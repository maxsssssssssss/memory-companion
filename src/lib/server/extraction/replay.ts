import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, link, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import {
  AudioUploadSchema,
  BriefItemSchema,
  SemanticSegmentSchema,
  TranscriptSegmentSchema,
  type AudioUpload,
  type BriefItem,
  type SemanticSegment,
  type TranscriptSegment
} from "@/lib/domain/types";
import {
  AnalysisChunkCheckpointSchema,
  JsonAnalysisChunkCheckpointStore,
  type AnalysisCheckpointResultSource,
  type AnalysisChunkCheckpoint
} from "@/lib/server/analysis-chunks/checkpoint";
import { JsonStore } from "@/lib/server/storage/json-store";
import { planExtractionChunks, type ExtractionChunk } from "./chunks";
import { processDailyBriefChunks } from "./chunk-processing";
import { dailyBriefProviderRequestMetrics } from "./openai-provider";
import type { ExtractionProgressEvent, ExtractionProvider } from "./provider";

const SAFE_STORE_ID = /^[A-Za-z0-9_-]+$/u;
const BriefItemsSchema = z.array(BriefItemSchema);

type SourceSnapshot = Record<string, { bytes: number; sha256: string }>;

export type DailyBriefReplayArtifacts = {
  userId: string;
  userRoot: string;
  upload: AudioUpload;
  segments: TranscriptSegment[];
  semanticSegments: SemanticSegment[];
  baselineItems: BriefItem[];
  chunks: ExtractionChunk[];
  checkpoints: AnalysisChunkCheckpoint[];
  checkpointByChunkIndex: Map<number, AnalysisChunkCheckpoint>;
};

type DailyBriefEvidenceAudit = {
  itemCount: number;
  evidenceRefCount: number;
  itemsWithoutEvidence: number;
  invalidSourceIds: number;
  duplicateEvidenceRefs: number;
  crossChunkSourceIds: number;
  sourceRangeMismatches: number;
  quoteMismatches: number;
};

type DailyBriefItemAudit = {
  id: string;
  category: BriefItem["category"];
  priority: BriefItem["priority"];
  confidence: number;
  sourceSegmentIds: string[];
  sourceTimeRange: BriefItem["sourceTimeRange"];
};

type DailyBriefHistoricalChunkAudit = {
  chunkIndex: number;
  segmentCount: number;
  startSeconds: number;
  endSeconds: number;
  inputChars: number;
  inputBytes: number;
  promptChars: null;
  responseTextChars: null;
  parseResult: "not_recorded";
  validationResult: "not_recorded";
  checkpointStatus: AnalysisChunkCheckpoint["status"];
  checkpointResultSource: AnalysisCheckpointResultSource;
  checkpointExecutionAttemptCount: number;
  checkpointEnvelopeElapsedMs: number | null;
  fallbackReason: "not_recorded" | null;
  outputItems: number;
  evidenceRefs: number;
};

type DailyBriefReplayChunkAudit = {
  chunkIndex: number;
  segmentCount: number;
  startSeconds: number;
  endSeconds: number;
  inputChars: number;
  inputBytes: number;
  status: "completed" | "fallback" | "not_reported";
  resultSource: "provider" | "checkpoint_fixture" | "rule_fallback" | "not_reported";
  elapsedMs: number | null;
  itemCount: number | null;
  fallbackReason: string | null;
};

type DailyBriefOfflineBenchmarkMetrics = {
  chunkCount: number;
  firstAttemptSuccess: number;
  retryChunks: number;
  fallbackChunks: number;
  promptChars: number;
  estimatedOutputTokens: number;
  rawItems: number;
  finalItems: number;
  typeCoverage: BriefItem["category"][];
  evidenceViolations: number;
  mockWallClockMs: number;
  outputDigestSha256: string;
};

