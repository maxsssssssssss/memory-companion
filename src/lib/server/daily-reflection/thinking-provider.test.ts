import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DailyReflectionThinkingMessage,
  DailyReflectionThinkingSource
} from "@/lib/domain/daily-reflection-thinking";
import type { JsonStore } from "@/lib/server/storage/json-store";

import {
  DailyReflectionThinkingProviderTimeoutError,
  OpenAiThinkingConversationProvider,
  buildDailyReflectionThinkingSystemPrompt,
  resolveDailyReflectionThinkingModel
} from "./thinking-provider";

const store = {} as JsonStore;
const client = {} as never;

function source(id: string, text: string): DailyReflectionThinkingSource {
  return {
    sourceId: id,
    claim: {
      text,
      sourceMemoryIds: [`memory_${id}`],
      sourceCardIds: [`card_${id}`],
      evidenceIds: [`segment_${id}`],
      evidence: [{
        reflectionId: `reflection_${id}`,
        cardId: `card_${id}`,
        sourceSegmentId: `segment_${id}`,
        recordingDate: "2026-08-20",
        startSeconds: 1,
        endSeconds: 4,
        snippet: text,
        sourceOrigin: "user_reflection"
      }],
      epistemicStatuses: ["explicit_user_statement"]
    }
  };
}

function historyMessage(input: {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: DailyReflectionThinkingSource[];
  safetyBoundaryVersion?: "v2" | null;
}): DailyReflectionThinkingMessage {
  const sources = input.sources ?? [];
  return {
    id: input.id,
    operationKey: `operation_${input.id}`,
    role: input.role,
    mode: "brainstorm",
    contextMode: sources.length > 0 ? "personal" : "none",
    content: input.content,
    ...(input.safetyBoundaryVersion !== undefined
      ? { safetyBoundaryVersion: input.safetyBoundaryVersion }
      : {}),
    usedPersonalContext: sources.length > 0,
    sources,
    personalContextClaims: [],
    interpretations: [],
    hypotheses: [],
    model: input.role === "assistant" ? "gpt-5.5" : null,
    createdAt: "2026-08-26T00:00:00.000Z",
    completionStatus: "completed"
  };
}

