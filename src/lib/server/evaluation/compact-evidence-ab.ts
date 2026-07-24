import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import type { QuestionAnswer } from "@/lib/domain/types";
import {
  answerQuestionStream,
  type AnswerQuestionStreamInput,
  type QaEvaluationEvidenceView,
  type QaRetrievedEvidence
} from "@/lib/server/retrieval/ai-qa";
import {
  compactEvidencePromptForEvaluation,
  projectCompactEvidence
} from "@/lib/server/retrieval/evidence-compression/projection";
import type { CompactEvidenceProjection } from "@/lib/server/retrieval/evidence-compression/types";
import { analyzeQaQueryIntent } from "@/lib/server/retrieval/lifecycle-retrieval";
import type { QaExecutionDiagnostics } from "@/lib/server/retrieval/qa-observability";
import type {
  QaAnswerStreamEvent,
  QaStreamingTrace
} from "@/lib/server/retrieval/qa-streaming";
import {
  getOpenAIClientRuntimeConfig,
  getQaModelPreference,
  getQaPromptPreference
} from "@/lib/server/settings/provider-config";
import {
  resolveOpenAIClientProvider,
  type OpenAIClientProvider
} from "@/lib/server/openai/client";
import { JsonStore } from "@/lib/server/storage/json-store";
import { createMemoryVoiceQaAnswerer } from "@/lib/server/voice-qa/adapter";

import {
  evaluateQaProviderModelQuality,
  preservesAggregateLifecycleBoundary,
  QaProviderModelQuestionSchema,
  qaProviderModelEvidenceDigest,
  type QaProviderModelQuality
} from "./qa-provider-model-benchmark";
import {
  loadLongRecording60mBenchmarkSource,
  stableDigest,
  type AnswerStrategyBenchmarkSource
} from "./answer-strategy-ab";

export const COMPACT_EVIDENCE_AB_VERSION = 1;
export const COMPACT_EVIDENCE_AB_SCHEDULE_VERSION =
  "seeded-counterbalanced-evidence-view-v1";
export const COMPACT_EVIDENCE_TOKEN_ESTIMATE_METHOD = "ceil_chars_div_2";

export const CompactEvidenceAbViewSchema = z.enum(["original", "compact"]);
export type CompactEvidenceAbView = z.infer<typeof CompactEvidenceAbViewSchema>;

export const CompactEvidenceAbCategorySchema = z.enum([
  "lifecycle",
  "preference",
  "unsupported",
  "relationship"
]);
export type CompactEvidenceAbCategory = z.infer<
  typeof CompactEvidenceAbCategorySchema
>;

const ConceptSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/u),
    anyOf: z.array(z.string().trim().min(1).max(80)).min(1).optional(),
    allOf: z.array(z.string().trim().min(1).max(80)).min(1).optional()
  })
  .strict()
  .refine((concept) => Boolean(concept.anyOf) !== Boolean(concept.allOf), {
    message: "Each concept requires exactly one of anyOf or allOf"
  });

export const CompactEvidenceAbQuestionSchema = z
  .object({
    id: z.string().regex(/^q\d{3}$/u),
    category: CompactEvidenceAbCategorySchema,
    question: z.string().trim().min(2).max(300),
    expectedScope: z.literal("current"),
    evaluation: z
      .object({
        kind: z.enum([
          "lifecycle",
          "aggregate_lifecycle",
          "preference",
          "unsupported",
          "relationship"
        ]),
        expectedState: z.enum([
          "resolved",
          "pending",
          "partial_or_unknown",
          "not_applicable"
        ]),
        concepts: z.array(ConceptSchema).max(12),
        minimumConcepts: z.number().int().nonnegative().max(12),
        requiredConceptIds: z.array(z.string().min(1)).max(12)
      })
      .strict()
  })
  .strict()
  .superRefine((question, context) => {
    const conceptIds = new Set(question.evaluation.concepts.map((item) => item.id));
    if (conceptIds.size !== question.evaluation.concepts.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Concept IDs must be unique"
      });
    }
    if (question.evaluation.minimumConcepts > question.evaluation.concepts.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "minimumConcepts exceeds the concept count"
      });
    }
    for (const id of question.evaluation.requiredConceptIds) {
      if (!conceptIds.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown required concept ID: ${id}`
        });
      }
    }
  });

export type CompactEvidenceAbQuestion = z.infer<
  typeof CompactEvidenceAbQuestionSchema
>;

export const CompactEvidenceAbDatasetSchema = z
  .object({
    version: z.literal(1),
    datasetVersion: z.literal("long-recording-60m-v1"),
    questions: z.array(CompactEvidenceAbQuestionSchema).min(7)
  })
  .strict()
  .superRefine((dataset, context) => {
    const ids = dataset.questions.map((question) => question.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Question IDs must be unique"
      });
    }
    for (const requiredId of [
      "q012",
      "q017",
      "q018",
      "q022",
      "q025",
      "q026",
      "q034"
    ]) {
      if (!ids.includes(requiredId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Missing Compact Evidence benchmark question: ${requiredId}`
        });
      }
    }
  });

export type CompactEvidenceAbDataset = z.infer<
  typeof CompactEvidenceAbDatasetSchema
>;

export type CompactEvidenceAbRuntime = {
  provider: OpenAIClientProvider;
  modelId: string;
  wireApi: "chat" | "responses";
  answerStrategy: "agent";
};

export type CompactEvidenceAbScheduleEntry = {
  pairId: string;
  round: number;
  question: CompactEvidenceAbQuestion;
  views: [CompactEvidenceAbView, CompactEvidenceAbView];
};

export type CompactEvidenceAbExecution = {
  answer: QuestionAnswer;
  diagnostics: QaExecutionDiagnostics | null;
  streamTrace: QaStreamingTrace | null;
  finalSource: Extract<QaAnswerStreamEvent, { type: "final" }>["source"] | null;
  evidence: QaRetrievedEvidence[];
  projection: CompactEvidenceProjection;
  totalLatencyMs: number;
};

export type CompactEvidenceAbQuality = {
  citation: {
    valid: boolean;
    inlineMetadataAligned: boolean;
    exactSourceMapping: boolean;
    citedSourcesAllowed: boolean;
  };
  sourceIds: {
    valid: boolean;
    citedSegmentIdsMatchMetadata: boolean;
  };
  concepts: {
    matched: string[];
    missing: string[];
    minimumRequired: number;
    requiredIdsPassed: boolean;
    pass: boolean;
  };
  lifecycle: QaProviderModelQuality["lifecycle"];
  unsupported: QaProviderModelQuality["unsupported"];
  ownerBoundary: {
    applicable: boolean;
    limitedCheck: true;
    inventedLocalToGlobalMapping: boolean;
    pass: boolean;
  };
  projection: {
    citationMappingUnchanged: boolean;
    sourceIdsUnchanged: boolean;
    lifecycleStateUnchanged: boolean;
  };
  finalQualityPass: boolean;
};

export type CompactEvidenceAbStreamingOutcome =
  | "streaming_success"
  | "safe_fallback"
  | "failed";

