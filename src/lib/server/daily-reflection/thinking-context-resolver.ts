import type {
  ContextMode,
  DailyReflectionThinkingContextResolveRequest,
  DailyReflectionThinkingSource,
  ThinkingMode
} from "@/lib/domain/daily-reflection-thinking";
import {
  DailyReflectionThinkingContextResolveRequestSchema,
  DailyReflectionThinkingContextResolveResultSchema,
  DailyReflectionThinkingSourceSchema
} from "@/lib/domain/daily-reflection-thinking";
import type {
  DailyReflectionQueryClaim,
  DailyReflectionQueryResponse
} from "@/lib/domain/daily-reflection-query";
import { DailyReflectionQueryResponseSchema } from
  "@/lib/domain/daily-reflection-query";

import {
  getDailyReflectionQueryService
} from "./reflection-query-service";
import {
  getDailyReflectionReturnSourceRepository,
  type DailyReflectionAdmittedReturnSource,
  type DailyReflectionGroundedCardSource,
  type DailyReflectionReturnSourceSnapshot
} from "./return-source-repository";
import { dailyReflectionToday } from "./return-time";

type SourceRepository = Readonly<{
  snapshot(
    accountId: string,
    startDate: string,
    endDate: string
  ): DailyReflectionReturnSourceSnapshot;
}>;

type QueryService = Readonly<{
  query(
    accountId: string,
    input: { query: string; scope: "all" }
  ): DailyReflectionQueryResponse;
}>;

export type DailyReflectionThinkingContextInput = Readonly<{
  accountId: string;
  message: string;
  mode: ThinkingMode;
  contextMode: ContextMode;
  pinnedCardIds?: readonly string[];
  pinnedMemoryIds?: readonly string[];
  pinnedEvidenceIds?: readonly string[];
}>;

export type DailyReflectionThinkingPastCluesResolution = Readonly<{
  queryResult: DailyReflectionQueryResponse | null;
  insufficientEvidence: boolean;
}>;

export type DailyReflectionThinkingResolvedContext = Readonly<{
  promptExcerpts: readonly string[];
  sources: DailyReflectionThinkingSource[];
  usedPersonalContext: boolean;
  pastClues: DailyReflectionThinkingPastCluesResolution | null;
}>;

type Candidate = Readonly<{
  kind: "memory" | "card";
  source: DailyReflectionAdmittedReturnSource
    | DailyReflectionGroundedCardSource;
  sourceId: string;
  cardId: string;
  memoryId: string | null;
  title: string;
  content: string;
  importance: number;
  dates: string[];
  claim: DailyReflectionQueryClaim;
  pinned: boolean;
  relevance: number;
}>;

const SAFE_EPISTEMIC = new Set([
  "explicit_user_statement",
  "reported_event"
]);
const UNSAFE_RISK_FLAGS = new Set([
  "ai_inference",
  "attribution_uncertain",
  "low_evidence"
]);
const AUTO_PERSONAL_CONTEXT_CUE =
  /(?:我(?:之前|过去|以前|曾经|上次)|之前我|过去我|以前我|我记得|我的记录|我说过|我提到过|回顾|历史记录|过去的线索|以前的线索)|\b(?:my\s+(?:past|previous)|i\s+(?:previously|once)|earlier\s+record|past\s+clue|personal\s+context)\b/iu;
const QUERY_NOISE = [
  /一起想想|一起想|帮我想想|请帮我|下一步|怎么办|怎么做/gu,
  /我(?:之前|过去|以前|曾经|上次)|之前我|过去我|以前我|我记得/gu,
  /我的记录|历史记录|回顾|相关|线索|内容|事情|什么|哪些|一下/gu,
  /说过|提到过|记录过|想过|有没有|是否|请|帮我|我|的/gu,
  /\b(?:please|help|think|brainstorm|past|previous|previously|earlier|record|records|clue|clues|context|about|what|which|my|me|i)\b/giu
] as const;
const GENERIC_TERMS = new Set([
  "一起", "想想", "下一步", "这个", "那个", "事情", "相关", "记录",
  "过去", "以前", "之前", "曾经", "线索", "什么", "哪些",
  "about", "context", "past", "record", "what", "which"
]);
const MAX_SOURCES = 16;
const MAX_CONTENT_EXCERPT = 480;
const MAX_CLAIM_TEXT = 1_200;
const MAX_PROMPT_EXCERPT = 900;

function clean(value: string, max: number) {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized.length <= max
    ? normalized
    : `${normalized.slice(0, max - 1)}…`;
}

