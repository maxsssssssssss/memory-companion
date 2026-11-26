import { describe, expect, it } from "vitest";

import { presentBookHomeMaterial, type BookHomeMaterial } from "./book-home-material";

function material(values: Partial<BookHomeMaterial> & Pick<BookHomeMaterial, "kind" | "text">): BookHomeMaterial {
  return { evidenceIds: ["evidence-1"], sources: [], ...values } as BookHomeMaterial;
}

describe("presentBookHomeMaterial", () => {
  it.each([
    ["open_promise", "你答应过：下周把文件交给小林。", "下周把文件交给小林。"],
    ["follow_up", "可以问问 Ta：考试是否延期还没确定？", "考试是否延期还没确定？"],
    ["recent_update", "Ta 的近况：阿岚这周还没确定是否参加排练。", "阿岚这周还没确定是否参加排练。"],
    ["preference", "Ta 的偏好: 不太喜欢临时更改计划。", "不太喜欢临时更改计划。"],
    ["shared_moment", "一起经历的事：11月共同做了一次小幅试印，把照片贴满一张纸。", "11月共同做了一次小幅试印，把照片贴满一张纸。"],
    ["shared_moment", "你们一起经历的：在旧车站等到雨停。", "在旧车站等到雨停。"]
  ] as const)("removes only a duplicated %s label followed by a colon", (kind, text, expected) => {
    expect(presentBookHomeMaterial(material({ kind, text }))).toMatchObject({ text: expected });
  });

  it("does not shorten subjects, turn advice into questions, or change names", () => {
    for (const text of [
      "聊聊蓝色小画册的进展。",
      "聊聊河岸的手绘图。",
      "可以问问考试准备得怎么样了。",
      "小周说下个月可能不去京都，还没有决定。"
    ]) {
      expect(presentBookHomeMaterial(material({ kind: "follow_up", text, reason: "" }))).toEqual({ text });
    }
  });

  it.each([
    "Ta 上次提到在给摄影展做一本蓝色的小画册。",
    "阿岚这周还在整理河岸的手绘图，路线没有确定。",
    "小林说11月20日可能不参加考试，还要等老师回复。"
  ])("separates an existing follow-up intent from its full context: %s", (context) => {
    const text = `可以问问这件事的进展：${context}`;
    const item = Object.freeze(material({ kind: "follow_up", text, reason: "Ta 上次提到了这件正在做的事。" }));
    const result = presentBookHomeMaterial(item);
    expect(result).toEqual({ followUpTopic: true, text: context.replace(/^Ta 上次提到在给/u, "给"), reason: item.kind === "follow_up" ? item.reason : undefined });
    expect(item.text).toBe(text);
  });

  it.each(["Ta 上次提到的人周四来取书。", "Ta 上次提到过要等消息。"])("keeps a meaningful subject or verb prefix: %s", topic => {
    expect(presentBookHomeMaterial(material({kind: "follow_up", text: "可以问问这件事的进展：" + topic, reason: ""})).text).toBe(topic);
  });

  it("does not split the follow-up template inside formal attribution or another kind", () => {
    const template = "可以问问这件事的进展：Ta 还没有确定是否参加。";
    for (const prefix of ["你在复盘中提到：", "结合相处记录和你的复盘："]) {
      const text = prefix + template;
      expect(presentBookHomeMaterial(material({ kind: "follow_up", text, reason: "" }))).toEqual({ text });
    }
    expect(presentBookHomeMaterial(material({ kind: "recent_update", text: template }))).toEqual({ text: template });
  });

  it("keeps empty or nonmatching intent/context sentences unchanged", () => {
    for (const text of [
      "可以问问这件事的进展：",
      "可以问问这件事的进展：   ",
      "不可以问问这件事的进展：Ta 还没准备好。",
      "下周可以问问这件事的进展：Ta 还没准备好。",
      "可以问问这件事的进展吗：Ta 还没准备好。"
    ]) expect(presentBookHomeMaterial(material({ kind: "follow_up", text, reason: "" }))).toEqual({ text: text.trim() });
  });

  it("keeps formal reflection attribution even when its body repeats a type label", () => {
    for (const prefix of ["你在复盘中提到：", "结合相处记录和你的复盘："]) {
      const text = `${prefix}Ta 的近况：最近不一定能来。`;
      expect(presentBookHomeMaterial(material({ kind: "recent_update", text }))).toEqual({ text });
    }
  });

  it("keeps an unrelated label, a non-colon phrase, and an empty-body fallback intact", () => {
    for (const text of ["Ta 的近况：", "Ta 的近况：   ", "Ta 的近况仍未确定。", "你答应过：不要改日期。"])
      expect(presentBookHomeMaterial(material({ kind: "recent_update", text })).text).toBe(text.trim());
  });

  it("shows the verified open promise status without repeating its stock reason", () => {
    const item = material({ kind: "open_promise", text: "明天带上路线图。", reason: "这项约定仍然待办。", promiseId: "promise-1" });
    expect(presentBookHomeMaterial(item)).toEqual({ text: "明天带上路线图。", status: "仍待办" });
  });

  it("removes only the known content-free follow-up reason", () => {
    expect(presentBookHomeMaterial(material({ kind: "follow_up", text: "聊聊新剧的排练。", reason: "Ta 上次提到了这件正在做的事。" })))
      .toEqual({ text: "聊聊新剧的排练。" });
    expect(presentBookHomeMaterial(material({ kind: "follow_up", text: "聊聊新剧的排练。", reason: "Ta 上次提到了这件正在做的事，但首演日期还没确定。" })))
      .toHaveProperty("reason", "Ta 上次提到了这件正在做的事，但首演日期还没确定。");
  });

  it("keeps unique reasons including time, negation, uncertainty, and substantive detail", () => {
    for (const reason of [
      "Ta 上次提到刷题时遇到了一些难题。",
      "11月20日前还不能确认，可能需要先问老师。",
      "这项约定仍然待办，但要等对方回信。",
      "我答应的是下周，不是这周。"
    ]) {
      expect(presentBookHomeMaterial(material({ kind: "open_promise", text: "下周把资料带来。", reason, promiseId: "promise-2" })))
        .toEqual({ text: "下周把资料带来。", reason, status: "仍待办" });
    }
  });

  it("omits a repeated sentence but does not collapse a different question or multiple clauses", () => {
    expect(presentBookHomeMaterial(material({ kind: "follow_up", text: "可以问问 Ta：周五是否到场。", reason: "周五是否到场。" })))
      .toEqual({ text: "周五是否到场。" });
    expect(presentBookHomeMaterial(material({ kind: "follow_up", text: "她还没决定。", reason: "她还没决定？" })))
      .toHaveProperty("reason", "她还没决定？");
    expect(presentBookHomeMaterial(material({ kind: "follow_up", text: "别急。明天再问。", reason: "别急。明天再问，还要先确认日期。" })))
      .toHaveProperty("reason", "别急。明天再问，还要先确认日期。");
  });

  it("does not mutate the formal item, sources, or source quote", () => {
    const source = Object.freeze({ id: "source-1", uploadId: "upload-1", segmentIds: ["segment-1"], recordingDate: "2026-11-13",
      startSeconds: 12, endSeconds: 17, quote: "这周还没有决定，可能下周再试。", kind: "transcript", presentation: "direct_quote" });
    const item = Object.freeze(material({ kind: "follow_up", text: "可以问问 Ta：下周是否再试。", reason: "仍未确定。",
      sources: Object.freeze([source]) as unknown as BookHomeMaterial["sources"] }));
    const before = structuredClone(item);
    expect(presentBookHomeMaterial(item)).toEqual({ text: "下周是否再试。", reason: "仍未确定。" });
    expect(item).toEqual(before);
  });
});
