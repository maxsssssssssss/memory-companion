import {
  meaningfulTextTokens,
  roundedScore,
  sharedTokenCount,
  tokenSetSimilarity
} from "@/lib/server/text-features";
import type { RelationshipLifecycleRejectionReason, RelationshipLifecycleSignal } from "./types";

const LIFECYCLE_GENERIC_TOKENS = new Set([
  "已经", "完成", "确认", "计划", "安排", "承诺", "答应", "问题", "是否", "结果", "解决", "以后", "下次",
  "双方", "对方", "一方", "具体", "明确", "状态", "尚未", "还没", "需要", "进行", "成功", "相关", "事情",
  "方把", "把不", "理解", "而不", "不是", "表示", "说明", "回应", "希望", "提出", "给出", "不会", "不再",
  "其中", "这里", "当前", "片段", "互动", "感受", "线索"
]);
const GENERIC_SCOPE_TOKENS = new Set(["社区", "课程", "活动", "时间", "位置", "内容", "方式", "信息"]);
const EXPLICIT_ACTION_PATTERN = /预约|报名|付款|提交|修改|检查|通知|练习|问答|答复|购买|参加|取消|见面|用餐|沟通|发送|查询|取件|寄送/gu;
const GOAL_BEFORE_STATE_PATTERN = /([\p{Script=Han}]{2,8}?)(?:状态|已经|已|尚未|还没|完成|成功|结果|待确认)/gu;
const TIMEFRAME_PATTERN = /\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日|(?:周|星期)[一二三四五六日天]/gu;

