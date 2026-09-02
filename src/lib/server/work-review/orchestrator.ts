import { randomUUID } from "node:crypto";

import {
  WorkMeetingCandidateStructuredDataSchema,
  type WorkClaimRiskLevel,
  type WorkEvidenceTimestampQuality,
  type WorkMeetingCandidateStructuredData,
  type WorkVerifierClaimDraft
} from "@/lib/domain/work-review";
import type { JsonStore } from "@/lib/server/storage/json-store";
import { probeAudioDurationSeconds } from "@/lib/server/transcription/chunks/audio-planner";

import {
  createConfiguredWorkMeetingExtractor,
  createConfiguredWorkMeetingVerifier,
  materializeWorkEvidence,
  validateWorkVerifierOutput,
  type WorkMeetingExtractor,
  type WorkMeetingVerifier
} from "./analysis-provider";
import {
  assembleWorkMeetingCandidates,
  buildWorkMeetingVerifierInput,
  deriveCandidateCopyFromAtomicClaims,
  partitionWorkCandidatesForVerification
} from "./candidate-normalization";
import { cleanupWorkReviewUploadArtifacts } from "./cleanup";
import { getWorkReviewDatabase } from "./db";
import {
  evaluateWorkCandidatePublication,
  evaluateWorkClaimPublication,
  riskLevelForWorkClaimType
} from "./publication-policy";
import {
  WorkReviewConflictError,
  WorkReviewLeaseLostError,
  WorkReviewRepository,
  type WorkProcessingFence
} from "./repository";
import {
  resolveWorkReviewFeatureFlags,
  resolveWorkReviewCapacityLimits,
  WORK_MEETING_PIPELINE_VERSION,
  WORK_MEETING_PUBLICATION_POLICY_VERSION,
  type WorkReviewCapacityLimits,
  type WorkReviewFeatureFlags
} from "./runtime-config";
import {
  transcribeWorkMeetingAudio,
  type WorkMeetingTranscriber
} from "./transcription-policy";
import { buildWorkMeetingTranscriptWindows } from "./windowing";

const TRANSCRIPTION_LEASE_MS = 15 * 60_000;
const ANALYSIS_LEASE_MS = 15 * 60_000;

type AnalysisProviders = {
  extractor: WorkMeetingExtractor;
  verifier?: WorkMeetingVerifier;
};

