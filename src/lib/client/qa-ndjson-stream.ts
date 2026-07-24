import {
  QaBrowserStreamEventSchema,
  type QaBrowserStreamEvent
} from "@/lib/qa-browser-stream";

const MAX_NDJSON_LINE_CHARACTERS = 4 * 1024 * 1024;

export class QaBrowserStreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QaBrowserStreamProtocolError";
  }
}

function parseLine(line: string): QaBrowserStreamEvent {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    throw new QaBrowserStreamProtocolError("QA stream returned invalid JSON");
  }

  const parsed = QaBrowserStreamEventSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new QaBrowserStreamProtocolError("QA stream returned an invalid event");
  }
  return parsed.data;
}

export async function* parseQaBrowserNdjsonStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<QaBrowserStreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let transportCompleted = false;
  let protocolCompleted = false;
  let sawMeta = false;
  let sawFinal = false;
  let sawError = false;
  let expectedSentenceSequence = 1;

  const validateOrder = (event: QaBrowserStreamEvent) => {
    if (!sawMeta) {
      if (event.type !== "meta") {
        throw new QaBrowserStreamProtocolError("QA stream must begin with metadata");
      }
      sawMeta = true;
      return;
    }

    if (event.type === "meta") {
      throw new QaBrowserStreamProtocolError("QA stream returned duplicate metadata");
    }
    if (protocolCompleted) {
      throw new QaBrowserStreamProtocolError("QA stream returned an event after completion");
    }
    if (event.type === "sentence") {
      if (sawFinal || sawError || event.sequence !== expectedSentenceSequence) {
        throw new QaBrowserStreamProtocolError("QA stream returned an out-of-order sentence");
      }
      expectedSentenceSequence += 1;
      return;
    }
    if (event.type === "final") {
      if (sawFinal || sawError) {
        throw new QaBrowserStreamProtocolError("QA stream returned an invalid final answer");
      }
      sawFinal = true;
      return;
    }
    if (event.type === "error") {
      if (sawError || sawFinal) {
        throw new QaBrowserStreamProtocolError("QA stream returned an invalid error");
      }
      sawError = true;
      return;
    }

    if (event.status === "failed" ? !sawError : !sawFinal) {
      throw new QaBrowserStreamProtocolError("QA stream completion does not match its result");
    }
    protocolCompleted = true;
  };

  const consumeLine = (line: string) => {
    const event = parseLine(line);
    validateOrder(event);
    return event;
  };

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      try {
        buffer += decoder.decode(result.value, { stream: true });
      } catch {
        throw new QaBrowserStreamProtocolError("QA stream returned invalid UTF-8");
      }
      if (buffer.length > MAX_NDJSON_LINE_CHARACTERS) {
        throw new QaBrowserStreamProtocolError("QA stream frame exceeded the size limit");
      }

      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield consumeLine(line);
        newline = buffer.indexOf("\n");
      }
    }

    try {
      buffer += decoder.decode();
    } catch {
      throw new QaBrowserStreamProtocolError("QA stream returned invalid UTF-8");
    }
    if (buffer.trim()) {
      throw new QaBrowserStreamProtocolError("QA stream ended with an incomplete frame");
    }
    if (!protocolCompleted) {
      throw new QaBrowserStreamProtocolError("QA stream ended before completion");
    }
    transportCompleted = true;
  } finally {
    if (!transportCompleted) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
