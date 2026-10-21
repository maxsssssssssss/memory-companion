import { randomInt } from "node:crypto";
import { ReferencedGeneratedQuiz, type ModelQuiz, type ReferencedQuizResponse } from "@/lib/domain/learning-quiz";
import { frameworkHash } from "./framework-repository";
import { inspectLiteralSetCardinality, parseFiniteSetAtoms, finiteSetLiteralKey, findFiniteSetLiterals } from "./quiz-set-cardinality";
import { hasQuizChoicePrefix, maskQuizEntities, quizEntityRanges } from "./quiz-entity-context";
import type { QuizCandidateReport } from "./quiz-delivery";

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
const positionDependent = /以上(?:全|都|皆|均|各|两|三)|上述(?:全|都|皆|均|各|两|三)|以下(?:全|都|皆|均)|(?:all|none|both) of (?:the )?(?:above|below)|(?:选项|答案|option|choice|选择|选|choose|select|正确项|错误项)\s*[A-Z]\b|\b[A-Z](?:项|正确|错误|准确|误将|将|说|是正确|是错误)/i;
// One complete-combination rule is used before binding and after binding as
// well as on stems/options. Never substitute only one side of a choice list.
const optionCombination = /\b[A-Z]项?\s*(?:和|与|及|、|或|and|or|&|[/／,，])\s*(?:(?:选项|option|choice)\s*)?[A-Z]项?(?![A-Za-z0-9_])/i;
function hasOrdinalChoice(text: string) {
  for (const match of text.matchAll(/第\s*[一二两三四五六七八九十百零〇\d]+\s*(?:个\s*)?(?:选项|项)/g)) {
    const after = text.slice(match.index! + match[0].length);
    if (match[0].endsWith("选项") || hasQuizChoicePrefix(text.slice(0, match.index))
      || /^\s*(?:(?:是|为|才是|应为)\s*)?(?:正确|错误|不正确|不准确|符合|不符合|可选)/.test(after)) return true;
  }
  return false;
}
const crossQuestion = /第\s*[一二三四五六七八九十\d]+\s*题|上(?:一)?题|前题|下(?:一)?题|previous question|next question/i;
export function hasQuizPositionDependency(text: string, context = "") {
  // Mask explicit entity names for detection only; never rewrite a saved explanation.
  // A leading question label is display numbering, not reliance on another
  // question. References such as "第2题的…" or a second reference remain checked.
  const body = text.replace(/^\s*(?:\[[^\]\r\n]+\]\s*)?第\s*[一二三四五六七八九十\d]+\s*题(?:\s*[:：、.]\s*|\s+(?!\s|的|中|所|里|给出|提到|答案|选项))/, "");
  const masked = maskQuizEntities(text, context);
  return crossQuestion.test(body) || hasOrdinalChoice(masked) || optionCombination.test(masked) || positionDependent.test(masked);
}

/** New-response explanations only: resolve explicit option identities to quoted
 * content before shuffling. Never apply this to stems, hints or saved history. */
export const QUIZ_REJECTION_DETAILS = {
  structure_or_evidence: "题目结构或解释与依据关联不完整",
  option_identity: "选项身份不完整或引用未知选项",
  position_dependency: "解析选项引用不明确：存在组合引用或序数位置依赖",
  answer_contradiction: "解析与答案矛盾：判定与正确选项ID不符",
  repeated_focus: "与已保留题的考点和情境重复",
} as const;
export type QuizRejectionReason = keyof typeof QUIZ_REJECTION_DETAILS;
type ExplanationInspection = { text: string; issue: null } | { text: null; issue: QuizRejectionReason };
export function inspectQuizOptionExplanation(text: string, options: Array<{ id: string; text: string }>, correctId: string, context = ""): ExplanationInspection {
  const byId = new Map(options.map(o => [o.id, o]));
  if (byId.size !== options.length || !byId.has(correctId)) return { text: null, issue: "option_identity" };
  const masked = maskQuizEntities(text, context);
  if (crossQuestion.test(text) || hasOrdinalChoice(masked) || optionCombination.test(masked)) return { text: null, issue: "position_dependency" };
  const protectedRanges = quizEntityRanges(text, context);
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
    if (!option) return { text: null, issue: "option_identity" };
    const after = text.slice(end);
    if (/^\s*[∩∪⊆⊂⊇⊃∈∉]/.test(after)) return { text: null, issue: "position_dependency" };
    const positive = groups.verdict === "正确项" || groups.label === "答案" || /^(?:\s*是)?\s*(?:正确|准确)(?!地)/.test(after);
    const negative = groups.verdict === "错误项" || /^(?:\s*是)?\s*(?:错误(?!地)|不正确|不准确)/.test(after);
    if ((positive && id !== correctId) || (negative && id === correctId)) return { text: null, issue: "answer_contradiction" };
    const prefix = groups.verdict === "正确项" ? "正确选项" : groups.verdict === "错误项" ? "错误选项" : "选项";
    pieces.push(text.slice(cursor, start), `${prefix}「${option.text}」`);
    cursor = end;
  }
  pieces.push(text.slice(cursor));
  const result = pieces.join("");
  return hasQuizPositionDependency(result, context) ? { text: null, issue: "position_dependency" } : { text: result, issue: null };
}
export function bindQuizOptionExplanation(text: string, options: Array<{ id: string; text: string }>, correctId: string, context = ""): string | null {
  return inspectQuizOptionExplanation(text, options, correctId, context).text;
}

