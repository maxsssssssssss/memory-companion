import { meaningfulTextTokens, sharedTokenCount } from "@/lib/server/text-features";

export type QaQueryIntentAnalysis = {
  intent: "general" | "lifecycle_resolution";
  preferLatestState: boolean;
  asksForCompletionEvidence: boolean;
  aggregateCommitmentCompletion: boolean;
  topicTokens: string[];
};

export type QaLifecycleEvidenceState = "resolved" | "pending" | "neutral";

export type QaLifecycleEvidenceAssessment = {
  topicOverlap: number;
  state: QaLifecycleEvidenceState;
};

const lifecycleIntentPatterns = [
  /后来(?:怎么样|如何|变成|是怎样|是如何|是什么)?/u,
  /(?:最终|最后)(?:状态|结果|怎么样|如何|变成|决定|确认|完成)?/u,
  /后续(?:怎么样|如何|状态|结果|进展)?/u,
  /(?:现在|目前).{0,10}(?:状态|怎么样|如何|进展|结果)/u,
  /(?:怎样|如何).{0,8}(?:解决|完成|确认|收尾)/u,
  /(?:有没有|是否|有无).{0,48}(?:已经|已|完成|确认|解决|履行|兑现|落实|提交|付款|支付|预约|发送|收到)/u
];

const completionConfirmationPatterns = [
  /(?:做完|完成|做到|兑现|履行|实现)(?:了)?(?:吗|没有|没|否)/u,
  /(?:有没有|是否|有无).{0,48}(?:做完|完成|做到|兑现|履行|实现)/u,
  /(?:后来|最终|最后|后续).{0,24}(?:做完|完成|做到|兑现|履行|实现).{0,8}(?:没有|没|吗|否)?/u
];

const completionEvidencePatterns = [
  /(?:有没有|是否|有无).{0,48}(?:已经|已|完成|确认|解决|履行|兑现|落实|提交|付款|支付|预约|发送|收到)/u,
  /(?:后来|最终|最后|后续|现在|目前).{0,24}(?:完成|确认|解决|履行|兑现|落实|提交|付款|支付|预约|发送|收到|状态|结果)/u,
  /(?:怎样|如何).{0,8}(?:解决|完成|确认|收尾)/u
];

const aggregateCommitmentPatterns = [
  /(?:答应|承诺|约定)/u,
  /(?:我会|将会|将在).{0,28}(?:提交|付款|支付|完成|做完|做到|履行|兑现|落实|实现|预约|发送|发(?:给)?|回复|核实|查看)/u,
  /\b(?:promise|commitment)\b/iu
];

const aggregateFulfillmentPatterns = [
  /已经(?:提交|付款|支付|完成|做完|做到|履行|兑现|落实|实现|预约|发送|收到|回复|核实|查看)/u,
  /已(?:提交|付款|支付|完成|做完|做到|履行|兑现|落实|实现|预约|发送|收到|回复|核实|查看)/u,
  /(?:提交|付款|支付|发送|回复)(?:成功|完成)/u,
  /(?:预约|任务|事项)已经完成/u,
  /(?:确认通知|回复|答复)也?收到了?/u,
  /(?:做完|做到|履行|兑现|落实|实现|完成)了/u,
  /\b(?:completed|fulfilled|paid|booked)\b/iu
];

const genericLifecycleTokens = new Set([
  "是否", "有没", "没有", "有无", "后来", "最终", "最后", "后续", "现在", "目前", "状态", "结果",
  "怎样", "如何", "怎么", "什么", "变成", "解决", "完成", "确认", "已经", "证据", "表明", "录音",
  "记录", "问题", "事情", "这个", "那个", "当前", "前问", "问中", "中是", "的是", "了吗", "没有",
  "做完", "做到", "兑现", "履行", "实现", "完了"
]);

const resolvedStatePatterns = [
  /已经(?:提交|付款|支付|完成|做完|做到|确认|解决|履行|兑现|落实|实现|预约|发送|收到)/giu,
  /已(?:提交|付款|支付|完成|做完|做到|确认|解决|履行|兑现|落实|实现|预约|发送|收到)/giu,
  /(?:提交|付款|支付|预约|发送)(?:成功|完成)/giu,
  /(?:预约|计划|安排)已经完成/giu,
  /(?:确认通知|回复|答复)也?收到了?/giu,
  /(?:预约|安排|状态)(?:成功|已定|确定|确认)/giu,
  /(?:最终|明确)(?:决定|确认|同意|完成|解决)/giu,
  /双方(?:决定|确认|同意|达成)/giu,
  /我也同意/giu,
  /(?:最终|明确|想清楚).{0,16}(?:两个人|两人|不邀请朋友)/giu,
  /(?:这次)?就(?:订|定)(?:在|为)?/giu,
  /不再扩大人数/giu,
  /不需要等待|无需等待/giu,
  /\b(?:completed|confirmed|resolved|fulfilled|scheduled|paid|booked)\b/giu
];

