"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { createDailyReflectionApi } from "@/lib/client/daily-reflection-api";
import type {
  DailyReflectionDetailResponse,
  DailyReflectionHistoryItem,
  DailyReflectionWorkingCardView
} from "@/lib/domain/daily-reflection-api";
import type { DailyReflectionReturnItem } from "@/lib/domain/daily-reflection-return";

import styles from "./daily-reflection.module.css";
import {
  REFLECTION_ASK_EXAMPLES,
  REFLECTION_ROUTES,
  REFLECTION_TRUST_COPY,
  reflectionCardKindLabel,
  reflectionCardPath,
  reflectionSessionPath
} from "./reflection-product";
import { useReflectionApp } from "./reflection-app-shell";

type SessionPreview = Readonly<{
  cardKinds: string[];
  durationSeconds: number | null;
  summary: string | null;
}>;

const REVIEW_CARD_KIND_LABELS: Record<string, string> = {
  insight: "洞察",
  open_question: "问题",
  decision: "决定",
  user_action: "行动"
};

function localDateValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function localDateFromTimestamp(value: string) {
  return localDateValue(new Date(value));
}

function greeting(date = new Date()) {
  const hour = date.getHours();
  if (hour < 6) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 13) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function displayDate(date = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long"
  }).format(date);
}

