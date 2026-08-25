"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createDailyReflectionApi,
  DailyReflectionApiError,
  type DailyReflectionApi
} from "@/lib/client/daily-reflection-api";
import type {
  DailyReflectionWorkingCardDetailResponse,
  DailyReflectionWorkingCardView
} from "@/lib/domain/daily-reflection-api";
import type {
  DailyReflectionWorkingCardKind,
  DailyReflectionWorkingCardStatus
} from "@/lib/domain/daily-reflection-working-card";

import styles from "./daily-reflection.module.css";
import { ReflectionConfirmDialog } from "./reflection-confirm-dialog";
import { reflectionCardPath, reflectionSessionPath } from "./reflection-product";

const FILTER_KIND_LABELS = {
  insight: "洞察",
  question: "问题",
  decision: "决定",
  action: "行动"
} as const satisfies Partial<Record<DailyReflectionWorkingCardKind, string>>;

type ProductCardKind = keyof typeof FILTER_KIND_LABELS;

function cardKindLabel(kind: DailyReflectionWorkingCardKind) {
  return FILTER_KIND_LABELS[kind as ProductCardKind] ?? "暂未归类";
}

const STATUS_LABELS: Record<DailyReflectionWorkingCardStatus, string> = {
  generated: "等待保存",
  review_pending: "稍后再看",
  saved: "你的卡片",
  archived: "已归档",
  removed: "已从卡片库移除"
};

type DailyReflectionCardLibraryProps = Readonly<{
  api?: DailyReflectionApi;
  detailOnly?: boolean;
  embedded?: boolean;
  initialCardId?: string | null;
  now?: () => Date;
}>;

