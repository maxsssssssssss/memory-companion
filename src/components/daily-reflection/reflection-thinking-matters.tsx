"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import type { ThinkingMode } from "@/lib/domain/daily-reflection-thinking";
import type { ThinkingMatter, ThinkingMatterComparisonInput, ThinkingMatterMutation, ThinkingMatterView } from "@/lib/domain/reflection-thinking-matter";
import { createThinkingMattersApi, type ThinkingMattersApi } from "@/lib/client/reflection-thinking-matters-api";
import { createDailyReflectionApi, type DailyReflectionApi } from "@/lib/client/daily-reflection-api";
import { ProductDialog, ProductState } from "@/components/product-system/product-primitives";

import styles from "./daily-reflection.module.css";
import { reflectionCardPath, reflectionMemoryPath } from "./reflection-product";

const STATUS = { active: "继续思考中", paused: "暂时放下", resolved: "已解决", archived: "已归档" };
const ARRANGEMENT_STATUS = { adopted: "已采纳 · 尚未执行", tried: "已尝试", not_started: "还没开始", changed: "已经调整", completed: "用户确认已完成" };

function operationKey() { return `thinking-${crypto.randomUUID()}`; }

function stableOperation(ref: { current: { signature: string; key: string } | null }, signature: string) {
  if (ref.current?.signature !== signature) ref.current = { signature, key: operationKey() };
  return ref.current.key;
}

