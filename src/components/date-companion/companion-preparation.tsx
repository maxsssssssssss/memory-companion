"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ProductDialog, ProductEvidence } from "@/components/product-system/product-primitives";
import { preparationChoiceState } from "@/lib/domain/date-companion-preparation";
import type { PreparationItem, PreparationMessage, PreparationSource, PreparationView } from "@/lib/domain/date-companion-preparation";
import { preparationRequest, type PreparationCatalog } from "@/lib/client/date-companion-preparation-api";
import styles from "./companion-preparation.module.css";

function Sources({ sources }: { sources: PreparationSource[] }) {
  if (!sources.length) return null;
  return <details className={styles.sources}><summary>看看来源 · {sources.length}</summary>
    {sources.map(source => <div key={source.id}>
      {source.valid ? <><ProductEvidence label={source.origin === "user_reflection" ? "你的转述" : source.speakerRole === "companion" ? "Ta 的原话" : source.speakerRole === "self" ? "你的原话" : "记录原话"} meta={source.recordingDate}>{source.quote}</ProductEvidence>
        <Link href={source.href}>查看原记录</Link></> : <p>这条来源已不可用，之后的讨论不会再使用它。</p>}
    </div>)}
  </details>;
}

type ChoiceState = ReturnType<typeof preparationChoiceState>;

function ConversationTurn({ message, items, currentMeetingId, choices, busy, edit, select, remove }: {
  currentMeetingId?: string;
  choices: ReadonlyMap<string, ChoiceState>;
  message: PreparationMessage;
  items: PreparationItem[];
  busy: boolean;
  edit: (item: PreparationItem) => void;
  select: (item: PreparationItem) => void;
  remove: (item: PreparationItem) => void;
}) {
  // A saved user choice stays readable. Unselected source-dependent proposals
  // lose their action affordance as soon as their source is no longer usable.
  const visibleItems = items.filter(item => choices.get(item.id) ||
    (item.status === "suggested" && item.sources.every(source => source.valid)));
  // Earlier conversations may have used exactly the whole item as the reply.
  // In that case its live, editable row already shows the same text.
  const showDiscussion = Boolean(message.text.trim()) && !visibleItems.some(item => item.text === message.text);
  const sources = new Map(message.sources.map(source => [source.id, source]));
  for (const item of visibleItems) {
    for (const source of item.sources) if (!sources.has(source.id)) sources.set(source.id, source);
  }
  return (
    <article className={`${styles.message} ${message.role === "user" ? styles.user : styles.assistant}`} aria-label={message.role === "user" ? "你说" : "助手回复"}>
      {showDiscussion && <p>{message.text}</p>}
      {visibleItems.map(item => {
        const choice = choices.get(item.id);
        const oldOption = item.meetingId && currentMeetingId && item.meetingId !== currentMeetingId;
        const note = choice === "withdrawn" ? "后来放下了" : choice === "earlier" ? "那次留下的" : choice === "current" ? "已留下" : oldOption ? "当时的备选" : null;
        return <div className={styles.suggestion} key={item.id} role="group" aria-label={choice === "current" ? "已选准备" : note ? "以前的准备" : "可选准备"}>
          <p>{item.text}</p>
          {note
            ? <span className={styles.selectedNote}>{note}</span>
            : <div className={styles.itemActions}>
                <button type="button" disabled={busy} onClick={() => select(item)}>留下这条</button>
                <button type="button" disabled={busy} onClick={() => edit(item)}>改一下</button>
                <button type="button" disabled={busy} onClick={() => remove(item)}>这条先不留</button>
              </div>}
        </div>;
      })}
      {!showDiscussion && !visibleItems.length && items.length > 0 && <p className={styles.note}>这次没有留下这条准备。</p>}
      <Sources sources={Array.from(sources.values())} />
    </article>
  );
}

