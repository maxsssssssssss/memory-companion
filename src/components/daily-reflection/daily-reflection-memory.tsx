"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createDailyReflectionApi,
  DailyReflectionApiError,
  type DailyReflectionApi
} from "@/lib/client/daily-reflection-api";
import type {
  DailyReflectionMemoryDetailResponse,
  DailyReflectionMemoryView
} from "@/lib/domain/daily-reflection-memory-view";
import { ProductState } from "@/components/product-system/product-primitives";

import styles from "./daily-reflection.module.css";
import { ReflectionConfirmDialog } from "./reflection-confirm-dialog";
import { reflectionMemoryPath, reflectionSessionPath } from "./reflection-product";

const MEMORY_TYPE_LABELS: Record<DailyReflectionMemoryView["memoryType"], string> = {
  summary: "洞察",
  question: "未解决问题",
  decision: "决定",
  commitment: "行动约定",
  preference: "偏好",
  person_fact: "人物信息",
  event: "经历"
};

function epistemicCopy(memory: DailyReflectionMemoryView) {
  if (memory.epistemicStatus === "explicit_user_statement") return "你明确表达过";
  if (memory.epistemicStatus === "reported_event") return "你记录过的经历";
  return "系统整理的推测";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" })
    .format(new Date(`${value}T12:00:00+08:00`));
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" })
    .format(new Date(`${value}T12:00:00+08:00`));
}

function monthKey(value: string) {
  return value.slice(0, 7);
}

function formatMonth(value: string) {
  const [year = "", month = "1"] = value.split("-");
  return `${year} 年 ${Number(month)} 月`;
}

type MemoryTypeFilter = "all" | DailyReflectionMemoryView["memoryType"];

type DailyReflectionMemoryProps = Readonly<{
  api?: DailyReflectionApi;
  memoryId?: string | null;
}>;

