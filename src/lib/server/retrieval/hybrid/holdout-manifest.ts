import { createHash } from "node:crypto";
import { z } from "zod";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const DateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const NonEmptyStringSchema = z.string().trim().min(1);

const FrozenOwnerSchema = z.object({
  scope: z.enum(["individual", "shared", "unknown"]),
  type: z.enum(["known_identity", "local_speaker", "unknown"]),
  identityId: z.string().trim().min(1).nullable(),
  confidence: z.number().min(0).max(1),
  source: z.enum([
    "speaker_identity",
    "manual_mapping",
    "explicit_statement",
    "unknown"
  ]),
  conflict: z.boolean()
}).strict();

const FrozenMemoryEvidenceSchema = z.object({
  id: NonEmptyStringSchema,
  sourceType: z.enum([
    "transcript",
    "brief",
    "timeline",
    "audio_insight",
    "relationship_signal"
  ]),
  sourceId: NonEmptyStringSchema,
  uploadId: NonEmptyStringSchema,
  recordingDate: DateKeySchema,
  canonicalEvidenceIds: z.array(NonEmptyStringSchema),
  canonicalSourceSegmentIds: z.array(NonEmptyStringSchema),
  mappable: z.boolean()
}).strict();

const FrozenMemoryItemSchema = z.object({
  memoryId: NonEmptyStringSchema,
  type: z.enum([
    "event",
    "commitment",
    "question",
    "relationship_signal",
    "preference",
    "summary"
  ]),
  status: z.enum(["active", "resolved", "expired", "superseded"]),
  title: NonEmptyStringSchema,
  summary: NonEmptyStringSchema,
  importance: z.number().min(0).max(1),
  importanceScore: z.number().min(0).max(1),
  firstSeenDate: DateKeySchema,
  lastSeenDate: DateKeySchema,
  occurrenceCount: z.number().int().min(1),
  owner: FrozenOwnerSchema,
  evidence: z.array(FrozenMemoryEvidenceSchema).min(1),
  contentHash: HashSchema,
  modelRevision: z.string().trim().min(1).nullable()
}).strict();

const HoldoutUploadSchema = z.object({
  uploadId: NonEmptyStringSchema,
  recordingDate: DateKeySchema,
  transcriptSegmentCount: z.number().int().nonnegative(),
  transcriptHash: HashSchema,
  eventClusterIds: z.array(NonEmptyStringSchema)
}).strict();

const HoldoutSourceSchema = z.object({
  sourceId: NonEmptyStringSchema,
  datasetId: NonEmptyStringSchema,
  runtimePath: NonEmptyStringSchema,
  userId: NonEmptyStringSchema,
  benchmarkReportPath: NonEmptyStringSchema,
  uploads: z.array(HoldoutUploadSchema).min(1),
  transcriptSegmentCount: z.number().int().nonnegative(),
  transcriptHash: HashSchema,
  eventClusterIds: z.array(NonEmptyStringSchema)
}).strict();

export const FrozenMemoryManifestSchema = z.object({
  version: z.literal(1),
  kind: z.literal("daily_brief_holdout_memory_manifest"),
  frozenAt: z.string().datetime(),
  generatedBeforeQuestions: z.literal(true),
  source: HoldoutSourceSchema,
  repository: z.object({
    schemaVersion: z.number().int().nonnegative(),
    sourceBuild: z.string().trim().min(1),
    memoryModelRevision: z.string().trim().min(1).nullable()
  }).strict(),
  canonicalUniverse: z.object({
    evidenceCount: z.number().int().nonnegative(),
    identityHash: HashSchema,
    contentHash: HashSchema
  }).strict(),
  counts: z.object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
    superseded: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
    verifiedOwner: z.number().int().nonnegative(),
    localOwner: z.number().int().nonnegative(),
    unknownOwner: z.number().int().nonnegative(),
    conflictOwner: z.number().int().nonnegative(),
    canonicalMappable: z.number().int().nonnegative(),
    unmappable: z.number().int().nonnegative(),
    evidenceRows: z.number().int().nonnegative()
  }).strict(),
  memories: z.array(FrozenMemoryItemSchema),
  manifestHash: HashSchema
}).strict();

