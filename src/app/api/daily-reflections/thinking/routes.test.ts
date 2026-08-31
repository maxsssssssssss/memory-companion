import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonStore } from "@/lib/server/storage/json-store";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(() => true),
  requireAuth: vi.fn(),
  think: vi.fn(),
  getConversation: vi.fn(),
  serviceFactory: vi.fn(),
  resolverFactory: vi.fn(() => ({ resolve: vi.fn() }))
}));

vi.mock("@/lib/server/auth/request-context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth/request-context")>(
    "@/lib/server/auth/request-context"
  );
  return { ...actual, requireAuthContext: mocks.requireAuth };
});
vi.mock("@/lib/server/daily-reflection/runtime-config", () => ({
  isDailyReflectionUploadEnabled: mocks.enabled
}));
vi.mock("@/lib/server/daily-reflection/thinking-context-resolver", () => ({
  getDailyReflectionThinkingContextResolver: mocks.resolverFactory
}));
vi.mock("@/lib/server/daily-reflection/thinking-conversation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/daily-reflection/thinking-conversation")>(
    "@/lib/server/daily-reflection/thinking-conversation"
  );
  return {
    ...actual,
    createDailyReflectionThinkingConversationService: mocks.serviceFactory
  };
});

import { POST } from "./route";
import { GET } from "./[conversationId]/route";
import {
  DailyReflectionThinkingConversationNotFoundError,
  DailyReflectionThinkingOperationConflictError
} from "@/lib/server/daily-reflection/thinking-conversation";

const accountStore = {} as JsonStore;

function assistantMessage(
  completionStatus: "completed" | "provider_error" = "completed"
) {
  return {
    id: "message_assistant_1",
    operationKey: "operation_1",
    role: "assistant" as const,
    mode: "brainstorm" as const,
    contextMode: "none" as const,
    content: completionStatus === "completed" ? "可以先列三个方向。" : "这次一起想暂时没有完成，请稍后再试。",
    safetyBoundaryVersion: "v2" as const,
    usedPersonalContext: false,
    sources: [],
    personalContextClaims: [],
    interpretations: [],
    hypotheses: [],
    model: "gpt-5.5",
    createdAt: "2026-08-26T00:00:00.000Z",
    completionStatus
  };
}

function response(completionStatus: "completed" | "provider_error" = "completed") {
  return {
    conversationId: "conversation_1",
    operationKey: "operation_1",
    assistantMessage: assistantMessage(completionStatus),
    usedPersonalContext: false,
    sources: [],
    model: "gpt-5.5"
  };
}

function post(body: unknown) {
  return POST(new Request("http://localhost/api/daily-reflections/thinking", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }));
}

describe("Daily Reflection Thinking routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled.mockReturnValue(true);
    mocks.requireAuth.mockResolvedValue({
      user: { id: "account_1", email: "user@example.com" },
      store: accountStore
    });
    mocks.serviceFactory.mockReturnValue({
      think: mocks.think,
      getConversation: mocks.getConversation
    });
    mocks.think.mockResolvedValue(response());
  });

  it("requires auth and keeps Thinking responses private", async () => {
    mocks.requireAuth.mockRejectedValueOnce(new Error("unauthenticated"));
    const unauthorized = await post({
      operationKey: "operation_1",
      mode: "brainstorm",
      contextMode: "none",
      message: "一起想想。"
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("enforces the strict request and rejects non-personal past_clues", async () => {
    const injected = await post({
      operationKey: "operation_1",
      mode: "brainstorm",
      contextMode: "none",
      message: "一起想想。",
      evidenceReferences: [{ sourceSegmentId: "forged" }]
    });
    const invalidPast = await post({
      operationKey: "operation_2",
      mode: "past_clues",
      contextMode: "auto",
      message: "过去有什么线索？"
    });
    expect(injected.status).toBe(400);
    expect(invalidPast.status).toBe(400);
    expect(mocks.serviceFactory).not.toHaveBeenCalled();
  });

  it("passes only the authenticated account, parsed DTO and AbortSignal to the service", async () => {
    const result = await post({
      operationKey: "operation_1",
      mode: "brainstorm",
      contextMode: "none",
      message: "一起想想。"
    });
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.serviceFactory).toHaveBeenCalledWith({
      store: accountStore,
      contextResolver: mocks.resolverFactory.mock.results[0]?.value
    });
    expect(mocks.think).toHaveBeenCalledWith(
      "account_1",
      {
        operationKey: "operation_1",
        mode: "brainstorm",
        contextMode: "none",
        message: "一起想想。"
      },
      expect.any(AbortSignal)
    );
    await expect(result.json()).resolves.toEqual(response());
  });

  it("returns stable conflicts/not-found and preserves provider completion status", async () => {
    mocks.think.mockRejectedValueOnce(new DailyReflectionThinkingOperationConflictError());
    expect((await post({
      operationKey: "operation_1",
      mode: "brainstorm",
      contextMode: "none",
      message: "一起想想。"
    })).status).toBe(409);

    mocks.think.mockRejectedValueOnce(new DailyReflectionThinkingConversationNotFoundError());
    expect((await post({
      operationKey: "operation_2",
      conversationId: "missing_conversation",
      mode: "brainstorm",
      contextMode: "none",
      message: "继续。"
    })).status).toBe(404);

    mocks.think.mockResolvedValueOnce(response("provider_error"));
    const unavailable = await post({
      operationKey: "operation_1",
      mode: "brainstorm",
      contextMode: "none",
      message: "一起想想。"
    });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual(response("provider_error"));
  });

  it("restores only the current account conversation and returns uniform 404", async () => {
    const conversation = {
      schemaVersion: 1 as const,
      conversationId: "conversation_1",
      messages: [assistantMessage()],
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z"
    };
    mocks.getConversation.mockResolvedValueOnce(conversation);
    const found = await GET(
      new Request("http://localhost/api/daily-reflections/thinking/conversation_1"),
      { params: Promise.resolve({ conversationId: "conversation_1" }) }
    );
    expect(found.status).toBe(200);
    expect(found.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.serviceFactory).toHaveBeenCalledWith({
      store: accountStore,
      contextResolver: expect.any(Object)
    });
    expect(mocks.getConversation).toHaveBeenCalledWith("conversation_1");
    await expect(found.json()).resolves.toEqual({ conversation });

    mocks.getConversation.mockRejectedValueOnce(
      new DailyReflectionThinkingConversationNotFoundError()
    );
    const missing = await GET(
      new Request("http://localhost/api/daily-reflections/thinking/conversation_1"),
      { params: Promise.resolve({ conversationId: "conversation_1" }) }
    );
    expect(missing.status).toBe(404);
  });
});
