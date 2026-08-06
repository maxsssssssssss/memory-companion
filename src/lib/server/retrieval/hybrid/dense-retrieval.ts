import type { QaRetrievedEvidence } from "../ai-qa";
import {
  cosineSimilarity,
  type EmbeddingProvider
} from "./embedding-provider";
import {
  SqliteEmbeddingIndex,
  embeddingContentHash
} from "./embedding-index";

const DEFAULT_EMBEDDING_BATCH_SIZE = 16;

export type DenseEvidenceCandidate = {
  rank: number;
  score: number;
  evidence: QaRetrievedEvidence;
};

export type EvidenceIndexingResult = {
  total: number;
  embedded: number;
  unchanged: number;
  removed: number;
};

export function canonicalEvidenceEmbeddingText(evidence: QaRetrievedEvidence) {
  return `${evidence.title.trim()}\n${evidence.text.trim()}`
    .normalize("NFKC")
    .replace(/^\d{4}-\d{2}-\d{2}\s*·\s*/gmu, "")
    .replace(/\[\d{4}-\d{2}-\d{2}\]\s*/gmu, "");
}

export function denseQuestionEmbeddingText(question: string) {
  return [
    "Instruct: Given a Chinese personal-memory question, retrieve canonical evidence that directly supports the answer while preserving temporal, lifecycle, relationship, preference, and decision meaning.",
    `Query: ${question.normalize("NFKC").trim()}`
  ].join("\n");
}

export async function indexCanonicalEvidence(input: {
  evidence: readonly QaRetrievedEvidence[];
  sourceUploadIdByObjectId: ReadonlyMap<string, string>;
  provider: EmbeddingProvider;
  index: SqliteEmbeddingIndex;
  batchSize?: number;
  retainedObjectIds?: ReadonlySet<string>;
  onProgress?: (progress: {
    completed: number;
    total: number;
  }) => Promise<unknown> | unknown;
}): Promise<EvidenceIndexingResult> {
  if (
    input.provider.config.modelName !== input.index.model.modelName ||
    input.provider.config.modelVersion !== input.index.model.modelVersion ||
    input.provider.config.dimension !== input.index.model.dimension
  ) {
    throw new Error("embedding provider and sidecar model configuration must match");
  }
  const batchSize = Math.max(1, Math.floor(input.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE));
  const uniqueEvidence = [...new Map(input.evidence.map((item) => [item.id, item])).values()];
  if (uniqueEvidence.length !== input.evidence.length) {
    throw new Error("canonical Evidence ids must be unique before indexing");
  }
  const sourceUploadIdFor = (objectId: string) => {
    const sourceUploadId = input.sourceUploadIdByObjectId.get(objectId)?.trim();
    if (!sourceUploadId) {
      throw new Error("canonical Evidence is missing a source upload owner");
    }
    return sourceUploadId;
  };
  const pending = uniqueEvidence.flatMap((evidence) => {
    const text = canonicalEvidenceEmbeddingText(evidence);
    const contentHash = embeddingContentHash(text);
    const sourceUploadId = sourceUploadIdFor(evidence.id);
    const existing = input.index.get("evidence", evidence.id);
    if (
      existing?.sourceUploadId !== null &&
      existing?.sourceUploadId !== undefined &&
      existing.sourceUploadId !== sourceUploadId
    ) {
      throw new Error("canonical Evidence source upload ownership changed");
    }
    return existing?.contentHash === contentHash &&
      existing.sourceUploadId === sourceUploadId
      ? []
      : [{ evidence, text, contentHash, sourceUploadId }];
  });
  const pendingUpserts: Array<{
    objectType: "evidence";
    objectId: string;
    sourceUploadId: string;
    contentHash: string;
    vector: number[];
  }> = [];
  await input.onProgress?.({ completed: 0, total: pending.length });

  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize);
    const vectors = await input.provider.embed(batch.map((item) => item.text));
    if (vectors.length !== batch.length) {
      throw new Error("embedding provider returned an unexpected vector count");
    }
    batch.forEach((item, index) => {
      pendingUpserts.push({
        objectType: "evidence",
        objectId: item.evidence.id,
        sourceUploadId: item.sourceUploadId,
        contentHash: item.contentHash,
        vector: vectors[index]!
      });
    });
    await input.onProgress?.({
      completed: Math.min(offset + batch.length, pending.length),
      total: pending.length
    });
  }

  const retainedIds = new Set([
    ...uniqueEvidence.map((item) => item.id),
    ...(input.retainedObjectIds ?? [])
  ]);
  const snapshot = input.index.applySnapshot({
    objectType: "evidence",
    retainedObjectIds: retainedIds,
    upserts: pendingUpserts
  });
  return {
    total: uniqueEvidence.length,
    embedded: pending.length,
    unchanged: uniqueEvidence.length - pending.length,
    removed: snapshot.removed
  };
}

export async function retrieveDenseEvidence(input: {
  question: string;
  evidence: readonly QaRetrievedEvidence[];
  provider: EmbeddingProvider;
  index: SqliteEmbeddingIndex;
  limit?: number;
  contentHashPolicy?: "strict" | "object_id";
  queryVector?: readonly number[];
}): Promise<DenseEvidenceCandidate[]> {
  const limit = Math.max(1, Math.floor(input.limit ?? 30));
  const queryVector = input.queryVector ??
    (await input.provider.embed([denseQuestionEmbeddingText(input.question)]))[0];
  if (!queryVector) throw new Error("embedding provider did not return a query vector");
  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));

  return input.index
    .getMany("evidence", [...evidenceById.keys()])
    .flatMap((entry) => {
      const evidence = evidenceById.get(entry.objectId);
      if (!evidence) return [];
      const currentHash = embeddingContentHash(canonicalEvidenceEmbeddingText(evidence));
      if ((input.contentHashPolicy ?? "strict") === "strict" && entry.contentHash !== currentHash) {
        return [];
      }
      return [{
        score: cosineSimilarity(queryVector, entry.vector),
        evidence
      }];
    })
    .sort((left, right) =>
      right.score - left.score ||
      right.evidence.priority - left.evidence.priority ||
      left.evidence.id.localeCompare(right.evidence.id)
    )
    .slice(0, limit)
    .map((candidate, index) => ({
      rank: index + 1,
      score: candidate.score,
      evidence: candidate.evidence
    }));
}
