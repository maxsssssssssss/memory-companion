import { z, ZodError } from "zod";

import {
  WorkWeeklySectionKindSchema,
  WorkWeeklySourceSnapshotSchema,
  WorkWeeklySourceRefSchema,
  type WorkWeeklySourceSnapshot
} from "@/lib/domain/work-weekly";
import { createOpenAIClient } from "@/lib/server/openai/client";
import { parseStructuredJsonResponse, StructuredJsonResponseError } from "@/lib/server/openai/structured-json";
import { getOpenAIClientRuntimeConfig } from "@/lib/server/settings/provider-config";

export const WORK_WEEKLY_SYNTHESIZER_PROFILE_ID = "work_weekly_synthesizer_v1" as const;
export const WORK_WEEKLY_VERIFIER_PROFILE_ID = "work_weekly_verifier_v1" as const;
export const WORK_WEEKLY_QA_ANSWERER_PROFILE_ID = "work_weekly_qa_answerer_v1" as const;
export const WORK_WEEKLY_QA_VERIFIER_PROFILE_ID = "work_weekly_qa_verifier_v1" as const;

export const WORK_WEEKLY_SYNTHESIZER_PROMPT_VERSION = "work_weekly_synthesizer_prompt_v14" as const;
export const WORK_WEEKLY_VERIFIER_PROMPT_VERSION = "work_weekly_verifier_prompt_v11" as const;
export const WORK_WEEKLY_QA_ANSWERER_PROMPT_VERSION = "work_weekly_qa_answerer_prompt_v1" as const;
export const WORK_WEEKLY_QA_VERIFIER_PROMPT_VERSION = "work_weekly_qa_verifier_prompt_v1" as const;

export const WORK_WEEKLY_SYNTHESIZER_SCHEMA_VERSION = "work_weekly_synthesizer_schema_v3" as const;
export const WORK_WEEKLY_VERIFIER_SCHEMA_VERSION = "work_weekly_verifier_schema_v4" as const;
export const WORK_WEEKLY_QA_ANSWERER_SCHEMA_VERSION = "work_weekly_qa_answerer_schema_v1" as const;
export const WORK_WEEKLY_QA_VERIFIER_SCHEMA_VERSION = "work_weekly_qa_verifier_schema_v1" as const;

export const WorkWeeklyClaimTypeSchema = z.enum([
  "fact",
  "person",
  "decision",
  "commitment",
  "deadline",
  "completion",
  "causality",
  "frequency",
  "temporal_order"
]);

const workWeeklyGeneratedIdSchema = z.string().trim().min(1).max(512);

export const WorkWeeklyGeneratedClaimSchema = z.object({
  id: workWeeklyGeneratedIdSchema,
  text: z.string().trim().min(1).max(20_000),
  claimType: WorkWeeklyClaimTypeSchema,
  sourceRefs: z.array(WorkWeeklySourceRefSchema).min(1).max(64)
}).strict().superRefine((claim, context) => {
  if (new Set(claim.sourceRefs).size !== claim.sourceRefs.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceRefs"],
      message: "Claim sourceRefs must be unique"
    });
  }
});

const WORK_WEEKLY_ITEM_TYPES = ["evidence_backed_fact", "interpretation", "suggestion"] as const;

export const WorkWeeklyGeneratedItemSchema = z.object({
  id: workWeeklyGeneratedIdSchema,
  section: WorkWeeklySectionKindSchema,
  text: z.string().trim().min(1).max(20_000),
  itemType: z.enum(WORK_WEEKLY_ITEM_TYPES),
  claims: z.array(WorkWeeklyGeneratedClaimSchema).min(1).max(32)
}).strict().superRefine((item, context) => {
  if ((item.section === "next_week") !== (item.itemType === "suggestion")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["itemType"],
      message: "Only next_week items may be suggestions, and next_week must be a suggestion"
    });
  }
  const ids = item.claims.map((claim) => claim.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Claim IDs must be unique per item" });
  }
});

export const WorkWeeklySynthesizerResponseSchema = z.object({
  items: z.array(WorkWeeklyGeneratedItemSchema).max(64)
}).strict().superRefine((response, context) => {
  const itemIds = response.items.map((item) => item.id);
  if (new Set(itemIds).size !== itemIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Generated item IDs must be unique" });
  }
  const claimIds = response.items.flatMap((item) => item.claims.map((claim) => claim.id));
  if (new Set(claimIds).size !== claimIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Generated claim IDs must be unique" });
  }
});

export function workWeeklyCurrentCompletionSourceRefs(snapshot: WorkWeeklySourceSnapshot) {
  return snapshot.todoEvents.filter((event) => event.eventType === "todo.completed"
    && event.localDate >= snapshot.scope.weekStart && event.localDate <= snapshot.scope.weekEnd
    && event.localDate <= snapshot.scope.observedThrough).map((event) => event.sourceRef);
}

export function workWeeklyCompletionClaimSupported(snapshot: WorkWeeklySourceSnapshot, refs: string[], text: string) {
  return /在系统中标记完成/u.test(text)
    && !/(?:上周|前一周|去年|上月)/u.test(text)
    && !/(?:已|已经|因此|所以)(?:现实履行|实际交付|实际完成)/u.test(text)
    && workWeeklyCurrentCompletionSourceRefs(snapshot).some((ref) => refs.includes(ref));
}

/** Generation-only contract. The shared item schema and QA may still carry
 * multiple independent claims; do not weaken their publication checks. */
export function buildWorkWeeklySynthesisResponseSchema(snapshot: WorkWeeklySourceSnapshot) {
  return WorkWeeklySynthesizerResponseSchema.superRefine((response, context) => {
    response.items.forEach((item, index) => {
      if (item.claims.length !== 1) context.addIssue({ code: z.ZodIssueCode.custom,
        path: ["items", index, "claims"], message: "Each generated topic must be one self-contained claim" });
      if (item.section === "completed" && !item.claims.every((claim) =>
        workWeeklyCompletionClaimSupported(snapshot, claim.sourceRefs, claim.text))) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["items", index, "section"],
          message: "Completed requires a current-week Todo completion event and system-state wording" });
      }
    });
  });
}

export const WorkWeeklyClaimVerdictSchema = z.enum([
  "entailed",
  "partially_entailed",
  "unsupported",
  "contradicted",
  "unverifiable"
]);

export const WorkWeeklyVerifierItemSchema = z.object({
  claimId: z.string().trim().min(1).max(512),
  verdict: WorkWeeklyClaimVerdictSchema,
  issueCodes: z.array(z.string().trim().min(1).max(256)).max(32),
  supportedSourceRefs: z.array(WorkWeeklySourceRefSchema).max(64)
}).strict().superRefine((item, context) => {
  if (new Set(item.supportedSourceRefs).size !== item.supportedSourceRefs.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["supportedSourceRefs"],
      message: "supportedSourceRefs must be unique"
    });
  }
});

export const WorkWeeklyVerifierResponseSchema = z.object({
  items: z.array(WorkWeeklyVerifierItemSchema).max(2_048)
}).strict();

export const WorkWeeklyCoverageAssessmentSchema = z.object({
  sourceRef: WorkWeeklySourceRefSchema,
  status: z.enum(["covered", "partial", "omitted", "not_applicable"]),
  claimIds: z.array(workWeeklyGeneratedIdSchema).max(2_048),
  reasonCode: z.enum(["covered", "missing_key_content", "missing_qualification", "duplicate", "background_only", "outside_week"])
}).strict();

const WorkWeeklyVerificationDisputeSchema = z.object({
  claimId: workWeeklyGeneratedIdSchema,
  issueCode: z.string().trim().min(1).max(256),
  claimExcerpt: z.string().trim().min(1).max(600),
  explanation: z.string().trim().min(1).max(600)
}).strict();

