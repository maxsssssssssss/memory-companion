"use client";

import { useRef } from "react";

import { isDefinitiveWorkReviewApiError } from "@/lib/client/work-review-api";

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
