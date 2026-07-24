import {
  APIConnectionError,
  APIConnectionTimeoutError,
  ContentFilterFinishReasonError,
  InternalServerError,
  LengthFinishReasonError,
  RateLimitError
} from "openai/error";
import { ZodError } from "zod";

import {
  StructuredJsonResponseError,
  type StructuredJsonDiagnostics
} from "@/lib/server/openai/structured-json";

export const DAILY_BRIEF_FAILURE_CODES = [
  "deadline",
  "network_error",
  "fetch_timeout",
  "provider_5xx",
  "rate_limit",
  "empty_response",
  "incomplete_response",
  "max_output_tokens",
  "invalid_json",
  "validation_failure",
  "evidence_validation_failure",
  "content_filter",
  "unknown_provider_error"
] as const;

export type DailyBriefFailureCode = (typeof DAILY_BRIEF_FAILURE_CODES)[number];

export const DAILY_BRIEF_FAILURE_PHASES = [
  "request",
  "provider_wait",
  "provider_response",
  "parse",
  "validation",
  "evidence_validation"
] as const;

export type DailyBriefFailurePhase = (typeof DAILY_BRIEF_FAILURE_PHASES)[number];

export const DAILY_BRIEF_MAX_RETRY_AFTER_MS = 30_000;
const MAX_VALIDATION_ISSUES = 10;

type DailyBriefStructuredDiagnostics = StructuredJsonDiagnostics & {
  providerErrorCode?: unknown;
};

export type DailyBriefFailureContext = {
  diagnostics?: DailyBriefStructuredDiagnostics;
  totalDeadlineAborted?: boolean;
  requestStarted?: boolean;
  nowMs?: number;
};

export type DailyBriefFailureClassification = {
  failureCode: DailyBriefFailureCode;
  failurePhase: DailyBriefFailurePhase;
  retryable: boolean;
  compactRecovery: boolean;
  errorName: string;
  httpStatus?: number;
  providerCode?: string;
  retryAfterMs?: number;
  retryAfterCapped?: boolean;
};

export type DailyBriefRetryAfter = {
  retryAfterMs?: number;
  retryAfterCapped: boolean;
};

export type DailyBriefValidationLogFields = {
  validationIssueCount: number;
  validationIssueCodes: string[];
  validationIssuePaths: string[];
  validationIssuesTruncated: boolean;
};

export type DailyBriefValidationCheckpointSummary = {
  validationIssueCount: number;
  validationIssueSummary: Array<{ code: string; count: number }>;
  validationIssuesTruncated: boolean;
};

function safeCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1_000_000, Math.max(0, Math.trunc(value)))
    : 0;
}

export class DailyBriefEvidenceValidationError extends Error {
  readonly invalidReferenceCount: number;
  readonly rejectedItemCount: number;

  constructor(input: { invalidReferenceCount?: number; rejectedItemCount?: number } = {}) {
    super("Daily Brief evidence validation failed");
    this.name = "DailyBriefEvidenceValidationError";
    this.invalidReferenceCount = safeCount(input.invalidReferenceCount);
    this.rejectedItemCount = safeCount(input.rejectedItemCount);
  }
}

const KNOWN_ERROR_NAMES = new Set([
  "AbortError",
  "APIConnectionError",
  "APIConnectionTimeoutError",
  "APIError",
  "APIUserAbortError",
  "AuthenticationError",
  "BadRequestError",
  "ConflictError",
  "ContentFilterFinishReasonError",
  "ChunkAttemptTimeoutError",
  "DailyBriefBudgetError",
  "DailyBriefEvidenceValidationError",
  "DailyBriefProviderFailureError",
  "Error",
  "InternalServerError",
  "LengthFinishReasonError",
  "NotFoundError",
  "PermissionDeniedError",
  "RateLimitError",
  "StructuredJsonResponseError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "UnprocessableEntityError",
  "ZodError"
]);

const KNOWN_PROVIDER_CODES = new Set([
  "rate_limit",
  "rate_limit_exceeded",
  "server_error",
  "too_many_requests"
]);

const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT"
]);

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "UND_ERR_SOCKET"
]);

function errorName(error: unknown) {
  if (!error || typeof error !== "object" || !("name" in error) || typeof error.name !== "string") {
    return "UnknownError";
  }
  return KNOWN_ERROR_NAMES.has(error.name) ? error.name : "UnknownError";
}

