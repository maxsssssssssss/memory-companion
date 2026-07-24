import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import type { TranscriptChunk } from "@/lib/domain/chunks";
import {
  AudioInsightSchema,
  AudioUploadSchema,
  RelationshipSignalCardSchema,
  SemanticSegmentSchema,
  TranscriptSegmentSchema,
  type AudioInsight,
  type AudioUpload,
  type RelationshipSignalCard,
  type SemanticSegment,
  type TranscriptSegment
} from "@/lib/domain/types";
import {
  AnalysisChunkCheckpointSchema,
  JsonAnalysisChunkCheckpointStore,
  type AnalysisChunkCheckpoint
} from "@/lib/server/analysis-chunks/checkpoint";
import { resolveAnalysisTranscriptChunks } from "@/lib/server/analysis-chunks/transcript-chunks";
import { containsForbiddenRelationshipJudgment } from "@/lib/processing/relationship-signals";
import { JsonStore } from "@/lib/server/storage/json-store";
import { JsonChunkCheckpointStore } from "@/lib/server/transcription/chunks/checkpoint-store";
import { RelationshipSignalCandidateSchema } from "./candidates";
import { processRelationshipSignalChunks } from "./chunk-processing";
import { buildRelationshipSignalRequestPlan } from "./openai-provider";
import type { RelationshipSignalProvider } from "./provider";

const SAFE_STORE_ID = /^[A-Za-z0-9_-]+$/u;
const RelationshipCandidateArraySchema = z.array(RelationshipSignalCandidateSchema);

type SourceSnapshot = Record<string, { bytes: number; sha256: string }>;
type SignalTypeCoverage = Record<RelationshipSignalCard["signalType"], number>;

type RelationshipReplayBenchmarkSnapshot = {
  transcriptChars: number;
  insightChars: number;
  promptChars: number;
  outputChars: number;
  outputMeasurement:
    | "retained_response_diagnostics"
    | "retained_compact_projection"
    | "remote_response_diagnostics";
  estimatedOutputTokens: number;
  providerCandidates: number;
  validCandidates: number;
  finalCards: number;
  typeCoverage: SignalTypeCoverage;
  firstWindowCards: number;
  longRecording45mV1Coverage: Record<string, boolean> | null;
};

export type RelationshipReplayArtifacts = {
  userId: string;
  userRoot: string;
  upload: AudioUpload;
  segments: TranscriptSegment[];
  transcriptChunks: TranscriptChunk[];
  audioInsights: AudioInsight[];
  semanticSegments: SemanticSegment[];
  relationshipCheckpoints: AnalysisChunkCheckpoint[];
  baselineCards: RelationshipSignalCard[];
};

export type RelationshipReplayReport = {
  version: 1;
  generatedAt: string;
  mode: "offline" | "remote";
  uploadId: string;
  userId: string;
  recordingDate: string;
  artifacts: {
    transcriptSegments: number;
    transcriptChunks: number;
    audioInsights: number;
    semanticSegments: number;
    relationshipCheckpoints: number;
    baselineCards: number;
  };
  cards: RelationshipSignalCard[];
  stats: Awaited<ReturnType<typeof processRelationshipSignalChunks>>["stats"];
  chunkAudits: Awaited<ReturnType<typeof processRelationshipSignalChunks>>["chunkAudits"];
  reducerAudit: Awaited<ReturnType<typeof processRelationshipSignalChunks>>["reducerAudit"];
  benchmark: {
    tokenEstimateMethod: "ceil_json_chars_div_2";
    beforeMeasurementSource: "retained_checkpoint_metadata";
    retainedCheckpointsWithoutRequestMetrics: number;
    retainedCheckpointsWithoutResponseDiagnostics: number;
    providerLatencyMeasured: boolean;
    before: RelationshipReplayBenchmarkSnapshot;
    after: RelationshipReplayBenchmarkSnapshot;
  };
  network: {
    remoteAllowed: boolean;
    blockedAttempts: number;
    remoteCalls: number;
  };
  evidenceFirst: {
    invalidSourceIds: number;
    quoteMismatch: number;
    safetyViolations: number;
  };
  integrity: {
    sourceArtifactsUnchanged: boolean;
    changedPaths: string[];
  };
};

