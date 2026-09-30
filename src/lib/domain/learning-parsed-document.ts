import { z } from "zod";
import { LearningId, LEARNING_PDF_MAX_PAGES, type LearningPdfPage } from "./learning";

export const PARSED_CONTRACT_VERSION = "learning-parsed-document/2" as const;
export const PARSED_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;
export const PARSED_DOCUMENT_MAX_BLOCKS = 20000;
export const ParsedDocumentStatus = z.enum(["pending", "processing", "completed", "failed"]);
export const ParsedFailureCode = z.enum(["parser_error", "timeout", "unsupported", "invalid_output", "cancelled"]);
const label = z.string().trim().min(1).max(500);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const physicalPage = z.number().int().min(1).max(LEARNING_PDF_MAX_PAGES);
const uniquePages = z.array(physicalPage).min(1).max(LEARNING_PDF_MAX_PAGES).refine((p) => new Set(p).size === p.length);
export const ParsedQualityStatus = z.enum(["unverified", "verified", "warning", "blocked"]);
export const ParsedIssue = z.object({
  code: label, origin: z.enum(["automatic_rule", "text_layer_comparison", "manual_review", "visual_review", "prior_visual_review", "legacy_import"]),
  severity: z.enum(["warning", "blocked"]), message: label,
  scope: z.object({ physical_pages: uniquePages, block_ids: z.array(LearningId).max(1000) }).strict(),
  evidence_refs: z.array(label).max(20),
  // Imported rule/version/evidence details are inert provenance, not a new verdict.
  details_json: z.string().max(16384).optional()
}).strict();
export const ParsedReview = z.object({
  id: LearningId, method: z.enum(["manual_review", "visual_review", "prior_visual_review"]),
  evidence_ref: label, reviewer: label, reviewed_at: z.string().datetime(),
  document_id: LearningId, material_id: LearningId, parse_version: z.number().int().positive(), original_sha256: hash,
  target: z.object({ physical_page: physicalPage, block_id: LearningId.nullable() }).strict(),
  content_sha256: hash, source_sha256: hash,
  scope: z.array(z.enum(["content", "source_mapping", "reading_order"])).min(1).max(3),
  outcome: z.enum(["verified", "warning", "blocked"]), note: label
}).strict();
export const ParsedQuality = z.object({
  status: ParsedQualityStatus, reason: label,
  automatic_signals: z.array(ParsedIssue).max(100), text_layer_signals: z.array(ParsedIssue).max(100),
  reviews: z.array(ParsedReview).max(100),
  // Prior negative findings can lack reviewer/time/scope proof. Never fabricate a verified review.
  prior_findings: z.array(ParsedIssue).max(100).optional()
}).strict().superRefine((q, ctx) => {
  if (q.automatic_signals.some((i) => i.origin !== "automatic_rule") || q.text_layer_signals.some((i) => i.origin !== "text_layer_comparison")
    || q.prior_findings?.some((i) => !["manual_review", "visual_review", "prior_visual_review"].includes(i.origin))) {
    ctx.addIssue({ code: "custom", message: "signal_origin_mismatch" });
  }
});
const bbox = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
  .refine(([x0, y0, x1, y1]) => x0 >= 0 && y0 >= 0 && x1 > x0 && y1 > y0, "invalid_region");
