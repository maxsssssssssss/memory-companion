import { describe, expect, it } from "vitest";
import { formatTime } from "@/lib/domain/time";
import type { BriefItem, RelationshipSignalCard, TranscriptSegment } from "@/lib/domain/types";
import { classifySegment } from "@/lib/processing/classifier";
import { extractBriefItems } from "@/lib/processing/extract-rule-based";
import { sampleTranscriptSegments } from "@/lib/processing/sample-transcript";
import { answerSameDayQuestion } from "./qa";

const segments = sampleTranscriptSegments.map(classifySegment);
const items = extractBriefItems("upload_demo", segments);
const fallbackSegment: TranscriptSegment = {
  id: "seg_user_comments_1",
  uploadId: "upload_demo",
  startSeconds: 615,
  endSeconds: 675,
  speaker: "speaker_1",
  text: "上午复盘时讨论用户评论入口需要保留证据链。",
  confidence: 0.92,
  sceneLabels: [],
  valueLabels: []
};

function briefItem(overrides: Partial<BriefItem>): BriefItem {
  return {
    id: "brief_test",
    uploadId: "upload_demo",
    category: "task",
    title: "下次见面时间需要继续跟进",
    body: "双方提到下次见面的时间还需要再确认。",
    priority: "high",
    confidence: 0.86,
    status: "confirmed",
    sourceSegmentIds: ["seg_task_1"],
    sourceTimeRange: { startSeconds: 10, endSeconds: 20 },
    transcriptExcerpt: "那我们下周再看一下具体哪天方便。",
    people: [],
    topics: ["见面安排"],
    ...overrides
  };
}

function relationshipSignal(overrides: Partial<RelationshipSignalCard> = {}): RelationshipSignalCard {
  return {
    id: "relationship_signal_upload_demo_1",
    uploadId: "upload_demo",
    date: "2026-07-09",
    signalType: "evasive_answer",
    signalCategory: "uncertain",
    severity: "medium",
    confidence: 0.74,
    summary: "关键问题之后的回应没有直接回答原问题。",
    explanation: "这可能是回避，也可能是当时没有理解问题，需要继续澄清。",
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
    suggestedReflection: "可以回到原问题，确认是暂时不方便回答还是没有理解。",
    caution: "仅凭这一小段不能确定是在故意回避。",
    createdAt: "2026-07-09T10:00:00.000Z",
    ...overrides
  };
}

const relationshipSegment: TranscriptSegment = {
  id: "seg_relationship_1",
  uploadId: "upload_demo",
  startSeconds: 60,
  endSeconds: 95,
  speaker: "speaker_2",
  text: "这个问题以后再说吧，先聊点别的。",
  confidence: 0.93,
  sceneLabels: ["unknown"],
  valueLabels: []
};

