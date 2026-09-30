import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useState } from "react";

import { GlobalProductEntry } from "./global-product-entry";
import { GlobalProductEntryBoundary } from "./global-product-entry-boundary";
import { ProductAccountMenu } from "./product-account-menu";
import { ProductCapabilitiesProvider } from "./product-capabilities";
import { productPreferenceKey } from "./product-preference";
import { ProductDialog, ProductEvidence, ProductReviewCompletion, ProductState, ProductTabs } from "./product-primitives";
import { ProductSwitcher } from "./product-switcher";

const { replaceMock, routerMock } = vi.hoisted(() => {
  const replace = vi.fn();
  return { replaceMock: replace, routerMock: { replace } };
});

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock
}));

beforeEach(() => {
  replaceMock.mockReset();
  window.localStorage.clear();
});
afterEach(cleanup);

describe("product system", () => {
  it("adds the trial learning entrance while retaining the existing three destinations", () => {
    render(<GlobalProductEntry accountId="account_a" dailyReflectionEnabled workReviewEnabled onLogout={vi.fn()} userLabel="synthetic@example.com" />);
    for (const [name, href] of [["约会陪伴", "/date-companion/a"], ["日常复盘", "/reflection"], ["工作复盘", "/work-review"], ["学习整理", "/learning"]]) {
      expect(screen.getByRole("link", { name: new RegExp(name) })).toHaveAttribute("href", href);
    }
    const learning = screen.getByRole("link", { name: /学习整理/ });
    expect(learning).toHaveTextContent("试用中");
    learning.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(learning);
    expect(window.localStorage.getItem(productPreferenceKey("account_a"))).toBe("learning_organizer");
  });

  it("exposes learning in the switcher without changing other feature gates", () => {
    render(<ProductSwitcher accountId="account_a" currentProduct="learning_organizer" dailyReflectionEnabled={false} workReviewEnabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: /切换产品/ }));
    expect(screen.getByRole("link", { name: /学习整理/ })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: /工作复盘|日常复盘/ })).not.toBeInTheDocument();
  });
  it.each([undefined, false])("uses the server capability at the entry while honoring override %s", (override) => {
    render(
      <ProductCapabilitiesProvider workReviewEnabled>
        <GlobalProductEntry
          accountId="account_a"
          dailyReflectionEnabled={false}
          onLogout={vi.fn()}
          userLabel="a@example.com"
          workReviewEnabled={override}
        />
      </ProductCapabilitiesProvider>
    );

    if (override === false) {
      expect(screen.queryByRole("link", { name: /工作复盘/u })).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole("link", { name: /工作复盘/u })).toHaveAttribute("href", "/work-review");
    }
    expect(screen.queryByRole("link", { name: /日常复盘/u })).not.toBeInTheDocument();
  });

  it("keeps the neutral entry on auth-only transport", async () => {
    const api = {
      getCurrentUser: vi.fn().mockResolvedValue({
        id: "account_a",
        email: "a@example.com",
        name: "小明"
      }),
      logout: vi.fn().mockResolvedValue(undefined)
    };
    render(<GlobalProductEntryBoundary api={api} dailyReflectionEnabled workReviewEnabled={false} />);

    expect(await screen.findByRole("heading", { name: "选择一个空间" })).toBeVisible();
    expect(api.getCurrentUser).toHaveBeenCalledTimes(1);
    expect(screen.getByText("小明")).toBeVisible();
    expect(
      screen.getByRole("link", { name: /约会陪伴/u }).querySelector("span[aria-hidden='true']")
    ).toHaveTextContent("约");
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("keeps anonymous and retryable auth states fail closed at the global entry", async () => {
    const api = {
      getCurrentUser: vi.fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(null),
      logout: vi.fn().mockResolvedValue(undefined)
    };
    render(<GlobalProductEntryBoundary api={api} dailyReflectionEnabled workReviewEnabled={false} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法进入");
    fireEvent.click(screen.getByRole("button", { name: "重新尝试" }));
    await waitFor(() => expect(api.getCurrentUser).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("status")).toHaveTextContent("正在返回登录页");
    expect(replaceMock).toHaveBeenCalledWith("/date-companion");
    expect(screen.queryByRole("heading", { name: "选择一个空间" })).not.toBeInTheDocument();
  });

  it("wires the global account menu to the real logout boundary", async () => {
    const api = {
      getCurrentUser: vi.fn().mockResolvedValue({
        id: "account_a",
        email: "a@example.com",
        name: null
      }),
      logout: vi.fn().mockResolvedValue(undefined)
    };
    render(<GlobalProductEntryBoundary api={api} dailyReflectionEnabled workReviewEnabled={false} />);

    await screen.findByRole("heading", { name: "选择一个空间" });
    fireEvent.click(screen.getByRole("button", { name: /账号菜单/u }));
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    await waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1));
    expect(replaceMock).toHaveBeenCalledWith("/date-companion");
  });

  it("keeps last-product state account scoped and never auto-navigates", async () => {
    window.localStorage.setItem(productPreferenceKey("account_a"), "daily_reflection");
    window.localStorage.setItem(productPreferenceKey("account_b"), "date_companion");
    render(
      <GlobalProductEntry
        accountId="account_a"
        dailyReflectionEnabled
        onLogout={vi.fn()}
        userLabel="a@example.com"
        workReviewEnabled
      />
    );

    expect(await screen.findByText("上次使用")).toBeVisible();
    expect(screen.getByRole("link", { name: /日常复盘.*继续进入/u })).toHaveTextContent("继续进入");
    expect(screen.getByRole("link", { name: "继续上次使用 · 日常复盘 →" })).toHaveAttribute("href", "/reflection");
    expect(window.localStorage.getItem(productPreferenceKey("account_b"))).toBe("date_companion");
  });

  it("marks the current shell and exposes one lightweight switcher", async () => {
    render(<ProductSwitcher accountId="account_a" currentProduct="date_companion" />);

    expect(screen.getByRole("button", { name: /切换产品，当前为约会陪伴/u })).toBeVisible();
    await waitFor(() => {
      expect(window.localStorage.getItem(productPreferenceKey("account_a"))).toBe("date_companion");
    });
    fireEvent.click(screen.getByRole("button", { name: /切换产品/u }));
    expect(screen.getByRole("link", { name: "全部产品" })).toHaveAttribute("href", "/");
    expect(
      screen.getByRole("link", { name: /约会陪伴/u }).querySelector("span[aria-hidden='true']")
    ).toHaveTextContent("约");
    expect(screen.getByRole("link", { name: /日常复盘/u })).toHaveAttribute("href", "/reflection");
    expect(screen.getByText("工作复盘")).toBeVisible();
  });

  it("enables the Work Review route and keeps its last-product preference account scoped", async () => {
    render(
      <ProductSwitcher
        accountId="account_a"
        currentProduct="office_review"
        workReviewEnabled
      />
    );

    expect(screen.getByRole("button", { name: /切换产品，当前为工作复盘/u })).toBeVisible();
    await waitFor(() => {
      expect(window.localStorage.getItem(productPreferenceKey("account_a"))).toBe("office_review");
    });
    fireEvent.click(screen.getByRole("button", { name: /切换产品/u }));
    expect(screen.getByRole("link", { name: /工作复盘/u })).toHaveAttribute("href", "/work-review");
  });

  it("closes product menus on outside click, repeated click and Escape with focus restored", () => {
    render(<ProductSwitcher accountId="account_a" currentProduct="daily_reflection" />);

    const trigger = screen.getByRole("button", { name: /切换产品/u });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerDown(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("keeps unavailable spaces honest inside the switcher", () => {
    render(
      <ProductSwitcher
        accountId="account_a"
        currentProduct="date_companion"
        dailyReflectionEnabled={false}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /切换产品/u }));

    expect(screen.queryByRole("link", { name: /日常复盘/u })).not.toBeInTheDocument();
    expect(screen.getByText("日常复盘").closest("span[aria-disabled='true']")).toBeVisible();
    expect(screen.getAllByText("暂未开放")).toHaveLength(2);
  });

  it("provides one shared account menu with pending and recoverable logout states", async () => {
    const onLogout = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    render(<ProductAccountMenu onLogout={onLogout} showLabel userLabel="a@example.com" />);

    const trigger = screen.getByRole("button", { name: /账号菜单/u });
    fireEvent.click(trigger);
    const logout = screen.getByRole("button", { name: "退出登录" });
    fireEvent.click(logout);
    fireEvent.click(logout);
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法退出");

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(2));
  });

  it("provides keyboard tabs without changing business values", () => {
    function Harness() {
      const [value, setValue] = useState("today");
      return (
        <ProductTabs
          ariaLabel="回看范围"
          items={[
            { id: "today", label: "今天", panel: <p>今天内容</p> },
            { id: "week", label: "本周", panel: <p>本周内容</p> }
          ]}
          onChange={setValue}
          value={value}
        />
      );
    }
    render(<Harness />);

    const today = screen.getByRole("tab", { name: "今天" });
    today.focus();
    fireEvent.keyDown(today, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "本周" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("本周内容");
  });

  it("keeps dialog focus, Escape and scroll-lock behavior canonical", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)} type="button">打开详情</button>
          <ProductDialog onClose={() => setOpen(false)} open={open} title="来源详情">
            <button type="button">查看原话</button>
          </ProductDialog>
        </>
      );
    }
    render(<Harness />);

    const opener = screen.getByRole("button", { name: "打开详情" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog", { name: "来源详情" })).toHaveAttribute("aria-modal", "true");
    expect(document.body.style.overflow).toBe("hidden");
    expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe("");
    expect(opener).toHaveFocus();
  });

  it("traps focus using visible controls and disclosure summaries, not closed details content", () => {
    render(<ProductDialog open onClose={() => {}} title="折叠内容">
      <button>可见操作</button>
      <details><summary>处理详情</summary><button>隐藏操作</button></details>
      <input type="hidden" />
      <div hidden><button>另一隐藏操作</button></div>
    </ProductDialog>);
    const close = screen.getByRole("button", { name: "关闭" });
    const summary = screen.getByText("处理详情");
    close.focus(); fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(summary).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" }); expect(close).toHaveFocus();
    fireEvent.click(summary);
    close.focus(); fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "隐藏操作" })).toHaveFocus();
  });

  it("can preserve an in-flight child controller while closed without keeping focus or scroll lock", async () => {
    const unmounted = vi.fn();
    let complete!: () => void;
    function Child() {
      const [status, setStatus] = useState("进行中");
      useEffect(() => { complete = () => setStatus("已完成"); return unmounted; }, []);
      return <p>{status}</p>;
    }
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>材料进度</button>
        <ProductDialog keepMounted open={open} onClose={() => setOpen(false)} title="材料与进度"><Child /></ProductDialog></>;
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "材料进度" });
    opener.focus(); fireEvent.click(opener);
    expect(screen.getByText("进行中")).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe(""); expect(opener).toHaveFocus();
    act(() => complete());
    expect(unmounted).not.toHaveBeenCalled();
    fireEvent.click(opener); expect(screen.getByText("已完成")).toBeVisible();
  });

  it("uses one evidence language and honest loading/error semantics", () => {
    render(
      <>
        <ProductEvidence meta="8 月 24 日">这是当时的原话。</ProductEvidence>
        <ProductState description="请稍后再试。" title="暂时没有加载完成" tone="error" />
      </>
    );

    expect(screen.getByText("这是当时的原话。").closest("figure")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("暂时没有加载完成");
  });

  it("links a review completion action to its user-facing title", () => {
    render(
      <ProductReviewCompletion
        action={<button type="button">完成本次复盘</button>}
        description="长期记忆不会自动改变。"
        title="准备好就完成本次复盘"
      />
    );

    const region = screen.getByRole("region", { name: "准备好就完成本次复盘" });
    expect(region).toHaveTextContent("长期记忆不会自动改变。");
    expect(screen.getByRole("button", { name: "完成本次复盘" })).toBeInTheDocument();
  });
});
