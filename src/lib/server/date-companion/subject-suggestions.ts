import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import {
  DcSubjectSuggestionBatchSchema,
  DcSubjectSuggestionStatusResponseSchema,
  type DcMemorySubject,
  type DcSubjectDraftPreview,
  type DcSubjectSuggestion,
  type DcSubjectSuggestionBatch,
  type DcSubjectSuggestionConfirmation,
  type DcSubjectSuggestionReasonCode,
  type DcSubjectSuggestionStatusResponse
} from "@/lib/domain/date-companion-stage2";

export type { DcSubjectSuggestionConfirmation } from "@/lib/domain/date-companion-stage2";

import { DcConflictError, DcNotFoundError, DcRetryableError } from "./errors";
import { dateCompanionEvidenceDigest, stableBridgeDigest } from "./memory-bridge-digest";
import { assertUploadCanBeAuthorized, getInteractionGrantGeneration } from "./memory-grant-ledger";
import {
  DateCompanionSubjectSuggestionRepository,
  type DateCompanionSubjectSuggestionBatchKey,
  type DateCompanionSubjectSuggestionBatchRow
} from "./subject-suggestion-repository";
import {
  DATE_COMPANION_SUBJECT_MODEL,
  SubjectSuggestionProviderOutputError,
  SubjectSuggestionProviderUnavailableError,
  createQwenDateCompanionSubjectSuggestionProvider,
  type DateCompanionSubjectSuggestionProvider
} from "./subject-suggestion-provider";

type SubjectEvidenceRow = {
  id: string;
  recap_item_id: string;
  upload_id: string;
  source_segment_id: string;
  start_seconds: number;
  end_seconds: number;
  speaker_id: string | null;
  quote: string;
  content_digest: string | null;
  kind: "moment" | "mentioned" | "promise" | "continue";
  recap_text: string;
};

type ReviewableEvidenceRow = SubjectEvidenceRow & {
  disposition: "pending" | "kept" | "excluded";
  same_upload: number;
  individual_review: number | null;
  reviewed_role: "self" | "companion" | "unresolved" | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
};

type SubjectContextRow = {
  relationship_id: string;
  version: number;
  status: "draft" | "confirmed";
  source_state: "available" | "server_cleaned" | "explicitly_deleted";
  confirmation_fingerprint: string | null;
  mapping_version: number | null;
  mapping_status: "confirmed" | "needs_review" | "archived" | null;
  retention_enabled: 0 | 1 | null;
  relationship_status: string;
};

type CanonicalSubjectSource = {
  canonicalSourceKey: string;
  uploadId: string;
  sourceSegmentId: string;
  contentDigest: string;
  quote: string;
  recapItemIds: string[];
  evidenceSnapshotIds: string[];
  recapContexts: Array<{
    recapItemId: string;
    kind: SubjectEvidenceRow["kind"];
    text: string;
  }>;
};

function stableId(prefix: string, values: string[]) {
  return `${prefix}_${createHash("sha256")
    .update(values.join("\u0000"))
    .digest("hex")
    .slice(0, 32)}`;
}

function interactionContext(
  database: Database.Database,
  userId: string,
  interactionId: string,
  alreadySubmitted = false
) {
  const row = database.prepare(`
    SELECT i.relationship_id, i.version, i.status, i.source_state,
           i.confirmation_fingerprint, m.version AS mapping_version,
           m.status AS mapping_status, s.enabled AS retention_enabled, rel.status AS relationship_status
    FROM dc_interactions i
    JOIN dc_relationships rel ON rel.user_id = i.user_id AND rel.id = i.relationship_id
    LEFT JOIN dc_relationship_person_mappings m
      ON m.user_id = i.user_id AND m.relationship_id = i.relationship_id
    LEFT JOIN dc_memory_retention_settings s ON s.user_id = i.user_id
    WHERE i.user_id = ? AND i.id = ?
  `).get(userId, interactionId) as SubjectContextRow | undefined;
  if (!row) throw new DcNotFoundError("Interaction not found");
  if (row.relationship_status !== "active") throw new DcConflictError("relationship_archived");
  if (row.source_state === "explicitly_deleted") {
    throw new DcConflictError("subject_suggestion_source_deleted");
  }
  if (row.retention_enabled === 0 && !alreadySubmitted) {
    throw new DcConflictError("memory_retention_disabled");
  }
  if (row.mapping_status !== "confirmed" || !row.mapping_version) {
    throw new DcConflictError("subject_suggestion_mapping_not_confirmed");
  }
  return row as SubjectContextRow & { mapping_version: number; mapping_status: "confirmed" };
}

