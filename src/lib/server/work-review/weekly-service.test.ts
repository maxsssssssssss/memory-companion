import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { openWorkReviewDatabase } from "./db";
import { WorkTodoRepository } from "./todo-repository";
import { WorkWeeklyConflictError } from "./weekly-repository";
import { WorkWeeklyService } from "./weekly-service";

let databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases) database.close();
  databases = [];
});

function setup() {
  const database = openWorkReviewDatabase({ filePath: ":memory:" });
  databases.push(database);
  let id = 0;
  let now = new Date("2026-09-03T02:00:00.000Z");
  const service = new WorkWeeklyService(database, {
    now: () => now,
    idFactory: () => `id_${++id}`
  });
  new WorkTodoRepository(database, {
    now: () => "2026-09-03T01:59:00.000Z",
    idFactory: () => "seed"
  }).createManualTodo({
    accountId: "account_a",
    operationKey: "seed_todo",
    title: "Existing source",
    kind: "self",
    notes: null,
    ownerLabel: null,
    currentDueDate: null,
    isImportant: false,
    myDayDate: null
  });
  return {
    database,
    now: () => now,
    setNow: (value: string) => { now = new Date(value); },
    service
  };
}

const scope = {
  weekStart: "2026-08-31",
  timeZone: "Asia/Shanghai",
  scopeKind: "all" as const,
  projectId: null
};

describe("WorkWeeklyService consistency", () => {
  it("returns the same explicit latest-generation status from scope and detail without manufacturing ready content", () => {
    const { service } = setup();
    expect(service.getByScope("account_a", scope)).toMatchObject({ review: null, items: [], latestGeneration: null });
    const queued = service.generate("account_a", { ...scope, operationKey: "quality_dto", expectedVersion: null });
    expect(service.getByScope("account_a", scope).latestGeneration).toMatchObject({
      runId: queued.run.id, executionStatus: "pending", qualityStatus: "not_assessed" });
    const repository = service.runtimeRepository();
    const fence = repository.claimGenerationRun({ accountId: "account_a", runId: queued.run.id,
      leaseOwner: "fixture_worker", leaseMs: 60_000 });
    repository.markGenerationFailed({ accountId: "account_a", fence,
      errorCode: "weekly_generation_quality_insufficient", qualityAssessment: { status: "insufficient" } });
    const detail = service.getDetail("account_a", queued.review.id);
    expect(detail.review.status).toBe("failed");
    expect(detail.items).toEqual([]);
    expect(detail.latestGeneration).toMatchObject({ executionStatus: "completed", sourceCheckStatus: "completed",
      qualityStatus: "insufficient", displayingPreviousVersion: false });
    expect(service.getByScope("account_a", scope).latestGeneration).toEqual(detail.latestGeneration);
    expect(service.getByScope("account_b", scope)).toMatchObject({ review: null, items: [], latestGeneration: null });
  });

  it("does not queue a GPT run for an empty source scope", () => {
    const database = openWorkReviewDatabase({ filePath: ":memory:" });
    databases.push(database);
    const service = new WorkWeeklyService(database, {
      now: () => new Date("2026-09-03T02:00:00.000Z")
    });
    expect(() => service.generate("account_a", {
      ...scope,
      operationKey: "generate_empty",
      expectedVersion: null
    })).toThrow("weekly_insufficient_sources");
    expect(database.prepare(`SELECT count(*) AS count FROM wr_weekly_review_runs`).get())
      .toEqual({ count: 0 });
  });

  it("freezes the timezone before GET reconciliation can mutate an existing review", () => {
    const { service } = setup();
    const generated = service.generate("account_a", {
      ...scope,
      operationKey: "generate_timezone",
      expectedVersion: null
    });
    const before = service.runtimeRepository().getReview("account_a", generated.review.id);
    expect(() => service.getByScope("account_a", {
      ...scope,
      timeZone: "UTC"
    })).toThrow(WorkWeeklyConflictError);
    expect(service.runtimeRepository().getReview("account_a", generated.review.id)).toEqual(before);
  });

  it("rebuilds live sources inside publication and never promotes an unpublished stale review", () => {
    const { database, now, setNow, service } = setup();
    const queuedSnapshot = service.buildSnapshot("account_a", scope);
    const generated = service.generate("account_a", {
      ...scope,
      operationKey: "generate_atomic_fence",
      expectedVersion: null
    });
    const repository = service.runtimeRepository();
    const fence = repository.claimGenerationRun({
      accountId: "account_a",
      runId: generated.run.id,
      leaseOwner: "worker_a",
      leaseMs: 60_000
    });
    new WorkTodoRepository(database, {
      now: () => now().toISOString(),
      idFactory: () => "new_source"
    }).createManualTodo({
      accountId: "account_a",
      operationKey: "new_source_todo",
      title: "New source after claim",
      kind: "self",
      notes: null,
      ownerLabel: null,
      currentDueDate: null,
      isImportant: false,
      myDayDate: null
    });
    setNow("2026-09-03T02:00:30.000Z");
    expect(() => repository.publishSystemVersion({
      accountId: "account_a",
      fence,
      currentSnapshot: queuedSnapshot,
      items: [],
      synthesizerProfile: "future_text_owner",
      verifierProfile: null
    })).toThrow("weekly_source_changed");
    expect(repository.getReview("account_a", generated.review.id)).toMatchObject({
      status: "stale",
      currentSystemVersion: 0
    });
    expect(service.getDetail("account_a", generated.review.id).review).toMatchObject({
      status: "stale",
      currentSystemVersion: 0
    });
  });
});