const WorkWeeklyCoverageMatchSchema = z.object({
  claimId: workWeeklyGeneratedIdSchema,
  sourceExcerpt: z.string().trim().min(1).max(600),
  claimExcerpt: z.string().trim().min(1).max(600)
}).strict();

export const WorkWeeklyGenerationVerifierResponseSchema = z.object({
  items: z.array(WorkWeeklyVerifierItemSchema).max(2_048),
  // Parse auxiliary details separately; malformed prose cannot invalidate the
  // authoritative verdicts or erase otherwise usable content.
  disputes: z.unknown().optional(),
  // These are semantic selections, never inferred from the reference graph.
  coverage: z.array(WorkWeeklyCoverageAssessmentSchema.extend({
    matches: z.unknown().optional()
  })).max(2_048)
}).strict();

export type WorkWeeklyCoverageAssessment = z.infer<typeof WorkWeeklyCoverageAssessmentSchema>;
export type WorkWeeklyVerificationAuditDetails = {
  disputes: z.infer<typeof WorkWeeklyVerificationDisputeSchema>[];
  coverageMatches: { sourceRef: string; matches: z.infer<typeof WorkWeeklyCoverageMatchSchema>[] }[];
  discardedDiagnosticCount: number;
};

/** Exact audit text, not an additional citation source. */
export function workWeeklyCoverageSourceText(snapshot: WorkWeeklySourceSnapshot, sourceRef: string): string {
  return snapshot.findings.find((source) => source.sourceRef === sourceRef)?.body
    ?? JSON.stringify(resolveWorkWeeklySourceRecord(snapshot, sourceRef)?.value ?? null);
}

/** Audit units, not a requirement to publish or cite every source individually. */
export function workWeeklyCoverageSourceRefs(snapshot: WorkWeeklySourceSnapshot): string[] {
  return [...snapshot.findings, ...snapshot.todos, ...snapshot.todoEvents].map((source) => source.sourceRef).sort();
}

function coverageClaimRelationship(snapshot: WorkWeeklySourceSnapshot, sourceRef: string, refs: string[]) {
  if (refs.includes(sourceRef)) return "direct_record" as const;
  const finding = snapshot.findings.find((source) => source.sourceRef === sourceRef);
  if (finding) {
    const supportingEvidence = new Set(finding.evidenceRefs);
    if (refs.some((ref) => supportingEvidence.has(ref))) return "direct_evidence" as const;
    return refs.some((ref) => snapshot.findings.some((other) => other.sourceRef === ref
      && other.evidenceRefs.some((evidenceRef) => supportingEvidence.has(evidenceRef)))) ? "shared_evidence" as const : null;
  }
  const todo = snapshot.todos.find((source) => source.sourceRef === sourceRef);
  const event = snapshot.todoEvents.find((source) => source.sourceRef === sourceRef);
  const todoId = todo?.id ?? event?.todoId;
  return todoId && (snapshot.todos.some((source) => source.id === todoId && refs.includes(source.sourceRef))
    || snapshot.todoEvents.some((source) => source.todoId === todoId && refs.includes(source.sourceRef))) ? "todo_history" as const : null;
}

export function workWeeklyCoverageClaimIsRelated(snapshot: WorkWeeklySourceSnapshot, sourceRef: string, refs: string[]) {
  return coverageClaimRelationship(snapshot, sourceRef, refs) !== null;
}

export function validateWorkWeeklyCoverage(input: {
  coverage: unknown;
  snapshot: WorkWeeklySourceSnapshot;
  claims: WorkWeeklyGeneratedClaim[];
  localizeMappingErrors?: boolean;
}): WorkWeeklyCoverageAssessment[] {
  const parsed = z.array(WorkWeeklyCoverageAssessmentSchema).safeParse(input.coverage);
  const refs = workWeeklyCoverageSourceRefs(input.snapshot);
  if (!parsed.success) rejectWeeklyVerifierContract("work_weekly_coverage_output_invalid", "coverage_schema",
    { expectedCount: refs.length }, parsed.error);
  const counts = verifierIdentityCounts(refs, parsed.data.map((entry) => entry.sourceRef));
  const claimIds = new Set(input.claims.map((claim) => claim.id));
  if (counts.actualCount !== counts.expectedCount || counts.duplicateCount || counts.missingCount || counts.unknownCount) {
    rejectWeeklyVerifierContract("work_weekly_coverage_output_invalid", "coverage_source_set", counts);
  }
  for (const entry of parsed.data) {
    const duplicateClaimIdCount = entry.claimIds.length - new Set(entry.claimIds).size;
    const unknownClaimIdCount = entry.claimIds.filter((id) => !claimIds.has(id)).length;
    if (duplicateClaimIdCount || unknownClaimIdCount) {
      rejectWeeklyVerifierContract("work_weekly_coverage_output_invalid", "coverage_claim_ids",
        { ...counts, duplicateClaimIdCount, unknownClaimIdCount });
    }
    const unrelatedClaimCount = entry.claimIds.filter((id) => !workWeeklyCoverageClaimIsRelated(input.snapshot, entry.sourceRef,
      input.claims.find((claim) => claim.id === id)!.sourceRefs)).length;
    // Duplicate is a semantic comparison with other canonical material, not
    // attribution to this source. It never adds citations to a claim.
    if (unrelatedClaimCount && entry.reasonCode !== "duplicate") {
      if (input.localizeMappingErrors) {
        entry.status = "partial"; entry.reasonCode = "missing_key_content"; entry.claimIds = [];
        continue;
      }
      rejectWeeklyVerifierContract("work_weekly_coverage_source_unrelated", "coverage_source_relation", { ...counts, unrelatedClaimCount });
    }
    const valid = entry.status === "covered"
      ? entry.reasonCode === "covered" && entry.claimIds.length > 0
      : entry.status === "partial" || entry.status === "omitted"
        ? entry.reasonCode === "missing_key_content" || entry.reasonCode === "missing_qualification"
        : entry.reasonCode === "duplicate" ? entry.claimIds.length > 0
          : (entry.reasonCode === "background_only" || entry.reasonCode === "outside_week") && entry.claimIds.length === 0;
    if (!valid) {
      if (input.localizeMappingErrors) {
        entry.status = "omitted"; entry.reasonCode = "missing_key_content"; entry.claimIds = [];
      } else rejectWeeklyVerifierContract("work_weekly_coverage_output_invalid", "coverage_status_contract", counts);
    }
  }
  return parsed.data;
}

export type WorkWeeklyClaimType = z.infer<typeof WorkWeeklyClaimTypeSchema>;
export type WorkWeeklyGeneratedClaim = z.infer<typeof WorkWeeklyGeneratedClaimSchema>;
export type WorkWeeklyGeneratedItem = z.infer<typeof WorkWeeklyGeneratedItemSchema>;
export type WorkWeeklyClaimVerdict = z.infer<typeof WorkWeeklyClaimVerdictSchema>;
export type WorkWeeklyVerifierItem = z.infer<typeof WorkWeeklyVerifierItemSchema>;

export type WorkWeeklyProviderRole =
  | "synthesizer"
  | "verifier"
  | "qa_answerer"
  | "qa_verifier";

export type WorkWeeklyProviderProfile = {
  id: string;
  role: WorkWeeklyProviderRole;
  provider: "openai" | "openai_compatible" | "fixture";
  model: string;
  reasoningEffort: "provider_default" | "none" | "minimal" | "low" | "medium" | "high";
  timeoutMs: number;
  maxOutputTokens: number;
  promptVersion: string;
  schemaVersion: string;
};

type RuntimeEnv = Readonly<Record<string, string | undefined>>;