export type CompactEvidenceAbRun = {
  run_id: string;
  pair_id: string;
  round: number;
  question_id: string;
  category: CompactEvidenceAbCategory;
  evidence_view: CompactEvidenceAbView;
  execution_order: 1 | 2;
  status: "completed" | "failed";
  provider: string;
  model_id: string;
  wire_api: "chat" | "responses";
  answer_strategy: "agent";
  input_chars: number | null;
  estimated_input_tokens: number | null;
  evidence_chars: number | null;
  estimated_evidence_tokens: number | null;
  canonical_evidence_chars: number | null;
  compact_evidence_chars: number | null;
  evidence_reduction_ratio: number | null;
  ttft_ms: number | null;
  generation_latency_ms: number | null;
  total_latency_ms: number | null;
  response_length: number;
  evidence_count: number | null;
  canonical_evidence_digest: string | null;
  source_mapping_digest: string | null;
  citation_count: number;
  fallback_status: string;
  final_source: CompactEvidenceAbExecution["finalSource"];
  sentence_units: number | null;
  committed_units: number | null;
  sentence_commit_count: number | null;
  streaming_outcome: CompactEvidenceAbStreamingOutcome;
  streaming_success: boolean;
  safe_fallback: boolean;
  projection_fallback_items: number | null;
  projection_fallback_reasons: Record<string, number>;
  quality: CompactEvidenceAbQuality | null;
  answer_text: string | null;
  cited_segment_ids: string[];
  error_name: string | null;
  error_code: string | null;
};

export type CompactEvidenceAbAggregate = {
  runs: number;
  completed: number;
  failed: number;
  mean_input_chars: number | null;
  median_input_chars: number | null;
  mean_estimated_input_tokens: number | null;
  mean_ttft_ms: number | null;
  median_ttft_ms: number | null;
  p95_ttft_ms: number | null;
  mean_generation_latency_ms: number | null;
  median_generation_latency_ms: number | null;
  p95_generation_latency_ms: number | null;
  mean_total_latency_ms: number | null;
  median_total_latency_ms: number | null;
  p95_total_latency_ms: number | null;
  quality_passed: number;
  citation_valid: number;
  source_ids_valid: number;
  lifecycle_correct: number;
  lifecycle_applicable: number;
  unsupported_correct: number;
  unsupported_applicable: number;
  owner_boundary_passed: number;
  owner_boundary_applicable: number;
  fallbacks: number;
  streaming_successes: number;
  safe_fallbacks: number;
};

export type CompactEvidenceAbReport = {
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
    tokenEstimateMethod: typeof COMPACT_EVIDENCE_TOKEN_ESTIMATE_METHOD;
  };
  dataset: {
    datasetVersion: "long-recording-60m-v1";
    questionCount: number;
    questionIds: string[];
    distribution: Record<CompactEvidenceAbCategory, number>;
  };
  source: {
    contextDigest: string;
    memoryContextDigest: string;
    memoryContextCount: 0;
    contextCounts: AnswerStrategyBenchmarkSource["contextCounts"];
  };
  runtime: CompactEvidenceAbRuntime;
  runs: CompactEvidenceAbRun[];
  pairIntegrity: {
    totalPairs: number;
    validPairs: number;
    invalidShapePairs: number;
    incompletePairs: number;
    evidenceMismatchPairs: number;
    sourceMappingMismatchPairs: number;
    runtimeMismatchPairs: number;
  };
  aggregates: {
    byView: Record<CompactEvidenceAbView, CompactEvidenceAbAggregate>;
    byCategory: Record<
      CompactEvidenceAbCategory,
      Record<CompactEvidenceAbView, CompactEvidenceAbAggregate>
    >;
  };
  comparison: {
    inputCharsReductionRatio: number | null;
    estimatedInputTokensReductionRatio: number | null;
    meanTtftImprovementRatio: number | null;
    meanGenerationImprovementRatio: number | null;
    meanTotalImprovementRatio: number | null;
    qualityRegressionPairs: number;
    citationRegressionPairs: number;
    sourceIdRegressionPairs: number;
    lifecycleRegressionPairs: number;
    unsupportedRegressionPairs: number;
    ownerBoundaryRegressionPairs: number;
    streamingRegressionPairs: number;
    compactProjectionFallbackRuns: number;
    sharedQualityFailureQuestions: string[];
  };
  regressions: Array<{
    pair_id: string;
    question_id: string;
    round: number;
    reasons: string[];
  }>;
  productionGray: {
    recommendation: "eligible" | "not_eligible" | "inconclusive";
    reasons: string[];
  };
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

function baseFirstView(seed: string, questionId: string): CompactEvidenceAbView {
  return createHash("sha256").update(`${seed}:${questionId}`).digest()[0]! % 2 === 0
    ? "original"
    : "compact";
}

export function createCompactEvidenceAbSchedule(
  questions: CompactEvidenceAbQuestion[],
  rounds: number,
  seed: string
): CompactEvidenceAbScheduleEntry[] {
  if (!Number.isInteger(rounds) || rounds < 2 || rounds > 20) {
    throw new Error("Compact Evidence A/B rounds must be between 2 and 20");
  }
  if (!seed.trim()) throw new Error("Compact Evidence A/B seed is required");

  return Array.from({ length: rounds }, (_, index) => index + 1).flatMap((round) =>
    shuffled(questions, `${seed}:round:${round}`).map((question) => {
      const base = baseFirstView(seed, question.id);
      const first =
        round % 2 === 0
          ? base === "original"
            ? "compact"
            : "original"
          : base;
      const second = first === "original" ? "compact" : "original";
      return {
        pairId: `r${String(round).padStart(2, "0")}-${question.id}`,
        round,
        question,
        views: [first, second]
      };
    })
  );
}

export function compactEvidenceAbScheduleDigest(
  schedule: readonly CompactEvidenceAbScheduleEntry[]
) {
  return stableDigest(
    schedule.map((item) => ({
      pairId: item.pairId,
      round: item.round,
      questionId: item.question.id,
      views: item.views
    }))
  );
}

