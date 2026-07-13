import { describe, expect, it } from "vitest";

import type { AudioInsight, BriefItem, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import type { LocalDayPayload } from "./local-analysis";
import { buildQaScopeMeta } from "./qa-scope-metadata";

function segment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: "seg_1",
    uploadId: "upload_1",
    startSeconds: 0,
    endSeconds: 20,
    speaker: "speaker_1",
    text: "这次约会里提到了下次见面的安排。",
    confidence: 0.92,
    sceneLabels: ["self_reflection"],
    valueLabels: ["idea"],
    ...overrides
  };
}

function audioInsight(overrides: Partial<AudioInsight> = {}): AudioInsight {
  return {
    id: "insight_1",
    uploadId: "upload_1",
    sourceSegmentIds: ["seg_1"],
    sourceTimeRange: { startSeconds: 0, endSeconds: 20 },
    speaker: { id: "speaker_1", role: "other", confidence: 0.7 },
    voice: { pace: "normal", volume: "unknown", pause: "normal", overlap: false, confidence: 0.4 },
    toneLabels: ["comforting"],
    emotionLabels: ["interested"],
    interactionLabels: ["rapport"],
    atmosphereLabels: ["warm"],
    summary: "互动氛围偏温和。",
    evidence: "先回应感受，再讨论安排。",
    confidence: 0.72,
    ...overrides
  };
}

function semanticSegment(overrides: Partial<SemanticSegment> = {}): SemanticSegment {
  return {
    id: "semantic_1",
    uploadId: "upload_1",
    title: "下次见面安排",
    summary: "双方讨论了下次见面的可能时间。",
    startSeconds: 0,
    endSeconds: 30,
    tags: ["约会"],
    sceneLabels: ["self_reflection"],
    valueLabels: ["open_question"],
    confidence: 0.8,
    sourceSegmentIds: ["seg_1"],
    sourceTimeRange: { startSeconds: 0, endSeconds: 30 },
    transcriptExcerpt: "那我们下周再看时间。",
    ...overrides
  };
}

function briefItem(overrides: Partial<BriefItem> = {}): BriefItem {
  return {
    id: "brief_1",
    uploadId: "upload_1",
    category: "open_question",
    title: "下次见面还没说清",
    body: "下次见面时间还需要继续确认。",
    priority: "high",
    confidence: 0.84,
    status: "confirmed",
    sourceSegmentIds: ["seg_1"],
    sourceTimeRange: { startSeconds: 0, endSeconds: 20 },
    transcriptExcerpt: "下周再看时间。",
    people: [],
    topics: ["见面安排"],
    ...overrides
  };
}

function payload(overrides: Partial<LocalDayPayload> = {}): LocalDayPayload {
  const uploadId = overrides.upload?.id ?? "upload_1";
  return {
    upload: {
      id: uploadId,
      originalName: `${uploadId}.mp3`,
      mimeType: "audio/mpeg",
      sizeBytes: 1024,
      recordingDate: "2026-07-09",
      createdAt: "2026-07-09T10:00:00.000Z",
      status: "ready",
      ...overrides.upload
    },
    job: {
      id: `job_${uploadId}`,
      uploadId,
      status: "ready",
      progress: 100,
      ...overrides.job
    },
    segments: [segment({ uploadId })],
    audioInsights: [audioInsight({ uploadId })],
    semanticSegments: [semanticSegment({ uploadId })],
    semanticSegmentsAvailable: true,
    briefItems: [briefItem({ uploadId })],
    relationshipSignals: [],
    relationshipSignalsAvailable: true,
    ...overrides
  };
}

describe("buildQaScopeMeta", () => {
  it("describes the current recording scope with local evidence counts", () => {
    const meta = buildQaScopeMeta({
      scope: "current",
      referenceDate: "2026-07-09",
      payload: payload()
    });

    expect(meta).toEqual(
      expect.objectContaining({
        scope: "current",
        label: "当前录音",
        description: "仅基于当前这段录音回答",
        recordingCount: 1,
        dateRangeLabel: "2026-07-09",
        evidenceCount: 4
      })
    );
  });

  it("counts only selected-week ready recordings and evidence", () => {
    const meta = buildQaScopeMeta({
      scope: "week",
      referenceDate: "2026-07-09",
      memoryPayloads: [
        payload({ upload: { ...payload().upload, id: "last_week", recordingDate: "2026-07-01" } }),
        payload({ upload: { ...payload().upload, id: "this_week", recordingDate: "2026-07-09" } })
      ]
    });

    expect(meta).toEqual(
      expect.objectContaining({
        scope: "week",
        label: "本周范围",
        description: "基于本周已处理录音回答",
        recordingCount: 1,
        dateRangeLabel: "2026-07-09",
        evidenceCount: 4
      })
    );
  });

  it("describes all memory with date coverage and a caution", () => {
    const meta = buildQaScopeMeta({
      scope: "all",
      referenceDate: "2026-07-09",
      memoryPayloads: [
        payload({ upload: { ...payload().upload, id: "day_one", recordingDate: "2026-07-01" } }),
        payload({ upload: { ...payload().upload, id: "day_two", recordingDate: "2026-07-09" } })
      ]
    });

    expect(meta).toEqual(
      expect.objectContaining({
        scope: "all",
        label: "全部记忆",
        description: "基于全部已处理记忆回答，长期结论需要足够证据支持",
        recordingCount: 2,
        dateRangeLabel: "2026-07-01 至 2026-07-09",
        evidenceCount: 8,
        caution: "长期结论需要至少两个不同日期的证据支持"
      })
    );
  });

  it("uses recordingDates when only server-side scope data is available", () => {
    const meta = buildQaScopeMeta({
      scope: "week",
      referenceDate: "2026-07-09",
      recordingDates: ["2026-07-01", "2026-07-08", "2026-07-09"],
      hasServerScopeData: true
    });

    expect(meta.recordingCount).toBe(2);
    expect(meta.dateRangeLabel).toBe("2026-07-08 至 2026-07-09");
    expect(meta.evidenceCount).toBeUndefined();
  });
});
