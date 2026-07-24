import { describe, expect, it } from "vitest";
import type { QuestionAnswer } from "@/lib/domain/types";
import {
  estimateVoiceWordCount,
  generateVoiceFollowUpQuestion,
  optimizeVoiceResponse,
  VOICE_RESPONSE_EMPTY_FALLBACK,
  VOICE_RESPONSE_MAX_WORDS,
  voiceResponseSourceFromQuestionAnswer
} from "./response-optimizer";

function questionAnswer(overrides: Partial<QuestionAnswer> = {}): QuestionAnswer {
  return {
    id: "answer_1",
    uploadId: "upload_1",
    question: "今天有什么重要的事？",
    answer: "你们确认了周二晚上的安排。[E1]",
    citedSegmentIds: ["segment_1"],
    citations: [{
      id: "E1",
      title: "相关片段",
      startSeconds: 12,
      endSeconds: 18,
      excerpt: "周二晚上七点",
      sourceSegmentIds: ["segment_1"]
    }],
    createdAt: "2026-07-21T00:00:00.000Z",
    ...overrides
  };
}

describe("VoiceResponseOptimizer", () => {
  it("compresses a long answer, removes spoken formatting, and retains uncertainty", () => {
    const answer = [
      "# 简短回答",
      "- 你们先确认了明天需要继续沟通。[E1]",
      "- 对方答应会提前说明时间和地点。[E2]",
      "- 你也提到自己希望先听完，再决定是否调整原来的安排。",
      "- 记录里还包含路程、天气、晚饭、节目和购物等背景细节。",
      "- 这些背景能帮助还原场景，但不直接改变已经确认的安排。",
      "- 目前的记录只能支持这一次约定，不能证明以后每次都会照做。",
      "- 如果之后出现新的记录，还需要把前后的变化放在一起看。",
      "- 这里还有一些不适合在语音里逐条朗读的辅助信息。",
      "- 最后还有一段重复说明，用来确保原始回答明显超过语音长度上限。"
    ].join("\n");

    const result = optimizeVoiceResponse({
      responseMode: "VOICE",
      response: {
        answer,
        evidence: ["segment_1", "segment_2"],
        confidence: 0.72,
        citations: [{ id: "E1" }, { id: "E2" }]
      }
    });

    expect(estimateVoiceWordCount(result.spoken_text)).toBeLessThanOrEqual(VOICE_RESPONSE_MAX_WORDS);
    expect(result.spoken_text).not.toMatch(/[#*\[\]]|^\s*[-+]\s/u);
    expect(result.spoken_text).not.toContain("E1");
    expect(result.spoken_text).toContain("不能证明以后每次都会照做");
    expect(result.omitted_details.omitted).toBe(true);
    expect(result.omitted_details.reason_codes).toEqual(
      expect.arrayContaining(["citations", "length", "list_compaction", "markdown"])
    );
  });

  it("preserves evidence, confidence, and citations in the internal result", () => {
    const evidence = [{ sourceId: "segment_1", quote: "周二晚上七点" }];
    const citations = [{ id: "E1", sourceSegmentIds: ["segment_1"] }];
    const response = {
      answer: "你们约的是周二晚上七点。[E1]",
      evidence,
      confidence: 0.91,
      citations
    };
    const snapshot = structuredClone(response);

    const result = optimizeVoiceResponse({ responseMode: "VOICE", response });

    expect(result.spoken_text).toBe("你们约的是周二晚上七点。");
    expect(result.internal).toEqual({
      original_answer: response.answer,
      evidence,
      confidence: 0.91,
      citations
    });
    expect(result.internal.evidence).toBe(evidence);
    expect(result.internal.citations).toBe(citations);
    expect(response).toEqual(snapshot);
  });

  it("removes mechanical record references without speaking their identifiers", () => {
    const result = optimizeVoiceResponse({
      responseMode: "VOICE",
      response: {
        answer: "直接回答：根据记忆记录 #123，你们确认了周二晚上的安排，证据 E1 也指向同一段对话。",
        evidence: ["segment_1"]
      }
    });

    expect(result.spoken_text).toBe("你们确认了周二晚上的安排，也指向同一段对话。");
    expect(result.spoken_text).not.toMatch(/#123|E1|记忆记录/u);
    expect(result.omitted_details.reason_codes).toEqual(
      expect.arrayContaining(["citations", "robotic_preamble"])
    );
  });

  it("keeps an uncertainty boundary when shortening the surrounding detail", () => {
    const repeatedDetail = Array.from({ length: 7 }, (_, index) =>
      `第${index + 1}段补充了当时沟通的背景、顺序和现场细节。`
    ).join("");
    const result = optimizeVoiceResponse({
      responseMode: "VOICE",
      response: {
        answer: `这次记录里出现了一次具体的照顾行为。${repeatedDetail}不过，这还不足以说明以后所有情况都会一样。`,
        evidence: ["segment_1"]
      }
    });

    expect(result.spoken_text).toContain("还不足以说明以后所有情况都会一样");
    expect(result.omitted_details.reason_codes).toContain("length");
  });

  it("reserves room for a trailing safety boundary when the first sentence exceeds the budget", () => {
    const longFirstSentence = Array.from(
      { length: 18 },
      (_, index) => `第${index + 1}项背景补充了沟通发生时的顺序和现场细节，`
    ).join("") + "这些内容共同构成了很长的第一句话。";
    const result = optimizeVoiceResponse({
      responseMode: "VOICE",
      response: {
        answer: `${longFirstSentence}不过，这一次具体行为不能证明以后每次都会如此，也不代表所有情况。`,
        evidence: ["segment_1"]
      }
    });

    expect(estimateVoiceWordCount(result.spoken_text)).toBeLessThanOrEqual(VOICE_RESPONSE_MAX_WORDS);
    expect(result.spoken_text).toContain("不能证明以后每次都会如此");
    expect(result.spoken_text).toContain("不代表所有情况");
    expect(result.omitted_details.reason_codes).toContain("length");
  });

  it("uses a safe empty fallback without inventing evidence", () => {
    const result = optimizeVoiceResponse({
      responseMode: "VOICE",
      response: { answer: "   ", evidence: [], citations: [] }
    });

    expect(result.spoken_text).toBe(VOICE_RESPONSE_EMPTY_FALLBACK);
    expect(result.follow_up_question).toBeUndefined();
    expect(result.internal.evidence).toEqual([]);
    expect(result.internal.citations).toEqual([]);
  });

  it("leaves normal TEXT answers byte-for-byte unchanged", () => {
    const answer = "# 原始标题\n- 第一项 [E1]\n- 第二项";
    const result = optimizeVoiceResponse({
      responseMode: "TEXT",
      response: { answer, evidence: ["segment_1"] }
    });

    expect(result.spoken_text).toBe(answer);
    expect(result.omitted_details).toMatchObject({ omitted: false, reason_codes: [] });
  });

  it("offers a neutral follow-up only when explicitly enabled and support is weak", () => {
    const weakResponse = { answer: "目前还不能确定。", confidence: 0.4, evidence: [] };

    expect(generateVoiceFollowUpQuestion(weakResponse)).toBe("你愿意再补充一点相关细节吗？");
    expect(optimizeVoiceResponse({
      responseMode: "VOICE",
      response: weakResponse
    }).follow_up_question).toBeUndefined();
    expect(optimizeVoiceResponse({
      responseMode: "VOICE",
      response: weakResponse,
      allowFollowUpQuestion: true
    }).follow_up_question).toBe("你愿意再补充一点相关细节吗？");
    expect(generateVoiceFollowUpQuestion({
      answer: "已经确认。",
      confidence: 0.9,
      evidence: ["segment_1"]
    })).toBeUndefined();
  });

  it("adapts the existing QuestionAnswer without exposing citations in speech", () => {
    const answer = questionAnswer();
    const source = voiceResponseSourceFromQuestionAnswer(answer);
    const result = optimizeVoiceResponse({ responseMode: "VOICE", response: source });

    expect(result.spoken_text).toBe("你们确认了周二晚上的安排。");
    expect(result.internal.evidence).toEqual(["segment_1"]);
    expect(result.internal.citations).toEqual(answer.citations);
  });
});
