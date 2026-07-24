import { describe, expect, it } from "vitest";
import {
  buildStandaloneDiarizationSentences,
  DiarizationEvaluationInputError,
  evaluateCombinedDiarizationQualityGate,
  parseCombinedAsrSpeakerLabels,
  parseStandaloneDiarizationLabels,
  summarizeDiarizationResponseShape
} from "./voiceprint-diarization";

describe("voiceprint diarization evaluation helpers", () => {
  it("parses and deduplicates combined ASR speaker labels", () => {
    expect(parseCombinedAsrSpeakerLabels({
      data: {
        speaker_result: [
          { speaker: " speaker_1 ", text: "private transcript A" },
          { speaker: "speaker_2", text: "private transcript B" },
          { speaker: "speaker_1", text: "private transcript C" },
          { text: "missing label" }
        ]
      }
    })).toEqual({
      source: "combined_asr",
      resultCount: 4,
      validLabelEntryCount: 3,
      labels: ["speaker_1", "speaker_2"]
    });
  });

  it("parses standalone diarization labels from data.result", () => {
    expect(parseStandaloneDiarizationLabels({
      data: {
        result: [
          { speaker: "speaker_2", text: "private transcript" },
          { speaker: "speaker_1", text: "private transcript" }
        ]
      }
    })).toEqual({
      source: "standalone_diarization",
      resultCount: 2,
      validLabelEntryCount: 2,
      labels: ["speaker_2", "speaker_1"]
    });
  });

  it("normalizes singular timestamp arrays to standalone timestamps", () => {
    expect(buildStandaloneDiarizationSentences({
      data: {
        asr_result: {
          sentences: [
            {
              text: "  first private sentence  ",
              timestamp: [
                { start: 0, end: 10 },
                { start: 15, end: 20 }
              ],
              emotion: "neutral"
            }
          ]
        }
      }
    })).toEqual([
      {
        text: "first private sentence",
        timestamps: [
          { start: 0, end: 10 },
          { start: 15, end: 20 }
        ]
      }
    ]);
  });

  it("preserves plural sentence-level timestamp objects", () => {
    expect(buildStandaloneDiarizationSentences({
      data: {
        asr_result: {
          sentences: [
            {
              text: "private sentence",
              timestamps: { start: 1_000, end: 2_500 }
            }
          ]
        }
      }
    })).toEqual([
      {
        text: "private sentence",
        timestamps: { start: 1_000, end: 2_500 }
      }
    ]);
  });

  it("rejects sentences with missing timestamps without exposing text", () => {
    let caught: unknown;
    try {
      buildStandaloneDiarizationSentences({
        data: {
          asr_result: {
            sentences: [{ text: "TOP SECRET TRANSCRIPT" }]
          }
        }
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DiarizationEvaluationInputError);
    expect(caught).toMatchObject({
      code: "asr_sentence_timestamps_missing",
      sentenceIndex: 0
    });
    expect(String(caught)).not.toContain("TOP SECRET TRANSCRIPT");
  });

  it("rejects sentences with missing text", () => {
    expect(() => buildStandaloneDiarizationSentences({
      data: {
        asr_result: {
          sentences: [{ timestamps: { start: 0, end: 10 } }]
        }
      }
    })).toThrowError(
      expect.objectContaining({
        code: "asr_sentence_text_missing",
        sentenceIndex: 0
      })
    );
  });

  it("returns an empty label set when neither response contains labels", () => {
    expect(parseCombinedAsrSpeakerLabels({ data: { asr_result: {} } })).toEqual({
      source: "combined_asr",
      resultCount: 0,
      validLabelEntryCount: 0,
      labels: []
    });
    expect(parseStandaloneDiarizationLabels({ data: { result: [] } })).toEqual({
      source: "standalone_diarization",
      resultCount: 0,
      validLabelEntryCount: 0,
      labels: []
    });
  });

  it("passes the strict combined gate only for two speakers with text", () => {
    expect(evaluateCombinedDiarizationQualityGate({
      data: {
        speaker_result: [
          { speaker: "speaker_1", text: "private transcript A" },
          { speaker: "speaker_2", text: "private transcript B" },
          { speaker: "speaker_1", text: "private transcript C" }
        ]
      }
    }, {
      expectedSpeakerCount: 2,
      requiredSpeakerLabel: "speaker_1"
    })).toEqual({
      passed: true,
      reason: "passed",
      expectedSpeakerCount: 2,
      uniqueSpeakerCount: 2,
      speakersWithTextCount: 2,
      emptyTextSpeakerCount: 0,
      labels: ["speaker_1", "speaker_2"]
    });
  });

  it("fails the strict combined gate when a speaker has no text", () => {
    expect(evaluateCombinedDiarizationQualityGate({
      data: {
        speaker_result: [
          { speaker: "speaker_1", text: "private transcript" },
          { speaker: "speaker_2", text: "   " }
        ]
      }
    }, {
      expectedSpeakerCount: 2,
      requiredSpeakerLabel: "speaker_1"
    })).toMatchObject({
      passed: false,
      reason: "speaker_without_text",
      uniqueSpeakerCount: 2,
      speakersWithTextCount: 1,
      emptyTextSpeakerCount: 1
    });
  });

  it("fails the strict combined gate for missing required or extra speakers", () => {
    expect(evaluateCombinedDiarizationQualityGate({
      data: {
        speaker_result: [
          { speaker: "speaker_2", text: "private transcript A" },
          { speaker: "speaker_3", text: "private transcript B" }
        ]
      }
    }, {
      expectedSpeakerCount: 2,
      requiredSpeakerLabel: "speaker_1"
    })).toMatchObject({
      passed: false,
      reason: "required_speaker_missing"
    });

    expect(evaluateCombinedDiarizationQualityGate({
      data: {
        speaker_result: [
          { speaker: "speaker_1", text: "private transcript A" },
          { speaker: "speaker_2", text: "private transcript B" },
          { speaker: "speaker_3", text: "private transcript C" }
        ]
      }
    }, {
      expectedSpeakerCount: 2
    })).toMatchObject({
      passed: false,
      reason: "unexpected_speaker_count"
    });
  });

  it("summarizes response shape without returning transcript or labels", () => {
    const summary = summarizeDiarizationResponseShape({
      code: 0,
      message: "TOP SECRET MESSAGE",
      data: {
        asr_result: {
          detected_language: "zh",
          sentences: [{ text: "TOP SECRET TRANSCRIPT" }]
        },
        speaker_result: [
          { speaker: "PRIVATE CONTACT NAME", text: "TOP SECRET TRANSCRIPT" }
        ]
      }
    });

    expect(summary).toEqual({
      topLevelFields: ["code", "data", "message"],
      dataFields: ["asr_result", "speaker_result"],
      asrResultFields: ["detected_language", "sentences"],
      sentenceCount: 1,
      combinedSpeakerResultCount: 1,
      standaloneResultCount: 0
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("TOP SECRET");
    expect(serialized).not.toContain("PRIVATE CONTACT NAME");
  });
});
