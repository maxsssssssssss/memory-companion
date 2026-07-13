import type { ProactiveInsight } from "@/lib/domain/proactive-insights";
import { proactiveInsightAbstractLanguagePenalty } from "@/lib/domain/proactive-insight-quality";

import type { ProactiveInsightMemoryContext, ProactiveMemoryItem } from "./memory-context";

function memoryPriority(memory: ProactiveMemoryItem) {
  if (memory.lifecycleKind === "unresolved_question") {
    return 60;
  }
  if (memory.lifecycleKind === "active_commitment") {
    return 50;
  }
  if (memory.lifecycleKind === "repeated_memory") {
    return 40;
  }
  if (memory.lifecycleKind === "relationship_signal") {
    return 30;
  }
  return 20;
}

function insightPriority(
  insight: ProactiveInsight,
  memoryByRef: Map<string, ProactiveMemoryItem>,
  changedMemoryRefs: Set<string>
) {
  if (insight.type === "unresolved_issue" || insight.insightType === "follow_up") {
    return 70;
  }

  const referencedPriority = (insight.memoryRefs ?? []).reduce(
    (highest, memoryRef) => {
      const memory = memoryByRef.get(memoryRef);
      return memory ? Math.max(highest, memoryPriority(memory)) : highest;
    },
    0
  );
  if (referencedPriority > 0) {
    if (
      referencedPriority < 50 &&
      (insight.memoryRefs ?? []).some((memoryRef) => changedMemoryRefs.has(memoryRef))
    ) {
      return 45;
    }
    return referencedPriority;
  }
  if (insight.insightType === "reminder") {
    return 50;
  }
  const relationshipEvidence = insight.evidenceRefs.filter(
    (evidence) => evidence.kind === "relationship_signal"
  );
  if (relationshipEvidence.length > 0) {
    const onlyPositive = relationshipEvidence.every(
      (evidence) => evidence.signalCategory === "positive"
    );
    return onlyPositive && insight.insightType === "reflection" ? 20 : 30;
  }
  return 10;
}

export function rankProactiveInsights(
  insights: ProactiveInsight[],
  memoryContext?: ProactiveInsightMemoryContext
) {
  const memoryByRef = new Map(
    memoryContext?.memories.map((memory) => [memory.evidenceId, memory] as const) ?? []
  );
  const changedMemoryRefs = new Set(
    memoryContext?.relations
      .filter((relation) => relation.relationType !== "related")
      .flatMap((relation) => [relation.sourceMemoryRef, relation.targetMemoryRef]) ?? []
  );
  return insights
    .map((insight, index) => ({
      insight,
      index,
      priority:
        insightPriority(insight, memoryByRef, changedMemoryRefs) -
        proactiveInsightAbstractLanguagePenalty(insight)
    }))
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        right.insight.confidence - left.insight.confidence ||
        left.index - right.index
    )
    .map(({ insight }) => insight);
}
