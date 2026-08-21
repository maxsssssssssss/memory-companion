import { createHash } from "node:crypto";
import { z } from "zod";

import {
  DailyReflectionIdSchema,
  type Candidate,
  type CandidateAdmissionResult,
  type CreateDailyReflectionInput,
  type CreateDailyReflectionV2Input,
  type DailyReflectionAdmissionOperation,
  type DailyReflection,
  type ReflectionCard,
  type PendingCandidateInput,
  type ProcessingPlan,
  type ReflectionConfirmation
} from "@/lib/domain/daily-reflection";
import {
  TranscriptSegmentSchema,
  type TranscriptSegment
} from "@/lib/domain/types";

import { buildDailyReflectionCandidates } from "./candidate-builder";
import {
  DailyReflectionCandidateProviderFailedError,
  DailyReflectionCandidateProviderUnavailableError,
  DailyReflectionCandidateValidationError,
  structuredDailyReflectionCandidateProvider,
  structuredDailyReflectionCardOrganizerProvider,
  validateDailyReflectionProviderCandidates,
  validateDailyReflectionOrganizedCards,
  dailyReflectionCandidateModelName,
  estimateDailyReflectionOrganizerInputTokens,
  type DailyReflectionCardOrganizerProvider,
  type DailyReflectionHiddenCandidate,
  type DailyReflectionCandidateProvider
} from "./candidate-provider";
import {
  DAILY_REFLECTION_CARD_PIPELINE_PROMPT_VERSION,
  DEFAULT_DAILY_REFLECTION_CARD_PIPELINE_POLICY,
  DailyReflectionCardPipelinePolicySchema,
  buildDailyReflectionTranscriptWindows,
  dailyReflectionCardDisplayPlan,
  estimateDailyReflectionTokens,
  type DailyReflectionCardPipelinePolicy
} from "./card-pipeline-policy";
import {
  DailyReflectionConflictError,
  DailyReflectionLeaseLostError,
  DailyReflectionRepository,
  DailyReflectionVersionConflictError
} from "./repository";
import {
  isDailyReflectionTombstone,
  type DailyReflectionRetryStatus
} from "./state-machine";

export type { DailyReflectionRetryStatus } from "./state-machine";

export type DailyReflectionTranscriptReference = Readonly<{
  accountId: string;
  reflectionId: string;
  uploadId: string;
}>;

export type DailyReflectionTranscriptReader = (
  reference: DailyReflectionTranscriptReference
) => Promise<readonly TranscriptSegment[]> | readonly TranscriptSegment[];

export type DailyReflectionView = {
  reflection: DailyReflection;
  processingPlan: ProcessingPlan | null;
  transcriptReference: DailyReflectionTranscriptReference | null;
  candidates: Candidate[];
  cards: ReflectionCard[];
  confirmation: ReflectionConfirmation | null;
  admissionOperation: DailyReflectionAdmissionOperation | null;
  admissionResults: CandidateAdmissionResult[];
};

export type DailyReflectionRetryResult = Readonly<{
  accountId: string;
  reflectionId: string;
  failedVersion: number;
  resumeStatus: DailyReflectionRetryStatus;
  reflection: DailyReflection;
  processingPlan: ProcessingPlan;
  transcriptReference: DailyReflectionTranscriptReference;
}>;

export type DailyReflectionRetryIntent = DailyReflectionRetryResult;

export type DailyReflectionWorkerResult = {
  outcome: "completed" | "reused" | "failed" | "tombstoned";
  reflection: DailyReflection;
  candidates: Candidate[];
};

export type DailyReflectionServiceOptions = {
  readTranscriptSegments?: DailyReflectionTranscriptReader;
  buildCandidates?: typeof buildDailyReflectionCandidates;
  candidateProvider?: DailyReflectionCandidateProvider;
  cardOrganizerProvider?: DailyReflectionCardOrganizerProvider;
  cardPipelinePolicy?: DailyReflectionCardPipelinePolicy;
  executionFence?: { leaseOwner: string; attemptVersion: number };
};

const WorkerInputSchema = z.object({
  accountId: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema
}).strict();

const RetryInputSchema = WorkerInputSchema.extend({
  expectedVersion: z.number().int().nonnegative(),
  resumeStatus: z.enum(["uploading", "transcribing", "extracting"]).optional()
}).strict();

function transcriptReference(
  accountId: string,
  processingPlan: ProcessingPlan | null
): DailyReflectionTranscriptReference | null {
  if (!processingPlan) return null;
  return {
    accountId,
    reflectionId: processingPlan.reflectionId,
    uploadId: processingPlan.uploadId
  };
}

