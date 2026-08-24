import { createHash } from "node:crypto";

import {
  DAILY_REFLECTION_RETURN_TIME_ZONE,
  DailyReflectionDailyReturnResponseSchema,
  DailyReflectionWeeklyReflectionResponseSchema,
  type DailyReflectionReturnEvidence,
  type DailyReflectionReturnItem,
  type DailyReflectionWeeklyItem
} from "@/lib/domain/daily-reflection-return";

import {
  dailyReflectionSevenDayWindow,
  dailyReflectionToday,
  stableDailyReflectionProjectionTimestamp
} from "./return-time";
import {
  getDailyReflectionReturnSourceRepository,
  type DailyReflectionAdmittedReturnSource,
  type DailyReflectionEmergingCardSource,
  type DailyReflectionReturnSourceSnapshot
} from "./return-source-repository";

type SourceRepository = {
  snapshot(accountId: string, startDate: string, endDate: string):
    DailyReflectionReturnSourceSnapshot;
};

const SAFE_EPISTEMIC = new Set(["explicit_user_statement", "reported_event"]);

function stableId(prefix: string, value: unknown) {
  return `${prefix}_${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 32)}`;
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort();
}

function cleanTitle(value: string) {
  return value.trim().slice(0, 240);
}

function cleanBody(value: string) {
  const normalized = value.trim();
  return normalized.length <= 2_000
    ? normalized
    : `${normalized.slice(0, 1_997)}…`;
}

function sortSources(sources: DailyReflectionAdmittedReturnSource[]) {
  return [...sources].sort((left, right) => (
    right.importance - left.importance
    || right.recordingDate.localeCompare(left.recordingDate)
    || left.memoryId.localeCompare(right.memoryId)
    || left.cardId.localeCompare(right.cardId)
  ));
}

function safeSource(source: DailyReflectionAdmittedReturnSource) {
  if (
    !SAFE_EPISTEMIC.has(source.epistemicStatus)
    || source.epistemicCaution !== null
    || source.riskFlags.some((flag) => (
      flag === "ai_inference"
      || flag === "attribution_uncertain"
      || flag === "low_evidence"
    ))
  ) return false;
  if (source.memoryType === "commitment") {
    return source.cardKind === "action"
      && source.actionClaimed
      && source.epistemicStatus === "explicit_user_statement";
  }
  return true;
}

function evidenceFor(sources: Array<{
  evidence: DailyReflectionReturnEvidence[];
}>) {
  const byId = new Map<string, DailyReflectionReturnEvidence>();
  for (const item of sources.flatMap((source) => source.evidence)) {
    if (!byId.has(item.sourceSegmentId)) byId.set(item.sourceSegmentId, item);
  }
  return [...byId.values()].sort((left, right) => (
    left.recordingDate.localeCompare(right.recordingDate)
    || left.reflectionId.localeCompare(right.reflectionId)
    || left.startSeconds - right.startSeconds
    || left.sourceSegmentId.localeCompare(right.sourceSegmentId)
  ));
}

function groupByMemory(sources: DailyReflectionAdmittedReturnSource[]) {
  const grouped = new Map<string, DailyReflectionAdmittedReturnSource[]>();
  for (const source of sources) {
    grouped.set(source.memoryId, [...(grouped.get(source.memoryId) ?? []), source]);
  }
  return grouped;
}

function returnItem(input: {
  type: DailyReflectionReturnItem["type"];
  referenceDate: string;
  title: string;
  body: string;
  sources: DailyReflectionAdmittedReturnSource[];
}) {
  const evidence = evidenceFor(input.sources);
  return {
    id: stableId("dr_return", {
      version: 1,
      referenceDate: input.referenceDate,
      type: input.type,
      memoryIds: unique(input.sources.map((source) => source.memoryId)),
      cardIds: unique(input.sources.map((source) => source.cardId))
    }),
    type: input.type,
    title: cleanTitle(input.title),
    body: cleanBody(input.body),
    sourceMemoryIds: unique(input.sources.map((source) => source.memoryId)),
    sourceCardIds: unique(input.sources.map((source) => source.cardId)),
    evidenceIds: evidence.map((item) => item.sourceSegmentId),
    evidence,
    epistemicStatuses: unique(
      input.sources.map((source) => source.epistemicStatus)
    ),
    createdAt: stableDailyReflectionProjectionTimestamp(input.referenceDate)
  } satisfies DailyReflectionReturnItem;
}

