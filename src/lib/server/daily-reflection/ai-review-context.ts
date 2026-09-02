import { createHash } from "node:crypto";

import {
  DAILY_REFLECTION_AI_REVIEW_CONTRACT_VERSION,
  DailyReflectionAiReviewCanonicalSourceSchema,
  DailyReflectionAiReviewProviderDraftSchema,
  DailyReflectionAiReviewReadyContentSchema,
  DailyReflectionAiReviewScopeSchema,
  type DailyReflectionAiReviewCanonicalSource,
  type DailyReflectionAiReviewProviderDraft,
  type DailyReflectionAiReviewReadyContent,
  type DailyReflectionAiReviewScope
} from "@/lib/domain/daily-reflection-ai-review";
import type {
  DailyReflectionDailyReturnResponse,
  DailyReflectionReturnItem,
  DailyReflectionWeeklyItem,
  DailyReflectionWeeklyReflectionResponse
} from "@/lib/domain/daily-reflection-return";

import { getDailyReflectionReturnService } from "./return-service";

type ReturnService = {
  daily(accountId: string, referenceDate?: string): DailyReflectionDailyReturnResponse;
  weekly(accountId: string, endDate?: string): DailyReflectionWeeklyReflectionResponse;
};

export type DailyReflectionAiReviewContext = {
  schemaVersion: typeof DAILY_REFLECTION_AI_REVIEW_CONTRACT_VERSION;
  accountId: string;
  scope: DailyReflectionAiReviewScope;
  startDate: string;
  endDate: string;
  sourceFingerprint: string;
  promptVersion: string;
  model: string;
  sources: DailyReflectionAiReviewCanonicalSource[];
};

function unique(values: string[]) {
  return [...new Set(values)].sort();
}

function sourceFromReturnItem(
  item: DailyReflectionReturnItem | DailyReflectionWeeklyItem
): DailyReflectionAiReviewCanonicalSource {
  const evidence = [...item.evidence].sort((left, right) => (
    left.recordingDate.localeCompare(right.recordingDate)
    || left.reflectionId.localeCompare(right.reflectionId)
    || left.startSeconds - right.startSeconds
    || left.sourceSegmentId.localeCompare(right.sourceSegmentId)
  ));
  return DailyReflectionAiReviewCanonicalSourceSchema.parse({
    sourceId: item.id,
    sourceKind: item.type,
    title: item.title,
    content: item.body,
    memoryIds: unique(item.sourceMemoryIds),
    cardIds: unique(item.sourceCardIds),
    recordingDates: unique(evidence.map((source) => source.recordingDate)),
    evidence,
    epistemicStatuses: unique(item.epistemicStatuses)
  });
}

function flattenDaily(result: DailyReflectionDailyReturnResponse) {
  const seenAuthority = new Set<string>();
  return [...result.openLoops, ...result.resurfacedMemories].filter((item) => {
    const authority = JSON.stringify({
      cardIds: [...item.sourceCardIds].sort(),
      evidenceIds: item.evidence.map((source) => source.sourceSegmentId).sort()
    });
    if (seenAuthority.has(authority)) return false;
    seenAuthority.add(authority);
    return true;
  });
}

function flattenWeekly(result: DailyReflectionWeeklyReflectionResponse) {
  return [
    ...result.repeatedThemes,
    ...result.changedDecisions,
    ...result.openCommitments,
    ...result.emergingIdeas
  ];
}

function canonicalSources(items: Array<DailyReflectionReturnItem | DailyReflectionWeeklyItem>) {
  const byId = new Map<string, DailyReflectionAiReviewCanonicalSource>();
  for (const item of items) {
    const source = sourceFromReturnItem(item);
    const previous = byId.get(source.sourceId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(source)) {
      throw new Error("daily_reflection_ai_review_source_conflict");
    }
    byId.set(source.sourceId, source);
  }
  return [...byId.values()].sort((left, right) => (
    left.sourceKind.localeCompare(right.sourceKind)
    || left.sourceId.localeCompare(right.sourceId)
  ));
}

