// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWorkReviewDatabase } from "./db";
import { WorkMeetingFollowUpRepository } from "./follow-up-repository";
import { WorkMeetingFollowUpService } from "./follow-up-service";
import { WorkReviewNotFoundError, WorkReviewRepository } from "./repository";
import { WorkTodoRepository } from "./todo-repository";

const ACCOUNT_A = "account_a";
const NOW_GENERATED = "2026-09-02T08:00:00.000Z";
let now = NOW_GENERATED;
let database: Database.Database;
let workRepository: WorkReviewRepository;
let todoRepository: WorkTodoRepository;
let followUpRepository: WorkMeetingFollowUpRepository;
let service: WorkMeetingFollowUpService;
let id = 0;

beforeEach(() => {
  database = openWorkReviewDatabase({ filePath: ":memory:" });
  now = NOW_GENERATED;
  id = 0;
  const options = { now: () => now, idFactory: () => `follow_up_${++id}` };
  workRepository = new WorkReviewRepository(database, options);
  todoRepository = new WorkTodoRepository(database, options);
  followUpRepository = new WorkMeetingFollowUpRepository(database, { now: () => now });
  service = new WorkMeetingFollowUpService(database, {
    workRepository,
    todoRepository,
    followUpRepository,
    resolveFeatureFlags: () => ({
      enabled: true,
      uploadEnabled: true,
      analysisEnabled: true,
      verifierEnabled: true,
      todoEnabled: true,
      todoMeetingProjectionEnabled: true,
      followUpEnabled: true,
      recoveryEnabled: false
    })
  });
});

afterEach(() => database.close());

function seedReviewedMeeting() {
  const meeting = workRepository.reserveMeeting({
    accountId: ACCOUNT_A,
    idempotencyKey: "follow_up_upload",
    operationKey: "follow_up_upload",
    contentHash: "a".repeat(64),
    meetingId: "meeting_follow_up",
    sourceUploadId: "source_follow_up",
    title: "产品复盘会",
    meetingDate: "2026-09-02"
  }).meeting;
  workRepository.publishSourceUpload({
    accountId: ACCOUNT_A,
    meetingId: meeting.id,
    uploadId: meeting.sourceUploadId,
    originalName: "meeting.wav",
    mimeType: "audio/wav",
    sizeBytes: 1_024,
    recordingDate: meeting.meetingDate,
    filePath: "C:\\test-data\\meeting.wav",
    contentHash: "a".repeat(64)
  });
  workRepository.queueStage({ accountId: ACCOUNT_A, meetingId: meeting.id, stage: "transcription" });
  const transcriptionFence = workRepository.claimProcessingAttempt({
    accountId: ACCOUNT_A,
    meetingId: meeting.id,
    stage: "transcription",
    leaseOwner: "follow-up-transcriber",
    leaseDurationMs: 60_000,
    pipelineVersion: "work_meeting_v1",
    providerProfile: "test_transcriber"
  });
  if (!transcriptionFence) throw new Error("expected transcription fence");
  const publication = workRepository.publishCanonicalTranscript({
    accountId: ACCOUNT_A,
    meetingId: meeting.id,
    fence: transcriptionFence,
    sourceDurationSeconds: 120,
    segments: [{
      id: "segment_follow_up",
      uploadId: meeting.sourceUploadId,
      startSeconds: 0,
      endSeconds: 12,
      speaker: "Speaker 1",
      text: "我会在周五前完成接口，风险项仍待确认。",
      confidence: 0.99,
      sceneLabels: [],
      valueLabels: []
    }]
  }).publication;
  workRepository.queueStage({ accountId: ACCOUNT_A, meetingId: meeting.id, stage: "meeting_analysis" });
  const analysisFence = workRepository.claimProcessingAttempt({
    accountId: ACCOUNT_A,
    meetingId: meeting.id,
    stage: "meeting_analysis",
    leaseOwner: "follow-up-analysis",
    leaseDurationMs: 60_000,
    pipelineVersion: "work_meeting_v1",
    providerProfile: "test_extractor",
    promptVersion: "work_meeting_extractor_v1"
  });
  if (!analysisFence) throw new Error("expected analysis fence");
  workRepository.markAnalysisVerifying({
    accountId: ACCOUNT_A,
    meetingId: meeting.id,
    fence: analysisFence
  });
  const [candidate] = workRepository.publishAnalysisResult({
    accountId: ACCOUNT_A,
    meetingId: meeting.id,
    fence: analysisFence,
    canonicalContentDigest: publication.contentDigest,
    candidates: [{
      kind: "commitment",
      title: "完成接口",
      body: "Speaker 1 明确承诺在周五前完成接口。",
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
      generatorProfile: "test_extractor",
      generatorPromptVersion: "work_meeting_extractor_v1",
      evidenceSegmentIds: ["segment_follow_up"],
      timestampQualityBySegmentId: { segment_follow_up: "provider_exact" },
      claims: [{
        claimType: "commitment_existence",
        text: "有人明确承诺完成接口。",
        evidenceSegmentIds: ["segment_follow_up"],
        evaluation: {
          supportVerdict: "entailed",
          issueCodes: [],
          riskLevel: "high",
          publicationAction: "show_as_candidate",
          confirmationRequired: true,
          supportedEvidenceIds: ["segment_follow_up"],
          generatorProfile: "test_extractor",
          verifierProfile: "test_verifier",
          verifierPromptVersion: "work_meeting_verifier_v1",
          policyVersion: "work_meeting_publication_v1"
        }
      }]
    }]
  });
  const reviewed = workRepository.reviewCandidate({
    accountId: ACCOUNT_A,
    meetingId: meeting.id,
    candidateId: candidate!.id,
    action: "accept",
    expectedVersion: candidate!.version,
    operationKey: "accept_follow_up"
  });
  const current = workRepository.getMeeting(ACCOUNT_A, meeting.id);
  workRepository.completeReview({
    accountId: ACCOUNT_A,
    meetingId: meeting.id,
    expectedVersion: current.version,
    operationKey: "complete_follow_up"
  });
  return { meetingId: meeting.id, findingId: reviewed.finding!.id };
}

