"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { SourceRefVM } from "@/lib/domain/date-companion";
import type { QuestionAnswer } from "@/lib/domain/types";
import { projectQaCitationText } from "@/lib/domain/qa-citation-text";
import { recordingQaAnswerIsReadable, resolveQaPaperCitation } from "@/lib/client/date-companion-qa-evidence";
import type { QaPaperProps } from "./companion-qa-paper";
import { emptyQaDraft, readQaDraft, writeQaDraft, type QaDraft } from "./companion-qa-drafts";
import { QaPaperCitations, QaReadingPaper, useRecordingQaCatalog, verifiedDay } from "./companion-qa-paper-sources";

type Turn = { id: string; question: string; status: "pending" | "complete" | "failed" | "unconfirmed" | "ineligible"; answerId?: string; retrying?: boolean };
type Layer = { kind: "chat" | "history" } | { kind: "source" | "full"; answerId: string; citation: number; source: number };
type ReturnPoint = { layer: Layer; top: number; trigger: HTMLElement };
function followBottom(el: HTMLElement) { el.scrollTop = el.scrollHeight; }
function displayAnswer(answer: QuestionAnswer) {
  const text = answer.answer.trimEnd();
  const ids = new Set(answer.citations?.map(citation => citation.id));
  return projectQaCitationText(text, ids).trimEnd() || text;
}
function scrollToEntry(el: HTMLElement, within: HTMLElement) {
  within.scrollTop += el.getBoundingClientRect().top - within.getBoundingClientRect().top - 12;
}
export function animateQaPaper(el: Element | null, part: "question" | "answer" | "edge", keyboard: boolean) {
  const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  if (!el?.animate || keyboard || media?.matches) return;
  const edge = part === "edge";
  const start = edge ? { opacity: .38, transform: "scaleX(.18)" } :
    { opacity: .86, transform: part === "question" ? "translate(14px,8px)" : "translateY(13px)" };
  const animation = el.animate([start, { opacity: 1, transform: "none" }], {
    duration: edge ? 190 : part === "question" ? 215 : 245, easing: "cubic-bezier(.22,.83,.25,1)"
  });
  const settle = () => { if (media?.matches) animation.cancel(); };
  media?.addEventListener("change", settle);
  void animation.finished.catch(() => {}).finally(() => media?.removeEventListener("change", settle));
}

