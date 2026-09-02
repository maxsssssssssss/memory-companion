import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import type {
  DailyReflectionAiReviewCanonicalSource,
  DailyReflectionAiReviewProviderDraft
} from "@/lib/domain/daily-reflection-ai-review";
import type { OpenAIClientRuntimeConfig } from "@/lib/server/openai/client";
import type { requestQaAnswerText } from "@/lib/server/retrieval/qa-provider";
import type { JsonStore } from "@/lib/server/storage/json-store";

import {
  createDailyReflectionAiReviewProvider,
  DailyReflectionAiReviewProviderOutputError,
  DailyReflectionAiReviewProviderTimeoutError,
  resolveDailyReflectionAiReviewGptModel
} from "./ai-review-provider";

const settingsStore = {} as JsonStore;

function source(sourceId: string, index = 1): DailyReflectionAiReviewCanonicalSource {
  const cardId = `card_${index}`;
  return {
    sourceId,
    sourceKind: "resurfaced_memory",
    title: `来源 ${index}`,
    content: `服务端 canonical 内容 ${index}`,
    memoryIds: [`memory_${index}`],
    cardIds: [cardId],
    recordingDates: [`2026-08-${String(20 + index).padStart(2, "0")}`],
    evidence: [{
      reflectionId: `reflection_${index}`,
      cardId,
      recordingDate: `2026-08-${String(20 + index).padStart(2, "0")}`,
      sourceOrigin: "user_reflection",
      sourceSegmentId: `segment_${index}`,
      startSeconds: 0,
      endSeconds: 2,
      snippet: `脱敏证据 ${index}`
    }],
    epistemicStatuses: ["explicit_user_statement"]
  };
}

function draft(overrides: Partial<DailyReflectionAiReviewProviderDraft> = {}) {
  return {
    schemaVersion: 1 as const,
    selectedSourceIds: ["source_1"],
    observations: [{
      sourceIds: ["source_1"],
      interpretation: "一种可能的理解。",
      followUpQuestion: "你想继续确认什么？"
    }],
    ...overrides
  };
}

function input(sources = [source("source_1")]) {
  return {
    scope: "daily" as const,
    startDate: "2026-08-21",
    endDate: "2026-08-21",
    sources,
    settingsStore
  };
}

function harness(options: {
  text?: string;
  wireApi?: "chat" | "responses";
  timeoutMs?: number;
  requestText?: typeof requestQaAnswerText;
  runtimeConfig?: OpenAIClientRuntimeConfig;
} = {}) {
  const client = {} as OpenAI;
  const getRuntimeConfig = vi.fn(async () => options.runtimeConfig ?? ({
    openAiApiKey: "test-key",
    openAiBaseUrl: "https://example.invalid/v1"
  }));
  const clientFactory = vi.fn(() => client);
  const requestText = vi.fn(options.requestText ?? (async (...args) => {
    const requestOptions = args[4];
    requestOptions.onUsage?.({ outputTokenCount: 41, totalTokenCount: 151 });
    return options.text ?? JSON.stringify(draft());
  }));
  let now = 1_000;
  const provider = createDailyReflectionAiReviewProvider({
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    wireApi: options.wireApi ?? "responses",
    getRuntimeConfig,
    clientFactory,
    requestText,
    now: () => {
      const value = now;
      now += 25;
      return value;
    }
  });
  return {
    provider,
    getRuntimeConfig,
    clientFactory,
    requestText
  };
}

