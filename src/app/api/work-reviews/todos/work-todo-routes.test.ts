// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CreateManualWorkTodoRequest,
  CreateWorkTodoFromFindingRequest
} from "@/lib/domain/work-todo";
import type { WorkMeetingCandidateKind } from "@/lib/domain/work-review";
import type { AuthContext } from "@/lib/server/auth/request-context";
import { openWorkReviewDatabase } from "@/lib/server/work-review/db";
import {
  WorkReviewRepository,
  type WorkTranscriptSegment
} from "@/lib/server/work-review/repository";
import { WorkTodoRepository } from "@/lib/server/work-review/todo-repository";

const state = vi.hoisted(() => ({
  database: null as Database.Database | null,
  authContext: null as AuthContext | null
}));

const mocks = vi.hoisted(() => ({
  cleanupUploadArtifacts: vi.fn()
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

vi.mock("@/lib/server/work-review/cleanup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/work-review/cleanup")>()),
  cleanupWorkReviewUploadArtifacts: mocks.cleanupUploadArtifacts
}));

import {
  GET as getMeeting,
  DELETE as deleteMeeting
} from "../meetings/[meetingId]/route";
import { POST as projectFinding } from "../meetings/[meetingId]/findings/[findingId]/todo/route";
import {
  GET as getTodo,
  PATCH as updateTodo,
  DELETE as deleteTodo
} from "./[todoId]/route";
import { POST as completeTodo } from "./[todoId]/complete/route";
import {
  POST as addToMyDay,
  DELETE as removeFromMyDay
} from "./[todoId]/my-day/route";
import { POST as reopenTodo } from "./[todoId]/reopen/route";
import { GET as getTodoSource } from "./[todoId]/source/route";
import { GET as listTodos, POST as createTodo } from "./route";

const hash = "c".repeat(64);
let meetingRepository: WorkReviewRepository;
let todoRepository: WorkTodoRepository;

