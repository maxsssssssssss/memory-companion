import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";

import {
  DailyReflectionMemoryProposalSchema,
  DailyReflectionMemoryProposalStatusSchema,
  DailyReflectionMemoryProposalTypeSchema,
  type DailyReflectionMemoryProposal
} from "@/lib/domain/daily-reflection-memory-proposal";
import {
  DailyReflectionIdSchema,
  ProcessingPlanV2Schema,
  ReflectionConfirmationV2Schema
} from "@/lib/domain/daily-reflection";
import {
  AudioUploadSchema,
  type TranscriptSegment
} from "@/lib/domain/types";

import { parseDailyReflectionCanonicalTranscript } from "./canonical-transcript";
import {
  DailyReflectionConflictError,
  DailyReflectionNotFoundError,
  DailyReflectionVersionConflictError,
  createDailyReflectionRepository,
  type DailyReflectionRepository,
  type DailyReflectionRepositoryOptions
} from "./repository";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const UNASSESSED_POLICY_VERSION = "unassessed";

type ProposalRow = {
  id: string;
  account_id: string;
  card_id: string;
  reflection_id: string;
  title: string;
  card_kind: DailyReflectionMemoryProposal["cardKind"];
  action_claimed: 0 | 1;
  memory_type: DailyReflectionMemoryProposal["memoryType"];
  content: string;
  evidence_ids_json: string;
  evidence_snapshots_json: string;
  risk_flags_json: string;
  subject_person_id: string | null;
  importance: number;
  durability: number;
  novelty: number;
  sensitivity: number;
  epistemic_status: DailyReflectionMemoryProposal["epistemicStatus"];
  epistemic_caution: DailyReflectionMemoryProposal["epistemicCaution"];
  status: DailyReflectionMemoryProposal["status"];
  policy_version: string;
  score: number;
  reasons_json: string;
  operation_key: string;
  request_fingerprint: string;
  memory_id: string | null;
  source_origin: DailyReflectionMemoryProposal["sourceOrigin"];
  input_adapter: DailyReflectionMemoryProposal["inputAdapter"];
  capture_purpose: DailyReflectionMemoryProposal["capturePurpose"];
  recording_date: string;
  created_by: "user";
  admission_method: "daily_reflection_memory_proposal_v1";
  card_version: number;
  version: number;
  lease_owner: string | null;
  lease_until: string | null;
  attempt_version: number;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  admitted_at: string | null;
};

const CreateProposalInputSchema = z.object({
  accountId: DailyReflectionIdSchema,
  cardId: DailyReflectionIdSchema,
  expectedCardVersion: z.number().int().nonnegative(),
  memoryType: DailyReflectionMemoryProposalTypeSchema
}).strict();

const ProposalIdentitySchema = z.object({
  accountId: DailyReflectionIdSchema,
  proposalId: DailyReflectionIdSchema
}).strict();

const PolicyDecisionInputSchema = ProposalIdentitySchema.extend({
  expectedVersion: z.number().int().nonnegative(),
  decision: z.enum(["approved", "rejected"]),
  policyVersion: z.string().trim().min(1).max(128),
  score: z.number().min(0).max(1),
  reasons: z.array(z.string().trim().min(1).max(256)).max(32)
}).strict().superRefine((input, context) => {
  if (input.decision === "rejected" && input.reasons.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reasons"],
      message: "rejected proposals require a reason"
    });
  }
});

type FrozenEvidenceSnapshot = {
  sourceSegmentId: string;
  uploadId: string;
  startSeconds: number;
  endSeconds: number;
  effectiveOrigin: "user_reflection" | "direct_conversation";
  contentDigest: string;
};

const FrozenEvidenceSnapshotSchema = z.object({
  sourceSegmentId: DailyReflectionIdSchema,
  uploadId: DailyReflectionIdSchema,
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  effectiveOrigin: z.enum(["user_reflection", "direct_conversation"]),
  contentDigest: z.string().regex(HASH_PATTERN)
}).strict().refine((snapshot) => snapshot.endSeconds > snapshot.startSeconds, {
  message: "frozen Evidence range must be valid"
});

export type DailyReflectionMemoryProposalSource = {
  proposal: DailyReflectionMemoryProposal;
  evidenceSegments: Array<TranscriptSegment & {
    effectiveOrigin: "user_reflection" | "direct_conversation";
  }>;
  sourceSegments: TranscriptSegment[];
  upload: z.infer<typeof AudioUploadSchema> | null;
  sourceValid: boolean;
  sourceInvalidReason: string | null;
};

