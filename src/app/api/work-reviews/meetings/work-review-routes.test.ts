// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/lib/server/auth/request-context";
import type { WorkMeetingCandidateStructuredData } from "@/lib/domain/work-review";
import { openWorkReviewDatabase } from "@/lib/server/work-review/db";
import {
  WorkReviewRepository,
  type WorkTranscriptSegment
} from "@/lib/server/work-review/repository";

const state = vi.hoisted(() => ({
  database: null as Database.Database | null,
  authContext: null as AuthContext | null,
  afterCallbacks: [] as Array<() => Promise<void>>
}));

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  processWorkMeeting: vi.fn(),
  persistAudioUpload: vi.fn(),
  cleanupPersistedUploadAttempt: vi.fn(),
  cleanupUploadArtifacts: vi.fn()
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: mocks.after
}));

vi.mock("@/lib/server/auth/request-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/auth/request-context")>()),
  requireAuthContext: vi.fn(async () => {
    if (!state.authContext) throw new Error("unauthenticated");
    return state.authContext;
  })
}));

vi.mock("@/lib/server/work-review/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/work-review/db")>()),
  getWorkReviewDatabase: () => {
    if (!state.database) throw new Error("test_work_review_database_unavailable");
    return state.database;
  }
}));

vi.mock("@/lib/server/work-review/orchestrator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/work-review/orchestrator")>()),
  processWorkMeeting: mocks.processWorkMeeting
}));

vi.mock("@/lib/server/uploads/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/uploads/storage")>()),
  persistAudioUpload: mocks.persistAudioUpload,
  cleanupPersistedAudioUploadAttempt: mocks.cleanupPersistedUploadAttempt
}));

vi.mock("@/lib/server/work-review/cleanup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/work-review/cleanup")>()),
  cleanupWorkReviewUploadArtifacts: mocks.cleanupUploadArtifacts
}));

import { GET as getMeeting, DELETE as deleteMeeting } from "./[meetingId]/route";
import { PATCH as reviewCandidate } from "./[meetingId]/candidates/[candidateId]/route";
import { POST as completeReview } from "./[meetingId]/complete/route";
import { POST as retryMeeting } from "./[meetingId]/retry/route";
import { GET as listMeetings, POST as uploadMeeting } from "./route";

const hashA = "a".repeat(64);
let repository: WorkReviewRepository;

function authContext(accountId: string): AuthContext {
  return {
    user: { id: accountId, email: `${accountId}@example.test`, name: accountId },
    store: {
      read: vi.fn(),
      write: vi.fn(),
      delete: vi.fn(),
      list: vi.fn()
    } as unknown as AuthContext["store"],
    dataRootDir: `C:\\test-data\\${accountId}`,
    uploadsRootDir: `C:\\test-data\\${accountId}\\uploads`
  };
}

function audioFile(bytes = "work-review-audio", name = "meeting.wav", type = "audio/wav") {
  return new File([bytes], name, { type });
}

function uploadRequest(input: {
  idempotencyKey?: string;
  files?: File[];
  title?: string;
  meetingDate?: string;
  clientAccountId?: string;
}) {
  const form = new FormData();
  for (const file of input.files ?? [audioFile()]) form.append("file", file);
  form.set("title", input.title ?? "产品评审会");
  form.set("meetingDate", input.meetingDate ?? "2026-09-01");
  if (input.clientAccountId) form.set("accountId", input.clientAccountId);
  const headers = new Headers();
  if (input.idempotencyKey) headers.set("Idempotency-Key", input.idempotencyKey);
  return new Request("http://localhost/api/work-reviews/meetings", {
    method: "POST",
    headers,
    body: form
  });
}

