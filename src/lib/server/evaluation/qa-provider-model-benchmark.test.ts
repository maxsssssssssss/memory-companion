import { describe, expect, it } from "vitest";

import type { QuestionAnswer } from "@/lib/domain/types";
import type { QaRetrievedEvidence } from "@/lib/server/retrieval/ai-qa";

import {
  createQaProviderModelSchedule,
  evaluateQaProviderModelQuality,
  loadQaProviderModelDataset,
  QaProviderModelQuestionSchema
} from "./qa-provider-model-benchmark";

function evidence(
  id: string,
  text: string,
  sourceId: string
): QaRetrievedEvidence {
  return {
    id,
    kind: "raw",
    title: text,
    text,
    startSeconds: 0,
    endSeconds: 10,
    sourceSegmentIds: [sourceId],
    priority: 1
  };
}

function answer(
  text: string,
  citations: Array<{ id: string; sourceId: string }>
): QuestionAnswer {
  return {
    id: "answer-1",
    uploadId: "upload-1",
    question: "question",
    answer: text,
    citedSegmentIds: citations.map((item) => item.sourceId),
    citations: citations.map((item) => ({
      id: item.id,
      title: "Evidence",
      startSeconds: 0,
      endSeconds: 10,
      excerpt: "Synthetic evidence",
      sourceSegmentIds: [item.sourceId]
    })),
    createdAt: "2026-07-23T00:00:00.000Z"
  };
}

function question(input: {
  id: string;
  kind: "lifecycle" | "aggregate_lifecycle" | "unsupported" | "summary";
  expectedState: "resolved" | "pending" | "partial_or_unknown" | "not_applicable";
  text: string;
  groups?: string[][];
}) {
  return QaProviderModelQuestionSchema.parse({
    id: input.id,
    category: input.kind === "unsupported"
      ? "unsupported"
      : input.kind === "summary"
        ? "summary"
        : "lifecycle",
    question: input.text,
    expectedScope: "current",
    evaluation: {
      kind: input.kind,
      expectedState: input.expectedState,
      requiredAnswerAnyOf: input.groups ?? []
    }
  });
}

