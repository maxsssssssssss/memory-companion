import { describe, expect, it } from "vitest";
import type { ProactiveInsight } from "@/lib/domain/proactive-insights";
import type { AudioInsight, BriefItem, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import type { LocalDayPayload } from "./local-analysis";
import { combineDayPayloads } from "./day-aggregation";

function segment(uploadId: string, index: number, startSeconds: number, endSeconds: number): TranscriptSegment {
  return {
    id: `${uploadId}_seg_${index}`,
    uploadId,
    startSeconds,
    endSeconds,
    text: `${uploadId} 第 ${index} 段`,
    confidence: 0.8,
    sceneLabels: ["unknown"],
    valueLabels: []
  };
}

function semanticSegment(uploadId: string, sourceSegmentId: string, startSeconds: number, endSeconds: number): SemanticSegment {
  return {
    id: `semantic_${uploadId}`,
    uploadId,
    title: `${uploadId} 主题`,
    summary: `${uploadId} 摘要`,
    startSeconds,
    endSeconds,
    tags: ["会议"],
    sceneLabels: ["unknown"],
    valueLabels: [],
    confidence: 0.8,
    sourceSegmentIds: [sourceSegmentId],
    sourceTimeRange: { startSeconds, endSeconds },
    transcriptExcerpt: `${uploadId} 摘要原文`
  };
}

function audioInsight(uploadId: string, sourceSegmentId: string, startSeconds: number, endSeconds: number): AudioInsight {
  return {
    id: `insight_${uploadId}`,
    uploadId,
    sourceSegmentIds: [sourceSegmentId],
    sourceTimeRange: { startSeconds, endSeconds },
    speaker: { id: "speaker_1", role: "self", confidence: 0.6 },
    voice: { pace: "normal", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.35 },
    toneLabels: ["firm"],
    emotionLabels: ["neutral"],
    interactionLabels: ["decision_moment"],
    summary: `${uploadId} 语气明确`,
    evidence: `${uploadId} 原文证据`,
    confidence: 0.7
  };
}

function briefItem(uploadId: string, sourceSegmentId: string, startSeconds: number, endSeconds: number): BriefItem {
  return {
    id: `brief_${uploadId}`,
    uploadId,
    category: "decision",
    title: `${uploadId} 决策`,
    body: `${uploadId} 内容`,
    priority: "high",
    confidence: 0.8,
    status: "candidate",
    sourceSegmentIds: [sourceSegmentId],
    sourceTimeRange: { startSeconds, endSeconds },
    transcriptExcerpt: `${uploadId} 原文`,
    people: [],
    topics: []
  };
}

function proactiveInsight(uploadId: string, sourceSegmentId: string, startSeconds: number, endSeconds: number): ProactiveInsight {
  return {
    id: `proactive_${uploadId}`,
    scope: "current",
    type: "follow_up_question",
    category: "follow_up",
    observation: `${uploadId} has a follow-up worth reviewing.`,
    question: `What should be followed up from ${uploadId}?`,
    reason: "The recording contains a concrete next step.",
    confidence: 0.8,
    evidenceRefs: [
      {
        evidenceId: `evidence_${uploadId}`,
        kind: "brief",
        sourceType: "brief",
        sourceId: `brief_${uploadId}`,
        uploadId,
        recordingDate: "2026-06-10",
        sourceSegmentIds: [sourceSegmentId],
        timeRange: { startSeconds, endSeconds },
        title: `${uploadId} follow-up`,
        summary: `${uploadId} contains a next step.`,
        excerpt: `${uploadId} transcript evidence.`,
        confidence: 0.8
      }
    ],
    sourceUploadIds: [uploadId],
    createdAt: "2026-06-10T08:00:00.000Z"
  };
}

function payload(uploadId: string, createdAt: string, durationSeconds: number): LocalDayPayload {
  const firstSegment = segment(uploadId, 1, 0, durationSeconds);

  return {
    upload: {
      id: uploadId,
      originalName: `${uploadId}.mp3`,
      mimeType: "audio/mpeg",
      sizeBytes: 1000,
      recordingDate: "2026-06-10",
      createdAt,
      durationSeconds,
      status: "ready"
    },
    job: {
      id: `job_${uploadId}`,
      uploadId,
      status: "ready",
      progress: 100,
      startedAt: createdAt,
      finishedAt: createdAt
    },
    segments: [firstSegment],
    audioInsights: [audioInsight(uploadId, firstSegment.id, 0, durationSeconds)],
    semanticSegments: [semanticSegment(uploadId, firstSegment.id, 0, durationSeconds)],
    semanticSegmentsAvailable: true,
    briefItems: [briefItem(uploadId, firstSegment.id, 0, durationSeconds)],
    speakerAliases: {}
  };
}

describe("combineDayPayloads", () => {
  it("combines multiple recordings from one day into a single day payload with shifted evidence times", () => {
    const morning = payload("upload_morning", "2026-06-10T01:00:00.000Z", 60);
    const afternoon = payload("upload_afternoon", "2026-06-10T06:00:00.000Z", 90);

    const combined = combineDayPayloads([afternoon, morning]);

    expect(combined.upload).toEqual(
      expect.objectContaining({
        id: "day_2026-06-10",
        originalName: "2 段录音",
        recordingDate: "2026-06-10",
        durationSeconds: 151,
        status: "ready"
      })
    );
    expect(combined.recordings.map((recording) => recording.upload.id)).toEqual(["upload_morning", "upload_afternoon"]);
    expect(combined.segments.map((item) => [item.id, item.startSeconds, item.endSeconds])).toEqual([
      ["upload_morning_seg_1", 0, 60],
      ["upload_afternoon_seg_1", 61, 151]
    ]);
    expect(combined.briefItems.map((item) => [item.id, item.sourceTimeRange.startSeconds, item.sourceTimeRange.endSeconds])).toEqual([
      ["brief_upload_morning", 0, 60],
      ["brief_upload_afternoon", 61, 151]
    ]);
    expect(combined.audioInsights.map((item) => [item.id, item.sourceTimeRange.startSeconds, item.sourceTimeRange.endSeconds])).toEqual([
      ["insight_upload_morning", 0, 60],
      ["insight_upload_afternoon", 61, 151]
    ]);
    expect(combined.semanticSegments.map((item) => [item.id, item.startSeconds, item.endSeconds])).toEqual([
      ["semantic_upload_morning", 0, 60],
      ["semantic_upload_afternoon", 61, 151]
    ]);
  });

  it("keeps current-scope proactive insights from each real recording", () => {
    const morning = payload("upload_morning", "2026-06-10T01:00:00.000Z", 60);
    const afternoon = payload("upload_afternoon", "2026-06-10T06:00:00.000Z", 90);
    morning.proactiveInsights = [proactiveInsight("upload_morning", "upload_morning_seg_1", 0, 60)];
    morning.proactiveInsightsAvailable = true;
    afternoon.proactiveInsights = [proactiveInsight("upload_afternoon", "upload_afternoon_seg_1", 0, 90)];
    afternoon.proactiveInsightsAvailable = true;

    const combined = combineDayPayloads([afternoon, morning]);

    expect(combined.proactiveInsights?.map((item) => item.id)).toEqual(["proactive_upload_morning", "proactive_upload_afternoon"]);
    expect(combined.proactiveInsightsAvailable).toBe(true);
    expect(combined.proactiveInsights?.[1].evidenceRefs[0].timeRange).toEqual({ startSeconds: 0, endSeconds: 90 });
  });

  it("preserves input order when recordings do not have createdAt timestamps", () => {
    const first = payload("upload_z", "2026-06-10T01:00:00.000Z", 60);
    const second = payload("upload_a", "2026-06-10T06:00:00.000Z", 90);
    delete first.upload.createdAt;
    delete first.job?.startedAt;
    delete second.upload.createdAt;
    delete second.job?.startedAt;

    const combined = combineDayPayloads([first, second]);

    expect(combined.recordings.map((recording) => recording.upload.id)).toEqual(["upload_z", "upload_a"]);
    expect(combined.segments.map((item) => [item.id, item.startSeconds, item.endSeconds])).toEqual([
      ["upload_z_seg_1", 0, 60],
      ["upload_a_seg_1", 61, 151]
    ]);
  });

  it("keeps speaker aliases scoped by real upload id when combining multiple recordings", () => {
    const morning = payload("upload_morning", "2026-06-10T01:00:00.000Z", 60);
    const afternoon = payload("upload_afternoon", "2026-06-10T06:00:00.000Z", 90);
    morning.speakerAliases = { speaker_1: "张三" };
    afternoon.speakerAliases = { speaker_1: "李四" };

    const combined = combineDayPayloads([morning, afternoon]);

    expect(combined.speakerAliases).toEqual({});
    expect(combined.speakerAliasesByUploadId).toEqual({
      upload_morning: { speaker_1: "张三" },
      upload_afternoon: { speaker_1: "李四" }
    });
  });
});
