import { createHash } from "node:crypto";

import type { QuestionAnswer } from "@/lib/domain/types";
import {
  analyzeQaQueryIntent,
  buildCanonicalQaEvidence,
  prepareQaSelectedEvidenceForEvaluation,
  type AnswerQuestionWithAIInput,
  type QaEvidenceRetrievalResult,
  type QaLexicalReviewCandidate,
  type QaRetrievedEvidence
} from "@/lib/server/retrieval/ai-qa";
import {
  canonicalEvidenceEmbeddingText,
  denseQuestionEmbeddingText,
  retrieveDenseEvidence
} from "@/lib/server/retrieval/hybrid/dense-retrieval";
import {
  embeddingContentHash,
  SqliteEmbeddingIndex,
  type EmbeddingIndexEntry
} from "@/lib/server/retrieval/hybrid/embedding-index";
import type {
  EmbeddingModelConfig,
  EmbeddingProvider
} from "@/lib/server/retrieval/hybrid/embedding-provider";
import {
  rankHybridEvidenceForReview,
  type RankedHybridEvidence
} from "@/lib/server/retrieval/hybrid/evidence-ranking";
import {
  generateHybridCandidatesWithDiagnostics,
  hybridCandidateCitationValidity
} from "@/lib/server/retrieval/hybrid/hybrid-candidates";
import { buildHybridEvidenceRankingMetadata } from "@/lib/server/retrieval/hybrid/ranking-metadata";
import {
  assertLocalQwen4BConfig,
  hybridEmbeddingIndexPath,
  qwenEmbeddingProviderForPurpose,
  QWEN3_EMBEDDING_4B_DIMENSION,
  QWEN3_EMBEDDING_4B_MODEL,
  QWEN3_EMBEDDING_4B_REVISION
} from "@/lib/server/retrieval/hybrid/runtime-config";
import { PHASE_3_1_RANKING_VERSION } from "@/lib/server/retrieval/hybrid/shadow-baseline";
import type { EvidenceRankingMetadata } from "@/lib/server/retrieval/hybrid/types";
import type { VoiceSessionTrace } from "@/lib/server/voice-qa/trace";
import { VoiceQaShadowReviewRepository } from "./voice-qa-shadow-review-repository";

export const VOICE_QA_SHADOW_REVIEW_VERSION = "voice_qa_shadow_review_v1";
export const VOICE_QA_SHADOW_CANONICAL_EVIDENCE_VERSION =
  "canonical_qa_evidence_v1";
export const VOICE_QA_SHADOW_REVIEW_TARGET = 60;
export const VOICE_QA_SHADOW_REVIEW_FUSION = "uniform_rrf";
export const VOICE_QA_SHADOW_REVIEW_RANKING = "phase3_1_minimal";
const VOICE_QA_LOCAL_EVIDENCE_DELIMITER = "\n\n本地证据：\n";

type ReviewSystem = "A" | "B";
type ReviewFallbackReason =
  | "index_unavailable"
  | "index_incomplete"
  | "model_mismatch"
  | "embedding_unavailable"
  | "candidate_boundary"
  | "collector_unavailable";

export type VoiceQaShadowReviewCandidate = {
  evidenceId: string;
  rank: number;
  selectedTop16: boolean;
  score: number | null;
  reasons: string[];
  details: Record<string, unknown>;
};

export type VoiceQaShadowReviewSystemResult = {
  system: ReviewSystem;
  inputHash: string;
  top30: VoiceQaShadowReviewCandidate[];
  top16EvidenceIds: string[];
  orderHash: string;
  canonicalCandidateValidity: boolean;
  retrievalMs: number;
  denseMs: number | null;
  fallbackReason: ReviewFallbackReason | null;
};

export type VoiceQaShadowReviewRetrievalSnapshot = {
  version: typeof VOICE_QA_SHADOW_REVIEW_VERSION;
  caseId: string;
  userId: string;
  scope: "current" | "week" | "all";
  voiceSessionId: string;
  traceId: string;
  asrText: string;
  asrHash: string;
  conversation: AnswerQuestionWithAIInput["conversation"];
  conversationHash: string;
  replayInput: VoiceQaShadowReviewReplayInput;
  canonicalEvidence: QaRetrievedEvidence[];
  canonicalUniverseHash: string;
  canonicalContentHash: string;
  canonicalSnapshotId: string;
  inputHash: string;
  flatSnapshotFingerprint: string | null;
  embedding: EmbeddingModelConfig;
  fusion: typeof VOICE_QA_SHADOW_REVIEW_FUSION;
  rankingVersion: typeof PHASE_3_1_RANKING_VERSION;
  algorithmFingerprint: string;
  codeFingerprint: string;
  queryVector: number[] | null;
  queryVectorHash: string | null;
  rankingMetadata: Array<[string, EvidenceRankingMetadata]>;
  memorySourceIds: string[];
  systems: Record<ReviewSystem, VoiceQaShadowReviewSystemResult>;
  backgroundRetrievalMs: number;
};

export type VoiceQaShadowReviewReplayInput = Pick<
  AnswerQuestionWithAIInput,
  | "uploadId"
  | "question"
  | "conversation"
  | "scope"
  | "segments"
  | "audioInsights"
  | "semanticSegments"
  | "briefItems"
  | "relationshipSignals"
  | "memoryContext"
  | "memoryIndexFallback"
  | "answerMode"
  | "memoryRetrievalMs"
>;

export type VoiceQaShadowReviewDependencies = {
  provider?: EmbeddingProvider;
  flatIndex?: SqliteEmbeddingIndex;
  now?: () => number;
};

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonHash(value: unknown) {
  return sha256(JSON.stringify(value));
}

function vectorBuffer(vector: readonly number[]) {
  const buffer = Buffer.allocUnsafe(
    vector.length * Float32Array.BYTES_PER_ELEMENT
  );
  vector.forEach((value, index) =>
    buffer.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT)
  );
  return buffer;
}

