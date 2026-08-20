import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import {
  AudioInsightSchema,
  AudioUploadSchema,
  BriefItemSchema,
  RelationshipSignalCardSchema,
  SemanticSegmentSchema,
  TranscriptSegmentSchema,
  type AudioInsight,
  type BriefItem,
  type RelationshipSignalCard,
  type SemanticSegment,
  type TranscriptSegment
} from "@/lib/domain/types";
import {
  buildMemoryContextPayload,
  weekRangeForMemoryContext,
  type MemoryContextPayload
} from "@/lib/client/memory-context";
import type { LocalDayPayload } from "@/lib/client/local-analysis";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import type { MemoryItem } from "@/lib/server/memory/types";
import { JsonStore } from "@/lib/server/storage/json-store";
import {
  retrieveMemoryIndexEvidence,
  type MemoryIndexQaContext
} from "../memory-index-evidence";
import {
  buildCanonicalQaEvidence,
  retrieveQaEvidence,
  type AnswerQuestionWithAIInput,
  type QaRetrievedEvidence
} from "../ai-qa";
import {
  indexCanonicalEvidence,
  retrieveDenseEvidence
} from "./dense-retrieval";
import type { EmbeddingProvider } from "./embedding-provider";
import { scoreHybridEvidenceCandidates } from "./evidence-ranking";
import {
  generateHybridCandidates,
  hybridCandidateCitationValidity
} from "./hybrid-candidates";
import { SqliteEmbeddingIndex } from "./embedding-index";
import { parseHybridQuery } from "./query-parser";
import type {
  EvidenceRankingMetadata,
  HybridMemoryType
} from "./types";

const BenchmarkReportSchema = z.object({
  version: z.number(),
  kind: z.string(),
  source: z.object({
    isolatedRuntime: z.string(),
    userId: z.string(),
    days: z.array(z.object({
      day: z.string(),
      date: z.string(),
      uploadId: z.string()
    }))
  }),
  results: z.array(z.object({
    id: z.string(),
    scope: z.enum(["current", "week", "all"]),
    category: z.string(),
    question: z.string(),
    currentDay: z.string().nullable().optional(),
    referenceDate: z.string().nullable().optional(),
    retrievalEvaluable: z.boolean(),
    retrievalFailures: z.array(z.string()).default([]),
    expectedEvidence: z.array(z.object({
      day: z.string(),
      matchedSegmentIds: z.array(z.string()).default([])
    })).default([]),
    retrievedTopK: z.array(z.object({
      id: z.string(),
      kind: z.enum(["brief", "semantic", "audio", "audio_emotion", "raw", "relationship_signal"]),
      title: z.string(),
      startSeconds: z.number(),
      endSeconds: z.number(),
      sourceSegmentIds: z.array(z.string()),
      priority: z.number()
    })).default([])
  }))
});

type BenchmarkSourceReport = z.infer<typeof BenchmarkReportSchema>;
type BenchmarkSourceCase = BenchmarkSourceReport["results"][number];

type LoadedDay = {
  day: string;
  date: string;
  uploadId: string;
  payload: LocalDayPayload;
};

export type HybridBenchmarkCase = {
  id: string;
  scope: "current" | "week" | "all";
  category: string;
  question: string;
  retrievalFailures: string[];
  retrievalEvaluable: boolean;
  expectedGroups: string[][];
  qaInput: AnswerQuestionWithAIInput;
  canonicalEvidence: QaRetrievedEvidence[];
  currentCandidates: QaRetrievedEvidence[];
  historicalCandidates: QaRetrievedEvidence[];
  currentLatencyMs: number;
  missingExpectedGroups: string[][];
  metadata: Map<string, EvidenceRankingMetadata>;
  scopeDateRange?: {
    startDate: string;
    endDate: string;
  };
};

export type HybridBenchmarkSystemMetrics = {
  recallAt10: number;
  recallAt30: number;
  mrr: number;
  citationValidity: number;
  recoveredRetrievalMisses: number;
};

