// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PARSED_CONTRACT_VERSION, type ParsedBlock } from "@/lib/domain/learning-parsed-document";
import { AgentStore } from "@/lib/server/agent/store";
import { AgentRuntime } from "@/lib/server/agent/runtime";
import { syntheticLearningPdf } from "../../../../scripts/fixtures/learning-pdf.mjs";
import { LearningRepository } from "./repository";
import { LearningFrameworkRepository } from "./framework-repository";
import { LearningStudyRepository } from "./study-repository";
import { freezeLearningAgentScope, readLearningAgentScope } from "./agent-scope";
import { createLearningAgentScenario } from "./agent-scenario";

let root: string, learning: LearningRepository, pageId: string, materialId: string;
const bytes = syntheticLearningPdf({ pages: 1 }), sha = createHash("sha256").update(bytes).digest("hex");
const selection = () => ({ materialIds: [materialId], chapterIds: [], nodeIds: [], includeHistory: false, includeNotes: true, includeSupplements: true });
function selectParsedVersion() {
  const document = learning.createParsedDocument(pageId, { id: randomUUID(), materialId, originalSha256: sha, originalVersion: 1,
    requestedPages: [1], parser: { name: "SYNTHETIC", version: "offline" } });
  const id = randomUUID(), block: ParsedBlock = { id, type: "text", parser_type: "synthetic", role: "body",
    content: { raw: "[合成] 前提满足时才可应用规则。", normalized: "[合成] 前提满足时才可应用规则。", format: "plain", cleaning: "none" },
    source_member_ids: [id], source_regions: [{ member_id: id, physical_page: 1, bbox: [0.1, 0.1, 0.8, 0.2], unit: "normalized", origin: "top_left", frame: "displayed_pdf_crop",
      parser_ref: { run_id: document.id, page_index: 0, block_id: id, result_ref: "synthetic-result" } }],
    quality: { status: "unverified", reason: "SYNTHETIC ONLY", automatic_signals: [], text_layer_signals: [], reviews: [] } };
  learning.startParsedDocument(pageId, document.id);
  learning.completeParsedDocument(pageId, document.id, { contract_version: PARSED_CONTRACT_VERSION, document_id: document.id,
    material_id: materialId, original_sha256: sha, parse_version: document.version,
    parser_run: { run_id: document.id, upstream_document_id: materialId, model: "SYNTHETIC", config_summary: "NO OCR" },
    coverage: { requested_pages: [1], succeeded_pages: [1], failed_pages: [] },
    pages: [{ physical_page: 1, printed_label: null, parser_page_index: 0, parse_status: "succeeded", failure_code: null,
      render: { width_px: 600, height_px: 800, rotation: 0, crop_pdf: [0, 0, 600, 800], frame: "displayed_pdf_crop" },
      issues: [], reading_order: { block_ids: [id], origin: "synthetic", reviews: [] }, blocks: [block] }] });
  learning.selectPdfStudy(pageId, materialId, { documentId: document.id, physicalPages: [1], excludedBlockIds: [],
    acknowledgeUnverified: true, acknowledgeWarnings: false }, learning.get(pageId).revision);
  return document;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-source-binding-")); learning = new LearningRepository(root, "owner");
  pageId = randomUUID(); materialId = randomUUID(); learning.create({ id: pageId, title: "[合成] 来源版本" });
  learning.saveMaterials(pageId, [{ id: materialId, title: "[合成] PDF", kind: "pdf", filename: "synthetic.pdf", bytes,
    pdf: { sha256: sha, originalVersion: 1, parsing: "not_parsed", pageCount: 1,
      pages: [{ physicalPage: 1, width: 600, height: 800, rotation: 0, view: [0, 0, 600, 800], userUnit: 1 }] } }]);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("External I/O forbidden"); }));
});
afterEach(async () => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); learning.close(); await rm(root, { recursive: true, force: true }); });

