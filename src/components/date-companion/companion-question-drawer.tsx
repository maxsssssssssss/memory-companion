"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import type { QuestionAnswer } from "@/lib/domain/types";

import styles from "./date-companion.module.css";

export type CompanionQaPresentationState = {
  status: "idle" | "streaming" | "complete" | "failed";
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
  const [question, setQuestion] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamingRef = useRef(qaState.status === "streaming");
  const cancelRef = useRef(onCancel);

  streamingRef.current = qaState.status === "streaming";
  cancelRef.current = onCancel;

  const visibleAnswers = useMemo(
    () => answers.filter((answer) => answer.answer.trim().length > 0),
    [answers]
  );

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
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    requestAnimationFrame(() => textareaRef.current?.focus());
    return () => document.removeEventListener("keydown", handleKeyDown);
  // close intentionally reads the current streaming status through this effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, qaState.status]);

  useEffect(() => () => {
    if (streamingRef.current) cancelRef.current();
  }, []);

  const submitQuestion = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = question.trim();
    if (!enabled || !normalized) return;
    if (qaState.status === "streaming") onCancel();
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

      {open ? (
        <>
          <button aria-label="关闭问答抽屉" className={styles.drawerBackdrop} onClick={close} type="button" />
          <aside aria-label="问问 Daily Brief" aria-modal="true" className={styles.drawer} role="dialog">
            <header className={styles.drawerHeader}>
              <div>
                <small>仅限当前这次相处</small>
                <h2>问问 Daily Brief</h2>
              </div>
              <button aria-label="关闭" className={styles.drawerClose} onClick={close} type="button">×</button>
            </header>

            <div className={styles.drawerBody}>
              {visibleAnswers.length === 0 && qaState.status !== "streaming" ? (
                <div className={styles.drawerWelcome}>
                  <p>{enabled ? "回答只会使用当前这次相处的文字和复盘证据。没有足够来源时，我会明确说不确定。" : "当前录音还没有整理完成，完成后才能针对这次相处提问。"}</p>
                  {enabled ? (
                    <div className={styles.suggestions} aria-label="提问建议">
                      {SUGGESTIONS.map((suggestion) => <button key={suggestion} onClick={() => chooseSuggestion(suggestion)} type="button">{suggestion}</button>)}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className={styles.chatHistory} aria-live="polite">
                  {visibleAnswers.map((answer) => {
                    const citations = (answer.citations ?? []).filter((citation) =>
                      citation.sourceSegmentIds.every((segmentId) => validSegmentIds.has(segmentId))
                    );
                    const explicitSegmentIds = new Set(citations.flatMap((citation) => citation.sourceSegmentIds));
                    const fallbackSegmentIds = answer.citedSegmentIds.filter(
                      (segmentId) => validSegmentIds.has(segmentId) && !explicitSegmentIds.has(segmentId)
                    );
                    return (
                      <div key={answer.id}>
                        <article className={`${styles.message} ${styles.messageUser}`}>
                          <p className={styles.messageBubble}>{answer.question}</p>
                        </article>
                        <article className={`${styles.message} ${styles.messageAssistant}`}>
                          <p className={styles.messageBubble}>{answer.answer}</p>
                          {citations.length > 0 || fallbackSegmentIds.length > 0 ? (
                            <ul className={styles.citationList} aria-label="回答来源">
                              {citations.map((citation) => {
                                const segmentId = citation.sourceSegmentIds.find((candidate) => validSegmentIds.has(candidate));
                                return (
                                  <li className={styles.citationItem} key={citation.id}>
                                    <details>
                                      <summary>来自这次相处 · {citation.title}</summary>
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
                                  <details>
                                    <summary>来自这次相处 · 文字片段</summary>
                                    <div className={styles.citationBody}>
                                      <span>{segmentTextById?.get(segmentId) ? `“${segmentTextById.get(segmentId)}”` : "这条旧回答只保存了文字片段编号。"}</span>
                                      <Link href={`/date-companion/a/recap?segment=${encodeURIComponent(segmentId)}#full-transcript`} onClick={close}>在完整文字稿中查看</Link>
                                    </div>
                                  </details>
                                </li>
                              ))}
                            </ul>
                          ) : <small className={styles.composerHint}>这个回答没有可定位的有效来源，因此不提供“回到原话”。</small>}
                        </article>
                      </div>
                    );
                  })}
                </div>
              )}

              {qaState.status === "streaming" ? (
                <p className={styles.streamingAnswer} aria-label="正在生成回答">{qaState.committedText || "正在根据这次相处整理回答…"}</p>
              ) : null}
              {qaState.status === "failed" ? <p className={styles.inlineError} role="alert">{qaState.errorMessage || "这次提问没有完成，请稍后再试。"}</p> : null}
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
        </>
      ) : null}
    </>
  );
}
