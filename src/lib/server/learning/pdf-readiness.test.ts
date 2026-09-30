// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LearningPdfMetadata } from "@/lib/domain/learning";
import { PdfStudySelection } from "@/lib/domain/learning-pdf-study";
import { PARSED_CONTRACT_VERSION, type ParsedBlock, type ParsedDocument, type ParsedDocumentResult, type ParsedIssue } from "@/lib/domain/learning-parsed-document";
import { syntheticLearningPdf } from "../../../../scripts/fixtures/learning-pdf.mjs";
import { LearningRepository } from "./repository";
import { parsedPageHashes, prepareParsedResult } from "./parsed-document-core";
import { inspectLearningPdfReadiness } from "./pdf-readiness";

// All originals, OCR text, findings and execution checkpoints are synthetic.
const bytes = syntheticLearningPdf({ pages: 3 });
const sha = createHash("sha256").update(bytes).digest("hex");
const metadata: LearningPdfMetadata = { sha256: sha, originalVersion: 1, parsing: "not_parsed", pageCount: 3,
  pages: [1, 2, 3].map(physicalPage => ({ physicalPage, width: 600, height: 800, rotation: 0, view: [0, 0, 600, 800], userUnit: 1 })) };
let root: string, repo: LearningRepository, pageId: string, materialId: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "synthetic-learning-readiness-"));
  repo = new LearningRepository(root, "synthetic-owner"); pageId = randomUUID(); materialId = randomUUID();
  repo.create({ id: pageId, title: "SYNTHETIC" });
  repo.saveMaterials(pageId, [{ id: materialId, title: "SYNTHETIC", kind: "pdf", filename: "synthetic.pdf", bytes, pdf: metadata }]);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("External I/O forbidden"); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); repo.close(); rmSync(root, { recursive: true, force: true }); });
