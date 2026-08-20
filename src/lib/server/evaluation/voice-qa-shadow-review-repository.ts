import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { getDataRootDir } from "@/lib/server/storage/paths";

const DATABASE_FILE_NAME = "voice-qa-shadow-review-v1.sqlite";
const SAFE_USER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GOLD_CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export type VoiceQaShadowReviewScope = "current" | "week" | "all";
export type VoiceQaShadowReviewSystem = "A" | "B";
export const VOICE_QA_SHADOW_REQUIRED_FAULT_SCENARIOS = [
  "ssh_tunnel_down",
  "embedding_timeout",
  "embedding_model_revision_dimension_mismatch",
  "flat_sidecar_missing_vector",
  "redis_6380_restart",
  "worker_restart_retry"
] as const;
export type VoiceQaShadowRequiredFaultScenario =
  (typeof VOICE_QA_SHADOW_REQUIRED_FAULT_SCENARIOS)[number];
export type VoiceQaShadowReviewCaseStatus =
  | "pending"
  | "valid"
  | "invalid"
  | "ambiguous";
export type VoiceQaShadowReviewRunStatus =
  | "completed"
  | "fallback"
  | "failed";

export interface VoiceQaShadowReviewCaseInput {
  caseId: string;
  scope: VoiceQaShadowReviewScope;
  voiceSessionId: string;
  traceId: string;
  asrText: string;
  asrTextHash?: string;
  asrLatencyMs?: number | null;
  conversationContext: unknown;
  canonicalSnapshotId?: string | null;
  flatSnapshotId?: string | null;
  modelFingerprint: string;
  promptFingerprint: string;
  codeFingerprint: string;
  modelMetadata?: unknown;
  fallbackReason?: string | null;
  status?: VoiceQaShadowReviewCaseStatus;
  invalidReason?: string | null;
}

