import { createHash } from "node:crypto";

import {
  ProactiveInsightSchema,
  ProactiveInsightRawItemSchema,
  type ProactiveEvidence,
  type ProactiveInsight,
  type ProactiveInsightContext,
  type ProactiveReflectionType
} from "@/lib/domain/proactive-insights";
import { proactiveInsightHasAbstractLanguage } from "@/lib/domain/proactive-insight-quality";
import type { ProactiveInsightMemoryContext, ProactiveMemoryItem } from "./memory-context";
import { rankProactiveInsights } from "./ranking";

const MIN_CONFIDENCE = 0.45;
const crossRangePattern = /长期|一直|反复|重复|每次|总是|经常|通常|趋势|模式|long[- ]term|always|usually|often|every time|trend|pattern|repeatedly/i;
const absoluteHistoricalPattern =
  /他一直|她一直|对方一直|他就是|她就是|对方就是|长期来看一定|一定是长期|本质上就是|天生就是|permanent conclusion|always is/i;
const historicalReferencePattern = /之前|过去|此前|历史|已有记忆|再次|重复|又一次|previous|earlier|historical|existing memory|again|repeat/i;
const commitmentJudgmentPattern =
  /没有履行承诺|未履行承诺|违约|食言|背弃承诺|failed to keep (?:a |the )?promise|broke (?:a |the )?promise|breach of commitment/i;
const forbiddenPattern =
  /渣男|渣女|有病|人格定性|心理诊断|应该分手|必须分手|一定在操控|PUA|自恋型人格|人格障碍|他就是|她就是|对方就是|长期来看一定|diagnosis|diagnostic|personality disorder|break up with|should break up|must break up|narcissistic personality/i;
const ENGLISH_GROUNDING_STOP_WORDS = new Set([
  "about",
  "again",
  "conversation",
  "current",
  "evidence",
  "followup",
  "interaction",
  "memory",
  "question",
  "record",
  "relationship",
  "specific",
  "there",
  "these",
  "thing",
  "those",
  "today",
  "worth"
]);
const HAN_GROUNDING_STOP_WORDS = new Set([
  "一个",
  "之前",
  "什么",
  "关系",
  "出现",
  "可以",
  "双方",
  "后来",
  "当前",
  "已经",
  "怎么",
  "是否",
  "记录",
  "证据",
  "这个",
  "这些",
  "这次",
  "过去",
  "还有",
  "互动",
  "问题",
  "需要",
  "值得"
]);

export type ProactiveInsightRejectionReason =
  | "invalid_schema"
  | "low_confidence"
  | "forbidden_text"
  | "unknown_evidence"
  | "missing_current_evidence"
  | "missing_memory_evidence"
  | "cross_scope_evidence"
  | "scope_guard"
  | "commitment_judgment"
  | "abstract_language"
  | "ungrounded_text"
  | "missing_caution"
  | "duplicate_question";

export function summarizeProactiveInsightSchemaIssues(error: {
  issues: Array<{ path: Array<string | number>; code: string }>;
}) {
  return Array.from(
    new Set(
      error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "item";
        return `${path}:${issue.code}`;
      })
    )
  )
    .sort()
    .join("|")
    .slice(0, 240);
}

function normalizeQuestion(question: string) {
  return question.replace(/\s+/g, " ").trim().toLowerCase();
}