it("does not rebind historical framework notes or supplements to matching paragraph numbers of a new PDF parse", () => {
  const first = selectParsedVersion(), framework = new LearningFrameworkRepository(learning), id = randomUUID();
  framework.begin(pageId, { id, materialIds: [materialId] }, 24000); framework.validating(pageId, id);
  framework.complete(pageId, id, { overview: "[合成]", chapters: [{ title: "[合成] 旧版框架", explanation: "非证据", nodes: [
    { title: "旧版知识点", explanation: "非证据", supplement: "OLD_SUPPLEMENT", sources: [{ materialId, paragraph: 1 }] }
  ] }] });
  const chapter = framework.view(pageId).chapters[0], node = chapter.nodes[0];
  new LearningStudyRepository(learning).appendNote(pageId, { chapterId: chapter.id, nodeId: node.id, revision: chapter.revision, text: "OLD_NOTE" });
  const frozen = freezeLearningAgentScope(learning, pageId, selection());
  expect(readLearningAgentScope(learning, pageId, frozen).navigation[0].nodes[0]).toMatchObject({ note: "OLD_NOTE", supplement: "OLD_SUPPLEMENT" });
  const second = selectParsedVersion();
  expect(second.id).not.toBe(first.id);
  expect(() => readLearningAgentScope(learning, pageId, frozen)).toThrow("source_changed");
  const fresh = freezeLearningAgentScope(learning, pageId, selection()), current = readLearningAgentScope(learning, pageId, fresh);
  expect(current.materials[0].paragraphs[0].parsed?.documentId).toBe(second.id);
  expect(current.navigation).toEqual([]);
  expect(JSON.stringify(current)).not.toMatch(/OLD_NOTE|OLD_SUPPLEMENT/);
  expect(() => freezeLearningAgentScope(learning, pageId, { ...selection(), materialIds: [], nodeIds: [node.id] })).toThrow("source_changed");
  // Historical manual backreferences remain available under their original binding.
  expect(framework.source(pageId, chapter.id, node.id, 0).paragraph.parsed?.documentId).toBe(first.id);
});

it("rejects a restored task's feedback after the current PDF source version changes without another decision", async () => {
  selectParsedVersion();
  const storePath = join(root, "agent.sqlite"), checkpointPath = join(root, "checkpoints.sqlite");
  let store = AgentStore.open(storePath), decisions = 0;
  const decision = vi.fn(async () => ++decisions === 1
    ? { tool: "learning.read_source", args: { materialId, paragraph: 1 } }
    : { wait: { kind: "feedback", message: "[合成] 请提交反馈" } });
  let runtime = new AgentRuntime({ store, checkpointPath, scenario: createLearningAgentScenario(learning), decision });
  const task = store.createTask({ accountId: "owner", scenario: "learning.adaptive-review.v1", resourceId: pageId,
    goal: "[合成] 原文复习", scope: freezeLearningAgentScope(learning, pageId, selection()) });
  try {
    const waiting = await runtime.advance("owner", task.id);
    expect(waiting.status).toBe("waiting"); expect(waiting.actions[0].status).toBe("succeeded");
    expect(decision).toHaveBeenCalledTimes(2);
    selectParsedVersion();
    runtime.close(); store.close(); learning.close();
    learning = new LearningRepository(root, "owner"); store = AgentStore.open(storePath);
    runtime = new AgentRuntime({ store, checkpointPath, scenario: createLearningAgentScenario(learning), decision });
    const result = await runtime.advance("owner", task.id, { id: randomUUID(), version: 1, kind: "feedback", message: "[模拟学生] 继续复习" });
    expect(result.status).toBe("needs_attention"); expect(result.recovery?.kind).toBe("source_invalid");
    expect(result.actions).toHaveLength(1); expect(decision).toHaveBeenCalledTimes(2);
    expect(result.usage.calls).toBe(0);
  } finally { runtime.close(); store.close(); }
});
