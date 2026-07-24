import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import type { QuestionAnswer } from "@/lib/domain/types";
import {
  answerQuestionStream,
  type AnswerQuestionStreamInput,
  type QaRetrievedEvidence
} from "@/lib/server/retrieval/ai-qa";
import {
  analyzeQaQueryIntent,
  assessQaLifecycleEvidence,
  type QaLifecycleEvidenceState
} from "@/lib/server/retrieval/lifecycle-retrieval";
import type { QaExecutionDiagnostics } from "@/lib/server/retrieval/qa-observability";
import type { QaStreamingTrace } from "@/lib/server/retrieval/qa-streaming";
import { getQaPromptPreference } from "@/lib/server/settings/provider-config";
import { JsonStore } from "@/lib/server/storage/json-store";
import { createMemoryVoiceQaAnswerer } from "@/lib/server/voice-qa/adapter";

import {
  loadLongRecording60mBenchmarkSource,
  stableDigest,
  type AnswerStrategyBenchmarkSource
} from "./answer-strategy-ab";

export const QA_PROVIDER_MODEL_BENCHMARK_VERSION = 1;
export const QA_PROVIDER_MODEL_SCHEDULE_VERSION = "seeded-counterbalanced-v1";

export const QaProviderModelAliasSchema = z.enum(["gpt-5.5", "ds-v4"]);
export type QaProviderModelAlias = z.infer<typeof QaProviderModelAliasSchema>;

const RequiredAnswerGroupSchema = z.array(z.string().trim().min(1).max(80)).min(1);

export const QaProviderModelQuestionSchema = z.object({
  id: z.string().regex(/^q\d{3}$/u),
  category: z.enum(["lifecycle", "unsupported", "summary"]),
  question: z.string().trim().min(2).max(300),
  expectedScope: z.literal("current"),
  evaluation: z.object({
    kind: z.enum(["lifecycle", "aggregate_lifecycle", "unsupported", "summary"]),
    expectedState: z.enum(["resolved", "pending", "partial_or_unknown", "not_applicable"]),
    requiredAnswerAnyOf: z.array(RequiredAnswerGroupSchema).max(8)
  }).strict()
}).strict();

