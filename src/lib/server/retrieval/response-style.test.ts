import { describe, expect, it } from "vitest";
import {
  buildCompanionResponseStyleInstruction,
  classifyCompanionResponseIntent,
  containsAbsoluteRelationshipConclusion,
  normalizeCompanionResponseStyle
} from "./response-style";

describe("companion response style", () => {
  it("answers reminder questions without adding an unsolicited advice section", () => {
    const answer = [
      "直接回答：可以，这个例子更适合作为一个提醒。[E1]",
      "我留意到的模式：当时有情绪，但也出现了一次具体的照顾行为。[E2]",
      "可以怎么做：下次生气时你应该先停下来复盘。"
    ].join("\n\n");

    const normalized = normalizeCompanionResponseStyle({
      question: "这个例子以后是不是可以用来提醒自己？",
      answer
    });

    expect(classifyCompanionResponseIntent("这个例子以后是不是可以用来提醒自己？")).toBe("reflection");
    expect(normalized).toContain("可以，这个例子更适合作为一个提醒。[E1]");
    expect(normalized).toContain("当时有情绪，但也出现了一次具体的照顾行为。[E2]");
    expect(normalized).not.toContain("我留意到的模式");
    expect(normalized).not.toContain("可以怎么做");
    expect(normalized).toContain("如果你愿意，下次生气时可以考虑先停下来复盘。");
    expect(normalized).not.toContain("你应该");
    expect(normalized.match(/\[E\d+\]/g)).toEqual(["[E1]", "[E2]"]);
  });

  it("never deletes an out-of-band-cited fact or safety boundary", () => {
    const normalized = normalizeCompanionResponseStyle({
      question: "这个是不是说明他在乎我？",
      answer: "直接回答：这次有一个具体的照顾行为。\n\n你需要注意，这只是一次行为，不能代表所有情况。"
    });

    expect(normalized).toContain("这次有一个具体的照顾行为。");
    expect(normalized).toContain("你需要注意，这只是一次行为，不能代表所有情况。");
  });

  it("does not turn a cited factual obligation into optional advice", () => {
    const normalized = normalizeCompanionResponseStyle({
      question: "我当时需要做什么？",
      answer: "直接回答：你需要周二前把提纲发给对方。[E1]"
    });

    expect(classifyCompanionResponseIntent("我当时需要做什么？")).toBe("fact");
    expect(normalized).toBe("你需要周二前把提纲发给对方。[E1]");
  });

  it("normalizes legacy headings separated by single line breaks", () => {
    const normalized = normalizeCompanionResponseStyle({
      question: "这个例子以后是不是可以用来提醒自己？",
      answer: "直接回答：可以。[E1]\n我留意到的模式：这是一次具体行为。[E1]\n可以怎么做：你应该先记下它。"
    });

    expect(normalized).not.toContain("直接回答：");
    expect(normalized).not.toContain("我留意到的模式：");
    expect(normalized).not.toContain("可以怎么做：");
    expect(normalized).toContain("如果你愿意，可以考虑先记下它。");
    expect(normalized.match(/\[E\d+\]/g)).toEqual(["[E1]", "[E1]"]);
  });

  it("keeps evidence and uncertainty in reflection answers", () => {
    const normalized = normalizeCompanionResponseStyle({
      question: "我后来调整了吗？",
      answer: "直接回答：目前记录更支持你已经意识到这个问题。[E1]\n\n这还不足以说明已经长期改变。[E2]"
    });

    expect(classifyCompanionResponseIntent("我后来调整了吗？")).toBe("reflection");
    expect(normalized).toContain("已经意识到这个问题。[E1]");
    expect(normalized).toContain("还不足以说明已经长期改变。[E2]");
    expect(normalized.match(/\[E\d+\]/g)).toEqual(["[E1]", "[E2]"]);
  });

  it("allows requested advice but softens directive wording", () => {
    const normalized = normalizeCompanionResponseStyle({
      question: "我应该怎么办？",
      answer: "可以怎么做：你应该先把具体感受说清楚。[E1]"
    });

    expect(classifyCompanionResponseIntent("我应该怎么办？")).toBe("advice");
    expect(normalized).toContain("可以考虑先把具体感受说清楚。[E1]");
    expect(normalized).not.toContain("你应该");
    expect(normalized).not.toContain("可以怎么做：");
  });

  it("classifies direct fact and relationship-understanding questions", () => {
    expect(classifyCompanionResponseIntent("我们什么时候约好的？")).toBe("fact");
    expect(classifyCompanionResponseIntent("她喜欢吃什么？")).toBe("fact");
    expect(classifyCompanionResponseIntent("这个是不是说明他在乎我？")).toBe("relationship_understanding");
  });

  it("rejects absolute relationship verdicts without rewriting their meaning", () => {
    expect(containsAbsoluteRelationshipConclusion("他一定爱你，你们一定很好。[E1]")).toBe(true);
    expect(containsAbsoluteRelationshipConclusion("你们一定很好。[E1]")).toBe(true);
    expect(containsAbsoluteRelationshipConclusion("这次具体的照顾行为，可能体现了当时的在意。[E1]")).toBe(false);
    expect(containsAbsoluteRelationshipConclusion("这一次还不能说明他一定爱你，也不能证明你们关系一定很好。[E1]")).toBe(false);
  });

  it("builds intent-specific instructions without changing evidence requirements", () => {
    const relationshipInstruction = buildCompanionResponseStyleInstruction({
      question: "这个是不是说明他在乎我？"
    });
    const adviceInstruction = buildCompanionResponseStyleInstruction({ question: "我应该怎么办？" });

    expect(relationshipInstruction).toContain("关系理解");
    expect(relationshipInstruction).toContain("一次具体行为");
    expect(relationshipInstruction).toContain("保留所有 [E#] 引用");
    expect(adviceInstruction).toContain("明确请求了建议");
    expect(adviceInstruction).toContain("柔和");
  });
});
