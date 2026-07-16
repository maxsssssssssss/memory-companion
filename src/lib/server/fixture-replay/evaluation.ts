import { createHash } from "node:crypto";

import { ProactiveInsightCacheDocumentSchema, proactiveInsightCacheIdForUpload, type ProactiveInsight } from "@/lib/domain/proactive-insights";
import type { AudioInsight, BriefItem, RelationshipSignalCard, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import type { MemoryEvidence, MemoryItem, MemoryRelation, MemoryRepository } from "@/lib/server/memory/types";
import { retrieveMemoryIndexEvidence } from "@/lib/server/retrieval/memory-index-evidence";
import { currentWeekRange, dateFromKey } from "@/lib/server/retrieval/memory-scope-qa";
import type { JsonStore } from "@/lib/server/storage/json-store";

import { fixtureUploadId } from "./dataset";
import type { FixtureDataset, FixtureSession } from "./types";

export type FixtureDayReplayResult = {
  sessionId: string;
  uploadId: string;
  recordingDate: string;
  status: string;
  transcriptSegments: number;
  speakers: number;
  audioInsights: number;
  semanticSegments: number;
  briefItems: number;
  relationshipSignals: number;
  proactiveInsights: number;
  memoryCandidates: number;
  addedMemoryIds: string[];
  updatedMemoryIds: string[];
  dedupMerged: number;
  relationCount: number;
};

type AssertionResult = {
  id: string;
  pass: boolean;
  detail: string;
};

const forbiddenPatterns = [
  /渣男|渣女|有病|应该分手|必须分手|心理诊断|人格判断/u,
  /personality disorder|mental illness|should break up|must break up/iu
];
const longTermPattern = /长期|一直|总是|经常|反复模式|long[- ]term|always|pattern/iu;
const ordinaryGreetingPattern = /^(你好|早上好|晚上好|谢谢|好的|嗯|好)[。！! ]*$/u;

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/gu, "").trim();
}

function memoryText(memory: MemoryItem) {
  return `${memory.title} ${memory.summary} ${memory.evidence.map((item) => item.quote).join(" ")}`;
}

function evidenceDates(memory: MemoryItem) {
  return [...new Set(memory.evidence.map((item) => item.date))].sort();
}

function memoryHasUpload(memory: MemoryItem, uploadId: string) {
  return memory.evidence.some((item) => item.uploadId === uploadId);
}

function memoryPairHasRelation(input: {
  memories: MemoryItem[];
  relations: MemoryRelation[];
  sourceUploadId: string;
  targetUploadId: string;
  accepted: string[];
}) {
  const memoryById = new Map(input.memories.map((memory) => [memory.id, memory] as const));
  return input.relations.some((relation) => {
    if (!input.accepted.includes(relation.relationType)) {
      return false;
    }
    const source = memoryById.get(relation.sourceMemoryId);
    const target = memoryById.get(relation.targetMemoryId);
    return Boolean(
      source && target &&
      memoryHasUpload(source, input.sourceUploadId) &&
      memoryHasUpload(target, input.targetUploadId)
    );
  });
}

function memoryCombinesUploads(memory: MemoryItem, uploadIds: string[]) {
  const actual = new Set(memory.evidence.map((item) => item.uploadId));
  return uploadIds.every((uploadId) => actual.has(uploadId));
}

type ArtifactTrace = {
  quote: string;
  sourceSegmentIds: readonly string[];
};

async function artifactTraceIndex(store: JsonStore, uploadId: string) {
  const [segments, briefItems, semanticSegments, relationshipSignals, audioInsights] = await Promise.all([
    store.read<TranscriptSegment[]>("segments", uploadId),
    store.read<BriefItem[]>("brief-items", uploadId),
    store.read<SemanticSegment[]>("semantic-segments", uploadId),
    store.read<RelationshipSignalCard[]>("relationship-signals", uploadId),
    store.read<AudioInsight[]>("audio-insights", uploadId)
  ]);
  return {
    transcript: new Map((segments ?? []).map((item) => [item.id, {
      quote: item.text,
      sourceSegmentIds: [item.id]
    }] as const)),
    brief: new Map((briefItems ?? []).map((item) => [item.id, {
      quote: item.transcriptExcerpt,
      sourceSegmentIds: item.sourceSegmentIds
    }] as const)),
    timeline: new Map((semanticSegments ?? []).map((item) => [item.id, {
      quote: item.transcriptExcerpt,
      sourceSegmentIds: item.sourceSegmentIds
    }] as const)),
    relationship_signal: new Map((relationshipSignals ?? []).map((item) => [item.id, {
      quote: item.textEvidence.join(" "),
      sourceSegmentIds: item.evidenceSegments.map((evidence) => evidence.segmentId)
    }] as const)),
    audio_insight: new Map((audioInsights ?? []).map((item) => [item.id, {
      quote: item.evidence,
      sourceSegmentIds: item.sourceSegmentIds
    }] as const))
  };
}

