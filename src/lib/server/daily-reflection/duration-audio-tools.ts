import { spawn } from "node:child_process";
import { toNamespacedPath } from "node:path";
import { getFfmpegExecutable, getFfprobeExecutable } from "@/lib/server/ffmpeg";
import {
  dailyReflectionUploadFailure,
  type DailyReflectionUploadFailureCode
} from "@/lib/domain/daily-reflection-upload-failure";

export class DailyReflectionDurationProbeError extends Error {
  readonly name = "DailyReflectionDurationProbeError";
  readonly retryable: boolean;
  constructor(readonly code: DailyReflectionUploadFailureCode = "daily_reflection_duration_probe_failed") {
    super(code);
    this.retryable = dailyReflectionUploadFailure(code)!.retryable;
  }
}

export type DurationToolDiagnostic = {
  stage: "probe" | "decode";
  elapsedMs: number;
  exitCode: number | null;
  outcome: "success" | DailyReflectionUploadFailureCode;
};
export type DurationToolOptions = {
  signal?: AbortSignal;
  budgetMs?: number;
  assertWritable?: () => void;
  onDiagnostic?: (event: DurationToolDiagnostic) => void;
};

function toolError(stderr: string) {
  if (/decoder .*not found|unknown decoder|unsupported codec|no decoder|decoding requested.*no decoder/iu.test(stderr)) {
    return new DailyReflectionDurationProbeError("daily_reflection_audio_codec_unsupported");
  }
  if (/no such file|permission denied|input\/output error/iu.test(stderr)) {
    return new DailyReflectionDurationProbeError();
  }
  return new DailyReflectionDurationProbeError("daily_reflection_audio_invalid");
}

async function runTool(input: DurationToolOptions & {
  stage: "probe" | "decode";
  filePath: string;
  streamIndex?: number;
  timeoutMs: number;
}) {
  const started = Date.now();
  const timeoutCode = input.stage === "probe"
    ? "daily_reflection_duration_probe_timeout" : "daily_reflection_duration_decode_timeout";
  if (input.timeoutMs <= 0) throw new DailyReflectionDurationProbeError(timeoutCode);
  input.assertWritable?.();
  if (input.signal?.aborted) throw new DailyReflectionDurationProbeError("daily_reflection_upload_interrupted");
  return await new Promise<{ stdout: string; pcmBytes: number }>((resolve, reject) => {
    // The bundled Windows ffprobe cannot open long paths without this native
    // prefix. Only the tool argument changes; canonical storage paths stay put.
    const filePath = toNamespacedPath(input.filePath);
    const args = input.stage === "probe" ? [
      "-v", "error", "-count_packets", "-show_entries",
      "format=duration:stream=index,codec_type,codec_name,duration,start_time,sample_rate",
      "-of", "json", filePath
    ] : [
      "-nostdin", "-hide_banner", "-v", "error", "-xerror", "-err_detect", "explode",
      "-i", filePath, "-map", `0:${input.streamIndex}`, "-vn", "-sn", "-dn",
      "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"
    ];
    const child = spawn(input.stage === "probe" ? getFfprobeExecutable() : getFfmpegExecutable(), args, {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    let outputBytes = 0;
    let stderrBytes = 0;
    let stderr = "";
    const stdout: Buffer[] = [];
    let failure: unknown;
    let settled = false;
    const stop = (error: unknown) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const abort = () => stop(new DailyReflectionDurationProbeError("daily_reflection_upload_interrupted"));
    input.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => stop(new DailyReflectionDurationProbeError(timeoutCode)), input.timeoutMs);
    const fenceTimer = setInterval(() => {
      try { input.assertWritable?.(); } catch (error) { stop(error); }
    }, 250);
    const finish = (exitCode: number | null, spawnError?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(fenceTimer);
      input.signal?.removeEventListener("abort", abort);
      if (spawnError) failure ??= new DailyReflectionDurationProbeError("daily_reflection_duration_tool_unavailable");
      if (!failure && (exitCode !== 0 || stderrBytes > 0)) failure = toolError(stderr);
      if (!failure) {
        try { input.assertWritable?.(); } catch (error) { failure = error; }
      }
      const outcome = failure instanceof DailyReflectionDurationProbeError ? failure.code
        : failure ? "daily_reflection_upload_lease_lost" : "success";
      // Diagnostics are safe enums and numbers, never the tool's raw output.
      try { input.onDiagnostic?.({ stage: input.stage, elapsedMs: Date.now() - started, exitCode, outcome }); } catch { /* Logging cannot alter ownership. */ }
      if (failure) reject(failure);
      else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), pcmBytes: outputBytes });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (!Number.isSafeInteger(outputBytes) || (input.stage === "probe" && outputBytes > 128 * 1024)) {
        stop(new DailyReflectionDurationProbeError());
      } else if (input.stage === "probe") stdout.push(chunk);
      // Decode output is counted then discarded; no complete PCM is retained.
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 32 * 1024) stderr += chunk.toString("utf8");
      else stop(toolError(stderr));
    });
    child.once("error", (error) => finish(null, error));
    child.once("close", (code) => finish(code));
    if (input.signal?.aborted) abort();
  });
}

