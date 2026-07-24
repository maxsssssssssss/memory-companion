import type { RelationshipLifecycleRelationType, RelationshipLifecycleRole, RelationshipLifecycleSignal } from "./types";

const QUESTION_PATTERN = /(?:询问|追问|问题是|仍需|还需|尚未|待).{0,24}(?:是否|能否|有没有|确认|答复|结果)|^[^。！？!?]{1,80}[?？]$/u;
const CONCRETE_RESULT_PATTERN = /(?:已经|已)(?:完成|确认|解决|办好|提交|预约|付款|落实|查到|收到)|(?:结果|实际)(?:是|为|显示|确认)|(?:查到|收到|办好|完成|解决)(?:了|结果|确认)|确认(?:成功|完成|有|无|为|是)|(?:成功|失败)(?:完成|预约|报名|提交)|没有(?:空位|名额)/u;
const FUTURE_ACTION_PATTERN = /计划|准备|承诺|答应|约定|将会|将于|会在|之后会|稍后|明天|后天|下周|周[一二三四五六日天]|星期[一二三四五六日天]/u;
const EXPLICIT_COMMITMENT_PATTERN = /承诺|答应|保证|约定|说好|会在|将会|负责|按约/u;
const PLAN_PATTERN = /计划|安排|准备|打算|尚未|还没|待确认|需要确认/u;
const COMPLETION_PATTERN = /(?:已经|已|按约|如期).{0,18}(?:完成|确认|解决|办好|提交|预约|付款|落实|结束)|(?:完成|办好|落实|解决|确认)(?:了|成功|完毕)/u;
const FULFILLMENT_PATTERN = /按约|如期|兑现|履行|照约定|已经完成|已完成|完成了/u;
const CONCERN_PATTERN = /担心|担忧|顾虑|不安|不舒服|困扰|介意|焦虑|失望|没有提前|临时改变|突然改变|模糊|回避|影响.{0,8}(?:安排|感受|信任)/u;
const RESOLUTION_PATTERN = /达成|形成|解决|修复|说清|澄清|一致|规则|边界|以后|下次|提前|替代安排|双方确认|可以接受/u;
const UPDATE_PATTERN = /更新|进度|改为|调整|延期|提前|推迟|变更|重新安排|还在|正在|尚未/u;

function summaryText(signal: RelationshipLifecycleSignal) {
  return [signal.summary, signal.metadata?.status ?? ""].join(" ").normalize("NFKC");
}

function combinedText(signal: RelationshipLifecycleSignal) {
  return [
    signal.summary,
    ...signal.evidenceText,
    signal.metadata?.status ?? ""
  ].join(" ").normalize("NFKC");
}

export function lifecycleRoles(signal: RelationshipLifecycleSignal) {
  const summary = summaryText(signal);
  const text = combinedText(signal);
  const roles = new Set<RelationshipLifecycleRole>();
  const concreteResult = CONCRETE_RESULT_PATTERN.test(text) &&
    !/(?:尚未|还没|未|没有)(?:完成|确认|解决|办好|提交|预约|付款|落实|打开|查看|查询|得到|获得|收到结果)/u.test(text);
  const completed = COMPLETION_PATTERN.test(text);
  const futureAction = FUTURE_ACTION_PATTERN.test(summary);
  const explicitCommitment = EXPLICIT_COMMITMENT_PATTERN.test(summary);
  const planLike = PLAN_PATTERN.test(summary);

  if (
    signal.signalType === "evasive_answer" ||
    (QUESTION_PATTERN.test(summary) && !(signal.signalType === "clear_commitment" && planLike))
  ) roles.add("question");
  if (signal.signalType === "clear_commitment" && planLike && !explicitCommitment) roles.add("plan");
  if (signal.signalType === "clear_commitment" && (explicitCommitment || (futureAction && !planLike)) && !completed) roles.add("commitment");
  const explicitConcern = CONCERN_PATTERN.test(summary) && !/(?:不是|并非|并不|没有|不再)(?:真的)?(?:担心|担忧|顾虑|不安|不舒服|困扰|介意|焦虑|失望)/u.test(summary);
  if (
    signal.signalCategory === "risk" ||
    signal.signalCategory === "uncertain" ||
    signal.signalType === "evasive_answer" ||
    signal.signalType === "invalidating_or_belittling" ||
    explicitConcern
  ) roles.add("concern");

  if (concreteResult) roles.add("answer");
  if (completed) roles.add("completion");
  if (completed && FULFILLMENT_PATTERN.test(text)) roles.add("fulfillment");
  if (
    (signal.signalType === "boundary_respect" || signal.signalType === "clear_commitment") &&
    RESOLUTION_PATTERN.test(text)
  ) roles.add("resolution");
  if (UPDATE_PATTERN.test(text) && !completed) roles.add("update");

  return roles;
}

export type LifecycleRuleMatch = {
  relationType: RelationshipLifecycleRelationType;
  sourceRole: RelationshipLifecycleRole;
  targetRole: RelationshipLifecycleRole;
  priority: number;
};

export function compatibleLifecycleRule(
  sourceRoles: ReadonlySet<RelationshipLifecycleRole>,
  targetRoles: ReadonlySet<RelationshipLifecycleRole>
): LifecycleRuleMatch | null {
  const matches: LifecycleRuleMatch[] = [];
  if (sourceRoles.has("question") && targetRoles.has("answer")) {
    matches.push({ relationType: "answered_by", sourceRole: "question", targetRole: "answer", priority: 4 });
  }
  if (sourceRoles.has("commitment") && targetRoles.has("fulfillment")) {
    matches.push({ relationType: "fulfilled_by", sourceRole: "commitment", targetRole: "fulfillment", priority: 3.5 });
  }
  if (sourceRoles.has("concern") && targetRoles.has("resolution")) {
    matches.push({ relationType: "resolved_by", sourceRole: "concern", targetRole: "resolution", priority: 3 });
  }
  if (sourceRoles.has("plan") && targetRoles.has("completion")) {
    matches.push({ relationType: "resolved_by", sourceRole: "plan", targetRole: "completion", priority: 2.5 });
  }
  if (
    (sourceRoles.has("question") || sourceRoles.has("plan") || sourceRoles.has("commitment") || sourceRoles.has("concern")) &&
    targetRoles.has("update")
  ) {
    matches.push({
      relationType: "updated_by",
      sourceRole: sourceRoles.has("question") ? "question" : sourceRoles.has("plan") ? "plan" : sourceRoles.has("commitment") ? "commitment" : "concern",
      targetRole: "update",
      priority: 1
    });
  }
  return matches.sort((left, right) => right.priority - left.priority || left.relationType.localeCompare(right.relationType))[0] ?? null;
}
