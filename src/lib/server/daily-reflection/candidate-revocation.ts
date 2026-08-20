import { createHash, randomUUID } from "node:crypto";

import { getMemoryDatabase } from "@/lib/server/memory/db";
import {
  createDailyReflectionMemoryCandidateRevocationRepository,
  dailyReflectionCandidateRevocationPayloadDigest,
  type DailyReflectionMemoryCandidateRevocationResult
} from "@/lib/server/memory/daily-reflection-candidate-revocation";
import { resolvePipelineExecutionMode } from "@/lib/server/queue/config";
import { enqueueEmbeddingIndexJob } from "@/lib/server/queue/producer";
import { resolveQaHybridRetrievalMode } from "@/lib/server/retrieval/hybrid/runtime-config";

import { getDailyReflectionDatabase } from "./db";
import {
  createDailyReflectionRepository,
  DailyReflectionConflictError,
  type DailyReflectionCandidateRevocationOperation,
  type DailyReflectionCandidateRevocationReceipt,
  type DailyReflectionRepository
} from "./repository";

export type DailyReflectionCandidateRevocationServiceResult = {
  operation: DailyReflectionCandidateRevocationOperation;
  receipt: DailyReflectionCandidateRevocationReceipt;
  rememberedCount: number;
  reused: boolean;
};

export class DailyReflectionCandidateRevocationError extends Error {
  constructor(
    readonly code:
      | "daily_reflection_candidate_revocation_failed"
      | "daily_reflection_candidate_revocation_index_refresh_failed"
  ) {
    super(code);
    this.name = "DailyReflectionCandidateRevocationError";
  }
}

type SourceRepository = Pick<
  DailyReflectionRepository,
  | "prepareCandidateRevocation"
  | "startCandidateRevocation"
  | "completeCandidateRevocation"
  | "failCandidateRevocation"
  | "setCandidateRevocationIndexRefreshStatus"
  | "getCandidateRevocationReceipt"
  | "getRememberedCandidateCount"
>;

export type DailyReflectionCandidateRevocationDependencies = {
  sourceRepository: SourceRepository;
  memoryRepository: {
    apply(input: {
      id: string;
      userId: string;
      reflectionId: string;
      confirmationId: string;
      candidateId: string;
      operationKey: string;
      payloadDigest: string;
      now: string;
    }): DailyReflectionMemoryCandidateRevocationResult;
  };
  shouldRefreshIndex: () => boolean;
  enqueueIndexRefresh: (accountId: string) => Promise<unknown>;
  now?: () => string;
  idFactory?: () => string;
  leaseDurationMs?: number;
};

function stableId(prefix: string, value: string) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

