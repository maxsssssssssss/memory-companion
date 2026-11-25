"use client";

import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from "react";

export function ProductPopover({
  children,
  className,
  label,
  panelClassName,
  paperMotion = false,
  trigger,
  triggerClassName
}: Readonly<{
  children: ReactNode;
  className?: string;
  label: string;
  panelClassName?: string;
  paperMotion?: boolean;
  trigger: ReactNode;
  triggerClassName?: string;
}>) {
  const [open, setOpen] = useState(false);
  const [present, setPresent] = useState(false);
  const [operation, setOperation] = useState(0);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wanted = useRef(false);
  const running = useRef<Animation | null>(null);
  const serial = useRef(0);
  const pending = useRef<{ id: number; open: boolean; animate: boolean; from?: Keyframe } | null>(null);

  const cancel = useCallback(() => {
    running.current?.cancel();
    running.current = null;
  }, []);
  const change = useCallback((next: boolean, detail = 1) => {
    if (next === wanted.current) return;
    const node = panelRef.current;
    const style = node && getComputedStyle(node);
    const from = style ? { transform: style.transform, opacity: style.opacity } : undefined;
    cancel();
    wanted.current = next;
    const animate = paperMotion && !!detail
      && !(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
    pending.current = { id: ++serial.current, open: next, animate, from };
    setOpen(next);
    setPresent(next || animate && !!node);
    setOperation(serial.current);
  }, [cancel, paperMotion]);

  // Motion Prompt #053 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#053
  // Adaptation: a whole paper slip, -12px/210ms in and -8px/140ms out.
  // Each toggle owns its exit; stale completion can never remove a reopened menu.
  useLayoutEffect(() => {
    const intent = pending.current, node = panelRef.current;
    if (!intent || intent.id !== operation) return;
    pending.current = null;
    if (!node || !intent.animate || !node.animate) {
      if (!intent.open) setPresent(false);
      return;
    }
    const animation = node.animate([
      intent.from ?? { transform: "translateY(-12px)", opacity: 0 },
      intent.open ? { transform: "translateY(0)", opacity: 1 }
        : { transform: "translateY(-8px)", opacity: 0 },
    ], { duration: intent.open ? 210 : 140, easing: "cubic-bezier(.23,1,.32,1)", fill: "both" });
    running.current = animation;
    void animation.finished.then(() => {
      if (intent.id !== serial.current || running.current !== animation) return;
      if (wanted.current) cancel();
      else setPresent(false); // Hold the exit fill until React actually removes the paper.
    }).catch(() => {});
  }, [operation, cancel]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const settle = () => {
      if (!media?.matches) return;
      serial.current++;
      pending.current = null;
      cancel();
      setPresent(wanted.current);
    };
    media?.addEventListener("change", settle);
    return () => {
      serial.current++;
      pending.current = null;
      cancel();
      media?.removeEventListener("change", settle);
    };
  }, [cancel]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        change(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      change(false, 0);
      triggerRef.current?.focus({ preventScroll: true });
    };
    const restoreHistory = () => { if (paperMotion) change(false, 0); };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("popstate", restoreHistory);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("popstate", restoreHistory);
    };
  }, [open, change, paperMotion]);

  const handlePanelClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest("a[href], [data-product-popover-close='true']")) {
      change(false, event.detail);
    }
  };

  return (
    <div className={className} ref={rootRef} onBlur={event => {
      if (paperMotion && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) change(false, 0);
    }}>
      <button
        aria-controls={panelId}
        aria-expanded={open}
        aria-label={label}
        className={triggerClassName}
        onClick={event => change(!wanted.current, event.detail)}
        ref={triggerRef}
        type="button"
      >
        {trigger}
      </button>
      {present ? (
        // Let the link handle navigation before closing and unmounting its panel.
        <div className={panelClassName} id={panelId} onClick={handlePanelClick}
          ref={panelRef} data-paper-menu={paperMotion ? (open ? "open" : "exiting") : undefined}
          aria-hidden={!open || undefined} inert={!open || undefined}
          onKeyDown={() => { if (open) cancel(); }}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
