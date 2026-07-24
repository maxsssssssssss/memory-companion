import { describe, expect, it, vi } from "vitest";

import type { QaExecutionDiagnostics } from "@/lib/server/retrieval/qa-observability";

import {
  buildVoiceQaLatencyBreakdown,
  logVoiceQaBenchmark,
  voiceQaBenchmarkPayload
} from "./qa-benchmark";

const diagnostics: QaExecutionDiagnostics = {
  answerMode: "direct",
  memoryRetrievalMs: 4,
  relationshipContextBuildingMs: 2,
  rerankingMs: 6,
  promptConstructionMs: 3,
  llmGenerationMs: 40,
  responseValidationMs: 1,
  totalMs: 56,
  promptCharacters: 1_200,
  responseCharacters: 90,
  evidenceCount: 8,
  providerCallCount: 1,
  fallbackReason: "none"
};

describe("Voice QA benchmark observability", () => {
  it("calculates comparison fields without logging private content", () => {
    const payload = voiceQaBenchmarkPayload({
      sessionId: "session-1",
      answerMode: "agent",
      diagnostics,
      responseOptimizationMs: 2,
      totalLatencyMs: 58,
      responseLength: 72
    });

    expect(payload).toMatchObject({
      answer_mode: "direct",
      retrieval_ms: 12,
      reasoning_ms: 4,
      generation_ms: 40,
      total_latency_ms: 58,
      response_length: 72
    });
    expect(JSON.stringify(payload)).not.toContain("private memory");
  });

  it("keeps missing timing fields explicit instead of inventing stage durations", () => {
    const input = {
      sessionId: "session-2",
      answerMode: "agent" as const,
      responseOptimizationMs: null,
      totalLatencyMs: null,
      responseLength: 0
    };

    expect(voiceQaBenchmarkPayload(input)).toMatchObject({
      answer_mode: "agent",
      retrieval_ms: null,
      reasoning_ms: null,
      generation_ms: null,
      total_latency_ms: null,
      fallback_reason: "diagnostics_unavailable"
    });
    expect(buildVoiceQaLatencyBreakdown(input)).toMatchObject({
      answerMode: "agent",
      memoryRetrievalMs: null,
      totalMs: null,
      evidenceCount: null,
      providerCallCount: null,
      responseOptimizationMs: null,
      endToEndQaMs: null
    });
  });

  it("does not report a partial aggregate as a complete stage duration", () => {
    const payload = voiceQaBenchmarkPayload({
      sessionId: "session-partial",
      answerMode: "agent",
      diagnostics: {
        ...diagnostics,
        memoryRetrievalMs: null,
        responseValidationMs: null
      },
      responseOptimizationMs: null,
      totalLatencyMs: 58,
      responseLength: 72
    });

    expect(payload.retrieval_ms).toBeNull();
    expect(payload.reasoning_ms).toBeNull();
  });

  it("emits one bounded structured log line", () => {
    const info = vi.fn();
    logVoiceQaBenchmark({
      sessionId: "session-3",
      answerMode: "agent",
      diagnostics,
      responseOptimizationMs: 1,
      totalLatencyMs: 57,
      responseLength: 80
    }, { info });

    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]?.[0]).toMatch(/^VOICE_QA_BENCHMARK: \{/u);
  });
});
