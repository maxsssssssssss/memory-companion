import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ todoEnabled: false }));

vi.mock("@/lib/server/work-review/runtime-config", () => ({
  isWorkReviewTodoEnabled: () => state.todoEnabled
}));
vi.mock("@/components/work-review/work-review-home", () => ({
  WorkReviewHome: () => <div>legacy-work-review-home</div>
}));
vi.mock("@/components/work-review/work-review-today", () => ({
  WorkReviewToday: () => <div>work-review-today</div>
}));

import WorkReviewPage from "./page";

afterEach(() => {
  cleanup();
  state.todoEnabled = false;
});

describe("WorkReviewPage Todo flag compatibility", () => {
  it("keeps the existing WorkReviewHome when Todo is disabled", () => {
    render(<WorkReviewPage />);
    expect(screen.getByText("legacy-work-review-home")).toBeVisible();
    expect(screen.queryByText("work-review-today")).not.toBeInTheDocument();
  });

  it("uses Today as the root only when Todo is enabled", () => {
    state.todoEnabled = true;
    render(<WorkReviewPage />);
    expect(screen.getByText("work-review-today")).toBeVisible();
    expect(screen.queryByText("legacy-work-review-home")).not.toBeInTheDocument();
  });
});
