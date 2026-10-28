// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import type { AgentTask } from "@/lib/domain/agent";
import type { AgentContext, AgentDecisionInput } from "@/lib/server/agent/types";
import { agentDecisionRequest } from "@/lib/server/agent/model";
import { createLearningAgentDecisionProvider, fitLearningAgentDecisionInput } from "./agent-context";

afterEach(() => vi.unstubAllGlobals());
const task: AgentTask = { id: "synthetic-context-task", version: 2, accountId: "owner", scenario: "learning.adaptive-review.v1", resourceId: "page",
  goal: "依据本次反馈继续复习", scope: { includeHistory: true, fingerprint: "authorized" }, status: "running", actions: [],
  budget: { maxCalls: 16, maxInputChars: 48000, maxOutputTokens: 8000, maxComputeMs: 600000, maxSteps: 16, maxNoProgress: 3 },
  usage: { calls: 8, inputTokens: 100, outputTokens: 20, unknownUsageCalls: 0, computeMs: 1000, steps: 6 }, createdAt: "synthetic", updatedAt: "synthetic" };
function answers(n: number, size = 20000): AgentDecisionInput["results"][number] {
  return { actionId: "answer-" + n, tool: "learning.read_answers", status: "succeeded", value: {
    attemptId: "attempt-" + n, quizId: "quiz-" + n, score: { correct: 1, total: 5 },
    questions: [{ index: 1, stem: "合成条件".repeat(size / 4), selectedOptionId: "stable-option", progress: { hinted: true, skipped: false, revealed: false }, feedback: { explanation: "原始解析与来源" } }]
  } };
}
function fixture(): AgentDecisionInput {
  return { task, observation: { taskVersion: 2, materials: [{ materialId: "source" }] }, tools: [],
    event: { id: "submission", kind: "quiz_submission", refId: "attempt-4", version: 2 },
    results: [answers(1), answers(2), answers(3), answers(4, 5000),
      { actionId: "explain", tool: "learning.explain", status: "succeeded", value: { id: "explanation", question: "为什么", materialAnswer: "当前完整讲解", items: [{ materialId: "source", paragraph: 1 }] } },
      { actionId: "navigation", tool: "learning.read_navigation", status: "succeeded", value: { historyAllowed: true, chapters: [] } }] };
}
it("fits multiple rounds while preserving newest answers, explanation, feedback and authorization without mutating evidence", () => {
  const input = fixture(), before = JSON.stringify(input);
  expect(agentDecisionRequest(input).inputChars).toBeGreaterThan(47000);
  const compact = fitLearningAgentDecisionInput(input, 47000);
  expect(agentDecisionRequest(compact).inputChars).toBeLessThanOrEqual(47000);
  expect(compact.results[0].value).toMatchObject({ detailsOmitted: true, attemptId: "attempt-1", questions: [{ selectedOptionId: "stable-option", progress: { hinted: true } }],
    readDetails: { tool: "learning.read_answers", args: { attemptId: "attempt-1" } } });
  expect(compact.results.slice(-3)).toEqual(input.results.slice(-3));
  expect(compact.event).toEqual(input.event); expect(compact.task).toEqual(input.task); expect(compact.observation).toEqual(input.observation);
  expect(JSON.stringify(input)).toBe(before);
});
it("retains disputed status and unresolved failures instead of making them usable diagnoses", () => {
  const input = fixture(); input.results[0] = { ...answers(1), value: { ...(answers(1).value as object), disputed: true } };
  input.results.splice(2, 0, { actionId: "unknown", tool: "learning.create_quiz", status: "unknown", value: { status: "unknown", summary: "核对原回执" } });
  const compact = fitLearningAgentDecisionInput(input, 47000);
  expect(compact.results[0].value).toMatchObject({ disputed: true, detailsOmitted: true });
  expect(compact.results[0].value).not.toHaveProperty("score");
  expect(compact.results[0].value).not.toHaveProperty("questions.0.selectedOptionId");
  expect(compact.results.find(r => r.actionId === "unknown")).toEqual(input.results[2]);
});
it("compacts earlier source and explanation bodies as explicitly omitted references, never truncated evidence", () => {
  const input = fixture(); input.results = [
    { actionId: "source-old", tool: "learning.read_source", status: "succeeded", value: { materialId: "source", title: "合成", scopeNotice: { unverified: true }, paragraph: { number: 2, text: "原文".repeat(20000), parsed: { physicalPage: 4 } } } },
    { actionId: "explain-old", tool: "learning.explain", status: "succeeded", value: { id: "earlier", taskVersion: 2, question: "之前的问题", materialAnswer: "旧讲解".repeat(20000), items: [{ materialId: "source", paragraph: 2 }], supplements: [{ kind: "example", text: "额外例子" }] } },
    ...input.results.slice(-3) ];
  const compact = fitLearningAgentDecisionInput(input, 47000);
  expect(agentDecisionRequest(compact).inputChars).toBeLessThanOrEqual(47000);
  expect(compact.results[0].value).toMatchObject({ detailsOmitted: true, scopeNotice: { unverified: true }, paragraph: { number: 2, parsed: { physicalPage: 4 } }, readDetails: { args: { materialId: "source", paragraph: 2 } } });
  expect(compact.results[0].value).not.toHaveProperty("paragraph.text");
  expect(compact.results[1].value).toMatchObject({ detailsOmitted: true, includesSupplement: true, items: [{ materialId: "source", paragraph: 2 }] });
  expect(compact.results[1].value).not.toHaveProperty("materialAnswer");
});
it("uses the fitted size at the real provider boundary without dispatching extra requests", async () => {
  const input = fixture(); const network = vi.fn(); vi.stubGlobal("fetch", network);
  let measured = 0;
  const ctx: AgentContext = { task, actionId: "decision", event: input.event, signal: new AbortController().signal, assertActive: async () => {},
    call: async request => { measured = request.inputChars; throw Error("captured-before-network"); } };
  const decision = createLearningAgentDecisionProvider(() => ({ apiKey: "synthetic", baseURL: "https://synthetic.invalid/v1", model: "synthetic", maxInputChars: 47000, maxOutputTokens: 2000, requestTimeoutMs: 1000 }));
  await expect(decision(input, ctx)).rejects.toThrow("captured-before-network");
  expect(measured).toBeGreaterThan(0); expect(measured).toBeLessThanOrEqual(47000); expect(network).not.toHaveBeenCalled();
});
it("fails before any call if required current context cannot fit, respecting the smaller task limit", async () => {
  const input = fixture(); input.task = { ...task, budget: { ...task.budget, maxInputChars: 1000 } };
  const call = vi.fn(), network = vi.fn(); vi.stubGlobal("fetch", network);
  const ctx: AgentContext = { task: input.task, actionId: "decision", signal: new AbortController().signal, assertActive: async () => {}, call };
  const decision = createLearningAgentDecisionProvider(() => ({ apiKey: "synthetic", baseURL: "https://synthetic.invalid/v1", model: "synthetic", maxInputChars: 47000, maxOutputTokens: 2000, requestTimeoutMs: 1000 }));
  await expect(decision(input, ctx)).rejects.toMatchObject({ code: "budget", message: "agent_decision_input_limit" });
  expect(call).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
});