function defaultRetryStatus(view: DailyReflectionView): DailyReflectionRetryStatus {
  if (!view.processingPlan) return "uploading";
  return view.reflection.errorCode?.startsWith("daily_reflection_transcript_")
    ? "extracting"
    : "transcribing";
}

function workerResult(
  outcome: DailyReflectionWorkerResult["outcome"],
  view: DailyReflectionView
): DailyReflectionWorkerResult {
  return {
    outcome,
    reflection: view.reflection,
    candidates: view.candidates
  };
}

function namespaceCandidateIds(
  accountId: string,
  reflectionId: string,
  candidates: readonly PendingCandidateInput[]
) {
  return candidates.map((candidate): PendingCandidateInput => {
    const digest = createHash("sha256").update(JSON.stringify({
      version: 1,
      accountId,
      reflectionId,
      builderId: candidate.id ?? null,
      ordinal: candidate.ordinal,
      proposedText: candidate.proposedText,
      candidateType: candidate.candidateType,
      sourceSegmentIds: candidate.sourceSegmentIds
    })).digest("hex");
    return {
      ...candidate,
      // Candidate ids are global primary keys in the frozen schema. Namespace
      // the builder's deterministic identity so two accounts may safely use
      // the same upload/segment identifiers without colliding.
      id: `daily_reflection_candidate_${digest}`
    };
  });
}

/**
 * Owns Daily Reflection persistence and candidate-extraction orchestration.
 * Transcript production remains outside this service: the worker receives a
 * canonical transcript reader and never invokes or reimplements ASR.
 */
export class DailyReflectionService {
  private readonly readTranscriptSegments?: DailyReflectionTranscriptReader;
  private readonly buildCandidates: typeof buildDailyReflectionCandidates;
  private readonly candidateProvider: DailyReflectionCandidateProvider;
  private readonly cardOrganizerProvider: DailyReflectionCardOrganizerProvider;
  private readonly cardPipelinePolicy: DailyReflectionCardPipelinePolicy;
  private readonly executionFence?: { leaseOwner: string; attemptVersion: number };

  constructor(
    private readonly repository: DailyReflectionRepository,
    options: DailyReflectionServiceOptions = {}
  ) {
    this.readTranscriptSegments = options.readTranscriptSegments;
    this.buildCandidates = options.buildCandidates ?? buildDailyReflectionCandidates;
    this.candidateProvider = options.candidateProvider
      ?? structuredDailyReflectionCandidateProvider;
    this.cardOrganizerProvider = options.cardOrganizerProvider
      ?? structuredDailyReflectionCardOrganizerProvider;
    this.cardPipelinePolicy = DailyReflectionCardPipelinePolicySchema.parse(
      options.cardPipelinePolicy ?? DEFAULT_DAILY_REFLECTION_CARD_PIPELINE_POLICY
    );
    this.executionFence = options.executionFence
      ? {
        leaseOwner: options.executionFence.leaseOwner,
        attemptVersion: options.executionFence.attemptVersion
      }
      : undefined;
  }

  private fenced() {
    return this.executionFence ?? {};
  }

  create(input: CreateDailyReflectionInput) {
    return this.repository.createReflection(input);
  }

  createReflection(input: CreateDailyReflectionInput) {
    return this.create(input);
  }

  createReflectionV2(input: CreateDailyReflectionV2Input) {
    return this.repository.createReflectionV2(input);
  }

  get(accountId: string, reflectionId: string): DailyReflectionView {
    const detail = this.repository.getReflectionDetail(accountId, reflectionId);
    return {
      ...detail,
      transcriptReference: transcriptReference(accountId, detail.processingPlan)
    };
  }

  getReflection(accountId: string, reflectionId: string) {
    return this.repository.getReflection(accountId, reflectionId);
  }

  getProcessingPlan(accountId: string, reflectionId: string) {
    // Require the account-scoped reflection first so a missing plan cannot be
    // used to distinguish another account's record from a missing record.
    this.repository.getReflection(accountId, reflectionId);
    return this.repository.getProcessingPlan(accountId, reflectionId);
  }

  getTranscriptReference(accountId: string, reflectionId: string) {
    return this.get(accountId, reflectionId).transcriptReference;
  }

  getCandidates(accountId: string, reflectionId: string) {
    return this.repository.listCandidates(accountId, reflectionId);
  }