export type DailyReflectionMemoryProposalExecutionFence = {
  leaseOwner: string;
  leaseUntil: string;
  attemptVersion: number;
};

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableProposalId(accountId: string, cardId: string) {
  return `daily_reflection_memory_proposal_${createHash("sha256")
    .update(`${accountId}\u0000${cardId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function parseSnapshots(row: ProposalRow): FrozenEvidenceSnapshot[] {
  return z.array(FrozenEvidenceSnapshotSchema).parse(
    JSON.parse(row.evidence_snapshots_json) as unknown
  );
}

function sameCanonicalSegment(
  current: TranscriptSegment,
  snapshot: FrozenEvidenceSnapshot
) {
  return current.id === snapshot.sourceSegmentId
    && current.uploadId === snapshot.uploadId
    && current.startSeconds === snapshot.startSeconds
    && current.endSeconds === snapshot.endSeconds
    && fingerprint({
      id: current.id,
      uploadId: current.uploadId,
      startSeconds: current.startSeconds,
      endSeconds: current.endSeconds,
      speaker: current.speaker ?? null,
      identity: current.identity ?? null,
      text: current.text,
      confidence: current.confidence,
      sceneLabels: current.sceneLabels,
      valueLabels: current.valueLabels
    }) === snapshot.contentDigest;
}

function proposalFromRow(row: ProposalRow): DailyReflectionMemoryProposal {
  const snapshots = parseSnapshots(row);
  return DailyReflectionMemoryProposalSchema.parse({
    id: row.id,
    accountId: row.account_id,
    cardId: row.card_id,
    reflectionId: row.reflection_id,
    title: row.title,
    cardKind: row.card_kind,
    actionClaimed: row.action_claimed === 1,
    memoryType: row.memory_type,
    content: row.content,
    evidenceIds: JSON.parse(row.evidence_ids_json) as unknown,
    evidenceSnapshots: snapshots.map((item) => ({
      sourceSegmentId: item.sourceSegmentId,
      uploadId: item.uploadId,
      startSeconds: item.startSeconds,
      endSeconds: item.endSeconds,
      effectiveOrigin: item.effectiveOrigin
    })),
    riskFlags: JSON.parse(row.risk_flags_json) as unknown,
    subjectPersonId: row.subject_person_id,
    importance: row.importance,
    durability: row.durability,
    novelty: row.novelty,
    sensitivity: row.sensitivity,
    epistemicStatus: row.epistemic_status,
    epistemicCaution: row.epistemic_caution,
    status: row.status,
    policyVersion: row.policy_version,
    score: row.score,
    reasons: JSON.parse(row.reasons_json) as unknown,
    operationKey: row.operation_key,
    requestFingerprint: row.request_fingerprint,
    memoryId: row.memory_id,
    sourceOrigin: row.source_origin,
    inputAdapter: row.input_adapter,
    capturePurpose: row.capture_purpose,
    recordingDate: row.recording_date,
    createdBy: row.created_by,
    admissionMethod: row.admission_method,
    cardVersion: row.card_version,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    admittedAt: row.admitted_at
  });
}

export class DailyReflectionMemoryProposalBusyError extends Error {
  readonly code = "daily_reflection_memory_proposal_busy";

  constructor() {
    super("Daily Reflection Memory Proposal is already being admitted");
  }
}

export class DailyReflectionMemoryProposalLeaseLostError extends Error {
  readonly code = "daily_reflection_memory_proposal_lease_lost";

  constructor() {
    super("Daily Reflection Memory Proposal lease was lost");
  }
}

export type DailyReflectionMemoryProposalRepositoryOptions =
  DailyReflectionRepositoryOptions & {
    sourceRepository?: DailyReflectionRepository;
  };

export class DailyReflectionMemoryProposalRepository {
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly sourceRepository: DailyReflectionRepository;

  constructor(
    private readonly database: Database.Database,
    options: DailyReflectionMemoryProposalRepositoryOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
    this.sourceRepository = options.sourceRepository
      ?? createDailyReflectionRepository(database, options);
  }

  private findRow(accountId: string, proposalId: string) {
    return this.database.prepare(`
      SELECT * FROM dr_memory_proposals WHERE account_id = ? AND id = ?
    `).get(accountId, proposalId) as ProposalRow | undefined;
  }

  private findRowByCard(accountId: string, cardId: string) {
    return this.database.prepare(`
      SELECT * FROM dr_memory_proposals WHERE account_id = ? AND card_id = ?
    `).get(accountId, cardId) as ProposalRow | undefined;
  }

  private requireRow(accountId: string, proposalId: string) {
    const row = this.findRow(accountId, proposalId);
    if (!row) throw new DailyReflectionNotFoundError();
    return row;
  }

  private recordEvent(input: {
    row: ProposalRow;
    eventType: "created" | "evaluated" | "admission_started" | "admission_failed" | "admitted" | "recovered" | "revoked";
    reasonCode?: string | null;
    errorCode?: string | null;
    attemptVersion?: number;
    createdAt: string;
  }) {
    const reasonMetadata = {
      ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.attemptVersion === undefined ? {} : { attemptVersion: input.attemptVersion })
    };
    this.database.prepare(`
      INSERT INTO dr_memory_proposal_events (
        id, account_id, proposal_id, proposal_version, event_type,
        reason_metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.idFactory(),
      input.row.account_id,
      input.row.id,
      input.row.version,
      input.eventType,
      JSON.stringify(reasonMetadata),
      input.createdAt
    );
  }

  get(accountId: string, proposalId: string) {
    const identity = ProposalIdentitySchema.parse({ accountId, proposalId });
    return proposalFromRow(this.requireRow(identity.accountId, identity.proposalId));
  }

  getByCard(accountId: string, cardId: string) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedCardId = DailyReflectionIdSchema.parse(cardId);
    const row = this.findRowByCard(parsedAccountId, parsedCardId);
    return row ? proposalFromRow(row) : null;
  }

  list(rawInput: {
    accountId: string;
    status?: DailyReflectionMemoryProposal["status"];
    limit?: number;
    offset?: number;
  }) {
    const input = z.object({
      accountId: DailyReflectionIdSchema,
      status: DailyReflectionMemoryProposalStatusSchema.optional(),
      limit: z.number().int().min(1).max(100).default(24),
      offset: z.number().int().min(0).max(100_000).default(0)
    }).strict().parse(rawInput);
    const where = input.status ? "account_id = ? AND status = ?" : "account_id = ?";
    const values = input.status ? [input.accountId, input.status] : [input.accountId];
    const total = (this.database.prepare(`
      SELECT count(*) AS count FROM dr_memory_proposals WHERE ${where}
    `).get(...values) as { count: number }).count;
    const rows = this.database.prepare(`
      SELECT * FROM dr_memory_proposals
      WHERE ${where}
      ORDER BY updated_at DESC, id ASC
      LIMIT ? OFFSET ?
    `).all(...values, input.limit, input.offset) as ProposalRow[];
    return {
      proposals: rows.map(proposalFromRow),
      total,
      limit: input.limit,
      offset: input.offset
    };
  }

  create(rawInput: {
    accountId: string;
    cardId: string;
    expectedCardVersion: number;
    memoryType: DailyReflectionMemoryProposal["memoryType"];
  }) {
    const input = CreateProposalInputSchema.parse(rawInput);
    const existing = this.findRowByCard(input.accountId, input.cardId);
    if (existing) {
      if (
        existing.card_version !== input.expectedCardVersion
        || existing.memory_type !== input.memoryType
      ) {
        throw new DailyReflectionConflictError(
          "daily_reflection_memory_proposal_idempotency_conflict"
        );
      }
      return { proposal: proposalFromRow(existing), reused: true };
    }

    const detail = this.sourceRepository.getWorkingCardWithEvidence(
      input.accountId,
      input.cardId
    );
    const card = detail.card;
    if (card.version !== input.expectedCardVersion) {
      throw new DailyReflectionVersionConflictError(card.version);
    }
    if (card.status !== "saved") {
      throw new DailyReflectionConflictError("daily_reflection_memory_proposal_card_ineligible");
    }
    if (card.sourceUnavailable || detail.evidence.length === 0) {
      throw new DailyReflectionConflictError(
        "daily_reflection_memory_proposal_evidence_unavailable"
      );
    }
    if (card.sourceReflectionIds.length !== 1) {
      throw new DailyReflectionConflictError(
        "daily_reflection_memory_proposal_mixed_source_unsupported"
      );
    }
    const reflectionId = card.sourceReflectionIds[0]!;
    const reflection = this.sourceRepository.getReflection(input.accountId, reflectionId);
    if (reflection.status !== "completed") {
      throw new DailyReflectionConflictError(
        "daily_reflection_memory_proposal_reflection_not_completed"
      );
    }
    const confirmation = ReflectionConfirmationV2Schema.safeParse(
      this.sourceRepository.getConfirmation(input.accountId, reflectionId)
    );
    if (!confirmation.success || confirmation.data.saveIntent !== "recap_only") {
      throw new DailyReflectionConflictError(
        "daily_reflection_memory_proposal_requires_recap_only"
      );
    }
    const plan = ProcessingPlanV2Schema.safeParse(
      this.sourceRepository.getProcessingPlan(input.accountId, reflectionId)
    );
    const reflectionInput = this.sourceRepository.getReflectionV2Input(
      input.accountId,
      reflectionId
    );
    const upload = AudioUploadSchema.safeParse(this.sourceRepository.readPublishedAsset({
      accountId: input.accountId,
      reflectionId,
      assetKind: "upload"
    }));
    if (
      !plan.success
      || !reflectionInput
      || !upload.success
      || reflection.uploadId !== plan.data.uploadId
      || upload.data.id !== plan.data.uploadId
      || reflectionInput.sourceOrigin !== plan.data.sourceOrigin
      || reflectionInput.inputAdapter !== plan.data.inputAdapter
      || reflectionInput.capturePurpose !== plan.data.capturePurpose
      || reflectionInput.recordingDate !== upload.data.recordingDate
    ) {
      throw new DailyReflectionConflictError(
        "daily_reflection_memory_proposal_source_contract_invalid"
      );
    }
    const canonical = parseDailyReflectionCanonicalTranscript(
      this.sourceRepository.readPublishedAsset({
        accountId: input.accountId,
        reflectionId,
        assetKind: "segments"
      }),
      upload.data.id
    );
    const canonicalById = new Map(canonical?.map((segment) => [segment.id, segment]) ?? []);
    const evidenceSegments = card.evidenceIds.map((id) => canonicalById.get(id));
    if (
      !canonical
      || evidenceSegments.some((segment) => !segment)
      || evidenceSegments.some((segment, index) => {
        const detailEvidence = detail.evidence[index];
        return !segment
          || !detailEvidence
          || detailEvidence.sourceSegmentId !== segment.id
          || detailEvidence.uploadId !== segment.uploadId
          || detailEvidence.startSeconds !== segment.startSeconds
          || detailEvidence.endSeconds !== segment.endSeconds
          || detailEvidence.text !== segment.text;
      })
    ) {
      throw new DailyReflectionConflictError(
        "daily_reflection_memory_proposal_evidence_unavailable"
      );
    }
    const reflectionCard = this.sourceRepository
      .listReflectionCards(input.accountId, reflectionId)
      .find((item) => item.id === card.id);
    if (!reflectionCard) {
      throw new DailyReflectionConflictError(
        "daily_reflection_memory_proposal_card_snapshot_missing"
      );
    }
    const candidate = this.sourceRepository
      .listCandidates(input.accountId, reflectionId)
      .find((item) => item.id === card.id);
    const subjectPersonId = candidate?.subjectConfirmed ? candidate.subjectPersonId : null;
    const actionClaimed = card.cardKind === "action"
      && reflectionCard.cardKind === "user_action"
      && reflectionCard.actionClaimed;
    const epistemicCaution = reflectionCard.epistemicStatus === "reported_event"
      && reflectionCard.riskFlags.includes("attribution_uncertain")
      ? "reported_inference" as const
      : null;
    const snapshots = evidenceSegments.map((segment) => ({
      sourceSegmentId: segment!.id,
      uploadId: segment!.uploadId,
      startSeconds: segment!.startSeconds,
      endSeconds: segment!.endSeconds,
      effectiveOrigin: plan.data.sourceOrigin,
      contentDigest: fingerprint({
        id: segment!.id,
        uploadId: segment!.uploadId,
        startSeconds: segment!.startSeconds,
        endSeconds: segment!.endSeconds,
        speaker: segment!.speaker ?? null,
        identity: segment!.identity ?? null,
        text: segment!.text,
        confidence: segment!.confidence,
        sceneLabels: segment!.sceneLabels,
        valueLabels: segment!.valueLabels
      })
    }));
    const operationKey = `daily-reflection-card:${card.id}`;
    const requestFingerprint = fingerprint({
      version: 1,
      accountId: input.accountId,
      cardId: card.id,
      reflectionId,
      cardVersion: card.version,
      title: card.title,
      content: card.content,
      cardKind: card.cardKind,
      actionClaimed,
      memoryType: input.memoryType,
      evidenceSegments: snapshots,
      importance: card.importance,
      durability: reflectionCard.durability,
      novelty: card.novelty,
      riskFlags: reflectionCard.riskFlags,
      subjectPersonId,
      epistemicStatus: reflectionCard.epistemicStatus,
      epistemicCaution,
      sourceOrigin: plan.data.sourceOrigin,
      inputAdapter: plan.data.inputAdapter,
      capturePurpose: plan.data.capturePurpose,
      recordingDate: upload.data.recordingDate
    });
    const now = this.now();
    const proposalId = stableProposalId(input.accountId, input.cardId);
    const insert = this.database.transaction(() => {
      const replay = this.findRowByCard(input.accountId, input.cardId);
      if (replay) {
        if (replay.request_fingerprint !== requestFingerprint) {
          throw new DailyReflectionConflictError(
            "daily_reflection_memory_proposal_idempotency_conflict"
          );
        }
        return { proposal: proposalFromRow(replay), reused: true };
      }
      this.database.prepare(`
        INSERT INTO dr_memory_proposals (
          id, account_id, card_id, reflection_id, title, card_kind,
          action_claimed, memory_type, content, evidence_ids_json,
          evidence_snapshots_json, risk_flags_json, subject_person_id,
          importance, durability, novelty, sensitivity, epistemic_status,
          epistemic_caution, status, policy_version, score, reasons_json,
          operation_key, request_fingerprint, memory_id, source_origin,
          input_adapter, capture_purpose, recording_date, created_by,
          admission_method, card_version, version, lease_owner, lease_until,
          attempt_version, error_code, created_at, updated_at, admitted_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'pending', ?, 0, '[]', ?, ?, NULL, ?, ?, ?, ?, 'user',
          'daily_reflection_memory_proposal_v1', ?, 0, NULL, NULL, 0, NULL,
          ?, ?, NULL
        )
      `).run(
        proposalId,
        input.accountId,
        input.cardId,
        reflectionId,
        card.title,
        card.cardKind,
        actionClaimed ? 1 : 0,
        input.memoryType,
        card.content,
        JSON.stringify(card.evidenceIds),
        JSON.stringify(snapshots),
        JSON.stringify(reflectionCard.riskFlags),
        subjectPersonId,
        card.importance,
        reflectionCard.durability,
        card.novelty,
        reflectionCard.riskFlags.includes("sensitive") ? 1 : 0,
        reflectionCard.epistemicStatus,
        epistemicCaution,
        UNASSESSED_POLICY_VERSION,
        operationKey,
        requestFingerprint,
        plan.data.sourceOrigin,
        plan.data.inputAdapter,
        plan.data.capturePurpose,
        upload.data.recordingDate,
        card.version,
        now,
        now
      );
      const row = this.requireRow(input.accountId, proposalId);
      this.recordEvent({ row, eventType: "created", createdAt: now });
      return { proposal: proposalFromRow(row), reused: false };
    });
    return insert.immediate();
  }

  evaluate(rawInput: {
    accountId: string;
    proposalId: string;
    expectedVersion: number;
    decision: "approved" | "rejected";
    policyVersion: string;
    score: number;
    reasons: string[];
  }) {
    const input = PolicyDecisionInputSchema.parse(rawInput);
    const run = this.database.transaction(() => {
      const current = this.requireRow(input.accountId, input.proposalId);
      if (current.status === "admitted") {
        throw new DailyReflectionConflictError(
          "daily_reflection_memory_proposal_already_admitted"
        );
      }
      const stableReasons = [...new Set(input.reasons)].sort();
      const existingReasons = z.array(z.string()).parse(JSON.parse(current.reasons_json));
      if (current.status === input.decision) {
        if (
          current.policy_version === input.policyVersion
          && current.score === input.score
          && JSON.stringify(existingReasons) === JSON.stringify(stableReasons)
        ) {
          return { proposal: proposalFromRow(current), reused: true };
        }
        throw new DailyReflectionConflictError(
          "daily_reflection_memory_proposal_policy_conflict"
        );
      }
      if (current.status !== "pending") {
        throw new DailyReflectionConflictError(
          "daily_reflection_memory_proposal_policy_conflict"
        );
      }
      if (current.version !== input.expectedVersion) {
        throw new DailyReflectionVersionConflictError(current.version);
      }
      const now = this.now();
      const updated = this.database.prepare(`
        UPDATE dr_memory_proposals
        SET status = ?, policy_version = ?, score = ?, reasons_json = ?,
            version = version + 1, updated_at = ?, error_code = NULL
        WHERE account_id = ? AND id = ? AND version = ? AND status = 'pending'
      `).run(
        input.decision,
        input.policyVersion,
        input.score,
        JSON.stringify(stableReasons),
        now,
        input.accountId,
        input.proposalId,
        input.expectedVersion
      );
      if (updated.changes !== 1) {
        throw new DailyReflectionVersionConflictError(
          this.requireRow(input.accountId, input.proposalId).version
        );
      }
      const row = this.requireRow(input.accountId, input.proposalId);
      this.recordEvent({
        row,
        eventType: "evaluated",
        reasonCode: stableReasons[0] ?? null,
        createdAt: now
      });
      return { proposal: proposalFromRow(row), reused: false };
    });
    return run.immediate();
  }

  startAdmission(input: {
    accountId: string;
    proposalId: string;
    leaseOwner: string;
    leaseDurationMs: number;
    now?: string;
  }) {
    const parsed = z.object({
      accountId: DailyReflectionIdSchema,
      proposalId: DailyReflectionIdSchema,
      leaseOwner: z.string().trim().min(1).max(512),
      leaseDurationMs: z.number().int().positive().max(15 * 60_000),
      now: z.string().datetime().optional()
    }).strict().parse(input);
    const run = this.database.transaction(() => {
      const current = this.requireRow(parsed.accountId, parsed.proposalId);
      if (current.status === "admitted" || current.status === "rejected") {
        return { proposal: proposalFromRow(current), executionFence: null };
      }
      if (current.status !== "approved") {
        throw new DailyReflectionConflictError(
          "daily_reflection_memory_proposal_not_approved"
        );
      }
      const now = parsed.now ?? this.now();
      const cardLifecycle = this.database.prepare(`
        SELECT memory_lifecycle_status
        FROM dr_working_cards
        WHERE account_id = ? AND id = ?
      `).get(parsed.accountId, current.card_id) as
        { memory_lifecycle_status: string } | undefined;
      if (
        !cardLifecycle
        || cardLifecycle.memory_lifecycle_status === "revocation_requested"
        || cardLifecycle.memory_lifecycle_status === "revoked"
      ) {
        throw new DailyReflectionConflictError(
          "daily_reflection_card_memory_revocation_requested"
        );
      }
      if (
        current.lease_owner
        && current.lease_until
        && current.lease_until > now
      ) {
        throw new DailyReflectionMemoryProposalBusyError();
      }
      const leaseUntil = new Date(
        Date.parse(now) + parsed.leaseDurationMs
      ).toISOString();
      const updated = this.database.prepare(`
        UPDATE dr_memory_proposals
        SET lease_owner = ?, lease_until = ?, attempt_version = attempt_version + 1,
            version = version + 1, updated_at = ?, error_code = NULL
        WHERE account_id = ? AND id = ? AND status = 'approved'
          AND (lease_owner IS NULL OR lease_until <= ?)
          AND EXISTS (
            SELECT 1 FROM dr_working_cards card
            WHERE card.account_id = dr_memory_proposals.account_id
              AND card.id = dr_memory_proposals.card_id
              AND card.memory_lifecycle_status NOT IN (
                'revocation_requested', 'revoked'
              )
          )
      `).run(
        parsed.leaseOwner,
        leaseUntil,
        now,
        parsed.accountId,
        parsed.proposalId,
        now
      );
      if (updated.changes !== 1) throw new DailyReflectionMemoryProposalBusyError();
      const row = this.requireRow(parsed.accountId, parsed.proposalId);
      this.recordEvent({
        row,
        eventType: "admission_started",
        attemptVersion: row.attempt_version,
        createdAt: now
      });
      return {
        proposal: proposalFromRow(row),
        executionFence: {
          leaseOwner: parsed.leaseOwner,
          leaseUntil,
          attemptVersion: row.attempt_version
        } satisfies DailyReflectionMemoryProposalExecutionFence
      };
    });
    return run.immediate();
  }

  completeAdmission(input: {
    accountId: string;
    proposalId: string;
    leaseOwner: string;
    attemptVersion: number;
    memoryId: string;
    recovered?: boolean;
    now?: string;
  }) {
    const parsed = z.object({
      accountId: DailyReflectionIdSchema,
      proposalId: DailyReflectionIdSchema,
      leaseOwner: z.string().trim().min(1).max(512),
      attemptVersion: z.number().int().positive(),
      memoryId: DailyReflectionIdSchema,
      recovered: z.boolean().default(false),
      now: z.string().datetime().optional()
    }).strict().parse(input);
    const run = this.database.transaction(() => {
      const current = this.requireRow(parsed.accountId, parsed.proposalId);
      if (current.status === "admitted") {
        if (current.memory_id !== parsed.memoryId) {
          throw new DailyReflectionConflictError(
            "daily_reflection_memory_proposal_memory_conflict"
          );
        }
        return { proposal: proposalFromRow(current), reused: true };
      }
      const now = parsed.now ?? this.now();
      const updated = this.database.prepare(`
        UPDATE dr_memory_proposals
        SET status = 'admitted', memory_id = ?, admitted_at = ?,
            lease_owner = NULL, lease_until = NULL, error_code = NULL,
            version = version + 1, updated_at = ?
        WHERE account_id = ? AND id = ? AND status = 'approved'
          AND lease_owner = ? AND attempt_version = ? AND lease_until > ?
          AND EXISTS (
            SELECT 1 FROM dr_working_cards card
            WHERE card.account_id = dr_memory_proposals.account_id
              AND card.id = dr_memory_proposals.card_id
              AND card.memory_lifecycle_status NOT IN (
                'revocation_requested', 'revoked'
              )
          )
      `).run(
        parsed.memoryId,
        now,
        now,
        parsed.accountId,
        parsed.proposalId,
        parsed.leaseOwner,
        parsed.attemptVersion,
        now
      );
      if (updated.changes !== 1) {
        throw new DailyReflectionMemoryProposalLeaseLostError();
      }
      const row = this.requireRow(parsed.accountId, parsed.proposalId);
      this.database.prepare(`
        UPDATE dr_working_cards
        SET memory_lifecycle_status = 'active',
            memory_lifecycle_version = memory_lifecycle_version + 1,
            memory_lifecycle_updated_at = ?
        WHERE account_id = ? AND id = ?
          AND memory_lifecycle_status IN ('not_admitted', 'active')
      `).run(now, parsed.accountId, row.card_id);
      this.recordEvent({
        row,
        eventType: parsed.recovered ? "recovered" : "admitted",
        attemptVersion: parsed.attemptVersion,
        createdAt: now
      });
      return { proposal: proposalFromRow(row), reused: false };
    });
    return run.immediate();
  }

  failAdmission(input: {
    accountId: string;
    proposalId: string;
    leaseOwner: string;
    attemptVersion: number;
    errorCode: string;
    now?: string;
  }) {
    const parsed = z.object({
      accountId: DailyReflectionIdSchema,
      proposalId: DailyReflectionIdSchema,
      leaseOwner: z.string().trim().min(1).max(512),
      attemptVersion: z.number().int().positive(),
      errorCode: z.string().trim().min(1).max(128)
        .regex(/^[a-z0-9][a-z0-9_.:-]*$/u),
      now: z.string().datetime().optional()
    }).strict().parse(input);
    const run = this.database.transaction(() => {
      const now = parsed.now ?? this.now();
      const updated = this.database.prepare(`
        UPDATE dr_memory_proposals
        SET lease_owner = NULL, lease_until = NULL, error_code = ?,
            version = version + 1, updated_at = ?
        WHERE account_id = ? AND id = ? AND status = 'approved'
          AND lease_owner = ? AND attempt_version = ? AND lease_until > ?
      `).run(
        parsed.errorCode,
        now,
        parsed.accountId,
        parsed.proposalId,
        parsed.leaseOwner,
        parsed.attemptVersion,
        now
      );
      if (updated.changes !== 1) {
        throw new DailyReflectionMemoryProposalLeaseLostError();
      }
      const row = this.requireRow(parsed.accountId, parsed.proposalId);
      this.recordEvent({
        row,
        eventType: "admission_failed",
        errorCode: parsed.errorCode,
        attemptVersion: parsed.attemptVersion,
        createdAt: now
      });
      return proposalFromRow(row);
    });
    return run.immediate();
  }

  reject(input: {
    accountId: string;
    proposalId: string;
    reason: string;
  }) {
    const parsed = z.object({
      accountId: DailyReflectionIdSchema,
      proposalId: DailyReflectionIdSchema,
      reason: z.string().trim().min(1).max(256)
    }).strict().parse(input);
    const run = this.database.transaction(() => {
      const current = this.requireRow(parsed.accountId, parsed.proposalId);
      if (current.status === "rejected") return proposalFromRow(current);
      if (current.status === "admitted") {
        throw new DailyReflectionConflictError(
          "daily_reflection_memory_proposal_already_admitted"
        );
      }
      const now = this.now();
      if (current.lease_owner && current.lease_until && current.lease_until > now) {
        throw new DailyReflectionMemoryProposalBusyError();
      }
      this.database.prepare(`
        UPDATE dr_memory_proposals
        SET status = 'rejected', reasons_json = ?, lease_owner = NULL,
            lease_until = NULL, version = version + 1, updated_at = ?
        WHERE account_id = ? AND id = ? AND status IN ('pending', 'approved')
      `).run(
        JSON.stringify([parsed.reason]),
        now,
        parsed.accountId,
        parsed.proposalId
      );
      const row = this.requireRow(parsed.accountId, parsed.proposalId);
      this.recordEvent({
        row,
        eventType: "evaluated",
        reasonCode: parsed.reason,
        createdAt: now
      });
      return proposalFromRow(row);
    });
    return run.immediate();
  }

  getAdmissionSource(accountId: string, proposalId: string): DailyReflectionMemoryProposalSource {
    const identity = ProposalIdentitySchema.parse({ accountId, proposalId });
    const row = this.requireRow(identity.accountId, identity.proposalId);
    const proposal = proposalFromRow(row);
    const snapshots = parseSnapshots(row);
    let sourceInvalidReason: string | null = null;
    let currentSegments: TranscriptSegment[] | null = null;
    let currentById = new Map<string, TranscriptSegment>();
    try {
      const card = this.sourceRepository.getWorkingCard(identity.accountId, proposal.cardId);
      const reflection = this.sourceRepository.getReflection(
        identity.accountId,
        proposal.reflectionId
      );
      const plan = ProcessingPlanV2Schema.safeParse(
        this.sourceRepository.getProcessingPlan(identity.accountId, proposal.reflectionId)
      );
      const confirmation = ReflectionConfirmationV2Schema.safeParse(
        this.sourceRepository.getConfirmation(identity.accountId, proposal.reflectionId)
      );
      currentSegments = parseDailyReflectionCanonicalTranscript(
        this.sourceRepository.readPublishedAsset({
          accountId: identity.accountId,
          reflectionId: proposal.reflectionId,
          assetKind: "segments"
        }),
        snapshots[0]!.uploadId
      );
      currentById = new Map(currentSegments?.map((item) => [item.id, item]) ?? []);
      if (
        card.status !== "saved"
        || card.sourceUnavailable
        || card.version !== proposal.cardVersion
        || card.title !== proposal.title
        || card.content !== proposal.content
        || card.cardKind !== proposal.cardKind
        || JSON.stringify(card.evidenceIds) !== JSON.stringify(proposal.evidenceIds)
        || reflection.status !== "completed"
        || !plan.success
        || plan.data.sourceOrigin !== proposal.sourceOrigin
        || plan.data.inputAdapter !== proposal.inputAdapter
        || plan.data.capturePurpose !== proposal.capturePurpose
        || !confirmation.success
        || confirmation.data.saveIntent !== "recap_only"
        || !currentSegments
        || snapshots.some((snapshot) => {
          const current = currentById.get(snapshot.sourceSegmentId);
          return !current || !sameCanonicalSegment(current, snapshot);
        })
      ) {
        sourceInvalidReason = "daily_reflection_memory_proposal_source_changed";
      }
    } catch {
      sourceInvalidReason = "daily_reflection_memory_proposal_source_unavailable";
    }
    const upload = AudioUploadSchema.safeParse(this.sourceRepository.readPublishedAsset({
      accountId: identity.accountId,
      reflectionId: proposal.reflectionId,
      assetKind: "upload"
    }));
    if (
      !upload.success
      || upload.data.id !== snapshots[0]!.uploadId
      || upload.data.recordingDate !== proposal.recordingDate
    ) {
      sourceInvalidReason = "daily_reflection_memory_proposal_source_unavailable";
    }
    return {
      proposal,
      evidenceSegments: snapshots.flatMap((snapshot) => {
        const current = currentById.get(snapshot.sourceSegmentId);
        return current ? [{ ...current, effectiveOrigin: snapshot.effectiveOrigin }] : [];
      }),
      sourceSegments: currentSegments ?? [],
      upload: upload.success ? upload.data : null,
      sourceValid: sourceInvalidReason === null,
      sourceInvalidReason
    };
  }

  hasActiveAdmissionLease(accountId: string, cardId: string, at = this.now()) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedCardId = DailyReflectionIdSchema.parse(cardId);
    return Boolean(this.database.prepare(`
      SELECT 1 FROM dr_memory_proposals
      WHERE account_id = ? AND card_id = ? AND status = 'approved'
        AND lease_owner IS NOT NULL AND lease_until > ?
    `).get(parsedAccountId, parsedCardId, at));
  }

  listEvents(accountId: string, proposalId: string) {
    const identity = ProposalIdentitySchema.parse({ accountId, proposalId });
    this.requireRow(identity.accountId, identity.proposalId);
    return this.database.prepare(`
      SELECT id, proposal_id, account_id, proposal_version, event_type,
             reason_metadata_json, created_at
      FROM dr_memory_proposal_events
      WHERE account_id = ? AND proposal_id = ?
      ORDER BY created_at, id
    `).all(identity.accountId, identity.proposalId) as Array<{
      id: string;
      proposal_id: string;
      account_id: string;
      proposal_version: number;
      event_type: string;
      reason_metadata_json: string;
      created_at: string;
    }>;
  }
}

export function createDailyReflectionMemoryProposalRepository(
  database: Database.Database,
  options: DailyReflectionMemoryProposalRepositoryOptions = {}
) {
  return new DailyReflectionMemoryProposalRepository(database, options);
}

export function isDailyReflectionMemoryProposalFingerprint(value: string) {
  return HASH_PATTERN.test(value);
}
