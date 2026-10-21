import { z } from "zod";
import { quizCandidateValidationIssues, type QuizCandidateIssue } from "./quiz-candidate-diagnostics";
import { ReferencedGeneratedQuiz } from "@/lib/domain/learning-quiz";
import { compactQuizRequest, compactQuizPrompt, CompactQuizEnvelope } from "./quiz-compact";
import { inspectQuizOptionExplanation, hasQuizPositionDependency, quizProceduralHint, QUIZ_REJECTION_DETAILS, type QuizRejectionReason } from "./quiz-grounding";

// A request/response view over the existing references-v2 codec. No new stored
// reference authority, additional model request, or historical data conversion.
const shortIds = z.array(z.string().regex(/^r[1-9]\d*$/)).min(1).max(100).transform(ids => [...new Set(ids)]);
const reasonParts = z.array(z.object({ text: z.string().trim().min(1).max(8000), evidenceIds: shortIds }).strict()).min(1).max(16);
const originalItem = ReferencedGeneratedQuiz.shape.items.element;
const itemSchema = originalItem.omit({ explanation: true, explanationEvidenceIds: true }).extend({
  focus: z.string().trim().min(1).max(300).optional(),
  stemEvidenceIds: shortIds,
  // Earlier in-flight responses may carry independent explanatory content.
  // Retain all of it; new requests derive the summary from the correct reason.
  explanationParts: z.preprocess(v => Array.isArray(v) && v.length === 0 ? undefined : v, reasonParts.nullish()),
  scenario: z.preprocess(v => v === "" ? null : v, originalItem.shape.scenario),
  hint: z.preprocess(v => v === "" ? null : v, originalItem.shape.hint.optional().default(null)),
  options: z.array(originalItem.shape.options.element.omit({ reason: true, evidenceIds: true }).extend({ reasonParts })).min(2).max(6)
});
const planEntry = z.object({ material: z.number().int().positive(), contribution: z.string().trim().min(1).max(1200),
  references: z.array(z.string().regex(/^r[1-9]\d*$/)).max(100) }).strict();
// This composed request already owns the reference map and the exact account /
// page / request / source snapshot in its server closure. The model need not
// retype a fixed 64-character digest. Earlier responses may still echo it:
// explicit echoes must retain both strict format and exact binding checks.
const envelope = CompactQuizEnvelope.extend({ referenceScope: CompactQuizEnvelope.shape.referenceScope.optional(),
  reason: CompactQuizEnvelope.shape.reason.default(null), materialPlan: z.array(z.unknown()).max(1000).default([]) });
const normalize = (text: string) => text.replace(/\s/g, "").toLowerCase();
const joinParts = (parts: z.infer<typeof reasonParts>) => ({ text: parts.map(p => p.text).join("\n"), ids: [...new Set(parts.flatMap(p => p.evidenceIds))] });

export function composedQuizRequest(...args: Parameters<typeof compactQuizRequest>) {
  const codec = compactQuizRequest(...args);
  return {
    ...codec,
    schema: envelope,
    input: { ...codec.input, taskContext: { ...codec.input.taskContext,
      coverageInstruction: "先按materialCatalog逐份辨别独有知识、重复背景和无法确定的内容，再安排本组考点。材料序号仅供计划；题目依据仍用正文referenceId。题量有限时诚实说明未覆盖内容，不按文件平均配题，也不靠重复考点凑题。" } },
    decode(value: unknown, scope: Parameters<typeof codec.decode>[1], onIssue?: (issue: QuizCandidateIssue) => void) {
      const parsed = envelope.parse(value);
      const { materialPlan, ...body } = parsed;
      const notes: string[] = [];
      const seenMaterials = new Set<number>();
      let invalidPlan = false;
      for (const raw of materialPlan) {
        const entry = planEntry.safeParse(raw);
        if (!entry.success) { invalidPlan = true; continue; }
        const { material, references } = entry.data;
        const allowed = new Set(codec.input.materials[material - 1]?.paragraphs.map(p => p.referenceId));
        if (!allowed.size || seenMaterials.has(material) || references.some(ref => !allowed.has(ref))) { invalidPlan = true; continue; }
        seenMaterials.add(material);
      }
      // Planning text is never an answer source or shown before a test. Actual
      // published coverage is computed again after individual item validation.
      if (invalidPlan || seenMaterials.size !== codec.input.materials.length) notes.push("材料考查安排不完整；本组实际涉及范围以已保存题目的来源为准。");
      const focuses: Array<string | undefined> = [];
      const rejections = new Map<number, QuizRejectionReason>();
      const reject = (index: number, reason: QuizRejectionReason, validationIssues?: QuizCandidateIssue["validationIssues"]) => {
        onIssue?.({ index, stage: "composition", code: reason, ...(validationIssues ? { validationIssues } : {}) });
        rejections.set(index, reason);
        notes.push(`第 ${index + 1} 题${QUIZ_REJECTION_DETAILS[reason]}，未发布。`);
        return { compositionRejected: true, rejectionReason: reason };
      };
      const items = body.items.map((raw, index) => {
        const result = itemSchema.safeParse(raw);
        if (!result.success) {
          return reject(index, "structure_or_evidence", quizCandidateValidationIssues(result.error));
        }
        const { focus, explanationParts, ...q } = result.data;
        if (new Set(q.options.map(o => o.id)).size !== q.options.length || !q.options.some(o => o.id === q.correctOptionId)) return reject(index, "option_identity");
        if ([q.scenario ?? "", q.stem, ...q.options.map(o => o.text)].some(text => hasQuizPositionDependency(text, `${q.scenario ?? ""}\n${q.stem}`))) return reject(index, "position_dependency");
        focuses[index] = focus;
        const explanation = joinParts(explanationParts ?? q.options.find(o => o.id === q.correctOptionId)!.reasonParts);
        return { ...q, explanation: explanation.text, explanationEvidenceIds: explanation.ids,
          options: q.options.map(({ reasonParts, ...option }) => {
            const reason = joinParts(reasonParts);
            return { ...option, reason: reason.text, evidenceIds: reason.ids };
          }) };
      });
      const decoded = codec.decode({ ...body, referenceScope: body.referenceScope ?? codec.input.taskContext.referenceScope, items }, scope, onIssue);
      const seen = new Set<string>();
      decoded.items = decoded.items.map((raw, index) => {
        if (rejections.has(index)) return { compositionRejected: true, rejectionReason: rejections.get(index)! };
        const checked = ReferencedGeneratedQuiz.shape.items.element.safeParse(raw);
        if (!checked.success) return raw;
        const q = checked.data;
        // Only post-answer prose is normalized, after exact short-reference
        // restoration. No model text is inserted into a stem, option or hint.
        const context = `${q.scenario ?? ""}\n${q.stem}`;
        const explanation = inspectQuizOptionExplanation(q.explanation, q.options, q.correctOptionId, context);
        const reasons = q.options.map(o => inspectQuizOptionExplanation(o.reason, q.options, q.correctOptionId, context));
        const issue = [explanation, ...reasons].find(result => result.issue)?.issue;
        if (issue) return reject(index, issue);
        const normalized = { ...q, explanation: explanation.text!, options: q.options.map((o, i) => ({ ...o, reason: reasons[i].text! })), hint: quizProceduralHint(q.kind) };
        if (!focuses[index]) return normalized;
        // Exact declared objective + same scenario and stem basis, not an
        // ungrounded semantic-similarity threshold. Paraphrases still need review.
        const key = JSON.stringify([normalize(focuses[index]!), normalize(q.scenario ?? ""), [...new Set(q.stemEvidenceIds)].sort()]);
        if (seen.has(key)) return reject(index, "repeated_focus");
        seen.add(key);
        return normalized;
      });
      return { ...decoded, reason: [decoded.reason, ...notes].filter(Boolean).join("\n") || null };
    }
  };
}

