import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DailyReflectionAiReviewApi } from "@/lib/client/daily-reflection-ai-review-api";
import { DailyReflectionApiError } from "@/lib/client/daily-reflection-api";
import { ReflectionAppShell, useReflectionApp } from "./reflection-app-shell";

const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/reflection",
  useRouter: () => navigation
}));

// Keep the real hook, controller, navigationSession and client response parser.
// Only the same-origin transport is replaced with synthetic responses.
const transport = vi.fn<typeof fetch>();
const userA = { id: "account_A", email: "a@fixture.invalid", name: "合成 A" };
const userB = { id: "account_B", email: "b@fixture.invalid", name: "合成 B" };
let readUser: () => Promise<Response>;
const renderedAccounts: string[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deferredUser() {
  let resolve!: (response: () => Response) => void;
  const promise = new Promise<() => Response>((finish) => { resolve = finish; });
  // StrictMode can issue two me calls; each needs its own readable body.
  return { resolve, read: () => promise.then((response) => response()) };
}

const aiReviewApi: DailyReflectionAiReviewApi = {
  get: vi.fn(), ensure: vi.fn(), markSeen: vi.fn(),
  getSummary: vi.fn(async () => ({
    schemaVersion: 1 as const, exposureMode: "on" as const, pendingCount: 0, unseenReadyCount: 0, items: []
  }))
};

function AccountContent() {
  const { session, handleApiError } = useReflectionApp();
  if (session.auth.status !== "authenticated") throw new Error("Account content mounted before authentication");
  renderedAccounts.push(session.auth.user.id);
  return <>
    <p>内容 {session.auth.user.id}</p>
    <button onClick={() => handleApiError(new DailyReflectionApiError(401, "unauthenticated"))} type="button">模拟过期响应</button>
  </>;
}

function shell(strict = false) {
  const children: ReactNode = <ReflectionAppShell aiReviewApi={aiReviewApi} browserRecordingEnabled={false} toySyncEnabled={false}>
    <AccountContent />
  </ReflectionAppShell>;
  return strict ? <StrictMode>{children}</StrictMode> : children;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  renderedAccounts.length = 0;
  readUser = async () => json({ user: userA });
  transport.mockImplementation(async (input) => {
    const path = String(input);
    if (path === "/api/auth/me") return readUser();
    if (path === "/api/auth/logout") return json({ ok: true });
    if (path === "/api/daily-reflections") return json({ reflections: [] });
    throw new Error(`Unexpected synthetic request: ${path}`);
  });
  vi.stubGlobal("fetch", transport);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function logoutAndUnmount(strict = false) {
  const view = render(shell(strict));
  await screen.findByText("内容 account_A");
  fireEvent.click(screen.getByRole("button", { name: "账号菜单，当前账号合成 A" }));
  fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
  await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/date-companion"));
  expect(screen.queryByText("内容 account_A")).not.toBeInTheDocument();
  view.unmount();
  navigation.replace.mockClear();
  renderedAccounts.length = 0;
}

describe("ReflectionAppShell with the retained real session", () => {
  it.each([false, true])("revalidates logout/login B before redirecting on first remount (StrictMode=%s)", async (strict) => {
    await logoutAndUnmount(strict);
    const pending = deferredUser();
    readUser = pending.read;
    render(shell(strict));
    expect(screen.getByRole("status")).toHaveTextContent("正在打开你的日常复盘");
    expect(renderedAccounts).toEqual([]);
    expect(navigation.replace).not.toHaveBeenCalled();

    await act(async () => { pending.resolve(() => json({ user: userB })); });
    expect(await screen.findByText("内容 account_B")).toBeVisible();
    expect(renderedAccounts.every((account) => account === userB.id)).toBe(true);
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(transport.mock.calls.filter(([, init]) => init?.method !== "GET").map(([path]) => path))
      .toEqual(["/api/auth/logout"]);
  });

  it("redirects only after this mount's me confirms anonymous", async () => {
    await logoutAndUnmount();
    const pending = deferredUser();
    readUser = pending.read;
    render(shell());
    expect(navigation.replace).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(() => json({ error: "unauthenticated" }, 401)); });
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/date-companion"));
    expect(renderedAccounts).toEqual([]);
    expect(screen.getByRole("status")).toHaveTextContent("正在返回登录页");
  });

  it("does not mount old account content while revalidating a retained authenticated session", async () => {
    const first = render(shell());
    await screen.findByText("内容 account_A");
    first.unmount();
    renderedAccounts.length = 0;
    navigation.replace.mockClear();
    const pending = deferredUser();
    readUser = pending.read;
    render(shell());
    expect(renderedAccounts).toEqual([]);
    expect(screen.queryByText("内容 account_A")).not.toBeInTheDocument();
    await act(async () => { pending.resolve(() => json({ user: userB })); });
    expect(await screen.findByText("内容 account_B")).toBeVisible();
    expect(renderedAccounts.every((account) => account === userB.id)).toBe(true);
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("keeps a live API 401 fail closed after authentication", async () => {
    render(shell());
    await screen.findByText("内容 account_A");
    readUser = async () => json({ error: "unauthenticated" }, 401);
    fireEvent.click(screen.getByRole("button", { name: "模拟过期响应" }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/date-companion"));
    expect(screen.queryByText("内容 account_A")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("正在返回登录页"));
  });
});
