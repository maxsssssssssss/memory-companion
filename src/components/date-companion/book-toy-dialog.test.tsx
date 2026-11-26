import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookToyDialog } from "./book-toy-dialog";

type Clip = { node: HTMLElement; frames: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn> };
let clips: Clip[], frames: Map<number, FrameRequestCallback>, frameId: number;
let media: EventTarget & { matches: boolean };
const release = vi.fn(), contain = vi.fn((_dialog: unknown) => release);
vi.mock("./book-modal-scroll", () => ({ containBookModalScroll: (dialog: unknown) => contain(dialog) }));
function Harness({ label = "真实录音列表", scope = "account:relationship" }: { label?: string; scope?: string }) {
  return <BookToyDialog scope={scope} busy={false} trigger="连接玩偶" triggerClassName="trigger"
    renderToy={close => <><p>{label}</p><input aria-label="可操作控件" /><button onClick={close}>带回录音</button></>} />;
}
const open = (detail = 1) => fireEvent.click(screen.getByRole("button", { name: "连接玩偶" }), { detail });
const close = (detail = 1) => fireEvent.click(screen.getByRole("button", { name: "关闭连接玩偶" }), { detail });
const host = () => document.querySelector("dialog")!;
const flush = () => act(() => { const work = [...frames.values()]; frames.clear(); work.forEach(fn => fn(16)); });
const preference = (matches: boolean) => act(() => { media.matches = matches; media.dispatchEvent(new Event("change")); });
const fronts = () => clips.filter(c => c.node.dataset.toyPaper === "front");
beforeEach(() => {
  vi.useFakeTimers(); clips = []; frames = new Map(); frameId = 0; release.mockClear(); contain.mockClear();
  media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { frames.set(++frameId, fn); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: vi.fn(function(this: HTMLDialogElement) { this.open = true; this.querySelector<HTMLElement>("[autofocus]")?.focus(); }) });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn(function(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event("close")); }) });
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: function(this: HTMLElement, keys: Keyframe[], options: KeyframeAnimationOptions) {
    const clip = { node: this, frames: keys, options, cancel: vi.fn(), finish: vi.fn() }; clips.push(clip); return clip;
  } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (HTMLElement.prototype as { animate?: unknown }).animate; delete (HTMLDialogElement.prototype as { showModal?: unknown }).showModal; delete (HTMLDialogElement.prototype as { close?: unknown }).close; });
describe("book toy paper operation", () => {
  it("mounts receipt recovery while the native dialog stays closed and the picker stays idle", () => {
    const recover = vi.fn();
    const pick = vi.fn();
    function ToyContent() {
      useEffect(() => { recover(); }, []);
      return <button type="button" onClick={pick}>选择录音文件夹</button>;
    }
    render(<BookToyDialog scope="account:relationship" busy={false} trigger="连接玩偶" triggerClassName="trigger"
      renderToy={() => <ToyContent />} />);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(host().open).toBe(false);
    expect(HTMLDialogElement.prototype.showModal).not.toHaveBeenCalled();
    expect(contain).not.toHaveBeenCalled();
    expect(pick).not.toHaveBeenCalled();

    open(0);
    expect(host().open).toBe(true);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(pick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button",{name:"选择录音文件夹"}));
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it("replays three opens on the same native host and does not replay for a data render", () => {
    const view = render(<StrictMode><Harness /></StrictMode>), native = host();
    for (let round = 0; round < 3; round++) {
      open(); flush();
      expect(fronts().filter(c => c.options.duration === 300)).toHaveLength(round + 1);
      view.rerender(<StrictMode><Harness label={"读取结果" + round} /></StrictMode>); flush();
      expect(fronts().filter(c => c.options.duration === 300)).toHaveLength(round + 1);
      close(); act(() => vi.advanceTimersByTime(180));
      expect(native.open).toBe(false); expect(host()).toBe(native);
      expect(screen.getByRole("button", { name: "连接玩偶" })).toHaveFocus();
    }
  });
  it("reads the current visual value when interrupted, holds exit fill and closes once", () => {
    render(<Harness />); open(); flush(); close();
    const exit = fronts().at(-1)!;
    expect(exit.options).toMatchObject({ duration: 180, fill: "both" });
    expect(exit.frames.at(-1)).toMatchObject({ opacity: 0 });
    act(() => vi.advanceTimersByTime(179)); expect(host().open).toBe(true); expect(exit.cancel).not.toHaveBeenCalled();
    close(); expect(host().open).toBe(false);
    act(() => vi.advanceTimersByTime(200)); expect(HTMLDialogElement.prototype.close).toHaveBeenCalledTimes(1);
  });
  it("a newer open invalidates an old close timer without remounting content", () => {
    render(<Harness />); open(); flush(); const input = screen.getByLabelText("可操作控件");
    fireEvent.change(input, { target: { value: "临时输入" } }); close();
    act(() => vi.advanceTimersByTime(35)); open(); flush();
    act(() => vi.advanceTimersByTime(250));
    expect(host().open).toBe(true); expect(screen.getByLabelText("可操作控件")).toBe(input); expect(input).toHaveValue("临时输入");
    expect(fronts().filter(c => c.options.duration === 300)).toHaveLength(2);
  });
  it("keyboard and reduced opening stay static only for that operation", () => {
    render(<Harness />); open(0); flush(); expect(clips).toHaveLength(0); close(0);
    preference(true); open(); flush(); expect(clips).toHaveLength(0); preference(false); flush(); expect(clips).toHaveLength(0);
    close(0); open(); flush(); expect(fronts()).toHaveLength(1);
  });
  it("runtime reduced motion settles entry and closes exit without replay on restore", () => {
    render(<Harness />); open(); flush(); preference(true);
    expect(fronts()[0].cancel).toHaveBeenCalled(); expect(host().open).toBe(true);
    preference(false); flush(); expect(fronts()).toHaveLength(1);
    close(); preference(true); expect(host().open).toBe(false);
    preference(false); open(); flush(); expect(fronts().filter(c => c.options.duration === 300)).toHaveLength(2);
    act(() => vi.advanceTimersByTime(250)); expect(host().open).toBe(true);
  });
  it("does not delay the selection callback or the native cancellation", () => {
    render(<Harness />); open(); flush(); fireEvent.click(screen.getByText("带回录音"), { detail: 1 });
    expect(host().open).toBe(true); act(() => vi.advanceTimersByTime(180)); expect(host().open).toBe(false);
    open(); flush(); const cancel = new Event("cancel", { cancelable: true });
    fireEvent(host(), cancel); expect(cancel.defaultPrevented).toBe(false);
    expect(clips.every(c => c.cancel.mock.calls.length > 0)).toBe(true);
  });
  it("cancels pending decoration and releases scroll containment on scope change and leave", () => {
    const view = render(<Harness />); open(); view.rerender(<Harness scope="another-account:another-relation" />); flush();
    expect(clips).toHaveLength(0); expect(host().open).toBe(false); expect(release).toHaveBeenCalled();
    open(); flush(); close(); view.unmount(); act(() => vi.advanceTimersByTime(250));
    expect(document.querySelector("dialog")).toBeNull();
  });
});
