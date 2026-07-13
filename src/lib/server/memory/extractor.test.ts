// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { BriefItem, RelationshipSignalCard, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import { extractUploadMemories } from "./extractor";

const segments: TranscriptSegment[] = [
  {
    id: "segment_1",
    uploadId: "upload_1",
    startSeconds: 0,
    endSeconds: 8,
    speaker: "speaker_1",
    text: "我会在周五前确认餐厅。",
    confidence: 0.96,
    sceneLabels: ["unknown"],
    valueLabels: ["commitment"]
  },
  {
    id: "segment_2",
    uploadId: "upload_1",
    startSeconds: 9,
    endSeconds: 18,
    speaker: "speaker_2",
    text: "那周六具体几点还需要再确认。",
    confidence: 0.94,
    sceneLabels: ["unknown"],
    valueLabels: ["open_question"]
  }
];

const briefItems: BriefItem[] = [
  {
    id: "brief_commitment",
    uploadId: "upload_1",
    category: "commitment",
    title: "周五前确认餐厅",
    body: "对方表示会在周五前确认餐厅。",
    priority: "high",
    confidence: 0.88,
    status: "candidate",
    sourceSegmentIds: ["segment_1"],
    sourceTimeRange: { startSeconds: 0, endSeconds: 8 },
    transcriptExcerpt: "我会在周五前确认餐厅。",
    people: [],
    topics: ["见面安排"]
  },
  {
    id: "brief_question",
    uploadId: "upload_1",
    category: "open_question",
    title: "周六时间待确认",
    body: "周六的具体时间还没有说清。",
    priority: "medium",
    confidence: 0.8,
    status: "candidate",
    sourceSegmentIds: ["segment_2"],
    sourceTimeRange: { startSeconds: 9, endSeconds: 18 },
    transcriptExcerpt: "那周六具体几点还需要再确认。",
    people: [],
    topics: ["见面安排"]
  }
];

const semanticSegments: SemanticSegment[] = [
  {
    id: "semantic_1",
    uploadId: "upload_1",
    title: "下次见面安排",
    summary: "双方讨论了餐厅和周六见面的时间。",
    startSeconds: 0,
    endSeconds: 18,
    tags: ["见面安排"],
    sceneLabels: ["unknown"],
    valueLabels: ["commitment", "open_question"],
    confidence: 0.84,
    sourceSegmentIds: ["segment_1", "segment_2"],
    sourceTimeRange: { startSeconds: 0, endSeconds: 18 },
    transcriptExcerpt: "我会确认餐厅，周六时间还要再确认。"
  }
];

const relationshipSignals: RelationshipSignalCard[] = [
  {
    id: "signal_1",
    uploadId: "upload_1",
    date: "2026-07-08",
    signalType: "clear_commitment",
    signalCategory: "positive",
    severity: "low",
    confidence: 0.81,
    summary: "出现了明确的时间承诺。",
    explanation: "当前片段里给出了可回看的时间点。",
    involvedSpeakers: ["speaker_1"],
    timeRange: { startSeconds: 0, endSeconds: 8 },
    evidenceSegments: [
      { segmentId: "segment_1", speaker: "speaker_1", startSeconds: 0, endSeconds: 8, text: "我会在周五前确认餐厅。" }
    ],
    textEvidence: ["我会在周五前确认餐厅。"],
    suggestedReflection: "之后可以回看这项安排是否得到确认。",
    createdAt: "2026-07-08T10:00:00.000Z"
  }
];

