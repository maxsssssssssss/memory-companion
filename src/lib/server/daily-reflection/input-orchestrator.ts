import { z } from "zod";

import {
  DailyReflectionIdSchema,
  DailyReflectionV2CapturePurposeSchema,
  DailyReflectionV2InputAdapterSchema,
  DailyReflectionV2SourceOriginSchema,
  InputMethodSchema,
  type DailyReflectionV2InputAdapter,
  type InputMethod
} from "@/lib/domain/daily-reflection";
import {
  DAILY_REFLECTION_FULL_CANDIDATE_DEFAULT,
  DAILY_REFLECTION_QUICK_CANDIDATE_LIMIT,
  type DailyReflectionDurationResolution
} from "@/lib/domain/daily-reflection-duration";
import type { JsonStore } from "@/lib/server/storage/json-store";

import {
  createDailyReflectionJob,
  type DailyReflectionJob
} from "./job-store";
import {
  type DailyReflectionExecutionFence,
  type DailyReflectionInputReceiptV2,
  type DailyReflectionRepository
} from "./repository";

const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const RecordingDateSchema = z.string().date();
const OperationKeySchema = z.string().trim().min(1).max(512);

export type DailyReflectionInputContractErrorCode =
  | "invalid_input_method"
  | "invalid_input_adapter"
  | "invalid_source_origin"
  | "invalid_capture_purpose"
  | "invalid_operation_key"
  | "invalid_recording_date";

export class DailyReflectionInputContractError extends Error {
  readonly name = "DailyReflectionInputContractError";

  constructor(readonly code: DailyReflectionInputContractErrorCode) {
    super(code);
  }
}

export type DailyReflectionResolvedInputContract = {
  inputMethod: InputMethod;
  inputAdapter: DailyReflectionV2InputAdapter;
  sourceOrigin: "user_reflection" | "direct_conversation";
  capturePurpose: "inspiration_capture";
  operationKey: string;
  recordingDate: string;
};

function expectedInputMethod(inputAdapter: DailyReflectionV2InputAdapter): InputMethod {
  return inputAdapter === "browser_recorder" ? "browser_recording" : "file_upload";
}

export function resolveDailyReflectionInputContract(input: {
  inputMethod: unknown;
  inputAdapter?: unknown;
  sourceOrigin: unknown;
  capturePurpose?: unknown;
  operationKey: unknown;
  recordingDate: unknown;
}): DailyReflectionResolvedInputContract {
  const inputMethod = InputMethodSchema.safeParse(input.inputMethod);
  if (!inputMethod.success) {
    throw new DailyReflectionInputContractError("invalid_input_method");
  }
  const adapterValue = input.inputAdapter === undefined || input.inputAdapter === ""
    ? (inputMethod.data === "browser_recording" ? "browser_recorder" : "file_picker")
    : input.inputAdapter;
  const inputAdapter = DailyReflectionV2InputAdapterSchema.safeParse(adapterValue);
  if (
    !inputAdapter.success
    || expectedInputMethod(inputAdapter.data) !== inputMethod.data
  ) {
    throw new DailyReflectionInputContractError("invalid_input_adapter");
  }
  // Source provenance is deliberately parsed independently from adapter. No
  // browser/Toy transport is allowed to overwrite the caller's explicit fact.
  const sourceOrigin = DailyReflectionV2SourceOriginSchema.safeParse(input.sourceOrigin);
  if (!sourceOrigin.success) {
    throw new DailyReflectionInputContractError("invalid_source_origin");
  }
  const capturePurpose = DailyReflectionV2CapturePurposeSchema.safeParse(
    input.capturePurpose === undefined || input.capturePurpose === ""
      ? "inspiration_capture"
      : input.capturePurpose
  );
  if (!capturePurpose.success) {
    throw new DailyReflectionInputContractError("invalid_capture_purpose");
  }
  const operationKey = OperationKeySchema.safeParse(input.operationKey);
  if (!operationKey.success) {
    throw new DailyReflectionInputContractError("invalid_operation_key");
  }
  const recordingDate = RecordingDateSchema.safeParse(input.recordingDate);
  if (!recordingDate.success) {
    throw new DailyReflectionInputContractError("invalid_recording_date");
  }
  return {
    inputMethod: inputMethod.data,
    inputAdapter: inputAdapter.data,
    sourceOrigin: sourceOrigin.data,
    capturePurpose: capturePurpose.data,
    operationKey: operationKey.data,
    recordingDate: recordingDate.data
  };
}