  bindUpload(input: Parameters<DailyReflectionRepository["bindUploadAndPlan"]>[0]) {
    return this.repository.bindUploadAndPlan(input);
  }

  update(input: Parameters<DailyReflectionRepository["transitionStatus"]>[0]) {
    return this.repository.transitionStatus(input);
  }

  updateStatus(input: Parameters<DailyReflectionRepository["transitionStatus"]>[0]) {
    return this.update(input);
  }

  createPendingCandidates(
    input: Parameters<DailyReflectionRepository["createPendingCandidates"]>[0]
  ) {
    return this.repository.createPendingCandidates(input);
  }

  retry(rawInput: {
    accountId: string;
    reflectionId: string;
    expectedVersion: number;
    resumeStatus?: DailyReflectionRetryStatus;
  }): DailyReflectionRetryResult {
    const input = RetryInputSchema.parse(rawInput);
    const view = this.get(input.accountId, input.reflectionId);
    if (view.reflection.version !== input.expectedVersion) {
      throw new DailyReflectionVersionConflictError(view.reflection.version);
    }
    if (view.reflection.status !== "failed") {
      throw new DailyReflectionConflictError("daily_reflection_retry_requires_failed");
    }
    const resumeStatus = input.resumeStatus ?? defaultRetryStatus(view);
    if (
      view.reflection.uploadId === null
      || !view.processingPlan
      || !view.transcriptReference
    ) {
      throw new DailyReflectionConflictError("daily_reflection_retry_requires_upload_binding");
    }
    if (
      view.processingPlan.uploadId !== view.reflection.uploadId
      || view.transcriptReference.uploadId !== view.reflection.uploadId
    ) {
      throw new DailyReflectionConflictError("daily_reflection_retry_reference_mismatch");
    }
    const retried = this.repository.retryFailed({
      accountId: input.accountId,
      reflectionId: input.reflectionId,
      expectedVersion: input.expectedVersion,
      resumeStatus
    });
    const retriedTranscriptReference = transcriptReference(
      input.accountId,
      retried.processingPlan
    );
    if (!retriedTranscriptReference) {
      throw new DailyReflectionConflictError("daily_reflection_retry_requires_upload_binding");
    }
    return {
      accountId: input.accountId,
      reflectionId: input.reflectionId,
      failedVersion: input.expectedVersion,
      resumeStatus,
      reflection: retried.reflection,
      processingPlan: retried.processingPlan,
      transcriptReference: retriedTranscriptReference
    };
  }

  requestRetry(
    input: Parameters<DailyReflectionService["retry"]>[0]
  ): DailyReflectionRetryResult {
    return this.retry(input);
  }

  private currentWorkerView(accountId: string, reflectionId: string) {
    return this.get(accountId, reflectionId);
  }

  private classifySettledWorkerView(view: DailyReflectionView) {
    if (isDailyReflectionTombstone(view.reflection.status)) {
      return workerResult("tombstoned", view);
    }
    if (
      view.reflection.status === "review_pending"
      || view.reflection.status === "confirmation_ready"
      || view.reflection.status === "admitting"
      || view.reflection.status === "completed"
      || view.reflection.status === "admission_failed"
    ) {
      return workerResult("reused", view);
    }
    if (view.reflection.status === "failed") {
      return workerResult("failed", view);
    }
    return null;
  }

  private settleWorkerRace(accountId: string, reflectionId: string, error: unknown) {
    const view = this.currentWorkerView(accountId, reflectionId);
    const settled = this.classifySettledWorkerView(view);
    if (settled) return settled;
    throw error;
  }

  private failWorker(
    accountId: string,
    reflectionId: string,
    errorCode: string,
    errorMessage: string
  ): DailyReflectionWorkerResult {
    const beforeFailure = this.currentWorkerView(accountId, reflectionId);
    const settled = this.classifySettledWorkerView(beforeFailure);
    if (settled) return settled;
    if (beforeFailure.reflection.status !== "extracting") {
      throw new DailyReflectionConflictError(
        "daily_reflection_not_ready_for_candidate_extraction"
      );
    }
    try {
      const reflection = this.repository.transitionStatus({
        accountId,
        reflectionId,
        expectedVersion: beforeFailure.reflection.version,
        status: "failed",
        errorCode,
        errorMessage: errorMessage.slice(0, 4_000),
        ...this.fenced()
      });
      return {
        outcome: "failed",
        reflection,
        candidates: this.repository.listCandidates(accountId, reflectionId)
      };
    } catch (error) {
      return this.settleWorkerRace(accountId, reflectionId, error);
    }
  }