async function loadTranscriptIndex(store: JsonStore, sessions: FixtureSession[]) {
  const byUpload = new Map<string, TranscriptSegment[]>();
  const sourceArtifactsByUpload = new Map<string, Awaited<ReturnType<typeof artifactTraceIndex>>>();
  for (const session of sessions) {
    const uploadId = fixtureUploadId(session.sessionId);
    byUpload.set(uploadId, (await store.read<TranscriptSegment[]>("segments", uploadId)) ?? []);
    sourceArtifactsByUpload.set(uploadId, await artifactTraceIndex(store, uploadId));
  }
  return { byUpload, sourceArtifactsByUpload };
}

function quoteIsGrounded(input: {
  evidence: MemoryEvidence;
  transcript: TranscriptSegment[];
  artifact?: ArtifactTrace;
}) {
  const artifact = input.artifact;
  if (!artifact || artifact.sourceSegmentIds.length === 0) {
    return false;
  }
  const segmentById = new Map(input.transcript.map((segment) => [segment.id, segment] as const));
  if (!artifact.sourceSegmentIds.every((segmentId) => segmentById.has(segmentId))) {
    return false;
  }
  const quote = normalizeWhitespace(input.evidence.quote);
  if (!quote) {
    return false;
  }
  return artifact.sourceSegmentIds.some((segmentId) => {
    const sourceText = normalizeWhitespace(segmentById.get(segmentId)?.text ?? "");
    return sourceText.length > 0 && sourceText.includes(quote);
  });
}

async function loadProactiveInsights(store: JsonStore, sessions: FixtureSession[]) {
  const results: Array<{ sessionId: string; uploadId: string; recordingDate: string; items: ProactiveInsight[] }> = [];
  for (const session of sessions) {
    const uploadId = fixtureUploadId(session.sessionId);
    const raw = await store.read<unknown>("proactive-insights", proactiveInsightCacheIdForUpload(uploadId));
    const parsed = ProactiveInsightCacheDocumentSchema.safeParse(raw);
    results.push({
      sessionId: session.sessionId,
      uploadId,
      recordingDate: session.date,
      items: parsed.success ? parsed.data.items : []
    });
  }
  return results;
}

function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableObject);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableObject(child)])
    );
  }
  return value;
}

function stableDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(stableObject(value))).digest("hex");
}