function jsonRequest(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function routeContext<T extends Record<string, string>>(params: T) {
  return { params: Promise.resolve(params) };
}

function transcriptSegment(uploadId: string): WorkTranscriptSegment {
  return {
    id: "segment_1",
    uploadId,
    startSeconds: 0,
    endSeconds: 8,
    speaker: "Speaker 1",
    text: "我来在周五前完成接口测试。",
    confidence: 0.98,
    sceneLabels: [],
    valueLabels: []
  };
}

const structuredData: WorkMeetingCandidateStructuredData = {
  decisionFinality: null,
  rawActorLabel: "Speaker 1",
  candidateOwner: null,
  dueAt: null,
  originalDueExpression: "周五前",
  actionBasis: "explicit_commitment",
  relatedCommitmentCandidateId: null,
  planStages: []
};

function reserveMeeting(accountId: string, suffix: string) {
  const meeting = repository.reserveMeeting({
    accountId,
    idempotencyKey: `upload_${suffix}`,
    operationKey: `upload_${suffix}`,
    contentHash: hashA,
    sourceUploadId: `source_${suffix}`,
    meetingId: `meeting_${suffix}`,
    title: `会议 ${suffix}`,
    meetingDate: "2026-09-01"
  }).meeting;
  repository.publishSourceUpload({
    accountId,
    meetingId: meeting.id,
    uploadId: meeting.sourceUploadId,
    originalName: "meeting.wav",
    mimeType: "audio/wav",
    sizeBytes: 128,
    recordingDate: "2026-09-01",
    filePath: `C:\\test-data\\${accountId}\\uploads\\${meeting.sourceUploadId}.wav`,
    contentHash: hashA
  });
  return meeting;
}

function publishTranscript(accountId: string, suffix: string) {
  const meeting = reserveMeeting(accountId, suffix);
  repository.queueStage({ accountId, meetingId: meeting.id, stage: "transcription" });
  const fence = repository.claimProcessingAttempt({
    accountId,
    meetingId: meeting.id,
    stage: "transcription",
    leaseOwner: `transcriber_${suffix}`,
    leaseDurationMs: 60_000,
    pipelineVersion: "work_meeting_v1",
    providerProfile: "fixture_explicit_test"
  });
  if (!fence) throw new Error("expected transcription fence");
  repository.publishCanonicalTranscript({
    accountId,
    meetingId: meeting.id,
    fence,
    segments: [transcriptSegment(meeting.sourceUploadId)],
    sourceDurationSeconds: 95
  });
  return repository.getMeeting(accountId, meeting.id);
}

function publishReviewReadyMeeting(accountId: string, suffix: string, candidateCount = 4) {
  const meeting = publishTranscript(accountId, suffix);
  repository.queueStage({ accountId, meetingId: meeting.id, stage: "meeting_analysis" });
  const fence = repository.claimProcessingAttempt({
    accountId,
    meetingId: meeting.id,
    stage: "meeting_analysis",
    leaseOwner: `analyzer_${suffix}`,
    leaseDurationMs: 60_000,
    pipelineVersion: "work_meeting_v1",
    providerProfile: "work_meeting_extractor_test",
    promptVersion: "work_meeting_extractor_v1"
  });
  if (!fence) throw new Error("expected analysis fence");
  repository.markAnalysisVerifying({ accountId, meetingId: meeting.id, fence });
  const publication = repository.readCanonicalPublication(accountId, meeting.id);
  if (!publication) throw new Error("expected canonical publication");
  const candidates = repository.publishAnalysisResult({
    accountId,
    meetingId: meeting.id,
    fence,
    canonicalContentDigest: publication.contentDigest,
    candidates: Array.from({ length: candidateCount }, (_, index) => ({
      id: `candidate_${suffix}_${index + 1}`,
      kind: "commitment" as const,
      title: `完成接口测试 ${index + 1}`,
      body: `Speaker 1 明确承诺完成接口测试 ${index + 1}。`,
      structuredData,
      publicationAction: "show_as_candidate" as const,
      riskLevel: "high" as const,
      generatorProfile: "work_meeting_extractor_test",
      generatorPromptVersion: "work_meeting_extractor_v1",
      evidenceSegmentIds: ["segment_1"],
      timestampQualityBySegmentId: { segment_1: "provider_exact" as const },
      claims: [{
        id: `claim_${suffix}_${index + 1}`,
        claimType: "commitment_existence" as const,
        text: `存在明确承诺 ${index + 1}`,
        evidenceSegmentIds: ["segment_1"],
        evaluation: {
          supportVerdict: "entailed" as const,
          issueCodes: [],
          riskLevel: "high" as const,
          publicationAction: "show_as_candidate" as const,
          confirmationRequired: true,
          supportedEvidenceIds: ["segment_1"],
          generatorProfile: "work_meeting_extractor_test",
          verifierProfile: "work_meeting_verifier_test",
          verifierPromptVersion: "work_meeting_verifier_v1",
          policyVersion: "work_meeting_publication_v1"
        }
      }]
    }))
  });
  return { meeting: repository.getMeeting(accountId, meeting.id), candidates };
}

async function responseJson(response: Response) {
  return await response.json() as Record<string, unknown>;
}

beforeEach(() => {
  state.database = openWorkReviewDatabase({ filePath: ":memory:" });
  repository = new WorkReviewRepository(state.database, {
    now: () => "2026-09-01T10:00:00.000Z",
    idFactory: (() => {
      let value = 0;
      return () => `test_${++value}`;
    })()
  });
  state.authContext = authContext("account_a");
  state.afterCallbacks = [];
  process.env.WORK_REVIEW_ENABLED = "true";
  process.env.WORK_REVIEW_UPLOAD_ENABLED = "true";
  process.env.WORK_REVIEW_ANALYSIS_ENABLED = "true";
  process.env.WORK_REVIEW_VERIFIER_ENABLED = "true";
  mocks.after.mockReset().mockImplementation((callback: () => Promise<void>) => {
    state.afterCallbacks.push(callback);
  });
  mocks.processWorkMeeting.mockReset().mockResolvedValue({
    meetingId: "unused",
    transcriptReady: false,
    analysisReady: false,
    busy: false
  });
  mocks.persistAudioUpload.mockReset().mockImplementation(async (input) => {
    const upload = {
      id: input.uploadId,
      originalName: input.file.name,
      mimeType: input.file.type,
      sizeBytes: input.file.size,
      recordingDate: input.recordingDate,
      createdAt: "2026-09-01T10:00:00.000Z",
      status: "uploaded" as const,
      filePath: `${input.uploadDir}\\${input.uploadId}.${input.attemptSuffix}.wav`
    };
    await input.publishUpload?.(upload);
    return upload;
  });
  mocks.cleanupPersistedUploadAttempt.mockReset().mockResolvedValue(undefined);
  mocks.cleanupUploadArtifacts.mockReset().mockResolvedValue({ ok: true, failures: [] });
});

afterEach(() => {
  state.database?.close();
  state.database = null;
  state.authContext = null;
  delete process.env.WORK_REVIEW_ENABLED;
  delete process.env.WORK_REVIEW_UPLOAD_ENABLED;
  delete process.env.WORK_REVIEW_ANALYSIS_ENABLED;
  delete process.env.WORK_REVIEW_VERIFIER_ENABLED;
  delete process.env.WORK_REVIEW_MAX_UPLOAD_BYTES;
});

describe("Work Review upload routes", () => {
  it("rejects an unauthenticated upload before persistence or scheduling", async () => {
    state.authContext = null;
    const response = await uploadMeeting(uploadRequest({ idempotencyKey: "upload_auth" }));

    expect(response.status).toBe(401);
    expect(await responseJson(response)).toEqual({ error: "unauthenticated" });
    expect(mocks.persistAudioUpload).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("derives account scope only from the server auth context", async () => {
    const response = await uploadMeeting(uploadRequest({
      idempotencyKey: "upload_server_scope",
      clientAccountId: "account_b"
    }));

    expect(response.status).toBe(202);
    const body = await responseJson(response);
    expect(repository.listMeetings("account_a")).toHaveLength(1);
    expect(repository.listMeetings("account_b")).toHaveLength(0);
    expect(repository.getMeeting("account_a", body.meetingId as string).accountId)
      .toBe("account_a");
    expect(state.afterCallbacks).toHaveLength(1);
    await state.afterCallbacks[0]!();
    expect(mocks.processWorkMeeting).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account_a",
      meetingId: body.meetingId
    }));
  });

  it("rejects an oversized declared request before multipart parsing and persistence", async () => {
    process.env.WORK_REVIEW_MAX_UPLOAD_BYTES = "10";
    const request = uploadRequest({ idempotencyKey: "upload_oversized_request" });
    request.headers.set("content-length", String(10 + 1024 * 1024 + 1));

    const response = await uploadMeeting(request);

    expect(response.status).toBe(413);
    expect(await responseJson(response)).toEqual({ error: "file_too_large" });
    expect(repository.listMeetings("account_a")).toHaveLength(0);
    expect(mocks.persistAudioUpload).not.toHaveBeenCalled();
  });

  it("rejects an oversized parsed Work upload before hashing or persistence", async () => {
    process.env.WORK_REVIEW_MAX_UPLOAD_BYTES = "4";
    const response = await uploadMeeting(uploadRequest({
      idempotencyKey: "upload_oversized_file",
      files: [audioFile("12345")]
    }));

    expect(response.status).toBe(413);
    expect(await responseJson(response)).toEqual({ error: "file_too_large" });
    expect(repository.listMeetings("account_a")).toHaveLength(0);
    expect(mocks.persistAudioUpload).not.toHaveBeenCalled();
  });

  it("rejects invalid and multi-file uploads without reserving a meeting", async () => {
    const invalid = await uploadMeeting(uploadRequest({
      idempotencyKey: "upload_invalid",
      files: [audioFile("text", "notes.txt", "text/plain")]
    }));
    const multi = await uploadMeeting(uploadRequest({
      idempotencyKey: "upload_multiple",
      files: [audioFile("one"), audioFile("two", "other.wav")]
    }));

    expect(invalid.status).toBe(400);
    expect(await responseJson(invalid)).toEqual({ error: "unsupported_audio_format" });
    expect(multi.status).toBe(400);
    expect(await responseJson(multi)).toEqual({ error: "invalid_upload" });
    expect(repository.listMeetings("account_a")).toHaveLength(0);
    expect(mocks.persistAudioUpload).not.toHaveBeenCalled();
  });

  it("replays the same upload idempotently and rejects changed content", async () => {
    const first = await uploadMeeting(uploadRequest({ idempotencyKey: "upload_replay" }));
    const firstBody = await responseJson(first);
    const replay = await uploadMeeting(uploadRequest({ idempotencyKey: "upload_replay" }));
    const replayBody = await responseJson(replay);
    const conflict = await uploadMeeting(uploadRequest({
      idempotencyKey: "upload_replay",
      files: [audioFile("different-audio-bytes")]
    }));

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replayBody).toMatchObject({ meetingId: firstBody.meetingId, reused: true });
    expect(conflict.status).toBe(409);
    expect(await responseJson(conflict)).toEqual({ error: "idempotency_conflict" });
    expect(repository.listMeetings("account_a")).toHaveLength(1);
    expect(mocks.persistAudioUpload).toHaveBeenCalledTimes(1);
  });

  it("isolates concurrent same-key upload attempt files so a loser cannot delete the winner", async () => {
    let started = 0;
    let releaseBoth: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => { releaseBoth = resolve; });
    mocks.persistAudioUpload.mockImplementation(async (input) => {
      started += 1;
      if (started === 2) releaseBoth?.();
      await bothStarted;
      const upload = {
        id: input.uploadId,
        originalName: input.file.name,
        mimeType: input.file.type,
        sizeBytes: input.file.size,
        recordingDate: input.recordingDate,
        createdAt: "2026-09-01T10:00:00.000Z",
        status: "uploaded" as const,
        filePath: `${input.uploadDir}\\${input.uploadId}.${input.attemptSuffix}.wav`
      };
      await input.publishUpload?.(upload);
      return upload;
    });

    const [first, replay] = await Promise.all([
      uploadMeeting(uploadRequest({
        idempotencyKey: "upload_concurrent",
        title: "第一个标题",
        meetingDate: "2026-09-01"
      })),
      uploadMeeting(uploadRequest({
        idempotencyKey: "upload_concurrent",
        title: "重试时的标题",
        meetingDate: "2026-09-02"
      }))
    ]);
    const firstBody = await responseJson(first);
    const replayBody = await responseJson(replay);

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replayBody.meetingId).toBe(firstBody.meetingId);
    expect(repository.listMeetings("account_a")).toHaveLength(1);
    expect(mocks.persistAudioUpload).toHaveBeenCalledTimes(2);
    expect(mocks.persistAudioUpload.mock.calls[0]![0].attemptSuffix)
      .not.toBe(mocks.persistAudioUpload.mock.calls[1]![0].attemptSuffix);
    expect(mocks.cleanupPersistedUploadAttempt).toHaveBeenCalledTimes(1);
    const winnerPath = repository.readSourceUpload(
      "account_a",
      firstBody.meetingId as string
    )?.filePath;
    expect(mocks.cleanupPersistedUploadAttempt).toHaveBeenCalledWith(expect.objectContaining({
      upload: expect.objectContaining({ filePath: expect.not.stringContaining(winnerPath ?? "") }),
      removeProjection: false
    }));
  });
});

