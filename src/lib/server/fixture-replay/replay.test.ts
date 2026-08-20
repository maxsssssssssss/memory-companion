import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { replayMemoryFixtures, assertFixtureReplayEnvironment } from "./replay";

let tempDir: string | undefined;
const datasetPath = resolve("test-data/memory-multiday-v1");

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("memory fixture replay", () => {
  it("rejects production execution", () => {
    expect(() => assertFixtureReplayEnvironment("production")).toThrow("only available in development or test");
    expect(() => assertFixtureReplayEnvironment(undefined)).toThrow("only available in development or test");
  });

  it("replays all days locally and produces a repeatable evidence-backed report", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-fixture-replay-"));
    const reportPath = join(tempDir, "evaluation", "report.json");
    const input = {
      datasetPath,
      userId: "memory-eval-user",
      resetUser: true,
      reportPath,
      failFast: true,
      dataRoot: tempDir,
      memoryDatabasePath: join(tempDir, "memory.sqlite"),
      logger: { info() {}, warn() {}, error() {} }
    };

    const first = await replayMemoryFixtures(input);
    const second = await replayMemoryFixtures(input);
    const stored = JSON.parse(await readFile(reportPath, "utf8")) as typeof second.report;

    expect(first.report.dayByDay).toHaveLength(8);
    expect(first.report.dayByDay.every((day) => day.status === "ready")).toBe(true);
    expect(first.report.execution.networkAttempts).toBe(0);
    expect(first.report.orphanEvidenceCount).toBe(0);
    expect(first.report.must.filter((assertion) => !assertion.pass)).toEqual([]);
    expect(first.report.mustNotViolations).toEqual([]);
    expect(first.report.pass).toBe(true);
    expect(new Set(
      first.report.dayByDay.flatMap((day) => day.addedMemoryIds)
    ).size).toBeGreaterThan(0);
    expect(first.report.memoryEvidence.length).toBeGreaterThan(0);
    expect(second.report.deterministicDigest).toBe(first.report.deterministicDigest);
    expect(stored.deterministicDigest).toBe(second.report.deterministicDigest);
    expect(second.report.scopeChecks.current.isolated).toBe(true);
    expect(second.report.scopeChecks.week.range).toEqual({ start: "2026-07-06", end: "2026-07-12" });
    expect(second.report.scopeChecks.all.dates).toEqual(
      expect.arrayContaining(["2026-06-29", "2026-07-09", "2026-07-12"])
    );
    expect(second.report.scopeChecks.all.dates).not.toContain("2026-07-11");
    expect(second.report.memoryEvidence.every((evidence) => evidence.sourceId.startsWith("fixture_") || evidence.sourceId.includes("fixture_"))).toBe(true);
  }, 30_000);
});