const ROLE_CONFIG = {
  synthesizer: {
    prefix: "WORK_REVIEW_WEEKLY_SYNTHESIZER",
    id: WORK_WEEKLY_SYNTHESIZER_PROFILE_ID,
    promptVersion: WORK_WEEKLY_SYNTHESIZER_PROMPT_VERSION,
    schemaVersion: WORK_WEEKLY_SYNTHESIZER_SCHEMA_VERSION,
    defaultTimeoutMs: 120_000,
    defaultMaxOutputTokens: 16_000
  },
  verifier: {
    prefix: "WORK_REVIEW_WEEKLY_VERIFIER",
    id: WORK_WEEKLY_VERIFIER_PROFILE_ID,
    promptVersion: WORK_WEEKLY_VERIFIER_PROMPT_VERSION,
    schemaVersion: WORK_WEEKLY_VERIFIER_SCHEMA_VERSION,
    defaultTimeoutMs: 120_000,
    defaultMaxOutputTokens: 8_000
  },
  qa_answerer: {
    prefix: "WORK_REVIEW_WEEKLY_QA_ANSWERER",
    id: WORK_WEEKLY_QA_ANSWERER_PROFILE_ID,
    promptVersion: WORK_WEEKLY_QA_ANSWERER_PROMPT_VERSION,
    schemaVersion: WORK_WEEKLY_QA_ANSWERER_SCHEMA_VERSION,
    defaultTimeoutMs: 30_000,
    defaultMaxOutputTokens: 4_000
  },
  qa_verifier: {
    prefix: "WORK_REVIEW_WEEKLY_QA_VERIFIER",
    id: WORK_WEEKLY_QA_VERIFIER_PROFILE_ID,
    promptVersion: WORK_WEEKLY_QA_VERIFIER_PROMPT_VERSION,
    schemaVersion: WORK_WEEKLY_QA_VERIFIER_SCHEMA_VERSION,
    defaultTimeoutMs: 30_000,
    defaultMaxOutputTokens: 4_000
  }
} as const;

export class WorkWeeklyProviderError extends Error {
  constructor(readonly code: string, message = code, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkWeeklyProviderError";
  }
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new WorkWeeklyProviderError("work_weekly_provider_config_invalid");
  }
  return parsed;
}

export function resolveWorkWeeklyProviderProfile(
  role: WorkWeeklyProviderRole,
  env: RuntimeEnv = process.env
): WorkWeeklyProviderProfile {
  const config = ROLE_CONFIG[role];
  const providerValue = (env[`${config.prefix}_PROVIDER`] ?? "openai_compatible").trim();
  if (!(["openai", "openai_compatible", "fixture"] as const).includes(
    providerValue as "openai" | "openai_compatible" | "fixture"
  )) {
    throw new WorkWeeklyProviderError("work_weekly_provider_config_invalid");
  }
  if (providerValue === "fixture"
    && (env.NODE_ENV === "production" || env.WORK_REVIEW_ALLOW_FIXTURE_PROVIDER !== "true")) {
    throw new WorkWeeklyProviderError("work_weekly_fixture_provider_forbidden");
  }
  const model = (
    env[`${config.prefix}_MODEL`]
    ?? env.OPENAI_QA_MODEL
    ?? env.OPENAI_TEXT_MODEL
    ?? ""
  ).trim();
  if (!model) throw new WorkWeeklyProviderError("work_weekly_provider_model_missing");
  const effort = (env[`${config.prefix}_REASONING_EFFORT`] ?? "provider_default").trim();
  if (!(["provider_default", "none", "minimal", "low", "medium", "high"] as const)
    .includes(effort as WorkWeeklyProviderProfile["reasoningEffort"])) {
    throw new WorkWeeklyProviderError("work_weekly_provider_config_invalid");
  }
  if (effort === "none"
    && (providerValue !== "openai_compatible" || model !== "deepseek-v4-pro")) {
    throw new WorkWeeklyProviderError("work_weekly_provider_config_invalid");
  }
  return {
    id: config.id,
    role,
    provider: providerValue as WorkWeeklyProviderProfile["provider"],
    model,
    reasoningEffort: effort as WorkWeeklyProviderProfile["reasoningEffort"],
    timeoutMs: positiveInteger(
      env[`${config.prefix}_TIMEOUT_MS`], config.defaultTimeoutMs, 120_000
    ),
    maxOutputTokens: positiveInteger(
      env[`${config.prefix}_MAX_OUTPUT_TOKENS`], config.defaultMaxOutputTokens, 32_000
    ),
    promptVersion: config.promptVersion,
    schemaVersion: config.schemaVersion
  };
}

export type WorkWeeklyStructuredJsonRequest = (input: {
  profile: WorkWeeklyProviderProfile;
  schema: z.ZodTypeAny;
  requestInput: Parameters<typeof parseStructuredJsonResponse>[0]["requestInput"];
  jsonInstruction: string;
  normalize?: (value: unknown) => unknown;
  signal?: AbortSignal;
}) => Promise<unknown>;

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("work_weekly_provider_timeout")),
    timeoutMs
  );
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    }
  };
}

export const requestWorkWeeklyStructuredJson: WorkWeeklyStructuredJsonRequest = async (input) => {
  if (input.profile.provider === "fixture") {
    throw new WorkWeeklyProviderError("work_weekly_fixture_provider_forbidden");
  }
  const runtime = await getOpenAIClientRuntimeConfig();
  const baseClient = createOpenAIClient({ ...runtime, timeoutMs: input.profile.timeoutMs });
  const endpoint = new URL(baseClient.baseURL);
  const tokenHubDeepSeek = endpoint.hostname === "tokenhub.vision-intelligence.tech"
    && input.profile.model === "deepseek-v4-pro";
  if (tokenHubDeepSeek && (
    !["http:", "https:"].includes(endpoint.protocol)
    || endpoint.username || endpoint.password || endpoint.port || endpoint.search || endpoint.hash
    || !["/", "/v1", "/v1/"].includes(endpoint.pathname)
  )) throw new WorkWeeklyProviderError("work_weekly_tokenhub_base_url_invalid");
  if (input.profile.reasoningEffort === "none" && !tokenHubDeepSeek) {
    throw new WorkWeeklyProviderError("work_weekly_provider_config_invalid");
  }
  const client = tokenHubDeepSeek ? baseClient.withOptions({
    baseURL: "https://tokenhub.vision-intelligence.tech/v1",
    maxRetries: 0,
    logLevel: "off",
    fetchOptions: { redirect: "error" },
    organization: null,
    project: null
  }) : baseClient;
  const effort = input.profile.reasoningEffort === "provider_default"
    ? tokenHubDeepSeek ? "none" : undefined
    : input.profile.reasoningEffort;
  const request = timeoutSignal(input.signal, input.profile.timeoutMs);
  try {
    return await parseStructuredJsonResponse({
      client,
      model: input.profile.model,
      name: input.profile.schemaVersion,
      schema: input.schema,
      mode: "json",
      ...(tokenHubDeepSeek ? { stream: true } : {}),
      requestInput: input.requestInput,
      jsonInstruction: input.jsonInstruction,
      normalize: input.normalize,
      maxOutputTokens: input.profile.maxOutputTokens,
      // The installed SDK predates `none`; restrict this extension above to
      // the adopted TokenHub DeepSeek route, as the meeting provider does.
      reasoning: effort ? { effort } as NonNullable<
        Parameters<typeof parseStructuredJsonResponse>[0]["reasoning"]
      > : undefined,
      requestOptions: {
        signal: request.signal,
        ...(tokenHubDeepSeek ? { timeout: input.profile.timeoutMs, maxRetries: 0 } : {})
      },
      onDiagnostics(diagnostics) {
        if (diagnostics.parseResult === "failed" || diagnostics.validationResult === "failed"
          || diagnostics.providerErrorCode || diagnostics.responseStatus === "incomplete") {
          console.error(JSON.stringify({
            component: "work-weekly-provider",
            role: input.profile.role,
            parseResult: diagnostics.parseResult,
            validationResult: diagnostics.validationResult,
            responseStatus: diagnostics.responseStatus === undefined ? undefined
              : ["completed", "incomplete", "failed", "cancelled", "in_progress", "queued"]
                .includes(diagnostics.responseStatus) ? diagnostics.responseStatus : "other",
            providerErrorCode: diagnostics.providerErrorCode,
            ...(diagnostics.parseResult === "failed" ? {
              responseTextLength: diagnostics.responseTextLength,
              inputTokens: diagnostics.inputTokens,
              outputTokens: diagnostics.outputTokens
            } : {}),
            validationIssueSummary: diagnostics.validationIssueSummary,
            validationPaths: diagnostics.validationIssues?.map(({ path, code }) => ({ path, code }))
          }));
        }
      }
    });
  } catch (error) {
    if (request.signal.aborted) {
      throw new WorkWeeklyProviderError(
        input.signal?.aborted ? "work_weekly_provider_cancelled" : "work_weekly_provider_timeout",
        undefined,
        { cause: error }
      );
    }
    if (error instanceof ZodError) {
      throw new WorkWeeklyProviderError("work_weekly_provider_schema_invalid", undefined, { cause: error });
    }
    if (error instanceof StructuredJsonResponseError) {
      console.error(JSON.stringify({ component: "work-weekly-provider", role: input.profile.role,
        errorCode: error.code }));
    }
    throw error;
  } finally {
    request.cleanup();
  }
};

