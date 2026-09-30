import { createHash } from "node:crypto";
import {
  PARSED_CONTRACT_VERSION, ParsedDocumentResult, type ParsedBlock, type ParsedCoverage, type ParsedDocument,
  type ParsedIssue, type ParsedPage, type ParsedPageInput, type ParsedQuality, type ParsedReview,
  type ParsedSource, type QualityAssessment, type StoredParsedBlock
} from "@/lib/domain/learning-parsed-document";
import type { LearningPdfMetadata, LearningPdfPage } from "@/lib/domain/learning";

export type ParsedContext = { id: string; materialId: string; version: number; originalSha256: string };
type SavedResult = Omit<ParsedDocumentResult, "pages"> & {
  pages: Array<ParsedPageInput & { size: LearningPdfPage }>; coverage: ParsedCoverage;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const samePages = (a: number[], b: number[]) => a.length === b.length && new Set(a).size === a.length
  && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);

/** Hashes bind a review to content/role/format, every source member, geometry and order. */
export function parsedBlockHashes(block: ParsedBlock, pages: Array<ParsedPageInput & { size: LearningPdfPage }>) {
  return {
    content_sha256: digest([block.type, block.role, block.content]),
    source_sha256: digest([block.source_member_ids, block.source_regions, block.source_regions.map((r) => {
      const page = pages.find((p) => p.physical_page === r.physical_page);
      return page ? [page.size, page.render, page.parser_page_index, page.reading_order.block_ids, ...(page.provenance ? [page.provenance] : [])] : null;
    })])
  };
}
export function parsedPageHashes(page: ParsedPageInput & { size: LearningPdfPage }) {
  return { content_sha256: digest(page.blocks.map((b) => [b.id, b.type, b.role, b.content])),
    source_sha256: digest([page.size, page.render, page.reading_order.block_ids, page.blocks.map((b) => b.source_regions), ...(page.provenance ? [page.provenance] : [])]) };
}
function assess(reviews: ParsedReview[], context: ParsedContext, target: ParsedReview["target"],
  hashes: { content_sha256: string; source_sha256: string }, reported: ParsedQuality["status"], issues: ParsedIssue[], scope: "content" | "reading_order"): QualityAssessment {
  const current = reviews.filter((r) => r.document_id === context.id && r.material_id === context.materialId
    && r.parse_version === context.version && r.original_sha256 === context.originalSha256
    && r.target.physical_page === target.physical_page && r.target.block_id === target.block_id
    && r.content_sha256 === hashes.content_sha256 && r.source_sha256 === hashes.source_sha256);
  const validIds = new Set(current.map((r) => r.id));
  const verified = [...new Set(current.filter((r) => r.outcome === "verified").flatMap((r) => r.scope))];
  const blocked = reported === "blocked" || issues.some((i) => i.severity === "blocked") || current.some((r) => r.outcome === "blocked");
  const warning = reported === "warning" || issues.some((i) => i.severity === "warning") || current.some((r) => r.outcome === "warning");
  return { status: blocked ? "blocked" : warning ? "warning" : verified.includes(scope) ? "verified" : "unverified",
    verified_scopes: verified, invalid_review_ids: reviews.filter((r) => !validIds.has(r.id)).map((r) => r.id) };
}
export function prepareParsedResult(input: unknown, context: ParsedContext, original: LearningPdfMetadata, requested: number[]): SavedResult {
  const value = ParsedDocumentResult.parse(input);
  if (value.document_id !== context.id || value.material_id !== context.materialId || value.original_sha256 !== context.originalSha256
    || value.parse_version !== context.version) throw new Error("parsed_identity_mismatch");
  if (!samePages(value.coverage.requested_pages, requested) || !samePages(value.pages.map((p) => p.physical_page), requested)
    || !samePages(value.coverage.succeeded_pages, value.pages.filter((p) => p.parse_status === "succeeded").map((p) => p.physical_page))
    || !samePages(value.coverage.failed_pages, value.pages.filter((p) => p.parse_status === "failed").map((p) => p.physical_page))) {
    throw new Error("parsed_page_coverage_mismatch");
  }
  const allIds = new Set(value.pages.flatMap((p) => p.blocks.map((b) => b.id)));
  const checkIssue = (issue: ParsedIssue) => {
    if (issue.scope.physical_pages.some((p) => p > original.pageCount) || issue.scope.block_ids.some((id) => !allIds.has(id))) throw new Error("invalid_issue_scope");
  };
  const pages = value.pages.map((page) => {
    const size = original.pages.find((p) => p.physicalPage === page.physical_page);
    if (!size) throw new Error("parsed_page_coverage_mismatch");
    if (page.parse_status === "failed" ? (!page.failure_code || page.blocks.length > 0) : page.failure_code !== null) throw new Error("invalid_page_execution");
    if (!samePages(page.reading_order.block_ids.map((id) => page.blocks.findIndex((b) => b.id === id)), page.blocks.map((_, i) => i))) throw new Error("invalid_reading_order");
    if (page.render && (page.render.rotation !== size.rotation || JSON.stringify(page.render.crop_pdf) !== JSON.stringify(size.view)
      || Math.abs(page.render.width_px / page.render.height_px - size.width / size.height) > 2 / page.render.height_px)) throw new Error("render_geometry_mismatch");
    page.issues.forEach((issue) => {
      checkIssue(issue);
      if (!issue.scope.physical_pages.includes(page.physical_page)) throw new Error("invalid_issue_scope");
    });
    for (const b of page.blocks) {
      [...b.quality.automatic_signals, ...b.quality.text_layer_signals, ...b.quality.prior_findings ?? []].forEach((issue) => {
        checkIssue(issue);
        if (!issue.scope.physical_pages.some((p) => p === page.physical_page || b.source_regions.some((r) => r.physical_page === p))
          || (issue.scope.block_ids.length > 0 && !issue.scope.block_ids.includes(b.id))) throw new Error("invalid_issue_scope");
      });
      for (const r of b.source_regions) {
        const source = value.pages.find((p) => p.physical_page === r.physical_page);
        if (!source || source.parse_status !== "succeeded" || r.parser_ref.page_index !== source.parser_page_index
          || r.parser_ref.run_id !== value.parser_run.run_id) throw new Error("invalid_source_mapping");
        if (r.unit === "render_pixel" && (!source.render || r.bbox[2] > source.render.width_px || r.bbox[3] > source.render.height_px)) throw new Error("region_outside_render");
      }
    }
    return { ...page, size };
  });
  return { ...value, pages, coverage: { ...value.coverage, original_page_count: original.pageCount,
    whole_document_processed: value.coverage.succeeded_pages.length === original.pageCount && value.coverage.failed_pages.length === 0 } };
}