export type DailyBriefReplayReport = {
  version: 1;
  generatedAt: string;
  mode: "offline" | "remote";
  uploadId: string;
  userId: string;
  recordingDate: string;
  execution: {
    kind: "offline_retained_checkpoint_fixture" | "offline_injected_provider" | "remote_provider";
    providerLatencyMeasured: boolean;
    replayWallClockMs: number;
    latencyInterpretation:
      | "fixture_harness_only_not_provider_latency"
      | "injected_offline_harness_only_not_provider_latency"
      | "remote_stage_wall_clock_including_retries_fallback_and_merge";
  };
  artifacts: {
    transcriptSegments: number;
    semanticSegments: number;
    plannedChunks: number;
    retainedCheckpoints: number;
    baselineItems: number;
  };
  historical: {
    source: "retained_analysis_checkpoint";
    providerLatencyMeasured: false;
    limitation: "provider_response_and_failure_phase_not_recorded";
    checkpointEnvelopeWallMs: number | null;
    checkpointEnvelopeSumMs: number;
    providerSuccessChunks: number;
    providerRetrySuccessChunks: number;
    fallbackChunks: number;
    retainedFinalOutputDigestSha256: string;
    chunks: DailyBriefHistoricalChunkAudit[];
  };
  replay: {
    outputDigestSha256: string;
    matchesRetainedFinalOutput: boolean;
    itemAudits: DailyBriefItemAudit[];
    chunkAudits: DailyBriefReplayChunkAudit[];
    events: ExtractionProgressEvent[];
    stats: {
      chunkCount: number;
      completedChunks: number;
      fallbackChunks: number;
      rawItemCount: number | null;
      finalItemCount: number;
      stageElapsedAtMergeEventMs: number | null;
    };
  };
  evidence: {
    historicalCheckpointOutputs: DailyBriefEvidenceAudit;
    replayOutput: DailyBriefEvidenceAudit;
  };
  offlineBenchmark: {
    interpretation: "deterministic_scheduler_mock_not_provider_latency_or_provider_quality";
    mockWallClockInterpretation: "fixed_10ms_per_provider_attempt_scheduler_harness";
    simulatedFailurePattern: "retained_rule_fallback_chunks_fail_once_with_provider_5xx";
    evidenceBackfill: {
      retained: DailyBriefEvidenceAudit;
      normalized: DailyBriefEvidenceAudit;
      outputDigestChanged: boolean;
    };
    before: DailyBriefOfflineBenchmarkMetrics;
    after: DailyBriefOfflineBenchmarkMetrics;
    outputDigestStable: boolean;
  };
  network: {
    remoteAllowed: boolean;
    blockedAttempts: number;
    remoteCalls: number;
    observationScope: "global_fetch_only";
    executionIsolation: "dedicated_cli_process_required";
  };
  integrity: {
    sourceArtifactsUnchanged: boolean;
    changedPaths: string[];
  };
};

export type RunDailyBriefReplayInput = {
  dataDir: string;
  uploadId: string;
  reportPath: string;
  userId?: string;
  provider?: ExtractionProvider;
  remote?: boolean;
  now?: () => string;
};

function assertSafeStoreId(value: string, label: string) {
  if (!SAFE_STORE_ID.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
}

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readParsed<TSchema extends z.ZodTypeAny>(
  filePath: string,
  schema: TSchema
): Promise<z.output<TSchema>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid retained JSON artifact: ${filePath}`, { cause: error });
    }
    throw error;
  }
  return schema.parse(value) as z.output<TSchema>;
}

async function findReplayUser(input: { dataDir: string; uploadId: string; userId?: string }) {
  const usersDirectory = resolve(input.dataDir, "users");
  if (input.userId) {
    assertSafeStoreId(input.userId, "userId");
    const uploadPath = resolve(usersDirectory, input.userId, "uploads", `${input.uploadId}.json`);
    if (!(await exists(uploadPath))) {
      throw new Error(`Retained upload ${input.uploadId} was not found for user ${input.userId}`);
    }
    return input.userId;
  }

  let entries;
  try {
    entries = await readdir(usersDirectory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Retained users directory is unavailable: ${usersDirectory}`, { cause: error });
  }
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_STORE_ID.test(entry.name)) continue;
    if (await exists(resolve(usersDirectory, entry.name, "uploads", `${input.uploadId}.json`))) {
      matches.push(entry.name);
    }
  }
  if (matches.length === 0) throw new Error(`Retained upload was not found: ${input.uploadId}`);
  if (matches.length > 1) throw new Error(`Retained upload is ambiguous across users: ${input.uploadId}`);
  return matches[0];
}

