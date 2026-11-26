"use client";

import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

// Motion Prompt #162 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#162
// Motion Prompt #049 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#049
// Motion Prompt #137 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#137
// Motion Prompt #080 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#080
// Reading adaptation: real text never scales or blurs. One explicit operation
// owns the decoration; native dialogs and each reader keep their own state.
export type SourcePaperEntry = { pointer: boolean; trigger?: HTMLElement };
export function sourcePaperEntry(trigger?: HTMLElement, detail = 0): SourcePaperEntry {
  return { pointer: detail > 0, trigger };
}
const ease = "cubic-bezier(.23,1,.32,1)";
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function useSourcePaperMotion({ paper, edge, active, entry, edgeOnly = false }: {
  paper: RefObject<HTMLElement | null>; edge: RefObject<HTMLElement | null>;
  active: boolean; entry?: SourcePaperEntry | null; edgeOnly?: boolean;
}) {
  const animations = useRef<Animation[]>([]);
  const frame = useRef(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closing = useRef<(() => void) | null>(null);
  const generation = useRef(0);
  const played = useRef<SourcePaperEntry | null>(null);
  const current = useRef({ active, entry, edgeOnly });
  current.current = { active, entry, edgeOnly };

  const cancel = useCallback(() => {
    generation.current++;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    closing.current = null;
    for (const animation of animations.current) animation.cancel();
    animations.current = [];
  }, []);
  const play = useCallback((node: HTMLElement | null, frames: Keyframe[], duration: number, fill: FillMode = "none") => {
    if (!node?.animate) return;
    const animation = node.animate(frames, { duration, easing: ease, fill });
    animations.current.push(animation);
    return animation;
  }, []);
  const settle = useCallback(() => cancel(), [cancel]);
  const layer = useCallback((direction: 1 | -1, detail: number) => {
    cancel();
    if (!current.current.active || detail === 0 || reduced()) return;
    play(edge.current, [
      { transform: `translateX(${direction * 18}px)`, opacity: .8 },
      { transform: "translateX(0)", opacity: 0 }
    ], 240);
    const owner = generation.current;
    frame.current = requestAnimationFrame(() => {
      if (owner !== generation.current) return;
      const target = paper.current?.querySelector<HTMLElement>('[data-segment-id][aria-current="true"], [data-highlight="true"]');
      if (target && direction > 0) {
        // The existing full-strength highlight is already present. This tint
        // settles over it; it never controls visibility, focus or location.
        play(target, [{ backgroundColor: "#e5c6b2" }, { backgroundColor: getComputedStyle(target).backgroundColor }], 240);
      }
    });
  }, [cancel, edge, paper, play]);
  const dismiss = useCallback((close: () => void, detail: number) => {
    if (closing.current) { closing.current(); return; }
    const node = paper.current;
    const from = node ? getComputedStyle(node).transform : "none";
    cancel();
    if (!current.current.active || detail === 0 || reduced() || !node?.animate) { close(); return; }
    const owner = generation.current;
    const animation = play(node, [{ transform: from, opacity: 1 }, { transform: "translateY(18px)", opacity: 0 }], 180, "forwards");
    let requested = false;
    const requestCloseOnce = () => {
      if (owner !== generation.current || requested) return;
      requested = true;
      if (closeTimer.current) clearTimeout(closeTimer.current);
      closeTimer.current = null;
      // The native host may await a React commit or history traversal. Keep
      // its last transparent frame until actual cleanup or the next entry.
      // Finishing also makes repeated close / runtime reduce settle at once.
      try { animation?.finish?.(); } catch { /* Closing never waits on WAAPI. */ }
      close();
    };
    closing.current = requestCloseOnce;
    // A bounded UI exit, independent of animationend/finished and business data.
    // A new open, navigation, reduced-motion change or unmount invalidates it.
    closeTimer.current = setTimeout(requestCloseOnce, 180);
  }, [cancel, paper, play]);

  useLayoutEffect(() => {
    if (!active) { cancel(); return; }
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const stop = () => {
      if (!media?.matches) return;
      const finish = closing.current;
      if (finish) finish();
      else cancel();
    };
    const key = () => { if (!closing.current) settle(); };
    const read = () => { if (!closing.current) settle(); };
    const pointer = (event: Event) => {
      const target=event.target instanceof HTMLElement?event.target:null;
      if(target?.closest('button,a[href]'))return;
      if(!closing.current)settle();
    };
    const focus = (event: Event) => {
      const target=event.target instanceof HTMLElement?event.target:null;
      if(target?.matches('input,textarea,[contenteditable=true]'))read();
    };
    media?.addEventListener?.("change", stop);
    paper.current?.addEventListener("keydown", key, true);
    paper.current?.addEventListener("wheel", read, { passive: true });
    paper.current?.addEventListener("pointerdown", pointer, true);
    paper.current?.addEventListener("touchmove", read, { passive: true });
    paper.current?.addEventListener("focusin", focus);
    const node = paper.current;
    return () => {
      media?.removeEventListener?.("change", stop);
      node?.removeEventListener("keydown", key, true);
      node?.removeEventListener("wheel", read);
      node?.removeEventListener("pointerdown", pointer, true);
      node?.removeEventListener("touchmove", read);
      node?.removeEventListener("focusin", focus);
      cancel();
    };
  }, [active, cancel, paper, settle]);

  useLayoutEffect(() => {
    if (!active || !entry || played.current === entry) return;
    cancel();
    // StrictMode can cancel this scheduled decoration without consuming it.
    frame.current = requestAnimationFrame(() => {
      played.current = entry;
      if (!entry.pointer || reduced() || !paper.current?.animate) return;
      const node = paper.current;
      const rect = node.getBoundingClientRect();
      const origin = entry.trigger?.getBoundingClientRect();
      const visible = origin && origin.bottom > 0 && origin.top < innerHeight && origin.right > 0 && origin.left < innerWidth;
      const x = visible ? Math.max(-14, Math.min(14, (origin.left + origin.width / 2 - rect.left - rect.width / 2) * .06)) : 0;
      if (!edgeOnly) play(node, [
        { transform: `translate(${x}px, 28px)`, opacity: 1 },
        { transform: "translate(0, 0)", opacity: 1 }
      ], 300);
      play(edge.current, [
        { transform: `translate(${edgeOnly ? 18 : 6}px, ${edgeOnly ? 0 : 8}px)`, opacity: .85 },
        { transform: "translate(0, 0)", opacity: 0 }
      ], 300);
    });
    return () => cancelAnimationFrame(frame.current);
  }, [active, entry, edgeOnly, paper, edge, cancel, play]);

  return { settle, layer, dismiss };
}
