import { z } from "zod";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import type { AgentDecisionDiagnostic } from "./types";

/** Paths may contain model-provided record keys; preserve only declared schema fields. */
export function decisionSchemaIssues(schema: z.ZodType, error: z.ZodError): Pick<AgentDecisionDiagnostic, "issues" | "issuesTruncated"> {
  const fields = new Set<string>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const object = node as Record<string, unknown>;
    if (object.properties && typeof object.properties === "object") {
      Object.keys(object.properties).forEach(field => fields.add(field));
    }
    Object.values(object).forEach(visit);
  };
  // Diagnostics must not turn a strict rejection into a different failure when
  // a custom schema cannot be serialized; unknown field paths are simply hidden.
  try { visit(toJsonSchema(schema)); } catch { /* no response values are needed */ }
  const issues: AgentDecisionDiagnostic["issues"] = [];
  let issuesTruncated = false;
  const collect = (items: z.ZodIssue[]) => {
    for (const issue of items) {
      if (issues.length >= 32) { issuesTruncated = true; return; }
      issues.push({ code: issue.code, path: issue.path.slice(0, 12).map(part =>
        typeof part === "number" ? (Number.isSafeInteger(part) && part >= 0 && part <= 100_000 ? part : "[index]")
          : fields.has(part) ? part : "[dynamic-key]") });
      if (issue.path.length > 12) issuesTruncated = true;
      if (issue.code === "invalid_union") issue.unionErrors.forEach(branch => collect(branch.issues));
    }
  };
  collect(error.issues);
  return { issues, issuesTruncated };
}

/** Exact names are recorded only for registered tools; arbitrary model strings stay out of storage. */
export function decisionToolName(name: unknown, registered: string[]): string | null {
  return typeof name === "string" && registered.includes(name) ? name.slice(0, 100) : null;
}
