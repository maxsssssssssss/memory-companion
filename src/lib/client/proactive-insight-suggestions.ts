import type { ProactiveInsight } from "@/lib/domain/proactive-insights";
import { proactiveInsightHasAbstractLanguage } from "@/lib/domain/proactive-insight-quality";

import type { ProactiveQaSuggestion } from "./proactive-qa-suggestions";

const DEFAULT_LIMIT = 3;
const DEFAULT_AGENT_LIMIT = 3;

function normalizedQuestion(question: string) {
  return question
    .toLowerCase()
    .replace(/[\s?？!！,，。:：;；'"“”‘’]/gu, "")
    .trim();
}

function sourceTypeForInsight(insight: ProactiveInsight): ProactiveQaSuggestion["sourceType"] {
  const sourceTypes = [...new Set(insight.evidenceRefs.map((evidence) => evidence.sourceType))];
  if (sourceTypes.length !== 1) {
    return "memory";
  }

  const sourceType = sourceTypes[0];
  if (sourceType === "semantic_segment") {
    return "timeline";
  }
  return sourceType;
}

function toAgentSuggestion(insight: ProactiveInsight, index: number): ProactiveQaSuggestion {
  const currentEvidenceUploadIds = new Set(insight.evidenceRefs.map((evidence) => evidence.uploadId));
  return {
    id: insight.id,
    scope: insight.scope,
    category: insight.category,
    question: insight.question,
    reason: insight.reason,
    sourceType: sourceTypeForInsight(insight),
    sourceIds: [...new Set(insight.evidenceRefs.map((evidence) => evidence.sourceId))],
    sourceUploadIds: insight.sourceUploadIds,
    priority: 200 - index,
    origin: "agent",
    observation: insight.observation,
    confidence: insight.confidence,
    evidenceCount: insight.evidenceRefs.length,
    memoryAware: insight.sourceUploadIds.some((uploadId) => !currentEvidenceUploadIds.has(uploadId)),
    insightType: insight.insightType,
    caution: insight.caution
  };
}

function sharesCategoryEvidence(left: ProactiveQaSuggestion, right: ProactiveQaSuggestion) {
  if (left.category !== right.category) {
    return false;
  }
  const leftSourceIds = new Set(left.sourceIds);
  return right.sourceIds.some((sourceId) => leftSourceIds.has(sourceId));
}

function isDuplicate(candidate: ProactiveQaSuggestion, accepted: ProactiveQaSuggestion[]) {
  const questionKey = normalizedQuestion(candidate.question);
  return accepted.some(
    (item) => normalizedQuestion(item.question) === questionKey || sharesCategoryEvidence(item, candidate)
  );
}

export function mergeProactiveInsightSuggestions(input: {
  agentInsights: ProactiveInsight[];
  ruleSuggestions: ProactiveQaSuggestion[];
  limit?: number;
  agentLimit?: number;
}): ProactiveQaSuggestion[] {
  const limit = Math.min(DEFAULT_LIMIT, Math.max(0, input.limit ?? DEFAULT_LIMIT));
  const agentLimit = Math.min(DEFAULT_AGENT_LIMIT, Math.max(0, input.agentLimit ?? DEFAULT_AGENT_LIMIT));
  const eligibleAgentInsights = input.agentInsights.filter(
    (insight) => !proactiveInsightHasAbstractLanguage(insight)
  );
  if (eligibleAgentInsights.length === 0) {
    return input.ruleSuggestions.slice(0, limit);
  }

  const accepted: ProactiveQaSuggestion[] = [];
  eligibleAgentInsights.slice(0, agentLimit).forEach((insight, index) => {
    const suggestion = toAgentSuggestion(insight, index);
    if (!isDuplicate(suggestion, accepted)) {
      accepted.push(suggestion);
    }
  });

  for (const ruleSuggestion of input.ruleSuggestions) {
    if (accepted.length >= limit) {
      break;
    }
    if (!isDuplicate(ruleSuggestion, accepted)) {
      accepted.push(ruleSuggestion);
    }
  }

  return accepted.slice(0, limit);
}
