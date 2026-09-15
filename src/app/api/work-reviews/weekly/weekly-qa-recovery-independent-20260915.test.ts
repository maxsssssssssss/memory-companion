// @vitest-environment node
// Independent local acceptance. All content is synthetic; the production request
// constructor and SQLite/API path run, while Responses transport never connects.
import type Database from "better-sqlite3";
import OpenAI from "openai";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkTodoSchema } from "@/lib/domain/work-todo";
import { WorkMeetingCandidateStructuredDataSchema } from "@/lib/domain/work-review";
import type { WorkWeeklyQaRun } from "@/lib/domain/work-weekly";
import { openWorkReviewDatabase } from "@/lib/server/work-review/db";
import { WorkProjectRepository } from "@/lib/server/work-review/project-repository";
import { WorkReviewRepository } from "@/lib/server/work-review/repository";
import { WorkWeeklyService } from "@/lib/server/work-review/weekly-service";
import { createConfiguredWorkWeeklyRunExecutor } from "@/lib/server/work-review/weekly-ai-runner";
import { answerWorkWeeklyQuestion, createConfiguredWorkWeeklyQaProviders } from "@/lib/server/work-review/weekly-qa-provider";
import { POST as createTodo } from "../todos/route";
import { PATCH as editTodo } from "../todos/[todoId]/route";
import { POST as completeTodo } from "../todos/[todoId]/complete/route";
import { POST as reopenTodo } from "../todos/[todoId]/reopen/route";
import { POST as addMyDay, DELETE as removeMyDay } from "../todos/[todoId]/my-day/route";
import { GET as getQa, POST as askQa, DELETE as clearQa } from "./[weeklyReviewId]/qa/route";
import { GET as getSource } from "./[weeklyReviewId]/sources/[sourceRef]/route";

const state = vi.hoisted(() => ({ database: null as Database.Database | null,
  accountId: "independent_qa_account", sequence: 0, client: vi.fn(), config: vi.fn(),
  network: vi.fn(() => { throw new Error("offline_network_forbidden"); }) }));
vi.mock("@/lib/server/auth/request-context", () => ({
  requireAuthContext: async () => ({ user: { id: state.accountId } }), isUnauthenticatedError: () => false
}));
vi.mock("@/lib/server/work-review/db", async (original) => ({
  ...await original<typeof import("@/lib/server/work-review/db")>(), getWorkReviewDatabase: () => state.database!
}));
vi.mock("@/lib/server/openai/client", () => ({ createOpenAIClient: state.client }));
vi.mock("@/lib/server/settings/provider-config", () => ({ getOpenAIClientRuntimeConfig: state.config }));
vi.mock("node:crypto", async (original) => ({ ...await original<typeof import("node:crypto")>(),
  randomUUID: () => `00000000-0000-4000-8000-${String(++state.sequence).padStart(12, "0")}` }));

const accountId = "independent_qa_account";
const bodyText = "成员甲确认会检查发布清单。";
const scope = { weekStart: "2026-09-14", timeZone: "Asia/Shanghai", scopeKind: "all" as const, projectId: null };
const title = "核对匿名验收清单";
const answerText = `待办“${title}”在系统中标记完成后重新打开，目前系统状态为未完成；不代表实际交付。`;
const env = Object.fromEntries(["SYNTHESIZER", "VERIFIER", "QA_ANSWERER", "QA_VERIFIER"].flatMap(role => [
  [`WORK_REVIEW_WEEKLY_${role}_MODEL`, "deepseek-v4-pro"],
  [`WORK_REVIEW_WEEKLY_${role}_REASONING_EFFORT`, "none"]
]));
type Wire = { input: Array<{ role: string; content: string }>; stream: boolean; model: string };
let requests: Wire[];
let responses: Array<unknown | ((packet: Wire) => unknown)>;
let service: WorkWeeklyService;
const request = (method = "GET", body?: unknown) => new Request("http://localhost/offline-fixture", {
  method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
});
const path = (weeklyReviewId: string) => ({ params: Promise.resolve({ weeklyReviewId }) });
const todoPath = (todoId: string) => ({ params: Promise.resolve({ todoId }) });
const time = (stamp: string) => vi.setSystemTime(new Date(stamp));

