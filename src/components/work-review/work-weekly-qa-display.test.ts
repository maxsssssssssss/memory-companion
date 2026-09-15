import { describe, expect, it } from "vitest";
import type { WorkWeeklyLiveSourceResponse } from "@/lib/client/work-review-api";

import { formatWeeklyQaDisplayText } from "./work-weekly-qa-display";

const state = { title: "核对匿名验收清单", status: "open" as const, kind: "self" as const, ownerLabel: null,
  currentDueDate: null, completedAt: null, deletedAt: null, version: 1 };
const source: WorkWeeklyLiveSourceResponse = {
  identity: { sourceRef: "wrs_fixture", sourceKind: "todo", sourceId: "todo_1", version: 1, digest: null,
    publicationId: null, segmentId: null, included: true },
  source: { sourceRef: "wrs_fixture", id: "todo_1", version: 1, current: state, stateAtWeekEnd: state,
    historyCompleteness: "exact", sourceMeetingId: null, sourceFindingId: null, sourceFindingKind: null, projects: [] }
};
const display = (text: string) => formatWeeklyQaDisplayText(text, [source]);

describe("Weekly QA Todo status display", () => {
  // Evaluation supplied these three suffixes from the saved synthetic v3 claims.
  // The Todo name/date here are placeholders, not a reconstruction of the full answer.
  it.each([
    ["核对匿名验收清单在本周范围内的观察截止状态为 open。", "核对匿名验收清单在本周范围内的观察截止状态为未完成。"],
    ["本周系统记录中，核对匿名验收清单于合成日期被标记为 completed。", "本周系统记录中，核对匿名验收清单于合成日期被标记为已完成。"],
    ["本周系统记录中，核对匿名验收清单在标记 completed 后被重新打开为 open。", "本周系统记录中，核对匿名验收清单在标记完成后被重新打开为未完成。"],
    ["待办甲在本周范围内的观察截止状态为 open。", "待办甲在本周范围内的观察截止状态为未完成。"],
    ["待办甲在合成日期被标记为 completed。", "待办甲在合成日期被标记为已完成。"],
    ["待办甲在标记 completed 后被重新打开为 open。", "待办甲在标记完成后被重新打开为未完成。"],
    ["Todo 当前系统状态为 completed。", "Todo 当前系统状态为已标记完成。"],
    ["待办当前状态为 open。", "待办当前状态为未完成。"]
  ])("renders the known Todo description %s", (input, expected) => {
    expect(display(input)).toBe(expected);
    expect(display(expected)).toBe(expected);
  });

  it("keeps history distinct from the current state without inferring a reopen event", () => {
    const result = display("待办曾被标记为 completed。待办当前状态为 open。");
    expect(result).toBe("待办曾被标记为已完成。待办当前状态为未完成。");
    expect(result).not.toContain("重新打开");
    expect(result).not.toContain("已标记为已标记完成");
  });

  it("preserves a quoted Todo title while translating the explicit state outside it", () => {
    expect(display("待办“状态为 open”当前系统状态为 completed。"))
      .toBe("待办“状态为 open”当前系统状态为已标记完成。");
  });

  it.each([
    "会议当前状态为 completed。",
    "项目当前状态为 open。",
    "待办所属项目当前状态为 open。",
    "待办关联会议处理状态为 completed。",
    "待办 open，completed。",
    "待办当前状态为 complete。",
    "待办当前状态为 completedAt。",
    "待办当前状态为 open-source。",
    "待办当前状态为 OpenAI。",
    "待办当前状态为 unknown。",
    "待办当前状态为 open_value。",
    "待办当前状态为 OPEN。",
    "待办标题：当前状态为 open。",
    "待办名称为当前状态为 completed。",
    "原话：待办当前状态为 open。",
    "原话如下。\n待办当前状态为 open。",
    "会议还有一些处理信息。当前状态为 completed。",
    "引文：待办被标记为 completed。",
    "“待办当前状态为 open”",
    "待办‘状态为 completed’",
    "待办「状态为 open」",
    "待办『状态为 completed』",
    '待办"状态为 open"',
    "待办'Status completed'",
    "待办《状态为 open》",
    "“原文。待办当前状态为 open。结束”",
    "“原文\n待办当前状态为 open\n结束”",
    "“待办当前状态为 open。引号未闭合",
    "待办 `状态为 completed`。",
    "```text\n待办当前状态为 open。\n```",
    "~~~text\n待办当前状态为 open。\n~~~",
    "    待办当前状态为 open。",
    "> 待办当前状态为 open。",
    "# 待办当前状态为 open。",
    "[待办当前状态为 open](https://example.test/open)",
    "待办当前状态为 open。 https://example.test/completed",
    "待办当前状态为 open。[1]",
    "待办状态字段 completedAt，OpenAI 和 open-source 保持原样。"
  ])("retains protected or uncertain content: %s", (input) => {
    expect(display(input)).toBe(input);
  });

  it("protects literal unquoted titles and does not modify source objects", () => {
    const title = "状态为 open。状态为 completed";
    const protectedSource = { ...source, source: { ...source.source, current: { ...state, title }, stateAtWeekEnd: { ...state, title } } } as WorkWeeklyLiveSourceResponse;
    const original = structuredClone(protectedSource);
    expect(formatWeeklyQaDisplayText(`${title}在本周范围内的观察截止状态为 open。`, [protectedSource]))
      .toBe(`${title}在本周范围内的观察截止状态为未完成。`);
    expect(protectedSource).toEqual(original);
  });

  it("keeps raw text without complete, included Todo metadata", () => {
    const text = "核对匿名验收清单在本周范围内的观察截止状态为 open。";
    expect(formatWeeklyQaDisplayText(text)).toBe(text);
    expect(formatWeeklyQaDisplayText(text, [{ ...source, identity: { ...source.identity, included: false } }])).toBe(text);
    expect(formatWeeklyQaDisplayText(text, [{ ...source, identity: { ...source.identity, sourceKind: "meeting" } }])).toBe(text);
  });
});