export function createDailyReflectionCandidateRevocationService(
  dependencies: DailyReflectionCandidateRevocationDependencies
) {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const idFactory = dependencies.idFactory ?? randomUUID;
  const leaseDurationMs = dependencies.leaseDurationMs ?? 60_000;

  async function refreshIndexIfRequired(input: {
    accountId: string;
    reflectionId: string;
    candidateId: string;
    operation: DailyReflectionCandidateRevocationOperation;
  }) {
    if (!dependencies.shouldRefreshIndex()) return input.operation;
    if (input.operation.indexRefreshStatus === "enqueued") return input.operation;
    if (
      input.operation.indexRefreshStatus !== "pending"
      && input.operation.indexRefreshStatus !== "failed"
    ) {
      return input.operation;
    }
    try {
      await dependencies.enqueueIndexRefresh(input.accountId);
      return dependencies.sourceRepository.setCandidateRevocationIndexRefreshStatus({
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        candidateId: input.candidateId,
        status: "enqueued",
        now: now()
      }) ?? input.operation;
    } catch {
      dependencies.sourceRepository.setCandidateRevocationIndexRefreshStatus({
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        candidateId: input.candidateId,
        status: "failed",
        now: now()
      });
      throw new DailyReflectionCandidateRevocationError(
        "daily_reflection_candidate_revocation_index_refresh_failed"
      );
    }
  }

  async function revoke(input: {
    accountId: string;
    reflectionId: string;
    candidateId: string;
    expectedVersion: number;
    idempotencyKey: string;
  }): Promise<DailyReflectionCandidateRevocationServiceResult> {
    const prepared = dependencies.sourceRepository.prepareCandidateRevocation(input);
    if (prepared.receipt) {
      const operation = await refreshIndexIfRequired({ ...input, operation: prepared.operation });
      return {
        operation,
        receipt: prepared.receipt,
        rememberedCount: dependencies.sourceRepository.getRememberedCandidateCount(
          input.accountId,
          input.reflectionId
        ),
        reused: prepared.reused
      };
    }

    const leaseOwner = `daily-reflection-candidate-revocation:${idFactory()}`;
    const claimed = dependencies.sourceRepository.startCandidateRevocation({
      accountId: input.accountId,
      reflectionId: input.reflectionId,
      candidateId: input.candidateId,
      leaseOwner,
      leaseDurationMs,
      now: now()
    });
    if (!claimed.executionFence) {
      const receipt = dependencies.sourceRepository.getCandidateRevocationReceipt(
        input.accountId,
        claimed.operation.id
      );
      if (!receipt) {
        throw new DailyReflectionCandidateRevocationError(
          "daily_reflection_candidate_revocation_failed"
        );
      }
      const operation = await refreshIndexIfRequired({ ...input, operation: claimed.operation });
      return {
        operation,
        receipt,
        rememberedCount: dependencies.sourceRepository.getRememberedCandidateCount(
          input.accountId,
          input.reflectionId
        ),
        reused: true
      };
    }

    const payloadDigest = dailyReflectionCandidateRevocationPayloadDigest({
      userId: input.accountId,
      reflectionId: input.reflectionId,
      confirmationId: claimed.operation.confirmationId,
      candidateId: input.candidateId,
      operationKey: claimed.operation.operationKey
    });
    let memoryApplied = false;
    try {
      const memoryResult = dependencies.memoryRepository.apply({
        id: stableId("memory_daily_reflection_candidate_revocation", claimed.operation.id),
        userId: input.accountId,
        reflectionId: input.reflectionId,
        confirmationId: claimed.operation.confirmationId,
        candidateId: input.candidateId,
        operationKey: claimed.operation.operationKey,
        payloadDigest,
        now: now()
      });
      memoryApplied = true;
      const completed = dependencies.sourceRepository.completeCandidateRevocation({
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        candidateId: input.candidateId,
        leaseOwner: claimed.executionFence.leaseOwner,
        attemptVersion: claimed.executionFence.attemptVersion,
        result: {
          outcome: "revoked",
          memoryId: memoryResult.historicalMemoryId,
          removedMemoryEvidenceCount: memoryResult.removedMemoryEvidenceCount,
          removedPersonSourceCount: memoryResult.removedPersonSourceCount
        },
        indexRefreshRequired: dependencies.shouldRefreshIndex(),
        now: now()
      });
      const operation = await refreshIndexIfRequired({ ...input, operation: completed.operation });
      return {
        operation,
        receipt: completed.receipt,
        rememberedCount: dependencies.sourceRepository.getRememberedCandidateCount(
          input.accountId,
          input.reflectionId
        ),
        reused: prepared.reused || memoryResult.reused || completed.reused
      };
    } catch (error) {
      if (!(error instanceof DailyReflectionCandidateRevocationError)) {
        try {
          dependencies.sourceRepository.failCandidateRevocation({
            accountId: input.accountId,
            reflectionId: input.reflectionId,
            candidateId: input.candidateId,
            leaseOwner: claimed.executionFence.leaseOwner,
            attemptVersion: claimed.executionFence.attemptVersion,
            errorCode: memoryApplied
              ? "daily_reflection_candidate_revocation_receipt_failed"
              : "daily_reflection_candidate_revocation_memory_failed",
            now: now()
          });
        } catch {
          // A stale worker must not overwrite a newer attempt or whole-delete fence.
        }
      }
      if (error instanceof DailyReflectionConflictError) throw error;
      if (error instanceof DailyReflectionCandidateRevocationError) throw error;
      throw new DailyReflectionCandidateRevocationError(
        "daily_reflection_candidate_revocation_failed"
      );
    }
  }

  return { revoke };
}

export function getDailyReflectionCandidateRevocationService() {
  const memoryDatabase = getMemoryDatabase();
  return createDailyReflectionCandidateRevocationService({
    sourceRepository: createDailyReflectionRepository(getDailyReflectionDatabase()),
    memoryRepository: createDailyReflectionMemoryCandidateRevocationRepository(memoryDatabase),
    shouldRefreshIndex: () => (
      resolvePipelineExecutionMode() === "queue"
      && resolveQaHybridRetrievalMode() !== "off"
    ),
    enqueueIndexRefresh: (accountId) => enqueueEmbeddingIndexJob({
      version: 1,
      userRef: accountId,
      reason: "upload_deleted"
    })
  });
}
