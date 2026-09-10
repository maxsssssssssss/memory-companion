import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkReviewApi } from "@/lib/client/work-review-api";

import { WorkReviewShell } from "./work-review-shell";

const navigation = vi.hoisted(() => ({
  pathname: "/work-review/projects",
  router: { replace: vi.fn() }
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => navigation.router
}));
vi.mock("@/components/product-system/product-switcher", () => ({ ProductSwitcher: () => <div>switcher</div> }));
vi.mock("@/components/product-system/product-account-menu", () => ({ ProductAccountMenu: () => <div>account</div> }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function authenticatedApi(capabilities?: {
  projects: boolean;
  weekly: boolean;
  weeklyAi: boolean;
  weeklyVerifier: boolean;
  weeklyQa: boolean;
  weeklyQaVerifier: boolean;
}) {
  const api = {
    getCurrentUser: vi.fn().mockResolvedValue({ id: "account_1", email: "person@example.com", name: "Person" }),
    logout: vi.fn()
  } as unknown as WorkReviewApi;
  if (capabilities) api.getCapabilities = vi.fn().mockResolvedValue(capabilities);
  return api;
}

describe("WorkReviewShell Todo flag", () => {
  it("keeps Meetings available while Todo and optional capabilities are disabled", async () => {
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
    expect(screen.getByRole("link", { name: "会议" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "待办" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "项目" })).not.toBeInTheDocument();
  });

  it("fetches enabled capabilities and shows Meetings, Todo, Projects, and Weekly navigation", async () => {
    const client = authenticatedApi({
      projects: true,
      weekly: true,
      weeklyAi: true,
      weeklyVerifier: true,
      weeklyQa: true,
      weeklyQaVerifier: true
    });
    render(
      <WorkReviewShell
        analysisEnabled
        api={client}
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
    expect(screen.queryByRole("link", { name: "今天" })).not.toBeInTheDocument();
    const projects = await screen.findByRole("link", { name: "项目" });
    expect(projects).toHaveAttribute("href", "/work-review/projects");
    expect(projects).toHaveAttribute("aria-current", "page");
    expect(within(nav).getAllByRole("link").map(link => link.textContent)).toEqual(["会议", "待办", "项目", "周回顾"]);
    expect(screen.getByRole("link", { name: "待办" })).toHaveAttribute("href", "/work-review/todos");
    expect(screen.getByRole("link", { name: "会议" })).toHaveAttribute("href", "/work-review/meetings");
    expect(await screen.findByRole("link", { name: "周回顾" })).toHaveAttribute("href", "/work-review/weekly");
    expect(client.getCapabilities).toHaveBeenCalledTimes(1);
  });

  it("keeps Weekly out of navigation when the server capability is off", async () => {
    render(
      <WorkReviewShell
        analysisEnabled
        api={authenticatedApi({
          projects: true,
          weekly: false,
          weeklyAi: false,
          weeklyVerifier: false,
          weeklyQa: false,
          weeklyQaVerifier: false
        })}
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

    expect(await screen.findByText("today-home")).toBeVisible();
    expect(await screen.findByRole("navigation", { name: "工作复盘" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "周回顾" })).not.toBeInTheDocument();
  });
});
