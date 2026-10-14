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
const optionPrefix = /(?:选项|答案|option|choice|正确项|错误项|选择|选|choose|select)\s*[:：]?\s*(?:(?:中(?:的)?|分别(?:是|为)|是|为)\s*[:：]?\s*)?$/i;
const crossQuestion = /第\s*[一二三四五六七八九十\d]+\s*题|上(?:一)?题|前题|下(?:一)?题|previous question|next question/i;
function quizLiteralRanges(text: string) {
  const entity = /(?:方案|计划|组别|类型|模型|区域|\bplan\b|\bgroup\b|\bcase\b)\s*[A-Z](?:\s*(?:和|与|及|、|或|and|or|&)\s*[A-Z])?|\b[A-Z]\s*(?:组|队|型|类|区|站)/gi;
  const ranges = [...text.matchAll(entity)].map(m => [m.index!, m.index! + m[0].length]);
  // These are explicit mathematical expressions or typed set entities, not
  // bare letters. In particular, do not match "B 和 A" across A∩B 和 A∪B.
  // A choice prefix/suffix always wins; naming sets cannot excuse "选项A和B".
  const sets = /\b[A-Z](?:\s*[∩∪⊆⊂⊇⊃∈∉]\s*[A-Z])+\b|集合\s*[A-Z](?:\s*(?:和|与|及|、|或|and|or|&)\s*[A-Z])*|\b[A-Z](?:\s*(?:和|与|及|、|或|and|or|&)\s*[A-Z])+\s*(?:(?:都|均)?(?:是|为)(?:(?:非空|空|有限|无限)?集合|非空集|空集)|的(?:元素|交集|并集|补集))/g;
  for (const m of text.matchAll(sets)) {
    const end = m.index! + m[0].length;
    if (!optionPrefix.test(text.slice(0, m.index)) && !/^\s*(?:项|选项)/.test(text.slice(end))) ranges.push([m.index!, end]);
  }
  // Explicit alphabet enumerations containing letters outside the option-ID
  // alphabet are content (e.g. an acronym's letters), not choice combinations.
  // This does not whitelist a sample name or exempt bare A/B combinations.
  const letters = /\b([A-Z](?:\s*[、,，]\s*[A-Z])+)\s*(?:[一二三四五六七八九十\d]+\s*个)?\s*(?:字母|letters?\b)/gi;
  for (const m of text.matchAll(letters)) {
    if (!optionPrefix.test(text.slice(0, m.index)) && /[G-Z]/i.test(m[1])) ranges.push([m.index!, m.index! + m[0].length]);
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
  // A leading question label is display numbering, not reliance on another
  // question. References such as "第2题的…" or a second reference remain checked.
  const body = text.replace(/^\s*(?:\[[^\]\r\n]+\]\s*)?第\s*[一二三四五六七八九十\d]+\s*题(?:\s*[:：、.]\s*|\s+(?!\s|的|中|所|里|给出|提到|答案|选项))/, "");
  return crossQuestion.test(body) || positionDependent.test(maskQuizLiterals(text));
}

/** New-response explanations only: resolve explicit option identities to quoted
 * content before shuffling. Never apply this to stems, hints or saved history. */
export function bindQuizOptionExplanation(text: string, options: Array<{ id: string; text: string }>, correctId: string): string | null {
  const byId = new Map(options.map(o => [o.id, o]));
  if (byId.size !== options.length || !byId.has(correctId) || crossQuestion.test(text)) return null;
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
    const groups = match.groups!, id = groups.verdictId ?? groups.labelId ?? groups.bareId;
    const option = byId.get(id);
    if (!option) return null;
    const after = text.slice(end);
    if (/^\s*[∩∪⊆⊂⊇⊃∈∉]/.test(after)) return null;
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

// A deliberately small equality fence for explicit integer-set literals. It
// detects reordered/repeated members, not algebra, set builders, cardinality
// questions, general mathematical truth or citation sufficiency.
const integerSet = /\{\s*(?:[+-]?\d+(?:\s*[,，、]\s*[+-]?\d+)*)?\s*\}/g;
function integerSetKey(literal: string) {
  return `{${[...new Set((literal.match(/[+-]?\d+/g) ?? []).map(n => BigInt(n).toString()))].sort().join(",")}}`;
}
function literalSetContext(stem: string) {
  return /集合|交集|并集|补集|[∩∪⊆⊂⊇⊃∈∉]/.test(stem)
    && !/多重集|重集|multiset|序列|元组|数组|列表|字符串|JSON|代码|写法|字面|表示法/i.test(stem);
}
function optionContentKey(text: string, setContext: boolean) {
  return (setContext ? text.replace(integerSet, integerSetKey) : text).replace(/\s/g, "").toLowerCase();
}
function contradictsLiteralSetEquality(stem: string, answer: string) {
  // An incorrect-statement question may intentionally choose an inequality.
  if (/错误|不正确|不成立|不符合/.test(stem)) return false;
  const ownSets = [...answer.matchAll(integerSet)];
  if (ownSets.length === 2 && integerSetKey(ownSets[0][0]) === integerSetKey(ownSets[1][0])) {
    const relation = answer.replace(integerSet, "集合值").replace(/\s/g, "");
    if (/^集合值(?:≠|!=|不等于)集合值[。.]?$/.test(relation)
      || /^集合值(?:和|与|、)集合值(?:是)?(?:不同(?:的集合)?|不相等|不是同一集合)[。.]?$/.test(relation)) return true;
  }
  const contextSets = [...stem.matchAll(integerSet)];
  return contextSets.length === 2 && integerSetKey(contextSets[0][0]) === integerSetKey(contextSets[1][0])
    && /^(?:这|上述|题中)?(?:两个集合|两者|二者)(?:是)?(?:不同(?:的集合)?|不相等|不是同一集合)[。.]?$/.test(answer.replace(/\s/g, ""));
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
      || new Set(q.options.map(o => optionContentKey(o.text, literalSetContext(fullStem)))).size !== q.options.length
      || [scenario ?? "", q.stem, q.explanation, q.hint ?? "", ...q.options.flatMap(o => [o.text, o.reason])].some(hasQuizPositionDependency)) {
      reject("选项重复、身份不完整或依赖排列位置，未发布"); continue;
    }
    if (literalSetContext(fullStem) && contradictsLiteralSetEquality(fullStem, q.options.find(o => o.id === q.correctOptionId)!.text)) {
      reject("正确项与显式整数集合的相等关系矛盾，未发布"); continue;
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
