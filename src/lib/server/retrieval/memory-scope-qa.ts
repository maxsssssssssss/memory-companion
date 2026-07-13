import type {
  AudioInsight,
  AudioUpload,
  BriefItem,
  QuestionAnswer,
  RelationshipSignalCard,
  SemanticSegment,
  TranscriptSegment
} from "@/lib/domain/types";
import { observeMemoryShadowRetrieval, type MemoryShadowDateRange } from "@/lib/server/memory/shadow-retrieval";
import {
  answerQuestionWithAI,
  retrieveQaEvidence,
  type AnswerQuestionWithAIInput,
  type QaConversationMessage,
  type QaScope
} from "@/lib/server/retrieval/ai-qa";
import {
  retrieveMemoryIndexEvidence,
  type MemoryIndexQaContext
} from "@/lib/server/retrieval/memory-index-evidence";
import { appStore } from "@/lib/server/storage/json-store";
import type { JsonStore } from "@/lib/server/storage/json-store";

export type StoredUpload = AudioUpload & {
  filePath?: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateFromKey(dateKey: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);

  if (!match) {
    const parsed = new Date(dateKey);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * DAY_MS);
}

export function currentWeekRange(reference = new Date()) {
  const localDate = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
  const daysSinceMonday = (localDate.getDay() + 6) % 7;
  const start = addDays(localDate, -daysSinceMonday);
  const end = addDays(start, 6);

  return {
    start,
    end,
    startKey: formatDateKey(start),
    endKey: formatDateKey(end),
    scopeId: `week_${formatDateKey(start).replaceAll("-", "")}_${formatDateKey(end).replaceAll("-", "")}`
  };
}

export function isUploadInRange(upload: StoredUpload, start: Date, end: Date) {
  const recordingDate = dateFromKey(upload.recordingDate);

  if (!recordingDate) {
    return false;
  }

  const recordingDateKey = formatDateKey(recordingDate);
  return recordingDateKey >= formatDateKey(start) && recordingDateKey <= formatDateKey(end);
}

function prefixWithRecordingDate(recordingDate: string, text: string) {
  return `[${recordingDate}] ${text}`;
}

function decorateSegments(upload: StoredUpload, segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments.map((segment) => ({
    ...segment,
    text: prefixWithRecordingDate(upload.recordingDate, segment.text)
  }));
}

function decorateSemanticSegments(upload: StoredUpload, semanticSegments: SemanticSegment[]): SemanticSegment[] {
  return semanticSegments.map((segment) => ({
    ...segment,
    title: `${upload.recordingDate} · ${segment.title}`,
    summary: prefixWithRecordingDate(upload.recordingDate, segment.summary),
    transcriptExcerpt: prefixWithRecordingDate(upload.recordingDate, segment.transcriptExcerpt)
  }));
}

function decorateAudioInsights(upload: StoredUpload, audioInsights: AudioInsight[]): AudioInsight[] {
  return audioInsights.map((insight) => ({
    ...insight,
    summary: prefixWithRecordingDate(upload.recordingDate, insight.summary),
    evidence: prefixWithRecordingDate(upload.recordingDate, insight.evidence)
  }));
}

function decorateBriefItems(upload: StoredUpload, briefItems: BriefItem[]): BriefItem[] {
  return briefItems.map((item) => ({
    ...item,
    title: `${upload.recordingDate} · ${item.title}`,
    body: prefixWithRecordingDate(upload.recordingDate, item.body),
    transcriptExcerpt: prefixWithRecordingDate(upload.recordingDate, item.transcriptExcerpt)
  }));
}

function decorateRelationshipSignals(upload: StoredUpload, relationshipSignals: RelationshipSignalCard[]) {
  return relationshipSignals.map((card) => ({
    ...card,
    date: upload.recordingDate
  }));
}

async function readUploadEvidence(store: JsonStore, upload: StoredUpload) {
  const [segments, audioInsights, semanticSegments, briefItems, relationshipSignals] = await Promise.all([
    store.read<TranscriptSegment[]>("segments", upload.id),
    store.read<AudioInsight[]>("audio-insights", upload.id),
    store.read<SemanticSegment[]>("semantic-segments", upload.id),
    store.read<BriefItem[]>("brief-items", upload.id),
    store.read<RelationshipSignalCard[]>("relationship-signals", upload.id)
  ]);

  return {
    segments: decorateSegments(upload, segments ?? []),
    audioInsights: decorateAudioInsights(upload, audioInsights ?? []),
    semanticSegments: decorateSemanticSegments(upload, semanticSegments ?? []),
    briefItems: decorateBriefItems(upload, briefItems ?? []),
    relationshipSignals: decorateRelationshipSignals(upload, relationshipSignals ?? [])
  };
}