// A bounded equality fence for explicit finite literal sets. The same parser
// owns literal identity for duplicate choices, equality and cardinality checks.
function literalSetContext(stem: string) {
  return /集合|交集|并集|补集|[∩∪⊆⊂⊇⊃∈∉]/.test(stem)
    && !/多重集|重集|multiset|序列|元组|数组|列表|字符串|JSON|代码|写法|字面|表示法/i.test(stem);
}
function replaceFiniteLiterals(text: string, key: (literal: string) => string) {
  let cursor = 0;
  const parts: string[] = [];
  for (const literal of findFiniteSetLiterals(text)) {
    parts.push(text.slice(cursor, literal.index), key(literal.text));
    cursor = literal.index + literal.text.length;
  }
  return [...parts, text.slice(cursor)].join("");
}
function optionContentKey(text: string, setContext: boolean) {
  // Typed atom keys retain element identity (including letter case), even when
  // ordinary prose outside the literals is normalized for duplicate detection.
  const literal = setContext && parseFiniteSetAtoms(text) !== null ? finiteSetLiteralKey(text)!
    : setContext ? replaceFiniteLiterals(text, value => finiteSetLiteralKey(value)!) : text;
  return literal.replace(/\s/g, "").toLowerCase();
}
function contradictsLiteralSetEquality(stem: string, answer: string) {
  if (/错误|不正确|不成立|不符合/.test(stem)) return false;
  const ownSets = findFiniteSetLiterals(answer);
  if (ownSets.length === 2 && finiteSetLiteralKey(ownSets[0].text) === finiteSetLiteralKey(ownSets[1].text)) {
    const relation = replaceFiniteLiterals(answer, () => "集合值").replace(/\s/g, "");
    if (/^集合值(?:≠|!=|不等于)集合值[。.]?$/.test(relation)
      || /^集合值(?:和|与|、)集合值(?:是)?(?:不同(?:的集合)?|不相等|不是同一集合)[。.]?$/.test(relation)) return true;
  }
  const contextSets = findFiniteSetLiterals(stem);
  return contextSets.length === 2 && finiteSetLiteralKey(contextSets[0].text) === finiteSetLiteralKey(contextSets[1].text)
    && /^(?:这|上述|题中)?(?:两个集合|两者|二者)(?:是)?(?:不同(?:的集合)?|不相等|不是同一集合)[。.]?$/.test(answer.replace(/\s/g, ""));
}

/** Shared inspection for candidate selection and the final publication fence.
 * It neither changes display order nor infers missing semantic evidence. */
