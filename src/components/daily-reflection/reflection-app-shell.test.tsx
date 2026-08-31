import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DailyReflectionSessionValue } from "@/lib/client/daily-reflection-session";

import { ReflectionAppShell } from "./reflection-app-shell";

const state = vi.hoisted(() => ({
  pathname: "/reflection",
  router: {
    push: vi.fn(),
    replace: vi.fn()
  },
  session: null as unknown as DailyReflectionSessionValue
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => state.router
}));

vi.mock("@/lib/client/daily-reflection-session", () => ({
  useDailyReflectionSession: () => state.session
}));

function session(auth: DailyReflectionSessionValue["auth"]): DailyReflectionSessionValue {
  return {
    auth,
    initialize: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined)
  } as unknown as DailyReflectionSessionValue;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.pathname = "/reflection";
  state.session = session({
    status: "authenticated",
    user: { id: "account_1", email: "user@example.com", name: "小满" }
  });
});

describe("ReflectionAppShell", () => {
  it("provides one canonical desktop/mobile shell and global capture action", () => {
    state.pathname = "/reflection/cards";
    render(
      <ReflectionAppShell browserRecordingEnabled toySyncEnabled={false}>
        <p>页面内容</p>
      </ReflectionAppShell>
    );

    expect(screen.getByText("页面内容")).toBeVisible();
    const desktop = screen.getByRole("navigation", { name: "日常复盘主导航" });
    expect(within(desktop).getByRole("link", { name: "卡片" })).toHaveAttribute("aria-current", "page");
    expect(within(desktop).getByRole("link", { name: "记忆" })).toHaveAttribute("href", "/reflection/memory");
    expect(within(desktop).getByRole("link", { name: "一起想" })).toHaveAttribute("href", "/reflection/think");
    expect(within(desktop).queryByRole("link", { name: "问问过去" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("banner")).getByRole("link", { name: /开始讲述/u }))
      .toHaveAttribute("href", "/reflection/capture?new=1&method=record");
    expect(within(screen.getByRole("banner")).queryByRole("button", { name: "头脑风暴" }))
      .toBeVisible();
    expect(within(screen.getByRole("banner")).getByRole("button", { name: /切换产品/u })).toBeVisible();
    const mobile = screen.getByRole("navigation", { name: "日常复盘移动导航" });
    expect(within(mobile).getByRole("link", { name: "开始讲述" })).toHaveAttribute("href", "/reflection/capture?new=1&method=record");
    expect(within(mobile).getByRole("link", { name: "一起想" })).toHaveAttribute("href", "/reflection/think");
    expect(within(mobile).queryByText("记忆")).not.toBeInTheDocument();
  });

  it("opens and closes the shared Quick Panel from the global brainstorm action", async () => {
    render(
      <ReflectionAppShell browserRecordingEnabled toySyncEnabled={false}>
        <p>页面内容</p>
      </ReflectionAppShell>
    );

    const trigger = within(screen.getByRole("banner")).getByRole("button", { name: "头脑风暴" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "先把这个念头打开" })).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("uses a local return header and removes the mobile bottom navigation in focused flows", () => {
    state.pathname = "/reflection/cards/card_1";
    render(
      <ReflectionAppShell browserRecordingEnabled toySyncEnabled={false}>
        <p>卡片详情</p>
      </ReflectionAppShell>
    );

    expect(screen.getByRole("navigation", { name: "当前页面导航" })).toHaveTextContent("返回卡片");
    expect(screen.queryByRole("navigation", { name: "日常复盘移动导航" })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "日常复盘主导航" })).toBeInTheDocument();
  });

  it("keeps authentication fail closed and redirects anonymous users", async () => {
    state.session = session({ status: "anonymous" });
    render(
      <ReflectionAppShell browserRecordingEnabled={false} toySyncEnabled={false}>
        <p>私密内容</p>
      </ReflectionAppShell>
    );

    expect(screen.queryByText("私密内容")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("正在返回登录页");
    await waitFor(() => expect(state.router.replace).toHaveBeenCalledWith("/date-companion"));
  });

  it("shows an honest auth error and retries the same session boundary", () => {
    state.session = session({ status: "error", message: "登录状态暂时无法确认。" });
    render(
      <ReflectionAppShell browserRecordingEnabled={false} toySyncEnabled={false}>
        <p>私密内容</p>
      </ReflectionAppShell>
    );

    expect(screen.getByRole("alert")).toHaveTextContent("登录状态暂时无法确认。");
    fireEvent.click(screen.getByRole("button", { name: "重新尝试" }));
    expect(state.session.initialize).toHaveBeenCalledTimes(1);
  });

  it("uses the shared account menu and returns to login after logout", async () => {
    const logout = vi.fn(async () => undefined);
    state.session = {
      ...state.session,
      logout
    };
    render(
      <ReflectionAppShell browserRecordingEnabled toySyncEnabled={false}>
        <p>页面内容</p>
      </ReflectionAppShell>
    );

    fireEvent.click(screen.getByRole("button", { name: /账号菜单/u }));
    expect(screen.getByText("小满")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    expect(state.router.replace).toHaveBeenCalledWith("/date-companion");
  });
});
