import { describe, expect, it, vi } from "vitest";

import type {
  RecoverStaleWorkMeetingsInput,
  WorkMeetingRecoveryDependencies,
  WorkMeetingRecoverySummary
} from "@/lib/server/work-review/recovery";
import { getUserUploadsRootDir } from "@/lib/server/auth/session";
import { JsonStore } from "@/lib/server/storage/json-store";

import { runWorkReviewStartupRecovery } from "./work-review-recovery-runtime";

const ENABLED_ENV = {
  WORK_REVIEW_ENABLED: "true",
  WORK_REVIEW_UPLOAD_ENABLED: "true",
  WORK_REVIEW_ANALYSIS_ENABLED: "true",
  WORK_REVIEW_RECOVERY_ENABLED: "true"
} as const;

const EMPTY_SUMMARY: WorkMeetingRecoverySummary = {
  selected: 0,
  completed: 0,
  recovered: 0,
  failed: 0,
  skippedBusy: 0,
  skippedChanged: 0,
  skippedDeleted: 0,
  errors: 0
};

describe("Work Review startup recovery runtime", () => {
  it.each([
    ["disabled top-level flag", {
      WORK_REVIEW_ENABLED: "false"
    }],
    ["disabled recovery flag", {
      ...ENABLED_ENV,
      WORK_REVIEW_RECOVERY_ENABLED: "false"
    }],
    ["disabled parent upload flag", {
      ...ENABLED_ENV,
      WORK_REVIEW_UPLOAD_ENABLED: "false"
    }]
  ])("does not touch recovery dependencies when %s", async (_label, env) => {
    const recoverStaleWorkMeetings = vi.fn();
    const resolveRuntime = vi.fn();
    const logger = { info: vi.fn() };

    await expect(runWorkReviewStartupRecovery(env, {
      recoverStaleWorkMeetings,
      resolveRuntime,
      logger
    })).resolves.toBeNull();

    expect(recoverStaleWorkMeetings).not.toHaveBeenCalled();
    expect(resolveRuntime).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("runs exactly one bounded Core recovery pass with default-on Work stages", async () => {
    const runtime = {
      store: { kind: "account-store" },
      uploadsRootDir: "C:/data/users/account_a/uploads"
    };
    const resolveRuntime = vi.fn().mockReturnValue(runtime);
    const summary: WorkMeetingRecoverySummary = {
      ...EMPTY_SUMMARY,
      selected: 1,
      completed: 1,
      recovered: 1
    };
    const recoverStaleWorkMeetings = vi.fn(async (
      input: RecoverStaleWorkMeetingsInput,
      dependencies?: WorkMeetingRecoveryDependencies
    ) => {
      expect(input).not.toHaveProperty("batchSize");
      expect(input).not.toHaveProperty("staleAfterMs");
      expect(await input.resolveRuntime("account_a")).toBe(runtime);
      dependencies?.onProgress?.({
        completed: 0,
        total: 1,
        state: "started"
      });
      dependencies?.onProgress?.({
        completed: 1,
        total: 1,
        state: "processing",
        outcome: "recovered"
      });
      dependencies?.onProgress?.({
        completed: 1,
        total: 1,
        state: "completed"
      });
      return summary;
    });
    const logger = { info: vi.fn() };

    await expect(runWorkReviewStartupRecovery({}, {
      recoverStaleWorkMeetings,
      resolveRuntime,
      logger
    })).resolves.toEqual(summary);

    expect(recoverStaleWorkMeetings).toHaveBeenCalledTimes(1);
    expect(recoverStaleWorkMeetings).toHaveBeenCalledWith(expect.objectContaining({
      allowTranscription: true,
      allowAnalysis: true,
      resolveRuntime
    }), expect.objectContaining({ onProgress: expect.any(Function) }));
    expect(resolveRuntime).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "[work-review-worker] recovery progress=1/1 state=processing outcome=recovered"
    );
    expect(logger.info).toHaveBeenLastCalledWith(
      "[work-review-worker] recovery selected=1 completed=1 recovered=1 " +
      "failed=0 skipped_busy=0 skipped_changed=0 skipped_deleted=0 errors=0"
    );
    expect(logger.info.mock.calls.flat().join(" ")).not.toContain("account_a");
  });

  it("keeps analysis recovery closed when only Work upload recovery is enabled", async () => {
    const recoverStaleWorkMeetings = vi.fn().mockResolvedValue(EMPTY_SUMMARY);

    await runWorkReviewStartupRecovery({
      ...ENABLED_ENV,
      WORK_REVIEW_ANALYSIS_ENABLED: "false"
    }, {
      recoverStaleWorkMeetings,
      resolveRuntime: vi.fn(),
      logger: { info: vi.fn() }
    });

    expect(recoverStaleWorkMeetings).toHaveBeenCalledWith(
      expect.objectContaining({
        allowTranscription: true,
        allowAnalysis: false
      }),
      expect.any(Object)
    );
  });

  it("resolves the default runtime to the candidate account's scoped store", async () => {
    const recoverStaleWorkMeetings = vi.fn(async (
      input: RecoverStaleWorkMeetingsInput
    ) => {
      const runtime = await input.resolveRuntime("account_a");
      expect(runtime?.store).toBeInstanceOf(JsonStore);
      expect(runtime?.uploadsRootDir).toBe(getUserUploadsRootDir("account_a"));
      return EMPTY_SUMMARY;
    });

    await runWorkReviewStartupRecovery(ENABLED_ENV, {
      recoverStaleWorkMeetings,
      logger: { info: vi.fn() }
    });

    expect(recoverStaleWorkMeetings).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight recovery pass across concurrent startup callers", async () => {
    let completeRecovery!: (summary: WorkMeetingRecoverySummary) => void;
    const pendingRecovery = new Promise<WorkMeetingRecoverySummary>((resolve) => {
      completeRecovery = resolve;
    });
    const recoverStaleWorkMeetings = vi.fn().mockReturnValue(pendingRecovery);
    const dependencies = {
      recoverStaleWorkMeetings,
      resolveRuntime: vi.fn(),
      logger: { info: vi.fn() }
    };

    const first = runWorkReviewStartupRecovery(ENABLED_ENV, dependencies);
    const second = runWorkReviewStartupRecovery(ENABLED_ENV, dependencies);

    expect(recoverStaleWorkMeetings).toHaveBeenCalledTimes(1);
    completeRecovery(EMPTY_SUMMARY);
    await expect(Promise.all([first, second])).resolves.toEqual([
      EMPTY_SUMMARY,
      EMPTY_SUMMARY
    ]);
    expect(dependencies.logger.info).toHaveBeenCalledTimes(1);
  });

  it("propagates Core failures so the existing worker startup cleanup stays fail closed", async () => {
    const failure = new Error("recovery unavailable");
    const recoverStaleWorkMeetings = vi.fn().mockRejectedValue(failure);

    await expect(runWorkReviewStartupRecovery(ENABLED_ENV, {
      recoverStaleWorkMeetings,
      resolveRuntime: vi.fn(),
      logger: { info: vi.fn() }
    })).rejects.toBe(failure);

    expect(recoverStaleWorkMeetings).toHaveBeenCalledTimes(1);
  });
});