function inspectReferencedQuiz(value: ReferencedQuizResponse, catalog: QuizReference[]) {
  const references = new Map(catalog.map(r => [r.referenceId, r]));
  const items: ModelQuiz["items"] = [], rejected: string[] = [];
  const acceptedIndexes: number[] = [];
  const diagnostics: QuizCandidateReport = { candidates: value.items.length, rejected: [] };
  const stems = new Set<string>();
  for (const [index, raw] of value.items.entries()) {
    const reject = (reason: string, code: QuizCandidateReport["rejected"][number]["code"]) => {
      rejected.push(`第 ${index + 1} 题${reason}`);
      diagnostics.rejected.push({ index, code });
    };
    const checked = ReferencedGeneratedQuiz.shape.items.element.safeParse(raw);
    if (!checked.success) {
      // Local composition diagnostics survive candidate filtering/publication;
      // a rejected marker can only reject, never bypass the question schema.
      const marker = raw as { compositionRejected?: unknown; compactReferenceRejected?: unknown; reviewCheckRejected?: unknown; rejectionReason?: unknown } | null;
      const reason = marker?.compositionRejected === true && typeof marker.rejectionReason === "string"
        && Object.hasOwn(QUIZ_REJECTION_DETAILS, marker.rejectionReason) ? marker.rejectionReason as QuizRejectionReason : null;
      const reviewReason = marker?.reviewCheckRejected === true && ["annotation_schema", "annotation_role", "annotation_objective", "annotation_missing", "review_source_mismatch"].includes(String(marker.rejectionReason))
        ? marker.rejectionReason as QuizCandidateReport["rejected"][number]["code"] : "goal_mismatch";
      reject(`${reason ? QUIZ_REJECTION_DETAILS[reason] : marker?.reviewCheckRejected === true ? "本次检查说明未通过关联检查" : "题目结构或依据ID格式不合法"}，未发布`,
        reason ?? (marker?.reviewCheckRejected === true ? reviewReason
          : marker?.compactReferenceRejected === true && marker.rejectionReason === "source_binding" ? "source_binding" : "structure_or_evidence")); continue;
    }
    const q = checked.data;
    const { scenario, ...question } = q;
    const fullStem = scenario ? `${scenario}\n\n${q.stem}` : q.stem;
    const stem = fullStem.replace(/\s/g, "").toLowerCase();
    if (stems.has(stem)) { reject("重复，未发布", "repeated_focus"); continue; }
    if (new Set(q.options.map(o => o.id)).size !== q.options.length || !q.options.some(o => o.id === q.correctOptionId)) {
      reject(`${QUIZ_REJECTION_DETAILS.option_identity}，未发布`, "option_identity"); continue;
    }
    if (new Set(q.options.map(o => optionContentKey(o.text, literalSetContext(fullStem)))).size !== q.options.length) {
      reject("选项重复：文本相同或显式集合值等价，未发布", "equivalent_options"); continue;
    }
    if ([scenario ?? "", q.stem, q.explanation, q.hint ?? "", ...q.options.flatMap(o => [o.text, o.reason])].some(text => hasQuizPositionDependency(text, fullStem))) {
      reject(`${QUIZ_REJECTION_DETAILS.position_dependency}，未发布`, "position_dependency"); continue;
    }
    if (literalSetContext(fullStem) && contradictsLiteralSetEquality(fullStem, q.options.find(o => o.id === q.correctOptionId)!.text)) {
      reject("正确项与显式有限集合的相等关系矛盾，未发布", "answer_contradiction"); continue;
    }
    const cardinality = inspectLiteralSetCardinality(fullStem, q.options, q.correctOptionId);
    if (cardinality.status === "invalid") {
      const reason = cardinality.code === "multiple_answers" ? "答案不唯一：多个选项符合显式有限集合的元素个数"
        : cardinality.code === "no_answer" ? "无正确答案：没有选项符合显式有限集合的元素个数"
        : "答案矛盾：正确选项ID与显式有限集合的元素个数不符";
      reject(`${reason}，未发布`, cardinality.code === "incorrect_answer" ? "answer_contradiction" : "answer_not_unique"); continue;
    }
    const used = [...new Set([...q.stemEvidenceIds, ...q.explanationEvidenceIds, ...q.options.flatMap(o => o.evidenceIds)])];
    if (used.some(id => !references.has(id))) {
      reject("依据不在所选范围或依据关联缺失，未发布", "source_binding"); continue;
    }
    // No model-created alias or repeated quote: evidence is the exact selected paragraph/block.
    const evidence = used.map(id => ({ id, referenceId: id, source: references.get(id)!.source, quote: references.get(id)!.text }));
    const sources = [...new Map(evidence.map(e => [JSON.stringify(e.source), e.source])).values()];
    items.push({ ...question, stem: fullStem, options: q.options, sources, evidence, hint: q.hint ? quizProceduralHint(q.kind) : null });
    acceptedIndexes.push(index);
    stems.add(stem);
  }
  return { acceptedIndexes, rejected, diagnostics, quiz: { title: value.title, reason: [value.reason, rejected.length ? `发布检查排除 ${rejected.length} 题：${rejected.join("；")}。实际保留 ${items.length} 题，未补调用。` : null].filter(Boolean).join("\n") || null, items } };
}

/** Bounded local diagnosis only: no question, answer, rationale or source body. */
export function inspectQuizCandidateDelivery(value: ReferencedQuizResponse, catalog: QuizReference[]): QuizCandidateReport {
  return inspectReferencedQuiz(value, catalog).diagnostics;
}

/** Surplus candidates are inspected before selecting in model order. Invalid
 * early items must not hide a valid later candidate or fail the entire group. */
export function limitReferencedQuizCandidates(value: ReferencedQuizResponse, catalog: QuizReference[], count: number): ReferencedQuizResponse {
  const inspected = inspectReferencedQuiz(value, catalog);
  const selected = inspected.acceptedIndexes.slice(0, count);
  const omitted = inspected.acceptedIndexes.length - selected.length;
  return { ...value, items: selected.map(index => value.items[index]),
    reason: [value.reason, inspected.rejected.length ? `发布检查排除 ${inspected.rejected.length} 题：${inspected.rejected.join("；")}。` : null,
      `模型返回 ${value.items.length} 个候选题，本组按设置保留 ${selected.length} 题${omitted > 0 ? `，另有 ${omitted} 个候选未加入本组` : ""}，未追加生成。`].filter(Boolean).join("\n") || null };
}

/** Resolve explicit IDs only. Arrange once, immediately before persistence. */
export function resolveReferencedQuiz(value: ReferencedQuizResponse, catalog: QuizReference[]): ModelQuiz {
  const { quiz } = inspectReferencedQuiz(value, catalog);
  return { ...quiz, items: quiz.items.map(q => ({ ...q, options: arrangeQuizOptions(q.options) })) };
}
