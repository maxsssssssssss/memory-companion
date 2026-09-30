import { createHash } from "node:crypto";
import { z } from "zod";
import { v5 as uuidv5 } from "uuid";
import { PARSED_CONTRACT_VERSION, ParsedDocumentResult, type ParsedBlock, type ParsedDocument, type ParsedIssue } from "@/lib/domain/learning-parsed-document";
import type { LearningPdfMetadata } from "@/lib/domain/learning";

// Only mappings established in the supplied draft. This is not an OCR client or registry.
export function paddleBlockKind(parserType: string): Pick<ParsedBlock, "type" | "role" | "parser_type"> {
  const known: Record<string, [ParsedBlock["type"], ParsedBlock["role"]]> = {
    text: ["text", "body"], title: ["text", "heading"], doc_title: ["text", "heading"], paragraph_title: ["text", "heading"],
    figure_title: ["text", "caption"], table_title: ["text", "caption"], caption: ["text", "caption"],
    footnote: ["text", "footnote"], formula_number: ["text", "formula_number"],
    header: ["text", "header"], footer: ["text", "footer"], display_formula: ["formula", "other"],
    table: ["table", "other"], algorithm: ["code", "other"], image: ["image", "other"], chart: ["image", "other"]
  };
  const [type, role] = Object.hasOwn(known, parserType) ? known[parserType] : ["unknown" as const, "other" as const];
  return { type, role, parser_type: parserType };
}

/** The caller supplies the locally established mapping; never assume index + 1. */
export function paddlePhysicalPage(pageIndex: number, mapping: Array<{ page_index: number; physical_page: number }>): number {
  const matches = mapping.filter((p) => p.page_index === pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || matches.length !== 1
    || !Number.isInteger(matches[0].physical_page) || matches[0].physical_page < 1) throw new Error("paddle_page_mapping_required");
  return matches[0].physical_page;
}

const box = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const pair = z.tuple([z.number().positive(), z.number().positive()]);
const issueSchema = z.object({ code: z.string(), severity: z.enum(["warning", "blocked"]),
  origin: z.enum(["automatic_rule", "prior_visual_review"]), rule_version: z.string().nullable(), evidence: z.record(z.unknown()) }).strict();
const draftSchema = z.object({
  contract_version: z.literal("parsed-document-draft/0.1"), document_id: z.string(),
  source: z.object({ asset_ref: z.string(), title: z.string(), source_page_count: z.number().int().positive(), license: z.string(), source_url: z.string() }).strict(),
  coverage: z.object({ requested_physical_pages: z.array(z.number().int().positive()), parsed_physical_pages: z.array(z.number().int().positive()),
    failed_physical_pages: z.array(z.number().int().positive()), complete_source: z.boolean() }).strict(),
  parser: z.object({ run_id: z.string(), name: z.string(), version: z.string(), engine_versions: z.record(z.string()),
    models: z.array(z.string()), config_sha256: z.string(), inference_replayed: z.boolean() }).strict(),
  quality: z.object({ status: z.string(), meaning: z.string(), ruleset: z.string() }).strict(),
  pages: z.array(z.object({ case_ref: z.string(), physical_page: z.number().int().positive(), printed_label: z.string().nullable(),
    size: z.object({ pdf_points: pair, render_pixels: pair }).strict(), parse_status: z.literal("succeeded"),
    reading_order: z.object({ block_ids: z.array(z.string()), basis: z.string(), verification: z.literal("unverified") }).strict(),
    issues: z.array(issueSchema), quality_status: z.string(),
    blocks: z.array(z.object({ id: z.string(), page_number: z.number().int().positive(),
      type: z.enum(["text", "table", "formula", "image", "code", "unknown"]), role: z.string(),
      content: z.object({ raw: z.string(), normalized: z.string(), format: z.enum(["plain_text", "html", "latex"]), normalization: z.array(z.string()) }).strict(),
      content_sha256: z.string(), parser_ref: z.string(),
      parser_native: z.object({ label: z.string(), block_id: z.number().int(), block_order: z.number().int().nullable(), group_id: z.number().int() }).strict(),
      source_regions: z.array(z.object({ physical_page: z.number().int().positive(), parser_block_id: z.string(), bbox: box,
        coordinate_space: z.literal("normalized_top_left"), original_geometry: z.object({ bbox: box, unit: z.literal("render_pixel"), render_size: pair }).strict(),
        artifact_ref: z.string(), artifact_pointer: z.string() }).strict()).min(1), checks: z.record(z.unknown()),
      quality: z.object({ status: z.enum(["unverified", "verified", "warning", "blocked"]), learning_use: z.string(),
        issues: z.array(issueSchema), verification: z.unknown().nullable() }).strict()
    }).strict())
  }).strict())
}).strict();
export type PaddleDraftDocument = z.infer<typeof draftSchema>;

