"use client";

import Link from "next/link";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { createDailyReflectionApi } from "@/lib/client/daily-reflection-api";
import { ProductState } from "@/components/product-system/product-primitives";
import type {
  DailyReflectionDailyReturnResponse,
  DailyReflectionReturnEvidence,
  DailyReflectionReturnItem,
  DailyReflectionWeeklyItem,
  DailyReflectionWeeklyReflectionResponse
} from "@/lib/domain/daily-reflection-return";

import styles from "./daily-reflection.module.css";
import { armCaptureContextIntent } from "./reflection-capture-intent";
import { reflectionCardPath, reflectionSessionPath } from "./reflection-product";

type DailyReflectionReturnApi = Readonly<{
  getDailyReturn(input?: { date?: string }, signal?: AbortSignal): Promise<DailyReflectionDailyReturnResponse>;
  getWeeklyReflection(input?: { endDate?: string }, signal?: AbortSignal): Promise<DailyReflectionWeeklyReflectionResponse>;
}>;

type DailyReflectionReturnProps = Readonly<{
  api?: DailyReflectionReturnApi;
  embedded?: boolean;
}>;

type DisplayItem = DailyReflectionReturnItem | DailyReflectionWeeklyItem;
type ReturnTab = "daily" | "weekly";
type QuickViewState = Readonly<{ item: DisplayItem; referenceDate: string }>;

const SAFE_EPISTEMIC_STATUSES = new Set(["explicit_user_statement", "reported_event"]);
const DAILY_LABELS: Record<DailyReflectionReturnItem["type"], string> = {
  open_loop: "仍值得继续",
  reflection_prompt: "现在是否有变化",
  resurfaced_memory: "与过去相连"
};
const WEEKLY_LABELS: Record<DailyReflectionWeeklyItem["type"], string> = {
  repeated_theme: "反复出现的主题",
  changed_decision: "发生变化的决定",
  open_commitment: "仍在继续的承诺",
  emerging_idea: "正在形成的想法"
};
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");
const RETURN_DATE_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  day: "numeric",
  month: "numeric",
  timeZone: "Asia/Shanghai",
  year: "numeric"
});
const RETURN_SHORT_DATE_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  day: "numeric",
  month: "numeric",
  timeZone: "Asia/Shanghai"
});

function formatTimestamp(seconds: number) {
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3_600);
  const minutes = Math.floor((rounded % 3_600) / 60);
  const remaining = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function parseDateKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
    ? Date.UTC(year, month - 1, day)
    : Number.NaN;
}

function dateAtShanghaiNoon(value: string) {
  return new Date(`${value}T12:00:00+08:00`);
}

function formatFullDate(value: string) {
  const parts = RETURN_DATE_FORMAT.formatToParts(dateAtShanghaiNoon(value));
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${year} 年 ${month} 月 ${day} 日`;
}

function formatShortDate(value: string) {
  const parts = RETURN_SHORT_DATE_FORMAT.formatToParts(dateAtShanghaiNoon(value));
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${month} 月 ${day} 日`;
}

function relativeDate(value: string, referenceDate: string) {
  const distance = Math.round((parseDateKey(referenceDate) - parseDateKey(value)) / 86_400_000);
  if (!Number.isFinite(distance)) return "";
  if (distance <= 0) return "当天";
  return `${distance} 天前`;
}

function evidenceDates(item: DisplayItem) {
  const dates = "dates" in item ? item.dates : item.evidence.map((source) => source.recordingDate);
  return [...new Set(dates)].sort();
}

function sourceSummary(item: DisplayItem) {
  return "sourceCount" in item ? `${item.sourceCount} 条来源` : `${item.evidence.length} 段来源`;
}

function dateSummary(item: DisplayItem, referenceDate: string) {
  const dates = evidenceDates(item);
  if (dates.length === 0) return "";
  if (dates.length === 1) {
    return `记录于 ${formatShortDate(dates[0])} · ${relativeDate(dates[0], referenceDate)}`;
  }
  return `${formatShortDate(dates[0])}—${formatShortDate(dates.at(-1) as string)} · ${dates.length} 个记录日`;
}

