"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import {
  createDailyReflectionApi,
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

const KIND_LABELS: Record<DailyReflectionWorkingCardKind, string> = {
  idea: "想法",
  insight: "洞察",
  question: "问题",
  decision: "决定",
  event: "事件",
  action: "行动"
};

const STATUS_LABELS: Record<DailyReflectionWorkingCardStatus, string> = {
  generated: "刚整理",
  review_pending: "待查看",
  saved: "已保存",
  archived: "已归档",
  removed: "已移除"
};

type DailyReflectionCardLibraryProps = Readonly<{
  api?: DailyReflectionApi;
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
  now = defaultNow
}: DailyReflectionCardLibraryProps) {
  const api = useMemo(() => providedApi ?? createDailyReflectionApi(), [providedApi]);
  const [cards, setCards] = useState<DailyReflectionWorkingCardView[]>([]);
  const [total, setTotal] = useState(0);
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [cardKind, setCardKind] = useState<DailyReflectionWorkingCardKind | "">("");
  const [status, setStatus] = useState<"" | "saved" | "archived" | "removed">("");
  const [timeRange, setTimeRange] = useState<"all" | "30d">("all");
  const [sort, setSort] = useState<"updated_desc" | "created_desc" | "created_asc" | "title_asc">("updated_desc");
  const [selected, setSelected] = useState<DailyReflectionWorkingCardDetailResponse | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [contentDraft, setContentDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setError(cause instanceof Error ? cause.message : "My Cards 暂时无法加载。");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [api, cardKind, now, query, sort, status, timeRange]);

  useEffect(() => {
    const controller = new AbortController();
    void loadCards(controller.signal);
    return () => controller.abort();
  }, [loadCards]);

  const openCard = async (cardId: string) => {
    setBusy(true);
    setError(null);
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
  };

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
      await loadCards();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "卡片修改没有保存成功。");
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
      await loadCards();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "卡片状态没有更新成功。");
    } finally {
      setBusy(false);
    }
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setQuery(queryDraft.normalize("NFKC").trim());
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <Link className={styles.wordmark} href="/date-companion/modules" aria-label="返回空间选择">
          <span className={styles.wordmarkMark}>DB</span>
          <b>My Cards</b>
        </Link>
        <nav className={styles.productNav} aria-label="产品空间">
          <Link href="/date-companion/reflection">日常复盘</Link>
          <Link aria-current="page" className={styles.activeProductNav} href="/date-companion/reflection/cards">My Cards</Link>
        </nav>
      </header>

      <main className={`${styles.page} ${styles.cardLibraryPage}`}>
        <section className={styles.intro}>
          <div>
            <p className={styles.eyebrow}>我的工作卡片</p>
            <h1>我的 Cards</h1>
            <p>这里保存的是你认可的工作卡片。每张卡都保留原始复盘和可核对依据。</p>
          </div>
          <Link className={styles.secondaryButton} href="/date-companion/reflection">返回日常复盘</Link>
        </section>

        <form className={styles.cardLibraryFilters} onSubmit={submitSearch}>
          <label>
            <span>搜索</span>
            <input
              aria-label="搜索 My Cards"
              maxLength={200}
              onChange={(event) => setQueryDraft(event.target.value)}
              placeholder="标题、内容或标签"
              value={queryDraft}
            />
          </label>
          <label>
            <span>类型</span>
            <select aria-label="按类型筛选" onChange={(event) => setCardKind(event.target.value as DailyReflectionWorkingCardKind | "")} value={cardKind}>
              <option value="">全部类型</option>
              {Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>
            <span>状态</span>
            <select aria-label="按状态筛选" onChange={(event) => setStatus(event.target.value as typeof status)} value={status}>
              <option value="">活跃与归档</option>
              <option value="saved">已保存</option>
              <option value="archived">已归档</option>
              <option value="removed">已移除</option>
            </select>
          </label>
          <label>
            <span>时间</span>
            <select aria-label="按时间筛选" onChange={(event) => setTimeRange(event.target.value as typeof timeRange)} value={timeRange}>
              <option value="all">全部时间</option>
              <option value="30d">最近 30 天</option>
            </select>
          </label>
          <label>
            <span>排序</span>
            <select aria-label="卡片排序" onChange={(event) => setSort(event.target.value as typeof sort)} value={sort}>
              <option value="updated_desc">最近更新</option>
              <option value="created_desc">最新创建</option>
              <option value="created_asc">最早创建</option>
              <option value="title_asc">标题</option>
            </select>
          </label>
          <button className={styles.primaryButton} type="submit">搜索</button>
        </form>

        {error ? <p className={styles.inlineError} role="alert">{error}</p> : null}
        <div className={styles.cardLibraryLayout}>
          <section aria-labelledby="my-cards-list-title" className={styles.cardLibraryList}>
            <div className={styles.sectionHeading}>
              <h2 id="my-cards-list-title">My Cards</h2>
              <span>{total} 张</span>
            </div>
            {loading ? <p role="status">正在读取 Cards…</p> : cards.length === 0 ? (
              <p className={styles.historyEmpty}>还没有符合条件的 Card。</p>
            ) : (
              <ol className={styles.candidateList}>
                {cards.map((card) => (
                  <li className={styles.candidateCard} key={card.id}>
                    <div className={styles.candidateCardTop}>
                      <b>{card.title}</b>
                      <span className={styles.pendingBadge}>{STATUS_LABELS[card.status]}</span>
                    </div>
                    <p>{card.content}</p>
                    <div className={styles.cardLibraryMeta}>
                      <span>{KIND_LABELS[card.cardKind]}</span>
                      <span>{formatTime(card.createdAt)}</span>
                    </div>
                    <button className={styles.textButton} disabled={busy} onClick={() => void openCard(card.id)} type="button">查看详情</button>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <aside aria-label="Card 详情" className={styles.cardLibraryDetail}>
            {!selected ? <p>选择一张 Card 查看内容和依据。</p> : (
              <>
                <div className={styles.candidateCardTop}>
                  <h2>{selected.card.title}</h2>
                  <span className={styles.pendingBadge}>{STATUS_LABELS[selected.card.status]}</span>
                </div>
                <label className={styles.candidateEditor}>
                  <span>标题</span>
                  <input
                    aria-label="编辑 Card 标题"
                    disabled={busy || selected.card.status === "removed"}
                    maxLength={240}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    value={titleDraft}
                  />
                </label>
                <label className={styles.candidateEditor}>
                  <span>内容</span>
                  <textarea
                    aria-label="编辑 Card 内容"
                    disabled={busy || selected.card.status === "removed"}
                    maxLength={20_000}
                    onChange={(event) => setContentDraft(event.target.value)}
                    rows={5}
                    value={contentDraft}
                  />
                </label>
                {selected.card.status !== "removed" ? (
                  <button className={styles.secondaryButton} disabled={busy || !titleDraft.trim() || !contentDraft.trim()} onClick={() => void saveEdits()} type="button">保存修改</button>
                ) : null}
                <dl className={styles.cardLibraryDefinitionList}>
                  <div><dt>类型</dt><dd>{KIND_LABELS[selected.card.cardKind]}</dd></div>
                  <div><dt>创建时间</dt><dd>{formatTime(selected.card.createdAt)}</dd></div>
                  <div><dt>来源复盘</dt><dd>{selected.card.sourceUnavailable
                    ? "原始复盘已不可用"
                    : selected.card.sourceReflectionIds.map((reflectionId, index) => (
                      <Link href={`/date-companion/reflection?reflectionId=${encodeURIComponent(reflectionId)}`} key={reflectionId}>
                        {selected.card.sourceReflectionIds.length === 1 ? "查看来源复盘" : `查看来源复盘 ${index + 1}`}
                      </Link>
                    ))}</dd></div>
                </dl>
                <section aria-label="Card 依据">
                  <h3>依据</h3>
                  {selected.card.sourceUnavailable ? (
                    <p className={styles.evidenceUnavailable}>原始来源已不可用；Card 保留历史，但不会伪装成仍可核对。</p>
                  ) : (
                    <ol className={styles.evidenceList}>
                      {selected.card.evidence.map((evidence) => (
                        <li key={evidence.sourceSegmentId}>
                          <p>{evidence.text}</p>
                          <small>{Math.floor(evidence.startSeconds / 60)}:{String(Math.floor(evidence.startSeconds % 60)).padStart(2, "0")}</small>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
                <div className={styles.candidateActions}>
                  {selected.card.status === "saved" ? (
                    <button className={styles.secondaryButton} disabled={busy} onClick={() => void applyLifecycle("archive")} type="button">归档</button>
                  ) : null}
                  {selected.card.status === "archived" || selected.card.status === "removed" ? (
                    <button className={styles.primaryButton} disabled={busy} onClick={() => void applyLifecycle("restore")} type="button">恢复</button>
                  ) : null}
                  {selected.card.status === "saved" || selected.card.status === "archived" ? (
                    <button className={styles.dangerButton} disabled={busy} onClick={() => void applyLifecycle("remove")} type="button">从 My Cards 移除</button>
                  ) : null}
                </div>
              </>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}
