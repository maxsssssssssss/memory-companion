// @vitest-environment node

import type Database from "better-sqlite3";
import type OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkWeeklyRun, WorkWeeklySourceSnapshot } from "@/lib/domain/work-weekly";
import { openWorkReviewDatabase } from "./db";
import { WorkTodoRepository } from "./todo-repository";
import { WorkWeeklyService } from "./weekly-service";
import { createConfiguredWorkWeeklyRunExecutor } from "./weekly-ai-runner";
import { adaptWorkWeeklyModelResponse, workWeeklyCompletionClaimSupported } from "./weekly-ai-provider";

const transport = vi.hoisted(() => ({ createClient: vi.fn(), runtimeConfig: vi.fn() }));
vi.mock("@/lib/server/openai/client", () => ({ createOpenAIClient: transport.createClient }));
vi.mock("@/lib/server/settings/provider-config", () => ({ getOpenAIClientRuntimeConfig: transport.runtimeConfig }));

const accountId = "weekly_todos_only_account";
const scope = { weekStart: "2026-09-14", timeZone: "Asia/Shanghai", scopeKind: "all" as const, projectId: null };
const title = "检查合成待办样例";
const baseURL = "https://tokenhub.vision-intelligence.tech/v1";
const env = {
  WORK_REVIEW_WEEKLY_SYNTHESIZER_MODEL: "deepseek-v4-pro",
  WORK_REVIEW_WEEKLY_VERIFIER_MODEL: "deepseek-v4-pro",
  WORK_REVIEW_WEEKLY_SYNTHESIZER_REASONING_EFFORT: "none",
  WORK_REVIEW_WEEKLY_VERIFIER_REASONING_EFFORT: "none",
  WORK_REVIEW_WEEKLY_QA_ENABLED: "false"
};

type WireRequest = { input: Array<{ role: string; content: string }>; stream: boolean; model: string };
type VerifierPack = {
  verificationContract: { expectedClaimIds: string[]; expectedVerdictCount: number; expectedCoverageSourceRefs: string[] };
  items: Array<{ claim: { id: string; text: string; sourceRefs: string[] }; sources: Array<{ sourceRef: string; sourceKind: string }>;
    publicationContext: { section: string } }>;
};

let db: Database.Database;
let now: string;
let service: WorkWeeklyService;
let todoRepository: WorkTodoRepository;
let snapshot: WorkWeeklySourceSnapshot;
let answer: unknown;
let claimText: string;
let requests: WireRequest[];
let verifierWithoutSupport: boolean;
let verifierIssue: string | null;

function fixtureStream(value: unknown) {
  const event = { type: "response.completed", response: {
    status: "completed", error: null, incomplete_details: null,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] }]
  } };
  return { async asResponse() {
    return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } };
}

function sourceRefs() {
  return [snapshot.todos[0]!.sourceRef, ...snapshot.todoEvents.map((event) => event.sourceRef)];
}

function generated(text: string, section = "overview") {
  return { items: [{ section, text, claimType: "fact", isInterpretation: false, sourceRefs: sourceRefs() }] };
}