function interactionEvidence(
  database: Database.Database,
  userId: string,
  interactionId: string,
  preview?: DcSubjectDraftPreview
) {
  const selected = preview && new Set(preview.itemIds);
  const choices = new Map(preview?.assignments.map(choice => [choice.speakerId, choice]));
  if (preview && (selected?.size !== preview.itemIds.length || choices.size !== preview.assignments.length)) {
    throw new DcConflictError("subject_suggestion_preview_invalid");
  }
  const rows = database.prepare(`
    SELECT e.id, e.recap_item_id, e.upload_id, e.source_segment_id,
           e.start_seconds, e.end_seconds, e.speaker_id, e.quote,
           e.content_digest, r.kind, r.proposed_text AS recap_text, r.disposition,
           e.upload_id = i.source_upload_id AS same_upload, p.review_by_segment AS individual_review,
           v.role AS reviewed_role, v.confirmed_by AS reviewed_by, v.confirmed_at AS reviewed_at
    FROM dc_evidence_snapshots e
    INNER JOIN dc_recap_items r ON r.id = e.recap_item_id AND r.user_id = e.user_id
    INNER JOIN dc_interactions i ON i.id = r.interaction_id AND i.user_id = e.user_id
    LEFT JOIN dc_participant_assignments p ON p.user_id=e.user_id AND p.interaction_id=i.id AND p.speaker_id=e.speaker_id
    LEFT JOIN dc_evidence_speaker_reviews v ON v.user_id=e.user_id AND v.interaction_id=i.id AND v.evidence_id=e.id
    WHERE e.user_id = ? AND r.interaction_id = ?
      AND (r.disposition='kept' OR (?=1 AND r.disposition='pending'))
    ORDER BY e.upload_id, e.source_segment_id, e.content_digest, e.id
  `).all(userId, interactionId, preview ? 1 : 0) as ReviewableEvidenceRow[];
  const candidates = selected ? rows.filter(row => selected.has(row.recap_item_id)) : rows;
  const ineligibleItems = new Set<string>();
  for (const row of candidates) {
    let role = row.reviewed_by === userId && row.reviewed_at ? row.reviewed_role : null;
    const choice = row.speaker_id && choices.get(row.speaker_id);
    if (choice) {
      if (choice.reviewedSegments) {
        role = choice.reviewedSegments.find(segment => segment.sourceSegmentId === row.source_segment_id
          && segment.contentDigest === row.content_digest)?.role ?? null;
      } else {
        role = row.individual_review === 0 ? choice.role : null;
      }
    }
    if (!row.same_upload || row.individual_review === null || (role !== "self" && role !== "companion")
      || (row.kind === "mentioned" && role !== "companion") || (row.kind === "promise" && role !== "self")) {
      ineligibleItems.add(row.recap_item_id);
    }
  }
  // A recap context can summarize every attached source. Drop the whole item's
  // context if one of its supporting lines still has an unknown speaker.
  return candidates.filter(row => !ineligibleItems.has(row.recap_item_id));
}

type SubjectScopeInput = { database: Database.Database; memoryDatabase?: Database.Database; userId: string; interactionId: string; draftPreview?: DcSubjectDraftPreview };

function grantEvidenceDigest(input: SubjectScopeInput, sources: CanonicalSubjectSource[]) {
  const generation = getInteractionGrantGeneration(input.database, input.userId, input.interactionId);
  const evidenceDigest = dateCompanionSubjectEvidenceDigest(sources);
  return generation === 1 ? evidenceDigest : stableBridgeDigest({ generation, evidenceDigest });
}

function subjectScope(input: SubjectScopeInput) {
  const context = interactionContext(input.database, input.userId, input.interactionId);
  const preview = input.draftPreview;
  if (context.status === "draft" && !preview) throw new DcConflictError("subject_suggestion_draft_preview_required");
  if (preview && (context.status !== "draft" || preview.version !== context.version)) {
    throw new DcConflictError("subject_suggestion_batch_stale");
  }
  const sources = buildDateCompanionCanonicalSubjectSources({
    userId: input.userId, evidenceRows: interactionEvidence(input.database, input.userId, input.interactionId, preview)
  });
  if (sources.length === 0) throw new DcConflictError("subject_suggestion_evidence_empty");
  if (input.memoryDatabase) assertUploadCanBeAuthorized(input.memoryDatabase, input.userId, sources[0].uploadId);
  return { context, sources, evidenceDigest: grantEvidenceDigest(input, sources) };
}

