"use client";

import { useEffect, useMemo, useState } from "react";

import styles from "./exploration.module.css";

type TranscriptLine = {
  id: string;
  time: string;
  dateTime: string;
  speaker: "你" | "林澄";
  text: string;
};

type TranscriptChapter = {
  id: string;
  title: string;
  timeRange: string;
  lines: TranscriptLine[];
};

const transcriptChapters: TranscriptChapter[] = [
  {
    id: "dinner",
    title: "到店与晚餐",
    timeRange: "18:34–18:45",
    lines: [
      { id: "arrival", time: "18:34", dateTime: "2026-08-02T18:34:00+08:00", speaker: "你", text: "这边靠窗，可以看到河。你坐里面还是外面？" },
      { id: "market-opening", time: "18:36", dateTime: "2026-08-02T18:36:00+08:00", speaker: "林澄", text: "坐里面吧。我今天带了几张市集摊位的照片，等菜的时候给你看。" },
      { id: "market-cups", time: "18:37", dateTime: "2026-08-02T18:37:00+08:00", speaker: "林澄", text: "我还在挑要带去市集的那一组杯子，想再看一晚。" },
      { id: "market-concern", time: "18:42", dateTime: "2026-08-02T18:42:00+08:00", speaker: "林澄", text: "其实是有点期待的，但第一次一个人摆摊，还是会担心准备得不够好。" },
      { id: "continue-cups", time: "18:43", dateTime: "2026-08-02T18:43:00+08:00", speaker: "你", text: "最后决定带哪一组陶杯了吗？下次见面给我看看。" },
      { id: "listen-concern", time: "18:45", dateTime: "2026-08-02T18:45:00+08:00", speaker: "你", text: "你慢慢说，我想听听你最担心的是哪一部分。" }
    ]
  },
  {
    id: "after-dinner",
    title: "饭后慢慢聊",
    timeRange: "18:58–19:14",
    lines: [
      { id: "market-weather", time: "18:58", dateTime: "2026-08-02T18:58:00+08:00", speaker: "林澄", text: "如果那天下雨，摊位会往里面挪一点。我还在想桌布要不要换深色。" },
      { id: "market-help", time: "19:02", dateTime: "2026-08-02T19:02:00+08:00", speaker: "你", text: "不用一次把所有事想完。你最想先确认桌布，还是先把杯子选出来？" },
      { id: "birthday", time: "19:05", dateTime: "2026-08-02T19:05:00+08:00", speaker: "林澄", text: "妈妈生日快到了，我还没想好送花还是做一只杯子。" },
      { id: "birthday-cup", time: "19:09", dateTime: "2026-08-02T19:09:00+08:00", speaker: "你", text: "如果是你做的杯子，Ta可能会把每一个小痕迹都记得很久。" },
      { id: "birthday-choice", time: "19:14", dateTime: "2026-08-02T19:14:00+08:00", speaker: "林澄", text: "也是。我想做一个Ta每天早上都能用的，不用很精致。" }
    ]
  },
  {
    id: "riverside",
    title: "河边散步",
    timeRange: "19:22–19:43",
    lines: [
      { id: "leave-restaurant", time: "19:22", dateTime: "2026-08-02T19:22:00+08:00", speaker: "你", text: "沿河走一小段吧，风比刚才大了。" },
      { id: "scarf", time: "19:27", dateTime: "2026-08-02T19:27:00+08:00", speaker: "林澄", text: "风这么大，围巾给你一半吧。这样我们都不会太冷。" },
      { id: "shared-scarf", time: "19:31", dateTime: "2026-08-02T19:31:00+08:00", speaker: "你", text: "那就慢一点走，不然这条围巾要把我们拽到一起了。" },
      { id: "old-song", time: "19:36", dateTime: "2026-08-02T19:36:00+08:00", speaker: "林澄", text: "河对面那家店放的歌，好像是我们上次在唱片店听到的那首。" },
      { id: "walk-route", time: "19:43", dateTime: "2026-08-02T19:43:00+08:00", speaker: "你", text: "下次换一条靠里面的小路，也许会安静一点。" }
    ]
  },
  {
    id: "way-home",
    title: "回程",
    timeRange: "19:51–20:16",
    lines: [
      { id: "market-followup", time: "19:51", dateTime: "2026-08-02T19:51:00+08:00", speaker: "林澄", text: "我明天把最后两组杯子的照片发你，不过你不用马上帮我选。" },
      { id: "market-boundary", time: "19:57", dateTime: "2026-08-02T19:57:00+08:00", speaker: "你", text: "好，你想听意见的时候再告诉我。我先看看它们各自哪里不一样。" },
      { id: "record-store-memory", time: "20:04", dateTime: "2026-08-02T20:04:00+08:00", speaker: "林澄", text: "刚才那首歌让我又想起那家唱片店，那里周六下午也开门。" },
      { id: "next-saturday", time: "20:10", dateTime: "2026-08-02T20:10:00+08:00", speaker: "你", text: "如果市集前你想换换脑子，我们周六傍晚可以再到河边走走。" },
      { id: "promise-address", time: "20:16", dateTime: "2026-08-02T20:16:00+08:00", speaker: "你", text: "我回去把那家唱片店的地址发给你，那家周六下午也开门。" }
    ]
  }
];

