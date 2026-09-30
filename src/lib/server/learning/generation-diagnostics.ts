import { ZodError } from "zod";

// Learning-owned schema paths only. Never persist messages, received values,
// unrecognised property names, Provider bodies or private reasoning.
const fields = new Set(("overview chapters nodes id title explanation supplement sources materialId paragraph " +
  "items context limitation windows count contractVersion referenceScope materialPlan material contribution references focus scenario stem kind " +
  "options text reason reasonParts explanationParts evidenceIds stemEvidenceIds explanationEvidenceIds correctOptionId hint").split(" "));
const codes = new Set("missing_field invalid_type invalid_enum_value too_small too_big invalid_string unrecognized_keys invalid_union invalid_union_discriminator invalid_literal not_multiple_of not_finite custom".split(" "));
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
function safePath(value: unknown) {
  if (value === "$") return "$";
  if (typeof value !== "string" || value.length > 240 || !/^[A-Za-z]+(?:\[\d{1,6}\]|\.[A-Za-z]+)*$/.test(value)) return "$";
  return value.split(/[.\[\]]/).filter(Boolean).every(p => /^\d+$/.test(p) || fields.has(p)) ? value : "$";
}

/** Keep enough information to diagnose the schema failure without its content. */
export function learningValidationDiagnostics(input: unknown): Record<string, unknown> {
  const value = object(input);
  if (!value || value.validationResult !== "failed") return {};
  const all = Array.isArray(value.validationIssues) ? value.validationIssues : [];
  const issues = all.slice(0, 10).flatMap(item => {
    const issue = object(item);
    return issue && typeof issue.code === "string" && codes.has(issue.code) ? [{ path: safePath(issue.path), code: issue.code }] : [];
  });
  const count = value.validationIssueCount;
  return {
    ...(typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? { validationIssueCount: count } : {}),
    ...(issues.length ? { validationIssues: issues } : {}),
    ...(value.validationIssuesTruncated === true || all.length > 10 ? { validationIssuesTruncated: true } : {})
  };
}

export function learningValidationError(error: unknown) {
  if (!(error instanceof ZodError)) return {};
  return learningValidationDiagnostics({ validationResult: "failed", validationIssueCount: error.issues.length,
    validationIssues: error.issues.map(issue => ({
      path: issue.path.reduce<string>((p, part) => typeof part === "number" ? `${p}[${part}]` : `${p ? `${p}.` : ""}${part}`, "") || "$",
      code: issue.code === "invalid_type" && issue.received === "undefined" ? "missing_field" : issue.code
    })) });
}