function checkpointElapsedMs(checkpoint: AnalysisChunkCheckpoint) {
  if (!checkpoint.startedAt || !checkpoint.completedAt) return null;
  const elapsed = Date.parse(checkpoint.completedAt) - Date.parse(checkpoint.startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

function completedCheckpointResultSource(checkpoint: AnalysisChunkCheckpoint) {
  if (!checkpoint.resultSource) {
    throw new Error(`Completed Daily Brief checkpoint ${checkpoint.id} has no result source`);
  }
  return checkpoint.resultSource;
}

function expectedCheckpointSourceId(uploadId: string, chunk: ExtractionChunk) {
  return `${uploadId}_daily_brief_${chunk.id}`;
}

function validateItemsAgainstSegments(input: {
  uploadId: string;
  label: string;
  segments: TranscriptSegment[];
  items: BriefItem[];
  requireVerbatimExcerpt?: boolean;
}) {
  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));
  for (const item of input.items) {
    if (item.uploadId !== input.uploadId) {
      throw new Error(`Daily Brief ${input.label} has a mismatched uploadId`);
    }
    if (item.sourceSegmentIds.length === 0) {
      throw new Error(`Daily Brief ${input.label} has an item without evidence`);
    }
    if (new Set(item.sourceSegmentIds).size !== item.sourceSegmentIds.length) {
      throw new Error(`Daily Brief ${input.label} has duplicate evidence refs`);
    }
    const sources = item.sourceSegmentIds.map((id) => segmentById.get(id));
    if (sources.some((source) => !source)) {
      throw new Error(`Daily Brief ${input.label} has invalid evidence refs`);
    }
    const resolved = sources.filter((source): source is TranscriptSegment => Boolean(source));
    const startSeconds = Math.min(...resolved.map((source) => source.startSeconds));
    const endSeconds = Math.max(...resolved.map((source) => source.endSeconds));
    if (
      item.sourceTimeRange.startSeconds !== startSeconds ||
      item.sourceTimeRange.endSeconds !== endSeconds
    ) {
      throw new Error(`Daily Brief ${input.label} has an invalid evidence range`);
    }
    if (
      input.requireVerbatimExcerpt === true
      && !resolved.some((source) => source.text.includes(item.transcriptExcerpt))
    ) {
      throw new Error(`Daily Brief ${input.label} has a non-verbatim evidence excerpt`);
    }
  }
}

export async function loadDailyBriefReplayArtifacts(input: {
  dataDir: string;
  uploadId: string;
  userId?: string;
}): Promise<DailyBriefReplayArtifacts> {
  assertSafeStoreId(input.uploadId, "uploadId");
  const dataDir = resolve(input.dataDir);
  const userId = await findReplayUser({ ...input, dataDir });
  const userRoot = resolve(dataDir, "users", userId);
  const store = new JsonStore(userRoot);
  const [upload, segments, semanticSegments, baselineItems, listedCheckpoints] = await Promise.all([
    readParsed(resolve(userRoot, "uploads", `${input.uploadId}.json`), AudioUploadSchema),
    readParsed(resolve(userRoot, "segments", `${input.uploadId}.json`), z.array(TranscriptSegmentSchema)),
    readParsed(resolve(userRoot, "semantic-segments", `${input.uploadId}.json`), z.array(SemanticSegmentSchema)),
    readParsed(resolve(userRoot, "brief-items", `${input.uploadId}.json`), BriefItemsSchema),
    new JsonAnalysisChunkCheckpointStore(store).list({
      userId,
      uploadId: input.uploadId,
      kind: "daily_brief"
    })
  ]);

  if (upload.id !== input.uploadId) throw new Error(`Retained upload record id does not match ${input.uploadId}`);
  if (segments.length === 0) throw new Error(`Retained transcript is empty for upload ${input.uploadId}`);

  const chunks = planExtractionChunks({ segments, semanticSegments }).chunks;
  const checkpoints = listedCheckpoints.map((checkpoint) => AnalysisChunkCheckpointSchema.parse(checkpoint));
  const checkpointByChunkIndex = new Map<number, AnalysisChunkCheckpoint>();
  const matchedCheckpointIds = new Set<string>();

  for (const chunk of chunks) {
    const sourceChunkId = expectedCheckpointSourceId(input.uploadId, chunk);
    const matches = checkpoints.filter(
      (checkpoint) => checkpoint.sourceChunkId === sourceChunkId && checkpoint.sourceChunkIndex === chunk.index
    );
    if (matches.length !== 1) {
      throw new Error(
        `Daily Brief retained checkpoint coverage for chunk ${chunk.index} must be unique; found ${matches.length}`
      );
    }
    const checkpoint = matches[0];
    if (
      checkpoint.status !== "completed" ||
      checkpoint.output === undefined ||
      !checkpoint.resultSource
    ) {
      throw new Error(`Daily Brief retained checkpoint chunk ${chunk.index} is not completed with output`);
    }
    const items = BriefItemsSchema.parse(checkpoint.output);
    validateItemsAgainstSegments({
      uploadId: input.uploadId,
      label: `retained checkpoint chunk ${chunk.index}`,
      segments: chunk.segments,
      items
    });
    const retainedInputChars = checkpoint.metadata.inputCharacterCount;
    if (typeof retainedInputChars === "number" && retainedInputChars !== chunk.inputChars) {
      throw new Error(`Daily Brief retained checkpoint chunk ${chunk.index} input size does not match rebuilt chunk`);
    }
    checkpointByChunkIndex.set(chunk.index, checkpoint);
    matchedCheckpointIds.add(checkpoint.id);
  }

  if (matchedCheckpointIds.size !== checkpoints.length) {
    throw new Error("Daily Brief retained checkpoints contain unmatched or duplicate chunk artifacts");
  }
  validateItemsAgainstSegments({
    uploadId: input.uploadId,
    label: "retained final output",
    segments,
    items: baselineItems
  });

  return {
    userId,
    userRoot,
    upload,
    segments,
    semanticSegments,
    baselineItems,
    chunks,
    checkpoints,
    checkpointByChunkIndex
  };
}

