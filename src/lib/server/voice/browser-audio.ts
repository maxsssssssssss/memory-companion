import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { getFfmpegExecutable } from "@/lib/server/ffmpeg";

export const BROWSER_VOICE_MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const BROWSER_VOICE_PCM_SAMPLE_RATE = 16_000;
export const BROWSER_VOICE_PCM_CHANNELS = 1;
export const BROWSER_VOICE_PCM_BYTES_PER_SAMPLE = 2;
export const BROWSER_VOICE_PCM_PACKET_DURATION_MS = 20;
export const BROWSER_VOICE_PCM_PACKET_BYTES = 640;
export const BROWSER_VOICE_MAX_DURATION_SECONDS = 75;
export const BROWSER_VOICE_MAX_PCM_BYTES =
  BROWSER_VOICE_PCM_SAMPLE_RATE *
  BROWSER_VOICE_PCM_CHANNELS *
  BROWSER_VOICE_PCM_BYTES_PER_SAMPLE *
  BROWSER_VOICE_MAX_DURATION_SECONDS;

const DEFAULT_CONVERSION_TIMEOUT_MS = 60_000;
const MAX_CONVERSION_TIMEOUT_MS = 120_000;
const MAX_STDERR_BYTES = 32 * 1024;
const PCM16_FULL_SCALE = 32_768;
const PCM_DBFS_FLOOR = -120;
const NON_SILENT_SAMPLE_THRESHOLD = Math.round(PCM16_FULL_SCALE * 0.01);
const LIKELY_SILENT_RMS_DBFS = -50;
const LIKELY_SILENT_SAMPLE_RATIO = 0.01;
const SUPPORTED_BROWSER_AUDIO_MIME_TYPES = new Set([
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm"
]);

export type BrowserVoiceAudioErrorCode =
  | "unsupported_mime_type"
  | "invalid_audio"
  | "audio_too_large"
  | "audio_too_long"
  | "conversion_aborted"
  | "conversion_timeout"
  | "conversion_failed"
  | "invalid_pcm"
  | "stream_aborted"
  | "invalid_target";

export class BrowserVoiceAudioError extends Error {
  constructor(
    readonly code: BrowserVoiceAudioErrorCode,
    message: string
  ) {
    super(message);
    this.name = "BrowserVoiceAudioError";
  }
}

export type ConvertBrowserAudioInput = {
  audio: Buffer;
  mimeType: string;
  signal?: AbortSignal;
};

export type BrowserAudioSpawn = typeof spawn;

export type ConvertBrowserAudioDependencies = {
  ffmpegExecutable?: string;
  spawnProcess?: BrowserAudioSpawn;
  conversionTimeoutMs?: number;
};

export type BrowserPcmTarget =
  | { sendAudio(chunk: Buffer): Promise<void> }
  | ((chunk: Buffer) => Promise<void>);