// This is the delivered 0.1 handoff mapping, not a parser registry or a URL resolver.
export const PaddleHandoffPage = z.object({
  case_id: z.string(), original_sha256: z.string(), source_physical_page_1based: z.number().int().positive(),
  source_printed_label: z.string().nullable(), test_single_page_sha256: z.string(), test_single_page_index_0based: z.number().int().nonnegative(),
  selected_pdf_page_1based: z.number().int().positive(), source_size_pdf_points: pair, render_size_pixels: pair,
  native_json_sha256: z.string()
});
export type PaddleHandoffBinding = {
  attempt: ParsedDocument; original: LearningPdfMetadata;
  pages: Array<z.infer<typeof PaddleHandoffPage> & { excerpt_sha256: string; text_layer_sha256: string }>;
  snapshot_sha256: string; review_findings_sha256: string;
  // Only locally supplied, hash-checked bytes. No filesystem/network access in the adapter.
  artifacts: ReadonlyMap<string, Uint8Array>;
};
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// MuPDF exposes float32 PDF boxes; PDF.js may retain the original decimal token.
// Accept one float32 relative precision unit, never a pixel/point-scale shift.
const samePdfBox = (a:number[],b:number[]) => a.length===b.length&&a.every((v,i)=>Math.abs(v-b[i])<=Math.max(1,Math.abs(v),Math.abs(b[i]))*2**-23);
const requireMatch = (condition: boolean, code: string) => { if (!condition) throw new Error(code); };

const serviceSource = z.object({ document_sha256:z.string(), physical_page:z.number().int().positive(), bbox:box }).strict();
const serviceResponse = z.object({
  service_version:z.literal("ocr-pdf-trial-0.1"),request_id:z.string(),status:z.literal("completed"),publishable:z.literal(true),
  document:z.object({document_id:z.string(),sha256:z.string(),physical_page_count:z.number().int().positive(),selected_physical_pages:z.array(z.number().int().positive()),selected_pdf_sha256:z.string()}),
  pages:z.array(z.object({physical_page:z.number().int().positive(),page_index:z.number().int().nonnegative(),selection_index:z.number().int().nonnegative(),
    render_size:z.object({width:z.number().int().positive(),height:z.number().int().positive()}),
    pdf_geometry:z.object({physical_page:z.number().int().positive(),mediabox_pt:box,cropbox_pt:box,rotation_degrees:z.number(),display_size_pt:pair}),
    blocks:z.array(z.object({block_id:z.number().int(),type:z.string(),raw_content:z.string().nullable(),content:z.string().nullable(),bbox:box,order:z.number().nullable(),polygon_points:z.array(z.array(z.number())).nullable(),
      sources:z.array(serviceSource).min(1),quality:z.object({status:z.literal("unverified"),warnings:z.array(z.string())})})),
    coverage:z.object({detected_regions:z.number(),output_blocks:z.number(),vl_requests:z.number(),semantic_completeness:z.literal("unverified"),issues:z.array(z.unknown())}),
    raw_paddle:z.record(z.unknown()),status:z.literal("completed"),quality_status:z.literal("unverified") })),
  coverage:z.object({requested_pages:z.number(),completed_pages:z.number(),partial:z.literal(false),failures:z.array(z.unknown()).length(0),semantic_completeness:z.literal("unverified")}),
  parser:z.object({paddleocr:z.string(),paddlex:z.string(),model:z.string(),backend:z.string(),profile:z.record(z.unknown())}),authorization:z.string()
});
export type PaddleServiceFinding = { originalSha256:string; physicalPage:number; serviceVersion:string; model:string; code:string; message:string; evidenceRef:string; severity:"warning"|"blocked" };