const GoldGroupSchema = z.object({
  id: NonEmptyStringSchema,
  sourceSegmentIds: z.array(NonEmptyStringSchema).min(1)
}).strict();

export const RetrievalHoldoutManifestSchema = z.object({
  version: z.literal(1),
  kind: z.literal("daily_brief_retrieval_holdout_manifest"),
  role: z.literal("holdout"),
  splitUnit: z.literal("recording_upload_date_group"),
  frozenAt: z.string().datetime(),
  memoryManifests: z.array(z.object({
    sourceId: NonEmptyStringSchema,
    manifestPath: NonEmptyStringSchema,
    manifestHash: HashSchema,
    frozenAt: z.string().datetime()
  }).strict()).min(1),
  developmentSet: z.object({
    name: z.literal("hybrid_phase31_shadow_v1"),
    uploadIds: z.array(NonEmptyStringSchema),
    transcriptHashes: z.array(HashSchema),
    eventClusterIds: z.array(NonEmptyStringSchema)
  }).strict(),
  sources: z.array(HoldoutSourceSchema).min(1),
  cases: z.array(z.object({
    caseId: NonEmptyStringSchema,
    question: NonEmptyStringSchema,
    scope: z.enum(["current", "week", "all"]),
    category: z.enum([
      "decision",
      "fact",
      "lifecycle",
      "preference",
      "relationship",
      "temporal",
      "other"
    ]),
    queryIntent: z.array(NonEmptyStringSchema).min(1),
    requiredAnswerAspects: z.array(NonEmptyStringSchema).min(1),
    goldEvidenceGroups: z.array(GoldGroupSchema),
    acceptableAlternativeEvidenceGroups: z.array(GoldGroupSchema),
    requiredLifecycleStates: z.array(NonEmptyStringSchema),
    requiredDates: z.array(DateKeySchema),
    requiredEntities: z.array(NonEmptyStringSchema),
    memoryShouldHelp: z.boolean(),
    expectedMemoryIds: z.array(NonEmptyStringSchema),
    evaluability: z.enum([
      "retrieval-evaluable",
      "QA-only",
      "fixture/universe gap",
      "ambiguous"
    ]),
    exclusionReasons: z.array(NonEmptyStringSchema),
    sourceId: NonEmptyStringSchema
  }).strict()).min(1),
  manifestHash: HashSchema
}).strict();

export type FrozenMemoryManifest = z.infer<typeof FrozenMemoryManifestSchema>;
export type RetrievalHoldoutManifest = z.infer<typeof RetrievalHoldoutManifestSchema>;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)])
    );
  }
  return value;
}

export function canonicalManifestJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

export function holdoutManifestHash(value: unknown) {
  const withoutEmbeddedHash =
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([key]) => key !== "manifestHash")
        )
      : value;
  return createHash("sha256")
    .update(canonicalManifestJson(withoutEmbeddedHash))
    .digest("hex");
}

export function assertFrozenMemoryManifest(value: unknown) {
  const manifest = FrozenMemoryManifestSchema.parse(value);
  const actualHash = holdoutManifestHash(manifest);
  if (manifest.manifestHash !== actualHash) {
    throw new Error(
      `Frozen Memory manifest hash mismatch: expected ${manifest.manifestHash}, got ${actualHash}`
    );
  }
  if (manifest.memories.length !== manifest.counts.total) {
    throw new Error("Frozen Memory manifest total does not match its item list");
  }
  if (
    manifest.counts.active +
      manifest.counts.resolved +
      manifest.counts.superseded +
      manifest.counts.expired !==
    manifest.counts.total
  ) {
    throw new Error("Frozen Memory status counts do not sum to total");
  }
  return manifest;
}