function evidenceAudit(input: {
  items: BriefItem[];
  segments: TranscriptSegment[];
  chunks?: ExtractionChunk[];
}): DailyBriefEvidenceAudit {
  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));
  const chunkBySegmentId = new Map<string, number>();
  for (const chunk of input.chunks ?? []) {
    for (const segment of chunk.segments) chunkBySegmentId.set(segment.id, chunk.index);
  }
  let evidenceRefCount = 0;
  let itemsWithoutEvidence = 0;
  let invalidSourceIds = 0;
  let duplicateEvidenceRefs = 0;
  let crossChunkSourceIds = 0;
  let sourceRangeMismatches = 0;
  let quoteMismatches = 0;
  for (const item of input.items) {
    evidenceRefCount += item.sourceSegmentIds.length;
    if (item.sourceSegmentIds.length === 0) itemsWithoutEvidence += 1;
    duplicateEvidenceRefs += item.sourceSegmentIds.length - new Set(item.sourceSegmentIds).size;
    const sources = item.sourceSegmentIds.flatMap((id) => {
      const source = segmentById.get(id);
      if (!source) {
        invalidSourceIds += 1;
        return [];
      }
      return [source];
    });
    const sourceChunkIndexes = new Set(
      item.sourceSegmentIds.flatMap((id) => {
        const index = chunkBySegmentId.get(id);
        return index === undefined ? [] : [index];
      })
    );
    if (sourceChunkIndexes.size > 1) crossChunkSourceIds += item.sourceSegmentIds.length;
    if (sources.length > 0) {
      const startSeconds = Math.min(...sources.map((source) => source.startSeconds));
      const endSeconds = Math.max(...sources.map((source) => source.endSeconds));
      if (
        item.sourceTimeRange.startSeconds !== startSeconds ||
        item.sourceTimeRange.endSeconds !== endSeconds
      ) {
        sourceRangeMismatches += 1;
      }
      if (!sources.some((source) => source.text.includes(item.transcriptExcerpt))) {
        quoteMismatches += 1;
      }
    }
  }
  return {
    itemCount: input.items.length,
    evidenceRefCount,
    itemsWithoutEvidence,
    invalidSourceIds,
    duplicateEvidenceRefs,
    crossChunkSourceIds,
    sourceRangeMismatches,
    quoteMismatches
  };
}

