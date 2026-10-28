// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import fixture from "./testing/natural-quiz-c6dd171.fixture.json";
import { replayC6RetainedQuizValidators } from "./testing/natural-quiz-c6dd171-replay";
import type { RetainedValidatorFixture } from "./testing/natural-quiz-validator-replay";
let root: string;
let result: Awaited<ReturnType<typeof replayC6RetainedQuizValidators>>;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "retained-c6-quiz-"));
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Real Provider requests prohibited"); }));
  result = await replayC6RetainedQuizValidators(fixture as RetainedValidatorFixture, root);
});
afterAll(async () => { vi.unstubAllGlobals(); if (root) await rm(root, { recursive: true, force: true }); });
it.each([
  ["G3-R1-0", "published"], ["G3-R1-1", "equivalent_options"],
  ["G3-R2-0", "equivalent_options"], ["G3-R2-1", "published"],
  ["G5-R1-0", "equivalent_options"], ["G5-R1-1", "equivalent_options"], ["G5-R1-2", "published"]
])("retained c6 candidate %s reaches the actual %s gate", (id, expected) => {
  const candidate = result.candidates.find(candidate => candidate.originalEvidenceId === id)!;
  expect(candidate.actual).toBe(expected);
  expect(candidate.stage).toBe(expected === "published" ? "saved" : "publication");
});
it("separates raw invalid kind, explicit normalization, official publication and private original projection", () => {
  expect(result.rawKindContract).toMatchObject({ value: "boundary", accepted: false, issues: [{ code: "invalid_enum_value", path: "kind" }] });
  expect(result.normalization).toMatchObject({ originalKind: "boundary", normalizedKind: "application", originalCandidateUnchanged: true, reviewRoleUnchanged: true });
  expect(result.generationService).toMatchObject({ published: 1, offlineResponses: 1, semanticReviewResponses: 1, realProviderCalls: 0, filteredOriginalIndex: 2, publishedIndex: 0,
    score: { correct: 1, total: 1 }, duplicateSubmit: "PASS", restart: "PASS", sqliteIntegrity: "ok" });
});
it("keeps source, stable IDs, review mapping, answer hiding, duplicate submit and reopening through the formal chain", () => {
  expect(result.groups.map(group => group.count)).toEqual([1, 1, 1]);
  expect(result.groups.every(group => (group.score as { correct: number; total: number }).correct === 1 && (group.score as { correct: number; total: number }).total === 1)).toBe(true);
  expect(result.sqliteIntegrity).toBe("ok"); expect(result.restart).toBe("PASS"); expect(result.duplicateSubmit).toBe("PASS");
  expect(fetch).not.toHaveBeenCalled();
});
