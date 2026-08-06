import {
  buildCanonicalQaEvidence,
  type AnswerQuestionWithAIInput,
  type QaEvidenceRetrievalResult
} from "@/lib/server/retrieval/ai-qa";
import {
  canonicalEvidenceEmbeddingText,
  denseQuestionEmbeddingText,
  retrieveDenseEvidence
} from "./dense-retrieval";
import { embeddingContentHash, SqliteEmbeddingIndex } from "./embedding-index";
import { rankHybridEvidence } from "./evidence-ranking";
import {
  generateHybridCandidatesWithDiagnostics,
  hybridCandidateCitationValidity
} from "./hybrid-candidates";
import { buildHybridEvidenceRankingMetadata } from "./ranking-metadata";
import {
  assertLocalQwen4BConfig,
  hybridEmbeddingIndexPath,
  qwenEmbeddingProviderForPurpose
} from "./runtime-config";

export type ProductionHybridFallbackReason =
  | "missing_user"
  | "index_unavailable"
  | "index_incomplete"
  | "model_mismatch"
  | "embedding_unavailable"
  | "candidate_boundary";

export class ProductionHybridRetrievalError extends Error {
  constructor(
    readonly reason: ProductionHybridFallbackReason,
    message: string,
    readonly indexCoverage: number | null = null,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ProductionHybridRetrievalError";
  }
}

function canonicalEvidenceSourceUploadIds(
  qaInput: AnswerQuestionWithAIInput,
  canonicalEvidence: ReturnType<typeof buildCanonicalQaEvidence>
) {
  const evidenceInput = qaInput.hybridEvidenceInput ?? qaInput;
  const sources = [
    ...evidenceInput.segments,
    ...(evidenceInput.audioInsights ?? []),
    ...evidenceInput.semanticSegments,
    ...evidenceInput.briefItems,
    ...(evidenceInput.relationshipSignals ?? [])
  ];
  const ownerByObjectId = new Map<string, string>();
  const ambiguousObjectIds = new Set<string>();

  for (const source of sources) {
    const objectId = typeof source.id === "string" ? source.id.trim() : "";
    const sourceUploadId = typeof source.uploadId === "string"
      ? source.uploadId.trim()
      : "";
    if (!objectId || !sourceUploadId) {
      if (objectId) ambiguousObjectIds.add(objectId);
      continue;
    }
    const existingOwner = ownerByObjectId.get(objectId);
    if (existingOwner && existingOwner !== sourceUploadId) {
      ambiguousObjectIds.add(objectId);
      continue;
    }
    ownerByObjectId.set(objectId, sourceUploadId);
  }

  const canonicalOwners = new Map<string, string>();
  for (const evidence of canonicalEvidence) {
    const owner = ambiguousObjectIds.has(evidence.id)
      ? undefined
      : ownerByObjectId.get(evidence.id);
    if (owner && !canonicalOwners.has(evidence.id)) {
      canonicalOwners.set(evidence.id, owner);
    }
  }
  if (canonicalOwners.size !== canonicalEvidence.length) {
    const ownerCoverage = canonicalOwners.size / canonicalEvidence.length;
    throw new ProductionHybridRetrievalError(
      "index_incomplete",
      `Trusted source ownership covers ${canonicalOwners.size}/${canonicalEvidence.length} canonical items`,
      ownerCoverage
    );
  }
  return canonicalOwners;
}

function classifyError(error: unknown) {
  if (error instanceof ProductionHybridRetrievalError) return error;
  const message = error instanceof Error ? error.message : "unknown error";
  if (/model|revision|dimension/iu.test(message)) {
    return new ProductionHybridRetrievalError("model_mismatch", message, null, { cause: error });
  }
  if (/sqlite|database|sidecar|file/iu.test(message)) {
    return new ProductionHybridRetrievalError("index_unavailable", message, null, { cause: error });
  }
  return new ProductionHybridRetrievalError("embedding_unavailable", message, null, { cause: error });
}

