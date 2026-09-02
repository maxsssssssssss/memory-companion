import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkReviewApi } from "@/lib/client/work-review-api";

import { WorkReviewShell } from "./work-review-shell";

const navigation = vi.hoisted(() => ({
  router: { replace: vi.fn() }
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/work-review",
  useRouter: () => navigation.router
}));
vi.mock("@/components/product-system/product-switcher", () => ({ ProductSwitcher: () => <div>switcher</div> }));
vi.mock("@/components/product-system/product-account-menu", () => ({ ProductAccountMenu: () => <div>account</div> }));

afterEach(cleanup);

function authenticatedApi() {
  return {
    getCurrentUser: vi.fn().mockResolvedValue({ id: "account_1", email: "person@example.com", name: "Person" }),
    logout: vi.fn()
  } as unknown as WorkReviewApi;
}

describe("WorkReviewShell Todo flag", () => {
  it("keeps the existing shell without internal navigation when Todo is disabled", async () => {
    render(
      <WorkReviewShell
        analysisEnabled
        api={authenticatedApi()}
        dailyReflectionEnabled
        followUpEnabled={false}
        todoEnabled={false}
        todoMeetingProjectionEnabled={false}
        uploadEnabled
        verifierEnabled
      >
        <p>legacy-home</p>
      </WorkReviewShell>
    );
    expect(await screen.findByText("legacy-home")).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "工作复盘" })).not.toBeInTheDocument();
  });

  it("shows Today, Todo, and Meetings navigation only when Todo is enabled", async () => {
    render(
      <WorkReviewShell
        analysisEnabled
        api={authenticatedApi()}
        dailyReflectionEnabled
        followUpEnabled
        todoEnabled
        todoMeetingProjectionEnabled
        uploadEnabled
        verifierEnabled
      >
        <p>today-home</p>
      </WorkReviewShell>
    );
    const nav = await screen.findByRole("navigation", { name: "工作复盘" });
    expect(nav).toBeVisible();
    expect(screen.getByRole("link", { name: "今天" })).toHaveAttribute("href", "/work-review");
    expect(screen.getByRole("link", { name: "待办" })).toHaveAttribute("href", "/work-review/todos");
    expect(screen.getByRole("link", { name: "会议" })).toHaveAttribute("href", "/work-review/meetings");
  });
});