export async function evaluateFixtureReplay(input: {
  dataset: FixtureDataset;
  sessions: FixtureSession[];
  userId: string;
  store: JsonStore;
  repository: MemoryRepository;
  dayResults: FixtureDayReplayResult[];
  networkAttempts: number;
  orphanEvidenceCount: number;
  startedAt: string;
  finishedAt: string;
}) {
  const memories = input.repository.getRelevantMemories({ userId: input.userId, limit: 10_000 });
  const relations = input.repository.getMemoryRelations(input.userId);
  const evidence = memories.flatMap((memory) => memory.evidence);
  const transcriptIndex = await loadTranscriptIndex(input.store, input.sessions);
  const proactiveByDay = await loadProactiveInsights(input.store, input.sessions);
  const sessionById = new Map(input.sessions.map((session) => [session.sessionId, session] as const));
  const upload = (sessionId: string) => fixtureUploadId(sessionId);
  const day1 = upload("memory-v1-day-01");
  const day3 = upload("memory-v1-day-03");
  const day5 = upload("memory-v1-day-05");
  const day6 = upload("memory-v1-day-06");
  const day2 = upload("memory-v1-day-02");
  const day4 = upload("memory-v1-day-04");
  const day8 = upload("memory-v1-day-08");

  const resumeCommitments = memories.filter(
    (memory) => memory.type === "commitment" && /简历|resume review/iu.test(memoryText(memory))
  );
  const coffeePreferences = memories.filter(
    (memory) => memory.type === "preference" && /咖啡|拿铁|coffee preference/iu.test(memoryText(memory))
  );
  const allEvidenceHasMemory = memories.every((memory) => memory.evidence.length > 0);
  const quotesTraceable = evidence.every((item) => {
    const source = transcriptIndex.byUpload.get(item.uploadId) ?? [];
    const artifact = transcriptIndex.sourceArtifactsByUpload.get(item.uploadId)?.[item.sourceType].get(item.sourceId);
    return quoteIsGrounded({ evidence: item, transcript: source, artifact });
  });
  const sourceIdsTraceable = evidence.every((item) => {
    const sourceArtifacts = transcriptIndex.sourceArtifactsByUpload.get(item.uploadId);
    return Boolean(sourceArtifacts?.[item.sourceType]?.has(item.sourceId));
  });
  const datesValid = memories.every((memory) => {
    const dates = evidenceDates(memory);
    const everyEvidenceMatchesManifest = memory.evidence.every((item) => {
      const session = input.sessions.find((candidate) => fixtureUploadId(candidate.sessionId) === item.uploadId);
      return session?.date === item.date;
    });
    return everyEvidenceMatchesManifest && memory.firstSeenDate === dates[0] && memory.lastSeenDate === dates.at(-1);
  });

  const referenceDate = input.dataset.expected.scopeExpectations.referenceDate;
  const reference = dateFromKey(referenceDate);
  if (!reference) {
    throw new Error(`Invalid scope reference date: ${referenceDate}`);
  }
  const weekRange = currentWeekRange(reference);
  const referenceSession = input.sessions.find((session) => session.date === referenceDate) ?? input.sessions.at(-1);
  if (!referenceSession) {
    throw new Error("Fixture replay has no reference session");
  }
  const referenceUploadId = fixtureUploadId(referenceSession.sessionId);
  const currentMemories = input.repository.getRelevantMemories({
    userId: input.userId,
    uploadId: referenceUploadId,
    limit: 10_000
  });
  const weekMemories = input.repository.getRelevantMemories({
    userId: input.userId,
    startDate: weekRange.startKey,
    endDate: weekRange.endKey,
    limit: 10_000
  });
  const allMemories = input.repository.getRelevantMemories({ userId: input.userId, limit: 10_000 });
  const currentIsolated = currentMemories.every((memory) =>
    memory.evidence.every((item) => item.uploadId === referenceUploadId && item.date === referenceDate)
  );

  const allProactive = proactiveByDay.flatMap((day) => day.items);
  const patternDatesValid = allProactive
    .filter((item) => item.insightType === "pattern_observation" || item.type === "memory_pattern")
    .every((item) => {
      const dates = new Set(item.evidenceRefs.map((evidenceRef) => evidenceRef.recordingDate));
      for (const memoryRef of item.memoryRefs ?? []) {
        const memory = memories.find((candidate) => `memory:${candidate.id}` === memoryRef);
        memory?.evidence.forEach((memoryEvidence) => dates.add(memoryEvidence.date));
      }
      return dates.size >= 2;
    });
  const safetyText = [
    ...memories.flatMap((memory) => [memory.title, memory.summary]),
    ...allProactive.flatMap((item) => [item.observation, item.question, item.reason, item.caution ?? ""])
  ].join("\n");
  const forbiddenViolations = forbiddenPatterns.flatMap((pattern) => pattern.test(safetyText) ? [pattern.source] : []);
  const singleDayLongTerm = allProactive.some((item) => {
    if (!longTermPattern.test(`${item.observation} ${item.question} ${item.reason}`)) {
      return false;
    }
    const dates = new Set(item.evidenceRefs.map((evidenceRef) => evidenceRef.recordingDate));
    return dates.size < 2 && (item.memoryRefs ?? []).length === 0;
  });
  const highImportanceGreeting = memories.some(
    (memory) => memory.importanceScore >= 0.7 && memory.evidence.some((item) => ordinaryGreetingPattern.test(item.quote.trim()))
  );

  const must: AssertionResult[] = [
    {
      id: "resume-commitment-created",
      pass: resumeCommitments.some((memory) => memoryHasUpload(memory, day1)),
      detail: "Day 1 resume commitment is persisted as a commitment memory."
    },
    {
      id: "resume-follow-up-linked",
      pass: resumeCommitments.some((memory) => memoryCombinesUploads(memory, [day1, day3])) || memoryPairHasRelation({
        memories,
        relations,
        sourceUploadId: day1,
        targetUploadId: day3,
        accepted: ["follow_up", "related", "repeated"]
      }),
      detail: "Day 3 follows or merges with the Day 1 resume commitment."
    },
    {
      id: "resume-resolution-linked",
      pass: memoryPairHasRelation({
        memories,
        relations,
        sourceUploadId: day1,
        targetUploadId: day6,
        accepted: ["resolved_by", "follow_up"]
      }) || resumeCommitments.some((memory) => memory.status === "resolved" && memoryHasUpload(memory, day1)),
      detail: "Day 6 resolves or follows the original resume commitment with evidence."
    },
    {
      id: "coffee-preference-present",
      pass: coffeePreferences.length > 0,
      detail: "Coffee preference is stored as preference memory."
    },
    {
      id: "coffee-preference-not-fragmented",
      pass: coffeePreferences.some((memory) => memoryCombinesUploads(memory, [day1, day5])) || memoryPairHasRelation({
        memories,
        relations,
        sourceUploadId: day1,
        targetUploadId: day5,
        accepted: ["repeated", "related"]
      }),
      detail: "Repeated coffee preference is merged or explicitly related."
    },
    { id: "memory-evidence-required", pass: allEvidenceHasMemory, detail: "Every memory has evidence." },
    { id: "orphan-evidence-zero", pass: input.orphanEvidenceCount === 0, detail: `Orphan evidence rows: ${input.orphanEvidenceCount}.` },
    { id: "evidence-quote-traceable", pass: quotesTraceable, detail: "Every evidence quote is present in its fixture transcript." },
    { id: "source-id-not-fabricated", pass: sourceIdsTraceable, detail: "Every sourceId resolves to the matching persisted fixture artifact." },
    { id: "memory-dates-correct", pass: datesValid, detail: "Evidence and first/last-seen dates match the manifest." },
    { id: "current-scope-isolated", pass: currentIsolated, detail: "Current scope only contains the reference upload." },
    { id: "multi-date-pattern-requires-two-dates", pass: patternDatesValid, detail: "Pattern observations require at least two dates." },
    { id: "relationship-safety-boundary", pass: forbiddenViolations.length === 0, detail: "No forbidden relationship verdict was persisted." },
    { id: "network-not-accessed", pass: input.networkAttempts === 0, detail: `Network attempts: ${input.networkAttempts}.` }
  ];

  const coffeeRepeated = coffeePreferences.some((memory) => memory.occurrenceCount > 1) || memoryPairHasRelation({
    memories,
    relations,
    sourceUploadId: day1,
    targetUploadId: day5,
    accepted: ["repeated"]
  });
  const museumRelated = memoryPairHasRelation({
    memories,
    relations,
    sourceUploadId: day2,
    targetUploadId: day4,
    accepted: ["follow_up", "related", "contradicted_by"]
  }) && memoryPairHasRelation({
    memories,
    relations,
    sourceUploadId: day4,
    targetUploadId: day8,
    accepted: ["resolved_by", "follow_up", "related"]
  });
  const eventImportance = memories.filter((memory) => memory.type === "event").map((memory) => memory.importanceScore);
  const commitmentImportance = resumeCommitments.map((memory) => memory.importanceScore);
  const weekQaContext = retrieveMemoryIndexEvidence({
    userId: input.userId,
    scope: "week",
    query: "commitment follow-up",
    dateRange: { startDate: weekRange.startKey, endDate: weekRange.endKey },
    repository: input.repository
  });
  const allQaContext = retrieveMemoryIndexEvidence({
    userId: input.userId,
    scope: "all",
    query: "preference commitment relationship",
    repository: input.repository
  });
  const allEvidenceWeeks = new Set(
    allQaContext.evidence.flatMap((item) => {
      const value = dateFromKey(item.date);
      return value ? [currentWeekRange(value).startKey] : [];
    })
  );
  const evasiveCards = await input.store.read<RelationshipSignalCard[]>("relationship-signals", day3) ?? [];
  const should: AssertionResult[] = [
    { id: "coffee-occurrence-or-repeated", pass: coffeeRepeated, detail: "Coffee preference occurrence or repeated relation is present." },
    { id: "museum-plan-related", pass: museumRelated, detail: "Museum adjustment and completion are connected." },
    {
      id: "commitment-more-important-than-chatter",
      pass: commitmentImportance.length > 0 && (eventImportance.length === 0 || Math.max(...commitmentImportance) > Math.min(...eventImportance)),
      detail: "Resume commitment outranks at least one ordinary event."
    },
    { id: "week-recalls-commitment", pass: weekQaContext.memories.some((memory) => memory.type === "commitment"), detail: "Week retrieval returns a commitment." },
    { id: "all-recalls-cross-week-memory", pass: allEvidenceWeeks.size >= 2 && allQaContext.distinctDates.length >= 2, detail: "All retrieval returns evidence from multiple natural weeks." },
    { id: "proactive-insight-concrete", pass: allProactive.length > 0 && allProactive.every((item) => item.evidenceRefs.length > 0), detail: "Proactive insights are evidence-backed." },
    {
      id: "evasive-signal-has-counter-evidence",
      pass: evasiveCards.filter((card) => card.signalType === "evasive_answer").every((card) => Boolean(card.caution && card.counterEvidence?.length)),
      detail: "Any evasive signal preserves caution and counter evidence."
    }
  ];

  const mustNotViolations = [
    ...forbiddenViolations.map((pattern) => `forbidden_text:${pattern}`),
    ...(singleDayLongTerm ? ["single_day_long_term_claim"] : []),
    ...(highImportanceGreeting ? ["high_importance_greeting"] : []),
    ...(input.networkAttempts > 0 ? ["network_access"] : [])
  ];

  const scopeChecks = {
    referenceUploadId,
    referenceDate,
    current: {
      memoryCount: currentMemories.length,
      dates: [...new Set(currentMemories.flatMap((memory) => memory.evidence.map((item) => item.date)))].sort(),
      isolated: currentIsolated
    },
    week: {
      range: { start: weekRange.startKey, end: weekRange.endKey },
      memoryCount: weekMemories.length,
      dates: [...new Set(weekMemories.flatMap((memory) => memory.evidence.map((item) => item.date)))].sort(),
      qaMemoryCount: weekQaContext.count,
      qaEvidenceCount: weekQaContext.evidence.length
    },
    all: {
      memoryCount: allMemories.length,
      dates: [...new Set(allMemories.flatMap((memory) => memory.evidence.map((item) => item.date)))].sort(),
      qaMemoryCount: allQaContext.count,
      qaEvidenceCount: allQaContext.evidence.length
    }
  };

  const deterministicData = {
    datasetVersion: input.dataset.manifest.datasetVersion,
    userId: input.userId,
    dayResults: input.dayResults,
    memories,
    evidence,
    orphanEvidenceCount: input.orphanEvidenceCount,
    relations,
    scopeChecks,
    proactiveByDay,
    must,
    should,
    mustNotViolations
  };
  const pass = must.every((assertion) => assertion.pass) && mustNotViolations.length === 0;
  return {
    datasetVersion: input.dataset.manifest.datasetVersion,
    userId: input.userId,
    execution: {
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      networkAttempts: input.networkAttempts
    },
    dayByDay: input.dayResults,
    finalMemoryItems: memories,
    memoryEvidence: evidence,
    orphanEvidenceCount: input.orphanEvidenceCount,
    relations,
    scopeChecks,
    proactiveInsights: proactiveByDay,
    must,
    should,
    mustNotViolations,
    pass,
    warnings: should.filter((assertion) => !assertion.pass).map((assertion) => assertion.id),
    deterministicDigest: stableDigest(deterministicData),
    selectedSessions: input.sessions.map((session) => ({
      sessionId: session.sessionId,
      date: session.date,
      manifestUserId: sessionById.get(session.sessionId)?.userId
    }))
  };
}
