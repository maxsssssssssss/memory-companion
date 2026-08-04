"use client";

import { useLayoutEffect, useRef, useState } from "react";

import styles from "./exploration.module.css";

type ProfileFactId = "remembered" | "recent" | "between" | "promise";

type ProfileFact = {
  id: ProfileFactId;
  title: string;
  summary: string;
  side: "left" | "right";
  fragments: Array<{
    meta: string;
    text: string;
    speaker: string;
    quote: string;
  }>;
};

const profileFacts: ProfileFact[] = [
  {
    id: "remembered",
    title: "你记得的Ta",
    summary: "Ta喜欢旧书店、桂花拿铁，也喜欢在傍晚没有目的地散步。",
    side: "left",
    fragments: [
      { meta: "7 月 19 日 · 16:08", text: "喜欢书页边上以前读者留下的小字。", speaker: "林澄", quote: "我喜欢书页边上有以前读者留下的小字，会觉得这本书走过很远。" },
      { meta: "7 月 5 日 · 16:02", text: "桂花味会让Ta想起秋天刚开始的几天。", speaker: "林澄", quote: "桂花味很像秋天刚开始的那几天。" },
      { meta: "6 月 28 日 · 19:11", text: "傍晚散步时，不太在意一定要走到哪里。", speaker: "林澄", quote: "不一定要走到哪里，天黑之前慢慢晃一会儿就很好。" }
    ]
  },
  {
    id: "recent",
    title: "Ta最近",
    summary: "正在准备第一次独立参加的陶艺市集。Ta期待，也有一点担心准备得不够好。",
    side: "right",
    fragments: [
      { meta: "8 月 2 日 · 18:37", text: "还在挑选要带去的杯子，第一次独立摆摊。", speaker: "林澄", quote: "我还在挑要带去市集的那一组杯子，第一次自己摆摊。" },
      { meta: "8 月 2 日 · 18:42", text: "最担心的是作品不够成熟，也怕现场忙不过来。", speaker: "林澄", quote: "会担心准备得不够好，也怕现场一忙起来就顾不过来。" },
      { meta: "6 月 21 日 · 17:12", text: "妈妈的生日快到了，还没决定礼物。", speaker: "林澄", quote: "妈妈快过生日了，我还没想好要送花还是做一只杯子。" }
    ]
  },
  {
    id: "between",
    title: "你们之间",
    summary: "雨天在旧书店的屋檐下聊了很久，也慢慢有了只属于你们的小习惯。",
    side: "left",
    fragments: [
      { meta: "7 月 19 日 · 16:31", text: "在旧书店屋檐下躲雨，聊到小时候的家。", speaker: "你", quote: "雨小一点也不用急着走，我们再逛一层。" },
      { meta: "7 月 5 日 · 15:26", text: "同时认出一首老歌，后来一起听完了整张唱片。", speaker: "你", quote: "这首歌我高中时循环听过很久，没想到你也认识。" },
      { meta: "6 月 28 日 · 19:18", text: "约好散步时轮流选一条没走过的小路。", speaker: "林澄", quote: "下次换你挑路，我们找一条都没走过的。" }
    ]
  },
  {
    id: "promise",
    title: "你答应了",
    summary: "2 件还记着 · 1 件已经做到。点开可以逐件看看。",
    side: "right",
    fragments: []
  }
];

const initialPromises = [
  { id: "record-store", text: "把那家唱片店的地址发给Ta", meta: "8 月 2 日 · 20:16", speaker: "你", quote: "我回去把那家唱片店的地址发给你，那家周六下午也开门。", done: false },
  { id: "market-poster", text: "帮Ta看一遍市集介绍", meta: "7 月 30 日 · 21:08", speaker: "你", quote: "你把市集介绍发我吧，我今晚帮你看一遍。", done: true },
  { id: "birthday-flowers", text: "找一家适合给妈妈选花的店", meta: "6 月 21 日 · 17:18", speaker: "你", quote: "我知道一家很安静的花店，回去把名字找给你。", done: false }
];