function authContext(accountId: string): AuthContext {
  return {
    user: { id: accountId, email: `${accountId}@example.test`, name: accountId },
    store: {
      read: vi.fn(), write: vi.fn(), delete: vi.fn(), list: vi.fn()
    } as unknown as AuthContext["store"],
    dataRootDir: `C:\\test-data\\${accountId}`,
    uploadsRootDir: `C:\\test-data\\${accountId}\\uploads`
  };
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

async function responseJson(response: Response) {
  return await response.json() as Record<string, unknown>;
}

function sourceSegment(uploadId: string): WorkTranscriptSegment {
  return {
    id: `segment_${uploadId}`,
    uploadId,
    startSeconds: 10,
    endSeconds: 18,
    speaker: "Speaker 1",
    text: "请在周五前完成接口联调。",
    confidence: 0.98,
    sceneLabels: [],
    valueLabels: []
  };
}

function publishFinding(input: {
  accountId: string;
  suffix: string;
  kind?: WorkMeetingCandidateKind;
  actionBasis?: "explicit_commitment" | "assignment_without_acceptance"
    | "suggested_action" | "unowned_follow_up";
}) {
  const kind = input.kind ?? "action_item";
  const uploadId = `upload_${input.suffix}`;
  const meetingId = `meeting_${input.suffix}`;
  const meeting = meetingRepository.reserveMeeting({
    accountId: input.accountId,
    idempotencyKey: `reserve_${input.suffix}`,
    operationKey: `reserve_${input.suffix}`,
    contentHash: hash,
    sourceUploadId: uploadId,
    meetingId,
    title: `会议 ${input.suffix}`,
    meetingDate: "2026-09-02"
  }).meeting;
  meetingRepository.publishSourceUpload({
    accountId: input.accountId,
    meetingId,
    uploadId,
    originalName: "meeting.wav",
    mimeType: "audio/wav",
    sizeBytes: 128,
    recordingDate: "2026-09-02",
    filePath: `C:\\test-data\\${input.accountId}\\uploads\\${uploadId}.wav`,
    contentHash: hash
  });
  meetingRepository.queueStage({ accountId: input.accountId, meetingId, stage: "transcription" });
  const transcriptionFence = meetingRepository.claimProcessingAttempt({
    accountId: input.accountId,
    meetingId,
    stage: "transcription",
    leaseOwner: `transcriber_${input.suffix}`,
    leaseDurationMs: 60_000,
    pipelineVersion: "work_meeting_v1",
    providerProfile: "fixture"
  });
  if (!transcriptionFence) throw new Error("expected transcription fence");
  const segment = sourceSegment(uploadId);
  meetingRepository.publishCanonicalTranscript({
    accountId: input.accountId,
    meetingId,
    fence: transcriptionFence,
    segments: [segment],
    sourceDurationSeconds: 90
  });
  meetingRepository.queueStage({ accountId: input.accountId, meetingId, stage: "meeting_analysis" });
  const analysisFence = meetingRepository.claimProcessingAttempt({
    accountId: input.accountId,
    meetingId,
    stage: "meeting_analysis",
    leaseOwner: `analyzer_${input.suffix}`,
    leaseDurationMs: 60_000,
    pipelineVersion: "work_meeting_v1",
    providerProfile: "fixture",
    promptVersion: "work_meeting_extractor_v1"
  });
  if (!analysisFence) throw new Error("expected analysis fence");
  meetingRepository.markAnalysisVerifying({
    accountId: input.accountId,
    meetingId,
    fence: analysisFence
  });
  const publication = meetingRepository.readCanonicalPublication(input.accountId, meetingId);
  if (!publication) throw new Error("expected canonical publication");
  const claimType = kind === "action_item" ? "action_item"
    : kind === "commitment" ? "commitment_existence"
      : "decision_existence";
  const candidates = meetingRepository.publishAnalysisResult({
    accountId: input.accountId,
    meetingId,
    fence: analysisFence,
    canonicalContentDigest: publication.contentDigest,
    candidates: [{
      id: `candidate_${input.suffix}`,
      kind,
      title: `完成联调 ${input.suffix}`,
      body: "确认需要完成接口联调。",
      structuredData: {
        decisionFinality: kind === "decision" ? "final" : null,
        rawActorLabel: "Speaker 1",
        candidateOwner: null,
        dueAt: kind === "action_item" || kind === "commitment"
          ? "2026-09-04T10:00:00.000Z" : null,
        originalDueExpression: kind === "action_item" || kind === "commitment" ? "周五前" : null,
        actionBasis: kind === "action_item" || kind === "commitment"
          ? input.actionBasis ?? "explicit_commitment" : null,
        relatedCommitmentCandidateId: null,
        planStages: []
      },
      publicationAction: "show_as_candidate",
      riskLevel: "high",
      generatorProfile: "fixture",
      generatorPromptVersion: "work_meeting_extractor_v1",
      evidenceSegmentIds: [segment.id],
      timestampQualityBySegmentId: { [segment.id]: "provider_exact" },
      claims: [{
        id: `claim_${input.suffix}`,
        claimType,
        text: "存在会议结果。",
        evidenceSegmentIds: [segment.id],
        evaluation: {
          supportVerdict: "entailed",
          issueCodes: [],
          riskLevel: "high",
          publicationAction: "show_as_candidate",
          confirmationRequired: true,
          supportedEvidenceIds: [segment.id],
          generatorProfile: "fixture",
          verifierProfile: "fixture",
          verifierPromptVersion: "work_meeting_verifier_v1",
          policyVersion: "work_meeting_publication_v1"
        }
      }]
    }]
  });
  const reviewed = meetingRepository.reviewCandidate({
    accountId: input.accountId,
    meetingId,
    candidateId: candidates[0]!.id,
    action: "accept",
    expectedVersion: candidates[0]!.version,
    operationKey: `confirm_${input.suffix}`
  });
  if (!reviewed.finding) throw new Error("expected confirmed finding");
  return { meeting, candidate: candidates[0]!, finding: reviewed.finding };
}

function manualBody(
  operationKey: string,
  overrides: Record<string, unknown> = {}
): CreateManualWorkTodoRequest & Record<string, unknown> {
  return {
    operationKey,
    title: "完成 Todo API",
    kind: "self",
    notes: null,
    ownerLabel: null,
    currentDueDate: "2026-09-04",
    isImportant: false,
    myDayDate: null,
    ...overrides
  } as CreateManualWorkTodoRequest & Record<string, unknown>;
}

function projectionBody(
  operationKey: string,
  overrides: Record<string, unknown> = {}
): CreateWorkTodoFromFindingRequest & Record<string, unknown> {
  return {
    operationKey,
    title: "完成接口联调",
    kind: "self",
    notes: null,
    ownerLabel: null,
    currentDueDate: "2026-09-04",
    isImportant: false,
    myDayDate: null,
    ownershipOverrideConfirmed: false,
    ...overrides
  } as CreateWorkTodoFromFindingRequest & Record<string, unknown>;
}

beforeEach(() => {
  state.database = openWorkReviewDatabase({ filePath: ":memory:" });
  let id = 0;
  const options = {
    now: () => "2026-09-02T10:00:00.000Z",
    idFactory: () => `test_${++id}`
  };
  meetingRepository = new WorkReviewRepository(state.database, options);
  todoRepository = new WorkTodoRepository(state.database, options);
  state.authContext = authContext("account_a");
  process.env.WORK_REVIEW_ENABLED = "true";
  process.env.WORK_REVIEW_UPLOAD_ENABLED = "true";
  process.env.WORK_REVIEW_ANALYSIS_ENABLED = "true";
  process.env.WORK_REVIEW_VERIFIER_ENABLED = "true";
  process.env.WORK_REVIEW_TODO_ENABLED = "true";
  process.env.WORK_REVIEW_TODO_MEETING_PROJECTION_ENABLED = "true";
  mocks.cleanupUploadArtifacts.mockReset().mockResolvedValue({ ok: true, failures: [] });
});

afterEach(() => {
  state.database?.close();
  state.database = null;
  state.authContext = null;
  for (const name of [
    "WORK_REVIEW_ENABLED", "WORK_REVIEW_UPLOAD_ENABLED", "WORK_REVIEW_ANALYSIS_ENABLED",
    "WORK_REVIEW_VERIFIER_ENABLED", "WORK_REVIEW_TODO_ENABLED",
    "WORK_REVIEW_TODO_MEETING_PROJECTION_ENABLED"
  ]) delete process.env[name];
});

describe("Work Todo routes", () => {
  it("fails closed before auth and rejects client scope/source fields", async () => {
    state.authContext = null;
    const unauthenticated = await createTodo(jsonRequest(
      "http://localhost/api/work-reviews/todos", "POST", manualBody("unauthenticated")
    ));
    expect(unauthenticated.status).toBe(401);

    state.authContext = authContext("account_a");
    const forged = await createTodo(jsonRequest(
      "http://localhost/api/work-reviews/todos",
      "POST",
      manualBody("forged", { accountId: "account_b", sourceFindingId: "finding_fake" })
    ));
    expect(forged.status).toBe(400);
    expect(todoRepository.listTodos({ accountId: "account_a", view: "all" })).toHaveLength(0);
  });

  it("keeps manual Todo available while both Todo flags fail closed independently", async () => {
    process.env.WORK_REVIEW_TODO_ENABLED = "false";
    const disabled = await createTodo(jsonRequest(
      "http://localhost/api/work-reviews/todos", "POST", manualBody("disabled")
    ));
    expect(disabled.status).toBe(404);

    process.env.WORK_REVIEW_TODO_ENABLED = "true";
    process.env.WORK_REVIEW_TODO_MEETING_PROJECTION_ENABLED = "false";
    const finding = publishFinding({ accountId: "account_a", suffix: "projection_flag" });
    const projection = await projectFinding(
      jsonRequest("http://localhost/projection", "POST", projectionBody("projection_disabled")),
      routeContext({ meetingId: finding.meeting.id, findingId: finding.finding.id })
    );
    const manual = await createTodo(jsonRequest(
      "http://localhost/api/work-reviews/todos", "POST", manualBody("manual_enabled")
    ));
    expect(projection.status).toBe(404);
    expect(manual.status).toBe(201);
  });

  it("supports manual create, edit, My Day, complete, reopen, list, and delete", async () => {
    const created = await createTodo(jsonRequest(
      "http://localhost/api/work-reviews/todos",
      "POST",
      manualBody("manual_lifecycle", { myDayDate: "2026-09-02" })
    ));
    const createdBody = await responseJson(created);
    const createdTodo = createdBody.todo as { id: string; version: number };
    expect(created.status).toBe(201);

    const today = await listTodos(new Request(
      "http://localhost/api/work-reviews/todos?view=today&day=2026-09-02"
    ));
    expect((await responseJson(today)).todos).toEqual([
      expect.objectContaining({ id: createdTodo.id })
    ]);

    const updated = await updateTodo(
      jsonRequest("http://localhost/todo", "PATCH", {
        expectedVersion: createdTodo.version,
        operationKey: "update_lifecycle",
        title: "完成 Todo Route",
        isImportant: true
      }),
      routeContext({ todoId: createdTodo.id })
    );
    const updatedTodo = (await responseJson(updated)).todo as { version: number };
    const completed = await completeTodo(
      jsonRequest("http://localhost/complete", "POST", {
        expectedVersion: updatedTodo.version,
        operationKey: "complete_lifecycle"
      }),
      routeContext({ todoId: createdTodo.id })
    );
    const completedTodo = (await responseJson(completed)).todo as { version: number };
    expect(completed.status).toBe(200);
    const completedList = await listTodos(new Request(
      "http://localhost/api/work-reviews/todos?view=completed"
    ));
    expect((await responseJson(completedList)).todos).toEqual([
      expect.objectContaining({ id: createdTodo.id, status: "completed" })
    ]);

    const reopened = await reopenTodo(
      jsonRequest("http://localhost/reopen", "POST", {
        expectedVersion: completedTodo.version,
        operationKey: "reopen_lifecycle"
      }),
      routeContext({ todoId: createdTodo.id })
    );
    const reopenedTodo = (await responseJson(reopened)).todo as { version: number };
    const removed = await removeFromMyDay(
      jsonRequest("http://localhost/my-day", "DELETE", {
        expectedVersion: reopenedTodo.version,
        operationKey: "remove_day_lifecycle"
      }),
      routeContext({ todoId: createdTodo.id })
    );
    const removedTodo = (await responseJson(removed)).todo as { version: number };
    const added = await addToMyDay(
      jsonRequest("http://localhost/my-day", "POST", {
        day: "2026-09-03",
        expectedVersion: removedTodo.version,
        operationKey: "add_day_lifecycle"
      }),
      routeContext({ todoId: createdTodo.id })
    );
    const addedTodo = (await responseJson(added)).todo as { version: number };
    const deleted = await deleteTodo(
      jsonRequest("http://localhost/todo", "DELETE", {
        expectedVersion: addedTodo.version,
        operationKey: "delete_lifecycle"
      }),
      routeContext({ todoId: createdTodo.id })
    );
    expect(deleted.status).toBe(200);
    const all = await listTodos(new Request("http://localhost/api/work-reviews/todos?view=all"));
    expect((await responseJson(all)).todos).toEqual([]);
  });

  it("prevents account A from reading or mutating account B Todo and source", async () => {
    const source = publishFinding({ accountId: "account_b", suffix: "private_b" });
    const privateTodo = todoRepository.createTodoFromFinding({
      accountId: "account_b",
      meetingId: source.meeting.id,
      findingId: source.finding.id,
      ...projectionBody("private_b_create")
    }).todo;
    state.authContext = authContext("account_a");
    const context = routeContext({ todoId: privateTodo.id });
    const responses = await Promise.all([
      getTodo(new Request("http://localhost/todo"), context),
      updateTodo(jsonRequest("http://localhost/todo", "PATCH", {
        expectedVersion: privateTodo.version, operationKey: "private_update", title: "越权"
      }), context),
      completeTodo(jsonRequest("http://localhost/complete", "POST", {
        expectedVersion: privateTodo.version, operationKey: "private_complete"
      }), context),
      deleteTodo(jsonRequest("http://localhost/todo", "DELETE", {
        expectedVersion: privateTodo.version, operationKey: "private_delete"
      }), context),
      getTodoSource(new Request("http://localhost/source"), context)
    ]);
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
    expect(todoRepository.getTodo("account_b", privateTodo.id).status).toBe("open");
  });

  it("projects only confirmed supported Finding kinds and reuses an active projection", async () => {
    const source = publishFinding({ accountId: "account_a", suffix: "projection" });
    const context = routeContext({ meetingId: source.meeting.id, findingId: source.finding.id });
    const first = await projectFinding(
      jsonRequest("http://localhost/projection", "POST", projectionBody("projection_first")),
      context
    );
    const firstTodo = (await responseJson(first)).todo as { id: string };
    const duplicate = await projectFinding(
      jsonRequest("http://localhost/projection", "POST", projectionBody("projection_duplicate")),
      context
    );
    expect(first.status).toBe(201);
    expect(await responseJson(duplicate)).toMatchObject({
      reused: true,
      todo: { id: firstTodo.id }
    });

    const meeting = await getMeeting(
      new Request(`http://localhost/api/work-reviews/meetings/${source.meeting.id}`),
      routeContext({ meetingId: source.meeting.id })
    );
    expect(await responseJson(meeting)).toMatchObject({
      linkedTodoCount: 1,
      todoProjections: [{
        id: firstTodo.id,
        sourceFindingId: source.finding.id,
        status: "open"
      }]
    });

    const resolvedSource = await getTodoSource(
      new Request("http://localhost/source"), routeContext({ todoId: firstTodo.id })
    );
    expect(await responseJson(resolvedSource)).toMatchObject({
      todoId: firstTodo.id,
      sourceChanged: false,
      finding: { id: source.finding.id },
      evidenceContexts: [expect.objectContaining({ isDirectEvidence: true })]
    });

    const decision = publishFinding({ accountId: "account_a", suffix: "decision", kind: "decision" });
    const rejectedKind = await projectFinding(
      jsonRequest("http://localhost/projection", "POST", projectionBody("decision_projection")),
      routeContext({ meetingId: decision.meeting.id, findingId: decision.finding.id })
    );
    const pendingCandidate = await projectFinding(
      jsonRequest("http://localhost/projection", "POST", projectionBody("pending_projection")),
      routeContext({ meetingId: source.meeting.id, findingId: source.candidate.id })
    );
    expect(rejectedKind.status).toBe(400);
    expect(pendingCandidate.status).toBe(404);
  });

  it("requires the explicit ownership override for assignment without acceptance", async () => {
    const source = publishFinding({
      accountId: "account_a",
      suffix: "assignment",
      kind: "action_item",
      actionBasis: "assignment_without_acceptance"
    });
    const context = routeContext({ meetingId: source.meeting.id, findingId: source.finding.id });
    const rejected = await projectFinding(
      jsonRequest("http://localhost/projection", "POST", projectionBody("assignment_rejected")),
      context
    );
    expect(rejected.status).toBe(409);
    expect(await responseJson(rejected)).toEqual({ error: "todo_ownership_override_required" });

    const accepted = await projectFinding(
      jsonRequest("http://localhost/projection", "POST", projectionBody(
        "assignment_accepted", { ownershipOverrideConfirmed: true }
      )),
      context
    );
    expect(accepted.status).toBe(201);
  });

  it("requires a linked-Todo policy and can detach while preserving unrelated Todo", async () => {
    const source = publishFinding({ accountId: "account_a", suffix: "detach" });
    const linked = todoRepository.createTodoFromFinding({
      accountId: "account_a",
      meetingId: source.meeting.id,
      findingId: source.finding.id,
      ...projectionBody("detach_linked")
    }).todo;
    const manual = todoRepository.createManualTodo({
      accountId: "account_a",
      ...manualBody("detach_manual")
    }).todo;
    const noPolicy = await deleteMeeting(
      new Request("http://localhost/meeting", { method: "DELETE" }),
      routeContext({ meetingId: source.meeting.id })
    );
    expect(noPolicy.status).toBe(409);
    expect(await responseJson(noPolicy)).toEqual({
      error: "linked_todos_require_policy",
      linkedTodoCount: 1,
      linkedTodoIds: [linked.id]
    });
    expect(meetingRepository.getMeeting("account_a", source.meeting.id).deletedAt).toBeNull();

    const detached = await deleteMeeting(
      jsonRequest("http://localhost/meeting", "DELETE", { policy: "detach_linked_todos" }),
      routeContext({ meetingId: source.meeting.id })
    );
    expect(detached.status).toBe(200);
    expect(todoRepository.getTodo("account_a", linked.id)).toMatchObject({
      origin: "detached_meeting_finding",
      sourceMeetingId: null,
      sourceFindingId: null,
      sourceActionBasis: null
    });
    expect(todoRepository.getTodo("account_a", manual.id).origin).toBe("manual");
    const detachedSource = await getTodoSource(
      new Request("http://localhost/source"), routeContext({ todoId: linked.id })
    );
    expect(detachedSource.status).toBe(409);
  });

  it("can soft-delete linked Todo with the meeting without affecting another meeting", async () => {
    const target = publishFinding({ accountId: "account_a", suffix: "delete_linked" });
    const other = publishFinding({ accountId: "account_a", suffix: "other_meeting" });
    const targetTodo = todoRepository.createTodoFromFinding({
      accountId: "account_a",
      meetingId: target.meeting.id,
      findingId: target.finding.id,
      ...projectionBody("target_todo")
    }).todo;
    const otherTodo = todoRepository.createTodoFromFinding({
      accountId: "account_a",
      meetingId: other.meeting.id,
      findingId: other.finding.id,
      ...projectionBody("other_todo")
    }).todo;
    const response = await deleteMeeting(
      jsonRequest("http://localhost/meeting", "DELETE", { policy: "delete_linked_todos" }),
      routeContext({ meetingId: target.meeting.id })
    );
    expect(response.status).toBe(200);
    expect(() => todoRepository.getTodo("account_a", targetTodo.id)).toThrow();
    expect(todoRepository.getTodo("account_a", otherTodo.id).id).toBe(otherTodo.id);
    expect(meetingRepository.getMeeting("account_a", other.meeting.id).deletedAt).toBeNull();
  });
});
