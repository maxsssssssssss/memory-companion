import { performance } from "node:perf_hooks";
import type { HybridEvidenceCandidate } from "./types";
import {
  assertValidRerankerScores,
  type RerankerProvider
} from "./reranker-provider";

export type RerankedHybridCandidate = HybridEvidenceCandidate & {
  rerankerScore: number;
  originalRank: number;
  rerankerRank: number;
};

export type RerankResult = {
  candidates: HybridEvidenceCandidate[] | RerankedHybridCandidate[];
  latencyMs: number;
  fallback: boolean;
  fallbackReason?: string;
  scoreDistribution?: {
    min: number;
    max: number;
    mean: number;
    p50: number;
    p95: number;
  };
};

function percentile(sorted: readonly number[], fraction: number) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]!;
}

function distribution(scores: readonly number[]) {
  const sorted = [...scores].sort((left, right) => left - right);
  return {
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
    mean: sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95)
  };
}

export function orderHybridCandidatesByRerankerScores(input: {
  candidates: readonly HybridEvidenceCandidate[];
  scoresByEvidenceId: ReadonlyMap<string, number>;
}) {
  const scores = input.candidates.map((candidate) => {
    const score = input.scoresByEvidenceId.get(candidate.evidence.id);
    if (score === undefined || !Number.isFinite(score)) {
      throw new Error(`missing reranker score for evidence ${candidate.evidence.id}`);
    }
    return score;
  });
  assertValidRerankerScores(scores, input.candidates.length);
  return input.candidates
    .map((candidate, index): RerankedHybridCandidate => ({
      ...candidate,
      rerankerScore: scores[index]!,
      originalRank: index + 1,
      rerankerRank: 0
    }))
    .sort((left, right) =>
      right.rerankerScore - left.rerankerScore ||
      left.originalRank - right.originalRank ||
      left.evidence.id.localeCompare(right.evidence.id)
    )
    .map((candidate, index) => ({ ...candidate, rerankerRank: index + 1 }));
}

export async function rerankHybridCandidates(input: {
  question: string;
  candidates: readonly HybridEvidenceCandidate[];
  provider: RerankerProvider;
  enabled?: boolean;
}): Promise<RerankResult> {
  const startedAt = performance.now();
  const original = [...input.candidates];
  if (!input.enabled) {
    return {
      candidates: original,
      latencyMs: performance.now() - startedAt,
      fallback: true,
      fallbackReason: "disabled"
    };
  }
  try {
    const scores = await input.provider.score(
      input.question,
      original.map((candidate) => ({
        id: candidate.evidence.id,
        text: `${candidate.evidence.title}\n${candidate.evidence.text}`
      }))
    );
    assertValidRerankerScores(scores, original.length);
    const candidates = orderHybridCandidatesByRerankerScores({
      candidates: original,
      scoresByEvidenceId: new Map(
        original.map((candidate, index) => [candidate.evidence.id, scores[index]!])
      )
    });
    return {
      candidates,
      latencyMs: performance.now() - startedAt,
      fallback: false,
      scoreDistribution: distribution(scores)
    };
  } catch (error) {
    return {
      candidates: original,
      latencyMs: performance.now() - startedAt,
      fallback: true,
      fallbackReason: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    };
  }
}
