import { createHash, randomUUID } from "node:crypto";

import {
  type WorkExtractorCandidateDraft,
  type WorkClaimRiskLevel,
  type WorkEvidenceTimestampQuality,
  type WorkVerifierClaimDraft
} from "@/lib/domain/work-review";
import type { JsonStore } from "@/lib/server/storage/json-store";
import { probeAudioDurationSeconds } from "@/lib/server/transcription/chunks/audio-planner";

import {
  createConfiguredWorkMeetingExtractor,
  createConfiguredWorkMeetingVerifier,
  buildWorkMeetingVerifierProviderPayload,
  isWorkAnalysisProviderTransientError,
  validateAggregatedWorkVerifierOutput,
  validateWorkMeetingVerifierResult,
  validateWorkExtractorOutput,
  WorkMeetingAnalysisProviderError,
  WorkExtractorValidationSummarySchema,
  type WorkExtractorValidationSummary,
  type WorkMeetingExtractor,
  type WorkMeetingVerifier,
  type WorkExtractorSchemaRepair
} from "./analysis-provider";
import {
  assembleWorkMeetingCandidates,
  attachWorkQuestionResolutionClaims,
  buildWorkCandidatePublicationProjection,
  WorkMeetingAnalysisLimitError,
  partitionWorkMeetingCandidateReviewCapacity,
  planWorkCandidatesForVerification,
  packWorkDuplicateCoverageForVerification,
  selectWorkCandidatesForGptVerification
} from "./candidate-normalization";
import { cleanupWorkReviewUploadArtifacts } from "./cleanup";
import {
  applyWorkMeetingOrganization,
  applyVerifiedWorkMeetingDuplicates,
  buildWorkMeetingDeduplicationPayload,
  createWorkMeetingDeduplicator,
  WORK_MEETING_DEDUPLICATOR_TIMEOUT_MS,
  WORK_MEETING_DEDUPLICATOR_SCHEMA_VERSION,
  WorkMeetingOrganizationCheckpointSchema,
  type WorkMeetingDeduplicator
} from "./candidate-deduplication";
import { WORK_MEETING_ANALYSIS_AUDIT_VERSION } from "./analysis-audit";
import { buildWorkDuplicateCoverageRequests, type WorkDuplicateCoverageEvaluation } from "./duplicate-coverage";
import { getWorkReviewDatabase } from "./db";
import {
  evaluateWorkClaimPublication,
  isWorkOptionalAttributeClaim,
  riskLevelForWorkClaim,
  WORK_MEETING_CAUSALITY_ROUTING_ISSUE_CODE,
  WORK_MEETING_NON_GPT_ISSUE_CODE,
  WORK_MEETING_NON_GPT_PROFILE,
  WORK_MEETING_VERIFIER_CAPACITY_ISSUE_CODE,
  WORK_MEETING_SEMANTIC_VALUE_AUDIT_ISSUE_CODE_PREFIX
} from "./publication-policy";
import {
  WorkReviewConflictError,
  WorkReviewLeaseLostError,
  WorkReviewRepository,
  type WorkProcessingFence
} from "./repository";
import {
  resolveWorkReviewFeatureFlags,
  resolveWorkReviewAnalysisConcurrency,
  resolveWorkReviewCapacityLimits,
  resolveWorkReviewExtractorExecutionPolicy,
  WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
  WORK_MEETING_EXTRACTOR_SCHEMA_VERSION,
  WORK_MEETING_PIPELINE_VERSION,
  WORK_MEETING_PUBLICATION_POLICY_VERSION,
  WORK_MEETING_VERIFIER_PROMPT_VERSION,
  WORK_MEETING_VERIFIER_SCHEMA_VERSION,
  type WorkReviewCapacityLimits,
  type WorkReviewExtractorExecutionPolicy,
  type WorkReviewFeatureFlags
} from "./runtime-config";
import {
  transcribeWorkMeetingAudio,
  type WorkMeetingTranscriber
} from "./transcription-policy";
import {
  buildWorkMeetingTranscriptWindows,
  splitWorkMeetingTranscriptWindow,
  type WorkMeetingTranscriptWindow
} from "./windowing";

const TRANSCRIPTION_LEASE_MS = 15 * 60_000;
const ANALYSIS_LEASE_MS = 15 * 60_000;

type AnalysisProviders = {
  extractor: WorkMeetingExtractor;
  verifier?: WorkMeetingVerifier;
  deduplicator?: WorkMeetingDeduplicator;
};

export type WorkMeetingProcessorDependencies = {
  repository?: WorkReviewRepository;
  transcriber?: WorkMeetingTranscriber;
  probeDurationSeconds?: (filePath: string) => Promise<number>;
  resolveCapacityLimits?: () => WorkReviewCapacityLimits;
  resolveFeatureFlags?: () => WorkReviewFeatureFlags;
  resolveAnalysisConcurrency?: () => number;
  resolveExtractorExecutionPolicy?: () => WorkReviewExtractorExecutionPolicy;
  createAnalysisProviders?: (input: {
    verifierEnabled: boolean;
  }) => AnalysisProviders;
  cleanupRawAudio?: (input: {
    filePath: string;
    uploadsRootDir: string;
    uploadId: string;
    store: JsonStore;
  }) => Promise<void>;
  leaseOwnerFactory?: (stage: "transcription" | "meeting_analysis") => string;
  onProgress?: (event: {
    stage: "transcription" | "meeting_analysis";
    completed: number;
    total: number;
    state: "started" | "processing" | "failed" | "completed";
  }) => void;
};

export type ProcessWorkMeetingInput = {
  accountId: string;
  meetingId: string;
  store: JsonStore;
  uploadsRootDir: string;
};

export type ProcessWorkMeetingResult = {
  meetingId: string;
  transcriptReady: boolean;
  analysisReady: boolean;
  busy: boolean;
};

function defaultRepository() {
  return new WorkReviewRepository(getWorkReviewDatabase());
}

function defaultAnalysisProviders(input: { verifierEnabled: boolean }): AnalysisProviders {
  const verifier = input.verifierEnabled ? createConfiguredWorkMeetingVerifier() : undefined;
  return {
    extractor: createConfiguredWorkMeetingExtractor(),
    ...(verifier ? { verifier } : {}),
    ...(verifier && verifier.profile.provider !== "fixture"
      ? { deduplicator: createWorkMeetingDeduplicator({ profile: verifier.profile }) } : {})
  };
}

function defaultLeaseOwnerFactory(stage: "transcription" | "meeting_analysis") {
  return `work-${stage}-${process.pid}-${randomUUID()}`;
}

async function defaultCleanupRawAudio(input: {
  filePath: string;
  uploadsRootDir: string;
  uploadId: string;
  store: JsonStore;
}) {
  const cleanup = await cleanupWorkReviewUploadArtifacts(input);
  if (!cleanup.ok) {
    throw new Error(`work_review_upload_cleanup_failed:${cleanup.failures.join(",")}`);
  }
}

function errorCode(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "code" in error) {
    const value = (error as { code?: unknown }).code;
    if (typeof value === "string" && /^[a-z0-9_:-]{1,160}$/u.test(value)) return value;
  }
  return fallback;
}

function reportProgress(
  dependencies: WorkMeetingProcessorDependencies,
  event: Parameters<NonNullable<WorkMeetingProcessorDependencies["onProgress"]>>[0]
) {
  dependencies.onProgress?.(event);
  console.info(
    `[work-review] stage=${event.stage} progress=${event.completed}/${event.total} state=${event.state}`
  );
}

async function withLeaseHeartbeat<Result>(input: {
  renew: () => void;
  leaseDurationMs: number;
  task: () => Promise<Result>;
}) {
  let heartbeatError: unknown;
  const intervalMs = Math.max(30_000, Math.floor(input.leaseDurationMs / 3));
  const timer = setInterval(() => {
    try {
      input.renew();
    } catch (error) {
      heartbeatError = error;
      clearInterval(timer);
    }
  }, intervalMs);
  timer.unref?.();
  try {
    const result = await input.task();
    if (heartbeatError) throw heartbeatError;
    return result;
  } finally {
    clearInterval(timer);
  }
}

function safeMarkFailed(input: {
  repository: WorkReviewRepository;
  accountId: string;
  meetingId: string;
  fence: WorkProcessingFence;
  code: string;
}) {
  try {
    input.repository.markStageFailed({
      accountId: input.accountId,
      meetingId: input.meetingId,
      fence: input.fence,
      errorCode: input.code
    });
  } catch (error) {
    if (error instanceof WorkReviewLeaseLostError) return;
    if (error instanceof WorkReviewConflictError
      && error.code === "work_review_tombstoned") return;
    throw error;
  }
}

function isTombstoned(error: unknown) {
  return error instanceof WorkReviewConflictError
    && error.code === "work_review_tombstoned";
}

function timestampQualityMap(segmentIds: string[]): Record<string, WorkEvidenceTimestampQuality> {
  return Object.fromEntries(segmentIds.map((segmentId) => [
    segmentId,
    "unknown" satisfies WorkEvidenceTimestampQuality
  ])) as Record<string, WorkEvidenceTimestampQuality>;
}

