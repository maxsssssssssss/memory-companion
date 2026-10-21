// @vitest-environment node
// Synthetic, meaning-preserving variations. Exact Windows candidates have their
// own immutable evidence replay; these examples do not replace those inputs.
import { describe, expect, it } from "vitest";
import { bindQuizOptionExplanation, hasQuizPositionDependency } from "./quiz-grounding";

const options = [{ id: "A", text: "{6}" }, { id: "B", text: "∅" }, { id: "C", text: "{2,4,6,8}" }];
const variants = [
  { names: ["A", "B"], context: "已知集合 A={2,4,6}，B={6,8}。交集是什么？", space: "" },
  { names: ["E", "F"], context: "已知集合 E = { 6 , 4 , 2 }，F = { 8 , 6 }。交集是什么？", space: " " },
  { names: ["X", "Y"], context: "已知集合 X={2,6,4,6}，Y={6,8,8}。交集是什么？", space: "  " },
  { names: ["C", "D"], context: "已知集合 C={4,2,6}，D={8,6}。交集是什么？", space: "\n" },
];

describe.each(variants)("question-local entities $names", ({ names: [left, right], context, space }) => {
  const pair = `${left}${space}和${space}${right}`;
  it("keeps names as mathematical entities through naming, whitespace and literal-order variations", () => {
    for (const text of [`${pair}都包含6。`, `归入${pair}的条件必须同时满足。`, `${pair}没有共同元素时交集为空。`, `${pair}包含的共同元素是6。`]) {
      expect(hasQuizPositionDependency(text, context), text).toBe(false);
      expect(bindQuizOptionExplanation(text, options, "A", context), text).toBe(text);
    }
  });
  it("checks every occurrence; mathematical context does not exempt an option or ordinal verdict", () => {
    for (const suffix of ["选项 A/B 都正确。", "选项 A 和 B 都正确。", "正确答案只能从 A 和 B 中选择。", "正确答案是第3项。", "第二项正确。", "由第2题可知。", "以上皆是。", "正确项 B。", "错误项 A。", "A项与B项都正确。", "A和B都不正确。", "A和B不是正确的。", "A和B都不准确。", "A和B均不符合。", "A和B并非正确。", "A 和 B 两项都正确。", "A和B两个选项正确。"] ) {
      const text = `${pair}都包含6。${suffix}`;
      expect(bindQuizOptionExplanation(text, options, "A", context), text).toBeNull();
    }
  });
});

it("does not import another question's declaration or infer unidentified bare combinations", () => {
  const context = "已知集合 A={1,2}，B={2,3}。";
  for (const text of ["X 和 Y 都包含6。", "归入X和Y的条件必须同时满足。", "E和F没有共同元素。", "E和F"]) {
    expect(hasQuizPositionDependency(text, context), text).toBe(true);
  }
});

it("does not treat explicit display-option definitions as mathematical declarations", () => {
  const context = "选项 A={1,2}，选项 B={2,3}。";
  expect(hasQuizPositionDependency("A和B没有共同元素。", context)).toBe(true);
});

it("retains an explicitly typed mathematical quotation without declaring its names globally", () => {
  const context = "集合 X={2,4,6}，Y={6,8}。";
  expect(hasQuizPositionDependency("按定义，交集是同时属于 A 和 B 的元素。X 和 Y 都包含6。", context)).toBe(false);
  expect(hasQuizPositionDependency("按定义，交集是同时属于 A 和 B 的元素。正确答案在 A 和 B 中。", context)).toBe(true);
});
