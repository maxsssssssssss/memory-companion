"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { TranscriptLineVM } from "@/lib/domain/date-companion";

import styles from "./date-companion.module.css";

export type TranscriptChapterPresentation = {
  id: string;
  title: string;
  startSeconds: number;
  endSeconds: number;
  segmentIds: string[];
};

type CompanionTranscriptProps = {
  chapters?: TranscriptChapterPresentation[];
  highlightedSegmentId?: string | null;
  lines: TranscriptLineVM[];
};

function formatTimestamp(seconds: number) {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainder = wholeSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function normalizedSpeakerLabel(line: TranscriptLineVM, speakerOrder: Map<string, number>) {
  if (line.speakerLabel?.trim()) return line.speakerLabel.trim();
  if (!line.speakerId) return "说话人";
  return `说话人 ${speakerOrder.get(line.speakerId) ?? 1}`;
}

export function CompanionTranscript({ chapters = [], highlightedSegmentId, lines }: CompanionTranscriptProps) {
  const [expanded, setExpanded] = useState(() => Boolean(highlightedSegmentId));
  const [query, setQuery] = useState("");
  const lineElements = useRef(new Map<string, HTMLLIElement>());
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");

  const sortedLines = useMemo(
    () => [...lines].sort((left, right) => left.startSeconds - right.startSeconds || left.id.localeCompare(right.id)),
    [lines]
  );
  const speakerOrder = useMemo(() => {
    const result = new Map<string, number>();
    for (const line of sortedLines) {
      if (line.speakerId && !result.has(line.speakerId)) result.set(line.speakerId, result.size + 1);
    }
    return result;
  }, [sortedLines]);
  const visibleLines = useMemo(
    () => normalizedQuery
      ? sortedLines.filter((line) => `${normalizedSpeakerLabel(line, speakerOrder)} ${line.text}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
      : sortedLines,
    [normalizedQuery, sortedLines, speakerOrder]
  );

  const visibleChapters = useMemo(() => {
    if (chapters.length === 0) {
      return [{
        id: "full-transcript",
        title: "完整记录",
        startSeconds: sortedLines[0]?.startSeconds ?? 0,
        endSeconds: sortedLines.at(-1)?.endSeconds ?? 0,
        lines: visibleLines
      }];
    }

    const chapterByLineId = new Map<string, string>();
    for (const chapter of chapters) {
      for (const segmentId of chapter.segmentIds) chapterByLineId.set(segmentId, chapter.id);
    }
    const fallbackLines: TranscriptLineVM[] = [];
    const result = chapters.map((chapter) => ({
      ...chapter,
      lines: visibleLines.filter((line) => chapterByLineId.get(line.id) === chapter.id)
    }));
    for (const line of visibleLines) {
      if (!chapterByLineId.has(line.id)) fallbackLines.push(line);
    }
    if (fallbackLines.length > 0) {
      result.push({
        id: "other-transcript",
        title: "其他片段",
        startSeconds: fallbackLines[0]?.startSeconds ?? 0,
        endSeconds: fallbackLines.at(-1)?.endSeconds ?? 0,
        segmentIds: fallbackLines.map((line) => line.id),
        lines: fallbackLines
      });
    }
    return result;
  }, [chapters, sortedLines, visibleLines]);

  useEffect(() => {
    if (!highlightedSegmentId) return;
    setExpanded(true);
    setQuery("");
  }, [highlightedSegmentId]);

  useEffect(() => {
    if (!expanded || !highlightedSegmentId) return;
    const element = lineElements.current.get(highlightedSegmentId);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.focus({ preventScroll: true });
  }, [expanded, highlightedSegmentId, visibleLines]);

  return (
    <section className={`${styles.contentPanel} ${styles.transcriptPanel}`} id="full-transcript" aria-labelledby="transcript-title">
      <h2 id="transcript-title">完整文字稿</h2>
      <p className={styles.contentIntro}>
        {expanded
          ? "来源会定位到真实文字片段。当前原始音频不会在这里播放。"
          : `默认收起 · 共 ${sortedLines.length} 条文字片段`}
      </p>
      <button
        aria-controls="full-transcript-content"
        aria-expanded={expanded}
        className={styles.secondaryButton}
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >{expanded ? "收起完整文字稿" : "展开完整文字稿"}</button>

      {expanded ? (
        <div id="full-transcript-content">
          {sortedLines.length === 0 ? (
            <div className={styles.emptyState}>
              <div><b>没有识别到可用文字</b><span>处理未完成时，空数组不代表最终没有内容。</span></div>
            </div>
          ) : (
            <>
              <div className={styles.transcriptToolbar}>
                <input
                  aria-label="搜索完整文字稿"
                  className={styles.transcriptSearch}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="在这次相处的文字稿里搜索"
                  type="search"
                  value={query}
                />
                <span className={styles.transcriptCount}>{visibleLines.length} / {sortedLines.length} 条</span>
              </div>
              <div className={styles.transcriptScroll} tabIndex={0} aria-label="完整文字稿内容">
                {visibleLines.length === 0 ? <p className={styles.transcriptNoResult}>没有找到匹配的片段</p> : null}
                {visibleChapters.map((chapter) => chapter.lines.length > 0 ? (
                  <section className={styles.chapter} key={chapter.id}>
                    <header className={styles.chapterHeader}>
                      <h3>{chapter.title}</h3>
                      <span>{formatTimestamp(chapter.startSeconds)} – {formatTimestamp(chapter.endSeconds)}</span>
                    </header>
                    <ol className={styles.transcriptList}>
                      {chapter.lines.map((line) => {
                        const highlighted = line.id === highlightedSegmentId;
                        return (
                          <li
                            aria-current={highlighted ? "true" : undefined}
                            className={`${styles.transcriptLine} ${highlighted ? styles.transcriptHighlighted : ""}`}
                            data-segment-id={line.id}
                            id={`transcript-${line.id}`}
                            key={`${line.uploadId}:${line.id}`}
                            ref={(element) => {
                              if (element) lineElements.current.set(line.id, element);
                              else lineElements.current.delete(line.id);
                            }}
                            tabIndex={highlighted ? 0 : -1}
                          >
                            <time>{formatTimestamp(line.startSeconds)}</time>
                            <b title={normalizedSpeakerLabel(line, speakerOrder)}>{normalizedSpeakerLabel(line, speakerOrder)}</b>
                            <p>{line.text}</p>
                          </li>
                        );
                      })}
                    </ol>
                  </section>
                ) : null)}
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