function maxRiskLevel(levels: WorkClaimRiskLevel[]) {
  const order: WorkClaimRiskLevel[] = ["low", "medium", "high", "critical"];
  return levels.reduce((current, next) =>
    order.indexOf(next) > order.indexOf(current) ? next : current
  , "low" as WorkClaimRiskLevel);
}

type WorkExtractorRecoveryAction =
  | "json_repair"
  | "transient_retry"
  | "fail";

function workExtractorRecoveryAction(error: unknown): WorkExtractorRecoveryAction {
  if (!(error instanceof WorkMeetingAnalysisProviderError)) return "fail";
  if (error.code === "work_analysis_provider_invalid_json") return "json_repair";
  if (isWorkAnalysisProviderTransientError(error)) return "transient_retry";
  return "fail";
}

function workExtractorSchemaRepair(error: unknown): WorkExtractorSchemaRepair {
  if (!(error instanceof WorkMeetingAnalysisProviderError)) {
    return { validationIssues: [], validationIssuesTruncated: false };
  }
  return {
    validationIssues: error.safeDiagnostics?.validationIssues ?? [],
    validationIssuesTruncated: error.safeDiagnostics?.validationIssuesTruncated === true
  };
}

class WorkAnalysisExecutionLimitError extends Error {
  constructor(
    public readonly code:
      | "work_analysis_call_budget_exhausted"
      | "work_analysis_deadline_exceeded",
    message: string
  ) {
    super(message);
    this.name = "WorkAnalysisExecutionLimitError";
  }
}

class WorkAnalysisProviderContractMismatchError extends Error {
  readonly code = "work_analysis_provider_contract_mismatch";

  constructor(message: string) {
    super(message);
    this.name = "WorkAnalysisProviderContractMismatchError";
  }
}

function assertWorkAnalysisProviderContracts(input: {
  providers: AnalysisProviders;
  verifierEnabled: boolean;
}) {
  if (input.providers.extractor.profile.promptVersion !== WORK_MEETING_EXTRACTOR_PROMPT_VERSION
    || input.providers.extractor.profile.schemaVersion !== WORK_MEETING_EXTRACTOR_SCHEMA_VERSION) {
    throw new WorkAnalysisProviderContractMismatchError(
      "Work Meeting Extractor profile does not match the active prompt and schema contract"
    );
  }
  if (!input.verifierEnabled) return;
  if (!input.providers.verifier
    || input.providers.verifier.profile.promptVersion !== WORK_MEETING_VERIFIER_PROMPT_VERSION
    || input.providers.verifier.profile.schemaVersion !== WORK_MEETING_VERIFIER_SCHEMA_VERSION) {
    throw new WorkAnalysisProviderContractMismatchError(
      "Work Meeting Verifier profile does not match the active prompt and schema contract"
    );
  }
}

type WorkAnalysisExecutionState = {
  callCount: number;
  maxCalls: number;
  stageCallCount: Record<WorkAnalysisProviderCallStage, number>;
  stageMaxCalls: Record<WorkAnalysisProviderCallStage, number>;
  deadlineAt: number;
};

type WorkAnalysisProviderCallStage = "extractor" | "verifier" | "recovery" | "deduplicator";

