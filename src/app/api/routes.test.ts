import { mkdtemp as nodeMkdtemp, rm as nodeRm, utimes, writeFile as nodeWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testDataRootDir = join(tmpdir(), "daily-brief-test", "user_default");
const testUploadsRootDir = join(testDataRootDir, "uploads");
const testProviderConfigPath = join(testDataRootDir, "settings", "provider-config.json");

const storeMock = vi.hoisted(() => ({
  list: vi.fn(),
  listIds: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  delete: vi.fn()
}));

const mkdirMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn());
const rmMock = vi.hoisted(() => vi.fn());
const statMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());
const processUploadMock = vi.hoisted(() => vi.fn());
const deleteProviderRawResponseCapturesMock = vi.hoisted(() => vi.fn());
const retrieveQaEvidenceMock = vi.hoisted(() => vi.fn());
const observeMemoryShadowRetrievalMock = vi.hoisted(() => vi.fn());
const retrieveMemoryIndexEvidenceMock = vi.hoisted(() => vi.fn());
const memoryRepositoryMock = vi.hoisted(() => ({
  deleteByUpload: vi.fn(),
  getRelevantMemories: vi.fn(),
  replaceUploadMemories: vi.fn()
}));
const dateCompanionRepositoryMock = vi.hoisted(() => ({
  getInteractionVersionByUpload: vi.fn(),
  markUploadSourceState: vi.fn(),
  prepareInteractionDeletion: vi.fn(),
  deleteInteractionByUpload: vi.fn()
}));
const answerQuestionWithAIMock = vi.hoisted(() => vi.fn());
const normalizeQaConversationMock = vi.hoisted(() => vi.fn());
const afterMock = vi.hoisted(() => vi.fn());
const enqueuePipelineJobMock = vi.hoisted(() => vi.fn());
const enqueueEmbeddingIndexJobMock = vi.hoisted(() => vi.fn());
const prepareHybridIndexRetentionMock = vi.hoisted(() => vi.fn());
const requiresHybridPermanentIndexDeletionMock = vi.hoisted(() => vi.fn());
const requestHybridPermanentIndexDeletionMock = vi.hoisted(() => vi.fn());
const deleteHybridIndexDeletionMock = vi.hoisted(() => vi.fn());
const readHybridIndexDeletionMock = vi.hoisted(() => vi.fn());
const readHybridIndexRetentionManifestMock = vi.hoisted(() => vi.fn());
const originalEvaluationMode = process.env.EVALUATION_MODE;
const originalPipelineExecutionMode = process.env.PIPELINE_EXECUTION_MODE;
const originalHybridRetrievalMode = process.env.QA_HYBRID_RETRIEVAL_MODE;
const originalHybridRetentionPolicy = process.env.HYBRID_INDEX_RETENTION_POLICY;
const authContextMock = vi.hoisted(() => ({
  isUnauthenticatedError: vi.fn((error: unknown) => error instanceof Error && error.message === "unauthenticated"),
  requireAuthContext: vi.fn(),
  unauthorizedResponse: vi.fn(() => Response.json({ error: "unauthenticated" }, { status: 401 }))
}));

vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("crypto")>();
  return {
    ...actual,
    randomUUID: vi.fn(() => "upload_test")
  };
});

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    mkdir: mkdirMock,
    writeFile: writeFileMock,
    rm: rmMock,
    stat: statMock
  };
});

vi.mock("child_process", () => ({
  default: {
    execFile: execFileMock
  },
  execFile: execFileMock
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: afterMock
  };
});

vi.mock("@/lib/server/storage/json-store", () => ({
  appStore: storeMock
}));

vi.mock("@/lib/server/auth/request-context", () => authContextMock);

vi.mock("@/lib/server/pipeline/process-upload", () => ({
  isUploadProcessingCancelled: vi.fn(() => false),
  processUpload: processUploadMock
}));

vi.mock("@/lib/server/evaluation/provider-response-capture", () => ({
  deleteProviderRawResponseCaptures: deleteProviderRawResponseCapturesMock
}));

vi.mock("@/lib/server/queue/producer", () => ({
  enqueuePipelineJob: enqueuePipelineJobMock,
  enqueueEmbeddingIndexJob: enqueueEmbeddingIndexJobMock
}));

vi.mock("@/lib/server/retrieval/hybrid/retention-runtime", () => ({
  prepareHybridIndexRetention: prepareHybridIndexRetentionMock,
  requiresHybridPermanentIndexDeletion:
    requiresHybridPermanentIndexDeletionMock,
  requestHybridPermanentIndexDeletion:
    requestHybridPermanentIndexDeletionMock
}));

vi.mock("@/lib/server/retrieval/hybrid/retention-manifest", () => ({
  deleteHybridIndexDeletion: deleteHybridIndexDeletionMock,
  readHybridIndexDeletion: readHybridIndexDeletionMock,
  readHybridIndexRetentionManifest: readHybridIndexRetentionManifestMock
}));

vi.mock("@/lib/server/memory", () => ({
  getMemoryRepository: vi.fn(() => memoryRepositoryMock)
}));

vi.mock("@/lib/server/date-companion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/date-companion")>();
  return {
    ...actual,
    getDateCompanionRepository: vi.fn(() => dateCompanionRepositoryMock)
  };
});

vi.mock("@/lib/server/retrieval/qa", () => ({
  answerSameDayQuestion: vi.fn()
}));

vi.mock("@/lib/server/retrieval/ai-qa", () => ({
  answerQuestionWithAI: answerQuestionWithAIMock,
  normalizeQaConversation: normalizeQaConversationMock,
  retrieveQaEvidence: retrieveQaEvidenceMock
}));

vi.mock("@/lib/server/memory/shadow-retrieval", () => ({
  dateRangeFromScopeId: vi.fn((scopeId: string) =>
    scopeId === "week_2026-06-08_2026-06-14"
      ? { startDate: "2026-06-08", endDate: "2026-06-14" }
      : undefined
  ),
  observeMemoryShadowRetrieval: observeMemoryShadowRetrievalMock
}));

vi.mock("@/lib/server/retrieval/memory-index-evidence", () => ({
  retrieveMemoryIndexEvidence: retrieveMemoryIndexEvidenceMock
}));

import { DcConflictError } from "@/lib/server/date-companion";
import { GET as getDay } from "./days/[uploadId]/route";
import { GET as getAudioInsightCorrections, PUT as putAudioInsightCorrections } from "./days/[uploadId]/audio-insight-corrections/route";
import { GET as getSpeakerAliases, PUT as putSpeakerAliases } from "./days/[uploadId]/speaker-aliases/route";
import { GET as getQaHistory, POST as postQa } from "./days/[uploadId]/qa/route";
import { POST as postContextQa } from "./days/context/qa/route";
import { GET as getJob } from "./jobs/[jobId]/route";
import { GET as getAllQaHistory, POST as postAllQa } from "./memory/all/qa/route";
import { GET as getWeekQaHistory, POST as postWeekQa } from "./memory/week/qa/route";
import { POST as postOpenDataFolder } from "./settings/open-data-folder/route";
import { GET as getSettings, POST as postSettings } from "./settings/route";
import { DELETE as deleteUpload } from "./uploads/[uploadId]/route";
import { GET as getUploadByDate } from "./uploads/by-date/route";
import { GET as getUploadDates } from "./uploads/dates/route";
import { GET as getLatestUpload } from "./uploads/latest/route";
import { POST as postUpload } from "./uploads/route";
import { buildPipelineJobId } from "@/lib/server/queue/types";

function relationshipSignalFixture(input: {
  uploadId: string;
  segmentId: string;
  date: string;
  startSeconds?: number;
  endSeconds?: number;
}) {
  const startSeconds = input.startSeconds ?? 10;
  const endSeconds = input.endSeconds ?? 20;

  return {
    id: `relationship_signal_${input.uploadId}_1`,
    uploadId: input.uploadId,
    date: input.date,
    signalType: "active_listening",
    signalCategory: "positive",
    severity: "low",
    confidence: 0.78,
    summary: "回应中出现了确认对方表达的线索。",
    explanation: "这只描述当前片段中的互动，不代表长期关系结论。",
    involvedSpeakers: ["speaker_1", "speaker_2"],
    timeRange: { startSeconds, endSeconds },
    evidenceSegments: [
      {
        segmentId: input.segmentId,
        speaker: "speaker_2",
        startSeconds,
        endSeconds,
        text: "我听到了，我们可以再确认。"
      }
    ],
    textEvidence: ["我听到了，我们可以再确认。"],
    suggestedReflection: "可以继续观察这种回应是否稳定出现。",
    createdAt: `${input.date}T10:00:00.000Z`
  };
}

