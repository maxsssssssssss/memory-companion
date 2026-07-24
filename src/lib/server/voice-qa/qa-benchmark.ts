import type {
  QaAnswerMode,
  QaExecutionDiagnostics
} from "@/lib/server/retrieval/qa-observability";

import type { VoiceQaLatencyBreakdown } from "./trace";

function sumComplete(...values: Array<number | null | undefined>) {
  if (values.some((value) => value === null || value === undefined)) return null;
  return (values as number[]).reduce((sum, value) => sum + value, 0);
}

export type VoiceQaBenchmarkInput = {
  sessionId: string;
  answerMode: QaAnswerMode;
  diagnostics?: QaExecutionDiagnostics;
  responseOptimizationMs: number | null;
  totalLatencyMs: number | null;
  responseLength: number;
};

export function buildVoiceQaLatencyBreakdown(
  input: VoiceQaBenchmarkInput
): VoiceQaLatencyBreakdown {
  const diagnostics = input.diagnostics;
  return {
    answerMode: diagnostics?.answerMode ?? input.answerMode,
    memoryRetrievalMs: diagnostics?.memoryRetrievalMs ?? null,
    relationshipContextBuildingMs: diagnostics?.relationshipContextBuildingMs ?? null,
    rerankingMs: diagnostics?.rerankingMs ?? null,
    promptConstructionMs: diagnostics?.promptConstructionMs ?? null,
    llmGenerationMs: diagnostics?.llmGenerationMs ?? null,
    responseValidationMs: diagnostics?.responseValidationMs ?? null,
    totalMs: diagnostics?.totalMs ?? input.totalLatencyMs ?? null,
    promptCharacters: diagnostics?.promptCharacters ?? null,
    responseCharacters: diagnostics?.responseCharacters ?? null,
    evidenceCount: diagnostics?.evidenceCount ?? null,
    providerCallCount: diagnostics?.providerCallCount ?? null,
    fallbackReason: diagnostics?.fallbackReason ?? "diagnostics_unavailable",
    responseOptimizationMs: input.responseOptimizationMs,
    endToEndQaMs: input.totalLatencyMs
  };
}

export function voiceQaBenchmarkPayload(input: VoiceQaBenchmarkInput) {
  const diagnostics = input.diagnostics;
  const retrievalMs = diagnostics
    ? sumComplete(
      diagnostics.memoryRetrievalMs,
      diagnostics.relationshipContextBuildingMs,
      diagnostics.rerankingMs
    )
    : null;
  const reasoningMs = diagnostics
    ? sumComplete(diagnostics.promptConstructionMs, diagnostics.responseValidationMs)
    : null;

  return {
    session_id: input.sessionId,
    answer_mode: diagnostics?.answerMode ?? input.answerMode,
    retrieval_ms: retrievalMs,
    memory_retrieval_ms: diagnostics?.memoryRetrievalMs ?? null,
    relationship_context_ms: diagnostics?.relationshipContextBuildingMs ?? null,
    reranking_ms: diagnostics?.rerankingMs ?? null,
    prompt_construction_ms: diagnostics?.promptConstructionMs ?? null,
    reasoning_ms: reasoningMs,
    generation_ms: diagnostics?.llmGenerationMs ?? null,
    response_validation_ms: diagnostics?.responseValidationMs ?? null,
    response_optimization_ms: input.responseOptimizationMs,
    total_latency_ms: input.totalLatencyMs,
    response_length: input.responseLength,
    evidence_count: diagnostics?.evidenceCount ?? null,
    prompt_chars: diagnostics?.promptCharacters ?? null,
    model_call_count: diagnostics?.providerCallCount ?? null,
    fallback_reason: diagnostics?.fallbackReason ?? "diagnostics_unavailable"
  };
}

export function logVoiceQaBenchmark(
  input: VoiceQaBenchmarkInput,
  logger: Pick<Console, "info"> = console
) {
  logger.info(`VOICE_QA_BENCHMARK: ${JSON.stringify(voiceQaBenchmarkPayload(input))}`);
}
