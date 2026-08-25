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
  reflectionCardPath,
  reflectionSessionPath
} from "./reflection-product";
import { useReflectionApp } from "./reflection-app-shell";

type SessionPreview = Readonly<{
  cardKinds: string[];
  durationSeconds: number | null;
  summary: string | null;
}>;

const CARD_KIND_LABELS: Record<string, string> = {
  insight: "洞察",
  open_question: "问题",
  question: "问题",
  decision: "决定",
  user_action: "行动",
  action: "行动"
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
    cardKinds: [...new Set(cards.map((card) => CARD_KIND_LABELS[card.cardKind]).filter(Boolean))]
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
    <main className={styles.productPage}>
      <section className={styles.productHero}>
        <p className={styles.productEyebrow}>{displayDate()}</p>
        <h1>{firstUse ? "给今天留下一点真实的东西。" : `${greeting()}，有什么值得留下？`}</h1>
        <p>{firstUse
          ? `${browserRecordingEnabled ? "说一段或" : ""}上传一段${toySyncEnabled ? "，也可以从玩偶录音中选择一段" : ""}。Daily Reflection 会先整理成可核对的卡片，再由你决定什么值得长期记住。`
          : "先从一段真实表达开始。今天的想法可以成为卡片，也可能在未来合适的时候重新回来。"}</p>
        <div className={styles.productActions}>
          <Link className={styles.productPrimary} href={`${REFLECTION_ROUTES.capture}?new=1`}>开始表达</Link>
          {session.reflectionId ? (
            <Link className={styles.productSecondary} href={reflectionSessionPath(session.reflectionId)}>继续正在进行的复盘</Link>
          ) : null}
        </div>
        <p className={styles.trustNote}>{REFLECTION_TRUST_COPY}</p>
      </section>

      {firstUse ? (
        <section className={styles.productSection} aria-labelledby="reflection-first-use-title">
          <div className={styles.productSectionHeader}>
            <div><p className={styles.productEyebrow}>以后可以这样找回来</p><h2 id="reflection-first-use-title">从一个问题开始想象它的价值</h2></div>
          </div>
          <div className={styles.questionChips}>
            {REFLECTION_ASK_EXAMPLES.map((question) => (
              <Link href={`${REFLECTION_ROUTES.ask}?q=${encodeURIComponent(question)}`} key={question}>{question}</Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className={styles.productSection} aria-labelledby="reflection-start-title">
        <div className={styles.productSectionHeader}>
          <div><p className={styles.productEyebrow}>最轻松的开始</p><h2 id="reflection-start-title">选择你已经习惯的表达方式</h2></div>
        </div>
        <div className={styles.productGrid}>
          {browserRecordingEnabled ? <Link className={styles.productCard} href={`${REFLECTION_ROUTES.capture}?new=1&method=record`}>
            <span className={styles.productPill}>直接表达</span><h3>开始说</h3><p>说完由你结束。提交前录音只留在这台设备上。</p>
          </Link> : null}
          <Link className={styles.productCard} href={`${REFLECTION_ROUTES.capture}?new=1&method=upload`}>
            <span className={styles.productPill}>已有内容</span><h3>上传录音</h3><p>选择一段已经录好的声音，并明确它来自自己的复盘还是一段真实交流。</p>
          </Link>
          {toySyncEnabled ? <Link className={styles.productCard} href={`${REFLECTION_ROUTES.capture}?new=1&method=toy`}>
            <span className={styles.productPill}>设备录音</span><h3>从玩偶导入</h3><p>从你明确选择的录音位置中，挑一段交给 Daily Reflection。</p>
          </Link> : null}
        </div>
      </section>

      {returns.length > 0 ? (
        <section className={styles.productSection} aria-labelledby="reflection-continue-title">
          <div className={styles.productSectionHeader}>
            <div><p className={styles.productEyebrow}>过去仍有回声</p><h2 id="reflection-continue-title">值得继续</h2></div>
            <Link className={styles.productSecondary} href={REFLECTION_ROUTES.reflect}>查看完整回看</Link>
          </div>
          <div className={styles.productGrid}>
            {returns.map((item) => (
              <article className={styles.productCard} key={item.id}>
                <span className={styles.productPill}>{item.type === "open_loop" ? "还没结束" : item.type === "reflection_prompt" ? "再想一想" : "过去的一条线索"}</span>
                <h3>{item.title}</h3><p>{item.body}</p>
                <div className={styles.productActions}>
                  <Link className={styles.productSecondary} href={`${REFLECTION_ROUTES.capture}?new=1&prompt=${encodeURIComponent(item.title)}`}>继续想</Link>
                  <Link className={styles.productSecondary} href={`${reflectionSessionPath(item.evidence[0].reflectionId)}?segment=${encodeURIComponent(item.evidence[0].sourceSegmentId)}`}>查看来源</Link>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className={styles.productSection} aria-labelledby="reflection-today-title">
        <div className={styles.productSectionHeader}>
          <div><p className={styles.productEyebrow}>今天留下的内容</p><h2 id="reflection-today-title">{todaySessions.length > 0 ? "今天的复盘" : "今天还没有记录"}</h2></div>
          {cardCount !== null ? <p>卡片库中有 {cardCount} 张卡片</p> : null}
        </div>
        {todaySessions.length > 0 ? (
          <div className={styles.productGrid}>{todaySessions.map((item) => <SessionPreviewCard item={item} key={item.id} preview={previews[item.id]} />)}</div>
        ) : <p className={styles.productEmpty}>不需要每天完成一份报告。只在有一句话值得留下时回来就好。</p>}
        {todayCards.length > 0 ? (
          <div className={styles.productGrid} aria-label="今天保存的卡片">
            {todayCards.map((card) => (
              <Link className={styles.productCard} href={reflectionCardPath(card.id)} key={card.id}>
                <span className={styles.productPill}>{CARD_KIND_LABELS[card.cardKind] ?? "暂未归类"}</span>
                <h3>{card.title}</h3><p>{card.content}</p>
                <div className={styles.productCardMeta}><span>{card.evidenceIds.length} 段来源</span><span>你的卡片</span></div>
              </Link>
            ))}
          </div>
        ) : null}
      </section>

      {recentSessions.length > 0 ? (
        <section className={styles.productSection} aria-labelledby="reflection-recent-title">
          <div className={styles.productSectionHeader}>
            <div><p className={styles.productEyebrow}>最近</p><h2 id="reflection-recent-title">过去的表达</h2></div>
          </div>
          <div className={styles.productGrid}>{recentSessions.map((item) => <SessionPreviewCard item={item} key={item.id} preview={previews[item.id]} />)}</div>
        </section>
      ) : session.historyState === "loading" ? <p className={styles.productEmpty} role="status">正在读取过去的复盘…</p> : null}
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
    <Link className={styles.productCard} href={reflectionSessionPath(item.id)}>
      <div className={styles.productCardMeta}><span>{item.recordingDate ?? "日期待确认"}</span><span>{source}</span>{duration ? <span>{duration}</span> : null}</div>
      <h3>{preview?.summary ?? item.sourceStatement}</h3>
      <p>{preview?.cardKinds.length
        ? `${preview.cardKinds.join("、")} · ${item.candidateCount} 条整理内容`
        : item.candidateCount > 0 ? `${item.candidateCount} 条整理内容` : "原始表达已保留"}</p>
      <div className={styles.productCardMeta}><span className={styles.productPill}>{statusLabel(item)}</span>{item.rememberedCount > 0 ? <span>长期记住 {item.rememberedCount} 条</span> : null}</div>
    </Link>
  );
}
