import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProactiveInsightContext } from "@/lib/domain/proactive-insights";

import { createDeepseekProactiveInsightProvider } from "./deepseek-provider";
import type { ProactiveInsightMemoryContext } from "./memory-context";

function context(): ProactiveInsightContext {
  return {
    schemaVersion: 1,
    scope: "current",
    referenceDate: "2026-07-10",
    dateRange: {
      startDate: "2026-07-10",
      endDate: "2026-07-10"
    },
    sourceUploadIds: ["upload_1"],
    distinctDates: ["2026-07-10"],
    truncated: false,
    evidence: [
      {
        evidenceId: "relationship_signal:card_1",
        kind: "relationship_signal",
        sourceType: "relationship_signal",
        sourceId: "card_1",
        uploadId: "upload_1",
        recordingDate: "2026-07-10",
        sourceSegmentIds: ["seg_1"],
        timeRange: {
          startSeconds: 10,
          endSeconds: 18
        },
        title: "Risk clue",
        summary: "A tense local moment.",
        excerpt: "Are you listening right now?",
        caution: "Only a local clue from this excerpt.",
        signalCategory: "risk"
      },
      {
        evidenceId: "brief:item_1",
        kind: "brief",
        sourceType: "brief",
        sourceId: "item_1",
        uploadId: "upload_1",
        recordingDate: "2026-07-10",
        sourceSegmentIds: ["seg_2"],
        timeRange: {
          startSeconds: 19,
          endSeconds: 28
        },
        title: "Follow-up",
        summary: "A concrete next step.",
        excerpt: "Let's revisit it tomorrow."
      }
    ]
  };
}

function memoryContext(): ProactiveInsightMemoryContext {
  return {
    scope: "current",
    currentUploadId: "upload_1",
    truncated: false,
    relations: [
      {
        relationId: "relation_follow_up",
        relationType: "follow_up",
        confidence: 0.82,
        sourceMemoryRef: "memory:question_1",
        targetMemoryRef: "memory:commitment_1"
      }
    ],
    memories: [
      {
        evidenceId: "memory:commitment_1",
        memoryId: "commitment_1",
        type: "commitment",
        title: "Confirm the next meeting",
        summary: "A future meeting time still needs confirmation.",
        importanceScore: 0.86,
        confidence: "high",
        status: "active",
        lifecycleKind: "active_commitment",
        occurrenceCount: 2,
        dates: ["2026-07-08", "2026-07-09"],
        sourceUploadIds: ["upload_history_1", "upload_history_2"],
        evidence: [
          {
            sourceType: "transcript",
            sourceId: "history_segment_1",
            uploadId: "upload_history_1",
            recordingDate: "2026-07-08",
            excerpt: "Let's confirm the time tomorrow."
          },
          {
            sourceType: "transcript",
            sourceId: "history_segment_2",
            uploadId: "upload_history_2",
            recordingDate: "2026-07-09",
            excerpt: "We still need to settle the exact time."
          }
        ]
      },
      {
        evidenceId: "memory:question_1",
        memoryId: "question_1",
        type: "question",
        title: "An unresolved follow-up",
        summary: "A previous question still needs clarification.",
        importanceScore: 0.82,
        confidence: "high",
        status: "active",
        lifecycleKind: "unresolved_question",
        occurrenceCount: 1,
        dates: ["2026-07-09"],
        sourceUploadIds: ["upload_history_2"],
        evidence: [
          {
            sourceType: "transcript",
            sourceId: "history_question_segment",
            uploadId: "upload_history_2",
            recordingDate: "2026-07-09",
            excerpt: "We still need to talk through that question."
          }
        ]
      }
    ]
  };
}

type ProviderDependencies = NonNullable<Parameters<typeof createDeepseekProactiveInsightProvider>[0]>;
type ClientFactory = NonNullable<ProviderDependencies["clientFactory"]>;
type MockClient = ReturnType<ClientFactory>;
type CreateRequest = Parameters<MockClient["chat"]["completions"]["create"]>[0];
type CreateResponse = Awaited<ReturnType<MockClient["chat"]["completions"]["create"]>>;

