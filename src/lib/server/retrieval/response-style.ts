export type CompanionResponseIntent = "fact" | "relationship_understanding" | "reflection" | "advice";

export type CompanionConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

type CompanionResponseStyleInput = {
  question: string;
  conversation?: CompanionConversationMessage[];
};

const explicitAdvicePattern =
  /怎么办|(?:我|我们)?(?:该|应该|要)怎么(?:做|处理|回应|沟通|调整)|如何(?:处理|回应|沟通|改善|调整|解决)|(?:给|提供).{0,4}建议|有什么(?:具体)?建议|建议(?:一下|我)|下一步(?:该|要|可以)?怎么/u;
const reflectionPattern =
  /后来|之后|复盘|提醒自己|(?:有没有|是否|是不是).{0,8}(?:调整|改变|改进|做到|兑现|完成|提醒)|(?:调整|改变|改进|做到|兑现|完成)了吗/u;
const relationshipUnderstandingPattern =
  /(?:他|她|对方|伴侣|我们|关系).{0,12}(?:在乎|态度|心意|相处|关系|说明|意味着|怎么看|如何理解)|(?:在乎|爱|喜欢).{0,8}(?:我|你)|(?:说明|代表).{0,8}(?:他|她|对方).{0,8}(?:在乎|爱|喜欢)/u;
const shortFollowUpPattern = /^(?:那这个呢|这个呢|为什么|是吗|真的吗|可以吗|然后呢)[？?。！!\s]*$/u;

const reportHeadingPattern =
  /^(\s*(?:[-*]\s*)?)(?:直接回答|我留意到的模式|我留意到|当天讨论里|这说明)\s*[：:]\s*/u;
const adviceHeadingPattern = /^(\s*(?:[-*]\s*)?)(?:可以怎么做|下一步建议)\s*[：:]\s*/u;
const directiveLeadPattern = /^(?:建议你|你应该|你需要)(?:\s*[：:]\s*|\s*)/u;
const absoluteRelationshipConclusionPatterns = [
  /(?:他|她|对方|伴侣).{0,8}(?:一定|肯定|必然|显然|其实).{0,12}(?:爱|在乎|喜欢)(?:你|我)?/u,
  /你们(?:的)?关系(?:一定|肯定|必然|显然|其实|确实)?(?:会)?(?:很|非常)好/u,
  /你们(?:一定|肯定|必然|显然|其实|确实)(?:会)?(?:很|非常)?好/u,
  /你们.{0,8}(?:一定|肯定|必然).{0,8}(?:幸福|合适|没问题|会一直)/u
];
const negatedConclusionBoundaryPattern =
  /不能(?:据此)?(?:说明|证明|代表|判断)?|无法(?:说明|证明|判断)?|不足以(?:说明|证明|判断)?|不代表/u;

function latestUserContext(input: CompanionResponseStyleInput) {
  const question = input.question.trim();
  if (!shortFollowUpPattern.test(question)) {
    return question;
  }

  const previousUserMessage = [...(input.conversation ?? [])]
    .reverse()
    .find((message) => message.role === "user" && message.content.trim().length > 0);

  return previousUserMessage ? `${previousUserMessage.content}\n${question}` : question;
}

export function classifyCompanionResponseIntent(
  question: string,
  conversation?: CompanionConversationMessage[]
): CompanionResponseIntent {
  const context = latestUserContext({ question, conversation });

  if (explicitAdvicePattern.test(context)) {
    return "advice";
  }
  if (relationshipUnderstandingPattern.test(context)) {
    return "relationship_understanding";
  }
  if (reflectionPattern.test(context)) {
    return "reflection";
  }
  return "fact";
}

