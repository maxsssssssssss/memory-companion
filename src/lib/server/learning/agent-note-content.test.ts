// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentApproval } from "@/lib/domain/agent";
import type { LearningAgentExplanation, LearningAgentNotePreview } from "@/lib/domain/learning-agent";
import type { AgentContext } from "@/lib/server/agent/types";
import { LearningRepository } from "./repository";
import { LearningFrameworkRepository, frameworkHash } from "./framework-repository";
import { LearningStudyRepository } from "./study-repository";
import { LearningAgentRepository, learningAgentOperationId } from "./agent-repository";
import { freezeLearningAgentScope } from "./agent-scope";
import { createLearningAgentNoteTool, readLearningAgentNotePreview } from "./agent-notes";

const originalParagraph = "交集 A∩B 包含同时属于 A 和 B 的元素。判断一个元素是否在交集中，需要两个归属条件同时成立。若 A={1,2,3}，B={3,4}，则 A∩B={3}。没有共同元素时交集为空集。";
const contradictory = "A={1,2,3}，B={3,4}，A∩B={3}。元素3同时属于两个集合，所以不满足交集的双条件。";
const correct = "A={1,2,3}，B={3,4}，A∩B={3}。元素3同时属于两个集合，所以满足交集的双条件。";
let root: string, learning: LearningRepository, pageId: string, materialId: string, chapterId: string, nodeId: string, ctx: AgentContext;
const framework = () => new LearningFrameworkRepository(learning).view(pageId);
const artifacts = () => new LearningAgentRepository(learning);
const tool = () => createLearningAgentNoteTool(learning);

function savedExplanation(text: string) {
  const id = randomUUID(), answer: LearningAgentExplanation = { id, taskId: ctx.task.id, taskVersion: 1, question: "[合成离线] 为什么3属于交集？", materialAnswer: text, supplements: [], items: [{ materialId, paragraph: 1 }] };
  artifacts().reserve({ id, taskId: ctx.task.id, taskVersion: 1, pageId, kind: "explanation", actionId: randomUUID(), binding: (ctx.task.scope as { fingerprint: string }).fingerprint, materialIds: [materialId] });
  artifacts().complete(pageId, ctx.task.id, id, answer);
  return id;
}

/** Import a pre-upgrade pending preview through the artifact storage contract.
 * No SQL mutation of task states, approvals, grades or business note results. */
function legacyPreview(explanationId: string): LearningAgentNotePreview {
  const chapter = framework().chapters[0], node = chapter.nodes[0], id = learningAgentOperationId(ctx.actionId, "note");
  const preview: LearningAgentNotePreview = { id, taskId: ctx.task.id, taskVersion: 1, explanationId, chapterId, nodeId,
    targetLabel: `${chapter.title} / ${node.title}`, content: `来自复习向导（旧预览）\n${contradictory}`, sources: [{ materialId, paragraph: 1 }], includesSupplement: false,
    targetRevision: chapter.revision, noteHash: frameworkHash(node.note), sourceFingerprint: "" };
  preview.sourceFingerprint = frameworkHash(JSON.stringify({ ...preview, sourceFingerprint: undefined, scope: (ctx.task.scope as { fingerprint: string }).fingerprint, sources: node.sources }));
  artifacts().reserve({ id, taskId: ctx.task.id, taskVersion: 1, pageId, kind: "note_proposal", actionId: ctx.actionId, binding: (ctx.task.scope as { fingerprint: string }).fingerprint, materialIds: [materialId] });
  artifacts().savePreview(pageId, ctx.task.id, id, { preview });
  return preview;
}

