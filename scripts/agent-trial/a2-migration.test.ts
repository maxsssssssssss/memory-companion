// @vitest-environment node
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentEvent, AgentTask } from "@/lib/domain/agent";
import { AgentRuntime } from "@/lib/server/agent/runtime";
import { AgentStore } from "@/lib/server/agent/store";
import { AgentFailure, type AgentDecision, type AgentDecisionProvider, type AgentScenario } from "@/lib/server/agent/types";
import { LearningRepository } from "@/lib/server/learning/repository";
import { LearningAgentRepository } from "@/lib/server/learning/agent-repository";

type SqlValue = string | number | null | { base64: string };
type Snapshot = {
  schema: Array<{ type: string; name: string; sql: string }>;
  rows: Record<string, Array<Record<string, SqlValue>>>;
};
type Fixture = {
  provenance: { commit: string; syntheticOnly: boolean };
  accountId: string; taskId: string; task: AgentTask;
  consumed: AgentEvent; pending: AgentEvent;
  records: Array<{ id: string; actionId: string; content: string; feedback: string }>;
  tasks: Snapshot; checkpoints: Snapshot;
  learningArtifactSchema: string;
};
// Exported from the public A1 Store/Runtime APIs at the recorded commit, including
// actual SqliteSaver interrupts. It is not generated with the code under test and
// needs no Git history, real credentials, user database or Provider to replay.
const fixture = JSON.parse(readFileSync(new URL("./a1-migration.fixture.json", import.meta.url), "utf8")) as Fixture;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllGlobals();
});
function identifier(value: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error("Unexpected fixture SQL identifier");
  return `"${value}"`;
}
function restore(path: string, snapshot: Snapshot) {
  const database = new Database(path);
  try {
    database.transaction(() => {
      database.pragma("defer_foreign_keys = ON");
      for (const entry of snapshot.schema) database.exec(entry.sql);
      for (const [table, rows] of Object.entries(snapshot.rows)) {
        for (const row of rows) {
          const columns = Object.keys(row);
          const values = Object.values(row).map(value => value !== null && typeof value === "object" ? Buffer.from(value.base64, "base64") : value);
          database.prepare(`INSERT INTO ${identifier(table)} (${columns.map(identifier).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...values);
        }
      }
    })();
    expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
  } finally { database.close(); }
}
function digest(path: string) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function schema(database: Database.Database) {
  return database.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all();
}
function openStore(path: string) {
  const store = AgentStore.open(path);
  cleanups.push(() => { if (store.database.open) store.close(); });
  return store;
}
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "agent-a1-upgrade-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const taskPath = join(directory, "agent-tasks.sqlite");
  const checkpointPath = join(directory, "agent-checkpoints.sqlite");
  restore(taskPath, fixture.tasks);
  restore(checkpointPath, fixture.checkpoints);
  // A real Learning database is adjacent to the Agent files. Only synthetic
  // source bytes are saved; this migration test never manufactures quiz grades.
  const learning = new LearningRepository(directory, fixture.accountId);
  const page = learning.create({ id: randomUUID(), title: "合成迁移边界教材" });
  learning.saveMaterials(page.id, [{ id: randomUUID(), title: "合成原文", kind: "text", filename: null,
    bytes: Buffer.from("[仅迁移测试] 旧教材原文与个人学习数据不由 Agent 升级重写。\r\n\r\n第二段保留精确字节。") }]);
  learning.close();
  const learningPath = join(directory, "learning-organizer.sqlite");
  const learningHash = digest(learningPath);
  const fetch = vi.fn(() => { throw new Error("Provider access forbidden in synthetic migration test"); });
  vi.stubGlobal("fetch", fetch);
  return { directory, pageId: page.id, taskPath, checkpointPath, learningPath, learningHash, fetch };
}
function unchangedA1Rows(store: AgentStore) {
  for (const [table, rows] of Object.entries(fixture.tasks.rows)) {
    const columns = Object.keys(rows[0]);
    expect(store.database.prepare(`SELECT ${columns.map(identifier).join(",")} FROM ${identifier(table)} ORDER BY rowid`).all()).toEqual(rows);
  }
}
function runtime(store: AgentStore, checkpointPath: string, nextDecision: AgentDecision = { finish: "Synthetic fixture complete" }) {
  const execute = vi.fn(async () => { throw new Error("A1 successful action must not execute again"); });
  const scene: AgentScenario = {
    id: fixture.task.scenario,
    validate: async context => {
      if (context.task.accountId !== fixture.accountId || context.task.resourceId !== fixture.task.resourceId) throw new AgentFailure("forbidden", "Synthetic migration scope mismatch");
    },
    observe: async () => ({ authorizedRecord: "synthetic-only" }),
    tools: {
      "synthetic.create": {
        description: "Read an existing synthetic migration receipt", parameters: z.object({}).strict(), execute,
        readResult: async receipt => fixture.records.find(record => record.id === receipt.resultRef?.id),
      },
    },
    validateEvent: async event => {
      if (event.kind === "feedback" && event.message === "Synthetic explicit user feedback") return;
      if (event.kind !== "submitted" || !fixture.records.some(record => record.id === event.refId && record.feedback)) throw new AgentFailure("invalid_action", "Synthetic feedback not saved");
    },
    finish: async () => "Migration fixture handed back; no learning outcome asserted.",
  };
  const decision = vi.fn<AgentDecisionProvider>(async (_input, context) => context.call(
    { kind: "decision", model: "mock-migration-only", inputChars: 100, maxOutputTokens: 200 },
    async () => ({ value: nextDecision, usage: { inputTokens: 11, outputTokens: 6 } }),
  ));
  const value = new AgentRuntime({ store, checkpointPath, scenario: scene, decision });
  cleanups.push(() => { try { value.close(); } catch { /* Already closed to simulate a process restart. */ } });
  return { value, decision, execute };
}

describe("A1 persistent Agent data upgraded to A2 (synthetic fixture, zero Provider)", () => {
  it("preserves A1 tasks, action receipts, waits, event JSON, usage and adjacent Learning source bytes", () => {
    const h = setup();
    expect(fixture.provenance).toMatchObject({ commit: "c0786b48947cdc059052c6b07d421f290cc3f1d1", syntheticOnly: true });
    const checkpointHash = digest(h.checkpointPath);
    const store = openStore(h.taskPath);
    unchangedA1Rows(store);
    const migrated = store.getTask(fixture.accountId, fixture.taskId);
    expect(migrated).toMatchObject({ ...fixture.task, version: 1 });
    expect(migrated.actions.every(action => action.version === 1)).toBe(true);
    expect(migrated.usage).toEqual(fixture.task.usage);
    expect(migrated.usage).toMatchObject({ calls: 2, unknownUsageCalls: 1, inputTokens: null, outputTokens: null });
    for (const table of Object.keys(fixture.tasks.rows)) {
      expect(store.database.prepare(`SELECT DISTINCT version FROM ${identifier(table)}`).all()).toEqual([{ version: 1 }]);
    }
    expect(store.getTask(fixture.accountId, "synthetic-a1-paused-task").status).toBe("paused");
    expect(() => store.getTask("different-account", fixture.taskId)).toThrow();
    expect(digest(h.checkpointPath)).toBe(checkpointHash);
    expect(digest(h.learningPath)).toBe(h.learningHash);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("applies migrations and the versioned event identity index idempotently across repeated opens", () => {
    const h = setup();
    const first = openStore(h.taskPath);
    const firstSchema = schema(first.database);
    const firstTask = first.getTask(fixture.accountId, fixture.taskId);
    const indexes = first.database.pragma("index_list(agent_events)") as Array<{ name: string; unique: number }>;
    const versionedIdentity = indexes.filter(index => index.unique).some(index => {
      const columns = first.database.pragma(`index_info(${identifier(index.name)})`) as Array<{ name: string }>;
      return columns.map(column => column.name).join(",") === "task_id,version,event_kind,ref_id";
    });
    expect(versionedIdentity).toBe(true);
    first.close();
    for (let reopen = 0; reopen < 2; reopen += 1) {
      const reopened = openStore(h.taskPath);
      expect(schema(reopened.database)).toEqual(firstSchema);
      expect(reopened.getTask(fixture.accountId, fixture.taskId)).toEqual(firstTask);
      unchangedA1Rows(reopened);
      expect(reopened.database.pragma("foreign_key_check")).toEqual([]);
      reopened.close();
    }
    expect(digest(h.learningPath)).toBe(h.learningHash);
  });

  it("adds the Learning artifact version without replacing A1 bodies, result IDs or material bytes", () => {
    const h = setup();
    const learning = new LearningRepository(h.directory, fixture.accountId);
    cleanups.push(() => { if (learning.database.open) learning.close(); });
    // This old table declaration is copied verbatim from the recorded A1
    // commit. The fake artifact is a storage fixture, not a generated lesson,
    // quiz score or browser acceptance result.
    learning.database.exec(fixture.learningArtifactSchema);
    const artifact = {
      id: "synthetic-a1-explanation", task_id: fixture.taskId, page_id: h.pageId, account_id: fixture.accountId,
      kind: "explanation", action_id: "synthetic-a1-explanation-action", binding_hash: "synthetic-source-binding",
      material_ids: "[]", state: "completed", body_json: JSON.stringify({ text: "[合成旧版本解释] 保留原始正文。", citations: [] }),
      created_at: "2026-10-13T00:00:00.000Z",
    };
    const columns = Object.keys(artifact);
    learning.database.prepare(`INSERT INTO learning_agent_artifacts (${columns.map(identifier).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(artifact));
    const originalMaterials = learning.database.prepare("SELECT * FROM learning_materials ORDER BY id").all();
    const originalPages = learning.database.prepare("SELECT * FROM learning_pages ORDER BY id").all();
    let migrated = new LearningAgentRepository(learning);
    expect(migrated.get(h.pageId, fixture.taskId, artifact.id)).toEqual({ ...artifact, task_version: 1 });
    const migratedSchema = schema(learning.database);
    migrated = new LearningAgentRepository(learning);
    expect(schema(learning.database)).toEqual(migratedSchema);
    expect(migrated.list(h.pageId, fixture.taskId)).toEqual([{ ...artifact, task_version: 1 }]);
    expect(learning.database.prepare("SELECT * FROM learning_materials ORDER BY id").all()).toEqual(originalMaterials);
    expect(learning.database.prepare("SELECT * FROM learning_pages ORDER BY id").all()).toEqual(originalPages);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("reopens the A1 interrupt and automatically consumes its already authenticated pending event once", async () => {
    const h = setup();
    let store = openStore(h.taskPath);
    const first = runtime(store, h.checkpointPath);
    // The A1 fixture already contains a saved, authenticated event. A2's worker
    // must pick it up after restart even if the original notification was lost.
    const resumed = await first.value.advance(fixture.accountId, fixture.taskId);
    expect(resumed.status).toBe("ended");
    expect(resumed.endReason).toBe("Migration fixture handed back; no learning outcome asserted.");
    expect(resumed.actions).toHaveLength(2);
    expect(resumed.usage.calls).toBe(3);
    expect(resumed.usage.unknownUsageCalls).toBe(1);
    expect(first.execute).not.toHaveBeenCalled();
    expect(first.decision).toHaveBeenCalledTimes(1);
    expect(first.decision.mock.calls[0][0].results.map(result => result.value)).toEqual(fixture.records);
    expect(first.decision.mock.calls[0][0].event).toMatchObject(fixture.pending);
    expect(store.acceptedEvent(fixture.accountId, fixture.taskId, fixture.pending)?.consumed).toBe(true);
    first.value.close(); store.close();
    store = openStore(h.taskPath);
    const reopened = runtime(store, h.checkpointPath);
    expect((await reopened.value.advance(fixture.accountId, fixture.taskId)).status).toBe("ended");
    expect((await reopened.value.advance(fixture.accountId, fixture.taskId, fixture.pending)).status).toBe("ended");
    expect((await reopened.value.advance(fixture.accountId, fixture.taskId, fixture.consumed)).usage.calls).toBe(3);
    expect(reopened.decision).not.toHaveBeenCalled();
    expect(reopened.execute).not.toHaveBeenCalled();
    expect(digest(h.learningPath)).toBe(h.learningHash);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("keeps a resumed task waiting with zero new calls across reopen until new explicit feedback arrives", async () => {
    const h = setup();
    let store = openStore(h.taskPath);
    const first = runtime(store, h.checkpointPath, { wait: { kind: "feedback", message: "Await a new explicit response" } });
    expect((await first.value.advance(fixture.accountId, fixture.taskId)).status).toBe("waiting");
    expect(first.decision).toHaveBeenCalledTimes(1);
    expect(store.acceptedEvent(fixture.accountId, fixture.taskId, fixture.pending)?.consumed).toBe(true);
    expect((await first.value.advance(fixture.accountId, fixture.taskId)).status).toBe("waiting");
    expect((await first.value.advance(fixture.accountId, fixture.taskId, fixture.pending)).status).toBe("waiting");
    expect(first.decision).toHaveBeenCalledTimes(1);
    expect(first.execute).not.toHaveBeenCalled();
    first.value.close(); store.close();
    store = openStore(h.taskPath);
    const reopened = runtime(store, h.checkpointPath);
    expect((await reopened.value.advance(fixture.accountId, fixture.taskId)).status).toBe("waiting");
    expect((await reopened.value.advance(fixture.accountId, fixture.taskId, fixture.consumed)).status).toBe("waiting");
    expect(reopened.decision).not.toHaveBeenCalled();
    expect(store.getTask(fixture.accountId, fixture.taskId).usage.calls).toBe(3);
    const feedback = { id: "synthetic-new-user-feedback", kind: "feedback", message: "Synthetic explicit user feedback" };
    const ended = await reopened.value.advance(fixture.accountId, fixture.taskId, feedback);
    expect(ended.status).toBe("ended");
    expect(ended.usage.calls).toBe(4);
    expect(reopened.decision).toHaveBeenCalledTimes(1);
    expect(reopened.execute).not.toHaveBeenCalled();
    expect(ended.actions).toHaveLength(2);
    expect(digest(h.learningPath)).toBe(h.learningHash);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