beforeEach(() => {
  db = openWorkReviewDatabase({ filePath: ":memory:" });
  now = "2026-09-13T01:00:00.000Z";
  todoRepository = new WorkTodoRepository(db, { now: () => now });
  const created = todoRepository.createManualTodo({ accountId, operationKey: "create_synthetic_todo", title,
    kind: "self", notes: null, ownerLabel: null, currentDueDate: null, isImportant: false, myDayDate: null }).todo;
  now = "2026-09-14T00:01:00.000Z";
  const completed = todoRepository.completeTodo({ accountId, todoId: created.id,
    expectedVersion: created.version, operationKey: "complete_synthetic_todo" }).todo;
  now = "2026-09-14T00:02:00.000Z";
  todoRepository.reopenTodo({ accountId, todoId: created.id,
    expectedVersion: completed.version, operationKey: "reopen_synthetic_todo" });
  now = "2026-09-14T00:10:00.000Z";
  service = new WorkWeeklyService(db, { now: () => new Date(now) });
  snapshot = service.buildSnapshot(accountId, scope);
  claimText = `待办“${title}”在系统中标记完成后重新打开，当前系统状态为未完成；这些操作不证明实际交付。`;
  answer = generated(claimText);
  requests = [];
  verifierWithoutSupport = false;
  verifierIssue = null;
  transport.createClient.mockReset();
  transport.runtimeConfig.mockReset().mockResolvedValue({});
  const client = { baseURL, withOptions: vi.fn(), responses: { create: vi.fn((request: WireRequest) => {
    requests.push(request);
    const user = JSON.parse(request.input.find((message) => message.role === "user")!.content) as VerifierPack;
    if (!user.verificationContract) return fixtureStream(answer);
    // Fixed synthetic oracle. This proves control flow and contracts, not new model semantics.
    expect(user.items).toHaveLength(1);
    const claim = user.items[0]!.claim;
    expect(claim.text).toBe(claimText);
    expect(claim.sourceRefs).toEqual(sourceRefs());
    expect(user.items[0]!.sources.map((source) => source.sourceKind).sort()).toEqual(["todo", "todo_event", "todo_event"]);
    expect(user.verificationContract.expectedClaimIds).toEqual([claim.id]);
    return fixtureStream({ items: [{ claimId: claim.id, verdict: verifierIssue ? "contradicted" : verifierWithoutSupport ? "partial_entailed" : "entailed",
      issueCodes: verifierIssue ? [verifierIssue] : verifierWithoutSupport ? ["missing_qualification"] : [],
      supportedSourceRefs: verifierWithoutSupport || verifierIssue ? [] : claim.sourceRefs }],
      disputes: verifierIssue ? [{ claimId: claim.id, issueCode: verifierIssue, claimExcerpt: claim.text, explanation: "合成核验：所述状态、时间或实际交付没有该事件支持。" }] : [],
      coverage: sourceRefs().map((sourceRef) => ({ sourceRef, status: verifierIssue ? "omitted" : "covered",
        reasonCode: verifierIssue ? "missing_key_content" : "covered", claimIds: verifierIssue ? [] : [claim.id], matches: [] })) });
  }) } };
  client.withOptions.mockReturnValue(client);
  transport.createClient.mockReturnValue(client as unknown as OpenAI);
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

function executor() {
  return createConfiguredWorkWeeklyRunExecutor({ repository: service.runtimeRepository(), env,
    loadSnapshot: ({ accountId: requestedAccount }) => service.buildSnapshot(requestedAccount, scope) });
}

function run(run: WorkWeeklyRun) {
  return executor().runGeneration({ accountId, weeklyReviewId: run.weeklyReviewId, runId: run.id,
    runVersion: run.runVersion, sourceSnapshotDigest: run.sourceSnapshotDigest,
    leaseOwner: "synthetic_worker", leaseMs: 600_000, observedState: "queued" });
}

describe("Work Weekly minimal Todo-only generation through Responses and SQLite", () => {
  it("publishes a valid reopened Todo without meetings, Findings, Canonical Evidence or projects", async () => {
    expect(snapshot.summary).toMatchObject({ meetingCount: 0, findingCount: 0, todoCount: 1,
      todoEventCount: 2, evidenceCount: 0, projectCount: 0, truncated: false, historyCompleteness: "exact" });
    expect(snapshot.todoEvents.map((event) => event.eventType)).toEqual(["todo.completed", "todo.reopened"]);
    const queued = service.generate(accountId, { ...scope, operationKey: "generate_minimal", expectedVersion: null });
    expect(await run(queued.run)).toMatchObject({ state: "published" });
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.stream && request.model === "deepseek-v4-pro")).toBe(true);
    for (const request of requests) {
      expect(request.input[0]!.content).toContain("JSON 根对象必须包含 items 字段");
      expect(request.input[0]!.content).not.toContain("JSON 根对象必须包含 results 字段");
    }
    const pack = JSON.parse(requests[0]!.input.find((message) => message.role === "user")!.content);
    expect(pack.sources.map((source: { sourceKind: string }) => source.sourceKind).sort()).toEqual(["todo", "todo_event", "todo_event"]);
    expect(pack.generationContract.currentWeekCompletionSourceRefs).toEqual([snapshot.todoEvents[0]!.sourceRef]);
    const detail = service.getDetail(accountId, queued.review.id);
    expect(detail.latestGeneration).toMatchObject({ executionStatus: "completed", qualityStatus: "passed" });
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]).toMatchObject({ systemText: claimText, verificationState: "verified" });
  });

  it.each(["progress", "in_progress"])("verifies and saves a recovered %s state summary as overview", async (section) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    answer = generated(claimText, section);
    const queued = service.generate(accountId, { ...scope, operationKey: "normalize_todo_state_section", expectedVersion: null });
    expect(await run(queued.run)).toMatchObject({ state: "published" });
    expect(requests).toHaveLength(2);
    const verifierPack = JSON.parse(requests[1]!.input.find((message) => message.role === "user")!.content) as VerifierPack;
    expect(verifierPack.items[0]!.publicationContext.section).toBe("overview");
    const detail = service.getDetail(accountId, queued.review.id);
    expect(detail.latestGeneration).toMatchObject({ executionStatus: "completed", qualityStatus: "passed" });
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]).toMatchObject({ section: "overview", systemText: claimText, verificationState: "verified" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("still verifies actual activity claims after recovering their section", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    claimText = "检查人员本周已经实际开始核对清单。";
    answer = generated(claimText, "in_progress");
    verifierIssue = "source_does_not_support_claim";
    const queued = service.generate(accountId, { ...scope, operationKey: "verify_activity_after_normalization", expectedVersion: null });
    expect(await run(queued.run)).toMatchObject({ state: "failed", errorCode: "weekly_generation_no_safe_items" });
    expect(requests).toHaveLength(2);
    expect(service.getDetail(accountId, queued.review.id).items).toEqual([]);
  });

  it.each([
    `待办“${title}”在系统中标记为完成后重新打开，当前系统状态为未完成；这些操作不证明实际交付。`,
    `系统已把待办“${title}”标为完成，随后又重新打开；当前为未完成，实际交付另需核对。`,
    `本周曾勾选完成待办“${title}”，随后撤销了完成状态；仅代表清单中的状态变化。`,
    `上周创建的待办“${title}”，本周在应用内标成完成后重新打开；没有实际履行证据。`
  ])("publishes verified system-state paraphrases through SSE and SQLite: %s", async (text) => {
    claimText = text;
    answer = generated(claimText, "completed");
    const queued = service.generate(accountId, { ...scope, operationKey: "generate_completion_wording", expectedVersion: null });
    expect(await run(queued.run)).toMatchObject({ state: "published" });
    expect(requests).toHaveLength(2);
    expect(service.getDetail(accountId, queued.review.id).items[0]).toMatchObject({ systemText: claimText });
  });

  it.each([
    ["contradictory current state", "待办已经完成，目前没有重新打开。", "source_does_not_support_claim"],
    ["real-world completion", "待办已经实际完成并交付。", "todo_state_not_real_world_completion"],
    ["promoted system event", "待办在系统中标记为完成，因此实际交付了任务。", "todo_state_not_real_world_completion"],
    ["outside week", "待办上周在系统中标记为完成。", "source_does_not_support_claim"]
  ])("rejects %s at semantic verification without publishing it", async (_reason, text, issue) => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    claimText = text; verifierIssue = issue; answer = generated(text, "completed");
    expect(workWeeklyCompletionClaimSupported(snapshot, sourceRefs())).toBe(true);
    expect(adaptWorkWeeklyModelResponse({ snapshot, response: answer })).toHaveLength(1);
    const queued = service.generate(accountId, { ...scope, operationKey: "verify_completion_semantics", expectedVersion: null });
    expect(await run(queued.run)).toMatchObject({ state: "failed", errorCode: "weekly_generation_no_safe_items" });
    expect(requests).toHaveLength(2);
    expect(service.getDetail(accountId, queued.review.id).items).toEqual([]);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ stage: "publication",
      publishableItemCount: 0, rejectionReasons: { verifier_contradicted: 1 } });
    expect(JSON.stringify(log.mock.calls)).not.toContain(text);
  });

  it("does not let wording replace a cited current-week completion event", () => {
    const text = "待办在系统中标记为完成。";
    const unrelatedRefs = [snapshot.todos[0]!.sourceRef, snapshot.todoEvents[1]!.sourceRef];
    expect(workWeeklyCompletionClaimSupported(snapshot, unrelatedRefs)).toBe(false);
    const noEvents = { ...snapshot, todoEvents: [] };
    expect(workWeeklyCompletionClaimSupported(noEvents, sourceRefs())).toBe(false);
    const previousWeek = { ...snapshot, todoEvents: snapshot.todoEvents.map((event) => ({ ...event, localDate: "2026-09-13" })) };
    expect(workWeeklyCompletionClaimSupported(previousWeek, sourceRefs())).toBe(false);
    expect(() => adaptWorkWeeklyModelResponse({ snapshot: previousWeek, response: generated(text, "completed") }))
      .toThrow("work_weekly_synthesizer_output_invalid");
  });

  it("publishes after duplicate citations are normalized through the actual adapter and in-memory repository", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const wire = generated(claimText); wire.items[0]!.sourceRefs.push(...sourceRefs()); answer = wire;
    const queued = service.generate(accountId, { ...scope, operationKey: "deduplicate_sources", expectedVersion: null });
    expect(await run(queued.run)).toMatchObject({ state: "published" });
    expect(requests).toHaveLength(2);
    expect(service.getDetail(accountId, queued.review.id).items[0]).toMatchObject({ systemText: claimText });
  });

  it.each([false, true])("never publishes zero-safe-item recovery and preserves any old version: previous=%s", async (previous) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const initial = service.generate(accountId, { ...scope, operationKey: "generate_before_empty_verification", expectedVersion: null });
    if (previous) {
      expect(await run(initial.run)).toMatchObject({ state: "published" });
      const detail = service.getDetail(accountId, initial.review.id);
      service.updateItem(accountId, initial.review.id, detail.items[0]!.id, { expectedVersion: detail.items[0]!.version,
        operationKey: "preserve_edit_before_empty_verification", text: "用户补充：核对系统状态，不推断实际交付。" });
    }
    const before = service.getDetail(accountId, initial.review.id);
    const pending = previous ? service.regenerate(accountId, initial.review.id, {
      expectedVersion: before.review.version, operationKey: "regenerate_without_safe_verdicts"
    }).run : initial.run;
    verifierWithoutSupport = true;
    expect(await run(pending)).toMatchObject({ state: "failed", errorCode: "weekly_generation_no_safe_items" });
    const after = service.getDetail(accountId, initial.review.id);
    expect(after.items).toEqual(before.items);
    expect(after.displayedGeneration).toEqual(before.displayedGeneration);
    expect(after.review.currentSystemVersion).toBe(previous ? 1 : 0);
    expect(after.latestGeneration).toMatchObject({ executionStatus: "failed", displayingPreviousVersion: previous,
      errorCode: "weekly_generation_no_safe_items" });
    expect(requests).toHaveLength(previous ? 4 : 2);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it.each(["missing_items", "unknown_field", "invalid_refs"] as const)(
    "keeps the published version and user edit after a strict %s response failure", async (failure) => {
      const initial = service.generate(accountId, { ...scope, operationKey: "generate_before_failure", expectedVersion: null });
      expect(await run(initial.run)).toMatchObject({ state: "published" });
      const initialDetail = service.getDetail(accountId, initial.review.id);
      const item = initialDetail.items[0]!;
      service.updateItem(accountId, initial.review.id, item.id, {
        expectedVersion: item.version, operationKey: "keep_user_edit", text: "用户补充：仍需自己核对待办状态。"
      });
      const before = service.getDetail(accountId, initial.review.id);
      const value = generated(claimText);
      answer = failure === "missing_items" ? { results: [] }
        : failure === "unknown_field" ? { items: [{ ...value.items[0], unsupported: "SYNTHETIC_PRIVATE_VALUE" }] }
          : { items: [{ ...value.items[0], sourceRefs: null }] };
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const next = service.regenerate(accountId, initial.review.id, { expectedVersion: before.review.version,
        operationKey: `regenerate_${failure}` });
      const result = await run(next.run);
      expect(result).toMatchObject({ state: "failed", errorCode: "work_weekly_provider_schema_invalid" });
      expect(requests).toHaveLength(3); // two initial calls, one failed synthesis, no verifier or retry
      const after = service.getDetail(accountId, initial.review.id);
      expect(after.items).toEqual(before.items);
      expect(after.displayedGeneration).toEqual(before.displayedGeneration);
      expect(after.review.currentSystemVersion).toBe(before.review.currentSystemVersion);
      expect(after.latestGeneration).toMatchObject({ executionStatus: "failed", displayingPreviousVersion: true,
        errorCode: "work_weekly_provider_schema_invalid" });
      const diagnostics = log.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(diagnostics).toContain('"validationResult":"failed"');
      expect(diagnostics).not.toContain("SYNTHETIC_PRIVATE_VALUE");
      expect(diagnostics).not.toContain(claimText);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    }
  );
});