export type HybridBenchmarkReport = {
  version: 1;
  kind: "daily_brief_hybrid_retrieval_benchmark";
  generatedAt: string;
  model: EmbeddingProvider["config"];
  indexing: {
    total: number;
    embedded: number;
    unchanged: number;
    removed: number;
  };
  baselineSource: {
    reportPath: string;
    runtimePath: string;
    caseCount: number;
    evaluableCaseCount: number;
    completeRetrievalMisses: number;
  };
  systems: {
    baseline: HybridBenchmarkSystemMetrics;
    dense: HybridBenchmarkSystemMetrics;
    hybrid: HybridBenchmarkSystemMetrics;
    hybridRanking: HybridBenchmarkSystemMetrics;
  };
  categories: Record<string, {
    baseline: HybridBenchmarkSystemMetrics;
    dense: HybridBenchmarkSystemMetrics;
    hybrid: HybridBenchmarkSystemMetrics;
    hybridRanking: HybridBenchmarkSystemMetrics;
  }>;
  cases: Array<{
    id: string;
    scope: string;
    category: string;
    temporal: boolean;
    failures: string[];
    expectedGroupCount: number;
    baselineIds: string[];
    denseIds: string[];
    hybridIds: string[];
    hybridRankingIds: string[];
  }>;
  caveats: string[];
};

type SystemCandidates = {
  baseline: QaRetrievedEvidence[];
  dense: QaRetrievedEvidence[];
  hybrid: QaRetrievedEvidence[];
  hybridRanking: QaRetrievedEvidence[];
};

function candidateFromReport(
  item: BenchmarkSourceCase["retrievedTopK"][number],
  canonicalById: ReadonlyMap<string, QaRetrievedEvidence>
): QaRetrievedEvidence {
  return canonicalById.get(item.id) ?? {
    ...item,
    text: "",
    sourceSegmentIds: [...item.sourceSegmentIds]
  };
}

async function loadDay(input: {
  userRoot: string;
  day: string;
  date: string;
  uploadId: string;
}): Promise<LoadedDay> {
  const store = new JsonStore(input.userRoot);
  const [upload, segments, audioInsights, semanticSegments, briefItems, relationshipSignals] =
    await Promise.all([
      store.read("uploads", input.uploadId).then((value) => AudioUploadSchema.parse(value)),
      store.read("segments", input.uploadId).then((value) =>
        z.array(TranscriptSegmentSchema).parse(value)
      ),
      store.read("audio-insights", input.uploadId).then((value) =>
        z.array(AudioInsightSchema).parse(value ?? [])
      ),
      store.read("semantic-segments", input.uploadId).then((value) =>
        z.array(SemanticSegmentSchema).parse(value ?? [])
      ),
      store.read("brief-items", input.uploadId).then((value) =>
        z.array(BriefItemSchema).parse(value ?? [])
      ),
      store.read("relationship-signals", input.uploadId).then((value) =>
        z.array(RelationshipSignalCardSchema).parse(value ?? [])
      )
    ]);
  return {
    day: input.day,
    date: input.date,
    uploadId: input.uploadId,
    payload: {
      upload,
      segments,
      audioInsights,
      semanticSegments,
      semanticSegmentsAvailable: true,
      briefItems,
      relationshipSignals,
      relationshipSignalsAvailable: true
    }
  };
}

export function buildHybridBenchmarkScopedQaInput(input: {
  userId: string;
  question: string;
  scope: "week" | "all";
  context: MemoryContextPayload;
  memoryContext?: MemoryIndexQaContext;
}): AnswerQuestionWithAIInput {
  return {
    userId: input.userId,
    uploadId: input.context.uploadId,
    question: input.question,
    scope: input.scope,
    segments: input.context.segments,
    audioInsights: input.context.audioInsights,
    semanticSegments: input.context.semanticSegments,
    briefItems: input.context.briefItems,
    relationshipSignals: input.context.relationshipSignals,
    ...(input.memoryContext && input.memoryContext.count > 0
      ? { memoryContext: input.memoryContext }
      : {})
  };
}