describe("QA Provider model benchmark", () => {
  it("loads the focused long-recording-60m dataset", async () => {
    const dataset = await loadQaProviderModelDataset(
      "benchmark/qa-provider-model/long-recording-60m.json"
    );

    expect(dataset.questions.map((item) => item.id)).toEqual(
      expect.arrayContaining(["q017", "q018", "q022", "q034", "q040"])
    );
    expect(dataset.questions).toHaveLength(5);
  });

  it("counterbalances model order without changing the questions", async () => {
    const dataset = await loadQaProviderModelDataset(
      "benchmark/qa-provider-model/long-recording-60m.json"
    );
    const schedule = createQaProviderModelSchedule(
      dataset.questions,
      3,
      "model-benchmark-test"
    );

    expect(schedule).toHaveLength(15);
    for (const id of dataset.questions.map((item) => item.id)) {
      const pairs = schedule.filter((item) => item.question.id === id);
      expect(pairs).toHaveLength(3);
      expect(new Set(pairs.flatMap((item) => item.models))).toEqual(
        new Set(["gpt-5.5", "ds-v4"])
      );
      expect(new Set(pairs.map((item) => item.models[0])).size).toBe(2);
    }
  });

  it("accepts resolved lifecycle evidence for q017", () => {
    const prompt = question({
      id: "q017",
      kind: "lifecycle",
      expectedState: "resolved",
      text: "陶艺预约后来从未确认状态变成了什么状态？",
      groups: [
        ["预约完成", "预约成功"],
        ["付款", "确认通知"]
      ]
    });
    const result = evaluateQaProviderModelQuality({
      question: prompt,
      answer: answer("后来已经付款并收到确认通知，预约完成。[E1]", [
        { id: "E1", sourceId: "s1" }
      ]),
      evidence: [
        evidence("E1", "陶艺预约已经提交并付款成功，确认通知也收到了，预约完成。", "s1")
      ],
      fallbackStatus: "none"
    });

    expect(result.citation.finalValid).toBe(true);
    expect(result.lifecycle.citedStates).toContain("resolved");
    expect(result.lifecycle.pass).toBe(true);
    expect(result.finalQualityPass).toBe(true);
  });

  it("recognizes grounded unsupported handling for q022", () => {
    const prompt = question({
      id: "q022",
      kind: "unsupported",
      expectedState: "pending",
      text: "录音中是否有证据表明三个讨论问题和提纲已经发送？"
    });
    const result = evaluateQaProviderModelQuality({
      question: prompt,
      answer: answer(
        "目前没有找到已经发送的证据，只能确认她承诺周一前会把提纲发出。[E1]",
        [{ id: "E1", sourceId: "s1" }]
      ),
      evidence: [evidence("E1", "我答应周一晚上八点前发送三个问题和提纲。", "s1")],
      fallbackStatus: "unsupported_answer"
    });

    expect(result.unsupported.grounded).toBe(true);
    expect(result.unsupported.pass).toBe(true);
    expect(result.providerPath).toBe("grounded_unsupported");
    expect(result.finalQualityPass).toBe(true);
  });

  it("accepts concise q022 answers that begin with a direct no", () => {
    const prompt = question({
      id: "q022",
      kind: "unsupported",
      expectedState: "pending",
      text: "录音中是否有证据表明三个讨论问题和提纲已经发送？"
    });
    const result = evaluateQaProviderModelQuality({
      question: prompt,
      answer: answer(
        "没有。当前录音里只能证明她承诺周一前发送，并未出现已经发送的证据。[E1]",
        [{ id: "E1", sourceId: "s1" }]
      ),
      evidence: [evidence("E1", "我答应周一晚上八点前发送三个问题和提纲。", "s1")],
      fallbackStatus: "none"
    });

    expect(result.unsupported.pass).toBe(true);
  });

  it("requires q034 to preserve partial or unknown completion", () => {
    const prompt = question({
      id: "q034",
      kind: "aggregate_lifecycle",
      expectedState: "partial_or_unknown",
      text: "她答应的事情都做完了吗？"
    });
    const items = [
      evidence("E1", "陶艺预约已经付款完成并收到确认。", "s1"),
      evidence("E2", "她答应周一前发送提纲，周二陪练。", "s2")
    ];
    const safe = evaluateQaProviderModelQuality({
      question: prompt,
      answer: answer(
        "不能确认她答应的事情全部做完：陶艺预约完成了，但提纲和正式陪练仍只有承诺。[E1][E2]",
        [
          { id: "E1", sourceId: "s1" },
          { id: "E2", sourceId: "s2" }
        ]
      ),
      evidence: items,
      fallbackStatus: "none"
    });
    const unsafe = evaluateQaProviderModelQuality({
      question: prompt,
      answer: answer("她答应的事情已经全部做完了。[E1]", [
        { id: "E1", sourceId: "s1" }
      ]),
      evidence: items,
      fallbackStatus: "none"
    });

    expect(safe.lifecycle.citedStates).toEqual(["pending", "resolved"]);
    expect(safe.lifecycle.pass).toBe(true);
    expect(unsafe.lifecycle.pass).toBe(false);
    expect(unsafe.finalQualityPass).toBe(false);
  });

  it("accepts q034 when future arrangements are explicitly not completed", () => {
    const prompt = question({
      id: "q034",
      kind: "aggregate_lifecycle",
      expectedState: "partial_or_unknown",
      text: "她答应的事情都做完了吗？"
    });
    const result = evaluateQaProviderModelQuality({
      question: prompt,
      answer: answer(
        "陶艺预约已完成；排练和通知只是已有明确约定，是后续安排，还没有到执行时间。[E1][E2]",
        [
          { id: "E1", sourceId: "s1" },
          { id: "E2", sourceId: "s2" }
        ]
      ),
      evidence: [
        evidence("E1", "陶艺预约已经付款完成。", "s1"),
        evidence("E2", "她答应周二陪练。", "s2")
      ],
      fallbackStatus: "none"
    });

    expect(result.lifecycle.pass).toBe(true);
  });

  it("accepts grounded q034 wording observed in the Compact Evidence A/B run", () => {
    const prompt = question({
      id: "q034",
      kind: "aggregate_lifecycle",
      expectedState: "partial_or_unknown",
      text: "她答应的事情都做完了吗？"
    });
    const items = [
      evidence("E1", "陶艺预约已经付款完成并收到确认。", "s1"),
      evidence("E2", "她答应周二陪练，之后到时间再处理。", "s2")
    ];

    for (const text of [
      "没有证据表明她答应的事都做完了。陶艺预约已经完成，但排练只是已有明确约定，不能算已完成。[E1][E2]",
      "没有证据显示她答应的事都已经做完。陶艺预约已完成，但排练只是约定，不等于已完成。[E1][E2]"
    ]) {
      const result = evaluateQaProviderModelQuality({
        question: prompt,
        answer: answer(text, [
          { id: "E1", sourceId: "s1" },
          { id: "E2", sourceId: "s2" }
        ]),
        evidence: items,
        fallbackStatus: "none"
      });

      expect(result.lifecycle.citedStates).toEqual(["pending", "resolved"]);
      expect(result.lifecycle.pass).toBe(true);
      expect(result.finalQualityPass).toBe(true);
    }
  });

  it("fails closed when inline citation metadata is missing", () => {
    const prompt = question({
      id: "q040",
      kind: "summary",
      expectedState: "not_applicable",
      text: "总结一下今天的事情。"
    });
    const result = evaluateQaProviderModelQuality({
      question: prompt,
      answer: answer("今天主要讨论了读书会和陶艺安排。[E2]", [
        { id: "E1", sourceId: "s1" }
      ]),
      evidence: [evidence("E1", "今天讨论了读书会和陶艺安排。", "s1")],
      fallbackStatus: "none"
    });

    expect(result.citation.inlineMetadataAligned).toBe(false);
    expect(result.finalQualityPass).toBe(false);
  });
});
