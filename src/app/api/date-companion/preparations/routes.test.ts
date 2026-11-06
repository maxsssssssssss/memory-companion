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
import { GET as list, POST as create } from "./route";
import { GET as get, PATCH as mutate, DELETE as remove } from "./[id]/route";
import { POST as turn } from "./[id]/turns/route";
import type { PreparationView } from "@/lib/domain/date-companion-preparation";
function request(method: string, user = "alice", body?: unknown) {
  return new Request("http://localhost/api/date-companion/preparations", {
    method, headers: { ...(user ? { "x-test-user": user } : {}), "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {})
  });
}
describe("preparation API with real SQLite service and Runtime", () => {
  let db: Database.Database, service: PreparationAgentService;
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
});
