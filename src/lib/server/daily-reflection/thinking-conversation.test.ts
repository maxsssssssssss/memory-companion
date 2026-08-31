import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DailyReflectionThinkingConversation,
  DailyReflectionThinkingResponse,
  DailyReflectionThinkingSource
} from "@/lib/domain/daily-reflection-thinking";
import type { JsonStore } from "@/lib/server/storage/json-store";

import type { ThinkingConversationProvider } from "./thinking-provider";
import {
  DailyReflectionThinkingConversationNotFoundError,
  DailyReflectionThinkingConversationService,
  DailyReflectionThinkingOperationConflictError,
  type DailyReflectionThinkingContextResolver,
  type DailyReflectionThinkingConversationStore
} from "./thinking-conversation";

class MemoryConversationStore implements DailyReflectionThinkingConversationStore {
  conversations = new Map<string, DailyReflectionThinkingConversation>();
  operations = new Map<string, Parameters<DailyReflectionThinkingConversationStore["writeOperation"]>[0]>();

  async readConversation(id: string) {
    return structuredClone(this.conversations.get(id) ?? null);
  }

  async writeConversation(value: DailyReflectionThinkingConversation) {
    this.conversations.set(value.conversationId, structuredClone(value));
  }

  async readOperation(key: string) {
    return structuredClone(this.operations.get(key) ?? null);
  }

  async writeOperation(value: Parameters<DailyReflectionThinkingConversationStore["writeOperation"]>[0]) {
    this.operations.set(value.operationKey, structuredClone(value));
  }
}

function source(): DailyReflectionThinkingSource {
  return {
    sourceId: "source_1",
    claim: {
      text: "你曾记录：想先做一个小实验。",
      sourceMemoryIds: ["memory_1"],
      sourceCardIds: ["card_1"],
      evidenceIds: ["segment_1"],
      evidence: [{
        reflectionId: "reflection_1",
        cardId: "card_1",
        sourceSegmentId: "segment_1",
        recordingDate: "2026-08-20",
        startSeconds: 1,
        endSeconds: 4,
        snippet: "我想先做一个小实验。",
        sourceOrigin: "user_reflection"
      }],
      epistemicStatuses: ["explicit_user_statement"]
    }
  };
}

function fixture(input: {
  sources?: DailyReflectionThinkingSource[];
  providerResult?: Awaited<ReturnType<ThinkingConversationProvider["generate"]>>;
} = {}) {
  const store = new MemoryConversationStore();
  const contextResolver: DailyReflectionThinkingContextResolver = {
    resolve: vi.fn(async () => ({ sources: input.sources ?? [] }))
  };
  const provider: ThinkingConversationProvider = {
    model: "gpt-5.5",
    generate: vi.fn(async () => input.providerResult ?? ({
      answer: "可以先列出三个方向。",
      personalContextClaims: [],
      interpretations: ["这是一次方向探索。"],
      hypotheses: ["也许先做低成本实验。"]
    }))
  };
  const service = new DailyReflectionThinkingConversationService({
    store,
    contextResolver,
    provider,
    settingsStore: {} as JsonStore,
    now: () => new Date("2026-08-26T00:00:00.000Z")
  });
  return { store, contextResolver, provider, service };
}

