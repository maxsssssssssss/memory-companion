"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type ChangeEvent,
  type MutableRefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from "react";

import {
  ProductDialog,
  ProductState,
  ProductTabs
} from "@/components/product-system/product-primitives";
import {
  isDefinitiveWorkReviewApiError,
  WorkReviewApiError,
  type WorkReviewV2CoreApi,
  type WorkWeeklyScopeResponse
} from "@/lib/client/work-review-api";
import type { WorkProject } from "@/lib/domain/work-project";
import type {
  WorkWeeklyQaMessage,
  WorkWeeklyQaThread,
  WorkWeeklyReview,
  WorkWeeklyReviewItem,
  WorkWeeklyScope,
  WorkWeeklyScopeKind,
  WorkWeeklySectionKind,
  WorkWeeklySourceSummary
} from "@/lib/domain/work-weekly";

import { useWorkReview } from "./work-review-shell";
import { asWorkReviewV2Api, workReviewOperationKey } from "./work-review-v2";
import { WorkWeeklySourceDialog } from "./work-weekly-source-dialog";
import { useWeeklyQaDisplayText } from "./work-weekly-qa-display";
import styles from "./work-weekly.module.css";

type LoadState = "idle" | "loading" | "ready" | "error";
type WeeklyTab = "review" | "qa";
type ConfirmAction = "regenerate" | "reset" | null;
type DisplayedGeneration = NonNullable<WorkWeeklyScopeResponse["displayedGeneration"]>;

