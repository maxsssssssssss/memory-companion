import type { ToySyncSelection } from "@/components/daily-reflection/daily-reflection-toy-sync";

// One in-memory return point for a home → source → home visit. This contains
// presentation state only; saved records, evidence and upload receipts stay in
// the formal session. Keeping File by reference also avoids copying audio.
export type BookHomeForm = {
  uploadStateKey: string;
  attemptedFile: File | null;
  file: File | null;
  recordingDate: string;
  fileError: string | null;
  toySelection: ToySyncSelection | null;
  open: boolean;
};

export type BookHomeReadingPoint = {
  scopeKey: string;
  uploadId: string;
  segmentId: string;
  openSources: string[];
  focusKey: string;
  scrollX: number;
  scrollY: number;
  form: BookHomeForm;
};

let readingPoint: BookHomeReadingPoint | null = null;
// Latest unfinished form and one-shot reading position have separate lifetimes.
// Neither is persisted; File is retained by reference for local page visits only.
let currentForm: { scopeKey: string; form: BookHomeForm } | null = null;

export function rememberBookHomeForm(scopeKey: string | undefined, form: BookHomeForm) {
  if (scopeKey) currentForm = { scopeKey, form };
}

export function bookHomeForm(scopeKey: string | undefined) {
  return scopeKey && currentForm?.scopeKey === scopeKey ? currentForm.form : null;
}

export function rememberBookHomeReading(point: BookHomeReadingPoint) {
  readingPoint = point;
  rememberBookHomeForm(point.scopeKey, point.form);
}

export function bookHomeReading(scopeKey: string | undefined) {
  return scopeKey && readingPoint?.scopeKey === scopeKey ? readingPoint : null;
}

export function clearBookHomeReading(scopeKey?: string) {
  if (!scopeKey || readingPoint?.scopeKey === scopeKey) readingPoint = null;
  if (!scopeKey) currentForm = null;
}

export function keepBookHomeReadingFor(scopeKey: string | undefined) {
  if (!scopeKey || readingPoint?.scopeKey !== scopeKey) readingPoint = null;
  if (!scopeKey || currentForm?.scopeKey !== scopeKey) currentForm = null;
}
