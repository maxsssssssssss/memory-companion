// @vitest-environment node

import { describe, expect, it } from "vitest";
import { calculateImportance } from "./importance";

function input(overrides: Partial<Parameters<typeof calculateImportance>[0]> = {}) {
  return {
    type: "event" as const,
    title: "Discuss weekend plans",
    summary: "We discussed where to meet.",
    status: "active" as const,
    occurrenceCount: 1,
    evidenceDates: ["2026-07-07"],
    evidenceSourceTypes: ["transcript" as const],
    ...overrides
  };
}

describe("memory importance", () => {
  it("scores a commitment above an otherwise equivalent event", () => {
    const event = calculateImportance(input());
    const commitment = calculateImportance(input({ type: "commitment" }));

    expect(commitment.score).toBeGreaterThan(event.score);
    expect(commitment.reasons).toContain("commitment type");
  });

  it("raises importance for recurrence across multiple dates", () => {
    const once = calculateImportance(input());
    const repeated = calculateImportance(
      input({
        occurrenceCount: 3,
        evidenceDates: ["2026-07-07", "2026-07-08", "2026-07-09"]
      })
    );

    expect(repeated.score).toBeGreaterThan(once.score);
    expect(repeated.score).toBeGreaterThanOrEqual(0.75);
    expect(repeated.reasons).toEqual(
      expect.arrayContaining(["appeared multiple times", "appeared on multiple dates"])
    );
  });

  it("explains actionable and unresolved signals", () => {
    const result = calculateImportance(
      input({
        type: "question",
        title: "Confirm with Alex next Wednesday",
        summary: "The next step is still unresolved and needs follow-up on 2026-07-15."
      })
    );

    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "question type",
        "contains explicit date",
        "mentions a person",
        "contains future action",
        "unresolved item"
      ])
    );
  });

  it("does not retain the unresolved bonus after a question is resolved", () => {
    const active = calculateImportance(input({ type: "question", status: "active" }));
    const resolved = calculateImportance(input({ type: "question", status: "resolved" }));

    expect(active.score).toBeGreaterThan(resolved.score);
    expect(resolved.reasons).not.toContain("unresolved item");
  });

  it("scores stable preferences above one-time choices", () => {
    const stable = calculateImportance(input({
      type: "preference",
      title: "更喜欢低音量",
      summary: "听音乐时我通常会把音量调低。"
    }));
    const oneTime = calculateImportance(input({
      type: "preference",
      title: "今天选择低音量",
      summary: "今天先把音量调低。"
    }));

    expect(stable.score).toBeGreaterThan(oneTime.score);
  });

  it("does not make a broad single-day summary important because it has many evidence rows", () => {
    const result = calculateImportance({
      ...input({ type: "event", title: "会议安排与风险问题梳理", summary: "围绕多个话题展开。" }),
      evidenceCount: 47
    } as Parameters<typeof calculateImportance>[0]);

    expect(result.score).toBeLessThan(0.6);
    expect(result).toHaveProperty("breakdown");
  });

  it("keeps one-off relationship observations below durable commitments", () => {
    const listening = calculateImportance(input({
      type: "relationship_signal",
      title: "一次主动倾听",
      summary: "当前片段里有一次复述。"
    }));
    const commitment = calculateImportance(input({
      type: "commitment",
      title: "周五前检查简历",
      summary: "我答应周五晚上八点前完成检查。"
    }));

    expect(listening.score).toBeLessThan(0.5);
    expect(commitment.score).toBeGreaterThan(listening.score);
  });

  it("reduces resolved ordinary questions below active actionable questions", () => {
    const active = calculateImportance(input({
      type: "question",
      status: "active",
      title: "博物馆出发时间待确认",
      summary: "具体时间还没有确认。"
    }));
    const resolved = calculateImportance(input({
      type: "question",
      status: "resolved",
      title: "普通时间问题已解决",
      summary: "出发时间已经确认。"
    }));

    expect(resolved.score).toBeLessThan(0.5);
    expect(active.score).toBeGreaterThan(resolved.score);
  });
});