const PARTIAL_REVIEW_TITLE = "已生成，部分内容待核对";
const REVIEW_ISSUE_LABELS: Readonly<Record<DisplayedGeneration["reviewIssues"][number]["reasonCode"], string>> = {
  missing_key_content: "这条来源的重要内容尚未完整纳入回顾。",
  missing_qualification: "相关表述的前提或限定条件仍需核对。",
  claim_not_verified: "相关内容尚未通过来源核对，未作为已证实正文展示。",
  coverage_claim_filtered: "部分相关内容未进入可用正文，请对照来源核对。",
  coverage_not_applicable_invalid: "这条来源是否需要纳入回顾仍需核对。",
  source_pack_truncated: "本次使用的来源范围有限，可能遗漏重要内容。",
  source_history_incomplete: "部分来源历史不完整，仍需补充核对。",
  source_unavailable: "原来源已不可用，相关事项仍待核对。"
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const PROCESSING_STATUSES = new Set(["queued", "generating", "verifying"]);
const SECTION_ORDER: readonly WorkWeeklySectionKind[] = [
  "overview",
  "progress",
  "decisions",
  "completed",
  "in_progress",
  "waiting_for_others",
  "open_questions",
  "next_week"
];
const SECTION_LABELS: Readonly<Record<WorkWeeklySectionKind, string>> = {
  overview: "本周概览",
  progress: "重要进展",
  decisions: "关键决定与变化",
  completed: "本周标记完成的待办",
  in_progress: "仍在进行",
  waiting_for_others: "等待他人",
  open_questions: "未解决问题",
  next_week: "AI建议关注"
};
const QA_PROMPTS = [
  "这周完成了什么？",
  "还有哪些事项没有结束？",
  "哪些工作正在等待他人？",
  "本周做出了哪些决定？"
] as const;

function dateFromKey(value: string) {
  if (!DATE_PATTERN.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function workWeeklyCurrentWeekStart(now = new Date()) {
  const local = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysSinceMonday = (local.getDay() + 6) % 7;
  local.setDate(local.getDate() - daysSinceMonday);
  return dateKey(local);
}

export function workWeeklyShiftWeek(weekStart: string, amount: number) {
  const parsed = dateFromKey(weekStart);
  if (!parsed) return weekStart;
  parsed.setUTCDate(parsed.getUTCDate() + amount * 7);
  return parsed.toISOString().slice(0, 10);
}

function validWeekStart(value: string | null, currentWeekStart: string) {
  const parsed = value ? dateFromKey(value) : null;
  return parsed && parsed.getUTCDay() === 1 && value! <= currentWeekStart ? value! : currentWeekStart;
}

function weekRangeLabel(weekStart: string) {
  const end = workWeeklyShiftWeek(weekStart, 1);
  const endDate = new Date(`${end}T00:00:00.000Z`);
  endDate.setUTCDate(endDate.getUTCDate() - 1);
  return `${weekStart} 至 ${endDate.toISOString().slice(0, 10)}`;
}

function actionError(error: unknown) {
  if (error instanceof WorkReviewApiError && error.code === "version_conflict") {
    return "内容已在其他页面更新。请载入最新状态后再继续。";
  }
  return error instanceof WorkReviewApiError
    ? error.message
    : "暂时无法完成这项操作，请稍后重试。";
}

function keyForOperation(
  keys: MutableRefObject<Map<string, string>>,
  logicalKey: string,
  prefix: string
) {
  const existing = keys.current.get(logicalKey);
  if (existing) return existing;
  const created = workReviewOperationKey(prefix);
  keys.current.set(logicalKey, created);
  return created;
}

function settleOperation(
  keys: MutableRefObject<Map<string, string>>,
  logicalKey: string,
  error?: unknown
) {
  if (error === undefined || isDefinitiveWorkReviewApiError(error)) keys.current.delete(logicalKey);
}

function itemText(item: WorkWeeklyReviewItem) {
  const text = item.userText ?? item.systemText ?? "";
  if (item.section === "next_week" && item.origin === "gpt" && item.userText === null
    && text.startsWith("GPT 建议关注：")) {
    return `AI建议关注：${text.slice("GPT 建议关注：".length)}`;
  }
  return text;
}

function visibleItem(item: WorkWeeklyReviewItem) {
  return item.hiddenAt === null && item.invalidatedAt === null
    && item.verificationState !== "invalidated" && Boolean(itemText(item).trim());
}

function sourceSummaryHasContent(summary: WorkWeeklySourceSummary | null) {
  return Boolean(summary && (
    summary.findingCount > 0
    || summary.todoCount > 0
    || summary.todoEventCount > 0
    || summary.evidenceCount > 0
  ));
}

function SourceSummary({ scope, summary }: Readonly<{
  scope: WorkWeeklyScope | null;
  summary: WorkWeeklySourceSummary;
}>) {
  return (
    <section aria-labelledby="weekly-source-heading" className={styles.sourceSummary}>
      <header>
        <h2 id="weekly-source-heading">来源覆盖范围</h2>
        <p>以下数字由服务端 Source Snapshot 返回，不是页面估算。</p>
      </header>
      <dl>
        <div><dt>会议</dt><dd>{summary.meetingCount}</dd></div>
        <div><dt>已确认结果</dt><dd>{summary.findingCount}</dd></div>
        <div><dt>待办</dt><dd>{summary.todoCount}</dd></div>
        <div><dt>待办变化</dt><dd>{summary.todoEventCount}</dd></div>
        <div><dt>原话证据</dt><dd>{summary.evidenceCount}</dd></div>
        <div><dt>项目</dt><dd>{summary.projectCount}</dd></div>
        <div><dt>待确认结果</dt><dd>{summary.pendingCandidateCount}</dd></div>
      </dl>
      {scope ? (
        <p className={styles.observedThrough}>
          {scope.windowComplete
            ? `数据窗口已完整覆盖这一周；统计截至 ${scope.observedThrough}。`
            : `当前周数据截至 ${scope.observedThrough}；本周尚未结束。`}
        </p>
      ) : null}
      <p className={styles.coverageDetail}>
        本次有界输入包含 {summary.includedFindingCount} 项结果、{summary.includedTodoCount} 条待办、
        {summary.includedTodoEventCount} 条待办变化与 {summary.includedEvidenceCount} 条原话证据。
        {summary.historyCompleteness === "legacy_limited" ? " 部分旧待办的周内历史有限。" : " 待办历史覆盖完整。"}
      </p>
      {summary.truncated ? (
        <p className={styles.capacityWarning} role="status">
          来源超过本次处理容量；服务端未纳入 {summary.omittedFindingCount} 项结果、
          {summary.omittedTodoCount} 条待办、{summary.omittedTodoEventCount} 条待办变化与
          {summary.omittedEvidenceCount} 条原话证据。回顾不代表完整覆盖。
        </p>
      ) : null}
    </section>
  );
}

function SourceButtons({
  onOpenSource,
  sourceRefs
}: Readonly<{
  onOpenSource: (sourceRef: string) => void;
  sourceRefs: readonly string[];
}>) {
  if (sourceRefs.length === 0) return null;
  return (
    <div aria-label="本条来源" className={styles.sourceButtons}>
      {sourceRefs.map((sourceRef, index) => (
        <button className={styles.textButton} key={sourceRef} onClick={() => onOpenSource(sourceRef)} type="button">
          来源 {index + 1}
        </button>
      ))}
    </div>
  );
}

function PartialReviewNotice({ generation, onOpenSource }: Readonly<{
  generation: DisplayedGeneration;
  onOpenSource: (sourceRef: string) => void;
}>) {
  const [expanded, setExpanded] = useState(false);
  const headingId = useId();
  const issuesId = useId();
  return (
    <section aria-labelledby={headingId} className={styles.partialReviewNotice}>
      <h2 id={headingId}>{PARTIAL_REVIEW_TITLE}</h2>
      <p>下方是当前可用的回顾内容，仍有缺失或待核对事项；这些提示不作为已证实结论。</p>
      {generation.reviewIssues.length ? (
        <>
          <button aria-controls={issuesId} aria-expanded={expanded} className={styles.textButton} onClick={() => setExpanded((value) => !value)} type="button">
            {expanded ? "收起待核对事项" : "查看待核对事项"}（{generation.reviewIssues.length}）
          </button>
          <ul hidden={!expanded} id={issuesId}>
            {generation.reviewIssues.map((issue, index) => (
              <li key={`${issue.reasonCode}:${issue.sourceRef ?? "unavailable"}:${index}`}>
                <p>{REVIEW_ISSUE_LABELS[issue.reasonCode]}</p>
                {issue.sourceRef ? <button className={styles.textButton} onClick={() => onOpenSource(issue.sourceRef!)} type="button">查看事项 {index + 1} 的原始记录</button> : null}
              </li>
            ))}
          </ul>
        </>
      ) : <p>待核对事项详情暂不可用。</p>}
    </section>
  );
}

type QaController = Readonly<{
  busy: boolean;
  clear: () => Promise<void>;
  draft: string;
  error: string | null;
  loadState: LoadState;
  messages: WorkWeeklyQaMessage[];
  notice: string | null;
  pending: boolean;
  refreshing: boolean;
  reload: () => void;
  setDraft: (value: string) => void;
  submit: () => Promise<void>;
  thread: WorkWeeklyQaThread | null;
}>;

function useWeeklyQa({
  active,
  api,
  enabled,
  review
}: Readonly<{
  active: boolean;
  api: WorkReviewV2CoreApi | null;
  enabled: boolean;
  review: WorkWeeklyReview | null;
}>): QaController {
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [thread, setThread] = useState<WorkWeeklyQaThread | null>(null);
  const [messages, setMessages] = useState<WorkWeeklyQaMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [visible, setVisible] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const operationKeysRef = useRef(new Map<string, string>());
  const questionRef = useRef<{ threadId: string; messageId: string } | null>(null);
  const stopReadRef = useRef<() => void>(() => {});
  const mutationRef = useRef<AbortController | null>(null);
  const skipInitialReadRef = useRef(false);
  const reviewId = review?.deletedAt ? null : review?.id ?? null;

  useEffect(() => {
    setLoadState("idle");
    setThread(null);
    setMessages([]);
    setDraft("");
    setBusy(false);
    setPending(false);
    setRefreshing(false);
    setError(null);
    setReadError(null);
    setNotice(null);
    operationKeysRef.current.clear();
    questionRef.current = null;
    skipInitialReadRef.current = false;
    return () => {
      stopReadRef.current();
      mutationRef.current?.abort();
      mutationRef.current = null;
    };
  }, [api, reviewId]);

  useEffect(() => {
    const onVisibility = () => {
      const nextVisible = document.visibilityState !== "hidden";
      if (!nextVisible) stopReadRef.current();
      skipInitialReadRef.current = false;
      setVisible(nextVisible);
    };
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (!active || !visible || !api || !enabled || !reviewId || busy) {
      setPending(false);
      setRefreshing(false);
      if (!active || !visible) skipInitialReadRef.current = false;
      return;
    }
    const controller = new AbortController();
    const deadline = Date.now() + 90_000;
    let stopped = false;
    let inFlight = false;
    let interval: ReturnType<typeof globalThis.setInterval>;
    let expiry: ReturnType<typeof globalThis.setTimeout>;
    const stop = () => {
      stopped = true;
      controller.abort();
      globalThis.clearInterval(interval);
      globalThis.clearTimeout(expiry);
    };
    stopReadRef.current = stop;
    const finish = () => {
      setPending(false);
      setRefreshing(false);
      stop();
    };
    const expire = () => {
      finish();
      setLoadState("ready");
      setNotice("本轮查询已满90秒，尚未收到最终结果。可点击“更新结果”继续查询，这不表示生成失败。");
    };
    const read = async () => {
      if (stopped || inFlight) return;
      if (Date.now() >= deadline) { expire(); return; }
      inFlight = true;
      setRefreshing(true);
      try {
        const response = await api.getWeeklyQa(reviewId, controller.signal);
        if (stopped) return;
        if (Date.now() >= deadline) { expire(); return; }
        if (response && response.thread.weeklyReviewId !== reviewId) return;
        const target = questionRef.current;
        const targetIndex = response?.messages.findIndex((message) => message.id === target?.messageId) ?? -1;
        // An older snapshot ending in an earlier answer cannot finish this question.
        if (target && response?.thread.id === target.threadId && !response.thread.clearedAt && targetIndex < 0) return;
        setThread(response?.thread ?? null);
        setMessages(response?.messages ?? []);
        setLoadState("ready");
        // Reading records successfully does not mean a rejected mutation succeeded.
        setReadError(null);
        if (!response || response.thread.clearedAt) {
          questionRef.current = null;
          finish();
          return;
        }
        const correspondingAnswer = target && response.thread.id === target.threadId
          ? response.messages[targetIndex + 1]
          : null;
        if (correspondingAnswer?.role === "assistant" && correspondingAnswer.answerStatus !== null) {
          questionRef.current = null;
          setNotice("这轮问答结果已更新。");
          finish();
          return;
        }
        const lastMessage = response.messages.at(-1);
        if (!target || response.thread.id !== target.threadId) {
          questionRef.current = lastMessage?.role === "user"
            ? { threadId: response.thread.id, messageId: lastMessage.id }
            : null;
        }
        if (questionRef.current) setPending(true);
        else finish();
      } catch (nextError) {
        if (stopped || controller.signal.aborted) return;
        setReadError(actionError(nextError));
        setLoadState((current) => current === "loading" ? "error" : current);
        if (nextError instanceof WorkReviewApiError && [401, 403, 404, 410].includes(nextError.status)) {
          setMessages([]);
          setThread(null);
          questionRef.current = null;
          setLoadState("error");
          finish();
        }
      } finally {
        inFlight = false;
        if (!stopped) setRefreshing(false);
      }
    };
    setLoadState((current) => current === "idle" ? "loading" : current);
    setPending(questionRef.current !== null);
    // Fixed wall-clock ticks; skip a tick while a previous GET is still in flight.
    // The independent deadline also aborts a hanging GET at 90 seconds.
    interval = globalThis.setInterval(() => void read(), 5_000);
    expiry = globalThis.setTimeout(expire, 90_000);
    if (!skipInitialReadRef.current) void read();
    else if (!questionRef.current) finish();
    skipInitialReadRef.current = false;
    return stop;
  }, [active, api, attempt, busy, enabled, reviewId, visible]);

  const submit = async () => {
    if (!api || !reviewId || !review || mutationRef.current || busy || pending || messages.at(-1)?.role === "user" || !draft.trim()) return;
    const question = draft.trim();
    const logicalKey = `weekly-qa:${review.id}:${thread?.version ?? "new"}:${question}`;
    setBusy(true);
    setError(null);
    setReadError(null);
    setNotice(null);
    stopReadRef.current();
    const controller = new AbortController();
    mutationRef.current = controller;
    try {
      const response = await api.askWeeklyQa(review.id, {
        question,
        expectedVersion: thread?.version ?? null,
        operationKey: keyForOperation(operationKeysRef, logicalKey, "weekly-qa")
      }, controller.signal);
      if (controller.signal.aborted) return;
      settleOperation(operationKeysRef, logicalKey);
      setThread(response.thread);
      setMessages(response.messages);
      setDraft("");
      const questionIndex = response.messages.findIndex((message) => message.id === response.run.questionMessageId);
      const answer = questionIndex >= 0 ? response.messages[questionIndex + 1] : null;
      questionRef.current = answer?.role === "assistant" && answer.answerStatus !== null
        ? null
        : { threadId: response.run.threadId, messageId: response.run.questionMessageId };
      skipInitialReadRef.current = active && document.visibilityState !== "hidden";
      setAttempt((value) => value + 1);
    } catch (nextError) {
      if (controller.signal.aborted) return;
      skipInitialReadRef.current = true;
      settleOperation(operationKeysRef, logicalKey, nextError);
      setError(actionError(nextError));
    } finally {
      if (!controller.signal.aborted) {
        mutationRef.current = null;
        setBusy(false);
      }
    }
  };

  const clear = async () => {
    if (!api || !reviewId || !review || !thread || busy || mutationRef.current) return;
    const logicalKey = `weekly-qa-clear:${review.id}:${thread.version}`;
    setBusy(true);
    setError(null);
    setReadError(null);
    setNotice(null);
    stopReadRef.current();
    const controller = new AbortController();
    mutationRef.current = controller;
    try {
      await api.clearWeeklyQa(review.id, {
        expectedVersion: thread.version,
        operationKey: keyForOperation(operationKeysRef, logicalKey, "weekly-qa-clear")
      }, controller.signal);
      if (controller.signal.aborted) return;
      settleOperation(operationKeysRef, logicalKey);
      setPending(false);
      setMessages([]);
      setThread(null);
      questionRef.current = null;
      setNotice("问答记录已清空；周回顾、会议、待办和 Evidence 没有改变。");
      setAttempt((value) => value + 1);
    } catch (nextError) {
      if (controller.signal.aborted) return;
      settleOperation(operationKeysRef, logicalKey, nextError);
      setError(actionError(nextError));
    } finally {
      if (!controller.signal.aborted) {
        mutationRef.current = null;
        setBusy(false);
      }
    }
  };

  return {
    busy,
    clear,
    draft,
    error: readError ?? error,
    loadState,
    messages,
    notice,
    pending,
    refreshing,
    reload: () => {
      if (mutationRef.current) return;
      stopReadRef.current();
      skipInitialReadRef.current = false;
      setReadError(null);
      setNotice(null);
      setAttempt((value) => value + 1);
    },
    setDraft,
    submit,
    thread
  };
}

function WeeklyQaPanel({
  api,
  enabled,
  loading,
  onReloadScope,
  onOpenSource,
  qa,
  review,
  scopeLoadError,
  verifierEnabled
}: Readonly<{
  api: WorkReviewV2CoreApi | null;
  enabled: boolean;
  loading: boolean;
  onReloadScope: () => void;
  onOpenSource: (sourceRef: string) => void;
  qa: QaController;
  review: WorkWeeklyReview | null;
  scopeLoadError: string | null;
  verifierEnabled: boolean;
}>) {
  const [confirmClear, setConfirmClear] = useState(false);
  const displayText = useWeeklyQaDisplayText(api, review, qa.thread?.id, qa.messages,
    enabled && verifierEnabled && !loading && !scopeLoadError);
  if (!enabled) {
    return <ProductState description="周回顾本身仍可查看；问答能力由服务端功能开关控制。" title="问问本周暂未开放" tone="empty" />;
  }
  if (scopeLoadError) {
    return <ProductState action={<button className={styles.secondaryButton} onClick={onReloadScope} type="button">重新加载</button>} description={scopeLoadError} title="暂时无法读取周回顾" tone="error" />;
  }
  if (loading) {
    return <ProductState title="正在切换周回顾范围…" tone="loading" />;
  }
  if (!review) {
    return <ProductState description="先在“本周回顾”中生成一份有可靠来源的回顾。" title="生成周回顾后可以继续提问" tone="empty" />;
  }
  if (qa.loadState === "idle" || qa.loadState === "loading") {
    return <ProductState title="正在读取问答记录…" tone="loading" />;
  }
  if (qa.loadState === "error") {
    return <ProductState action={<button className={styles.secondaryButton} disabled={qa.busy || qa.refreshing} onClick={qa.reload} type="button">更新结果</button>} description={qa.error ?? undefined} title="暂时无法读取问答记录" tone="error" />;
  }

  const canAsk = review.status === "ready" && verifierEnabled;
  const trailingQuestion = qa.messages.at(-1)?.role === "user" && !qa.pending;
  return (
    <section className={styles.qaPanel}>
      <header className={styles.qaHeader}>
        <div>
          <h2>问问本周</h2>
          <p>问题只在当前周和当前项目范围内查找 Work 来源；历史回答不会成为下一轮 Evidence。</p>
        </div>
        {qa.thread && qa.messages.length > 0 ? (
          <button className={styles.tertiaryButton} disabled={qa.busy} onClick={() => setConfirmClear(true)} type="button">清空记录</button>
        ) : null}
      </header>

      <button aria-busy={qa.refreshing} className={styles.secondaryButton} disabled={qa.busy || qa.refreshing} onClick={qa.reload} type="button">更新结果</button>

      {!verifierEnabled ? (
        <p className={styles.verifierNotice} role="status">QA 核验暂不可用。自由文本回答已隐藏，页面只保留服务端返回的来源入口。</p>
      ) : null}
      {review.status !== "ready" ? (
        <p className={styles.verifierNotice} role="status">
          {review.status === "stale" ? "来源已经变化。重新生成并完成核对后，才能继续提问。" : "周回顾尚未处于可问答状态。"}
        </p>
      ) : null}
      {qa.error ? <p className={styles.formError} role="alert">{qa.error}</p> : null}
      <p aria-live="polite" className={styles.liveNotice}>{qa.notice}</p>

      {qa.messages.length > 0 ? (
        <ol className={styles.qaMessages}>
          {qa.messages.map((message) => {
            const invalidated = message.answerStatus === "invalidated" || message.invalidatedAt !== null;
            const basedOnOldSnapshot = message.sourceSnapshotDigest !== review.sourceSnapshotDigest;
            const suppressAssistantText = message.role === "assistant"
              && (!verifierEnabled || invalidated || message.verifierProfile === null);
            return (
              <li data-role={message.role} key={message.id}>
                <header><span>{message.role === "user" ? "你" : "本周回答"}</span><time>{new Date(message.createdAt).toLocaleString("zh-CN")}</time></header>
                {basedOnOldSnapshot ? <p className={styles.oldSnapshotNotice}>基于旧的数据版本</p> : null}
                {message.role === "assistant" && message.answerStatus === "insufficient_evidence" ? (
                  <p>在本周已确认的工作记录中，没有找到足够依据回答这个问题。</p>
                ) : message.role === "assistant" && message.answerStatus === "failed" ? (
                  <p>这轮回答没有完成。当前记录中没有可展示的回答正文。</p>
                ) : suppressAssistantText ? (
                  <p>{invalidated ? "这条回答引用的来源已经失效，正文已隐藏。" : "回答正文需要通过 Weekly QA Verifier 后才会显示。"}</p>
                ) : (
                  <p>{message.text === null ? "回答尚未返回。" : displayText(message)}</p>
                )}
                {message.role === "assistant" && !invalidated ? <SourceButtons onOpenSource={onOpenSource} sourceRefs={message.sourceRefs} /> : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <ProductState description="可以从一个具体问题开始；系统不会使用互联网、其他周或其他产品的内容补造答案。" title="还没有问答记录" tone="empty" />
      )}
      {trailingQuestion ? <p className={styles.pendingBoundary}>尚未收到这轮问题的最终结果。点击“更新结果”查询已有任务，不会重新提交问题。</p> : null}
      {qa.pending ? <p className={styles.pendingBoundary} role="status">正在等待问答结果，每5秒查询一次，本轮最多90秒。</p> : null}

      <div className={styles.promptSuggestions} aria-label="建议问题">
        {QA_PROMPTS.map((prompt) => <button disabled={!canAsk || qa.busy || qa.pending} key={prompt} onClick={() => qa.setDraft(prompt)} type="button">{prompt}</button>)}
      </div>
      <form className={styles.qaComposer} onSubmit={(event) => { event.preventDefault(); void qa.submit(); }}>
        <label htmlFor="work-weekly-question">继续问这一周</label>
        <textarea
          disabled={!canAsk || qa.busy || qa.pending}
          id="work-weekly-question"
          maxLength={8_000}
          onChange={(event) => qa.setDraft(event.currentTarget.value)}
          placeholder={canAsk ? "例如：哪些事项仍在等待他人？" : "当前状态暂不能提问"}
          value={qa.draft}
        />
        <div>
          <p>只使用当前周、当前范围和当前有效 Work Evidence。</p>
          <button className={styles.primaryButton} disabled={!canAsk || qa.busy || qa.pending || trailingQuestion || !qa.draft.trim()} type="submit">{qa.busy ? "正在提交…" : "发送问题"}</button>
        </div>
      </form>

      <ProductDialog
        footer={(
          <>
            <button className={styles.secondaryButton} onClick={() => setConfirmClear(false)} type="button">取消</button>
            <button className={styles.dangerButton} onClick={() => { setConfirmClear(false); void qa.clear(); }} type="button">清空问答</button>
          </>
        )}
        onClose={() => setConfirmClear(false)}
        open={confirmClear}
        title="清空这份周回顾的问答记录？"
      >
        <p className={styles.dialogCopy}>只会清空当前周回顾的问答消息。周回顾、会议、待办、项目与 Evidence 都不会删除。</p>
      </ProductDialog>
    </section>
  );
}

export function WorkWeeklyPageFallback() {
  return <main className={styles.page}><ProductState title="正在打开周回顾…" tone="loading" /></main>;
}

export function WorkWeeklyPage() {
  const { user } = useWorkReview();
  // Never carry a previous account's review or QA into a new account.
  return <WorkWeeklyScopePage key={user.id} />;
}

function WorkWeeklyScopePage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { api, capabilities, capabilitiesStatus, refreshCapabilities } = useWorkReview();
  const v2Api = useMemo(() => asWorkReviewV2Api(api), [api]);
  const currentWeekStart = workWeeklyCurrentWeekStart();
  const weekStart = validWeekStart(searchParams.get("weekStart"), currentWeekStart);
  const rawScope = searchParams.get("scope");
  const rawProjectId = searchParams.get("projectId");
  const scopeKind: WorkWeeklyScopeKind = rawScope === "unassigned"
    ? "unassigned"
    : rawScope === "project" && rawProjectId
      ? "project"
      : "all";
  const projectId = scopeKind === "project" ? rawProjectId : null;
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadedScopeKey, setLoadedScopeKey] = useState<string | null>(null);
  const [projects, setProjects] = useState<WorkProject[]>([]);
  const [review, setReview] = useState<WorkWeeklyReview | null>(null);
  const [items, setItems] = useState<WorkWeeklyReviewItem[]>([]);
  const [sourceSummary, setSourceSummary] = useState<WorkWeeklySourceSummary | null>(null);
  const [latestGeneration, setLatestGeneration] = useState<WorkWeeklyScopeResponse["latestGeneration"]>(null);
  const [displayedGeneration, setDisplayedGeneration] = useState<WorkWeeklyScopeResponse["displayedGeneration"]>(null);
  const [activeTab, setActiveTab] = useState<WeeklyTab>("review");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pollStep, setPollStep] = useState(0);
  const [pollFailures, setPollFailures] = useState(0);
  const [pageVisible, setPageVisible] = useState(true);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteSection, setNoteSection] = useState<WorkWeeklySectionKind>("overview");
  const [noteText, setNoteText] = useState("");
  const [activeSourceRef, setActiveSourceRef] = useState<string | null>(null);
  const operationKeysRef = useRef(new Map<string, string>());
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const detailRequestRef = useRef<AbortController | null>(null);
  const scopeKey = `${weekStart}:${timeZone ?? "pending"}:${scopeKind}:${projectId ?? "none"}`;

  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  }, []);

  useEffect(() => () => detailRequestRef.current?.abort(), [scopeKey]);

  const canonicalHref = useMemo(() => {
    const query = new URLSearchParams({ weekStart, scope: scopeKind });
    if (scopeKind === "project" && projectId) query.set("projectId", projectId);
    return `${pathname}?${query.toString()}`;
  }, [pathname, projectId, scopeKind, weekStart]);

  useEffect(() => {
    const current = `${pathname}?${searchParams.toString()}`;
    if (current !== canonicalHref) router.replace(canonicalHref);
  }, [canonicalHref, pathname, router, searchParams]);

  useEffect(() => {
    if (editingId) editorRef.current?.focus();
  }, [editingId]);

  useEffect(() => {
    const onVisibility = () => {
      const visible = document.visibilityState !== "hidden";
      setPageVisible(visible);
      if (visible) {
        setPollStep(0);
        setPollFailures(0);
      }
    };
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const applyScopeResponse = (response: WorkWeeklyScopeResponse) => {
    setReview(response.review);
    setItems(response.items);
    setSourceSummary(response.sourceSummary);
    setLatestGeneration(response.latestGeneration ?? null);
    setDisplayedGeneration(response.displayedGeneration ?? null);
  };

  useEffect(() => {
    if (capabilitiesStatus !== "ready" || !capabilities.weekly || !v2Api || !timeZone) return;
    const controller = new AbortController();
    setLoadState("loading");
    setLoadedScopeKey(null);
    setBusyAction(null);
    setError(null);
    setNotice(null);
    const scope = { weekStart, timeZone, scopeKind, projectId } as const;
    const projectRequest = capabilities.projects
      ? v2Api.listProjects("all", controller.signal)
      : Promise.resolve([] as WorkProject[]);
    void Promise.all([v2Api.getWeeklyReview(scope, controller.signal), projectRequest]).then(([response, nextProjects]) => {
      if (controller.signal.aborted) return;
      applyScopeResponse(response);
      setProjects(nextProjects);
      setLoadedScopeKey(scopeKey);
      setLoadState("ready");
      setPollStep(0);
      setPollFailures(0);
    }).catch((nextError: unknown) => {
      if (controller.signal.aborted || nextError instanceof DOMException && nextError.name === "AbortError") return;
      setError(actionError(nextError));
      setLoadState("error");
    });
    return () => controller.abort();
  }, [attempt, capabilities.projects, capabilities.weekly, capabilitiesStatus, projectId, scopeKey, scopeKind, timeZone, v2Api, weekStart]);

  useEffect(() => {
    if (!v2Api || !review || !PROCESSING_STATUSES.has(review.status) || loadState !== "ready" || loadedScopeKey !== scopeKey || !pageVisible || pollFailures >= 3 || busyAction !== null) return;
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => {
      void v2Api.getWeeklyReviewDetail(review.id, controller.signal).then((response) => {
        if (controller.signal.aborted) return;
        setReview(response.review);
        setItems(response.items);
        setSourceSummary(response.sourceSummary);
        setLatestGeneration(response.latestGeneration ?? null);
        setDisplayedGeneration(response.displayedGeneration ?? null);
        setPollStep((value) => value + 1);
        setPollFailures(0);
        setError(null);
        if (!PROCESSING_STATUSES.has(response.review.status)) setNotice(null);
      }).catch((nextError: unknown) => {
        if (controller.signal.aborted || nextError instanceof DOMException && nextError.name === "AbortError") return;
        setPollFailures((value) => value + 1);
        if (pollFailures >= 2) {
          setError(actionError(nextError));
          setNotice("连续读取状态失败，自动查询已暂停。点击“刷新状态”继续查询；后台任务不会因此停止。");
        }
      });
    }, pollFailures > 0 ? 15_000 : pollStep < 5 ? 1_200 : pollStep < 10 ? 5_000 : pollStep < 20 ? 15_000 : 30_000);
    return () => {
      controller.abort();
      globalThis.clearTimeout(timer);
    };
  }, [busyAction, loadState, loadedScopeKey, pageVisible, pollFailures, pollStep, review, scopeKey, v2Api]);

  const scopeReady = loadState === "ready" && loadedScopeKey === scopeKey;
  const scopedReview = scopeReady ? review : null;
  const qa = useWeeklyQa({
    active: activeTab === "qa" && scopeReady,
    api: v2Api,
    enabled: capabilities.weeklyQa,
    review: scopedReview
  });

  const updateUrl = (nextWeekStart: string, nextScope: WorkWeeklyScopeKind, nextProjectId: string | null) => {
    const query = new URLSearchParams({ weekStart: nextWeekStart, scope: nextScope });
    if (nextScope === "project" && nextProjectId) query.set("projectId", nextProjectId);
    router.push(`${pathname}?${query.toString()}`);
  };

  const generate = async () => {
    if (!v2Api || !timeZone || busyAction) return;
    const logicalKey = `weekly-generate:${weekStart}:${scopeKind}:${projectId ?? "none"}:${review?.version ?? "new"}`;
    setBusyAction("generate");
    setError(null);
    setNotice(null);
    detailRequestRef.current?.abort();
    const controller = new AbortController();
    detailRequestRef.current = controller;
    try {
      const response = review
        ? await v2Api.regenerateWeeklyReview(review.id, {
          expectedVersion: review.version,
          operationKey: keyForOperation(operationKeysRef, logicalKey, "weekly-regenerate")
        }, controller.signal)
        : await v2Api.generateWeeklyReview({
          weekStart,
          timeZone,
          scopeKind,
          projectId,
          expectedVersion: null,
          operationKey: keyForOperation(operationKeysRef, logicalKey, "weekly-generate")
        }, controller.signal);
      if (controller.signal.aborted) return;
      settleOperation(operationKeysRef, logicalKey);
      setReview(response.review);
      setSourceSummary(response.review.sourceSummary);
      setLatestGeneration(null);
      setPollStep(0);
      setPollFailures(0);
      setNotice("已提交生成；个人补充独立保留。页面会自动检查状态，等待较久时每 30 秒检查一次。");
    } catch (nextError) {
      if (controller.signal.aborted) return;
      settleOperation(operationKeysRef, logicalKey, nextError);
      setError(actionError(nextError));
    } finally {
      if (!controller.signal.aborted) setBusyAction(null);
    }
  };

  const refreshDetail = async () => {
    if (!v2Api || !review) {
      setAttempt((value) => value + 1);
      return;
    }
    setBusyAction("refresh");
    setError(null);
    detailRequestRef.current?.abort();
    const controller = new AbortController();
    detailRequestRef.current = controller;
    try {
      const response = await v2Api.getWeeklyReviewDetail(review.id, controller.signal);
      if (controller.signal.aborted) return;
      setReview(response.review);
      setItems(response.items);
      setSourceSummary(response.sourceSummary);
      setLatestGeneration(response.latestGeneration ?? null);
      setDisplayedGeneration(response.displayedGeneration ?? null);
      setPollStep(0);
      setPollFailures(0);
      setNotice("已载入服务端最新状态。");
    } catch (nextError) {
      if (controller.signal.aborted) return;
      setError(actionError(nextError));
    } finally {
      if (!controller.signal.aborted) setBusyAction(null);
    }
  };

  const mutateItem = async (
    item: WorkWeeklyReviewItem,
    change: { text?: string; hidden?: boolean; sortOrder?: number },
    successMessage: string
  ) => {
    if (!v2Api || !review || busyAction) return null;
    const logicalKey = `weekly-item:${review.id}:${item.id}:${item.version}:${JSON.stringify(change)}`;
    setBusyAction(`item:${item.id}`);
    setError(null);
    setNotice(null);
    try {
      const next = await v2Api.updateWeeklyItem(review.id, item.id, {
        ...change,
        expectedVersion: item.version,
        operationKey: keyForOperation(operationKeysRef, logicalKey, "weekly-item")
      });
      settleOperation(operationKeysRef, logicalKey);
      const response = await v2Api.getWeeklyReviewDetail(review.id);
      setReview(response.review);
      setItems(response.items);
      setSourceSummary(response.sourceSummary);
      setLatestGeneration(response.latestGeneration ?? null);
      setDisplayedGeneration(response.displayedGeneration ?? null);
      setNotice(successMessage);
      return response.items.find((candidate) => candidate.id === next.id) ?? next;
    } catch (nextError) {
      settleOperation(operationKeysRef, logicalKey, nextError);
      setError(actionError(nextError));
      return null;
    } finally {
      setBusyAction(null);
    }
  };

  const reorderItem = async (item: WorkWeeklyReviewItem, direction: -1 | 1) => {
    const peers = items.filter((candidate) => (
      candidate.section === item.section
      && visibleItem(candidate)
      && (capabilities.weeklyVerifier || candidate.origin === "user_note")
    ))
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
    const index = peers.findIndex((candidate) => candidate.id === item.id);
    const neighbor = peers[index + direction];
    if (!neighbor || neighbor.sortOrder === item.sortOrder) return;
    const moved = await mutateItem(item, { sortOrder: neighbor.sortOrder }, direction < 0 ? "已上移一项。" : "已下移一项。");
    if (!moved || !v2Api || !review) return;
    const logicalKey = `weekly-item-order:${review.id}:${neighbor.id}:${neighbor.version}:${item.sortOrder}`;
    setBusyAction(`item:${neighbor.id}`);
    try {
      const nextNeighbor = await v2Api.updateWeeklyItem(review.id, neighbor.id, {
        sortOrder: item.sortOrder,
        expectedVersion: neighbor.version,
        operationKey: keyForOperation(operationKeysRef, logicalKey, "weekly-item-order")
      });
      settleOperation(operationKeysRef, logicalKey);
      const response = await v2Api.getWeeklyReviewDetail(review.id);
      setReview(response.review);
      setItems(response.items);
      setSourceSummary(response.sourceSummary);
      setLatestGeneration(response.latestGeneration ?? null);
      setDisplayedGeneration(response.displayedGeneration ?? null);
    } catch (nextError) {
      settleOperation(operationKeysRef, logicalKey, nextError);
      setError(`${actionError(nextError)} 已重新读取当前顺序。`);
      void refreshDetail();
    } finally {
      setBusyAction(null);
    }
  };

  const createNote = async () => {
    if (!v2Api || !review || busyAction || !noteText.trim()) return;
    const text = noteText.trim();
    const logicalKey = `weekly-note:${review.id}:${review.version}:${noteSection}:${text}`;
    setBusyAction("note");
    setError(null);
    try {
      await v2Api.createWeeklyUserNote(review.id, {
        section: noteSection,
        text,
        sortOrder: items.filter((item) => item.section === noteSection).length + 100,
        expectedVersion: review.version,
        operationKey: keyForOperation(operationKeysRef, logicalKey, "weekly-note")
      });
      settleOperation(operationKeysRef, logicalKey);
      const response = await v2Api.getWeeklyReviewDetail(review.id);
      setReview(response.review);
      setItems(response.items);
      setSourceSummary(response.sourceSummary);
      setLatestGeneration(response.latestGeneration ?? null);
      setDisplayedGeneration(response.displayedGeneration ?? null);
      setNoteOpen(false);
      setNoteText("");
      setNotice("个人补充已保存。它不会自动成为 Meeting Finding、Todo 或 Memory。");
    } catch (nextError) {
      settleOperation(operationKeysRef, logicalKey, nextError);
      setError(actionError(nextError));
    } finally {
      setBusyAction(null);
    }
  };

  const deleteNote = async (item: WorkWeeklyReviewItem) => {
    if (!v2Api || !review || busyAction) return;
    const logicalKey = `weekly-note-delete:${review.id}:${item.id}:${item.version}`;
    setBusyAction(`item:${item.id}`);
    setError(null);
    try {
      await v2Api.deleteWeeklyUserNote(review.id, item.id, {
        expectedVersion: item.version,
        operationKey: keyForOperation(operationKeysRef, logicalKey, "weekly-note-delete")
      });
      settleOperation(operationKeysRef, logicalKey);
      const response = await v2Api.getWeeklyReviewDetail(review.id);
      setReview(response.review);
      setItems(response.items);
      setSourceSummary(response.sourceSummary);
      setLatestGeneration(response.latestGeneration ?? null);
      setDisplayedGeneration(response.displayedGeneration ?? null);
      setNotice("个人补充已删除。");
    } catch (nextError) {
      settleOperation(operationKeysRef, logicalKey, nextError);
      setError(actionError(nextError));
    } finally {
      setBusyAction(null);
    }
  };

  const reset = async () => {
    if (!v2Api || !review || busyAction) return;
    const logicalKey = `weekly-reset:${review.id}:${review.version}`;
    setBusyAction("reset");
    setError(null);
    try {
      await v2Api.resetWeeklyReview(review.id, {
        expectedVersion: review.version,
        operationKey: keyForOperation(operationKeysRef, logicalKey, "weekly-reset")
      });
      settleOperation(operationKeysRef, logicalKey);
      const response = await v2Api.getWeeklyReviewDetail(review.id);
      setReview(response.review);
      setItems(response.items);
      setSourceSummary(response.sourceSummary);
      setLatestGeneration(response.latestGeneration ?? null);
      setDisplayedGeneration(response.displayedGeneration ?? null);
      setEditingId(null);
      setNotice("已恢复最近一次系统生成版本；个人补充仍然保留。");
    } catch (nextError) {
      settleOperation(operationKeysRef, logicalKey, nextError);
      setError(actionError(nextError));
    } finally {
      setBusyAction(null);
    }
  };

  const copy = async (sections: readonly WorkWeeklySectionKind[], successMessage: string) => {
    const lines = SECTION_ORDER.filter((section) => sections.includes(section)).flatMap((section) => {
      const sectionItems = items.filter((item) => (
        item.section === section
        && visibleItem(item)
        && (capabilities.weeklyVerifier || item.origin === "user_note")
      ));
      return sectionItems.length === 0
        ? []
        : [SECTION_LABELS[section], ...sectionItems.map((item) => `- ${itemText(item)}`), ""];
    });
    if (lines.length === 0) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      const partialNotice = displayedGeneration?.qualityStatus === "needs_review"
        ? `${PARTIAL_REVIEW_TITLE}\n以下是当前可用内容，仍有缺失或待核对事项。\n\n`
        : "";
      await navigator.clipboard.writeText(partialNotice + lines.join("\n").trim());
      setNotice(successMessage);
      setError(null);
    } catch {
      setError("浏览器没有允许复制。请选中回顾文字后手动复制。");
    }
  };

  if (capabilitiesStatus === "loading") return <WorkWeeklyPageFallback />;
  if (capabilitiesStatus === "error") {
    return <main className={styles.page}><ProductState action={<button className={styles.secondaryButton} onClick={refreshCapabilities} type="button">重新确认</button>} description="无法确认项目、周回顾与核验能力是否开放。" title="暂时无法打开周回顾" tone="error" /></main>;
  }
  if (!capabilities.weekly) {
    return <main className={styles.page}><ProductState description="会议、待办和会后纪要仍可继续使用。" title="周回顾暂未开放" tone="empty" /></main>;
  }
  if (!v2Api) {
    return <main className={styles.page}><ProductState description="当前客户端缺少 Work Review V2 合同，请刷新应用后重试。" title="周回顾接口尚未就绪" tone="error" /></main>;
  }

  const activeProjects = projects.filter((project) => project.status === "active");
  const archivedProjects = projects.filter((project) => project.status === "archived");
  const scopeValue = scopeKind === "project" ? `project:${projectId}` : scopeKind;
  const selectedProjectIsListed = projectId !== null && projects.some((project) => project.id === projectId);
  const visibleItems = items.filter(visibleItem);
  const hiddenItems = items.filter((item) => (
    item.hiddenAt !== null
    && item.invalidatedAt === null
    && item.verificationState !== "invalidated"
    && (capabilities.weeklyVerifier || item.origin === "user_note")
  ));
  const invalidatedCount = items.filter((item) => item.invalidatedAt !== null || item.verificationState === "invalidated").length;
  const narrativeItems = capabilities.weeklyVerifier
    ? visibleItems
    : visibleItems.filter((item) => item.origin === "user_note");
  const allSections = SECTION_ORDER;
  const decisionsSections = ["decisions"] as const;
  const actionSections = ["completed", "in_progress", "waiting_for_others"] as const;
  const generationProcessing = review !== null && PROCESSING_STATUSES.has(review.status);
  const hasVisibleSystemContent = narrativeItems.some((item) => item.origin === "gpt");
  const retainedCopy = latestGeneration?.displayingPreviousVersion
    ? "之前的回顾已保留，仅显示当前可用内容；这不表示之前的内容已通过完整性评估。"
    : review?.currentSystemVersion === 0
      ? "当前还没有已发布的系统回顾。个人补充独立保留。"
      : generationProcessing && hasVisibleSystemContent
        ? "当前可用内容仍在下方展示，本次生成尚未完成。"
        : "";
  const qualityInsufficient = latestGeneration?.qualityStatus === "insufficient";
  const outcomeUnknown = latestGeneration?.executionStatus === "unknown";
  const generationFailed = review?.status === "failed" || latestGeneration?.executionStatus === "failed";
  const generationNotice = generationProcessing ? (
    <ProductState
      action={<button className={styles.secondaryButton} disabled={busyAction !== null} onClick={() => void refreshDetail()} type="button">刷新状态</button>}
      description={`${review?.status === "queued" ? "请求已经进入处理队列。" : review?.status === "generating" ? "正在整理本周已确认来源。" : "正在核对事实与引用来源。"}${retainedCopy}`}
      title={review?.status === "queued" ? "等待生成本周回顾" : review?.status === "generating" ? "正在生成本周回顾" : "正在核对本周回顾"}
      tone="loading"
    />
  ) : qualityInsufficient ? (
    <ProductState
      action={<button className={styles.secondaryButton} disabled={busyAction !== null} onClick={() => void refreshDetail()} type="button">载入最新状态</button>}
      description={`本次内容未满足完整性要求，没有发布为新的系统回顾。${retainedCopy}`}
      title="本次回顾内容不完整"
      tone="status"
    />
  ) : outcomeUnknown || generationFailed ? (
    <ProductState
      action={<button className={styles.secondaryButton} disabled={busyAction !== null} onClick={() => void refreshDetail()} type="button">载入最新状态</button>}
      description={`${outcomeUnknown ? "暂时无法确认本次生成结果，请先载入最新状态。" : latestGeneration?.executionStatus === "failed" ? "本次生成运行未完成。" : "当前未提供本次生成的具体失败状态，请载入最新状态确认。"}${retainedCopy}`}
      title={outcomeUnknown ? "本次生成结果尚未确认" : "本次生成未完成"}
      tone="error"
    />
  ) : review && review.currentSystemVersion > 0 && (displayedGeneration ? displayedGeneration.qualityStatus === "not_assessed" : !latestGeneration || latestGeneration.qualityStatus === "not_assessed") ? (
    <p className={styles.verifierNotice} role="status">{displayedGeneration || latestGeneration ? "这份回顾尚未评估完整性。" : "当前未提供这份回顾的完整性评估状态。"}生成完成或来源已核对，不表示重要内容已完整覆盖。</p>
  ) : null;
  const reviewPanel = loadState === "idle" || loadState === "loading" ? (
    <ProductState title="正在读取这一周的来源与回顾…" tone="loading" />
  ) : loadState === "error" ? (
    <ProductState action={<button className={styles.secondaryButton} onClick={() => setAttempt((value) => value + 1)} type="button">重新加载</button>} description={error ?? undefined} title="暂时无法读取周回顾" tone="error" />
  ) : (
    <div className={styles.reviewPanel}>
      {sourceSummary ? <SourceSummary scope={review?.scope ?? null} summary={sourceSummary} /> : null}
      {!capabilities.weeklyVerifier ? (
        <p className={styles.verifierNotice} role="status">Weekly Verifier 暂未开放。页面只显示确定性来源覆盖与个人补充，不展示 GPT 自由叙述。</p>
      ) : null}
      {error ? <p className={styles.formError} role="alert">{error}</p> : null}
      <p aria-live="polite" className={styles.liveNotice}>{notice}</p>

      {!review ? (
        <ProductState
          action={capabilities.weeklyAi && capabilities.weeklyVerifier && sourceSummaryHasContent(sourceSummary) ? (
            <button className={styles.primaryButton} disabled={busyAction !== null} onClick={() => void generate()} type="button">{busyAction === "generate" ? "正在提交…" : "生成本周回顾"}</button>
          ) : undefined}
          description={sourceSummaryHasContent(sourceSummary)
            ? capabilities.weeklyAi && capabilities.weeklyVerifier
              ? "生成只会使用当前范围内已确认的 Work 来源。"
              : "来源已经准备好，但生成或核验能力尚未开放。"
            : "本周还没有足够的已确认会议结果或待办形成可靠回顾。"}
          title="这一周还没有回顾"
          tone="empty"
        />
      ) : (
        <>
          {generationNotice}
          {displayedGeneration?.qualityStatus === "needs_review" ? <PartialReviewNotice generation={displayedGeneration} key={`${review.id}:${displayedGeneration.systemVersion}`} onOpenSource={setActiveSourceRef} /> : null}
          {review.status === "stale" ? (
            <section className={styles.staleNotice} role="status">
              <div><h2>本周来源后来发生变化</h2><p>旧回顾没有被自动覆盖。确认变化后，可以主动重新生成。</p></div>
              {capabilities.weeklyAi && capabilities.weeklyVerifier ? <button className={styles.primaryButton} disabled={busyAction !== null} onClick={() => setConfirmAction("regenerate")} type="button">按最新来源重新生成</button> : null}
            </section>
          ) : null}
          <div className={styles.reviewActions}>
            <button className={styles.primaryButton} disabled={busyAction !== null} onClick={() => setNoteOpen(true)} type="button">增加个人补充</button>
            <button className={styles.secondaryButton} disabled={busyAction !== null || narrativeItems.length === 0} onClick={() => void copy(allSections, "已复制当前可见回顾全文。")} type="button">复制全文</button>
            <button className={styles.secondaryButton} disabled={busyAction !== null || !narrativeItems.some((item) => item.section === "decisions")} onClick={() => void copy(decisionsSections, "已复制决定部分。")} type="button">只复制决定</button>
            <button className={styles.secondaryButton} disabled={busyAction !== null || !narrativeItems.some((item) => actionSections.includes(item.section as typeof actionSections[number]))} onClick={() => void copy(actionSections, "已复制待办与等待他人部分。")} type="button">复制待办与等待他人</button>
            <button className={styles.tertiaryButton} disabled={busyAction !== null || generationProcessing || review.currentSystemVersion === 0} onClick={() => setConfirmAction("reset")} type="button">恢复系统版本</button>
            {capabilities.weeklyAi && capabilities.weeklyVerifier ? <button className={styles.tertiaryButton} disabled={busyAction !== null || generationProcessing} onClick={() => setConfirmAction("regenerate")} type="button">重新生成</button> : null}
          </div>
          <p className={styles.copyBoundary}>复制只使用当前屏幕可见、未失效的服务端 item；不会创建 Todo、Finding 或 Memory。</p>
          <p className={styles.copyBoundary}>来源核对仅检查原始记录是否支持相关表述，不保证内容质量或决定已最终确认；AI 建议不代表承诺。</p>

          {SECTION_ORDER.map((section) => {
            const sectionItems = narrativeItems.filter((item) => item.section === section)
              .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
            if (sectionItems.length === 0) return null;
            return (
              <section className={styles.weeklySection} key={section}>
                <header><h2>{SECTION_LABELS[section]}</h2>{section === "next_week" ? <span>AI 建议，不是承诺</span> : null}</header>
                <ol>
                  {sectionItems.map((item, index) => {
                    const editing = editingId === item.id;
                    return (
                      <li data-origin={item.origin} key={item.id}>
                        {editing ? (
                          <div className={styles.itemEditor}>
                            <label htmlFor={`weekly-item-${item.id}`}>编辑回顾内容</label>
                            <textarea id={`weekly-item-${item.id}`} maxLength={20_000} onChange={(event) => setEditText(event.currentTarget.value)} ref={editorRef} value={editText} />
                            <div><button className={styles.primaryButton} disabled={!editText.trim() || busyAction !== null} onClick={() => void mutateItem(item, { text: editText.trim() }, "修改已保存，并标记为用户编辑。 ").then((next) => { if (next) setEditingId(null); })} type="button">保存修改</button><button className={styles.secondaryButton} disabled={busyAction !== null} onClick={() => setEditingId(null)} type="button">取消</button></div>
                          </div>
                        ) : (
                          <>
                            <div className={styles.itemHeader}><span>{item.origin === "user_note" ? "个人补充" : item.userEditedAt ? "用户编辑" : item.verificationState === "qualified" ? "经限定核对" : "来源已核对"}</span>{item.origin === "gpt" && item.systemVersion !== review.currentSystemVersion ? <small>保留的旧版内容</small> : null}</div>
                            <p>{itemText(item)}</p>
                            <div className={styles.itemFooter}>
                            <SourceButtons onOpenSource={setActiveSourceRef} sourceRefs={item.sourceRefs} />
                            <div className={styles.itemActions}>
                              <button className={styles.textButton} disabled={busyAction !== null} onClick={() => { setEditingId(item.id); setEditText(itemText(item)); }} type="button">编辑</button>
                              {item.origin === "gpt" ? <button className={styles.textButton} disabled={busyAction !== null} onClick={() => void mutateItem(item, { hidden: true }, "这条内容已从当前浏览中隐藏。")} type="button">隐藏</button> : <button className={styles.dangerTextButton} disabled={busyAction !== null} onClick={() => void deleteNote(item)} type="button">删除补充</button>}
                              <button className={styles.textButton} disabled={busyAction !== null || index === 0} onClick={() => void reorderItem(item, -1)} type="button">上移</button>
                              <button className={styles.textButton} disabled={busyAction !== null || index === sectionItems.length - 1} onClick={() => void reorderItem(item, 1)} type="button">下移</button>
                            </div>
                            </div>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </section>
            );
          })}
          {!hasVisibleSystemContent && (generationProcessing || qualityInsufficient || generationFailed || outcomeUnknown) ? <ProductState description="个人补充与已隐藏内容独立保留；失效或未核验的正文不会恢复显示。" title="当前没有可展示的系统回顾" tone="empty" /> : narrativeItems.length === 0 ? <ProductState description={capabilities.weeklyVerifier ? "当前版本没有可展示的非空区块。" : "只有完成核验的 GPT 内容才会在这里显示。"} title="暂无可展示的回顾内容" tone="empty" /> : null}
          {hiddenItems.length > 0 ? (
            <section className={styles.hiddenItems}>
              <h2>已隐藏内容</h2>
              <ul>{hiddenItems.map((item) => <li key={item.id}><span>{itemText(item)}</span><button className={styles.textButton} disabled={busyAction !== null} onClick={() => void mutateItem(item, { hidden: false }, "这条内容已恢复显示。")} type="button">恢复</button></li>)}</ul>
            </section>
          ) : null}
          {invalidatedCount > 0 ? <p className={styles.invalidatedNotice}>{invalidatedCount} 条 GPT 内容因来源失效已隐藏，正文与失效引用不会继续显示。</p> : null}
        </>
      )}
    </div>
  );

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div><h1>本周回顾</h1><p>把一周内已确认的会议结果、待办变化与原话证据整理在同一个可信范围里。</p></div>
        {capabilities.projects ? <Link className={styles.manageLink} href="/work-review/projects">管理项目</Link> : null}
      </header>
      <section aria-label="周回顾范围" className={styles.scopeBar}>
        <div className={styles.weekControl}>
          <button aria-label="上一周" onClick={() => updateUrl(workWeeklyShiftWeek(weekStart, -1), scopeKind, projectId)} type="button">上一周</button>
          <div><strong>{weekStart === currentWeekStart ? "本周" : "所选周"}</strong><span>{weekRangeLabel(weekStart)}</span></div>
          <button aria-label="下一周" disabled={weekStart >= currentWeekStart} onClick={() => updateUrl(workWeeklyShiftWeek(weekStart, 1), scopeKind, projectId)} type="button">下一周</button>
          <button disabled={weekStart === currentWeekStart} onClick={() => updateUrl(currentWeekStart, scopeKind, projectId)} type="button">回到本周</button>
        </div>
        <label className={styles.scopeSelect}>
          <span>项目范围</span>
          <select
            disabled={!capabilities.projects || loadState === "loading"}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              const value = event.currentTarget.value;
              if (value.startsWith("project:")) updateUrl(weekStart, "project", value.slice("project:".length));
              else updateUrl(weekStart, value as "all" | "unassigned", null);
            }}
            value={scopeValue}
          >
            <option value="all">全部项目</option>
            <option value="unassigned">未分类</option>
            {scopeKind === "project" && projectId && !selectedProjectIsListed ? <option value={scopeValue}>当前项目范围</option> : null}
            {activeProjects.length > 0 ? <optgroup label="使用中的项目">{activeProjects.map((project) => <option key={project.id} value={`project:${project.id}`}>{project.name}</option>)}</optgroup> : null}
            {archivedProjects.length > 0 ? <optgroup label="已归档项目">{archivedProjects.map((project) => <option key={project.id} value={`project:${project.id}`}>{project.name}（已归档）</option>)}</optgroup> : null}
          </select>
        </label>
      </section>
      {!capabilities.projects ? <p className={styles.scopeNotice}>项目能力未开放；页面保持 URL 指定的服务端范围，但不提供项目切换。</p> : null}
      <ProductTabs
        ariaLabel="周回顾内容"
        items={[
          { id: "review", label: "本周回顾", panel: reviewPanel },
          { id: "qa", label: "问问本周", panel: <WeeklyQaPanel api={v2Api} enabled={capabilities.weeklyQa} loading={!scopeReady} onReloadScope={() => setAttempt((value) => value + 1)} onOpenSource={setActiveSourceRef} qa={qa} review={scopedReview} scopeLoadError={loadState === "error" ? error : null} verifierEnabled={capabilities.weeklyQaVerifier} /> }
        ]}
        onChange={(value) => setActiveTab(value as WeeklyTab)}
        value={activeTab}
      />

      <ProductDialog
        footer={(
          <>
            <button className={styles.secondaryButton} onClick={() => setConfirmAction(null)} type="button">取消</button>
            <button className={styles.primaryButton} onClick={() => { const action = confirmAction; setConfirmAction(null); if (action === "regenerate") void generate(); if (action === "reset") void reset(); }} type="button">确认{confirmAction === "reset" ? "恢复" : "重新生成"}</button>
          </>
        )}
        onClose={() => setConfirmAction(null)}
        open={Boolean(confirmAction)}
        title={confirmAction === "reset" ? "恢复最近的系统版本？" : "按最新来源重新生成？"}
      >
        <p className={styles.dialogCopy}>{confirmAction === "reset" ? "GPT item 的用户编辑与隐藏状态会恢复；个人补充会保留。会议、待办与 Evidence 不会改变。" : "当前内容不会被自动覆盖；新版本只有在完成事实核对并发布后才会替换系统内容。"}</p>
      </ProductDialog>

      <ProductDialog
        footer={(
          <>
            <button className={styles.secondaryButton} onClick={() => setNoteOpen(false)} type="button">取消</button>
            <button className={styles.primaryButton} disabled={!noteText.trim() || busyAction !== null} onClick={() => void createNote()} type="button">{busyAction === "note" ? "正在保存…" : "保存补充"}</button>
          </>
        )}
        onClose={() => setNoteOpen(false)}
        open={noteOpen}
        title="增加个人补充"
      >
        <div className={styles.noteForm}>
          <label><span>放入区块</span><select onChange={(event) => setNoteSection(event.currentTarget.value as WorkWeeklySectionKind)} value={noteSection}>{SECTION_ORDER.map((section) => <option key={section} value={section}>{SECTION_LABELS[section]}</option>)}</select></label>
          <label><span>补充内容</span><textarea maxLength={20_000} onChange={(event) => setNoteText(event.currentTarget.value)} value={noteText} /></label>
          <p>个人补充由你明确写入，不需要 Evidence，也不会自动成为待办、会议事实或长期记忆。</p>
        </div>
      </ProductDialog>

      {review ? <WorkWeeklySourceDialog api={v2Api} onClose={() => setActiveSourceRef(null)} onOpenSource={setActiveSourceRef} reviewId={review.id} sourceRef={activeSourceRef} /> : null}
    </main>
  );
}
