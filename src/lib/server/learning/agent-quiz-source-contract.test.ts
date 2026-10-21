// @vitest-environment node
// Synthetic neighbour of Windows G3: original public records are separately
// replayed by natural-quiz-original-evidence.mjs, never relabelled as this fixture.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentDecision, AgentDecisionProvider } from "../agent/types";
import { AgentRuntime } from "../agent/runtime";
import { AgentStore } from "../agent/store";
import { LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { withLearningCompletionDecision } from "./agent-context";
import { createLearningAgentScenario } from "./agent-scenario";
import { freezeLearningAgentScope } from "./agent-scope";
import { assessLearningCompletion, readLearningReviewPlan } from "./agent-completion";
import type { generateStudyJson } from "./framework-generator";

let directory: string, learning: LearningRepository, store: AgentStore, runtime: AgentRuntime | undefined, page: string, material: string;
const config = { baseURL: "https://synthetic.invalid", apiKey: "SYNTHETIC_NOT_SENT", model: "offline", maxInputChars: 48000, maxOutputTokens: 8000 };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-quiz-source-contract-")); learning = new LearningRepository(directory, "owner"); store = AgentStore.open(join(directory, "agents.sqlite"));
  page = randomUUID(); material = randomUUID(); learning.create({ id: page, title: "[合成] 已约定来源" });
  learning.saveMaterials(page, [{ id: material, title: "[合成] 集合材料", kind: "text", filename: null, bytes: Buffer.from([
    "[合成] 本课程讨论集合，不是实际学生数据。", "集合中相同元素重复写出不会增加元素个数。",
    "交集包含同时属于两个集合的元素。", "并集包含至少属于一个集合的元素。",
    "交集是并集的子集。", "假设 X={红,蓝}，Y={蓝,绿}，共同元素是蓝。", "未约定的计数公式 |A∪B|=|A|+|B|−|A∩B|。"
  ].join("\n\n")) }]);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network prohibited"); }));
});
afterEach(async () => { runtime?.close(); runtime = undefined; store.close(); learning.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

it("G3 synthetic: a small natural request gets only its frozen sources, a valid partial Quiz, saved answer and diagnosis without post-submit source repair", async () => {
  const objective = { id: "set_basics", label: "集合的基础归属判断", sources: [2, 3, 4].map(paragraph => ({ materialId: material, paragraph })),
    requirements: [{ role: "concept", description: "选择交集与并集所需的归属条件", independent: false }] };
  const purpose = { objectiveIds: ["set_basics"], role: "concept", method: "retrieval", purpose: "先观察基础归属条件", priorEvidenceRefs: [] };
  let calls = 0;
  const generate = vi.fn(async (_config, _name, _prompt, raw) => {
    const wire = raw as { materials: Array<{ paragraphs: Array<{ referenceId: string; text: string }> }>; taskContext: { reviewContract: { requiredRole: string; allowedObjectiveIds: string[] } } };
    expect(wire.materials[0].paragraphs.map(p => p.text)).toEqual([
      "集合中相同元素重复写出不会增加元素个数。", "交集包含同时属于两个集合的元素。", "并集包含至少属于一个集合的元素。"
    ]);
    expect(JSON.stringify(wire.materials)).not.toContain("计数公式");
    expect(wire.taskContext.reviewContract).toMatchObject({ requiredRole: "concept", allowedObjectiveIds: ["set_basics"] });
    const ref = wire.materials[0].paragraphs[1].referenceId;
    const item = { scenario: null, stem: "一个元素属于交集需要满足什么条件？", kind: "concept", stemEvidenceIds: [ref], correctOptionId: "F",
      options: [{ id: "F", text: "同时属于两个集合", reasonParts: [{ text: "交集要求两个归属条件同时成立。", evidenceIds: [ref] }] },
        { id: "C", text: "只属于其中一个集合", reasonParts: [{ text: "只属于一个集合并不满足交集条件。", evidenceIds: [ref] }] }],
      reviewCheck: { objectiveIds: ["set_basics"], role: "concept", rationale: "本题以选择作答观察交集双条件判断，不证明自由表达或长期掌握。" } };
    return { contractVersion: "references-v2", title: "[合成] 基础判断", reason: null,
      materialPlan: [{ material: 1, contribution: "当前已约定的基础归属条件", references: [ref] }],
      items: [{ ...item, stem: "[合成] 缺失来源的候选应被排除", stemEvidenceIds: ["r999"] }, item] };
  }) as unknown as typeof generateStudyJson;
  const decision: AgentDecisionProvider = async (_input, ctx) => ctx.call({ kind: "decision", inputChars: 10, maxOutputTokens: 200 }, async () => {
    calls++;
    let value: AgentDecision;
    if (calls === 1) value = { tool: "learning.establish_review_plan", args: { kind: "diagnosis", objectives: [objective] } };
    else if (calls === 2) value = { tool: "learning.create_quiz", args: { count: 2, difficulty: "basic", purpose } };
    else throw Error("Unexpected extra model call after sufficient diagnosis observations");
    return { value, usage: { inputTokens: 1, outputTokens: 1 } };
  });
  const scenario = createLearningAgentScenario(learning, { configure: () => config, generate });
  runtime = new AgentRuntime({ store, checkpointPath: join(directory, "checkpoint.sqlite"), scenario, decision: withLearningCompletionDecision(learning, decision) });
  const task = store.createTask({ accountId: "owner", scenario: scenario.id, resourceId: page, goal: "先出两道题看看。",
    scope: { ...freezeLearningAgentScope(learning, page, { materialIds: [material], chapterIds: [], nodeIds: [], includeNotes: false, includeHistory: false, includeSupplements: false }), completionVersion: 1 } });
  const waiting = await runtime.advance("owner", task.id), quiz = new LearningQuizRepository(learning);
  expect(waiting).toMatchObject({ status: "waiting", wait: { kind: "quiz_submission" } });
  expect(quiz.list(page)[0]).toMatchObject({ status: "completed", count: 1, delivery: { requested: 2, published: 1 } });
  const originalPlan = readLearningReviewPlan(learning, waiting);
  let attempt = quiz.attempt(page, waiting.wait!.refId!);
  expect(JSON.stringify(attempt)).not.toContain("correctOptionId");
  attempt = quiz.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "choose", question: 0, optionId: "F" });
  attempt = quiz.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "finish", question: 0, optionId: null });
  const event = { id: randomUUID(), kind: "quiz_submission" as const, refId: attempt.id, version: 1 };
  const ended = await runtime.submitEvent("owner", task.id, event, { expectedVersion: 1 });
  expect(ended.status).toBe("ended");
  const assessment = assessLearningCompletion(learning, ended);
  expect(assessment).toMatchObject({ outcome: "diagnosis_complete", canAutoFinish: true, longTermMastery: "unverified" });
  expect(assessment.technicalBlocker).toBeUndefined();
  expect(readLearningReviewPlan(learning, ended)).toEqual(originalPlan);
  expect(calls).toBe(2); expect(generate).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  await runtime.submitEvent("owner", task.id, event, { expectedVersion: 1 });
  expect(calls).toBe(2); expect(quiz.list(page)).toHaveLength(1);
});
