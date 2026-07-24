// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BriefItem, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import type { ExtractionProvider } from "./provider";
import { formatExtractionSegments, planExtractionChunks } from "./chunks";
import {
  assertDailyBriefReplayReportPath,
  loadDailyBriefReplayArtifacts,
  runDailyBriefReplay
} from "./replay";

const timestamp = "2026-07-15T08:00:00.000Z";
const uploadId = "retained_upload_1";
const userId = "retained_user_1";
const temporaryRoots = new Set<string>();
const originalFetch = globalThis.fetch;
const originalRemoteVerify = process.env.RUN_DAILY_BRIEF_REMOTE_VERIFY;

afterEach(async () => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  if (originalRemoteVerify === undefined) delete process.env.RUN_DAILY_BRIEF_REMOTE_VERIFY;
  else process.env.RUN_DAILY_BRIEF_REMOTE_VERIFY = originalRemoteVerify;
  await Promise.all([...temporaryRoots].map((root) => rm(root, { recursive: true, force: true })));
  temporaryRoots.clear();
});

function transcriptSegments(): TranscriptSegment[] {
  return [
    {
      id: "retained_segment_1",
      uploadId,
      startSeconds: 10,
      endSeconds: 18,
      speaker: "speaker_a",
      text: "A concrete action was agreed for Saturday evening.",
      confidence: 0.98,
      sceneLabels: [],
      valueLabels: ["commitment"]
    },
    {
      id: "retained_segment_2",
      uploadId,
      startSeconds: 19,
      endSeconds: 27,
      speaker: "speaker_b",
      text: "The follow-up notes will be sent before Sunday morning.",
      confidence: 0.97,
      sceneLabels: [],
      valueLabels: ["task"]
    }
  ];
}

function semanticSegments(segments: TranscriptSegment[]): SemanticSegment[] {
  return [{
    id: "retained_semantic_1",
    uploadId,
    title: "Weekend follow-up",
    summary: "A time-bound action and follow-up were discussed.",
    startSeconds: 10,
    endSeconds: 27,
    tags: ["follow-up"],
    sceneLabels: [],
    valueLabels: ["commitment"],
    confidence: 0.96,
    sourceSegmentIds: segments.map((segment) => segment.id),
    sourceTimeRange: { startSeconds: 10, endSeconds: 27 },
    transcriptExcerpt: segments[0].text
  }];
}