function sameSet(left: Iterable<string>, right: Iterable<string>) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

export function assertWorkWeeklySnapshotAuthority(input: {
  snapshot: WorkWeeklySourceSnapshot;
  accountId: string;
}) {
  const snapshot = WorkWeeklySourceSnapshotSchema.parse(input.snapshot);
  if (snapshot.accountId !== input.accountId) {
    throw new WorkWeeklyProviderError("work_weekly_snapshot_account_mismatch");
  }
  const allowlist = new Set(snapshot.allowlistedSourceRefs);
  if (allowlist.size !== snapshot.allowlistedSourceRefs.length) {
    throw new WorkWeeklyProviderError("work_weekly_source_allowlist_invalid");
  }
  const included = snapshot.identities
    .filter((identity) => identity.included)
    .map((identity) => identity.sourceRef);
  if (!sameSet(included, allowlist)) {
    throw new WorkWeeklyProviderError("work_weekly_source_allowlist_invalid");
  }
  const refs = [
    ...snapshot.meetings.map((source) => source.sourceRef),
    ...snapshot.findings.map((source) => source.sourceRef),
    ...snapshot.todos.map((source) => source.sourceRef),
    ...snapshot.todoEvents.map((source) => source.sourceRef),
    ...snapshot.evidence.map((source) => source.sourceRef),
    ...snapshot.findings.flatMap((source) => source.evidenceRefs)
  ];
  if (refs.some((ref) => !allowlist.has(ref))) {
    throw new WorkWeeklyProviderError("work_weekly_source_not_allowlisted");
  }
  return snapshot;
}

export type WorkWeeklySourceRecord = {
  sourceRef: string;
  sourceKind: "meeting" | "finding" | "todo" | "todo_event" | "project" | "evidence";
  value: unknown;
};

export function resolveWorkWeeklySourceRecord(
  snapshot: WorkWeeklySourceSnapshot,
  sourceRef: string
): WorkWeeklySourceRecord | null {
  const identity = snapshot.identities.find((candidate) =>
    candidate.included && candidate.sourceRef === sourceRef
  );
  if (!identity) return null;
  let value: unknown;
  switch (identity.sourceKind) {
    case "meeting":
      value = snapshot.meetings.find((candidate) => candidate.sourceRef === sourceRef);
      break;
    case "finding":
      value = snapshot.findings.find((candidate) => candidate.sourceRef === sourceRef);
      break;
    case "todo":
      value = snapshot.todos.find((candidate) => candidate.sourceRef === sourceRef);
      break;
    case "todo_event":
      value = snapshot.todoEvents.find((candidate) => candidate.sourceRef === sourceRef);
      break;
    case "evidence":
      value = snapshot.evidence.find((candidate) => candidate.sourceRef === sourceRef);
      break;
    case "project":
      value = snapshot.projects.find((candidate) => candidate.id === identity.sourceId);
      break;
  }
  return value === undefined ? null : { sourceRef, sourceKind: identity.sourceKind, value };
}

function sourceRecords(snapshot: WorkWeeklySourceSnapshot, refs: string[]) {
  return refs.map((ref) => {
    const record = resolveWorkWeeklySourceRecord(snapshot, ref);
    if (!record) throw new WorkWeeklyProviderError("work_weekly_source_not_allowlisted");
    const finding = snapshot.findings.find((source) => source.sourceRef === ref);
    const meetingId = finding?.meetingId ?? snapshot.evidence.find((source) => source.sourceRef === ref)?.meetingId;
    const meetingDate = snapshot.meetings.find((meeting) => meeting.id === meetingId)?.meetingDate;
    return { ...record, ...(finding ? findingProviderView(finding) : {}),
      ...(meetingDate ? { recordContext: { meetingDate, activityTimeBasis: "source_text" } } : {}) };
  });
}

function findingProviderView(finding: WorkWeeklySourceSnapshot["findings"][number]) {
  const data = finding.structuredData && typeof finding.structuredData === "object" && !Array.isArray(finding.structuredData)
    ? finding.structuredData as Record<string, unknown> : {};
  // Meeting publication-policy emits this note when finality is still pending
  // and may deliberately retain its recorded enum. Resolve that known display
  // contract only in the model view; never rewrite the canonical snapshot.
  const confirmationPending = finding.kind === "decision" && finding.body.includes("决定是否最终待确认");
  // The meeting policy emits this separate optional-deadline status. It must
  // not erase an accepted task or promote a retained date expression.
  const deadlinePending = finding.body.includes("截止时间待确认");
  const effectiveFinality = confirmationPending
    ? data.decisionFinality === "tentative" ? "tentative" : "unclear"
    : data.decisionFinality ?? null;
  const mode = finding.kind === "proposal" ? "proposal"
    : data.actionBasis === "assignment_without_acceptance" ? "assignment"
      : finding.kind === "decision" ? "decision"
        : finding.kind === "commitment" ? "commitment" : "reported_fact";
  const generationGuidance = {
    mode,
    suggestedClaimType: mode === "decision" || mode === "commitment" ? mode : "fact",
    framing: mode === "proposal" ? "表述为提出/拟议的方案，放open_questions；不因认领或日期改写为已决定、承诺或已开展。"
      : mode === "assignment" ? "表述为分配事项，接受与开展尚不能由分配本身证明。"
        : mode === "decision" ? "按有效最终性表述安排、范围变化和后续重评条件；如实保留待确认是正确表述，不是claim冲突。"
          : mode === "commitment" ? "表述已作出的承诺；履行及实际开展另需证据。可在decisions说明已同意的安排。"
            : "表述已有观察或未决事实；只有来源描述实际活动才能归入进展。",
    ...(mode === "decision" ? { effectiveFinality,
      finalityBasis: confirmationPending ? "canonical_confirmation_note" : "recorded_value_and_body" } : {}),
    qualificationBasis: "body",
    deadlineStatus: deadlinePending ? "pending_confirmation" : "read_source",
    deadlineFraming: deadlinePending ? "任务接受与日期确认分别判断；保留有据任务，日期若保留须明确待确认，或省略未确认日期。" : "日期仅按来源支持的含义表达。",
    progressBasis: "actual_activity_required"
  } as const;
  return {
    value: confirmationPending ? { ...finding, structuredData: { ...data, decisionFinality: effectiveFinality } } : finding,
    generationGuidance
  };
}

