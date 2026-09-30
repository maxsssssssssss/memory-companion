import { z } from "zod";
import { ReferencedGeneratedQuiz, ReferencedQuizEnvelope, type ReferencedQuizResponse } from "@/lib/domain/learning-quiz";
import { frameworkHash } from "./framework-repository";
import type { LearningQuizRepository } from "./quiz-repository";
import { LearningError } from "./repository";
import { learningModelInput, quizModelInputView } from "./model-input";

type Input = NonNullable<ReturnType<LearningQuizRepository["begin"]>>;
export type QuizReferenceScope = { accountId: string; pageId: string; requestId: string; expiresAt: number };
const shortIds = z.array(z.string().regex(/^r[1-9]\d*$/)).min(1).max(100).refine(v => new Set(v).size === v.length);
const longItem = ReferencedGeneratedQuiz.shape.items.element;
const compactItem = longItem.extend({
  stemEvidenceIds: shortIds, explanationEvidenceIds: shortIds,
  options: z.array(longItem.shape.options.element.extend({ evidenceIds: shortIds })).min(2).max(6)
});
export const CompactQuizEnvelope = ReferencedQuizEnvelope.extend({ referenceScope: z.string().regex(/^[a-f0-9]{64}$/) });

/** A one-request codec, not a stored source authority. Repository publication still
 * checks the live account, material hashes, selected parsed versions and deletion. */
export function compactQuizRequest(input: Input, scope: QuizReferenceScope, view: "current" | "reduced" = "reduced") {
  const boundScope = { ...scope };
  const wire = learningModelInput(input);
  const stable = [...input.materials.flatMap(m => m.paragraphs.map(p => p.referenceId)), ...input.extras.map(e => e.referenceId)];
  if (new Set(stable).size !== stable.length || stable.some(id => !/^ref_[a-f0-9]{64}$/.test(id))) {
    throw new LearningError(422, "quiz_grounding_invalid");
  }
  const binding = frameworkHash(JSON.stringify({ scope: boundScope, input }));
  const aliases = new Map(stable.map((id, i) => [id, `r${i + 1}`]));
  const originals = new Map([...aliases].map(([id, alias]) => [alias, id]));
  const current = {
    ...wire,
    materials: wire.materials.map(m => ({ ...m, paragraphs: m.paragraphs.map(p => ({ ...p, referenceId: aliases.get(p.referenceId!)! })) })),
    extras: input.extras.map(e => ({ kind: e.kind, text: e.text, referenceId: aliases.get(e.referenceId)! })),
    taskContext: { ...wire.taskContext, referenceScope: binding }
  };
  const compact = view === "current" ? current : quizModelInputView(current);
  const aliasPattern = /\br[1-9]\d*\b/g;
  const literalNames = new Set([...input.materials.flatMap(m => m.paragraphs.map(p => p.text)), ...input.extras.map(e => e.text)]
    .flatMap(text => text.match(aliasPattern) ?? []));
  const labels = new Map<string, string>();
  for (const m of input.materials) for (const p of m.paragraphs) {
    const page = p.sourceContext?.physicalPage;
    labels.set(aliases.get(p.referenceId)!, `《${m.title}》${page ? `PDF 第 ${page} 物理页，来源段 ${p.number}` : `第 ${p.number} 段`}`);
  }
  input.extras.forEach((e, i) => labels.set(aliases.get(e.referenceId)!, `所选${e.kind === "note" ? "个人笔记" : "补充解释"}第 ${i + 1} 条`));
  const prose = (text: string, allowed: Set<string>, literals = literalNames) => text.replace(aliasPattern, id => {
    // A name actually present in the source (or explicitly defined in a new
    // scenario) is content, not an instruction to delete/replace a variable.
    if (literals.has(id)) return id;
    if (!allowed.has(id) || !labels.has(id)) throw new LearningError(422, "quiz_grounding_invalid");
    return `〔${labels.get(id)}〕`;
  });
  let consumed = false;
  return {
    input: compact,
    schema: CompactQuizEnvelope,
    resolveIds(ids: string[]) {
      if (Date.now() >= boundScope.expiresAt || ids.some(id => !originals.has(id))) throw new LearningError(422,"quiz_grounding_invalid");
      return ids.map(id => originals.get(id)!);
    },
    decode(value: unknown, currentScope: QuizReferenceScope): ReferencedQuizResponse {
      if (consumed || Date.now() >= boundScope.expiresAt || JSON.stringify(currentScope) !== JSON.stringify(boundScope)) {
        throw new LearningError(409, "source_changed");
      }
      consumed = true;
      const parsed = CompactQuizEnvelope.parse(value);
      if (parsed.referenceScope !== binding) throw new LearningError(422, "quiz_grounding_invalid");
      const { referenceScope: _binding, ...result } = parsed;
      return { ...result, title: prose(result.title, new Set(originals.keys())),
        reason: result.reason === null ? null : prose(result.reason, new Set(originals.keys())), items: result.items.map(raw => {
        const item = compactItem.safeParse(raw);
        // Preserve independent valid questions. A bad item cannot pass through as
        // legacy full IDs, be guessed, or lose only the inconvenient reference.
        const rejected = { compactReferenceRejected: true };
        if (!item.success) return rejected;
        const q = item.data;
        const used = [...q.stemEvidenceIds, ...q.explanationEvidenceIds, ...q.options.flatMap(o => o.evidenceIds)];
        if (used.some(id => !originals.has(id))) return rejected;
        const expand = (ids: string[]) => ids.map(id => originals.get(id)!);
        const literals = new Set(literalNames);
        for (const match of `${q.scenario ?? ""}\n${q.stem}`.matchAll(/(?:变量|参数|令|设)\s*(r[1-9]\d*)\b|\b(r[1-9]\d*)\s*=/g)) literals.add(match[1] ?? match[2]);
        try {
          return { ...q, scenario: q.scenario ? prose(q.scenario, new Set(q.stemEvidenceIds), literals) : q.scenario,
            stem: prose(q.stem, new Set(q.stemEvidenceIds), literals), explanation: prose(q.explanation, new Set(q.explanationEvidenceIds), literals),
            hint: q.hint === null ? null : prose(q.hint, new Set(used), literals),
            stemEvidenceIds: expand(q.stemEvidenceIds), explanationEvidenceIds: expand(q.explanationEvidenceIds),
            options: q.options.map(o => ({ ...o, text: prose(o.text, new Set(o.evidenceIds), literals),
              reason: prose(o.reason, new Set(o.evidenceIds), literals), evidenceIds: expand(o.evidenceIds) })) };
        } catch (e) { if (e instanceof LearningError) return rejected; throw e; }
      }) };
    }
  };
}

/** Only the wire-reference instructions change; educational rules stay identical. */
export function compactQuizPrompt(prompt: string) {
  return prompt.replace("每段材料/解析块和每条显式纳入的extra已有稳定referenceId。", "每段材料/解析块和每条显式纳入的extra已有本请求短referenceId（如r1）。")
    .replaceAll("所给完整referenceId", "所给referenceId")
    .replace("不要另建e1/e2别名、数组下标", "不要另建别名、数组下标")
    .replace('"contractVersion":"references-v2","title"', '"contractVersion":"references-v2","referenceScope":"原样回传taskContext.referenceScope","title"');
}