export type RunRelationshipReplayInput = {
  dataDir: string;
  uploadId: string;
  reportPath: string;
  userId?: string;
  provider?: RelationshipSignalProvider;
  remote?: boolean;
  now?: () => string;
};

function assertSafeStoreId(value: string, label: string) {
  if (!SAFE_STORE_ID.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
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

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
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
    const uploadPath = resolve(usersDirectory, entry.name, "uploads", `${input.uploadId}.json`);
    if (await exists(uploadPath)) matches.push(entry.name);
  }
  if (matches.length === 0) {
    throw new Error(`Retained upload was not found: ${input.uploadId}`);
  }
  if (matches.length > 1) {
    throw new Error(`Retained upload is ambiguous across users: ${input.uploadId}`);
  }
  return matches[0];
}

export async function loadRelationshipReplayArtifacts(input: {
  dataDir: string;
  uploadId: string;
  userId?: string;
}): Promise<RelationshipReplayArtifacts> {
  assertSafeStoreId(input.uploadId, "uploadId");
  const dataDir = resolve(input.dataDir);
  const userId = await findReplayUser({ ...input, dataDir });
  const userRoot = resolve(dataDir, "users", userId);
  const store = new JsonStore(userRoot);
  const [upload, segments, audioInsights, semanticSegments, baselineCards, checkpointChunks, checkpoints] =
    await Promise.all([
      readParsed(resolve(userRoot, "uploads", `${input.uploadId}.json`), AudioUploadSchema),
      readParsed(resolve(userRoot, "segments", `${input.uploadId}.json`), z.array(TranscriptSegmentSchema)),
      readParsed(resolve(userRoot, "audio-insights", `${input.uploadId}.json`), z.array(AudioInsightSchema)),
      readParsed(resolve(userRoot, "semantic-segments", `${input.uploadId}.json`), z.array(SemanticSegmentSchema)),
      readParsed(resolve(userRoot, "relationship-signals", `${input.uploadId}.json`), z.array(RelationshipSignalCardSchema)),
      new JsonChunkCheckpointStore(store).listTranscriptChunks(input.uploadId),
      new JsonAnalysisChunkCheckpointStore(store).list({
        userId,
        uploadId: input.uploadId,
        kind: "relationship_candidate"
      })
    ]);

  if (upload.id !== input.uploadId) {
    throw new Error(`Retained upload record id does not match ${input.uploadId}`);
  }
  if (segments.length === 0) {
    throw new Error(`Retained transcript is empty for upload ${input.uploadId}`);
  }
  if (checkpointChunks.length === 0) {
    throw new Error(`Retained TranscriptChunk artifacts are missing for upload ${input.uploadId}`);
  }
  const transcriptChunks = resolveAnalysisTranscriptChunks({
    uploadId: input.uploadId,
    segments,
    checkpointChunks
  });
  const retainedSegmentIds = new Set(checkpointChunks.flatMap((chunk) => chunk.segments.map((segment) => segment.id)));
  if (segments.some((segment) => !retainedSegmentIds.has(segment.id))) {
    throw new Error(`Retained TranscriptChunk coverage is incomplete for upload ${input.uploadId}`);
  }

  return {
    userId,
    userRoot,
    upload,
    segments,
    transcriptChunks,
    audioInsights,
    semanticSegments,
    relationshipCheckpoints: checkpoints.map((checkpoint) => AnalysisChunkCheckpointSchema.parse(checkpoint)),
    baselineCards
  };
}

function chunkSignature(segments: TranscriptSegment[]) {
  return segments.map((segment) => segment.id).join("\u001f");
}