export class DailyReflectionInputOrchestrator {
  constructor(private readonly repository: DailyReflectionRepository) {}

  reserve(input: DailyReflectionResolvedInputContract & {
    accountId: string;
    contentHash: string;
  }) {
    const accountId = DailyReflectionIdSchema.parse(input.accountId);
    const contentHash = ContentHashSchema.parse(input.contentHash);
    const reserved = this.repository.createReflectionV2({
      accountId,
      uploadId: null,
      operationKey: input.operationKey,
      inputAdapter: input.inputAdapter,
      sourceOrigin: input.sourceOrigin,
      capturePurpose: input.capturePurpose,
      recordingDate: input.recordingDate,
      contentHash
    });
    if (!reserved.receipt) {
      throw new Error("daily_reflection_v2_receipt_missing");
    }
    return {
      ...reserved,
      receipt: reserved.receipt
    };
  }

  claimStaging(input: {
    receipt: DailyReflectionInputReceiptV2;
    leaseOwner: string;
    leaseDurationMs: number;
  }): DailyReflectionExecutionFence | null {
    return this.repository.claimExecutionLease({
      accountId: input.receipt.accountId,
      reflectionId: input.receipt.reflectionId,
      leaseOwner: input.leaseOwner,
      leaseDurationMs: input.leaseDurationMs,
      uploadFingerprint: input.receipt.contentHash,
      provisionalUploadId: input.receipt.uploadId,
      allowedStatuses: ["uploading"]
    });
  }

  bindAuthoritativePlan(input: {
    receipt: DailyReflectionInputReceiptV2;
    expectedVersion: number;
    duration: DailyReflectionDurationResolution;
    fence: DailyReflectionExecutionFence;
  }) {
    const candidateLimit = input.duration.processingProfile === "quick_reflection"
      ? DAILY_REFLECTION_QUICK_CANDIDATE_LIMIT
      : DAILY_REFLECTION_FULL_CANDIDATE_DEFAULT;
    return this.repository.bindUploadAndPlanV2({
      accountId: input.receipt.accountId,
      reflectionId: input.receipt.reflectionId,
      expectedVersion: input.expectedVersion,
      uploadId: input.receipt.uploadId,
      inputAdapter: input.duration.inputAdapter,
      processingProfile: input.duration.processingProfile,
      effectiveDurationMs: input.duration.effectiveDurationMs,
      durationSource: input.duration.durationSource,
      candidateLimit,
      leaseOwner: input.fence.leaseOwner,
      attemptVersion: input.fence.attemptVersion
    });
  }

  async ensureDurableJob(input: {
    store: JsonStore;
    receipt: DailyReflectionInputReceiptV2;
    executionMode: "inline" | "queue";
    queueJobId?: string;
    queuedAt?: string;
  }): Promise<DailyReflectionJob> {
    const job = await createDailyReflectionJob({
      store: input.store,
      accountId: input.receipt.accountId,
      reflectionId: input.receipt.reflectionId,
      uploadId: input.receipt.uploadId,
      executionMode: input.executionMode,
      ...(input.queueJobId ? { queueJobId: input.queueJobId } : {}),
      ...(input.queuedAt ? { queuedAt: input.queuedAt } : {})
    });
    if (job.id !== input.receipt.jobId) {
      throw new Error("daily_reflection_v2_job_receipt_conflict");
    }
    return job;
  }
}
