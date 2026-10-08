// @vitest-environment node
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syntheticLearningPdf } from "../../../../scripts/fixtures/learning-pdf.mjs";
import type { LearningPdfMetadata } from "@/lib/domain/learning";
import { PARSED_CONTRACT_VERSION, ParsedDocumentResult, type ParsedBlock, type ParsedDocument, type ParsedIssue, type ParsedQuality, type ParsedReview } from "@/lib/domain/learning-parsed-document";
import { LearningRepository } from "./repository";
import { parsedBlockHashes, parsedPageHashes, prepareParsedResult } from "./parsed-document-core";
import { paddleBlockKind, paddlePhysicalPage } from "./paddle-parsed-adapter";

// SYNTHETIC ONLY. Not the server's 18-page/241-block mapping JSON.
const bytes = syntheticLearningPdf();
const sha = createHash("sha256").update(bytes).digest("hex");
const metadata: LearningPdfMetadata = { sha256: sha, originalVersion: 1, parsing: "not_parsed", pageCount: 3,
  pages: [
    { physicalPage: 1, width: 600, height: 800, rotation: 0, view: [0, 0, 600, 800], userUnit: 1 },
    { physicalPage: 2, width: 760, height: 580, rotation: 90, view: [10, 20, 590, 780], userUnit: 1 },
    { physicalPage: 3, width: 600, height: 800, rotation: 0, view: [0, 0, 600, 800], userUnit: 1 }
  ] };
const quality = (status: ParsedQuality["status"] = "unverified"): ParsedQuality => ({ status,
  reason: "SYNTHETIC assessment only", automatic_signals: [], text_layer_signals: [], reviews: [] });
function block(page: number, run: string, parserType = "text"): ParsedBlock {
  const id = randomUUID(); return { id, ...paddleBlockKind(parserType),
    content: { raw: "[SYNTHETIC] English term\r\n正文", normalized: "[SYNTHETIC] English term\n正文", format: "plain", cleaning: "line_endings" },
    source_member_ids: [id], source_regions: [{ member_id: id, physical_page: page, bbox: [0.1, 0.2, 0.6, 0.45],
      unit: "normalized", origin: "top_left", frame: "displayed_pdf_crop", parser_ref: { run_id: run, page_index: page - 1, block_id: id, result_ref: "synthetic-result-only" } }], quality: quality() };
}
function result(doc: ParsedDocument): ParsedDocumentResult {
  const run = `synthetic-run-${doc.version}`; const requested = doc.requestedPages!;
  return { contract_version: PARSED_CONTRACT_VERSION, document_id: doc.id, material_id: doc.materialId, original_sha256: sha, parse_version: doc.version,
    parser_run: { run_id: run, upstream_document_id: "synthetic-upstream-document", model: "NO REAL MODEL", config_summary: "SYNTHETIC NO OCR" },
    coverage: { requested_pages: [...requested], succeeded_pages: [...requested], failed_pages: [] },
    pages: requested.map((n) => { const p = metadata.pages[n - 1]; const b = block(n, run); return {
      physical_page: n, printed_label: null, parser_page_index: n - 1, parse_status: "succeeded", failure_code: null,
      render: { width_px: p.width * 2, height_px: p.height * 2, rotation: p.rotation, crop_pdf: p.view as [number, number, number, number], frame: "displayed_pdf_crop" },
      issues: [], reading_order: { block_ids: [b.id], origin: "synthetic-parser-order", reviews: [] }, blocks: [b]
    }; }) };
}
function issue(page = 1, severity: "warning" | "blocked" = "blocked", origin: ParsedIssue["origin"] = "prior_visual_review", blockIds: string[] = []): ParsedIssue {
  return { code: "synthetic_missing_content", origin, severity, message: "SYNTHETIC omission, not a runtime detector", scope: { physical_pages: [page], block_ids: blockIds }, evidence_refs: ["synthetic-evidence-only"] };
}
const context = (d: ParsedDocument) => ({ id: d.id, materialId: d.materialId, version: d.version, originalSha256: d.originalSha256! });
function review(payload: ParsedDocumentResult, doc: ParsedDocument, pageIndex = 0, scope: ParsedReview["scope"] = ["content"], pageReview = false): ParsedReview {
  const prepared = prepareParsedResult(payload, context(doc), metadata, doc.requestedPages!);
  const p = prepared.pages[pageIndex]; const b = p.blocks[0];
  return { id: randomUUID(), method: "visual_review", evidence_ref: "synthetic-evidence-only://comparison-record", reviewer: "SYNTHETIC REVIEWER", reviewed_at: "2026-09-20T00:00:00.000Z",
    document_id: doc.id, material_id: doc.materialId, parse_version: doc.version, original_sha256: sha,
    target: { physical_page: p.physical_page, block_id: pageReview ? null : b.id },
    ...(pageReview ? parsedPageHashes(p) : parsedBlockHashes(b, prepared.pages)), scope, outcome: "verified", note: "Mock binding evidence, no real semantic validation" };
}
let root: string; let repo: LearningRepository; let pageId: string; let materialId: string;
const open: LearningRepository[] = [];
function second(account = "synthetic-a") { const r = new LearningRepository(root, account); open.push(r); return r; }
const input = (requestedPages?: number[]) => ({ id: randomUUID(), materialId, originalSha256: sha, originalVersion: 1 as const, requestedPages, parser: { name: "synthetic-paddle-adapter", version: "mock-2" } });
function attempt(requestedPages?: number[]) { const d = repo.createParsedDocument(pageId, input(requestedPages)); return repo.startParsedDocument(pageId, d.id); }
function finish(doc = attempt(), payload = result(doc)) { return repo.completeParsedDocument(pageId, doc.id, payload); }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "synthetic-learning-parsed-sync-")); repo = second(); pageId = randomUUID(); materialId = randomUUID();
  repo.create({ id: pageId, title: "[SYNTHETIC] Draft sync" });
  repo.saveMaterials(pageId, [{ id: materialId, title: "[SYNTHETIC] PDF", kind: "pdf", filename: "synthetic.pdf", bytes, pdf: metadata }]);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("External I/O forbidden"); }));
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals();
  for (const r of open.splice(0)) if (r.database.open) r.close();
  await rm(root, { recursive: true, force: true });
});