export function composedQuizPrompt(prompt: string) {
  const compact = compactQuizPrompt(prompt);
  // Replace the old wire instructions, rather than leaving contradictory output
  // shapes for the model to reconcile. All educational/source rules stay in place.
  return compact.split("\n").filter(line => !line.startsWith("每段材料/解析块和每条显式纳入的extra已有")
    && !line.startsWith("仅输出JSON：") && !line.startsWith("上述JSON是封闭输出契约"))
    .map(line => line.startsWith("一次输出答案") ? "一次输出答案及每个选项的正确/错误原因。应用在服务器按作答模式揭示，不能把答案放在题干中。"
      : line.startsWith("hint不能重述") ? line.slice(line.indexOf("选项id是")) : line)
    .join("\n") + `
本次按以下顺序组织同一份响应，不增加调用：先写materialPlan，逐份说明有何独有考点并选择相应referenceId；仅为背景、与其他内容重复、无法确定或受本组题量限制时写明原因，references可为空。不要凭文件名认定没有价值。再写items，每题focus用一句话明确实际考查的判断，先安排互补考点，避免两题反复考同一分类。
每个选项的reasonParts把解释与依据就近放在一起；一句解释用到规则和案例时同时引用两处，涉及另一条件时另写一段并关联其依据。正确选项的reasonParts须完整说明推理和适用条件，程序复用它作为总解析，不再要求另一份重复结论。不要输出选项reason/evidenceIds、explanation/explanationEvidenceIds、explanationParts或hint；程序完整拼接解释、合并来源并提供不泄题的思考步骤，不猜补相邻段落。片段不需要按每个词或逐claim拆分，也不代表语义已核验。
referenceScope是应用已绑定的请求元数据，无需输出或重新计算；它不是课程依据。各处evidenceIds仍必须逐项选择本次实际给出的r编号，不能猜测、借用别题或补造来源。
仅输出JSON：{"contractVersion":"references-v2","title":"题组标题","reason":null,"materialPlan":[{"material":1,"contribution":"独有考点或本组未考查的原因","references":["r1"]}],"items":[{"focus":"本题考查的判断","scenario":null,"stem":"待判断的问题","kind":"concept|relationship|application","stemEvidenceIds":["r1"],"options":[{"id":"A","text":"选项","reasonParts":[{"text":"为何正确或错误及适用条件","evidenceIds":["r1"]}]},{"id":"B","text":"选项","reasonParts":[{"text":"为何正确或错误","evidenceIds":["r1","r2"]}]}],"correctOptionId":"A"}]}。
解释的每个片段都应有实际依据；一个片段缺少依据时不能借用其他选项或整题的来源补齐。引用未知或不属于本次范围就不可发布该题。所有选项稳定ID与事实保持关联，不写显示位置字母。`;
}

export function quizCoverageNotice(materials: Array<{ materialId: string; title: string }>, items: Array<{ sources: Array<{ kind: string; materialId?: string }> }>) {
  if (!items.length) return null;
  const used = new Set(items.flatMap(q => q.sources.filter(s => s.kind === "material").map(s => s.materialId)));
  const missing = materials.filter(m => !used.has(m.materialId));
  if (!missing.length) return null;
  const names = missing.slice(0, 8).map(m => `《${m.title}》`).join("、");
  return `本组题引用了 ${materials.length - missing.length}/${materials.length} 份所选材料，未引用${names}${missing.length > 8 ? `等 ${missing.length} 份材料` : ""}；不代表已覆盖全部学习范围。`;
}