function normalizeTranscriptQuery(value: string) {
  return value.trim().toLocaleLowerCase("zh-CN");
}

export function StaticTranscriptReview({
  open,
  targetLineId,
  targetVersion,
  onOpenChange
}: {
  open: boolean;
  targetLineId: string | null;
  targetVersion: number;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = normalizeTranscriptQuery(query);

  useEffect(() => {
    if (targetLineId) setQuery("");
  }, [targetLineId, targetVersion]);

  useEffect(() => {
    if (!open || !targetLineId || normalizedQuery) return;
    const line = document.getElementById(`transcript-${targetLineId}`);
    if (!line) return;
    line.focus({ preventScroll: true });
    line.scrollIntoView?.({ block: "center" });
  }, [normalizedQuery, open, targetLineId, targetVersion]);

  const visibleChapters = useMemo(() => {
    if (!normalizedQuery) return transcriptChapters;
    return transcriptChapters
      .map((chapter) => ({
        ...chapter,
        lines: chapter.lines.filter((line) =>
          normalizeTranscriptQuery(`${line.time} ${line.speaker} ${line.text}`).includes(normalizedQuery)
        )
      }))
      .filter((chapter) => chapter.lines.length > 0);
  }, [normalizedQuery]);
  const visibleLineCount = visibleChapters.reduce((count, chapter) => count + chapter.lines.length, 0);

  return (
    <details
      className={styles.aTranscriptPreview}
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
    >
      <summary>
        <span>
          <b>查看完整文字稿</b>
          <small>1 小时 42 分钟 · 按这次相处的过程回看</small>
        </span>
        <em>只读</em>
      </summary>
      <section
        className={styles.aTranscriptReview}
        role="region"
        aria-label="周日晚餐完整文字稿"
        data-transcript-mode="full-review"
      >
        <header>
          <span>
            <small>周日晚餐.m4a</small>
            <h2>完整文字稿</h2>
          </span>
          <em>共 {transcriptChapters.reduce((count, chapter) => count + chapter.lines.length, 0)} 段虚构文字</em>
        </header>

        <form
          className={styles.aTranscriptSearch}
          role="search"
          aria-label="在周日晚餐文字稿里查找"
          onSubmit={(event) => event.preventDefault()}
        >
          <label htmlFor="recap-transcript-search">在这次相处里找一句话</label>
          <div>
            <span aria-hidden="true">⌕</span>
            <input
              id="recap-transcript-search"
              value={query}
              placeholder="例如：围巾、妈妈生日、唱片店"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? <button type="button" onClick={() => setQuery("")}>清空</button> : null}
          </div>
        </form>

        {normalizedQuery ? (
          <p className={styles.aTranscriptStatus} role="status">
            {visibleLineCount
              ? `在文字稿里找到 ${visibleLineCount} 处“${query.trim()}”。`
              : `这份文字稿样例里没有“${query.trim()}”。`}
          </p>
        ) : null}

        <div className={styles.aTranscriptScroll} tabIndex={0} aria-label="完整文字稿内容">
          {visibleChapters.map((chapter) => (
            <section className={styles.aTranscriptChapter} key={chapter.id} data-transcript-chapter={chapter.id}>
              <header>
                <h3>{chapter.title}</h3>
                <span>{chapter.timeRange}</span>
              </header>
              <ol aria-label={`${chapter.title}文字稿`}>
                {chapter.lines.map((line) => {
                  const isTarget = line.id === targetLineId;
                  return (
                    <li
                      id={`transcript-${line.id}`}
                      key={line.id}
                      data-transcript-line
                      data-speaker={line.speaker}
                      aria-current={isTarget ? "true" : undefined}
                      tabIndex={isTarget ? -1 : undefined}
                    >
                      <time dateTime={line.dateTime}>{line.time}</time>
                      <b>{line.speaker}</b>
                      <p>{line.text}</p>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
          {!visibleChapters.length ? (
            <p className={styles.aTranscriptEmpty}>换一个词，或者清空后继续往下看。</p>
          ) : null}
        </div>
        <small className={styles.aDemoBoundary}>这里只演示长文字稿的回看方式，不会读取、播放或保存任何录音。</small>
      </section>
    </details>
  );
}