export interface StoredVoiceQaShadowReviewCase {
  caseId: string;
  userId: string;
  scope: VoiceQaShadowReviewScope;
  voiceSessionId: string;
  traceId: string;
  asrText: string;
  asrTextHash: string;
  asrLatencyMs: number | null;
  conversationContext: unknown;
  canonicalSnapshotId: string | null;
  flatSnapshotId: string | null;
  modelFingerprint: string;
  promptFingerprint: string;
  codeFingerprint: string;
  modelMetadata: unknown;
  fallbackReason: string | null;
  status: VoiceQaShadowReviewCaseStatus;
  invalidReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type VoiceQaShadowQuestionSourceKind =
  | "real_microphone"
  | "synthetic_voice"
  | "recorded_holdout";

export interface VoiceQaShadowQuestionInput {
  expectedText: string;
  expectedTextHash?: string;
  audioSha256: string;
  audioDurationMs: number;
  sourceKind: VoiceQaShadowQuestionSourceKind;
  metadata?: unknown;
}

export interface StoredVoiceQaShadowQuestionInput {
  caseId: string;
  expectedText: string;
  expectedTextHash: string;
  audioSha256: string;
  audioDurationMs: number;
  sourceKind: VoiceQaShadowQuestionSourceKind;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceQaShadowReplayInputSnapshotInput {
  version: "voice_qa_shadow_replay_input_v1";
  input: unknown;
  inputHash?: string;
}

export interface StoredVoiceQaShadowReplayInputSnapshot {
  caseId: string;
  version: "voice_qa_shadow_replay_input_v1";
  input: unknown;
  inputHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface CanonicalEvidenceInput {
  evidenceId: string;
  ordinal: number;
  content: string;
  contentHash?: string;
  metadata?: unknown;
}

export interface CanonicalEvidenceSnapshotInput {
  snapshotId: string;
  universeHash: string;
  contentHash: string;
  evidence: readonly CanonicalEvidenceInput[];
}

export interface StoredCanonicalEvidenceSnapshot {
  snapshotId: string;
  universeHash: string;
  contentHash: string;
  evidence: Array<{
    evidenceId: string;
    ordinal: number;
    content: string;
    contentHash: string;
    metadata: unknown;
  }>;
  createdAt: string;
}

export interface VoiceQaShadowQueryVectorInput {
  vector: readonly number[] | Float32Array;
  vectorHash?: string;
  modelName: string;
  modelRevision: string;
  dimension: number;
}

export interface StoredVoiceQaShadowQueryVector {
  caseId: string;
  vector: Float32Array;
  vectorHash: string;
  modelName: string;
  modelRevision: string;
  dimension: number;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceQaShadowRetrievalCandidateInput {
  evidenceId: string;
  rank: number;
  selectedRank?: number | null;
  score?: number | null;
  reason?: unknown;
}

export interface VoiceQaShadowRetrievalRunInput {
  system: VoiceQaShadowReviewSystem;
  replayIndex?: number;
  status: VoiceQaShadowReviewRunStatus;
  flatSnapshotId: string | null;
  denseLatencyMs?: number | null;
  totalLatencyMs: number;
  fallbackReason?: string | null;
  candidateValidity: boolean;
  inputHash: string;
  orderHash?: string;
  rankingMetadata?: unknown;
  memorySourceIds?: readonly string[];
  candidates: readonly VoiceQaShadowRetrievalCandidateInput[];
}

export interface StoredVoiceQaShadowRetrievalRun {
  runId: string;
  caseId: string;
  system: VoiceQaShadowReviewSystem;
  replayIndex: number;
  status: VoiceQaShadowReviewRunStatus;
  flatSnapshotId: string | null;
  denseLatencyMs: number | null;
  totalLatencyMs: number;
  fallbackReason: string | null;
  candidateValidity: boolean;
  inputHash: string;
  orderHash: string;
  rankingMetadata: unknown;
  memorySourceIds: string[];
  candidates: Array<{
    evidenceId: string;
    rank: number;
    selectedRank: number | null;
    score: number | null;
    reason: unknown;
  }>;
  createdAt: string;
  updatedAt: string;
}

export type VoiceQaShadowQaAttemptKind =
  | "stream_primary"
  | "sync_primary"
  | "sync_fallback"
  | "final_projection";

const QA_ATTEMPT_INDEX_BY_KIND: Record<
  VoiceQaShadowQaAttemptKind,
  number
> = {
  stream_primary: 0,
  sync_primary: 0,
  sync_fallback: 1,
  final_projection: 2
};

export interface VoiceQaShadowQaAttemptInput {
  attemptIndex: number;
  kind: VoiceQaShadowQaAttemptKind;
  status: "completed" | "failed" | "aborted";
  fallbackReason?: string | null;
  provider: string;
  model: string;
  promptFingerprint: string;
  codeFingerprint: string;
  answerText?: string | null;
  citations?: unknown;
  latencyMs?: number | null;
}

export interface StoredVoiceQaShadowQaAttempt {
  caseId: string;
  attemptIndex: number;
  kind: VoiceQaShadowQaAttemptKind;
  status: "completed" | "failed" | "aborted";
  fallbackReason: string | null;
  provider: string;
  model: string;
  promptFingerprint: string;
  codeFingerprint: string;
  answerText: string | null;
  answerHash: string | null;
  citations: unknown | null;
  citationsHash: string | null;
  latencyMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceQaShadowOfficialAnswerInput {
  answerText: string;
  citations: unknown;
  model: string;
  promptFingerprint: string;
  codeFingerprint: string;
  fallbackReason?: string | null;
  llmFirstTokenLatencyMs?: number | null;
  firstPlayableSentenceLatencyMs?: number | null;
  firstAudioLatencyMs?: number | null;
  completeLatencyMs?: number | null;
  streamingComplete?: boolean | null;
  ttsFailure?: string | null;
}

export interface StoredVoiceQaShadowOfficialAnswer
  extends VoiceQaShadowOfficialAnswerInput {
  caseId: string;
  answerHash: string;
  citationsHash: string;
  fallbackReason: string | null;
  llmFirstTokenLatencyMs: number | null;
  firstPlayableSentenceLatencyMs: number | null;
  firstAudioLatencyMs: number | null;
  completeLatencyMs: number | null;
  streamingComplete: boolean | null;
  ttsFailure: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceQaShadowBlindPromptSnapshotInput {
  status: "provider_prompt" | "no_provider_prompt";
  attemptKind: "sync_primary" | "sync_fallback" | "final_projection";
  systemPrompt?: string | null;
  userPromptPrefix?: string | null;
  evidenceSectionHash?: string | null;
  answerMode: "agent" | "direct";
  memoryCount: number;
  evidenceCount: number;
  lifecycleMetadata: unknown;
}

export interface StoredVoiceQaShadowBlindPromptSnapshot
  extends VoiceQaShadowBlindPromptSnapshotInput {
  caseId: string;
  systemPrompt: string | null;
  systemPromptHash: string | null;
  userPromptPrefix: string | null;
  userPromptPrefixHash: string | null;
  evidenceSectionHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceQaShadowGoldInput {
  status: "evaluable" | "ambiguous" | "excluded";
  evidenceGroups: readonly (readonly string[])[];
  requiredFacts: readonly string[];
  shouldRefuse: boolean;
  categories?: readonly string[];
  reviewerId?: string | null;
  notes?: string | null;
}

export interface StoredVoiceQaShadowGold {
  caseId: string;
  status: "evaluable" | "ambiguous" | "excluded";
  evidenceGroups: string[][];
  requiredFacts: string[];
  shouldRefuse: boolean;
  categories: string[];
  reviewerId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceQaShadowBlindAnswerInput {
  round: number;
  label: string;
  system: VoiceQaShadowReviewSystem;
  answerText: string;
  citations: unknown;
  citationValidity?: boolean | null;
  model: string;
  generationLatencyMs?: number | null;
}

export interface StoredVoiceQaShadowBlindAnswer
  extends VoiceQaShadowBlindAnswerInput {
  caseId: string;
  answerHash: string;
  citationsHash: string;
  citationValidity: boolean | null;
  generationLatencyMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceQaShadowBlindReviewInput {
  round: number;
  label: string;
  scores: unknown;
  hardViolations: readonly string[];
  outcome?: "win" | "tie" | "loss" | "unscored";
  reviewerId?: string | null;
}

export interface StoredVoiceQaShadowBlindReview
  extends VoiceQaShadowBlindReviewInput {
  caseId: string;
  outcome: "win" | "tie" | "loss" | "unscored";
  reviewerId: string | null;
  reviewedAt: string;
}

export interface VoiceQaShadowFaultRunInput {
  faultRunId: string;
  caseId?: string | null;
  scenario: string;
  status: "completed" | "failed" | "aborted";
  shadowError?: string | null;
  expectedOfficialAnswerHash?: string | null;
  actualOfficialAnswerHash?: string | null;
  expectedCitationHash?: string | null;
  actualCitationHash?: string | null;
  voiceUninterrupted?: boolean | null;
  lexicalFailOpen?: boolean | null;
  citationsValid?: boolean | null;
  shadowLatencyMs?: number | null;
  metadata?: unknown;
}

export interface StoredVoiceQaShadowFaultRun
  extends VoiceQaShadowFaultRunInput {
  userId: string;
  caseId: string | null;
  shadowError: string | null;
  expectedOfficialAnswerHash: string | null;
  actualOfficialAnswerHash: string | null;
  expectedCitationHash: string | null;
  actualCitationHash: string | null;
  voiceUninterrupted: boolean | null;
  lexicalFailOpen: boolean | null;
  citationsValid: boolean | null;
  shadowLatencyMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceQaShadowReviewCaseBundleInput {
  case: VoiceQaShadowReviewCaseInput;
  questionInput?: VoiceQaShadowQuestionInput;
  replayInput?: VoiceQaShadowReplayInputSnapshotInput;
  canonicalSnapshot?: CanonicalEvidenceSnapshotInput;
  queryVector?: VoiceQaShadowQueryVectorInput;
  retrievalRuns?: readonly VoiceQaShadowRetrievalRunInput[];
  qaAttempts?: readonly VoiceQaShadowQaAttemptInput[];
  officialAnswer?: VoiceQaShadowOfficialAnswerInput;
  blindPromptSnapshot?: VoiceQaShadowBlindPromptSnapshotInput;
  gold?: VoiceQaShadowGoldInput;
  blindAnswers?: readonly VoiceQaShadowBlindAnswerInput[];
  blindReviews?: readonly VoiceQaShadowBlindReviewInput[];
  faultRuns?: readonly Omit<VoiceQaShadowFaultRunInput, "caseId">[];
}

export interface StoredVoiceQaShadowReviewCaseBundle {
  case: StoredVoiceQaShadowReviewCase;
  questionInput: StoredVoiceQaShadowQuestionInput | null;
  replayInput: StoredVoiceQaShadowReplayInputSnapshot | null;
  canonicalSnapshot: StoredCanonicalEvidenceSnapshot | null;
  queryVector: StoredVoiceQaShadowQueryVector | null;
  retrievalRuns: StoredVoiceQaShadowRetrievalRun[];
  qaAttempts: StoredVoiceQaShadowQaAttempt[];
  officialAnswer: StoredVoiceQaShadowOfficialAnswer | null;
  blindPromptSnapshot: StoredVoiceQaShadowBlindPromptSnapshot | null;
  gold: StoredVoiceQaShadowGold | null;
  blindAnswers: StoredVoiceQaShadowBlindAnswer[];
  blindReviews: StoredVoiceQaShadowBlindReview[];
  faultRuns: StoredVoiceQaShadowFaultRun[];
}

type CaseRow = {
  case_id: string;
  user_id: string;
  scope: VoiceQaShadowReviewScope;
  voice_session_id: string;
  trace_id: string;
  asr_text: string;
  asr_text_hash: string;
  asr_latency_ms: number | null;
  conversation_context_json: string;
  canonical_snapshot_id: string | null;
  flat_snapshot_id: string | null;
  hnav_snapshot_id: string | null;
  model_fingerprint: string;
  prompt_fingerprint: string;
  code_fingerprint: string;
  model_metadata_json: string;
  fallback_reason: string | null;
  status: VoiceQaShadowReviewCaseStatus;
  invalid_reason: string | null;
  created_at: string;
  updated_at: string;
};

type SnapshotRow = {
  snapshot_id: string;
  universe_hash: string;
  content_hash: string;
  created_at: string;
};

type QuestionInputRow = {
  case_id: string;
  expected_text: string;
  expected_text_hash: string;
  audio_sha256: string;
  audio_duration_ms: number;
  source_kind: VoiceQaShadowQuestionSourceKind;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

type ReplayInputRow = {
  case_id: string;
  snapshot_version: "voice_qa_shadow_replay_input_v1";
  input_json: string;
  input_hash: string;
  created_at: string;
  updated_at: string;
};

type EvidenceRow = {
  evidence_id: string;
  ordinal: number;
  content: string;
  content_hash: string;
  metadata_json: string;
};

type VectorRow = {
  case_id: string;
  vector: Buffer;
  vector_sha256: string;
  model_name: string;
  model_revision: string;
  dimension: number;
  created_at: string;
  updated_at: string;
};

type RetrievalRunRow = {
  run_id: string;
  case_id: string;
  system_code: VoiceQaShadowReviewSystem;
  replay_index: number;
  status: VoiceQaShadowReviewRunStatus;
  flat_snapshot_id: string | null;
  hnav_snapshot_id: string | null;
  dense_latency_ms: number | null;
  navigation_latency_ms: number | null;
  total_latency_ms: number;
  fallback_reason: string | null;
  candidate_validity: number;
  input_hash: string;
  order_hash: string;
  ranking_metadata_json: string;
  memory_source_ids_json: string;
  created_at: string;
  updated_at: string;
};

type CandidateRow = {
  evidence_id: string;
  pool_rank: number;
  selected_rank: number | null;
  score: number | null;
  reason_json: string;
};

type QaAttemptRow = {
  case_id: string;
  attempt_index: number;
  attempt_kind: VoiceQaShadowQaAttemptKind;
  status: "completed" | "failed" | "aborted";
  fallback_reason: string | null;
  provider: string;
  model: string;
  prompt_fingerprint: string;
  code_fingerprint: string;
  answer_text: string | null;
  answer_hash: string | null;
  citations_json: string | null;
  citations_hash: string | null;
  latency_ms: number | null;
  created_at: string;
  updated_at: string;
};

type OfficialAnswerRow = {
  case_id: string;
  answer_text: string;
  answer_hash: string;
  citations_json: string;
  citations_hash: string;
  model: string;
  prompt_fingerprint: string;
  code_fingerprint: string;
  fallback_reason: string | null;
  llm_first_token_latency_ms: number | null;
  first_playable_sentence_latency_ms: number | null;
  first_audio_latency_ms: number | null;
  complete_latency_ms: number | null;
  streaming_complete: number | null;
  tts_failure: string | null;
  created_at: string;
  updated_at: string;
};

type BlindPromptSnapshotRow = {
  case_id: string;
  status: "provider_prompt" | "no_provider_prompt";
  attempt_kind: "sync_primary" | "sync_fallback" | "final_projection";
  system_prompt: string | null;
  system_prompt_hash: string | null;
  user_prompt_prefix: string | null;
  user_prompt_prefix_hash: string | null;
  evidence_section_hash: string | null;
  answer_mode: "agent" | "direct";
  memory_count: number;
  evidence_count: number;
  lifecycle_metadata_json: string;
  created_at: string;
  updated_at: string;
};

type GoldRow = {
  case_id: string;
  status: "evaluable" | "ambiguous" | "excluded";
  evidence_groups_json: string;
  required_facts_json: string;
  should_refuse: number;
  categories_json: string;
  reviewer_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type BlindAnswerRow = {
  case_id: string;
  review_round: number;
  answer_label: string;
  system_code: VoiceQaShadowReviewSystem;
  answer_text: string;
  answer_hash: string;
  citations_json: string;
  citations_hash: string;
  citation_validity: number | null;
  model: string;
  generation_latency_ms: number | null;
  created_at: string;
  updated_at: string;
};

type BlindReviewRow = {
  case_id: string;
  review_round: number;
  answer_label: string;
  scores_json: string;
  hard_violations_json: string;
  outcome: "win" | "tie" | "loss" | "unscored";
  reviewer_id: string | null;
  reviewed_at: string;
};

type FaultRunRow = {
  fault_run_id: string;
  case_id: string | null;
  user_id: string;
  scenario: string;
  status: "completed" | "failed" | "aborted";
  shadow_error: string | null;
  expected_official_answer_hash: string | null;
  actual_official_answer_hash: string | null;
  expected_citation_hash: string | null;
  actual_citation_hash: string | null;
  voice_uninterrupted: number | null;
  lexical_fail_open: number | null;
  citations_valid: number | null;
  shadow_latency_ms: number | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

function assertSafeUserId(userId: string) {
  if (
    !SAFE_USER_ID_PATTERN.test(userId) ||
    userId.length > 128
  ) {
    throw new Error("Invalid voice QA shadow review user id");
  }
  return userId;
}

function assertIdentifier(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function optionalIdentifier(value: string | null | undefined, label: string) {
  return value === null || value === undefined
    ? null
    : assertIdentifier(value, label);
}

function assertSha256(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

export function hashVoiceQaShadowReviewText(value: string) {
  return sha256(value);
}

function serializeJson(value: unknown, label: string) {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable`);
  }
  if (serialized === undefined) {
    throw new Error(`${label} must be JSON serializable`);
  }
  return serialized;
}

function parseJson(value: string) {
  return JSON.parse(value) as unknown;
}

function assertNonNegativeNumber(
  value: number | null | undefined,
  label: string
) {
  if (
    value !== null &&
    value !== undefined &&
    (!Number.isFinite(value) || value < 0)
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value ?? null;
}

function nullableBoolean(value: boolean | null | undefined) {
  return value === null || value === undefined ? null : value ? 1 : 0;
}

function booleanFromRow(value: number | null) {
  return value === null ? null : value === 1;
}

function float32Buffer(
  vector: readonly number[] | Float32Array,
  dimension: number
) {
  if (!Number.isInteger(dimension) || dimension <= 0 || dimension > 100_000) {
    throw new Error("Invalid query vector dimension");
  }
  if (vector.length !== dimension) {
    throw new Error(
      `Query vector dimension mismatch: expected ${dimension}, got ${vector.length}`
    );
  }
  const normalized = new Float32Array(dimension);
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(`Invalid query vector value at index ${index}`);
    }
    normalized[index] = value;
  }
  return Buffer.from(
    normalized.buffer,
    normalized.byteOffset,
    normalized.byteLength
  );
}

function float32FromBuffer(value: Buffer, dimension: number) {
  if (value.byteLength !== dimension * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error("Stored query vector dimension mismatch");
  }
  const copy = Buffer.from(value);
  return new Float32Array(
    copy.buffer,
    copy.byteOffset,
    dimension
  ).slice();
}

function normalizedCandidates(
  candidates: readonly VoiceQaShadowRetrievalCandidateInput[]
) {
  if (candidates.length > 30) {
    throw new Error("A retrieval run cannot store more than Top-30 candidates");
  }
  const rankSet = new Set<number>();
  const selectedRankSet = new Set<number>();
  const evidenceIdSet = new Set<string>();
  return candidates.map((candidate) => {
    const evidenceId = assertIdentifier(candidate.evidenceId, "candidate evidence id");
    if (
      !Number.isInteger(candidate.rank) ||
      candidate.rank < 1 ||
      candidate.rank > 30 ||
      rankSet.has(candidate.rank)
    ) {
      throw new Error("Candidate ranks must be unique integers from 1 through 30");
    }
    rankSet.add(candidate.rank);
    if (evidenceIdSet.has(evidenceId)) {
      throw new Error("Candidate evidence ids must be unique within a retrieval run");
    }
    evidenceIdSet.add(evidenceId);

    const selectedRank = candidate.selectedRank ?? null;
    if (
      selectedRank !== null &&
      (
        !Number.isInteger(selectedRank) ||
        selectedRank < 1 ||
        selectedRank > 16 ||
        selectedRankSet.has(selectedRank)
      )
    ) {
      throw new Error("Selected ranks must be unique integers from 1 through 16");
    }
    if (selectedRank !== null) selectedRankSet.add(selectedRank);
    const score = candidate.score ?? null;
    if (score !== null && !Number.isFinite(score)) {
      throw new Error("Invalid candidate score");
    }
    return {
      evidenceId,
      rank: candidate.rank,
      selectedRank,
      score,
      reasonJson: serializeJson(candidate.reason ?? null, "candidate reason")
    };
  }).sort((left, right) => left.rank - right.rank);
}

function retrievalOrderHash(
  candidates: readonly {
    evidenceId: string;
    rank: number;
    selectedRank: number | null;
  }[]
) {
  return sha256(JSON.stringify(
    candidates.map(({ evidenceId, rank, selectedRank }) => ({
      evidenceId,
      rank,
      selectedRank
    }))
  ));
}

function stableRunId(
  caseId: string,
  system: VoiceQaShadowReviewSystem,
  replayIndex: number
) {
  return `retrieval_${sha256(`${caseId}\0${system}\0${replayIndex}`)}`;
}

function caseFromRow(row: CaseRow): StoredVoiceQaShadowReviewCase {
  return {
    caseId: row.case_id,
    userId: row.user_id,
    scope: row.scope,
    voiceSessionId: row.voice_session_id,
    traceId: row.trace_id,
    asrText: row.asr_text,
    asrTextHash: row.asr_text_hash,
    asrLatencyMs: row.asr_latency_ms,
    conversationContext: parseJson(row.conversation_context_json),
    canonicalSnapshotId: row.canonical_snapshot_id,
    flatSnapshotId: row.flat_snapshot_id,
    modelFingerprint: row.model_fingerprint,
    promptFingerprint: row.prompt_fingerprint,
    codeFingerprint: row.code_fingerprint,
    modelMetadata: parseJson(row.model_metadata_json),
    fallbackReason: row.fallback_reason,
    status: row.status,
    invalidReason: row.invalid_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function getVoiceQaShadowReviewDatabasePath(
  userId: string,
  dataRoot = getDataRootDir()
) {
  const safeUserId = assertSafeUserId(userId);
  return resolve(
    join(dataRoot, "users", safeUserId, "evaluation", DATABASE_FILE_NAME)
  );
}

function createSchema(database: Database.Database) {
  const legacyQaAttempts = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'qa_attempts'
  `).get() as { sql: string | null } | undefined;
  if (
    legacyQaAttempts?.sql &&
    !legacyQaAttempts.sql.includes("final_projection")
  ) {
    database.exec(`
      ALTER TABLE qa_attempts RENAME TO qa_attempts_legacy_v4;
      CREATE TABLE qa_attempts (
        case_id TEXT NOT NULL,
        attempt_index INTEGER NOT NULL CHECK (attempt_index >= 0),
        attempt_kind TEXT NOT NULL
          CHECK (attempt_kind IN (
            'stream_primary', 'sync_primary', 'sync_fallback', 'final_projection'
          )),
        status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'aborted')),
        fallback_reason TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_fingerprint TEXT NOT NULL,
        code_fingerprint TEXT NOT NULL,
        answer_text TEXT,
        answer_hash TEXT,
        citations_json TEXT,
        citations_hash TEXT,
        latency_ms REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (case_id, attempt_index),
        FOREIGN KEY (case_id)
          REFERENCES review_cases(case_id)
          ON DELETE CASCADE
      );
      INSERT INTO qa_attempts (
        case_id, attempt_index, attempt_kind, status, fallback_reason,
        provider, model, prompt_fingerprint, code_fingerprint,
        answer_text, answer_hash, citations_json, citations_hash,
        latency_ms, created_at, updated_at
      )
      SELECT
        case_id,
        attempt_index,
        CASE
          WHEN attempt_kind = 'stream_final' THEN 'final_projection'
          ELSE attempt_kind
        END,
        status,
        fallback_reason,
        provider,
        model,
        prompt_fingerprint,
        code_fingerprint,
        answer_text,
        answer_hash,
        citations_json,
        citations_hash,
        latency_ms,
        created_at,
        updated_at
      FROM qa_attempts_legacy_v4;
      DROP TABLE qa_attempts_legacy_v4;
    `);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS review_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS canonical_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      universe_hash TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS canonical_evidence (
      snapshot_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, evidence_id),
      UNIQUE (snapshot_id, ordinal),
      FOREIGN KEY (snapshot_id)
        REFERENCES canonical_snapshots(snapshot_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS review_cases (
      case_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('current', 'week', 'all')),
      voice_session_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      asr_text TEXT NOT NULL,
      asr_text_hash TEXT NOT NULL,
      asr_latency_ms REAL,
      conversation_context_json TEXT NOT NULL,
      canonical_snapshot_id TEXT,
      flat_snapshot_id TEXT,
      hnav_snapshot_id TEXT,
      model_fingerprint TEXT NOT NULL,
      prompt_fingerprint TEXT NOT NULL,
      code_fingerprint TEXT NOT NULL,
      model_metadata_json TEXT NOT NULL,
      fallback_reason TEXT,
      status TEXT NOT NULL
        CHECK (status IN ('pending', 'valid', 'invalid', 'ambiguous')),
      invalid_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (canonical_snapshot_id)
        REFERENCES canonical_snapshots(snapshot_id)
        ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS question_inputs (
      case_id TEXT PRIMARY KEY,
      expected_text TEXT NOT NULL,
      expected_text_hash TEXT NOT NULL,
      audio_sha256 TEXT NOT NULL,
      audio_duration_ms REAL NOT NULL CHECK (audio_duration_ms >= 0),
      source_kind TEXT NOT NULL
        CHECK (source_kind IN ('real_microphone', 'synthetic_voice', 'recorded_holdout')),
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (case_id)
        REFERENCES review_cases(case_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS case_replay_inputs (
      case_id TEXT PRIMARY KEY,
      snapshot_version TEXT NOT NULL
        CHECK (snapshot_version = 'voice_qa_shadow_replay_input_v1'),
      input_json TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (case_id)
        REFERENCES review_cases(case_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS case_query_vectors (
      case_id TEXT PRIMARY KEY,
      vector BLOB NOT NULL,
      vector_sha256 TEXT NOT NULL,
      model_name TEXT NOT NULL,
      model_revision TEXT NOT NULL,
      dimension INTEGER NOT NULL CHECK (dimension > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (case_id)
        REFERENCES review_cases(case_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS retrieval_runs (
      run_id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      system_code TEXT NOT NULL CHECK (system_code IN ('A', 'B', 'C')),
      replay_index INTEGER NOT NULL CHECK (replay_index >= 0),
      status TEXT NOT NULL CHECK (status IN ('completed', 'fallback', 'failed')),
      flat_snapshot_id TEXT,
      hnav_snapshot_id TEXT,
      dense_latency_ms REAL,
      navigation_latency_ms REAL,
      total_latency_ms REAL NOT NULL,
      fallback_reason TEXT,
      candidate_validity INTEGER NOT NULL CHECK (candidate_validity IN (0, 1)),
      input_hash TEXT NOT NULL,
      order_hash TEXT NOT NULL,
      ranking_metadata_json TEXT NOT NULL,
      memory_source_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (case_id, system_code, replay_index),
      FOREIGN KEY (case_id)
        REFERENCES review_cases(case_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS retrieval_candidates (
      run_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      pool_rank INTEGER NOT NULL CHECK (pool_rank BETWEEN 1 AND 30),
      selected_rank INTEGER CHECK (selected_rank BETWEEN 1 AND 16),
      score REAL,
      reason_json TEXT NOT NULL,
      PRIMARY KEY (run_id, evidence_id),
      UNIQUE (run_id, pool_rank),
      UNIQUE (run_id, selected_rank),
      FOREIGN KEY (run_id)
        REFERENCES retrieval_runs(run_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS qa_attempts (
      case_id TEXT NOT NULL,
      attempt_index INTEGER NOT NULL CHECK (attempt_index >= 0),
      attempt_kind TEXT NOT NULL
        CHECK (attempt_kind IN (
          'stream_primary', 'sync_primary', 'sync_fallback', 'final_projection'
        )),
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'aborted')),
      fallback_reason TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_fingerprint TEXT NOT NULL,
      code_fingerprint TEXT NOT NULL,
      answer_text TEXT,
      answer_hash TEXT,
      citations_json TEXT,
      citations_hash TEXT,
      latency_ms REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (case_id, attempt_index),
      FOREIGN KEY (case_id)
        REFERENCES review_cases(case_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS official_answers (
      case_id TEXT PRIMARY KEY,
      answer_text TEXT NOT NULL,
      answer_hash TEXT NOT NULL,
      citations_json TEXT NOT NULL,
      citations_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_fingerprint TEXT NOT NULL,
      code_fingerprint TEXT NOT NULL,
      fallback_reason TEXT,
      llm_first_token_latency_ms REAL,
      first_playable_sentence_latency_ms REAL,
      first_audio_latency_ms REAL,
      complete_latency_ms REAL,
      streaming_complete INTEGER CHECK (streaming_complete IN (0, 1)),
      tts_failure TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (case_id)
        REFERENCES review_cases(case_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS blind_prompt_snapshots (
      case_id TEXT PRIMARY KEY,
      status TEXT NOT NULL
        CHECK (status IN ('provider_prompt', 'no_provider_prompt')),
      attempt_kind TEXT NOT NULL
        CHECK (attempt_kind IN ('sync_primary', 'sync_fallback', 'final_projection')),
      system_prompt TEXT,
      system_prompt_hash TEXT,
      user_prompt_prefix TEXT,
      user_prompt_prefix_hash TEXT,
      evidence_section_hash TEXT,
      answer_mode TEXT NOT NULL CHECK (answer_mode IN ('agent', 'direct')),
      memory_count INTEGER NOT NULL CHECK (memory_count >= 0),
      evidence_count INTEGER NOT NULL CHECK (evidence_count >= 0),
      lifecycle_metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (
          status = 'provider_prompt'
          AND system_prompt IS NOT NULL
          AND system_prompt_hash IS NOT NULL
          AND user_prompt_prefix IS NOT NULL
          AND user_prompt_prefix_hash IS NOT NULL
          AND evidence_section_hash IS NOT NULL
        )
        OR
        (
          status = 'no_provider_prompt'
          AND system_prompt IS NULL
          AND system_prompt_hash IS NULL
          AND user_prompt_prefix IS NULL
          AND user_prompt_prefix_hash IS NULL
          AND evidence_section_hash IS NULL
        )
      ),
      FOREIGN KEY (case_id)
        REFERENCES review_cases(case_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gold_annotations (
      case_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('evaluable', 'ambiguous', 'excluded')),
      evidence_groups_json TEXT NOT NULL,
      required_facts_json TEXT NOT NULL,
      should_refuse INTEGER NOT NULL CHECK (should_refuse IN (0, 1)),
      categories_json TEXT NOT NULL DEFAULT '[]',
      reviewer_id TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (case_id)
        REFERENCES review_cases(case_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS blind_answers (
      case_id TEXT NOT NULL,
      review_round INTEGER NOT NULL CHECK (review_round > 0),
      answer_label TEXT NOT NULL,
      system_code TEXT NOT NULL CHECK (system_code IN ('A', 'B', 'C')),
      answer_text TEXT NOT NULL,
      answer_hash TEXT NOT NULL,
      citations_json TEXT NOT NULL,
      citations_hash TEXT NOT NULL,
      citation_validity INTEGER CHECK (citation_validity IN (0, 1)),
      model TEXT NOT NULL,
      generation_latency_ms REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (case_id, review_round, answer_label),
      UNIQUE (case_id, review_round, system_code),
      FOREIGN KEY (case_id)
        REFERENCES review_cases(case_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS blind_reviews (
      case_id TEXT NOT NULL,
      review_round INTEGER NOT NULL CHECK (review_round > 0),
      answer_label TEXT NOT NULL,
      scores_json TEXT NOT NULL,
      hard_violations_json TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('win', 'tie', 'loss', 'unscored')),
      reviewer_id TEXT,
      reviewed_at TEXT NOT NULL,
      PRIMARY KEY (case_id, review_round, answer_label),
      FOREIGN KEY (case_id, review_round, answer_label)
        REFERENCES blind_answers(case_id, review_round, answer_label)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS fault_runs (
      fault_run_id TEXT PRIMARY KEY,
      case_id TEXT,
      user_id TEXT NOT NULL,
      scenario TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'aborted')),
      shadow_error TEXT,
      expected_official_answer_hash TEXT,
      actual_official_answer_hash TEXT,
      expected_citation_hash TEXT,
      actual_citation_hash TEXT,
      voice_uninterrupted INTEGER CHECK (voice_uninterrupted IN (0, 1)),
      lexical_fail_open INTEGER CHECK (lexical_fail_open IN (0, 1)),
      citations_valid INTEGER CHECK (citations_valid IN (0, 1)),
      shadow_latency_ms REAL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (case_id)
        REFERENCES review_cases(case_id)
        ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_review_cases_scope_created
      ON review_cases(scope, created_at, case_id);
    CREATE INDEX IF NOT EXISTS idx_retrieval_runs_case
      ON retrieval_runs(case_id, system_code, replay_index);
    CREATE INDEX IF NOT EXISTS idx_qa_attempts_case
      ON qa_attempts(case_id, attempt_index);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_attempts_case_kind
      ON qa_attempts(case_id, attempt_kind);
    CREATE INDEX IF NOT EXISTS idx_fault_runs_case
      ON fault_runs(case_id, created_at);
  `);
  const goldColumns = database
    .prepare("PRAGMA table_info(gold_annotations)")
    .all() as Array<{ name: string }>;
  if (!goldColumns.some((column) => column.name === "categories_json")) {
    database.exec(
      "ALTER TABLE gold_annotations ADD COLUMN categories_json TEXT NOT NULL DEFAULT '[]'"
    );
  }
  const blindAnswerColumns = database
    .prepare("PRAGMA table_info(blind_answers)")
    .all() as Array<{ name: string }>;
  if (
    !blindAnswerColumns.some(
      (column) => column.name === "citation_validity"
    )
  ) {
    database.exec(
      "ALTER TABLE blind_answers ADD COLUMN citation_validity INTEGER " +
      "CHECK (citation_validity IN (0, 1))"
    );
  }
  const officialAnswerColumns = database
    .prepare("PRAGMA table_info(official_answers)")
    .all() as Array<{ name: string }>;
  if (
    !officialAnswerColumns.some(
      (column) => column.name === "first_audio_latency_ms"
    )
  ) {
    database.exec(
      "ALTER TABLE official_answers ADD COLUMN first_audio_latency_ms REAL"
    );
  }
}

export class VoiceQaShadowReviewRepository {
  readonly filePath: string;
  private readonly database: Database.Database;
  private readonly userId: string;
  private readonly now: () => string;

  constructor(input: {
    userId: string;
    filePath?: string;
    dataRoot?: string;
    now?: () => string;
  }) {
    this.userId = assertSafeUserId(input.userId);
    this.filePath = input.filePath === ":memory:"
      ? ":memory:"
      : resolve(
        input.filePath ??
          getVoiceQaShadowReviewDatabasePath(this.userId, input.dataRoot)
      );
    this.now = input.now ?? (() => new Date().toISOString());
    if (this.filePath !== ":memory:") {
      mkdirSync(dirname(this.filePath), { recursive: true });
    }
    this.database = new Database(this.filePath);
    try {
      this.database.pragma("foreign_keys = ON");
      this.database.pragma("busy_timeout = 5000");
      if (this.filePath !== ":memory:") {
        this.database.pragma("journal_mode = WAL");
        this.database.pragma("synchronous = NORMAL");
      }
      createSchema(this.database);
      this.bindDatabaseToUser();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private bindDatabaseToUser() {
    this.database.prepare(`
      INSERT INTO review_metadata (key, value)
      VALUES ('owner_user_id', ?)
      ON CONFLICT (key) DO NOTHING
    `).run(this.userId);
    const owner = this.database.prepare(`
      SELECT value FROM review_metadata WHERE key = 'owner_user_id'
    `).get() as { value: string } | undefined;
    if (owner?.value !== this.userId) {
      throw new Error("Voice QA shadow review database belongs to another user");
    }
    this.database.prepare(`
      INSERT INTO review_metadata (key, value)
      VALUES ('schema_version', '8')
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `).run();
  }

  close() {
    if (this.database.open) this.database.close();
  }

  databaseSettings() {
    return {
      foreignKeys: this.database.pragma("foreign_keys", { simple: true }) as number,
      busyTimeout: this.database.pragma("busy_timeout", { simple: true }) as number,
      journalMode: this.database.pragma("journal_mode", { simple: true }) as string
    };
  }

  upsertCanonicalSnapshot(
    input: CanonicalEvidenceSnapshotInput
  ): StoredCanonicalEvidenceSnapshot {
    const snapshotId = assertIdentifier(input.snapshotId, "canonical snapshot id");
    const universeHash = assertSha256(input.universeHash, "canonical universe hash");
    const contentHash = assertSha256(input.contentHash, "canonical content hash");
    const evidenceIdSet = new Set<string>();
    const ordinalSet = new Set<number>();
    const evidence = input.evidence.map((item) => {
      const evidenceId = assertIdentifier(item.evidenceId, "canonical evidence id");
      if (evidenceIdSet.has(evidenceId)) {
        throw new Error("Canonical evidence ids must be unique");
      }
      evidenceIdSet.add(evidenceId);
      if (!Number.isInteger(item.ordinal) || item.ordinal < 0 || ordinalSet.has(item.ordinal)) {
        throw new Error("Canonical evidence ordinals must be unique non-negative integers");
      }
      ordinalSet.add(item.ordinal);
      const actualContentHash = sha256(item.content);
      const suppliedContentHash = item.contentHash === undefined
        ? actualContentHash
        : assertSha256(item.contentHash, "canonical evidence content hash");
      if (suppliedContentHash !== actualContentHash) {
        throw new Error(`Canonical evidence content hash mismatch for ${evidenceId}`);
      }
      return {
        evidenceId,
        ordinal: item.ordinal,
        content: item.content,
        contentHash: actualContentHash,
        metadataJson: serializeJson(item.metadata ?? null, "canonical evidence metadata")
      };
    }).sort((left, right) => left.ordinal - right.ordinal);

    const run = this.database.transaction(() => {
      const existing = this.database.prepare(`
        SELECT * FROM canonical_snapshots WHERE snapshot_id = ?
      `).get(snapshotId) as SnapshotRow | undefined;
      if (
        existing &&
        (
          existing.universe_hash !== universeHash ||
          existing.content_hash !== contentHash
        )
      ) {
        throw new Error("Canonical snapshot id is already bound to different content");
      }
      const timestamp = existing?.created_at ?? this.now();
      this.database.prepare(`
        INSERT INTO canonical_snapshots (
          snapshot_id, universe_hash, content_hash, created_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT (snapshot_id) DO NOTHING
      `).run(snapshotId, universeHash, contentHash, timestamp);
      this.database.prepare(`
        DELETE FROM canonical_evidence WHERE snapshot_id = ?
      `).run(snapshotId);
      const insertEvidence = this.database.prepare(`
        INSERT INTO canonical_evidence (
          snapshot_id, evidence_id, ordinal, content, content_hash, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const item of evidence) {
        insertEvidence.run(
          snapshotId,
          item.evidenceId,
          item.ordinal,
          item.content,
          item.contentHash,
          item.metadataJson
        );
      }
    });
    run();
    return this.getCanonicalSnapshot(snapshotId)!;
  }

  getCanonicalSnapshot(
    snapshotIdInput: string
  ): StoredCanonicalEvidenceSnapshot | null {
    const snapshotId = assertIdentifier(snapshotIdInput, "canonical snapshot id");
    const snapshot = this.database.prepare(`
      SELECT * FROM canonical_snapshots WHERE snapshot_id = ?
    `).get(snapshotId) as SnapshotRow | undefined;
    if (!snapshot) return null;
    const evidence = this.database.prepare(`
      SELECT evidence_id, ordinal, content, content_hash, metadata_json
      FROM canonical_evidence
      WHERE snapshot_id = ?
      ORDER BY ordinal ASC, evidence_id ASC
    `).all(snapshotId) as EvidenceRow[];
    return {
      snapshotId: snapshot.snapshot_id,
      universeHash: snapshot.universe_hash,
      contentHash: snapshot.content_hash,
      evidence: evidence.map((item) => ({
        evidenceId: item.evidence_id,
        ordinal: item.ordinal,
        content: item.content,
        contentHash: item.content_hash,
        metadata: parseJson(item.metadata_json)
      })),
      createdAt: snapshot.created_at
    };
  }

  upsertCase(input: VoiceQaShadowReviewCaseInput) {
    const caseId = assertIdentifier(input.caseId, "review case id");
    const asrTextHash = input.asrTextHash === undefined
      ? sha256(input.asrText)
      : assertSha256(input.asrTextHash, "ASR text hash");
    if (asrTextHash !== sha256(input.asrText)) {
      throw new Error("ASR text hash does not match ASR text");
    }
    const existing = this.database.prepare(`
      SELECT * FROM review_cases WHERE case_id = ?
    `).get(caseId) as CaseRow | undefined;
    if (
      existing &&
      (
        existing.user_id !== this.userId ||
        existing.asr_text_hash !== asrTextHash ||
        existing.asr_text !== input.asrText
      )
    ) {
      throw new Error("Review case id is already bound to different ASR input");
    }
    const timestamp = this.now();
    const canonicalSnapshotId = optionalIdentifier(
      input.canonicalSnapshotId,
      "canonical snapshot id"
    );
    this.database.prepare(`
      INSERT INTO review_cases (
        case_id, user_id, scope, voice_session_id, trace_id,
        asr_text, asr_text_hash, asr_latency_ms, conversation_context_json,
        canonical_snapshot_id, flat_snapshot_id, hnav_snapshot_id,
        model_fingerprint, prompt_fingerprint, code_fingerprint,
        model_metadata_json, fallback_reason, status, invalid_reason,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?
      )
      ON CONFLICT (case_id) DO UPDATE SET
        scope = excluded.scope,
        voice_session_id = excluded.voice_session_id,
        trace_id = excluded.trace_id,
        asr_latency_ms = excluded.asr_latency_ms,
        conversation_context_json = excluded.conversation_context_json,
        canonical_snapshot_id = excluded.canonical_snapshot_id,
        flat_snapshot_id = excluded.flat_snapshot_id,
        hnav_snapshot_id = excluded.hnav_snapshot_id,
        model_fingerprint = excluded.model_fingerprint,
        prompt_fingerprint = excluded.prompt_fingerprint,
        code_fingerprint = excluded.code_fingerprint,
        model_metadata_json = excluded.model_metadata_json,
        fallback_reason = excluded.fallback_reason,
        status = excluded.status,
        invalid_reason = excluded.invalid_reason,
        updated_at = excluded.updated_at
    `).run(
      caseId,
      this.userId,
      input.scope,
      assertIdentifier(input.voiceSessionId, "voice session id"),
      assertIdentifier(input.traceId, "trace id"),
      input.asrText,
      asrTextHash,
      assertNonNegativeNumber(input.asrLatencyMs, "ASR latency"),
      serializeJson(input.conversationContext, "conversation context"),
      canonicalSnapshotId,
      optionalIdentifier(input.flatSnapshotId, "flat snapshot id"),
      null,
      assertIdentifier(input.modelFingerprint, "model fingerprint"),
      assertIdentifier(input.promptFingerprint, "prompt fingerprint"),
      assertIdentifier(input.codeFingerprint, "code fingerprint"),
      serializeJson(input.modelMetadata ?? null, "model metadata"),
      input.fallbackReason ?? null,
      input.status ?? "pending",
      input.invalidReason ?? null,
      existing?.created_at ?? timestamp,
      timestamp
    );
    return this.getCase(caseId)!;
  }

  getCase(caseIdInput: string) {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    const row = this.database.prepare(`
      SELECT * FROM review_cases WHERE case_id = ? AND user_id = ?
    `).get(caseId, this.userId) as CaseRow | undefined;
    return row ? caseFromRow(row) : null;
  }

  listCases(input: {
    scope?: VoiceQaShadowReviewScope;
    limit?: number;
  } = {}) {
    const limit = Math.max(1, Math.min(10_000, Math.floor(input.limit ?? 100)));
    const rows = input.scope
      ? this.database.prepare(`
          SELECT * FROM review_cases
          WHERE user_id = ? AND scope = ?
          ORDER BY created_at ASC, case_id ASC
          LIMIT ?
        `).all(this.userId, input.scope, limit)
      : this.database.prepare(`
          SELECT * FROM review_cases
          WHERE user_id = ?
          ORDER BY created_at ASC, case_id ASC
          LIMIT ?
        `).all(this.userId, limit);
    return (rows as CaseRow[]).map(caseFromRow);
  }

  upsertQuestionInput(
    caseIdInput: string,
    input: VoiceQaShadowQuestionInput
  ) {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    if (!this.getCase(caseId)) throw new Error("Review case does not exist");
    const expectedTextHash = input.expectedTextHash === undefined
      ? sha256(input.expectedText)
      : assertSha256(input.expectedTextHash, "expected question text hash");
    if (expectedTextHash !== sha256(input.expectedText)) {
      throw new Error(
        "Expected question text hash does not match expected question text"
      );
    }
    const audioSha256 = assertSha256(
      input.audioSha256,
      "question audio hash"
    );
    const audioDurationMs = assertNonNegativeNumber(
      input.audioDurationMs,
      "question audio duration"
    )!;
    if (
      !(
        input.sourceKind === "real_microphone" ||
        input.sourceKind === "synthetic_voice" ||
        input.sourceKind === "recorded_holdout"
      )
    ) {
      throw new Error("Invalid question source kind");
    }
    const metadataJson = serializeJson(
      input.metadata ?? null,
      "question input metadata"
    );
    const existing = this.database.prepare(`
      SELECT * FROM question_inputs WHERE case_id = ?
    `).get(caseId) as QuestionInputRow | undefined;
    if (existing) {
      const unchanged =
        existing.expected_text === input.expectedText &&
        existing.expected_text_hash === expectedTextHash &&
        existing.audio_sha256 === audioSha256 &&
        existing.audio_duration_ms === audioDurationMs &&
        existing.source_kind === input.sourceKind &&
        existing.metadata_json === metadataJson;
      if (!unchanged) {
        throw new Error(
          "Review case is already bound to a different question input"
        );
      }
      return this.getQuestionInput(caseId)!;
    }
    const timestamp = this.now();
    this.database.prepare(`
      INSERT INTO question_inputs (
        case_id, expected_text, expected_text_hash, audio_sha256,
        audio_duration_ms, source_kind, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      caseId,
      input.expectedText,
      expectedTextHash,
      audioSha256,
      audioDurationMs,
      input.sourceKind,
      metadataJson,
      timestamp,
      timestamp
    );
    return this.getQuestionInput(caseId)!;
  }

  getQuestionInput(
    caseIdInput: string
  ): StoredVoiceQaShadowQuestionInput | null {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    const row = this.database.prepare(`
      SELECT * FROM question_inputs WHERE case_id = ?
    `).get(caseId) as QuestionInputRow | undefined;
    return row
      ? {
          caseId: row.case_id,
          expectedText: row.expected_text,
          expectedTextHash: row.expected_text_hash,
          audioSha256: row.audio_sha256,
          audioDurationMs: row.audio_duration_ms,
          sourceKind: row.source_kind,
          metadata: parseJson(row.metadata_json),
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }
      : null;
  }

  upsertReplayInput(
    caseIdInput: string,
    input: VoiceQaShadowReplayInputSnapshotInput
  ) {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    if (!this.getCase(caseId)) throw new Error("Review case does not exist");
    if (input.version !== "voice_qa_shadow_replay_input_v1") {
      throw new Error("Unsupported replay input snapshot version");
    }
    const inputJson = serializeJson(input.input, "replay input snapshot");
    const computedInputHash = sha256(inputJson);
    const inputHash = input.inputHash === undefined
      ? computedInputHash
      : assertSha256(input.inputHash, "replay input snapshot hash");
    if (inputHash !== computedInputHash) {
      throw new Error("Replay input snapshot hash does not match its content");
    }
    const existing = this.database.prepare(`
      SELECT * FROM case_replay_inputs WHERE case_id = ?
    `).get(caseId) as ReplayInputRow | undefined;
    if (existing) {
      if (
        existing.snapshot_version !== input.version ||
        existing.input_hash !== inputHash ||
        existing.input_json !== inputJson
      ) {
        throw new Error(
          "Review case is already bound to a different replay input snapshot"
        );
      }
      return this.getReplayInput(caseId)!;
    }
    const timestamp = this.now();
    this.database.prepare(`
      INSERT INTO case_replay_inputs (
        case_id, snapshot_version, input_json, input_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      caseId,
      input.version,
      inputJson,
      inputHash,
      timestamp,
      timestamp
    );
    return this.getReplayInput(caseId)!;
  }

  getReplayInput(
    caseIdInput: string
  ): StoredVoiceQaShadowReplayInputSnapshot | null {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    const row = this.database.prepare(`
      SELECT * FROM case_replay_inputs WHERE case_id = ?
    `).get(caseId) as ReplayInputRow | undefined;
    return row
      ? {
          caseId: row.case_id,
          version: row.snapshot_version,
          input: parseJson(row.input_json),
          inputHash: row.input_hash,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }
      : null;
  }

  upsertQueryVector(caseIdInput: string, input: VoiceQaShadowQueryVectorInput) {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    if (!this.getCase(caseId)) throw new Error("Review case does not exist");
    const vector = float32Buffer(input.vector, input.dimension);
    const vectorHash = sha256(vector);
    if (
      input.vectorHash !== undefined &&
      assertSha256(input.vectorHash, "query vector hash") !== vectorHash
    ) {
      throw new Error("Query vector hash does not match query vector");
    }
    const existing = this.database.prepare(`
      SELECT * FROM case_query_vectors WHERE case_id = ?
    `).get(caseId) as VectorRow | undefined;
    if (
      existing &&
      (
        existing.vector_sha256 !== vectorHash ||
        existing.model_name !== input.modelName ||
        existing.model_revision !== input.modelRevision ||
        existing.dimension !== input.dimension
      )
    ) {
      throw new Error("Review case is already bound to a different query vector");
    }
    const timestamp = this.now();
    this.database.prepare(`
      INSERT INTO case_query_vectors (
        case_id, vector, vector_sha256, model_name, model_revision,
        dimension, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (case_id) DO UPDATE SET
        updated_at = excluded.updated_at
    `).run(
      caseId,
      vector,
      vectorHash,
      assertIdentifier(input.modelName, "embedding model name"),
      assertIdentifier(input.modelRevision, "embedding model revision"),
      input.dimension,
      existing?.created_at ?? timestamp,
      timestamp
    );
    return this.getQueryVector(caseId)!;
  }

  getQueryVector(caseIdInput: string): StoredVoiceQaShadowQueryVector | null {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    const row = this.database.prepare(`
      SELECT * FROM case_query_vectors WHERE case_id = ?
    `).get(caseId) as VectorRow | undefined;
    return row
      ? {
          caseId: row.case_id,
          vector: float32FromBuffer(row.vector, row.dimension),
          vectorHash: row.vector_sha256,
          modelName: row.model_name,
          modelRevision: row.model_revision,
          dimension: row.dimension,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }
      : null;
  }

  upsertRetrievalRun(
    caseIdInput: string,
    input: VoiceQaShadowRetrievalRunInput
  ) {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    if (!this.getCase(caseId)) throw new Error("Review case does not exist");
    if (input.system !== "A" && input.system !== "B") {
      throw new Error("Unsupported retrieval review system");
    }
    const replayIndex = input.replayIndex ?? 0;
    if (!Number.isInteger(replayIndex) || replayIndex < 0 || replayIndex > 1_000) {
      throw new Error("Invalid retrieval replay index");
    }
    const candidates = normalizedCandidates(input.candidates);
    const computedOrderHash = retrievalOrderHash(candidates);
    const orderHash = input.orderHash === undefined
      ? computedOrderHash
      : assertSha256(input.orderHash, "retrieval order hash");
    if (orderHash !== computedOrderHash) {
      throw new Error("Retrieval order hash does not match candidate ordering");
    }
    const inputHash = assertSha256(input.inputHash, "retrieval input hash");
    const runId = stableRunId(caseId, input.system, replayIndex);
    const existing = this.database.prepare(`
      SELECT * FROM retrieval_runs WHERE run_id = ?
    `).get(runId) as RetrievalRunRow | undefined;
    if (
      existing &&
      (
        existing.input_hash !== inputHash ||
        existing.order_hash !== orderHash
      )
    ) {
      throw new Error(
        "Retrieval system/replay slot is already bound to different input or ordering"
      );
    }
    const timestamp = this.now();
    const run = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO retrieval_runs (
          run_id, case_id, system_code, replay_index, status,
          flat_snapshot_id, hnav_snapshot_id,
          dense_latency_ms, navigation_latency_ms, total_latency_ms,
          fallback_reason, candidate_validity, input_hash, order_hash,
          ranking_metadata_json, memory_source_ids_json,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT (run_id) DO UPDATE SET
          status = excluded.status,
          flat_snapshot_id = excluded.flat_snapshot_id,
          hnav_snapshot_id = excluded.hnav_snapshot_id,
          dense_latency_ms = excluded.dense_latency_ms,
          navigation_latency_ms = excluded.navigation_latency_ms,
          total_latency_ms = excluded.total_latency_ms,
          fallback_reason = excluded.fallback_reason,
          candidate_validity = excluded.candidate_validity,
          ranking_metadata_json = excluded.ranking_metadata_json,
          memory_source_ids_json = excluded.memory_source_ids_json,
          updated_at = excluded.updated_at
      `).run(
        runId,
        caseId,
        input.system,
        replayIndex,
        input.status,
        optionalIdentifier(input.flatSnapshotId, "retrieval flat snapshot id"),
        null,
        assertNonNegativeNumber(input.denseLatencyMs, "dense latency"),
        null,
        assertNonNegativeNumber(input.totalLatencyMs, "total retrieval latency"),
        input.fallbackReason ?? null,
        input.candidateValidity ? 1 : 0,
        inputHash,
        orderHash,
        serializeJson(input.rankingMetadata ?? null, "ranking metadata"),
        serializeJson(
          (input.memorySourceIds ?? []).map((item) =>
            assertIdentifier(item, "memory source id")
          ),
          "memory source ids"
        ),
        existing?.created_at ?? timestamp,
        timestamp
      );
      this.database.prepare(`
        DELETE FROM retrieval_candidates WHERE run_id = ?
      `).run(runId);
      const insertCandidate = this.database.prepare(`
        INSERT INTO retrieval_candidates (
          run_id, evidence_id, pool_rank, selected_rank, score, reason_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const candidate of candidates) {
        insertCandidate.run(
          runId,
          candidate.evidenceId,
          candidate.rank,
          candidate.selectedRank,
          candidate.score,
          candidate.reasonJson
        );
      }
    });
    run();
    return this.getRetrievalRun(caseId, input.system, replayIndex)!;
  }

  getRetrievalRun(
    caseIdInput: string,
    system: VoiceQaShadowReviewSystem,
    replayIndex = 0
  ): StoredVoiceQaShadowRetrievalRun | null {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    const row = this.database.prepare(`
      SELECT * FROM retrieval_runs
      WHERE case_id = ? AND system_code = ? AND replay_index = ?
    `).get(caseId, system, replayIndex) as RetrievalRunRow | undefined;
    if (!row) return null;
    const candidates = this.database.prepare(`
      SELECT evidence_id, pool_rank, selected_rank, score, reason_json
      FROM retrieval_candidates
      WHERE run_id = ?
      ORDER BY pool_rank ASC, evidence_id ASC
    `).all(row.run_id) as CandidateRow[];
    return {
      runId: row.run_id,
      caseId: row.case_id,
      system: row.system_code,
      replayIndex: row.replay_index,
      status: row.status,
      flatSnapshotId: row.flat_snapshot_id,
      denseLatencyMs: row.dense_latency_ms,
      totalLatencyMs: row.total_latency_ms,
      fallbackReason: row.fallback_reason,
      candidateValidity: row.candidate_validity === 1,
      inputHash: row.input_hash,
      orderHash: row.order_hash,
      rankingMetadata: parseJson(row.ranking_metadata_json),
      memorySourceIds: parseJson(row.memory_source_ids_json) as string[],
      candidates: candidates.map((candidate) => ({
        evidenceId: candidate.evidence_id,
        rank: candidate.pool_rank,
        selectedRank: candidate.selected_rank,
        score: candidate.score,
        reason: parseJson(candidate.reason_json)
      })),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listRetrievalRuns(caseIdInput: string) {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    const rows = this.database.prepare(`
      SELECT system_code, replay_index
      FROM retrieval_runs
      WHERE case_id = ? AND system_code IN ('A', 'B')
      ORDER BY replay_index ASC, system_code ASC
    `).all(caseId) as Array<{
      system_code: VoiceQaShadowReviewSystem;
      replay_index: number;
    }>;
    return rows.map((row) =>
      this.getRetrievalRun(caseId, row.system_code, row.replay_index)!
    );
  }

  upsertQaAttempt(
    caseIdInput: string,
    input: VoiceQaShadowQaAttemptInput
  ) {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    if (!this.getCase(caseId)) throw new Error("Review case does not exist");
    if (
      !Number.isInteger(input.attemptIndex) ||
      input.attemptIndex < 0 ||
      input.attemptIndex > 1_000
    ) {
      throw new Error("Invalid QA attempt index");
    }
    if (
      !(
        input.kind === "stream_primary" ||
        input.kind === "sync_primary" ||
        input.kind === "sync_fallback" ||
        input.kind === "final_projection"
      )
    ) {
      throw new Error("Invalid QA attempt kind");
    }
    if (input.attemptIndex !== QA_ATTEMPT_INDEX_BY_KIND[input.kind]) {
      throw new Error("QA attempt index does not match its fixed kind slot");
    }
    if (
      !(
        input.status === "completed" ||
        input.status === "failed" ||
        input.status === "aborted"
      )
    ) {
      throw new Error("Invalid QA attempt status");
    }
    const answerText = input.answerText ?? null;
    const answerHash = answerText === null ? null : sha256(answerText);
    const citationsJson = input.citations === undefined
      ? null
      : serializeJson(input.citations, "QA attempt citations");
    const citationsHash = citationsJson === null ? null : sha256(citationsJson);
    const normalized = {
      kind: input.kind,
      status: input.status,
      fallbackReason: input.fallbackReason ?? null,
      provider: assertIdentifier(input.provider, "QA attempt provider"),
      model: assertIdentifier(input.model, "QA attempt model"),
      promptFingerprint: assertIdentifier(
        input.promptFingerprint,
        "QA attempt prompt fingerprint"
      ),
      codeFingerprint: assertIdentifier(
        input.codeFingerprint,
        "QA attempt code fingerprint"
      ),
      answerText,
      answerHash,
      citationsJson,
      citationsHash,
      latencyMs: assertNonNegativeNumber(input.latencyMs, "QA attempt latency")
    };
    const existing = this.database.prepare(`
      SELECT * FROM qa_attempts
      WHERE case_id = ? AND attempt_index = ?
    `).get(caseId, input.attemptIndex) as QaAttemptRow | undefined;
    if (existing) {
      const unchanged =
        existing.attempt_kind === normalized.kind &&
        existing.status === normalized.status &&
        existing.fallback_reason === normalized.fallbackReason &&
        existing.provider === normalized.provider &&
        existing.model === normalized.model &&
        existing.prompt_fingerprint === normalized.promptFingerprint &&
        existing.code_fingerprint === normalized.codeFingerprint &&
        existing.answer_text === normalized.answerText &&
        existing.answer_hash === normalized.answerHash &&
        existing.citations_json === normalized.citationsJson &&
        existing.citations_hash === normalized.citationsHash &&
        existing.latency_ms === normalized.latencyMs;
      if (!unchanged) {
        throw new Error(
          "QA attempt slot is already bound to a different terminal result"
        );
      }
      return this.getQaAttempt(caseId, input.attemptIndex)!;
    }
    const timestamp = this.now();
    this.database.prepare(`
      INSERT INTO qa_attempts (
        case_id, attempt_index, attempt_kind, status, fallback_reason,
        provider, model, prompt_fingerprint, code_fingerprint,
        answer_text, answer_hash, citations_json, citations_hash,
        latency_ms, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      caseId,
      input.attemptIndex,
      normalized.kind,
      normalized.status,
      normalized.fallbackReason,
      normalized.provider,
      normalized.model,
      normalized.promptFingerprint,
      normalized.codeFingerprint,
      normalized.answerText,
      normalized.answerHash,
      normalized.citationsJson,
      normalized.citationsHash,
      normalized.latencyMs,
      timestamp,
      timestamp
    );
    return this.getQaAttempt(caseId, input.attemptIndex)!;
  }

  getQaAttempt(
    caseIdInput: string,
    attemptIndex: number
  ): StoredVoiceQaShadowQaAttempt | null {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    const row = this.database.prepare(`
      SELECT * FROM qa_attempts
      WHERE case_id = ? AND attempt_index = ?
    `).get(caseId, attemptIndex) as QaAttemptRow | undefined;
    return row
      ? {
          caseId: row.case_id,
          attemptIndex: row.attempt_index,
          kind: row.attempt_kind,
          status: row.status,
          fallbackReason: row.fallback_reason,
          provider: row.provider,
          model: row.model,
          promptFingerprint: row.prompt_fingerprint,
          codeFingerprint: row.code_fingerprint,
          answerText: row.answer_text,
          answerHash: row.answer_hash,
          citations: row.citations_json === null
            ? null
            : parseJson(row.citations_json),
          citationsHash: row.citations_hash,
          latencyMs: row.latency_ms,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }
      : null;
  }

  listQaAttempts(caseIdInput: string) {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    const rows = this.database.prepare(`
      SELECT attempt_index FROM qa_attempts
      WHERE case_id = ?
      ORDER BY attempt_index ASC
    `).all(caseId) as Array<{ attempt_index: number }>;
    return rows.map((row) =>
      this.getQaAttempt(caseId, row.attempt_index)!
    );
  }

  upsertOfficialAnswer(
    caseIdInput: string,
    input: VoiceQaShadowOfficialAnswerInput
  ) {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    if (!this.getCase(caseId)) throw new Error("Review case does not exist");
    const citationsJson = serializeJson(input.citations, "official answer citations");
    const timestamp = this.now();
    const existing = this.database.prepare(`
      SELECT created_at FROM official_answers WHERE case_id = ?
    `).get(caseId) as { created_at: string } | undefined;
    this.database.prepare(`
      INSERT INTO official_answers (
        case_id, answer_text, answer_hash, citations_json, citations_hash,
        model, prompt_fingerprint, code_fingerprint, fallback_reason,
        llm_first_token_latency_ms, first_playable_sentence_latency_ms,
        first_audio_latency_ms, complete_latency_ms, streaming_complete,
        tts_failure, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (case_id) DO UPDATE SET
        answer_text = excluded.answer_text,
        answer_hash = excluded.answer_hash,
        citations_json = excluded.citations_json,
        citations_hash = excluded.citations_hash,
        model = excluded.model,
        prompt_fingerprint = excluded.prompt_fingerprint,
        code_fingerprint = excluded.code_fingerprint,
        fallback_reason = excluded.fallback_reason,
        llm_first_token_latency_ms = excluded.llm_first_token_latency_ms,
        first_playable_sentence_latency_ms = excluded.first_playable_sentence_latency_ms,
        first_audio_latency_ms = excluded.first_audio_latency_ms,
        complete_latency_ms = excluded.complete_latency_ms,
        streaming_complete = excluded.streaming_complete,
        tts_failure = excluded.tts_failure,
        updated_at = excluded.updated_at
    `).run(
      caseId,
      input.answerText,
      sha256(input.answerText),
      citationsJson,
      sha256(citationsJson),
      assertIdentifier(input.model, "official answer model"),
      assertIdentifier(input.promptFingerprint, "official answer prompt fingerprint"),
      assertIdentifier(input.codeFingerprint, "official answer code fingerprint"),
      input.fallbackReason ?? null,
      assertNonNegativeNumber(input.llmFirstTokenLatencyMs, "LLM first token latency"),
      assertNonNegativeNumber(
        input.firstPlayableSentenceLatencyMs,
        "first playable sentence latency"
      ),
      assertNonNegativeNumber(input.firstAudioLatencyMs, "first audio latency"),
      assertNonNegativeNumber(input.completeLatencyMs, "complete answer latency"),
      nullableBoolean(input.streamingComplete),
      input.ttsFailure ?? null,
      existing?.created_at ?? timestamp,
      timestamp
    );
    return this.getOfficialAnswer(caseId)!;
  }

  getOfficialAnswer(
    caseIdInput: string
  ): StoredVoiceQaShadowOfficialAnswer | null {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    const row = this.database.prepare(`
      SELECT * FROM official_answers WHERE case_id = ?
    `).get(caseId) as OfficialAnswerRow | undefined;
    return row
      ? {
          caseId: row.case_id,
          answerText: row.answer_text,
          answerHash: row.answer_hash,
          citations: parseJson(row.citations_json),
          citationsHash: row.citations_hash,
          model: row.model,
          promptFingerprint: row.prompt_fingerprint,
          codeFingerprint: row.code_fingerprint,
          fallbackReason: row.fallback_reason,
          llmFirstTokenLatencyMs: row.llm_first_token_latency_ms,
          firstPlayableSentenceLatencyMs:
            row.first_playable_sentence_latency_ms,
          firstAudioLatencyMs: row.first_audio_latency_ms,
          completeLatencyMs: row.complete_latency_ms,
          streamingComplete: booleanFromRow(row.streaming_complete),
          ttsFailure: row.tts_failure,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }
      : null;
  }

  upsertBlindPromptSnapshot(
    caseIdInput: string,
    input: VoiceQaShadowBlindPromptSnapshotInput
  ): StoredVoiceQaShadowBlindPromptSnapshot {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    if (!this.getCase(caseId)) throw new Error("Review case does not exist");
    if (!Number.isInteger(input.memoryCount) || input.memoryCount < 0) {
      throw new Error("Invalid blind prompt memory count");
    }
    if (!Number.isInteger(input.evidenceCount) || input.evidenceCount < 0) {
      throw new Error("Invalid blind prompt evidence count");
    }
    const providerPrompt = input.status === "provider_prompt";
    const systemPrompt = providerPrompt
      ? input.systemPrompt ?? null
      : null;
    const userPromptPrefix = providerPrompt
      ? input.userPromptPrefix ?? null
      : null;
    const evidenceSectionHash = providerPrompt
      ? input.evidenceSectionHash === undefined ||
          input.evidenceSectionHash === null
        ? null
        : assertSha256(input.evidenceSectionHash, "blind prompt evidence section hash")
      : null;
    if (
      providerPrompt &&
      (
        systemPrompt === null ||
        userPromptPrefix === null ||
        evidenceSectionHash === null
      )
    ) {
      throw new Error("Provider blind prompt snapshot is incomplete");
    }
    if (
      !providerPrompt &&
      (
        input.systemPrompt !== undefined && input.systemPrompt !== null ||
        input.userPromptPrefix !== undefined && input.userPromptPrefix !== null ||
        input.evidenceSectionHash !== undefined &&
          input.evidenceSectionHash !== null
      )
    ) {
      throw new Error("No-provider blind prompt snapshot cannot contain prompt data");
    }
    const lifecycleMetadataJson = serializeJson(
      input.lifecycleMetadata,
      "blind prompt lifecycle metadata"
    );
    const normalized = {
      status: input.status,
      attemptKind: input.attemptKind,
      systemPrompt,
      systemPromptHash: systemPrompt === null ? null : sha256(systemPrompt),
      userPromptPrefix,
      userPromptPrefixHash:
        userPromptPrefix === null ? null : sha256(userPromptPrefix),
      evidenceSectionHash,
      answerMode: input.answerMode,
      memoryCount: input.memoryCount,
      evidenceCount: input.evidenceCount,
      lifecycleMetadataJson
    };
    const existing = this.database.prepare(`
      SELECT * FROM blind_prompt_snapshots WHERE case_id = ?
    `).get(caseId) as BlindPromptSnapshotRow | undefined;
    if (existing) {
      const existingIsFinal = existing.attempt_kind === "final_projection";
      const incomingIsFinal = normalized.attemptKind === "final_projection";
      if (existingIsFinal && !incomingIsFinal) {
        return this.getBlindPromptSnapshot(caseId)!;
      }
      const unchanged =
        existing.status === normalized.status &&
        existing.attempt_kind === normalized.attemptKind &&
        existing.system_prompt === normalized.systemPrompt &&
        existing.system_prompt_hash === normalized.systemPromptHash &&
        existing.user_prompt_prefix === normalized.userPromptPrefix &&
        existing.user_prompt_prefix_hash === normalized.userPromptPrefixHash &&
        existing.evidence_section_hash === normalized.evidenceSectionHash &&
        existing.answer_mode === normalized.answerMode &&
        existing.memory_count === normalized.memoryCount &&
        existing.evidence_count === normalized.evidenceCount &&
        existing.lifecycle_metadata_json === normalized.lifecycleMetadataJson;
      if (unchanged) return this.getBlindPromptSnapshot(caseId)!;
      if (!incomingIsFinal) {
        throw new Error(
          "Blind prompt snapshot is already bound to a different attempt"
        );
      }
    }
    const timestamp = this.now();
    this.database.prepare(`
      INSERT INTO blind_prompt_snapshots (
        case_id, status, attempt_kind, system_prompt, system_prompt_hash,
        user_prompt_prefix, user_prompt_prefix_hash, evidence_section_hash,
        answer_mode, memory_count, evidence_count, lifecycle_metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (case_id) DO UPDATE SET
        status = excluded.status,
        attempt_kind = excluded.attempt_kind,
        system_prompt = excluded.system_prompt,
        system_prompt_hash = excluded.system_prompt_hash,
        user_prompt_prefix = excluded.user_prompt_prefix,
        user_prompt_prefix_hash = excluded.user_prompt_prefix_hash,
        evidence_section_hash = excluded.evidence_section_hash,
        answer_mode = excluded.answer_mode,
        memory_count = excluded.memory_count,
        evidence_count = excluded.evidence_count,
        lifecycle_metadata_json = excluded.lifecycle_metadata_json,
        updated_at = excluded.updated_at
    `).run(
      caseId,
      normalized.status,
      normalized.attemptKind,
      normalized.systemPrompt,
      normalized.systemPromptHash,
      normalized.userPromptPrefix,
      normalized.userPromptPrefixHash,
      normalized.evidenceSectionHash,
      normalized.answerMode,
      normalized.memoryCount,
      normalized.evidenceCount,
      normalized.lifecycleMetadataJson,
      existing?.created_at ?? timestamp,
      timestamp
    );
    return this.getBlindPromptSnapshot(caseId)!;
  }

  getBlindPromptSnapshot(
    caseIdInput: string
  ): StoredVoiceQaShadowBlindPromptSnapshot | null {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    const row = this.database.prepare(`
      SELECT * FROM blind_prompt_snapshots WHERE case_id = ?
    `).get(caseId) as BlindPromptSnapshotRow | undefined;
    return row
      ? {
          caseId: row.case_id,
          status: row.status,
          attemptKind: row.attempt_kind,
          systemPrompt: row.system_prompt,
          systemPromptHash: row.system_prompt_hash,
          userPromptPrefix: row.user_prompt_prefix,
          userPromptPrefixHash: row.user_prompt_prefix_hash,
          evidenceSectionHash: row.evidence_section_hash,
          answerMode: row.answer_mode,
          memoryCount: row.memory_count,
          evidenceCount: row.evidence_count,
          lifecycleMetadata: parseJson(row.lifecycle_metadata_json),
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }
      : null;
  }

  upsertGold(caseIdInput: string, input: VoiceQaShadowGoldInput) {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    if (!this.getCase(caseId)) throw new Error("Review case does not exist");
    const evidenceGroups = input.evidenceGroups.map((group) =>
      group.map((id) => assertIdentifier(id, "gold evidence id"))
    );
    const categories = [...new Set((input.categories ?? []).map((category) => {
      const normalized = category.trim();
      if (!GOLD_CATEGORY_PATTERN.test(normalized)) {
        throw new Error("Invalid Gold category identifier");
      }
      return normalized;
    }))].sort();
    if (
      input.status === "evaluable" &&
      evidenceGroups.length === 0 &&
      !input.shouldRefuse
    ) {
      throw new Error("Evaluable non-refusal gold requires evidence");
    }
    const timestamp = this.now();
    const existing = this.database.prepare(`
      SELECT created_at FROM gold_annotations WHERE case_id = ?
    `).get(caseId) as { created_at: string } | undefined;
    this.database.prepare(`
      INSERT INTO gold_annotations (
        case_id, status, evidence_groups_json, required_facts_json,
        should_refuse, categories_json, reviewer_id, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (case_id) DO UPDATE SET
        status = excluded.status,
        evidence_groups_json = excluded.evidence_groups_json,
        required_facts_json = excluded.required_facts_json,
        should_refuse = excluded.should_refuse,
        categories_json = excluded.categories_json,
        reviewer_id = excluded.reviewer_id,
        notes = excluded.notes,
        updated_at = excluded.updated_at
    `).run(
      caseId,
      input.status,
      serializeJson(evidenceGroups, "gold evidence groups"),
      serializeJson([...input.requiredFacts], "gold required facts"),
      input.shouldRefuse ? 1 : 0,
      serializeJson(categories, "Gold categories"),
      input.reviewerId ?? null,
      input.notes ?? null,
      existing?.created_at ?? timestamp,
      timestamp
    );
    return this.getGold(caseId)!;
  }

  getGold(caseIdInput: string): StoredVoiceQaShadowGold | null {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    const row = this.database.prepare(`
      SELECT * FROM gold_annotations WHERE case_id = ?
    `).get(caseId) as GoldRow | undefined;
    return row
      ? {
          caseId: row.case_id,
          status: row.status,
          evidenceGroups: parseJson(row.evidence_groups_json) as string[][],
          requiredFacts: parseJson(row.required_facts_json) as string[],
          shouldRefuse: row.should_refuse === 1,
          categories: parseJson(row.categories_json) as string[],
          reviewerId: row.reviewer_id,
          notes: row.notes,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }
      : null;
  }

  upsertBlindAnswer(
    caseIdInput: string,
    input: VoiceQaShadowBlindAnswerInput
  ) {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    if (!this.getCase(caseId)) throw new Error("Review case does not exist");
    if (!Number.isInteger(input.round) || input.round < 1 || input.round > 100) {
      throw new Error("Invalid blind answer round");
    }
    const label = assertIdentifier(input.label, "blind answer label");
    const citationsJson = serializeJson(input.citations, "blind answer citations");
    const timestamp = this.now();
    const existing = this.database.prepare(`
      SELECT created_at FROM blind_answers
      WHERE case_id = ? AND review_round = ? AND answer_label = ?
    `).get(caseId, input.round, label) as { created_at: string } | undefined;
    this.database.prepare(`
      INSERT INTO blind_answers (
        case_id, review_round, answer_label, system_code,
        answer_text, answer_hash, citations_json, citations_hash,
        citation_validity, model, generation_latency_ms, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (case_id, review_round, answer_label) DO UPDATE SET
        system_code = excluded.system_code,
        answer_text = excluded.answer_text,
        answer_hash = excluded.answer_hash,
        citations_json = excluded.citations_json,
        citations_hash = excluded.citations_hash,
        citation_validity = excluded.citation_validity,
        model = excluded.model,
        generation_latency_ms = excluded.generation_latency_ms,
        updated_at = excluded.updated_at
    `).run(
      caseId,
      input.round,
      label,
      input.system,
      input.answerText,
      sha256(input.answerText),
      citationsJson,
      sha256(citationsJson),
      nullableBoolean(input.citationValidity),
      assertIdentifier(input.model, "blind answer model"),
      assertNonNegativeNumber(
        input.generationLatencyMs,
        "blind answer generation latency"
      ),
      existing?.created_at ?? timestamp,
      timestamp
    );
    return this.getBlindAnswer(caseId, input.round, label)!;
  }

  getBlindAnswer(
    caseIdInput: string,
    round: number,
    labelInput: string
  ): StoredVoiceQaShadowBlindAnswer | null {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    const label = assertIdentifier(labelInput, "blind answer label");
    const row = this.database.prepare(`
      SELECT * FROM blind_answers
      WHERE case_id = ? AND review_round = ? AND answer_label = ?
    `).get(caseId, round, label) as BlindAnswerRow | undefined;
    return row
      ? {
          caseId: row.case_id,
          round: row.review_round,
          label: row.answer_label,
          system: row.system_code,
          answerText: row.answer_text,
          answerHash: row.answer_hash,
          citations: parseJson(row.citations_json),
          citationsHash: row.citations_hash,
          citationValidity: booleanFromRow(row.citation_validity),
          model: row.model,
          generationLatencyMs: row.generation_latency_ms,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }
      : null;
  }

  listBlindAnswers(caseIdInput: string) {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    const rows = this.database.prepare(`
      SELECT review_round, answer_label
      FROM blind_answers
      WHERE case_id = ?
      ORDER BY review_round ASC, answer_label ASC
    `).all(caseId) as Array<{ review_round: number; answer_label: string }>;
    return rows.map((row) =>
      this.getBlindAnswer(caseId, row.review_round, row.answer_label)!
    );
  }

  upsertBlindReview(
    caseIdInput: string,
    input: VoiceQaShadowBlindReviewInput
  ) {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    const label = assertIdentifier(input.label, "blind answer label");
    if (!this.getBlindAnswer(caseId, input.round, label)) {
      throw new Error("Blind answer does not exist");
    }
    const reviewedAt = this.now();
    this.database.prepare(`
      INSERT INTO blind_reviews (
        case_id, review_round, answer_label, scores_json,
        hard_violations_json, outcome, reviewer_id, reviewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (case_id, review_round, answer_label) DO UPDATE SET
        scores_json = excluded.scores_json,
        hard_violations_json = excluded.hard_violations_json,
        outcome = excluded.outcome,
        reviewer_id = excluded.reviewer_id,
        reviewed_at = excluded.reviewed_at
    `).run(
      caseId,
      input.round,
      label,
      serializeJson(input.scores, "blind review scores"),
      serializeJson([...input.hardViolations], "blind review hard violations"),
      input.outcome ?? "unscored",
      input.reviewerId ?? null,
      reviewedAt
    );
    return this.getBlindReview(caseId, input.round, label)!;
  }

  getBlindReview(
    caseIdInput: string,
    round: number,
    labelInput: string
  ): StoredVoiceQaShadowBlindReview | null {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    const label = assertIdentifier(labelInput, "blind answer label");
    const row = this.database.prepare(`
      SELECT * FROM blind_reviews
      WHERE case_id = ? AND review_round = ? AND answer_label = ?
    `).get(caseId, round, label) as BlindReviewRow | undefined;
    return row
      ? {
          caseId: row.case_id,
          round: row.review_round,
          label: row.answer_label,
          scores: parseJson(row.scores_json),
          hardViolations: parseJson(row.hard_violations_json) as string[],
          outcome: row.outcome,
          reviewerId: row.reviewer_id,
          reviewedAt: row.reviewed_at
        }
      : null;
  }

  listBlindReviews(caseIdInput: string) {
    const caseId = assertIdentifier(caseIdInput, "review case id");
    const rows = this.database.prepare(`
      SELECT review_round, answer_label
      FROM blind_reviews
      WHERE case_id = ?
      ORDER BY review_round ASC, answer_label ASC
    `).all(caseId) as Array<{ review_round: number; answer_label: string }>;
    return rows.map((row) =>
      this.getBlindReview(caseId, row.review_round, row.answer_label)!
    );
  }

  upsertFaultRun(input: VoiceQaShadowFaultRunInput) {
    const faultRunId = assertIdentifier(input.faultRunId, "fault run id");
    const caseId = optionalIdentifier(input.caseId, "review case id");
    if (caseId && !this.getCase(caseId)) {
      throw new Error("Review case does not exist");
    }
    const timestamp = this.now();
    const existing = this.database.prepare(`
      SELECT created_at FROM fault_runs WHERE fault_run_id = ?
    `).get(faultRunId) as { created_at: string } | undefined;
    this.database.prepare(`
      INSERT INTO fault_runs (
        fault_run_id, case_id, user_id, scenario, status, shadow_error,
        expected_official_answer_hash, actual_official_answer_hash,
        expected_citation_hash, actual_citation_hash,
        voice_uninterrupted, lexical_fail_open, citations_valid,
        shadow_latency_ms, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (fault_run_id) DO UPDATE SET
        case_id = excluded.case_id,
        scenario = excluded.scenario,
        status = excluded.status,
        shadow_error = excluded.shadow_error,
        expected_official_answer_hash = excluded.expected_official_answer_hash,
        actual_official_answer_hash = excluded.actual_official_answer_hash,
        expected_citation_hash = excluded.expected_citation_hash,
        actual_citation_hash = excluded.actual_citation_hash,
        voice_uninterrupted = excluded.voice_uninterrupted,
        lexical_fail_open = excluded.lexical_fail_open,
        citations_valid = excluded.citations_valid,
        shadow_latency_ms = excluded.shadow_latency_ms,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      faultRunId,
      caseId,
      this.userId,
      assertIdentifier(input.scenario, "fault scenario"),
      input.status,
      input.shadowError ?? null,
      input.expectedOfficialAnswerHash
        ? assertSha256(input.expectedOfficialAnswerHash, "expected answer hash")
        : null,
      input.actualOfficialAnswerHash
        ? assertSha256(input.actualOfficialAnswerHash, "actual answer hash")
        : null,
      input.expectedCitationHash
        ? assertSha256(input.expectedCitationHash, "expected citation hash")
        : null,
      input.actualCitationHash
        ? assertSha256(input.actualCitationHash, "actual citation hash")
        : null,
      nullableBoolean(input.voiceUninterrupted),
      nullableBoolean(input.lexicalFailOpen),
      nullableBoolean(input.citationsValid),
      assertNonNegativeNumber(input.shadowLatencyMs, "shadow fault latency"),
      serializeJson(input.metadata ?? null, "fault run metadata"),
      existing?.created_at ?? timestamp,
      timestamp
    );
    return this.getFaultRun(faultRunId)!;
  }

  getFaultRun(
    faultRunIdInput: string
  ): StoredVoiceQaShadowFaultRun | null {
    const faultRunId = assertIdentifier(faultRunIdInput, "fault run id");
    const row = this.database.prepare(`
      SELECT * FROM fault_runs
      WHERE fault_run_id = ? AND user_id = ?
    `).get(faultRunId, this.userId) as FaultRunRow | undefined;
    return row ? {
      faultRunId: row.fault_run_id,
      caseId: row.case_id,
      userId: row.user_id,
      scenario: row.scenario,
      status: row.status,
      shadowError: row.shadow_error,
      expectedOfficialAnswerHash: row.expected_official_answer_hash,
      actualOfficialAnswerHash: row.actual_official_answer_hash,
      expectedCitationHash: row.expected_citation_hash,
      actualCitationHash: row.actual_citation_hash,
      voiceUninterrupted: booleanFromRow(row.voice_uninterrupted),
      lexicalFailOpen: booleanFromRow(row.lexical_fail_open),
      citationsValid: booleanFromRow(row.citations_valid),
      shadowLatencyMs: row.shadow_latency_ms,
      metadata: parseJson(row.metadata_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    } : null;
  }

  listFaultRuns(caseIdInput?: string) {
    const rows = caseIdInput
      ? this.database.prepare(`
          SELECT * FROM fault_runs
          WHERE user_id = ? AND case_id = ?
          ORDER BY created_at ASC, fault_run_id ASC
        `).all(
          this.userId,
          assertIdentifier(caseIdInput, "review case id")
        )
      : this.database.prepare(`
          SELECT * FROM fault_runs
          WHERE user_id = ?
          ORDER BY created_at ASC, fault_run_id ASC
        `).all(this.userId);
    return (rows as FaultRunRow[]).map((row) => this.getFaultRun(row.fault_run_id)!);
  }

  upsertCaseBundle(input: VoiceQaShadowReviewCaseBundleInput) {
    const transaction = this.database.transaction(() => {
      if (input.canonicalSnapshot) {
        if (
          input.case.canonicalSnapshotId &&
          input.case.canonicalSnapshotId !== input.canonicalSnapshot.snapshotId
        ) {
          throw new Error("Case and canonical snapshot ids do not match");
        }
        this.upsertCanonicalSnapshot(input.canonicalSnapshot);
      }
      const storedCase = this.upsertCase({
        ...input.case,
        canonicalSnapshotId:
          input.case.canonicalSnapshotId ??
          input.canonicalSnapshot?.snapshotId ??
          null
      });
      if (input.questionInput) {
        this.upsertQuestionInput(storedCase.caseId, input.questionInput);
      }
      if (input.replayInput) {
        this.upsertReplayInput(storedCase.caseId, input.replayInput);
      }
      if (input.queryVector) {
        this.upsertQueryVector(storedCase.caseId, input.queryVector);
      }
      for (const run of input.retrievalRuns ?? []) {
        this.upsertRetrievalRun(storedCase.caseId, run);
      }
      for (const attempt of input.qaAttempts ?? []) {
        this.upsertQaAttempt(storedCase.caseId, attempt);
      }
      if (input.officialAnswer) {
        this.upsertOfficialAnswer(storedCase.caseId, input.officialAnswer);
      }
      if (input.blindPromptSnapshot) {
        this.upsertBlindPromptSnapshot(
          storedCase.caseId,
          input.blindPromptSnapshot
        );
      }
      if (input.gold) this.upsertGold(storedCase.caseId, input.gold);
      for (const answer of input.blindAnswers ?? []) {
        this.upsertBlindAnswer(storedCase.caseId, answer);
      }
      for (const review of input.blindReviews ?? []) {
        this.upsertBlindReview(storedCase.caseId, review);
      }
      for (const faultRun of input.faultRuns ?? []) {
        this.upsertFaultRun({ ...faultRun, caseId: storedCase.caseId });
      }
    });
    transaction();
    return this.getCaseBundle(input.case.caseId)!;
  }

  getCaseBundle(
    caseIdInput: string
  ): StoredVoiceQaShadowReviewCaseBundle | null {
    const storedCase = this.getCase(caseIdInput);
    if (!storedCase) return null;
    return {
      case: storedCase,
      questionInput: this.getQuestionInput(storedCase.caseId),
      replayInput: this.getReplayInput(storedCase.caseId),
      canonicalSnapshot: storedCase.canonicalSnapshotId
        ? this.getCanonicalSnapshot(storedCase.canonicalSnapshotId)
        : null,
      queryVector: this.getQueryVector(storedCase.caseId),
      retrievalRuns: this.listRetrievalRuns(storedCase.caseId),
      qaAttempts: this.listQaAttempts(storedCase.caseId),
      officialAnswer: this.getOfficialAnswer(storedCase.caseId),
      blindPromptSnapshot: this.getBlindPromptSnapshot(storedCase.caseId),
      gold: this.getGold(storedCase.caseId),
      blindAnswers: this.listBlindAnswers(storedCase.caseId),
      blindReviews: this.listBlindReviews(storedCase.caseId),
      faultRuns: this.listFaultRuns(storedCase.caseId)
    };
  }
}
