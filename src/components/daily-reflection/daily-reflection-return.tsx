"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { createDailyReflectionApi } from "@/lib/client/daily-reflection-api";
import type {
  DailyReflectionDailyReturnResponse,
  DailyReflectionReturnEvidence,
  DailyReflectionReturnItem,
  DailyReflectionWeeklyItem,
  DailyReflectionWeeklyReflectionResponse
} from "@/lib/domain/daily-reflection-return";

import styles from "./daily-reflection.module.css";
import { reflectionSessionPath } from "./reflection-product";

type DailyReflectionReturnApi = Readonly<{
  getDailyReturn(
    input?: { date?: string },
    signal?: AbortSignal
  ): Promise<DailyReflectionDailyReturnResponse>;
  getWeeklyReflection(
    input?: { endDate?: string },
    signal?: AbortSignal
  ): Promise<DailyReflectionWeeklyReflectionResponse>;
}>;

type DailyReflectionReturnProps = Readonly<{
  api?: DailyReflectionReturnApi;
  embedded?: boolean;
}>;

type DisplayItem = DailyReflectionReturnItem | DailyReflectionWeeklyItem;

const SAFE_EPISTEMIC_STATUSES = new Set([
  "explicit_user_statement",
  "reported_event"
]);

function formatTimestamp(seconds: number) {
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3_600);
  const minutes = Math.floor((rounded % 3_600) / 60);
  const remaining = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function sourceContext(item: DailyReflectionReturnEvidence) {
  return item.sourceOrigin === "user_reflection"
    ? `你在 ${item.recordingDate} 的复盘中提到`
    : `在 ${item.recordingDate} 的交流中提到`;
}

function isDisplayable(item: DisplayItem) {
  return item.sourceCardIds.length > 0
    && item.evidence.length > 0
    && item.evidenceIds.length > 0
    && item.epistemicStatuses.every((status) => SAFE_EPISTEMIC_STATUSES.has(status));
}

function EvidenceList({ evidence }: { evidence: DailyReflectionReturnEvidence[] }) {
  return (
    <ol className={styles.evidenceList}>
      {evidence.map((item) => (
        <li key={`${item.cardId}:${item.sourceSegmentId}`}>
          <p>{item.snippet}</p>
          <small>{sourceContext(item)} · {formatTimestamp(item.startSeconds)}</small>
          <Link
            className={styles.textButton}
            href={`${reflectionSessionPath(item.reflectionId)}?segment=${encodeURIComponent(item.sourceSegmentId)}`}
          >查看原话</Link>
        </li>
      ))}
    </ol>
  );
}

function ReturnItem({ item }: { item: DisplayItem }) {
  const [evidenceExpanded, setEvidenceExpanded] = useState(false);
  return (
    <li className={styles.returnItem}>
      <div className={styles.candidateCardTop}>
        <b>{item.title}</b>
        {"sourceCount" in item ? (
          <span className={styles.pendingBadge}>{item.sourceCount} 条来源</span>
        ) : null}
      </div>
      <p className={styles.candidateText}>{item.body}</p>
      <div className={styles.candidateSource}>
        <span>{item.evidence.length} 段可核对依据</span>
        <button
          aria-expanded={evidenceExpanded}
          className={styles.sourceButton}
          onClick={() => setEvidenceExpanded((current) => !current)}
          type="button"
        >{evidenceExpanded ? "收起依据" : "查看依据"}</button>
      </div>
      {evidenceExpanded ? <EvidenceList evidence={item.evidence} /> : null}
      <Link
        className={styles.secondaryButton}
        href={`/reflection/capture?new=1&prompt=${encodeURIComponent(`${item.title}：${item.body}`)}`}
      >继续想</Link>
    </li>
  );
}