/** Actual delivered HTTP shape. Account/material identity is supplied by the authenticated repository. */
export function adaptPaddleServiceResponse(input:unknown,binding:{attempt:ParsedDocument;original:LearningPdfMetadata;requestId:string;upstreamDocumentId?:string;physicalPages:number[];findings?:PaddleServiceFinding[]}):ParsedDocumentResult {
  const v=serviceResponse.parse(input),{attempt,original}=binding, responseHash=sha256(JSON.stringify(input));
  requireMatch(v.request_id===binding.requestId&&v.document.document_id===(binding.upstreamDocumentId??attempt.materialId)&&v.document.sha256===original.sha256&&attempt.originalSha256===original.sha256
    &&v.document.physical_page_count===original.pageCount&&equal(v.document.selected_physical_pages,binding.physicalPages),"paddle_local_identity_mismatch");
  requireMatch(v.coverage.requested_pages===binding.physicalPages.length&&v.coverage.completed_pages===v.pages.length&&equal(v.pages.map(p=>p.physical_page),binding.physicalPages),"paddle_page_mapping_required");
  const uid=(page:number,id:number)=>uuidv5(`${binding.requestId}:${page}:${id}`,attempt.id);
  const pages=v.pages.map((p,index)=>{
    const originalPage=original.pages.find(x=>x.physicalPage===p.physical_page);
    requireMatch(!!originalPage&&p.page_index===p.physical_page-1&&p.selection_index===index&&p.pdf_geometry.physical_page===p.physical_page,"paddle_page_mapping_required");
    const g=originalPage!;
    requireMatch(g.rotation===0&&g.userUnit===1&&g.view[0]===0&&g.view[1]===0&&p.pdf_geometry.rotation_degrees===g.rotation,"paddle_geometry_transform_not_established");
    requireMatch(samePdfBox(p.pdf_geometry.cropbox_pt,g.view)&&samePdfBox(p.pdf_geometry.display_size_pt,[g.width,g.height]),"paddle_page_geometry_mismatch");
    const issue=(code:string,message:string,severity:"warning"|"blocked",blockId?:string):ParsedIssue=>({code,origin:"automatic_rule",severity,message,scope:{physical_pages:[p.physical_page],block_ids:blockId?[blockId]:[]},evidence_refs:[`sha256:${responseHash}`]});
    const native=p.raw_paddle.prunedResult as {parsing_res_list?:Array<{block_id:number;block_content:string|null;block_label:string;block_bbox:number[]}>}|undefined;
    requireMatch(Array.isArray(native?.parsing_res_list)&&p.coverage.output_blocks===p.blocks.length,"paddle_native_content_mismatch");
    const blocks:ParsedBlock[]=p.blocks.map((b,bi)=>{
      const id=uid(p.physical_page,b.block_id),raw=native!.parsing_res_list!.find(n=>n.block_id===b.block_id);
      requireMatch(!!raw&&raw.block_content===b.raw_content&&raw.block_label===b.type&&equal(raw.block_bbox,b.bbox)&&b.raw_content===b.content,"paddle_native_content_mismatch");
      const regions=b.sources.map((s,i)=>{
        requireMatch(s.document_sha256===original.sha256&&binding.physicalPages.includes(s.physical_page),"paddle_region_binding_mismatch");
        return {member_id:`${binding.requestId}:${p.physical_page}:${b.block_id}:${i}`,physical_page:s.physical_page,bbox:s.bbox,unit:"render_pixel" as const,origin:"top_left" as const,frame:"displayed_pdf_crop" as const,
          parser_ref:{run_id:attempt.id,page_index:s.physical_page-1,block_id:String(b.block_id),result_ref:`sha256:${responseHash}#/pages/${index}/blocks/${bi}`}};
      });
      const signals=b.quality.warnings.map(w=>issue(w,w,w==="formula_unverified"?"blocked":"warning",id));
      return {id,...paddleBlockKind(b.type),provenance:{upstream_id:String(b.block_id),upstream_content_sha256:sha256(b.raw_content??""),details_json:JSON.stringify({order:b.order,polygon_points:b.polygon_points,request_id:binding.requestId})},
        content:{raw:b.raw_content,normalized:b.content,format:b.type==="table"?"html":b.type.includes("formula")?"latex":"plain",cleaning:"none"},
        source_member_ids:regions.map(r=>r.member_id),source_regions:regions,quality:{status:signals.some(s=>s.severity==="blocked")?"blocked":signals.length?"warning":"unverified",reason:"HTTP completion is not semantic verification",automatic_signals:signals,text_layer_signals:[],reviews:[]}};
    });
    const issues:ParsedIssue[]=p.coverage.issues.map((x,i)=>issue(`parser_coverage_${i}`,JSON.stringify(x).slice(0,500),"blocked"));
    for(const f of binding.findings??[])if(f.originalSha256===original.sha256&&f.physicalPage===p.physical_page&&f.serviceVersion===v.service_version&&f.model===v.parser.model)
      issues.push({code:f.code,origin:"prior_visual_review",severity:f.severity,message:f.message,scope:{physical_pages:[p.physical_page],block_ids:[]},evidence_refs:[f.evidenceRef]});
    return {physical_page:p.physical_page,printed_label:null,parser_page_index:p.page_index,parse_status:"succeeded" as const,failure_code:null,
      render:{width_px:p.render_size.width,height_px:p.render_size.height,rotation:g.rotation,crop_pdf:g.view as [number,number,number,number],frame:"displayed_pdf_crop" as const},
      issues,reading_order:{block_ids:blocks.map(b=>b.id),origin:"delivered Paddle array order; not semantically verified",reviews:[]},blocks};
  });
  return ParsedDocumentResult.parse({contract_version:PARSED_CONTRACT_VERSION,document_id:attempt.id,material_id:attempt.materialId,original_sha256:original.sha256,parse_version:attempt.version,
    parser_run:{run_id:attempt.id,upstream_document_id:v.document.document_id,model:v.parser.model,config_summary:JSON.stringify({service:v.service_version,parser:v.parser,request_id:v.request_id,selected_pdf_sha256:v.document.selected_pdf_sha256,response_sha256:responseHash})},
    coverage:{requested_pages:binding.physicalPages,succeeded_pages:binding.physicalPages,failed_pages:[]},pages});
}

