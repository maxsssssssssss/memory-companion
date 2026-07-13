import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chatCreateMock = vi.hoisted(() => vi.fn());
const responsesCreateMock = vi.hoisted(() => vi.fn());
const createOpenAIClientMock = vi.hoisted(() => vi.fn());
const resolveOpenAIClientProviderMock = vi.hoisted(() => vi.fn());
const getOpenAIClientRuntimeConfigMock = vi.hoisted(() => vi.fn());
const getQaModelPreferenceMock = vi.hoisted(() => vi.fn());
const getQaPromptPreferenceMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/openai/client", () => ({
  createOpenAIClient: createOpenAIClientMock,
  resolveOpenAIClientProvider: resolveOpenAIClientProviderMock
}));

vi.mock("@/lib/server/settings/provider-config", () => ({
  getOpenAIClientRuntimeConfig: getOpenAIClientRuntimeConfigMock,
  getQaModelPreference: getQaModelPreferenceMock,
  getQaPromptPreference: getQaPromptPreferenceMock
}));

import type { AudioInsight, BriefItem, RelationshipSignalCard, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import { answerQuestionWithAI, buildHumanizedQaSystemPrompt } from "./ai-qa";
import type { MemoryIndexQaContext } from "./memory-index-evidence";

const originalQaWireApi = process.env.OPENAI_QA_WIRE_API;
const originalOpenAiWireApi = process.env.OPENAI_WIRE_API;

function rawSegment(overrides: Partial<TranscriptSegment>): TranscriptSegment {
  return {
    id: "seg_base",
    uploadId: "upload_1",
    startSeconds: 60,
    endSeconds: 90,
    text: "默认转写文本",
    confidence: 0.91,
    sceneLabels: ["unknown"],
    valueLabels: [],
    ...overrides
  };
}

function semanticSegment(overrides: Partial<SemanticSegment>): SemanticSegment {
  return {
    id: "semantic_1",
    uploadId: "upload_1",
    title: "智能Agent记忆与主动性",
    summary: "讨论智能Agent需要具备长期记忆、主动规划和情感驱动能力。",
    startSeconds: 120,
    endSeconds: 260,
    tags: ["产品", "灵感/想法"],
    sceneLabels: ["product_discussion"],
    valueLabels: ["idea"],
    confidence: 0.88,
    sourceSegmentIds: ["seg_agent_1", "seg_agent_2"],
    sourceTimeRange: { startSeconds: 120, endSeconds: 260 },
    transcriptExcerpt: "Agent 不能只是被动响应，要有记忆、主动规划和情感驱动。",
    ...overrides
  };
}

function briefItem(overrides: Partial<BriefItem>): BriefItem {
  return {
    id: "brief_1",
    uploadId: "upload_1",
    category: "idea",
    title: "打造具备主动意识和记忆能力的智能Agent",
    body: "规划开发一个具备主动规划、记忆和情感驱动能力的智能Agent。",
    priority: "high",
    confidence: 0.9,
    status: "candidate",
    sourceSegmentIds: ["seg_agent_1"],
    sourceTimeRange: { startSeconds: 120, endSeconds: 180 },
    transcriptExcerpt: "智能Agent不仅被动响应指令，还要主动规划和记忆。",
    people: [],
    topics: ["智能Agent"],
    ...overrides
  };
}

function audioInsight(overrides: Partial<AudioInsight>): AudioInsight {
  return {
    id: "insight_1",
    uploadId: "upload_1",
    sourceSegmentIds: ["seg_tone_1"],
    sourceTimeRange: { startSeconds: 60, endSeconds: 95 },
    speaker: { id: "speaker_2", displayName: "对方", role: "other", confidence: 0.62 },
    voice: { pace: "normal", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.35 },
    toneLabels: ["hesitant", "questioning"],
    emotionLabels: ["interested", "anxious"],
    interactionLabels: ["follow_up_question", "tension"],
    summary: "对方以试探方式追问预算风险。",
    evidence: "原文提到“预算是不是还有风险”。",
    confidence: 0.7,
    ...overrides
  };
}

function relationshipSignal(overrides: Partial<RelationshipSignalCard> = {}): RelationshipSignalCard {
  return {
    id: "relationship_signal_upload_1_1",
    uploadId: "upload_1",
    date: "2026-07-09",
    signalType: "evasive_answer",
    signalCategory: "uncertain",
    severity: "medium",
    confidence: 0.74,
    summary: "关键问题之后的回应没有直接回答原问题。",
    explanation: "这可能是回避，也可能是当时没有理解问题，需要结合原文继续澄清。",
    involvedSpeakers: ["speaker_1", "speaker_2"],
    timeRange: { startSeconds: 60, endSeconds: 95 },
    evidenceSegments: [
      {
        segmentId: "seg_relationship_1",
        speaker: "speaker_2",
        startSeconds: 60,
        endSeconds: 95,
        text: "这个问题以后再说吧，先聊点别的。"
      }
    ],
    textEvidence: ["这个问题以后再说吧，先聊点别的。"],
    suggestedReflection: "可以回到原问题，确认对方是暂时不方便回答还是没有理解。",
    caution: "仅凭这一小段不能确定是在故意回避。",
    createdAt: "2026-07-09T10:00:00.000Z",
    ...overrides
  };
}

function memoryContext(input: {
  sourceIds?: string[];
  date?: string;
  summary?: string;
} = {}): MemoryIndexQaContext {
  const date = input.date ?? "2026-07-09";
  const sourceIds = input.sourceIds ?? ["brief_1", "seg_memory_target"];
  const evidence = sourceIds.map((sourceId, index) => ({
    id: `memory_evidence_${index}`,
    memoryId: "memory_1",
    sourceType: sourceId.startsWith("seg_") ? "transcript" as const : "brief" as const,
    sourceId,
    uploadId: "upload_1",
    date,
    quote: `Original evidence for ${sourceId}`,
    createdAt: `${date}T10:00:00.000Z`
  }));
  const memory = {
    id: "memory_1",
    userId: "user_1",
    type: "commitment" as const,
    title: "Confirm the next meeting",
    summary: input.summary ?? "The next meeting time still needs confirmation.",
    importance: 0.86,
    importanceScore: 0.86,
    importanceReasons: ["commitment type"],
    status: "active" as const,
    occurrenceCount: 2,
    firstSeenDate: date,
    lastSeenDate: date,
    accessCount: 0,
    lastAccessedAt: null,
    date,
    createdAt: `${date}T10:00:00.000Z`,
    updatedAt: `${date}T10:00:00.000Z`,
    evidence
  };

  return {
    scope: "all",
    memories: [memory],
    evidence,
    sourceIds,
    distinctDates: [date],
    count: 1,
    retrievalTimeMs: 1
  };
}

describe("answerQuestionWithAI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveOpenAIClientProviderMock.mockImplementation((config: { openRouterApiKey?: string }) =>
      config?.openRouterApiKey ? "openrouter" : "openai-compatible"
    );
    getQaPromptPreferenceMock.mockResolvedValue("场景可能是商务谈判，请优先识别各方诉求、让步、风险和待确认条件。");
  });

  afterEach(() => {
    if (originalQaWireApi === undefined) {
      delete process.env.OPENAI_QA_WIRE_API;
    } else {
      process.env.OPENAI_QA_WIRE_API = originalQaWireApi;
    }
    if (originalOpenAiWireApi === undefined) {
      delete process.env.OPENAI_WIRE_API;
    } else {
      process.env.OPENAI_WIRE_API = originalOpenAiWireApi;
    }
  });

  it("builds the restrained companion prompt with evidence boundaries", () => {
    const prompt = buildHumanizedQaSystemPrompt("all");

    expect(prompt).toContain("长期陪用户复盘的人");
    expect(prompt).toContain("克制但懂你");
    expect(prompt).toContain("直接回答");
    expect(prompt).toContain("我留意到的模式");
    expect(prompt).toContain("可以怎么做");
    expect(prompt).toContain("关键结论必须使用 [E1] 这样的证据编号");
    expect(prompt).toContain("没有找到足够证据");
    expect(prompt).toContain("不建立隐藏的用户画像");
    expect(prompt).toContain("全部记忆问答");
    expect(prompt).toContain("至少两个不同日期的证据");
    expect(prompt).toContain("只有单日证据时，不能包装成长期趋势");
  });

  it("adds long-term memory safety rules to the system prompt", () => {
    const prompt = buildHumanizedQaSystemPrompt("all");

    expect(prompt).toContain("Memories are compressed observations, not ground truth");
    expect(prompt).toContain("Always prioritize original evidence");
  });

  it("uses memory source ids to promote original evidence without creating memory citations", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: { completions: { create: chatCreateMock } }
    });
    chatCreateMock.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            mode: "memory_answer",
            answer: "原始录音里提到下次见面时间仍需确认。[E1]",
            citationIds: ["E1"]
          })
        }
      }]
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const segments = Array.from({ length: 17 }, (_, index) =>
      rawSegment({
        id: index === 16 ? "seg_memory_target" : `seg_other_${index}`,
        startSeconds: index * 10,
        endSeconds: index * 10 + 8,
        text: index === 16 ? "[2026-07-09] 下次见面的时间还需要确认。" : `普通片段 ${index}`
      })
    );

    try {
      const answer = await answerQuestionWithAI({
        uploadId: "all_memory",
        question: "过去有哪些承诺需要回看？",
        scope: "all",
        segments,
        semanticSegments: [],
        briefItems: [],
        memoryContext: memoryContext({ sourceIds: ["seg_memory_target"] })
      });

      const request = chatCreateMock.mock.calls[0][0];
      expect(request.messages[1].content).toContain("[Long-term memory]");
      expect(request.messages[1].content).toContain("Original evidence: [E1]");
      expect(request.messages[1].content).toContain("The next meeting time still needs confirmation.");
      expect(answer.citedSegmentIds).toEqual(["seg_memory_target"]);
      expect(answer.citations).toEqual([
        expect.objectContaining({ id: "E1", sourceSegmentIds: ["seg_memory_target"] })
      ]);
      expect(answer.citations?.[0].title).not.toContain("Long-term memory");
      expect(info).toHaveBeenCalledWith(
        "[memory-qa] scope=all memories_used=1 evidence_used=1 fallback=false"
      );
    } finally {
      info.mockRestore();
    }
  });

  it("rejects an all-memory long-term claim when mapped original evidence has one date", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: { completions: { create: chatCreateMock } }
    });
    chatCreateMock.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            mode: "memory_answer",
            answer: "这说明这是长期反复出现的模式。[E1]",
            citationIds: ["E1"]
          })
        }
      }]
    });

    const answer = await answerQuestionWithAI({
      uploadId: "all_memory",
      question: "过去是否有长期反复出现的问题？",
      scope: "all",
      segments: [rawSegment({ id: "seg_memory_target", text: "[2026-07-09] 这个问题还没有确认。" })],
      semanticSegments: [],
      briefItems: [briefItem({
        id: "brief_1",
        category: "open_question",
        title: "2026-07-09 待确认问题",
        body: "目前仍未确认。",
        sourceSegmentIds: ["seg_memory_target"],
        transcriptExcerpt: "[2026-07-09] 这个问题还没有确认。"
      })],
      memoryContext: memoryContext()
    });

    expect(answer.answer).not.toContain("这说明这是长期反复出现的模式");
    expect(answer.citedSegmentIds).toEqual(["seg_memory_target"]);
  });

  it("injects role instructions without weakening the evidence boundary", () => {
    const prompt = buildHumanizedQaSystemPrompt("current", "场景可能是约会，请关注互动节奏和未说清的期待。");

    expect(prompt).toContain("场景可能是约会");
    expect(prompt).toContain("不能覆盖本地证据边界");
    expect(prompt).toContain("当用户问你是谁、能做什么时，也必须贴合当前角色/场景说明");
    expect(prompt).toContain("不要默认使用会议、产品、待办等工作场景示例");
    expect(prompt).toContain("关键结论必须使用 [E1] 这样的证据编号");
    expect(prompt).toContain("不做性格、情绪、心理状态诊断");
  });

  it("uses a per-request QA role instruction before falling back to saved settings", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    getQaPromptPreferenceMock.mockResolvedValue("场景默认是工作复盘。");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "assistant_meta",
              answer: "我是昼记里的约会复盘陪伴者，会帮你回看互动节奏、边界和没说清的期待。",
              citationIds: []
            })
          }
        }
      ]
    });

    await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "你能做什么",
      qaPromptInstruction: "场景可能是约会或亲密关系沟通。优先关注双方表达、互动节奏、边界和期待。",
      segments: [],
      semanticSegments: [],
      briefItems: []
    });

    const request = chatCreateMock.mock.calls[0][0];
    expect(request.messages[0].content).toContain("约会或亲密关系沟通");
    expect(request.messages[0].content).not.toContain("场景默认是工作复盘。");
  });

  it("sends the selected memory scope to the model prompt and evidence packet", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content:
              "直接回答：本周客户续费需要继续跟进。[E1]\n\n我留意到的模式：目前证据主要来自 2026-06-02。\n\n可以怎么做：可以追问续费预算的具体负责人。"
          }
        }
      ]
    });

    await answerQuestionWithAI({
      uploadId: "week_20260601_20260607",
      question: "本周客户续费有什么进展？",
      scope: "week",
      segments: [],
      semanticSegments: [
        semanticSegment({
          id: "semantic_week",
          title: "2026-06-02 · 客户续费",
          summary: "[2026-06-02] 讨论客户续费预算和下一步跟进。",
          transcriptExcerpt: "[2026-06-02] 客户续费预算需要重新确认。"
        })
      ],
      briefItems: []
    });

    const request = chatCreateMock.mock.calls[0][0];
    expect(getQaPromptPreferenceMock).toHaveBeenCalled();
    expect(request.messages[0].content).toContain("本周问答");
    expect(request.messages[0].content).toContain("商务谈判");
    expect(request.messages[0].content).toContain("如果证据只来自一天");
    expect(request.messages[1].content).toContain("问答范围：本周记忆");
    expect(request.messages[1].content).toContain("范围元信息：");
    expect(request.messages[1].content).toContain("可用证据日期：2026-06-02");
    expect(request.messages[1].content).toContain("证据条数：1");
    expect(request.messages[1].content).toContain("[E1]");
  });

  it("allows model-classified assistant identity answers without requiring memory evidence", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "assistant_meta",
              answer: "我是昼记里的本地录音记忆陪伴者，会帮你整理、回看和追问自己的录音记忆；但我不会假装记得没有证据的事。",
              citationIds: []
            })
          }
        }
      ]
    });

    const answer = await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "你是谁？",
      segments: [],
      semanticSegments: [],
      briefItems: []
    });

    expect(answer.answer).toContain("昼记");
    expect(answer.answer).toContain("本地录音记忆");
    expect(answer.answer).toContain("不会假装记得");
    expect(answer.citedSegmentIds).toEqual([]);
    expect(chatCreateMock.mock.calls[0][0].messages[0].content).toContain("assistant_meta");
  });

  it("passes recent conversation context to the model for short follow-up questions", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "memory_answer",
              answer: "可以，按发言角色来看：张三更像推动方案的人，李四更关注风险。[E1]",
              citationIds: ["E1"]
            })
          }
        }
      ]
    });

    const noisySegments = Array.from({ length: 16 }, (_, index) =>
      rawSegment({
        id: `seg_noise_${index}`,
        startSeconds: index * 10,
        endSeconds: index * 10 + 5,
        text: `普通会议背景 ${index}`
      })
    );

    await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "可以",
      conversation: [
        {
          role: "user",
          content: "你看看会议中的每个人的性格是怎么样的，分析一下"
        },
        {
          role: "assistant",
          content:
            "不适合给参会者下性格结论。如果你愿意，我可以改成分析每个人在这场会议里的发言角色、关注点、决策风格或协作方式。"
        }
      ],
      segments: [
        ...noisySegments,
        rawSegment({
          id: "seg_role_focus",
          startSeconds: 999,
          endSeconds: 1040,
          text: "张三负责推动方案，李四主要关注风险和落地代价，王五补充客户视角。"
        })
      ],
      semanticSegments: [],
      briefItems: []
    });

    const request = chatCreateMock.mock.calls[0][0];
    expect(request.messages[1].content).toContain("最近对话：");
    expect(request.messages[1].content).toContain("性格是怎么样的");
    expect(request.messages[1].content).toContain("发言角色、关注点、决策风格或协作方式");
    expect(request.messages[1].content).toContain("当前问题：可以");
    expect(request.messages[1].content).toContain("张三负责推动方案");
  });

  it("still rejects model-classified memory answers when citations are missing", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "memory_answer",
              answer: "你今天重点讨论了客户预算。",
              citationIds: []
            })
          }
        }
      ]
    });

    const answer = await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "我今天重点讨论了什么？",
      segments: [
        rawSegment({
          id: "seg_budget_1",
          text: "今天讨论了客户预算。"
        })
      ],
      semanticSegments: [],
      briefItems: []
    });

    expect(answer.answer).not.toBe("你今天重点讨论了客户预算。");
    expect(answer.answer).toContain("没有找到足够证据");
    expect(answer.citedSegmentIds).toEqual([]);
  });

  it("falls back from uncited AI answers to task evidence for proactive next-step questions", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "memory_answer",
              answer: "这次录音里下一步需要继续确认下次见面的具体时间。",
              citationIds: []
            })
          }
        }
      ]
    });

    const answer = await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "这次录音里有哪些下一步需要确认？",
      segments: [],
      semanticSegments: [],
      briefItems: [
        briefItem({
          id: "brief_task",
          category: "task",
          title: "下次见面时间需要继续跟进",
          body: "双方提到下次见面的时间还需要再确认。",
          sourceSegmentIds: ["seg_task_1"],
          transcriptExcerpt: "那我们下周再看一下具体哪天方便。"
        })
      ]
    });

    expect(answer.answer).toContain("下次见面时间需要继续跟进");
    expect(answer.answer).not.toContain("没有找到足够证据");
    expect(answer.citedSegmentIds).toEqual(["seg_task_1"]);
  });

  it("uses deterministic evidence when the AI marks a proactive question unsupported but brief evidence exists", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "unsupported",
              answer: "我在当前记忆里没有找到足够证据支持这个判断。",
              citationIds: []
            })
          }
        }
      ]
    });

    const answer = await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "这次录音里有哪些下一步需要确认？",
      segments: [],
      semanticSegments: [],
      briefItems: [
        briefItem({
          id: "brief_task",
          category: "task",
          title: "下次见面时间需要继续跟进",
          body: "双方提到下次见面的时间还需要再确认。",
          sourceSegmentIds: ["seg_task_1"],
          transcriptExcerpt: "那我们下周再看一下具体哪天方便。"
        })
      ]
    });

    expect(answer.answer).toContain("下次见面时间需要继续跟进");
    expect(answer.answer).not.toContain("没有找到足够证据");
    expect(answer.citedSegmentIds).toEqual(["seg_task_1"]);
  });

  it("uses OpenAI-compatible chat with local evidence and returns time citations", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-4o");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: "这段录音讨论了智能Agent要从被动响应升级为主动规划，并保留长期记忆。[E1]"
          }
        }
      ]
    });

    const answer = await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "Agent 相关的产品想法是什么？",
      segments: [
        rawSegment({
          id: "seg_agent_1",
          startSeconds: 120,
          endSeconds: 180,
          text: "智能Agent不仅被动响应指令，还要主动规划和记忆。",
          valueLabels: ["idea"]
        }),
        rawSegment({
          id: "seg_agent_2",
          startSeconds: 180,
          endSeconds: 260,
          text: "它还应该有情感驱动，能够主动给用户提供服务。",
          valueLabels: ["idea"]
        })
      ],
      semanticSegments: [semanticSegment({})],
      briefItems: [briefItem({})]
    });

    expect(createOpenAIClientMock).toHaveBeenCalledWith({ openRouterApiKey: "custom_key" });
    expect(chatCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openai/gpt-4o",
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "system" }),
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("[E1]")
          })
        ])
      })
    );
    expect(chatCreateMock.mock.calls[0][0].messages[1].content).toContain("智能Agent记忆与主动性");
    expect(answer.answer).toContain("主动规划");
    expect(answer.citedSegmentIds).toEqual(["seg_agent_1", "seg_agent_2"]);
    expect(answer.citations?.[0]).toEqual(
      expect.objectContaining({
        id: "E1",
        startSeconds: 120,
        endSeconds: 260,
        sourceSegmentIds: ["seg_agent_1", "seg_agent_2"]
      })
    );
  });

  it("can call the Responses API for Nexus-compatible QA gateways", async () => {
    process.env.OPENAI_QA_WIRE_API = "responses";
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openAiApiKey: "nexus_key" });
    getQaModelPreferenceMock.mockResolvedValue("gpt-5.5");
    createOpenAIClientMock.mockReturnValue({
      responses: {
        create: responsesCreateMock
      }
    });
    responsesCreateMock.mockResolvedValue({
      output_text: JSON.stringify({
        mode: "memory_answer",
        answer: "Direct answer: the recording discusses an Agent that can plan and remember. [E1]",
        citationIds: ["E1"]
      })
    });

    const answer = await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "What is the Agent idea?",
      segments: [
        rawSegment({
          id: "seg_agent_1",
          startSeconds: 120,
          endSeconds: 180,
          text: "Agent should plan proactively and remember context.",
          valueLabels: ["idea"]
        })
      ],
      semanticSegments: [
        semanticSegment({
          sourceSegmentIds: ["seg_agent_1"],
          sourceTimeRange: { startSeconds: 120, endSeconds: 180 },
          transcriptExcerpt: "Agent should plan proactively and remember context.",
          summary: "Agent planning and memory."
        })
      ],
      briefItems: []
    });

    expect(responsesCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.5",
        input: expect.arrayContaining([
          expect.objectContaining({ role: "system" }),
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("[E1]")
          })
        ])
      })
    );
    expect(chatCreateMock).not.toHaveBeenCalled();
    expect(answer.citedSegmentIds).toEqual(["seg_agent_1"]);
  });

  it("includes audio insight signals as evidence for tone and interaction questions", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "memory_answer",
              answer: "直接回答：对方这一段更像在试探性追问预算风险，不是明确反对。[E1]\n\n我留意到的模式：语气里有疑问和紧张线索。\n\n可以怎么做：可以回到具体预算边界继续确认。",
              citationIds: ["E1"]
            })
          }
        }
      ]
    });

    const answer = await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "对方这段语气怎么样？",
      segments: [
        rawSegment({
          id: "seg_tone_1",
          startSeconds: 60,
          endSeconds: 95,
          speaker: "speaker_2",
          text: "预算是不是还有风险？"
        })
      ],
      audioInsights: [audioInsight({})],
      semanticSegments: [],
      briefItems: []
    });

    const request = chatCreateMock.mock.calls[0][0];
    expect(request.messages[1].content).toContain("语气/互动线索");
    expect(request.messages[1].content).toContain("对方以试探方式追问预算风险");
    expect(request.messages[1].content).toContain("hesitant");
    expect(answer.citedSegmentIds).toEqual(["seg_tone_1"]);
    expect(answer.citations?.[0]).toEqual(
      expect.objectContaining({
        title: "对方的语气/互动线索",
        sourceSegmentIds: ["seg_tone_1"]
      })
    );
  });

  it("includes explainable acoustic signals and user corrections in tone evidence", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "memory_answer",
              answer: "直接回答：这段气氛更像是认真讨论风险，不应直接说成紧张。[E1]\n\n我留意到的模式：原文在追问预算边界，同时声音上有停顿变多和多人重叠。\n\n可以怎么做：可以回到预算条件继续确认。",
              citationIds: ["E1"]
            })
          }
        }
      ]
    });

    await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "当时气氛是不是有点紧张？",
      segments: [
        rawSegment({
          id: "seg_tone_1",
          startSeconds: 60,
          endSeconds: 95,
          speaker: "speaker_2",
          text: "预算是不是还有风险？"
        })
      ],
      audioInsights: [
        audioInsight({
          voice: {
            pace: "normal",
            volume: "high",
            pause: "many",
            overlap: true,
            confidence: 0.72,
            explanations: [
              { kind: "volume", label: "音量更高", detail: "这一段平均音量约 -16 dBFS。", confidence: 0.72 },
              { kind: "pause", label: "停顿变多", detail: "静音和停顿占比约 42%。", confidence: 0.72 },
              { kind: "overlap", label: "多人重叠", detail: "speaker_2 与 speaker_1 的转写时间发生重叠。", confidence: 0.72 }
            ]
          },
          userCorrections: [
            {
              labelCorrections: [{ from: "紧张", to: "认真" }],
              note: "用户确认这一段不是紧张，而是在认真讨论。",
              updatedAt: "2026-07-05T10:00:00.000Z"
            }
          ]
        })
      ],
      semanticSegments: [],
      briefItems: []
    });

    const request = chatCreateMock.mock.calls[0][0];
    expect(request.messages[1].content).toContain("声音依据");
    expect(request.messages[1].content).toContain("音量更高");
    expect(request.messages[1].content).toContain("停顿变多");
    expect(request.messages[1].content).toContain("多人重叠");
    expect(request.messages[1].content).toContain("用户纠正");
    expect(request.messages[1].content).toContain("紧张 -> 认真");
  });

  it("renders emotion evidence for atmosphere questions", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "memory_answer",
              answer: "直接回答：当时气氛确实偏认真、偏紧。[E1]\n\n我留意到的模式：声音线索里有停顿变多。\n\n可以怎么做：可以先确认预算边界。",
              citationIds: ["E1"]
            })
          }
        }
      ]
    });

    await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "当时气氛是不是有点紧张？",
      segments: [
        rawSegment({
          id: "seg_tone_1",
          startSeconds: 60,
          endSeconds: 95,
          speaker: "speaker_2",
          text: "预算是不是还有风险？"
        })
      ],
      audioInsights: [
        audioInsight({
          toneLabels: ["serious"],
          emotionLabels: ["anxious"],
          interactionLabels: ["tension"],
          atmosphereLabels: ["serious", "tense"],
          emotionEvidence: [
            {
              id: "emotion_evidence_1",
              kind: "atmosphere",
              label: "认真偏紧",
              normalizedLabel: "tense",
              source: "acoustic",
              confidence: 0.72,
              detail: "音量升高、停顿变多，并且多人重叠。",
              sourceSegmentIds: ["seg_tone_1"],
              sourceTimeRange: { startSeconds: 60, endSeconds: 95 },
              features: [
                { name: "volume", label: "音量更高", value: "-16", unit: "dBFS" },
                { name: "pause", label: "停顿变多", value: "42", unit: "%" }
              ]
            }
          ]
        })
      ],
      semanticSegments: [],
      briefItems: []
    });

    const request = chatCreateMock.mock.calls[0][0];
    expect(request.messages[1].content).toContain("气氛线索");
    expect(request.messages[1].content).toContain("认真偏紧");
    expect(request.messages[1].content).toContain("停顿变多");
  });

  it("keeps legacy emotion evidence without feature details usable", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "memory_answer",
              answer: "直接回答：这段旧数据记录为认真偏紧。[E1]\n\n我留意到的模式：只有气氛线索，没有更多声学特征。\n\n可以怎么做：可以回到原文确认。",
              citationIds: ["E1"]
            })
          }
        }
      ]
    });
    const legacyEmotionEvidence = {
      id: "legacy_emotion_evidence_1",
      kind: "atmosphere",
      label: "认真偏紧",
      normalizedLabel: "tense",
      source: "acoustic",
      confidence: 0.72,
      detail: "旧数据没有 features 字段。",
      sourceSegmentIds: ["seg_tone_1"],
      sourceTimeRange: { startSeconds: 60, endSeconds: 95 }
    } as unknown as NonNullable<AudioInsight["emotionEvidence"]>[number];

    await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "当时气氛是不是有点紧张？",
      segments: [
        rawSegment({
          id: "seg_tone_1",
          startSeconds: 60,
          endSeconds: 95,
          speaker: "speaker_2",
          text: "预算是不是还有风险？"
        })
      ],
      audioInsights: [
        audioInsight({
          atmosphereLabels: ["serious", "tense"],
          emotionEvidence: [legacyEmotionEvidence]
        })
      ],
      semanticSegments: [],
      briefItems: []
    });

    const request = chatCreateMock.mock.calls[0][0];
    expect(request.messages[1].content).toContain("旧数据没有 features 字段");
    expect(request.messages[1].content).toContain("认真偏紧");
  });

  it("prefers audio emotion evidence over semantic evidence for the same source on atmosphere questions", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "memory_answer",
              answer: "直接回答：优先看声音和气氛证据，这段偏认真偏紧。[E1]\n\n我留意到的模式：普通摘要和情绪证据都指向同一原始片段。\n\n可以怎么做：可以展开证据看原文。",
              citationIds: ["E1"]
            })
          }
        }
      ]
    });

    await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "这段气氛是不是有点紧张？",
      segments: [
        rawSegment({
          id: "seg_tone_1",
          startSeconds: 60,
          endSeconds: 95,
          speaker: "speaker_2",
          text: "预算是不是还有风险？"
        })
      ],
      audioInsights: [
        audioInsight({
          atmosphereLabels: ["tense"],
          emotionEvidence: [
            {
              id: "emotion_evidence_1",
              kind: "atmosphere",
              label: "认真偏紧",
              normalizedLabel: "tense",
              source: "fusion",
              confidence: 0.78,
              detail: "追问预算风险，声音特征也偏紧。",
              sourceSegmentIds: ["seg_tone_1"],
              sourceTimeRange: { startSeconds: 60, endSeconds: 95 },
              features: [{ name: "pause", label: "停顿变多", value: "42", unit: "%" }]
            }
          ]
        })
      ],
      semanticSegments: [
        semanticSegment({
          id: "semantic_tone_1",
          title: "预算风险追问",
          summary: "这段围绕预算风险展开，问题集中在预算边界。",
          sourceSegmentIds: ["seg_tone_1"],
          sourceTimeRange: { startSeconds: 60, endSeconds: 95 },
          transcriptExcerpt: "预算是不是还有风险？",
          valueLabels: ["open_question"]
        })
      ],
      briefItems: []
    });

    const request = chatCreateMock.mock.calls[0][0];
    expect(request.messages[1].content).toMatch(/\[E1\][\s\S]*气氛线索/);
    expect(request.messages[1].content).toMatch(/\[E1\][\s\S]*认真偏紧/);
  });

  it("falls back to deterministic QA when the AI answer has no explicit citations", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-4o");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: "用户评论入口需要保留证据链。"
          }
        }
      ]
    });

    const answer = await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "今天我有没有讨论用户评论？",
      segments: [
        rawSegment({
          id: "seg_comment_1",
          startSeconds: 42,
          endSeconds: 58,
          text: "今天讨论了用户评论入口怎么保留证据链。",
          valueLabels: []
        })
      ],
      semanticSegments: [],
      briefItems: []
    });

    expect(answer.answer).toContain("我找到了这些相关片段");
    expect(answer.answer).toContain("用户评论");
    expect(answer.answer).not.toBe("用户评论入口需要保留证据链。");
    expect(answer.citedSegmentIds).toEqual(["seg_comment_1"]);
  });

  it("uses relationship signal cards as composite evidence for relationship questions", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "memory_answer",
              answer:
                "直接回答：这段回应存在需要继续澄清的回避线索，卡片置信度为 74%，但不能据此判断对方的长期态度。[E1]\n\n我留意到的模式：目前只有这一小段证据。\n\n可以怎么做：可以回到原问题确认。",
              citationIds: ["E1"]
            })
          }
        }
      ]
    });

    const answer = await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "对方有没有回避关键问题？",
      segments: [
        rawSegment({
          id: "seg_relationship_1",
          startSeconds: 60,
          endSeconds: 95,
          speaker: "speaker_2",
          text: "这个问题以后再说吧，先聊点别的。"
        })
      ],
      semanticSegments: [],
      briefItems: [],
      relationshipSignals: [
        relationshipSignal({
          explanation: "这段解释刻意写得很长，用来确认引用摘要不会因为解释文本过长而截掉重要的不确定性提示。".repeat(10),
          counterEvidence: ["补充证据".repeat(180), "另一条补充证据".repeat(180)],
          acousticEvidence: [
            { audioInsightId: "insight_1", detail: "声音辅助说明".repeat(180), confidence: 0.6 }
          ]
        })
      ]
    });

    const request = chatCreateMock.mock.calls[0][0];
    expect(request.messages[0].content).toContain("Relationship Signal");
    expect(request.messages[1].content).toContain("关键问题之后的回应没有直接回答原问题");
    expect(request.messages[1].content).toContain("置信度：74%");
    expect(request.messages[1].content).toContain("仅凭这一小段不能确定是在故意回避");
    expect(request.messages[1].content).toContain("这个问题以后再说吧，先聊点别的。");
    expect(answer.citedSegmentIds).toEqual(["seg_relationship_1"]);
    expect(answer.citations?.[0]).toEqual(
      expect.objectContaining({
        title: "2026-07-09 · 关系信号 · 回避回答",
        excerpt: expect.stringContaining("仅凭这一小段不能确定是在故意回避"),
        sourceSegmentIds: ["seg_relationship_1"]
      })
    );
  });

  it("falls back to relationship card evidence when the model omits citations", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "memory_answer",
              answer: "这段回应看起来像在回避。",
              citationIds: []
            })
          }
        }
      ]
    });

    const answer = await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "对方有没有回避关键问题？",
      segments: [
        rawSegment({
          id: "seg_relationship_1",
          startSeconds: 60,
          endSeconds: 95,
          speaker: "speaker_2",
          text: "这个问题以后再说吧，先聊点别的。"
        })
      ],
      semanticSegments: [],
      briefItems: [],
      relationshipSignals: [relationshipSignal()]
    });

    expect(answer.answer).toContain("结构化关系观察");
    expect(answer.answer).toContain("置信度：74%");
    expect(answer.citedSegmentIds).toEqual(["seg_relationship_1"]);
  });

  it("keeps relationship intent for a short follow-up when deterministic fallback is used", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "memory_answer",
              answer: "可能和前面的回应有关。",
              citationIds: []
            })
          }
        }
      ]
    });

    const answer = await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "为什么？",
      conversation: [
        { role: "user", content: "对方有没有回避关键问题？" },
        { role: "assistant", content: "我会按原文证据说明。" }
      ],
      segments: [
        rawSegment({
          id: "seg_relationship_1",
          startSeconds: 60,
          endSeconds: 95,
          speaker: "speaker_2",
          text: "这个问题以后再说吧，先聊点别的。"
        })
      ],
      semanticSegments: [],
      briefItems: [],
      relationshipSignals: [relationshipSignal()]
    });

    expect(answer.answer).toContain("置信度：74%");
    expect(answer.answer).toContain("仅凭这一小段不能确定是在故意回避");
    expect(answer.citedSegmentIds).toEqual(["seg_relationship_1"]);
  });

  it("adds deterministic confidence and caution when a cited relationship answer omits them", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "memory_answer",
              answer: "这段回应有需要继续澄清的线索。[E1]",
              citationIds: ["E1"]
            })
          }
        }
      ]
    });

    const answer = await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "对方有没有回避关键问题？",
      segments: [
        rawSegment({
          id: "seg_relationship_1",
          startSeconds: 60,
          endSeconds: 95,
          speaker: "speaker_2",
          text: "这个问题以后再说吧，先聊点别的。"
        })
      ],
      semanticSegments: [],
      briefItems: [],
      relationshipSignals: [relationshipSignal()]
    });

    expect(answer.answer).toContain("置信度 74%");
    expect(answer.answer).toContain("仅凭这一小段不能确定是在故意回避");
    expect(answer.citedSegmentIds).toEqual(["seg_relationship_1"]);
  });

  it("rejects forbidden relationship judgments from the model and uses safe evidence fallback", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "memory_answer",
              answer: "对方一定在操控你，你应该分手。[E1]",
              citationIds: ["E1"]
            })
          }
        }
      ]
    });

    const answer = await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "对方有没有回避关键问题？",
      segments: [
        rawSegment({
          id: "seg_relationship_1",
          startSeconds: 60,
          endSeconds: 95,
          speaker: "speaker_2",
          text: "这个问题以后再说吧，先聊点别的。"
        })
      ],
      semanticSegments: [],
      briefItems: [],
      relationshipSignals: [relationshipSignal()]
    });

    expect(answer.answer).not.toContain("一定在操控");
    expect(answer.answer).not.toContain("应该分手");
    expect(answer.answer).toContain("仅凭这一小段不能确定是在故意回避");
    expect(answer.citedSegmentIds).toEqual(["seg_relationship_1"]);
  });

  it("does not accept an all-memory recurring-pattern claim backed by one relationship-card date", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "memory_answer",
              answer: "过去记录显示对方长期、反复回避关键问题。[E1]",
              citationIds: ["E1"]
            })
          }
        }
      ]
    });

    const answer = await answerQuestionWithAI({
      uploadId: "all_memory",
      question: "过去记录里类似关系信号是否反复出现？",
      scope: "all",
      segments: [
        rawSegment({
          id: "seg_relationship_1",
          startSeconds: 60,
          endSeconds: 95,
          speaker: "speaker_2",
          text: "你提到 2026-06-01 的那次对话，但这个问题以后再说吧。"
        })
      ],
      semanticSegments: [],
      briefItems: [],
      relationshipSignals: [relationshipSignal()]
    });

    expect(answer.answer).toContain("不足以支持长期或反复模式判断");
    expect(answer.answer).not.toContain("长期、反复回避");
    expect(answer.citedSegmentIds).toEqual(["seg_relationship_1"]);
  });

  it("does not accept a model-invented long-term pattern in current scope", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "memory_answer",
              answer: "这说明对方一直、反复回避你的关键问题。[E1]",
              citationIds: ["E1"]
            })
          }
        }
      ]
    });

    const answer = await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "对方有没有回避关键问题？",
      scope: "current",
      segments: [
        rawSegment({
          id: "seg_relationship_1",
          startSeconds: 60,
          endSeconds: 95,
          speaker: "speaker_2",
          text: "这个问题以后再说吧，先聊点别的。"
        })
      ],
      semanticSegments: [],
      briefItems: [],
      relationshipSignals: [relationshipSignal()]
    });

    expect(answer.answer).not.toContain("一直、反复回避");
    expect(answer.answer).toContain("不能确定是在故意回避");
    expect(answer.citedSegmentIds).toEqual(["seg_relationship_1"]);
  });

  it("rejects forbidden judgments for relationship questions even when no valid card is available", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openRouterApiKey: "custom_key" });
    getQaModelPreferenceMock.mockResolvedValue("openai/gpt-5-mini");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "memory_answer",
              answer: "这个人有病，你应该分手。[E1]",
              citationIds: ["E1"]
            })
          }
        }
      ]
    });

    const answer = await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "这次互动有没有让我不舒服的地方？",
      segments: [
        rawSegment({
          id: "seg_relationship_1",
          startSeconds: 60,
          endSeconds: 95,
          speaker: "speaker_2",
          text: "这个问题以后再说吧，先聊点别的。"
        })
      ],
      semanticSegments: [],
      briefItems: [],
      relationshipSignals: []
    });

    expect(answer.answer).not.toContain("有病");
    expect(answer.answer).not.toContain("应该分手");
    expect(answer.answer).toContain("没有找到足够证据");
    expect(answer.citedSegmentIds).toEqual([]);
  });

  it("surfaces a provider-model mismatch instead of silently using deterministic fallback", async () => {
    const mismatch = Object.assign(
      new Error(
        "QA model provider mismatch: provider=openai-compatible model=openai/gpt-5-mini expected_env=OPENAI_QA_MODEL"
      ),
      { name: "QaModelProviderMismatchError", model: "openai/gpt-5-mini" }
    );
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openAiApiKey: "tokenhub_key" });
    getQaModelPreferenceMock.mockRejectedValue(mismatch);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      answerQuestionWithAI({
        uploadId: "upload_1",
        question: "What commitments were made?",
        segments: [],
        semanticSegments: [],
        briefItems: [briefItem({ category: "commitment" })]
      })
    ).rejects.toBe(mismatch);

    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/provider=openai-compatible/));
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/selected_model=openai\/gpt-5-mini/));
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/fallback_reason=model_provider_mismatch/));
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/elapsed_ms=\d+/));
  });

  it("logs provider, selected model, fallback reason and elapsed time for provider failures", async () => {
    getOpenAIClientRuntimeConfigMock.mockResolvedValue({ openAiApiKey: "tokenhub_key" });
    getQaModelPreferenceMock.mockResolvedValue("gpt-5.5");
    createOpenAIClientMock.mockReturnValue({
      chat: {
        completions: {
          create: chatCreateMock
        }
      }
    });
    chatCreateMock.mockRejectedValue(new Error("upstream unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const answer = await answerQuestionWithAI({
      uploadId: "upload_1",
      question: "What commitments were made?",
      segments: [],
      semanticSegments: [],
      briefItems: [briefItem({ category: "commitment" })]
    });

    expect(answer.citedSegmentIds).toEqual(["seg_agent_1"]);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/provider=openai-compatible/));
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/selected_model=gpt-5.5/));
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/fallback_reason=provider_error/));
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/elapsed_ms=\d+/));
  });
});
