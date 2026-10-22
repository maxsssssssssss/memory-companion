import { ZodError } from "zod";
import { createHash } from "node:crypto";
import type { LearningRepository } from "./repository";

/** Private, bounded final-answer diagnostics. Never an evidence/answer authority,
 * never included in learner or model observations. No request/source body is kept. */
export type QuizCandidateIssue = {
  index: number; stage: "composition" | "compact" | "review" | "publication" | "envelope" | "normalization";
  code: string; validationIssues?: Array<{ path: string; code: string }>;
  originalKind?: "boundary"; normalizedKind?: "application";
  expectedRole?: string; actualRole?: unknown;
  expectedObjectiveIds?: string[]; actualObjectiveIds?: unknown;
};
export type QuizDiagnosticContext = { taskId: string; taskVersion: number; actionId: string };
const fields = new Set(("focus scenario stem kind stemEvidenceIds options id text reason reasonParts evidenceIds " +
  "correctOptionId explanation explanationParts explanationEvidenceIds hint reviewCheck objectiveIds role rationale").split(" "));
const pathFields = new Set([...fields, ..."referenceScope contractVersion materialPlan material contribution references title items".split(" ")]);
const issueCodes = new Set(("structure_or_evidence option_identity position_dependency answer_contradiction repeated_focus " +
  "equivalent_options answer_not_unique source_binding goal_mismatch annotation_schema annotation_role annotation_objective " +
  "annotation_missing review_source_mismatch invalid_type invalid_string too_small too_big custom missing_field " +
  "invalid_enum_value invalid_literal unrecognized_keys invalid_union not_multiple_of not_finite kind_alias").split(" "));
