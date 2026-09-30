import type { LearningMaterial, LearningParagraph, LearningSource } from "@/lib/domain/learning";
import type { ParsedTextBinding, PdfStudySelection } from "@/lib/domain/learning-pdf-study";
import { LearningError, type LearningRepository } from "./repository";

/** Concrete PDF-to-learning projection. Does not change OCR text or quality verdicts. */
export function parsedLearningSource(repo: LearningRepository, pageId: string, material: LearningMaterial,
  selection: PdfStudySelection, historical?: ParsedTextBinding): LearningSource {
  const doc = repo.getParsedDocument(pageId, selection.documentId);
  if (doc.materialId !== material.id || doc.originalSha256 !== material.pdf?.sha256) throw new LearningError(409, "source_changed");
  const scope = repo.inspectParsedScope(pageId, doc.id, selection.physicalPages);
  const excluded = new Set(selection.excludedBlockIds ?? []);
  const enabled = scope.blocks.filter(({block}) => !excluded.has(block.id));
  const applicableIssues = scope.issues.filter(i => !i.scope.block_ids.length || i.scope.block_ids.some(id => !excluded.has(id)));
  if (!historical) {
    // Excluding a blocked block must not admit the same pixels through a merged
    // or duplicate block. Region overlap is a conservative source restriction,
    // not an assertion that neighboring content is semantically wrong.
    const blockedRegions=scope.blocks.filter(b=>b.block.quality.status==="blocked").flatMap(b=>b.source.source_regions);
    if(enabled.some(b=>b.source.source_regions.some(r=>blockedRegions.some(x=>x.physical_page===r.physical_page
      && Math.max(x.normalized_bbox[0],r.normalized_bbox[0])<Math.min(x.normalized_bbox[2],r.normalized_bbox[2])
      && Math.max(x.normalized_bbox[1],r.normalized_bbox[1])<Math.min(x.normalized_bbox[3],r.normalized_bbox[3])))))throw new LearningError(409,"pdf_scope_blocked");
    if ([...excluded].some(id => !scope.blocks.some(b => b.block.id===id))) throw new LearningError(400, "invalid_scope");
    if (!scope.conditions.selected_pages_succeeded || applicableIssues.some(i=>i.severity==="blocked") || enabled.some(b=>b.block.quality.status==="blocked")
      || doc.pages!.some(p=>selection.physicalPages.includes(p.physical_page)&&p.reading_order.assessment.status==="blocked")) throw new LearningError(409, "pdf_scope_blocked");
    if ((applicableIssues.some(i=>i.severity==="warning") || enabled.some(b=>b.block.quality.status==="warning")) && !selection.acknowledgeWarnings) throw new LearningError(409, "pdf_warning_ack_required");
    if (!selection.acknowledgeUnverified) throw new LearningError(409, "pdf_scope_not_selected");
    if (enabled.some(({ block }) => !block.content.normalized?.trim())) throw new LearningError(409, "pdf_scope_missing_content");
    // A merged block cannot carry an unselected page into generation implicitly.
    if (enabled.some(({ block }) => block.source_regions.some(r => !selection.physicalPages.includes(r.physical_page)))) throw new LearningError(409, "pdf_scope_incomplete_region");
  }
  const paragraphs: LearningParagraph[] = []; let offset = 0, number = 0;
  for (const p of [...doc.pages!].sort((a,b) => a.physical_page-b.physical_page)) for (const id of p.reading_order.block_ids) {
    const block = p.blocks.find(b => b.id === id)!; const text = block.content.normalized ?? "";
    const parsed: ParsedTextBinding = { documentId: doc.id, version: doc.version, blockId: id, physicalPage: p.physical_page, sourceHash: block.source_sha256 };
    number++;
    if (selection.physicalPages.includes(p.physical_page) && !excluded.has(id) && text.trim()) paragraphs.push({ number, start: offset, end: offset+text.length, text, parsed });
    offset += text.length+2;
  }
  if (historical && !paragraphs.some(p => JSON.stringify(p.parsed) === JSON.stringify(historical))) throw new LearningError(409, "source_changed");
  if (!paragraphs.length) throw new LearningError(409, "pdf_scope_missing_content");
  return { material, text: paragraphs.map(p=>p.text).join("\n\n"), paragraphs,
    scopeNotice: { kind: "pdf", documentId: doc.id, parseVersion: doc.version, physicalPages: selection.physicalPages,
      excludedPhysicalPages: material.pdf!.pages.map(p=>p.physicalPage).filter(n=>!selection.physicalPages.includes(n)),
      excludedBlockIds: [...excluded], contentVerified: false, warningCodes: [...new Set(scope.issues.map(i=>i.code))] } };
}