function normalizeToken(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function normalizeGoalKey(value: string) {
  const normalized = normalizeToken(value);
  if (/^(?:报名|预约)$/u.test(normalized)) return "registration_or_reservation";
  return normalized;
}

function isGenericSummary(value: string) {
  return /回应里出现|后续回应方式|关系信号|出现了.{0,8}线索|具体互动线索/u.test(value);
}

function featureText(signal: RelationshipLifecycleSignal) {
  const evidence = isGenericSummary(signal.summary) ? signal.evidenceText : [];
  return [
    signal.summary,
    ...evidence,
    ...(signal.metadata?.entities ?? []),
    ...(signal.metadata?.goals ?? []),
    ...(signal.metadata?.timeframes ?? [])
  ].join(" ");
}

function topicTokens(signal: RelationshipLifecycleSignal) {
  const tokens = meaningfulTextTokens(featureText(signal));
  return new Set([...tokens].filter((token) => !LIFECYCLE_GENERIC_TOKENS.has(token)));
}

function goalKeys(signal: RelationshipLifecycleSignal) {
  const text = featureText(signal).normalize("NFKC");
  const keys = new Set((signal.metadata?.goals ?? []).map(normalizeGoalKey).filter(Boolean));
  for (const action of text.match(EXPLICIT_ACTION_PATTERN) ?? []) keys.add(normalizeGoalKey(action));
  for (const match of text.matchAll(GOAL_BEFORE_STATE_PATTERN)) {
    const phrase = match[1]
      .replace(/^(?:社区|当前|双方|对方|一方|关于|已经|计划|准备)+/u, "")
      .replace(/(?:的|之|该)$/u, "")
      .trim();
    if (phrase.length >= 2 && phrase.length <= 8) keys.add(normalizeToken(phrase));
  }
  return keys;
}

function timeframeKeys(signal: RelationshipLifecycleSignal) {
  const values = [...(signal.metadata?.timeframes ?? []), signal.summary];
  const keys = new Set<string>();
  for (const value of values) {
    for (const raw of value.match(TIMEFRAME_PATTERN) ?? []) {
      keys.add(normalizeToken(raw.replace(/^星期/u, "周")));
    }
  }
  return keys;
}

function intersection<T>(left: ReadonlySet<T>, right: ReadonlySet<T>) {
  return [...left].filter((value) => right.has(value));
}

export type LifecycleMatchFeatures = {
  topicScore: number;
  sharedTopics: number;
  sharedGoals: number;
  sharedEvidence: number;
  sharedSpeakers: number;
  temporalGapSeconds: number;
  contextScore: number;
};

export type LifecycleIdentityMatch =
  | { matched: true; features: LifecycleMatchFeatures }
  | { matched: false; rejectionReason: RelationshipLifecycleRejectionReason; features: LifecycleMatchFeatures };

export function matchLifecycleIdentity(
  source: RelationshipLifecycleSignal,
  target: RelationshipLifecycleSignal
): LifecycleIdentityMatch {
  const sourceTopics = topicTokens(source);
  const targetTopics = topicTokens(target);
  const sourceGoals = goalKeys(source);
  const targetGoals = goalKeys(target);
  const sourceTimes = timeframeKeys(source);
  const targetTimes = timeframeKeys(target);
  const sharedTopics = sharedTokenCount(sourceTopics, targetTopics);
  const sharedGoals = intersection(sourceGoals, targetGoals).length;
  const sharedEvidence = intersection(new Set(source.evidenceSegmentIds), new Set(target.evidenceSegmentIds)).length;
  const sharedSpeakers = intersection(new Set(source.speakers), new Set(target.speakers)).length;
  const temporalGapSeconds = Math.max(0, target.timeRange.startSeconds - source.timeRange.endSeconds);
  const topicScore = roundedScore(Math.max(
    tokenSetSimilarity(sourceTopics, targetTopics),
    sharedTopics >= 3 ? 0.72 : sharedTopics === 2 ? 0.52 : sharedTopics === 1 ? 0.3 : 0,
    sharedGoals > 0 ? 0.68 : 0,
    sharedEvidence > 0 ? 0.9 : 0
  ));
  const contextScore = roundedScore(sharedEvidence > 0 ? 1 : sharedSpeakers > 0 ? 0.8 : temporalGapSeconds <= 600 ? 0.58 : 0);
  const features = {
    topicScore,
    sharedTopics,
    sharedGoals,
    sharedEvidence,
    sharedSpeakers,
    temporalGapSeconds,
    contextScore
  };

  if (target.timeRange.startSeconds <= source.timeRange.startSeconds) {
    return { matched: false, rejectionReason: "non_forward_time", features };
  }
  const stronglyAnchoredLongRangeMatch = sharedGoals > 0 && sharedTopics >= 3 && topicScore >= 0.52;
  if (sharedEvidence === 0 && temporalGapSeconds > 1_800 && !stronglyAnchoredLongRangeMatch) {
    return { matched: false, rejectionReason: "different_time_window", features };
  }
  if (sourceTimes.size > 0 && targetTimes.size > 0 && intersection(sourceTimes, targetTimes).length === 0) {
    return { matched: false, rejectionReason: "different_time_window", features };
  }
  const proximateGoalContinuation = sharedGoals > 0 && sharedSpeakers > 0 && temporalGapSeconds <= 900;
  if (sharedEvidence === 0 && sharedTopics === 0 && !proximateGoalContinuation) {
    return { matched: false, rejectionReason: "different_entity", features };
  }
  if (sourceGoals.size > 0 && targetGoals.size > 0 && sharedGoals === 0 && sharedEvidence === 0) {
    return { matched: false, rejectionReason: "different_goal", features };
  }
  const strongLocalTopicIdentity = sharedTopics >= 4 && topicScore >= 0.72 && temporalGapSeconds <= 300;
  if (sharedEvidence === 0 && sharedGoals === 0 && !strongLocalTopicIdentity) {
    return { matched: false, rejectionReason: "different_entity", features };
  }
  const onlyGenericSharedTopic = sharedTopics === 1 && intersection(sourceTopics, targetTopics).every((token) => GENERIC_SCOPE_TOKENS.has(token));
  if (
    sharedEvidence === 0 &&
    sharedGoals === 0 &&
    (sharedTopics === 0 || onlyGenericSharedTopic || (sharedTopics === 1 && topicScore < 0.35))
  ) {
    return { matched: false, rejectionReason: "different_entity", features };
  }
  if (contextScore === 0) {
    return { matched: false, rejectionReason: "unrelated_interaction_context", features };
  }
  return { matched: true, features };
}
