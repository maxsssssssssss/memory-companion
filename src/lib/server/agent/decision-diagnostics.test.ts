// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { AgentStore } from "./store";
import { AgentRuntime } from "./runtime";
import { createAgentDecisionProvider } from "./model";
import { decisionSchemaIssues } from "./decision-diagnostics";
import type { AgentScenario } from "./types";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.unstubAllGlobals(); });
const PRIVATE = "private_material_or_key_must_not_be_stored";

function fixture(value: unknown, options: { eventType?: string; parameters?: z.ZodType; raw?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "agent-decision-diagnostics-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "tasks.sqlite"), checkpointPath = join(directory, "checkpoint.sqlite");
  const store = AgentStore.open(dbPath);
  cleanups.push(() => { if (store.database.open) store.close(); });
  const requestIds: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe("https://synthetic-provider.invalid/v1/responses");
    requestIds.push(request.headers.get("x-client-request-id")!);
    const event = { type: options.eventType ?? "response.completed", response: { status: "completed",
      usage: { input_tokens: 17, output_tokens: 6 },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: options.raw ?? JSON.stringify(value) }] }] } };
    return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetch);
  const execute = vi.fn(async () => ({ summary: "Synthetic read completed", wait: { kind: "feedback", message: "Waiting" } }));
  const scenario: AgentScenario = { id: "synthetic-diagnostic", validate: async () => {}, observe: async () => ({ available: true }), tools: {
    "synthetic.read": { description: "Read authorized record", parameters: options.parameters ?? z.object({ id: z.literal("allowed") }).strict(), execute },
  } };
  const decision = createAgentDecisionProvider(() => ({ baseURL: "https://synthetic-provider.invalid/v1", apiKey: PRIVATE,
    model: "synthetic", maxInputChars: 48000, maxOutputTokens: 1000, requestTimeoutMs: 1000 }));
  const runtime = new AgentRuntime({ store, checkpointPath, scenario, decision });
  cleanups.push(() => { try { runtime.close(); } catch {} });
  const task = store.createTask({ accountId: "alice", scenario: scenario.id, resourceId: "synthetic-resource", goal: "Read the synthetic record", scope: {} });
  return { store, runtime, task, fetch, requestIds, execute, dbPath };
}