describe("Daily Reflection Thinking Provider", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("resolves OPENAI_QA_MODEL before OPENAI_TEXT_MODEL", () => {
    expect(resolveDailyReflectionThinkingModel({
      OPENAI_QA_MODEL: "gpt-5.5",
      OPENAI_TEXT_MODEL: "gpt-4.1-mini"
    })).toBe("gpt-5.5");
    expect(resolveDailyReflectionThinkingModel({
      OPENAI_TEXT_MODEL: "gpt-4.1-mini"
    })).toBe("gpt-4.1-mini");
  });

  it("asks all five modes for direct natural plain text without presentation boilerplate", () => {
    for (const mode of [
      "brainstorm",
      "clarify_decision",
      "compare_directions",
      "extend_idea",
      "past_clues"
    ] as const) {
      const prompt = buildDailyReflectionThinkingSystemPrompt(mode);
      expect(prompt).toContain("personalContextClaims");
      expect(prompt).toContain("hypotheses");
      expect(prompt).toContain("开门见山、连贯、具体");
      expect(prompt).toContain("自然中文纯文本回答");
      expect(prompt).toContain("禁止 Markdown heading");
      expect(prompt).toContain("普通编号");
      expect(prompt).toContain("不要把整篇回答机械写成清单");
      expect(prompt).toContain("不要在 answer 中输出");
      expect(prompt).toContain("前四种开放模式仍要正常、完整地回答");
    }
  });

  it("uses Responses-compatible transport without a remote request and validates source IDs", async () => {
    const requestText = vi.fn().mockResolvedValue(JSON.stringify({
      answer: "先把真正需要验证的问题写成一句话。\n\n## 一个可行起点\n从最小、可逆的实验开始，再根据结果决定是否扩大投入。",
      personalContextClaims: [],
      interpretations: ["目前是在拓宽可能性。"],
      hypotheses: ["也许先做低成本试验。"]
    }));
    const provider = new OpenAiThinkingConversationProvider({
      environment: {
        NODE_ENV: "test",
        OPENAI_QA_MODEL: "gpt-5.5",
        OPENAI_QA_WIRE_API: "responses"
      },
      clientFactory: vi.fn(async () => client),
      requestText
    });
    const output = await provider.generate({
      mode: "brainstorm",
      contextMode: "none",
      message: "一起想想下一步。",
      history: [],
      sources: [],
      settingsStore: store
    });
    expect(output.answer).toBe(
      "先把真正需要验证的问题写成一句话。\n\n一个可行起点\n从最小、可逆的实验开始，再根据结果决定是否扩大投入。"
    );
    expect(output.answer).not.toContain("##");
    expect(output.answer).not.toContain("模型解释（不代表你的历史记录或原话）");
    expect(requestText).toHaveBeenCalledTimes(1);
    expect(requestText.mock.calls[0]?.[1]).toBe("gpt-5.5");
    expect(requestText.mock.calls[0]?.[4]).toBe("responses");
  });

  it("normalizes Markdown presentation into paragraphs and ordinary numbering", async () => {
    const requestText = vi.fn().mockResolvedValue(JSON.stringify({
      answer: "## 模型解释（不代表你的历史记录或原话）：\n\n**先说结论**：方案 A 更适合做低成本验证。\n\n- 明确成功标准\n- 约定复盘时间\n\n[查看方法](https://example.test/method)\n\n| 方向 | 特点 |\n| --- | --- |\n| A | 成本低 |\n\n```text\n一天后复盘\n```",
      personalContextClaims: [],
      interpretations: ["模型解释：这两个步骤可以减少**沉没成本**。"],
      hypotheses: ["新的推演（不代表你的历史记录或原话）：也许一天就能得到第一轮信号。"]
    }));
    const provider = new OpenAiThinkingConversationProvider({
      clientFactory: vi.fn(async () => client),
      requestText
    });
    const output = await provider.generate({
      mode: "compare_directions",
      contextMode: "none",
      message: "帮我比较两个方向。",
      history: [],
      sources: [],
      settingsStore: store
    });
    expect(output.answer).toBe(
      "先说结论：方案 A 更适合做低成本验证。\n\n1. 明确成功标准\n2. 约定复盘时间\n\n查看方法（https://example.test/method）\n\n方向；特点\nA；成本低\n\n一天后复盘"
    );
    expect(output.interpretations).toEqual(["这两个步骤可以减少沉没成本。"]);
    expect(output.hypotheses).toEqual(["也许一天就能得到第一轮信号。"]);
    expect(output.answer).not.toMatch(/^\s*(?:#|[-*+]\s|```|\|)/mu);
    expect(output.answer).not.toContain("**");
  });

  it("keeps unrestricted free text outside structured personal claims", async () => {
    const requestText = vi.fn().mockResolvedValue(JSON.stringify({
      answer: "你上次把方案 A 定为首选。",
      personalContextClaims: [],
      interpretations: [],
      hypotheses: []
    }));
    const provider = new OpenAiThinkingConversationProvider({
      clientFactory: vi.fn(async () => client),
      requestText
    });
    const output = await provider.generate({
      mode: "brainstorm",
      contextMode: "none",
      message: "一起想想。",
      history: [],
      sources: [],
      settingsStore: store
    });
    expect(output.answer).toBe("你上次把方案 A 定为首选。");
    expect(output.personalContextClaims).toEqual([]);
    expect(requestText).toHaveBeenCalledTimes(1);
  });

  it("projects personal claims from the canonical allowlisted source instead of model text", async () => {
    const trusted = source("source_a", "你曾记录：先验证最小实验。");
    const requestText = vi.fn().mockResolvedValue(JSON.stringify({
      answer: "可以把它拆成一个可逆步骤。",
      personalContextClaims: [{
        text: "模型擅自改写的个人事实。",
        sourceIds: [trusted.sourceId]
      }],
      interpretations: ["这条线索适合转成验证动作。"],
      hypotheses: ["也许先定义一天内可观察的结果。"]
    }));
    const provider = new OpenAiThinkingConversationProvider({
      clientFactory: vi.fn(async () => client),
      requestText
    });
    const output = await provider.generate({
      mode: "extend_idea",
      contextMode: "personal",
      message: "继续展开。",
      history: [],
      sources: [trusted],
      settingsStore: store
    });
    expect(output.personalContextClaims).toEqual([{
      text: trusted.claim.text,
      sourceIds: [trusted.sourceId]
    }]);
    expect(output.answer).toBe("可以把它拆成一个可逆步骤。");
    expect(output.answer).not.toContain(trusted.claim.text);
    expect(output.answer).not.toContain("模型擅自改写的个人事实");
  });

  it("filters sourced assistant history against every ID in the current exact allowlist", async () => {
    const sourceA = source("source_a", "来源 A 的可信内容。");
    const sourceB = source("source_b", "来源 B 的可信内容。");
    const history = [
      historyMessage({ id: "user_old", role: "user", content: "旧用户消息。" }),
      historyMessage({
        id: "assistant_legacy_unsourced",
        role: "assistant",
        content: "普通的 legacy 助手正文也必须丢弃。"
      }),
      historyMessage({
        id: "assistant_current_unsourced",
        role: "assistant",
        content: "当前安全边界的一般助手正文。",
        safetyBoundaryVersion: "v2"
      }),
      historyMessage({
        id: "assistant_a",
        role: "assistant",
        content: "撤销来源 A 的旧助手正文 source_a。",
        sources: [sourceA],
        safetyBoundaryVersion: "v2"
      }),
      historyMessage({
        id: "assistant_b",
        role: "assistant",
        content: "仍有效来源 B 的旧助手正文。",
        sources: [sourceB],
        safetyBoundaryVersion: "v2"
      }),
      historyMessage({
        id: "assistant_ab",
        role: "assistant",
        content: "同时依赖 A 和 B 的旧助手正文。",
        sources: [sourceA, sourceB],
        safetyBoundaryVersion: "v2"
      })
    ];
    const requestText = vi.fn().mockResolvedValue(JSON.stringify({
      answer: "可以继续分析。",
      personalContextClaims: [],
      interpretations: [],
      hypotheses: []
    }));
    const provider = new OpenAiThinkingConversationProvider({
      clientFactory: vi.fn(async () => client),
      requestText
    });
    await provider.generate({
      mode: "brainstorm",
      contextMode: "personal",
      message: "继续。",
      history,
      sources: [sourceB],
      settingsStore: store
    });
    await provider.generate({
      mode: "brainstorm",
      contextMode: "personal",
      message: "继续。",
      history,
      sources: [sourceA, sourceB],
      settingsStore: store
    });
    const promptWithOnlyB = requestText.mock.calls[0]?.[3] as string;
    expect(promptWithOnlyB).toContain("旧用户消息。");
    expect(promptWithOnlyB).toContain("当前安全边界的一般助手正文。");
    expect(promptWithOnlyB).toContain("仍有效来源 B 的旧助手正文。");
    expect(promptWithOnlyB).not.toContain("普通的 legacy 助手正文");
    expect(promptWithOnlyB).not.toContain("撤销来源 A 的旧助手正文");
    expect(promptWithOnlyB).not.toContain("同时依赖 A 和 B 的旧助手正文");
    expect(promptWithOnlyB).not.toContain("source_a");
    const promptWithAAndB = requestText.mock.calls[1]?.[3] as string;
    expect(promptWithAAndB).toContain("撤销来源 A 的旧助手正文 source_a。");
    expect(promptWithAAndB).toContain("同时依赖 A 和 B 的旧助手正文。");
  });

  it("retries at most once and never accepts an invented personal source", async () => {
    const requestText = vi.fn()
      .mockResolvedValueOnce("not-json")
      .mockResolvedValueOnce(JSON.stringify({
        answer: "可以继续分析。",
        personalContextClaims: [{ text: "你以前决定过。", sourceIds: ["invented"] }],
        interpretations: [],
        hypotheses: []
      }));
    const provider = new OpenAiThinkingConversationProvider({
      clientFactory: vi.fn(async () => client),
      requestText,
      maxAttempts: 99
    });
    await expect(provider.generate({
      mode: "brainstorm",
      contextMode: "personal",
      message: "我以前怎么想？",
      history: [],
      sources: [],
      settingsStore: store
    })).rejects.toMatchObject({ name: "DailyReflectionThinkingProviderUnavailableError" });
    expect(requestText).toHaveBeenCalledTimes(2);
  });

  it("propagates caller abort and bounds provider timeout", async () => {
    const requestText = vi.fn(async (
      _client,
      _model,
      _system,
      _user,
      _wire,
      signal: AbortSignal
    ) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const aborted = new AbortController();
    aborted.abort(new DOMException("cancelled", "AbortError"));
    const provider = new OpenAiThinkingConversationProvider({
      clientFactory: vi.fn(async () => client),
      requestText,
      timeoutMs: 10
    });
    await expect(provider.generate({
      mode: "brainstorm",
      contextMode: "none",
      message: "继续想。",
      history: [],
      sources: [],
      settingsStore: store,
      signal: aborted.signal
    })).rejects.toMatchObject({ name: "AbortError" });
    await expect(provider.generate({
      mode: "brainstorm",
      contextMode: "none",
      message: "继续想。",
      history: [],
      sources: [],
      settingsStore: store
    })).rejects.toBeInstanceOf(DailyReflectionThinkingProviderTimeoutError);
  });
});
