import type { QuizCandidateIssue } from "./quiz-candidate-diagnostics";

/** Generation-boundary aliases only, before reference/identity binding. A
 * boundary/condition exercise is an application question; this does not change
 * its review role, objective, answer or source. Persisted questions and the
 * strict domain schema are never coerced, and unknown labels remain invalid. */
export function normalizeQuizGeneratedItemKind(value: unknown, index: number, onIssue?: (issue: QuizCandidateIssue) => void): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  if (item.kind !== "boundary") return value;
  onIssue?.({ index, stage: "normalization", code: "kind_alias", originalKind: "boundary", normalizedKind: "application" });
  return { ...item, kind: "application" };
}

/** The legacy stable-reference generation path uses the same entry policy. */
export function normalizeQuizGeneratedKinds(value: unknown, onIssue?: (issue: QuizCandidateIssue) => void): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const body = value as Record<string, unknown>;
  return Array.isArray(body.items) ? { ...body, items: body.items.map((item, index) => normalizeQuizGeneratedItemKind(item, index, onIssue)) } : value;
}
