// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonStore } from "@/lib/server/storage/json-store";

import type { WorkMeetingExtractor } from "./analysis-provider";
import { openWorkReviewDatabase } from "./db";
import type { WorkMeetingProcessorDependencies } from "./orchestrator";
import { recoverStaleWorkMeetings } from "./recovery";
import {
  WorkReviewLeaseLostError,
  WorkReviewRepository,
  type WorkProcessingFence,
  type WorkTranscriptSegment
} from "./repository";

const INITIAL_NOW = "2026-09-01T10:00:00.000Z";
const RECOVERY_NOW = "2026-09-01T10:30:00.000Z";
const UPLOADS_ROOT = "C:\\test-data\\work-review";

let database: Database.Database;
let repository: WorkReviewRepository;
let sequence: number;

beforeEach(() => {
  database = openWorkReviewDatabase({ filePath: ":memory:" });
  sequence = 0;
  repository = new WorkReviewRepository(database, {
    now: () => INITIAL_NOW,
    idFactory: () => `recovery_${++sequence}`
  });
});

afterEach(() => database.close());

function seedMeeting(input: {
  suffix: string;
  accountId?: string;
  publishSource?: boolean;
}) {
  const accountId = input.accountId ?? "account_a";
  const meeting = repository.reserveMeeting({
    accountId,
    idempotencyKey: `upload_${input.suffix}`,
    operationKey: `upload_${input.suffix}`,
    contentHash: "a".repeat(64),
    meetingId: `meeting_${input.suffix}`,
    sourceUploadId: `source_${input.suffix}`,
    title: `恢复验证 ${input.suffix}`,
    meetingDate: "2026-09-01"
  }).meeting;
  if (input.publishSource !== false) {
    repository.publishSourceUpload({
      accountId,
      meetingId: meeting.id,
      uploadId: meeting.sourceUploadId,
      originalName: `${input.suffix}.wav`,
      mimeType: "audio/wav",
      sizeBytes: 1_024,
      recordingDate: "2026-09-01",
      filePath: `${UPLOADS_ROOT}\\${accountId}\\${input.suffix}.wav`,
      contentHash: "a".repeat(64)
    });
  }
  return { accountId, meeting };
}

function segment(uploadId: string, id = "segment_1"): WorkTranscriptSegment {
  return {
    id,
    uploadId,
    startSeconds: 0,
    endSeconds: 4,
    speaker: "Speaker 1",
    text: "这是用于恢复验证的会议内容。",
    confidence: 0.98,
    sceneLabels: [],
    valueLabels: []
  };
}

function claimExpiredTranscription(input: {
  accountId: string;
  meetingId: string;
}): WorkProcessingFence {
  repository.queueStage({ ...input, stage: "transcription" });
  const fence = repository.claimProcessingAttempt({
    ...input,
    stage: "transcription",
    leaseOwner: `old-transcriber-${input.meetingId}`,
    leaseDurationMs: 60_000,
    pipelineVersion: "test_pipeline",
    providerProfile: "test_transcriber"
  });
  if (!fence) throw new Error("expected transcription fence");
  return fence;
}

function publishCanonicalTranscript(input: {
  accountId: string;
  meetingId: string;
  uploadId: string;
}) {
  repository.queueStage({
    accountId: input.accountId,
    meetingId: input.meetingId,
    stage: "transcription"
  });
  const fence = repository.claimProcessingAttempt({
    accountId: input.accountId,
    meetingId: input.meetingId,
    stage: "transcription",
    leaseOwner: `seed-transcriber-${input.meetingId}`,
    leaseDurationMs: 60_000,
    pipelineVersion: "test_pipeline",
    providerProfile: "test_transcriber"
  });
  if (!fence) throw new Error("expected seed transcription fence");
  repository.publishCanonicalTranscript({
    accountId: input.accountId,
    meetingId: input.meetingId,
    fence,
    segments: [segment(input.uploadId)],
    sourceDurationSeconds: 4
  });
}

function emptyExtractor(): WorkMeetingExtractor {
  return {
    profile: {
      profileId: "work-recovery-extractor-test",
      provider: "fixture",
      model: "deterministic-test",
      reasoningEffort: "provider_default",
      timeoutMs: 1_000,
      maxOutputTokens: 1_024,
      promptVersion: "work_meeting_extractor_v1",
      schemaVersion: "work_meeting_candidates_v1"
    },
    extract: vi.fn(async () => [])
  };
}