export async function retrieveProductionHybridEvidence(input: {
  qaInput: AnswerQuestionWithAIInput;
  lexical: QaEvidenceRetrievalResult;
}) {
  if (!input.qaInput.userId) {
    throw new ProductionHybridRetrievalError(
      "missing_user",
      "Hybrid QA requires a trusted user id"
    );
  }
  const canonicalEvidence = buildCanonicalQaEvidence(input.qaInput);
  if (canonicalEvidence.length === 0) {
    return { evidence: [], denseRetrievalMs: 0, indexCoverage: 1 };
  }
  const sourceUploadIdByObjectId = canonicalEvidenceSourceUploadIds(
    input.qaInput,
    canonicalEvidence
  );
  try {
    const provider = qwenEmbeddingProviderForPurpose("query");
    assertLocalQwen4BConfig(provider);
    const index = new SqliteEmbeddingIndex(
      hybridEmbeddingIndexPath(input.qaInput.userId),
      provider.config,
      { readonly: true }
    );
    try {
      const entries = index.getMany(
        "evidence",
        canonicalEvidence.map((evidence) => evidence.id)
      );
      const currentById = new Map(canonicalEvidence.map((evidence) => [
        evidence.id,
        {
          contentHash: embeddingContentHash(canonicalEvidenceEmbeddingText(evidence)),
          sourceUploadId: sourceUploadIdByObjectId.get(evidence.id)
        }
      ]));
      const coveredIds = new Set(entries.flatMap((entry) => {
        const current = currentById.get(entry.objectId);
        return current?.contentHash === entry.contentHash &&
          current.sourceUploadId === entry.sourceUploadId
          ? [entry.objectId]
          : [];
      }));
      const indexCoverage = coveredIds.size / canonicalEvidence.length;
      if (coveredIds.size !== canonicalEvidence.length) {
        throw new ProductionHybridRetrievalError(
          "index_incomplete",
          `Hybrid sidecar covers ${coveredIds.size}/${canonicalEvidence.length} canonical items`,
          indexCoverage
        );
      }
      const denseStartedAt = performance.now();
      const queryVector = (
        await provider.embed([denseQuestionEmbeddingText(input.qaInput.question)])
      )[0];
      if (!queryVector) {
        throw new ProductionHybridRetrievalError(
          "embedding_unavailable",
          "Embedding provider did not return a Hybrid query vector",
          indexCoverage
        );
      }
      const denseCandidates = await retrieveDenseEvidence({
        question: input.qaInput.question,
        evidence: canonicalEvidence,
        provider,
        index,
        limit: 50,
        queryVector
      });
      const denseRetrievalMs = Math.max(0, Math.round(performance.now() - denseStartedAt));
      const metadata = buildHybridEvidenceRankingMetadata({
        evidence: canonicalEvidence,
        segments:
          input.qaInput.hybridEvidenceInput?.segments ?? input.qaInput.segments,
        memoryContext: input.qaInput.memoryContext
      });
      const hybrid = generateHybridCandidatesWithDiagnostics({
        question: input.qaInput.question,
        conversation: input.qaInput.conversation,
        evidence: canonicalEvidence,
        denseCandidates,
        currentCandidates: input.lexical.evidence,
        metadata,
        limit: 50,
        strategy: "uniform_rrf"
      });
      if (!hybridCandidateCitationValidity(hybrid.candidates, canonicalEvidence)) {
        throw new ProductionHybridRetrievalError(
          "candidate_boundary",
          "Hybrid candidates crossed the canonical citation boundary",
          indexCoverage
        );
      }
      const evidence = rankHybridEvidence({
        question: input.qaInput.question,
        candidates: hybrid.candidates,
        metadata,
        limit: 16,
        experiment: "phase3_1_minimal"
      }).map((candidate) => candidate.evidence);
      return { evidence, denseRetrievalMs, indexCoverage };
    } finally {
      index.close();
    }
  } catch (error) {
    throw classifyError(error);
  }
}
