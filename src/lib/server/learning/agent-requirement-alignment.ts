/** A narrow negative check on what a saved question actually asks the learner
 * to choose. It never proves an objective or source semantically supported and
 * does not evaluate mathematics, correctness, or a learner's reasoning. */
type RequirementAlignment =
  | { status: "unverified" }
  | { status: "incompatible"; code: "membership_not_cardinality"; reason: string };

type Question = { stem: string; options: ReadonlyArray<{ id: string; text: string }> };
type Requirement = { role: string; description: string };

const compact = (text: string) => text.normalize("NFKC").replace(/\s+/gu, "");
const setExpression = String.raw`(?:[A-Za-z][∩∪][A-Za-z]|交集|并集)`;
const member = String.raw`(?:元素)?(?:[+-]?\d+|[A-Za-z])?`;
const predicate = String.raw`(?:既|也|只|同时)?(?:不)?(?:属于|计入)${setExpression}`;
// Match complete choices, not incidental words in a longer answer. In
// particular, a numeric/formula answer or an explanation of duplicate counting
// must not be mistaken for a pure membership choice.
const membershipChoice = new RegExp(String.raw`^${member}${predicate}(?:(?:[,，;；]|(?:和|与))(?:但|也|而|又|且)?${member}${predicate})*[。.]?$`, "u");

export function inspectLearningRequirementAlignment(question: Question, requirement: Requirement): RequirementAlignment {
  const unverified = { status: "unverified" } as const;
  const description = compact(requirement.description);
  // Only an explicit application calculation requirement is recognized. Other
  // subject areas, conceptual explanations and mixed demands remain semantic
  // proposals; absence of this mismatch is not a positive verification.
  if (requirement.role !== "application" || /不(?:必|用|需|要求)|无需|无须/u.test(description)) return unverified;
  if (!/(?:计算|求出|求得|算出)/u.test(description)
    || !/(?:交集|并集|集合|[∩∪])/u.test(description)
    || !/(?:元素(?:个数|数量)|基数|\|[^|]+\|)/u.test(description)) return unverified;
  if (question.options.length < 2
    || new Set(question.options.map(option => option.id)).size !== question.options.length
    || !question.options.every(option => membershipChoice.test(compact(option.text)))) return unverified;
  return { status: "incompatible", code: "membership_not_cardinality",
    reason: "本题全部选项只要求区分元素是否属于交集或并集，没有要求计算集合元素个数，不能支持当前的基数计算要求。请核对实际题目与检查要求的关联；这不是学生错答。" };
}
