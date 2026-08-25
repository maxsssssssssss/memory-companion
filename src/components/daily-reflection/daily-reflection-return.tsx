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
    <li className={styles.candidateCard}>
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
  title
}: Readonly<{
  eyebrow: string;
  emptyText: string;
  id: string;
  items: DisplayItem[];
  title: string;
}>) {
  const displayable = items.filter(isDisplayable);
  return (
    <section aria-labelledby={id} className={styles.candidateSection}>
      <div className={styles.sectionHeading}>
        <div>
          <p>{eyebrow}</p>
          <h2 id={id}>{title}</h2>
        </div>
        <span>{displayable.length} 条</span>
      </div>
      {displayable.length > 0 ? (
        <ol className={styles.candidateList}>
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
            <h1>今天，回看一点重要的事</h1>
          </div>
          <p className={styles.introText}>这里只呈现已经确认且仍可核对的内容。没有充分来源时，会保持空白。</p>
        </section>

        <section className={styles.historySection} aria-labelledby="daily-return-today-title">
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
            <div className={styles.cardLibraryPage}>
              <ReturnGroup eyebrow="仍未解决" emptyText="目前没有仍待确认的事项。" id="daily-return-open-loops" items={daily.openLoops.slice(0, 1)} title="一个未解决问题" />
              <ReturnGroup eyebrow="过去回来" emptyText="今天没有适合重新回看的记录。" id="daily-return-resurfaced" items={daily.resurfacedMemories.slice(0, 1)} title="一个相关旧想法" />
              <ReturnGroup eyebrow="今天的变化" emptyText="目前没有有依据的核对问题。" id="daily-return-prompts" items={daily.reflectionPrompts.slice(0, 1)} title="一个值得核对的变化" />
            </div>
          ) : (
            <p className={styles.historyEmpty}>今天暂时没有需要回看的内容。</p>
          )}
        </section>

        <section className={styles.historySection} aria-labelledby="weekly-reflection-title">
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
            <div className={styles.cardLibraryPage}>
              <ReturnGroup eyebrow="反复出现" emptyText="本周没有足够的重复来源。" id="weekly-repeated-themes" items={weekly.repeatedThemes} title="反复出现了什么" />
              <ReturnGroup eyebrow="前后变化" emptyText="本周没有发现有先后依据支持的变化。" id="weekly-changed-decisions" items={weekly.changedDecisions} title="什么发生变化" />
              <ReturnGroup eyebrow="仍待继续" emptyText="本周没有仍未完成的确认事项。" id="weekly-open-commitments" items={weekly.openCommitments} title="什么仍未解决" />
              <ReturnGroup eyebrow="可能形成方向" emptyText="本周没有新的、可核对的想法。" id="weekly-emerging-ideas" items={weekly.emergingIdeas} title="什么可能形成方向" />
            </div>
          ) : (
            <p className={styles.historyEmpty}>过去七天暂无足够、有来源的回顾内容。</p>
          )}
        </section>
      </main>
    </div>
  );
}
