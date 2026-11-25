"use client";

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import styles from "./paper-state-motion.module.css";

// Motion Prompt #080 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#080
// Motion Prompt #160 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#160
// Motion Prompt #057 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#057
// Motion Prompt #061 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#061
// Adaptation: operation-owned ink only. Text, business state and focus never wait.
const easing = "cubic-bezier(.23,1,.32,1)";
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function PaperFeedbackMarks() {
  return <span className={styles.feedback} aria-hidden="true">
    <span className={styles.edge} data-paper-feedback-edge="" />
    <span className={styles.mark} data-paper-feedback-ink="" />
  </span>;
}

/** UI receipts only: callers retain authority over save/apply/selection success. */
export function usePaperFeedback(scope: string) {
  const receipts = useRef(new Set<string>());
  const running = useRef<Animation[]>([]);
  const frame = useRef(0);
  const generation = useRef(0);
  const active = useRef<string | null>(null);
  const cancel = useCallback(() => {
    generation.current++;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    running.current.forEach(animation => animation.cancel());
    running.current = [];
  }, []);
  useLayoutEffect(() => {
    active.current = scope;
    receipts.current.clear();
    cancel();
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const change = () => { if (media?.matches) cancel(); };
    media?.addEventListener("change", change);
    window.addEventListener("popstate", cancel);
    return () => {
      active.current = null;
      cancel();
      media?.removeEventListener("change", change);
      window.removeEventListener("popstate", cancel);
    };
  }, [scope, cancel]);
  const confirm = useCallback(({ id, target, detail, kind }: {
    id: string; target: () => HTMLElement | null; detail: number;
    kind: "saved" | "applied" | "selection";
  }) => {
    if (active.current !== scope) return false;
    if (receipts.current.has(id)) return false;
    receipts.current.add(id);
    cancel();
    if (!detail || reduced()) return true;
    const owner = generation.current;
    frame.current = requestAnimationFrame(() => {
      if (owner !== generation.current || reduced()) return;
      const node = target();
      if (!node?.isConnected) return;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight) return;
      const edge = node.querySelector<HTMLElement>("[data-paper-feedback-edge]");
      const ink = node.querySelector<HTMLElement>("[data-paper-feedback-ink]");
      const duration = kind === "selection" ? 200 : 240;
      if (edge?.animate) running.current.push(edge.animate([
        { transform: "translateY(5px)", opacity: 0 },
        { transform: "translateY(1px)", opacity: .85, offset: .35 },
        { transform: "translateY(0)", opacity: 0 },
      ], { duration, easing }));
      if (ink?.animate) running.current.push(ink.animate([
        { transform: "scaleX(.08)", opacity: .85 },
        { transform: "scaleX(1)", opacity: .8, offset: .72 },
        { transform: "scaleX(1)", opacity: 0 },
      ], { duration, easing }));
    });
    return true;
  }, [cancel, scope]);
  return { confirm, cancel };
}

export function PaperChoiceInk({ inkRef }: { inkRef: RefObject<HTMLSpanElement | null> }) {
  return <span ref={inkRef} className={styles.choice} data-paper-choice-ink="" aria-hidden="true" />;
}

/** One moving mark shared by a control group; the existing selected value is authoritative. */
export function usePaperChoiceMotion({ container, value, scope }: {
  container: RefObject<HTMLElement | null>; value: string; scope: string;
}) {
  const ink = useRef<HTMLSpanElement>(null);
  const running = useRef<Animation | null>(null);
  const pending = useRef<{ value: string; detail: number } | null>(null);
  const previous = useRef({ value, scope });
  const current = useRef(value);
  current.current = value;
  const [intent, setIntent] = useState(0);
  const cancel = useCallback(() => { running.current?.cancel(); running.current = null; }, []);
  const place = useCallback((animate: boolean) => {
    const host = container.current, mark = ink.current;
    const target = host && Array.from(host.querySelectorAll<HTMLElement>("[data-paper-choice-value]"))
      .find(node => node.dataset.paperChoiceValue === current.current);
    if (!host || !mark || !target) return;
    // Read the interrupted visual before cancelling; reverse from here, not an old endpoint.
    const before = mark.getBoundingClientRect(), box = target.getBoundingClientRect(), root = host.getBoundingClientRect();
    const visible = box.width > 0 && box.height > 0;
    const wasVisible = mark.style.visibility === "visible" && before.width > 0;
    cancel();
    mark.style.visibility = visible ? "visible" : "hidden";
    mark.style.left = `${box.left - root.left + host.scrollLeft - host.clientLeft}px`;
    mark.style.top = `${box.bottom - root.top + host.scrollTop - host.clientTop - 4}px`;
    mark.style.width = `${box.width}px`;
    if (!animate || !visible || !wasVisible || reduced() || !mark.animate) return;
    running.current = mark.animate([
      { transform: `translate(${before.left - box.left}px,${before.top - (box.bottom - 4)}px) scaleX(${before.width / box.width})` },
      { transform: "translate(0,0) scaleX(1)" },
    ], { duration: 220, easing });
  }, [container, cancel]);
  useLayoutEffect(() => {
    const restoredScope = previous.current.scope !== scope;
    const selectedChanged = previous.current.value !== value;
    if (restoredScope) pending.current = null;
    const operation = pending.current;
    const matches = operation?.value === value;
    if (matches || selectedChanged || restoredScope) {
      pending.current = null;
      place(!restoredScope && !!matches && !!operation?.detail);
    } else if (!operation) place(false);
    previous.current = { value, scope };
  }, [intent, value, scope, place]);
  useLayoutEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const settle = () => { pending.current = null; cancel(); };
    const change = () => { if (media?.matches) settle(); };
    const resize = () => place(false);
    media?.addEventListener("change", change);
    window.addEventListener("popstate", settle);
    window.addEventListener("resize", resize);
    let lastSize = "";
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      const size = rect ? `${rect.width}:${rect.height}` : "";
      if (lastSize && size !== lastSize) place(false);
      lastSize = size;
    });
    if (container.current) observer?.observe(container.current);
    return () => {
      settle(); observer?.disconnect();
      media?.removeEventListener("change", change);
      window.removeEventListener("popstate", settle);
      window.removeEventListener("resize", resize);
    };
  }, [container, cancel, place]);
  const choose = useCallback((next: string, detail: number) => {
    if (next === (pending.current?.value ?? current.current)) return false;
    pending.current = { value: next, detail };
    setIntent(serial => serial + 1);
    return true;
  }, []);
  return { ink, choose };
}
