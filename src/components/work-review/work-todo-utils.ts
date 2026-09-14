"use client";

import { useEffect, useRef } from "react";

import { isDefinitiveWorkReviewApiError, WorkReviewApiError, type WorkReviewApi, type WorkTodo, type WorkTodoDraft, type UpdateWorkTodoInput } from "@/lib/client/work-review-api";
import type { SetWorkResourceProjectsRequest } from "@/lib/domain/work-project";

export class WorkTodoEditError extends Error {}

const editableTodoFields = ["title", "kind", "ownerLabel", "currentDueDate", "notes", "isImportant", "myDayDate"] as const;
type PendingTodoEdit = { kind: "fields"; body: UpdateWorkTodoInput } | { kind: "projects"; body: SetWorkResourceProjectsRequest };
type TodoEditSession = {
  current: WorkTodo;
  fingerprint: string | null;
  pending: PendingTodoEdit | null;
  refreshRequired: boolean;
  fieldsSaved: boolean;
};

// Both Today and the Todo list use the same two-transaction edit contract.
// Keep the exact in-flight body separately from the refreshed display version.
export function useWorkTodoEdit(api: WorkReviewApi, todo: WorkTodo | null) {
  const sessionRef = useRef<TodoEditSession | null>(null);
  useEffect(() => { sessionRef.current = null; }, [api, todo]);
  return async (draft: WorkTodoDraft) => {
    if (!todo) return;
    const session = sessionRef.current ??= { current: todo, fingerprint: null, pending: null, refreshRequired: false, fieldsSaved: false };
    const fingerprint = JSON.stringify(draft);
    if (session.fingerprint !== fingerprint) {
      if (session.pending) session.refreshRequired = true;
      session.pending = null;
      session.fingerprint = fingerprint;
    }
    const refresh = async () => {
      session.current = (await api.getTodo(todo.id)).todo;
      session.refreshRequired = false;
    };
    try {
      if (session.refreshRequired) await refresh();
      // An uncertain project request must be replayed before considering fields again.
      if (session.pending?.kind !== "projects") {
        const changed = editableTodoFields.some((field) => draft[field] !== session.current[field]);
        if (session.pending?.kind === "fields" || changed) {
          const pending = session.pending?.kind === "fields" ? session.pending : {
            kind: "fields" as const,
            body: { ...Object.fromEntries(editableTodoFields.map((field) => [field, draft[field]])), expectedVersion: session.current.version, operationKey: workTodoOperationKey("edit-todo") }
          };
          session.pending = pending;
          const updated = await api.updateTodo(todo.id, pending.body);
          // Ordinary Todo PATCH does not always include relation enrichment.
          // Missing projects is not an authoritative empty relation set.
          session.current = { ...updated, projects: updated.projects ?? session.current.projects };
          session.pending = null;
          session.fieldsSaved = true;
        }
      }
      const currentIds = session.current.projects?.map((project) => project.id) ?? [];
      const projectsChanged = draft.projectIds !== undefined && (currentIds.length !== draft.projectIds.length || draft.projectIds.some((id) => !currentIds.includes(id)));
      if (session.pending?.kind === "projects" || projectsChanged) {
        if (!api.setTodoProjects) throw new WorkReviewApiError(503, "work_review_unavailable");
        const pending = session.pending?.kind === "projects" ? session.pending : {
          kind: "projects" as const,
          body: { expectedVersion: session.current.version, operationKey: workTodoOperationKey("edit-todo-projects"), projectIds: draft.projectIds! }
        };
        session.pending = pending;
        const linked = await api.setTodoProjects(todo.id, pending.body);
        session.current = { ...session.current, version: linked.resourceVersion, projects: linked.projects };
        session.pending = null;
      }
    } catch (error) {
      const projectFailure = session.pending?.kind === "projects";
      if (isDefinitiveWorkReviewApiError(error)) session.pending = null;
      session.refreshRequired = true;
      try { await refresh(); } catch { /* Retain refreshRequired; no write until a later successful read. */ }
      const reason = error instanceof WorkReviewApiError ? error.message : "请求结果暂时无法确认，请重试。";
      const prefix = projectFailure && session.fieldsSaved ? "待办内容已保存，项目关联尚未确认保存。" : projectFailure ? "项目关联尚未确认保存。" : "";
      const recovery = session.refreshRequired ? "未能读取最新状态，请重试。" : "已读取最新状态，请确认表单内容后再保存。";
      throw new WorkTodoEditError(`${prefix}${reason}${recovery}`, { cause: error });
    }
  };
}

export function workReviewLocalDay(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function workTodoOperationKey(prefix: string) {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${id}`;
}

export function formatWorkTodoDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" })
    .format(new Date(year, month - 1, day));
}

export function formatWorkTodoSourceDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Shanghai",
    year: "numeric"
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  return year && month && day ? `${year}-${month}-${day}` : value;
}

export function useWorkTodoOperationKeys() {
  const keys = useRef(new Map<string, string>());
  const keyFor = (logicalKey: string, prefix: string) => {
    const existing = keys.current.get(logicalKey);
    if (existing) return existing;
    const created = workTodoOperationKey(prefix);
    keys.current.set(logicalKey, created);
    return created;
  };
  const settle = (logicalKey: string, error?: unknown) => {
    if (error === undefined || isDefinitiveWorkReviewApiError(error)) keys.current.delete(logicalKey);
  };
  return { keyFor, settle } as const;
}