export async function loadCompactEvidenceAbDataset(filePath: string) {
  return CompactEvidenceAbDatasetSchema.parse(
    JSON.parse(await readFile(resolve(filePath), "utf8"))
  );
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

function wireApi(environment: NodeJS.ProcessEnv): "chat" | "responses" {
  return (
    environment.OPENAI_QA_WIRE_API ?? environment.OPENAI_WIRE_API
  )?.trim().toLowerCase() === "responses"
    ? "responses"
    : "chat";
}

export async function resolveCompactEvidenceAbRuntime(input: {
  source: AnswerStrategyBenchmarkSource;
  environment?: NodeJS.ProcessEnv;
}): Promise<CompactEvidenceAbRuntime> {
  const rawStore = new JsonStore(
    resolve(input.source.dataDir, "users", input.source.userId)
  );
  const store = benchmarkSettingsStore(rawStore);
  const runtimeConfig = await getOpenAIClientRuntimeConfig(store);
  const provider = resolveOpenAIClientProvider(runtimeConfig);
  const modelId = await getQaModelPreference(store, provider);
  return {
    provider,
    modelId,
    wireApi: wireApi(input.environment ?? process.env),
    answerStrategy: "agent"
  };
}

function evidenceView(view: CompactEvidenceAbView): QaEvaluationEvidenceView {
  return view === "compact" ? "compact" : "canonical";
}

export async function executeCompactEvidenceAbQuestion(input: {
  source: AnswerStrategyBenchmarkSource;
  question: CompactEvidenceAbQuestion;
  view: CompactEvidenceAbView;
}): Promise<CompactEvidenceAbExecution> {
  const rawStore = new JsonStore(
    resolve(input.source.dataDir, "users", input.source.userId)
  );
  const store = benchmarkSettingsStore(rawStore);
  const promptInstruction = (await getQaPromptPreference(store)).trim();
  let diagnostics: QaExecutionDiagnostics | null = null;
  let streamTrace: QaStreamingTrace | null = null;
  let finalSource: CompactEvidenceAbExecution["finalSource"] = null;
  let evidence: QaRetrievedEvidence[] = [];
  const capture: { projection: CompactEvidenceProjection | null } = {
    projection: null
  };

  const streamDelegate = (qaInput: AnswerQuestionStreamInput) =>
    answerQuestionStream({
      ...qaInput,
      ...(promptInstruction ? { qaPromptInstruction: promptInstruction } : {}),
      evaluationEvidenceView: evidenceView(input.view),
      onRetrievedEvidence: (items) => {
        evidence = items;
        capture.projection = projectCompactEvidence({
          evidence: items,
          queryIntent: analyzeQaQueryIntent(input.question.question)
        });
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
    sessionId: `compact-evidence-ab-${randomUUID()}`,
    transcript: input.question.question,
    userId: input.source.userId,
    scope: "current",
    uploadId: input.source.uploadId,
    mode: "TEXT",
    onQaDiagnostics: (value) => {
      diagnostics = value;
    },
    onQaStreamEvent: (event) => {
      if (event.type !== "final") return;
      streamTrace = event.trace;
      finalSource = event.source;
    }
  });
  if (!answer) throw new Error("Compact Evidence benchmark returned no answer");
  const projection = capture.projection;
  if (projection === null) {
    throw new Error("Compact Evidence benchmark did not observe canonical Evidence");
  }
  if (
    !projection.citationMappingUnchanged ||
    !projection.sourceIdsUnchanged ||
    !projection.lifecycleStateUnchanged
  ) {
    throw new Error("Compact Evidence benchmark projection invariants failed");
  }
  return {
    answer,
    diagnostics,
    streamTrace,
    finalSource,
    evidence,
    projection,
    totalLatencyMs: Math.max(0, Math.round(performance.now() - startedAt))
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

function inlineCitationIds(answer: string) {
  return [...answer.matchAll(/\[(E\d+)\]/giu)].map((match) =>
    match[1]!.toUpperCase()
  );
}

function citationQuality(
  answer: QuestionAnswer,
  evidence: QaRetrievedEvidence[]
): CompactEvidenceAbQuality["citation"] &
  CompactEvidenceAbQuality["sourceIds"] {
  const allowedSources = new Set(evidence.flatMap((item) => item.sourceSegmentIds));
  const byCitationId = new Map<string, QaRetrievedEvidence>(
    evidence.map((item, index) => [`E${index + 1}`, item] as const)
  );
  const declared = answer.citations ?? [];
  const declaredIds = new Set(declared.map((item) => item.id.toUpperCase()));
  const citedSourcesAllowed =
    answer.citedSegmentIds.every((sourceId) => allowedSources.has(sourceId)) &&
    declared.every((citation) =>
      citation.sourceSegmentIds.length > 0 &&
      citation.sourceSegmentIds.every((sourceId) => allowedSources.has(sourceId))
    );
  const inlineMetadataAligned = inlineCitationIds(answer.answer).every((id) =>
    declaredIds.has(id)
  );
  const exactSourceMapping =
    declared.length > 0 &&
    declared.every((citation) => {
      const evidenceItem = byCitationId.get(citation.id.toUpperCase());
      return (
        evidenceItem !== undefined &&
        sameStringSet(citation.sourceSegmentIds, evidenceItem.sourceSegmentIds)
      );
    });
  const metadataSources = [
    ...new Set(declared.flatMap((citation) => citation.sourceSegmentIds))
  ];
  const citedSegmentIdsMatchMetadata = sameStringSet(
    answer.citedSegmentIds,
    metadataSources
  );
  return {
    valid:
      citedSourcesAllowed &&
      inlineMetadataAligned &&
      exactSourceMapping &&
      citedSegmentIdsMatchMetadata,
    inlineMetadataAligned,
    exactSourceMapping,
    citedSourcesAllowed,
    citedSegmentIdsMatchMetadata
  };
}

function normalizedContains(text: string, value: string) {
  return text.normalize("NFKC").toLowerCase().includes(
    value.normalize("NFKC").toLowerCase()
  );
}

function conceptQuality(
  question: CompactEvidenceAbQuestion,
  answerText: string
): CompactEvidenceAbQuality["concepts"] {
  const matched = question.evaluation.concepts
    .filter((concept) =>
      concept.anyOf
        ? concept.anyOf.some((value) => normalizedContains(answerText, value))
        : concept.allOf!.every((value) => normalizedContains(answerText, value))
    )
    .map((concept) => concept.id);
  const matchedSet = new Set(matched);
  const missing = question.evaluation.concepts
    .map((concept) => concept.id)
    .filter((id) => !matchedSet.has(id));
  const requiredIdsPassed = question.evaluation.requiredConceptIds.every((id) =>
    matchedSet.has(id)
  );
  return {
    matched,
    missing,
    minimumRequired: question.evaluation.minimumConcepts,
    requiredIdsPassed,
    pass:
      requiredIdsPassed &&
      matched.length >= question.evaluation.minimumConcepts
  };
}

const INVENTED_LOCAL_TO_GLOBAL_IDENTITY =
  /(?:speaker[_\s-]?[0-9]+|说话人[一二三四0-9]+).{0,16}(?:就是|对应|是)(?:用户|伴侣|女友|男友|妻子|丈夫|本人)/iu;

function providerModelQuestion(question: CompactEvidenceAbQuestion) {
  if (
    question.evaluation.kind !== "lifecycle" &&
    question.evaluation.kind !== "aggregate_lifecycle" &&
    question.evaluation.kind !== "unsupported"
  ) {
    return null;
  }
  return QaProviderModelQuestionSchema.parse({
    id: question.id,
    category:
      question.evaluation.kind === "unsupported" ? "unsupported" : "lifecycle",
    question: question.question,
    expectedScope: "current",
    evaluation: {
      kind: question.evaluation.kind,
      expectedState: question.evaluation.expectedState,
      requiredAnswerAnyOf: question.evaluation.concepts.flatMap((concept) =>
        concept.anyOf
          ? [concept.anyOf]
          : concept.allOf!.map((value) => [value])
      )
    }
  });
}

const NOT_APPLICABLE_LIFECYCLE: QaProviderModelQuality["lifecycle"] = {
  applicable: false,
  intentRecognized: null,
  expectedState: "not_applicable",
  citedStates: [],
  semanticChecksPassed: null,
  pass: null
};

const NOT_APPLICABLE_UNSUPPORTED: QaProviderModelQuality["unsupported"] = {
  applicable: false,
  grounded: null,
  completionClaimAbsent: null,
  pass: null
};

function compactEvidenceQualityPass(
  quality: Omit<CompactEvidenceAbQuality, "finalQualityPass">
) {
  return (
    quality.citation.valid &&
    quality.concepts.pass &&
    quality.lifecycle.pass !== false &&
    quality.unsupported.pass !== false &&
    quality.ownerBoundary.pass &&
    quality.projection.citationMappingUnchanged &&
    quality.projection.sourceIdsUnchanged &&
    quality.projection.lifecycleStateUnchanged
  );
}

export function evaluateCompactEvidenceAbQuality(input: {
  question: CompactEvidenceAbQuestion;
  answer: QuestionAnswer;
  evidence: QaRetrievedEvidence[];
  fallbackStatus: string;
  projection: CompactEvidenceProjection;
}): CompactEvidenceAbQuality {
  const citation = citationQuality(input.answer, input.evidence);
  const concepts = conceptQuality(input.question, input.answer.answer);
  const compatible = providerModelQuestion(input.question);
  const providerQuality = compatible
    ? evaluateQaProviderModelQuality({
        question: compatible,
        answer: input.answer,
        evidence: input.evidence,
        fallbackStatus: input.fallbackStatus
      })
    : null;
  const ownerApplicable =
    input.question.category === "preference" ||
    input.question.category === "relationship" ||
    input.question.id === "q034";
  const inventedLocalToGlobalMapping = INVENTED_LOCAL_TO_GLOBAL_IDENTITY.test(
    input.answer.answer
  );
  const lifecycle = providerQuality?.lifecycle ?? NOT_APPLICABLE_LIFECYCLE;
  const unsupported =
    providerQuality?.unsupported ?? NOT_APPLICABLE_UNSUPPORTED;
  const ownerPass = !inventedLocalToGlobalMapping;
  const qualityWithoutFinal: Omit<
    CompactEvidenceAbQuality,
    "finalQualityPass"
  > = {
    citation: {
      valid: citation.valid,
      inlineMetadataAligned: citation.inlineMetadataAligned,
      exactSourceMapping: citation.exactSourceMapping,
      citedSourcesAllowed: citation.citedSourcesAllowed
    },
    sourceIds: {
      valid:
        citation.citedSourcesAllowed &&
        citation.exactSourceMapping &&
        citation.citedSegmentIdsMatchMetadata,
      citedSegmentIdsMatchMetadata: citation.citedSegmentIdsMatchMetadata
    },
    concepts,
    lifecycle,
    unsupported,
    ownerBoundary: {
      applicable: ownerApplicable,
      limitedCheck: true,
      inventedLocalToGlobalMapping,
      pass: ownerPass
    },
    projection: {
      citationMappingUnchanged: input.projection.citationMappingUnchanged,
      sourceIdsUnchanged: input.projection.sourceIdsUnchanged,
      lifecycleStateUnchanged: input.projection.lifecycleStateUnchanged
    }
  };
  return {
    ...qualityWithoutFinal,
    finalQualityPass: compactEvidenceQualityPass(qualityWithoutFinal)
  };
}

export function rescoreCompactEvidenceAbStoredRuns(input: {
  questions: readonly CompactEvidenceAbQuestion[];
  runs: readonly CompactEvidenceAbRun[];
}) {
  const questions = new Map(input.questions.map((question) => [question.id, question]));
  return input.runs.map((run): CompactEvidenceAbRun => {
    const question = questions.get(run.question_id);
    if (
      !question ||
      question.evaluation.kind !== "aggregate_lifecycle" ||
      !run.quality ||
      !run.answer_text
    ) {
      return run;
    }
    const lifecycle = run.quality.lifecycle;
    const lifecyclePass =
      lifecycle.intentRecognized === true &&
      lifecycle.citedStates.includes("pending") &&
      lifecycle.citedStates.includes("resolved") &&
      preservesAggregateLifecycleBoundary(run.answer_text);
    const qualityWithoutFinal: Omit<
      CompactEvidenceAbQuality,
      "finalQualityPass"
    > = {
      ...run.quality,
      lifecycle: {
        ...lifecycle,
        pass: lifecyclePass
      }
    };
    return {
      ...run,
      quality: {
        ...qualityWithoutFinal,
        finalQualityPass: compactEvidenceQualityPass(qualityWithoutFinal)
      }
    };
  });
}

function estimateTokens(characters: number) {
  return Math.ceil(characters / 2);
}

function errorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,80}$/u.test(value)
    ? value
    : null;
}

function projectionFallbackReasons(projection: CompactEvidenceProjection) {
  const reasons: Record<string, number> = {};
  for (const view of projection.views) {
    if (!view.fallbackReason) continue;
    reasons[view.fallbackReason] = (reasons[view.fallbackReason] ?? 0) + 1;
  }
  return reasons;
}

function streamingOutcome(input: {
  execution: CompactEvidenceAbExecution;
  quality: CompactEvidenceAbQuality;
}): CompactEvidenceAbStreamingOutcome {
  const trace = input.execution.streamTrace;
  const commit = trace?.sentenceCommit;
  if (
    input.execution.finalSource === "provider_stream" &&
    trace?.status === "completed" &&
    trace.fallbackReason === null &&
    commit !== undefined &&
    (commit?.sentenceUnits ?? 0) > 0 &&
    commit.committedUnits === commit.sentenceUnits &&
    commit.missingSentenceSupport === 0 &&
    commit.citationMetadataMismatch === 0 &&
    commit.responseNotFullyCommittable === 0
  ) {
    return "streaming_success";
  }
  return input.quality.citation.valid && input.quality.sourceIds.valid
    ? "safe_fallback"
    : "failed";
}

function completedRun(input: {
  pair: CompactEvidenceAbScheduleEntry;
  view: CompactEvidenceAbView;
  order: 1 | 2;
  runtime: CompactEvidenceAbRuntime;
  execution: CompactEvidenceAbExecution;
}): CompactEvidenceAbRun {
  const diagnostics = input.execution.diagnostics;
  const trace = input.execution.streamTrace;
  const diagnosticsFallback =
    diagnostics?.fallbackReason && diagnostics.fallbackReason !== "none"
      ? diagnostics.fallbackReason
      : null;
  const fallbackStatus =
    trace?.fallbackReason ??
    diagnosticsFallback ??
    (input.execution.finalSource &&
    input.execution.finalSource !== "provider_stream"
      ? input.execution.finalSource
      : diagnostics
        ? "none"
        : "diagnostics_unavailable");
  const quality = evaluateCompactEvidenceAbQuality({
    question: input.pair.question,
    answer: input.execution.answer,
    evidence: input.execution.evidence,
    fallbackStatus,
    projection: input.execution.projection
  });
  const outcome = streamingOutcome({ execution: input.execution, quality });
  const evidenceCharacters =
    input.view === "compact"
      ? input.execution.projection.compactChars
      : input.execution.projection.originalChars;
  const commit = trace?.sentenceCommit;
  return {
    run_id: `${input.pair.pairId}-${input.view}`,
    pair_id: input.pair.pairId,
    round: input.pair.round,
    question_id: input.pair.question.id,
    category: input.pair.question.category,
    evidence_view: input.view,
    execution_order: input.order,
    status: "completed",
    provider: input.runtime.provider,
    model_id: input.runtime.modelId,
    wire_api: input.runtime.wireApi,
    answer_strategy: "agent",
    input_chars: diagnostics?.promptCharacters ?? null,
    estimated_input_tokens:
      diagnostics?.promptCharacters === null ||
      diagnostics?.promptCharacters === undefined
        ? null
        : estimateTokens(diagnostics.promptCharacters),
    evidence_chars: evidenceCharacters,
    estimated_evidence_tokens: estimateTokens(evidenceCharacters),
    canonical_evidence_chars: input.execution.projection.originalChars,
    compact_evidence_chars: input.execution.projection.compactChars,
    evidence_reduction_ratio: input.execution.projection.reductionRatio,
    ttft_ms: trace?.latencies.firstTokenMs ?? null,
    generation_latency_ms:
      diagnostics?.llmGenerationMs ?? trace?.latencies.totalStreamMs ?? null,
    total_latency_ms: input.execution.totalLatencyMs,
    response_length: input.execution.answer.answer.length,
    evidence_count: input.execution.evidence.length,
    canonical_evidence_digest: qaProviderModelEvidenceDigest(
      input.execution.evidence
    ),
    source_mapping_digest: stableDigest(
      input.execution.evidence.map((item, index) => ({
        citationId: `E${index + 1}`,
        canonicalEvidenceId: item.id,
        sourceSegmentIds: item.sourceSegmentIds
      }))
    ),
    citation_count: input.execution.answer.citations?.length ?? 0,
    fallback_status: fallbackStatus,
    final_source: input.execution.finalSource,
    sentence_units: commit?.sentenceUnits ?? null,
    committed_units: commit?.committedUnits ?? null,
    sentence_commit_count: trace?.sentenceCount ?? null,
    streaming_outcome: outcome,
    streaming_success: outcome === "streaming_success",
    safe_fallback: outcome === "safe_fallback",
    projection_fallback_items: input.execution.projection.fallbackItems,
    projection_fallback_reasons: projectionFallbackReasons(
      input.execution.projection
    ),
    quality,
    answer_text: input.execution.answer.answer,
    cited_segment_ids: [...input.execution.answer.citedSegmentIds],
    error_name: null,
    error_code: null
  };
}

function failedRun(input: {
  pair: CompactEvidenceAbScheduleEntry;
  view: CompactEvidenceAbView;
  order: 1 | 2;
  runtime: CompactEvidenceAbRuntime;
  error: unknown;
}): CompactEvidenceAbRun {
  return {
    run_id: `${input.pair.pairId}-${input.view}`,
    pair_id: input.pair.pairId,
    round: input.pair.round,
    question_id: input.pair.question.id,
    category: input.pair.question.category,
    evidence_view: input.view,
    execution_order: input.order,
    status: "failed",
    provider: input.runtime.provider,
    model_id: input.runtime.modelId,
    wire_api: input.runtime.wireApi,
    answer_strategy: "agent",
    input_chars: null,
    estimated_input_tokens: null,
    evidence_chars: null,
    estimated_evidence_tokens: null,
    canonical_evidence_chars: null,
    compact_evidence_chars: null,
    evidence_reduction_ratio: null,
    ttft_ms: null,
    generation_latency_ms: null,
    total_latency_ms: null,
    response_length: 0,
    evidence_count: null,
    canonical_evidence_digest: null,
    source_mapping_digest: null,
    citation_count: 0,
    fallback_status: "execution_error",
    final_source: null,
    sentence_units: null,
    committed_units: null,
    sentence_commit_count: null,
    streaming_outcome: "failed",
    streaming_success: false,
    safe_fallback: false,
    projection_fallback_items: null,
    projection_fallback_reasons: {},
    quality: null,
    answer_text: null,
    cited_segment_ids: [],
    error_name: input.error instanceof Error ? input.error.name : "unknown",
    error_code: errorCode(input.error)
  };
}

type ExecuteQuestion = (input: {
  question: CompactEvidenceAbQuestion;
  view: CompactEvidenceAbView;
}) => Promise<CompactEvidenceAbExecution>;

export async function runCompactEvidenceAb(input: {
  questions: CompactEvidenceAbQuestion[];
  source: AnswerStrategyBenchmarkSource;
  runtime: CompactEvidenceAbRuntime;
  rounds: number;
  seed: string;
  remote: boolean;
  executeQuestion?: ExecuteQuestion;
  onRunStart?: (input: {
    completedRuns: number;
    totalRuns: number;
    pair: CompactEvidenceAbScheduleEntry;
    view: CompactEvidenceAbView;
    order: 1 | 2;
    runs: readonly CompactEvidenceAbRun[];
  }) => unknown;
  onProgress?: (input: {
    completedRuns: number;
    totalRuns: number;
    run: CompactEvidenceAbRun;
    runs: readonly CompactEvidenceAbRun[];
  }) => unknown;
}) {
  const schedule = createCompactEvidenceAbSchedule(
    input.questions,
    input.rounds,
    input.seed
  );
  const totalRuns = schedule.length * 2;
  const runs: CompactEvidenceAbRun[] = [];
  const executeQuestion =
    input.executeQuestion ??
    ((runInput) =>
      executeCompactEvidenceAbQuestion({
        source: input.source,
        question: runInput.question,
        view: runInput.view
      }));

  for (const pair of schedule) {
    for (const [index, view] of pair.views.entries()) {
      const order = (index + 1) as 1 | 2;
      await input.onRunStart?.({
        completedRuns: runs.length,
        totalRuns,
        pair,
        view,
        order,
        runs
      });
      let run: CompactEvidenceAbRun;
      try {
        const execution = await executeQuestion({
          question: pair.question,
          view
        });
        run = completedRun({
          pair,
          view,
          order,
          runtime: input.runtime,
          execution
        });
      } catch (error) {
        run = failedRun({
          pair,
          view,
          order,
          runtime: input.runtime,
          error
        });
      }
      runs.push(run);
      await input.onProgress?.({
        completedRuns: runs.length,
        totalRuns,
        run,
        runs
      });
    }
  }

  return buildCompactEvidenceAbReport({
    questions: input.questions,
    source: input.source,
    runtime: input.runtime,
    schedule,
    rounds: input.rounds,
    seed: input.seed,
    runs,
    remote: input.remote
  });
}

function values(
  runs: CompactEvidenceAbRun[],
  key:
    | "input_chars"
    | "estimated_input_tokens"
    | "ttft_ms"
    | "generation_latency_ms"
    | "total_latency_ms"
) {
  return runs
    .map((run) => run[key])
    .filter((value): value is number => value !== null);
}

function mean(items: number[]) {
  return items.length === 0
    ? null
    : Math.round(items.reduce((sum, item) => sum + item, 0) / items.length);
}

function percentile(items: number[], percentileValue: number) {
  if (items.length === 0) return null;
  const sorted = [...items].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.ceil((percentileValue / 100) * sorted.length) - 1
  );
  return sorted[index] ?? null;
}

function aggregate(runs: CompactEvidenceAbRun[]): CompactEvidenceAbAggregate {
  const completed = runs.filter((run) => run.status === "completed");
  const lifecycle = completed.filter(
    (run) => run.quality?.lifecycle.applicable === true
  );
  const unsupported = completed.filter(
    (run) => run.quality?.unsupported.applicable === true
  );
  const owner = completed.filter(
    (run) => run.quality?.ownerBoundary.applicable === true
  );
  return {
    runs: runs.length,
    completed: completed.length,
    failed: runs.length - completed.length,
    mean_input_chars: mean(values(completed, "input_chars")),
    median_input_chars: percentile(values(completed, "input_chars"), 50),
    mean_estimated_input_tokens: mean(
      values(completed, "estimated_input_tokens")
    ),
    mean_ttft_ms: mean(values(completed, "ttft_ms")),
    median_ttft_ms: percentile(values(completed, "ttft_ms"), 50),
    p95_ttft_ms: percentile(values(completed, "ttft_ms"), 95),
    mean_generation_latency_ms: mean(
      values(completed, "generation_latency_ms")
    ),
    median_generation_latency_ms: percentile(
      values(completed, "generation_latency_ms"),
      50
    ),
    p95_generation_latency_ms: percentile(
      values(completed, "generation_latency_ms"),
      95
    ),
    mean_total_latency_ms: mean(values(completed, "total_latency_ms")),
    median_total_latency_ms: percentile(
      values(completed, "total_latency_ms"),
      50
    ),
    p95_total_latency_ms: percentile(values(completed, "total_latency_ms"), 95),
    quality_passed: completed.filter(
      (run) => run.quality?.finalQualityPass === true
    ).length,
    citation_valid: completed.filter(
      (run) => run.quality?.citation.valid === true
    ).length,
    source_ids_valid: completed.filter(
      (run) => run.quality?.sourceIds.valid === true
    ).length,
    lifecycle_correct: lifecycle.filter(
      (run) => run.quality?.lifecycle.pass === true
    ).length,
    lifecycle_applicable: lifecycle.length,
    unsupported_correct: unsupported.filter(
      (run) => run.quality?.unsupported.pass === true
    ).length,
    unsupported_applicable: unsupported.length,
    owner_boundary_passed: owner.filter(
      (run) => run.quality?.ownerBoundary.pass === true
    ).length,
    owner_boundary_applicable: owner.length,
    fallbacks: completed.filter((run) => run.fallback_status !== "none").length,
    streaming_successes: completed.filter((run) => run.streaming_success).length,
    safe_fallbacks: completed.filter((run) => run.safe_fallback).length
  };
}

function improvement(
  original: number | null,
  compact: number | null
): number | null {
  if (original === null || compact === null || original === 0) return null;
  return Math.round(((original - compact) / original) * 10_000) / 10_000;
}

function pairRegressions(runs: CompactEvidenceAbRun[]) {
  const byPair = new Map<string, CompactEvidenceAbRun[]>();
  for (const run of runs) {
    byPair.set(run.pair_id, [...(byPair.get(run.pair_id) ?? []), run]);
  }
  const regressions: CompactEvidenceAbReport["regressions"] = [];
  const invalidShapePairIds = new Set<string>();
  const incompletePairIds = new Set<string>();
  const evidenceMismatchPairIds = new Set<string>();
  const sourceMappingMismatchPairIds = new Set<string>();
  const runtimeMismatchPairIds = new Set<string>();
  let qualityRegressionPairs = 0;
  let citationRegressionPairs = 0;
  let sourceIdRegressionPairs = 0;
  let lifecycleRegressionPairs = 0;
  let unsupportedRegressionPairs = 0;
  let ownerBoundaryRegressionPairs = 0;
  let streamingRegressionPairs = 0;

  for (const [pairId, pairRuns] of byPair) {
    const originals = pairRuns.filter((run) => run.evidence_view === "original");
    const compacts = pairRuns.filter((run) => run.evidence_view === "compact");
    const original = originals[0];
    const compact = compacts[0];
    if (pairRuns.length !== 2 || originals.length !== 1 || compacts.length !== 1) {
      invalidShapePairIds.add(pairId);
    }
    if (!original || !compact) {
      incompletePairIds.add(pairId);
      continue;
    }
    if (
      !original.canonical_evidence_digest ||
      original.canonical_evidence_digest !== compact.canonical_evidence_digest
    ) {
      evidenceMismatchPairIds.add(pairId);
    }
    if (
      !original.source_mapping_digest ||
      original.source_mapping_digest !== compact.source_mapping_digest
    ) {
      sourceMappingMismatchPairIds.add(pairId);
    }
    if (
      original.provider !== compact.provider ||
      original.model_id !== compact.model_id ||
      original.wire_api !== compact.wire_api ||
      original.answer_strategy !== compact.answer_strategy
    ) {
      runtimeMismatchPairIds.add(pairId);
    }
    const reasons: string[] = [];
    const compare = (
      reason: string,
      originalPass: boolean | null | undefined,
      compactPass: boolean | null | undefined
    ) => {
      if (originalPass === true && compactPass !== true) reasons.push(reason);
    };
    compare(
      "quality_regression",
      original.quality?.finalQualityPass,
      compact.quality?.finalQualityPass
    );
    compare(
      "citation_regression",
      original.quality?.citation.valid,
      compact.quality?.citation.valid
    );
    compare(
      "source_id_regression",
      original.quality?.sourceIds.valid,
      compact.quality?.sourceIds.valid
    );
    compare(
      "lifecycle_regression",
      original.quality?.lifecycle.pass,
      compact.quality?.lifecycle.pass
    );
    compare(
      "unsupported_regression",
      original.quality?.unsupported.pass,
      compact.quality?.unsupported.pass
    );
    compare(
      "owner_boundary_regression",
      original.quality?.ownerBoundary.pass,
      compact.quality?.ownerBoundary.pass
    );
    compare(
      "streaming_regression",
      original.streaming_success,
      compact.streaming_success
    );
    if (reasons.includes("quality_regression")) qualityRegressionPairs += 1;
    if (reasons.includes("citation_regression")) citationRegressionPairs += 1;
    if (reasons.includes("source_id_regression")) sourceIdRegressionPairs += 1;
    if (reasons.includes("lifecycle_regression")) lifecycleRegressionPairs += 1;
    if (reasons.includes("unsupported_regression")) {
      unsupportedRegressionPairs += 1;
    }
    if (reasons.includes("owner_boundary_regression")) {
      ownerBoundaryRegressionPairs += 1;
    }
    if (reasons.includes("streaming_regression")) streamingRegressionPairs += 1;
    if (reasons.length > 0) {
      regressions.push({
        pair_id: pairId,
        question_id: original.question_id,
        round: original.round,
        reasons
      });
    }
  }
  const invalidPairIds = new Set([
    ...invalidShapePairIds,
    ...incompletePairIds,
    ...evidenceMismatchPairIds,
    ...sourceMappingMismatchPairIds,
    ...runtimeMismatchPairIds
  ]);
  return {
    totalPairs: byPair.size,
    validPairs: byPair.size - invalidPairIds.size,
    invalidShapePairs: invalidShapePairIds.size,
    incompletePairs: incompletePairIds.size,
    evidenceMismatchPairs: evidenceMismatchPairIds.size,
    sourceMappingMismatchPairs: sourceMappingMismatchPairIds.size,
    runtimeMismatchPairs: runtimeMismatchPairIds.size,
    qualityRegressionPairs,
    citationRegressionPairs,
    sourceIdRegressionPairs,
    lifecycleRegressionPairs,
    unsupportedRegressionPairs,
    ownerBoundaryRegressionPairs,
    streamingRegressionPairs,
    regressions
  };
}

function categoryDistribution(questions: CompactEvidenceAbQuestion[]) {
  return Object.fromEntries(
    CompactEvidenceAbCategorySchema.options.map((category) => [
      category,
      questions.filter((question) => question.category === category).length
    ])
  ) as Record<CompactEvidenceAbCategory, number>;
}

export function buildCompactEvidenceAbReport(input: {
  questions: CompactEvidenceAbQuestion[];
  source: AnswerStrategyBenchmarkSource;
  runtime: CompactEvidenceAbRuntime;
  schedule: CompactEvidenceAbScheduleEntry[];
  rounds: number;
  seed: string;
  runs: CompactEvidenceAbRun[];
  remote: boolean;
  generatedAt?: string;
}): CompactEvidenceAbReport {
  const runs = rescoreCompactEvidenceAbStoredRuns({
    questions: input.questions,
    runs: input.runs
  });
  const original = aggregate(
    runs.filter((run) => run.evidence_view === "original")
  );
  const compact = aggregate(
    runs.filter((run) => run.evidence_view === "compact")
  );
  const pair = pairRegressions(runs);
  const compactRuns = runs.filter((run) => run.evidence_view === "compact");
  const compactProjectionFallbackRuns = compactRuns.filter(
    (run) => (run.projection_fallback_items ?? 0) > 0
  ).length;
  const failedCompactRuns = compactRuns.filter(
    (run) => run.status === "failed"
  ).length;
  const sharedQualityFailureQuestions = input.questions
    .map((question) => question.id)
    .filter((questionId) => {
      const originalRuns = runs.filter(
        (run) =>
          run.question_id === questionId &&
          run.evidence_view === "original" &&
          run.status === "completed"
      );
      const compactQuestionRuns = runs.filter(
        (run) =>
          run.question_id === questionId &&
          run.evidence_view === "compact" &&
          run.status === "completed"
      );
      return (
        originalRuns.length > 0 &&
        compactQuestionRuns.length > 0 &&
        originalRuns.every((run) => run.quality?.finalQualityPass === false) &&
        compactQuestionRuns.every(
          (run) => run.quality?.finalQualityPass === false
        )
      );
    });
  const meanTotalImprovementRatio = improvement(
    original.mean_total_latency_ms,
    compact.mean_total_latency_ms
  );
  const reasons: string[] = [];
  if (failedCompactRuns > 0) reasons.push(`${failedCompactRuns} Compact runs failed`);
  if (pair.incompletePairs > 0) reasons.push("One or more A/B pairs are incomplete");
  if (
    pair.invalidShapePairs > 0 ||
    pair.evidenceMismatchPairs > 0 ||
    pair.sourceMappingMismatchPairs > 0 ||
    pair.runtimeMismatchPairs > 0
  ) {
    reasons.push("A/B pair integrity did not hold");
  }
  if (
    pair.qualityRegressionPairs > 0 ||
    pair.citationRegressionPairs > 0 ||
    pair.sourceIdRegressionPairs > 0 ||
    pair.lifecycleRegressionPairs > 0 ||
    pair.unsupportedRegressionPairs > 0 ||
    pair.ownerBoundaryRegressionPairs > 0
  ) {
    reasons.push("Compact introduced a deterministic quality regression");
  }
  if (compact.fallbacks > original.fallbacks) {
    reasons.push("Compact produced more validation/provider fallbacks");
  }
  if (compact.streaming_successes < original.streaming_successes) {
    reasons.push("Compact reduced fully committed streaming responses");
  }
  if (sharedQualityFailureQuestions.length > 0) {
    reasons.push(
      `Required questions have unresolved shared quality failures: ${sharedQualityFailureQuestions.join(", ")}`
    );
  }
  if (
    meanTotalImprovementRatio !== null &&
    meanTotalImprovementRatio <= 0
  ) {
    reasons.push("Compact did not demonstrate mean total latency improvement");
  }
  const complete =
    runs.length === input.schedule.length * 2 &&
    runs.every((run) => run.status === "completed");
  const recommendation =
    !complete || pair.incompletePairs > 0
      ? "inconclusive"
      : reasons.length > 0
        ? "not_eligible"
        : "eligible";

  return {
    version: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    execution: {
      remote: input.remote,
      rounds: input.rounds,
      seed: input.seed,
      serialized: true,
      scheduleVersion: COMPACT_EVIDENCE_AB_SCHEDULE_VERSION,
      scheduleDigest: compactEvidenceAbScheduleDigest(input.schedule),
      totalRuns: input.schedule.length * 2,
      tokenEstimateMethod: COMPACT_EVIDENCE_TOKEN_ESTIMATE_METHOD
    },
    dataset: {
      datasetVersion: "long-recording-60m-v1",
      questionCount: input.questions.length,
      questionIds: input.questions.map((question) => question.id),
      distribution: categoryDistribution(input.questions)
    },
    source: {
      contextDigest: input.source.contextDigest,
      memoryContextDigest: input.source.memoryContextDigest,
      memoryContextCount: 0,
      contextCounts: input.source.contextCounts
    },
    runtime: input.runtime,
    runs,
    pairIntegrity: {
      totalPairs: pair.totalPairs,
      validPairs: pair.validPairs,
      invalidShapePairs: pair.invalidShapePairs,
      incompletePairs: pair.incompletePairs,
      evidenceMismatchPairs: pair.evidenceMismatchPairs,
      sourceMappingMismatchPairs: pair.sourceMappingMismatchPairs,
      runtimeMismatchPairs: pair.runtimeMismatchPairs
    },
    aggregates: {
      byView: { original, compact },
      byCategory: Object.fromEntries(
        CompactEvidenceAbCategorySchema.options.map((category) => [
          category,
          {
            original: aggregate(
              runs.filter(
                (run) =>
                  run.category === category && run.evidence_view === "original"
              )
            ),
            compact: aggregate(
              runs.filter(
                (run) =>
                  run.category === category && run.evidence_view === "compact"
              )
            )
          }
        ])
      ) as CompactEvidenceAbReport["aggregates"]["byCategory"]
    },
    comparison: {
      inputCharsReductionRatio: improvement(
        original.mean_input_chars,
        compact.mean_input_chars
      ),
      estimatedInputTokensReductionRatio: improvement(
        original.mean_estimated_input_tokens,
        compact.mean_estimated_input_tokens
      ),
      meanTtftImprovementRatio: improvement(
        original.mean_ttft_ms,
        compact.mean_ttft_ms
      ),
      meanGenerationImprovementRatio: improvement(
        original.mean_generation_latency_ms,
        compact.mean_generation_latency_ms
      ),
      meanTotalImprovementRatio,
      qualityRegressionPairs: pair.qualityRegressionPairs,
      citationRegressionPairs: pair.citationRegressionPairs,
      sourceIdRegressionPairs: pair.sourceIdRegressionPairs,
      lifecycleRegressionPairs: pair.lifecycleRegressionPairs,
      unsupportedRegressionPairs: pair.unsupportedRegressionPairs,
      ownerBoundaryRegressionPairs: pair.ownerBoundaryRegressionPairs,
      streamingRegressionPairs: pair.streamingRegressionPairs,
      compactProjectionFallbackRuns,
      sharedQualityFailureQuestions
    },
    regressions: pair.regressions,
    productionGray: {
      recommendation,
      reasons:
        reasons.length > 0
          ? reasons
          : [
              "All completed pairs preserved deterministic safety and quality checks",
              "A limited production gray remains subject to manual answer review"
            ]
    },
    limitations: [
      "Estimated tokens use ceil(characters / 2); Provider token usage is not available.",
      "Owner-boundary validation is limited to detecting invented local-speaker-to-global-identity mappings because retained current-scope data has no trusted global speaker identities.",
      "Preference and relationship semantic checks are deterministic dataset-specific concept coverage, not an LLM judge.",
      "Latency is Provider- and network-dependent; three rounds reduce but do not remove temporal variance.",
      "Three rounds create a 2:1 execution-direction split per question, so order and round effects remain partially confounded.",
      "This current-scope retained benchmark used zero long-term Memory-context entries; it exercised shared transcript, Audio Insight, Brief, and Relationship context instead.",
      "Compact item-level fallback_original is reported explicitly and is never counted as a projected item."
    ]
  };
}

export async function appendCompactEvidenceAbProgress(
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

export async function writeCompactEvidenceAbReport(
  path: string,
  report: CompactEvidenceAbReport
) {
  await atomicWrite(path, `${JSON.stringify(report, null, 2)}\n`);
}

export async function writeCompactEvidenceAbPartial(input: {
  path: string;
  status: "running" | "completed" | "failed";
  report: CompactEvidenceAbReport;
  completedRuns: number;
  totalRuns: number;
  currentRun?: Record<string, unknown> | null;
  error?: { name: string; code: string | null } | null;
}) {
  await atomicWrite(
    input.path,
    `${JSON.stringify(
      {
        status: input.status,
        updatedAt: new Date().toISOString(),
        completedRuns: input.completedRuns,
        totalRuns: input.totalRuns,
        currentRun: input.currentRun ?? null,
        error: input.error ?? null,
        report: {
          runs: input.report.runs.map((run) => ({
            run_id: run.run_id,
            question_id: run.question_id,
            evidence_view: run.evidence_view,
            execution_order: run.execution_order,
            status: run.status,
            input_chars: run.input_chars,
            ttft_ms: run.ttft_ms,
            generation_latency_ms: run.generation_latency_ms,
            total_latency_ms: run.total_latency_ms,
            fallback_status: run.fallback_status,
            streaming_outcome: run.streaming_outcome,
            quality_pass: run.quality?.finalQualityPass ?? null
          }))
        }
      },
      null,
      2
    )}\n`
  );
}

function metric(value: number | null) {
  return value === null ? "N/A" : value.toLocaleString("en-US");
}

function percent(value: number | null) {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

export function renderCompactEvidenceAbMarkdown(
  report: CompactEvidenceAbReport
) {
  const viewRows = CompactEvidenceAbViewSchema.options.map((view) => {
    const value = report.aggregates.byView[view];
    return `| ${view} | ${value.completed}/${value.runs} | ${metric(value.mean_input_chars)} | ${metric(value.mean_estimated_input_tokens)} | ${metric(value.mean_ttft_ms)} | ${metric(value.median_ttft_ms)} | ${metric(value.p95_ttft_ms)} | ${metric(value.mean_generation_latency_ms)} | ${metric(value.mean_total_latency_ms)} | ${value.quality_passed}/${value.completed} | ${value.fallbacks} | ${value.streaming_successes} | ${value.safe_fallbacks} |`;
  });
  const runRows = report.runs.map((run) =>
    `| ${run.question_id} | ${run.round} | ${run.evidence_view} | ${run.execution_order} | ${run.status} | ${metric(run.input_chars)} | ${metric(run.ttft_ms)} | ${metric(run.generation_latency_ms)} | ${metric(run.total_latency_ms)} | ${run.quality?.finalQualityPass === true ? "pass" : "fail"} | ${run.fallback_status} | ${run.streaming_outcome} |`
  );
  const regressionRows =
    report.regressions.length === 0
      ? ["| None | - | - | - |"]
      : report.regressions.map(
          (item) =>
            `| ${item.pair_id} | ${item.question_id} | ${item.round} | ${item.reasons.join(", ")} |`
        );
  return `# Compact Evidence A/B Report

## Scope

- Dataset: \`${report.dataset.datasetVersion}\`
- Questions: ${report.dataset.questionIds.join(", ")}
- Rounds: ${report.execution.rounds}
- Runs: ${report.runs.length}/${report.execution.totalRuns}
- Model: \`${report.runtime.modelId}\`
- Provider: \`${report.runtime.provider}\`
- Answer strategy: Agent QA
- Pair integrity: ${report.pairIntegrity.validPairs}/${report.pairIntegrity.totalPairs}
- Long-term Memory context entries: ${report.source.memoryContextCount}
- Token estimate: \`${report.execution.tokenEstimateMethod}\`

The only intended Provider-input difference is the Evidence block. Retrieval, canonical Evidence, system prompt, question, model, Agent strategy, final validation, citation mapping, and SentenceCommit allowlists remain shared.

## Aggregate performance and quality

| Evidence view | Completed | Mean input chars | Est. input tokens | Mean TTFT ms | Median TTFT ms | P95 TTFT ms | Mean generation ms | Mean total ms | Quality pass | Fallbacks | Streaming success | Safe fallback |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${viewRows.join("\n")}

## Relative change

- Input characters reduced: ${percent(report.comparison.inputCharsReductionRatio)}
- Estimated input tokens reduced: ${percent(report.comparison.estimatedInputTokensReductionRatio)}
- Mean TTFT improvement: ${percent(report.comparison.meanTtftImprovementRatio)}
- Mean generation improvement: ${percent(report.comparison.meanGenerationImprovementRatio)}
- Mean total latency improvement: ${percent(report.comparison.meanTotalImprovementRatio)}

## Quality and safety comparison

- Quality regression pairs: ${report.comparison.qualityRegressionPairs}
- Citation regression pairs: ${report.comparison.citationRegressionPairs}
- Source-ID regression pairs: ${report.comparison.sourceIdRegressionPairs}
- Lifecycle regression pairs: ${report.comparison.lifecycleRegressionPairs}
- Unsupported regression pairs: ${report.comparison.unsupportedRegressionPairs}
- Owner-boundary regression pairs: ${report.comparison.ownerBoundaryRegressionPairs}
- Streaming regression pairs: ${report.comparison.streamingRegressionPairs}
- Compact runs with projection fallback items: ${report.comparison.compactProjectionFallbackRuns}
- Shared quality-failure questions: ${report.comparison.sharedQualityFailureQuestions.length > 0 ? report.comparison.sharedQualityFailureQuestions.join(", ") : "none"}

## Per-run results

| Question | Round | View | Order | Status | Input chars | TTFT ms | Generation ms | Total ms | Quality | Fallback | Streaming |
| --- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
${runRows.join("\n")}

## Regression cases

| Pair | Question | Round | Reasons |
| --- | --- | ---: | --- |
${regressionRows.join("\n")}

## Production gray assessment

**${report.productionGray.recommendation}**

${report.productionGray.reasons.map((item) => `- ${item}`).join("\n")}

## Limitations

${report.limitations.map((item) => `- ${item}`).join("\n")}
`;
}

export async function writeCompactEvidenceAbMarkdown(
  path: string,
  report: CompactEvidenceAbReport
) {
  await atomicWrite(path, renderCompactEvidenceAbMarkdown(report));
}

export function compactEvidencePromptCharacters(
  evidence: QaRetrievedEvidence[],
  question: string
) {
  const projection = projectCompactEvidence({
    evidence,
    queryIntent: analyzeQaQueryIntent(question)
  });
  return {
    canonical: projection.originalChars,
    compact: compactEvidencePromptForEvaluation(projection).length,
    projection
  };
}

export { loadLongRecording60mBenchmarkSource, stableDigest, sha256 };
