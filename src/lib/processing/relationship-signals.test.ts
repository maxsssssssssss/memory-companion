import { describe, expect, it } from "vitest";
import type { AudioInsight, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import {
  RelationshipSignalModelItemsSchema,
  buildConservativeRelationshipSignalFallbackCards,
  hasRelationshipSignalContext,
  normalizeEvidenceField,
  normalizeRelationshipSignalModelResponse,
  normalizeRelationshipSignalItems
} from "./relationship-signals";

const relationshipSegments: TranscriptSegment[] = [
  {
    id: "seg_1",
    uploadId: "upload_1",
    startSeconds: 10,
    endSeconds: 20,
    speaker: "speaker_1",
    text: "刚才你一直追问的时候我有点不舒服，我想先停一下。",
    confidence: 0.91,
    sceneLabels: ["unknown"],
    valueLabels: ["open_question"]
  },
  {
    id: "seg_2",
    uploadId: "upload_1",
    startSeconds: 20,
    endSeconds: 35,
    speaker: "speaker_2",
    text: "好，我听到了。我们可以先停一下，你愿意的话再慢慢说。",
    confidence: 0.93,
    sceneLabels: ["unknown"],
    valueLabels: []
  }
];

const technicalSegments: TranscriptSegment[] = [
  {
    id: "seg_tech",
    uploadId: "upload_tech",
    startSeconds: 0,
    endSeconds: 12,
    speaker: "speaker_1",
    text: "ESP32 这边先连 WebSocket，再把智能音箱的音频流发到服务端。",
    confidence: 0.9,
    sceneLabels: ["product_discussion"],
    valueLabels: ["task"]
  }
];

const semanticSegments: SemanticSegment[] = [];
const audioInsights: AudioInsight[] = [];

function validModelItem(overrides: Record<string, unknown> = {}) {
  return {
    signalType: "boundary_respect",
    signalCategory: "positive",
    severity: "low",
    confidence: 0.84,
    summary: "对方接受了先停一下的边界表达。",
    explanation: "这只是基于当下两句对话的互动线索，不代表长期关系结论。",
    involvedSpeakers: ["speaker_1", "speaker_2"],
    evidenceSegmentIds: ["seg_1", "seg_2"],
    evidenceSegments: [],
    textEvidence: ["我想先停一下", "我们可以先停一下"],
    suggestedReflection: "可以留意后续对方是否也能持续尊重类似表达。",
    ...overrides
  };
}

describe("relationship signal processing", () => {
  it("normalizes string evidence containers before strict model validation", () => {
    expect(normalizeEvidenceField("他说话比较积极")).toEqual(["他说话比较积极"]);

    const normalized = normalizeRelationshipSignalModelResponse({
      items: [
        validModelItem({
          counterEvidence: "也有一次没有回应",
          acousticEvidence: "语气比较积极",
          interactionEvidence: "主动询问情况"
        })
      ]
    });
    const parsed = RelationshipSignalModelItemsSchema.parse(normalized);

    expect(parsed.items[0].counterEvidence).toEqual(["也有一次没有回应"]);
    expect(parsed.items[0].acousticEvidence).toEqual([]);
    expect(parsed.items[0].interactionEvidence).toEqual([]);
  });

  it("keeps array evidence containers unchanged", () => {
    const evidence = ["他说话比较积极", "主动询问情况"];

    expect(normalizeEvidenceField(evidence)).toBe(evidence);
  });

  it("normalizes missing, null, and unsupported evidence values to empty arrays", () => {
    expect(normalizeEvidenceField(undefined)).toEqual([]);
    expect(normalizeEvidenceField(null)).toEqual([]);
    expect(normalizeEvidenceField(42)).toEqual([]);
    expect(normalizeEvidenceField({ detail: "unsupported" })).toEqual([]);

    const parsed = RelationshipSignalModelItemsSchema.parse(
      normalizeRelationshipSignalModelResponse({
        items: [validModelItem({ counterEvidence: null })]
      })
    );

    expect(parsed.items[0].counterEvidence).toEqual([]);
    expect(parsed.items[0].acousticEvidence).toEqual([]);
    expect(parsed.items[0].interactionEvidence).toEqual([]);
  });

  it("does not change an already valid relationship signal model response", () => {
    const response = {
      items: [
        validModelItem({
          counterEvidence: ["也有一次没有回应"],
          acousticEvidence: [
            {
              audioInsightId: "audio_1",
              detail: "语速和音量保持平稳",
              confidence: 0.72
            }
          ],
          interactionEvidence: [
            {
              sourceId: "semantic_1",
              detail: "边界表达后出现了明确回应",
              confidence: 0.78
            }
          ]
        })
      ]
    };

    expect(normalizeRelationshipSignalModelResponse(response)).toEqual(response);
  });

  it("normalizes model evidence using real transcript segment timing and text", () => {
    const cards = normalizeRelationshipSignalItems({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights,
      items: [
        {
          signalType: "boundary_respect",
          signalCategory: "positive",
          severity: "low",
          confidence: 0.84,
          summary: "对方接受了先停一下的边界表达。",
          explanation: "这只是基于当下两句对话的互动线索，不代表长期关系结论。",
          involvedSpeakers: ["speaker_1", "speaker_2"],
          evidenceSegmentIds: ["seg_1", "seg_2"],
          evidenceSegments: [
            {
              segmentId: "made_up",
              speaker: "speaker_x",
              startSeconds: 999,
              endSeconds: 1000,
              text: "fake"
            }
          ],
          textEvidence: ["我想先停一下", "我们可以先停一下"],
          suggestedReflection: "可以留意后续对方是否也能持续尊重类似表达。"
        }
      ]
    });

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      signalType: "boundary_respect",
      signalCategory: "positive",
      timeRange: { startSeconds: 10, endSeconds: 35 },
      involvedSpeakers: ["speaker_1", "speaker_2"]
    });
    expect(cards[0].evidenceSegments).toEqual([
      {
        segmentId: "seg_1",
        speaker: "speaker_1",
        startSeconds: 10,
        endSeconds: 20,
        text: relationshipSegments[0].text
      },
      {
        segmentId: "seg_2",
        speaker: "speaker_2",
        startSeconds: 20,
        endSeconds: 35,
        text: relationshipSegments[1].text
      }
    ]);
  });

  it("backfills trusted speaker identities while keeping local transcript labels intact", () => {
    const identified = relationshipSegments.map((segment, index) => ({
      ...segment,
      identity: {
        globalSpeakerId: `person_${index + 1}`,
        displayName: index === 0 ? "Contact A" : "Contact B",
        identityType: "known_contact" as const,
        confidence: 0.94,
        source: "voiceprint" as const
      }
    }));
    const cards = normalizeRelationshipSignalItems({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: identified,
      semanticSegments,
      audioInsights,
      items: [validModelItem({ involvedSpeakers: [] })]
    });

    expect(cards[0].involvedSpeakers).toEqual(["Contact A", "Contact B"]);
    expect(cards[0].evidenceSegments.map((item) => item.speaker)).toEqual(["Contact A", "Contact B"]);
    expect(identified.map((segment) => segment.speaker)).toEqual(["speaker_1", "speaker_2"]);
  });

  it("drops cards that use forbidden relationship judgments", () => {
    const cards = normalizeRelationshipSignalItems({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights,
      items: [
        {
          signalType: "evasive_answer",
          signalCategory: "uncertain",
          severity: "medium",
          confidence: 0.8,
          summary: "他是渣男。",
          explanation: "对方一定在操控你。",
          involvedSpeakers: ["speaker_2"],
          evidenceSegmentIds: ["seg_2"],
          textEvidence: ["好，我听到了。"],
          suggestedReflection: "你应该分手。",
          caution: "这是人格判断。"
        }
      ]
    });

    expect(cards).toEqual([]);
  });

  it("requires caution for uncertain and risk cards", () => {
    const cards = normalizeRelationshipSignalItems({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: relationshipSegments,
      semanticSegments,
      audioInsights,
      items: [
        {
          signalType: "evasive_answer",
          signalCategory: "uncertain",
          severity: "medium",
          confidence: 0.7,
          summary: "这个回应可能还需要澄清。",
          explanation: "对方没有直接回应感受部分，但证据只来自这一小段。",
          involvedSpeakers: ["speaker_2"],
          evidenceSegmentIds: ["seg_2"],
          textEvidence: ["好，我听到了。"],
          suggestedReflection: "可以在下一次对话里把感受说得更具体。"
        }
      ]
    });

    expect(cards).toEqual([]);
  });

  it("returns no cards for non-relationship technical context", () => {
    expect(
      hasRelationshipSignalContext({
        segments: technicalSegments,
        semanticSegments,
        audioInsights
      })
    ).toBe(false);

    const cards = normalizeRelationshipSignalItems({
      uploadId: "upload_tech",
      recordingDate: "2026-07-09",
      segments: technicalSegments,
      semanticSegments,
      audioInsights,
      items: [
        {
          signalType: "active_listening",
          signalCategory: "positive",
          severity: "low",
          confidence: 0.75,
          summary: "技术讨论里的回应不应被硬解释成关系信号。",
          explanation: "非关系语境应返回空数组。",
          involvedSpeakers: ["speaker_1"],
          evidenceSegmentIds: ["seg_tech"],
          textEvidence: ["ESP32"],
          suggestedReflection: "不生成。"
        }
      ]
    });

    expect(cards).toEqual([]);
  });

  it("builds conservative fallback cards only from explicit relationship evidence", () => {
    const cards = buildConservativeRelationshipSignalFallbackCards({
      uploadId: "upload_1",
      recordingDate: "2026-07-09",
      segments: [
        {
          id: "seg_1",
          uploadId: "upload_1",
          startSeconds: 0,
          endSeconds: 8,
          speaker: "speaker_1",
          text: "我想问问你下周还想见面吗？上次你很久没回消息，我有一点不安。",
          confidence: 0.9,
          sceneLabels: ["unknown"],
          valueLabels: []
        },
        {
          id: "seg_2",
          uploadId: "upload_1",
          startSeconds: 8,
          endSeconds: 16,
          speaker: "speaker_2",
          text: "我听到了，你会不安，是因为不知道我是不是认真，对吗？",
          confidence: 0.9,
          sceneLabels: ["unknown"],
          valueLabels: []
        },
        {
          id: "seg_3",
          uploadId: "upload_1",
          startSeconds: 16,
          endSeconds: 25,
          speaker: "speaker_1",
          text: "我也想表达一个边界，如果今晚需要休息，希望你不要一直追问。",
          confidence: 0.9,
          sceneLabels: ["unknown"],
          valueLabels: []
        },
        {
          id: "seg_4",
          uploadId: "upload_1",
          startSeconds: 25,
          endSeconds: 34,
          speaker: "speaker_2",
          text: "可以，我尊重你需要休息。下次如果我临时有事，我会提前发消息。",
          confidence: 0.9,
          sceneLabels: ["unknown"],
          valueLabels: []
        }
      ],
      semanticSegments,
      audioInsights
    });

    expect(cards.map((card) => card.signalType)).toEqual([
      "active_listening",
      "boundary_respect",
      "clear_commitment"
    ]);
    expect(cards[0].evidenceSegments.map((segment) => segment.segmentId)).toEqual(["seg_1", "seg_2"]);
    expect(cards.every((card) => card.signalCategory === "positive")).toBe(true);
  });

  it("does not build fallback cards for non-relationship context", () => {
    const cards = buildConservativeRelationshipSignalFallbackCards({
      uploadId: "upload_tech",
      recordingDate: "2026-07-09",
      segments: technicalSegments,
      semanticSegments,
      audioInsights
    });

    expect(cards).toEqual([]);
  });
});