function processorDependencies(input: {
  transcriber?: WorkMeetingProcessorDependencies["transcriber"];
  analysisEnabled?: boolean;
  extractor?: WorkMeetingExtractor;
} = {}): Omit<WorkMeetingProcessorDependencies, "repository"> {
  const extractor = input.extractor ?? emptyExtractor();
  return {
    transcriber: input.transcriber,
    probeDurationSeconds: vi.fn(async () => 4),
    cleanupRawAudio: vi.fn(async () => undefined),
    resolveFeatureFlags: () => ({
      enabled: true,
      uploadEnabled: true,
      analysisEnabled: input.analysisEnabled ?? false,
      verifierEnabled: false,
      todoEnabled: false,
      todoMeetingProjectionEnabled: false,
      followUpEnabled: false,
      recoveryEnabled: true
    }),
    createAnalysisProviders: () => ({ extractor }),
    leaseOwnerFactory: (stage) => `recovery-test-${stage}`
  };
}

function recoveryInput(overrides: Partial<Parameters<typeof recoverStaleWorkMeetings>[0]> = {}) {
  return {
    allowTranscription: true,
    allowAnalysis: true,
    resolveRuntime: async () => ({
      store: {} as JsonStore,
      uploadsRootDir: UPLOADS_ROOT
    }),
    staleAfterMs: 5 * 60_000,
    now: RECOVERY_NOW,
    ...overrides
  };
}

