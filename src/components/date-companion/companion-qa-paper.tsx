"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DayPayload } from "@/lib/domain/day-payload";
import type { DcInteractionRead } from "@/lib/domain/date-companion-stage2";
import type { QaState, SourceRefVM } from "@/lib/domain/date-companion";
import type { QuestionAnswer } from "@/lib/domain/types";
import type { DateCompanionQaMode } from "@/lib/client/date-companion-session";
import { containBookModalScroll } from "./book-modal-scroll";
import { QaPaperConversation } from "./companion-qa-paper-conversation";
import type { QaSourceSpeakerLabel } from "./companion-qa-paper-sources";
import bookStyles from "./book-panels.module.css";
import styles from "./date-companion.module.css";
import "./companion-qa-paper.css";

export type QaPaperProps = {
  mode: DateCompanionQaMode;
  title: string;
  scopeKey: string | null;
  disabledMessage?: string;
  disabledAction?: ReactNode;
  onRetryRead?: () => void;
  checkCatalog?: (signal: AbortSignal) => Promise<void>;
  verifying: boolean;
  enabled: boolean;
  openFromLink?: boolean;
  answers: QuestionAnswer[];
  withheldCount?: number;
  qaState: QaState;
  suggestedQuestions: readonly string[];
  sources: readonly SourceRefVM[];
  recordingId?: string;
  recordingRevision?: object;
  recordingReview?: DcInteractionRead;
  sourceDay: (uploadId: string) => DayPayload | null;
  sourceSpeakerLabel: QaSourceSpeakerLabel;
  onActivate: () => void;
  onCancel: () => void;
  onAsk: (question: string) => Promise<QuestionAnswer | null>;
};

export function CompanionQaPaper(props: QaPaperProps) {
  const recording = props.mode === "current-interaction";
  const label = recording ? "问问这次相处" : "问问 Ta";
  const id = useId();
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  const [exited, setExited] = useState(false);
  useEffect(() => {
    const check = props.checkCatalog;
    if (!open || !check) return;
    const controller = new AbortController();
    let reading = false;
    const refresh = async () => {
      if (reading || document.visibilityState === "hidden") return;
      reading = true;
      try { await check(controller.signal); } finally { reading = false; }
    };
    // Other devices and direct API writes do not emit this tab's withdrawal notification.
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [open, props.checkCatalog]);
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const maskDown = useRef(false);
  const staticAction = useRef(false);
  const release = useRef<(() => void) | null>(null);
  const back = useRef<(() => boolean) | null>(null);
  const request = useRef({ active: false, cancel: props.onCancel });
  request.current = { active: props.qaState.status === "streaming", cancel: props.onCancel };

  function toggle(next: boolean, keyboard: boolean) {
    staticAction.current = keyboard;
    if (next) {
      props.onActivate();
      setExited(false);
      setVisited(true);
    } else if (request.current.active) request.current.cancel();
    setOpen(next);
  }
  useEffect(() => {
    if (!props.openFromLink) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("qa") !== "ta") return;
    url.searchParams.delete("qa");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    toggle(true, true);
  }, [props.openFromLink]);

  useLayoutEffect(() => {
    const el = dialog.current, paper = panel.current;
    if (!el || !paper) return;
    let valid = true;
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    el.dataset.static = String(staticAction.current || Boolean(media?.matches));
    function finish() {
      if (!valid || open || !el?.open) return;
      el.close();
      setExited(true);
      release.current?.();
      release.current = null;
      trigger.current?.focus({ preventScroll: true });
    }
    function settle() {
      if (!media?.matches || !el) return;
      el.dataset.static = "true";
      finish();
    }
    if (open) {
      if (!el.open) {
        el.dataset.phase = "closed";
        el.showModal();
        release.current = containBookModalScroll(el);
        closeButton.current?.focus({ preventScroll: true });
        paper.getBoundingClientRect();
      }
      el.dataset.phase = "open";
    } else if (el.open) {
      el.dataset.phase = "closed";
      paper.getBoundingClientRect();
      const transitions = paper.getAnimations?.().filter(a => "transitionProperty" in a && a.transitionProperty === "transform") ?? [];
      if (!transitions.length) finish();
      else void Promise.allSettled(transitions.map(a => a.finished)).then(finish);
    }
    media?.addEventListener("change", settle);
    return () => { valid = false; media?.removeEventListener("change", settle); };
  }, [open, visited]);
  useLayoutEffect(() => {
    const el = dialog.current;
    // Replacing an invalidated scope can remove its focused reader or input.
    if (open && el?.open && (!el.contains(document.activeElement) || document.activeElement?.matches(":disabled") ||
      document.activeElement?.closest("[hidden]"))) closeButton.current?.focus({ preventScroll: true });
  }, [open, props.scopeKey, props.disabledMessage, props.answers, props.sources]);
  useEffect(() => () => {
    release.current?.();
    if (request.current.active) request.current.cancel();
  }, []);
  function dismiss(keyboard: boolean) {
    if (!back.current?.()) toggle(false, keyboard);
  }

  return <>
    <button type="button" ref={trigger} className={recording ? `${styles.qaTrigger} ${bookStyles.bookTrigger}` : styles.qaTrigger}
      aria-label={label} aria-controls={id} aria-haspopup="dialog" aria-expanded={open}
      onClick={e => toggle(true, e.detail === 0)}>
      <span className={styles.qaTriggerMark} aria-hidden="true">?</span><span className={styles.qaTriggerLabel}>{label}</span>
    </button>
    {visited && createPortal(<dialog id={id} ref={dialog} className="qa-shell" data-formal-qa={props.mode}
      aria-labelledby={id + "-title"} aria-describedby={id + "-scope"}
      onCancel={e => { e.preventDefault(); dismiss(true); }}
      onKeyDownCapture={e => {
        if (e.key !== "Escape" || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        e.preventDefault(); e.stopPropagation();
        if (!e.repeat) dismiss(true);
      }}
      onPointerDown={e => { maskDown.current = e.target === e.currentTarget; }}
      onClick={e => {
        if (e.target !== e.currentTarget || !maskDown.current) return;
        maskDown.current = false;
        if (open) toggle(false, false);
        else {
          const rect = trigger.current?.getBoundingClientRect();
          if (rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) toggle(true, false);
        }
      }}>
      <article ref={panel} className="qa-panel">
        <header className="qa-header">
          <h2 id={id + "-title"}>{props.title}</h2>
          <p id={id + "-scope"}>{recording ? "Daily Brief 根据这场录音可用的本机材料回答。" : "Daily Brief 根据当前关系中可用于问答的记录回答。"}</p>
          <button type="button" className="qa-close" ref={closeButton} aria-label="关闭问答"
            onClick={e => toggle(!open, e.detail === 0)}><span aria-hidden="true">×</span></button>
        </header>
        <QaPaperConversation key={props.scopeKey ?? "unverified"} {...props} open={open} exited={exited} back={back} />
      </article>
    </dialog>, document.body)}
  </>;
}