function replayInputSnapshot(
  input: AnswerQuestionWithAIInput
): VoiceQaShadowReviewReplayInput {
  return {
    uploadId: input.uploadId,
    question: input.question,
    ...(input.conversation
      ? { conversation: input.conversation.map((message) => ({ ...message })) }
      : {}),
    scope: input.scope ?? "current",
    segments: input.segments.map((segment) => ({ ...segment })),
    ...(input.audioInsights
      ? { audioInsights: input.audioInsights.map((item) => ({ ...item })) }
      : {}),
    semanticSegments: input.semanticSegments.map((item) => ({ ...item })),
    briefItems: input.briefItems.map((item) => ({ ...item })),
    ...(input.relationshipSignals
      ? {
          relationshipSignals: input.relationshipSignals.map((item) => ({
            ...item
          }))
        }
      : {}),
    ...(input.memoryContext
      ? {
          memoryContext: {
            ...input.memoryContext,
            memories: input.memoryContext.memories.map((item) => ({ ...item })),
            ...(input.memoryContext.ownerAttributions
              ? {
                  ownerAttributions:
                    input.memoryContext.ownerAttributions.map((item) => ({
                      ...item
                    }))
                }
              : {}),
            evidence: input.memoryContext.evidence.map((item) => ({ ...item })),
            sourceIds: [...input.memoryContext.sourceIds],
            distinctDates: [...input.memoryContext.distinctDates]
          }
        }
      : {}),
    ...(input.memoryIndexFallback === undefined
      ? {}
      : { memoryIndexFallback: input.memoryIndexFallback }),
    ...(input.answerMode ? { answerMode: input.answerMode } : {}),
    ...(input.memoryRetrievalMs === undefined
      ? {}
      : { memoryRetrievalMs: input.memoryRetrievalMs })
  };
}

function canonicalHashes(evidence: readonly QaRetrievedEvidence[]) {
  const sorted = [...evidence].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const canonicalUniverseHash = jsonHash(
    sorted.map((item) => ({
      id: item.id,
      sourceSegmentIds: [...item.sourceSegmentIds].sort()
    }))
  );
  const canonicalContentHash = jsonHash(
    sorted.map((item) => ({
      id: item.id,
      title: item.title,
      text: item.text,
      priority: item.priority,
      startSeconds: item.startSeconds,
      endSeconds: item.endSeconds,
      sourceSegmentIds: [...item.sourceSegmentIds]
    }))
  );
  return {
    canonicalUniverseHash,
    canonicalContentHash,
    canonicalSnapshotId: jsonHash({
      kind: "voice_qa_canonical_snapshot_v1",
      canonicalUniverseHash,
      canonicalContentHash
    })
  };
}

function entryVectorHash(entry: EmbeddingIndexEntry) {
  return sha256(vectorBuffer(entry.vector));
}

function flatSnapshotFingerprint(input: {
  model: EmbeddingModelConfig;
  entries: readonly EmbeddingIndexEntry[];
}) {
  return jsonHash({
    kind: "evaluation_flat_snapshot_fingerprint_v1",
    model: input.model,
    entries: [...input.entries]
      .sort((left, right) => left.objectId.localeCompare(right.objectId))
      .map((entry) => ({
        objectId: entry.objectId,
        contentHash: entry.contentHash,
        vectorHash: entryVectorHash(entry)
      }))
  });
}

function candidateMatchesCanonical(
  evidence: QaRetrievedEvidence,
  canonicalById: ReadonlyMap<string, QaRetrievedEvidence>
) {
  const canonical = canonicalById.get(evidence.id);
  return Boolean(
    canonical &&
    canonical.sourceSegmentIds.length > 0 &&
    canonical.sourceSegmentIds.length === evidence.sourceSegmentIds.length &&
    canonical.sourceSegmentIds.every(
      (sourceId, index) => sourceId === evidence.sourceSegmentIds[index]
    )
  );
}

function lexicalCandidate(
  candidate: QaLexicalReviewCandidate,
  index: number
): VoiceQaShadowReviewCandidate {
  return {
    evidenceId: candidate.evidence.id,
    rank: index + 1,
    selectedTop16: index < 16,
    score: candidate.score,
    reasons: [...candidate.reasons],
    details: {
      duplicateRank: candidate.duplicateRank,
      lifecycleState: candidate.lifecycleState,
      topicOverlap: candidate.topicOverlap,
      representative: candidate.representative
    }
  };
}

function hybridCandidate(
  candidate: RankedHybridEvidence,
  index: number
): VoiceQaShadowReviewCandidate {
  return {
    evidenceId: candidate.evidence.id,
    rank: index + 1,
    selectedTop16: index < 16,
    score: candidate.score,
    reasons: [...candidate.rankingGuards],
    details: {
      originalRank: candidate.originalRank,
      rrfScore: candidate.rrfScore,
      denseScore: candidate.denseScore ?? null,
      structuredScore: candidate.structuredScore ?? null,
      channelRanks: candidate.channelRanks,
      features: candidate.features,
      weights: candidate.weights,
      contributions: candidate.contributions,
      lifecycleState: candidate.lifecycleState,
      lifecycleTopicOverlap: candidate.lifecycleTopicOverlap,
      relevanceGate: candidate.relevanceGate
    }
  };
}

function systemResult(input: {
  system: ReviewSystem;
  inputHash: string;
  candidates: VoiceQaShadowReviewCandidate[];
  canonicalById: ReadonlyMap<string, QaRetrievedEvidence>;
  retrievalMs: number;
  denseMs?: number | null;
  fallbackReason?: ReviewFallbackReason | null;
}) {
  const top30 = input.candidates.slice(0, 30);
  return {
    system: input.system,
    inputHash: input.inputHash,
    top30,
    top16EvidenceIds: top30.slice(0, 16).map((item) => item.evidenceId),
    orderHash: jsonHash(top30.map((item) => ({
      evidenceId: item.evidenceId,
      rank: item.rank,
      selectedRank: item.selectedTop16 ? item.rank : null
    }))),
    canonicalCandidateValidity: top30.every((candidate) => {
      const evidence = input.canonicalById.get(candidate.evidenceId);
      return evidence
        ? candidateMatchesCanonical(evidence, input.canonicalById)
        : false;
    }),
    retrievalMs: input.retrievalMs,
    denseMs: input.denseMs ?? null,
    fallbackReason: input.fallbackReason ?? null
  } satisfies VoiceQaShadowReviewSystemResult;
}

