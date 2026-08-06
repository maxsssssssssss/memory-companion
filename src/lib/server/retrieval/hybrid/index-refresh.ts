import type {
  AudioInsight,
  AudioUpload,
  BriefItem,
  RelationshipSignalCard,
  SemanticSegment,
  TranscriptSegment
} from "@/lib/domain/types";
import {
  applySpeakerAliasesToPayload,
  sanitizeSpeakerAliases,
  type StoredSpeakerAliases
} from "@/lib/domain/speaker-aliases";
import {
  applyAudioInsightCorrections,
  type StoredAudioInsightCorrections
} from "@/lib/domain/audio-insight-corrections";
import { buildCanonicalQaEvidenceCorpus } from "@/lib/server/retrieval/ai-qa";
import type { JsonStore } from "@/lib/server/storage/json-store";
import {
  canonicalEvidenceEmbeddingText,
  indexCanonicalEvidence
} from "./dense-retrieval";
import type { EmbeddingProvider } from "./embedding-provider";
import {
  embeddingContentHash,
  SqliteEmbeddingIndex
} from "./embedding-index";
import {
  completeHybridIndexDeletion,
  deleteHybridIndexRetentionManifest,
  listHybridIndexDeletions,
  listHybridIndexRetentionManifests,
  type HybridIndexRetentionEvidence
} from "./retention-manifest";
import {
  assertLocalQwen4BConfig,
  hybridEmbeddingIndexPath,
  qwenEmbeddingProviderForPurpose,
  QWEN3_EMBEDDING_4B_DIMENSION,
  QWEN3_EMBEDDING_4B_MODEL,
  QWEN3_EMBEDDING_4B_REVISION
} from "./runtime-config";

type ReadyUpload = AudioUpload & { status: "ready" };

export type HybridIndexRefreshProgress = {
  completed: number;
  total: number;
  stage: "loading" | "embedding" | "completed";
  uploadId?: string;
};

export async function canonicalEvidenceForUpload(store: JsonStore, upload: ReadyUpload) {
  const [
    segments,
    audioInsights,
    storedAudioInsightCorrections,
    semanticSegments,
    briefItems,
    relationshipSignals,
    storedSpeakerAliases
  ] = await Promise.all([
    store.read<TranscriptSegment[]>("segments", upload.id),
    store.read<AudioInsight[]>("audio-insights", upload.id),
    store.read<StoredAudioInsightCorrections>("audio-insight-corrections", upload.id),
    store.read<SemanticSegment[]>("semantic-segments", upload.id),
    store.read<BriefItem[]>("brief-items", upload.id),
    store.read<RelationshipSignalCard[]>("relationship-signals", upload.id),
    store.read<StoredSpeakerAliases>("speaker-aliases", upload.id)
  ]);
  const correctedAudioInsights = applyAudioInsightCorrections(
    audioInsights ?? [],
    storedAudioInsightCorrections?.corrections ?? {}
  );
  const aliased = applySpeakerAliasesToPayload(
    {
      segments: segments ?? [],
      audioInsights: correctedAudioInsights,
      semanticSegments: semanticSegments ?? [],
      briefItems: briefItems ?? []
    },
    sanitizeSpeakerAliases(storedSpeakerAliases?.aliases ?? {})
  );
  return buildCanonicalQaEvidenceCorpus({
    segments: aliased.segments,
    audioInsights: aliased.audioInsights ?? [],
    semanticSegments: aliased.semanticSegments ?? [],
    briefItems: aliased.briefItems,
    relationshipSignals: relationshipSignals ?? []
  });
}

function registerEvidenceIdentity(
  identity: Map<string, { uploadId: string; contentHash: string }>,
  uploadId: string,
  entry: HybridIndexRetentionEvidence
) {
  const existing = identity.get(entry.objectId);
  if (existing && (
    existing.uploadId !== uploadId ||
    existing.contentHash !== entry.contentHash
  )) {
    throw new Error(
      "Hybrid canonical Evidence id is shared by conflicting uploads or contents"
    );
  }
  identity.set(entry.objectId, { uploadId, contentHash: entry.contentHash });
}

/**
 * Privacy deletion is a local-only phase. It must not depend on lyc, on a
 * healthy retained snapshot for another upload, or on a full refresh.
 */
export async function deletePendingHybridIndexEvidence(input: {
  userId: string;
  store: JsonStore;
  indexPath?: string;
}) {
  const deletions = await listHybridIndexDeletions(input.store);
  const pending = deletions.filter((deletion) => deletion.status === "pending");
  if (pending.length === 0) {
    return { completed: 0, requested: 0, removed: 0, alreadyMissing: 0 };
  }
  const index = new SqliteEmbeddingIndex(
    input.indexPath ?? hybridEmbeddingIndexPath(input.userId),
    {
      modelName: QWEN3_EMBEDDING_4B_MODEL,
      modelVersion: QWEN3_EMBEDDING_4B_REVISION,
      dimension: QWEN3_EMBEDDING_4B_DIMENSION
    }
  );
  const deleted = {
    completed: 0,
    requested: 0,
    removed: 0,
    alreadyMissing: 0
  };
  try {
    for (const deletion of pending) {
      const result = index.deleteUpload({
        sourceUploadId: deletion.uploadId,
        expectedContentHashes: new Map(
          deletion.evidence.map((entry) => [entry.objectId, entry.contentHash])
        )
      });
      await deleteHybridIndexRetentionManifest(input.store, deletion.uploadId);
      await completeHybridIndexDeletion(input.store, {
        uploadId: deletion.uploadId,
        corpusHash: deletion.corpusHash
      });
      deleted.completed += 1;
      deleted.requested += result.requested;
      deleted.removed += result.removed;
      deleted.alreadyMissing += result.alreadyMissing;
    }
  } finally {
    index.close();
  }
  return deleted;
}

