import { beforeEach, describe, expect, it, vi } from "vitest";

const chatCreate = vi.hoisted(() => vi.fn());
const createOpenAIClient = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/openai/client", () => ({
  createOpenAIClient,
  resolveOpenAIClientProvider: vi.fn(() => "openai-compatible")
}));

vi.mock("@/lib/server/settings/provider-config", () => ({
  getOpenAIClientRuntimeConfig: vi.fn(async () => ({ openAiApiKey: "test-key" })),
  getQaModelPreference: vi.fn(async () => "test-model"),
  getQaPromptPreference: vi.fn(async () => "")
}));

import type { BriefItem, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import {
  analyzeQaQueryIntent,
  answerQuestionWithAI,
  retrieveQaEvidence
} from "./ai-qa";
import type { QaAnswerMode, QaExecutionDiagnostics } from "./qa-observability";

const uploadId = "long-recording-60m-regression";

function segment(id: string, text: string, startSeconds: number): TranscriptSegment {
  return {
    id,
    uploadId,
    startSeconds,
    endSeconds: startSeconds + 10,
    text,
    confidence: 0.96,
    sceneLabels: ["unknown"],
    valueLabels: []
  };
}

function brief(input: {
  id: string;
  title: string;
  body: string;
  sourceSegmentIds: string[];
  startSeconds: number;
  category?: "commitment" | "task" | "decision" | "idea" | "risk" | "open_question" | "notable_quote";
  topics?: string[];
}): BriefItem {
  return {
    id: input.id,
    uploadId,
    category: input.category ?? "decision",
    title: input.title,
    body: input.body,
    priority: "high",
    confidence: 0.98,
    status: "candidate",
    sourceSegmentIds: input.sourceSegmentIds,
    sourceTimeRange: {
      startSeconds: input.startSeconds,
      endSeconds: input.startSeconds + 20
    },
    transcriptExcerpt: input.body,
    people: [],
    topics: input.topics ?? []
  };
}

function distractors(count = 18): SemanticSegment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `semantic_noise_${index}`,
    uploadId,
    title: `早期普通问题 ${index}`,
    summary: `这是与目标事件无关的早期讨论问题 ${index}。`,
    startSeconds: index * 30,
    endSeconds: index * 30 + 20,
    tags: ["普通内容"],
    sceneLabels: ["unknown"],
    valueLabels: ["open_question"],
    confidence: 0.8,
    sourceSegmentIds: [`seg_noise_${index}`],
    sourceTimeRange: { startSeconds: index * 30, endSeconds: index * 30 + 20 },
    transcriptExcerpt: `普通讨论问题 ${index}。`
  }));
}

const potteryPending = segment(
  "seg_u_088",
  "我看到课程介绍了，报名那一栏还没仔细点进去，实在不行换一场。",
  1590
);
const potteryParticipants = segment(
  "seg_u_131",
  "这次就我们两个人，不邀请朋友。",
  2440
);
const potteryAgreement = segment(
  "seg_u_132",
  "我也同意这次不邀请朋友，就订周日下午两点的两个位置。",
  2460
);
const potteryCompleted = segment(
  "seg_u_138",
  "已经提交并付款成功，确认通知也收到了。预约已经完成，参与者就是我们两个人。",
  2570
);
const potteryFinalState = segment(
  "seg_u_144",
  "现在的准确状态是预约成功，不需要等待其他结果。",
  2680
);

const potteryBriefs = [
  brief({
    id: "brief_pottery_pending",
    title: "陶艺课程报名尚未确认",
    body: "双方确认目前只确定对陶艺有兴趣；上午或下午未定，是否邀请朋友未定。",
    sourceSegmentIds: [potteryPending.id],
    startSeconds: potteryPending.startSeconds,
    category: "open_question",
    topics: ["陶艺预约"]
  }),
  brief({
    id: "brief_pottery_participants_resolved",
    title: "陶艺体验最终只预约两人，不邀请朋友",
    body: `${potteryParticipants.text}${potteryAgreement.text}`,
    sourceSegmentIds: [potteryParticipants.id, potteryAgreement.id],
    startSeconds: potteryParticipants.startSeconds,
    category: "decision",
    topics: ["陶艺预约", "参与者"]
  }),
  brief({
    id: "brief_pottery_completed",
    title: "陶艺预约已付款并完成确认",
    body: `${potteryCompleted.text}${potteryFinalState.text}`,
    sourceSegmentIds: [potteryCompleted.id, potteryFinalState.id],
    startSeconds: potteryCompleted.startSeconds,
    category: "decision",
    topics: ["陶艺预约"]
  })
];