function historicalAudit(artifacts: DailyBriefReplayArtifacts) {
  const chunks = artifacts.chunks.map((chunk): DailyBriefHistoricalChunkAudit => {
    const checkpoint = artifacts.checkpointByChunkIndex.get(chunk.index)!;
    const items = BriefItemsSchema.parse(checkpoint.output);
    return {
      chunkIndex: chunk.index,
      segmentCount: chunk.segments.length,
      startSeconds: chunk.startSeconds,
      endSeconds: chunk.endSeconds,
      inputChars: chunk.inputChars,
      inputBytes: chunk.inputBytes,
      promptChars: null,
      responseTextChars: null,
      parseResult: "not_recorded",
      validationResult: "not_recorded",
      checkpointStatus: checkpoint.status,
      checkpointResultSource: completedCheckpointResultSource(checkpoint),
      checkpointExecutionAttemptCount: checkpoint.attemptCount,
      checkpointEnvelopeElapsedMs: checkpointElapsedMs(checkpoint),
      fallbackReason: checkpoint.resultSource === "rule_fallback" ? "not_recorded" : null,
      outputItems: items.length,
      evidenceRefs: items.reduce((total, item) => total + item.sourceSegmentIds.length, 0)
    };
  });
  const started = artifacts.checkpoints.flatMap((checkpoint) => {
    const value = Date.parse(checkpoint.startedAt ?? "");
    return Number.isFinite(value) ? [value] : [];
  });
  const completed = artifacts.checkpoints.flatMap((checkpoint) => {
    const value = Date.parse(checkpoint.completedAt ?? "");
    return Number.isFinite(value) ? [value] : [];
  });
  return {
    source: "retained_analysis_checkpoint" as const,
    providerLatencyMeasured: false as const,
    limitation: "provider_response_and_failure_phase_not_recorded" as const,
    checkpointEnvelopeWallMs:
      started.length > 0 && completed.length > 0 && Math.max(...completed) >= Math.min(...started)
        ? Math.max(...completed) - Math.min(...started)
        : null,
    checkpointEnvelopeSumMs: chunks.reduce(
      (total, chunk) => total + (chunk.checkpointEnvelopeElapsedMs ?? 0),
      0
    ),
    providerSuccessChunks: chunks.filter((chunk) => chunk.checkpointResultSource === "provider_success").length,
    providerRetrySuccessChunks: chunks.filter(
      (chunk) => chunk.checkpointResultSource === "provider_retry_success"
    ).length,
    fallbackChunks: chunks.filter((chunk) => chunk.checkpointResultSource === "rule_fallback").length,
    retainedFinalOutputDigestSha256: outputDigest(artifacts.baselineItems),
    chunks
  };
}

function replayChunkAudits(
  chunks: ExtractionChunk[],
  events: ExtractionProgressEvent[],
  offlineFixture: boolean
): DailyBriefReplayChunkAudit[] {
  return chunks.map((chunk) => {
    const completion = events.find(
      (event) =>
        (event.phase === "chunk_completed" || event.phase === "chunk_fallback") &&
        event.chunkIndex === chunk.index + 1
    );
    if (!completion || (completion.phase !== "chunk_completed" && completion.phase !== "chunk_fallback")) {
      return {
        chunkIndex: chunk.index,
        segmentCount: chunk.segments.length,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        inputChars: chunk.inputChars,
        inputBytes: chunk.inputBytes,
        status: "not_reported" as const,
        resultSource: "not_reported" as const,
        elapsedMs: null,
        itemCount: null,
        fallbackReason: null
      };
    }
    const fallback = completion.phase === "chunk_fallback";
    return {
      chunkIndex: chunk.index,
      segmentCount: chunk.segments.length,
      startSeconds: chunk.startSeconds,
      endSeconds: chunk.endSeconds,
      inputChars: chunk.inputChars,
      inputBytes: chunk.inputBytes,
      status: fallback ? "fallback" as const : "completed" as const,
      resultSource: fallback
        ? "rule_fallback" as const
        : offlineFixture
          ? "checkpoint_fixture" as const
          : "provider" as const,
      elapsedMs: completion.elapsedMs,
      itemCount: completion.itemCount,
      fallbackReason: fallback ? completion.reason : null
    };
  });
}

function replayStats(events: ExtractionProgressEvent[], finalItems: BriefItem[], chunkCount: number) {
  const completed = events.filter((event) => event.phase === "chunk_completed");
  const fallback = events.filter((event) => event.phase === "chunk_fallback");
  const merged = events.find((event) => event.phase === "merged");
  return {
    chunkCount,
    completedChunks: completed.length,
    fallbackChunks: fallback.length,
    rawItemCount: merged?.phase === "merged" ? merged.rawItemCount : null,
    finalItemCount: finalItems.length,
    stageElapsedAtMergeEventMs: merged?.phase === "merged" ? merged.elapsedMs : null
  };
}