function rememberMatter(id: string | null) {
  const url = new URL(window.location.href);
  url.searchParams.delete("conversation");
  if (id) url.searchParams.set("matter", id);
  else url.searchParams.delete("matter");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function requestedMatter() { return new URL(window.location.href).searchParams.get("matter"); }
function requestedCard() { return new URL(window.location.href).searchParams.get("card"); }
function formatUpdated(value: string) { return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function clearCardRequest() {
  const url = new URL(window.location.href);
  url.searchParams.delete("card");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function ReflectionThinkingMatters({ mode, onModeChange, api: suppliedApi, cardApi: suppliedCardApi, restoreModeOnLoad = true }: Readonly<{
  mode: ThinkingMode;
  onModeChange?(mode: ThinkingMode): void;
  api?: ThinkingMattersApi;
  cardApi?: Pick<DailyReflectionApi, "getWorkingCard">;
  restoreModeOnLoad?: boolean;
}>) {
  const [api] = useState(() => suppliedApi ?? createThinkingMattersApi());
  const [cardApi] = useState(() => suppliedCardApi ?? createDailyReflectionApi());
  const [matters, setMatters] = useState<ThinkingMatter[]>([]);
  const [view, setView] = useState<ThinkingMatterView | null>(null);
  const [draft, setDraft] = useState("");
  const [allowHistory, setAllowHistory] = useState(false);
  const [feedback, setFeedback] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [replyPending, setReplyPending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editGoal, setEditGoal] = useState("");
  const [editVersion, setEditVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionVersion, setCorrectionVersion] = useState(0);
  const [cardPreview, setCardPreview] = useState<{ id: string; title: string; version: number } | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [allowCard, setAllowCard] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const messageViewport = useRef<HTMLDivElement | null>(null);
  const followsLatest = useRef(true);
  const previousMatter = useRef<string | null>(null);
  const closeProgress = useCallback(() => setProgressOpen(false), []);
  const updateFollowState = useCallback(() => {
    const element = messageViewport.current;
    if (!element) return;
    followsLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 96;
    if (followsLatest.current) setHasNewMessages(false);
  }, []);
  const scrollToLatest = useCallback(() => {
    const element = messageViewport.current;
    if (!element) return;
    followsLatest.current = true;
    setHasNewMessages(false);
    const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof element.scrollTo === "function") element.scrollTo({ behavior: reduceMotion ? "auto" : "smooth", top: element.scrollHeight });
    else element.scrollTop = element.scrollHeight;
  }, []);
  const startFeedback = useCallback(() => {
    setFeedback(true);
    setProgressOpen(false);
    window.requestAnimationFrame(() => document.getElementById("thinking-matter-draft")?.focus());
  }, []);
  const mounted = useRef(true);
  const lock = useRef(false);
  const requestVersion = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const readVersion = useRef(0);
  const selectedId = useRef<string | null>(null);
  const createIntent = useRef<{ signature: string; key: string } | null>(null);
  const turnIntent = useRef<{ signature: string; key: string } | null>(null);
  const mutationIntent = useRef<{ signature: string; key: string } | null>(null);
  const cardIntent = useRef<{ signature: string; key: string } | null>(null);

  function accept(next: ThinkingMatterView, restoreMode = false) {
    if (!mounted.current) return;
    selectedId.current = next.matter.id;
    setCreating(false);
    setView(next);
    setMatters(current => [next.matter, ...current.filter(item => item.id !== next.matter.id)]);
    setAllowHistory(next.matter.contextMode !== "none");
    rememberMatter(next.matter.id);
    if (restoreMode) onModeChange?.(next.matter.mode);
  }

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    async function initialize() {
      try {
        const cardId = requestedCard();
        const preview = cardId ? cardApi.getWorkingCard(cardId, controller.signal).then(result => {
          if (controller.signal.aborted) return;
          if (result.card.status === "saved" && !result.card.sourceUnavailable) { setCardPreview({ id: result.card.id, title: result.card.title, version: result.card.version }); setProgressOpen(true); }
          else setCardError("这张卡片或原始来源目前不可用，不会使用旧摘录。");
        }).catch(() => { if (!controller.signal.aborted) setCardError("这张卡片目前无法核对，不会使用旧摘录。你仍可以直接讨论。"); }) : Promise.resolve();
        const [saved] = await Promise.all([api.list(controller.signal), preview]);
        if (controller.signal.aborted) return;
        setMatters(saved);
        const id = requestedMatter() ?? (!cardId && saved.length === 1 ? saved[0]?.id : undefined);
        if (id) {
          const next = await api.get(id, controller.signal);
          if (!controller.signal.aborted) accept(next, restoreModeOnLoad);
        } else setCreating(saved.length === 0 && !cardId);
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "暂时无法读取正在想的事。");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void initialize();
    return () => { mounted.current = false; controller.abort(); activeRequest.current?.abort(); };
    // The API is fixed for the lifetime of this account-scoped page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  async function selectMatter(id: string, preserveDraft = false) {
    if (lock.current) return;
    const version = ++readVersion.current;
    setLoading(true);
    setError(null);
    setNotice(null);
    if (!preserveDraft) { setEditing(false); setCorrecting(false); }
    try {
      const next = await api.get(id);
      if (mounted.current && version === readVersion.current) {
        accept(next, true);
        if (!preserveDraft) { setDraft(""); setFeedback(false); setProgressOpen(false); }
      }
    } catch (reason) { if (mounted.current && version === readVersion.current) { setError(reason instanceof Error ? reason.message : "暂时无法读取这件事。"); setProgressOpen(false); } }
    finally { if (mounted.current && version === readVersion.current) setLoading(false); }
  }

  async function refresh() {
    if (selectedId.current) await selectMatter(selectedId.current, true);
    else {
      setLoading(true);
      try { setMatters(await api.list()); setError(null); }
      catch (reason) { setError(reason instanceof Error ? reason.message : "暂时无法读取进展。"); }
      finally { setLoading(false); }
    }
  }

  async function mutate(input: ThinkingMatterMutation) {
    if (!view || lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { operationKey: _providedKey, ...intent } = input;
      const key = stableOperation(mutationIntent, JSON.stringify({ matterId: view.matter.id, ...intent }));
      const next = await api.mutate(view.matter.id, { ...input, operationKey: key });
      accept(next);
      setNotice(input.kind === "adopt" ? "已记下你的采纳，尚未标为执行或完成。"
        : input.kind === "reject" ? "已记下不采纳，原建议保留在历史里。"
          : input.kind === "status" ? (input.status === "paused" ? "已暂停，已有安排和讨论会保留。" : input.status === "archived" ? "已归档，原有讨论和安排会保留。" : "已恢复，可以继续讨论。")
            : input.kind === "edit" && input.contextMode !== undefined ? "已保存资料使用选择。"
              : input.kind === "choice" ? "已记录你的取舍与原因，助手建议没有替你做决定。"
                : input.kind === "correct" ? "已按你的更正更新当前理解，旧记录仍然保留。"
                  : input.kind === "comparison" ? "已保存方案比较，尚未替你作出选择。"
            : "已保存你的修改。");
      setEditing(false);
      setCorrecting(false);
      return true;
    } catch (reason) { if (mounted.current) { setError(reason instanceof Error ? reason.message : "未能确认保存结果，请重新读取进展。"); setProgressOpen(false); } return false; }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || lock.current || (!view && !creating)) return;
    lock.current = true;
    scrollToLatest();
    const version = ++requestVersion.current;
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true);
    setReplyPending(true);
    setError(null);
    setNotice(null);
    try {
      let current = view;
      if (!current) {
        const create = { question: text, mode, contextMode: allowHistory ? "personal" as const : "none" as const,
          ...(allowCard && cardPreview ? { sourceCardId: cardPreview.id, sourceCardVersion: cardPreview.version } : {}) };
        current = await api.create({ operationKey: stableOperation(createIntent, JSON.stringify(create)), ...create }, controller.signal);
        if (controller.signal.aborted || version !== requestVersion.current) return;
        accept(current);
        if (allowCard && cardPreview) { clearCardRequest(); setCardPreview(null); setAllowCard(false); }
      }
      const turn = { expectedVersion: current.matter.version,
        text, mode, contextMode: allowHistory ? "personal" : "none", ...(feedback ? { feedback: true } : {}),
      } as const;
      const next = await api.turn(current.matter.id, {
        operationKey: stableOperation(turnIntent, JSON.stringify({ matterId: current.matter.id, ...turn })), ...turn,
      }, controller.signal);
      if (controller.signal.aborted || version !== requestVersion.current || !mounted.current) return;
      accept(next);
      setDraft("");
      setFeedback(false);
    } catch (reason) {
      if (controller.signal.aborted || version !== requestVersion.current || !mounted.current) return;
      setError(reason instanceof Error ? reason.message : "这次回复未完成，请先重新读取进展。");
    } finally {
      if (version === requestVersion.current) { lock.current = false; activeRequest.current = null; if (mounted.current) { setBusy(false); setReplyPending(false); } }
    }
  }

  async function cancel() {
    if (!selectedId.current || cancelling) return;
    setCancelling(true);
    try {
      // Re-read the server version because a submitted turn may already have
      // saved the user's words while its reply is still running.
      const latest = await api.get(selectedId.current);
      const next = await api.mutate(latest.matter.id, {
        operationKey: operationKey(), expectedVersion: latest.matter.version,
        kind: "cancel", ...(latest.matter.activeGeneration ? { generationId: latest.matter.activeGeneration.id } : {}),
      });
      ++requestVersion.current;
      activeRequest.current?.abort();
      activeRequest.current = null;
      lock.current = false;
      accept(next);
      setBusy(false);
      setReplyPending(false);
      setError(null);
      setNotice("本次回复已取消，已保存的讨论仍然保留。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "取消结果尚未确认，请重新读取进展。"); }
    finally { setCancelling(false); }
  }

  async function recover() {
    if (!view || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await api.recover(view.matter.id, { operationKey: operationKey() });
      accept(next);
      setNotice(next.matter.activeGeneration?.status === "unknown"
        ? "尚未找到已完成的回复，结果仍未确认；没有重新发起回复。"
        : "已核对本轮结果，没有重复生成。");
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "暂时无法核对本轮结果，请稍后再核对。");
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }

  async function associateCard() {
    if (!view || !cardPreview || !allowCard || lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const input = { expectedVersion: view.matter.version, cardId: cardPreview.id, cardVersion: cardPreview.version };
      const next = await api.linkCard(view.matter.id, { ...input, operationKey: stableOperation(cardIntent, JSON.stringify({ matterId: view.matter.id, ...input })) });
      accept(next); setCardPreview(null); setAllowCard(false); setProgressOpen(false); clearCardRequest();
      setNotice("已把这张卡片关联到当前事项，其他资料仍按你的许可使用。");
    } catch (reason) { if (mounted.current) { setError(reason instanceof Error ? reason.message : "这张卡片暂时无法关联，请重新核对。"); setProgressOpen(false); } }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }

  async function unlinkCard(cardId: string) {
    if (!view || lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const input = { expectedVersion: view.matter.version, cardId };
      const next = await api.unlinkCard(view.matter.id, { ...input, operationKey: stableOperation(cardIntent, JSON.stringify({ matterId: view.matter.id, ...input })) });
      accept(next); setNotice("已取消这张卡片与当前事项的关联，不再作为后续思考依据。");
    } catch (reason) { if (mounted.current) { setError(reason instanceof Error ? reason.message : "暂时无法确认取消关联，请重新读取进展。"); setProgressOpen(false); } }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }

  const matter = view?.matter;
  const generation = matter?.activeGeneration;
  const latestEvent = view?.events.at(-1);
  const knownFailure = generation?.status === "known_failed"
    || (latestEvent?.kind === "generation_failed" && latestEvent.data.status === "known_failed");
  const suggestions = matter?.suggestions.filter(suggestion => suggestion.status === "proposed") ?? [];
  const conversation = view?.events.filter(event => event.kind === "user_message" || event.kind === "assistant_message" || event.kind === "feedback") ?? [];
  const latestFeedback = [...(view?.events ?? [])].reverse().find(event => event.kind === "feedback");
  const inactive = Boolean(matter && matter.status !== "active");
  const choosing = !matter && !creating && !loading;
  const recent = [...matters].filter(item => item.status !== "archived").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const archived = [...matters].filter(item => item.status === "archived").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));


  const latestMessage = conversation.at(-1);
  useEffect(() => {
    const id = matter?.id ?? null;
    if (previousMatter.current !== id) {
      previousMatter.current = id;
      followsLatest.current = true;
      setHasNewMessages(false);
    }
    if (!followsLatest.current) { if (latestMessage) setHasNewMessages(true); return; }
    const frame = window.requestAnimationFrame(() => { if (followsLatest.current) scrollToLatest(); });
    return () => window.cancelAnimationFrame(frame);
  }, [matter?.id, conversation.length, latestMessage?.id, latestMessage?.text, scrollToLatest]);
  const currentChoice = matter?.comparison?.options.find(option => option.id === matter.userChoice.optionId);
  const orphanSuggestions = suggestions.filter(suggestion => !conversation.some(event => event.kind === "assistant_message" && event.id === suggestion.sourceEventId));
  const suggestedSteps = (items: typeof suggestions) => items.length ? <section aria-label="建议的下一步" className={styles.thinkingMatterSuggestions}>
    <p>这些仍是建议；采纳后才会记为你的安排。</p><ul>{items.map(suggestion => <li key={suggestion.id}><p>{suggestion.text}</p><div className={styles.thinkingMatterActions}>
      <button className={styles.primaryButton} disabled={busy || inactive} onClick={() => void mutate({ operationKey: operationKey(), expectedVersion: matter!.version, kind: "adopt", suggestionId: suggestion.id })} type="button">采纳这一步</button>
      <button className={styles.secondaryButton} disabled={busy || inactive} onClick={() => void mutate({ operationKey: operationKey(), expectedVersion: matter!.version, kind: "reject", suggestionId: suggestion.id })} type="button">不采纳</button>
    </div></li>)}</ul>
  </section> : null;

  return (
    <section aria-label="正在想的事" className={styles.thinkingMatters}>
      <div className={styles.thinkingMatterToolbar}>
        <label><span className={styles.visuallyHidden}>正在想的事</span>
          <select aria-label="选择正在想的事" disabled={busy || loading} onChange={event => {
            if (event.target.value) void selectMatter(event.target.value);
          }} value={matter?.id ?? ""}>
            <option value="">{creating ? "新的一件事" : "请选择一件事"}</option>
            {matters.map(item => <option key={item.id} value={item.id}>{item.question} · {STATUS[item.status]}</option>)}
          </select>
        </label>
        <button className={styles.secondaryButton} disabled={busy || loading} onClick={() => {
          selectedId.current = null; setView(null); setDraft(""); setFeedback(false); setAllowHistory(false);
          ++readVersion.current;
          setCreating(true); setCorrecting(false);
          createIntent.current = null; turnIntent.current = null; mutationIntent.current = null;
          setError(null); setNotice(null); setEditing(false); rememberMatter(null);
        }} aria-label="新建一件事" type="button">新建</button>
      <button aria-expanded={progressOpen} aria-haspopup="dialog" className={styles.secondaryButton} onClick={() => setProgressOpen(true)} type="button">进展与资料</button>
        {matter ? <details className={styles.thinkingMatterMore}><summary>更多</summary><div className={styles.thinkingMatterActions}>
          {matter.status === "archived" || matter.status === "resolved" ? <button className={styles.primaryButton} disabled={busy} onClick={() => void mutate({ operationKey: operationKey(), expectedVersion: matter.version, kind: "status", status: "active" })} type="button">重新打开这件事</button> : <button className={styles.secondaryButton} disabled={busy} onClick={() => void mutate({
            operationKey: operationKey(), expectedVersion: matter.version, kind: "status", status: matter.status === "paused" ? "active" : "paused",
          })} type="button">{matter.status === "paused" ? "继续这件事" : "先暂停这件事"}</button>}
          {matter.status !== "archived" ? <button className={styles.secondaryButton} disabled={busy} onClick={() => void mutate({ operationKey: operationKey(), expectedVersion: matter.version, kind: "status", status: "archived" })} type="button">归档这件事</button> : null}
        </div></details> : null}
        {matter ? <div className={styles.thinkingMatterToolbarStatus}><span>{STATUS[matter.status]}</span>
          {currentChoice && matter.userChoice.status !== "undecided" ? <span title={matter.userChoice.reason}>{matter.userChoice.status === "leaning" ? "倾向" : "已选择"}：{currentChoice.name}</span> : null}
          {matter.arrangements.length ? <span>已采纳 {matter.arrangements.length} 项安排</span> : null}
        </div> : null}</div>
      <section aria-label="一起想的讨论" className={`${styles.thinkingMatterBody} ${styles.thinkingMatterConversation}`}>
        <div className={styles.thinkingMatterMessageArea}>
          <div aria-label="这件事的对话" className={styles.thinkingMatterMessages} role="log" aria-live="polite" onScroll={updateFollowState} ref={messageViewport} tabIndex={0}>
            {choosing ? <ProductState title="选择要继续的事，或新建一件事" description="每件事分别保存。先选择对应事项，再聊上次的安排或实际反馈。" /> : null}
            {loading ? <ProductState title="正在读取已保存的讨论…" tone="loading" /> : null}
            {conversation.length ? conversation.map(event => <article className={event.kind === "assistant_message" ? styles.thinkingMatterAssistant : styles.thinkingMatterUser} key={event.id}>
              <small>{event.kind === "assistant_message" ? "一起想" : event.kind === "feedback" ? "你的实际反馈" : "你"}</small><p>{event.text}</p>
              {event.kind === "assistant_message" && event.sources.length ? <button className={styles.secondaryButton} onClick={() => setProgressOpen(true)} type="button">查看本轮依据 · {event.sources.length}</button> : null}
              {event.kind === "assistant_message" ? suggestedSteps(suggestions.filter(suggestion => suggestion.sourceEventId === event.id)) : null}
            </article>) : !choosing && !loading ? <div className={styles.thinkingEmpty}><h2>从一件在意的事聊起</h2><p>可以讨论、比较，也可以慢慢找到下一步。今天只想聊聊也没关系。</p></div> : null}
            {suggestedSteps(orphanSuggestions)}
          </div>
          {hasNewMessages ? <button className={styles.thinkingMatterLatestMessage} onClick={scrollToLatest} type="button">有新回复，回到最新</button> : null}
        </div>
        <div className={styles.thinkingMatterComposerArea}>
          {error ? <ProductState action={<button className={styles.secondaryButton} disabled={busy} onClick={() => void refresh()} type="button">重新读取进展</button>} title={error} tone="error" /> : null}
          {notice ? <p className={styles.thinkingMatterNotice} role="status">{notice}</p> : null}
          {cardError ? <ProductState title={cardError} tone="status" /> : null}
          {generation?.status === "unknown" ? <ProductState title="这次回复的结果尚未确认" description="不会自动重发。可以核对已保存的结果，或取消本次回复后再继续。" action={<div className={styles.thinkingMatterActions}>
          <button className={styles.secondaryButton} disabled={busy || cancelling} onClick={() => void recover()} type="button">核对本轮结果</button>
          <button className={styles.secondaryButton} disabled={busy || cancelling} onClick={() => void cancel()} type="button">取消本次回复</button>
        </div>} />
          : knownFailure ? <ProductState title="这次回复未完成" description="原问题和反馈已保留，你可以补充问题继续讨论；不会自动重新发送。" /> : null}
        {inactive ? <p className={styles.thinkingMatterNotice}>{matter?.status === "archived" ? "这件事已归档；重新打开后可以继续，原有历史会保留。" : matter?.status === "resolved" ? "你已将这件事标为已解决；重新打开后可以继续，原有历史会保留。" : "这件事暂时放下了；恢复后可以继续讨论，原有历史会保留。"}</p> : null}
          {matter || creating || loading ? <form className={styles.thinkingComposer} onSubmit={event => void send(event)}>
          <label className={styles.thinkingMatterDraftLabel} htmlFor="thinking-matter-draft">{feedback ? "反馈实际情况" : matter ? "继续一起想" : "你正在想什么"}</label>
          <textarea disabled={loading || inactive} id="thinking-matter-draft" rows={2} maxLength={8000} onChange={event => setDraft(event.target.value)} placeholder={feedback ? "试过之后发生了什么？还没开始、想换方向也可以说。" : "比如：我一直改计划，不知道怎么开始。"} value={draft} />
          <div><button className={styles.secondaryButton} onClick={() => setProgressOpen(true)} type="button">资料 · {(matter?.linkedSources.length ?? 0) + (allowHistory ? 1 : 0)}</button><small>{feedback ? "这次会记录为实际反馈。" : "讨论会保存，采纳安排由你决定。"}</small>
            {matter?.arrangements.length && !feedback ? <button className={styles.secondaryButton} disabled={busy || inactive} onClick={startFeedback} type="button">反馈实际情况</button> : null}
            {feedback ? <button className={styles.secondaryButton} disabled={busy} onClick={() => setFeedback(false)} type="button">改为普通讨论</button> : null}
            {replyPending || generation?.status === "running" ? <button className={styles.secondaryButton} disabled={cancelling || !matter} onClick={() => void cancel()} type="button">{cancelling ? "正在取消…" : "取消本次回复"}</button> : null}
            <button className={styles.primaryButton} disabled={loading || busy || inactive || !draft.trim() || generation?.status === "unknown" || generation?.status === "running"} type="submit">{busy ? (replyPending ? "正在一起想…" : "正在保存…") : feedback ? "提交反馈并继续想" : matter ? "发送" : "开始一起想"}</button>
          </div>
        </form> : null}
        </div>
      </section>
      <div className={styles.thinkingMatterDrawer}>
        <ProductDialog keepMounted onClose={closeProgress} open={progressOpen} title="进展与资料">
          {matters.length ? <section aria-label="最近在想的事" className={styles.thinkingRecentMatters}>
        <details open={!matter && !creating}>
          <summary>最近在想的事</summary>
          <ul>{recent.slice(0, 8).map(item => <li key={item.id}>
            <button aria-pressed={matter?.id === item.id} disabled={busy || loading} onClick={() => void selectMatter(item.id)} type="button">{item.question}</button>
            <small>{STATUS[item.status]} · 更新于 <time dateTime={item.updatedAt}>{formatUpdated(item.updatedAt)}</time></small>
          </li>)}</ul>
          {archived.length ? <details><summary>已归档的事 · {archived.length}</summary><ul>{archived.map(item => <li key={item.id}>
            <button disabled={busy || loading} onClick={() => void selectMatter(item.id)} type="button">{item.question}</button>
            <small>已归档 · 更新于 <time dateTime={item.updatedAt}>{formatUpdated(item.updatedAt)}</time></small>
          </li>)}</ul></details> : null}
        </details>
      </section> : null}
          {cardPreview ? <section aria-label="从日常卡片继续想" className={styles.thinkingMatterUnderstanding}>
        <h3>从一张卡片继续想</h3><p>{cardPreview.title}</p>
        <p>选择已有事项，或新建一件事；只有你明确允许后，这张卡片才会进入该事项的思考背景。</p>
        <label className={styles.thinkingMatterHistory}><input checked={allowCard} disabled={busy || loading} onChange={event => setAllowCard(event.target.checked)} type="checkbox" />允许这件事使用这张卡片</label>
        {matter ? <button className={styles.primaryButton} disabled={busy || !allowCard || inactive} onClick={() => void associateCard()} type="button">关联到这件事</button> : <button className={styles.secondaryButton} disabled={busy || loading} onClick={() => { setCreating(true); setDraft(""); setProgressOpen(false); window.requestAnimationFrame(() => document.getElementById("thinking-matter-draft")?.focus()); }} type="button">在新事项中一起想</button>}
      </section> : null}
          {matter ? <section aria-label="当前理解" className={styles.thinkingMatterUnderstanding}>
        <div className={styles.thinkingMatterSectionTitle}><h3>当前理解</h3>
          <div className={styles.thinkingMatterActions}>
            <button className={styles.secondaryButton} disabled={busy || inactive} onClick={() => { setEditGoal(matter.goal); setEditVersion(matter.version); setEditing(!editing); setCorrecting(false); }} type="button">修改目标</button>
            <button className={styles.secondaryButton} disabled={busy || inactive} onClick={() => { setCorrection(matter.understanding); setCorrectionVersion(matter.version); setCorrectionReason(""); setCorrecting(!correcting); setEditing(false); }} type="button">纠正当前理解</button>
          </div>
        </div>
        {matter.goal ? <p>你希望：{matter.goal}</p> : null}
        <p>{matter.understanding || "先从你的问题聊起，你可以随时补充或纠正。"}</p>
        {matter.judgments.length ? <details><summary>还待确认的判断</summary><ul>{matter.judgments.map((judgment, index) => <li key={`${index}-${judgment}`}>{judgment}</li>)}</ul></details> : null}
        {editing ? <form className={styles.thinkingMatterEdit} onSubmit={event => {
          event.preventDefault(); if (editVersion === matter.version) void mutate({ operationKey: operationKey(), expectedVersion: editVersion, kind: "edit", goal: editGoal });
        }}><label>当前目标<textarea maxLength={8000} onChange={event => setEditGoal(event.target.value)} value={editGoal} /></label>
          {editVersion !== matter.version ? <p role="status">进展已更新，当前草稿已保留。请取消编辑，再根据最新内容修改。</p> : null}
          <div className={styles.thinkingMatterActions}><button className={styles.primaryButton} disabled={busy || editVersion !== matter.version} type="submit">保存目标</button><button className={styles.secondaryButton} onClick={() => setEditing(false)} type="button">取消修改</button></div>
        </form> : null}
        {correcting ? <form className={styles.thinkingMatterEdit} onSubmit={event => {
          event.preventDefault(); if (correctionVersion === matter.version) void mutate({ operationKey: operationKey(), expectedVersion: correctionVersion, kind: "correct", understanding: correction, reason: correctionReason });
        }}><label>更正后的理解<textarea maxLength={8000} onChange={event => setCorrection(event.target.value)} value={correction} /></label>
          <label>更正说明（可不填）<textarea maxLength={8000} onChange={event => setCorrectionReason(event.target.value)} value={correctionReason} /></label>
          {correctionVersion !== matter.version ? <p role="status">进展已更新，当前草稿已保留。请取消编辑，再根据最新内容修改。</p> : null}
          <div className={styles.thinkingMatterActions}><button className={styles.primaryButton} disabled={busy || !correction.trim() || correctionVersion !== matter.version} type="submit">保存更正</button><button className={styles.secondaryButton} onClick={() => setCorrecting(false)} type="button">取消更正</button></div>
        </form> : null}
      </section> : null}

      {matter ? <ThinkingComparison busy={busy || inactive} key={matter.id} onMutate={mutate} view={view!} /> : null}
      {matter?.linkedSources.length ? <section aria-label="明确关联的卡片" className={styles.thinkingMatterLinkedSources}>
        <h3>这件事使用的卡片</h3><p>只关联你明确允许的卡片；不自动允许查找其他资料。</p>
        <ul>{matter.linkedSources.filter(source => source.kind === "card").map((source, index) => {
          const values = view?.events.find(event => event.id === source.sourceEventId)?.data.linkedSourceAvailability;
          const availability = Array.isArray(values) ? values.find(value => value && typeof value === "object"
            && value.sourceId === source.sourceId && value.kind === source.kind && value.version === source.version)?.status : undefined;
          return <li key={source.sourceId}>
            {availability === "available" ? <Link href={reflectionCardPath(source.sourceId)} prefetch={false}>日常卡片 {index + 1}</Link>
              : <span className={styles.thinkingSourceUnavailable}>日常卡片 {index + 1} · {availability === "unavailable" ? "来源已失效或已撤回" : "来源尚未核对"}</span>}
            <button className={styles.secondaryButton} disabled={busy} onClick={() => void unlinkCard(source.sourceId)} type="button">取消关联卡片 {index + 1}</button>
          </li>;
        })}</ul>
      </section> : null}
          {matter?.arrangements.length ? <section aria-label="已采纳的安排" className={styles.thinkingMatterArrangements}>
        <h3>已采纳的安排</h3><ul>{matter.arrangements.map(arrangement => <li key={arrangement.id}>
          <p>{arrangement.text}</p><small>{ARRANGEMENT_STATUS[arrangement.status]}</small>
          <button className={styles.secondaryButton} disabled={busy || inactive} onClick={startFeedback} type="button">反馈这项安排</button>
        </li>)}</ul>
      </section> : null}

      {latestFeedback ? <section aria-label="最近反馈" className={styles.thinkingLatestFeedback}>
        <h3>最近反馈</h3><time dateTime={latestFeedback.createdAt}>{formatUpdated(latestFeedback.createdAt)}</time><p>{latestFeedback.text}</p>
      </section> : null}
          {conversation.some(event => event.kind === "assistant_message" && event.sources.length) ? <section aria-label="讨论依据" className={styles.thinkingMatterSources}><h3>讨论依据</h3>{conversation.filter(event => event.kind === "assistant_message" && event.sources.length).map(event => <div key={event.id}><p>这轮回复的依据 · <time dateTime={event.createdAt}>{formatUpdated(event.createdAt)}</time></p>{event.kind === "assistant_message" && event.sources.length ? <div aria-label="本轮依据" className={styles.thinkingMatterSources}>
              <span>依据：</span>{event.sources.map((source, index) => {
                const number = event.sources.slice(0, index + 1).filter(item => item.kind === source.kind).length;
                const label = `${source.kind === "memory" ? "日常记忆" : source.kind === "card" ? "日常卡片" : "日常记录"} ${number}`;
                const href = source.kind === "memory" ? reflectionMemoryPath(source.sourceId) : source.kind === "card" ? reflectionCardPath(source.sourceId) : null;
                return href ? <Link href={href} key={`${source.kind}-${source.sourceId}-${index}`} prefetch={false}>{label}</Link> : <span key={`${source.kind}-${source.sourceId}-${index}`}>{label}</span>;
              })}
            </div> : null}</div>)}</section> : null}
          <section aria-label="资料使用范围" className={styles.thinkingMatterUnderstanding}><h3>资料使用范围</h3><p>关联一张卡片只允许使用该卡片。其他历史资料由你另行决定是否允许。</p><label className={styles.thinkingMatterHistory}><input checked={allowHistory} disabled={busy || loading} onChange={event => {
            const allowed = event.target.checked;
            setAllowHistory(allowed);
            if (matter) void mutate({ operationKey: operationKey(), expectedVersion: matter.version, kind: "edit", contextMode: allowed ? "personal" : "none" });
          }} type="checkbox" />允许按需参考我的日常卡片和记忆</label></section>
          {view && view.events.length ? <details className={styles.thinkingMatterHistoryDetails}><summary>查看这件事的完整记录</summary><ol>{view.events.map(event => <li key={event.id}><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString("zh-CN")}</time><p>{event.text || "已记录本次状态变化。"}</p></li>)}</ol></details> : null}
        </ProductDialog>
      </div>
    </section>
  );
}