export function assertRetrievalHoldoutManifest(input: {
  value: unknown;
  memoryManifests: readonly FrozenMemoryManifest[];
  forbiddenCaseIds?: ReadonlySet<string>;
}) {
  const manifest = RetrievalHoldoutManifestSchema.parse(input.value);
  const actualHash = holdoutManifestHash(manifest);
  if (manifest.manifestHash !== actualHash) {
    throw new Error(
      `Retrieval holdout manifest hash mismatch: expected ${manifest.manifestHash}, got ${actualHash}`
    );
  }
  const frozenBySource = new Map(
    input.memoryManifests.map((memory) => [memory.source.sourceId, memory])
  );
  for (const reference of manifest.memoryManifests) {
    const frozen = frozenBySource.get(reference.sourceId);
    if (
      !frozen ||
      reference.manifestHash !== frozen.manifestHash ||
      reference.frozenAt !== frozen.frozenAt
    ) {
      throw new Error(
        `Retrieval holdout references a different frozen Memory manifest for ${reference.sourceId}`
      );
    }
    if (Date.parse(reference.frozenAt) > Date.parse(manifest.frozenAt)) {
      throw new Error("Memory must be frozen before the holdout questions");
    }
  }
  if (manifest.memoryManifests.length !== frozenBySource.size) {
    throw new Error("Every frozen Memory partition must be referenced by the holdout");
  }

  const developmentUploads = new Set(manifest.developmentSet.uploadIds);
  const developmentTranscripts = new Set(manifest.developmentSet.transcriptHashes);
  const developmentEventClusters = new Set(manifest.developmentSet.eventClusterIds);
  const sourceIds = new Set(manifest.sources.map((source) => source.sourceId));
  const duplicateCaseIds = manifest.cases
    .map((item) => item.caseId)
    .filter((caseId, index, values) => values.indexOf(caseId) !== index);
  if (duplicateCaseIds.length > 0) {
    throw new Error(`Duplicate holdout case IDs: ${[...new Set(duplicateCaseIds)].join(", ")}`);
  }
  for (const source of manifest.sources) {
    if (!frozenBySource.has(source.sourceId)) {
      throw new Error(`Holdout source ${source.sourceId} has no frozen Memory manifest`);
    }
    if (source.uploads.some((upload) => developmentUploads.has(upload.uploadId))) {
      throw new Error(
        `Holdout upload overlaps development set: ${
          source.uploads.find((upload) => developmentUploads.has(upload.uploadId))!.uploadId
        }`
      );
    }
    if (
      developmentTranscripts.has(source.transcriptHash) ||
      source.uploads.some((upload) => developmentTranscripts.has(upload.transcriptHash))
    ) {
      throw new Error(`Holdout transcript overlaps development set: ${source.transcriptHash}`);
    }
    const overlappingEventCluster = source.eventClusterIds.find((eventClusterId) =>
      developmentEventClusters.has(eventClusterId)
    );
    if (overlappingEventCluster) {
      throw new Error(
        `Holdout event cluster overlaps development set: ${overlappingEventCluster}`
      );
    }
  }
  for (const item of manifest.cases) {
    if (!sourceIds.has(item.sourceId)) {
      throw new Error(`Holdout case ${item.caseId} references an unknown source`);
    }
    if (input.forbiddenCaseIds?.has(item.caseId)) {
      throw new Error(`Holdout reuses a development regression case: ${item.caseId}`);
    }
    const excluded = item.evaluability !== "retrieval-evaluable";
    if (excluded !== (item.exclusionReasons.length > 0)) {
      throw new Error(
        `Holdout case ${item.caseId} must record exclusion reasons exactly when excluded`
      );
    }
    if (
      item.evaluability === "retrieval-evaluable" &&
      item.goldEvidenceGroups.length === 0
    ) {
      throw new Error(`Retrieval-evaluable case ${item.caseId} has no gold evidence`);
    }
  }
  return manifest;
}