describe("Daily Reflection Thinking conversation service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("never calls the personal resolver for context none and still calls the Provider", async () => {
    const test = fixture();
    const response = await test.service.think("account_1", {
      operationKey: "operation_none",
      mode: "brainstorm",
      contextMode: "none",
      message: "一起想想下一步。"
    });
    expect(test.contextResolver.resolve).not.toHaveBeenCalled();
    expect(test.provider.generate).toHaveBeenCalledTimes(1);
    expect(response.model).toBe("gpt-5.5");
    expect(response.usedPersonalContext).toBe(false);
    expect(response.assistantMessage).toMatchObject({
      safetyBoundaryVersion: "v2",
      personalContextClaims: []
    });
    expect(response.assistantMessage.content).toBe("可以先列出三个方向。");
    expect(response.assistantMessage.content).not.toContain("模型解释");
    expect(response.assistantMessage.content).not.toContain("新的推演");
    expect(response.assistantMessage.interpretations).toEqual(["这是一次方向探索。"]);
    expect(response.assistantMessage.hypotheses).toEqual(["也许先做低成本实验。"]);
  });

  it("lets open personal and auto modes answer without sources and only resolves obvious auto context", async () => {
    const test = fixture();
    await test.service.think("account_1", {
      operationKey: "operation_personal_empty",
      mode: "clarify_decision",
      contextMode: "personal",
      message: "帮我理清选择。"
    });
    await test.service.think("account_1", {
      operationKey: "operation_auto_irrelevant",
      mode: "extend_idea",
      contextMode: "auto",
      message: "把这个点子继续展开。"
    });
    await test.service.think("account_1", {
      operationKey: "operation_auto_relevant",
      mode: "extend_idea",
      contextMode: "auto",
      message: "我以前有没有提过类似想法？"
    });
    expect(test.contextResolver.resolve).toHaveBeenCalledTimes(2);
    expect(test.provider.generate).toHaveBeenCalledTimes(3);
  });

  it("returns a trusted past_clues no-result without calling the Provider", async () => {
    const test = fixture();
    const response = await test.service.think("account_1", {
      operationKey: "operation_past_empty",
      mode: "past_clues",
      contextMode: "personal",
      message: "过去有没有相关线索？"
    });
    expect(test.contextResolver.resolve).toHaveBeenCalledTimes(1);
    expect(test.provider.generate).not.toHaveBeenCalled();
    expect(response.assistantMessage).toMatchObject({
      completionStatus: "no_result",
      usedPersonalContext: false,
      safetyBoundaryVersion: "v2"
    });
    expect(response.sources).toEqual([]);
  });

  it("keeps direct plain content separate from canonical facts and model attribution fields", async () => {
    const trusted = source();
    const test = fixture({
      sources: [trusted],
      providerResult: {
        answer: "## 直接回答\n\n**先用一个小实验验证方案 A。**\n\n- 明确成功标准\n- 一天后复盘",
        personalContextClaims: [{ text: "模型伪造的个人事实。", sourceIds: [trusted.sourceId] }],
        interpretations: ["这可以成为可逆下一步。"],
        hypotheses: ["也许再加一个成功标准。"]
      }
    });
    const response = await test.service.think("account_1", {
      operationKey: "operation_past_source",
      mode: "past_clues",
      contextMode: "personal",
      message: "过去有没有相关线索？",
      pinnedMemoryIds: ["memory_1"]
    });
    expect(test.provider.generate).toHaveBeenCalledWith(expect.objectContaining({
      sources: [trusted]
    }));
    expect(response.usedPersonalContext).toBe(true);
    expect(response.assistantMessage.safetyBoundaryVersion).toBe("v2");
    expect(response.assistantMessage.personalContextClaims).toEqual([{
      text: trusted.claim.text,
      sourceIds: [trusted.sourceId]
    }]);
    const content = response.assistantMessage.content;
    expect(content).toBe(
      "直接回答\n\n先用一个小实验验证方案 A。\n\n1. 明确成功标准\n2. 一天后复盘"
    );
    expect(content).not.toMatch(/^\s*(?:#|[-*+]\s|```|\|)/mu);
    expect(content).not.toContain("**");
    expect(content).not.toContain("模型解释");
    expect(content).not.toContain("新的推演");
    expect(content).not.toContain(trusted.claim.text);
    expect(content).not.toContain("这可以成为可逆下一步。");
    expect(content).not.toContain("也许再加一个成功标准。");
    expect(response.assistantMessage.interpretations).toEqual(["这可以成为可逆下一步。"]);
    expect(response.assistantMessage.hypotheses).toEqual(["也许再加一个成功标准。"]);
    const conversation = await test.service.getConversation(response.conversationId);
    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages.every((message) => (
      message.mode === "past_clues"
      && message.contextMode === "personal"
      && message.sources.length === 1
    ))).toBe(true);
    expect(conversation.messages[0]?.safetyBoundaryVersion).toBeNull();
    expect(conversation.messages[1]?.safetyBoundaryVersion).toBe("v2");
  });

  it("replays one operation exactly and rejects reuse with another request", async () => {
    const test = fixture();
    const request = {
      operationKey: "operation_replay",
      mode: "brainstorm" as const,
      contextMode: "none" as const,
      message: "一起想想。"
    };
    const first = await test.service.think("account_1", request);
    const second = await test.service.think("account_1", request);
    expect(second).toEqual(first);
    expect(first.assistantMessage.safetyBoundaryVersion).toBe("v2");
    expect(test.provider.generate).toHaveBeenCalledTimes(1);
    await expect(test.service.think("account_1", {
      ...request,
      message: "换一个请求。"
    })).rejects.toBeInstanceOf(DailyReflectionThinkingOperationConflictError);
  });

  it("recovers a lost completed response from conversation plus pending receipt", async () => {
    const test = fixture();
    const request = {
      operationKey: "operation_lost_response",
      mode: "brainstorm" as const,
      contextMode: "none" as const,
      message: "一起想想。"
    };
    const first = await test.service.think("account_1", request);
    const operation = test.store.operations.get(request.operationKey)!;
    test.store.operations.set(request.operationKey, {
      ...operation,
      status: "pending",
      response: null
    });
    const recovered = await test.service.think("account_1", request);
    expect(recovered).toEqual(first);
    expect(test.provider.generate).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent retries so user and assistant messages are written once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const test = fixture();
    vi.mocked(test.provider.generate).mockImplementationOnce(async () => {
      await gate;
      return {
        answer: "完成。",
        personalContextClaims: [],
        interpretations: [],
        hypotheses: []
      };
    });
    const request = {
      operationKey: "operation_concurrent",
      mode: "brainstorm" as const,
      contextMode: "none" as const,
      message: "一起想想。"
    };
    const first = test.service.think("account_1", request);
    const second = test.service.think("account_1", request);
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(right).toEqual(left);
    expect(test.provider.generate).toHaveBeenCalledTimes(1);
    expect((await test.service.getConversation(left.conversationId)).messages).toHaveLength(2);
  });

  it("keeps conversations account-scoped through separate authenticated stores", async () => {
    const accountA = fixture();
    const accountB = fixture();
    const response = await accountA.service.think("account_a", {
      operationKey: "operation_account_a",
      mode: "brainstorm",
      contextMode: "none",
      message: "只属于 A。"
    });
    await expect(accountB.service.getConversation(response.conversationId))
      .rejects.toBeInstanceOf(DailyReflectionThinkingConversationNotFoundError);
  });

  it("stores provider failure once without writing Card, Memory, or Retrieval state", async () => {
    const test = fixture();
    vi.mocked(test.provider.generate).mockRejectedValueOnce(new Error("provider failed"));
    const response = await test.service.think("account_1", {
      operationKey: "operation_provider_error",
      mode: "compare_directions",
      contextMode: "none",
      message: "比较两个方向。"
    });
    expect(response.assistantMessage.completionStatus).toBe("provider_error");
    expect(response.assistantMessage.content).not.toContain("provider failed");
    expect(test.store.conversations.size).toBe(1);
    expect(test.store.operations.size).toBe(1);
  });
});