function outputDigest(items: BriefItem[]) {
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

function evidenceViolationCount(audit: DailyBriefEvidenceAudit) {
  return audit.itemsWithoutEvidence
    + audit.invalidSourceIds
    + audit.duplicateEvidenceRefs
    + audit.sourceRangeMismatches
    + audit.quoteMismatches;
}

function normalizeBenchmarkEvidence(items: BriefItem[], segments: TranscriptSegment[]) {
  const segmentById = new Map(segments.map((segment) => [segment.id, segment] as const));
  return items.map((item) => {
    const sources = item.sourceSegmentIds.map((id) => segmentById.get(id)!);
    return BriefItemSchema.parse({
      ...item,
      sourceTimeRange: {
        startSeconds: Math.min(...sources.map((source) => source.startSeconds)),
        endSeconds: Math.max(...sources.map((source) => source.endSeconds))
      },
      transcriptExcerpt: sources[0].text
    });
  });
}

async function runOfflineSchedulerBenchmark(artifacts: DailyBriefReplayArtifacts) {
  const simulatedFailureChunks = new Set(
    artifacts.chunks
      .filter((chunk) => artifacts.checkpointByChunkIndex.get(chunk.index)?.resultSource === "rule_fallback")
      .map((chunk) => chunk.index)
  );
  const run = async (maxRetries: number) => {
    const attemptCounts = new Map<number, number>();
    const benchmarkStartedAt = Date.now();
    const result = await processDailyBriefChunks({
      uploadId: artifacts.upload.id,
      segments: artifacts.segments,
      semanticSegments: artifacts.semanticSegments,
      concurrency: 2,
      recoveryConcurrency: 1,
      maxRetries,
      retryDelayMs: 0,
      attemptTimeoutMs: 1_000,
      totalBudgetMs: 10_000,
      executeChunk: async (chunk) => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        const attempt = (attemptCounts.get(chunk.index) ?? 0) + 1;
        attemptCounts.set(chunk.index, attempt);
        if (simulatedFailureChunks.has(chunk.index) && attempt === 1) {
          throw Object.assign(new Error("simulated transient provider failure"), { status: 503 });
        }
        const retainedItems = BriefItemsSchema.parse(
          artifacts.checkpointByChunkIndex.get(chunk.index)!.output
        );
        return {
          items: normalizeBenchmarkEvidence(retainedItems, chunk.segments),
          resultSource: "provider_success" as const
        };
      },
      fallbackChunk: async (chunk) => {
        const retainedItems = BriefItemsSchema.parse(
          artifacts.checkpointByChunkIndex.get(chunk.index)!.output
        );
        return {
          items: normalizeBenchmarkEvidence(retainedItems, chunk.segments),
          resultSource: "rule_fallback" as const,
          fallbackReason: "provider_5xx" as const
        };
      }
    });
    const audit = evidenceAudit({
      items: result.items,
      segments: artifacts.segments,
      chunks: artifacts.chunks
    });
    const promptChars = artifacts.chunks.reduce((total, chunk) => {
      const attempts = result.attemptHistory[chunk.index] ?? [];
      return total + attempts.reduce(
        (chunkTotal, attempt) => chunkTotal
          + dailyBriefProviderRequestMetrics(chunk, attempt.recoveryMode).promptChars,
        0
      );
    }, 0);
    const rawItems = result.chunkResults.reduce((total, chunk) => total + chunk.items.length, 0);
    return {
      chunkCount: result.stats.chunkCount,
      firstAttemptSuccess: result.stats.firstAttemptSuccess,
      retryChunks: result.stats.retryChunks,
      fallbackChunks: result.stats.fallbackChunks,
      promptChars,
      estimatedOutputTokens: Math.ceil(
        JSON.stringify(result.chunkResults.flatMap((chunk) => chunk.items)).length / 4
      ),
      rawItems,
      finalItems: result.items.length,
      typeCoverage: [...new Set(result.items.map((item) => item.category))].sort(),
      evidenceViolations: evidenceViolationCount(audit),
      mockWallClockMs: Date.now() - benchmarkStartedAt,
      outputDigestSha256: outputDigest(result.items)
    } satisfies DailyBriefOfflineBenchmarkMetrics;
  };

  const retainedItems = artifacts.chunks.flatMap((chunk) =>
    BriefItemsSchema.parse(artifacts.checkpointByChunkIndex.get(chunk.index)!.output)
  );
  const normalizedItems = artifacts.chunks.flatMap((chunk) =>
    normalizeBenchmarkEvidence(
      BriefItemsSchema.parse(artifacts.checkpointByChunkIndex.get(chunk.index)!.output),
      chunk.segments
    )
  );
  const before = await run(0);
  const after = await run(1);
  return {
    interpretation: "deterministic_scheduler_mock_not_provider_latency_or_provider_quality" as const,
    mockWallClockInterpretation: "fixed_10ms_per_provider_attempt_scheduler_harness" as const,
    simulatedFailurePattern: "retained_rule_fallback_chunks_fail_once_with_provider_5xx" as const,
    evidenceBackfill: {
      retained: evidenceAudit({ items: retainedItems, segments: artifacts.segments, chunks: artifacts.chunks }),
      normalized: evidenceAudit({ items: normalizedItems, segments: artifacts.segments, chunks: artifacts.chunks }),
      outputDigestChanged: outputDigest(retainedItems) !== outputDigest(normalizedItems)
    },
    before,
    after,
    outputDigestStable: before.outputDigestSha256 === after.outputDigestSha256
  };
}

