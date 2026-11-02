// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { openWorkReviewDatabase } from "./db";
import { seedWorkAgentCase } from "./agent-test-fixture";
import { openWorkAgentRuntime, readWorkAgentProject, startWorkAgent } from "./agent-service";
import { responseStreamFixture } from "../openai/structured-json-stream.test-fixture";
import { WorkAgentRepository } from "./agent-repository";

let root: string, db: ReturnType<typeof openWorkReviewDatabase>, fixture: ReturnType<typeof seedWorkAgentCase>;
let runner: ReturnType<typeof openWorkAgentRuntime>, taskId: string;
let mode: "complete" | "eof" | "disconnect" | "timeout" | "cancel" | "cancel_after_complete" | "cleanup" | "invalid_schema" | "invalid_json" | "bad_terminal" | "event_limit";
let info: MockInstance<typeof console.info>, requests: number;
const tokens = { input_tokens: 6102, output_tokens: 1365, total_tokens: 7467 };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "work-agent-stream-")); db = openWorkReviewDatabase({ filePath: join(root, "work.sqlite") }); fixture = seedWorkAgentCase(db);
  runner = openWorkAgentRuntime(db, { checkpointPath: join(root, "checkpoint.sqlite") });
  for (const [key, value] of Object.entries({ WORK_REVIEW_EXTRACTOR_PROVIDER: "tokenhub-structured-json", WORK_REVIEW_EXTRACTOR_MODEL: "deepseek-v4-pro",
    WORK_REVIEW_EXTRACTOR_MAX_OUTPUT_TOKENS: "6000", WORK_REVIEW_EXTRACTOR_REASONING_EFFORT: "none", WORK_REVIEW_EXTRACTOR_TIMEOUT_MS: "90000",
    OPENAI_BASE_URL: "https://tokenhub.vision-intelligence.tech/v1", OPENAI_API_KEY: "offline-private-key" })) vi.stubEnv(key, value);
  requests = 0; mode = "complete";
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    requests++;
    const req = new Request(input, init), body = await req.json();
    expect(req.url).toBe("https://tokenhub.vision-intelligence.tech/v1/responses");
    expect(body).toMatchObject({ model: "deepseek-v4-pro", stream: true, store: false, max_output_tokens: 6000 });
    expect(req.headers.get("x-client-request-id")).toMatch(/^[a-f0-9-]{36}$/);
    const comparison = requests === 2;
    const value = comparison ? fixture.m3 : requests > 2
      ? { wait: { kind: "feedback", message: "已知模型结果无效，等待人工处理。" } } : { tool: "work.compare_meeting", args: {} };
    const text = comparison && mode === "invalid_json" ? '{"items":' : JSON.stringify(comparison && mode === "invalid_schema" ? { items: [], changes: [] } : value);
    const response = { status: "completed", error: null, incomplete_details: null, usage: comparison ? tokens : { input_tokens: 11, output_tokens: 7 },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] };
    const stream = responseStreamFixture(response, comparison ? 2 : 100_000);
    const headers = { "content-type": "text/event-stream" };
    if (!comparison) return new Response(stream.body, { headers });
    if (mode === "event_limit") return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { ...response, padding: "x".repeat(200_000) } })}\n\n`, { headers });
    if (mode === "bad_terminal") return new Response(`data: ${JSON.stringify({ type: "response.failed", response })}\n\n`, { headers });
    if (["complete", "invalid_schema", "invalid_json"].includes(mode)) return new Response(stream.body, { headers });
    const first = mode === "cleanup" || mode === "cancel_after_complete" ? stream.body : 'data: {"type":"response.output_text.delta","delta":"PRIVATE_PARTIAL"}\n\n';
    let sent = false;
    const bytes = new TextEncoder().encode(first);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        req.signal.addEventListener("abort", () => controller.error(new DOMException("PRIVATE_ABORT", "AbortError")), { once: true });
      },
      pull(controller) {
        if (!sent) {
          sent = true; controller.enqueue(bytes);
          if (mode === "cancel") runner.runtime.control(fixture.accountId, taskId, "cancel", 1);
        } else if (mode === "eof") controller.close();
        else if (mode === "disconnect") controller.error(new TypeError("PRIVATE_DISCONNECT"));
        // Timeout stays open until the real request signal aborts it.
      },
      cancel() {
        if (mode === "cleanup") throw new Error("PRIVATE_CLEANUP_ERROR");
        if (mode === "cancel_after_complete") runner.runtime.control(fixture.accountId, taskId, "cancel", 1);
      }
    }, { highWaterMark: 0 });
    return new Response(source, { headers });
  }));
});
afterEach(() => { runner.runtime.close(); db.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function run() {
  taskId = startWorkAgent(db, fixture.accountId, fixture.project.id, { id: randomUUID(), meetingId: fixture.meetings[2], goal: "帮我整理今天开完会之后的工作" }).id;
  return runner.runtime.advance(fixture.accountId, taskId);
}
const comparisonCall = () => db.prepare("SELECT status,input_tokens,output_tokens FROM agent_calls WHERE task_id=? AND kind='work_agent_comparison'").get(taskId);
const diagnostics = () => info.mock.calls.flatMap(args => args[0] === "[work-agent-response]" ? [JSON.parse(args[1] as string)] : []);

describe("Work model SSE -> shared Runtime -> actual SQLite", { timeout: 15_000 }, () => {
  it("saves a complete fragmented comparison and accounts reported usage before publishing", async () => {
    const original = WorkAgentRepository.prototype.saveComparison;
    const save = vi.spyOn(WorkAgentRepository.prototype, "saveComparison").mockImplementation(function (this: WorkAgentRepository, ...args) {
      expect(comparisonCall()).toEqual({ status: "succeeded", input_tokens: 6102, output_tokens: 1365 });
      return original.apply(this, args);
    });
    const task = await run();
    expect(task.status).toBe("waiting"); expect(task.wait?.kind).toBe("work_selection"); expect(save).toHaveBeenCalledOnce();
    expect(task.usage).toMatchObject({ calls: 2, inputTokens: 6113, outputTokens: 1372, unknownUsageCalls: 0 });
    expect(new WorkAgentRepository(db).read(task)?.comparison?.changes).toHaveLength(6);
    expect(diagnostics()[1]).toMatchObject({ stream: { phase: "complete", completionReceived: true }, inputTokens: 6102, outputTokens: 1365 });
    expect(diagnostics()[1].stream.totalEventBytes).toBeGreaterThan(200_000);
    expect(fixture.todos.getTodo(fixture.accountId, fixture.deployment.id).title).toBe("A方案部署");
    expect(requests).toBe(2);
  });
  it.each(["eof", "disconnect", "timeout", "cancel", "cancel_after_complete", "cleanup", "bad_terminal", "event_limit"] as const)("keeps %s unknown, stops publication and never automatically retries", async failure => {
    mode = failure;
    if (failure === "timeout") vi.stubEnv("WORK_REVIEW_EXTRACTOR_TIMEOUT_MS", "1000");
    const task = await run();
    const usageKnown = ["cleanup", "cancel_after_complete", "bad_terminal"].includes(failure);
    expect(comparisonCall()).toEqual({ status: "unknown", input_tokens: usageKnown ? 6102 : null, output_tokens: usageKnown ? 1365 : null });
    expect(task.status).toBe(failure.startsWith("cancel") ? "cancelled" : "needs_attention");
    expect(new WorkAgentRepository(db).read(task)).toBeNull();
    expect(db.prepare("SELECT count(*) n FROM wr_work_thread_events").get()).toEqual({ n: 0 });
    expect(fixture.todos.getTodo(fixture.accountId, fixture.deployment.id).title).toBe("A方案部署");
    const expected = { eof: "missing_completion", disconnect: "transport_error", timeout: "timeout", cancel: "aborted", cancel_after_complete: "aborted",
      cleanup: "cleanup_error", bad_terminal: "provider_terminal", event_limit: "byte_limit" }[failure];
    expect(diagnostics()[1]).toMatchObject({ parseResult: "not_started", stream: { failureReason: expected } });
    expect(JSON.stringify(diagnostics())).not.toMatch(/PRIVATE|offline-private-key|https:|方案/);
    await runner.runtime.advance(fixture.accountId, taskId);
    readWorkAgentProject(db, fixture.accountId, fixture.project.id);
    expect(requests).toBe(2);
  });
  it.each(["invalid_schema", "invalid_json"] as const)("keeps %s a known unusable result with reported usage", async failure => {
    mode = failure; await run();
    expect(comparisonCall()).toEqual({ status: "failed", input_tokens: 6102, output_tokens: 1365 });
    expect(db.prepare("SELECT count(*) n FROM wr_work_agent_artifacts").get()).toEqual({ n: 0 });
    // Known failures return to the existing decision loop; the scripted next decision
    // waits. The failed HTTP request itself is never retried by the transport.
    expect(requests).toBe(3);
    expect(db.prepare("SELECT count(*) n FROM agent_calls WHERE kind='work_agent_comparison'").get()).toEqual({ n: 1 });
    expect(diagnostics()[1].stream.completionReceived).toBe(true);
  });
});
