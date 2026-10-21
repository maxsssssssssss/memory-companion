// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import fixture from "./testing/natural-quiz-d84eaa9.fixture.json";
import { replayRetainedQuizValidators, type RetainedValidatorFixture } from "./testing/natural-quiz-validator-replay";
let root: string;
let result: ReturnType<typeof replayRetainedQuizValidators>;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "retained-quiz-validator-"));
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Real Provider requests are prohibited"); }));
  result = replayRetainedQuizValidators(fixture as RetainedValidatorFixture, root);
});
afterAll(async () => { vi.unstubAllGlobals(); if (root) await rm(root, { recursive: true, force: true }); });
it.each([
  ["G3-1-1", "published"], ["G3-1-2", "published"],
  ["G3-2-1", "published"], ["G3-2-2", "equivalent_options"],
  ["G5-1-1", "published"], ["G5-1-2", "equivalent_options"], ["G5-1-3", "published"]
])("original retained %s reaches its actual %s gate", (id, expected) => {
  const candidate = result.candidates.find(candidate => candidate.id === id)!;
  expect(candidate.actual).toBe(expected);
  expect(candidate.stage).toBe(expected === "published" ? "saved" : "publication");
});
it("keeps exact source/check/option identities through filtering, shuffling, formal answers, duplicate submit and restart", () => {
  expect(result.groups.map(group => group.count)).toEqual([2, 1, 2]);
  expect(result.groups.map(group => group.score)).toEqual([
    expect.objectContaining({ correct: 2, total: 2 }), expect.objectContaining({ correct: 1, total: 1 }), expect.objectContaining({ correct: 2, total: 2 })
  ]);
  expect(result.sqliteIntegrity).toBe("ok"); expect(result.restart).toBe("PASS"); expect(result.duplicateSubmit).toBe("PASS");
  expect(result.realProviderCalls).toBe(0);
});