function qaInputForCase(
  source: BenchmarkSourceCase,
  days: readonly LoadedDay[],
  input: {
    userId: string;
    memoryRepository: ReturnType<typeof createMemoryRepository>;
  }
) {
  if (source.scope === "current") {
    const day = days.find((item) => item.day === source.currentDay);
    if (!day) throw new Error(`Benchmark case ${source.id} references an unknown current day`);
    return {
      userId: input.userId,
      uploadId: day.uploadId,
      question: source.question,
      scope: "current" as const,
      segments: day.payload.segments,
      audioInsights: day.payload.audioInsights,
      semanticSegments: day.payload.semanticSegments,
      briefItems: day.payload.briefItems,
      relationshipSignals: day.payload.relationshipSignals ?? []
    };
  }
  const referenceDate =
    source.referenceDate ??
    days.map((item) => item.date).sort().at(-1);
  if (!referenceDate) throw new Error(`Benchmark case ${source.id} has no reference date`);
  const context = buildMemoryContextPayload({
    scope: source.scope,
    referenceDate,
    payloads: days.map((item) => item.payload)
  });
  if (!context) throw new Error(`Benchmark case ${source.id} produced no scoped context`);
  const dateRange = scopeDateRangeForCase(source, days);
  const memoryContext = retrieveMemoryIndexEvidence({
    userId: input.userId,
    scope: source.scope,
    query: source.question,
    ...(dateRange ? { dateRange } : {}),
    repository: input.memoryRepository
  });
  return buildHybridBenchmarkScopedQaInput({
    userId: input.userId,
    question: source.question,
    scope: source.scope,
    context,
    memoryContext
  });
}

function scopeDateRangeForCase(
  source: BenchmarkSourceCase,
  days: readonly LoadedDay[]
) {
  if (source.scope === "all") return undefined;
  if (source.scope === "current") {
    const day = days.find((item) => item.day === source.currentDay);
    return day ? { startDate: day.date, endDate: day.date } : undefined;
  }
  const referenceDate =
    source.referenceDate ??
    days.map((item) => item.date).sort().at(-1);
  if (!referenceDate) return undefined;
  const range = weekRangeForMemoryContext(referenceDate);
  return { startDate: range.startKey, endDate: range.endKey };
}

function memoryMetadataBySource(memories: readonly MemoryItem[]) {
  const bySource = new Map<string, MemoryItem[]>();
  for (const memory of memories) {
    for (const evidence of memory.evidence) {
      const current = bySource.get(evidence.sourceId) ?? [];
      current.push(memory);
      bySource.set(evidence.sourceId, current);
    }
  }
  return bySource;
}

function preferredMemoryStatus(memories: readonly MemoryItem[]) {
  if (memories.some((memory) => memory.status === "resolved")) return "resolved" as const;
  if (memories.some((memory) => memory.status === "active")) return "active" as const;
  if (memories.some((memory) => memory.status === "superseded")) return "superseded" as const;
  return memories.some((memory) => memory.status === "expired") ? "expired" as const : undefined;
}

