import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import {
  AudioInsightSchema,
  AudioUploadSchema,
  BriefItemSchema,
  RelationshipSignalCardSchema,
  SemanticSegmentSchema,
  TranscriptSegmentSchema,
  type QuestionAnswer
} from "@/lib/domain/types";
import {
  applySpeakerAliasesToPayload,
  sanitizeSpeakerAliases,
  type StoredSpeakerAliases
} from "@/lib/domain/speaker-aliases";
import { VoiceQaContextSchema, type VoiceQaContext } from "@/lib/domain/voice-qa-context";
import {
  answerQuestionWithAI,
  type AnswerQuestionWithAIInput,
  type QaRetrievedEvidence
} from "@/lib/server/retrieval/ai-qa";
import type { QaExecutionDiagnostics } from "@/lib/server/retrieval/qa-observability";
import { JsonStore } from "@/lib/server/storage/json-store";
import { createMemoryVoiceQaAnswerer } from "@/lib/server/voice-qa/adapter";
import {
  optimizeVoiceResponse,
  voiceResponseSourceFromQuestionAnswer
} from "@/lib/server/voice-qa/response-optimizer";
import type { VoiceAnswerMode } from "@/lib/server/voice-qa/answer-strategy";

export const ANSWER_STRATEGY_AB_VERSION = 1;
export const ANSWER_STRATEGY_AB_SCHEDULE_VERSION = "seeded-counterbalanced-v1";

export const AnswerStrategyBenchmarkCategorySchema = z.enum([
  "fact",
  "relationship",
  "lifecycle",
  "preference",
  "ambiguous",
  "companion"
]);

export const AnswerStrategyBenchmarkQuestionSchema = z.object({
  id: z.string().regex(/^q\d{3}$/u),
  category: AnswerStrategyBenchmarkCategorySchema,
  question: z.string().trim().min(2).max(300),
  expected_scope: z.literal("current"),
  difficulty: z.enum(["easy", "medium", "hard"])
}).strict();

const REQUIRED_CATEGORY_COUNTS = {
  fact: 5,
  relationship: 8,
  lifecycle: 8,
  preference: 5,
  ambiguous: 1,
  companion: 4
} as const;

