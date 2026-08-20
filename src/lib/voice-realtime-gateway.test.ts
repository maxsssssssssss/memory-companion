import { describe, expect, it } from "vitest";

import {
  REALTIME_VOICE_GATEWAY_SUBPROTOCOL,
  REALTIME_VOICE_GATEWAY_SUBPROTOCOL_V2,
  RealtimeVoiceGatewayProtocolError,
  decodeRealtimeVoiceGatewayAudioFrame,
  decodeRealtimeVoiceGatewayAudioFrameV2,
  encodeRealtimeVoiceGatewayAudioFrame,
  encodeRealtimeVoiceGatewayAudioFrameV2
} from "./voice-realtime-gateway";

describe("Realtime Voice WebSocket gateway protocol", () => {
  it("round-trips raw browser PCM without transcript or QA data", () => {
    const encoded = encodeRealtimeVoiceGatewayAudioFrame({
      kind: "input_pcm",
      pcm16le: new Uint8Array([1, 2, 3, 4])
    });

    expect(REALTIME_VOICE_GATEWAY_SUBPROTOCOL).toBe(
      "daily-brief-realtime-voice.v1"
    );
    expect(decodeRealtimeVoiceGatewayAudioFrame(encoded)).toEqual({
      kind: "input_pcm",
      pcm16le: new Uint8Array([1, 2, 3, 4])
    });
  });

  it("binds output PCM to the exact turn, sentence, sequence, and Provider item", () => {
    const encoded = encodeRealtimeVoiceGatewayAudioFrame({
      kind: "output_pcm",
      turnSequence: 4,
      sequence: 9,
      sentenceSequence: 2,
      providerItemId: "reply-4",
      pcm16le: new Uint8Array([5, 6])
    });

    expect(decodeRealtimeVoiceGatewayAudioFrame(encoded)).toEqual({
      kind: "output_pcm",
      turnSequence: 4,
      sequence: 9,
      sentenceSequence: 2,
      providerItemId: "reply-4",
      pcm16le: new Uint8Array([5, 6])
    });
  });

  it("rejects truncated, odd-byte, or unbounded PCM frames", () => {
    expect(() => decodeRealtimeVoiceGatewayAudioFrame(
      new Uint8Array([1, 2, 3])
    )).toThrow(RealtimeVoiceGatewayProtocolError);
    expect(() => encodeRealtimeVoiceGatewayAudioFrame({
      kind: "input_pcm",
      pcm16le: new Uint8Array([1])
    })).toThrow("16-bit sample boundary");
    expect(() => encodeRealtimeVoiceGatewayAudioFrame({
      kind: "input_pcm",
      pcm16le: new Uint8Array(256 * 1024 + 2)
    })).toThrow("bounded frame size");
  });

  it("keeps v2 input sequence and capture timestamp in the binary frame", () => {
    const encoded = encodeRealtimeVoiceGatewayAudioFrameV2({
      kind: "input_pcm",
      inputEpoch: 3,
      sequence: 17,
      timestampMs: 1_786_000_000_123,
      pcm16le: new Uint8Array([1, 2, 3, 4])
    });

    expect(REALTIME_VOICE_GATEWAY_SUBPROTOCOL_V2).toBe(
      "daily-brief-realtime-voice.v2"
    );
    expect(decodeRealtimeVoiceGatewayAudioFrameV2(encoded)).toEqual({
      kind: "input_pcm",
      inputEpoch: 3,
      sequence: 17,
      timestampMs: 1_786_000_000_123,
      pcm16le: new Uint8Array([1, 2, 3, 4])
    });
  });

  it("binds v2 output to replay, turn, item offset, and Provider epoch", () => {
    const encoded = encodeRealtimeVoiceGatewayAudioFrameV2({
      kind: "output_pcm",
      providerEpoch: 2,
      serverSequence: 11,
      turnSequence: 4,
      sequence: 7,
      sentenceSequence: 2,
      itemOffsetSamples: 480,
      providerItemId: "reply-4",
      pcm16le: new Uint8Array([5, 6])
    });

    expect(decodeRealtimeVoiceGatewayAudioFrameV2(encoded)).toEqual({
      kind: "output_pcm",
      providerEpoch: 2,
      serverSequence: 11,
      turnSequence: 4,
      sequence: 7,
      sentenceSequence: 2,
      itemOffsetSamples: 480,
      providerItemId: "reply-4",
      pcm16le: new Uint8Array([5, 6])
    });
  });

  it("rejects v2 output audio that cannot be bound for barge-in", () => {
    expect(() => encodeRealtimeVoiceGatewayAudioFrameV2({
      kind: "output_pcm",
      providerEpoch: 1,
      serverSequence: 1,
      turnSequence: 1,
      sequence: 1,
      sentenceSequence: 1,
      itemOffsetSamples: 0,
      providerItemId: " ",
      pcm16le: new Uint8Array([1, 2])
    })).toThrow("requires a Provider item ID");
  });
});
