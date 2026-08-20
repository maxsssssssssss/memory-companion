import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateDailyReflectionInput } from "@/lib/domain/daily-reflection";
import type { TranscriptSegment } from "@/lib/domain/types";
import { JsonStore } from "@/lib/server/storage/json-store";

import { cleanupDailyReflectionCompletedAudio } from "./cleanup";
import { openDailyReflectionDatabase } from "./db";
import { readDailyReflectionJob } from "./job-store";
import {
  processDailyReflectionUpload,
  type ProcessDailyReflectionUploadDependencies
} from "./process-upload";
import { DailyReflectionRepository } from "./repository";

const timestamp = "2026-08-13T02:00:00.000Z";
const forbiddenCollections = [
  "audio-insights",
  "semantic-segments",
  "brief-items",
  "relationship-signals",
  "relationship-lifecycle",
  "memory-owner-audits",
  "memory-owner-review-candidates",
  "proactive-insights",
  "speaker-identities",
  "voiceprint-training-candidates",
  "answers-by-upload"
] as const;

let root: string;
let uploadsRootDir: string;
let store: JsonStore;
let database: Database.Database;
let repository: DailyReflectionRepository;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "daily-reflection-pipeline-"));
  uploadsRootDir = join(root, "uploads");
  await mkdir(uploadsRootDir, { recursive: true });
  store = new JsonStore(join(root, "store"));
  database = openDailyReflectionDatabase({
    filePath: join(root, "daily-reflection.sqlite")
  });
  repository = new DailyReflectionRepository(database, {
    now: () => timestamp,
    idFactory: () => "generated_candidate"
  });
});

afterEach(async () => {
  database.close();
  await rm(root, { recursive: true, force: true });
});

function createInput(
  overrides: Partial<CreateDailyReflectionInput> = {}
): CreateDailyReflectionInput {
  return {
    id: "reflection_pipeline",
    accountId: "account_pipeline",
    uploadId: "upload_pipeline",
    inputMethod: "file_upload",
    sourceOrigin: "user_reflection",
    processingProfile: "full_recording",
    ingestionContext: "daily_reflection",
    idempotencyKey: "pipeline_key",
    ...overrides
  };
}

function segments(count = 5): TranscriptSegment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `segment_${index + 1}`,
    uploadId: "upload_pipeline",
    startSeconds: index * 45,
    endSeconds: index === count - 1 ? 210 : index * 45 + 30,
    speaker: `speaker_${index + 1}`,
    identity: {
      globalSpeakerId: `person_${index + 1}`,
      identityType: "known_contact" as const,
      confidence: 1,
      source: "manual_mapping" as const
    },
    text: `Reflection candidate ${index + 1}`,
    confidence: 0.95,
    sceneLabels: [],
    valueLabels: []
  }));
}

async function prepareWorkflow(
  overrides: Partial<CreateDailyReflectionInput> = {}
) {
  const created = repository.createReflection(createInput(overrides));
  const filePath = join(uploadsRootDir, "upload_pipeline.wav");
  await writeFile(filePath, "audio");
  await store.write("uploads", "upload_pipeline", {
    id: "upload_pipeline",
    originalName: "reflection.wav",
    mimeType: "audio/wav",
    sizeBytes: 5,
    recordingDate: "2026-08-13",
    createdAt: timestamp,
    status: "uploaded",
    filePath,
    ingestionContext: "daily_reflection",
    reflectionId: created.reflection.id
  });
  return { created, filePath };
}

