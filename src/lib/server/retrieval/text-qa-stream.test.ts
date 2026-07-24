import { describe, expect, it, vi } from "vitest";

import type { QuestionAnswer } from "@/lib/domain/types";
import { parseQaBrowserNdjsonStream } from "@/lib/client/qa-ndjson-stream";
import type { QaAnswerStreamEvent, QaStreamingTrace } from "@/lib/server/retrieval/qa-streaming";
import {
  acceptsQaBrowserStream,
  createTextQaBrowserStream,
  textQaNdjsonResponse
} from "./text-qa-stream";

const answer: QuestionAnswer = {
  id: "answer_1",
  uploadId: "upload_1",
  question: "后来怎么样？",
  answer: "后来已经确认了。[E1]",
  citedSegmentIds: ["segment_1"],
  citations: [
    {
      id: "E1",
      title: "确认",
      startSeconds: 10,
      endSeconds: 12,
      excerpt: "已经确认了",
      sourceSegmentIds: ["segment_1"]
    }
  ],
  createdAt: "2026-07-23T09:00:00.000Z"
};

const trace: QaStreamingTrace = {
  version: 1,
  streamId: "123e4567-e89b-42d3-a456-426614174000",
  status: "completed",
  timestamps: {
    stream_started: "2026-07-23T09:00:00.000Z",
    provider_request_started: null,
    first_token_received: null,
    first_sentence_candidate: null,
    first_sentence_validated: null,
    first_sentence_completed: null,
    provider_stream_ended: null,
    stream_completed: "2026-07-23T09:00:01.000Z"
  },
  latencies: {
    firstTokenMs: null,
    firstSentenceCandidateMs: null,
    firstSentenceValidatedMs: null,
    firstSentenceMs: null,
    totalStreamMs: null,
    totalOperationMs: 1000
  },
  tokenChunkCount: 1,
  sentenceCount: 1,
  providerCallCount: 1,
  fallbackReason: null
};

function streamInput() {
  return {
    uploadId: "upload_1",
    question: "后来怎么样？",
    segments: [],
    semanticSegments: [],
    briefItems: []
  };
}

async function eventsFrom(stream: ReadableStream<Uint8Array>) {
  const response = textQaNdjsonResponse(stream);
  if (!response.body) throw new Error("expected streamed response body");
  const events = [];
  for await (const event of parseQaBrowserNdjsonStream(response.body)) {
    events.push(event);
  }
  return events;
}

async function* successfulEvents(): AsyncGenerator<QaAnswerStreamEvent> {
  yield {
    type: "stream_started",
    streamId: trace.streamId,
    timestamp: trace.timestamps.stream_started
  };
  yield {
    type: "token",
    sequence: 1,
    quarantinedText: "private raw provider content",
    safeForSpeech: false,
    safeForPersistence: false,
    validated: false
  };
  yield {
    type: "sentence_completed",
    // Core sequence can contain gaps when earlier provisional units were withheld.
    sequence: 7,
    sentence: "后来已经确认了。",
    text: "后来已经确认了。",
    citationIds: ["E1"],
    supportIds: ["segment_1"],
    citedSegmentIds: ["segment_1"],
    groundingValidated: true,
    safeForSpeech: false,
    safeForPersistence: false,
    requiresResponseOptimization: true,
    validated: true,
    status: "committed",
    reason: "grounded"
  };
  yield { type: "final", answer, source: "provider_stream", trace };
}

describe("text QA browser stream", () => {
  it("recognizes only enabled NDJSON accept headers", () => {
    expect(
      acceptsQaBrowserStream(
        new Request("http://localhost/qa", {
          headers: { accept: "application/json, application/x-ndjson" }
        })
      )
    ).toBe(true);
    expect(
      acceptsQaBrowserStream(
        new Request("http://localhost/qa", {
          headers: { accept: "application/x-ndjson; q=0" }
        })
      )
    ).toBe(false);
    expect(acceptsQaBrowserStream(new Request("http://localhost/qa"))).toBe(false);
  });

  it("exposes grounded sentences and the canonical final answer without raw tokens", async () => {
    const onFinal = vi.fn();
    const stream = createTextQaBrowserStream({
      input: streamInput(),
      onFinal,
      dependencies: {
        answerQuestionStream: (() => successfulEvents()) as never
      }
    });

    const events = await eventsFrom(stream);

    expect(events.map((event) => event.type)).toEqual([
      "meta",
      "sentence",
      "final",
      "complete"
    ]);
    expect(JSON.stringify(events)).not.toContain("private raw provider content");
    expect(events[1]).toMatchObject({
      type: "sentence",
      sequence: 1,
      text: "后来已经确认了。",
      supportIds: ["segment_1"],
      citedSegmentIds: ["segment_1"],
      groundingValidated: true
    });
    expect(events[2]).toMatchObject({ type: "final", answer });
    expect(onFinal).toHaveBeenCalledTimes(1);
  });

  it("does not publish the final answer when final-only persistence fails", async () => {
    const stream = createTextQaBrowserStream({
      input: streamInput(),
      onFinal: async () => {
        throw new Error("write failed");
      },
      dependencies: {
        answerQuestionStream: (() => successfulEvents()) as never
      }
    });

    const events = await eventsFrom(stream);

    expect(events.some((event) => event.type === "final")).toBe(false);
    expect(events.slice(-2)).toEqual([
      { type: "error", code: "qa_stream_failed", recoverable: true },
      { type: "complete", status: "failed" }
    ]);
  });

  it("reports an empty provider iterator as an incomplete recoverable stream", async () => {
    async function* empty(): AsyncGenerator<QaAnswerStreamEvent> {
      return;
    }
    const stream = createTextQaBrowserStream({
      input: streamInput(),
      dependencies: {
        answerQuestionStream: (() => empty()) as never
      }
    });

    const events = await eventsFrom(stream);
    expect(events.map((event) => event.type)).toEqual(["meta", "error", "complete"]);
    expect(events.slice(1)).toEqual([
      { type: "error", code: "qa_stream_incomplete", recoverable: true },
      { type: "complete", status: "failed" }
    ]);
  });
});
