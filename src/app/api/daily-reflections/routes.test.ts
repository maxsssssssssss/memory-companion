import type Database from "better-sqlite3";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DailyReflectionDetailResponseSchema,
  DailyReflectionHistoryResponseSchema
} from "@/lib/domain/daily-reflection-api";
import { DailyReflectionDurationPolicyError } from "@/lib/domain/daily-reflection-duration";
import type { AuthContext } from "@/lib/server/auth/request-context";
import { cleanupDailyReflectionStagingAssets } from "@/lib/server/daily-reflection/cleanup";
import { openDailyReflectionDatabase } from "@/lib/server/daily-reflection/db";
import { DailyReflectionRepository } from "@/lib/server/daily-reflection/repository";
import { DailyReflectionService } from "@/lib/server/daily-reflection/service";
import { DailyReflectionDurationProbeError } from "@/lib/server/daily-reflection/duration-resolver";
import { recoverDailyReflectionJobs } from "@/lib/server/queue/daily-reflection-recovery";
import { JsonStore } from "@/lib/server/storage/json-store";

const moduleState = vi.hoisted(() => ({
  repository: null as unknown,
  authContext: null as unknown,
  personRepository: null as unknown,
  candidateRevocationService: null as unknown
}));
const afterMock = vi.hoisted(() => vi.fn());
const enqueueDailyReflectionJobMock = vi.hoisted(() => vi.fn());
const processDailyReflectionUploadMock = vi.hoisted(() => vi.fn());
const resolveDailyReflectionAuthoritativeDurationMock = vi.hoisted(() => vi.fn());
const deleteMemoryUploadAndRefreshIndexMock = vi.hoisted(() => vi.fn());
const admitDailyReflectionUnderLeaseMock = vi.hoisted(() => vi.fn());
const uploadStorageState = vi.hoisted(() => ({
  failBeforePersist: false,
  failAfterPersist: false,
  crashAfterRawWrite: false,
  captureBeforePersist: false,
  crashedFilePath: null as string | null,
  capturedProvisional: null as unknown
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: afterMock
}));

vi.mock("@/lib/server/auth/request-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/auth/request-context")>()),
  requireAuthContext: vi.fn(async () => moduleState.authContext as AuthContext)
}));

vi.mock("@/lib/server/daily-reflection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/daily-reflection")>()),
  getDailyReflectionRepository: () => moduleState.repository as DailyReflectionRepository,
  getDailyReflectionMemoryAdmissionService: () => ({
    admitUnderLease: admitDailyReflectionUnderLeaseMock
  }),
  getDailyReflectionCandidateRevocationService: () =>
    moduleState.candidateRevocationService as { revoke(input: unknown): Promise<unknown> },
  processDailyReflectionUpload: processDailyReflectionUploadMock,
  resolveDailyReflectionAuthoritativeDuration:
    resolveDailyReflectionAuthoritativeDurationMock
}));

vi.mock("@/lib/server/person", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/person")>()),
  getPersonRepository: () => moduleState.personRepository as {
    getConfirmedPerson(accountId: string, personId: string): unknown;
  }
}));

vi.mock("@/lib/server/memory/upload-deletion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/memory/upload-deletion")>()),
  deleteMemoryUploadAndRefreshIndex: deleteMemoryUploadAndRefreshIndexMock
}));

vi.mock("@/lib/server/queue/producer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/queue/producer")>()),
  enqueueDailyReflectionJob: enqueueDailyReflectionJobMock
}));

vi.mock("@/lib/server/uploads/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/uploads/storage")>();
  return {
    ...actual,
    persistAudioUpload: vi.fn(async (
      input: Parameters<typeof actual.persistAudioUpload>[0]
    ) => {
      if (uploadStorageState.failBeforePersist) {
        uploadStorageState.failBeforePersist = false;
        throw new actual.AudioUploadPersistenceError("", {
          cause: new Error("simulated pre-persist storage failure")
        });
      }
      if (uploadStorageState.captureBeforePersist) {
        uploadStorageState.captureBeforePersist = false;
        const reflectionId = (input.extra as { reflectionId?: string } | undefined)
          ?.reflectionId;
        const authContext = moduleState.authContext as AuthContext;
        const currentRepository = moduleState.repository as DailyReflectionRepository;
        uploadStorageState.capturedProvisional = reflectionId
          ? {
              ownership: currentRepository.getProvisionalUploadOwnership(
                authContext.user.id,
                reflectionId
              ),
              processingPlan: currentRepository.getProcessingPlan(
                authContext.user.id,
                reflectionId
              )
            }
          : null;
      }
      if (uploadStorageState.crashAfterRawWrite) {
        uploadStorageState.crashAfterRawWrite = false;
        await mkdir(input.uploadDir, { recursive: true });
        const filePath = join(
          input.uploadDir,
          `${input.uploadId}.${input.attemptSuffix ?? "attempt-unknown"}.wav`
        );
        await writeFile(filePath, new Uint8Array(await input.file.arrayBuffer()));
        uploadStorageState.crashedFilePath = filePath;
        throw new Error("simulated process termination after raw audio write");
      }
      const persisted = await actual.persistAudioUpload(input);
      if (uploadStorageState.failAfterPersist) {
        uploadStorageState.failAfterPersist = false;
        throw new Error("simulated raw persist failure with sensitive detail");
      }
      return persisted;
    })
  };
});

import {
  GET as listDailyReflections,
  POST as postDailyReflection
} from "./route";
import {
  DELETE as deleteDailyReflection,
  GET as getDailyReflection
} from "./[reflectionId]/route";
import { POST as cancelDailyReflection } from "./[reflectionId]/cancel/route";
import { PATCH as updateDailyReflectionCandidates } from
  "./[reflectionId]/candidates/route";
import { POST as finalizeDailyReflection } from "./[reflectionId]/finalize/route";
import { POST as revokeDailyReflectionCandidate } from
  "./[reflectionId]/candidates/[candidateId]/revoke/route";
import { POST as retryDailyReflection } from "./[reflectionId]/retry/route";

const accountId = "account_daily_reflection_api";
const otherAccountId = "account_daily_reflection_other";
const originalFeatureFlag = process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
const originalBrowserRecordingFlag =
  process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED;
const originalToySyncFlag = process.env.DAILY_REFLECTION_TOY_SYNC_ENABLED;
const originalSharedToySyncFlag = process.env.DAILY_BRIEF_TOY_SYNC_ENABLED;
const originalExecutionMode = process.env.PIPELINE_EXECUTION_MODE;

let database: Database.Database;
let repository: DailyReflectionRepository;
let store: JsonStore;
let rootDir: string;
let uploadsRootDir: string;
let generatedId: number;

function setAccount(id: string) {
  moduleState.authContext = {
    user: { id, email: `${id}@example.com` },
    store,
    dataRootDir: rootDir,
    uploadsRootDir
  } satisfies AuthContext;
}

function postRequest(input: {
  idempotencyKey: string;
  sourceOrigin?: string | null;
  inputMethod?: string;
  inputAdapter?: string;
  clientReportedDurationMs?: string;
  processingProfile?: string;
  bytes?: Uint8Array;
}) {
  const form = new FormData();
  const bytes = input.bytes ?? new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
  const fileBuffer = Uint8Array.from(bytes).buffer;
  const file = new File(
    [fileBuffer],
    "reflection.wav",
    { type: "audio/wav" }
  );
  Object.defineProperty(file, "arrayBuffer", {
    value: vi.fn().mockResolvedValue(fileBuffer)
  });
  form.set("file", file);
  form.set("recordingDate", "2026-08-13");
  if (input.sourceOrigin !== null) {
    form.set("sourceOrigin", input.sourceOrigin ?? "user_reflection");
  }
  if (input.inputMethod !== undefined) {
    form.set("inputMethod", input.inputMethod);
  }
  if (input.inputAdapter !== undefined) {
    form.set("inputAdapter", input.inputAdapter);
  }
  if (input.clientReportedDurationMs !== undefined) {
    form.set("clientReportedDurationMs", input.clientReportedDurationMs);
  }
  if (input.processingProfile !== undefined) {
    form.set("processingProfile", input.processingProfile);
  }
  form.set("idempotencyKey", input.idempotencyKey);
  return {
    formData: vi.fn().mockResolvedValue(form)
  } as unknown as Request;
}

function params(reflectionId: string) {
  return { params: Promise.resolve({ reflectionId }) };
}

function candidateParams(reflectionId: string, candidateId: string) {
  return { params: Promise.resolve({ reflectionId, candidateId }) };
}

function segment(uploadId: string, id = "segment_api_1") {
  return {
    id,
    uploadId,
    startSeconds: 0,
    endSeconds: 8,
    text: "A canonical reflection segment.",
    confidence: 0.96,
    sceneLabels: [],
    valueLabels: []
  };
}

function uploadRecord(input: {
  reflectionId: string;
  uploadId: string;
  originalName?: string;
}) {
  return {
    id: input.uploadId,
    originalName: input.originalName ?? "reflection.wav",
    mimeType: "audio/wav",
    sizeBytes: 2048,
    recordingDate: "2026-08-13",
    createdAt: "2026-08-13T08:00:00.000Z",
    durationSeconds: 16,
    status: "ready" as const,
    filePath: join(uploadsRootDir, `${input.uploadId}.wav`),
    ingestionContext: "daily_reflection" as const,
    reflectionId: input.reflectionId,
    uploadFingerprint: "a".repeat(64),
    persistenceAttemptVersion: 7
  };
}

function createReviewPendingDetail(input: {
  reflectionId: string;
  uploadId: string;
  sourceSegmentId: string;
  publishCanonical?: boolean;
}) {
  const service = new DailyReflectionService(repository);
  const created = service.createReflection({
    id: input.reflectionId,
    accountId,
    uploadId: input.uploadId,
    inputMethod: "file_upload",
    sourceOrigin: "user_reflection",
    processingProfile: "full_recording",
    ingestionContext: "daily_reflection",
    idempotencyKey: `detail-${input.reflectionId}`
  }).reflection;
  const uploading = service.updateStatus({
    accountId,
    reflectionId: input.reflectionId,
    expectedVersion: created.version,
    status: "uploading"
  });
  const transcribing = service.updateStatus({
    accountId,
    reflectionId: input.reflectionId,
    expectedVersion: uploading.version,
    status: "transcribing"
  });
  const extracting = service.updateStatus({
    accountId,
    reflectionId: input.reflectionId,
    expectedVersion: transcribing.version,
    status: "extracting"
  });
  const fence = input.publishCanonical === false
    ? null
    : repository.claimExecutionLease({
        accountId,
        reflectionId: input.reflectionId,
        leaseOwner: `review-fixture:${input.reflectionId}`,
        leaseDurationMs: 60_000,
        allowedStatuses: ["extracting"]
      });
  if (input.publishCanonical !== false && !fence) {
    throw new Error("expected review fixture publication fence");
  }
  if (fence) {
    repository.publishAssetUnderExecutionFence({
      accountId,
      reflectionId: input.reflectionId,
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion,
      assetKind: "upload",
      payload: uploadRecord({ reflectionId: input.reflectionId, uploadId: input.uploadId })
    });
    repository.publishAssetUnderExecutionFence({
      accountId,
      reflectionId: input.reflectionId,
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion,
      assetKind: "segments",
      payload: [segment(input.uploadId, input.sourceSegmentId)]
    });
  }
  const stored = repository.savePendingCandidates({
    accountId,
    reflectionId: input.reflectionId,
    expectedVersion: extracting.version,
    ...(fence ? {
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion
    } : {}),
    candidates: [{
      ordinal: 0,
      proposedText: "Candidate requiring canonical evidence.",
      candidateType: "summary",
      sourceSegmentIds: [input.sourceSegmentId]
    }]
  });
  service.updateStatus({
    accountId,
    reflectionId: input.reflectionId,
    expectedVersion: stored.reflection.version,
    status: "review_pending",
    ...(fence ? {
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion
    } : {})
  });
}

