"use client";

import { useState } from "react";

import styles from "./exploration.module.css";

type Interaction = {
  id: string;
  date: string;
  dateTime: string;
  title: string;
  place: string;
  summary: string;
  fragments: Array<{
    time: string;
    dateTime: string;
    speaker: "你" | "林澄";
    text: string;
  }>;
};

const interactions: Interaction[] = [
  {
    id: "market-walk",
    date: "8 月 2 日 · 周日",
    dateTime: "2026-08-02",
    title: "周日晚餐与河边散步",
    place: "南岸小馆 · 河边",
    summary: "Ta第一次认真说起独立参加陶艺市集的期待和不安。",
    fragments: [
      {
        time: "18:42",
        dateTime: "2026-08-02T18:42:00+08:00",
        speaker: "林澄",
        text: "第一次一个人摆摊，还是会担心准备得不够好。"
      },
      {
        time: "20:16",
        dateTime: "2026-08-02T20:16:00+08:00",
        speaker: "你",
        text: "我回去把唱片店的地址发给你。"
      },
      {
        time: "19:05",
        dateTime: "2026-08-02T19:05:00+08:00",
        speaker: "林澄",
        text: "妈妈生日快到了，我还没想好送花还是做一只杯子。"
      }
    ]
  },
  {
    id: "bookstore-rain",
    date: "7 月 19 日 · 周日",
    dateTime: "2026-07-19",
    title: "旧书店门口躲雨",
    place: "青禾旧书店",
    summary: "你们在屋檐下聊到喜欢的旧书，也第一次谈到各自小时候的家。",
    fragments: [
      {
        time: "16:08",
        dateTime: "2026-07-19T16:08:00+08:00",
        speaker: "林澄",
        text: "我喜欢书页边上有以前读者留下的小字。"
      },
      {
        time: "16:31",
        dateTime: "2026-07-19T16:31:00+08:00",
        speaker: "你",
        text: "雨小一点也不用急着走，我们再逛一层。"
      }
    ]
  },
  {
    id: "record-store",
    date: "7 月 5 日 · 周日",
    dateTime: "2026-07-05",
    title: "唱片店和桂花拿铁",
    place: "朝夕唱片 · 巷口咖啡",
    summary: "你们同时认出一首老歌，Ta说桂花味会让人想起秋天。",
    fragments: [
      {
        time: "15:26",
        dateTime: "2026-07-05T15:26:00+08:00",
        speaker: "你",
        text: "这首歌我高中时循环听过很久。"
      },
      {
        time: "16:02",
        dateTime: "2026-07-05T16:02:00+08:00",
        speaker: "林澄",
        text: "桂花味很像秋天刚开始的那几天。"
      }
    ]
  }
];

export function RelationshipHistory() {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <>
      <section
        className={styles.aHistorySection}
        aria-labelledby="relationship-history-title"
        data-module="interaction-history"
      >
        <header className={styles.aWideSectionHeader}>
          <span>
            <small>慢慢累积下来的片段</small>
            <h2 id="relationship-history-title">一起走过的几次</h2>
          </span>
        </header>

        <div className={styles.aHistoryList}>
          {interactions.map((interaction) => {
              const isOpen = openId === interaction.id;
              const panelId = `interaction-${interaction.id}`;
              return (
                <article
                  id={`interaction-card-${interaction.id}`}
                  key={interaction.id}
                  data-interaction-entry={interaction.id}
                >
                  <button
                    type="button"
                    aria-controls={panelId}
                    aria-expanded={isOpen}
                    onClick={() => setOpenId((current) => current === interaction.id ? null : interaction.id)}
                  >
                    <time dateTime={interaction.dateTime}>{interaction.date}</time>
                    <span><b>{interaction.title}</b><small>{interaction.place}</small></span>
                    <em>{isOpen ? "收起" : "展开"}</em>
                  </button>
                  <div id={panelId} hidden={!isOpen}>
                    <p>{interaction.summary}</p>
                    <ul>
                      {interaction.fragments.map((fragment) => (
                        <li key={fragment.dateTime} data-interaction-fragment>
                          <time dateTime={fragment.dateTime}>{fragment.time}</time>
                          <b>{fragment.speaker}</b>
                          <span>{fragment.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </article>
              );
          })}
        </div>
      </section>

      <section
        className={styles.aObservationSection}
        aria-labelledby="relationship-observation-title"
        data-module="relationship-observations"
      >
        <header className={styles.aWideSectionHeader}>
          <span>
            <small>不是结论，只是一种可能</small>
            <h2 id="relationship-observation-title">关于你们的一点观察</h2>
          </span>
        </header>
        <div className={styles.aObservationGrid}>
          <article>
            <p>从两次留下的片段看，Ta谈起作品时可能越来越具体，也更愿意让你看到准备的过程；这仍不一定完整。</p>
            <details>
              <summary>看看为什么这样想</summary>
              <div>
                <blockquote><small>7 月 30 日 · 晚间通话</small>“作品还没挑好，等我再整理一下。”</blockquote>
                <blockquote><small>8 月 2 日 · 周日晚餐</small>“我在两个杯子版本里选，下次把釉色和杯口的差别给你看。”</blockquote>
              </div>
            </details>
          </article>
        </div>
        <small className={styles.aDemoBoundary}>这些观察都是虚构的 UI Demo 文案，关系该怎样理解仍由你判断。</small>
      </section>
    </>
  );
}
