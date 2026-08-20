import { createHash } from "node:crypto";

import { z } from "zod";

import {
  createQaSelectedEvidenceEvaluationSession,
  noProviderQaAnswerForEvaluation,
  prepareQaSelectedEvidenceForEvaluation,
  qaSelectedEvidenceCitationValidityForEvaluation,
  retrieveQaEvidenceWithDiagnostics,
  type AnswerQuestionWithAIInput,
  type QaRetrievedEvidence,
  type QaSelectedEvidenceEvaluationSession
} from "@/lib/server/retrieval/ai-qa";
import type { JsonStore } from "@/lib/server/storage/json-store";
import type { EmbeddingProvider } from "@/lib/server/retrieval/hybrid/embedding-provider";
import {
  QWEN3_EMBEDDING_4B_DIMENSION,
  QWEN3_EMBEDDING_4B_MODEL,
  QWEN3_EMBEDDING_4B_REVISION
} from "@/lib/server/retrieval/hybrid/runtime-config";
import {
  VOICE_QA_SHADOW_CANONICAL_EVIDENCE_VERSION,
  runVoiceQaShadowReviewRetrieval,
  type VoiceQaShadowReviewReplayInput,
  type VoiceQaShadowReviewRetrievalSnapshot
} from "./voice-qa-shadow-review";
import {
  VOICE_QA_SHADOW_REQUIRED_FAULT_SCENARIOS,
  VoiceQaShadowReviewRepository,
  hashVoiceQaShadowReviewText,
  type StoredVoiceQaShadowReviewCase,
  type StoredVoiceQaShadowReviewCaseBundle,
  type VoiceQaShadowReviewCaseStatus,
  type VoiceQaShadowReviewSystem
} from "./voice-qa-shadow-review-repository";
import { buildVoiceQaShadowReviewReports } from "./voice-qa-shadow-review-export";

const IDENTIFIER = /^[A-Za-z0-9_.:@/-]{1,512}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CASE_TERMINAL_STATUS = z.enum(["valid", "invalid", "ambiguous"]);
const SYSTEM = z.enum(["A", "B"]);
const ANSWER_LABEL = z.enum(["X", "Y"]);
const REVIEW_SCORE = z.number().min(0).max(4);
export const VOICE_QA_SHADOW_NO_PROVIDER_MODEL =
  "no_provider_prompt";
const BLIND_MAPPING_VERSION = "voice_qa_shadow_blind_mapping_v1";

const QuestionAttachmentSchema = z.object({
  caseId: z.string().regex(IDENTIFIER).optional(),
  traceId: z.string().regex(IDENTIFIER).optional(),
  expectedText: z.string().min(1),
  expectedTextHash: z.string().regex(SHA256).optional(),
  audioSha256: z.string().regex(SHA256),
  audioDurationMs: z.number().nonnegative(),
  sourceKind: z.enum(["real_microphone", "synthetic_voice", "recorded_holdout"]),
  metadata: z.unknown().optional(),
  status: CASE_TERMINAL_STATUS,
  invalidReason: z.string().min(1).nullable().optional()
}).superRefine((value, context) => {
  if (Boolean(value.caseId) === Boolean(value.traceId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "exactly one of caseId or traceId is required"
    });
  }
  if (value.status === "invalid" && !value.invalidReason) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "invalid status requires invalidReason"
    });
  }
});

const QuestionImportSchema = z.object({
  version: z.literal(1),
  cases: z.array(QuestionAttachmentSchema).min(1)
});

const GoldEntrySchema = z.object({
  caseId: z.string().regex(IDENTIFIER),
  status: z.enum(["evaluable", "ambiguous", "excluded"]),
  evidenceGroups: z.array(z.array(z.string().regex(IDENTIFIER)).min(1)),
  requiredFacts: z.array(z.string().min(1)),
  shouldRefuse: z.boolean(),
  categories: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u)).optional(),
  reviewerId: z.string().regex(IDENTIFIER).nullable().optional(),
  notes: z.string().nullable().optional()
});

const GoldImportSchema = z.object({
  version: z.literal(1),
  cases: z.array(GoldEntrySchema).min(1)
});

const BlindAnswerSchema = z.object({
  caseId: z.string().regex(IDENTIFIER),
  round: z.union([z.literal(1), z.literal(2)]),
  label: ANSWER_LABEL,
  system: SYSTEM,
  answerText: z.string(),
  citations: z.unknown(),
  citationValidity: z.boolean(),
  model: z.string().regex(IDENTIFIER),
  generationLatencyMs: z.number().nonnegative().nullable().optional(),
  promptTemplateFingerprint: z.string().regex(IDENTIFIER),
  codeFingerprint: z.string().regex(IDENTIFIER),
  inputHash: z.string().regex(SHA256),
  evidenceIds: z.array(z.string().regex(IDENTIFIER)).max(16)
});

const BlindReviewSchema = z.object({
  caseId: z.string().regex(IDENTIFIER),
  round: z.union([z.literal(1), z.literal(2)]),
  label: ANSWER_LABEL,
  scores: z.object({
    factualCorrectness: REVIEW_SCORE,
    completeness: REVIEW_SCORE,
    citationSupport: REVIEW_SCORE,
    uncertainty: REVIEW_SCORE,
    directness: REVIEW_SCORE
  }).strict(),
  hardViolations: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,127}$/u)),
  outcome: z.enum(["win", "tie", "loss", "unscored"]),
  reviewerId: z.string().regex(IDENTIFIER).nullable().optional()
});

const BlindImportSchema = z.object({
  version: z.literal(1),
  answers: z.array(BlindAnswerSchema).optional(),
  reviews: z.array(BlindReviewSchema).optional()
}).superRefine((value, context) => {
  if ((value.answers?.length ?? 0) + (value.reviews?.length ?? 0) === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "answers or reviews are required"
    });
  }
});

const FaultEntrySchema = z.object({
  faultRunId: z.string().regex(IDENTIFIER),
  caseId: z.string().regex(IDENTIFIER).nullable().optional(),
  scenario: z.enum(VOICE_QA_SHADOW_REQUIRED_FAULT_SCENARIOS),
  status: z.enum(["completed", "failed", "aborted"]),
  shadowError: z.string().nullable().optional(),
  expectedOfficialAnswerHash: z.string().regex(SHA256).nullable().optional(),
  actualOfficialAnswerHash: z.string().regex(SHA256).nullable().optional(),
  expectedCitationHash: z.string().regex(SHA256).nullable().optional(),
  actualCitationHash: z.string().regex(SHA256).nullable().optional(),
  voiceUninterrupted: z.boolean().nullable().optional(),
  lexicalFailOpen: z.boolean().nullable().optional(),
  citationsValid: z.boolean().nullable().optional(),
  shadowLatencyMs: z.number().nonnegative().nullable().optional(),
  metadata: z.unknown().optional()
});