function returnLabel(item: DisplayItem) {
  return item.type in DAILY_LABELS
    ? DAILY_LABELS[item.type as DailyReflectionReturnItem["type"]]
    : WEEKLY_LABELS[item.type as DailyReflectionWeeklyItem["type"]];
}

function sourceContext(item: DailyReflectionReturnEvidence) {
  return item.sourceOrigin === "user_reflection"
    ? `你在 ${formatShortDate(item.recordingDate)} 的复盘中提到`
    : `在 ${formatShortDate(item.recordingDate)} 的交流中提到`;
}

function isDisplayable(item: DisplayItem) {
  return item.sourceCardIds.length > 0
    && item.evidence.length > 0
    && item.evidenceIds.length > 0
    && item.epistemicStatuses.every((status) => SAFE_EPISTEMIC_STATUSES.has(status));
}

function capturePath() {
  return "/reflection/capture?new=1";
}

function armCaptureContext(item: DisplayItem) {
  armCaptureContextIntent(`${item.title}：${item.body}`);
}

function uniqueCardPath(item: DisplayItem) {
  return item.sourceCardIds.length === 1 ? reflectionCardPath(item.sourceCardIds[0]) : null;
}

function EvidenceList({ evidence }: { evidence: DailyReflectionReturnEvidence[] }) {
  return (
    <ol className={styles.returnEvidenceList}>
      {evidence.map((item) => (
        <li key={`${item.cardId}:${item.sourceSegmentId}`}>
          <div className={styles.returnEvidenceMeta}>
            <span>{sourceContext(item)}</span>
            <time>{formatTimestamp(item.startSeconds)}</time>
          </div>
          <blockquote>{item.snippet}</blockquote>
          <Link
            className={styles.textButton}
            href={`${reflectionSessionPath(item.reflectionId)}?segment=${encodeURIComponent(item.sourceSegmentId)}`}
          >查看原话</Link>
        </li>
      ))}
    </ol>
  );
}

function ReturnQuickView({ onClose, state }: Readonly<{ onClose(): void; state: QuickViewState }>) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = `return-quick-view-title-${state.item.id}`;
  const cardPath = uniqueCardPath(state.item);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const body = document.body;
    const previousOverflow = body.style.overflow;
    const previousPaddingRight = body.style.paddingRight;
    const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
        .filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1) as HTMLElement;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPaddingRight;
    };
  }, [onClose]);

  return (
    <div className={styles.returnQuickViewBackdrop} onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.returnQuickView}
        id="return-quick-view"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className={styles.returnQuickViewHeader}>
          <span className={styles.returnType} data-return-kind={state.item.type}>{returnLabel(state.item)}</span>
          <button aria-label="关闭回看详情" className={styles.iconButton} onClick={onClose} ref={closeButtonRef} type="button">×</button>
        </header>
        <div className={styles.returnQuickViewBody}>
          <button
            aria-expanded="true"
            className={styles.returnQuickViewTitle}
            id={titleId}
            onClick={onClose}
            type="button"
          >{state.item.title}</button>
          <section className={styles.returnRecordedContent}>
            <p>{state.item.type === "reflection_prompt" ? "现在可以想一想" : "你当时记录的内容"}</p>
            <blockquote>{state.item.body}</blockquote>
          </section>
          <div className={styles.returnQuickViewMeta}>
            <span>{dateSummary(state.item, state.referenceDate)}</span>
            <span>{sourceSummary(state.item)}</span>
          </div>
          <section aria-labelledby={`${titleId}-sources`} className={styles.returnQuickViewSources}>
            <h3 id={`${titleId}-sources`}>来源预览</h3>
            <EvidenceList evidence={state.item.evidence} />
          </section>
        </div>
        <footer className={styles.returnQuickViewActions}>
          <Link className={styles.secondaryButton} href={capturePath()} onClick={() => armCaptureContext(state.item)}>继续想</Link>
          {cardPath ? <Link className={styles.primaryButton} href={cardPath}>打开原卡片</Link> : null}
        </footer>
      </div>
    </div>
  );
}

