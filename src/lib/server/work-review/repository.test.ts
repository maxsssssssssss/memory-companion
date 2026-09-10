import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkMeetingCandidateStructuredDataSchema } from "@/lib/domain/work-review";

import { openWorkReviewDatabase } from "./db";
import {
  WorkReviewAnalysisDeadlineExceededError,
  WorkReviewConflictError,
  WorkReviewLeaseLostError,
  WorkReviewNotFoundError,
  WorkReviewRepository,
  type WorkProcessingFence,
  type WorkTranscriptSegment
} from "./repository";
import { WORK_REVIEW_SCHEMA_VERSION } from "./schema";

const initialNow = "2026-09-01T00:00:00.000Z";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

let database: Database.Database;
let repository: WorkReviewRepository;
let generatedId = 0;

beforeEach(() => {
  database = openWorkReviewDatabase({ filePath: ":memory:" });
  generatedId = 0;
  repository = new WorkReviewRepository(database, {
    now: () => initialNow,
    idFactory: () => `generated_${++generatedId}`
  });
});

afterEach(() => database.close());

function reserve(accountId = "account_a", idempotencyKey = "upload_once") {
  return repository.reserveMeeting({
    accountId,
    idempotencyKey,
    contentHash: hashA,
    sourceUploadId: `upload_${accountId}_${idempotencyKey}`,
    title: "产品评审会",
    meetingDate: "2026-09-01",
    sourceDurationSeconds: 94
  });
}

function segment(uploadId: string, overrides: Partial<WorkTranscriptSegment> = {}): WorkTranscriptSegment {
  return {
    id: "segment_1",
    uploadId,
    startSeconds: 0,
    endSeconds: 8,
    speaker: "Speaker 1",
    text: "我来在周五前完成接口测试。",
    confidence: 0.98,
    sceneLabels: [],
    valueLabels: [],
    ...overrides
  };
}

function publishTranscript(accountId = "account_a") {
  const created = reserve(accountId);
  repository.publishSourceUpload({
    accountId,
    meetingId: created.meeting.id,
    uploadId: created.meeting.sourceUploadId,
    originalName: "meeting.wav",
    mimeType: "audio/wav",
    sizeBytes: 1024,
    recordingDate: "2026-09-01",
    filePath: `C:\\safe-test-uploads\\${created.meeting.sourceUploadId}.wav`,
    contentHash: hashA
  });
  repository.queueStage({
    accountId,
    meetingId: created.meeting.id,
    stage: "transcription"
  });
  const fence = repository.claimProcessingAttempt({
    accountId,
    meetingId: created.meeting.id,
    stage: "transcription",
    leaseOwner: "transcriber_1",
    leaseDurationMs: 60_000,
    pipelineVersion: "work_meeting_v1",
    providerProfile: "fixture_explicit_test"
  });
  if (!fence) throw new Error("expected transcription fence");
  const published = repository.publishCanonicalTranscript({
    accountId,
    meetingId: created.meeting.id,
    fence,
    segments: [segment(created.meeting.sourceUploadId)]
  });
  return { created, fence, published };
}

function publishReviewReadyMeeting() {
  const transcript = publishTranscript();
  repository.queueStage({
    accountId: "account_a",
    meetingId: transcript.created.meeting.id,
    stage: "meeting_analysis"
  });
  const fence = repository.claimProcessingAttempt({
    accountId: "account_a",
    meetingId: transcript.created.meeting.id,
    stage: "meeting_analysis",
    leaseOwner: "analysis_1",
    leaseDurationMs: 60_000,
    pipelineVersion: "work_meeting_v1",
    providerProfile: "work_meeting_extractor_test",
    promptVersion: "work_meeting_extractor_v1"
  });
  if (!fence) throw new Error("expected analysis fence");
  repository.markAnalysisVerifying({
    accountId: "account_a",
    meetingId: transcript.created.meeting.id,
    fence
  });
  const candidates = repository.publishAnalysisResult({
    accountId: "account_a",
    meetingId: transcript.created.meeting.id,
    fence,
    canonicalContentDigest: transcript.published.publication.contentDigest,
    candidates: [{
      kind: "commitment",
      title: "完成接口测试",
      body: "Speaker 1 明确承诺在周五前完成接口测试。",
      structuredData: {
        decisionFinality: null,
        rawActorLabel: "Speaker 1",
        candidateOwner: null,
        dueAt: null,
        originalDueExpression: "周五前",
        actionBasis: "explicit_commitment",
        relatedCommitmentCandidateId: null,
        planStages: []
      },
      publicationAction: "show_as_candidate",
      riskLevel: "high",
      generatorProfile: "work_meeting_extractor_test",
      generatorPromptVersion: "work_meeting_extractor_v1",
      evidenceSegmentIds: ["segment_1"],
      timestampQualityBySegmentId: { segment_1: "provider_exact" },
      claims: [{
        claimType: "commitment_existence",
        text: "有人明确承诺完成接口测试。",
        evidenceSegmentIds: ["segment_1"],
        evaluation: {
          supportVerdict: "entailed",
          issueCodes: [],
          riskLevel: "high",
          publicationAction: "show_as_candidate",
          confirmationRequired: true,
          supportedEvidenceIds: ["segment_1"],
          generatorProfile: "work_meeting_extractor_test",
          verifierProfile: "work_meeting_verifier_test",
          verifierPromptVersion: "work_meeting_verifier_v1",
          policyVersion: "work_meeting_publication_v1"
        }
      }]
    }]
  });
  return { ...transcript, analysisFence: fence, candidate: candidates[0]! };
}