const defaultNow = () => new Date();

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function DailyReflectionCardLibrary({
  api: providedApi,
  detailOnly = false,
  embedded = false,
  initialCardId = null,
  now = defaultNow
}: DailyReflectionCardLibraryProps) {
  const api = useMemo(() => providedApi ?? createDailyReflectionApi(), [providedApi]);
  const [cards, setCards] = useState<DailyReflectionWorkingCardView[]>([]);
  const [total, setTotal] = useState(0);
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [cardKind, setCardKind] = useState<ProductCardKind | "">("");
  const [status, setStatus] = useState<"saved" | "archived" | "removed">("saved");
  const [timeRange, setTimeRange] = useState<"all" | "30d">("all");
  const [sort, setSort] = useState<"updated_desc" | "created_desc" | "created_asc" | "title_asc">("updated_desc");
  const [selected, setSelected] = useState<DailyReflectionWorkingCardDetailResponse | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [contentDraft, setContentDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<"remove" | "revoke" | null>(null);
  const openedInitialCardId = useRef<string | null>(null);

  const loadCards = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const createdFrom = timeRange === "30d"
        ? new Date(now().getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString()
        : undefined;
      const result = await api.listWorkingCards({
        ...(query ? { query } : {}),
        ...(cardKind ? { cardKind } : {}),
        ...(status ? { status } : {}),
        ...(createdFrom ? { createdFrom } : {}),
        sort,
        limit: 50,
        offset: 0
      }, signal);
      setCards(result.cards);
      setTotal(result.total);
    } catch (cause) {
      if (signal?.aborted) return;
      setError(cause instanceof Error ? cause.message : "卡片暂时无法加载。");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [api, cardKind, now, query, sort, status, timeRange]);

  useEffect(() => {
    if (detailOnly) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    void loadCards(controller.signal);
    return () => controller.abort();
  }, [detailOnly, loadCards]);

  const openCard = useCallback(async (cardId: string) => {
    setBusy(true);
    setError(null);
    setSelected(null);
    try {
      const result = await api.getWorkingCard(cardId);
      setSelected(result);
      setTitleDraft(result.card.title);
      setContentDraft(result.card.content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "卡片详情暂时无法加载。");
    } finally {
      setBusy(false);
    }
  }, [api]);

  useEffect(() => {
    if (!initialCardId || openedInitialCardId.current === initialCardId) return;
    openedInitialCardId.current = initialCardId;
    void openCard(initialCardId);
  }, [initialCardId, openCard]);

  const saveEdits = async () => {
    const card = selected?.card;
    const title = titleDraft.normalize("NFKC").trim();
    const content = contentDraft.normalize("NFKC").trim();
    if (!card || !title || !content || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.updateWorkingCard(card.id, {
        expectedVersion: card.version,
        title,
        content
      });
      setSelected(result);
      setTitleDraft(result.card.title);
      setContentDraft(result.card.content);
      if (!detailOnly) await loadCards();
    } catch (cause) {
      if (cause instanceof DailyReflectionApiError && cause.status === 409) {
        await openCard(card.id);
        if (!detailOnly) await loadCards();
        setError("这张卡片已经在其他页面更新，已重新加载最新内容。");
      } else {
        setError(cause instanceof Error ? cause.message : "卡片修改没有保存成功。");
      }
    } finally {
      setBusy(false);
    }
  };

  const applyLifecycle = async (operation: "archive" | "restore" | "remove") => {
    const card = selected?.card;
    if (!card || busy) return;
    setBusy(true);
    setError(null);
    try {
      const input = { expectedVersion: card.version };
      const result = operation === "archive"
        ? await api.archiveWorkingCard(card.id, input)
        : operation === "restore"
          ? await api.restoreWorkingCard(card.id, input)
          : await api.removeWorkingCard(card.id, input);
      setSelected(result);
      if (!detailOnly) await loadCards();
      if (operation === "remove") setConfirmAction(null);
    } catch (cause) {
      if (cause instanceof DailyReflectionApiError && cause.status === 409) {
        await openCard(card.id);
        if (!detailOnly) await loadCards();
        setError("这张卡片已经在其他页面更新，已重新加载最新内容。");
      } else {
        setError(cause instanceof Error ? cause.message : "卡片状态没有更新成功。");
      }
    } finally {
      setBusy(false);
    }
  };

  const revokeMemorySource = async () => {
    const card = selected?.card;
    if (
      !card
      || busy
      || (card.memoryLifecycleStatus !== "active"
        && card.memoryLifecycleStatus !== "revocation_requested")
    ) return;
    setBusy(true);
    setError(null);
    try {
      let expectedMemoryLifecycleVersion = card.memoryLifecycleVersion;
      if (card.memoryLifecycleStatus === "revocation_requested") {
        const recovery = await api.getWorkingCardMemoryRevocation(card.id);
        if (!recovery.found) {
          throw new Error("撤销进度无法恢复，请重新加载后再试。");
        }
        expectedMemoryLifecycleVersion =
          recovery.result.operation.requestedMemoryLifecycleVersion;
      }
      await api.revokeWorkingCardMemory(card.id, {
        expectedMemoryLifecycleVersion,
        idempotencyKey: `daily-reflection-card-revoke:${card.id}:v${expectedMemoryLifecycleVersion}`
      });
      const refreshed = await api.getWorkingCard(card.id);
      setSelected(refreshed);
      if (!detailOnly) await loadCards();
      setConfirmAction(null);
    } catch (cause) {
      if (cause instanceof DailyReflectionApiError && cause.status === 409) {
        await openCard(card.id);
        if (!detailOnly) await loadCards();
        setError("这张卡片已经在其他页面更新，已重新加载最新内容。");
      } else {
        setError(cause instanceof Error
          ? cause.message
          : "这条长期记忆暂时没有撤销成功。");
      }
    } finally {
      setBusy(false);
    }
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setQuery(queryDraft.normalize("NFKC").trim());
  };

  const selectedDetail = !selected && (loading || busy) ? (
    <p className={styles.productEmpty} role="status">正在读取这张卡片…</p>
  ) : !selected ? (
    <div className={styles.productEmpty}>
      <h2>{detailOnly ? "这张卡片暂时无法打开" : "选择一张卡片"}</h2>
      <p>{detailOnly ? "它可能已被移除，或当前无法读取。" : "在这里查看、编辑并核对卡片的原始来源。"}</p>
    </div>
  ) : (
    <article className={styles.cardDetailArticle}>
      <div className={styles.cardDetailHeading}>
        <div>
          <p className={styles.eyebrow}>{cardKindLabel(selected.card.cardKind)}</p>
          <h1>{selected.card.title}</h1>
        </div>
        <span className={styles.pendingBadge}>{STATUS_LABELS[selected.card.status]}</span>
      </div>
      <label className={styles.candidateEditor}>
        <span>标题</span>
        <input
          aria-label="编辑卡片标题"
          disabled={busy || selected.card.status === "removed"}
          maxLength={240}
          onChange={(event) => setTitleDraft(event.target.value)}
          value={titleDraft}
        />
      </label>
      <label className={styles.candidateEditor}>
        <span>正文</span>
        <textarea
          aria-label="编辑卡片正文"
          disabled={busy || selected.card.status === "removed"}
          maxLength={20_000}
          onChange={(event) => setContentDraft(event.target.value)}
          rows={8}
          value={contentDraft}
        />
      </label>
      {selected.card.status !== "removed" ? (
        <button className={styles.primaryButton} disabled={busy || !titleDraft.trim() || !contentDraft.trim()} onClick={() => void saveEdits()} type="button">保存修改</button>
      ) : null}
      <dl className={styles.cardLibraryDefinitionList}>
        <div><dt>类型</dt><dd>{cardKindLabel(selected.card.cardKind)}</dd></div>
        <div><dt>创建时间</dt><dd>{formatTime(selected.card.createdAt)}</dd></div>
        <div><dt>最近更新</dt><dd>{formatTime(selected.card.updatedAt)}</dd></div>
        <div><dt>长期记忆</dt><dd>{selected.card.memoryLifecycleStatus === "active"
          ? "已长期记住"
          : selected.card.memoryLifecycleStatus === "revocation_requested"
            ? "正在撤销"
            : selected.card.memoryLifecycleStatus === "revoked"
              ? "已撤销"
              : "暂未长期保存"}</dd></div>
        <div><dt>来源</dt><dd>{selected.card.sourceUnavailable
          ? "原始复盘已不可用"
          : selected.card.sourceReflectionIds.map((reflectionId, index) => (
            <Link href={reflectionSessionPath(reflectionId)} key={reflectionId}>
              {selected.card.sourceReflectionIds.length === 1 ? "查看来源复盘" : `查看来源复盘 ${index + 1}`}
            </Link>
          ))}</dd></div>
      </dl>
      <details className={styles.progressivePanel}>
        <summary>查看来源 · {selected.card.evidence.length} 段</summary>
        {selected.card.sourceUnavailable ? (
          <p className={styles.evidenceUnavailable}>原始来源已不可用；卡片仍然保留，但不会伪装成仍可核对。</p>
        ) : (
          <ol className={styles.evidenceList}>
            {selected.card.evidence.map((evidence) => (
              <li key={evidence.sourceSegmentId}>
                <p>{evidence.text}</p>
                <small>{evidence.effectiveOrigin === "user_reflection" ? "自己的复盘原话" : "真实交流原话"} · {Math.floor(evidence.startSeconds / 60)}:{String(Math.floor(evidence.startSeconds % 60)).padStart(2, "0")}</small>
                {selected.card.sourceReflectionIds.length === 1 ? (
                  <Link className={styles.textButton} href={`${reflectionSessionPath(selected.card.sourceReflectionIds[0]!)}?segment=${encodeURIComponent(evidence.sourceSegmentId)}`}>
                    在完整文字记录中查看
                  </Link>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </details>
      <div className={styles.candidateActions}>
        {selected.card.memoryLifecycleStatus === "active"
          || selected.card.memoryLifecycleStatus === "revocation_requested" ? (
          <button className={styles.dangerButton} disabled={busy} onClick={() => setConfirmAction("revoke")} type="button">
            撤销这条记忆
          </button>
        ) : null}
        {selected.card.status === "saved" ? (
          <button className={styles.secondaryButton} disabled={busy} onClick={() => void applyLifecycle("archive")} type="button">归档</button>
        ) : null}
        {selected.card.status === "archived" || selected.card.status === "removed" ? (
          <button className={styles.primaryButton} disabled={busy} onClick={() => void applyLifecycle("restore")} type="button">恢复</button>
        ) : null}
        {selected.card.status === "saved" || selected.card.status === "archived" ? (
          <button className={styles.dangerButton} disabled={busy} onClick={() => setConfirmAction("remove")} type="button">从卡片库移除</button>
        ) : null}
      </div>
    </article>
  );

  return (
    <div className={embedded ? styles.embeddedRoot : styles.root}>
      <main className={`${embedded ? styles.productPage : styles.page} ${styles.cardLibraryPage}`}>
        {!detailOnly ? (
          <>
            <section className={styles.productIntro}>
              <div><p className={styles.eyebrow}>思想资产</p><h1>卡片</h1><p>把值得继续使用的洞察、问题、决定和行动，留成属于你的卡片。</p></div>
              <Link className={styles.secondaryButton} href="/reflection/memory">查看长期记忆</Link>
            </section>
            <form className={styles.cardLibraryFilters} onSubmit={submitSearch}>
              <label><span>搜索</span><input aria-label="搜索卡片" maxLength={200} onChange={(event) => setQueryDraft(event.target.value)} placeholder="搜索标题或正文" value={queryDraft} /></label>
              <label><span>类型</span><select aria-label="按类型筛选" onChange={(event) => setCardKind(event.target.value as ProductCardKind | "")} value={cardKind}>
                <option value="">全部</option>
                {Object.entries(FILTER_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select></label>
              <label><span>状态</span><select aria-label="按状态筛选" onChange={(event) => setStatus(event.target.value as typeof status)} value={status}>
                <option value="saved">使用中</option><option value="archived">已归档</option><option value="removed">已移除</option>
              </select></label>
              <label><span>时间</span><select aria-label="按时间筛选" onChange={(event) => setTimeRange(event.target.value as typeof timeRange)} value={timeRange}>
                <option value="all">全部时间</option><option value="30d">最近 30 天</option>
              </select></label>
              <label><span>排序</span><select aria-label="卡片排序" onChange={(event) => setSort(event.target.value as typeof sort)} value={sort}>
                <option value="updated_desc">最近更新</option><option value="created_desc">最新创建</option><option value="created_asc">最早创建</option><option value="title_asc">按标题</option>
              </select></label>
              <button className={styles.secondaryButton} type="submit">筛选</button>
            </form>
          </>
        ) : <Link className={styles.backLink} href="/reflection/cards">← 返回卡片库</Link>}

        {error && !confirmAction ? <p className={styles.inlineError} role="alert">{error}</p> : null}
        {detailOnly ? selectedDetail : (
          <div className={styles.cardLibraryLayout}>
            <section aria-labelledby="reflection-cards-title" className={styles.cardLibraryList}>
              <div className={styles.sectionHeading}><h2 id="reflection-cards-title">你的卡片</h2><span>{total} 张</span></div>
              {loading ? <p role="status">正在读取卡片…</p> : cards.length === 0 ? (
                <div className={styles.productEmpty}><h3>这里还没有卡片</h3><p>完成一次复盘后，把真正想留下的重点保存到这里。</p><Link className={styles.primaryButton} href="/reflection/capture?new=1">开始表达</Link></div>
              ) : (
                <ol className={styles.candidateList}>
                  {cards.map((card) => (
                    <li className={styles.candidateCard} key={card.id}>
                      <div className={styles.candidateCardTop}><b>{card.title}</b><span className={styles.pendingBadge}>{STATUS_LABELS[card.status]}</span></div>
                      <p className={styles.cardExcerpt}>{card.content}</p>
                      <div className={styles.cardLibraryMeta}>
                        <span>{cardKindLabel(card.cardKind)}</span>
                        <span>{card.evidenceIds.length} 段来源</span><span>更新于 {formatTime(card.updatedAt)}</span>
                      </div>
                      <button className={`${styles.textButton} ${styles.desktopOnly}`} disabled={busy} onClick={() => void openCard(card.id)} type="button">快速查看</button>
                      <Link className={`${styles.textButton} ${styles.mobileOnly}`} href={reflectionCardPath(card.id)}>查看详情</Link>
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <aside aria-label="卡片快速详情" className={styles.cardLibraryDetail}>
              {selectedDetail}
              {selected ? <Link className={styles.textButton} href={reflectionCardPath(selected.card.id)}>打开完整页面</Link> : null}
            </aside>
          </div>
        )}
      </main>
      <ReflectionConfirmDialog busy={busy} confirmLabel={confirmAction === "revoke" ? "确认撤销" : "确认移除"} onCancel={() => setConfirmAction(null)} onConfirm={() => {
        if (confirmAction === "revoke") void revokeMemorySource();
        if (confirmAction === "remove") void applyLifecycle("remove");
      }} open={confirmAction !== null} title={confirmAction === "revoke" ? "撤销这条长期记忆？" : "从卡片库移除？"}>
        <p>{confirmAction === "revoke"
          ? "只撤销这张卡片对应的长期记忆。原始复盘和卡片仍会保留，你仍可查看来源。"
          : "卡片会从卡片库移除，但原始复盘不会删除。之后仍可恢复这张卡片。"}</p>
        {error ? <p className={styles.inlineError} role="alert">{error}</p> : null}
      </ReflectionConfirmDialog>
    </div>
  );
}
