import type { MemoryEvidenceSourceType, MemoryItemType, MemoryStatus } from "./types";
import { isOneTimeChoiceText, isStablePreferenceText } from "./admission";

export type ImportanceInput = {
  type: MemoryItemType;
  title: string;
  summary: string;
  status?: MemoryStatus;
  occurrenceCount?: number;
  evidenceDates?: string[];
  evidenceSourceTypes?: MemoryEvidenceSourceType[];
  evidenceCount?: number;
};

export type ImportanceFactor = {
  id: string;
  delta: number;
};

export type ImportanceResult = {
  score: number;
  reasons: string[];
  breakdown: {
    baseScore: number;
    positiveFactors: ImportanceFactor[];
    penalties: ImportanceFactor[];
    finalScore: number;
  };
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
  commitment: 0.56,
  preference: 0.58,
  question: 0.48,
  relationship_signal: 0.4,
  event: 0.36,
  summary: 0.22
};

const EXPLICIT_DATE_PATTERN =
  /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}\b|\d{1,2}月\d{1,2}日|周[一二三四五六日天]|星期[一二三四五六日天]|明天|后天|下周|周末|today|tomorrow|next\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i;
const PERSON_PATTERN =
  /(?:和|问|告诉|联系|见)\s*[\p{Script=Han}]{1,4}(?:先生|女士|老师|同学)|(?:男友|女友|伴侣|丈夫|妻子|妈妈|爸爸|朋友|对方)|\b(?:with|ask|tell|meet|contact)\s+[A-Z][a-z]{1,30}\b/u;
const FUTURE_ACTION_PATTERN =
  /下一步|跟进|待办|计划|安排|预约|确认|回复|联系|准备|会在|将在|下次|答应|承诺|需要.{0,8}(?:做|确认|跟进|回复)|next step|follow[- ]?up|plan(?:ned)?|will\b|going to|confirm|schedule|promise/i;
const UNRESOLVED_PATTERN =
  /未解决|没解决|没说清|待确认|待定|尚未|还需|仍需|需要确认|open question|unresolved|not decided|still (?:open|unclear)/i;
const LIFECYCLE_PATTERN =
  /改期|调整|延期|完成|解决|落实|兑现|取消|恢复|重新确认|postponed|rescheduled|completed|resolved|finished|cancelled|canceled/i;
const GENERIC_SUMMARY_PATTERN =
  /^(?:对话|谈话|录音|会议|互动|内容)?(?:概述|概览|总结|摘要|梳理|主要内容)|围绕多个话题|讨论了多个|conversation summary|general discussion|several topics/i;
const WEAK_RELATIONSHIP_PATTERN =
  /一次|单次|片段|礼貌|简单回应|主动倾听|情绪支持|active listening|emotional support|polite response/i;

function rounded(value: number) {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

export function calculateImportance(memory: ImportanceInput): ImportanceResult {
  const text = `${memory.title} ${memory.summary}`.trim();
  const status = memory.status ?? "active";
  const occurrenceCount = Math.max(1, Math.floor(memory.occurrenceCount ?? 1));
  const distinctDates = new Set(memory.evidenceDates ?? []).size;
  const distinctSourceTypes = new Set(memory.evidenceSourceTypes ?? []).size;
  const evidenceCount = Math.max(0, Math.floor(memory.evidenceCount ?? 0));
  const baseScore = TYPE_SCORES[memory.type];
  const reasons = [`${memory.type} type`];
  const positiveFactors: ImportanceFactor[] = [];
  const penalties: ImportanceFactor[] = [];
  let score = baseScore;

  const add = (id: string, delta: number, legacyReason?: string) => {
    score += delta;
    positiveFactors.push({ id, delta });
    reasons.push(id);
    if (legacyReason) reasons.push(legacyReason);
  };
  const penalize = (id: string, delta: number) => {
    score -= delta;
    penalties.push({ id, delta: -delta });
    reasons.push(id);
  };

  if (EXPLICIT_DATE_PATTERN.test(text)) add("specific_deadline", 0.09, "contains explicit date");
  if (PERSON_PATTERN.test(text)) add("named_participant", 0.03, "mentions a person");
  if (status === "active" && FUTURE_ACTION_PATTERN.test(text)) {
    add("explicit_future_action", 0.09, "contains future action");
  }
  if (status === "active" && (memory.type === "question" || UNRESOLVED_PATTERN.test(text))) {
    add("unresolved_item", 0.1, "unresolved item");
  }
  if (memory.type === "preference" && isStablePreferenceText(text)) {
    add("stable_preference", 0.12);
  }
  if (LIFECYCLE_PATTERN.test(text)) add("meaningful_state_change", 0.08);
  if (occurrenceCount >= 2) {
    add("repeated_occurrence", occurrenceCount >= 3 ? 0.2 : 0.11, "appeared multiple times");
  }
  if (distinctDates >= 2) {
    add("multiple_distinct_dates", distinctDates >= 3 ? 0.16 : 0.1, "appeared on multiple dates");
  }
  if ((memory.evidenceSourceTypes ?? []).includes("transcript")) {
    add("high_quality_transcript_evidence", 0.04);
  }
  if (distinctSourceTypes >= 2 && distinctDates >= 2) {
    add("diverse_cross_date_evidence", 0.03, "supported by diverse evidence");
  }

  if (memory.type === "preference" && isOneTimeChoiceText(text)) penalize("one_time_choice", 0.16);
  if (GENERIC_SUMMARY_PATTERN.test(text)) penalize("generic_summary", 0.14);
  if (status === "resolved" && memory.type === "question") penalize("resolved_low_future_value", 0.12);
  if (
    memory.type === "relationship_signal" &&
    occurrenceCount === 1 &&
    distinctDates <= 1 &&
    WEAK_RELATIONSHIP_PATTERN.test(text)
  ) {
    penalize("single_weak_relationship_observation", 0.1);
  }
  if (evidenceCount >= 20 && distinctDates <= 1 && occurrenceCount === 1) {
    penalize("many_rows_single_occurrence", 0.08);
  }

  const finalScore = rounded(score);
  return {
    score: finalScore,
    reasons: Array.from(new Set(reasons)),
    breakdown: {
      baseScore,
      positiveFactors,
      penalties,
      finalScore
    }
  };
}