export function QaPaperConversation(props: QaPaperProps & { open: boolean; exited: boolean; back: RefObject<(() => boolean) | null> }) {
  const prefix = useId();
  const allowed = props.enabled && !!props.scopeKey;
  const [draft, setDraft] = useState<QaDraft>(() => props.scopeKey ? readQaDraft(props.scopeKey) : emptyQaDraft);
  const draftRef = useRef(draft);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [layer, setLayer] = useState<Layer>({ kind: "chat" });
  const [unread, setUnread] = useState(false);
  const chat = useRef<HTMLDivElement>(null);
  const reader = useRef<HTMLDivElement>(null);
  const fullReader = useRef<HTMLDivElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const suggestionTrigger = useRef<HTMLButtonElement>(null);
  const suggestionPaper = useRef<HTMLDivElement>(null);
  const [suggestionOpen, setSuggestionOpen] = useState<boolean | null>(null);
  const [animateSuggestions, setAnimateSuggestions] = useState(false);
  const sticky = useRef(true);
  const chatTop = useRef(0);
  const stack = useRef<ReturnPoint[]>([]);
  const navigation = useRef<{ focus?: HTMLElement; top?: number; arrival?: boolean; keyboard?: boolean; jumpId?: string } | null>(null);
  const request = useRef<{ id: string; keyboard: boolean; token: object } | null>(null);
  const receipt = useRef<{ id: string; keyboard: boolean } | null>(null);
  const newQuestion = useRef<{ id: string; keyboard: boolean } | null>(null);
  const lastCommitted = useRef("");
  const retryFocus = useRef<{ button: HTMLElement; id: string } | null>(null);
  const recordingId = props.recordingId;
  const recording = useRecordingQaCatalog(allowed && props.open, recordingId, props.recordingRevision, props.recordingReview, props.sourceDay, props.exited);
  const verifyingSources = Boolean(recordingId && !recording);
  const sources = recordingId ? recording ?? [] : props.sources;
  const answers = !allowed || verifyingSources ? [] : recordingId
    ? props.answers.filter(answer => recordingQaAnswerIsReadable(answer, recordingId, sources)) : props.answers;
  const withheldCount = (props.withheldCount ?? 0) + (allowed && recordingId && !verifyingSources ? props.answers.length - answers.length : 0);
  const answerById = new Map(answers.map(answer => [answer.id, answer]));
  const localIds = new Set(turns.map(turn => turn.answerId).filter(Boolean));
  // The history store is authoritative. Never retain an answer body after it has been withdrawn.
  const rows: { turn: Turn; answer?: QuestionAnswer }[] = answers.filter(answer => !localIds.has(answer.id))
    .map(answer => ({ turn: { id: answer.id, question: answer.question, status: "complete" }, answer }));
  for (const turn of turns) {
    const answer = turn.answerId ? answerById.get(turn.answerId) : undefined;
    if (turn.status !== "complete" || answer) rows.push({ turn, answer });
  }
  const selected = "answerId" in layer ? answerById.get(layer.answerId)?.citations?.[layer.citation] : undefined;
  const evidence = selected ? resolveQaPaperCitation(selected, sources) : null;
  const fullSource = layer.kind === "full" ? evidence?.sources[layer.source] : undefined;
  const day = fullSource ? verifiedDay(fullSource, props.sourceDay) : null;
  const streaming = props.qaState.status === "streaming";
  const committed = props.qaState.status === "streaming" ? props.qaState.committedText : "";
  const busy = !!request.current || turns.some(turn => turn.status === "pending");
  // Only the first, empty conversation offers the paper already unfolded.
  // A restored answer is known before its citations finish being checked.
  const initialSuggestions = !props.answers.length && !withheldCount && !turns.length
    && !draft.text && !streaming && !props.verifying && !verifyingSources;
  const suggestionsVisible = allowed && props.open && layer.kind === "chat" && (suggestionOpen ?? initialSuggestions);

  useLayoutEffect(() => {
    if (allowed) return;
    request.current = null;
    receipt.current = null;
    retryFocus.current = null;
    newQuestion.current = null;
    setTurns([]);
    setExpanded(new Set());
    stack.current = [];
    navigation.current = null;
    setLayer({ kind: "chat" });
    setUnread(false);
  }, [allowed]);

  function foldSuggestions() {
    setAnimateSuggestions(false);
    setSuggestionOpen(false);
  }
  useEffect(() => {
    if (!props.open) return;
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    function settle() {
      if (!preference?.matches) return;
      // Some browsers retain an in-flight CSS transition when its media rule disappears.
      for (const transition of suggestionPaper.current?.getAnimations?.() ?? []) transition.cancel();
      setAnimateSuggestions(false);
    }
    preference?.addEventListener("change", settle);
    return () => preference?.removeEventListener("change", settle);
  }, [props.open]);
  const scrollNode = () => layer.kind === "chat" ? chat.current : layer.kind === "history" ? history.current :
    layer.kind === "full" ? fullReader.current : reader.current;

  function updateDraft(next: QaDraft) {
    if (!props.scopeKey || !allowed) return;
    draftRef.current = next;
    writeQaDraft(props.scopeKey, next);
    setDraft(next);
  }
  function saveSelection(node: HTMLTextAreaElement) {
    if (node.value !== draftRef.current.text) return;
    const next = { ...draftRef.current, start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection };
    if (next.start !== draftRef.current.start || next.end !== draftRef.current.end || next.direction !== draftRef.current.direction) updateDraft(next);
  }
  function restoreSelection() {
    const d = draftRef.current;
    input.current?.setSelectionRange(d.start, d.end, d.direction);
  }
  function suggest(text: string) {
    if (draftRef.current.text || composing.current) return;
    foldSuggestions();
    updateDraft({ text, start: text.length, end: text.length, direction: "none" });
    input.current?.focus({ preventScroll: true });
  }

  function go(next: Layer, trigger: HTMLElement, keyboard: boolean) {
    foldSuggestions();
    if (layer.kind === "chat" && input.current) saveSelection(input.current);
    stack.current.push({ layer, trigger, top: scrollNode()?.scrollTop ?? 0 });
    navigation.current = { arrival: true, keyboard };
    setLayer(next);
  }
  function back() {
    if (layer.kind === "chat" && suggestionsVisible && suggestionOpen === true) {
      foldSuggestions();
      suggestionTrigger.current?.focus({ preventScroll: true });
      return true;
    }
    const previous = stack.current.pop();
    if (!previous) {
      if (input.current) saveSelection(input.current);
      return false;
    }
    navigation.current = { top: previous.top, focus: previous.trigger };
    setLayer(previous.layer);
    return true;
  }
  useLayoutEffect(() => {
    props.back.current = back;
    return () => { props.back.current = null; };
  });
  useLayoutEffect(() => {
    const intent = navigation.current;
    const node = scrollNode();
    if (!intent || !node) return;
    navigation.current = null;
    const target = intent.jumpId ? document.getElementById(intent.jumpId) :
      intent.arrival && layer.kind === "full" ? node.querySelector<HTMLElement>('[data-target="true"]') : null;
    if (target) scrollToEntry(target, node);
    else node.scrollTop = intent.top ?? 0;
    const heading = node.querySelector<HTMLElement>("h3");
    (target ?? (intent.focus?.isConnected ? intent.focus : heading))?.focus({ preventScroll: true });
    if (intent.arrival && layer.kind !== "chat") animateQaPaper(node.querySelector(".qa-paper-edge"), "edge", !!intent.keyboard);
    if (layer.kind === "chat") restoreSelection();
  }, [layer]);

  useLayoutEffect(() => {
    if (props.open) {
      restoreSelection();
      const frame = requestAnimationFrame(() => {
        if (chat.current && !chat.current.hidden) {
          if (sticky.current) followBottom(chat.current);
          else chat.current.scrollTop = chatTop.current;
        }
      });
      return () => { cancelAnimationFrame(frame); request.current = null; };
    } else {
      setSuggestionOpen(null);
      setAnimateSuggestions(false);
      request.current = null;
      receipt.current = null;
      newQuestion.current = null;
      retryFocus.current = null;
      setTurns(old => old.map(turn => turn.status === "pending" ? { ...turn, status: "unconfirmed" } : turn));
    }
    return () => { request.current = null; };
  }, [props.open]);
  useLayoutEffect(() => {
    if (!props.exited) return;
    stack.current = [];
    setLayer({ kind: "chat" });
  }, [props.exited]);

  function finish(id: string, status: Turn["status"], answerId?: string) {
    if (request.current?.id !== id) return;
    if (retryFocus.current?.button !== document.activeElement) retryFocus.current = null;
    if (answerId && props.open) receipt.current = { id, keyboard: request.current.keyboard };
    request.current = null;
    setTurns(old => old.map(turn => turn.id === id ? { ...turn, status, answerId } : turn));
  }
  useLayoutEffect(() => {
    const current = request.current;
    if (current && props.qaState.status === "failed") {
      finish(current.id, props.qaState.outcome ?? "failed");
    }
  }, [props.qaState]);

  async function send(question: string, keyboard: boolean, retry?: Turn, retryButton?: HTMLElement) {
    const value = question.trim();
    if (!allowed || !props.open || !value || composing.current || request.current || streaming) return;
    foldSuggestions();
    const id = retry?.id ?? crypto.randomUUID();
    const token = {};
    request.current = { id, keyboard, token };
    if (retry) {
      if (retryButton?.matches(":focus")) retryFocus.current = { button: retryButton, id };
      setTurns(old => old.map(turn => turn.id === id ? { ...turn, status: "pending", retrying: true } : turn));
    } else {
      newQuestion.current = { id, keyboard };
      setTurns(old => [...old, { id, question: value, status: "pending" }]);
      updateDraft(emptyQaDraft);
      sticky.current = true;
    }
    try {
      const answer = await props.onAsk(value);
      if (request.current?.token !== token) return;
      if (answer) finish(id, "complete", answer.id);
      // Explicit failure is reported in qaState. A null return can also mean cancellation.
      else if (request.current?.token === token) setReturned(token);
    } catch {
      if (request.current?.token === token) finish(id, "unconfirmed");
    }
  }
  const [returned, setReturned] = useState<object | null>(null);
  useEffect(() => {
    if (!returned || returned !== request.current?.token || props.qaState.status === "streaming") return;
    const failure = props.qaState.status === "failed" ? props.qaState : null;
    finish(request.current.id, failure?.outcome ?? (failure ? "failed" : "unconfirmed"));
  }, [returned, props.qaState]);

  useLayoutEffect(() => {
    const node = chat.current;
    if (!props.open || !node) return;
    const arrival = newQuestion.current;
    const done = receipt.current;
    const newSentence = committed && committed !== lastCommitted.current;
    lastCommitted.current = committed;
    if (arrival) {
      newQuestion.current = null;
      animateQaPaper(document.getElementById(prefix + "-q-" + arrival.id), "question", arrival.keyboard);
    }
    if (done) {
      receipt.current = null;
      if (layer.kind === "chat" && sticky.current) animateQaPaper(document.getElementById(prefix + "-a-" + done.id), "answer", done.keyboard);
    }
    if ((arrival || done || newSentence) && layer.kind === "chat" && sticky.current) followBottom(node);
    else if (done || newSentence) setUnread(true);
    const handoff = retryFocus.current;
    if (handoff && !request.current) {
      retryFocus.current = null;
      if (document.activeElement === document.body && !handoff.button.isConnected && layer.kind === "chat") {
        document.getElementById(prefix + "-a-" + handoff.id)?.focus({ preventScroll: true });
      }
    }
  }, [turns, committed, props.open, layer.kind, prefix]);
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = node.scrollHeight + 2 + "px";
  }, [draft.text, layer.kind, props.open]);

  const suggestion = props.mode === "person" ? "Ta 以前明确提到过哪些在意的事？" : "这次相处里最值得记住的是什么？";
  const suggestions = [...new Set([...props.suggestedQuestions.filter(s => s.trim()).slice(0, 2), suggestion])];
  const layerTitle = layer.kind === "history" ? "返回问答" : layer.kind === "full" ? "返回该依据" : "返回回答";
  return <>
    <nav className="qa-toolbar" aria-label="问答阅读层级">
      {layer.kind === "chat" ? <>{(allowed || withheldCount > 0) && <button className="qa-history-toggle" type="button"
        onClick={e => go({ kind: "history" }, e.currentTarget, e.detail === 0)}>聊过的</button>}</> :
        <button className="qa-link qa-reader-nav" type="button" onClick={back}>← {layerTitle}</button>}
    </nav>
    <div ref={chat} className="qa-scroll" hidden={layer.kind !== "chat"} aria-label="问答内容"
      onScroll={e => {
        if (!props.open || layer.kind !== "chat") return;
        const el = e.currentTarget;
        chatTop.current = el.scrollTop;
        sticky.current = el.scrollHeight - el.scrollTop - el.clientHeight < 55;
        if (sticky.current) setUnread(false);
      }}>
      {!allowed ? <div className="qa-status" role="status" id={prefix + "-status"}>
        <p>{props.disabledMessage || "正在核对可用材料…"}</p>{props.verifying && <Skeleton/>}
        {props.disabledAction}
        {props.onRetryRead && <button type="button" className="qa-link" onClick={props.onRetryRead}>重新读取人物资料</button>}</div> :
        !rows.length && <p className="qa-reading-kicker" role="status">{verifyingSources && props.answers.length ? "正在核对这场录音的问答历史…" : "从一个想核对的问题开始。"}</p>}
      {allowed && rows.map(({ turn, answer }) => {
        const pending = turn.status === "pending";
        const liveText = pending && props.qaState.status === "streaming" && props.qaState.question === turn.question ? committed : "";
        return <section className="qa-pair" key={turn.id} data-turn={turn.id}>
          <div className="qa-question" id={prefix + "-q-" + turn.id} tabIndex={-1}>
            <div className="qa-byline">你</div><p>{turn.question}</p></div>
          <article className="qa-answer" id={prefix + "-a-" + turn.id} tabIndex={-1}>
            <div className="qa-byline">Daily Brief</div>
            {answer || liveText ? <div className="qa-prose">{(answer ? displayAnswer(answer) : liveText).split(/\n+/u).filter(Boolean).map((p, i) => <p key={i}>{p}</p>)}</div> : null}
            {answer ? verifyingSources && answer.citations?.length ? <p role="status">正在核对依据…</p> :
              <QaPaperCitations answer={answer} sources={sources} sourceSpeakerLabel={props.sourceSpeakerLabel} expanded={expanded.has(answer.id)}
                onExpand={() => setExpanded(old => { const next = new Set(old); if (next.has(answer.id)) next.delete(answer.id); else next.add(answer.id); return next; })}
                animateEdge={animateQaPaper}
                onOpen={(citation, button, keyboard) => go({ kind: "source", answerId: answer.id, citation, source: 0 }, button, keyboard)}/>
              : <div className="qa-pending qa-status">
                <p role="status">{pending ? props.qaState.status === "streaming" && props.qaState.phase === "reading" ? "正在核对可用材料…" : "正在生成回答…" :
                  turn.status === "unconfirmed" ? "连接已中断，本次回答的结果尚未确认。" : turn.status === "ineligible" ? "这次可用的问答材料已经变化。" : "这次回答未能生成。"}</p>
                {pending && !liveText && <Skeleton/>}
                {(!pending || turn.retrying) && turn.status !== "ineligible" && <button type="button" className="qa-link" aria-disabled={busy}
                  onClick={e => void send(turn.question, e.detail === 0, turn, e.currentTarget)}>
                  {pending ? "正在重试…" : turn.status === "unconfirmed" ? "重新生成这次回答" : "重试这次回答"}</button>}
              </div>}
          </article>
        </section>;
      })}
    </div>
    <div className="qa-scroll qa-reader" hidden={layer.kind !== "history"} ref={history} aria-label="问答历史">
      <h3 tabIndex={-1}>聊过的</h3>
      {!answers.length && !withheldCount && <p>{props.verifying || verifyingSources ? "正在核对问答历史…" : "这个范围内还没有已完成的问答。"}</p>}
      {withheldCount > 0 && <p>另有 {withheldCount} 条历史回答，当前资料范围内无法核验。</p>}
      {answers.slice().reverse().map(answer => <button className="qa-list-entry" type="button" key={answer.id}
        onClick={() => {
          const row = rows.find(entry => entry.answer?.id === answer.id);
          if (!row) return;
          stack.current = [];
          navigation.current = { jumpId: prefix + "-q-" + row.turn.id };
          sticky.current = false;
          setLayer({ kind: "chat" });
        }}><strong>{answer.question}</strong><span>{new Date(answer.createdAt).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" })}</span></button>)}
    </div>
    {("answerId" in layer) && <div className="qa-scroll qa-reader" hidden={layer.kind !== "source"} ref={reader}>
      <QaReadingPaper evidence={evidence} day={null} sourceDay={props.sourceDay} sourceSpeakerLabel={props.sourceSpeakerLabel} animated headingId={prefix + "-source"}
        onFull={(source, button) => go({ ...layer, kind: "full", source }, button, button.matches(":focus-visible"))}/>
    </div>}
    {layer.kind === "full" && <div className="qa-scroll qa-reader" ref={fullReader}>
      <QaReadingPaper evidence={evidence} day={day} fullSource={fullSource} sourceDay={props.sourceDay} sourceSpeakerLabel={props.sourceSpeakerLabel}
        animated headingId={prefix + "-full"} onFull={() => {}}/>
    </div>}
    <form className="qa-composer" hidden={layer.kind !== "chat"} onSubmit={e => { e.preventDefault(); void send(draftRef.current.text, false); }}>
      {unread && <button type="button" className="qa-jump" onClick={() => { if (chat.current) followBottom(chat.current); sticky.current = true; setUnread(false); }}>查看新回答 ↓</button>}
      {allowed && <div className="qa-suggestion-anchor" onBlur={e => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) foldSuggestions();
      }}>
        <button type="button" className="qa-suggestion-trigger" ref={suggestionTrigger}
          aria-expanded={suggestionsVisible} aria-controls={prefix + "-suggestions"}
          onClick={e => {
            setAnimateSuggestions(e.detail > 0);
            setSuggestionOpen(!suggestionsVisible);
          }}>提问建议<span aria-hidden="true" className="qa-suggestion-chevron"/></button>
        <div className="qa-suggestion-paper" ref={suggestionPaper} data-open={suggestionsVisible} data-motion={animateSuggestions}
          id={prefix + "-suggestions"} aria-hidden={!suggestionsVisible} inert={!suggestionsVisible}>
          <div className="qa-suggestions">
            {draft.text && <p>清空输入框后可选用建议。</p>}
            {suggestions.map(s => <button key={s} type="button" disabled={!!draft.text || busy || streaming}
              onClick={() => suggest(s)}>{s}</button>)}
          </div>
        </div>
      </div>}
      <div className="qa-input-row"><textarea ref={input} rows={1} maxLength={4000} aria-label="你的问题" value={draft.text}
        aria-describedby={allowed ? undefined : prefix + "-status"} disabled={!allowed}
        placeholder={allowed ? "还想问些什么？" : "暂时无法提问"} onSelect={e => saveSelection(e.currentTarget)} onBlur={e => saveSelection(e.currentTarget)}
        onChange={e => {
          const el = e.currentTarget;
          foldSuggestions();
          updateDraft({ text: el.value, start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection });
        }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={e => {
          if (e.key !== "Enter" || e.shiftKey || composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
          if (!window.matchMedia?.("(pointer: coarse)").matches || e.ctrlKey || e.metaKey) {
            e.preventDefault();
            void send(draftRef.current.text, true);
          }
        }}/>
        <button type="submit" className="qa-send" disabled={!allowed || busy || !draft.text.trim()}
          onClick={e => { e.preventDefault(); void send(draftRef.current.text, e.detail === 0); }}>发送</button></div>
      {allowed && <small className="qa-key-hint">Shift + Enter 换行</small>}
    </form>
  </>;
}

function Skeleton() {
  return <div aria-hidden="true" className="qa-skeleton"><i/><i/></div>;
}