export function DailyReflectionMemory({ api: providedApi, memoryId = null }: DailyReflectionMemoryProps) {
  const api = useMemo(() => providedApi ?? createDailyReflectionApi(), [providedApi]);
  const router = useRouter();
  const [memories, setMemories] = useState<DailyReflectionMemoryView[]>([]);
  const [detail, setDetail] = useState<DailyReflectionMemoryDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [quickViewMemoryId, setQuickViewMemoryId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<MemoryTypeFilter>("all");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const quickViewRef = useRef<HTMLDivElement>(null);
  const quickViewCloseRef = useRef<HTMLButtonElement>(null);
  const quickViewOpenerRef = useRef<HTMLElement | null>(null);
  const memoryPageHeadingRef = useRef<HTMLHeadingElement>(null);
  const busyRef = useRef(busy);
  const confirmOpenRef = useRef(confirmOpen);
  busyRef.current = busy;
  confirmOpenRef.current = confirmOpen;
  const memoryTypeCounts = useMemo(() => memories.reduce<Record<string, number>>((counts, memory) => ({
    ...counts,
    [memory.memoryType]: (counts[memory.memoryType] ?? 0) + 1
  }), {}), [memories]);
  const recentMemories = useMemo(() => memories.slice(0, 3), [memories]);
  const filteredMemories = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return memories.filter((memory) => {
      if (typeFilter !== "all" && memory.memoryType !== typeFilter) return false;
      if (!normalizedQuery) return true;
      return `${memory.title}\n${memory.content}\n${MEMORY_TYPE_LABELS[memory.memoryType]}`
        .toLocaleLowerCase("zh-CN")
        .includes(normalizedQuery);
    });
  }, [memories, query, typeFilter]);
  const groupedMemories = useMemo(() => {
    const groups = new Map<string, DailyReflectionMemoryView[]>();
    for (const memory of filteredMemories) {
      const key = monthKey(memory.recordingDate);
      const group = groups.get(key) ?? [];
      group.push(memory);
      groups.set(key, group);
    }
    return [...groups.entries()];
  }, [filteredMemories]);
  const quickViewMemory = useMemo(
    () => memories.find((memory) => memory.id === quickViewMemoryId) ?? null,
    [memories, quickViewMemoryId]
  );

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    setActionError(null);
    try {
      if (memoryId) {
        const response = await api.getMemory(memoryId, signal);
        if (signal?.aborted) return;
        setDetail(response);
      } else {
        const response = await api.listMemories(signal);
        if (signal?.aborted) return;
        setMemories(response.memories);
      }
    } catch (cause) {
      if (signal?.aborted) return;
      if (cause instanceof DailyReflectionApiError && cause.status === 404 && memoryId) {
        setLoadError("这条记忆已撤销，或当前无法读取。");
      } else {
        setLoadError("长期记忆暂时无法读取。");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [api, memoryId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const revoke = async (memory: DailyReflectionMemoryView) => {
    if (!memory || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const card = (await api.getWorkingCard(memory.cardId)).card;
      if (card.memoryLifecycleStatus === "revoked") {
        setConfirmOpen(false);
        if (memoryId) {
          router.replace("/reflection/memory");
        } else {
          quickViewOpenerRef.current = null;
          setMemories((current) => current.filter((item) => item.id !== memory.id));
          setQuickViewMemoryId(null);
          window.requestAnimationFrame(() => memoryPageHeadingRef.current?.focus());
        }
        return;
      }
      let expectedMemoryLifecycleVersion = card.memoryLifecycleVersion;
      if (card.memoryLifecycleStatus === "revocation_requested") {
        const recovery = await api.getWorkingCardMemoryRevocation(card.id);
        if (!recovery.found) throw new Error("撤销进度暂时无法恢复，请重新加载后再试。");
        expectedMemoryLifecycleVersion = recovery.result.operation.requestedMemoryLifecycleVersion;
      }
      await api.revokeWorkingCardMemory(card.id, {
        expectedMemoryLifecycleVersion,
        idempotencyKey: `daily-reflection-card-revoke:${card.id}:v${expectedMemoryLifecycleVersion}`
      });
      setConfirmOpen(false);
      if (memoryId) {
        router.replace("/reflection/memory");
        router.refresh();
      } else {
        quickViewOpenerRef.current = null;
        setMemories((current) => current.filter((item) => item.id !== memory.id));
        setQuickViewMemoryId(null);
        window.requestAnimationFrame(() => memoryPageHeadingRef.current?.focus());
      }
    } catch (cause) {
      setActionError(cause instanceof DailyReflectionApiError && cause.status === 409
        ? "这条记忆已经在其他页面更新，请重新加载最新内容。"
        : cause instanceof Error ? cause.message : "这条记忆暂时没有撤销成功。");
    } finally {
      setBusy(false);
    }
  };

  const openQuickView = useCallback((memoryIdToOpen: string, opener: HTMLElement) => {
    quickViewOpenerRef.current = opener;
    setActionError(null);
    setQuickViewMemoryId(memoryIdToOpen);
  }, []);

  const closeQuickView = useCallback(() => {
    if (busyRef.current || confirmOpenRef.current) return;
    setActionError(null);
    setQuickViewMemoryId(null);
  }, []);

  useEffect(() => {
    if (!quickViewMemoryId) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    quickViewCloseRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!confirmOpenRef.current && !busyRef.current) {
          event.preventDefault();
          setQuickViewMemoryId(null);
        }
        return;
      }
      if (event.key !== "Tab" || confirmOpenRef.current) return;
      const focusable = quickViewRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])"
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      quickViewOpenerRef.current?.focus();
    };
  }, [quickViewMemoryId]);

  const renderMemoryCard = (memory: DailyReflectionMemoryView, variant: "recent" | "archive") => (
    <article
      className={`${styles.memoryArchiveCard} ${variant === "recent" ? styles.memoryRecentCard : ""}`}
      data-memory-type={memory.memoryType}
    >
      <div className={styles.memoryCardTopline}>
        <span>{MEMORY_TYPE_LABELS[memory.memoryType]}</span>
        <span><i aria-hidden="true" />长期有效</span>
      </div>
      <h3>
        <button
          aria-controls={`memory-quick-view-${memory.id}`}
          aria-expanded={quickViewMemoryId === memory.id}
          aria-haspopup="dialog"
          onClick={(event) => openQuickView(memory.id, event.currentTarget)}
          type="button"
        >
          {memory.title}
        </button>
      </h3>
      <p className={styles.memoryCardExcerpt}>{memory.content}</p>
      <div className={styles.memoryCardFooter}>
        <span>{epistemicCopy(memory)}</span>
        <span>{memory.sourceCount} 段来源</span>
        <time dateTime={memory.recordingDate}>来自 {formatShortDate(memory.recordingDate)}</time>
      </div>
    </article>
  );

  if (memoryId) {
    return (
      <main className={`${styles.productPage} ${styles.memoryPage}`}>
        <Link className={styles.backLink} href="/reflection/memory" prefetch>← 返回记忆</Link>
        {loading ? <ProductState description="正在核对长期状态与来源。" title="正在读取这条记忆" tone="loading" /> : loadError ? (
          <ProductState action={<button className={styles.secondaryButton} onClick={() => void load()} type="button">重新尝试</button>} description={loadError} title="暂时无法打开这条记忆" tone="error" />
        ) : detail ? (
          <article className={styles.memoryDetailArticle} data-memory-type={detail.memory.memoryType}>
            <div className={`${styles.cardDetailHeading} ${styles.memoryDetailHeading}`}>
              <div>
                <p className={styles.memoryStateLine}>
                  <span>{MEMORY_TYPE_LABELS[detail.memory.memoryType]}</span>
                  <span><i aria-hidden="true" />当前有效</span>
                </p>
                <h1>{detail.memory.title}</h1>
              </div>
            </div>
            <p className={styles.readingText}>{detail.memory.content}</p>
            {detail.memory.epistemicCaution ? <p className={styles.cautionCopy}>这是系统根据你的表达整理出的理解，查看原话可以帮助你判断它是否准确。</p> : null}
            <dl className={styles.cardLibraryDefinitionList}>
              <div><dt>状态</dt><dd>已长期记住</dd></div>
              <div><dt>依据性质</dt><dd>{epistemicCopy(detail.memory)}</dd></div>
              <div><dt>首次出现</dt><dd>{formatDate(detail.memory.recordingDate)}</dd></div>
              <div><dt>来源数量</dt><dd>{detail.memory.sourceCount} 段</dd></div>
              <div><dt>范围</dt><dd>你的日常复盘</dd></div>
            </dl>
            <section className={styles.memoryTimelineSection} aria-labelledby="memory-evidence-title">
              <h2 id="memory-evidence-title">来源时间线</h2>
              <ol className={styles.evidenceTimeline}>
                {detail.memory.evidence.map((evidence) => (
                  <li key={evidence.sourceSegmentId}>
                    <time dateTime={evidence.recordingDate}>{evidence.sourceOrigin === "user_reflection"
                      ? `你在 ${formatDate(evidence.recordingDate)} 的复盘中提到`
                      : `在 ${formatDate(evidence.recordingDate)} 的交流中提到`}</time>
                    <p>{evidence.snippet}</p>
                    <Link href={`${reflectionSessionPath(evidence.reflectionId)}?segment=${encodeURIComponent(evidence.sourceSegmentId)}`}>查看来源</Link>
                  </li>
                ))}
              </ol>
            </section>
            {actionError && !confirmOpen ? <p className={styles.inlineError} role="alert">{actionError}</p> : null}
            <section className={styles.dangerZone} aria-labelledby="memory-danger-title">
              <div><h2 id="memory-danger-title">不再长期使用这条内容</h2><p>原始复盘与卡片仍会保留，只有长期上下文会被撤销。</p></div>
              <button className={styles.dangerButton} disabled={busy} onClick={() => setConfirmOpen(true)} type="button">撤销这条记忆</button>
            </section>
          </article>
        ) : null}
        <ReflectionConfirmDialog busy={busy} confirmLabel="确认撤销" onCancel={() => setConfirmOpen(false)} onConfirm={() => detail && void revoke(detail.memory)} open={confirmOpen} title="撤销这条长期记忆？">
          <p>撤销后，系统不再把它作为长期上下文。原始复盘和已保存卡片不会删除，你仍可查看当时的表达。</p>
          {actionError ? <p className={styles.inlineError} role="alert">{actionError}</p> : null}
        </ReflectionConfirmDialog>
      </main>
    );
  }

  return (
    <main className={`${styles.productPage} ${styles.memoryPage}`}>
      <section className={styles.memoryHero}>
        <div>
          <p className={styles.eyebrow}>你确认留下的内容</p>
          <h1 ref={memoryPageHeadingRef} tabIndex={-1}>长期记忆</h1>
          <p>重要的表达在这里沉淀下来，未来可以继续使用，也可以随时回看来源或撤销。</p>
          {!loading && memories.length > 0 ? <small>{memories.length} 条记忆正在长期保留</small> : null}
        </div>
        <Link className={styles.memoryLibraryLink} href="/reflection/cards" prefetch>进入卡片库 <span aria-hidden="true">→</span></Link>
      </section>
      {loading ? <ProductState description="正在找回你确认留下的长期内容。" title="正在读取长期记忆" tone="loading" /> : loadError ? (
        <ProductState action={<button className={styles.secondaryButton} onClick={() => void load()} type="button">重新尝试</button>} description="请稍后再试；已经长期保留的内容不会受影响。" title="长期记忆暂时没有加载完成" tone="error" />
      ) : memories.length === 0 ? (
        <ProductState action={<Link className={styles.primaryButton} href="/reflection/capture?new=1">开始一次复盘</Link>} description="只有你明确选择长期记住的内容，才会出现在这里。" title="还没有长期记忆" tone="empty" />
      ) : (
        <>
          <section className={styles.recentMemorySection} aria-labelledby="recent-memory-title">
            <div className={styles.memorySectionHeading}>
              <div><p className={styles.eyebrow}>最近留下</p><h2 id="recent-memory-title">最近记住</h2></div>
              <a href="#all-memories-title">查看全部 <span aria-hidden="true">↓</span></a>
            </div>
            <div aria-label="最近记住的内容" className={styles.recentMemoryGrid}>
              {recentMemories.map((memory) => <div key={memory.id}>{renderMemoryCard(memory, "recent")}</div>)}
            </div>
          </section>
          <section className={styles.memoryArchive} aria-labelledby="all-memories-title">
            <div className={styles.memoryArchiveHeader}>
              <div><p className={styles.eyebrow}>可追溯的长期内容</p><h2 id="all-memories-title">全部记忆</h2></div>
              <div className={styles.memoryArchiveTools}>
                <label>
                  <span className={styles.visuallyHidden}>搜索长期记忆</span>
                  <input autoComplete="off" name="memory-search" onChange={(event) => setQuery(event.target.value)} placeholder="搜索记忆内容或标题…" type="search" value={query} />
                </label>
                <label>
                  <span className={styles.visuallyHidden}>按类型筛选</span>
                  <select name="memory-type" onChange={(event) => setTypeFilter(event.target.value as MemoryTypeFilter)} value={typeFilter}>
                    <option value="all">全部类型 · {memories.length}</option>
                    {Object.entries(memoryTypeCounts).map(([type, count]) => (
                      <option key={type} value={type}>{MEMORY_TYPE_LABELS[type as keyof typeof MEMORY_TYPE_LABELS]} · {count}</option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
            {groupedMemories.length === 0 ? (
              <div className={styles.memorySearchEmpty} role="status">
                <h3>没有找到相符的记忆</h3>
                <p>换一个关键词或类型试试，现有长期内容不会被修改。</p>
                <button className={styles.textButton} onClick={() => { setQuery(""); setTypeFilter("all"); }} type="button">清除筛选</button>
              </div>
            ) : (
              <div className={styles.memoryMonthList}>
                {groupedMemories.map(([month, monthMemories]) => (
                  <section className={styles.memoryMonthGroup} key={month} aria-labelledby={`memory-month-${month}`}>
                    <div className={styles.memoryMonthHeading}>
                      <span aria-hidden="true" />
                      <h3 id={`memory-month-${month}`}>{formatMonth(month)}</h3>
                      <small>{monthMemories.length}</small>
                    </div>
                    <div className={styles.memoryArchiveGrid}>
                      {monthMemories.map((memory) => <div key={memory.id}>{renderMemoryCard(memory, "archive")}</div>)}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </section>
        </>
      )}
      {quickViewMemory ? (
        <div className={styles.memoryQuickViewBackdrop} onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeQuickView();
        }} role="presentation">
          <section
            aria-labelledby={`memory-quick-view-title-${quickViewMemory.id}`}
            aria-modal="true"
            className={styles.memoryQuickView}
            data-memory-type={quickViewMemory.memoryType}
            id={`memory-quick-view-${quickViewMemory.id}`}
            ref={quickViewRef}
            role="dialog"
          >
            <header className={styles.memoryQuickViewHeader}>
              <div className={styles.memoryCardTopline}>
                <span>{MEMORY_TYPE_LABELS[quickViewMemory.memoryType]}</span>
                <span><i aria-hidden="true" />长期有效</span>
              </div>
              <button aria-label="关闭记忆预览" className={styles.memoryQuickViewClose} onClick={closeQuickView} ref={quickViewCloseRef} type="button">×</button>
            </header>
            <div className={styles.memoryQuickViewBody}>
              <h2 id={`memory-quick-view-title-${quickViewMemory.id}`}>{quickViewMemory.title}</h2>
              <p className={styles.memoryQuickViewContent}>{quickViewMemory.content}</p>
              {quickViewMemory.epistemicCaution ? <p className={styles.cautionCopy}>这是根据你的表达整理出的理解，查看原话可以帮助你判断它是否准确。</p> : null}
              <dl className={styles.memoryQuickViewMeta}>
                <div><dt>内容性质</dt><dd>{epistemicCopy(quickViewMemory)}</dd></div>
                <div><dt>来源日期</dt><dd>{formatDate(quickViewMemory.recordingDate)}</dd></div>
                <div><dt>原话依据</dt><dd>{quickViewMemory.sourceCount} 段</dd></div>
              </dl>
              <section className={styles.memorySourcePreview} aria-labelledby={`memory-source-preview-${quickViewMemory.id}`}>
                <div><h3 id={`memory-source-preview-${quickViewMemory.id}`}>来源预览</h3><span>保留当时的表达</span></div>
                {quickViewMemory.evidence.slice(0, 2).map((evidence) => (
                  <blockquote key={evidence.sourceSegmentId}>
                    <p>“{evidence.snippet}”</p>
                    <footer>
                      <span>{evidence.sourceOrigin === "user_reflection" ? "你的复盘" : "真实交流"} · {formatShortDate(evidence.recordingDate)}</span>
                      <Link href={`${reflectionSessionPath(evidence.reflectionId)}?segment=${encodeURIComponent(evidence.sourceSegmentId)}`}>查看原话</Link>
                    </footer>
                  </blockquote>
                ))}
              </section>
              {actionError && !confirmOpen ? <p className={styles.inlineError} role="alert">{actionError}</p> : null}
            </div>
            <footer className={styles.memoryQuickViewActions}>
              <button className={styles.memoryQuickViewRevoke} disabled={busy} onClick={() => setConfirmOpen(true)} type="button">撤销这条记忆</button>
              <Link className={styles.primaryButton} href={reflectionMemoryPath(quickViewMemory.id)} prefetch>查看完整详情 <span aria-hidden="true">→</span></Link>
            </footer>
          </section>
        </div>
      ) : null}
      <ReflectionConfirmDialog busy={busy} confirmLabel="确认撤销" onCancel={() => setConfirmOpen(false)} onConfirm={() => quickViewMemory && void revoke(quickViewMemory)} open={confirmOpen} title="撤销这条长期记忆？">
        <p>撤销后，系统不再把它作为长期上下文。原始复盘和已保存卡片不会删除，你仍可查看当时的表达。</p>
        {actionError ? <p className={styles.inlineError} role="alert">{actionError}</p> : null}
      </ReflectionConfirmDialog>
    </main>
  );
}