export const AnswerStrategyBenchmarkDatasetSchema = z
  .array(AnswerStrategyBenchmarkQuestionSchema)
  .min(30)
  .superRefine((questions, context) => {
    const ids = new Set<string>();
    for (const [index, question] of questions.entries()) {
      if (ids.has(question.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "id"],
          message: `Duplicate benchmark question id: ${question.id}`
        });
      }
      ids.add(question.id);
    }

    for (const [category, minimum] of Object.entries(REQUIRED_CATEGORY_COUNTS)) {
      const count = questions.filter((question) => question.category === category).length;
      if (count < minimum) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Benchmark category ${category} requires at least ${minimum} questions`
        });
      }
    }
  });

const RetainedBenchmarkUploadSchema = AudioUploadSchema.extend({
  evaluationRetention: z.boolean().optional()
});

export type AnswerStrategyBenchmarkQuestion = z.infer<
  typeof AnswerStrategyBenchmarkQuestionSchema
>;
export type AnswerStrategyBenchmarkCategory = z.infer<
  typeof AnswerStrategyBenchmarkCategorySchema
>;

export type AnswerStrategyBenchmarkPair = {
  pairId: string;
  round: number;
  question: AnswerStrategyBenchmarkQuestion;
  modes: [VoiceAnswerMode, VoiceAnswerMode];
};

export type AnswerStrategyManualScores = {
  factual_correctness: number | null;
  evidence_grounding: number | null;
  relationship_understanding: number | null;
  companion_quality: number | null;
  notes: string | null;
};

export type AnswerStrategyBenchmarkRun = {
  run_id: string;
  pair_id: string;
  round: number;
  question_id: string;
  category: AnswerStrategyBenchmarkCategory;
  difficulty: AnswerStrategyBenchmarkQuestion["difficulty"];
  answer_mode: VoiceAnswerMode;
  execution_order: 1 | 2;
  pair_order: "agent_first" | "direct_first";
  status: "completed" | "failed";
  total_latency_ms: number | null;
  generation_latency_ms: number | null;
  response_length: number;
  raw_response_length: number;
  evidence_count: number | null;
  evidence_digest: string | null;
  citation_count: number;
  cited_segment_count: number;
  citation_validation_passed: boolean | null;
  fallback_status: string;
  context_digest: string;
  memory_context_digest: string;
  answer_text: string | null;
  cited_segment_ids: string[];
  manual_scores: AnswerStrategyManualScores;
  error_name: string | null;
  error_code: string | null;
};

export type AnswerStrategyBenchmarkSource = {
  dataDir: string;
  userId: string;
  uploadId: string;
  context: VoiceQaContext;
  contextDigest: string;
  memoryContextDigest: string;
  contextCounts: {
    transcriptSegments: number;
    audioInsights: number;
    semanticSegments: number;
    briefItems: number;
    relationshipCards: number;
  };
};

type AnswerQuestionDelegate = typeof answerQuestionWithAI;

export type RunAnswerStrategyBenchmarkInput = {
  questions: AnswerStrategyBenchmarkQuestion[];
  source: AnswerStrategyBenchmarkSource;
  rounds: number;
  seed: string;
  remote: boolean;
  answerQuestion?: AnswerQuestionDelegate;
  now?: () => number;
  generatedAt?: () => string;
  logger?: Pick<Console, "info" | "warn">;
  onRunStart?: (input: {
    completedRuns: number;
    totalRuns: number;
    run: {
      runId: string;
      questionId: string;
      category: AnswerStrategyBenchmarkCategory;
      round: number;
      answerMode: VoiceAnswerMode;
      executionOrder: 1 | 2;
    };
    runs: readonly AnswerStrategyBenchmarkRun[];
  }) => unknown;
  onProgress?: (input: {
    completedRuns: number;
    totalRuns: number;
    run: AnswerStrategyBenchmarkRun;
    runs: readonly AnswerStrategyBenchmarkRun[];
  }) => unknown;
};

export type AnswerStrategyModeAggregate = {
  runs: number;
  completed: number;
  failed: number;
  fallbacks: number;
  mean_total_latency_ms: number | null;
  median_total_latency_ms: number | null;
  p95_total_latency_ms: number | null;
  mean_generation_latency_ms: number | null;
  mean_response_length: number | null;
  mean_evidence_count: number | null;
  mean_citation_count: number | null;
};

export type AnswerStrategyBenchmarkReport = {
  version: number;
  generatedAt: string;
  execution: {
    remote: boolean;
    remoteCalls: number;
    providerLatencyMeasured: boolean;
    rounds: number;
    seed: string;
    scheduleVersion: string;
    scheduleDigest: string;
    serialized: true;
  };
  dataset: {
    questionCount: number;
    distribution: Record<AnswerStrategyBenchmarkCategory, number>;
  };
  source: {
    datasetVersion: "long-recording-60m-v1";
    scope: "current";
    uploadRef: string;
    userRef: string;
    contextDigest: string;
    memoryContextDigest: string;
    memoryContextCount: 0;
    contextCounts: AnswerStrategyBenchmarkSource["contextCounts"];
  };
  runs: AnswerStrategyBenchmarkRun[];
  pairIntegrity: {
    totalPairs: number;
    validPairs: number;
    evidenceMismatchPairs: number;
    missingEvidenceDigestPairs: number;
  };
  aggregates: {
    byMode: Record<VoiceAnswerMode, AnswerStrategyModeAggregate>;
    byCategory: Record<
      AnswerStrategyBenchmarkCategory,
      Record<VoiceAnswerMode, AnswerStrategyModeAggregate>
    >;
  };
  manualReview: {
    scoringScale: "0-5";
    scoredRuns: number;
    winnerDeclared: false;
  };
  failures: Array<{
    run_id: string;
    question_id: string;
    answer_mode: VoiceAnswerMode;
    round: number;
    fallback_status: string;
    error_name: string | null;
    error_code: string | null;
  }>;
  integrity: {
    answerStrategyOnlyVariable: boolean;
    sameContextForAllRuns: boolean;
    sameMemoryContextForAllRuns: boolean;
    sameEvidenceWithinPairs: boolean;
    originalUploadMutated: false;
    memoryMutated: false;
  };
  limitations: string[];
};

const EMPTY_MANUAL_SCORES: AnswerStrategyManualScores = {
  factual_correctness: null,
  evidence_grounding: null,
  relationship_understanding: null,
  companion_quality: null,
  notes: null
};

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, child]) => [key, stableValue(child)])
  );
}

export function stableDigest(value: unknown) {
  return sha256(JSON.stringify(stableValue(value)));
}

function evidenceDigest(evidence: QaRetrievedEvidence[]) {
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

function baseFirstMode(seed: string, questionId: string): VoiceAnswerMode {
  return createHash("sha256")
    .update(`${seed}:${questionId}`)
    .digest()[0]! % 2 === 0
    ? "agent"
    : "direct";
}

export function createAnswerStrategyBenchmarkSchedule(
  questions: AnswerStrategyBenchmarkQuestion[],
  rounds: number,
  seed: string
): AnswerStrategyBenchmarkPair[] {
  if (!Number.isInteger(rounds) || rounds < 3) {
    throw new Error("Answer strategy benchmark requires at least 3 rounds");
  }
  const normalizedSeed = seed.trim();
  if (!normalizedSeed) throw new Error("Answer strategy benchmark seed is required");

  return Array.from({ length: rounds }, (_, index) => index + 1).flatMap((round) =>
    shuffled(questions, `${normalizedSeed}:round:${round}`).map((question) => {
      const base = baseFirstMode(normalizedSeed, question.id);
      const first = round % 2 === 0 ? (base === "agent" ? "direct" : "agent") : base;
      const second = first === "agent" ? "direct" : "agent";
      return {
        pairId: `r${String(round).padStart(2, "0")}-${question.id}`,
        round,
        question,
        modes: [first, second]
      };
    })
  );
}

export async function loadAnswerStrategyBenchmarkDataset(filePath: string) {
  const raw = await readFile(resolve(filePath), "utf8");
  return AnswerStrategyBenchmarkDatasetSchema.parse(JSON.parse(raw));
}

function redactedReference(value: string) {
  return `${value.slice(0, 8)}-${sha256(value).slice(0, 12)}`;
}

export async function loadLongRecording60mBenchmarkSource(input: {
  dataDir: string;
  userId: string;
  uploadId: string;
}): Promise<AnswerStrategyBenchmarkSource> {
  const dataDir = resolve(input.dataDir);
  const userRoot = resolve(dataDir, "users", input.userId);
  const store = new JsonStore(userRoot);
  const upload = RetainedBenchmarkUploadSchema.parse(
    await store.read("uploads", input.uploadId)
  );
  if (upload.status !== "ready") throw new Error("Benchmark upload must be ready");
  if (upload.evaluationRetention !== true) {
    throw new Error("Benchmark upload must have evaluation retention enabled");
  }

  const [segments, audioInsights, semanticSegments, briefItems, relationshipSignals, aliases] =
    await Promise.all([
      store.read("segments", input.uploadId).then((value) => z.array(TranscriptSegmentSchema).parse(value)),
      store.read("audio-insights", input.uploadId).then((value) => z.array(AudioInsightSchema).parse(value)),
      store.read("semantic-segments", input.uploadId).then((value) => z.array(SemanticSegmentSchema).parse(value)),
      store.read("brief-items", input.uploadId).then((value) => z.array(BriefItemSchema).parse(value)),
      store.read("relationship-signals", input.uploadId).then((value) => z.array(RelationshipSignalCardSchema).parse(value)),
      store.read<StoredSpeakerAliases>("speaker-aliases", input.uploadId)
    ]);
  const aliased = applySpeakerAliasesToPayload(
    { segments, audioInsights, semanticSegments, briefItems },
    sanitizeSpeakerAliases(aliases?.aliases ?? {})
  );
  const context = VoiceQaContextSchema.parse({
    contextId: input.uploadId,
    segments: aliased.segments,
    audioInsights: aliased.audioInsights ?? [],
    semanticSegments: aliased.semanticSegments ?? [],
    briefItems: aliased.briefItems,
    relationshipSignals
  });

  return {
    dataDir,
    userId: input.userId,
    uploadId: input.uploadId,
    context,
    contextDigest: stableDigest(context),
    memoryContextDigest: stableDigest({ scope: "current", memories: [] }),
    contextCounts: {
      transcriptSegments: context.segments.length,
      audioInsights: context.audioInsights.length,
      semanticSegments: context.semanticSegments.length,
      briefItems: context.briefItems.length,
      relationshipCards: context.relationshipSignals.length
    }
  };
}

function elapsedMs(startedAt: number, now: () => number) {
  return Math.max(0, Math.round(now() - startedAt));
}

function errorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z0-9_-]{1,80}$/u.test(code) ? code : null;
}

function pairOrder(modes: [VoiceAnswerMode, VoiceAnswerMode]) {
  return modes[0] === "agent" ? "agent_first" as const : "direct_first" as const;
}

function validCitations(answer: QuestionAnswer, evidence: QaRetrievedEvidence[]) {
  const allowed = new Set(evidence.flatMap((item) => item.sourceSegmentIds));
  return answer.citedSegmentIds.every((id) => allowed.has(id));
}

async function runOne(input: {
  source: AnswerStrategyBenchmarkSource;
  pair: AnswerStrategyBenchmarkPair;
  mode: VoiceAnswerMode;
  order: 1 | 2;
  answerQuestion: AnswerQuestionDelegate;
  now: () => number;
}): Promise<AnswerStrategyBenchmarkRun> {
  let diagnostics: QaExecutionDiagnostics | undefined;
  let retrievedEvidence: QaRetrievedEvidence[] | undefined;
  const instrumentedDelegate: AnswerQuestionDelegate = async (qaInput) => {
    const instrumented = Object.create(
      Object.getPrototypeOf(qaInput),
      Object.getOwnPropertyDescriptors(qaInput)
    ) as AnswerQuestionWithAIInput;
    Object.defineProperty(instrumented, "onRetrievedEvidence", {
      value: (evidence: QaRetrievedEvidence[]) => {
        retrievedEvidence = evidence;
      },
      enumerable: false,
      configurable: true
    });
    return input.answerQuestion(instrumented);
  };
  const store = new JsonStore(resolve(input.source.dataDir, "users", input.source.userId));
  const answerer = createMemoryVoiceQaAnswerer({
    userId: input.source.userId,
    store,
    scope: "current",
    uploadId: input.source.uploadId,
    context: input.source.context,
    answerMode: input.mode,
    dependencies: { answerQuestionWithAI: instrumentedDelegate }
  });
  const startedAt = input.now();
  const base = {
    run_id: `${input.pair.pairId}-${input.mode}`,
    pair_id: input.pair.pairId,
    round: input.pair.round,
    question_id: input.pair.question.id,
    category: input.pair.question.category,
    difficulty: input.pair.question.difficulty,
    answer_mode: input.mode,
    execution_order: input.order,
    pair_order: pairOrder(input.pair.modes),
    context_digest: input.source.contextDigest,
    memory_context_digest: input.source.memoryContextDigest,
    manual_scores: { ...EMPTY_MANUAL_SCORES }
  };

  try {
    const answer = await answerer.answer({
      sessionId: `benchmark-${input.pair.pairId}-${input.mode}`,
      transcript: input.pair.question.question,
      userId: input.source.userId,
      scope: "current",
      uploadId: input.source.uploadId,
      mode: "VOICE",
      onQaDiagnostics: (value) => {
        diagnostics = value;
      }
    });
    if (!answer) throw new Error("Benchmark answerer returned no answer");
    const optimized = optimizeVoiceResponse({
      responseMode: "VOICE",
      response: voiceResponseSourceFromQuestionAnswer(answer)
    });
    const evidence = retrievedEvidence ?? [];
    return {
      ...base,
      status: "completed",
      total_latency_ms: elapsedMs(startedAt, input.now),
      generation_latency_ms: diagnostics?.llmGenerationMs ?? null,
      response_length: optimized.spoken_text.length,
      raw_response_length: answer.answer.length,
      evidence_count: diagnostics?.evidenceCount ?? evidence.length,
      evidence_digest: retrievedEvidence ? evidenceDigest(evidence) : null,
      citation_count: answer.citations?.length ?? 0,
      cited_segment_count: answer.citedSegmentIds.length,
      citation_validation_passed: retrievedEvidence ? validCitations(answer, evidence) : null,
      fallback_status: diagnostics?.fallbackReason ?? "diagnostics_unavailable",
      answer_text: answer.answer,
      cited_segment_ids: [...answer.citedSegmentIds],
      error_name: null,
      error_code: null
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      total_latency_ms: elapsedMs(startedAt, input.now),
      generation_latency_ms: diagnostics?.llmGenerationMs ?? null,
      response_length: 0,
      raw_response_length: 0,
      evidence_count: diagnostics?.evidenceCount ?? retrievedEvidence?.length ?? null,
      evidence_digest: retrievedEvidence ? evidenceDigest(retrievedEvidence) : null,
      citation_count: 0,
      cited_segment_count: 0,
      citation_validation_passed: null,
      fallback_status: diagnostics?.fallbackReason ?? "execution_error",
      answer_text: null,
      cited_segment_ids: [],
      error_name: error instanceof Error && error.name ? error.name : "unknown",
      error_code: errorCode(error)
    };
  }
}

function mean(values: number[]) {
  return values.length === 0
    ? null
    : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index] ?? null;
}

function aggregate(runs: AnswerStrategyBenchmarkRun[]): AnswerStrategyModeAggregate {
  const completed = runs.filter((run) => run.status === "completed");
  const totalLatency = completed.flatMap((run) =>
    run.total_latency_ms === null ? [] : [run.total_latency_ms]
  );
  const generationLatency = completed.flatMap((run) =>
    run.generation_latency_ms === null ? [] : [run.generation_latency_ms]
  );
  const evidenceCounts = completed.flatMap((run) =>
    run.evidence_count === null ? [] : [run.evidence_count]
  );
  return {
    runs: runs.length,
    completed: completed.length,
    failed: runs.length - completed.length,
    fallbacks: completed.filter((run) => run.fallback_status !== "none").length,
    mean_total_latency_ms: mean(totalLatency),
    median_total_latency_ms: percentile(totalLatency, 0.5),
    p95_total_latency_ms: percentile(totalLatency, 0.95),
    mean_generation_latency_ms: mean(generationLatency),
    mean_response_length: mean(completed.map((run) => run.response_length)),
    mean_evidence_count: mean(evidenceCounts),
    mean_citation_count: mean(completed.map((run) => run.citation_count))
  };
}

export function buildAnswerStrategyBenchmarkReport(input: {
  questions: AnswerStrategyBenchmarkQuestion[];
  source: AnswerStrategyBenchmarkSource;
  rounds: number;
  seed: string;
  remote: boolean;
  schedule: AnswerStrategyBenchmarkPair[];
  runs: AnswerStrategyBenchmarkRun[];
  generatedAt: string;
}): AnswerStrategyBenchmarkReport {
  const distribution = Object.fromEntries(
    AnswerStrategyBenchmarkCategorySchema.options.map((category) => [
      category,
      input.questions.filter((question) => question.category === category).length
    ])
  ) as Record<AnswerStrategyBenchmarkCategory, number>;
  const pairRuns = new Map<string, AnswerStrategyBenchmarkRun[]>();
  for (const run of input.runs) {
    pairRuns.set(run.pair_id, [...(pairRuns.get(run.pair_id) ?? []), run]);
  }
  const pairs = [...pairRuns.values()];
  const missingEvidenceDigestPairs = pairs.filter(
    (runs) => runs.length !== 2 || runs.some((run) => !run.evidence_digest)
  ).length;
  const evidenceMismatchPairs = pairs.filter((runs) => {
    if (runs.length !== 2 || runs.some((run) => !run.evidence_digest)) return false;
    return runs[0]?.evidence_digest !== runs[1]?.evidence_digest;
  }).length;
  const validPairs = pairs.length - missingEvidenceDigestPairs - evidenceMismatchPairs;
  const byCategory = Object.fromEntries(
    AnswerStrategyBenchmarkCategorySchema.options.map((category) => [
      category,
      {
        agent: aggregate(input.runs.filter(
          (run) => run.category === category && run.answer_mode === "agent"
        )),
        direct: aggregate(input.runs.filter(
          (run) => run.category === category && run.answer_mode === "direct"
        ))
      }
    ])
  ) as AnswerStrategyBenchmarkReport["aggregates"]["byCategory"];

  return {
    version: ANSWER_STRATEGY_AB_VERSION,
    generatedAt: input.generatedAt,
    execution: {
      remote: input.remote,
      remoteCalls: input.remote ? input.runs.length : 0,
      providerLatencyMeasured: input.remote,
      rounds: input.rounds,
      seed: input.seed,
      scheduleVersion: ANSWER_STRATEGY_AB_SCHEDULE_VERSION,
      scheduleDigest: stableDigest(input.schedule.map((pair) => ({
        pairId: pair.pairId,
        questionId: pair.question.id,
        modes: pair.modes
      }))),
      serialized: true
    },
    dataset: { questionCount: input.questions.length, distribution },
    source: {
      datasetVersion: "long-recording-60m-v1",
      scope: "current",
      uploadRef: redactedReference(input.source.uploadId),
      userRef: redactedReference(input.source.userId),
      contextDigest: input.source.contextDigest,
      memoryContextDigest: input.source.memoryContextDigest,
      memoryContextCount: 0,
      contextCounts: input.source.contextCounts
    },
    runs: input.runs,
    pairIntegrity: {
      totalPairs: pairs.length,
      validPairs,
      evidenceMismatchPairs,
      missingEvidenceDigestPairs
    },
    aggregates: {
      byMode: {
        agent: aggregate(input.runs.filter((run) => run.answer_mode === "agent")),
        direct: aggregate(input.runs.filter((run) => run.answer_mode === "direct"))
      },
      byCategory
    },
    manualReview: {
      scoringScale: "0-5",
      scoredRuns: 0,
      winnerDeclared: false
    },
    failures: input.runs
      .filter((run) =>
        run.status === "failed" ||
        run.fallback_status !== "none" ||
        run.citation_validation_passed === false
      )
      .map((run) => ({
        run_id: run.run_id,
        question_id: run.question_id,
        answer_mode: run.answer_mode,
        round: run.round,
        fallback_status: run.fallback_status,
        error_name: run.error_name,
        error_code: run.error_code
      })),
    integrity: {
      answerStrategyOnlyVariable: true,
      sameContextForAllRuns: input.runs.every(
        (run) => run.context_digest === input.source.contextDigest
      ),
      sameMemoryContextForAllRuns: input.runs.every(
        (run) => run.memory_context_digest === input.source.memoryContextDigest
      ),
      sameEvidenceWithinPairs: evidenceMismatchPairs === 0 && missingEvidenceDigestPairs === 0,
      originalUploadMutated: false,
      memoryMutated: false
    },
    limitations: [
      "Current-scope provided context does not query the SQLite long-term Memory index; both modes share the same empty current-memory context.",
      "Human quality score fields are intentionally null until a reviewer scores the synthetic-data answers.",
      "Provider latency varies with external queueing; three rounds reduce but do not eliminate that variance.",
      "Answer text is retained only because this benchmark uses a synthetic dialogue and requires manual review; raw transcript and evidence text are not copied into the report."
    ]
  };
}

export async function runAnswerStrategyBenchmark(
  input: RunAnswerStrategyBenchmarkInput
): Promise<AnswerStrategyBenchmarkReport> {
  if (!input.remote && !input.answerQuestion) {
    throw new Error("Offline answer strategy benchmark requires an injected answerQuestion delegate");
  }
  const questions = AnswerStrategyBenchmarkDatasetSchema.parse(input.questions);
  const schedule = createAnswerStrategyBenchmarkSchedule(
    questions,
    input.rounds,
    input.seed
  );
  const answerQuestion = input.answerQuestion ?? answerQuestionWithAI;
  const now = input.now ?? (() => performance.now());
  const generatedAt = input.generatedAt ?? (() => new Date().toISOString());
  const logger = input.logger ?? console;
  const runs: AnswerStrategyBenchmarkRun[] = [];
  const totalRuns = schedule.length * 2;

  for (const pair of schedule) {
    for (const [index, mode] of pair.modes.entries()) {
      const executionOrder = (index + 1) as 1 | 2;
      await input.onRunStart?.({
        completedRuns: runs.length,
        totalRuns,
        run: {
          runId: `${pair.pairId}-${mode}`,
          questionId: pair.question.id,
          category: pair.question.category,
          round: pair.round,
          answerMode: mode,
          executionOrder
        },
        runs: [...runs]
      });
      const run = await runOne({
        source: input.source,
        pair,
        mode,
        order: executionOrder,
        answerQuestion,
        now
      });
      runs.push(run);
      const logPayload = {
        question_id: run.question_id,
        category: run.category,
        round: run.round,
        answer_mode: run.answer_mode,
        execution_order: run.execution_order,
        status: run.status,
        total_latency_ms: run.total_latency_ms,
        generation_latency_ms: run.generation_latency_ms,
        response_length: run.response_length,
        evidence_count: run.evidence_count,
        citation_count: run.citation_count,
        fallback_status: run.fallback_status
      };
      if (run.status === "completed") {
        logger.info(`ANSWER_STRATEGY_AB: ${JSON.stringify(logPayload)}`);
      } else {
        logger.warn(`ANSWER_STRATEGY_AB: ${JSON.stringify(logPayload)}`);
      }
      await input.onProgress?.({
        completedRuns: runs.length,
        totalRuns,
        run,
        runs: [...runs]
      });
    }
  }

  return buildAnswerStrategyBenchmarkReport({
    questions,
    source: input.source,
    rounds: input.rounds,
    seed: input.seed,
    remote: input.remote,
    schedule,
    runs,
    generatedAt: generatedAt()
  });
}

function pathIsInside(childPath: string, parentPath: string) {
  const relation = relative(resolve(parentPath), resolve(childPath));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

export function assertAnswerStrategyBenchmarkOutputPaths(input: {
  dataDir: string;
  reportPath: string;
  docsPath: string;
  progressPath: string;
  partialReportPath: string;
}) {
  const targets = [
    input.reportPath,
    input.docsPath,
    input.progressPath,
    input.partialReportPath
  ].map((target) => resolve(target));
  if (new Set(targets.map((target) => target.toLowerCase())).size !== targets.length) {
    throw new Error("Answer strategy benchmark output paths must be distinct");
  }
  for (const target of targets) {
    if (pathIsInside(target, input.dataDir)) {
      throw new Error("Answer strategy benchmark outputs must be outside retained runtime data");
    }
  }
}

export async function writeAnswerStrategyBenchmarkReport(
  reportPath: string,
  report: AnswerStrategyBenchmarkReport,
  dataDir: string
) {
  const target = resolve(reportPath);
  if (pathIsInside(target, dataDir)) {
    throw new Error("Answer strategy benchmark report must be outside retained runtime data");
  }
  await mkdir(dirname(target), { recursive: true });
  const temporaryPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await rename(temporaryPath, target);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function answerStrategyBenchmarkProgressPaths(reportPath: string) {
  const target = resolve(reportPath);
  const stem = target.endsWith(".json") ? target.slice(0, -".json".length) : target;
  return {
    progressPath: `${stem}.progress.jsonl`,
    partialReportPath: `${stem}.partial.json`
  };
}

export type AnswerStrategyBenchmarkProgressEvent =
  | {
    event: "benchmark_started";
    at: string;
    completed_runs: 0;
    total_runs: number;
  }
  | {
    event: "run_started";
    at: string;
    completed_runs: number;
    total_runs: number;
    run_id: string;
    question_id: string;
    category: AnswerStrategyBenchmarkCategory;
    round: number;
    answer_mode: VoiceAnswerMode;
    execution_order: 1 | 2;
  }
  | {
    event: "run_completed";
    at: string;
    completed_runs: number;
    total_runs: number;
    question_id: string;
    category: AnswerStrategyBenchmarkCategory;
    round: number;
    answer_mode: VoiceAnswerMode;
    execution_order: 1 | 2;
    status: AnswerStrategyBenchmarkRun["status"];
    total_latency_ms: number | null;
    generation_latency_ms: number | null;
    evidence_count: number | null;
    citation_count: number;
    fallback_status: string;
  }
  | {
    event: "benchmark_completed";
    at: string;
    completed_runs: number;
    total_runs: number;
    failed_runs: number;
    fallback_runs: number;
    citation_violation_runs: number;
  }
  | {
    event: "benchmark_failed";
    at: string;
    completed_runs: number;
    total_runs: number;
    error_name: string;
    error_code: string | null;
  };

export async function appendAnswerStrategyBenchmarkProgress(
  progressPath: string,
  event: AnswerStrategyBenchmarkProgressEvent
) {
  const target = resolve(progressPath);
  await mkdir(dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(event)}\n`, "utf8");
}