function RememberedPreparations({ view, choices, busy, edit }: {
  view: PreparationView; choices: ReadonlyMap<string, ChoiceState>; busy: boolean; edit: (item: PreparationItem) => void;
}) {
  const current = view.items.filter(item => choices.get(item.id) === "current");
  const past = view.items.filter(item => choices.get(item.id) === "earlier" || choices.get(item.id) === "withdrawn");
  if (!current.length && !past.length) return null;
  const lastLink = [...view.events].reverse().find(event => event.kind === "review_linked");
  const originalMeeting = view.reviewLink?.originalMeetingId ?? lastLink?.data.originalMeetingId;
  const nextMeeting = view.reviewLink?.nextMeetingId ?? lastLink?.data.nextMeetingId;
  const pastGroups = new Map<string, PreparationItem[]>();
  for (const item of past) {
    const meeting = item.meetingId ?? view.id;
    const group = pastGroups.get(meeting);
    if (group) group.push(item); else pastGroups.set(meeting, [item]);
  }
  const list = (items: PreparationItem[]) => <ul>{items.map(item => <li key={item.id}>
    <span>{item.text}</span>
    {choices.get(item.id) === "withdrawn" ? <small className={styles.selectedNote}>后来放下了</small>
      : <button type="button" disabled={busy} onClick={() => edit(item)}>改一下</button>}
    <Sources sources={item.sources} />
  </li>)}</ul>;
  return <div className={styles.remembered}>
    {current.length > 0 && <details open key={`${view.id}:${view.currentMeetingId ?? view.id}`}>
      <summary>这次想记得的事 · {current.length}</summary>
      <div role="group" aria-label={nextMeeting && nextMeeting === view.currentMeetingId ? "为下一次留下的" : "这次留下的准备"}>{list(current)}</div>
    </details>}
    {past.length > 0 && <details key={`past:${view.id}`}>
      <summary>以前留下的 · {past.length}</summary>
      {Array.from(pastGroups, ([meeting, items]) => {
        const name = originalMeeting === meeting ? "这次见面前留下的" : "先前的选择";
        return <div key={meeting} role="group" aria-label={name}>
          {pastGroups.size > 1 && <h2 className={styles.meetingLabel}>{name}</h2>}{list(items)}
        </div>;
      })}
    </details>}
  </div>;
}

function rememberOpenDiscussion(id: string | null) {
  const url = new URL(window.location.href);
  // The empty home shows this same conversation. After its first save the
  // account has a relationship, so the ordinary home will show recording tools.
  if (id && /^\/date-companion\/a\/?$/u.test(url.pathname)) url.pathname = "/date-companion/a/prepare";
  if (!/^\/date-companion\/a\/prepare\/?$/u.test(url.pathname)) return;
  if (id) url.searchParams.set("preparation", id);
  else url.searchParams.delete("preparation");
  window.history.replaceState(window.history.state, "", url);
}

