import { describe, expect, it, vi } from "vitest";

import {
  createQaStreamingTraceRecorder,
  notifyQaStreamingTrace,
  splitValidatedQaSentences
} from "./qa-streaming";

function clock(values: number[]) {
  let index = 0;
  return {
    now: () => values[index++] ?? values.at(-1) ?? 0,
    isoNow: () => new Date(1_700_000_000_000 + index * 100).toISOString()
  };
}

describe("QA streaming trace", () => {
  it("records first-token, first-sentence, and completion timing in order", () => {
    const recorder = createQaStreamingTraceRecorder({
      streamId: "11111111-1111-4111-8111-111111111111",
      clock: clock([10, 20, 30, 40, 50, 60, 70, 80])
    });

    recorder.markProviderStarted();
    recorder.markFirstToken();
    recorder.markFirstToken();
    recorder.markFirstSentenceCandidate();
    recorder.markFirstSentenceValidated();
    recorder.markFirstSentence();
    recorder.markProviderEnded();
    const trace = recorder.complete({
      status: "completed",
      tokenChunkCount: 4,
      sentenceCount: 2,
      providerCallCount: 1
    });

    expect(trace.latencies).toEqual({
      firstTokenMs: 10,
      firstSentenceCandidateMs: 30,
      firstSentenceValidatedMs: 40,
      firstSentenceMs: 50,
      totalStreamMs: 50,
      totalOperationMs: 70
    });
    expect(trace.timestamps.first_token_received).not.toBeNull();
    expect(trace.timestamps.first_sentence_candidate).not.toBeNull();
    expect(trace.timestamps.first_sentence_validated).not.toBeNull();
    expect(trace.timestamps.first_sentence_completed).not.toBeNull();
  });

  it("uses explicit null timing when an empty stream has no token or sentence", () => {
    const recorder = createQaStreamingTraceRecorder({
      streamId: "22222222-2222-4222-8222-222222222222",
      clock: clock([10, 35])
    });
    const trace = recorder.complete({
      status: "completed_with_fallback",
      tokenChunkCount: 0,
      sentenceCount: 1,
      providerCallCount: 1,
      fallbackReason: "empty_stream"
    });

    expect(trace.latencies).toEqual({
      firstTokenMs: null,
      firstSentenceCandidateMs: null,
      firstSentenceValidatedMs: null,
      firstSentenceMs: null,
      totalStreamMs: null,
      totalOperationMs: 25
    });
  });

  it("splits only validated text and keeps immediate citations with their sentence", () => {
    expect(splitValidatedQaSentences("先确认了时间。[E1] 后来完成预约！[E2]\n仍有一项未知"))
      .toEqual(["先确认了时间。[E1]", "后来完成预约！[E2]", "仍有一项未知"]);
  });

  it("logs only content-free metrics and isolates observer failures", async () => {
    const recorder = createQaStreamingTraceRecorder({
      streamId: "33333333-3333-4333-8333-333333333333",
      clock: clock([10, 20])
    });
    const trace = recorder.complete({
      status: "completed",
      tokenChunkCount: 1,
      sentenceCount: 1,
      providerCallCount: 1,
      sentenceCommit: {
        sentenceUnits: 2,
        committedUnits: 0,
        missingSentenceSupport: 1,
        citationMetadataMismatch: 0,
        responseNotFullyCommittable: 1
      }
    });
    const logger = { info: vi.fn(), warn: vi.fn() };
    const observer = vi.fn(async () => {
      throw new Error("private answer text");
    });

    notifyQaStreamingTrace(observer, trace, logger);
    await Promise.resolve();
    await Promise.resolve();

    const logged = logger.info.mock.calls.flat().join(" ") + logger.warn.mock.calls.flat().join(" ");
    expect(logged).toContain("QA_STREAM_TRACE");
    expect(logged).toContain('"sentence_units":2');
    expect(logged).toContain('"committed_units":0');
    expect(logged).toContain('"missing_sentence_support":1');
    expect(logged).toContain('"citation_metadata_mismatch":0');
    expect(logged).toContain('"response_not_fully_committable":1');
    expect(logged).not.toContain("private answer text");
  });

  it("uses null commit diagnostics when final sentence evaluation did not run", () => {
    const recorder = createQaStreamingTraceRecorder({
      streamId: "44444444-4444-4444-8444-444444444444",
      clock: clock([10, 20])
    });
    const trace = recorder.complete({
      status: "failed",
      tokenChunkCount: 0,
      sentenceCount: 0,
      providerCallCount: 1,
      fallbackReason: "provider_error"
    });
    const logger = { info: vi.fn(), warn: vi.fn() };

    notifyQaStreamingTrace(undefined, trace, logger);

    expect(trace.sentenceCommit).toBeUndefined();
    expect(logger.info.mock.calls.flat().join(" ")).toContain('"sentence_units":null');
  });
});