function formatDuration(seconds: number | null) {
  if (!seconds || seconds <= 0) return null;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (minutes === 0) return `${remainder} 秒`;
  return remainder > 0 ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`;
}

function statusLabel(item: DailyReflectionHistoryItem) {
  if (item.status === "review_pending") return "等你看看";
  if (item.status === "confirmation_ready" || item.status === "admitting") return "正在保存";
  if (item.status === "completed") return "已完成";
  if (item.status === "failed" || item.status === "admission_failed") return "需要继续";
  if (item.status === "cancelled") return "已取消";
  if (item.status === "transcribing") return "正在转成文字";
  if (item.status === "extracting") return "正在整理重点";
  return "正在接收录音";
}

function previewFromDetail(detail: DailyReflectionDetailResponse): SessionPreview {
  const cards = [...detail.cards].sort((left, right) => left.rank - right.rank);
  const firstCard = cards[0];
  const firstCandidate = detail.candidates[0];
  return {
    durationSeconds: detail.upload?.durationSeconds ?? null,
    summary: firstCard
      ? (firstCard.userTitle ?? firstCard.proposedTitle)
      : firstCandidate
        ? ("userText" in firstCandidate && firstCandidate.userText
          ? firstCandidate.userText
          : firstCandidate.proposedText)
        : null,
    cardKinds: [...new Set(cards.map((card) => REVIEW_CARD_KIND_LABELS[card.cardKind]).filter(Boolean))]
  };
}

export function ReflectionHome() {
  const { browserRecordingEnabled, handleApiError, session, toySyncEnabled } = useReflectionApp();
  const api = useMemo(() => createDailyReflectionApi(), []);
  const [previews, setPreviews] = useState<Record<string, SessionPreview>>({});
  const [returns, setReturns] = useState<DailyReflectionReturnItem[]>([]);
  const [cardCount, setCardCount] = useState<number | null>(null);
  const [todayCards, setTodayCards] = useState<DailyReflectionWorkingCardView[]>([]);
  const today = localDateValue();
  const firstUse = session.historyState === "ready" && session.history.length === 0;

  useEffect(() => {
    const controller = new AbortController();
    const recent = session.history.slice(0, 5);
    void Promise.all(recent.map(async (item) => {
      try {
        return [item.id, previewFromDetail(await api.get(item.id, controller.signal))] as const;
      } catch (error) {
        if (!controller.signal.aborted) handleApiError(error);
        return null;
      }
    })).then((items) => {
      if (!controller.signal.aborted) setPreviews(Object.fromEntries(items.filter(Boolean) as Array<readonly [string, SessionPreview]>));
    });
    return () => controller.abort();
  }, [api, handleApiError, session.history]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api.getDailyReturn({}, controller.signal),
      api.listWorkingCards({ status: "saved", sort: "created_desc", limit: 6, offset: 0 }, controller.signal)
    ]).then(([daily, cards]) => {
      if (controller.signal.aborted) return;
      const seen = new Set<string>();
      const items = [daily.openLoops[0], daily.reflectionPrompts[0], daily.resurfacedMemories[0]]
        .filter((item): item is DailyReflectionReturnItem => Boolean(item))
        .filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)))
        .slice(0, 3);
      setReturns(items);
      setCardCount(cards.total);
      setTodayCards(cards.cards.filter((card) => localDateFromTimestamp(card.createdAt) === today).slice(0, 3));
    }).catch((error) => {
      if (!controller.signal.aborted) handleApiError(error);
    });
    return () => controller.abort();
  }, [api, handleApiError, today]);

  const todaySessions = session.history.filter((item) => item.recordingDate === today).slice(0, 3);
  const recentSessions = session.history.filter((item) => item.recordingDate !== today).slice(0, 5);

  return (
    <main className={`${styles.productPage} ${styles.homePage}`}>
      <section className={styles.homeHeroGrid}>
        <div className={styles.homeHero}>
          <p className={styles.productEyebrow}>{displayDate()}</p>
          <h1>{firstUse ? "给今天留下一点真实的东西。" : <>{greeting()}。<br />今天想留下什么？</>}</h1>
          <p>{firstUse
            ? "从一段真实表达开始。系统会把值得继续的部分整理出来，再由你决定留下什么。"
            : "说下当下真正关心的事。它会先成为可核对的卡片，再在未来合适的时候重新回来。"}</p>
          <div className={styles.productActions}>
            <Link className={styles.productPrimary} href={`${REFLECTION_ROUTES.capture}?new=1`}>开始表达</Link>
            {session.reflectionId ? <Link className={styles.productSecondary} href={reflectionSessionPath(session.reflectionId)}>继续上次复盘</Link> : null}
          </div>
          <div className={styles.homeQuickLinks} aria-label="其他输入方式">
            <Link href={`${REFLECTION_ROUTES.capture}?new=1&method=upload`}>上传录音</Link>
            {toySyncEnabled ? <Link href={`${REFLECTION_ROUTES.capture}?new=1&method=toy`}>从玩偶导入</Link> : null}
            {!browserRecordingEnabled ? <span>当前浏览器仅支持上传</span> : null}
          </div>
          <p className={styles.trustNote}>{REFLECTION_TRUST_COPY}</p>
        </div>

        <aside className={styles.homeContinuity} aria-labelledby="reflection-continue-title">
          <div className={styles.homeSectionHeading}>
            <div><p className={styles.productEyebrow}>过去仍有回声</p><h2 id="reflection-continue-title">值得继续</h2></div>
            <Link href={REFLECTION_ROUTES.reflect}>查看回看</Link>
          </div>
          {returns.length > 0 ? (
            <ol className={styles.homeContinuityList}>
              {returns.slice(0, 2).map((item) => (
                <li key={item.id}>
                  <span>{item.type === "open_loop" ? "还没有解决" : item.type === "reflection_prompt" ? "可能发生了变化" : "一个相关旧想法"}</span>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                  <div>
                    <Link href={`${REFLECTION_ROUTES.capture}?new=1&prompt=${encodeURIComponent(item.title)}`}>继续想</Link>
                    <Link href={`${reflectionSessionPath(item.evidence[0].reflectionId)}?segment=${encodeURIComponent(item.evidence[0].sourceSegmentId)}`}>查看来源</Link>
                  </div>
                </li>
              ))}
            </ol>
          ) : firstUse ? (
            <div className={styles.homeFirstUseQuestions}>
              <p>以后，你可以这样找回过去：</p>
              {REFLECTION_ASK_EXAMPLES.slice(0, 2).map((question) => (
                <Link href={`${REFLECTION_ROUTES.ask}?q=${encodeURIComponent(question)}`} key={question}>{question}</Link>
              ))}
            </div>
          ) : <p className={styles.homeEmpty}>暂时没有需要追问的旧线索。新的表达会慢慢在这里形成连接。</p>}
        </aside>
      </section>

      <section className={styles.homeCollection} aria-labelledby="reflection-today-title">
        <div className={styles.homeSectionHeading}>
          <div><p className={styles.productEyebrow}>今天留下的</p><h2 id="reflection-today-title">{todaySessions.length > 0 || todayCards.length > 0 ? "今天的内容" : "今天还没有记录"}</h2></div>
          {cardCount !== null ? <Link href={REFLECTION_ROUTES.cards}>{cardCount} 张卡片</Link> : null}
        </div>
        {todaySessions.length > 0 ? <div className={styles.homeSessionList}>{todaySessions.map((item) => <SessionPreviewCard item={item} key={item.id} preview={previews[item.id]} />)}</div> : null}
        {todayCards.length > 0 ? (
          <div className={styles.homeCardStrip} aria-label="今天保存的卡片">
            {todayCards.map((card) => (
              <Link href={reflectionCardPath(card.id)} key={card.id}>
                <span>{reflectionCardKindLabel(card.cardKind)}</span><h3>{card.title}</h3><p>{card.content}</p>
                <small>{card.evidenceIds.length} 段来源 · 你的卡片</small>
              </Link>
            ))}
          </div>
        ) : todaySessions.length === 0 ? <p className={styles.homeEmpty}>不需要每天完成一份报告。只在有一句话值得留下时回来就好。</p> : null}
      </section>

      {recentSessions.length > 0 ? (
        <section className={styles.homeCollection} aria-labelledby="reflection-recent-title">
          <div className={styles.homeSectionHeading}><div><p className={styles.productEyebrow}>最近复盘</p><h2 id="reflection-recent-title">过去的表达</h2></div></div>
          <div className={styles.homeSessionList}>{recentSessions.map((item) => <SessionPreviewCard item={item} key={item.id} preview={previews[item.id]} />)}</div>
        </section>
      ) : session.historyState === "loading" ? <p className={styles.homeEmpty} role="status">正在读取过去的复盘…</p> : null}
    </main>
  );
}

function SessionPreviewCard({ item, preview }: Readonly<{
  item: DailyReflectionHistoryItem;
  preview?: SessionPreview;
}>) {
  const duration = formatDuration(preview?.durationSeconds ?? null);
  const source = item.sourceOrigin === "user_reflection" ? "自己的复盘" : "真实交流";
  return (
    <Link className={styles.homeSessionRow} href={reflectionSessionPath(item.id)}>
      <div>
        <h3>{preview?.summary ?? item.sourceStatement}</h3>
        <p>{preview?.cardKinds.length
        ? `${preview.cardKinds.join("、")} · ${item.candidateCount} 条整理内容`
        : item.candidateCount > 0 ? `${item.candidateCount} 条整理内容` : "原始表达已保留"}</p>
      </div>
      <div className={styles.homeSessionMeta}><span>{item.recordingDate ?? "日期待确认"}</span><span>{source}</span>{duration ? <span>{duration}</span> : null}<b>{statusLabel(item)}</b>{item.rememberedCount > 0 ? <span>长期记住 {item.rememberedCount} 条</span> : null}</div>
    </Link>
  );
}