function itemAudits(items: BriefItem[]): DailyBriefItemAudit[] {
  return items.map((item) => ({
    id: item.id,
    category: item.category,
    priority: item.priority,
    confidence: item.confidence,
    sourceSegmentIds: item.sourceSegmentIds,
    sourceTimeRange: item.sourceTimeRange
  }));
}

export function assertDailyBriefReplayReportPath(input: { dataDir: string; reportPath: string }) {
  const dataDir = resolve(input.dataDir);
  const reportPath = resolve(input.reportPath);
  const relativePath = relative(dataDir, reportPath);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    throw new Error("Daily Brief replay report must be outside the retained source data directory");
  }
}

async function nearestExistingPath(filePath: string) {
  let current = resolve(filePath);
  while (!(await exists(current))) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`No existing ancestor for replay report path: ${filePath}`);
    current = parent;
  }
  return current;
}

async function assertCanonicalDailyBriefReplayReportPath(input: {
  dataDir: string;
  reportPath: string;
}) {
  const dataDir = resolve(input.dataDir);
  const reportPath = resolve(input.reportPath);
  const existingReportAncestor = await nearestExistingPath(dirname(reportPath));
  const [canonicalDataDir, canonicalReportAncestor] = await Promise.all([
    realpath(dataDir),
    realpath(existingReportAncestor)
  ]);
  const canonicalReportPath = resolve(
    canonicalReportAncestor,
    relative(existingReportAncestor, reportPath)
  );
  const relativePath = relative(canonicalDataDir, canonicalReportPath);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    throw new Error("Daily Brief replay report must be outside the retained source data directory");
  }
}

async function listSourceFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const filePath = resolve(current, entry.name);
    if (entry.isDirectory()) paths.push(...await listSourceFiles(root, filePath));
    else if (entry.isFile()) paths.push(filePath);
  }
  return paths.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

async function hashFile(filePath: string) {
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      const value = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += value.length;
      hash.update(value);
    });
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return { bytes, sha256: hash.digest("hex") };
}

async function snapshotSource(root: string): Promise<SourceSnapshot> {
  const absoluteRoot = resolve(root);
  const paths = await listSourceFiles(absoluteRoot);
  return Object.fromEntries(
    await Promise.all(paths.map(async (filePath) => [
      relative(absoluteRoot, filePath),
      await hashFile(filePath)
    ] as const))
  );
}

function changedSnapshotPaths(before: SourceSnapshot, after: SourceSnapshot) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths]
    .filter((filePath) =>
      before[filePath]?.bytes !== after[filePath]?.bytes ||
      before[filePath]?.sha256 !== after[filePath]?.sha256
    )
    .sort();
}