export async function loadHybridEvidenceCorpus(input: {
  store: JsonStore;
  onProgress?: (progress: HybridIndexRefreshProgress) => Promise<unknown> | unknown;
}) {
  const deletions = await listHybridIndexDeletions(input.store);
  const deletingUploadIds = new Set(
    deletions.map((deletion) => deletion.uploadId)
  );
  const readyUploads = (await input.store.list<AudioUpload>("uploads"))
    .map(({ value }) => value)
    .filter((upload): upload is ReadyUpload =>
      upload.status === "ready" && !deletingUploadIds.has(upload.id)
    )
    .sort((left, right) =>
      left.recordingDate.localeCompare(right.recordingDate) ||
      left.id.localeCompare(right.id)
    );
  const retainedManifests = (await listHybridIndexRetentionManifests(input.store))
    .filter((manifest) => !deletingUploadIds.has(manifest.uploadId));
  const uploadEvidence: Array<{
    upload: ReadyUpload;
    evidence: ReturnType<typeof buildCanonicalQaEvidenceCorpus>;
  }> = [];
  for (const [index, upload] of readyUploads.entries()) {
    await input.onProgress?.({
      completed: index,
      total: readyUploads.length,
      stage: "loading",
      uploadId: upload.id
    });
    uploadEvidence.push({
      upload,
      evidence: await canonicalEvidenceForUpload(input.store, upload)
    });
  }
  await input.onProgress?.({
    completed: readyUploads.length,
    total: readyUploads.length,
    stage: "loading"
  });
  const identity = new Map<string, { uploadId: string; contentHash: string }>();
  const sourceUploadIdByObjectId = new Map<string, string>();
  for (const snapshot of uploadEvidence) {
    for (const evidence of snapshot.evidence) {
      registerEvidenceIdentity(identity, snapshot.upload.id, {
        objectId: evidence.id,
        contentHash: embeddingContentHash(canonicalEvidenceEmbeddingText(evidence))
      });
      sourceUploadIdByObjectId.set(evidence.id, snapshot.upload.id);
    }
  }
  for (const manifest of retainedManifests) {
    for (const entry of manifest.evidence) {
      registerEvidenceIdentity(identity, manifest.uploadId, entry);
    }
  }
  for (const deletion of deletions) {
    for (const entry of deletion.evidence) {
      if (identity.has(entry.objectId)) {
        throw new Error(
          "Hybrid deletion Evidence id is still referenced by another live or retained upload"
        );
      }
    }
  }
  return {
    uploads: readyUploads,
    uploadEvidence,
    evidence: uploadEvidence.flatMap((snapshot) => snapshot.evidence),
    retainedManifests,
    deletions,
    retainedObjectIds: new Set(identity.keys()),
    sourceUploadIdByObjectId
  };
}

export async function refreshHybridEvidenceIndex(input: {
  userId: string;
  store: JsonStore;
  provider?: EmbeddingProvider;
  indexPath?: string;
  batchSize?: number;
  onProgress?: (progress: HybridIndexRefreshProgress) => Promise<unknown> | unknown;
}) {
  const deleted = await deletePendingHybridIndexEvidence({
    userId: input.userId,
    store: input.store,
    indexPath: input.indexPath
  });
  const corpus = await loadHybridEvidenceCorpus({
    store: input.store,
    onProgress: input.onProgress
  });
  const provider = input.provider ?? qwenEmbeddingProviderForPurpose("index");
  if (!input.provider) assertLocalQwen4BConfig(provider);
  await input.onProgress?.({
    completed: 0,
    total: corpus.evidence.length,
    stage: "embedding"
  });
  const index = new SqliteEmbeddingIndex(
    input.indexPath ?? hybridEmbeddingIndexPath(input.userId),
    provider.config
  );
  try {
    for (const manifest of corpus.retainedManifests) {
      const expected = new Map(
        manifest.evidence.map((entry) => [entry.objectId, entry.contentHash])
      );
      index.claimLegacyOwnership({
        objectType: "evidence",
        sourceUploadId: manifest.uploadId,
        expectedContentHashes: expected
      });
    }
    const result = await indexCanonicalEvidence({
      evidence: corpus.evidence,
      sourceUploadIdByObjectId: corpus.sourceUploadIdByObjectId,
      provider,
      index,
      batchSize: input.batchSize ?? 16,
      retainedObjectIds: corpus.retainedObjectIds,
      onProgress: async ({ completed, total }) => {
        await input.onProgress?.({
          completed: corpus.evidence.length - total + completed,
          total: corpus.evidence.length,
          stage: "embedding"
        });
      }
    });
    await input.onProgress?.({
      completed: corpus.evidence.length,
      total: corpus.evidence.length,
      stage: "completed"
    });
    return {
      uploadCount: corpus.uploads.length,
      retainedUploadCount: corpus.retainedManifests.length,
      completedDeletionCount: deleted.completed,
      ...result,
      removed: result.removed + deleted.removed
    };
  } finally {
    index.close();
  }
}