export function buildDateCompanionCanonicalSubjectSources(input: {
  userId: string;
  evidenceRows: SubjectEvidenceRow[];
}) {
  const sources = new Map<string, CanonicalSubjectSource>();
  for (const row of input.evidenceRows) {
    const digest = dateCompanionEvidenceDigest({
      userId: input.userId,
      uploadId: row.upload_id,
      sourceSegmentId: row.source_segment_id,
      startSeconds: row.start_seconds,
      endSeconds: row.end_seconds,
      speakerId: row.speaker_id,
      quote: row.quote
    });
    if (!row.content_digest || row.content_digest !== digest) {
      throw new DcConflictError("evidence_digest_conflict");
    }
    const canonicalSourceKey = stableBridgeDigest({
      uploadId: row.upload_id,
      sourceSegmentId: row.source_segment_id,
      contentDigest: row.content_digest
    });
    const current = sources.get(canonicalSourceKey) ?? {
      canonicalSourceKey,
      uploadId: row.upload_id,
      sourceSegmentId: row.source_segment_id,
      contentDigest: row.content_digest,
      quote: row.quote,
      recapItemIds: [],
      evidenceSnapshotIds: [],
      recapContexts: []
    };
    if (
      current.uploadId !== row.upload_id
      || current.sourceSegmentId !== row.source_segment_id
      || current.contentDigest !== row.content_digest
      || current.quote !== row.quote
    ) {
      throw new DcConflictError("subject_suggestion_canonical_source_conflict");
    }
    if (!current.recapItemIds.includes(row.recap_item_id)) current.recapItemIds.push(row.recap_item_id);
    if (!current.evidenceSnapshotIds.includes(row.id)) current.evidenceSnapshotIds.push(row.id);
    if (!current.recapContexts.some((context) => context.recapItemId === row.recap_item_id)) {
      current.recapContexts.push({
        recapItemId: row.recap_item_id,
        kind: row.kind,
        text: row.recap_text
      });
    }
    sources.set(canonicalSourceKey, current);
  }
  return [...sources.values()].map((source) => ({
    ...source,
    recapItemIds: [...source.recapItemIds].sort(),
    evidenceSnapshotIds: [...source.evidenceSnapshotIds].sort(),
    recapContexts: [...source.recapContexts].sort((left, right) =>
      left.recapItemId.localeCompare(right.recapItemId)
    )
  })).sort((left, right) => left.canonicalSourceKey.localeCompare(right.canonicalSourceKey));
}

export function dateCompanionSubjectEvidenceDigest(sources: CanonicalSubjectSource[]) {
  return stableBridgeDigest([...sources]
    .sort((left, right) => left.canonicalSourceKey.localeCompare(right.canonicalSourceKey))
    .map((source) => ({
      canonicalSourceKey: source.canonicalSourceKey,
      uploadId: source.uploadId,
      sourceSegmentId: source.sourceSegmentId,
      contentDigest: source.contentDigest,
      recapItemIds: [...source.recapItemIds].sort(),
      evidenceSnapshotIds: [...source.evidenceSnapshotIds].sort(),
      recapContexts: [...source.recapContexts]
        .sort((left, right) =>
          left.recapItemId.localeCompare(right.recapItemId)
          || left.kind.localeCompare(right.kind)
          || left.text.localeCompare(right.text)
        )
        .map((context) => ({
          recapItemId: context.recapItemId,
          kind: context.kind,
          text: context.text
        }))
    })));
}

function consistentSuggestion(input: {
  subject: DcMemorySubject;
  confidence: number;
  reasonCode: DcSubjectSuggestionReasonCode;
}) {
  if (input.subject === "unknown") return true;
  return (
    (input.subject === "self" && input.reasonCode === "explicit_self_reference")
    || (input.subject === "companion" && input.reasonCode === "explicit_companion_reference")
    || (input.subject === "both" && input.reasonCode === "mutual_relationship_context")
  );
}

function invalidProviderSuggestions(sources: CanonicalSubjectSource[]): DcSubjectSuggestion[] {
  return sources.map((source) => ({
    canonicalSourceKey: source.canonicalSourceKey,
    uploadId: source.uploadId,
    sourceSegmentId: source.sourceSegmentId,
    contentDigest: source.contentDigest,
    recapItemIds: source.recapItemIds,
    evidenceSnapshotIds: source.evidenceSnapshotIds,
    proposedSubject: "unknown",
    confidence: 0,
    reasonCode: "provider_output_invalid"
  }));
}