function weeklyItem(input: {
  type: DailyReflectionWeeklyItem["type"];
  startDate: string;
  endDate: string;
  title: string;
  body: string;
  sources: DailyReflectionAdmittedReturnSource[];
  cardSources?: DailyReflectionEmergingCardSource[];
}) {
  const allSources = [...input.sources, ...(input.cardSources ?? [])];
  const evidence = evidenceFor(allSources);
  const memoryIds = unique(input.sources.map((source) => source.memoryId));
  const cardIds = unique([
    ...input.sources.map((source) => source.cardId),
    ...(input.cardSources ?? []).map((source) => source.cardId)
  ]);
  const dates = unique([
    ...input.sources.map((source) => source.recordingDate),
    ...(input.cardSources ?? []).flatMap((source) => source.recordingDates)
  ]);
  const epistemicStatuses = unique([
    ...input.sources.map((source) => source.epistemicStatus),
    ...(input.cardSources ?? []).flatMap((source) => source.epistemicStatuses)
  ]);
  return {
    id: stableId("dr_weekly", {
      version: 1,
      startDate: input.startDate,
      endDate: input.endDate,
      type: input.type,
      memoryIds,
      cardIds
    }),
    type: input.type,
    title: cleanTitle(input.title),
    body: cleanBody(input.body),
    sourceCount: input.type === "emerging_idea"
      ? cardIds.length
      : memoryIds.length,
    dates,
    sourceMemoryIds: memoryIds,
    sourceCardIds: cardIds,
    evidenceIds: evidence.map((item) => item.sourceSegmentId),
    evidence,
    epistemicStatuses,
    createdAt: stableDailyReflectionProjectionTimestamp(input.endDate)
  } satisfies DailyReflectionWeeklyItem;
}

function normalizedTheme(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .slice(0, 160);
}

