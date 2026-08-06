import { createHash } from "node:crypto";
import { z } from "zod";
import type { JsonStore } from "@/lib/server/storage/json-store";
import {
  QWEN3_EMBEDDING_4B_DIMENSION,
  QWEN3_EMBEDDING_4B_MODEL,
  QWEN3_EMBEDDING_4B_REVISION
} from "./runtime-config";

export const HYBRID_INDEX_RETENTIONS_COLLECTION = "hybrid-index-retentions";
export const HYBRID_INDEX_DELETIONS_COLLECTION = "hybrid-index-deletions";
export const HYBRID_INDEX_RETENTION_VERSION = 1 as const;
export const HYBRID_EVIDENCE_PROJECTION_VERSION = 1 as const;

const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const StoreKeySchema = z.string().min(1).max(512).regex(STORE_KEY_PATTERN);
const Sha256Schema = z.string().regex(SHA256_PATTERN);
const TimestampSchema = z.string().datetime({ offset: true });

export const HybridIndexRetentionEvidenceSchema = z.object({
  objectId: z.string().trim().min(1).max(1_024),
  contentHash: Sha256Schema
}).strict();

export type HybridIndexRetentionEvidence = z.infer<
  typeof HybridIndexRetentionEvidenceSchema
>;

function compareEvidence(
  left: HybridIndexRetentionEvidence,
  right: HybridIndexRetentionEvidence
) {
  if (left.objectId < right.objectId) return -1;
  if (left.objectId > right.objectId) return 1;
  return left.contentHash < right.contentHash
    ? -1
    : left.contentHash > right.contentHash
      ? 1
      : 0;
}

/**
 * Produces the only persisted Evidence ordering. Exact duplicates collapse;
 * one object id resolving to multiple contents is an unsafe corpus conflict.
 */
export function canonicalizeHybridIndexRetentionEvidence(
  evidence: readonly HybridIndexRetentionEvidence[]
) {
  const byObjectId = new Map<string, HybridIndexRetentionEvidence>();
  for (const rawEntry of evidence) {
    const entry = HybridIndexRetentionEvidenceSchema.parse(rawEntry);
    const existing = byObjectId.get(entry.objectId);
    if (existing && existing.contentHash !== entry.contentHash) {
      throw new Error(
        `Hybrid retention corpus has conflicting content hashes for object ${entry.objectId}`
      );
    }
    byObjectId.set(entry.objectId, entry);
  }
  return [...byObjectId.values()].sort(compareEvidence);
}

export function hybridIndexRetentionCorpusHash(
  evidence: readonly HybridIndexRetentionEvidence[]
) {
  const canonicalEvidence = canonicalizeHybridIndexRetentionEvidence(evidence);
  return createHash("sha256")
    .update(JSON.stringify({
      projectionVersion: HYBRID_EVIDENCE_PROJECTION_VERSION,
      modelName: QWEN3_EMBEDDING_4B_MODEL,
      modelVersion: QWEN3_EMBEDDING_4B_REVISION,
      dimension: QWEN3_EMBEDDING_4B_DIMENSION,
      evidence: canonicalEvidence
    }), "utf8")
    .digest("hex");
}

function validateCanonicalCorpus(
  value: {
    evidence: HybridIndexRetentionEvidence[];
    corpusHash: string;
  },
  context: z.RefinementCtx
) {
  let canonicalEvidence: HybridIndexRetentionEvidence[];
  try {
    canonicalEvidence = canonicalizeHybridIndexRetentionEvidence(value.evidence);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: error instanceof Error ? error.message : "Invalid Hybrid retention corpus"
    });
    return;
  }
  const canonicalOrder =
    canonicalEvidence.length === value.evidence.length &&
    canonicalEvidence.every((entry, index) =>
      entry.objectId === value.evidence[index]?.objectId &&
      entry.contentHash === value.evidence[index]?.contentHash
    );
  if (!canonicalOrder) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "Hybrid retention Evidence must be uniquely and canonically sorted"
    });
    return;
  }
  if (hybridIndexRetentionCorpusHash(canonicalEvidence) !== value.corpusHash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["corpusHash"],
      message: "Hybrid retention corpus hash does not match its Evidence"
    });
  }
}

