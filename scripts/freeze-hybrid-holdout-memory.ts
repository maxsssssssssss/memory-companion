import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import {
  AudioInsightSchema,
  AudioUploadSchema,
  BriefItemSchema,
  RelationshipSignalCardSchema,
  SemanticSegmentSchema,
  TranscriptSegmentSchema,
  type AudioInsight,
  type BriefItem,
  type RelationshipSignalCard,
  type SemanticSegment,
  type TranscriptSegment
} from "@/lib/domain/types";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import { MEMORY_SCHEMA_VERSION } from "@/lib/server/memory/schema";
import type { MemoryItem } from "@/lib/server/memory/types";
import { JsonStore } from "@/lib/server/storage/json-store";
import { buildCanonicalQaEvidence } from "@/lib/server/retrieval/ai-qa";
import { memoryEmbeddingText } from "@/lib/server/retrieval/hybrid/memory-expansion";
import {
  canonicalManifestJson,
  holdoutManifestHash
} from "@/lib/server/retrieval/hybrid/holdout-manifest";
import { embeddingContentHash } from "@/lib/server/retrieval/hybrid/embedding-index";

type UploadOption = {
  uploadId: string;
  recordingDate: string;
  eventClusterIds: string[];
};

type CliOptions = {
  sourceId: string;
  datasetId: string;
  runtimePath: string;
  userId: string;
  benchmarkReportPath: string;
  sourceBuild: string;
  outputPath: string;
  uploads: UploadOption[];
  memoryModelRevision: string | null;
  migrateSchema: boolean;
};

const DateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

