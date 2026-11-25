import { afterEach, describe, expect, it, vi } from "vitest";
import { containBookModalScroll } from "./book-modal-scroll";

const cleanups: (() => void)[] = [];
function modal(height = 200, contentHeight = 600) {
  const dialog = document.createElement("dialog");
  dialog.open = true;
  dialog.style.overflow = "auto";
  dialog.style.overflowY = "auto";
  Object.defineProperties(dialog, {
    clientHeight: { value: height }, scrollHeight: { value: contentHeight },
    clientWidth: { value: 300 }, scrollWidth: { value: 300 }
  });
  dialog.getBoundingClientRect = () => ({ left: 100, right: 400, top: 100, bottom: 300, width: 300, height: 200, x: 100, y: 100, toJSON() {} });
  document.body.append(dialog);
  const release = containBookModalScroll(dialog);
  cleanups.push(release, () => dialog.remove());
  return { dialog, release };
}
function wheel(target: HTMLElement, dy: number, x = 150, y = 150, extra: WheelEventInit = {}) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: dy, clientX: x, clientY: y, ...extra });
  target.dispatchEvent(event);
  return event;
}
function finger(target: HTMLElement, name: string, x: number, y: number, points = 1) {
  const event = new Event(name, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: Array.from({ length: points }, (_, identifier) => ({ identifier, clientX: x, clientY: y })) });
  target.dispatchEvent(event);
  return event;
}
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); });

describe("book native modal scroll isolation", () => {
  it("blocks backdrop gestures even though their target is the dialog", () => {
    const { dialog } = modal();
    expect(wheel(dialog, 100, 25, 25).defaultPrevented).toBe(true);
    expect(dialog.scrollTop).toBe(0);
  });
  it("keeps native wheel scrolling when the modal can consume the full gesture", () => {
    const { dialog } = modal();
    expect(wheel(dialog, 100).defaultPrevented).toBe(false);
  });
  it("consumes a partial bottom gesture locally and never passes the remainder to the page", () => {
    const { dialog } = modal(); dialog.scrollTop = 370;
    expect(wheel(dialog, 80).defaultPrevented).toBe(true);
    expect(dialog.scrollTop).toBe(400);
    expect(wheel(dialog, 80).defaultPrevented).toBe(true);
    expect(dialog.scrollTop).toBe(400);
  });
  it("contains top and non-overflowing modal boundaries", () => {
    const { dialog } = modal(200, 200);
    expect(wheel(dialog, -80).defaultPrevented).toBe(true);
    expect(wheel(dialog, 80).defaultPrevented).toBe(true);
  });
  it("leaves root styles and width-related inline declarations untouched", () => {
    const before = [document.body.getAttribute("style"), document.documentElement.getAttribute("style")];
    const { dialog, release } = modal(); wheel(dialog, 200, 5, 5); release();
    expect([document.body.getAttribute("style"), document.documentElement.getAttribute("style")]).toEqual(before);
  });
  it("does not unlock another independently registered modal", () => {
    const first = modal(), second = modal(); first.release(); first.release();
    expect(wheel(second.dialog, 100, 25, 25).defaultPrevented).toBe(true);
    second.release();
    expect(wheel(second.dialog, 100, 25, 25).defaultPrevented).toBe(false);
  });
  it("releases on native close, but ignores a queued close after rapid reopen", () => {
    const { dialog } = modal();
    dialog.dispatchEvent(new Event("close"));
    expect(wheel(dialog, 80, 25, 25).defaultPrevented).toBe(true);
    dialog.open = false; dialog.dispatchEvent(new Event("close"));
    expect(wheel(dialog, 80, 25, 25).defaultPrevented).toBe(false);
  });
  it("does not lock a removed route or leave guards after cleanup", () => {
    const { dialog, release } = modal(); dialog.remove();
    expect(wheel(document.body, 100, 25, 25).defaultPrevented).toBe(false);
    release();
    expect(wheel(document.body, 100).defaultPrevented).toBe(false);
  });
  it("contains touch overshoot while preserving ordinary inside pan", () => {
    const { dialog } = modal();
    finger(dialog, "touchstart", 150, 220);
    expect(finger(dialog, "touchmove", 150, 180).defaultPrevented).toBe(false);
    dialog.scrollTop = 390;
    expect(finger(dialog, "touchmove", 150, 150).defaultPrevented).toBe(true);
    expect(dialog.scrollTop).toBe(400);
  });
  it("preserves native vertical momentum with minor horizontal finger or trackpad drift", () => {
    const { dialog } = modal(); dialog.scrollTop = 100;
    finger(dialog, "touchstart", 150, 220);
    expect(finger(dialog, "touchmove", 148, 180).defaultPrevented).toBe(false);
    expect(wheel(dialog, 40, 150, 150, { deltaX: 2 }).defaultPrevented).toBe(false);
    expect(dialog.scrollTop).toBe(100); // No manual substitute for the native pan.
    dialog.scrollTop = 400;
    expect(wheel(dialog, 40, 150, 150, { deltaX: 2 }).defaultPrevented).toBe(true);
  });
  it("blocks backdrop touch but keeps multi-touch zoom independent", () => {
    const { dialog } = modal();
    finger(dialog, "touchstart", 20, 220);
    expect(finger(dialog, "touchmove", 20, 180).defaultPrevented).toBe(true);
    finger(dialog, "touchstart", 150, 220, 2);
    expect(finger(dialog, "touchmove", 150, 180, 2).defaultPrevented).toBe(false);
    expect(wheel(dialog, 100, 20, 20, { ctrlKey: true }).defaultPrevented).toBe(false);
  });
  it("routes page navigation keys inside, leaving Escape, Tab and button activation native", () => {
    const { dialog } = modal();
    const button = document.createElement("button"); dialog.append(button);
    const key = (name: string) => { const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: name }); button.dispatchEvent(event); return event; };
    expect(key("PageDown").defaultPrevented).toBe(true);
    expect(dialog.scrollTop).toBe(180);
    expect(key("End").defaultPrevented).toBe(true);
    expect(dialog.scrollTop).toBe(400);
    for (const name of ["Escape", "Tab", " "]) expect(key(name).defaultPrevented).toBe(false);
  });
  it("never intercepts text editing navigation", () => {
    const { dialog } = modal(); const input = document.createElement("textarea"); dialog.append(input);
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Home" }); input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
  it("restores unexpected root scrolling only while a modal is active", () => {
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const { release } = modal(); vi.spyOn(window, "scrollY", "get").mockReturnValue(40);
    window.dispatchEvent(new Event("scroll")); expect(scroll).toHaveBeenCalledWith({ left: 0, top: 0, behavior: "instant" });
    scroll.mockClear(); release(); window.dispatchEvent(new Event("scroll")); expect(scroll).not.toHaveBeenCalled();
  });
});