  private completeExistingCandidates(view: DailyReflectionView) {
    if (view.candidates.length === 0) return null;
    if (view.reflection.status === "review_pending") {
      return workerResult("reused", view);
    }
    if (view.reflection.status !== "extracting") return null;
    try {
      this.repository.transitionStatus({
        accountId: view.reflection.accountId,
        reflectionId: view.reflection.id,
        expectedVersion: view.reflection.version,
        status: "review_pending",
        ...this.fenced()
      });
      return workerResult(
        "reused",
        this.currentWorkerView(view.reflection.accountId, view.reflection.id)
      );
    } catch (error) {
      return this.settleWorkerRace(
        view.reflection.accountId,
        view.reflection.id,
        error
      );
    }
  }

  async executeCandidateWorker(rawInput: {
    accountId: string;
    reflectionId: string;
    signal?: AbortSignal;
  }): Promise<DailyReflectionWorkerResult> {
    const input = WorkerInputSchema.parse({
      accountId: rawInput.accountId,
      reflectionId: rawInput.reflectionId
    });
    let view = this.currentWorkerView(input.accountId, input.reflectionId);

    // First tombstone check: a queued worker must become a no-op after cancel
    // or delete, even if the queue delivery itself cannot be recalled.
    const alreadySettled = this.classifySettledWorkerView(view);
    if (alreadySettled) return alreadySettled;
    const existingResult = this.completeExistingCandidates(view);
    if (existingResult) return existingResult;

    if (view.reflection.status === "transcribing") {
      try {
        this.repository.transitionStatus({
          accountId: input.accountId,
          reflectionId: input.reflectionId,
          expectedVersion: view.reflection.version,
          status: "extracting",
          ...this.fenced()
        });
      } catch (error) {
        return this.settleWorkerRace(input.accountId, input.reflectionId, error);
      }
      view = this.currentWorkerView(input.accountId, input.reflectionId);
    }
    if (view.reflection.status !== "extracting") {
      throw new DailyReflectionConflictError(
        "daily_reflection_not_ready_for_candidate_extraction"
      );
    }
    const processingPlan = view.processingPlan;
    const canonicalTranscriptReference = view.transcriptReference;
    if (!processingPlan || !canonicalTranscriptReference) {
      return this.failWorker(
        input.accountId,
        input.reflectionId,
        "daily_reflection_transcript_reference_missing",
        "Daily Reflection has no bound canonical transcript reference"
      );
    }
    if (!this.readTranscriptSegments) {
      throw new DailyReflectionConflictError(
        "daily_reflection_transcript_reader_unavailable"
      );
    }

    let segments: TranscriptSegment[];
    try {
      segments = z.array(TranscriptSegmentSchema).parse(
        await this.readTranscriptSegments(canonicalTranscriptReference)
      );
    } catch (error) {
      return this.failWorker(
        input.accountId,
        input.reflectionId,
        "daily_reflection_transcript_read_failed",
        error instanceof Error ? error.message : "Canonical transcript read failed"
      );
    }

    // Second tombstone check closes the read/build race: cancellation that
    // lands while an external transcript read is in flight wins.
    view = this.currentWorkerView(input.accountId, input.reflectionId);
    const cancelledDuringRead = this.classifySettledWorkerView(view);
    if (cancelledDuringRead) return cancelledDuringRead;
    if (view.reflection.status !== "extracting") {
      throw new DailyReflectionConflictError(
        "daily_reflection_not_ready_for_candidate_extraction"
      );
    }
    if (segments.length === 0) {
      return this.failWorker(
        input.accountId,
        input.reflectionId,
        "daily_reflection_transcript_segments_missing",
        "Canonical transcript contains no segments"
      );
    }
    if (segments.some((segment) => segment.uploadId !== processingPlan.uploadId)) {
      return this.failWorker(
        input.accountId,
        input.reflectionId,
        "daily_reflection_transcript_reference_mismatch",
        "Canonical transcript segment upload does not match the processing plan"
      );
    }

    const v2Input = this.repository.getReflectionV2Input(
      input.accountId,
      input.reflectionId
    );
    let persistCandidates: (expectedVersion: number) => void;
    if (v2Input) {
      if (processingPlan.planVersion !== 2) {
        return this.failWorker(
          input.accountId,
          input.reflectionId,
          "daily_reflection_processing_plan_v2_required",
          "Daily Reflection V2 requires a server-authoritative ProcessingPlan V2"
        );
      }
      try {
        const windows = buildDailyReflectionTranscriptWindows({
          segments,
          policy: this.cardPipelinePolicy
        });
        const extracted: DailyReflectionHiddenCandidate[] = [];
        let inputTokenEstimate = 0;
        for (const window of windows) {
          inputTokenEstimate += window.estimatedInputTokens;
          const response = await this.candidateProvider.generate({
            accountId: input.accountId,
            reflectionId: input.reflectionId,
            input: v2Input,
            processingPlan,
            segments: window.segments,
            windowIndex: window.index,
            windowCount: windows.length,
            maxOutputTokens: this.cardPipelinePolicy.extractionOutputTokenBudget,
            ...(rawInput.signal ? { signal: rawInput.signal } : {})
          });
          if (rawInput.signal?.aborted) throw new DailyReflectionLeaseLostError();
          extracted.push(...validateDailyReflectionProviderCandidates({
            accountId: input.accountId,
            reflectionId: input.reflectionId,
            segments: window.segments,
            candidateLimit: this.cardPipelinePolicy.maxHiddenPerWindow,
            response
          }));
        }
        const seen = new Set<string>();
        const pendingCandidates = extracted
          .sort((left, right) =>
            right.confidence - left.confidence
            || left.ordinal - right.ordinal
            || left.id!.localeCompare(right.id!)
          )
          .filter((candidate) => {
            const key = `${candidate.candidateKind}\u0000${candidate.proposedText
              .trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN")}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, this.cardPipelinePolicy.maxHiddenTotal)
          .map((candidate, ordinal) => ({ ...candidate, ordinal }));
        if (pendingCandidates.length === 0) {
          throw new DailyReflectionCandidateValidationError("candidates_missing");
        }
        const organizerCandidates: DailyReflectionHiddenCandidate[] = [];
        for (const candidate of pendingCandidates) {
          const trial = [...organizerCandidates, candidate];
          const estimate = estimateDailyReflectionOrganizerInputTokens({
            candidates: trial,
            evidenceSnippets: {}
          });
          if (estimate > this.cardPipelinePolicy.organizerInputTokenBudget) {
            if (organizerCandidates.length === 0) {
              throw new DailyReflectionCandidateValidationError(
                "organizer_input_budget_exceeded"
              );
            }
            break;
          }
          organizerCandidates.push(candidate);
        }
        const segmentById = new Map(segments.map((segment) => [segment.id, segment] as const));
        const evidenceSnippets: Record<string, string> = {};
        for (const evidenceId of [
          ...new Set(organizerCandidates.flatMap((candidate) => candidate.evidenceIds))
        ]) {
          const text = segmentById.get(evidenceId)!.text;
          // Never cut Canonical text. A short whole segment is added only when
          // the complete Organizer payload remains within its configured cap.
          if (estimateDailyReflectionTokens(text) > 80) continue;
          const trial = { ...evidenceSnippets, [evidenceId]: text };
          if (estimateDailyReflectionOrganizerInputTokens({
            candidates: organizerCandidates,
            evidenceSnippets: trial
          }) > this.cardPipelinePolicy.organizerInputTokenBudget) continue;
          evidenceSnippets[evidenceId] = text;
        }
        const organizerTokenEstimate = estimateDailyReflectionOrganizerInputTokens({
          candidates: organizerCandidates,
          evidenceSnippets
        });
        inputTokenEstimate += organizerTokenEstimate;
        const organizerResponse = await this.cardOrganizerProvider.organize({
          accountId: input.accountId,
          reflectionId: input.reflectionId,
          input: v2Input,
          processingPlan,
          candidates: organizerCandidates,
          evidenceSnippets,
          displayPlan: dailyReflectionCardDisplayPlan(
            processingPlan.effectiveDurationMs,
            this.cardPipelinePolicy
          ),
          maxOutputTokens: this.cardPipelinePolicy.organizerOutputTokenBudget,
          ...(rawInput.signal ? { signal: rawInput.signal } : {})
        });
        if (rawInput.signal?.aborted) throw new DailyReflectionLeaseLostError();
        const cards = validateDailyReflectionOrganizedCards({
          accountId: input.accountId,
          reflectionId: input.reflectionId,
          effectiveDurationMs: processingPlan.effectiveDurationMs,
          policy: this.cardPipelinePolicy,
          candidates: organizerCandidates,
          response: organizerResponse
        });
        persistCandidates = (expectedVersion) => {
          this.repository.saveCardPipelineV2({
            accountId: input.accountId,
            reflectionId: input.reflectionId,
            expectedVersion,
            candidates: pendingCandidates.map(({ topicHint: _topicHint, ...candidate }) => candidate),
            cards,
            audit: {
              modelName: dailyReflectionCandidateModelName(),
              promptVersion: DAILY_REFLECTION_CARD_PIPELINE_PROMPT_VERSION,
              policy: { ...this.cardPipelinePolicy },
              windowCount: windows.length,
              providerCallCount: windows.length + 1,
              hiddenCandidateCount: pendingCandidates.length,
              clusterCount: new Set(cards.map((card) => card.clusterId)).size,
              cardCount: cards.length,
              inputTokenEstimate,
              outputTokenBudget:
                windows.length * this.cardPipelinePolicy.extractionOutputTokenBudget
                + this.cardPipelinePolicy.organizerOutputTokenBudget
            },
            ...this.fenced()
          });
        };
      } catch (error) {
        if (error instanceof DailyReflectionLeaseLostError || rawInput.signal?.aborted) {
          throw new DailyReflectionLeaseLostError();
        }
        const errorCode = error instanceof DailyReflectionCandidateProviderUnavailableError
          ? error.code
          : error instanceof DailyReflectionCandidateProviderFailedError
            ? error.code
            : error instanceof DailyReflectionCandidateValidationError
              ? error.code
              : "daily_reflection_candidate_provider_failed";
        return this.failWorker(
          input.accountId,
          input.reflectionId,
          errorCode,
          errorCode
        );
      }
    } else {
      let pendingCandidates: PendingCandidateInput[];
      try {
        pendingCandidates = namespaceCandidateIds(
          input.accountId,
          input.reflectionId,
          this.buildCandidates({
            segments,
            sourceOrigin: processingPlan.sourceOrigin,
            processingProfile: processingPlan.processingProfile
          })
        );
      } catch (error) {
        return this.failWorker(
          input.accountId,
          input.reflectionId,
          "daily_reflection_candidate_build_failed",
          error instanceof Error ? error.message : "Candidate building failed"
        );
      }
      if (pendingCandidates.length === 0) {
        return this.failWorker(
          input.accountId,
          input.reflectionId,
          "daily_reflection_candidates_missing",
          "Canonical transcript produced no review candidates"
        );
      }
      persistCandidates = (expectedVersion) => {
        this.repository.createPendingCandidates({
          accountId: input.accountId,
          reflectionId: input.reflectionId,
          expectedVersion,
          candidates: pendingCandidates,
          ...this.fenced()
        });
      };
    }

    // A cancellation may race with the synchronous pure builder as well.
    view = this.currentWorkerView(input.accountId, input.reflectionId);
    const cancelledDuringBuild = this.classifySettledWorkerView(view);
    if (cancelledDuringBuild) return cancelledDuringBuild;
    if (view.reflection.status !== "extracting") {
      throw new DailyReflectionConflictError(
        "daily_reflection_not_ready_for_candidate_extraction"
      );
    }

    try {
      persistCandidates(view.reflection.version);
    } catch (error) {
      return this.settleWorkerRace(input.accountId, input.reflectionId, error);
    }

    // Final tombstone checks bracket the persistence and final state update.
    view = this.currentWorkerView(input.accountId, input.reflectionId);
    const cancelledAfterSave = this.classifySettledWorkerView(view);
    if (cancelledAfterSave) return cancelledAfterSave;
    if (view.reflection.status !== "extracting") {
      throw new DailyReflectionConflictError(
        "daily_reflection_not_ready_for_candidate_extraction"
      );
    }
    try {
      this.repository.transitionStatus({
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        expectedVersion: view.reflection.version,
        status: "review_pending",
        ...this.fenced()
      });
    } catch (error) {
      return this.settleWorkerRace(input.accountId, input.reflectionId, error);
    }

    const completed = this.currentWorkerView(input.accountId, input.reflectionId);
    if (isDailyReflectionTombstone(completed.reflection.status)) {
      return workerResult("tombstoned", completed);
    }
    return workerResult("completed", completed);
  }

  executeWorker(input: Parameters<DailyReflectionService["executeCandidateWorker"]>[0]) {
    return this.executeCandidateWorker(input);
  }
}

export function createDailyReflectionService(
  repository: DailyReflectionRepository,
  options: DailyReflectionServiceOptions = {}
) {
  return new DailyReflectionService(repository, options);
}
