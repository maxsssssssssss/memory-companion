// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
const state = vi.hoisted(() => ({ service: null as unknown }));
vi.mock("@/lib/server/auth/request-context", () => ({
  requireAuthContext: async (request: Request) => {
    const id = request.headers.get("x-test-user");
    if (!id)
      throw new Error("unauthenticated");
    return { user: { id } };
  }, isUnauthenticatedError: (error: unknown) => error instanceof Error && error.message === "unauthenticated", unauthorizedResponse: () => Response.json({ error: "unauthenticated" }, { status: 401 })
}));
vi.mock("@/lib/server/date-companion/preparation-service", () => ({ getPreparationAgentService: () => state.service }));
import { openDateCompanionDatabase } from "@/lib/server/date-companion/db";
import { PreparationAgentService } from "@/lib/server/date-companion/preparation-agent";
import { DateCompanionRepository } from "@/lib/server/date-companion/repository";
import type { AgentDecision, AgentDecisionInput } from "@/lib/server/agent/types";
import { agentDecisionRequest } from "@/lib/server/agent/model";
import { GET as list, POST as create } from "./route";
import { GET as get, PATCH as mutate, DELETE as remove } from "./[id]/route";
import { POST as turn } from "./[id]/turns/route";
import { missingSuggestionTurn, type PreparationView } from "@/lib/domain/date-companion-preparation";
function request(method: string, user = "alice", body?: unknown) {
  return new Request("http://localhost/api/date-companion/preparations", {
    method, headers: { ...(user ? { "x-test-user": user } : {}), "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {})
  });
}
describe("preparation API with real SQLite service and Runtime", () => {
  let db: Database.Database, service: PreparationAgentService;
  function keptRecording(uploadId: string, quote: string) {
    const records = new DateCompanionRepository(db);
    const relationshipId = records.createOrGetRelationship("alice").relationship.id;
    const { interactionId } = records.importInteraction({
      userId: "alice", relationshipId, sourceUploadId: uploadId, recordingDate: "2026-11-01",
      originalName: uploadId, participants: [{ speakerId: "ta" }], recapCandidates: [{
        kind: "mentioned", proposedText: quote, sortOrder: 0,
        evidence: [{ uploadId, sourceSegmentId: uploadId + "-1", speakerId: "ta", startSeconds: 1, endSeconds: 4, quote }]
      }]
    });
    const [item] = records.getInteractionDetail("alice", relationshipId, interactionId).recapItems;
    records.updateRecap({ userId: "alice", interactionId, version: 0, finalize: true,
      assignments: [{ speakerId: "ta", role: "companion" }], mutations: [{ id: item.id, version: 0, disposition: "kept" }] });
    return { relationshipId, interactionId, id: item.evidence[0].id, quote };
  }
  function useDecisions(decide: (input: AgentDecisionInput) => AgentDecision) {
    service.close();
    service = new PreparationAgentService(db, { decision: (input, ctx) => ctx.call({
      kind: "agent_decision", inputChars: 100, maxOutputTokens: 200
    }, async () => ({ value: decide(input), usage: { inputTokens: 10, outputTokens: 10 } })) });
    state.service = service;
  }
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("network forbidden");
    }));
    db = openDateCompanionDatabase({ filePath: ":memory:" });
    service = new PreparationAgentService(db, { decision: async (_input, ctx) => ctx.call({
        kind: "agent_decision", inputChars: 100, maxOutputTokens: 200
      }, async () => ({ value: { tool: "respond", args: {
            reply: "先轻松聊聊就好。", suggestions: ["见面先聊聊最近的生活"], sourceIds: []
          } }, usage: { inputTokens: 10, outputTokens: 10 } })) });
    state.service = service;
  });
  afterEach(() => {
    service.close();
    db.close();
    vi.unstubAllGlobals();
  });
  it("requires auth for every route and refuses malformed bodies", async () => {
    const context = { params: Promise.resolve({ id: "absent" }) };
    expect((await list(request("GET", ""))).status).toBe(401);
    expect((await create(request("POST", "", {}))).status).toBe(401);
    expect((await get(request("GET", ""), context)).status).toBe(401);
    expect((await mutate(request("PATCH", "", {}), context)).status).toBe(401);
    expect((await remove(request("DELETE", "", {}), context)).status).toBe(401);
    expect((await turn(request("POST", "", {}), context)).status).toBe(401);
    expect((await create(request("POST", "alice", { text: "hello" }))).status).toBe(400);
    expect((await create(new Request("http://localhost", {
      method: "POST", headers: { "x-test-user": "alice" }, body: "{"
    }))).status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM dc_preparations").get()).toEqual({ n: 0 });
  });
  it("recovers real saved choices/feedback, fences cross-account reads/mutations and preserves accounting on delete", async () => {
    const created = await create(request("POST", "alice", { operationKey: "first", text: "明天见Ta" }));
    expect(created.status).toBe(200);
    expect(created.headers.get("Cache-Control")).toBe("private, no-store");
    let { view } = await created.json() as {
      view: PreparationView;
    };
    const context = { params: Promise.resolve({ id: view.id }) };
    expect((await get(request("GET", "bob"), context)).status).toBe(404);
    expect((await mutate(request("PATCH", "bob", {
      operationKey: "foreign", expectedVersion: view.version, kind: "pause"
    }), context)).status).toBe(404);
    ({ view } = await (await mutate(request("PATCH", "alice", {
      operationKey: "select", expectedVersion: view.version, kind: "select", itemId: view.items[0].id
    }), context)).json());
    expect(view.items[0].status).toBe("selected");
    ({ view } = await (await turn(request("POST", "alice", {
      operationKey: "feedback", expectedVersion: view.version, text: "后来发生了别的事", kind: "feedback"
    }), context)).json());
    expect(view.messages.at(-2)?.text).toBe("后来发生了别的事");
    expect((await (await get(request("GET"), context)).json()).view.items[0].status).toBe("selected");
    expect((await mutate(request("PATCH", "alice", {
      operationKey: "stale", expectedVersion: 0, kind: "pause"
    }), context)).status).toBe(409);
    const calls = db.prepare("SELECT COUNT(*) AS n FROM agent_calls").get();
    const deletion = { operationKey: "delete", expectedVersion: view.version };
    expect((await remove(request("DELETE", "alice", deletion), context)).status).toBe(200);
    expect((await remove(request("DELETE", "alice", deletion), context)).status).toBe(200);
    expect((await get(request("GET"), context)).status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_calls").get()).toEqual(calls);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("retries a confirmed missing card once on its saved turn, fencing stale, duplicate and foreign requests", async () => {
    const first = await create(request("POST", "alice", { operationKey: "create", text: "只想聊聊近况" }));
    const { view: initial } = await first.json() as { view: PreparationView };
    const context = { params: Promise.resolve({ id: initial.id }) };
    const original = { operationKey: "opener", expectedVersion: initial.version, text: "给我一句开场白。", kind: "message" as const };
    const lease = service.repository.begin("alice", initial.id, { ...original, revokeHistory: false });
    service.repository.fail("alice", initial.id, lease.generationId!, lease.version!, "缺少可留下的建议", "missing_suggestions");
    const failed = service.get("alice", initial.id);
    const originalMessage = failed.messages.at(-1)!;
    expect(failed.events.at(-1)?.data).toMatchObject({ failureCode: "missing_suggestions", messageId: originalMessage.id });
    const retry = { operationKey: "retry-opener", expectedVersion: failed.version, retryMessageId: originalMessage.id };
    const submit = (body: unknown, owner = "alice") => turn(request("POST", owner, body), context);
    const calls = () => (db.prepare("SELECT COUNT(*) AS n FROM agent_calls").get() as { n: number }).n;
    const before = calls();
    expect((await submit(retry, "bob")).status).toBe(404);
    expect((await submit({ ...retry, retryMessageId: initial.messages[0].id })).status).toBe(409);
    expect((await submit({ ...retry, text: "换一个问题" })).status).toBe(400);
    expect(calls()).toBe(before);
    const replies = await Promise.all([submit(retry), submit(retry)]);
    expect(replies.map(reply=>reply.status)).toEqual([200,200]);
    const saved = service.get("alice", initial.id);
    expect(saved.generationStatus).toBe("idle");
    expect(saved.messages.filter(m=>m.role==="user")).toEqual(failed.messages.filter(m=>m.role==="user"));
    expect(saved.messages).toHaveLength(failed.messages.length+1);
    expect(saved.items).toHaveLength(failed.items.length+1);
    expect(saved.items.at(-1)?.sourceMessageId).toBe(saved.messages.at(-1)?.id);
    service.repository.fail("alice", initial.id, lease.generationId!, lease.version!, "迟到的错误", "missing_suggestions");
    expect((await submit(retry)).status).toBe(200);
    expect((await submit(original)).status).toBe(200);
    expect((await submit({ ...retry, operationKey: "stale" })).status).toBe(409);
    expect((await submit({ ...retry, expectedVersion: saved.version, operationKey: "already-answered" })).status).toBe(409);
    expect(calls()).toBe(before+1);
    expect((await (await get(request("GET"), context)).json()).view).toEqual(saved);
  });
  it("retries a missing card against the newly saved scope and keeps the original user turn", async () => {
    const oldRecord = keptRecording("scope-old", "我在排木刻画。");
    const newRecord = keptRecording("scope-new", "我在做蓝色画册。");
    let phase: "fail" | "retry" = "fail";
    const requests: string[] = [];
    useDecisions(input => {
      requests.push(JSON.stringify(agentDecisionRequest(input).messages));
      const source = phase === "fail" ? oldRecord : newRecord;
      if (!input.results.length) return { tool: "list_review_sources", args: { scope: "selected" } };
      if (!input.results.some(r => r.tool === "read_source")) return { tool: "read_source", args: { sourceId: source.id } };
      return { tool: "respond", args: { reply: "当时说的是：" + source.quote,
        suggestions: phase === "fail" ? [] : ["那本蓝色画册最近做得怎么样？"], sourceIds: [source.id] } };
    });
    const { view: failed } = await (await create(request("POST", "alice", {
      operationKey: "ask", text: "给我一条可以直接说的开场白。", interactionIds: [oldRecord.interactionId]
    }))).json() as { view: PreparationView };
    expect(requests.join("")).toContain(oldRecord.quote);
    const message = failed.messages[0];
    expect(missingSuggestionTurn(failed)?.id).toBe(message.id);
    const context = { params: Promise.resolve({ id: failed.id }) };
    const scope = (operationKey: string, expectedVersion: number, interactionIds: string[], allowRetained: boolean) =>
      mutate(request("PATCH", "alice", { operationKey, expectedVersion, kind: "scope", interactionIds, allowRetained }), context);
    const submit = (body: unknown) => turn(request("POST", "alice", body), context);
    const firstCount = requests.length;
    const { view: added } = await (await scope("add", failed.version, [oldRecord.interactionId, newRecord.interactionId], true)).json() as { view: PreparationView };
    const { view: reduced } = await (await scope("remove", added.version, [newRecord.interactionId], false)).json() as { view: PreparationView };
    for (const updated of [added, reduced]) {
      expect(updated).toMatchObject({ generationStatus: "failed", generationMessage: failed.generationMessage, messages: [message], items: [] });
      expect(missingSuggestionTurn(updated)?.id).toBe(message.id);
      expect(updated.events.filter(e => e.kind === "generation_stopped")).toEqual(failed.events.filter(e => e.kind === "generation_stopped"));
    }
    expect((await (await get(request("GET"), context)).json()).view).toEqual(reduced);
    expect(service.sources.read("alice", oldRecord.relationshipId, reduced.interactionIds, oldRecord.id, reduced.allowRetained)).toBeNull();
    // Reproduce the stored JSON written by the old scope handler. GET must project
    // the known failure without rewriting the record or automatically running a task.
    const stored = () => (db.prepare("SELECT body_json FROM dc_preparations WHERE id=?").get(failed.id) as { body_json: string }).body_json;
    const legacy = JSON.parse(stored()) as PreparationView & { taskId: string };
    legacy.generationStatus = "idle";
    delete legacy.generationMessage;
    const oldBody = JSON.stringify(legacy);
    db.prepare("UPDATE dc_preparations SET body_json=? WHERE id=?").run(oldBody, failed.id);
    expect((await (await get(request("GET"), context)).json()).view).toEqual(reduced);
    expect(stored()).toBe(oldBody);
    const retry = { operationKey: "retry-after-scope", expectedVersion: reduced.version, retryMessageId: message.id };
    // An overlapping newer task can leave the same business events on interruption.
    // Its task started after this stop, so even its latest version grants no retry.
    const taskCreated = (db.prepare("SELECT created_at FROM agent_tasks WHERE id=?").get(legacy.taskId) as {created_at: string}).created_at;
    db.prepare("UPDATE agent_tasks SET created_at=? WHERE id=?").run(reduced.events.at(-1)!.createdAt, legacy.taskId);
    expect((await (await get(request("GET"), context)).json()).view.generationStatus).toBe("idle");
    expect((await submit({ ...retry, operationKey: "interrupted-attempt" })).status).toBe(409);
    db.prepare("UPDATE agent_tasks SET created_at=? WHERE id=?").run(taskCreated, legacy.taskId);
    expect((await submit({ ...retry, expectedVersion: failed.version })).status).toBe(409);
    expect(requests).toHaveLength(firstCount);
    phase = "retry";
    const { view: saved } = await (await submit(retry)).json() as { view: PreparationView };
    expect(saved.generationStatus).toBe("idle");
    expect(saved.messages.map(m => m.role)).toEqual(["user", "assistant"]);
    expect(saved.messages[0]).toEqual(message);
    expect(saved.messages[1].sources.map(s => s.quote)).toEqual([newRecord.quote]);
    expect(saved.items.map(i => i.sources.map(s => s.id))).toEqual([[newRecord.id]]);
    const retriedRequests = requests.slice(firstCount).join("");
    expect(retriedRequests).toContain(newRecord.quote);
    expect(retriedRequests).not.toContain(oldRecord.quote);
    expect(retriedRequests).not.toContain(oldRecord.id);
    const afterSuccess = requests.length;
    expect((await (await submit(retry)).json()).view).toEqual(saved);
    expect(requests).toHaveLength(afterSuccess);
    expect((await (await get(request("GET"), context)).json()).view).toEqual(saved);
    // Even with the current version, the earlier failed user message cannot claim another turn's failure.
    const latest = service.repository.begin("alice", failed.id, {
      operationKey: "next", expectedVersion: saved.version, text: "再给我一句开场白。", kind: "message"
    });
    service.repository.fail("alice", failed.id, latest.generationId!, latest.version!, "缺少可留下的建议", "missing_suggestions");
    const next = service.get("alice", failed.id);
    expect(missingSuggestionTurn(next)?.id).toBe(next.messages.at(-1)?.id);
    expect((await submit({ ...retry, expectedVersion: next.version, operationKey: "old-turn" })).status).toBe(409);
    expect(requests).toHaveLength(afterSuccess);
  });
  it("clearing every source before retry leaves earlier reads out of the new request and saved card", async () => {
    const old = keptRecording("clear-and-retry", "周五去看紫色木桥。");
    let scopeCleared = false;
    const wire: string[] = [];
    useDecisions(input => {
      wire.push(JSON.stringify(agentDecisionRequest(input).messages));
      if (scopeCleared) return { tool: "respond", args: { reply: "", suggestions: ["这周有什么开心的小事吗？"], sourceIds: [] } };
      if (!input.results.length) return { tool: "list_review_sources", args: { scope: "selected" } };
      if (!input.results.some(r => r.tool === "read_source")) return { tool: "read_source", args: { sourceId: old.id } };
      return { tool: "respond", args: { reply: "当时提到「" + old.quote + "」", suggestions: [], sourceIds: [old.id] } };
    });
    const { view: failed } = await (await create(request("POST", "alice", {
      operationKey: "start", text: "给我一句能直接说的开场白。", interactionIds: [old.interactionId]
    }))).json() as {view: PreparationView};
    const original = failed.messages[0];
    expect(missingSuggestionTurn(failed)?.id).toBe(original.id);
    expect(wire.join("")).toContain(old.quote);
    const context = { params: Promise.resolve({ id: failed.id }) };
    const before = wire.length;
    scopeCleared = true;
    const {view: cleared} = await (await mutate(request("PATCH", "alice", {
      kind: "scope", operationKey: "clear", expectedVersion: failed.version, interactionIds: [], allowRetained: false
    }), context)).json() as {view: PreparationView};
    expect(wire).toHaveLength(before);
    expect(missingSuggestionTurn(cleared)?.id).toBe(original.id);
    const { view } = await (await turn(request("POST", "alice", {
      operationKey: "retry", expectedVersion: cleared.version, retryMessageId: original.id
    }), context)).json() as {view: PreparationView};
    expect(wire).toHaveLength(before + 1);
    expect(wire.at(-1)).not.toContain(old.quote);
    expect(wire.at(-1)).not.toContain(old.id);
    expect(view.generationStatus).toBe("idle");
    const row = db.prepare("SELECT body_json FROM dc_preparations WHERE id=? AND user_id=?").get(view.id, "alice") as { body_json: string };
    const saved = JSON.parse(row.body_json) as PreparationView;
    expect(saved.messages.map(m => [m.role, m.sources])).toEqual([["user", []], ["assistant", []]]);
    expect(saved.messages[0].id).toBe(original.id);
    expect(saved.items.map(i => [i.text, i.sources])).toEqual([["这周有什么开心的小事吗？", []]]);
    expect((await (await get(request("GET"), context)).json()).view).toEqual(view);
  });
  it("publishes one verified quote and one new selectable opener from a mixed request", async () => {
    const selected = keptRecording("mixed-opener", "嗨，路上顺利吗？");
    const excluded = keptRecording("outside-scope", "我在门口等蓝色电车。");
    const text = "先查那句原话，再帮我写一句新的开场白";
    const card = "今天路上有什么让你想多看一眼的事吗？";
    const wire: string[] = [];
    useDecisions(input => {
      wire.push(JSON.stringify(agentDecisionRequest(input).messages));
      if (!input.results.length) return { tool: "list_review_sources", args: { scope: "selected" } };
      if (!input.results.some(result => result.tool === "read_source")) return { tool: "read_source", args: { sourceId: selected.id } };
      const corrected = input.results.some(result => result.tool === "respond" && result.status === "failed");
      return { tool: "respond", args: { reply: "Ta 的原话是「" + selected.quote + "」",
        suggestions: corrected ? [card] : [], sourceIds: [selected.id] } };
    });
    const ask = { operationKey: "mixed", text, interactionIds: [selected.interactionId] };
    const result = await create(request("POST", "alice", ask));
    expect(result.status).toBe(200);
    const { view } = await result.json() as { view: PreparationView };
    expect(view.generationStatus).toBe("idle");
    const [user, assistant] = view.messages;
    expect(view.messages.map(m => m.role)).toEqual(["user", "assistant"]);
    expect(user.text).toBe(text);
    expect(assistant.text.split(selected.quote)).toHaveLength(2);
    expect(assistant.text).not.toContain(card);
    expect(assistant.sources).toMatchObject([{ id: selected.id, quote: selected.quote, speakerRole: "companion" }]);
    expect(view.items.map(i => [i.text, i.status, i.sourceMessageId])).toEqual([[card, "suggested", assistant.id]]);
    expect(view.items[0].sources.map(s => s.id)).toEqual([selected.id]);
    expect(wire.join("")).toContain(selected.quote);
    expect(wire.join("")).not.toContain(excluded.quote);
    expect(wire.join("")).not.toContain(excluded.id);
    expect(service.store.listTasks("alice", view.id)[0].actions.map(a => [a.tool, a.status])).toEqual([
      ["list_review_sources", "succeeded"], ["read_source", "succeeded"], ["respond", "failed"], ["respond", "succeeded"]
    ]);
    const context = { params: Promise.resolve({ id: view.id }) };
    const calls = wire.length;
    expect((await (await create(request("POST", "alice", ask))).json()).view).toEqual(view);
    expect((await (await get(request("GET"), context)).json()).view).toEqual(view);
    expect(wire).toHaveLength(calls);
    const row = db.prepare("SELECT body_json FROM dc_preparations WHERE id=? AND user_id=?").get(view.id, "alice") as {body_json: string};
    const saved = JSON.parse(row.body_json) as PreparationView;
    expect(saved.messages.map(m => [m.id, m.text])).toEqual([[user.id, text], [assistant.id, assistant.text]]);
    expect(saved.items.map(i => [i.id, i.text])).toEqual([[view.items[0].id, card]]);
    expect(saved.messages[1].sources.map(s => s.id)).toEqual([selected.id]);
  });
  it("reads operation receipts without replay, with account isolation and deletion tombstones", async () => {
    const receipt = (key: string, user = "alice") => list(new Request(
      `http://localhost/api/date-companion/preparations?operationKey=${encodeURIComponent(key)}`,
      { headers: user ? { "x-test-user": user } : {} }));
    expect((await receipt("create", "")).status).toBe(401);
    expect((await receipt("")).status).toBe(400);
    expect(await (await receipt("create")).json()).toEqual({ found: false });
    const { view } = await (await create(request("POST", "alice", { operationKey: "create", text: "一起去散步" }))).json();
    const before = db.prepare("SELECT COUNT(*) AS n FROM agent_calls").get();
    const saved = await (await receipt("create")).json();
    expect(saved).toMatchObject({ found: true, id: view.id, deleted: false, view: { version: view.version } });
    expect(saved).not.toHaveProperty("taskId");
    expect(await (await receipt("create", "bob")).json()).toEqual({ found: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_calls").get()).toEqual(before);
    const context = { params: Promise.resolve({ id: view.id }) };
    await remove(request("DELETE", "alice", { operationKey: "remove", expectedVersion: view.version }), context);
    expect(await (await receipt("remove")).json()).toEqual({ found: true, id: view.id, deleted: true });
    expect(await (await receipt("create")).json()).toEqual({ found: true, id: view.id, deleted: true });
  });
});
