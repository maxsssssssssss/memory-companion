// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentTask } from "@/lib/domain/agent";
import type { ThinkingMatterView } from "@/lib/domain/reflection-thinking-matter";
import type { DailyReflectionThinkingSource } from "@/lib/domain/daily-reflection-thinking";
import { DailyReflectionWorkingCardSchema } from "@/lib/domain/daily-reflection-working-card";
import { openDailyReflectionDatabase } from "@/lib/server/daily-reflection/db";
import { ThinkingAgentService } from "@/lib/server/daily-reflection/thinking-agent";
import * as factory from "@/lib/server/daily-reflection/thinking-agent-service";
import { AgentFailure, type AgentDecision, type AgentDecisionProvider } from "@/lib/server/agent/types";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), enabled: vi.fn(() => true) }));
vi.mock("@/lib/server/auth/request-context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth/request-context")>("@/lib/server/auth/request-context");
  return { ...actual, requireAuthContext: mocks.auth };
});
vi.mock("@/lib/server/daily-reflection/runtime-config", () => ({ isDailyReflectionUploadEnabled: mocks.enabled }));

import { GET as list, POST as create } from "./route";
import { GET as get, POST as update } from "./[matterId]/route";

type View = ThinkingMatterView & { task?: AgentTask };
const url = "http://localhost/api/daily-reflections/thinking/matters";
let service: ThinkingAgentService;
let choose: ReturnType<typeof vi.fn<AgentDecisionProvider>>;
let forbiddenFetch: ReturnType<typeof vi.fn>;
let decision: AgentDecisionProvider;
let seq = 0;

function answer(reply: string, suggestion = "先做一个最小页面，看看真正卡在哪里。"): AgentDecision {
  return { tool: "respond", args: { reply, understanding: reply, judgments: ["待确认：当前困难的具体原因。"],
    suggestions: suggestion ? [{ text: suggestion, kind: "action" }] : [] } };
}

beforeEach(() => {
  seq = 0;
  mocks.auth.mockReset(); mocks.auth.mockResolvedValue({ user: { id: "account_a" } });
  mocks.enabled.mockReset(); mocks.enabled.mockReturnValue(true);
  forbiddenFetch = vi.fn(async () => { throw new Error("API acceptance is offline; network is forbidden"); });
  vi.stubGlobal("fetch", forbiddenFetch);
  choose = vi.fn<AgentDecisionProvider>(async input => {
    if (input.task.goal.includes("技术其实没问题")) return answer("技术已验证；我们改为讨论展示什么内容。", "选一件作品，写出希望展示的过程和结果。");
    if (input.task.goal.includes("总是修改作品计划")) return { wait: { kind: "feedback" as const, message: "最难开始的是功能范围还是展示内容？" } };
    return answer("可以先做一个最小页面，验证真正的阻碍。");
  });
  decision = (input, context) => context.call({
    kind: "offline_api_fixture_decision", model: "synthetic_no_provider", inputChars: JSON.stringify(input.observation).length, maxOutputTokens: 1_000,
  }, async () => ({ value: await choose(input, context), usage: { inputTokens: 8, outputTokens: 11 } }));
  // Factory injection only: every business method, Runtime action and receipt is real.
  service = new ThinkingAgentService(openDailyReflectionDatabase({ filePath: ":memory:" }), { decision });
  vi.spyOn(factory, "getThinkingAgentService").mockReturnValue(service);
});