function briefItem(): BriefItem {
  return {
    id: "retained_brief_1",
    uploadId,
    category: "task",
    title: "Complete the agreed weekend follow-up",
    body: "The participants agreed on a concrete action and delivery window.",
    priority: "medium",
    confidence: 0.94,
    status: "candidate",
    sourceSegmentIds: ["retained_segment_1", "retained_segment_2"],
    sourceTimeRange: { startSeconds: 10, endSeconds: 27 },
    transcriptExcerpt: "A concrete action was agreed for Saturday evening.",
    people: ["speaker_a", "speaker_b"],
    topics: ["follow-up"]
  };
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function retainedTree() {
  const root = await mkdtemp(join(tmpdir(), "daily-brief-replay-"));
  temporaryRoots.add(root);
  const dataDir = join(root, "retained-runtime");
  const userRoot = join(dataDir, "users", userId);
  const reportPath = join(root, "benchmark-output", "report.json");
  const segments = transcriptSegments();
  const semantics = semanticSegments(segments);
  const chunks = planExtractionChunks({ segments, semanticSegments: semantics }).chunks;
  const item = briefItem();
  const checkpoint = {
    version: 1,
    id: `${userId}_${uploadId}_daily_brief_00000_fixture`,
    userId,
    uploadId,
    kind: "daily_brief",
    sourceChunkId: `${uploadId}_daily_brief_${chunks[0].id}`,
    sourceChunkIndex: 0,
    inputFingerprint: "a".repeat(64),
    processorFingerprint: "b".repeat(64),
    status: "completed",
    resultSource: "provider_success",
    attemptCount: 1,
    createdAt: timestamp,
    startedAt: timestamp,
    completedAt: "2026-07-15T08:00:01.250Z",
    updatedAt: "2026-07-15T08:00:01.250Z",
    output: [item],
    metadata: {
      inputCharacterCount: formatExtractionSegments(chunks[0].segments).length,
      segmentCount: chunks[0].segments.length
    }
  };
  const files = {
    upload: join(userRoot, "uploads", `${uploadId}.json`),
    audio: join(userRoot, "uploads", `${uploadId}.wav`),
    segments: join(userRoot, "segments", `${uploadId}.json`),
    semanticSegments: join(userRoot, "semantic-segments", `${uploadId}.json`),
    briefItems: join(userRoot, "brief-items", `${uploadId}.json`),
    checkpoint: join(userRoot, "analysis-chunks", `${checkpoint.id}.json`),
    memory: join(dataDir, "memory.sqlite")
  };

  await Promise.all([
    mkdir(join(userRoot, "uploads"), { recursive: true }),
    mkdir(dataDir, { recursive: true })
  ]);
  await Promise.all([
    writeJson(files.upload, {
      id: uploadId,
      originalName: "retained.wav",
      mimeType: "audio/wav",
      sizeBytes: 1234,
      recordingDate: "2026-07-15",
      createdAt: timestamp,
      durationSeconds: 30,
      status: "ready"
    }),
    writeFile(files.audio, "retained-audio-sentinel", "utf8"),
    writeJson(files.segments, segments),
    writeJson(files.semanticSegments, semantics),
    writeJson(files.briefItems, [item]),
    writeJson(files.checkpoint, checkpoint),
    writeFile(files.memory, "memory-database-sentinel", "utf8")
  ]);

  return { root, dataDir, userRoot, reportPath, segments, semantics, chunks, item, checkpoint, files };
}

async function digestFiles(files: Record<string, string>) {
  return Object.fromEntries(
    await Promise.all(Object.entries(files).map(async ([name, filePath]) => [
      name,
      createHash("sha256").update(await readFile(filePath)).digest("hex")
    ]))
  );
}

describe("Daily Brief-only retained artifact replay", () => {
  it("rebuilds Daily Brief chunks from transcript and semantic artifacts", async () => {
    const fixture = await retainedTree();

    const artifacts = await loadDailyBriefReplayArtifacts({
      dataDir: fixture.dataDir,
      uploadId
    });

    expect(artifacts.userId).toBe(userId);
    expect(artifacts.segments).toEqual(fixture.segments);
    expect(artifacts.semanticSegments).toEqual(fixture.semantics);
    expect(artifacts.chunks.map((chunk) => chunk.id)).toEqual(fixture.chunks.map((chunk) => chunk.id));
    expect(artifacts.checkpoints).toHaveLength(1);
    expect(artifacts.baselineItems).toEqual([fixture.item]);
  });

  it("replays retained outputs through the real deterministic merge without mutating source artifacts", async () => {
    const fixture = await retainedTree();
    const before = await digestFiles(fixture.files);
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const result = await runDailyBriefReplay({
      dataDir: fixture.dataDir,
      uploadId,
      reportPath: fixture.reportPath,
      now: () => timestamp
    });

    expect(result.report.execution).toMatchObject({
      kind: "offline_retained_checkpoint_fixture",
      providerLatencyMeasured: false,
      latencyInterpretation: "fixture_harness_only_not_provider_latency"
    });
    expect(result.report.historical).toMatchObject({
      providerLatencyMeasured: false,
      checkpointEnvelopeWallMs: 1250,
      providerSuccessChunks: 1,
      fallbackChunks: 0
    });
    expect(result.report.network).toEqual({
      remoteAllowed: false,
      blockedAttempts: 0,
      remoteCalls: 0,
      observationScope: "global_fetch_only",
      executionIsolation: "dedicated_cli_process_required"
    });
    expect(result.report.integrity).toEqual({ sourceArtifactsUnchanged: true, changedPaths: [] });
    expect(result.report.evidence.historicalCheckpointOutputs).toMatchObject({
      invalidSourceIds: 0,
      duplicateEvidenceRefs: 0,
      sourceRangeMismatches: 0
    });
    expect(result.report.evidence.replayOutput).toMatchObject({
      invalidSourceIds: 0,
      duplicateEvidenceRefs: 0,
      sourceRangeMismatches: 0
    });
    expect(result.report.offlineBenchmark).toMatchObject({
      mockWallClockInterpretation: "fixed_10ms_per_provider_attempt_scheduler_harness",
      outputDigestStable: true,
      evidenceBackfill: {
        normalized: {
          invalidSourceIds: 0,
          duplicateEvidenceRefs: 0,
          sourceRangeMismatches: 0,
          quoteMismatches: 0
        }
      }
    });
    expect(result.report.replay.itemAudits).toHaveLength(1);
    expect(result.report.replay.outputDigestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.items).toHaveLength(1);
    expect(await digestFiles(fixture.files)).toEqual(before);

    const serializedReport = await readFile(fixture.reportPath, "utf8");
    expect(serializedReport).not.toContain(fixture.segments[0].text);
    expect(serializedReport).not.toContain(fixture.item.transcriptExcerpt);
  });

  it("blocks network access by default even for an injected provider", async () => {
    const fixture = await retainedTree();
    const hostFetch = vi.fn(async () => new Response("unexpected external response"));
    globalThis.fetch = hostFetch as typeof fetch;
    let networkWasBlocked = false;
    const provider: ExtractionProvider = {
      async extract() {
        try {
          await fetch("https://daily-brief-replay.invalid/provider");
        } catch {
          networkWasBlocked = true;
        }
        return [fixture.item];
      }
    };

    const result = await runDailyBriefReplay({
      dataDir: fixture.dataDir,
      uploadId,
      reportPath: fixture.reportPath,
      provider,
      remote: false,
      now: () => timestamp
    });

    expect(networkWasBlocked).toBe(true);
    expect(hostFetch).not.toHaveBeenCalled();
    expect(result.report.execution.kind).toBe("offline_injected_provider");
    expect(result.report.execution.providerLatencyMeasured).toBe(false);
    expect(result.report.network).toEqual({
      remoteAllowed: false,
      blockedAttempts: 1,
      remoteCalls: 0,
      observationScope: "global_fetch_only",
      executionIsolation: "dedicated_cli_process_required"
    });
  });

  it("requires complete, unique checkpoints with valid evidence", async () => {
    const missing = await retainedTree();
    await rm(missing.files.checkpoint);
    await expect(loadDailyBriefReplayArtifacts({ dataDir: missing.dataDir, uploadId })).rejects.toThrow(
      /coverage.*found 0/u
    );

    const duplicate = await retainedTree();
    await writeJson(
      join(duplicate.userRoot, "analysis-chunks", "duplicate_daily_brief_checkpoint.json"),
      { ...duplicate.checkpoint, id: "duplicate_daily_brief_checkpoint" }
    );
    await expect(loadDailyBriefReplayArtifacts({ dataDir: duplicate.dataDir, uploadId })).rejects.toThrow(
      /unique.*found 2/u
    );

    const invalidEvidence = await retainedTree();
    await writeJson(invalidEvidence.files.checkpoint, {
      ...invalidEvidence.checkpoint,
      output: [{ ...invalidEvidence.item, sourceSegmentIds: ["unknown_segment"] }]
    });
    await expect(
      loadDailyBriefReplayArtifacts({ dataDir: invalidEvidence.dataDir, uploadId })
    ).rejects.toThrow(/invalid evidence refs/u);
  });

  it("requires an explicit runtime remote gate and provider", async () => {
    const fixture = await retainedTree();
    const provider: ExtractionProvider = { async extract() { return [fixture.item]; } };

    await expect(runDailyBriefReplay({
      dataDir: fixture.dataDir,
      uploadId,
      reportPath: fixture.reportPath,
      provider,
      remote: true
    })).rejects.toThrow(/RUN_DAILY_BRIEF_REMOTE_VERIFY=1/u);

    process.env.RUN_DAILY_BRIEF_REMOTE_VERIFY = "1";
    await expect(runDailyBriefReplay({
      dataDir: fixture.dataDir,
      uploadId,
      reportPath: fixture.reportPath,
      remote: true
    })).rejects.toThrow(/explicit provider/u);
  });

  it("rejects reports inside source data and refuses to overwrite reports", async () => {
    const fixture = await retainedTree();
    expect(() => assertDailyBriefReplayReportPath({
      dataDir: fixture.dataDir,
      reportPath: join(fixture.dataDir, "evaluation", "report.json")
    })).toThrow(/outside/u);

    await writeJson(fixture.reportPath, { existing: true });
    await expect(runDailyBriefReplay({
      dataDir: fixture.dataDir,
      uploadId,
      reportPath: fixture.reportPath
    })).rejects.toThrow(/already exists/u);
    expect(JSON.parse(await readFile(fixture.reportPath, "utf8"))).toEqual({ existing: true });
  });
});
