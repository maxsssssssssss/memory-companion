import type { RelationshipSignalCard } from "@/lib/domain/types";
import { meaningfulTextTokens, roundedScore } from "@/lib/server/text-features";
import type { MemoryWriteInput } from "./types";

export type MemoryAdmissionDecision = {
  memoryId: string;
  type: MemoryWriteInput["type"];
  shouldPersist: boolean;
  score: number;
  reasons: string[];
  memoryTier: "daily_only" | "long_term";
};

const STABLE_PREFERENCE_PATTERN =
  /不喜欢|更喜欢|最喜欢|特别喜欢|更倾向|(?:我的|我对.{1,20}的)偏好(?:是|为|：|:)|平时.{0,8}(?:喜欢|选择|会)|通常.{0,8}(?:喜欢|选择|会)|一般(?:会|选|喜欢|倾向)|习惯|不太能接受|一直习惯|prefer|usually|habit/iu;
const ONE_TIME_CHOICE_PATTERN =
  /(?:今天|这次|这回|当前|现在|暂时).{0,10}(?:先|就|选|点|喝|吃|用|想|不想)|(?:for now|today|this time)/iu;
const FUTURE_ACTION_PATTERN =
  /答应|承诺|约定|说好|保证|会在|将在|最晚|之前|以后|稍后|今晚|明天|后天|下周|周[一二三四五六日天]|星期[一二三四五六日天]|下次|回来|回复|确认|完成|提交|发送|检查|查询|预约|follow[- ]?up|will\b|promise|commitment|deadline|confirm|complete|submit|send/iu;
const DEADLINE_PATTERN =
  /\d{1,2}(?:点|时|[:：]\d{1,2})|\d{4}-\d{2}-\d{2}|今晚|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]|之前|最晚|within|before|by\s+\w+/iu;
const UNRESOLVED_PATTERN =
  /未解决|没解决|还没|仍未|待确认|待定|尚未|还需|仍需|需要确认|没有下文|unresolved|still (?:open|unclear)|not decided/iu;
const LIFECYCLE_PATTERN =
  /计划|安排|调整|改期|延期|取消|完成|落实|解决|确认|达成|提交|购买|预约|参观|就诊|follow[- ]?up|planned|postponed|cancelled|completed|resolved|finished/iu;
const GENERIC_SUMMARY_PATTERN =
  /^(?:围绕.{2,100}(?:展开|梳理|讨论|总结)|.{0,80}(?:多个话题|多项内容|综合问题).{0,20})[。！! ]*$/u;
const GENERIC_TITLE_PATTERN = /(?:概述|概览|总结|摘要|梳理)$|^(?:综合|整体|日常|一般).{0,12}$/u;
const ORDINARY_CHATTER_PATTERN =
  /^(?:你好|早上好|晚上好|谢谢|好的|嗯|天气.{0,12}|路上.{0,12}|今天吃.{0,12}|随便聊聊)[。！! ]*$/u;
const BOUNDARY_AGREEMENT_PATTERN =
  /(?:双方|我们).{0,16}(?:同意|约定|说好|确认|接受).{0,40}(?:暂停|休息|边界|回来|恢复|不追问|说明)|(?:暂停|休息|边界).{0,32}(?:约定|说好|双方确认|恢复沟通|回来继续|不连续追问)/u;
const EXPLICIT_COMMITMENT_PATTERN = /答应|承诺|约定|说好|保证|promise|commitment/iu;
const TRANSIENT_SAME_SESSION_PATTERN = /吃完|饭后|待会|一会儿|这顿|当晚具体安排|回去路上/iu;
const DURABLE_TIME_PATTERN =
  /\d{1,2}(?:点|时|[:：]\d{1,2})|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]|下周|下次|月底|before|by\s+\w+/iu;
const GENERIC_RELATIONSHIP_SUMMARY_PATTERN =
  /^(?:对方|双方|互动|回应).{0,24}(?:出现|给出|体现|展现|涉及).{0,24}(?:线索|回应方式|答复时间|后续行动|承诺|支持|边界)[。！! ]*$/u;

export function isStablePreferenceText(value: string) {
  return STABLE_PREFERENCE_PATTERN.test(value) && !(
    ONE_TIME_CHOICE_PATTERN.test(value) && !/平时|通常|一般|习惯|更喜欢|更倾向|不喜欢|偏好/u.test(value)
  );
}

export function isOneTimeChoiceText(value: string) {
  return ONE_TIME_CHOICE_PATTERN.test(value) && !isStablePreferenceText(value);
}

function memoryText(memory: MemoryWriteInput) {
  return [
    memory.title,
    memory.summary,
    ...(memory.evidence ?? []).map((evidence) => evidence.quote)
  ].join(" ");
}

function hasSpecificContent(value: string) {
  return meaningfulTextTokens(value).size >= 3;
}

function isBroadAggregate(memory: MemoryWriteInput, sourceSegmentCount: number) {
  return GENERIC_SUMMARY_PATTERN.test(memory.summary.trim()) && (
    GENERIC_TITLE_PATTERN.test(memory.title.trim()) || sourceSegmentCount > 8
  );
}

