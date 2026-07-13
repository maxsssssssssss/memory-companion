import type { MemoryEvidenceSourceType, MemoryItemType, MemoryStatus } from "./types";

export type ImportanceInput = {
  type: MemoryItemType;
  title: string;
  summary: string;
  status?: MemoryStatus;
  occurrenceCount?: number;
  evidenceDates?: string[];
  evidenceSourceTypes?: MemoryEvidenceSourceType[];
};

export type ImportanceResult = {
  score: number;
  reasons: string[];
};

const EXTRACTION_REASON_PREFIX = "extraction:";

export function combineImportanceReasons(calculated: string[], existing: string[] = []) {
  return Array.from(
    new Set([
      ...existing.filter((reason) => reason.startsWith(EXTRACTION_REASON_PREFIX)),
      ...calculated
    ])
  ).slice(0, 20);
}

const TYPE_SCORES: Record<MemoryItemType, number> = {
  commitment: 0.7,
  preference: 0.7,
  question: 0.62,
  relationship_signal: 0.6,
  event: 0.5,
  summary: 0.35
};

const EXPLICIT_DATE_PATTERN =
  /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}\b|\d{1,2}月\d{1,2}日|周[一二三四五六日天]|星期[一二三四五六日天]|明天|后天|下周|周末|today|tomorrow|next\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i;
const PERSON_PATTERN =
  /(?:和|问|告诉|联系|见)\s*[\p{Script=Han}]{1,4}(?:先生|女士|老师|同学)?|(?:男友|女友|伴侣|丈夫|妻子|妈妈|爸爸|朋友|对方)|\b(?:with|ask|tell|meet|contact)\s+[A-Z][a-z]{1,30}\b/u;
const FUTURE_ACTION_PATTERN =
  /下一步|跟进|待办|计划|安排|预约|确认|回复|联系|准备|会在|将在|下次|需要.{0,8}(?:做|确认|跟进|回复)|next step|follow[- ]?up|plan(?:ned)?|will\b|going to|confirm|schedule/i;
const UNRESOLVED_PATTERN =
  /未解决|没解决|没说清|待确认|待定|尚未|还需|仍需|需要确认|open question|unresolved|not decided|still (?:open|unclear)/i;

function rounded(value: number) {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

export function calculateImportance(memory: ImportanceInput): ImportanceResult {
  const text = `${memory.title} ${memory.summary}`.trim();
  const status = memory.status ?? "active";
  const occurrenceCount = Math.max(1, Math.floor(memory.occurrenceCount ?? 1));
  const distinctDates = new Set(memory.evidenceDates ?? []).size;
  const distinctSourceTypes = new Set(memory.evidenceSourceTypes ?? []).size;
  const reasons = [`${memory.type} type`];
  let score = TYPE_SCORES[memory.type];

  if (EXPLICIT_DATE_PATTERN.test(text)) {
    score += 0.05;
    reasons.push("contains explicit date");
  }
  if (PERSON_PATTERN.test(text)) {
    score += 0.04;
    reasons.push("mentions a person");
  }
  if (FUTURE_ACTION_PATTERN.test(text)) {
    score += 0.08;
    reasons.push("contains future action");
  }
  if (status === "active" && (memory.type === "question" || UNRESOLVED_PATTERN.test(text))) {
    score += 0.07;
    reasons.push("unresolved item");
  }
  if (occurrenceCount >= 2) {
    score += occurrenceCount >= 3 ? 0.18 : 0.1;
    reasons.push("appeared multiple times");
  }
  if (distinctDates >= 2) {
    score += distinctDates >= 3 ? 0.08 : 0.05;
    reasons.push("appeared on multiple dates");
  }
  if (distinctSourceTypes >= 2) {
    score += 0.03;
    reasons.push("supported by diverse evidence");
  }

  return { score: rounded(score), reasons };
}
