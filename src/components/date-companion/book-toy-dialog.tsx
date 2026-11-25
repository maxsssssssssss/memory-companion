"use client";

import { type ReactNode, useCallback, useLayoutEffect, useRef } from "react";
import { containBookModalScroll } from "./book-modal-scroll";
import styles from "./book-toy-dialog.module.css";

// Motion Prompt #049 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#049
// Paper adaptation: translate the whole readable paper; only its blank backing
// rotates. No text scaling, business delay, persistent play flag or focus trap.
const ease = "cubic-bezier(.23,1,.32,1)";
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function BookToyDialog({ busy, scope, trigger, triggerClassName, renderToy }: {
  busy: boolean; scope?: string; trigger: ReactNode; triggerClassName: string;
  renderToy: (close: () => void) => ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null), paper = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLSpanElement>(null), invoker = useRef<HTMLButtonElement>(null);
  const release = useRef<(() => void) | null>(null);
  const clips = useRef<Animation[]>([]), frame = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0), closing = useRef(false), lastPointer = useRef(false);
  const cancel = useCallback(() => {
    generation.current++;
    cancelAnimationFrame(frame.current); frame.current = 0;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    for (const clip of clips.current) clip.cancel();
    clips.current = [];
  }, []);
  const settle = useCallback(() => { if (!closing.current) cancel(); }, [cancel]);
  const closeNow = useCallback(() => {
    // Hide the native host before releasing an exit's transparent final frame.
    if (dialog.current?.open) dialog.current.close();
    cancel(); closing.current = false;
    release.current?.(); release.current = null;
  }, [cancel]);
  const play = (node: HTMLElement | null, frames: Keyframe[], duration: number, delay = 0) => {
    if (!node?.animate) return;
    clips.current.push(node.animate(frames, { duration, delay, easing: ease, fill: "both" }));
  };
  const dismiss = (detail: number) => {
    if (!dialog.current?.open) return;
    if (closing.current || !detail || reduced() || !paper.current?.animate) { closeNow(); return; }
    const from = getComputedStyle(paper.current), backing = back.current && getComputedStyle(back.current);
    const start = { transform: from.transform, opacity: from.opacity };
    const backStart = { transform: backing?.transform ?? "none", opacity: backing?.opacity ?? "1" };
    cancel(); closing.current = true;
    const owner = generation.current;
    play(paper.current, [start, { transform: "translateY(18px)", opacity: 0 }], 180);
    play(back.current, [backStart, { transform: "translate(4px, 16px) rotate(-.6deg)", opacity: 0 }], 160);
    timer.current = setTimeout(() => {
      if (owner !== generation.current || !closing.current) return;
      for (const clip of clips.current) { try { clip.finish(); } catch { /* close is bounded */ } }
      closeNow();
    }, 180);
  };
  const open = (detail: number) => {
    const host = dialog.current;
    if (!host || (host.open && !closing.current)) return;
    const wasClosing = closing.current;
    const from = wasClosing && paper.current ? getComputedStyle(paper.current) : null;
    const start = from ? { transform: from.transform, opacity: from.opacity } : { transform: "translateY(24px)", opacity: 1 };
    cancel(); closing.current = false; lastPointer.current = detail > 0;
    if (!host.open) {
      release.current?.(); release.current = containBookModalScroll(host);
      try { host.showModal(); } catch (error) { release.current(); release.current = null; throw error; }
    }
    if (!detail || reduced()) return;
    const owner = generation.current;
    frame.current = requestAnimationFrame(() => {
      if (owner !== generation.current || !host.open || closing.current || reduced()) return;
      play(paper.current, [start, { transform: "translateY(0)", opacity: 1 }], 300);
      play(back.current, [
        { transform: "translate(1px, 17px) rotate(-1.6deg)", opacity: .35 },
        { transform: "translate(4px, 5px) rotate(-.6deg)", opacity: 1 }
      ], 340, 45);
    });
  };
  useLayoutEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const preference = () => { if (media?.matches) { if (closing.current) closeNow(); else settle(); } };
    const leave = () => closeNow();
    media?.addEventListener?.("change", preference);
    window.addEventListener("pagehide", leave);
    return () => {
      media?.removeEventListener?.("change", preference);
      window.removeEventListener("pagehide", leave);
      closeNow();
    };
  }, [scope, closeNow, settle]);

  return <>
    <button ref={invoker} className={triggerClassName} type="button" aria-haspopup="dialog" disabled={busy}
      onClick={event => open(event.detail)}>{trigger}</button>
    <dialog className={styles.dialog} ref={dialog} aria-label="从玩偶选择录音" data-toy-dialog=""
      onClose={() => {
        if (dialog.current?.open) return; // An older queued close cannot cancel a newer open.
        cancel(); closing.current = false; release.current?.(); release.current = null;
        invoker.current?.focus({ preventScroll: true });
      }}
      onCancel={() => { cancel(); closing.current = false; }}>
      <span ref={back} className={styles.back} data-toy-paper="back" aria-hidden="true" />
      <div ref={paper} className={styles.paper} data-toy-paper="front"
        onKeyDownCapture={() => { lastPointer.current = false; settle(); }}
        onPointerDownCapture={event => {
          lastPointer.current = true;
          if (!(event.target instanceof Element && event.target.closest('[data-toy-dismiss]'))) settle();
        }} onWheelCapture={settle} onTouchMoveCapture={settle}
        onFocusCapture={event => { if (event.target.matches('input,textarea,[contenteditable=true]')) settle(); }}>
        <button type="button" className={styles.dismiss} aria-label="关闭连接玩偶" data-toy-dismiss="" autoFocus
          onClick={event => dismiss(event.detail)}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.45"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
        <div className={styles.scroll} data-toy-scroll="">
          {/* Receipt recovery starts when Home mounts, even with this dialog closed. */}
          {renderToy(() => dismiss(lastPointer.current ? 1 : 0))}
        </div>
      </div>
    </dialog>
  </>;
}
