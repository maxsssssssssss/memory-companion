import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import type {
  DailyReflectionThinkingConversation,
  DailyReflectionThinkingResponse,
  DailyReflectionThinkingSource
} from "@/lib/domain/daily-reflection-thinking";
import { JsonStore } from "@/lib/server/storage/json-store";

import type { ThinkingConversationProvider } from "./thinking-provider";
import {
  DailyReflectionThinkingConversationNotFoundError,
  DailyReflectionThinkingConversationService,
  DailyReflectionThinkingOperationConflictError,
  createDailyReflectionThinkingConversationService,
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
    const conversation = await test.service.getConversation("account_1", response.conversationId);
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
    expect((await test.service.getConversation("account_1", left.conversationId)).messages).toHaveLength(2);
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
    await expect(accountB.service.getConversation("account_b", response.conversationId))
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

  it("preserves a legitimate unmarked legacy answer for display while excluding it before any provider receives history", async () => {
    const test = fixture();
    const first = await test.service.think("account_1", { operationKey: "old_display", mode: "brainstorm", contextMode: "none", message: "保留用户原话" });
    const raw = test.store.conversations.get(first.conversationId)!;
    delete raw.messages[1].safetyBoundaryVersion;
    raw.messages[1].content = "LEGACY_UNMARKED_DISCUSSION";
    const displayed = await test.service.getConversation("account_1", first.conversationId);
    expect(displayed.messages[1].content).toBe("LEGACY_UNMARKED_DISCUSSION");
    expect(displayed.messages[1].safetyBoundaryVersion).toBeUndefined();
    await test.service.think("account_1", { operationKey: "continue_legacy", conversationId: first.conversationId, mode: "extend_idea", contextMode: "none", message: "以我现在的表达继续" });
    const history = vi.mocked(test.provider.generate).mock.calls.at(-1)![0].history;
    expect(JSON.stringify(history)).not.toContain("LEGACY_UNMARKED_DISCUSSION");
    expect(history.some(message => message.content === "保留用户原话")).toBe(true);
    expect(test.store.conversations.get(first.conversationId)!.messages[1].content).toBe("LEGACY_UNMARKED_DISCUSSION");
  });

  it("removes withdrawn source excerpts from GET, completed-operation replay and subsequent provider history without rewriting the audit", async () => {
    const trusted = source(), privateText = "PRIVATE_LEGACY_DERIVED_ANSWER";
    let available = true;
    const test = fixture({ sources: [trusted], providerResult: { answer: privateText, personalContextClaims: [{ text: "模型解释", sourceIds: [trusted.sourceId] }], interpretations: [privateText], hypotheses: [privateText] } });
    vi.mocked(test.contextResolver.resolve).mockImplementation(async () => ({ sources: available ? [trusted] : [] }));
    const request = { operationKey: "legacy_source", mode: "brainstorm" as const, contextMode: "personal" as const, message: "用户明确的问题" };
    const first = await test.service.think("account_1", request);
    available = false;
    const displayed = await test.service.getConversation("account_1", first.conversationId);
    expect(JSON.stringify(displayed)).not.toContain(privateText); expect(JSON.stringify(displayed)).not.toContain(trusted.claim.text);
    expect(displayed.messages[0].content).toBe("用户明确的问题");
    const replay = await test.service.think("account_1", request);
    expect(JSON.stringify(replay)).not.toContain(privateText); expect(replay.sources).toEqual([]);
    expect(test.provider.generate).toHaveBeenCalledTimes(1);
    vi.mocked(test.provider.generate).mockResolvedValueOnce({ answer: "只讨论当前内容", personalContextClaims: [], interpretations: [], hypotheses: [] });
    vi.mocked(test.contextResolver.resolve).mockClear();
    await test.service.think("account_1", { operationKey: "legacy_without_grant", conversationId: first.conversationId, mode: "brainstorm", contextMode: "none", message: "不再使用资料" });
    expect(test.contextResolver.resolve).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(test.provider.generate).mock.calls.at(-1)![0].history)).not.toContain(privateText);
    expect(JSON.stringify(test.store.conversations.get(first.conversationId))).toContain(privateText);
    expect(JSON.stringify(test.store.operations.get(request.operationKey))).toContain(privateText);
  });

  it("does not let an unchanged source ID authorize a previous claim or evidence version", async () => {
    const previous = source(), changed = structuredClone(previous);
    changed.claim.text = "CURRENT_REVISED_RECORD"; changed.claim.evidence[0].snippet = "CURRENT_REVISED_EVIDENCE";
    let current = previous;
    const test = fixture({ sources: [previous], providerResult: { answer: "OLD_SOURCE_VERSION_DERIVATION", personalContextClaims: [], interpretations: [], hypotheses: [] } });
    vi.mocked(test.contextResolver.resolve).mockImplementation(async () => ({ sources: [current] }));
    const first = await test.service.think("account_1", { operationKey: "original_version", mode: "brainstorm", contextMode: "personal", message: "原始用户问题" });
    current = changed;
    expect(JSON.stringify(await test.service.getConversation("account_1", first.conversationId))).not.toContain("OLD_SOURCE_VERSION_DERIVATION");
    vi.mocked(test.provider.generate).mockResolvedValueOnce({ answer: "按当前版本讨论", personalContextClaims: [], interpretations: [], hypotheses: [] });
    await test.service.think("account_1", { operationKey: "new_version", conversationId: first.conversationId, mode: "brainstorm", contextMode: "personal", message: "按修订资料继续" });
    const input = vi.mocked(test.provider.generate).mock.calls.at(-1)![0];
    expect(input.sources[0].claim.text).toBe("CURRENT_REVISED_RECORD");
    expect(JSON.stringify(input.history)).not.toContain("OLD_SOURCE_VERSION_DERIVATION");
  });

  it.each(["withdraw", "version"])("fences a generated legacy answer when its source changes during the call: %s", async change => {
    const trusted = source(); let available = true, entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const test = fixture({ sources: [trusted] });
    vi.mocked(test.contextResolver.resolve).mockImplementation(async () => ({ sources: available ? [trusted] : [] }));
    vi.mocked(test.provider.generate).mockImplementationOnce(async () => { entered(); await gate; return { answer: "PRIVATE_LATE_LEGACY_RESULT", personalContextClaims: [], interpretations: [], hypotheses: [] }; });
    const pending = test.service.think("account_1", { operationKey: `late_${change}`, mode: "brainstorm", contextMode: "personal", message: "必须保存的用户原话" });
    await ready;
    if (change === "withdraw") available = false;
    else trusted.claim.evidence[0].snippet = "changed evidence while model running";
    release();
    const response = await pending;
    expect(response.assistantMessage.completionStatus).toBe("provider_error"); expect(response.sources).toEqual([]);
    expect(JSON.stringify([...test.store.conversations.values()])).not.toContain("PRIVATE_LATE_LEGACY_RESULT");
    expect((await test.service.getConversation("account_1", response.conversationId)).messages[0].content).toBe("必须保存的用户原话");
  });

  it("rejects an ignored cancellation before publishing a late legacy provider answer", async () => {
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const test = fixture(), controller = new AbortController();
    vi.mocked(test.provider.generate).mockImplementationOnce(async () => { entered(); await gate; return { answer: "LATE_CANCELLED_LEGACY", personalContextClaims: [], interpretations: [], hypotheses: [] }; });
    const pending = test.service.think("account_1", { operationKey: "late_cancel", mode: "brainstorm", contextMode: "none", message: "用户原话保留" }, controller.signal);
    await ready; controller.abort(); release();
    const response = await pending;
    expect(response.assistantMessage.completionStatus).toBe("cancelled"); expect(response.assistantMessage.content).not.toContain("LATE_CANCELLED_LEGACY");
  });

  it("revalidates past-clues query projections with the original question rather than a different generic claim", async () => {
    const queried = source(), generic = structuredClone(queried); generic.claim.text = "不同格式的普通检索摘要";
    const test = fixture({ providerResult: { answer: "合法的过去线索回答", personalContextClaims: [], interpretations: [], hypotheses: [] } });
    vi.mocked(test.contextResolver.resolve).mockImplementation(async input => ({ sources: input.mode === "past_clues" && input.message === "过去如何选择展示方向？" ? [queried] : [generic] }));
    const first = await test.service.think("account_1", { operationKey: "past_clues_original", mode: "past_clues", contextMode: "personal", message: "过去如何选择展示方向？" });
    expect(first.assistantMessage.completionStatus).toBe("completed"); expect(first.assistantMessage.content).toBe("合法的过去线索回答");
    expect((await test.service.getConversation("account_1", first.conversationId)).messages[1].content).toBe("合法的过去线索回答");
  });

  it("persists a new no-context input during an older call and fences the late answer without overwriting either user's messages", async () => {
    const trusted = source(), test = fixture({ sources: [trusted] });
    const initial = await test.service.think("account_1", { operationKey: "concurrent_seed", mode: "brainstorm", contextMode: "none", message: "最初的问题" });
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(test.provider.generate).mockImplementationOnce(async () => { entered(); await gate; return { answer: "PRIVATE_OLDER_INFLIGHT_ANSWER", personalContextClaims: [], interpretations: [], hypotheses: [] }; });
    const pending = test.service.think("account_1", { operationKey: "older_personal", conversationId: initial.conversationId, mode: "brainstorm", contextMode: "personal", message: "先参考资料" });
    await ready;
    vi.mocked(test.provider.generate).mockResolvedValueOnce({ answer: "只按新的用户表达讨论", personalContextClaims: [], interpretations: [], hypotheses: [] });
    const newer = await test.service.think("account_1", { operationKey: "newer_none", conversationId: initial.conversationId, mode: "brainstorm", contextMode: "none", message: "撤回资料使用，只讨论现在" });
    expect(newer.assistantMessage.content).toBe("只按新的用户表达讨论");
    const afterNewer = structuredClone(test.store.conversations.get(initial.conversationId)!);
    release();
    const late = await pending;
    expect(late.assistantMessage.completionStatus).toBe("provider_error"); expect(late.sources).toEqual([]);
    expect(test.store.conversations.get(initial.conversationId)).toEqual(afterNewer);
    expect(afterNewer.messages.filter(message => message.role === "user").map(message => message.content)).toEqual(["最初的问题", "先参考资料", "撤回资料使用，只讨论现在"]);
    expect(JSON.stringify(afterNewer)).not.toContain("PRIVATE_OLDER_INFLIGHT_ANSWER");
    expect(JSON.stringify(vi.mocked(test.provider.generate).mock.calls.at(-1)![0])).not.toContain(trusted.claim.text);
    expect(test.provider.generate).toHaveBeenCalledTimes(3);
  });

  it("reopens an isolated JsonStore and safely projects withdrawn history and replay without changing the stored conversation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reflection-thinking-p3-legacy-")), accountRoot = join(directory, "account_a");
    const trusted = source(); let available = true;
    const provider: ThinkingConversationProvider = { model: "synthetic_no_provider", generate: vi.fn(async () => ({ answer: "PRIVATE_PERSISTED_LEGACY_ANSWER", personalContextClaims: [], interpretations: [], hypotheses: [] })) };
    const contextResolver: DailyReflectionThinkingContextResolver = { resolve: async input => ({ sources: input.accountId === "account_a" && available ? [trusted] : [] }) };
    try {
      const request = { operationKey: "physical_legacy", mode: "brainstorm" as const, contextMode: "personal" as const, message: "合成用户问题" };
      const first = await createDailyReflectionThinkingConversationService({ store: new JsonStore(accountRoot), provider, contextResolver }).think("account_a", request);
      const filePath = join(accountRoot, "daily-reflection-thinking-conversations", `${first.conversationId}.json`), before = readFileSync(filePath, "utf8");
      available = false;
      const reopened = createDailyReflectionThinkingConversationService({ store: new JsonStore(accountRoot), provider, contextResolver });
      expect(JSON.stringify(await reopened.getConversation("account_a", first.conversationId))).not.toContain("PRIVATE_PERSISTED_LEGACY_ANSWER");
      expect(JSON.stringify(await reopened.think("account_a", request))).not.toContain("PRIVATE_PERSISTED_LEGACY_ANSWER");
      expect(readFileSync(filePath, "utf8")).toBe(before); expect(provider.generate).toHaveBeenCalledTimes(1);
      const other = createDailyReflectionThinkingConversationService({ store: new JsonStore(join(directory, "account_b")), provider, contextResolver });
      await expect(other.getConversation("account_b", first.conversationId)).rejects.toBeInstanceOf(DailyReflectionThinkingConversationNotFoundError);
    } finally {
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("reflection-thinking-p3-legacy-")) throw new Error("Unexpected test cleanup directory");
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