export function evaluateMemoryAdmission(input: {
  memory: MemoryWriteInput;
  relationshipSignal?: RelationshipSignalCard;
  sourceSegmentCount?: number;
  occurrenceCount?: number;
  distinctDates?: number;
}): MemoryAdmissionDecision {
  const memory = input.memory;
  const text = memoryText(memory);
  const reasons: string[] = [];
  const sourceSegmentCount = input.sourceSegmentCount ?? memory.evidence.filter((item) => item.sourceType === "transcript").length;
  const broadAggregate = isBroadAggregate(memory, sourceSegmentCount);
  let score = 0.45;
  let shouldPersist = true;

  if (input.relationshipSignal) {
    const signal = input.relationshipSignal;
    const repeatedAcrossDates = (input.distinctDates ?? 1) >= 2 && (input.occurrenceCount ?? 1) >= 2;
    const strongEvidence = signal.evidenceSegments.length >= 2 && signal.confidence >= 0.65;
    const groundedSignalText = [
      signal.summary,
      ...signal.evidenceSegments.map((evidence) => evidence.text)
    ].join(" ");
    const specificSignal = hasSpecificContent(signal.summary) &&
      !GENERIC_RELATIONSHIP_SUMMARY_PATTERN.test(signal.summary.trim());
    const actionableCommitment = FUTURE_ACTION_PATTERN.test(groundedSignalText) && specificSignal && (
      DEADLINE_PATTERN.test(groundedSignalText) || EXPLICIT_COMMITMENT_PATTERN.test(groundedSignalText)
    ) && (!TRANSIENT_SAME_SESSION_PATTERN.test(groundedSignalText) || DURABLE_TIME_PATTERN.test(groundedSignalText));
    if (signal.signalType === "clear_commitment" && actionableCommitment) {
      score = 0.84;
      reasons.push("actionable_relationship_commitment");
    } else if (signal.signalType === "boundary_respect" && BOUNDARY_AGREEMENT_PATTERN.test(text)) {
      score = 0.76;
      reasons.push("explicit_boundary_agreement");
    } else if (repeatedAcrossDates && strongEvidence) {
      score = 0.72;
      reasons.push("repeated_across_dates", "strong_relationship_evidence");
    } else {
      shouldPersist = false;
      score = roundedScore(0.28 + signal.confidence * 0.2);
      reasons.push(
        signal.signalType === "active_listening" || signal.signalType === "emotional_support"
          ? "single_supportive_interaction_is_daily_only"
          : "single_relationship_observation_is_daily_only"
      );
    }
  } else if (memory.type === "preference") {
    shouldPersist = isStablePreferenceText(text) && !isOneTimeChoiceText(text) && !broadAggregate;
    score = shouldPersist ? 0.75 : 0.28;
    reasons.push(shouldPersist ? "explicit_stable_preference" : "one_time_or_ambiguous_choice");
  } else if (memory.type === "commitment") {
    shouldPersist = FUTURE_ACTION_PATTERN.test(text) && hasSpecificContent(text) && !broadAggregate;
    score = shouldPersist ? 0.78 + (DEADLINE_PATTERN.test(text) ? 0.08 : 0) : 0.36;
    reasons.push(shouldPersist ? "explicit_future_action" : "ambiguous_non_actionable_commitment");
    if (shouldPersist && DEADLINE_PATTERN.test(text)) reasons.push("specific_deadline");
  } else if (memory.type === "question") {
    const broad = broadAggregate;
    shouldPersist = UNRESOLVED_PATTERN.test(text) && hasSpecificContent(`${memory.title} ${memory.summary}`) && !broad;
    score = shouldPersist ? 0.68 : 0.32;
    reasons.push(shouldPersist ? "unresolved_with_follow_up_value" : broad ? "broad_aggregate_question" : "resolved_or_generic_question");
  } else if (memory.type === "event") {
    const explicitRecentActivity = (memory.importanceReasons ?? []).includes("extraction: contains a dated or completed activity");
    shouldPersist = (LIFECYCLE_PATTERN.test(text) || explicitRecentActivity) && !ORDINARY_CHATTER_PATTERN.test(memory.summary.trim());
    score = shouldPersist ? 0.62 : 0.3;
    reasons.push(shouldPersist ? "event_lifecycle_value" : "ordinary_transient_event");
  } else if (memory.type === "summary") {
    shouldPersist = !GENERIC_SUMMARY_PATTERN.test(memory.summary.trim()) && hasSpecificContent(memory.summary);
    score = shouldPersist ? 0.5 : 0.22;
    reasons.push(shouldPersist ? "specific_summary" : "generic_summary");
  }

  if (sourceSegmentCount > 20 && GENERIC_SUMMARY_PATTERN.test(memory.summary.trim())) {
    shouldPersist = false;
    score -= 0.15;
    reasons.push("broad_single_day_evidence_span");
  }

  return {
    memoryId: memory.id,
    type: memory.type,
    shouldPersist,
    score: roundedScore(score),
    reasons,
    memoryTier: shouldPersist ? "long_term" : "daily_only"
  };
}