describe("API routes", () => {
  beforeEach(() => {
    delete process.env.EVALUATION_MODE;
    delete process.env.PIPELINE_EXECUTION_MODE;
    delete process.env.QA_HYBRID_RETRIEVAL_MODE;
    delete process.env.HYBRID_INDEX_RETENTION_POLICY;
    vi.clearAllMocks();
    storeMock.list.mockResolvedValue([]);
    storeMock.listIds.mockResolvedValue([]);
    processUploadMock.mockResolvedValue(undefined);
    deleteProviderRawResponseCapturesMock.mockResolvedValue(undefined);
    enqueuePipelineJobMock.mockImplementation(async (payload) => ({
      jobId: buildPipelineJobId(payload),
      enqueued: true
    }));
    enqueueEmbeddingIndexJobMock.mockResolvedValue({
      jobId: "hybrid-index-test-0",
      enqueued: true
    });
    prepareHybridIndexRetentionMock.mockResolvedValue({
      status: "prepared",
      matched: 1,
      total: 1
    });
    requiresHybridPermanentIndexDeletionMock.mockResolvedValue(false);
    requestHybridPermanentIndexDeletionMock.mockResolvedValue({
      status: "completed"
    });
    deleteHybridIndexDeletionMock.mockResolvedValue(undefined);
    readHybridIndexDeletionMock.mockResolvedValue(null);
    readHybridIndexRetentionManifestMock.mockResolvedValue(null);
    retrieveQaEvidenceMock.mockReturnValue([
      {
        id: "brief_shadow_1",
        kind: "brief",
        title: "shadow evidence",
        text: "summary",
        sourceSegmentIds: ["segment_shadow_1"]
      }
    ]);
    observeMemoryShadowRetrievalMock.mockReturnValue(null);
    retrieveMemoryIndexEvidenceMock.mockImplementation((input: { scope: "current" | "week" | "all" }) => ({
      scope: input.scope,
      memories: [],
      evidence: [],
      sourceIds: [],
      distinctDates: [],
      count: 0,
      retrievalTimeMs: 1
    }));
    memoryRepositoryMock.deleteByUpload.mockReturnValue(undefined);
    dateCompanionRepositoryMock.getInteractionVersionByUpload.mockReturnValue(null);
    dateCompanionRepositoryMock.markUploadSourceState.mockReturnValue(true);
    dateCompanionRepositoryMock.prepareInteractionDeletion.mockReturnValue({
      interactionId: "interaction_1",
      relationshipId: "relationship_1",
      sourceUploadId: "upload_1",
      version: 3
    });
    dateCompanionRepositoryMock.deleteInteractionByUpload.mockReturnValue(true);
    afterMock.mockImplementation((callback: () => void) => {
      callback();
    });
    authContextMock.requireAuthContext.mockResolvedValue({
      user: { id: "user_default", email: "default@example.com" },
      store: storeMock,
      dataRootDir: testDataRootDir,
      uploadsRootDir: testUploadsRootDir
    });
    answerQuestionWithAIMock.mockResolvedValue({
      id: "answer_1",
      uploadId: "upload_1",
      question: "What did I commit to?",
      answer: "Answer",
      citedSegmentIds: ["segment_1"],
      createdAt: "2026-06-03T00:00:00.000Z"
    });
    normalizeQaConversationMock.mockImplementation((conversation: unknown) => {
      if (!Array.isArray(conversation)) {
        return [];
      }

      return conversation
        .filter(
          (message): message is { role: "user" | "assistant"; content: string } =>
            Boolean(message) &&
            typeof message === "object" &&
            ((message as { role?: unknown }).role === "user" || (message as { role?: unknown }).role === "assistant") &&
            typeof (message as { content?: unknown }).content === "string"
        )
        .map((message) => ({ role: message.role, content: message.content.trim() }))
        .filter((message) => message.content.length > 0)
        .slice(-8);
    });
    execFileMock.mockImplementation((_command: string, _args: string[], callback: (error: Error | null) => void) => {
      callback(null);
    });
    statMock.mockRejectedValue(new Error("missing file"));
  });

  afterEach(() => {
    if (originalEvaluationMode === undefined) {
      delete process.env.EVALUATION_MODE;
    } else {
      process.env.EVALUATION_MODE = originalEvaluationMode;
    }
    if (originalPipelineExecutionMode === undefined) {
      delete process.env.PIPELINE_EXECUTION_MODE;
    } else {
      process.env.PIPELINE_EXECUTION_MODE = originalPipelineExecutionMode;
    }
    if (originalHybridRetrievalMode === undefined) {
      delete process.env.QA_HYBRID_RETRIEVAL_MODE;
    } else {
      process.env.QA_HYBRID_RETRIEVAL_MODE = originalHybridRetrievalMode;
    }
    if (originalHybridRetentionPolicy === undefined) {
      delete process.env.HYBRID_INDEX_RETENTION_POLICY;
    } else {
      process.env.HYBRID_INDEX_RETENTION_POLICY = originalHybridRetentionPolicy;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns 400 when upload file is missing", async () => {
    const request = new Request("http://localhost/api/uploads", {
      method: "POST",
      body: new FormData()
    });

    const response = await postUpload(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "missing_file" });
  });

  it("stores uploaded audio under a stable safe path and starts background processing", async () => {
    const formData = new FormData();
    const file = new File(["audio-data"], "../../../demo.m4a", { type: "audio/mp4" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(new TextEncoder().encode("audio-data").buffer)
    });
    formData.set("recordingDate", "2026-06-03");
    formData.set("file", file);
    const request = {
      formData: vi.fn().mockResolvedValue(formData)
    } as unknown as Request;

    const response = await postUpload(request);
    const [[uploadCollection, uploadId, payload]] = storeMock.write.mock.calls;
    const responseBody = await response.json();

    expect(response.status).toBe(201);
    expect(responseBody).toEqual({ uploadId, jobId: expect.any(String), status: "uploaded" });
    const jobId = responseBody.jobId as string;
    expect(uploadId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(jobId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(uploadCollection).toBe("uploads");
    expect(payload.originalName).toBe("../../../demo.m4a");
    expect(payload.filePath).toBe(join(testUploadsRootDir, `${uploadId}.m4a`));
    expect(payload.filePath.includes("..")).toBe(false);
    expect(payload.dateCompanionAudioSnapshotVersion).toBeUndefined();
    expect(mkdirMock).toHaveBeenCalledWith(testUploadsRootDir, { recursive: true });
    expect(writeFileMock).toHaveBeenCalledOnce();
    expect(storeMock.write).toHaveBeenCalledWith("jobs", jobId, {
      id: jobId,
      uploadId,
      status: "waiting",
      progress: 0,
      updatedAt: expect.any(String),
      executionMode: "inline"
    });
    expect(storeMock.write).toHaveBeenCalledWith("jobs-by-upload", uploadId, {
      id: jobId,
      uploadId,
      status: "waiting",
      progress: 0,
      updatedAt: expect.any(String),
      executionMode: "inline"
    });
    expect(afterMock).toHaveBeenCalledOnce();
    expect(enqueuePipelineJobMock).not.toHaveBeenCalled();
    expect(authContextMock.requireAuthContext).toHaveBeenCalledWith(request);
    expect(processUploadMock).toHaveBeenCalledWith({ uploadId, store: storeMock, userId: "user_default" });
  });

  it("stores only the normalized internal marker for an exact date-companion upload context", async () => {
    const formData = new FormData();
    const file = new File(["audio-data"], "date.m4a", { type: "audio/mp4" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(new TextEncoder().encode("audio-data").buffer)
    });
    formData.set("file", file);
    formData.set("uploadContext", "date-companion");
    formData.set("dateCompanionAudioSnapshotVersion", "999");

    const response = await postUpload({
      formData: vi.fn().mockResolvedValue(formData)
    } as unknown as Request);
    const uploadWrite = storeMock.write.mock.calls.find(([collection]) => collection === "uploads");

    expect(response.status).toBe(201);
    expect(uploadWrite?.[2]).toMatchObject({ dateCompanionAudioSnapshotVersion: 1 });
    expect(uploadWrite?.[2]).not.toHaveProperty("uploadContext");
    expect(uploadWrite?.[2]).not.toHaveProperty("dateCompanionAudioSnapshotVersion", 999);
  });

  it("enqueues a minimal stable BullMQ job without invoking after in queue mode", async () => {
    process.env.PIPELINE_EXECUTION_MODE = "queue";
    const formData = new FormData();
    const file = new File(["audio-data"], "queue.m4a", { type: "audio/mp4" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(new TextEncoder().encode("audio-data").buffer)
    });
    formData.set("file", file);
    const request = { formData: vi.fn().mockResolvedValue(formData) } as unknown as Request;

    const response = await postUpload(request);
    const body = await response.json();
    const expectedQueueJobId = buildPipelineJobId({
      version: 1,
      uploadId: body.uploadId,
      userRef: "user_default"
    });

    expect(response.status).toBe(201);
    expect(body).toEqual({
      uploadId: expect.any(String),
      jobId: expect.any(String),
      status: "waiting",
      executionMode: "queue",
      queueJobId: expectedQueueJobId
    });
    expect(enqueuePipelineJobMock).toHaveBeenCalledWith({
      version: 1,
      uploadId: body.uploadId,
      userRef: "user_default"
    });
    expect(afterMock).not.toHaveBeenCalled();
    expect(processUploadMock).not.toHaveBeenCalled();
    expect(storeMock.write).toHaveBeenCalledWith(
      "jobs-by-upload",
      body.uploadId,
      expect.objectContaining({
        executionMode: "queue",
        queueJobId: expectedQueueJobId,
        queuedAt: expect.any(String),
        status: "waiting"
      })
    );
  });

  it("returns a recoverable waiting receipt and retains the upload when Redis enqueue is unavailable", async () => {
    process.env.PIPELINE_EXECUTION_MODE = "queue";
    enqueuePipelineJobMock.mockRejectedValueOnce(new Error("redis unavailable"));
    const formData = new FormData();
    const file = new File(["audio-data"], "queue.m4a", { type: "audio/mp4" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(new TextEncoder().encode("audio-data").buffer)
    });
    formData.set("file", file);

    const response = await postUpload({
      formData: vi.fn().mockResolvedValue(formData)
    } as unknown as Request);

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toEqual({
      uploadId: expect.any(String),
      jobId: expect.any(String),
      status: "waiting",
      executionMode: "queue",
      queueJobId: expect.stringMatching(/^pipeline-[a-f0-9]{64}$/),
      enqueueDeferred: true,
      warning: "pipeline_queue_unavailable"
    });
    expect(afterMock).not.toHaveBeenCalled();
    expect(processUploadMock).not.toHaveBeenCalled();
    expect(rmMock).not.toHaveBeenCalled();
    expect(storeMock.write).not.toHaveBeenCalledWith(
      "uploads",
      body.uploadId,
      expect.objectContaining({
        status: "failed",
        errorCode: "queue_unavailable"
      })
    );
    expect(storeMock.write).not.toHaveBeenCalledWith(
      "jobs-by-upload",
      body.uploadId,
      expect.objectContaining({ status: "failed", errorCode: "queue_unavailable" })
    );
  });

  it("marks only an explicitly opted-in upload for evaluation retention", async () => {
    process.env.EVALUATION_MODE = "true";
    const formData = new FormData();
    const file = new File(["audio-data"], "evaluation.m4a", { type: "audio/mp4" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(new TextEncoder().encode("audio-data").buffer)
    });
    formData.set("file", file);
    const request = {
      headers: new Headers({ "x-evaluation-retention": "true" }),
      formData: vi.fn().mockResolvedValue(formData)
    } as unknown as Request;

    const response = await postUpload(request);
    const [[, uploadId, payload]] = storeMock.write.mock.calls;

    expect(response.status).toBe(201);
    expect(payload).toMatchObject({ evaluationRetention: true });
    await expect(response.json()).resolves.toEqual({
      uploadId,
      jobId: expect.any(String),
      status: "uploaded",
      evaluationRetention: true
    });
  });

  it("logs the background processing lifecycle without request content", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const formData = new FormData();
    const file = new File(["audio-data"], "demo.m4a", { type: "audio/mp4" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(new TextEncoder().encode("audio-data").buffer)
    });
    formData.set("file", file);
    const request = {
      formData: vi.fn().mockResolvedValue(formData)
    } as unknown as Request;

    const response = await postUpload(request);
    const responseBody = await response.json();
    const uploadId = responseBody.uploadId as string;

    expect(response.status).toBe(201);
    await vi.waitFor(() => {
      expect(consoleInfo.mock.calls.map(([message]) => String(message))).toEqual(
        expect.arrayContaining([
          `[pipeline] background scheduled upload_id=${uploadId}`,
          `[pipeline] background started upload_id=${uploadId}`,
          expect.stringMatching(new RegExp(`^\\[pipeline\\] background completed upload_id=${uploadId} elapsed_ms=\\d+$`))
        ])
      );
    });
    consoleInfo.mockRestore();
  });

  it("normalizes recorder pcm uploads to wav before processing", async () => {
    const formData = new FormData();
    const file = new File(["pcm-data"], "Note-20000105224639.pcm", { type: "application/octet-stream" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(new Uint8Array([0x01, 0x00, 0xff, 0x7f]).buffer)
    });
    formData.set("file", file);
    const request = {
      formData: vi.fn().mockResolvedValue(formData)
    } as unknown as Request;

    const response = await postUpload(request);
    const [[, uploadId, payload]] = storeMock.write.mock.calls;
    const writtenBytes = writeFileMock.mock.calls[0]?.[1] as Uint8Array;

    expect(response.status).toBe(201);
    expect(payload.originalName).toBe("Note-20000105224639.pcm");
    expect(payload.mimeType).toBe("audio/wav");
    expect(payload.filePath).toBe(join(testUploadsRootDir, `${uploadId}.wav`));
    expect(new TextDecoder().decode(writtenBytes.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(writtenBytes.subarray(8, 12))).toBe("WAVE");
  });

  it("stores uploaded audio under APP_DATA_DIR when configured", async () => {
    process.env.APP_DATA_DIR = "/var/data/daily-brief";

    try {
      const formData = new FormData();
      const file = new File(["audio-data"], "demo.mp3", { type: "audio/mpeg" });
      Object.defineProperty(file, "arrayBuffer", {
        value: vi.fn().mockResolvedValue(new TextEncoder().encode("audio-data").buffer)
      });
      formData.set("file", file);
      const request = {
        formData: vi.fn().mockResolvedValue(formData)
      } as unknown as Request;

      const response = await postUpload(request);
      const [[, uploadId, payload]] = storeMock.write.mock.calls;

      expect(response.status).toBe(201);
      expect(payload.filePath).toBe(join(testUploadsRootDir, `${uploadId}.mp3`));
      expect(mkdirMock).toHaveBeenCalledWith(testUploadsRootDir, { recursive: true });
    } finally {
      delete process.env.APP_DATA_DIR;
    }
  });

  it("returns job status by job id", async () => {
    storeMock.read.mockResolvedValue({
      id: "job_1",
      uploadId: "upload_1",
      status: "transcribing",
      progress: 25
    });

    const response = await getJob(new Request("http://localhost/api/jobs/job_1"), {
      params: Promise.resolve({ jobId: "job_1" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "job_1",
      uploadId: "upload_1",
      status: "transcribing",
      progress: 25
    });
  });

  it("returns the latest upload id by upload createdAt timestamp", async () => {
    storeMock.list.mockResolvedValue([
      {
        id: "upload_old",
        value: {
          id: "upload_old",
          originalName: "old.mp3",
          mimeType: "audio/mpeg",
          sizeBytes: 100,
          recordingDate: "2026-06-03",
          status: "ready",
          createdAt: "2026-06-03T10:00:00.000Z"
        }
      },
      {
        id: "upload_new",
        value: {
          id: "upload_new",
          originalName: "new.mp3",
          mimeType: "audio/mpeg",
          sizeBytes: 100,
          recordingDate: "2026-06-04",
          status: "ready",
          createdAt: "2026-06-04T10:00:00.000Z"
        }
      }
    ]);

    const response = await getLatestUpload(new Request("http://localhost/api/uploads/latest"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ uploadId: "upload_new" });
  });

  it("reads latest upload from the authenticated user's scoped store", async () => {
    storeMock.list.mockResolvedValue([
      {
        id: "upload_private",
        value: {
          id: "upload_private",
          originalName: "private.mp3",
          mimeType: "audio/mpeg",
          sizeBytes: 100,
          recordingDate: "2026-06-05",
          status: "ready",
          createdAt: "2026-06-05T10:00:00.000Z"
        }
      }
    ]);

    const request = new Request("http://localhost/api/uploads/latest");
    const response = await getLatestUpload(request);

    expect(response.status).toBe(200);
    expect(authContextMock.requireAuthContext).toHaveBeenCalledWith(request);
    expect(storeMock.list).toHaveBeenCalledWith("uploads");
    await expect(response.json()).resolves.toEqual({ uploadId: "upload_private" });
  });

  it("rejects unauthenticated access before reading upload data", async () => {
    authContextMock.requireAuthContext.mockRejectedValueOnce(new Error("unauthenticated"));

    const request = new Request("http://localhost/api/uploads/latest");
    const response = await getLatestUpload(request);

    expect(response.status).toBe(401);
    expect(storeMock.list).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: "unauthenticated" });
  });

  it("returns the latest upload id for a selected recording date", async () => {
    storeMock.list.mockResolvedValue([
      {
        id: "upload_morning",
        value: {
          id: "upload_morning",
          originalName: "morning.mp3",
          mimeType: "audio/mpeg",
          sizeBytes: 100,
          recordingDate: "2026-06-03",
          status: "ready",
          createdAt: "2026-06-03T08:00:00.000Z"
        }
      },
      {
        id: "upload_evening",
        value: {
          id: "upload_evening",
          originalName: "evening.mp3",
          mimeType: "audio/mpeg",
          sizeBytes: 100,
          recordingDate: "2026-06-03",
          status: "ready",
          createdAt: "2026-06-03T20:00:00.000Z"
        }
      },
      {
        id: "upload_other_day",
        value: {
          id: "upload_other_day",
          originalName: "other.mp3",
          mimeType: "audio/mpeg",
          sizeBytes: 100,
          recordingDate: "2026-06-04",
          status: "ready",
          createdAt: "2026-06-04T10:00:00.000Z"
        }
      }
    ]);

    const response = await getUploadByDate(new Request("http://localhost/api/uploads/by-date?date=2026-06-03"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      uploadId: "upload_evening",
      uploadIds: ["upload_morning", "upload_evening"],
      recordingDate: "2026-06-03"
    });
  });

  it("returns all upload ids for a selected recording date from oldest to newest while keeping the latest upload id", async () => {
    storeMock.list.mockResolvedValue([
      {
        id: "upload_evening",
        value: {
          id: "upload_evening",
          originalName: "evening.mp3",
          mimeType: "audio/mpeg",
          sizeBytes: 100,
          recordingDate: "2026-06-03",
          status: "ready",
          createdAt: "2026-06-03T20:00:00.000Z"
        }
      },
      {
        id: "upload_other_day",
        value: {
          id: "upload_other_day",
          originalName: "other.mp3",
          mimeType: "audio/mpeg",
          sizeBytes: 100,
          recordingDate: "2026-06-04",
          status: "ready",
          createdAt: "2026-06-04T10:00:00.000Z"
        }
      },
      {
        id: "upload_morning",
        value: {
          id: "upload_morning",
          originalName: "morning.mp3",
          mimeType: "audio/mpeg",
          sizeBytes: 100,
          recordingDate: "2026-06-03",
          status: "ready",
          createdAt: "2026-06-03T08:00:00.000Z"
        }
      },
      {
        id: "upload_midday",
        value: {
          id: "upload_midday",
          originalName: "midday.mp3",
          mimeType: "audio/mpeg",
          sizeBytes: 100,
          recordingDate: "2026-06-03",
          status: "ready",
          createdAt: "2026-06-03T12:00:00.000Z"
        }
      }
    ]);

    const response = await getUploadByDate(new Request("http://localhost/api/uploads/by-date?date=2026-06-03"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      uploadId: "upload_evening",
      uploadIds: ["upload_morning", "upload_midday", "upload_evening"],
      recordingDate: "2026-06-03"
    });
  });

  it("falls back to upload file mtime when selecting a date without createdAt timestamps", async () => {
    const tempDirectory = await nodeMkdtemp(join(tmpdir(), "daily-brief-mtime-"));
    const olderPath = join(tempDirectory, "older.mp3");
    const newerPath = join(tempDirectory, "newer.mp3");

    try {
      await nodeWriteFile(olderPath, "older");
      await nodeWriteFile(newerPath, "newer");
      await utimes(olderPath, new Date(1000), new Date(1000));
      await utimes(newerPath, new Date(2000), new Date(2000));
      statMock.mockImplementation(async (filePath: string) => ({
        mtimeMs: filePath === newerPath ? 2000 : 1000
      }));
      storeMock.list.mockResolvedValue([
        {
          id: "upload_old_file",
          value: {
            id: "upload_old_file",
            originalName: "older.mp3",
            mimeType: "audio/mpeg",
            sizeBytes: 100,
            recordingDate: "2026-06-03",
            status: "ready",
            filePath: olderPath
          }
        },
        {
          id: "upload_new_file",
          value: {
            id: "upload_new_file",
            originalName: "newer.mp3",
            mimeType: "audio/mpeg",
            sizeBytes: 100,
            recordingDate: "2026-06-03",
            status: "ready",
            filePath: newerPath
          }
        }
      ]);

      const response = await getUploadByDate(new Request("http://localhost/api/uploads/by-date?date=2026-06-03"));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        uploadId: "upload_new_file",
        uploadIds: ["upload_old_file", "upload_new_file"],
        recordingDate: "2026-06-03"
      });
    } finally {
      await nodeRm(tempDirectory, { force: true, recursive: true });
    }
  });

  it("returns null when a selected recording date has no upload", async () => {
    storeMock.list.mockResolvedValue([
      {
        id: "upload_other_day",
        value: {
          id: "upload_other_day",
          originalName: "other.mp3",
          mimeType: "audio/mpeg",
          sizeBytes: 100,
          recordingDate: "2026-06-04",
          status: "ready",
          createdAt: "2026-06-04T10:00:00.000Z"
        }
      }
    ]);

    const response = await getUploadByDate(new Request("http://localhost/api/uploads/by-date?date=2026-06-03"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ uploadId: null, uploadIds: [], recordingDate: "2026-06-03" });
  });

  it("returns 400 when the selected recording date is not a real calendar day", async () => {
    const response = await getUploadByDate(new Request("http://localhost/api/uploads/by-date?date=2026-02-31"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_date" });
    expect(storeMock.list).not.toHaveBeenCalled();
  });

  it("returns unique recording dates that have ready local uploads with evidence", async () => {
    storeMock.list.mockResolvedValue([
      {
        id: "upload_morning",
        value: {
          id: "upload_morning",
          originalName: "morning.mp3",
          mimeType: "audio/mpeg",
          sizeBytes: 100,
          recordingDate: "2026-06-03",
          status: "ready"
        }
      },
      {
        id: "upload_evening",
        value: {
          id: "upload_evening",
          originalName: "evening.mp3",
          mimeType: "audio/mpeg",
          sizeBytes: 100,
          recordingDate: "2026-06-03",
          status: "ready"
        }
      },
      {
        id: "upload_empty",
        value: {
          id: "upload_empty",
          originalName: "empty.mp3",
          mimeType: "audio/mpeg",
          sizeBytes: 100,
          recordingDate: "2026-06-01",
          status: "ready"
        }
      },
      {
        id: "upload_other_day",
        value: {
          id: "upload_other_day",
          originalName: "other.mp3",
          mimeType: "audio/mpeg",
          sizeBytes: 100,
          recordingDate: "2026-06-02",
          status: "transcribing"
        }
      }
    ]);
    storeMock.read.mockImplementation((collection: string, uploadId: string) => {
      if (uploadId === "upload_morning" && collection === "segments") {
        return Promise.resolve([{ id: "segment_1" }]);
      }

      return Promise.resolve([]);
    });

    const response = await getUploadDates(new Request("http://localhost/api/uploads/dates"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ dates: ["2026-06-03"] });
  });

  it("returns local-only settings without leaking a custom API key", async () => {
    storeMock.read.mockResolvedValue({
      apiKeyMode: "custom",
      openRouterApiKey: "sk-or-secret",
      updatedAt: "2026-06-04T08:00:00.000Z"
    });
    process.env.OPENROUTER_API_KEY = "default_key";

    const response = await getSettings(new Request("http://localhost/api/settings"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(
      expect.objectContaining({
        apiKeyMode: "custom",
        hasCustomApiKey: true,
        defaultApiKeyAvailable: true,
        activeApiKeySource: "custom",
        providerDisplayName: "OpenRouter / OpenAI compatible",
        qaModel: expect.any(String),
        qaModelPresets: expect.arrayContaining([expect.objectContaining({ value: expect.any(String) })]),
        qaPromptPresetId: "work",
        qaPromptPresets: expect.arrayContaining([expect.objectContaining({ id: "negotiation", label: "商务谈判" })]),
        customQaPrompt: "",
        storageMode: "local",
        canOpenDataFolder: true,
        dataDirectory: testDataRootDir,
        uploadsDirectory: testUploadsRootDir,
        apiKeyStoragePath: testProviderConfigPath
      })
    );
    expect(JSON.stringify(body)).not.toContain("sk-or-secret");
  });

  it("stores a user OpenRouter API key locally without returning the key", async () => {
    storeMock.read.mockResolvedValue({
      apiKeyMode: "custom",
      openRouterApiKey: "sk-or-user",
      updatedAt: "2026-06-04T08:00:00.000Z"
    });
    const request = new Request("http://localhost/api/settings", {
      method: "POST",
      body: JSON.stringify({
        apiKeyMode: "custom",
        openRouterApiKey: "  sk-or-user  ",
        qaModel: " openai/gpt-5.1 "
      }),
      headers: { "content-type": "application/json" }
    });

    const response = await postSettings(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(storeMock.write).toHaveBeenCalledWith("settings", "provider-config", {
      apiKeyMode: "custom",
      openRouterApiKey: "sk-or-user",
      qaModel: "openai/gpt-5.1",
      updatedAt: expect.any(String)
    });
    expect(body).toEqual(
      expect.objectContaining({
        apiKeyMode: "custom",
        hasCustomApiKey: true,
        activeApiKeySource: "custom"
      })
    );
    expect(JSON.stringify(body)).not.toContain("sk-or-user");
  });

  it("updates only the QA model without requiring the API key again", async () => {
    storeMock.read.mockResolvedValue({
      apiKeyMode: "custom",
      openRouterApiKey: "sk-or-existing",
      qaModel: "openai/gpt-5-mini",
      updatedAt: "2026-06-04T08:00:00.000Z"
    });
    const request = new Request("http://localhost/api/settings", {
      method: "POST",
      body: JSON.stringify({ qaModel: "openai/gpt-5.2" }),
      headers: { "content-type": "application/json" }
    });

    const response = await postSettings(request);

    expect(response.status).toBe(200);
    expect(storeMock.write).toHaveBeenCalledWith("settings", "provider-config", {
      apiKeyMode: "custom",
      openRouterApiKey: "sk-or-existing",
      qaModel: "openai/gpt-5.2",
      updatedAt: expect.any(String)
    });
  });

  it("updates only the QA prompt role without requiring the API key again", async () => {
    storeMock.read.mockResolvedValue({
      apiKeyMode: "custom",
      openRouterApiKey: "sk-or-existing",
      qaModel: "openai/gpt-5-mini",
      updatedAt: "2026-06-04T08:00:00.000Z"
    });
    const request = new Request("http://localhost/api/settings", {
      method: "POST",
      body: JSON.stringify({
        qaPromptPresetId: "custom",
        customQaPrompt: "请像谈判教练一样回答，优先识别筹码、让步和风险。"
      }),
      headers: { "content-type": "application/json" }
    });

    const response = await postSettings(request);

    expect(response.status).toBe(200);
    expect(storeMock.write).toHaveBeenCalledWith("settings", "provider-config", {
      apiKeyMode: "custom",
      openRouterApiKey: "sk-or-existing",
      qaModel: "openai/gpt-5-mini",
      qaPromptPresetId: "custom",
      customQaPrompt: "请像谈判教练一样回答，优先识别筹码、让步和风险。",
      updatedAt: expect.any(String)
    });
  });

  it("switches back to the default provider without keeping the custom key", async () => {
    storeMock.read.mockResolvedValue({
      apiKeyMode: "default",
      updatedAt: "2026-06-04T08:00:00.000Z"
    });
    const request = new Request("http://localhost/api/settings", {
      method: "POST",
      body: JSON.stringify({ apiKeyMode: "default" }),
      headers: { "content-type": "application/json" }
    });

    const response = await postSettings(request);

    expect(response.status).toBe(200);
    expect(storeMock.write).toHaveBeenCalledWith("settings", "provider-config", {
      apiKeyMode: "default",
      updatedAt: expect.any(String)
    });
  });

  it("opens the local data folder on the user's machine", async () => {
    const response = await postOpenDataFolder(new Request("http://localhost/api/settings/open-data-folder", { method: "POST" }));

    expect(response.status).toBe(200);
    expect(execFileMock).toHaveBeenCalledWith("open", [testDataRootDir], expect.any(Function));
    await expect(response.json()).resolves.toEqual({
      opened: true,
      dataDirectory: testDataRootDir
    });
  });

  it("does not try to open a server storage folder in online validation mode", async () => {
    process.env.APP_STORAGE_MODE = "server";

    try {
      const response = await postOpenDataFolder(new Request("http://localhost/api/settings/open-data-folder", { method: "POST" }));

      expect(response.status).toBe(400);
      expect(execFileMock).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toEqual({ error: "open_data_folder_unavailable" });
    } finally {
      delete process.env.APP_STORAGE_MODE;
    }
  });

  it("returns sanitized day payload without filePath", async () => {
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return {
          id: "upload_1",
          originalName: "demo.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-06-03",
          status: "ready",
          filePath: ".data/uploads/upload_1.m4a"
        };
      }
      if (collection === "jobs-by-upload") {
        return { id: "job_1", uploadId: "upload_1", status: "ready", progress: 100 };
      }
      if (collection === "segments") {
        return [{ id: "segment_1" }];
      }
      if (collection === "audio-insights") {
        return [{ id: "insight_1" }];
      }
      if (collection === "semantic-segments") {
        return [{ id: "semantic_1" }];
      }
      if (collection === "brief-items") {
        return [{ id: "brief_1" }];
      }
      if (collection === "relationship-signals") {
        return [{ id: "signal_1" }];
      }
      if (collection === "proactive-insights") {
        return {
          schemaVersion: 1,
          cacheId: "current_upload_1",
          scope: "current",
          status: "generated",
          sourceFingerprint: "fingerprint_1",
          generatedAt: "2026-06-03T12:00:00.000Z",
          items: [
            {
              id: "proactive_1",
              scope: "current",
              type: "follow_up_question",
              category: "follow_up",
              observation: "录音里出现了一项仍需确认的安排。",
              question: "这次还有什么需要确认？",
              reason: "摘要里保留了一项未确认内容。",
              confidence: 0.72,
              evidenceRefs: [
                {
                  evidenceId: "brief:brief_1",
                  kind: "brief",
                  sourceType: "brief",
                  sourceId: "brief_1",
                  uploadId: "upload_1",
                  recordingDate: "2026-06-03",
                  sourceSegmentIds: ["segment_1"],
                  timeRange: { startSeconds: 1, endSeconds: 2 },
                  title: "需要确认的安排",
                  summary: "安排仍未确认。",
                  excerpt: "我们之后再确认具体时间。"
                }
              ],
              sourceUploadIds: ["upload_1"],
              createdAt: "2026-06-03T12:00:00.000Z"
            }
          ]
        };
      }
      return null;
    });

    const response = await getDay(new Request("http://localhost/api/days/upload_1"), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.upload.filePath).toBeUndefined();
    expect(body.upload.id).toBe("upload_1");
    expect(body.job.id).toBe("job_1");
    expect(body.segments).toEqual([{ id: "segment_1" }]);
    expect(body.audioInsights).toEqual([{ id: "insight_1" }]);
    expect(body.semanticSegments).toEqual([{ id: "semantic_1" }]);
    expect(body.semanticSegmentsAvailable).toBe(true);
    expect(body.briefItems).toEqual([{ id: "brief_1" }]);
    expect(body.relationshipSignals).toEqual([{ id: "signal_1" }]);
    expect(body.proactiveInsights).toEqual([
      expect.objectContaining({ id: "proactive_1", question: "这次还有什么需要确认？" })
    ]);
    expect(body.proactiveInsightsAvailable).toBe(true);
  });

  it("does not expose malformed proactive insight cache data", async () => {
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return {
          id: "upload_1",
          originalName: "demo.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-06-03",
          status: "ready"
        };
      }
      if (collection === "proactive-insights") {
        return {
          schemaVersion: 1,
          cacheId: "current_upload_1",
          scope: "current",
          status: "generated",
          sourceFingerprint: "fingerprint_1",
          generatedAt: "2026-06-03T12:00:00.000Z",
          items: [{ id: "broken_without_evidence" }]
        };
      }
      return null;
    });

    const response = await getDay(new Request("http://localhost/api/days/upload_1"), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.proactiveInsights).toEqual([]);
    expect(body.proactiveInsightsAvailable).toBe(false);
  });

  it("saves speaker aliases for the authenticated user's current upload", async () => {
    process.env.PIPELINE_EXECUTION_MODE = "queue";
    process.env.QA_HYBRID_RETRIEVAL_MODE = "shadow";
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return {
          id: "upload_1",
          originalName: "demo.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-06-03",
          status: "ready"
        };
      }
      return null;
    });
    const request = new Request("http://localhost/api/days/upload_1/speaker-aliases", {
      method: "PUT",
      body: JSON.stringify({
        aliases: {
          speaker_1: " 张三 ",
          speaker_2: "我",
          speaker_3: ""
        }
      })
    });

    const response = await putSpeakerAliases(request, {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(200);
    expect(authContextMock.requireAuthContext).toHaveBeenCalledWith(request);
    expect(storeMock.write).toHaveBeenCalledWith("speaker-aliases", "upload_1", {
      aliases: {
        speaker_1: "张三",
        speaker_2: "我"
      },
      updatedAt: expect.any(String)
    });
    expect(enqueueEmbeddingIndexJobMock).toHaveBeenCalledWith({
      version: 1,
      userRef: "user_default",
      reason: "speaker_aliases"
    });
    await expect(response.json()).resolves.toEqual({
      aliases: {
        speaker_1: "张三",
        speaker_2: "我"
      }
    });
  });

  it("blocks speaker alias writes once permanent upload deletion has started", async () => {
    storeMock.read.mockResolvedValue({
      id: "upload_1",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 12,
      recordingDate: "2026-06-03",
      status: "ready"
    });
    readHybridIndexDeletionMock.mockResolvedValue({ status: "pending" });

    const response = await putSpeakerAliases(
      new Request("http://localhost/api/days/upload_1/speaker-aliases", {
        method: "PUT",
        body: JSON.stringify({ aliases: { speaker_1: "Alice" } })
      }),
      { params: Promise.resolve({ uploadId: "upload_1" }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "upload_deletion_in_progress"
    });
    expect(storeMock.write).not.toHaveBeenCalled();
    expect(enqueueEmbeddingIndexJobMock).not.toHaveBeenCalled();
  });

  it("blocks speaker alias writes while browser-cache retention is prepared", async () => {
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return { id: "upload_1", status: "ready" };
      }
      return null;
    });
    readHybridIndexRetentionManifestMock.mockResolvedValue({
      uploadId: "upload_1"
    });

    const response = await putSpeakerAliases(
      new Request("http://localhost/api/days/upload_1/speaker-aliases", {
        method: "PUT",
        body: JSON.stringify({ aliases: { speaker_1: "Alice" } })
      }),
      { params: Promise.resolve({ uploadId: "upload_1" }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "upload_cleanup_in_progress"
    });
    expect(storeMock.write).not.toHaveBeenCalled();
  });

  it("reads speaker aliases for the authenticated user's current upload", async () => {
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return {
          id: "upload_1",
          originalName: "demo.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-06-03",
          status: "ready"
        };
      }
      if (collection === "speaker-aliases") {
        return { aliases: { speaker_1: "张三" }, updatedAt: "2026-06-03T00:00:00.000Z" };
      }
      return null;
    });

    const request = new Request("http://localhost/api/days/upload_1/speaker-aliases");
    const response = await getSpeakerAliases(request, {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(200);
    expect(authContextMock.requireAuthContext).toHaveBeenCalledWith(request);
    await expect(response.json()).resolves.toEqual({ aliases: { speaker_1: "张三" } });
  });

  it("returns saved speaker aliases with the day payload", async () => {
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return {
          id: "upload_1",
          originalName: "demo.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-06-03",
          status: "ready"
        };
      }
      if (collection === "speaker-aliases") {
        return { aliases: { speaker_1: "张三" }, updatedAt: "2026-06-03T00:00:00.000Z" };
      }
      return null;
    });

    const response = await getDay(new Request("http://localhost/api/days/upload_1"), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.speakerAliases).toEqual({ speaker_1: "张三" });
  });

  it("saves audio insight corrections for the authenticated user's current upload", async () => {
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return {
          id: "upload_1",
          originalName: "demo.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-06-03",
          status: "ready"
        };
      }
      return null;
    });
    const request = new Request("http://localhost/api/days/upload_1/audio-insight-corrections", {
      method: "PUT",
      body: JSON.stringify({
        corrections: {
          insight_1: {
            labelCorrections: [{ from: " 紧张 ", to: " 认真 " }],
            note: "  用户确认这段不是紧张。 "
          },
          "bad/id": {
            labelCorrections: [{ from: "x", to: "y" }]
          }
        }
      })
    });

    const response = await putAudioInsightCorrections(request, {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(200);
    expect(authContextMock.requireAuthContext).toHaveBeenCalledWith(request);
    expect(storeMock.write).toHaveBeenCalledWith("audio-insight-corrections", "upload_1", {
      corrections: {
        insight_1: {
          labelCorrections: [{ from: "紧张", to: "认真" }],
          note: "用户确认这段不是紧张。",
          updatedAt: expect.any(String)
        }
      },
      updatedAt: expect.any(String)
    });
    await expect(response.json()).resolves.toEqual({
      corrections: {
        insight_1: {
          labelCorrections: [{ from: "紧张", to: "认真" }],
          note: "用户确认这段不是紧张。",
          updatedAt: expect.any(String)
        }
      },
      updatedAt: expect.any(String)
    });
  });

  it("removes a correction write when permanent deletion starts concurrently", async () => {
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection !== "uploads") return null;
      return {
        id: "upload_1",
        originalName: "demo.m4a",
        mimeType: "audio/mp4",
        sizeBytes: 12,
        recordingDate: "2026-06-03",
        status: "ready"
      };
    });
    readHybridIndexDeletionMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: "pending" });

    const response = await putAudioInsightCorrections(
      new Request("http://localhost/api/days/upload_1/audio-insight-corrections", {
        method: "PUT",
        body: JSON.stringify({ corrections: {} })
      }),
      { params: Promise.resolve({ uploadId: "upload_1" }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "upload_deletion_in_progress"
    });
    expect(storeMock.write).toHaveBeenCalledWith(
      "audio-insight-corrections",
      "upload_1",
      expect.objectContaining({ corrections: {} })
    );
    expect(storeMock.delete).toHaveBeenCalledWith(
      "audio-insight-corrections",
      "upload_1"
    );
    expect(enqueueEmbeddingIndexJobMock).not.toHaveBeenCalled();
  });

  it("restores prior corrections when browser cleanup starts during a write", async () => {
    const previousCorrections = {
      corrections: {},
      updatedAt: "2026-08-06T00:00:00.000Z"
    };
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return { id: "upload_1", status: "ready" };
      }
      if (collection === "audio-insight-corrections") {
        return previousCorrections;
      }
      return null;
    });
    readHybridIndexRetentionManifestMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ uploadId: "upload_1" });

    const response = await putAudioInsightCorrections(
      new Request("http://localhost/api/days/upload_1/audio-insight-corrections", {
        method: "PUT",
        body: JSON.stringify({ corrections: {} })
      }),
      { params: Promise.resolve({ uploadId: "upload_1" }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "upload_cleanup_in_progress"
    });
    expect(storeMock.write).toHaveBeenLastCalledWith(
      "audio-insight-corrections",
      "upload_1",
      previousCorrections
    );
    expect(storeMock.delete).not.toHaveBeenCalledWith(
      "audio-insight-corrections",
      "upload_1"
    );
    expect(enqueueEmbeddingIndexJobMock).not.toHaveBeenCalled();
  });

  it("reads audio insight corrections for the authenticated user's current upload", async () => {
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return {
          id: "upload_1",
          originalName: "demo.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-06-03",
          status: "ready"
        };
      }
      if (collection === "audio-insight-corrections") {
        return {
          corrections: {
            insight_1: {
              labelCorrections: [{ from: "紧张", to: "认真" }],
              note: "用户确认这段不是紧张。",
              updatedAt: "2026-06-03T00:00:00.000Z"
            }
          },
          updatedAt: "2026-06-03T00:00:00.000Z"
        };
      }
      return null;
    });

    const request = new Request("http://localhost/api/days/upload_1/audio-insight-corrections");
    const response = await getAudioInsightCorrections(request, {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(200);
    expect(authContextMock.requireAuthContext).toHaveBeenCalledWith(request);
    await expect(response.json()).resolves.toEqual({
      corrections: {
        insight_1: {
          labelCorrections: [{ from: "紧张", to: "认真" }],
          note: "用户确认这段不是紧张。",
          updatedAt: "2026-06-03T00:00:00.000Z"
        }
      }
    });
  });

  it("returns saved audio insight corrections with the day payload", async () => {
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return {
          id: "upload_1",
          originalName: "demo.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-06-03",
          status: "ready"
        };
      }
      if (collection === "audio-insights") {
        return [{ id: "insight_1", summary: "说话人语气紧张。" }];
      }
      if (collection === "audio-insight-corrections") {
        return {
          corrections: {
            insight_1: {
              labelCorrections: [{ from: "紧张", to: "认真" }],
              note: "用户确认这段不是紧张。",
              updatedAt: "2026-06-03T00:00:00.000Z"
            }
          },
          updatedAt: "2026-06-03T00:00:00.000Z"
        };
      }
      return null;
    });

    const response = await getDay(new Request("http://localhost/api/days/upload_1"), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.audioInsights).toEqual([
      {
        id: "insight_1",
        summary: "说话人语气紧张。",
        userCorrections: [
          {
            labelCorrections: [{ from: "紧张", to: "认真" }],
            note: "用户确认这段不是紧张。",
            updatedAt: "2026-06-03T00:00:00.000Z"
          }
        ]
      }
    ]);
  });

  it("distinguishes missing semantic artifacts from generated empty semantic results", async () => {
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return {
          id: "upload_1",
          originalName: "demo.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-06-03",
          status: "ready"
        };
      }
      if (collection === "semantic-segments") {
        return [];
      }
      return null;
    });

    const response = await getDay(new Request("http://localhost/api/days/upload_1"), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.semanticSegments).toEqual([]);
    expect(body.semanticSegmentsAvailable).toBe(true);
  });

  it("returns 400 for malformed qa json bodies", async () => {
    const request = new Request("http://localhost/api/days/upload_1/qa", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" }
    });

    const response = await postQa(request, {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_json" });
  });

  it("returns saved qa history for an upload", async () => {
    const savedAnswers = [
      {
        id: "answer_old",
        uploadId: "upload_1",
        question: "之前问过什么？",
        answer: "之前保存的回答",
        citedSegmentIds: ["segment_1"],
        createdAt: "2026-06-03T00:00:00.000Z"
      }
    ];
    storeMock.read.mockImplementation(async (collection: string, id: string) => {
      if (collection === "answers-by-upload" && id === "upload_1") {
        return savedAnswers;
      }
      return null;
    });

    const response = await getQaHistory(new Request("http://localhost/api/days/upload_1/qa"), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ answers: savedAnswers });
  });

  it("returns saved qa history for week and all-memory scopes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    storeMock.read.mockImplementation(async (collection: string, id: string) => {
      if (collection === "answers-by-scope" && id === "week_20260601_20260607") {
        return [{ id: "answer_week", question: "本周问题", answer: "本周回答", citedSegmentIds: [], createdAt: "2026-06-04T12:00:00.000Z" }];
      }
      if (collection === "answers-by-scope" && id === "all_memory") {
        return [{ id: "answer_all", question: "全部问题", answer: "全部回答", citedSegmentIds: [], createdAt: "2026-06-04T12:01:00.000Z" }];
      }
      return null;
    });

    const weekResponse = await getWeekQaHistory(new Request("http://localhost/api/memory/week/qa"));
    const allResponse = await getAllQaHistory(new Request("http://localhost/api/memory/all/qa"));

    expect(weekResponse.status).toBe(200);
    await expect(weekResponse.json()).resolves.toEqual({
      answers: [{ id: "answer_week", question: "本周问题", answer: "本周回答", citedSegmentIds: [], createdAt: "2026-06-04T12:00:00.000Z" }]
    });
    expect(allResponse.status).toBe(200);
    await expect(allResponse.json()).resolves.toEqual({
      answers: [{ id: "answer_all", question: "全部问题", answer: "全部回答", citedSegmentIds: [], createdAt: "2026-06-04T12:01:00.000Z" }]
    });
  });

  it("persists AI qa answers by upload and by answer id", async () => {
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return { id: "upload_1", status: "ready" };
      }
      if (collection === "segments") {
        return [{ id: "segment_1", text: "demo" }];
      }
      if (collection === "semantic-segments") {
        return [{ id: "semantic_1", title: "语义证据" }];
      }
      if (collection === "audio-insights") {
        return [{ id: "insight_1", summary: "说话人语气坚定。" }];
      }
      if (collection === "audio-insight-corrections") {
        return {
          corrections: {
            insight_1: {
              labelCorrections: [{ from: "tentative", to: "confirmed" }],
              note: "User confirmed the label.",
              updatedAt: "2026-06-03T00:00:00.000Z"
            }
          },
          updatedAt: "2026-06-03T00:00:00.000Z"
        };
      }
      if (collection === "brief-items") {
        return [{ id: "brief_1" }];
      }
      if (collection === "relationship-signals") {
        return [relationshipSignalFixture({ uploadId: "upload_1", segmentId: "segment_1", date: "2026-06-03" })];
      }
      if (collection === "answers-by-upload") {
        return [{ id: "answer_old" }];
      }
      return null;
    });
    const request = new Request("http://localhost/api/days/upload_1/qa", {
      method: "POST",
      body: JSON.stringify({ question: "What did I commit to?" }),
      headers: { "content-type": "application/json" }
    });

    const response = await postQa(request, {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(200);
    expect(answerQuestionWithAIMock).toHaveBeenCalledWith({
      userId: "user_default",
      uploadId: "upload_1",
      question: "What did I commit to?",
      scope: "current",
      segments: [{ id: "segment_1", text: "demo" }],
      audioInsights: [{ id: "insight_1", summary: "说话人语气坚定。" }],
      semanticSegments: [{ id: "semantic_1", title: "语义证据" }],
      briefItems: [{ id: "brief_1" }],
      relationshipSignals: [relationshipSignalFixture({ uploadId: "upload_1", segmentId: "segment_1", date: "2026-06-03" })],
      settingsStore: storeMock
    });
    const qaInput = answerQuestionWithAIMock.mock.calls.at(-1)?.[0];
    expect(qaInput.hybridEvidenceInput.audioInsights[0].userCorrections)
      .toEqual([expect.objectContaining({ note: "User confirmed the label." })]);
    expect(Object.keys(qaInput)).not.toContain("hybridEvidenceInput");
    expect(storeMock.write).toHaveBeenNthCalledWith(1, "answers", "answer_1", {
      id: "answer_1",
      uploadId: "upload_1",
      question: "What did I commit to?",
      answer: "Answer",
      citedSegmentIds: ["segment_1"],
      createdAt: "2026-06-03T00:00:00.000Z"
    });
    expect(storeMock.write).toHaveBeenNthCalledWith(2, "answers-by-upload", "upload_1", [
      { id: "answer_old" },
      {
        id: "answer_1",
        uploadId: "upload_1",
        question: "What did I commit to?",
        answer: "Answer",
        citedSegmentIds: ["segment_1"],
        createdAt: "2026-06-03T00:00:00.000Z"
      }
    ]);
    await expect(response.json()).resolves.toEqual({
      id: "answer_1",
      uploadId: "upload_1",
      question: "What did I commit to?",
      answer: "Answer",
      citedSegmentIds: ["segment_1"],
      createdAt: "2026-06-03T00:00:00.000Z"
    });
  });

  it("passes qa conversation context through the current upload route", async () => {
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return { id: "upload_1", status: "ready" };
      }
      if (collection === "segments") {
        return [{ id: "segment_1", text: "demo" }];
      }
      if (collection === "semantic-segments") {
        return [];
      }
      if (collection === "audio-insights") {
        return [{ id: "insight_1", summary: "对方有追问。" }];
      }
      if (collection === "brief-items") {
        return [];
      }
      if (collection === "answers-by-upload") {
        return [];
      }
      return null;
    });

    const conversation = [
      {
        role: "user",
        content: "你看看会议中的每个人的性格是怎么样的，分析一下"
      },
      {
        role: "assistant",
        content: "我可以改成分析每个人在这场会议里的发言角色、关注点、决策风格或协作方式。"
      }
    ];
    const request = new Request("http://localhost/api/days/upload_1/qa", {
      method: "POST",
      body: JSON.stringify({ question: "可以", conversation }),
      headers: { "content-type": "application/json" }
    });

    const response = await postQa(request, {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(200);
    expect(answerQuestionWithAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadId: "upload_1",
        question: "可以",
        audioInsights: [{ id: "insight_1", summary: "对方有追问。" }],
        conversation
      })
    );
  });

  it("answers current day qa from browser-provided context without persisting server history", async () => {
    answerQuestionWithAIMock.mockResolvedValueOnce({
      id: "answer_day_context",
      uploadId: "day_2026-06-03",
      question: "这一天有什么重点？",
      answer: "这一天上午确认上线节奏，晚间要补齐客户材料。[E1]",
      citedSegmentIds: ["seg_context_1"],
      createdAt: "2026-06-03T10:00:00.000Z"
    });
    const conversation = [
      { role: "user", content: "先帮我看重点" },
      { role: "assistant", content: "可以，我会只按当天证据回答。" }
    ];
    const segment = {
      id: "seg_context_1",
      uploadId: "upload_morning",
      startSeconds: 10,
      endSeconds: 20,
      speaker: "A",
      text: "上午确认上线节奏。",
      confidence: 0.95,
      sceneLabels: ["product_discussion"],
      valueLabels: ["decision"]
    };
    const semanticSegment = {
      id: "semantic_context_1",
      uploadId: "upload_morning",
      title: "上线节奏确认",
      summary: "上午确认上线节奏。",
      startSeconds: 10,
      endSeconds: 20,
      tags: ["上线"],
      sceneLabels: ["product_discussion"],
      valueLabels: ["decision"],
      confidence: 0.92,
      sourceSegmentIds: ["seg_context_1"],
      sourceTimeRange: { startSeconds: 10, endSeconds: 20 },
      transcriptExcerpt: "上午确认上线节奏。"
    };
    const briefItem = {
      id: "brief_context_1",
      uploadId: "upload_morning",
      category: "decision",
      title: "确认上线节奏",
      body: "上午确认上线节奏。",
      priority: "high",
      confidence: 0.9,
      status: "confirmed",
      sourceSegmentIds: ["seg_context_1"],
      sourceTimeRange: { startSeconds: 10, endSeconds: 20 },
      transcriptExcerpt: "上午确认上线节奏。",
      people: [],
      topics: ["上线"]
    };
    const audioInsight = {
      id: "insight_context_1",
      uploadId: "upload_morning",
      sourceSegmentIds: ["seg_context_1"],
      sourceTimeRange: { startSeconds: 10, endSeconds: 20 },
      speaker: { id: "A", role: "self", confidence: 0.6 },
      voice: { pace: "normal", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.35 },
      toneLabels: ["firm"],
      emotionLabels: ["neutral"],
      interactionLabels: ["decision_moment"],
      summary: "说话人语气明确，正在确认节奏。",
      evidence: "原文提到“确认上线节奏”。",
      confidence: 0.7
    };
    const relationshipSignal = relationshipSignalFixture({
      uploadId: "upload_morning",
      segmentId: "seg_context_1",
      date: "2026-06-03",
      startSeconds: 10,
      endSeconds: 20
    });
    const request = new Request("http://localhost/api/days/context/qa", {
      method: "POST",
      body: JSON.stringify({
        uploadId: "day_2026-06-03",
        question: "这一天有什么重点？",
        conversation,
        promptPresetId: "date",
        customPrompt: "",
        segments: [segment],
        audioInsights: [audioInsight],
        semanticSegments: [semanticSegment],
        briefItems: [briefItem],
        relationshipSignals: [relationshipSignal]
      }),
      headers: { "content-type": "application/json" }
    });

    const response = await postContextQa(request);

    expect(response.status).toBe(200);
    expect(answerQuestionWithAIMock).toHaveBeenCalledWith({
      userId: "user_default",
      uploadId: "day_2026-06-03",
      question: "这一天有什么重点？",
      scope: "current",
      segments: [segment],
      audioInsights: [audioInsight],
      semanticSegments: [semanticSegment],
      briefItems: [briefItem],
      relationshipSignals: [relationshipSignal],
      qaPromptInstruction: "场景可能是约会或亲密关系沟通。优先关注双方表达、互动节奏、边界、期待、没说清的地方和让人舒服或不舒服的细节；避免操控性建议，不做人格或心理诊断。",
      settingsStore: storeMock,
      conversation
    });
    expect(storeMock.write).not.toHaveBeenCalled();
    expect(storeMock.read).toHaveBeenCalledWith(
      "speaker-aliases",
      "upload_morning"
    );
    await expect(response.json()).resolves.toEqual({
      id: "answer_day_context",
      uploadId: "day_2026-06-03",
      question: "这一天有什么重点？",
      answer: "这一天上午确认上线节奏，晚间要补齐客户材料。[E1]",
      citedSegmentIds: ["seg_context_1"],
      createdAt: "2026-06-03T10:00:00.000Z"
    });
  });

  it("keeps context lexical input raw while giving Hybrid an aliased projection", async () => {
    storeMock.read.mockImplementation(async (collection, id) => {
      if (collection === "speaker-aliases" && id === "upload_alias_context") {
        return {
          aliases: { speaker_A: "小林" },
          updatedAt: "2026-06-03T09:00:00.000Z"
        };
      }
      return undefined;
    });
    answerQuestionWithAIMock.mockResolvedValueOnce({
      id: "answer_alias_context",
      uploadId: "day_2026-06-03",
      question: "是谁确认了安排？",
      answer: "小林确认了安排。[E1]",
      citedSegmentIds: ["seg_alias_context"],
      createdAt: "2026-06-03T10:00:00.000Z"
    });
    const segment = {
      id: "seg_alias_context",
      uploadId: "upload_alias_context",
      startSeconds: 10,
      endSeconds: 20,
      speaker: "speaker_A",
      text: "speaker_A 确认了安排。",
      confidence: 0.95,
      sceneLabels: ["product_discussion"],
      valueLabels: ["decision"]
    };
    const briefItem = {
      id: "brief_alias_context",
      uploadId: "upload_alias_context",
      category: "decision",
      title: "speaker_A 确认安排",
      body: "speaker_A 确认了安排。",
      priority: "high",
      confidence: 0.9,
      status: "confirmed",
      sourceSegmentIds: [segment.id],
      sourceTimeRange: { startSeconds: 10, endSeconds: 20 },
      transcriptExcerpt: "speaker_A 确认了安排。",
      people: ["speaker_A"],
      topics: ["安排"]
    };
    const request = new Request("http://localhost/api/days/context/qa", {
      method: "POST",
      body: JSON.stringify({
        uploadId: "day_2026-06-03",
        question: "是谁确认了安排？",
        segments: [segment],
        audioInsights: [],
        semanticSegments: [],
        briefItems: [briefItem],
        speakerAliasesByUploadId: {
          upload_alias_context: { speaker_A: "小林" }
        }
      }),
      headers: { "content-type": "application/json" }
    });

    const response = await postContextQa(request);

    expect(response.status).toBe(200);
    const qaInput = answerQuestionWithAIMock.mock.calls.at(-1)?.[0];
    expect(qaInput?.briefItems[0]?.title).toBe("speaker_A 确认安排");
    expect(qaInput?.hybridEvidenceInput?.briefItems[0]?.title).toBe("小林 确认安排");
    expect(qaInput?.hybridEvidenceInput?.briefItems[0]?.people).toEqual(["小林"]);
    expect(Object.keys(qaInput ?? {})).not.toContain("hybridEvidenceInput");
    expect(storeMock.read).not.toHaveBeenCalledWith(
      "speaker-aliases",
      "upload_alias_context"
    );
  });

  it("ignores malformed relationship signals in browser-provided context", async () => {
    answerQuestionWithAIMock.mockResolvedValueOnce({
      id: "answer_tolerant_context",
      uploadId: "day_2026-06-03",
      question: "What should I review?",
      answer: "Review the cited exchange. [E1]",
      citedSegmentIds: ["seg_tolerant_context"],
      createdAt: "2026-06-03T10:00:00.000Z"
    });
    const segment = {
      id: "seg_tolerant_context",
      uploadId: "upload_tolerant_context",
      startSeconds: 10,
      endSeconds: 20,
      speaker: "A",
      text: "We can confirm the plan tomorrow.",
      confidence: 0.95,
      sceneLabels: ["product_discussion"],
      valueLabels: ["decision"]
    };
    const validSignal = relationshipSignalFixture({
      uploadId: "upload_tolerant_context",
      segmentId: segment.id,
      date: "2026-06-03",
      startSeconds: 10,
      endSeconds: 20
    });
    const request = new Request("http://localhost/api/days/context/qa", {
      method: "POST",
      body: JSON.stringify({
        uploadId: "day_2026-06-03",
        question: "What should I review?",
        segments: [segment],
        audioInsights: [],
        semanticSegments: [],
        briefItems: [],
        relationshipSignals: [validSignal, { id: "broken_signal" }]
      }),
      headers: { "content-type": "application/json" }
    });

    const response = await postContextQa(request);

    expect(response.status).toBe(200);
    expect(answerQuestionWithAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        relationshipSignals: [validSignal]
      })
    );
  });

  it("passes browser-provided week context scope through to AI QA", async () => {
    const memoryContext = {
      scope: "week",
      memories: [],
      evidence: [],
      sourceIds: ["seg_week_context_1"],
      distinctDates: ["2026-06-10"],
      count: 1,
      retrievalTimeMs: 1
    };
    retrieveMemoryIndexEvidenceMock.mockReturnValueOnce(memoryContext);
    observeMemoryShadowRetrievalMock.mockImplementationOnce(() => {
      throw new Error("shadow observer unavailable");
    });
    const segment = {
      id: "seg_week_context_1",
      uploadId: "local_week",
      startSeconds: 0,
      endSeconds: 45,
      text: "[2026-06-10] 她说下周还可以再约。",
      confidence: 0.92,
      sceneLabels: ["self_reflection"],
      valueLabels: ["idea"]
    };
    const audioInsight = {
      id: "insight_week_context_1",
      uploadId: "local_week",
      sourceSegmentIds: ["seg_week_context_1"],
      sourceTimeRange: { startSeconds: 0, endSeconds: 45 },
      speaker: { id: "speaker_unknown", role: "unknown", confidence: 0.4 },
      voice: { pace: "normal", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.35 },
      toneLabels: ["playful"],
      emotionLabels: ["relaxed"],
      interactionLabels: ["rapport"],
      summary: "[2026-06-10] 互动氛围轻松。",
      evidence: "[2026-06-10] 她说下周还可以再约。",
      confidence: 0.58
    };
    const request = new Request("http://localhost/api/days/context/qa", {
      method: "POST",
      body: JSON.stringify({
        uploadId: "week_2026-06-08_2026-06-14",
        scope: "week",
        question: "这周互动氛围怎么样？",
        segments: [segment],
        audioInsights: [audioInsight],
        semanticSegments: [],
        briefItems: []
      }),
      headers: { "content-type": "application/json" }
    });

    const response = await postContextQa(request);

    expect(response.status).toBe(200);
    expect(answerQuestionWithAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadId: "week_2026-06-08_2026-06-14",
        question: "这周互动氛围怎么样？",
        scope: "week",
        segments: [segment],
        audioInsights: [audioInsight],
        memoryContext
      })
    );
    expect(retrieveMemoryIndexEvidenceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_default",
        scope: "week",
        dateRange: { startDate: "2026-06-08", endDate: "2026-06-14" }
      })
    );
    expect(observeMemoryShadowRetrievalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_default",
        scope: "week",
        query: "这周互动氛围怎么样？",
        dateRange: { startDate: "2026-06-08", endDate: "2026-06-14" },
        jsonEvidence: expect.any(Array),
        jsonRetrievalTimeMs: expect.any(Number)
      })
    );
  });

  it("keeps browser-provided week QA available when memory index retrieval fails", async () => {
    retrieveMemoryIndexEvidenceMock.mockImplementationOnce(() => {
      throw new Error("memory sqlite unavailable");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const request = new Request("http://localhost/api/days/context/qa", {
      method: "POST",
      body: JSON.stringify({
        uploadId: "week_2026-06-08_2026-06-14",
        scope: "week",
        question: "本周有哪些未解决的问题？",
        segments: [{
          id: "seg_week_failure_1",
          uploadId: "local_week",
          startSeconds: 0,
          endSeconds: 20,
          text: "[2026-06-10] 这个问题还需要确认。",
          confidence: 0.9,
          sceneLabels: ["unknown"],
          valueLabels: ["open_question"]
        }],
        audioInsights: [],
        semanticSegments: [],
        briefItems: []
      }),
      headers: { "content-type": "application/json" }
    });

    try {
      const response = await postContextQa(request);

      expect(response.status).toBe(200);
      expect(answerQuestionWithAIMock).toHaveBeenCalledWith(
        expect.objectContaining({ memoryIndexFallback: true })
      );
      expect(answerQuestionWithAIMock.mock.calls[0][0]).not.toHaveProperty("memoryContext");
    } finally {
      warning.mockRestore();
    }
  });

  it("answers week memory qa using only ready uploads from the current week", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    answerQuestionWithAIMock.mockResolvedValueOnce({
      id: "answer_week",
      uploadId: "week_20260601_20260607",
      question: "本周客户续费有什么进展？",
      answer: "本周需要继续跟进客户续费。[E1]",
      citedSegmentIds: ["upload_week_seg_1"],
      createdAt: "2026-06-04T12:01:00.000Z"
    });
    storeMock.list.mockResolvedValue([
      {
        id: "upload_week",
        value: {
          id: "upload_week",
          originalName: "week.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 100,
          recordingDate: "2026-06-02",
          status: "ready"
        }
      },
      {
        id: "upload_processing",
        value: {
          id: "upload_processing",
          originalName: "processing.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 100,
          recordingDate: "2026-06-03",
          status: "transcribing"
        }
      },
      {
        id: "upload_last_week",
        value: {
          id: "upload_last_week",
          originalName: "last-week.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 100,
          recordingDate: "2026-05-30",
          status: "ready"
        }
      }
    ]);
    storeMock.read.mockImplementation(async (collection: string, id: string) => {
      if (collection === "segments" && id === "upload_week") {
        return [{ id: "upload_week_seg_1", uploadId: "upload_week", text: "客户续费本周要继续跟进。" }];
      }
      if (collection === "audio-insights" && id === "upload_week") {
        return [
          {
            id: "insight_week",
            uploadId: "upload_week",
            sourceSegmentIds: ["upload_week_seg_1"],
            sourceTimeRange: { startSeconds: 20, endSeconds: 40 },
            speaker: { id: "speaker_1", role: "customer", confidence: 0.6 },
            voice: { pace: "normal", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.35 },
            toneLabels: ["hesitant"],
            emotionLabels: ["anxious"],
            interactionLabels: ["follow_up_question"],
            summary: "客户对续费预算有迟疑。",
            evidence: "原文提到续费需要继续跟进。",
            confidence: 0.7
          }
        ];
      }
      if (collection === "semantic-segments" && id === "upload_week") {
        return [{ id: "semantic_week", uploadId: "upload_week", title: "客户续费", summary: "讨论客户续费跟进。" }];
      }
      if (collection === "brief-items" && id === "upload_week") {
        return [{ id: "brief_week", uploadId: "upload_week", title: "跟进客户续费", body: "本周要推动续费。" }];
      }
      if (collection === "relationship-signals" && id === "upload_week") {
        return [relationshipSignalFixture({ uploadId: "upload_week", segmentId: "upload_week_seg_1", date: "2026-06-02" })];
      }
      if (collection === "answers-by-scope" && id === "week_20260601_20260607") {
        return [{ id: "answer_old" }];
      }
      return [];
    });
    const request = new Request("http://localhost/api/memory/week/qa", {
      method: "POST",
      body: JSON.stringify({ question: "本周客户续费有什么进展？" }),
      headers: { "content-type": "application/json" }
    });

    const response = await postWeekQa(request);

    expect(response.status).toBe(200);
    expect(answerQuestionWithAIMock).toHaveBeenCalledWith({
      userId: "user_default",
      uploadId: "week_20260601_20260607",
      question: "本周客户续费有什么进展？",
      scope: "week",
      segments: [expect.objectContaining({ id: "upload_week_seg_1", text: "[2026-06-02] 客户续费本周要继续跟进。" })],
      audioInsights: [expect.objectContaining({ id: "insight_week", summary: "[2026-06-02] 客户对续费预算有迟疑。" })],
      semanticSegments: [expect.objectContaining({ id: "semantic_week", title: "2026-06-02 · 客户续费" })],
      briefItems: [expect.objectContaining({ id: "brief_week", title: "2026-06-02 · 跟进客户续费" })],
      relationshipSignals: [
        expect.objectContaining({
          id: "relationship_signal_upload_week_1",
          uploadId: "upload_week",
          date: "2026-06-02"
        })
      ],
      settingsStore: storeMock
    });
    expect(storeMock.read).not.toHaveBeenCalledWith("segments", "upload_processing");
    expect(storeMock.read).not.toHaveBeenCalledWith("segments", "upload_last_week");
    expect(storeMock.write).toHaveBeenNthCalledWith(1, "answers", "answer_week", {
      id: "answer_week",
      uploadId: "week_20260601_20260607",
      question: "本周客户续费有什么进展？",
      answer: "本周需要继续跟进客户续费。[E1]",
      citedSegmentIds: ["upload_week_seg_1"],
      createdAt: "2026-06-04T12:01:00.000Z"
    });
    expect(storeMock.write).toHaveBeenNthCalledWith(2, "answers-by-scope", "week_20260601_20260607", [
      { id: "answer_old" },
      {
        id: "answer_week",
        uploadId: "week_20260601_20260607",
        question: "本周客户续费有什么进展？",
        answer: "本周需要继续跟进客户续费。[E1]",
        citedSegmentIds: ["upload_week_seg_1"],
        createdAt: "2026-06-04T12:01:00.000Z"
      }
    ]);
    expect(observeMemoryShadowRetrievalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_default",
        scope: "week",
        dateRange: { startDate: "2026-06-01", endDate: "2026-06-07" }
      })
    );
  });

  it("answers week memory qa using the week that contains the requested reference date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    answerQuestionWithAIMock.mockResolvedValueOnce({
      id: "answer_week_reference",
      uploadId: "week_20260525_20260531",
      question: "上周客户续费有什么进展？",
      answer: "上周需要继续跟进客户续费。[E1]",
      citedSegmentIds: ["upload_reference_week_seg_1"],
      createdAt: "2026-06-04T12:01:00.000Z"
    });
    storeMock.list.mockResolvedValue([
      {
        id: "upload_reference_week",
        value: {
          id: "upload_reference_week",
          originalName: "reference-week.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 100,
          recordingDate: "2026-05-27",
          status: "ready"
        }
      },
      {
        id: "upload_current_week",
        value: {
          id: "upload_current_week",
          originalName: "current-week.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 100,
          recordingDate: "2026-06-02",
          status: "ready"
        }
      }
    ]);
    storeMock.read.mockImplementation(async (collection: string, id: string) => {
      if (collection === "segments" && id === "upload_reference_week") {
        return [{ id: "upload_reference_week_seg_1", uploadId: "upload_reference_week", text: "上周客户续费要继续跟进。" }];
      }
      if (collection === "semantic-segments" && id === "upload_reference_week") {
        return [{ id: "semantic_reference_week", uploadId: "upload_reference_week", title: "客户续费", summary: "上周讨论客户续费。" }];
      }
      if (collection === "brief-items" && id === "upload_reference_week") {
        return [{ id: "brief_reference_week", uploadId: "upload_reference_week", title: "上周客户续费", body: "上周要推动续费。" }];
      }
      if (collection === "answers-by-scope" && id === "week_20260525_20260531") {
        return [];
      }
      return [];
    });
    const request = new Request("http://localhost/api/memory/week/qa?referenceDate=2026-05-30", {
      method: "POST",
      body: JSON.stringify({ question: "上周客户续费有什么进展？" }),
      headers: { "content-type": "application/json" }
    });

    const response = await postWeekQa(request);

    expect(response.status).toBe(200);
    expect(answerQuestionWithAIMock).toHaveBeenCalledWith({
      userId: "user_default",
      uploadId: "week_20260525_20260531",
      question: "上周客户续费有什么进展？",
      scope: "week",
      segments: [expect.objectContaining({ id: "upload_reference_week_seg_1", text: "[2026-05-27] 上周客户续费要继续跟进。" })],
      audioInsights: [],
      semanticSegments: [expect.objectContaining({ id: "semantic_reference_week", title: "2026-05-27 · 客户续费" })],
      briefItems: [expect.objectContaining({ id: "brief_reference_week", title: "2026-05-27 · 上周客户续费" })],
      relationshipSignals: [],
      settingsStore: storeMock
    });
    expect(storeMock.read).not.toHaveBeenCalledWith("segments", "upload_current_week");
  });

  it("loads week memory qa history for the requested reference date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    storeMock.read.mockImplementation(async (collection: string, id: string) => {
      if (collection === "answers-by-scope" && id === "week_20260525_20260531") {
        return [{ id: "answer_reference_week", question: "上周问题", answer: "上周回答", citedSegmentIds: [], createdAt: "2026-06-04T12:00:00.000Z" }];
      }
      if (collection === "answers-by-scope" && id === "week_20260601_20260607") {
        return [{ id: "answer_current_week", question: "本周问题", answer: "本周回答", citedSegmentIds: [], createdAt: "2026-06-04T12:01:00.000Z" }];
      }
      return null;
    });

    const response = await getWeekQaHistory(new Request("http://localhost/api/memory/week/qa?referenceDate=2026-05-30"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      answers: [{ id: "answer_reference_week", question: "上周问题", answer: "上周回答", citedSegmentIds: [], createdAt: "2026-06-04T12:00:00.000Z" }]
    });
  });

  it("answers all memory qa using every ready upload", async () => {
    answerQuestionWithAIMock.mockResolvedValueOnce({
      id: "answer_all",
      uploadId: "all_memory",
      question: "过去客户续费有什么进展？",
      answer: "过去所有录音显示客户续费需要继续跟进。[E1]",
      citedSegmentIds: ["upload_old_seg_1"],
      createdAt: "2026-06-04T12:01:00.000Z"
    });
    storeMock.list.mockResolvedValue([
      {
        id: "upload_old",
        value: {
          id: "upload_old",
          originalName: "old.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 100,
          recordingDate: "2026-05-20",
          status: "ready"
        }
      },
      {
        id: "upload_week",
        value: {
          id: "upload_week",
          originalName: "week.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 100,
          recordingDate: "2026-06-02",
          status: "ready"
        }
      },
      {
        id: "upload_processing",
        value: {
          id: "upload_processing",
          originalName: "processing.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 100,
          recordingDate: "2026-06-03",
          status: "transcribing"
        }
      }
    ]);
    storeMock.read.mockImplementation(async (collection: string, id: string) => {
      if (collection === "segments" && id === "upload_old") {
        return [{ id: "upload_old_seg_1", uploadId: "upload_old", text: "老客户续费要继续跟进。" }];
      }
      if (collection === "segments" && id === "upload_week") {
        return [{ id: "upload_week_seg_1", uploadId: "upload_week", text: "本周客户预算重新确认。" }];
      }
      if (collection === "semantic-segments" && id === "upload_old") {
        return [{ id: "semantic_old", uploadId: "upload_old", title: "老客户续费", summary: "讨论历史续费。" }];
      }
      if (collection === "semantic-segments" && id === "upload_week") {
        return [{ id: "semantic_week", uploadId: "upload_week", title: "客户预算", summary: "讨论本周预算。" }];
      }
      if (collection === "brief-items" && id === "upload_old") {
        return [{ id: "brief_old", uploadId: "upload_old", title: "跟进老客户续费", body: "历史录音提到继续跟进。" }];
      }
      if (collection === "brief-items" && id === "upload_week") {
        return [{ id: "brief_week", uploadId: "upload_week", title: "确认客户预算", body: "本周要重新确认预算。" }];
      }
      if (collection === "relationship-signals" && id === "upload_old") {
        return [relationshipSignalFixture({ uploadId: "upload_old", segmentId: "upload_old_seg_1", date: "2026-05-20" })];
      }
      if (collection === "relationship-signals" && id === "upload_week") {
        return [relationshipSignalFixture({ uploadId: "upload_week", segmentId: "upload_week_seg_1", date: "2026-06-02" })];
      }
      if (collection === "answers-by-scope" && id === "all_memory") {
        return [{ id: "answer_old" }];
      }
      return [];
    });
    const request = new Request("http://localhost/api/memory/all/qa", {
      method: "POST",
      body: JSON.stringify({ question: "过去客户续费有什么进展？" }),
      headers: { "content-type": "application/json" }
    });

    const response = await postAllQa(request);

    expect(response.status).toBe(200);
    expect(answerQuestionWithAIMock).toHaveBeenCalledWith({
      userId: "user_default",
      uploadId: "all_memory",
      question: "过去客户续费有什么进展？",
      scope: "all",
      segments: [
        expect.objectContaining({ id: "upload_old_seg_1", text: "[2026-05-20] 老客户续费要继续跟进。" }),
        expect.objectContaining({ id: "upload_week_seg_1", text: "[2026-06-02] 本周客户预算重新确认。" })
      ],
      audioInsights: [],
      semanticSegments: [
        expect.objectContaining({ id: "semantic_old", title: "2026-05-20 · 老客户续费" }),
        expect.objectContaining({ id: "semantic_week", title: "2026-06-02 · 客户预算" })
      ],
      briefItems: [
        expect.objectContaining({ id: "brief_old", title: "2026-05-20 · 跟进老客户续费" }),
        expect.objectContaining({ id: "brief_week", title: "2026-06-02 · 确认客户预算" })
      ],
      relationshipSignals: [
        expect.objectContaining({ id: "relationship_signal_upload_old_1", date: "2026-05-20" }),
        expect.objectContaining({ id: "relationship_signal_upload_week_1", date: "2026-06-02" })
      ],
      settingsStore: storeMock
    });
    expect(storeMock.read).not.toHaveBeenCalledWith("segments", "upload_processing");
    expect(storeMock.write).toHaveBeenNthCalledWith(1, "answers", "answer_all", {
      id: "answer_all",
      uploadId: "all_memory",
      question: "过去客户续费有什么进展？",
      answer: "过去所有录音显示客户续费需要继续跟进。[E1]",
      citedSegmentIds: ["upload_old_seg_1"],
      createdAt: "2026-06-04T12:01:00.000Z"
    });
    expect(storeMock.write).toHaveBeenNthCalledWith(2, "answers-by-scope", "all_memory", [
      { id: "answer_old" },
      {
        id: "answer_all",
        uploadId: "all_memory",
        question: "过去客户续费有什么进展？",
        answer: "过去所有录音显示客户续费需要继续跟进。[E1]",
        citedSegmentIds: ["upload_old_seg_1"],
        createdAt: "2026-06-04T12:01:00.000Z"
      }
    ]);
    expect(observeMemoryShadowRetrievalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_default",
        scope: "all",
        query: "过去客户续费有什么进展？"
      })
    );
  });

  it("returns 404 for week memory qa when this week has no ready uploads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T12:00:00.000Z"));
    storeMock.list.mockResolvedValue([
      {
        id: "upload_processing",
        value: {
          id: "upload_processing",
          originalName: "processing.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 100,
          recordingDate: "2026-06-03",
          status: "transcribing"
        }
      }
    ]);
    const request = new Request("http://localhost/api/memory/week/qa", {
      method: "POST",
      body: JSON.stringify({ question: "本周有什么要跟进？" }),
      headers: { "content-type": "application/json" }
    });

    const response = await postWeekQa(request);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "week_memory_not_found" });
    expect(answerQuestionWithAIMock).not.toHaveBeenCalled();
  });

  it("returns 404 for qa when upload does not exist", async () => {
    storeMock.read.mockResolvedValue(null);
    const request = new Request("http://localhost/api/days/upload_missing/qa", {
      method: "POST",
      body: JSON.stringify({ question: "What did I commit to?" }),
      headers: { "content-type": "application/json" }
    });

    const response = await postQa(request, {
      params: Promise.resolve({ uploadId: "upload_missing" })
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "upload_not_found" });
    expect(answerQuestionWithAIMock).not.toHaveBeenCalled();
    expect(storeMock.write).not.toHaveBeenCalled();
  });

  it("returns 409 before current-upload qa can run during permanent deletion", async () => {
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return { id: "upload_1", status: "ready" };
      }
      return null;
    });
    readHybridIndexDeletionMock.mockResolvedValue({ status: "pending" });

    const response = await postQa(
      new Request("http://localhost/api/days/upload_1/qa", {
        method: "POST",
        body: JSON.stringify({ question: "What did I commit to?" }),
        headers: { "content-type": "application/json" }
      }),
      { params: Promise.resolve({ uploadId: "upload_1" }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "upload_deletion_in_progress"
    });
    expect(answerQuestionWithAIMock).not.toHaveBeenCalled();
    expect(storeMock.write).not.toHaveBeenCalled();
  });

  it("removes a current-upload qa answer when deletion wins the persistence race", async () => {
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return { id: "upload_1", status: "ready" };
      }
      if (collection === "answers-by-upload") return [];
      return null;
    });
    readHybridIndexDeletionMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: "pending" });

    const response = await postQa(
      new Request("http://localhost/api/days/upload_1/qa", {
        method: "POST",
        body: JSON.stringify({ question: "What did I commit to?" }),
        headers: { "content-type": "application/json" }
      }),
      { params: Promise.resolve({ uploadId: "upload_1" }) }
    );

    expect(response.status).toBe(409);
    expect(answerQuestionWithAIMock).toHaveBeenCalledOnce();
    expect(storeMock.write).toHaveBeenCalledWith(
      "answers",
      "answer_1",
      expect.any(Object)
    );
    expect(storeMock.delete).toHaveBeenCalledWith("answers", "answer_1");
    expect(storeMock.delete).toHaveBeenCalledWith("answers-by-upload", "upload_1");
  });

  it("cleans up orphan answer if answers-by-upload write fails", async () => {
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return { id: "upload_1", status: "ready" };
      }
      if (collection === "segments") {
        return [{ id: "segment_1", text: "demo" }];
      }
      if (collection === "brief-items") {
        return [{ id: "brief_1" }];
      }
      if (collection === "answers-by-upload") {
        return [];
      }
      return null;
    });
    storeMock.write
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("index write failed"));
    storeMock.delete.mockResolvedValue(undefined);

    await expect(
      postQa(
        new Request("http://localhost/api/days/upload_1/qa", {
          method: "POST",
          body: JSON.stringify({ question: "What did I commit to?" }),
          headers: { "content-type": "application/json" }
        }),
        {
          params: Promise.resolve({ uploadId: "upload_1" })
        }
      )
    ).rejects.toThrow("index write failed");

    expect(storeMock.write).toHaveBeenNthCalledWith(1, "answers", "answer_1", {
      id: "answer_1",
      uploadId: "upload_1",
      question: "What did I commit to?",
      answer: "Answer",
      citedSegmentIds: ["segment_1"],
      createdAt: "2026-06-03T00:00:00.000Z"
    });
    expect(storeMock.write).toHaveBeenNthCalledWith(2, "answers-by-upload", "upload_1", [
      {
        id: "answer_1",
        uploadId: "upload_1",
        question: "What did I commit to?",
        answer: "Answer",
        citedSegmentIds: ["segment_1"],
        createdAt: "2026-06-03T00:00:00.000Z"
      }
    ]);
    expect(storeMock.delete).toHaveBeenCalledWith("answers", "answer_1");
  });

  it("does not answer qa before upload processing is ready", async () => {
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return { id: "upload_1", status: "transcribing" };
      }
      return null;
    });

    const response = await postQa(
      new Request("http://localhost/api/days/upload_1/qa", {
        method: "POST",
        body: JSON.stringify({ question: "今天我答应了谁什么？" }),
        headers: { "content-type": "application/json" }
      }),
      {
        params: Promise.resolve({ uploadId: "upload_1" })
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "upload_not_ready" });
    expect(answerQuestionWithAIMock).not.toHaveBeenCalled();
    expect(storeMock.write).not.toHaveBeenCalled();
  });

  it("returns 400 instead of leaking store key validation on invalid ids", async () => {
    const jobResponse = await getJob(new Request("http://localhost/api/jobs/../bad"), {
      params: Promise.resolve({ jobId: "../bad" })
    });
    const uploadDeleteResponse = await deleteUpload(new Request("http://localhost/api/uploads/../bad"), {
      params: Promise.resolve({ uploadId: "../bad" })
    });

    expect(jobResponse.status).toBe(400);
    await expect(jobResponse.json()).resolves.toEqual({ error: "invalid_job_id" });
    expect(uploadDeleteResponse.status).toBe(400);
    await expect(uploadDeleteResponse.json()).resolves.toEqual({ error: "invalid_upload_id" });
  });

  it("deletes upload file and related records", async () => {
    process.env.PIPELINE_EXECUTION_MODE = "queue";
    process.env.QA_HYBRID_RETRIEVAL_MODE = "shadow";
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return {
          id: "upload_1",
          originalName: "demo.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-06-03",
          status: "ready",
          filePath: join(testUploadsRootDir, "upload_1.m4a")
        };
      }
      if (collection === "jobs-by-upload") {
        return { id: "job_1", uploadId: "upload_1", status: "ready", progress: 100 };
      }
      if (collection === "answers-by-upload") {
        return [{ id: "answer_1" }, { id: "answer_2" }];
      }
      return null;
    });

    const response = await deleteUpload(new Request("http://localhost/api/uploads/upload_1"), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(200);
    expect(storeMock.write).toHaveBeenCalledWith("deleted-uploads", "upload_1", {
      uploadId: "upload_1",
      deletedAt: expect.any(String)
    });
    expect(rmMock).toHaveBeenCalledWith(join(testUploadsRootDir, "upload_1.m4a"), { force: true });
    expect(storeMock.delete).toHaveBeenCalledWith("jobs", "job_1");
    expect(storeMock.delete).toHaveBeenCalledWith("uploads", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("jobs-by-upload", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("segments", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("audio-insights", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("audio-insight-corrections", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("speaker-aliases", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("semantic-segments", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("brief-items", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("relationship-signals", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("relationship-lifecycle", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("speaker-identities", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("memory-owner-audits", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("proactive-insights", "current_upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("evaluation-reports", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("answers", "answer_1");
    expect(storeMock.delete).toHaveBeenCalledWith("answers", "answer_2");
    expect(storeMock.delete).toHaveBeenCalledWith("answers-by-upload", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith(
      "date-companion-audio-staging",
      "upload_1"
    );
    expect(storeMock.listIds).toHaveBeenCalledWith("analysis-chunks");
    expect(memoryRepositoryMock.deleteByUpload).toHaveBeenCalledWith("user_default", "upload_1");
    expect(enqueueEmbeddingIndexJobMock).toHaveBeenCalledWith({
      version: 1,
      userRef: "user_default",
      reason: "upload_deleted"
    });
    await expect(response.json()).resolves.toEqual({ deleted: true });
  });

  it("keeps source data until browser-cache Hybrid retention is fully indexed", async () => {
    process.env.PIPELINE_EXECUTION_MODE = "queue";
    process.env.HYBRID_INDEX_RETENTION_POLICY = "browser_cache";
    storeMock.read.mockImplementation(async (collection: string) =>
      collection === "uploads"
        ? {
            id: "upload_1",
            originalName: "demo.m4a",
            mimeType: "audio/mp4",
            sizeBytes: 12,
            recordingDate: "2026-06-03",
            status: "ready"
          }
        : null
    );
    prepareHybridIndexRetentionMock.mockResolvedValue({
      status: "pending",
      matched: 2,
      total: 3
    });

    const response = await deleteUpload(new Request(
      "http://localhost/api/uploads/upload_1",
      { headers: { "x-daily-brief-cleanup-mode": "browser-cache" } }
    ), { params: Promise.resolve({ uploadId: "upload_1" }) });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "hybrid_index_pending",
      retryable: true,
      matched: 2,
      total: 3
    });
    expect(enqueueEmbeddingIndexJobMock).toHaveBeenCalledWith({
      version: 1,
      userRef: "user_default",
      reason: "browser_cleanup"
    });
    expect(storeMock.write).not.toHaveBeenCalledWith(
      "deleted-uploads",
      expect.anything(),
      expect.anything()
    );
    expect(storeMock.delete).not.toHaveBeenCalledWith("uploads", "upload_1");
  });

  it("retains the prepared Hybrid snapshot during browser-cache cleanup", async () => {
    process.env.PIPELINE_EXECUTION_MODE = "queue";
    process.env.HYBRID_INDEX_RETENTION_POLICY = "browser_cache";
    storeMock.read.mockImplementation(async (collection: string) =>
      collection === "uploads"
        ? {
            id: "upload_1",
            originalName: "demo.m4a",
            mimeType: "audio/mp4",
            sizeBytes: 12,
            recordingDate: "2026-06-03",
            status: "ready"
          }
        : null
    );

    const response = await deleteUpload(new Request(
      "http://localhost/api/uploads/upload_1",
      { headers: { "x-daily-brief-cleanup-mode": "browser-cache" } }
    ), { params: Promise.resolve({ uploadId: "upload_1" }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deleted: true,
      hybridIndexRetained: true
    });
    expect(storeMock.delete).toHaveBeenCalledWith("uploads", "upload_1");
    expect(deleteHybridIndexDeletionMock).not.toHaveBeenCalled();
  });

  it("does not remove source data while permanent Hybrid deletion is pending", async () => {
    process.env.PIPELINE_EXECUTION_MODE = "queue";
    requiresHybridPermanentIndexDeletionMock.mockResolvedValue(true);
    requestHybridPermanentIndexDeletionMock.mockResolvedValue({ status: "pending" });
    storeMock.read.mockImplementation(async (collection: string) =>
      collection === "uploads"
        ? {
            id: "upload_1",
            originalName: "demo.m4a",
            mimeType: "audio/mp4",
            sizeBytes: 12,
            recordingDate: "2026-06-03",
            status: "ready"
          }
        : null
    );

    const response = await deleteUpload(
      new Request("http://localhost/api/uploads/upload_1"),
      { params: Promise.resolve({ uploadId: "upload_1" }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "hybrid_index_deletion_pending",
      retryable: true
    });
    expect(enqueueEmbeddingIndexJobMock).toHaveBeenCalledWith({
      version: 1,
      userRef: "user_default",
      reason: "permanent_delete"
    });
    expect(storeMock.write).not.toHaveBeenCalledWith(
      "deleted-uploads",
      expect.anything(),
      expect.anything()
    );
    expect(storeMock.delete).not.toHaveBeenCalledWith("uploads", "upload_1");
  });

  it("finalizes a completed Hybrid deletion even when the retention policy is off", async () => {
    process.env.PIPELINE_EXECUTION_MODE = "queue";
    requiresHybridPermanentIndexDeletionMock.mockResolvedValue(true);
    requestHybridPermanentIndexDeletionMock.mockResolvedValue({ status: "completed" });
    storeMock.read.mockImplementation(async (collection: string) =>
      collection === "uploads"
        ? {
            id: "upload_1",
            originalName: "demo.m4a",
            mimeType: "audio/mp4",
            sizeBytes: 12,
            recordingDate: "2026-06-03",
            status: "ready"
          }
        : null
    );

    const response = await deleteUpload(
      new Request("http://localhost/api/uploads/upload_1"),
      { params: Promise.resolve({ uploadId: "upload_1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deleted: true,
      hybridIndexDeleted: true
    });
    expect(storeMock.delete).toHaveBeenCalledWith("uploads", "upload_1");
    expect(deleteHybridIndexDeletionMock).toHaveBeenCalledWith(
      storeMock,
      "upload_1"
    );
  });

  it("blocks permanent Hybrid cleanup before source deletion when Queue is unavailable", async () => {
    requiresHybridPermanentIndexDeletionMock.mockResolvedValue(true);
    storeMock.read.mockResolvedValue({
      id: "upload_1",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 12,
      recordingDate: "2026-06-03",
      status: "ready"
    });

    const response = await deleteUpload(
      new Request("http://localhost/api/uploads/upload_1"),
      { params: Promise.resolve({ uploadId: "upload_1" }) }
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "hybrid_index_queue_required",
      retryable: true
    });
    expect(requestHybridPermanentIndexDeletionMock).not.toHaveBeenCalled();
    expect(storeMock.delete).not.toHaveBeenCalled();
  });

  it("does not clean a marked date-companion upload before its SQLite import exists", async () => {
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return {
          id: "upload_1",
          originalName: "date.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-06-03",
          status: "ready",
          dateCompanionAudioSnapshotVersion: 1
        };
      }
      return null;
    });

    const response = await deleteUpload(new Request(
      "http://localhost/api/uploads/upload_1",
      {
        method: "DELETE",
        headers: { "x-daily-brief-cleanup-mode": "browser-cache" }
      }
    ), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(409);
    expect(storeMock.write).not.toHaveBeenCalledWith(
      "deleted-uploads",
      "upload_1",
      expect.anything()
    );
    expect(storeMock.delete).not.toHaveBeenCalledWith(
      "date-companion-audio-staging",
      "upload_1"
    );
    await expect(response.json()).resolves.toEqual({
      error: "date_companion_import_required",
      retryable: true
    });
  });

  it("marks an imported relationship snapshot after browser-cache parent cleanup", async () => {
    dateCompanionRepositoryMock.getInteractionVersionByUpload.mockReturnValue({
      interactionId: "interaction_1",
      version: 3
    });
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return {
          id: "upload_1",
          originalName: "demo.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-06-03",
          status: "ready"
        };
      }
      return null;
    });

    const response = await deleteUpload(new Request(
      "http://localhost/api/uploads/upload_1",
      {
        method: "DELETE",
        headers: { "x-daily-brief-cleanup-mode": "browser-cache" }
      }
    ), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(200);
    expect(dateCompanionRepositoryMock.markUploadSourceState).toHaveBeenCalledWith(
      "user_default",
      "upload_1",
      "server_cleaned"
    );
    expect(dateCompanionRepositoryMock.deleteInteractionByUpload).not.toHaveBeenCalled();
    expect(storeMock.delete).toHaveBeenCalledWith(
      "date-companion-audio-staging",
      "upload_1"
    );
    const parentDeleteIndex = storeMock.delete.mock.calls.findIndex(
      ([collection, id]) => collection === "uploads" && id === "upload_1"
    );
    expect(parentDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(storeMock.delete.mock.invocationCallOrder[parentDeleteIndex]).toBeLessThan(
      dateCompanionRepositoryMock.markUploadSourceState.mock.invocationCallOrder[0]
    );
    await expect(response.json()).resolves.toEqual({
      deleted: true,
      relationshipSnapshotRetained: true
    });
  });

  it("keeps browser-cache cleanup idempotent after the upload parent is gone", async () => {
    storeMock.read.mockResolvedValue(null);
    dateCompanionRepositoryMock.getInteractionVersionByUpload.mockReturnValue({
      interactionId: "interaction_1",
      version: 3
    });

    const response = await deleteUpload(new Request(
      "http://localhost/api/uploads/upload_1",
      {
        method: "DELETE",
        headers: { "x-daily-brief-cleanup-mode": "browser-cache" }
      }
    ), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(200);
    expect(dateCompanionRepositoryMock.markUploadSourceState).toHaveBeenCalledWith(
      "user_default",
      "upload_1",
      "server_cleaned"
    );
    await expect(response.json()).resolves.toMatchObject({
      deleted: true,
      uploadAlreadyDeleted: true,
      relationshipSnapshotRetained: true
    });
  });

  it("removes an imported relationship interaction on explicit upload deletion", async () => {
    dateCompanionRepositoryMock.getInteractionVersionByUpload.mockReturnValue({
      interactionId: "interaction_1",
      version: 3
    });
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return {
          id: "upload_1",
          originalName: "demo.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-06-03",
          status: "ready"
        };
      }
      return null;
    });

    const response = await deleteUpload(new Request("http://localhost/api/uploads/upload_1", {
      method: "DELETE",
      headers: {
        "x-date-companion-interaction-id": "interaction_1",
        "if-match": "\"3\""
      }
    }), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(200);
    expect(dateCompanionRepositoryMock.prepareInteractionDeletion).toHaveBeenCalledWith(
      "user_default",
      "interaction_1",
      3
    );
    expect(dateCompanionRepositoryMock.deleteInteractionByUpload).toHaveBeenCalledWith(
      "user_default",
      "upload_1",
      "interaction_1",
      3
    );
    const parentDeleteIndex = storeMock.delete.mock.calls.findIndex(
      ([collection, id]) => collection === "uploads" && id === "upload_1"
    );
    expect(parentDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(dateCompanionRepositoryMock.prepareInteractionDeletion.mock.invocationCallOrder[0]).toBeLessThan(
      storeMock.delete.mock.invocationCallOrder[parentDeleteIndex]
    );
    expect(storeMock.delete.mock.invocationCallOrder[parentDeleteIndex]).toBeLessThan(
      dateCompanionRepositoryMock.deleteInteractionByUpload.mock.invocationCallOrder[0]
    );
    await expect(response.json()).resolves.toMatchObject({
      deleted: true,
      relationshipInteractionDeleted: true
    });
  });

  it("requires an interaction version before any explicit source cleanup", async () => {
    dateCompanionRepositoryMock.getInteractionVersionByUpload.mockReturnValue({
      interactionId: "interaction_1",
      version: 3
    });
    storeMock.read.mockImplementation(async (collection: string) =>
      collection === "uploads"
        ? {
          id: "upload_1",
          originalName: "demo.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-06-03",
          status: "ready"
        }
        : null
    );

    const response = await deleteUpload(
      new Request("http://localhost/api/uploads/upload_1", { method: "DELETE" }),
      { params: Promise.resolve({ uploadId: "upload_1" }) }
    );

    expect(response.status).toBe(428);
    await expect(response.json()).resolves.toEqual({
      error: "interaction_version_required",
      requiredHeaders: ["x-date-companion-interaction-id", "if-match"]
    });
    expect(storeMock.write).not.toHaveBeenCalled();
    expect(storeMock.delete).not.toHaveBeenCalled();
    expect(dateCompanionRepositoryMock.deleteInteractionByUpload).not.toHaveBeenCalled();
  });

  it("blocks explicit upload cleanup while voice enrollment is processing", async () => {
    dateCompanionRepositoryMock.getInteractionVersionByUpload.mockReturnValue({
      interactionId: "interaction_1",
      version: 3
    });
    dateCompanionRepositoryMock.prepareInteractionDeletion.mockImplementation(() => {
      throw new DcConflictError("voice_enrollment_in_progress");
    });
    storeMock.read.mockImplementation(async (collection: string) =>
      collection === "uploads"
        ? {
          id: "upload_1",
          originalName: "demo.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-06-03",
          status: "ready"
        }
        : null
    );

    const response = await deleteUpload(new Request(
      "http://localhost/api/uploads/upload_1",
      {
        method: "DELETE",
        headers: {
          "x-date-companion-interaction-id": "interaction_1",
          "if-match": "3"
        }
      }
    ), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "voice_enrollment_in_progress" });
    expect(storeMock.write).not.toHaveBeenCalled();
    expect(storeMock.delete).not.toHaveBeenCalled();
    expect(dateCompanionRepositoryMock.deleteInteractionByUpload).not.toHaveBeenCalled();
  });

  it("rejects a stale explicit source delete before touching JsonStore", async () => {
    dateCompanionRepositoryMock.getInteractionVersionByUpload.mockReturnValue({
      interactionId: "interaction_1",
      version: 4
    });
    storeMock.read.mockImplementation(async (collection: string) =>
      collection === "uploads"
        ? {
          id: "upload_1",
          originalName: "demo.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-06-03",
          status: "ready"
        }
        : null
    );

    const response = await deleteUpload(new Request(
      "http://localhost/api/uploads/upload_1",
      {
        method: "DELETE",
        headers: {
          "x-date-companion-interaction-id": "interaction_1",
          "if-match": "\"3\""
        }
      }
    ), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "version_conflict",
      currentVersion: 4
    });
    expect(storeMock.write).not.toHaveBeenCalled();
    expect(storeMock.delete).not.toHaveBeenCalled();
  });

  it("finishes a versioned relationship delete after the JsonStore parent is already gone", async () => {
    storeMock.read.mockResolvedValue(null);
    dateCompanionRepositoryMock.getInteractionVersionByUpload.mockReturnValue({
      interactionId: "interaction_1",
      version: 4
    });

    const response = await deleteUpload(new Request(
      "http://localhost/api/uploads/upload_1",
      {
        method: "DELETE",
        headers: {
          "x-date-companion-interaction-id": "interaction_1",
          "if-match": "4"
        }
      }
    ), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(200);
    expect(dateCompanionRepositoryMock.deleteInteractionByUpload).toHaveBeenCalledWith(
      "user_default",
      "upload_1",
      "interaction_1",
      4
    );
    await expect(response.json()).resolves.toEqual({
      deleted: true,
      uploadAlreadyDeleted: true,
      relationshipInteractionDeleted: true
    });
  });

  it("maps a concurrent relationship source change to a conflict response", async () => {
    dateCompanionRepositoryMock.getInteractionVersionByUpload.mockReturnValue({
      interactionId: "interaction_1",
      version: 4
    });
    dateCompanionRepositoryMock.deleteInteractionByUpload.mockImplementation(() => {
      throw new DcConflictError("interaction_source_mismatch");
    });
    storeMock.read.mockImplementation(async (collection: string) =>
      collection === "uploads"
        ? {
          id: "upload_1",
          originalName: "demo.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-06-03",
          status: "ready"
        }
        : null
    );

    const response = await deleteUpload(new Request(
      "http://localhost/api/uploads/upload_1",
      {
        method: "DELETE",
        headers: {
          "x-date-companion-interaction-id": "interaction_1",
          "if-match": "4"
        }
      }
    ), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "interaction_source_mismatch"
    });
  });

  it("retries the SQLite cascade after JsonStore deletion without losing relationship evidence first", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let parentAvailable = true;
    dateCompanionRepositoryMock.getInteractionVersionByUpload.mockReturnValue({
      interactionId: "interaction_1",
      version: 4
    });
    dateCompanionRepositoryMock.deleteInteractionByUpload
      .mockImplementationOnce(() => {
        throw new Error("sqlite busy");
      })
      .mockReturnValueOnce(true);
    storeMock.read.mockImplementation(async (collection: string) =>
      collection === "uploads" && parentAvailable
        ? {
          id: "upload_1",
          originalName: "demo.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-06-03",
          status: "ready"
        }
        : null
    );
    storeMock.delete.mockImplementation(async (collection: string, id: string) => {
      if (collection === "uploads" && id === "upload_1") parentAvailable = false;
    });
    const request = () => new Request("http://localhost/api/uploads/upload_1", {
      method: "DELETE",
      headers: {
        "x-date-companion-interaction-id": "interaction_1",
        "if-match": "4"
      }
    });

    const first = await deleteUpload(request(), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });
    expect(first.status).toBe(500);
    expect(parentAvailable).toBe(false);
    expect(dateCompanionRepositoryMock.deleteInteractionByUpload).toHaveBeenCalledTimes(1);

    const second = await deleteUpload(request(), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });
    expect(second.status).toBe(200);
    expect(dateCompanionRepositoryMock.deleteInteractionByUpload).toHaveBeenCalledTimes(2);
    await expect(second.json()).resolves.toMatchObject({
      deleted: true,
      uploadAlreadyDeleted: true,
      relationshipInteractionDeleted: true
    });
    consoleError.mockRestore();
  });

  it("retains upload, checkpoints and memory when evaluation cleanup is unconfirmed", async () => {
    process.env.EVALUATION_MODE = "true";
    dateCompanionRepositoryMock.getInteractionVersionByUpload.mockReturnValue({
      interactionId: "interaction_1",
      version: 3
    });
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return {
          id: "upload_1",
          originalName: "evaluation.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-07-16",
          status: "ready",
          evaluationRetention: true,
          filePath: join(testUploadsRootDir, "upload_1.m4a")
        };
      }
      return null;
    });

    const response = await deleteUpload(new Request("http://localhost/api/uploads/upload_1", {
      method: "DELETE"
    }), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "evaluation_retention_active",
      retained: true,
      confirmationHeader: "x-evaluation-delete-confirmed"
    });
    expect(storeMock.write).not.toHaveBeenCalledWith("deleted-uploads", expect.anything(), expect.anything());
    expect(storeMock.delete).not.toHaveBeenCalled();
    expect(storeMock.listIds).not.toHaveBeenCalledWith("analysis-chunks");
    expect(memoryRepositoryMock.deleteByUpload).not.toHaveBeenCalled();
    expect(rmMock).not.toHaveBeenCalled();
  });

  it("does not change cleanup for an unmarked upload when evaluation mode is enabled", async () => {
    process.env.EVALUATION_MODE = "true";
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return {
          id: "upload_1",
          originalName: "ordinary.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-07-16",
          status: "ready"
        };
      }
      return null;
    });

    const response = await deleteUpload(new Request("http://localhost/api/uploads/upload_1", {
      method: "DELETE"
    }), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(200);
    expect(storeMock.delete).toHaveBeenCalledWith("uploads", "upload_1");
    expect(memoryRepositoryMock.deleteByUpload).toHaveBeenCalledWith("user_default", "upload_1");
  });

  it("allows an explicitly confirmed user delete during evaluation", async () => {
    process.env.EVALUATION_MODE = "true";
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return {
          id: "upload_1",
          originalName: "evaluation.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-07-16",
          status: "ready",
          evaluationRetention: true
        };
      }
      return null;
    });

    const response = await deleteUpload(new Request("http://localhost/api/uploads/upload_1", {
      method: "DELETE",
      headers: { "x-evaluation-delete-confirmed": "true" }
    }), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(200);
    expect(storeMock.write).toHaveBeenCalledWith("deleted-uploads", "upload_1", {
      uploadId: "upload_1",
      deletedAt: expect.any(String)
    });
    expect(storeMock.delete).toHaveBeenCalledWith("uploads", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("evaluation-reports", "upload_1");
    expect(memoryRepositoryMock.deleteByUpload).toHaveBeenCalledWith("user_default", "upload_1");
    expect(deleteProviderRawResponseCapturesMock).toHaveBeenCalledWith("upload_1");
  });

  it("keeps the parent upload retryable when child cleanup fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return {
          id: "upload_1",
          originalName: "retryable.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-07-16",
          status: "ready"
        };
      }
      return null;
    });
    memoryRepositoryMock.deleteByUpload
      .mockImplementationOnce(() => {
        throw new Error("sqlite busy");
      })
      .mockReturnValue(undefined);

    const first = await deleteUpload(new Request("http://localhost/api/uploads/upload_1", {
      method: "DELETE"
    }), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(first.status).toBe(500);
    await expect(first.json()).resolves.toEqual({
      error: "upload_cleanup_failed",
      deleted: false,
      retryable: true
    });
    expect(storeMock.delete).not.toHaveBeenCalledWith("uploads", "upload_1");

    const second = await deleteUpload(new Request("http://localhost/api/uploads/upload_1", {
      method: "DELETE"
    }), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(second.status).toBe(200);
    expect(storeMock.delete).toHaveBeenCalledWith("uploads", "upload_1");
    consoleError.mockRestore();
  });

  it("skips invalid child ids during delete and continues parent cleanup", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    storeMock.read.mockImplementation(async (collection: string) => {
      if (collection === "uploads") {
        return {
          id: "upload_1",
          originalName: "demo.m4a",
          mimeType: "audio/mp4",
          sizeBytes: 12,
          recordingDate: "2026-06-03",
          status: "ready",
          filePath: ".data/uploads/upload_1.m4a"
        };
      }
      if (collection === "jobs-by-upload") {
        return { id: 123, uploadId: "upload_1", status: "ready", progress: 100 };
      }
      if (collection === "answers-by-upload") {
        return [{ id: true }, { id: undefined }, { id: "good_answer" }];
      }
      return null;
    });

    const response = await deleteUpload(new Request("http://localhost/api/uploads/upload_1"), {
      params: Promise.resolve({ uploadId: "upload_1" })
    });

    expect(response.status).toBe(200);
    expect(storeMock.write).toHaveBeenCalledWith("deleted-uploads", "upload_1", {
      uploadId: "upload_1",
      deletedAt: expect.any(String)
    });
    expect(storeMock.delete).not.toHaveBeenCalledWith("jobs", 123);
    expect(storeMock.delete).toHaveBeenCalledWith("answers", "good_answer");
    expect(storeMock.delete).not.toHaveBeenCalledWith("answers", true);
    expect(storeMock.delete).not.toHaveBeenCalledWith("answers", undefined);
    expect(storeMock.delete).toHaveBeenCalledWith("uploads", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("jobs-by-upload", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("segments", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("audio-insights", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("semantic-segments", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("brief-items", "upload_1");
    expect(storeMock.delete).toHaveBeenCalledWith("answers-by-upload", "upload_1");
    expect(warnSpy).toHaveBeenCalledTimes(3);
    await expect(response.json()).resolves.toEqual({ deleted: true });
  });
});