function normalized(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function queryTerms(message: string) {
  let value = Array.from(message).slice(0, 1_024).join("")
    .normalize("NFKC").toLocaleLowerCase("zh-CN");
  for (const pattern of QUERY_NOISE) value = value.replace(pattern, " ");
  const terms = new Set<string>();
  for (const group of value.match(
    /[\p{Script=Han}]{2,}|[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu
  ) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(group)) {
      if (group.length <= 12) terms.add(group);
      for (let index = 0; index < group.length - 1; index += 1) {
        terms.add(group.slice(index, index + 2));
      }
    } else {
      terms.add(group);
    }
  }
  return [...terms].filter((term) => !GENERIC_TERMS.has(term)).sort();
}

function relevanceFor(
  terms: string[],
  source: { title: string; content: string }
) {
  if (terms.length === 0) return 0;
  const title = normalized(source.title);
  const target = normalized(`${source.title}\n${source.content}`);
  return terms.reduce((score, term) => {
    const compact = normalized(term);
    if (!compact || !target.includes(compact)) return score;
    return score + (title.includes(compact) ? 3 : 1);
  }, 0);
}

function hasUnsafeRisk(source: { riskFlags: string[] }) {
  return source.riskFlags.some((flag) => UNSAFE_RISK_FLAGS.has(flag));
}

function safeMemory(source: DailyReflectionAdmittedReturnSource) {
  if (
    !SAFE_EPISTEMIC.has(source.epistemicStatus)
    || source.epistemicCaution !== null
    || hasUnsafeRisk(source)
    || source.subjectPersonId !== null
    || source.memoryType === "person_fact"
  ) {
    return false;
  }
  if (source.memoryType === "commitment") {
    return source.cardKind === "action"
      && source.actionClaimed
      && source.epistemicStatus === "explicit_user_statement";
  }
  return true;
}

function safeCard(source: DailyReflectionGroundedCardSource) {
  return source.epistemicStatuses.length > 0
    && source.epistemicStatuses.every((status) => SAFE_EPISTEMIC.has(status))
    && !hasUnsafeRisk(source);
}

function canonicalEvidence(
  evidence: DailyReflectionAdmittedReturnSource["evidence"]
) {
  const authorityById = new Map<string, string>();
  for (const item of evidence) {
    const authority = JSON.stringify(item);
    const existing = authorityById.get(item.sourceSegmentId);
    if (existing && existing !== authority) return null;
    authorityById.set(item.sourceSegmentId, authority);
  }
  if (authorityById.size !== evidence.length) return null;
  return [...evidence].sort((left, right) => (
    left.recordingDate.localeCompare(right.recordingDate)
    || left.reflectionId.localeCompare(right.reflectionId)
    || left.startSeconds - right.startSeconds
    || left.sourceSegmentId.localeCompare(right.sourceSegmentId)
  ));
}

function compactClaimText(input: {
  kind: "memory" | "card";
  title: string;
  content: string;
  dates: string[];
  reported: boolean;
}) {
  const date = input.dates.at(-1) ?? "日期未知";
  const content = clean(input.content, MAX_CONTENT_EXCERPT);
  const attribution = input.reported
    ? "你保存过一条被报告的记录"
    : input.kind === "memory"
      ? "你曾确认并保存"
      : "你曾保存一张工作卡";
  return clean(
    `${date} · ${input.title}\n${attribution}：“${content}”`,
    MAX_CLAIM_TEXT
  );
}

function memoryCandidate(
  source: DailyReflectionAdmittedReturnSource,
  pins: ReturnType<typeof pinSets>,
  terms: string[]
): Candidate | null {
  if (!safeMemory(source)) return null;
  const evidence = canonicalEvidence(source.evidence);
  if (!evidence || evidence.length === 0) return null;
  const claim = {
    text: compactClaimText({
      kind: "memory",
      title: source.title,
      content: source.content,
      dates: [source.recordingDate],
      reported: source.epistemicStatus === "reported_event"
    }),
    sourceMemoryIds: [source.memoryId],
    sourceCardIds: [source.cardId],
    evidenceIds: evidence.map((item) => item.sourceSegmentId),
    evidence,
    epistemicStatuses: [source.epistemicStatus]
  } satisfies DailyReflectionQueryClaim;
  const parsed = DailyReflectionThinkingSourceSchema.safeParse({
    sourceId: source.memoryId,
    claim
  });
  if (!parsed.success) return null;
  return {
    kind: "memory",
    source,
    sourceId: source.memoryId,
    cardId: source.cardId,
    memoryId: source.memoryId,
    title: source.title,
    content: source.content,
    importance: source.importance,
    dates: [source.recordingDate],
    claim: parsed.data.claim,
    pinned: pins.memory.has(source.memoryId)
      || pins.card.has(source.cardId)
      || evidence.some((item) => pins.evidence.has(item.sourceSegmentId)),
    relevance: relevanceFor(terms, source)
  };
}

function cardCandidate(
  source: DailyReflectionGroundedCardSource,
  pins: ReturnType<typeof pinSets>,
  terms: string[]
): Candidate | null {
  if (!safeCard(source)) return null;
  const evidence = canonicalEvidence(source.evidence);
  if (!evidence || evidence.length === 0) return null;
  const claim = {
    text: compactClaimText({
      kind: "card",
      title: source.title,
      content: source.content,
      dates: source.recordingDates,
      reported: source.epistemicStatuses.includes("reported_event")
    }),
    sourceMemoryIds: [],
    sourceCardIds: [source.cardId],
    evidenceIds: evidence.map((item) => item.sourceSegmentId),
    evidence,
    epistemicStatuses: [...source.epistemicStatuses].sort()
  } satisfies DailyReflectionQueryClaim;
  const parsed = DailyReflectionThinkingSourceSchema.safeParse({
    sourceId: source.cardId,
    claim
  });
  if (!parsed.success) return null;
  return {
    kind: "card",
    source,
    sourceId: source.cardId,
    cardId: source.cardId,
    memoryId: null,
    title: source.title,
    content: source.content,
    importance: source.importance,
    dates: [...source.recordingDates].sort(),
    claim: parsed.data.claim,
    pinned: pins.card.has(source.cardId)
      || evidence.some((item) => pins.evidence.has(item.sourceSegmentId)),
    relevance: relevanceFor(terms, source)
  };
}

function pinSets(input: {
  pinnedCardIds: readonly string[];
  pinnedMemoryIds: readonly string[];
  pinnedEvidenceIds: readonly string[];
}) {
  return {
    card: new Set(input.pinnedCardIds),
    memory: new Set(input.pinnedMemoryIds),
    evidence: new Set(input.pinnedEvidenceIds)
  };
}

function hasPins(input: {
  pinnedCardIds: readonly string[];
  pinnedMemoryIds: readonly string[];
  pinnedEvidenceIds: readonly string[];
}) {
  return input.pinnedCardIds.length > 0
    || input.pinnedMemoryIds.length > 0
    || input.pinnedEvidenceIds.length > 0;
}

function candidateSources(
  snapshot: DailyReflectionReturnSourceSnapshot,
  input: DailyReflectionThinkingContextResolveRequest,
  terms: string[]
) {
  const pins = pinSets(input);
  const memories = snapshot.admitted
    .map((source) => memoryCandidate(source, pins, terms))
    .filter((source): source is Candidate => Boolean(source));
  const memoryCardIds = new Set(memories.map((source) => source.cardId));
  const cards = snapshot.workingCards
    .filter((source) => !memoryCardIds.has(source.cardId))
    .map((source) => cardCandidate(source, pins, terms))
    .filter((source): source is Candidate => Boolean(source));
  return [...memories, ...cards]
    .filter((source) => source.pinned || terms.length === 0 || source.relevance > 0)
    .sort((left, right) => (
      Number(right.pinned) - Number(left.pinned)
      || right.relevance - left.relevance
      || right.importance - left.importance
      || (right.dates.at(-1) ?? "").localeCompare(left.dates.at(-1) ?? "")
      || Number(right.kind === "memory") - Number(left.kind === "memory")
      || left.sourceId.localeCompare(right.sourceId)
    ))
    .slice(0, MAX_SOURCES);
}

function formatSeconds(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function promptExcerpt(source: DailyReflectionThinkingSource) {
  const evidence = source.claim.evidence[0];
  if (!evidence) return clean(source.claim.text, MAX_PROMPT_EXCERPT);
  return clean([
    source.claim.text,
    `可核对来源：${evidence.recordingDate} ${formatSeconds(evidence.startSeconds)}`,
    `原始片段：${evidence.snippet}`
  ].join("\n"), MAX_PROMPT_EXCERPT);
}

function emptyContext(
  pastClues: DailyReflectionThinkingPastCluesResolution | null = null
): DailyReflectionThinkingResolvedContext {
  return {
    promptExcerpts: [],
    sources: [],
    usedPersonalContext: false,
    pastClues
  };
}

function contextFromSources(
  sources: DailyReflectionThinkingSource[],
  pastClues: DailyReflectionThinkingPastCluesResolution | null = null
): DailyReflectionThinkingResolvedContext {
  const parsed = DailyReflectionThinkingContextResolveResultSchema.parse({
    sources
  });
  return {
    promptExcerpts: parsed.sources.map(promptExcerpt),
    sources: parsed.sources,
    usedPersonalContext: parsed.sources.length > 0,
    pastClues
  };
}

function queryText(message: string) {
  return Array.from(message).slice(0, 512).join("").trim();
}

function sourcesFromQuery(
  result: DailyReflectionQueryResponse,
  input: DailyReflectionThinkingContextResolveRequest
) {
  const usedIds = new Set<string>();
  const pins = pinSets(input);
  return result.claims.flatMap((claim, index) => {
    const baseId = claim.sourceMemoryIds[0]
      ?? claim.sourceCardIds[0]
      ?? claim.evidenceIds[0];
    if (!baseId) return [];
    let sourceId = baseId;
    if (usedIds.has(sourceId)) sourceId = `${baseId}:claim:${index + 1}`;
    usedIds.add(sourceId);
    const parsed = DailyReflectionThinkingSourceSchema.safeParse({
      sourceId,
      claim
    });
    return parsed.success ? [{
      source: parsed.data,
      index,
      pinned: claim.sourceMemoryIds.some((id) => pins.memory.has(id))
        || claim.sourceCardIds.some((id) => pins.card.has(id))
        || claim.evidenceIds.some((id) => pins.evidence.has(id))
    }] : [];
  }).sort((left, right) => (
    Number(right.pinned) - Number(left.pinned) || left.index - right.index
  )).slice(0, MAX_SOURCES).map((item) => item.source);
}

export function createDailyReflectionThinkingContextResolver(
  dependencies: {
    sourceRepository?: SourceRepository;
    queryService?: QueryService;
    now?: () => Date;
  } = {}
) {
  const now = dependencies.now ?? (() => new Date());

  function resolve(
    rawInput: DailyReflectionThinkingContextInput
  ): DailyReflectionThinkingResolvedContext {
    if (rawInput.contextMode === "none") return emptyContext();

    const input = DailyReflectionThinkingContextResolveRequestSchema.parse({
      accountId: rawInput.accountId,
      message: rawInput.message,
      mode: rawInput.mode,
      contextMode: rawInput.contextMode,
      pinnedCardIds: [...(rawInput.pinnedCardIds ?? [])],
      pinnedMemoryIds: [...(rawInput.pinnedMemoryIds ?? [])],
      pinnedEvidenceIds: [...(rawInput.pinnedEvidenceIds ?? [])]
    });

    if (input.mode === "past_clues") {
      try {
        const rawResult = (dependencies.queryService
          ?? getDailyReflectionQueryService()).query(input.accountId, {
          query: queryText(input.message),
          scope: "all"
        });
        const parsed = DailyReflectionQueryResponseSchema.safeParse(rawResult);
        if (!parsed.success) {
          return emptyContext({ queryResult: null, insufficientEvidence: true });
        }
        const sources = sourcesFromQuery(parsed.data, input);
        const insufficientEvidence = parsed.data.insufficientEvidence
          || sources.length === 0;
        return contextFromSources(
          insufficientEvidence ? [] : sources,
          { queryResult: parsed.data, insufficientEvidence }
        );
      } catch {
        return emptyContext({ queryResult: null, insufficientEvidence: true });
      }
    }

    const terms = queryTerms(input.message);
    if (
      input.contextMode === "auto"
      && !hasPins(input)
      && (!AUTO_PERSONAL_CONTEXT_CUE.test(input.message) || terms.length === 0)
    ) {
      return emptyContext();
    }

    try {
      const snapshot = (dependencies.sourceRepository
        ?? getDailyReflectionReturnSourceRepository()).snapshot(
        input.accountId,
        "0001-01-01",
        dailyReflectionToday(now())
      );
      const candidates = candidateSources(snapshot, input, terms);
      return contextFromSources(candidates.map((candidate) => ({
        sourceId: candidate.sourceId,
        claim: candidate.claim
      })));
    } catch {
      return emptyContext();
    }
  }

  return { resolve };
}

export function getDailyReflectionThinkingContextResolver() {
  return createDailyReflectionThinkingContextResolver();
}
