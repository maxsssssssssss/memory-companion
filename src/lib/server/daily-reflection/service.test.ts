import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CreateDailyReflectionInput
} from "@/lib/domain/daily-reflection";
import type { TranscriptSegment } from "@/lib/domain/types";

import { buildDailyReflectionCandidates } from "./candidate-builder";
import { openDailyReflectionDatabase } from "./db";
import {
  DailyReflectionNotFoundError,
  DailyReflectionRepository,
  DailyReflectionVersionConflictError
} from "./repository";
import { DailyReflectionService } from "./service";

const timestamp = "2026-08-13T01:00:00.000Z";

let database: Database.Database;
let repository: DailyReflectionRepository;
let generatedId = 0;

beforeEach(() => {
  database = openDailyReflectionDatabase({ filePath: ":memory:" });
  generatedId = 0;
  repository = new DailyReflectionRepository(database, {
    now: () => timestamp,
    idFactory: () => `service_generated_${++generatedId}`
  });
});

afterEach(() => {
  database.close();
});

function createInput(
  overrides: Partial<CreateDailyReflectionInput> = {}
): CreateDailyReflectionInput {
  return {
    id: "reflection_service",
    accountId: "account_service",
    uploadId: "upload_service",
    inputMethod: "file_upload",
    sourceOrigin: "user_reflection",
    processingProfile: "full_recording",
    ingestionContext: "daily_reflection",
    idempotencyKey: "service_create",
    ...overrides
  };
}

function segment(index: number, text = `Reflection item ${index + 1}`): TranscriptSegment {
  return {
    id: `segment_${index + 1}`,
    uploadId: "upload_service",
    startSeconds: index * 10,
    endSeconds: index * 10 + 8,
    text,
    confidence: 0.95,
    sceneLabels: [],
    valueLabels: []
  };
}

function advanceToTranscribing(
  service: DailyReflectionService,
  reflection = service.create(createInput()).reflection
) {
  const uploading = service.update({
    accountId: reflection.accountId,
    reflectionId: reflection.id,
    expectedVersion: reflection.version,
    status: "uploading"
  });
  return service.update({
    accountId: uploading.accountId,
    reflectionId: uploading.id,
    expectedVersion: uploading.version,
    status: "transcribing"
  });
}