const fixedCorpusShape = {
  version: z.literal(HYBRID_INDEX_RETENTION_VERSION),
  projectionVersion: z.literal(HYBRID_EVIDENCE_PROJECTION_VERSION),
  modelName: z.literal(QWEN3_EMBEDDING_4B_MODEL),
  modelVersion: z.literal(QWEN3_EMBEDDING_4B_REVISION),
  dimension: z.literal(QWEN3_EMBEDDING_4B_DIMENSION),
  uploadId: StoreKeySchema,
  evidence: z.array(HybridIndexRetentionEvidenceSchema),
  corpusHash: Sha256Schema
} as const;

export const HybridIndexRetentionManifestSchema = z.object({
  ...fixedCorpusShape,
  preparedAt: TimestampSchema
}).strict().superRefine(validateCanonicalCorpus);

export type HybridIndexRetentionManifest = z.infer<
  typeof HybridIndexRetentionManifestSchema
>;

export function buildHybridIndexRetentionManifest(input: {
  uploadId: string;
  evidence: readonly HybridIndexRetentionEvidence[];
  preparedAt?: string;
}): HybridIndexRetentionManifest {
  const evidence = canonicalizeHybridIndexRetentionEvidence(input.evidence);
  return HybridIndexRetentionManifestSchema.parse({
    version: HYBRID_INDEX_RETENTION_VERSION,
    projectionVersion: HYBRID_EVIDENCE_PROJECTION_VERSION,
    modelName: QWEN3_EMBEDDING_4B_MODEL,
    modelVersion: QWEN3_EMBEDDING_4B_REVISION,
    dimension: QWEN3_EMBEDDING_4B_DIMENSION,
    uploadId: input.uploadId,
    evidence,
    corpusHash: hybridIndexRetentionCorpusHash(evidence),
    preparedAt: input.preparedAt ?? new Date().toISOString()
  });
}

function assertStoredRecordId(recordId: string, uploadId: string) {
  if (recordId !== uploadId) {
    throw new Error("Hybrid retention record id does not match its upload id");
  }
}

export async function readHybridIndexRetentionManifest(
  store: JsonStore,
  uploadId: string
) {
  const recordId = StoreKeySchema.parse(uploadId);
  const raw = await store.read<unknown>(HYBRID_INDEX_RETENTIONS_COLLECTION, recordId);
  if (raw === null) return null;
  const manifest = HybridIndexRetentionManifestSchema.parse(raw);
  assertStoredRecordId(recordId, manifest.uploadId);
  return manifest;
}

export async function listHybridIndexRetentionManifests(store: JsonStore) {
  const records = await store.list<unknown>(HYBRID_INDEX_RETENTIONS_COLLECTION);
  return records
    .map((record) => {
      const manifest = HybridIndexRetentionManifestSchema.parse(record.value);
      assertStoredRecordId(record.id, manifest.uploadId);
      return manifest;
    })
    .sort((left, right) => left.uploadId < right.uploadId ? -1 : left.uploadId > right.uploadId ? 1 : 0);
}

export async function writeHybridIndexRetentionManifest(
  store: JsonStore,
  manifest: HybridIndexRetentionManifest
) {
  const parsed = HybridIndexRetentionManifestSchema.parse(manifest);
  await store.write(HYBRID_INDEX_RETENTIONS_COLLECTION, parsed.uploadId, parsed);
  return parsed;
}

export async function deleteHybridIndexRetentionManifest(
  store: JsonStore,
  uploadId: string
) {
  await store.delete(HYBRID_INDEX_RETENTIONS_COLLECTION, StoreKeySchema.parse(uploadId));
}

const deletionPendingShape = {
  ...fixedCorpusShape,
  status: z.literal("pending"),
  requestedAt: TimestampSchema
} as const;

const deletionCompletedShape = {
  ...fixedCorpusShape,
  status: z.literal("completed"),
  requestedAt: TimestampSchema,
  completedAt: TimestampSchema
} as const;

export const HybridIndexDeletionPendingSchema = z.object(deletionPendingShape)
  .strict()
  .superRefine(validateCanonicalCorpus);
export const HybridIndexDeletionCompletedSchema = z.object(deletionCompletedShape)
  .strict()
  .superRefine(validateCanonicalCorpus);
