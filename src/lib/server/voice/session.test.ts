// @vitest-environment node

import { describe, expect, it } from "vitest";

import { VoiceEvent, type ParsedVoiceServerEvent } from "./events";
import { synthesizeVoiceText } from "./session";
import type { VoiceProvider, VoiceSessionConfig, VoiceSessionInfo } from "./types";

class MockVoiceProvider implements VoiceProvider {
  readonly calls: string[] = [];
  private readonly audioCallbacks = new Set<(audio: Buffer) => void>();
  private readonly eventCallbacks = new Set<(event: ParsedVoiceServerEvent) => void>();
  private readonly transcriptCallbacks = new Set<(text: string) => void>();

  async connect() {
    this.calls.push("connect");
  }

  async startSession(config?: VoiceSessionConfig): Promise<VoiceSessionInfo> {
    this.calls.push(`start:${config?.model ?? "default"}`);
    return { sessionId: "session-test", dialogId: "dialog-test" };
  }

  async sendAudio(_chunk: Buffer) {
    this.calls.push("audio");
  }

  async finishAudioInput() {
    this.calls.push("finish-audio-input");
  }

  async sendText(text: string) {
    this.calls.push(`text:${text}`);
    this.emitAudio(Buffer.from([0x00, 0x01]));
    this.emitAudio(Buffer.from([0xff, 0x7f]));
    this.emitEvent(VoiceEvent.TTSEnded, "TTSEnded", undefined, "session-test");
  }

  async finishSession() {
    this.calls.push("finish");
  }

  onTranscript(callback: (text: string) => void) {
    this.transcriptCallbacks.add(callback);
    return () => this.transcriptCallbacks.delete(callback);
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

  emitAudio(audio: Buffer) {
    for (const callback of this.audioCallbacks) callback(audio);
  }

  emitEvent(eventId: number, eventName: string, errorCode?: number, sessionId?: string) {
    const event: ParsedVoiceServerEvent = {
      eventId,
      eventName,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(sessionId ? { sessionId } : {}),
      rawPayload: Buffer.alloc(0),
      compressed: false,
      serialization: "json",
      unknown: false
    };
    for (const callback of this.eventCallbacks) callback(event);
  }
}

describe("synthesizeVoiceText", () => {
  it("runs one provider session, preserves audio order, and closes it", async () => {
    const provider = new MockVoiceProvider();
    const times = [100, 125, 200, 275];

    const result = await synthesizeVoiceText("  你好，介绍一下今天的情况  ", {
      provider,
      sessionConfig: { model: "1.2.1.1" },
      now: () => times.shift() ?? 275
    });

    expect(result).toEqual({
      sessionId: "session-test",
      dialogId: "dialog-test",
      audio: Buffer.from([0x00, 0x01, 0xff, 0x7f]),
      connectLatencyMs: 25,
      ttsLatencyMs: 75
    });
    expect(provider.calls).toEqual([
      "connect",
      "start:1.2.1.1",
      "text:你好，介绍一下今天的情况",
      "finish",
      "close"
    ]);
  });

  it("fails on provider Error events and still closes the session", async () => {
    const provider = new MockVoiceProvider();
    provider.sendText = async () => {
      provider.calls.push("text:error");
      provider.emitEvent(0, "Error", 45000001);
    };

    await expect(synthesizeVoiceText("hello", { provider })).rejects.toMatchObject({
      reason: "provider_error",
      providerCode: 45000001
    });
    expect(provider.calls.at(-1)).toBe("close");
  });

  it("rejects empty text before connecting", async () => {
    const provider = new MockVoiceProvider();

    await expect(synthesizeVoiceText("   ", { provider })).rejects.toMatchObject({
      reason: "invalid_request"
    });
    expect(provider.calls).toEqual([]);
  });
});
