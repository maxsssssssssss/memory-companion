import { gzipSync, gunzipSync } from "node:zlib";

export const MAX_VOICE_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_VOICE_SESSION_ID_BYTES = 1_024;

const PROTOCOL_VERSION = 1;
const FIXED_HEADER_BYTES = 4;
const CARRY_EVENT_ID = 0x04;
const FULL_CLIENT_REQUEST = 0x01;
const AUDIO_ONLY_REQUEST = 0x02;
const FULL_SERVER_RESPONSE = 0x09;
const AUDIO_ONLY_RESPONSE = 0x0b;
const ERROR_INFORMATION = 0x0f;
const SERIALIZATION_RAW = 0x00;
const SERIALIZATION_JSON = 0x01;
const COMPRESSION_NONE = 0x00;
const COMPRESSION_GZIP = 0x01;

export enum VoiceEvent {
  StartConnection = 1,
  FinishConnection = 2,
  ConnectionStarted = 50,
  ConnectionFailed = 51,
  ConnectionFinished = 52,
  StartSession = 100,
  FinishSession = 102,
  SessionStarted = 150,
  SessionFinished = 152,
  SessionFailed = 153,
  TaskRequest = 200,
  EndASR = 400,
  TTSSentenceStart = 350,
  TTSSentenceEnd = 351,
  TTSResponse = 352,
  TTSEnded = 359,
  ASRInfo = 450,
  ASRResponse = 451,
  ASREnded = 459,
  ChatTTSText = 500,
  ChatResponse = 550,
  ChatEnded = 559,
  DialogCommonError = 599,
  Error = 599
}

const EVENT_NAMES = new Map<number, string>([
  [VoiceEvent.StartConnection, "StartConnection"],
  [VoiceEvent.FinishConnection, "FinishConnection"],
  [VoiceEvent.ConnectionStarted, "ConnectionStarted"],
  [VoiceEvent.ConnectionFailed, "ConnectionFailed"],
  [VoiceEvent.ConnectionFinished, "ConnectionFinished"],
  [VoiceEvent.StartSession, "StartSession"],
  [VoiceEvent.FinishSession, "FinishSession"],
  [VoiceEvent.SessionStarted, "SessionStarted"],
  [VoiceEvent.SessionFinished, "SessionFinished"],
  [VoiceEvent.SessionFailed, "SessionFailed"],
  [VoiceEvent.TaskRequest, "TaskRequest"],
  [VoiceEvent.EndASR, "EndASR"],
  [VoiceEvent.TTSSentenceStart, "TTSSentenceStart"],
  [VoiceEvent.TTSSentenceEnd, "TTSSentenceEnd"],
  [VoiceEvent.TTSResponse, "TTSResponse"],
  [VoiceEvent.TTSEnded, "TTSEnded"],
  [VoiceEvent.ASRInfo, "ASRInfo"],
  [VoiceEvent.ASRResponse, "ASRResponse"],
  [VoiceEvent.ASREnded, "ASREnded"],
  [VoiceEvent.ChatTTSText, "ChatTTSText"],
  [VoiceEvent.ChatResponse, "ChatResponse"],
  [VoiceEvent.ChatEnded, "ChatEnded"],
  [VoiceEvent.DialogCommonError, "DialogCommonError"]
]);

const CLIENT_EVENTS = new Set<number>([
  VoiceEvent.StartConnection,
  VoiceEvent.FinishConnection,
  VoiceEvent.StartSession,
  VoiceEvent.FinishSession,
  VoiceEvent.TaskRequest,
  VoiceEvent.EndASR,
  VoiceEvent.ChatTTSText
]);

export type VoiceSerialization = "json" | "none" | "unknown";

export type ParsedVoiceServerEvent = {
  eventId: number;
  eventName: string;
  sessionId?: string;
  connectionId?: string;
  payload?: unknown;
  audio?: Buffer;
  errorCode?: number;
  rawPayload: Buffer;
  compressed: boolean;
  serialization: VoiceSerialization;
  unknown: boolean;
  messageType?: number;
  /** Local adapter failure classification; never populated from provider text. */
  internalFailureReason?: "connection_failed" | "connection_closed" | "protocol_error";
};

export type EncodeVoiceEventOptions = {
  sessionId?: string;
  gzip?: boolean;
};

export class VoiceProtocolError extends Error {
  readonly code = "voice_protocol_error";

  constructor(message: string) {
    super(message);
    this.name = "VoiceProtocolError";
  }
}

function assertClientEvent(eventId: number) {
  if (!Number.isSafeInteger(eventId) || eventId < 1 || eventId > 0x7fffffff) {
    throw new VoiceProtocolError("Voice event ID must be a positive int32");
  }
  if (!CLIENT_EVENTS.has(eventId)) {
    throw new VoiceProtocolError(`Voice event ${eventId} is not a supported client event`);
  }
}

