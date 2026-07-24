// @vitest-environment node

import {
  APIConnectionError,
  APIConnectionTimeoutError,
  ContentFilterFinishReasonError,
  InternalServerError,
  LengthFinishReasonError,
  RateLimitError
} from "openai/error";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { StructuredJsonResponseError } from "@/lib/server/openai/structured-json";
import {
  DAILY_BRIEF_FAILURE_CODES,
  DAILY_BRIEF_FAILURE_PHASES,
  DailyBriefEvidenceValidationError,
  DailyBriefProviderFailureError,
  buildDailyBriefValidationCheckpointSummary,
  buildDailyBriefValidationLogFields,
  classifyDailyBriefFailure,
  isRetryableDailyBriefFailure,
  parseDailyBriefRetryAfter,
  shouldUseDailyBriefCompactRecovery,
  wrapDailyBriefProviderFailure
} from "./failure-diagnostics";

function apiError(input: {
  status: number;
  code?: string;
  headers?: Headers;
  name?: string;
}) {
  const error = new Error("provider body may contain private input") as Error & {
    status: number;
    code?: string;
    headers: Headers;
  };
  if (input.name) error.name = input.name;
  error.status = input.status;
  error.code = input.code;
  error.headers = input.headers ?? new Headers();
  return error;
}

