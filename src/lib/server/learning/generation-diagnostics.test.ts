// @vitest-environment node
import { expect, it } from "vitest";
import { z } from "zod";
import { learningValidationDiagnostics, learningValidationError } from "./generation-diagnostics";

it("persists only schema-owned paths and error codes, with bounded details and no messages", () => {
  const safe = learningValidationDiagnostics({ validationResult: "failed", validationIssueCount: 15, validationIssues: [
    { path: "chapters[0].nodes[3].sources[0]", code: "invalid_string", message: "SECRET_TEXT", received: "PRIVATE" },
    { path: "SECRET_BODY", code: "missing_field", message: "PRIVATE_MESSAGE" },
    ...Array.from({ length: 13 }, () => ({ path: "SECRET", code: "SECRET_CODE", message: "SECRET" }))
  ], rawResponse: "PRIVATE", apiKey: "SECRET" });
  expect(safe).toEqual({ validationIssueCount: 15, validationIssuesTruncated: true, validationIssues: [
    { path: "chapters[0].nodes[3].sources[0]", code: "invalid_string" }, { path: "$", code: "missing_field" }
  ] });
  expect(JSON.stringify(safe)).not.toMatch(/SECRET|PRIVATE|apiKey|received|message/);
  expect(learningValidationDiagnostics({ validationResult: "success", validationIssues: [{ path: "$", code: "custom" }] })).toEqual({});
});
it("records local validation errors without accepting arbitrary exception text", () => {
  const result = z.object({ explanation: z.string() }).safeParse({});
  expect(result.success).toBe(false);
  if (!result.success) expect(learningValidationError(result.error)).toEqual({ validationIssueCount: 1, validationIssues: [{ path: "explanation", code: "missing_field" }] });
  expect(learningValidationError(new Error("SECRET_PROVIDER_BODY"))).toEqual({});
});

it("identifies misplaced schema-owned keys while redacting arbitrary key names and all values", () => {
  const parsed = z.object({ items: z.array(z.unknown()) }).strict().safeParse({ items: [],
    reviewCheck: { rationale: "PRIVATE_ANSWER" }, explanation: "PRIVATE_TEXT", "sk-PRIVATE_SECRET_KEY": "SECRET_VALUE" });
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  const diagnostics = learningValidationError(parsed.error);
  expect(diagnostics).toEqual({ validationIssueCount: 1, validationIssues: [{ path: "$", code: "unrecognized_keys",
    unrecognizedFields: ["reviewCheck", "explanation"], unrecognizedFieldCount: 3 }] });
  expect(learningValidationDiagnostics({ validationResult: "failed", ...diagnostics })).toEqual(diagnostics);
  expect(JSON.stringify(diagnostics)).not.toMatch(/PRIVATE|SECRET|sk-/);
  expect(learningValidationDiagnostics({ validationResult: "failed", validationIssues: [{ path: "$", code: "unrecognized_keys",
    unrecognizedFields: ["Cookie: private-session", "items", "PRIVATE_TEXT"], unrecognizedFieldCount: 3 }] }))
    .toEqual({ validationIssues: [{ path: "$", code: "unrecognized_keys", unrecognizedFields: ["items"], unrecognizedFieldCount: 3 }] });
});

it("bounds field diagnostics and ignores them for other failure types", () => {
  const extra = { unrecognizedFields: Array.from({ length: 30 }, () => "items"), unrecognizedFieldCount: 30 };
  expect(learningValidationDiagnostics({ validationResult: "failed", validationIssues: [{ path: "$", code: "unrecognized_keys", ...extra }] }))
    .toEqual({ validationIssues: [{ path: "$", code: "unrecognized_keys", unrecognizedFields: ["items"], unrecognizedFieldCount: 30 }] });
  expect(learningValidationDiagnostics({ validationResult: "failed", validationIssues: [{ path: "$", code: "invalid_type", ...extra }] }))
    .toEqual({ validationIssues: [{ path: "$", code: "invalid_type" }] });
});

it("keeps reading and selection schema paths without saving source values", () => {
  const result = z.object({ items: z.array(z.object({ context: z.string(), windows: z.array(z.string()), count: z.number() })), limitation: z.string().nullable() }).safeParse({ items: [{ context: 9, windows: [false], count: "PRIVATE" }] });
  expect(result.success).toBe(false);
  if (!result.success) {
    const diagnostic = learningValidationError(result.error);
    expect(diagnostic).toMatchObject({ validationIssueCount: 4, validationIssues: [
      { path: "items[0].context", code: "invalid_type" },
      { path: "items[0].windows[0]", code: "invalid_type" },
      { path: "items[0].count", code: "invalid_type" },
      { path: "limitation", code: "missing_field" }
    ] });
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE");
  }
});
