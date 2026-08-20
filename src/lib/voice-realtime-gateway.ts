export const REALTIME_VOICE_GATEWAY_PROTOCOL_VERSION = 1 as const;
export const REALTIME_VOICE_GATEWAY_SUBPROTOCOL =
  "daily-brief-realtime-voice.v1" as const;
export const REALTIME_VOICE_GATEWAY_PROTOCOL_VERSION_V2 = 2 as const;
export const REALTIME_VOICE_GATEWAY_SUBPROTOCOL_V2 =
  "daily-brief-realtime-voice.v2" as const;

const AUDIO_FRAME_MAGIC = 0x44564231; // DVB1
const AUDIO_FRAME_HEADER_BYTES = 20;
const MAX_AUDIO_FRAME_BYTES = 256 * 1024;
const MAX_PROVIDER_ITEM_ID_BYTES = 1_024;

export type RealtimeVoiceGatewayClientControl =
  | {
      type: "session_start";
      version: 1;
      scope: "current" | "week" | "all";
      uploadId?: string;
      referenceDate?: string;
    }
  | {
      type: "browser_playback_start";
      turnSequence: number;
    }
  | {
      type: "conversation_truncate";
      turnSequence: number;
      providerItemId: string;
      audioEndMs: number;
    }
  | { type: "ping"; nonce: string }
  | { type: "session_close" };

export type RealtimeVoiceGatewayAudioFrame =
  | {
      kind: "input_pcm";
      pcm16le: Uint8Array;
    }
  | {
      kind: "output_pcm";
      turnSequence: number;
      sequence: number;
      sentenceSequence: number;
      providerItemId?: string;
      pcm16le: Uint8Array;
    };

export interface RealtimeVoiceGatewayTransport {
  readonly kind: "websocket";
  connect(): Promise<void>;
  sendControl(message: RealtimeVoiceGatewayClientControl): Promise<void>;
  sendAudio(frame: Extract<
    RealtimeVoiceGatewayAudioFrame,
    { kind: "input_pcm" }
  >): Promise<void>;
  close(): Promise<void>;
}

export class RealtimeVoiceGatewayProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealtimeVoiceGatewayProtocolError";
  }
}

export type RealtimeVoiceGatewaySessionStartV2 = {
  type: "session_start";
  version: 2;
  scope: "current" | "week" | "all";
  uploadId?: string;
  referenceDate?: string;
  context?: unknown;
  conversation?: unknown[];
};

export type RealtimeVoiceGatewayClientControlV2 =
  | RealtimeVoiceGatewaySessionStartV2
  | {
      type: "session_resume";
      version: 2;
      sessionId: string;
      lastInputAck: number;
      lastServerAck: number;
    }
  | { type: "start_turn"; commandId: string }
  | { type: "interrupt"; commandId: string; turnSequence?: number }
  | { type: "server_ack"; throughSequence: number }
  | {
      type: "browser_playback_start";
      commandId: string;
      turnSequence: number;
    }
  | {
      type: "conversation_truncate";
      commandId: string;
      turnSequence: number;
      providerItemId: string;
      audioEndMs: number;
    }
  | { type: "ping"; nonce: string }
  | { type: "session_close"; commandId: string };

export type RealtimeVoiceGatewayServerControlV2 =
  | {
      type: "ready";
      version: 2;
      sessionId: string;
      connectionId: string;
      resumed: boolean;
      inputEpoch: number;
      providerEpoch: number;
      inputAckThrough: number;
      replayFrom: number;
      serverSequence: number;
    }
  | { type: "input_ack"; throughSequence: number }
  | {
      type: "event";
      serverSequence: number;
      name: string;
      event: unknown;
    }
  | {
      type: "command_ack";
      commandId: string;
      status: "applied" | "already_applied" | "stale" | "rejected";
    }
  | { type: "pong"; nonce: string }
  | {
      type: "resync_required";
      reason: "replay_expired" | "session_lost" | "provider_restarted";
    }
  | { type: "error"; code: string; fatal: boolean };