export type WorkMeetingProcessorDependencies = {
  repository?: WorkReviewRepository;
  transcriber?: WorkMeetingTranscriber;
  probeDurationSeconds?: (filePath: string) => Promise<number>;
  resolveCapacityLimits?: () => WorkReviewCapacityLimits;
  resolveFeatureFlags?: () => WorkReviewFeatureFlags;
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
  return {
    extractor: createConfiguredWorkMeetingExtractor(),
    ...(input.verifierEnabled ? { verifier: createConfiguredWorkMeetingVerifier() } : {})
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

function materializeStructuredData(input: {
  publicationId: string;
  segments: Parameters<typeof materializeWorkEvidence>[0]["segments"];
  evidenceIds: string[];
  structuredData: Parameters<typeof assembleWorkMeetingCandidates>[0]["batches"][number]["candidates"][number]["structuredData"];
  timestampQualityBySegmentId: Record<string, WorkEvidenceTimestampQuality>;
}): WorkMeetingCandidateStructuredData {
  const candidateEvidence = materializeWorkEvidence({
    publicationId: input.publicationId,
    segments: input.segments,
    evidenceIds: input.evidenceIds,
    timestampQualityBySegmentId: input.timestampQualityBySegmentId
  });
  const candidateSpeakers = new Set(candidateEvidence.flatMap((evidence) =>
    evidence.rawSpeakerLabel ? [evidence.rawSpeakerLabel] : []
  ));
  return WorkMeetingCandidateStructuredDataSchema.parse({
    ...input.structuredData,
    rawActorLabel: candidateSpeakers.size === 1 ? [...candidateSpeakers][0] : null,
    planStages: input.structuredData.planStages.map((stage) => {
      const evidence = materializeWorkEvidence({
        publicationId: input.publicationId,
        segments: input.segments,
        evidenceIds: stage.evidenceIds,
        timestampQualityBySegmentId: input.timestampQualityBySegmentId
      });
      const speakers = new Set(evidence.flatMap((item) =>
        item.rawSpeakerLabel ? [item.rawSpeakerLabel] : []
      ));
      return {
        id: stage.clientStageKey,
        content: evidence.map((item) => item.text).join("；").slice(0, 20_000),
        status: "unclear",
        rawSpeakerLabel: speakers.size === 1 ? [...speakers][0] : null,
        evidenceRefs: evidence.map(({ text: _text, ...reference }) => reference)
      };
    })
  });
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
  try {
    providers = (input.dependencies.createAnalysisProviders ?? defaultAnalysisProviders)({
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
  const fence = input.repository.claimProcessingAttempt({
    accountId: input.request.accountId,
    meetingId: input.request.meetingId,
    stage: "meeting_analysis",
    leaseOwner: (input.dependencies.leaseOwnerFactory ?? defaultLeaseOwnerFactory)("meeting_analysis"),
    leaseDurationMs: ANALYSIS_LEASE_MS,
    pipelineVersion: WORK_MEETING_PIPELINE_VERSION,
    providerProfile: providers.extractor.profile.profileId,
    promptVersion: providers.extractor.profile.promptVersion
  });
  if (!fence) return { ready: false, busy: true };

  const windows = buildWorkMeetingTranscriptWindows(input.publication.segments);
  reportProgress(input.dependencies, {
    stage: "meeting_analysis", completed: 0, total: windows.length, state: "started"
  });
  let analysisProgressTotal = windows.length;
  try {
    const batches = [];
    for (const window of windows) {
      input.repository.renewProcessingLease({
        accountId: input.request.accountId,
        meetingId: input.request.meetingId,
        fence,
        leaseDurationMs: ANALYSIS_LEASE_MS
      });
      const candidates = await providers.extractor.extract({
        accountId: input.request.accountId,
        meetingId: input.request.meetingId,
        publicationId: input.publication.publicationId,
        canonicalDigest: input.publication.contentDigest,
        window
      });
      input.repository.renewProcessingLease({
        accountId: input.request.accountId,
        meetingId: input.request.meetingId,
        fence,
        leaseDurationMs: ANALYSIS_LEASE_MS
      });
      batches.push({ windowIndex: window.index, candidates });
      reportProgress(input.dependencies, {
        stage: "meeting_analysis",
        completed: window.index + 1,
        total: windows.length,
        state: "processing"
      });
    }
    const candidates = assembleWorkMeetingCandidates({
      accountId: input.request.accountId,
      meetingId: input.request.meetingId,
      publicationId: input.publication.publicationId,
      canonicalDigest: input.publication.contentDigest,
      segments: input.publication.segments,
      batches
    });
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
    let verifierDrafts: WorkVerifierClaimDraft[];
    if (input.flags.verifierEnabled && providers.verifier) {
      verifierDrafts = [];
      const verifierBatches = partitionWorkCandidatesForVerification(candidates);
      analysisProgressTotal += verifierBatches.length;
      for (const [index, verifierCandidates] of verifierBatches.entries()) {
        input.repository.renewProcessingLease({
          accountId: input.request.accountId,
          meetingId: input.request.meetingId,
          fence,
          leaseDurationMs: ANALYSIS_LEASE_MS
        });
        verifierDrafts.push(...await providers.verifier.verify(buildWorkMeetingVerifierInput({
          accountId: input.request.accountId,
          meetingId: input.request.meetingId,
          publicationId: input.publication.publicationId,
          canonicalDigest: input.publication.contentDigest,
          segments: input.publication.segments,
          candidates: verifierCandidates,
          timestampQualityBySegmentId
        })));
        reportProgress(input.dependencies, {
          stage: "meeting_analysis",
          completed: windows.length + index + 1,
          total: windows.length + verifierBatches.length,
          state: "processing"
        });
      }
      verifierDrafts = validateWorkVerifierOutput({
        response: { items: verifierDrafts },
        claims: candidates.flatMap((candidate) => candidate.claims),
        allowedSegments: input.publication.segments
      }).items;
    } else {
      verifierDrafts = candidates.flatMap((candidate) => candidate.claims.map((claim) => ({
        claimId: claim.id,
        supportVerdict: "unverifiable" as const,
        issueCodes: ["verifier_disabled"],
        supportedEvidenceIds: []
      })));
    }
    const evaluationByClaimId = new Map(verifierDrafts.map((evaluation) => [
      evaluation.claimId,
      evaluation
    ]));
    const persistedCandidates = candidates.map((candidate) => {
      const structuredData = materializeStructuredData({
        publicationId: input.publication.publicationId,
        segments: input.publication.segments,
        evidenceIds: candidate.evidenceIds,
        structuredData: candidate.structuredData,
        timestampQualityBySegmentId
      });
      const candidateEvaluations = candidate.claims.map((claim) => {
        const evaluation = evaluationByClaimId.get(claim.id) ?? {
          claimId: claim.id,
          supportVerdict: "unverifiable" as const,
          issueCodes: ["verifier_result_missing"],
          supportedEvidenceIds: []
        };
        return evaluation;
      });
      const policy = evaluateWorkCandidatePublication({
        kind: candidate.kind,
        structuredData,
        claims: candidate.claims,
        evaluations: candidateEvaluations,
        verifierEnabled: input.flags.verifierEnabled
      });
      const claimInputs = candidate.claims.map((claim) => {
        const verification = evaluationByClaimId.get(claim.id) ?? {
          claimId: claim.id,
          supportVerdict: "unverifiable" as const,
          issueCodes: ["verifier_result_missing"],
          supportedEvidenceIds: []
        };
        const claimPolicy = evaluateWorkClaimPublication({
          claimType: claim.claimType,
          supportVerdict: verification.supportVerdict,
          issueCodes: verification.issueCodes
        });
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
            verifierProfile: providers.verifier?.profile.profileId ?? "verifier_disabled",
            verifierPromptVersion: providers.verifier?.profile.promptVersion ?? "verifier_disabled",
            policyVersion: WORK_MEETING_PUBLICATION_POLICY_VERSION
          }
        };
      });
      const displayCopy = deriveCandidateCopyFromAtomicClaims(candidate.claims);
      return {
        id: candidate.id,
        kind: candidate.kind,
        title: displayCopy.title,
        body: displayCopy.body,
        structuredData: policy.structuredData,
        publicationAction: policy.publicationAction,
        riskLevel: maxRiskLevel(candidate.claims.map((claim) =>
          riskLevelForWorkClaimType(claim.claimType)
        )),
        generatorProfile: providers.extractor.profile.profileId,
        generatorPromptVersion: providers.extractor.profile.promptVersion,
        evidenceSegmentIds: candidate.evidenceIds,
        timestampQualityBySegmentId,
        claims: claimInputs
      };
    });
    input.repository.publishAnalysisResult({
      accountId: input.request.accountId,
      meetingId: input.request.meetingId,
      fence,
      canonicalContentDigest: input.publication.contentDigest,
      candidates: persistedCandidates
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
      completed: 0,
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