export function ExpandableProfileFacts() {
  const [expandedId, setExpandedId] = useState<ProfileFactId | null>(null);
  const [promises, setPromises] = useState(initialPromises);
  const cardRefs = useRef<Record<ProfileFactId, HTMLElement | null>>({
    remembered: null,
    recent: null,
    between: null,
    promise: null
  });
  const previousRects = useRef<Map<ProfileFactId, DOMRect> | null>(null);
  const expandedFact = profileFacts.find((fact) => fact.id === expandedId);
  const squeezeSide = expandedFact
    ? expandedFact.side === "left"
      ? "right"
      : "left"
    : "none";

  useLayoutEffect(() => {
    const firstRects = previousRects.current;
    previousRects.current = null;
    if (!firstRects) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    for (const fact of profileFacts) {
      const card = cardRefs.current[fact.id];
      const first = firstRects.get(fact.id);
      if (!card || !first || typeof card.animate !== "function") continue;

      const last = card.getBoundingClientRect();
      if (!first.width || !first.height || !last.width || !last.height) continue;

      card.animate(
        [
          {
            transform: `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / last.width}, ${first.height / last.height})`,
            transformOrigin: "top left"
          },
          { transform: "none", transformOrigin: "top left" }
        ],
        {
          duration: 440,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)"
        }
      );
    }
  }, [expandedId]);

  const toggleFact = (id: ProfileFactId) => {
    previousRects.current = new Map(
      profileFacts.flatMap((fact) => {
        const card = cardRefs.current[fact.id];
        return card ? [[fact.id, card.getBoundingClientRect()] as const] : [];
      })
    );
    setExpandedId((current) => (current === id ? null : id));
  };

  const compactFacts = expandedId
    ? profileFacts.filter((fact) => fact.id !== expandedId)
    : [];
  const openPromiseCount = promises.filter((promise) => !promise.done).length;
  const donePromiseCount = promises.length - openPromiseCount;

  const togglePromise = (id: string) => {
    setPromises((current) =>
      current.map((promise) => promise.id === id ? { ...promise, done: !promise.done } : promise)
    );
  };

  return (
    <section
      className={styles.aProfileFacts}
      aria-label="关于Ta的四个片段"
      data-uniform-card-group="person"
      data-expanded-card={expandedId ?? "none"}
      data-squeeze-side={squeezeSide}
    >
      {profileFacts.map((fact) => {
        const state = expandedId === null
          ? "idle"
          : expandedId === fact.id
            ? "expanded"
            : "compact";
        const railOrder = state === "compact"
          ? compactFacts.findIndex((item) => item.id === fact.id) + 1
          : 0;
        const contentId = `profile-fact-${fact.id}`;

        return (
          <article
            id={`profile-card-${fact.id}`}
            className={styles.aProfileFact}
            data-card-id={fact.id}
            data-card-state={state}
            data-rail-order={railOrder || undefined}
            key={fact.id}
            ref={(node) => {
              cardRefs.current[fact.id] = node;
            }}
          >
            <h2>
              <button
                type="button"
                aria-controls={contentId}
                aria-expanded={state === "expanded"}
                title={state === "expanded" ? "再次点击恢复四张卡片" : "点击放大这张卡片"}
                onClick={() => toggleFact(fact.id)}
              >
                {fact.title}
              </button>
            </h2>
            <div
              id={contentId}
              data-profile-fact-content
              hidden={state === "compact"}
            >
              {state === "expanded" ? (
                fact.id === "promise" ? (
                  <section className={styles.aPromiseList} aria-label="你答应的几件事" data-module="promise-list">
                    <ul>
                      {promises.map((promise) => (
                        <li key={promise.id} data-promise-state={promise.done ? "done" : "open"}>
                          <span>
                            <small>{promise.done ? "已经做到" : "还没做到"}</small>
                            <b>{promise.text}</b>
                            <em>{promise.meta}</em>
                          </span>
                          <button
                            type="button"
                            aria-pressed={promise.done}
                            aria-label={`${promise.done ? "改回还没做到" : "标为已经做到"}：${promise.text}`}
                            onClick={() => togglePromise(promise.id)}
                          >
                            {promise.done ? "改回还没做到" : "标为已经做到"}
                          </button>
                          <details className={styles.aPromiseSource}>
                            <summary>回到原话</summary>
                            <blockquote><small>{promise.meta} · {promise.speaker}</small>“{promise.quote}”</blockquote>
                          </details>
                        </li>
                      ))}
                    </ul>
                    <small className={styles.aDemoBoundary}>状态只在当前 UI Demo 里切换，刷新后恢复。</small>
                  </section>
                ) : (
                  <ul className={styles.aProfileFragmentList}>
                    {fact.fragments.map((fragment) => (
                      <li key={`${fact.id}-${fragment.meta}`}>
                        <small>{fragment.meta}</small>
                        <p>{fragment.text}</p>
                        <details className={styles.aProfileSource}>
                          <summary>回到原话</summary>
                          <blockquote><small>{fragment.meta} · {fragment.speaker}</small>“{fragment.quote}”</blockquote>
                        </details>
                      </li>
                    ))}
                  </ul>
                )
              ) : (
                <p className={styles.aProfileFactSummary}>
                  {fact.id === "promise"
                    ? `${openPromiseCount} 件还记着 · ${donePromiseCount} 件已经做到。点开可以逐件看看。`
                    : fact.summary}
                </p>
              )}
            </div>
          </article>
        );
      })}
    </section>
  );
}