function objectField(value: unknown, key: string) {
  return value && typeof value === "object" && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function httpStatus(error: unknown) {
  const value = objectField(error, "status");
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function knownProviderCode(value: unknown) {
  return typeof value === "string" && KNOWN_PROVIDER_CODES.has(value)
    ? value
    : undefined;
}

function nestedKnownCode(error: unknown, allowed: Set<string>, depth = 0): string | undefined {
  if (!error || typeof error !== "object" || depth > 3) return undefined;
  const code = objectField(error, "code");
  if (typeof code === "string" && allowed.has(code)) return code;
  return nestedKnownCode(objectField(error, "cause"), allowed, depth + 1);
}

function headerValue(headers: unknown, wantedName: string) {
  if (!headers || typeof headers !== "object") return undefined;
  const getter = objectField(headers, "get");
  if (typeof getter === "function") {
    try {
      const value = getter.call(headers, wantedName);
      if (typeof value === "string") return value.trim();
    } catch {
      return undefined;
    }
  }

  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (name.toLowerCase() !== wantedName.toLowerCase()) continue;
    if (typeof value === "string" || typeof value === "number") return String(value).trim();
    if (Array.isArray(value) && (typeof value[0] === "string" || typeof value[0] === "number")) {
      return String(value[0]).trim();
    }
  }
  return undefined;
}

function finiteNonNegativeNumber(value: string) {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function boundedRetryAfter(milliseconds: number): DailyBriefRetryAfter {
  const safe = Math.max(0, Math.ceil(milliseconds));
  return {
    retryAfterMs: Math.min(safe, DAILY_BRIEF_MAX_RETRY_AFTER_MS),
    retryAfterCapped: safe > DAILY_BRIEF_MAX_RETRY_AFTER_MS
  };
}

export function parseDailyBriefRetryAfter(
  headers: unknown,
  nowMs = Date.now()
): DailyBriefRetryAfter {
  const millisecondsHeader = headerValue(headers, "retry-after-ms");
  if (millisecondsHeader !== undefined) {
    const milliseconds = finiteNonNegativeNumber(millisecondsHeader);
    if (milliseconds !== undefined) return boundedRetryAfter(milliseconds);
  }

  const retryAfterHeader = headerValue(headers, "retry-after");
  if (retryAfterHeader === undefined) return { retryAfterCapped: false };
  const seconds = finiteNonNegativeNumber(retryAfterHeader);
  if (seconds !== undefined) return boundedRetryAfter(seconds * 1_000);

  const date = Date.parse(retryAfterHeader);
  if (!Number.isFinite(date) || date < nowMs) return { retryAfterCapped: false };
  return boundedRetryAfter(date - nowMs);
}

export function isRetryableDailyBriefFailure(code: DailyBriefFailureCode) {
  return [
    "network_error",
    "fetch_timeout",
    "provider_5xx",
    "rate_limit",
    "empty_response",
    "incomplete_response",
    "max_output_tokens",
    "invalid_json"
  ].includes(code);
}

export function shouldUseDailyBriefCompactRecovery(code: DailyBriefFailureCode) {
  return code === "incomplete_response" || code === "max_output_tokens";
}

function baseClassification(input: {
  failureCode: DailyBriefFailureCode;
  failurePhase: DailyBriefFailurePhase;
  error: unknown;
  context: DailyBriefFailureContext;
}): DailyBriefFailureClassification {
  const status = httpStatus(input.error);
  const providerCode = knownProviderCode(input.context.diagnostics?.providerErrorCode)
    ?? knownProviderCode(objectField(input.error, "code"));
  const retryAfter = parseDailyBriefRetryAfter(
    objectField(input.error, "headers"),
    input.context.nowMs
  );
  return Object.freeze({
    failureCode: input.failureCode,
    failurePhase: input.failurePhase,
    retryable: isRetryableDailyBriefFailure(input.failureCode),
    compactRecovery: shouldUseDailyBriefCompactRecovery(input.failureCode),
    errorName: errorName(input.error),
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(retryAfter.retryAfterMs === undefined ? {} : retryAfter)
  });
}

export class DailyBriefProviderFailureError extends Error {
  readonly classification: DailyBriefFailureClassification;

  constructor(classification: DailyBriefFailureClassification) {
    super(`Daily Brief provider failed: ${classification.failureCode}`);
    this.name = "DailyBriefProviderFailureError";
    this.classification = Object.freeze({ ...classification });
  }
}

function isErrorNamed(error: unknown, name: string) {
  return errorName(error) === name;
}

function structuredClassification(
  error: unknown,
  context: DailyBriefFailureContext
): Pick<DailyBriefFailureClassification, "failureCode" | "failurePhase"> | null {
  const incompleteReason = context.diagnostics?.incompleteReason;
  if (incompleteReason === "max_output_tokens") {
    return { failureCode: "max_output_tokens", failurePhase: "provider_response" };
  }
  if (incompleteReason === "content_filter") {
    return { failureCode: "content_filter", failurePhase: "provider_response" };
  }

  if (error instanceof StructuredJsonResponseError) {
    if (error.code === "empty_response") {
      return { failureCode: "empty_response", failurePhase: "provider_response" };
    }
    if (error.code === "incomplete_response") {
      return { failureCode: "incomplete_response", failurePhase: "provider_response" };
    }
    if (error.code === "incomplete_json") {
      return { failureCode: "incomplete_response", failurePhase: "parse" };
    }
    return { failureCode: "invalid_json", failurePhase: "parse" };
  }
  if (context.diagnostics?.responseStatus === "incomplete") {
    return { failureCode: "incomplete_response", failurePhase: "provider_response" };
  }
  return null;
}

export function classifyDailyBriefFailure(
  error: unknown,
  context: DailyBriefFailureContext = {}
): DailyBriefFailureClassification {
  if (
    context.totalDeadlineAborted
    || objectField(error, "code") === "DAILY_BRIEF_DEADLINE"
    || isErrorNamed(error, "DailyBriefBudgetError")
  ) {
    return baseClassification({
      failureCode: "deadline",
      failurePhase: context.requestStarted === false ? "request" : "provider_wait",
      error,
      context
    });
  }
  if (error instanceof DailyBriefProviderFailureError) return error.classification;
  if (error instanceof DailyBriefEvidenceValidationError) {
    return baseClassification({
      failureCode: "evidence_validation_failure",
      failurePhase: "evidence_validation",
      error,
      context
    });
  }

  const structured = structuredClassification(error, context);
  if (structured) return baseClassification({ ...structured, error, context });
  if (error instanceof LengthFinishReasonError || isErrorNamed(error, "LengthFinishReasonError")) {
    return baseClassification({
      failureCode: "max_output_tokens",
      failurePhase: "provider_response",
      error,
      context
    });
  }
  if (error instanceof ContentFilterFinishReasonError || isErrorNamed(error, "ContentFilterFinishReasonError")) {
    return baseClassification({
      failureCode: "content_filter",
      failurePhase: "provider_response",
      error,
      context
    });
  }
  if (error instanceof ZodError || context.diagnostics?.validationResult === "failed") {
    return baseClassification({
      failureCode: "validation_failure",
      failurePhase: "validation",
      error,
      context
    });
  }
  if (context.diagnostics?.parseResult === "failed") {
    return baseClassification({
      failureCode: "invalid_json",
      failurePhase: "parse",
      error,
      context
    });
  }
  if (error instanceof SyntaxError || isErrorNamed(error, "SyntaxError")) {
    return baseClassification({
      failureCode: "invalid_json",
      failurePhase: "parse",
      error,
      context
    });
  }

  const status = httpStatus(error);
  const timeoutCode = nestedKnownCode(error, TIMEOUT_CODES);
  if (
    error instanceof APIConnectionTimeoutError
    || status === 408
    || timeoutCode
    || [
      "AbortError",
      "APIConnectionTimeoutError",
      "APIUserAbortError",
      "ChunkAttemptTimeoutError",
      "TimeoutError"
    ].includes(errorName(error))
  ) {
    return baseClassification({
      failureCode: "fetch_timeout",
      failurePhase: "provider_wait",
      error,
      context
    });
  }

  const providerCode = knownProviderCode(context.diagnostics?.providerErrorCode)
    ?? knownProviderCode(objectField(error, "code"));
  if (error instanceof RateLimitError || status === 429 || ["rate_limit", "rate_limit_exceeded", "too_many_requests"].includes(providerCode ?? "")) {
    return baseClassification({
      failureCode: "rate_limit",
      failurePhase: "provider_response",
      error,
      context
    });
  }
  if (error instanceof InternalServerError || (status !== undefined && status >= 500) || providerCode === "server_error") {
    return baseClassification({
      failureCode: "provider_5xx",
      failurePhase: "provider_response",
      error,
      context
    });
  }
  if (error instanceof APIConnectionError || nestedKnownCode(error, NETWORK_CODES)) {
    return baseClassification({
      failureCode: "network_error",
      failurePhase: "request",
      error,
      context
    });
  }
  return baseClassification({
    failureCode: "unknown_provider_error",
    failurePhase: status === undefined ? "request" : "provider_response",
    error,
    context
  });
}

export function wrapDailyBriefProviderFailure(
  error: unknown,
  context: DailyBriefFailureContext = {}
) {
  if (error instanceof DailyBriefProviderFailureError && !context.totalDeadlineAborted) return error;
  return new DailyBriefProviderFailureError(classifyDailyBriefFailure(error, context));
}

const ZOD_CODES = new Set([
  "custom",
  "invalid_date",
  "invalid_enum_value",
  "invalid_intersection_types",
  "invalid_literal",
  "invalid_string",
  "invalid_type",
  "invalid_union",
  "invalid_union_discriminator",
  "missing_field",
  "not_finite",
  "not_multiple_of",
  "too_big",
  "too_small",
  "unrecognized_keys"
]);

function safeZodCode(value: unknown) {
  return typeof value === "string" && ZOD_CODES.has(value) ? value : "unknown_validation_issue";
}

function zodCode(issue: ZodError["issues"][number]) {
  return issue.code === "invalid_type" && issue.received === "undefined"
    ? "missing_field"
    : safeZodCode(issue.code);
}

function safePath(path: Array<string | number>) {
  if (path.length === 0) return "$";
  let result = "";
  for (const part of path) {
    if (typeof part === "number") {
      result += `[${Math.max(0, Math.trunc(part))}]`;
      continue;
    }
    const safe = part.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64) || "unknown";
    result += result ? `.${safe}` : safe;
  }
  return result.slice(0, 240);
}

type SafeValidationIssue = { code: string; path: string };

function validationIssues(input: ZodError | StructuredJsonDiagnostics | undefined) {
  if (input instanceof ZodError) {
    const issues = input.issues.slice(0, MAX_VALIDATION_ISSUES).map((issue): SafeValidationIssue => ({
      code: zodCode(issue),
      path: safePath(issue.path)
    }));
    return { issues, count: input.issues.length, truncated: input.issues.length > MAX_VALIDATION_ISSUES };
  }
  const issues = (input?.validationIssues ?? []).slice(0, MAX_VALIDATION_ISSUES).map((issue) => ({
    code: safeZodCode(issue.code),
    path: safePath(issue.path === "$" ? [] : issue.path
      .replace(/\[(\d+)\]/gu, ".$1")
      .split(".")
      .filter(Boolean)
      .map((part) => /^\d+$/u.test(part) ? Number(part) : part))
  }));
  return {
    issues,
    count: safeCount(input?.validationIssueCount ?? issues.length),
    truncated: input?.validationIssuesTruncated === true
      || safeCount(input?.validationIssueCount ?? issues.length) > issues.length
  };
}

export function buildDailyBriefValidationLogFields(
  input: ZodError | StructuredJsonDiagnostics | undefined
): DailyBriefValidationLogFields {
  const result = validationIssues(input);
  return {
    validationIssueCount: result.count,
    validationIssueCodes: result.issues.map((issue) => issue.code),
    validationIssuePaths: result.issues.map((issue) => issue.path),
    validationIssuesTruncated: result.truncated
  };
}

export function buildDailyBriefValidationCheckpointSummary(
  input: ZodError | StructuredJsonDiagnostics | undefined
): DailyBriefValidationCheckpointSummary {
  const result = validationIssues(input);
  const counts = new Map<string, number>();
  if (input instanceof ZodError) {
    for (const issue of input.issues) {
      const code = zodCode(issue);
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  } else if (input?.validationIssueSummary) {
    for (const item of input.validationIssueSummary) {
      const code = safeZodCode(item.code);
      counts.set(code, (counts.get(code) ?? 0) + safeCount(item.count));
    }
  } else {
    for (const issue of result.issues) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  }
  const allSummary = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => ({ code, count }));
  return {
    validationIssueCount: result.count,
    validationIssueSummary: allSummary.slice(0, MAX_VALIDATION_ISSUES),
    validationIssuesTruncated: result.truncated || allSummary.length > MAX_VALIDATION_ISSUES
  };
}
