import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductPopover } from "./product-popover";

let reduced = false;
let changes: Set<() => void>;
let animations: { finish: () => void; cancel: ReturnType<typeof vi.fn>; options: KeyframeAnimationOptions; keys: Keyframe[] }[];
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
beforeEach(() => {
  reduced = false; changes = new Set(); animations = [];
  vi.stubGlobal("matchMedia", () => ({ get matches() { return reduced; },
    addEventListener: (_: string, fn: () => void) => changes.add(fn),
    removeEventListener: (_: string, fn: () => void) => changes.delete(fn) }));
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: vi.fn((keys, options) => {
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const cancel = vi.fn();
    animations.push({ finish, cancel, keys: keys as Keyframe[], options: options as KeyframeAnimationOptions });
    return { finished, cancel } as unknown as Animation;
  }) });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalAnimate) Object.defineProperty(Element.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(Element.prototype, "animate");
});
const fixture = (paperMotion = true) => render(<ProductPopover label="paper" trigger="paper" paperMotion={paperMotion}>
  <a href="/target">destination</a><button>account action</button>
</ProductPopover>);
const trigger = () => screen.getByRole("button", { name: "paper" });
const click = (detail = 1) => fireEvent.click(trigger(), { detail });
const finish = async (index: number) => act(async () => { animations[index].finish(); await Promise.resolve(); });

describe("paper menu operation ownership", () => {
  it("replays all three opens, retains inert exit paper, and does not replay a render", async () => {
    const view = fixture();
    for (let i = 0; i < 3; i++) {
      click(); expect(animations).toHaveLength(i * 2 + 1);
      expect(screen.getByRole("link")).toBeVisible();
      await finish(i * 2);
      view.rerender(<ProductPopover label="paper" trigger="paper" paperMotion><a href="/target">destination</a><button>account action</button></ProductPopover>);
      expect(animations).toHaveLength(i * 2 + 1);
      click(); expect(document.querySelector('[data-paper-menu="exiting"]')).toHaveAttribute("inert");
      expect(screen.queryByRole("link")).toBeNull();
      await finish(i * 2 + 1);
      expect(document.querySelector("[data-paper-menu]")).toBeNull();
    }
  });
  it("cancels interrupted exit and ignores its late completion after reopen", async () => {
    fixture(); click(); click(); click();
    expect(animations).toHaveLength(3);
    expect(animations[0].cancel).toHaveBeenCalled();
    expect(animations[1].cancel).toHaveBeenCalled();
    await finish(1); await finish(0);
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link")).toBeVisible();
    await finish(2); expect(screen.getByRole("link")).toBeVisible();
  });
  it("keyboard and reduced operations do not consume a future pointer open", () => {
    fixture(); click(0); expect(animations).toHaveLength(0);
    fireEvent.keyDown(screen.getByRole("link"), { key: "Escape" });
    expect(trigger()).toHaveFocus();
    reduced = true; click(); click(); expect(animations).toHaveLength(0);
    reduced = false; click(); expect(animations).toHaveLength(1);
  });
  it("runtime reduction settles immediately without replay when preference returns", async () => {
    fixture(); click();
    act(() => { reduced = true; changes.forEach(fn => fn()); });
    expect(animations[0].cancel).toHaveBeenCalled();
    expect(screen.getByRole("link")).toBeVisible();
    act(() => { reduced = false; changes.forEach(fn => fn()); });
    expect(animations).toHaveLength(1);
    click();
    act(() => { reduced = true; changes.forEach(fn => fn()); });
    expect(document.querySelector("[data-paper-menu]")).toBeNull();
    await finish(1); reduced = false; click(); expect(animations).toHaveLength(3);
  });
  it("does not animate other product editions and cancels on unmount", () => {
    const other = fixture(false); click(); click(); expect(animations).toHaveLength(0); other.unmount();
    const paper = fixture(); click(); paper.unmount(); expect(animations[0].cancel).toHaveBeenCalled();
  });
  it("closes statically for history restoration and lets Tab leave without a trap", () => {
    fixture(); click(); fireEvent.popState(window);
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(animations).toHaveLength(1);
    click();
    const outside = document.createElement("button"); document.body.append(outside);
    fireEvent.blur(screen.getByRole("link"), { relatedTarget: outside });
    expect(trigger()).toHaveAttribute("aria-expanded", "false"); outside.remove();
  });
});
