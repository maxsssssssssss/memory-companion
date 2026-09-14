"use client";

import { useEffect, useState } from "react";

import {
  WorkReviewApiError,
  type WorkMeetingFinding,
  type WorkReviewApi,
  type WorkTodo,
  type WorkTodoKind,
  type WorkTodoProjection
} from "@/lib/client/work-review-api";

import { WorkTodoDialog, type WorkTodoDialogSubmission } from "./work-todo-dialog";
import workStyles from "./work-review.module.css";
import styles from "./work-todo.module.css";
import { workReviewLocalDay } from "./work-todo-utils";

export function WorkFindingTodoActions({
  api,
  defaultProjectIds = [],
  finding,
  linkedTodo,
  meetingId,
  onCreated,
  onOpenTodo,
  projectionEnabled,
  projectsEnabled = false
}: Readonly<{
  api: WorkReviewApi;
  defaultProjectIds?: readonly string[];
  finding: WorkMeetingFinding;
  linkedTodo: WorkTodoProjection | null;
  meetingId: string;
  onCreated: (todo: WorkTodo) => void;
  onOpenTodo: (todoId: string) => void;
  projectionEnabled: boolean;
  projectsEnabled?: boolean;
}>) {
  const [kind, setKind] = useState<WorkTodoKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createdTodo, setCreatedTodo] = useState<WorkTodo | null>(null);
  const [reused, setReused] = useState(false);
  useEffect(() => {
    if (linkedTodo) setCreatedTodo(null);
  }, [linkedTodo]);
  const visibleTodo = linkedTodo ?? createdTodo;
  if (visibleTodo) {
    return (
      <div className={styles.linkedTodoState}>
        <span>{visibleTodo.status === "completed" ? "关联待办已完成" : "已加入待办"}</span>
        <span>{visibleTodo.title}</span>
        {reused ? <p className={styles.integrityNote} role="status">已找到原待办，没有重复创建。本次表单不会覆盖已有内容；如需修改，请查看待办后编辑。</p> : null}
        <button className={workStyles.secondaryButton} onClick={() => onOpenTodo(visibleTodo.id)} type="button">查看待办</button>
      </div>
    );
  }
  if (!projectionEnabled) return null;

  return (
    <div className={styles.findingTodoActions}>
      <p>会议结果与待办相互独立；创建后可以单独编辑和完成。</p>
      <div>
        <button className={workStyles.primaryButton} onClick={() => { setError(null); setKind("self"); }} type="button">加入我的待办</button>
        <button className={workStyles.secondaryButton} onClick={() => { setError(null); setKind("waiting_for_other"); }} type="button">设为等待他人</button>
      </div>
      <WorkTodoDialog
        api={api}
        defaultProjectIds={defaultProjectIds}
        error={error}
        finding={finding}
        initialKind={kind ?? "self"}
        mode="projection"
        onClose={() => setKind(null)}
        onSubmit={async (input: WorkTodoDialogSubmission) => {
          setError(null);
          try {
            const result = await api.createTodoFromFinding(meetingId, finding.id, input);
            setCreatedTodo(result.todo);
            setReused(result.reused);
            setKind(null);
            onCreated(result.todo);
          } catch (createError) {
            setError(createError instanceof WorkReviewApiError ? createError.message : "暂时无法从这条会议结果创建待办。");
            throw createError;
          }
        }}
        open={kind !== null}
        projectsEnabled={projectsEnabled}
        today={workReviewLocalDay()}
      />
    </div>
  );
}
