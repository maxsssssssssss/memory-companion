import { createHash } from "node:crypto";
import type { BriefItem, RelationshipSignalCard, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import type {
  MemoryEvidenceSourceType,
  MemoryEvidenceWrite,
  MemoryItemType,
  MemoryWriteInput
} from "./types";

export type ExtractUploadMemoriesInput = {
  userId: string;
  uploadId: string;
  recordingDate: string;
  segments: TranscriptSegment[];
  briefItems: BriefItem[];
  semanticSegments: SemanticSegment[];
  relationshipSignals: RelationshipSignalCard[];
  now?: string;
};

const priorityImportance = {
  high: 0.9,
  medium: 0.7,
  low: 0.5
} as const;

const severityImportance = {
  high: 0.9,
  medium: 0.7,
  low: 0.5
} as const;

type MemoryClassification = {
  type: MemoryItemType;
  reason: string;
};

const unresolvedPattern =
  /未解决|没解决|没说清|待确认|待定|尚未|还(?:没|未|需|要).{0,10}(?:确认|决定|说清|解决)|需要(?:再|继续|进一步)?确认|open question|unresolved|not decided|still (?:open|unclear)/i;
const preferencePattern =
  /(?:我|我们|你|你们|他|她|对方).{0,12}(?:不喜欢|更喜欢|最喜欢|特别喜欢|偏好|习惯|通常|一般|总是|每次)|(?:我|我们).{0,12}(?:希望|需要).{0,16}(?:先|再|被|得到|不要|别|提前)|不喜欢临时|prefer(?:ence)?|usually|habit/i;
const commitmentPattern =
  /(?:我|我们|他|她|对方|双方).{0,10}(?:承诺|答应|约定|说好|保证)|(?:明天|后天|下周|周末|下次).{0,24}(?:一起|去|做|见|确认|联系|安排|完成)|(?:我|我们|他|她|对方).{0,10}(?:会|将|计划|打算|准备).{0,28}(?:确认|联系|安排|去|做|不再|及时|一起|完成|回复)|promise|commitment|agreed? to|will (?:confirm|contact|meet|do|finish)/i;
const recentEventPattern =
  /今天|昨天|刚刚|这次|当时|上次|已经.{0,12}(?:完成|解决|确认)|(?:完成|解决|确认)了|today|yesterday|this time|last time/i;
const MAX_RECENT_SEMANTIC_EVENTS = 2;

function clamp(value: number) {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function cleanText(value: string, maxLength = 4_000) {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function stableId(prefix: "memory" | "evidence", parts: string[]) {
  const digest = createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 32);
  return `${prefix}_${digest}`;
}

function sourceText(input: { title: string; summary: string; excerpt: string }) {
  return `${input.title}\n${input.summary}\n${input.excerpt}`;
}

function classifyBriefItem(item: BriefItem): MemoryClassification | null {
  if (item.category === "commitment") {
    return { type: "commitment", reason: "extraction: brief category commitment" };
  }
  if (item.category === "open_question") {
    return { type: "question", reason: "extraction: brief category open_question" };
  }
  const text = sourceText({ title: item.title, summary: item.body, excerpt: item.transcriptExcerpt });
  if (preferencePattern.test(text)) {
    return { type: "preference", reason: "extraction: contains explicit stable preference or habit" };
  }
  if (item.category === "task") {
    return { type: "commitment", reason: "extraction: brief task contains a future action" };
  }
  if (item.category === "risk" && unresolvedPattern.test(text)) {
    return { type: "question", reason: "extraction: risk remains unresolved or pending confirmation" };
  }
  if (item.category === "decision" || item.category === "risk") {
    return { type: "event", reason: `extraction: brief category ${item.category}` };
  }
  return null;
}

function classifySemanticSegment(segment: SemanticSegment): MemoryClassification | null {
  const text = sourceText({
    title: segment.title,
    summary: segment.summary,
    excerpt: segment.transcriptExcerpt
  });
  if (segment.valueLabels.includes("open_question") || unresolvedPattern.test(text)) {
    return {
      type: "question",
      reason: segment.valueLabels.includes("open_question")
        ? "extraction: semantic value label open_question"
        : "extraction: contains unresolved or pending confirmation language"
    };
  }
  if (preferencePattern.test(text)) {
    return { type: "preference", reason: "extraction: contains explicit stable preference or habit" };
  }
  if (segment.valueLabels.includes("task")) {
    return { type: "commitment", reason: "extraction: semantic task contains a future action" };
  }
  if (commitmentPattern.test(text)) {
    return {
      type: "commitment",
      reason: "extraction: contains future action and commitment language"
    };
  }
  if (segment.valueLabels.includes("decision") || segment.valueLabels.includes("risk")) {
    const label = segment.valueLabels.includes("decision") ? "decision" : "risk";
    return { type: "event", reason: `extraction: semantic value label ${label}` };
  }
  if (recentEventPattern.test(text)) {
    return { type: "event", reason: "extraction: contains a dated or completed activity" };
  }
  return null;
}

function createMemory(input: {
  userId: string;
  uploadId: string;
  recordingDate: string;
  type: MemoryItemType;
  title: string;
  summary: string;
  importance: number;
  extractionReason: string;
  structuredSourceType: Exclude<MemoryEvidenceSourceType, "transcript" | "audio_insight">;
  structuredSourceId: string;
  structuredQuote: string;
  sourceSegmentIds: string[];
  segmentById: Map<string, TranscriptSegment>;
  now: string;
}): MemoryWriteInput | null {
  const sourceSegments = Array.from(new Set(input.sourceSegmentIds))
    .map((segmentId) => input.segmentById.get(segmentId))
    .filter(
      (segment): segment is TranscriptSegment =>
        segment !== undefined && segment.uploadId === input.uploadId
    );

  if (sourceSegments.length === 0) {
    return null;
  }

  const memoryId = stableId("memory", [
    input.userId,
    input.uploadId,
    input.type,
    input.structuredSourceType,
    input.structuredSourceId
  ]);
  const evidence: MemoryEvidenceWrite[] = [
    {
      id: stableId("evidence", [memoryId, input.structuredSourceType, input.structuredSourceId]),
      sourceType: input.structuredSourceType,
      sourceId: input.structuredSourceId,
      uploadId: input.uploadId,
      date: input.recordingDate,
      quote: cleanText(input.structuredQuote),
      createdAt: input.now
    },
    ...sourceSegments.map((segment) => ({
      id: stableId("evidence", [memoryId, "transcript", segment.id]),
      sourceType: "transcript" as const,
      sourceId: segment.id,
      uploadId: input.uploadId,
      date: input.recordingDate,
      quote: cleanText(segment.text),
      createdAt: input.now
    }))
  ];

  return {
    id: memoryId,
    type: input.type,
    title: cleanText(input.title, 500),
    summary: cleanText(input.summary),
    importance: clamp(input.importance),
    importanceReasons: [input.extractionReason],
    date: input.recordingDate,
    createdAt: input.now,
    updatedAt: input.now,
    evidence
  };
}

export function extractUploadMemories(input: ExtractUploadMemoriesInput): MemoryWriteInput[] {
  const now = input.now ?? new Date().toISOString();
  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));
  const candidates: Array<MemoryWriteInput | null> = [];
  let recentSemanticEventCount = 0;

  for (const semanticSegment of input.semanticSegments) {
    const classification = classifySemanticSegment(semanticSegment);
    if (!classification) {
      continue;
    }
    if (classification.reason === "extraction: contains a dated or completed activity") {
      if (recentSemanticEventCount >= MAX_RECENT_SEMANTIC_EVENTS) {
        continue;
      }
      recentSemanticEventCount += 1;
    }
    candidates.push(
      createMemory({
        ...input,
        type: classification.type,
        title: semanticSegment.title,
        summary: semanticSegment.summary,
        importance: 0.45 + semanticSegment.confidence * 0.35,
        extractionReason: classification.reason,
        structuredSourceType: "timeline",
        structuredSourceId: semanticSegment.id,
        structuredQuote: semanticSegment.transcriptExcerpt,
        sourceSegmentIds: semanticSegment.sourceSegmentIds,
        segmentById,
        now
      })
    );
  }

  for (const briefItem of input.briefItems) {
    const classification = classifyBriefItem(briefItem);
    if (!classification) {
      continue;
    }
    candidates.push(
      createMemory({
        ...input,
        type: classification.type,
        title: briefItem.title,
        summary: briefItem.body,
        importance: priorityImportance[briefItem.priority] * 0.7 + briefItem.confidence * 0.3,
        extractionReason: classification.reason,
        structuredSourceType: "brief",
        structuredSourceId: briefItem.id,
        structuredQuote: briefItem.transcriptExcerpt,
        sourceSegmentIds: briefItem.sourceSegmentIds,
        segmentById,
        now
      })
    );
  }

  for (const relationshipSignal of input.relationshipSignals) {
    candidates.push(
      createMemory({
        ...input,
        type: "relationship_signal",
        title: relationshipSignal.summary,
        summary: relationshipSignal.explanation,
        importance: severityImportance[relationshipSignal.severity] * 0.6 + relationshipSignal.confidence * 0.4,
        extractionReason: `extraction: relationship signal ${relationshipSignal.signalType}`,
        structuredSourceType: "relationship_signal",
        structuredSourceId: relationshipSignal.id,
        structuredQuote: relationshipSignal.textEvidence.join(" "),
        sourceSegmentIds: relationshipSignal.evidenceSegments.map((evidence) => evidence.segmentId),
        segmentById,
        now
      })
    );
  }

  return candidates.filter((memory): memory is MemoryWriteInput => memory !== null);
}
