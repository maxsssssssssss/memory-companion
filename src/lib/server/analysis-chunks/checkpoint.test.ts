import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonStore } from "@/lib/server/storage/json-store";
import {
  AnalysisChunkCheckpointSchema,
  JsonAnalysisChunkCheckpointStore,
  buildAnalysisCheckpointId,
  executeWithAnalysisCheckpoint,
  fingerprintAnalysisInput
} from "./checkpoint";

const OutputSchema = z.object({ values: z.array(z.string()) }).strict();
const now = "2026-07-15T08:00:00.000Z";
let tempDir: string | undefined;

async function setup() {
  tempDir = await mkdtemp(join(tmpdir(), "analysis-checkpoint-"));
  const store = new JsonStore(tempDir);
  return { store, checkpoints: new JsonAnalysisChunkCheckpointStore(store) };
}

function executionInput(
  checkpoints: JsonAnalysisChunkCheckpointStore,
  execute: () => Promise<{ output: { values: string[] }; resultSource: "provider_success" }>
) {
  return {
    store: checkpoints,
    userId: "user_a",
    uploadId: "upload_a",
    kind: "daily_brief" as const,
    sourceChunkId: "source_chunk_0",
    sourceChunkIndex: 0,
    inputFingerprint: fingerprintAnalysisInput({ text: "same input" }),
    processorFingerprint: fingerprintAnalysisInput({ processor: "v1" }),
    outputSchema: OutputSchema,
    staleAfterMs: 60_000,
    now: () => now,
    execute
  };
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("analysis chunk checkpoints", () => {
  it("reuses a valid completed checkpoint without executing the provider", async () => {
    const { checkpoints } = await setup();
    const execute = vi.fn(async () => ({ output: { values: ["one"] }, resultSource: "provider_success" as const }));
    const input = executionInput(checkpoints, execute);

    const first = await executeWithAnalysisCheckpoint(input);
    const second = await executeWithAnalysisCheckpoint(input);

    expect(first.cacheStatus).toBe("miss");
    expect(second.cacheStatus).toBe("hit");
    expect(second.output).toEqual({ values: ["one"] });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reuses a rule fallback without relabelling it as provider success", async () => {
    const { checkpoints } = await setup();
    const execute = vi.fn(async () => ({ output: { values: ["fallback"] }, resultSource: "rule_fallback" as const }));
    const input = { ...executionInput(checkpoints, execute as never), execute };

    const first = await executeWithAnalysisCheckpoint(input);
    const second = await executeWithAnalysisCheckpoint(input);

    expect(first.resultSource).toBe("rule_fallback");
    expect(second.resultSource).toBe("rule_fallback");
    expect(second.cacheStatus).toBe("hit");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(["inputFingerprint", "processorFingerprint"] as const)(
    "reprocesses when %s changes",
    async (field) => {
      const { checkpoints } = await setup();
      const execute = vi.fn(async () => ({ output: { values: [String(execute.mock.calls.length)] }, resultSource: "provider_success" as const }));
      const input = executionInput(checkpoints, execute);
      await executeWithAnalysisCheckpoint(input);

      const result = await executeWithAnalysisCheckpoint({ ...input, [field]: fingerprintAnalysisInput({ changed: field }) });

      expect(result.cacheStatus).toBe("stale");
      expect(execute).toHaveBeenCalledTimes(2);
    }
  );

  it("ignores corrupt JSON and replaces it with a valid completed checkpoint", async () => {
    const { checkpoints } = await setup();
    const execute = vi.fn(async () => ({ output: { values: ["recovered"] }, resultSource: "provider_success" as const }));
    const input = executionInput(checkpoints, execute);
    const id = buildAnalysisCheckpointId(input);
    const directory = join(tempDir!, "analysis-chunks");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${id}.json`), "{broken", "utf8");

    const result = await executeWithAnalysisCheckpoint(input);

    expect(result.cacheStatus).toBe("corrupt");
    expect(AnalysisChunkCheckpointSchema.parse(await checkpoints.read(id)).status).toBe("completed");
  });

  it("does not reuse a completed checkpoint whose output fails the current schema", async () => {
    const { checkpoints } = await setup();
    const execute = vi.fn(async () => ({ output: { values: ["valid"] }, resultSource: "provider_success" as const }));
    const input = executionInput(checkpoints, execute);
    const id = buildAnalysisCheckpointId(input);
    await checkpoints.write({
      version: 1,
      id,
      userId: input.userId,
      uploadId: input.uploadId,
      kind: input.kind,
      sourceChunkId: input.sourceChunkId,
      sourceChunkIndex: input.sourceChunkIndex,
      inputFingerprint: input.inputFingerprint,
      processorFingerprint: input.processorFingerprint,
      status: "completed",
      resultSource: "provider_success",
      attemptCount: 1,
      createdAt: now,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      output: { values: [42] },
      metadata: {}
    });

    const result = await executeWithAnalysisCheckpoint(input);

    expect(result.cacheStatus).toBe("corrupt");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "processing"] as const)("reprocesses a %s checkpoint when eligible", async (status) => {
    const { checkpoints } = await setup();
    const execute = vi.fn(async () => ({ output: { values: ["recovered"] }, resultSource: "provider_success" as const }));
    const input = executionInput(checkpoints, execute);
    const id = buildAnalysisCheckpointId(input);
    const old = "2026-07-15T07:00:00.000Z";
    await checkpoints.write({
      version: 1,
      id,
      userId: input.userId,
      uploadId: input.uploadId,
      kind: input.kind,
      sourceChunkId: input.sourceChunkId,
      sourceChunkIndex: input.sourceChunkIndex,
      inputFingerprint: input.inputFingerprint,
      processorFingerprint: input.processorFingerprint,
      status,
      attemptCount: 1,
      createdAt: old,
      startedAt: old,
      updatedAt: old,
      ...(status === "failed" ? { error: { code: "timeout", message: "timed out", retryable: true } } : {}),
      metadata: {}
    });

    const result = await executeWithAnalysisCheckpoint(input);

    expect(result.cacheStatus).toBe(status === "processing" ? "stale" : "miss");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not reclaim a fresh processing checkpoint before its stale budget", async () => {
    const { checkpoints } = await setup();
    const execute = vi.fn(async () => ({ output: { values: ["unexpected"] }, resultSource: "provider_success" as const }));
    const input = executionInput(checkpoints, execute);
    const id = buildAnalysisCheckpointId(input);
    await checkpoints.write({
      version: 1,
      id,
      userId: input.userId,
      uploadId: input.uploadId,
      kind: input.kind,
      sourceChunkId: input.sourceChunkId,
      sourceChunkIndex: input.sourceChunkIndex,
      inputFingerprint: input.inputFingerprint,
      processorFingerprint: input.processorFingerprint,
      status: "processing",
      attemptCount: 1,
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      metadata: {}
    });

    await expect(executeWithAnalysisCheckpoint(input)).rejects.toThrow("still processing");
    expect(execute).not.toHaveBeenCalled();
  });

  it("writes a sanitised failed checkpoint", async () => {
    const { checkpoints } = await setup();
    const execute = vi.fn(async () => {
      throw new Error("request failed token=secret-value api_key=also-secret");
    });
    const input = executionInput(checkpoints, execute as never);

    await expect(executeWithAnalysisCheckpoint(input)).rejects.toThrow("request failed");
    const record = AnalysisChunkCheckpointSchema.parse(await checkpoints.read(buildAnalysisCheckpointId(input)));

    expect(record.status).toBe("failed");
    expect(record.error?.message).not.toContain("secret-value");
    expect(record.error?.message).not.toContain("also-secret");
  });

  it("single-flights concurrent execution of the same checkpoint", async () => {
    const { checkpoints } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await gate;
      return { output: { values: ["shared"] }, resultSource: "provider_success" as const };
    });
    const input = executionInput(checkpoints, execute);

    const first = executeWithAnalysisCheckpoint(input);
    const second = executeWithAnalysisCheckpoint(input);
    release();
    const [left, right] = await Promise.all([first, second]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(left.output).toEqual(right.output);
  });

  it("isolates upload, user, and kind records and deletes only one upload", async () => {
    const { checkpoints } = await setup();
    const base = executionInput(checkpoints, async () => ({ output: { values: ["x"] }, resultSource: "provider_success" as const }));
    await executeWithAnalysisCheckpoint(base);
    await executeWithAnalysisCheckpoint({ ...base, uploadId: "upload_b", sourceChunkId: "source_b" });
    await executeWithAnalysisCheckpoint({ ...base, userId: "user_b", sourceChunkId: "source_user_b" });
    await executeWithAnalysisCheckpoint({ ...base, kind: "audio_insight", sourceChunkId: "source_audio" });

    await checkpoints.deleteUpload("user_a", "upload_a");

    expect(await checkpoints.list({ userId: "user_a", uploadId: "upload_a" })).toHaveLength(0);
    expect(await checkpoints.list({ userId: "user_a", uploadId: "upload_b" })).toHaveLength(1);
    expect(await checkpoints.list({ userId: "user_b", uploadId: "upload_a" })).toHaveLength(1);
  });

  it("leaves no temporary half-files after an atomic write", async () => {
    const { checkpoints } = await setup();
    const input = executionInput(checkpoints, async () => ({ output: { values: ["atomic"] }, resultSource: "provider_success" as const }));

    await executeWithAnalysisCheckpoint(input);

    const files = await readdir(join(tempDir!, "analysis-chunks"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/u);
  });

  it("resumes only missing or stale chunks after an interrupted batch", async () => {
    const { checkpoints } = await setup();
    const calls = new Map<number, number>();
    const inputFor = (index: number) => {
      const execute = vi.fn(async () => {
        calls.set(index, (calls.get(index) ?? 0) + 1);
        return { output: { values: [`chunk-${index}`] }, resultSource: "provider_success" as const };
      });
      return {
        ...executionInput(checkpoints, execute),
        sourceChunkId: `source_chunk_${index}`,
        sourceChunkIndex: index,
        inputFingerprint: fingerprintAnalysisInput({ chunk: index }),
        execute
      };
    };
    const inputs = Array.from({ length: 5 }, (_, index) => inputFor(index));
    await Promise.all(inputs.slice(0, 3).map((input) => executeWithAnalysisCheckpoint(input)));
    const interrupted = inputs[3];
    const interruptedId = buildAnalysisCheckpointId(interrupted);
    const old = "2026-07-15T07:00:00.000Z";
    await checkpoints.write({
      version: 1,
      id: interruptedId,
      userId: interrupted.userId,
      uploadId: interrupted.uploadId,
      kind: interrupted.kind,
      sourceChunkId: interrupted.sourceChunkId,
      sourceChunkIndex: interrupted.sourceChunkIndex,
      inputFingerprint: interrupted.inputFingerprint,
      processorFingerprint: interrupted.processorFingerprint,
      status: "processing",
      attemptCount: 1,
      createdAt: old,
      startedAt: old,
      updatedAt: old,
      metadata: {}
    });

    const resumed = await Promise.all(inputs.map((input) => executeWithAnalysisCheckpoint(input)));

    expect(resumed.slice(0, 3).map((item) => item.cacheStatus)).toEqual(["hit", "hit", "hit"]);
    expect(resumed[3].cacheStatus).toBe("stale");
    expect(resumed[4].cacheStatus).toBe("miss");
    expect(calls).toEqual(new Map([[0, 1], [1, 1], [2, 1], [3, 1], [4, 1]]));
  });
});
