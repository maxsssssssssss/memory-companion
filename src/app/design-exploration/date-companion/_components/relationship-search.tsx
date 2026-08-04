"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import styles from "./exploration.module.css";

type SearchGroup = "关于Ta" | "你答应过的" | "这次相处" | "一起走过的几次" | "见Ta前";

type RelationshipSearchEntry = {
  id: string;
  group: SearchGroup;
  kind: "remembered" | "recent" | "between" | "promise" | "recap" | "interaction" | "prepare";
  title: string;
  excerpt: string;
  keywords: string;
  href: string;
  targetLabel: string;
  source: {
    occasion: string;
    time: string;
    dateTime: string;
    speaker: "你" | "林澄";
    quote: string;
  };
};

const prototypeBase = "/design-exploration/date-companion/a";

const searchEntries: RelationshipSearchEntry[] = [
  {
    id: "remembered-bookstore",
    group: "关于Ta",
    kind: "remembered",
    title: "你记得的Ta",
    excerpt: "Ta喜欢旧书店，也喜欢书页边上以前读者留下的小字。",
    keywords: "喜欢 旧书店 书页 小字 阅读",
    href: "#profile-card-remembered",
    targetLabel: "回到你记得的Ta",
    source: {
      occasion: "旧书店门口",
      time: "16:08",
      dateTime: "2026-07-19T16:08:00+08:00",
      speaker: "林澄",
      quote: "我喜欢书页边上有以前读者留下的小字，会觉得这本书走过很远。"
    }
  },
  {
    id: "remembered-coffee",
    group: "关于Ta",
    kind: "remembered",
    title: "你记得的Ta",
    excerpt: "桂花味会让Ta想起秋天刚开始的几天。",
    keywords: "喜欢 桂花 桂花拿铁 咖啡 秋天",
    href: "#profile-card-remembered",
    targetLabel: "回到你记得的Ta",
    source: {
      occasion: "巷口咖啡",
      time: "16:02",
      dateTime: "2026-07-05T16:02:00+08:00",
      speaker: "林澄",
      quote: "桂花味很像秋天刚开始的那几天。"
    }
  },
  {
    id: "recent-market",
    group: "关于Ta",
    kind: "recent",
    title: "Ta最近",
    excerpt: "Ta正在准备第一次独立参加的陶艺市集，也担心自己还没准备好。",
    keywords: "最近 陶艺 市集 摆摊 杯子 紧张 准备",
    href: "#profile-card-recent",
    targetLabel: "回到Ta最近",
    source: {
      occasion: "周日晚餐",
      time: "18:42",
      dateTime: "2026-08-02T18:42:00+08:00",
      speaker: "林澄",
      quote: "第一次一个人摆摊，还是会担心准备得不够好。"
    }
  },
  {
    id: "recent-birthday",
    group: "关于Ta",
    kind: "recent",
    title: "Ta最近",
    excerpt: "Ta妈妈的生日快到了，Ta还没决定送花还是亲手做一只杯子。",
    keywords: "最近 妈妈 母亲 生日 礼物 花 杯子",
    href: "#profile-card-recent",
    targetLabel: "回到Ta最近",
    source: {
      occasion: "周日晚餐",
      time: "19:05",
      dateTime: "2026-08-02T19:05:00+08:00",
      speaker: "林澄",
      quote: "妈妈生日快到了，我还没想好送花还是做一只杯子。"
    }
  },
  {
    id: "between-rain",
    group: "关于Ta",
    kind: "between",
    title: "你们之间",
    excerpt: "你们在旧书店的屋檐下躲过雨，也慢慢有了轮流选散步路线的小习惯。",
    keywords: "你们之间 躲雨 旧书店 散步 小路 习惯",
    href: "#profile-card-between",
    targetLabel: "回到你们之间",
    source: {
      occasion: "旧书店门口",
      time: "16:31",
      dateTime: "2026-07-19T16:31:00+08:00",
      speaker: "你",
      quote: "雨小一点也不用急着走，我们再逛一层。"
    }
  },
  {
    id: "promise-address",
    group: "你答应过的",
    kind: "promise",
    title: "把唱片店的地址发给Ta",
    excerpt: "这件事还没做到，Ta说那家店周六下午也开门。",
    keywords: "答应 承诺 唱片店 地址 周六 还没做到",
    href: "#profile-card-promise",
    targetLabel: "回到你答应了",
    source: {
      occasion: "河边散步",
      time: "20:16",
      dateTime: "2026-08-02T20:16:00+08:00",
      speaker: "你",
      quote: "我回去把那家唱片店的地址发给你，那家周六下午也开门。"
    }
  },
  {
    id: "promise-market-copy",
    group: "你答应过的",
    kind: "promise",
    title: "帮Ta看一遍市集介绍",
    excerpt: "这件事已经做到，来自市集准备前的一次晚间通话。",
    keywords: "答应 承诺 市集 介绍 已经做到",
    href: "#profile-card-promise",
    targetLabel: "回到你答应了",
    source: {
      occasion: "晚间通话",
      time: "21:08",
      dateTime: "2026-07-30T21:08:00+08:00",
      speaker: "你",
      quote: "你把市集介绍发我吧，我今晚帮你看一遍。"
    }
  },
  {
    id: "promise-flowers",
    group: "你答应过的",
    kind: "promise",
    title: "找一家适合给妈妈选花的店",
    excerpt: "这件事还没做到，是你听到妈妈生日后答应找的。",
    keywords: "答应 承诺 妈妈 生日 花店 还没做到",
    href: "#profile-card-promise",
    targetLabel: "回到你答应了",
    source: {
      occasion: "花店外",
      time: "17:18",
      dateTime: "2026-06-21T17:18:00+08:00",
      speaker: "你",
      quote: "我知道一家很安静的花店，回去把名字找给你。"
    }
  },
  {
    id: "recap-scarf",
    group: "这次相处",
    kind: "recap",
    title: "这次最值得留下的一刻",
    excerpt: "河边的风很大，Ta把围巾分了一半给你。",
    keywords: "复盘 今晚 围巾 河边 风 温柔 一刻",
    href: `${prototypeBase}/recap#recap-card-moment`,
    targetLabel: "打开这次相处",
    source: {
      occasion: "河边散步",
      time: "19:27",
      dateTime: "2026-08-02T19:27:00+08:00",
      speaker: "林澄",
      quote: "风这么大，围巾给你一半吧。这样我们都不会太冷。"
    }
  },
  {
    id: "recap-mentioned",
    group: "这次相处",
    kind: "recap",
    title: "Ta特别提到了什么？",
    excerpt: "Ta第一次独立参加市集，担心自己的作品还不够成熟。",
    keywords: "复盘 提到 陶艺 市集 摆摊 作品 成熟 紧张",
    href: `${prototypeBase}/recap#recap-card-mentioned`,
    targetLabel: "打开这次相处",
    source: {
      occasion: "周日晚餐",
      time: "18:42",
      dateTime: "2026-08-02T18:42:00+08:00",
      speaker: "林澄",
      quote: "第一次一个人摆摊，还是会担心准备得不够好。"
    }
  },
  {
    id: "recap-promise",
    group: "这次相处",
    kind: "recap",
    title: "你答应了什么？",
    excerpt: "你答应回去以后，把那家唱片店的地址发给Ta。",
    keywords: "复盘 答应 承诺 唱片店 地址 还没做到",
    href: `${prototypeBase}/recap#recap-card-promise`,
    targetLabel: "打开这次相处",
    source: {
      occasion: "河边散步",
      time: "20:16",
      dateTime: "2026-08-02T20:16:00+08:00",
      speaker: "你",
      quote: "我回去把那家唱片店的地址发给你，那家周六下午也开门。"
    }
  },
  {
    id: "recap-continue",
    group: "这次相处",
    kind: "recap",
    title: "下次想从哪里继续？",
    excerpt: "可以问问Ta最后选了哪些陶杯，也问问妈妈的生日准备。",
    keywords: "复盘 下次 继续 话题 陶杯 妈妈 生日",
    href: `${prototypeBase}/recap#recap-card-continue`,
    targetLabel: "打开这次相处",
    source: {
      occasion: "周日晚餐",
      time: "18:43",
      dateTime: "2026-08-02T18:43:00+08:00",
      speaker: "你",
      quote: "最后决定带哪一组陶杯了吗？下次见面给我看看。"
    }
  },
  {
    id: "history-market-walk",
    group: "一起走过的几次",
    kind: "interaction",
    title: "周日晚餐与河边散步",
    excerpt: "Ta说起第一次独立摆摊的期待和不安，你也答应把唱片店地址发给Ta。",
    keywords: "历史 晚餐 河边 散步 陶艺 市集 妈妈 生日 唱片店",
    href: "#interaction-card-market-walk",
    targetLabel: "回到这次相处",
    source: {
      occasion: "周日晚餐",
      time: "19:05",
      dateTime: "2026-08-02T19:05:00+08:00",
      speaker: "林澄",
      quote: "妈妈生日快到了，我还没想好送花还是做一只杯子。"
    }
  },
  {
    id: "history-bookstore",
    group: "一起走过的几次",
    kind: "interaction",
    title: "旧书店门口躲雨",
    excerpt: "你们聊到喜欢的旧书，也第一次谈到各自小时候的家。",
    keywords: "历史 旧书店 躲雨 小时候 家 阅读",
    href: "#interaction-card-bookstore-rain",
    targetLabel: "回到这次相处",
    source: {
      occasion: "旧书店门口",
      time: "16:08",
      dateTime: "2026-07-19T16:08:00+08:00",
      speaker: "林澄",
      quote: "我喜欢书页边上有以前读者留下的小字。"
    }
  },
  {
    id: "history-record-store",
    group: "一起走过的几次",
    kind: "interaction",
    title: "唱片店和桂花拿铁",
    excerpt: "你们同时认出一首老歌，Ta说桂花味会让人想起秋天。",
    keywords: "历史 唱片店 桂花 拿铁 咖啡 老歌 秋天",
    href: "#interaction-card-record-store",
    targetLabel: "回到这次相处",
    source: {
      occasion: "巷口咖啡",
      time: "16:02",
      dateTime: "2026-07-05T16:02:00+08:00",
      speaker: "林澄",
      quote: "桂花味很像秋天刚开始的那几天。"
    }
  },
  {
    id: "prepare-market",
    group: "见Ta前",
    kind: "prepare",
    title: "Ta最近最在意的",
    excerpt: "周末的陶艺市集能不能顺利，是Ta最近最在意的事。",
    keywords: "见面前 准备 最近 在意 陶艺 市集 摆摊",
    href: `${prototypeBase}/prepare#prepare-recent`,
    targetLabel: "打开见面前",
    source: {
      occasion: "周日晚餐",
      time: "18:42",
      dateTime: "2026-08-02T18:42:00+08:00",
      speaker: "林澄",
      quote: "第一次一个人摆摊，还是会担心准备得不够好。"
    }
  },
  {
    id: "prepare-birthday",
    group: "见Ta前",
    kind: "prepare",
    title: "你们上次聊到",
    excerpt: "Ta妈妈的生日快到了，Ta还没有决定送什么礼物。",
    keywords: "见面前 准备 上次 妈妈 生日 礼物",
    href: `${prototypeBase}/prepare#prepare-last-talk`,
    targetLabel: "打开见面前",
    source: {
      occasion: "周日晚餐",
      time: "19:05",
      dateTime: "2026-08-02T19:05:00+08:00",
      speaker: "林澄",
      quote: "妈妈生日快到了，我还没想好送花还是做一只杯子。"
    }
  },
  {
    id: "prepare-continue",
    group: "见Ta前",
    kind: "prepare",
    title: "可以自然继续的话题",
    excerpt: "可以自然地问问Ta，市集最后决定带哪一组陶杯。",
    keywords: "见面前 准备 继续 话题 开场 陶杯 市集",
    href: `${prototypeBase}/prepare#prepare-continue`,
    targetLabel: "打开见面前",
    source: {
      occasion: "周日晚餐",
      time: "18:43",
      dateTime: "2026-08-02T18:43:00+08:00",
      speaker: "你",
      quote: "最后决定带哪一组陶杯了吗？下次见面给我看看。"
    }
  }
];

