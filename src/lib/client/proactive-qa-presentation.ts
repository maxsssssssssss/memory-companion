import { z } from "zod";

import {
  ProactiveEvidenceSchema,
  ProactiveInsightScopeSchema,
  ProactiveReflectionTypeSchema,
  type ProactiveInsight
} from "@/lib/domain/proactive-insights";
import { proactiveInsightHasAbstractLanguage } from "@/lib/domain/proactive-insight-quality";

import type { ProactiveQaSuggestion } from "./proactive-qa-suggestions";

const DEFAULT_LIMIT = 3;
const FORBIDDEN_PATTERN = /渣男|渣女|操控|有病|应该分手|人格|心理诊断|诊断/iu;
const OBSERVATION_QUESTION_PATTERN = /[?？]|你是否|你们后来|请问/iu;
const SECOND_PERSON_QUESTION_PATTERN = /你|请问/iu;
const QUESTION_INTENT_PATTERN = /[?？]|有没有|是否|什么|哪些|哪一|哪段|如何|怎么|为什么|吗|呢/iu;

const UserVoiceQuestionSchema = z
  .string()
  .trim()
  .min(1)
  .max(280)
  .refine((value) => QUESTION_INTENT_PATTERN.test(value), "Suggested question must be a question")
  .refine((value) => !SECOND_PERSON_QUESTION_PATTERN.test(value), "Suggested question must use the user's voice")
  .refine((value) => !FORBIDDEN_PATTERN.test(value), "Suggested question contains unsafe language");

const ObservationContentSchema = z
  .string()
  .trim()
  .min(1)
  .max(280)
  .refine((value) => !OBSERVATION_QUESTION_PATTERN.test(value), "Observation must be a statement")
  .refine((value) => !FORBIDDEN_PATTERN.test(value), "Observation contains unsafe language");

export const ProactiveObservationSchema = z
  .object({
    id: z.string().min(1).max(120),
    type: ProactiveReflectionTypeSchema,
    title: z.string().trim().min(1).max(40),
    content: ObservationContentSchema,
    evidenceRefs: z.array(ProactiveEvidenceSchema).min(1).max(4),
    scope: ProactiveInsightScopeSchema,
    relatedQuestions: z.array(UserVoiceQuestionSchema).max(3),
    memoryAware: z.boolean().optional(),
    caution: z.string().trim().min(1).max(240).optional()
  })
  .strict();

export const SuggestedQuestionSchema = z
  .object({
    id: z.string().min(1).max(160),
    question: UserVoiceQuestionSchema,
    scope: ProactiveInsightScopeSchema,
    relatedObservationId: z.string().min(1).max(120).optional(),
    reason: z.string().trim().min(1).max(360).optional(),
    category: z.enum(["summary", "relationship", "tone", "follow_up", "memory"]).optional(),
    sourceType: z.enum(["brief", "timeline", "audio_insight", "relationship_signal", "memory", "fallback"]),
    sourceIds: z.array(z.string().min(1).max(512)).max(8),
    sourceUploadIds: z.array(z.string().min(1).max(120)).max(31)
  })
  .strict();

export type ProactiveObservation = z.infer<typeof ProactiveObservationSchema>;
export type SuggestedQuestion = z.infer<typeof SuggestedQuestionSchema>;

export type ProactiveQaPresentation = {
  observations: ProactiveObservation[];
  suggestedQuestions: SuggestedQuestion[];
};

