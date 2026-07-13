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
});