type OptionDraft = {
  id?: string; name: string; content: string;
  reasons: string; limits: string; costs: string; unknowns: string;
};
const emptyOption = (): OptionDraft => ({ name: "", content: "", reasons: "", limits: "", costs: "", unknowns: "" });
function lines(value: string) { return [...new Set(value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean))]; }

function ThinkingComparison({ view, busy, onMutate }: {
  view: ThinkingMatterView; busy: boolean; onMutate(input: ThinkingMatterMutation): Promise<boolean>;
}) {
  const { matter, events } = view;
  const comparison = matter.comparison;
  const choice = matter.userChoice;
  const [editing, setEditing] = useState(false);
  const [question, setQuestion] = useState("");
  const [dimensions, setDimensions] = useState("");
  const [options, setOptions] = useState<OptionDraft[]>([]);
  const [reason, setReason] = useState(choice.reason);
  const [formError, setFormError] = useState<string | null>(null);
  const [editVersion, setEditVersion] = useState(matter.version);
  useEffect(() => setReason(choice.reason), [choice.sourceEventId, choice.reason]);
  const nameFor = (id: string | null) => comparison?.options.find(option => option.id === id)?.name ?? "此前方案";
  const changes = events.filter(event => ["choice_changed", "comparison_edited", "corrected"].includes(event.kind));
  function describeChoice(value: unknown) {
    if (!value || typeof value !== "object") return null;
    const saved = value as Record<string, unknown>;
    if (saved.status === "undecided") return "暂不决定";
    if ((saved.status === "leaning" || saved.status === "selected") && typeof saved.optionId === "string") return `${saved.status === "leaning" ? "倾向" : "选择"}${nameFor(saved.optionId)}`;
    return null;
  }

  function startEdit() {
    setQuestion(comparison?.question ?? matter.question);
    setEditVersion(matter.version);
    setDimensions(comparison?.dimensions.join("\n") ?? "");
    setOptions(comparison?.options.map(option => ({ id: option.id, name: option.name, content: option.content,
      reasons: option.reasons.join("\n"), limits: option.limits.join("\n"), costs: option.costs.join("\n"), unknowns: option.unknowns.join("\n") })) ?? [emptyOption(), emptyOption()]);
    setFormError(null); setEditing(true);
  }

  function updateOption(index: number, field: keyof Omit<OptionDraft, "id">, value: string) {
    setOptions(current => current.map((option, itemIndex) => itemIndex === index ? { ...option, [field]: value } : option));
  }

  async function saveComparison(event: FormEvent) {
    event.preventDefault();
    if (editVersion !== matter.version) return;
    if (!question.trim() || options.some(option => !option.name.trim())) { setFormError("请写下比较的问题和每个方案的名称。"); return; }
    if (lines(dimensions).length > 16 || options.some(option => [option.reasons, option.limits, option.costs, option.unknowns].some(value => lines(value).length > 12))) {
      setFormError("关注点最多 16 项；每个方案每栏最多保留 12 条要点。"); return;
    }
    const input: ThinkingMatterComparisonInput = { question, dimensions: lines(dimensions),
      options: options.map(option => ({ ...(option.id ? { id: option.id } : {}), name: option.name, content: option.content,
        reasons: lines(option.reasons), limits: lines(option.limits), costs: lines(option.costs), unknowns: lines(option.unknowns) })),
      recommendation: comparison?.recommendation ? { optionId: comparison.recommendation.optionId, text: comparison.recommendation.text } : null,
    };
    if (await onMutate({ operationKey: operationKey(), expectedVersion: editVersion, kind: "comparison", comparison: input })) setEditing(false);
  }

  async function recordChoice(status: "undecided" | "leaning" | "selected", optionId: string | null, rejectedIds = choice.rejectedIds) {
    await onMutate({ operationKey: operationKey(), expectedVersion: matter.version, kind: "choice", status, optionId, reason, rejectedIds });
  }

  return <section aria-label="方案比较" className={styles.thinkingComparison}>
    <div className={styles.thinkingMatterSectionTitle}><h3>方案比较</h3><button className={styles.secondaryButton} disabled={busy} onClick={startEdit} type="button">编辑方案比较</button></div>
    {comparison ? <>
      <h4>{comparison.question}</h4>
      {comparison.dimensions.length ? <p className={styles.thinkingComparisonDimensions}>这次关注：{comparison.dimensions.join(" · ")}</p> : null}
      {comparison.recommendation ? <aside aria-label="助手的建议" className={styles.thinkingComparisonRecommendation}>
        <strong>助手的建议{comparison.recommendation.optionId ? `：${nameFor(comparison.recommendation.optionId)}` : ""}</strong>
        <p>{comparison.recommendation.text}</p><small>这仍是助手的建议，不代表你已经选择。</small>
      </aside> : null}
      <p className={styles.thinkingChoiceState}>你的选择：{choice.status === "undecided" ? "暂不决定" : `${choice.status === "leaning" ? "更倾向" : "已选择"}${nameFor(choice.optionId)}`}{choice.reason ? `；原因：${choice.reason}` : ""}</p>
      {choice.rejectedIds.length ? <p className={styles.thinkingComparisonDimensions}>暂不考虑：{choice.rejectedIds.map(id => nameFor(id)).join("、")}</p> : null}
      <label className={styles.thinkingChoiceReason}>取舍原因（可不填）<textarea disabled={busy} maxLength={8000} onChange={event => setReason(event.target.value)} rows={2} value={reason} /></label>
      <div className={styles.thinkingComparisonOptions}>{comparison.options.map(option => {
        const interpretationStatus = events.find(event => event.id === option.sourceEventId)?.data.interpretationStatus;
        const unavailable = interpretationStatus === "unavailable" || interpretationStatus === "corrected";
        return <article aria-label={`方案：${option.name}`} key={option.id}>
        <h4>{option.name}</h4>{option.content ? <p>{option.content}</p> : null}
        {unavailable ? <p className={styles.thinkingSourceUnavailable}>{interpretationStatus === "corrected" ? "此前解释已被修正，暂不可选择。" : "来源已失效，暂不可选择。"}可以根据你现在的表达重新记录比较。</p> : null}
        <dl>{([ ["reasons", "可以考虑的理由"], ["limits", "适用前提与局限"], ["costs", "需要付出的代价"], ["unknowns", "还不知道的事"] ] as const).map(([field, label]) => option[field].length ? <div key={field}><dt>{label}</dt><dd><ul>{option[field].map((point, index) => <li key={`${index}-${point}`}>{point}</li>)}</ul></dd></div> : null)}</dl>
        <div className={styles.thinkingMatterActions}>
          <button className={styles.secondaryButton} disabled={busy || unavailable} onClick={() => void recordChoice("leaning", option.id, choice.rejectedIds.filter(id => id !== option.id))} type="button">倾向：{option.name}</button>
          <button className={styles.primaryButton} disabled={busy || unavailable} onClick={() => void recordChoice("selected", option.id, choice.rejectedIds.filter(id => id !== option.id))} type="button">选择：{option.name}</button>
          <button className={styles.secondaryButton} disabled={busy || unavailable} onClick={() => void recordChoice(choice.optionId === option.id ? "undecided" : choice.status, choice.optionId === option.id ? null : choice.optionId, [...new Set([...choice.rejectedIds, option.id])])} type="button">暂不考虑：{option.name}</button>
        </div>
      </article>;
      })}</div>
      <button className={styles.secondaryButton} disabled={busy} onClick={() => void recordChoice("undecided", null)} type="button">暂不决定</button>
    </> : <p className={styles.thinkingComparisonDimensions}>需要比较几个方向时，可以在对话中提出，也可以自己记下方案。</p>}

    {editing ? <form className={styles.thinkingComparisonEditor} onSubmit={event => void saveComparison(event)}>
      <label>比较问题<input disabled={busy} maxLength={8000} onChange={event => setQuestion(event.target.value)} value={question} /></label>
      <label>比较关注点（每行一个）<textarea disabled={busy} maxLength={4000} onChange={event => setDimensions(event.target.value)} rows={3} value={dimensions} /></label>
      {options.map((option, index) => <fieldset key={option.id ?? `new-${index}`}><legend>方案 {index + 1}</legend>
        <label>方案 {index + 1} 名称<input disabled={busy} maxLength={240} onChange={event => updateOption(index, "name", event.target.value)} value={option.name} /></label>
        <label>方案 {index + 1} 内容<textarea disabled={busy} maxLength={4000} onChange={event => updateOption(index, "content", event.target.value)} rows={3} value={option.content} /></label>
        {([ ["reasons", "理由"], ["limits", "前提与局限"], ["costs", "代价"], ["unknowns", "未知信息"] ] as const).map(([field, label]) => <label key={field}>方案 {index + 1} {label}（每行一条）<textarea disabled={busy} maxLength={14400} onChange={event => updateOption(index, field, event.target.value)} rows={2} value={option[field]} /></label>)}
      </fieldset>)}
      {formError ? <p className={styles.inlineError} role="alert">{formError}</p> : null}
      {editVersion !== matter.version ? <p className={styles.thinkingMatterNotice} role="status">比较已更新，当前草稿已保留。请取消编辑，再核对最新方案。</p> : null}
      <div className={styles.thinkingMatterActions}><button className={styles.secondaryButton} disabled={busy || options.length >= 12} onClick={() => setOptions(current => [...current, emptyOption()])} type="button">新增方案</button>
        <button className={styles.primaryButton} disabled={busy || editVersion !== matter.version} type="submit">保存方案比较</button><button className={styles.secondaryButton} disabled={busy} onClick={() => setEditing(false)} type="button">取消编辑比较</button></div>
    </form> : null}
    {changes.length ? <details className={styles.thinkingMatterHistoryDetails}><summary>查看取舍变化记录</summary><ol>{changes.map(event => <li key={event.id}><time dateTime={event.createdAt}>{formatUpdated(event.createdAt)}</time>
      {event.kind === "choice_changed" && describeChoice(event.data.choice) ? <p>{describeChoice(event.data.previousChoice) ?? "此前尚未记录"} → {describeChoice(event.data.choice)}</p> : null}
      <p>{event.text}</p>{typeof event.data.reason === "string" && event.data.reason && !event.text.includes(event.data.reason) ? <p>原因：{event.data.reason}</p> : null}</li>)}</ol></details> : null}
  </section>;
}
