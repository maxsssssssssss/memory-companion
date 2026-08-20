"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { DailyReflectionTranscriptSegmentView } from "@/lib/domain/daily-reflection-api";

import styles from "./daily-reflection.module.css";

export type TranscriptFocusRequest = {
  segmentId: string;
  requestId: number;
};

type DailyReflectionTranscriptProps = {
  focusRequest?: TranscriptFocusRequest | null;
  segments: DailyReflectionTranscriptSegmentView[];
};

function formatTimestamp(seconds: number) {
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3_600);
  const minutes = Math.floor((rounded % 3_600) / 60);
  const remaining = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function speakerLabel(segment: DailyReflectionTranscriptSegmentView) {
  return segment.identity?.displayName?.trim()
    || segment.speaker?.trim()
    || "说话人";
}

export function DailyReflectionTranscript({
  focusRequest = null,
  segments
}: DailyReflectionTranscriptProps) {
  const [query, setQuery] = useState("");
  const [highlightedSegmentId, setHighlightedSegmentId] = useState<string | null>(null);
  const segmentNodes = useRef(new Map<string, HTMLLIElement>());

  const sortedSegments = useMemo(
    () => [...segments].sort((left, right) => (
      left.startSeconds - right.startSeconds
      || left.endSeconds - right.endSeconds
      || left.id.localeCompare(right.id)
    )),
    [segments]
  );
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleSegments = useMemo(() => {
    if (!normalizedQuery) return sortedSegments;
    return sortedSegments.filter((segment) => (
      segment.text.toLocaleLowerCase("zh-CN").includes(normalizedQuery)
      || speakerLabel(segment).toLocaleLowerCase("zh-CN").includes(normalizedQuery)
    ));
  }, [normalizedQuery, sortedSegments]);

  useEffect(() => {
    if (!focusRequest || !sortedSegments.some((segment) => segment.id === focusRequest.segmentId)) {
      return;
    }
    setQuery("");
    setHighlightedSegmentId(focusRequest.segmentId);
    const timer = window.setTimeout(() => {
      const node = segmentNodes.current.get(focusRequest.segmentId);
      node?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      node?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusRequest?.requestId, focusRequest?.segmentId, sortedSegments]);

  return (
    <section className={styles.transcriptSection} aria-labelledby="daily-reflection-transcript-title">
      <div className={styles.sectionHeading}>
        <div>
          <p>完整记录</p>
          <h2 id="daily-reflection-transcript-title">文字稿</h2>
        </div>
        <span>{sortedSegments.length} 段</span>
      </div>

      <label className={styles.searchField}>
        <span>搜索文字稿</span>
        <input
          onChange={(event) => setQuery(event.target.value)}
          placeholder="输入一句话或说话人"
          type="search"
          value={query}
        />
      </label>

      <div className={styles.transcriptScroller} role="region" aria-label="完整文字稿" tabIndex={0}>
        {visibleSegments.length > 0 ? (
          <ol className={styles.transcriptList}>
            {visibleSegments.map((segment) => {
              const highlighted = segment.id === highlightedSegmentId;
              return (
                <li
                  aria-label={`${speakerLabel(segment)}，${formatTimestamp(segment.startSeconds)}`}
                  className={`${styles.transcriptLine} ${highlighted ? styles.transcriptLineHighlighted : ""}`}
                  data-highlighted={highlighted ? "true" : undefined}
                  data-segment-id={segment.id}
                  key={segment.id}
                  ref={(node) => {
                    if (node) segmentNodes.current.set(segment.id, node);
                    else segmentNodes.current.delete(segment.id);
                  }}
                  tabIndex={-1}
                >
                  <div className={styles.transcriptMeta}>
                    <b>{speakerLabel(segment)}</b>
                    <time>{formatTimestamp(segment.startSeconds)}</time>
                  </div>
                  <p>{segment.text}</p>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className={styles.emptySearch}>没有找到匹配的文字。</p>
        )}
      </div>
    </section>
  );
}