export function buildWorkWeeklySynthesisPack(input: {
  accountId: string;
  snapshot: WorkWeeklySourceSnapshot;
}) {
  const snapshot = assertWorkWeeklySnapshotAuthority(input);
  const groupedEvidence = new Set(snapshot.findings.flatMap((finding) => finding.evidenceRefs));
  return {
    contractVersion: 1,
    scope: snapshot.scope,
    snapshotDigest: snapshot.digest,
    inputPackDigest: snapshot.inputPackDigest,
    sourceSummary: snapshot.summary,
    generationContract: {
      claimsPerTopic: 1,
      allowedSections: WorkWeeklySectionKindSchema.options.filter((section) =>
        section !== "completed" || workWeeklyCurrentCompletionSourceRefs(snapshot).length > 0),
      currentWeekCompletionSourceRefs: workWeeklyCurrentCompletionSourceRefs(snapshot)
    },
    sources: sourceRecords(snapshot, snapshot.allowlistedSourceRefs.filter((ref) => !groupedEvidence.has(ref)))
      .map((record) => {
        const finding = snapshot.findings.find((source) => source.sourceRef === record.sourceRef);
        return { ...record, ...(finding ? { supportingEvidence: sourceRecords(snapshot, finding.evidenceRefs) } : {}) };
      })
  } as const;
}

// These IDs join this response to its verifier input only; persistent IDs are
// allocated by the repository. Preserve invalid fields for strict rejection.
function normalizeWorkWeeklyGeneratedIds(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const response = value as Record<string, unknown>;
  if (!Array.isArray(response.items) || response.items.length > 64) return value;
  return { ...response, items: response.items.map((entry, itemIndex) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const item = entry as Record<string, unknown>;
    const itemNumber = String(itemIndex + 1).padStart(3, "0");
    return {
      ...item,
      ...(workWeeklyGeneratedIdSchema.safeParse(item.id).success ? { id: `item_${itemNumber}` } : {}),
      ...(Array.isArray(item.claims) ? { claims: item.claims.map((entry, claimIndex) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const claim = entry as Record<string, unknown>;
        return {
          ...claim,
          ...(workWeeklyGeneratedIdSchema.safeParse(claim.id).success
            ? { id: `claim_${itemNumber}_${String(claimIndex + 1).padStart(3, "0")}` } : {})
        };
      }) } : {})
    };
  }) };
}

function validateGeneratedItems(input: {
  response: unknown;
  snapshot: WorkWeeklySourceSnapshot;
}) {
  const parsed = buildWorkWeeklySynthesisResponseSchema(input.snapshot).safeParse(normalizeWorkWeeklyGeneratedIds(input.response));
  if (!parsed.success) {
    throw new WorkWeeklyProviderError("work_weekly_synthesizer_output_invalid");
  }
  const allowlist = new Set(input.snapshot.allowlistedSourceRefs);
  if (parsed.data.items.some((item) => item.claims.some((claim) =>
    claim.sourceRefs.some((ref) => !allowlist.has(ref))
  ))) {
    throw new WorkWeeklyProviderError("work_weekly_source_not_allowlisted");
  }
  return parsed.data.items;
}

function verifierIdentityCounts(expected: string[], actual: string[]) {
  const expectedIds = new Set(expected);
  const actualIds = new Set(actual);
  return {
    expectedCount: expected.length,
    actualCount: actual.length,
    inputDuplicateCount: expected.length - expectedIds.size,
    duplicateCount: actual.length - actualIds.size,
    missingCount: [...expectedIds].filter((id) => !actualIds.has(id)).length,
    unknownCount: [...actualIds].filter((id) => !expectedIds.has(id)).length
  };
}

function rejectWeeklyVerifierContract(
  code: "work_weekly_verifier_output_invalid" | "work_weekly_verifier_source_not_allowed"
    | "work_weekly_coverage_output_invalid" | "work_weekly_coverage_source_unrelated",
  reason: "verdict_schema" | "generation_response_schema" | "input_claim_ids" | "verdict_count"
    | "verdict_claim_ids" | "verdict_source_subset" | "supported_verdict_without_sources"
    | "coverage_schema" | "coverage_source_set" | "coverage_claim_ids"
    | "coverage_source_relation" | "coverage_status_contract" | "dispute_contract" | "coverage_match_contract",
  counts: Record<string, number>,
  schemaError?: ZodError
): never {
  // Zod codes and our numeric counters only. Never serialize issue messages,
  // paths, unknown IDs, sourceRefs, provider enum values or response content.
  const schemaIssueCounts: Record<string, number> = {};
  for (const issue of schemaError?.issues ?? []) {
    schemaIssueCounts[issue.code] = (schemaIssueCounts[issue.code] ?? 0) + 1;
  }
  console.error(JSON.stringify({ component: "work-weekly-verifier-contract", errorCode: code,
    reason, ...counts, ...(schemaError ? { schemaIssueCounts } : {}) }));
  throw new WorkWeeklyProviderError(code);
}

export function validateWorkWeeklyVerifierOutput(input: {
  response: unknown;
  claims: WorkWeeklyGeneratedClaim[];
}) {
  const parsed = WorkWeeklyVerifierResponseSchema.safeParse(input.response);
  if (!parsed.success) rejectWeeklyVerifierContract("work_weekly_verifier_output_invalid", "verdict_schema",
    { expectedCount: input.claims.length }, parsed.error);
  const claimById = new Map(input.claims.map((claim) => [claim.id, claim]));
  const counts = verifierIdentityCounts(input.claims.map((claim) => claim.id), parsed.data.items.map((item) => item.claimId));
  if (counts.inputDuplicateCount) {
    rejectWeeklyVerifierContract("work_weekly_verifier_output_invalid", "input_claim_ids", counts);
  }
  if (counts.actualCount !== counts.expectedCount) {
    rejectWeeklyVerifierContract("work_weekly_verifier_output_invalid", "verdict_count", counts);
  }
  if (counts.duplicateCount || counts.unknownCount || counts.missingCount) {
    rejectWeeklyVerifierContract("work_weekly_verifier_output_invalid", "verdict_claim_ids", counts);
  }
  const unsupportedRefCount = parsed.data.items.reduce((count, item) => count
    + item.supportedSourceRefs.filter((ref) => !claimById.get(item.claimId)!.sourceRefs.includes(ref)).length, 0);
  if (unsupportedRefCount) {
    rejectWeeklyVerifierContract("work_weekly_verifier_source_not_allowed", "verdict_source_subset", { ...counts, unsupportedRefCount });
  }
  const emptySupportedCount = parsed.data.items.filter((item) =>
    (item.verdict === "entailed" || item.verdict === "partially_entailed") && item.supportedSourceRefs.length === 0).length;
  if (emptySupportedCount) {
    rejectWeeklyVerifierContract("work_weekly_verifier_output_invalid", "supported_verdict_without_sources", { ...counts, emptySupportedCount });
  }
  return parsed.data.items;
}