afterEach(() => {
  expect(forbiddenFetch).not.toHaveBeenCalled();
  service.close(); service.store.close();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function request(method: string, body?: unknown, target = url) {
  return new Request(target, { method, headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  return response.json() as Promise<T>;
}
async function newMatter(question = "我总是修改作品计划，一直没有开始。") {
  return json<View>(await create(request("POST", { operationKey: `create_${++seq}`, question })), 201);
}
function context(id: string) { return { params: Promise.resolve({ matterId: id }) }; }
async function readMatter(id: string) { return json<View>(await get(request("GET", undefined, `${url}/${id}`), context(id))); }
async function turn(view: View, text: string, extra: Record<string, unknown> = {}) {
  return json<View>(await update(request("POST", { action: "turn", operationKey: `turn_${++seq}`, expectedVersion: view.matter.version, text, ...extra }), context(view.matter.id)));
}
async function mutate(view: View, body: Record<string, unknown>) {
  return json<View>(await update(request("POST", { action: "mutate", operationKey: `mutation_${++seq}`, expectedVersion: view.matter.version, ...body }), context(view.matter.id)));
}

describe("Thinking matter HTTP API with formal SQLite services and synthetic decisions", () => {
  it("executes create, clarify, suggest, adopt, reopen and real feedback through the API", async () => {
    expect((await json<{ matters: unknown[] }>(await list(request("GET")))).matters).toEqual([]);
    let view = await newMatter();
    const matterId = view.matter.id;
    expect(view.matter.status).toBe("active"); expect(view.matter.arrangements).toEqual([]);
    view = await turn(view, view.matter.question);
    expect(view.events.at(-1)?.text).toContain("功能范围还是展示内容");
    view = await turn(view, "主要是功能范围太大，不知道删什么。");
    expect(view.matter.suggestions[0].status).toBe("proposed"); expect(view.matter.arrangements).toEqual([]);
    view = await mutate(view, { kind: "adopt", suggestionId: view.matter.suggestions[0].id });
    expect(view.matter.arrangements[0].status).toBe("adopted");
    const adoptedText = view.matter.arrangements[0].text;
    const oldEventCount = view.events.length;
    view = await readMatter(matterId);
    expect(view.matter.arrangements[0].text).toBe(adoptedText);
    view = await turn(view, "我试过了，技术其实没问题，主要是不知道展示什么内容。", { feedback: true });
    expect(view.matter.arrangements[0].status).toBe("tried");
    expect(view.matter.arrangements[0].text).toBe(adoptedText);
    expect(view.matter.understanding).toContain("讨论展示什么内容");
    expect(view.events.length).toBeGreaterThan(oldEventCount);
    expect(view.events.some(event => event.kind === "feedback" && event.text === "我试过了，技术其实没问题，主要是不知道展示什么内容。")).toBe(true);
    expect(view.task?.status).toBe("ended"); expect(view.matter.status).toBe("active");
    expect(view.task?.usage.calls).toBe(1); expect(view.task?.usage.inputTokens).toBe(8);
    expect(await readMatter(matterId)).toEqual(view);
    expect((await json<{ matters: Array<{ id: string }> }>(await list(request("GET")))).matters.map(item => item.id)).toEqual([matterId]);
  });

  it("saves explicit feedback, arrangement edits, pause and resume as distinct user choices", async () => {
    let view = await turn(await newMatter("我要展示一个作品。"), "帮我开始");
    view = await mutate(view, { kind: "adopt", suggestionId: view.matter.suggestions[0].id });
    const arrangementId = view.matter.arrangements[0].id;
    view = await mutate(view, { kind: "feedback", arrangementId, arrangementStatus: "not_started", text: "我还没开始做。" });
    expect(view.matter.arrangements[0].status).toBe("not_started");
    expect(view.events.at(-1)?.text).toBe("我还没开始做。");
    view = await mutate(view, { kind: "edit", arrangementId, text: "改为先选一个展示内容样例。" });
    expect(view.matter.arrangements[0].text).toContain("内容样例");
    expect(view.matter.arrangements[0].status).toBe("changed");
    const calls = choose.mock.calls.length;
    view = await turn(view, "先暂停这件事");
    expect(view.matter.status).toBe("paused"); expect(view.events.at(-1)?.text).toBe("先暂停这件事");
    expect(choose).toHaveBeenCalledTimes(calls);
    const blocked = await update(request("POST", { action: "turn", operationKey: "paused-turn", expectedVersion: view.matter.version, text: "不应后台继续" }), context(view.matter.id));
    expect(await json<{ error: string }>(blocked, 409)).toEqual({ error: "thinking_matter_not_active" });
    view = await mutate(view, { kind: "status", status: "active" });
    expect(view.matter.status).toBe("active"); expect(view.matter.arrangements[0].status).not.toBe("completed");
  });

  it("enforces discussion-only without creating arrangements or requiring history", async () => {
    const view = await turn(await newMatter("比较两个方向"), "帮我比较两个方向，但今天不要安排计划。");
    expect(view.matter.contextMode).toBe("none");
    expect(view.matter.suggestions).toEqual([]); expect(view.matter.arrangements).toEqual([]);
    expect(view.events.filter(event => event.kind === "assistant_message")).toHaveLength(1);
  });

  it("keeps hypothetical or negated trial language separate from actual execution feedback", async () => {
    let view = await turn(await newMatter("讨论作品展示"), "帮我开始");
    view = await mutate(view, { kind: "adopt", suggestionId: view.matter.suggestions[0].id });
    view = await turn(view, "如果我试过了之后仍没想清楚怎么办？");
    expect(view.matter.arrangements[0].status).toBe("adopted");
    view = await turn(view, "我没有说我试过了，我只是讨论可能的结果。");
    expect(view.matter.arrangements[0].status).toBe("adopted");
    expect(view.events.filter(event => event.kind === "feedback").map(event => event.text)).toEqual([
      "如果我试过了之后仍没想清楚怎么办？", "我没有说我试过了，我只是讨论可能的结果。",
    ]);
  });

  it("withdraws sourced assistant and adopted excerpts from API projections and later model input", async () => {
    const privateExcerpt = "过去只想展示星纹陶盘";
    const source: DailyReflectionThinkingSource = { sourceId: "card_fixture", claim: {
      text: privateExcerpt, sourceCardIds: ["card_fixture"], sourceMemoryIds: [], evidenceIds: ["segment_fixture"], epistemicStatuses: ["explicit_user_statement"],
      evidence: [{ sourceSegmentId: "segment_fixture", cardId: "card_fixture", reflectionId: "reflection_fixture", sourceOrigin: "user_reflection", recordingDate: "2026-11-02", startSeconds: 0, endSeconds: 3, snippet: privateExcerpt }],
    } };
    let available = true;
    service.close(); service.store.close();
    service = new ThinkingAgentService(openDailyReflectionDatabase({ filePath: ":memory:" }), { decision,
      resolver: { resolve: input => ({ sources: available && input.accountId === "account_a" ? [source] : [], promptExcerpts: [], usedPersonalContext: available, pastClues: null }) } });
    vi.mocked(factory.getThinkingAgentService).mockReturnValue(service);
    const observations: unknown[] = [];
    choose.mockImplementation(async input => {
      observations.push(input.observation);
      if (input.task.goal === "查我的日常作品记录" && !input.results.length) return { tool: "search_records", args: { query: "作品" } };
      return input.task.goal === "查我的日常作品记录" ? answer(`从记录看到：${privateExcerpt}`, `安排：${privateExcerpt}`) : answer("根据当前表达重新讨论内容。", "");
    });
    let view = await turn(await newMatter("讨论作品展示"), "查我的日常作品记录", { contextMode: "personal" });
    expect(view.events.at(-1)?.sources).toHaveLength(1);
    const adoption = { action: "mutate", kind: "adopt", operationKey: "source-adoption-receipt", expectedVersion: view.matter.version, suggestionId: view.matter.suggestions[0].id };
    view = await json<View>(await update(request("POST", adoption), context(view.matter.id)));
    expect(view.events.at(-1)?.text).toContain(privateExcerpt);
    available = false;
    view = await readMatter(view.matter.id);
    expect(JSON.stringify(view)).not.toContain(privateExcerpt);
    expect(await json<View>(await update(request("POST", adoption), context(view.matter.id)))).toEqual(view);
    expect(view.matter.arrangements).toHaveLength(1);
    view = await turn(view, "用现在的问题继续讨论");
    expect(JSON.stringify(observations.at(-1))).not.toContain(privateExcerpt);
    expect(view.matter.arrangements).toHaveLength(1);
    // Durable audit history still exists; the HTTP/model projection revalidates it.
    expect(service.repository.get("account_a", view.matter.id).events.some(event => event.kind === "adopted" && event.text.includes(privateExcerpt))).toBe(true);
  });

  it("rejects a stale UI adoption after its source is withdrawn without creating an arrangement", async () => {
    const source: DailyReflectionThinkingSource = { sourceId: "card_stale", claim: {
      text: "合成来源：用户曾讨论展示一件作品。", sourceCardIds: ["card_stale"], sourceMemoryIds: [], evidenceIds: ["segment_stale"], epistemicStatuses: ["explicit_user_statement"],
      evidence: [{ sourceSegmentId: "segment_stale", cardId: "card_stale", reflectionId: "reflection_stale", sourceOrigin: "user_reflection", recordingDate: "2026-11-02", startSeconds: 0, endSeconds: 2, snippet: "我想展示一件作品。" }],
    } };
    let available = true;
    service.close(); service.store.close();
    service = new ThinkingAgentService(openDailyReflectionDatabase({ filePath: ":memory:" }), { decision,
      resolver: { resolve: input => ({ sources: available && input.accountId === "account_a" ? [source] : [], promptExcerpts: [], usedPersonalContext: available, pastClues: null }) } });
    vi.mocked(factory.getThinkingAgentService).mockReturnValue(service);
    choose.mockImplementation(async input => input.results.length ? answer("可以从一件作品开始。", "选择一件作品展示。") : { tool: "search_records", args: { query: "作品" } });
    const proposed = await turn(await newMatter("作品展示"), "查找日常作品记录", { contextMode: "personal" });
    const staleSuggestionId = proposed.matter.suggestions[0].id;
    available = false;
    expect((await readMatter(proposed.matter.id)).matter.suggestions).toEqual([]);
    const denied = await update(request("POST", { action: "mutate", kind: "adopt", operationKey: "stale-source-adopt", expectedVersion: proposed.matter.version, suggestionId: staleSuggestionId }), context(proposed.matter.id));
    expect(await json(denied, 409)).toEqual({ error: "thinking_source_changed" });
    const retained = service.repository.get("account_a", proposed.matter.id);
    expect(retained.matter.arrangements).toEqual([]);
    expect(retained.matter.suggestions[0].status).toBe("proposed");
    expect(retained.matter.version).toBe(proposed.matter.version);
    expect(retained.events).toHaveLength(proposed.events.length);
  });

  it("replays create, model turn and adoption operations without duplicate calls or writes", async () => {
    const createBody = { operationKey: "same-create", question: "我想开始一个页面。" };
    let view = await json<View>(await create(request("POST", createBody)), 201);
    expect((await json<View>(await create(request("POST", createBody)), 201)).matter.id).toBe(view.matter.id);
    const input = { action: "turn", operationKey: "same-turn", expectedVersion: view.matter.version, text: "帮我开始" };
    view = await json<View>(await update(request("POST", input), context(view.matter.id)));
    expect(await json<View>(await update(request("POST", input), context(view.matter.id)))).toEqual(view);
    expect(choose).toHaveBeenCalledTimes(1);
    const adoption = { action: "mutate", kind: "adopt", operationKey: "same-adopt", expectedVersion: view.matter.version, suggestionId: view.matter.suggestions[0].id };
    view = await json<View>(await update(request("POST", adoption), context(view.matter.id)));
    expect(await json<View>(await update(request("POST", adoption), context(view.matter.id)))).toEqual(view);
    expect(view.matter.arrangements).toHaveLength(1); expect(view.events.filter(event => event.kind === "adopted")).toHaveLength(1);
    const conflict = await update(request("POST", { ...adoption, text: "复用key但修改内容" }), context(view.matter.id));
    expect((await json<{ error: string }>(conflict, 409)).error).toBe("thinking_matter_operation_conflict");
    const feedback = { action: "turn", operationKey: "same-feedback", expectedVersion: view.matter.version, text: "我试过了，技术其实没问题，主要是不知道展示什么内容。", feedback: true };
    view = await json<View>(await update(request("POST", feedback), context(view.matter.id)));
    expect(await json<View>(await update(request("POST", feedback), context(view.matter.id)))).toEqual(view);
    expect(view.events.filter(event => event.kind === "feedback")).toHaveLength(1);
    expect(view.matter.arrangements[0].version).toBe(1);
    expect(choose).toHaveBeenCalledTimes(2);
  });

  it("isolates account lists, reads, turns, mutations and task details", async () => {
    const own = await turn(await newMatter("账号A私有问题"), "讨论我的问题");
    mocks.auth.mockResolvedValue({ user: { id: "account_b" } });
    expect((await json<{ matters: unknown[] }>(await list(request("GET")))).matters).toEqual([]);
    expect(await json(await get(request("GET"), context(own.matter.id)), 404)).toEqual({ error: "thinking_matter_not_found" });
    const deniedTurn = await update(request("POST", { action: "turn", operationKey: "cross-turn", expectedVersion: own.matter.version, text: "窃取内容" }), context(own.matter.id));
    expect(await json(deniedTurn, 404)).toEqual({ error: "thinking_matter_not_found" });
    const deniedMutation = await update(request("POST", { action: "mutate", kind: "status", status: "paused", operationKey: "cross-pause", expectedVersion: own.matter.version }), context(own.matter.id));
    expect(await json(deniedMutation, 404)).toEqual({ error: "thinking_matter_not_found" });
    const other = await newMatter("账号B自己的问题");
    expect(other.matter.accountId).toBe("account_b");
    mocks.auth.mockResolvedValue({ user: { id: "account_a" } });
    expect((await readMatter(own.matter.id)).matter.status).toBe("active");
    expect(choose).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight HTTP turn and discards its late decision without resolving the matter", async () => {
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    choose.mockImplementation(async () => { entered(); await gate; return answer("不能写回的迟到回答", "不能写回的迟到安排"); });
    const view = await newMatter("讨论取消行为");
    const controller = new AbortController();
    const req = new Request(`${url}/${view.matter.id}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "turn", operationKey: "cancel-http-turn", expectedVersion: view.matter.version, text: "开始讨论" }), signal: controller.signal });
    const pending = update(req, context(view.matter.id));
    await ready;
    controller.abort(); release();
    const cancelled = await json<View>(await pending);
    expect(cancelled.matter.activeGeneration).toBeNull(); expect(cancelled.matter.status).toBe("active");
    expect(cancelled.matter.arrangements).toEqual([]); expect(cancelled.matter.suggestions).toEqual([]);
    expect(cancelled.events.some(event => event.text.includes("迟到"))).toBe(false);
    expect(cancelled.events.at(-1)?.kind).toBe("cancelled");
  });

  it.each(["list", "create", "get", "update"])("requires authentication for %s and retains private no-store errors", async endpoint => {
    mocks.auth.mockRejectedValue(new Error("unauthenticated"));
    const response = endpoint === "list" ? await list(request("GET"))
      : endpoint === "create" ? await create(request("POST", { operationKey: "x", question: "问题" }))
      : endpoint === "get" ? await get(request("GET"), context("private_matter"))
      : await update(request("POST", { action: "turn", operationKey: "x", expectedVersion: 0, text: "讨论" }), context("private_matter"));
    expect(await json(response, 401)).toEqual({ error: "unauthenticated" });
    expect(service.repository.list("account_a")).toEqual([]);
  });

  it("honors the existing product feature gate before authentication or business access", async () => {
    mocks.enabled.mockReturnValue(false);
    expect(await json(await list(request("GET")), 404)).toEqual({ error: "daily_reflection_not_found" });
    expect(await json(await create(request("POST", {})), 404)).toEqual({ error: "daily_reflection_not_found" });
    expect(mocks.auth).not.toHaveBeenCalled(); expect(choose).not.toHaveBeenCalled();
  });

  it.each([
    { action: "turn", taskId: "foreign-task" },
    { action: "turn", arrangementId: "foreign-arrangement" },
    { action: "turn", arrangementStatus: "completed" },
    { action: "turn", arrangementStatus: "tried" },
    { action: "turn", accountId: "account_b" },
    { action: "turn", generationId: "forged-generation" },
    { action: "mutate", kind: "status", status: "paused", taskId: "injected-task" },
  ])("rejects unexposed server-owned field injection %j", async injection => {
    const view = await newMatter("用于检查参数边界");
    const payload = injection.action === "turn"
      ? { operationKey: "injection", expectedVersion: view.matter.version, text: "讨论", ...injection }
      : { operationKey: "injection", expectedVersion: view.matter.version, ...injection };
    const response = await update(request("POST", payload), context(view.matter.id));
    expect(await json(response, 400)).toEqual({ error: "invalid_thinking_matter_request" });
    expect((await readMatter(view.matter.id)).matter.version).toBe(view.matter.version);
    expect(choose).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON, invalid IDs, unknown actions and stale versions without leaking bodies", async () => {
    const malformed = new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{secret: unfinished" });
    expect(await json(await create(malformed), 400)).toEqual({ error: "invalid_thinking_matter_request" });
    expect(await json(await create(request("POST", { operationKey: "x", question: "", extra: "secret" })), 400)).toEqual({ error: "invalid_thinking_matter_request" });
    expect(await json(await get(request("GET"), context("../../other-account")), 400)).toEqual({ error: "invalid_thinking_matter_request" });
    const view = await newMatter("有效问题");
    expect(await json(await update(request("POST", { action: "execute_sql", sql: "secret" }), context(view.matter.id)), 400)).toEqual({ error: "invalid_thinking_matter_request" });
    expect(await json(await update(request("POST", { action: "turn", operationKey: "stale", expectedVersion: 999, text: "secret" }), context(view.matter.id)), 409)).toEqual({ error: "thinking_matter_version_conflict" });
    expect(choose).not.toHaveBeenCalled();
  });

  it("P2 saves manual comparison, choice, correction, archive and reopen without invoking a model", async () => {
    let view = await newMatter("比较内容方向");
    view = await mutate(view, { kind: "comparison", comparison: { question: "展示什么", dimensions: ["速度"],
      options: ["方案A", "方案B"].map(name => ({ name, content: `${name}内容`, reasons: ["原因"], limits: [], costs: [], unknowns: [] })), recommendation: null } });
    const optionId = view.matter.comparison!.options[0].id;
    view = await mutate(view, { kind: "choice", status: "leaning", optionId, reason: "先试验" });
    expect(view.matter.userChoice).toMatchObject({ status: "leaning", optionId, reason: "先试验" });
    view = await mutate(view, { kind: "correct", understanding: "要讨论展示内容，不是技术能力", reason: "此前理解不准确" });
    view = await mutate(view, { kind: "status", status: "archived" });
    expect(view.matter.status).toBe("archived");
    expect(await json(await update(request("POST", { action: "turn", operationKey: "archived", expectedVersion: view.matter.version, text: "继续" }), context(view.matter.id)), 409)).toEqual({ error: "thinking_matter_not_active" });
    view = await mutate(view, { kind: "status", status: "active" });
    expect((await readMatter(view.matter.id)).matter.userChoice.optionId).toBe(optionId);
    expect(view.matter.understanding).toContain("展示内容"); expect(view.matter.arrangements).toEqual([]);
    expect(choose).not.toHaveBeenCalled();
  });

  it("P2 validates canonical card grants on create/link/unlink and rejects internal authority injection", async () => {
    const detail = { card: DailyReflectionWorkingCardSchema.parse({ id: "card_link", accountId: "account_a", sourceReflectionIds: ["reflection_link"],
      title: "合成关联卡", content: "需要比较展示方向", cardKind: "idea", evidenceIds: ["segment_link"], status: "saved", importance: 0.5, novelty: 0.5,
      relatedCardIds: [], tags: [], visibility: "private", sourceUnavailable: false, version: 2, createdAt: "2026-11-03T00:00:00.000Z", updatedAt: "2026-11-03T00:00:00.000Z" }),
      evidence: [{ sourceSegmentId: "segment_link", uploadId: "upload_link", effectiveOrigin: "user_reflection" as const, startSeconds: 0, endSeconds: 2, text: "合成原文" }] };
    service.close(); service.store.close();
    service = new ThinkingAgentService(openDailyReflectionDatabase({ filePath: ":memory:" }), { decision, cardReader: () => detail });
    vi.mocked(factory.getThinkingAgentService).mockReturnValue(service);
    let view = await json<View>(await create(request("POST", { operationKey: "linked_create", question: "关联讨论", sourceCardId: "card_link", sourceCardVersion: 2 })), 201);
    expect(view.matter.linkedSources[0]).toMatchObject({ sourceId: "card_link", kind: "card" });
    expect(view.matter.contextMode).toBe("none");
    expect(await json(await create(request("POST", { operationKey: "bad_pair", question: "关联讨论", sourceCardId: "card_link" })), 400)).toEqual({ error: "invalid_thinking_matter_request" });
    expect(await json(await create(request("POST", { operationKey: "forged", question: "伪造", source: view.matter.linkedSources[0] })), 400)).toEqual({ error: "invalid_thinking_matter_request" });
    for (const kind of ["link_source", "unlink_source"]) {
      const fields = kind === "link_source" ? { source: { sourceId: "card_link", version: "forged", kind: "card" } } : { sourceId: "card_link" };
      expect(await json(await update(request("POST", { action: "mutate", kind, operationKey: `forge_${kind}`, expectedVersion: view.matter.version, ...fields }), context(view.matter.id)), 400)).toEqual({ error: "invalid_thinking_matter_request" });
    }
    expect(await json(await update(request("POST", { action: "turn", operationKey: "choice_injection", expectedVersion: view.matter.version, text: "讨论", choice: { status: "undecided", reason: "伪造" } }), context(view.matter.id)), 400)).toEqual({ error: "invalid_thinking_matter_request" });
    view = await json<View>(await update(request("POST", { action: "unlink_card", cardId: "card_link", operationKey: "unlink", expectedVersion: view.matter.version }), context(view.matter.id)));
    expect(view.matter.linkedSources).toEqual([]);
    expect(await json(await update(request("POST", { action: "link_card", cardId: "card_link", cardVersion: 1, operationKey: "stale_link", expectedVersion: view.matter.version }), context(view.matter.id)), 409)).toEqual({ error: "thinking_source_changed" });
    view = await json<View>(await update(request("POST", { action: "link_card", cardId: "card_link", cardVersion: 2, operationKey: "link", expectedVersion: view.matter.version }), context(view.matter.id)));
    expect(view.matter.linkedSources).toHaveLength(1);
    mocks.auth.mockResolvedValue({ user: { id: "account_b" } });
    expect(await json(await create(request("POST", { operationKey: "foreign_card", question: "不能关联其他账号卡", sourceCardId: "card_link", sourceCardVersion: 2 })), 409)).toEqual({ error: "thinking_source_changed" });
    expect(service.repository.list("account_b")).toEqual([]); expect(choose).not.toHaveBeenCalled();
  });

  it("P2 strips withdrawn source text from nested prior comparison/correction audit fields in HTTP and model projections", async () => {
    const privateText = "PRIVATE_NESTED_SOURCE_DERIVATION";
    const source: DailyReflectionThinkingSource = { sourceId: "nested_card", claim: { text: privateText, sourceCardIds: ["nested_card"], sourceMemoryIds: [], evidenceIds: ["nested_segment"], epistemicStatuses: ["explicit_user_statement"],
      evidence: [{ sourceSegmentId: "nested_segment", cardId: "nested_card", reflectionId: "nested_reflection", sourceOrigin: "user_reflection", recordingDate: "2026-11-03", startSeconds: 0, endSeconds: 2, snippet: privateText }] } };
    let available = true; const modelInputs: unknown[] = [];
    service.close(); service.store.close();
    service = new ThinkingAgentService(openDailyReflectionDatabase({ filePath: ":memory:" }), { decision,
      resolver: { resolve: () => ({ sources: available ? [source] : [], promptExcerpts: [], usedPersonalContext: available, pastClues: null }) } });
    vi.mocked(factory.getThinkingAgentService).mockReturnValue(service);
    choose.mockImplementation(async input => {
      if (input.task.goal === "参考来源") return input.results.length ? { tool: "respond", args: { reply: privateText, understanding: privateText, judgments: [privateText], suggestions: [],
        comparison: { question: privateText, dimensions: [privateText], options: ["A", "B"].map(name => ({ name, content: privateText, reasons: [privateText], limits: [], costs: [], unknowns: [] })), recommendation: null } } } : { tool: "search_records", args: { query: "资料" } };
      modelInputs.push({ observation: input.observation, results: input.results });
      return input.results.length ? answer("按当前表达讨论", "") : { tool: "read_matter", args: { offset: 0 } };
    });
    let view = await turn(await newMatter("独立当前用户问题"), "参考来源", { contextMode: "personal" });
    view = await mutate(view, { kind: "comparison", comparison: { question: "用户调整后的问题", dimensions: [],
      options: view.matter.comparison!.options.map((option, index) => ({ id: option.id, name: option.name, content: index ? option.content : "用户修改后的内容", reasons: index ? option.reasons : [], limits: [], costs: [], unknowns: [] })), recommendation: null } });
    view = await mutate(view, { kind: "correct", understanding: "按用户当前表达理解", reason: "先前理解需要改正" });
    expect(JSON.stringify(service.repository.get("account_a", view.matter.id).events.filter(event => ["comparison_edited", "corrected"].includes(event.kind)).map(event => event.data))).toContain(privateText);
    available = false;
    const safe = await readMatter(view.matter.id);
    expect(JSON.stringify(safe)).not.toContain(privateText);
    expect(safe.events.find(event => event.kind === "comparison_edited")?.data).not.toHaveProperty("previousComparison");
    expect(safe.events.find(event => event.kind === "corrected")?.data).not.toHaveProperty("previousUnderstanding");
    await turn(safe, "继续当前讨论");
    expect(JSON.stringify(modelInputs)).not.toContain(privateText);
  });

  it.each(["known_failure", "unknown"] as const)("preserves %s user-facing state through HTTP without implicit retries", async code => {
    choose.mockImplementation(async () => { throw new AgentFailure(code, "fixture failure with private details"); });
    const view = await turn(await newMatter("失败时也保存的问题"), "需要保留的用户原话");
    expect(view.events.some(event => event.text === "需要保留的用户原话")).toBe(true);
    expect(view.events.at(-1)?.data.status).toBe(code === "unknown" ? "unknown" : "known_failed");
    expect(JSON.stringify(view)).not.toContain("fixture failure with private details");
    expect(choose).toHaveBeenCalledTimes(1);
    if (code === "unknown") {
      const inspect = { action: "recover", operationKey: "inspect-unknown" };
      const inspected = await json<View>(await update(request("POST", inspect), context(view.matter.id)));
      expect(inspected.matter.activeGeneration?.status).toBe("unknown");
      expect(inspected.task?.recovery?.kind).toBe("unknown");
      expect(await json<View>(await update(request("POST", inspect), context(view.matter.id)))).toEqual(inspected);
      expect(choose).toHaveBeenCalledTimes(1);
      expect(await json(await update(request("POST", { ...inspect, taskId: "forged" }), context(view.matter.id)), 400)).toEqual({ error: "invalid_thinking_matter_request" });
      const blocked = await update(request("POST", { action: "turn", operationKey: "no-implicit-retry", expectedVersion: view.matter.version, text: "再次讨论" }), context(view.matter.id));
      expect(await json(blocked, 409)).toEqual({ error: "thinking_generation_pending" });
      const cancelled = await mutate(view, { kind: "cancel" });
      expect(cancelled.matter.activeGeneration).toBeNull(); expect(cancelled.matter.status).toBe("active");
    }
  });
});