export type StreamBrowserPcmOptions = {
  signal?: AbortSignal;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

export type BrowserVoicePcmDiagnostics = {
  durationMs: number;
  pcmBytes: number;
  packetCount: number;
  peakDbfs: number;
  rmsDbfs: number;
  nonSilentRatio: number;
  likelySilent: boolean;
};

function normalizedMimeType(value: string) {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function throwIfAborted(signal: AbortSignal | undefined, code: "conversion_aborted" | "stream_aborted") {
  if (signal?.aborted) {
    throw new BrowserVoiceAudioError(code, "Browser voice audio operation was aborted.");
  }
}

function conversionTimeout(value: number | undefined) {
  if (value === undefined) return DEFAULT_CONVERSION_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new BrowserVoiceAudioError("invalid_audio", "Browser voice conversion timeout must be positive.");
  }
  return Math.min(MAX_CONVERSION_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

function validateBrowserAudioInput(input: ConvertBrowserAudioInput) {
  if (!Buffer.isBuffer(input.audio) || input.audio.byteLength === 0) {
    throw new BrowserVoiceAudioError("invalid_audio", "Browser voice audio must be a non-empty Buffer.");
  }
  if (input.audio.byteLength > BROWSER_VOICE_MAX_INPUT_BYTES) {
    throw new BrowserVoiceAudioError("audio_too_large", "Browser voice audio exceeds the 20 MiB input limit.");
  }
  if (!SUPPORTED_BROWSER_AUDIO_MIME_TYPES.has(normalizedMimeType(input.mimeType))) {
    throw new BrowserVoiceAudioError(
      "unsupported_mime_type",
      "Browser voice audio MIME type is not supported."
    );
  }
}

export function validateBrowserVoicePcm(pcm: Buffer) {
  if (!Buffer.isBuffer(pcm) || pcm.byteLength === 0) {
    throw new BrowserVoiceAudioError("invalid_pcm", "Browser voice PCM must be a non-empty Buffer.");
  }
  const frameBytes = BROWSER_VOICE_PCM_CHANNELS * BROWSER_VOICE_PCM_BYTES_PER_SAMPLE;
  if (pcm.byteLength % frameBytes !== 0) {
    throw new BrowserVoiceAudioError("invalid_pcm", "Browser voice PCM must be aligned to complete int16 frames.");
  }
  if (pcm.byteLength > BROWSER_VOICE_MAX_PCM_BYTES) {
    throw new BrowserVoiceAudioError(
      "audio_too_long",
      `Browser voice PCM must not exceed ${BROWSER_VOICE_MAX_DURATION_SECONDS} seconds.`
    );
  }
  const bytesPerSecond = BROWSER_VOICE_PCM_SAMPLE_RATE * frameBytes;
  return {
    durationMs: (pcm.byteLength / bytesPerSecond) * 1_000,
    packetCount: Math.ceil(pcm.byteLength / BROWSER_VOICE_PCM_PACKET_BYTES)
  };
}

function roundedMetric(value: number, decimalPlaces: number) {
  const scale = 10 ** decimalPlaces;
  const rounded = Math.round(value * scale) / scale;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function amplitudeDbfs(amplitude: number) {
  if (amplitude <= 0) return PCM_DBFS_FLOOR;
  return Math.max(
    PCM_DBFS_FLOOR,
    roundedMetric(20 * Math.log10(amplitude / PCM16_FULL_SCALE), 1)
  );
}

/**
 * Computes bounded aggregate signal metadata for opt-in diagnostics. The
 * summary contains no samples and cannot reconstruct the source recording.
 */
export function summarizeBrowserVoicePcm(pcm: Buffer): BrowserVoicePcmDiagnostics {
  const metadata = validateBrowserVoicePcm(pcm);
  const sampleCount = pcm.byteLength / BROWSER_VOICE_PCM_BYTES_PER_SAMPLE;
  let peakAmplitude = 0;
  let squaredAmplitudeTotal = 0;
  let nonSilentSamples = 0;

  for (let offset = 0; offset < pcm.byteLength; offset += BROWSER_VOICE_PCM_BYTES_PER_SAMPLE) {
    const sample = pcm.readInt16LE(offset);
    const amplitude = Math.abs(sample);
    peakAmplitude = Math.max(peakAmplitude, amplitude);
    squaredAmplitudeTotal += sample * sample;
    if (amplitude >= NON_SILENT_SAMPLE_THRESHOLD) nonSilentSamples += 1;
  }

  const rmsAmplitude = Math.sqrt(squaredAmplitudeTotal / sampleCount);
  const rmsDbfs = amplitudeDbfs(rmsAmplitude);
  const nonSilentRatio = nonSilentSamples / sampleCount;
  return {
    durationMs: Math.round(metadata.durationMs),
    pcmBytes: pcm.byteLength,
    packetCount: metadata.packetCount,
    peakDbfs: amplitudeDbfs(peakAmplitude),
    rmsDbfs,
    nonSilentRatio: roundedMetric(nonSilentRatio, 4),
    likelySilent: rmsDbfs <= LIKELY_SILENT_RMS_DBFS || nonSilentRatio < LIKELY_SILENT_SAMPLE_RATIO
  };
}

function convertedPcm(input: ConvertBrowserAudioInput, dependencies: ConvertBrowserAudioDependencies) {
  const timeoutMs = conversionTimeout(dependencies.conversionTimeoutMs);
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const executable = dependencies.ffmpegExecutable ?? getFfmpegExecutable();
  const argumentsList = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    "pipe:0",
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    String(BROWSER_VOICE_PCM_CHANNELS),
    "-ar",
    String(BROWSER_VOICE_PCM_SAMPLE_RATE),
    "-c:a",
    "pcm_s16le",
    "-f",
    "s16le",
    "pipe:1"
  ];

  return new Promise<Buffer>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(executable, argumentsList, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch {
      reject(new BrowserVoiceAudioError("conversion_failed", "Browser voice audio conversion failed."));
      return;
    }

    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", handleAbort);
    };
    const fail = (error: BrowserVoiceAudioError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const stopAndFail = (error: BrowserVoiceAudioError) => {
      if (settled) return;
      child.kill();
      fail(error);
    };
    const handleAbort = () => stopAndFail(new BrowserVoiceAudioError(
      "conversion_aborted",
      "Browser voice audio operation was aborted."
    ));
    const timer = setTimeout(() => stopAndFail(new BrowserVoiceAudioError(
      "conversion_timeout",
      "Browser voice audio conversion timed out."
    )), timeoutMs);

    input.signal?.addEventListener("abort", handleAbort, { once: true });
    child.stdout.on("data", (value: Buffer | Uint8Array) => {
      if (settled) return;
      const chunk = Buffer.from(value);
      outputBytes += chunk.byteLength;
      if (outputBytes > BROWSER_VOICE_MAX_PCM_BYTES) {
        stopAndFail(new BrowserVoiceAudioError(
          "audio_too_long",
          `Browser voice PCM must not exceed ${BROWSER_VOICE_MAX_DURATION_SECONDS} seconds.`
        ));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (value: Buffer | Uint8Array) => {
      // Drain stderr to avoid child-process backpressure, but retain no content.
      stderrBytes = Math.min(MAX_STDERR_BYTES, stderrBytes + value.byteLength);
    });
    child.stdin.on("error", () => {
      // A converter that exits early can close stdin; the close/error event below
      // remains the single source of the public, redacted failure.
    });
    child.once("error", () => {
      fail(new BrowserVoiceAudioError("conversion_failed", "Browser voice audio conversion failed."));
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new BrowserVoiceAudioError("conversion_failed", "Browser voice audio conversion failed."));
        return;
      }
      const pcm = Buffer.concat(chunks, outputBytes);
      try {
        validateBrowserVoicePcm(pcm);
      } catch (error) {
        if (error instanceof BrowserVoiceAudioError && error.code === "audio_too_long") {
          fail(error);
        } else {
          fail(new BrowserVoiceAudioError("conversion_failed", "Browser voice audio conversion failed."));
        }
        return;
      }
      settled = true;
      cleanup();
      resolve(pcm);
    });

    if (input.signal?.aborted) {
      handleAbort();
      return;
    }
    try {
      child.stdin.end(input.audio);
    } catch {
      stopAndFail(new BrowserVoiceAudioError("conversion_failed", "Browser voice audio conversion failed."));
    }
  });
}

export async function convertBrowserAudioToPcm16(
  input: ConvertBrowserAudioInput,
  dependencies: ConvertBrowserAudioDependencies = {}
) {
  throwIfAborted(input.signal, "conversion_aborted");
  validateBrowserAudioInput(input);
  return convertedPcm(input, dependencies);
}

function defaultWait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BrowserVoiceAudioError("stream_aborted", "Browser voice audio operation was aborted."));
      return;
    }
    const handleAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", handleAbort);
      reject(new BrowserVoiceAudioError("stream_aborted", "Browser voice audio operation was aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) handleAbort();
  });
}

