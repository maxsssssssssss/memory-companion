// @vitest-environment node

import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { VoiceEvent, type ParsedVoiceServerEvent } from "@/lib/server/voice/events";
import type {
  VoiceProvider,
  VoiceSessionConfig,
  VoiceSessionInfo
} from "@/lib/server/voice/types";

import { parseVoiceDemoArgs, runVoiceDemoCli } from "./voice-demo";

class DemoVoiceProvider implements VoiceProvider {
  readonly calls: string[] = [];
  private readonly audioCallbacks = new Set<(audio: Buffer) => void>();
  private readonly eventCallbacks = new Set<(event: ParsedVoiceServerEvent) => void>();

  async connect() {
    this.calls.push("connect");
  }

  async startSession(config?: VoiceSessionConfig): Promise<VoiceSessionInfo> {
    this.calls.push(`start:${config?.audioOutput?.format ?? "default"}`);
    return { sessionId: "demo-session" };
  }

  async sendAudio(_chunk: Buffer) {
    this.calls.push("send-audio");
  }

  async finishAudioInput() {
    this.calls.push("finish-audio-input");
  }

  async sendText(_text: string) {
    this.calls.push("send-text");
    const pcm = Buffer.alloc(48_000, 0x01);
    for (const callback of this.audioCallbacks) callback(pcm);
    const event: ParsedVoiceServerEvent = {
      eventId: VoiceEvent.TTSEnded,
      eventName: "TTSEnded",
      sessionId: "demo-session",
      rawPayload: Buffer.alloc(0),
      compressed: false,
      serialization: "json",
      unknown: false
    };
    for (const callback of this.eventCallbacks) callback(event);
  }

  async finishSession() {
    this.calls.push("finish");
  }

  onTranscript(_callback: (text: string) => void) {
    return () => undefined;
  }

  onAudio(callback: (audio: Buffer) => void) {
    this.audioCallbacks.add(callback);
    return () => this.audioCallbacks.delete(callback);
  }

  onEvent(callback: (event: ParsedVoiceServerEvent) => void) {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  async close() {
    this.calls.push("close");
  }
}

describe("voice demo CLI", () => {
  it("uses APP_DATA_DIR for the ignored default WAV output", () => {
    expect(parseVoiceDemoArgs(["--text", "hello"], { APP_DATA_DIR: "local-data" })).toMatchObject({
      text: "hello",
      outputPath: expect.stringMatching(/[\\/]local-data[\\/]voice-demo[\\/]output\.wav$/u)
    });
  });

  it("rejects missing text and misleading non-WAV output names", () => {
    expect(() => parseVoiceDemoArgs([])).toThrow("--text is required");
    expect(() => parseVoiceDemoArgs(["--text", "hello", "--output", "output.ogg"])).toThrow(".wav");
  });

  it("runs against a mock provider and writes a valid WAV without network access", async () => {
    const root = await mkdtemp(join(tmpdir(), "daily-brief-voice-demo-"));
    const outputPath = join(root, "voice.wav");
    const provider = new DemoVoiceProvider();
    let stdout = "";
    const times = [10, 20, 30, 50];

    const report = await runVoiceDemoCli(
      ["--text", "你好", "--output", outputPath],
      {
        provider,
        stdout: { write: (value) => { stdout += String(value); return true; } },
        now: () => times.shift() ?? 50
      }
    );
    const wav = await readFile(outputPath);

    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(report).toMatchObject({
      outputPath,
      sessionId: "demo-session",
      connectLatencyMs: 10,
      ttsLatencyMs: 20,
      audioDurationMs: 1_000,
      outputSizeBytes: 48_044
    });
    expect(JSON.parse(stdout)).toEqual(report);
    expect(provider.calls).toEqual([
      "connect",
      "start:pcm_s16le",
      "send-text",
      "finish",
      "close"
    ]);
  });
});