export async function answerMemoryScopeQuestion(input: {
  question: string;
  conversation?: QaConversationMessage[];
  scopeId: string;
  qaScope: Extract<QaScope, "week" | "all">;
  userId?: string;
  shadowDateRange?: MemoryShadowDateRange;
  store?: JsonStore;
  qaPromptInstruction?: string;
  includeUpload?: (upload: StoredUpload) => boolean;
}): Promise<QuestionAnswer | null> {
  const store = input.store ?? appStore;
  const uploads = await store.list<StoredUpload>("uploads");
  const scopedUploads = uploads
    .map(({ value }) => value)
    .filter((upload) => upload.status === "ready" && (input.includeUpload ? input.includeUpload(upload) : true))
    .sort((left, right) => left.recordingDate.localeCompare(right.recordingDate) || left.id.localeCompare(right.id));

  if (scopedUploads.length === 0) {
    return null;
  }

  const scopedEvidence = await Promise.all(scopedUploads.map((upload) => readUploadEvidence(store, upload)));
  const segments = scopedEvidence.flatMap((evidence) => evidence.segments);
  const audioInsights = scopedEvidence.flatMap((evidence) => evidence.audioInsights);
  const semanticSegments = scopedEvidence.flatMap((evidence) => evidence.semanticSegments);
  const briefItems = scopedEvidence.flatMap((evidence) => evidence.briefItems);
  const relationshipSignals = scopedEvidence.flatMap((evidence) => evidence.relationshipSignals);

  if (
    segments.length === 0 &&
    audioInsights.length === 0 &&
    semanticSegments.length === 0 &&
    briefItems.length === 0 &&
    relationshipSignals.length === 0
  ) {
    return null;
  }

  let memoryContext: MemoryIndexQaContext | undefined;
  let memoryIndexFallback = false;
  if (input.userId) {
    try {
      memoryContext = retrieveMemoryIndexEvidence({
        userId: input.userId,
        scope: input.qaScope,
        query: input.question,
        ...(input.shadowDateRange ? { dateRange: input.shadowDateRange } : {})
      });
    } catch (error) {
      memoryIndexFallback = true;
      console.warn(
        `[memory-qa] scope=${input.qaScope} memory_retrieval_failure=${error instanceof Error ? error.message : "unknown_error"}`
      );
    }
  }

  const qaInput: AnswerQuestionWithAIInput = {
    uploadId: input.scopeId,
    question: input.question,
    scope: input.qaScope,
    segments,
    audioInsights,
    semanticSegments,
    briefItems,
    relationshipSignals,
    ...(memoryContext && memoryContext.count > 0 ? { memoryContext } : {}),
    ...(memoryIndexFallback ? { memoryIndexFallback: true } : {}),
    settingsStore: store,
    ...(input.qaPromptInstruction ? { qaPromptInstruction: input.qaPromptInstruction } : {}),
    ...(input.conversation && input.conversation.length > 0 ? { conversation: input.conversation } : {})
  };
  let shadowSnapshot: { evidence: ReturnType<typeof retrieveQaEvidence>; elapsedMs: number } | null = null;
  if (input.userId) {
    try {
      const jsonRetrievalStartedAt = performance.now();
      shadowSnapshot = {
        evidence: retrieveQaEvidence(qaInput),
        elapsedMs: Math.max(
          0,
          Math.round((performance.now() - jsonRetrievalStartedAt) * 100) / 100
        )
      };
    } catch (error) {
      console.warn(
        `[memory-shadow] scope=${input.qaScope} json_observer_failure=${error instanceof Error ? error.message : "unknown_error"}`
      );
    }
  }
  const answer = await answerQuestionWithAI(qaInput);

  if (input.userId && shadowSnapshot) {
    try {
      observeMemoryShadowRetrieval({
        userId: input.userId,
        scope: input.qaScope,
        query: input.question,
        ...(input.shadowDateRange ? { dateRange: input.shadowDateRange } : {}),
        jsonEvidence: shadowSnapshot.evidence,
        jsonRetrievalTimeMs: shadowSnapshot.elapsedMs
      });
    } catch (error) {
      console.warn(
        `[memory-shadow] scope=${input.qaScope} observer_failure=${error instanceof Error ? error.message : "unknown_error"}`
      );
    }
  }
  const answers = (await store.read<QuestionAnswer[]>("answers-by-scope", input.scopeId)) ?? [];

  await store.write("answers", answer.id, answer);
  try {
    await store.write("answers-by-scope", input.scopeId, [...answers, answer]);
  } catch (error) {
    await store.delete("answers", answer.id).catch(() => undefined);
    throw error;
  }

  return answer;
}
