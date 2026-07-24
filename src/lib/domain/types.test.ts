import { describe, expect, it } from "vitest";
import { AudioInsightSchema, BriefItemSchema, RelationshipSignalCardSchema, TranscriptSegmentSchema } from "./types";

describe("domain schemas", () => {
  it("accepts a transcript segment with stable time range", () => {
    const segment = TranscriptSegmentSchema.parse({
      id: "seg_1",
      uploadId: "upload_1",
      startSeconds: 60,
      endSeconds: 95,
      speaker: "speaker_1",
      text: "我们今天要把客户报价方案定下来。",
      confidence: 0.91,
      sceneLabels: ["customer_call"],
      valueLabels: ["decision"]
    });

    expect(segment.endSeconds).toBeGreaterThan(segment.startSeconds);
  });

  it("preserves optional global speaker identity without changing the local label", () => {
    const segment = TranscriptSegmentSchema.parse({
      id: "seg_identity_1",
      uploadId: "upload_1",
      startSeconds: 0,
      endSeconds: 4,
      speaker: "speaker_0",
      identity: {
        globalSpeakerId: "person_1",
        displayName: "Contact A",
        identityType: "known_contact",
        confidence: 0.92,
        source: "voiceprint"
      },
      text: "A short utterance.",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    });

    expect(segment.speaker).toBe("speaker_0");
    expect(segment.identity?.globalSpeakerId).toBe("person_1");
  });

  it("accepts a known-user voiceprint identity without changing the local label", () => {
    const segment = TranscriptSegmentSchema.parse({
      id: "seg_identity_user",
      uploadId: "upload_1",
      startSeconds: 0,
      endSeconds: 4,
      speaker: "speaker_0",
      identity: {
        globalSpeakerId: "user_user_1",
        identityType: "known_user",
        confidence: 0.95,
        source: "voiceprint"
      },
      text: "A short utterance.",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    });

    expect(segment.speaker).toBe("speaker_0");
    expect(segment.identity?.identityType).toBe("known_user");
  });

  it("rejects invalid speaker identity confidence", () => {
    expect(() =>
      TranscriptSegmentSchema.parse({
        id: "seg_identity_invalid",
        uploadId: "upload_1",
        startSeconds: 0,
        endSeconds: 4,
        speaker: "speaker_0",
        identity: {
          globalSpeakerId: "person_1",
          identityType: "known_contact",
          confidence: 1.1,
          source: "voiceprint"
        },
        text: "A short utterance.",
        confidence: 0.9,
        sceneLabels: [],
        valueLabels: []
      })
    ).toThrow();
  });

  it("rejects a brief item without source evidence", () => {
    expect(() =>
      BriefItemSchema.parse({
        id: "brief_1",
        uploadId: "upload_1",
        category: "task",
        title: "跟进报价",
        body: "明天把报价方案发给客户。",
        priority: "high",
        confidence: 0.86,
        status: "candidate",
        sourceSegmentIds: [],
        sourceTimeRange: { startSeconds: 0, endSeconds: 0 },
        transcriptExcerpt: ""
      })
    ).toThrow();
  });

  it("accepts audio insight signals with source evidence", () => {
    const insight = AudioInsightSchema.parse({
      id: "insight_1",
      uploadId: "upload_1",
      sourceSegmentIds: ["seg_1"],
      sourceTimeRange: { startSeconds: 60, endSeconds: 95 },
      speaker: {
        id: "speaker_1",
        displayName: "我",
        role: "self",
        confidence: 0.72
      },
      voice: {
        pace: "normal",
        volume: "unknown",
        pause: "unknown",
        overlap: false,
        confidence: 0.35,
        explanations: [
          { kind: "pause", label: "停顿变多", detail: "静音和停顿占比约 42%。", confidence: 0.72 }
        ]
      },
      toneLabels: ["hesitant", "questioning"],
      emotionLabels: ["anxious"],
      interactionLabels: ["follow_up_question", "tension"],
      userCorrections: [
        {
          labelCorrections: [{ from: "紧张", to: "认真" }],
          note: "用户确认这一段不是紧张，而是在认真讨论。",
          updatedAt: "2026-07-05T10:00:00.000Z"
        }
      ],
      summary: "说话人以试探方式提出风险确认。",
      evidence: "原文提到“可能还有风险”和“是不是需要再确认”。",
      confidence: 0.68
    });

    expect(insight.sourceTimeRange.endSeconds).toBeGreaterThan(insight.sourceTimeRange.startSeconds);
    expect(insight.voice.explanations?.[0].label).toBe("停顿变多");
    expect(insight.userCorrections?.[0].labelCorrections[0]).toEqual({ from: "紧张", to: "认真" });
  });

  it("accepts emotion evidence with source features and atmosphere labels", () => {
    const insight = AudioInsightSchema.parse({
      id: "insight_1",
      uploadId: "upload_1",
      sourceSegmentIds: ["seg_1"],
      sourceTimeRange: { startSeconds: 120, endSeconds: 180 },
      speaker: { id: "speaker_1", role: "self", confidence: 0.64 },
      voice: {
        pace: "normal",
        volume: "high",
        pause: "many",
        overlap: true,
        confidence: 0.72,
        explanations: [
          { kind: "volume", label: "音量更高", detail: "这一段平均音量约 -16 dBFS。", confidence: 0.72 }
        ]
      },
      toneLabels: ["questioning", "serious"],
      emotionLabels: ["anxious"],
      interactionLabels: ["tension", "follow_up_question"],
      atmosphereLabels: ["serious", "tense"],
      emotionEvidence: [
        {
          id: "evidence_1",
          kind: "atmosphere",
          label: "认真偏紧",
          normalizedLabel: "tense",
          source: "acoustic",
          confidence: 0.72,
          detail: "音量升高、停顿变多，并且多人重叠。",
          sourceSegmentIds: ["seg_1"],
          sourceTimeRange: { startSeconds: 120, endSeconds: 180 },
          features: [
            { name: "volume", label: "音量更高", value: "-16", unit: "dBFS" },
            { name: "pause", label: "停顿变多", value: "42", unit: "%" }
          ]
        }
      ],
      summary: "这一段在认真追问风险。",
      evidence: "原文追问风险，声音上音量更高、停顿变多。",
      confidence: 0.72
    });

    expect(insight.atmosphereLabels).toEqual(["serious", "tense"]);
    expect(insight.emotionEvidence?.[0]).toEqual(
      expect.objectContaining({
        source: "acoustic",
        normalizedLabel: "tense",
        detail: "音量升高、停顿变多，并且多人重叠。"
      })
    );
  });

  it("accepts a relationship signal card with transcript evidence", () => {
    const card = RelationshipSignalCardSchema.parse({
      id: "relationship_signal_upload_1_1",
      uploadId: "upload_1",
      date: "2026-07-09",
      signalType: "active_listening",
      signalCategory: "positive",
      severity: "low",
      confidence: 0.82,
      summary: "speaker_2 paused and asked a follow-up question.",
      explanation: "The card stays close to the transcript and treats the moment as an interaction clue.",
      involvedSpeakers: ["speaker_1", "speaker_2"],
      timeRange: { startSeconds: 12, endSeconds: 24 },
      evidenceSegments: [
        {
          segmentId: "seg_1",
          speaker: "speaker_2",
          startSeconds: 12,
          endSeconds: 24,
          text: "I hear that felt uncomfortable. Do you want to say more?"
        }
      ],
      textEvidence: ["I hear that felt uncomfortable. Do you want to say more?"],
      suggestedReflection: "You could notice whether this kind of follow-up happens consistently.",
      createdAt: "2026-07-09T00:00:00.000Z"
    });

    expect(card.evidenceSegments[0].segmentId).toBe("seg_1");
  });
});