export type RealtimeVoiceGatewayAudioFrameV2 =
  | {
      kind: "input_pcm";
      inputEpoch: number;
      sequence: number;
      timestampMs: number;
      pcm16le: Uint8Array;
    }
  | {
      kind: "output_pcm";
      providerEpoch: number;
      serverSequence: number;
      turnSequence: number;
      sequence: number;
      sentenceSequence: number;
      itemOffsetSamples: number;
      providerItemId: string;
      pcm16le: Uint8Array;
    };

const AUDIO_FRAME_V2_MAGIC = 0x44564232; // DVB2
const AUDIO_FRAME_V2_HEADER_BYTES = 48;

function nonNegativeSafeInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RealtimeVoiceGatewayProtocolError(
      `${name} must be a non-negative safe integer`
    );
  }
  return value;
}

/**
 * Version 2 keeps the browser input cursor and the server replay cursor in the
 * binary frame itself. This lets reconnect logic deduplicate PCM without ever
 * inspecting transcripts, answers, evidence, or citations.
 */
export function encodeRealtimeVoiceGatewayAudioFrameV2(
  frame: RealtimeVoiceGatewayAudioFrameV2
) {
  const pcm16le = pcmBytes(frame.pcm16le);
  const providerItemId = frame.kind === "output_pcm"
    ? frame.providerItemId.trim()
    : "";
  if (frame.kind === "output_pcm" && !providerItemId) {
    throw new RealtimeVoiceGatewayProtocolError(
      "Realtime Voice v2 output PCM requires a Provider item ID"
    );
  }
  const itemBytes = providerItemId
    ? new TextEncoder().encode(providerItemId)
    : new Uint8Array();
  if (itemBytes.byteLength > MAX_PROVIDER_ITEM_ID_BYTES) {
    throw new RealtimeVoiceGatewayProtocolError(
      "Realtime Voice Provider item ID is too large"
    );
  }
  const output = new Uint8Array(
    AUDIO_FRAME_V2_HEADER_BYTES + itemBytes.byteLength + pcm16le.byteLength
  );
  const view = new DataView(output.buffer);
  view.setUint32(0, AUDIO_FRAME_V2_MAGIC, false);
  view.setUint8(4, REALTIME_VOICE_GATEWAY_PROTOCOL_VERSION_V2);
  view.setUint8(5, frame.kind === "input_pcm" ? 1 : 2);
  view.setUint16(6, itemBytes.byteLength, false);
  if (frame.kind === "input_pcm") {
    view.setUint32(8, positiveUint32(frame.inputEpoch, "inputEpoch"), false);
    view.setUint32(20, positiveUint32(frame.sequence, "sequence"), false);
    view.setBigUint64(
      32,
      BigInt(nonNegativeSafeInteger(frame.timestampMs, "timestampMs")),
      false
    );
  } else {
    view.setUint32(8, positiveUint32(frame.providerEpoch, "providerEpoch"), false);
    view.setUint32(
      12,
      positiveUint32(frame.serverSequence, "serverSequence"),
      false
    );
    view.setUint32(
      16,
      positiveUint32(frame.turnSequence, "turnSequence"),
      false
    );
    view.setUint32(20, positiveUint32(frame.sequence, "sequence"), false);
    view.setUint32(
      24,
      positiveUint32(frame.sentenceSequence, "sentenceSequence"),
      false
    );
    view.setUint32(
      28,
      nonNegativeSafeInteger(frame.itemOffsetSamples, "itemOffsetSamples"),
      false
    );
  }
  view.setUint32(40, pcm16le.byteLength, false);
  output.set(itemBytes, AUDIO_FRAME_V2_HEADER_BYTES);
  output.set(pcm16le, AUDIO_FRAME_V2_HEADER_BYTES + itemBytes.byteLength);
  return output;
}