function fallbackReason(error: unknown): ReviewFallbackReason {
  const message = error instanceof Error ? error.message : "";
  if (/model|revision|dimension/iu.test(message)) return "model_mismatch";
  if (/covers|coverage|incomplete|missing vector/iu.test(message)) {
    return "index_incomplete";
  }
  if (/sqlite|database|sidecar|file|snapshot/iu.test(message)) {
    return "index_unavailable";
  }
  if (/candidate|canonical/iu.test(message)) return "candidate_boundary";
  return "embedding_unavailable";
}

function emptySystemResult(input: {
  system: ReviewSystem;
  inputHash: string;
  canonicalById: ReadonlyMap<string, QaRetrievedEvidence>;
  retrievalMs: number;
  fallbackReason: ReviewFallbackReason;
}) {
  return systemResult({
    ...input,
    candidates: []
  });
}

export async function runVoiceQaShadowReviewRetrieval(input: {
  caseId: string;
  qaInput: AnswerQuestionWithAIInput;
  lexical: QaEvidenceRetrievalResult;
  dependencies?: VoiceQaShadowReviewDependencies;
}): Promise<VoiceQaShadowReviewRetrievalSnapshot> {
  const userId = input.qaInput.userId;
  const context = input.qaInput.shadowReviewContext;
  if (!userId || !context) {
    throw new Error("Voice QA shadow review requires trusted user and trace context");
  }
  const now = input.dependencies?.now ?? (() => performance.now());
  const backgroundStartedAt = now();
  const scope = input.qaInput.scope ?? "current";
  const canonicalEvidence = buildCanonicalQaEvidence(input.qaInput);
  const canonicalById = new Map(
    canonicalEvidence.map((evidence) => [evidence.id, evidence])
  );
  const hashes = canonicalHashes(canonicalEvidence);
  const conversation = input.qaInput.conversation
    ? input.qaInput.conversation.map((message) => ({ ...message }))
    : undefined;
  const asrHash = sha256(input.qaInput.question);
  const conversationHash = jsonHash(conversation ?? []);
  const inputHash = jsonHash({
    scope,
    asrHash,
    conversationHash,
    canonicalUniverseHash: hashes.canonicalUniverseHash,
    canonicalContentHash: hashes.canonicalContentHash
  });
  const lexicalCandidates = (input.lexical.reviewRanking ?? []).map(
    lexicalCandidate
  );
  const lexicalReviewAvailable = input.lexical.reviewRanking !== undefined;
  const systems = {
    A: systemResult({
      system: "A",
      inputHash,
      candidates: lexicalCandidates,
      canonicalById,
      retrievalMs:
        input.lexical.relationshipContextBuildingMs +
        input.lexical.rerankingMs
    }),
    B: emptySystemResult({
      system: "B",
      inputHash,
      canonicalById,
      retrievalMs: 0,
      fallbackReason: "collector_unavailable"
    })
  } satisfies Record<ReviewSystem, VoiceQaShadowReviewSystemResult>;
  if (!lexicalReviewAvailable && input.lexical.evidence.length > 0) {
    systems.A = {
      ...systems.A,
      canonicalCandidateValidity: false,
      fallbackReason: "collector_unavailable"
    };
  }
  const metadata = buildHybridEvidenceRankingMetadata({
    evidence: canonicalEvidence,
    segments: input.qaInput.segments,
    memoryContext: input.qaInput.memoryContext
  });
  const provider =
    input.dependencies?.provider ?? qwenEmbeddingProviderForPurpose("query");
  let flatIndex = input.dependencies?.flatIndex;
  const ownsFlatIndex = !flatIndex;
  let queryVector: number[] | null = null;
  let queryVectorHash: string | null = null;
  let flatFingerprint: string | null = null;

  try {
    assertLocalQwen4BConfig(provider);
    if (canonicalEvidence.length === 0) {
      systems.B = systemResult({
        system: "B",
        inputHash,
        candidates: [],
        canonicalById,
        retrievalMs: 0,
        denseMs: 0
      });
    } else {
      flatIndex ??= new SqliteEmbeddingIndex(
        hybridEmbeddingIndexPath(userId),
        provider.config,
        { readonly: true }
      );
      const entries = flatIndex.getMany(
        "evidence",
        canonicalEvidence.map((evidence) => evidence.id)
      );
      const currentHashById = new Map(
        canonicalEvidence.map((evidence) => [
          evidence.id,
          embeddingContentHash(canonicalEvidenceEmbeddingText(evidence))
        ])
      );
      const coveredEntries = entries.filter(
        (entry) =>
          currentHashById.get(entry.objectId) === entry.contentHash
      );
      if (coveredEntries.length !== canonicalEvidence.length) {
        throw new Error(
          `embedding sidecar covers ${coveredEntries.length}/${canonicalEvidence.length} canonical items`
        );
      }
      flatFingerprint = flatSnapshotFingerprint({
        model: provider.config,
        // The snapshot identifies the frozen physical sidecar, not this
        // question's scoped canonical universe. Coverage is still checked
        // above against the scoped getMany result.
        entries: flatIndex.list("evidence")
      });
      const denseStartedAt = now();
      queryVector =
        (await provider.embed([
          denseQuestionEmbeddingText(input.qaInput.question)
        ]))[0] ?? null;
      if (!queryVector) {
        throw new Error("embedding provider did not return a review query vector");
      }
      queryVectorHash = sha256(vectorBuffer(queryVector));
      const denseCandidates = await retrieveDenseEvidence({
        question: input.qaInput.question,
        evidence: canonicalEvidence,
        provider,
        index: flatIndex,
        limit: 50,
        queryVector
      });
      const denseMs = Math.max(0, Math.round(now() - denseStartedAt));
      const hybrid = generateHybridCandidatesWithDiagnostics({
        question: input.qaInput.question,
        conversation: input.qaInput.conversation,
        evidence: canonicalEvidence,
        denseCandidates,
        currentCandidates: input.lexical.evidence,
        metadata,
        limit: 50,
        strategy: VOICE_QA_SHADOW_REVIEW_FUSION
      });
      if (!hybridCandidateCitationValidity(hybrid.candidates, canonicalEvidence)) {
        throw new Error("Hybrid review candidates crossed the canonical boundary");
      }
      const rankedB = rankHybridEvidenceForReview({
        question: input.qaInput.question,
        candidates: hybrid.candidates,
        metadata,
        experiment: VOICE_QA_SHADOW_REVIEW_RANKING
      });
      systems.B = systemResult({
        system: "B",
        inputHash,
        candidates: rankedB.map((candidate, index) =>
          hybridCandidate(candidate, index)
        ),
        canonicalById,
        retrievalMs: Math.max(0, Math.round(now() - backgroundStartedAt)),
        denseMs
      });

    }
  } catch (error) {
    const reason = fallbackReason(error);
    const elapsed = Math.max(0, Math.round(now() - backgroundStartedAt));
    systems.B = emptySystemResult({
      system: "B",
      inputHash,
      canonicalById,
      retrievalMs: elapsed,
      fallbackReason: reason
    });
  } finally {
    if (ownsFlatIndex) flatIndex?.close();
  }

  const algorithmFingerprint = jsonHash({
    version: VOICE_QA_SHADOW_REVIEW_VERSION,
    embedding: {
      modelName: QWEN3_EMBEDDING_4B_MODEL,
      modelVersion: QWEN3_EMBEDDING_4B_REVISION,
      dimension: QWEN3_EMBEDDING_4B_DIMENSION
    },
    fusion: VOICE_QA_SHADOW_REVIEW_FUSION,
    rankingVersion: PHASE_3_1_RANKING_VERSION,
    rankingExperiment: VOICE_QA_SHADOW_REVIEW_RANKING
  });
  return {
    version: VOICE_QA_SHADOW_REVIEW_VERSION,
    caseId: input.caseId,
    userId,
    scope,
    voiceSessionId: context.voiceSessionId,
    traceId: context.traceId,
    asrText: input.qaInput.question,
    asrHash,
    conversation,
    conversationHash,
    replayInput: replayInputSnapshot(input.qaInput),
    canonicalEvidence,
    ...hashes,
    inputHash,
    flatSnapshotFingerprint: flatFingerprint,
    embedding: { ...provider.config },
    fusion: VOICE_QA_SHADOW_REVIEW_FUSION,
    rankingVersion: PHASE_3_1_RANKING_VERSION,
    algorithmFingerprint,
    codeFingerprint:
      process.env.VOICE_QA_SHADOW_REVIEW_CODE_FINGERPRINT?.trim() ||
      "unresolved",
    queryVector,
    queryVectorHash,
    rankingMetadata: [...metadata.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    ),
    memorySourceIds: [...new Set(input.qaInput.memoryContext?.sourceIds ?? [])]
      .sort(),
    systems,
    backgroundRetrievalMs: Math.max(
      0,
      Math.round(now() - backgroundStartedAt)
    )
  };
}

