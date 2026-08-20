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
  buildCanonicalQaEvidenceCorpus,
  type QaRetrievedEvidence
} from "@/lib/server/retrieval/ai-qa";
import type { JsonStore } from "@/lib/server/storage/json-store";
import {
  resolveRetrievalUpload,
  type RetrievalUploadResolution
} from "../source-awareness";
import { indexCanonicalEvidence } from "./dense-retrieval";
import type { EmbeddingProvider } from "./embedding-provider";
import { SqliteEmbeddingIndex } from "./embedding-index";
import {
  assertLocalQwen4BConfig,
  hybridEmbeddingIndexPath,
  qwenEmbeddingProviderForPurpose
} from "./runtime-config";

type ReadyUpload = AudioUpload & {
  status: "ready";
};

export type HybridIndexRefreshProgress = {
  completed: number;
  total: number;
  stage: "loading" | "embedding" | "completed";
  uploadId?: string;
};

async function canonicalEvidenceForUpload(
  store: JsonStore,
  upload: ReadyUpload,
  source: RetrievalUploadResolution
) {
  if (source.attribution.origin === "user_reflection") {
    return buildCanonicalQaEvidenceCorpus({
      segments: source.canonicalSegments ?? [],
      audioInsights: [],
      semanticSegments: [],
      briefItems: [],
      relationshipSignals: []
    });
  }
  const [
    segments,
    audioInsights,
    semanticSegments,
    briefItems,
    relationshipSignals,
    storedSpeakerAliases
  ] = await Promise.all([
    store.read<TranscriptSegment[]>("segments", upload.id),
    store.read<AudioInsight[]>("audio-insights", upload.id),
    store.read<SemanticSegment[]>("semantic-segments", upload.id),
    store.read<BriefItem[]>("brief-items", upload.id),
    store.read<RelationshipSignalCard[]>("relationship-signals", upload.id),
    store.read<StoredSpeakerAliases>("speaker-aliases", upload.id)
  ]);
  const aliased = applySpeakerAliasesToPayload(
    {
      segments: segments ?? [],
      audioInsights: audioInsights ?? [],
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

export async function loadHybridEvidenceCorpus(input: {
  userId: string;
  store: JsonStore;
  onProgress?: (progress: HybridIndexRefreshProgress) => Promise<unknown> | unknown;
  resolveUploadSource?: typeof resolveRetrievalUpload;
}) {
  const sourceResolver = input.resolveUploadSource ?? resolveRetrievalUpload;
  const readyUploads = (await input.store.list<AudioUpload>("uploads"))
    .map(({ value }) => value)
    .filter((upload): upload is ReadyUpload => upload.status === "ready")
    .sort((left, right) =>
      left.recordingDate.localeCompare(right.recordingDate) ||
      left.id.localeCompare(right.id)
    )
    .flatMap((upload) => {
      const source = sourceResolver({ userId: input.userId, upload });
      return source.visible ? [{ upload, source }] : [];
    });
  const evidence: QaRetrievedEvidence[] = [];
  for (const [index, { upload, source }] of readyUploads.entries()) {
    await input.onProgress?.({
      completed: index,
      total: readyUploads.length,
      stage: "loading",
      uploadId: upload.id
    });
    evidence.push(...await canonicalEvidenceForUpload(input.store, upload, source));
  }
  await input.onProgress?.({
    completed: readyUploads.length,
    total: readyUploads.length,
    stage: "loading"
  });
  return {
    uploads: readyUploads.map(({ upload }) => upload),
    evidence: [...new Map(evidence.map((item) => [item.id, item])).values()]
  };
}

export async function refreshHybridEvidenceIndex(input: {
  userId: string;
  store: JsonStore;
  provider?: EmbeddingProvider;
  indexPath?: string;
  batchSize?: number;
  onProgress?: (progress: HybridIndexRefreshProgress) => Promise<unknown> | unknown;
  resolveUploadSource?: typeof resolveRetrievalUpload;
}) {
  const corpus = await loadHybridEvidenceCorpus({
    userId: input.userId,
    store: input.store,
    onProgress: input.onProgress,
    resolveUploadSource: input.resolveUploadSource
  });
  const provider = input.provider ?? qwenEmbeddingProviderForPurpose("index");
  if (!input.provider) {
    assertLocalQwen4BConfig(provider);
  }
  const totalWork = corpus.evidence.length;
  await input.onProgress?.({
    completed: 0,
    total: totalWork,
    stage: "embedding"
  });
  const index = new SqliteEmbeddingIndex(
    input.indexPath ?? hybridEmbeddingIndexPath(input.userId),
    provider.config
  );
  try {
    const indexing = await indexCanonicalEvidence({
      evidence: corpus.evidence,
      provider,
      index,
      batchSize: input.batchSize ?? 16,
      onProgress: async ({ completed, total }) => {
        await input.onProgress?.({
          completed: corpus.evidence.length - total + completed,
          total: totalWork,
          stage: "embedding"
        });
      }
    });
    await input.onProgress?.({
      completed: totalWork,
      total: totalWork,
      stage: "completed"
    });
    return {
      uploadCount: corpus.uploads.length,
      ...indexing
    };
  } finally {
    index.close();
  }
}