export const ParsedRegion = z.object({
  member_id: label, physical_page: physicalPage,
  bbox, unit: z.enum(["normalized", "render_pixel"]), origin: z.literal("top_left"), frame: z.literal("displayed_pdf_crop"),
  parser_ref: z.object({ run_id: label, page_index: z.number().int().nonnegative().nullable(), block_id: label, result_ref: label }).strict()
}).strict().refine((r) => r.unit !== "normalized" || (r.bbox[2] <= 1 && r.bbox[3] <= 1), "region_outside_page");
export const ParsedBlock = z.object({
  id: LearningId, type: z.enum(["text", "table", "formula", "image", "code", "unknown"]), parser_type: label,
  role: z.enum(["body", "heading", "caption", "footnote", "formula_number", "page_number", "chart", "header", "footer", "other"]),
  provenance: z.object({ upstream_id: label, upstream_content_sha256: hash, details_json: z.string().max(16384) }).strict().optional(),
  content: z.object({ raw: z.string().max(65536).nullable(), normalized: z.string().max(65536).nullable(),
    format: z.enum(["plain", "markdown", "latex", "html", "code"]), cleaning: z.enum(["none", "line_endings"]) }).strict(),
  source_member_ids: z.array(label).min(1).max(64), source_regions: z.array(ParsedRegion).min(1).max(64),
  quality: ParsedQuality
}).strict().superRefine((b, ctx) => {
  const expected = b.content.cleaning === "line_endings" ? b.content.raw?.replace(/\r\n?/g, "\n") ?? null : b.content.raw;
  if (b.content.normalized !== expected) ctx.addIssue({ code: "custom", message: "unsupported_content_cleaning" });
  const members = new Set(b.source_member_ids);
  if (members.size !== b.source_member_ids.length || b.source_regions.some((r) => !members.has(r.member_id))
    || b.source_member_ids.some((id) => !b.source_regions.some((r) => r.member_id === id))) {
    ctx.addIssue({ code: "custom", message: "incomplete_merge_sources" });
  }
});
export const ParsedPageInput = z.object({
  physical_page: physicalPage, printed_label: z.string().max(100).nullable(), parser_page_index: z.number().int().nonnegative().nullable(),
  parse_status: z.enum(["succeeded", "failed"]), failure_code: ParsedFailureCode.nullable(),
  provenance: z.object({ case_ref: label, input_sha256: hash, excerpt_sha256: hash,
    excerpt_physical_page: z.number().int().positive(), result_ref: label, reported_quality: ParsedQualityStatus }).strict().optional(),
  render: z.object({ width_px: z.number().int().positive().max(100000), height_px: z.number().int().positive().max(100000),
    rotation: z.number().int(), crop_pdf: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
    frame: z.literal("displayed_pdf_crop") }).strict().nullable(),
  issues: z.array(ParsedIssue).max(100),
  reading_order: z.object({ block_ids: z.array(LearningId).max(1000), origin: label, reviews: z.array(ParsedReview).max(100) }).strict(),
  blocks: z.array(ParsedBlock).max(1000)
}).strict();
export const ParsedDocumentResult = z.object({
  contract_version: z.literal(PARSED_CONTRACT_VERSION), document_id: LearningId, material_id: LearningId,
  original_sha256: hash, parse_version: z.number().int().positive(),
  parser_run: z.object({ run_id: label, upstream_document_id: label.nullable(), model: label.nullable(), config_summary: z.string().max(2000) }).strict(),
  coverage: z.object({ requested_pages: uniquePages, succeeded_pages: z.array(physicalPage).max(LEARNING_PDF_MAX_PAGES),
    failed_pages: z.array(physicalPage).max(LEARNING_PDF_MAX_PAGES) }).strict(),
  pages: z.array(ParsedPageInput).min(1).max(LEARNING_PDF_MAX_PAGES)
}).strict().superRefine((result, ctx) => {
  const blocks = result.pages.flatMap((p) => p.blocks);
  const reviewIds = [...result.pages.flatMap((p) => p.reading_order.reviews), ...blocks.flatMap((b) => b.quality.reviews)].map((r) => r.id);
  if (new Set(reviewIds).size !== reviewIds.length) ctx.addIssue({ code: "custom", message: "duplicate_review_id" });
  if (blocks.length > PARSED_DOCUMENT_MAX_BLOCKS || new Set(blocks.map((b) => b.id)).size !== blocks.length
    || new Set(result.pages.map((p) => p.physical_page)).size !== result.pages.length) ctx.addIssue({ code: "custom", message: "duplicate_or_excess_content" });
});
const parserLabel = z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/u);
export const CreateParsedDocument = z.object({
  id: LearningId, materialId: LearningId, originalSha256: hash, originalVersion: z.literal(1),
  requestedPages: uniquePages.optional(), parser: z.object({ name: parserLabel, version: parserLabel }).strict()
}).strict();

export type ParsedIssue = z.infer<typeof ParsedIssue>;
export type ParsedReview = z.infer<typeof ParsedReview>;
export type ParsedQuality = z.infer<typeof ParsedQuality>;
export type ParsedBlock = z.infer<typeof ParsedBlock>;
export type ParsedRegion = z.infer<typeof ParsedRegion>;
export type ParsedPageInput = z.infer<typeof ParsedPageInput>;
export type ParsedDocumentResult = z.infer<typeof ParsedDocumentResult>;
export type CreateParsedDocument = z.infer<typeof CreateParsedDocument>;
export type QualityAssessment = { status: ParsedQuality["status"]; verified_scopes: ParsedReview["scope"]; invalid_review_ids: string[] };
export type StoredParsedBlock = Omit<ParsedBlock, "quality"> & {
  content_sha256: string; source_sha256: string;
  quality: ParsedQuality & QualityAssessment & { reported_status: ParsedQuality["status"] };
};
export type ParsedPage = Omit<ParsedPageInput, "blocks" | "reading_order"> & {
  size: LearningPdfPage; blocks: StoredParsedBlock[];
  reading_order: ParsedPageInput["reading_order"] & { assessment: QualityAssessment };
};
export type ParsedCoverage = ParsedDocumentResult["coverage"] & { original_page_count: number; whole_document_processed: boolean };
export type ParsedDocument = {
  id: string; learningPageId: string; materialId: string; version: number;
  parser: CreateParsedDocument["parser"]; createdAt: string; updatedAt: string;
  status: z.infer<typeof ParsedDocumentStatus>; sourceState: "available" | "source_deleted";
  originalSha256: string | null; originalVersion: 1; failureCode: z.infer<typeof ParsedFailureCode> | null;
  requestedPages: number[] | null; contractVersion: string | null;
  coverage: ParsedCoverage | null; parserRun: ParsedDocumentResult["parser_run"] | null; pages: ParsedPage[] | null;
};
export type ParsedSource = {
  learningPageId: string; materialId: string; documentId: string; documentVersion: number;
  originalSha256: string; originalVersion: 1; blockId: string;
  source_regions: Array<ParsedRegion & { page: LearningPdfPage; normalized_bbox: [number, number, number, number] }>;
};
export type ParsedBlockSource =
  | { state: "available"; source: ParsedSource; block: StoredParsedBlock; pageIssues: ParsedIssue[] }
  | { state: "source_deleted"; documentId: string; materialId: string };
export type ParsedScopeInspection = {
  documentId: string; version: number; selected_pages: number[]; coverage: ParsedCoverage;
  missing_pages: number[]; failed_pages: number[]; issues: ParsedIssue[];
  blocks: Array<{ block: StoredParsedBlock; source: ParsedSource }>;
  conditions: { selected_pages_succeeded: boolean; has_warning: boolean; has_blocked: boolean; content_completeness: "not_established" };
};