async function prepareQuickBrowserWorkflow() {
  const created = repository.createReflection(createInput({
    uploadId: null,
    inputMethod: "browser_recording",
    sourceOrigin: "user_reflection",
    idempotencyKey: "pipeline_browser_quick"
  }));
  const fence = repository.claimExecutionLease({
    accountId: created.reflection.accountId,
    reflectionId: created.reflection.id,
    leaseOwner: "pipeline_browser_probe",
    leaseDurationMs: 60_000,
    allowedStatuses: ["created"]
  });
  repository.bindUploadAndPlan({
    accountId: created.reflection.accountId,
    reflectionId: created.reflection.id,
    expectedVersion: created.reflection.version,
    uploadId: "upload_pipeline",
    processingProfile: "quick_reflection",
    leaseOwner: fence!.leaseOwner,
    attemptVersion: fence!.attemptVersion
  });
  repository.releaseExecutionLease({
    accountId: created.reflection.accountId,
    reflectionId: created.reflection.id,
    leaseOwner: fence!.leaseOwner,
    attemptVersion: fence!.attemptVersion
  });
  const filePath = join(uploadsRootDir, "upload_pipeline.wav");
  await writeFile(filePath, "audio");
  await store.write("uploads", "upload_pipeline", {
    id: "upload_pipeline",
    originalName: "browser-reflection.wav",
    mimeType: "audio/wav",
    sizeBytes: 5,
    recordingDate: "2026-08-13",
    createdAt: timestamp,
    status: "uploaded",
    filePath,
    ingestionContext: "daily_reflection",
    reflectionId: created.reflection.id,
    durationSeconds: 180,
    effectiveDurationMs: 180_000,
    durationSource: "server_ffprobe"
  });
}

function run(
  transcribeAudio: ProcessDailyReflectionUploadDependencies["transcribeAudio"],
  overrides: Partial<ProcessDailyReflectionUploadDependencies> = {}
) {
  return processDailyReflectionUpload({
    accountId: "account_pipeline",
    reflectionId: "reflection_pipeline",
    store,
    uploadsRootDir,
    executionMode: "inline"
  }, {
    repository,
    transcribeAudio,
    now: () => timestamp,
    ...overrides
  });
}

