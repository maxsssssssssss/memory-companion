import { describe, expect, it } from "vitest";

import {
  optimizeStreamingVoiceSentence,
  preflightStreamingVoiceSentences,
  type StreamingVoiceSentenceInput
} from "./streaming-response-optimizer";

function groundedSentence(
  overrides: Partial<StreamingVoiceSentenceInput> = {}
): StreamingVoiceSentenceInput {
  return {
    sequence: 1,
    sentence: "你们已经确认了周日的安排。[E1]",
    supportIds: ["segment_1"],
    citedSegmentIds: ["segment_1"],
    groundingValidated: true,
    ...overrides
  };
}

describe("optimizeStreamingVoiceSentence", () => {
  it("removes citation IDs without changing the grounded sentence", () => {
    const result = optimizeStreamingVoiceSentence(groundedSentence());

    expect(result).toEqual({
      ok: true,
      sequence: 1,
      spokenSentence: "你们已经确认了周日的安排。",
      supportIds: ["segment_1"],
      safeForSpeech: true
    });
  });

  it.each([
    "目前没有证据证明她已经完成这项承诺。[E1]",
    "这仍然只是计划，尚未确认。[E1]",
    "这项承诺由对方提出，不代表双方都已经完成。[E1]",
    "目前只能确认双方做过约定，后来是否兑现仍未知。[E1]"
  ])("preserves uncertainty, lifecycle state, and ownership boundaries: %s", (sentence) => {
    const result = optimizeStreamingVoiceSentence(groundedSentence({ sentence }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a speech-safe sentence");
    expect(result.spokenSentence).toBe(sentence.replace("[E1]", ""));
  });

  it("removes presentation-only markdown and normalizes support IDs", () => {
    const result = optimizeStreamingVoiceSentence(groundedSentence({
      sentence: "- **目前仍未确认。** [E1]",
      supportIds: [" segment_1 ", "segment_1"]
    }));

    expect(result).toEqual({
      ok: true,
      sequence: 1,
      spokenSentence: "目前仍未确认。",
      supportIds: ["segment_1"],
      safeForSpeech: true
    });
  });

  it("does not truncate a long sentence or its trailing uncertainty boundary", () => {
    const sentence = `${"这段背景用于说明当时的讨论顺序，".repeat(30)}目前仍没有证据证明承诺已经完成。[E1]`;
    const result = optimizeStreamingVoiceSentence(groundedSentence({ sentence }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a speech-safe sentence");
    expect(result.spokenSentence).toBe(sentence.replace("[E1]", ""));
    expect(result.spokenSentence).toContain("目前仍没有证据证明承诺已经完成");
  });

  it("fails closed when grounding validation has not completed", () => {
    expect(optimizeStreamingVoiceSentence(groundedSentence({
      groundingValidated: false
    }))).toMatchObject({
      ok: false,
      safeForSpeech: false,
      reason: "grounding_not_validated"
    });
  });

  it("fails closed when sentence support is missing", () => {
    expect(optimizeStreamingVoiceSentence(groundedSentence({
      supportIds: []
    }))).toMatchObject({
      ok: false,
      safeForSpeech: false,
      reason: "missing_support"
    });
  });

  it("fails closed when support is outside the current cited-segment allowlist", () => {
    expect(optimizeStreamingVoiceSentence(groundedSentence({
      supportIds: ["segment_other"]
    }))).toMatchObject({
      ok: false,
      safeForSpeech: false,
      reason: "support_not_allowlisted"
    });
  });

  it.each([
    "状态仍未确认。[E1,]",
    "状态仍未确认。[E 1]",
    "状态仍未确认。［E1］",
    "状态仍未确认，证据 E1。"
  ])("does not speak malformed or residual citation forms: %s", (sentence) => {
    expect(optimizeStreamingVoiceSentence(groundedSentence({ sentence }))).toMatchObject({
      ok: false,
      safeForSpeech: false,
      reason: "citation_residue"
    });
  });

  it("does not mutate the grounded event", () => {
    const input = groundedSentence({
      supportIds: ["segment_1", "segment_2"],
      citedSegmentIds: ["segment_1", "segment_2"]
    });
    const snapshot = structuredClone(input);

    optimizeStreamingVoiceSentence(input);

    expect(input).toEqual(snapshot);
  });
});

describe("preflightStreamingVoiceSentences", () => {
  it("returns all speech sentences in sequence only after the full turn passes", () => {
    const result = preflightStreamingVoiceSentences([
      groundedSentence(),
      groundedSentence({
        sequence: 2,
        sentence: "但目前还不能确认以后每次都会如此。[E2]",
        supportIds: ["segment_2"],
        citedSegmentIds: ["segment_1", "segment_2"]
      })
    ]);

    expect(result).toEqual({
      ok: true,
      safeForSpeech: true,
      sentences: [
        {
          sequence: 1,
          spokenSentence: "你们已经确认了周日的安排。",
          supportIds: ["segment_1"],
          safeForSpeech: true
        },
        {
          sequence: 2,
          spokenSentence: "但目前还不能确认以后每次都会如此。",
          supportIds: ["segment_2"],
          safeForSpeech: true
        }
      ]
    });
  });

  it("withholds every sentence when any later sentence fails", () => {
    const result = preflightStreamingVoiceSentences([
      groundedSentence(),
      groundedSentence({
        sequence: 2,
        sentence: "后来已经完成。[E2]",
        supportIds: ["segment_unknown"]
      })
    ]);

    expect(result).toEqual({
      ok: false,
      safeForSpeech: false,
      reason: "support_not_allowlisted",
      failedSequence: 2,
      sentences: []
    });
  });

  it("rejects an empty turn and non-increasing sequence numbers", () => {
    expect(preflightStreamingVoiceSentences([])).toEqual({
      ok: false,
      safeForSpeech: false,
      reason: "empty_turn",
      sentences: []
    });
    expect(preflightStreamingVoiceSentences([
      groundedSentence({ sequence: 2 }),
      groundedSentence({ sequence: 2 })
    ])).toEqual({
      ok: false,
      safeForSpeech: false,
      reason: "invalid_sequence",
      failedSequence: 2,
      sentences: []
    });
  });
});
