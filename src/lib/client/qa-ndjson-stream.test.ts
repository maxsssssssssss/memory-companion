import { describe, expect, it } from "vitest";

import {
  QaBrowserStreamProtocolError,
  parseQaBrowserNdjsonStream
} from "./qa-ndjson-stream";

const meta = JSON.stringify({
  type: "meta",
  version: 1,
  streamId: "11111111-1111-4111-8111-111111111111"
});
const sentence = JSON.stringify({
  type: "sentence",
  sequence: 1,
  text: "今天确认了安排。",
  supportIds: ["segment_1"],
  citedSegmentIds: ["segment_1"],
  groundingValidated: true
});
const final = JSON.stringify({
  type: "final",
  answer: {
    id: "answer_1",
    uploadId: "upload_1",
    question: "今天发生了什么？",
    answer: "今天确认了安排。[E1]",
    citedSegmentIds: ["segment_1"],
    citations: [{
      id: "E1",
      title: "安排确认",
      startSeconds: 1,
      endSeconds: 2,
      excerpt: "已经确认",
      sourceSegmentIds: ["segment_1"]
    }],
    createdAt: "2026-07-23T00:00:00.000Z"
  },
  source: "provider_stream"
});

function streamOf(chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
}

async function collect(chunks: string[]) {
  const events = [];
  for await (const event of parseQaBrowserNdjsonStream(streamOf(chunks))) {
    events.push(event);
  }
  return events;
}

describe("parseQaBrowserNdjsonStream", () => {
  it("parses split grounded QA frames in order", async () => {
    const events = await collect([
      `${meta.slice(0, 30)}`,
      `${meta.slice(30)}\n${sentence}\n`,
      `${final}\n{"type":"complete","status":"completed"}\n`
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "meta",
      "sentence",
      "final",
      "complete"
    ]);
  });

  it("accepts an explicit failed stream without a final answer", async () => {
    const events = await collect([
      `${meta}\n`,
      '{"type":"error","code":"provider_failed","recoverable":true}\n',
      '{"type":"complete","status":"failed"}\n'
    ]);

    expect(events.map((event) => event.type)).toEqual(["meta", "error", "complete"]);
  });

  it("rejects raw tokens, ungrounded sentences, and skipped sequences", async () => {
    await expect(collect([
      `${meta}\n`,
      '{"type":"token","quarantinedText":"raw"}\n'
    ])).rejects.toBeInstanceOf(QaBrowserStreamProtocolError);

    await expect(collect([
      `${meta}\n`,
      '{"type":"sentence","sequence":1,"text":"未经验证。","supportIds":["segment_1"],"citedSegmentIds":["segment_1"],"groundingValidated":false}\n'
    ])).rejects.toBeInstanceOf(QaBrowserStreamProtocolError);

    await expect(collect([
      `${meta}\n`,
      '{"type":"sentence","sequence":2,"text":"顺序错误。","supportIds":["segment_1"],"citedSegmentIds":["segment_1"],"groundingValidated":true}\n'
    ])).rejects.toBeInstanceOf(QaBrowserStreamProtocolError);
  });

  it("rejects invalid lifecycle ordering and incomplete streams", async () => {
    await expect(collect([
      `${sentence}\n`
    ])).rejects.toBeInstanceOf(QaBrowserStreamProtocolError);

    await expect(collect([
      `${meta}\n${final}\n`
    ])).rejects.toBeInstanceOf(QaBrowserStreamProtocolError);

    await expect(collect([
      `${meta}\n${final}\n{"type":"complete","status":"completed"}\n${sentence}\n`
    ])).rejects.toBeInstanceOf(QaBrowserStreamProtocolError);
  });

  it("cancels the transport after a protocol failure", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${meta}\n{"type":"token"}\n`));
      },
      cancel() {
        cancelled = true;
      }
    });
    const consume = async () => {
      for await (const _event of parseQaBrowserNdjsonStream(stream)) {
        // Consume the stream.
      }
    };

    await expect(consume()).rejects.toBeInstanceOf(QaBrowserStreamProtocolError);
    expect(cancelled).toBe(true);
  });
});