function createFailedReflection(input: {
  reflectionId: string;
  uploadId: string;
  idempotencyKey: string;
}) {
  const service = new DailyReflectionService(repository);
  const created = service.createReflection({
    id: input.reflectionId,
    accountId,
    uploadId: input.uploadId,
    inputMethod: "file_upload",
    sourceOrigin: "user_reflection",
    processingProfile: "full_recording",
    ingestionContext: "daily_reflection",
    idempotencyKey: input.idempotencyKey
  }).reflection;
  const uploading = service.updateStatus({
    accountId,
    reflectionId: input.reflectionId,
    expectedVersion: created.version,
    status: "uploading"
  });
  const transcribing = service.updateStatus({
    accountId,
    reflectionId: input.reflectionId,
    expectedVersion: uploading.version,
    status: "transcribing"
  });
  return service.updateStatus({
    accountId,
    reflectionId: input.reflectionId,
    expectedVersion: transcribing.version,
    status: "failed",
    errorCode: "daily_reflection_transcription_failed",
    errorMessage: "Daily Reflection transcription failed"
  });
}

async function createViaPost(idempotencyKey: string) {
  const response = await postDailyReflection(postRequest({ idempotencyKey }));
  expect(response.status).toBe(201);
  return await response.json() as {
    reflectionId: string;
    uploadId: string;
    jobId: string;
  };
}

async function addPendingCandidate(reflectionId: string, uploadId: string) {
  const service = new DailyReflectionService(repository);
  const initial = service.get(accountId, reflectionId).reflection;
  const transcribing = service.updateStatus({
    accountId,
    reflectionId,
    expectedVersion: initial.version,
    status: "transcribing"
  });
  const extracting = service.updateStatus({
    accountId,
    reflectionId,
    expectedVersion: transcribing.version,
    status: "extracting"
  });
  await store.write("segments", uploadId, [segment(uploadId)]);
  repository.savePendingCandidates({
    accountId,
    reflectionId,
    expectedVersion: extracting.version,
    candidates: [{
      id: `candidate_${reflectionId}`,
      ordinal: 0,
      proposedText: "Keep this reflection candidate.",
      candidateType: "event",
      sourceSegmentIds: ["segment_api_1"]
    }]
  });
}

beforeEach(async () => {
  process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
  delete process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED;
  delete process.env.DAILY_REFLECTION_TOY_SYNC_ENABLED;
  delete process.env.DAILY_BRIEF_TOY_SYNC_ENABLED;
  process.env.PIPELINE_EXECUTION_MODE = "inline";
  rootDir = await mkdtemp(join(tmpdir(), "daily-reflection-api-"));
  uploadsRootDir = join(rootDir, "uploads");
  store = new JsonStore(join(rootDir, "store"));
  database = openDailyReflectionDatabase({ filePath: ":memory:" });
  generatedId = 0;
  repository = new DailyReflectionRepository(database, {
    now: () => "2026-08-13T08:00:00.000Z",
    idFactory: () => `api_generated_${++generatedId}`
  });
  moduleState.repository = repository;
  moduleState.personRepository = {
    getConfirmedPerson: vi.fn(() => null)
  };
  moduleState.candidateRevocationService = {
    revoke: vi.fn()
  };
  setAccount(accountId);
  vi.clearAllMocks();
  afterMock.mockImplementation(() => undefined);
  enqueueDailyReflectionJobMock.mockResolvedValue({ enqueued: true });
  processDailyReflectionUploadMock.mockResolvedValue(undefined);
  deleteMemoryUploadAndRefreshIndexMock.mockResolvedValue({
    memoryDeleted: true,
    indexRefresh: "not_required"
  });
  admitDailyReflectionUnderLeaseMock.mockImplementation(async (input: {
    accountId: string;
    reflectionId: string;
    leaseOwner: string;
    leaseDurationMs: number;
  }) => {
    const claim = repository.startAdmissionOperation(input);
    if (!claim.executionFence) {
      return repository.listAdmissionResults(input.accountId, claim.operation.id);
    }
    const confirmation = repository.getConfirmation(input.accountId, input.reflectionId);
    if (!confirmation) throw new Error("confirmation missing in admission mock");
    const results = confirmation.candidateSnapshots
      .filter((candidate) => candidate.status === "kept")
      .map((candidate) => ({
        candidateId: candidate.candidateId,
        status: "rejected" as const,
        memoryId: null,
        reasonCode: "verified_owner_required",
        errorCode: null,
        operationKey: `test-operation:${candidate.candidateId}`,
        updatedAt: "2026-08-13T08:00:00.000Z"
      }));
    return repository.completeAdmissionOperation({
      accountId: input.accountId,
      reflectionId: input.reflectionId,
      leaseOwner: claim.executionFence.leaseOwner,
      attemptVersion: claim.executionFence.attemptVersion,
      results
    }).results;
  });
  resolveDailyReflectionAuthoritativeDurationMock.mockResolvedValue({
    inputMethod: "browser_recording",
    effectiveDurationMs: 60_000,
    clientReportedDurationMs: null,
    durationSource: "server_ffprobe",
    processingProfile: "quick_reflection"
  });
  uploadStorageState.failAfterPersist = false;
  uploadStorageState.failBeforePersist = false;
  uploadStorageState.crashAfterRawWrite = false;
  uploadStorageState.captureBeforePersist = false;
  uploadStorageState.crashedFilePath = null;
  uploadStorageState.capturedProvisional = null;
});

afterEach(async () => {
  database.close();
  await rm(rootDir, { recursive: true, force: true });
  if (originalFeatureFlag === undefined) {
    delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
  } else {
    process.env.DAILY_REFLECTION_UPLOAD_ENABLED = originalFeatureFlag;
  }
  if (originalExecutionMode === undefined) {
    delete process.env.PIPELINE_EXECUTION_MODE;
  } else {
    process.env.PIPELINE_EXECUTION_MODE = originalExecutionMode;
  }
  if (originalBrowserRecordingFlag === undefined) {
    delete process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED;
  } else {
    process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED =
      originalBrowserRecordingFlag;
  }
  if (originalToySyncFlag === undefined) {
    delete process.env.DAILY_REFLECTION_TOY_SYNC_ENABLED;
  } else {
    process.env.DAILY_REFLECTION_TOY_SYNC_ENABLED = originalToySyncFlag;
  }
  if (originalSharedToySyncFlag === undefined) {
    delete process.env.DAILY_BRIEF_TOY_SYNC_ENABLED;
  } else {
    process.env.DAILY_BRIEF_TOY_SYNC_ENABLED = originalSharedToySyncFlag;
  }
});

