// @vitest-environment node
// Explicit opt-in: actual delivered public evaluation files; never a fixture or a user database.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, sep, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LearningPdfMetadata } from "@/lib/domain/learning";
import type { ParsedDocument, ParsedDocumentResult } from "@/lib/domain/learning-parsed-document";
import { LearningRepository } from "./repository";
import { inspectLearningPdf, learningPdfAssetRoot } from "./pdf-inspect";
import { adaptPaddleDraftDocument, PaddleHandoffPage, type PaddleHandoffBinding, type PaddleDraftDocument } from "./paddle-parsed-adapter";

const sourceRoot = process.env.LEARNING_PARSED_HANDOFF;
const output = resolve("output/learning-parsed-real-handoff-20260920");
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const paths: string[] = [];
type Manifest = {
  documents: Array<{ document_key: string; original_pdf: string; original_sha256: string; original_page_count: number; title: string; selected_pages_pdf: string }>;
  pages: Array<Parameters<typeof PaddleHandoffPage.parse>[0] & Record<string, unknown>>;
  stages: Array<{ name: string; path: string; sha256: string }>;
  review_findings: string;
};
type Imported = { key: string; materialId: string; pdf: LearningPdfMetadata; bytes: Buffer; importMode: string;
  stages: Array<{ wire: PaddleDraftDocument; binding: PaddleHandoffBinding; payload: ParsedDocumentResult; saved: ParsedDocument }> };
let manifest: Manifest; let repo: LearningRepository; let databaseRoot: string; let pageId: string;
const artifacts = new Map<string, Uint8Array>();
const imported: Imported[] = [];
const read = (relative: string) => {
  const path = resolve(sourceRoot!, relative);
  if (!path.startsWith(resolve(sourceRoot!) + sep)) throw new Error("handoff_path_outside_root");
  return readFileSync(path);
};