async function writeReport(reportPath: string, report: DailyBriefReplayReport) {
  if (await exists(reportPath)) throw new Error(`Daily Brief replay report already exists: ${reportPath}`);
  await mkdir(dirname(reportPath), { recursive: true });
  const temporaryPath = `${reportPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(report, null, 2), { encoding: "utf8", flag: "wx" });
    await link(temporaryPath, reportPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function runDailyBriefReplay(input: RunDailyBriefReplayInput) {
  const dataDir = resolve(input.dataDir);
  const reportPath = resolve(input.reportPath);
  const remote = input.remote === true;
  assertDailyBriefReplayReportPath({ dataDir, reportPath });
  await assertCanonicalDailyBriefReplayReportPath({ dataDir, reportPath });
  if (await exists(reportPath)) throw new Error(`Daily Brief replay report already exists: ${reportPath}`);
  if (remote && process.env.RUN_DAILY_BRIEF_REMOTE_VERIFY !== "1") {
    throw new Error("Remote Daily Brief replay requires RUN_DAILY_BRIEF_REMOTE_VERIFY=1");
  }
  if (remote && !input.provider) throw new Error("Remote Daily Brief replay requires an explicit provider");

  const before = await snapshotSource(dataDir);
  const artifacts = await loadDailyBriefReplayArtifacts({
    dataDir,
    uploadId: input.uploadId,
    ...(input.userId ? { userId: input.userId } : {})
  });
  const historical = historicalAudit(artifacts);
  const originalFetch = globalThis.fetch;
  let blockedAttempts = 0;
  let remoteCalls = 0;
  if (remote) {
    globalThis.fetch = (async (...arguments_: Parameters<typeof fetch>) => {
      remoteCalls += 1;
      return await originalFetch(...arguments_);
    }) as typeof fetch;
  } else {
    globalThis.fetch = (async () => {
      blockedAttempts += 1;
      throw new Error("Network access is disabled during offline Daily Brief replay");
    }) as typeof fetch;
  }

  const events: ExtractionProgressEvent[] = [];
  const replayStartedAt = Date.now();
  let items: BriefItem[];
  let offlineFixture = false;
  try {
    if (input.provider) {
      items = await input.provider.extract(artifacts.upload.id, artifacts.segments, {
        semanticSegments: artifacts.semanticSegments,
        onProgress: (event) => { events.push(event); }
      });
    } else {
      offlineFixture = true;
      const result = await processDailyBriefChunks({
        uploadId: artifacts.upload.id,
        segments: artifacts.segments,
        semanticSegments: artifacts.semanticSegments,
        concurrency: 2,
        onProgress: (event) => { events.push(event); },
        executeChunk: async (chunk) => {
          const checkpoint = artifacts.checkpointByChunkIndex.get(chunk.index)!;
          return {
            items: normalizeBenchmarkEvidence(
              BriefItemsSchema.parse(checkpoint.output),
              chunk.segments
            ),
            // This execution consumes a retained fixture. Historical provider/fallback
            // provenance is reported separately and must not be replayed as a new failure.
            resultSource: "provider_success"
          };
        },
        fallbackChunk: async (_chunk, error) => { throw error; },
        providerLabel: "fixture"
      });
      items = result.items;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  items = BriefItemsSchema.parse(items);
  validateItemsAgainstSegments({
    uploadId: artifacts.upload.id,
    label: "replay output",
    segments: artifacts.segments,
    items,
    requireVerbatimExcerpt: Boolean(input.provider)
  });
  const replayWallClockMs = Date.now() - replayStartedAt;
  const offlineBenchmark = await runOfflineSchedulerBenchmark(artifacts);

  const after = await snapshotSource(dataDir);
  const changedPaths = changedSnapshotPaths(before, after);
  if (changedPaths.length > 0) {
    throw new Error(`Daily Brief replay changed retained source artifacts: ${changedPaths.join(", ")}`);
  }
  const executionKind = remote
    ? "remote_provider" as const
    : input.provider
      ? "offline_injected_provider" as const
      : "offline_retained_checkpoint_fixture" as const;
  const report: DailyBriefReplayReport = {
    version: 1,
    generatedAt: input.now?.() ?? new Date().toISOString(),
    mode: remote ? "remote" : "offline",
    uploadId: artifacts.upload.id,
    userId: artifacts.userId,
    recordingDate: artifacts.upload.recordingDate,
    execution: {
      kind: executionKind,
      providerLatencyMeasured: remote,
      replayWallClockMs,
      latencyInterpretation: remote
        ? "remote_stage_wall_clock_including_retries_fallback_and_merge"
        : input.provider
          ? "injected_offline_harness_only_not_provider_latency"
          : "fixture_harness_only_not_provider_latency"
    },
    artifacts: {
      transcriptSegments: artifacts.segments.length,
      semanticSegments: artifacts.semanticSegments.length,
      plannedChunks: artifacts.chunks.length,
      retainedCheckpoints: artifacts.checkpoints.length,
      baselineItems: artifacts.baselineItems.length
    },
    historical,
    replay: {
      outputDigestSha256: outputDigest(items),
      matchesRetainedFinalOutput: outputDigest(items) === historical.retainedFinalOutputDigestSha256,
      itemAudits: itemAudits(items),
      chunkAudits: replayChunkAudits(artifacts.chunks, events, offlineFixture),
      events,
      stats: replayStats(events, items, artifacts.chunks.length)
    },
    evidence: {
      historicalCheckpointOutputs: evidenceAudit({
        items: artifacts.chunks.flatMap((chunk) =>
          BriefItemsSchema.parse(artifacts.checkpointByChunkIndex.get(chunk.index)!.output)
        ),
        segments: artifacts.segments,
        chunks: artifacts.chunks
      }),
      replayOutput: evidenceAudit({ items, segments: artifacts.segments, chunks: artifacts.chunks })
    },
    offlineBenchmark,
    network: {
      remoteAllowed: remote,
      blockedAttempts,
      remoteCalls,
      observationScope: "global_fetch_only",
      executionIsolation: "dedicated_cli_process_required"
    },
    integrity: {
      sourceArtifactsUnchanged: changedPaths.length === 0,
      changedPaths
    }
  };
  await writeReport(reportPath, report);
  return { reportPath, report, items };
}