function approve(preview: { target: string; sourceFingerprint: string; title: string; summary: string }) {
  ctx.task.approval = { ...preview, content: "", id: ctx.actionId, actionId: ctx.actionId, taskVersion: 1, tool: "learning.append_note", fingerprint: "[合成已授权上下文]", status: "approved", createdAt: "synthetic" } satisfies AgentApproval;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-note-content-")); learning = new LearningRepository(root, "owner");
  pageId = randomUUID(); materialId = randomUUID(); learning.create({ id: pageId, title: "[合成] 已知解释问题与笔记" });
  learning.saveMaterials(pageId, [{ id: materialId, title: "[合成] 集合", kind: "text", filename: null, bytes: Buffer.from(originalParagraph) }]);
  const f = new LearningFrameworkRepository(learning), requestId = randomUUID();
  f.begin(pageId, { id: requestId, materialIds: [materialId] }, 24000); f.validating(pageId, requestId);
  f.complete(pageId, requestId, { overview: "[合成]", chapters: [{ title: "[合成] 交集", explanation: "原框架", nodes: [{ title: "同时归属", explanation: "原节点", supplement: null, sources: [{ materialId, paragraph: 1 }] }] }] });
  const chapter = framework().chapters[0]; chapterId = chapter.id; nodeId = chapter.nodes[0].id;
  new LearningStudyRepository(learning).appendNote(pageId, { chapterId, nodeId, revision: chapter.revision, text: "用户原有笔记" });
  ctx = { task: { id: randomUUID(), version: 1, accountId: "owner", resourceId: pageId, scenario: "learning.adaptive-review.v1", goal: "[合成] 解释并保存",
    scope: freezeLearningAgentScope(learning, pageId, { materialIds: [materialId], chapterIds: [], nodeIds: [], includeHistory: false, includeNotes: false, includeSupplements: false }),
    status: "running", actions: [], budget: { maxCalls: 8, maxInputChars: 48000, maxOutputTokens: 8000, maxComputeMs: 100000, maxSteps: 10, maxNoProgress: 3 },
    usage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0, computeMs: 0, steps: 0 }, createdAt: "synthetic", updatedAt: "synthetic" },
    actionId: randomUUID(), signal: new AbortController().signal, assertActive: async () => {}, call: async (_request, invoke) => (await invoke()).value };
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Provider requests forbidden"); }));
});
afterEach(async () => { if (learning.database.open) learning.close(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

describe("known explanation content issue at note confirmation/write", () => {
  it("rejects a new proposal without rewriting the source explanation or existing note", async () => {
    const explanationId = savedExplanation(contradictory), original = artifacts().get(pageId, ctx.task.id, explanationId), before = framework();
    await expect(tool().confirmation!({ explanationId, chapterId, nodeId }, ctx)).rejects.toMatchObject({ code: "known_failure", message: "agent_note_explanation_content_issue" });
    expect(artifacts().get(pageId, ctx.task.id, explanationId)).toEqual(original);
    expect(artifacts().list(pageId, ctx.task.id).filter(row => row.kind === "note_proposal")).toEqual([]);
    expect(framework()).toEqual(before); expect(fetch).not.toHaveBeenCalled();
  });

  it("rechecks a pre-upgrade pending approval after reopening and refuses its write", async () => {
    const explanationId = savedExplanation(contradictory), preview = legacyPreview(explanationId), original = artifacts().get(pageId, ctx.task.id, preview.id), before = framework();
    approve({ target: preview.targetLabel, sourceFingerprint: preview.sourceFingerprint, title: "旧确认", summary: "旧提案" });
    learning.close(); learning = new LearningRepository(root, "owner");
    expect(() => readLearningAgentNotePreview(learning, ctx.task, preview.id)).toThrow("agent_note_explanation_content_issue");
    await expect(tool().execute({ explanationId, chapterId, nodeId }, ctx)).rejects.toMatchObject({ code: "known_failure", message: "agent_note_explanation_content_issue" });
    expect(artifacts().get(pageId, ctx.task.id, preview.id)).toEqual(original);
    expect(framework()).toEqual(before); expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves source/account/version guards before an old preview can be written", async () => {
    const explanationId = savedExplanation(contradictory), preview = legacyPreview(explanationId);
    expect(() => readLearningAgentNotePreview(learning, { ...ctx.task, accountId: "intruder" }, preview.id)).toThrow("agent_account_forbidden");
    expect(() => readLearningAgentNotePreview(learning, { ...ctx.task, version: 2 }, preview.id)).toThrow("agent_note_preview_unavailable");
    learning.deleteMaterial(pageId, materialId);
    expect(() => readLearningAgentNotePreview(learning, ctx.task, preview.id)).toThrow("agent_note_preview_unavailable");
    expect(artifacts().get(pageId, ctx.task.id, explanationId)).toMatchObject({ state: "invalidated", body_json: null });
    expect(artifacts().get(pageId, ctx.task.id, preview.id)).toMatchObject({ state: "invalidated", body_json: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows explicit approval of supported syntax and appends once through the real note service", async () => {
    const explanationId = savedExplanation(correct), args = { explanationId, chapterId, nodeId };
    const confirmation = await tool().confirmation!(args, ctx); approve(confirmation!);
    const result = await tool().execute(args, ctx), once = framework();
    expect(once.chapters[0].nodes[0].note).toBe(`用户原有笔记\n\n${confirmation!.content}`);
    learning.close(); learning = new LearningRepository(root, "owner");
    expect(await tool().recover!(ctx.actionId, ctx)).toEqual(result);
    expect(await tool().execute(args, ctx)).toEqual(result);
    expect(framework()).toEqual(once); expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps already-written historical receipts without retracting or duplicating the note", async () => {
    const explanationId = savedExplanation(contradictory), preview = legacyPreview(explanationId);
    // Simulate an older accepted business write using the existing note service,
    // then persist its truthful receipt. The repair must not rewrite this fact.
    const appended = new LearningStudyRepository(learning).appendNote(pageId, { chapterId, nodeId, revision: preview.targetRevision, text: preview.content });
    const chapter = appended.chapters[0], note = chapter.nodes[0].note;
    artifacts().complete(pageId, ctx.task.id, preview.id, { preview, written: { chapterId, nodeId, revision: chapter.revision, contentHash: frameworkHash(preview.content), noteHash: frameworkHash(note), sourceFingerprint: (ctx.task.scope as { fingerprint: string }).fingerprint } });
    const original = artifacts().get(pageId, ctx.task.id, preview.id);
    const receipt = await tool().recover!(ctx.actionId, ctx);
    expect(receipt).toMatchObject({ ref: { kind: "learning.note", id: preview.id } });
    expect(await tool().execute({ explanationId, chapterId, nodeId }, ctx)).toEqual(receipt);
    expect(framework().chapters[0].nodes[0].note).toBe(note);
    expect(artifacts().get(pageId, ctx.task.id, preview.id)).toEqual(original); expect(fetch).not.toHaveBeenCalled();
  });
});
