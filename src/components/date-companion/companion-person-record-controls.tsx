"use client";

import { useState } from "react";

import { ProductDialog } from "@/components/product-system/product-primitives";
import type { DateCompanionMutationState, InteractionVM } from "@/lib/domain/date-companion";

import styles from "./date-companion.module.css";

const PERSON_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  day: "numeric",
  month: "numeric",
  timeZone: "Asia/Shanghai",
  year: "numeric"
});

function formatDate(value: string) {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  const date = new Date(dateOnly ? `${value}T12:00:00+08:00` : value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const parts = Object.fromEntries(PERSON_DATE_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year} 年 ${parts.month} 月 ${parts.day} 日`;
}

export function PersonRecordControls({ confirmedInteractions, mutationState, onDeleteInteraction, open = false,
  titleFor = interaction => interaction.title || interaction.fileName }: {
  confirmedInteractions: InteractionVM[];
  mutationState: DateCompanionMutationState;
  onDeleteInteraction?: (interaction: InteractionVM) => Promise<void> | void;
  open?: boolean;
  titleFor?: (interaction: InteractionVM) => string;
}) {
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const selectedDeleteInteraction = confirmedInteractions.find((interaction) => interaction.id === deleteCandidateId) ?? null;
  const relationshipMutationError = mutationState.status === "error"
    && (mutationState.operation === "promise" || mutationState.operation === "delete")
    ? mutationState.message
    : null;

  return (
    <>
        {confirmedInteractions.length > 0 && onDeleteInteraction ? (
          <details className={styles.personRecordControls} open={open || undefined}>
            <summary>{open ? <><span className={styles.recordListClosed}>展开记录列表</span><span className={styles.recordListOpen}>收起记录列表</span></> : "管理相关记录"}</summary>
            <ul>
              {confirmedInteractions.map((interaction) => (
                <li key={interaction.id}>
                  <span><b>{titleFor(interaction)}</b><small>{formatDate(interaction.recordingDate)}</small></span>
                  <button disabled={deletingId !== null} onClick={() => { setDeleteError(null); setDeleteCandidateId(interaction.id); }} type="button">移除这次记录</button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {deleteError || relationshipMutationError ? <p className={styles.inlineError} role="alert">{deleteError || relationshipMutationError}</p> : null}
      <ProductDialog
        footer={(
          <>
            <button disabled={deletingId !== null} onClick={() => setDeleteCandidateId(null)} type="button">取消</button>
            <button
              className={styles.dangerButton}
              disabled={deletingId !== null}
              onClick={async () => {
                if (!selectedDeleteInteraction || !onDeleteInteraction) return;
                setDeletingId(selectedDeleteInteraction.id);
                setDeleteError(null);
                try {
                  await onDeleteInteraction(selectedDeleteInteraction);
                  setDeleteCandidateId(null);
                } catch (error) {
                  setDeleteError(error instanceof Error && error.message.trim() ? error.message : "这次记录暂时没有移除成功。");
                } finally {
                  setDeletingId(null);
                }
              }}
              type="button"
            >{deletingId ? "正在移除…" : "确认移除记录"}</button>
          </>
        )}
        onClose={() => deletingId === null && setDeleteCandidateId(null)}
        open={Boolean(selectedDeleteInteraction)}
        title="移除这次相处记录？"
      >
        <p>将移除“{selectedDeleteInteraction ? titleFor(selectedDeleteInteraction) : "这次相处"}”（{selectedDeleteInteraction ? formatDate(selectedDeleteInteraction.recordingDate) : "日期未知"}）。这会删除整次相处记录，并让由它产生的片段和约定重新整理；人物本身不会因此被删除。</p>
        {deleteError && <p role="alert">{deleteError}</p>}
      </ProductDialog>
    </>
  );
}
