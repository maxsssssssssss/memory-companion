import type {
  DailyReflectionQueryClaim,
  DailyReflectionQueryRequest,
  DailyReflectionQueryResponse
} from "@/lib/domain/daily-reflection-query";
import { DailyReflectionQueryResponseSchema } from
  "@/lib/domain/daily-reflection-query";
import type { DailyReflectionReturnEvidence } from
  "@/lib/domain/daily-reflection-return";
import { getPersonRepository } from "@/lib/server/person";

import { routeDailyReflectionQueryIntent } from "./reflection-query-intent";
import {
  getDailyReflectionReturnSourceRepository,
  type DailyReflectionAdmittedReturnSource,
  type DailyReflectionGroundedCardSource,
  type DailyReflectionReturnSourceSnapshot
} from "./return-source-repository";
import {
  addDailyReflectionDateDays,
  dailyReflectionToday
} from "./return-time";

type SourceRepository = Readonly<{
  snapshot(
    accountId: string,
    startDate: string,
    endDate: string
  ): DailyReflectionReturnSourceSnapshot;
}>;

type PersonAuthority = Readonly<{
  getConfirmedPerson(accountId: string, personId: string): unknown | null;
}>;

type RankedMemory = Readonly<{
  kind: "memory";
  source: DailyReflectionAdmittedReturnSource;
  relevance: number;
}>;

type RankedCard = Readonly<{
  kind: "card";
  source: DailyReflectionGroundedCardSource;
  relevance: number;
}>;

type RankedSource = RankedMemory | RankedCard;

const SAFE_EPISTEMIC = new Set([
  "explicit_user_statement",
  "reported_event"
]);
const UNSAFE_RISK_FLAGS = new Set([
  "ai_inference",
  "attribution_uncertain",
  "low_evidence"
]);

const QUERY_NOISE = [
  /为什么|为何|什么原因|原因是什么|出于什么考虑|怎么|如何/gu,
  /第一次|首次|最早|最初|什么时候|何时|后来|最终|之前|现在/gu,
  /决定|选择|选了|放弃|采纳|答应|承诺|约定|待办|未完成|跟进事项/gu,
  /想法|看法|观点|态度|计划|偏好|变化|改变|转变|演变/gu,
  /回顾|探索|记录|过去|以前|哪些|什么|事情|一下|关于|我的|我/gu,
  /想到|提到|出现|说过|曾经|[的了吗呢过]/gu,
  /\b(?:why|reason|decide|decided|decision|choose|chose|choice|first|time|earliest|initially|change|changed|belief|opinion|commitment|commitments|promise|promised|memory|memories|explore|about|what|when|how|did|do|does|have|has|are|still|unfinished|need|to|would|over|past|previously|related|record|records|the|my|me|i)\b/giu
] as const;

const GENERIC_TERMS = new Set([
  "这个", "那个", "事情", "记录", "过去", "以前", "后来", "现在",
  "what", "when", "why", "about", "this", "that"
]);