const caseCollectionPromises = new Map<string, Promise<void>>();
const caseWriteTails = new Map<string, Promise<void>>();

export type VoiceQaShadowReviewVoiceMetrics = {
  asrLatencyMs: number | null;
  llmFirstTokenLatencyMs: number | null;
  firstPlayableSentenceLatencyMs: number | null;
  firstAudioLatencyMs: number | null;
  completeLatencyMs: number | null;
  streamingComplete: boolean;
  ttsFailure: string | null;
};

const pendingVoiceMetrics = new Map<string, VoiceQaShadowReviewVoiceMetrics>();

function reviewCaseKey(userId: string, caseId: string) {
  return JSON.stringify([userId, caseId]);
}

function enqueueCaseWrite(
  key: string,
  operation: () => void | Promise<void>
) {
  const previous = caseWriteTails.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(operation);
  caseWriteTails.set(key, next);
  void next.finally(() => {
    if (caseWriteTails.get(key) === next) caseWriteTails.delete(key);
  }).catch(() => undefined);
  return next;
}

function traceDurationMs(
  trace: VoiceSessionTrace,
  start: keyof VoiceSessionTrace["timestamps"],
  end: keyof VoiceSessionTrace["timestamps"]
) {
  const startAt = trace.timestamps[start];
  const endAt = trace.timestamps[end];
  if (!startAt || !endAt) return null;
  const elapsed = Date.parse(endAt) - Date.parse(startAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

export function voiceQaShadowReviewMetricsFromTrace(
  trace: VoiceSessionTrace
): VoiceQaShadowReviewVoiceMetrics {
  const ttsFailures = trace.failures
    .filter((failure) => failure.stage === "tts")
    .map((failure) => failure.code);
  return {
    asrLatencyMs: trace.latencies.asrLatencyMs,
    llmFirstTokenLatencyMs: trace.latencySegments?.llm_ttft_ms ?? null,
    firstPlayableSentenceLatencyMs: traceDurationMs(
      trace,
      "speech_ended",
      "first_safe_sentence"
    ),
    firstAudioLatencyMs: traceDurationMs(
      trace,
      "speech_ended",
      "first_audio_chunk_received"
    ),
    completeLatencyMs: traceDurationMs(
      trace,
      "speech_ended",
      "voice_response_complete"
    ),
    streamingComplete: Boolean(trace.timestamps.stream_completed),
    ttsFailure: ttsFailures.length > 0
      ? [...new Set(ttsFailures)].join(",")
      : null
  };
}

function caseFallbackReason(
  systems: VoiceQaShadowReviewRetrievalSnapshot["systems"]
) {
  return (["B"] as const)
    .flatMap((system) => {
      const reason = systems[system].fallbackReason;
      return reason ? [`${system}:${reason}`] : [];
    })
    .join(",") || null;
}

function retrievalRun(
  snapshot: VoiceQaShadowReviewRetrievalSnapshot,
  system: ReviewSystem
) {
  const result = snapshot.systems[system];
  return {
    system,
    replayIndex: 0,
    status: result.fallbackReason ? "fallback" as const : "completed" as const,
    flatSnapshotId: system === "A"
      ? null
      : snapshot.flatSnapshotFingerprint,
    denseLatencyMs: result.denseMs,
    totalLatencyMs: result.retrievalMs,
    fallbackReason: result.fallbackReason,
    candidateValidity: result.canonicalCandidateValidity,
    inputHash: result.inputHash,
    orderHash: result.orderHash,
    rankingMetadata: {
      algorithmFingerprint: snapshot.algorithmFingerprint,
      fusion: snapshot.fusion,
      rankingVersion: snapshot.rankingVersion,
      evidence: snapshot.rankingMetadata
    },
    memorySourceIds: snapshot.memorySourceIds,
    candidates: result.top30.map((candidate) => ({
      evidenceId: candidate.evidenceId,
      rank: candidate.rank,
      selectedRank: candidate.selectedTop16 ? candidate.rank : null,
      score: candidate.score,
      reason: {
        reasons: candidate.reasons,
        details: candidate.details
      }
    }))
  };
}

function persistRetrievalSnapshot(
  snapshot: VoiceQaShadowReviewRetrievalSnapshot
) {
  const repository = new VoiceQaShadowReviewRepository({
    userId: snapshot.userId
  });
  try {
    repository.upsertCaseBundle({
      canonicalSnapshot: {
        snapshotId: snapshot.canonicalSnapshotId,
        universeHash: snapshot.canonicalUniverseHash,
        contentHash: snapshot.canonicalContentHash,
        evidence: snapshot.canonicalEvidence.map((evidence, ordinal) => ({
          evidenceId: evidence.id,
          ordinal,
          content: evidence.text,
          metadata: {
            kind: evidence.kind,
            title: evidence.title,
            startSeconds: evidence.startSeconds,
            endSeconds: evidence.endSeconds,
            sourceSegmentIds: evidence.sourceSegmentIds,
            priority: evidence.priority,
            relationshipSignal: evidence.relationshipSignal ?? null
          }
        }))
      },
      case: {
        caseId: snapshot.caseId,
        scope: snapshot.scope,
        voiceSessionId: snapshot.voiceSessionId,
        traceId: snapshot.traceId,
        asrText: snapshot.asrText,
        asrTextHash: snapshot.asrHash,
        asrLatencyMs: null,
        conversationContext: snapshot.conversation ?? [],
        canonicalSnapshotId: snapshot.canonicalSnapshotId,
        flatSnapshotId: snapshot.flatSnapshotFingerprint,
        modelFingerprint: snapshot.algorithmFingerprint,
        promptFingerprint: "pending",
        codeFingerprint: snapshot.codeFingerprint,
        modelMetadata: {
          canonicalEvidenceVersion:
            VOICE_QA_SHADOW_CANONICAL_EVIDENCE_VERSION,
          embedding: snapshot.embedding,
          fusion: snapshot.fusion,
          rankingVersion: snapshot.rankingVersion,
          inputHash: snapshot.inputHash,
          backgroundRetrievalMs: snapshot.backgroundRetrievalMs
        },
        fallbackReason: caseFallbackReason(snapshot.systems),
        status: "pending"
      },
      replayInput: {
        version: "voice_qa_shadow_replay_input_v1",
        input: snapshot.replayInput
      },
      ...(snapshot.queryVector
        ? {
            queryVector: {
              vector: snapshot.queryVector,
              vectorHash: snapshot.queryVectorHash ?? undefined,
              modelName: snapshot.embedding.modelName,
              modelRevision: snapshot.embedding.modelVersion,
              dimension: snapshot.embedding.dimension
            }
          }
        : {}),
      retrievalRuns: (["A", "B"] as const).map((system) =>
        retrievalRun(snapshot, system)
      )
    });

    const cases = repository.listCases({ limit: 10_000 });
    let collected = 0;
    for (const reviewCase of cases) {
      const runs = repository.listRetrievalRuns(reviewCase.caseId)
        .filter((run) => run.replayIndex === 0);
      if (
        runs.length === 3 &&
        new Set(runs.map((run) => run.inputHash)).size === 1
      ) {
        collected += 1;
      }
    }
    console.info(
      `[voice-qa-shadow-review] case_id=${snapshot.caseId} ` +
      `scope=${snapshot.scope} status=collected ` +
      `collected=${collected}/${VOICE_QA_SHADOW_REVIEW_TARGET} ` +
      `retrieval_ms=${snapshot.backgroundRetrievalMs} ` +
      `fallback=${caseFallbackReason(snapshot.systems) ?? "none"}`
    );
  } finally {
    repository.close();
  }
}

export function collectVoiceQaShadowReviewRetrieval(input: {
  caseId: string;
  input: AnswerQuestionWithAIInput;
  lexical: QaEvidenceRetrievalResult;
}) {
  const userId = input.input.userId;
  if (!userId) {
    return Promise.reject(
      new Error("Voice QA shadow review requires a trusted user id")
    );
  }
  const key = reviewCaseKey(userId, input.caseId);
  const existing = caseCollectionPromises.get(key);
  if (existing) return existing;
  const collection = (async () => {
    const snapshot = await runVoiceQaShadowReviewRetrieval({
      caseId: input.caseId,
      qaInput: input.input,
      lexical: input.lexical
    });
    persistRetrievalSnapshot(snapshot);
  })();
  caseCollectionPromises.set(key, collection);
  void collection.finally(() => {
    if (caseCollectionPromises.get(key) === collection) {
      caseCollectionPromises.delete(key);
    }
  }).catch(() => undefined);
  return collection;
}

function officialCitationValidity(
  bundle: NonNullable<
    ReturnType<VoiceQaShadowReviewRepository["getCaseBundle"]>
  >,
  answer: QuestionAnswer
) {
  const canonicalById = new Map(
    bundle.canonicalSnapshot?.evidence.map((evidence) => [
      evidence.evidenceId,
      evidence
    ]) ?? []
  );
  const selectedByCitationId = new Map<string, string>(
    bundle.retrievalRuns
      .find((run) => run.system === "A" && run.replayIndex === 0)
      ?.candidates
      .flatMap((candidate) =>
        candidate.selectedRank === null
          ? []
          : [[`E${candidate.selectedRank}`, candidate.evidenceId] as const]
      ) ?? []
  );
  const compactExcerpt = (text: string) => {
    const compacted = text.replace(/\s+/gu, " ").trim();
    return compacted.length > 220
      ? `${compacted.slice(0, 219)}…`
      : compacted;
  };
  const citations = answer.citations ?? [];
  const citationIds = citations.map((citation) => citation.id);
  if (new Set(citationIds).size !== citationIds.length) return false;
  const inlineCitationIds = [
    ...answer.answer.matchAll(/\[(E\d+)\]/gu)
  ].map((match) => match[1]!);
  if (inlineCitationIds.some((citationId) => !citationIds.includes(citationId))) {
    return false;
  }
  for (const citation of citations) {
    const evidenceId = selectedByCitationId.get(citation.id);
    const canonical = evidenceId ? canonicalById.get(evidenceId) : undefined;
    const metadata = objectRecord(canonical?.metadata);
    const sourceSegmentIds = Array.isArray(metadata.sourceSegmentIds)
      ? metadata.sourceSegmentIds.filter(
          (sourceId): sourceId is string => typeof sourceId === "string"
        )
      : [];
    if (
      !canonical ||
      citation.title !== metadata.title ||
      citation.startSeconds !== metadata.startSeconds ||
      citation.endSeconds !== metadata.endSeconds ||
      citation.excerpt !== compactExcerpt(canonical.content) ||
      citation.sourceSegmentIds.length !== sourceSegmentIds.length ||
      !citation.sourceSegmentIds.every(
        (sourceId, index) => sourceId === sourceSegmentIds[index]
      )
    ) {
      return false;
    }
  }
  const citedSourceIds = [
    ...new Set(citations.flatMap((citation) => citation.sourceSegmentIds))
  ].sort();
  return (
    answer.citedSegmentIds.length === citedSourceIds.length &&
    [...answer.citedSegmentIds].sort().every(
      (sourceId, index) => sourceId === citedSourceIds[index]
    )
  );
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function applyVoiceMetricsToOfficialAnswer(
  repository: VoiceQaShadowReviewRepository,
  caseId: string,
  metrics: VoiceQaShadowReviewVoiceMetrics
) {
  const official = repository.getOfficialAnswer(caseId);
  if (!official) return false;
  repository.upsertOfficialAnswer(caseId, {
    answerText: official.answerText,
    citations: official.citations,
    model: official.model,
    promptFingerprint: official.promptFingerprint,
    codeFingerprint: official.codeFingerprint,
    fallbackReason: official.fallbackReason,
    llmFirstTokenLatencyMs:
      metrics.llmFirstTokenLatencyMs ?? official.llmFirstTokenLatencyMs,
    firstPlayableSentenceLatencyMs:
      metrics.firstPlayableSentenceLatencyMs ??
      official.firstPlayableSentenceLatencyMs,
    firstAudioLatencyMs:
      metrics.firstAudioLatencyMs ?? official.firstAudioLatencyMs,
    completeLatencyMs:
      metrics.completeLatencyMs ?? official.completeLatencyMs,
    streamingComplete: metrics.streamingComplete,
    ttsFailure: metrics.ttsFailure
  });
  return true;
}

function storedCanonicalQaEvidence(
  bundle: NonNullable<
    ReturnType<VoiceQaShadowReviewRepository["getCaseBundle"]>
  >,
  evidenceIds: readonly string[]
) {
  const byId = new Map(
    bundle.canonicalSnapshot?.evidence.map((item) => [
      item.evidenceId,
      item
    ]) ?? []
  );
  return evidenceIds.map((evidenceId): QaRetrievedEvidence => {
    const stored = byId.get(evidenceId);
    const metadata = objectRecord(stored?.metadata);
    const sourceSegmentIds = Array.isArray(metadata.sourceSegmentIds)
      ? metadata.sourceSegmentIds.filter(
          (value): value is string => typeof value === "string"
        )
      : [];
    const allowedKinds = new Set<QaRetrievedEvidence["kind"]>([
      "brief",
      "semantic",
      "audio",
      "audio_emotion",
      "raw",
      "relationship_signal"
    ]);
    if (
      !stored ||
      typeof metadata.kind !== "string" ||
      !allowedKinds.has(metadata.kind as QaRetrievedEvidence["kind"]) ||
      typeof metadata.title !== "string" ||
      typeof metadata.startSeconds !== "number" ||
      typeof metadata.endSeconds !== "number" ||
      typeof metadata.priority !== "number"
    ) {
      throw new Error("Stored canonical Evidence metadata is incomplete");
    }
    const relationshipSignal = objectRecord(metadata.relationshipSignal);
    return {
      id: stored.evidenceId,
      kind: metadata.kind as QaRetrievedEvidence["kind"],
      title: metadata.title,
      text: stored.content,
      startSeconds: metadata.startSeconds,
      endSeconds: metadata.endSeconds,
      sourceSegmentIds,
      priority: metadata.priority,
      ...(Object.keys(relationshipSignal).length > 0
        ? {
            relationshipSignal:
              relationshipSignal as QaRetrievedEvidence["relationshipSignal"]
          }
        : {})
    };
  });
}

function blindPromptSnapshotFromOfficialAttempt(
  bundle: NonNullable<
    ReturnType<VoiceQaShadowReviewRepository["getCaseBundle"]>
  >,
  input: {
    attemptKind: "sync_primary" | "sync_fallback" | "final_projection";
    fallbackReason: string | null;
    systemPrompt?: string;
    userPrompt?: string;
    promptFingerprint: string;
  }
) {
  const replayInput = objectRecord(bundle.replayInput?.input);
  const selectedCandidates = bundle.retrievalRuns
    .find((run) => run.system === "A" && run.replayIndex === 0)
    ?.candidates
    .filter((candidate) => candidate.selectedRank !== null)
    .sort(
      (left, right) =>
        (left.selectedRank ?? Number.MAX_SAFE_INTEGER) -
        (right.selectedRank ?? Number.MAX_SAFE_INTEGER)
    ) ?? [];
  const common = {
    attemptKind: input.attemptKind,
    answerMode: replayInput.answerMode === "direct"
      ? "direct" as const
      : "agent" as const,
    memoryCount: 0,
    evidenceCount: 0,
    lifecycleMetadata: {
      queryIntent: analyzeQaQueryIntent(bundle.case.asrText),
      selectedEvidence: selectedCandidates.map((candidate) => ({
        evidenceId: candidate.evidenceId,
        selectedRank: candidate.selectedRank,
        reason: candidate.reason
      })),
      replayInputHash: bundle.replayInput?.inputHash ?? null,
      canonicalContentHash: bundle.canonicalSnapshot?.contentHash ?? null
    }
  };
  if (
    input.systemPrompt === undefined &&
    input.userPrompt === undefined &&
    input.fallbackReason === "insufficient_evidence"
  ) {
    return {
      status: "no_provider_prompt" as const,
      ...common
    };
  }
  if (
    input.systemPrompt === undefined ||
    input.userPrompt === undefined
  ) {
    return null;
  }
  const delimiterIndex = input.userPrompt.indexOf(
    VOICE_QA_LOCAL_EVIDENCE_DELIMITER
  );
  if (
    delimiterIndex < 0 ||
    delimiterIndex !== input.userPrompt.lastIndexOf(
      VOICE_QA_LOCAL_EVIDENCE_DELIMITER
    )
  ) {
    return null;
  }
  const userPromptPrefix = input.userPrompt.slice(0, delimiterIndex);
  const evidenceSection = input.userPrompt.slice(
    delimiterIndex + VOICE_QA_LOCAL_EVIDENCE_DELIMITER.length
  );
  if (!bundle.replayInput || !bundle.canonicalSnapshot) {
    return null;
  }
  const selectedEvidenceIds = selectedCandidates.map(
    (candidate) => candidate.evidenceId
  );
  const selectedEvidence = storedCanonicalQaEvidence(
    bundle,
    selectedEvidenceIds
  );
  const prepared = prepareQaSelectedEvidenceForEvaluation({
    qaInput: bundle.replayInput.input as VoiceQaShadowReviewReplayInput,
    selectedEvidence,
    systemPrompt: input.systemPrompt,
    userPromptPrefix,
    expectedEvidenceSectionHash: sha256(evidenceSection),
    expectedOfficialPromptFingerprint: input.promptFingerprint
  });
  if (
    prepared.lexicalEvidenceIds.length !== selectedEvidenceIds.length ||
    prepared.lexicalEvidenceIds.some(
      (evidenceId, index) => evidenceId !== selectedEvidenceIds[index]
    )
  ) {
    return null;
  }
  return {
    status: "provider_prompt" as const,
    systemPrompt: input.systemPrompt,
    userPromptPrefix,
    evidenceSectionHash: prepared.evidenceSectionHash,
    ...common,
    memoryCount: prepared.memoryCount,
    evidenceCount: prepared.memoryEvidenceCount,
    lifecycleMetadata: {
      ...common.lifecycleMetadata,
      lexicalEvidenceIds: prepared.lexicalEvidenceIds
    }
  };
}

export async function recordVoiceQaShadowReviewOfficialAnswer(input: {
  caseId: string;
  userId: string;
  answer: QuestionAnswer;
  attemptKind: "sync_primary" | "sync_fallback" | "final_projection";
  provider: string;
  selectedModel: string;
  providerMetadata?: {
    providerId: "gpt-5.5" | "qwen-vllm";
    wireApi: "chat" | "responses";
    reasoningEnabled: boolean | null;
    endpointFingerprint: string;
  };
  fallbackReason: string | null;
  systemPrompt?: string;
  userPrompt?: string;
  qaLatencyMs: number;
}) {
  const key = reviewCaseKey(input.userId, input.caseId);
  await caseCollectionPromises.get(key);
  await enqueueCaseWrite(key, () => {
    const repository = new VoiceQaShadowReviewRepository({
      userId: input.userId
    });
    try {
      const bundle = repository.getCaseBundle(input.caseId);
      if (!bundle) {
        throw new Error("Voice QA shadow review case is not persisted");
      }
      const existingOfficial = bundle.officialAnswer;
      const existingAttemptKind =
        objectRecord(existingOfficial?.citations).attemptKind;
      const promptFingerprint =
        input.systemPrompt || input.userPrompt
          ? jsonHash({
              systemPromptHash: sha256(input.systemPrompt ?? ""),
              userPromptHash: sha256(input.userPrompt ?? "")
            })
          : "unresolved";
      const citationValidity = officialCitationValidity(bundle, input.answer);
      const attemptCitations = {
        answerId: input.answer.id,
        citedSegmentIds: input.answer.citedSegmentIds,
        citations: input.answer.citations ?? [],
        citationValidity
      };
      if (
        input.attemptKind === "final_projection" &&
        input.fallbackReason !== "insufficient_evidence"
      ) {
        const primaryCompleted =
          input.fallbackReason === null || input.fallbackReason === "none";
        repository.upsertQaAttempt(input.caseId, {
          attemptIndex: 0,
          kind: "stream_primary",
          status: primaryCompleted ? "completed" : "failed",
          fallbackReason: input.fallbackReason,
          provider: input.provider,
          model: input.selectedModel,
          promptFingerprint,
          codeFingerprint: bundle.case.codeFingerprint,
          ...(primaryCompleted
            ? {
                answerText: input.answer.answer,
                citations: attemptCitations
              }
            : {}),
          latencyMs: null
        });
      }
      repository.upsertQaAttempt(input.caseId, {
        attemptIndex:
          input.attemptKind === "sync_primary"
            ? 0
            : input.attemptKind === "sync_fallback"
              ? 1
              : 2,
        kind: input.attemptKind,
        status: "completed",
        fallbackReason: input.fallbackReason,
        provider: input.provider,
        model: input.selectedModel,
        promptFingerprint,
        codeFingerprint: bundle.case.codeFingerprint,
        answerText: input.answer.answer,
        citations: attemptCitations,
        latencyMs: input.qaLatencyMs
      });
      // A streaming final represents the outer Voice QA attempt. A sync answer
      // may be its internal fallback and must never overwrite that final view
      // merely because its asynchronous persistence resolves later. Its
      // attempt row above remains available for failure/retry analysis.
      if (
        existingAttemptKind === "final_projection" &&
        input.attemptKind !== "final_projection"
      ) {
        return;
      }
      const blindPromptSnapshot = blindPromptSnapshotFromOfficialAttempt(
        bundle,
        {
          ...input,
          promptFingerprint
        }
      );
      if (blindPromptSnapshot) {
        repository.upsertBlindPromptSnapshot(
          input.caseId,
          blindPromptSnapshot
        );
      } else {
        console.warn(
          `[voice-qa-shadow-review] case_id=${input.caseId} ` +
          "status=blind_prompt_snapshot_missing"
        );
      }
      repository.upsertCase({
        caseId: bundle.case.caseId,
        scope: bundle.case.scope,
        voiceSessionId: bundle.case.voiceSessionId,
        traceId: bundle.case.traceId,
        asrText: bundle.case.asrText,
        asrTextHash: bundle.case.asrTextHash,
        asrLatencyMs: bundle.case.asrLatencyMs,
        conversationContext: bundle.case.conversationContext,
        canonicalSnapshotId: bundle.case.canonicalSnapshotId,
        flatSnapshotId: bundle.case.flatSnapshotId,
        modelFingerprint: bundle.case.modelFingerprint,
        promptFingerprint,
        codeFingerprint: bundle.case.codeFingerprint,
        modelMetadata: {
          ...objectRecord(bundle.case.modelMetadata),
          officialQa: {
            provider: input.provider,
            model: input.selectedModel,
            ...(input.providerMetadata ?? {}),
            attemptKind: input.attemptKind,
            qaLatencyMs: input.qaLatencyMs
          }
        },
        fallbackReason: bundle.case.fallbackReason,
        status: bundle.case.status,
        invalidReason: bundle.case.invalidReason
      });
      repository.upsertOfficialAnswer(input.caseId, {
        answerText: input.answer.answer,
        citations: {
          ...attemptCitations,
          provider: input.provider,
          attemptKind: input.attemptKind
        },
        model: `${input.provider}:${input.selectedModel}`,
        promptFingerprint,
        codeFingerprint: bundle.case.codeFingerprint,
        fallbackReason: input.fallbackReason,
        // QA completion is not Voice completion. Preserve terminal metrics
        // already written by the Bridge and otherwise leave them unknown.
        llmFirstTokenLatencyMs:
          existingOfficial?.llmFirstTokenLatencyMs ?? null,
        firstPlayableSentenceLatencyMs:
          existingOfficial?.firstPlayableSentenceLatencyMs ?? null,
        firstAudioLatencyMs:
          existingOfficial?.firstAudioLatencyMs ?? null,
        completeLatencyMs: existingOfficial?.completeLatencyMs ?? null,
        streamingComplete: existingOfficial?.streamingComplete ?? null,
        ttsFailure: existingOfficial?.ttsFailure ?? null
      });
      const pendingMetrics = pendingVoiceMetrics.get(key);
      if (
        pendingMetrics &&
        applyVoiceMetricsToOfficialAnswer(
          repository,
          input.caseId,
          pendingMetrics
        )
      ) {
        pendingVoiceMetrics.delete(key);
      }
      console.info(
        `[voice-qa-shadow-review] case_id=${input.caseId} ` +
        `scope=${bundle.case.scope} status=official_answer_recorded ` +
        `citation_valid=${citationValidity} qa_ms=${input.qaLatencyMs}`
      );
    } finally {
      repository.close();
    }
  });
}

export async function recordVoiceQaShadowReviewVoiceOutcome(input: {
  caseId: string;
  userId: string;
  traceId: string;
  metrics: VoiceQaShadowReviewVoiceMetrics;
}) {
  const key = reviewCaseKey(input.userId, input.caseId);
  const metrics = input.metrics;
  pendingVoiceMetrics.set(key, metrics);
  await caseCollectionPromises.get(key);
  await enqueueCaseWrite(key, () => {
    const repository = new VoiceQaShadowReviewRepository({
      userId: input.userId
    });
    try {
      const bundle = repository.getCaseBundle(input.caseId);
      if (!bundle) {
        throw new Error("Voice QA shadow review case is not persisted");
      }
      if (bundle.case.traceId !== input.traceId) {
        throw new Error("Voice QA shadow review trace identity mismatch");
      }
      repository.upsertCase({
        caseId: bundle.case.caseId,
        scope: bundle.case.scope,
        voiceSessionId: bundle.case.voiceSessionId,
        traceId: bundle.case.traceId,
        asrText: bundle.case.asrText,
        asrTextHash: bundle.case.asrTextHash,
        asrLatencyMs: metrics.asrLatencyMs,
        conversationContext: bundle.case.conversationContext,
        canonicalSnapshotId: bundle.case.canonicalSnapshotId,
        flatSnapshotId: bundle.case.flatSnapshotId,
        modelFingerprint: bundle.case.modelFingerprint,
        promptFingerprint: bundle.case.promptFingerprint,
        codeFingerprint: bundle.case.codeFingerprint,
        modelMetadata: bundle.case.modelMetadata,
        fallbackReason: bundle.case.fallbackReason,
        status: bundle.case.status,
        invalidReason: bundle.case.invalidReason
      });
      if (
        applyVoiceMetricsToOfficialAnswer(repository, input.caseId, metrics)
      ) {
        pendingVoiceMetrics.delete(key);
      }
      console.info(
        `[voice-qa-shadow-review] case_id=${input.caseId} ` +
        `scope=${bundle.case.scope} status=voice_outcome_recorded ` +
        `streaming_complete=${metrics.streamingComplete} ` +
        `tts_failure=${metrics.ttsFailure ?? "none"}`
      );
    } finally {
      repository.close();
    }
  });
}