describe("Work Review scoped review routes", () => {
  it("prevents account A from reading, mutating, or deleting account B resources", async () => {
    const ready = publishReviewReadyMeeting("account_b", "private_b", 1);
    state.authContext = authContext("account_a");
    const params = routeContext({ meetingId: ready.meeting.id });
    const getResponse = await getMeeting(
      new Request(`http://localhost/api/work-reviews/meetings/${ready.meeting.id}`),
      params
    );
    const patchResponse = await reviewCandidate(
      jsonRequest("http://localhost/candidate", "PATCH", {
        action: "accept",
        expectedVersion: ready.candidates[0]!.version,
        operationKey: "cross_account_accept"
      }),
      routeContext({ meetingId: ready.meeting.id, candidateId: ready.candidates[0]!.id })
    );
    const deleteResponse = await deleteMeeting(
      new Request(`http://localhost/api/work-reviews/meetings/${ready.meeting.id}`, {
        method: "DELETE"
      }),
      params
    );

    expect(getResponse.status).toBe(404);
    expect(patchResponse.status).toBe(404);
    expect(deleteResponse.status).toBe(404);
    expect(repository.getMeeting("account_b", ready.meeting.id).ingestionStatus)
      .toBe("transcript_ready");
    expect(repository.listCandidates("account_b", ready.meeting.id)[0]?.status)
      .toBe("pending_review");
    expect(mocks.cleanupUploadArtifacts).not.toHaveBeenCalled();
  });

  it("supports accept, edit, retype, ignore, optimistic versions, and operation replay", async () => {
    const ready = publishReviewReadyMeeting("account_a", "review_actions", 4);
    const [accepted, edited, retyped, ignored] = ready.candidates;
    const acceptBody = {
      action: "accept",
      expectedVersion: accepted!.version,
      operationKey: "accept_once"
    };
    const acceptResponse = await reviewCandidate(
      jsonRequest("http://localhost/candidate", "PATCH", acceptBody),
      routeContext({ meetingId: ready.meeting.id, candidateId: accepted!.id })
    );
    const acceptReplay = await reviewCandidate(
      jsonRequest("http://localhost/candidate", "PATCH", acceptBody),
      routeContext({ meetingId: ready.meeting.id, candidateId: accepted!.id })
    );
    const editResponse = await reviewCandidate(
      jsonRequest("http://localhost/candidate", "PATCH", {
        action: "edit_and_accept",
        expectedVersion: edited!.version,
        operationKey: "edit_once",
        title: "修订后的标题",
        body: "修订后的正文",
        structuredData
      }),
      routeContext({ meetingId: ready.meeting.id, candidateId: edited!.id })
    );
    const retypeResponse = await reviewCandidate(
      jsonRequest("http://localhost/candidate", "PATCH", {
        action: "retype_and_accept",
        expectedVersion: retyped!.version,
        operationKey: "retype_once",
        kind: "open_question",
        title: "需要确认的问题",
        body: "仍需确认发布窗口。",
        structuredData: { ...structuredData, actionBasis: null }
      }),
      routeContext({ meetingId: ready.meeting.id, candidateId: retyped!.id })
    );
    const ignoreResponse = await reviewCandidate(
      jsonRequest("http://localhost/candidate", "PATCH", {
        action: "ignore",
        expectedVersion: ignored!.version,
        operationKey: "ignore_once"
      }),
      routeContext({ meetingId: ready.meeting.id, candidateId: ignored!.id })
    );
    const staleResponse = await reviewCandidate(
      jsonRequest("http://localhost/candidate", "PATCH", {
        action: "accept",
        expectedVersion: 99,
        operationKey: "stale_action"
      }),
      routeContext({ meetingId: ready.meeting.id, candidateId: accepted!.id })
    );

    expect(acceptResponse.status).toBe(200);
    expect(await responseJson(acceptReplay)).toMatchObject({ reused: true });
    expect(editResponse.status).toBe(200);
    expect(retypeResponse.status).toBe(200);
    expect(ignoreResponse.status).toBe(200);
    expect(staleResponse.status).toBe(409);
    expect(await responseJson(staleResponse)).toMatchObject({ error: "version_conflict" });
    expect(repository.listCandidates("account_a", ready.meeting.id).map((item) => item.status))
      .toEqual(["accepted", "edited_and_accepted", "retyped_and_accepted", "ignored"]);
    expect(repository.listFindings("account_a", ready.meeting.id)).toEqual([
      expect.objectContaining({ sourceCandidateId: accepted!.id, kind: "commitment" }),
      expect.objectContaining({ sourceCandidateId: edited!.id, title: "修订后的标题" }),
      expect.objectContaining({ sourceCandidateId: retyped!.id, kind: "open_question" })
    ]);
  });

  it("completes idempotently without writing Todo, Memory, Person, or generic store data", async () => {
    const ready = publishReviewReadyMeeting("account_a", "complete", 1);
    const candidate = ready.candidates[0]!;
    await reviewCandidate(
      jsonRequest("http://localhost/candidate", "PATCH", {
        action: "ignore",
        expectedVersion: candidate.version,
        operationKey: "ignore_before_complete"
      }),
      routeContext({ meetingId: ready.meeting.id, candidateId: candidate.id })
    );
    const before = repository.getMeeting("account_a", ready.meeting.id);
    const completionBody = {
      expectedVersion: before.version,
      operationKey: "complete_once"
    };
    const first = await completeReview(
      jsonRequest("http://localhost/complete", "POST", completionBody),
      routeContext({ meetingId: ready.meeting.id })
    );
    const replay = await completeReview(
      jsonRequest("http://localhost/complete", "POST", completionBody),
      routeContext({ meetingId: ready.meeting.id })
    );

    expect(first.status).toBe(200);
    expect(await responseJson(replay)).toMatchObject({ ok: true, reused: true });
    expect(repository.getMeeting("account_a", ready.meeting.id).reviewStatus).toBe("completed");
    const applicationTables = (state.database!.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>).map((row) => row.name);
    expect(applicationTables.length).toBeGreaterThan(0);
    expect(applicationTables.every((name) => name.startsWith("wr_"))).toBe(true);
    const store = state.authContext!.store as unknown as {
      read: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn>;
    };
    expect(store.read).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
    expect(store.list).not.toHaveBeenCalled();
  });

  it("queues ASR when no canonical publication exists and analysis when it does", async () => {
    const asrMeeting = reserveMeeting("account_a", "retry_asr");
    const asrResponse = await retryMeeting(
      jsonRequest("http://localhost/retry", "POST", { operationKey: "retry_asr_once" }),
      routeContext({ meetingId: asrMeeting.id })
    );
    expect(asrResponse.status).toBe(202);
    expect(await responseJson(asrResponse)).toMatchObject({ ok: true, reused: false });
    expect(repository.getMeeting("account_a", asrMeeting.id)).toMatchObject({
      ingestionStatus: "queued",
      analysisStatus: "not_started"
    });

    const analysisMeeting = publishTranscript("account_a", "retry_analysis");
    const analysisResponse = await retryMeeting(
      jsonRequest("http://localhost/retry", "POST", { operationKey: "retry_analysis_once" }),
      routeContext({ meetingId: analysisMeeting.id })
    );
    expect(analysisResponse.status).toBe(202);
    expect(repository.getMeeting("account_a", analysisMeeting.id)).toMatchObject({
      ingestionStatus: "transcript_ready",
      analysisStatus: "queued"
    });
    expect(state.afterCallbacks).toHaveLength(2);
    await Promise.all(state.afterCallbacks.map((callback) => callback()));
    expect(mocks.processWorkMeeting).toHaveBeenNthCalledWith(1, expect.objectContaining({
      accountId: "account_a", meetingId: asrMeeting.id
    }));
    expect(mocks.processWorkMeeting).toHaveBeenNthCalledWith(2, expect.objectContaining({
      accountId: "account_a", meetingId: analysisMeeting.id
    }));

    const replay = await retryMeeting(
      jsonRequest("http://localhost/retry", "POST", { operationKey: "retry_analysis_once" }),
      routeContext({ meetingId: analysisMeeting.id })
    );
    expect(replay.status).toBe(202);
    expect(await responseJson(replay)).toMatchObject({ ok: true, reused: true });
    expect(state.afterCallbacks).toHaveLength(3);
  });

  it("registers inline recovery when a detail read observes queued processing", async () => {
    const meeting = reserveMeeting("account_a", "recover_processing");
    repository.queueStage({
      accountId: "account_a",
      meetingId: meeting.id,
      stage: "transcription"
    });

    const response = await getMeeting(
      new Request(`http://localhost/api/work-reviews/meetings/${meeting.id}`),
      routeContext({ meetingId: meeting.id })
    );

    expect(response.status).toBe(200);
    expect(state.afterCallbacks).toHaveLength(1);
    await state.afterCallbacks[0]!();
    expect(mocks.processWorkMeeting).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account_a",
      meetingId: meeting.id
    }));
  });

  it("retries failed deletion cleanup and makes completed cleanup absorbing", async () => {
    const meeting = publishTranscript("account_a", "delete_cleanup");
    mocks.cleanupUploadArtifacts
      .mockResolvedValueOnce({ ok: false, failures: ["disk_busy"] })
      .mockResolvedValueOnce({ ok: true, failures: [] });
    const request = () => new Request(
      `http://localhost/api/work-reviews/meetings/${meeting.id}`,
      { method: "DELETE" }
    );
    const context = () => routeContext({ meetingId: meeting.id });

    const failed = await deleteMeeting(request(), context());
    const recovered = await deleteMeeting(request(), context());
    const replay = await deleteMeeting(request(), context());

    expect(failed.status).toBe(500);
    expect(await responseJson(recovered)).toMatchObject({
      ok: true,
      cleanupStatus: "completed",
      reused: true
    });
    expect(await responseJson(replay)).toMatchObject({
      ok: true,
      cleanupStatus: "completed",
      reused: true
    });
    expect(mocks.cleanupUploadArtifacts).toHaveBeenCalledTimes(2);
    expect(repository.readSourceUpload("account_a", meeting.id)).toBeNull();
    expect(repository.getMeeting("account_a", meeting.id)).toMatchObject({
      title: "已删除会议",
      meetingDate: "1970-01-01",
      sourceDurationSeconds: null,
      canonicalPublicationId: null,
      canonicalContentDigest: null,
      canonicalSegmentCount: 0
    });
  });

  it("recovers cleanup in an isolated after callback without delaying the meeting list", async () => {
    const failedMeeting = publishTranscript("account_a", "recover_bad");
    const recoveredMeeting = publishTranscript("account_a", "recover_good");
    mocks.cleanupUploadArtifacts.mockImplementation(async ({ uploadId }) => {
      if (uploadId === failedMeeting.sourceUploadId) throw new Error("transient_cleanup_error");
      return { ok: true, failures: [] };
    });

    const response = await listMeetings(new Request("http://localhost/api/work-reviews/meetings"));
    expect(response.status).toBe(200);
    expect((await responseJson(response)).meetings).toHaveLength(2);
    expect(state.afterCallbacks).toHaveLength(1);

    await expect(state.afterCallbacks[0]!()).resolves.toBeUndefined();
    expect(repository.readSourceUpload("account_a", failedMeeting.id)?.filePath).not.toBeNull();
    expect(repository.readSourceUpload("account_a", recoveredMeeting.id)?.filePath).toBeNull();
  });

  it("recovers a crash after tombstone commit on the next authenticated list", async () => {
    const meeting = publishTranscript("account_a", "recover_deleted");
    repository.deleteMeeting({ accountId: "account_a", meetingId: meeting.id });

    const response = await listMeetings(new Request("http://localhost/api/work-reviews/meetings"));
    expect(response.status).toBe(200);
    expect((await responseJson(response)).meetings).toEqual([]);
    expect(state.afterCallbacks).toHaveLength(1);
    await state.afterCallbacks[0]!();

    expect(repository.readSourceUpload("account_a", meeting.id)).toBeNull();
    expect(state.database!.prepare(`
      SELECT cleanup_status FROM wr_tombstones
      WHERE account_id = ? AND meeting_id = ?
    `).get("account_a", meeting.id)).toEqual({ cleanup_status: "completed" });
  });

  it("lists only the authenticated account meetings", async () => {
    reserveMeeting("account_a", "list_a");
    reserveMeeting("account_b", "list_b");
    const response = await listMeetings(new Request("http://localhost/api/work-reviews/meetings"));
    expect(response.status).toBe(200);
    const body = await responseJson(response) as { meetings: Array<{ id: string }> };
    expect(body.meetings.map((meeting) => meeting.id)).toEqual(["meeting_list_a"]);
  });

  it("rejects incoherent or unknown Meeting project filters", async () => {
    const orphanProjectId = await listMeetings(new Request(
      "http://localhost/api/work-reviews/meetings?projectId=wrp_alpha"
    ));
    const unknown = await listMeetings(new Request(
      "http://localhost/api/work-reviews/meetings?unexpected=true"
    ));
    expect(orphanProjectId.status).toBe(400);
    expect(unknown.status).toBe(400);
  });
});
