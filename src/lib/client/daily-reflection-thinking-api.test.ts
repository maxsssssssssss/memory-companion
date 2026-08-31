import { describe, expect, it, vi } from "vitest";

import {
  DailyReflectionThinkingApiError,
  createDailyReflectionThinkingApi
} from "./daily-reflection-thinking-api";

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function response(completionStatus: "completed" | "provider_error" = "completed") {
  return {
    conversationId: "thinking_conversation_1",
    operationKey: "operation_1",
    assistantMessage: {
      id: "assistant_1",
      operationKey: "operation_1",
      role: "assistant" as const,
      mode: "brainstorm" as const,
      contextMode: "none" as const,
      content: completionStatus === "completed" ? "可以先把三个方向并排放下。" : "这次一起想暂时没有完成，请稍后再试。",
      usedPersonalContext: false,
      sources: [],
      personalContextClaims: [],
      interpretations: completionStatus === "completed" ? ["可以先区分验证成本。"] : [],
      hypotheses: [],
      model: "deepseek-fixture",
      createdAt: "2026-08-26T08:00:00.000Z",
      completionStatus
    },
    usedPersonalContext: false,
    sources: [],
    model: "deepseek-fixture"
  };
}

describe("createDailyReflectionThinkingApi", () => {
  it("posts the strict DTO with same-origin private transport and parses the response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(response()));
    const api = createDailyReflectionThinkingApi(fetcher);

    await expect(api.think({
      operationKey: "operation_1",
      mode: "brainstorm",
      contextMode: "none",
      message: "一起想想怎么验证这个方向。"
    })).resolves.toEqual(response());

    expect(fetcher).toHaveBeenCalledWith("/api/daily-reflections/thinking", {
      method: "POST",
      body: JSON.stringify({
        operationKey: "operation_1",
        mode: "brainstorm",
        contextMode: "none",
        message: "一起想想怎么验证这个方向。"
      }),
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      signal: undefined
    });
  });

  it("rejects forged request fields and dangerous response drift", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({
      ...response(),
      evidence: [{ text: "forged" }]
    }));
    const api = createDailyReflectionThinkingApi(fetcher);

    await expect(api.think({
      operationKey: "operation_1",
      mode: "brainstorm",
      contextMode: "none",
      message: "一起想想。",
      evidence: [{ text: "forged" }]
    } as never)).rejects.toMatchObject({ code: "invalid_daily_reflection_thinking_request" });
    expect(fetcher).not.toHaveBeenCalled();

    await expect(api.think({
      operationKey: "operation_1",
      mode: "brainstorm",
      contextMode: "none",
      message: "一起想想。"
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("preserves the server provider failure envelope for recoverable UI handling", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(response("provider_error"), 503));
    const api = createDailyReflectionThinkingApi(fetcher);

    await expect(api.think({
      operationKey: "operation_1",
      mode: "brainstorm",
      contextMode: "none",
      message: "再试着展开一下。"
    })).resolves.toMatchObject({
      assistantMessage: { completionStatus: "provider_error" }
    });
  });

  it("maps safe route errors without leaking technical payloads", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ error: "thinking_operation_conflict" }, 409));
    const api = createDailyReflectionThinkingApi(fetcher);

    await expect(api.think({
      operationKey: "operation_1",
      mode: "brainstorm",
      contextMode: "none",
      message: "一起想想。"
    })).rejects.toEqual(expect.objectContaining<Partial<DailyReflectionThinkingApiError>>({
      status: 409,
      code: "thinking_operation_conflict",
      message: "这次请求状态已经变化，请重新发送。"
    }));
  });

  it("restores a strict account-scoped conversation from the canonical GET route", async () => {
    const conversation = {
      schemaVersion: 1 as const,
      conversationId: "thinking_conversation_1",
      messages: [],
      createdAt: "2026-08-26T08:00:00.000Z",
      updatedAt: "2026-08-26T08:00:00.000Z"
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ conversation }));
    const api = createDailyReflectionThinkingApi(fetcher);

    await expect(api.getConversation("thinking_conversation_1")).resolves.toEqual(conversation);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/daily-reflections/thinking/thinking_conversation_1",
      expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store" })
    );
  });
});