function deterministicInsightId(context: ProactiveInsightContext, evidenceIds: string[], question: string, index: number) {
  const value = `${context.scope}|${context.referenceDate}|${evidenceIds.join(",")}|${normalizeQuestion(question)}|${index}`;
  return `pi_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function collectCaution(
  evidenceRefs: ProactiveEvidence[],
  memoryRefs: ProactiveMemoryItem[],
  modelCaution?: string
) {
  const relationshipRiskRefs = evidenceRefs.filter(
    (item) => item.kind === "relationship_signal" && item.signalCategory && item.signalCategory !== "positive"
  );
  if (relationshipRiskRefs.some((item) => !item.caution?.trim())) {
    return null;
  }
  const cautionValues = [modelCaution?.trim(), ...relationshipRiskRefs.map((item) => item.caution?.trim())]
    .filter((value): value is string => Boolean(value));

  if (memoryRefs.length > 0) {
    const memoryDates = new Set(memoryRefs.flatMap((memory) => memory.dates));
    cautionValues.push(
      memoryDates.size >= 2
        ? "结合多个日期的历史证据进行观察，仍不能据此推断长期模式或人格结论。"
        : "过去曾出现类似情况，可以进一步关注；现有历史证据不足以支持长期结论。"
    );
  }

  const unique = Array.from(new Set(cautionValues));
  return unique.length > 0
    ? unique.join(" ")
    : "这是基于当前记录的复盘提示，仍需要结合完整上下文进一步确认。";
}

function insightText(rawItem: { observation: string; question: string; reason: string; caution?: string }) {
  return `${rawItem.observation}\n${rawItem.question}\n${rawItem.reason}\n${rawItem.caution ?? ""}`;
}

function textIsForbidden(rawItem: { observation: string; question: string; reason: string; caution?: string }) {
  return forbiddenPattern.test(insightText(rawItem));
}

function normalizedEnglishToken(token: string) {
  const value = token.toLowerCase();
  if (value.length > 5 && value.endsWith("ing")) {
    return value.slice(0, -3);
  }
  if (value.length > 4 && value.endsWith("ed")) {
    return value.slice(0, -2);
  }
  if (value.length > 4 && value.endsWith("s")) {
    return value.slice(0, -1);
  }
  return value;
}

function englishGroundingTokens(value: string) {
  return new Set(
    (value.normalize("NFKC").toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])
      .map(normalizedEnglishToken)
      .filter((token) => token.length >= 4 && !ENGLISH_GROUNDING_STOP_WORDS.has(token))
  );
}

function hanGroundingTokens(value: string) {
  const tokens = new Set<string>();
  const runs = value.normalize("NFKC").match(/[\p{Script=Han}]{2,}/gu) ?? [];
  for (const run of runs) {
    for (let length = 2; length <= Math.min(3, run.length); length += 1) {
      for (let index = 0; index <= run.length - length; index += 1) {
        const token = run.slice(index, index + length);
        if (!HAN_GROUNDING_STOP_WORDS.has(token)) {
          tokens.add(token);
        }
      }
    }
  }
  return tokens;
}

function setsOverlap(left: Set<string>, right: Set<string>) {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

function textIsGrounded(
  item: { observation: string; question: string; reason: string },
  evidenceRefs: ProactiveEvidence[],
  memoryRefs: ProactiveMemoryItem[]
) {
  const candidateText = `${item.observation}\n${item.question}\n${item.reason}`;
  const sourceText = [
    ...evidenceRefs.flatMap((evidence) => [evidence.title, evidence.summary, evidence.excerpt]),
    ...memoryRefs.flatMap((memory) => [
      memory.title,
      memory.summary,
      ...memory.evidence.map((evidence) => evidence.excerpt)
    ])
  ].join("\n");
  const candidateHan = hanGroundingTokens(candidateText);
  const sourceHan = hanGroundingTokens(sourceText);
  const candidateEnglish = englishGroundingTokens(candidateText);
  const sourceEnglish = englishGroundingTokens(sourceText);
  let comparable = false;

  if (candidateHan.size > 0 && sourceHan.size > 0) {
    comparable = true;
    if (setsOverlap(candidateHan, sourceHan)) {
      return true;
    }
  }
  if (candidateEnglish.size > 0 && sourceEnglish.size > 0) {
    comparable = true;
    if (setsOverlap(candidateEnglish, sourceEnglish)) {
      return true;
    }
  }

  // Cross-language paraphrases cannot be checked reliably without another model call.
  return !comparable;
}

function deriveInsightType(type: string): ProactiveReflectionType {
  if (type === "unresolved_issue") {
    return "reminder";
  }
  if (type === "follow_up_question") {
    return "follow_up";
  }
  if (type === "memory_pattern") {
    return "pattern_observation";
  }
  return "reflection";
}

function violatesCurrentScopeGuard(
  scope: ProactiveInsightContext["scope"],
  rawItem: { type: string; observation: string; question: string; reason: string },
  insightType: ProactiveReflectionType,
  evidenceRefs: ProactiveEvidence[],
  memoryRefs: ProactiveMemoryItem[]
) {
  if (scope !== "current") {
    return false;
  }
  if (rawItem.type === "memory_pattern") {
    return true;
  }

  const text = `${rawItem.observation}\n${rawItem.question}\n${rawItem.reason}`;
  if (absoluteHistoricalPattern.test(text)) {
    return true;
  }
  const evidenceDates = new Set([
    ...evidenceRefs.map((evidence) => evidence.recordingDate),
    ...memoryRefs.flatMap((memory) => memory.dates)
  ]);
  if (insightType === "pattern_observation") {
    return evidenceDates.size < 2;
  }
  if (!crossRangePattern.test(text)) {
    return false;
  }
  return memoryRefs.length === 0 || evidenceDates.size < 2;
}

function evidenceMatchesContext(context: ProactiveInsightContext, evidence: ProactiveEvidence) {
  return (
    evidence.sourceSegmentIds.length > 0 &&
    context.sourceUploadIds.includes(evidence.uploadId) &&
    context.distinctDates.includes(evidence.recordingDate)
  );
}

export function validateProactiveInsights(input: {
  context: ProactiveInsightContext;
  memoryContext?: ProactiveInsightMemoryContext;
  rawItems: unknown;
  createdAt?: string;
  maxItems?: number;
  onReject?: (reason: ProactiveInsightRejectionReason, detail?: string) => void;
}): ProactiveInsight[] {
  const rawItems = Array.isArray(input.rawItems) ? input.rawItems : [];
  const evidenceById = new Map(input.context.evidence.map((item) => [item.evidenceId, item]));
  const memoryContextMatches =
    input.memoryContext?.scope === input.context.scope &&
    input.context.sourceUploadIds.includes(input.memoryContext.currentUploadId);
  const memoryById = new Map(
    memoryContextMatches
      ? input.memoryContext?.memories.map((memory) => [memory.evidenceId, memory] as const) ?? []
      : []
  );
  const maxItems = input.maxItems ?? 3;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const usedQuestions = new Set<string>();
  const accepted: ProactiveInsight[] = [];

  for (const rawItem of rawItems) {
    const parsed = ProactiveInsightRawItemSchema.safeParse(rawItem);
    if (!parsed.success) {
      input.onReject?.("invalid_schema", summarizeProactiveInsightSchemaIssues(parsed.error));
      continue;
    }

    const item = parsed.data;
    if (item.confidence < MIN_CONFIDENCE) {
      input.onReject?.("low_confidence");
      continue;
    }
    if (textIsForbidden(item)) {
      input.onReject?.("forbidden_text");
      continue;
    }
    if (commitmentJudgmentPattern.test(insightText(item))) {
      input.onReject?.("commitment_judgment");
      continue;
    }
    if (proactiveInsightHasAbstractLanguage(item)) {
      input.onReject?.("abstract_language");
      continue;
    }

    const explicitMemoryRefIds = item.memoryRefs ?? [];
    const legacyMemoryRefIds = item.evidenceIds.filter((evidenceId) => memoryById.has(evidenceId));
    const currentEvidenceIds = item.evidenceIds.filter((evidenceId) => evidenceById.has(evidenceId));
    const unknownEvidenceIds = item.evidenceIds.filter(
      (evidenceId) => !evidenceById.has(evidenceId) && !memoryById.has(evidenceId)
    );
    const unknownMemoryRefs = explicitMemoryRefIds.filter((memoryRef) => !memoryById.has(memoryRef));
    if (unknownEvidenceIds.length > 0 || unknownMemoryRefs.length > 0) {
      input.onReject?.("unknown_evidence");
      continue;
    }

    const memoryRefIds = Array.from(new Set([...legacyMemoryRefIds, ...explicitMemoryRefIds]));
    const evidenceRefs = currentEvidenceIds
      .map((evidenceId) => evidenceById.get(evidenceId))
      .filter((evidence): evidence is ProactiveEvidence => Boolean(evidence));
    const memoryRefs = memoryRefIds
      .map((evidenceId) => memoryById.get(evidenceId))
      .filter((memory): memory is ProactiveMemoryItem => Boolean(memory));
    if (evidenceRefs.length === 0) {
      input.onReject?.("missing_current_evidence");
      continue;
    }
    if (evidenceRefs.some((evidence) => !evidenceMatchesContext(input.context, evidence))) {
      input.onReject?.("cross_scope_evidence");
      continue;
    }
    if (
      historicalReferencePattern.test(insightText(item)) &&
      memoryRefs.length === 0
    ) {
      input.onReject?.("missing_memory_evidence");
      continue;
    }
    const insightType = item.insightType ?? deriveInsightType(item.type);
    if (violatesCurrentScopeGuard(input.context.scope, item, insightType, evidenceRefs, memoryRefs)) {
      input.onReject?.("scope_guard");
      continue;
    }
    if (!textIsGrounded(item, evidenceRefs, memoryRefs)) {
      input.onReject?.("ungrounded_text");
      continue;
    }

    const caution = collectCaution(evidenceRefs, memoryRefs, item.caution);
    if (caution === null) {
      input.onReject?.("missing_caution");
      continue;
    }

    const normalizedQuestion = normalizeQuestion(item.question);
    if (usedQuestions.has(normalizedQuestion)) {
      input.onReject?.("duplicate_question");
      continue;
    }
    usedQuestions.add(normalizedQuestion);

    const insight = ProactiveInsightSchema.parse({
      id: deterministicInsightId(input.context, item.evidenceIds, item.question, accepted.length),
      scope: input.context.scope,
      type: item.type,
      insightType,
      category: item.category,
      observation: item.observation.trim(),
      question: item.question.trim(),
      reason: item.reason.trim(),
      confidence: item.confidence,
      evidenceRefs,
      memoryRefs: memoryRefIds,
      sourceUploadIds: Array.from(
        new Set([
          ...evidenceRefs.map((evidence) => evidence.uploadId),
          ...memoryRefs.flatMap((memory) => memory.sourceUploadIds)
        ])
      ).slice(0, 4),
      caution,
      createdAt
    });
    accepted.push(insight);
  }

  return rankProactiveInsights(accepted, input.memoryContext).slice(0, maxItems);
}
