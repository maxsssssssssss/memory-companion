import type { AudioInsight, BriefItem, RelationshipSignalCard, SemanticSegment } from "@/lib/domain/types";
import type { LocalDayPayload } from "./local-analysis";
import type { MemoryContextPayload } from "./memory-context";

export type ProactiveQaScope = "current" | "week" | "all";

export type ProactiveQaSuggestion = {
  id: string;
  scope: ProactiveQaScope;
  category: "summary" | "relationship" | "tone" | "follow_up" | "memory";
  question: string;
  reason: string;
  sourceType: "brief" | "timeline" | "audio_insight" | "relationship_signal" | "memory" | "fallback";
  sourceIds: string[];
  sourceUploadIds: string[];
  priority: number;
  origin?: "rule" | "agent";
  observation?: string;
  confidence?: number;
  evidenceCount?: number;
  memoryAware?: boolean;
  insightType?: "reminder" | "reflection" | "follow_up" | "pattern_observation";
  caution?: string;
};

type BuildProactiveQaSuggestionsInput = {
  scope: ProactiveQaScope;
  referenceDate: string;
  payload?: LocalDayPayload | null;
  memoryPayloads?: LocalDayPayload[];
  memoryContext?: MemoryContextPayload | null;
  hasServerScopeData?: boolean;
  limit?: number;
};

type Candidate = ProactiveQaSuggestion;

const DEFAULT_LIMIT = 3;
const FORBIDDEN_PATTERN = /渣男|渣女|操控|有病|应该分手|人格|诊断/gu;

const fallbackQuestions: Record<ProactiveQaScope, Array<Omit<ProactiveQaSuggestion, "id" | "scope">>> = {
  current: [
    {
      category: "summary",
      question: "这次录音里最值得回看的重点是什么？",
      reason: "可以先从本次录音的摘要和时间轴抓住主线。",
      sourceType: "fallback",
      sourceIds: [],
      sourceUploadIds: [],
      priority: 10
    },
    {
      category: "tone",
      question: "这次录音里的语气和互动氛围有什么线索？",
      reason: "如果有语气线索，适合结合原文一起回看。",
      sourceType: "fallback",
      sourceIds: [],
      sourceUploadIds: [],
      priority: 9
    },
    {
      category: "follow_up",
      question: "这次录音里还有哪些没有说清的问题？",
      reason: "把未确认的问题单独拎出来，下一次更容易追问。",
      sourceType: "fallback",
      sourceIds: [],
      sourceUploadIds: [],
      priority: 8
    }
  ],
  week: [
    {
      category: "memory",
      question: "本周目前可回看的重点是什么？",
      reason: "先基于本周已有录音回看，不把单次证据说成反复模式。",
      sourceType: "fallback",
      sourceIds: [],
      sourceUploadIds: [],
      priority: 10
    },
    {
      category: "follow_up",
      question: "本周有哪些还没有说清或需要继续确认的问题？",
      reason: "先找卡点，再决定下一次要问什么。",
      sourceType: "fallback",
      sourceIds: [],
      sourceUploadIds: [],
      priority: 9
    }
  ],
  all: [
    {
      category: "memory",
      question: "当前已有记录里有哪些证据值得先回看？",
      reason: "全部记忆先做证据回看，长期结论需要跨日期证据。",
      sourceType: "fallback",
      sourceIds: [],
      sourceUploadIds: [],
      priority: 10
    },
    {
      category: "follow_up",
      question: "当前已有记录里有哪些问题还没有说清？",
      reason: "如果证据不足，回答应该明确说证据不够。",
      sourceType: "fallback",
      sourceIds: [],
      sourceUploadIds: [],
      priority: 9
    }
  ]
};

