import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import {
  TranscriptSegmentSchema,
  type TranscriptSegment
} from "@/lib/domain/types";

import {
  MemoryOwnerResolutionSchema,
  type MemoryOwnerResolution
} from "./owner-attribution/types";
import { createMemoryRepository } from "./repository";
import {
  MemoryWriteInputSchema,
  type MemoryRepository,
  type MemoryWriteInput
} from "./types";

export type DailyReflectionProposalAdmissionErrorCode =
  | "daily_reflection_proposal_conflict"
  | "daily_reflection_proposal_upload_deleted"
  | "daily_reflection_proposal_evidence_missing"
  | "daily_reflection_proposal_person_forbidden";

export class DailyReflectionProposalAdmissionError extends Error {
  constructor(readonly code: DailyReflectionProposalAdmissionErrorCode) {
    super(code);
    this.name = "DailyReflectionProposalAdmissionError";
  }
}

export type DailyReflectionProposalEvidenceDigest = {
  memoryEvidenceId: string;
  sourceSegmentId: string;
  contentDigest: string;
};

export type DailyReflectionProposalAdmissionInput = {
  userId: string;
  reflectionId: string;
  proposalId: string;
  cardId: string;
  operationKey: string;
  payloadDigest: string;
  publicationId: string;
  publicationFingerprint: string;
  publicationDigest: string;
  uploadId: string;
  sourceOrigin: "user_reflection" | "direct_conversation";
  inputAdapter: "file_picker" | "browser_recorder" | "toy_sync";
  capturePurpose: "inspiration_capture";
  recordingDate: string;
  memory: MemoryWriteInput;
  ownerAttribution: MemoryOwnerResolution;
  evidenceDigests: DailyReflectionProposalEvidenceDigest[];
  sourceSegments: TranscriptSegment[];
  personId?: string | null;
  subjectPersonId?: string | null;
  now: string;
};

export type DailyReflectionProposalAdmissionResult = {
  status: "admitted" | "already_exists";
  userId: string;
  reflectionId: string;
  publicationId: string;
  publicationStatus: "unpublished" | "published";
  proposalId: string;
  cardId: string;
  operationKey: string;
  payloadDigest: string;
  memoryId: string;
};

export type DailyReflectionProposalProvenance = {
  memoryEvidenceId: string;
  userId: string;
  publicationId: string;
  reflectionId: string;
  proposalId: string;
  cardId: string;
  uploadId: string;
  sourceSegmentId: string;
  sourceOrigin: "user_reflection" | "direct_conversation";
  contentDigest: string;
  createdAt: string;
};

type PublicationRow = {
  id: string;
  user_id: string;
  reflection_id: string;
  confirmation_id: string;
  upload_id: string;
  confirmation_fingerprint: string;
  payload_digest: string;
  effective_source_origin: "user_reflection" | "direct_conversation";
  content_kind: "user_confirmed_derived_content";
  contract_version: 1 | 2;
  save_intent: "retain_selected";
  input_adapter: "file_picker" | "browser_recorder" | "toy_sync" | null;
  capture_purpose: "inspiration_capture" | null;
  recording_date: string | null;
  status: "unpublished" | "published" | "deleted";
};

type PayloadRow = {
  confirmation_id: string;
  candidate_id: string;
  memory_json: string;
  owner_attribution_json: string;
  subject_person_id: string | null;
  payload_digest: string;
};

type RecoveryRow = PayloadRow & {
  user_id: string;
  reflection_id: string;
  publication_id: string;
  publication_status: "unpublished" | "published" | "deleted";
  operation_key: string;
  receipt_status: "admitted" | "rejected";
  receipt_memory_id: string | null;
  receipt_reason_code: string | null;
  current_status: "active" | "revoked" | null;
  current_memory_id: string | null;
};

type ProvenanceRow = {
  memory_evidence_id: string;
  user_id: string;
  publication_id: string;
  reflection_id: string;
  confirmation_id: string;
  candidate_id: string;
  upload_id: string;
  source_segment_id: string;
  effective_source_origin: "user_reflection" | "direct_conversation";
  content_digest: string;
  created_at: string;
};

