import {
  VoiceBrowserStreamEventSchema,
  type VoiceBrowserStreamEvent
} from "@/lib/voice-browser-stream";

const MAX_NDJSON_LINE_CHARACTERS = 16 * 1024 * 1024;

export class VoiceBrowserStreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceBrowserStreamProtocolError";
  }
}

function parseLine(line: string): VoiceBrowserStreamEvent {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    throw new VoiceBrowserStreamProtocolError("Voice stream returned invalid JSON");
  }
  const parsed = VoiceBrowserStreamEventSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new VoiceBrowserStreamProtocolError("Voice stream returned an invalid event");
  }
  return parsed.data;
}

export async function* parseVoiceBrowserNdjsonStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<VoiceBrowserStreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let completed = false;
  let terminalEventSeen = false;
  const decodeEvent = (line: string) => {
    if (terminalEventSeen) {
      throw new VoiceBrowserStreamProtocolError(
        "Voice stream returned an event after its terminal completion"
      );
    }
    const event = parseLine(line);
    if (event.type === "complete") terminalEventSeen = true;
    return event;
  };
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      try {
        buffer += decoder.decode(result.value, { stream: true });
      } catch {
        throw new VoiceBrowserStreamProtocolError("Voice stream returned invalid UTF-8");
      }
      if (buffer.length > MAX_NDJSON_LINE_CHARACTERS) {
        throw new VoiceBrowserStreamProtocolError("Voice stream frame exceeded the size limit");
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield decodeEvent(line);
        newline = buffer.indexOf("\n");
      }
    }
    try {
      buffer += decoder.decode();
    } catch {
      throw new VoiceBrowserStreamProtocolError("Voice stream returned invalid UTF-8");
    }
    if (buffer.trim()) {
      throw new VoiceBrowserStreamProtocolError("Voice stream ended with an incomplete frame");
    }
    if (!terminalEventSeen) {
      throw new VoiceBrowserStreamProtocolError(
        "Voice stream ended without a terminal completion"
      );
    }
    completed = true;
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