function rankingMetadata(input: {
  evidence: readonly QaRetrievedEvidence[];
  segmentById: ReadonlyMap<string, TranscriptSegment>;
  dateBySegmentId: ReadonlyMap<string, string>;
  memoriesBySourceId: ReadonlyMap<string, MemoryItem[]>;
  ownersByMemoryId: ReadonlyMap<string, string[]>;
}) {
  const result = new Map<string, EvidenceRankingMetadata>();
  for (const evidence of input.evidence) {
    const sourceIds = new Set([evidence.id, ...evidence.sourceSegmentIds]);
    const memories = [...sourceIds].flatMap((sourceId) =>
      input.memoriesBySourceId.get(sourceId) ?? []
    );
    const uniqueMemories = [...new Map(memories.map((memory) => [memory.id, memory])).values()];
    const memoryTypes = [...new Set(uniqueMemories.map((memory) => memory.type))] as HybridMemoryType[];
    const recordingDate = evidence.sourceSegmentIds
      .map((sourceId) => input.dateBySegmentId.get(sourceId))
      .find(Boolean);
    const sourceSegments = evidence.sourceSegmentIds.flatMap((sourceId) => {
      const segment = input.segmentById.get(sourceId);
      return segment ? [segment] : [];
    });
    const firstSource = sourceSegments[0];
    const speakers = [...new Set(sourceSegments.flatMap((segment) => [
      ...(segment.speaker ? [segment.speaker] : []),
      ...(segment.identity?.globalSpeakerId ? [segment.identity.globalSpeakerId] : []),
      ...(segment.identity?.displayName ? [segment.identity.displayName] : [])
    ]))];
    const owners = [...new Set(uniqueMemories.flatMap((memory) =>
      input.ownersByMemoryId.get(memory.id) ?? []
    ))];
    const textEntities = [
      ...`${evidence.title} ${evidence.text}`.matchAll(/\b[A-Z][A-Za-z0-9_-]{1,31}\b/gu)
    ].map((match) => match[0]);
    result.set(evidence.id, {
      ...(recordingDate ? { recordingDate } : {}),
      ...(firstSource?.uploadId ? { recordingId: firstSource.uploadId } : {}),
      ...(firstSource
        ? { segmentOrder: firstSource.startSeconds }
        : {}),
      ...(textEntities.length > 0 ? { entities: [...new Set(textEntities)] } : {}),
      ...(speakers.length > 0 ? { speakers, entityAliases: speakers } : {}),
      ...(owners.length > 0 ? { owners } : {}),
      relationshipSourceValid:
        evidence.sourceSegmentIds.length > 0 &&
        sourceSegments.length === evidence.sourceSegmentIds.length,
      ...(memoryTypes[0] ? { memoryType: memoryTypes[0], memoryTypes } : {}),
      ...(preferredMemoryStatus(uniqueMemories)
        ? { memoryStatus: preferredMemoryStatus(uniqueMemories) }
        : {}),
      ...(uniqueMemories.length > 0
        ? {
            occurrenceCount: Math.max(...uniqueMemories.map((memory) => memory.occurrenceCount)),
            distinctDates: Math.max(
              ...uniqueMemories.map((memory) =>
                new Set(memory.evidence.map((item) => item.date)).size
              )
            ),
            importanceScore: Math.max(
              ...uniqueMemories.map((memory) => memory.importanceScore)
            )
          }
        : {})
    });
  }
  return result;
}