function mergeProviderSuggestions(
  sources: CanonicalSubjectSource[],
  proposed: Awaited<ReturnType<DateCompanionSubjectSuggestionProvider["suggest"]>>
) {
  const proposedByKey = new Map(proposed.map((item) => [item.canonicalSourceKey, item]));
  if (
    proposedByKey.size !== proposed.length
    || proposedByKey.size !== sources.length
    || sources.some((source) => !proposedByKey.has(source.canonicalSourceKey))
  ) {
    return { status: "degraded" as const, suggestions: invalidProviderSuggestions(sources) };
  }
  const suggestions = sources.map((source): DcSubjectSuggestion => {
    const item = proposedByKey.get(source.canonicalSourceKey)!;
    const safe = consistentSuggestion({
      subject: item.proposedSubject,
      confidence: item.confidence,
      reasonCode: item.reasonCode
    });
    return {
      canonicalSourceKey: source.canonicalSourceKey,
      uploadId: source.uploadId,
      sourceSegmentId: source.sourceSegmentId,
      contentDigest: source.contentDigest,
      recapItemIds: source.recapItemIds,
      evidenceSnapshotIds: source.evidenceSnapshotIds,
      proposedSubject: safe ? item.proposedSubject : "unknown",
      confidence: item.confidence,
      reasonCode: safe ? item.reasonCode : "provider_output_invalid"
    };
  });
  return {
    status: suggestions.some((item) => item.reasonCode === "provider_output_invalid")
      ? "degraded" as const
      : "ready" as const,
    suggestions
  };
}

function parseBatchRow(row: DateCompanionSubjectSuggestionBatchRow) {
  try {
    return DcSubjectSuggestionBatchSchema.parse(JSON.parse(row.payload_json));
  } catch {
    throw new DcConflictError("subject_suggestion_batch_corrupt");
  }
}

// The Provider timeout can be configured up to 300 seconds. Keep the claim
// beyond that ceiling so a healthy owner cannot be duplicated near timeout.
const SUBJECT_SUGGESTION_CLAIM_LEASE_MS = 330_000;
const SUBJECT_SUGGESTION_CLAIM_WAIT_MS = 340_000;
const SUBJECT_SUGGESTION_CLAIM_POLL_MS = 25;

type SubjectSuggestionSingleflightOptions = {
  leaseMs?: number;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
};

function positiveMilliseconds(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("subject_suggestion_singleflight_timing_invalid");
  }
  return Math.floor(value);
}

function abortedError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("subject_suggestion_request_aborted");
}

