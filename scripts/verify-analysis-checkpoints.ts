import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { AudioUpload, BriefItem, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import { TranscriptSegmentSchema } from "@/lib/domain/types";
import {
  AnalysisChunkCheckpointSchema,
  JsonAnalysisChunkCheckpointStore
} from "@/lib/server/analysis-chunks/checkpoint";
import { resolveAnalysisTranscriptChunks } from "@/lib/server/analysis-chunks/transcript-chunks";
import { processDailyBriefChunks } from "@/lib/server/extraction/chunk-processing";
import type { ExtractionChunk } from "@/lib/server/extraction/chunks";
import { buildFixtureTranscriptSegments, loadFixtureDataset } from "@/lib/server/fixture-replay/dataset";
import { fixtureReplayProviders, createFixtureTranscriptionProvider } from "@/lib/server/fixture-replay/providers";
import { replayMemoryFixtures } from "@/lib/server/fixture-replay/replay";
import { resetFixtureReplayUser } from "@/lib/server/fixture-replay/reset";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { normalizeEvidenceQuoteForDedup } from "@/lib/server/memory/evidence-deduplication";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import { processUpload } from "@/lib/server/pipeline/process-upload";
import { JsonStore } from "@/lib/server/storage/json-store";

type CapturedRun<T> = {
  value: T;
  logs: string[];
  networkAttempts: number;
};

type CheckpointAudit = Record<"audio_insight" | "daily_brief" | "relationship_candidate", {
  hit: number;
  miss: number;
  stale: number;
  corrupt: number;
}>;

const OUTPUT_DIR = resolve(".data/evaluation/analysis-checkpoint-v1");
const MULTIDAY_DATASET = resolve("test-data/memory-multiday-v1");
const LONG_DATASET = resolve("test-data/long-recording-45m-v1");

function stableDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function captureOffline<T>(run: () => Promise<T>): Promise<CapturedRun<T>> {
  const original = {
    fetch: globalThis.fetch,
    info: console.info,
    warn: console.warn,
    error: console.error
  };
  const logs: string[] = [];
  let networkAttempts = 0;
  const capture = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  globalThis.fetch = (async () => {
    networkAttempts += 1;
    throw new Error("Network access is disabled during analysis checkpoint verification");
  }) as typeof fetch;
  console.info = capture;
  console.warn = capture;
  console.error = capture;
  try {
    return { value: await run(), logs, networkAttempts };
  } finally {
    globalThis.fetch = original.fetch;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
}

function checkpointAudit(logs: string[]): CheckpointAudit {
  const result: CheckpointAudit = {
    audio_insight: { hit: 0, miss: 0, stale: 0, corrupt: 0 },
    daily_brief: { hit: 0, miss: 0, stale: 0, corrupt: 0 },
    relationship_candidate: { hit: 0, miss: 0, stale: 0, corrupt: 0 }
  };
  for (const line of logs) {
    const match = /\[analysis-checkpoint\].*kind=(audio_insight|daily_brief|relationship_candidate).*cache=(hit|miss|stale|corrupt)/u.exec(line);
    if (match) result[match[1] as keyof CheckpointAudit][match[2] as keyof CheckpointAudit["audio_insight"]] += 1;
  }
  return result;
}

function briefBenchmarkInput() {
  const segments = Array.from({ length: 66 }, (_, index): TranscriptSegment => ({
    id: `benchmark_seg_${String(index).padStart(3, "0")}`,
    uploadId: "benchmark_daily_brief",
    startSeconds: index * 20,
    endSeconds: index * 20 + 10,
    speaker: index % 2 === 0 ? "speaker_1" : "speaker_2",
    text: `Segment ${index} contains a concrete action and enough detail for stable chunk planning.`,
    confidence: 1,
    sceneLabels: ["product_discussion"],
    valueLabels: index % 11 === 0 ? ["task"] : []
  }));
  const semanticSegments = Array.from({ length: 6 }, (_, index): SemanticSegment => {
    const source = segments.slice(index * 11, index * 11 + 11);
    return {
      id: `benchmark_semantic_${index}`,
      uploadId: "benchmark_daily_brief",
      title: `Topic ${index}`,
      summary: `Summary ${index}`,
      startSeconds: source[0].startSeconds,
      endSeconds: source.at(-1)!.endSeconds,
      tags: ["topic"],
      sceneLabels: ["product_discussion"],
      valueLabels: [],
      confidence: 1,
      sourceSegmentIds: source.map((segment) => segment.id),
      sourceTimeRange: { startSeconds: source[0].startSeconds, endSeconds: source.at(-1)!.endSeconds },
      transcriptExcerpt: source[0].text
    };
  });
  return { segments, semanticSegments };
}

function benchmarkItem(chunk: ExtractionChunk): BriefItem {
  const source = chunk.segments[0];
  return {
    id: `benchmark_item_${chunk.index}`,
    uploadId: "benchmark_daily_brief",
    category: "task",
    title: `Task ${chunk.index}`,
    body: source.text,
    priority: "medium",
    confidence: 0.8,
    status: "candidate",
    sourceSegmentIds: [source.id],
    sourceTimeRange: { startSeconds: source.startSeconds, endSeconds: source.endSeconds },
    transcriptExcerpt: source.text,
    people: [],
    topics: [`topic_${chunk.index}`]
  };
}

async function runBriefBenchmark(concurrency: number) {
  const input = briefBenchmarkInput();
  let active = 0;
  let maxActive = 0;
  const startedAt = Date.now();
  const result = await processDailyBriefChunks({
    uploadId: "benchmark_daily_brief",
    ...input,
    concurrency,
    executeChunk: async (chunk) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      active -= 1;
      return { items: [benchmarkItem(chunk)], resultSource: "provider_success" };
    },
    fallbackChunk: async (_chunk, error) => { throw error; }
  });
  return {
    chunks: result.stats.chunkCount,
    concurrency,
    theoreticalSerialMs: result.stats.chunkCount * 100,
    wallClockMs: Date.now() - startedAt,
    maxActive,
    digest: stableDigest(result.items)
  };
}

async function evidenceMetrics(report: Awaited<ReturnType<typeof replayMemoryFixtures>>["report"]) {
  const dataset = await loadFixtureDataset(MULTIDAY_DATASET);
  const transcriptById = new Map<string, TranscriptSegment>();
  for (const session of dataset.manifest.sessions) {
    for (const segment of await buildFixtureTranscriptSegments({ dataset, session })) {
      transcriptById.set(segment.id, segment);
    }
  }
  const transcriptEvidence = report.memoryEvidence.filter((item) => item.sourceType === "transcript");
  const duplicateKeys = new Set<string>();
  let duplicateEvidence = 0;
  for (const item of report.memoryEvidence) {
    const key = JSON.stringify([
      item.memoryId,
      item.uploadId,
      item.sourceId,
      normalizeEvidenceQuoteForDedup(item.quote)
    ]);
    if (duplicateKeys.has(key)) duplicateEvidence += 1;
    duplicateKeys.add(key);
  }
  return {
    invalidSourceIds: transcriptEvidence.filter((item) => !transcriptById.has(item.sourceId)).length,
    nonVerbatimQuotes: transcriptEvidence.filter((item) => {
      const source = transcriptById.get(item.sourceId);
      return !source || !source.text.includes(item.quote);
    }).length,
    duplicateEvidence,
    memoriesWithoutEvidence: report.finalMemoryItems.filter((item) => item.evidence.length === 0).length,
    orphanEvidence: report.orphanEvidenceCount
  };
}

async function runMultidayVerification() {
  const dataRoot = join(OUTPUT_DIR, "runtime-multiday");
  const databasePath = join(dataRoot, "memory.sqlite");
  const common = {
    datasetPath: MULTIDAY_DATASET,
    userId: "analysis-checkpoint-eval",
    dataRoot,
    memoryDatabasePath: databasePath,
    failFast: true
  };
  const first = await captureOffline(() => replayMemoryFixtures({
    ...common,
    resetUser: true,
    reportPath: join(OUTPUT_DIR, "first-run.json")
  }));
  const second = await captureOffline(() => replayMemoryFixtures({
    ...common,
    resetUser: true,
    preserveAnalysisCheckpointsOnReset: true,
    reportPath: join(OUTPUT_DIR, "second-run.json")
  }));

  const store = new JsonStore(join(dataRoot, "users", common.userId));
  const checkpoints = new JsonAnalysisChunkCheckpointStore(store);
  const invalidated: string[] = [];
  for (const kind of ["audio_insight", "daily_brief", "relationship_candidate"] as const) {
    const records = await checkpoints.list({
      userId: common.userId,
      uploadId: "fixture_memory-v1-day-01",
      kind
    });
    const checkpoint = records.find((item) => item.sourceChunkIndex === 0);
    if (!checkpoint) throw new Error(`Missing ${kind} checkpoint for partial invalidation`);
    await checkpoints.write(AnalysisChunkCheckpointSchema.parse({
      ...checkpoint,
      inputFingerprint: stableDigest({ invalidated: checkpoint.inputFingerprint })
    }));
    invalidated.push(checkpoint.id);
  }
  const partial = await captureOffline(() => replayMemoryFixtures({
    ...common,
    resetUser: true,
    preserveAnalysisCheckpointsOnReset: true,
    reportPath: join(OUTPUT_DIR, "partial-invalidation-replay.json")
  }));

  return {
    first: {
      pass: first.value.report.pass,
      digest: first.value.report.deterministicDigest,
      checkpoint: checkpointAudit(first.logs),
      networkAttempts: first.networkAttempts
    },
    second: {
      pass: second.value.report.pass,
      digest: second.value.report.deterministicDigest,
      checkpoint: checkpointAudit(second.logs),
      networkAttempts: second.networkAttempts
    },
    partialInvalidation: {
      pass: partial.value.report.pass,
      digest: partial.value.report.deterministicDigest,
      checkpoint: checkpointAudit(partial.logs),
      invalidatedCheckpointIds: invalidated,
      networkAttempts: partial.networkAttempts
    },
    evidence: await evidenceMetrics(second.value.report)
  };
}

type LongDialogue = {
  utterances: Array<{
    utteranceId: string;
    speaker: string;
    text: string;
    expectedStartRange: [number, number];
    tags: string[];
  }>;
};

async function longFixtureSegments(uploadId: string) {
  const dialogue = JSON.parse(await readFile(join(LONG_DATASET, "dialogue.json"), "utf8")) as LongDialogue;
  const rangeCounts = new Map<string, number>();
  const rangeIndexes = new Map<string, number>();
  for (const utterance of dialogue.utterances) {
    const key = utterance.expectedStartRange.join(":");
    rangeCounts.set(key, (rangeCounts.get(key) ?? 0) + 1);
  }
  return dialogue.utterances.map((utterance) => {
    const [rangeStart, rangeEnd] = utterance.expectedStartRange;
    const key = utterance.expectedStartRange.join(":");
    const localIndex = rangeIndexes.get(key) ?? 0;
    rangeIndexes.set(key, localIndex + 1);
    const step = (rangeEnd - rangeStart) / (rangeCounts.get(key) ?? 1);
    const startSeconds = Math.round((rangeStart + localIndex * step + 0.5) * 1000) / 1000;
    const endSeconds = Math.round(Math.min(rangeEnd - 0.5, startSeconds + Math.max(3, Math.min(12, step * 0.72))) * 1000) / 1000;
    return TranscriptSegmentSchema.parse({
      id: `${uploadId}_${utterance.utteranceId}`,
      uploadId,
      startSeconds,
      endSeconds,
      speaker: utterance.speaker,
      text: utterance.text,
      confidence: 1,
      sceneLabels: ["self_reflection"],
      valueLabels: utterance.tags.some((tag) => /commitment|future_action|follow_up/u.test(tag)) ? ["commitment"] : []
    });
  });
}

async function runLongFixtureOnce(input: {
  dataRoot: string;
  databasePath: string;
  userId: string;
  uploadId: string;
  reset: boolean;
  preserveCheckpoints: boolean;
}) {
  const store = new JsonStore(join(input.dataRoot, "users", input.userId));
  const database = openMemoryDatabase({ filePath: input.databasePath });
  const repository = createMemoryRepository(database);
  try {
    if (input.reset) {
      await resetFixtureReplayUser({
        userId: input.userId,
        uploadIds: [input.uploadId],
        store,
        database,
        preserveAnalysisCheckpoints: input.preserveCheckpoints
      });
    }
    const segments = await longFixtureSegments(input.uploadId);
    const artifact = join(input.dataRoot, "fixture-artifacts", input.userId, `${input.uploadId}.fixture`);
    await mkdir(dirname(artifact), { recursive: true });
    await writeFile(artifact, "fixture", "utf8");
    const upload: AudioUpload & { filePath: string } = {
      id: input.uploadId,
      originalName: "long-recording-45m-v1.fixture",
      mimeType: "application/x-long-recording-fixture",
      sizeBytes: 7,
      recordingDate: "2026-07-15",
      createdAt: "2026-07-15T00:00:00.000Z",
      durationSeconds: 2682,
      status: "uploaded",
      filePath: artifact
    };
    await store.delete("deleted-uploads", input.uploadId);
    await store.write("uploads", input.uploadId, upload);
    const counters = { audioInsight: 0, relationshipCandidate: 0 };
    const result = await processUpload({
      uploadId: input.uploadId,
      userId: input.userId,
      store,
      memoryRepository: repository,
      dependencies: {
        ...fixtureReplayProviders,
        transcriptionProvider: createFixtureTranscriptionProvider(segments),
        audioInsightProvider: {
          async analyze(...args) {
            counters.audioInsight += 1;
            return await fixtureReplayProviders.audioInsightProvider.analyze(...args);
          }
        },
        relationshipSignalProvider: {
          async analyze(...args) {
            return await fixtureReplayProviders.relationshipSignalProvider.analyze(...args);
          },
          async extractCandidates(...args) {
            counters.relationshipCandidate += 1;
            return await fixtureReplayProviders.relationshipSignalProvider.extractCandidates!(...args);
          }
        },
        now: () => "2026-07-15T00:00:00.000Z"
      }
    });
    const transcriptChunks = resolveAnalysisTranscriptChunks({
      uploadId: input.uploadId,
      segments: result.segments,
      now: () => "2026-07-15T00:00:00.000Z"
    });
    const componentDigests = {
      segments: stableDigest(result.segments),
      audioInsights: stableDigest(result.audioInsights),
      semanticSegments: stableDigest(result.semanticSegments),
      briefItems: stableDigest(result.briefItems),
      relationshipSignals: stableDigest(result.relationshipSignals)
    };
    return {
      status: result.job.status,
      transcriptChunkCount: transcriptChunks.length,
      dailyBriefCount: result.briefItems.length,
      relationshipCardCount: result.relationshipSignals.length,
      counters,
      componentDigests,
      digest: stableDigest({
        segments: result.segments,
        audioInsights: result.audioInsights,
        semanticSegments: result.semanticSegments,
        briefItems: result.briefItems,
        relationshipSignals: result.relationshipSignals
      })
    };
  } finally {
    database.close();
  }
}

async function runLongVerification() {
  const dataRoot = join(OUTPUT_DIR, "runtime-long");
  const common = {
    dataRoot,
    databasePath: join(dataRoot, "memory.sqlite"),
    userId: "analysis-checkpoint-long-eval",
    uploadId: "fixture_long-recording-45m-v1"
  };
  const first = await captureOffline(() => runLongFixtureOnce({
    ...common,
    reset: true,
    preserveCheckpoints: false
  }));
  const second = await captureOffline(() => runLongFixtureOnce({
    ...common,
    reset: true,
    preserveCheckpoints: true
  }));
  return {
    first: { ...first.value, checkpoint: checkpointAudit(first.logs), networkAttempts: first.networkAttempts },
    second: { ...second.value, checkpoint: checkpointAudit(second.logs), networkAttempts: second.networkAttempts }
  };
}

function markdown(report: Record<string, unknown>) {
  const typed = report as {
    benchmark: Awaited<ReturnType<typeof runBriefBenchmark>>[];
    multiday: Awaited<ReturnType<typeof runMultidayVerification>>;
    longFixture: Awaited<ReturnType<typeof runLongVerification>>;
  };
  const benchmarkRows = typed.benchmark.map((item) =>
    `| ${item.chunks} | ${item.concurrency} | ${item.theoreticalSerialMs} | ${item.wallClockMs} | ${item.maxActive} |`
  ).join("\n");
  return `# Analysis Checkpoint v1 Verification

## Daily Brief bounded concurrency

| Chunks | Concurrency | Serial theory (ms) | Wall-clock (ms) | Max active |
| ---: | ---: | ---: | ---: | ---: |
${benchmarkRows}

All benchmark runs produced the same digest: ${new Set(typed.benchmark.map((item) => item.digest)).size === 1}.

## Multi-day replay

- First pass: ${typed.multiday.first.pass}
- Second pass: ${typed.multiday.second.pass}
- First/second digest equal: ${typed.multiday.first.digest === typed.multiday.second.digest}
- Second checkpoint hits: ${JSON.stringify(typed.multiday.second.checkpoint)}
- Partial invalidation: ${JSON.stringify(typed.multiday.partialInvalidation.checkpoint)}
- Evidence metrics: ${JSON.stringify(typed.multiday.evidence)}

## 45-minute local fixture

- First status/chunks: ${typed.longFixture.first.status} / ${typed.longFixture.first.transcriptChunkCount}
- Second status/chunks: ${typed.longFixture.second.status} / ${typed.longFixture.second.transcriptChunkCount}
- First/second digest equal: ${typed.longFixture.first.digest === typed.longFixture.second.digest}
- First provider calls: ${JSON.stringify(typed.longFixture.first.counters)}
- Second provider calls: ${JSON.stringify(typed.longFixture.second.counters)}
- Second checkpoint hits: ${JSON.stringify(typed.longFixture.second.checkpoint)}
- Network attempts: ${typed.longFixture.first.networkAttempts + typed.longFixture.second.networkAttempts}
`;
}

async function main() {
  if (process.env.NODE_ENV !== "test" && process.env.NODE_ENV !== "development") {
    throw new Error("Analysis checkpoint verification is only available in development or test");
  }
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
  const benchmarkCaptured = await captureOffline(async () => [
    await runBriefBenchmark(1),
    await runBriefBenchmark(2),
    await runBriefBenchmark(3)
  ]);
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    benchmark: benchmarkCaptured.value,
    multiday: await runMultidayVerification(),
    longFixture: await runLongVerification(),
    networkAttempts: benchmarkCaptured.networkAttempts
  };
  await writeFile(join(OUTPUT_DIR, "report.json"), JSON.stringify(report, null, 2), "utf8");
  await writeFile(join(OUTPUT_DIR, "report.md"), markdown(report), "utf8");
  await writeFile(join(OUTPUT_DIR, "partial-invalidation.json"), JSON.stringify(report.multiday.partialInvalidation, null, 2), "utf8");
  const passed =
    report.benchmark.every((item) => item.maxActive <= item.concurrency) &&
    new Set(report.benchmark.map((item) => item.digest)).size === 1 &&
    report.multiday.first.pass &&
    report.multiday.second.pass &&
    report.multiday.first.digest === report.multiday.second.digest &&
    Object.values(report.multiday.evidence).every((value) => value === 0) &&
    report.longFixture.first.status === "ready" &&
    report.longFixture.second.status === "ready" &&
    report.longFixture.first.transcriptChunkCount === 9 &&
    report.longFixture.first.digest === report.longFixture.second.digest &&
    report.longFixture.second.counters.audioInsight === 0 &&
    report.longFixture.second.counters.relationshipCandidate === 0 &&
    report.networkAttempts === 0;
  console.log(JSON.stringify({ passed, reportPath: join(OUTPUT_DIR, "report.json") }, null, 2));
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[analysis-checkpoint-verification] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
