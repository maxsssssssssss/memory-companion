import { z } from "zod";

import {
  DailyReflectionAiReviewLookupResponseSchema,
  DailyReflectionAiReviewOperationViewSchema,
  DailyReflectionAiReviewScopeSchema,
  DailyReflectionAiReviewSummarySchema,
  type DailyReflectionAiReviewCanonicalSource,
  type DailyReflectionAiReviewOperationView,
  type DailyReflectionAiReviewScope
} from "@/lib/domain/daily-reflection-ai-review";

const DateKeySchema = z.string().date();
const IdentifierSchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u);

const AiReviewRequestSchema = z.object({
  scope: DailyReflectionAiReviewScopeSchema,
  referenceDate: DateKeySchema
}).strict();

const ErrorResponseSchema = z.object({
  error: z.string().trim().min(1).max(256)
}).strict();

export type DailyReflectionAiReviewLookupResponse = z.infer<
  typeof DailyReflectionAiReviewLookupResponseSchema
>;
export type DailyReflectionAiReviewSummaryResponse = z.infer<
  typeof DailyReflectionAiReviewSummarySchema
>;
export type {
  DailyReflectionAiReviewCanonicalSource,
  DailyReflectionAiReviewOperationView,
  DailyReflectionAiReviewScope
};

export type DailyReflectionAiReviewApi = Readonly<{
  get(
    input: { scope: DailyReflectionAiReviewScope; referenceDate: string },
    signal?: AbortSignal
  ): Promise<DailyReflectionAiReviewLookupResponse>;
  ensure(
    input: { scope: DailyReflectionAiReviewScope; referenceDate: string },
    signal?: AbortSignal
  ): Promise<DailyReflectionAiReviewOperationView>;
  getSummary(signal?: AbortSignal): Promise<DailyReflectionAiReviewSummaryResponse>;
  markSeen(reviewId: string, signal?: AbortSignal): Promise<DailyReflectionAiReviewOperationView>;
}>;

const ERROR_COPY: Readonly<Record<string, string>> = {
  unauthenticated: "登录已失效，请重新登录。",
  daily_reflection_ai_review_not_found: "这份 AI 深度回看已不可用。",
  daily_reflection_ai_review_conflict: "回看的来源已经变化，请稍后重新查看。",
  daily_reflection_ai_review_unavailable: "这次 AI 深度回看暂时没有完成。"
};

export class DailyReflectionAiReviewApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DailyReflectionAiReviewApiError";
    this.code = code;
    this.status = status;
  }
}

function fallbackError(status: number) {
  if (status === 401) return ERROR_COPY.unauthenticated;
  if (status === 404) return ERROR_COPY.daily_reflection_ai_review_not_found;
  if (status === 409) return ERROR_COPY.daily_reflection_ai_review_conflict;
  return ERROR_COPY.daily_reflection_ai_review_unavailable;
}

async function requestJson<T>(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
  signal?: AbortSignal
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers
      },
      signal
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new DailyReflectionAiReviewApiError(
      0,
      "network_error",
      "网络连接失败，请稍后再试。",
      { cause }
    );
  }
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) as unknown : null;
  } catch (cause) {
    throw new DailyReflectionAiReviewApiError(
      response.status,
      "invalid_response",
      "服务器返回了无法识别的数据。",
      { cause }
    );
  }
  if (!response.ok) {
    const parsed = ErrorResponseSchema.safeParse(payload);
    const code = response.status === 401
      ? "unauthenticated"
      : parsed.success ? parsed.data.error : "invalid_response";
    throw new DailyReflectionAiReviewApiError(
      response.status,
      code,
      ERROR_COPY[code] ?? fallbackError(response.status)
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new DailyReflectionAiReviewApiError(
      response.status,
      "invalid_response",
      "服务器返回了无法识别的数据。"
    );
  }
  return parsed.data;
}

export function createDailyReflectionAiReviewApi(
  fetcher: typeof fetch = fetch
): DailyReflectionAiReviewApi {
  const endpoint = "/api/daily-reflections/returns/ai-review";
  return {
    async get(rawInput, signal) {
      const input = AiReviewRequestSchema.parse(rawInput);
      const query = new URLSearchParams({
        scope: input.scope,
        referenceDate: input.referenceDate
      });
      return requestJson(
        fetcher,
        `${endpoint}?${query}`,
        { method: "GET" },
        DailyReflectionAiReviewLookupResponseSchema,
        signal
      );
    },

    async ensure(rawInput, signal) {
      const input = AiReviewRequestSchema.parse(rawInput);
      return requestJson(
        fetcher,
        endpoint,
        { method: "POST", body: JSON.stringify(input) },
        DailyReflectionAiReviewOperationViewSchema,
        signal
      );
    },

    async getSummary(signal) {
      return requestJson(
        fetcher,
        `${endpoint}/summary`,
        { method: "GET" },
        DailyReflectionAiReviewSummarySchema,
        signal
      );
    },

    async markSeen(rawReviewId, signal) {
      const reviewId = IdentifierSchema.parse(rawReviewId);
      return requestJson(
        fetcher,
        `${endpoint}/${encodeURIComponent(reviewId)}/seen`,
        { method: "POST" },
        DailyReflectionAiReviewOperationViewSchema,
        signal
      );
    }
  };
}