export function decodeRealtimeVoiceGatewayAudioFrameV2(
  value: ArrayBuffer | Uint8Array
): RealtimeVoiceGatewayAudioFrameV2 {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (bytes.byteLength < AUDIO_FRAME_V2_HEADER_BYTES) {
    throw new RealtimeVoiceGatewayProtocolError(
      "Realtime Voice v2 audio frame is truncated"
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(0, false) !== AUDIO_FRAME_V2_MAGIC ||
    view.getUint8(4) !== REALTIME_VOICE_GATEWAY_PROTOCOL_VERSION_V2
  ) {
    throw new RealtimeVoiceGatewayProtocolError(
      "Realtime Voice v2 audio frame header is invalid"
    );
  }
  const itemLength = view.getUint16(6, false);
  const pcmLength = view.getUint32(40, false);
  const pcmOffset = AUDIO_FRAME_V2_HEADER_BYTES + itemLength;
  if (pcmOffset + pcmLength !== bytes.byteLength || pcmLength === 0) {
    throw new RealtimeVoiceGatewayProtocolError(
      "Realtime Voice v2 audio frame length is invalid"
    );
  }
  const pcm16le = pcmBytes(bytes.slice(pcmOffset));
  const kind = view.getUint8(5);
  if (kind === 1) {
    if (itemLength !== 0) {
      throw new RealtimeVoiceGatewayProtocolError(
        "Realtime Voice v2 input PCM must not contain an item ID"
      );
    }
    const timestamp = view.getBigUint64(32, false);
    if (timestamp > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RealtimeVoiceGatewayProtocolError(
        "Realtime Voice v2 timestamp exceeds the safe integer range"
      );
    }
    return {
      kind: "input_pcm",
      inputEpoch: positiveUint32(view.getUint32(8, false), "inputEpoch"),
      sequence: positiveUint32(view.getUint32(20, false), "sequence"),
      timestampMs: Number(timestamp),
      pcm16le
    };
  }
  if (kind !== 2) {
    throw new RealtimeVoiceGatewayProtocolError(
      "Realtime Voice v2 audio frame kind is unsupported"
    );
  }
  const providerItemId = new TextDecoder("utf-8", { fatal: true })
    .decode(bytes.slice(AUDIO_FRAME_V2_HEADER_BYTES, pcmOffset))
    .trim();
  if (!providerItemId) {
    throw new RealtimeVoiceGatewayProtocolError(
      "Realtime Voice v2 output PCM requires a Provider item ID"
    );
  }
  return {
    kind: "output_pcm",
    providerEpoch: positiveUint32(view.getUint32(8, false), "providerEpoch"),
    serverSequence: positiveUint32(
      view.getUint32(12, false),
      "serverSequence"
    ),
    turnSequence: positiveUint32(view.getUint32(16, false), "turnSequence"),
    sequence: positiveUint32(view.getUint32(20, false), "sequence"),
    sentenceSequence: positiveUint32(
      view.getUint32(24, false),
      "sentenceSequence"
    ),
    itemOffsetSamples: view.getUint32(28, false),
    providerItemId,
    pcm16le
  };
}

function positiveUint32(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffff_ffff) {
    throw new RealtimeVoiceGatewayProtocolError(
      `${name} must be a positive uint32`
    );
  }
  return value;
}

function pcmBytes(value: Uint8Array) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new RealtimeVoiceGatewayProtocolError(
      "Realtime Voice PCM frame must not be empty"
    );
  }
  if (value.byteLength % 2 !== 0) {
    throw new RealtimeVoiceGatewayProtocolError(
      "Realtime Voice PCM frame must end on a 16-bit sample boundary"
    );
  }
  if (value.byteLength > MAX_AUDIO_FRAME_BYTES) {
    throw new RealtimeVoiceGatewayProtocolError(
      "Realtime Voice PCM frame exceeds the bounded frame size"
    );
  }
  return value;
}