describe("processDailyReflectionUpload", () => {
  it("removes completed raw audio and checkpoints while retaining review evidence", async () => {
    const { filePath } = await prepareWorkflow();
    const attemptPath = join(uploadsRootDir, "upload_pipeline.attempt-9.wav");
    const unrelatedPath = join(uploadsRootDir, "unrelated.wav");
    const chunkDirectory = join(uploadsRootDir, "upload_pipeline-chunks");
    const chunkPath = join(chunkDirectory, "chunk_00000.mp3");
    await mkdir(chunkDirectory, { recursive: true });
    await Promise.all([
      writeFile(attemptPath, "attempt audio"),
      writeFile(unrelatedPath, "unrelated audio"),
      writeFile(chunkPath, "generated audio"),
      store.write("audio-chunks", "upload_pipeline_audio_chunk_00000", {
        id: "upload_pipeline_audio_chunk_00000",
        uploadId: "upload_pipeline",
        index: 0,
        startSeconds: 0,
        endSeconds: 30,
        durationSeconds: 30,
        source: { type: "generated_chunk", path: chunkPath },
        status: "completed",
        retryCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: {}
      }),
      store.write("transcript-chunks", "upload_pipeline_transcript_chunk_00000", {
        id: "upload_pipeline_transcript_chunk_00000",
        uploadId: "upload_pipeline",
        audioChunkId: "upload_pipeline_audio_chunk_00000",
        index: 0,
        startSeconds: 0,
        endSeconds: 30,
        timebase: "upload_global",
        speakerIdScope: "upload",
        speakerMap: {},
        segments: [],
        status: "completed",
        retryCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: {}
      }),
      store.write(
        "daily-reflection-asset-attempts",
        "reflection_pipeline-upload-attempt-9",
        {
          accountId: "account_pipeline",
          reflectionId: "reflection_pipeline",
          uploadId: "upload_pipeline"
        }
      ),
      store.write(
        "daily-reflection-asset-attempts",
        "reflection_pipeline-other-upload-attempt-9",
        {
          accountId: "account_pipeline",
          reflectionId: "reflection_pipeline-other",
          uploadId: "upload_pipeline_other"
        }
      ),
      store.write(
        "daily-reflection-asset-attempts",
        "reflection_pipeline-upload-attempt-99",
        {
          accountId: "another_account",
          reflectionId: "reflection_pipeline",
          uploadId: "upload_pipeline"
        }
      )
    ]);

    const completed = await run(vi.fn(async () => segments(1)));

    expect(completed).toMatchObject({
      outcome: "completed",
      status: "review_pending",
      candidateCount: 1
    });
    await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(attemptPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(chunkDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(unrelatedPath)).resolves.toBeUndefined();
    await expect(store.listIds("audio-chunks")).resolves.toEqual([]);
    await expect(store.listIds("transcript-chunks")).resolves.toEqual([]);
    await expect(store.listIds("daily-reflection-asset-attempts"))
      .resolves.toEqual([
        "reflection_pipeline-other-upload-attempt-9",
        "reflection_pipeline-upload-attempt-99"
      ]);
    await expect(store.read("uploads", "upload_pipeline")).resolves.toMatchObject({
      id: "upload_pipeline",
      reflectionId: "reflection_pipeline",
      ingestionContext: "daily_reflection"
    });
    await expect(store.read<TranscriptSegment[]>("segments", "upload_pipeline"))
      .resolves.toHaveLength(1);
    expect(repository.readPublishedAsset({
      accountId: "account_pipeline",
      reflectionId: "reflection_pipeline",
      assetKind: "upload"
    })).toMatchObject({ id: "upload_pipeline" });
    expect(repository.readPublishedAsset<TranscriptSegment[]>({
      accountId: "account_pipeline",
      reflectionId: "reflection_pipeline",
      assetKind: "segments"
    })).toHaveLength(1);
    expect(repository.listCandidates("account_pipeline", "reflection_pipeline"))
      .toHaveLength(1);
    await expect(readDailyReflectionJob(store, "reflection_pipeline"))
      .resolves.toMatchObject({ status: "completed", progress: 100 });

    await expect(run(vi.fn(async () => segments(1)))).resolves.toMatchObject({
      outcome: "reused",
      status: "review_pending"
    });
  });

  it("leaves the job incomplete on cleanup failure and retries cleanup on redelivery", async () => {
    const { filePath } = await prepareWorkflow();
    const transcribeAudio = vi.fn(async () => segments(1));
    let cleanupAttempt = 0;
    const cleanupCompletedAudio = vi.fn(async (
      input: Parameters<typeof cleanupDailyReflectionCompletedAudio>[0]
    ) => {
      cleanupAttempt += 1;
      const job = await readDailyReflectionJob(store, "reflection_pipeline");
      expect(job).toMatchObject({ status: "processing", progress: 80 });
      if (cleanupAttempt === 1) {
        throw new Error("simulated completed audio cleanup failure");
      }
      await cleanupDailyReflectionCompletedAudio(input);
    });

    await expect(run(transcribeAudio, { cleanupCompletedAudio }))
      .rejects.toThrow("Daily Reflection review finalization failed");
    expect(repository.getReflection("account_pipeline", "reflection_pipeline").status)
      .toBe("review_pending");
    await expect(readDailyReflectionJob(store, "reflection_pipeline"))
      .resolves.toMatchObject({ status: "processing", progress: 80 });
    await expect(access(filePath)).resolves.toBeUndefined();

    await expect(run(transcribeAudio, { cleanupCompletedAudio })).resolves.toMatchObject({
      outcome: "reused",
      status: "review_pending",
      candidateCount: 1
    });
    expect(cleanupCompletedAudio).toHaveBeenCalledTimes(2);
    expect(transcribeAudio).toHaveBeenCalledOnce();
    await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readDailyReflectionJob(store, "reflection_pipeline"))
      .resolves.toMatchObject({ status: "completed", progress: 100 });
  });

  it("stages a 181+ second full recording with five pending candidates and no forbidden writes", async () => {
    await prepareWorkflow();
    const writeSpy = vi.spyOn(store, "write");
    const transcribeAudio = vi.fn(async () => segments());

    const completed = await run(transcribeAudio);

    expect(completed).toEqual({
      outcome: "completed",
      reflectionId: "reflection_pipeline",
      uploadId: "upload_pipeline",
      status: "review_pending",
      candidateCount: 5
    });
    expect(transcribeAudio).toHaveBeenCalledOnce();
    expect(transcribeAudio).toHaveBeenCalledWith(expect.objectContaining({
      uploadId: "upload_pipeline",
      identityPolicy: "skip"
    }));
    const detail = repository.getReflectionDetail(
      "account_pipeline",
      "reflection_pipeline"
    );
    expect(detail.reflection.status).toBe("review_pending");
    expect(detail.processingPlan).toMatchObject({
      sourceOrigin: "user_reflection",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection"
    });
    expect(detail.candidates).toHaveLength(5);
    expect(detail.candidates.every((candidate) =>
      candidate.status === "pending"
      && candidate.subjectPersonId === null
      && candidate.subjectConfirmed === false
    )).toBe(true);
    const canonical = await store.read<TranscriptSegment[]>("segments", "upload_pipeline");
    expect(canonical).toHaveLength(5);
    expect(canonical?.at(-1)?.endSeconds).toBe(210);
    expect(canonical?.every((segment) => segment.identity === undefined)).toBe(true);
    expect(await store.read("uploads", "upload_pipeline")).toMatchObject({
      status: "extracting",
      ingestionContext: "daily_reflection"
    });
    expect(await readDailyReflectionJob(store, "reflection_pipeline"))
      .toMatchObject({ status: "completed", progress: 100 });
    expect(await store.read("jobs-by-upload", "upload_pipeline")).toBeNull();
    for (const collection of forbiddenCollections) {
      expect(await store.listIds(collection), collection).toEqual([]);
    }
    expect(writeSpy.mock.calls.map(([collection]) => collection)).not.toEqual(
      expect.arrayContaining([...forbiddenCollections])
    );

    const repeated = await run(transcribeAudio);
    expect(repeated.outcome).toBe("reused");
    expect(repeated.candidateCount).toBe(5);
    expect(transcribeAudio).toHaveBeenCalledOnce();
    expect(database.prepare("SELECT COUNT(*) AS count FROM dr_candidates").get())
      .toEqual({ count: 5 });
  });

  it("uses the frozen quick browser plan and persists at most three candidates", async () => {
    await prepareQuickBrowserWorkflow();
    const transcribeAudio = vi.fn(async () => segments());

    const completed = await run(transcribeAudio);

    expect(completed).toMatchObject({
      outcome: "completed",
      status: "review_pending",
      candidateCount: 3
    });
    const detail = repository.getReflectionDetail(
      "account_pipeline",
      "reflection_pipeline"
    );
    expect(detail.processingPlan).toMatchObject({
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection",
      processingProfile: "quick_reflection"
    });
    expect(detail.candidates).toHaveLength(3);
    expect(detail.candidates.map((candidate) => candidate.sourceSegmentIds))
      .toEqual(segments().slice(0, 3).map((item) => [item.id]));
  });

  it.each([
    { name: "empty transcript", transcript: [] as TranscriptSegment[], code: "daily_reflection_transcript_segments_missing" },
    { name: "candidate builder failure", transcript: [{ ...segments(1)[0], text: "   " }], code: "daily_reflection_candidate_build_failed" }
  ])("fails safely for $name without writing candidates", async ({ transcript, code }) => {
    await prepareWorkflow();
    const result = await run(vi.fn(async () => transcript));

    expect(result.outcome).toBe("failed");
    expect(repository.getReflection("account_pipeline", "reflection_pipeline"))
      .toMatchObject({ status: "failed", errorCode: code });
    expect(repository.listCandidates("account_pipeline", "reflection_pipeline"))
      .toEqual([]);
    expect(repository.readPublishedAsset({
      accountId: "account_pipeline",
      reflectionId: "reflection_pipeline",
      assetKind: "upload"
    })).toMatchObject({ status: "failed", errorCode: code });
    expect(await store.read("uploads", "upload_pipeline"))
      .toMatchObject({ status: "failed", errorCode: code });
    expect(await readDailyReflectionJob(store, "reflection_pipeline"))
      .toMatchObject({ status: "failed" });
  });

  it("stores a finite generic error and retries explicitly after ASR failure", async () => {
    await prepareWorkflow();
    const failed = await run(vi.fn(async () => {
      throw new Error("token=SECRET provider exploded");
    }));
    expect(failed.outcome).toBe("failed");
    const failure = repository.getReflection("account_pipeline", "reflection_pipeline");
    expect(failure).toMatchObject({
      status: "failed",
      errorCode: "daily_reflection_processing_failed",
      errorMessage: "Daily Reflection staging failed"
    });
    expect(JSON.stringify(failure)).not.toContain("SECRET");
    const failedUpload = repository.readPublishedAsset({
      accountId: "account_pipeline",
      reflectionId: "reflection_pipeline",
      assetKind: "upload"
    });
    expect(failedUpload).toMatchObject({
      status: "failed",
      errorCode: "daily_reflection_processing_failed",
      errorMessage: "Daily Reflection staging failed"
    });
    expect(JSON.stringify(failedUpload)).not.toContain("SECRET");
    expect(await readDailyReflectionJob(store, "reflection_pipeline"))
      .toMatchObject({ status: "failed" });

    repository.retryFailed({
      accountId: "account_pipeline",
      reflectionId: "reflection_pipeline",
      expectedVersion: failure.version,
      resumeStatus: "transcribing"
    });
    const recovered = await run(vi.fn(async () => segments(1)));
    expect(recovered).toMatchObject({
      outcome: "completed",
      status: "review_pending",
      candidateCount: 1
    });
  });

  it("lets cancellation win an in-flight ASR race and removes all draft assets", async () => {
    const { filePath } = await prepareWorkflow();
    let release!: (value: TranscriptSegment[]) => void;
    const pendingTranscript = new Promise<TranscriptSegment[]>((resolve) => {
      release = resolve;
    });
    const transcribeAudio = vi.fn(() => pendingTranscript);
    const processing = run(transcribeAudio);
    await vi.waitFor(() => expect(transcribeAudio).toHaveBeenCalledOnce());

    const transcribing = repository.getReflection(
      "account_pipeline",
      "reflection_pipeline"
    );
    expect(transcribing.status).toBe("transcribing");
    repository.transitionStatus({
      accountId: "account_pipeline",
      reflectionId: "reflection_pipeline",
      expectedVersion: transcribing.version,
      status: "cancelled"
    });
    release(segments(1));

    await expect(processing).resolves.toMatchObject({
      outcome: "tombstoned",
      status: "cancelled"
    });
    expect(await store.read("segments", "upload_pipeline")).toBeNull();
    expect(await store.read("uploads", "upload_pipeline")).toBeNull();
    expect(await readDailyReflectionJob(store, "reflection_pipeline")).toBeNull();
    expect(repository.listCandidates("account_pipeline", "reflection_pipeline"))
      .toEqual([]);
    await expect(access(filePath)).rejects.toThrow();
    expect(await store.read("deleted-uploads", "upload_pipeline"))
      .toMatchObject({ ingestionContext: "daily_reflection" });
  });

  it("uses the persisted lease across two workers so only one executes ASR", async () => {
    await prepareWorkflow();
    const databaseB = openDailyReflectionDatabase({
      filePath: join(root, "daily-reflection.sqlite")
    });
    const repositoryB = new DailyReflectionRepository(databaseB, {
      now: () => timestamp
    });
    let release!: (value: TranscriptSegment[]) => void;
    const pendingTranscript = new Promise<TranscriptSegment[]>((resolve) => {
      release = resolve;
    });
    const firstAsr = vi.fn(() => pendingTranscript);
    const secondAsr = vi.fn(async () => segments(1));
    try {
      const firstWorker = run(firstAsr);
      await vi.waitFor(() => expect(firstAsr).toHaveBeenCalledOnce());
      const secondWorker = await run(secondAsr, { repository: repositoryB });

      expect(secondWorker).toMatchObject({
        outcome: "busy",
        status: "transcribing"
      });
      expect(secondAsr).not.toHaveBeenCalled();
      release(segments(1));
      await expect(firstWorker).resolves.toMatchObject({
        outcome: "completed",
        status: "review_pending"
      });
      expect(firstAsr).toHaveBeenCalledOnce();
    } finally {
      databaseB.close();
    }
  });

  it("prevents a stale ASR writer from overwriting an expired-lease takeover", async () => {
    await prepareWorkflow();
    const databaseB = openDailyReflectionDatabase({
      filePath: join(root, "daily-reflection.sqlite")
    });
    const repositoryB = new DailyReflectionRepository(databaseB, {
      now: () => "2026-08-13T02:16:00.000Z"
    });
    let releaseStale!: (value: TranscriptSegment[]) => void;
    const staleTranscript = new Promise<TranscriptSegment[]>((resolve) => {
      releaseStale = resolve;
    });
    const staleAsr = vi.fn(() => staleTranscript);
    const winningSegments = [{
      ...segments(1)[0],
      id: "segment_winner",
      text: "WINNER canonical reflection"
    }];
    try {
      const staleWorker = run(staleAsr);
      await vi.waitFor(() => expect(staleAsr).toHaveBeenCalledOnce());
      const winningWorker = await run(vi.fn(async () => winningSegments), {
        repository: repositoryB,
        now: () => "2026-08-13T02:16:00.000Z"
      });
      expect(winningWorker).toMatchObject({
        outcome: "completed",
        status: "review_pending"
      });

      releaseStale([{
        ...segments(1)[0],
        id: "segment_stale",
        text: "STALE canonical reflection"
      }]);
      await expect(staleWorker).resolves.toMatchObject({
        outcome: "reused",
        status: "review_pending"
      });
      await expect(store.read<TranscriptSegment[]>("segments", "upload_pipeline"))
        .resolves.toEqual([expect.objectContaining({
          id: "segment_winner",
          text: "WINNER canonical reflection"
        })]);
      expect(repositoryB.listCandidates("account_pipeline", "reflection_pipeline"))
        .toEqual([expect.objectContaining({
          proposedText: "WINNER canonical reflection"
        })]);
    } finally {
      databaseB.close();
    }
  });

  it("fences the deterministic stage-to-publish gap before canonical segment write", async () => {
    await prepareWorkflow();
    const databaseB = openDailyReflectionDatabase({
      filePath: join(root, "daily-reflection.sqlite")
    });
    const repositoryB = new DailyReflectionRepository(databaseB, {
      now: () => "2026-08-13T02:16:00.000Z"
    });
    let releasePublish!: () => void;
    const publishBarrier = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const beforePublishAsset = vi.fn(async (assetKind: "upload" | "segments") => {
      if (assetKind !== "segments") return;
      await publishBarrier;
    });
    const staleSegments = [{
      ...segments(1)[0],
      id: "segment_publish_gap_stale",
      text: "STALE publish-gap transcript"
    }];
    const winnerSegments = [{
      ...segments(1)[0],
      id: "segment_publish_gap_winner",
      text: "WINNER publish-gap transcript"
    }];
    try {
      const staleWorker = run(vi.fn(async () => staleSegments), {
        beforePublishAsset
      });
      await vi.waitFor(() => expect(beforePublishAsset).toHaveBeenCalledWith(
        "segments",
        1
      ));

      const winner = await run(vi.fn(async () => winnerSegments), {
        repository: repositoryB,
        now: () => "2026-08-13T02:16:00.000Z"
      });
      expect(winner).toMatchObject({
        outcome: "completed",
        status: "review_pending"
      });
      releasePublish();
      await expect(staleWorker).resolves.toMatchObject({
        outcome: "reused",
        status: "review_pending"
      });

      expect(repositoryB.readPublishedAsset<TranscriptSegment[]>({
        accountId: "account_pipeline",
        reflectionId: "reflection_pipeline",
        assetKind: "segments"
      })).toEqual([expect.objectContaining({
        id: "segment_publish_gap_winner",
        text: "WINNER publish-gap transcript"
      })]);
      await expect(store.read<TranscriptSegment[]>("segments", "upload_pipeline"))
        .resolves.toEqual([expect.objectContaining({
          id: "segment_publish_gap_winner"
        })]);
      await expect(store.listIds("daily-reflection-asset-attempts"))
        .resolves.toEqual([]);
    } finally {
      databaseB.close();
    }
  });
});
