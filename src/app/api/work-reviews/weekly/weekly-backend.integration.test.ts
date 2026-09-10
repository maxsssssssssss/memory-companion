// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkMeetingCandidateStructuredDataSchema } from "@/lib/domain/work-review";
import { WorkWeeklyReviewItemSchema, type WorkWeeklyRun } from "@/lib/domain/work-weekly";
import { openWorkReviewDatabase } from "@/lib/server/work-review/db";
import { WorkProjectRepository } from "@/lib/server/work-review/project-repository";
import { WorkReviewRepository } from "@/lib/server/work-review/repository";
import { WorkTodoRepository } from "@/lib/server/work-review/todo-repository";
import {
  createStructuredWorkWeeklySynthesizer, createStructuredWorkWeeklyClaimVerifier, WorkWeeklyGeneratedClaimSchema,
  type WorkWeeklyStructuredJsonRequest, type WorkWeeklyGeneratedClaim
} from "@/lib/server/work-review/weekly-ai-provider";
import { createFixtureWorkWeeklyRunExecutor } from "@/lib/server/work-review/weekly-ai-runner";
import { workWeeklyProfile } from "@/lib/server/work-review/weekly-ai-test-fixture";
import {
  createStructuredWorkWeeklyQaAnswerer, createStructuredWorkWeeklyQaVerifier
} from "@/lib/server/work-review/weekly-qa-provider";
import { WorkWeeklyService } from "@/lib/server/work-review/weekly-service";

const state = vi.hoisted(() => ({
  database: null as Database.Database | null, accountId: "account_a", sequence: 0,
  network: vi.fn(() => { throw new Error("offline_fixture_network_forbidden"); })
}));
vi.mock("@/lib/server/auth/request-context", () => ({
  requireAuthContext: vi.fn(async () => ({ user: { id: state.accountId } })),
  isUnauthenticatedError: () => false
}));
vi.mock("@/lib/server/work-review/db", async (original) => ({
  ...await original<typeof import("@/lib/server/work-review/db")>(),
  getWorkReviewDatabase: () => state.database!
}));
vi.mock("@/lib/server/openai/client", () => ({ createOpenAIClient: state.network }));
vi.mock("node:crypto", async (original) => ({
  ...await original<typeof import("node:crypto")>(),
  randomUUID: () => `00000000-0000-4000-8000-${String(++state.sequence).padStart(12, "0")}`
}));

import { GET as getDetail } from "./[weeklyReviewId]/route";
import { PATCH as editItem } from "./[weeklyReviewId]/items/[itemId]/route";
import { GET as getSource } from "./[weeklyReviewId]/sources/[sourceRef]/route";
import { GET as getQa, POST as askQa } from "./[weeklyReviewId]/qa/route";
import { POST as reset } from "./[weeklyReviewId]/reset/route";

beforeEach(() => {
  state.sequence = 0;
  state.accountId = "account_a";
  state.network.mockClear();
  vi.stubGlobal("fetch", state.network);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-01T01:00:00.000Z"));
  for (const flag of ["WORK_REVIEW_ENABLED", "WORK_REVIEW_PROJECTS_ENABLED",
    "WORK_REVIEW_WEEKLY_ENABLED", "WORK_REVIEW_WEEKLY_AI_ENABLED", "WORK_REVIEW_WEEKLY_QA_ENABLED"]) {
    vi.stubEnv(flag, "true");
  }
  state.database = openWorkReviewDatabase({ filePath: ":memory:" });
});

afterEach(() => {
  state.database?.close();
  state.database = null;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  expect(state.network).not.toHaveBeenCalled();
});

const accountId = "account_a";
const bodyText = "成员甲确认会检查发布清单。";
const editText = "用户编辑的周报内容";
const request = (method = "GET", body?: unknown) => new Request("http://localhost/fixture", {
  method, ...(body === undefined ? {} : {
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  })
});
const path = (weeklyReviewId: string) => ({ params: Promise.resolve({ weeklyReviewId }) });