// Legacy core v1 results remain immutable on disk. They never inherit a verified verdict.
type LegacyPage = LearningPdfPage & { quality: { status: "verified" | "warning" | "blocked"; reason: string };
  blocks: Array<{ id: string; type: ParsedBlock["type"]; content: string | null; quality: LegacyPage["quality"];
    region: { x: number; y: number; width: number; height: number } }> };
function legacyResult(pages: LegacyPage[], context: ParsedContext): SavedResult {
  const requested = pages.map((p) => p.physicalPage);
  return { contract_version: PARSED_CONTRACT_VERSION, document_id: context.id, material_id: context.materialId,
    original_sha256: context.originalSha256, parse_version: context.version,
    parser_run: { run_id: "legacy-core-v1", upstream_document_id: null, model: null, config_summary: "Legacy receipt; no review evidence" },
    coverage: { requested_pages: requested, succeeded_pages: requested, failed_pages: [], original_page_count: pages.length, whole_document_processed: true },
    pages: pages.map(({ blocks, quality, ...size }) => ({
      physical_page: size.physicalPage, printed_label: null, parser_page_index: null, size, render: null,
      parse_status: "succeeded", failure_code: null,
      issues: quality.status === "verified" ? [] : [{ code: "legacy_page_quality", origin: "legacy_import", severity: quality.status,
        message: quality.reason, scope: { physical_pages: [size.physicalPage], block_ids: [] }, evidence_refs: [] }],
      reading_order: { block_ids: blocks.map((b) => b.id), origin: "legacy_array_order_unverified", reviews: [] },
      blocks: blocks.map((b) => ({ id: b.id, type: b.type, parser_type: "legacy-unavailable", role: "other", content: { raw: b.content, normalized: b.content, cleaning: "none", format: "plain" },
        source_member_ids: [b.id], source_regions: [{ member_id: b.id, physical_page: size.physicalPage,
          bbox: [b.region.x, b.region.y, b.region.x + b.region.width, b.region.y + b.region.height], unit: "normalized", origin: "top_left", frame: "displayed_pdf_crop",
          parser_ref: { run_id: "legacy-core-v1", page_index: null, block_id: b.id, result_ref: "legacy local block; parser index unavailable" } }],
        quality: { status: b.quality.status, reason: b.quality.reason, automatic_signals: [], text_layer_signals: [], reviews: [] } }))
    })) };
}
export function readParsedResult(json: string, context: ParsedContext): Pick<ParsedDocument, "pages" | "coverage" | "parserRun" | "contractVersion"> {
  const raw = JSON.parse(json) as SavedResult | LegacyPage[];
  const legacy = Array.isArray(raw); const result = legacy ? legacyResult(raw, context) : raw;
  const pages: ParsedPage[] = result.pages.map((p) => ({ ...p,
    reading_order: { ...p.reading_order, assessment: assess(p.reading_order.reviews, context,
      { physical_page: p.physical_page, block_id: null }, parsedPageHashes(p), "unverified", [], "reading_order") },
    blocks: p.blocks.map((b): StoredParsedBlock => {
      const hashes = parsedBlockHashes(b, result.pages);
      const assessment = assess(b.quality.reviews, context, { physical_page: p.physical_page, block_id: b.id }, hashes, b.quality.status,
        [...b.quality.automatic_signals, ...b.quality.text_layer_signals, ...b.quality.prior_findings ?? []], "content");
      // Empty data cannot become verified even if a review claims it.
      if (!b.content.normalized?.trim() && assessment.status === "verified") { assessment.status = "unverified"; assessment.verified_scopes = []; }
      return { ...b, ...hashes, quality: { ...b.quality, reported_status: b.quality.status, ...assessment } };
    }) }));
  return { pages, coverage: result.coverage, parserRun: result.parser_run, contractVersion: legacy ? "legacy/1" : result.contract_version };
}
export function parsedSource(document: ParsedDocument, block: StoredParsedBlock): ParsedSource {
  return { learningPageId: document.learningPageId, materialId: document.materialId, documentId: document.id, documentVersion: document.version,
    originalSha256: document.originalSha256!, originalVersion: 1, blockId: block.id,
    source_regions: block.source_regions.map((r) => {
      const p = document.pages!.find((p) => p.physical_page === r.physical_page)!;
      const b = r.bbox;
      const normalized_bbox: [number, number, number, number] = r.unit === "normalized" ? [...b]
        : [b[0] / p.render!.width_px, b[1] / p.render!.height_px, b[2] / p.render!.width_px, b[3] / p.render!.height_px];
      return { ...r, page: p.size, normalized_bbox };
    }) };
}