const SYNTHESIZER_SYSTEM_PROMPT = [
  "你是 Work Weekly Synthesizer。只用当前账号/自然周/项目的 Source Pack，生成待独立核验的周回顾；不得引入用户编辑、历史回答、其他产品或一般知识，不创建Todo/Memory等记录。",
  "sources按canonical Finding及其supportingEvidence成组。先围绕Finding.body的主要事项组织，再用同组Evidence补细节，避免只抽背景而漏当前安排。generationGuidance是现有canonical类型的解释，不是新Evidence；原话称‘决定’而canonical mode为proposal时仍按拟议事项表达。",
  "每item恰好1个自足claim；详细条目围绕一个主题，结论与改变该结论的条件同句核验。overview可概括多个主题，每个分句分别有据，不把整体概括为已确认/已完成，也不重复详细条目清单。",
  "保留主要事项、决定与范围取舍、变化前后、关键日期、未决依赖及有意义的后续关注；合并重复来源并保留必要引用，不以固定字数/条数凑完整。按范围读摘要：‘首轮取消某功能’可由‘本轮不交付、以后重评’精确表达，不等于永久取消需求；只有实质矛盾才说明冲突。claim.text是正式内容，item.text仅为摘要元数据。",
  "只保留影响所述结论的必要限定，可自然改写，不要求逐字复述。决定仍待确认就不能肯定化；不陈述发言者/认领人时无需附加归属待确认，不涉及非关键日期时无需重复日期附注。重要排期和前后变化不能因此省略。",
  "提议不是决定，分配不是承诺。proposal即使包含认领、计划日期或行动措辞，也不能直接标为decision/commitment；可以用fact如实报告某方案仍是提议，不因来源为proposal而遗漏。认领/拟安排不等于已开始/已推进。试点暂不提供不能概括为取消需求。日期不自动为deadline，先后不是因果，同会议派生多源不是独立频率。",
  "任务是否已接受与日期是否确定是两个独立事实。按generationGuidance.deadlineStatus读取canonical截止附注：已接受任务仍应保留，未确认日期若重要就明确待确认，也可省略日期；不能把整个已接受任务降成提议，也不能把原日期表达写成确定期限。",
  "userConfirmedAt确认的是记录；Provider视图已按canonical待确认注记统一effectiveFinality。决定自身待确认不是无法描述，用暂定/是否定案尚待确认等表达即可；本轮范围、后续评估与恢复条件和决定一起说明。",
  "章节按含义选择：decisions记录有据的决定、已同意的安排及变化；progress/in_progress须描述实际发生的推进或开展状态；提议和未接受分配放open_questions，缺少外部输入放waiting_for_others。不能为了填栏把计划放进展。",
  "completed只对应currentWeekCompletionSourceRefs中的本周todo.completed，写明在系统中标记完成，不代表现实履行。没有事件此栏为空。",
  "next_week精选有用的关注对象及有据缺口，不派负责人、不造期限、不写催办指令；发布端添加固定AI建议关注前缀。完整回顾不要求每个open_question再写一条关注，已表达清楚的事项可以不重复；无真实缺口时可空，不固定建议条数。",
  "以observedThrough为观察日；recordContext.meetingDate只是记录时间，活动时间按正文解释。overview概括主题和确定程度，不重复细节；每个分句只用自己的sourceRefs，不从相邻未引用记录添时间或人物。",
  "以下是表达示例，不是本周Evidence：来源‘暂用提醒方案，试点后根据反馈评估是否恢复，决定仍待确认’可写‘暂按该方案试点，是否定案尚待确认；试点后依据反馈再评估恢复’，不能删后半句。",
  "混合来源示例：同一主题有暂定安排和另一项提议，可用fact写‘甲安排暂定；乙仍是提议’，或分别表达，不将整个组合标成已决定。角色示例：‘组织者只安排测试和保存观察，技术结论由林工给出’，保留两个明确主语，不改成‘林工给出结论，其只负责组织’。",
  "时间示例：本周记录‘上周人工观察了两次’是历史背景，可用于说明本轮安排的依据，不是in_progress；已经过的检查日写‘原计划周二检查，暂无后续结果’，不写未来等待。",
  "验证范围示例：来源‘仅检查单机流程，并发写入和故障恢复尚未验证’应保留已验范围与具体未验风险，而不缩成‘是否发布待定’；这些实质缺口比未涉及人物的归属尾注更重要。"
].join("\n");

const VERIFIER_SYSTEM_PROMPT = [
  "你是独立的 Work Weekly Claim Verifier。每个claim只用自己的sources核验；publicationContext不是 Evidence，coverageSources也不扩充逐claim证据。sourceQualifications是该引用所关联canonical Finding的解释限制，可约束确定性/类型，不能用于引入sources没有支持的新事实或扩大supportedSourceRefs。",
  "先核验claim实际陈述的命题：分句有据且没有丢掉会改变该命题的条件即可entailed，不要求一条概览或关注独自复述整个来源。未陈述负责人身份/接受情况就不要求人名尾注，未陈述非关键日期就不要求日期附注；来源本身仍缺的重要内容另在整组coverage审查。实际命题升格或必要限定丢失才partially_entailed/相应issue。",
  "检查实际语义而非claimType标签：fact可以报告‘某方案仍是提议’，不表示方案已成事实或决定。来源是proposal而claim保留拟议状态时应核验为有据陈述；只有句义实际升级成已决定/已承诺才拒绝。issue应对应实际错误分句的断言及来源只支持的含义，不能只用类型名称不一致解释claim_type_mismatch。assignment_without_acceptance不是接受，Todo completed仅是系统状态；日期不是自动deadline，顺序不是causality，同会议多条派生记录不是独立frequency。",
  "任务接受与截止确认独立核验：已接受任务可以连同‘日期尚待确认’一起entailed，或不提未确认日期；把日期肯定化才是该日期分句的问题。不能因截止未确认而拒绝已有据的任务本身。拒绝后不自行改写原句或补发核对。",
  "Provider视图以effectiveFinality统一canonical注记。decision_finality_conflict检查claim是否擅自增强确定性，不是在标记来源自己待确认；claim写‘该决定是否最终尚待确认’已经正确保留这一限定，不要求改成固定用词。仍须分别检查后续评估等其他必要内容，不能由最终性正确推断整条完整。",
  "按publicationContext.section核验：progress/in_progress需本周实际推进/截至观察日已开展的状态，只有上周发生的观察不证明现在还在开展；记录会议在本周也不改变历史活动时间。分工、未来计划或open Todo不足，不满足用section_mismatch。decisions可包含有据的已同意安排。",
  "overview允许多个主题的简洁概括，各分句分别有据且保留必要限定即可，不仅因多主题报mixed_topics。详细条目才要求单主题；依赖另一个claim才能保留必要条件用non_atomic_claim，无关主题拼接用mixed_topics。",
  "next_week核验具体关注对象和有据缺口，不能新增owner/deadline/承诺/指令；对象不清或缺口无据用invalid_attention_target。固定AI建议关注前缀不属于用户承诺。completed仍需当前周且不晚于observedThrough的todo.completed事件及系统标记完成语义。",
  "coverageSources就地列出canonical源、证据和candidateClaims的正文/章节。relationship只标明direct_record、direct_evidence、shared_evidence或todo_history关系，不证明内容完整。以源body的主要事项为目标，先取本轮entailed且无issue、支持引用仍关联的候选，再审查其联合内容；不要以单条候选是否完整决定整组status。",
  "coverage显式返回claimIds和matches，只选择真正表达该sourceText主要事项及必要限定的安全claim。每个match逐字摘出sourceText与claim.text中含义对应的短分句；先比较两个分句的主题、动作、确定性和条件，再判断其联合内容是否covered。同一Evidence可含多个不同主题，shared_evidence及其他relationship均不是语义覆盖；不得把有关联的所有claim填进claimIds。若认为partial，先检查所缺含义是否已在该组其他安全条目中。被拒冗余条目不影响已有完整表达，历史背景/共享Evidence细节却不能替代缺失的当前安排。真正部分缺失用partial，整主题缺失用omitted。",
  "重复来源可not_applicable/duplicate，并与本轮全部entailed无issue内容作语义比较；无候选或无共享Evidence也可比较，但须完整承载主要含义、没有实质差异，不能扩大逐claim引用。真正背景或周外无当前影响可background_only/outside_week，不以此掩盖当前未决事项。",
  "next_week是精选关注而非逐源必填栏目；重要内容已在安全回顾中完整表达时，不因没有另写关注而降低coverage。无负责人陈述的简要缺口描述不需要复写人名限制。",
  "以下是核验示例，不是Evidence：来源‘本轮拟人工巡检两次，不承诺长期承担，结束后再评估’，候选仅‘此前做过一次人工巡检’可以是有据背景，但覆盖仍partial/missing_key_content；加入本轮安排、非长期承诺和重评条件才完整。来源‘仅验单机，并发与恢复未验’若只剩‘是否发布待定’，也遗漏了实质验证风险。",
  "含义比较：‘首轮取消交付’与‘本轮不提供、以后重评’可兼容，不强迫重复矛盾尾注；‘永久取消需求’与‘需求保留’才冲突。组织与技术判断若有不同主体，代词不能把两者合成一人；无当前进展证据的历史背景不能靠错放章节变成进展。",
  "来源不足返回unsupported、contradicted或unverifiable；issueCodes非空或partially_entailed均不发布。核验失败不触发追加调用或反复改写。"
].join("\n");

