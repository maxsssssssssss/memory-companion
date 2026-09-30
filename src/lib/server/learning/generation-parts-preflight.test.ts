// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GenerationParts, generationProgress } from "./generation-parts";
import { LearningError, LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { LearningFrameworkRepository } from "./framework-repository";
import { LearningApiError, learningErrorMessage } from "@/lib/client/learning-api";

let directory: string, repo: LearningRepository, quiz: LearningQuizRepository, page: string, material: string, run: string;
const prefix = join(tmpdir(), "learning-preflight-synthetic-");
const settings = () => ({ materialIds: [material], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, count: 5, difficulty: "standard" });
const parts = () => new GenerationParts(repo, page, "quiz", run, [material], () => quiz.assertSources(page, run), 120000);
const fitError = () => { throw new LearningError(503, "generation_request_does_not_fit"); };
const row = (id = "questions-1") => repo.database.prepare("SELECT * FROM learning_generation_parts WHERE page_id=? AND kind='quiz' AND run_id=? AND part_id=?").get(page, run, id) as {
  state: string; attempts: number; failure: string | null; diagnostics_json: string | null; result_json: string | null; token: string | null;
};
const resume = () => quiz.begin(page, { id: run, settings: settings(), resume: true }, 48000);
function legacy(failure = "generation_request_does_not_fit", diagnostics: string | null = null, state = "failed") {
  repo.database.prepare("UPDATE learning_generation_parts SET state=?,attempts=2,failure=?,diagnostics_json=? WHERE run_id=? AND part_id='questions-1'")
    .run(state, failure, diagnostics, run);
  quiz.fail(page, run, failure);
}
beforeEach(async () => {
  directory = await mkdtemp(prefix); repo = new LearningRepository(directory, "owner"); quiz = new LearningQuizRepository(repo);
  page = randomUUID(); material = randomUUID(); run = randomUUID();
  repo.create({ id: page, title: "[合成] 请求前检查" });
  repo.saveMaterials(page, [{ id: material, title: "[合成] 材料", kind: "text", filename: null, bytes: Buffer.from("[合成] 仅在前提成立时适用。") }]);
  quiz.begin(page, { id: run, settings: settings() }, 48000);
  parts().plan([{ id: "questions-0", input: "[合成] 前三题" }, { id: "questions-1", input: "[合成] 后两题" }]);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network forbidden"); }));
});
afterEach(async () => {
  if (repo.database.open) repo.close(); vi.unstubAllGlobals();
  if (!resolve(directory).startsWith(resolve(prefix))) throw Error("Unexpected synthetic directory");
  await rm(directory, { recursive: true, force: true });
});

it("does not claim, spend attempts, change diagnostics or call the operation when local preflight fails", async () => {
  const operation = vi.fn(async () => ({ items: [] })), before = JSON.stringify(row());
  for (let i = 0; i < 3; i++) {
    await expect(parts().execute("questions-1", operation, v => v, fitError)).rejects.toThrow("generation_request_does_not_fit");
    expect(JSON.stringify(row())).toBe(before);
  }
  expect(operation).not.toHaveBeenCalled(); expect(row().attempts).toBe(0);
  expect(generationProgress(repo, page, "quiz", run)?.canResume).toBe(true);
  const message = learningErrorMessage(new LearningApiError(503, "generation_request_does_not_fit"));
  expect(message).toContain("超过当前单次处理容量"); expect(message).toContain("尚未发送给模型"); expect(message).not.toMatch(/缩小|删减/);
});

it("recovers old local-only fit counts on explicit resume and retains all three saved candidates and recovery evidence", async () => {
  const candidates = { items: [1, 2, 3].map(n => ({ stem: `[合成] 已完成候选${n}`, source: "[合成] 完整引用保持" })) };
  await parts().execute("questions-0", async () => candidates, v => v);
  const completedBefore = JSON.stringify(row("questions-0"));
  legacy(); const before = JSON.stringify(row());
  expect(generationProgress(repo, page, "quiz", run)).toMatchObject({ completed: 1, total: 2, canResume: true });
  expect(JSON.stringify(row())).toBe(before);
  const preflight = vi.fn(), operation = vi.fn(async (diagnostics: (v: object) => void) => {
    diagnostics({ responseStatus: "completed", inputTokens: 100, localPreflightRecovery: "must not replace history", body: "PRIVATE" });
    diagnostics({ responseStatus: "completed", outputTokens: 20 });
    return { items: [4, 5] };
  });
  await expect(parts().execute("questions-1", operation, v => v, preflight)).rejects.toThrow("framework_interrupted");
  expect(preflight).not.toHaveBeenCalled(); expect(operation).not.toHaveBeenCalled();
  expect(resume()).toBeTruthy();
  expect(await parts().execute("questions-0", operation, v => v, preflight)).toEqual(candidates);
  expect(preflight).not.toHaveBeenCalled();
  await expect(parts().execute("questions-1", operation, v => v, preflight)).resolves.toEqual({ items: [4, 5] });
  expect(operation).toHaveBeenCalledTimes(1); expect(preflight).toHaveBeenCalledTimes(1);
  expect(row()).toMatchObject({ state: "completed", attempts: 1 });
  expect(JSON.parse(row().diagnostics_json!)).toEqual({ localPreflightRecovery: { attempts: 2, failure: "generation_request_does_not_fit" }, responseStatus: "completed", outputTokens: 20 });
  expect(JSON.stringify(row("questions-0"))).toBe(completedBefore); expect(fetch).not.toHaveBeenCalled();
  repo.close(); repo = new LearningRepository(directory, "owner"); quiz = new LearningQuizRepository(repo);
  expect(JSON.stringify(row("questions-0"))).toBe(completedBefore);
  expect(JSON.parse(row().diagnostics_json!).localPreflightRecovery.attempts).toBe(2);
});

it("leaves legacy evidence untouched if the new preflight still fails and requires an actual preflight to recover", async () => {
  legacy("generation_request_does_not_fit", " {} "); expect(resume()).toBeTruthy();
  const before = JSON.stringify(row()), operation = vi.fn(async () => ({}));
  await expect(parts().execute("questions-1", operation, v => v)).rejects.toThrow("generation_part_failed");
  await expect(parts().execute("questions-1", operation, v => v, fitError)).rejects.toThrow("generation_request_does_not_fit");
  expect(JSON.stringify(row())).toBe(before); expect(operation).not.toHaveBeenCalled();
});

it("does not broaden legacy recovery for framework generation without the Quiz recovery contract", async () => {
  const framework = new LearningFrameworkRepository(repo);
  framework.begin(page, { id: run, materialIds: [material] }, 48000);
  const frameworkParts = new GenerationParts(repo, page, "framework", run, [material], () => framework.assertSources(page, run), 120000);
  frameworkParts.plan([{ id: "read-0", input: "[合成] 框架正文" }]);
  repo.database.prepare("UPDATE learning_generation_parts SET state='failed',attempts=2,failure='generation_request_does_not_fit' WHERE kind='framework' AND run_id=?").run(run);
  const before = JSON.stringify(repo.database.prepare("SELECT * FROM learning_generation_parts WHERE kind='framework' AND run_id=?").all(run));
  expect(generationProgress(repo, page, "framework", run)?.canResume).toBe(false);
  const operation = vi.fn(async () => ({})), preflight = vi.fn();
  await expect(frameworkParts.execute("read-0", operation, v => v, preflight)).rejects.toThrow("generation_part_failed");
  expect(operation).not.toHaveBeenCalled(); expect(preflight).not.toHaveBeenCalled();
  expect(JSON.stringify(repo.database.prepare("SELECT * FROM learning_generation_parts WHERE kind='framework' AND run_id=?").all(run))).toBe(before);
});

it("keeps a two-request retry ceiling after correcting local counts and persists history through provider failures", async () => {
  legacy(); resume();
  const operation = vi.fn(async (diagnostics: (v: object) => void) => {
    diagnostics({ responseStatus: "completed", outputTokens: 10 }); return { invalid: true };
  });
  const invalid = () => { throw new LearningError(422, "quiz_invalid_result"); };
  for (let attempt = 1; attempt <= 2; attempt++) {
    await expect(parts().execute("questions-1", operation, invalid, () => {})).rejects.toThrow("quiz_invalid_result");
    expect(row().attempts).toBe(attempt);
    expect(JSON.parse(row().diagnostics_json!).localPreflightRecovery).toEqual({ attempts: 2, failure: "generation_request_does_not_fit" });
    quiz.fail(page, run, "quiz_invalid_result");
    if (attempt === 1) expect(resume()).toBeTruthy();
  }
  expect(operation).toHaveBeenCalledTimes(2); expect(generationProgress(repo, page, "quiz", run)?.canResume).toBe(false); expect(resume()).toBeNull();
});

it.each(["unknown", "running"])("never normalizes or replays a %s request even with a fit error and no diagnostics", async state => {
  legacy("generation_request_does_not_fit", null, state);
  const before = JSON.stringify(row()); expect(generationProgress(repo, page, "quiz", run)?.canResume).toBe(false); expect(resume()).toBeNull();
  // Exercise the part fence independently of the already-tested parent fence.
  repo.database.prepare("UPDATE learning_quiz_runs SET status='generating',deadline=? WHERE id=?").run(Date.now() + 120000, run);
  const operation = vi.fn(async () => ({})), preflight = vi.fn();
  await expect(parts().execute("questions-1", operation, v => v, preflight)).rejects.toThrow("generation_result_unknown");
  expect(JSON.stringify(row())).toBe(before); expect(preflight).not.toHaveBeenCalled(); expect(operation).not.toHaveBeenCalled();
});

it.each([
  ["framework_provider_failed", null], ["quiz_invalid_result", null], ["generation_request_does_not_fit", '{"responseStatus":"failed"}'],
  ["generation_request_does_not_fit", '{"inputTokens":0}'], ["generation_request_does_not_fit", '{"totalDurationMs":0}'],
  ["generation_request_does_not_fit", "not-json"], ["generation_request_does_not_fit", '{"localPreflightRecovery":{"attempts":2,"failure":"generation_request_does_not_fit"}}'],
] as const)("does not normalize %s when evidence is %s", async (failure, diagnostics) => {
  legacy(failure, diagnostics); const before = JSON.stringify(row());
  expect(generationProgress(repo, page, "quiz", run)?.canResume).toBe(false); expect(resume()).toBeNull();
  repo.database.prepare("UPDATE learning_quiz_runs SET status='generating',deadline=? WHERE id=?").run(Date.now() + 120000, run);
  const operation = vi.fn(async () => ({})), preflight = vi.fn();
  await expect(parts().execute("questions-1", operation, v => v, preflight)).rejects.toThrow("generation_part_failed");
  expect(JSON.stringify(row())).toBe(before); expect(operation).not.toHaveBeenCalled(); expect(preflight).not.toHaveBeenCalled();
});

it("keeps concurrent claims exclusive after preflight and refuses a late result after material deletion", async () => {
  let finish!: (v: unknown) => void;
  const operation = vi.fn(() => new Promise(resolve => { finish = resolve; })), preflight = vi.fn();
  const first = parts().execute("questions-1", operation, v => v, preflight);
  await expect(parts().execute("questions-1", operation, v => v, preflight)).rejects.toThrow("generation_result_unknown");
  expect(operation).toHaveBeenCalledTimes(1); expect(preflight).toHaveBeenCalledTimes(1); expect(row().attempts).toBe(1);
  repo.deleteMaterial(page, material); finish({ items: ["[合成] 迟到候选"] });
  await expect(first).rejects.toThrow(); expect(row()).toBeUndefined();
  expect(quiz.list(page)[0]).toMatchObject({ status: "failed", count: 0 });
});

it("checks source and account ownership before recovery, preflight or model execution", async () => {
  legacy(); const operation = vi.fn(async () => ({})), preflight = vi.fn();
  const before = JSON.stringify(row());
  repo.database.prepare("UPDATE learning_materials SET original=? WHERE id=?").run(Buffer.from("[合成] 已修改材料"), material);
  expect(() => resume()).toThrow("source_changed");
  await expect(parts().execute("questions-1", operation, v => v, preflight)).rejects.toThrow("source_changed");
  const other = new LearningRepository(directory, "other-owner");
  try {
    const inaccessible = new GenerationParts(other, page, "quiz", run, [material], () => other.get(page), 120000);
    await expect(inaccessible.execute("questions-1", operation, v => v, preflight)).rejects.toThrow();
  } finally { other.close(); }
  expect(JSON.stringify(row())).toBe(before); expect(operation).not.toHaveBeenCalled(); expect(preflight).not.toHaveBeenCalled();
});