function sessionBytesFor(eventId: number, sessionId: string | undefined) {
  const connectionEvent = eventId === VoiceEvent.StartConnection || eventId === VoiceEvent.FinishConnection;
  if (connectionEvent) {
    if (sessionId !== undefined) {
      throw new VoiceProtocolError("Connection events must not carry a session ID");
    }
    return undefined;
  }
  if (!sessionId?.trim()) {
    throw new VoiceProtocolError(`Voice event ${eventId} requires a session ID`);
  }
  const bytes = Buffer.from(sessionId, "utf8");
  if (bytes.byteLength > MAX_VOICE_SESSION_ID_BYTES) {
    throw new VoiceProtocolError("Voice session ID is too large");
  }
  return bytes;
}

function uint32(value: number) {
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32BE(value, 0);
  return result;
}

function int32(value: number) {
  const result = Buffer.allocUnsafe(4);
  result.writeInt32BE(value, 0);
  return result;
}

function encodeEvent(
  messageType: number,
  serialization: number,
  eventId: number,
  inputPayload: Buffer,
  options: EncodeVoiceEventOptions
) {
  assertClientEvent(eventId);
  const session = sessionBytesFor(eventId, options.sessionId);
  if (inputPayload.byteLength > MAX_VOICE_FRAME_BYTES) {
    throw new VoiceProtocolError("Voice event payload is too large");
  }
  const payload = options.gzip ? gzipSync(inputPayload) : inputPayload;
  if (payload.byteLength > MAX_VOICE_FRAME_BYTES) {
    throw new VoiceProtocolError("Voice event payload is too large");
  }
  const frame = Buffer.concat([
    Buffer.from([
      (PROTOCOL_VERSION << 4) | 1,
      (messageType << 4) | CARRY_EVENT_ID,
      (serialization << 4) | (options.gzip ? COMPRESSION_GZIP : COMPRESSION_NONE),
      0
    ]),
    int32(eventId),
    ...(session ? [uint32(session.byteLength), session] : []),
    uint32(payload.byteLength),
    payload
  ]);
  if (frame.byteLength > MAX_VOICE_FRAME_BYTES) {
    throw new VoiceProtocolError("Voice event frame is too large");
  }
  return frame;
}

export function encodeJsonEvent(
  eventId: number,
  payload: unknown,
  options: EncodeVoiceEventOptions = {}
) {
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch {
    throw new VoiceProtocolError("Voice JSON payload is not serializable");
  }
  if (json === undefined) {
    throw new VoiceProtocolError("Voice JSON payload is not serializable");
  }
  return encodeEvent(
    FULL_CLIENT_REQUEST,
    SERIALIZATION_JSON,
    eventId,
    Buffer.from(json, "utf8"),
    options
  );
}

export function encodeAudioEvent(
  eventId: number,
  audio: Buffer | Uint8Array,
  options: EncodeVoiceEventOptions = {}
) {
  if (!(audio instanceof Uint8Array) || audio.byteLength === 0) {
    throw new VoiceProtocolError("Voice audio payload must not be empty");
  }
  return encodeEvent(
    AUDIO_ONLY_REQUEST,
    SERIALIZATION_RAW,
    eventId,
    Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength),
    options
  );
}

class FrameReader {
  offset: number;

  constructor(readonly frame: Buffer, offset = 0) {
    this.offset = offset;
  }

  remaining() {
    return this.frame.byteLength - this.offset;
  }