describe("answerSameDayQuestion", () => {
  it("answers commitment questions with citations", () => {
    const answer = answerSameDayQuestion("今天我答应了谁什么？", segments, items);

    expect(answer.answer).toContain("报价");
    expect(answer.citedSegmentIds.length).toBeGreaterThan(0);
  });

  it("answers English commitment category questions with citations", () => {
    const answer = answerSameDayQuestion("What commitments did I make today?", segments, items);

    expect(answer.answer).toContain("报价");
    expect(answer.citedSegmentIds).toEqual(["seg_customer_1"]);
  });

  it("routes English category plurals case-insensitively", () => {
    const categoryQuestions: Array<[string, string]> = [
      ["What COMMITMENTS did I make today?", "seg_customer_1"],
      ["What TASKS do I have today?", "seg_customer_1"],
      ["What DECISIONS did I make today?", "seg_product_1"],
      ["What IDEAS did I have today?", "seg_reflection_1"],
      ["What RISKS came up today?", "seg_risk_1"],
      ["What QUESTIONS remain today?", "seg_reflection_1"]
    ];

    categoryQuestions.forEach(([question, segmentId]) => {
      const answer = answerSameDayQuestion(question, segments, items);

      expect(answer.citedSegmentIds).toEqual([segmentId]);
    });
  });

  it("answers transcript fallback matches with timestamps and citations", () => {
    const answer = answerSameDayQuestion("今天我有没有讨论用户评论？", [fallbackSegment], []);

    expect(answer.answer).toContain(formatTime(fallbackSegment.startSeconds));
    expect(answer.answer).toContain("用户评论");
    expect(answer.citedSegmentIds).toEqual(["seg_user_comments_1"]);
  });

  it("does not delete Chinese keyword characters during fallback cleanup", () => {
    const segment: TranscriptSegment = {
      ...fallbackSegment,
      id: "seg_user_score_1",
      startSeconds: 1200,
      endSeconds: 1260,
      text: "今天只看了用户评分指标，没有阅读评论内容。"
    };
    const answer = answerSameDayQuestion("今天我有没有讨论用户评论？", [segment], []);

    expect(answer.answer).toContain("没有找到");
    expect(answer.citedSegmentIds).toEqual([]);
  });

  it("does not guess when there is no evidence", () => {
    const answer = answerSameDayQuestion("今天我有没有讨论办公室装修？", segments, items);

    expect(answer.answer).toBe("我在当前这段录音里没有找到足够证据支持这个判断。可以换成更具体的时间、人名、项目名或关键词再问。");
    expect(answer.citedSegmentIds).toEqual([]);
  });

  it("uses scope-aware no-evidence wording for week and all memory", () => {
    const weekAnswer = answerSameDayQuestion("本周有没有反复出现办公室装修？", [], [], "week_20260706_20260712", "week");
    const allAnswer = answerSameDayQuestion("过去记录里有没有长期出现办公室装修？", [], [], "all_memory", "all");

    expect(weekAnswer.answer).toBe("我在本周已处理录音里没有找到足够证据支持这个判断。可以换成更具体的时间、人名、项目名或关键词再问。");
    expect(allAnswer.answer).toBe("我在全部已处理记忆里没有找到足够证据支持这个判断。可以换成更具体的时间、人名、项目名或关键词再问。");
  });

  it("answers next-step confirmation questions from task evidence", () => {
    const answer = answerSameDayQuestion("这次录音里有哪些下一步需要确认？", [], [briefItem({})]);

    expect(answer.answer).toContain("下次见面时间需要继续跟进");
    expect(answer.citedSegmentIds).toEqual(["seg_task_1"]);
  });

  it("answers next-step confirmation questions from open question evidence", () => {
    const answer = answerSameDayQuestion(
      "这次录音里有哪些还没说清、需要继续确认的问题？",
      [],
      [
        briefItem({
          id: "brief_open_question",
          category: "open_question",
          title: "下次见面的节奏还没说清",
          body: "双方没有把下次见面的时间和边界完全确认。",
          sourceSegmentIds: ["seg_open_question_1"]
        })
      ]
    );

    expect(answer.answer).toContain("下次见面的节奏还没说清");
    expect(answer.citedSegmentIds).toEqual(["seg_open_question_1"]);
  });

  it("answers explicit commitment review questions from commitment evidence", () => {
    const answer = answerSameDayQuestion(
      "这次录音里有哪些明确承诺需要回看？",
      [],
      [
        briefItem({
          id: "brief_commitment",
          category: "commitment",
          title: "对方明确说这周会确认时间",
          body: "对方承诺这周会给出下次见面的具体时间。",
          sourceSegmentIds: ["seg_commitment_1"]
        })
      ]
    );

    expect(answer.answer).toContain("对方明确说这周会确认时间");
    expect(answer.citedSegmentIds).toEqual(["seg_commitment_1"]);
  });

  it("does not turn single-day all-memory evidence into a long-term pattern", () => {
    const answer = answerSameDayQuestion(
      "过去记录里有没有反复出现的模式？",
      [],
      [
        briefItem({
          id: "brief_single_day",
          category: "idea",
          title: "2026-07-09 · 下次见面安排",
          body: "[2026-07-09] 这次只提到一次下次见面安排。",
          sourceSegmentIds: ["seg_single_day"]
        })
      ],
      "all_memory",
      "all"
    );

    expect(answer.answer).toContain("不足以支持长期或反复模式判断");
    expect(answer.answer).toContain("2026-07-09");
    expect(answer.citedSegmentIds).toEqual(["seg_single_day"]);
  });

  it("states when week pattern evidence comes mainly from one day", () => {
    const answer = answerSameDayQuestion(
      "本周反复出现的话题是什么？",
      [],
      [
        briefItem({
          id: "brief_week_single_day",
          category: "idea",
          title: "2026-07-09 · 下次见面安排",
          body: "[2026-07-09] 这次提到下次见面安排。",
          sourceSegmentIds: ["seg_week_single_day"]
        })
      ],
      "week_20260706_20260712",
      "week"
    );

    expect(answer.answer).toContain("目前证据主要来自 2026-07-09");
    expect(answer.answer).toContain("不足以支持整周反复或变化判断");
    expect(answer.citedSegmentIds).toEqual(["seg_week_single_day"]);
  });

  it("answers relationship questions from cards when deterministic fallback is used", () => {
    const answer = answerSameDayQuestion(
      "对方有没有回避关键问题？",
      [relationshipSegment],
      [],
      "upload_demo",
      "current",
      [relationshipSignal()]
    );

    expect(answer.answer).toContain("结构化关系观察");
    expect(answer.answer).toContain("置信度：74%");
    expect(answer.answer).toContain("仅凭这一小段不能确定是在故意回避");
    expect(answer.citedSegmentIds).toEqual(["seg_relationship_1"]);
    expect(answer.citations?.[0]).toEqual(
      expect.objectContaining({
        title: "2026-07-09 · 关系信号 · 回避回答",
        sourceSegmentIds: ["seg_relationship_1"]
      })
    );
  });

  it("does not turn one relationship card into an all-memory recurring pattern", () => {
    const answer = answerSameDayQuestion(
      "过去记录里类似关系信号是否反复出现？",
      [relationshipSegment],
      [],
      "all_memory",
      "all",
      [relationshipSignal()]
    );

    expect(answer.answer).toContain("不足以支持长期或反复模式判断");
    expect(answer.answer).toContain("2026-07-09");
    expect(answer.citedSegmentIds).toEqual(["seg_relationship_1"]);
  });
});