export function CompanionPreparation({ relationshipName = "Ta" }: { relationshipName?: string }) {
  const [catalog, setCatalog] = useState<PreparationCatalog>({ preparations: [], availableSources: [] });
  const [view, setView] = useState<PreparationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<"sending" | "saving" | "deleting" | null>(null);
  const busy = operation !== null;
  const [slow, setSlow] = useState(false);
  const [readNotice, setReadNotice] = useState("");
  const [needsReload, setNeedsReload] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<"history" | "scope" | "options" | "delete" | "review" | null>(null);
  const [reviewChoice, setReviewChoice] = useState<string | null>(null);
  const [scope, setScope] = useState<string[]>([]);
  const [retained, setRetained] = useState(false);
  const [scopeDraft, setScopeDraft] = useState<string[]>([]);
  const [retainedDraft, setRetainedDraft] = useState(false);
  const [edit, setEdit] = useState<PreparationItem | null>(null);
  const [editText, setEditText] = useState("");
  const [feedback, setFeedback] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const nearBottom = useRef(true);
  const waitController = useRef<AbortController | null>(null);
  const displayed = useRef({ id: "", count: 0 });
  const pending = useRef<{ text: string; path: string; body: string } | null>(null);
  const requestEpoch = useRef(0);
  const latch = useRef(false);
  const alive = useRef(true);
  const closeDialog = useCallback(() => setDialog(null), []);
  const closeEdit = useCallback(() => setEdit(null), []);

  const accept = useCallback((next: PreparationView) => {
    setNeedsReload(false); setView(next); setScope(next.interactionIds); setRetained(next.allowRetained);
    setCatalog(current => ({ ...current, preparations: [next, ...current.preparations.filter(item => item.id !== next.id)] }));
  }, []);
  useEffect(() => {
    if (operation !== "sending") { setSlow(false); return; }
    const timer = window.setTimeout(() => setSlow(true), 12_000);
    return () => window.clearTimeout(timer);
  }, [operation]);
  const load = useCallback(async () => {
    const epoch = ++requestEpoch.current;
    setLoading(true);
    try {
      const result = await preparationRequest<PreparationCatalog>();
      if (!alive.current || epoch !== requestEpoch.current) return;
      setCatalog(result);
      const requested = new URL(window.location.href).searchParams.get("preparation");
      const chosen = result.preparations.find(item => item.id === requested) ?? result.preparations[0];
      if (chosen) accept(chosen);
      if (requested && chosen?.id !== requested) rememberOpenDiscussion(chosen?.id ?? null);
    } catch (cause) { if (alive.current && epoch === requestEpoch.current) throw cause; }
    finally { if (alive.current && epoch === requestEpoch.current) setLoading(false); }
  }, [accept]);
  useEffect(() => {
    alive.current = true;
    void load().catch(() => { if (alive.current) setError("暂时没能找回之前的内容，可以重新读取。"); });
    return () => { alive.current = false; requestEpoch.current++; };
  }, [load]);

  // Keep the conversation in the visible viewport, including a mobile keyboard.
  useEffect(() => {
    const node = panelRef.current;
    if (!node) return;
    const resize = () => {
      const viewport = window.visualViewport;
      const bottom = (viewport?.height ?? window.innerHeight) + (viewport?.offsetTop ?? 0);
      const main = node.closest("main");
      if (main) main.dataset.chatCompact = String((viewport?.height ?? window.innerHeight) < 520);
      node.style.height = `${Math.max(160, bottom - node.getBoundingClientRect().top - 12)}px`;
    };
    resize();
    const observer = new ResizeObserver(resize);
    const chrome = node.closest("main")?.firstElementChild;
    if (chrome && chrome !== node) observer.observe(chrome);
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("scroll", resize);
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); window.visualViewport?.removeEventListener("resize", resize); window.visualViewport?.removeEventListener("scroll", resize); };
  }, []);
  useEffect(() => {
    const id = view?.id ?? "", count = view?.messages.length ?? 0;
    const switched = displayed.current.id !== id;
    if (switched || nearBottom.current) {
      const node = messagesRef.current;
      if (node) node.scrollTop = node.scrollHeight;
      nearBottom.current = true; setUnseen(false);
    } else if (count > displayed.current.count) setUnseen(true);
    displayed.current = { id, count };
  }, [view?.id, view?.messages.length]);
  useEffect(() => {
    if (!view || view.generationStatus !== "running" || busy) return;
    const epoch = requestEpoch.current;
    const timer = window.setTimeout(() => {
      void preparationRequest<{ view: PreparationView }>(`/${view.id}`).then(result => {
        if (alive.current && epoch === requestEpoch.current) accept(result.view);
      }).catch(() => { if (alive.current && epoch === requestEpoch.current) setError("回答还没能读回来，你的内容已保留。请稍后重新读取。"); });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [view, busy, accept]);

  async function open(id: string, preserveDraft = false) {
    if (busy) return;
    const epoch = ++requestEpoch.current;
    setLoading(true); setError("");
    try {
      const result = await preparationRequest<{ view: PreparationView }>(`/${id}`);
      if (!alive.current || epoch !== requestEpoch.current) return false;
      if (!preserveDraft) nearBottom.current = true;
      accept(result.view); rememberOpenDiscussion(result.view.id);
      if (!preserveDraft) { setText(""); setFeedback(false); setReadNotice(""); pending.current = null; }
      closeDialog();
      return true;
    } catch (cause) { if (alive.current && epoch === requestEpoch.current) setError((cause as Error).message); return false; }
    finally { if (alive.current && epoch === requestEpoch.current) setLoading(false); }
  }
  async function reread() {
    if (busy || loading) return;
    setError(""); setReadNotice("");
    try {
      if (view) { if (!await open(view.id, true)) return; }
      else await load();
      if (alive.current) setReadNotice(pending.current ? "已重新读取。草稿仍在，可以和聊天记录核对后再发送。" : "已重新读取这段讨论。");
    } catch { if (alive.current) setError("暂时没能读回这段讨论，输入仍在。请稍后再试。"); }
  }
  async function mutate(kind: "select" | "edit" | "remove" | "scope" | "pause" | "link_review" | "unlink_review", extra: Record<string, unknown> = {}) {
    if (!view || latch.current) return;
    latch.current = true; setOperation("saving"); setReadNotice(""); setError("");
    try {
      const result = await preparationRequest<{ view: PreparationView }>(`/${view.id}`, { method: "PATCH", body: JSON.stringify({ operationKey: crypto.randomUUID(), expectedVersion: view.version, kind, ...extra }) });
      if (alive.current) { accept(result.view); closeEdit(); closeDialog(); }
    } catch (cause) { setError((cause as Error).message); }
    finally { latch.current = false; if (alive.current) setOperation(null); }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    const body = text.trim();
    if (!body || latch.current || loading || needsReload) return;
    latch.current = true; setOperation("sending"); setReadNotice(""); setError("");
    if (!pending.current || pending.current.text !== body) {
      const operationKey = crypto.randomUUID();
      pending.current = { text: body, path: view ? `/${view.id}/turns` : "", body: JSON.stringify(view
        ? { operationKey, expectedVersion: view.version, text: body, kind: feedback ? "feedback" : "message" }
        : { operationKey, text: body, interactionIds: scope, allowRetained: retained }) };
    }
    const controller = new AbortController();
    waitController.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 210_000);
    try {
      const result = await preparationRequest<{ view: PreparationView }>(pending.current.path, { method: "POST", body: pending.current.body, signal: controller.signal });
      if (alive.current) {
        accept(result.view); rememberOpenDiscussion(result.view.id);
        setText(current => current.trim() === body ? "" : current);
        setFeedback(false); pending.current = null;
      }
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof Error && "versionConflict" in cause && cause.versionConflict === true) {
        // This particular request was rejected, so after re-reading it can use
        // the new version. An unknown outcome must retain the exact request.
        pending.current = null; setNeedsReload(true);
        setError("这段讨论刚有更新，刚才的话没有送出。输入仍在，请重新读取后再发送。");
      } else {
        const message = controller.signal.aborted ? "已停止等待这次回复。" : cause instanceof Error ? cause.message : "暂时没有收到结果。";
        setError(`${message} 输入仍在。请先重新读取，核对刚才的话是否已保存。`);
      }
    }
    finally {
      window.clearTimeout(timeout); waitController.current = null; latch.current = false;
      if (alive.current) setOperation(null);
    }
  }
  async function removeConversation() {
    if (!view || latch.current) return;
    latch.current = true; setOperation("deleting"); setReadNotice(""); setError("");
    try {
      await preparationRequest(`/${view.id}`, { method: "DELETE", body: JSON.stringify({ operationKey: crypto.randomUUID(), expectedVersion: view.version }) });
      setCatalog(current => ({ ...current, preparations: current.preparations.filter(item => item.id !== view.id) }));
      setView(null); setNeedsReload(false); rememberOpenDiscussion(null); setScope([]); setRetained(false); setText(""); setFeedback(false); pending.current = null; closeDialog();
    } catch (cause) { setError((cause as Error).message); }
    finally { latch.current = false; setOperation(null); }
  }
  const reviewLink = view?.reviewLink;
  const reviewCandidates = catalog.availableSources.filter(record => record.reviewAvailable);
  const linkedRecord = reviewLink?.available ? reviewCandidates.find(record => record.id === reviewLink.interactionId) : undefined;
  const historicalLink = Boolean(reviewLink && view?.currentMeetingId && reviewLink.nextMeetingId !== view.currentMeetingId);
  const linkedCaption = reviewLink?.available
    ? `${reviewLink.recordingDate} · ${linkedRecord?.title ?? "相处记录"}`
    : `${reviewLink?.recordingDate ?? ""} · 原记录已不可用`;
  const bringQuestionToChat = (question: string) => {
    setText(current => current.trim() ? `${current}\n${question}` : question);
    closeDialog();
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const turnItems = view?.items;
  const itemsByMessage = useMemo(() => {
    const groups = new Map<string, PreparationItem[]>();
    for (const item of turnItems ?? []) {
      const group = groups.get(item.sourceMessageId);
      if (group) group.push(item);
      else groups.set(item.sourceMessageId, [item]);
    }
    return groups;
  }, [turnItems]);
  const choices = useMemo(() => new Map(view?.items.map(item => [item.id, preparationChoiceState(view, item)])), [view]);
  const editItem = (item: PreparationItem) => {
    setEdit(item);
    setEditText(item.text);
  };
  const recentExpression = useMemo(() => {
    if (!view) return "";
    for (let index = view.messages.length - 1; index >= 0; index--) {
      if (view.messages[index].role === "user") return view.messages[index].text;
    }
    return view.title;
  }, [view]);
  const readError = error && <div role="alert" className={styles.error}>
    <span>{error}</span><button type="button" disabled={busy || loading} onClick={() => void reread()}>重新读取</button>
  </div>;
  return <section className={styles.chat} ref={panelRef} aria-label="和 Ta 的相处讨论" data-testid="companion-chat">
    <header className={styles.header}>
      <div className={styles.heading}><h1>聊聊和 {relationshipName} 的相处</h1>
        <p title={recentExpression || undefined}>{view ? `最近聊到 · ${recentExpression}` : "见面前想一想，回来后也可以接着说。"}</p></div>
      <div className={styles.headerActions}>
        <button type="button" disabled={busy || loading} onClick={() => setDialog("history")}>聊过的</button>
        <button type="button" disabled={busy || loading} onClick={() => { setScopeDraft(view?.interactionIds ?? scope); setRetainedDraft(view?.allowRetained ?? retained); setDialog("scope"); }}>资料范围</button>
        {view ? <button type="button" aria-label="更多操作" disabled={busy || loading} onClick={() => setDialog("options")}>更多</button> : null}
      </div>
    </header>
    {view && <RememberedPreparations view={view} choices={choices} busy={busy} edit={editItem} />}
    <div className={styles.messages} ref={messagesRef} role="region" aria-label="聊天记录" tabIndex={0} onScroll={() => {
      const node = messagesRef.current!; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 70;
      if (nearBottom.current) setUnseen(false);
    }}>
      {loading ? <p role="status">正在找回之前聊到的内容…</p> : !view?.messages.length ? <div className={styles.welcome}>
        <p className={styles.welcomeTitle}>从你现在想说的开始。</p>
        <p>不用录音，直接写下你对这次见面或上次相处的想法就好。</p>
        <div className={styles.examples}>{["明天下午见 Ta，想轻松一点。", "我不确定要不要提那件事，想聊聊。"].map(example => <button key={example} type="button" onClick={() => { setText(example); inputRef.current?.focus(); }}>{example}</button>)}</div>
      </div> : view.messages.map(message => (
        <ConversationTurn key={message.id} message={message} items={itemsByMessage.get(message.id) ?? []} currentMeetingId={view.currentMeetingId} choices={choices} busy={busy}
          edit={editItem} select={item => void mutate("select", { itemId: item.id })} remove={item => void mutate("remove", { itemId: item.id })} />
      ))}
      {operation === "sending" && <div className={styles.recovery} role="status">
        <p>{slow ? "还在等这次回复。暂时没有收到结果，输入仍在这里。" : "正在发送，等一下回复…"}</p>
        <button type="button" onClick={() => waitController.current?.abort()}>先不等回复</button>
      </div>}
      {operation === "saving" && <p className={styles.note} role="status">正在保存修改…</p>}
      {operation === "deleting" && <p className={styles.note} role="status">正在删除这段讨论…</p>}
      {!busy && view?.generationStatus === "running" && <p className={styles.note} role="status">你说的话已保存，回复还在进行。回来后可以接着看。</p>}
      {!busy && view?.generationStatus === "failed" && <div className={styles.recovery} role="status">
        <p>你说的话已保存，这次没有完整回复。可以补充新想法继续聊。</p>
        <button type="button" onClick={() => inputRef.current?.focus()}>接着说</button>
      </div>}
      {view?.status === "paused" && <p className={styles.note}>这次先聊到这里。聊天和准备都已保存，想继续时直接发送新的一句。</p>}
      {readNotice && <p className={styles.note} role="status">{readNotice}</p>}
    </div>
    {unseen ? <button className={styles.newMessage} type="button" onClick={() => { const node = messagesRef.current; if (node) node.scrollTop = node.scrollHeight; nearBottom.current = true; setUnseen(false); }}>看看新回复</button> : null}
    {!dialog && !edit && readError}
    <form className={styles.composer} onSubmit={send}>
      <label htmlFor="companion-message" className={styles.inputLabel}>{feedback ? "后来怎么样？" : "想聊点什么？"}</label>
      <div className={styles.inputRow}><textarea id="companion-message" ref={inputRef} value={text} maxLength={6000} rows={2} placeholder={feedback ? "上次准备没用上，后来发生了……" : "关于 Ta，你现在想说什么？"} onChange={event => { setReadNotice(""); setText(event.target.value); }} onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !event.altKey && !event.ctrlKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
      }} /><button type="submit" disabled={busy || loading || needsReload || !text.trim()}>发送</button></div>
      <div className={styles.composerFoot}>
        {view && (reviewLink || reviewCandidates.length > 0) ? (
          <button className={styles.reviewTrigger} type="button" disabled={busy || loading}
            aria-label={reviewLink ? "查看已关联的相处记录" : undefined}
            title={reviewLink ? linkedCaption : undefined}
            onClick={() => { setReviewChoice(null); setError(""); setDialog("review"); }}>
            {reviewLink ? `${historicalLink ? "先前关联" : "已关联"} · ${linkedCaption}` : "用一份相处记录聊聊"}
          </button>
        ) : <span>{scope.length || retained ? "只使用你选定的资料" : "从当前表达聊起；需要时再选资料"}</span>}
        {view && <button type="button" aria-pressed={feedback} disabled={busy || loading} onClick={() => { setFeedback(value => !value); inputRef.current?.focus(); }}>回来记一下</button>}
      </div>
    </form>
    <ProductDialog title={reviewLink ? "已关联的相处记录" : "选一份相处记录"} open={dialog === "review"} onClose={closeDialog}
      footer={!reviewLink && <button className={styles.primary} type="button" disabled={busy || !reviewCandidates.some(record => record.id === reviewChoice)}
        onClick={() => void mutate("link_review", { interactionId: reviewChoice })}>用这份记录</button>}>
      <div className={styles.dialogBody}>
        {reviewLink ? <>
          <p className={styles.recordCaption}>{historicalLink ? "先前这次相处 · " : ""}{linkedCaption}</p>
          {reviewLink.available ? <>
            <Link className={styles.originalRecord} href={`/date-companion/a/recap?interaction=${encodeURIComponent(reviewLink.interactionId)}`}>打开原记录</Link>
            <div className={styles.reviewPrompts}>
              <button type="button" onClick={() => bringQuestionToChat("结合这份记录，看看原来准备的和这次实际聊到的内容吧。")}>看看这次发生了什么</button>
              <button type="button" onClick={() => bringQuestionToChat("根据这次相处，帮我想一个下一次见面的小建议。")}>接着准备下一次</button>
            </div>
          </> : <p>这份记录已经无法读取。你可以继续聊自己的感受和留下的准备。</p>}
          {scope.includes(reviewLink.interactionId) && <p className={styles.note}>这份记录也在你选的“资料范围”中。要完全停用它，请一并取消那里的选择。</p>}
          <button type="button" disabled={busy} onClick={() => void mutate("unlink_review")}>取消关联</button>
        </> : <>
          <p>选一份已经确认的复盘，只用于这段讨论。关联不会开启长期记忆。</p>
          <div role="radiogroup" aria-label="已确认的相处记录">{reviewCandidates.map(record => (
            <label className={styles.scopeOption} key={record.id}><input type="radio" name="companion-review-record" checked={reviewChoice === record.id}
              onChange={() => setReviewChoice(record.id)} /><span>{record.recordingDate} · {record.title}</span></label>
          ))}</div>
        </>}
        {readError}
      </div>
    </ProductDialog>
    <ProductDialog title="之前聊过的" open={dialog === "history"} onClose={closeDialog}>
      <div className={styles.dialogBody}>{readError}<button className={styles.primary} type="button" disabled={loading || busy} onClick={() => { requestEpoch.current++; setLoading(false); setView(null); setNeedsReload(false); rememberOpenDiscussion(null); setReadNotice(""); setError(""); setText(""); setScope([]); setRetained(false); setFeedback(false); pending.current = null; closeDialog(); }}>聊点新的</button>
        {catalog.preparations.length ? catalog.preparations.map(item => <button className={styles.historyItem} key={item.id} type="button" disabled={loading || busy} onClick={() => void open(item.id)}><span>{item.title}</span><small>{item.id === view?.id ? "当前这段 · " : ""}{new Date(item.updatedAt).toLocaleDateString("zh-CN")}</small></button>) : <p>还没有之前的讨论，从第一句话开始就会留下进展。</p>}</div>
    </ProductDialog>
    <ProductDialog title="这次可以用哪些资料" open={dialog === "scope"} onClose={closeDialog} footer={<button className={styles.primary} type="button" disabled={busy} onClick={() => { if (view) void mutate("scope", { interactionIds: scopeDraft, allowRetained: retainedDraft }); else { setScope(scopeDraft); setRetained(retainedDraft); closeDialog(); } }}>用这些资料</button>}>
      <div className={styles.dialogBody}>{readError}<p>只为这段讨论使用。选用记录不会开启长期记忆；不选也可以继续聊。</p>
        {catalog.availableSources.map(source => <label className={styles.scopeOption} key={source.id}><input type="checkbox" checked={scopeDraft.includes(source.id)} onChange={event => setScopeDraft(current => event.target.checked ? [...current, source.id] : current.filter(id => id !== source.id))} /><span>{source.recordingDate} · {source.title}</span></label>)}
        {catalog.availableSources.length > 0
          ? <Link className={styles.originalRecord} href="/date-companion/a/prepare?view=records">回看准备卡</Link>
          : <p>还没有可选的已确认相处记录。</p>}
        <label className={styles.scopeOption}><input type="checkbox" checked={retainedDraft} onChange={event => setRetainedDraft(event.target.checked)} /><span>使用已获准的长期资料</span></label>
        <p className={styles.note}>只读取已经合法保留的人物资料与记忆，不改变长期保留设置。</p>
        {reviewLink && <p className={styles.note}>你另外关联了一份相处记录；要停用这份关联，可以在聊天框下方打开它并取消。</p>}
        <button type="button" onClick={() => { setScopeDraft([]); setRetainedDraft(false); }}>{reviewLink ? "清空这里的选择" : "这次不用历史资料"}</button>
      </div>
    </ProductDialog>
    <ProductDialog title="这段讨论" open={dialog === "options"} onClose={closeDialog}><div className={styles.dialogBody}>{readError}
      <button type="button" disabled={busy} onClick={() => void mutate("pause")}>这次先不聊</button>
      <button className={styles.danger} type="button" onClick={() => setDialog("delete")}>删除这段讨论</button>
    </div></ProductDialog>
    <ProductDialog title="删除这段讨论？" open={dialog === "delete"} onClose={closeDialog}><div className={styles.dialogBody}>{readError}<p>聊天、留下的准备和反馈会一起删除，原来的相处记录不会改变。</p><button className={styles.danger} type="button" disabled={busy} onClick={() => void removeConversation()}>确认删除</button></div></ProductDialog>
    <ProductDialog title="改一下这条" open={Boolean(edit)} onClose={closeEdit} footer={<button className={styles.primary} type="button" disabled={busy || !editText.trim()} onClick={() => void mutate("edit", { itemId: edit?.id, text: editText.trim() })}>保存修改</button>}>
      <div className={styles.dialogBody}>{readError}<label>内容<textarea className={styles.editInput} rows={4} value={editText} maxLength={500} onChange={event => setEditText(event.target.value)} /></label>
        {edit?.status === "selected" ? <button className={styles.danger} type="button" disabled={busy} onClick={() => void mutate("remove", { itemId: edit.id })}>这条不留了</button> : <p>修改后仍是可选内容，想采用时再点“留下这条”。</p>}</div>
    </ProductDialog>
  </section>;
}