function positiveSeconds(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export async function measureDailyReflectionAudio(filePath: string, options: DurationToolOptions = {}) {
  const started = Date.now();
  const budgetMs = Math.min(75_000, options.budgetMs ?? 75_000);
  const probe = await runTool({ ...options, stage: "probe", filePath, timeoutMs: Math.min(10_000, budgetMs) });
  let metadata: { streams?: Array<{ index?: number; codec_type?: string; codec_name?: string; duration?: unknown }>; format?: { duration?: unknown } };
  try { metadata = JSON.parse(probe.stdout); } catch { throw new DailyReflectionDurationProbeError(); }
  if (!metadata || !Array.isArray(metadata.streams)) throw new DailyReflectionDurationProbeError();
  const tracks = metadata.streams.filter((stream) => stream.codec_type === "audio");
  const audio = tracks[0];
  if (!audio) throw new DailyReflectionDurationProbeError("daily_reflection_audio_no_track");
  if (!Number.isInteger(audio.index) || audio.index! < 0) throw new DailyReflectionDurationProbeError();
  if (!audio.codec_name || audio.codec_name === "unknown") {
    throw new DailyReflectionDurationProbeError("daily_reflection_audio_codec_unsupported");
  }
  const streamDuration = positiveSeconds(audio.duration);
  // Container duration can describe a different (e.g. longer video) track.
  const singleAudio = metadata.streams.length === 1 && tracks.length === 1;
  const extraction = tracks.length > 1 || metadata.streams.some((stream) => stream.codec_type === "video")
    ? { requiresAudioExtraction: true as const } : {};
  const duration = streamDuration ?? (singleAudio ? positiveSeconds(metadata.format?.duration) : null);
  // Encoded duration can include priming/padding (notably WebM Opus). Around
  // the 180s policy boundary, decode actual samples instead of rounding it down.
  if (duration !== null && Math.abs(duration - 180) > 1) {
    return { durationSeconds: duration, durationSource: "server_ffprobe" as const, ...extraction };
  }
  const decoded = await runTool({
    ...options, stage: "decode", filePath, streamIndex: audio.index,
    timeoutMs: budgetMs - (Date.now() - started)
  });
  if (decoded.pcmBytes <= 0 || decoded.pcmBytes % 2 !== 0) {
    throw new DailyReflectionDurationProbeError("daily_reflection_audio_invalid");
  }
  // FFmpeg applies decoder skip/discard padding before PCM output. Counting
  // decoded bytes avoids ffprobe 4's nb_samples/pre-skip overcount for Opus.
  return { durationSeconds: decoded.pcmBytes / (2 * 48_000), durationSource: "server_ffmpeg_decode" as const, ...extraction };
}
