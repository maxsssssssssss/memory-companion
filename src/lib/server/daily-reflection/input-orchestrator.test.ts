import type Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonStore } from "@/lib/server/storage/json-store";

import { openDailyReflectionDatabase } from "./db";
import {
  DailyReflectionInputContractError,
  DailyReflectionInputOrchestrator,
  resolveDailyReflectionInputContract
} from "./input-orchestrator";
import {
  DailyReflectionConflictError,
  DailyReflectionRepository
} from "./repository";

const NOW = "2026-08-21T00:00:00.000Z";
const CONTENT_HASH = "a".repeat(64);

let database: Database.Database;
let repository: DailyReflectionRepository;
let orchestrator: DailyReflectionInputOrchestrator;
let storeRoot: string;
let store: JsonStore;
let generatedId = 0;

beforeEach(async () => {
  database = openDailyReflectionDatabase({ filePath: ":memory:" });
  repository = new DailyReflectionRepository(database, {
    now: () => NOW,
    idFactory: () => `reflection_input_${++generatedId}`
  });
  orchestrator = new DailyReflectionInputOrchestrator(repository);
  storeRoot = await mkdtemp(join(tmpdir(), "daily-reflection-input-"));
  store = new JsonStore(storeRoot);
});

afterEach(async () => {
  database.close();
  await rm(storeRoot, { recursive: true, force: true });
});

function contract(input: {
  inputMethod: "file_upload" | "browser_recording";
  inputAdapter?: "file_picker" | "browser_recorder" | "toy_sync";
  sourceOrigin?: "user_reflection" | "direct_conversation";
  operationKey?: string;
}) {
  return resolveDailyReflectionInputContract({
    inputMethod: input.inputMethod,
    inputAdapter: input.inputAdapter,
    sourceOrigin: input.sourceOrigin ?? "user_reflection",
    capturePurpose: "inspiration_capture",
    operationKey: input.operationKey ?? `operation_${input.inputAdapter ?? input.inputMethod}`,
    recordingDate: "2026-08-21"
  });
}

describe("DailyReflectionInputOrchestrator", () => {
  it.each([
    ["file_upload", "file_picker"],
    ["browser_recording", "browser_recorder"],
    ["file_upload", "toy_sync"]
  ] as const)("validates %s and %s through one contract", (inputMethod, inputAdapter) => {
    expect(contract({
      inputMethod,
      inputAdapter,
      sourceOrigin: "direct_conversation"
    })).toEqual({
      inputMethod,
      inputAdapter,
      sourceOrigin: "direct_conversation",
      capturePurpose: "inspiration_capture",
      operationKey: `operation_${inputAdapter}`,
      recordingDate: "2026-08-21"
    });
  });

  it("keeps adapter and source validation independent and rejects adapter mismatches", () => {
    expect(() => resolveDailyReflectionInputContract({
      inputMethod: "browser_recording",
      inputAdapter: "browser_recorder",
      sourceOrigin: "unknown",
      capturePurpose: "inspiration_capture",
      operationKey: "operation_source_invalid",
      recordingDate: "2026-08-21"
    })).toThrowError(expect.objectContaining<Partial<DailyReflectionInputContractError>>({
      code: "invalid_source_origin"
    }));
    expect(() => contract({
      inputMethod: "browser_recording",
      inputAdapter: "toy_sync"
    })).toThrowError(expect.objectContaining<Partial<DailyReflectionInputContractError>>({
      code: "invalid_input_adapter"
    }));
  });

  it("replays one durable receipt, fails closed on conflicting content, and isolates accounts", () => {
    const resolved = contract({
      inputMethod: "file_upload",
      inputAdapter: "file_picker",
      operationKey: "operation_replay"
    });
    const first = orchestrator.reserve({
      accountId: "account_1",
      ...resolved,
      contentHash: CONTENT_HASH
    });
    const replay = orchestrator.reserve({
      accountId: "account_1",
      ...resolved,
      contentHash: CONTENT_HASH
    });
    expect(replay.reused).toBe(true);
    expect(replay.receipt).toEqual(first.receipt);
    expect(repository.getInputReceiptV2("account_1", "operation_replay"))
      .toEqual(first.receipt);
    expect(() => orchestrator.reserve({
      accountId: "account_1",
      ...resolved,
      contentHash: "b".repeat(64)
    })).toThrowError(expect.objectContaining<Partial<DailyReflectionConflictError>>({
      code: "daily_reflection_idempotency_conflict"
    }));
    expect(orchestrator.reserve({
      accountId: "account_2",
      ...resolved,
      contentHash: "b".repeat(64)
    }).receipt.accountId).toBe("account_2");
  });

  it.each([
    ["file_upload", "file_picker", 29_000, "quick_reflection", 3],
    ["browser_recording", "browser_recorder", 180_000, "quick_reflection", 3],
    ["file_upload", "toy_sync", 180_001, "full_recording", 5]
  ] as const)(
    "binds a V2 plan and durable job for %s/%s",
    async (inputMethod, inputAdapter, effectiveDurationMs, processingProfile, candidateLimit) => {
      const reserved = orchestrator.reserve({
        accountId: "account_1",
        ...contract({
          inputMethod,
          inputAdapter,
          operationKey: `operation_plan_${inputAdapter}`
        }),
        contentHash: CONTENT_HASH
      });
      const uploading = repository.transitionStatus({
        accountId: "account_1",
        reflectionId: reserved.reflection.id,
        expectedVersion: reserved.reflection.version,
        status: "uploading"
      });
      const fence = orchestrator.claimStaging({
        receipt: reserved.receipt,
        leaseOwner: `lease_${inputAdapter}`,
        leaseDurationMs: 60_000
      });
      expect(fence).not.toBeNull();
      const bound = orchestrator.bindAuthoritativePlan({
        receipt: reserved.receipt,
        expectedVersion: uploading.version + 1,
        duration: {
          inputMethod,
          inputAdapter,
          effectiveDurationMs,
          clientReportedDurationMs: null,
          durationSource: "server_ffprobe",
          processingProfile
        },
        fence: fence!
      });
      expect(bound.processingPlan).toMatchObject({
        planVersion: 2,
        inputAdapter,
        effectiveDurationMs,
        processingProfile,
        candidateLimit
      });
      const job = await orchestrator.ensureDurableJob({
        store,
        receipt: reserved.receipt,
        executionMode: "inline"
      });
      expect(job.id).toBe(reserved.receipt.jobId);
      await expect(orchestrator.ensureDurableJob({
        store,
        receipt: reserved.receipt,
        executionMode: "inline"
      })).resolves.toEqual(job);
    }
  );
});