function waitForPoll(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(abortedError(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(abortedError(signal!));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function waitForOwnedBatch(input: {
  repository: DateCompanionSubjectSuggestionRepository;
  key: DateCompanionSubjectSuggestionBatchKey;
  waitTimeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
}) {
  const deadline = Date.now() + input.waitTimeoutMs;
  while (Date.now() <= deadline) {
    const completed = input.repository.findBatch(input.key);
    if (completed) return parseBatchRow(completed);
    await waitForPoll(input.pollIntervalMs, input.signal);
  }
  throw new DcRetryableError("subject_suggestion_generation_in_progress");
}

export function getDateCompanionSubjectSuggestionBatchStatus(input: {
  database: Database.Database;
  memoryDatabase?: Database.Database;
  userId: string;
  interactionId: string;
  now?: string;
  draftPreview?: DcSubjectDraftPreview;
}): DcSubjectSuggestionStatusResponse {
  const { context, evidenceDigest } = subjectScope(input);
  const key: DateCompanionSubjectSuggestionBatchKey = {
    userId: input.userId,
    interactionId: input.interactionId,
    interactionVersion: context.version,
    mappingVersion: context.mapping_version,
    evidenceDigest
  };
  const repository = new DateCompanionSubjectSuggestionRepository(input.database);
  const base = {
    interactionId: input.interactionId,
    interactionVersion: context.version,
    mappingVersion: context.mapping_version,
    evidenceDigest
  };
  const completed = repository.findBatch(key);
  if (completed) {
    return DcSubjectSuggestionStatusResponseSchema.parse({
      ...base,
      status: "ready",
      batch: parseBatchRow(completed)
    });
  }
  const claim = repository.findClaim(key);
  const now = input.now ?? new Date().toISOString();
  return DcSubjectSuggestionStatusResponseSchema.parse({
    ...base,
    status: claim && claim.lease_expires_at > now ? "processing" : "idle"
  });
}

export async function getOrCreateDateCompanionSubjectSuggestionBatch(input: {
  database: Database.Database;
  memoryDatabase?: Database.Database;
  userId: string;
  interactionId: string;
  provider?: DateCompanionSubjectSuggestionProvider;
  signal?: AbortSignal;
  singleflight?: SubjectSuggestionSingleflightOptions;
  draftPreview?: DcSubjectDraftPreview;
}): Promise<DcSubjectSuggestionBatch> {
  const { context, sources, evidenceDigest } = subjectScope(input);
  function assertCurrentScope() {
    if (input.signal?.aborted) throw abortedError(input.signal);
    const current = subjectScope(input);
    if (current.evidenceDigest !== evidenceDigest || current.context.version !== context.version
      || current.context.mapping_version !== context.mapping_version) {
      throw new DcConflictError("subject_suggestion_batch_stale");
    }
  }
  const repository = new DateCompanionSubjectSuggestionRepository(input.database);
  const key: DateCompanionSubjectSuggestionBatchKey = {
    userId: input.userId,
    interactionId: input.interactionId,
    interactionVersion: context.version,
    mappingVersion: context.mapping_version,
    evidenceDigest
  };
  const claimLeaseMs = positiveMilliseconds(
    input.singleflight?.leaseMs,
    SUBJECT_SUGGESTION_CLAIM_LEASE_MS
  );
  const claimWaitMs = positiveMilliseconds(
    input.singleflight?.waitTimeoutMs,
    SUBJECT_SUGGESTION_CLAIM_WAIT_MS
  );
  const claimPollMs = positiveMilliseconds(
    input.singleflight?.pollIntervalMs,
    SUBJECT_SUGGESTION_CLAIM_POLL_MS
  );
  const claimDeadline = Date.now() + claimWaitMs;
  let claimToken: string | undefined;
  while (!claimToken) {
    const nowMs = Date.now();
    const candidateToken = randomUUID();
    const claim = repository.claimGeneration({
      key,
      relationshipId: context.relationship_id,
      claimToken: candidateToken,
      now: new Date(nowMs).toISOString(),
      leaseExpiresAt: new Date(nowMs + claimLeaseMs).toISOString()
    });
    if (claim.kind === "completed") {
      assertCurrentScope();
      return parseBatchRow(claim.row);
    }
    if (claim.kind === "owner") {
      claimToken = claim.claimToken;
      break;
    }
    if (Date.now() >= claimDeadline) {
      throw new DcRetryableError("subject_suggestion_generation_in_progress");
    }
    await waitForPoll(claimPollMs, input.signal);
  }

  let merged: ReturnType<typeof mergeProviderSuggestions>;
  try {
    assertCurrentScope();
    const provider = input.provider ?? createQwenDateCompanionSubjectSuggestionProvider();
    const proposed = await provider.suggest(sources.map((source) => ({
      canonicalSourceKey: source.canonicalSourceKey,
      quote: source.quote,
      recapContexts: source.recapContexts
    })), input.signal);
    merged = mergeProviderSuggestions(sources, proposed);
  } catch (error) {
    if (error instanceof SubjectSuggestionProviderOutputError) {
      merged = { status: "degraded", suggestions: invalidProviderSuggestions(sources) };
    } else {
      repository.releaseGeneration(key, claimToken);
      if (error instanceof SubjectSuggestionProviderUnavailableError) {
        throw new DcRetryableError("subject_suggestion_provider_unavailable");
      }
      throw error;
    }
  }

  try {
    assertCurrentScope();
    const proposalDigest = stableBridgeDigest(merged.suggestions);
    const confirmationFingerprint = stableBridgeDigest({
      userId: input.userId,
      interactionId: input.interactionId,
      interactionVersion: context.version,
      mappingVersion: context.mapping_version,
      evidenceDigest,
      proposalDigest,
      existingConfirmationFingerprint: context.confirmation_fingerprint
    });
    const batchId = stableId("dc_subject_batch", [
      input.userId,
      input.interactionId,
      String(context.version),
      String(context.mapping_version),
      evidenceDigest,
      proposalDigest
    ]);
    const createdAt = new Date().toISOString();
    const batch = DcSubjectSuggestionBatchSchema.parse({
      batchId,
      interactionId: input.interactionId,
      interactionVersion: context.version,
      mappingVersion: context.mapping_version,
      evidenceDigest,
      proposalDigest,
      confirmationFingerprint,
      model: DATE_COMPANION_SUBJECT_MODEL,
      status: merged.status,
      suggestions: merged.suggestions,
      createdAt
    });
    const completed = repository.completeGeneration({
      key,
      claimToken,
      batch: {
        id: batch.batchId,
        relationshipId: context.relationship_id,
        proposalDigest: batch.proposalDigest,
        confirmationFingerprint: batch.confirmationFingerprint,
        model: batch.model,
        status: batch.status,
        payloadJson: JSON.stringify(batch),
        createdAt
      }
    });
    if (completed.kind === "completed") return parseBatchRow(completed.row);
    const ownerBatch = await waitForOwnedBatch({
      repository,
      key,
      waitTimeoutMs: claimWaitMs,
      pollIntervalMs: claimPollMs,
      signal: input.signal
    });
    assertCurrentScope();
    return ownerBatch;
  } catch (error) {
    repository.releaseGeneration(key, claimToken);
    throw error;
  }
}

export function validateDateCompanionSubjectSuggestionConfirmation(input: {
  database: Database.Database;
  userId: string;
  interactionId: string;
  interactionVersion: number;
  mappingVersion: number;
  confirmation: DcSubjectSuggestionConfirmation;
  selections: Array<{ evidenceSnapshotId: string; subject: DcMemorySubject }>;
  keptEvidenceSnapshotIds: string[];
  alreadySubmitted?: boolean;
}) {
  const row = input.database.prepare(`
    SELECT id, payload_json FROM dc_subject_suggestion_batches
    WHERE user_id = ? AND interaction_id = ? AND id = ?
  `).get(
    input.userId,
    input.interactionId,
    input.confirmation.batchId
  ) as DateCompanionSubjectSuggestionBatchRow | undefined;
  if (!row) throw new DcConflictError("subject_suggestion_batch_stale");
  const batch = parseBatchRow(row);
  if (
    input.confirmation.confirmedVisibleSuggestions !== true
    || batch.interactionVersion !== input.interactionVersion
    || batch.mappingVersion !== input.mappingVersion
    || batch.evidenceDigest !== input.confirmation.evidenceDigest
    || batch.proposalDigest !== input.confirmation.proposalDigest
    || batch.confirmationFingerprint !== input.confirmation.confirmationFingerprint
  ) {
    throw new DcConflictError("subject_suggestion_batch_stale");
  }
  const context = interactionContext(input.database, input.userId, input.interactionId, input.alreadySubmitted);
  if (context.version !== batch.interactionVersion || context.mapping_version !== batch.mappingVersion) {
    throw new DcConflictError("subject_suggestion_batch_stale");
  }
  const currentSources = buildDateCompanionCanonicalSubjectSources({
    userId: input.userId,
    evidenceRows: interactionEvidence(input.database, input.userId, input.interactionId)
  });
  if (grantEvidenceDigest(input, currentSources) !== batch.evidenceDigest) {
    throw new DcConflictError("subject_suggestion_evidence_stale");
  }
  const proposedSubjects = new Map<string, DcMemorySubject>();
  for (const suggestion of batch.suggestions) {
    for (const evidenceSnapshotId of suggestion.evidenceSnapshotIds) {
      const existing = proposedSubjects.get(evidenceSnapshotId);
      if (existing && existing !== suggestion.proposedSubject) {
        throw new DcConflictError("subject_suggestion_batch_stale");
      }
      proposedSubjects.set(evidenceSnapshotId, suggestion.proposedSubject);
    }
  }
  const allowedIds = new Set(proposedSubjects.keys());
  const selectedIds = [...input.selections.map((selection) => selection.evidenceSnapshotId)].sort();
  const expectedIds = [...input.keptEvidenceSnapshotIds].sort();
  if (
    selectedIds.length !== new Set(selectedIds).size
    || selectedIds.some((id) => !allowedIds.has(id))
    || input.selections.some((selection) =>
      proposedSubjects.get(selection.evidenceSnapshotId) !== selection.subject
    )
    || selectedIds.length !== expectedIds.length
    || selectedIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new DcConflictError("subject_suggestion_selection_set_mismatch");
  }
  return batch;
}
