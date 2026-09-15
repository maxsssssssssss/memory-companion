// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkWeeklySourceSnapshot } from "@/lib/domain/work-weekly";
import { adaptWorkWeeklyModelResponse, type WorkWeeklySynthesizerModelResponse } from "./weekly-ai-provider";
import { WORK_WEEKLY_TEST_REFS as refs, workWeeklyTestSnapshot } from "./weekly-ai-test-fixture";

afterEach(() => vi.restoreAllMocks());

function reopen(snapshot: WorkWeeklySourceSnapshot) {
  const todo = snapshot.todos[0]!;
  todo.current = { ...todo.current, status: "open", completedAt: null, version: 3 };
  todo.version = 3;
  todo.stateAtWeekEnd = null;
  const event = { ...snapshot.todoEvents[0]!, id: "event_reopened", sourceRef: "work:todo_event:reopened",
    eventType: "todo.reopened" as const, changedFields: ["status", "reopenedAt"], occurredAt: "2026-09-03T08:01:00.000Z", oldVersion: 2,
    newVersion: 3, stateAfter: { ...todo.current } };
  snapshot.todoEvents.push(event);
  snapshot.identities.push({ ...snapshot.identities.find((item) => item.sourceRef === refs.todoCompleted)!,
    sourceRef: event.sourceRef, sourceId: event.id, version: 3 });
  snapshot.allowlistedSourceRefs.push(event.sourceRef);
  snapshot.createdAt = "2026-09-03T09:00:00.000Z";
  return snapshot;
}

function duplicated(snapshot: WorkWeeklySourceSnapshot): WorkWeeklySynthesizerModelResponse {
  const sourceRefs = [snapshot.todos[0]!.sourceRef, ...snapshot.todoEvents.map((event) => event.sourceRef)];
  return { items: [
    { section: "overview", text: "待办先被标记完成，随后重新打开，当前未完成。", claimType: "fact", isInterpretation: false, sourceRefs },
    { section: "completed", text: "清单曾勾选完成，但之后撤销完成状态。", claimType: "completion", isInterpretation: false,
      sourceRefs: sourceRefs.slice(1) }
  ] };
}

