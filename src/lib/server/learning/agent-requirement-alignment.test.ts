import { describe, expect, it } from "vitest";
import { inspectLearningRequirementAlignment } from "./agent-requirement-alignment";

// Unchanged public W2 first-quiz text from the 24eead0 Windows evidence.
// This local contract test is not the separate full attachment/SQLite replay.
const counting = { role: "application", description: "能用 |A∪B|=|A|+|B|-|A∩B| 计算并集元素个数。" };
const membership = { role: "application", description: "能对给定集合和元素判断其属于交集、并集或两者。" };
const q0 = { stem: "设 A={1,2,3}，B={3,4}，元素 3 属于下列哪一项？", options: [
  { id: "D", text: "既不属于 A∩B，也不属于 A∪B" },
  { id: "A", text: "既属于 A∩B，也属于 A∪B" },
  { id: "B", text: "只属于 A∩B，不属于 A∪B" },
  { id: "C", text: "只属于 A∪B，不属于 A∩B" },
] };
const q1 = { stem: "设 A={1,2,3}，B={3,4}，则 |A∪B| 等于多少？", options: [
  { id: "A", text: "4" }, { id: "C", text: "3" }, { id: "D", text: "1" }, { id: "B", text: "5" },
] };
const q2 = { stem: "设 A={1,2,3}，B={3,4}，元素 1 在并集计算中应如何处理？", options: [
  { id: "A", text: "计入 A∪B，但不计入 A∩B" },
  { id: "B", text: "计入 A∩B，但不计入 A∪B" },
  { id: "C", text: "既计入 A∩B，也计入 A∪B" },
  { id: "D", text: "既不计入 A∩B，也不计入 A∪B" },
] };

describe("bounded answer-demand and Learning requirement alignment", () => {
  it.each(["用自己的话解释并集为什么减去交集", "能独立口述两个概念的区别", "以自己的语言说明理由"])("does not turn a supplied multiple-choice answer into %s", description => {
    expect(inspectLearningRequirementAlignment(q1, { role: "concept", description })).toMatchObject({
      status: "incompatible", code: "choice_not_self_expression"
    });
  });
  it.each(["能说明并集计数为什么需要减去交集", "选择解释并集去重的正确说法", "不要求用自己的话解释，只需选择正确理由"])("does not reject recognition evidence for %s", description => {
    expect(inspectLearningRequirementAlignment(q1, { role: "concept", description })).toEqual({ status: "unverified" });
  });
  it.each([
    "无需计算数值，用自己的话解释为什么并集要减去交集",
    "不必列举元素；需独立口述为什么共同元素不能重复计算",
    "无需用自己的话解释公式，但需独立书写使用它的理由",
  ])("does not let an unrelated or earlier negation waive self-expression: %s", description => {
    expect(inspectLearningRequirementAlignment(q1, { role: "concept", description })).toMatchObject({
      status: "incompatible", code: "choice_not_self_expression"
    });
  });
  it.each([
    "无需用自己的话解释为什么并集要减去交集，只需选择正确理由",
    "不必独立口述为什么共同元素不能重复计算；选择对应理由即可",
    "不要求学生另行独立书写，选择解释即可",
    "不需要用自己的话解释，只需选择一个给定的理由",
  ])("keeps a directly negated self-expression demand eligible for semantic review: %s", description => {
    expect(inspectLearningRequirementAlignment(q1, { role: "concept", description })).toEqual({ status: "unverified" });
  });
  it("rejects original W2 index2 membership choices as cardinality application despite stem saying 计算", () => {
    expect(inspectLearningRequirementAlignment(q2, counting)).toMatchObject({ status: "incompatible", code: "membership_not_cardinality" });
  });
  it("leaves original index0 membership application a semantic proposal, without falsely verifying it", () => {
    expect(inspectLearningRequirementAlignment(q0, membership)).toEqual({ status: "unverified" });
  });
  it("leaves original index1 numeric calculation provisionally usable, not a proof of formula reasoning", () => {
    expect(inspectLearningRequirementAlignment(q1, counting)).toEqual({ status: "unverified" });
  });
  it("also refuses index0 as counting evidence without changing its legitimate membership use", () => {
    expect(inspectLearningRequirementAlignment(q0, counting).status).toBe("incompatible");
    expect(inspectLearningRequirementAlignment(q2, membership).status).toBe("unverified");
  });
  it("does not use option labels, ordering, chosen answer or generated rationale to infer alignment", () => {
    expect(inspectLearningRequirementAlignment({ ...q2, options: [...q2.options].reverse() }, counting).status).toBe("incompatible");
  });
  it("does not turn known mismatch into a score or mutate the saved question", () => {
    const frozen = Object.freeze({ ...q2, options: Object.freeze(q2.options.map(o => Object.freeze({ ...o }))) });
    const before = JSON.stringify(frozen);
    inspectLearningRequirementAlignment(frozen, counting);
    expect(JSON.stringify(frozen)).toBe(before);
  });
  it.each([
    { role: "concept", description: "能说明并集中共同元素只写一次。" },
    { role: "boundary", description: "能避免把交集数量当作并集数量，理解减去重复计数的原因。" },
    { role: "application", description: "不要求计算并集元素个数，只判断一个元素属于哪里。" },
    { role: "application", description: "能计算速度变化量。" },
  ])("does not claim a check for other requirement forms: $description", requirement => {
    expect(inspectLearningRequirementAlignment(q2, requirement)).toEqual({ status: "unverified" });
  });
  it("does not match a membership phrase inside a longer duplicate-counting explanation", () => {
    const mixed = { ...q2, options: q2.options.map(o => ({ ...o, text: `${o.text}；共同元素只计一次，所以总数为4。` })) };
    expect(inspectLearningRequirementAlignment(mixed, counting)).toEqual({ status: "unverified" });
  });
  it("does not claim checks for malformed choices or unsupported mathematical notation", () => {
    expect(inspectLearningRequirementAlignment({ ...q2, options: [q2.options[0]] }, counting)).toEqual({ status: "unverified" });
    expect(inspectLearningRequirementAlignment({ ...q2, options: [q2.options[0], q2.options[0]] }, counting)).toEqual({ status: "unverified" });
    expect(inspectLearningRequirementAlignment({ ...q2, options: q2.options.map(o => ({ ...o, text: `若满足某个条件，则${o.text}` })) }, counting)).toEqual({ status: "unverified" });
  });
});
