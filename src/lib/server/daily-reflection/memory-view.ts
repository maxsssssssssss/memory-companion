import {
  DailyReflectionMemoryDetailResponseSchema,
  DailyReflectionMemoryListResponseSchema,
  type DailyReflectionMemoryView
} from "@/lib/domain/daily-reflection-memory-view";

import { getDailyReflectionReturnSourceRepository } from "./return-source-repository";

const MIN_DATE = "0001-01-01";
const MAX_DATE = "9999-12-31";

function snapshotMemories(accountId: string): DailyReflectionMemoryView[] {
  const snapshot = getDailyReflectionReturnSourceRepository().snapshot(accountId, MIN_DATE, MAX_DATE);
  return snapshot.admitted
    .map((source) => ({
      id: source.memoryId,
      cardId: source.cardId,
      reflectionId: source.reflectionId,
      recordingDate: source.recordingDate,
      memoryType: source.memoryType,
      cardKind: source.cardKind,
      epistemicStatus: source.epistemicStatus,
      epistemicCaution: source.epistemicCaution,
      title: source.title,
      content: source.content,
      sourceCount: source.evidence.length,
      evidence: source.evidence
    }))
    .sort((left, right) => right.recordingDate.localeCompare(left.recordingDate)
      || left.id.localeCompare(right.id));
}

export function listDailyReflectionMemories(accountId: string) {
  const memories = snapshotMemories(accountId);
  return DailyReflectionMemoryListResponseSchema.parse({ memories, total: memories.length });
}

export function getDailyReflectionMemory(accountId: string, memoryId: string) {
  const memory = snapshotMemories(accountId).find((item) => item.id === memoryId);
  if (!memory) return null;
  return DailyReflectionMemoryDetailResponseSchema.parse({ memory });
}