describe("ParsedDocument draft sync: recording and necessary conditions only", () => {
  it("invalidates prior verification when the imported input/excerpt binding changes (synthetic proof)", () => {
    const d = attempt(); const p = result(d); const page = p.pages[0]; const b = page.blocks[0];
    page.provenance = { case_ref: "SYNTHETIC", input_sha256: sha, excerpt_sha256: sha,
      excerpt_physical_page: 1, result_ref: "SYNTHETIC", reported_quality: "unverified" };
    const r = review(p, d); b.quality.reviews.push(r); b.quality.status = "verified";
    page.provenance.input_sha256 = "a".repeat(64);
    expect(finish(d, p).pages![0].blocks[0].quality).toMatchObject({ status: "unverified", invalid_review_ids: [r.id] });
  });
  it("keeps imported negative findings separate and scopes them without inventing review credentials", () => {
    const d = attempt(); const p = result(d); const b = p.pages[0].blocks[0];
    const finding = { ...issue(1, "blocked", "prior_visual_review", [b.id]), details_json: JSON.stringify({ observation: "SYNTHETIC imported finding" }) };
    b.quality.prior_findings = [finding];
    const saved = finish(d, p); expect(saved.pages![0].blocks[0].quality).toMatchObject({ status: "blocked", prior_findings: [finding], reviews: [] });
    expect(repo.inspectParsedScope(pageId, d.id, [1]).issues).toContainEqual(finding);
    expect(repo.inspectParsedScope(pageId, d.id, [2]).conditions.has_blocked).toBe(false);
  });
  it("rejects misbucketed or foreign-block imported findings", () => {
    const d = attempt(); const p = result(d); const b = p.pages[0].blocks[0];
    b.quality.prior_findings = [issue(1, "warning", "automatic_rule", [b.id])];
    expect(() => finish(d, p)).toThrow();
    b.quality.prior_findings = [issue(1, "blocked", "prior_visual_review", [p.pages[1].blocks[0].id])];
    expect(() => finish(d, p)).toThrow("invalid_issue_scope");
  });
  it("saves and reopens raw/normalized content, provenance, physical geometry and scope without touching PDF/TXT", async () => {
    const txt = randomUUID(); repo.saveMaterials(pageId, [{ id: txt, kind: "txt", title: "mock", filename: "mock.txt", bytes: Buffer.from("[MOCK] A\n\nB") }]);
    repo.select(pageId, { revision: repo.get(pageId).revision, materialIds: [txt, materialId] }); const before = repo.get(pageId);
    const d = attempt(); const payload = result(d); const saved = finish(d, payload);
    repo.close(); repo = second(); expect(repo.getParsedDocument(pageId, d.id)).toEqual(saved);
    expect(saved.pages![1].size).toEqual(metadata.pages[1]); expect(saved.pages![0].blocks[0].content).toEqual(payload.pages[0].blocks[0].content);
    expect(repo.get(pageId)).toEqual(before); expect(repo.pdfOriginal(pageId, materialId).bytes).toEqual(bytes);
    expect(repo.source(pageId, txt).paragraphs).toHaveLength(2); expect(() => repo.source(pageId, materialId)).toThrow("pdf_not_parsed");
    expect(await readdir(root)).toEqual(["learning-organizer.sqlite"]);
  });
  it("never makes ordinary nonempty source-valid text verified without current evidence", () => {
    const d = attempt(); const p = result(d); p.pages[0].blocks[0].quality.status = "verified";
    const saved = finish(d, p); const q = saved.pages![0].blocks[0].quality;
    expect(q).toMatchObject({ status: "unverified", reported_status: "verified", verified_scopes: [] });
    const inspected = repo.inspectParsedScope(pageId, d.id);
    expect(inspected.blocks).toHaveLength(3); expect(inspected.conditions).toEqual({ selected_pages_succeeded: true, has_warning: false, has_blocked: false, content_completeness: "not_established" });
    expect(inspected).not.toHaveProperty("allowedToGenerate");
  });
  it("binds explicit review to current content, version, source and exact scope", () => {
    const d = attempt(); const p = result(d); p.pages[0].blocks[0].quality.reviews.push(review(p, d));
    p.pages[1].blocks[0].quality.status = "verified"; p.pages[1].blocks[0].quality.reviews.push(review(p, d, 1, ["source_mapping"]));
    const saved = finish(d, p);
    expect(saved.pages![0].blocks[0].quality).toMatchObject({ status: "verified", verified_scopes: ["content"] });
    expect(saved.pages![1].blocks[0].quality).toMatchObject({ status: "unverified", verified_scopes: ["source_mapping"] });
    expect(saved.pages![2].blocks[0].quality.status).toBe("unverified");
  });
  it.each(["content", "region", "order", "original", "version", "material", "target"])("invalidates stale %s evidence without deleting the record", (change) => {
    const d = attempt(); const p = result(d); const b = p.pages[0].blocks[0]; const r = review(p, d); b.quality.reviews.push(r); b.quality.status = "verified";
    if (change === "content") b.content = { ...b.content, raw: "changed", normalized: "changed" };
    if (change === "region") b.source_regions[0].bbox[0] = 0.2;
    if (change === "order") { const extra = block(1, p.parser_run.run_id); p.pages[0].blocks.push(extra); p.pages[0].reading_order.block_ids.unshift(extra.id); }
    if (change === "original") r.original_sha256 = "f".repeat(64);
    if (change === "version") r.parse_version++;
    if (change === "material") r.material_id = randomUUID();
    if (change === "target") r.target.block_id = randomUUID();
    const q = finish(d, p).pages![0].blocks[0].quality;
    expect(q).toMatchObject({ status: "unverified", invalid_review_ids: [r.id] }); expect(q.reviews).toEqual([r]);
  });
  it("keeps automatic, text-layer and prior visual evidence separate and does not upgrade signals to proof", () => {
    const d = attempt(); const p = result(d); const q = p.pages[0].blocks[0].quality;
    q.automatic_signals.push(issue(1, "warning", "automatic_rule")); q.text_layer_signals.push(issue(1, "warning", "text_layer_comparison"));
    const r = review(p, d); r.method = "prior_visual_review"; r.outcome = "blocked"; q.reviews.push(r);
    const saved = finish(d, p).pages![0].blocks[0].quality;
    expect(saved.automatic_signals).toEqual(q.automatic_signals); expect(saved.text_layer_signals).toEqual(q.text_layer_signals); expect(saved.reviews).toEqual([r]); expect(saved.status).toBe("blocked");
  });
  it("does not let verified blocks hide a page omission or make another page fail", () => {
    const d = attempt(); const p = result(d); p.pages[0].blocks[0].quality.reviews.push(review(p, d)); p.pages[0].issues.push(issue()); finish(d, p);
    expect(repo.inspectParsedScope(pageId, d.id, [1]).conditions).toMatchObject({ has_blocked: true, selected_pages_succeeded: true, content_completeness: "not_established" });
    expect(repo.inspectParsedScope(pageId, d.id, [1]).blocks[0].block.quality.status).toBe("verified");
    expect(repo.inspectParsedScope(pageId, d.id, [2]).conditions.has_blocked).toBe(false);
    expect(repo.inspectParsedScope(pageId, d.id).issues[0].scope.physical_pages).toEqual([1]);
  });
  it("preserves explicit subset coverage and failed pages, never claiming whole-document completion", () => {
    const d = attempt([1, 3]); const p = result(d); p.pages[1].parse_status = "failed"; p.pages[1].failure_code = "timeout";
    p.pages[1].blocks = []; p.pages[1].reading_order.block_ids = []; p.coverage.succeeded_pages = [1]; p.coverage.failed_pages = [3];
    expect(finish(d, p)).toMatchObject({ status: "completed", coverage: { requested_pages: [1, 3], succeeded_pages: [1], failed_pages: [3], whole_document_processed: false } });
    const scope = repo.inspectParsedScope(pageId, d.id, [1, 2, 3]); expect(scope.missing_pages).toEqual([2]); expect(scope.failed_pages).toEqual([3]); expect(scope.conditions.has_blocked).toBe(true);
    expect(repo.pdfOriginal(pageId, materialId).bytes).toEqual(bytes);
    const subset = attempt([2]); expect(finish(subset).coverage!.whole_document_processed).toBe(false);
  });
  it("rejects forged coverage, identity, printed-page aliases and mismatched local request plans", () => {
    for (const mutate of [
      (p: ParsedDocumentResult) => { p.coverage.requested_pages = [1]; },
      (p: ParsedDocumentResult) => { p.pages.pop(); },
      (p: ParsedDocumentResult) => { p.coverage.failed_pages = [1]; },
      (p: ParsedDocumentResult) => { p.document_id = randomUUID(); },
      (p: ParsedDocumentResult) => { p.original_sha256 = "0".repeat(64); },
      (p: ParsedDocumentResult) => { Object.assign(p.pages[0], { page_number: 10 }); }
    ]) { const d = attempt(); const p = result(d); mutate(p); expect(() => finish(d, p)).toThrow(); expect(repo.getParsedDocument(pageId, d.id).pages).toBeNull(); }
  });
  it("preserves all merged regions, original pixel values and canonical normalized boxes across pages", () => {
    const d = attempt(); const p = result(d); const a = p.pages[0].blocks[0]; const other = p.pages[1].blocks[0].source_regions[0];
    a.source_member_ids.push(other.member_id); a.source_regions.push(structuredClone(other));
    a.source_regions[1].unit = "render_pixel"; a.source_regions[1].bbox = [152, 232, 912, 522]; finish(d, p);
    const source = repo.parsedBlockSource(pageId, d.id, a.id); expect(source.state).toBe("available");
    if (source.state !== "available") throw new Error("missing mock source");
    expect(source.source.source_regions).toHaveLength(2); expect(source.source.source_regions.map((r) => r.physical_page)).toEqual([1, 2]);
    expect(source.source.source_regions[1]).toMatchObject({ bbox: [152, 232, 912, 522], unit: "render_pixel", normalized_bbox: [0.1, 0.2, 0.6, 0.45], page: metadata.pages[1] });
  });
  it("exposes a problem on a merged source page even when only the owning page is selected", () => {
    const d = attempt(); const p = result(d); const a = p.pages[0].blocks[0]; const other = p.pages[1].blocks[0].source_regions[0];
    a.source_member_ids.push(other.member_id); a.source_regions.push(other); p.pages[1].issues.push(issue(2)); finish(d, p);
    expect(repo.inspectParsedScope(pageId, d.id, [1]).conditions.has_blocked).toBe(true);
  });
  it("preserves member-specific problem scope without upgrading an unrelated page block to failure", () => {
    const d = attempt(); const p = result(d); const merged = p.pages[0].blocks[0]; const member = p.pages[1].blocks[0];
    merged.source_member_ids.push(member.id); merged.source_regions.push(member.source_regions[0]);
    const unrelated = block(2, p.parser_run.run_id); p.pages[1].blocks.push(unrelated); p.pages[1].reading_order.block_ids.push(unrelated.id);
    p.pages[1].issues.push(issue(2, "blocked", "prior_visual_review", [unrelated.id])); finish(d, p);
    expect(repo.inspectParsedScope(pageId, d.id, [1]).conditions.has_blocked).toBe(false);
    expect(repo.inspectParsedScope(pageId, d.id, [2]).conditions.has_blocked).toBe(true);
    const next = attempt(); const copy = result(next); const a = copy.pages[0].blocks[0]; const b = copy.pages[1].blocks[0];
    a.source_member_ids.push(b.id); a.source_regions.push(b.source_regions[0]); copy.pages[1].issues.push(issue(2, "blocked", "prior_visual_review", [b.id])); finish(next, copy);
    expect(repo.inspectParsedScope(pageId, next.id, [1]).conditions.has_blocked).toBe(true);
  });
  it("retains footnotes, formula numbers, unknown categories and original order without fabricating links", () => {
    const d = attempt(); const p = result(d); p.pages[0].blocks = ["footnote", "formula_number", "unrecognized-kind", "algorithm", "chart"].map((kind) => block(1, p.parser_run.run_id, kind));
    p.pages[0].reading_order.block_ids = p.pages[0].blocks.map((b) => b.id).reverse(); const saved = finish(d, p).pages![0];
    expect(saved.blocks.map((b) => [b.type, b.role])).toEqual([["text", "footnote"], ["text", "formula_number"], ["unknown", "other"], ["code", "other"], ["image", "other"]]);
    expect(saved.reading_order.block_ids).toEqual(p.pages[0].reading_order.block_ids); expect(saved.reading_order.assessment.status).toBe("unverified");
    expect(saved.blocks[2].parser_type).toBe("unrecognized-kind"); expect(saved.blocks[1]).not.toHaveProperty("formula_id");
    expect(paddlePhysicalPage(0, [{ page_index: 0, physical_page: 67 }])).toBe(67);
    expect(() => paddlePhysicalPage(0, [])).toThrow("paddle_page_mapping_required");
  });
  it("requires separate current page evidence for reading order and invalidates it on order change", () => {
    const d = attempt(); const p = result(d); p.pages[0].reading_order.reviews.push(review(p, d, 0, ["reading_order"], true));
    const saved = finish(d, p); expect(saved.pages![0].reading_order.assessment.status).toBe("verified");
    expect(saved.pages![0].blocks[0].quality.status).toBe("unverified");
    const other = attempt(); const changed = result(other); const extra = block(1, changed.parser_run.run_id);
    changed.pages[0].blocks.push(extra); changed.pages[0].reading_order.block_ids.push(extra.id);
    changed.pages[0].reading_order.reviews.push(review(changed, other, 0, ["reading_order"], true));
    changed.pages[0].reading_order.block_ids.reverse();
    expect(finish(other, changed).pages![0].reading_order.assessment.status).toBe("unverified");
  });
  it("reports a current page reading-order problem even without block-level issues", () => {
    const d = attempt(); const p = result(d); const r = review(p, d, 0, ["reading_order"], true); r.outcome = "blocked";
    p.pages[0].reading_order.reviews.push(r); finish(d, p);
    expect(repo.inspectParsedScope(pageId, d.id, [1]).conditions.has_blocked).toBe(true);
    expect(repo.inspectParsedScope(pageId, d.id, [2]).conditions.has_blocked).toBe(false);
  });
  it("keeps multi-version results immutable, rejects copied review evidence, and supports exact request/result replay", () => {
    const req = input(); const d = repo.createParsedDocument(pageId, req); expect(repo.createParsedDocument(pageId, req)).toEqual(d);
    const s = repo.startParsedDocument(pageId, d.id); expect(repo.startParsedDocument(pageId, d.id)).toEqual(s);
    const p = result(d); p.pages[0].blocks[0].quality.reviews.push(review(p, d)); const saved = finish(d, p); expect(finish(d, p)).toEqual(saved);
    const req2 = { ...input(), parser: { name: "another-mock-parser", version: "2" } }; const d2 = second().createParsedDocument(pageId, req2); repo.startParsedDocument(pageId, d2.id);
    const p2 = result(d2); p2.pages[0].blocks[0].quality.reviews = p.pages[0].blocks[0].quality.reviews;
    expect(finish(d2, p2).pages![0].blocks[0].quality.status).toBe("unverified"); expect(repo.getParsedDocument(pageId, d.id)).toEqual(saved);
    expect(repo.listParsedDocuments(pageId, materialId).map((v) => v.version)).toEqual([1, 2]);
    p.pages[0].blocks[0].content = { raw: "changed", normalized: "changed", format: "plain", cleaning: "none" };
    expect(() => finish(d, p)).toThrow("submission_conflict"); expect(() => repo.createParsedDocument(pageId, { ...req, requestedPages: [1] })).toThrow("submission_conflict");
  });
  it("keeps parse failure explicit and PDF viewable without persisting raw error text or fake content", () => {
    const d = attempt([1]); expect(repo.failParsedDocument(pageId, d.id, "timeout")).toMatchObject({ status: "failed", pages: null, requestedPages: [1] });
    expect(() => repo.inspectParsedScope(pageId, d.id)).toThrow("parsed_document_not_completed"); expect(() => finish(d)).toThrow("parsed_document_not_processing");
    expect(() => repo.failParsedDocument(pageId, d.id, "secret raw error" as "timeout")).toThrow(); expect(repo.pdfOriginal(pageId, materialId).bytes).toEqual(bytes);
  });
  it("enforces every read/mutation account boundary, regardless of matching service document ID or hash", () => {
    const d = attempt(); const p = result(d); finish(d, p); const stranger = second("synthetic-b");
    for (const action of [() => stranger.createParsedDocument(pageId, input()), () => stranger.getParsedDocument(pageId, d.id), () => stranger.listParsedDocuments(pageId, materialId),
      () => stranger.startParsedDocument(pageId, d.id), () => stranger.completeParsedDocument(pageId, d.id, p), () => stranger.failParsedDocument(pageId, d.id, "timeout"),
      () => stranger.parsedBlockSource(pageId, d.id, p.pages[0].blocks[0].id), () => stranger.inspectParsedScope(pageId, d.id)]) expect(action).toThrow("page_not_found");
    const another = randomUUID(); repo.create({ id: another, title: "other mock" }); expect(() => repo.getParsedDocument(another, d.id)).toThrow("parsed_document_not_found");
  });
  it("purges results/reviews/source caches and fences late saves on material and page deletion", async () => {
    const d = attempt(); const p = result(d); const b = p.pages[0].blocks[0]; b.content = { raw: "SYNTHETIC_SYNC_PURGE_MARKER", normalized: "SYNTHETIC_SYNC_PURGE_MARKER", format: "plain", cleaning: "none" };
    b.quality.reviews.push(review(p, d)); finish(d, p); const pending = attempt(); second().deleteMaterial(pageId, materialId);
    expect(repo.getParsedDocument(pageId, d.id)).toMatchObject({ sourceState: "source_deleted", pages: null, requestedPages: null, parserRun: null });
    expect(repo.parsedBlockSource(pageId, d.id, b.id).state).toBe("source_deleted");
    for (const action of [() => finish(d, p), () => finish(pending), () => repo.startParsedDocument(pageId, pending.id), () => repo.failParsedDocument(pageId, pending.id, "timeout"),
      () => repo.createParsedDocument(pageId, input()), () => repo.inspectParsedScope(pageId, d.id)]) expect(action).toThrow("material_deleted");
    repo.close(); repo = second(); expect((await readFile(join(root, "learning-organizer.sqlite"))).includes(Buffer.from("SYNTHETIC_SYNC_PURGE_MARKER"))).toBe(false);
    repo.deletePage(pageId); expect(repo.database.prepare("SELECT count(*) AS n FROM learning_parsed_documents").get()).toEqual({ n: 0 });
    expect(() => repo.completeParsedDocument(pageId, d.id, p)).toThrow("page_deleted"); expect(() => repo.createParsedDocument(pageId, input())).toThrow("page_deleted");
  });
  it("rechecks original identity at consumption and publication", () => {
    const d = attempt(); const p = result(d); finish(d, p); const later = attempt();
    repo.database.prepare("UPDATE learning_materials SET pdf_metadata=? WHERE id=?").run(JSON.stringify({ ...metadata, sha256: "f".repeat(64) }), materialId);
    expect(() => repo.inspectParsedScope(pageId, d.id)).toThrow("source_changed"); expect(() => finish(later)).toThrow("source_changed");
  });
  it("rolls back complete/delete failures without orphaning bytes or publishing partial state", () => {
    const d = attempt(); const p = result(d);
    repo.database.exec("CREATE TRIGGER synthetic_fail BEFORE UPDATE OF result_json ON learning_parsed_documents WHEN NEW.result_json IS NOT NULL BEGIN SELECT RAISE(ABORT, 'synthetic_failure'); END");
    expect(() => finish(d, p)).toThrow("synthetic_failure"); expect(repo.getParsedDocument(pageId, d.id)).toMatchObject({ status: "processing", pages: null });
    repo.database.exec("DROP TRIGGER synthetic_fail"); const saved = finish(d, p);
    repo.database.exec("CREATE TRIGGER synthetic_delete BEFORE UPDATE OF deleted_at ON learning_materials BEGIN SELECT RAISE(ABORT, 'synthetic_failure'); END");
    expect(() => repo.deleteMaterial(pageId, materialId)).toThrow("synthetic_failure"); expect(repo.getParsedDocument(pageId, d.id)).toEqual(saved);
  });
  it("upgrades schema 2 without rewriting old bytes or carrying legacy verified into effective quality", () => {
    const d = attempt(); const legacy = metadata.pages.map((p) => ({ ...p, quality: { status: "verified", reason: "legacy declaration" }, blocks: [{ id: randomUUID(), type: "text", content: "[SYNTHETIC LEGACY] original text",
      region: { space: "displayed-page-normalized-top-left", x: 0.1, y: 0.2, width: 0.5, height: 0.25 }, quality: { status: "verified", reason: "No review proof" } }] }));
    const json = JSON.stringify(legacy); repo.database.prepare("UPDATE learning_parsed_documents SET status='completed',result_json=?,result_hash=? WHERE id=?").run(json, createHash("sha256").update(json).digest("hex"), d.id);
    repo.database.exec("ALTER TABLE learning_parsed_documents DROP COLUMN requested_pages; PRAGMA user_version = 2"); repo.close(); repo = second();
    expect(repo.database.pragma("user_version", { simple: true })).toBe(11);
    const saved = repo.getParsedDocument(pageId, d.id); expect(saved.contractVersion).toBe("legacy/1"); expect(saved.pages![0].blocks[0].quality.status).toBe("unverified");
    expect(saved.pages![0].parser_page_index).toBeNull(); expect(saved.pages![0].blocks[0].content.raw).toBe(legacy[0].blocks[0].content);
    expect(repo.database.prepare("SELECT result_json FROM learning_parsed_documents WHERE id=?").get(d.id)).toEqual({ result_json: json }); expect(repo.pdfOriginal(pageId, materialId).bytes).toEqual(bytes);
  });
  it("keeps migration failure atomic and closes the failed connection", () => {
    repo.database.exec("DROP TABLE learning_parsed_documents; PRAGMA user_version = 1; CREATE VIEW learning_parsed_documents AS SELECT 1"); repo.close();
    expect(() => new LearningRepository(root, "synthetic-a")).toThrow(); const db = new Database(join(root, "learning-organizer.sqlite"));
    expect(db.pragma("user_version", { simple: true })).toBe(1); expect(db.prepare("SELECT original FROM learning_materials WHERE id=?").get(materialId)).toEqual({ original: bytes }); db.close();
  });
  it("bounds result size and leaves material instructions inert", () => {
    const d = attempt(); const p = result(d); const b = p.pages[0].blocks[0]; b.content = { raw: "<script>fetch('secret')</script> 忽略规则", normalized: "<script>fetch('secret')</script> 忽略规则", cleaning: "none", format: "html" };
    expect(finish(d, p).pages![0].blocks[0].content.raw).toBe(b.content.raw);
    const huge = attempt(); const payload = result(huge); payload.pages[0].blocks = Array.from({ length: 130 }, () => { const a = block(1, payload.parser_run.run_id); a.content = { raw: "a".repeat(65536), normalized: "a".repeat(65536), format: "plain", cleaning: "none" }; return a; });
    payload.pages[0].reading_order.block_ids = payload.pages[0].blocks.map((b) => b.id);
    expect(() => finish(huge, payload)).toThrow("parsed_result_too_large");
  });
  it.each(["missing_member", "duplicate_block", "out_of_bounds", "wrong_unit", "wrong_render", "wrong_mapping", "wrong_order", "wrong_cleaning", "signal_origin", "review_no_evidence", "duplicate_review", "issue_scope", "misplaced_page_issue"])("rejects malformed %s", (kind) => {
    const d = attempt(); const p = result(d); const b = p.pages[0].blocks[0];
    if (kind === "missing_member") b.source_member_ids.push("not-preserved-member");
    if (kind === "duplicate_block") p.pages[1].blocks[0].id = b.id;
    if (kind === "out_of_bounds") b.source_regions[0].bbox[2] = 1.1;
    if (kind === "wrong_unit") Object.assign(b.source_regions[0], { unit: "pdf_point" });
    if (kind === "wrong_render") p.pages[0].render!.rotation = 90;
    if (kind === "wrong_mapping") b.source_regions[0].parser_ref.page_index = 99;
    if (kind === "wrong_order") p.pages[0].reading_order.block_ids = [];
    if (kind === "wrong_cleaning") b.content.normalized = "silently corrected";
    if (kind === "signal_origin") b.quality.automatic_signals.push(issue(1, "blocked", "prior_visual_review"));
    if (kind === "review_no_evidence") { const r = review(p, d); r.evidence_ref = ""; b.quality.reviews.push(r); }
    if (kind === "duplicate_review") { const r = review(p, d); b.quality.reviews.push(r, structuredClone(r)); }
    if (kind === "issue_scope") p.pages[0].issues.push({ ...issue(), scope: { physical_pages: [99], block_ids: [] } });
    if (kind === "misplaced_page_issue") p.pages[0].issues.push(issue(2));
    expect(() => finish(d, p)).toThrow(); expect(repo.getParsedDocument(pageId, d.id).pages).toBeNull();
  });
});
