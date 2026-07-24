// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AudioInsightSchema, type TranscriptSegment } from "@/lib/domain/types";
import { resolveAnalysisTranscriptChunks } from "@/lib/server/analysis-chunks/transcript-chunks";
import { RawRelationshipSignalItemSchema } from "@/lib/processing/relationship-signals";
import type { RelationshipSignalProvider } from "./provider";
import {
  assertRelationshipReplayReportPath,
  createRetainedRelationshipReplayProvider,
  loadRelationshipReplayArtifacts,
  runRelationshipReplay
} from "./replay";

const timestamp = "2026-07-15T08:00:00.000Z";
const uploadId = "retained_upload_1";
const userId = "retained_user_1";
const temporaryRoots = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    [...temporaryRoots].map((root) => rm(root, { recursive: true, force: true }))
  );
  temporaryRoots.clear();
});

function relationshipSegments(): TranscriptSegment[] {
  return [
    {
      id: "retained_segment_1",
      uploadId,
      startSeconds: 10,
      endSeconds: 18,
      speaker: "speaker_a",
      text: "关系 interaction: I can review your resume with you at 8:00 PM on Saturday.",
      confidence: 0.98,
      sceneLabels: [],
      valueLabels: ["commitment"]
    },
    {
      id: "retained_segment_2",
      uploadId,
      startSeconds: 19,
      endSeconds: 27,
      speaker: "speaker_a",
      text: "I will send the concrete revision notes before Sunday morning.",
      confidence: 0.98,
      sceneLabels: [],
      valueLabels: ["commitment"]
    }
  ];
}

function relationshipCandidate() {
  return RawRelationshipSignalItemSchema.parse({
    signalType: "clear_commitment",
    signalCategory: "positive",
    severity: "low",
    confidence: 0.96,
    summary: "A specific resume review and follow-up were promised for the weekend.",
    explanation: "The interaction includes a concrete action, time and delivery commitment.",
    involvedSpeakers: ["speaker_a"],
    evidenceSegmentIds: ["retained_segment_1", "retained_segment_2"],
    evidenceSegments: [],
    textEvidence: [],
    suggestedReflection: "Did the promised review and follow-up happen at the agreed time?"
  });
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function retainedTree() {
  const root = await mkdtemp(join(tmpdir(), "relationship-replay-"));
  temporaryRoots.add(root);
  const dataDir = join(root, "retained-runtime");
  const userRoot = join(dataDir, "users", userId);
  const reportPath = join(root, "benchmark-output", "report.json");
  const segments = relationshipSegments();
  const transcriptChunks = resolveAnalysisTranscriptChunks({
    uploadId,
    segments,
    maxDurationSeconds: 300,
    now: () => timestamp
  });
  const insight = AudioInsightSchema.parse({
    id: "retained_insight_1",
    uploadId,
    sourceSegmentIds: segments.map((segment) => segment.id),
    sourceTimeRange: { startSeconds: 10, endSeconds: 27 },
    speaker: { id: "speaker_a", role: "unknown", confidence: 0.9 },
    voice: {
      pace: "normal",
      volume: "unknown",
      pause: "unknown",
      overlap: false,
      confidence: 0.8
    },
    toneLabels: ["comforting"],
    emotionLabels: ["neutral"],
    interactionLabels: ["rapport"],
    summary: "The speaker made a concrete, time-bound offer to help and follow up.",
    evidence: segments.map((segment) => segment.text).join(" "),
    confidence: 0.94
  });
  const item = relationshipCandidate();
  const retainedResponseText = JSON.stringify({ items: [item] });
  const checkpointCandidate = {
    id: `${uploadId}_relationship_candidate_00000_001`,
    uploadId,
    transcriptChunkId: transcriptChunks[0].id,
    chunkIndex: 0,
    item
  };
  const checkpoint = {
    version: 1,
    id: `${userId}_${uploadId}_relationship_candidate_00000_fixture`,
    userId,
    uploadId,
    kind: "relationship_candidate",
    sourceChunkId: transcriptChunks[0].id,
    sourceChunkIndex: 0,
    inputFingerprint: "a".repeat(64),
    processorFingerprint: "b".repeat(64),
    status: "completed",
    resultSource: "provider_success",
    attemptCount: 1,
    createdAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
    output: [checkpointCandidate],
    metadata: {
      fixture: true,
      validationRejections: [],
      requestMetrics: {
        transcriptCharacterCount: 180,
        insightCharacterCount: 140,
        promptCharacterCount: 780
      },
      responseDiagnostics: {
        responseTextLength: retainedResponseText.length
      }
    }
  };

  const files = {
    upload: join(userRoot, "uploads", `${uploadId}.json`),
    segments: join(userRoot, "segments", `${uploadId}.json`),
    audioInsights: join(userRoot, "audio-insights", `${uploadId}.json`),
    semanticSegments: join(userRoot, "semantic-segments", `${uploadId}.json`),
    transcriptChunk: join(userRoot, "transcript-chunks", `${transcriptChunks[0].id}.json`),
    checkpoint: join(userRoot, "analysis-chunks", `${checkpoint.id}.json`),
    relationshipCards: join(userRoot, "relationship-signals", `${uploadId}.json`),
    memory: join(dataDir, "memory.sqlite"),
    memoryWal: join(dataDir, "memory.sqlite-wal"),
    memoryShm: join(dataDir, "memory.sqlite-shm")
  };

  await mkdir(dataDir, { recursive: true });
  await Promise.all([
    writeJson(files.upload, {
      id: uploadId,
      originalName: "retained.wav",
      mimeType: "audio/wav",
      sizeBytes: 1234,
      recordingDate: "2026-07-15",
      createdAt: timestamp,
      durationSeconds: 30,
      status: "ready",
      filePath: join(userRoot, "uploads", `${uploadId}.wav`),
      evaluationRetention: true
    }),
    writeJson(files.segments, segments),
    writeJson(files.audioInsights, [insight]),
    writeJson(files.semanticSegments, []),
    writeJson(files.transcriptChunk, transcriptChunks[0]),
    writeJson(files.checkpoint, checkpoint),
    writeJson(files.relationshipCards, []),
    writeFile(files.memory, "memory-database-sentinel", "utf8"),
    writeFile(files.memoryWal, "memory-wal-sentinel", "utf8"),
    writeFile(files.memoryShm, "memory-shm-sentinel", "utf8")
  ]);

  return { root, dataDir, userRoot, reportPath, segments, transcriptChunks, files };
}

async function digestFiles(files: Record<string, string>) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(async ([name, filePath]) => [
        name,
        createHash("sha256").update(await readFile(filePath)).digest("hex")
      ])
    )
  );
}

