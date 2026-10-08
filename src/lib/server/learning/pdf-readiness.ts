import type { LearningPdfReadiness, PdfStudySelection } from "@/lib/domain/learning-pdf-study";
import { parsedLearningSource } from "./parsed-learning";
import { pdfParseProgress } from "./pdf-parser-service";
import { LearningError, type LearningRepository } from "./repository";

/** Read-only proposal. The caller owns automatic-processing permission and must
 * pause for explicit permission whenever partial is true before saving this scope.
 * Existing repositories remain the only source, scope and processing authorities. */
export function inspectLearningPdfReadiness(repo: LearningRepository, pageId: string, materialId: string, documentId?: string): LearningPdfReadiness {
  const material = repo.pdfOriginal(pageId, materialId, false).material;
  const allPages = material.pdf!.pages.map(p => p.physicalPage);
  const documents = repo.listParsedDocuments(pageId, materialId);
  const selected = documentId === undefined ? documents.at(-1) : documents.find(d => d.id === documentId);
  if (documentId !== undefined && !selected) throw new LearningError(404, "parsed_document_not_found");
  const result: LearningPdfReadiness = { documentId: selected?.id ?? null, status: "blocked", selection: null,
    partial: true, totalPages: allPages.length, completedPages: [], failedPages: [], pendingPages: [],
    unknownPages: [], excludedPages: [...allPages], excludedBlockCount: 0, warningCodes: [], limitations: [] };
  if (!selected) {
    result.pendingPages = [...allPages];
    result.limitations.push("PDF 原件已保存，尚未解析，暂无可用于整理的文字。");
    return result;
  }
  const doc = repo.getParsedDocument(pageId, selected.id);
  const checkpoints = pdfParseProgress(repo, pageId, doc.id);
  const progress = new Map(checkpoints.map(p => [p.physical_page, p.status]));
  const serviceChanged = checkpoints.some(point => point.issue === "pdf_parser_service_changed");
  const uploadIssue = checkpoints.find(point => point.issue?.startsWith("pdf_source_"))?.issue;
  const stopped = checkpoints.some(point => point.issue === "pdf_parser_budget_exhausted") ? "budget_exhausted"
    : checkpoints.some(point => point.issue === "pdf_parser_session_expired") ? "session_expired" : undefined;
  const succeeded = new Set(doc.coverage?.succeeded_pages ?? []);
  const requested = new Set(doc.requestedPages ?? []);
  for (const page of allPages) {
    const state = progress.get(page);
    if (succeeded.has(page) || (doc.status === "processing" && state === "completed")) result.completedPages.push(page);
    else if (state === "unknown" || state === "submitted") result.unknownPages.push(page);
    else if (state === "pending" || state === "waiting_resource" || !requested.has(page) || doc.status === "pending") result.pendingPages.push(page);
    // Legacy imported results may have no execution checkpoints. Their failed
    // pages mean no usable result, not proof of repeated Provider failures.
    else result.failedPages.push(page);
  }
  if (result.failedPages.length) result.limitations.push(`${result.failedPages.length} 页未获得可用解析结果。`);
  if (result.pendingPages.length) result.limitations.push(`${result.pendingPages.length} 页尚未处理。`);
  if (result.unknownPages.length) result.limitations.push(`${result.unknownPages.length} 页处理结果待确认，不会自动重新提交。`);
  if (serviceChanged) result.limitations.unshift("上次处理对应的解析服务已变化，需要先核对原请求；已完成页和原件仍保留。");
  if (uploadIssue) result.limitations.unshift(uploadIssue === "pdf_source_outcome_unknown"
    ? "PDF 原件上传结果待确认；尚未重复上传或提交新页识别，可稍后继续处理。"
    : uploadIssue === "pdf_source_capacity_exhausted" ? "PDF 解析服务临时存储空间不足；尚未提交新页识别，已完成页仍保留。"
    : "PDF 原件的临时解析副本尚未准备好；已完成页保留，可继续处理未完成部分。");
  if (stopped) result.limitations.unshift(stopped === "budget_exhausted" ? "本轮解析额度已用完，已完成页和原件仍保留；未完成页不会自动重试。"
    : "本轮解析服务使用时段已结束，已完成页和原件仍保留；未完成页不会自动重试。");
  if (stopped && !result.unknownPages.length) result.processing = stopped;
  else if (!serviceChanged && !result.unknownPages.length && [...progress.values()].some(state => state === "waiting_resource")) {
    result.processing = "waiting_resource";
    result.limitations.unshift(`等待解析资源，已完成 ${result.completedPages.length}/${allPages.length} 页；已完成页已保存。`);
  } else if (!serviceChanged && !result.unknownPages.length && doc.status === "processing" && result.completedPages.length) result.processing = "resuming";
  if (doc.status === "pending" || doc.status === "processing") {
    result.status = "waiting";
    if (!serviceChanged && !stopped && result.processing !== "waiting_resource") result.limitations.unshift(`正在准备 PDF，已完成 ${result.completedPages.length}/${doc.requestedPages?.length ?? allPages.length} 页。`);
    return result;
  }
  if (doc.status !== "completed" || !doc.pages) {
    result.limitations.push("当前解析尚无可用文字，原件保留。");
    return result;
  }
  const scope = repo.inspectParsedScope(pageId, doc.id, doc.requestedPages!);
  const pageBlocked = new Set(scope.issues.filter(i => i.severity === "blocked" && !i.scope.block_ids.length)
    .flatMap(i => i.scope.physical_pages));
  for (const page of doc.pages) if (page.reading_order.assessment.status === "blocked") pageBlocked.add(page.physical_page);
  let pages = doc.pages.filter(p => p.parse_status === "succeeded" && !pageBlocked.has(p.physical_page)).map(p => p.physical_page);
  // inspectParsedScope includes every source region of a touched block, including
  // excluded blocks. Preserve its page-level restrictions across merged regions.
  const blockedLinkedPages = new Set(scope.blocks.filter(b => b.block.source_regions.some(r => pageBlocked.has(r.physical_page)))
    .flatMap(b => b.block.source_regions.map(r => r.physical_page)));
  pages = pages.filter(p => !blockedLinkedPages.has(p));
  const blockedIds = new Set(scope.issues.filter(i => i.severity === "blocked").flatMap(i => i.scope.block_ids));
  const blockedRegions = scope.blocks.filter(b => b.block.quality.status === "blocked" || blockedIds.has(b.block.id))
    .flatMap(b => b.source.source_regions);
  const excluded = new Set(scope.blocks.filter(({ block, source }) => block.quality.status === "blocked" || blockedIds.has(block.id)
    || !block.content.normalized?.trim() || source.source_regions.some(r => blockedRegions.some(b => b.physical_page === r.physical_page
      && Math.max(b.normalized_bbox[0], r.normalized_bbox[0]) < Math.min(b.normalized_bbox[2], r.normalized_bbox[2])
      && Math.max(b.normalized_bbox[1], r.normalized_bbox[1]) < Math.min(b.normalized_bbox[3], r.normalized_bbox[3])))).map(b => b.block.id));
  // Removing an empty page can invalidate a merged block on another page.
  // Iterate only while pages shrink, never expand beyond actual succeeded pages.
  for (;;) {
    for (const { block } of scope.blocks) if (block.source_regions.some(r => !pages.includes(r.physical_page))) excluded.add(block.id);
    const usable = pages.filter(p => doc.pages!.find(page => page.physical_page === p)!.blocks.some(b => !excluded.has(b.id)));
    if (usable.length === pages.length) break;
    pages = usable;
  }
  result.excludedPages = allPages.filter(p => !pages.includes(p));
  result.excludedBlockCount = excluded.size;
  result.warningCodes = [...new Set(scope.issues.map(i => i.code))];
  result.partial = result.excludedPages.length > 0 || result.excludedBlockCount > 0;
  if (result.excludedBlockCount) result.limitations.push(`已排除 ${result.excludedBlockCount} 个不可用、空白或来源不完整的区域。`);
  const unavailable = result.excludedPages.filter(p => succeeded.has(p));
  if (unavailable.length) result.limitations.push(`${unavailable.length} 个已处理页没有可安全用于整理的范围。`);
  if (scope.conditions.has_warning) result.limitations.push("可用文字仍含解析告警；这些告警会随学习来源保留，不代表已核验。");
  result.limitations.push("解析内容尚未核实；框架与练习仅依据本次可用文字，不补全图像或公式。");
  if (!pages.length) return result;
  const selectedScope = repo.inspectParsedScope(pageId, doc.id, pages);
  const selection: PdfStudySelection = { documentId: doc.id, physicalPages: pages.sort((a, b) => a - b),
    excludedBlockIds: selectedScope.blocks.filter(b => excluded.has(b.block.id)).map(b => b.block.id),
    authorization: "automatic", acknowledgeUnverified: true, acknowledgeWarnings: true };
  // This exact admission check is also used by selectPdfStudy. A proposal cannot
  // relax page, overlap, reading-order, content or source-region gates.
  try { parsedLearningSource(repo, pageId, material, selection); }
  catch (error) {
    if (!(error instanceof LearningError) || !["pdf_scope_blocked", "pdf_scope_missing_content", "pdf_scope_incomplete_region"].includes(error.code)) throw error;
    result.limitations.push("当前范围仍有未满足的来源或内容限制，暂不能自动整理。");
    return result;
  }
  result.selection = selection;
  result.status = result.partial ? "partial" : "ready";
  return result;
}