type NormalizedInput = Omit<
  DailyReflectionProposalAdmissionInput,
  "memory" | "ownerAttribution" | "sourceSegments"
> & {
  memory: ReturnType<typeof MemoryWriteInputSchema.parse>;
  ownerAttribution: ReturnType<typeof MemoryOwnerResolutionSchema.parse>;
  sourceSegments: TranscriptSegment[];
};

function conflict(): never {
  throw new DailyReflectionProposalAdmissionError(
    "daily_reflection_proposal_conflict"
  );
}

function requiredIdentifier(value: string) {
  if (typeof value !== "string") conflict();
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) conflict();
  return normalized;
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function normalizeInput(
  raw: DailyReflectionProposalAdmissionInput
): NormalizedInput {
  if (raw.personId !== undefined && raw.personId !== null) {
    throw new DailyReflectionProposalAdmissionError(
      "daily_reflection_proposal_person_forbidden"
    );
  }
  if (raw.subjectPersonId !== undefined && raw.subjectPersonId !== null) {
    throw new DailyReflectionProposalAdmissionError(
      "daily_reflection_proposal_person_forbidden"
    );
  }
  if (raw.capturePurpose !== "inspiration_capture") conflict();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.recordingDate)) conflict();
  if (!Number.isFinite(Date.parse(raw.now))) conflict();

  const input = {
    ...raw,
    userId: requiredIdentifier(raw.userId),
    reflectionId: requiredIdentifier(raw.reflectionId),
    proposalId: requiredIdentifier(raw.proposalId),
    cardId: requiredIdentifier(raw.cardId),
    operationKey: requiredIdentifier(raw.operationKey),
    payloadDigest: requiredIdentifier(raw.payloadDigest),
    publicationId: requiredIdentifier(raw.publicationId),
    publicationFingerprint: requiredIdentifier(raw.publicationFingerprint),
    publicationDigest: requiredIdentifier(raw.publicationDigest),
    uploadId: requiredIdentifier(raw.uploadId),
    memory: MemoryWriteInputSchema.parse(raw.memory),
    ownerAttribution: MemoryOwnerResolutionSchema.parse(raw.ownerAttribution),
    evidenceDigests: raw.evidenceDigests.map((evidenceDigest) => ({
      memoryEvidenceId: requiredIdentifier(evidenceDigest.memoryEvidenceId),
      sourceSegmentId: requiredIdentifier(evidenceDigest.sourceSegmentId),
      contentDigest: requiredIdentifier(evidenceDigest.contentDigest)
    })),
    sourceSegments: raw.sourceSegments.map((segment) =>
      TranscriptSegmentSchema.parse(segment)
    )
  } satisfies NormalizedInput;

  if (
    input.ownerAttribution.memoryId !== input.memory.id
    || input.ownerAttribution.memoryType !== input.memory.type
  ) {
    conflict();
  }
  if (input.operationKey !== `daily-reflection-card:${input.cardId}`) {
    conflict();
  }

  const segmentById = new Map<string, TranscriptSegment>();
  for (const segment of input.sourceSegments) {
    if (segment.uploadId !== input.uploadId || segmentById.has(segment.id)) {
      conflict();
    }
    segmentById.set(segment.id, segment);
  }

  const transcriptEvidence = new Map(
    input.memory.evidence
      .filter((evidence) => evidence.sourceType === "transcript")
      .map((evidence) => [evidence.id, evidence] as const)
  );
  if (transcriptEvidence.size === 0 || input.evidenceDigests.length === 0) {
    throw new DailyReflectionProposalAdmissionError(
      "daily_reflection_proposal_evidence_missing"
    );
  }

  const digestEvidenceIds = new Set<string>();
  const digestSourceIds = new Set<string>();
  for (const evidenceDigest of input.evidenceDigests) {
    if (
      digestEvidenceIds.has(evidenceDigest.memoryEvidenceId)
      || digestSourceIds.has(evidenceDigest.sourceSegmentId)
    ) {
      conflict();
    }
    digestEvidenceIds.add(evidenceDigest.memoryEvidenceId);
    digestSourceIds.add(evidenceDigest.sourceSegmentId);
    const memoryEvidence = transcriptEvidence.get(evidenceDigest.memoryEvidenceId);
    const sourceSegment = segmentById.get(evidenceDigest.sourceSegmentId);
    if (
      !memoryEvidence
      || memoryEvidence.sourceId !== evidenceDigest.sourceSegmentId
      || memoryEvidence.uploadId !== input.uploadId
      || !sourceSegment
      || memoryEvidence.quote !== sourceSegment.text.slice(0, 4_000)
      || evidenceDigest.contentDigest !== digest({
        version: 1,
        accountId: input.userId,
        reflectionId: input.reflectionId,
        uploadId: input.uploadId,
        sourceSegmentId: evidenceDigest.sourceSegmentId,
        quote: memoryEvidence.quote,
        sourceOrigin: input.sourceOrigin
      })
    ) {
      throw new DailyReflectionProposalAdmissionError(
        "daily_reflection_proposal_evidence_missing"
      );
    }
  }

  const transcriptSourceIds = new Set(
    [...transcriptEvidence.values()].map((evidence) => evidence.sourceId)
  );
  if (
    digestEvidenceIds.size !== transcriptEvidence.size
    || digestSourceIds.size !== transcriptSourceIds.size
    || [...transcriptEvidence.keys()].some((id) => !digestEvidenceIds.has(id))
    || [...transcriptSourceIds].some((id) => !digestSourceIds.has(id))
  ) {
    throw new DailyReflectionProposalAdmissionError(
      "daily_reflection_proposal_evidence_missing"
    );
  }

  const ownerEvidenceIds = new Set(input.ownerAttribution.evidenceSegmentIds);
  if (
    [...ownerEvidenceIds].some((segmentId) => !transcriptSourceIds.has(segmentId))
    || input.ownerAttribution.participants.some((participant) =>
      participant.evidenceSegmentIds.some(
        (segmentId) => !transcriptSourceIds.has(segmentId)
      )
    )
  ) {
    conflict();
  }
  return input;
}