function seedMeeting(repository: WorkReviewRepository, projectId: string, index: number) {
  const meeting = repository.reserveMeeting({
    accountId, idempotencyKey: `upload_${index}`, contentHash: String(index).repeat(64),
    sourceUploadId: `upload_${index}`, title: `匿名会议 ${index}`,
    meetingDate: "2026-09-01", sourceDurationSeconds: 8, projectIds: [projectId]
  }).meeting;
  repository.publishSourceUpload({
    accountId, meetingId: meeting.id, uploadId: meeting.sourceUploadId,
    originalName: "fixture.wav", mimeType: "audio/wav", sizeBytes: 32,
    recordingDate: "2026-09-01", filePath: `fixture-${index}.wav`,
    contentHash: String(index).repeat(64)
  });
  repository.queueStage({ accountId, meetingId: meeting.id, stage: "transcription" });
  const transcriptFence = repository.claimProcessingAttempt({
    accountId, meetingId: meeting.id, stage: "transcription", leaseOwner: "fixture_asr",
    leaseDurationMs: 60_000, pipelineVersion: "fixture_v1", providerProfile: "fixture"
  })!;
  const canonical = repository.publishCanonicalTranscript({
    accountId, meetingId: meeting.id, fence: transcriptFence,
    segments: [
      { id: `segment_${index}`, uploadId: meeting.sourceUploadId, startSeconds: 0, endSeconds: 4,
        speaker: "SPEAKER_00", text: bodyText, confidence: 1, sceneLabels: [], valueLabels: [] },
      { id: `uncited_${index}`, uploadId: meeting.sourceUploadId, startSeconds: 4, endSeconds: 8,
        speaker: "SPEAKER_01", text: "UNCITED_FIXTURE", confidence: 1, sceneLabels: [], valueLabels: [] }
    ]
  });
  repository.queueStage({ accountId, meetingId: meeting.id, stage: "meeting_analysis" });
  const analysisFence = repository.claimProcessingAttempt({
    accountId, meetingId: meeting.id, stage: "meeting_analysis", leaseOwner: "fixture_analysis",
    leaseDurationMs: 60_000, pipelineVersion: "fixture_v1", providerProfile: "fixture"
  })!;
  repository.markAnalysisVerifying({ accountId, meetingId: meeting.id, fence: analysisFence });
  const [candidate] = repository.publishAnalysisResult({
    accountId, meetingId: meeting.id, fence: analysisFence,
    canonicalContentDigest: canonical.publication.contentDigest,
    candidates: [{
      kind: "commitment", title: "检查发布清单", body: bodyText,
      structuredData: WorkMeetingCandidateStructuredDataSchema.parse({
        decisionFinality: null, rawActorLabel: "SPEAKER_00", candidateOwner: null,
        dueAt: null, originalDueExpression: null, actionBasis: "explicit_commitment",
        relatedCommitmentCandidateId: null, planStages: []
      }),
      publicationAction: "show_as_candidate", riskLevel: "high",
      generatorProfile: "fixture", generatorPromptVersion: "fixture_v1",
      evidenceSegmentIds: [`segment_${index}`],
      timestampQualityBySegmentId: { [`segment_${index}`]: "provider_exact" },
      claims: [{
        claimType: "commitment_existence", text: bodyText, evidenceSegmentIds: [`segment_${index}`],
        evaluation: {
          supportVerdict: "entailed", issueCodes: [], riskLevel: "high",
          publicationAction: "show_as_candidate", confirmationRequired: true,
          supportedEvidenceIds: [`segment_${index}`], generatorProfile: "fixture",
          verifierProfile: "fixture_verifier", verifierPromptVersion: "fixture_v1",
          policyVersion: "fixture_v1"
        }
      }]
    }]
  });
  const finding = repository.reviewCandidate({
    accountId, meetingId: meeting.id, candidateId: candidate!.id, action: "accept",
    expectedVersion: candidate!.version, operationKey: `confirm_${index}`
  }).finding!;
  return { meetingId: meeting.id, finding, publicationId: canonical.publication.publicationId };
}