describe("Relationship-only retained artifact replay", () => {
  it("loads a retained-like upload without requiring the full Pipeline", async () => {
    const fixture = await retainedTree();

    const artifacts = await loadRelationshipReplayArtifacts({
      dataDir: fixture.dataDir,
      uploadId
    });

    expect(artifacts.userId).toBe(userId);
    expect(artifacts.upload).toMatchObject({ id: uploadId, recordingDate: "2026-07-15", status: "ready" });
    expect(artifacts.segments.map((segment) => segment.id)).toEqual(fixture.segments.map((segment) => segment.id));
    expect(artifacts.transcriptChunks).toHaveLength(1);
    expect(artifacts.audioInsights).toHaveLength(1);
    expect(artifacts.semanticSegments).toEqual([]);
    expect(artifacts.relationshipCheckpoints).toHaveLength(1);
    expect(artifacts.baselineCards).toEqual([]);
  });

  it("runs only Relationship provider plus reducer offline and leaves retained artifacts unchanged", async () => {
    const fixture = await retainedTree();
    const before = await digestFiles(fixture.files);
    let providerCalls = 0;
    let replayNetworkGuardBlocked = false;
    const hostFetch = vi.fn(async () => new Response("unexpected external response"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = hostFetch as typeof fetch;
    const provider: RelationshipSignalProvider = {
      async analyze() {
        return [];
      },
      async extractCandidates() {
        providerCalls += 1;
        try {
          await fetch("https://relationship-replay.invalid/provider");
        } catch {
          replayNetworkGuardBlocked = true;
        }
        return [relationshipCandidate()];
      }
    };

    try {
      const result = await runRelationshipReplay({
        dataDir: fixture.dataDir,
        uploadId,
        reportPath: fixture.reportPath,
        provider,
        remote: false,
        now: () => timestamp
      });

      expect(providerCalls).toBe(1);
      expect(replayNetworkGuardBlocked).toBe(true);
      expect(hostFetch).not.toHaveBeenCalled();
      expect(globalThis.fetch).toBe(hostFetch);
      expect(result.reportPath).toBe(fixture.reportPath);
      expect(result.report).toMatchObject({
        version: 1,
        mode: "offline",
        uploadId,
        userId,
        network: {
          remoteAllowed: false,
          blockedAttempts: 1,
          remoteCalls: 0
        },
        evidenceFirst: {
          invalidSourceIds: 0,
          quoteMismatch: 0,
          safetyViolations: 0
        },
        integrity: {
          sourceArtifactsUnchanged: true,
          changedPaths: []
        }
      });
      expect(result.report.stats.cardCount).toBe(1);
      expect(result.report.cards).toHaveLength(1);
      expect(result.report.cards[0].signalType).toBe("clear_commitment");
      expect(result.report.cards[0].evidenceSegments.map((evidence) => evidence.segmentId)).toEqual(
        fixture.segments.map((segment) => segment.id)
      );
      expect(JSON.parse(await readFile(fixture.reportPath, "utf8"))).toEqual(result.report);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(await digestFiles(fixture.files)).toEqual(before);
  });

  it("benchmarks retained full candidates against the selected compact request contract offline", async () => {
    const fixture = await retainedTree();
    const before = await digestFiles(fixture.files);
    const reportPath = join(fixture.root, "benchmark-output", "retained-provider-report.json");
    const hostFetch = vi.fn(async () => new Response("unexpected external response"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = hostFetch as typeof fetch;

    try {
      const result = await runRelationshipReplay({
        dataDir: fixture.dataDir,
        uploadId,
        reportPath,
        remote: false,
        now: () => timestamp
      });

      expect(hostFetch).not.toHaveBeenCalled();
      expect(result.report.network).toEqual({
        remoteAllowed: false,
        blockedAttempts: 0,
        remoteCalls: 0
      });
      expect(result.report.chunkAudits[0]).toMatchObject({
        insightsBefore: 1,
        insightsAfter: 1,
        outputTokensBudget: 2_800
      });
      expect(result.report.chunkAudits[0].promptChars).toBeGreaterThan(0);
      expect(result.report.benchmark).toMatchObject({
        tokenEstimateMethod: "ceil_json_chars_div_2",
        beforeMeasurementSource: "retained_checkpoint_metadata",
        retainedCheckpointsWithoutRequestMetrics: 0,
        retainedCheckpointsWithoutResponseDiagnostics: 0,
        providerLatencyMeasured: false,
        before: { providerCandidates: 1, validCandidates: 1, finalCards: 0 },
        after: { providerCandidates: 1, validCandidates: 1, finalCards: 1 }
      });
      expect(result.report.benchmark.after.outputChars).toBeLessThan(
        result.report.benchmark.before.outputChars
      );
      expect(result.report.integrity).toEqual({
        sourceArtifactsUnchanged: true,
        changedPaths: []
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(await digestFiles(fixture.files)).toEqual(before);
  });

  it("rejects a report path inside the retained source data directory", async () => {
    const fixture = await retainedTree();
    const nestedReport = join(fixture.dataDir, "evaluation", "relationship-replay.json");

    expect(() =>
      assertRelationshipReplayReportPath({ dataDir: fixture.dataDir, reportPath: nestedReport })
    ).toThrow(/outside.*data|source.*directory|retained/iu);
    expect(() =>
      assertRelationshipReplayReportPath({ dataDir: fixture.dataDir, reportPath: fixture.reportPath })
    ).not.toThrow();
  });

  it("does not mistake a missing retained candidate checkpoint for an empty-signal chunk", async () => {
    const fixture = await retainedTree();
    const artifacts = await loadRelationshipReplayArtifacts({
      dataDir: fixture.dataDir,
      uploadId
    });

    expect(() => createRetainedRelationshipReplayProvider({
      ...artifacts,
      relationshipCheckpoints: []
    })).toThrow(/checkpoints.*missing|missing.*chunks/iu);
  });
});