function valueAfter(argv: string[], index: number) {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${argv[index]} requires a value`);
  }
  return value;
}

function parseUpload(value: string): UploadOption {
  const [uploadId, recordingDate, eventClusters = ""] = value.split(",");
  if (!uploadId?.trim() || !recordingDate?.trim()) {
    throw new Error("--upload must use uploadId,YYYY-MM-DD,event1|event2");
  }
  return {
    uploadId: uploadId.trim(),
    recordingDate: DateKeySchema.parse(recordingDate.trim()),
    eventClusterIds: eventClusters
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean)
  };
}

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  const uploads: UploadOption[] = [];
  let migrateSchema = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--migrate-schema") {
      migrateSchema = true;
      continue;
    }
    const value = valueAfter(argv, index);
    index += 1;
    if (arg === "--upload") uploads.push(parseUpload(value));
    else values.set(arg, value);
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  if (uploads.length === 0) throw new Error("At least one --upload is required");
  return {
    sourceId: required("--source-id"),
    datasetId: required("--dataset-id"),
    runtimePath: resolve(required("--runtime")),
    userId: required("--user"),
    benchmarkReportPath: resolve(required("--benchmark-report")),
    sourceBuild: required("--source-build"),
    outputPath: resolve(required("--output")),
    uploads,
    memoryModelRevision: values.get("--memory-model-revision") ?? null,
    migrateSchema
  };
}

function digest(value: unknown) {
  return createHash("sha256").update(canonicalManifestJson(value)).digest("hex");
}

type LoadedUpload = UploadOption & {
  upload: z.infer<typeof AudioUploadSchema>;
  segments: TranscriptSegment[];
  audioInsights: AudioInsight[];
  semanticSegments: SemanticSegment[];
  briefItems: BriefItem[];
  relationshipSignals: RelationshipSignalCard[];
};

async function optionalArtifact<TSchema extends z.ZodTypeAny>(
  store: JsonStore,
  collection: string,
  id: string,
  schema: TSchema
): Promise<z.output<TSchema>> {
  const value = await store.read(collection, id);
  return schema.parse(value ?? []) as z.output<TSchema>;
}

async function loadUpload(store: JsonStore, option: UploadOption): Promise<LoadedUpload> {
  const [
    upload,
    segments,
    audioInsights,
    semanticSegments,
    briefItems,
    relationshipSignals
  ] = await Promise.all([
    store.read("uploads", option.uploadId).then((value) => AudioUploadSchema.parse(value)),
    store.read("segments", option.uploadId).then((value) =>
      z.array(TranscriptSegmentSchema).parse(value)
    ),
    optionalArtifact(store, "audio-insights", option.uploadId, z.array(AudioInsightSchema)),
    optionalArtifact(
      store,
      "semantic-segments",
      option.uploadId,
      z.array(SemanticSegmentSchema)
    ),
    optionalArtifact(store, "brief-items", option.uploadId, z.array(BriefItemSchema)),
    optionalArtifact(
      store,
      "relationship-signals",
      option.uploadId,
      z.array(RelationshipSignalCardSchema)
    )
  ]);
  if (upload.recordingDate !== option.recordingDate) {
    throw new Error(
      `Recording date mismatch for ${option.uploadId}: ` +
      `${upload.recordingDate} != ${option.recordingDate}`
    );
  }
  return {
    ...option,
    upload,
    segments,
    audioInsights,
    semanticSegments,
    briefItems,
    relationshipSignals
  };
}

function conflictFromOwner(owner: ReturnType<
  ReturnType<typeof createMemoryRepository>["getMemoryOwnerAttributions"]
>[number] | undefined) {
  if (!owner || owner.scope !== "unknown") return false;
  const identities = new Set([
    ...(owner.owner.identityId ? [owner.owner.identityId] : []),
    ...owner.participants.flatMap((participant) =>
      participant.attribution.identityId
        ? [participant.attribution.identityId]
        : []
    )
  ]);
  return identities.size > 1;
}

function canonicalFingerprints(evidence: ReturnType<typeof buildCanonicalQaEvidence>) {
  const ordered = [...evidence].sort((left, right) => left.id.localeCompare(right.id));
  return {
    identityHash: digest(ordered.map((item) => ({
      id: item.id,
      sourceSegmentIds: [...item.sourceSegmentIds].sort()
    }))),
    contentHash: digest(ordered.map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      text: item.text,
      startSeconds: item.startSeconds,
      endSeconds: item.endSeconds,
      priority: item.priority,
      sourceSegmentIds: item.sourceSegmentIds
    })))
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const databasePath = resolve(options.runtimePath, "memory.sqlite");
  if (options.migrateSchema) {
    const migrationDatabase = openMemoryDatabase({ filePath: databasePath });
    migrationDatabase.close();
  }
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true
  });
  const store = new JsonStore(resolve(options.runtimePath, "users", options.userId));
  try {
    const uploads = await Promise.all(
      options.uploads.map((option) => loadUpload(store, option))
    );
    const selectedUploadIds = new Set(uploads.map((item) => item.uploadId));
    const repository = createMemoryRepository(database);
    const memories = repository.getRelevantMemories({
      userId: options.userId,
      limit: 10_000
    }).filter((memory) =>
      memory.evidence.some((item) => selectedUploadIds.has(item.uploadId))
    );
    const owners = repository.getMemoryOwnerAttributions(
      options.userId,
      memories.map((memory) => memory.id)
    );
    const ownerByMemoryId = new Map(owners.map((owner) => [owner.memoryId, owner]));
    const segments = uploads.flatMap((item) => item.segments);
    const canonicalEvidence = buildCanonicalQaEvidence({
      uploadId: uploads.at(-1)!.uploadId,
      question: "freeze canonical holdout universe",
      scope: "all",
      segments,
      audioInsights: uploads.flatMap((item) => item.audioInsights),
      semanticSegments: uploads.flatMap((item) => item.semanticSegments),
      briefItems: uploads.flatMap((item) => item.briefItems),
      relationshipSignals: uploads.flatMap((item) => item.relationshipSignals)
    });
    const canonicalById = new Map(canonicalEvidence.map((item) => [item.id, item]));
    const canonicalBySourceId = new Map<string, typeof canonicalEvidence>();
    for (const evidence of canonicalEvidence) {
      for (const sourceId of evidence.sourceSegmentIds) {
        const current = canonicalBySourceId.get(sourceId) ?? [];
        current.push(evidence);
        canonicalBySourceId.set(sourceId, current);
      }
    }

    const frozenMemories = memories
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((memory: MemoryItem) => {
        const owner = ownerByMemoryId.get(memory.id);
        const conflict = conflictFromOwner(owner);
        const evidence = memory.evidence.map((item) => {
          const direct = canonicalById.get(item.sourceId);
          const mapped = direct ? [direct] : canonicalBySourceId.get(item.sourceId) ?? [];
          return {
            id: item.id,
            sourceType: item.sourceType,
            sourceId: item.sourceId,
            uploadId: item.uploadId,
            recordingDate: item.date,
            canonicalEvidenceIds: mapped.map((entry) => entry.id).sort(),
            canonicalSourceSegmentIds: [
              ...new Set(mapped.flatMap((entry) => entry.sourceSegmentIds))
            ].sort(),
            mappable: mapped.length > 0
          };
        });
        return {
          memoryId: memory.id,
          type: memory.type,
          status: memory.status,
          title: memory.title,
          summary: memory.summary,
          importance: memory.importance,
          importanceScore: memory.importanceScore,
          firstSeenDate: memory.firstSeenDate,
          lastSeenDate: memory.lastSeenDate,
          occurrenceCount: memory.occurrenceCount,
          owner: {
            scope: owner?.scope ?? "unknown",
            type: owner?.owner.type ?? "unknown",
            identityId: owner?.owner.identityId ?? null,
            confidence: owner?.owner.confidence ?? 0,
            source: owner?.owner.source ?? "unknown",
            conflict
          },
          evidence,
          contentHash: embeddingContentHash(memoryEmbeddingText(memory)),
          modelRevision: options.memoryModelRevision
        };
      });
    const statusCount = (status: MemoryItem["status"]) =>
      frozenMemories.filter((memory) => memory.status === status).length;
    const ownerCount = (type: "known_identity" | "local_speaker" | "unknown") =>
      frozenMemories.filter((memory) => memory.owner.type === type).length;
    const mappable = frozenMemories.filter((memory) =>
      memory.evidence.some((item) => item.mappable)
    ).length;
    const uploadManifests = uploads.map((item) => ({
      uploadId: item.uploadId,
      recordingDate: item.recordingDate,
      transcriptSegmentCount: item.segments.length,
      transcriptHash: digest(item.segments.map((segment) => ({
        id: segment.id,
        text: segment.text,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds
      }))),
      eventClusterIds: item.eventClusterIds
    }));
    const fingerprints = canonicalFingerprints(canonicalEvidence);
    const baseManifest = {
      version: 1 as const,
      kind: "daily_brief_holdout_memory_manifest" as const,
      frozenAt: new Date().toISOString(),
      generatedBeforeQuestions: true as const,
      source: {
        sourceId: options.sourceId,
        datasetId: options.datasetId,
        runtimePath: relative(resolve("."), options.runtimePath).replaceAll("\\", "/"),
        userId: options.userId,
        benchmarkReportPath: relative(resolve("."), options.benchmarkReportPath)
          .replaceAll("\\", "/"),
        uploads: uploadManifests,
        transcriptSegmentCount: segments.length,
        transcriptHash: digest(uploadManifests.map((item) => item.transcriptHash)),
        eventClusterIds: [...new Set(
          uploadManifests.flatMap((item) => item.eventClusterIds)
        )].sort()
      },
      repository: {
        schemaVersion: MEMORY_SCHEMA_VERSION,
        sourceBuild: options.sourceBuild,
        memoryModelRevision: options.memoryModelRevision
      },
      canonicalUniverse: {
        evidenceCount: canonicalEvidence.length,
        ...fingerprints
      },
      counts: {
        total: frozenMemories.length,
        active: statusCount("active"),
        resolved: statusCount("resolved"),
        superseded: statusCount("superseded"),
        expired: statusCount("expired"),
        verifiedOwner: ownerCount("known_identity"),
        localOwner: ownerCount("local_speaker"),
        unknownOwner: ownerCount("unknown"),
        conflictOwner: frozenMemories.filter((memory) => memory.owner.conflict).length,
        canonicalMappable: mappable,
        unmappable: frozenMemories.length - mappable,
        evidenceRows: frozenMemories.reduce(
          (total, memory) => total + memory.evidence.length,
          0
        )
      },
      memories: frozenMemories
    };
    const manifest = {
      ...baseManifest,
      manifestHash: holdoutManifestHash(baseManifest)
    };
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, JSON.stringify(manifest, null, 2), "utf8");
    console.log(JSON.stringify({
      sourceId: options.sourceId,
      outputPath: options.outputPath,
      manifestHash: manifest.manifestHash,
      transcriptSegmentCount: segments.length,
      canonicalEvidenceCount: canonicalEvidence.length,
      memoryCounts: manifest.counts,
      ownerMetadataRows: owners.length
    }, null, 2));
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(
    `[freeze-hybrid-holdout-memory] failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exitCode = 1;
});