const stages = new Set(["composition", "compact", "review", "publication", "envelope", "normalization"]);
const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const scrub = (text: string) => text
  .replace(/(?:sk-[A-Za-z0-9_-]{10,}|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}|Bearer\s+[^\s"']+)/gi, "[redacted]")
  .replace(/(?:api[_-]?key|password|authorization|cookie|secret)\s*[:=]\s*[^\s,;，；]+/gi, "[redacted]")
  .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted]");
function pathOf(path: unknown[]) {
  return path.map(v => typeof v === "number" && v >= 0 && v < 1000 ? `[${v}]`
    : typeof v === "string" && pathFields.has(v) ? `.${v}` : ".?").join("").replace(/^\./, "").slice(0, 180) || "$";
}
export function quizCandidateValidationIssues(error: ZodError) {
  return error.issues.slice(0, 12).map(issue => ({ path: pathOf(issue.path),
    code: issue.code === "invalid_type" && issue.received === "undefined" ? "missing_field" : issue.code }));
}
export function quizCandidateDiagnostics(raw: unknown, issues: QuizCandidateIssue[], identity: {
  runId: string; partId: string; requestId: string; context?: QuizDiagnosticContext;
}) {
  const safeIssues = issues.slice(0, 100).map(issue => ({
    index: Number.isInteger(issue.index) && issue.index >= 0 && issue.index < 50 ? issue.index : -1,
    stage: stages.has(issue.stage) ? issue.stage : "envelope",
    code: issueCodes.has(issue.code) ? issue.code : "structure_or_evidence",
    ...(issue.stage === "normalization" && issue.code === "kind_alias" && issue.originalKind === "boundary" && issue.normalizedKind === "application"
      ? { originalKind: issue.originalKind, normalizedKind: issue.normalizedKind } : {}),
    ...(issue.validationIssues ? { validationIssues: issue.validationIssues.slice(0, 12).map(v => ({
      path: /^[A-Za-z.?$\[\]0-9]{1,180}$/.test(v.path) ? v.path.replace(/[A-Za-z]+/g, field => pathFields.has(field) ? field : "?") : "$",
      code: issueCodes.has(v.code) ? v.code : "custom"
    })) } : {}),
    ...(issue.expectedRole ? { expectedRole: scrub(issue.expectedRole).slice(0, 64) } : {}),
    ...(issue.actualRole !== undefined ? { actualRole: typeof issue.actualRole === "string" ? scrub(issue.actualRole).slice(0, 64) : typeof issue.actualRole } : {}),
    ...(issue.expectedObjectiveIds ? { expectedObjectiveIds: issue.expectedObjectiveIds.slice(0, 12).map(v => scrub(v).slice(0, 64)) } : {}),
    ...(issue.actualObjectiveIds !== undefined ? { actualObjectiveIds: Array.isArray(issue.actualObjectiveIds)
      ? issue.actualObjectiveIds.slice(0, 12).map(v => typeof v === "string" ? scrub(v).slice(0, 64) : typeof v) : typeof issue.actualObjectiveIds } : {})
  }));
  const items = record(raw)?.items;
  const indexes = new Set(safeIssues.map(issue => issue.index));
  let remaining = 48_000, truncated = false;
  const copy = (v: unknown, depth = 0): unknown => {
    if (remaining <= 0 || depth > 6) { truncated = true; return "[omitted]"; }
    if (typeof v === "string") {
      const cleaned = scrub(v), limit = Math.min(4000, remaining);
      if (cleaned.length > limit) truncated = true;
      const result = cleaned.slice(0, limit); remaining -= result.length; return result;
    }
    if (v === null || typeof v === "boolean" || typeof v === "number") return v;
    if (Array.isArray(v)) { if (v.length > 16) truncated = true; return v.slice(0, 16).map(x => copy(x, depth + 1)); }
    const obj = record(v);
    return obj ? Object.fromEntries(Object.entries(obj).filter(([key]) => fields.has(key)).map(([key, value]) => [key, copy(value, depth + 1)])) : "[invalid type]";
  };
  const selected = Array.isArray(items) ? items.map((value, index) => ({ value, index })).filter(({ index }) => indexes.has(index) || indexes.has(-1)) : [];
  const candidates = selected.slice(0, 12).map(({ value, index }) => ({ index, candidate: copy(value) }));
  return { version: 1, ...identity, recordedAt: Date.now(), expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    issues: safeIssues.filter(issue => issue.stage !== "normalization"),
    ...(safeIssues.some(issue => issue.stage === "normalization") ? { normalizations: safeIssues.filter(issue => issue.stage === "normalization") } : {}),
    candidates, truncated: truncated || selected.length > 12 || issues.length > 100,
    omittedCandidates: Math.max(0, selected.length - candidates.length),
    // Hash refers to the sanitized retained projection, not an assertion of raw completeness.
    projectionHash: createHash("sha256").update(JSON.stringify(candidates)).digest("hex") };
}

/** Expiry is enforced whenever this page's Quiz data is used. Adjustment clears
 * old-version candidate prose immediately; no model call or source read occurs. */
export function clearQuizCandidateDiagnostics(learning: LearningRepository, pageId: string,
  task?: { taskId: string; exceptVersion?: number; exactVersion?: number }) {
  learning.get(pageId);
  // Some pre-existing interrupted checkpoints contain malformed diagnostics.
  // Expiry must neither make those rows unreadable nor silently repair them.
  const readable = "CASE WHEN json_valid(diagnostics_json) THEN diagnostics_json ELSE '{}' END";
  if (task) learning.database.prepare(`UPDATE learning_generation_parts SET diagnostics_json=json_remove(diagnostics_json,'$.candidateDiagnostics')
    WHERE page_id=? AND kind='quiz' AND json_extract(${readable},'$.candidateDiagnostics.context.taskId')=?
    AND (? IS NULL OR json_extract(${readable},'$.candidateDiagnostics.context.taskVersion')<>?)
    AND (? IS NULL OR json_extract(${readable},'$.candidateDiagnostics.context.taskVersion')=?)`)
    .run(pageId, task.taskId, task.exceptVersion ?? null, task.exceptVersion ?? null, task.exactVersion ?? null, task.exactVersion ?? null);
  else learning.database.prepare(`UPDATE learning_generation_parts SET diagnostics_json=json_remove(diagnostics_json,'$.candidateDiagnostics')
    WHERE page_id=? AND kind='quiz' AND json_extract(${readable},'$.candidateDiagnostics.expiresAt')<=?`).run(pageId, Date.now());
}
