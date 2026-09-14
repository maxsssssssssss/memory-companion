// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getWorkTodoFindingDefaults } from "./work-todo";

describe("Work Todo defaults from confirmed Finding fields", () => {
  it("combines a broad topic with the complete action and its conditions", () => {
    const body = "若测试环境参数齐备，林澄在9月16日前整理迁移清单，仅包含试点范围。";
    const result = getWorkTodoFindingDefaults({ title: "迁移安排", body });
    expect(result.title).toBe(`迁移安排：${body}`);
  });

  it("keeps an actionable title when the legal Finding body is only background", () => {
    const body = "客户希望看到本轮迁移范围，细节待会上确认。";
    const result = getWorkTodoFindingDefaults({ title: "整理迁移清单", body });
    expect(result.title).toBe(`整理迁移清单：${body}`);
  });

  it("does not repeat identical source fields", () => {
    expect(getWorkTodoFindingDefaults({ title: " 整理迁移清单。 ", body: "整理迁移清单。" }).title)
      .toBe("整理迁移清单。");
  });

  it("keeps the original title when the complete combination exceeds the existing limit", () => {
    const title = "整理迁移清单";
    const body = `${"完整来源背景。".repeat(40)}仅在参数齐备后推进。`;
    const input = { title, body };
    expect(getWorkTodoFindingDefaults(input).title).toBe(title);
    expect(input.body).toBe(body);
    const oversizedTitle = "完整行动".repeat(70);
    expect(getWorkTodoFindingDefaults({ title: oversizedTitle, body }).title).toBe(oversizedTitle);
  });

  it("uses a supported owner and the Work calendar date rather than the UTC prefix", () => {
    expect(getWorkTodoFindingDefaults({ body: "整理测试清单。", candidateOwner: "林澄",
      dueAt: "2026-09-15T17:00:00.000Z", originalDueExpression: "9月16日前", actionBasis: "explicit_commitment" }))
      .toEqual({ title: "整理测试清单。", sourceOwnerLabel: "林澄", sourceDueAt: "2026-09-15T17:00:00.000Z",
        currentDueDate: "2026-09-16", ownerNeedsConfirmation: false, dueNeedsConfirmation: false });
  });

  it("does not infer missing fields from a speaker or a date mentioned in prose", () => {
    const source = { body: "Speaker 2提到9月16日的检查记录。", rawActorLabel: "Speaker 2",
      candidateOwner: null, dueAt: null, originalDueExpression: null };
    expect(getWorkTodoFindingDefaults(source)).toEqual({ title: source.body, sourceOwnerLabel: null, sourceDueAt: null,
      currentDueDate: null, ownerNeedsConfirmation: false, dueNeedsConfirmation: false });
  });

  it("leaves a relative or yearless deadline expression for explicit user confirmation", () => {
    expect(getWorkTodoFindingDefaults({ body: "准备回归清单。", originalDueExpression: "下周二前" }))
      .toMatchObject({ sourceDueAt: null, currentDueDate: null, dueNeedsConfirmation: true });
    expect(getWorkTodoFindingDefaults({ body: "准备回归清单。", originalDueExpression: "9月16号" }))
      .toMatchObject({ sourceDueAt: null, currentDueDate: null, dueNeedsConfirmation: true });
  });

  it("recognizes standalone publication notes without mistaking a prose mention for authority", () => {
    const supported = { candidateOwner: "林澄", dueAt: "2026-09-16T00:00:00.000Z" };
    expect(getWorkTodoFindingDefaults({ ...supported, body: "整理清单；负责人待确认；截止时间待确认" }))
      .toEqual({ title: "整理清单；负责人待确认；截止时间待确认", sourceOwnerLabel: null, sourceDueAt: null, currentDueDate: null,
        ownerNeedsConfirmation: true, dueNeedsConfirmation: true });
    expect(getWorkTodoFindingDefaults({ ...supported, body: "林澄检查“负责人待确认”和“截止时间待确认”的提示文案。" }))
      .toMatchObject({ sourceOwnerLabel: "林澄", currentDueDate: "2026-09-16",
        ownerNeedsConfirmation: false, dueNeedsConfirmation: false });
  });

  it("does not preassign an unowned action or parse malformed absolute dates", () => {
    expect(getWorkTodoFindingDefaults({ body: "仍需安排检查。", actionBasis: "unowned_follow_up",
      candidateOwner: "Speaker 3", dueAt: "9月16日" }))
      .toMatchObject({ sourceOwnerLabel: null, sourceDueAt: null, currentDueDate: null, ownerNeedsConfirmation: true });
  });
});