export function createRetainedRelationshipReplayProvider(
  artifacts: RelationshipReplayArtifacts
): RelationshipSignalProvider {
  const chunkById = new Map(artifacts.transcriptChunks.map((chunk) => [chunk.id, chunk]));
  const itemsByChunk = new Map<string, z.infer<typeof RelationshipCandidateArraySchema>[number]["item"][]>();
  for (const checkpoint of artifacts.relationshipCheckpoints) {
    if (checkpoint.status !== "completed" || checkpoint.output === undefined) continue;
    const chunk = chunkById.get(checkpoint.sourceChunkId);
    const parsed = RelationshipCandidateArraySchema.safeParse(checkpoint.output);
    if (!chunk || !parsed.success) continue;
    const signature = chunkSignature(chunk.segments);
    if (itemsByChunk.has(signature)) {
      throw new Error(`Retained Relationship checkpoints are ambiguous for chunk ${chunk.index}`);
    }
    itemsByChunk.set(
      signature,
      parsed.data.map((candidate) => candidate.item)
    );
  }
  const missingChunks = artifacts.transcriptChunks.filter(
    (chunk) => !itemsByChunk.has(chunkSignature(chunk.segments))
  );
  if (missingChunks.length > 0) {
    throw new Error(
      `Retained Relationship checkpoints are missing or invalid for chunks: ${missingChunks.map((chunk) => chunk.index).join(",")}`
    );
  }

  return {
    async analyze() {
      return [];
    },
    async extractCandidates(input) {
      const plan = buildRelationshipSignalRequestPlan(input);
      input.onRequestMetrics?.(plan.metrics);
      const candidates = itemsByChunk.get(chunkSignature(input.segments)) ?? [];
      let selected = candidates;
      if (candidates.length > plan.limit) {
        const ranked = candidates
          .map((candidate, index) => ({
            candidate,
            index,
            score: candidate.confidence * 1_000
              + new Set(candidate.evidenceSegmentIds).size * 10
              + Math.min(180, candidate.summary.length) / 180
          }))
          .sort((left, right) => right.score - left.score || left.index - right.index);
        selected = [];
        for (const { candidate } of ranked) {
          if (selected.length >= plan.limit) break;
          selected.push(candidate);
        }
      }
      return selected;
    }
  };
}

function emptySignalTypeCoverage(): SignalTypeCoverage {
  return {
    active_listening: 0,
    emotional_support: 0,
    boundary_respect: 0,
    clear_commitment: 0,
    evasive_answer: 0,
    invalidating_or_belittling: 0
  };
}

function cardOverlapsWindow(card: RelationshipSignalCard, startSeconds: number, endSeconds: number) {
  return card.evidenceSegments.some(
    (evidence) => evidence.startSeconds < endSeconds && evidence.endSeconds > startSeconds
  );
}

function longRecording45mV1Coverage(cards: RelationshipSignalCard[]) {
  const has = (
    startSeconds: number,
    endSeconds: number,
    types: RelationshipSignalCard["signalType"][]
  ) => cards.some((card) => types.includes(card.signalType) && cardOverlapsWindow(card, startSeconds, endSeconds));
  return {
    workPressureSupport: has(300, 600, ["active_listening", "emotional_support"]),
    resumeCommitment: has(600, 900, ["clear_commitment"])
      || has(2_400, 2_683, ["clear_commitment"]),
    onlineConflictConcern: has(1_500, 1_800, [
      "active_listening",
      "emotional_support",
      "boundary_respect",
      "evasive_answer",
      "invalidating_or_belittling"
    ]),
    pauseAndResumeAgreement: has(1_800, 2_100, ["boundary_respect", "clear_commitment"])
      || has(2_400, 2_683, ["boundary_respect", "clear_commitment"]),
    museumPlan: has(900, 1_200, ["clear_commitment", "boundary_respect", "active_listening"])
      || has(2_100, 2_400, ["clear_commitment", "boundary_respect", "active_listening"]),
    preferenceRespectWindowCard: has(600, 900, ["active_listening", "boundary_respect"])
      || has(2_100, 2_683, ["active_listening", "boundary_respect"])
  };
}

