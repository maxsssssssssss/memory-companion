// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

import type { JsonStore } from "@/lib/server/storage/json-store";

import type {
  DcVoiceEnrollmentDispatchCandidate,
  DcVoiceEnrollmentDispatchJob
} from "./types";
import {
  createConfiguredDateCompanionVoiceEnrollmentDispatcher,
  startDateCompanionVoiceEnrollmentWorker,
  type DateCompanionVoiceEnrollmentCandidateRepository,
  type DateCompanionVoiceEnrollmentRuntimeConfig,
  type DateCompanionVoiceEnrollmentWorkerRuntime
} from "./voice-enrollment-runtime";
import {
  resolveDateCompanionVoiceEnrollmentAvailability,
  type DateCompanionVoiceEnrollmentDispatcher
} from "./voice-enrollment";

const config: DateCompanionVoiceEnrollmentRuntimeConfig = {
  pollIntervalMs: 60_000,
  maxAttempts: 3,
  retryBaseMs: 1_000,
  retryMaxMs: 4_000,
  batchSize: 10
};

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

function dispatchJob(overrides: Partial<DcVoiceEnrollmentDispatchJob> = {}): DcVoiceEnrollmentDispatchJob {
  return {
    id: "outbox_1",
    userId: "user_1",
    relationshipId: "relationship_1",
    interactionId: "interaction_1",
    snapshotId: "snapshot_1",
    idempotencyKey: "voice_enrollment_stable_request",
    providerSpeakerId: "contact_ta_stable",
    expectedGlobalSpeakerId: "contact_global_stable",
    sourceUploadId: "upload_1",
    providerRecordId: "provider_record_1",
    chunkId: "chunk_1",
    localSpeaker: "speaker_1",
    speakerIds: ["speaker_1"],
    attemptCount: 1,
    claimToken: "claim_1",
    leaseExpiresAt: "2026-08-05T12:05:00.000Z",
    ...overrides
  };
}

function candidate(overrides: Partial<DcVoiceEnrollmentDispatchCandidate> = {}): DcVoiceEnrollmentDispatchCandidate {
  return {
    outboxId: "outbox_1",
    userId: "user_1",
    status: "pending",
    attemptCount: 0,
    updatedAt: "2026-08-05T12:00:00.000Z",
    ...overrides
  };
}

function statefulRepository(input: {
  now: () => number;
  initial?: DcVoiceEnrollmentDispatchCandidate;
  job?: DcVoiceEnrollmentDispatchJob;
}) {
  let current: (Omit<DcVoiceEnrollmentDispatchCandidate, "status"> & {
    status: "pending" | "processing" | "failed" | "completed";
  }) = input.initial ?? candidate();
  const job = input.job ?? dispatchJob();
  const repository = {
    listVoiceEnrollmentDispatchCandidates: vi.fn(() =>
      current.status === "completed" ? [] : [{ ...current }]
    ),
    claimVoiceEnrollment: vi.fn(() => {
      current = {
        ...current,
        status: "processing",
        attemptCount: current.attemptCount + 1,
        updatedAt: new Date(input.now()).toISOString(),
        leaseExpiresAt: new Date(input.now() + 300_000).toISOString()
      };
      return {
        ...job,
        attemptCount: current.attemptCount,
        claimToken: `claim_${current.attemptCount}`,
        leaseExpiresAt: current.leaseExpiresAt
      };
    }),
    failVoiceEnrollment: vi.fn(() => {
      current = {
        ...current,
        status: "failed",
        updatedAt: new Date(input.now()).toISOString(),
        leaseExpiresAt: undefined
      };
    }),
    completeVoiceEnrollment: vi.fn(() => {
      current = { ...current, status: "completed", updatedAt: new Date(input.now()).toISOString() };
      return { idempotent: false, continuityKey: "voice:contact_global_stable" };
    })
  };
  return {
    repository: repository as unknown as DateCompanionVoiceEnrollmentCandidateRepository,
    spies: repository,
    current: () => ({ ...current })
  };
}

function startTestRuntime(options: {
  repository: DateCompanionVoiceEnrollmentCandidateRepository;
  now?: () => number;
  dispatcher?: DateCompanionVoiceEnrollmentDispatcher;
  dispatchCandidate?: (
    value: DcVoiceEnrollmentDispatchCandidate
  ) => Promise<{ status: "completed" | "failed" }>;
}): DateCompanionVoiceEnrollmentWorkerRuntime {
  return startDateCompanionVoiceEnrollmentWorker({
    enabled: true,
    config,
    repository: options.repository,
    now: options.now,
    dispatcher: options.dispatcher,
    dispatchCandidate: options.dispatchCandidate,
    logger: silentLogger,
    startImmediately: false
  });
}