describe("recoverStaleWorkMeetings", () => {
  it("recovers stale transcription once and fences the expired worker", async () => {
    const { accountId, meeting } = seedMeeting({ suffix: "transcription" });
    const expiredFence = claimExpiredTranscription({ accountId, meetingId: meeting.id });
    const transcriber = vi.fn(async () => [segment(meeting.sourceUploadId)]);

    const first = await recoverStaleWorkMeetings(recoveryInput(), {
      database,
      processorDependencies: processorDependencies({ transcriber })
    });

    expect(first).toEqual({
      selected: 1,
      completed: 1,
      recovered: 1,
      failed: 0,
      skippedBusy: 0,
      skippedChanged: 0,
      skippedDeleted: 0,
      errors: 0
    });
    expect(transcriber).toHaveBeenCalledTimes(1);
    expect(repository.getMeeting(accountId, meeting.id)).toMatchObject({
      ingestionStatus: "transcript_ready",
      currentTranscriptionAttempt: 2,
      canonicalSegmentCount: 1
    });
    expect(() => repository.publishCanonicalTranscript({
      accountId,
      meetingId: meeting.id,
      fence: expiredFence,
      segments: [segment(meeting.sourceUploadId, "late_segment")]
    })).toThrow(WorkReviewLeaseLostError);

    const publicationCount = database.prepare(`
      SELECT COUNT(*) AS count FROM wr_canonical_publications
      WHERE account_id = ? AND meeting_id = ?
    `).get(accountId, meeting.id) as { count: number };
    expect(publicationCount.count).toBe(1);

    const second = await recoverStaleWorkMeetings(recoveryInput(), {
      database,
      processorDependencies: processorDependencies({ transcriber })
    });
    expect(second.selected).toBe(0);
    expect(transcriber).toHaveBeenCalledTimes(1);
  });

  it("recovers stale analysis without duplicating canonical or derived records", async () => {
    const { accountId, meeting } = seedMeeting({ suffix: "analysis" });
    publishCanonicalTranscript({
      accountId,
      meetingId: meeting.id,
      uploadId: meeting.sourceUploadId
    });
    repository.queueStage({ accountId, meetingId: meeting.id, stage: "meeting_analysis" });
    const oldAnalysisFence = repository.claimProcessingAttempt({
      accountId,
      meetingId: meeting.id,
      stage: "meeting_analysis",
      leaseOwner: "old-analysis-worker",
      leaseDurationMs: 60_000,
      pipelineVersion: "test_pipeline",
      providerProfile: "test_extractor",
      promptVersion: "work_meeting_extractor_v1"
    });
    expect(oldAnalysisFence).not.toBeNull();
    const extractor = emptyExtractor();

    const first = await recoverStaleWorkMeetings(recoveryInput(), {
      database,
      processorDependencies: processorDependencies({
        analysisEnabled: true,
        extractor
      })
    });

    expect(first.recovered).toBe(1);
    expect(repository.getMeeting(accountId, meeting.id)).toMatchObject({
      ingestionStatus: "transcript_ready",
      analysisStatus: "review_ready",
      currentAnalysisAttempt: 2
    });
    expect(extractor.extract).toHaveBeenCalledTimes(1);
    expect((database.prepare(`
      SELECT COUNT(*) AS count FROM wr_canonical_publications
      WHERE account_id = ? AND meeting_id = ?
    `).get(accountId, meeting.id) as { count: number }).count).toBe(1);
    expect((database.prepare(`
      SELECT COUNT(*) AS count FROM wr_meeting_candidates
      WHERE account_id = ? AND meeting_id = ?
    `).get(accountId, meeting.id) as { count: number }).count).toBe(0);
    expect((database.prepare(`
      SELECT COUNT(*) AS count FROM wr_findings
      WHERE account_id = ? AND meeting_id = ?
    `).get(accountId, meeting.id) as { count: number }).count).toBe(0);

    const attemptCountBefore = (database.prepare(`
      SELECT COUNT(*) AS count FROM wr_processing_attempts
      WHERE account_id = ? AND meeting_id = ? AND stage = 'meeting_analysis'
    `).get(accountId, meeting.id) as { count: number }).count;
    const second = await recoverStaleWorkMeetings(recoveryInput(), {
      database,
      processorDependencies: processorDependencies({
        analysisEnabled: true,
        extractor
      })
    });
    expect(second.selected).toBe(0);
    expect((database.prepare(`
      SELECT COUNT(*) AS count FROM wr_processing_attempts
      WHERE account_id = ? AND meeting_id = ? AND stage = 'meeting_analysis'
    `).get(accountId, meeting.id) as { count: number }).count).toBe(attemptCountBefore);
  });

  it("does not take over a stale meeting while its current lease is still live", async () => {
    const { accountId, meeting } = seedMeeting({ suffix: "busy" });
    repository.queueStage({ accountId, meetingId: meeting.id, stage: "transcription" });
    repository.claimProcessingAttempt({
      accountId,
      meetingId: meeting.id,
      stage: "transcription",
      leaseOwner: "active-worker",
      leaseDurationMs: 60 * 60_000,
      pipelineVersion: "test_pipeline",
      providerProfile: "test_transcriber"
    });
    const transcriber = vi.fn(async () => [segment(meeting.sourceUploadId)]);

    const summary = await recoverStaleWorkMeetings(recoveryInput(), {
      database,
      processorDependencies: processorDependencies({ transcriber })
    });

    expect(summary).toMatchObject({ selected: 1, skippedBusy: 1, recovered: 0 });
    expect(transcriber).not.toHaveBeenCalled();
    expect(repository.getMeeting(accountId, meeting.id)).toMatchObject({
      ingestionStatus: "transcribing",
      currentTranscriptionAttempt: 1
    });
  });

  it("never selects a tombstoned meeting for recovery", async () => {
    const { accountId, meeting } = seedMeeting({ suffix: "deleted" });
    claimExpiredTranscription({ accountId, meetingId: meeting.id });
    repository.deleteMeeting({ accountId, meetingId: meeting.id });
    const transcriber = vi.fn(async () => [segment(meeting.sourceUploadId)]);

    const summary = await recoverStaleWorkMeetings(recoveryInput(), {
      database,
      processorDependencies: processorDependencies({ transcriber })
    });

    expect(summary.selected).toBe(0);
    expect(transcriber).not.toHaveBeenCalled();
    expect(repository.getMeeting(accountId, meeting.id).ingestionStatus).toBe("deleted");
  });

  it("does not fail a candidate that changed while runtime resolution was pending", async () => {
    const { accountId, meeting } = seedMeeting({ suffix: "runtime-race" });
    claimExpiredTranscription({ accountId, meetingId: meeting.id });
    let freshFence: WorkProcessingFence | null = null;

    const summary = await recoverStaleWorkMeetings(recoveryInput({
      resolveRuntime: async () => {
        freshFence = repository.claimProcessingAttempt({
          accountId,
          meetingId: meeting.id,
          stage: "transcription",
          leaseOwner: "fresh-runtime-worker",
          leaseDurationMs: 60_000,
          pipelineVersion: "test_pipeline",
          providerProfile: "test_transcriber",
          now: "2026-09-01T10:31:00.000Z"
        });
        return null;
      }
    }), {
      database,
      processingNow: () => "2026-09-01T10:31:01.000Z"
    });

    expect(freshFence).not.toBeNull();
    expect(summary).toMatchObject({
      selected: 1,
      failed: 0,
      skippedChanged: 1,
      errors: 0
    });
    expect(repository.getMeeting(accountId, meeting.id)).toMatchObject({
      ingestionStatus: "transcribing",
      currentTranscriptionAttempt: 2,
      errorCode: null
    });
  });

  it("fences and marks an unsafe stale state failed instead of looping forever", async () => {
    const { accountId, meeting } = seedMeeting({
      suffix: "missing-source",
      publishSource: false
    });
    repository.queueStage({ accountId, meetingId: meeting.id, stage: "transcription" });

    const summary = await recoverStaleWorkMeetings(recoveryInput(), { database });

    expect(summary).toMatchObject({ selected: 1, failed: 1, recovered: 0, errors: 0 });
    expect(repository.getMeeting(accountId, meeting.id)).toMatchObject({
      ingestionStatus: "failed",
      currentTranscriptionAttempt: 1,
      errorStage: "transcription",
      errorCode: "work_review_recovery_source_unavailable"
    });
  });

  it("honors the requested batch bound and reports count-only progress", async () => {
    const first = seedMeeting({ suffix: "batch-a", accountId: "account_a" });
    const second = seedMeeting({ suffix: "batch-b", accountId: "account_b" });
    claimExpiredTranscription({
      accountId: first.accountId,
      meetingId: first.meeting.id
    });
    claimExpiredTranscription({
      accountId: second.accountId,
      meetingId: second.meeting.id
    });
    const onProgress = vi.fn();
    const transcriber = vi.fn(async (input) => [segment(input.uploadId)]);

    const summary = await recoverStaleWorkMeetings(recoveryInput({ batchSize: 1 }), {
      database,
      processorDependencies: processorDependencies({ transcriber }),
      onProgress
    });

    expect(summary).toMatchObject({ selected: 1, completed: 1, recovered: 1 });
    expect(transcriber).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      completed: 0,
      total: 1,
      state: "started"
    });
    expect(onProgress).toHaveBeenLastCalledWith({
      completed: 1,
      total: 1,
      state: "completed"
    });
    const remaining = [
      repository.getMeeting(first.accountId, first.meeting.id),
      repository.getMeeting(second.accountId, second.meeting.id)
    ].filter((meeting) => meeting.ingestionStatus === "transcribing");
    expect(remaining).toHaveLength(1);
  });

  it("uses a live processing clock instead of freezing leases at batch start", async () => {
    const { accountId, meeting } = seedMeeting({ suffix: "live-clock" });
    repository.queueStage({ accountId, meetingId: meeting.id, stage: "transcription" });
    const times = [
      "2026-09-01T10:30:00.000Z",
      "2026-09-01T10:32:00.000Z"
    ];
    const processingNow = vi.fn(() => times.shift() ?? "2026-09-01T10:32:00.000Z");

    const summary = await recoverStaleWorkMeetings(recoveryInput(), {
      database,
      processingNow,
      processMeeting: async (request, dependencies) => {
        const processingRepository = dependencies?.repository;
        if (!processingRepository) throw new Error("missing recovery repository");
        const fence = processingRepository.claimProcessingAttempt({
          accountId: request.accountId,
          meetingId: request.meetingId,
          stage: "transcription",
          leaseOwner: "live-clock-worker",
          leaseDurationMs: 60_000,
          pipelineVersion: "test_pipeline",
          providerProfile: "test_transcriber"
        });
        if (!fence) throw new Error("expected live-clock fence");
        expect(() => processingRepository.renewProcessingLease({
          accountId: request.accountId,
          meetingId: request.meetingId,
          fence,
          leaseDurationMs: 60_000
        })).toThrow(WorkReviewLeaseLostError);
        return {
          meetingId: request.meetingId,
          transcriptReady: false,
          analysisReady: false,
          busy: true
        };
      }
    });

    expect(processingNow).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ selected: 1, skippedBusy: 1 });
  });
});
