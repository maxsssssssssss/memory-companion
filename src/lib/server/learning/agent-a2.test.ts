// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAction, AgentApproval, AgentTask } from "@/lib/domain/agent";
import type { AgentContext, AgentDecisionProvider } from "@/lib/server/agent/types";
import { AgentStore } from "@/lib/server/agent/store";
import { AgentRuntime } from "@/lib/server/agent/runtime";
import { LearningRepository } from "./repository";
import { LearningFrameworkRepository } from "./framework-repository";
import { LearningStudyRepository } from "./study-repository";
import { LearningAgentRepository, learningAgentOperationId } from "./agent-repository";
import { freezeLearningAgentScope } from "./agent-scope";
import { createLearningAgentScenario, readLearningAgentExplanation } from "./agent-scenario";
import { AppendLearningAgentNote, readLearningAgentNotePreview } from "./agent-notes";
import type { generateStudyJson } from "./framework-generator";

let root: string, learning: LearningRepository, pageId: string, materialId: string, secondMaterialId: string, chapterId: string, nodeId: string, otherNodeId: string;
const config = { baseURL: "https://tokenhub.vision-intelligence.tech/v1", apiKey: "SYNTHETIC", model: "deepseek-v4-pro", maxInputChars: 24000, maxOutputTokens: 900 };
const selection = (includeNotes = false) => ({ materialIds: [materialId], chapterIds: [], nodeIds: [], includeHistory: false, includeNotes, includeSupplements: false });
const framework = () => new LearningFrameworkRepository(learning).view(pageId);
function context(includeNotes = false): AgentContext {
  return { task: { id: randomUUID(), version: 1, accountId: "owner", scenario: "learning.adaptive-review.v1", resourceId: pageId, goal: "[合成] 解释并考虑保存笔记",
    scope: freezeLearningAgentScope(learning, pageId, selection(includeNotes)), status: "running", actions: [], budget: { maxCalls: 8, maxInputChars: 48000, maxOutputTokens: 8000, maxComputeMs: 100000, maxSteps: 10, maxNoProgress: 3 },
    usage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0, computeMs: 0, steps: 0 }, createdAt: "synthetic", updatedAt: "synthetic" },
    actionId: randomUUID(), signal: new AbortController().signal, assertActive: async () => {}, call: async (_request, invoke) => (await invoke()).value };
}
async function prepare(includeNotes = false) {
  const generate = vi.fn(async () => ({ materialAnswer: "[模拟生成] 前提未满足时不能应用规则。", supplements: [], items: [{ materialId, paragraph: 1 }] })) as unknown as typeof generateStudyJson;
  const scene = createLearningAgentScenario(learning, { configure: () => config, generate }), ctx = context(includeNotes);
  const explanation = await scene.tools["learning.explain"].execute({ question: "[合成] 为什么不能应用？", sources: [{ materialId, paragraph: 1 }] }, ctx);
  const explanationId = explanation.ref!.id;
  ctx.actionId = randomUUID();
  const args = { explanationId, chapterId, nodeId }, tool = scene.tools["learning.append_note"];
  return { scene, ctx, tool, args, generate, explanationId };
}
async function approve(h: Awaited<ReturnType<typeof prepare>>) {
  const confirmation = await h.tool.confirmation!(h.args, h.ctx);
  h.ctx.task.approval = { ...confirmation!, content: "", id: h.ctx.actionId, actionId: h.ctx.actionId, taskVersion: h.ctx.task.version!, tool: "learning.append_note", fingerprint: "[synthetic shared fingerprint]", status: "approved", createdAt: "synthetic" } satisfies AgentApproval;
  return confirmation!;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "learning-agent-a2-")); learning = new LearningRepository(root, "owner");
  pageId = randomUUID(); materialId = randomUUID(); secondMaterialId = randomUUID(); learning.create({ id: pageId, title: "[合成] A2" });
  learning.saveMaterials(pageId, [
    { id: materialId, title: "[合成] 规则", kind: "text", filename: null, bytes: Buffer.from("[合成] 前提满足时才能应用规则。\n\n[合成] 应用后结果分为通过和未通过。") },
    { id: secondMaterialId, title: "[合成] 额外材料", kind: "text", filename: null, bytes: Buffer.from("[合成] 范围新增时才可以读。") }
  ]);
  const f = new LearningFrameworkRepository(learning), id = randomUUID(); f.begin(pageId, { id, materialIds: [materialId] }, 24000); f.validating(pageId, id);
  f.complete(pageId, id, { overview: "[合成]", chapters: [{ title: "[合成] 规则", explanation: "框架正文保持", nodes: [
    { title: "前提", explanation: "节点正文保持", supplement: null, sources: [{ materialId, paragraph: 1 }] },
    { title: "结果", explanation: "结果正文保持", supplement: null, sources: [{ materialId, paragraph: 2 }] }
  ] }] });
  const chapter = f.view(pageId).chapters[0]; chapterId = chapter.id; nodeId = chapter.nodes[0].id; otherNodeId = chapter.nodes[1].id;
  new LearningStudyRepository(learning).appendNote(pageId, { chapterId, nodeId, revision: chapter.revision, text: "用户已有笔记 PRIVATE_OLD_NOTE" });
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network forbidden"); }));
});
afterEach(async () => { if (learning.database.open) learning.close(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

it("prepares exact persisted preview without read-note authorization or a write, and requires separate approval", async () => {
  const h = await prepare(), before = framework(), confirmation = await h.tool.confirmation!(h.args, h.ctx);
  expect(confirmation?.content).toContain("[模拟生成]"); expect(confirmation?.content).not.toContain("PRIVATE_OLD_NOTE");
  expect(framework()).toEqual(before);
  expect(readLearningAgentNotePreview(learning, h.ctx.task, learningAgentOperationId(h.ctx.actionId, "note"))).toMatchObject({ nodeId, taskVersion: 1, includesSupplement: false, sources: [{ materialId, paragraph: 1 }] });
  await expect(h.tool.execute(h.args, h.ctx)).rejects.toThrow("agent_note_confirmation_required");
  h.ctx.task.approval = { ...confirmation!, id: h.ctx.actionId, actionId: h.ctx.actionId, taskVersion: 1, tool: "learning.append_note", fingerprint: "synthetic", status: "rejected", createdAt: "synthetic" };
  await expect(h.tool.execute(h.args, h.ctx)).rejects.toThrow("agent_note_confirmation_required");
  expect(framework()).toEqual(before); expect(h.generate).toHaveBeenCalledTimes(1);
});

it("appends only confirmed content through existing note service and recovers the real write without duplication", async () => {
  const h = await prepare(), before = framework(), confirmation = await approve(h);
  const result = await h.tool.execute(h.args, h.ctx); await h.tool.validateResult!(result, h.ctx);
  const changed = framework().chapters[0];
  expect(changed.nodes[0].note).toBe(`${before.chapters[0].nodes[0].note}\n\n${confirmation.content}`);
  expect(changed.nodes[0].explanation).toBe(before.chapters[0].nodes[0].explanation);
  expect(changed.nodes[1]).toEqual(before.chapters[0].nodes[1]);
  expect(result.handoff).toContain("不代表学习检查通过");
  await expect(h.tool.recover!(h.ctx.actionId, { ...h.ctx, task: { ...h.ctx.task, accountId: "intruder" } })).rejects.toMatchObject({ code: "forbidden" });
  learning.close(); learning = new LearningRepository(root, "owner");
  const reopened = createLearningAgentScenario(learning);
  expect(await reopened.tools["learning.append_note"].recover!(h.ctx.actionId, h.ctx)).toEqual(result);
  await reopened.tools["learning.append_note"].execute(h.args, h.ctx);
  expect(framework().chapters[0].nodes[0].note).toBe(changed.nodes[0].note);
  expect(h.generate).toHaveBeenCalledTimes(1);
});

it("permits exactly the approved append when notes were readable and fences unrelated later changes", async () => {
  const h = await prepare(true); await approve(h);
  const result = await h.tool.execute(h.args, h.ctx);
  await expect(h.scene.validate(h.ctx)).rejects.toMatchObject({ code: "source_changed" });
  await expect(h.tool.validateResult!(result, h.ctx)).resolves.toBeUndefined();
  const chapter = framework().chapters[0];
  new LearningStudyRepository(learning).appendNote(pageId, { chapterId, nodeId: otherNodeId, revision: chapter.revision, text: "其他节点的新笔记" });
  await expect(h.tool.validateResult!(result, h.ctx)).rejects.toMatchObject({ code: "source_changed" });
});

it("rejects stale target revision so user edits and saved drafts are never replaced", async () => {
  const h = await prepare(); await approve(h);
  const chapter = framework().chapters[0];
  new LearningStudyRepository(learning).appendNote(pageId, { chapterId, nodeId, revision: chapter.revision, text: "用户后来保存的草稿" });
  const before = framework();
  await expect(h.tool.execute(h.args, h.ctx)).rejects.toThrow("agent_note_preview_changed");
  expect(framework()).toEqual(before); expect(before.chapters[0].nodes[0].note).toContain("用户后来保存的草稿");
});

it("rejects unreliable targets, source deletion and tampered confirmation bindings", async () => {
  const h = await prepare();
  await expect(h.tool.confirmation!({ ...h.args, nodeId: otherNodeId }, h.ctx)).rejects.toThrow("agent_note_target_unreliable");
  await approve(h); h.ctx.task.approval!.sourceFingerprint = "tampered";
  await expect(h.tool.execute(h.args, h.ctx)).rejects.toThrow("agent_note_confirmation_changed");
  learning.deleteMaterial(pageId, materialId);
  await expect(h.tool.execute(h.args, h.ctx)).rejects.toThrow("agent_note_preview_unavailable");
  expect(new LearningAgentRepository(learning).get(pageId, h.ctx.task.id, learningAgentOperationId(h.ctx.actionId, "note"))).toMatchObject({ state: "invalidated", body_json: null });
});

it("rejects material IDs used as note addresses without confusing them with changed source authorization", async () => {
  const h = await prepare(), before = framework(), wrong = { ...h.args, chapterId: materialId, nodeId: materialId };
  expect(AppendLearningAgentNote.safeParse(wrong).success).toBe(true);
  await expect(h.tool.confirmation!(wrong, h.ctx)).rejects.toMatchObject({ code: "known_failure", message: "agent_note_target_invalid", publicSummary: expect.stringContaining("learning.read_navigation") });
  await expect(h.scene.validate(h.ctx)).resolves.toBeUndefined();
  expect(new LearningAgentRepository(learning).list(pageId, h.ctx.task.id).filter(a => a.kind === "note_proposal")).toEqual([]);
  expect(framework()).toEqual(before);

  const restricted = { ...h.ctx, task: { ...h.ctx.task, scope: freezeLearningAgentScope(learning, pageId, { ...selection(), materialIds: [], nodeIds: [nodeId] }) } };
  await expect(h.tool.confirmation!({ ...h.args, nodeId: otherNodeId }, restricted)).rejects.toMatchObject({ code: "forbidden", message: "agent_note_target_forbidden" });
  await expect(h.tool.confirmation!(h.args, { ...h.ctx, task: { ...h.ctx.task, accountId: "intruder" } })).rejects.toMatchObject({ code: "forbidden", message: "agent_account_forbidden" });
  await expect(h.tool.confirmation!(h.args, { ...h.ctx, task: { ...h.ctx.task, version: 2 } })).rejects.toMatchObject({ code: "forbidden", message: "agent_explanation_forbidden" });
  await expect(h.tool.confirmation!(h.args, { ...h.ctx, task: { ...h.ctx.task, id: randomUUID() } })).rejects.toMatchObject({ code: "forbidden", message: "agent_explanation_forbidden" });
  expect(framework()).toEqual(before);
});

it("persists the rejected target and feedback wait across reopening, while real source deletion still blocks recovery", async () => {
  const h = await prepare(), dbPath = join(root, "invalid-target.sqlite"), checkpointPath = join(root, "invalid-target-checkpoints.sqlite");
  let store = AgentStore.open(dbPath);
  const task = store.createTask({ id: h.ctx.task.id, accountId: "owner", scenario: h.scene.id, resourceId: pageId, goal: h.ctx.task.goal, scope: h.ctx.task.scope });
  const decision = vi.fn<AgentDecisionProvider>(async (input, ctx) => ctx.call({ kind: "decision", inputChars: 100, maxOutputTokens: 100 }, async () => ({ value: input.results.length
    ? { wait: { kind: "feedback", message: "[合成离线] 等待用户选择可靠知识点。" } }
    : { tool: "learning.append_note", args: { ...h.args, chapterId: materialId, nodeId: materialId } } })));
  let runtime = new AgentRuntime({ store, checkpointPath, scenario: h.scene, decision });
  try {
    const waiting = await runtime.advance("owner", task.id);
    expect(waiting).toMatchObject({ status: "waiting", usage: { calls: 2 }, wait: { kind: "feedback" } });
    expect(waiting.recovery).toBeUndefined(); expect(waiting.approval).toBeUndefined();
    expect(waiting.actions[0]).toMatchObject({ status: "failed", summary: expect.stringContaining("agent_note_target_invalid") });
    expect(decision.mock.calls[1][0].results[0]).toMatchObject({ status: "failed", value: { summary: expect.stringContaining("learning.read_navigation") } });
    expect(store.database.prepare("SELECT count(*) AS count FROM agent_approvals").get()).toEqual({ count: 0 });
    expect(new LearningAgentRepository(learning).list(pageId, task.id).filter(a => a.kind === "note_proposal")).toEqual([]);
    runtime.close(); store.close(); learning.close();
    learning = new LearningRepository(root, "owner"); store = AgentStore.open(dbPath);
    runtime = new AgentRuntime({ store, checkpointPath, scenario: createLearningAgentScenario(learning), decision });
    expect((await runtime.advance("owner", task.id)).status).toBe("waiting");
    expect(decision).toHaveBeenCalledTimes(2);
    expect(framework().chapters[0].nodes[0].note).toBe("用户已有笔记 PRIVATE_OLD_NOTE");
    learning.deleteMaterial(pageId, materialId);
    expect(await runtime.advance("owner", task.id)).toMatchObject({ status: "needs_attention", recovery: { kind: "source_invalid" }, usage: { calls: 2 } });
    expect(decision).toHaveBeenCalledTimes(2);
    expect(new LearningAgentRepository(learning).get(pageId, task.id, h.explanationId)).toMatchObject({ state: "invalidated", body_json: null });
  } finally { runtime.close(); store.close(); }
});

it("new task versions cannot reuse old explanations, pending approvals or late feedback", async () => {
  const h = await prepare(); await approve(h);
  const old = { ...h.ctx.task }, next: AgentTask = { ...h.ctx.task, version: 2, goal: "[合成] 新目标", scope: freezeLearningAgentScope(learning, pageId, { ...selection(), materialIds: [secondMaterialId] }) };
  const updated = { ...h.ctx, task: next };
  expect((await h.scene.observe(updated) as { artifacts: unknown[] }).artifacts).toEqual([]);
  expect(() => readLearningAgentExplanation(learning, next, h.explanationId)).toThrow("agent_explanation_not_found");
  await expect(h.tool.execute(h.args, updated)).rejects.toThrow("agent_note_preview_unavailable");
  await expect(h.scene.validateEvent!({ id: randomUUID(), version: 1, kind: "feedback", message: "旧反馈" }, { ...updated, task: { ...next, wait: { kind: "feedback", message: "等待" } } })).rejects.toThrow("agent_event_version_changed");
  expect(readLearningAgentExplanation(learning, old, h.explanationId)).toBeTruthy();
  new LearningAgentRepository(learning).invalidateNotePreviews(pageId, old.id, 2);
  expect(new LearningAgentRepository(learning).get(pageId, old.id, learningAgentOperationId(h.ctx.actionId, "note"))).toMatchObject({ state: "invalidated", body_json: null });
  expect(framework().chapters[0].nodes[0].note).toBe("用户已有笔记 PRIVATE_OLD_NOTE");
});

it("only explicitly changed scope admits extra materials and note reads", async () => {
  const h = await prepare();
  await expect(h.scene.tools["learning.read_source"].execute({ materialId: secondMaterialId, paragraph: 1 }, h.ctx)).rejects.toMatchObject({ code: "forbidden" });
  const updated = { ...h.ctx, task: { ...h.ctx.task, version: 2, scope: freezeLearningAgentScope(learning, pageId, { ...selection(true), materialIds: [materialId, secondMaterialId] }) } };
  await expect(h.scene.tools["learning.read_source"].execute({ materialId: secondMaterialId, paragraph: 1 }, updated)).resolves.toBeTruthy();
  const navResult = await h.scene.tools["learning.read_navigation"].readResult!({} as AgentAction, updated);
  expect(JSON.stringify(navResult)).toContain("PRIVATE_OLD_NOTE");
});

it("runs the actual shared confirmation loop, appends once with readable notes and then honestly hands back", async () => {
  const h = await prepare(true), store = AgentStore.open(join(root, "agent-approval.sqlite"));
  const task = store.createTask({ id: h.ctx.task.id, accountId: "owner", scenario: h.scene.id, resourceId: pageId, goal: h.ctx.task.goal, scope: h.ctx.task.scope });
  const decision = vi.fn(async () => ({ tool: "learning.append_note", args: h.args }));
  const runtime = new AgentRuntime({ store, checkpointPath: join(root, "approval-checkpoints.sqlite"), scenario: h.scene, decision });
  try {
    const pending = await runtime.advance("owner", task.id);
    expect(pending.status).toBe("waiting"); expect(pending.approval?.status).toBe("pending");
    expect(pending.approval?.content).toBe("");
    expect(framework().chapters[0].nodes[0].note).toBe("用户已有笔记 PRIVATE_OLD_NOTE");
    const approval = pending.approval!;
    const input = { approvalId: approval.id, expectedVersion: 1, fingerprint: approval.fingerprint, decision: "approve" as const, eventId: randomUUID() };
    const completed = await runtime.resolveApproval("owner", task.id, input);
    expect(completed.status).toBe("ended"); expect(completed.endReason).toContain("不代表学习检查通过");
    expect(completed.actions.at(-1)?.status).toBe("succeeded");
    const saved = framework().chapters[0].nodes[0].note;
    expect(saved).toContain("[模拟生成]"); expect(saved.match(/来自复习向导/g)).toHaveLength(1);
    await runtime.resolveApproval("owner", task.id, input);
    expect(framework().chapters[0].nodes[0].note).toBe(saved); expect(decision).toHaveBeenCalledTimes(1);
  } finally { runtime.close(); store.close(); }
});