function normalizedQuestionKey(question: string) {
  return question
    .toLowerCase()
    .replace(/[\s?？!！,，。:：;；'"“”‘’]/gu, "")
    .trim();
}

export function normalizeSuggestedQuestionText(question: string) {
  return question
    .trim()
    .replace(/你们/gu, "我们")
    .replace(/你的/gu, "我的")
    .replace(/建议你/gu, "我可以")
    .replace(/你/gu, "我");
}

function sourceTypeForInsight(insight: ProactiveInsight): SuggestedQuestion["sourceType"] {
  const sourceTypes = [...new Set(insight.evidenceRefs.map((evidence) => evidence.sourceType))];
  if (sourceTypes.length !== 1) {
    return "memory";
  }

  return sourceTypes[0] === "semantic_segment" ? "timeline" : sourceTypes[0];
}

function titleForInsight(insight: ProactiveInsight) {
  if (insight.insightType === "reminder" || insight.insightType === "follow_up") {
    return "可以确认";
  }
  if (insight.insightType === "pattern_observation") {
    return "值得关注";
  }
  return "一个小发现";
}

function reflectionTypeForInsight(insight: ProactiveInsight): ProactiveObservation["type"] {
  if (insight.insightType) {
    return insight.insightType;
  }
  if (insight.type === "unresolved_issue" || insight.type === "follow_up_question") {
    return "follow_up";
  }
  if (insight.type === "memory_pattern") {
    return "pattern_observation";
  }
  return insight.type === "relationship_question" ? "reminder" : "reflection";
}

function memoryAwareForInsight(insight: ProactiveInsight) {
  const currentEvidenceUploadIds = new Set(insight.evidenceRefs.map((evidence) => evidence.uploadId));
  return insight.sourceUploadIds.some((uploadId) => !currentEvidenceUploadIds.has(uploadId));
}

function observationFromInsight(insight: ProactiveInsight, relatedQuestion?: string) {
  const parsed = ProactiveObservationSchema.safeParse({
    id: insight.id,
    type: reflectionTypeForInsight(insight),
    title: titleForInsight(insight),
    content: insight.observation,
    evidenceRefs: insight.evidenceRefs,
    scope: insight.scope,
    relatedQuestions: relatedQuestion ? [relatedQuestion] : [],
    memoryAware: memoryAwareForInsight(insight),
    caution: insight.caution
  });
  return parsed.success ? parsed.data : null;
}

function questionFromInsight(insight: ProactiveInsight, relatedObservationId?: string) {
  const parsed = SuggestedQuestionSchema.safeParse({
    id: `${insight.id}_question`,
    question: normalizeSuggestedQuestionText(insight.question),
    scope: insight.scope,
    relatedObservationId,
    reason: insight.reason,
    category: insight.category,
    sourceType: sourceTypeForInsight(insight),
    sourceIds: [...new Set(insight.evidenceRefs.map((evidence) => evidence.sourceId))],
    sourceUploadIds: insight.sourceUploadIds
  });
  return parsed.success ? parsed.data : null;
}

function questionFromRule(suggestion: ProactiveQaSuggestion) {
  const parsed = SuggestedQuestionSchema.safeParse({
    id: suggestion.id,
    question: normalizeSuggestedQuestionText(suggestion.question),
    scope: suggestion.scope,
    reason: suggestion.reason,
    category: suggestion.category,
    sourceType: suggestion.sourceType,
    sourceIds: suggestion.sourceIds,
    sourceUploadIds: suggestion.sourceUploadIds
  });
  return parsed.success ? parsed.data : null;
}

function questionsAreDuplicates(left: SuggestedQuestion, right: SuggestedQuestion) {
  if (normalizedQuestionKey(left.question) === normalizedQuestionKey(right.question)) {
    return true;
  }
  if (left.category !== right.category) {
    return false;
  }
  const leftSourceIds = new Set(left.sourceIds);
  return right.sourceIds.some((sourceId) => leftSourceIds.has(sourceId));
}

export function buildProactiveQaPresentation(input: {
  agentInsights: ProactiveInsight[];
  ruleSuggestions: ProactiveQaSuggestion[];
  observationLimit?: number;
  questionLimit?: number;
}): ProactiveQaPresentation {
  const observationLimit = Math.min(DEFAULT_LIMIT, Math.max(0, input.observationLimit ?? DEFAULT_LIMIT));
  const questionLimit = Math.min(DEFAULT_LIMIT, Math.max(0, input.questionLimit ?? DEFAULT_LIMIT));
  const observations: ProactiveObservation[] = [];
  const suggestedQuestions: SuggestedQuestion[] = [];
  const agentInsights = input.agentInsights.filter((insight) => !proactiveInsightHasAbstractLanguage(insight));

  for (const insight of agentInsights) {
    const normalizedQuestion = normalizeSuggestedQuestionText(insight.question);
    const questionWithoutObservation = questionFromInsight(insight);
    const observation = observationFromInsight(insight, questionWithoutObservation?.question);
    const question = questionFromInsight(insight, observation?.id);

    if (observation && observations.length < observationLimit) {
      observations.push(observation);
    }
    if (question && !suggestedQuestions.some((accepted) => questionsAreDuplicates(accepted, question))) {
      suggestedQuestions.push(question);
    }
  }

  for (const ruleSuggestion of input.ruleSuggestions) {
    if (suggestedQuestions.length >= questionLimit) {
      break;
    }
    const question = questionFromRule(ruleSuggestion);
    if (question && !suggestedQuestions.some((accepted) => questionsAreDuplicates(accepted, question))) {
      suggestedQuestions.push(question);
    }
  }

  return {
    observations: observations.slice(0, observationLimit),
    suggestedQuestions: suggestedQuestions.slice(0, questionLimit)
  };
}
