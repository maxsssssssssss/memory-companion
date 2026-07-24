// @vitest-environment node

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_VOICE_MAX_INPUT_BYTES,
  BROWSER_VOICE_MAX_PCM_BYTES,
  BROWSER_VOICE_PCM_PACKET_BYTES,
  BrowserVoiceAudioError,
  convertBrowserAudioToPcm16,
  streamBrowserPcmToVoiceBridge,
  summarizeBrowserVoicePcm,
  validateBrowserVoicePcm
} from "./browser-audio";

class FakeAudioProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, "SIGKILL"));
    return true;
  }
}

function fakeSpawn(input: {
  output?: Buffer;
  stderr?: string;
  exitCode?: number;
  hang?: boolean;
}) {
  const child = new FakeAudioProcess();
  const spawnProcess = vi.fn(() => {
    child.stdin.once("finish", () => {
      if (input.hang) return;
      if (input.stderr) child.stderr.end(input.stderr);
      else child.stderr.end();
      if (input.output) child.stdout.end(input.output);
      else child.stdout.end();
      queueMicrotask(() => child.emit("close", input.exitCode ?? 0, null));
    });
    return child;
  });
  return { child, spawnProcess };
}

describe("browser voice audio conversion", () => {
  it("converts an allowlisted browser container to 16 kHz mono PCM without trusting MIME parameters", async () => {
    const pcm = Buffer.alloc(32_000, 1);
    const fake = fakeSpawn({ output: pcm });

    const result = await convertBrowserAudioToPcm16(
      {
        audio: Buffer.from("browser-webm"),
        mimeType: "Audio/WebM; codecs=opus"
      },
      {
        ffmpegExecutable: "safe-ffmpeg",
        spawnProcess: fake.spawnProcess as never
      }
    );

    expect(result).toEqual(pcm);
    expect(fake.spawnProcess).toHaveBeenCalledWith(
      "safe-ffmpeg",
      expect.arrayContaining([
        "-i",
        "pipe:0",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1"
      ]),
      expect.objectContaining({ windowsHide: true })
    );
  });

  it.each(["audio/webm", "audio/ogg", "audio/mp4", "audio/wav"])(
    "accepts %s",
    async (mimeType) => {
      const fake = fakeSpawn({ output: Buffer.alloc(640) });
      await expect(convertBrowserAudioToPcm16(
        { audio: Buffer.from("audio"), mimeType },
        { spawnProcess: fake.spawnProcess as never }
      )).resolves.toHaveLength(640);
    }
  );

  it("rejects unsupported, empty, and oversized browser input before spawning ffmpeg", async () => {
    const fake = fakeSpawn({ output: Buffer.alloc(640) });
    const dependencies = { spawnProcess: fake.spawnProcess as never };

    await expect(convertBrowserAudioToPcm16({
      audio: Buffer.from("audio"),
      mimeType: "application/octet-stream"
    }, dependencies)).rejects.toMatchObject({ code: "unsupported_mime_type" });
    await expect(convertBrowserAudioToPcm16({
      audio: Buffer.alloc(0),
      mimeType: "audio/webm"
    }, dependencies)).rejects.toMatchObject({ code: "invalid_audio" });
    await expect(convertBrowserAudioToPcm16({
      audio: Buffer.alloc(BROWSER_VOICE_MAX_INPUT_BYTES + 1),
      mimeType: "audio/webm"
    }, dependencies)).rejects.toMatchObject({ code: "audio_too_large" });
    expect(fake.spawnProcess).not.toHaveBeenCalled();
  });

  it("caps PCM output at 75 seconds", async () => {
    const fake = fakeSpawn({ output: Buffer.alloc(BROWSER_VOICE_MAX_PCM_BYTES + 2) });

    await expect(convertBrowserAudioToPcm16(
      { audio: Buffer.from("audio"), mimeType: "audio/ogg" },
      { spawnProcess: fake.spawnProcess as never }
    )).rejects.toMatchObject({ code: "audio_too_long" });
    expect(fake.child.killed).toBe(true);
  });

  it("times out a hung converter with a bounded, redacted error", async () => {
    const fake = fakeSpawn({ hang: true });

    await expect(convertBrowserAudioToPcm16(
      { audio: Buffer.from("audio"), mimeType: "audio/webm" },
      { spawnProcess: fake.spawnProcess as never, conversionTimeoutMs: 5 }
    )).rejects.toMatchObject({ code: "conversion_timeout" });
    expect(fake.child.killed).toBe(true);
  });

  it("does not expose ffmpeg stderr, transcript content, or credentials", async () => {
    const sensitive = "token=secret transcript=private-words Authorization=Bearer-value";
    const fake = fakeSpawn({ stderr: sensitive, exitCode: 1 });

    let error: unknown;
    try {
      await convertBrowserAudioToPcm16(
        { audio: Buffer.from("audio"), mimeType: "audio/mp4" },
        { spawnProcess: fake.spawnProcess as never }
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BrowserVoiceAudioError);
    expect(error).toMatchObject({ code: "conversion_failed" });
    expect(String(error)).not.toContain(sensitive);
    expect(String(error)).not.toContain("private-words");
    expect(String(error)).not.toContain("Bearer-value");
  });

  it("honors an already aborted request without spawning ffmpeg", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeSpawn({ output: Buffer.alloc(640) });

    await expect(convertBrowserAudioToPcm16(
      { audio: Buffer.from("audio"), mimeType: "audio/wav", signal: controller.signal },
      { spawnProcess: fake.spawnProcess as never }
    )).rejects.toMatchObject({ code: "conversion_aborted" });
    expect(fake.spawnProcess).not.toHaveBeenCalled();
  });
});