it("sends an actual offline SDK request above 47000 characters within the new limit, retaining both rounds", async () => {
  const input = fixture(); input.task = { ...task, budget: { ...task.budget, maxInputChars: 200000 } };
  const original = JSON.stringify(input), requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(await new Request(url, init).text());
    const response = { type: "response.completed", response: { status: "completed", error: null, incomplete_details: null,
      usage: { input_tokens: 25000, output_tokens: 20 }, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ wait: { kind: "feedback", message: "还有未完成的检查，请确认下一步。" } }) }] }] } };
    return new Response(`data: ${JSON.stringify(response)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  }));
  let measured = 0;
  const ctx: AgentContext = { task: input.task, actionId: "offline", signal: new AbortController().signal, assertActive: async () => {},
    call: async (request, invoke) => { measured = request.inputChars; return (await invoke()).value; } };
  const decide = createLearningAgentDecisionProvider(() => ({ apiKey: "synthetic", baseURL: "https://synthetic.invalid/v1", model: "deepseek-v4-pro", maxInputChars: 200000, maxOutputTokens: 2000, requestTimeoutMs: 1000 }));
  await expect(decide(input, ctx)).resolves.toHaveProperty("wait");
  expect(requests).toHaveLength(1); expect(requests[0].length).toBeGreaterThan(47000); expect(requests[0].length).toBeLessThanOrEqual(measured);
  expect(measured).toBeLessThanOrEqual(200000);
  const payload = JSON.parse(JSON.parse(requests[0]).input.find((m: { role: string }) => m.role === "user").content);
  expect(payload.results).toEqual(input.results); expect(payload.feedback).toEqual(input.event);
  expect(JSON.stringify(input)).toBe(original);
});

it("rejects an oversized Unicode context before reserving or sending a request even with a high character setting", async () => {
  const input = fixture(); input.task = { ...task, budget: { ...task.budget, maxInputChars: 1000000 } };
  input.results = [answers(1, 400000)];
  const call = vi.fn(), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const decide = createLearningAgentDecisionProvider(() => ({ apiKey: "synthetic", baseURL: "https://synthetic.invalid/v1", model: "deepseek-v4-pro", maxInputChars: 1000000, maxOutputTokens: 8000, requestTimeoutMs: 1000 }));
  await expect(decide(input, { task: input.task, actionId: "offline", signal: new AbortController().signal, assertActive: async () => {}, call })).rejects.toThrow("agent_decision_context_limit");
  expect(call).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
