"use client";

import { useEffect, useState } from "react";

import type { DateCompanionProactiveValuePresentation } from "@/lib/client/date-companion-proactive-value";
import type { SourceRefVM } from "@/lib/domain/date-companion";

import styles from "./date-companion.module.css";

type CompanionProactiveObservationProps = {
  presentation: DateCompanionProactiveValuePresentation;
  onOpenSource?: (source: SourceRefVM, segmentId: string) => Promise<void> | void;
};

function formatDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  return match ? `${Number(match[2])} 月 ${Number(match[3])} 日` : value;
}

function sourceTime(source: SourceRefVM) {
  const seconds = Math.max(0, Math.floor(source.startSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function CompanionProactiveObservation({
  presentation,
  onOpenSource
}: CompanionProactiveObservationProps) {
  const [hiddenFingerprint, setHiddenFingerprint] = useState<string | null>(null);
  const hidden = hiddenFingerprint === presentation.fingerprint;

  useEffect(() => {
    if (hiddenFingerprint && hiddenFingerprint !== presentation.fingerprint) setHiddenFingerprint(null);
  }, [hiddenFingerprint, presentation.fingerprint]);

  if (hidden) {
    return (
      <div className={styles.proactiveHidden} role="status">
        <p>这条观察已在本次浏览中收起，原话记录没有改变。</p>
        <button onClick={() => setHiddenFingerprint(null)} type="button">重新显示</button>
      </div>
    );
  }

  return (
    <div className={styles.proactiveObservation} data-proactive-status={presentation.status}>
      <p className={styles.observationCopy}>{presentation.observation}</p>
      <p className={styles.proactiveCaution}>{presentation.caution}</p>
      <details className={styles.longTermSources}>
        <summary>核对原话 · {presentation.sources.length}</summary>
        <ul>
          {presentation.sources.map((source) => {
            const segmentId = source.segmentIds[0];
            const canOpen = Boolean(source.canOpenTranscript && segmentId && onOpenSource);
            return (
              <li key={`${source.uploadId}:${segmentId ?? source.id}`}>
                <blockquote>“{source.quote}”</blockquote>
                <div>
                  <span>{formatDate(source.recordingDate)} · {sourceTime(source)}</span>
                  {canOpen ? (
                    <button onClick={() => onOpenSource?.(source, segmentId)} type="button">在完整文字稿中查看</button>
                  ) : <small>已保留可核对原话</small>}
                </div>
              </li>
            );
          })}
        </ul>
      </details>
      <button
        className={styles.proactiveHideAction}
        onClick={() => setHiddenFingerprint(presentation.fingerprint)}
        title="只在本次浏览中收起，不会改动原话或长期记录"
        type="button"
      >这条不准确</button>
    </div>
  );
}