function mockCreate(response: CreateResponse) {
  return vi.fn<(request: CreateRequest) => Promise<CreateResponse>>().mockResolvedValue(response);
}

function mockRejectedCreate(error: Error) {
  return vi.fn<(request: CreateRequest) => Promise<CreateResponse>>().mockRejectedValue(error);
}

const envSnapshot = {
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseUrl: process.env.DEEPSEEK_BASE_URL,
  model: process.env.DEEPSEEK_MODEL,
  timeout: process.env.PROACTIVE_INSIGHT_TIMEOUT_MS,
  retries: process.env.PROACTIVE_INSIGHT_MAX_RETRIES,
  maxOutputTokens: process.env.PROACTIVE_INSIGHT_MAX_OUTPUT_TOKENS,
  maxItems: process.env.PROACTIVE_INSIGHT_MAX_ITEMS,
  provider: process.env.PROACTIVE_INSIGHT_PROVIDER
};

describe("createDeepseekProactiveInsightProvider", () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "deepseek_key";
    delete process.env.DEEPSEEK_BASE_URL;
    delete process.env.DEEPSEEK_MODEL;
    delete process.env.PROACTIVE_INSIGHT_TIMEOUT_MS;
    delete process.env.PROACTIVE_INSIGHT_MAX_RETRIES;
    delete process.env.PROACTIVE_INSIGHT_MAX_OUTPUT_TOKENS;
    delete process.env.PROACTIVE_INSIGHT_MAX_ITEMS;
  });

  afterEach(() => {
    if (envSnapshot.apiKey === undefined) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = envSnapshot.apiKey;
    }
    if (envSnapshot.baseUrl === undefined) {
      delete process.env.DEEPSEEK_BASE_URL;
    } else {
      process.env.DEEPSEEK_BASE_URL = envSnapshot.baseUrl;
    }
    if (envSnapshot.model === undefined) {
      delete process.env.DEEPSEEK_MODEL;
    } else {
      process.env.DEEPSEEK_MODEL = envSnapshot.model;
    }
    if (envSnapshot.timeout === undefined) {
      delete process.env.PROACTIVE_INSIGHT_TIMEOUT_MS;
    } else {
      process.env.PROACTIVE_INSIGHT_TIMEOUT_MS = envSnapshot.timeout;
    }
    if (envSnapshot.retries === undefined) {
      delete process.env.PROACTIVE_INSIGHT_MAX_RETRIES;
    } else {
      process.env.PROACTIVE_INSIGHT_MAX_RETRIES = envSnapshot.retries;
    }
    if (envSnapshot.maxOutputTokens === undefined) {
      delete process.env.PROACTIVE_INSIGHT_MAX_OUTPUT_TOKENS;
    } else {
      process.env.PROACTIVE_INSIGHT_MAX_OUTPUT_TOKENS = envSnapshot.maxOutputTokens;
    }
    if (envSnapshot.maxItems === undefined) {
      delete process.env.PROACTIVE_INSIGHT_MAX_ITEMS;
    } else {
      process.env.PROACTIVE_INSIGHT_MAX_ITEMS = envSnapshot.maxItems;
    }
    if (envSnapshot.provider === undefined) {
      delete process.env.PROACTIVE_INSIGHT_PROVIDER;
    } else {
      process.env.PROACTIVE_INSIGHT_PROVIDER = envSnapshot.provider;
    }
  });

  it("returns validated generated insights on success and sends strict request config", async () => {
    process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com";
    process.env.DEEPSEEK_MODEL = "deepseek-v4-pro";
    process.env.PROACTIVE_INSIGHT_TIMEOUT_MS = "3456";
    process.env.PROACTIVE_INSIGHT_MAX_RETRIES = "2";
    process.env.PROACTIVE_INSIGHT_MAX_OUTPUT_TOKENS = "1500";
    process.env.PROACTIVE_INSIGHT_MAX_ITEMS = "2";

    const create = mockCreate({
      choices: [
        {
          message: {
            content: JSON.stringify({
              items: [
                {
                  type: "relationship_question",
                  insightType: "reflection",
                  category: "relationship",
                  observation: "A tense check-in appeared in one clear moment.",
                  question: "What felt most tense in that exchange?",
                  reason: "The evidence shows a specific interaction clue worth unpacking.",
                  evidenceIds: ["relationship_signal:card_1", "brief:item_1"],
                  memoryRefs: [],
                  confidence: 0.79,
                  caution: "This is a local reflection prompt, not a relationship conclusion."
                }
              ]
            })
          }
        }
      ]
    });
    const clientFactory = vi.fn<ClientFactory>(
      (config): MockClient => ({
        chat: {
          completions: {
            create
          }
        }
      })
    );

    const provider = createDeepseekProactiveInsightProvider({
      clientFactory,
      now: () => 2000,
      logger: {
        info: vi.fn(),
        warn: vi.fn()
      }
    });

    const result = await provider.generate({
      context: context(),
      createdAt: "2026-07-10T12:00:00.000Z"
    });

    expect(clientFactory).toHaveBeenCalledWith({
      apiKey: "deepseek_key",
      baseURL: "https://api.deepseek.com",
      timeout: 3456,
      maxRetries: 0
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "deepseek-v4-pro",
        response_format: { type: "json_object" },
        stream: false,
        max_tokens: 1500,
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "system" }),
          expect.objectContaining({ role: "user" })
        ]),
        thinking: {
          type: "disabled"
        }
      })
    );
    expect(result.status).toBe("generated");
    expect(result.provider).toBe("deepseek");
    expect(result.model).toBe("deepseek-v4-pro");
    expect(result.failureCode).toBeUndefined();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.insightType).toBe("reflection");
    expect(result.items[0]?.memoryRefs).toEqual([]);
    expect(result.items[0]?.caution).toContain("This is a local reflection prompt");
    expect(result.items[0]?.caution).toContain("Only a local clue from this excerpt.");

    const request = create.mock.calls[0]?.[0];
    const prompts = (request?.messages as Array<{ content?: string }> | undefined)
      ?.map((message) => message.content ?? "")
      .join("\n") ?? "";
    expect(prompts).toContain(
      "exactly these fields: type, insightType, category, observation, question, reason, evidenceIds, memoryRefs, confidence, caution"
    );
    expect(prompts).toContain("Do not output Markdown, comments, or additional fields");
  });

  it("accepts a valid JSON object wrapped in a markdown code fence", async () => {
    const create = mockCreate({
      choices: [
        {
          message: {
            content: `\`\`\`json\n${JSON.stringify({
              items: [
                {
                  type: "reflection",
                  category: "summary",
                  observation: "A concrete follow-up appears.",
                  question: "What should be revisited next?",
                  reason: "The current brief contains a traceable next step.",
                  evidenceIds: ["brief:item_1"],
                  confidence: 0.72
                }
              ]
            })}\n\`\`\``
          }
        }
      ]
    });
    const provider = createDeepseekProactiveInsightProvider({
      clientFactory: vi.fn<ClientFactory>(() => ({ chat: { completions: { create } } })),
      logger: { info: vi.fn(), warn: vi.fn() }
    });

    const result = await provider.generate({ context: context() });

    expect(result.status).toBe("generated");
    expect(result.items).toHaveLength(1);
  });

  it.each([
    {
      label: "missing evidenceIds",
      candidate: {
        type: "reflection",
        category: "summary",
        observation: "A concrete observation.",
        question: "What should be revisited?",
        reason: "The current evidence suggests a follow-up.",
        confidence: 0.72
      },
      detail: "evidenceIds:invalid_type"
    },
    {
      label: "invalid type",
      candidate: {
        type: "unsupported_type",
        category: "summary",
        observation: "A concrete observation.",
        question: "What should be revisited?",
        reason: "The current evidence suggests a follow-up.",
        evidenceIds: ["brief:item_1"],
        confidence: 0.72
      },
      detail: "type:invalid_enum_value"
    }
  ])("falls back with a field-level schema log for $label", async ({ candidate, detail }) => {
    const create = mockCreate({
      choices: [{ message: { content: JSON.stringify({ items: [candidate] }) } }]
    });
    const logger = { info: vi.fn(), warn: vi.fn() };
    const provider = createDeepseekProactiveInsightProvider({
      clientFactory: vi.fn<ClientFactory>(() => ({ chat: { completions: { create } } })),
      logger
    });

    const result = await provider.generate({ context: context() });

    expect(result).toMatchObject({ status: "fallback", failureCode: "invalid_schema", items: [] });
    const logMessage = String(logger.warn.mock.calls[0]?.[0] ?? "");
    expect(logMessage).toContain("rejection_reasons=invalid_schema:1");
    expect(logMessage).toContain(`schema_rejections=${detail}:1`);
    expect(logMessage).not.toContain("A concrete observation");
  });

  it("adds traceable long-term memory to the prompt without presenting it as ground truth", async () => {
    const create = mockCreate({
      choices: [
        {
          message: {
            content: JSON.stringify({ items: [] })
          }
        }
      ]
    });
    const provider = createDeepseekProactiveInsightProvider({
      clientFactory: vi.fn<ClientFactory>(() => ({
        chat: {
          completions: {
            create
          }
        }
      })),
      logger: {
        info: vi.fn(),
        warn: vi.fn()
      }
    });

    await provider.generate({
      context: context(),
      memoryContext: memoryContext()
    });

    const request = create.mock.calls[0]?.[0];
    const systemPrompt = String(
      (request?.messages as Array<{ role?: string; content?: string }> | undefined)?.find(
        (message) => message.role === "system"
      )?.content ?? ""
    );
    const userPrompt = String(
      (request?.messages as Array<{ role?: string; content?: string }> | undefined)?.find(
        (message) => message.role === "user"
      )?.content ?? ""
    );

    expect(systemPrompt).toContain("compressed observations");
    expect(systemPrompt).toContain("not ground truth");
    expect(systemPrompt).toContain("Do not infer personality");
    expect(systemPrompt).toContain("Ignore unrelated memories and still generate current-only insights");
    expect(systemPrompt).toContain("过去曾出现类似情况，可以进一步关注");
    expect(systemPrompt).toContain("follow_up_question | unresolved_issue | reflection");
    expect(systemPrompt).toContain("summary | relationship | tone | follow_up | memory");
    expect(systemPrompt).toContain("mentions previous, earlier, 之前, 过去, 历史, 再次, or 重复");
    expect(systemPrompt).toContain("你是一个陪伴型助手，不是心理咨询师");
    expect(systemPrompt).toContain("值得留意的小事情");
    expect(systemPrompt).toContain("最多输出 3 条");
    expect(systemPrompt).toContain("你们之前提到的这个问题，后来有继续聊吗？");
    expect(systemPrompt).toContain("关系质量、长期方向、沟通一致性、认知偏差");
    expect(systemPrompt).toContain("Do not claim that a commitment was broken");
    expect(systemPrompt).toContain("pattern_observation");
    expect(userPrompt).toContain("[Long-term Memory]");
    expect(userPrompt).toContain("Lifecycle: active_commitment");
    expect(userPrompt).toContain("Lifecycle: unresolved_question");
    expect(userPrompt).toContain("[Memory Relations]");
    expect(userPrompt).toContain("relation=follow_up");
    expect(userPrompt).toContain("memory:commitment_1");
    expect(userPrompt).toContain("2026-07-08");
    expect(userPrompt).toContain("history_segment_1");
    expect(userPrompt).toContain("Allowed current evidence IDs: relationship_signal:card_1, brief:item_1");
    expect(userPrompt).toContain("Allowed memory evidence IDs: memory:commitment_1, memory:question_1");
    expect(userPrompt).toContain('"memoryRefs": [\n        "memory:commitment_1"');
    expect(userPrompt).toContain("Every item must cite at least one current evidence ID");
  });

  it("accepts only memory-aware output that cites both current and known memory evidence", async () => {
    const create = mockCreate({
      choices: [
        {
          message: {
            content: JSON.stringify({
              items: [
                {
                  type: "follow_up_question",
                  category: "memory",
                  observation: "The current follow-up resembles two earlier dated confirmations.",
                  question: "What still needs to be confirmed this time?",
                  reason: "Current evidence and existing memory both point to a useful clarification.",
                  evidenceIds: ["brief:item_1", "memory:commitment_1"],
                  confidence: 0.76
                },
                {
                  type: "follow_up_question",
                  category: "memory",
                  observation: "This cites an invented memory.",
                  question: "Should this invented memory be trusted?",
                  reason: "It should not be accepted.",
                  evidenceIds: ["brief:item_1", "memory:missing"],
                  confidence: 0.9
                }
              ]
            })
          }
        }
      ]
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn()
    };
    const provider = createDeepseekProactiveInsightProvider({
      clientFactory: vi.fn<ClientFactory>(() => ({
        chat: {
          completions: {
            create
          }
        }
      })),
      logger
    });

    const result = await provider.generate({
      context: context(),
      memoryContext: memoryContext(),
      createdAt: "2026-07-10T12:00:00.000Z"
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.question).toBe("What still needs to be confirmed this time?");
    expect(result.items[0]?.evidenceRefs.map((item) => item.evidenceId)).toEqual(["brief:item_1"]);
    expect(result.items[0]?.sourceUploadIds).toEqual([
      "upload_1",
      "upload_history_1",
      "upload_history_2"
    ]);
    const logMessage = String(logger.info.mock.calls[0]?.[0] ?? "");
    expect(logMessage).toContain("accepted=1 rejected=1");
    expect(logMessage).toContain("rejection_reasons=unknown_evidence:1");
  });

  it("returns fallback for illegal base urls without constructing a client or logging secrets", async () => {
    process.env.DEEPSEEK_BASE_URL = "https://evil.example.com";
    const clientFactory = vi.fn<ClientFactory>();
    const logger = {
      info: vi.fn(),
      warn: vi.fn()
    };
    const provider = createDeepseekProactiveInsightProvider({
      clientFactory,
      now: () => 1200,
      logger
    });

    const result = await provider.generate({
      context: context()
    });

    expect(result).toMatchObject({
      status: "fallback",
      failureCode: "invalid_base_url",
      items: []
    });
    expect(clientFactory).not.toHaveBeenCalled();
    const logMessage = String(logger.warn.mock.calls[0]?.[0] ?? "");
    expect(logMessage).not.toContain("deepseek_key");
    expect(logMessage).not.toContain("Are you listening right now?");
    expect(logMessage).not.toContain("Let's revisit it tomorrow.");
  });

  it("returns fallback results for missing keys, invalid json, api errors, and timeouts", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn()
    };

    delete process.env.DEEPSEEK_API_KEY;
    const missingKeyProvider = createDeepseekProactiveInsightProvider({
      clientFactory: vi.fn(),
      now: () => 100,
      logger
    });
    await expect(missingKeyProvider.generate({ context: context() })).resolves.toMatchObject({
      status: "fallback",
      failureCode: "missing_api_key",
      items: []
    });

    process.env.DEEPSEEK_API_KEY = "deepseek_key";
    const invalidJsonProvider = createDeepseekProactiveInsightProvider({
      clientFactory: vi.fn<ClientFactory>(
        (): MockClient => ({
          chat: {
            completions: {
              create: mockCreate({
                choices: [
                  {
                    message: {
                      content: "not json"
                    }
                  }
                ]
              })
            }
          }
        })
      ),
      now: () => 200,
      logger
    });
    await expect(invalidJsonProvider.generate({ context: context() })).resolves.toMatchObject({
      status: "fallback",
      failureCode: "invalid_json",
      items: []
    });

    const apiErrorProvider = createDeepseekProactiveInsightProvider({
      clientFactory: vi.fn<ClientFactory>(
        (): MockClient => ({
          chat: {
            completions: {
              create: mockRejectedCreate(new Error("boom"))
            }
          }
        })
      ),
      now: () => 300,
      logger
    });
    await expect(apiErrorProvider.generate({ context: context() })).resolves.toMatchObject({
      status: "fallback",
      failureCode: "api_error",
      items: []
    });

    const abortError = new Error("request timed out");
    abortError.name = "APIConnectionTimeoutError";
    const timeoutProvider = createDeepseekProactiveInsightProvider({
      clientFactory: vi.fn<ClientFactory>(
        (): MockClient => ({
          chat: {
            completions: {
              create: mockRejectedCreate(abortError)
            }
          }
        })
      ),
      now: () => 400,
      logger
    });
    await expect(timeoutProvider.generate({ context: context() })).resolves.toMatchObject({
      status: "fallback",
      failureCode: "timeout",
      items: []
    });
  });

  it("clamps timeout to 30000 and forces retries to zero", async () => {
    process.env.PROACTIVE_INSIGHT_TIMEOUT_MS = "45000";
    process.env.PROACTIVE_INSIGHT_MAX_RETRIES = "7";

    const create = mockCreate({
      choices: [
        {
          message: {
            content: JSON.stringify({ items: [] })
          }
        }
      ]
    });
    const clientFactory = vi.fn<ClientFactory>(
      (config): MockClient => ({
        chat: {
          completions: {
            create
          }
        }
      })
    );

    const provider = createDeepseekProactiveInsightProvider({
      clientFactory,
      now: () => 600
    });

    await provider.generate({
      context: context()
    });

    expect(clientFactory).toHaveBeenCalledWith({
      apiKey: "deepseek_key",
      baseURL: "https://api.deepseek.com",
      timeout: 30000,
      maxRetries: 0
    });
  });

  it("accepts shorter positive timeouts and still keeps retries at zero", async () => {
    process.env.PROACTIVE_INSIGHT_TIMEOUT_MS = "2500";
    process.env.PROACTIVE_INSIGHT_MAX_RETRIES = "1";

    const create = mockCreate({
      choices: [
        {
          message: {
            content: JSON.stringify({ items: [] })
          }
        }
      ]
    });
    const clientFactory = vi.fn<ClientFactory>(
      (config): MockClient => ({
        chat: {
          completions: {
            create
          }
        }
      })
    );

    const provider = createDeepseekProactiveInsightProvider({
      clientFactory,
      now: () => 700
    });

    await provider.generate({
      context: context()
    });

    expect(clientFactory).toHaveBeenCalledWith({
      apiKey: "deepseek_key",
      baseURL: "https://api.deepseek.com",
      timeout: 2500,
      maxRetries: 0
    });
  });

  it("returns generated empty results without constructing a client when evidence is empty", async () => {
    const clientFactory = vi.fn();
    const provider = createDeepseekProactiveInsightProvider({
      clientFactory,
      now: () => 500,
      logger: {
        info: vi.fn(),
        warn: vi.fn()
      }
    });

    const result = await provider.generate({
      context: {
        ...context(),
        evidence: []
      }
    });

    expect(result).toMatchObject({
      status: "generated",
      items: [],
      provider: "deepseek"
    });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("rejects unsupported model names before any request", async () => {
    process.env.DEEPSEEK_MODEL = "tenant/deepseek-v4-flash";
    const clientFactory = vi.fn();
    const provider = createDeepseekProactiveInsightProvider({
      clientFactory,
      now: () => 1000
    });

    const result = await provider.generate({
      context: context()
    });

    expect(result.status).toBe("fallback");
    expect(result.failureCode).toBe("invalid_model");
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("logs metadata only on success", async () => {
    const create = mockCreate({
      choices: [
        {
          message: {
            content: JSON.stringify({ items: [] })
          }
        }
      ]
    });
    const clientFactory = vi.fn<ClientFactory>(
      (): MockClient => ({
        chat: {
          completions: {
            create
          }
        }
      })
    );
    const logger = {
      info: vi.fn(),
      warn: vi.fn()
    };

    const provider = createDeepseekProactiveInsightProvider({
      clientFactory,
      now: () => 1300,
      logger
    });

    await provider.generate({
      context: context()
    });

    const logMessage = String(logger.info.mock.calls[0]?.[0] ?? "");
    expect(logMessage).toContain("provider=deepseek");
    expect(logMessage).not.toContain("deepseek_key");
    expect(logMessage).not.toContain("Are you listening right now?");
    expect(logMessage).not.toContain("Let's revisit it tomorrow.");
  });
});
