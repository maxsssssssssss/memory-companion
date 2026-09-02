"use client";

import Link from "next/link";
import { useContext, useEffect, useMemo, useState } from "react";

import { ProductState } from "@/components/product-system/product-primitives";
import { WorkReviewApiError, type WorkReviewApi, type WorkTodo } from "@/lib/client/work-review-api";

import { WorkReviewContext } from "./work-review-shell";
import { WorkTodoDetail } from "./work-todo-detail";
import { WorkTodoDialog, type WorkTodoDialogSubmission } from "./work-todo-dialog";
import { WorkTodoRows, type WorkTodoRowAction } from "./work-todo-list";
import workStyles from "./work-review.module.css";
import styles from "./work-todo.module.css";
import { formatWorkTodoDate, useWorkTodoOperationKeys, workReviewLocalDay } from "./work-todo-utils";

function todayError(error: unknown) {
  return error instanceof WorkReviewApiError ? error.message : "暂时无法读取今天的待办，请稍后重试。";
}

function fullDayLabel(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "full" }).format(new Date(year, month - 1, day));
}

function DueSuggestionList({
  busyTodoId,
  onAdd,
  todos
}: Readonly<{
  busyTodoId: string | null;
  onAdd: (todo: WorkTodo) => Promise<void>;
  todos: readonly WorkTodo[];
}>) {
  return (
    <ul className={styles.suggestionList}>
      {todos.map((todo) => (
        <li key={todo.id}>
          <div><b>{todo.title}</b><span>{todo.kind === "self" ? "我的待办" : `等待：${todo.ownerLabel ?? "负责人尚未确认"}`}</span></div>
          <time dateTime={todo.currentDueDate ?? undefined}>{todo.currentDueDate ? formatWorkTodoDate(todo.currentDueDate) : ""}</time>
          <button className={workStyles.secondaryButton} disabled={busyTodoId === todo.id} onClick={() => void onAdd(todo)} type="button">加入今天</button>
        </li>
      ))}
    </ul>
  );
}

