// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ThinkingMatterComparisonInputSchema, type ThinkingMatterComparisonInput } from "@/lib/domain/reflection-thinking-matter";
import { openDailyReflectionDatabase } from "./db";
import { ThinkingAgentService } from "./thinking-agent";

const { installGuard } = createRequire(import.meta.url)(resolve("scripts/reflection-thinking-real-network-guard.cjs"));
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.unstubAllEnvs(); });
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const completed = (value: unknown) => ({ type: "response.completed", response: { status: "completed", error: null, incomplete_details: null,
  usage: { input_tokens: 31, output_tokens: 17 },
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] }],
} });

function fixture(transport: (payload: { observation: { matter: { comparison: ThinkingMatterComparisonInput | null } } }, index: number) => Response) {
  const root = mkdtempSync(join(tmpdir(), "thinking-transport-offline-")), data = join(root, "data");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(data);
  writeFileSync(join(root, "AUTHORIZATION.json"), JSON.stringify({ mode: "real", maxRequests: 12, model: "deepseek-v4-pro" }));
  for (const [key, value] of Object.entries({ APP_DATA_DIR: data, OPENAI_BASE_URL: "https://tokenhub.vision-intelligence.tech/v1",
    OPENAI_API_KEY: "offline-only-synthetic-key", OPENAI_AUTH_HEADER_MODE: "raw" })) vi.stubEnv(key, value);
  const db = openDailyReflectionDatabase({ filePath: join(data, "daily-reflection.sqlite") });
  cleanup.push(() => db.close());
  const service = new ThinkingAgentService(db, { resolver: { resolve: () => ({ sources: [], promptExcerpts: [], usedPersonalContext: false, pastClues: null }) } });
  cleanup.push(() => service.close());
  const payloads: unknown[] = [];
  // Exercise the real SDK, guard, Runtime and SQLite services. The socket-facing
  // transport is always this fake; no credentials or Provider network are used.
  const fetch = vi.fn<typeof globalThis.fetch>(async input => {
    const request = input as Request, body = await request.json();
    const payload = JSON.parse(body.input.find((message: { role: string }) => message.role === "user").content);
    payloads.push(payload);
    return transport(payload, payloads.length - 1);
  });
  const guard = installGuard({ environment: { THINKING_P1_REAL_DIR: root, APP_DATA_DIR: data, OPENAI_API_KEY: "offline-only-synthetic-key" },
    fetch, stdout: () => {} });
  cleanup.push(() => guard.close());
  const created = service.repository.create("synthetic_account", { question: "比较方案A与方案B", operationKey: "create" });
  return { service, db, fetch, guard, created, payloads };
}

function comparison(): ThinkingMatterComparisonInput {
  return { question: "选择哪个展示方向", dimensions: ["表达内容", "准备成本"],
    options: ["方案A", "方案B"].map(name => ({ name, content: `${name}内容`, reasons: ["当前理由"], limits: [], costs: [], unknowns: ["参与情况"] })), recommendation: null };
}

