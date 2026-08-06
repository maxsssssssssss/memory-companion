"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { QuestionAnswer } from "@/lib/domain/types";

import styles from "./date-companion.module.css";

export type CompanionQaPresentationState = {
  status: "idle" | "streaming" | "complete" | "failed";
  question?: string;
  committedText?: string;
  errorMessage?: string;
};

type CompanionQuestionDrawerProps = {
  answers: QuestionAnswer[];
  enabled: boolean;
  qaState: CompanionQaPresentationState;
  segmentTextById?: ReadonlyMap<string, string>;
  validSegmentIds: ReadonlySet<string>;
  onAsk: (question: string) => Promise<void> | void;
  onCancel: () => void;
};

const SUGGESTIONS = [
  "这次相处里明确聊到了什么？",
  "这次出现了哪些约定，分别是谁说的？",
  "有哪些问题适合下次自然继续？"
] as const;

export function CompanionQuestionDrawer({ answers, enabled, qaState, segmentTextById, validSegmentIds, onAsk, onCancel }: CompanionQuestionDrawerProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [question, setQuestion] = useState("");
  const [lastSubmittedQuestion, setLastSubmittedQuestion] = useState("");
  const drawerId = useId();
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const latestQuestionRef = useRef<HTMLElement>(null);
  const streamingRef = useRef(qaState.status === "streaming");
  const cancelRef = useRef(onCancel);

  streamingRef.current = qaState.status === "streaming";
  cancelRef.current = onCancel;

  const visibleAnswers = useMemo(
    () => answers.filter((answer) => answer.answer.trim().length > 0),
    [answers]
  );
  const activeQuestion = qaState.question?.trim() || lastSubmittedQuestion;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (qaState.status === "failed") {
      const failedQuestion = qaState.question?.trim() ?? "";
      if (failedQuestion) setQuestion((current) => current || failedQuestion);
    }
    if (qaState.status === "complete") {
      setLastSubmittedQuestion("");
    }
  }, [qaState]);

  const close = () => {
    if (qaState.status === "streaming") onCancel();
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "Tab") {
        const focusable = Array.from(
          drawerRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex]:not([tabindex="-1"])'
          ) ?? []
        );
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    requestAnimationFrame(() => closeRef.current?.focus());
    return () => document.removeEventListener("keydown", handleKeyDown);
  // close intentionally reads the current streaming status through this effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, qaState.status]);

  useEffect(() => () => {
    if (streamingRef.current) cancelRef.current();
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      latestQuestionRef.current?.scrollIntoView?.({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeQuestion, open, qaState.status, visibleAnswers.length]);

  const submitQuestion = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = question.trim();
    if (!enabled || !normalized) return;
    if (qaState.status === "streaming") onCancel();
    setLastSubmittedQuestion(normalized);
    setQuestion("");
    void onAsk(normalized);
  };

  const chooseSuggestion = (suggestion: string) => {
    setQuestion(suggestion);
    textareaRef.current?.focus();
  };

  return (
    <>
      <button
        aria-controls={drawerId}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={styles.qaTrigger}
        onClick={() => setOpen(true)}
        ref={triggerRef}
        type="button"
      >
        <span className={styles.qaTriggerMark} aria-hidden="true">?</span>
        <span className={styles.qaTriggerLabel}>问问这次相处</span>
      </button>

      {mounted && open ? createPortal(
        <>
          <button aria-label="关闭问问 Daily Brief" className={styles.drawerBackdrop} onClick={close} type="button" />
          <aside
            aria-labelledby={titleId}
            aria-modal="true"
            className={styles.drawer}
            data-drawer-side="left"
            data-panel-kind="conversation"
            id={drawerId}
            ref={drawerRef}
            role="dialog"
          >
            <header className={styles.drawerHeader}>
              <div>
                <small>仅限当前这次相处</small>
                <h2 id={titleId}>问问 Daily Brief</h2>
              </div>
              <button aria-label="关闭" className={styles.drawerClose} onClick={close} ref={closeRef} type="button">×</button>
            </header>

            <div className={styles.drawerBody}>
              <div className={styles.drawerWelcome}>
                <p>{enabled ? "我会根据当前这次相处的文字和复盘证据回答。证据不够时，我会直接说明不确定。" : "当前录音还没有整理完成，完成后才能针对这次相处提问。"}</p>
                {enabled ? (
                  <section aria-labelledby={`${drawerId}-suggestions`}>
                    <h3 id={`${drawerId}-suggestions`}>猜你想问</h3>
                    <div className={styles.suggestions} aria-label="猜你想问">
                      {SUGGESTIONS.map((suggestion) => (
                        <button key={suggestion} onClick={() => chooseSuggestion(suggestion)} type="button">
                          <span>{suggestion}</span>
                          <span aria-hidden="true">→</span>
                        </button>
                      ))}
                    </div>
                    <small className={styles.composerHint}>点一下会填入提问框，你可以修改后再发送。</small>
                  </section>
                ) : null}
              </div>

              {visibleAnswers.length > 0 || qaState.status === "streaming" || qaState.status === "failed" ? (
                <div className={styles.chatHistory} aria-label="当前相处对话" aria-live="polite" role="log">
                  {visibleAnswers.map((answer, answerIndex) => {
                    const citations = (answer.citations ?? []).filter((citation) =>
                      citation.sourceSegmentIds.every((segmentId) => validSegmentIds.has(segmentId))
                    );
                    const explicitSegmentIds = new Set(citations.flatMap((citation) => citation.sourceSegmentIds));
                    const fallbackSegmentIds = answer.citedSegmentIds.filter(
                      (segmentId) => validSegmentIds.has(segmentId) && !explicitSegmentIds.has(segmentId)
                    );
                    const isLatestCompletedQuestion = answerIndex === visibleAnswers.length - 1
                      && qaState.status !== "streaming"
                      && qaState.status !== "failed";
                    return (
                      <div key={answer.id}>
                        <article
                          aria-label="你的问题"
                          className={`${styles.message} ${styles.messageUser}`}
                          ref={isLatestCompletedQuestion ? latestQuestionRef : undefined}
                        >
                          <span className={styles.messageRole}>你问</span>
                          <p className={styles.messageBubble}>{answer.question}</p>
                        </article>
                        <article aria-label="Daily Brief 的回答" className={`${styles.message} ${styles.messageAssistant}`}>
                          <span className={styles.messageRole}>Daily Brief</span>
                          <p className={styles.messageBubble}>{answer.answer}</p>
                          {citations.length > 0 || fallbackSegmentIds.length > 0 ? (
                            <details className={styles.citationGroup} data-evidence-group>
                              <summary>
                                <span>回答证据</span>
                                <span>{citations.length + fallbackSegmentIds.length} 条</span>
                              </summary>
                              <ul className={styles.citationList} aria-label="回答来源">
                                {citations.map((citation) => {
                                  const segmentId = citation.sourceSegmentIds.find((candidate) => validSegmentIds.has(candidate));
                                  return (
                                    <li className={styles.citationItem} key={citation.id}>
                                      <details data-evidence-id={citation.id}>
                                        <summary>
                                          <span className={styles.citationCode}>{citation.id}</span>
                                          <span>来自这次相处 · {citation.title}</span>
                                        </summary>
                                        <div className={styles.citationBody}>
                                          <span>“{citation.excerpt}”</span>
                                          {segmentId ? <Link href={`/date-companion/a/recap?segment=${encodeURIComponent(segmentId)}#full-transcript`} onClick={close}>在完整文字稿中查看</Link> : null}
                                        </div>
                                      </details>
                                    </li>
                                  );
                                })}
                                {fallbackSegmentIds.map((segmentId) => (
                                  <li className={styles.citationItem} key={`segment:${segmentId}`}>
                                    <details data-evidence-id={`segment:${segmentId}`}>
                                      <summary>
                                        <span className={styles.citationCode}>片段</span>
                                        <span>来自这次相处 · 文字片段</span>
                                      </summary>
                                      <div className={styles.citationBody}>
                                        <span>{segmentTextById?.get(segmentId) ? `“${segmentTextById.get(segmentId)}”` : "这条旧回答只保存了文字片段编号。"}</span>
                                        <Link href={`/date-companion/a/recap?segment=${encodeURIComponent(segmentId)}#full-transcript`} onClick={close}>在完整文字稿中查看</Link>
                                      </div>
                                    </details>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          ) : <small className={styles.composerHint}>这个回答没有可定位的有效来源，因此不提供“回到原话”。</small>}
                        </article>
                      </div>
                    );
                  })}

                  {qaState.status === "streaming" ? (
                    <div data-conversation-state="streaming">
                      {activeQuestion ? (
                        <article aria-label="你的问题" className={`${styles.message} ${styles.messageUser}`} ref={latestQuestionRef}>
                          <span className={styles.messageRole}>你问</span>
                          <p className={styles.messageBubble}>{activeQuestion}</p>
                        </article>
                      ) : null}
                      <article aria-label="Daily Brief 的回答" className={`${styles.message} ${styles.messageAssistant}`}>
                        <span className={styles.messageRole}>Daily Brief</span>
                        <p className={styles.streamingAnswer} aria-label="正在生成回答">{qaState.committedText || "正在根据这次相处整理回答…"}</p>
                      </article>
                    </div>
                  ) : null}

                  {qaState.status === "failed" ? (
                    <div data-conversation-state="failed">
                      {activeQuestion ? (
                        <article aria-label="你的问题" className={`${styles.message} ${styles.messageUser}`} ref={latestQuestionRef}>
                          <span className={styles.messageRole}>你问</span>
                          <p className={styles.messageBubble}>{activeQuestion}</p>
                        </article>
                      ) : null}
                      <article aria-label="Daily Brief 的回答" className={`${styles.message} ${styles.messageAssistant}`}>
                        <span className={styles.messageRole}>Daily Brief</span>
                        <p className={styles.inlineError} role="alert">{qaState.errorMessage || "这次提问没有完成，请稍后再试。"}</p>
                      </article>
                    </div>
                  ) : null}
                </div>
              ) : <p className={styles.drawerEmpty}>可以从“猜你想问”开始，也可以直接写下自己的问题。</p>}
            </div>

            <footer className={styles.drawerComposer}>
              <form className={styles.composerForm} onSubmit={submitQuestion}>
                <textarea
                  aria-label="针对这次相处提问"
                  disabled={!enabled}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder={enabled ? "问问这次相处…" : "整理完成后可以提问"}
                  ref={textareaRef}
                  rows={1}
                  value={question}
                />
                <button disabled={!enabled || !question.trim()} type="submit">{qaState.status === "streaming" ? "重新问" : "发送"}</button>
              </form>
              <small className={styles.composerHint}>只支持当前这次相处；不会搜索关于 Ta 的全部历史。</small>
            </footer>
          </aside>
        </>,
        document.body
      ) : null}
    </>
  );
}