export const WORK_WEEKLY_SYNTHESIZER_JSON_INSTRUCTION =
  "输出严格 JSON {items:[{id,section,text,itemType,claims:[{id,text,claimType,sourceRefs}]}]}。" +
  `section 只能是 ${JSON.stringify(WorkWeeklySectionKindSchema.options)}；` +
  `itemType 只能是 ${JSON.stringify(WORK_WEEKLY_ITEM_TYPES)}；` +
  `claimType 只能是 ${JSON.stringify(WorkWeeklyClaimTypeSchema.options)}。` +
  "section、itemType、claimType是三个不同字段，禁止把section或itemType的值用于claimType。" +
  "普通来源事实使用claimType=fact；风险、提议、解释或下周关注项也不能自创claimType。" +
  "next_week的唯一claim.text同时写具体关注对象和已有来源支持的事实缺口，用fact或其他已列出的事实类型；item.text仅为非权威摘要，正式显示不使用它。不要在claim中重复AI建议关注前缀或把建议动作冒充事实。" +
  "按主题合并重复信息，同一事实不必在多个section重复列出；每个claim只引用直接支持它的必要sourceRefs。" +
  "输出紧凑JSON，省略缩进和多余空白，必须闭合全部括号并保留完整结尾。" +
  "最多64个items，Weekly生成每个item恰好1个自足claim（最终性/条件/例外不能另拆），每个claim有1至64个不重复sourceRefs。" +
  "section必须来自generationContract.allowedSections；completed引用仅可用currentWeekCompletionSourceRefs中的真实本周完成事件，集合为空时禁止completed。" +
  "item与claim的id是本轮临时标记，使用非空短字符串；本地会统一编号后交给核对器。" +
  "section=next_week当且仅当itemType=suggestion，其他section不得使用suggestion。" +
  "id、text以及sourceRefs中的每个元素均为非空字符串；sourceRefs只能来自输入Source Pack；禁止quote或额外字段。";

export const WORK_WEEKLY_VERIFIER_JSON_INSTRUCTION =
  "输出严格 JSON {items:[{claimId,verdict,issueCodes,supportedSourceRefs}]}。" +
  `verdict只能是${JSON.stringify(WorkWeeklyClaimVerdictSchema.options)}。` +
  "每个输入claim恰好一项且claimId不重复；issueCodes为字符串数组，无问题时返回[]。" +
  "逐字复制verificationContract.expectedClaimIds，不得使用item.id、sourceRef或重新编号；items数量必须等于expectedVerdictCount，即使unsupported/contradicted/unverifiable也必须保留该claim的核验项。" +
  "supportedSourceRefs为不重复字符串数组，只能是该claim引用来源的子集；" +
  "entailed或partially_entailed必须有至少一个supportedSourceRef；禁止额外字段。";

export const WORK_WEEKLY_GENERATION_VERIFIER_JSON_INSTRUCTION =
  WORK_WEEKLY_VERIFIER_JSON_INSTRUCTION.replace("{items:[{claimId,verdict,issueCodes,supportedSourceRefs}]}",
    "{items:[{claimId,verdict,issueCodes,supportedSourceRefs}],disputes:[{claimId,issueCode,claimExcerpt,explanation}],coverage:[{sourceRef,status,reasonCode,claimIds,matches:[{claimId,sourceExcerpt,claimExcerpt}]}]}") +
  "disputes必需，无争议为[]；每个非entailed判词必须有issueCodes，每个issueCode对应至少一个dispute，claimId和issueCode逐字对应items。claimExcerpt必须是该claim.text非空原文子串；explanation说明实际句义的错误，不能仅说fact标签不等于proposal。该定位只作私有诊断，不发布也不改写claim。" +
  "coverage是必需字段，每个coverageSources恰好一项，sourceRef仅来自该集合；status只能covered/partial/omitted/not_applicable。" +
  "covered用reasonCode=covered；partial/omitted用missing_key_content或missing_qualification；" +
  "not_applicable用duplicate或background_only/outside_week。claimIds只选择联合承载该来源含义的entailed且issueCodes为空的claim；covered/duplicate必须非空，omitted/background_only/outside_week为[]。" +
  "matches与claimIds选中集合完全一致；每个match的sourceExcerpt是该sourceText逐字子串，claimExcerpt是对应claim.text逐字子串，不能只摘两边共有的空泛词。重复来源也要定位同义承载。没有选中claim时matches=[]；这些片段不生成新引用或替代逐claim核验。";

export interface WorkWeeklySynthesizer {
  readonly profile: WorkWeeklyProviderProfile;
  synthesize(input: {
    accountId: string;
    snapshot: WorkWeeklySourceSnapshot;
    signal?: AbortSignal;
  }): Promise<WorkWeeklyGeneratedItem[]>;
}

export interface WorkWeeklyClaimVerifier {
  readonly profile: WorkWeeklyProviderProfile;
  verify(input: {
    accountId: string;
    snapshot: WorkWeeklySourceSnapshot;
    claims: WorkWeeklyGeneratedClaim[];
    /** Generation-only publication context; never an additional evidence source. */
    items?: WorkWeeklyGeneratedItem[];
    /** Opt-in full-review audit in the same request; QA's claim-only contract stays unchanged. */
    onCoverage?: (coverage: WorkWeeklyCoverageAssessment[]) => void;
    /** Private diagnostics only. Never publish these model explanations. */
    onAuditDetails?: (details: WorkWeeklyVerificationAuditDetails) => void;
    signal?: AbortSignal;
  }): Promise<WorkWeeklyVerifierItem[]>;
}

export function createStructuredWorkWeeklySynthesizer(input: {
  profile: WorkWeeklyProviderProfile;
  requestStructuredJson?: WorkWeeklyStructuredJsonRequest;
}): WorkWeeklySynthesizer {
  if (input.profile.role !== "synthesizer" || input.profile.provider === "fixture") {
    throw new WorkWeeklyProviderError("work_weekly_synthesizer_profile_invalid");
  }
  const request = input.requestStructuredJson ?? requestWorkWeeklyStructuredJson;
  return {
    profile: input.profile,
    async synthesize(call) {
      const snapshot = assertWorkWeeklySnapshotAuthority(call);
      const response = await request({
        profile: input.profile,
        schema: buildWorkWeeklySynthesisResponseSchema(snapshot),
        requestInput: [
          { role: "system", content: SYNTHESIZER_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(buildWorkWeeklySynthesisPack(call)) }
        ],
        jsonInstruction: WORK_WEEKLY_SYNTHESIZER_JSON_INSTRUCTION,
        normalize: normalizeWorkWeeklyGeneratedIds,
        signal: call.signal
      });
      return validateGeneratedItems({ response, snapshot });
    }
  };
}

