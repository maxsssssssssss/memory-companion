import { describe, expect, it } from "vitest";

import {
  VoiceBrowserStreamProtocolError,
  parseVoiceBrowserNdjsonStream
} from "./voice-ndjson-stream";

function streamOf(chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
}

describe("parseVoiceBrowserNdjsonStream", () => {
  it("parses split NDJSON frames in order", async () => {
    const events = [];
    for await (const event of parseVoiceBrowserNdjsonStream(streamOf([
      '{"type":"meta","version":1,"conversationSessionId":"conversation_1",',
      '"traceId":"11111111-1111-4111-8111-111111111111","audio":{"format":"pcm_s16le","sampleRate":24000,"channels":1}}\n',
      '{"type":"audio_chunk","sequence":1,"sentenceSequence":1,"chunkSequence":1,"audioBase64":"AQI="}\n',
      '{"type":"complete","status":"completed","errors":[]}\n'
    ]))) events.push(event);

    expect(events.map((event) => event.type)).toEqual(["meta", "audio_chunk", "complete"]);
  });

  it("rejects malformed and incomplete frames", async () => {
    const malformed = async () => {
      for await (const _event of parseVoiceBrowserNdjsonStream(streamOf([
        '{"type":"audio_chunk","sequence":0}\n'
      ]))) {
        // Consume the stream.
      }
    };
    await expect(malformed()).rejects.toBeInstanceOf(VoiceBrowserStreamProtocolError);

    const incomplete = async () => {
      for await (const _event of parseVoiceBrowserNdjsonStream(streamOf([
        '{"type":"complete"'
      ]))) {
        // Consume the stream.
      }
    };
    await expect(incomplete()).rejects.toBeInstanceOf(VoiceBrowserStreamProtocolError);
  });

  it("cancels the transport after a protocol failure", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"audio_chunk","sequence":0}\n'));
      },
      cancel() {
        cancelled = true;
      }
    });

    const consume = async () => {
      for await (const _event of parseVoiceBrowserNdjsonStream(stream)) {
        // Consume the stream.
      }
    };

    await expect(consume()).rejects.toBeInstanceOf(VoiceBrowserStreamProtocolError);
    expect(cancelled).toBe(true);
  });

  it("rejects a clean EOF without complete and any event after complete", async () => {
    const withoutComplete = async () => {
      for await (const _event of parseVoiceBrowserNdjsonStream(streamOf([
        '{"type":"meta","version":1,"conversationSessionId":"conversation_1",' +
          '"traceId":"11111111-1111-4111-8111-111111111111",' +
          '"audio":{"format":"pcm_s16le","sampleRate":24000,"channels":1}}\n'
      ]))) {
        // Consume the stream.
      }
    };
    await expect(withoutComplete()).rejects.toThrow(/without a terminal completion/u);

    const afterComplete = async () => {
      for await (const _event of parseVoiceBrowserNdjsonStream(streamOf([
        '{"type":"complete","status":"completed","errors":[]}\n',
        '{"type":"complete","status":"completed","errors":[]}\n'
      ]))) {
        // Consume the stream.
      }
    };
    await expect(afterComplete()).rejects.toThrow(/after its terminal completion/u);
  });
});
