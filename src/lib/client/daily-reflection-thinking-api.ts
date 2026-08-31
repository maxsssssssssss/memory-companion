import type {
  DailyReflectionThinkingConversation,
  DailyReflectionThinkingRequest,
  DailyReflectionThinkingResponse
} from "@/lib/domain/daily-reflection-thinking";
import {
  DailyReflectionThinkingConversationIdSchema,
  DailyReflectionThinkingConversationResponseSchema,
  DailyReflectionThinkingRequestSchema,
  DailyReflectionThinkingResponseSchema
} from "@/lib/domain/daily-reflection-thinking";
import { z } from "zod";

export type DailyReflectionThinkingApi = Readonly<{
  think(
    input: DailyReflectionThinkingRequest,
    signal?: AbortSignal
  ): Promise<DailyReflectionThinkingResponse>;
  getConversation(
    conversationId: string,
    signal?: AbortSignal
  ): Promise<DailyReflectionThinkingConversation>;
}>;

const ThinkingErrorResponseSchema = z.object({
  error: z.string().trim().min(1).max(256)
}).strict();

const ERROR_COPY: Readonly<Record<string, string>> = {
  unauthenticated: "登录已失效，请重新登录。",
  invalid_daily_reflection_thinking_request: "这次问题还不完整，请检查后再试。",
  invalid_thinking_conversation_id: "这次一起想的内容已不可用，请重新开始。",
  thinking_conversation_not_found: "这次一起想的内容已不可用，请重新开始。",
  thinking_operation_conflict: "这次请求状态已经变化，请重新发送。",
  daily_reflection_thinking_unavailable: "这次没有继续下去。你可以保留原问题，再试一次。"
};

export class DailyReflectionThinkingApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DailyReflectionThinkingApiError";
    this.code = code;
    this.status = status;
  }
}

function fallbackError(status: number) {
  if (status === 401) return "登录已失效，请重新登录。";
  if (status === 404) return "这次一起想的内容已不可用，请重新开始。";
  if (status === 409) return "这次请求状态已经变化，请重新发送。";
  return "这次没有继续下去。你可以保留原问题，再试一次。";
}

async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new DailyReflectionThinkingApiError(
      response.status,
      "invalid_response",
      "服务器返回了无法识别的数据，请稍后重试。",
      { cause }
    );
  }
}

async function request(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  signal?: AbortSignal
) {
  try {
    return await fetcher(url, {
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
    throw new DailyReflectionThinkingApiError(
      0,
      "network_error",
      "网络连接失败，请检查后重试。",
      { cause }
    );
  }
}

export function createDailyReflectionThinkingApi(
  fetcher: typeof fetch = fetch
): DailyReflectionThinkingApi {
  return {
    async think(rawInput, signal) {
      const input = DailyReflectionThinkingRequestSchema.safeParse(rawInput);
      if (!input.success) {
        throw new DailyReflectionThinkingApiError(
          400,
          "invalid_daily_reflection_thinking_request",
          ERROR_COPY.invalid_daily_reflection_thinking_request
        );
      }
      const response = await request(fetcher, "/api/daily-reflections/thinking", {
        method: "POST",
        body: JSON.stringify(input.data)
      }, signal);
      const payload = await responsePayload(response);
      const parsed = DailyReflectionThinkingResponseSchema.safeParse(payload);
      if (parsed.success && (response.ok || response.status === 499 || response.status === 503)) {
        return parsed.data;
      }
      if (!response.ok) {
        const error = ThinkingErrorResponseSchema.safeParse(payload);
        const code = response.status === 401
          ? "unauthenticated"
          : error.success ? error.data.error : "invalid_response";
        throw new DailyReflectionThinkingApiError(
          response.status,
          code,
          ERROR_COPY[code] ?? fallbackError(response.status)
        );
      }
      throw new DailyReflectionThinkingApiError(
        response.status,
        "invalid_response",
        "服务器返回了无法识别的数据，请稍后重试。"
      );
    },

    async getConversation(rawConversationId, signal) {
      const conversationId = DailyReflectionThinkingConversationIdSchema.safeParse(rawConversationId);
      if (!conversationId.success) {
        throw new DailyReflectionThinkingApiError(
          400,
          "invalid_thinking_conversation_id",
          ERROR_COPY.invalid_thinking_conversation_id
        );
      }
      const response = await request(
        fetcher,
        `/api/daily-reflections/thinking/${encodeURIComponent(conversationId.data)}`,
        { method: "GET" },
        signal
      );
      const payload = await responsePayload(response);
      if (!response.ok) {
        const error = ThinkingErrorResponseSchema.safeParse(payload);
        const code = response.status === 401
          ? "unauthenticated"
          : error.success ? error.data.error : "invalid_response";
        throw new DailyReflectionThinkingApiError(
          response.status,
          code,
          ERROR_COPY[code] ?? fallbackError(response.status)
        );
      }
      const parsed = DailyReflectionThinkingConversationResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new DailyReflectionThinkingApiError(
          response.status,
          "invalid_response",
          "服务器返回了无法识别的数据，请稍后重试。"
        );
      }
      return parsed.data.conversation;
    }
  };
}
