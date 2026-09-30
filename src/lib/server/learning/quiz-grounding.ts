import { randomInt } from "node:crypto";
import { ReferencedGeneratedQuiz, type ModelQuiz, type ReferencedQuizResponse } from "@/lib/domain/learning-quiz";
import { frameworkHash } from "./framework-repository";

export type QuizReference = { referenceId: string; source: ModelQuiz["items"][number]["sources"][number]; text: string };
export const quizReferenceId = (binding: unknown) => `ref_${frameworkHash(JSON.stringify(binding))}`;
export const QUIZ_PROCEDURAL_HINT = "先区分题干对象、适用前提和实际结果，再逐项对照所选材料中的条件与反例。";
export function quizProceduralHint(kind: ModelQuiz["items"][number]["kind"]) {
  if (kind === "concept") return "先找出题干所问的概念，再对照材料中的定义和适用范围，逐项比较差别。";
  if (kind === "relationship") return "分别找出关系两端的依据，检查它们的联系是否需要额外条件，以及是否存在例外。";
  return QUIZ_PROCEDURAL_HINT;
}

// The UI assigns visible letters from this persisted order; IDs and attached reasons never change.
export function arrangeQuizOptions<T>(options: T[], pick = randomInt): T[] {
  const result = [...options];
  for (let i = result.length - 1; i > 0; i--) {
    const j = pick(i + 1); [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// A conservative rejection of position-dependent options, not a semantic verifier.
const positionDependent = /以上(?:全|都|皆|均|各|两|三)|上述(?:全|都|皆|均|各|两|三)|以下(?:全|都|皆|均)|(?:all|none|both) of (?:the )?(?:above|below)|(?:选项|答案|option|choice|选择|选|choose|select|正确项|错误项)\s*[A-Z]\b|\b[A-Z]\s*(?:和|与|及|、|或|and|or|&)\s*[A-Z]\b|第[一二三四五六1-6]个选项|\b[A-Z](?:项|正确|错误|准确|误将|将|说|是正确|是错误)/i;
function quizLiteralRanges(text: string) {
  const entity = /(?:方案|计划|组别|类型|模型|区域|\bplan\b|\bgroup\b|\bcase\b)\s*[A-Z](?:\s*(?:和|与|及|、|或|and|or|&)\s*[A-Z])?|\b[A-Z]\s*(?:组|队|型|类|区|站)/gi;
  const ranges = [...text.matchAll(entity)].map(m => [m.index!, m.index! + m[0].length]);
  // Explicit alphabet enumerations containing letters outside the option-ID
  // alphabet are content (e.g. an acronym's letters), not choice combinations.
  // This does not whitelist a sample name or exempt bare A/B combinations.
  const letters = /\b([A-Z](?:\s*[、,，]\s*[A-Z])+)\s*(?:[一二三四五六七八九十\d]+\s*个)?\s*(?:字母|letters?\b)/gi;
  for (const m of text.matchAll(letters)) {
    const optionPrefix = /(?:选项|答案|option|choice|正确项|错误项|选择|选|choose|select)\s*$/i.test(text.slice(0, m.index));
    if (!optionPrefix && /[G-Z]/i.test(m[1])) ranges.push([m.index!, m.index! + m[0].length]);
  }
  return ranges;
}
function maskQuizLiterals(text: string) {
  const chars = text.split("");
  for (const [start, end] of quizLiteralRanges(text)) for (let i = start; i < end; i++) chars[i] = " ";
  return chars.join("");
}
export function hasQuizPositionDependency(text: string) {
  // Mask explicit entity names for detection only; never rewrite a saved explanation.
  return positionDependent.test(maskQuizLiterals(text));
}

/** New-response explanations only: resolve explicit option identities to quoted
 * content before shuffling. Never apply this to stems, hints or saved history. */
export function bindQuizOptionExplanation(text: string, options: Array<{ id: string; text: string }>, correctId: string): string | null {
  const byId = new Map(options.map(o => [o.id, o]));
  if (byId.size !== options.length || !byId.has(correctId)) return null;
  if (/\b[A-Z]项?\s*(?:和|与|及|、|或|and|or|&)\s*(?:选项\s*)?[A-Z]项?(?![A-Za-z0-9_])/.test(maskQuizLiterals(text))) return null;
  const protectedRanges = quizLiteralRanges(text);
  const explicit = /(?<verdict>正确项|错误项)\s*(?<verdictId>[A-Z])\b|(?<label>选项|答案|[Oo]ption|[Cc]hoice)\s*(?<labelId>[A-Z])\b|\b(?<bareId>[A-Z])(?<suffix>项|(?=正确|错误|准确|误将|将|说|是正确|是错误))/g;
  const pieces: string[] = [];
  let cursor = 0;
  for (const match of text.matchAll(explicit)) {
    const start = match.index!, end = start + match[0].length;
    if (protectedRanges.some(([a, b]) => start < b && end > a)) continue;
    // A reference to another question or a combined/ordinal choice is not a
    // reference to this question's option identity.
    if (/第\s*[一二三四五六七八九十\d]+\s*题|上(?:一)?题|前题|下(?:一)?题|previous question|next question/i.test(text)) return null;
    const groups = match.groups!, id = groups.verdictId ?? groups.labelId ?? groups.bareId;
    const option = byId.get(id);
    if (!option) return null;
    const after = text.slice(end);
    const positive = groups.verdict === "正确项" || groups.label === "答案" || /^(?:\s*是)?\s*(?:正确|准确)(?!地)/.test(after);
    const negative = groups.verdict === "错误项" || /^(?:\s*是)?\s*(?:错误(?!地)|不正确|不准确)/.test(after);
    if ((positive && id !== correctId) || (negative && id === correctId)) return null;
    const prefix = groups.verdict === "正确项" ? "正确选项" : groups.verdict === "错误项" ? "错误选项" : "选项";
    pieces.push(text.slice(cursor, start), `${prefix}「${option.text}」`);
    cursor = end;
  }
  pieces.push(text.slice(cursor));
  const result = pieces.join("");
  return hasQuizPositionDependency(result) ? null : result;
}

/** Shared inspection for candidate selection and the final publication fence.
 * It neither changes display order nor infers missing semantic evidence. */
function inspectReferencedQuiz(value: ReferencedQuizResponse, catalog: QuizReference[]) {
  const references = new Map(catalog.map(r => [r.referenceId, r]));
  const items: ModelQuiz["items"] = [], rejected: string[] = [];
  const acceptedIndexes: number[] = [];
  const stems = new Set<string>();
  for (const [index, raw] of value.items.entries()) {
    const reject = (reason: string) => rejected.push(`第 ${index + 1} 题${reason}`);
    const checked = ReferencedGeneratedQuiz.shape.items.element.safeParse(raw);
    if (!checked.success) { reject("题目结构或依据ID格式不合法，未发布"); continue; }
    const q = checked.data;
    const { scenario, ...question } = q;
    const fullStem = scenario ? `${scenario}\n\n${q.stem}` : q.stem;
    const stem = fullStem.replace(/\s/g, "").toLowerCase();
    if (stems.has(stem)) { reject("重复，未发布"); continue; }
    if (new Set(q.options.map(o => o.id)).size !== q.options.length || !q.options.some(o => o.id === q.correctOptionId)
      || new Set(q.options.map(o => o.text.replace(/\s/g, "").toLowerCase())).size !== q.options.length
      || [fullStem, q.explanation, q.hint ?? "", ...q.options.flatMap(o => [o.text, o.reason])].some(hasQuizPositionDependency)) {
      reject("选项重复、身份不完整或依赖排列位置，未发布"); continue;
    }
    const used = [...new Set([...q.stemEvidenceIds, ...q.explanationEvidenceIds, ...q.options.flatMap(o => o.evidenceIds)])];
    if (used.some(id => !references.has(id))) {
      reject("依据不在所选范围或依据关联缺失，未发布"); continue;
    }
    // No model-created alias or repeated quote: evidence is the exact selected paragraph/block.
    const evidence = used.map(id => ({ id, referenceId: id, source: references.get(id)!.source, quote: references.get(id)!.text }));
    const sources = [...new Map(evidence.map(e => [JSON.stringify(e.source), e.source])).values()];
    items.push({ ...question, stem: fullStem, options: q.options, sources, evidence, hint: q.hint ? quizProceduralHint(q.kind) : null });
    acceptedIndexes.push(index);
    stems.add(stem);
  }
  return { acceptedIndexes, rejected, quiz: { title: value.title, reason: [value.reason, rejected.length ? `结构与依据检查排除 ${rejected.length} 题：${rejected.join("；")}。实际保留 ${items.length} 题，未补调用。` : null].filter(Boolean).join("\n") || null, items } };
}

/** Surplus candidates are inspected before selecting in model order. Invalid
 * early items must not hide a valid later candidate or fail the entire group. */
export function limitReferencedQuizCandidates(value: ReferencedQuizResponse, catalog: QuizReference[], count: number): ReferencedQuizResponse {
  const inspected = inspectReferencedQuiz(value, catalog);
  const selected = inspected.acceptedIndexes.slice(0, count);
  const omitted = inspected.acceptedIndexes.length - selected.length;
  return { ...value, items: selected.map(index => value.items[index]),
    reason: [value.reason, inspected.rejected.length ? `结构与依据检查排除 ${inspected.rejected.length} 题：${inspected.rejected.join("；")}。` : null,
      `模型返回 ${value.items.length} 个候选题，本组按设置保留 ${selected.length} 题${omitted > 0 ? `，另有 ${omitted} 个候选未加入本组` : ""}，未追加生成。`].filter(Boolean).join("\n") || null };
}

/** Resolve explicit IDs only. Arrange once, immediately before persistence. */
export function resolveReferencedQuiz(value: ReferencedQuizResponse, catalog: QuizReference[]): ModelQuiz {
  const { quiz } = inspectReferencedQuiz(value, catalog);
  return { ...quiz, items: quiz.items.map(q => ({ ...q, options: arrangeQuizOptions(q.options) })) };
}
