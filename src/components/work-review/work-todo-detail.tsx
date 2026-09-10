"use client";

import { useEffect, useRef, useState } from "react";

import { ProductDialog, ProductEvidence, ProductState } from "@/components/product-system/product-primitives";
import {
  WorkReviewApiError,
  type WorkReviewApi,
  type WorkTodo,
  type WorkTodoDetailResponse,
  type WorkTodoSourceResponse
} from "@/lib/client/work-review-api";

import { formatEvidenceTime } from "./work-review-shared";
import { WorkProjectBadges } from "./work-project-picker";
import workStyles from "./work-review.module.css";
import styles from "./work-todo.module.css";
import {
  formatWorkTodoDate,
  formatWorkTodoSourceDateTime,
  workTodoOperationKey
} from "./work-todo-utils";

function detailError(error: unknown) {
  return error instanceof WorkReviewApiError ? error.message : "暂时无法读取这条待办，请稍后重试。";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function WorkTodoDetail({
  api,
  onChanged,
  onClose,
  onEdit,
  open,
  todoId
}: Readonly<{
  api: WorkReviewApi;
  onChanged: () => void;
  onClose: () => void;
  onEdit?: (todo: WorkTodo) => void;
  open: boolean;
  todoId: string | null;
}>) {
  const [detail, setDetail] = useState<WorkTodoDetailResponse | null>(null);
  const [source, setSource] = useState<WorkTodoSourceResponse | null>(null);
  const [mode, setMode] = useState<"detail" | "source" | "delete">("detail");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const deleteKeyRef = useRef(workTodoOperationKey("delete-todo"));

  useEffect(() => {
    if (!open || !todoId) return;
    const controller = new AbortController();
    setDetail(null);
    setSource(null);
    setMode("detail");
    setError(null);
    deleteKeyRef.current = workTodoOperationKey("delete-todo");
    void api.getTodo(todoId, controller.signal).then((next) => {
      if (!controller.signal.aborted) setDetail(next);
    }).catch((loadError: unknown) => {
      if (controller.signal.aborted || loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(detailError(loadError));
    });
    return () => controller.abort();
  }, [api, open, todoId]);

  const showSource = async () => {
    if (!todoId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.getTodoSource(todoId);
      setSource(next);
      setMode("source");
    } catch (loadError) {
      setError(detailError(loadError));
    } finally {
      setBusy(false);
    }
  };

  const footer = mode === "delete" ? (
    <div className={styles.dialogActions}>
      <button className={workStyles.secondaryButton} disabled={busy} onClick={() => setMode("detail")} type="button">返回</button>
      <button
        className={workStyles.dangerButton}
        disabled={busy || !detail}
        onClick={() => {
          if (!detail || busy) return;
          setBusy(true);
          setError(null);
          void api.deleteTodo(detail.todo.id, {
            expectedVersion: detail.todo.version,
            operationKey: deleteKeyRef.current
          }).then(() => {
            onChanged();
            onClose();
          }).catch((deleteError: unknown) => setError(detailError(deleteError))).finally(() => setBusy(false));
        }}
        type="button"
      >{busy ? "正在删除…" : "确认删除待办"}</button>
    </div>
  ) : mode === "source" ? (
    <div className={styles.dialogActions}>
      <button className={workStyles.secondaryButton} onClick={() => setMode("detail")} type="button">返回待办详情</button>
      <button className={workStyles.primaryButton} onClick={onClose} type="button">关闭</button>
    </div>
  ) : (
    <div className={styles.dialogActions}>
      <button className={workStyles.dangerButton} disabled={!detail} onClick={() => setMode("delete")} type="button">删除</button>
      {onEdit ? <button className={workStyles.secondaryButton} disabled={!detail} onClick={() => detail && onEdit(detail.todo)} type="button">编辑</button> : null}
      <button className={workStyles.primaryButton} onClick={onClose} type="button">关闭</button>
    </div>
  );

  return (
    <ProductDialog footer={footer} onClose={onClose} open={open} title={mode === "source" ? "会议来源" : mode === "delete" ? "删除待办" : "待办详情"}>
      {error ? <p className={workStyles.formError} role="alert">{error}</p> : null}
      {mode === "delete" ? (
        <div className={styles.deleteTodoCopy}>
          <p>删除只会移除这条待办，不会删除来源会议、会议结果或会议转写。</p>
          <strong>{detail?.todo.title}</strong>
        </div>
      ) : mode === "source" ? (
        source ? (
          <div className={styles.sourceQuickView}>
            {source.sourceChanged ? <p className={styles.sourceChanged}>来源会议结果后来被修改。当前待办没有自动改变。</p> : null}
            <dl className={styles.detailGrid}>
              <div><dt>来源会议</dt><dd>{source.meeting.title}</dd></div>
              <div><dt>会议日期</dt><dd><time dateTime={source.meeting.meetingDate}>{source.meeting.meetingDate}</time></dd></div>
              <div><dt>来源类型</dt><dd>{source.finding.kind === "commitment" ? "明确承诺" : "行动事项"}</dd></div>
            </dl>
            <section className={styles.findingSource} aria-labelledby="todo-source-finding-title">
              <h3 id="todo-source-finding-title">{source.finding.title}</h3>
              <p>{source.finding.body}</p>
            </section>
            <div className={styles.sourceEvidenceList}>
              {source.evidenceContexts.map((evidence, index) => (
                <ProductEvidence key={`${evidence.publicationId}:${evidence.segmentId}`} label={`${evidence.isDirectEvidence ? "会议原文" : "前后文"} ${index + 1}/${source.evidenceContexts.length}`} meta={formatEvidenceTime(evidence.startSeconds, evidence.endSeconds)}>
                  {evidence.displaySpeakerLabel ? <span className={styles.sourceSpeaker}>{evidence.displaySpeakerLabel}</span> : null}
                  {evidence.text}
                </ProductEvidence>
              ))}
            </div>
            <p className={styles.integrityNote}>这里显示的是当前会议原文；待办中的编辑值不会冒充会议原话。</p>
          </div>
        ) : <ProductState title="正在读取会议来源…" tone="loading" />
      ) : detail ? (
        <div className={styles.todoDetail}>
          <header><h3>{detail.todo.title}</h3><span data-status={detail.todo.status}>{detail.todo.status === "completed" ? "已完成" : "进行中"}</span></header>
          <WorkProjectBadges projects={detail.todo.projects ?? []} />
          <dl className={styles.detailGrid}>
            <div><dt>类型</dt><dd>{detail.todo.kind === "self" ? "我的待办" : "等待他人"}</dd></div>
            <div><dt>负责人</dt><dd>{detail.todo.kind === "self" ? "我" : detail.todo.ownerLabel ?? "负责人尚未确认"}</dd></div>
            <div><dt>当前计划日期</dt><dd>{detail.todo.currentDueDate ? formatWorkTodoDate(detail.todo.currentDueDate) : "未设置"}</dd></div>
            <div><dt>今天</dt><dd>{detail.todo.myDayDate ? `已安排在 ${detail.todo.myDayDate}` : "未加入"}</dd></div>
            <div><dt>重要</dt><dd>{detail.todo.isImportant ? "是" : "否"}</dd></div>
            <div><dt>创建时间</dt><dd>{formatDateTime(detail.todo.createdAt)}</dd></div>
            {detail.todo.completedAt ? <div><dt>完成时间</dt><dd>{formatDateTime(detail.todo.completedAt)}</dd></div> : null}
          </dl>
          {detail.todo.notes ? <section className={styles.todoNotes}><h4>备注</h4><p>{detail.todo.notes}</p></section> : null}
          {detail.source.state === "detached" ? <p className={styles.detachedSource}>原来源会议已删除</p> : null}
          {detail.source.state === "missing" ? <p className={styles.detachedSource}>来源会议当前不可用</p> : null}
          {detail.source.meeting ? (
            <section className={styles.todoSourceSummary}>
              <h4>来源会议</h4>
              <p>{detail.source.meeting.title} · {detail.source.meeting.meetingDate}</p>
              {detail.todo.sourceOriginalDueExpression || detail.todo.sourceOriginalDueAt ? (
                <p>会议原始日期：{detail.todo.sourceOriginalDueExpression ?? (
                  detail.todo.sourceOriginalDueAt ? formatWorkTodoSourceDateTime(detail.todo.sourceOriginalDueAt) : null
                )}</p>
              ) : null}
              {detail.todo.currentDueDate ? <p>当前计划日期：{formatWorkTodoDate(detail.todo.currentDueDate)}</p> : null}
              {detail.source.sourceChanged ? <p className={styles.sourceChanged}>来源后来被修改；当前待办没有自动改变。</p> : null}
              <button className={workStyles.secondaryButton} disabled={busy} onClick={() => void showSource()} type="button">
                {detail.source.sourceChanged ? "查看最新来源" : "查看会议原文"}
              </button>
            </section>
          ) : null}
        </div>
      ) : <ProductState description={error ?? undefined} title={error ? "待办详情没有加载完成" : "正在读取待办详情…"} tone={error ? "error" : "loading"} />}
    </ProductDialog>
  );
}