export function fingerprintDailyReflectionAiReviewContext(input: {
  accountId: string;
  scope: DailyReflectionAiReviewScope;
  startDate: string;
  endDate: string;
  promptVersion: string;
  model: string;
  sources: DailyReflectionAiReviewCanonicalSource[];
}) {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: DAILY_REFLECTION_AI_REVIEW_CONTRACT_VERSION,
    accountId: input.accountId,
    scope: input.scope,
    startDate: input.startDate,
    endDate: input.endDate,
    promptVersion: input.promptVersion,
    model: input.model,
    sources: input.sources
  })).digest("hex");
}

export function buildDailyReflectionAiReviewContext(input: {
  accountId: string;
  scope: DailyReflectionAiReviewScope;
  referenceDate: string;
  promptVersion: string;
  model: string;
  returnService?: ReturnService;
}): DailyReflectionAiReviewContext | null {
  const scope = DailyReflectionAiReviewScopeSchema.parse(input.scope);
  const service = input.returnService ?? getDailyReflectionReturnService();
  const result = scope === "daily"
    ? service.daily(input.accountId, input.referenceDate)
    : service.weekly(input.accountId, input.referenceDate);
  const sources = canonicalSources(
    scope === "daily" ? flattenDaily(result as DailyReflectionDailyReturnResponse)
      : flattenWeekly(result as DailyReflectionWeeklyReflectionResponse)
  );
  if (sources.length === 0) return null;
  const startDate = scope === "daily"
    ? (result as DailyReflectionDailyReturnResponse).referenceDate
    : (result as DailyReflectionWeeklyReflectionResponse).startDate;
  const endDate = scope === "daily"
    ? (result as DailyReflectionDailyReturnResponse).referenceDate
    : (result as DailyReflectionWeeklyReflectionResponse).endDate;
  return {
    schemaVersion: DAILY_REFLECTION_AI_REVIEW_CONTRACT_VERSION,
    accountId: input.accountId,
    scope,
    startDate,
    endDate,
    promptVersion: input.promptVersion,
    model: input.model,
    sources,
    sourceFingerprint: fingerprintDailyReflectionAiReviewContext({
      accountId: input.accountId,
      scope,
      startDate,
      endDate,
      promptVersion: input.promptVersion,
      model: input.model,
      sources
    })
  };
}

export function projectDailyReflectionAiReviewDraft(input: {
  context: DailyReflectionAiReviewContext;
  draft: DailyReflectionAiReviewProviderDraft;
}): DailyReflectionAiReviewReadyContent {
  const draft = DailyReflectionAiReviewProviderDraftSchema.parse(input.draft);
  const allowed = new Map(input.context.sources.map((source) => [source.sourceId, source]));
  for (const sourceId of draft.selectedSourceIds) {
    if (!allowed.has(sourceId)) {
      throw new Error("daily_reflection_ai_review_source_not_allowed");
    }
  }
  const selectedSourceIds = [...draft.selectedSourceIds].sort();
  const canonical = selectedSourceIds.map((sourceId) => allowed.get(sourceId)!);
  return DailyReflectionAiReviewReadyContentSchema.parse({
    schemaVersion: DAILY_REFLECTION_AI_REVIEW_CONTRACT_VERSION,
    selectedSourceIds,
    canonicalSources: canonical,
    observations: draft.observations.map((observation) => ({
      sourceIds: [...observation.sourceIds].sort(),
      canonicalSources: [...observation.sourceIds].sort()
        .map((sourceId) => {
          const source = allowed.get(sourceId);
          if (!source) throw new Error("daily_reflection_ai_review_source_not_allowed");
          return source;
        }),
      modelInterpretation: {
        kind: "model_inference" as const,
        text: observation.interpretation
      },
      // Canonical Return sources do not encode whether a third-party suggestion
      // was adopted. Keep the useful interpretation, but never publish a free-form
      // model question whose premise cannot be deterministically verified.
      followUpQuestion: null
    }))
  });
}