function cardSnapshot(cards: RelationshipSignalCard[], includeLongRecordingAudit: boolean) {
  const typeCoverage = emptySignalTypeCoverage();
  for (const card of cards) typeCoverage[card.signalType] += 1;
  return {
    typeCoverage,
    firstWindowCards: cards.filter((card) => cardOverlapsWindow(card, 0, 300)).length,
    longRecording45mV1Coverage: includeLongRecordingAudit
      ? longRecording45mV1Coverage(cards)
      : null
  };
}

function compactCandidateProjection(candidate: z.infer<typeof RelationshipCandidateArraySchema>[number]["item"]) {
  return {
    signalType: candidate.signalType,
    severity: candidate.severity,
    confidence: candidate.confidence,
    summary: candidate.summary,
    evidenceSegmentIds: candidate.evidenceSegmentIds,
    ...(candidate.caution ? { caution: candidate.caution } : {})
  };
}

function numericMetric(metadata: Record<string, unknown>, key: string) {
  const requestMetrics = metadata.requestMetrics;
  if (!requestMetrics || typeof requestMetrics !== "object") return null;
  const value = (requestMetrics as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numericNestedMetadataMetric(
  metadata: Record<string, unknown>,
  parent: string,
  key: string
) {
  const nested = metadata[parent];
  if (!nested || typeof nested !== "object") return null;
  const value = (nested as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function benchmarkReport(
  artifacts: RelationshipReplayArtifacts,
  result: Awaited<ReturnType<typeof processRelationshipSignalChunks>>,
  remote: boolean
) {
  const completedCheckpoints = artifacts.relationshipCheckpoints.filter(
    (checkpoint) => checkpoint.status === "completed" && checkpoint.output !== undefined
  );
  const retainedCandidates = completedCheckpoints.flatMap((checkpoint) => {
    const parsed = RelationshipCandidateArraySchema.safeParse(checkpoint.output);
    return parsed.success ? parsed.data.map((candidate) => candidate.item) : [];
  });
  const checkpointsWithMetrics = completedCheckpoints.filter(
    (checkpoint) => numericMetric(checkpoint.metadata, "promptCharacterCount") !== null
  );
  const checkpointsWithResponseDiagnostics = completedCheckpoints.filter(
    (checkpoint) => numericNestedMetadataMetric(
      checkpoint.metadata,
      "responseDiagnostics",
      "responseTextLength"
    ) !== null
  );
  const sumRetainedMetric = (key: string) => completedCheckpoints.reduce(
    (total, checkpoint) => total + (numericMetric(checkpoint.metadata, key) ?? 0),
    0
  );
  const firstAttemptMetric = (
    audit: Awaited<ReturnType<typeof processRelationshipSignalChunks>>["chunkAudits"][number],
    key: "transcriptCharacterCount" | "insightCharsAfter" | "promptCharacterCount"
  ) => audit.attempts.find((attempt) => attempt.attempt === 1)?.requestMetrics?.[key] ?? 0;
  const sumFirstAttemptMetric = (
    key: "transcriptCharacterCount" | "insightCharsAfter" | "promptCharacterCount"
  ) => result.chunkAudits.reduce((total, audit) => total + firstAttemptMetric(audit, key), 0);
  const beforeOutputChars = completedCheckpoints.reduce(
    (total, checkpoint) => total + (numericNestedMetadataMetric(
      checkpoint.metadata,
      "responseDiagnostics",
      "responseTextLength"
    ) ?? 0),
    0
  );
  const projectedCompactOutputChars = completedCheckpoints.reduce((total, checkpoint) => {
    const parsed = RelationshipCandidateArraySchema.safeParse(checkpoint.output);
    if (!parsed.success) return total;
    return total + JSON.stringify({
      items: parsed.data.map((candidate) => compactCandidateProjection(candidate.item))
    }).length;
  }, 0);
  const remoteOutputChars = result.chunkAudits.reduce(
    (total, audit) => total + audit.attempts.reduce(
      (attemptTotal, attempt) => attemptTotal + (attempt.responseTextChars ?? 0),
      0
    ),
    0
  );
  const afterOutputChars = remote ? remoteOutputChars : projectedCompactOutputChars;
  const validationRejectedCandidates = completedCheckpoints.reduce((total, checkpoint) => {
    const rejections = checkpoint.metadata.validationRejections;
    return total + (Array.isArray(rejections) ? rejections.length : 0);
  }, 0);
  const afterProviderCandidates = result.chunkAudits.reduce((total, audit) => {
    const finalAttempt = audit.attempts.at(-1);
    return total + (finalAttempt?.rawCandidateCount ?? finalAttempt?.validCandidateCount ?? 0);
  }, 0);
  const retainedDurationSeconds = typeof artifacts.upload.durationSeconds === "number"
    ? artifacts.upload.durationSeconds
    : Math.max(0, ...artifacts.segments.map((segment) => segment.endSeconds));
  const includeLongRecordingAudit = artifacts.transcriptChunks.length === 9
    && retainedDurationSeconds >= 2_600
    && retainedDurationSeconds <= 2_750;
  const beforeCardSnapshot = cardSnapshot(artifacts.baselineCards, includeLongRecordingAudit);
  const afterCardSnapshot = cardSnapshot(result.cards, includeLongRecordingAudit);
  return {
    tokenEstimateMethod: "ceil_json_chars_div_2" as const,
    beforeMeasurementSource: "retained_checkpoint_metadata" as const,
    retainedCheckpointsWithoutRequestMetrics: completedCheckpoints.length - checkpointsWithMetrics.length,
    retainedCheckpointsWithoutResponseDiagnostics:
      completedCheckpoints.length - checkpointsWithResponseDiagnostics.length,
    providerLatencyMeasured: remote,
    before: {
      transcriptChars: sumRetainedMetric("transcriptCharacterCount"),
      insightChars: sumRetainedMetric("insightCharacterCount"),
      promptChars: sumRetainedMetric("promptCharacterCount"),
      outputChars: beforeOutputChars,
      outputMeasurement: "retained_response_diagnostics" as const,
      estimatedOutputTokens: Math.ceil(beforeOutputChars / 2),
      providerCandidates: retainedCandidates.length + validationRejectedCandidates,
      validCandidates: retainedCandidates.length,
      finalCards: artifacts.baselineCards.length,
      ...beforeCardSnapshot
    },
    after: {
      transcriptChars: sumFirstAttemptMetric("transcriptCharacterCount"),
      insightChars: sumFirstAttemptMetric("insightCharsAfter"),
      promptChars: sumFirstAttemptMetric("promptCharacterCount"),
      outputChars: afterOutputChars,
      outputMeasurement: remote
        ? "remote_response_diagnostics" as const
        : "retained_compact_projection" as const,
      estimatedOutputTokens: Math.ceil(afterOutputChars / 2),
      providerCandidates: afterProviderCandidates,
      validCandidates: result.stats.candidateCount,
      finalCards: result.cards.length,
      ...afterCardSnapshot
    }
  };
}

export function assertRelationshipReplayReportPath(input: { dataDir: string; reportPath: string }) {
  const dataDir = resolve(input.dataDir);
  const reportPath = resolve(input.reportPath);
  const relativePath = relative(dataDir, reportPath);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    throw new Error("Relationship replay report must be outside the retained source data directory");
  }
}

async function listSourceFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) {
      paths.push(...await listSourceFiles(root, path));
    } else if (entry.isFile()) {
      paths.push(path);
    }
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
    await Promise.all(paths.map(async (path) => [relative(absoluteRoot, path), await hashFile(path)] as const))
  );
}