const FaultImportSchema = z.object({
  version: z.literal(1),
  runs: z.array(FaultEntrySchema).min(1)
});

type RunRetrieval = typeof runVoiceQaShadowReviewRetrieval;

export type VoiceQaShadowReplayFailure = {
  caseId: string;
  missing: string[];
};

export class VoiceQaShadowReplayPreconditionError extends Error {
  readonly caseId: string;
  readonly missing: string[];

  constructor(caseId: string, missing: string[]) {
    super(
      `Replay preconditions are incomplete for case ${caseId}: ` +
      missing.join(",")
    );
    this.name = "VoiceQaShadowReplayPreconditionError";
    this.caseId = caseId;
    this.missing = [...missing];
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function updateCaseStatus(
  repository: VoiceQaShadowReviewRepository,
  reviewCase: StoredVoiceQaShadowReviewCase,
  status: Exclude<VoiceQaShadowReviewCaseStatus, "pending">,
  invalidReason: string | null
) {
  return repository.upsertCase({
    ...caseInputFromStored(reviewCase),
    status,
    invalidReason
  });
}

function caseInputFromStored(reviewCase: StoredVoiceQaShadowReviewCase) {
  return {
    caseId: reviewCase.caseId,
    scope: reviewCase.scope,
    voiceSessionId: reviewCase.voiceSessionId,
    traceId: reviewCase.traceId,
    asrText: reviewCase.asrText,
    asrTextHash: reviewCase.asrTextHash,
    asrLatencyMs: reviewCase.asrLatencyMs,
    conversationContext: reviewCase.conversationContext,
    canonicalSnapshotId: reviewCase.canonicalSnapshotId,
    flatSnapshotId: reviewCase.flatSnapshotId,
    modelFingerprint: reviewCase.modelFingerprint,
    promptFingerprint: reviewCase.promptFingerprint,
    codeFingerprint: reviewCase.codeFingerprint,
    modelMetadata: reviewCase.modelMetadata,
    fallbackReason: reviewCase.fallbackReason,
    status: reviewCase.status,
    invalidReason: reviewCase.invalidReason
  };
}

function resolveCase(
  repository: VoiceQaShadowReviewRepository,
  locator: { caseId?: string; traceId?: string }
) {
  if (locator.caseId) {
    const reviewCase = repository.getCase(locator.caseId);
    if (!reviewCase) throw new Error(`Review case not found: ${locator.caseId}`);
    return reviewCase;
  }
  const matches = repository.listCases({ limit: 10_000 }).filter(
    (reviewCase) => reviewCase.traceId === locator.traceId
  );
  if (matches.length !== 1) {
    throw new Error(
      `Trace locator must resolve exactly one review case; matches=${matches.length}`
    );
  }
  return matches[0]!;
}

export function attachVoiceQaShadowQuestionInputs(
  repository: VoiceQaShadowReviewRepository,
  raw: unknown
) {
  const input = QuestionImportSchema.parse(raw);
  const caseIds: string[] = [];
  for (const item of input.cases) {
    const reviewCase = resolveCase(repository, item);
    repository.upsertQuestionInput(reviewCase.caseId, {
      expectedText: item.expectedText,
      ...(item.expectedTextHash
        ? { expectedTextHash: item.expectedTextHash }
        : {}),
      audioSha256: item.audioSha256,
      audioDurationMs: item.audioDurationMs,
      sourceKind: item.sourceKind,
      ...(item.metadata === undefined ? {} : { metadata: item.metadata })
    });
    updateCaseStatus(
      repository,
      reviewCase,
      item.status,
      item.status === "valid" ? null : item.invalidReason ?? null
    );
    caseIds.push(reviewCase.caseId);
  }
  return {
    attachedCount: caseIds.length,
    caseIds,
    importHash: sha256(JSON.stringify(raw))
  };
}

export function importVoiceQaShadowGold(
  repository: VoiceQaShadowReviewRepository,
  raw: unknown
) {
  const input = GoldImportSchema.parse(raw);
  const caseIds: string[] = [];
  for (const item of input.cases) {
    const bundle = repository.getCaseBundle(item.caseId);
    if (!bundle?.canonicalSnapshot) {
      throw new Error(`Canonical snapshot missing for case ${item.caseId}`);
    }
    const canonicalIds = new Set(
      bundle.canonicalSnapshot.evidence.map((evidence) => evidence.evidenceId)
    );
    const flattened = item.evidenceGroups.flat();
    if (new Set(flattened).size !== flattened.length) {
      throw new Error(`Gold evidence ids must be unique for case ${item.caseId}`);
    }
    const unknownIds = flattened.filter((id) => !canonicalIds.has(id));
    if (unknownIds.length > 0) {
      throw new Error(
        `Gold contains non-canonical evidence for case ${item.caseId}; count=${unknownIds.length}`
      );
    }
    repository.upsertGold(item.caseId, {
      status: item.status,
      evidenceGroups: item.evidenceGroups,
      requiredFacts: item.requiredFacts,
      shouldRefuse: item.shouldRefuse,
      ...(item.categories ? { categories: item.categories } : {}),
      ...(item.reviewerId !== undefined
        ? { reviewerId: item.reviewerId }
        : {}),
      ...(item.notes !== undefined ? { notes: item.notes } : {})
    });
    caseIds.push(item.caseId);
  }
  return {
    importedCount: caseIds.length,
    caseIds,
    importHash: sha256(JSON.stringify(raw))
  };
}

export function buildVoiceQaShadowGoldTemplate(
  repository: VoiceQaShadowReviewRepository,
  input: { caseIds?: readonly string[] } = {}
) {
  const selected = input.caseIds
    ? input.caseIds.map((caseId) => {
        const bundle = repository.getCaseBundle(caseId);
        if (!bundle) throw new Error(`Review case not found: ${caseId}`);
        return bundle;
      })
    : repository.listCases({ limit: 10_000 })
        .filter((reviewCase) => reviewCase.status === "valid")
        .map((reviewCase) => repository.getCaseBundle(reviewCase.caseId)!);
  const cases = selected.map((bundle) => {
    if (!bundle.canonicalSnapshot) {
      throw new Error(
        `Canonical snapshot missing for case ${bundle.case.caseId}`
      );
    }
    return {
      caseId: bundle.case.caseId,
      scope: bundle.case.scope,
      asrText: bundle.case.asrText,
      conversationContext: bundle.case.conversationContext,
      canonicalSnapshot: {
        snapshotId: bundle.canonicalSnapshot.snapshotId,
        universeHash: bundle.canonicalSnapshot.universeHash,
        contentHash: bundle.canonicalSnapshot.contentHash,
        evidence: bundle.canonicalSnapshot.evidence.map((evidence) => ({
          evidenceId: evidence.evidenceId,
          ordinal: evidence.ordinal,
          content: evidence.content,
          contentHash: evidence.contentHash,
          metadata: evidence.metadata
        }))
      },
      status: "evaluable" as const,
      evidenceGroups: [] as string[][],
      requiredFacts: [] as string[],
      shouldRefuse: false,
      categories: [] as string[],
      reviewerId: null as string | null,
      notes: null as string | null
    };
  });
  return {
    version: 1 as const,
    kind: "voice_qa_shadow_gold_review_template_v1" as const,
    privacy: "user_scoped_private_review_material" as const,
    candidateSystemOriginsIncluded: false,
    caseCount: cases.length,
    cases
  };
}

function selectedEvidenceIds(
  bundle: StoredVoiceQaShadowReviewCaseBundle,
  system: VoiceQaShadowReviewSystem
) {
  const run = bundle.retrievalRuns.find(
    (candidate) => candidate.system === system && candidate.replayIndex === 0
  );
  return run
    ? run.candidates
        .filter((candidate) => candidate.selectedRank !== null)
        .sort((left, right) => left.selectedRank! - right.selectedRank!)
        .map((candidate) => candidate.evidenceId)
    : null;
}

function assertCompleteBlindAnswerSet(
  repository: VoiceQaShadowReviewRepository,
  caseId: string
) {
  const answers = repository.listBlindAnswers(caseId);
  const expectedKeys = new Set(
    [1, 2].flatMap((round) =>
      (["A", "B"] as const).map((system) => `${round}:${system}`)
    )
  );
  const actualKeys = new Set(
    answers.map((answer) => `${answer.round}:${answer.system}`)
  );
  if (
    actualKeys.size !== expectedKeys.size ||
    [...expectedKeys].some((key) => !actualKeys.has(key))
  ) {
    throw new Error(`Blind answer set is incomplete for case ${caseId}`);
  }
  const mappings = [1, 2].map((round) =>
    answers
      .filter((answer) => answer.round === round)
      .sort((left, right) => left.system.localeCompare(right.system))
      .map((answer) => `${answer.system}:${answer.label}`)
      .join("|")
  );
  if (mappings[0] === mappings[1]) {
    throw new Error(`Blind answer order was not swapped for case ${caseId}`);
  }
}

export function importVoiceQaShadowBlindReview(
  repository: VoiceQaShadowReviewRepository,
  raw: unknown
) {
  const input = BlindImportSchema.parse(raw);
  const answerCaseIds = new Set<string>();
  const importedModels = new Set<string>();
  const templateFingerprints = new Set<string>();
  const codeFingerprints = new Set<string>();
  const importedAnswers = input.answers ?? [];
  for (const answer of importedAnswers) {
    answerCaseIds.add(answer.caseId);
    importedModels.add(answer.model);
    templateFingerprints.add(answer.promptTemplateFingerprint);
    codeFingerprints.add(answer.codeFingerprint);
  }
  const providerModels = new Set(
    [...importedModels].filter(
      (model) => model !== VOICE_QA_SHADOW_NO_PROVIDER_MODEL
    )
  );
  if (providerModels.size > 1) {
    throw new Error("Blind answers must use one model");
  }
  if (templateFingerprints.size > 1) {
    throw new Error("Blind answers must use one prompt template fingerprint");
  }
  if (codeFingerprints.size > 1) {
    throw new Error("Blind answers must use one code fingerprint");
  }
  for (const caseId of answerCaseIds) {
    const caseAnswers = importedAnswers.filter(
      (answer) => answer.caseId === caseId
    );
    const keys = new Set(
      caseAnswers.map((answer) => `${answer.round}:${answer.system}`)
    );
    if (caseAnswers.length !== 4 || keys.size !== 4) {
      throw new Error(`Blind answer set is incomplete for case ${caseId}`);
    }
    const mappings = [1, 2].map((round) =>
      caseAnswers
        .filter((answer) => answer.round === round)
        .sort((left, right) => left.system.localeCompare(right.system))
        .map((answer) => `${answer.system}:${answer.label}`)
        .join("|")
    );
    if (mappings[0] === mappings[1]) {
      throw new Error(`Blind answer order was not swapped for case ${caseId}`);
    }
  }
  const validatedAnswers: typeof importedAnswers = [];
  for (const answer of importedAnswers) {
    const bundle = repository.getCaseBundle(answer.caseId);
    if (!bundle) throw new Error(`Review case not found: ${answer.caseId}`);
    const run = bundle.retrievalRuns.find(
      (candidate) =>
        candidate.system === answer.system &&
        candidate.replayIndex === 0
    );
    if (!run || run.inputHash !== answer.inputHash) {
      throw new Error(
        `Blind answer retrieval input mismatch for case ${answer.caseId}`
      );
    }
    const expectedEvidence = selectedEvidenceIds(bundle, answer.system);
    if (
      !expectedEvidence ||
      expectedEvidence.length !== answer.evidenceIds.length ||
      expectedEvidence.some((id, index) => id !== answer.evidenceIds[index])
    ) {
      throw new Error(
        `Blind answer evidence ordering mismatch for case ${answer.caseId}`
      );
    }
    if (bundle.case.codeFingerprint !== answer.codeFingerprint) {
      throw new Error(
        `Blind answer code fingerprint mismatch for case ${answer.caseId}`
      );
    }
    if (
      bundle.blindPromptSnapshot?.status === "no_provider_prompt" &&
      answer.model !== VOICE_QA_SHADOW_NO_PROVIDER_MODEL
    ) {
      throw new Error(
        `No-provider blind answer model mismatch for case ${answer.caseId}`
      );
    }
    if (
      bundle.blindPromptSnapshot?.status === "provider_prompt" &&
      answer.model === VOICE_QA_SHADOW_NO_PROVIDER_MODEL
    ) {
      throw new Error(
        `Provider blind answer model mismatch for case ${answer.caseId}`
      );
    }
    validatedAnswers.push(answer);
  }
  for (const answer of validatedAnswers) {
    repository.upsertBlindAnswer(answer.caseId, {
      round: answer.round,
      label: answer.label,
      system: answer.system,
      answerText: answer.answerText,
      citations: answer.citations,
      citationValidity: answer.citationValidity,
      model: answer.model,
      ...(answer.generationLatencyMs !== undefined
        ? { generationLatencyMs: answer.generationLatencyMs }
        : {})
    });
  }
  for (const caseId of answerCaseIds) {
    assertCompleteBlindAnswerSet(repository, caseId);
  }

  const reviewCaseIds = new Set<string>();
  for (const review of input.reviews ?? []) {
    repository.upsertBlindReview(review.caseId, {
      round: review.round,
      label: review.label,
      scores: review.scores,
      hardViolations: review.hardViolations,
      outcome: review.outcome,
      ...(review.reviewerId !== undefined
        ? { reviewerId: review.reviewerId }
        : {})
    });
    reviewCaseIds.add(review.caseId);
  }
  return {
    answerCount: input.answers?.length ?? 0,
    reviewCount: input.reviews?.length ?? 0,
    caseIds: [...new Set([...answerCaseIds, ...reviewCaseIds])].sort(),
    importHash: sha256(JSON.stringify(raw))
  };
}

export function importVoiceQaShadowFaultRuns(
  repository: VoiceQaShadowReviewRepository,
  raw: unknown
) {
  const input = FaultImportSchema.parse(raw);
  const faultRunIds: string[] = [];
  for (const run of input.runs) {
    const expectedHashesPresent =
      Boolean(run.expectedOfficialAnswerHash) &&
      Boolean(run.actualOfficialAnswerHash) &&
      Boolean(run.expectedCitationHash) &&
      Boolean(run.actualCitationHash);
    if (run.status === "completed" && !expectedHashesPresent) {
      throw new Error(
        `Completed fault run requires expected and actual hashes: ${run.faultRunId}`
      );
    }
    if (expectedHashesPresent) {
      const computedFailOpen =
        run.expectedOfficialAnswerHash === run.actualOfficialAnswerHash &&
        run.expectedCitationHash === run.actualCitationHash;
      if (run.lexicalFailOpen !== computedFailOpen) {
        throw new Error(
          `Fault fail-open flag does not match hashes: ${run.faultRunId}`
        );
      }
    }
    if (run.scenario === "redis_6380_restart") {
      const metadata = objectRecord(run.metadata);
      if (
        metadata?.redisPort !== 6380 ||
        metadata.touchedRedis6379 !== false
      ) {
        throw new Error(
          "Redis fault run must attest redisPort=6380 and touchedRedis6379=false"
        );
      }
    }
    repository.upsertFaultRun({
      faultRunId: run.faultRunId,
      ...(run.caseId !== undefined ? { caseId: run.caseId } : {}),
      scenario: run.scenario,
      status: run.status,
      ...(run.shadowError !== undefined
        ? { shadowError: run.shadowError }
        : {}),
      ...(run.expectedOfficialAnswerHash !== undefined
        ? { expectedOfficialAnswerHash: run.expectedOfficialAnswerHash }
        : {}),
      ...(run.actualOfficialAnswerHash !== undefined
        ? { actualOfficialAnswerHash: run.actualOfficialAnswerHash }
        : {}),
      ...(run.expectedCitationHash !== undefined
        ? { expectedCitationHash: run.expectedCitationHash }
        : {}),
      ...(run.actualCitationHash !== undefined
        ? { actualCitationHash: run.actualCitationHash }
        : {}),
      ...(run.voiceUninterrupted !== undefined
        ? { voiceUninterrupted: run.voiceUninterrupted }
        : {}),
      ...(run.lexicalFailOpen !== undefined
        ? { lexicalFailOpen: run.lexicalFailOpen }
        : {}),
      ...(run.citationsValid !== undefined
        ? { citationsValid: run.citationsValid }
        : {}),
      ...(run.shadowLatencyMs !== undefined
        ? { shadowLatencyMs: run.shadowLatencyMs }
        : {}),
      ...(run.metadata === undefined ? {} : { metadata: run.metadata })
    });
    faultRunIds.push(run.faultRunId);
  }
  return {
    importedCount: faultRunIds.length,
    faultRunIds,
    importHash: sha256(JSON.stringify(raw))
  };
}

function replayInputFromBundle(
  bundle: StoredVoiceQaShadowReviewCaseBundle
) {
  const missing: string[] = [];
  if (!bundle.replayInput) missing.push("replay_input_snapshot");
  if (!bundle.canonicalSnapshot) missing.push("canonical_snapshot");
  if (!bundle.queryVector) missing.push("query_vector");
  const primaryRuns = new Map(
    bundle.retrievalRuns
      .filter((run) => run.replayIndex === 0)
      .map((run) => [run.system, run])
  );
  for (const system of ["A", "B"] as const) {
    if (!primaryRuns.has(system)) missing.push(`primary_run_${system}`);
  }
  const raw = objectRecord(bundle.replayInput?.input);
  for (const field of [
    "uploadId",
    "question",
    "segments",
    "semanticSegments",
    "briefItems"
  ] as const) {
    if (raw?.[field] === undefined) missing.push(`replay_input.${field}`);
  }
  if (missing.length > 0) {
    throw new VoiceQaShadowReplayPreconditionError(
      bundle.case.caseId,
      missing
    );
  }
  if (
    typeof raw!.question !== "string" ||
    hashVoiceQaShadowReviewText(raw!.question) !== bundle.case.asrTextHash
  ) {
    throw new VoiceQaShadowReplayPreconditionError(
      bundle.case.caseId,
      ["replay_input.question_hash_mismatch"]
    );
  }
  const queryVector = bundle.queryVector!;
  const modelMismatch: string[] = [];
  if (queryVector.modelName !== QWEN3_EMBEDDING_4B_MODEL) {
    modelMismatch.push("query_vector.model_name");
  }
  if (queryVector.modelRevision !== QWEN3_EMBEDDING_4B_REVISION) {
    modelMismatch.push("query_vector.model_revision");
  }
  if (queryVector.dimension !== QWEN3_EMBEDDING_4B_DIMENSION) {
    modelMismatch.push("query_vector.dimension");
  }
  if (modelMismatch.length > 0) {
    throw new VoiceQaShadowReplayPreconditionError(
      bundle.case.caseId,
      modelMismatch
    );
  }
  return {
    replayInput: bundle.replayInput!.input as VoiceQaShadowReviewReplayInput,
    queryVector,
    primaryRuns
  };
}

function replayRunInput(
  snapshot: VoiceQaShadowReviewRetrievalSnapshot,
  system: VoiceQaShadowReviewSystem
) {
  const result = snapshot.systems[system];
  return {
    system,
    replayIndex: 1,
    status: result.fallbackReason ? "fallback" as const : "completed" as const,
    flatSnapshotId: system === "A"
      ? null
      : snapshot.flatSnapshotFingerprint,
    denseLatencyMs: result.denseMs,
    totalLatencyMs: result.retrievalMs,
    fallbackReason: result.fallbackReason,
    candidateValidity: result.canonicalCandidateValidity,
    inputHash: result.inputHash,
    orderHash: result.orderHash,
    rankingMetadata: {
      algorithmFingerprint: snapshot.algorithmFingerprint,
      fusion: snapshot.fusion,
      rankingVersion: snapshot.rankingVersion,
      evidence: snapshot.rankingMetadata
    },
    memorySourceIds: snapshot.memorySourceIds,
    candidates: result.top30.map((candidate) => ({
      evidenceId: candidate.evidenceId,
      rank: candidate.rank,
      selectedRank: candidate.selectedTop16 ? candidate.rank : null,
      score: candidate.score,
      reason: {
        reasons: candidate.reasons,
        details: candidate.details
      }
    }))
  };
}

export async function replayVoiceQaShadowReviewCases(
  repository: VoiceQaShadowReviewRepository,
  input: {
    userId: string;
    caseIds?: readonly string[];
    runRetrieval?: RunRetrieval;
    onProgress?: (progress: {
      completed: number;
      total: number;
      caseId: string;
      status: "completed" | "failed";
    }) => void;
  }
) {
  const runRetrieval = input.runRetrieval ?? runVoiceQaShadowReviewRetrieval;
  const reviewCases = input.caseIds
    ? input.caseIds.map((caseId) => {
        const reviewCase = repository.getCase(caseId);
        if (!reviewCase) throw new Error(`Review case not found: ${caseId}`);
        return reviewCase;
      })
    : repository.listCases({ limit: 10_000 }).filter(
        (reviewCase) => reviewCase.status === "valid"
      );
  const completed: string[] = [];
  const failures: VoiceQaShadowReplayFailure[] = [];
  for (const reviewCase of reviewCases) {
    const bundle = repository.getCaseBundle(reviewCase.caseId)!;
    try {
      const prepared = replayInputFromBundle(bundle);
      let vectorReadCount = 0;
      const provider: EmbeddingProvider = {
        config: {
          modelName: prepared.queryVector.modelName,
          modelVersion: prepared.queryVector.modelRevision,
          dimension: prepared.queryVector.dimension
        },
        async embed(texts) {
          if (texts.length !== 1 || vectorReadCount > 0) {
            throw new Error("Replay query vector can be consumed exactly once");
          }
          vectorReadCount += 1;
          return [Array.from(prepared.queryVector.vector)];
        }
      };
      const qaInput: AnswerQuestionWithAIInput = {
        ...prepared.replayInput,
        userId: input.userId,
        shadowReviewContext: {
          voiceSessionId: bundle.case.voiceSessionId,
          traceId: bundle.case.traceId,
          caseId: bundle.case.caseId,
          started: true
        }
      };
      const lexical = retrieveQaEvidenceWithDiagnostics(qaInput);
      const snapshot = await runRetrieval({
        caseId: bundle.case.caseId,
        qaInput,
        lexical,
        dependencies: { provider }
      });
      const mismatch: string[] = [];
      if (vectorReadCount !== 1) mismatch.push("query_vector_not_consumed_once");
      if (
        snapshot.canonicalSnapshotId !==
        bundle.canonicalSnapshot!.snapshotId
      ) {
        mismatch.push("canonical_snapshot_changed");
      }
      if (snapshot.queryVectorHash !== prepared.queryVector.vectorHash) {
        mismatch.push("query_vector_hash_changed");
      }
      if (
        snapshot.flatSnapshotFingerprint !== bundle.case.flatSnapshotId
      ) {
        mismatch.push("flat_snapshot_changed");
      }
      for (const system of ["A", "B"] as const) {
        const primary = prepared.primaryRuns.get(system)!;
        const result = snapshot.systems[system];
        if (result.fallbackReason) mismatch.push(`${system}_fallback`);
        if (!result.canonicalCandidateValidity) {
          mismatch.push(`${system}_candidate_invalid`);
        }
        if (result.inputHash !== primary.inputHash) {
          mismatch.push(`${system}_input_hash_changed`);
        }
      }
      if (mismatch.length > 0) {
        throw new VoiceQaShadowReplayPreconditionError(
          bundle.case.caseId,
          mismatch
        );
      }
      repository.upsertCaseBundle({
        case: caseInputFromStored(bundle.case),
        retrievalRuns: (["A", "B"] as const).map((system) =>
          replayRunInput(snapshot, system)
        )
      });
      completed.push(bundle.case.caseId);
      input.onProgress?.({
        completed: completed.length + failures.length,
        total: reviewCases.length,
        caseId: bundle.case.caseId,
        status: "completed"
      });
    } catch (error) {
      if (error instanceof VoiceQaShadowReplayPreconditionError) {
        failures.push({ caseId: error.caseId, missing: error.missing });
        input.onProgress?.({
          completed: completed.length + failures.length,
          total: reviewCases.length,
          caseId: bundle.case.caseId,
          status: "failed"
        });
        continue;
      }
      failures.push({
        caseId: bundle.case.caseId,
        missing: [
          `runtime:${error instanceof Error ? error.name : "unknown"}`
        ]
      });
      input.onProgress?.({
        completed: completed.length + failures.length,
        total: reviewCases.length,
        caseId: bundle.case.caseId,
        status: "failed"
      });
    }
  }
  return {
    totalCount: reviewCases.length,
    completedCount: completed.length,
    failedCount: failures.length,
    completed,
    failures
  };
}

type BlindProviderConfig = {
  providerId: "gpt-5.5";
  logProvider: "openrouter" | "openai-compatible";
  model: string;
  wireApi: "chat" | "responses";
  reasoningEnabled: boolean | null;
  endpointFingerprint: string;
};

type PreparedBlindCase = {
  bundle: StoredVoiceQaShadowReviewCaseBundle;
  qaInput: AnswerQuestionWithAIInput;
  mode: "provider_prompt" | "no_provider_prompt";
  selectedEvidence: Record<
    VoiceQaShadowReviewSystem,
    QaRetrievedEvidence[]
  >;
  providerConfig: BlindProviderConfig | null;
};

function storedQaEvidence(
  bundle: StoredVoiceQaShadowReviewCaseBundle,
  evidenceIds: readonly string[]
) {
  const byId = new Map(
    bundle.canonicalSnapshot?.evidence.map((item) => [
      item.evidenceId,
      item
    ]) ?? []
  );
  return evidenceIds.map((evidenceId): QaRetrievedEvidence => {
    const stored = byId.get(evidenceId);
    const metadata = objectRecord(stored?.metadata);
    const sourceSegmentIds = Array.isArray(metadata?.sourceSegmentIds)
      ? metadata.sourceSegmentIds.filter(
          (value): value is string => typeof value === "string"
        )
      : [];
    const kind = metadata?.kind;
    if (
      !stored ||
      stored.contentHash !== sha256(stored.content) ||
      ![
        "brief",
        "semantic",
        "audio",
        "audio_emotion",
        "raw",
        "relationship_signal"
      ].includes(typeof kind === "string" ? kind : "") ||
      typeof metadata?.title !== "string" ||
      typeof metadata.startSeconds !== "number" ||
      typeof metadata.endSeconds !== "number" ||
      typeof metadata.priority !== "number" ||
      !Array.isArray(metadata.sourceSegmentIds) ||
      sourceSegmentIds.length !== metadata.sourceSegmentIds.length
    ) {
      throw new Error("canonical_evidence_metadata");
    }
    const relationshipSignal = objectRecord(metadata.relationshipSignal);
    return {
      id: stored.evidenceId,
      kind: kind as QaRetrievedEvidence["kind"],
      title: metadata.title,
      text: stored.content,
      startSeconds: metadata.startSeconds,
      endSeconds: metadata.endSeconds,
      sourceSegmentIds,
      priority: metadata.priority,
      ...(relationshipSignal && Object.keys(relationshipSignal).length > 0
        ? {
            relationshipSignal:
              relationshipSignal as QaRetrievedEvidence["relationshipSignal"]
          }
        : {})
    };
  });
}

function selectedEvidenceForBlindSystem(
  bundle: StoredVoiceQaShadowReviewCaseBundle,
  system: VoiceQaShadowReviewSystem
) {
  const primary = bundle.retrievalRuns.find(
    (run) => run.system === system && run.replayIndex === 0
  );
  const replay = bundle.retrievalRuns.find(
    (run) => run.system === system && run.replayIndex === 1
  );
  if (
    !primary ||
    !replay ||
    primary.status !== "completed" ||
    replay.status !== "completed" ||
    primary.fallbackReason !== null ||
    replay.fallbackReason !== null ||
    primary.candidateValidity !== true ||
    replay.candidateValidity !== true ||
    primary.inputHash !== replay.inputHash ||
    primary.orderHash !== replay.orderHash
  ) {
    throw new Error(`retrieval_${system}_not_frozen`);
  }
  const selected = primary.candidates
    .filter((candidate) => candidate.selectedRank !== null)
    .sort((left, right) => left.selectedRank! - right.selectedRank!);
  if (
    selected.length > 16 ||
    selected.some(
      (candidate, index) => candidate.selectedRank !== index + 1
    ) ||
    new Set(selected.map((candidate) => candidate.evidenceId)).size !==
      selected.length
  ) {
    throw new Error(`selected_rank_${system}_invalid`);
  }
  return storedQaEvidence(
    bundle,
    selected.map((candidate) => candidate.evidenceId)
  );
}

function officialBlindProviderConfig(
  bundle: StoredVoiceQaShadowReviewCaseBundle
): BlindProviderConfig {
  const officialQa = objectRecord(
    objectRecord(bundle.case.modelMetadata)?.officialQa
  );
  const official = bundle.officialAnswer;
  if (
    !officialQa ||
    !official ||
    officialQa.providerId !== "gpt-5.5" ||
    (
      officialQa.provider !== "openrouter" &&
      officialQa.provider !== "openai-compatible"
    ) ||
    typeof officialQa.model !== "string" ||
    !/(?:^|\/)gpt-5\.5$/u.test(officialQa.model) ||
    (
      officialQa.wireApi !== "chat" &&
      officialQa.wireApi !== "responses"
    ) ||
    (
      officialQa.reasoningEnabled !== null &&
      typeof officialQa.reasoningEnabled !== "boolean"
    ) ||
    typeof officialQa.endpointFingerprint !== "string" ||
    !SHA256.test(officialQa.endpointFingerprint) ||
    official.model !== `${officialQa.provider}:${officialQa.model}`
  ) {
    throw new Error("official_provider_config");
  }
  return {
    providerId: "gpt-5.5",
    logProvider: officialQa.provider,
    model: officialQa.model,
    wireApi: officialQa.wireApi,
    reasoningEnabled: officialQa.reasoningEnabled,
    endpointFingerprint: officialQa.endpointFingerprint
  };
}

function blindLabels(caseId: string) {
  const labels = ["X", "Y"] as const;
  const systems = [...(["A", "B"] as const)].sort((left, right) =>
    sha256(`${BLIND_MAPPING_VERSION}:${caseId}:${left}`)
      .localeCompare(
        sha256(`${BLIND_MAPPING_VERSION}:${caseId}:${right}`)
      )
  );
  const round1 = new Map(
    systems.map((system, index) => [system, labels[index]!] as const)
  );
  const round2 = new Map(
    systems.map(
      (system, index) =>
        [system, labels[(index + 1) % labels.length]!] as const
    )
  );
  return { round1, round2 };
}

function sameBlindAnswerProjection(
  left: StoredVoiceQaShadowReviewCaseBundle["blindAnswers"][number],
  right: StoredVoiceQaShadowReviewCaseBundle["blindAnswers"][number]
) {
  return (
    left.answerHash === right.answerHash &&
    left.citationsHash === right.citationsHash &&
    left.citationValidity === right.citationValidity &&
    left.model === right.model
  );
}

function preflightBlindCases(
  repository: VoiceQaShadowReviewRepository,
  input: {
    userId: string;
    settingsStore?: JsonStore;
    caseIds?: readonly string[];
  }
) {
  const reviewCases = input.caseIds
    ? input.caseIds.map((caseId) => {
        const reviewCase = repository.getCase(caseId);
        if (!reviewCase) throw new Error(`Review case not found: ${caseId}`);
        return reviewCase;
      })
    : repository.listCases({ limit: 10_000 }).filter(
        (reviewCase) => reviewCase.status === "valid"
      );
  const failures: VoiceQaShadowReplayFailure[] = [];
  const prepared: PreparedBlindCase[] = [];
  for (const reviewCase of reviewCases) {
    const bundle = repository.getCaseBundle(reviewCase.caseId)!;
    const missing: string[] = [];
    try {
      if (!bundle.replayInput) throw new Error("replay_input_snapshot");
      if (!bundle.canonicalSnapshot) throw new Error("canonical_snapshot");
      if (!bundle.officialAnswer) throw new Error("official_answer");
      if (!bundle.blindPromptSnapshot) {
        throw new Error("blind_prompt_snapshot");
      }
      if (
        ["pending", "unresolved"].includes(bundle.case.codeFingerprint)
      ) {
        throw new Error("code_fingerprint");
      }
      if (
        ["pending", "unresolved"].includes(bundle.case.modelFingerprint)
      ) {
        throw new Error("model_fingerprint");
      }
      if (!bundle.case.flatSnapshotId) throw new Error("flat_snapshot");
      const modelMetadata = objectRecord(bundle.case.modelMetadata);
      if (
        modelMetadata?.canonicalEvidenceVersion !==
        VOICE_QA_SHADOW_CANONICAL_EVIDENCE_VERSION
      ) {
        throw new Error("canonical_evidence_version");
      }
      const replay = bundle.replayInput.input as VoiceQaShadowReviewReplayInput;
      if (
        typeof replay.question !== "string" ||
        hashVoiceQaShadowReviewText(replay.question) !==
          bundle.case.asrTextHash
      ) {
        throw new Error("replay_question_hash");
      }
      const qaInput: AnswerQuestionWithAIInput = {
        ...replay,
        userId: input.userId,
        ...(input.settingsStore
          ? { settingsStore: input.settingsStore }
          : {})
      };
      const selectedEvidence = Object.fromEntries(
        (["A", "B"] as const).map((system) => [
          system,
          selectedEvidenceForBlindSystem(bundle, system)
        ])
      ) as Record<VoiceQaShadowReviewSystem, QaRetrievedEvidence[]>;
      const snapshot = bundle.blindPromptSnapshot;
      if (snapshot.status === "no_provider_prompt") {
        const citations = objectRecord(bundle.officialAnswer.citations);
        if (
          bundle.officialAnswer.fallbackReason !== "insufficient_evidence" ||
          selectedEvidence.A.length !== 0 ||
          selectedEvidence.B.length !== 0 ||
          !Array.isArray(citations?.citations) ||
          citations.citations.length !== 0 ||
          !Array.isArray(citations.citedSegmentIds) ||
          citations.citedSegmentIds.length !== 0
        ) {
          throw new Error("no_provider_boundary");
        }
        prepared.push({
          bundle,
          qaInput,
          mode: snapshot.status,
          selectedEvidence,
          providerConfig: null
        });
        continue;
      }
      if (
        !snapshot.systemPrompt ||
        !snapshot.userPromptPrefix ||
        !snapshot.systemPromptHash ||
        !snapshot.userPromptPrefixHash ||
        !snapshot.evidenceSectionHash
      ) {
        throw new Error("provider_prompt_snapshot");
      }
      const providerConfig = officialBlindProviderConfig(bundle);
      const preparations = Object.fromEntries(
        (["A", "B"] as const).map((system) => [
          system,
          prepareQaSelectedEvidenceForEvaluation({
            qaInput,
            selectedEvidence: selectedEvidence[system],
            systemPrompt: snapshot.systemPrompt!,
            userPromptPrefix: snapshot.userPromptPrefix!,
            ...(system === "A"
              ? {
                  expectedEvidenceSectionHash:
                    snapshot.evidenceSectionHash!,
                  expectedOfficialPromptFingerprint:
                    bundle.officialAnswer!.promptFingerprint,
                  expectedMemoryCount: snapshot.memoryCount,
                  expectedMemoryEvidenceCount: snapshot.evidenceCount
                }
              : {})
          })
        ])
      ) as Record<
        VoiceQaShadowReviewSystem,
        ReturnType<typeof prepareQaSelectedEvidenceForEvaluation>
      >;
      if (
        preparations.A.fullPromptFingerprint !==
          bundle.case.promptFingerprint ||
        preparations.A.systemPromptHash !== snapshot.systemPromptHash ||
        preparations.A.userPromptPrefixHash !==
          snapshot.userPromptPrefixHash ||
        preparations.A.lexicalEvidenceIds.length !==
          selectedEvidence.A.length ||
        preparations.A.lexicalEvidenceIds.some(
          (evidenceId, index) =>
            evidenceId !== selectedEvidence.A[index]?.id
        )
      ) {
        throw new Error("official_A_prompt_or_lexical");
      }
      prepared.push({
        bundle,
        qaInput,
        mode: snapshot.status,
        selectedEvidence,
        providerConfig
      });
    } catch (error) {
      missing.push(
        error instanceof Error ? error.message : "unknown_precondition"
      );
      failures.push({ caseId: reviewCase.caseId, missing });
    }
  }
  if (failures.length > 0) {
    return { prepared: [] as PreparedBlindCase[], failures };
  }
  const singletonFields: Array<[
    string,
    (item: PreparedBlindCase) => unknown
  ]> = [
    ["code_fingerprint_set", (item) => item.bundle.case.codeFingerprint],
    ["model_fingerprint_set", (item) => item.bundle.case.modelFingerprint],
    ["flat_snapshot_set", (item) => item.bundle.case.flatSnapshotId],
    [
      "canonical_evidence_version_set",
      (item) =>
        objectRecord(item.bundle.case.modelMetadata)
          ?.canonicalEvidenceVersion
    ]
  ];
  for (const [field, select] of singletonFields) {
    if (new Set(prepared.map(select)).size !== 1) {
      failures.push({
        caseId: "batch",
        missing: [field]
      });
    }
  }
  const providerCases = prepared.filter(
    (item) => item.providerConfig !== null
  );
  if (
    new Set(
      providerCases.map((item) => JSON.stringify(item.providerConfig))
    ).size > 1
  ) {
    failures.push({
      caseId: "batch",
      missing: ["official_provider_config_set"]
    });
  }
  if (
    new Set(
      providerCases.map(
        (item) => item.bundle.blindPromptSnapshot!.systemPromptHash
      )
    ).size > 1
  ) {
    failures.push({
      caseId: "batch",
      missing: ["system_prompt_template_hash_set"]
    });
  }
  return {
    prepared: failures.length === 0 ? prepared : [],
    failures
  };
}

function blindReviewTemplate(
  repository: VoiceQaShadowReviewRepository,
  caseIds: readonly string[]
) {
  return {
    version: 1 as const,
    kind: "voice_qa_shadow_blind_review_template_v1" as const,
    privacy: "user_scoped_private_review_material" as const,
    systemIdentityIncluded: false,
    mappingVersion: BLIND_MAPPING_VERSION,
    caseCount: caseIds.length,
    cases: [...caseIds].sort().map((caseId) => {
      const bundle = repository.getCaseBundle(caseId)!;
      return {
        caseId,
        scope: bundle.case.scope,
        rounds: [1, 2].map((round) => ({
          round,
          answers: bundle.blindAnswers
            .filter((answer) => answer.round === round)
            .sort((left, right) => left.label.localeCompare(right.label))
            .map((answer) => ({
              label: answer.label,
              answerText: answer.answerText,
              citations: answer.citations,
              scores: {
                factualCorrectness: null,
                completeness: null,
                citationSupport: null,
                uncertainty: null,
                directness: null
              },
              hardViolations: [] as string[],
              outcome: "unscored" as const,
              reviewerId: null as string | null
            }))
        }))
      };
    })
  };
}

export async function generateVoiceQaShadowBlindReview(
  repository: VoiceQaShadowReviewRepository,
  input: {
    userId: string;
    settingsStore?: JsonStore;
    caseIds?: readonly string[];
    createSession?: typeof createQaSelectedEvidenceEvaluationSession;
    onProgress?: (progress: {
      completed: number;
      total: number;
      caseId: string;
      status: "completed" | "failed";
    }) => void;
  }
) {
  const preflight = preflightBlindCases(repository, input);
  if (preflight.failures.length > 0) {
    return {
      totalCount:
        input.caseIds?.length ??
        repository.listCases({ limit: 10_000 }).filter(
          (reviewCase) => reviewCase.status === "valid"
        ).length,
      completedCount: 0,
      failedCount: preflight.failures.length,
      providerCallCount: 0,
      failures: preflight.failures,
      caseIds: [] as string[],
      template: null,
      generationPerformed: false as const
    };
  }
  const providerConfig = preflight.prepared.find(
    (item) => item.providerConfig !== null
  )?.providerConfig ?? null;
  const createSession =
    input.createSession ?? createQaSelectedEvidenceEvaluationSession;
  let session: QaSelectedEvidenceEvaluationSession | null = null;
  if (providerConfig) {
    session = await createSession({
      settingsStore: input.settingsStore,
      expectedLogProvider: providerConfig.logProvider,
      expectedModel: providerConfig.model,
      expectedWireApi: providerConfig.wireApi,
      expectedReasoningEnabled: providerConfig.reasoningEnabled,
      expectedEndpointFingerprint: providerConfig.endpointFingerprint
    });
  }
  const completed: string[] = [];
  const failures: VoiceQaShadowReplayFailure[] = [];
  let providerCallCount = 0;
  let generatedSystemCount = 0;
  for (const prepared of preflight.prepared) {
    try {
      const labels = blindLabels(prepared.bundle.case.caseId);
      const existing = repository.listBlindAnswers(
        prepared.bundle.case.caseId
      );
      const noProviderAnswer = prepared.mode === "no_provider_prompt"
        ? noProviderQaAnswerForEvaluation(prepared.qaInput)
        : null;
      for (const system of ["A", "B"] as const) {
        const expectedLabels = [
          { round: 1, label: labels.round1.get(system)! },
          { round: 2, label: labels.round2.get(system)! }
        ];
        const existingSystem = existing.filter(
          (answer) => answer.system === system
        );
        if (existingSystem.length > 0) {
          if (
            existingSystem.length !== 2 ||
            !sameBlindAnswerProjection(
              existingSystem[0]!,
              existingSystem[1]!
            ) ||
            expectedLabels.some(
              ({ round, label }) =>
                !existingSystem.some(
                  (answer) =>
                    answer.round === round && answer.label === label
                )
            )
          ) {
            throw new Error(`existing_blind_answer_${system}`);
          }
          continue;
        }
        let answer;
        let generationLatencyMs: number | null = 0;
        let model: string;
        if (prepared.mode === "no_provider_prompt") {
          answer = noProviderAnswer!;
          model = VOICE_QA_SHADOW_NO_PROVIDER_MODEL;
        } else {
          if (!session || !prepared.providerConfig) {
            throw new Error("provider_session");
          }
          const snapshot = prepared.bundle.blindPromptSnapshot!;
          const result = await session.answer({
            qaInput: prepared.qaInput,
            selectedEvidence: prepared.selectedEvidence[system],
            systemPrompt: snapshot.systemPrompt!,
            userPromptPrefix: snapshot.userPromptPrefix!,
            ...(system === "A"
              ? {
                  expectedEvidenceSectionHash:
                    snapshot.evidenceSectionHash!,
                  expectedOfficialPromptFingerprint:
                    prepared.bundle.officialAnswer!.promptFingerprint,
                  expectedMemoryCount: snapshot.memoryCount,
                  expectedMemoryEvidenceCount: snapshot.evidenceCount
                }
              : {})
          });
          providerCallCount += 1;
          answer = result.answer;
          generationLatencyMs = result.generationLatencyMs;
          model = `${result.logProvider}:${result.model}`;
        }
        const citationValidity =
          qaSelectedEvidenceCitationValidityForEvaluation(
            answer,
            prepared.selectedEvidence[system]
          );
        if (!citationValidity) {
          throw new Error(`citation_validity_${system}`);
        }
        repository.upsertCaseBundle({
          case: caseInputFromStored(prepared.bundle.case),
          blindAnswers: expectedLabels.map(({ round, label }) => ({
            round,
            label,
            system,
            answerText: answer.answer,
            citations: answer.citations ?? [],
            citationValidity,
            model,
            generationLatencyMs
          }))
        });
        generatedSystemCount += 1;
      }
      completed.push(prepared.bundle.case.caseId);
      input.onProgress?.({
        completed: completed.length + failures.length,
        total: preflight.prepared.length,
        caseId: prepared.bundle.case.caseId,
        status: "completed"
      });
    } catch (error) {
      failures.push({
        caseId: prepared.bundle.case.caseId,
        missing: [
          error instanceof Error ? error.message : "generation_failure"
        ]
      });
      input.onProgress?.({
        completed: completed.length + failures.length,
        total: preflight.prepared.length,
        caseId: prepared.bundle.case.caseId,
        status: "failed"
      });
    }
  }
  const template = blindReviewTemplate(repository, completed);
  return {
    totalCount: preflight.prepared.length,
    completedCount: completed.length,
    failedCount: failures.length,
    providerCallCount,
    generatedSystemCount,
    failures,
    caseIds: completed,
    template,
    generationPerformed: generatedSystemCount > 0
  };
}

export function assessVoiceQaShadowBlindGeneration(
  repository: VoiceQaShadowReviewRepository,
  input: { caseIds?: readonly string[] } = {}
) {
  const reviewCases = input.caseIds
    ? input.caseIds.map((caseId) => {
        const reviewCase = repository.getCase(caseId);
        if (!reviewCase) throw new Error(`Review case not found: ${caseId}`);
        return reviewCase;
      })
    : repository.listCases({ limit: 10_000 }).filter(
        (reviewCase) => reviewCase.status === "valid"
      );
  const failures = reviewCases.map((reviewCase) => {
    const bundle = repository.getCaseBundle(reviewCase.caseId)!;
    const missing: string[] = [];
    if (!bundle.replayInput) missing.push("replay_input_snapshot");
    if (!bundle.officialAnswer) missing.push("official_answer");
    if (bundle.case.promptFingerprint === "pending") {
      missing.push("resolved_prompt_fingerprint");
    }
    if (!bundle.blindPromptSnapshot) {
      missing.push("blind_generation_prompt_snapshot");
    }
    for (const system of ["A", "B"] as const) {
      if (!selectedEvidenceIds(bundle, system)) {
        missing.push(`selected_top16_${system}`);
      }
    }
    return {
      caseId: reviewCase.caseId,
      missing
    };
  }).filter((item) => item.missing.length > 0);
  return {
    totalCount: reviewCases.length,
    readyCount: reviewCases.length - failures.length,
    failedCount: failures.length,
    failures,
    generationPerformed: false as const
  };
}

export function voiceQaShadowReviewStatus(
  repository: VoiceQaShadowReviewRepository
) {
  const reports = buildVoiceQaShadowReviewReports(repository);
  const manifest = reports["dataset-manifest.json"];
  return {
    reviewStatus: manifest.reviewStatus,
    counts: manifest.counts,
    questionInputs: {
      count: manifest.questionInputs.count,
      missingCount: manifest.questionInputs.missingCount,
      bySourceKind: manifest.questionInputs.bySourceKind
    },
    readiness: manifest.readiness
  };
}