  readInt32(label: string) {
    this.require(4, label);
    const value = this.frame.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  readUInt32(label: string) {
    this.require(4, label);
    const value = this.frame.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  readBytes(length: number, label: string) {
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_VOICE_FRAME_BYTES) {
      throw new VoiceProtocolError(`Invalid ${label} length`);
    }
    this.require(length, label);
    const value = this.frame.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  private require(length: number, label: string) {
    if (length > this.remaining()) {
      throw new VoiceProtocolError(`Truncated voice frame while reading ${label}`);
    }
  }
}

function decodeUtf8(bytes: Buffer, label: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new VoiceProtocolError(`Invalid UTF-8 in voice ${label}`);
  }
}

function tryReadScopedPayload(reader: FrameReader) {
  const originalOffset = reader.offset;
  if (reader.remaining() < 8) return undefined;
  try {
    const idLength = reader.readUInt32("scope ID length");
    if (idLength === 0 || idLength > MAX_VOICE_SESSION_ID_BYTES || reader.remaining() < idLength + 4) {
      reader.offset = originalOffset;
      return undefined;
    }
    const id = decodeUtf8(reader.readBytes(idLength, "scope ID"), "scope ID");
    const payloadLength = reader.readUInt32("payload length");
    if (payloadLength !== reader.remaining()) {
      reader.offset = originalOffset;
      return undefined;
    }
    return { id, payload: reader.readBytes(payloadLength, "payload") };
  } catch {
    reader.offset = originalOffset;
    return undefined;
  }
}

function readPayload(reader: FrameReader) {
  const payloadLength = reader.readUInt32("payload length");
  if (payloadLength !== reader.remaining()) {
    throw new VoiceProtocolError("Voice frame payload length does not match frame size");
  }
  return reader.readBytes(payloadLength, "payload");
}

function decompressPayload(payload: Buffer, compression: number) {
  if (compression === COMPRESSION_NONE) return { payload, compressed: false };
  if (compression !== COMPRESSION_GZIP) {
    throw new VoiceProtocolError(`Unsupported voice compression method ${compression}`);
  }
  try {
    return {
      payload: gunzipSync(payload, { maxOutputLength: MAX_VOICE_FRAME_BYTES }),
      compressed: true
    };
  } catch {
    throw new VoiceProtocolError("Invalid or oversized gzip voice payload");
  }
}

function parsePayload(payload: Buffer, serializationCode: number) {
  if (serializationCode === SERIALIZATION_RAW) {
    return { serialization: "none" as const, payload: undefined };
  }
  if (serializationCode !== SERIALIZATION_JSON) {
    return { serialization: "unknown" as const, payload: undefined };
  }
  try {
    return {
      serialization: "json" as const,
      payload: JSON.parse(decodeUtf8(payload, "JSON payload")) as unknown
    };
  } catch (error) {
    if (error instanceof VoiceProtocolError) throw error;
    throw new VoiceProtocolError("Invalid JSON in voice provider response");
  }
}

function bufferFrom(input: Buffer | ArrayBuffer | Uint8Array) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

export function parseServerEvent(input: Buffer | ArrayBuffer | Uint8Array): ParsedVoiceServerEvent {
  const frame = bufferFrom(input);
  if (frame.byteLength < FIXED_HEADER_BYTES || frame.byteLength > MAX_VOICE_FRAME_BYTES) {
    throw new VoiceProtocolError("Voice frame size is outside the allowed range");
  }
  const version = frame[0] >> 4;
  const headerBytes = (frame[0] & 0x0f) * 4;
  if (version !== PROTOCOL_VERSION) {
    throw new VoiceProtocolError(`Unsupported voice protocol version ${version}`);
  }
  if (headerBytes < FIXED_HEADER_BYTES || headerBytes > frame.byteLength) {
    throw new VoiceProtocolError("Invalid voice protocol header size");
  }
  const messageType = frame[1] >> 4;
  const flags = frame[1] & 0x0f;
  const serializationCode = frame[2] >> 4;
  const compression = frame[2] & 0x0f;
  if (![FULL_SERVER_RESPONSE, AUDIO_ONLY_RESPONSE, ERROR_INFORMATION].includes(messageType)) {
    throw new VoiceProtocolError(`Unexpected server voice message type ${messageType}`);
  }

  const reader = new FrameReader(frame, headerBytes);
  let eventId: number;
  let errorCode: number | undefined;
  let sessionId: string | undefined;
  let connectionId: string | undefined;
  let encodedPayload: Buffer;

  if (messageType === ERROR_INFORMATION && (flags & CARRY_EVENT_ID) === 0) {
    eventId = VoiceEvent.DialogCommonError;
    errorCode = reader.readInt32("error code");
    encodedPayload = readPayload(reader);
  } else {
    if ((flags & CARRY_EVENT_ID) === 0) {
      throw new VoiceProtocolError("Voice server event is missing its event ID flag");
    }
    eventId = reader.readInt32("event ID");
    const scoped = tryReadScopedPayload(reader);
    if (scoped) {
      encodedPayload = scoped.payload;
      if ([VoiceEvent.ConnectionStarted, VoiceEvent.ConnectionFailed, VoiceEvent.ConnectionFinished].includes(eventId)) {
        connectionId = scoped.id;
      } else {
        sessionId = scoped.id;
      }
    } else {
      encodedPayload = readPayload(reader);
    }
  }

  const decompressed = decompressPayload(encodedPayload, compression);
  const parsed = parsePayload(decompressed.payload, serializationCode);
  const known = EVENT_NAMES.has(eventId);
  return {
    eventId,
    eventName: EVENT_NAMES.get(eventId) ?? `Unknown(${eventId})`,
    ...(sessionId ? { sessionId } : {}),
    ...(connectionId ? { connectionId } : {}),
    ...(parsed.payload !== undefined ? { payload: parsed.payload } : {}),
    ...(messageType === AUDIO_ONLY_RESPONSE || eventId === VoiceEvent.TTSResponse
      ? { audio: Buffer.from(decompressed.payload) }
      : {}),
    ...(errorCode === undefined ? {} : { errorCode }),
    rawPayload: Buffer.from(decompressed.payload),
    compressed: decompressed.compressed,
    serialization: parsed.serialization,
    unknown: !known,
    messageType
  };
}
