// @vitest-environment node

import type Database from "better-sqlite3";
import type OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkWeeklyRun, WorkWeeklySourceSnapshot } from "@/lib/domain/work-weekly";
import { openWorkReviewDatabase } from "./db";
import { WorkTodoRepository } from "./todo-repository";
import { WorkWeeklyService } from "./weekly-service";
import { createConfiguredWorkWeeklyRunExecutor } from "./weekly-ai-runner";
import { buildWorkWeeklySynthesisResponseSchema, workWeeklyCompletionClaimSupported } from "./weekly-ai-provider";

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
  items: Array<{ claim: { id: string; text: string; sourceRefs: string[] }; sources: Array<{ sourceRef: string; sourceKind: string }> }>;
};

let db: Database.Database;
let now: string;
let service: WorkWeeklyService;
let todoRepository: WorkTodoRepository;
let snapshot: WorkWeeklySourceSnapshot;
let answer: unknown;
let claimText: string;
let requests: WireRequest[];

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
  return { items: [{ id: "draft", section, text: "待办系统状态变化", itemType: "evidence_backed_fact",
    claims: [{ id: "state_change", text, claimType: "fact", sourceRefs: sourceRefs() }] }] };
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
    return fixtureStream({ items: [{ claimId: claim.id, verdict: "entailed", issueCodes: [], supportedSourceRefs: claim.sourceRefs }],
      disputes: [], coverage: sourceRefs().map((sourceRef) => ({ sourceRef, status: "covered", reasonCode: "covered", claimIds: [claim.id], matches: [] })) });
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

  it("accepts equivalent system-state wording with 标记为完成 in the completed section", async () => {
    claimText = `待办“${title}”在系统中标记为完成后重新打开，当前系统状态为未完成；这些操作不证明实际交付。`;
    answer = generated(claimText, "completed");
    const queued = service.generate(accountId, { ...scope, operationKey: "generate_completion_wording", expectedVersion: null });
    expect(await run(queued.run)).toMatchObject({ state: "published" });
    expect(requests).toHaveLength(2);
    expect(service.getDetail(accountId, queued.review.id).items[0]).toMatchObject({ systemText: claimText });
  });

  it.each([
    ["negated state", "待办在系统中标记为未完成。"],
    ["real-world completion", "待办已经实际完成并交付。"],
    ["promoted system event", "待办在系统中标记为完成，因此实际交付了任务。"],
    ["outside week", "待办上周在系统中标记为完成。"]
  ])("still rejects %s in completed even with a real current-week completion reference", (_reason, text) => {
    expect(workWeeklyCompletionClaimSupported(snapshot, sourceRefs(), text)).toBe(false);
    expect(buildWorkWeeklySynthesisResponseSchema(snapshot).safeParse(generated(text, "completed")).success).toBe(false);
  });

  it("does not let wording replace a cited current-week completion event", () => {
    const text = "待办在系统中标记为完成。";
    const unrelatedRefs = [snapshot.todos[0]!.sourceRef, snapshot.todoEvents[1]!.sourceRef];
    expect(workWeeklyCompletionClaimSupported(snapshot, unrelatedRefs, text)).toBe(false);
    const noEvents = { ...snapshot, todoEvents: [] };
    expect(workWeeklyCompletionClaimSupported(noEvents, sourceRefs(), text)).toBe(false);
    const previousWeek = { ...snapshot, todoEvents: snapshot.todoEvents.map((event) => ({ ...event, localDate: "2026-09-13" })) };
    expect(workWeeklyCompletionClaimSupported(previousWeek, sourceRefs(), text)).toBe(false);
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
          : { items: [{ ...value.items[0], claims: [{ ...value.items[0]!.claims[0], sourceRefs: null }] }] };
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