export function buildCompanionResponseStyleInstruction(input: CompanionResponseStyleInput) {
  const intent = classifyCompanionResponseIntent(input.question, input.conversation);
  const intentInstruction: Record<CompanionResponseIntent, string> = {
    fact: "这是事实查询：用一两句话直接给出时间、人物、约定或结果；除非回答事实所需，不展开关系分析。",
    relationship_understanding:
      "这是关系理解问题：先回应用户的判断，再描述证据中的一次具体行为；保留不确定性，并说明一次具体行为不代表所有情况。",
    reflection:
      "这是复盘问题：区分记录已经支持的变化与仍属推断的部分；没有跨时证据时，不声称改变已经长期完成。",
    advice: "用户明确请求了建议：可以提供一到两个具体选项，使用“可以考虑”或“如果你愿意”等柔和表达，不命令用户。"
  };

  return [
    `回答意图：${intent === "relationship_understanding" ? "关系理解" : intent === "reflection" ? "复盘" : intent === "advice" ? "主动建议" : "事实查询"}。`,
    intentInstruction[intent],
    intent === "advice" ? "建议应放在直接回答之后。" : "用户没有明确请求建议：不要主动提供下一步、行动指导或“你应该”。",
    "不要使用“我留意到的模式”“当天讨论里”“这说明”“可以怎么做”等固定报告标题。",
    "保持事实和证据边界，保留所有 [E#] 引用；不要改写、删除或新增 citation。"
  ].join("\n");
}

export function containsAbsoluteRelationshipConclusion(answer: string) {
  return answer.split(/[。！？!?\n]|(?:但|不过|可是|然而)/u).some((clause) =>
    absoluteRelationshipConclusionPatterns.some((pattern) => {
      const match = clause.match(pattern);
      if (!match || match.index === undefined) {
        return false;
      }

      const leadingContext = clause.slice(Math.max(0, match.index - 20), match.index);
      return !negatedConclusionBoundaryPattern.test(leadingContext) && !/不一定|未必|并不/u.test(match[0]);
    })
  );
}

function citationTokens(answer: string) {
  return answer.match(/\[E\d+\]/gu) ?? [];
}

function hasSameCitationSequence(before: string, after: string) {
  const beforeTokens = citationTokens(before);
  const afterTokens = citationTokens(after);
  return beforeTokens.length === afterTokens.length && beforeTokens.every((token, index) => token === afterTokens[index]);
}

function softenDirective(text: string, intent: CompanionResponseIntent) {
  const prefix = intent === "advice" ? "可以考虑" : "如果你愿意，可以考虑";
  const parts = text.match(/^(\s*(?:[-*]\s*)?)(.*)$/u);
  const linePrefix = parts?.[1] ?? "";
  const content = parts?.[2] ?? text;
  const softened = content
    .replace(/^建议你/u, prefix)
    .replace(/^你应该/u, prefix)
    .replace(/^你需要/u, intent === "advice" ? "可以先" : "如果你愿意，可以先");
  return `${linePrefix}${softened}`;
}

function softenUnrequestedSuggestion(text: string) {
  const parts = text.match(/^(\s*(?:[-*]\s*)?)(.*)$/u);
  const linePrefix = parts?.[1] ?? "";
  const content = parts?.[2] ?? text;
  const softened = content
    .replace(/建议你/u, "可以考虑")
    .replace(/你应该/u, "可以考虑")
    .replace(/你需要/u, "可以先");
  const optional = /^(?:如果|也许|或许|不妨)/u.test(softened) ? softened : `如果你愿意，${softened}`;
  return `${linePrefix}${optional}`;
}

export function normalizeCompanionResponseStyle(input: CompanionResponseStyleInput & { answer: string }) {
  const original = input.answer.trim();
  if (!original) {
    return original;
  }

  const intent = classifyCompanionResponseIntent(input.question, input.conversation);
  const normalized = original
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => {
      const withoutReportHeading = line.replace(reportHeadingPattern, "$1");
      const hasAdviceHeading = adviceHeadingPattern.test(withoutReportHeading);
      const withoutAdviceHeading = withoutReportHeading.replace(adviceHeadingPattern, "$1");
      if (hasAdviceHeading && intent !== "advice") {
        return softenUnrequestedSuggestion(withoutAdviceHeading);
      }
      return intent === "advice" ? softenDirective(withoutAdviceHeading, intent) : withoutAdviceHeading;
    })
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

  if (!normalized || !hasSameCitationSequence(original, normalized)) {
    return original;
  }

  return normalized;
}