describe("browser voice PCM validation and streaming", () => {
  it("validates duration and packet count without changing PCM", () => {
    const pcm = Buffer.alloc(32_000);
    expect(validateBrowserVoicePcm(pcm)).toEqual({ durationMs: 1_000, packetCount: 50 });
    expect(() => validateBrowserVoicePcm(Buffer.alloc(3))).toThrow(/aligned/i);
    expect(() => validateBrowserVoicePcm(Buffer.alloc(BROWSER_VOICE_MAX_PCM_BYTES + 2))).toThrow(/75 seconds/i);
  });

  it("sends bounded 640-byte packets with 20 ms pacing and a final aligned remainder", async () => {
    const pcm = Buffer.alloc(BROWSER_VOICE_PCM_PACKET_BYTES * 2 + 320, 1);
    const chunks: Buffer[] = [];
    const wait = vi.fn(async () => undefined);

    const result = await streamBrowserPcmToVoiceBridge(
      pcm,
      async (chunk) => { chunks.push(Buffer.from(chunk)); },
      { wait }
    );

    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([640, 640, 320]);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 20, undefined);
    expect(result).toEqual({
      bytesSent: pcm.byteLength,
      packetCount: 3,
      durationMs: 50
    });
  });

  it("supports a bridge-like target and stops on AbortSignal", async () => {
    const controller = new AbortController();
    const sendAudio = vi.fn(async () => undefined);
    const wait = vi.fn(async () => { controller.abort(); });

    await expect(streamBrowserPcmToVoiceBridge(
      Buffer.alloc(BROWSER_VOICE_PCM_PACKET_BYTES * 2),
      { sendAudio },
      { signal: controller.signal, wait }
    )).rejects.toMatchObject({ code: "stream_aborted" });
    expect(sendAudio).toHaveBeenCalledTimes(1);
  });

  it("summarizes PCM signal levels with deterministic bounded metadata", () => {
    const samples = Array.from({ length: 16 }, (_, index) => (
      [0, 16_384, -16_384, 32_767][index % 4]!
    ));
    const pcm = Buffer.alloc(samples.length * 2);
    samples.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2));

    expect(summarizeBrowserVoicePcm(pcm)).toEqual({
      durationMs: 1,
      pcmBytes: 32,
      packetCount: 1,
      peakDbfs: 0,
      rmsDbfs: -4.3,
      nonSilentRatio: 0.75,
      likelySilent: false
    });
  });

  it("classifies digital silence without retaining sample data", () => {
    const summary = summarizeBrowserVoicePcm(Buffer.alloc(BROWSER_VOICE_PCM_PACKET_BYTES));

    expect(summary).toEqual({
      durationMs: 20,
      pcmBytes: BROWSER_VOICE_PCM_PACKET_BYTES,
      packetCount: 1,
      peakDbfs: -120,
      rmsDbfs: -120,
      nonSilentRatio: 0,
      likelySilent: true
    });
    expect(Object.keys(summary)).toEqual([
      "durationMs",
      "pcmBytes",
      "packetCount",
      "peakDbfs",
      "rmsDbfs",
      "nonSilentRatio",
      "likelySilent"
    ]);
  });
});