function DailyPrimaryCard({ expanded, index, item, onOpen, referenceDate, total }: Readonly<{
  expanded: boolean;
  index: number;
  item: DailyReflectionReturnItem;
  onOpen(event: ReactMouseEvent<HTMLButtonElement>, item: DisplayItem): void;
  referenceDate: string;
  total: number;
}>) {
  const cardPath = uniqueCardPath(item);
  return (
    <article className={styles.returnPrimaryCard} data-return-kind={item.type}>
      <div className={styles.returnCardTopline}>
        <span className={styles.returnType} data-return-kind={item.type}>{returnLabel(item)}</span>
        <span>{index + 1} / {total}</span>
      </div>
      <h2><button
        aria-controls="return-quick-view"
        aria-expanded={expanded}
        className={styles.returnTitleButton}
        onClick={(event) => onOpen(event, item)}
        type="button"
      >{item.title}</button></h2>
      <div className={styles.returnPrimaryBody}>
        <p>{item.type === "reflection_prompt" ? "现在可以想一想" : "你曾记录"}</p>
        <blockquote>{item.body}</blockquote>
      </div>
      <div className={styles.returnCardFooter}>
        <span>{dateSummary(item, referenceDate)}</span>
        <button className={styles.returnSourceLink} onClick={(event) => onOpen(event, item)} type="button">
          {sourceSummary(item)}
        </button>
      </div>
      <div className={styles.returnPrimaryActions}>
        <Link className={styles.secondaryButton} href={capturePath()} onClick={() => armCaptureContext(item)}>继续想</Link>
        {cardPath ? <Link className={styles.primaryButton} href={cardPath}>打开原卡片</Link> : null}
      </div>
    </article>
  );
}

function DailySecondaryItem({ expanded, item, onOpen, onSelect, referenceDate }: Readonly<{
  expanded: boolean;
  item: DailyReflectionReturnItem;
  onOpen(event: ReactMouseEvent<HTMLButtonElement>, item: DisplayItem): void;
  onSelect(): void;
  referenceDate: string;
}>) {
  const latestDate = evidenceDates(item).at(-1);
  return (
    <li className={styles.returnSecondaryItem} data-return-kind={item.type}>
      <button className={styles.returnSecondarySelect} onClick={onSelect} type="button">
        <span className={styles.returnType} data-return-kind={item.type}>{returnLabel(item)}</span>
        <small>{latestDate ? `${formatShortDate(latestDate)} · ${relativeDate(latestDate, referenceDate)}` : ""}</small>
        <strong>{item.title}</strong>
        <span>{item.body}</span>
        <em>{sourceSummary(item)} <span aria-hidden="true">→</span></em>
      </button>
      <button
        aria-controls="return-quick-view"
        aria-expanded={expanded}
        aria-label={`展开“${item.title}”的来源`}
        className={styles.returnSecondarySource}
        onClick={(event) => onOpen(event, item)}
        type="button"
      >查看来源</button>
    </li>
  );
}