function stableWorkAnalysisJson(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableWorkAnalysisJson(item) ?? "null").join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().flatMap((key) => {
      const serialized = stableWorkAnalysisJson(value[key]);
      return serialized === undefined ? [] : [`${JSON.stringify(key)}:${serialized}`];
    }).join(",")}}`;
  }
  return undefined;
}

function workAnalysisDigest(value: unknown) {
  const serialized = stableWorkAnalysisJson(value);
  if (serialized === undefined) throw new Error("work_analysis_digest_input_invalid");
  return createHash("sha256").update(serialized).digest("hex");
}

function workAnalysisProviderContractDigest(input: {
  stage: "extractor" | "verifier" | "deduplicator";
  profile: AnalysisProviders["extractor"]["profile"];
  outputSchemaVersion: string;
}) {
  return workAnalysisDigest({
    stage: input.stage,
    pipelineVersion: WORK_MEETING_PIPELINE_VERSION,
    publicationPolicyVersion: WORK_MEETING_PUBLICATION_POLICY_VERSION,
    outputSchemaVersion: input.outputSchemaVersion,
    profile: input.profile
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type WorkExtractorCheckpointGroup = {
  evidenceIds: string[];
  candidates: WorkExtractorCandidateDraft[];
  validation?: WorkExtractorValidationSummary;
};

function validateWorkExtractorCheckpointPayload(input: {
  payload: unknown;
  window: WorkMeetingTranscriptWindow;
}): WorkExtractorCheckpointGroup[] {
  if (!isRecord(input.payload) || !Array.isArray(input.payload.groups)
    || input.payload.groups.length === 0) {
    throw new Error("work_analysis_checkpoint_extractor_payload_invalid");
  }
  let canonicalOffset = 0;
  const groups = input.payload.groups.map((rawGroup) => {
    if (!isRecord(rawGroup) || !Array.isArray(rawGroup.evidenceIds)
      || rawGroup.evidenceIds.length === 0 || !Array.isArray(rawGroup.candidates)
      || rawGroup.evidenceIds.some((id) => typeof id !== "string")) {
      throw new Error("work_analysis_checkpoint_extractor_payload_invalid");
    }
    const evidenceIds = rawGroup.evidenceIds as string[];
    const allowedSegments = input.window.segments.slice(
      canonicalOffset,
      canonicalOffset + evidenceIds.length
    );
    if (allowedSegments.length !== evidenceIds.length
      || evidenceIds.some((id, index) => id !== allowedSegments[index]?.id)) {
      throw new Error("work_analysis_checkpoint_extractor_closure_invalid");
    }
    canonicalOffset += evidenceIds.length;
    const candidates = validateWorkExtractorOutput({
      response: { items: rawGroup.candidates },
      allowedSegments
    }).items;
    const validation = rawGroup.validation === undefined ? undefined
      : WorkExtractorValidationSummarySchema.parse(rawGroup.validation);
    if (validation && validation.retained !== candidates.length) {
      throw new Error("work_analysis_checkpoint_extractor_counts_invalid");
    }
    return { evidenceIds, candidates, ...(validation ? { validation } : {}) };
  });
  if (canonicalOffset !== input.window.segments.length) {
    throw new Error("work_analysis_checkpoint_extractor_closure_invalid");
  }
  return groups;
}

function validateWorkVerifierCheckpointPayload(input: {
  payload: unknown;
  verifierInput: Parameters<typeof buildWorkMeetingVerifierProviderPayload>[0];
}) {
  if (!isRecord(input.payload) || !Array.isArray(input.payload.items)) {
    throw new Error("work_analysis_checkpoint_verifier_payload_invalid");
  }
  return validateWorkMeetingVerifierResult({
    response: input.payload,
    claims: input.verifierInput.claims,
    allowedSegments: input.verifierInput.segments,
    duplicateCoverage: input.verifierInput.duplicateCoverage
  });
}

function assertWorkAnalysisDeadline(state: WorkAnalysisExecutionState) {
  if (Date.now() >= state.deadlineAt) {
    throw new WorkAnalysisExecutionLimitError(
      "work_analysis_deadline_exceeded",
      "Work Meeting analysis deadline was exceeded"
    );
  }
}

function safeWorkExtractorErrorClass(error: unknown) {
  if (error instanceof WorkAnalysisExecutionLimitError) {
    return error.code === "work_analysis_call_budget_exhausted"
      ? "call_budget_exhausted"
      : "analysis_deadline_exceeded";
  }
  return workExtractorRecoveryAction(error);
}

async function runBoundedWorkAnalysisProviderCall<Output>(input: {
  state: WorkAnalysisExecutionState;
  stage: WorkAnalysisProviderCallStage;
  parentSignal: AbortSignal;
  execute: (signal: AbortSignal) => Promise<Output>;
  onStarted: (callNumber: number, stageCallNumber: number) => void;
}): Promise<Output> {
  if (input.state.callCount >= input.state.maxCalls
    || input.state.stageCallCount[input.stage] >= input.state.stageMaxCalls[input.stage]) {
    throw new WorkAnalysisExecutionLimitError(
      "work_analysis_call_budget_exhausted",
      `Work Meeting analysis ${input.stage} Provider call budget was exhausted`
    );
  }
  const remainingMs = input.state.deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new WorkAnalysisExecutionLimitError(
      "work_analysis_deadline_exceeded",
      "Work Meeting analysis deadline was exceeded"
    );
  }
  if (input.parentSignal.aborted) {
    throw input.parentSignal.reason instanceof Error
      ? input.parentSignal.reason
      : new Error("work_analysis_aborted");
  }

  input.state.callCount += 1;
  input.state.stageCallCount[input.stage] += 1;
  input.onStarted(
    input.state.callCount,
    input.state.stageCallCount[input.stage]
  );
  const controller = new AbortController();
  const deadlineError = new WorkAnalysisExecutionLimitError(
    "work_analysis_deadline_exceeded",
    "Work Meeting analysis deadline was exceeded"
  );
  let rejectBoundary!: (reason: unknown) => void;
  let deadlineReached = false;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  const onParentAbort = () => {
    const reason = input.parentSignal.reason instanceof Error
      ? input.parentSignal.reason
      : new Error("work_analysis_aborted");
    controller.abort(reason);
    rejectBoundary(reason);
  };
  input.parentSignal.addEventListener("abort", onParentAbort, { once: true });
  const deadlineTimer = setTimeout(() => {
    deadlineReached = true;
    controller.abort(deadlineError);
    rejectBoundary(deadlineError);
  }, remainingMs);
  deadlineTimer.unref?.();
  try {
    return await Promise.race([
      input.execute(controller.signal),
      boundary
    ]);
  } catch (error) {
    if (deadlineReached) throw deadlineError;
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    input.parentSignal.removeEventListener("abort", onParentAbort);
  }
}

async function runWithSingleTransientProviderRetry<Output>(input: {
  execute: (budgetStage: WorkAnalysisProviderCallStage) => Promise<Output>;
  onRetry: () => void;
}) {
  try {
    return await input.execute("verifier");
  } catch (error) {
    if (!isWorkAnalysisProviderTransientError(error)) throw error;
    input.onRetry();
    return input.execute("recovery");
  }
}

export async function mapWorkAnalysisWithConcurrency<Input, Output>(input: {
  items: Input[];
  concurrency: number;
  worker: (item: Input, index: number, signal: AbortSignal) => Promise<Output>;
}): Promise<Output[]> {
  if (!Number.isInteger(input.concurrency) || input.concurrency < 1) {
    throw new Error("work_analysis_concurrency_must_be_positive");
  }
  const results = new Array<Output>(input.items.length);
  const controller = new AbortController();
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;

  const runWorker = async () => {
    while (true) {
      // Do not dispatch new work after the first terminal error. Calls that
      // were already in flight are intentionally not aborted, so they can
      // finish validation and persist their checkpoints for the next attempt.
      if (failed) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= input.items.length) return;
      try {
        results[index] = await input.worker(input.items[index], index, controller.signal);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        return;
      }
    }
  };

  await Promise.allSettled(Array.from(
    { length: Math.min(input.concurrency, input.items.length) },
    () => runWorker()
  ));
  if (failed) throw firstError;
  return results;
}

async function transcribeIfNeeded(input: {
  request: ProcessWorkMeetingInput;
  repository: WorkReviewRepository;
  transcriber: WorkMeetingTranscriber;
  dependencies: WorkMeetingProcessorDependencies;
  maxAudioDurationSeconds: number;
}) {
  const existing = input.repository.readCanonicalPublication(
    input.request.accountId,
    input.request.meetingId
  );
  if (existing) return { publication: existing, busy: false };

  let meeting = input.repository.getMeeting(input.request.accountId, input.request.meetingId);
  if (meeting.ingestionStatus === "created" || meeting.ingestionStatus === "failed") {
    meeting = input.repository.queueStage({
      accountId: input.request.accountId,
      meetingId: input.request.meetingId,
      stage: "transcription"
    });
  }
  const sourceUpload = input.repository.readSourceUpload(
    input.request.accountId,
    input.request.meetingId
  );
  const fence = input.repository.claimProcessingAttempt({
    accountId: input.request.accountId,
    meetingId: input.request.meetingId,
    stage: "transcription",
    leaseOwner: (input.dependencies.leaseOwnerFactory ?? defaultLeaseOwnerFactory)("transcription"),
    leaseDurationMs: TRANSCRIPTION_LEASE_MS,
    pipelineVersion: WORK_MEETING_PIPELINE_VERSION,
    providerProfile: "work_transcription_configured"
  });
  if (!fence) return { publication: null, busy: true };
  reportProgress(input.dependencies, {
    stage: "transcription", completed: 0, total: 1, state: "started"
  });
  try {
    if (!sourceUpload?.filePath) throw Object.assign(
      new Error("Work Review source audio is unavailable"),
      { code: "work_review_source_audio_unavailable" }
    );
    const sourceDurationSeconds = await (
      input.dependencies.probeDurationSeconds ?? probeAudioDurationSeconds
    )(sourceUpload.filePath);
    if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) {
      throw Object.assign(
        new Error("Work Review audio duration is invalid"),
        { code: "work_review_invalid_audio_duration" }
      );
    }
    if (sourceDurationSeconds > input.maxAudioDurationSeconds) {
      throw Object.assign(
        new Error("Work Review audio exceeds the configured duration limit"),
        { code: "work_review_audio_duration_exceeded" }
      );
    }
    const renewTranscriptionLease = () => {
      input.repository.renewProcessingLease({
        accountId: input.request.accountId,
        meetingId: input.request.meetingId,
        fence,
        leaseDurationMs: TRANSCRIPTION_LEASE_MS
      });
    };
    const segments = await withLeaseHeartbeat({
      renew: renewTranscriptionLease,
      leaseDurationMs: TRANSCRIPTION_LEASE_MS,
      task: () => input.transcriber({
        uploadId: meeting.sourceUploadId,
        filePath: sourceUpload.filePath!,
        mimeType: sourceUpload.mimeType,
        store: input.request.store,
        userId: input.request.accountId,
        onChunkProgress: (event) => {
          renewTranscriptionLease();
          reportProgress(input.dependencies, {
            stage: "transcription",
            completed: event.completed,
            total: event.total,
            state: "processing"
          });
        }
      })
    });
    const published = input.repository.publishCanonicalTranscript({
      accountId: input.request.accountId,
      meetingId: input.request.meetingId,
      fence,
      segments,
      sourceDurationSeconds
    }).publication;
    reportProgress(input.dependencies, {
      stage: "transcription", completed: 1, total: 1, state: "completed"
    });
    try {
      await (input.dependencies.cleanupRawAudio ?? defaultCleanupRawAudio)({
        filePath: sourceUpload.filePath,
        uploadsRootDir: input.request.uploadsRootDir,
        uploadId: sourceUpload.uploadId,
        store: input.request.store
      });
      input.repository.clearSourceUploadPath({
        accountId: input.request.accountId,
        meetingId: input.request.meetingId,
        expectedFilePath: sourceUpload.filePath
      });
    } catch {
      console.warn("[work-review] source_audio_cleanup_failed");
    }
    return { publication: published, busy: false };
  } catch (error) {
    safeMarkFailed({
      repository: input.repository,
      accountId: input.request.accountId,
      meetingId: input.request.meetingId,
      fence,
      code: errorCode(error, "work_review_transcription_failed")
    });
    reportProgress(input.dependencies, {
      stage: "transcription", completed: 0, total: 1, state: "failed"
    });
    return { publication: null, busy: false };
  }
}

async function analyzeIfEnabled(input: {
  request: ProcessWorkMeetingInput;
  repository: WorkReviewRepository;
  publication: NonNullable<ReturnType<WorkReviewRepository["readCanonicalPublication"]>>;
  flags: WorkReviewFeatureFlags;
  dependencies: WorkMeetingProcessorDependencies;
}) {
  const current = input.repository.getMeeting(input.request.accountId, input.request.meetingId);
  if (current.analysisStatus === "review_ready") return { ready: true, busy: false };
  if (!input.flags.analysisEnabled) return { ready: false, busy: false };
  if (current.analysisStatus === "not_started" || current.analysisStatus === "failed") {
    input.repository.queueStage({
      accountId: input.request.accountId,
      meetingId: input.request.meetingId,
      stage: "meeting_analysis"
    });
  }
  let providers: AnalysisProviders;
  let extractorExecutionPolicy: WorkReviewExtractorExecutionPolicy;
  try {
    providers = (input.dependencies.createAnalysisProviders ?? defaultAnalysisProviders)({
      verifierEnabled: input.flags.verifierEnabled
    });
    extractorExecutionPolicy = (
      input.dependencies.resolveExtractorExecutionPolicy
      ?? resolveWorkReviewExtractorExecutionPolicy
    )();
    assertWorkAnalysisProviderContracts({
      providers,
      verifierEnabled: input.flags.verifierEnabled
    });
  } catch (error) {
    const fence = input.repository.claimProcessingAttempt({
      accountId: input.request.accountId,
      meetingId: input.request.meetingId,
      stage: "meeting_analysis",
      leaseOwner: (input.dependencies.leaseOwnerFactory ?? defaultLeaseOwnerFactory)("meeting_analysis"),
      leaseDurationMs: ANALYSIS_LEASE_MS,
      pipelineVersion: WORK_MEETING_PIPELINE_VERSION,
      providerProfile: "work_analysis_unavailable",
      promptVersion: null
    });
    if (fence) safeMarkFailed({
      repository: input.repository,
      accountId: input.request.accountId,
      meetingId: input.request.meetingId,
      fence,
      code: errorCode(error, "work_review_analysis_unavailable")
    });
    return { ready: false, busy: !fence };
  }
  const requestedAnalysisDeadlineAt = new Date(
    Date.now() + extractorExecutionPolicy.analysisDeadlineMs
  ).toISOString();
  const fence = input.repository.claimProcessingAttempt({
    accountId: input.request.accountId,
    meetingId: input.request.meetingId,
    stage: "meeting_analysis",
    leaseOwner: (input.dependencies.leaseOwnerFactory ?? defaultLeaseOwnerFactory)("meeting_analysis"),
    leaseDurationMs: ANALYSIS_LEASE_MS,
    pipelineVersion: WORK_MEETING_PIPELINE_VERSION,
    providerProfile: providers.extractor.profile.profileId,
    promptVersion: providers.extractor.profile.promptVersion,
    deadlineAt: requestedAnalysisDeadlineAt
  });
  if (!fence) return { ready: false, busy: true };
  const analysisDeadlineAt = Date.parse(fence.deadlineAt ?? "");
  if (!Number.isFinite(analysisDeadlineAt)) {
    safeMarkFailed({
      repository: input.repository,
      accountId: input.request.accountId,
      meetingId: input.request.meetingId,
      fence,
      code: "work_analysis_deadline_invalid"
    });
    return { ready: false, busy: false };
  }

  const extractorProviderContractDigest = workAnalysisProviderContractDigest({
    stage: "extractor",
    profile: providers.extractor.profile,
    outputSchemaVersion: WORK_MEETING_EXTRACTOR_SCHEMA_VERSION
  });
  const verifierProviderContractDigest = providers.verifier
    ? workAnalysisProviderContractDigest({
        stage: "verifier",
        profile: providers.verifier.profile,
        outputSchemaVersion: WORK_MEETING_VERIFIER_SCHEMA_VERSION
      })
    : null;

  let analysisProgressTotal = 0;
  let analysisProgressCompleted = 0;
  try {
    const windows = buildWorkMeetingTranscriptWindows(input.publication.segments, {
      targetInputTokens: extractorExecutionPolicy.targetInputTokensPerWindow,
      maxInputTokens: extractorExecutionPolicy.maxInputTokensPerWindow,
      ...(extractorExecutionPolicy.targetInputTokensPerWindow > 1_200 ? {
        preferredMinInputTokens: Math.floor(extractorExecutionPolicy.targetInputTokensPerWindow * 0.8),
        preferredMaxInputTokens: Math.min(
          extractorExecutionPolicy.maxInputTokensPerWindow,
          Math.ceil(extractorExecutionPolicy.targetInputTokensPerWindow * 1.2)
        )
      } : {})
    });
    analysisProgressTotal = windows.length;
    reportProgress(input.dependencies, {
      stage: "meeting_analysis", completed: 0, total: windows.length, state: "started"
    });
    const analysisConcurrency = (
      input.dependencies.resolveAnalysisConcurrency ?? resolveWorkReviewAnalysisConcurrency
    )();
    const analysisExecutionState: WorkAnalysisExecutionState = {
      callCount: 0,
      maxCalls: extractorExecutionPolicy.maxProviderCalls,
      stageCallCount: {
        extractor: 0,
        verifier: 0,
        recovery: 0,
        deduplicator: 0
      },
      stageMaxCalls: {
        extractor: extractorExecutionPolicy.extractorMaxProviderCalls,
        verifier: extractorExecutionPolicy.verifierMaxProviderCalls,
        recovery: extractorExecutionPolicy.recoveryMaxProviderCalls,
        // The single global pass reserves verification/recovery capacity first.
        deduplicator: 1
      },
      deadlineAt: analysisDeadlineAt
    };
    console.info(
      `[work-review] stage=meeting_analysis provider_budget=started initial_windows=${windows.length} max_calls=${analysisExecutionState.maxCalls} extractor_calls=${analysisExecutionState.stageMaxCalls.extractor} verifier_calls=${analysisExecutionState.stageMaxCalls.verifier} recovery_calls=${analysisExecutionState.stageMaxCalls.recovery} deadline_ms=${extractorExecutionPolicy.analysisDeadlineMs}`
    );
    const batchGroups = await mapWorkAnalysisWithConcurrency({
      items: windows,
      concurrency: analysisConcurrency,
      worker: async (window, _index, signal) => {
        const extractorLogicalInputDigest = workAnalysisDigest({
          publicationId: input.publication.publicationId,
          canonicalContentDigest: input.publication.contentDigest,
          window: {
            index: window.index,
            count: window.count,
            segments: window.segments
          },
          windowing: {
            targetInputTokens: extractorExecutionPolicy.targetInputTokensPerWindow,
            maxInputTokens: extractorExecutionPolicy.maxInputTokensPerWindow,
            recoverySplitDepth: extractorExecutionPolicy.maxRecoverySplitDepth
          }
        });
        const extractorCheckpointInput = {
          accountId: input.request.accountId,
          meetingId: input.request.meetingId,
          fence,
          publicationId: input.publication.publicationId,
          canonicalContentDigest: input.publication.contentDigest,
          checkpointKind: "extractor_block" as const,
          logicalInputDigest: extractorLogicalInputDigest,
          providerContractDigest: extractorProviderContractDigest,
          outputSchemaVersion: WORK_MEETING_EXTRACTOR_SCHEMA_VERSION
        };
        const cachedCheckpoint = input.repository.readAnalysisCheckpoint(
          extractorCheckpointInput
        );
        if (cachedCheckpoint) {
          const cachedGroups = validateWorkExtractorCheckpointPayload({
            payload: cachedCheckpoint.payload,
            window
          });
          console.info(
            `[work-review] stage=meeting_analysis checkpoint=hit kind=extractor_block initial_window=${window.index + 1}/${window.count} groups=${cachedGroups.length}`
          );
          analysisProgressCompleted += 1;
          reportProgress(input.dependencies, {
            stage: "meeting_analysis",
            completed: analysisProgressCompleted,
            total: analysisProgressTotal,
            state: "processing"
          });
          return cachedGroups;
        }
        const legacyRecoveryCheckpointInput = (
          targetWindow: typeof window,
          recoveryDepth: number
        ) => ({
          accountId: input.request.accountId,
          meetingId: input.request.meetingId,
          fence,
          publicationId: input.publication.publicationId,
          canonicalContentDigest: input.publication.contentDigest,
          checkpointKind: "extractor_block" as const,
          logicalInputDigest: workAnalysisDigest({
            checkpointScope: "recovery_leaf",
            publicationId: input.publication.publicationId,
            canonicalContentDigest: input.publication.contentDigest,
            initialWindowId: workAnalysisDigest({
              index: window.index,
              count: window.count,
              segments: window.segments
            }),
            initialWindow: {
              index: window.index,
              count: window.count,
              evidenceIds: window.evidenceIds
            },
            recoveryDepth,
            targetWindow: {
              index: targetWindow.index,
              count: targetWindow.count,
              segments: targetWindow.segments
            },
            windowing: {
              targetInputTokens: extractorExecutionPolicy.targetInputTokensPerWindow,
              maxInputTokens: extractorExecutionPolicy.maxInputTokensPerWindow,
              recoverySplitDepth: extractorExecutionPolicy.maxRecoverySplitDepth
            }
          }),
          providerContractDigest: extractorProviderContractDigest,
          outputSchemaVersion: WORK_MEETING_EXTRACTOR_SCHEMA_VERSION
        });
        const extract = async (
          targetWindow: typeof window,
          budgetStage: WorkAnalysisProviderCallStage,
          schemaRepair?: WorkExtractorSchemaRepair
        ) => {
          let callNumber = 0;
          let stageCallNumber = 0;
          let validation: WorkExtractorValidationSummary | undefined;
          const startedAt = Date.now();
          try {
            const candidates = await runBoundedWorkAnalysisProviderCall({
              state: analysisExecutionState,
              stage: budgetStage,
              parentSignal: signal,
              onStarted: (allocatedCallNumber, allocatedStageCallNumber) => {
                callNumber = allocatedCallNumber;
                stageCallNumber = allocatedStageCallNumber;
                console.info(
                  `[work-review] stage=meeting_analysis extractor_call=${callNumber}/${analysisExecutionState.maxCalls} budget_stage=${budgetStage} stage_call=${stageCallNumber}/${analysisExecutionState.stageMaxCalls[budgetStage]} state=started initial_window=${window.index + 1}/${window.count} segments=${targetWindow.segments.length} estimated_input_tokens=${targetWindow.estimatedInputTokens}`
                );
              },
              execute: async (boundedSignal) => {
                input.repository.renewProcessingLease({
                  accountId: input.request.accountId,
                  meetingId: input.request.meetingId,
                  fence,
                  leaseDurationMs: ANALYSIS_LEASE_MS
                });
                const extracted = await providers.extractor.extract({
                  accountId: input.request.accountId,
                  meetingId: input.request.meetingId,
                  publicationId: input.publication.publicationId,
                  canonicalDigest: input.publication.contentDigest,
                  window: targetWindow,
                  schemaRepair,
                  onItemDiscarded: (discard) => {
                    const issueSummary = discard.issues
                      .map((issue) => `${issue.path}:${issue.code}`)
                      .join(",");
                    console.warn(
                      `[work-review] stage=meeting_analysis extractor_item=discarded initial_window=${window.index + 1}/${window.count} item_index=${discard.itemIndex} reason=${discard.reason} issues=${issueSummary || "none"} issues_truncated=${discard.issuesTruncated}`
                    );
                  },
                  onItemsValidated: (summary) => {
                    validation = WorkExtractorValidationSummarySchema.parse(summary);
                    console.info(`[work-review] stage=meeting_analysis extractor_validation=${summary.result} initial_window=${window.index + 1}/${window.count} segments=${targetWindow.segments.length} estimated_input_tokens=${targetWindow.estimatedInputTokens} returned=${summary.returned} retained=${summary.retained} discarded=${summary.discarded} reasons=${JSON.stringify(summary.reasons)} model=${encodeURIComponent(providers.extractor.profile.model)} prompt=${encodeURIComponent(providers.extractor.profile.promptVersion)} schema=${encodeURIComponent(providers.extractor.profile.schemaVersion)}`);
                  },
                  signal: boundedSignal
                });
                if (boundedSignal.aborted) {
                  throw boundedSignal.reason instanceof Error
                    ? boundedSignal.reason
                    : new Error("work_analysis_aborted");
                }
                const validated = validateWorkExtractorOutput({
                  response: { items: extracted },
                  allowedSegments: targetWindow.segments
                }).items;
                input.repository.renewProcessingLease({
                  accountId: input.request.accountId,
                  meetingId: input.request.meetingId,
                  fence,
                  leaseDurationMs: ANALYSIS_LEASE_MS
                });
                return validated;
              }
            });
            console.info(
              `[work-review] stage=meeting_analysis extractor_call=${callNumber}/${analysisExecutionState.maxCalls} budget_stage=${budgetStage} stage_call=${stageCallNumber}/${analysisExecutionState.stageMaxCalls[budgetStage]} state=completed elapsed_ms=${Math.max(0, Date.now() - startedAt)} candidates=${candidates.length}`
            );
            return { candidates, ...(validation ? { validation } : {}) };
          } catch (error) {
            console.warn(
              `[work-review] stage=meeting_analysis extractor_call=${callNumber || "blocked"}/${analysisExecutionState.maxCalls} budget_stage=${budgetStage} state=failed elapsed_ms=${Math.max(0, Date.now() - startedAt)} error_class=${safeWorkExtractorErrorClass(error)}`
            );
            throw error;
          }
        };
        const extractMissingBlock = async (
          targetWindow: typeof window,
          recoveryCheckpointInput?: ReturnType<typeof legacyRecoveryCheckpointInput>
        ): Promise<WorkExtractorCheckpointGroup> => {
          let result: { candidates: WorkExtractorCandidateDraft[]; validation?: WorkExtractorValidationSummary };
          try {
            result = await extract(targetWindow, "extractor");
          } catch (error) {
            const recoveryAction = workExtractorRecoveryAction(error);
            if (recoveryAction === "fail") throw error;
            console.warn(
              `[work-review] stage=meeting_analysis recovery=${recoveryAction} attempt=1/1 window=${window.index + 1}/${window.count} segments=${targetWindow.segments.length}`
            );
            result = await extract(
              targetWindow,
              "recovery",
              recoveryAction === "json_repair"
                ? workExtractorSchemaRepair(error)
                : undefined
            );
          }
          const group = {
            evidenceIds: targetWindow.evidenceIds,
            ...result
          };
          if (recoveryCheckpointInput) {
            input.repository.saveAnalysisCheckpoint({
              ...recoveryCheckpointInput,
              payload: { groups: [group] }
            });
            console.info(
              `[work-review] stage=meeting_analysis checkpoint=saved kind=extractor_block scope=legacy_recovery_leaf initial_window=${window.index + 1}/${window.count} segments=${targetWindow.segments.length}`
            );
          }
          return group;
        };
        // New failures never create timeout-driven splits. This compatibility
        // path only discovers and completes a split that was already
        // checkpointed by an earlier attempt (notably the existing A1 run).
        const legacyRecoveryWindows = extractorExecutionPolicy.maxRecoverySplitDepth > 0
          ? splitWorkMeetingTranscriptWindow(window)
          : [];
        const legacyRecoveryEntries = legacyRecoveryWindows.length >= 2
          ? legacyRecoveryWindows.map((recoveryWindow) => {
              const checkpointInput = legacyRecoveryCheckpointInput(recoveryWindow, 1);
              const checkpoint = input.repository.readAnalysisCheckpoint(checkpointInput);
              if (!checkpoint) return { recoveryWindow, checkpointInput, groups: null };
              const groups = validateWorkExtractorCheckpointPayload({
                payload: checkpoint.payload,
                window: recoveryWindow
              });
              if (groups.length !== 1
                || groups[0].evidenceIds.length !== recoveryWindow.evidenceIds.length
                || groups[0].evidenceIds.some(
                  (id, index) => id !== recoveryWindow.evidenceIds[index]
                )) {
                throw new Error("work_analysis_checkpoint_extractor_recovery_leaf_invalid");
              }
              return { recoveryWindow, checkpointInput, groups };
            })
          : [];
        const hasLegacyRecoveryCheckpoint = legacyRecoveryEntries.some(
          (entry) => entry.groups !== null
        );
        const groups = hasLegacyRecoveryCheckpoint
          ? await Promise.all(legacyRecoveryEntries.map(async (entry) => {
              if (entry.groups) {
                console.info(
                  `[work-review] stage=meeting_analysis checkpoint=hit kind=extractor_block scope=legacy_recovery_leaf initial_window=${window.index + 1}/${window.count} segments=${entry.recoveryWindow.segments.length}`
                );
                return entry.groups[0];
              }
              return extractMissingBlock(entry.recoveryWindow, entry.checkpointInput);
            }))
          : [await extractMissingBlock(window)];
        input.repository.saveAnalysisCheckpoint({
          ...extractorCheckpointInput,
          payload: { groups }
        });
        console.info(
          `[work-review] stage=meeting_analysis checkpoint=saved kind=extractor_block initial_window=${window.index + 1}/${window.count} groups=${groups.length}`
        );
        analysisProgressCompleted += 1;
        reportProgress(input.dependencies, {
          stage: "meeting_analysis",
          completed: analysisProgressCompleted,
          total: analysisProgressTotal,
          state: "processing"
        });
        return groups;
      }
    });
    const batches = batchGroups.flat().map((batch, windowIndex) => ({
      windowIndex,
      candidates: batch.candidates
    }));
    const extractionSummaries = batchGroups.flat().flatMap(group => group.validation ? [group.validation] : []);
    console.info(`[work-review] stage=meeting_analysis extraction_coverage=reported blocks=${batches.length} observed_blocks=${extractionSummaries.length} provider_empty=${extractionSummaries.filter(s => s.result === "provider_empty").length} all_discarded=${extractionSummaries.filter(s => s.result === "all_discarded").length} partially_retained=${extractionSummaries.filter(s => s.result === "partially_retained").length}`);
    assertWorkAnalysisDeadline(analysisExecutionState);
    const assembledCandidates = assembleWorkMeetingCandidates({
      accountId: input.request.accountId,
      meetingId: input.request.meetingId,
      publicationId: input.publication.publicationId,
      canonicalDigest: input.publication.contentDigest,
      segments: input.publication.segments,
      batches
    });
    const verifierAvailable = input.flags.verifierEnabled && providers.verifier !== undefined;
    const organizationCheckpointInput = {
      accountId: input.request.accountId, meetingId: input.request.meetingId, fence,
      publicationId: input.publication.publicationId,
      canonicalContentDigest: input.publication.contentDigest,
      checkpointKind: "organization_plan" as const,
      logicalInputDigest: workAnalysisDigest({ assembledCandidates, canonicalDigest: input.publication.contentDigest }),
      providerContractDigest: workAnalysisDigest({
        verifierAvailable,
        provider: providers.deduplicator ? workAnalysisProviderContractDigest({
          stage: "deduplicator", profile: providers.deduplicator.profile,
          outputSchemaVersion: WORK_MEETING_DEDUPLICATOR_SCHEMA_VERSION
        }) : "unavailable",
        pipelineVersion: WORK_MEETING_PIPELINE_VERSION
      }),
      outputSchemaVersion: WORK_MEETING_DEDUPLICATOR_SCHEMA_VERSION
    };
    let organization = applyWorkMeetingOrganization(assembledCandidates, {}, input.publication.segments);
    let organizationCheckpoint = WorkMeetingOrganizationCheckpointSchema.parse({
      state: "fallback", reason: "provider_unavailable", response: organization.acceptedPlan, skippedInvalidCount: 0
    });
    analysisProgressTotal += 1;
    const cachedOrganization = input.repository.readAnalysisCheckpoint(organizationCheckpointInput);
    if (cachedOrganization) {
      organizationCheckpoint = WorkMeetingOrganizationCheckpointSchema.parse(cachedOrganization.payload);
      organization = applyWorkMeetingOrganization(assembledCandidates, organizationCheckpoint.response, input.publication.segments);
      if (organization.skippedInvalidCount !== 0) throw new Error("work_analysis_checkpoint_organization_payload_invalid");
      console.info("[work-review] stage=meeting_analysis checkpoint=hit kind=organization_plan progress=1/1");
    } else {
      if (assembledCandidates.length < 2) {
        organizationCheckpoint = { ...organizationCheckpoint, state: "not_needed", reason: "too_few_candidates" };
      } else if (verifierAvailable && providers.deduplicator) {
        const remainingMs = analysisExecutionState.deadlineAt - Date.now();
        const reservedCalls = analysisExecutionState.stageMaxCalls.verifier
          + Math.max(0, analysisExecutionState.stageMaxCalls.recovery - analysisExecutionState.stageCallCount.recovery);
        const reservedMs = (Math.ceil(analysisExecutionState.stageMaxCalls.verifier / analysisConcurrency)
          + Math.max(0, analysisExecutionState.stageMaxCalls.recovery - analysisExecutionState.stageCallCount.recovery))
          * providers.verifier!.profile.timeoutMs + 5_000;
        const organizerTimeoutMs = Math.min(WORK_MEETING_DEDUPLICATOR_TIMEOUT_MS,
          providers.deduplicator.profile.timeoutMs, remainingMs - reservedMs);
        if (analysisExecutionState.callCount + 1 + reservedCalls > analysisExecutionState.maxCalls || organizerTimeoutMs <= 0) {
          organizationCheckpoint.reason = "budget_or_deadline";
        } else {
          console.info(`[work-review] stage=meeting_analysis organization=started progress=0/1 candidates=${assembledCandidates.length} timeout_ms=${organizerTimeoutMs} reserved_ms=${reservedMs}`);
          input.repository.renewProcessingLease({ accountId: input.request.accountId,
            meetingId: input.request.meetingId, fence, leaseDurationMs: ANALYSIS_LEASE_MS });
          try {
            buildWorkMeetingDeduplicationPayload(assembledCandidates, input.publication.segments);
            const response = await runBoundedWorkAnalysisProviderCall({
              state: analysisExecutionState, stage: "deduplicator",
              parentSignal: AbortSignal.timeout(organizerTimeoutMs),
              onStarted: callNumber => console.info(`[work-review] stage=meeting_analysis deduplicator_call=${callNumber}/${analysisExecutionState.maxCalls} budget_stage=deduplicator stage_call=1/1 state=started`),
              execute: signal => providers.deduplicator!.deduplicate({ candidates: assembledCandidates, segments: input.publication.segments, signal })
            });
            const proposed = applyWorkMeetingOrganization(assembledCandidates, response, input.publication.segments);
            if (proposed.skippedInvalidCount > 0 && Object.values(proposed.acceptedPlan).every(rows => rows.length === 0)) {
              organizationCheckpoint.skippedInvalidCount = proposed.skippedInvalidCount;
              organizationCheckpoint.rejectedAdvice = proposed.rejectedAdvice;
              throw new Error("work_organization_no_valid_advice");
            }
            // Optional organization must not turn an otherwise affordable
            // verification graph into a meeting-wide capacity failure.
            const proposedCandidates = attachWorkQuestionResolutionClaims({ candidates: proposed.candidates, segments: input.publication.segments });
            planWorkCandidatesForVerification({ candidates: selectWorkCandidatesForGptVerification({
              candidates: proposedCandidates, segments: input.publication.segments
            }), segments: input.publication.segments });
            organization = proposed;
            organizationCheckpoint = { state: "applied", reason: "completed", response: organization.acceptedPlan,
              skippedInvalidCount: organization.skippedInvalidCount, rejectedAdvice: organization.rejectedAdvice };
          } catch (error) {
            organizationCheckpoint.reason = error instanceof WorkMeetingAnalysisLimitError
              ? "verification_capacity"
              : error instanceof WorkMeetingAnalysisProviderError && error.code === "work_analysis_provider_timeout"
                || error instanceof Error && error.name === "TimeoutError" ? "provider_timeout"
                : error instanceof Error && ["AbortError", "APIUserAbortError"].includes(error.name)
                  ? "provider_cancelled" : "provider_or_plan_failure";
            console.warn(`[work-review] stage=meeting_analysis organization=fallback progress=1/1 reason=${organizationCheckpoint.reason}`);
          }
        }
      }
      // Fencing/storage errors must escape the optional Provider fallback.
      input.repository.renewProcessingLease({ accountId: input.request.accountId,
        meetingId: input.request.meetingId, fence, leaseDurationMs: ANALYSIS_LEASE_MS });
      input.repository.saveAnalysisCheckpoint({ ...organizationCheckpointInput, payload: organizationCheckpoint });
    }
    console.info(`[work-review] stage=meeting_analysis organization=${organizationCheckpoint.state} reason=${organizationCheckpoint.reason} progress=1/1 groups=${organization.groups.length} skipped_invalid=${organizationCheckpoint.skippedInvalidCount} candidates=${organization.candidates.length}`);
    analysisProgressCompleted += 1;
    reportProgress(input.dependencies, { stage: "meeting_analysis", completed: analysisProgressCompleted,
      total: analysisProgressTotal, state: "processing" });
    const candidates = attachWorkQuestionResolutionClaims({
      candidates: organization.candidates,
      segments: input.publication.segments
    });
    console.info(
      `[work-review] stage=meeting_analysis consolidation=completed local_candidates=${batches.reduce((total, batch) => total + batch.candidates.length, 0)} assembled_candidates=${candidates.length} resolution_claims=${candidates.flatMap((candidate) => candidate.claims).filter((claim) => claim.claimType === "question_resolution").length}`
    );
    assertWorkAnalysisDeadline(analysisExecutionState);
    input.repository.markAnalysisVerifying({
      accountId: input.request.accountId,
      meetingId: input.request.meetingId,
      fence
    });
    input.repository.renewProcessingLease({
      accountId: input.request.accountId,
      meetingId: input.request.meetingId,
      fence,
      leaseDurationMs: ANALYSIS_LEASE_MS
    });
    const timestampQualityBySegmentId = timestampQualityMap(
      input.publication.segments.map((segment) => segment.id)
    );
    const allClaims = candidates.flatMap((candidate) => candidate.claims);
    const gptCandidates = selectWorkCandidatesForGptVerification({
      candidates,
      segments: input.publication.segments
    });
    const gptClaims = gptCandidates.flatMap((candidate) => candidate.claims);
    const gptClaimIds = new Set(gptClaims.map((claim) => claim.id));
    const verifierBatchBudget = Math.min(analysisExecutionState.stageMaxCalls.verifier,
      Math.max(0, analysisExecutionState.maxCalls - analysisExecutionState.callCount));
    if (verifierAvailable && verifierBatchBudget === 0 && gptClaims.some(claim => !isWorkOptionalAttributeClaim(claim))) {
      throw new WorkAnalysisExecutionLimitError("work_analysis_call_budget_exhausted", "Work Meeting verifier Provider call budget was exhausted");
    }
    const verificationPlan = verifierAvailable && verifierBatchBudget > 0 ? planWorkCandidatesForVerification({ candidates: gptCandidates,
      segments: input.publication.segments, maxBatches: verifierBatchBudget })
      : { batches: [], deferredClaimIds: verifierAvailable ? gptClaims.map(claim => claim.id) : [] };
    const capacityDeferredIds = new Set(verificationPlan.deferredClaimIds);
    const optionalRequestFailedIds = new Set<string>();
    const scheduledGptClaims = verificationPlan.batches.flatMap(batch => batch.flatMap(candidate => candidate.claims));
    console.info(`[work-review] stage=meeting_analysis verifier_capacity scheduled_claims=${scheduledGptClaims.length} optional_not_checked=${capacityDeferredIds.size} reason=capacity batches=${verificationPlan.batches.length}/${analysisExecutionState.stageMaxCalls.verifier}`);
    let gptVerifierDrafts: WorkVerifierClaimDraft[] = [];
    const coverageRequests = buildWorkDuplicateCoverageRequests({ candidates, duplicates: organization.duplicates,
      scope: { accountId: input.request.accountId, meetingId: input.request.meetingId,
        publicationId: input.publication.publicationId, canonicalDigest: input.publication.contentDigest },
      segments: input.publication.segments });
    let coverageEvaluations: WorkDuplicateCoverageEvaluation[] = coverageRequests.map(r => ({
      relationId: r.relationId, verdict: "uncertain", reason: verifierAvailable && verifierBatchBudget === 0 ? "capacity" : "verifier_unavailable", supportedEvidenceIds: []
    }));
    if (verifierAvailable && verifierBatchBudget > 0 && (gptClaims.length > 0 || coverageRequests.length > 0)) {
      const verifierBatches = verificationPlan.batches;
      const packed = packWorkDuplicateCoverageForVerification({
        base: { accountId: input.request.accountId, meetingId: input.request.meetingId,
          publicationId: input.publication.publicationId, canonicalDigest: input.publication.contentDigest,
          segments: input.publication.segments, timestampQualityBySegmentId },
        batches: verifierBatches, requests: coverageRequests, maxBatches: verifierBatchBudget
      });
      coverageEvaluations = packed.unchecked;
      analysisProgressTotal += packed.inputs.length;
      const verifierBatchResults = await mapWorkAnalysisWithConcurrency({
        items: packed.inputs,
        concurrency: analysisConcurrency,
        worker: async (verifierInput, _index, signal) => {
          input.repository.renewProcessingLease({
            accountId: input.request.accountId,
            meetingId: input.request.meetingId,
            fence,
            leaseDurationMs: ANALYSIS_LEASE_MS
          });
          const verifierLogicalInputDigest = workAnalysisDigest({
            publicationId: input.publication.publicationId,
            canonicalContentDigest: input.publication.contentDigest,
            providerPayload: buildWorkMeetingVerifierProviderPayload(verifierInput)
          });
          const verifierCheckpointInput = {
            accountId: input.request.accountId,
            meetingId: input.request.meetingId,
            fence,
            publicationId: input.publication.publicationId,
            canonicalContentDigest: input.publication.contentDigest,
            checkpointKind: "verifier_batch" as const,
            logicalInputDigest: verifierLogicalInputDigest,
            providerContractDigest: verifierProviderContractDigest!,
            outputSchemaVersion: WORK_MEETING_VERIFIER_SCHEMA_VERSION
          };
          const cachedCheckpoint = input.repository.readAnalysisCheckpoint(
            verifierCheckpointInput
          );
          if (cachedCheckpoint) {
            const cachedItems = validateWorkVerifierCheckpointPayload({
              payload: cachedCheckpoint.payload,
              verifierInput
            });
            console.info(
              `[work-review] stage=meeting_analysis checkpoint=hit kind=verifier_batch claims=${verifierInput.claims.length}`
            );
            analysisProgressCompleted += 1;
            reportProgress(input.dependencies, {
              stage: "meeting_analysis",
              completed: analysisProgressCompleted,
              total: analysisProgressTotal,
              state: "processing"
            });
            return cachedItems;
          }
          const runVerifierProviderCall = (
            budgetStage: WorkAnalysisProviderCallStage
          ) => runBoundedWorkAnalysisProviderCall({
            state: analysisExecutionState,
            stage: budgetStage,
            parentSignal: signal,
            onStarted: (callNumber, stageCallNumber) => {
              console.info(
                `[work-review] stage=meeting_analysis verifier_call=${callNumber}/${analysisExecutionState.maxCalls} budget_stage=${budgetStage} stage_call=${stageCallNumber}/${analysisExecutionState.stageMaxCalls[budgetStage]} state=started claims=${verifierInput.claims.length}`
              );
            },
            execute: async (boundedSignal) => {
              const boundedVerifierInput = {
                ...verifierInput,
                signal: boundedSignal
              };
              const response = await providers.verifier!.verify(boundedVerifierInput);
              if (boundedSignal.aborted) {
                throw boundedSignal.reason instanceof Error
                  ? boundedSignal.reason
                  : new Error("work_analysis_aborted");
              }
              return validateWorkMeetingVerifierResult({
                response,
                claims: verifierInput.claims,
                allowedSegments: verifierInput.segments,
                duplicateCoverage: verifierInput.duplicateCoverage
              });
            }
          });
          const optionalOnly = verifierInput.claims.every(isWorkOptionalAttributeClaim);
          let optionalRequestFailed = false;
          const result = optionalOnly
            ? await runVerifierProviderCall("verifier").catch(error => {
              // Optional-only batches cannot invalidate completed required
              // Claims. Cancellation, deadline and storage/fencing still escape.
              if (signal.aborted || !(error instanceof WorkMeetingAnalysisProviderError)) throw error;
              optionalRequestFailed = true;
              verifierInput.claims.forEach(claim => optionalRequestFailedIds.add(claim.id));
              console.warn(`[work-review] stage=meeting_analysis optional_verifier=failed claims=${verifierInput.claims.length} reason=${error.code}`);
              return { items: [],
              coverage: (verifierInput.duplicateCoverage ?? []).map(r => ({ relationId: r.relationId,
                verdict: "uncertain" as const, reason: "request_failed" as const, supportedEvidenceIds: [] })) };
            })
            : verifierInput.duplicateCoverage?.length
            ? await runVerifierProviderCall("verifier").catch(error => {
              // An optional-only failure can retain its originals. Required
              // Claim failure still obeys the existing atomic-publication gate.
              if (verifierInput.claims.length || signal.aborted) throw error;
              return { items: [], coverage: verifierInput.duplicateCoverage!.map(r => ({
                relationId: r.relationId, verdict: "uncertain" as const, reason: "request_failed" as const, supportedEvidenceIds: []
              })) };
            })
            : await runWithSingleTransientProviderRetry({
            execute: runVerifierProviderCall,
            onRetry: () => {
              console.warn(
                `[work-review] stage=meeting_analysis recovery=transient_verifier_retry attempt=1/1 claims=${verifierInput.claims.length}`
              );
            }
          });
          if (!optionalRequestFailed) {
            input.repository.saveAnalysisCheckpoint({ ...verifierCheckpointInput, payload: result });
            console.info(`[work-review] stage=meeting_analysis checkpoint=saved kind=verifier_batch claims=${verifierInput.claims.length}`);
          }
          input.repository.renewProcessingLease({
            accountId: input.request.accountId,
            meetingId: input.request.meetingId,
            fence,
            leaseDurationMs: ANALYSIS_LEASE_MS
          });
          analysisProgressCompleted += 1;
          reportProgress(input.dependencies, {
            stage: "meeting_analysis",
            completed: analysisProgressCompleted,
            total: analysisProgressTotal,
            state: "processing"
          });
          return result;
        }
      });
      gptVerifierDrafts.push(...verifierBatchResults.flatMap(r => r.items));
      coverageEvaluations.push(...verifierBatchResults.flatMap(r => r.coverage));
      gptVerifierDrafts = validateAggregatedWorkVerifierOutput({
        response: { items: gptVerifierDrafts },
        claims: scheduledGptClaims,
        allowedSegments: input.publication.segments,
        requireComplete: false
      }).items;
    }
    assertWorkAnalysisDeadline(analysisExecutionState);
    const gptEvaluationByClaimId = new Map(gptVerifierDrafts.map((evaluation) => [
      evaluation.claimId,
      evaluation
    ]));
    const verifierDrafts: WorkVerifierClaimDraft[] = allClaims.map((claim) => {
      if (capacityDeferredIds.has(claim.id)) return {
        claimId: claim.id, supportVerdict: "unverifiable", issueCodes: [WORK_MEETING_VERIFIER_CAPACITY_ISSUE_CODE], supportedEvidenceIds: []
      };
      if (optionalRequestFailedIds.has(claim.id)) return {
        claimId: claim.id, supportVerdict: "unverifiable", issueCodes: ["verifier_optional_request_failed"], supportedEvidenceIds: []
      };
      if (!gptClaimIds.has(claim.id)) {
        return {
          claimId: claim.id,
          supportVerdict: "unverifiable",
          issueCodes: [WORK_MEETING_NON_GPT_ISSUE_CODE],
          supportedEvidenceIds: []
        };
      }
      if (!verifierAvailable) {
        return {
          claimId: claim.id,
          supportVerdict: "unverifiable",
          issueCodes: ["verifier_disabled"],
          supportedEvidenceIds: []
        };
      }
      const evaluation = gptEvaluationByClaimId.get(claim.id) ?? {
        claimId: claim.id,
        supportVerdict: "unverifiable" as const,
        issueCodes: ["verifier_result_missing"],
        supportedEvidenceIds: []
      };
      const internalAuditIssueCodes = [
        ...(claim.semanticRiskFlags?.includes("causality")
          ? [WORK_MEETING_CAUSALITY_ROUTING_ISSUE_CODE]
          : []),
        ...(claim.semanticValue
          ? [`${WORK_MEETING_SEMANTIC_VALUE_AUDIT_ISSUE_CODE_PREFIX}${createHash("sha256")
              .update(JSON.stringify(claim.semanticValue))
              .digest("hex")}`]
          : [])
      ];
      return internalAuditIssueCodes.length > 0
        ? {
            ...evaluation,
            issueCodes: [...new Set([
              ...evaluation.issueCodes,
              ...internalAuditIssueCodes
            ])]
          }
        : evaluation;
    });
    if (verifierDrafts.length !== allClaims.length
      || verifierDrafts.some((evaluation, index) => evaluation.claimId !== allClaims[index]?.id)
      || new Set(verifierDrafts.map((evaluation) => evaluation.claimId)).size !== allClaims.length) {
      throw new Error("work_verifier_full_claim_closure_invalid");
    }
    const evaluationByClaimId = new Map(verifierDrafts.map((evaluation) => [
      evaluation.claimId,
      evaluation
    ]));
    const publicationCopies = new Map<string, ReturnType<typeof buildWorkCandidatePublicationProjection>>();
    const evaluatedCandidates = candidates.map((candidate) => {
      const candidateEvaluations = candidate.claims.map((claim) => {
        const evaluation = evaluationByClaimId.get(claim.id);
        if (!evaluation) throw new Error("work_verifier_full_claim_closure_invalid");
        return evaluation;
      });
      const projection = buildWorkCandidatePublicationProjection({
        candidate, publicationId: input.publication.publicationId,
        segments: input.publication.segments, timestampQualityBySegmentId,
        evaluations: candidateEvaluations,
        verifierEnabled: verifierAvailable
      });
      publicationCopies.set(candidate.id, projection);
      const { policy, renderedCopy: displayCopy } = projection;
      const claimInputs = candidate.claims.map((claim) => {
        const verification = evaluationByClaimId.get(claim.id);
        if (!verification) throw new Error("work_verifier_full_claim_closure_invalid");
        const claimPolicy = evaluateWorkClaimPublication({
          claimType: claim.claimType,
          semanticRiskFlags: claim.semanticRiskFlags,
          supportVerdict: verification.supportVerdict,
          issueCodes: verification.issueCodes
        });
        const nonGptPath = verification.issueCodes.includes(WORK_MEETING_NON_GPT_ISSUE_CODE);
        const capacityNotChecked = verification.issueCodes.includes(WORK_MEETING_VERIFIER_CAPACITY_ISSUE_CODE);
        const verifierProfile = capacityNotChecked ? "not_invoked_capacity" : nonGptPath
          ? WORK_MEETING_NON_GPT_PROFILE
          : verifierAvailable
            ? providers.verifier!.profile.profileId
            : "verifier_disabled";
        const verifierPromptVersion = capacityNotChecked ? "not_invoked_capacity" : nonGptPath
          ? WORK_MEETING_NON_GPT_PROFILE
          : verifierAvailable
            ? providers.verifier!.profile.promptVersion
            : "verifier_disabled";
        return {
          id: claim.id,
          claimType: claim.claimType,
          text: claim.text,
          evidenceSegmentIds: claim.evidenceIds,
          evaluation: {
            supportVerdict: verification.supportVerdict,
            issueCodes: claimPolicy.issueCodes,
            riskLevel: claimPolicy.riskLevel,
            publicationAction: claimPolicy.publicationAction,
            confirmationRequired: claimPolicy.confirmationRequired,
            supportedEvidenceIds: verification.supportedEvidenceIds,
            generatorProfile: providers.extractor.profile.profileId,
            verifierProfile,
            verifierPromptVersion,
            policyVersion: WORK_MEETING_PUBLICATION_POLICY_VERSION
          }
        };
      });
      return {
        id: candidate.id,
        kind: candidate.kind,
        title: displayCopy.title,
        body: displayCopy.body,
        structuredData: policy.structuredData,
        publicationAction: policy.publicationAction,
        riskLevel: maxRiskLevel(candidate.claims.map((claim) =>
          riskLevelForWorkClaim(claim)
        )),
        generatorProfile: providers.extractor.profile.profileId,
        generatorPromptVersion: providers.extractor.profile.promptVersion,
        evidenceSegmentIds: candidate.evidenceIds,
        timestampQualityBySegmentId,
        claims: claimInputs
      };
    });
    const deduplicated = applyVerifiedWorkMeetingDuplicates(evaluatedCandidates, organization.duplicates,
      { requests: coverageRequests, evaluations: coverageEvaluations, publicationCopies });
    const duplicateCount = deduplicated.removed.length;
    // A recap's rank transfers to its verified detailed coverage, including
    // coverage that would otherwise have fallen beyond the primary list.
    const proposedPriorityIds = [...new Set(organization.priorityIds.flatMap(id =>
      deduplicated.removed.find(row => row.duplicateId === id)?.coveredByIds ?? [id]))];
    const reviewCapacity = partitionWorkMeetingCandidateReviewCapacity(deduplicated.candidates, 20, proposedPriorityIds);
    const priorityIds = reviewCapacity.priorityIds;
    console.info(`[work-review] stage=meeting_analysis coverage=completed checked=${coverageEvaluations.filter(e => e.reason === "evaluated").length}/${coverageRequests.length} removed=${deduplicated.removed.length} retained=${deduplicated.decisions.filter(d => !d.applied).length} ranking=${reviewCapacity.ranking.strategy} missing_priority=${reviewCapacity.ranking.missingPriorityIds.length}`);
    // Rejected hypotheses remain auditable but do not consume review slots.
    const persistedCandidates = [
      ...reviewCapacity.primaryCandidates,
      ...evaluatedCandidates.filter((candidate) => candidate.publicationAction === "suppress")
    ];
    console.info(
      `[work-review] stage=meeting_analysis review_capacity=completed evaluated_candidates=${evaluatedCandidates.length} duplicate_candidates=${duplicateCount} final_candidates=${reviewCapacity.primaryCandidates.length} suppressed_candidates=${persistedCandidates.length - reviewCapacity.primaryCandidates.length} overflow_candidates=${reviewCapacity.overflowCandidates.length}`
    );
    assertWorkAnalysisDeadline(analysisExecutionState);
    input.repository.publishAnalysisResult({
      accountId: input.request.accountId,
      meetingId: input.request.meetingId,
      fence,
      canonicalContentDigest: input.publication.contentDigest,
      candidates: persistedCandidates,
      analysisAudit: {
        version: WORK_MEETING_ANALYSIS_AUDIT_VERSION, batches, sources: assembledCandidates,
        extraction: batchGroups.flat().map((group, windowIndex) => ({
          windowIndex, segmentCount: group.evidenceIds.length,
          model: providers.extractor.profile.model, promptVersion: providers.extractor.profile.promptVersion,
          schemaVersion: providers.extractor.profile.schemaVersion, validation: group.validation ?? null
        })),
        organized: candidates, evaluated: evaluatedCandidates, organization: organizationCheckpoint,
        sourceToResult: organization.sourceToResult, removed: deduplicated.removed, priorityIds,
        coverageEvaluations, duplicateDecisions: deduplicated.decisions, ranking: reviewCapacity.ranking,
        primaryIds: reviewCapacity.primaryCandidates.map(c => c.id),
        overflowIds: reviewCapacity.overflowCandidates.map(c => c.id),
        fates: organization.sourceToResult.map(mapping => {
          const result = evaluatedCandidates.find(c => c.id === mapping.resultCandidateId)!;
          const removed = deduplicated.removed.find(row => row.duplicateId === result.id);
          const primary = reviewCapacity.primaryCandidates.some(c => c.id === result.id);
          return { ...mapping,
            fate: removed ? "duplicate" : result.publicationAction === "suppress" ? "suppressed" : primary ? "primary" : "overflow",
            reason: removed ? "verified_coverage" : result.publicationAction === "suppress" ? "publication_policy" : primary ? "review_priority" : "review_capacity",
            coveredByIds: removed?.coveredByIds ?? []
          };
        })
      }
    });
    reportProgress(input.dependencies, {
      stage: "meeting_analysis",
      completed: analysisProgressTotal,
      total: analysisProgressTotal,
      state: "completed"
    });
    return { ready: true, busy: false };
  } catch (error) {
    safeMarkFailed({
      repository: input.repository,
      accountId: input.request.accountId,
      meetingId: input.request.meetingId,
      fence,
      code: errorCode(error, "work_review_analysis_failed")
    });
    reportProgress(input.dependencies, {
      stage: "meeting_analysis",
      completed: analysisProgressCompleted,
      total: analysisProgressTotal,
      state: "failed"
    });
    return { ready: false, busy: false };
  }
}

export async function processWorkMeeting(
  request: ProcessWorkMeetingInput,
  dependencies: WorkMeetingProcessorDependencies = {}
): Promise<ProcessWorkMeetingResult> {
  try {
    const repository = dependencies.repository ?? defaultRepository();
    const flags = (dependencies.resolveFeatureFlags ?? resolveWorkReviewFeatureFlags)();
    if (!flags.enabled || !flags.uploadEnabled) {
      return {
        meetingId: request.meetingId,
        transcriptReady: false,
        analysisReady: false,
        busy: false
      };
    }
    const capacityLimits = (
      dependencies.resolveCapacityLimits ?? resolveWorkReviewCapacityLimits
    )();
    const transcription = await transcribeIfNeeded({
      request,
      repository,
      transcriber: dependencies.transcriber ?? transcribeWorkMeetingAudio,
      dependencies,
      maxAudioDurationSeconds: capacityLimits.maxAudioDurationSeconds
    });
    if (!transcription.publication) {
      return {
        meetingId: request.meetingId,
        transcriptReady: false,
        analysisReady: false,
        busy: transcription.busy
      };
    }
    const analysis = await analyzeIfEnabled({
      request,
      repository,
      publication: transcription.publication,
      flags,
      dependencies
    });
    return {
      meetingId: request.meetingId,
      transcriptReady: true,
      analysisReady: analysis.ready,
      busy: analysis.busy
    };
  } catch (error) {
    if (isTombstoned(error)) {
      return {
        meetingId: request.meetingId,
        transcriptReady: false,
        analysisReady: false,
        busy: false
      };
    }
    throw error;
  }
}
