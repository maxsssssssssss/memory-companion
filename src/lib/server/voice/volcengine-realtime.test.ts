// @vitest-environment node

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { VoiceEvent } from "./events";
import type { VolcengineRealtimeConfig } from "./provider";
import {
  VolcengineRealtimeVoiceProvider,
  buildVolcengineStartSessionPayload,
  type VoiceWebSocketLike
} from "./volcengine-realtime";

const config: VolcengineRealtimeConfig = {
  endpoint: "wss://openspeech.bytedance.com/api/v3/realtime/dialogue",
  appId: "app-id",
  accessKey: "access-key",
  appKey: "app-key",
  resourceId: "volc.speech.dialog",
  connectTimeoutMs: 1_000,
  eventTimeoutMs: 1_000,
  model: "1.2.1.1",
  speaker: undefined
};

class FakeSocket extends EventEmitter {
  readyState = 0;
  binaryType = "nodebuffer";
  readonly sent: Buffer[] = [];

  send(data: Buffer, callback: (error?: Error) => void) {
    this.sent.push(Buffer.from(data));
    callback();
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  message(frame: Buffer) {
    this.emit("message", frame);
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", code, Buffer.from(reason)));
  }

  terminate() {
    this.close(1006, "terminated");
  }
}

function int32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

function serverEventFrame(input: {
  eventId: number;
  payload?: unknown;
  audio?: Buffer;
  sessionId?: string;
}) {
  const isAudio = Boolean(input.audio);
  const payload = input.audio ?? Buffer.from(JSON.stringify(input.payload ?? {}), "utf8");
  const session = input.sessionId ? Buffer.from(input.sessionId, "utf8") : undefined;
  return Buffer.concat([
    Buffer.from([0x11, isAudio ? 0xb4 : 0x94, isAudio ? 0x00 : 0x10, 0x00]),
    int32(input.eventId),
    ...(session ? [int32(session.byteLength), session] : []),
    int32(payload.byteLength),
    payload
  ]);
}

function serverErrorFrame(code: number) {
  const payload = Buffer.from(JSON.stringify({ error: "sensitive provider detail" }), "utf8");
  return Buffer.concat([
    Buffer.from([0x11, 0xf0, 0x10, 0x00]),
    int32(code),
    int32(payload.byteLength),
    payload
  ]);
}

function decodeClientFrame(frame: Buffer) {
  let offset = 4;
  const eventId = frame.readInt32BE(offset);
  offset += 4;
  let sessionId: string | undefined;
  if (eventId !== VoiceEvent.StartConnection && eventId !== VoiceEvent.FinishConnection) {
    const length = frame.readInt32BE(offset);
    offset += 4;
    sessionId = frame.subarray(offset, offset + length).toString("utf8");
    offset += length;
  }
  const payloadLength = frame.readInt32BE(offset);
  offset += 4;
  const rawPayload = frame.subarray(offset, offset + payloadLength);
  return {
    eventId,
    sessionId,
    payload: frame[2] >> 4 === 1 ? JSON.parse(rawPayload.toString("utf8")) : rawPayload
  };
}

async function nextTurn() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function connectProvider(provider: VolcengineRealtimeVoiceProvider, socket: FakeSocket) {
  const connected = provider.connect();
  socket.open();
  await nextTurn();
  socket.message(serverEventFrame({ eventId: VoiceEvent.ConnectionStarted }));
  await connected;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("VolcengineRealtimeVoiceProvider", () => {
  it("uses the documented WebSocket URL and four required authentication headers", async () => {
    const socket = new FakeSocket();
    const factory = vi.fn(() => socket as unknown as VoiceWebSocketLike);
    const provider = new VolcengineRealtimeVoiceProvider(config, {
      socketFactory: factory,
      idFactory: () => "connect-id"
    });

    await connectProvider(provider, socket);

    expect(factory).toHaveBeenCalledWith(config.endpoint, {
      headers: {
        "X-Api-App-ID": "app-id",
        "X-Api-Access-Key": "access-key",
        "X-Api-Resource-Id": "volc.speech.dialog",
        "X-Api-App-Key": "app-key",
        "X-Api-Connect-Id": "connect-id"
      }
    });
    expect(decodeClientFrame(socket.sent[0])).toEqual({
      eventId: VoiceEvent.StartConnection,
      sessionId: undefined,
      payload: {}
    });
    await provider.close();
  });

  it("starts a text/PCM session and sends documented ChatTTSText start/end payloads", async () => {
    const socket = new FakeSocket();
    const ids = ["connect-id", "session-id"];
    const provider = new VolcengineRealtimeVoiceProvider(config, {
      socketFactory: () => socket as unknown as VoiceWebSocketLike,
      idFactory: () => ids.shift() ?? "unexpected-id"
    });
    await connectProvider(provider, socket);

    const starting = provider.startSession({
      model: "1.2.1.1",
      audioOutput: { format: "pcm_s16le", sampleRate: 24_000, channels: 1 }
    });
    let sessionSettled = false;
    void starting.then(
      () => { sessionSettled = true; },
      () => { sessionSettled = true; }
    );
    await nextTurn();
    expect(decodeClientFrame(socket.sent.at(-1)!)).toEqual({
      eventId: VoiceEvent.StartSession,
      sessionId: "session-id",
      payload: {
        dialog: { extra: { input_mod: "text", model: "1.2.1.1" } },
        tts: { audio_config: { format: "pcm_s16le", sample_rate: 24_000, channel: 1 } }
      }
    });
    socket.message(serverEventFrame({
      eventId: VoiceEvent.SessionStarted,
      sessionId: "different-session",
      payload: { dialog_id: "wrong-dialog" }
    }));
    await nextTurn();
    expect(sessionSettled).toBe(false);
    socket.message(serverEventFrame({
      eventId: VoiceEvent.SessionStarted,
      sessionId: "session-id",
      payload: { dialog_id: "dialog-id" }
    }));
    await expect(starting).resolves.toEqual({ sessionId: "session-id", dialogId: "dialog-id" });

    await provider.sendText("你好，介绍一下今天的情况");
    expect(socket.sent.slice(-2).map(decodeClientFrame)).toEqual([
      {
        eventId: VoiceEvent.ChatTTSText,
        sessionId: "session-id",
        payload: { start: true, content: "你好，介绍一下今天的情况", end: false }
      },
      {
        eventId: VoiceEvent.ChatTTSText,
        sessionId: "session-id",
        payload: { start: false, content: "", end: true }
      }
    ]);

    const finishing = provider.finishSession();
    await nextTurn();
    socket.message(serverEventFrame({
      eventId: VoiceEvent.SessionFinished,
      sessionId: "session-id"
    }));
    await finishing;
    await provider.close();
  });

  it("ends push-to-talk audio with one documented EndASR event", async () => {
    const socket = new FakeSocket();
    const ids = ["connect-id", "session-id"];
    const provider = new VolcengineRealtimeVoiceProvider(config, {
      socketFactory: () => socket as unknown as VoiceWebSocketLike,
      idFactory: () => ids.shift() ?? "unexpected-id"
    });
    await connectProvider(provider, socket);

    const starting = provider.startSession({ inputMode: "push_to_talk" });
    await nextTurn();
    socket.message(serverEventFrame({
      eventId: VoiceEvent.SessionStarted,
      sessionId: "session-id"
    }));
    await starting;

    const audio = Buffer.alloc(640, 1);
    await provider.sendAudio(audio);
    await provider.finishAudioInput();

    expect(socket.sent.slice(-2).map(decodeClientFrame)).toEqual([
      {
        eventId: VoiceEvent.TaskRequest,
        sessionId: "session-id",
        payload: audio
      },
      {
        eventId: VoiceEvent.EndASR,
        sessionId: "session-id",
        payload: {}
      }
    ]);
    await expect(provider.finishAudioInput()).rejects.toMatchObject({
      reason: "invalid_state"
    });
    await expect(provider.sendAudio(Buffer.from([1, 2]))).rejects.toMatchObject({
      reason: "invalid_state"
    });
    await provider.close();
  });

  it("does not send EndASR outside push-to-talk sessions", async () => {
    const socket = new FakeSocket();
    const ids = ["connect-id", "session-id"];
    const provider = new VolcengineRealtimeVoiceProvider(config, {
      socketFactory: () => socket as unknown as VoiceWebSocketLike,
      idFactory: () => ids.shift() ?? "unexpected-id"
    });
    await connectProvider(provider, socket);

    const starting = provider.startSession({ inputMode: "audio_file" });
    await nextTurn();
    socket.message(serverEventFrame({
      eventId: VoiceEvent.SessionStarted,
      sessionId: "session-id"
    }));
    await starting;
    const sentBefore = socket.sent.length;

    await expect(provider.finishAudioInput()).rejects.toMatchObject({
      reason: "invalid_state"
    });
    expect(socket.sent).toHaveLength(sentBefore);
    await provider.close();
  });

  it("logs only safe ChatTTSText frame metadata for successful sends", async () => {
    vi.stubEnv("VOICE_DEBUG", "true");
    const logger = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const socket = new FakeSocket();
    const ids = ["private-connect-id", "private-session-id"];
    const provider = new VolcengineRealtimeVoiceProvider(config, {
      socketFactory: () => socket as unknown as VoiceWebSocketLike,
      idFactory: () => ids.shift() ?? "unexpected-id"
    });
    await connectProvider(provider, socket);
    const starting = provider.startSession();
    await nextTurn();
    socket.message(serverEventFrame({
      eventId: VoiceEvent.SessionStarted,
      sessionId: "private-session-id"
    }));
    await starting;

    await provider.sendText("PRIVATE USER ANSWER TEXT");
    const [contentFrame, endFrame] = socket.sent.slice(-2);
    const chatTtsLogs = logger.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('"event":"chat_tts_text_'));
    expect(chatTtsLogs).toEqual([
      `VOICE_DEBUG {"event":"chat_tts_text_frame_encoded","message_type":"ChatTTSText","frame_role":"start_content","start":true,"end":false,"encoded_frame_size":${contentFrame.byteLength}}`,
      `VOICE_DEBUG {"event":"chat_tts_text_send_settled","message_type":"ChatTTSText","frame_role":"start_content","start":true,"end":false,"encoded_frame_size":${contentFrame.byteLength},"send_success":true}`,
      `VOICE_DEBUG {"event":"chat_tts_text_frame_encoded","message_type":"ChatTTSText","frame_role":"end","start":false,"end":true,"encoded_frame_size":${endFrame.byteLength}}`,
      `VOICE_DEBUG {"event":"chat_tts_text_send_settled","message_type":"ChatTTSText","frame_role":"end","start":false,"end":true,"encoded_frame_size":${endFrame.byteLength},"send_success":true}`
    ]);
    const logs = chatTtsLogs.join("\n");
    expect(logs).not.toContain("PRIVATE USER ANSWER TEXT");
    expect(logs).not.toContain("private-connect-id");
    expect(logs).not.toContain("private-session-id");
    expect(logs).not.toContain(config.appId);
    expect(logs).not.toContain(config.accessKey);
    expect(logs).not.toContain(config.appKey);

    await provider.close();
  });

  it("logs which ChatTTSText frame failed without exposing text or error details", async () => {
    vi.stubEnv("VOICE_DEBUG", "true");
    const logger = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const socket = new FakeSocket();
    const ids = ["private-connect-id", "private-session-id"];
    const provider = new VolcengineRealtimeVoiceProvider(config, {
      socketFactory: () => socket as unknown as VoiceWebSocketLike,
      idFactory: () => ids.shift() ?? "unexpected-id"
    });
    await connectProvider(provider, socket);
    const starting = provider.startSession();
    await nextTurn();
    socket.message(serverEventFrame({
      eventId: VoiceEvent.SessionStarted,
      sessionId: "private-session-id"
    }));
    await starting;

    const send = socket.send.bind(socket);
    let chatTtsSendCount = 0;
    vi.spyOn(socket, "send").mockImplementation((data, callback) => {
      chatTtsSendCount += 1;
      if (chatTtsSendCount === 2) {
        callback(new Error("PRIVATE SEND FAILURE DETAIL"));
        return;
      }
      send(data, callback);
    });
    await expect(provider.sendText("PRIVATE USER ANSWER TEXT"))
      .rejects.toMatchObject({ reason: "connection_failed" });

    const chatTtsLogs = logger.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('"event":"chat_tts_text_'));
    expect(chatTtsLogs).toHaveLength(4);
    expect(chatTtsLogs[1]).toMatch(
      /^VOICE_DEBUG \{"event":"chat_tts_text_send_settled","message_type":"ChatTTSText","frame_role":"start_content","start":true,"end":false,"encoded_frame_size":\d+,"send_success":true\}$/
    );
    expect(chatTtsLogs[3]).toMatch(
      /^VOICE_DEBUG \{"event":"chat_tts_text_send_settled","message_type":"ChatTTSText","frame_role":"end","start":false,"end":true,"encoded_frame_size":\d+,"send_success":false\}$/
    );
    const logs = chatTtsLogs.join("\n");
    expect(logs).not.toContain("PRIVATE USER ANSWER TEXT");
    expect(logs).not.toContain("PRIVATE SEND FAILURE DETAIL");
    expect(logs).not.toContain("private-connect-id");
    expect(logs).not.toContain("private-session-id");
    expect(logs).not.toContain(config.appId);
    expect(logs).not.toContain(config.accessKey);
    expect(logs).not.toContain(config.appKey);

    socket.close(1006, "test complete");
    await nextTurn();
    await provider.close();
  });

  it("logs only safe StartSession payload, frame, and successful send metadata", async () => {
    vi.stubEnv("VOICE_DEBUG", "true");
    const logger = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const socket = new FakeSocket();
    const ids = ["private-connect-id", "private-session-id"];
    const provider = new VolcengineRealtimeVoiceProvider(config, {
      socketFactory: () => socket as unknown as VoiceWebSocketLike,
      idFactory: () => ids.shift() ?? "unexpected-id"
    });
    await connectProvider(provider, socket);

    const starting = provider.startSession({
      model: "2.2.0.0",
      speaker: "private-speaker-value",
      audioOutput: { format: "pcm_s16le", sampleRate: 24_000, channels: 1 }
    });
    await nextTurn();
    const frameSize = socket.sent.at(-1)!.byteLength;
    socket.message(serverEventFrame({
      eventId: VoiceEvent.SessionStarted,
      sessionId: "private-session-id"
    }));
    await starting;

    const startSessionLogs = logger.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('"event":"start_session_'));
    expect(startSessionLogs).toEqual([
      'VOICE_DEBUG {"event":"start_session_payload_prepared","message_type":"StartSession","payload_keys":"dialog,tts"}',
      `VOICE_DEBUG {"event":"start_session_frame_encoded","message_type":"StartSession","payload_keys":"dialog,tts","encoded_frame_size":${frameSize}}`,
      `VOICE_DEBUG {"event":"start_session_send_settled","message_type":"StartSession","payload_keys":"dialog,tts","encoded_frame_size":${frameSize},"send_success":true}`
    ]);
    const logs = startSessionLogs.join("\n");
    expect(logs).not.toContain("private-connect-id");
    expect(logs).not.toContain("private-session-id");
    expect(logs).not.toContain("2.2.0.0");
    expect(logs).not.toContain("private-speaker-value");
    expect(logs).not.toContain(config.appId);
    expect(logs).not.toContain(config.accessKey);
    expect(logs).not.toContain(config.appKey);

    await provider.close();
  });

