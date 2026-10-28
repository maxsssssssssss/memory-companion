// @vitest-environment node
import { expect, it } from "vitest";
import { AgentStore, DEFAULT_AGENT_BUDGET } from "@/lib/server/agent/store";
import { agentModelConfig } from "./agent-decision-config";
import { learningAgentTaskBudget } from "./agent-task-budget";

const env = { OPENAI_API_KEY: "SYNTHETIC", OPENAI_BASE_URL: "https://tokenhub.vision-intelligence.tech/v1",
  LEARNING_AGENT_DECISION_PROVIDER: "tokenhub", LEARNING_AGENT_DECISION_MODEL: "deepseek-v4-pro", LEARNING_AGENT_DECISION_MAX_OUTPUT_TOKENS: "2000" };
it.each([undefined, "47000", "200000", "300000", "1000000"])("aligns configuration and new Learning task budgets for %s", value => {
  const config = { ...env, LEARNING_AGENT_DECISION_MAX_INPUT_CHARS: value };
  expect(agentModelConfig(config).maxInputChars).toBe(value === undefined ? 200000 : Number(value));
  expect(learningAgentTaskBudget(config).maxInputChars).toBe(agentModelConfig(config).maxInputChars);
  expect(DEFAULT_AGENT_BUDGET.maxInputChars).toBe(48000);
});
it.each(["", "0", "999", "1000001", "200000.5", "2e5", "NaN", "Infinity"])("rejects invalid input %s in both configurations", value => {
  const config = { ...env, LEARNING_AGENT_DECISION_MAX_INPUT_CHARS: value };
  expect(() => agentModelConfig(config)).toThrow("agent_model_not_configured");
  expect(() => learningAgentTaskBudget(config)).toThrow("agent_not_configured");
});
it("retains adopted Provider and output boundaries", () => {
  for (const change of [{ LEARNING_AGENT_DECISION_MODEL: "different-model" }, { OPENAI_BASE_URL: "https://unapproved.invalid" },
    { LEARNING_AGENT_DECISION_MAX_OUTPUT_TOKENS: "8001" }]) expect(() => agentModelConfig({ ...env, ...change })).toThrow("agent_model_not_configured");
});
it("does not increase an existing task's persisted input limit or reset usage", () => {
  const store = AgentStore.open(":memory:");
  try {
    const input = { accountId: "synthetic", scenario: "learning.adaptive-review.v1", resourceId: "page", goal: "Existing review", scope: {} };
    const old = store.createTask({ ...input, budget: { ...DEFAULT_AGENT_BUDGET } });
    const lease = store.claim("synthetic", old.id)!;
    const call = store.reserveCall("synthetic", old.id, lease.token, "saved", { kind: "synthetic", inputChars: 1000, maxOutputTokens: 256 }, 0);
    store.finishCall(call, "unknown"); store.release("synthetic", old.id, lease);
    const again = store.createTask({ ...input, id: old.id, budget: learningAgentTaskBudget({}) });
    expect(again.budget).toEqual(old.budget); expect(again.usage.calls).toBe(1);
    expect(store.createTask({ ...input, budget: learningAgentTaskBudget({}) }).budget.maxInputChars).toBe(200000);
  } finally { store.close(); }
});
