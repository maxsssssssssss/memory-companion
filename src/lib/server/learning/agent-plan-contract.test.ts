// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { LearningReviewPlanInput } from "@/lib/domain/learning-agent-completion";
import { agentDecisionRequest } from "@/lib/server/agent/model";
import { AgentStore } from "@/lib/server/agent/store";
import type { AgentScenario } from "@/lib/server/agent/types";
import { createLearningAgentScenario } from "./agent-scenario";
import { LearningRepository } from "./repository";

// These are the six synthetic parameter-contract counterexamples supplied in
// Windows' schema-contract-gap.ts, not the unavailable W1/W3 model responses.
type Plan = { kind: string; objectives: Array<{ id: string; label: string;
  sources: Array<{ materialId: string; paragraph: number }>;
  requirements: Array<{ role: string; description: string; independent: boolean }> }> };
const make = (kind: string): Plan => ({ kind, objectives: [{ id: "objective_1", label: "[合成合同复现] 检查规则",
  sources: [{ materialId: "00000000-0000-4000-8000-000000000001", paragraph: 1 }],
  requirements: [{ role: "concept", description: "[合成合同复现] 区分定义", independent: true }] }] });
type Case = { rule: string; invalid: Plan; corrected: Plan; path: Array<string | number> };
const cases: Case[] = [];
let invalid = make("explanation");
invalid.objectives[0].requirements = [];
invalid.objectives.push(structuredClone(invalid.objectives[0]));
let corrected = structuredClone(invalid); corrected.objectives[1].id = "objective_2";
cases.push({ rule: "duplicate_objective", invalid, corrected, path: ["objectives", 1, "id"] });
invalid = make("diagnosis"); invalid.objectives[0].requirements = [];
cases.push({ rule: "check_requirements_required", invalid, corrected: make("diagnosis"), path: ["objectives", 0, "requirements"] });
invalid = make("explanation"); invalid.objectives[0].requirements.push(structuredClone(invalid.objectives[0].requirements[0]));
corrected = structuredClone(invalid); corrected.objectives[0].requirements[1].role = "application";
cases.push({ rule: "duplicate_requirement", invalid, corrected, path: ["objectives", 0, "requirements", 1, "role"] });
invalid = make("targeted_review"); corrected = structuredClone(invalid); corrected.objectives[0].requirements[0].role = "followup";
cases.push({ rule: "targeted_followup_required", invalid, corrected, path: ["objectives", 0, "requirements"] });
for (const kind of ["chapter_check", "targeted_review"]) {
  invalid = make(kind);
  if (kind === "targeted_review") invalid.objectives[0].requirements[0].role = "followup";
  invalid.objectives[0].requirements[0].independent = false;
  corrected = structuredClone(invalid); corrected.objectives[0].requirements[0].independent = true;
  cases.push({ rule: "independent_check_required", invalid, corrected, path: ["objectives", 0, "requirements", 0, "independent"] });
}

let root: string, learning: LearningRepository, scene: AgentScenario;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "learning-plan-contract-"));
  learning = new LearningRepository(root, "synthetic-owner");
  scene = createLearningAgentScenario(learning);
});
afterAll(async () => { learning?.close(); if (root) await rm(root, { recursive: true, force: true }); });

describe("formal Learning review-plan parameter contract", () => {
  it.each(cases)("retains strict $rule rejection and accepts its corrected control ($invalid.kind)", ({ rule, invalid, corrected, path }) => {
    const schema = scene.tools["learning.establish_review_plan"].parameters;
    expect(schema).toBe(LearningReviewPlanInput);
    // Structural JSON Schema still cannot enforce cross-field superRefine.
    expect(LearningReviewPlanInput.innerType().safeParse(invalid).success).toBe(true);
    const result = schema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map(({ code, message, path }) => ({ code, message, path })))
      .toEqual([{ code: "custom", message: rule, path }]);
    expect(schema.safeParse(corrected).success).toBe(true);
  });

  it.each([
    { name: "unknown role", input: { ...make("explanation"), objectives: [{ ...make("explanation").objectives[0],
      requirements: [{ role: "made_up_role", description: "[合成合同复现] 区分定义", independent: true }] }] } },
    { name: "extra top-level verdict", input: { ...make("explanation"), pass: true } }
  ])("keeps $name rejected at both structural and full validation", ({ input }) => {
    expect(LearningReviewPlanInput.innerType().safeParse(input).success).toBe(false);
    expect(scene.tools["learning.establish_review_plan"].parameters.safeParse(input).success).toBe(false);
  });

  it("exposes all five conditional constraints in the actual decision-request tool schema", () => {
    const database = new Database(":memory:");
    try {
      const task = new AgentStore(database).createTask({ accountId: "synthetic-owner", scenario: scene.id,
        resourceId: "synthetic-page", goal: "[合成] 核对参数合同", scope: {} });
      const { messages } = agentDecisionRequest({ task, observation: {}, results: [],
        tools: Object.entries(scene.tools).map(([name, tool]) => ({ name, description: tool.description, parameters: tool.parameters })) });
      const payload: { tools: Array<{ name: string; parameters: { description?: string } }> } = JSON.parse(messages[1].content);
      const plan = payload.tools.find(tool => tool.name === "learning.establish_review_plan")!.parameters;
      for (const clause of ["objectives中的id全部唯一", "kind不是explanation时，每个目标的requirements至少一项",
        "同一目标的requirements中role唯一", "kind=targeted_review时，每个目标必须包含role=followup",
        "kind=targeted_review或chapter_check时，所有requirements的independent必须为true"]) {
        expect(plan.description).toContain(clause);
      }
      expect(plan.description).toContain("来源语义或学习结论");
      for (const name of ["learning.create_quiz", "learning.explain"]) {
        expect(JSON.stringify(payload.tools.find(tool => tool.name === name)!.parameters))
          .toContain("只能选择当前计划中的目标，数组内不得重复");
        const schema = scene.tools[name].parameters;
        const purpose = { objectiveIds: ["objective_1", "objective_1"], role: "concept", method: "retrieval", purpose: "[合成] 检查规则" };
        const args = name === "learning.create_quiz" ? { count: 1, difficulty: "basic", purpose }
          : { question: "[合成] 解释规则", sources: make("explanation").objectives[0].sources, purpose };
        expect(schema.safeParse(args).success).toBe(false);
        expect(schema.safeParse({ ...args, purpose: { ...purpose, objectiveIds: ["objective_1"] } }).success).toBe(true);
      }
      expect(task.actions).toEqual([]); expect(task.usage.calls).toBe(0);
    } finally { database.close(); }
  });

  it("does not impose independent checks or a Quiz on explanation-only and diagnostic goals", () => {
    const explanation = make("explanation"); explanation.objectives[0].requirements = [];
    const diagnosis = make("diagnosis"); diagnosis.objectives[0].requirements[0].independent = false;
    expect(LearningReviewPlanInput.safeParse(explanation).success).toBe(true);
    expect(LearningReviewPlanInput.safeParse(diagnosis).success).toBe(true);
  });
});