function WeeklySection({ expandedItemId, items, label, onOpen, referenceDate, type }: Readonly<{
  expandedItemId: string | null;
  items: DailyReflectionWeeklyItem[];
  label: string;
  onOpen(event: ReactMouseEvent<HTMLButtonElement>, item: DisplayItem): void;
  referenceDate: string;
  type: DailyReflectionWeeklyItem["type"];
}>) {
  const displayable = items.filter(isDisplayable);
  if (displayable.length === 0) return null;
  return (
    <section aria-labelledby={`weekly-${type}`} className={styles.returnWeeklySection} data-return-kind={type}>
      <div className={styles.returnWeeklySectionHeading}>
        <h2 id={`weekly-${type}`}>{label}</h2>
        <span>{displayable.length}</span>
      </div>
      <ol className={styles.returnWeeklyItems}>
        {displayable.map((item) => (
          <li key={item.id}>
            <button
              aria-controls="return-quick-view"
              aria-expanded={expandedItemId === item.id}
              className={styles.returnWeeklyTitle}
              onClick={(event) => onOpen(event, item)}
              type="button"
            >{item.title}</button>
            <p>{item.body}</p>
            <div><span>{dateSummary(item, referenceDate)}</span><span>{sourceSummary(item)}</span></div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function DailyReflectionReturn({ api: providedApi, embedded = false }: DailyReflectionReturnProps) {
  const api = useMemo(
    () => (providedApi ?? createDailyReflectionApi()) as unknown as DailyReflectionReturnApi,
    [providedApi]
  );
  const [daily, setDaily] = useState<DailyReflectionDailyReturnResponse | null>(null);
  const [weekly, setWeekly] = useState<DailyReflectionWeeklyReflectionResponse | null>(null);
  const [dailyLoading, setDailyLoading] = useState(true);
  const [weeklyLoading, setWeeklyLoading] = useState(true);
  const [dailyError, setDailyError] = useState<string | null>(null);
  const [weeklyError, setWeeklyError] = useState<string | null>(null);
  const [dailyAttempt, setDailyAttempt] = useState(0);
  const [weeklyAttempt, setWeeklyAttempt] = useState(0);
  const [activeTab, setActiveTab] = useState<ReturnTab>("daily");
  const [selectedDailyId, setSelectedDailyId] = useState<string | null>(null);
  const [quickView, setQuickView] = useState<QuickViewState | null>(null);
  const quickViewTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setDailyLoading(true);
    setDailyError(null);
    void api.getDailyReturn({}, controller.signal).then((result) => {
      if (!controller.signal.aborted) setDaily(result);
    }).catch(() => {
      if (!controller.signal.aborted) setDailyError("今天的回看暂时无法加载。");
    }).finally(() => {
      if (!controller.signal.aborted) setDailyLoading(false);
    });
    return () => controller.abort();
  }, [api, dailyAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    setWeeklyLoading(true);
    setWeeklyError(null);
    void api.getWeeklyReflection({}, controller.signal).then((result) => {
      if (!controller.signal.aborted) setWeekly(result);
    }).catch(() => {
      if (!controller.signal.aborted) setWeeklyError("本周回顾暂时无法加载。");
    }).finally(() => {
      if (!controller.signal.aborted) setWeeklyLoading(false);
    });
    return () => controller.abort();
  }, [api, weeklyAttempt]);

  const dailyItems = useMemo(() => {
    if (!daily) return [];
    const featured = [daily.openLoops[0], daily.reflectionPrompts[0], daily.resurfacedMemories[0]]
      .filter((item): item is DailyReflectionReturnItem => Boolean(item));
    const remaining = [
      ...daily.openLoops.slice(1),
      ...daily.reflectionPrompts.slice(1),
      ...daily.resurfacedMemories.slice(1)
    ];
    return [...featured, ...remaining].filter(isDisplayable);
  }, [daily]);
  const activeDailyItem = dailyItems.find((item) => item.id === selectedDailyId) ?? dailyItems[0];
  const activeDailyIndex = activeDailyItem ? dailyItems.findIndex((item) => item.id === activeDailyItem.id) : -1;
  const otherDailyItems = activeDailyItem ? dailyItems.filter((item) => item.id !== activeDailyItem.id) : [];
  const secondaryDailyItems = otherDailyItems.slice(0, 2);
  const additionalDailyItems = otherDailyItems.slice(2);
  const weeklyGroups = weekly ? [
    weekly.repeatedThemes,
    weekly.changedDecisions,
    weekly.openCommitments,
    weekly.emergingIdeas
  ] : [];
  const weeklyItemCount = weeklyGroups.flat().filter(isDisplayable).length;
  const weeklyCategoryCount = weeklyGroups.filter((items) => items.some(isDisplayable)).length;

  const closeQuickView = useCallback(() => {
    setQuickView(null);
    window.requestAnimationFrame(() => quickViewTriggerRef.current?.focus());
  }, []);

  const openQuickView = useCallback((event: ReactMouseEvent<HTMLButtonElement>, item: DisplayItem) => {
    quickViewTriggerRef.current = event.currentTarget;
    const referenceDate = activeTab === "daily" ? (daily?.referenceDate ?? "") : (weekly?.endDate ?? "");
    setQuickView({ item, referenceDate });
  }, [activeTab, daily?.referenceDate, weekly?.endDate]);

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, tab: ReturnTab) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next: ReturnTab = event.key === "Home"
      ? "daily"
      : event.key === "End"
        ? "weekly"
        : tab === "daily" ? "weekly" : "daily";
    setActiveTab(next);
    document.getElementById(`return-tab-${next}`)?.focus();
  };

  return (
    <div className={embedded ? styles.embeddedRoot : styles.root}>
      {!embedded ? <header className={styles.header}>
        <Link className={styles.wordmark} href="/" aria-label="返回产品选择">
          <span className={styles.wordmarkMark}>DB</span>
          <b>回看</b>
        </Link>
        <nav className={styles.productNav} aria-label="产品空间">
          <Link href="/reflection">今天</Link>
          <Link href="/reflection/cards">卡片</Link>
          <Link aria-current="page" className={styles.activeProductNav} href="/reflection/reflect">回看</Link>
          <Link href="/reflection/think?mode=past_clues">一起想</Link>
        </nav>
      </header> : null}

      <main className={`${embedded ? styles.productPage : styles.page} ${styles.returnPage}`}>
        <section className={styles.returnHero}>
          <div>
            <h1>回看</h1>
            {activeTab === "daily" ? <>
              <p>{daily ? `今天有 ${dailyItems.length} 件过去的内容值得重新看看。` : "今天值得重新看看的内容。"}</p>
              {daily ? <time dateTime={daily.referenceDate}>{formatFullDate(daily.referenceDate)}</time> : null}
            </> : <>
              <p>{weekly ? `本周有 ${weeklyItemCount} 个线索值得重新整理。` : "这一周值得重新整理的线索。"}</p>
              {weekly ? <span className={styles.returnDate}>{formatShortDate(weekly.startDate)}—{formatShortDate(weekly.endDate)}</span> : null}
            </>}
          </div>
          <div className={styles.returnTabs} role="tablist" aria-label="回看时间范围">
            <button aria-controls="daily-return-panel" aria-selected={activeTab === "daily"} id="return-tab-daily" onClick={() => setActiveTab("daily")} onKeyDown={(event) => handleTabKeyDown(event, "daily")} role="tab" tabIndex={activeTab === "daily" ? 0 : -1} type="button">今天</button>
            <button aria-controls="weekly-return-panel" aria-selected={activeTab === "weekly"} id="return-tab-weekly" onClick={() => setActiveTab("weekly")} onKeyDown={(event) => handleTabKeyDown(event, "weekly")} role="tab" tabIndex={activeTab === "weekly" ? 0 : -1} type="button">本周</button>
          </div>
        </section>

        {activeTab === "daily" ? <section className={styles.returnPanel} id="daily-return-panel" aria-labelledby="return-tab-daily" role="tabpanel">
          {dailyLoading ? <div className={styles.returnState}><ProductState description="正在核对仍然有效的来源。" title="正在准备今天的回看" tone="loading" /></div> : dailyError ? (
            <div className={styles.returnState}><ProductState action={<button className={styles.secondaryButton} onClick={() => setDailyAttempt((value) => value + 1)} type="button">重新尝试</button>} description={dailyError} title="今天的回看暂时没有加载完成" tone="error" /></div>
          ) : daily && activeDailyItem ? (<>
            <div className={styles.returnDailyLayout}>
              <div>
                <p className={styles.returnSectionLabel}>今天先看</p>
                <DailyPrimaryCard expanded={quickView?.item.id === activeDailyItem.id} index={activeDailyIndex} item={activeDailyItem} onOpen={openQuickView} referenceDate={daily.referenceDate} total={dailyItems.length} />
              </div>
              {secondaryDailyItems.length > 0 ? <aside aria-labelledby="return-secondary-title" className={styles.returnSecondaryPanel}>
                <h2 id="return-secondary-title">另外 {secondaryDailyItems.length} 条值得回看</h2>
                <ol className={styles.returnSecondaryList}>
                  {secondaryDailyItems.map((item) => <DailySecondaryItem expanded={quickView?.item.id === item.id} item={item} key={item.id} onOpen={openQuickView} onSelect={() => setSelectedDailyId(item.id)} referenceDate={daily.referenceDate} />)}
                </ol>
              </aside> : null}
            </div>
            {additionalDailyItems.length > 0 ? <details className={styles.returnMore}>
              <summary>更多值得回看 <span>{additionalDailyItems.length}</span></summary>
              <ol className={styles.returnMoreList}>
                {additionalDailyItems.map((item) => <DailySecondaryItem
                  expanded={quickView?.item.id === item.id}
                  item={item}
                  key={item.id}
                  onOpen={openQuickView}
                  onSelect={() => setSelectedDailyId(item.id)}
                  referenceDate={daily.referenceDate}
                />)}
              </ol>
            </details> : null}
          </>
          ) : (
            <div className={styles.returnState}><ProductState description="有来源、仍然有效的内容，会在合适的时候回到这里。" title="今天暂时没有需要重新出现的内容。" tone="empty" /></div>
          )}
        </section> : null}

        {activeTab === "weekly" ? <section className={styles.returnPanel} id="weekly-return-panel" aria-labelledby="return-tab-weekly" role="tabpanel">
          {weeklyLoading ? <div className={styles.returnState}><ProductState description="正在核对本周仍然有效的来源。" title="正在整理本周回看" tone="loading" /></div> : weeklyError ? (
            <div className={styles.returnState}><ProductState action={<button className={styles.secondaryButton} onClick={() => setWeeklyAttempt((value) => value + 1)} type="button">重新尝试</button>} description={weeklyError} title="本周回看暂时没有加载完成" tone="error" /></div>
          ) : weekly && weeklyItemCount > 0 ? <>
            <div className={styles.returnWeeklyOverview}>
              <span>{weeklyCategoryCount} 类线索</span>
              <strong>{weeklyItemCount} 条有来源的内容</strong>
            </div>
            <div className={styles.returnWeeklyGrid}>
              <WeeklySection expandedItemId={quickView?.item.id ?? null} items={weekly.repeatedThemes} label="反复出现的主题" onOpen={openQuickView} referenceDate={weekly.endDate} type="repeated_theme" />
              <WeeklySection expandedItemId={quickView?.item.id ?? null} items={weekly.changedDecisions} label="发生变化的决定" onOpen={openQuickView} referenceDate={weekly.endDate} type="changed_decision" />
              <WeeklySection expandedItemId={quickView?.item.id ?? null} items={weekly.openCommitments} label="仍在继续的承诺" onOpen={openQuickView} referenceDate={weekly.endDate} type="open_commitment" />
              <WeeklySection expandedItemId={quickView?.item.id ?? null} items={weekly.emergingIdeas} label="正在形成的想法" onOpen={openQuickView} referenceDate={weekly.endDate} type="emerging_idea" />
            </div>
          </> : (
            <div className={styles.returnState}><ProductState description="新的确认内容会在下一次周度整理时自然出现。" title="本周还没有形成足够清晰的回看线索。" tone="empty" /></div>
          )}
        </section> : null}
      </main>

      {quickView ? <ReturnQuickView onClose={closeQuickView} state={quickView} /> : null}
    </div>
  );
}