describe("memory extraction", () => {
  it("extracts v1 event, commitment, question and relationship signal memories", () => {
    const memories = extractUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments,
      briefItems,
      semanticSegments,
      relationshipSignals,
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(new Set(memories.map((memory) => memory.type))).toEqual(
      new Set(["commitment", "question", "relationship_signal"])
    );
    expect(memories.every((memory) => memory.evidence.some((evidence) => evidence.sourceType === "transcript"))).toBe(true);
    expect(memories.find((memory) => memory.type === "relationship_signal")?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceType: "relationship_signal", sourceId: "signal_1" }),
        expect.objectContaining({ sourceType: "transcript", sourceId: "segment_1", quote: segments[0].text })
      ])
    );
  });

  it("drops candidates that cannot be traced to a real transcript segment", () => {
    const memories = extractUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments,
      briefItems: [{ ...briefItems[0], id: "brief_missing", sourceSegmentIds: ["missing_segment"] }],
      semanticSegments: [],
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(memories).toEqual([]);
  });

  it("classifies an explicit future semantic action as commitment instead of event", () => {
    const futureSegment: TranscriptSegment = {
      ...segments[0],
      id: "segment_future",
      text: "下周我们一起去看电影，我会在周五前确认时间。",
      valueLabels: ["commitment"]
    };
    const futureSemantic: SemanticSegment = {
      ...semanticSegments[0],
      id: "semantic_future",
      title: "下周一起看电影",
      summary: "双方约定下周一起看电影，并在周五前确认时间。",
      valueLabels: ["commitment"],
      sourceSegmentIds: [futureSegment.id],
      transcriptExcerpt: futureSegment.text
    };

    const memories = extractUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments: [futureSegment],
      briefItems: [],
      semanticSegments: [futureSemantic],
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ type: "commitment" });
    expect(memories[0]?.importanceReasons).toContain(
      "extraction: contains future action and commitment language"
    );
  });

  it("classifies explicit stable preferences and unresolved questions", () => {
    const preferenceSegment: TranscriptSegment = {
      ...segments[0],
      id: "segment_preference",
      text: "我不喜欢临时改变计划，我习惯提前一天确认。",
      valueLabels: []
    };
    const questionSegment: TranscriptSegment = {
      ...segments[1],
      id: "segment_question",
      text: "具体几点还没说清，需要继续确认。",
      valueLabels: []
    };
    const semanticInputs: SemanticSegment[] = [
      {
        ...semanticSegments[0],
        id: "semantic_preference",
        title: "提前确认的偏好",
        summary: preferenceSegment.text,
        valueLabels: [],
        sourceSegmentIds: [preferenceSegment.id],
        transcriptExcerpt: preferenceSegment.text
      },
      {
        ...semanticSegments[0],
        id: "semantic_question",
        title: "见面时间待确认",
        summary: questionSegment.text,
        valueLabels: [],
        sourceSegmentIds: [questionSegment.id],
        transcriptExcerpt: questionSegment.text
      }
    ];

    const memories = extractUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments: [preferenceSegment, questionSegment],
      briefItems: [],
      semanticSegments: semanticInputs,
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(memories.map((memory) => memory.type).sort()).toEqual(["preference", "question"]);
    expect(memories.find((memory) => memory.type === "preference")?.importanceReasons).toContain(
      "extraction: contains explicit stable preference or habit"
    );
    expect(memories.find((memory) => memory.type === "question")?.importanceReasons).toContain(
      "extraction: contains unresolved or pending confirmation language"
    );
  });

  it("does not index generic semantic chatter as a durable event", () => {
    const chatterSegment: TranscriptSegment = {
      ...segments[0],
      id: "segment_chatter",
      text: "这个游戏挺有意思，我们再玩一轮。",
      valueLabels: []
    };
    const chatterSemantic: SemanticSegment = {
      ...semanticSegments[0],
      id: "semantic_chatter",
      title: "继续玩游戏",
      summary: chatterSegment.text,
      valueLabels: [],
      sourceSegmentIds: [chatterSegment.id],
      transcriptExcerpt: chatterSegment.text
    };

    expect(
      extractUploadMemories({
        userId: "user_1",
        uploadId: "upload_1",
        recordingDate: "2026-07-08",
        segments: [chatterSegment],
        briefItems: [],
        semanticSegments: [chatterSemantic],
        relationshipSignals: [],
        now: "2026-07-10T10:00:00.000Z"
      })
    ).toEqual([]);
  });

  it("keeps explicit recent activities and second-person preferences without treating chatter as event", () => {
    const activitySegment: TranscriptSegment = {
      ...segments[0],
      id: "segment_activity",
      text: "今天我们一起做了晚饭。",
      valueLabels: []
    };
    const preferenceSegment: TranscriptSegment = {
      ...segments[1],
      id: "segment_partner_preference",
      text: "我看到了你特别喜欢的鲍鱼。",
      valueLabels: []
    };
    const semanticInputs: SemanticSegment[] = [
      {
        ...semanticSegments[0],
        id: "semantic_activity",
        title: "一起做晚饭",
        summary: activitySegment.text,
        valueLabels: [],
        sourceSegmentIds: [activitySegment.id],
        transcriptExcerpt: activitySegment.text
      },
      {
        ...semanticSegments[0],
        id: "semantic_partner_preference",
        title: "喜欢鲍鱼",
        summary: preferenceSegment.text,
        valueLabels: [],
        sourceSegmentIds: [preferenceSegment.id],
        transcriptExcerpt: preferenceSegment.text
      }
    ];

    const memories = extractUploadMemories({
      userId: "user_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-08",
      segments: [activitySegment, preferenceSegment],
      briefItems: [],
      semanticSegments: semanticInputs,
      relationshipSignals: [],
      now: "2026-07-10T10:00:00.000Z"
    });

    expect(memories.map((memory) => memory.type).sort()).toEqual(["event", "preference"]);
    expect(memories.find((memory) => memory.type === "event")?.importanceReasons).toContain(
      "extraction: contains a dated or completed activity"
    );
  });
});