describe("Daily Brief provider failure diagnostics", () => {
  it("exposes only the requested stable failure codes and phases", () => {
    expect(DAILY_BRIEF_FAILURE_CODES).toEqual([
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
    ]);
    expect(DAILY_BRIEF_FAILURE_PHASES).toEqual([
      "request",
      "provider_wait",
      "provider_response",
      "parse",
      "validation",
      "evidence_validation"
    ]);
  });

  it("gives the total deadline priority over the underlying failure", () => {
    const result = classifyDailyBriefFailure(new z.ZodError([]), {
      totalDeadlineAborted: true,
      requestStarted: true
    });

    expect(result).toMatchObject({
      failureCode: "deadline",
      failurePhase: "provider_wait",
      retryable: false,
      compactRecovery: false
    });
  });

  it("uses request phase when the total deadline expires before request start", () => {
    expect(classifyDailyBriefFailure(new Error("not sent"), {
      totalDeadlineAborted: true,
      requestStarted: false
    })).toMatchObject({ failureCode: "deadline", failurePhase: "request" });
  });

  it("classifies OpenAI connection and timeout errors without inspecting messages", () => {
    const network = classifyDailyBriefFailure(new APIConnectionError({
      message: "token=secret transcript text",
      cause: new Error("private host")
    }));
    const timeout = classifyDailyBriefFailure(new APIConnectionTimeoutError());

    expect(network).toMatchObject({ failureCode: "network_error", failurePhase: "request" });
    expect(timeout).toMatchObject({ failureCode: "fetch_timeout", failurePhase: "provider_wait" });
  });

  it.each([
    [408, "fetch_timeout", "provider_wait"],
    [429, "rate_limit", "provider_response"],
    [500, "provider_5xx", "provider_response"],
    [503, "provider_5xx", "provider_response"],
    [401, "unknown_provider_error", "provider_response"]
  ] as const)("classifies HTTP %i as %s", (status, failureCode, failurePhase) => {
    expect(classifyDailyBriefFailure(apiError({ status }))).toMatchObject({
      failureCode,
      failurePhase,
      httpStatus: status
    });
  });

  it("classifies provider codes even when the HTTP status is unavailable", () => {
    expect(classifyDailyBriefFailure(Object.assign(new Error("hidden"), {
      code: "rate_limit_exceeded"
    }))).toMatchObject({ failureCode: "rate_limit", providerCode: "rate_limit_exceeded" });
    expect(classifyDailyBriefFailure(new Error("hidden"), {
      diagnostics: {
        responseTextLength: 0,
        parseResult: "not_started",
        validationResult: "not_started",
        providerErrorCode: "server_error"
      }
    })).toMatchObject({ failureCode: "provider_5xx", providerCode: "server_error" });
  });

  it("recognizes OpenAI rate-limit and server-error classes", () => {
    const rateLimit = new RateLimitError(429, { code: "rate_limit_exceeded" }, "hidden", new Headers());
    const server = new InternalServerError(502, { code: "server_error" }, "hidden", new Headers());

    expect(classifyDailyBriefFailure(rateLimit).failureCode).toBe("rate_limit");
    expect(classifyDailyBriefFailure(server).failureCode).toBe("provider_5xx");
  });

  it.each([
    ["empty_response", undefined, "empty_response", "provider_response"],
    ["no_json", undefined, "invalid_json", "parse"],
    ["invalid_json", undefined, "invalid_json", "parse"],
    ["incomplete_json", undefined, "incomplete_response", "parse"],
    ["incomplete_response", undefined, "incomplete_response", "provider_response"],
    ["incomplete_response", "max_output_tokens", "max_output_tokens", "provider_response"],
    ["incomplete_response", "content_filter", "content_filter", "provider_response"]
  ] as const)(
    "maps structured error %s with reason %s",
    (code, incompleteReason, failureCode, failurePhase) => {
      const error = new StructuredJsonResponseError(code, "private provider output");
      expect(classifyDailyBriefFailure(error, {
        diagnostics: {
          responseTextLength: 10,
          parseResult: "not_started",
          validationResult: "not_started",
          ...(incompleteReason ? { incompleteReason } : {})
        }
      })).toMatchObject({ failureCode, failurePhase });
    }
  );

  it("maps SDK length and content filter errors without message matching", () => {
    expect(classifyDailyBriefFailure(new LengthFinishReasonError())).toMatchObject({
      failureCode: "max_output_tokens",
      failurePhase: "provider_response"
    });
    expect(classifyDailyBriefFailure(new ContentFilterFinishReasonError())).toMatchObject({
      failureCode: "content_filter",
      failurePhase: "provider_response"
    });
  });

  it("separates schema and evidence validation failures", () => {
    const schema = z.object({ items: z.array(z.object({ category: z.string() })) });
    const parsed = schema.safeParse({ items: [{}] });
    if (parsed.success) throw new Error("expected Zod failure");
    const evidence = new DailyBriefEvidenceValidationError({
      invalidReferenceCount: 3,
      rejectedItemCount: 2
    });

    expect(classifyDailyBriefFailure(parsed.error)).toMatchObject({
      failureCode: "validation_failure",
      failurePhase: "validation"
    });
    expect(classifyDailyBriefFailure(evidence)).toMatchObject({
      failureCode: "evidence_validation_failure",
      failurePhase: "evidence_validation"
    });
    expect(evidence).toMatchObject({ invalidReferenceCount: 3, rejectedItemCount: 2 });
  });

  it("uses diagnostics as a cross-realm validation and parse fallback", () => {
    expect(classifyDailyBriefFailure(new Error("hidden"), {
      diagnostics: {
        responseTextLength: 10,
        parseResult: "success",
        validationResult: "failed"
      }
    })).toMatchObject({ failureCode: "validation_failure", failurePhase: "validation" });
    expect(classifyDailyBriefFailure(new Error("hidden"), {
      diagnostics: {
        responseTextLength: 10,
        parseResult: "failed",
        validationResult: "not_started"
      }
    })).toMatchObject({ failureCode: "invalid_json", failurePhase: "parse" });
  });

  it("keeps compact recovery limited to incomplete output failures", () => {
    expect(shouldUseDailyBriefCompactRecovery("max_output_tokens")).toBe(true);
    expect(shouldUseDailyBriefCompactRecovery("incomplete_response")).toBe(true);
    for (const code of DAILY_BRIEF_FAILURE_CODES) {
      if (code === "max_output_tokens" || code === "incomplete_response") continue;
      expect(shouldUseDailyBriefCompactRecovery(code)).toBe(false);
    }
  });

  it("marks transient failures retryable without retrying terminal validation or policy failures", () => {
    for (const code of [
      "network_error",
      "fetch_timeout",
      "provider_5xx",
      "rate_limit",
      "empty_response",
      "incomplete_response",
      "max_output_tokens",
      "invalid_json"
    ] as const) {
      expect(isRetryableDailyBriefFailure(code)).toBe(true);
    }
    for (const code of [
      "deadline",
      "validation_failure",
      "evidence_validation_failure",
      "content_filter",
      "unknown_provider_error"
    ] as const) {
      expect(isRetryableDailyBriefFailure(code)).toBe(false);
    }
  });

  it("wraps failures without retaining raw messages, bodies, headers, or causes", () => {
    const secret = "PRIVATE_TRANSCRIPT token=secret password=hunter2";
    const error = new APIConnectionError({ message: secret, cause: new Error(secret) });
    const wrapped = wrapDailyBriefProviderFailure(error);

    expect(wrapped).toBeInstanceOf(DailyBriefProviderFailureError);
    expect(wrapped.message).toBe("Daily Brief provider failed: network_error");
    expect(JSON.stringify(wrapped)).not.toContain(secret);
    expect(JSON.stringify(wrapped)).not.toContain("hunter2");
    expect(wrapDailyBriefProviderFailure(wrapped)).toBe(wrapped);
  });
});