beforeEach(() => {
  state.accountId = accountId; state.sequence = 0; requests = []; responses = [];
  state.network.mockClear(); state.client.mockReset(); state.config.mockReset().mockResolvedValue({});
  vi.stubGlobal("fetch", state.network);
  vi.useFakeTimers({ toFake: ["Date"] }); time("2026-09-13T01:00:00.000Z");
  for (const flag of ["WORK_REVIEW_ENABLED", "WORK_REVIEW_TODO_ENABLED", "WORK_REVIEW_PROJECTS_ENABLED",
    "WORK_REVIEW_WEEKLY_ENABLED", "WORK_REVIEW_WEEKLY_AI_ENABLED", "WORK_REVIEW_WEEKLY_VERIFIER_ENABLED",
    "WORK_REVIEW_WEEKLY_QA_ENABLED", "WORK_REVIEW_WEEKLY_QA_VERIFIER_ENABLED"]) vi.stubEnv(flag, "true");
  state.database = openWorkReviewDatabase({ filePath: ":memory:" });
  service = new WorkWeeklyService(state.database);
  const client = { baseURL: "https://tokenhub.vision-intelligence.tech/v1", withOptions: vi.fn(),
    responses: { create: vi.fn((packet: Wire) => {
      requests.push(packet);
      if (!responses.length) throw new Error("unexpected_offline_completion");
      const next = responses.shift();
      return { async asResponse() {
        const value = await (typeof next === "function" ? next(packet) : next);
        const event = { type: "response.completed", response: { status: "completed", error: null,
          incomplete_details: null, output: [{ type: "message", role: "assistant",
            content: [{ type: "output_text", text: JSON.stringify(value) }] }] } };
        return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
      } };
    }) } };
  client.withOptions.mockReturnValue(client); state.client.mockReturnValue(client as unknown as OpenAI);
});
afterEach(() => {
  expect(state.database!.pragma("foreign_key_check")).toEqual([]);
  state.database?.close(); state.database = null;
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  expect(state.network).not.toHaveBeenCalled();
});

async function apiTodo() {
  const response = await createTodo(request("POST", { title, kind: "self", operationKey: "create_todo" }));
  expect(response.status).toBe(201);
  return WorkTodoSchema.parse((await response.json()).todo);
}
async function ordinaryHistory() {
  let todo = await apiTodo();
  time("2026-09-14T01:00:00.000Z");
  const mutations = [
    [editTodo, "PATCH", { title: `${title}（修订）`, isImportant: true, myDayDate: "2026-09-14" }],
    [editTodo, "PATCH", { title, isImportant: false, myDayDate: null }],
    [addMyDay, "POST", { day: "2026-09-14" }],
    [removeMyDay, "DELETE", {}], [completeTodo, "POST", {}], [reopenTodo, "POST", {}]
  ] as const;
  for (const [index, [route, method, fields]] of mutations.entries()) {
    time(`2026-09-14T01:0${index}:00.000Z`);
    const response = await route(request(method, { ...fields, expectedVersion: todo.version,
      operationKey: `mutation_${index}` }), todoPath(todo.id));
    expect(response.status).toBe(200);
    todo = WorkTodoSchema.parse((await response.json()).todo);
  }
  time("2026-09-14T02:00:00.000Z");
  return todo;
}
function executor(qaDiagnosticSink?: Parameters<typeof createConfiguredWorkWeeklyRunExecutor>[0]["qaDiagnosticSink"]) {
  return createConfiguredWorkWeeklyRunExecutor({ env, repository: service.runtimeRepository(),
    loadSnapshot: ({ accountId: account }) => service.buildSnapshot(account, scope), qaDiagnosticSink });
}
async function queued(question = `本周${title}在系统中是什么状态？`) {
  let review = service.getByScope(accountId, scope).review;
  if (!review) {
    // Establish a published review through the real fence/publication repository;
    // the primary test above separately covers Synthesizer and Verifier transport.
    const snapshot = service.buildSnapshot(accountId, scope);
    const generation = service.generate(accountId, { ...scope, expectedVersion: null, operationKey: "prepare_review" });
    const repository = service.runtimeRepository();
    const fence = repository.claimGenerationRun({ accountId, runId: generation.run.id,
      leaseOwner: "independent_fixture_seed", leaseMs: 60_000 });
    repository.publishSystemVersion({ accountId, fence, currentSnapshot: snapshot,
      items: [{ section: "overview", text: "本周匿名来源记录。", verificationState: "verified", sortOrder: 0,
        sourceRefs: snapshot.allowlistedSourceRefs }], synthesizerProfile: "offline_seed", verifierProfile: "offline_seed" });
    review = service.getDetail(accountId, generation.review.id).review;
  }
  const response = await askQa(request("POST", { question, expectedVersion: null, operationKey: "ask" }), path(review.id));
  expect(response.status).toBe(202);
  const body = await response.json();
  return { review, run: body.run as WorkWeeklyQaRun };
}
function runQa(run: WorkWeeklyQaRun, qaDiagnosticSink?: Parameters<typeof executor>[0]) {
  return executor(qaDiagnosticSink).runQa({ accountId, weeklyReviewId: run.weeklyReviewId, threadId: run.threadId,
    questionMessageId: run.questionMessageId, runId: run.id, runVersion: run.runVersion,
    sourceSnapshotDigest: run.sourceSnapshotDigest, observedState: "queued", leaseOwner: "independent_worker", leaseMs: 600_000 });
}
function qaFixtures(refs: string[], text = answerText) {
  responses.push({ status: "answered", answer: text, claims: [{ id: "qa_claim", text, claimType: "fact", sourceRefs: refs }],
    relevantSourceRefs: refs });
  responses.push({ items: [{ claimId: "qa_claim", verdict: "entailed", issueCodes: [], supportedSourceRefs: refs }] });
}
async function persistedAnswer(reviewId: string, expectedText: string, refs: string[]) {
  const response = await getQa(request(), path(reviewId)); expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.messages.filter((message: { role: string }) => message.role === "assistant"))
    .toEqual([expect.objectContaining({ answerStatus: "answered", text: expectedText, sourceRefs: [...refs].sort() })]);
  for (const sourceRef of refs) {
    const source = await getSource(request(), { params: Promise.resolve({ weeklyReviewId: reviewId, sourceRef }) });
    expect(source.status).toBe(200);
    expect(await source.json()).toMatchObject({ identity: { sourceRef }, source: { sourceRef } });
  }
  return body;
}