function normalized(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function topicTerms(query: string) {
  let value = query.normalize("NFKC").toLocaleLowerCase("zh-CN");
  for (const pattern of QUERY_NOISE) value = value.replace(pattern, " ");
  const terms = new Set<string>();
  for (const group of value.match(/[\p{Script=Han}]{2,}|[\p{Script=Han}]|[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(group)) {
      if (group.length <= 8) terms.add(group);
      for (let index = 0; index < group.length - 1; index += 1) {
        terms.add(group.slice(index, index + 2));
      }
    } else {
      terms.add(group);
    }
  }
  return [...terms].filter((term) => !GENERIC_TERMS.has(term)).sort();
}

function sourceText(source: {
  title: string;
  content: string;
  tags?: string[];
}) {
  return `${source.title}\n${source.content}\n${source.tags?.join(" ") ?? ""}`;
}

function relevanceFor(query: string, terms: string[], source: {
  title: string;
  content: string;
  tags?: string[];
}) {
  if (terms.length === 0) return 1;
  const target = normalized(sourceText(source));
  const title = normalized(source.title);
  const normalizedQuery = normalized(query);
  let score = 0;
  if (normalizedQuery.length >= 2 && target.includes(normalizedQuery)) score += 8;
  const matched = terms.filter((term) => target.includes(normalized(term)));
  const matchedLongTopic = matched.some((term) => (
    /^[\p{Script=Han}]+$/u.test(term) && Array.from(term).length >= 3
  ));
  const requiredMatches = Math.max(1, Math.ceil(terms.length * 0.75));
  if (!matchedLongTopic && matched.length < requiredMatches) return 0;
  for (const term of matched) {
    const compact = normalized(term);
    if (!compact) continue;
    score += title.includes(compact) ? 3 : 1;
  }
  return score;
}

function queryRequiresExplicitPerson(query: string) {
  return /(?:和我|我和|跟我|我跟|与我|我与|关系|谁|对方|他(?:们)?|她(?:们)?)|\b(?:relationship|who|with\s+me|between\s+me\s+and|and\s+i|i\s+and)\b/iu
    .test(query);
}

function sourceHasUnsafeRisk(source: { riskFlags: string[] }) {
  return source.riskFlags.some((flag) => UNSAFE_RISK_FLAGS.has(flag));
}

function hasExplicitCausalLanguage(source: {
  title: string;
  content: string;
  evidence: DailyReflectionReturnEvidence[];
}) {
  const text = `${source.title}\n${source.content}\n${source.evidence
    .map((item) => item.snippet).join("\n")}`;
  return /(?:因为|由于|考虑到|原因(?:是|在于)|所以|因此|基于|出于|为了|之所以)|\b(?:because|due\s+to|reason(?:s)?\s+(?:was|were|is|are)|based\s+on|in\s+order\s+to|so\s+that)\b/iu
    .test(text);
}

function safeMemorySource(
  source: DailyReflectionAdmittedReturnSource,
  personId: string | null
) {
  if (
    !SAFE_EPISTEMIC.has(source.epistemicStatus)
    || source.epistemicCaution !== null
    || sourceHasUnsafeRisk(source)
  ) {
    return false;
  }
  if (personId) {
    if (source.subjectPersonId !== personId) return false;
  } else if (source.subjectPersonId !== null || source.memoryType === "person_fact") {
    return false;
  }
  if (source.memoryType === "commitment") {
    return source.cardKind === "action"
      && source.actionClaimed
      && source.epistemicStatus === "explicit_user_statement";
  }
  return true;
}

function safeCardSource(source: DailyReflectionGroundedCardSource) {
  return source.epistemicStatuses.every((status) => SAFE_EPISTEMIC.has(status))
    && !sourceHasUnsafeRisk(source);
}

function unique<T extends string>(values: T[]) {
  return [...new Set(values)].sort() as T[];
}

function hasEvidenceAuthorityConflict(sources: Array<{
  evidence: DailyReflectionReturnEvidence[];
}>) {
  const authorityById = new Map<string, string>();
  for (const item of sources.flatMap((source) => source.evidence)) {
    const authority = [
      item.reflectionId,
      item.cardId,
      item.recordingDate,
      item.sourceOrigin,
      item.startSeconds,
      item.endSeconds,
      item.snippet
    ].join("\u0000");
    const existing = authorityById.get(item.sourceSegmentId);
    if (existing && existing !== authority) return true;
    authorityById.set(item.sourceSegmentId, authority);
  }
  return false;
}

function evidenceFor(sources: Array<{ evidence: DailyReflectionReturnEvidence[] }>) {
  const byId = new Map<string, DailyReflectionReturnEvidence>();
  for (const evidence of sources.flatMap((source) => source.evidence)) {
    if (!byId.has(evidence.sourceSegmentId)) {
      byId.set(evidence.sourceSegmentId, evidence);
    }
  }
  return [...byId.values()].sort((left, right) => (
    left.recordingDate.localeCompare(right.recordingDate)
    || left.reflectionId.localeCompare(right.reflectionId)
    || left.startSeconds - right.startSeconds
    || left.sourceSegmentId.localeCompare(right.sourceSegmentId)
  ));
}

function clean(value: string, max = 2_000) {
  const normalizedValue = value.trim();
  return normalizedValue.length <= max
    ? normalizedValue
    : `${normalizedValue.slice(0, max - 1)}…`;
}

function earliestEvidence(source: { evidence: DailyReflectionReturnEvidence[] }) {
  return evidenceFor([source])[0] ?? null;
}

function compareSourceTime(
  left: DailyReflectionAdmittedReturnSource,
  right: DailyReflectionAdmittedReturnSource
) {
  const leftEvidence = earliestEvidence(left);
  const rightEvidence = earliestEvidence(right);
  if (!leftEvidence || !rightEvidence) return null;
  const dateOrder = leftEvidence.recordingDate.localeCompare(rightEvidence.recordingDate);
  if (dateOrder !== 0) return dateOrder;
  if (leftEvidence.reflectionId !== rightEvidence.reflectionId) return null;
  const segmentOrder = leftEvidence.startSeconds - rightEvidence.startSeconds;
  return segmentOrder === 0 ? null : segmentOrder;
}

function sameLifecycleTopic(
  left: DailyReflectionAdmittedReturnSource,
  right: DailyReflectionAdmittedReturnSource
) {
  const leftTitle = normalized(left.title);
  const rightTitle = normalized(right.title);
  return leftTitle.length >= 2
    && rightTitle.length >= 2
    && (leftTitle === rightTitle
      || leftTitle.includes(rightTitle)
      || rightTitle.includes(leftTitle));
}

function sourceClaim(source: RankedSource): DailyReflectionQueryClaim {
  const evidence = evidenceFor([source.source]);
  const reported = source.kind === "memory"
    ? source.source.epistemicStatus === "reported_event"
    : source.source.epistemicStatuses.includes("reported_event");
  return {
    text: clean(reported
      ? `你曾记录过一件被报告的事情：“${source.source.content}”`
      : `你曾记录：“${source.source.content}”`),
    sourceMemoryIds: source.kind === "memory" ? [source.source.memoryId] : [],
    sourceCardIds: [source.source.cardId],
    evidenceIds: evidence.map((item) => item.sourceSegmentId),
    evidence,
    epistemicStatuses: unique(source.kind === "memory"
      ? [source.source.epistemicStatus]
      : source.source.epistemicStatuses)
  };
}

function timelineClaim(
  earlier: DailyReflectionAdmittedReturnSource,
  later: DailyReflectionAdmittedReturnSource
): DailyReflectionQueryClaim | null {
  if (hasEvidenceAuthorityConflict([earlier, later])) return null;
  const evidence = evidenceFor([earlier, later]);
  return {
    text: clean(`记录显示，${earlier.recordingDate} 的“${earlier.content}”后来在 ${later.recordingDate} 变为“${later.content}”。`),
    sourceMemoryIds: unique([earlier.memoryId, later.memoryId]),
    sourceCardIds: unique([earlier.cardId, later.cardId]),
    evidenceIds: evidence.map((item) => item.sourceSegmentId),
    evidence,
    epistemicStatuses: unique([earlier.epistemicStatus, later.epistemicStatus])
  };
}

function rankMemories(
  query: string,
  terms: string[],
  sources: DailyReflectionAdmittedReturnSource[]
): RankedMemory[] {
  return sources.map((source) => ({
    kind: "memory" as const,
    source,
    relevance: relevanceFor(query, terms, source)
  })).filter((item) => terms.length === 0 || item.relevance > 0)
    .sort((left, right) => (
      right.relevance - left.relevance
      || right.source.importance - left.source.importance
      || right.source.recordingDate.localeCompare(left.source.recordingDate)
      || left.source.memoryId.localeCompare(right.source.memoryId)
      || left.source.cardId.localeCompare(right.source.cardId)
    ));
}

function rankCards(
  query: string,
  terms: string[],
  sources: DailyReflectionGroundedCardSource[]
): RankedCard[] {
  return sources.map((source) => ({
    kind: "card" as const,
    source,
    relevance: relevanceFor(query, terms, source)
  })).filter((item) => terms.length === 0 || item.relevance > 0)
    .sort((left, right) => (
      right.relevance - left.relevance
      || right.source.importance - left.source.importance
      || (right.source.recordingDates.at(-1) ?? "").localeCompare(
        left.source.recordingDates.at(-1) ?? ""
      )
      || left.source.cardId.localeCompare(right.source.cardId)
    ));
}

function sourceWindow(scope: DailyReflectionQueryRequest["scope"], now: Date) {
  const endDate = dailyReflectionToday(now);
  if (scope === "last_7_days") {
    return { startDate: addDailyReflectionDateDays(endDate, -6), endDate };
  }
  if (scope === "last_30_days") {
    return { startDate: addDailyReflectionDateDays(endDate, -29), endDate };
  }
  return { startDate: "0001-01-01", endDate };
}

function insufficient(
  intent: NonNullable<ReturnType<typeof routeDailyReflectionQueryIntent>>["intent"],
  createdAt: string
) {
  return DailyReflectionQueryResponseSchema.parse({
    answer: "现有可信记录里没有足够证据回答这个问题。",
    claims: [],
    intent,
    confidence: 0,
    insufficientEvidence: true,
    resurfacing: null,
    createdAt
  });
}

function answerFromClaims(
  intent: NonNullable<ReturnType<typeof routeDailyReflectionQueryIntent>>["intent"],
  claims: DailyReflectionQueryClaim[]
) {
  const intro = {
    decision_reasoning: "现有记录里，与这项决定直接相关的依据是：",
    first_appearance: "现有记录里，这个想法最早出现在：",
    belief_change: "现有记录支持的变化顺序是：",
    commitment_recall: "现有记录里，你明确认领过的事项是：",
    memory_exploration: "现有记录里，与这个主题相关的内容是："
  }[intent];
  return clean(`${intro}\n${claims.map((claim) => claim.text).join("\n")}`, 4_000);
}

function confidenceFor(
  intent: NonNullable<ReturnType<typeof routeDailyReflectionQueryIntent>>["intent"],
  claims: DailyReflectionQueryClaim[]
) {
  const base = {
    decision_reasoning: 0.76,
    first_appearance: 0.82,
    belief_change: 0.8,
    commitment_recall: 0.78,
    memory_exploration: 0.64
  }[intent];
  return Math.min(0.86, base + Math.max(0, claims.length - 1) * 0.02);
}

function resurfacingFor(claims: DailyReflectionQueryClaim[]) {
  if (hasEvidenceAuthorityConflict(claims)) return null;
  const evidence = evidenceFor(claims);
  const dates = unique(evidence.map((item) => item.recordingDate));
  const earliest = evidence[0];
  if (!earliest || dates.length < 2) return null;
  return {
    title: "这个主题曾多次出现",
    body: `最早可核对的记录在 ${earliest.recordingDate}，之后还有 ${dates.length - 1} 个日期的相关记录。`,
    earliestDate: earliest.recordingDate,
    evidence: earliest
  };
}

export function createDailyReflectionQueryService(
  repository: SourceRepository,
  options: { now?: () => Date; personAuthority?: PersonAuthority } = {}
) {
  const now = options.now ?? (() => new Date());
  const personAuthority = options.personAuthority ?? getPersonRepository();

  function query(accountId: string, input: DailyReflectionQueryRequest):
    DailyReflectionQueryResponse {
    const createdAt = now().toISOString();
    const route = routeDailyReflectionQueryIntent({
      query: input.query,
      ...(input.personId ? { personId: input.personId } : {})
    });
    if (!route) {
      throw new Error("daily_reflection_query_invalid");
    }
    if (!route.personId && queryRequiresExplicitPerson(input.query)) {
      return insufficient(route.intent, createdAt);
    }
    if (route.personId) {
      try {
        if (!personAuthority.getConfirmedPerson(accountId, route.personId)) {
          return insufficient(route.intent, createdAt);
        }
      } catch {
        return insufficient(route.intent, createdAt);
      }
    }
    const window = sourceWindow(input.scope, now());
    const snapshot = repository.snapshot(accountId, window.startDate, window.endDate);
    const memories = snapshot.admitted.filter((source) => (
      safeMemorySource(source, route.personId)
    ));
    const cards = route.personId
      ? []
      : snapshot.workingCards.filter(safeCardSource);
    const terms = topicTerms(input.query);
    const rankedMemories = rankMemories(input.query, terms, memories);
    const rankedCards = rankCards(input.query, terms, cards);
    let claims: DailyReflectionQueryClaim[] = [];

    if (route.intent === "decision_reasoning") {
      const decisions = rankedMemories.filter(
        (item) => item.source.memoryType === "decision"
      ).slice(0, 3);
      const decisionCardIds = new Set(decisions.map((item) => item.source.cardId));
      const decisionWorkingCards = new Map(cards.filter((item) => (
        decisionCardIds.has(item.cardId)
      )).map((item) => [item.cardId, item]));
      const related = (decisions.length === 0 ? [] : rankedCards).filter((item) => (
        item.source.cardKind === "decision"
        || item.source.cardKind === "insight"
        || item.source.cardKind === "idea"
      ) && (
        decisionCardIds.has(item.source.cardId)
        || item.source.relatedCardIds.some((id) => decisionCardIds.has(id))
        || [...decisionWorkingCards.values()].some(
          (decision) => decision.relatedCardIds.includes(item.source.cardId)
        )
      ) && hasExplicitCausalLanguage(item.source)).slice(0, 3);
      const causalDecisions = decisions.filter((item) => (
        hasExplicitCausalLanguage(item.source)
      ));
      claims = [...causalDecisions, ...related]
        .filter((item, index, all) => all.findIndex(
          (other) => other.source.cardId === item.source.cardId
        ) === index)
        .slice(0, 5)
        .map(sourceClaim);
    } else if (route.intent === "first_appearance") {
      const candidates = rankedCards.filter((item) => (
        item.source.cardKind === "idea" || item.source.cardKind === "insight"
      ));
      const evidenceCandidates = candidates.flatMap((item) => (
        item.source.evidence.map((sourceEvidence) => ({ item, sourceEvidence }))
      )).sort((left, right) => (
        left.sourceEvidence.recordingDate.localeCompare(right.sourceEvidence.recordingDate)
        || left.sourceEvidence.reflectionId.localeCompare(right.sourceEvidence.reflectionId)
        || left.sourceEvidence.startSeconds - right.sourceEvidence.startSeconds
        || left.item.source.cardId.localeCompare(right.item.source.cardId)
      ));
      const first = evidenceCandidates[0];
      const sameDate = first ? evidenceCandidates.filter((item) => (
        item.sourceEvidence.recordingDate === first.sourceEvidence.recordingDate
      )) : [];
      const unambiguous = first
        && new Set(sameDate.map((item) => item.sourceEvidence.reflectionId)).size === 1;
      if (first && unambiguous) {
        const claim = sourceClaim(first.item);
        const firstEvidence = first.sourceEvidence;
        claim.evidence = [firstEvidence];
        claim.evidenceIds = [firstEvidence.sourceSegmentId];
        const rangeLabel = input.scope === "all" ? "现有记录中" : "所选时间范围内";
        claim.text = `${firstEvidence.recordingDate} ${Math.floor(firstEvidence.startSeconds / 60)}:${String(Math.floor(firstEvidence.startSeconds % 60)).padStart(2, "0")} 是${rangeLabel}最早可核对的出现：“${clean(first.item.source.content, 1_500)}”`;
        claims = [claim];
      }
    } else if (route.intent === "belief_change") {
      const byId = new Map(memories.map((source) => [source.memoryId, source]));
      claims = snapshot.relations.filter((relation) => (
        relation.relationType === "contradicted_by" && relation.confidence >= 0.8
      )).flatMap((relation) => {
        const source = byId.get(relation.sourceMemoryId);
        const target = byId.get(relation.targetMemoryId);
        if (
          !source
          || !target
          || (source.memoryType !== "decision" && source.memoryType !== "preference")
          || target.memoryType !== source.memoryType
          || source.epistemicStatus !== "explicit_user_statement"
          || target.epistemicStatus !== "explicit_user_statement"
          || source.subjectPersonId !== target.subjectPersonId
          || !sameLifecycleTopic(source, target)
        ) return [];
        if (
          terms.length > 0
          && relevanceFor(input.query, terms, source) === 0
          && relevanceFor(input.query, terms, target) === 0
        ) {
          return [];
        }
        const order = compareSourceTime(source, target);
        if (order === null || order >= 0) return [];
        const claim = timelineClaim(source, target);
        return claim ? [claim] : [];
      }).filter((claim, index, all) => all.findIndex((other) => (
        JSON.stringify(other.sourceMemoryIds) === JSON.stringify(claim.sourceMemoryIds)
      )) === index).slice(0, 4);
    } else if (route.intent === "commitment_recall") {
      claims = rankedMemories.filter((item) => (
        item.source.memoryType === "commitment"
        && item.source.cardKind === "action"
        && item.source.actionClaimed
      )).slice(0, 5).map(sourceClaim);
    } else {
      claims = [...rankedMemories, ...rankedCards]
        .sort((left, right) => (
          right.relevance - left.relevance
          || right.source.importance - left.source.importance
          || left.source.cardId.localeCompare(right.source.cardId)
        ))
        .filter((item, index, all) => all.findIndex(
          (other) => other.source.cardId === item.source.cardId
        ) === index)
        .slice(0, 5)
        .map(sourceClaim);
    }

    if (claims.length === 0) return insufficient(route.intent, createdAt);
    return DailyReflectionQueryResponseSchema.parse({
      answer: answerFromClaims(route.intent, claims),
      claims,
      intent: route.intent,
      confidence: confidenceFor(route.intent, claims),
      insufficientEvidence: false,
      resurfacing: resurfacingFor(claims),
      createdAt
    });
  }

  return { query };
}

export function getDailyReflectionQueryService() {
  return createDailyReflectionQueryService(
    getDailyReflectionReturnSourceRepository()
  );
}