describe.runIf(Boolean(sourceRoot))("REAL delivered Paddle JSON offline integration (explicit local package only)", () => {
  beforeAll(async () => {
    mkdirSync(output, { recursive: true }); databaseRoot = mkdtempSync(join(output, "isolated-"));
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("real_handoff_network_forbidden"); }));
    const sums = read("SHA256SUMS.json");
    expect(sha(sums)).toBe("a0a2263e736e66201ff179d496375dbfcc74ddc35a1be0b59f984aab7b1b6e90");
    const index = JSON.parse(sums.toString("utf8")) as { files: Array<{ path: string; bytes: number; sha256: string }> };
    for (const file of index.files) {
      const bytes = read(file.path); expect(bytes.length).toBe(file.bytes); expect(sha(bytes)).toBe(file.sha256);
      artifacts.set(file.sha256, bytes); paths.push(file.path);
    }
    expect(index.files).toHaveLength(164);
    manifest = JSON.parse(read("handoff-manifest.json").toString("utf8"));
    repo = new LearningRepository(databaseRoot, "offline-handoff-owner");
    pageId = repo.create({ id: randomUUID(), title: "[离线真实交付验收] 禁止用于生产" }).id;
    const pdfjs = await import(/* @vite-ignore */ pathToFileURL(join(learningPdfAssetRoot(), "legacy/build/pdf.mjs")).href);
    for (const entry of manifest.documents) {
      const bytes = read(entry.original_pdf); expect(sha(bytes)).toBe(entry.original_sha256);
      // Internal metadata import: no page/byte-limit changes to the product inspector or repository.
      const task = pdfjs.getDocument({ data: Uint8Array.from(bytes), verbosity: 0, enableXfa: false, useWorkerFetch: false });
      let pdf: LearningPdfMetadata;
      try {
        const document = await task.promise;
        expect(document.numPages).toBe(entry.original_page_count);
        const pages = [];
        for (let physicalPage = 1; physicalPage <= document.numPages; physicalPage++) {
          const p = await document.getPage(physicalPage); const view = p.getViewport({ scale: 1 });
          pages.push({ physicalPage, width: view.width, height: view.height, rotation: p.rotate, view: [...p.view], userUnit: p.userUnit }); p.cleanup();
        }
        pdf = { sha256: sha(bytes), originalVersion: 1, pageCount: document.numPages, pages, parsing: "not_parsed" };
      } finally { await task.destroy(); }
      const materialId = randomUUID(); const filename = basename(entry.original_pdf); const title = `[真实公开样本] ${entry.document_key}`;
      const item = { id: materialId, kind: "pdf" as const, title, filename, bytes, pdf };
      const overLimit = bytes.length > 20 * 1024 * 1024 || pdf.pageCount > 200;
      let inspectorFailure: string | null = null;
      try { expect(await inspectLearningPdf(bytes)).toEqual(pdf); }
      catch (error) { inspectorFailure = error instanceof Error ? error.message : "unknown"; }
      const expectedFailures: Record<string, string> = { ZH: "pdf_too_large", CA: "pdf_page_limit", DC: "pdf_incomplete" };
      expect(inspectorFailure).toBe(expectedFailures[entry.document_key] ?? null);
      if (overLimit) {
        expect(() => repo.saveMaterials(pageId, [item])).toThrow(entry.document_key === "ZH" ? "pdf_too_large" : "invalid_pdf");
        // TEST-ONLY authorized bypass into a fresh isolated database. Exact original BLOB/hash/geometry.
        const fingerprint = createHash("sha256").update(JSON.stringify([title, "pdf", filename])).update(bytes).digest("hex");
        repo.database.prepare("INSERT INTO learning_materials(id,page_id,title,kind,filename,original,fingerprint,created_at,pdf_metadata) VALUES(?,?,?,'pdf',?,?,?,?,?)")
          .run(materialId, pageId, title, filename, bytes, fingerprint, new Date().toISOString(), JSON.stringify(pdf));
      } else {
        // DC: PDF.js warns about a 139-byte Name token. Metadata-only offline import
        // is explicitly reported as bypassing the product inspector, never upload acceptance.
        repo.saveMaterials(pageId, [item]);
      }
      imported.push({ key: entry.document_key, materialId, pdf, bytes, importMode: inspectorFailure ? `TEST_ONLY_INTERNAL_IMPORT:${inspectorFailure}` : "LOCAL_INSPECT_AND_REPOSITORY", stages: [] });
      console.log(`[real-handoff] originals ${imported.length}/5 ${entry.document_key} ${pdf.pageCount} physical pages; ${imported.at(-1)!.importMode}`);
    }
    for (const [stageIndex, stage] of manifest.stages.entries()) {
      const docs = JSON.parse(read(stage.path).toString("utf8")) as PaddleDraftDocument[];
      expect(docs).toHaveLength(5); expect(docs.flatMap((d) => d.pages)).toHaveLength(18);
      expect(docs.flatMap((d) => d.pages.flatMap((p) => p.blocks))).toHaveLength(241);
      for (const [i, item] of imported.entries()) {
        const wire = docs.find((d) => d.source.asset_ref === `sha256:${item.pdf.sha256}`)!;
        const attempt = repo.createParsedDocument(pageId, { id: randomUUID(), materialId: item.materialId, originalSha256: item.pdf.sha256, originalVersion: 1,
          requestedPages: wire.coverage.requested_physical_pages, parser: { name: wire.parser.name, version: wire.parser.version } });
        const entry = manifest.documents[i];
        const mappings = manifest.pages.map((p) => PaddleHandoffPage.parse(p)).filter((p) => p.original_sha256 === item.pdf.sha256)
          .map((p) => ({ ...p, excerpt_sha256: sha(read(entry.selected_pages_pdf)),
            text_layer_sha256: sha(read(manifest.pages.find((raw) => raw.case_id === p.case_id)!.source_text as string)) }));
        const binding: PaddleHandoffBinding = { attempt, original: item.pdf, pages: mappings, artifacts,
          snapshot_sha256: stage.sha256, review_findings_sha256: sha(read(manifest.review_findings)) };
        const payload = adaptPaddleDraftDocument(wire, binding); repo.startParsedDocument(pageId, attempt.id);
        const saved = repo.completeParsedDocument(pageId, attempt.id, payload);
        expect(repo.completeParsedDocument(pageId, attempt.id, payload)).toEqual(saved);
        item.stages.push({ wire, binding, payload, saved });
        console.log(`[real-handoff] snapshots ${stageIndex * 5 + i + 1}/15 ${stage.name} ${item.key}`);
      }
    }
    repo.close(); repo = new LearningRepository(databaseRoot, "offline-handoff-owner");
  }, 180000);
  afterAll(() => {
    if (repo?.database.open) { if (pageId) repo.deletePage(pageId); repo.close(); }
    vi.unstubAllGlobals();
  });

  it("imports exactly five actual originals and 18/241 per snapshot; reopens all saved versions", () => {
    expect(imported.filter((i) => i.importMode.startsWith("TEST_ONLY_INTERNAL_IMPORT")).map((i) => i.key)).toEqual(["ZH", "DC", "CA"]);
    for (const item of imported) {
      expect(sha(repo.pdfOriginal(pageId, item.materialId).bytes!)).toBe(sha(item.bytes));
      expect(repo.listParsedDocuments(pageId, item.materialId).map((d) => d.version)).toEqual([1, 2, 3]);
      for (const stage of item.stages) expect(repo.getParsedDocument(pageId, stage.saved.id)).toEqual(stage.saved);
    }
  }, 30000);
  it("round-trips every raw/normalized content, footnote, formula number, order, issue and region", () => {
    for (const item of imported) for (const stage of item.stages) {
      const saved = repo.getParsedDocument(pageId, stage.saved.id);
      for (const [pi, page] of stage.wire.pages.entries()) {
        const p = saved.pages![pi];
        expect(p.printed_label).toBe(page.printed_label);
        expect(p.reading_order.block_ids.map((id) => p.blocks.find((b) => b.id === id)!.provenance!.upstream_id)).toEqual(page.reading_order.block_ids);
        expect(p.issues.map((i) => JSON.parse(i.details_json!))).toEqual(page.issues);
        for (const [bi, block] of page.blocks.entries()) {
          const b = p.blocks[bi]; expect(b.content.raw).toBe(block.content.raw); expect(b.content.normalized).toBe(block.content.normalized);
          expect(b.provenance!.upstream_id).toBe(block.id); expect(JSON.parse(b.provenance!.details_json).role).toBe(block.role);
          const findings = [...b.quality.automatic_signals, ...b.quality.text_layer_signals, ...b.quality.prior_findings!].map((i) => JSON.parse(i.details_json!));
          expect(findings).toHaveLength(block.quality.issues.length); for (const issue of block.quality.issues) expect(findings).toContainEqual(issue);
          const source = repo.parsedBlockSource(pageId, saved.id, b.id); expect(source.state).toBe("available");
          if (source.state !== "available") throw Error("source unavailable");
          expect(source.source.source_regions).toHaveLength(block.source_regions.length);
          block.source_regions.forEach((r, ri) => {
            const region = source.source.source_regions[ri]; expect(region.normalized_bbox).toEqual(r.bbox);
            expect(region.bbox).toEqual(r.original_geometry.bbox); expect(region.physical_page).toBe(r.physical_page);
            expect(region.parser_ref.result_ref).toBe(`${r.artifact_ref}#${r.artifact_pointer}`);
            expect(region.page).toEqual(item.pdf.pages[r.physical_page - 1]);
          });
        }
      }
    }
    const blocks = imported.flatMap((i) => i.stages[0].saved.pages!.flatMap((p) => p.blocks));
    expect(blocks.filter((b) => b.role === "footnote")).toHaveLength(4);
    expect(blocks.filter((b) => b.role === "formula_number")).toHaveLength(3);
  }, 30000);
  it("retains partial coverage and page omissions independently of block status", () => {
    for (const item of imported) {
      const d = item.stages[2].saved; const inspection = repo.inspectParsedScope(pageId, d.id);
      expect(inspection.coverage.original_page_count).toBe(item.pdf.pageCount);
      expect(inspection.coverage.whole_document_processed).toBe(item.key === "SC");
      expect(inspection.conditions.content_completeness).toBe("not_established");
      const missing = item.pdf.pages.find((p) => !d.requestedPages!.includes(p.physicalPage));
      if (missing) expect(repo.inspectParsedScope(pageId, d.id, [missing.physicalPage])).toMatchObject({ missing_pages: [missing.physicalPage], conditions: { has_blocked: true, selected_pages_succeeded: false } });
    }
    const zh = imported[0].stages[2].saved;
    expect(repo.inspectParsedScope(pageId, zh.id, [70]).issues).toContainEqual(expect.objectContaining({ code: "missing_text", origin: "prior_visual_review", severity: "blocked", scope: { physical_pages: [70], block_ids: [] } }));
    expect(repo.inspectParsedScope(pageId, zh.id, [68]).conditions.has_blocked).toBe(false);
  });
  it("keeps automatic, text-layer and prior visual evidence distinct without producing verified", () => {
    const summary = manifest.stages.map((stage, si) => {
      const pages = imported.flatMap((i) => i.stages[si].saved.pages!); const blocks = pages.flatMap((p) => p.blocks);
      const statuses = { unverified: 0, warning: 0, blocked: 0, verified: 0 };
      for (const b of blocks) { statuses[b.quality.status]++; expect(b.quality.status).toBe(b.quality.reported_status); expect(b.quality.reviews).toEqual([]); }
      const issues = pages.flatMap((p) => [...p.issues, ...p.blocks.flatMap((b) => [...b.quality.automatic_signals, ...b.quality.text_layer_signals, ...b.quality.prior_findings!])]);
      return { stage: stage.name, documents: 5, pages: pages.length, blocks: blocks.length, statuses,
        issues_by_origin: Object.fromEntries(["automatic_rule", "text_layer_comparison", "prior_visual_review"].map((origin) => [origin, issues.filter((i) => i.origin === origin).length])) };
    });
    expect(summary[0].statuses).toEqual({ unverified: 172, warning: 69, blocked: 0, verified: 0 });
    expect(summary[2].statuses).toEqual({ unverified: 167, warning: 65, blocked: 9, verified: 0 });
    expect(summary[0].issues_by_origin.text_layer_comparison).toBe(0);
    expect(summary[1].issues_by_origin.text_layer_comparison).toBeGreaterThan(0);
    writeFileSync(join(output, "integration-summary.json"), JSON.stringify({ package_files: paths.length + 1, distinct_documents: 5, distinct_pages: 18, distinct_blocks: 241,
      databaseRoot, originals: imported.map((i) => ({ key: i.key, materialId: i.materialId, sha256: i.pdf.sha256, pageCount: i.pdf.pageCount, importMode: i.importMode })), snapshots: summary,
      actual_multi_region_blocks: 0, semantic_quality_reverified: false, network_calls: 0 }, null, 2));
    writeFileSync(join(output, "roundtrip-sources.json"), JSON.stringify(imported.flatMap((item) => item.stages[2].saved.pages!.map((p) => ({ key: item.key,
      case_ref: p.provenance!.case_ref, physical_page: p.physical_page, size: p.size, render: p.render,
      blocks: p.blocks.map((b) => { const source = repo.parsedBlockSource(pageId, item.stages[2].saved.id, b.id); if (source.state !== "available") throw Error("unavailable");
        return { id: b.id, upstream_id: b.provenance!.upstream_id, role: b.role, source_regions: source.source.source_regions }; }) }))), null, 2));
  });
  it("rejects missing/changed native evidence, wrong original identity and changed snapshot binding", () => {
    const { wire, binding } = imported[0].stages[2]; const missing = new Map(artifacts); missing.delete(binding.pages[0].native_json_sha256);
    expect(() => adaptPaddleDraftDocument(wire, { ...binding, artifacts: missing })).toThrow("paddle_evidence_missing_or_changed");
    const changed = new Map(artifacts); changed.set(binding.pages[0].native_json_sha256, Buffer.from("{}"));
    expect(() => adaptPaddleDraftDocument(wire, { ...binding, artifacts: changed })).toThrow("paddle_evidence_missing_or_changed");
    expect(() => adaptPaddleDraftDocument(wire, { ...binding, original: imported[1].pdf })).toThrow("paddle_local_identity_mismatch");
    const edited = structuredClone(wire); edited.pages[0].blocks[0].content.raw += "[故障注入测试]";
    expect(() => adaptPaddleDraftDocument(edited, binding)).toThrow("paddle_snapshot_binding_mismatch");
    const noReview = new Map(artifacts); noReview.delete(binding.review_findings_sha256);
    expect(() => adaptPaddleDraftDocument(wire, { ...binding, artifacts: noReview })).toThrow("paddle_evidence_missing_or_changed");
    const moved = structuredClone(binding.original); moved.pages[65].rotation = 180;
    expect(() => adaptPaddleDraftDocument(wire, { ...binding, original: moved })).toThrow("paddle_geometry_transform_not_established");
    const wrongMapping = structuredClone(binding.pages); wrongMapping[0].source_physical_page_1based = 65;
    expect(() => adaptPaddleDraftDocument(wire, { ...binding, pages: wrongMapping })).toThrow("paddle_page_mapping_required");
  });
  it("does not turn an evidence-free verified claim into a verified block (fault injection, not real review)", () => {
    const item = imported[1]; const source = item.stages[0]; const wire = structuredClone(source.wire);
    wire.pages[0].blocks[0].quality.status = "verified";
    const bytes = Buffer.from(JSON.stringify([wire])); const modified = new Map(artifacts); modified.set(sha(bytes), bytes);
    const attempt = repo.createParsedDocument(pageId, { id: randomUUID(), materialId: item.materialId, originalSha256: item.pdf.sha256, originalVersion: 1,
      requestedPages: source.saved.requestedPages!, parser: source.saved.parser });
    const payload = adaptPaddleDraftDocument(wire, { ...source.binding, attempt, artifacts: modified, snapshot_sha256: sha(bytes) });
    repo.startParsedDocument(pageId, attempt.id); const saved = repo.completeParsedDocument(pageId, attempt.id, payload);
    expect(saved.pages![0].blocks[0].quality).toMatchObject({ reported_status: "verified", status: "unverified", verified_scopes: [] });
  });
  it("rejects every foreign-account read/write and preserves original PDF after parse failure", () => {
    const stranger = new LearningRepository(databaseRoot, "offline-handoff-stranger"); const item = imported[0]; const stage = item.stages[0];
    try {
      for (const operation of [() => stranger.pdfOriginal(pageId, item.materialId), () => stranger.getParsedDocument(pageId, stage.saved.id),
        () => stranger.inspectParsedScope(pageId, stage.saved.id), () => stranger.parsedBlockSource(pageId, stage.saved.id, stage.saved.pages![0].blocks[0].id),
        () => stranger.completeParsedDocument(pageId, stage.saved.id, stage.payload), () => stranger.deleteMaterial(pageId, item.materialId)]) expect(operation).toThrow("page_not_found");
    } finally { stranger.close(); }
    const attempt = repo.createParsedDocument(pageId, { id: randomUUID(), materialId: item.materialId, originalSha256: item.pdf.sha256, originalVersion: 1,
      requestedPages: stage.saved.requestedPages!, parser: stage.saved.parser });
    repo.failParsedDocument(pageId, attempt.id, "parser_error");
    expect(sha(repo.pdfOriginal(pageId, item.materialId).bytes!)).toBe(sha(item.bytes));
  });
  it("purges imported copies, rejects late results across connections and leaves TXT working", () => {
    const textId = randomUUID(); repo.saveMaterials(pageId, [{ id: textId, kind: "txt", title: "[合成边界回归] TXT", filename: "synthetic.txt", bytes: Buffer.from("[合成测试] first\n\nsecond") }]);
    const second = new LearningRepository(databaseRoot, "offline-handoff-owner");
    try {
      for (const item of imported) {
        const stage = item.stages[0]; second.deleteMaterial(pageId, item.materialId);
        expect(repo.getParsedDocument(pageId, stage.saved.id)).toMatchObject({ sourceState: "source_deleted", pages: null });
        expect(() => repo.completeParsedDocument(pageId, stage.saved.id, stage.payload)).toThrow("material_deleted");
        expect(() => repo.pdfOriginal(pageId, item.materialId)).toThrow("material_deleted");
        expect(repo.database.prepare("SELECT count(*) AS n FROM learning_parsed_documents WHERE material_id=? AND (result_json IS NOT NULL OR result_hash IS NOT NULL OR original_sha256 IS NOT NULL)").get(item.materialId)).toEqual({ n: 0 });
      }
      expect(repo.source(pageId, textId).paragraphs).toHaveLength(2);
      second.deletePage(pageId); expect(() => repo.completeParsedDocument(pageId, imported[0].stages[0].saved.id, imported[0].stages[0].payload)).toThrow("page_deleted");
      expect(repo.database.prepare("SELECT count(*) AS n FROM learning_materials").get()).toEqual({ n: 0 });
      expect(repo.database.prepare("SELECT count(*) AS n FROM learning_parsed_documents").get()).toEqual({ n: 0 });
    } finally { second.close(); }
    expect(fetch).not.toHaveBeenCalled();
  });
});