function ReturnGroup({
  eyebrow,
  emptyText,
  id,
  items,
  hideWhenEmpty = false,
  presentation,
  showCount = true,
  title
}: Readonly<{
  eyebrow: string;
  emptyText: string;
  id: string;
  items: DisplayItem[];
  hideWhenEmpty?: boolean;
  presentation: "open" | "change" | "past" | "weekly";
  showCount?: boolean;
  title: string;
}>) {
  const displayable = items.filter(isDisplayable);
  if (hideWhenEmpty && displayable.length === 0) return null;
  return (
    <section aria-labelledby={id} className={styles.returnGroup} data-return-kind={presentation}>
      <div className={styles.sectionHeading}>
        <div>
          <p>{eyebrow}</p>
          <h2 id={id}>{title}</h2>
        </div>
        {showCount ? <span>{displayable.length} 条</span> : null}
      </div>
      {displayable.length > 0 ? (
        <ol className={styles.returnList}>
          {displayable.map((item) => <ReturnItem item={item} key={item.id} />)}
        </ol>
      ) : (
        <p className={styles.historyEmpty}>{emptyText}</p>
      )}
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
  const [activeTab, setActiveTab] = useState<"daily" | "weekly">("daily");

  useEffect(() => {
    const controller = new AbortController();
    void api.getDailyReturn({}, controller.signal).then((result) => {
      if (!controller.signal.aborted) setDaily(result);
    }).catch(() => {
      if (!controller.signal.aborted) setDailyError("今天的回看暂时无法加载。");
    }).finally(() => {
      if (!controller.signal.aborted) setDailyLoading(false);
    });
    void api.getWeeklyReflection({}, controller.signal).then((result) => {
      if (!controller.signal.aborted) setWeekly(result);
    }).catch(() => {
      if (!controller.signal.aborted) setWeeklyError("本周回顾暂时无法加载。");
    }).finally(() => {
      if (!controller.signal.aborted) setWeeklyLoading(false);
    });
    return () => controller.abort();
  }, [api]);

  const dailyHasContent = Boolean(daily && [
    ...daily.openLoops.slice(0, 1),
    ...daily.reflectionPrompts.slice(0, 1),
    ...daily.resurfacedMemories.slice(0, 1)
  ].some(isDisplayable));
  const weeklyGroups = weekly ? [
    weekly.repeatedThemes,
    weekly.changedDecisions,
    weekly.openCommitments,
    weekly.emergingIdeas
  ] : [];
  const weeklyItemCount = weeklyGroups.flat().filter(isDisplayable).length;
  const weeklyCategoryCount = weeklyGroups.filter((items) => items.some(isDisplayable)).length;

  return (
    <div className={embedded ? styles.embeddedRoot : styles.root}>
      {!embedded ? <header className={styles.header}>
        <Link className={styles.wordmark} href="/date-companion/modules" aria-label="返回空间选择">
          <span className={styles.wordmarkMark}>DB</span>
          <b>回看</b>
        </Link>
        <nav className={styles.productNav} aria-label="产品空间">
          <Link href="/reflection">今天</Link>
          <Link href="/reflection/cards">卡片</Link>
          <Link aria-current="page" className={styles.activeProductNav} href="/reflection/reflect">回看</Link>
          <Link href="/reflection/ask">问问过去</Link>
        </nav>
      </header> : null}

      <main className={`${embedded ? styles.productPage : styles.page} ${styles.cardLibraryPage}`}>
        <section className={embedded ? styles.productIntro : styles.intro}>
          <div>
            <p className={styles.eyebrow}>有来源的回顾</p>
            <h1>回看</h1>
          </div>
          <p className={styles.introText}>让过去重新帮助现在。这里只有已经确认且仍可核对的内容。</p>
        </section>

        <div className={styles.returnTabs} role="tablist" aria-label="回看时间范围">
          <button aria-controls="daily-return-panel" aria-selected={activeTab === "daily"} onClick={() => setActiveTab("daily")} role="tab" type="button">今天</button>
          <button aria-controls="weekly-return-panel" aria-selected={activeTab === "weekly"} onClick={() => setActiveTab("weekly")} role="tab" type="button">本周</button>
        </div>

        {activeTab === "daily" ? <section className={styles.returnPanel} id="daily-return-panel" aria-labelledby="daily-return-today-title" role="tabpanel">
          <div className={styles.historyHeading}>
            <div>
              <p className={styles.eyebrow}>今天值得再想一想</p>
              <h2 id="daily-return-today-title">今天</h2>
            </div>
            {daily ? <span>{daily.referenceDate}</span> : null}
          </div>
          {dailyLoading ? <p role="status">正在准备今天的回看…</p> : dailyError ? (
            <p className={styles.inlineError} role="alert">{dailyError}</p>
          ) : daily ? (
            dailyHasContent ? <div className={styles.returnGrid}>
              <ReturnGroup eyebrow="仍未解决" emptyText="" hideWhenEmpty id="daily-return-open-loops" items={daily.openLoops.slice(0, 1)} presentation="open" showCount={false} title="还没有解决" />
              <ReturnGroup eyebrow="需要再核对" emptyText="" hideWhenEmpty id="daily-return-prompts" items={daily.reflectionPrompts.slice(0, 1)} presentation="change" showCount={false} title="可能发生了变化" />
              <ReturnGroup eyebrow="过去回来" emptyText="" hideWhenEmpty id="daily-return-resurfaced" items={daily.resurfacedMemories.slice(0, 1)} presentation="past" showCount={false} title="与过去有关" />
            </div> : <p className={styles.historyEmpty}>今天暂时没有需要回看的内容。</p>
          ) : (
            <p className={styles.historyEmpty}>今天暂时没有需要回看的内容。</p>
          )}
        </section> : null}

        {activeTab === "weekly" ? <section className={styles.returnPanel} id="weekly-return-panel" aria-labelledby="weekly-reflection-title" role="tabpanel">
          <div className={styles.historyHeading}>
            <div>
              <p className={styles.eyebrow}>这一周在变化</p>
              <h2 id="weekly-reflection-title">本周回顾</h2>
            </div>
            {weekly ? <span>{weekly.startDate} 至 {weekly.endDate}</span> : null}
          </div>
          {weeklyLoading ? <p role="status">正在整理本周回顾…</p> : weeklyError ? (
            <p className={styles.inlineError} role="alert">{weeklyError}</p>
          ) : weekly ? (
            weeklyItemCount > 0 ? <>
              <p className={styles.returnOverview}>这一周有 {weeklyCategoryCount} 类内容值得回看，共 {weeklyItemCount} 条有来源的线索。</p>
              <div className={styles.returnGrid}>
                <ReturnGroup eyebrow="反复出现" emptyText="" hideWhenEmpty id="weekly-repeated-themes" items={weekly.repeatedThemes} presentation="weekly" title="反复出现了什么" />
                <ReturnGroup eyebrow="前后变化" emptyText="" hideWhenEmpty id="weekly-changed-decisions" items={weekly.changedDecisions} presentation="weekly" title="什么发生变化" />
                <ReturnGroup eyebrow="仍待继续" emptyText="" hideWhenEmpty id="weekly-open-commitments" items={weekly.openCommitments} presentation="weekly" title="什么仍未解决" />
                <ReturnGroup eyebrow="可能形成方向" emptyText="" hideWhenEmpty id="weekly-emerging-ideas" items={weekly.emergingIdeas} presentation="weekly" title="什么可能形成方向" />
              </div>
            </> : <p className={styles.historyEmpty}>过去七天暂无足够、有来源的回顾内容。</p>
          ) : (
            <p className={styles.historyEmpty}>过去七天暂无足够、有来源的回顾内容。</p>
          )}
        </section> : null}
      </main>
    </div>
  );
}