describe("DailyReflectionService", () => {
  it("provides idempotent create and account-scoped reflection views", () => {
    const service = new DailyReflectionService(repository);
    const first = service.create(createInput());
    const repeated = service.createReflection(createInput({ id: "ignored_retry_id" }));

    expect(repeated).toEqual({ ...first, reused: true });
    expect(service.get("account_service", "reflection_service")).toEqual({
      reflection: first.reflection,
      processingPlan: first.processingPlan,
      transcriptReference: {
        accountId: "account_service",
        reflectionId: "reflection_service",
        uploadId: "upload_service"
      },
      candidates: [],
      confirmation: null,
      admissionOperation: null,
      admissionResults: []
    });
    expect(service.getProcessingPlan("account_service", "reflection_service"))
      .toEqual(first.processingPlan);
    expect(service.getTranscriptReference("account_service", "reflection_service"))
      .toMatchObject({ uploadId: "upload_service" });
    expect(service.getCandidates("account_service", "reflection_service")).toEqual([]);

    expect(() => service.get("other_account", "reflection_service"))
      .toThrow(DailyReflectionNotFoundError);
    expect(() => service.getProcessingPlan("other_account", "reflection_service"))
      .toThrow(DailyReflectionNotFoundError);
    expect(() => service.getCandidates("other_account", "reflection_service"))
      .toThrow(DailyReflectionNotFoundError);
  });

  it("preserves optimistic versions for basic updates and upload binding", () => {
    const service = new DailyReflectionService(repository);
    const delayed = service.create(createInput({
      uploadId: null,
      idempotencyKey: "delayed_service"
    })).reflection;
    const bound = service.bindUpload({
      accountId: delayed.accountId,
      reflectionId: delayed.id,
      expectedVersion: delayed.version,
      uploadId: "upload_service"
    });
    expect(bound.reflection.version).toBe(1);
    const uploading = service.updateStatus({
      accountId: bound.reflection.accountId,
      reflectionId: bound.reflection.id,
      expectedVersion: bound.reflection.version,
      status: "uploading"
    });
    expect(uploading.version).toBe(2);
    expect(() => service.update({
      accountId: uploading.accountId,
      reflectionId: uploading.id,
      expectedVersion: 1,
      status: "transcribing"
    })).toThrowError(expect.objectContaining({
      code: "version_conflict",
      currentVersion: 2
    }));
  });

  it("uses the fenced browser profile and limits quick reflections to three candidates", async () => {
    const segments = Array.from({ length: 5 }, (_, index) => segment(index));
    const buildCandidates = vi.fn(buildDailyReflectionCandidates);
    const service = new DailyReflectionService(repository, {
      readTranscriptSegments: async () => segments,
      buildCandidates
    });
    const created = service.create(createInput({
      uploadId: null,
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection",
      idempotencyKey: "browser_quick_service"
    })).reflection;
    const fence = repository.claimExecutionLease({
      accountId: created.accountId,
      reflectionId: created.id,
      leaseOwner: "browser_quick_probe",
      leaseDurationMs: 60_000,
      allowedStatuses: ["created"]
    });
    const bound = service.bindUpload({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: created.version,
      uploadId: "upload_service",
      processingProfile: "quick_reflection",
      leaseOwner: fence!.leaseOwner,
      attemptVersion: fence!.attemptVersion
    }).reflection;
    repository.releaseExecutionLease({
      accountId: created.accountId,
      reflectionId: created.id,
      leaseOwner: fence!.leaseOwner,
      attemptVersion: fence!.attemptVersion
    });
    const transcribing = advanceToTranscribing(service, bound);

    const completed = await service.executeCandidateWorker({
      accountId: transcribing.accountId,
      reflectionId: transcribing.id
    });

    expect(buildCandidates).toHaveBeenCalledWith(expect.objectContaining({
      sourceOrigin: "user_reflection",
      processingProfile: "quick_reflection"
    }));
    expect(completed.outcome).toBe("completed");
    expect(completed.candidates).toHaveLength(3);
    expect(completed.candidates.map((candidate) => candidate.sourceSegmentIds))
      .toEqual(segments.slice(0, 3).map((item) => [item.id]));
  });

  it("keeps all full-recording candidates and makes repeated worker delivery idempotent", async () => {
    const segments = Array.from({ length: 5 }, (_, index) => segment(index));
    const readTranscriptSegments = vi.fn(async () => segments);
    const service = new DailyReflectionService(repository, { readTranscriptSegments });
    advanceToTranscribing(service);

    const completed = await service.executeCandidateWorker({
      accountId: "account_service",
      reflectionId: "reflection_service"
    });
    expect(completed.outcome).toBe("completed");
    expect(completed.reflection).toMatchObject({
      status: "review_pending",
      version: 5
    });
    expect(completed.candidates).toHaveLength(5);
    expect(completed.candidates.map((candidate) => candidate.sourceSegmentIds))
      .toEqual(segments.map((item) => [item.id]));

    const repeated = await service.executeWorker({
      accountId: "account_service",
      reflectionId: "reflection_service"
    });
    expect(repeated.outcome).toBe("reused");
    expect(repeated.candidates).toEqual(completed.candidates);
    expect(readTranscriptSegments).toHaveBeenCalledTimes(1);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_candidates"
    ).get()).toEqual({ count: 5 });
  });

  it("requires a user retry before a failed worker can resume", async () => {
    const service = new DailyReflectionService(repository, {
      readTranscriptSegments: async () => []
    });
    advanceToTranscribing(service);

    const failed = await service.executeCandidateWorker({
      accountId: "account_service",
      reflectionId: "reflection_service"
    });
    expect(failed).toMatchObject({
      outcome: "failed",
      reflection: {
        status: "failed",
        errorCode: "daily_reflection_transcript_segments_missing",
        version: 4
      },
      candidates: []
    });
    const replayedFailure = await service.executeWorker({
      accountId: "account_service",
      reflectionId: "reflection_service"
    });
    expect(replayedFailure).toEqual(failed);
    expect(() => service.requestRetry({
      accountId: "account_service",
      reflectionId: "reflection_service",
      expectedVersion: failed.reflection.version,
      resumeStatus: "review_pending" as never
    })).toThrow();
    expect(service.getReflection("account_service", "reflection_service"))
      .toEqual(failed.reflection);
    expect(() => service.requestRetry({
      accountId: "other_account",
      reflectionId: "reflection_service",
      expectedVersion: failed.reflection.version
    })).toThrow(DailyReflectionNotFoundError);
    expect(() => service.requestRetry({
      accountId: "account_service",
      reflectionId: "reflection_service",
      expectedVersion: failed.reflection.version - 1
    })).toThrow(DailyReflectionVersionConflictError);

    const retried = service.requestRetry({
      accountId: "account_service",
      reflectionId: "reflection_service",
      expectedVersion: failed.reflection.version
    });
    expect(retried).toMatchObject({
      accountId: "account_service",
      reflectionId: "reflection_service",
      failedVersion: 4,
      resumeStatus: "extracting",
      reflection: {
        status: "extracting",
        version: 5,
        errorCode: null,
        errorMessage: null
      },
      processingPlan: {
        reflectionId: "reflection_service",
        uploadId: "upload_service"
      },
      transcriptReference: {
        accountId: "account_service",
        reflectionId: "reflection_service",
        uploadId: "upload_service"
      }
    });
    expect(() => service.requestRetry({
      accountId: "account_service",
      reflectionId: "reflection_service",
      expectedVersion: failed.reflection.version
    })).toThrow(DailyReflectionVersionConflictError);
    expect(() => service.requestRetry({
      accountId: "account_service",
      reflectionId: "reflection_service",
      expectedVersion: retried.reflection.version
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_retry_requires_failed"
    }));

    const recoveredService = new DailyReflectionService(repository, {
      readTranscriptSegments: async () => [segment(0)]
    });
    const recovered = await recoveredService.executeWorker({
      accountId: "account_service",
      reflectionId: "reflection_service"
    });
    expect(recovered).toMatchObject({
      outcome: "completed",
      reflection: {
        status: "review_pending",
        version: 7,
        errorCode: null,
        errorMessage: null
      }
    });
    expect(recovered.candidates).toHaveLength(1);
  });

  it("fails closed when retry has no bound processing reference", () => {
    const service = new DailyReflectionService(repository);
    const created = service.create(createInput({
      id: "reflection_unbound",
      uploadId: null,
      idempotencyKey: "unbound_create"
    })).reflection;
    const failed = service.update({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: created.version,
      status: "failed",
      errorCode: "upload_failed",
      errorMessage: "upload was not bound"
    });
    expect(() => service.requestRetry({
      accountId: failed.accountId,
      reflectionId: failed.id,
      expectedVersion: failed.version,
      resumeStatus: "uploading"
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_retry_requires_upload_binding"
    }));
    expect(service.getReflection(failed.accountId, failed.id)).toEqual(failed);
  });

  it("keeps cancelled and deleted retries fail-closed", () => {
    const service = new DailyReflectionService(repository);

    const live = service.create(createInput({
      id: "reflection_live",
      uploadId: "upload_live",
      idempotencyKey: "live_create"
    })).reflection;
    const cancelled = service.update({
      accountId: live.accountId,
      reflectionId: live.id,
      expectedVersion: live.version,
      status: "cancelled"
    });
    expect(() => service.requestRetry({
      accountId: cancelled.accountId,
      reflectionId: cancelled.id,
      expectedVersion: cancelled.version
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_retry_requires_failed"
    }));
    const deleted = service.update({
      accountId: cancelled.accountId,
      reflectionId: cancelled.id,
      expectedVersion: cancelled.version,
      status: "deleted"
    });
    expect(() => service.requestRetry({
      accountId: deleted.accountId,
      reflectionId: deleted.id,
      expectedVersion: deleted.version
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_retry_requires_failed"
    }));
  });

  it.each(["cancelled", "deleted"] as const)(
    "lets a %s tombstone win a worker race after candidate building",
    async (tombstone) => {
      let service: DailyReflectionService;
      const buildCandidates = vi.fn((input: Parameters<
        typeof buildDailyReflectionCandidates
      >[0]) => {
        const current = service.getReflection("account_service", "reflection_service");
        const cancelled = service.update({
          accountId: current.accountId,
          reflectionId: current.id,
          expectedVersion: current.version,
          status: "cancelled"
        });
        if (tombstone === "deleted") {
          service.update({
            accountId: cancelled.accountId,
            reflectionId: cancelled.id,
            expectedVersion: cancelled.version,
            status: "deleted"
          });
        }
        return buildDailyReflectionCandidates(input);
      });
      service = new DailyReflectionService(repository, {
        readTranscriptSegments: async () => [segment(0)],
        buildCandidates
      });
      advanceToTranscribing(service);

      const result = await service.executeCandidateWorker({
        accountId: "account_service",
        reflectionId: "reflection_service"
      });
      expect(result.outcome).toBe("tombstoned");
      expect(result.reflection.status).toBe(tombstone);
      expect(result.candidates).toEqual([]);
      expect(service.getCandidates("account_service", "reflection_service")).toEqual([]);
      expect(() => service.retry({
        accountId: result.reflection.accountId,
        reflectionId: result.reflection.id,
        expectedVersion: result.reflection.version
      })).toThrowError(expect.objectContaining({
        code: "daily_reflection_retry_requires_failed"
      }));
    }
  );

  it("checks account ownership before a worker can read transcript data", async () => {
    const readTranscriptSegments = vi.fn(async () => [segment(0)]);
    const service = new DailyReflectionService(repository, { readTranscriptSegments });
    advanceToTranscribing(service);

    await expect(service.executeCandidateWorker({
      accountId: "other_account",
      reflectionId: "reflection_service"
    })).rejects.toBeInstanceOf(DailyReflectionNotFoundError);
    expect(readTranscriptSegments).not.toHaveBeenCalled();
  });
});
