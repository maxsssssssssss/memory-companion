import { z } from "zod";
import { GeneratedLearningFramework } from "@/lib/domain/learning-framework";
import { LearningError } from "./repository";
import { generationHash } from "./generation-parts";
import { learningModelInput, quizModelInputView } from "./model-input";

export type SourceMaterial = { materialId: string; title: string; kind?: string; scopeNotice?: unknown;
  paragraphs: Array<{ number: number; text: string; referenceId?: string; sourceContext?: unknown; slice?: { start: number; end: number; total: number } }> };
export type SourceAddress = { materialId: string; paragraph: number };
const ids = z.array(z.string().regex(/^r[1-9]\d*$/)).min(1).max(100).transform(v => [...new Set(v)]);
// These are transport-only conveniences, not permission to repair content or
// invent evidence. Model-created IDs never become stored chapter/node IDs.
const modelId = z.string().max(200).optional();
const supplement = z.string().trim().max(10000).nullable().optional().transform(v => v || null);
export const CompactFramework = z.object({ overview: z.string().trim().min(1).max(20000), chapters: z.array(z.object({
  id: modelId, title: z.string().trim().min(1).max(160), explanation: z.string().trim().min(1).max(20000),
  nodes: z.array(z.object({ id: modelId, title: z.string().trim().min(1).max(160), explanation: z.string().trim().min(1).max(20000),
    supplement, sources: ids }).strict().transform(({ id: _id, ...node }) => node)).min(1).max(1000)
}).strict().transform(({ id: _id, ...chapter }) => chapter)).min(1).max(200) }).strict();

/** Request-local aliases. The closed-over binding is never reconstructed from model output. */
export function sourceRequest(materials: SourceMaterial[], task: Record<string, unknown> = {}) {
  const references = new Map<string, SourceAddress>();
  const reverse = new Map<string, string>();
  const mapped = materials.map(m => ({ ...m, paragraphs: m.paragraphs.map(p => {
    const id = `r${references.size + 1}`;
    references.set(id, { materialId: m.materialId, paragraph: p.number });
    reverse.set(`${m.materialId}:${p.number}`, id);
    return { ...p, referenceId: id };
  }) }));
  const input = quizModelInputView(learningModelInput({ ...task, materials: mapped }));
  const resolve = (ref: string) => {
    const found = references.get(ref);
    if (!found) throw new LearningError(422, "framework_invalid_source");
    return { ...found };
  };
  return { input, resolve, reverse, binding: generationHash(materials),
    decodeFramework(value: unknown) {
      const parsed = CompactFramework.parse(value);
      return GeneratedLearningFramework.parse({ ...parsed, chapters: parsed.chapters.map(c => ({ ...c,
        nodes: c.nodes.map(n => ({ ...n, sources: n.sources.map(resolve) })) })) });
    } };
}

/** Packing is a per-request scheduling hint, never a whole-course admission limit.
 * Every source character is assigned. Oversized single paragraphs retain original
 * paragraph identity plus lossless slice offsets; no new stored paragraph numbers. */
export function sourceBatches(materials: SourceMaterial[], targetChars: number): SourceMaterial[][] {
  const target = Math.max(1000, targetChars);
  const units: Array<{ m: SourceMaterial; p: SourceMaterial["paragraphs"][number] }> = [];
  for (const m of materials) for (const p of m.paragraphs) {
    if (p.text.length <= target / 2) { units.push({ m, p }); continue; }
    let start = 0;
    while (start < p.text.length) {
      let end = Math.min(p.text.length, start + Math.floor(target / 2));
      if (end < p.text.length) {
        const fragment = p.text.slice(start, end), positions = [...fragment.matchAll(/[。！？.!?;；\n]\s*/g)];
        const boundary = positions.at(-1);
        if (boundary && boundary.index! > fragment.length / 2) end = start + boundary.index! + boundary[0].length;
        if (/[\uD800-\uDBFF]/.test(p.text[end - 1])) end--;
      }
      const slice={start,end,total:p.text.length};
      units.push({ m, p: { ...p, text: p.text.slice(start, end), slice,
        sourceContext:{...(p.sourceContext&&typeof p.sourceContext==="object"?p.sourceContext:{}),excerpt:slice,notice:"这是原段落的连续片段；不能假定未呈现的前后部分没有条件或例外。"} } }); start = end;
    }
  }
  const batches: SourceMaterial[][] = []; let current: SourceMaterial[] = [], size = 0;
  for (const { m, p } of units) {
    const bytes = JSON.stringify({ text: p.text, number: p.number }).length;
    if (current.length && (size + bytes > target || current.some(c=>c.materialId===m.materialId&&c.paragraphs.some(x=>x.number===p.number)))) { batches.push(current); current = []; size = 0; }
    let entry = current.find(c => c.materialId === m.materialId);
    if (!entry) { entry = { ...m, paragraphs: [] }; current.push(entry); size += 200; }
    entry.paragraphs.push(p); size += bytes;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function sourceSubset(materials: SourceMaterial[], refs: SourceAddress[]): SourceMaterial[] {
  const keys = new Set(refs.map(r => `${r.materialId}:${r.paragraph}`));
  return materials.map(m => ({ ...m, paragraphs: m.paragraphs.filter(p => keys.has(`${m.materialId}:${p.number}`)) })).filter(m => m.paragraphs.length);
}
