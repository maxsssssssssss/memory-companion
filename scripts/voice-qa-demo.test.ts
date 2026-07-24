// @vitest-environment node

import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { QuestionAnswer } from "@/lib/domain/types";
import { VoiceEvent, type ParsedVoiceServerEvent } from "@/lib/server/voice/events";
import type {
  VoiceProvider,
  VoiceSessionConfig,
  VoiceSessionInfo
} from "@/lib/server/voice/types";

import { parseVoiceQaDemoArgs, runVoiceQaDemoCli } from "./voice-qa-demo";

class DemoVoiceQaProvider implements VoiceProvider {
  readonly sentTexts: string[] = [];
  private readonly audioCallbacks = new Set<(audio: Buffer) => void>();
  private readonly eventCallbacks = new Set<(event: ParsedVoiceServerEvent) => void>();

  async connect() {}

  async startSession(_config?: VoiceSessionConfig): Promise<VoiceSessionInfo> {
    return { sessionId: "voice-qa-session" };
  }

  async sendAudio(_chunk: Buffer) {}

  async finishAudioInput() {}

  async sendText(text: string) {
    this.sentTexts.push(text);
    const startEvent: ParsedVoiceServerEvent = {
      eventId: VoiceEvent.TTSSentenceStart,
      eventName: "TTSSentenceStart",
      sessionId: "voice-qa-session",
      payload: {
        tts_type: "chat_tts_text",
        question_id: "question-1",
        reply_id: "reply-1"
      },
      rawPayload: Buffer.alloc(0),
      compressed: false,
      serialization: "json",
      unknown: false
    };
    for (const callback of this.eventCallbacks) callback(startEvent);
    const audioEvent: ParsedVoiceServerEvent = {
      eventId: VoiceEvent.TTSResponse,
      eventName: "TTSResponse",
      sessionId: "voice-qa-session",
      audio: Buffer.alloc(48_000, 1),
      rawPayload: Buffer.alloc(0),
      compressed: false,
      serialization: "none",
      unknown: false
    };
    for (const callback of this.eventCallbacks) callback(audioEvent);
    const event: ParsedVoiceServerEvent = {
      eventId: VoiceEvent.TTSEnded,
      eventName: "TTSEnded",
      sessionId: "voice-qa-session",
      payload: {
        tts_type: "chat_tts_text",
        question_id: "question-1",
        reply_id: "reply-1"
      },
      rawPayload: Buffer.alloc(0),
      compressed: false,
      serialization: "json",
      unknown: false
    };
    for (const callback of this.eventCallbacks) callback(event);
  }

  async finishSession() {}

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

  async close() {}
}

function qaAnswer(): QuestionAnswer {
  return {
    id: "answer-voice-demo",
    uploadId: "upload-1",
    question: "今天有什么重要事情？",
    answer: "今天确认了周末安排。[E1]",
    citedSegmentIds: ["segment-1"],
    citations: [{
      id: "E1",
      title: "周末安排",
      startSeconds: 1,
      endSeconds: 2,
      excerpt: "周日下午两点",
      sourceSegmentIds: ["segment-1"]
    }],
    createdAt: "2026-07-20T00:00:00.000Z"
  };
}

describe("voice QA demo CLI", () => {
  it("requires explicit user context and upload ID for current scope", () => {
    expect(() => parseVoiceQaDemoArgs(["--text", "hello"])).toThrow("--user-id");
    expect(() => parseVoiceQaDemoArgs([
      "--text", "hello",
      "--user-id", "user-1",
      "--scope", "current"
    ])).toThrow("--upload-id");
  });

  it("uses APP_DATA_DIR for the ignored output directory", () => {
    expect(parseVoiceQaDemoArgs([
      "--text", "hello",
      "--user-id", "user-1"
    ], { APP_DATA_DIR: "local-data" })).toMatchObject({
      scope: "all",
      outputDir: expect.stringMatching(/[\\/]local-data[\\/]voice-qa-demo$/u)
    });
  });

  it("runs QA once, sends citation-free speech, and writes WAV plus a redacted session report", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "daily-brief-voice-qa-demo-"));
    const provider = new DemoVoiceQaProvider();
    const answer = vi.fn(async () => qaAnswer());
    let stdout = "";

    const report = await runVoiceQaDemoCli([
      "--text", "今天有什么重要事情？",
      "--user-id", "user-1",
      "--scope", "current",
      "--upload-id", "upload-1",
      "--output-dir", outputDir
    ], {
      provider,
      answerer: { answer },
      stdout: { write: (value) => { stdout += String(value); return true; } }
    });

    const wav = await readFile(join(outputDir, "response.wav"));
    const session = JSON.parse(await readFile(join(outputDir, "session.json"), "utf8")) as Record<string, unknown>;
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(provider.sentTexts).toEqual(["今天确认了周末安排。"]);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(session).toMatchObject({
      version: 1,
      sessionId: "voice-qa-session",
      state: "closed",
      scope: "current",
      uploadId: "upload-1",
      citedSegmentIds: ["segment-1"],
      citationCount: 1,
      audioSizeBytes: 48_044
    });
    expect(session).not.toHaveProperty("transcript");
    expect(session).not.toHaveProperty("answer");
    expect(report).toEqual(JSON.parse(stdout));
  });
});
