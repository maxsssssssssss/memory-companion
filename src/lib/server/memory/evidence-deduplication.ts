import type { MemoryEvidence, MemoryEvidenceWrite } from "./types";

type EvidenceLike = MemoryEvidence | MemoryEvidenceWrite;

export function normalizeEvidenceQuoteForDedup(value: string) {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\r\n?/gu, "\n")
    .replace(/\s+/gu, " ")
    .trim();
  const withoutPunctuation = normalized
    .replace(/[\p{P}\s]+/gu, "")
    .trim();
  return withoutPunctuation || normalized;
}

function evidenceDedupKey(memoryId: string, evidence: EvidenceLike) {
  return JSON.stringify([
    memoryId,
    evidence.uploadId,
    evidence.sourceId,
    normalizeEvidenceQuoteForDedup(evidence.quote)
  ]);
}

function sourcePriority(evidence: EvidenceLike) {
  return evidence.sourceType === "transcript" ? 0 : 1;
}

function compareWinner(left: EvidenceLike, right: EvidenceLike) {
  return sourcePriority(left) - sourcePriority(right) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id);
}

function compareEvidence(left: EvidenceLike, right: EvidenceLike) {
  return left.date.localeCompare(right.date) ||
    sourcePriority(left) - sourcePriority(right) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id);
}

export function deduplicateMemoryEvidence<T extends EvidenceLike>(memoryId: string, evidence: T[]) {
  const byIdentity = new Map<string, T>();
  for (const item of evidence) {
    const key = evidenceDedupKey(memoryId, item);
    const existing = byIdentity.get(key);
    if (!existing || compareWinner(item, existing) < 0) {
      byIdentity.set(key, item);
    }
  }
  const deduplicated = [...byIdentity.values()].sort(compareEvidence);
  return {
    evidence: deduplicated,
    removed: evidence.length - deduplicated.length
  };
}