describe("Independent QA recovery: real business APIs, SQLite, offline Responses", () => {
  it("rolls up ordinary edits plus complete/reopen, then publishes useful QA with live citations", async () => {
    await ordinaryHistory();
    const snapshot = service.buildSnapshot(accountId, scope);
    expect(snapshot.summary).toMatchObject({ todoCount: 1, meetingCount: 0, evidenceCount: 0, historyCompleteness: "exact" });
    expect(snapshot.todoEvents.map(event => event.eventType)).toEqual([
      "todo.updated", "todo.updated", "todo.added_to_my_day", "todo.removed_from_my_day", "todo.completed", "todo.reopened"
    ]);
    const refs = [snapshot.todos[0]!.sourceRef, ...snapshot.todoEvents.map(event => event.sourceRef)];
    responses.push({ items: ["completed", "in_progress"].map(section => ({ section, text: answerText,
      claimType: "fact", isInterpretation: false, sourceRefs: refs })) });
    responses.push((packet: Wire) => {
      const pack = JSON.parse(packet.input.find(message => message.role === "user")!.content);
      expect(pack.items).toHaveLength(1);
      const claim = pack.items[0].claim;
      expect(pack.items[0].publicationContext.section).toBe("overview");
      expect(new Set(claim.sourceRefs)).toEqual(new Set(refs));
      expect(claim.text).toContain("标记完成"); expect(claim.text).toContain("重新打开");
      expect(claim.text).toContain("未完成"); expect(claim.text).toContain("不代表实际交付");
      expect(claim.text).not.toMatch(/became important|priority changed to|today安排为|marked complete/iu);
      return { items: [{ claimId: claim.id, verdict: "entailed", issueCodes: [], supportedSourceRefs: refs }], disputes: [],
        coverage: refs.map(sourceRef => ({ sourceRef, status: "covered", reasonCode: "covered", claimIds: [claim.id], matches: [] })) };
    });
    const generation = service.generate(accountId, { ...scope, expectedVersion: null, operationKey: "generate" });
    expect(await executor().runGeneration({ accountId, weeklyReviewId: generation.review.id,
      runId: generation.run.id, runVersion: generation.run.runVersion, sourceSnapshotDigest: snapshot.digest,
      observedState: "queued", leaseOwner: "independent_worker", leaseMs: 600_000 })).toMatchObject({ state: "published" });
    expect(service.getDetail(accountId, generation.review.id).items).toEqual([
      expect.objectContaining({ section: "overview", verificationState: "verified", sourceRefs: expect.arrayContaining(refs) })
    ]);
    qaFixtures(refs);
    const { review, run } = await queued();
    const queuedDatabase = state.database!.serialize();
    expect(await runQa(run)).toMatchObject({ state: "published" });
    await persistedAnswer(review.id, answerText, refs);
    expect(requests).toHaveLength(4);
    expect(requests.every(packet => packet.stream && packet.model === "deepseek-v4-pro")).toBe(true);
    expect(requests[2]!.input[0]!.content).not.toContain("JSON 根对象必须包含 items 字段");
    expect(requests[2]!.input[0]!.content).not.toContain("JSON 根对象必须包含 results 字段");
    expect(requests[2]!.input[0]!.content).toContain("relevantSourceRefs");
    const preparationDir = process.env.WORK_WEEKLY_INDEPENDENT_OUTPUT_DIR;
    if (preparationDir) {
      mkdirSync(preparationDir, { recursive: true });
      writeFileSync(`${preparationDir}/synthetic-qa-queued.sqlite`, queuedDatabase);
      writeFileSync(`${preparationDir}/synthetic-real-validation-input.json`, JSON.stringify({
        evidence: "pure synthetic offline preparation, no real calls authorized or executed",
        frozenNow: "2026-09-14T02:00:00.000Z", snapshot, reviewId: review.id, queuedQaRun: run,
        databaseSha256: createHash("sha256").update(queuedDatabase).digest("hex"),
        publicEndpoint: "https://tokenhub.vision-intelligence.tech/v1/responses",
        roles: ["synthesizer", "verifier", "qa_answerer", "qa_verifier"].map((role, index) => ({ role,
          model: requests[index]!.model, request: requests[index],
          payloadSha256: createHash("sha256").update(JSON.stringify(requests[index])).digest("hex") })),
        proposedBudgets: { qaOnly: 2, newWeeklyThenQa: 4 },
        retry: 0, fallback: false, probe: 0, stopOnFailureOrUnknownOutcome: true
      }, null, 2));
    }
  });

  it("answers a static Todo without inventing in-week events", async () => {
    await apiTodo(); time("2026-09-14T02:00:00.000Z");
    const snapshot = service.buildSnapshot(accountId, scope);
    expect(snapshot.todoEvents).toEqual([]); expect(snapshot.summary.historyCompleteness).toBe("exact");
    const text = `待办“${title}”目前系统状态为未完成；本周没有状态变更记录。`;
    const refs = [snapshot.todos[0]!.sourceRef]; qaFixtures(refs, text);
    const { review, run } = await queued(); expect(await runQa(run)).toMatchObject({ state: "published" });
    await persistedAnswer(review.id, text, refs); expect(requests).toHaveLength(2);
  });

  it("captures actual SDK URLs and strict QA roots for the local gpt-5.5 fallback without network", async () => {
    await ordinaryHistory();
    const snapshot = service.buildSnapshot(accountId, scope);
    const refs = [snapshot.todos[0]!.sourceRef, ...snapshot.todoEvents.map(event => event.sourceRef)];
    const text = `待办“${title}”目前系统状态为未完成。`;
    const scenarios: Array<{ scope: string; calls: Array<{ url: string; body: Record<string, unknown> }> }> = [];
    // Public fields were read from the local environment separately. No private
    // persisted Provider settings or real credentials enter this SDK instance.
    for (const [label, baseURL, finalURL] of [
      ["current_public_environment_after_work_adapter", "http://tokenhub.vision-intelligence.tech", "https://tokenhub.vision-intelligence.tech/v1/responses"],
      ["explicit_canonical_base", "https://tokenhub.vision-intelligence.tech/v1", "https://tokenhub.vision-intelligence.tech/v1/responses"]
    ]) {
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const transport = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
        expect(options?.method).toBe("POST");
        const body = JSON.parse(String(options?.body)); calls.push({ url: String(url), body });
        const output = calls.length === 1 ? { status: "answered", answer: text,
          claims: [{ id: "gpt_qa_claim", text, claimType: "fact", sourceRefs: refs }], relevantSourceRefs: refs }
          : { items: [{ claimId: "gpt_qa_claim", verdict: "entailed", issueCodes: [], supportedSourceRefs: refs }] };
        return Response.json({ id: "synthetic_response", object: "response", model: "gpt-5.5", status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output) }] }] });
      });
      const sdk = new OpenAI({ apiKey: "offline-dummy-key-never-sent", baseURL, fetch: transport, maxRetries: 0 });
      const originalCreate = sdk.responses.create;
      state.client.mockReturnValue(sdk);
      const providers = createConfiguredWorkWeeklyQaProviders({ env: { OPENAI_QA_MODEL: "gpt-5.5" } });
      expect(providers.answerer.profile).toMatchObject({ model: "gpt-5.5", reasoningEffort: "provider_default" });
      expect(providers.verifier.profile.model).toBe("gpt-5.5");
      expect(await answerWorkWeeklyQuestion({ accountId, weeklyReviewId: "synthetic_profile_scope", snapshot,
        question: `本周${title}在系统中是什么状态？`, ...providers })).toMatchObject({ answerStatus: "answered", answer: text, sourceRefs: [...refs].sort() });
      expect(transport).toHaveBeenCalledTimes(2);
      expect(calls.map(call => call.url)).toEqual([finalURL, finalURL]);
      const first = calls[0]!.body.input as Array<{ role: string; content: string }>;
      expect(first[0]!.content).toContain("relevantSourceRefs");
      expect(first[0]!.content).not.toContain("JSON 根对象必须包含 items 字段");
      expect((calls[1]!.body.input as Array<{ content: string }>)[0]!.content).toContain("JSON 根对象必须包含 items 字段");
      expect(JSON.stringify(first)).toContain(refs[0]);
      expect(calls.every(call => call.body.model === "gpt-5.5" && call.body.stream === undefined)).toBe(true);
      expect(sdk.responses.create).toBe(originalCreate);
      scenarios.push({ scope: label!, calls });
    }
    if (process.env.WORK_WEEKLY_INDEPENDENT_OUTPUT_DIR) {
      mkdirSync(process.env.WORK_WEEKLY_INDEPENDENT_OUTPUT_DIR, { recursive: true });
      writeFileSync(`${process.env.WORK_WEEKLY_INDEPENDENT_OUTPUT_DIR}/gpt55-public-request-preparation.json`, JSON.stringify({
        evidence: "actual SDK local fetch interception; no external network; dummy credential omitted", scenarios, snapshotSummary: snapshot.summary,
        model: "gpt-5.5", roles: ["qa_answerer", "qa_verifier"], maximumFutureRequests: 2,
        retries: 0, fallback: false, probe: 0, authorizationActive: false,
        note: "The Work-owned adapter normalizes the public environment root to its secure versioned target. No real calls are authorized."
      }, null, 2));
    }
  });

  it("keeps true absence of sources deterministic with zero transport calls", async () => {
    time("2026-09-14T02:00:00.000Z");
    const snapshot = service.buildSnapshot(accountId, scope);
    expect(snapshot.allowlistedSourceRefs).toEqual([]);
    expect(() => service.generate(accountId, { ...scope, expectedVersion: null, operationKey: "empty" }))
      .toThrow("weekly_insufficient_sources");
    const providers = createConfiguredWorkWeeklyQaProviders({ env });
    const answer = await answerWorkWeeklyQuestion({ accountId, weeklyReviewId: "unpublished_empty_scope", snapshot,
      question: "本周系统里有哪些待办？", ...providers });
    expect(answer).toMatchObject({ answerStatus: "insufficient_evidence", sourceRefs: [] });
    expect(requests).toHaveLength(0);
  });

  it("uses confirmed Findings and Canonical Evidence while excluding pending and uncited material", async () => {
    time("2026-09-14T01:00:00.000Z");
    const project = new WorkProjectRepository(state.database!).createProject({ accountId,
      operationKey: "project", name: "匿名验收项目", description: null }).project;
    const repository = new WorkReviewRepository(state.database!);
    const accepted = seedMeeting(repository, project.id, 1);
    const pending = seedMeeting(repository, project.id, 2, false);
    time("2026-09-14T02:00:00.000Z");
    const snapshot = service.buildSnapshot(accountId, scope);
    expect(snapshot.findings.map(finding => finding.id)).toEqual([accepted.finding!.id]);
    expect(snapshot.evidence).toHaveLength(1);
    expect(snapshot.evidence[0]!.meetingId).toBe(accepted.meetingId);
    expect(JSON.stringify(snapshot)).not.toContain("UNCITED_FIXTURE");
    const refs = [snapshot.evidence[0]!.sourceRef]; qaFixtures(refs, bodyText);
    const { review, run } = await queued("本周发布清单有哪些已确认的承诺？");
    expect(await runQa(run)).toMatchObject({ state: "published" });
    await persistedAnswer(review.id, bodyText, refs);
    const source = await (await getSource(request(), { params: Promise.resolve({ weeklyReviewId: review.id, sourceRef: refs[0]! }) })).json();
    expect(source.identity.sourceKind).toBe("evidence"); expect(source.source.text).toBe(bodyText);
    const pack = JSON.parse(requests[0]!.input.find(message => message.role === "user")!.content);
    expect(JSON.stringify(pack)).not.toContain(pending.meetingId);
    expect(JSON.stringify(pack)).not.toContain("UNCITED_FIXTURE");
    state.accountId = "independent_other_account";
    expect((await getSource(request(), { params: Promise.resolve({ weeklyReviewId: review.id, sourceRef: refs[0]! }) })).status).toBe(404);
    expect(requests).toHaveLength(2);
  });

  it("a failing diagnostic sink cannot roll back a verified answer", async () => {
    await apiTodo(); time("2026-09-14T02:00:00.000Z");
    const refs = [service.buildSnapshot(accountId, scope).todos[0]!.sourceRef];
    qaFixtures(refs); const { review, run } = await queued();
    const sink = vi.fn(() => { throw new Error("synthetic_private_diagnostic_failure"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await runQa(run, sink)).toMatchObject({ state: "published" });
    await persistedAnswer(review.id, answerText, refs); expect(sink).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic_private_diagnostic_failure");
    expect(requests).toHaveLength(2);
  });

  it.each(["schema", "timeout", "foreign_ref", "verifier_schema"])("keeps %s technical failure out of no-evidence answers and does not retry", async kind => {
    await apiTodo(); time("2026-09-14T02:00:00.000Z");
    if (kind === "schema") responses.push({ unexpected: "synthetic_private_body" });
    if (kind === "timeout") responses.push(() => { throw Object.assign(new Error("synthetic_private_body"), { name: "TimeoutError" }); });
    if (kind === "foreign_ref") qaFixtures(["evidence:foreign_publication:foreign_segment"]);
    if (kind === "verifier_schema") {
      qaFixtures([service.buildSnapshot(accountId, scope).todos[0]!.sourceRef]);
      responses[1] = { unexpected: "synthetic_private_body" };
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { review, run } = await queued(); const result = await runQa(run);
    expect(result).toMatchObject({ state: "failed", errorCode: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain("synthetic_private_body");
    const body = await (await getQa(request(), path(review.id))).json();
    expect(body.messages.filter((message: { role: string }) => message.role === "assistant"))
      .toEqual([expect.objectContaining({ answerStatus: "failed", sourceRefs: [] })]);
    expect(body.messages.some((message: { answerStatus: string }) => message.answerStatus === "insufficient_evidence")).toBe(false);
    expect(state.database!.prepare("SELECT state, error_code FROM wr_weekly_qa_runs WHERE id = ?").get(run.id))
      .toMatchObject({ state: "failed", error_code: expect.any(String) });
    const expectedCalls = kind === "verifier_schema" ? 2 : 1;
    expect(requests).toHaveLength(expectedCalls);
    expect(await runQa(run)).toMatchObject({ state: "not_claimed" }); expect(requests).toHaveLength(expectedCalls);
    const logs = JSON.stringify([warn.mock.calls, error.mock.calls, info.mock.calls]);
    for (const privateValue of ["synthetic_private_body", title, "foreign_publication", "https://"]) expect(logs).not.toContain(privateValue);
  });

  it("an unsupported claim remains a completed insufficient-evidence answer", async () => {
    await apiTodo(); time("2026-09-14T02:00:00.000Z");
    const refs = [service.buildSnapshot(accountId, scope).todos[0]!.sourceRef];
    qaFixtures(refs);
    responses[1] = { items: [{ claimId: "qa_claim", verdict: "unsupported",
      issueCodes: ["source_does_not_support_claim"], supportedSourceRefs: [] }] };
    const { review, run } = await queued(); expect(await runQa(run)).toMatchObject({ state: "published" });
    const body = await (await getQa(request(), path(review.id))).json();
    expect(body.messages.at(-1)).toMatchObject({ answerStatus: "insufficient_evidence", sourceRefs: [] });
    expect(requests).toHaveLength(2);
  });

  it("rejects late publication after clear and isolates another account", async () => {
    await apiTodo(); time("2026-09-14T02:00:00.000Z");
    const refs = [service.buildSnapshot(accountId, scope).todos[0]!.sourceRef];
    qaFixtures(refs); const draft = responses.shift();
    let release!: () => void; let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    responses.unshift(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return draft; });
    const { review, run } = await queued(); const pending = runQa(run); await entered;
    state.accountId = "independent_other_account";
    expect((await getQa(request(), path(review.id))).status).toBe(404);
    state.accountId = accountId;
    const before = await (await getQa(request(), path(review.id))).json();
    expect((await clearQa(request("DELETE", { expectedVersion: before.thread.version, operationKey: "clear" }), path(review.id))).status).toBe(200);
    release(); expect(await pending).toMatchObject({ state: "failed" });
    const after = await (await getQa(request(), path(review.id))).json();
    expect(after === null || after.messages.length === 0).toBe(true);
    expect(await runQa(run)).toMatchObject({ state: "not_claimed" }); expect(requests.length).toBeLessThanOrEqual(2);
  });

  it("preserves the active lease and terminates unknown outcome without replaying transport", async () => {
    await apiTodo(); time("2026-09-14T02:00:00.000Z");
    const { review, run } = await queued();
    service.runtimeRepository().claimQaRun({ accountId, runId: run.id, leaseOwner: "prior_worker", leaseMs: 1_000 });
    expect(await runQa(run)).toMatchObject({ state: "not_claimed" });
    time("2026-09-14T02:00:02.000Z");
    expect(await executor().terminateQaUnknownOutcome({ accountId, weeklyReviewId: review.id, runId: run.id,
      runVersion: run.runVersion, sourceSnapshotDigest: run.sourceSnapshotDigest, threadId: run.threadId,
      questionMessageId: run.questionMessageId, leaseOwner: "recovery_worker", leaseMs: 60_000,
      observedState: "processing" })).toMatchObject({ state: "failed", errorCode: "weekly_qa_provider_outcome_unknown" });
    expect(requests).toEqual([]);
    expect(await runQa(run)).toMatchObject({ state: "not_claimed" });
  });
});

function seedMeeting(repository: WorkReviewRepository, projectId: string, index: number, confirm = true) {
  const meeting = repository.reserveMeeting({
    accountId, idempotencyKey: `upload_${index}`, contentHash: String(index).repeat(64),
    sourceUploadId: `upload_${index}`, title: `匿名会议 ${index}`,
    meetingDate: "2026-09-14", sourceDurationSeconds: 8, projectIds: [projectId]
  }).meeting;
  repository.publishSourceUpload({
    accountId, meetingId: meeting.id, uploadId: meeting.sourceUploadId,
    originalName: "fixture.wav", mimeType: "audio/wav", sizeBytes: 32,
    recordingDate: "2026-09-14", filePath: `fixture-${index}.wav`,
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
  if (!confirm) return { meetingId: meeting.id, finding: null, publicationId: canonical.publication.publicationId };
  const finding = repository.reviewCandidate({
    accountId, meetingId: meeting.id, candidateId: candidate!.id, action: "accept",
    expectedVersion: candidate!.version, operationKey: `confirm_${index}`
  }).finding!;
  return { meetingId: meeting.id, finding, publicationId: canonical.publication.publicationId };
}
