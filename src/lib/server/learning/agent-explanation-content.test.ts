import { describe, expect, it } from "vitest";
import { inspectLearningExplanationContent } from "./agent-explanation-content";

// Unchanged public saved explanation and original paragraphs in the Windows
// 24eead0 evidence, semantic-review-w1.json. This is an offline content replay;
// it does not recreate the missing raw Provider response envelope.
const sources = [
  { materialId: "4af98966-ff6b-4058-b67c-e27f8778e76b", paragraph: 3, text: "交集 A∩B 包含同时属于 A 和 B 的元素。判断一个元素是否在交集中，需要两个归属条件同时成立。若 A={1,2,3}，B={3,4}，则 A∩B={3}。没有共同元素时交集为空集。" },
  { materialId: "4af98966-ff6b-4058-b67c-e27f8778e76b", paragraph: 4, text: "并集 A∪B 包含属于 A 或属于 B 的元素，这里的或允许同时属于二者。一个元素只出现一次。若 A={1,2,3}，B={3,4}，则 A∪B={1,2,3,4}。把元素 3 写两次不构成两个不同元素。" },
];
const original = "材料第3段说明交集 A∩B 使用“同时”条件，要求元素同时属于 A 和 B；第4段说明并集 A∪B 使用“或”，并明确这个“或允许同时属于二者”。因此交集对应的是“且”的严格同时归属，而并集中的“或”是包含式“或”：只要元素属于 A、属于 B 或同时属于二者，都满足条件。材料以 A={1,2,3}，B={3,4} 为例：交集为 {3}，并集为 {1,2,3,4}。元素 3 同时属于两个集合，所以不满足交集的双条件，但满足并集的“或”条件，且只出现一次。";
const setup = "A={1,2,3}，B={3,4}，A∩B={3}。";
const inspect = (text: string) => inspectLearningExplanationContent(text, sources);

describe("bounded explanation content issues", () => {
  it("retains and identifies the exact Windows W1 contradiction without rewriting it", () => {
    const before = JSON.stringify(sources), result = inspect(original);
    expect(result.status).toBe("known_issue");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe("literal_intersection_contradiction");
    expect(original.slice(result.issues[0].start, result.issues[0].end)).toBe("元素 3 同时属于两个集合，所以不满足交集的双条件");
    expect(original).toContain("交集为 {3}，并集为 {1,2,3,4}");
    expect(JSON.stringify(sources)).toBe(before);
    expect(JSON.stringify(result)).not.toContain(original);
  });

  it.each([
    "元素3同时属于A和B，因此不属于交集。",
    "元素 3 同时属于 B 与 A，故不满足交集条件。",
    "元素+03同时属于这两个集合，所以该元素不满足交集的双条件。",
  ])("detects the same narrow affirmative contradiction: %s", sentence => {
    expect(inspect(setup + sentence).status).toBe("known_issue");
  });

  it.each([
    "元素3同时属于两个集合，所以满足交集的双条件。",
    "元素1不同时属于两个集合，所以不满足交集的双条件。",
    "元素1只属于A，所以不属于交集。",
    "元素3同时属于两个集合，因此既属于交集也属于并集。",
    "元素3同时属于两个集合，所以不满足只属于一个集合的条件。",
    "不能说元素3同时属于两个集合，所以不满足交集的双条件。",
    "“元素3同时属于两个集合，所以不满足交集的双条件”是错误的。",
    "误以为元素3同时属于两个集合，所以不满足交集的双条件，这是应纠正的错误。",
    "假如元素3同时属于两个集合，所以不满足交集的双条件，这个说法成立吗？",
    "元素3同时属于两个集合，所以不满足交集的双条件？",
    "元素3同时属于两个集合，所以不满足交集的双条件，是错误的。",
  ])("does not mark a correct explanation or quoted misconception as this issue: %s", sentence => {
    expect(inspect(setup + sentence)).toEqual({ status: "no_known_issue", issues: [] });
  });

  it("keeps case-sensitive symbolic elements within the existing finite-set parser", () => {
    const text = "A={a,b}，B={a,c}，A∩B={a}。元素a同时属于两个集合，所以不满足交集的双条件。";
    const refs = [{ ...sources[0], text: "若 A={a,b}，B={a,c}，则 A∩B={a}。" }];
    expect(inspectLearningExplanationContent(text, refs).status).toBe("known_issue");
    expect(inspectLearningExplanationContent(text.replace("元素a", "元素A"), refs).status).toBe("no_known_issue");
  });

  it.each([
    "A={1,2,3}，B={3,4}，C={3,5}，A∩B={3}。元素3同时属于两个集合，所以不满足交集的双条件。",
    "A={1,2,3}，B={3,4}，A∩C={3}。元素3同时属于两个集合，所以不满足交集的双条件。",
    "A={1,2,3}，B={3,4}，A∩B={3}。元素3同时属于C和D，所以不满足交集的双条件。",
    "A={1,2,3}，B={3,4}，A∩B={3}。A={1}。元素3同时属于两个集合，所以不满足交集的双条件。",
    "A={x|x>0}，B={3,4}，A∩B={3}。元素3同时属于两个集合，所以不满足交集的双条件。",
    "元素3同时属于两个集合，所以不满足交集的双条件。",
  ])("leaves unsupported or ambiguous context undecided: %s", text => {
    expect(inspect(text).status).toBe("no_known_issue");
  });

  it("does not treat authorized source identity alone as content proof", () => {
    const unrelated = sources.map(source => ({ ...source, text: "集合包含元素；授权和段落编号本身不是语义证据。" }));
    expect(inspectLearningExplanationContent(original, unrelated)).toEqual({ status: "no_known_issue", issues: [] });
    expect(inspectLearningExplanationContent(original, [{ ...sources[0], text: "A={1}，B={3,4}。" }]).status).toBe("no_known_issue");
    expect(inspectLearningExplanationContent(original, []).status).toBe("no_known_issue");
  });

  it("does not label undetected content verified", () => {
    const result = inspect(setup + "A∪B={999}。");
    expect(result).toEqual({ status: "no_known_issue", issues: [] });
    expect(result).not.toHaveProperty("verified");
    expect(inspectLearningExplanationContent(null, sources).status).toBe("no_known_issue");
  });
});
