import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreviewFixture } from "../prepare-preview/fixtures";
import type { PreviewAdapter, PreviewSnapshot } from "./model";
import { useNotebookHandoff, useNotebookReducedMotion } from "./notebook-handoff";

const bounds = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON() {} } as DOMRect);

describe("successful notebook paper handoff", () => {
  let snapshot: PreviewSnapshot;
  let adapter: PreviewAdapter;
  let source: HTMLElement, trigger: HTMLButtonElement, target: HTMLElement;
  let book: HTMLElement, left: HTMLDivElement, chat: HTMLDivElement;
  let animate: ReturnType<typeof vi.fn>, cancellations: Array<ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    snapshot = createPreviewFixture("three-candidates", "handoff-test", "relation-test");
    adapter = { getSnapshot: () => snapshot, getDiscussion: (id: string) => snapshot.discussions.find(value => value.id === id) ?? null } as PreviewAdapter;
    document.body.innerHTML = '<div><div class="prep-mobile-tabs"><button role="tab">留下的准备 · 0</button></div><main class="prep-book"><div class="left"></div><div class="chat"><div class="prep-candidate"><div class="prep-note-content">同条原文</div><button id="choice-item-candidate">留下这条</button></div></div></main></div>';
    book = document.querySelector("main")!; left = document.querySelector(".left")!; chat = document.querySelector(".chat")!;
    source = document.querySelector(".prep-candidate")!; trigger = source.querySelector("button")!;
    target = document.createElement("article"); target.id = "note-item-candidate";
    target.innerHTML = '<p class="prep-note-text">同条原文</p>';
    vi.spyOn(target.firstElementChild!, "getBoundingClientRect").mockReturnValue(bounds(180, 387, 400, 80));
    vi.spyOn(source.querySelector(".prep-note-content")!, "getBoundingClientRect").mockReturnValue(bounds(800, 380, 400, 100));
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue(bounds(800, 350, 400, 210));
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(bounds(160, 360, 440, 200));
    vi.spyOn(chat, "getBoundingClientRect").mockReturnValue(bounds(780, 280, 440, 500));
    vi.spyOn(left, "getBoundingClientRect").mockReturnValue(bounds(140, 280, 480, 500));
    vi.stubGlobal("innerWidth", 1440); vi.stubGlobal("innerHeight", 1000);
    cancellations = [];
    animate = vi.fn(() => {
      const cancel = vi.fn(); cancellations.push(cancel);
      return { cancel, finished: new Promise<void>(() => {}) } as unknown as Animation;
    });
    vi.stubGlobal("Animation", class {});
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  });
  afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (HTMLElement.prototype as Partial<HTMLElement>).animate; });

  function mount(disabled = false) {
    const refs = { book: { current: book }, left: { current: left }, chat: { current: chat } };
    return renderHook(({ reduced, blocked }) => useNotebookHandoff({ adapter, ...refs, disabled: reduced, blocked }), { initialProps: { reduced: disabled, blocked: false } });
  }
  function selected(id = "item-candidate") {
    snapshot.discussions[0].items.find(item => item.id === id)!.status = "selected";
    if (id === "item-candidate") { left.append(target); trigger.textContent = "已留下"; }
  }
  function systemPreference() {
    let reduced = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      get matches() { return reduced; }, media: "(prefers-reduced-motion: reduce)",
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    })));
    return (value: boolean, dispatch = true) => {
      reduced = value;
      if (dispatch) act(() => listeners.forEach(listener => listener()));
    };
  }

  it("requires a confirmed same-item success, then consumes duplicate callbacks once", () => {
    const { result } = mount();
    const ticket = result.current.prepare(snapshot.discussions[0].items[0], trigger, false);
    expect(result.current.suppressEntrance("item-candidate")).toBe(true);
    act(() => result.current.confirm(ticket));
    expect(animate).not.toHaveBeenCalled(); // still only suggested
    selected();
    act(() => result.current.confirm(ticket));
    const copy = document.querySelector(".prep-handoff-copy");
    expect(copy).toHaveAttribute("aria-hidden", "true");
    expect(copy).toHaveTextContent(snapshot.discussions[0].items[0].text);
    expect(source).toHaveAttribute("data-handoff", "cross");
    expect(target).toBeVisible();
    const count = animate.mock.calls.length;
    act(() => result.current.confirm(ticket));
    expect(animate).toHaveBeenCalledTimes(count);
    expect(document.querySelectorAll(".prep-handoff-copy")).toHaveLength(1);
  });

  it("does not animate a failed receipt; a fresh retry may succeed", () => {
    const { result } = mount();
    const item = snapshot.discussions[0].items[0];
    const failed = result.current.prepare(item, trigger, false);
    result.current.reject(failed);
    expect(animate).not.toHaveBeenCalled();
    const retry = result.current.prepare(item, trigger, false);
    selected(); act(() => result.current.confirm(retry));
    expect(source).toHaveAttribute("data-handoff", "cross");
  });

  it("lifts and straightens before crossing the real paper, then docks above its text", () => {
    const { result } = mount();
    const ticket = result.current.prepare(snapshot.discussions[0].items[0], trigger, false);
    selected(); act(() => result.current.confirm(ticket));
    const frames = animate.mock.calls[0][0] as Keyframe[];
    expect(frames[2]).toMatchObject({ transform: "translate(-192px,-44px) rotate(0deg)", offset: .4, opacity: .96 });
    expect(frames[3]).toMatchObject({ transform: "translate(-632px,-44px) rotate(0deg)", offset: .84, opacity: .96 });
    expect(animate.mock.calls[0][1]).toMatchObject({ duration: 420 });
    // 336 + 44px paper + 6px shadow = 386, before the real text at 387.
    expect(target).toBeVisible();
    expect(target.style.opacity).toBe("");
  });

  it("falls back locally when an adjacent note action occupies the landing corridor", () => {
    const adjacent = document.createElement("button"); left.append(adjacent);
    vi.spyOn(adjacent, "getBoundingClientRect").mockReturnValue(bounds(190, 322, 240, 44));
    const { result } = mount();
    const ticket = result.current.prepare(snapshot.discussions[0].items[0], trigger, false);
    selected(); act(() => result.current.confirm(ticket));
    expect(source).toHaveAttribute("data-handoff", "local");
    expect(document.querySelector(".prep-handoff-copy")).toBeNull();
    expect(target).toBeVisible();
  });

  it("does not restart a handoff from a stale button after the item is already selected", () => {
    const { result } = mount();
    const stale = { ...snapshot.discussions[0].items[0] };
    selected();
    expect(result.current.prepare(stale, trigger, false)).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });

  it.each(["offscreen", "mobile"])("uses local paper for %s and never changes a read point", mode => {
    if (mode === "mobile") vi.stubGlobal("innerWidth", 390);
    else vi.spyOn(target, "getBoundingClientRect").mockReturnValue(bounds(160, 900, 440, 200));
    chat.scrollTop = 140; left.scrollTop = 42;
    const { result } = mount();
    const ticket = result.current.prepare(snapshot.discussions[0].items[0], trigger, false);
    selected(); act(() => result.current.confirm(ticket));
    expect(document.querySelector(".prep-handoff-copy")).toBeNull();
    expect(source).toHaveAttribute("data-handoff", "local");
    expect(source.querySelector(".prep-handoff-local-paper")).toHaveAttribute("aria-hidden", "true");
    expect(chat.scrollTop).toBe(140); expect(left.scrollTop).toBe(42);
  });

  it.each(["keyboard", "reduce", "unsupported"])("keeps content and focus immediate for %s", mode => {
    const { result } = mount(mode === "reduce");
    if (mode === "unsupported") Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: undefined });
    trigger.focus();
    const ticket = result.current.prepare(snapshot.discussions[0].items[0], trigger, mode === "keyboard");
    selected();
    const replacement = trigger.cloneNode(true) as HTMLButtonElement;
    trigger.replaceWith(replacement);
    act(() => result.current.confirm(ticket));
    expect(animate).not.toHaveBeenCalled();
    expect(replacement).toHaveFocus(); expect(target).toBeVisible();
  });

  it("lets continued reading cancel a pending decorative receipt without cancelling selection", () => {
    const { result } = mount();
    const ticket = result.current.prepare(snapshot.discussions[0].items[0], trigger, false);
    fireEvent.wheel(chat);
    selected(); act(() => result.current.confirm(ticket));
    expect(animate).not.toHaveBeenCalled();
    expect(snapshot.discussions[0].items[0].status).toBe("selected");
    expect(target).toBeVisible();
  });

  it.each(["focus", "input"])("protects editing started through %s without pointer or keyboard events", mode => {
    const field = document.createElement("textarea"); document.body.append(field);
    const { result } = mount();
    if (mode === "input") field.focus();
    const ticket = result.current.prepare(snapshot.discussions[0].items[0], trigger, false);
    if (mode === "focus") field.focus();
    else fireEvent.input(field, { target: { value: "辅助技术输入中的草稿" } });
    selected(); act(() => result.current.confirm(ticket));
    expect(animate).not.toHaveBeenCalled(); expect(field).toHaveFocus();
    expect(snapshot.discussions[0].items[0].status).toBe("selected");
  });

  it("ends an already active paper when focus moves directly to the composer", () => {
    const field = document.createElement("textarea"); document.body.append(field);
    const { result } = mount();
    const ticket = result.current.prepare(snapshot.discussions[0].items[0], trigger, false);
    selected(); act(() => result.current.confirm(ticket));
    expect(document.querySelector(".prep-handoff-copy")).not.toBeNull();
    field.focus();
    expect(document.querySelector(".prep-handoff-copy")).toBeNull();
    expect(field).toHaveFocus(); expect(target).toBeVisible();
  });

  it("ignores queued pre-receipt scroll events but cancels an actually changed flight read point", () => {
    const { result } = mount();
    const ticket = result.current.prepare(snapshot.discussions[0].items[0], trigger, false);
    chat.scrollTop = 120; fireEvent.scroll(chat);
    selected(); act(() => result.current.confirm(ticket));
    expect(source).toHaveAttribute("data-handoff", "cross");
    fireEvent.scroll(chat); // same read point, queued from before success
    expect(document.querySelector(".prep-handoff-copy")).not.toBeNull();
    chat.scrollTop = 135; fireEvent.scroll(chat);
    expect(document.querySelector(".prep-handoff-copy")).toBeNull();
    expect(snapshot.discussions[0].items[0].status).toBe("selected");
  });

  it.each(["prepare", "receipt"])("reads the current system preference at %s even before React receives change", phase => {
    const reduce = systemPreference();
    const { result } = mount(false);
    if (phase === "prepare") reduce(true, false);
    const ticket = result.current.prepare(snapshot.discussions[0].items[0], trigger, false);
    if (phase === "receipt") reduce(true, false);
    selected(); act(() => result.current.confirm(ticket));
    expect(animate).not.toHaveBeenCalled();
    expect(target).toBeVisible();
  });

  it("immediately cancels an active paper on system preference change without a prop rerender", () => {
    const reduce = systemPreference();
    const { result } = mount(false);
    const ticket = result.current.prepare(snapshot.discussions[0].items[0], trigger, false);
    selected(); act(() => result.current.confirm(ticket));
    expect(source).toHaveAttribute("data-handoff", "cross");
    reduce(true);
    expect(document.querySelector(".prep-handoff-copy")).toBeNull();
    expect(cancellations.every(cancel => cancel.mock.calls.length)).toBe(true);
    const count = animate.mock.calls.length;
    reduce(false); expect(animate).toHaveBeenCalledTimes(count);
  });

  it("does not revive a pending paper if reduced motion was enabled then disabled before the receipt", () => {
    const reduce = systemPreference();
    const { result } = mount(false);
    const ticket = result.current.prepare(snapshot.discussions[0].items[0], trigger, false);
    reduce(true); reduce(false);
    selected(); act(() => result.current.confirm(ticket));
    expect(animate).not.toHaveBeenCalled(); expect(target).toBeVisible();
  });

  it("updates the mounted notebook preference in both directions", () => {
    const reduce = systemPreference();
    const { result } = renderHook(() => useNotebookReducedMotion());
    expect(result.current).toBe(false);
    reduce(true); expect(result.current).toBe(true);
    reduce(false); expect(result.current).toBe(false);
  });

  it.each(["account", "relationship", "discussion", "logout"])("rejects a late success after %s changes", scope => {
    const { result, rerender } = mount();
    const ticket = result.current.prepare(snapshot.discussions[0].items[0], trigger, false);
    selected();
    if (scope === "account") snapshot.accountId = "other-account";
    if (scope === "relationship") snapshot.relationshipId = "other-relation";
    if (scope === "discussion") snapshot.currentDiscussionId = "discussion-earlier";
    if (scope === "logout") snapshot.loggedOut = true;
    rerender({ reduced: false, blocked: false });
    act(() => result.current.confirm(ticket));
    expect(animate).not.toHaveBeenCalled();
  });

  it("cancels a flying copy on the next input, reduced preference, source opening, or unmount", () => {
    const { result, rerender, unmount } = mount();
    const start = (id: string) => {
      const item = snapshot.discussions[0].items.find(value => value.id === id)!;
      const ticket = result.current.prepare(item, trigger, false);
      selected(id); act(() => result.current.confirm(ticket));
    };
    start("item-candidate");
    fireEvent.keyDown(document, { key: "a" });
    expect(document.querySelector(".prep-handoff-copy")).toBeNull();
    expect(cancellations.every(cancel => cancel.mock.calls.length)).toBe(true);
    start("candidate-2");
    expect(source).toHaveAttribute("data-handoff", "local");
    rerender({ reduced: false, blocked: true });
    expect(source.querySelector(".prep-handoff-local-paper")).toBeNull();
    rerender({ reduced: false, blocked: false });
    start("candidate-3");
    rerender({ reduced: true, blocked: false });
    expect(source.querySelector(".prep-handoff-local-paper")).toBeNull();
    unmount(); expect(document.querySelector(".prep-handoff-copy")).toBeNull();
  });
});
