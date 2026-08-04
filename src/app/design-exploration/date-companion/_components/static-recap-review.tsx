"use client";

import { useMemo, useState } from "react";

import styles from "./exploration.module.css";
import { StaticTranscriptReview } from "./static-transcript-review";

type RecapItemId = "moment" | "mentioned" | "promise" | "continue";

type RecapItem = {
  id: RecapItemId;
  number: string;
  title: string;
  text: string;
  source: {
    time: string;
    dateTime: string;
    speaker: string;
    quote: string;
    transcriptLineId: string;
  };
};

const initialRecapItems: RecapItem[] = [
  {
    id: "moment",
    number: "01",
    title: "这次最值得留下的一刻",
    text: "河边的风很大，Ta把围巾分了一半给我。",
    source: {
      time: "19:27",
      dateTime: "2026-08-02T19:27:00+08:00",
      speaker: "林澄",
      quote: "风这么大，围巾给你一半吧。这样我们都不会太冷。",
      transcriptLineId: "scarf"
    }
  },
  {
    id: "mentioned",
    number: "02",
    title: "Ta特别提到了什么？",
    text: "第一次参加市集，担心自己的作品还不够成熟。",
    source: {
      time: "18:42",
      dateTime: "2026-08-02T18:42:00+08:00",
      speaker: "林澄",
      quote: "其实是有点期待的，但第一次一个人摆摊，还是会担心准备得不够好。",
      transcriptLineId: "market-concern"
    }
  },
  {
    id: "promise",
    number: "03",
    title: "你答应了什么？",
    text: "回去以后，把那家唱片店的地址发给Ta。",
    source: {
      time: "20:16",
      dateTime: "2026-08-02T20:16:00+08:00",
      speaker: "你",
      quote: "我回去把那家唱片店的地址发给你，那家周六下午也开门。",
      transcriptLineId: "promise-address"
    }
  },
  {
    id: "continue",
    number: "04",
    title: "下次想从哪里继续？",
    text: "问问Ta最后选了哪些陶杯，也问问妈妈的生日准备。",
    source: {
      time: "18:43",
      dateTime: "2026-08-02T18:43:00+08:00",
      speaker: "你",
      quote: "最后决定带哪一组陶杯了吗？下次见面给我看看。",
      transcriptLineId: "continue-cups"
    }
  }
];