export const HybridIndexDeletionSchema = z.union([
  HybridIndexDeletionPendingSchema,
  HybridIndexDeletionCompletedSchema
]);

export type HybridIndexDeletion = z.infer<typeof HybridIndexDeletionSchema>;
export type HybridIndexDeletionPending = z.infer<
  typeof HybridIndexDeletionPendingSchema
>;
export type HybridIndexDeletionCompleted = z.infer<
  typeof HybridIndexDeletionCompletedSchema
>;

function buildPendingDeletion(input: {
  uploadId: string;
  evidence: readonly HybridIndexRetentionEvidence[];
  requestedAt?: string;
}): HybridIndexDeletionPending {
  const evidence = canonicalizeHybridIndexRetentionEvidence(input.evidence);
  return HybridIndexDeletionPendingSchema.parse({
    version: HYBRID_INDEX_RETENTION_VERSION,
    projectionVersion: HYBRID_EVIDENCE_PROJECTION_VERSION,
    modelName: QWEN3_EMBEDDING_4B_MODEL,
    modelVersion: QWEN3_EMBEDDING_4B_REVISION,
    dimension: QWEN3_EMBEDDING_4B_DIMENSION,
    uploadId: input.uploadId,
    evidence,
    corpusHash: hybridIndexRetentionCorpusHash(evidence),
    status: "pending",
    requestedAt: input.requestedAt ?? new Date().toISOString()
  });
}

export async function readHybridIndexDeletion(store: JsonStore, uploadId: string) {
  const recordId = StoreKeySchema.parse(uploadId);
  const raw = await store.read<unknown>(HYBRID_INDEX_DELETIONS_COLLECTION, recordId);
  if (raw === null) return null;
  const deletion = HybridIndexDeletionSchema.parse(raw);
  assertStoredRecordId(recordId, deletion.uploadId);
  return deletion;
}

export async function requestHybridIndexDeletion(
  store: JsonStore,
  input: {
    uploadId: string;
    evidence: readonly HybridIndexRetentionEvidence[];
    requestedAt?: string;
  }
) {
  const requested = buildPendingDeletion(input);
  const existing = await readHybridIndexDeletion(store, requested.uploadId);
  if (existing) {
    if (existing.corpusHash !== requested.corpusHash) {
      throw new Error("Hybrid index deletion already exists for a different corpus");
    }
    return existing;
  }
  await store.write(HYBRID_INDEX_DELETIONS_COLLECTION, requested.uploadId, requested);
  return requested;
}

export async function listHybridIndexDeletions(
  store: JsonStore,
  status?: HybridIndexDeletion["status"]
) {
  const records = await store.list<unknown>(HYBRID_INDEX_DELETIONS_COLLECTION);
  return records
    .map((record) => {
      const deletion = HybridIndexDeletionSchema.parse(record.value);
      assertStoredRecordId(record.id, deletion.uploadId);
      return deletion;
    })
    .filter((deletion) => status === undefined || deletion.status === status)
    .sort((left, right) => left.uploadId < right.uploadId ? -1 : left.uploadId > right.uploadId ? 1 : 0);
}

export async function completeHybridIndexDeletion(
  store: JsonStore,
  input: {
    uploadId: string;
    corpusHash: string;
    completedAt?: string;
  }
): Promise<HybridIndexDeletionCompleted> {
  const deletion = await readHybridIndexDeletion(store, input.uploadId);
  if (!deletion) {
    throw new Error("Hybrid index deletion request was not found");
  }
  if (deletion.corpusHash !== Sha256Schema.parse(input.corpusHash)) {
    throw new Error("Hybrid index deletion corpus changed before completion");
  }
  if (deletion.status === "completed") return deletion;
  const completed = HybridIndexDeletionCompletedSchema.parse({
    ...deletion,
    status: "completed",
    completedAt: input.completedAt ?? new Date().toISOString()
  });
  await store.write(HYBRID_INDEX_DELETIONS_COLLECTION, completed.uploadId, completed);
  return completed;
}

export async function deleteHybridIndexDeletion(store: JsonStore, uploadId: string) {
  await store.delete(HYBRID_INDEX_DELETIONS_COLLECTION, StoreKeySchema.parse(uploadId));
}