const groupOrder: SearchGroup[] = ["关于Ta", "你答应过的", "这次相处", "一起走过的几次", "见Ta前"];

function normalizeSearchText(value: string) {
  return value.trim().toLocaleLowerCase("zh-CN");
}

export function RelationshipSearch() {
  const [query, setQuery] = useState("");
  const normalizedQuery = normalizeSearchText(query);
  const results = useMemo(() => {
    if (!normalizedQuery) return [];
    return searchEntries.filter((entry) =>
      normalizeSearchText([
        entry.group,
        entry.title,
        entry.excerpt,
        entry.keywords,
        entry.source.occasion,
        entry.source.speaker,
        entry.source.quote
      ].join(" ")).includes(normalizedQuery)
    );
  }, [normalizedQuery]);

  return (
    <section
      className={styles.aRelationshipSearch}
      aria-labelledby="relationship-search-title"
      data-module="relationship-search"
    >
      <header className={styles.aWideSectionHeader}>
        <span>
          <small>喜欢的事、最近提到的、你答应过的</small>
          <h2 id="relationship-search-title">找找关于Ta的事</h2>
        </span>
      </header>

      <form
        className={styles.aHistorySearch}
        role="search"
        aria-label="找一找你和林澄之间的内容"
        onSubmit={(event) => event.preventDefault()}
      >
        <label htmlFor="relationship-wide-search">找一句话、一个地方或一件小事</label>
        <div>
          <span aria-hidden="true">⌕</span>
          <input
            id="relationship-wide-search"
            value={query}
            placeholder="例如：陶艺、市集、妈妈生日"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? <button type="button" onClick={() => setQuery("")}>清空</button> : null}
        </div>
        <small>会一起找人物片段、约定、复盘、相处记录和见面前内容；只查当前虚构界面样例。</small>
      </form>

      {normalizedQuery ? (
        <div className={styles.aRelationshipSearchResults}>
          <p className={styles.aRelationshipSearchStatus} role="status">
            {results.length
              ? `找到 ${results.length} 段和“${query.trim()}”有关的内容。`
              : `这组界面样例里还没有“${query.trim()}”。换一个词看看。`}
          </p>
          {groupOrder.map((group) => {
            const groupResults = results.filter((entry) => entry.group === group);
            if (!groupResults.length) return null;
            return (
              <section className={styles.aRelationshipSearchGroup} key={group} aria-label={group}>
                <h3>{group}</h3>
                <div>
                  {groupResults.map((entry) => (
                    <article
                      key={entry.id}
                      data-relationship-search-result
                      data-search-kind={entry.kind}
                    >
                      <header>
                        <small>{entry.source.occasion} · {entry.source.time}</small>
                        <h4>{entry.title}</h4>
                      </header>
                      <p>{entry.excerpt}</p>
                      <footer>
                        <details>
                          <summary aria-label={`回到原话：${entry.title} · ${entry.source.time}`}>回到原话</summary>
                          <blockquote>
                            <time dateTime={entry.source.dateTime}>{entry.source.time}</time>
                            <p><b>{entry.source.speaker}：</b>“{entry.source.quote}”</p>
                          </blockquote>
                        </details>
                        <Link href={entry.href}>{entry.targetLabel} <span aria-hidden="true">↗</span></Link>
                      </footer>
                    </article>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <p className={styles.aRelationshipSearchIdle}>输入一个词，再慢慢翻回相关的片段。</p>
      )}
    </section>
  );
}