export function StaticRecapReview() {
  const [peopleConfirmed, setPeopleConfirmed] = useState(false);
  const [finalConfirmed, setFinalConfirmed] = useState(false);
  const [items, setItems] = useState(initialRecapItems);
  const [excludedIds, setExcludedIds] = useState<RecapItemId[]>([]);
  const [editingId, setEditingId] = useState<RecapItemId | null>(null);
  const [draft, setDraft] = useState("");
  const [sourceId, setSourceId] = useState<RecapItemId | null>(null);
  const [feedback, setFeedback] = useState("");
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [transcriptTargetId, setTranscriptTargetId] = useState<string | null>(null);
  const [transcriptTargetVersion, setTranscriptTargetVersion] = useState(0);

  const selectedSource = useMemo(
    () => items.find((item) => item.id === sourceId) ?? null,
    [items, sourceId]
  );
  const keptCount = items.length - excludedIds.length;

  const beginEdit = (item: RecapItem) => {
    setEditingId(item.id);
    setDraft(item.text);
    setFeedback("");
    setFinalConfirmed(false);
  };

  const applyEdit = (id: RecapItemId) => {
    const nextText = draft.trim();
    if (!nextText) return;
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, text: nextText } : item))
    );
    setEditingId(null);
    setFeedback("修改只显示在这个界面样例里，刷新后会恢复。 ");
    setFinalConfirmed(false);
  };

  const toggleExcluded = (id: RecapItemId) => {
    setExcludedIds((current) =>
      current.includes(id) ? current.filter((itemId) => itemId !== id) : [...current, id]
    );
    setEditingId((current) => (current === id ? null : current));
    setFeedback("留下与否只改变当前界面样例，没有保存。 ");
    setFinalConfirmed(false);
  };

  const toggleSource = (id: RecapItemId) => {
    setSourceId((current) => (current === id ? null : id));
  };

  return (
    <>
      <section
        className={styles.aPeopleCheck}
        aria-labelledby="recap-people-title"
        data-module="people-confirmation"
      >
        <div className={styles.aPeopleSummary}>
          <header>
            <small>这段相处里</small>
            <h2 id="recap-people-title">你和林澄（Ta）</h2>
            <p>先核对两个人，后面的内容才不会记反。</p>
          </header>
          <div className={styles.aPeopleActions}>
            <details>
              <summary>需要核对？</summary>
              <div className={styles.aPeoplePair}>
                <p><small>录音里的原话 A · 我</small>“我回去把唱片店的地址发给你。”</p>
                <p><small>录音里的原话 B · 林澄</small>“第一次一个人摆摊，还是有点紧张。”</p>
                <span>称呼调整只展示在这里；本页不会真的辨认或改写人物。</span>
              </div>
            </details>
            <button
              type="button"
              aria-pressed={peopleConfirmed}
              onClick={() => {
                setPeopleConfirmed(true);
                setFinalConfirmed(false);
              }}
            >
              {peopleConfirmed ? "人物已核对" : "确认是我和林澄"}
            </button>
          </div>
        </div>
        <small className={styles.aDemoBoundary} role="status">
          {peopleConfirmed
            ? "人物核对只在本页演示中生效，没有保存。"
            : "这里只演示核对入口，不会真的辨认或保存人物。"}
        </small>
      </section>

      <div className={styles.aPromptCards} data-uniform-card-group="recap">
        {items.map((item) => {
          const isExcluded = excludedIds.includes(item.id);
          const isEditing = editingId === item.id;
          const sourceOpen = sourceId === item.id;

          return (
            <article
              id={`recap-card-${item.id}`}
              key={item.id}
              data-recap-item={item.id}
              data-review-state={isExcluded ? "excluded" : "kept"}
            >
              <small>{item.number}</small>
              <div className={styles.aPromptCardBody}>
                <h2>{item.title}</h2>
                {isExcluded ? (
                  <div className={styles.aRecapExcluded}>
                    <b>这条暂时不留下</b>
                    <span>仍保留在界面里，方便你反悔。</span>
                  </div>
                ) : isEditing ? (
                  <div className={styles.aRecapEditor}>
                    <label htmlFor={`recap-edit-${item.id}`}>修改整理后的文字</label>
                    <textarea
                      id={`recap-edit-${item.id}`}
                      aria-label={`修改这条：${item.title}`}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                    />
                    <span>
                      <button type="button" onClick={() => setEditingId(null)}>取消</button>
                      <button type="button" onClick={() => applyEdit(item.id)}>应用到界面样例</button>
                    </span>
                  </div>
                ) : (
                  <p>{item.text}</p>
                )}

                {!isEditing ? <footer className={styles.aRecapCardActions}>
                  {!isExcluded ? (
                    <button
                      type="button"
                      aria-label={`修改这条：${item.title}`}
                      onClick={() => beginEdit(item)}
                    >
                      修改
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`${isExcluded ? "恢复这条" : "这条不留下"}：${item.title}`}
                    onClick={() => toggleExcluded(item.id)}
                  >
                    {isExcluded ? "恢复这条" : "这条不留下"}
                  </button>
                  <button
                    type="button"
                    aria-controls="recap-original-fragment"
                    aria-expanded={sourceOpen}
                    aria-label={`回到原话：${item.title}`}
                    onClick={() => toggleSource(item.id)}
                  >
                    回到原话
                  </button>
                </footer> : null}
              </div>
            </article>
          );
        })}
      </div>

      {feedback ? <p className={styles.aRecapFeedback} role="status">{feedback}</p> : null}

      {selectedSource ? (
        <aside
          id="recap-original-fragment"
          className={styles.aOriginalTray}
          aria-label={`原话：${selectedSource.title}`}
          data-original-fragment={selectedSource.id}
        >
          <header>
            <span><small>周日晚餐 · 河边散步</small><b>{selectedSource.title}</b></span>
            <button type="button" aria-label="收起原话" onClick={() => setSourceId(null)}>×</button>
          </header>
          <blockquote>
            <time dateTime={selectedSource.source.dateTime}>{selectedSource.source.time}</time>
            <b>{selectedSource.source.speaker}：</b>
            “{selectedSource.source.quote}”
          </blockquote>
          <div className={styles.aOriginalTrayFoot}>
            <small>这段文字只是虚构的 UI Demo 依据，不会播放或读取录音。</small>
            <button
              type="button"
              onClick={() => {
                setTranscriptTargetId(selectedSource.source.transcriptLineId);
                setTranscriptTargetVersion((current) => current + 1);
                setTranscriptOpen(true);
              }}
            >
              在完整文字稿中查看
            </button>
          </div>
        </aside>
      ) : null}

      <StaticTranscriptReview
        open={transcriptOpen}
        targetLineId={transcriptTargetId}
        targetVersion={transcriptTargetVersion}
        onOpenChange={setTranscriptOpen}
      />

      <section className={styles.aRecapConfirm} data-module="recap-confirmation">
        <button
          type="button"
          disabled={!peopleConfirmed || keptCount === 0}
          onClick={() => setFinalConfirmed(true)}
        >
          <span>
            <b>确认留下 {keptCount} 条内容</b>
            <small>
              {!peopleConfirmed
                ? "先核对你和林澄"
                : keptCount === 0
                  ? "至少恢复一条内容"
                  : "只展示确认后的界面，不会真的保存"}
            </small>
          </span>
          <em aria-hidden="true">→</em>
        </button>
        {finalConfirmed ? (
          <p role="status"><b>这次整理在界面中已确认。</b><small>刷新后恢复，未保存任何内容。</small></p>
        ) : null}
      </section>
    </>
  );
}
