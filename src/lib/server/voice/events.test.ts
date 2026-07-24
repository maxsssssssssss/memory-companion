// @vitest-environment node

import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  VoiceEvent,
  VoiceProtocolError,
  encodeAudioEvent,
  encodeJsonEvent,
  parseServerEvent
} from "./events";

function int32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

function uint32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function decodeClientFrame(frame: Buffer) {
  let offset = 4;
  const eventId = frame.readInt32BE(offset);
  offset += 4;
  let sessionId: string | undefined;
  if (eventId !== VoiceEvent.StartConnection && eventId !== VoiceEvent.FinishConnection) {
    const sessionLength = frame.readUInt32BE(offset);
    offset += 4;
    sessionId = frame.subarray(offset, offset + sessionLength).toString("utf8");
    offset += sessionLength;
  }
  const payloadLength = frame.readUInt32BE(offset);
  offset += 4;
  return {
    eventId,
    sessionId,
    payload: frame.subarray(offset, offset + payloadLength)
  };
}

function jsonServerFrame(input: {
  eventId: number;
  payload: unknown;
  sessionId?: string;
  gzip?: boolean;
}) {
  const plainPayload = Buffer.from(JSON.stringify(input.payload), "utf8");
  const payload = input.gzip ? gzipSync(plainPayload) : plainPayload;
  const session = input.sessionId ? Buffer.from(input.sessionId, "utf8") : undefined;
  return Buffer.concat([
    Buffer.from([0x11, 0x94, input.gzip ? 0x11 : 0x10, 0x00]),
    int32(input.eventId),
    ...(session ? [uint32(session.byteLength), session] : []),
    uint32(payload.byteLength),
    payload
  ]);
}

function audioServerFrame(audio: Buffer, sessionId?: string) {
  const session = sessionId ? Buffer.from(sessionId, "utf8") : undefined;
  return Buffer.concat([
    Buffer.from([0x11, 0xb4, 0x00, 0x00]),
    int32(VoiceEvent.TTSResponse),
    ...(session ? [uint32(session.byteLength), session] : []),
    uint32(audio.byteLength),
    audio
  ]);
}

describe("Volcengine realtime voice event encoding", () => {
  it("encodes StartSession with the documented header, session ID and JSON payload", () => {
    const frame = encodeJsonEvent(
      VoiceEvent.StartSession,
      { dialog: { extra: { input_mod: "text" } } },
      { sessionId: "session-123" }
    );

    expect([...frame.subarray(0, 4)]).toEqual([0x11, 0x14, 0x10, 0x00]);
    const decoded = decodeClientFrame(frame);
    expect(decoded.eventId).toBe(VoiceEvent.StartSession);
    expect(decoded.sessionId).toBe("session-123");
    expect(JSON.parse(decoded.payload.toString("utf8"))).toEqual({
      dialog: { extra: { input_mod: "text" } }
    });
  });

  it("encodes the exact ChatTTSText payload without wrapping or rewriting it", () => {
    const payload = { start: true, content: "你好", end: false };
    const decoded = decodeClientFrame(encodeJsonEvent(
      VoiceEvent.ChatTTSText,
      payload,
      { sessionId: "session-tts" }
    ));

    expect(decoded.eventId).toBe(VoiceEvent.ChatTTSText);
    expect(decoded.sessionId).toBe("session-tts");
    expect(JSON.parse(decoded.payload.toString("utf8"))).toEqual(payload);
  });

  it("uses the documented audio-only header for TaskRequest", () => {
    const audio = Buffer.from([0x00, 0x01, 0xfe, 0xff]);
    const frame = encodeAudioEvent(VoiceEvent.TaskRequest, audio, { sessionId: "session-audio" });
    const decoded = decodeClientFrame(frame);

    expect([...frame.subarray(0, 4)]).toEqual([0x11, 0x24, 0x00, 0x00]);
    expect(decoded.payload).toEqual(audio);
  });

  it("encodes the documented EndASR boundary for push-to-talk input", () => {
    const frame = encodeJsonEvent(
      VoiceEvent.EndASR,
      {},
      { sessionId: "session-audio" }
    );
    const decoded = decodeClientFrame(frame);

    expect([...frame.subarray(0, 4)]).toEqual([0x11, 0x14, 0x10, 0x00]);
    expect(decoded.eventId).toBe(VoiceEvent.EndASR);
    expect(decoded.sessionId).toBe("session-audio");
    expect(JSON.parse(decoded.payload.toString("utf8"))).toEqual({});
  });

  it("requires session IDs only for session-scoped client events", () => {
    expect(() => encodeJsonEvent(VoiceEvent.StartSession, {})).toThrow(VoiceProtocolError);
    expect(() => encodeJsonEvent(
      VoiceEvent.StartConnection,
      {},
      { sessionId: "not-allowed" }
    )).toThrow(VoiceProtocolError);
    expect(() => encodeJsonEvent(VoiceEvent.StartConnection, {})).not.toThrow();
  });
});