async function fixture(needsReview = false) {
  const database = state.database!;
  const projects = new WorkProjectRepository(database);
  const meetings = new WorkReviewRepository(database);
  const todos = new WorkTodoRepository(database);
  const service = new WorkWeeklyService(database);
  const repository = service.runtimeRepository();
  const project = projects.createProject({
    accountId, operationKey: "project", name: "匿名项目", description: null
  }).project;
  const sources = [1, 2].map((index) => seedMeeting(meetings, project.id, index));
  for (const [index, source] of sources.entries()) {
    const todo = todos.createTodoFromFinding({
      accountId, meetingId: source.meetingId, findingId: source.finding.id,
      operationKey: `todo_${index}`, title: "检查发布清单", kind: "self", notes: null,
      ownerLabel: null, currentDueDate: null, isImportant: false, myDayDate: null,
      ownershipOverrideConfirmed: false, projectIds: [project.id]
    }).todo;
    vi.setSystemTime(new Date("2026-09-02T01:00:00.000Z"));
    todos.completeTodo({ accountId, todoId: todo.id, expectedVersion: todo.version,
      operationKey: `complete_${index}` });
  }
  vi.setSystemTime(new Date("2026-09-07T01:00:00.000Z"));
  const scope = { weekStart: "2026-08-31", timeZone: "Asia/Shanghai",
    scopeKind: "project" as const, projectId: project.id };
  const snapshot = service.buildSnapshot(accountId, scope);
  expect(snapshot.summary).toMatchObject({ findingCount: 2, evidenceCount: 2, todoCount: 2 });
  expect(snapshot.todoEvents.filter((event) => event.eventType === "todo.completed")).toHaveLength(2);
  expect(JSON.stringify(snapshot)).not.toContain("UNCITED_FIXTURE");
  const refs = sources.map((source) => snapshot.evidence.find((item) =>
    item.meetingId === source.meetingId)!.sourceRef);
  const claim = { id: "claim_1", text: bodyText, claimType: "fact" as const, sourceRefs: refs };
  const completions = snapshot.todoEvents.filter((event) => event.eventType === "todo.completed");
  const completionClaims = completions.map((event, index) => {
    const completedState = event.stateAfter;
    if (!completedState || completedState.status !== "completed") {
      throw new Error("fixture_completed_event_state_invalid");
    }
    return { id: `claim_completed_${index}`,
      text: `${completedState.title}在系统中标记完成。`, claimType: "completion" as const,
      sourceRefs: [event.sourceRef] };
  });
  const completionByTodo = new Map(completions.map((event, index) => [event.todoId, completionClaims[index]!]));
  expect([...completionByTodo.keys()].sort()).toEqual(snapshot.todos.map((todo) => todo.id).sort());
  // The anonymous oracle fixes each source-to-claim meaning independently of model output.
  // They exercise the strict generation contract; they are not real model quality evidence.
  const coverage = [
    ...snapshot.findings.map((source, index) => ({ sourceRef: source.sourceRef,
      status: needsReview && index === 0 ? "partial" as const : "covered" as const,
      reasonCode: needsReview && index === 0 ? "missing_key_content" as const : "covered" as const,
      claimId: claim.id })),
    ...[...snapshot.todos, ...snapshot.todoEvents].map((source) => {
      const completed = completionByTodo.get("todoId" in source ? source.todoId : source.id)!;
      return { sourceRef: source.sourceRef, status: "covered" as const, reasonCode: "covered" as const,
        claimId: completed.id };
    })
  ];
  const verdict = (value: WorkWeeklyGeneratedClaim) => ({ claimId: value.id, verdict: "entailed",
    issueCodes: [], supportedSourceRefs: value.sourceRefs });
  const provider = vi.fn<WorkWeeklyStructuredJsonRequest>(async (input) => {
    const payload = JSON.stringify(input.requestInput);
    expect(payload).not.toContain(editText);
    expect(payload).not.toContain("UNCITED_FIXTURE");
    switch (input.profile.role) {
      case "synthesizer": return { items: [
        { id: "item_1", section: "progress", text: bodyText,
          itemType: "evidence_backed_fact", claims: [claim] },
        ...completionClaims.map((completionClaim, index) => ({
          id: `completed_${index}`, section: "completed", text: completionClaim.text,
          itemType: "evidence_backed_fact", claims: [completionClaim]
        }))
      ] };
      case "verifier": {
        if (!Array.isArray(input.requestInput)) throw new Error("fixture_verifier_input_invalid");
        const message = input.requestInput[1];
        if (!message || !("content" in message) || typeof message.content !== "string") {
          throw new Error("fixture_verifier_input_invalid");
        }
        const entries = JSON.parse(message.content) as { items: Array<{ claim: unknown }> };
        const expectedClaims = [claim, ...completionClaims];
        expect(entries.items).toHaveLength(expectedClaims.length);
        const requestedClaims = entries.items.map((entry, index) => {
          const expected = expectedClaims[index]!;
          // The verifier judges prose without the generator's type label; the oracle keeps its fixed type.
          expect(entry.claim).toEqual({ id: expect.any(String), text: expected.text, sourceRefs: expected.sourceRefs });
          if (!entry.claim || typeof entry.claim !== "object") throw new Error("fixture_verifier_claim_invalid");
          return WorkWeeklyGeneratedClaimSchema.parse({ ...entry.claim, claimType: expected.claimType });
        });
        // Use normalized IDs from the real request, while independently fixing the fixture facts and citations.
        expect(requestedClaims.map(({ id: _id, ...value }) => value))
          .toEqual(expectedClaims.map(({ id: _id, ...value }) => value));
        const requestedIds = new Map(expectedClaims.map((value, index) => [value.id, requestedClaims[index]!.id]));
        return { items: requestedClaims.map(verdict), disputes: [], coverage: coverage.map((entry) => ({
          sourceRef: entry.sourceRef, status: entry.status, reasonCode: entry.reasonCode,
          claimIds: [requestedIds.get(entry.claimId)!]
        })) };
      }
      case "qa_answerer": return { status: "answered", answer: bodyText,
        claims: [claim], relevantSourceRefs: refs };
      case "qa_verifier": return { items: [verdict(claim)] };
    }
  });
  const publicationDiagnostics: unknown[] = [];
  const executor = createFixtureWorkWeeklyRunExecutor({
    repository, loadSnapshot: () => service.buildSnapshot(accountId, scope),
    diagnosticSink: async ({ event }) => {
      if (event.stage === "pipeline" && event.trace.stage === "published") publicationDiagnostics.push({
        quality: event.trace.quality_assessment,
        claims: event.trace.claims.map(({ claimId, outcome, reasonCode }) => ({ claimId, outcome, reasonCode }))
      });
    },
    synthesizer: createStructuredWorkWeeklySynthesizer({
      profile: workWeeklyProfile("synthesizer"), requestStructuredJson: provider }),
    weeklyVerifier: createStructuredWorkWeeklyClaimVerifier({
      profile: workWeeklyProfile("verifier"), requestStructuredJson: provider }),
    qaAnswerer: createStructuredWorkWeeklyQaAnswerer({
      profile: workWeeklyProfile("qa_answerer"), requestStructuredJson: provider }),
    qaVerifier: createStructuredWorkWeeklyQaVerifier({
      profile: workWeeklyProfile("qa_verifier"), requestStructuredJson: provider })
  });
  const runGeneration = (run: WorkWeeklyRun) => executor.runGeneration({
    accountId, weeklyReviewId: run.weeklyReviewId, runId: run.id, runVersion: run.runVersion,
    sourceSnapshotDigest: run.sourceSnapshotDigest, observedState: "queued", leaseOwner: "fixture",
    leaseMs: 60_000
  });
  const generated = service.generate(accountId, { ...scope, operationKey: "generate", expectedVersion: null });
  const generationResult = await runGeneration(generated.run);
  // Surface anonymous oracle assertion failures before the executor's safe public error code.
  for (const result of provider.mock.results) {
    if (result.type === "return") await expect(result.value).resolves.toBeDefined();
  }
  expect(generationResult.state, JSON.stringify({ generationResult, publicationDiagnostics })).toBe("published");
  const reviewId = generated.review.id;
  expect(service.getDetail(accountId, reviewId).latestGeneration).toMatchObject({
    executionStatus: "completed", sourceCheckStatus: "completed", qualityStatus: needsReview ? "needs_review" : "passed"
  });
  expect(service.getDetail(accountId, reviewId).displayedGeneration).toMatchObject({
    systemVersion: 1, qualityStatus: needsReview ? "needs_review" : "passed",
    reviewIssues: needsReview ? [{ sourceRef: snapshot.findings[0]!.sourceRef, reasonCode: "missing_key_content" }] : []
  });
  const item = service.getDetail(accountId, reviewId).items.find((value) => value.section === "progress")!;
  const edited = await editItem(request("PATCH", {
    operationKey: "edit", expectedVersion: item.version, text: editText
  }), { params: Promise.resolve({ weeklyReviewId: reviewId, itemId: item.id }) });
  expect(edited.status).toBe(200);
  const editedItem = WorkWeeklyReviewItemSchema.parse((await edited.json()).item);
  const queuedQa = await askQa(request("POST", {
    question: "本周检查发布清单的进度如何？", operationKey: "question", expectedVersion: null
  }), path(reviewId));
  expect(queuedQa.status).toBe(202);
  const qa = await queuedQa.json() as ReturnType<WorkWeeklyService["askQa"]>;
  expect((await executor.runQa({
    accountId, weeklyReviewId: reviewId, runId: qa.run.id, runVersion: qa.run.runVersion,
    threadId: qa.run.threadId, questionMessageId: qa.run.questionMessageId,
    sourceSnapshotDigest: qa.run.sourceSnapshotDigest, observedState: "queued",
    leaseOwner: "fixture_qa", leaseMs: 60_000
  })).state).toBe("published");
  expect(provider).toHaveBeenCalledTimes(4);
  const answer = service.getQa(accountId, reviewId)!.messages.find((value) => value.role === "assistant")!;
  expect(answer.sourceRefs).toEqual([...refs].sort());
  const completedItems = service.getDetail(accountId, reviewId).items.filter((value) => value.section === "completed");
  for (const completedItem of completedItems) expect(completedItem.systemText).toContain("在系统中标记完成");
  expect([...new Set(completedItems.flatMap((value) => value.sourceRefs))].sort())
    .toEqual(completions.map((event) => event.sourceRef).sort());
  return { database, projects, project, meetings, sources, service, repository, snapshot,
    scope, refs, reviewId, item: editedItem, answer, provider, runGeneration };
}

