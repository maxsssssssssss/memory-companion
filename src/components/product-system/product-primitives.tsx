"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef
} from "react";

import styles from "./product-system.module.css";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export function ProductState({
  action,
  description,
  title,
  tone = "status"
}: Readonly<{
  action?: ReactNode;
  description?: string;
  title: string;
  tone?: "status" | "loading" | "empty" | "error";
}>) {
  const role = tone === "error" ? "alert" : tone === "loading" ? "status" : undefined;
  return (
    <section className={styles.productState} data-tone={tone} role={role}>
      <span aria-hidden="true" className={styles.stateMark} />
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className={styles.stateAction}>{action}</div> : null}
    </section>
  );
}

export function ProductEvidence({
  children,
  label = "来源",
  meta
}: Readonly<{ children: ReactNode; label?: string; meta?: ReactNode }>) {
  return (
    <figure className={styles.evidence}>
      <figcaption><span>{label}</span>{meta ? <small>{meta}</small> : null}</figcaption>
      <blockquote>{children}</blockquote>
    </figure>
  );
}

export function ProductReviewCompletion({
  action,
  className,
  description,
  title
}: Readonly<{
  action: ReactNode;
  className?: string;
  description: ReactNode;
  title: ReactNode;
}>) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className={[styles.reviewCompletion, className].filter(Boolean).join(" ")}
    >
      <div>
        <h2 id={titleId}>{title}</h2>
        <p>{description}</p>
      </div>
      {action}
    </section>
  );
}

type TabItem = Readonly<{ id: string; label: string; panel: ReactNode }>;

export function ProductTabs({
  ariaLabel,
  items,
  onChange,
  value
}: Readonly<{
  ariaLabel: string;
  items: readonly TabItem[];
  onChange: (id: string) => void;
  value: string;
}>) {
  const baseId = useId();
  const moveFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % items.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    else return;
    event.preventDefault();
    onChange(items[nextIndex].id);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>("[role='tab']")[nextIndex]
      ?.focus();
  };
  const active = items.find((item) => item.id === value) ?? items[0];

  return (
    <div className={styles.tabs}>
      <div aria-label={ariaLabel} className={styles.tabList} role="tablist">
        {items.map((item, index) => {
          const selected = item.id === active.id;
          return (
            <button
              aria-controls={`${baseId}-${item.id}-panel`}
              aria-selected={selected}
              id={`${baseId}-${item.id}-tab`}
              key={item.id}
              onClick={() => onChange(item.id)}
              onKeyDown={(event) => moveFocus(event, index)}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >{item.label}</button>
          );
        })}
      </div>
      <div
        aria-labelledby={`${baseId}-${active.id}-tab`}
        className={styles.tabPanel}
        id={`${baseId}-${active.id}-panel`}
        role="tabpanel"
      >{active.panel}</div>
    </div>
  );
}

export function ProductDialog({
  children,
  footer,
  onClose,
  open,
  title
}: Readonly<{
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  open: boolean;
  title: string;
}>) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const panel = panelRef.current;
    const focusable = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (focusable ?? panel)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1) ?? first;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;
  return (
    <div
      className={styles.dialogBackdrop}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.dialog}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <h2 id={titleId}>{title}</h2>
          <button aria-label="关闭" onClick={onClose} type="button">×</button>
        </header>
        <div className={styles.dialogBody}>{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </div>
    </div>
  );
}
