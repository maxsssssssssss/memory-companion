import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";

import {
  DailyReflectionCardMemoryRevocationOperationSchema,
  DailyReflectionCardMemoryRevocationReceiptSchema,
  type DailyReflectionCardMemoryRevocationOperation,
  type DailyReflectionCardMemoryRevocationReceipt
} from "@/lib/domain/daily-reflection-memory-revocation";
import { DailyReflectionIdSchema } from "@/lib/domain/daily-reflection";
import type { DailyReflectionMemoryCardAuthority } from
  "@/lib/server/memory/daily-reflection-candidate-revocation";

import {
  DailyReflectionConflictError,
  DailyReflectionNotFoundError,
  DailyReflectionVersionConflictError,
  createDailyReflectionRepository,
  type DailyReflectionRepository,
  type DailyReflectionRepositoryOptions
} from "./repository";

type OperationRow = {
  id: string;
  account_id: string;
  card_id: string;
  reflection_id: string;
  proposal_id: string | null;
  authority_confirmation_id: string | null;
  authority_memory_id: string | null;
  operation_key: string;
  idempotency_key: string;
  request_fingerprint: string;
  requested_lifecycle_version: number;
  status: "ready" | "revoking" | "completed" | "failed";
  attempt_version: number;
  lease_owner: string | null;
  lease_until: string | null;
  error_code: string | null;
  index_refresh_status: "not_required" | "pending" | "enqueued" | "failed";
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type ReceiptRow = {
  card_id: string;
  proposal_id: string | null;
  outcome: "revoked" | "no_long_term_object";
  historical_memory_id: string | null;
  removed_memory_evidence_count: number;
  removed_person_source_count: number;
  created_at: string;
};

type ProposalRow = {
  id: string;
  reflection_id: string;
  status: "pending" | "approved" | "rejected" | "admitted";
  version: number;
  lease_owner: string | null;
  lease_until: string | null;
};

const PrepareSchema = z.object({
  accountId: DailyReflectionIdSchema,
  cardId: DailyReflectionIdSchema,
  expectedMemoryLifecycleVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().trim().min(1).max(512),
  authority: z.object({
    reflectionId: DailyReflectionIdSchema,
    confirmationId: DailyReflectionIdSchema,
    candidateId: DailyReflectionIdSchema,
    currentMemoryId: DailyReflectionIdSchema,
    publicationStatus: z.enum(["unpublished", "published"])
  }).strict().nullable()
}).strict();

const IdentitySchema = z.object({
  accountId: DailyReflectionIdSchema,
  cardId: DailyReflectionIdSchema
}).strict();

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function operationFromRow(row: OperationRow): DailyReflectionCardMemoryRevocationOperation {
  return DailyReflectionCardMemoryRevocationOperationSchema.parse({
    id: row.id,
    accountId: row.account_id,
    cardId: row.card_id,
    reflectionId: row.reflection_id,
    proposalId: row.proposal_id,
    authorityConfirmationId: row.authority_confirmation_id,
    authorityMemoryId: row.authority_memory_id,
    operationKey: row.operation_key,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    requestedMemoryLifecycleVersion: row.requested_lifecycle_version,
    status: row.status,
    attemptVersion: row.attempt_version,
    indexRefreshStatus: row.index_refresh_status,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  });
}

function receiptFromRow(row: ReceiptRow): DailyReflectionCardMemoryRevocationReceipt {
  return DailyReflectionCardMemoryRevocationReceiptSchema.parse({
    cardId: row.card_id,
    proposalId: row.proposal_id,
    outcome: row.outcome,
    historicalMemoryId: row.historical_memory_id,
    removedMemoryEvidenceCount: row.removed_memory_evidence_count,
    removedPersonSourceCount: row.removed_person_source_count,
    createdAt: row.created_at
  });
}

export type DailyReflectionWorkingCardMemoryRevocationRepositoryOptions = {
  sourceRepository?: DailyReflectionRepository;
  sourceRepositoryOptions?: DailyReflectionRepositoryOptions;
  now?: () => string;
  idFactory?: () => string;
};

export class DailyReflectionWorkingCardMemoryRevocationRepository {
  private readonly sourceRepository: DailyReflectionRepository;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(
    private readonly database: Database.Database,
    options: DailyReflectionWorkingCardMemoryRevocationRepositoryOptions = {}
  ) {
    this.sourceRepository = options.sourceRepository
      ?? createDailyReflectionRepository(database, options.sourceRepositoryOptions);
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  private findOperationRow(accountId: string, cardId: string) {
    return this.database.prepare(`
      SELECT * FROM dr_working_card_memory_revocation_operations
      WHERE account_id = ? AND card_id = ?
    `).get(accountId, cardId) as OperationRow | undefined;
  }

  private requireOperationRow(accountId: string, cardId: string) {
    const row = this.findOperationRow(accountId, cardId);
    if (!row) throw new DailyReflectionNotFoundError();
    return row;
  }

  private findReceiptRow(accountId: string, operationId: string) {
    return this.database.prepare(`
      SELECT card_id, proposal_id, outcome, historical_memory_id,
             removed_memory_evidence_count, removed_person_source_count,
             created_at
      FROM dr_working_card_memory_revocation_receipts
      WHERE account_id = ? AND operation_id = ?
    `).get(accountId, operationId) as ReceiptRow | undefined;
  }

  private findProposal(accountId: string, cardId: string) {
    return this.database.prepare(`
      SELECT id, reflection_id, status, version, lease_owner, lease_until
      FROM dr_memory_proposals
      WHERE account_id = ? AND card_id = ?
    `).get(accountId, cardId) as ProposalRow | undefined;
  }

  private proposalRevoked(accountId: string, proposalId: string) {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM dr_memory_proposal_events
      WHERE account_id = ? AND proposal_id = ? AND event_type = 'revoked'
    `).get(accountId, proposalId));
  }

  get(accountId: string, cardId: string) {
    const identity = IdentitySchema.parse({ accountId, cardId });
    const row = this.findOperationRow(identity.accountId, identity.cardId);
    if (!row) return null;
    const receipt = this.findReceiptRow(identity.accountId, row.id);
    return {
      operation: operationFromRow(row),
      receipt: receipt ? receiptFromRow(receipt) : null,
      card: this.sourceRepository.getWorkingCard(identity.accountId, identity.cardId)
    };
  }

  prepare(rawInput: {
    accountId: string;
    cardId: string;
    expectedMemoryLifecycleVersion: number;
    idempotencyKey: string;
    authority: DailyReflectionMemoryCardAuthority | null;
  }) {
    const input = PrepareSchema.parse(rawInput);
    const run = this.database.transaction(() => {
      const existing = this.findOperationRow(input.accountId, input.cardId);
      if (existing) {
        if (
          existing.idempotency_key !== input.idempotencyKey
          || existing.requested_lifecycle_version
            !== input.expectedMemoryLifecycleVersion
        ) {
          throw new DailyReflectionConflictError(
            "daily_reflection_card_memory_revocation_idempotency_conflict"
          );
        }
        return {
          operation: operationFromRow(existing),
          receipt: this.findReceiptRow(input.accountId, existing.id)
            ? receiptFromRow(this.findReceiptRow(input.accountId, existing.id)!)
            : null,
          card: this.sourceRepository.getWorkingCard(input.accountId, input.cardId),
          reused: true
        };
      }
      const conflictingKey = this.database.prepare(`
        SELECT card_id FROM dr_working_card_memory_revocation_operations
        WHERE account_id = ? AND idempotency_key = ?
      `).get(input.accountId, input.idempotencyKey) as { card_id: string } | undefined;
      if (conflictingKey) {
        throw new DailyReflectionConflictError(
          "daily_reflection_card_memory_revocation_idempotency_conflict"
        );
      }
      const card = this.sourceRepository.getWorkingCard(input.accountId, input.cardId);
      if (card.memoryLifecycleVersion !== input.expectedMemoryLifecycleVersion) {
        throw new DailyReflectionVersionConflictError(card.memoryLifecycleVersion);
      }
      if (card.status !== "saved" && card.status !== "archived") {
        throw new DailyReflectionConflictError(
          "daily_reflection_card_memory_revocation_ineligible"
        );
      }
      const proposal = this.findProposal(input.accountId, input.cardId);
      const proposalIsRevoked = proposal
        ? this.proposalRevoked(input.accountId, proposal.id)
        : false;
      const now = this.now();
      if (
        !input.authority
        && proposal?.status === "admitted"
        && !proposalIsRevoked
      ) {
        throw new DailyReflectionConflictError(
          "daily_reflection_card_memory_authority_missing"
        );
      }
      if (
        !input.authority
        && proposal?.status === "approved"
        && proposal.lease_owner
        && proposal.lease_until
        && proposal.lease_until > now
      ) {
        throw new DailyReflectionConflictError(
          "daily_reflection_memory_proposal_busy"
        );
      }
      if (input.authority) {
        if (
          input.authority.candidateId !== input.cardId
          || !card.sourceReflectionIds.includes(input.authority.reflectionId)
          || (
            proposal
            && (
              proposal.id !== input.authority.confirmationId
              || proposal.reflection_id !== input.authority.reflectionId
              || proposal.status === "rejected"
              || proposalIsRevoked
            )
          )
        ) {
          throw new DailyReflectionConflictError(
            "daily_reflection_card_memory_authority_conflict"
          );
        }
      }
      const reflectionId = input.authority?.reflectionId
        ?? proposal?.reflection_id
        ?? card.sourceReflectionIds[0]!;
      const operationKey = `daily-reflection-card-revocation:${input.cardId}`;
      const requestFingerprint = digest({
        version: 1,
        accountId: input.accountId,
        cardId: input.cardId,
        expectedMemoryLifecycleVersion: input.expectedMemoryLifecycleVersion,
        idempotencyKey: input.idempotencyKey,
        proposalId: proposal?.id ?? null,
        authority: input.authority
      });
      const operationId = `dr_card_memory_revoke_${digest([
        input.accountId,
        input.cardId
      ]).slice(0, 32)}`;
      this.database.prepare(`
        INSERT INTO dr_working_card_memory_revocation_operations (
          id, account_id, card_id, reflection_id, proposal_id,
          authority_confirmation_id, authority_memory_id, operation_key,
          idempotency_key, request_fingerprint, requested_lifecycle_version,
          status, attempt_version, lease_owner, lease_until, error_code,
          index_refresh_status, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 0,
          NULL, NULL, NULL, 'not_required', ?, ?, NULL)
      `).run(
        operationId,
        input.accountId,
        input.cardId,
        reflectionId,
        proposal?.id ?? null,
        input.authority?.confirmationId ?? null,
        input.authority?.currentMemoryId ?? null,
        operationKey,
        input.idempotencyKey,
        requestFingerprint,
        input.expectedMemoryLifecycleVersion,
        now,
        now
      );
      const lifecycleUpdated = this.database.prepare(`
        UPDATE dr_working_cards
        SET memory_lifecycle_status = 'revocation_requested',
            memory_lifecycle_version = memory_lifecycle_version + 1,
            memory_lifecycle_updated_at = ?
        WHERE account_id = ? AND id = ? AND memory_lifecycle_version = ?
          AND memory_lifecycle_status <> 'revoked'
      `).run(
        now,
        input.accountId,
        input.cardId,
        input.expectedMemoryLifecycleVersion
      );
      if (lifecycleUpdated.changes !== 1) {
        throw new DailyReflectionVersionConflictError(
          this.sourceRepository.getWorkingCard(input.accountId, input.cardId)
            .memoryLifecycleVersion
        );
      }
      return {
        operation: operationFromRow(this.requireOperationRow(input.accountId, input.cardId)),
        receipt: null,
        card: this.sourceRepository.getWorkingCard(input.accountId, input.cardId),
        reused: false
      };
    });
    return run.immediate();
  }

  start(input: {
    accountId: string;
    cardId: string;
    leaseOwner: string;
    leaseDurationMs: number;
    now?: string;
  }) {
    const parsed = IdentitySchema.extend({
      leaseOwner: z.string().trim().min(1).max(512),
      leaseDurationMs: z.number().int().positive().max(15 * 60_000),
      now: z.string().datetime().optional()
    }).strict().parse(input);
    const run = this.database.transaction(() => {
      const row = this.requireOperationRow(parsed.accountId, parsed.cardId);
      if (row.status === "completed") {
        return { operation: operationFromRow(row), executionFence: null, reused: true };
      }
      const now = parsed.now ?? this.now();
      if (row.status === "revoking" && row.lease_until && row.lease_until > now) {
        if (row.lease_owner === parsed.leaseOwner) {
          return {
            operation: operationFromRow(row),
            executionFence: {
              leaseOwner: parsed.leaseOwner,
              attemptVersion: row.attempt_version
            },
            reused: true
          };
        }
        throw new DailyReflectionConflictError(
          "daily_reflection_card_memory_revocation_busy"
        );
      }
      const leaseUntil = new Date(
        Date.parse(now) + parsed.leaseDurationMs
      ).toISOString();
      const updated = this.database.prepare(`
        UPDATE dr_working_card_memory_revocation_operations
        SET status = 'revoking', attempt_version = attempt_version + 1,
            lease_owner = ?, lease_until = ?, error_code = NULL, updated_at = ?
        WHERE account_id = ? AND card_id = ? AND (
          status IN ('ready', 'failed')
          OR (status = 'revoking' AND (lease_until IS NULL OR lease_until <= ?))
        )
      `).run(
        parsed.leaseOwner,
        leaseUntil,
        now,
        parsed.accountId,
        parsed.cardId,
        now
      );
      if (updated.changes !== 1) {
        throw new DailyReflectionConflictError(
          "daily_reflection_card_memory_revocation_claim_conflict"
        );
      }
      const claimed = this.requireOperationRow(parsed.accountId, parsed.cardId);
      return {
        operation: operationFromRow(claimed),
        executionFence: {
          leaseOwner: parsed.leaseOwner,
          attemptVersion: claimed.attempt_version
        },
        reused: false
      };
    });
    return run.immediate();
  }

  complete(input: {
    accountId: string;
    cardId: string;
    leaseOwner: string;
    attemptVersion: number;
    result: {
      outcome: "revoked" | "no_long_term_object";
      historicalMemoryId: string | null;
      removedMemoryEvidenceCount: number;
      removedPersonSourceCount: number;
    };
    indexRefreshRequired: boolean;
    now?: string;
  }) {
    const parsed = IdentitySchema.extend({
      leaseOwner: z.string().trim().min(1).max(512),
      attemptVersion: z.number().int().positive(),
      result: z.object({
        outcome: z.enum(["revoked", "no_long_term_object"]),
        historicalMemoryId: DailyReflectionIdSchema.nullable(),
        removedMemoryEvidenceCount: z.number().int().nonnegative(),
        removedPersonSourceCount: z.number().int().nonnegative()
      }).strict(),
      indexRefreshRequired: z.boolean(),
      now: z.string().datetime().optional()
    }).strict().parse(input);
    if (
      (parsed.result.outcome === "revoked")
      !== (parsed.result.historicalMemoryId !== null)
    ) {
      throw new DailyReflectionConflictError(
        "daily_reflection_card_memory_revocation_result_invalid"
      );
    }
    const run = this.database.transaction(() => {
      const row = this.requireOperationRow(parsed.accountId, parsed.cardId);
      const existingReceipt = this.findReceiptRow(parsed.accountId, row.id);
      if (row.status === "completed" && existingReceipt) {
        return {
          operation: operationFromRow(row),
          receipt: receiptFromRow(existingReceipt),
          card: this.sourceRepository.getWorkingCard(parsed.accountId, parsed.cardId),
          reused: true
        };
      }
      const now = parsed.now ?? this.now();
      if (
        row.status !== "revoking"
        || row.lease_owner !== parsed.leaseOwner
        || row.attempt_version !== parsed.attemptVersion
        || !row.lease_until
        || row.lease_until <= now
      ) {
        throw new DailyReflectionConflictError(
          "daily_reflection_card_memory_revocation_lease_lost"
        );
      }
      const proposal = row.proposal_id
        ? this.findProposal(parsed.accountId, parsed.cardId)
        : undefined;
      if (proposal && (proposal.status === "pending" || proposal.status === "approved")) {
        this.database.prepare(`
          UPDATE dr_memory_proposals
          SET status = 'rejected', reasons_json = '["card_revoked"]',
              lease_owner = NULL, lease_until = NULL,
              error_code = 'daily_reflection_card_revoked',
              version = version + 1, updated_at = ?
          WHERE account_id = ? AND id = ? AND status IN ('pending', 'approved')
        `).run(now, parsed.accountId, proposal.id);
      }
      const currentProposal = row.proposal_id
        ? this.findProposal(parsed.accountId, parsed.cardId)
        : undefined;
      if (
        currentProposal
        && !this.proposalRevoked(parsed.accountId, currentProposal.id)
      ) {
        this.database.prepare(`
          INSERT INTO dr_memory_proposal_events (
            id, account_id, proposal_id, proposal_version, event_type,
            reason_metadata_json, created_at
          ) VALUES (?, ?, ?, ?, 'revoked', ?, ?)
        `).run(
          this.idFactory(),
          parsed.accountId,
          currentProposal.id,
          currentProposal.version,
          JSON.stringify({ reasonCode: "card_revoked" }),
          now
        );
      }
      const cardUpdated = this.database.prepare(`
        UPDATE dr_working_cards
        SET memory_lifecycle_status = 'revoked',
            memory_lifecycle_version = memory_lifecycle_version + 1,
            memory_lifecycle_updated_at = ?
        WHERE account_id = ? AND id = ?
          AND memory_lifecycle_status IN ('revocation_requested', 'revoked')
      `).run(now, parsed.accountId, parsed.cardId);
      if (cardUpdated.changes !== 1) {
        throw new DailyReflectionConflictError(
          "daily_reflection_card_memory_lifecycle_conflict"
        );
      }
      this.database.prepare(`
        INSERT INTO dr_working_card_memory_revocation_receipts (
          account_id, operation_id, card_id, proposal_id, outcome,
          historical_memory_id, removed_memory_evidence_count,
          removed_person_source_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        parsed.accountId,
        row.id,
        parsed.cardId,
        row.proposal_id,
        parsed.result.outcome,
        parsed.result.historicalMemoryId,
        parsed.result.removedMemoryEvidenceCount,
        parsed.result.removedPersonSourceCount,
        now
      );
      const updated = this.database.prepare(`
        UPDATE dr_working_card_memory_revocation_operations
        SET status = 'completed', lease_owner = NULL, lease_until = NULL,
            error_code = NULL, index_refresh_status = ?,
            updated_at = ?, completed_at = ?
        WHERE account_id = ? AND card_id = ? AND status = 'revoking'
          AND lease_owner = ? AND attempt_version = ? AND lease_until > ?
      `).run(
        parsed.indexRefreshRequired && parsed.result.outcome === "revoked"
          ? "pending"
          : "not_required",
        now,
        now,
        parsed.accountId,
        parsed.cardId,
        parsed.leaseOwner,
        parsed.attemptVersion,
        now
      );
      if (updated.changes !== 1) {
        throw new DailyReflectionConflictError(
          "daily_reflection_card_memory_revocation_lease_lost"
        );
      }
      const completed = this.requireOperationRow(parsed.accountId, parsed.cardId);
      return {
        operation: operationFromRow(completed),
        receipt: receiptFromRow(this.findReceiptRow(parsed.accountId, completed.id)!),
        card: this.sourceRepository.getWorkingCard(parsed.accountId, parsed.cardId),
        reused: false
      };
    });
    return run.immediate();
  }

  fail(input: {
    accountId: string;
    cardId: string;
    leaseOwner: string;
    attemptVersion: number;
    errorCode: string;
    now?: string;
  }) {
    const parsed = IdentitySchema.extend({
      leaseOwner: z.string().trim().min(1).max(512),
      attemptVersion: z.number().int().positive(),
      errorCode: z.string().trim().min(1).max(128)
        .regex(/^[a-z0-9][a-z0-9_.:-]*$/u),
      now: z.string().datetime().optional()
    }).strict().parse(input);
    const now = parsed.now ?? this.now();
    const updated = this.database.prepare(`
      UPDATE dr_working_card_memory_revocation_operations
      SET status = 'failed', lease_owner = NULL, lease_until = NULL,
          error_code = ?, updated_at = ?
      WHERE account_id = ? AND card_id = ? AND status = 'revoking'
        AND lease_owner = ? AND attempt_version = ? AND lease_until > ?
    `).run(
      parsed.errorCode,
      now,
      parsed.accountId,
      parsed.cardId,
      parsed.leaseOwner,
      parsed.attemptVersion,
      now
    );
    if (updated.changes !== 1) {
      throw new DailyReflectionConflictError(
        "daily_reflection_card_memory_revocation_lease_lost"
      );
    }
    return operationFromRow(this.requireOperationRow(parsed.accountId, parsed.cardId));
  }

  setIndexRefreshStatus(input: {
    accountId: string;
    cardId: string;
    status: "enqueued" | "failed";
    now?: string;
  }) {
    const parsed = IdentitySchema.extend({
      status: z.enum(["enqueued", "failed"]),
      now: z.string().datetime().optional()
    }).strict().parse(input);
    const now = parsed.now ?? this.now();
    this.database.prepare(`
      UPDATE dr_working_card_memory_revocation_operations
      SET index_refresh_status = ?, updated_at = ?
      WHERE account_id = ? AND card_id = ? AND status = 'completed'
        AND index_refresh_status IN ('pending', 'failed')
    `).run(parsed.status, now, parsed.accountId, parsed.cardId);
    return operationFromRow(this.requireOperationRow(parsed.accountId, parsed.cardId));
  }
}

export function createDailyReflectionWorkingCardMemoryRevocationRepository(
  database: Database.Database,
  options: DailyReflectionWorkingCardMemoryRevocationRepositoryOptions = {}
) {
  return new DailyReflectionWorkingCardMemoryRevocationRepository(database, options);
}
