import { createHash } from "node:crypto";
import { ZodError } from "zod";

export type WorkWeeklyQaStage = "source_selection" | "answerer" | "verifier" | "publication" | "persistence";

const ERROR_CODES = [
  "weekly_qa_provider_unavailable", "weekly_qa_answer_invalid", "weekly_qa_source_not_allowlisted",
  "weekly_qa_verifier_invalid", "weekly_qa_provider_schema_invalid", "weekly_qa_provider_response_invalid",
  "weekly_qa_provider_timeout", "weekly_qa_cancelled", "weekly_qa_provider_failed", "weekly_qa_publication_invalid",
  "weekly_qa_contract_mismatch", "weekly_qa_thread_missing", "weekly_qa_question_missing",
  "weekly_source_changed", "weekly_qa_not_claimed", "weekly_qa_failed"
] as const;
type WorkWeeklyQaErrorCode = typeof ERROR_CODES[number];

export class WorkWeeklyQaTechnicalError extends Error {
  constructor(readonly code: WorkWeeklyQaErrorCode, readonly stage: WorkWeeklyQaStage, cause?: unknown) {
    super(code, { cause });
    this.name = "WorkWeeklyQaTechnicalError";
  }
}

/** Fixed codes only: SDK messages, response bodies and arbitrary error.code are never diagnostics. */
export function classifyWorkWeeklyQaError(error: unknown, stage: WorkWeeklyQaStage): WorkWeeklyQaTechnicalError {
  if (error instanceof WorkWeeklyQaTechnicalError) return error;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  let safeCode: WorkWeeklyQaErrorCode;
  if (typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code)) {
    safeCode = code as WorkWeeklyQaErrorCode;
  } else if (error instanceof ZodError || code === "work_weekly_provider_schema_invalid") {
    safeCode = "weekly_qa_provider_schema_invalid";
  } else if (code === "work_weekly_verifier_output_invalid") {
    safeCode = "weekly_qa_verifier_invalid";
  } else if (code === "work_weekly_verifier_source_not_allowed" || code === "work_weekly_source_not_allowlisted") {
    safeCode = "weekly_qa_source_not_allowlisted";
  } else if (code === "work_weekly_provider_timeout" || (error instanceof Error && error.name === "TimeoutError")) {
    safeCode = "weekly_qa_provider_timeout";
  } else if (code === "work_weekly_provider_cancelled" || (error instanceof Error && error.name === "AbortError")) {
    safeCode = "weekly_qa_cancelled";
  } else if (typeof code === "string" && ["no_json", "empty_response", "incomplete_json", "invalid_json", "incomplete_response"].includes(code)) {
    safeCode = "weekly_qa_provider_response_invalid";
  } else {
    safeCode = stage === "persistence" || stage === "source_selection" ? "weekly_qa_failed" : "weekly_qa_provider_failed";
  }
  return new WorkWeeklyQaTechnicalError(safeCode, stage, error);
}

export function assertWorkWeeklyQaNotCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new WorkWeeklyQaTechnicalError("weekly_qa_cancelled", "persistence");
}

const SCHEMA_FIELDS = new Set([
  "status", "answer", "claims", "id", "text", "claimType", "sourceRefs", "relevantSourceRefs",
  "items", "claimId", "verdict", "issueCodes", "supportedSourceRefs"
]);

export function workWeeklyQaSchemaIssues(error: unknown): Array<{ code: string; path: string }> {
  let current = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof ZodError) {
      return current.issues.slice(0, 16).map((issue) => ({
        code: issue.code,
        path: issue.path.slice(0, 8).map((part) => typeof part === "number"
          ? Number.isSafeInteger(part) && part >= 0 && part <= 1_024 ? String(part) : "index"
          : SCHEMA_FIELDS.has(String(part)) ? String(part) : "other").join(".") || "root"
      }));
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return [];
}

// Provider issueCodes are open strings. Unknown values count as other, never as log keys.
const SAFE_REASONS = new Set([
  "entailed", "partially_entailed", "unsupported", "contradicted", "unverifiable",
  "accepted", "exact_duplicate", "invalid_contract", "item_output_invalid", "related_claim_rejected",
  "verifier_partially_entailed", "verifier_unsupported", "verifier_contradicted", "verifier_unverifiable",
  "verifier_issues", "source_not_allowed", "item_verifier_issue", "claim_type_mismatch", "decision_source_missing",
  "commitment_source_missing", "completion_not_current_week_event", "deadline_source_missing", "causality_source_missing",
  "frequency_not_supported", "person_source_missing", "temporal_sources_missing",
  "missing_qualification", "unsupported_claim", "missing_evidence", "mixed_topics", "non_atomic_claim",
  "section_mismatch", "invalid_attention_target", "proposal_not_decision", "assignment_not_commitment",
  "completion_not_delivery", "date_not_deadline", "temporal_order_not_causality", "insufficient_independent_sources"
]);

export function workWeeklyQaReasonCounts(reasons: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const reason of reasons) {
    const key = SAFE_REASONS.has(reason) ? reason : "other";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export type WorkWeeklyQaDiagnostic = {
  stage: WorkWeeklyQaStage;
  outcome: "started" | "succeeded" | "insufficient_evidence" | "failed" | "published";
  errorCode?: WorkWeeklyQaErrorCode;
  reasonCode?: "weekly_qa_performance_question_refused" | "weekly_qa_no_relevant_sources"
    | "weekly_qa_answerer_insufficient" | "weekly_qa_no_safe_claims";
  sourceUnitCount?: number;
  sourceRefCount?: number;
  findingUnitCount?: number;
  todoUnitCount?: number;
  claimCount?: number;
  verdictCount?: number;
  publishedClaimCount?: number;
  verdictCounts?: Record<string, number>;
  issueCounts?: Record<string, number>;
  publicationReasonCounts?: Record<string, number>;
  schemaIssues?: Array<{ code: string; path: string }>;
};
export type WorkWeeklyQaDiagnosticObserver = (event: WorkWeeklyQaDiagnostic) => void | Promise<void>;
export type WorkWeeklyQaDiagnosticSink = (event: WorkWeeklyQaDiagnostic & {
  component: "work-weekly-qa";
  runKey: string;
  runVersion: number;
}) => void | Promise<void>;

/** Stable correlation without serializing account IDs, question text or source identifiers. */
export function workWeeklyQaRunKey(accountId: string, runId: string) {
  return createHash("sha256").update(JSON.stringify([accountId, runId])).digest("hex");
}

export async function emitWorkWeeklyQaDiagnostic(observer: WorkWeeklyQaDiagnosticObserver | undefined, event: WorkWeeklyQaDiagnostic) {
  try { await observer?.(event); } catch { /* Diagnostics never change an answer or a committed run. */ }
}
