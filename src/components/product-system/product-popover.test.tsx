import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Link from "next/link";
import type { NextRouter } from "next/router";
import { RouterContext } from "next/dist/shared/lib/router-context.shared-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductPopover } from "./product-popover";
import { ProductSwitcher } from "./product-switcher";
import { productPreferenceKey } from "./product-preference";

function router(): NextRouter {
  return { route: "/", pathname: "/", query: {}, asPath: "/", basePath: "", isFallback: false,
    isReady: true, isPreview: false, isLocaleDomain: false, push: vi.fn(async () => true), replace: vi.fn(async () => true),
    back: vi.fn(), forward: vi.fn(), reload: vi.fn(), prefetch: vi.fn(async () => undefined), beforePopState: vi.fn(),
    events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } };
}

afterEach(() => { cleanup(); window.localStorage.clear(); });

describe("ProductPopover navigation event order", () => {
  // Unit tests use the installed next/link entry with a router spy; trusted App
  // Router clicks and document continuity are checked in the Browser acceptance.
  it.each([1, 0])("lets the link handle a click with detail=%s before closing", (detail) => {
    const navigation = router();
    const click = vi.fn(() => expect(screen.getByRole("link", { name: "target" })).toBeInTheDocument());
    render(<RouterContext.Provider value={navigation}>
      <ProductPopover label="switch" trigger="switch">
        <Link href="/work-review" prefetch={false} onClick={click}><span>target</span></Link>
      </ProductPopover>
    </RouterContext.Provider>);
    const trigger = screen.getByRole("button", { name: "switch" });
    fireEvent.click(trigger);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, detail });
    fireEvent(screen.getByText("target"), event);
    expect(click).toHaveBeenCalledOnce();
    expect(navigation.push).toHaveBeenCalledWith("/work-review", "/work-review", expect.objectContaining({ scroll: true }));
    expect(event.defaultPrevented).toBe(true);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "target" })).not.toBeInTheDocument();
  });

  it.each(["ctrlKey", "metaKey", "shiftKey", "altKey", "target"] as const)("preserves native %s navigation", (modifier) => {
    const navigation = router();
    render(<RouterContext.Provider value={navigation}>
      <ProductPopover label="switch" trigger="switch">
        <Link href="/work-review" prefetch={false} target={modifier === "target" ? "_blank" : undefined}>target</Link>
      </ProductPopover>
    </RouterContext.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "switch" }));
    const link = screen.getByRole("link", { name: "target" });
    let preventedByProduct: boolean | undefined;
    // Suppress jsdom's unimplemented document navigation only after product and
    // Next Link handlers have run, preserving their observed native decision.
    document.addEventListener("click", event => { preventedByProduct = event.defaultPrevented; event.preventDefault(); }, { once: true });
    fireEvent.click(link, modifier === "target" ? {} : { [modifier]: true });
    expect(preventedByProduct).toBe(false);
    expect(navigation.push).not.toHaveBeenCalled();
    expect(link).toHaveAttribute("href", "/work-review");
    expect(screen.getByRole("button", { name: "switch" })).toHaveAttribute("aria-expanded", "false");
  });

  it("leaves middle-button activation to the browser", () => {
    const navigation = router();
    render(<RouterContext.Provider value={navigation}>
      <ProductPopover label="switch" trigger="switch"><Link href="/work-review" prefetch={false}>target</Link></ProductPopover>
    </RouterContext.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "switch" }));
    const event = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    fireEvent(screen.getByRole("link", { name: "target" }), event);
    expect(event.defaultPrevented).toBe(false);
    expect(navigation.push).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "target" })).toHaveAttribute("href", "/work-review");
  });

  it("keeps a link's own cancellation and runs close-marked actions before unmounting", () => {
    const navigation = router();
    const action = vi.fn();
    render(<RouterContext.Provider value={navigation}>
      <ProductPopover label="switch" trigger="switch">
        <Link href="/work-review" prefetch={false} onClick={event => event.preventDefault()}>cancelled</Link>
        <button data-product-popover-close="true" onClick={action}>action</button>
      </ProductPopover>
    </RouterContext.Provider>);
    const trigger = screen.getByRole("button", { name: "switch" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("link", { name: "cancelled" }));
    expect(navigation.push).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "action" }));
    expect(action).toHaveBeenCalledOnce();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("preserves Escape focus restoration, outside dismissal and non-closing account actions", () => {
    const action = vi.fn();
    render(<ProductPopover label="account" trigger="account"><button onClick={action}>logout</button></ProductPopover>);
    const trigger = screen.getByRole("button", { name: "account" });
    fireEvent.click(trigger);
    const logout = screen.getByRole("button", { name: "logout" });
    logout.focus();
    fireEvent.click(logout);
    expect(action).toHaveBeenCalledOnce();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(logout, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it.each([
    ["约会陪伴", "/date-companion/a", "date_companion"],
    ["日常复盘", "/reflection", "daily_reflection"],
    ["工作复盘", "/work-review", "office_review"],
    ["学习整理", "/learning", "learning_organizer"]
  ])("keeps %s Link navigation and account-scoped preference together", (name, href, id) => {
    const navigation = router();
    window.localStorage.setItem(productPreferenceKey("another-account"), "date_companion");
    render(<RouterContext.Provider value={navigation}>
      <ProductSwitcher accountId="fixture-account" currentProduct="daily_reflection" workReviewEnabled />
    </RouterContext.Provider>);
    const trigger = screen.getByRole("button", { name: /切换产品/u });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("link", { name: new RegExp(name, "u") }));
    expect(navigation.push).toHaveBeenCalledWith(href, href, expect.any(Object));
    expect(window.localStorage.getItem(productPreferenceKey("fixture-account"))).toBe(id);
    expect(window.localStorage.getItem(productPreferenceKey("another-account"))).toBe("date_companion");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