function block(page: number, run: string, text: string | null = "SYNTHETIC text", bbox: [number, number, number, number] = [0.1, 0.1, 0.3, 0.3]): ParsedBlock {
  const id = randomUUID();
  return { id, type: "text", parser_type: "synthetic-text", role: "body",
    content: { raw: text, normalized: text, format: "plain", cleaning: "none" },
    source_member_ids: [id], source_regions: [{ member_id: id, physical_page: page, bbox, unit: "normalized", origin: "top_left", frame: "displayed_pdf_crop",
      parser_ref: { run_id: run, page_index: page - 1, block_id: id, result_ref: "synthetic-result" } }],
    quality: { status: "unverified", reason: "SYNTHETIC ONLY", automatic_signals: [], text_layer_signals: [], reviews: [] } };
}
function issue(page: number, severity: "warning" | "blocked", ids: string[] = []): ParsedIssue {
  return { code: "SYNTHETIC_QUALITY", message: "SYNTHETIC ONLY", origin: "automatic_rule", severity,
    scope: { physical_pages: [page], block_ids: ids }, evidence_refs: ["synthetic-only"] };
}
function attempt(requestedPages = [1, 2, 3]) {
  return repo.createParsedDocument(pageId, { id: randomUUID(), materialId, originalSha256: sha, originalVersion: 1,
    requestedPages, parser: { name: "SYNTHETIC", version: "test" } });
}
function payload(doc: ParsedDocument): ParsedDocumentResult {
  return { contract_version: PARSED_CONTRACT_VERSION, document_id: doc.id, material_id: materialId, original_sha256: sha, parse_version: doc.version,
    parser_run: { run_id: doc.id, upstream_document_id: materialId, model: "SYNTHETIC", config_summary: "NO OCR" },
    coverage: { requested_pages: doc.requestedPages!, succeeded_pages: doc.requestedPages!, failed_pages: [] },
    pages: doc.requestedPages!.map(physical => { const b = block(physical, doc.id); return {
      physical_page: physical, printed_label: null, parser_page_index: physical - 1, parse_status: "succeeded", failure_code: null,
      render: { width_px: 600, height_px: 800, rotation: 0, crop_pdf: [0, 0, 600, 800], frame: "displayed_pdf_crop" },
      issues: [], reading_order: { block_ids: [b.id], origin: "synthetic", reviews: [] }, blocks: [b] }; }) };
}
function finish(edit?: (value: ParsedDocumentResult, doc: ParsedDocument) => void, requested?: number[]) {
  const doc = attempt(requested), value = payload(doc); edit?.(value, doc);
  repo.startParsedDocument(pageId, doc.id);
  return repo.completeParsedDocument(pageId, doc.id, value);
}
const inspect = () => inspectLearningPdfReadiness(repo, pageId, materialId);
function saveProposal() {
  const r = inspect(); expect(r.selection).not.toBeNull();
  repo.selectPdfStudy(pageId, materialId, r.selection, repo.get(pageId).revision);
  return repo.source(pageId, materialId);
}
it("proposes full unverified text without writes; old manual scopes and automatic authorization remain distinct", () => {
  const doc = finish(), changes = repo.database.prepare("SELECT total_changes() AS n").get();
  const readiness = inspect();
  expect(readiness).toMatchObject({ status: "ready", partial: false, completedPages: [1, 2, 3], failedPages: [], pendingPages: [],
    selection: { documentId: doc.id, physicalPages: [1, 2, 3], authorization: "automatic", acknowledgeUnverified: true } });
  expect(inspect()).toEqual(readiness);
  expect(repo.database.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
  expect(repo.get(pageId).materials[0].pdfStudy).toBeUndefined();
  const { authorization: _authorization, ...legacy } = readiness.selection!;
  expect(PdfStudySelection.parse(legacy)).not.toHaveProperty("authorization");
  expect(saveProposal().scopeNotice?.contentVerified).toBe(false);
  expect(repo.getParsedDocument(pageId, doc.id).pages![0].blocks[0].quality.status).toBe("unverified");
});
it("retains warning evidence without treating warnings as exclusions or verified content", () => {
  finish(p => { const b = p.pages[0].blocks[0]; b.quality.automatic_signals = [issue(1, "warning", [b.id])]; });
  expect(inspect()).toMatchObject({ status: "ready", partial: false, warningCodes: ["SYNTHETIC_QUALITY"] });
  expect(saveProposal().scopeNotice).toMatchObject({ contentVerified: false, warningCodes: ["SYNTHETIC_QUALITY"] });
});
it("excludes empty images, blocked formulas and overlapping duplicates while retaining safe text", () => {
  const doc = finish(p => {
    const page = p.pages[0], empty = block(1, p.document_id, null, [0.4, 0.4, 0.5, 0.5]);
    const formula = block(1, p.document_id, "SYNTHETIC FORMULA", [0.6, 0.6, 0.8, 0.8]); formula.quality.status = "blocked";
    const duplicate = block(1, p.document_id, "SYNTHETIC DUPLICATE", [0.65, 0.65, 0.9, 0.9]);
    page.blocks.push(empty, formula, duplicate); page.reading_order.block_ids = page.blocks.map(b => b.id);
  });
  expect(inspect()).toMatchObject({ status: "partial", partial: true, excludedBlockCount: 3, excludedPages: [] });
  expect(saveProposal().paragraphs).toHaveLength(3);
  expect(repo.getParsedDocument(pageId, doc.id).pages![0].blocks).toHaveLength(4);
});
it("does not bypass page-level negative evidence by excluding individual blocks", () => {
  finish(p => { p.pages[0].issues.push(issue(1, "blocked")); });
  expect(inspect()).toMatchObject({ status: "partial", excludedPages: [1], selection: { physicalPages: [2, 3] } });
  expect(saveProposal().paragraphs.map(p => p.parsed!.physicalPage)).toEqual([2, 3]);
});
it("preserves a valid reading-order blocked review", () => {
  finish((p, doc) => {
    const prepared = prepareParsedResult(p, { id: doc.id, materialId, version: doc.version, originalSha256: sha }, metadata, doc.requestedPages!);
    p.pages[0].reading_order.reviews.push({ id: randomUUID(), method: "visual_review", evidence_ref: "synthetic-review", reviewer: "SYNTHETIC", reviewed_at: "2026-09-24T00:00:00.000Z",
      document_id: doc.id, material_id: materialId, parse_version: doc.version, original_sha256: sha,
      target: { physical_page: 1, block_id: null }, ...parsedPageHashes(prepared.pages[0]), scope: ["reading_order"], outcome: "blocked", note: "SYNTHETIC ONLY" });
  });
  expect(inspect()).toMatchObject({ status: "partial", excludedPages: [1], selection: { physicalPages: [2, 3] } });
  saveProposal();
});
it("keeps complete multi-page source membership and excludes merges into an unusable page", () => {
  finish(p => {
    const first = p.pages[0].blocks[0], member = p.pages[1].blocks[0].source_regions[0];
    first.source_regions.push(structuredClone(member)); first.source_member_ids.push(member.member_id);
  });
  expect(inspect().status).toBe("ready"); saveProposal();
  finish(p => {
    const first = p.pages[0].blocks[0], member = p.pages[1].blocks[0].source_regions[0];
    first.source_regions.push(structuredClone(member)); first.source_member_ids.push(member.member_id);
    p.pages[1].issues.push(issue(2, "blocked"));
  });
  expect(inspect()).toMatchObject({ status: "partial", selection: { physicalPages: [3] }, excludedPages: [1, 2] });
  expect(saveProposal().paragraphs).toHaveLength(1);
});
it("distinguishes one failed page from unattempted pages without rewriting historical coverage", () => {
  const doc = finish(p => {
    p.coverage.succeeded_pages = [1]; p.coverage.failed_pages = [2, 3];
    for (const page of p.pages.slice(1)) Object.assign(page, { parse_status: "failed", failure_code: "parser_error", render: null, blocks: [], reading_order: { block_ids: [], origin: "synthetic unprocessed", reviews: [] } });
  });
  for (const [physical, status] of [[1, "completed"], [2, "failed"], [3, "pending"]] as const)
    repo.database.prepare("INSERT INTO learning_pdf_requests(document_id,material_id,page_id,physical_page,request_id,status) VALUES(?,?,?,?,?,?)").run(doc.id, materialId, pageId, physical, `${doc.id}_${physical}`, status);
  expect(inspect()).toMatchObject({ status: "partial", completedPages: [1], failedPages: [2], pendingPages: [3], selection: { physicalPages: [1] } });
  expect(repo.getParsedDocument(pageId, doc.id).coverage?.failed_pages).toEqual([2, 3]);
  saveProposal();
});
it("requires partial permission when only a selected subset was parsed", () => {
  finish(undefined, [2]);
  expect(inspect()).toMatchObject({ status: "partial", partial: true, pendingPages: [1, 3], excludedPages: [1, 3], selection: { physicalPages: [2] } });
});
it("keeps resource-wait pages pending without calling them OCR failures or changing saved coverage", () => {
  const doc = finish(p => {
    p.coverage.succeeded_pages = [1]; p.coverage.failed_pages = [2, 3];
    for (const page of p.pages.slice(1)) Object.assign(page, { parse_status: "failed", failure_code: "parser_error", render: null, blocks: [], reading_order: { block_ids: [], origin: "synthetic unprocessed", reviews: [] } });
  });
  for (const [physical, status] of [[1, "completed"], [2, "waiting_resource"], [3, "pending"]] as const)
    repo.database.prepare("INSERT INTO learning_pdf_requests(document_id,material_id,page_id,physical_page,request_id,status) VALUES(?,?,?,?,?,?)").run(doc.id, materialId, pageId, physical, `${doc.id}_${physical}`, status);
  expect(inspect()).toMatchObject({ status: "partial", processing: "waiting_resource", completedPages: [1], pendingPages: [2, 3], failedPages: [], unknownPages: [], selection: { physicalPages: [1] } });
  expect(inspect().limitations).toContain("等待解析资源，已完成 1/3 页；已完成页已保存。");
  expect(repo.getParsedDocument(pageId, doc.id).coverage?.failed_pages).toEqual([2, 3]);
  expect(repo.getParsedDocument(pageId, doc.id).pages![0].blocks[0].quality.status).toBe("unverified");
  repo.database.prepare("UPDATE learning_pdf_requests SET request_context_json=? WHERE document_id=? AND physical_page=2")
    .run(JSON.stringify({ issue: "pdf_parser_service_changed" }), doc.id);
  expect(inspect().processing).toBeUndefined();
  expect(inspect().limitations).toContain("上次处理对应的解析服务已变化，需要先核对原请求；已完成页和原件仍保留。");
});
it.each([
  ["budget_exhausted", "本轮解析额度已用完"], ["session_expired", "本轮解析服务使用时段已结束"]
] as const)("preserves the %s stop reason instead of promising a resource retry", (processing, label) => {
  const doc = finish(p => {
    p.coverage.succeeded_pages = [1]; p.coverage.failed_pages = [2, 3];
    for (const page of p.pages.slice(1)) Object.assign(page, { parse_status: "failed", failure_code: "parser_error", render: null, blocks: [], reading_order: { block_ids: [], origin: "synthetic unprocessed", reviews: [] } });
  });
  for (const [physical, status] of [[1, "completed"], [2, "failed"], [3, "pending"]] as const)
    repo.database.prepare("INSERT INTO learning_pdf_requests(document_id,material_id,page_id,physical_page,request_id,status,request_context_json) VALUES(?,?,?,?,?,?,?)")
      .run(doc.id, materialId, pageId, physical, `${doc.id}_${physical}`, status, physical === 2 ? JSON.stringify({ issue: `pdf_parser_${processing}` }) : null);
  expect(inspect()).toMatchObject({ status: "partial", processing, completedPages: [1], pendingPages: [3], failedPages: [2], selection: { physicalPages: [1] } });
  expect(inspect().limitations).toContain(`${label}，已完成页和原件仍保留；未完成页不会自动重试。`);
  expect(inspect().limitations.join(" ")).not.toContain("等待解析资源");
  expect(repo.getParsedDocument(pageId, doc.id).coverage?.failed_pages).toEqual([2, 3]);
});
it("describes active remaining-page work but never treats an unknown outcome as a resource wait", () => {
  const doc = attempt(); repo.startParsedDocument(pageId, doc.id);
  for (const [physical, status] of [[1, "completed"], [2, "pending"], [3, "pending"]] as const)
    repo.database.prepare("INSERT INTO learning_pdf_requests(document_id,material_id,page_id,physical_page,request_id,status) VALUES(?,?,?,?,?,?)").run(doc.id, materialId, pageId, physical, `${doc.id}_${physical}`, status);
  expect(inspect()).toMatchObject({ status: "waiting", processing: "resuming", completedPages: [1], pendingPages: [2, 3], selection: null });
  repo.database.prepare("UPDATE learning_pdf_requests SET status='unknown' WHERE document_id=? AND physical_page=2").run(doc.id);
  repo.database.prepare("UPDATE learning_pdf_requests SET status='waiting_resource' WHERE document_id=? AND physical_page=3").run(doc.id);
  expect(inspect()).toMatchObject({ status: "waiting", completedPages: [1], pendingPages: [3], unknownPages: [2], selection: null });
  expect(inspect().processing).toBeUndefined();
  expect(inspect().limitations).toContain("1 页处理结果待确认，不会自动重新提交。");
});
it("blocks all-empty output and missing attempts instead of inventing a scope", () => {
  expect(inspect()).toMatchObject({ status: "blocked", selection: null, pendingPages: [1, 2, 3] });
  finish(p => { for (const page of p.pages) for (const b of page.blocks) b.content = { raw: null, normalized: null, format: "plain", cleaning: "none" }; });
  expect(inspect()).toMatchObject({ status: "blocked", selection: null, partial: true, excludedPages: [1, 2, 3] });
});
it("waits for the latest version and never silently reuses an older completed parse", () => {
  finish(); const pending = attempt();
  expect(inspect()).toMatchObject({ documentId: pending.id, status: "waiting", selection: null });
  repo.startParsedDocument(pageId, pending.id);
  repo.database.prepare("INSERT INTO learning_pdf_requests(document_id,material_id,page_id,physical_page,request_id,status) VALUES(?,?,?,?,?,'unknown')")
    .run(pending.id, materialId, pageId, 1, `${pending.id}_1`);
  repo.failParsedDocument(pageId, pending.id, "parser_error");
  expect(inspect()).toMatchObject({ documentId: pending.id, status: "blocked", selection: null, unknownPages: [1] });
});
it("inspects an explicitly chosen older version without changing saved scope or historical sources", () => {
  const older = finish(); saveProposal();
  const savedScope = repo.get(pageId).materials[0].pdfStudy;
  const historical = repo.source(pageId, materialId).paragraphs[0].parsed!;
  const olderSnapshot = repo.getParsedDocument(pageId, older.id);
  const latest = finish(p => { p.pages[0].issues.push(issue(1, "blocked")); });
  const changes = repo.database.prepare("SELECT total_changes() AS n").get();
  expect(inspect()).toMatchObject({ documentId: latest.id, status: "partial", excludedPages: [1] });
  expect(inspectLearningPdfReadiness(repo, pageId, materialId, older.id)).toMatchObject({ documentId: older.id, status: "ready", partial: false,
    selection: { documentId: older.id, physicalPages: [1, 2, 3] } });
  expect(repo.get(pageId).materials[0].pdfStudy).toEqual(savedScope);
  expect(repo.getParsedDocument(pageId, older.id)).toEqual(olderSnapshot);
  expect(repo.source(pageId, materialId, historical).paragraphs[0].parsed).toEqual(historical);
  expect(repo.database.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
});
it("rejects an explicitly chosen version from another material even with identical original bytes", () => {
  const doc = finish(), second = randomUUID();
  repo.saveMaterials(pageId, [{ id: second, title: "SYNTHETIC SECOND", kind: "pdf", filename: "synthetic-second.pdf", bytes, pdf: metadata }]);
  expect(() => inspectLearningPdfReadiness(repo, pageId, second, doc.id)).toThrow("parsed_document_not_found");
  expect(() => inspectLearningPdfReadiness(repo, pageId, materialId, randomUUID())).toThrow("parsed_document_not_found");
  expect(repo.get(pageId).materials.find(m => m.id === second)?.pdfStudy).toBeUndefined();
});
it("rejects wrong-account, wrong-page and deleted sources and does not restore their data", () => {
  const doc = finish(), other = new LearningRepository(root, "synthetic-stranger");
  try { expect(() => inspectLearningPdfReadiness(other, pageId, materialId)).toThrow("page_not_found"); } finally { other.close(); }
  const otherPage = repo.create({ id: randomUUID(), title: "SYNTHETIC OTHER" });
  expect(() => inspectLearningPdfReadiness(repo, otherPage.id, materialId)).toThrow("material_not_found");
  repo.deleteMaterial(pageId, materialId);
  expect(inspect).toThrow("material_deleted");
  expect(repo.getParsedDocument(pageId, doc.id).sourceState).toBe("source_deleted");
});
