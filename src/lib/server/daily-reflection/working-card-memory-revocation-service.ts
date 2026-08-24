import { createHash, randomUUID } from "node:crypto";

import type {
  DailyReflectionCardMemoryRevocationOperation,
  DailyReflectionCardMemoryRevocationReceipt
} from "@/lib/domain/daily-reflection-memory-revocation";
import {
  createDailyReflectionMemoryCandidateRevocationRepository,
  dailyReflectionCandidateRevocationPayloadDigest,
  DailyReflectionMemoryCandidateRevocationError,
  type DailyReflectionMemoryCandidateRevocationResult
} from "@/lib/server/memory/daily-reflection-candidate-revocation";
import { getMemoryDatabase } from "@/lib/server/memory/db";
import { resolvePipelineExecutionMode } from "@/lib/server/queue/config";
import { enqueueEmbeddingIndexJob } from "@/lib/server/queue/producer";
import { resolveQaHybridRetrievalMode } from
  "@/lib/server/retrieval/hybrid/runtime-config";

import { getDailyReflectionDatabase } from "./db";
import {
  createDailyReflectionWorkingCardMemoryRevocationRepository,
  type DailyReflectionWorkingCardMemoryRevocationRepository
} from "./working-card-memory-revocation-repository";
import {
  DailyReflectionConflictError,
  DailyReflectionNotFoundError,
  DailyReflectionVersionConflictError
} from "./repository";

type SourceRepository = Pick<
  DailyReflectionWorkingCardMemoryRevocationRepository,
  "get" | "prepare" | "start" | "complete" | "fail" | "setIndexRefreshStatus"
>;

