"use client";

import { useContext, useEffect, useState } from "react";

import { ProductState, ProductTabs } from "@/components/product-system/product-primitives";
import {
  WorkReviewApiError,
  type WorkReviewApi,
  type WorkTodo,
  type WorkTodoView
} from "@/lib/client/work-review-api";

import { WorkReviewContext } from "./work-review-shell";
import { WorkTodoDetail } from "./work-todo-detail";
import { WorkTodoDialog, type WorkTodoDialogSubmission } from "./work-todo-dialog";
import workStyles from "./work-review.module.css";
import styles from "./work-todo.module.css";
import {
  formatWorkTodoDate,
  useWorkTodoOperationKeys,
  workReviewLocalDay
} from "./work-todo-utils";

export type WorkTodoRowAction = "complete" | "reopen" | "important" | "my-day" | "remove-my-day";

export function WorkTodoRows({
  busyTodoId,
  onAction,
  onOpen,
  today,
  todos
}: Readonly<{
  busyTodoId: string | null;
  onAction: (todo: WorkTodo, action: WorkTodoRowAction) => Promise<void>;
  onOpen: (todoId: string) => void;
  today: string;
  todos: readonly WorkTodo[];
}>) {
  return (
    <ul className={styles.todoList}>
      {todos.map((todo) => {
        const busy = busyTodoId === todo.id;
        const completed = todo.status === "completed";
        const inToday = todo.myDayDate === today;
        const overdue = !completed && Boolean(todo.currentDueDate && todo.currentDueDate < today);
        return (
          <li aria-busy={busy} className={styles.todoRow} key={todo.id}>
            <label className={styles.completeControl}>
              <input
                aria-label={completed ? `重新打开：${todo.title}` : `完成：${todo.title}`}
                checked={completed}
                disabled={busy}
                onChange={() => void onAction(todo, completed ? "reopen" : "complete")}
                type="checkbox"
              />
            </label>
            <div className={styles.todoMain}>
              <button className={styles.todoTitle} disabled={busy} onClick={() => onOpen(todo.id)} type="button">
                {todo.title}
              </button>
              <div className={styles.todoMeta}>
                <span>{todo.kind === "self" ? "我的待办" : `等待：${todo.ownerLabel ?? "负责人尚未确认"}`}</span>
                {todo.currentDueDate ? <time data-overdue={overdue || undefined} dateTime={todo.currentDueDate}>{overdue ? "已逾期 · " : ""}{formatWorkTodoDate(todo.currentDueDate)}</time> : null}
                {todo.origin === "meeting_finding" ? <span>来源会议</span> : null}
                {todo.origin === "detached_meeting_finding" ? <span>原来源会议已删除</span> : null}
                {todo.isImportant ? <strong>重要</strong> : null}
              </div>
            </div>
            {!completed ? (
              <div aria-label={`${todo.title}的操作`} className={styles.todoRowActions}>
                <button disabled={busy} onClick={() => void onAction(todo, inToday ? "remove-my-day" : "my-day")} type="button">
                  {inToday ? "移出今天" : "加入今天"}
                </button>
                <button disabled={busy} onClick={() => void onAction(todo, "important")} type="button">
                  {todo.isImportant ? "取消重要" : "标为重要"}
                </button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

const VIEW_ITEMS: readonly Readonly<{ id: Exclude<WorkTodoView, "today">; label: string }>[]= [
  { id: "all", label: "全部" },
  { id: "planned", label: "计划中" },
  { id: "waiting", label: "等待他人" },
  { id: "completed", label: "已完成" }
];

function todoError(error: unknown) {
  return error instanceof WorkReviewApiError ? error.message : "暂时无法完成待办操作，请稍后重试。";
}

export function WorkTodoListPage({ api: apiOverride }: Readonly<{ api?: WorkReviewApi }> = {}) {
  const context = useContext(WorkReviewContext);
  const api = apiOverride ?? context?.api;
  if (!api) throw new Error("WorkTodoListPage requires an API");
  const today = workReviewLocalDay();
  const [view, setView] = useState<Exclude<WorkTodoView, "today">>("all");
  const [todos, setTodos] = useState<WorkTodo[] | null>(null);
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
    setLoadError(null);
    setTodos(null);
    void api.listTodos(view, today, controller.signal).then((records) => {
      if (!controller.signal.aborted) setTodos(records);
    }).catch((error: unknown) => {
      if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
      setLoadError(todoError(error));
    });
    return () => controller.abort();
  }, [api, loadAttempt, today, view]);

  const refresh = () => setLoadAttempt((value) => value + 1);
  const mutate = async (todo: WorkTodo, action: WorkTodoRowAction) => {
    if (busyTodoId) return;
    setBusyTodoId(todo.id);
    setStatusNotice(null);
    const logicalKey = `${action}:${todo.id}:${todo.version}`;
    try {
      const operationKey = operationKeys.keyFor(logicalKey, `todo-${action}`);
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
      setLoadError(todoError(error));
    } finally {
      setBusyTodoId(null);
    }
  };

  const panel = loadError ? (
    <ProductState action={<button className={workStyles.secondaryButton} onClick={refresh} type="button">重新加载</button>} description={loadError} title="暂时无法读取待办" tone="error" />
  ) : todos === null ? (
    <ProductState title="正在读取待办…" tone="loading" />
  ) : todos.length === 0 ? (
    <ProductState action={<button className={workStyles.secondaryButton} onClick={() => setDialog({ mode: "create" })} type="button">新建待办</button>} description="新建一项，或者从已确认的会议行动事项中加入。" title={view === "completed" ? "还没有已完成的待办" : "这个视图还没有待办"} tone="empty" />
  ) : (
    <WorkTodoRows busyTodoId={busyTodoId} onAction={mutate} onOpen={setSelectedTodoId} today={today} todos={todos} />
  );

  return (
    <main className={workStyles.page}>
      <header className={styles.todoPageHeader}>
        <div><h1>待办</h1><p>管理我的待办和需要继续跟进的人，不改变会议中的原始事实。</p></div>
        <button className={workStyles.primaryButton} onClick={() => { setDialogError(null); setDialog({ mode: "create" }); }} type="button">新建待办</button>
      </header>
      {statusNotice ? <p aria-live="polite" className={styles.statusNotice}>{statusNotice}</p> : null}
      <ProductTabs
        ariaLabel="待办视图"
        items={VIEW_ITEMS.map((item) => ({ id: item.id, label: item.label, panel }))}
        onChange={(next) => setView(next as Exclude<WorkTodoView, "today">)}
        value={view}
      />
      <WorkTodoDialog
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
            setDialogError(todoError(error));
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