export function createStructuredWorkWeeklyClaimVerifier(input: {
  profile: WorkWeeklyProviderProfile;
  requestStructuredJson?: WorkWeeklyStructuredJsonRequest;
}): WorkWeeklyClaimVerifier {
  if (input.profile.role !== "verifier" || input.profile.provider === "fixture") {
    throw new WorkWeeklyProviderError("work_weekly_verifier_profile_invalid");
  }
  const request = input.requestStructuredJson ?? requestWorkWeeklyStructuredJson;
  return {
    profile: input.profile,
    async verify(call) {
      const snapshot = assertWorkWeeklySnapshotAuthority(call);
      const allowlist = new Set(snapshot.allowlistedSourceRefs);
      if (call.claims.some((claim) => claim.sourceRefs.some((ref) => !allowlist.has(ref)))) {
        throw new WorkWeeklyProviderError("work_weekly_source_not_allowlisted");
      }
      const verificationClaim = (claim: WorkWeeklyGeneratedClaim) => call.onCoverage
        ? { id: claim.id, text: claim.text, sourceRefs: claim.sourceRefs } : claim;
      const response = await request({
        profile: input.profile,
        schema: call.onCoverage ? WorkWeeklyGenerationVerifierResponseSchema : WorkWeeklyVerifierResponseSchema,
        requestInput: [
          { role: "system", content: VERIFIER_SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              snapshotDigest: snapshot.digest,
              scope: snapshot.scope,
              verificationContract: {
                expectedVerdictCount: call.claims.length,
                expectedClaimIds: call.claims.map((claim) => claim.id),
                ...(call.onCoverage ? {
                  expectedCoverageCount: workWeeklyCoverageSourceRefs(snapshot).length,
                  expectedCoverageSourceRefs: workWeeklyCoverageSourceRefs(snapshot)
                } : {})
              },
              ...(call.onCoverage ? { coverageSources: workWeeklyCoverageSourceRefs(snapshot).map((ref) => {
                const finding = snapshot.findings.find((item) => item.sourceRef === ref);
                return { source: sourceRecords(snapshot, [ref])[0], sourceText: workWeeklyCoverageSourceText(snapshot, ref),
                  evidence: sourceRecords(snapshot, finding?.evidenceRefs ?? []),
                  candidateClaims: call.claims.flatMap((claim) => {
                    const relationship = coverageClaimRelationship(snapshot, ref, claim.sourceRefs);
                    if (!relationship) return [];
                    const item = call.items?.find((item) => item.claims.some((entry) => entry.id === claim.id));
                    return [{ claim: verificationClaim(claim), relationship, ...(item ? { section: item.section, itemType: item.itemType } : {}) }];
                  }) };
              }) } : {}),
              items: call.claims.map((claim) => {
                const item = call.items?.find((item) => item.claims.some((entry) => entry.id === claim.id));
                return {
                  claim: verificationClaim(claim),
                  sources: sourceRecords(snapshot, claim.sourceRefs),
                  sourceQualifications: snapshot.findings.filter((finding) => claim.sourceRefs.includes(finding.sourceRef)
                    || finding.evidenceRefs.some((ref) => claim.sourceRefs.includes(ref)))
                    .map((finding) => ({ sourceRef: finding.sourceRef, body: finding.body,
                      generationGuidance: findingProviderView(finding).generationGuidance })),
                  ...(item ? { publicationContext: {
                    section: item.section,
                    itemType: item.itemType,
                    siblingClaims: item.claims.map(({ id, text }) => ({ id, text }))
                  } } : {})
                };
              })
            })
          }
        ],
        jsonInstruction: call.onCoverage ? WORK_WEEKLY_GENERATION_VERIFIER_JSON_INSTRUCTION : WORK_WEEKLY_VERIFIER_JSON_INSTRUCTION,
        signal: call.signal
      });
      if (call.onCoverage) {
        const parsed = WorkWeeklyGenerationVerifierResponseSchema.safeParse(response);
        if (!parsed.success) rejectWeeklyVerifierContract("work_weekly_verifier_output_invalid", "generation_response_schema",
          { expectedVerdictCount: call.claims.length, expectedCoverageCount: workWeeklyCoverageSourceRefs(snapshot).length }, parsed.error);
        const verdicts = validateWorkWeeklyVerifierOutput({ response: { items: parsed.data.items }, claims: call.claims });
        const diagnosticEntries = (value: unknown): unknown[] => Array.isArray(value) ? value : value == null ? [] : [value];
        const rawDisputes = diagnosticEntries(parsed.data.disputes);
        const rawMatches = parsed.data.coverage.map((entry) => ({ sourceRef: entry.sourceRef, claimIds: entry.claimIds,
          matches: diagnosticEntries(entry.matches) }));
        const unknownDiagnosticIds = [...rawDisputes, ...rawMatches.flatMap((entry) => entry.matches)]
          .filter((entry) => entry !== null && typeof entry === "object" && "claimId" in entry
            && typeof entry.claimId === "string" && !call.claims.some((claim) => claim.id === entry.claimId)).length;
        if (unknownDiagnosticIds) rejectWeeklyVerifierContract("work_weekly_verifier_output_invalid", "dispute_contract", { unknownDiagnosticIds });
        const disputes = rawDisputes.flatMap((value) => {
          const parsedDispute = WorkWeeklyVerificationDisputeSchema.safeParse(value);
          return parsedDispute.success ? [parsedDispute.data] : [];
        }).filter((dispute) => {
          const verdict = verdicts.find((entry) => entry.claimId === dispute.claimId);
          const claim = call.claims.find((entry) => entry.id === dispute.claimId);
          return verdict?.issueCodes.includes(dispute.issueCode) && claim?.text.includes(dispute.claimExcerpt);
        });
        const coverage = validateWorkWeeklyCoverage({
          coverage: parsed.data.coverage.map(({ matches: _matches, ...entry }) => entry), snapshot, claims: call.claims,
          localizeMappingErrors: true
        });
        const coverageMatches = rawMatches.map((entry) => ({ sourceRef: entry.sourceRef,
          matches: entry.matches.flatMap((value) => {
            const parsedMatch = WorkWeeklyCoverageMatchSchema.safeParse(value);
            return parsedMatch.success ? [parsedMatch.data] : [];
          }).filter((match) => entry.claimIds.includes(match.claimId)
            && workWeeklyCoverageSourceText(snapshot, entry.sourceRef).includes(match.sourceExcerpt)
            && call.claims.find((claim) => claim.id === match.claimId)?.text.includes(match.claimExcerpt)) }));
        // Excerpts help inspect the semantic decision; they neither establish
        // entailment nor veto safe siblings when punctuation/segmentation differs.
        call.onAuditDetails?.({ disputes, coverageMatches,
          discardedDiagnosticCount: rawDisputes.length - disputes.length
            + rawMatches.reduce((count, entry) => count + entry.matches.length, 0)
            - coverageMatches.reduce((count, entry) => count + entry.matches.length, 0) });
        // Preserve the semantic selection, including any selected claim later
        // filtered by policy. Never substitute a merely related safe claim.
        call.onCoverage(coverage);
        return verdicts;
      }
      return validateWorkWeeklyVerifierOutput({ response, claims: call.claims });
    }
  };
}

export function createConfiguredWorkWeeklyAiProviders(input: {
  env?: RuntimeEnv;
  requestStructuredJson?: WorkWeeklyStructuredJsonRequest;
} = {}) {
  return {
    synthesizer: createStructuredWorkWeeklySynthesizer({
      profile: resolveWorkWeeklyProviderProfile("synthesizer", input.env),
      requestStructuredJson: input.requestStructuredJson
    }),
    verifier: createStructuredWorkWeeklyClaimVerifier({
      profile: resolveWorkWeeklyProviderProfile("verifier", input.env),
      requestStructuredJson: input.requestStructuredJson
    })
  };
}