function audioSender(target: BrowserPcmTarget) {
  if (typeof target === "function") return target;
  if (target && typeof target.sendAudio === "function") {
    return (chunk: Buffer) => target.sendAudio(chunk);
  }
  throw new BrowserVoiceAudioError("invalid_target", "Browser voice PCM target must provide sendAudio.");
}

export async function streamBrowserPcmToVoiceBridge(
  pcm: Buffer,
  target: BrowserPcmTarget,
  options: StreamBrowserPcmOptions = {}
) {
  const metadata = validateBrowserVoicePcm(pcm);
  throwIfAborted(options.signal, "stream_aborted");
  const send = audioSender(target);
  const wait = options.wait ?? defaultWait;
  let packetCount = 0;

  for (let offset = 0; offset < pcm.byteLength; offset += BROWSER_VOICE_PCM_PACKET_BYTES) {
    throwIfAborted(options.signal, "stream_aborted");
    const chunk = pcm.subarray(offset, Math.min(pcm.byteLength, offset + BROWSER_VOICE_PCM_PACKET_BYTES));
    await send(chunk);
    packetCount += 1;
    if (offset + BROWSER_VOICE_PCM_PACKET_BYTES < pcm.byteLength) {
      await wait(BROWSER_VOICE_PCM_PACKET_DURATION_MS, options.signal);
      throwIfAborted(options.signal, "stream_aborted");
    }
  }

  return {
    bytesSent: pcm.byteLength,
    packetCount,
    durationMs: metadata.durationMs
  };
}