describe("Daily Brief Retry-After diagnostics", () => {
  it("prefers retry-after-ms and accepts case-insensitive record headers", () => {
    expect(parseDailyBriefRetryAfter({
      "Retry-After-MS": "1250",
      "Retry-After": "9"
    })).toEqual({ retryAfterMs: 1_250, retryAfterCapped: false });
  });

  it("parses seconds and an HTTP date using an injected clock", () => {
    expect(parseDailyBriefRetryAfter(new Headers({ "retry-after": "2.5" }))).toEqual({
      retryAfterMs: 2_500,
      retryAfterCapped: false
    });
    const now = Date.parse("2026-07-17T00:00:00.000Z");
    expect(parseDailyBriefRetryAfter(
      new Headers({ "retry-after": "Fri, 17 Jul 2026 00:00:04 GMT" }),
      now
    )).toEqual({ retryAfterMs: 4_000, retryAfterCapped: false });
  });

  it("caps Retry-After at 30 seconds and rejects malformed, negative, and past values", () => {
    expect(parseDailyBriefRetryAfter({ "retry-after": "60" })).toEqual({
      retryAfterMs: 30_000,
      retryAfterCapped: true
    });
    expect(parseDailyBriefRetryAfter({ "retry-after-ms": "12secret" })).toEqual({
      retryAfterCapped: false
    });
    expect(parseDailyBriefRetryAfter({ "retry-after": "-1" })).toEqual({
      retryAfterCapped: false
    });
    expect(parseDailyBriefRetryAfter(
      { "retry-after": "Thu, 16 Jul 2026 00:00:00 GMT" },
      Date.parse("2026-07-17T00:00:00.000Z")
    )).toEqual({ retryAfterCapped: false });
  });

  it("includes only the bounded derived delay in a classification", () => {
    const result = classifyDailyBriefFailure(apiError({
      status: 429,
      code: "rate_limit_exceeded",
      headers: new Headers({
        "retry-after": "999",
        authorization: "Bearer private-token"
      })
    }));

    expect(result).toMatchObject({
      failureCode: "rate_limit",
      retryAfterMs: 30_000,
      retryAfterCapped: true
    });
    expect(JSON.stringify(result)).not.toContain("authorization");
    expect(JSON.stringify(result)).not.toContain("private-token");
  });
});

describe("Daily Brief validation diagnostics", () => {
  function invalidItems(count: number) {
    const schema = z.object({
      items: z.array(z.object({
        category: z.enum(["task", "decision"]),
        sourceSegmentIds: z.array(z.string()).min(1)
      }))
    });
    const result = schema.safeParse({
      items: Array.from({ length: count }, () => ({
        category: "PRIVATE_INVALID_VALUE",
        sourceSegmentIds: "PRIVATE_TRANSCRIPT"
      }))
    });
    if (result.success) throw new Error("expected invalid fixture");
    return result.error;
  }

  it("emits at most ten structural issue codes and paths without values or messages", () => {
    const fields = buildDailyBriefValidationLogFields(invalidItems(12));

    expect(fields.validationIssueCount).toBe(24);
    expect(fields.validationIssueCodes).toHaveLength(10);
    expect(fields.validationIssuePaths).toHaveLength(10);
    expect(fields.validationIssuePaths[0]).toBe("items[0].category");
    expect(fields.validationIssuesTruncated).toBe(true);
    expect(fields).not.toHaveProperty("message");
    expect(JSON.stringify(fields)).not.toContain("PRIVATE_INVALID_VALUE");
    expect(JSON.stringify(fields)).not.toContain("PRIVATE_TRANSCRIPT");
  });

  it("normalizes a missing required field and stores only bounded code counts", () => {
    const schema = z.object({ items: z.array(z.object({ category: z.string() })) });
    const result = schema.safeParse({ items: [{}] });
    if (result.success) throw new Error("expected invalid fixture");

    expect(buildDailyBriefValidationLogFields(result.error)).toEqual({
      validationIssueCount: 1,
      validationIssueCodes: ["missing_field"],
      validationIssuePaths: ["items[0].category"],
      validationIssuesTruncated: false
    });
    expect(buildDailyBriefValidationCheckpointSummary(result.error)).toEqual({
      validationIssueCount: 1,
      validationIssueSummary: [{ code: "missing_field", count: 1 }],
      validationIssuesTruncated: false
    });
  });

  it("strips messages from structured diagnostics before checkpoint persistence", () => {
    const diagnostics = {
      responseTextLength: 20,
      parseResult: "success" as const,
      validationResult: "failed" as const,
      validationIssueCount: 2,
      validationIssues: [
        { path: "items[0].category", code: "invalid_enum_value", message: "PRIVATE VALUE" },
        { path: "items[1].sourceSegmentIds", code: "invalid_type", message: "PRIVATE QUOTE" }
      ],
      validationIssueSummary: [
        { code: "invalid_enum_value", count: 1 },
        { code: "invalid_type", count: 1 }
      ],
      validationIssuesTruncated: false
    };

    const log = buildDailyBriefValidationLogFields(diagnostics);
    const checkpoint = buildDailyBriefValidationCheckpointSummary(diagnostics);

    expect(log.validationIssuePaths).toEqual([
      "items[0].category",
      "items[1].sourceSegmentIds"
    ]);
    expect(checkpoint.validationIssueSummary).toEqual([
      { code: "invalid_enum_value", count: 1 },
      { code: "invalid_type", count: 1 }
    ]);
    expect(JSON.stringify({ log, checkpoint })).not.toContain("PRIVATE VALUE");
    expect(JSON.stringify({ log, checkpoint })).not.toContain("PRIVATE QUOTE");
    expect(checkpoint).not.toHaveProperty("validationIssues");
  });
});