/** Adapts a delivered snapshot without rerunning OCR, cleaning rules or quality evaluation. */
export function adaptPaddleDraftDocument(input: unknown, binding: PaddleHandoffBinding): ParsedDocumentResult {
  const draft = draftSchema.parse(input);
  const { attempt, original } = binding;
  const artifact = (hash: string) => {
    const bytes = binding.artifacts.get(hash);
    requireMatch(!!bytes && sha256(bytes) === hash, "paddle_evidence_missing_or_changed");
    return Buffer.from(bytes!);
  };
  const snapshot: unknown[] = JSON.parse(artifact(binding.snapshot_sha256).toString("utf8"));
  const position = snapshot.findIndex((d) => equal(d, input));
  requireMatch(position >= 0, "paddle_snapshot_binding_mismatch");
  requireMatch(draft.document_id === `sha256:${original.sha256}` && draft.source.asset_ref === draft.document_id
    && attempt.originalSha256 === original.sha256 && draft.source.source_page_count === original.pageCount
    && attempt.parser.name === draft.parser.name && attempt.parser.version === draft.parser.version, "paddle_local_identity_mismatch");
  requireMatch(draft.coverage.failed_physical_pages.length === 0, "paddle_failed_page_shape_not_delivered");
  const localId = (upstream: string) => uuidv5(upstream, attempt.id);
  const byPhysicalPage = new Map(binding.pages.map((p) => [p.source_physical_page_1based, p]));
  requireMatch(byPhysicalPage.size === binding.pages.length, "paddle_ambiguous_page_mapping");
  const roles: Record<string, ParsedBlock["role"]> = { body: "body", heading: "heading", caption: "caption", footnote: "footnote",
    formula_number: "formula_number", page_number: "page_number", running_header: "header", running_footer: "footer", chart: "chart" };
  const native = (hash: string) => z.object({ page_index: z.number().int(), page_count: z.number().int(), width: z.number(), height: z.number(),
    parsing_res_list: z.array(z.object({ block_id: z.number().int(), block_label: z.string(), block_content: z.string(), block_bbox: box,
      block_order: z.number().int().nullable(), group_id: z.number().int() })) }).parse(JSON.parse(artifact(hash).toString("utf8")));
  const convertIssue = (issue: z.infer<typeof issueSchema>, physical: number, blockId: string | null, pointer: string,
    parserBlockId: number | null): ParsedIssue => {
    const mapping = byPhysicalPage.get(physical)!;
    const refs = [`sha256:${binding.snapshot_sha256}#/${position}/${pointer}`, `sha256:${mapping.native_json_sha256}`];
    const textLayer = issue.evidence.method === "optional_pdf_text_layer_code_comparison";
    if (textLayer) { artifact(mapping.text_layer_sha256); refs.push(`sha256:${mapping.text_layer_sha256}`); }
    if (issue.origin === "prior_visual_review") {
      const ledger: Array<{ case: string; block_id: number | null; code: string; severity: string; observation: string; artifact_sha256: string }> =
        JSON.parse(artifact(binding.review_findings_sha256).toString("utf8"));
      const index = ledger.findIndex((r) => r.case === mapping.case_id && r.block_id === parserBlockId && r.code === issue.code
        && r.severity === issue.severity && r.observation === issue.evidence.observation && r.artifact_sha256 === mapping.native_json_sha256);
      requireMatch(index >= 0 && issue.evidence.artifact_sha256 === mapping.native_json_sha256, "paddle_review_binding_mismatch");
      refs.push(`sha256:${binding.review_findings_sha256}#/${index}`);
    }
    return { code: issue.code, origin: textLayer ? "text_layer_comparison" : issue.origin, severity: issue.severity,
      message: typeof issue.evidence.observation === "string" ? issue.evidence.observation : issue.code,
      scope: { physical_pages: [physical], block_ids: blockId ? [blockId] : [] }, evidence_refs: refs, details_json: JSON.stringify(issue) };
  };
  const pages = draft.pages.map((page, pi) => {
    const mapping = byPhysicalPage.get(page.physical_page);
    const size = original.pages.find((p) => p.physicalPage === page.physical_page);
    requireMatch(!!mapping && !!size, "paddle_page_mapping_required");
    const m = mapping!; const geometry = size!; const n = native(m.native_json_sha256);
    // Draft 0.1 has no crop/rotation transform evidence. These delivered pages are
    // unrotated, origin-zero, unit=1; don't pretend that an unknown transform is identity.
    requireMatch(geometry.rotation === 0 && geometry.userUnit === 1 && geometry.view[0] === 0 && geometry.view[1] === 0,
      "paddle_geometry_transform_not_established");
    requireMatch(m.case_id === page.case_ref && m.original_sha256 === original.sha256 && page.printed_label === m.source_printed_label
      && n.page_count === 1 && n.page_index === m.test_single_page_index_0based
      && equal(page.size.pdf_points, m.source_size_pdf_points) && equal(page.size.render_pixels, m.render_size_pixels)
      && equal([n.width, n.height], m.render_size_pixels)
      && Math.abs(geometry.width - page.size.pdf_points[0]) < 0.02 && Math.abs(geometry.height - page.size.pdf_points[1]) < 0.02,
    "paddle_page_geometry_mismatch");
    artifact(m.test_single_page_sha256); artifact(m.excerpt_sha256);
    const blocks: ParsedBlock[] = page.blocks.map((block, bi) => {
      requireMatch(block.page_number === page.physical_page && block.parser_ref === draft.parser.run_id
        && block.content_sha256 === sha256(block.content.normalized), "paddle_block_binding_mismatch");
      // The delivered corpus has no cleaning differences. Do not silently introduce trim/newline rules.
      const cleaning = block.content.raw === block.content.normalized ? "none" : "line_endings";
      requireMatch(block.content.normalized === (cleaning === "none" ? block.content.raw : block.content.raw.replace(/\r\n?/g, "\n")), "paddle_unsupported_cleaning");
      requireMatch(Object.hasOwn(roles, block.role), "paddle_unknown_role");
      const id = localId(block.id);
      const regions: ParsedBlock["source_regions"] = block.source_regions.map((region) => {
        const source = byPhysicalPage.get(region.physical_page);
        requireMatch(!!source && region.artifact_ref === `sha256:${source.native_json_sha256}`, "paddle_region_binding_mismatch");
        const result = native(source!.native_json_sha256);
        const match = /^\/parsing_res_list\/(0|[1-9]\d*)$/u.exec(region.artifact_pointer);
        const member = match ? result.parsing_res_list[Number(match[1])] : undefined;
        requireMatch(!!member && String(member.block_id) === region.parser_block_id
          && equal(member.block_bbox, region.original_geometry.bbox)
          && equal(region.original_geometry.render_size, [result.width, result.height])
          && equal(region.bbox, member.block_bbox.map((v, i) => v / (i % 2 ? result.height : result.width))), "paddle_region_geometry_mismatch");
        if (block.source_regions.length === 1) requireMatch(member!.block_content === block.content.raw
          && member!.block_label === block.parser_native.label && member!.block_id === block.parser_native.block_id
          && member!.block_order === block.parser_native.block_order && member!.group_id === block.parser_native.group_id, "paddle_native_content_mismatch");
        return { member_id: `${region.artifact_ref}#${region.artifact_pointer}`, physical_page: region.physical_page,
          bbox: [...region.original_geometry.bbox], unit: "render_pixel", origin: "top_left", frame: "displayed_pdf_crop",
          parser_ref: { run_id: draft.parser.run_id, page_index: result.page_index, block_id: region.parser_block_id,
            result_ref: `${region.artifact_ref}#${region.artifact_pointer}` } };
      });
      const issues = block.quality.issues.map((i, index) => convertIssue(i, page.physical_page, id,
        `pages/${pi}/blocks/${bi}/quality/issues/${index}`, block.parser_native.block_id));
      return { id, type: block.type, role: roles[block.role], parser_type: block.parser_native.label,
        provenance: { upstream_id: block.id, upstream_content_sha256: block.content_sha256,
          details_json: JSON.stringify({ parser_native: block.parser_native, role: block.role, checks: block.checks,
            normalization: block.content.normalization, learning_use: block.quality.learning_use, verification: block.quality.verification }) },
        content: { raw: block.content.raw, normalized: block.content.normalized, format: block.content.format === "plain_text" ? "plain" : block.content.format, cleaning },
        source_member_ids: [...new Set(regions.map((r) => r.member_id))], source_regions: regions,
        quality: { status: block.quality.status, reason: "Imported snapshot claim; no new semantic verification",
          automatic_signals: issues.filter((i) => i.origin === "automatic_rule"), text_layer_signals: issues.filter((i) => i.origin === "text_layer_comparison"),
          prior_findings: issues.filter((i) => i.origin === "prior_visual_review"), reviews: [] } };
    });
    paddlePhysicalPage(n.page_index, [{ page_index: m.test_single_page_index_0based, physical_page: page.physical_page }]);
    return { physical_page: page.physical_page, printed_label: page.printed_label, parser_page_index: n.page_index,
      parse_status: page.parse_status, failure_code: null,
      provenance: { case_ref: page.case_ref, input_sha256: m.test_single_page_sha256, excerpt_sha256: m.excerpt_sha256,
        excerpt_physical_page: m.selected_pdf_page_1based, result_ref: `sha256:${m.native_json_sha256}`, reported_quality: page.quality_status },
      render: { width_px: n.width, height_px: n.height, rotation: geometry.rotation, crop_pdf: geometry.view,
        frame: "displayed_pdf_crop" as const },
      issues: page.issues.map((i, index) => convertIssue(i, page.physical_page, null, `pages/${pi}/issues/${index}`, null)),
      reading_order: { block_ids: page.reading_order.block_ids.map(localId), origin: page.reading_order.basis, reviews: [] }, blocks };
  });
  return ParsedDocumentResult.parse({ contract_version: PARSED_CONTRACT_VERSION, document_id: attempt.id, material_id: attempt.materialId,
    original_sha256: original.sha256, parse_version: attempt.version,
    parser_run: { run_id: draft.parser.run_id, upstream_document_id: draft.document_id, model: draft.parser.models.join(", "),
      config_summary: JSON.stringify({ contract_version: draft.contract_version, snapshot_sha256: binding.snapshot_sha256,
        parser: draft.parser, quality: draft.quality, reported_complete_source: draft.coverage.complete_source }) },
    coverage: { requested_pages: draft.coverage.requested_physical_pages, succeeded_pages: draft.coverage.parsed_physical_pages,
      failed_pages: draft.coverage.failed_physical_pages }, pages });
}
