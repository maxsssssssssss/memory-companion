// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonStore } from "@/lib/server/storage/json-store";

import type { WorkMeetingExtractor } from "./analysis-provider";
import { openWorkReviewDatabase } from "./db";
import { processWorkMeeting } from "./orchestrator";
import { WorkReviewRepository } from "./repository";

let database: Database.Database;
let repository: WorkReviewRepository;

beforeEach(() => {
  database = openWorkReviewDatabase({ filePath: ":memory:" });
  repository = new WorkReviewRepository(database, {
    now: () => "2026-09-01T10:00:00.000Z",
    idFactory: (() => {
      let value = 0;
      return () => `orchestrator_${++value}`;
    })()
  });
});

afterEach(() => database.close());

function seedSourceAudio() {
  const meeting = repository.reserveMeeting({
    accountId: "account_a",
    idempotencyKey: "orchestrator_upload",
    operationKey: "orchestrator_upload",
    contentHash: "a".repeat(64),
    meetingId: "meeting_orchestrator",
    sourceUploadId: "source_orchestrator",
    title: "失败恢复验证会议",
    meetingDate: "2026-09-01"
  }).meeting;
  repository.publishSourceUpload({
    accountId: "account_a",
    meetingId: meeting.id,
    uploadId: meeting.sourceUploadId,
    originalName: "meeting.wav",
    mimeType: "audio/wav",
    sizeBytes: 1_024,
    recordingDate: "2026-09-01",
    filePath: "C:\\test-data\\account_a\\uploads\\source_orchestrator.wav",
    contentHash: "a".repeat(64)
  });
  return meeting;
}

describe("processWorkMeeting", () => {
  it("persists authoritative duration and keeps canonical transcript after analysis failure", async () => {
    const meeting = seedSourceAudio();
    const probeDurationSeconds = vi.fn(async () => 367.25);
    const transcriber = vi.fn(async () => [{
      id: "segment_1",
      uploadId: meeting.sourceUploadId,
      startSeconds: 0,
      endSeconds: 8,
      speaker: "Speaker 1",
      text: "我们先保留这个方案，下周再确认。",
      confidence: 0.97,
      sceneLabels: [],
      valueLabels: []
    }]);
    const extractor: WorkMeetingExtractor = {
      profile: {
        profileId: "work-meeting-extractor-test",
        provider: "fixture",
        model: "deterministic-test",
        reasoningEffort: "provider_default",
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        promptVersion: "work_meeting_extractor_v1",
        schemaVersion: "work_meeting_candidates_v1"
      },
      extract: vi.fn(async () => {
        throw Object.assign(new Error("deterministic analysis failure"), {
          code: "work_review_analysis_fixture_failure"
        });
      })
    };
    const cleanupRawAudio = vi.fn(async () => undefined);

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds,
      transcriber,
      cleanupRawAudio,
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      createAnalysisProviders: () => ({ extractor }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toEqual({
      meetingId: meeting.id,
      transcriptReady: true,
      analysisReady: false,
      busy: false
    });
    expect(probeDurationSeconds).toHaveBeenCalledWith(
      "C:\\test-data\\account_a\\uploads\\source_orchestrator.wav"
    );
    expect(transcriber).toHaveBeenCalledTimes(1);
    expect(cleanupRawAudio).toHaveBeenCalledTimes(1);
    expect(repository.getMeeting("account_a", meeting.id)).toMatchObject({
      ingestionStatus: "transcript_ready",
      sourceDurationSeconds: 367.25,
      canonicalSegmentCount: 1,
      analysisStatus: "failed",
      errorStage: "meeting_analysis",
      errorCode: "work_review_analysis_fixture_failure"
    });
    expect(repository.readCanonicalPublication("account_a", meeting.id)).toMatchObject({
      sourceUploadId: meeting.sourceUploadId,
      segmentCount: 1,
      segments: [expect.objectContaining({
        id: "segment_1",
        text: "我们先保留这个方案，下周再确认。"
      })]
    });
    expect(repository.readSourceUpload("account_a", meeting.id)?.filePath).toBeNull();
  });

  it("fails before ASR when ffprobe reports audio beyond the Work limit", async () => {
    const meeting = seedSourceAudio();
    const transcriber = vi.fn();

    const result = await processWorkMeeting({
      accountId: "account_a",
      meetingId: meeting.id,
      store: {} as JsonStore,
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    }, {
      repository,
      probeDurationSeconds: vi.fn(async () => 3_601),
      transcriber,
      resolveCapacityLimits: () => ({
        maxUploadBytes: 1024,
        maxAudioDurationSeconds: 3_600
      }),
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: false,
        verifierEnabled: false,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: false,
        recoveryEnabled: false
      }),
      leaseOwnerFactory: (stage) => `test_${stage}`
    });

    expect(result).toEqual({
      meetingId: meeting.id,
      transcriptReady: false,
      analysisReady: false,
      busy: false
    });
    expect(transcriber).not.toHaveBeenCalled();
    expect(repository.readCanonicalPublication("account_a", meeting.id)).toBeNull();
    expect(repository.getMeeting("account_a", meeting.id)).toMatchObject({
      ingestionStatus: "failed",
      sourceDurationSeconds: null,
      errorStage: "transcription",
      errorCode: "work_review_audio_duration_exceeded"
    });
  });
});