export function WorkReviewToday({ api: apiOverride }: Readonly<{ api?: WorkReviewApi }> = {}) {
  const context = useContext(WorkReviewContext);
  const api = apiOverride ?? context?.api;
  if (!api) throw new Error("WorkReviewToday requires an API");
  const today = useMemo(() => workReviewLocalDay(), []);
  const [records, setRecords] = useState<{ today: WorkTodo[]; dueToday: WorkTodo[]; overdue: WorkTodo[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busyTodoId, setBusyTodoId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "edit"; todo: WorkTodo } | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const operationKeys = useWorkTodoOperationKeys();

  useEffect(() => {
    const controller = new AbortController();
    setRecords(null);
    setLoadError(null);
    void Promise.all([
      api.listTodos("today", today, controller.signal),
      api.listTodos("planned", today, controller.signal)
    ]).then(([todayTodos, planned]) => {
      if (controller.signal.aborted) return;
      const notToday = planned.filter((todo) => todo.status === "open" && todo.myDayDate !== today);
      setRecords({
        today: todayTodos,
        dueToday: notToday.filter((todo) => todo.currentDueDate === today),
        overdue: notToday.filter((todo) => Boolean(todo.currentDueDate && todo.currentDueDate < today))
      });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
      setLoadError(todayError(error));
    });
    return () => controller.abort();
  }, [api, loadAttempt, today]);

  const refresh = () => setLoadAttempt((value) => value + 1);
  const mutate = async (todo: WorkTodo, action: WorkTodoRowAction) => {
    if (busyTodoId) return;
    setBusyTodoId(todo.id);
    setStatusNotice(null);
    const logicalKey = `${action}:${todo.id}:${todo.version}`;
    try {
      const operationKey = operationKeys.keyFor(logicalKey, `today-${action}`);
      if (action === "complete") await api.completeTodo(todo.id, { expectedVersion: todo.version, operationKey });
      else if (action === "reopen") await api.reopenTodo(todo.id, { expectedVersion: todo.version, operationKey });
      else if (action === "my-day") await api.setTodoMyDay(todo.id, { day: today, expectedVersion: todo.version, operationKey });
      else if (action === "remove-my-day") await api.removeTodoMyDay(todo.id, { expectedVersion: todo.version, operationKey });
      else await api.updateTodo(todo.id, { expectedVersion: todo.version, operationKey, isImportant: !todo.isImportant });
      operationKeys.settle(logicalKey);
      if (action === "complete" && todo.sourceFindingKind === "commitment") {
        setStatusNotice("已更新你的待办状态；会议记录中的原始承诺没有改变。");
      }
      refresh();
    } catch (error) {
      operationKeys.settle(logicalKey, error);
      setLoadError(todayError(error));
    } finally {
      setBusyTodoId(null);
    }
  };

  const primary = loadError ? (
    <ProductState action={<button className={workStyles.secondaryButton} onClick={refresh} type="button">重新加载</button>} description={loadError} title="暂时无法读取今天安排" tone="error" />
  ) : records === null ? (
    <ProductState title="正在读取今天安排…" tone="loading" />
  ) : records.today.length ? (
    <WorkTodoRows busyTodoId={busyTodoId} onAction={mutate} onOpen={setSelectedTodoId} today={today} todos={records.today} />
  ) : (
    <ProductState
      action={(
        <div className={styles.emptyActions}>
          <Link className={workStyles.secondaryButton} href="/work-review/todos">查看全部待办</Link>
        </div>
      )}
      description="可以新建一项，或者从全部待办中选择今天要处理的内容。"
      title="今天还没有安排待办"
      tone="empty"
    />
  );

  return (
    <main className={workStyles.page}>
      <header className={styles.todayHeader}>
        <div><h1>今天</h1><time dateTime={today}>{fullDayLabel(today)}</time></div>
        <div className={styles.pageActions}>
          <button className={workStyles.primaryButton} onClick={() => { setDialogError(null); setDialog({ mode: "create" }); }} type="button">新建待办</button>
          <Link className={workStyles.secondaryButton} href="/work-review/meetings">上传会议录音</Link>
        </div>
      </header>
      {statusNotice ? <p aria-live="polite" className={styles.statusNotice}>{statusNotice}</p> : null}
      <section aria-labelledby="today-list-title" className={styles.todaySection}>
        <h2 id="today-list-title">今天安排</h2>
        {primary}
      </section>
      {records?.dueToday.length ? (
        <section aria-labelledby="due-today-title" className={styles.secondaryTodoSection}>
          <div><h2 id="due-today-title">今天到期，但尚未加入今天</h2><p>由你决定是否把它放进今天。</p></div>
          <DueSuggestionList busyTodoId={busyTodoId} onAdd={(todo) => mutate(todo, "my-day")} todos={records.dueToday} />
        </section>
      ) : null}
      {records?.overdue.length ? (
        <section aria-labelledby="overdue-title" className={styles.secondaryTodoSection}>
          <div><h2 id="overdue-title">已经逾期</h2><p>逾期不会自动进入今天。</p></div>
          <DueSuggestionList busyTodoId={busyTodoId} onAdd={(todo) => mutate(todo, "my-day")} todos={records.overdue} />
        </section>
      ) : null}
      <WorkTodoDialog
        addToTodayDefault
        error={dialogError}
        mode={dialog?.mode ?? "create"}
        onClose={() => setDialog(null)}
        onSubmit={async (input: WorkTodoDialogSubmission) => {
          setDialogError(null);
          try {
            if (dialog?.mode === "edit") {
              await api.updateTodo(dialog.todo.id, {
                title: input.title,
                kind: input.kind,
                ownerLabel: input.ownerLabel,
                currentDueDate: input.currentDueDate,
                notes: input.notes,
                isImportant: input.isImportant,
                myDayDate: input.myDayDate,
                expectedVersion: dialog.todo.version,
                operationKey: input.operationKey
              });
            } else {
              await api.createTodo({
                title: input.title,
                kind: input.kind,
                ownerLabel: input.ownerLabel,
                currentDueDate: input.currentDueDate,
                notes: input.notes,
                isImportant: input.isImportant,
                myDayDate: input.myDayDate,
                operationKey: input.operationKey
              });
            }
            setDialog(null);
            refresh();
          } catch (error) {
            setDialogError(todayError(error));
            throw error;
          }
        }}
        open={Boolean(dialog)}
        today={today}
        todo={dialog?.mode === "edit" ? dialog.todo : null}
      />
      <WorkTodoDetail
        api={api}
        onChanged={refresh}
        onClose={() => setSelectedTodoId(null)}
        onEdit={(todo) => { setSelectedTodoId(null); setDialogError(null); setDialog({ mode: "edit", todo }); }}
        open={Boolean(selectedTodoId)}
        todoId={selectedTodoId}
      />
    </main>
  );
}
