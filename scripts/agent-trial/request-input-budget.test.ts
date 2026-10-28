// @vitest-environment node
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { learningAgentInputChars } from "../../src/lib/server/learning/agent-input-budget";
const { trialInputBudget, withinTrialInputBudget } = createRequire(import.meta.url)("./request-input-budget.cjs");
it("aligns trajectory transport and Learning limits without enlarging protocol input", () => {
  for (const value of [undefined, "47000", "200000", "300000", "1000000"]) {
    const env = { LEARNING_AGENT_DECISION_MAX_INPUT_CHARS: value };
    expect(trialInputBudget(env)).toBe(learningAgentInputChars(env));
    expect(trialInputBudget({ ...env, AGENT_TRIAL_PHASE: "protocol" })).toBe(48000);
  }
  for (const value of ["", "999", "1000001", "2e5"]) expect(() => trialInputBudget({ LEARNING_AGENT_DECISION_MAX_INPUT_CHARS: value })).toThrow();
});
it("accepts larger requests, rejects overflow and keeps a context reserve for Unicode and output", () => {
  expect(withinTrialInputBudget("中".repeat(200000), 8000, {})).toBe(true);
  expect(withinTrialInputBudget("a".repeat(200001), 8000, {})).toBe(false);
  expect(withinTrialInputBudget("a".repeat(48001), 2000, { AGENT_TRIAL_PHASE: "protocol" })).toBe(false);
  expect(withinTrialInputBudget("中".repeat(400000), 8000, { LEARNING_AGENT_DECISION_MAX_INPUT_CHARS: "1000000" })).toBe(false);
});
