import { calculateImportance, combineImportanceReasons } from "./importance";
import { meaningfulTextTokens, sharedTokenCount } from "../text-features";
import { MemoryItemSchema, type MemoryEvidence, type MemoryItem } from "./types";

export type MemorySimilarityMatch = {
  memory: MemoryItem;
  score: number;
  daysApart: number;
};

const MAX_EXACT_MATCH_DAYS = 90;
const MAX_SIMILAR_MATCH_DAYS = 30;
const MIN_SIMILARITY = 0.5;

export function normalizeMemoryText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textTokens(value: string) {
  const normalized = normalizeMemoryText(value);
  const tokens = new Set<string>();

  for (const word of normalized.match(/[a-z0-9]+/g) ?? []) {
    if (word.length >= 2) {
      tokens.add(word);
    }
  }
  for (const block of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (block.length === 1) {
      tokens.add(block);
      continue;
    }
    for (let index = 0; index < block.length - 1; index += 1) {
      tokens.add(block.slice(index, index + 2));
    }
  }

  return tokens;
}

export function textTokenOverlap(left: string, right: string) {
  const leftTokens = textTokens(left);
  const rightTokens = textTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

export function memoryTextSimilarity(left: Pick<MemoryItem, "title" | "summary">, right: Pick<MemoryItem, "title" | "summary">) {
  const titleScore = textTokenOverlap(left.title, right.title);
  const summaryScore = textTokenOverlap(left.summary, right.summary);
  return Math.round((titleScore * 0.65 + summaryScore * 0.35) * 1_000) / 1_000;
}

export function daysBetweenDates(left: string, right: string) {
  const leftTime = Date.parse(`${left}T00:00:00.000Z`);
  const rightTime = Date.parse(`${right}T00:00:00.000Z`);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(leftTime - rightTime) / 86_400_000;
}

export function findSimilarMemories(candidate: MemoryItem, existing: MemoryItem[]): MemorySimilarityMatch[] {
  return existing
    .filter((memory) => memory.userId === candidate.userId && memory.type === candidate.type)
    .map((memory) => {
      const titleScore = textTokenOverlap(candidate.title, memory.title);
      const summaryScore = textTokenOverlap(candidate.summary, memory.summary);
      const score = Math.round((titleScore * 0.65 + summaryScore * 0.35) * 1_000) / 1_000;
      const daysApart = daysBetweenDates(candidate.firstSeenDate, memory.lastSeenDate);
      const exactTitle = normalizeMemoryText(candidate.title) === normalizeMemoryText(memory.title);
      const exactSummary = normalizeMemoryText(candidate.summary) === normalizeMemoryText(memory.summary);
      const preferenceSubject = (value: MemoryItem) => meaningfulTextTokens(
        [
          value.title,
          value.summary,
          ...value.evidence
            .filter((evidence) => evidence.sourceType === "transcript")
            .map((evidence) => evidence.quote)
        ]
          .join(" ")
          .replace(/不喜欢|更喜欢|最喜欢|喜欢|更倾向|偏好|平时|通常|一般|习惯|会选|选择|prefer|usually|habit/giu, " ")
      );
      const preferenceShared = candidate.type === "preference"
        ? sharedTokenCount(preferenceSubject(candidate), preferenceSubject(memory))
        : 0;
      const similar = candidate.type === "preference"
        ? preferenceShared >= 2 && daysApart <= MAX_EXACT_MATCH_DAYS * 2
        : (exactSummary || exactTitle && summaryScore >= 0.2) && daysApart <= MAX_EXACT_MATCH_DAYS ||
          score >= MIN_SIMILARITY && titleScore >= 0.35 && summaryScore >= 0.2 && daysApart <= MAX_SIMILAR_MATCH_DAYS;
      return similar ? { memory, score, daysApart } : null;
    })
    .filter((match): match is MemorySimilarityMatch => match !== null)
    .sort((left, right) => right.score - left.score || left.memory.createdAt.localeCompare(right.memory.createdAt));
}

function latestIso(left: string | null, right: string | null) {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

function representative(primary: MemoryItem, incoming: MemoryItem) {
  if (incoming.importanceScore > primary.importanceScore) {
    return incoming;
  }
  if (incoming.importanceScore < primary.importanceScore) {
    return primary;
  }
  return incoming.createdAt < primary.createdAt ? incoming : primary;
}

export function mergeMemories(primary: MemoryItem, incoming: MemoryItem): MemoryItem {
  if (primary.userId !== incoming.userId || primary.type !== incoming.type) {
    throw new Error("Only same-user, same-type memories can be merged");
  }

  const selected = representative(primary, incoming);
  const evidenceById = new Map<string, MemoryEvidence>();
  for (const evidence of [...primary.evidence, ...incoming.evidence]) {
    evidenceById.set(evidence.id, { ...evidence, memoryId: primary.id });
  }
  const evidence = [...evidenceById.values()].sort(
    (left, right) => left.date.localeCompare(right.date) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );
  const evidenceDates = [...new Set(evidence.map((item) => item.date))].sort();
  const occurrenceCount = new Set(evidence.map((item) => item.uploadId)).size;
  const importance = calculateImportance({
    type: primary.type,
    title: selected.title,
    summary: selected.summary,
    status: primary.status,
    occurrenceCount,
    evidenceDates,
    evidenceSourceTypes: evidence.map((item) => item.sourceType),
    evidenceCount: evidence.length
  });
  const firstSeenDate = evidenceDates[0] ?? primary.firstSeenDate;
  const lastSeenDate = evidenceDates.at(-1) ?? primary.lastSeenDate;

  return MemoryItemSchema.parse({
    ...primary,
    title: selected.title,
    summary: selected.summary,
    importance: importance.score,
    importanceScore: importance.score,
    importanceReasons: combineImportanceReasons(importance.reasons, [
      ...primary.importanceReasons,
      ...incoming.importanceReasons
    ]),
    occurrenceCount,
    firstSeenDate,
    lastSeenDate,
    date: lastSeenDate,
    createdAt: primary.createdAt <= incoming.createdAt ? primary.createdAt : incoming.createdAt,
    updatedAt: primary.updatedAt >= incoming.updatedAt ? primary.updatedAt : incoming.updatedAt,
    accessCount: primary.accessCount + incoming.accessCount,
    lastAccessedAt: latestIso(primary.lastAccessedAt, incoming.lastAccessedAt),
    evidence
  });
}

export function consolidateMemories(memories: MemoryItem[]) {
  const consolidated: MemoryItem[] = [];
  const ordered = [...memories].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );

  for (const memory of ordered) {
    const match = findSimilarMemories(memory, consolidated)[0];
    if (!match) {
      consolidated.push(memory);
      continue;
    }
    const index = consolidated.findIndex((item) => item.id === match.memory.id);
    consolidated[index] = mergeMemories(consolidated[index], memory);
  }

  return consolidated;
}