  it("logs a safe StartSession send failure without exposing the error", async () => {
    vi.stubEnv("VOICE_DEBUG", "true");
    const logger = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const socket = new FakeSocket();
    const ids = ["private-connect-id", "private-session-id"];
    const provider = new VolcengineRealtimeVoiceProvider(config, {
      socketFactory: () => socket as unknown as VoiceWebSocketLike,
      idFactory: () => ids.shift() ?? "unexpected-id"
    });
    await connectProvider(provider, socket);
    vi.spyOn(socket, "send").mockImplementation((_data, callback) => {
      callback(new Error("private send failure detail"));
    });

    await expect(provider.startSession()).rejects.toMatchObject({
      reason: "connection_failed"
    });

    const startSessionLogs = logger.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('"event":"start_session_'));
    expect(startSessionLogs).toHaveLength(3);
    expect(startSessionLogs[2]).toMatch(
      /^VOICE_DEBUG \{"event":"start_session_send_settled","message_type":"StartSession","payload_keys":"dialog","encoded_frame_size":\d+,"send_success":false\}$/
    );
    const logs = startSessionLogs.join("\n");
    expect(logs).not.toContain("private send failure detail");
    expect(logs).not.toContain("private-connect-id");
    expect(logs).not.toContain("private-session-id");
    expect(logs).not.toContain(config.appId);
    expect(logs).not.toContain(config.accessKey);
    expect(logs).not.toContain(config.appKey);

    await provider.close();
  });

  it("emits ChatResponse text, ASR text, and raw TTS audio through callbacks", async () => {
    const socket = new FakeSocket();
    const provider = new VolcengineRealtimeVoiceProvider(config, {
      socketFactory: () => socket as unknown as VoiceWebSocketLike,
      idFactory: () => "connect-id"
    });
    const transcripts: string[] = [];
    const audio: Buffer[] = [];
    provider.onTranscript((text) => transcripts.push(text));
    provider.onAudio((chunk) => audio.push(chunk));
    await connectProvider(provider, socket);

    socket.message(serverEventFrame({
      eventId: VoiceEvent.ChatResponse,
      sessionId: "session-id",
      payload: { content: "assistant response" }
    }));
    socket.message(serverEventFrame({
      eventId: VoiceEvent.ASRResponse,
      sessionId: "session-id",
      payload: { results: [{ text: "user transcript", is_interim: false }] }
    }));
    socket.message(serverEventFrame({
      eventId: VoiceEvent.TTSResponse,
      sessionId: "session-id",
      audio: Buffer.from([0x00, 0xff, 0x01, 0x02])
    }));

    expect(transcripts).toEqual(["assistant response", "user transcript"]);
    expect(audio).toEqual([Buffer.from([0x00, 0xff, 0x01, 0x02])]);
    await provider.close();
  });

  it("rejects a pending operation on a server Error frame without exposing its payload", async () => {
    const socket = new FakeSocket();
    const provider = new VolcengineRealtimeVoiceProvider(config, {
      socketFactory: () => socket as unknown as VoiceWebSocketLike,
      idFactory: () => "connect-id"
    });
    const connecting = provider.connect();
    socket.open();
    await nextTurn();
    socket.message(serverErrorFrame(45000001));

    await expect(connecting).rejects.toMatchObject({
      reason: "provider_error",
      providerCode: 45000001
    });
    await expect(connecting).rejects.not.toThrow("sensitive provider detail");
    await provider.close();
  });

  it("rebuilds the socket and latest session while preserving registered callbacks", async () => {
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const sockets = [firstSocket, secondSocket];
    const ids = ["first-connect", "first-session", "second-connect", "second-session"];
    const factory = vi.fn(() => sockets.shift() as unknown as VoiceWebSocketLike);
    const provider = new VolcengineRealtimeVoiceProvider(config, {
      socketFactory: factory,
      idFactory: () => ids.shift() ?? "unexpected-id"
    });
    const transcripts: string[] = [];
    const audio: Buffer[] = [];
    provider.onTranscript((text) => transcripts.push(text));
    provider.onAudio((chunk) => audio.push(chunk));

    await connectProvider(provider, firstSocket);
    const firstSession = provider.startSession({
      inputMode: "push_to_talk",
      audioOutput: { format: "pcm_s16le", sampleRate: 24_000, channels: 1 }
    });
    await nextTurn();
    firstSocket.message(serverEventFrame({
      eventId: VoiceEvent.SessionStarted,
      sessionId: "first-session"
    }));
    await firstSession;

    firstSocket.close(1006, "unexpected disconnect");
    await nextTurn();
    await expect(provider.sendAudio(Buffer.from([0x01])))
      .rejects.toMatchObject({ reason: "connection_closed" });

    const reconnecting = provider.reconnect();
    secondSocket.open();
    await nextTurn();
    secondSocket.message(serverEventFrame({ eventId: VoiceEvent.ConnectionStarted }));
    await nextTurn();
    expect(decodeClientFrame(secondSocket.sent.at(-1)!)).toEqual({
      eventId: VoiceEvent.StartSession,
      sessionId: "second-session",
      payload: {
        dialog: { extra: { input_mod: "push_to_talk", model: "1.2.1.1" } },
        tts: { audio_config: { format: "pcm_s16le", sample_rate: 24_000, channel: 1 } }
      }
    });
    secondSocket.message(serverEventFrame({
      eventId: VoiceEvent.SessionStarted,
      sessionId: "second-session",
      payload: { dialog_id: "restored-dialog" }
    }));

    await expect(reconnecting).resolves.toEqual({
      sessionId: "second-session",
      dialogId: "restored-dialog"
    });
    expect(factory).toHaveBeenCalledTimes(2);

    secondSocket.message(serverEventFrame({
      eventId: VoiceEvent.ASRResponse,
      sessionId: "second-session",
      payload: { results: [{ text: "restored transcript", is_interim: false }] }
    }));
    secondSocket.message(serverEventFrame({
      eventId: VoiceEvent.TTSResponse,
      sessionId: "second-session",
      audio: Buffer.from([0x01, 0x02])
    }));
    expect(transcripts).toEqual(["restored transcript"]);
    expect(audio).toEqual([Buffer.from([0x01, 0x02])]);

    secondSocket.close(1006, "test complete");
    await nextTurn();
    await provider.close();
  });

  it("performs one connection attempt per call and leaves additional attempts to the caller", async () => {
    const firstSocket = new FakeSocket();
    const failedReconnectSocket = new FakeSocket();
    const restoredSocket = new FakeSocket();
    const sockets = [firstSocket, failedReconnectSocket, restoredSocket];
    const factory = vi.fn(() => sockets.shift() as unknown as VoiceWebSocketLike);
    const ids = [
      "first-connect",
      "first-session",
      "failed-connect",
      "restored-connect",
      "restored-session"
    ];
    const provider = new VolcengineRealtimeVoiceProvider(config, {
      socketFactory: factory,
      idFactory: () => ids.shift() ?? "unexpected-id"
    });
    await connectProvider(provider, firstSocket);
    const starting = provider.startSession();
    await nextTurn();
    firstSocket.message(serverEventFrame({
      eventId: VoiceEvent.SessionStarted,
      sessionId: "first-session"
    }));
    await starting;
    firstSocket.close(1006, "unexpected disconnect");
    await nextTurn();

    const reconnecting = provider.reconnect();
    failedReconnectSocket.emit("error", new Error("socket detail must stay private"));
    await expect(reconnecting).rejects.toMatchObject({ reason: "connection_failed" });
    expect(factory).toHaveBeenCalledTimes(2);

    const secondReconnect = provider.reconnect();
    restoredSocket.open();
    await nextTurn();
    restoredSocket.message(serverEventFrame({ eventId: VoiceEvent.ConnectionStarted }));
    await nextTurn();
    restoredSocket.message(serverEventFrame({
      eventId: VoiceEvent.SessionStarted,
      sessionId: "restored-session"
    }));
    await expect(secondReconnect).resolves.toEqual({ sessionId: "restored-session" });
    expect(factory).toHaveBeenCalledTimes(3);

    restoredSocket.close(1006, "test complete");
    await nextTurn();
    await provider.close();
  });

  it("emits structural VOICE_DEBUG metadata without transcript, payload, audio, or credentials", async () => {
    vi.stubEnv("VOICE_DEBUG", "true");
    const logger = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const socket = new FakeSocket();
    const provider = new VolcengineRealtimeVoiceProvider(config, {
      socketFactory: () => socket as unknown as VoiceWebSocketLike,
      idFactory: () => "connect-id"
    });
    await connectProvider(provider, socket);

    socket.message(serverEventFrame({
      eventId: VoiceEvent.ASRResponse,
      sessionId: "private-session",
      payload: {
        results: [
          { text: "SECRET TRANSCRIPT", is_interim: true },
          { text: "FINAL SECRET TRANSCRIPT", is_interim: false }
        ]
      }
    }));
    socket.message(serverEventFrame({
      eventId: VoiceEvent.TTSResponse,
      sessionId: "private-session",
      audio: Buffer.from("SECRET AUDIO")
    }));
    socket.message(serverErrorFrame(45000001));

    const logs = logger.mock.calls.map(([message]) => String(message)).join("\n");
    expect(logs).toContain('"event":"asr_event"');
    expect(logs).toContain('"result_count":2');
    expect(logs).toContain('"final_count":1');
    expect(logs).toContain('"partial_count":1');
    expect(logs).toContain('"event":"tts_event"');
    expect(logs).toContain('"audio_bytes":12');
    expect(logs).not.toContain("SECRET TRANSCRIPT");
    expect(logs).not.toContain("SECRET AUDIO");
    expect(logs).not.toContain("sensitive provider detail");
    expect(logs).not.toContain(config.appId);
    expect(logs).not.toContain(config.accessKey);
    expect(logs).not.toContain(config.appKey);

    await provider.close();
  });
});

describe("buildVolcengineStartSessionPayload", () => {
  it("does not inject dialog history or Memory into the provider session", () => {
    const payload = buildVolcengineStartSessionPayload({ audioOutput: { format: "provider_default" } });

    expect(payload).toEqual({
      dialog: { extra: { input_mod: "text", model: "1.2.1.1" } }
    });
    expect(JSON.stringify(payload)).not.toContain("dialog_context");
    expect(JSON.stringify(payload)).not.toContain("memory");
  });

  it("uses the provider default VAD mode by omitting undocumented input_mod values", () => {
    expect(buildVolcengineStartSessionPayload({ inputMode: "server_vad" })).toEqual({
      dialog: { extra: { model: "1.2.1.1" } }
    });
  });

  it("rejects PCM settings outside the documented 24 kHz mono contract", () => {
    expect(() => buildVolcengineStartSessionPayload({
      audioOutput: { format: "pcm_s16le", sampleRate: 48_000, channels: 1 }
    })).toThrow("24000");
    expect(() => buildVolcengineStartSessionPayload({
      audioOutput: { format: "pcm_s16le", sampleRate: 24_000, channels: 2 }
    })).toThrow("one channel");
  });
});