export async function loadHybridBenchmarkCases(input: {
  reportPath: string;
  runtimePath?: string;
}) {
  const reportPath = resolve(input.reportPath);
  const reportText = await readFile(reportPath, "utf8");
  const report = BenchmarkReportSchema.parse(JSON.parse(reportText));
  const runtimePath = resolve(input.runtimePath ?? report.source.isolatedRuntime);
  const userRoot = resolve(runtimePath, "users", report.source.userId);
  const days = await Promise.all(report.source.days.map((day) =>
    loadDay({ userRoot, ...day })
  ));
  const dateBySegmentId = new Map(
    days.flatMap((day) => day.payload.segments.map((segment) => [segment.id, day.date] as const))
  );
  const segmentById = new Map(
    days.flatMap((day) => day.payload.segments.map((segment) => [segment.id, segment] as const))
  );
  const memoryDatabase = new Database(resolve(runtimePath, "memory.sqlite"), {
    readonly: true,
    fileMustExist: true
  });
  const memoryRepository = createMemoryRepository(memoryDatabase);
  const memories = memoryRepository.getRelevantMemories({
    userId: report.source.userId,
    limit: 10_000
  });
  const memoriesBySourceId = memoryMetadataBySource(memories);
  const ownerMetadata = memoryRepository.getMemoryOwnerAttributions(
    report.source.userId,
    memories.map((memory) => memory.id)
  );
  const ownersByMemoryId = new Map(ownerMetadata.map((item) => [
    item.memoryId,
    [
      ...(item.owner.identityId ? [item.owner.identityId] : []),
      ...item.participants.flatMap((participant) =>
        participant.attribution.identityId ? [participant.attribution.identityId] : []
      )
    ]
  ]));
  const fixtureHash = createHash("sha256")
    .update(reportText)
    .update(JSON.stringify(days.map((day) => day.payload)))
    .update(JSON.stringify(memories))
    .update(JSON.stringify(ownerMetadata))
    .digest("hex");

  try {
    const cases: HybridBenchmarkCase[] = report.results.map((source) => {
      const qaInput = qaInputForCase(source, days, {
        userId: report.source.userId,
        memoryRepository
      });
      const canonicalEvidence = buildCanonicalQaEvidence(qaInput);
      const canonicalById = new Map(canonicalEvidence.map((item) => [item.id, item]));
      const currentStartedAt = performance.now();
      const currentCandidates = retrieveQaEvidence(qaInput);
      const currentLatencyMs = performance.now() - currentStartedAt;
      const expectedGroups = source.expectedEvidence
        .map((group) => [...new Set(group.matchedSegmentIds)])
        .filter((group) => group.length > 0);
      const canonicalSourceIds = new Set(
        canonicalEvidence.flatMap((evidence) => evidence.sourceSegmentIds)
      );
      return {
        id: source.id,
        scope: source.scope,
        category: source.category,
        question: source.question,
        retrievalFailures: source.retrievalFailures,
        retrievalEvaluable: source.retrievalEvaluable,
        expectedGroups,
        qaInput,
        canonicalEvidence,
        currentCandidates,
        historicalCandidates: source.retrievedTopK.map((item) =>
          candidateFromReport(item, canonicalById)
        ),
        currentLatencyMs,
        missingExpectedGroups: expectedGroups.filter((group) =>
          !group.some((id) => canonicalSourceIds.has(id))
        ),
        scopeDateRange: scopeDateRangeForCase(source, days),
        metadata: rankingMetadata({
          evidence: canonicalEvidence,
          segmentById,
          dateBySegmentId,
          memoriesBySourceId,
          ownersByMemoryId
        })
      };
    });
    return {
      reportPath,
      runtimePath,
      source: report,
      cases,
      fixtureHash,
      memories,
      ownersByMemoryId: new Map(ownerMetadata.map((item) => [item.memoryId, item]))
    };
  } finally {
    memoryDatabase.close();
  }
}

function expectedSourceIds(item: HybridBenchmarkCase) {
  return new Set(item.expectedGroups.flat());
}

function retrievedGroupCount(item: HybridBenchmarkCase, candidates: readonly QaRetrievedEvidence[], limit: number) {
  const retrievedIds = new Set(candidates.slice(0, limit).flatMap((candidate) =>
    candidate.sourceSegmentIds
  ));
  return item.expectedGroups.filter((group) => group.some((id) => retrievedIds.has(id))).length;
}

function firstExpectedRank(item: HybridBenchmarkCase, candidates: readonly QaRetrievedEvidence[]) {
  const expectedIds = expectedSourceIds(item);
  const index = candidates.findIndex((candidate) =>
    candidate.sourceSegmentIds.some((id) => expectedIds.has(id))
  );
  return index < 0 ? null : index + 1;
}