const pendingStatePatterns = [
  /(?:还没|尚未|暂未|未能|未|没有).{0,16}(?:完成|做完|做到|确认|解决|履行|兑现|落实|实现|提交|付款|支付|预约|发送|收到|决定|查看|核实)/giu,
  /(?:等待|待)(?:确认|回复|答复|结果|安排)/giu,
  /之后再说/giu,
  /暂(?:时)?(?:不|未|缓)/giu,
  /(?:未定|待定|暂不确定|信息不全)/giu,
  /(?:还|尚)?不确定/giu,
  /(?:考虑|计划)中/giu,
  /(?:我会|将会|将在).{0,28}(?:提交|付款|支付|完成|做完|做到|确认|解决|履行|兑现|落实|实现|预约|发送|发(?:给)?|收到)/giu,
  /(?:承诺|答应|约定).{0,28}(?:提交|付款|支付|完成|做完|做到|确认|解决|履行|兑现|落实|实现|预约|发送|发(?:给)?|收到)/giu,
  /(?:提交|付款|支付|完成|做完|做到|确认|解决|履行|兑现|落实|实现|预约|发送|发(?:给)?|收到).{0,12}(?:承诺|计划|约定)/giu,
  /(?:承诺|答应|约定)|\b(?:promise|commitment)\b/giu,
  /\b(?:planned|considering|pending|maybe|unconfirmed|not confirmed)\b/giu
];

function lastMatchIndex(value: string, patterns: RegExp[]) {
  let lastIndex = -1;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      if (typeof match.index === "number") lastIndex = Math.max(lastIndex, match.index);
    }
  }
  return lastIndex;
}

function topicTokens(question: string) {
  return [...meaningfulTextTokens(question)]
    .filter((token) => !genericLifecycleTokens.has(token))
    .sort();
}

export function analyzeQaQueryIntent(question: string): QaQueryIntentAnalysis {
  const normalized = question.normalize("NFKC").trim();
  const completionConfirmation = completionConfirmationPatterns.some((pattern) => pattern.test(normalized));
  const asksForCompletionEvidence =
    completionConfirmation || completionEvidencePatterns.some((pattern) => pattern.test(normalized));
  const lifecycleResolution =
    completionConfirmation || lifecycleIntentPatterns.some((pattern) => pattern.test(normalized));
  const aggregateCommitmentCompletion =
    asksForCompletionEvidence &&
    /(?:答应|承诺|约定)/u.test(normalized) &&
    /(?:都|全部|所有|事情|事项)/u.test(normalized);
  return {
    intent: lifecycleResolution ? "lifecycle_resolution" : "general",
    preferLatestState: lifecycleResolution,
    asksForCompletionEvidence,
    aggregateCommitmentCompletion,
    topicTokens: lifecycleResolution ? topicTokens(normalized) : []
  };
}

function classifyLifecycleEvidenceState(evidenceText: string): QaLifecycleEvidenceState {
  const resolvedIndex = lastMatchIndex(evidenceText, resolvedStatePatterns);
  const pendingIndex = lastMatchIndex(evidenceText, pendingStatePatterns);
  if (resolvedIndex >= 0 && resolvedIndex >= pendingIndex) {
    return "resolved";
  }
  if (pendingIndex >= 0) {
    return "pending";
  }
  return "neutral";
}

export function assessQaLifecycleEvidence(
  intent: QaQueryIntentAnalysis,
  evidenceText: string
): QaLifecycleEvidenceAssessment {
  if (intent.intent !== "lifecycle_resolution") {
    return { topicOverlap: 0, state: "neutral" };
  }

  const queryTokens = new Set(intent.topicTokens);
  const evidenceTokens = meaningfulTextTokens(evidenceText);
  const classifiedState = classifyLifecycleEvidenceState(evidenceText);
  const lexicalTopicOverlap = sharedTokenCount(queryTokens, evidenceTokens);
  if (intent.aggregateCommitmentCompletion) {
    const hasCommitment = aggregateCommitmentPatterns.some((pattern) => pattern.test(evidenceText));
    const hasFulfillment = aggregateFulfillmentPatterns.some((pattern) => pattern.test(evidenceText));
    const aggregateState: QaLifecycleEvidenceState = hasFulfillment
      ? "resolved"
      : hasCommitment
        ? "pending"
        : "neutral";
    if (aggregateState !== "neutral") {
      return {
        topicOverlap: Math.max(2, lexicalTopicOverlap),
        state: aggregateState
      };
    }
  }

  return {
    topicOverlap: lexicalTopicOverlap,
    state: lexicalTopicOverlap > 0 ? classifiedState : "neutral"
  };
}

export function lifecycleCompletionLabel(question: string) {
  const action = question.match(/(?:发送|提交|付款|支付|预约|确认|解决|履行|兑现|落实|收到|安排)/u)?.[0];
  if (!action || action === "确认" || action === "解决" || action === "收到") {
    return "已经完成";
  }
  return `已经${action}完成`;
}