function compactText(text: string, maxLength = 72) {
  const compacted = text.replace(/\s+/g, " ").replace(FORBIDDEN_PATTERN, "越界判断").trim();
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength - 1)}...` : compacted;
}

function suggestionTextIsSafe(suggestion: Pick<ProactiveQaSuggestion, "question" | "reason">) {
  return !FORBIDDEN_PATTERN.test(`${suggestion.question} ${suggestion.reason}`);
}

function dateFromKey(dateKey: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) {
    return null;
  }

  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function weekRange(referenceDate: string) {
  const reference = dateFromKey(referenceDate) ?? new Date();
  const daysSinceMonday = (reference.getUTCDay() + 6) % 7;
  const start = addDays(reference, -daysSinceMonday);
  const end = addDays(start, 6);
  return { startKey: formatDateKey(start), endKey: formatDateKey(end) };
}

function readyPayloads(payloads: LocalDayPayload[] = []) {
  return payloads.filter((payload) => (payload.job?.status ?? payload.upload.status) === "ready");
}

function uniqueRecordingDates(payloads: LocalDayPayload[]) {
  return [...new Set(payloads.map((payload) => payload.upload.recordingDate).filter(Boolean))].sort();
}

function sourcePayloads(input: BuildProactiveQaSuggestionsInput) {
  if (input.scope === "current") {
    return input.payload && (input.payload.job?.status ?? input.payload.upload.status) === "ready" ? [input.payload] : [];
  }

  const payloads = readyPayloads(input.memoryPayloads);
  if (input.scope === "all") {
    return payloads;
  }

  const range = weekRange(input.referenceDate);
  return payloads.filter(
    (payload) => payload.upload.recordingDate >= range.startKey && payload.upload.recordingDate <= range.endKey
  );
}

function bestBriefItems(payloads: LocalDayPayload[]) {
  return payloads
    .flatMap((payload) => payload.briefItems.map((item) => ({ payload, item })))
    .filter(({ item }) => item.priority === "high" || item.priority === "medium")
    .sort((left, right) => {
      const priorityScore = (item: BriefItem) => (item.priority === "high" ? 2 : item.priority === "medium" ? 1 : 0);
      return priorityScore(right.item) - priorityScore(left.item) || right.item.confidence - left.item.confidence;
    });
}

function bestAudioInsights(payloads: LocalDayPayload[]) {
  return payloads
    .flatMap((payload) => payload.audioInsights.map((insight) => ({ payload, insight })))
    .filter(({ insight }) => insight.confidence >= 0.45 || insight.interactionLabels.some((label) => label !== "unknown"))
    .sort((left, right) => right.insight.confidence - left.insight.confidence);
}

function bestSemanticSegments(payloads: LocalDayPayload[]) {
  return payloads
    .flatMap((payload) => payload.semanticSegments.map((segment) => ({ payload, segment })))
    .sort((left, right) => right.segment.confidence - left.segment.confidence);
}

function relationshipQuestion(scope: ProactiveQaScope, card: RelationshipSignalCard, hasMultipleDates: boolean) {
  if (scope === "all") {
    return hasMultipleDates ? "过去记录里是否有证据显示类似的关系信号反复出现？" : "当前已有记录里这条关系信号的证据是什么？";
  }

  if (scope === "week") {
    return hasMultipleDates ? "本周有哪些关系信号值得继续澄清？" : "本周目前这条关系信号的证据是什么？";
  }

  if (card.signalCategory === "positive") {
    return "这次录音里的关系信号，原文证据是什么？";
  }

  return "这条需要澄清的关系信号，原文证据是什么？";
}

function relationshipReason(card: RelationshipSignalCard) {
  const label = card.signalCategory === "positive" ? "积极信号" : card.signalCategory === "risk" ? "需要留意" : "需要澄清";
  return `${label}：${compactText(card.summary)}`;
}

function suggestionsFromRelationshipSignals(scope: ProactiveQaScope, payloads: LocalDayPayload[], hasMultipleDates: boolean): Candidate[] {
  return payloads
    .flatMap((payload) => (payload.relationshipSignals ?? []).map((card) => ({ payload, card })))
    .sort((left, right) => right.card.confidence - left.card.confidence)
    .slice(0, 2)
    .map(({ payload, card }, index) => ({
      id: `${scope}_relationship_${card.id}`,
      scope,
      category: "relationship",
      question: relationshipQuestion(scope, card, hasMultipleDates),
      reason: relationshipReason(card),
      sourceType: "relationship_signal",
      sourceIds: [card.id],
      sourceUploadIds: [card.uploadId || payload.upload.id],
      priority: 100 - index
    }));
}

function briefQuestion(scope: ProactiveQaScope, item: BriefItem, hasMultipleDates: boolean) {
  if (scope === "all") {
    if (!hasMultipleDates) {
      return "当前已有记录里有哪些证据值得先回看？";
    }

    return item.category === "open_question"
      ? "过去记录里是否有证据显示哪些问题长期没有说清？"
      : "过去记录里是否有证据显示类似话题反复出现？";
  }

  if (scope === "week") {
    if (!hasMultipleDates) {
      return "本周目前可回看的重点是什么？";
    }

    return item.category === "open_question" ? "本周有哪些还没有说清的问题？" : "本周有哪些反复出现的话题值得回看？";
  }

  if (item.category === "commitment") {
    return "这次录音里有哪些明确承诺需要回看？";
  }

  if (item.category === "task") {
    return "这次录音里有哪些下一步需要跟进？";
  }

  if (item.category === "open_question") {
    return "这次录音里有哪些还没说清、需要继续确认的问题？";
  }

  return "这次录音里最值得回看的重点是什么？";
}

function suggestionsFromBriefItems(scope: ProactiveQaScope, payloads: LocalDayPayload[], hasMultipleDates: boolean): Candidate[] {
  return bestBriefItems(payloads)
    .slice(0, 1)
    .map(({ payload, item }) => ({
      id: `${scope}_brief_${item.id}`,
      scope,
      category: item.category === "open_question" ? "follow_up" : scope === "current" ? "summary" : "memory",
      question: briefQuestion(scope, item, hasMultipleDates),
      reason: scope === "all" ? `先回看有日期的证据：${compactText(item.title)}` : `摘要里出现了这个线索：${compactText(item.title)}`,
      sourceType: "brief",
      sourceIds: [item.id],
      sourceUploadIds: [payload.upload.id],
      priority: 80
    }));
}

function toneQuestion(scope: ProactiveQaScope, hasMultipleDates: boolean) {
  if (scope === "all") {
    return hasMultipleDates ? "过去记录里是否有证据显示类似语气或互动氛围反复出现？" : "当前已有记录里的语气和互动氛围有什么证据？";
  }

  if (scope === "week") {
    return hasMultipleDates ? "本周的语气和互动氛围有没有变化的线索？" : "本周目前这条录音的语气和互动氛围有什么线索？";
  }

  return "这次录音里的语气和互动氛围有什么线索？";
}

function suggestionsFromAudioInsights(scope: ProactiveQaScope, payloads: LocalDayPayload[], hasMultipleDates: boolean): Candidate[] {
  return bestAudioInsights(payloads)
    .slice(0, 1)
    .map(({ payload, insight }) => ({
      id: `${scope}_audio_${insight.id}`,
      scope,
      category: "tone",
      question: toneQuestion(scope, hasMultipleDates),
      reason: `语气线索提到：${compactText(insight.summary)}`,
      sourceType: "audio_insight",
      sourceIds: [insight.id],
      sourceUploadIds: [payload.upload.id],
      priority: 70
    }));
}

function timelineQuestion(scope: ProactiveQaScope) {
  if (scope === "all") {
    return "过去记录里哪些时间轴片段最值得先回看证据？";
  }

  if (scope === "week") {
    return "本周时间轴里哪些片段最值得继续追问？";
  }

  return "这次录音时间轴里最值得回看的是哪一段？";
}

function suggestionsFromSemanticSegments(scope: ProactiveQaScope, payloads: LocalDayPayload[]): Candidate[] {
  return bestSemanticSegments(payloads)
    .slice(0, 1)
    .map(({ payload, segment }) => ({
      id: `${scope}_timeline_${segment.id}`,
      scope,
      category: scope === "current" ? "summary" : "memory",
      question: timelineQuestion(scope),
      reason: `时间轴里有一段：${compactText(segment.title)}`,
      sourceType: "timeline",
      sourceIds: [segment.id],
      sourceUploadIds: [payload.upload.id],
      priority: 60
    }));
}

function fallbackSuggestions(scope: ProactiveQaScope, sourceUploadIds: string[] = []) {
  return fallbackQuestions[scope].map((suggestion, index) => ({
    ...suggestion,
    id: `${scope}_fallback_${index + 1}`,
    scope,
    sourceUploadIds
  }));
}

function dedupeSuggestions(suggestions: Candidate[]) {
  const seen = new Set<string>();
  return suggestions.flatMap((suggestion) => {
    const key = `${suggestion.scope}:${suggestion.question}`;
    if (seen.has(key) || !suggestionTextIsSafe(suggestion)) {
      return [];
    }

    seen.add(key);
    return [suggestion];
  });
}

export function buildProactiveQaSuggestions(input: BuildProactiveQaSuggestionsInput): ProactiveQaSuggestion[] {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const payloads = sourcePayloads(input);
  const hasMultipleDates = uniqueRecordingDates(payloads).length >= 2;
  const sourceUploadIds = [...new Set(payloads.map((payload) => payload.upload.id))];
  const candidates = [
    ...suggestionsFromRelationshipSignals(input.scope, payloads, hasMultipleDates),
    ...suggestionsFromBriefItems(input.scope, payloads, hasMultipleDates),
    ...suggestionsFromAudioInsights(input.scope, payloads, hasMultipleDates),
    ...suggestionsFromSemanticSegments(input.scope, payloads)
  ];
  const safeCandidates = dedupeSuggestions(candidates).sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));

  if (safeCandidates.length > 0) {
    return safeCandidates.slice(0, limit);
  }

  if (payloads.length > 0 || input.hasServerScopeData || input.memoryContext) {
    return fallbackSuggestions(input.scope, sourceUploadIds).slice(0, limit);
  }

  return [];
}