describe("WorkReviewRepository", () => {
  it("opens an isolated WAL database with the expected pragmas and migration", () => {
    const root = mkdtempSync(join(tmpdir(), "work-review-db-"));
    const filePath = join(root, "work-review.sqlite");
    const fileDatabase = openWorkReviewDatabase({ filePath });
    try {
      expect(fileDatabase.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(fileDatabase.pragma("busy_timeout", { simple: true })).toBe(5000);
      expect(fileDatabase.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(fileDatabase.pragma("synchronous", { simple: true })).toBe(1);
      expect(fileDatabase.pragma("user_version", { simple: true }))
        .toBe(WORK_REVIEW_SCHEMA_VERSION);
      expect((fileDatabase.prepare("PRAGMA table_info(wr_processing_attempts)").all() as
        Array<{ name: string }>).map((column) => column.name)).toContain("deadline_at");
      expect(fileDatabase.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'wr_analysis_checkpoints'
      `).get()).toEqual({ name: "wr_analysis_checkpoints" });
    } finally {
      fileDatabase.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scopes meetings by account and replays only the same idempotency key and content hash", () => {
    const first = reserve();
    const replay = repository.reserveMeeting({
      accountId: "account_a",
      idempotencyKey: "upload_once",
      contentHash: hashA,
      sourceUploadId: "ignored_new_upload_id",
      meetingDate: "2026-09-02",
      title: "客户端重试时改变的标题"
    });

    expect(replay.reused).toBe(true);
    expect(replay.meeting.id).toBe(first.meeting.id);
    expect(repository.listMeetings("account_a")).toHaveLength(1);
    expect(() => repository.getMeeting("account_b", first.meeting.id))
      .toThrow(WorkReviewNotFoundError);
    expect(() => repository.reserveMeeting({
      accountId: "account_a",
      idempotencyKey: "upload_once",
      contentHash: hashB,
      sourceUploadId: "upload_conflict",
      meetingDate: "2026-09-01"
    })).toThrowError(expect.objectContaining({
      code: "work_review_idempotency_conflict"
    }));
  });

  it("lets the first same-hash source publication win across concurrent request metadata", () => {
    const created = reserve();
    const first = repository.publishSourceUpload({
      accountId: "account_a",
      meetingId: created.meeting.id,
      uploadId: created.meeting.sourceUploadId,
      originalName: "first-name.wav",
      mimeType: "audio/wav",
      sizeBytes: 1024,
      recordingDate: "2026-09-01",
      filePath: `C:\\safe-test-uploads\\${created.meeting.sourceUploadId}.request-first.wav`,
      contentHash: hashA
    });
    const replay = repository.publishSourceUpload({
      accountId: "account_a",
      meetingId: created.meeting.id,
      uploadId: created.meeting.sourceUploadId,
      originalName: "renamed-file.wav",
      mimeType: "audio/wav",
      sizeBytes: 1024,
      recordingDate: "2026-09-02",
      filePath: `C:\\safe-test-uploads\\${created.meeting.sourceUploadId}.request-second.wav`,
      contentHash: hashA
    });

    expect(first.reused).toBe(false);
    expect(replay).toMatchObject({
      reused: true,
      upload: {
        originalName: "first-name.wav",
        recordingDate: "2026-09-01",
        filePath: first.upload.filePath,
        contentHash: hashA
      }
    });
  });

  it("publishes one canonical authority only under the current live transcription fence", () => {
    const created = reserve();
    repository.publishSourceUpload({
      accountId: "account_a",
      meetingId: created.meeting.id,
      uploadId: created.meeting.sourceUploadId,
      originalName: "meeting.wav",
      mimeType: "audio/wav",
      sizeBytes: 1024,
      recordingDate: "2026-09-01",
      filePath: `C:\\safe-test-uploads\\${created.meeting.sourceUploadId}.wav`,
      contentHash: hashA
    });
    repository.queueStage({
      accountId: "account_a",
      meetingId: created.meeting.id,
      stage: "transcription"
    });
    const expired = repository.claimProcessingAttempt({
      accountId: "account_a",
      meetingId: created.meeting.id,
      stage: "transcription",
      leaseOwner: "old_worker",
      leaseDurationMs: 1_000,
      pipelineVersion: "v1",
      providerProfile: "fixture_explicit_test",
      now: "2026-09-01T00:00:00.000Z"
    });
    expect(expired).not.toBeNull();
    const current = repository.claimProcessingAttempt({
      accountId: "account_a",
      meetingId: created.meeting.id,
      stage: "transcription",
      leaseOwner: "new_worker",
      leaseDurationMs: 60_000,
      pipelineVersion: "v1",
      providerProfile: "fixture_explicit_test",
      now: "2026-09-01T00:00:02.000Z"
    });
    expect(current?.attemptVersion).toBe(2);
    expect(() => repository.publishCanonicalTranscript({
      accountId: "account_a",
      meetingId: created.meeting.id,
      fence: expired as WorkProcessingFence,
      segments: [segment(created.meeting.sourceUploadId)],
      now: "2026-09-01T00:00:02.000Z"
    })).toThrow(WorkReviewLeaseLostError);

    const result = repository.publishCanonicalTranscript({
      accountId: "account_a",
      meetingId: created.meeting.id,
      fence: current as WorkProcessingFence,
      segments: [segment(created.meeting.sourceUploadId)],
      now: "2026-09-01T00:00:03.000Z"
    });
    expect(result.publication.segmentCount).toBe(1);
    expect(result.publication.contentDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(repository.getMeeting("account_a", created.meeting.id)).toMatchObject({
      ingestionStatus: "transcript_ready",
      analysisStatus: "not_started",
      canonicalPublicationId: result.publication.publicationId
    });
    expect(repository.readSourceUpload("account_a", created.meeting.id)?.filePath)
      .toContain(created.meeting.sourceUploadId);
    expect(repository.clearSourceUploadPath({
      accountId: "account_a",
      meetingId: created.meeting.id,
      expectedFilePath: `C:\\safe-test-uploads\\${created.meeting.sourceUploadId}.wav`
    })?.filePath).toBeNull();
  });

  it("takes over expired extracting and verifying analysis leases but never a live lease", () => {
    const transcript = publishTranscript();
    repository.queueStage({
      accountId: "account_a", meetingId: transcript.created.meeting.id,
      stage: "meeting_analysis"
    });
    const oldFence = repository.claimProcessingAttempt({
      accountId: "account_a", meetingId: transcript.created.meeting.id,
      stage: "meeting_analysis", leaseOwner: "old_analysis", leaseDurationMs: 1_000,
      pipelineVersion: "v1", providerProfile: "extractor_test", promptVersion: "prompt_v1",
      now: "2026-09-01T00:00:00.000Z"
    })!;
    expect(repository.claimProcessingAttempt({
      accountId: "account_a", meetingId: transcript.created.meeting.id,
      stage: "meeting_analysis", leaseOwner: "too_early", leaseDurationMs: 60_000,
      pipelineVersion: "v1", providerProfile: "extractor_test", promptVersion: "prompt_v1",
      now: "2026-09-01T00:00:00.500Z"
    })).toBeNull();
    repository.markAnalysisVerifying({
      accountId: "account_a", meetingId: transcript.created.meeting.id,
      fence: oldFence, now: "2026-09-01T00:00:00.500Z"
    });
    const replacement = repository.claimProcessingAttempt({
      accountId: "account_a", meetingId: transcript.created.meeting.id,
      stage: "meeting_analysis", leaseOwner: "new_analysis", leaseDurationMs: 60_000,
      pipelineVersion: "v1", providerProfile: "extractor_test", promptVersion: "prompt_v1",
      now: "2026-09-01T00:00:02.000Z"
    });
    expect(replacement?.attemptVersion).toBe(2);
    expect(repository.getMeeting("account_a", transcript.created.meeting.id).analysisStatus)
      .toBe("extracting");
    expect(() => repository.markAnalysisVerifying({
      accountId: "account_a", meetingId: transcript.created.meeting.id,
      fence: oldFence, now: "2026-09-01T00:00:02.000Z"
    })).toThrow(WorkReviewLeaseLostError);
  });

  it("stores immutable analysis checkpoints and reuses them only under an exact current context", () => {
    const transcript = publishTranscript();
    const meetingId = transcript.created.meeting.id;
    repository.queueStage({ accountId: "account_a", meetingId, stage: "meeting_analysis" });
    const firstFence = repository.claimProcessingAttempt({
      accountId: "account_a",
      meetingId,
      stage: "meeting_analysis",
      leaseOwner: "checkpoint_analysis_1",
      leaseDurationMs: 60_000,
      pipelineVersion: "v1",
      providerProfile: "extractor_test",
      promptVersion: "prompt_v1",
      deadlineAt: "2026-09-01T00:00:30.000Z",
      now: initialNow
    })!;
    const checkpointInput = {
      accountId: "account_a",
      meetingId,
      fence: firstFence,
      publicationId: transcript.published.publication.publicationId,
      canonicalContentDigest: transcript.published.publication.contentDigest,
      checkpointKind: "extractor_block" as const,
      logicalInputDigest: hashA,
      providerContractDigest: hashB,
      outputSchemaVersion: "work_meeting_candidates_v1",
      now: "2026-09-01T00:00:01.000Z"
    };
    const first = repository.saveAnalysisCheckpoint({
      ...checkpointInput,
      payload: { items: [], metadata: { count: 0, complete: true } }
    });
    const replay = repository.saveAnalysisCheckpoint({
      ...checkpointInput,
      payload: { metadata: { complete: true, count: 0 }, items: [] }
    });

    expect(first).toMatchObject({
      reused: false,
      checkpoint: { originAttemptVersion: firstFence.attemptVersion, payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) }
    });
    expect(replay).toMatchObject({ reused: true, checkpoint: { payload: first.checkpoint.payload } });
    expect(repository.readAnalysisCheckpoint(checkpointInput)).toEqual(first.checkpoint);
    expect(repository.readAnalysisCheckpoint({
      ...checkpointInput,
      providerContractDigest: "c".repeat(64)
    })).toBeNull();
    expect(() => repository.saveAnalysisCheckpoint({
      ...checkpointInput,
      payload: { items: [{ unsafe: "different" }] }
    })).toThrowError(expect.objectContaining({ code: "work_review_analysis_checkpoint_conflict" }));
    expect(() => repository.readAnalysisCheckpoint({
      ...checkpointInput,
      accountId: "account_b"
    })).toThrow(WorkReviewNotFoundError);

    repository.markStageFailed({
      accountId: "account_a",
      meetingId,
      fence: firstFence,
      errorCode: "provider_failed",
      now: "2026-09-01T00:00:02.000Z"
    });
    repository.queueStage({ accountId: "account_a", meetingId, stage: "meeting_analysis" });
    const replacementFence = repository.claimProcessingAttempt({
      accountId: "account_a",
      meetingId,
      stage: "meeting_analysis",
      leaseOwner: "checkpoint_analysis_2",
      leaseDurationMs: 60_000,
      pipelineVersion: "v1",
      providerProfile: "extractor_test",
      promptVersion: "prompt_v1",
      deadlineAt: "2026-09-01T00:00:30.000Z",
      now: "2026-09-01T00:00:03.000Z"
    })!;
    const replacementInput = {
      ...checkpointInput,
      fence: replacementFence,
      now: "2026-09-01T00:00:04.000Z"
    };
    expect(repository.readAnalysisCheckpoint(replacementInput)).toMatchObject({
      originAttemptVersion: firstFence.attemptVersion,
      payload: first.checkpoint.payload
    });
    expect(repository.saveAnalysisCheckpoint({
      ...replacementInput,
      payload: first.checkpoint.payload
    })).toMatchObject({ reused: true, checkpoint: { originAttemptVersion: firstFence.attemptVersion } });
    expect(() => repository.saveAnalysisCheckpoint({
      ...checkpointInput,
      now: "2026-09-01T00:00:04.000Z",
      payload: first.checkpoint.payload
    })).toThrow(WorkReviewLeaseLostError);

    database.prepare(`
      UPDATE wr_analysis_checkpoints SET payload_digest = ?
      WHERE account_id = ? AND meeting_id = ?
    `).run("d".repeat(64), "account_a", meetingId);
    expect(() => repository.readAnalysisCheckpoint(replacementInput))
      .toThrowError(expect.objectContaining({ code: "work_review_analysis_checkpoint_invalid" }));
  });

  it("enforces an immutable attempt deadline but still records terminal failure after expiry", () => {
    const transcript = publishTranscript();
    const meetingId = transcript.created.meeting.id;
    repository.queueStage({ accountId: "account_a", meetingId, stage: "meeting_analysis" });
    const fence = repository.claimProcessingAttempt({
      accountId: "account_a",
      meetingId,
      stage: "meeting_analysis",
      leaseOwner: "deadline_analysis",
      leaseDurationMs: 60_000,
      pipelineVersion: "v1",
      providerProfile: "extractor_test",
      promptVersion: "prompt_v1",
      deadlineAt: "2026-09-01T00:00:10+00:00",
      now: initialNow
    })!;
    const expiredNow = "2026-09-01T00:00:10.000Z";

    expect(fence.deadlineAt).toBe(expiredNow);
    expect(() => repository.saveAnalysisCheckpoint({
      accountId: "account_a",
      meetingId,
      fence,
      publicationId: transcript.published.publication.publicationId,
      canonicalContentDigest: transcript.published.publication.contentDigest,
      checkpointKind: "extractor_block",
      logicalInputDigest: hashA,
      providerContractDigest: hashB,
      outputSchemaVersion: "work_meeting_candidates_v1",
      payload: { items: [] },
      now: expiredNow
    })).toThrow(WorkReviewAnalysisDeadlineExceededError);
    expect(() => repository.markAnalysisVerifying({
      accountId: "account_a", meetingId, fence, now: expiredNow
    })).toThrow(WorkReviewAnalysisDeadlineExceededError);

    expect(repository.markStageFailed({
      accountId: "account_a",
      meetingId,
      fence,
      errorCode: "work_analysis_deadline_exceeded",
      now: expiredNow
    }).analysisStatus).toBe("failed");
    expect(() => database.prepare(`
      UPDATE wr_processing_attempts SET deadline_at = ?
      WHERE account_id = ? AND meeting_id = ? AND stage = 'meeting_analysis'
    `).run("2026-09-01T00:01:00.000Z", "account_a", meetingId))
      .toThrow(/work_review_processing_deadline_immutable/u);
  });

  it("samples implicit checkpoint and publication time only after the IMMEDIATE transaction begins", () => {
    const transcript = publishTranscript();
    const meetingId = transcript.created.meeting.id;
    repository.queueStage({ accountId: "account_a", meetingId, stage: "meeting_analysis" });
    const fence = repository.claimProcessingAttempt({
      accountId: "account_a",
      meetingId,
      stage: "meeting_analysis",
      leaseOwner: "deadline_lock_analysis",
      leaseDurationMs: 60_000,
      pipelineVersion: "v1",
      providerProfile: "extractor_test",
      promptVersion: "prompt_v1",
      deadlineAt: "2026-09-01T00:00:10.000Z",
      now: initialNow
    })!;
    const sampledTransactionStates: boolean[] = [];
    repository = new WorkReviewRepository(database, {
      now: () => {
        sampledTransactionStates.push(database.inTransaction);
        return "2026-09-01T00:00:10.000Z";
      },
      idFactory: () => `generated_${++generatedId}`
    });
    const checkpointInput = {
      accountId: "account_a",
      meetingId,
      fence,
      publicationId: transcript.published.publication.publicationId,
      canonicalContentDigest: transcript.published.publication.contentDigest,
      checkpointKind: "extractor_block" as const,
      logicalInputDigest: hashA,
      providerContractDigest: hashB,
      outputSchemaVersion: "work_meeting_candidates_v1"
    };

    expect(() => repository.readAnalysisCheckpoint(checkpointInput))
      .toThrow(WorkReviewAnalysisDeadlineExceededError);
    expect(() => repository.saveAnalysisCheckpoint({
      ...checkpointInput,
      payload: { items: [] }
    })).toThrow(WorkReviewAnalysisDeadlineExceededError);
    expect(() => repository.markAnalysisVerifying({
      accountId: "account_a", meetingId, fence
    })).toThrow(WorkReviewAnalysisDeadlineExceededError);

    repository.markAnalysisVerifying({
      accountId: "account_a",
      meetingId,
      fence,
      now: "2026-09-01T00:00:09.000Z"
    });
    const implicitCallsBeforePublish = sampledTransactionStates.length;
    expect(() => repository.publishAnalysisResult({
      accountId: "account_a",
      meetingId,
      fence,
      canonicalContentDigest: transcript.published.publication.contentDigest,
      candidates: []
    })).toThrow(WorkReviewAnalysisDeadlineExceededError);

    expect(sampledTransactionStates).toEqual([true, true, true, true]);
    expect(sampledTransactionStates).toHaveLength(implicitCallsBeforePublish + 1);
    expect(repository.getMeeting("account_a", meetingId)).toMatchObject({
      analysisStatus: "verifying",
      reviewStatus: "not_started"
    });
    expect(repository.listCandidates("account_a", meetingId)).toEqual([]);
  });

  it("keeps checkpoints on failed publication and clears them in the successful publication transaction", () => {
    const transcript = publishTranscript();
    const meetingId = transcript.created.meeting.id;
    repository.queueStage({ accountId: "account_a", meetingId, stage: "meeting_analysis" });
    const fence = repository.claimProcessingAttempt({
      accountId: "account_a",
      meetingId,
      stage: "meeting_analysis",
      leaseOwner: "publish_checkpoint_analysis",
      leaseDurationMs: 60_000,
      pipelineVersion: "v1",
      providerProfile: "extractor_test",
      promptVersion: "prompt_v1"
    })!;
    repository.saveAnalysisCheckpoint({
      accountId: "account_a",
      meetingId,
      fence,
      publicationId: transcript.published.publication.publicationId,
      canonicalContentDigest: transcript.published.publication.contentDigest,
      checkpointKind: "verifier_batch",
      logicalInputDigest: hashA,
      providerContractDigest: hashB,
      outputSchemaVersion: "work_meeting_claim_evaluations_v1",
      payload: { items: [] }
    });
    repository.markAnalysisVerifying({ accountId: "account_a", meetingId, fence });

    expect(() => repository.publishAnalysisResult({
      accountId: "account_a",
      meetingId,
      fence,
      canonicalContentDigest: "f".repeat(64),
      candidates: []
    })).toThrowError(expect.objectContaining({ code: "work_review_canonical_digest_mismatch" }));
    expect((database.prepare(`
      SELECT count(*) AS count FROM wr_analysis_checkpoints
      WHERE account_id = ? AND meeting_id = ?
    `).get("account_a", meetingId) as { count: number }).count).toBe(1);

    repository.publishAnalysisResult({
      accountId: "account_a",
      meetingId,
      fence,
      canonicalContentDigest: transcript.published.publication.contentDigest,
      candidates: []
    });
    expect((database.prepare(`
      SELECT count(*) AS count FROM wr_analysis_checkpoints
      WHERE account_id = ? AND meeting_id = ?
    `).get("account_a", meetingId) as { count: number }).count).toBe(0);
  });

  it("rejects a stale analysis fence at the final atomic publication boundary", () => {
    const transcript = publishTranscript();
    repository.queueStage({
      accountId: "account_a",
      meetingId: transcript.created.meeting.id,
      stage: "meeting_analysis"
    });
    const staleFence = repository.claimProcessingAttempt({
      accountId: "account_a",
      meetingId: transcript.created.meeting.id,
      stage: "meeting_analysis",
      leaseOwner: "stale_analysis",
      leaseDurationMs: 1_000,
      pipelineVersion: "v1",
      providerProfile: "extractor_test",
      promptVersion: "prompt_v1",
      now: "2026-09-01T00:00:00.000Z"
    })!;
    repository.markAnalysisVerifying({
      accountId: "account_a",
      meetingId: transcript.created.meeting.id,
      fence: staleFence,
      now: "2026-09-01T00:00:00.500Z"
    });
    expect(repository.claimProcessingAttempt({
      accountId: "account_a",
      meetingId: transcript.created.meeting.id,
      stage: "meeting_analysis",
      leaseOwner: "replacement_analysis",
      leaseDurationMs: 60_000,
      pipelineVersion: "v1",
      providerProfile: "extractor_test",
      promptVersion: "prompt_v1",
      now: "2026-09-01T00:00:02.000Z"
    })).not.toBeNull();
    expect(() => repository.publishAnalysisResult({
      accountId: "account_a",
      meetingId: transcript.created.meeting.id,
      fence: staleFence,
      canonicalContentDigest: transcript.published.publication.contentDigest,
      candidates: [],
      now: "2026-09-01T00:00:02.000Z"
    })).toThrow(WorkReviewLeaseLostError);
    expect((database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM wr_meeting_candidates) AS candidates,
        (SELECT COUNT(*) FROM wr_atomic_claims) AS claims,
        (SELECT COUNT(*) FROM wr_claim_evaluations) AS evaluations
    `).get() as { candidates: number; claims: number; evaluations: number }))
      .toEqual({ candidates: 0, claims: 0, evaluations: 0 });
  });

  it("rejects empty, duplicate, cross-upload, and invalid canonical segments", () => {
    const created = reserve();
    repository.queueStage({ accountId: "account_a", meetingId: created.meeting.id, stage: "transcription" });
    const fence = repository.claimProcessingAttempt({
      accountId: "account_a", meetingId: created.meeting.id, stage: "transcription",
      leaseOwner: "worker", leaseDurationMs: 60_000, pipelineVersion: "v1",
      providerProfile: "fixture_explicit_test"
    })!;
    expect(() => repository.publishCanonicalTranscript({
      accountId: "account_a", meetingId: created.meeting.id, fence, segments: []
    })).toThrowError(expect.objectContaining({ code: "work_review_empty_transcript" }));
    expect(() => repository.publishCanonicalTranscript({
      accountId: "account_a", meetingId: created.meeting.id, fence,
      segments: [segment(created.meeting.sourceUploadId), segment(created.meeting.sourceUploadId)]
    })).toThrowError(expect.objectContaining({ code: "work_review_duplicate_segment_id" }));
    expect(() => repository.publishCanonicalTranscript({
      accountId: "account_a", meetingId: created.meeting.id, fence,
      segments: [segment("another_upload")]
    })).toThrowError(expect.objectContaining({ code: "work_review_segment_upload_mismatch" }));
  });

  it("makes processing retry durable and allows safe replay while a stage is active", () => {
    const created = reserve();
    const first = repository.retryProcessing({
      accountId: "account_a",
      meetingId: created.meeting.id,
      operationKey: "retry_processing_once",
      allowTranscription: true,
      allowAnalysis: true
    });
    const replay = repository.retryProcessing({
      accountId: "account_a",
      meetingId: created.meeting.id,
      operationKey: "retry_processing_once",
      allowTranscription: true,
      allowAnalysis: true
    });

    expect(first).toMatchObject({
      reused: false,
      stage: "transcription",
      meeting: { ingestionStatus: "queued" }
    });
    expect(replay).toMatchObject({
      reused: true,
      stage: "transcription",
      meeting: { ingestionStatus: "queued" }
    });
    expect(database.prepare(`
      SELECT count(*) AS count FROM wr_processing_operations
      WHERE account_id = ? AND meeting_id = ?
    `).get("account_a", created.meeting.id)).toEqual({ count: 1 });
  });

  it("atomically stores verified candidates and makes candidate review idempotent", () => {
    const ready = publishReviewReadyMeeting();
    expect(ready.candidate.evidenceRefs).toEqual([
      expect.objectContaining({
        publicationId: ready.published.publication.publicationId,
        segmentId: "segment_1",
        timestampQuality: "provider_exact"
      })
    ]);
    expect(repository.listAtomicClaims("account_a", ready.created.meeting.id)).toEqual([
      expect.objectContaining({ candidateId: ready.candidate.id, evidenceIds: ["segment_1"] })
    ]);
    expect(repository.listClaimEvaluations("account_a", ready.created.meeting.id)).toEqual([
      expect.objectContaining({ supportVerdict: "entailed", supportedEvidenceIds: ["segment_1"] })
    ]);
    expect(repository.getReceipt("account_a", "upload_once")?.state).toBe("completed");
    const accepted = repository.reviewCandidate({
      accountId: "account_a",
      meetingId: ready.created.meeting.id,
      candidateId: ready.candidate.id,
      action: "accept",
      expectedVersion: ready.candidate.version,
      operationKey: "accept_commitment_once"
    });
    const replay = repository.reviewCandidate({
      accountId: "account_a",
      meetingId: ready.created.meeting.id,
      candidateId: ready.candidate.id,
      action: "accept",
      expectedVersion: ready.candidate.version,
      operationKey: "accept_commitment_once"
    });

    expect(accepted.reused).toBe(false);
    expect(accepted.finding).toMatchObject({
      kind: "commitment",
      sourceCandidateId: ready.candidate.id
    });
    expect(replay.reused).toBe(true);
    expect(repository.listFindings("account_a", ready.created.meeting.id)).toHaveLength(1);
    const beforeComplete = repository.getMeeting("account_a", ready.created.meeting.id);
    const completed = repository.completeReview({
      accountId: "account_a",
      meetingId: ready.created.meeting.id,
      expectedVersion: beforeComplete.version,
      operationKey: "complete_review_once"
    });
    expect(completed.meeting.reviewStatus).toBe("completed");
    expect(repository.completeReview({
      accountId: "account_a", meetingId: ready.created.meeting.id,
      expectedVersion: beforeComplete.version,
      operationKey: "complete_review_once"
    }).reused).toBe(true);
    const current = repository.getMeeting("account_a", ready.created.meeting.id);
    expect(() => repository.completeReview({
      accountId: "account_a", meetingId: ready.created.meeting.id,
      expectedVersion: current.version,
      operationKey: "complete_review_again"
    })).toThrowError(expect.objectContaining({ code: "work_review_already_completed" }));
  });

  it("normalizes a user-confirmed commitment to an explicit commitment basis", () => {
    const ready = publishReviewReadyMeeting();
    const originalStructuredData = WorkMeetingCandidateStructuredDataSchema.parse(
      ready.candidate.structuredData
    );
    const result = repository.reviewCandidate({
      accountId: "account_a",
      meetingId: ready.created.meeting.id,
      candidateId: ready.candidate.id,
      action: "edit_and_accept",
      expectedVersion: ready.candidate.version,
      operationKey: "confirm_commitment_semantics",
      title: ready.candidate.title,
      body: ready.candidate.body,
      structuredData: {
        ...originalStructuredData,
        actionBasis: "assignment_without_acceptance"
      }
    });

    expect(result.finding?.structuredData).toMatchObject({
      actionBasis: "explicit_commitment",
      relatedCommitmentCandidateId: null
    });
  });

  it("keeps canonical Transcript available when analysis fails", () => {
    const transcript = publishTranscript();
    repository.queueStage({
      accountId: "account_a", meetingId: transcript.created.meeting.id,
      stage: "meeting_analysis"
    });
    const fence = repository.claimProcessingAttempt({
      accountId: "account_a", meetingId: transcript.created.meeting.id,
      stage: "meeting_analysis", leaseOwner: "analysis", leaseDurationMs: 60_000,
      pipelineVersion: "v1", providerProfile: "extractor_test", promptVersion: "prompt_v1"
    })!;
    repository.markStageFailed({
      accountId: "account_a", meetingId: transcript.created.meeting.id,
      fence, errorCode: "work_review_analysis_failed"
    });
    expect(repository.getMeeting("account_a", transcript.created.meeting.id)).toMatchObject({
      ingestionStatus: "transcript_ready",
      analysisStatus: "failed"
    });
    expect(repository.readCanonicalPublication("account_a", transcript.created.meeting.id))
      .not.toBeNull();
  });

  it("keeps speaker aliases meeting-local and never mutates canonical speaker labels", () => {
    const transcript = publishTranscript();
    const alias = repository.setSpeakerAlias({
      accountId: "account_a", meetingId: transcript.created.meeting.id,
      rawLabel: "Speaker 1", displayLabel: "Alex", expectedVersion: 0,
      operationKey: "alias_speaker_1"
    });
    expect(alias).toMatchObject({
      reused: false,
      alias: { rawLabel: "Speaker 1", displayLabel: "Alex", version: 0 }
    });
    expect(repository.setSpeakerAlias({
      accountId: "account_a", meetingId: transcript.created.meeting.id,
      rawLabel: "Speaker 1", displayLabel: "Alex", expectedVersion: 0,
      operationKey: "alias_speaker_1"
    })).toMatchObject({ reused: true, alias: { displayLabel: "Alex", version: 0 } });
    expect(() => repository.setSpeakerAlias({
      accountId: "account_a", meetingId: transcript.created.meeting.id,
      rawLabel: "Speaker 1", displayLabel: "Changed", expectedVersion: 0,
      operationKey: "alias_speaker_1"
    })).toThrowError(expect.objectContaining({ code: "work_review_operation_conflict" }));
    expect(repository.readCanonicalPublication("account_a", transcript.created.meeting.id)
      ?.segments[0]?.speaker).toBe("Speaker 1");
    expect(() => repository.setSpeakerAlias({
      accountId: "account_b", meetingId: transcript.created.meeting.id,
      rawLabel: "Speaker 1", displayLabel: "Mallory", expectedVersion: 0,
      operationKey: "cross_account_alias"
    })).toThrow(WorkReviewNotFoundError);
  });

  it("writes a tombstone before deleting derived authority and blocks late publication", () => {
    const transcript = publishTranscript();
    repository.queueStage({
      accountId: "account_a",
      meetingId: transcript.created.meeting.id,
      stage: "meeting_analysis"
    });
    const analysisFence = repository.claimProcessingAttempt({
      accountId: "account_a",
      meetingId: transcript.created.meeting.id,
      stage: "meeting_analysis",
      leaseOwner: "late_analysis",
      leaseDurationMs: 60_000,
      pipelineVersion: "v1",
      providerProfile: "extractor_test",
      promptVersion: "prompt_v1"
    })!;
    const checkpointInput = {
      accountId: "account_a",
      meetingId: transcript.created.meeting.id,
      fence: analysisFence,
      publicationId: transcript.published.publication.publicationId,
      canonicalContentDigest: transcript.published.publication.contentDigest,
      checkpointKind: "extractor_block" as const,
      logicalInputDigest: hashA,
      providerContractDigest: hashB,
      outputSchemaVersion: "work_meeting_candidates_v1"
    };
    repository.saveAnalysisCheckpoint({ ...checkpointInput, payload: { items: [] } });
    repository.markAnalysisVerifying({
      accountId: "account_a",
      meetingId: transcript.created.meeting.id,
      fence: analysisFence
    });
    const deletion = repository.deleteMeeting({
      accountId: "account_a", meetingId: transcript.created.meeting.id
    });
    expect(deletion).toMatchObject({ reused: false, cleanupStatus: "pending" });
    expect(repository.deleteMeeting({
      accountId: "account_a", meetingId: transcript.created.meeting.id
    }).reused).toBe(true);
    expect(() => repository.readCanonicalPublication(
      "account_a", transcript.created.meeting.id
    )).toThrowError(expect.objectContaining({ code: "work_review_tombstoned" }));
    expect(() => repository.publishCanonicalTranscript({
      accountId: "account_a",
      meetingId: transcript.created.meeting.id,
      fence: transcript.fence,
      segments: [segment(transcript.created.meeting.sourceUploadId)]
    })).toThrowError(expect.objectContaining({ code: "work_review_tombstoned" }));
    expect(() => repository.publishAnalysisResult({
      accountId: "account_a",
      meetingId: transcript.created.meeting.id,
      fence: analysisFence,
      canonicalContentDigest: transcript.published.publication.contentDigest,
      candidates: []
    })).toThrowError(expect.objectContaining({ code: "work_review_tombstoned" }));
    expect((database.prepare(`
      SELECT count(*) AS count FROM wr_analysis_checkpoints
      WHERE account_id = ? AND meeting_id = ?
    `).get("account_a", transcript.created.meeting.id) as { count: number }).count).toBe(0);
    expect(() => repository.readAnalysisCheckpoint(checkpointInput))
      .toThrowError(expect.objectContaining({ code: "work_review_tombstoned" }));
    expect(database.pragma("foreign_key_check")).toEqual([]);
    repository.markDeletionCleanup({
      accountId: "account_a", meetingId: transcript.created.meeting.id, status: "completed"
    });
    repository.markDeletionCleanup({
      accountId: "account_a", meetingId: transcript.created.meeting.id,
      status: "failed", errorCode: "late_cleanup_failure"
    });
    const tombstone = database.prepare(`
      SELECT cleanup_status, cleanup_error_code FROM wr_tombstones
      WHERE account_id = ? AND meeting_id = ?
    `).get("account_a", transcript.created.meeting.id) as {
      cleanup_status: string;
      cleanup_error_code: string | null;
    };
    expect(tombstone).toEqual({ cleanup_status: "completed", cleanup_error_code: null });
    expect(repository.readSourceUpload("account_a", transcript.created.meeting.id))
      .toBeNull();
  });
});
