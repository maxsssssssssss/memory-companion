// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkAnalysisEvaluationFailureSink, type WorkAnalysisFailureCapture } from "./evaluation-failure-capture";

describe("local Work Review failure artifacts", () => {
  let root: string;
  let runDir: string;
  let env: Record<string, string>;
  const runId = "synthetic-capture-test";
  const capture: WorkAnalysisFailureCapture = {
    requestTraceId: "61480af1-2c4d-4640-a645-68a4976329e6", stage: "extractor",
    model: "fixture", schemaName: "work_meeting_candidates_v7", errorCode: "work_extractor_output_invalid",
    elapsedMs: 1, diagnostics: { validationIssues: [{ path: "items", code: "too_big" }] },
    requestInput: [{ role: "user", content: "window=3/3\nSYNTHETIC_SOURCE" }],
    jsonInstruction: "Return JSON", response: { rawResponse: '  {"items":[21]}\n', state: "complete" }
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "work-failure-capture-test-"));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    runDir = join(root, ".data/evaluation/work-review-analysis-core-stabilization", runId);
    const dataDirectory = join(root, ".data/wrb-1234abcd");
    await mkdir(runDir, { recursive: true });
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(join(runDir, "failure-capture-scope.json"), JSON.stringify({ version: 1, runId, synthetic: true, dataDirectory }));
    env = { NODE_ENV: "test", APP_STORAGE_MODE: "local", EVALUATION_MODE: "true",
      DEBUG_SAVE_PROVIDER_RESPONSE: "true", WORK_REVIEW_EVALUATION_RUN_ID: runId, APP_DATA_DIR: dataDirectory };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    const part = relative(resolve(tmpdir()), resolve(root));
    if (!part.startsWith("work-failure-capture-test-") || part.includes(sep)) throw new Error("unsafe test cleanup path");
    await rm(root, { recursive: true, force: true });
  });

  it.each(["production", "no_evaluation", "no_debug", "no_run", "remote_storage"])("does not capture in %s", async (scenario) => {
    if (scenario === "production") env.NODE_ENV = "production";
    if (scenario === "no_evaluation") delete env.EVALUATION_MODE;
    if (scenario === "no_debug") delete env.DEBUG_SAVE_PROVIDER_RESPONSE;
    if (scenario === "no_run") delete env.WORK_REVIEW_EVALUATION_RUN_ID;
    if (scenario === "remote_storage") env.APP_STORAGE_MODE = "remote";
    expect(await createWorkAnalysisEvaluationFailureSink(env)).toBeUndefined();
    expect(await readdir(runDir)).toEqual(["failure-capture-scope.json"]);
  });

  it("saves exact answer, reason and source together without overwriting a prior request", async () => {
    const sink = (await createWorkAnalysisEvaluationFailureSink(env))!;
    await sink(capture);
    const artifact = JSON.parse(await readFile(join(runDir, "provider-failures", `${capture.requestTraceId}.json`), "utf8"));
    expect(artifact).toMatchObject({ ...capture, rawResponseAvailability: "complete",
      rawResponseSha256: createHash("sha256").update(capture.response!.rawResponse).digest("hex") });
    await expect(sink(capture)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it.each([
    [null, "not_received"],
    [{ rawResponse: "", state: "partial" }, "not_received"],
    [{ rawResponse: "", state: "complete" }, "empty"],
    [{ rawResponse: "unfinished", state: "partial" }, "partial"]
  ] as const)("distinguishes response availability %j", async (response, availability) => {
    const sink = (await createWorkAnalysisEvaluationFailureSink(env))!;
    await sink({ ...capture, response });
    const artifact = JSON.parse(await readFile(join(runDir, "provider-failures", `${capture.requestTraceId}.json`), "utf8"));
    expect(artifact.rawResponseAvailability).toBe(availability);
    expect(artifact.response).toEqual(response);
  });

  it("rejects mismatched data scope and traversal", async () => {
    env.APP_DATA_DIR = root;
    await expect(createWorkAnalysisEvaluationFailureSink(env)).rejects.toThrow("scope_invalid");
    env.WORK_REVIEW_EVALUATION_RUN_ID = "../outside";
    await expect(createWorkAnalysisEvaluationFailureSink(env)).rejects.toThrow("scope_invalid");
  });

  it("rejects an artifact directory junction outside this run", async () => {
    const sink = (await createWorkAnalysisEvaluationFailureSink(env))!;
    const other = join(root, "outside-run");
    await mkdir(other);
    await symlink(other, join(runDir, "provider-failures"), "junction");
    await expect(sink(capture)).rejects.toThrow("scope_invalid");
    expect(await readdir(other)).toEqual([]);
  });
});
