import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDeepseekMemoryRelevanceJudge } from "./deepseek-judge";
import type { MemoryRelevanceCandidate, MemoryRelevanceCurrentContext } from "./types";

const originalEnv = {
  provider: process.env.MEMORY_RELEVANCE_PROVIDER,
  proactiveProvider: process.env.PROACTIVE_INSIGHT_PROVIDER,
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseUrl: process.env.DEEPSEEK_BASE_URL,
  model: process.env.DEEPSEEK_MODEL,
  timeout: process.env.MEMORY_RELEVANCE_TIMEOUT_MS,
  outputTokens: process.env.MEMORY_RELEVANCE_MAX_OUTPUT_TOKENS
};

const current: MemoryRelevanceCurrentContext = {
  referenceDate: "2026-07-13",
  topics: ["一起玩合作游戏"],
  briefItems: ["两个人讨论下一局怎么配合"],
  semanticSummaries: ["游戏过程中的轻松互动"],
  relationshipSignals: ["对方听完建议后调整了玩法"]
};

const candidates: MemoryRelevanceCandidate[] = [
  {
    memoryId: "memory_game",
    memoryRef: "memory:memory_game",
    type: "relationship_signal",
    summary: "之前一起玩游戏时会回应对方的建议",
    dates: ["2026-07-10"],
    importanceScore: 0.74,
    status: "active",
    occurrenceCount: 2,
    evidenceSummaries: ["2026-07-10: 好，我按你说的试试"]
  },
  {
    memoryId: "memory_travel",
    memoryRef: "memory:memory_travel",
    type: "commitment",
    summary: "曾讨论旅行计划",
    dates: ["2026-07-01"],
    importanceScore: 0.9,
    status: "active",
    occurrenceCount: 1,
    evidenceSummaries: ["2026-07-01: 下个月再确认旅行日期"]
  }
];

function restoreEnv(name: keyof typeof originalEnv, envName: string) {
  const value = originalEnv[name];
  if (value === undefined) {
    delete process.env[envName];
  } else {
    process.env[envName] = value;
  }
}

describe("DeepSeek memory relevance judge", () => {
  beforeEach(() => {
    process.env.MEMORY_RELEVANCE_PROVIDER = "deepseek";
    process.env.PROACTIVE_INSIGHT_PROVIDER = "deepseek";
    process.env.DEEPSEEK_API_KEY = "test_key";
    delete process.env.DEEPSEEK_BASE_URL;
    delete process.env.DEEPSEEK_MODEL;
    delete process.env.MEMORY_RELEVANCE_TIMEOUT_MS;
    delete process.env.MEMORY_RELEVANCE_MAX_OUTPUT_TOKENS;
  });

  afterEach(() => {
    restoreEnv("provider", "MEMORY_RELEVANCE_PROVIDER");
    restoreEnv("proactiveProvider", "PROACTIVE_INSIGHT_PROVIDER");
    restoreEnv("apiKey", "DEEPSEEK_API_KEY");
    restoreEnv("baseUrl", "DEEPSEEK_BASE_URL");
    restoreEnv("model", "DEEPSEEK_MODEL");
    restoreEnv("timeout", "MEMORY_RELEVANCE_TIMEOUT_MS");
    restoreEnv("outputTokens", "MEMORY_RELEVANCE_MAX_OUTPUT_TOKENS");
  });

  it("returns the batch decision and sends only compact current context and memory summaries", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            results: [
              {
                memoryId: "memory_game",
                shouldUse: true,
                relevanceScore: 0.91,
                usefulnessScore: 0.82,
                reason: "The earlier game interaction can support a concrete follow-up."
              },
              {
                memoryId: "memory_travel",
                shouldUse: false,
                relevanceScore: 0.12,
                usefulnessScore: 0.08,
                reason: "The travel plan is unrelated to the current game interaction."
              }
            ]
          })
        }
      }]
    });
    const judge = createDeepseekMemoryRelevanceJudge({
      clientFactory: () => ({ chat: { completions: { create } } })
    });

    const result = await judge.judge({ current, candidates });

    expect(result).toMatchObject({
      status: "judged",
      provider: "deepseek",
      model: "deepseek-v4-flash"
    });
    expect(result.rawResults).toHaveLength(2);
    const request = create.mock.calls[0]?.[0] as { messages: Array<{ content: string }> };
    expect(request.messages[0]?.content).toContain("High importance alone is never a reason");
    expect(request.messages[1]?.content).toContain("memory_travel");
    expect(request.messages[1]?.content).toContain("一起玩合作游戏");
    expect(request.messages[1]?.content).not.toContain("sourceSegmentIds");
  });

  it("falls back on invalid JSON without retrying", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "not-json" } }]
    });
    const judge = createDeepseekMemoryRelevanceJudge({
      clientFactory: () => ({ chat: { completions: { create } } })
    });

    const result = await judge.judge({ current, candidates });

    expect(result).toMatchObject({ status: "fallback", failureCode: "invalid_json" });
    expect(result.rawResults).toEqual([]);
    expect(create).toHaveBeenCalledOnce();
  });
});