function changedSnapshotPaths(before: SourceSnapshot, after: SourceSnapshot) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths]
    .filter((path) => before[path]?.bytes !== after[path]?.bytes || before[path]?.sha256 !== after[path]?.sha256)
    .sort();
}

function evidenceAudit(cards: RelationshipSignalCard[], segments: TranscriptSegment[]) {
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  let invalidSourceIds = 0;
  let quoteMismatch = 0;
  for (const evidence of cards.flatMap((card) => card.evidenceSegments)) {
    const source = segmentById.get(evidence.segmentId);
    if (!source) {
      invalidSourceIds += 1;
    } else if (source.text !== evidence.text) {
      quoteMismatch += 1;
    }
  }
  return {
    invalidSourceIds,
    quoteMismatch,
    safetyViolations: cards.filter((card) => containsForbiddenRelationshipJudgment(card)).length
  };
}

async function assertReportDoesNotExist(reportPath: string) {
  if (await exists(reportPath)) {
    throw new Error(`Relationship replay report already exists: ${reportPath}`);
  }
}

async function writeReport(reportPath: string, report: RelationshipReplayReport) {
  await mkdir(dirname(reportPath), { recursive: true });
  const temporaryPath = `${reportPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(report, null, 2), { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, reportPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function runRelationshipReplay(input: RunRelationshipReplayInput) {
  const dataDir = resolve(input.dataDir);
  const reportPath = resolve(input.reportPath);
  const remote = input.remote === true;
  assertRelationshipReplayReportPath({ dataDir, reportPath });
  await assertReportDoesNotExist(reportPath);
  if (remote && process.env.RUN_RELATIONSHIP_REMOTE_VERIFY !== "1") {
    throw new Error("Remote Relationship replay requires RUN_RELATIONSHIP_REMOTE_VERIFY=1");
  }
  if (remote && !input.provider) {
    throw new Error("Remote Relationship replay requires an explicit provider");
  }

  const before = await snapshotSource(dataDir);
  const artifacts = await loadRelationshipReplayArtifacts({
    dataDir,
    uploadId: input.uploadId,
    ...(input.userId ? { userId: input.userId } : {})
  });
  const provider = input.provider ?? createRetainedRelationshipReplayProvider(artifacts);
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
      throw new Error("Network access is disabled during offline Relationship replay");
    }) as typeof fetch;
  }

  let result: Awaited<ReturnType<typeof processRelationshipSignalChunks>>;
  try {
    result = await processRelationshipSignalChunks({
      uploadId: artifacts.upload.id,
      recordingDate: artifacts.upload.recordingDate,
      transcriptChunks: artifacts.transcriptChunks,
      segments: artifacts.segments,
      semanticSegments: artifacts.semanticSegments,
      audioInsights: artifacts.audioInsights,
      provider,
      options: {
        ...(input.now ? { now: input.now } : {})
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const after = await snapshotSource(dataDir);
  const changedPaths = changedSnapshotPaths(before, after);
  const generatedAt = input.now?.() ?? new Date().toISOString();
  const report: RelationshipReplayReport = {
    version: 1,
    generatedAt,
    mode: remote ? "remote" : "offline",
    uploadId: artifacts.upload.id,
    userId: artifacts.userId,
    recordingDate: artifacts.upload.recordingDate,
    artifacts: {
      transcriptSegments: artifacts.segments.length,
      transcriptChunks: artifacts.transcriptChunks.length,
      audioInsights: artifacts.audioInsights.length,
      semanticSegments: artifacts.semanticSegments.length,
      relationshipCheckpoints: artifacts.relationshipCheckpoints.length,
      baselineCards: artifacts.baselineCards.length
    },
    cards: result.cards,
    stats: result.stats,
    chunkAudits: result.chunkAudits,
    reducerAudit: result.reducerAudit,
    benchmark: benchmarkReport(artifacts, result, remote),
    network: {
      remoteAllowed: remote,
      blockedAttempts,
      remoteCalls
    },
    evidenceFirst: evidenceAudit(result.cards, artifacts.segments),
    integrity: {
      sourceArtifactsUnchanged: changedPaths.length === 0,
      changedPaths
    }
  };
  await writeReport(reportPath, report);
  return { reportPath, report };
}
