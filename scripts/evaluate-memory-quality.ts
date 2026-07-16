import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type {
  AudioInsight,
  BriefItem,
  RelationshipSignalCard,
  SemanticSegment,
  TranscriptSegment
} from "@/lib/domain/types";
import { RawRelationshipSignalItemSchema } from "@/lib/processing/relationship-signals";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { extractUploadMemoriesWithAudit } from "@/lib/server/memory/extractor";
import { calculateImportance } from "@/lib/server/memory/importance";
import { detectMemoryRelationsWithAudit } from "@/lib/server/memory/relations";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import {
  RelationshipSignalCandidateSchema,
  reduceRelationshipSignalCandidates
} from "@/lib/server/relationship-signals/candidates";

type Options = {
  dataRoot: string;
  userId: string;
  uploadId: string;
  recordingDate: string;
  output: string;
  baseline?: string;
};

function value(argv: string[], index: number, flag: string) {
  const result = argv[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value`);
  return result;
}

function parseArgs(argv: string[]): Options {
  const parsed: Partial<Options> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = value(argv, index, flag);
    index += 1;
    if (flag === "--data-root") parsed.dataRoot = next;
    else if (flag === "--user") parsed.userId = next;
    else if (flag === "--upload") parsed.uploadId = next;
    else if (flag === "--date") parsed.recordingDate = next;
    else if (flag === "--output") parsed.output = next;
    else if (flag === "--baseline") parsed.baseline = next;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  for (const key of ["dataRoot", "userId", "uploadId", "recordingDate", "output"] as const) {
    if (!parsed[key]) throw new Error(`Missing required option: ${key}`);
  }
  return parsed as Options;
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function chunkIndex(card: RelationshipSignalCard) {
  const indexes = card.evidenceSegments.flatMap((evidence) => {
    const match = evidence.segmentId.match(/_chunk_(\d+)_seg_/u);
    return match ? [Number.parseInt(match[1], 10)] : [];
  });
  return indexes.length > 0 ? Math.min(...indexes) : Math.floor(card.timeRange.startSeconds / 300);
}

function cardCandidate(card: RelationshipSignalCard) {
  const index = chunkIndex(card);
  return RelationshipSignalCandidateSchema.parse({
    id: `${card.id}_quality_replay_candidate`,
    uploadId: card.uploadId,
    transcriptChunkId: `${card.uploadId}_quality_replay_chunk_${String(index).padStart(5, "0")}`,
    chunkIndex: index,
    item: RawRelationshipSignalItemSchema.parse({
      signalType: card.signalType,
      signalCategory: card.signalCategory,
      severity: card.severity,
      confidence: card.confidence,
      summary: card.summary,
      explanation: card.explanation,
      involvedSpeakers: card.involvedSpeakers,
      evidenceSegmentIds: card.evidenceSegments.map((evidence) => evidence.segmentId),
      evidenceSegments: [],
      counterEvidence: card.counterEvidence ?? [],
      acousticEvidence: card.acousticEvidence ?? [],
      textEvidence: card.textEvidence,
      interactionEvidence: card.interactionEvidence ?? [],
      suggestedReflection: card.suggestedReflection,
      caution: card.caution
    })
  });
}

function distribution<T extends string>(values: T[]) {
  return Object.fromEntries(
    [...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length])
  );
}

async function main() {
  if (process.env.NODE_ENV !== "test" && process.env.NODE_ENV !== "development") {
    throw new Error("Memory quality evaluation is only available in development or test");
  }
  const options = parseArgs(process.argv.slice(2));
  const userRoot = resolve(options.dataRoot, "users", options.userId);
  const artifact = <T>(collection: string) => json<T>(join(userRoot, collection, `${options.uploadId}.json`));
  const [segments, briefItems, semanticSegments, audioInsights, relationshipSignals, baseline] = await Promise.all([
    artifact<TranscriptSegment[]>("segments"),
    artifact<BriefItem[]>("brief-items"),
    artifact<SemanticSegment[]>("semantic-segments"),
    artifact<AudioInsight[]>("audio-insights"),
    artifact<RelationshipSignalCard[]>("relationship-signals"),
    options.baseline ? json<Record<string, unknown>>(resolve(options.baseline)) : Promise.resolve(undefined)
  ]);

  let networkAttempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkAttempts += 1;
    throw new Error("Network access is disabled during memory quality evaluation");
  }) as typeof fetch;
  const database = openMemoryDatabase({ filePath: ":memory:" });
  try {
    const reduced = reduceRelationshipSignalCandidates({
      uploadId: options.uploadId,
      recordingDate: options.recordingDate,
      candidates: relationshipSignals.map(cardCandidate),
      segments,
      semanticSegments,
      audioInsights,
      createdAt: relationshipSignals[0]?.createdAt ?? `${options.recordingDate}T00:00:00.000Z`
    });
    const extraction = extractUploadMemoriesWithAudit({
      userId: options.userId,
      uploadId: options.uploadId,
      recordingDate: options.recordingDate,
      segments,
      briefItems,
      semanticSegments,
      relationshipSignals: reduced.cards,
      now: `${options.recordingDate}T00:00:00.000Z`
    });
    const repository = createMemoryRepository(database);
    const write = repository.replaceUploadMemories({
      userId: options.userId,
      uploadId: options.uploadId,
      sourceSegments: segments,
      memories: extraction.memories
    });
    const memories = repository.getRelevantMemories({ userId: options.userId, limit: 10_000 });
    const relations = repository.getMemoryRelations(options.userId);
    const relationAudit = detectMemoryRelationsWithAudit(memories).audit;
    const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
    const allEvidence = memories.flatMap((memory) => memory.evidence);
    const invalidSourceIds = allEvidence.filter((evidence) =>
      evidence.sourceType === "transcript" && !segmentById.has(evidence.sourceId)
    );
    const nonVerbatimQuotes = allEvidence.filter((evidence) => {
      const segment = evidence.sourceType === "transcript" ? segmentById.get(evidence.sourceId) : undefined;
      return segment ? !segment.text.includes(evidence.quote) : !segments.some((item) => item.text.includes(evidence.quote));
    });
    const duplicateEvidence = memories.flatMap((memory) => {
      const seen = new Set<string>();
      return memory.evidence.filter((evidence) => {
        const key = `${evidence.sourceType}\u001f${evidence.sourceId}`;
        if (seen.has(key)) return true;
        seen.add(key);
        return false;
      });
    });
    const orphanEvidence = Number((database.prepare(`
      SELECT COUNT(*) AS count FROM memory_evidence e
      LEFT JOIN memory_items m ON m.id = e.memory_id WHERE m.id IS NULL
    `).get() as { count: number }).count);
    const importanceAudit = memories.map((memory) => ({
      memoryId: memory.id,
      type: memory.type,
      ...calculateImportance({
        type: memory.type,
        title: memory.title,
        summary: memory.summary,
        status: memory.status,
        occurrenceCount: memory.occurrenceCount,
        evidenceDates: memory.evidence.map((evidence) => evidence.date),
        evidenceSourceTypes: memory.evidence.map((evidence) => evidence.sourceType),
        evidenceCount: memory.evidence.length
      })
    }));
    const highImportance = memories.filter((memory) => memory.importanceScore >= 0.7).length;
    const evidenceAudit = {
      count: allEvidence.length,
      invalidSourceIds: invalidSourceIds.length,
      nonVerbatimQuotes: nonVerbatimQuotes.length,
      duplicateEvidence: duplicateEvidence.length,
      memoriesWithoutEvidence: memories.filter((memory) => memory.evidence.length === 0).length,
      orphanEvidence
    };
    const report = {
      mode: "deterministic_persisted_card_replay",
      limitation: "The historical run retained 15 reduced cards, not all 22 raw candidates.",
      uploadId: options.uploadId,
      recordingDate: options.recordingDate,
      baseline,
      relationship: {
        persistedCardInputs: relationshipSignals.length,
        clusterCount: reduced.audit.clusterCount,
        mergedCount: reduced.audit.mergedCount,
        selectedCards: reduced.cards.length,
        rejectedClusters: reduced.audit.rejectedCount,
        typeDistribution: distribution(reduced.cards.map((card) => card.signalType)),
        audit: reduced.audit
      },
      memory: {
        candidateCount: extraction.audit.candidateCount,
        persistedInputCount: extraction.audit.persistedCount,
        finalCount: memories.length,
        mergedCount: write.mergedCount,
        typeDistribution: distribution(memories.map((memory) => memory.type)),
        relationshipSignalCount: memories.filter((memory) => memory.type === "relationship_signal").length,
        preferenceCount: memories.filter((memory) => memory.type === "preference").length,
        importanceDistribution: {
          high: highImportance,
          medium: memories.filter((memory) => memory.importanceScore >= 0.4 && memory.importanceScore < 0.7).length,
          low: memories.filter((memory) => memory.importanceScore < 0.4).length
        },
        admissionAudit: extraction.audit,
        importanceAudit,
        items: memories
      },
      relations: { count: relations.length, items: relations, audit: relationAudit },
      evidence: evidenceAudit,
      networkAttempts,
      checks: {
        preferencePersisted: memories.some((memory) => memory.type === "preference"),
        relationshipCardsRemainDailyArtifacts: reduced.cards.length >= memories.filter((memory) => memory.type === "relationship_signal").length,
        evidenceFirst: Object.entries(evidenceAudit).every(([key, count]) => key === "count" || count === 0),
        schemaCompatible: true
      }
    };
    const output = resolve(options.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify({
      output,
      cards: reduced.cards.length,
      memories: memories.length,
      relationshipMemories: report.memory.relationshipSignalCount,
      preferences: report.memory.preferenceCount,
      importance: report.memory.importanceDistribution,
      relations: relations.length,
      evidence: evidenceAudit,
      networkAttempts
    }, null, 2));
  } finally {
    database.close();
    globalThis.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(`[memory-quality] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