export function createDailyReflectionReturnService(
  repository: SourceRepository,
  options: { now?: () => Date } = {}
) {
  const now = options.now ?? (() => new Date());

  function daily(accountId: string, referenceDate = dailyReflectionToday(now())) {
    const snapshot = repository.snapshot(accountId, "0001-01-01", referenceDate);
    const safe = sortSources(snapshot.admitted.filter(safeSource));
    const byMemory = groupByMemory(safe);
    const representatives = [...byMemory.values()]
      .map((sources) => sortSources(sources)[0]!)
      .sort((left, right) => (
        right.importance - left.importance
        || right.recordingDate.localeCompare(left.recordingDate)
        || left.memoryId.localeCompare(right.memoryId)
      ));

    const openLoops = representatives.filter((source) => (
      (source.memoryType === "commitment"
        && source.cardKind === "action"
        && source.actionClaimed
        && source.epistemicStatus === "explicit_user_statement")
      || (source.memoryType === "question" && source.cardKind === "question")
    )).slice(0, 3).map((source) => returnItem({
      type: "open_loop",
      referenceDate,
      title: source.title,
      body: source.content,
      sources: byMemory.get(source.memoryId)!
    }));

    const resurfacedMemories = representatives.slice(0, 3).map((source) =>
      returnItem({
        type: "resurfaced_memory",
        referenceDate,
        title: source.title,
        body: source.content,
        sources: byMemory.get(source.memoryId)!
      }));

    const reflectionPrompts = representatives.slice(0, 3).map((source) =>
      returnItem({
        type: "reflection_prompt",
        referenceDate,
        title: `现在的情况有变化吗：${source.title}`,
        body: `你之前记录过“${cleanBody(source.content).slice(0, 1_800)}”，现在情况是否有变化？`,
        sources: byMemory.get(source.memoryId)!
      }));

    return DailyReflectionDailyReturnResponseSchema.parse({
      referenceDate,
      timeZone: DAILY_REFLECTION_RETURN_TIME_ZONE,
      openLoops,
      resurfacedMemories,
      reflectionPrompts
    });
  }

  function weekly(accountId: string, endDate = dailyReflectionToday(now())) {
    const window = dailyReflectionSevenDayWindow(endDate);
    const snapshot = repository.snapshot(accountId, window.startDate, window.endDate);
    const safe = sortSources(snapshot.admitted.filter(safeSource));
    const byMemory = groupByMemory(safe);
    const representativeByMemory = new Map(
      [...byMemory].map(([memoryId, sources]) => [memoryId, sortSources(sources)[0]!])
    );

    const themeGroups = new Map<string, DailyReflectionAdmittedReturnSource[]>();
    for (const source of representativeByMemory.values()) {
      const key = normalizedTheme(source.title);
      if (!key) continue;
      themeGroups.set(key, [...(themeGroups.get(key) ?? []), source]);
    }
    const repeatedThemes = [...themeGroups.values()]
      .filter((sources) => (
        new Set(sources.map((source) => source.memoryId)).size >= 2
        && new Set(sources.map((source) => source.recordingDate)).size >= 2
      ))
      .sort((left, right) => (
        right.length - left.length
        || left[0]!.title.localeCompare(right[0]!.title)
      ))
      .slice(0, 5)
      .map((sources) => weeklyItem({
        type: "repeated_theme",
        ...window,
        title: sources[0]!.title,
        body: `过去七天有 ${sources.length} 条有来源的记录围绕“${sources[0]!.title}”。`,
        sources: sources.flatMap((source) => byMemory.get(source.memoryId)!)
      }));

    const seenDecisionPairs = new Set<string>();
    const changedDecisions = snapshot.relations.flatMap((relation) => {
      if (relation.relationType !== "contradicted_by" || relation.confidence < 0.8) {
        return [];
      }
      const source = representativeByMemory.get(relation.sourceMemoryId);
      const target = representativeByMemory.get(relation.targetMemoryId);
      if (
        !source
        || !target
        || source.memoryType !== "decision"
        || target.memoryType !== "decision"
        || source.recordingDate === target.recordingDate
      ) {
        return [];
      }
      const [earlier, later] = source.recordingDate < target.recordingDate
        ? [source, target]
        : [target, source];
      const key = [earlier.memoryId, later.memoryId].join("\u0000");
      if (seenDecisionPairs.has(key)) return [];
      seenDecisionPairs.add(key);
      return [weeklyItem({
        type: "changed_decision",
        ...window,
        title: later.title,
        body: `从“${cleanBody(earlier.content).slice(0, 850)}”变化为“${cleanBody(later.content).slice(0, 850)}”。`,
        sources: [
          ...byMemory.get(earlier.memoryId)!,
          ...byMemory.get(later.memoryId)!
        ]
      })];
    }).slice(0, 5);

    const openCommitments = [...representativeByMemory.values()]
      .filter((source) => (
        source.memoryType === "commitment"
        && source.cardKind === "action"
        && source.actionClaimed
        && source.epistemicStatus === "explicit_user_statement"
      ))
      .sort((left, right) => (
        right.importance - left.importance
        || left.recordingDate.localeCompare(right.recordingDate)
        || left.memoryId.localeCompare(right.memoryId)
      ))
      .slice(0, 5)
      .map((source) => weeklyItem({
        type: "open_commitment",
        ...window,
        title: source.title,
        body: source.content,
        sources: byMemory.get(source.memoryId)!
      }));

    const emergingIdeas = [...snapshot.emergingCards]
      .sort((left, right) => (
        right.importance - left.importance
        || right.recordingDates.at(-1)!.localeCompare(left.recordingDates.at(-1)!)
        || left.cardId.localeCompare(right.cardId)
      ))
      .slice(0, 5)
      .map((source) => weeklyItem({
        type: "emerging_idea",
        ...window,
        title: source.title,
        body: source.content,
        sources: [],
        cardSources: [source]
      }));

    return DailyReflectionWeeklyReflectionResponseSchema.parse({
      ...window,
      repeatedThemes,
      changedDecisions,
      openCommitments,
      emergingIdeas
    });
  }

  return { daily, weekly };
}

export function getDailyReflectionReturnService() {
  return createDailyReflectionReturnService(
    getDailyReflectionReturnSourceRepository()
  );
}