async function detail(reviewId: string) {
  const response = await getDetail(request(), path(reviewId));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  return await response.json() as ReturnType<WorkWeeklyService["getDetail"]>;
}

async function citation(reviewId: string, sourceRef: string) {
  return getSource(request(), { params: Promise.resolve({ weeklyReviewId: reviewId, sourceRef }) });
}

describe("Work Weekly offline SQLite/backend/API closure", () => {
  it.each(["meeting_delete", "scope_unlink", "canonical_revoke"] as const)(
    "retains edited Item/QA/canonical citation until the final source is gone: %s", async (mode) => {
      const needsReview = mode === "canonical_revoke";
      const f = await fixture(needsReview);
      expect((await detail(f.reviewId)).displayedGeneration?.qualityStatus)
        .toBe(needsReview ? "needs_review" : "passed");
      for (const ref of f.refs) {
        const response = await citation(f.reviewId, ref);
        expect(response.status).toBe(200);
        expect((await response.json()).source.text).toBe(bodyText);
      }
      state.accountId = "account_b";
      expect((await getDetail(request(), path(f.reviewId))).status).toBe(404);
      expect((await getQa(request(), path(f.reviewId))).status).toBe(404);
      expect((await citation(f.reviewId, f.refs[0]!)).status).toBe(404);
      state.accountId = accountId;
      const lateQa = f.service.askQa(accountId, f.reviewId, {
        question: "本周进度？", operationKey: "late_question",
        expectedVersion: f.service.getQa(accountId, f.reviewId)!.thread.version
      });
      const qaFence = f.repository.claimQaRun({ accountId, runId: lateQa.run.id,
        leaseOwner: "late_qa", leaseMs: 60_000 });
      const lateGeneration = f.service.regenerate(accountId, f.reviewId, {
        operationKey: "late_generation", expectedVersion: f.repository.getReview(accountId, f.reviewId).version
      });
      const generationFence = f.repository.claimGenerationRun({ accountId, runId: lateGeneration.run.id,
        leaseOwner: "late_generation", leaseMs: 60_000 });
      for (const [index, source] of f.sources.entries()) {
        if (mode === "meeting_delete") {
          f.meetings.deleteMeeting({ accountId, meetingId: source.meetingId,
            linkedTodoPolicy: "delete_linked_todos" });
        } else if (mode === "scope_unlink") {
          f.projects.setMeetingProjects({ accountId, meetingId: source.meetingId, projectIds: [],
            operationKey: `unlink_${index}`,
            expectedVersion: f.meetings.getMeeting(accountId, source.meetingId).version });
        } else {
          // Fixture-only revocation of the existing canonical authority, no alternate source store.
          f.database.prepare(`UPDATE wr_canonical_publications SET tombstoned_at = ?
            WHERE account_id = ? AND publication_id = ?`).run(new Date().toISOString(), accountId, source.publicationId);
        }
        const current = await detail(f.reviewId);
        if (needsReview) {
          expect(current.displayedGeneration).toMatchObject({ qualityStatus: "needs_review",
            reviewIssues: [{ sourceRef: null, reasonCode: "source_unavailable" }] });
          expect(JSON.stringify(current.displayedGeneration)).not.toContain(f.snapshot.findings[0]!.sourceRef);
        }
        const item = current.items.find((value) => value.id === f.item.id)!;
        const qaResponse = await getQa(request(), path(f.reviewId));
        expect(qaResponse.status).toBe(200);
        const qa = await qaResponse.json() as NonNullable<ReturnType<WorkWeeklyService["getQa"]>>;
        const answer = qa.messages.find((value) => value.id === f.answer.id)!;
        const survivingRefs = f.refs.slice(index + 1).sort();
        expect(item.sourceRefs).toEqual(survivingRefs);
        expect(answer.sourceRefs).toEqual(survivingRefs);
        expect((await citation(f.reviewId, f.refs[index]!)).status).toBe(404);
        if (survivingRefs.length) {
          expect(item).toMatchObject({ userText: editText, systemText: bodyText,
            userEditedAt: f.item.userEditedAt, invalidatedAt: null, hiddenAt: null,
            verificationState: "qualified", version: f.item.version + 1 });
          expect(answer).toMatchObject({ text: bodyText, answerStatus: "answered",
            invalidatedAt: null, version: f.answer.version + 1 });
          expect((await citation(f.reviewId, survivingRefs[0]!)).status).toBe(200);
          const repeat = await detail(f.reviewId);
          expect(repeat.items.find((value) => value.id === item.id)).toEqual(item);
          const staleEdit = await editItem(request("PATCH", { operationKey: "stale_edit",
            expectedVersion: f.item.version, text: "stale" }), {
            params: Promise.resolve({ weeklyReviewId: f.reviewId, itemId: item.id }) });
          expect(staleEdit.status).toBe(409);
        } else {
          expect(item).toMatchObject({ userText: null, verificationState: "invalidated",
            systemText: "来源已失效，内容不可用" });
          expect(item.hiddenAt).not.toBeNull();
          expect(answer).toMatchObject({ text: null, answerStatus: "invalidated" });
        }
      }
      expect(() => f.repository.publishSystemVersion({ accountId, fence: generationFence,
        currentSnapshot: f.snapshot, items: [{ section: "progress", text: bodyText, sourceRefs: f.refs,
          verificationState: "qualified", sortOrder: 0 }], synthesizerProfile: "fixture", verifierProfile: "fixture",
        qualityAssessment: { status: "needs_review", reviewIssues: [
          { sourceRef: f.snapshot.findings[0]!.sourceRef, reasonCode: "missing_key_content" }
        ] }
      })).toThrow();
      expect(() => f.repository.publishQaAnswer({ accountId, fence: qaFence,
        currentSnapshot: f.snapshot, text: bodyText, answerStatus: "answered", sourceRefs: f.refs,
        providerProfile: "fixture", verifierProfile: "fixture", promptVersion: "fixture"
      })).toThrow();
      expect(f.provider).toHaveBeenCalledTimes(4);
    }
  );

  it("preserves the edited system version through regenerate until an explicit versioned reset", async () => {
    const f = await fixture();
    const before = f.repository.getReview(accountId, f.reviewId);
    const regenerated = f.service.regenerate(accountId, f.reviewId, {
      operationKey: "regenerate", expectedVersion: before.version
    });
    expect((await f.runGeneration(regenerated.run)).state).toBe("published");
    const current = await detail(f.reviewId);
    expect(current.review.currentSystemVersion).toBe(2);
    expect(current.items.find((value) => value.id === f.item.id)).toEqual(f.item);
    const payload = { operationKey: "explicit_reset", expectedVersion: current.review.version };
    expect((await reset(request("POST", { ...payload, expectedVersion: before.version }), path(f.reviewId))).status)
      .toBe(409);
    expect((await reset(request("POST", payload), path(f.reviewId))).status).toBe(200);
    const resetDetail = await detail(f.reviewId);
    expect(resetDetail.items.some((value) => value.id === f.item.id)).toBe(false);
    expect(resetDetail.items.every((value) => value.systemVersion === 2 && value.userText === null)).toBe(true);
    expect((await reset(request("POST", payload), path(f.reviewId))).status).toBe(200);
    expect((await detail(f.reviewId)).review.version).toBe(resetDetail.review.version);
  });
});