function projectTodo(meetingId: string, findingId: string) {
  return todoRepository.createTodoFromFinding({
    accountId: ACCOUNT_A,
    meetingId,
    findingId,
    operationKey: "project_follow_up_todo",
    title: "完成接口",
    kind: "self",
    notes: null,
    ownerLabel: null,
    currentDueDate: "2026-09-05",
    isImportant: true,
    myDayDate: null,
    ownershipOverrideConfirmed: false
  }).todo;
}

describe("WorkMeetingFollowUpService", () => {
  it("returns server-owned review stats before a draft exists and generates idempotently", () => {
    const source = seedReviewedMeeting();
    projectTodo(source.meetingId, source.findingId);

    expect(service.get(ACCOUNT_A, source.meetingId)).toEqual({
      draft: null,
      sourceStats: {
        findingCount: 1,
        todoCount: 1,
        confirmedResultCount: 1,
        myTodoCount: 1,
        waitingForOtherTodoCount: 0,
        unresolvedQuestionCount: 0
      }
    });
    const first = service.generate({
      accountId: ACCOUNT_A,
      meetingId: source.meetingId,
      expectedVersion: null,
      operationKey: "generate_follow_up"
    });
    const replay = service.generate({
      accountId: ACCOUNT_A,
      meetingId: source.meetingId,
      expectedVersion: null,
      operationKey: "generate_follow_up"
    });

    expect(first.reused).toBe(false);
    expect(first.draft).toMatchObject({
      version: 0,
      stale: false,
      userEditedAt: null,
      sourceStats: { confirmedResultCount: 1, myTodoCount: 1 }
    });
    expect(first.draft.bodyMarkdown).toContain("# 会后纪要草稿");
    expect(first.draft.bodyMarkdown).toContain("会议原始截止时间：周五前");
    expect(first.draft.bodyMarkdown).toContain("Todo 当前计划时间：2026-09-05");
    expect(replay).toEqual({ ...first, reused: true });
  });

  it("preserves user edits when sources change, then resets and explicitly regenerates", () => {
    const source = seedReviewedMeeting();
    const todo = projectTodo(source.meetingId, source.findingId);
    const generated = service.generate({
      accountId: ACCOUNT_A,
      meetingId: source.meetingId,
      expectedVersion: null,
      operationKey: "generate_before_edit"
    }).draft;
    now = "2026-09-02T09:00:00.000Z";
    const edited = service.update({
      accountId: ACCOUNT_A,
      meetingId: source.meetingId,
      operationKey: "save_user_edit",
      expectedVersion: generated.version,
      bodyMarkdown: "# 我的会后纪要草稿\n\n保留这段用户编辑。"
    }).draft;
    todoRepository.updateTodo({
      accountId: ACCOUNT_A,
      todoId: todo.id,
      operationKey: "move_todo_due",
      expectedVersion: todo.version,
      currentDueDate: "2026-09-08"
    });

    const stale = service.get(ACCOUNT_A, source.meetingId).draft!;
    expect(stale.stale).toBe(true);
    expect(stale.bodyMarkdown).toBe(edited.bodyMarkdown);
    expect(stale.version).toBe(1);

    now = "2026-09-02T10:00:00.000Z";
    const reset = service.reset({
      accountId: ACCOUNT_A,
      meetingId: source.meetingId,
      expectedVersion: 1,
      operationKey: "reset_user_edit"
    }).draft;
    expect(reset.bodyMarkdown).toBe(generated.bodyMarkdown);
    expect(reset.userEditedAt).toBeNull();
    expect(reset.stale).toBe(true);
    expect(reset.version).toBe(2);

    const regenerated = service.generate({
      accountId: ACCOUNT_A,
      meetingId: source.meetingId,
      expectedVersion: 2,
      operationKey: "regenerate_after_source_change"
    }).draft;
    expect(regenerated.stale).toBe(false);
    expect(regenerated.version).toBe(3);
    expect(regenerated.bodyMarkdown).toContain("Todo 当前计划时间：2026-09-08");
  });

  it("isolates accounts and makes the draft inaccessible after meeting deletion", () => {
    const source = seedReviewedMeeting();
    projectTodo(source.meetingId, source.findingId);
    service.generate({
      accountId: ACCOUNT_A,
      meetingId: source.meetingId,
      expectedVersion: null,
      operationKey: "generate_before_delete"
    });

    expect(() => service.get("account_b", source.meetingId)).toThrow(WorkReviewNotFoundError);
    workRepository.deleteMeeting({
      accountId: ACCOUNT_A,
      meetingId: source.meetingId,
      linkedTodoPolicy: "delete_linked_todos"
    });
    expect(() => service.get(ACCOUNT_A, source.meetingId)).toThrow();
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM wr_follow_up_drafts
      WHERE account_id = ? AND meeting_id = ?
    `).get(ACCOUNT_A, source.meetingId)).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM wr_follow_up_operations
      WHERE account_id = ? AND meeting_id = ?
    `).get(ACCOUNT_A, source.meetingId)).toEqual({ count: 0 });
  });

  it("uses confirmed Findings without inventing Todo content when the Todo gate is off", () => {
    const source = seedReviewedMeeting();
    projectTodo(source.meetingId, source.findingId);
    const findingsOnly = new WorkMeetingFollowUpService(database, {
      workRepository,
      todoRepository,
      followUpRepository,
      resolveFeatureFlags: () => ({
        enabled: true,
        uploadEnabled: true,
        analysisEnabled: true,
        verifierEnabled: true,
        todoEnabled: false,
        todoMeetingProjectionEnabled: false,
        followUpEnabled: true,
        recoveryEnabled: false
      })
    });

    const result = findingsOnly.generate({
      accountId: ACCOUNT_A,
      meetingId: source.meetingId,
      expectedVersion: null,
      operationKey: "generate_findings_only"
    });
    expect(result.draft.sourceStats).toMatchObject({
      confirmedResultCount: 1,
      todoCount: 0,
      myTodoCount: 0,
      waitingForOtherTodoCount: 0
    });
    expect(result.draft.bodyMarkdown).not.toContain("## 我的待办");
  });
});