describe("Daily Reflection workflow API", () => {
  it("fails closed when disabled", async () => {
    delete process.env.DAILY_REFLECTION_UPLOAD_ENABLED;
    const disabled = await postDailyReflection(postRequest({ idempotencyKey: "disabled" }));
    expect(disabled.status).toBe(404);
  });

  it("lists only the current account's non-deleted recent records with bounded source-aware summaries", async () => {
    const service = new DailyReflectionService(repository);
    service.createReflection({
      id: "history_own",
      accountId,
      uploadId: null,
      inputMethod: "file_upload",
      sourceOrigin: "user_reflection",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      idempotencyKey: "history-own"
    });
    service.createReflection({
      id: "history_deleted",
      accountId,
      uploadId: null,
      inputMethod: "file_upload",
      sourceOrigin: "unknown",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      idempotencyKey: "history-deleted"
    });
    service.updateStatus({
      accountId,
      reflectionId: "history_deleted",
      expectedVersion: 0,
      status: "deleted"
    });
    service.createReflection({
      id: "history_other",
      accountId: otherAccountId,
      uploadId: null,
      inputMethod: "file_upload",
      sourceOrigin: "direct_conversation",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      idempotencyKey: "history-other"
    });

    const response = await listDailyReflections(new Request("http://localhost/api/daily-reflections"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const payload = DailyReflectionHistoryResponseSchema.parse(await response.json());
    expect(payload.reflections).toEqual([expect.objectContaining({
      id: "history_own",
      sourceOrigin: "user_reflection",
      sourceStatement: "你在 2026-08-13 的复盘中提到……",
      candidateCount: 0,
      transcriptAvailable: false
    })]);
    expect(JSON.stringify(payload)).not.toContain("history_other");
    expect(JSON.stringify(payload)).not.toContain("history_deleted");
  });

  it("rejects an unknown input method before persistence or dispatch", async () => {
    const response = await postDailyReflection(postRequest({
      idempotencyKey: "unknown-input-method",
      inputMethod: "client_selected_method"
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_input_method" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dr_reflections").get())
      .toEqual({ count: 0 });
    await expect(store.listIds("uploads")).resolves.toEqual([]);
    expect(resolveDailyReflectionAuthoritativeDurationMock).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("keeps browser recording ingestion disabled behind its own server flag", async () => {
    const response = await postDailyReflection(postRequest({
      idempotencyKey: "browser-disabled",
      inputMethod: "browser_recording",
      sourceOrigin: null
    }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "feature_disabled" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dr_reflections").get())
      .toEqual({ count: 0 });
    await expect(store.listIds("uploads")).resolves.toEqual([]);
    expect(resolveDailyReflectionAuthoritativeDurationMock).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("freezes server-resolved browser provenance and profile before dispatch", async () => {
    process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED = "true";
    uploadStorageState.captureBeforePersist = true;
    resolveDailyReflectionAuthoritativeDurationMock.mockResolvedValueOnce({
      inputMethod: "browser_recording",
      effectiveDurationMs: 60_000,
      clientReportedDurationMs: 300_000,
      durationSource: "server_ffprobe",
      processingProfile: "quick_reflection"
    });

    const response = await postDailyReflection(postRequest({
      idempotencyKey: "browser-authoritative",
      inputMethod: "browser_recording",
      sourceOrigin: "direct_conversation",
      clientReportedDurationMs: "300000",
      processingProfile: "full_recording"
    }));
    expect(response.status).toBe(201);
    const body = await response.json() as { reflectionId: string; uploadId: string };

    expect(uploadStorageState.capturedProvisional).toEqual({
      ownership: expect.objectContaining({
        accountId,
        reflectionId: body.reflectionId,
        uploadId: body.uploadId,
        uploadFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        attemptVersion: 1,
        status: "uploading"
      }),
      processingPlan: null
    });

    expect(repository.getReflection(accountId, body.reflectionId)).toMatchObject({
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection",
      processingProfile: "quick_reflection",
      status: "uploading"
    });
    expect(repository.getProcessingPlan(accountId, body.reflectionId)).toMatchObject({
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection",
      processingProfile: "quick_reflection",
      uploadId: body.uploadId
    });
    await expect(store.read("uploads", body.uploadId)).resolves.toMatchObject({
      durationSeconds: 60,
      effectiveDurationMs: 60_000,
      clientReportedDurationMs: 300_000,
      durationSource: "server_ffprobe",
      processingProfile: "quick_reflection"
    });
    expect(resolveDailyReflectionAuthoritativeDurationMock).toHaveBeenCalledWith({
      filePath: expect.stringContaining(body.uploadId),
      inputMethod: "browser_recording",
      clientReportedDurationMs: 300_000
    });
    expect(afterMock).toHaveBeenCalledTimes(1);

    const repeated = await postDailyReflection(postRequest({
      idempotencyKey: "browser-authoritative",
      inputMethod: "browser_recording",
      sourceOrigin: "unknown",
      clientReportedDurationMs: "30000",
      processingProfile: "full_recording"
    }));
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toMatchObject({
      reflectionId: body.reflectionId,
      uploadId: body.uploadId,
      reused: true
    });
    expect(repository.getProcessingPlan(accountId, body.reflectionId)).toMatchObject({
      sourceOrigin: "user_reflection",
      processingProfile: "quick_reflection"
    });
    expect(resolveDailyReflectionAuthoritativeDurationMock).toHaveBeenCalledTimes(1);
    // Inline retries may schedule the same product job again; the persisted
    // execution lease makes the duplicate delivery a no-op.
    expect(afterMock).toHaveBeenCalledTimes(2);
  });

  it("freezes the authoritative browser profile before queue publication", async () => {
    process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED = "true";
    process.env.PIPELINE_EXECUTION_MODE = "queue";
    enqueueDailyReflectionJobMock.mockImplementationOnce(async (payload) => {
      const reflection = repository.getReflection(accountId, payload.reflectionId);
      const plan = repository.getProcessingPlan(accountId, payload.reflectionId);
      expect(reflection).toMatchObject({
        inputMethod: "browser_recording",
        sourceOrigin: "user_reflection",
        processingProfile: "quick_reflection",
        status: "uploading"
      });
      expect(plan).toMatchObject({
        uploadId: reflection.uploadId,
        processingProfile: "quick_reflection"
      });
      await expect(store.read("uploads", reflection.uploadId!)).resolves.toMatchObject({
        effectiveDurationMs: 60_000,
        durationSource: "server_ffprobe",
        processingProfile: "quick_reflection"
      });
      return { jobId: "queue-browser-profile-frozen", enqueued: true };
    });

    const response = await postDailyReflection(postRequest({
      idempotencyKey: "browser-queue-profile-freeze",
      inputMethod: "browser_recording",
      sourceOrigin: "direct_conversation",
      processingProfile: "full_recording"
    }));

    expect(response.status).toBe(201);
    expect(enqueueDailyReflectionJobMock).toHaveBeenCalledTimes(1);
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("rejects a browser recording below the authoritative minimum", async () => {
    process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED = "true";
    resolveDailyReflectionAuthoritativeDurationMock.mockRejectedValueOnce(
      new DailyReflectionDurationPolicyError(
        "daily_reflection_duration_too_short"
      )
    );

    const response = await postDailyReflection(postRequest({
      idempotencyKey: "browser-too-short",
      inputMethod: "browser_recording",
      sourceOrigin: null,
      clientReportedDurationMs: "180000"
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "daily_reflection_duration_too_short",
      retryable: false
    });
    const reflection = database.prepare(`
      SELECT status, error_code FROM dr_reflections WHERE idempotency_key = ?
    `).get("browser-too-short");
    expect(reflection).toEqual({
      status: "failed",
      error_code: "daily_reflection_duration_too_short"
    });
    await expect(store.listIds("uploads")).resolves.toEqual([]);
    await expect(store.listIds("daily-reflection-jobs")).resolves.toEqual([]);
    expect(repository.getProcessingPlan(
      accountId,
      (database.prepare(`
        SELECT id FROM dr_reflections WHERE idempotency_key = ?
      `).get("browser-too-short") as { id: string }).id
    )).toBeNull();
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("keeps a probe failure replayable before binding the immutable plan", async () => {
    process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED = "true";
    resolveDailyReflectionAuthoritativeDurationMock
      .mockRejectedValueOnce(new DailyReflectionDurationProbeError())
      .mockResolvedValueOnce({
        inputMethod: "browser_recording",
        effectiveDurationMs: 181_000,
        clientReportedDurationMs: 60_000,
        durationSource: "server_ffprobe",
        processingProfile: "full_recording"
      });
    const request = () => postRequest({
      idempotencyKey: "browser-probe-retry",
      inputMethod: "browser_recording",
      sourceOrigin: null,
      clientReportedDurationMs: "60000"
    });

    const failed = await postDailyReflection(request());
    expect(failed.status).toBe(503);
    const failedBody = await failed.json() as { reflectionId: string; uploadId: string };
    await expect(Promise.resolve(
      repository.getReflection(accountId, failedBody.reflectionId)
    )).resolves.toMatchObject({
      status: "uploading",
      uploadId: failedBody.uploadId
    });
    expect(repository.getProcessingPlan(accountId, failedBody.reflectionId)).toBeNull();
    await expect(store.listIds("uploads")).resolves.toEqual([]);
    expect(afterMock).not.toHaveBeenCalled();

    const recoveryEnqueue = vi.fn(async () => ({
      jobId: "unexpected-browser-pre-plan-recovery",
      enqueued: true
    }));
    const recovery = await recoverDailyReflectionJobs({ enqueue: recoveryEnqueue }, {
      repository,
      getStore: () => store,
      getUploadsRootDir: () => uploadsRootDir,
      access,
      now: () => "2026-08-13T08:10:00.000Z"
    });
    expect(recovery).toMatchObject({
      workflowsScanned: 1,
      enqueued: 0,
      missingPlanFailed: 0,
      racesSkipped: 1,
      provisionalCleaned: 0
    });
    expect(recoveryEnqueue).not.toHaveBeenCalled();
    expect(repository.getReflection(accountId, failedBody.reflectionId))
      .toMatchObject({
        status: "uploading",
        uploadId: failedBody.uploadId,
        errorCode: null
      });

    const replay = await postDailyReflection(request());
    expect(replay.status).toBe(200);
    const replayBody = await replay.json() as { reflectionId: string; uploadId: string };
    expect(replayBody.reflectionId).toBe(failedBody.reflectionId);
    expect(repository.getProcessingPlan(accountId, replayBody.reflectionId)).toMatchObject({
      processingProfile: "full_recording",
      sourceOrigin: "user_reflection",
      uploadId: replayBody.uploadId
    });
    await expect(store.read("uploads", replayBody.uploadId)).resolves.toMatchObject({
      durationSeconds: 181,
      effectiveDurationMs: 181_000,
      clientReportedDurationMs: 60_000
    });
    expect(afterMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a pre-plan browser storage failure replayable", async () => {
    process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED = "true";
    uploadStorageState.failBeforePersist = true;
    const request = () => postRequest({
      idempotencyKey: "browser-storage-retry",
      inputMethod: "browser_recording",
      sourceOrigin: null
    });

    const failed = await postDailyReflection(request());
    expect(failed.status).toBe(503);
    const failedBody = await failed.json() as { reflectionId: string; uploadId: string };
    expect(repository.getReflection(accountId, failedBody.reflectionId))
      .toMatchObject({
        status: "uploading",
        uploadId: failedBody.uploadId
      });
    expect(repository.getProcessingPlan(accountId, failedBody.reflectionId)).toBeNull();

    const replay = await postDailyReflection(request());
    expect(replay.status).toBe(200);
    const replayBody = await replay.json() as { reflectionId: string; uploadId: string };
    expect(replayBody.reflectionId).toBe(failedBody.reflectionId);
    expect(repository.getProcessingPlan(accountId, replayBody.reflectionId))
      .toMatchObject({ processingProfile: "quick_reflection" });
    await expect(store.read("uploads", replayBody.uploadId)).resolves.toMatchObject({
      durationSeconds: 60,
      durationSource: "server_ffprobe"
    });
  });

  it("recovers a browser crash after raw write and idempotently replays the POST", async () => {
    process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED = "true";
    uploadStorageState.crashAfterRawWrite = true;
    const bytes = new Uint8Array([82, 73, 70, 70, 91, 92, 93, 94]);
    const request = () => postRequest({
      idempotencyKey: "browser-raw-write-crash",
      inputMethod: "browser_recording",
      sourceOrigin: null,
      bytes
    });

    const interrupted = await postDailyReflection(request());
    expect(interrupted.status).toBe(503);
    const interruptedBody = await interrupted.json() as {
      reflectionId: string;
      uploadId: string;
    };
    const crashedFilePath = uploadStorageState.crashedFilePath!;
    await expect(readFile(crashedFilePath)).resolves.toEqual(Buffer.from(bytes));
    expect(repository.getProcessingPlan(accountId, interruptedBody.reflectionId))
      .toBeNull();
    expect(repository.getProvisionalUploadOwnership(
      accountId,
      interruptedBody.reflectionId
    )).toMatchObject({
      uploadId: interruptedBody.uploadId,
      attemptVersion: 1,
      status: "uploading"
    });

    const enqueue = vi.fn(async () => ({
      jobId: "unexpected-provisional-enqueue",
      enqueued: true
    }));
    await expect(recoverDailyReflectionJobs({ enqueue }, {
      repository,
      getStore: () => store,
      getUploadsRootDir: () => uploadsRootDir,
      access,
      now: () => "2026-08-13T08:10:00.000Z"
    })).resolves.toMatchObject({
      workflowsScanned: 1,
      provisionalCleaned: 1,
      enqueued: 0
    });
    expect(enqueue).not.toHaveBeenCalled();
    await expect(access(crashedFilePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(repository.getProvisionalUploadOwnership(
      accountId,
      interruptedBody.reflectionId
    )).toMatchObject({ attemptVersion: 2, status: "uploading" });

    const replay = await postDailyReflection(request());
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      reflectionId: interruptedBody.reflectionId,
      uploadId: interruptedBody.uploadId,
      reused: true
    });
    expect(repository.getProcessingPlan(accountId, interruptedBody.reflectionId))
      .toMatchObject({ uploadId: interruptedBody.uploadId });
    expect(repository.getProvisionalUploadOwnership(
      accountId,
      interruptedBody.reflectionId
    )).toBeNull();
  });

  it.each([
    "manual_note",
    "ai_derived_observation",
    "legacy_unknown",
    "future_external_source"
  ])("rejects source value %s before persistence or dispatch", async (sourceOrigin) => {
    const invalid = await postDailyReflection(postRequest({
      idempotencyKey: `invalid-origin-${sourceOrigin}`,
      sourceOrigin
    }));
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "invalid_source_origin" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dr_reflections").get())
      .toEqual({ count: 0 });
    await expect(store.listIds("uploads")).resolves.toEqual([]);
    await expect(store.listIds("daily-reflection-jobs")).resolves.toEqual([]);
    expect(afterMock).not.toHaveBeenCalled();
    expect(processDailyReflectionUploadMock).not.toHaveBeenCalled();
    expect(enqueueDailyReflectionJobMock).not.toHaveBeenCalled();
  });

  it.each([
    "user_reflection",
    "direct_conversation",
    "unknown"
  ] as const)("accepts source value %s for file upload", async (sourceOrigin) => {
    const response = await postDailyReflection(postRequest({
      idempotencyKey: `allowed-origin-${sourceOrigin}`,
      sourceOrigin
    }));
    expect(response.status).toBe(201);
    const body = await response.json() as { reflectionId: string };
    expect(repository.getReflection(accountId, body.reflectionId)).toMatchObject({
      sourceOrigin
    });
    expect(repository.getProcessingPlan(accountId, body.reflectionId)).toMatchObject({
      sourceOrigin
    });
  });

  it("deduplicates sequential POST delivery by account and idempotency key", async () => {
    const first = await postDailyReflection(postRequest({ idempotencyKey: "sequential" }));
    const repeated = await postDailyReflection(postRequest({ idempotencyKey: "sequential" }));
    const firstBody = await first.json();
    const repeatedBody = await repeated.json();

    expect(first.status).toBe(201);
    expect(repeated.status).toBe(200);
    expect(repeatedBody).toMatchObject({
      reflectionId: firstBody.reflectionId,
      uploadId: firstBody.uploadId,
      jobId: firstBody.jobId,
      reused: true
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dr_reflections").get())
      .toEqual({ count: 1 });
    await expect(store.listIds("uploads")).resolves.toEqual([firstBody.uploadId]);
    await expect(store.listIds("daily-reflection-jobs"))
      .resolves.toEqual([firstBody.reflectionId]);
  });

  it("deduplicates concurrent POST delivery without duplicate uploads or jobs", async () => {
    const winnerBytes = new Uint8Array([82, 73, 70, 70, 17, 18, 19, 20]);
    const loserBytes = new Uint8Array([82, 73, 70, 70, 33, 34, 35, 36]);
    const [left, right] = await Promise.all([
      postDailyReflection(postRequest({
        idempotencyKey: "concurrent",
        bytes: winnerBytes
      })),
      postDailyReflection(postRequest({
        idempotencyKey: "concurrent",
        bytes: loserBytes
      }))
    ]);
    const leftBody = await left.json();
    const rightBody = await right.json();
    const winner = left.status === 201
      ? { body: leftBody, bytes: winnerBytes }
      : { body: rightBody, bytes: loserBytes };
    const loser = left.status === 409 ? leftBody : rightBody;

    expect([left.status, right.status].sort()).toEqual([201, 409]);
    expect(loser).toEqual({ error: "daily_reflection_idempotency_conflict" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dr_reflections").get())
      .toEqual({ count: 1 });
    await expect(store.listIds("uploads")).resolves.toEqual([winner.body.uploadId]);
    await expect(store.listIds("daily-reflection-jobs"))
      .resolves.toEqual([winner.body.reflectionId]);
    const storedUpload = await store.read<{ filePath: string }>(
      "uploads",
      winner.body.uploadId
    );
    expect(storedUpload).not.toBeNull();
    expect(new Uint8Array(await readFile(storedUpload!.filePath))).toEqual(winner.bytes);
  });

  it("joins concurrent delivery of the same idempotency key and file fingerprint", async () => {
    const bytes = new Uint8Array([82, 73, 70, 70, 71, 72, 73, 74]);
    const [left, right] = await Promise.all([
      postDailyReflection(postRequest({
        idempotencyKey: "concurrent-same",
        bytes
      })),
      postDailyReflection(postRequest({
        idempotencyKey: "concurrent-same",
        bytes
      }))
    ]);
    const [leftBody, rightBody] = await Promise.all([left.json(), right.json()]);

    expect([left.status, right.status].sort()).toEqual([201, 202]);
    expect(rightBody).toMatchObject({
      reflectionId: leftBody.reflectionId,
      uploadId: leftBody.uploadId,
      jobId: leftBody.jobId
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dr_reflections").get())
      .toEqual({ count: 1 });
    await expect(store.listIds("uploads")).resolves.toEqual([leftBody.uploadId]);
    await expect(store.listIds("daily-reflection-jobs"))
      .resolves.toEqual([leftBody.reflectionId]);
  });

  it("compensates a failed raw persist and repairs the same idempotent workflow on replay", async () => {
    const firstBytes = new Uint8Array([82, 73, 70, 70, 41, 42, 43, 44]);
    uploadStorageState.failAfterPersist = true;

    const failed = await postDailyReflection(postRequest({
      idempotencyKey: "persist-compensation",
      bytes: firstBytes
    }));

    expect(failed.status).toBe(503);
    const failedBody = await failed.json();
    expect(failedBody.error).toMatch(/^daily_reflection_/u);
    expect(JSON.stringify(failedBody)).not.toContain("sensitive detail");
    const row = database.prepare(`
      SELECT id, status, error_code FROM dr_reflections
      WHERE account_id = ? AND idempotency_key = ?
    `).get(accountId, "persist-compensation") as {
      id: string;
      status: string;
      error_code: string | null;
    };
    expect(row).toMatchObject({
      status: "failed",
      error_code: expect.stringMatching(/^daily_reflection_/u)
    });
    await expect(store.listIds("uploads")).resolves.toEqual([]);
    await expect(store.listIds("daily-reflection-jobs")).resolves.toEqual([]);
    await expect(readdir(uploadsRootDir).catch(() => [])).resolves.toEqual([]);
    expect(afterMock).not.toHaveBeenCalled();

    const replay = await postDailyReflection(postRequest({
      idempotencyKey: "persist-compensation",
      bytes: firstBytes
    }));
    const replayBody = await replay.json();
    expect(replay.status).toBe(200);
    expect(replayBody).toMatchObject({
      reflectionId: row.id,
      status: "uploading",
      reused: true
    });
    expect(repository.getReflection(accountId, row.id)).toMatchObject({
      status: "uploading",
      errorCode: null,
      errorMessage: null
    });
    await expect(store.listIds("uploads")).resolves.toEqual([replayBody.uploadId]);
    await expect(store.listIds("daily-reflection-jobs")).resolves.toEqual([row.id]);
    const repairedUpload = await store.read<{ filePath: string }>(
      "uploads",
      replayBody.uploadId
    );
    expect(repairedUpload).not.toBeNull();
    expect(new Uint8Array(await readFile(repairedUpload!.filePath))).toEqual(firstBytes);
    expect(afterMock).toHaveBeenCalledTimes(1);
  });

  it("takes over an uploading workflow whose persistence owner crashed", async () => {
    const created = repository.createReflection({
      id: "reflection_crashed_persist",
      accountId,
      uploadId: null,
      inputMethod: "file_upload",
      sourceOrigin: "user_reflection",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      idempotencyKey: "crashed-persist"
    });
    const uploadId = `daily-reflection-${created.reflection.id}`;
    const bound = repository.bindUploadAndPlan({
      accountId,
      reflectionId: created.reflection.id,
      expectedVersion: created.reflection.version,
      uploadId
    });
    repository.transitionStatus({
      accountId,
      reflectionId: created.reflection.id,
      expectedVersion: bound.reflection.version,
      status: "uploading"
    });
    const crashedFence = repository.claimExecutionLease({
      accountId,
      reflectionId: created.reflection.id,
      leaseOwner: "crashed_upload_owner",
      leaseDurationMs: 60_000,
      allowedStatuses: ["uploading"],
      now: "2026-08-13T07:00:00.000Z"
    });
    expect(crashedFence).toMatchObject({ attemptVersion: 1 });
    await mkdir(uploadsRootDir, { recursive: true });
    await writeFile(join(uploadsRootDir, `${uploadId}.attempt-1.wav`), "orphan");

    const response = await postDailyReflection(postRequest({
      idempotencyKey: "crashed-persist",
      bytes: new Uint8Array([82, 73, 70, 70, 61, 62, 63, 64])
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      reflectionId: created.reflection.id,
      uploadId,
      status: "uploading",
      reused: true
    });
    await expect(store.read("uploads", uploadId)).resolves.toMatchObject({
      ingestionContext: "daily_reflection",
      reflectionId: created.reflection.id
    });
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(repository.getExecutionLease(accountId, created.reflection.id)).toBeNull();
    expect(database.prepare(`
      SELECT attempt_version FROM dr_reflections WHERE id = ? AND account_id = ?
    `).get(created.reflection.id, accountId)).toEqual({ attempt_version: 2 });
    await expect(readdir(uploadsRootDir)).resolves.toEqual([
      `${uploadId}.attempt-2.wav`
    ]);
  });

  it("returns 202 without storage writes while another persistence lease is live", async () => {
    const created = repository.createReflection({
      id: "reflection_live_persist",
      accountId,
      uploadId: null,
      inputMethod: "file_upload",
      sourceOrigin: "user_reflection",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      idempotencyKey: "live-persist"
    });
    const uploadId = `daily-reflection-${created.reflection.id}`;
    const bound = repository.bindUploadAndPlan({
      accountId,
      reflectionId: created.reflection.id,
      expectedVersion: created.reflection.version,
      uploadId
    });
    const uploading = repository.transitionStatus({
      accountId,
      reflectionId: created.reflection.id,
      expectedVersion: bound.reflection.version,
      status: "uploading"
    });
    repository.claimExecutionLease({
      accountId,
      reflectionId: created.reflection.id,
      leaseOwner: "live_upload_owner",
      leaseDurationMs: 2 * 60_000,
      allowedStatuses: ["uploading"],
      now: "2026-08-13T08:00:00.000Z"
    });

    const response = await postDailyReflection(postRequest({
      idempotencyKey: "live-persist"
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      reflectionId: created.reflection.id,
      uploadId,
      status: uploading.status,
      persistencePending: true
    });
    await expect(store.listIds("uploads")).resolves.toEqual([]);
    await expect(store.listIds("daily-reflection-jobs")).resolves.toEqual([]);
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("returns the complete fenced transcript and safe upload with immutable origin", async () => {
    const created = repository.createReflection({
      id: "reflection_detail",
      accountId,
      uploadId: "upload_detail",
      inputMethod: "file_upload",
      sourceOrigin: "manual_note",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      idempotencyKey: "detail"
    });
    const service = new DailyReflectionService(repository);
    const uploading = service.updateStatus({
      accountId,
      reflectionId: created.reflection.id,
      expectedVersion: created.reflection.version,
      status: "uploading"
    });
    const transcribing = service.updateStatus({
      accountId,
      reflectionId: created.reflection.id,
      expectedVersion: uploading.version,
      status: "transcribing"
    });
    const extracting = service.updateStatus({
      accountId,
      reflectionId: created.reflection.id,
      expectedVersion: transcribing.version,
      status: "extracting"
    });
    const publishedUpload = uploadRecord({
      reflectionId: created.reflection.id,
      uploadId: "upload_detail",
      originalName: "refreshed-reflection.wav"
    });
    const publishedSegments = [
      segment("upload_detail", "segment_detail"),
      {
        ...segment("upload_detail", "segment_unreferenced"),
        startSeconds: 8,
        endSeconds: 16,
        text: "A complete transcript segment not referenced by any candidate."
      }
    ];
    const fence = repository.claimExecutionLease({
      accountId,
      reflectionId: created.reflection.id,
      leaseOwner: "detail-route-publication",
      leaseDurationMs: 60_000,
      allowedStatuses: ["extracting"]
    });
    if (!fence) throw new Error("expected detail publication fence");
    repository.publishAssetUnderExecutionFence({
      accountId,
      reflectionId: created.reflection.id,
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion,
      assetKind: "upload",
      payload: publishedUpload
    });
    repository.publishAssetUnderExecutionFence({
      accountId,
      reflectionId: created.reflection.id,
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion,
      assetKind: "segments",
      payload: publishedSegments
    });
    const stored = repository.savePendingCandidates({
      accountId,
      reflectionId: created.reflection.id,
      expectedVersion: extracting.version,
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion,
      candidates: [{
        ordinal: 0,
        proposedText: "Evidence-backed manual note.",
        candidateType: "summary",
        sourceSegmentIds: ["segment_detail"]
      }]
    });
    service.updateStatus({
      accountId,
      reflectionId: created.reflection.id,
      expectedVersion: stored.reflection.version,
      status: "review_pending",
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion
    });
    repository.releaseExecutionLease({
      accountId,
      reflectionId: created.reflection.id,
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion
    });
    await Promise.all([
      store.write("uploads", "upload_detail", {
        ...publishedUpload,
        originalName: "stale-compatibility-name.wav"
      }),
      store.write("segments", "upload_detail", [
        segment("upload_detail", "stale_compatibility_segment")
      ])
    ]);

    const response = await getDailyReflection(
      new Request("http://localhost/api/daily-reflections/reflection_detail"),
      params("reflection_detail")
    );
    expect(response!.status).toBe(200);
    const detail = DailyReflectionDetailResponseSchema.parse(await response!.json());
    expect(detail).toMatchObject({
      processingPlan: { sourceOrigin: "manual_note" },
      effectiveOrigin: "manual_note",
      upload: {
        id: "upload_detail",
        originalName: "refreshed-reflection.wav",
        status: "ready"
      },
      candidates: [{
        sourceSegmentIds: ["segment_detail"],
        evidence: [{
          sourceSegmentId: "segment_detail",
          uploadId: "upload_detail",
          effectiveOrigin: "manual_note"
        }]
      }],
      rememberedCount: 0,
      revokedCandidateIds: []
    });
    expect(detail.segments.map((item) => item.id)).toEqual([
      "segment_detail",
      "segment_unreferenced"
    ]);
    expect(detail.upload).not.toHaveProperty("filePath");
    expect(detail.upload).not.toHaveProperty("uploadFingerprint");
    expect(detail.upload).not.toHaveProperty("persistenceAttemptVersion");
    expect(JSON.stringify(detail)).not.toContain("detail-route-publication");

    setAccount(otherAccountId);
    const hidden = await getDailyReflection(
      new Request("http://localhost/api/daily-reflections/reflection_detail"),
      params("reflection_detail")
    );
    expect(hidden!.status).toBe(404);
    const hiddenRetry = await retryDailyReflection(
      new Request("http://localhost/api/daily-reflections/reflection_detail/retry", {
        method: "POST"
      }),
      params("reflection_detail")
    );
    const hiddenDelete = await deleteDailyReflection(
      new Request("http://localhost/api/daily-reflections/reflection_detail", {
        method: "DELETE"
      }),
      params("reflection_detail")
    );
    expect([hiddenRetry.status, hiddenDelete!.status]).toEqual([404, 404]);
    expect(repository.getReflection(accountId, "reflection_detail").status)
      .toBe("review_pending");
    expect(repository.listCandidates(accountId, "reflection_detail")).toHaveLength(1);

    setAccount(accountId);
    process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "false";
    const disabled = await getDailyReflection(
      new Request("http://localhost/api/daily-reflections/reflection_detail"),
      params("reflection_detail")
    );
    expect(disabled!.status).toBe(404);
    process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
  });

  it.each([
    "missing-plan",
    "missing-upload",
    "malformed-upload",
    "missing-segments",
    "empty-segments",
    "malformed-segments",
    "cross-upload",
    "unresolved-candidate"
  ])("fails closed for review_pending detail with %s", async (corruption) => {
    const suffix = corruption.replaceAll("-", "_");
    const reflectionId = `reflection_detail_${suffix}`;
    const uploadId = `upload_detail_${suffix}`;
    const sourceSegmentId = `segment_detail_${suffix}`;

    if (corruption === "missing-plan") {
      repository.createReflection({
        id: reflectionId,
        accountId,
        uploadId: null,
        inputMethod: "file_upload",
        sourceOrigin: "user_reflection",
        processingProfile: "full_recording",
        ingestionContext: "daily_reflection",
        idempotencyKey: `detail-${corruption}`
      });
      database.prepare(`
        UPDATE dr_reflections SET status = 'review_pending'
        WHERE id = ? AND account_id = ?
      `).run(reflectionId, accountId);
    } else {
      createReviewPendingDetail({
        reflectionId,
        uploadId,
        sourceSegmentId,
        publishCanonical: false
      });

      if (corruption !== "missing-upload") {
        await store.write(
          "uploads",
          uploadId,
          corruption === "malformed-upload"
            ? {
                id: uploadId,
                reflectionId,
                ingestionContext: "daily_reflection"
              }
            : uploadRecord({ reflectionId, uploadId })
        );
      }

      if (corruption !== "missing-segments") {
        const rawSegments = corruption === "empty-segments"
          ? []
          : corruption === "malformed-segments"
            ? [{ id: sourceSegmentId, uploadId }]
            : corruption === "cross-upload"
              ? [segment("upload_from_another_reflection", sourceSegmentId)]
              : corruption === "unresolved-candidate"
                ? [segment(uploadId, "different_source_segment")]
                : [segment(uploadId, sourceSegmentId)];
        await store.write("segments", uploadId, rawSegments);
      }
    }

    const response = await getDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}`),
      params(reflectionId)
    );

    expect(response!.status).toBe(409);
    await expect(response!.json()).resolves.toEqual({
      error: "daily_reflection_evidence_unavailable"
    });
  });

  it("keeps toy sync ingestion disabled behind its own server flag", async () => {
    const response = await postDailyReflection(postRequest({
      idempotencyKey: "toy-disabled",
      inputAdapter: "toy_sync"
    }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "feature_disabled" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dr_reflections").get())
      .toEqual({ count: 0 });
    await expect(store.listIds("uploads")).resolves.toEqual([]);
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown input adapter before persistence", async () => {
    const response = await postDailyReflection(postRequest({
      idempotencyKey: "toy-invalid-adapter",
      inputAdapter: "desktop_agent"
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_input_adapter" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dr_reflections").get())
      .toEqual({ count: 0 });
    await expect(store.listIds("uploads")).resolves.toEqual([]);
  });

  it("allows toy sync only through the existing file-upload input method", async () => {
    process.env.DAILY_REFLECTION_TOY_SYNC_ENABLED = "true";
    process.env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED = "true";
    const response = await postDailyReflection(postRequest({
      idempotencyKey: "toy-browser-method-rejected",
      inputAdapter: "toy_sync",
      inputMethod: "browser_recording",
      clientReportedDurationMs: "200000"
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_input_adapter" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dr_reflections").get())
      .toEqual({ count: 0 });
    await expect(store.listIds("uploads")).resolves.toEqual([]);
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("normalizes enabled toy sync to the existing authoritative file-upload path", async () => {
    process.env.DAILY_REFLECTION_TOY_SYNC_ENABLED = "true";
    const request = () => postRequest({
      idempotencyKey: "daily-reflection-toy-v1-stable",
      inputAdapter: "toy_sync",
      sourceOrigin: "direct_conversation"
    });
    const response = await postDailyReflection(request());

    expect(response.status).toBe(201);
    const body = await response.json() as {
      reflectionId: string;
      uploadId: string;
      jobId: string;
    };
    expect(repository.getReflection(accountId, body.reflectionId)).toMatchObject({
      inputMethod: "file_upload",
      sourceOrigin: "user_reflection",
      processingProfile: "full_recording"
    });
    await expect(store.read("uploads", body.uploadId)).resolves.toMatchObject({
      ingestionContext: "daily_reflection",
      reflectionId: body.reflectionId
    });
    expect(afterMock).toHaveBeenCalledTimes(1);

    const replay = await postDailyReflection(request());
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      reflectionId: body.reflectionId,
      uploadId: body.uploadId,
      jobId: body.jobId,
      reused: true
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dr_reflections").get())
      .toEqual({ count: 1 });
    await expect(store.listIds("uploads")).resolves.toEqual([body.uploadId]);
    expect(resolveDailyReflectionAuthoritativeDurationMock).not.toHaveBeenCalled();
  });

  it("updates review decisions with account-scoped confirmed Subjects and optimistic versioning", async () => {
    const reflectionId = "reflection_candidate_review";
    const uploadId = "upload_candidate_review";
    createReviewPendingDetail({
      reflectionId,
      uploadId,
      sourceSegmentId: "segment_candidate_review"
    });
    const reflection = repository.getReflection(accountId, reflectionId);
    const candidate = repository.listCandidates(accountId, reflectionId)[0];

    const invalidSubject = await updateDailyReflectionCandidates(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}/candidates`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: reflection.version,
          candidates: [{
            candidateId: candidate.id,
            status: "kept",
            userText: null,
            subjectPersonId: "person_unconfirmed"
          }]
        })
      }),
      params(reflectionId)
    );
    expect(invalidSubject.status).toBe(409);
    await expect(invalidSubject.json()).resolves.toEqual({
      error: "daily_reflection_subject_invalid"
    });
    expect(repository.listCandidates(accountId, reflectionId)[0].status).toBe("pending");

    moduleState.personRepository = {
      getConfirmedPerson: vi.fn((candidateAccountId: string, personId: string) => (
        candidateAccountId === accountId && personId === "person_confirmed"
          ? { id: personId, accountId: candidateAccountId, status: "confirmed" }
          : null
      ))
    };
    const updated = await updateDailyReflectionCandidates(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}/candidates`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: reflection.version,
          candidates: [{
            candidateId: candidate.id,
            status: "kept",
            userText: "  Confirmed wording.  ",
            subjectPersonId: "person_confirmed"
          }]
        })
      }),
      params(reflectionId)
    );
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      reflection: { version: reflection.version + 1 },
      candidates: [{
        id: candidate.id,
        proposedText: candidate.proposedText,
        userText: "Confirmed wording.",
        status: "kept",
        subjectPersonId: "person_confirmed",
        subjectConfirmed: true,
        sourceSegmentIds: candidate.sourceSegmentIds
      }]
    });

    const stale = await updateDailyReflectionCandidates(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}/candidates`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: reflection.version,
          candidates: [{
            candidateId: candidate.id,
            status: "excluded",
            userText: null,
            subjectPersonId: null
          }]
        })
      }),
      params(reflectionId)
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      error: "version_conflict",
      currentVersion: reflection.version + 1
    });

    setAccount(otherAccountId);
    const hidden = await updateDailyReflectionCandidates(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}/candidates`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: reflection.version + 1,
          candidates: [{
            candidateId: candidate.id,
            status: "excluded",
            userText: null,
            subjectPersonId: null
          }]
        })
      }),
      params(reflectionId)
    );
    expect(hidden.status).toBe(404);
  });

  it("finalizes once, reuses the confirmation, and blocks cancellation after confirmation", async () => {
    const reflectionId = "reflection_finalize_route";
    const uploadId = "upload_finalize_route";
    createReviewPendingDetail({
      reflectionId,
      uploadId,
      sourceSegmentId: "segment_finalize_route"
    });
    const review = repository.getReflection(accountId, reflectionId);
    const candidate = repository.listCandidates(accountId, reflectionId)[0];
    const decided = repository.updateCandidateDecisions({
      accountId,
      reflectionId,
      expectedVersion: review.version,
      candidates: [{
        candidateId: candidate.id,
        status: "kept",
        userText: "A user-confirmed reflection.",
        subjectPersonId: null
      }]
    });
    const request = () => new Request(
      `http://localhost/api/daily-reflections/${reflectionId}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: decided.reflection.version,
          idempotencyKey: "stable-finalize-route-key"
        })
      }
    );

    setAccount(otherAccountId);
    const hidden = await finalizeDailyReflection(request(), params(reflectionId));
    expect(hidden.status).toBe(404);
    expect(admitDailyReflectionUnderLeaseMock).not.toHaveBeenCalled();

    setAccount(accountId);
    const first = await finalizeDailyReflection(request(), params(reflectionId));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      reflection: { id: reflectionId, status: "completed" },
      confirmation: {
        idempotencyKey: "stable-finalize-route-key",
        candidateSnapshots: [{
          candidateId: candidate.id,
          proposedText: candidate.proposedText,
          userText: "A user-confirmed reflection.",
          sourceSegmentIds: ["segment_finalize_route"]
        }]
      },
      admissionOperation: {
        status: "completed",
        admittedCount: 0,
        rejectedCount: 1,
        excludedCount: 0
      },
      admissionResults: [{
        candidateId: candidate.id,
        status: "rejected",
        reasonCode: "verified_owner_required"
      }],
      reused: false
    });

    const repeated = await finalizeDailyReflection(request(), params(reflectionId));
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toMatchObject({
      reflection: { status: "completed" },
      admissionResults: [{ candidateId: candidate.id, status: "rejected" }],
      reused: true
    });
    expect(repository.listAdmissionResults(
      accountId,
      repository.getAdmissionOperation(accountId, reflectionId)!.id
    )).toHaveLength(1);

    const cancelled = await cancelDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}/cancel`, {
        method: "POST"
      }),
      params(reflectionId)
    );
    expect(cancelled.status).toBe(409);
    expect(repository.getReflection(accountId, reflectionId).status).toBe("completed");
    expect(repository.listCandidates(accountId, reflectionId)).toHaveLength(1);
  });

  it("retries a failed Memory admission with the same finalize request", async () => {
    const reflectionId = "reflection_finalize_retry";
    createReviewPendingDetail({
      reflectionId,
      uploadId: "upload_finalize_retry",
      sourceSegmentId: "segment_finalize_retry"
    });
    const review = repository.getReflection(accountId, reflectionId);
    const candidate = repository.listCandidates(accountId, reflectionId)[0];
    const decided = repository.updateCandidateDecisions({
      accountId,
      reflectionId,
      expectedVersion: review.version,
      candidates: [{
        candidateId: candidate.id,
        status: "kept",
        userText: null,
        subjectPersonId: null
      }]
    });
    const request = () => new Request(
      `http://localhost/api/daily-reflections/${reflectionId}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: decided.reflection.version,
          idempotencyKey: "stable-finalize-retry-key"
        })
      }
    );
    admitDailyReflectionUnderLeaseMock.mockImplementationOnce(async (input: {
      accountId: string;
      reflectionId: string;
      leaseOwner: string;
      leaseDurationMs: number;
    }) => {
      const claim = repository.startAdmissionOperation(input);
      if (!claim.executionFence) throw new Error("expected retry fixture fence");
      repository.failAdmissionOperation({
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        leaseOwner: claim.executionFence.leaseOwner,
        attemptVersion: claim.executionFence.attemptVersion,
        errorCode: "simulated_memory_failure"
      });
      throw new Error("simulated memory failure");
    });

    const failed = await finalizeDailyReflection(request(), params(reflectionId));
    expect(failed.status).toBe(503);
    expect(repository.getReflection(accountId, reflectionId).status).toBe("admission_failed");
    expect(repository.getConfirmation(accountId, reflectionId)?.idempotencyKey)
      .toBe("stable-finalize-retry-key");

    const retried = await finalizeDailyReflection(request(), params(reflectionId));
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({
      reflection: { status: "completed" },
      admissionOperation: { status: "completed", rejectedCount: 1 },
      admissionResults: [{
        candidateId: candidate.id,
        status: "rejected",
        reasonCode: "verified_owner_required"
      }],
      reused: true
    });
    expect(database.prepare(`
      SELECT attempt_version FROM dr_admission_operations
      WHERE account_id = ? AND reflection_id = ?
    `).get(accountId, reflectionId)).toEqual({ attempt_version: 2 });
  });

  it("completes an all-excluded review without producing admission receipts", async () => {
    const reflectionId = "reflection_finalize_all_excluded";
    createReviewPendingDetail({
      reflectionId,
      uploadId: "upload_finalize_all_excluded",
      sourceSegmentId: "segment_finalize_all_excluded"
    });
    const review = repository.getReflection(accountId, reflectionId);
    const candidate = repository.listCandidates(accountId, reflectionId)[0];
    const decided = repository.updateCandidateDecisions({
      accountId,
      reflectionId,
      expectedVersion: review.version,
      candidates: [{
        candidateId: candidate.id,
        status: "excluded",
        userText: null,
        subjectPersonId: null
      }]
    });

    const response = await finalizeDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: decided.reflection.version,
          idempotencyKey: "all-excluded-finalize-route-key"
        })
      }),
      params(reflectionId)
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      reflection: { status: "completed" },
      admissionOperation: {
        admittedCount: 0,
        rejectedCount: 0,
        excludedCount: 1
      },
      admissionResults: []
    });
  });

  it("keeps a completed review retryable until Memory cleanup succeeds", async () => {
    const reflectionId = "reflection_completed_delete";
    const uploadId = "upload_completed_delete";
    createReviewPendingDetail({
      reflectionId,
      uploadId,
      sourceSegmentId: "segment_completed_delete"
    });
    const review = repository.getReflection(accountId, reflectionId);
    const candidate = repository.listCandidates(accountId, reflectionId)[0];
    const decided = repository.updateCandidateDecisions({
      accountId,
      reflectionId,
      expectedVersion: review.version,
      candidates: [{
        candidateId: candidate.id,
        status: "kept",
        userText: null,
        subjectPersonId: null
      }]
    });
    const finalized = await finalizeDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: decided.reflection.version,
          idempotencyKey: "completed-delete-finalize-key"
        })
      }),
      params(reflectionId)
    );
    expect(finalized.status).toBe(200);

    setAccount(otherAccountId);
    const hidden = await deleteDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}`, { method: "DELETE" }),
      params(reflectionId)
    );
    expect(hidden!.status).toBe(404);
    expect(deleteMemoryUploadAndRefreshIndexMock).not.toHaveBeenCalled();

    setAccount(accountId);
    deleteMemoryUploadAndRefreshIndexMock.mockRejectedValueOnce(new Error("memory unavailable"));
    const failed = await deleteDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}`, { method: "DELETE" }),
      params(reflectionId)
    );
    expect(failed!.status).toBe(503);
    expect(repository.getReflection(accountId, reflectionId).status).toBe("completed");
    expect(repository.getAdmissionOperation(accountId, reflectionId)?.status)
      .toBe("delete_requested");
    expect(repository.getConfirmation(accountId, reflectionId)).not.toBeNull();
    expect(repository.listCandidates(accountId, reflectionId)).toHaveLength(1);

    const retried = await deleteDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}`, { method: "DELETE" }),
      params(reflectionId)
    );
    expect(retried!.status).toBe(204);
    expect(repository.getReflection(accountId, reflectionId).status).toBe("deleted");
    expect(repository.getConfirmation(accountId, reflectionId)).toBeNull();
    expect(repository.getAdmissionOperation(accountId, reflectionId)).toBeNull();
    expect(repository.listCandidates(accountId, reflectionId)).toEqual([]);

    const repeated = await deleteDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}`, { method: "DELETE" }),
      params(reflectionId)
    );
    expect(repeated!.status).toBe(204);
    expect(deleteMemoryUploadAndRefreshIndexMock).toHaveBeenCalledTimes(2);
  });

  it("returns a persisted safe upload with empty segments while transcription is pending", async () => {
    const reflectionId = "reflection_detail_processing";
    const uploadId = "upload_detail_processing";
    const service = new DailyReflectionService(repository);
    const created = service.createReflection({
      id: reflectionId,
      accountId,
      uploadId,
      inputMethod: "file_upload",
      sourceOrigin: "direct_conversation",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      idempotencyKey: "detail-processing"
    }).reflection;
    const uploading = service.updateStatus({
      accountId,
      reflectionId,
      expectedVersion: created.version,
      status: "uploading"
    });
    service.updateStatus({
      accountId,
      reflectionId,
      expectedVersion: uploading.version,
      status: "transcribing"
    });
    await Promise.all([
      store.write("uploads", uploadId, uploadRecord({
        reflectionId,
        uploadId,
        originalName: "processing-refresh.wav"
      })),
      store.write("segments", uploadId, [])
    ]);

    const response = await getDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}`),
      params(reflectionId)
    );

    expect(response!.status).toBe(200);
    const detail = DailyReflectionDetailResponseSchema.parse(await response!.json());
    expect(detail).toMatchObject({
      reflection: { status: "transcribing" },
      effectiveOrigin: "direct_conversation",
      upload: { originalName: "processing-refresh.wav" },
      segments: [],
      candidates: []
    });
    expect(detail.upload).not.toHaveProperty("filePath");
  });

  it("rejects an invalid retry without creating a job or mutating the reflection", async () => {
    const created = repository.createReflection({
      id: "reflection_not_failed",
      accountId,
      uploadId: "upload_not_failed",
      inputMethod: "file_upload",
      sourceOrigin: "unknown",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      idempotencyKey: "not-failed"
    });

    const response = await retryDailyReflection(
      new Request("http://localhost/api/daily-reflections/reflection_not_failed/retry", {
        method: "POST"
      }),
      params("reflection_not_failed")
    );
    expect(response.status).toBe(409);
    expect(repository.getReflection(accountId, created.reflection.id))
      .toMatchObject({ status: "created", version: 0 });
    await expect(store.listIds("daily-reflection-jobs")).resolves.toEqual([]);
    expect(afterMock).not.toHaveBeenCalled();
    expect(enqueueDailyReflectionJobMock).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", []],
    ["invalid", [{ id: "invalid_segment" }]],
    ["cross-upload", [segment("different_upload")]]
  ])("deletes %s canonical transcript data and retries from transcribing", async (
    label,
    rawSegments
  ) => {
    const reflectionId = `reflection_retry_${label.replace("-", "_")}`;
    const uploadId = `upload_retry_${label.replace("-", "_")}`;
    createFailedReflection({
      reflectionId,
      uploadId,
      idempotencyKey: `retry-${label}`
    });
    await store.write("segments", uploadId, rawSegments);
    const deleteSpy = vi.spyOn(store, "delete");

    const response = await retryDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}/retry`, {
        method: "POST"
      }),
      params(reflectionId)
    );

    expect(response.status).toBe(202);
    expect(repository.getReflection(accountId, reflectionId).status).toBe("transcribing");
    expect(deleteSpy).toHaveBeenCalledWith("segments", uploadId);
    await expect(store.read("segments", uploadId)).resolves.toBeNull();
    await expect(store.read("daily-reflection-jobs", reflectionId))
      .resolves.toMatchObject({ status: "waiting", progress: 0 });
    expect(afterMock).toHaveBeenCalledTimes(1);
  });

  it("preserves a valid matching canonical transcript and retries from extracting", async () => {
    const reflectionId = "reflection_retry_canonical";
    const uploadId = "upload_retry_canonical";
    createFailedReflection({
      reflectionId,
      uploadId,
      idempotencyKey: "retry-canonical"
    });
    const canonical = [segment(uploadId, "segment_retry_canonical")];
    await store.write("segments", uploadId, canonical);
    const deleteSpy = vi.spyOn(store, "delete");

    const response = await retryDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}/retry`, {
        method: "POST"
      }),
      params(reflectionId)
    );

    expect(response.status).toBe(202);
    expect(repository.getReflection(accountId, reflectionId).status).toBe("extracting");
    expect(deleteSpy).not.toHaveBeenCalledWith("segments", uploadId);
    await expect(store.read("segments", uploadId)).resolves.toEqual(canonical);
    await expect(store.read("daily-reflection-jobs", reflectionId))
      .resolves.toMatchObject({ status: "waiting", progress: 80 });
    expect(afterMock).toHaveBeenCalledTimes(1);
  });

  it("cancels and removes only staging assets while retaining a parked tombstone", async () => {
    const created = await createViaPost("cancel-assets");
    await addPendingCandidate(created.reflectionId, created.uploadId);
    const upload = await store.read<{ filePath: string }>("uploads", created.uploadId);
    expect(upload).not.toBeNull();

    const response = await cancelDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${created.reflectionId}/cancel`, {
        method: "POST"
      }),
      params(created.reflectionId)
    );
    expect(response.status).toBe(200);
    expect(repository.getReflection(accountId, created.reflectionId).status).toBe("cancelled");
    expect(repository.listCandidates(accountId, created.reflectionId)).toEqual([]);
    await expect(store.read("uploads", created.uploadId)).resolves.toBeNull();
    await expect(store.read("segments", created.uploadId)).resolves.toBeNull();
    await expect(store.read("daily-reflection-jobs", created.reflectionId)).resolves.toBeNull();
    await expect(access(upload!.filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes staging assets and makes the deleted reflection undiscoverable", async () => {
    const created = await createViaPost("delete-assets");
    await addPendingCandidate(created.reflectionId, created.uploadId);
    const extracting = repository.getReflection(accountId, created.reflectionId);
    repository.transitionStatus({
      accountId,
      reflectionId: created.reflectionId,
      expectedVersion: extracting.version,
      status: "review_pending"
    });
    const upload = await store.read<Record<string, unknown> & { filePath: string }>(
      "uploads",
      created.uploadId
    );
    const job = await store.read("daily-reflection-jobs", created.reflectionId);
    expect(upload).not.toBeNull();
    expect(job).not.toBeNull();
    await rm(upload!.filePath, { force: true });
    await expect(store.read("uploads", created.uploadId)).resolves.toMatchObject({
      id: created.uploadId,
      reflectionId: created.reflectionId
    });
    await expect(store.read("segments", created.uploadId)).resolves.not.toBeNull();
    await expect(store.read("daily-reflection-jobs", created.reflectionId))
      .resolves.not.toBeNull();
    expect(repository.listCandidates(accountId, created.reflectionId)).toHaveLength(1);
    const retained = await getDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${created.reflectionId}`),
      params(created.reflectionId)
    );
    expect(retained!.status).toBe(200);

    const response = await deleteDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${created.reflectionId}`, {
        method: "DELETE"
      }),
      params(created.reflectionId)
    );
    expect(response!.status).toBe(204);
    expect(repository.getReflection(accountId, created.reflectionId).status).toBe("deleted");
    expect(repository.listCandidates(accountId, created.reflectionId)).toEqual([]);
    await expect(store.read("uploads", created.uploadId)).resolves.toBeNull();
    await expect(store.read("segments", created.uploadId)).resolves.toBeNull();
    await expect(store.read("daily-reflection-jobs", created.reflectionId)).resolves.toBeNull();
    await expect(access(upload!.filePath)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(upload!.filePath, "late raw audio");
    await Promise.all([
      store.write("uploads", created.uploadId, upload),
      store.write("segments", created.uploadId, [segment(created.uploadId)]),
      store.write("daily-reflection-jobs", created.reflectionId, job)
    ]);
    const repeated = await deleteDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${created.reflectionId}`, {
        method: "DELETE"
      }),
      params(created.reflectionId)
    );
    expect(repeated!.status).toBe(204);
    expect(repository.getReflection(accountId, created.reflectionId).status).toBe("deleted");
    await expect(store.read("uploads", created.uploadId)).resolves.toBeNull();
    await expect(store.read("segments", created.uploadId)).resolves.toBeNull();
    await expect(store.read("daily-reflection-jobs", created.reflectionId)).resolves.toBeNull();
    await expect(access(upload!.filePath)).rejects.toMatchObject({ code: "ENOENT" });

    const hidden = await getDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${created.reflectionId}`),
      params(created.reflectionId)
    );
    expect(hidden!.status).toBe(404);
  });

  it.each(["cancel", "delete"] as const)(
    "%s cleans planless provisional audio while preserving foreign account assets",
    async (action) => {
      const reflectionId = `reflection_provisional_cleanup_${action}`;
      const uploadId = `daily-reflection-${reflectionId}`;
      const created = repository.createReflection({
        id: reflectionId,
        accountId,
        uploadId: null,
        inputMethod: "browser_recording",
        sourceOrigin: "user_reflection",
        processingProfile: "full_recording",
        ingestionContext: "daily_reflection",
        idempotencyKey: `provisional-cleanup-${action}`
      }).reflection;
      const uploading = repository.transitionStatus({
        accountId,
        reflectionId,
        expectedVersion: created.version,
        status: "uploading"
      });
      const fence = repository.claimExecutionLease({
        accountId,
        reflectionId,
        leaseOwner: `provisional-cleanup-${action}`,
        leaseDurationMs: 60_000,
        uploadFingerprint: "b".repeat(64),
        provisionalUploadId: uploadId,
        allowedStatuses: ["uploading"]
      });
      expect(fence).toMatchObject({ attemptVersion: 1 });
      expect(repository.getReflection(accountId, reflectionId)).toMatchObject({
        version: uploading.version + 1,
        uploadId,
        processingProfile: "full_recording"
      });
      expect(repository.getProcessingPlan(accountId, reflectionId)).toBeNull();

      const attemptPath = join(uploadsRootDir, `${uploadId}.attempt-1.wav`);
      const chunkDirectory = join(uploadsRootDir, `${uploadId}-chunks`);
      const generatedChunkPath = join(chunkDirectory, "chunk-0.wav");
      const unrelatedPath = join(uploadsRootDir, "unrelated-private.wav");
      const foreignUploadsRoot = join(rootDir, `foreign-uploads-${action}`);
      const foreignAttemptPath = join(
        foreignUploadsRoot,
        `${uploadId}.attempt-1.wav`
      );
      const foreignStore = new JsonStore(join(rootDir, `foreign-store-${action}`));
      await Promise.all([
        mkdir(chunkDirectory, { recursive: true }),
        mkdir(foreignUploadsRoot, { recursive: true })
      ]);
      await Promise.all([
        writeFile(attemptPath, "private provisional audio"),
        writeFile(generatedChunkPath, "private generated chunk"),
        writeFile(unrelatedPath, "unrelated account audio"),
        writeFile(foreignAttemptPath, "foreign account private audio"),
        foreignStore.write("uploads", uploadId, {
          id: uploadId,
          reflectionId,
          filePath: foreignAttemptPath,
          persistenceAttemptVersion: 1
        }),
        store.write("uploads", uploadId, {
          id: uploadId,
          originalName: "reflection.wav",
          mimeType: "audio/wav",
          sizeBytes: 24,
          recordingDate: "2026-08-13",
          createdAt: "2026-08-13T08:00:00.000Z",
          status: "uploaded",
          filePath: attemptPath,
          ingestionContext: "daily_reflection",
          reflectionId,
          uploadFingerprint: "b".repeat(64),
          persistenceAttemptVersion: 1
        }),
        store.write("segments", uploadId, [segment(uploadId)]),
        store.write("audio-chunks", `${uploadId}_audio_chunk_00000`, {
          id: `${uploadId}_audio_chunk_00000`,
          uploadId,
          index: 0,
          startSeconds: 0,
          endSeconds: 1,
          durationSeconds: 1,
          source: { type: "generated_chunk", path: generatedChunkPath },
          status: "created",
          retryCount: 0,
          createdAt: "2026-08-13T08:00:00.000Z",
          updatedAt: "2026-08-13T08:00:00.000Z",
          metadata: {}
        }),
        store.write("daily-reflection-jobs", reflectionId, {
          id: `job-${reflectionId}`,
          reflectionId,
          uploadId,
          status: "waiting",
          progress: 0,
          executionMode: "inline",
          updatedAt: "2026-08-13T08:00:00.000Z"
        }),
        store.write(
          "daily-reflection-asset-attempts",
          `${reflectionId}-upload-attempt-1`,
          {
            accountId,
            reflectionId,
            uploadId,
            assetKind: "upload",
            attemptVersion: 1,
            payload: { id: uploadId }
          }
        ),
        store.write(
          "daily-reflection-asset-attempts",
          `${reflectionId}-foreign-attempt-1`,
          {
            accountId: otherAccountId,
            reflectionId,
            uploadId,
            assetKind: "upload",
            attemptVersion: 1,
            payload: { id: uploadId }
          }
        )
      ]);

      const invoke = () => action === "cancel"
        ? cancelDailyReflection(
            new Request(`http://localhost/api/daily-reflections/${reflectionId}/cancel`, {
              method: "POST"
            }),
            params(reflectionId)
          )
        : deleteDailyReflection(
            new Request(`http://localhost/api/daily-reflections/${reflectionId}`, {
              method: "DELETE"
            }),
            params(reflectionId)
          );

      setAccount(otherAccountId);
      const hidden = await invoke();
      expect(hidden!.status).toBe(404);
      await expect(access(attemptPath)).resolves.toBeUndefined();
      setAccount(accountId);

      const first = await invoke();
      const repeated = await invoke();
      expect(first!.status).toBe(action === "cancel" ? 200 : 204);
      expect(repeated!.status).toBe(action === "cancel" ? 200 : 204);
      await expect(access(attemptPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(generatedChunkPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(unrelatedPath)).resolves.toBeUndefined();
      await expect(access(foreignAttemptPath)).resolves.toBeUndefined();
      await expect(foreignStore.read("uploads", uploadId)).resolves.toMatchObject({
        reflectionId,
        filePath: foreignAttemptPath
      });
      await expect(store.read("uploads", uploadId)).resolves.toBeNull();
      await expect(store.read("segments", uploadId)).resolves.toBeNull();
      await expect(store.read("audio-chunks", `${uploadId}_audio_chunk_00000`))
        .resolves.toBeNull();
      await expect(store.read("daily-reflection-jobs", reflectionId)).resolves.toBeNull();
      await expect(store.listIds("daily-reflection-asset-attempts")).resolves.toEqual([
        `${reflectionId}-foreign-attempt-1`
      ]);
      await expect(store.read("deleted-uploads", uploadId)).resolves.toMatchObject({
        reflectionId,
        uploadId,
        cleanupStatus: "complete"
      });
    }
  );

  it("fails closed instead of deleting a sibling reflection path from provisional JSON", async () => {
    const reflectionId = "reflection_provisional_sibling_guard";
    const uploadId = `daily-reflection-${reflectionId}`;
    const created = repository.createReflection({
      id: reflectionId,
      accountId,
      uploadId: null,
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      idempotencyKey: "provisional-sibling-guard"
    }).reflection;
    const uploading = repository.transitionStatus({
      accountId,
      reflectionId,
      expectedVersion: created.version,
      status: "uploading"
    });
    expect(repository.claimExecutionLease({
      accountId,
      reflectionId,
      leaseOwner: "provisional-sibling-writer",
      leaseDurationMs: 60_000,
      uploadFingerprint: "d".repeat(64),
      provisionalUploadId: uploadId,
      allowedStatuses: [uploading.status]
    })).toMatchObject({ attemptVersion: 1 });
    const siblingPath = join(uploadsRootDir, "daily-reflection-sibling.attempt-1.wav");
    await mkdir(uploadsRootDir, { recursive: true });
    await writeFile(siblingPath, "sibling private audio");
    await store.write("uploads", uploadId, {
      id: uploadId,
      filePath: siblingPath,
      ingestionContext: "daily_reflection",
      reflectionId,
      persistenceAttemptVersion: 1
    });

    const response = await deleteDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}`, {
        method: "DELETE"
      }),
      params(reflectionId)
    );

    expect(response!.status).toBe(503);
    await expect(response!.json()).resolves.toMatchObject({
      error: "daily_reflection_cleanup_failed",
      retryable: true
    });
    await expect(access(siblingPath)).resolves.toBeUndefined();
    expect(repository.getReflection(accountId, reflectionId).status).toBe("deleted");
  });

  it.each(["cancel", "delete"] as const)(
    "%s cleans unpublished cross-process attempt assets idempotently",
    async (action) => {
      const reflectionId = `reflection_attempt_cleanup_${action}`;
      const uploadId = `upload_attempt_cleanup_${action}`;
      const created = repository.createReflection({
        id: reflectionId,
        accountId,
        uploadId,
        inputMethod: "file_upload",
        sourceOrigin: "user_reflection",
        processingProfile: "full_recording",
        ingestionContext: "daily_reflection",
        idempotencyKey: `attempt-cleanup-${action}`
      }).reflection;
      repository.transitionStatus({
        accountId,
        reflectionId,
        expectedVersion: created.version,
        status: "uploading"
      });
      await mkdir(uploadsRootDir, { recursive: true });
      await Promise.all([
        writeFile(join(uploadsRootDir, `${uploadId}.attempt-1.wav`), "attempt one"),
        writeFile(join(uploadsRootDir, `${uploadId}.attempt-2.mp3`), "attempt two"),
        writeFile(join(uploadsRootDir, "unrelated.wav"), "keep"),
        store.write(
          "daily-reflection-asset-attempts",
          `${reflectionId}-upload-attempt-1`,
          { reflectionId, uploadId, attemptVersion: 1 }
        )
      ]);

      const invoke = () => action === "cancel"
        ? cancelDailyReflection(
            new Request(`http://localhost/api/daily-reflections/${reflectionId}/cancel`, {
              method: "POST"
            }),
            params(reflectionId)
          )
        : deleteDailyReflection(
            new Request(`http://localhost/api/daily-reflections/${reflectionId}`, {
              method: "DELETE"
            }),
            params(reflectionId)
          );
      const first = await invoke();
      const repeated = await invoke();

      expect(first!.status).toBe(action === "cancel" ? 200 : 204);
      expect(repeated!.status).toBe(action === "cancel" ? 200 : 204);
      await expect(readdir(uploadsRootDir)).resolves.toEqual(["unrelated.wav"]);
      await expect(store.listIds("daily-reflection-asset-attempts"))
        .resolves.toEqual([]);
      await expect(store.read("deleted-uploads", uploadId)).resolves.toMatchObject({
        reflectionId,
        uploadId,
        filePath: null,
        cleanupStatus: "complete"
      });
    }
  );

  it("keeps failed attempt cleanup retryable until deletion completes", async () => {
    const reflectionId = "reflection_attempt_cleanup_retry";
    const uploadId = "upload_attempt_cleanup_retry";
    const created = repository.createReflection({
      id: reflectionId,
      accountId,
      uploadId,
      inputMethod: "file_upload",
      sourceOrigin: "user_reflection",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      idempotencyKey: "attempt-cleanup-retry"
    }).reflection;
    const uploading = repository.transitionStatus({
      accountId,
      reflectionId,
      expectedVersion: created.version,
      status: "uploading"
    });
    repository.transitionStatus({
      accountId,
      reflectionId,
      expectedVersion: uploading.version,
      status: "deleted"
    });
    const attemptPath = join(uploadsRootDir, `${uploadId}.attempt-1.wav`);
    await mkdir(uploadsRootDir, { recursive: true });
    await Promise.all([
      writeFile(attemptPath, "unfinished attempt"),
      store.write(
        "daily-reflection-asset-attempts",
        `${reflectionId}-upload-attempt-1`,
        { reflectionId, uploadId, attemptVersion: 1 }
      )
    ]);
    const failingRemove = vi.fn(async () => {
      throw new Error("simulated attempt cleanup failure");
    }) as unknown as typeof rm;

    await expect(cleanupDailyReflectionStagingAssets({
      store,
      repository,
      accountId,
      reflectionId,
      uploadId,
      uploadsRootDir,
      removeUpload: true,
      removeFile: failingRemove
    })).rejects.toThrow("simulated attempt cleanup failure");
    await expect(access(attemptPath)).resolves.toBeUndefined();
    await expect(store.read("deleted-uploads", uploadId)).resolves.toMatchObject({
      reflectionId,
      uploadId,
      cleanupStatus: "pending"
    });

    const retried = await deleteDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}`, {
        method: "DELETE"
      }),
      params(reflectionId)
    );
    expect(retried!.status).toBe(204);
    await expect(access(attemptPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.listIds("daily-reflection-asset-attempts"))
      .resolves.toEqual([]);
    await expect(store.read("deleted-uploads", uploadId)).resolves.toMatchObject({
      reflectionId,
      uploadId,
      cleanupStatus: "complete"
    });
  });

  it("rereads durable candidate revocation state in detail and history", async () => {
    const reflectionId = "reflection_revoked_read";
    const uploadId = "upload_revoked_read";
    createReviewPendingDetail({
      reflectionId,
      uploadId,
      sourceSegmentId: "segment_revoked_read"
    });
    const review = repository.getReflection(accountId, reflectionId);
    const candidate = repository.listCandidates(accountId, reflectionId)[0];
    const decided = repository.updateCandidateDecisions({
      accountId,
      reflectionId,
      expectedVersion: review.version,
      candidates: [{
        candidateId: candidate.id,
        status: "kept",
        userText: null,
        subjectPersonId: null
      }]
    });
    admitDailyReflectionUnderLeaseMock.mockImplementationOnce(async (input: {
      accountId: string;
      reflectionId: string;
      leaseOwner: string;
      leaseDurationMs: number;
    }) => {
      const claim = repository.startAdmissionOperation(input);
      if (!claim.executionFence) throw new Error("expected admission fence");
      return repository.completeAdmissionOperation({
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        leaseOwner: claim.executionFence.leaseOwner,
        attemptVersion: claim.executionFence.attemptVersion,
        results: [{
          candidateId: candidate.id,
          status: "admitted",
          memoryId: "memory_revoked_read",
          reasonCode: null,
          errorCode: null,
          operationKey: "admission-revoked-read",
          updatedAt: "2026-08-13T08:00:00.000Z"
        }]
      }).results;
    });
    const finalized = await finalizeDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: decided.reflection.version,
          idempotencyKey: "finalize-revoked-read"
        })
      }),
      params(reflectionId)
    );
    expect(finalized.status).toBe(200);

    const completed = repository.getReflection(accountId, reflectionId);
    repository.prepareCandidateRevocation({
      accountId,
      reflectionId,
      candidateId: candidate.id,
      expectedVersion: completed.version,
      idempotencyKey: "revoke-read-key"
    });
    const claimed = repository.startCandidateRevocation({
      accountId,
      reflectionId,
      candidateId: candidate.id,
      leaseOwner: "revoke-read-worker",
      leaseDurationMs: 60_000,
      now: "2026-08-13T08:00:00.000Z"
    });
    if (!claimed.executionFence) throw new Error("expected revocation fence");
    repository.completeCandidateRevocation({
      accountId,
      reflectionId,
      candidateId: candidate.id,
      leaseOwner: claimed.executionFence.leaseOwner,
      attemptVersion: claimed.executionFence.attemptVersion,
      result: {
        outcome: "revoked",
        memoryId: "memory_revoked_read",
        removedMemoryEvidenceCount: 1,
        removedPersonSourceCount: 0
      },
      indexRefreshRequired: false,
      now: "2026-08-13T08:00:01.000Z"
    });

    const detailResponse = await getDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}`),
      params(reflectionId)
    );
    expect(detailResponse!.status).toBe(200);
    await expect(detailResponse!.json()).resolves.toMatchObject({
      rememberedCount: 0,
      revokedCandidateIds: [candidate.id]
    });
    const historyResponse = await listDailyReflections(
      new Request("http://localhost/api/daily-reflections")
    );
    const history = DailyReflectionHistoryResponseSchema.parse(await historyResponse.json());
    expect(history.reflections.find((item) => item.id === reflectionId)).toMatchObject({
      rememberedCount: 0,
      notSavedCount: 1
    });

    setAccount(otherAccountId);
    const hidden = await getDailyReflection(
      new Request(`http://localhost/api/daily-reflections/${reflectionId}`),
      params(reflectionId)
    );
    expect(hidden!.status).toBe(404);
  });

  it("exposes a strict account-scoped candidate revocation route", async () => {
    const revoke = vi.fn(async () => ({
      operation: { status: "completed" },
      receipt: { outcome: "revoked" },
      rememberedCount: 1,
      reused: false
    }));
    moduleState.candidateRevocationService = { revoke };
    moduleState.repository = {
      getReflection: vi.fn(() => ({ status: "completed", version: 9 }))
    };
    const response = await revokeDailyReflectionCandidate(
      new Request("http://localhost/api/daily-reflections/reflection_route/candidates/candidate_route/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: 8, idempotencyKey: "revoke-route-key" })
      }),
      candidateParams("reflection_route", "candidate_route")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      reflectionStatus: "completed",
      reflectionVersion: 9,
      revocationStatus: "completed",
      outcome: "revoked",
      rememberedCount: 1
    });
    expect(revoke).toHaveBeenCalledWith({
      accountId,
      reflectionId: "reflection_route",
      candidateId: "candidate_route",
      expectedVersion: 8,
      idempotencyKey: "revoke-route-key"
    });

    const invalid = await revokeDailyReflectionCandidate(
      new Request("http://localhost/api/daily-reflections/reflection_route/candidates/candidate_route/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: 9,
          idempotencyKey: "another-key",
          quote: "client-forged evidence"
        })
      }),
      candidateParams("reflection_route", "candidate_route")
    );
    expect(invalid.status).toBe(400);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