describe("Weekly canonical Todo state rollup before verification", () => {
  it("combines different wording and citation subsets into one observed state timeline", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const snapshot = reopen(workWeeklyTestSnapshot());
    const wire = duplicated(snapshot);
    const before = JSON.stringify({ snapshot, wire });
    const items = adaptWorkWeeklyModelResponse({ snapshot, response: wire });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "item_001", section: "overview", itemType: "evidence_backed_fact" });
    expect(items[0]!.text).toBe("待办“整理发布清单”：2026-09-03在系统中标记完成 → 2026-09-03重新打开；截至2026-09-03，系统状态为未完成；当前计划日期：2026-09-05。系统状态不代表实际交付。");
    expect(items[0]!.claims).toEqual([{ id: "claim_001_001", text: items[0]!.text, claimType: "fact",
      sourceRefs: wire.items[0]!.sourceRefs }]);
    expect(JSON.stringify({ snapshot, wire })).toBe(before);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ stage: "normalization",
      reason: "todo_state_summaries_rolled_up", todoCount: 1, inputItemCount: 2, outputItemCount: 1 });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/整理|work:todo|account_a|2026-/u);
  });

  it("uses completed only when the observed state is still complete", () => {
    const snapshot = workWeeklyTestSnapshot();
    const items = adaptWorkWeeklyModelResponse({ snapshot, response: duplicated(snapshot) });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ section: "completed", claims: [{ claimType: "completion" }] });
    expect(items[0]!.text).toContain("系统状态为已完成");
    expect(items[0]!.text).not.toContain("重新打开");
  });

  it("uses the selected week's end state instead of a later current completion", () => {
    const snapshot = reopen(workWeeklyTestSnapshot());
    snapshot.scope.windowComplete = true;
    snapshot.scope.observedThrough = snapshot.scope.weekEnd;
    snapshot.todos[0]!.stateAtWeekEnd = { ...snapshot.todos[0]!.current };
    snapshot.todos[0]!.current = { ...snapshot.todos[0]!.current, title: "下周才改的标题", status: "completed", version: 4 };
    const items = adaptWorkWeeklyModelResponse({ snapshot, response: duplicated(snapshot) });
    expect(items).toHaveLength(1);
    expect(items[0]!.section).toBe("overview");
    expect(items[0]!.text).toContain("截至2026-09-06，系统状态为未完成");
    expect(items[0]!.text).not.toContain("下周才改");
  });

  it("retains dates, owner changes and title changes, not just overlapping references", () => {
    const snapshot = reopen(workWeeklyTestSnapshot());
    const todo = snapshot.todos[0]!;
    todo.current = { ...todo.current, title: "新的清单标题", ownerLabel: "合成人物乙", currentDueDate: null, version: 4 };
    const event = { ...snapshot.todoEvents[1]!, sourceRef: "work:todo_event:updated", id: "event_updated",
      eventType: "todo.updated" as const, changedFields: ["title", "ownerLabel", "currentDueDate"],
      occurredAt: "2026-09-03T08:02:00.000Z", oldVersion: 3, newVersion: 4, stateAfter: { ...todo.current } };
    snapshot.todoEvents.push(event);
    snapshot.identities.push({ ...snapshot.identities.at(-1)!, sourceRef: event.sourceRef, sourceId: event.id, version: 4 });
    snapshot.allowlistedSourceRefs.push(event.sourceRef);
    const items = adaptWorkWeeklyModelResponse({ snapshot, response: duplicated(snapshot) });
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toContain("标题由“整理发布清单”改为“新的清单标题”");
    expect(items[0]!.text).toContain("记录的负责人由“未设置”改为“合成人物乙”");
    expect(items[0]!.text).toContain("计划日期由2026-09-05改为未设置");
    expect(items[0]!.text).not.toMatch(/接受|承诺|截止/u);
    expect(items[0]!.claims[0]!.sourceRefs).toContain(event.sourceRef);
  });

  it("does not combine different Todo IDs with the same title", () => {
    const snapshot = workWeeklyTestSnapshot();
    const other = { ...snapshot.todos[0]!, id: "todo_b", sourceRef: "work:todo:todo_b" };
    snapshot.todos.push(other);
    snapshot.identities.push({ ...snapshot.identities.find((item) => item.sourceRef === refs.todo)!,
      sourceRef: other.sourceRef, sourceId: other.id });
    snapshot.allowlistedSourceRefs.push(other.sourceRef);
    const wire = duplicated(snapshot);
    wire.items[1] = { ...wire.items[0]!, text: "另一个同名待办的系统状态。", sourceRefs: [other.sourceRef] };
    expect(adaptWorkWeeklyModelResponse({ snapshot, response: wire })).toHaveLength(2);
  });

  it("keeps an open Todo without activity events in overview", () => {
    const snapshot = reopen(workWeeklyTestSnapshot());
    snapshot.todoEvents = [];
    const wire = duplicated(snapshot);
    wire.items[1] = { ...wire.items[0]!, text: "仍然没有勾选完成的待办。" };
    const items = adaptWorkWeeklyModelResponse({ snapshot, response: wire });
    expect(items).toHaveLength(1);
    expect(items[0]!.section).toBe("overview");
    expect(items[0]!.text).toContain("系统状态为未完成");
    expect(items[0]!.text).not.toMatch(/重新打开|标记完成|实际开始/u);
    expect(items[0]!.claims[0]!.sourceRefs).toEqual([refs.todo]);
  });

  it("does not use array order as the event timeline when a Todo is completed again", () => {
    const snapshot = reopen(workWeeklyTestSnapshot());
    const todo = snapshot.todos[0]!;
    todo.current = { ...todo.current, status: "completed", completedAt: "2026-09-03T08:02:00.000Z", version: 4 };
    const event = { ...snapshot.todoEvents[0]!, id: "completed_again", sourceRef: "work:todo_event:completed_again",
      occurredAt: "2026-09-03T08:02:00.000Z", oldVersion: 3, newVersion: 4, stateAfter: { ...todo.current } };
    snapshot.todoEvents.unshift(event);
    snapshot.identities.push({ ...snapshot.identities.at(-1)!, sourceRef: event.sourceRef, sourceId: event.id, version: 4 });
    snapshot.allowlistedSourceRefs.push(event.sourceRef);
    const items = adaptWorkWeeklyModelResponse({ snapshot, response: duplicated(snapshot) });
    expect(items).toHaveLength(1);
    expect(items[0]!.section).toBe("completed");
    expect(items[0]!.text).toContain("在系统中标记完成 → 2026-09-03重新打开 → 2026-09-03在系统中标记完成");
    expect(items[0]!.text).toContain("系统状态为已完成");
  });

  it("preserves meeting facts, interpretations and suggestions alongside the state rollup", () => {
    const snapshot = reopen(workWeeklyTestSnapshot());
    const wire = duplicated(snapshot);
    const extra: WorkWeeklySynthesizerModelResponse["items"] = [
      { ...wire.items[0]!, text: "会议确认了方案乙。", section: "decisions", claimType: "decision", sourceRefs: [refs.decision] },
      { ...wire.items[0]!, text: "会议中的实际进展。", section: "progress", sourceRefs: [refs.todo, refs.evidenceCommitment] },
      { ...wire.items[0]!, text: "一种可能的解释。", isInterpretation: true },
      { ...wire.items[0]!, text: "建议核对清单。", section: "next_week" }
    ];
    wire.items.push(...extra);
    const items = adaptWorkWeeklyModelResponse({ snapshot, response: wire });
    expect(items).toHaveLength(5);
    expect(items.slice(1).map((item) => item.text)).toEqual(extra.map((item) => item.text));
    expect(items.slice(1).map((item) => item.section)).toEqual(extra.map((item) => item.section));
  });

  it.each(["legacy", "unavailable_week_end", "future_event", "unsupported_change"])("retains original claims when canonical rollup lacks data: %s", (reason) => {
    const snapshot = reopen(workWeeklyTestSnapshot());
    if (reason === "legacy") snapshot.todos[0]!.historyCompleteness = "legacy_limited";
    if (reason === "unavailable_week_end") snapshot.scope.windowComplete = true;
    if (reason === "future_event") snapshot.todoEvents[1]!.localDate = "2026-09-04";
    if (reason === "unsupported_change") snapshot.todoEvents[1]!.changedFields.push("notes");
    const wire = duplicated(snapshot);
    expect(adaptWorkWeeklyModelResponse({ snapshot, response: wire }).map((item) => item.text))
      .toEqual(wire.items.map((item) => item.text));
  });

  it("cannot erase an unknown citation by replacing its model claim", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const snapshot = reopen(workWeeklyTestSnapshot());
    const wire = duplicated(snapshot);
    wire.items[1]!.sourceRefs.push("work:todo:other_account");
    expect(() => adaptWorkWeeklyModelResponse({ snapshot, response: wire }))
      .toThrow("work_weekly_source_not_allowlisted");
  });
});