export async function writeAnswerStrategyBenchmarkPartialReport(input: {
  partialReportPath: string;
  report: AnswerStrategyBenchmarkReport;
  completedRuns: number;
  totalRuns: number;
  status: "running" | "completed" | "failed";
  updatedAt: string;
  currentRun?: {
    run_id: string;
    question_id: string;
    category: AnswerStrategyBenchmarkCategory;
    round: number;
    answer_mode: VoiceAnswerMode;
    execution_order: 1 | 2;
    started_at: string;
  } | null;
  error?: {
    error_name: string;
    error_code: string | null;
  } | null;
}) {
  const target = resolve(input.partialReportPath);
  await mkdir(dirname(target), { recursive: true });
  const temporaryPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const monitoringRuns = input.report.runs.map((run) => ({
    run_id: run.run_id,
    question_id: run.question_id,
    category: run.category,
    round: run.round,
    answer_mode: run.answer_mode,
    execution_order: run.execution_order,
    status: run.status,
    total_latency_ms: run.total_latency_ms,
    generation_latency_ms: run.generation_latency_ms,
    response_length: run.response_length,
    evidence_count: run.evidence_count,
    citation_count: run.citation_count,
    citation_validation_passed: run.citation_validation_passed,
    fallback_status: run.fallback_status,
    error_name: run.error_name,
    error_code: run.error_code
  }));
  try {
    await writeFile(temporaryPath, `${JSON.stringify({
      status: input.status,
      updatedAt: input.updatedAt,
      completedRuns: input.completedRuns,
      totalRuns: input.totalRuns,
      currentRun: input.currentRun ?? null,
      error: input.error ?? null,
      report: { runs: monitoringRuns }
    }, null, 2)}\n`, "utf8");
    await rename(temporaryPath, target);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function metric(value: number | null) {
  return value === null ? "N/A" : value.toLocaleString("en-US");
}

export function renderAnswerStrategyBenchmarkMarkdown(report: AnswerStrategyBenchmarkReport) {
  const failedRuns = report.runs.filter((run) => run.status === "failed").length;
  const fallbackRuns = report.runs.filter(
    (run) => run.status === "completed" && run.fallback_status !== "none"
  ).length;
  const citationViolationRuns = report.runs.filter(
    (run) => run.citation_validation_passed === false
  ).length;
  const slowestRun = report.runs
    .filter((run) => run.total_latency_ms !== null)
    .sort((left, right) => right.total_latency_ms! - left.total_latency_ms!)[0];
  const modeRows = (["agent", "direct"] as const).map((mode) => {
    const value = report.aggregates.byMode[mode];
    return `| ${mode} | ${value.completed}/${value.runs} | ${metric(value.mean_total_latency_ms)} | ${metric(value.median_total_latency_ms)} | ${metric(value.p95_total_latency_ms)} | ${metric(value.mean_generation_latency_ms)} | ${value.fallbacks} |`;
  });
  const categoryRows = AnswerStrategyBenchmarkCategorySchema.options.flatMap((category) =>
    (["agent", "direct"] as const).map((mode) => {
      const value = report.aggregates.byCategory[category][mode];
      return `| ${category} | ${mode} | ${value.completed}/${value.runs} | ${metric(value.mean_total_latency_ms)} | ${metric(value.mean_generation_latency_ms)} | ${metric(value.mean_citation_count)} |`;
    })
  );
  return `# Agent QA vs Direct Context A/B Results

## Test scope

- Dataset: \`long-recording-60m-v1\`
- Questions: ${report.dataset.questionCount}
- Rounds: ${report.execution.rounds}
- Total executions: ${report.runs.length}
- Execution: ${report.execution.remote ? "real remote QA Provider, serialized" : "offline/mock only"}
- Scope: current
- Context: ${report.source.contextCounts.transcriptSegments} transcript segments, ${report.source.contextCounts.audioInsights} Audio Insights, ${report.source.contextCounts.semanticSegments} semantic segments, ${report.source.contextCounts.briefItems} Brief items, ${report.source.contextCounts.relationshipCards} Relationship Cards
- Pair integrity: ${report.pairIntegrity.validPairs}/${report.pairIntegrity.totalPairs} pairs have matching evidence digests

The schedule uses a seeded, counterbalanced order. Each question runs in both orders across three rounds. Agent and Direct share the same immutable retained context, deterministic evidence retrieval, model configuration, citation validation, Relationship boundaries, and response optimizer. The answer strategy is the intended variable.

Current-scope provided-context QA does not query the SQLite long-term Memory index, so both modes share the same empty current-memory context. This result must not be generalized to week/all Memory retrieval.

## Overall performance

| Mode | Completed | Mean total ms | Median total ms | P95 total ms | Mean generation ms | Fallbacks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${modeRows.join("\n")}

## Category breakdown

| Category | Mode | Completed | Mean total ms | Mean generation ms | Mean citations |
| --- | --- | ---: | ---: | ---: | ---: |
${categoryRows.join("\n")}

## Grounding and failures

- Evidence digest mismatches: ${report.pairIntegrity.evidenceMismatchPairs}
- Missing evidence digests: ${report.pairIntegrity.missingEvidenceDigestPairs}
- Failed executions: ${failedRuns}
- Fallback responses: ${fallbackRuns}
- Citation validation violations: ${citationViolationRuns}
- Manual quality scores completed: ${report.manualReview.scoredRuns}/${report.runs.length}

No strategy winner is declared automatically. Factual correctness, evidence grounding, relationship understanding, and companion quality remain manual 0–5 fields in the JSON report.

## Latency distribution note

${slowestRun ? `The slowest retained call was \`${slowestRun.run_id}\` (${slowestRun.answer_mode}, ${slowestRun.category}) at ${metric(slowestRun.total_latency_ms)} ms.` : "No completed latency sample is available."} Means include every real call, including Provider queueing and retry long tails; inspect median, P95, and individual runs before interpreting a mean difference.

## Live progress monitoring

The runner writes an append-only \`*.progress.jsonl\` event log and atomically replaces a \`*.partial.json\` snapshot after every completed provider call. These files make completed work observable even when the terminal buffers stdout.

Use a one-shot status check:

~~~powershell
npm run answer-strategy:benchmark:status
~~~

Or keep a local terminal watching the partial report:

~~~powershell
npm run answer-strategy:benchmark:status -- --watch
~~~

The status includes completed and total runs, per-mode counts, failures, fallbacks, mean latency, ETA, and seconds since the last completed call. A growing \`stale_for_seconds\` value identifies a slow or stalled provider request without exposing questions, answers, evidence text, or credentials.

## Follow-up

1. Review all answer pairs blind to mode and fill the four manual score fields.
2. Inspect failures and fallback cases before comparing aggregate latency.
3. Repeat on week/all scopes with a separately frozen non-empty Memory context before drawing conclusions about long-term Memory QA.
4. Treat Provider latency as environment-specific; keep the serialized randomized schedule for future comparisons.
`;
}

export async function writeAnswerStrategyBenchmarkMarkdown(
  docsPath: string,
  report: AnswerStrategyBenchmarkReport
) {
  const target = resolve(docsPath);
  await mkdir(dirname(target), { recursive: true });
  const temporaryPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, renderAnswerStrategyBenchmarkMarkdown(report), "utf8");
    await rename(temporaryPath, target);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