describe("durable safe decision rejection diagnostics", () => {
  it.each([
    { value: { tool: PRIVATE, args: { body: PRIVATE } }, layer: "tool_selection", reason: "tool_not_registered", tool: null },
    { value: { tool: "synthetic.read", args: { id: PRIVATE, [PRIVATE]: PRIVATE } }, layer: "tool_parameters", reason: "tool_arguments_invalid", tool: "synthetic.read" },
    { value: { tool: "synthetic.read", args: { id: "allowed" }, finish: PRIVATE }, layer: "action_schema", reason: "action_schema_invalid", tool: null },
  ])("persists $layer, exact request/call/version identity, zero side effects and no retry", async ({ value, layer, reason, tool }) => {
    const h = fixture(value);
    const result = await h.runtime.advance("alice", h.task.id);
    expect(result.status).toBe("needs_attention");
    expect(result.actions).toEqual([]);
    expect(result.usage).toMatchObject({ calls: 1, inputTokens: 17, outputTokens: 6 });
    expect(h.execute).not.toHaveBeenCalled();
    const records = h.store.decisionDiagnostics("alice", h.task.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ requestId: h.requestIds[0], callId: h.requestIds[0], taskId: h.task.id,
      taskVersion: 1, decisionId: "decision:1", callStatus: layer === "action_schema" ? "failed" : "succeeded",
      diagnostic: { layer, reasonCode: reason, tool } });
    expect(h.requestIds[0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(records)).not.toContain(PRIVATE);
    if (layer === "tool_parameters") expect(records[0].diagnostic.issues).toContainEqual({ code: "invalid_literal", path: ["id"] });
    await h.runtime.advance("alice", h.task.id);
    expect(h.fetch).toHaveBeenCalledOnce();
    h.runtime.close(); h.store.close();
    const reopened = AgentStore.open(h.dbPath);
    try {
      expect(reopened.decisionDiagnostics("alice", h.task.id)).toEqual(records);
      expect(() => reopened.decisionDiagnostics("bob", h.task.id)).toThrow();
      expect(reopened.getTask("alice", h.task.id).usage.calls).toBe(1);
    } finally { reopened.close(); }
  });

  it("keeps indexed refinement paths but never their interpolated messages or values", async () => {
    const parameters = z.object({ objectives: z.array(z.object({ requirements: z.array(z.object({ independent: z.boolean() }).strict()) }).strict()) }).strict()
      .superRefine((_value, ctx) => ctx.addIssue({ code: "custom", path: ["objectives", 0, "requirements", 0, "independent"], message: PRIVATE }));
    const h = fixture({ tool: "synthetic.read", args: { objectives: [{ requirements: [{ independent: false }] }] } }, { parameters });
    await h.runtime.advance("alice", h.task.id);
    const [record] = h.store.decisionDiagnostics("alice", h.task.id);
    expect(record.diagnostic.issues).toEqual([{ code: "custom", path: ["objectives", 0, "requirements", 0, "independent"] }]);
    expect(JSON.stringify(record)).not.toContain(PRIVATE);
  });

  it("bounds dynamic record paths and issue counts without serializing model keys", () => {
    const schema = z.object({ records: z.record(z.literal("allowed")) }).strict();
    const parsed = schema.safeParse({ records: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`${PRIVATE}${i}`, PRIVATE])) });
    if (parsed.success) throw new Error("expected strict rejection");
    const diagnostic = decisionSchemaIssues(schema, parsed.error);
    expect(diagnostic.issues).toHaveLength(32);
    expect(diagnostic.issuesTruncated).toBe(true);
    expect(diagnostic.issues[0]).toEqual({ code: "invalid_literal", path: ["records", "[dynamic-key]"] });
    expect(JSON.stringify(diagnostic)).not.toContain(PRIVATE);
  });

  it.each([
    { options: { raw: `not_json_${PRIVATE}` }, layer: "action_json", code: "action_json_invalid", status: "failed" },
    { options: { eventType: "response.incomplete" }, layer: "response", code: "response_not_completed", status: "unknown" },
  ])("distinguishes $layer from tool validation and retains unknown without reissuing", async ({ options, layer, code, status }) => {
    const h = fixture({ finish: PRIVATE }, options);
    await h.runtime.advance("alice", h.task.id);
    const [record] = h.store.decisionDiagnostics("alice", h.task.id);
    expect(record).toMatchObject({ callStatus: status, diagnostic: { layer, reasonCode: code, tool: null, issues: [] } });
    expect(JSON.stringify(record)).not.toContain(PRIVATE);
    await h.runtime.advance("alice", h.task.id);
    expect(h.fetch).toHaveBeenCalledOnce(); expect(h.execute).not.toHaveBeenCalled();
  });

  it("adds nullable diagnostics to old call rows without inventing historical failures or changing usage", async () => {
    const h = fixture({ tool: "synthetic.read", args: { id: "allowed" } });
    const before = await h.runtime.advance("alice", h.task.id);
    expect(before.status).toBe("waiting");
    expect(h.store.decisionDiagnostics("alice", h.task.id)).toEqual([]);
    h.runtime.close();
    // Recreate the prior persisted schema, without changing task/usage/business facts.
    h.store.database.exec("ALTER TABLE agent_calls DROP COLUMN diagnostics_json");
    h.store.close();
    const reopened = AgentStore.open(h.dbPath);
    try {
      expect(reopened.getTask("alice", h.task.id)).toEqual(before);
      expect(reopened.decisionDiagnostics("alice", h.task.id)).toEqual([]);
    } finally { reopened.close(); }
  });
});
