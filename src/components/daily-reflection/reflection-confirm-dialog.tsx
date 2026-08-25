"use client";

import { type ReactNode, useEffect, useRef } from "react";

import styles from "./daily-reflection.module.css";

type ReflectionConfirmDialogProps = Readonly<{
  busy?: boolean;
  busyLabel?: string;
  cancelLabel?: string;
  children: ReactNode;
  confirmLabel: string;
  onCancel(): void;
  onConfirm(): void;
  open: boolean;
  role?: "dialog" | "alertdialog";
  title: string;
}>;

export function ReflectionConfirmDialog({
  busy = false,
  busyLabel = "正在处理…",
  cancelLabel = "取消",
  children,
  confirmLabel,
  onCancel,
  onConfirm,
  open,
  role = "dialog",
  title
}: ReflectionConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(busy);
  const onCancelRef = useRef(onCancel);
  busyRef.current = busy;
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])"
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
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
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className={styles.dialogBackdrop} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <div aria-labelledby="reflection-confirm-title" aria-modal="true" className={styles.confirmDialog} ref={dialogRef} role={role}>
        <h2 id="reflection-confirm-title">{title}</h2>
        <div className={styles.confirmDialogCopy}>{children}</div>
        <div className={styles.confirmDialogActions}>
          <button className={styles.textButton} disabled={busy} onClick={onCancel} type="button">{cancelLabel}</button>
          <button className={styles.dangerButton} disabled={busy} onClick={onConfirm} ref={confirmRef} type="button">
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