describe("Daily Reflection AI Review Provider", () => {
  it.each(["chat", "responses"] as const)(
    "uses the dedicated GPT role through the %s seam exactly once with safe usage metrics",
    async (wireApi) => {
      const setup = harness({ wireApi });

      const result = await setup.provider.generate(input());

      expect(result).toEqual({
        draft: draft(),
        model: "gpt-5.5",
        elapsedMs: 25,
        usage: { outputTokenCount: 41, totalTokenCount: 151 }
      });
      expect(setup.getRuntimeConfig).toHaveBeenCalledWith(settingsStore);
      expect(setup.clientFactory).toHaveBeenCalledWith(expect.objectContaining({
        timeoutMs: 480_000,
        maxRetries: 0
      }));
      expect(setup.requestText).toHaveBeenCalledTimes(1);
      expect(setup.requestText.mock.calls[0]?.[4]).toMatchObject({ wireApi });
      expect(setup.requestText.mock.calls[0]?.[2]).toContain(
        "followUpQuestion 必须为 null"
      );
    }
  );

  it("keeps the dedicated GPT role on an account-scoped OpenRouter transport", async () => {
    const setup = harness({
      runtimeConfig: {
        openRouterApiKey: "test-key",
        openRouterBaseUrl: "https://openrouter.ai/api/v1"
      }
    });

    const result = await setup.provider.generate(input());

    expect(result.model).toBe("openai/gpt-5.5");
    expect(setup.requestText).toHaveBeenCalledTimes(1);
  });

  it("pins the GPT alias independently of ordinary QA model preferences", () => {
    expect(resolveDailyReflectionAiReviewGptModel("openai-compatible"))
      .toBe("gpt-5.5");
    expect(resolveDailyReflectionAiReviewGptModel("openrouter"))
      .toBe("openai/gpt-5.5");
  });

  it("rejects extra output fields as an invalid strict schema without fallback", async () => {
    const setup = harness({
      text: JSON.stringify({ ...draft(), historicalFact: "不得进入契约" })
    });

    await expect(setup.provider.generate(input())).rejects.toMatchObject({
      name: "DailyReflectionAiReviewProviderOutputError",
      code: "invalid_schema"
    });
    expect(setup.requestText).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "unknown source",
      value: draft({
        selectedSourceIds: ["source_unknown"],
        observations: [{
          sourceIds: ["source_unknown"],
          interpretation: "推演",
          followUpQuestion: null
        }]
      })
    },
    {
      label: "selected source not used",
      value: draft({
        selectedSourceIds: ["source_1", "source_2"]
      })
    },
    {
      label: "more than four sources in one observation",
      value: draft({
        selectedSourceIds: ["source_1", "source_2", "source_3", "source_4", "source_5"],
        observations: [{
          sourceIds: ["source_1", "source_2", "source_3", "source_4", "source_5"],
          interpretation: "推演",
          followUpQuestion: null
        }]
      })
    }
  ])("rejects $label while keeping the exact source union", async ({ value }) => {
    const sources = [1, 2, 3, 4, 5].map((index) => source(`source_${index}`, index));
    const setup = harness({ text: JSON.stringify(value) });

    await expect(setup.provider.generate(input(sources))).rejects.toBeInstanceOf(
      DailyReflectionAiReviewProviderOutputError
    );
    expect(setup.requestText).toHaveBeenCalledTimes(1);
  });

  it("times out one in-flight request with SDK retries zero and never falls back", async () => {
    const setup = harness({
      timeoutMs: 5,
      requestText: async (...args) => {
        const signal = args[4]?.signal;
        if (!signal) throw new Error("missing test AbortSignal");
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    });

    await expect(setup.provider.generate(input())).rejects.toBeInstanceOf(
      DailyReflectionAiReviewProviderTimeoutError
    );
    expect(setup.requestText).toHaveBeenCalledTimes(1);
    expect(setup.clientFactory).toHaveBeenCalledWith(expect.objectContaining({
      maxRetries: 0,
      timeoutMs: 5
    }));
  });

  it("rejects non-JSON output after one request without a repair or fallback call", async () => {
    const setup = harness({ text: "not-json" });

    await expect(setup.provider.generate(input())).rejects.toMatchObject({
      code: "invalid_json"
    });
    expect(setup.requestText).toHaveBeenCalledTimes(1);
  });
});