export const QaProviderModelDatasetSchema = z.object({
  version: z.literal(1),
  datasetVersion: z.literal("long-recording-60m-v1"),
  questions: z.array(QaProviderModelQuestionSchema).min(5)
}).strict().superRefine((dataset, context) => {
  const ids = new Set(dataset.questions.map((question) => question.id));
  for (const requiredId of ["q017", "q018", "q022", "q034"]) {
    if (!ids.has(requiredId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Missing required provider model benchmark question: ${requiredId}`
      });
    }
  }
  if (!dataset.questions.some((question) => question.category === "summary")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provider model benchmark requires a summary question"
    });
  }
});

export type QaProviderModelQuestion = z.infer<typeof QaProviderModelQuestionSchema>;
export type QaProviderModelDataset = z.infer<typeof QaProviderModelDatasetSchema>;

export type QaProviderModelRuntime = {
  alias: QaProviderModelAlias;
  modelId: string;
  wireApi: "chat" | "responses";
  route: "configured_openai_compatible" | "configured_deepseek";
  sdkMaxRetries: number;
};

export type QaProviderModelScheduleEntry = {
  pairId: string;
  round: number;
  question: QaProviderModelQuestion;
  models: [QaProviderModelAlias, QaProviderModelAlias];
};

export type QaProviderModelExecution = {
  modelAlias: QaProviderModelAlias;
  modelId: string;
  wireApi: "chat" | "responses";
  route: QaProviderModelRuntime["route"];
  totalLatencyMs: number;
  answer: QuestionAnswer;
  diagnostics: QaExecutionDiagnostics | null;
  streamTrace: QaStreamingTrace | null;
  evidence: QaRetrievedEvidence[];
};

export type QaProviderModelQuality = {
  citation: {
    finalValid: boolean;
    inlineMetadataAligned: boolean;
    repairedByFallback: boolean;
  };
  lifecycle: {
    applicable: boolean;
    intentRecognized: boolean | null;
    expectedState: string;
    citedStates: QaLifecycleEvidenceState[];
    semanticChecksPassed: boolean | null;
    pass: boolean | null;
  };
  unsupported: {
    applicable: boolean;
    grounded: boolean | null;
    completionClaimAbsent: boolean | null;
    pass: boolean | null;
  };
  providerPath: "native_answer" | "grounded_unsupported" | "validation_fallback";
  finalQualityPass: boolean;
};

export type QaProviderModelBenchmarkRun = {
  run_id: string;
  pair_id: string;
  round: number;
  question_id: string;
  category: QaProviderModelQuestion["category"];
  model_alias: QaProviderModelAlias;
  model_id: string;
  wire_api: "chat" | "responses";
  route: QaProviderModelRuntime["route"];
  execution_order: 1 | 2;
  status: "completed" | "failed";
  ttft_ms: number | null;
  generation_latency_ms: number | null;
  total_latency_ms: number | null;
  response_length: number;
  prompt_characters: number | null;
  evidence_count: number | null;
  evidence_digest: string | null;
  citation_count: number;
  fallback_status: string;
  quality: QaProviderModelQuality | null;
  answer_text: string | null;
  cited_segment_ids: string[];
  error_name: string | null;
  error_code: string | null;
};

export type QaProviderModelAggregate = {
  runs: number;
  completed: number;
  failed: number;
  mean_ttft_ms: number | null;
  median_ttft_ms: number | null;
  p95_ttft_ms: number | null;
  mean_generation_latency_ms: number | null;
  median_generation_latency_ms: number | null;
  p95_generation_latency_ms: number | null;
  mean_total_latency_ms: number | null;
  median_total_latency_ms: number | null;
  p95_total_latency_ms: number | null;
  citation_valid_runs: number;
  lifecycle_correct_runs: number;
  lifecycle_applicable_runs: number;
  unsupported_correct_runs: number;
  unsupported_applicable_runs: number;
  native_answer_runs: number;
  fallback_runs: number;
};

export type QaProviderModelBenchmarkReport = {
  version: 1;
  generatedAt: string;
  execution: {
    remote: boolean;
    rounds: number;
    seed: string;
    serialized: true;
    scheduleVersion: string;
    scheduleDigest: string;
    totalRuns: number;
  };
  dataset: {
    datasetVersion: "long-recording-60m-v1";
    questionCount: number;
    questionIds: string[];
  };
  source: {
    contextDigest: string;
    memoryContextDigest: string;
    contextCounts: AnswerStrategyBenchmarkSource["contextCounts"];
  };
  models: Record<QaProviderModelAlias, QaProviderModelRuntime>;
  runs: QaProviderModelBenchmarkRun[];
  pairIntegrity: {
    totalPairs: number;
    validPairs: number;
    evidenceMismatchPairs: number;
    promptSizeMismatchPairs: number;
    incompletePairs: number;
  };
  aggregates: Record<QaProviderModelAlias, QaProviderModelAggregate>;
  limitations: string[];
};

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function seededUnit(seed: string) {
  const bytes = createHash("sha256").update(seed).digest();
  let state = bytes.readUInt32LE(0) || 0x9e3779b9;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffled<T>(values: readonly T[], seed: string) {
  const random = seededUnit(seed);
  const next = [...values];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex] as T, next[index] as T];
  }
  return next;
}

function baseFirstModel(seed: string, questionId: string): QaProviderModelAlias {
  return createHash("sha256")
    .update(`${seed}:${questionId}`)
    .digest()[0]! % 2 === 0
    ? "gpt-5.5"
    : "ds-v4";
}

export function createQaProviderModelSchedule(
  questions: QaProviderModelQuestion[],
  rounds: number,
  seed: string
): QaProviderModelScheduleEntry[] {
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) {
    throw new Error("QA Provider model benchmark rounds must be between 1 and 20");
  }
  if (!seed.trim()) throw new Error("QA Provider model benchmark seed is required");
  return Array.from({ length: rounds }, (_, index) => index + 1).flatMap((round) =>
    shuffled(questions, `${seed}:round:${round}`).map((question) => {
      const base = baseFirstModel(seed, question.id);
      const first = round % 2 === 0
        ? base === "gpt-5.5" ? "ds-v4" : "gpt-5.5"
        : base;
      const second = first === "gpt-5.5" ? "ds-v4" : "gpt-5.5";
      return {
        pairId: `r${String(round).padStart(2, "0")}-${question.id}`,
        round,
        question,
        models: [first, second]
      };
    })
  );
}

export async function loadQaProviderModelDataset(filePath: string) {
  return QaProviderModelDatasetSchema.parse(
    JSON.parse(await readFile(resolve(filePath), "utf8"))
  );
}

function errorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,80}$/u.test(code) ? code : null;
}

export function qaProviderModelEvidenceDigest(evidence: QaRetrievedEvidence[]) {
  return stableDigest(evidence.map((item) => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    text: item.text,
    startSeconds: item.startSeconds,
    endSeconds: item.endSeconds,
    sourceSegmentIds: item.sourceSegmentIds,
    priority: item.priority,
    relationshipSignal: item.relationshipSignal
  })));
}

function inlineCitationIds(answer: string) {
  return [...answer.matchAll(/\[(E\d+)\]/giu)].map((match) => match[1]!.toUpperCase());
}

function validateFinalCitations(answer: QuestionAnswer, evidence: QaRetrievedEvidence[]) {
  const allowedSources = new Set(evidence.flatMap((item) => item.sourceSegmentIds));
  const declaredCitations = answer.citations ?? [];
  const declaredIds = new Set(declaredCitations.map((citation) => citation.id.toUpperCase()));
  const finalValid =
    answer.citedSegmentIds.every((id) => allowedSources.has(id)) &&
    declaredCitations.every((citation) =>
      citation.sourceSegmentIds.length > 0 &&
      citation.sourceSegmentIds.every((id) => allowedSources.has(id))
    );
  const inlineMetadataAligned = inlineCitationIds(answer.answer)
    .every((id) => declaredIds.has(id));
  return { finalValid, inlineMetadataAligned };
}

function citedEvidenceFor(answer: QuestionAnswer, evidence: QaRetrievedEvidence[]) {
  const citedSources = new Set(answer.citedSegmentIds);
  return evidence.filter((item) => item.sourceSegmentIds.some((id) => citedSources.has(id)));
}

function answerGroupsPass(answer: string, groups: string[][]) {
  const normalized = answer.normalize("NFKC");
  return groups.every((group) => group.some((value) => normalized.includes(value)));
}

function lifecycleStates(
  question: QaProviderModelQuestion,
  answer: QuestionAnswer,
  evidence: QaRetrievedEvidence[]
) {
  const intent = analyzeQaQueryIntent(question.question);
  const states = new Set<QaLifecycleEvidenceState>();
  for (const item of citedEvidenceFor(answer, evidence)) {
    states.add(
      assessQaLifecycleEvidence(intent, `${item.title}\n${item.text}`).state
    );
  }
  states.delete("neutral");
  return {
    intent,
    states: [...states].sort() as QaLifecycleEvidenceState[]
  };
}

const UNCERTAINTY_PATTERN =
  /(?:^|[。！？]\s*)没有[。！]|没有(?:找到|足够)?(?:任何)?.{0,40}(?:证据|记录)|未找到.{0,24}(?:证据|记录)|并未(?:出现|找到).{0,24}(?:证据|记录)|未记录(?:实际)?(?:发送|完成)|不能确认|无法确认|尚无(?:证据|记录)|目前只(?:有|能确认)|当前未知/u;
const COMMITMENT_PATTERN = /承诺|答应|约定|计划|准备|会在|会把|将会/u;
const NOT_ALL_COMPLETED_PATTERN =
  /不能(?:确认|说).{0,16}(?:都|全部).{0,8}(?:完成|做完)|并非.{0,16}(?:都|全部).{0,8}(?:完成|做完)|不是.{0,16}(?:都|全部).{0,8}(?:完成|做完)|部分(?:已经)?(?:完成|做完)|仍有.{0,16}(?:未完成|没完成|没有完成)|(?:后续安排|已有明确约定).{0,32}(?:还没有到执行时间|不等于已经完成|没有显示.{0,12}完成)|当前未知/u;
const GROUNDED_NOT_ALL_COMPLETED_PATTERN =
  /没有(?:任何)?(?:证据|记录)(?:表明|显示|证明)?.{0,32}(?:都|全部).{0,8}(?:已经|已)?(?:完成|做完)|(?:只是|仅是|仅有)?(?:已有)?明确约定.{0,40}(?:不能算已完成|不等于(?:已经|已)完成|没有显示.{0,12}(?:完成|做完))/u;

export function preservesAggregateLifecycleBoundary(answerText: string) {
  const normalized = answerText.normalize("NFKC");
  return (
    NOT_ALL_COMPLETED_PATTERN.test(normalized) ||
    GROUNDED_NOT_ALL_COMPLETED_PATTERN.test(normalized)
  );
}

function evaluateQaProviderModelQualityFromSignals(input: {
  question: QaProviderModelQuestion;
  answerText: string;
  citedStates: QaLifecycleEvidenceState[];
  citation: QaProviderModelQuality["citation"];
  fallbackStatus: string;
}): QaProviderModelQuality {
  const repairedByFallback = input.fallbackStatus !== "none";
  const providerPath = input.fallbackStatus === "none"
    ? "native_answer"
    : input.fallbackStatus === "unsupported_answer"
      ? "grounded_unsupported"
      : "validation_fallback";
  const intent = analyzeQaQueryIntent(input.question.question);
  const normalizedAnswer = input.answerText.normalize("NFKC");
  const semanticChecksPassed = input.question.evaluation.requiredAnswerAnyOf.length > 0
    ? answerGroupsPass(input.answerText, input.question.evaluation.requiredAnswerAnyOf)
    : null;
  const lifecycleApplicable = input.question.evaluation.kind === "lifecycle" ||
    input.question.evaluation.kind === "aggregate_lifecycle";
  let lifecyclePass: boolean | null = null;
  if (input.question.evaluation.kind === "lifecycle") {
    lifecyclePass =
      intent.intent === "lifecycle_resolution" &&
      input.citedStates.includes(input.question.evaluation.expectedState as QaLifecycleEvidenceState) &&
      semanticChecksPassed !== false;
  } else if (input.question.evaluation.kind === "aggregate_lifecycle") {
    lifecyclePass =
      intent.intent === "lifecycle_resolution" &&
      intent.aggregateCommitmentCompletion &&
      input.citedStates.includes("pending") &&
      preservesAggregateLifecycleBoundary(normalizedAnswer);
  }

  const unsupportedApplicable = input.question.evaluation.kind === "unsupported";
  const unsupportedGrounded = unsupportedApplicable
    ? input.citedStates.includes("pending") &&
      UNCERTAINTY_PATTERN.test(normalizedAnswer) &&
      COMMITMENT_PATTERN.test(normalizedAnswer)
    : null;
  const completionClaimAbsent = unsupportedApplicable
    ? UNCERTAINTY_PATTERN.test(normalizedAnswer)
    : null;
  const unsupportedPass = unsupportedApplicable
    ? unsupportedGrounded === true && completionClaimAbsent === true
    : null;
  const finalQualityPass =
    input.citation.finalValid &&
    input.citation.inlineMetadataAligned &&
    lifecyclePass !== false &&
    unsupportedPass !== false;

  return {
    citation: {
      ...input.citation,
      repairedByFallback
    },
    lifecycle: {
      applicable: lifecycleApplicable,
      intentRecognized: lifecycleApplicable
        ? intent.intent === "lifecycle_resolution"
        : null,
      expectedState: input.question.evaluation.expectedState,
      citedStates: input.citedStates,
      semanticChecksPassed,
      pass: lifecyclePass
    },
    unsupported: {
      applicable: unsupportedApplicable,
      grounded: unsupportedGrounded,
      completionClaimAbsent,
      pass: unsupportedPass
    },
    providerPath,
    finalQualityPass
  };
}

export function evaluateQaProviderModelQuality(input: {
  question: QaProviderModelQuestion;
  answer: QuestionAnswer;
  evidence: QaRetrievedEvidence[];
  fallbackStatus: string;
}): QaProviderModelQuality {
  const citationValidation = validateFinalCitations(input.answer, input.evidence);
  const lifecycle = lifecycleStates(input.question, input.answer, input.evidence);
  return evaluateQaProviderModelQualityFromSignals({
    question: input.question,
    answerText: input.answer.answer,
    citedStates: lifecycle.states,
    citation: {
      ...citationValidation,
      repairedByFallback: input.fallbackStatus !== "none"
    },
    fallbackStatus: input.fallbackStatus
  });
}

function benchmarkSettingsStore(store: JsonStore): JsonStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property !== "read") return Reflect.get(target, property, receiver);
      return async (collection: string, id: string) => {
        const value = await target.read<Record<string, unknown>>(collection, id);
        if (collection !== "settings" || id !== "provider-config") return value;
        return {
          ...(value ?? {}),
          apiKeyMode: "default",
          openRouterApiKey: undefined,
          qaModel: undefined
        };
      };
    }
  }) as JsonStore;
}

export async function resolveQaProviderModelBasePromptInstruction(
  source: AnswerStrategyBenchmarkSource
) {
  const rawStore = new JsonStore(resolve(source.dataDir, "users", source.userId));
  return (await getQaPromptPreference(benchmarkSettingsStore(rawStore))).trim();
}

export async function executeQaProviderModelQuestion(input: {
  source: AnswerStrategyBenchmarkSource;
  question: QaProviderModelQuestion;
  runtime: QaProviderModelRuntime;
  /**
   * Evaluation-only suffix appended to the currently resolved prompt
   * instruction. Production prompt builders and provider contracts are not
   * changed.
   */
  systemPromptAppend?: string;
}): Promise<QaProviderModelExecution> {
  const rawStore = new JsonStore(resolve(input.source.dataDir, "users", input.source.userId));
  const store = benchmarkSettingsStore(rawStore);
  const basePromptInstruction = (await getQaPromptPreference(store)).trim();
  const systemPromptAppend = input.systemPromptAppend?.trim();
  const effectivePromptInstruction = [
    basePromptInstruction,
    systemPromptAppend
  ].filter(Boolean).join("\n\n");
  let diagnostics: QaExecutionDiagnostics | null = null;
  let streamTrace: QaStreamingTrace | null = null;
  let evidence: QaRetrievedEvidence[] = [];
  const streamDelegate = (qaInput: AnswerQuestionStreamInput) => answerQuestionStream({
    ...qaInput,
    ...(effectivePromptInstruction
      ? { qaPromptInstruction: effectivePromptInstruction }
      : {}),
    onRetrievedEvidence: (items) => {
      evidence = items;
    }
  });
  const answerer = createMemoryVoiceQaAnswerer({
    userId: input.source.userId,
    store,
    scope: "current",
    uploadId: input.source.uploadId,
    context: input.source.context,
    answerMode: "agent",
    dependencies: { answerQuestionStream: streamDelegate }
  });
  const startedAt = performance.now();
  const answer = await answerer.answer({
    sessionId: `qa-model-benchmark-${randomUUID()}`,
    transcript: input.question.question,
    userId: input.source.userId,
    scope: "current",
    uploadId: input.source.uploadId,
    mode: "TEXT",
    onQaDiagnostics: (value) => {
      diagnostics = value;
    },
    onQaStreamEvent: (event) => {
      if (event.type === "final") streamTrace = event.trace;
    }
  });
  if (!answer) throw new Error("QA Provider model benchmark returned no answer");
  return {
    modelAlias: input.runtime.alias,
    modelId: input.runtime.modelId,
    wireApi: input.runtime.wireApi,
    route: input.runtime.route,
    totalLatencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    answer,
    diagnostics,
    streamTrace,
    evidence
  };
}

type ExecuteModel = (input: {
  question: QaProviderModelQuestion;
  runtime: QaProviderModelRuntime;
}) => Promise<QaProviderModelExecution>;

function completedRun(input: {
  pair: QaProviderModelScheduleEntry;
  order: 1 | 2;
  execution: QaProviderModelExecution;
}): QaProviderModelBenchmarkRun {
  const fallbackStatus = input.execution.diagnostics?.fallbackReason ??
    input.execution.streamTrace?.fallbackReason ??
    "diagnostics_unavailable";
  return {
    run_id: `${input.pair.pairId}-${input.execution.modelAlias}`,
    pair_id: input.pair.pairId,
    round: input.pair.round,
    question_id: input.pair.question.id,
    category: input.pair.question.category,
    model_alias: input.execution.modelAlias,
    model_id: input.execution.modelId,
    wire_api: input.execution.wireApi,
    route: input.execution.route,
    execution_order: input.order,
    status: "completed",
    ttft_ms: input.execution.streamTrace?.latencies.firstTokenMs ?? null,
    generation_latency_ms: input.execution.diagnostics?.llmGenerationMs ??
      input.execution.streamTrace?.latencies.totalStreamMs ??
      null,
    total_latency_ms: input.execution.totalLatencyMs,
    response_length: input.execution.answer.answer.length,
    prompt_characters: input.execution.diagnostics?.promptCharacters ?? null,
    evidence_count: input.execution.diagnostics?.evidenceCount ??
      input.execution.evidence.length,
    evidence_digest: qaProviderModelEvidenceDigest(input.execution.evidence),
    citation_count: input.execution.answer.citations?.length ?? 0,
    fallback_status: fallbackStatus,
    quality: evaluateQaProviderModelQuality({
      question: input.pair.question,
      answer: input.execution.answer,
      evidence: input.execution.evidence,
      fallbackStatus
    }),
    answer_text: input.execution.answer.answer,
    cited_segment_ids: [...input.execution.answer.citedSegmentIds],
    error_name: null,
    error_code: null
  };
}

function failedRun(input: {
  pair: QaProviderModelScheduleEntry;
  model: QaProviderModelAlias;
  runtime: QaProviderModelRuntime;
  order: 1 | 2;
  error: unknown;
}): QaProviderModelBenchmarkRun {
  return {
    run_id: `${input.pair.pairId}-${input.model}`,
    pair_id: input.pair.pairId,
    round: input.pair.round,
    question_id: input.pair.question.id,
    category: input.pair.question.category,
    model_alias: input.model,
    model_id: input.runtime.modelId,
    wire_api: input.runtime.wireApi,
    route: input.runtime.route,
    execution_order: input.order,
    status: "failed",
    ttft_ms: null,
    generation_latency_ms: null,
    total_latency_ms: null,
    response_length: 0,
    prompt_characters: null,
    evidence_count: null,
    evidence_digest: null,
    citation_count: 0,
    fallback_status: "execution_error",
    quality: null,
    answer_text: null,
    cited_segment_ids: [],
    error_name: input.error instanceof Error && input.error.name
      ? input.error.name
      : "unknown",
    error_code: errorCode(input.error)
  };
}

function mean(values: number[]) {
  return values.length === 0
    ? null
    : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: number[], value: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)] ?? null;
}

function aggregate(runs: QaProviderModelBenchmarkRun[]): QaProviderModelAggregate {
  const completed = runs.filter((run) => run.status === "completed");
  const metric = (key: "ttft_ms" | "generation_latency_ms" | "total_latency_ms") =>
    completed.flatMap((run) => run[key] === null ? [] : [run[key]]);
  const ttft = metric("ttft_ms");
  const generation = metric("generation_latency_ms");
  const total = metric("total_latency_ms");
  const lifecycle = completed.filter((run) => run.quality?.lifecycle.applicable);
  const unsupported = completed.filter((run) => run.quality?.unsupported.applicable);
  return {
    runs: runs.length,
    completed: completed.length,
    failed: runs.length - completed.length,
    mean_ttft_ms: mean(ttft),
    median_ttft_ms: percentile(ttft, 0.5),
    p95_ttft_ms: percentile(ttft, 0.95),
    mean_generation_latency_ms: mean(generation),
    median_generation_latency_ms: percentile(generation, 0.5),
    p95_generation_latency_ms: percentile(generation, 0.95),
    mean_total_latency_ms: mean(total),
    median_total_latency_ms: percentile(total, 0.5),
    p95_total_latency_ms: percentile(total, 0.95),
    citation_valid_runs: completed.filter((run) =>
      run.quality?.citation.finalValid && run.quality.citation.inlineMetadataAligned
    ).length,
    lifecycle_correct_runs: lifecycle.filter((run) => run.quality?.lifecycle.pass).length,
    lifecycle_applicable_runs: lifecycle.length,
    unsupported_correct_runs: unsupported.filter((run) => run.quality?.unsupported.pass).length,
    unsupported_applicable_runs: unsupported.length,
    native_answer_runs: completed.filter((run) => run.quality?.providerPath === "native_answer").length,
    fallback_runs: completed.filter((run) => run.fallback_status !== "none").length
  };
}

export function buildQaProviderModelBenchmarkReport(input: {
  dataset: QaProviderModelDataset;
  source: AnswerStrategyBenchmarkSource;
  models: Record<QaProviderModelAlias, QaProviderModelRuntime>;
  schedule: QaProviderModelScheduleEntry[];
  rounds: number;
  seed: string;
  runs: QaProviderModelBenchmarkRun[];
  remote: boolean;
  generatedAt?: string;
}): QaProviderModelBenchmarkReport {
  const pairGroups = new Map<string, QaProviderModelBenchmarkRun[]>();
  for (const run of input.runs) {
    pairGroups.set(run.pair_id, [...(pairGroups.get(run.pair_id) ?? []), run]);
  }
  const pairs = [...pairGroups.values()];
  const incompletePairs = pairs.filter((runs) =>
    runs.length !== 2 || runs.some((run) => run.status !== "completed")
  ).length;
  const completePairs = pairs.filter((runs) =>
    runs.length === 2 && runs.every((run) => run.status === "completed")
  );
  const evidenceMismatchPairs = completePairs.filter((runs) =>
    !runs[0]?.evidence_digest ||
    !runs[1]?.evidence_digest ||
    runs[0].evidence_digest !== runs[1].evidence_digest
  ).length;
  const promptSizeMismatchPairs = completePairs.filter((runs) =>
    runs[0]?.prompt_characters === null ||
    runs[1]?.prompt_characters === null ||
    runs[0].prompt_characters !== runs[1].prompt_characters
  ).length;
  return {
    version: QA_PROVIDER_MODEL_BENCHMARK_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    execution: {
      remote: input.remote,
      rounds: input.rounds,
      seed: input.seed,
      serialized: true,
      scheduleVersion: QA_PROVIDER_MODEL_SCHEDULE_VERSION,
      scheduleDigest: stableDigest(input.schedule.map((entry) => ({
        pairId: entry.pairId,
        models: entry.models
      }))),
      totalRuns: input.schedule.length * 2
    },
    dataset: {
      datasetVersion: input.dataset.datasetVersion,
      questionCount: input.dataset.questions.length,
      questionIds: input.dataset.questions.map((question) => question.id)
    },
    source: {
      contextDigest: input.source.contextDigest,
      memoryContextDigest: input.source.memoryContextDigest,
      contextCounts: input.source.contextCounts
    },
    models: input.models,
    runs: input.runs,
    pairIntegrity: {
      totalPairs: input.schedule.length,
      validPairs:
        completePairs.length - evidenceMismatchPairs - promptSizeMismatchPairs,
      evidenceMismatchPairs,
      promptSizeMismatchPairs,
      incompletePairs
    },
    aggregates: {
      "gpt-5.5": aggregate(input.runs.filter((run) => run.model_alias === "gpt-5.5")),
      "ds-v4": aggregate(input.runs.filter((run) => run.model_alias === "ds-v4"))
    },
    limitations: [
      "The benchmark uses synthetic retained long-recording-60m data and current-scope context only.",
      "DeepSeek may use a different endpoint and wire API from GPT; route and wire_api are reported, so latency is model-plus-provider-path rather than a pure model-only measurement.",
      "External provider load and SDK retry behavior can affect TTFT and tail latency.",
      "Lifecycle and unsupported correctness use deterministic, dataset-specific rubrics; nuanced companion quality still requires human review.",
      "Final validation can repair a provider response with deterministic fallback; provider_path distinguishes native answers from repaired final answers."
    ]
  };
}

export function recalibrateQaProviderModelBenchmarkReport(
  report: QaProviderModelBenchmarkReport,
  dataset: QaProviderModelDataset
): QaProviderModelBenchmarkReport {
  const questions = new Map(dataset.questions.map((question) => [question.id, question]));
  const runs = report.runs.map((run): QaProviderModelBenchmarkRun => {
    const question = questions.get(run.question_id);
    if (!question || !run.quality || !run.answer_text) return run;
    return {
      ...run,
      quality: evaluateQaProviderModelQualityFromSignals({
        question,
        answerText: run.answer_text,
        citedStates: run.quality.lifecycle.citedStates,
        citation: run.quality.citation,
        fallbackStatus: run.fallback_status
      })
    };
  });
  return {
    ...report,
    runs,
    aggregates: {
      "gpt-5.5": aggregate(runs.filter((run) => run.model_alias === "gpt-5.5")),
      "ds-v4": aggregate(runs.filter((run) => run.model_alias === "ds-v4"))
    }
  };
}

export async function runQaProviderModelBenchmark(input: {
  dataset: QaProviderModelDataset;
  source: AnswerStrategyBenchmarkSource;
  models: Record<QaProviderModelAlias, QaProviderModelRuntime>;
  rounds: number;
  seed: string;
  remote: boolean;
  execute: ExecuteModel;
  onProgress?: (input: {
    completedRuns: number;
    totalRuns: number;
    run: QaProviderModelBenchmarkRun;
    runs: readonly QaProviderModelBenchmarkRun[];
  }) => unknown;
}): Promise<QaProviderModelBenchmarkReport> {
  const schedule = createQaProviderModelSchedule(
    input.dataset.questions,
    input.rounds,
    input.seed
  );
  const runs: QaProviderModelBenchmarkRun[] = [];
  const totalRuns = schedule.length * 2;
  for (const pair of schedule) {
    for (const [index, model] of pair.models.entries()) {
      const order = (index + 1) as 1 | 2;
      let run: QaProviderModelBenchmarkRun;
      try {
        const execution = await input.execute({
          question: pair.question,
          runtime: input.models[model]
        });
        run = completedRun({ pair, order, execution });
      } catch (error) {
        run = failedRun({
          pair,
          model,
          runtime: input.models[model],
          order,
          error
        });
      }
      runs.push(run);
      await input.onProgress?.({
        completedRuns: runs.length,
        totalRuns,
        run,
        runs: [...runs]
      });
    }
  }
  return buildQaProviderModelBenchmarkReport({
    dataset: input.dataset,
    source: input.source,
    models: input.models,
    schedule,
    rounds: input.rounds,
    seed: input.seed,
    runs,
    remote: input.remote
  });
}

export async function appendQaProviderModelProgress(
  path: string,
  event: Record<string, unknown>
) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(event)}\n`, "utf8");
}

async function atomicWrite(path: string, content: string) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeQaProviderModelReport(
  path: string,
  report: QaProviderModelBenchmarkReport
) {
  await atomicWrite(path, `${JSON.stringify(report, null, 2)}\n`);
}

function metric(value: number | null) {
  return value === null ? "N/A" : value.toLocaleString("en-US");
}

export function renderQaProviderModelReport(report: QaProviderModelBenchmarkReport) {
  const rows = QaProviderModelAliasSchema.options.map((alias) => {
    const value = report.aggregates[alias];
    return `| ${alias} | ${value.completed}/${value.runs} | ${metric(value.mean_ttft_ms)} | ${metric(value.median_ttft_ms)} | ${metric(value.p95_ttft_ms)} | ${metric(value.mean_generation_latency_ms)} | ${metric(value.mean_total_latency_ms)} | ${value.citation_valid_runs}/${value.completed} | ${value.lifecycle_correct_runs}/${value.lifecycle_applicable_runs} | ${value.unsupported_correct_runs}/${value.unsupported_applicable_runs} | ${value.fallback_runs} |`;
  });
  const questionRows = report.runs.map((run) =>
    `| ${run.question_id} | ${run.round} | ${run.model_alias} | ${run.execution_order} | ${run.status} | ${metric(run.ttft_ms)} | ${metric(run.generation_latency_ms)} | ${metric(run.total_latency_ms)} | ${run.quality?.citation.finalValid === true ? "pass" : "fail"} | ${run.quality?.lifecycle.pass === null || run.quality === null ? "N/A" : run.quality.lifecycle.pass ? "pass" : "fail"} | ${run.quality?.unsupported.pass === null || run.quality === null ? "N/A" : run.quality.unsupported.pass ? "pass" : "fail"} | ${run.quality?.providerPath ?? "N/A"} |`
  );
  return `# QA Provider Model Benchmark

## Scope

- Dataset: \`${report.dataset.datasetVersion}\`
- Questions: ${report.dataset.questionIds.join(", ")}
- Rounds: ${report.execution.rounds}
- Executions: ${report.runs.length}/${report.execution.totalRuns}
- Answer strategy: Agent QA only
- Pair integrity: ${report.pairIntegrity.validPairs}/${report.pairIntegrity.totalPairs}
- Evidence mismatches: ${report.pairIntegrity.evidenceMismatchPairs}
- Prompt-size mismatches: ${report.pairIntegrity.promptSizeMismatchPairs}

Both models use the same retained context, question, Agent prompt construction, Evidence ranking, lifecycle handling, citation mapping, and final validation. The production default model is not modified.

## Aggregate results

| Model | Completed | Mean TTFT ms | Median TTFT ms | P95 TTFT ms | Mean generation ms | Mean total ms | Citation valid | Lifecycle correct | Unsupported correct | Fallbacks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows.join("\n")}

## Per-run results

| Question | Round | Model | Order | Status | TTFT ms | Generation ms | Total ms | Citation | Lifecycle | Unsupported | Provider path |
| --- | ---: | --- | ---: | --- | ---: | ---: | ---: | --- | --- | --- | --- |
${questionRows.join("\n")}

## Interpretation boundary

No winner is declared automatically. A deterministic rubric checks citation validity, q017/q018 lifecycle resolution, q022 grounded unsupported handling, and q034 aggregate commitment status. Review answer text in the JSON report before making a product decision.

${report.limitations.map((item) => `- ${item}`).join("\n")}
`;
}

export async function writeQaProviderModelMarkdown(
  path: string,
  report: QaProviderModelBenchmarkReport
) {
  await atomicWrite(path, renderQaProviderModelReport(report));
}

export { loadLongRecording60mBenchmarkSource, stableDigest };