describe("Date Companion voice enrollment Worker", () => {
  it("is disabled by default", () => {
    expect(() => startDateCompanionVoiceEnrollmentWorker({
      enabled: false
    })).toThrow("disabled");
  });

  it("requires queue mode and validated shared storage in production", () => {
    expect(resolveDateCompanionVoiceEnrollmentAvailability({
      DATE_COMPANION_VOICE_ENROLLMENT_ENABLED: "true",
      PIPELINE_EXECUTION_MODE: "inline"
    })).toEqual({ available: false, reason: "execution_mode_not_queue" });
    expect(resolveDateCompanionVoiceEnrollmentAvailability({
      DATE_COMPANION_VOICE_ENROLLMENT_ENABLED: "true",
      PIPELINE_EXECUTION_MODE: "queue",
      APP_DATA_DIR: ".data",
      APP_STORAGE_MODE: "server"
    })).toEqual({ available: false, reason: "queue_configuration_invalid" });
    expect(resolveDateCompanionVoiceEnrollmentAvailability({
      DATE_COMPANION_VOICE_ENROLLMENT_ENABLED: "true",
      PIPELINE_EXECUTION_MODE: "queue",
      APP_DATA_DIR: resolve("voice-enrollment-shared-data"),
      APP_STORAGE_MODE: "server",
      PIPELINE_WORKER_CONCURRENCY: "1"
    })).toEqual({ available: true, reason: "available" });
  });

  it("claims, dispatches, and completes a pending enrollment", async () => {
    let now = Date.parse("2026-08-05T12:00:00.000Z");
    const state = statefulRepository({ now: () => now });
    const enroll = vi.fn(async () => ({ profileGlobalSpeakerId: "contact_global_stable" }));
    const runtime = startTestRuntime({
      repository: state.repository,
      now: () => now,
      dispatcher: { enroll }
    });

    await expect(runtime.pollNow()).resolves.toMatchObject({
      scanned: 1,
      eligible: 1,
      dispatched: 1,
      completed: 1,
      failed: 0
    });
    expect(state.spies.claimVoiceEnrollment).toHaveBeenCalledOnce();
    expect(state.spies.completeVoiceEnrollment).toHaveBeenCalledOnce();
    expect(state.current().status).toBe("completed");
    await runtime.close();
  });

  it("backs off a Provider failure and retries with the same stable request", async () => {
    let now = Date.parse("2026-08-05T12:00:00.000Z");
    const state = statefulRepository({ now: () => now });
    const providerError = Object.assign(new Error("provider unavailable"), {
      code: "provider_unavailable"
    });
    const enroll = vi.fn()
      .mockRejectedValueOnce(providerError)
      .mockResolvedValueOnce({ profileGlobalSpeakerId: "contact_global_stable" });
    const runtime = startTestRuntime({
      repository: state.repository,
      now: () => now,
      dispatcher: { enroll }
    });

    await expect(runtime.pollNow()).resolves.toMatchObject({ failed: 1, completed: 0 });
    expect(state.current()).toMatchObject({ status: "failed", attemptCount: 1 });
    await expect(runtime.pollNow()).resolves.toMatchObject({ eligible: 0, dispatched: 0 });
    expect(enroll).toHaveBeenCalledTimes(1);

    now += config.retryBaseMs;
    await expect(runtime.pollNow()).resolves.toMatchObject({ completed: 1, failed: 0 });
    expect(enroll).toHaveBeenCalledTimes(2);
    expect(enroll.mock.calls[0][0].idempotencyKey).toBe(enroll.mock.calls[1][0].idempotencyKey);
    expect(state.spies.failVoiceEnrollment).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "provider_unavailable" })
    );
    await runtime.close();
  });

  it("deduplicates overlapping polls so one candidate is never dispatched twice", async () => {
    const state = statefulRepository({ now: () => Date.parse("2026-08-05T12:00:00.000Z") });
    let resolveDispatch: ((value: { status: "completed" }) => void) | undefined;
    const dispatchCandidate = vi.fn(() => new Promise<{ status: "completed" }>((resolve) => {
      resolveDispatch = resolve;
    }));
    const runtime = startTestRuntime({
      repository: state.repository,
      dispatchCandidate
    });

    const first = runtime.pollNow();
    const second = runtime.pollNow();
    await vi.waitFor(() => expect(dispatchCandidate).toHaveBeenCalledOnce());
    resolveDispatch?.({ status: "completed" });
    await Promise.all([first, second]);

    expect(state.spies.listVoiceEnrollmentDispatchCandidates).toHaveBeenCalledOnce();
    expect(dispatchCandidate).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it("reclaims an expired lease after restart but not an active lease", async () => {
    const now = Date.parse("2026-08-05T12:10:00.000Z");
    const expired = statefulRepository({
      now: () => now,
      initial: candidate({
        status: "processing",
        attemptCount: 1,
        leaseExpiresAt: "2026-08-05T12:05:00.000Z"
      })
    });
    const dispatchExpired = vi.fn(async () => ({ status: "completed" as const }));
    const restarted = startTestRuntime({
      repository: expired.repository,
      now: () => now,
      dispatchCandidate: dispatchExpired
    });
    await expect(restarted.pollNow()).resolves.toMatchObject({ eligible: 1, dispatched: 1 });
    expect(dispatchExpired).toHaveBeenCalledOnce();
    await restarted.close();

    const active = statefulRepository({
      now: () => now,
      initial: candidate({
        status: "processing",
        attemptCount: 1,
        leaseExpiresAt: "2026-08-05T12:15:00.000Z"
      })
    });
    const dispatchActive = vi.fn(async () => ({ status: "completed" as const }));
    const activeRuntime = startTestRuntime({
      repository: active.repository,
      now: () => now,
      dispatchCandidate: dispatchActive
    });
    await expect(activeRuntime.pollNow()).resolves.toMatchObject({ eligible: 0, dispatched: 0 });
    expect(dispatchActive).not.toHaveBeenCalled();
    await activeRuntime.close();
  });

  it("never dispatches after the bounded attempt limit", async () => {
    const state = statefulRepository({
      now: () => Date.parse("2026-08-05T12:10:00.000Z"),
      initial: candidate({
        status: "failed",
        attemptCount: config.maxAttempts,
        updatedAt: "2026-08-05T00:00:00.000Z"
      })
    });
    const dispatchCandidate = vi.fn(async () => ({ status: "completed" as const }));
    const runtime = startTestRuntime({
      repository: state.repository,
      now: () => Date.parse("2026-08-05T12:10:00.000Z"),
      dispatchCandidate
    });

    await expect(runtime.pollNow()).resolves.toMatchObject({ eligible: 0, dispatched: 0 });
    expect(dispatchCandidate).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("maps the durable job to saveContact and fails closed on an unexpected profile", async () => {
    const saveContact = vi.fn(async () => ({
      profile: { globalSpeakerId: "contact_global_stable" }
    }));
    const dispatcher = createConfiguredDateCompanionVoiceEnrollmentDispatcher({
      getUserStore: () => ({}) as JsonStore,
      createService: () => ({ saveContact })
    });
    await expect(dispatcher.enroll(dispatchJob())).resolves.toEqual({
      profileGlobalSpeakerId: "contact_global_stable"
    });
    expect(saveContact).toHaveBeenCalledWith({
      userId: "user_1",
      requestId: "voice_enrollment_stable_request",
      recordId: "provider_record_1",
      uploadId: "upload_1",
      chunkId: "chunk_1",
      localSpeaker: "speaker_1",
      globalSpeakerId: "contact_global_stable",
      displayName: "Ta",
      providerSpeakerId: "contact_ta_stable"
    });

    const mismatch = createConfiguredDateCompanionVoiceEnrollmentDispatcher({
      getUserStore: () => ({}) as JsonStore,
      createService: () => ({
        saveContact: async () => ({ profile: { globalSpeakerId: "unexpected_profile" } })
      })
    });
    await expect(mismatch.enroll(dispatchJob())).rejects.toMatchObject({
      code: "voice_enrollment_profile_mismatch"
    });

    const state = statefulRepository({
      now: () => Date.parse("2026-08-05T12:00:00.000Z")
    });
    const mismatchRuntime = startTestRuntime({
      repository: state.repository,
      dispatcher: mismatch
    });
    await expect(mismatchRuntime.pollNow()).resolves.toMatchObject({
      completed: 0,
      failed: 1
    });
    expect(state.spies.completeVoiceEnrollment).not.toHaveBeenCalled();
    expect(state.spies.failVoiceEnrollment).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "voice_enrollment_profile_mismatch" })
    );
    await mismatchRuntime.close();
  });

  it("waits for an in-flight dispatch during idempotent shutdown", async () => {
    const state = statefulRepository({ now: () => Date.parse("2026-08-05T12:00:00.000Z") });
    let resolveDispatch: ((value: { status: "completed" }) => void) | undefined;
    const runtime = startTestRuntime({
      repository: state.repository,
      dispatchCandidate: () => new Promise((resolve) => {
        resolveDispatch = resolve;
      })
    });
    const poll = runtime.pollNow();
    await vi.waitFor(() => expect(state.spies.listVoiceEnrollmentDispatchCandidates).toHaveBeenCalledOnce());
    const close = runtime.close();
    let closed = false;
    void close.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    resolveDispatch?.({ status: "completed" });
    await Promise.all([poll, close, runtime.close(), runtime.runPromise]);
    expect(closed).toBe(true);
  });
});