function systemMetrics(input: {
  cases: readonly HybridBenchmarkCase[];
  candidates: ReadonlyMap<string, readonly QaRetrievedEvidence[]>;
}) {
  const evaluable = input.cases.filter((item) =>
    item.retrievalEvaluable && item.expectedGroups.length > 0
  );
  const totalGroups = evaluable.reduce((sum, item) => sum + item.expectedGroups.length, 0);
  const retrievedAt10 = evaluable.reduce((sum, item) =>
    sum + retrievedGroupCount(item, input.candidates.get(item.id) ?? [], 10), 0
  );
  const retrievedAt30 = evaluable.reduce((sum, item) =>
    sum + retrievedGroupCount(item, input.candidates.get(item.id) ?? [], 30), 0
  );
  const reciprocalRanks = evaluable.map((item) => {
    const rank = firstExpectedRank(item, input.candidates.get(item.id) ?? []);
    return rank ? 1 / rank : 0;
  });
  const validCounts = input.cases.map((item) => {
    const candidates = input.candidates.get(item.id) ?? [];
    const canonicalById = new Map(item.canonicalEvidence.map((evidence) => [evidence.id, evidence]));
    const valid = candidates.filter((candidate) => {
      const canonical = canonicalById.get(candidate.id);
      return Boolean(
        canonical &&
        canonical.sourceSegmentIds.length === candidate.sourceSegmentIds.length &&
        canonical.sourceSegmentIds.every((id, index) => id === candidate.sourceSegmentIds[index])
      );
    }).length;
    return { valid, total: candidates.length };
  });
  const completeMisses = evaluable.filter((item) =>
    item.retrievalFailures.includes("retrieval_miss")
  );
  const recoveredRetrievalMisses = completeMisses.filter((item) =>
    retrievedGroupCount(item, input.candidates.get(item.id) ?? [], 30) === item.expectedGroups.length
  ).length;
  const validTotal = validCounts.reduce((sum, item) => sum + item.valid, 0);
  const candidateTotal = validCounts.reduce((sum, item) => sum + item.total, 0);

  return {
    recallAt10: totalGroups === 0 ? 0 : retrievedAt10 / totalGroups,
    recallAt30: totalGroups === 0 ? 0 : retrievedAt30 / totalGroups,
    mrr: reciprocalRanks.length === 0
      ? 0
      : reciprocalRanks.reduce((sum, value) => sum + value, 0) / reciprocalRanks.length,
    citationValidity: candidateTotal === 0 ? 1 : validTotal / candidateTotal,
    recoveredRetrievalMisses
  };
}

function metricsForSystems(
  cases: readonly HybridBenchmarkCase[],
  candidatesByCase: ReadonlyMap<string, SystemCandidates>
) {
  const forSystem = (system: keyof SystemCandidates) => new Map(
    cases.map((item) => [item.id, candidatesByCase.get(item.id)?.[system] ?? []])
  );
  return {
    baseline: systemMetrics({ cases, candidates: forSystem("baseline") }),
    dense: systemMetrics({ cases, candidates: forSystem("dense") }),
    hybrid: systemMetrics({ cases, candidates: forSystem("hybrid") }),
    hybridRanking: systemMetrics({ cases, candidates: forSystem("hybridRanking") })
  };
}

