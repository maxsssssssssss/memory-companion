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

export type CompanionQuestionMode = "current-interaction" | "person";

type CompanionQuestionDrawerProps = {
  answers: QuestionAnswer[];
  enabled: boolean;
  disabledMessage?: string;
  mode: CompanionQuestionMode;
  qaState: CompanionQaPresentationState;
  segmentTextById?: ReadonlyMap<string, string>;
  suggestedQuestions?: readonly string[];
  validSegmentIds: ReadonlySet<string>;
  linkableSegmentIds?: ReadonlySet<string>;
  onOpenTranscriptSource?: (segmentId: string) => boolean;
  onActivate: () => void;
  onAsk: (question: string) => Promise<void> | void;
  onCancel: () => void;
};

const PERSON_SUGGESTIONS = [
  "Ta 以前明确提到过哪些在意的事？",
  "我们确认过哪些约定？",
  "过去有哪些话题适合下次自然继续？"
] as const;

const CURRENT_INTERACTION_SUGGESTIONS = [
  "这次相处里最值得记住的是什么？",
  "Ta 这次明确提到了什么？",
  "这次有哪些可以回到原话核对的约定？"
] as const;

export function CompanionQuestionDrawer({ answers, enabled, disabledMessage, mode, qaState, segmentTextById, suggestedQuestions = [], validSegmentIds, linkableSegmentIds = new Set(), onOpenTranscriptSource, onActivate, onAsk, onCancel }: CompanionQuestionDrawerProps) {
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
  const currentInteractionMode = mode === "current-interaction";
  const triggerLabel = currentInteractionMode ? "问问这次相处" : "问问 Ta";
  const dialogTitle = currentInteractionMode ? "问问这次相处" : "问问 Daily Brief";
  const suggestions = useMemo(() => {
    const ruleFallback = currentInteractionMode
      ? CURRENT_INTERACTION_SUGGESTIONS[0]
      : PERSON_SUGGESTIONS[0];
    const selected = suggestedQuestions
      .map((suggestion) => suggestion.trim())
      .filter((suggestion, index, values) => suggestion.length > 0 && values.indexOf(suggestion) === index)
      .slice(0, 2);
    return selected.includes(ruleFallback) ? selected : [...selected, ruleFallback];
  }, [currentInteractionMode, suggestedQuestions]);

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
        aria-label={triggerLabel}
        aria-controls={drawerId}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={styles.qaTrigger}
        onClick={() => {
          onActivate();
          setOpen(true);
        }}
        ref={triggerRef}
        title={!enabled ? disabledMessage : undefined}
        type="button"
      >
        <span className={styles.qaTriggerMark} aria-hidden="true">?</span>
        <span className={styles.qaTriggerLabel}>{triggerLabel}</span>
      </button>

      {mounted && open ? createPortal(
        <>
          <button aria-label={`关闭${triggerLabel}`} className={styles.drawerBackdrop} onClick={close} type="button" />
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
                <small>{currentInteractionMode ? "当前一次相处 · 本机完整记录" : "当前关系 · 已确认记录"}</small>
                <h2 id={titleId}>{dialogTitle}</h2>
              </div>
              <button aria-label="关闭" className={styles.drawerClose} onClick={close} ref={closeRef} type="button">×</button>
            </header>

            <div className={styles.drawerBody}>
              <div className={styles.drawerWelcome}>
                <p>{enabled
                  ? currentInteractionMode
                    ? "我只会根据这次录音里可核对的内容回答。记录不够时，我会直接说明不确定。"
                    : "我会根据你和 Ta 所有已确认且保留的相处证据回答。证据不够时，我会直接说明不确定。"
                  : (disabledMessage ?? (currentInteractionMode
                      ? "当前还没有可用于提问的完整相处记录。"
                      : "当前还没有可用于提问的关系记录。"))}</p>
                {enabled ? (
                  <section aria-labelledby={`${drawerId}-suggestions`}>
                    <h3 id={`${drawerId}-suggestions`}>猜你想问</h3>
                    <div className={styles.suggestions} aria-label="猜你想问">
                      {suggestions.map((suggestion) => (
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
                <div className={styles.chatHistory} aria-label={`${triggerLabel} 对话`} aria-live="polite" role="log">
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
                                  const linkableSegmentId = citation.sourceSegmentIds.find(
                                    (candidate) => validSegmentIds.has(candidate) && linkableSegmentIds.has(candidate)
                                  );
                                  return (
                                    <li className={styles.citationItem} key={citation.id}>
                                      <details data-evidence-id={citation.id}>
                                        <summary>
                                          <span className={styles.citationCode}>{citation.id}</span>
                                          <span>{currentInteractionMode ? "来自这次相处" : "来自和 Ta 的相处记录"} · {citation.title}</span>
                                        </summary>
                                        <div className={styles.citationBody}>
                                          <span>“{citation.excerpt}”</span>
                                          {linkableSegmentId ? <Link
                                            href={`/date-companion/a/recap?segment=${encodeURIComponent(linkableSegmentId)}#full-transcript`}
                                            onClick={(event) => {
                                              if (onOpenTranscriptSource && !onOpenTranscriptSource(linkableSegmentId)) {
                                                event.preventDefault();
                                                return;
                                              }
                                              close();
                                            }}
                                          >在完整文字稿中查看</Link> : null}
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
                                        <span>{currentInteractionMode ? "来自这次相处" : "来自和 Ta 的相处记录"} · 文字片段</span>
                                      </summary>
                                      <div className={styles.citationBody}>
                                        <span>{segmentTextById?.get(segmentId) ? `“${segmentTextById.get(segmentId)}”` : "这条旧回答只保存了文字片段编号。"}</span>
                                        {linkableSegmentIds.has(segmentId) ? <Link
                                          href={`/date-companion/a/recap?segment=${encodeURIComponent(segmentId)}#full-transcript`}
                                          onClick={(event) => {
                                            if (onOpenTranscriptSource && !onOpenTranscriptSource(segmentId)) {
                                              event.preventDefault();
                                              return;
                                            }
                                            close();
                                          }}
                                        >在完整文字稿中查看</Link> : null}
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
                        <p className={styles.streamingAnswer} aria-label="正在生成回答">{qaState.committedText || (currentInteractionMode ? "正在根据这次相处的完整记录整理回答…" : "正在根据已确认的相处记录整理回答…")}</p>
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
                  aria-label={currentInteractionMode ? "针对这次相处提问" : "向 Ta 的相处记录提问"}
                  disabled={!enabled}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder={enabled
                    ? currentInteractionMode ? "问问这次相处…" : "问问 Ta…"
                    : currentInteractionMode ? "本机有完整记录后可以提问" : "有已确认记录后可以提问"}
                  ref={textareaRef}
                  rows={1}
                  value={question}
                />
                <button disabled={!enabled || !question.trim()} type="submit">{qaState.status === "streaming" ? "重新问" : "发送"}</button>
              </form>
              <small className={styles.composerHint}>{currentInteractionMode
                ? "只使用这一次相处在本机保存的完整记录。"
                : "只使用当前关系内已确认且保留的相处证据，不会搜索全账号内容。"}</small>
            </footer>
          </aside>
        </>,
        document.body
      ) : null}
    </>
  );
}