export function encodeRealtimeVoiceGatewayAudioFrame(
  frame: RealtimeVoiceGatewayAudioFrame
) {
  const pcm16le = pcmBytes(frame.pcm16le);
  const normalizedProviderItemId = frame.kind === "output_pcm"
    ? frame.providerItemId?.trim()
    : undefined;
  if (
    frame.kind === "output_pcm" &&
    frame.providerItemId !== undefined &&
    !normalizedProviderItemId
  ) {
    throw new RealtimeVoiceGatewayProtocolError(
      "Realtime Voice Provider item ID must not be empty"
    );
  }
  const itemBytes = normalizedProviderItemId
    ? new TextEncoder().encode(normalizedProviderItemId)
    : new Uint8Array();
  if (itemBytes.byteLength > MAX_PROVIDER_ITEM_ID_BYTES) {
    throw new RealtimeVoiceGatewayProtocolError(
      "Realtime Voice Provider item ID is too large"
    );
  }
  const output = new Uint8Array(
    AUDIO_FRAME_HEADER_BYTES + itemBytes.byteLength + pcm16le.byteLength
  );
  const view = new DataView(output.buffer);
  view.setUint32(0, AUDIO_FRAME_MAGIC, false);
  view.setUint8(4, REALTIME_VOICE_GATEWAY_PROTOCOL_VERSION);
  view.setUint8(5, frame.kind === "input_pcm" ? 1 : 2);
  view.setUint16(6, itemBytes.byteLength, false);
  if (frame.kind === "output_pcm") {
    view.setUint32(8, positiveUint32(frame.turnSequence, "turnSequence"), false);
    view.setUint32(12, positiveUint32(frame.sequence, "sequence"), false);
    view.setUint32(
      16,
      positiveUint32(frame.sentenceSequence, "sentenceSequence"),
      false
    );
  }
  output.set(itemBytes, AUDIO_FRAME_HEADER_BYTES);
  output.set(pcm16le, AUDIO_FRAME_HEADER_BYTES + itemBytes.byteLength);
  return output;
}

export function decodeRealtimeVoiceGatewayAudioFrame(
  value: ArrayBuffer | Uint8Array
): RealtimeVoiceGatewayAudioFrame {
  const bytes = value instanceof Uint8Array
    ? value
    : new Uint8Array(value);
  if (bytes.byteLength < AUDIO_FRAME_HEADER_BYTES) {
    throw new RealtimeVoiceGatewayProtocolError(
      "Realtime Voice audio frame is truncated"
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(0, false) !== AUDIO_FRAME_MAGIC ||
    view.getUint8(4) !== REALTIME_VOICE_GATEWAY_PROTOCOL_VERSION
  ) {
    throw new RealtimeVoiceGatewayProtocolError(
      "Realtime Voice audio frame header is invalid"
    );
  }
  const kind = view.getUint8(5);
  const itemLength = view.getUint16(6, false);
  const pcmOffset = AUDIO_FRAME_HEADER_BYTES + itemLength;
  if (pcmOffset >= bytes.byteLength) {
    throw new RealtimeVoiceGatewayProtocolError(
      "Realtime Voice audio frame has no PCM payload"
    );
  }
  const pcm16le = pcmBytes(bytes.slice(pcmOffset));
  if (kind === 1) {
    if (itemLength !== 0) {
      throw new RealtimeVoiceGatewayProtocolError(
        "Realtime Voice input PCM must not contain an item ID"
      );
    }
    return { kind: "input_pcm", pcm16le };
  }
  if (kind !== 2) {
    throw new RealtimeVoiceGatewayProtocolError(
      "Realtime Voice audio frame kind is unsupported"
    );
  }
  const itemBytes = bytes.slice(AUDIO_FRAME_HEADER_BYTES, pcmOffset);
  const providerItemId = itemBytes.byteLength > 0
    ? new TextDecoder("utf-8", { fatal: true }).decode(itemBytes).trim()
    : undefined;
  return {
    kind: "output_pcm",
    turnSequence: positiveUint32(view.getUint32(8, false), "turnSequence"),
    sequence: positiveUint32(view.getUint32(12, false), "sequence"),
    sentenceSequence: positiveUint32(
      view.getUint32(16, false),
      "sentenceSequence"
    ),
    ...(providerItemId ? { providerItemId } : {}),
    pcm16le
  };
}