it("keeps two comparison turns, explicit choices and an adopted action with large SSE overhead through the actual SDK and guard", async () => {
  const h = fixture((payload, index) => {
    const next = index === 0 ? comparison() : ThinkingMatterComparisonInputSchema.parse(payload.observation.matter.comparison);
    if (index === 1) next.options[1].reasons = ["新约束下展示内容更合适"];
    const value = { tool: "respond", args: { reply: (index === 0 ? "先比较两个方向。" : "新约束改变了比较理由，仍保留你的选择。") + "合成比较依据。".repeat(240),
      understanding: "比较当前方向", judgments: [], suggestions: index === 0 ? [{ text: "先展示一段合成内容", kind: "action" }] : [], comparison: next } };
    const text = JSON.stringify(value);
    const deltas = [...text].map((delta, sequence_number) => frame({ type: "response.output_text.delta", sequence_number,
      item_id: "synthetic_assistant_message", output_index: 0, content_index: 0, delta }));
    // Token-sized events plus ordinary protocol fields exceed the old 200 KB
    // cumulative limit, while generated JSON and every individual event stay small.
    const wire = [...deltas, frame(completed(value))].join("");
    expect(Buffer.byteLength(wire)).toBeGreaterThan(200_000);
    return new Response(wire, { headers: { "content-type": "text/event-stream" } });
  });
  let view = await h.service.turn("synthetic_account", h.created.matter.id, { operationKey: "first", expectedVersion: h.created.matter.version, text: "比较A/B" });
  expect(view.matter.activeGeneration).toBeNull();
  const options = view.matter.comparison!.options;
  for (const [index, option] of options.entries()) view = h.service.mutate("synthetic_account", view.matter.id, {
    kind: "choice", operationKey: `choose_${index}`, expectedVersion: view.matter.version, status: "selected", optionId: option.id,
    reason: index ? "新约束下明确改选B" : "先选择A", });
  view = h.service.mutate("synthetic_account", view.matter.id, { kind: "adopt", operationKey: "adopt", expectedVersion: view.matter.version, suggestionId: view.matter.suggestions[0].id });
  view = await h.service.turn("synthetic_account", view.matter.id, { operationKey: "second", expectedVersion: view.matter.version, text: "补充新约束，只重新比较，不增加安排。" });
  expect(view.matter.activeGeneration).toBeNull();
  expect(view.matter.userChoice).toMatchObject({ status: "selected", optionId: options[1].id, reason: "新约束下明确改选B" });
  expect(view.matter.comparison!.options[1].reasons).toEqual(["新约束下展示内容更合适"]);
  expect(view.matter.comparison!.options.map(option => option.id)).toEqual(options.map(option => option.id));
  expect(view.matter.arrangements).toHaveLength(1); expect(view.matter.arrangements[0].status).toBe("adopted");
  expect(view.events.filter(event => event.kind === "choice_changed")).toHaveLength(2);
  expect((await h.service.get("synthetic_account", view.matter.id)).matter).toEqual(view.matter);
  await expect(h.service.get("another_account", view.matter.id)).rejects.toThrow();
  expect(h.db.prepare("SELECT status,input_tokens,output_tokens FROM agent_calls ORDER BY rowid").all()).toEqual([
    { status: "succeeded", input_tokens: 31, output_tokens: 17 }, { status: "succeeded", input_tokens: 31, output_tokens: 17 },
  ]);
  expect(h.fetch).toHaveBeenCalledTimes(2); expect(h.guard.snapshot()).toMatchObject({ sent: 2, completed: 2, unknown: 0 });
});

it("persists unknown stream details and inspection never issues another request", async () => {
  const h = fixture(() => new Response(frame({ type: "response.output_text.delta", delta: "PRIVATE_PARTIAL_OUTPUT" }), { headers: { "content-type": "text/event-stream" } }));
  const view = await h.service.turn("synthetic_account", h.created.matter.id, { operationKey: "first", expectedVersion: h.created.matter.version, text: "比较一下" });
  expect(view.matter.activeGeneration?.status).toBe("unknown");
  const task = h.service.task("synthetic_account", view.matter.id)!;
  const diagnostics = h.service.store.decisionDiagnostics("synthetic_account", task.id);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ callStatus: "unknown", diagnostic: { layer: "response", reasonCode: "response_not_completed",
    response: { parseResult: "not_started", validationResult: "not_started", stream: { completionReceived: false, failureReason: "missing_completion" } } } });
  expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_PARTIAL_OUTPUT");
  const reopened = await h.service.recover("synthetic_account", view.matter.id, "inspect_only");
  expect(reopened.matter.activeGeneration?.status).toBe("unknown");
  expect(h.service.task("synthetic_account", view.matter.id)!.usage.calls).toBe(1);
  expect(h.fetch).toHaveBeenCalledOnce(); expect(h.guard.snapshot()).toMatchObject({ sent: 1, unknown: 1, halted: true });
});

it("rejects sourceEventId in completed tool arguments as a separate known parameter failure without saving a reply", async () => {
  const h = fixture(() => {
    const value = comparison();
    const action = { tool: "respond", args: { reply: "不可保存的比较", understanding: "比较方向", judgments: [], suggestions: [],
      comparison: { ...value, options: value.options.map(option => ({ ...option, sourceEventId: "forged_private_event" })) } } };
    return new Response(frame(completed(action)), { headers: { "content-type": "text/event-stream" } });
  });
  const view = await h.service.turn("synthetic_account", h.created.matter.id, { operationKey: "first", expectedVersion: h.created.matter.version, text: "比较一下" });
  expect(view.events.some(event => event.kind === "assistant_message")).toBe(false);
  expect(view.matter.comparison).toBeNull(); expect(view.matter.arrangements).toEqual([]);
  expect(view.matter.activeGeneration).toBeNull();
  const task = h.service.task("synthetic_account", view.matter.id)!;
  const [record] = h.service.store.decisionDiagnostics("synthetic_account", task.id);
  expect(record).toMatchObject({ callStatus: "succeeded", diagnostic: { layer: "tool_parameters", reasonCode: "tool_arguments_invalid" } });
  expect(record.diagnostic.issues).toContainEqual({ code: "unrecognized_keys", path: ["comparison", "options", 0] });
  expect(JSON.stringify(record)).not.toContain("forged_private_event");
  expect(h.fetch).toHaveBeenCalledOnce(); expect(h.guard.snapshot()).toMatchObject({ sent: 1, completed: 1, unknown: 0 });
});