type MemoryRepository = {
  findActiveAuthority(userId: string, candidateId: string): {
    reflectionId: string;
    confirmationId: string;
    candidateId: string;
    currentMemoryId: string;
    publicationStatus: "unpublished" | "published";
  } | null;
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

export type DailyReflectionWorkingCardMemoryRevocationServiceDependencies = {
  sourceRepository: SourceRepository;
  memoryRepository: MemoryRepository;
  shouldRefreshIndex: () => boolean;
  enqueueIndexRefresh: (accountId: string) => Promise<unknown>;
  now?: () => string;
  idFactory?: () => string;
  leaseDurationMs?: number;
};

export type DailyReflectionWorkingCardMemoryRevocationServiceResult = {
  operation: DailyReflectionCardMemoryRevocationOperation;
  receipt: DailyReflectionCardMemoryRevocationReceipt | null;
  card: ReturnType<SourceRepository["prepare"]>["card"];
  reused: boolean;
};

export class DailyReflectionWorkingCardMemoryRevocationServiceError extends Error {
  constructor(readonly code:
    | "daily_reflection_card_memory_revocation_failed"
    | "daily_reflection_card_memory_revocation_index_refresh_failed") {
    super(code);
    this.name = "DailyReflectionWorkingCardMemoryRevocationServiceError";
  }
}

function stableId(prefix: string, value: string) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

export function createDailyReflectionWorkingCardMemoryRevocationService(
  dependencies: DailyReflectionWorkingCardMemoryRevocationServiceDependencies
) {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const idFactory = dependencies.idFactory ?? randomUUID;
  const leaseDurationMs = dependencies.leaseDurationMs ?? 60_000;

  async function refreshIndexIfRequired(input: {
    accountId: string;
    cardId: string;
    operation: DailyReflectionCardMemoryRevocationOperation;
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
      return dependencies.sourceRepository.setIndexRefreshStatus({
        accountId: input.accountId,
        cardId: input.cardId,
        status: "enqueued",
        now: now()
      });
    } catch {
      dependencies.sourceRepository.setIndexRefreshStatus({
        accountId: input.accountId,
        cardId: input.cardId,
        status: "failed",
        now: now()
      });
      throw new DailyReflectionWorkingCardMemoryRevocationServiceError(
        "daily_reflection_card_memory_revocation_index_refresh_failed"
      );
    }
  }

  function get(accountId: string, cardId: string) {
    return dependencies.sourceRepository.get(accountId, cardId);
  }

  async function revoke(input: {
    accountId: string;
    cardId: string;
    expectedMemoryLifecycleVersion: number;
    idempotencyKey: string;
  }): Promise<DailyReflectionWorkingCardMemoryRevocationServiceResult> {
    const authority = dependencies.memoryRepository.findActiveAuthority(
      input.accountId,
      input.cardId
    );
    const prepared = dependencies.sourceRepository.prepare({ ...input, authority });
    if (prepared.receipt) {
      const operation = await refreshIndexIfRequired({
        accountId: input.accountId,
        cardId: input.cardId,
        operation: prepared.operation
      });
      return { ...prepared, operation, reused: true };
    }
    const leaseOwner = `daily-reflection-card-memory-revocation:${idFactory()}`;
    const claimed = dependencies.sourceRepository.start({
      accountId: input.accountId,
      cardId: input.cardId,
      leaseOwner,
      leaseDurationMs,
      now: now()
    });
    if (!claimed.executionFence) {
      const existing = get(input.accountId, input.cardId);
      if (!existing?.receipt) {
        throw new DailyReflectionWorkingCardMemoryRevocationServiceError(
          "daily_reflection_card_memory_revocation_failed"
        );
      }
      const operation = await refreshIndexIfRequired({
        accountId: input.accountId,
        cardId: input.cardId,
        operation: existing.operation
      });
      return { ...existing, operation, reused: true };
    }

    let memoryApplied = false;
    let memoryReused = false;
    try {
      let result: {
        outcome: "revoked" | "no_long_term_object";
        historicalMemoryId: string | null;
        removedMemoryEvidenceCount: number;
        removedPersonSourceCount: number;
      } = {
        outcome: "no_long_term_object",
        historicalMemoryId: null,
        removedMemoryEvidenceCount: 0,
        removedPersonSourceCount: 0
      };
      if (claimed.operation.authorityConfirmationId) {
        const payloadDigest = dailyReflectionCandidateRevocationPayloadDigest({
          userId: input.accountId,
          reflectionId: claimed.operation.reflectionId,
          confirmationId: claimed.operation.authorityConfirmationId,
          candidateId: input.cardId,
          operationKey: claimed.operation.operationKey
        });
        try {
          const memory = dependencies.memoryRepository.apply({
            id: stableId(
              "memory_daily_reflection_card_revocation",
              claimed.operation.id
            ),
            userId: input.accountId,
            reflectionId: claimed.operation.reflectionId,
            confirmationId: claimed.operation.authorityConfirmationId,
            candidateId: input.cardId,
            operationKey: claimed.operation.operationKey,
            payloadDigest,
            now: now()
          });
          memoryApplied = true;
          memoryReused = memory.reused;
          result = {
            outcome: "revoked",
            historicalMemoryId: memory.historicalMemoryId,
            removedMemoryEvidenceCount: memory.removedMemoryEvidenceCount,
            removedPersonSourceCount: memory.removedPersonSourceCount
          };
        } catch (error) {
          const authorityAfterFailure = dependencies.memoryRepository
            .findActiveAuthority(input.accountId, input.cardId);
          if (
            error instanceof DailyReflectionMemoryCandidateRevocationError
            && [
              "daily_reflection_candidate_revocation_not_found",
              "daily_reflection_candidate_revocation_payload_missing",
              "daily_reflection_candidate_revocation_upload_deleted"
            ].includes(error.code)
            && authorityAfterFailure === null
          ) {
            result = {
              outcome: "no_long_term_object",
              historicalMemoryId: null,
              removedMemoryEvidenceCount: 0,
              removedPersonSourceCount: 0
            };
          } else {
            throw error;
          }
        }
      }
      const completed = dependencies.sourceRepository.complete({
        accountId: input.accountId,
        cardId: input.cardId,
        leaseOwner: claimed.executionFence.leaseOwner,
        attemptVersion: claimed.executionFence.attemptVersion,
        result,
        indexRefreshRequired: dependencies.shouldRefreshIndex(),
        now: now()
      });
      const operation = await refreshIndexIfRequired({
        accountId: input.accountId,
        cardId: input.cardId,
        operation: completed.operation
      });
      return {
        ...completed,
        operation,
        reused: prepared.reused || completed.reused || memoryReused
      };
    } catch (error) {
      if (
        !(error instanceof DailyReflectionWorkingCardMemoryRevocationServiceError)
      ) {
        try {
          dependencies.sourceRepository.fail({
            accountId: input.accountId,
            cardId: input.cardId,
            leaseOwner: claimed.executionFence.leaseOwner,
            attemptVersion: claimed.executionFence.attemptVersion,
            errorCode: memoryApplied
              ? "daily_reflection_card_memory_revocation_receipt_failed"
              : "daily_reflection_card_memory_revocation_memory_failed",
            now: now()
          });
        } catch {
          // A stale worker cannot overwrite a newer attempt or deletion fence.
        }
      }
      if (error instanceof DailyReflectionWorkingCardMemoryRevocationServiceError) {
        throw error;
      }
      if (
        error instanceof DailyReflectionConflictError
        || error instanceof DailyReflectionNotFoundError
        || error instanceof DailyReflectionVersionConflictError
      ) {
        throw error;
      }
      throw new DailyReflectionWorkingCardMemoryRevocationServiceError(
        "daily_reflection_card_memory_revocation_failed"
      );
    }
  }

  return { get, revoke };
}

export function getDailyReflectionWorkingCardMemoryRevocationService() {
  const sourceRepository = createDailyReflectionWorkingCardMemoryRevocationRepository(
    getDailyReflectionDatabase()
  );
  const memoryRepository = createDailyReflectionMemoryCandidateRevocationRepository(
    getMemoryDatabase()
  );
  return createDailyReflectionWorkingCardMemoryRevocationService({
    sourceRepository,
    memoryRepository,
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
