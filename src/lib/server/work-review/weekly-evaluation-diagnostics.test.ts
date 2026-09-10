// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkWeeklyEvaluationDiagnosticSink,
  type WorkWeeklyDiagnosticEvent } from "./weekly-evaluation-diagnostics";

const testRoot = resolve(process.cwd(), ".data/evaluation");
const directories: string[] = [];
async function directory() {
  await mkdir(testRoot, { recursive: true });
  const value = await mkdtemp(join(testRoot, "weekly-diagnostics-test-"));
  directories.push(value);
  return value;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const value of directories.splice(0)) {
    const part = relative(await realpath(testRoot), await realpath(value));
    if (!part.startsWith("weekly-diagnostics-test-") || part.includes(sep) || isAbsolute(part)) {
      throw new Error("Unsafe test cleanup target");
    }
    await rm(value, { recursive: true, force: true });
  }
});

const run = { accountId: "account_a", weeklyReviewId: "weekly_a", runId: "run_a", runVersion: 2,
  sourceSnapshotDigest: "a".repeat(64), inputPackDigest: "b".repeat(64) };
const started: WorkWeeklyDiagnosticEvent = { run, event: { stage: "started" }, canCapture: () => true };

describe("Work Weekly opt-in local evaluation diagnostics", () => {
  it("binds trace artifacts and distinguishes policy candidates from persisted output", async () => {
    const root = await directory();
    const sink = await createWorkWeeklyEvaluationDiagnosticSink({ directory: root, accountId: "account_a", weeklyReviewId: "weekly_a" });
    const event: WorkWeeklyDiagnosticEvent["event"] = { stage: "pipeline", trace: {
      snapshotDigest: run.sourceSnapshotDigest, inputPackDigest: run.inputPackDigest,
      stage: "published", publicationStatus: "candidate_only", items: [], claims: [],
      quality_assessment: { status: "insufficient", reviewIssues: [], reasonCodes: ["coverage_not_assessed"],
        sourceCount: 1, coveredSourceCount: 0, partialSourceCount: 0, omittedSourceCount: 0,
        notApplicableSourceCount: 0, unassessedSourceCount: 1 }
    } };
    await sink({ ...started, event });
    const artifact = JSON.parse(await readFile(join(root, run.runId, "001-published.json"), "utf8"));
    expect(artifact).toMatchObject({ version: 1, run, sequence: 1,
      phaseMeaning: "policy_candidates_before_sqlite_publication", event });
    expect(artifact.payloadSha256).toBe(createHash("sha256").update(JSON.stringify(event)).digest("hex"));
    await sink({ ...started, event: { stage: "finished", outcome: "quality_insufficient", errorCode: "weekly_generation_quality_insufficient" } });
    const terminal = JSON.parse(await readFile(join(root, run.runId, "002-finished.json"), "utf8"));
    expect(terminal.phaseMeaning).toBe("executor_outcome_after_persistence_attempt");
    expect(terminal.event.outcome).toBe("quality_insufficient");
  });

  it("skips other accounts, other reviews and cancelled captures", async () => {
    const root = await directory();
    const sink = await createWorkWeeklyEvaluationDiagnosticSink({ directory: root, accountId: "account_a", weeklyReviewId: "weekly_a" });
    await sink({ ...started, run: { ...run, accountId: "account_b" } });
    await sink({ ...started, run: { ...run, weeklyReviewId: "weekly_b" } });
    await sink({ ...started, canCapture: () => false });
    expect(await readdir(root)).toEqual([]);
  });

  it.each([2, 3])("retains no late file when cancellation is observed at check %s", async (cancelAt) => {
    const root = await directory();
    const sink = await createWorkWeeklyEvaluationDiagnosticSink({ directory: root, accountId: "account_a", weeklyReviewId: "weekly_a" });
    let checks = 0;
    await sink({ ...started, canCapture: () => ++checks < cancelAt });
    expect(await readdir(join(root, run.runId))).toEqual([]);
  });

  it("rejects changed run and snapshot bindings without overwriting earlier evidence", async () => {
    const root = await directory();
    const sink = await createWorkWeeklyEvaluationDiagnosticSink({ directory: root, accountId: "account_a", weeklyReviewId: "weekly_a" });
    await sink(started);
    const first = await readFile(join(root, run.runId, "001-started.json"), "utf8");
    await expect(sink({ ...started, run: { ...run, runVersion: 3 } })).rejects.toThrow("weekly_diagnostics_binding_changed");
    await expect(sink({ ...started, event: { stage: "pipeline", trace: {
      stage: "synthesized", generated: [], snapshotDigest: "c".repeat(64), inputPackDigest: run.inputPackDigest
    } } })).rejects.toThrow("weekly_diagnostics_binding_changed");
    expect(await readFile(join(root, run.runId, "001-started.json"), "utf8")).toBe(first);
    expect(await readdir(join(root, run.runId))).toEqual(["001-started.json"]);
  });

  it("does not overwrite a historical artifact on a new sink instance", async () => {
    const root = await directory();
    await mkdir(join(root, run.runId));
    await writeFile(join(root, run.runId, "001-started.json"), "retained evidence");
    const sink = await createWorkWeeklyEvaluationDiagnosticSink({ directory: root, accountId: "account_a", weeklyReviewId: "weekly_a" });
    await expect(sink(started)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(root, run.runId, "001-started.json"), "utf8")).toBe("retained evidence");
  });

  it("rejects a run directory junction escaping the explicitly selected artifact directory", async () => {
    const root = await directory();
    const outside = await directory();
    await symlink(outside, join(root, run.runId), "junction");
    const sink = await createWorkWeeklyEvaluationDiagnosticSink({ directory: root, accountId: "account_a", weeklyReviewId: "weekly_a" });
    await expect(sink(started)).rejects.toThrow("weekly_diagnostics_scope_invalid");
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects production and unscoped directories", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(createWorkWeeklyEvaluationDiagnosticSink({ directory: process.cwd(), accountId: "account_a", weeklyReviewId: "weekly_a" }))
      .rejects.toThrow("weekly_diagnostics_scope_invalid");
    vi.stubEnv("NODE_ENV", "test");
    await expect(createWorkWeeklyEvaluationDiagnosticSink({ directory: join(process.cwd(), "src"), accountId: "account_a", weeklyReviewId: "weekly_a" }))
      .rejects.toThrow("weekly_diagnostics_scope_invalid");
  });

  it("never serializes unclassified terminal error prose", async () => {
    const root = await directory();
    const sink = await createWorkWeeklyEvaluationDiagnosticSink({ directory: root, accountId: "account_a", weeklyReviewId: "weekly_a" });
    await sink({ ...started, event: { stage: "finished", outcome: "failed", errorCode: "secret request and transcript" } });
    const raw = await readFile(join(root, run.runId, "001-finished.json"), "utf8");
    expect(raw).not.toContain("secret request");
    expect(JSON.parse(raw).event.errorCode).toBeNull();
  });
});