function provenanceFromRow(row: ProvenanceRow): DailyReflectionProposalProvenance {
  return {
    memoryEvidenceId: row.memory_evidence_id,
    userId: row.user_id,
    publicationId: row.publication_id,
    reflectionId: row.reflection_id,
    proposalId: row.confirmation_id,
    cardId: row.candidate_id,
    uploadId: row.upload_id,
    sourceSegmentId: row.source_segment_id,
    sourceOrigin: row.effective_source_origin,
    contentDigest: row.content_digest,
    createdAt: row.created_at
  };
}

export function createDailyReflectionProposalAdmissionRepository(
  database: Database.Database,
  dependencies: {
    memoryRepository?: Pick<MemoryRepository, "replaceUploadMemories">;
  } = {}
) {
  const memoryRepository = dependencies.memoryRepository
    ?? createMemoryRepository(database);

  function getPublication(userId: string, reflectionId: string) {
    return database.prepare(`
      SELECT * FROM memory_daily_reflection_publications
      WHERE user_id = ? AND reflection_id = ?
    `).get(userId, reflectionId) as PublicationRow | undefined;
  }

  function getProvenance(input: {
    userId: string;
    proposalId: string;
    cardId: string;
  }) {
    const rows = database.prepare(`
      SELECT * FROM memory_daily_reflection_evidence_provenance
      WHERE user_id = ? AND confirmation_id = ? AND candidate_id = ?
      ORDER BY source_segment_id, memory_evidence_id
    `).all(
      requiredIdentifier(input.userId),
      requiredIdentifier(input.proposalId),
      requiredIdentifier(input.cardId)
    ) as ProvenanceRow[];
    return rows.map(provenanceFromRow);
  }

  function recoveryRow(userId: string, operationKey: string) {
    return database.prepare(`
      SELECT receipt.user_id, receipt.publication_id, receipt.operation_key,
             receipt.status AS receipt_status,
             receipt.memory_id AS receipt_memory_id,
             receipt.reason_code AS receipt_reason_code,
             publication.reflection_id,
             publication.status AS publication_status,
             payload.confirmation_id, payload.candidate_id, payload.memory_json,
             payload.owner_attribution_json, payload.subject_person_id,
             payload.payload_digest,
             current.status AS current_status,
             current.current_memory_id
      FROM memory_daily_reflection_candidate_receipts receipt
      INNER JOIN memory_daily_reflection_publications publication
        ON publication.user_id = receipt.user_id
        AND publication.id = receipt.publication_id
      INNER JOIN memory_daily_reflection_candidate_payloads payload
        ON payload.user_id = receipt.user_id
        AND payload.publication_id = receipt.publication_id
        AND payload.candidate_id = receipt.candidate_id
      LEFT JOIN memory_daily_reflection_candidate_current_memories current
        ON current.user_id = receipt.user_id
        AND current.publication_id = receipt.publication_id
        AND current.candidate_id = receipt.candidate_id
      WHERE receipt.user_id = ? AND receipt.operation_key = ?
    `).get(userId, operationKey) as RecoveryRow | undefined;
  }

  function findByOperationKey(input: { userId: string; operationKey: string }) {
    const userId = requiredIdentifier(input.userId);
    const operationKey = requiredIdentifier(input.operationKey);
    const row = recoveryRow(
      userId,
      operationKey
    );
    if (
      !row
      || row.publication_status === "deleted"
      || row.current_status !== "active"
      || !row.current_memory_id
    ) {
      return null;
    }
    const publication = getPublication(userId, row.reflection_id);
    const uploadDeleted = publication && database.prepare(`
      SELECT 1 FROM memory_upload_tombstones
      WHERE user_id = ? AND upload_id = ?
    `).get(userId, publication.upload_id);
    if (!publication || uploadDeleted) return null;
    const admitted = row.receipt_status === "admitted"
      && row.receipt_memory_id !== null
      && row.receipt_reason_code === null;
    if (!admitted) return null;
    const publicationStatus = row.publication_status;
    if (publicationStatus !== "unpublished" && publicationStatus !== "published") {
      return null;
    }
    return {
      status: "already_exists" as const,
      userId: row.user_id,
      reflectionId: row.reflection_id,
      publicationId: row.publication_id,
      publicationStatus,
      proposalId: row.confirmation_id,
      cardId: row.candidate_id,
      operationKey: row.operation_key,
      payloadDigest: row.payload_digest,
      memoryId: row.current_memory_id
    } satisfies DailyReflectionProposalAdmissionResult;
  }

  function publicationMatches(
    publication: PublicationRow,
    input: NormalizedInput
  ) {
    return publication.id === input.publicationId
      && publication.user_id === input.userId
      && publication.reflection_id === input.reflectionId
      && publication.upload_id === input.uploadId
      && publication.confirmation_fingerprint === input.publicationFingerprint
      && publication.payload_digest === input.publicationDigest
      && publication.effective_source_origin === input.sourceOrigin
      && publication.content_kind === "user_confirmed_derived_content"
      && publication.contract_version === 2
      && publication.save_intent === "retain_selected"
      && publication.input_adapter === input.inputAdapter
      && publication.capture_purpose === input.capturePurpose
      && publication.recording_date === input.recordingDate;
  }

  function exactProvenanceMatches(input: NormalizedInput) {
    const actual = getProvenance({
      userId: input.userId,
      proposalId: input.proposalId,
      cardId: input.cardId
    }).map((row) => ({
      memoryEvidenceId: row.memoryEvidenceId,
      sourceSegmentId: row.sourceSegmentId,
      contentDigest: row.contentDigest
    }));
    const expected = [...input.evidenceDigests].sort((left, right) =>
      left.sourceSegmentId.localeCompare(right.sourceSegmentId)
        || left.memoryEvidenceId.localeCompare(right.memoryEvidenceId)
    );
    return stableJson(actual) === stableJson(expected);
  }

  function replayResult(input: NormalizedInput, publication: PublicationRow) {
    const row = recoveryRow(input.userId, input.operationKey);
    if (!row) return null;
    if (publication.status === "deleted") {
      throw new DailyReflectionProposalAdmissionError(
        "daily_reflection_proposal_upload_deleted"
      );
    }
    let storedMemory: unknown;
    let storedOwner: unknown;
    try {
      storedMemory = MemoryWriteInputSchema.parse(JSON.parse(row.memory_json));
      storedOwner = MemoryOwnerResolutionSchema.parse(
        JSON.parse(row.owner_attribution_json)
      );
    } catch {
      conflict();
    }
    if (
      row.publication_id !== input.publicationId
      || row.reflection_id !== input.reflectionId
      || row.confirmation_id !== input.proposalId
      || row.candidate_id !== input.cardId
      || row.payload_digest !== input.payloadDigest
      || row.subject_person_id !== null
      || row.receipt_status !== "admitted"
      || row.receipt_memory_id === null
      || row.receipt_reason_code !== null
      || row.current_status !== "active"
      || !row.current_memory_id
      || stableJson(storedMemory) !== stableJson(input.memory)
      || stableJson(storedOwner) !== stableJson(input.ownerAttribution)
      || !exactProvenanceMatches(input)
    ) {
      conflict();
    }
    return {
      status: "already_exists" as const,
      userId: input.userId,
      reflectionId: input.reflectionId,
      publicationId: input.publicationId,
      publicationStatus: publication.status,
      proposalId: input.proposalId,
      cardId: input.cardId,
      operationKey: input.operationKey,
      payloadDigest: input.payloadDigest,
      memoryId: row.current_memory_id
    } satisfies DailyReflectionProposalAdmissionResult;
  }

  const applyProposal = database.transaction(
    (rawInput: DailyReflectionProposalAdmissionInput) => {
      const input = normalizeInput(rawInput);
      const tombstone = database.prepare(`
        SELECT 1 FROM memory_upload_tombstones
        WHERE user_id = ? AND upload_id = ?
      `).get(input.userId, input.uploadId);
      if (tombstone) {
        throw new DailyReflectionProposalAdmissionError(
          "daily_reflection_proposal_upload_deleted"
        );
      }

      const publicationForId = database.prepare(`
        SELECT * FROM memory_daily_reflection_publications WHERE id = ?
      `).get(input.publicationId) as PublicationRow | undefined;
      if (publicationForId && publicationForId.user_id !== input.userId) conflict();

      let publication = getPublication(input.userId, input.reflectionId);
      if (publication) {
        if (publication.status === "deleted") {
          throw new DailyReflectionProposalAdmissionError(
            "daily_reflection_proposal_upload_deleted"
          );
        }
        if (!publicationMatches(publication, input)) conflict();
        const replay = replayResult(input, publication);
        if (replay) return replay;
      } else {
        if (publicationForId) conflict();
        const operationConflict = database.prepare(`
          SELECT 1 FROM memory_daily_reflection_candidate_receipts
          WHERE user_id = ? AND operation_key = ?
        `).get(input.userId, input.operationKey);
        if (operationConflict) conflict();
        database.prepare(`
          INSERT INTO memory_daily_reflection_publications (
            id, user_id, reflection_id, confirmation_id, upload_id,
            confirmation_fingerprint, payload_digest, source_origin,
            effective_source_origin, content_kind, status,
            created_at, updated_at, deleted_at, contract_version, save_intent,
            input_adapter, capture_purpose, recording_date
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'user_reflection', ?,
            'user_confirmed_derived_content', 'unpublished', ?, ?, NULL,
            2, 'retain_selected', ?, ?, ?)
        `).run(
          input.publicationId,
          input.userId,
          input.reflectionId,
          input.proposalId,
          input.uploadId,
          input.publicationFingerprint,
          input.publicationDigest,
          input.sourceOrigin,
          input.now,
          input.now,
          input.inputAdapter,
          input.capturePurpose,
          input.recordingDate
        );
        publication = getPublication(input.userId, input.reflectionId)!;
      }

      const conflictingOperation = database.prepare(`
        SELECT 1 FROM memory_daily_reflection_candidate_receipts
        WHERE user_id = ? AND operation_key = ?
      `).get(input.userId, input.operationKey);
      const conflictingCard = database.prepare(`
        SELECT 1 FROM memory_daily_reflection_candidate_payloads
        WHERE user_id = ? AND publication_id = ? AND candidate_id = ?
      `).get(input.userId, input.publicationId, input.cardId);
      if (conflictingOperation || conflictingCard) conflict();

      const activePayloadRows = database.prepare(`
        SELECT payload.confirmation_id, payload.candidate_id,
               payload.memory_json, payload.owner_attribution_json,
               payload.subject_person_id, payload.payload_digest
        FROM memory_daily_reflection_candidate_payloads payload
        INNER JOIN memory_daily_reflection_candidate_current_memories current
          ON current.user_id = payload.user_id
          AND current.publication_id = payload.publication_id
          AND current.candidate_id = payload.candidate_id
          AND current.status = 'active'
        WHERE payload.user_id = ? AND payload.publication_id = ?
        ORDER BY payload.candidate_id
      `).all(input.userId, input.publicationId) as PayloadRow[];

      const activeMemories: MemoryWriteInput[] = [];
      const activeOwners: MemoryOwnerResolution[] = [];
      for (const row of activePayloadRows) {
        if (row.subject_person_id !== null) conflict();
        try {
          activeMemories.push(MemoryWriteInputSchema.parse(JSON.parse(row.memory_json)));
          activeOwners.push(
            MemoryOwnerResolutionSchema.parse(JSON.parse(row.owner_attribution_json))
          );
        } catch {
          conflict();
        }
      }
      if (activeMemories.some((memory) => memory.id === input.memory.id)) conflict();

      database.prepare(`
        INSERT INTO memory_daily_reflection_candidate_payloads (
          user_id, publication_id, reflection_id, confirmation_id, candidate_id,
          memory_json, owner_attribution_json, subject_person_id,
          payload_digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        input.userId,
        input.publicationId,
        input.reflectionId,
        input.proposalId,
        input.cardId,
        JSON.stringify(input.memory),
        JSON.stringify(input.ownerAttribution),
        input.payloadDigest,
        input.now
      );

      memoryRepository.replaceUploadMemories({
        userId: input.userId,
        uploadId: input.uploadId,
        memories: [...activeMemories, input.memory],
        ownerAttributions: [...activeOwners, input.ownerAttribution],
        sourceSegments: input.sourceSegments
      });

      const evidenceMemory = database.prepare(`
        SELECT evidence.memory_id, evidence.upload_id, evidence.source_id
        FROM memory_evidence evidence
        INNER JOIN memory_items memory
          ON memory.id = evidence.memory_id AND memory.user_id = ?
        WHERE evidence.id = ?
      `);
      const insertProvenance = database.prepare(`
        INSERT INTO memory_daily_reflection_evidence_provenance (
          memory_evidence_id, user_id, publication_id, reflection_id,
          confirmation_id, candidate_id, upload_id, source_segment_id,
          source_origin, effective_source_origin, content_kind,
          content_digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user_reflection', ?,
          'user_confirmed_derived_content', ?, ?)
      `);
      const newMemoryIds = new Set<string>();
      for (const evidenceDigest of input.evidenceDigests) {
        const evidence = evidenceMemory.get(
          input.userId,
          evidenceDigest.memoryEvidenceId
        ) as {
          memory_id: string;
          upload_id: string;
          source_id: string;
        } | undefined;
        if (
          !evidence
          || evidence.upload_id !== input.uploadId
          || evidence.source_id !== evidenceDigest.sourceSegmentId
        ) {
          throw new DailyReflectionProposalAdmissionError(
            "daily_reflection_proposal_evidence_missing"
          );
        }
        newMemoryIds.add(evidence.memory_id);
        insertProvenance.run(
          evidenceDigest.memoryEvidenceId,
          input.userId,
          input.publicationId,
          input.reflectionId,
          input.proposalId,
          input.cardId,
          input.uploadId,
          evidenceDigest.sourceSegmentId,
          input.sourceOrigin,
          evidenceDigest.contentDigest,
          input.now
        );
      }
      if (newMemoryIds.size !== 1) {
        throw new DailyReflectionProposalAdmissionError(
          "daily_reflection_proposal_evidence_missing"
        );
      }
      const memoryId = [...newMemoryIds][0]!;

      database.prepare(`
        INSERT INTO memory_daily_reflection_candidate_current_memories (
          user_id, publication_id, reflection_id, confirmation_id, candidate_id,
          status, current_memory_id, revocation_id, created_at, updated_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, NULL)
      `).run(
        input.userId,
        input.publicationId,
        input.reflectionId,
        input.proposalId,
        input.cardId,
        memoryId,
        input.now,
        input.now
      );
      database.prepare(`
        INSERT INTO memory_daily_reflection_candidate_receipts (
          user_id, publication_id, candidate_id, status, memory_id,
          reason_code, operation_key, created_at, candidate_kind, action_claimed
        ) VALUES (?, ?, ?, 'admitted', ?, NULL, ?, ?, NULL, NULL)
      `).run(
        input.userId,
        input.publicationId,
        input.cardId,
        memoryId,
        input.operationKey,
        input.now
      );

      const activeCards = database.prepare(`
        SELECT candidate_id FROM memory_daily_reflection_candidate_current_memories
        WHERE user_id = ? AND publication_id = ? AND status = 'active'
        ORDER BY candidate_id
      `).all(input.userId, input.publicationId) as Array<{ candidate_id: string }>;
      const resolveCardMemory = database.prepare(`
        SELECT DISTINCT evidence.memory_id
        FROM memory_daily_reflection_evidence_provenance provenance
        INNER JOIN memory_evidence evidence
          ON evidence.id = provenance.memory_evidence_id
        INNER JOIN memory_items memory
          ON memory.id = evidence.memory_id AND memory.user_id = provenance.user_id
        WHERE provenance.user_id = ? AND provenance.publication_id = ?
          AND provenance.candidate_id = ?
        ORDER BY evidence.memory_id
      `);
      const updateCurrentMemory = database.prepare(`
        UPDATE memory_daily_reflection_candidate_current_memories
        SET current_memory_id = ?, updated_at = ?
        WHERE user_id = ? AND publication_id = ? AND candidate_id = ?
          AND status = 'active'
      `);
      for (const activeCard of activeCards) {
        const rows = resolveCardMemory.all(
          input.userId,
          input.publicationId,
          activeCard.candidate_id
        ) as Array<{ memory_id: string }>;
        if (rows.length !== 1) {
          throw new DailyReflectionProposalAdmissionError(
            "daily_reflection_proposal_evidence_missing"
          );
        }
        updateCurrentMemory.run(
          rows[0]!.memory_id,
          input.now,
          input.userId,
          input.publicationId,
          activeCard.candidate_id
        );
      }

      return {
        status: "admitted" as const,
        userId: input.userId,
        reflectionId: input.reflectionId,
        publicationId: input.publicationId,
        publicationStatus: publication.status === "published"
          ? "published"
          : "unpublished",
        proposalId: input.proposalId,
        cardId: input.cardId,
        operationKey: input.operationKey,
        payloadDigest: input.payloadDigest,
        memoryId
      } satisfies DailyReflectionProposalAdmissionResult;
    }
  );

  const markPublished = database.transaction((input: {
    userId: string;
    reflectionId: string;
    now: string;
  }) => {
    const userId = requiredIdentifier(input.userId);
    const reflectionId = requiredIdentifier(input.reflectionId);
    const publication = getPublication(userId, reflectionId);
    if (!publication) return null;
    if (publication.status === "deleted") {
      throw new DailyReflectionProposalAdmissionError(
        "daily_reflection_proposal_upload_deleted"
      );
    }
    if (publication.status === "unpublished") {
      database.prepare(`
        UPDATE memory_daily_reflection_publications
        SET status = 'published', updated_at = ?
        WHERE id = ? AND user_id = ? AND reflection_id = ?
          AND status = 'unpublished'
      `).run(input.now, publication.id, userId, reflectionId);
    }
    return getPublication(userId, reflectionId) ?? null;
  });

  return {
    applyProposal: (input: DailyReflectionProposalAdmissionInput) =>
      applyProposal.immediate(input),
    findByOperationKey,
    getProvenance,
    getPublication,
    markPublished: (input: { userId: string; reflectionId: string; now: string }) =>
      markPublished.immediate(input)
  };
}

export type DailyReflectionProposalAdmissionRepository = ReturnType<
  typeof createDailyReflectionProposalAdmissionRepository
>;