function evidenceLabelContaining(prompt: string, marker: string) {
  const lines = prompt.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const evidenceId = lines[index]?.match(/^\[(E\d+)\]/u)?.[1];
    if (evidenceId && `${lines[index]}\n${lines[index + 1] ?? ""}`.includes(marker)) {
      return evidenceId;
    }
  }
  return undefined;
}

function mockGroundedProvider(marker: string, answerText: string) {
  chatCreate.mockImplementation(async (request: { messages: Array<{ content: string }> }) => {
    const evidenceId = evidenceLabelContaining(request.messages[1]?.content ?? "", marker);
    if (!evidenceId) throw new Error(`Expected evidence marker was not retrieved: ${marker}`);
    return {
      choices: [{
        message: {
          content: JSON.stringify({
            mode: "memory_answer",
            answer: `${answerText} [${evidenceId}]`,
            citationIds: [evidenceId]
          })
        }
      }]
    };
  });
}

function mockUnsupportedProvider() {
  chatCreate.mockResolvedValue({
    choices: [{
      message: {
        content: JSON.stringify({
          mode: "unsupported",
          answer: "我在当前记忆里没有找到足够证据支持这个判断。",
          citationIds: []
        })
      }
    }]
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  createOpenAIClient.mockReturnValue({
    chat: { completions: { create: chatCreate } }
  });
});

describe("lifecycle-aware QA retrieval", () => {
  it.each([
    "后来怎么样？",
    "最终状态是什么？",
    "有没有完成？",
    "是否确认？",
    "后续如何？",
    "现在是什么状态？"
  ])("recognizes lifecycle resolution intent: %s", (question) => {
    expect(analyzeQaQueryIntent(question)).toEqual(expect.objectContaining({
      intent: "lifecycle_resolution",
      preferLatestState: true
    }));
  });

  it.each([
    "她答应的事情都做完了吗？",
    "做完了吗？",
    "完成了吗？",
    "有没有完成？",
    "有没有做到？",
    "兑现了吗？",
    "履行了吗？",
    "实现了吗？",
    "后来做到没有？",
    "最终有没有完成？"
  ])("recognizes lifecycle resolution intent: %s", (question) => {
    expect(analyzeQaQueryIntent(question)).toEqual(expect.objectContaining({
      intent: "lifecycle_resolution",
      preferLatestState: true,
      asksForCompletionEvidence: true
    }));
  });

  it("marks all-commitments completion questions as aggregate lifecycle queries", () => {
    expect(analyzeQaQueryIntent("她答应的事情都做完了吗？")).toEqual(expect.objectContaining({
      intent: "lifecycle_resolution",
      preferLatestState: true,
      asksForCompletionEvidence: true,
      aggregateCommitmentCompletion: true
    }));
  });

  it("keeps the q017 completed booking evidence inside Top16 and before the pending state", () => {
    const evidence = retrieveQaEvidence({
      uploadId,
      question: "陶艺预约后来从未确认状态变成了什么状态？",
      segments: [potteryPending, potteryCompleted, potteryFinalState],
      semanticSegments: distractors(),
      briefItems: potteryBriefs
    });

    const completedIndex = evidence.findIndex((item) => item.id === "brief_pottery_completed");
    const pendingIndex = evidence.findIndex((item) => item.id === "brief_pottery_pending");
    expect(evidence).toHaveLength(16);
    expect(completedIndex).toBeGreaterThanOrEqual(0);
    expect(pendingIndex).toBeGreaterThanOrEqual(0);
    expect(completedIndex).toBeLessThan(pendingIndex);
    expect(evidence[completedIndex]?.sourceSegmentIds).toEqual(["seg_u_138", "seg_u_144"]);
  });

  it("keeps the q018 final participant decision ahead of the earlier undecided state", () => {
    const evidence = retrieveQaEvidence({
      uploadId,
      question: "是否邀请朋友参加陶艺课这个问题后来是怎样解决的？",
      segments: [potteryPending, potteryParticipants, potteryAgreement, potteryCompleted],
      semanticSegments: distractors(),
      briefItems: potteryBriefs
    });

    const resolvedIndex = evidence.findIndex((item) => item.id === "brief_pottery_participants_resolved");
    const pendingIndex = evidence.findIndex((item) => item.id === "brief_pottery_pending");
    expect(evidence).toHaveLength(16);
    expect(resolvedIndex).toBeGreaterThanOrEqual(0);
    expect(pendingIndex).toBeGreaterThanOrEqual(0);
    expect(resolvedIndex).toBeLessThan(pendingIndex);
    expect(evidence[resolvedIndex]?.sourceSegmentIds).toEqual(["seg_u_131", "seg_u_132"]);
  });

  it("does not treat a later completion from a different event as the same lifecycle chain", () => {
    const rehearsal = segment("seg_rehearsal_done", "周二的排练已经完成。", 3500);
    const rehearsalBrief = brief({
      id: "brief_rehearsal_completed",
      title: "周二排练已经完成",
      body: rehearsal.text,
      sourceSegmentIds: [rehearsal.id],
      startSeconds: rehearsal.startSeconds,
      category: "commitment",
      topics: ["读书会排练"]
    });
    const evidence = retrieveQaEvidence({
      uploadId,
      question: "陶艺预约后来从未确认状态变成了什么状态？",
      segments: [potteryPending, potteryCompleted, potteryFinalState, rehearsal],
      semanticSegments: distractors(),
      briefItems: [...potteryBriefs, rehearsalBrief]
    });

    const potteryIndex = evidence.findIndex((item) => item.id === "brief_pottery_completed");
    const rehearsalIndex = evidence.findIndex((item) => item.id === "brief_rehearsal_completed");
    expect(potteryIndex).toBeGreaterThanOrEqual(0);
    expect(rehearsalIndex === -1 || potteryIndex < rehearsalIndex).toBe(true);
  });

  it("keeps the legacy earlier-first tie break for non-lifecycle questions", () => {
    const evidence = retrieveQaEvidence({
      uploadId,
      question: "陶艺课讨论了哪些内容？",
      segments: [],
      semanticSegments: [],
      briefItems: [
        brief({
          id: "brief_general_early",
          title: "陶艺课普通讨论",
          body: "讨论陶艺课的基本内容。",
          sourceSegmentIds: ["seg_general_early"],
          startSeconds: 100,
          topics: ["陶艺课"]
        }),
        brief({
          id: "brief_general_late",
          title: "陶艺课普通讨论",
          body: "讨论陶艺课的基本内容。",
          sourceSegmentIds: ["seg_general_late"],
          startSeconds: 200,
          topics: ["陶艺课"]
        })
      ]
    });

    expect(evidence.map((item) => item.id)).toEqual([
      "brief_general_early",
      "brief_general_late"
    ]);
  });

  it.each<QaAnswerMode>(["agent", "direct"])(
    "gives %s the q017 completion evidence with valid source ids",
    async (answerMode) => {
      mockGroundedProvider("陶艺预约已付款并完成确认", "陶艺预约后来已经提交付款并完成确认。");
      const answer = await answerQuestionWithAI({
        uploadId,
        question: "陶艺预约后来从未确认状态变成了什么状态？",
        answerMode,
        segments: [potteryPending, potteryCompleted, potteryFinalState],
        semanticSegments: distractors(),
        briefItems: potteryBriefs
      });

      expect(answer.answer).toContain("已经提交付款并完成确认");
      expect(answer.citedSegmentIds).toEqual(["seg_u_138", "seg_u_144"]);
      expect(answer.citations?.flatMap((citation) => citation.sourceSegmentIds)).toEqual([
        "seg_u_138",
        "seg_u_144"
      ]);
    }
  );

  it.each<QaAnswerMode>(["agent", "direct"])(
    "gives %s the q018 final participant decision with valid source ids",
    async (answerMode) => {
      mockGroundedProvider("最终只预约两人，不邀请朋友", "双方最终决定只由两个人参加，不邀请朋友。");
      const answer = await answerQuestionWithAI({
        uploadId,
        question: "是否邀请朋友参加陶艺课这个问题后来是怎样解决的？",
        answerMode,
        segments: [potteryPending, potteryParticipants, potteryAgreement, potteryCompleted],
        semanticSegments: distractors(),
        briefItems: potteryBriefs
      });

      expect(answer.answer).toContain("只由两个人参加，不邀请朋友");
      expect(answer.citedSegmentIds).toEqual(["seg_u_131", "seg_u_132"]);
      expect(answer.citations?.flatMap((citation) => citation.sourceSegmentIds)).toEqual([
        "seg_u_131",
        "seg_u_132"
      ]);
    }
  );

  it.each<QaAnswerMode>(["agent", "direct"])(
    "keeps q022 unsupported answers grounded for %s mode",
    async (answerMode) => {
      mockUnsupportedProvider();
      let diagnostics: QaExecutionDiagnostics | undefined;
      const firstPromise = segment(
        "seg_u_039",
        "我周一晚上把三个讨论问题和开场提纲发给你，我会在八点前发。",
        700
      );
      const repeatedPromise = segment(
        "seg_u_173",
        "周一八点前仍按约定把三个问题和提纲发给你。",
        3200
      );
      const unrelated = segment("seg_unrelated", "课程费用这个问题还没有确认。", 3300);
      const answer = await answerQuestionWithAI({
        uploadId,
        question: "录音中是否有证据表明三个讨论问题和提纲已经发送？",
        answerMode,
        segments: [firstPromise, repeatedPromise, unrelated],
        semanticSegments: [],
        briefItems: [
          brief({
            id: "brief_send_promise_1",
            title: "周一八点前发送三个讨论问题和开场提纲",
            body: firstPromise.text,
            sourceSegmentIds: [firstPromise.id],
            startSeconds: firstPromise.startSeconds,
            category: "commitment",
            topics: ["读书会提纲"]
          }),
          brief({
            id: "brief_send_promise_2",
            title: "再次确认周一八点前发送三个问题和提纲",
            body: repeatedPromise.text,
            sourceSegmentIds: [repeatedPromise.id],
            startSeconds: repeatedPromise.startSeconds,
            category: "commitment",
            topics: ["读书会提纲"]
          }),
          brief({
            id: "brief_unrelated_question",
            title: "课程费用仍待确认",
            body: unrelated.text,
            sourceSegmentIds: [unrelated.id],
            startSeconds: unrelated.startSeconds,
            category: "open_question",
            topics: ["课程费用"]
          })
        ],
        onDiagnostics: (value) => {
          diagnostics = value;
        }
      });

      expect(answer.answer).toContain("计划或承诺");
      expect(answer.answer).toContain("没有找到已经发送完成的记录");
      expect(answer.answer).not.toContain("课程费用");
      expect(new Set(answer.citedSegmentIds)).toEqual(new Set(["seg_u_039", "seg_u_173"]));
      expect(answer.citations).toHaveLength(2);
      expect(answer.citations?.every((citation) =>
        citation.sourceSegmentIds.every((sourceId) => sourceId === "seg_u_039" || sourceId === "seg_u_173")
      )).toBe(true);
      expect(diagnostics?.fallbackReason).toBe("unsupported_answer");
    }
  );

  it.each<QaAnswerMode>(["agent", "direct"])(
    "keeps completion-confirmation answers grounded when a promise has no completion evidence in %s mode",
    async (answerMode) => {
      mockUnsupportedProvider();
      const promise = segment(
        "seg_commitment_pending",
        "speaker_2 承诺周二提交排练材料，目前只有承诺，还没有完成记录。",
        700
      );
      const unrelated = segment("seg_unrelated_relationship", "普通关系回顾没有新增状态。", 900);
      const answer = await answerQuestionWithAI({
        uploadId,
        question: "她答应的事情都做完了吗？",
        answerMode,
        segments: [promise, unrelated],
        semanticSegments: [],
        briefItems: [
          brief({
            id: "brief_commitment_pending",
            title: "speaker_2 承诺周二提交排练材料",
            body: promise.text,
            sourceSegmentIds: [promise.id],
            startSeconds: promise.startSeconds,
            category: "commitment",
            topics: ["排练材料"]
          }),
          brief({
            id: "brief_unrelated_relationship",
            title: "普通关系回顾",
            body: unrelated.text,
            sourceSegmentIds: [unrelated.id],
            startSeconds: unrelated.startSeconds,
            topics: ["关系回顾"]
          })
        ]
      });

      expect(answer.answer).toContain("已承诺");
      expect(answer.answer).toContain("已完成证据：没有找到");
      expect(answer.answer).toContain("当前状态：未知");
      expect(answer.answer).not.toContain("普通关系回顾");
      expect(answer.answer).not.toContain("我找到了这些有证据支持的内容");
      expect(answer.citedSegmentIds).toEqual([promise.id]);
      expect(answer.citations).toHaveLength(1);
    }
  );

  it.each<QaAnswerMode>(["agent", "direct"])(
    "reports completion evidence for a fulfilled promise in %s mode",
    async (answerMode) => {
      mockUnsupportedProvider();
      const completed = segment(
        "seg_commitment_completed",
        "speaker_2 承诺提交的排练材料已经完成，并且收到了确认。",
        1200
      );
      const answer = await answerQuestionWithAI({
        uploadId,
        question: "她答应的事情完成了吗？",
        answerMode,
        segments: [completed],
        semanticSegments: [],
        briefItems: [brief({
          id: "brief_commitment_completed",
          title: "speaker_2 承诺提交的排练材料已经完成",
          body: completed.text,
          sourceSegmentIds: [completed.id],
          startSeconds: completed.startSeconds,
          category: "commitment",
          topics: ["排练材料"]
        })]
      });

      expect(answer.answer).toContain("已完成证据");
      expect(answer.answer).toContain("当前状态");
      expect(answer.answer).not.toContain("当前状态：未知");
      expect(answer.citedSegmentIds).toEqual([completed.id]);
      expect(answer.citations).toHaveLength(1);
    }
  );

  it.each<QaAnswerMode>(["agent", "direct"])(
    "distinguishes partial completion from all commitments completed in %s mode",
    async (answerMode) => {
      mockUnsupportedProvider();
      const completed = segment(
        "seg_commitment_one_completed",
        "speaker_2 承诺提交的第一份材料已经完成，并且收到了确认。",
        1200
      );
      const pending = segment(
        "seg_commitment_two_pending",
        "speaker_2 承诺补充第二份材料，目前仍是承诺，还没有完成记录。",
        1600
      );
      const answer = await answerQuestionWithAI({
        uploadId,
        question: "她答应的事情都做完了吗？",
        answerMode,
        segments: [completed, pending],
        semanticSegments: [],
        briefItems: [
          brief({
            id: "brief_commitment_one_completed",
            title: "speaker_2 承诺提交的第一份材料已经完成",
            body: completed.text,
            sourceSegmentIds: [completed.id],
            startSeconds: completed.startSeconds,
            category: "commitment",
            topics: ["排练材料"]
          }),
          brief({
            id: "brief_commitment_two_pending",
            title: "speaker_2 承诺补充第二份材料",
            body: pending.text,
            sourceSegmentIds: [pending.id],
            startSeconds: pending.startSeconds,
            category: "commitment",
            topics: ["排练材料"]
          })
        ]
      });

      expect(answer.answer).toContain("已完成证据");
      expect(answer.answer).toContain("仍只有承诺");
      expect(answer.answer).toContain("只能确认部分完成");
      expect(answer.answer).toContain("不能确认所有承诺都已完成");
      expect(new Set(answer.citedSegmentIds)).toEqual(new Set([completed.id, pending.id]));
      expect(answer.citations).toHaveLength(2);
    }
  );
});
