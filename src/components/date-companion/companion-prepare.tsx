"use client";

import Link from "next/link";

import type { PromiseVM, RecapItemVM, SourceRefVM } from "@/lib/domain/date-companion";

import styles from "./date-companion.module.css";

type CompanionPrepareProps = {
  items: RecapItemVM[];
  openPromises?: PromiseVM[];
  relationshipName?: string;
  onOpenSource?: (source: SourceRefVM, segmentId: string) => Promise<void> | void;
};

const PREPARE_GROUPS: Array<{ kind: RecapItemVM["kind"]; title: string; empty: string }> = [
  { kind: "mentioned", title: "Ta 最近最在意的", empty: "还没有经你确认、能确定归给 Ta 的内容" },
  { kind: "moment", title: "上次聊到", empty: "还没有带真实来源、适合回看的片段" },
  { kind: "promise", title: "你答应过", empty: "目前没有待完成的约定" },
  { kind: "continue", title: "可以自然继续", empty: "还没有根据已确认原话整理出的开放问题" }
];

function formatTimestamp(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function PrepareSources({
  onOpenSource,
  sources
}: {
  onOpenSource?: (source: SourceRefVM, segmentId: string) => Promise<void> | void;
  sources: SourceRefVM[];
}) {
  return (
    <details className={styles.sourceDetails}>
      <summary><span>可以核对的原话</span><span>展开</span></summary>
      <ul className={styles.sourceList}>
        {sources.map((source) => {
          const segmentId = source.segmentIds[0];
          const canOpen = Boolean(source.canOpenTranscript && segmentId);
          const href = segmentId ? `/date-companion/a/recap?segment=${encodeURIComponent(segmentId)}#full-transcript` : null;
          return (
            <li className={styles.sourceItem} key={source.id}>
              <blockquote>{source.presentation === "direct_quote" ? `“${source.quote}”` : source.quote}</blockquote>
              <div className={styles.sourceMeta}>
                <span>{source.presentation === "direct_quote" ? "直接原话" : "根据原话整理"} · {formatTimestamp(source.startSeconds)}</span>
                {canOpen && onOpenSource ? (
                  <button className={styles.sourceJump} onClick={() => onOpenSource(source, segmentId)} type="button">在完整文字稿中查看</button>
                ) : canOpen && href ? (
                  <Link className={styles.sourceJump} href={href}>在完整文字稿中查看</Link>
                ) : <span className={styles.evidenceOnlyLabel}>已保留可核对原话</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export function CompanionPrepare({ items, onOpenSource, openPromises = [], relationshipName }: CompanionPrepareProps) {
  const validItems = items.filter((item) => item.disposition === "kept" && item.sources.length > 0);
  const validOpenPromises = openPromises.filter((promise) => promise.status === "open" && promise.sources.length > 0);
  const displayName = relationshipName?.trim() || "Ta";

  return (
    <div className={styles.twoColumnPage}>
      <header className={styles.stickyHero}>
        <span className={styles.heroMark} aria-hidden="true">想</span>
        <p>见 {displayName} 前看一眼</p>
        <h1>见 {displayName} 之前，花半分钟想一想</h1>
        <span>这里只回看你确认留下的内容和待完成约定，不猜见面时间，也不会自动创建提醒。</span>
      </header>

      <div className={styles.contentColumn}>
        <div className={styles.boundaryNote} role="note">被排除、尚未确认或说话人仍不确定的片段不会进入准备卡。已完成约定会保留原话，但不再作为待办出现。</div>
        <section className={styles.letterStack} aria-label="见面前准备卡">
          {PREPARE_GROUPS.map((group, index) => {
            const groupItems = validItems.filter((item) => item.kind === group.kind);
            return (
              <details className={styles.letterCard} key={group.kind} open={index === 0 ? true : undefined}>
                <summary>{group.title}</summary>
                <div className={styles.letterBody}>
                  {group.kind === "promise" ? (
                    validOpenPromises.length === 0 ? <p className={styles.prepareEmpty}>{group.empty}</p> : validOpenPromises.map((promise) => (
                      <div className={styles.prepareItem} key={promise.id}>
                        <p>{promise.text}</p>
                        <PrepareSources onOpenSource={onOpenSource} sources={promise.sources} />
                      </div>
                    ))
                  ) : groupItems.length === 0 ? <p className={styles.prepareEmpty}>{group.empty}</p> : groupItems.map((item) => (
                    <div className={styles.prepareItem} key={item.id}>
                      <p>{item.displayedText || item.proposedText}</p>
                      <PrepareSources onOpenSource={onOpenSource} sources={item.sources} />
                    </div>
                  ))}
                </div>
              </details>
            );
          })}
        </section>
        <div className={styles.prepareActions}>
          <Link className={styles.returnLink} href="/date-companion/a">看完了，回到此刻</Link>
        </div>
      </div>
    </div>
  );
}