export async function runHybridRetrievalBenchmark(input: {
  reportPath: string;
  runtimePath?: string;
  provider: EmbeddingProvider;
  index: SqliteEmbeddingIndex;
  batchSize?: number;
}): Promise<HybridBenchmarkReport> {
  const loaded = await loadHybridBenchmarkCases({
    reportPath: input.reportPath,
    runtimePath: input.runtimePath
  });
  const embeddingCorpus = [...new Map(
    loaded.cases
      .flatMap((item) => item.canonicalEvidence)
      .sort((left, right) => right.text.length - left.text.length)
      .map((item) => [item.id, item])
  ).values()];
  const indexing = await indexCanonicalEvidence({
    evidence: embeddingCorpus,
    provider: input.provider,
    index: input.index,
    batchSize: input.batchSize
  });
  const candidatesByCase = new Map<string, SystemCandidates>();

  for (const item of loaded.cases) {
    const dense = await retrieveDenseEvidence({
      question: item.question,
      evidence: item.canonicalEvidence,
      provider: input.provider,
      index: input.index,
      limit: 30,
      contentHashPolicy: "object_id"
    });
    const hybrid = generateHybridCandidates({
      question: item.question,
      evidence: item.canonicalEvidence,
      denseCandidates: dense,
      currentCandidates: item.currentCandidates,
      metadata: item.metadata,
      limit: 30
    });
    if (!hybridCandidateCitationValidity(hybrid, item.canonicalEvidence)) {
      throw new Error(`Hybrid candidate citation boundary failed for case ${item.id}`);
    }
    const ranked = scoreHybridEvidenceCandidates({
      question: item.question,
      candidates: hybrid,
      metadata: item.metadata
    });
    candidatesByCase.set(item.id, {
      baseline: item.currentCandidates,
      dense: dense.map((candidate) => candidate.evidence),
      hybrid: hybrid.map((candidate) => candidate.evidence),
      hybridRanking: ranked.map((candidate) => candidate.evidence)
    });
  }

  const systems = metricsForSystems(loaded.cases, candidatesByCase);
  const baselineCanonicalDrift =
    systems.baseline.citationValidity < 1
      ? [
          `The frozen baseline reproduces ${(systems.baseline.citationValidity * 100).toFixed(1)}% ` +
          "of candidate identities/sourceSegmentIds in the currently reconstructed Canonical Evidence; " +
          "treat its citation validity as a fixture/code drift diagnostic."
        ]
      : [];
  const categories = new Set(loaded.cases.map((item) => item.category));
  if (loaded.cases.some((item) => parseHybridQuery(item.question).types.includes("temporal"))) {
    categories.add("temporal");
  }
  const categoryMetrics: HybridBenchmarkReport["categories"] = {};
  for (const category of [...categories].sort()) {
    const cases = category === "temporal"
      ? loaded.cases.filter((item) => parseHybridQuery(item.question).types.includes("temporal"))
      : loaded.cases.filter((item) => item.category === category);
    categoryMetrics[category] = metricsForSystems(cases, candidatesByCase);
  }

  return {
    version: 1,
    kind: "daily_brief_hybrid_retrieval_benchmark",
    generatedAt: new Date().toISOString(),
    model: input.provider.config,
    indexing,
    baselineSource: {
      reportPath: loaded.reportPath,
      runtimePath: loaded.runtimePath,
      caseCount: loaded.cases.length,
      evaluableCaseCount: loaded.cases.filter((item) => item.retrievalEvaluable).length,
      completeRetrievalMisses: loaded.cases.filter((item) =>
        item.retrievalFailures.includes("retrieval_miss")
      ).length
    },
    systems,
    categories: categoryMetrics,
    cases: loaded.cases.map((item) => {
      const candidates = candidatesByCase.get(item.id)!;
      return {
        id: item.id,
        scope: item.scope,
        category: item.category,
        temporal: parseHybridQuery(item.question).types.includes("temporal"),
        failures: item.retrievalFailures,
        expectedGroupCount: item.expectedGroups.length,
        baselineIds: candidates.baseline.map((candidate) => candidate.id),
        denseIds: candidates.dense.map((candidate) => candidate.id),
        hybridIds: candidates.hybrid.map((candidate) => candidate.id),
        hybridRankingIds: candidates.hybridRanking.map((candidate) => candidate.id)
      };
    }),
    caveats: [
      "Hybrid systems run in shadow only and do not enter QA.",
      "Recall is computed over expected evidence groups with at least one retained source segment.",
      "Week/all baseline retrieval includes the same query-scoped SQLite Memory context as production Current Retrieval.",
      "Baseline exposes at most the existing Top-16, so its Recall@30 is bounded by that frozen list.",
      "Hybrid+Ranking Recall@30 uses the ranked candidate pool; production QA remains capped at Top-16.",
      "Citation validity checks candidate identity and sourceSegmentIds against Canonical Evidence; no citations are generated.",
      ...baselineCanonicalDrift
    ]
  };
}