describe("Volcengine realtime voice server event parsing", () => {
  it("parses ChatResponse JSON and its optional server session ID", () => {
    const event = parseServerEvent(jsonServerFrame({
      eventId: VoiceEvent.ChatResponse,
      sessionId: "session-chat",
      payload: { content: "今天有一件重要的事。", question_id: "question-1" }
    }));

    expect(event).toMatchObject({
      eventId: VoiceEvent.ChatResponse,
      eventName: "ChatResponse",
      sessionId: "session-chat",
      payload: { content: "今天有一件重要的事。", question_id: "question-1" },
      serialization: "json",
      compressed: false,
      unknown: false
    });
    expect(event.audio).toBeUndefined();
  });

  it("parses gzip JSON server payloads within the decompression bound", () => {
    const event = parseServerEvent(jsonServerFrame({
      eventId: VoiceEvent.SessionStarted,
      sessionId: "session-gzip",
      payload: { dialog_id: "dialog-1" },
      gzip: true
    }));

    expect(event.payload).toEqual({ dialog_id: "dialog-1" });
    expect(event.compressed).toBe(true);
  });

  it("returns TTSResponse bytes without attempting text decoding", () => {
    const audio = Buffer.from([0x00, 0xff, 0x81, 0x7f]);
    const event = parseServerEvent(audioServerFrame(audio, "session-voice"));

    expect(event).toMatchObject({
      eventId: VoiceEvent.TTSResponse,
      eventName: "TTSResponse",
      sessionId: "session-voice",
      serialization: "none",
      unknown: false
    });
    expect(event.audio).toEqual(audio);
    expect(event.rawPayload).toEqual(audio);
    expect(event.payload).toBeUndefined();
  });

  it("parses protocol Error frames as a bounded error code and JSON payload", () => {
    const payload = Buffer.from(JSON.stringify({ error: "provider rejected request" }), "utf8");
    const frame = Buffer.concat([
      Buffer.from([0x11, 0xf0, 0x10, 0x00]),
      int32(3001),
      uint32(payload.byteLength),
      payload
    ]);

    expect(parseServerEvent(frame)).toMatchObject({
      eventId: VoiceEvent.DialogCommonError,
      eventName: "DialogCommonError",
      errorCode: 3001,
      payload: { error: "provider rejected request" },
      serialization: "json",
      unknown: false
    });
  });

  it("preserves unknown event IDs for forward-compatible diagnostics", () => {
    const event = parseServerEvent(jsonServerFrame({ eventId: 777, payload: { status: "new" } }));
    expect(event).toMatchObject({
      eventId: 777,
      eventName: "Unknown(777)",
      payload: { status: "new" },
      unknown: true
    });
  });

  it.each([
    ["truncated payload", Buffer.from([0x11, 0x94, 0x10, 0x00, 0, 0, 2, 0, 0, 0, 0, 9])],
    ["wrong protocol version", Buffer.from([0x21, 0x94, 0x10, 0x00, 0, 0, 2, 0, 0, 0, 0, 0])],
    ["unsupported compression", Buffer.from([0x11, 0x94, 0x12, 0x00, 0, 0, 2, 0, 0, 0, 0, 0])],
    ["missing event flag", Buffer.from([0x11, 0x90, 0x10, 0x00, 0, 0, 0, 0])]
  ])("rejects a damaged frame: %s", (_label, frame) => {
    expect(() => parseServerEvent(frame)).toThrow(VoiceProtocolError);
  });
});
