import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { WorkWeeklySourceSnapshotSchema } from "@/lib/domain/work-weekly";

import { openWorkReviewDatabase } from "./db";
import {
  WorkWeeklyConflictError,
  WorkWeeklyNotFoundError,
  WorkWeeklyRepository,
  WorkWeeklyVersionConflictError
} from "./weekly-repository";
import { invalidateWorkWeeklySourcesWithinTransaction } from "./weekly-invalidation";
import { migrateWorkReviewSchema } from "./schema";

let databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases) database.close();
  databases = [];
});

function database() {
  const value = openWorkReviewDatabase({ filePath: ":memory:" });
  databases.push(value);
  return value;
}

function snapshot(digestCharacter = "a", includeSource = true) {
  const ref = "wrs_source_1";
  return WorkWeeklySourceSnapshotSchema.parse({
    contractVersion: 1,
    accountId: "account_a",
    scope: {
      weekStart: "2026-08-31", weekEnd: "2026-09-06",
      observedThrough: "2026-09-06", windowComplete: true,
      timeZone: "Asia/Shanghai", scopeKind: "all", projectId: null
    },
    digest: digestCharacter.repeat(64),
    inputPackDigest: "b".repeat(64),
    createdAt: "2026-09-07T00:00:00.000Z",
    summary: {
      meetingCount: includeSource ? 1 : 0, findingCount: includeSource ? 1 : 0,
      todoCount: 0, todoEventCount: 0, evidenceCount: 0, projectCount: 0,
      pendingCandidateCount: 0, includedFindingCount: includeSource ? 1 : 0,
      includedTodoCount: 0, includedTodoEventCount: 0, includedEvidenceCount: 0,
      omittedFindingCount: 0, omittedTodoCount: 0, omittedTodoEventCount: 0,
      omittedEvidenceCount: 0, truncated: false, historyCompleteness: "exact"
    },
    identities: includeSource ? [{
      sourceRef: ref, sourceKind: "finding", sourceId: "finding_1", version: 1,
      digest: "c".repeat(64), publicationId: null, segmentId: null, included: true
    }] : [],
    meetings: [],
    findings: includeSource ? [{
      sourceRef: ref, id: "finding_1", meetingId: "meeting_1", version: 1,
      kind: "decision", title: "Decision", body: "Ship", structuredData: {},
      userConfirmedAt: "2026-09-01T00:00:00.000Z", userEditedAt: null,
      evidenceRefs: [ref]
    }] : [],
    todos: [], todoEvents: [], projects: [], evidence: [],
    allowlistedSourceRefs: includeSource ? [ref] : []
  });
}

function snapshotWithMeetingSource() {
  const value = snapshot();
  return WorkWeeklySourceSnapshotSchema.parse({
    ...value,
    identities: [...value.identities, {
      sourceRef: "wrs_meeting_1", sourceKind: "meeting", sourceId: "meeting_1",
      version: 1, digest: "e".repeat(64), publicationId: "publication_1",
      segmentId: null, included: true
    }],
    meetings: [{
      sourceRef: "wrs_meeting_1", id: "meeting_1", version: 1,
      title: "Planning", meetingDate: "2026-09-01", reviewStatus: "completed",
      pendingCandidateCount: 0, canonicalPublicationId: "publication_1",
      canonicalContentDigest: "e".repeat(64), projects: []
    }],
    allowlistedSourceRefs: [...value.allowlistedSourceRefs, "wrs_meeting_1"]
  });
}

function snapshotWithIndependentMeetingSource() {
  const value = snapshot();
  return WorkWeeklySourceSnapshotSchema.parse({
    ...value,
    summary: { ...value.summary, meetingCount: 2 },
    identities: [...value.identities, {
      sourceRef: "wrs_meeting_2", sourceKind: "meeting", sourceId: "meeting_2",
      version: 1, digest: "f".repeat(64), publicationId: "publication_2",
      segmentId: null, included: true
    }],
    meetings: [{
      sourceRef: "wrs_meeting_2", id: "meeting_2", version: 1,
      title: "Independent source", meetingDate: "2026-09-02", reviewStatus: "completed",
      pendingCandidateCount: 0, canonicalPublicationId: "publication_2",
      canonicalContentDigest: "f".repeat(64), projects: []
    }],
    allowlistedSourceRefs: [...value.allowlistedSourceRefs, "wrs_meeting_2"]
  });
}

describe("WorkWeeklyRepository", () => {
  it.each(["duplicate", "processing", "verifying", "completed", "failed", "superseded", "deleted",
    "accountId", "weeklyReviewId", "runVersion", "sourceSnapshotDigest", "threadId", "questionMessageId"])(
    "atomically admits QA only once with exact queued identity: %s", (variant) => {
      const db = database();
      const source = snapshot();
      const repository = new WorkWeeklyRepository(db, { now: () => "2026-09-07T00:00:00.000Z", currentSnapshotBuilder: () => source });
      const queued = repository.queueGeneration({ accountId: "account_a", snapshot: source, operationKey: "generate_admission", expectedVersion: null, kind: "generate" });
      const fence = repository.claimGenerationRun({ accountId: "account_a", runId: queued.run.id, leaseOwner: "fixture", leaseMs: 60_000 });
      const ready = repository.publishSystemVersion({ accountId: "account_a", fence, currentSnapshot: source,
        items: [{ section: "decisions", text: "Fixture", sourceRefs: source.allowlistedSourceRefs, verificationState: "verified", sortOrder: 0 }], synthesizerProfile: "fixture", verifierProfile: null });
      const question = repository.queueQuestion({ accountId: "account_a", reviewId: ready.review.id, snapshot: source,
        question: "本周？", operationKey: "ask_admission", expectedVersion: null });
      const expected = { weeklyReviewId: question.run.weeklyReviewId, runVersion: question.run.runVersion,
        sourceSnapshotDigest: question.run.sourceSnapshotDigest, threadId: question.run.threadId, questionMessageId: question.run.questionMessageId };
      const claim = { accountId: "account_a", runId: question.run.id, leaseOwner: "worker_a", leaseMs: 60_000, expectedQueuedRun: expected };
      if (variant === "duplicate") {
        expect(repository.claimQaRun(claim).runId).toBe(question.run.id);
      } else if (["processing", "verifying", "completed", "failed", "superseded", "deleted"].includes(variant)) {
        const active = variant === "processing" || variant === "verifying";
        db.prepare("UPDATE wr_weekly_qa_runs SET state = ?, lease_owner = ?, lease_expires_at = ? WHERE id = ?")
          .run(variant, active ? "old_worker" : null, active ? "2026-09-01T00:00:00.000Z" : null, question.run.id);
      } else if (variant === "accountId") claim.accountId = "account_b";
      else Object.assign(expected, { [variant]: variant === "runVersion" ? 99 : "mismatched" });
      expect(() => repository.claimQaRun(claim)).toThrow();
      // A forged transport hint must not consume or fail the valid queued run.
      if (["accountId", "weeklyReviewId", "runVersion", "sourceSnapshotDigest", "threadId", "questionMessageId"].includes(variant)) {
        expect(db.prepare("SELECT state FROM wr_weekly_qa_runs WHERE id = ?").get(question.run.id)).toEqual({ state: "queued" });
      }
    });
  it.each(["passed", "needs_review"] as const)("persists %s across reopening, a later failure and explicit reset", (status) => {
    const directory = mkdtempSync(join(tmpdir(), "wr-weekly-quality-"));
    const filePath = join(directory, "fixture.sqlite");
    let db = openWorkReviewDatabase({ filePath });
    const source = snapshot();
    const options = { now: () => "2026-09-07T00:00:00.000Z", currentSnapshotBuilder: () => source };
    const reviewIssues = status === "needs_review"
      ? [{ sourceRef: "wrs_source_1", reasonCode: "missing_qualification" as const }] : [];
    try {
      let repository = new WorkWeeklyRepository(db, options);
      const queued = repository.queueGeneration({ accountId: "account_a", snapshot: source,
        operationKey: "persisted_quality", expectedVersion: null, kind: "generate" });
      const fence = repository.claimGenerationRun({ accountId: "account_a", runId: queued.run.id,
        leaseOwner: "fixture", leaseMs: 60_000 });
      const publication = { accountId: "account_a", fence, currentSnapshot: source,
        synthesizerProfile: "fixture", verifierProfile: "fixture", qualityAssessment: { status, reviewIssues },
        items: [{ section: "progress" as const, text: "Supported progress", sourceRefs: ["wrs_source_1"],
          verificationState: "verified" as const, sortOrder: 0 }] };
      const first = repository.publishSystemVersion(publication);
      expect(() => repository.publishSystemVersion(publication)).toThrow("Work Weekly lease is no longer owned");
      const expected = { runId: queued.run.id, runVersion: 1, systemVersion: 1, qualityStatus: status, reviewIssues };
      expect(repository.getDetail("account_a", first.review.id).displayedGeneration).toEqual(expected);
      expect(() => repository.getDisplayedGeneration("account_b", first.review.id)).toThrow(WorkWeeklyNotFoundError);
      expect(() => db.prepare("UPDATE wr_weekly_system_versions SET created_at = created_at").run())
        .toThrow("work_weekly_system_version_immutable");
      repository.updateItem({ accountId: "account_a", reviewId: first.review.id, itemId: first.items[0]!.id,
        operationKey: "edit_partial", expectedVersion: first.items[0]!.version,
        text: "User clarification", hidden: true, sortOrder: 9 });
      repository.createUserNote({ accountId: "account_a", reviewId: first.review.id, operationKey: "partial_note",
        expectedVersion: repository.getReview("account_a", first.review.id).version,
        section: "overview", text: "User note", sortOrder: 0 });
      const savedItems = repository.listItems("account_a", first.review.id);
      const second = repository.queueGeneration({ accountId: "account_a", snapshot: source,
        operationKey: "later_attempt", expectedVersion: repository.getReview("account_a", first.review.id).version,
        kind: "regenerate" });
      expect(repository.getDetail("account_a", first.review.id)).toMatchObject({
        latestGeneration: { executionStatus: "pending" }, displayedGeneration: expected });
      const secondFence = repository.claimGenerationRun({ accountId: "account_a", runId: second.run.id,
        leaseOwner: "next", leaseMs: 60_000 });
      expect(() => repository.publishSystemVersion({ ...publication, fence: secondFence, items: [] }))
        .toThrow("weekly_generation_quality_insufficient");
      repository.markGenerationFailed({ accountId: "account_a", fence: secondFence,
        errorCode: "work_weekly_provider_schema_invalid" });
      db.close();
      db = openWorkReviewDatabase({ filePath });
      repository = new WorkWeeklyRepository(db, options);
      expect(repository.getDetail("account_a", first.review.id)).toMatchObject({
        items: savedItems, displayedGeneration: expected,
        latestGeneration: { qualityStatus: "not_assessed", displayingPreviousVersion: true } });
      const reset = { accountId: "account_a", reviewId: first.review.id, operationKey: "partial_reset",
        expectedVersion: repository.getReview("account_a", first.review.id).version };
      repository.resetToCurrentSystemVersion(reset);
      expect(repository.resetToCurrentSystemVersion(reset).reused).toBe(true);
      expect(repository.getDisplayedGeneration("account_a", first.review.id)).toEqual(expected);
      expect(repository.listItems("account_a", first.review.id).some((item) => item.userText === "User note")).toBe(true);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      if (db.open) db.close();
      const target = resolve(directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("wr-weekly-quality-")) {
        throw new Error("fixture_cleanup_scope_invalid");
      }
      rmSync(target, { recursive: true });
    }
  });

  it.each(["reconcile", "meeting_delete"] as const)("rejects unsafe issues and redacts deleted refs through %s", (mode) => {
    const db = database();
    const source = snapshot();
    const repository = new WorkWeeklyRepository(db, { now: () => "2026-09-07T00:00:00.000Z",
      currentSnapshotBuilder: () => source });
    const queued = repository.queueGeneration({ accountId: "account_a", snapshot: source,
      operationKey: "issue_authority", expectedVersion: null, kind: "generate" });
    const fence = repository.claimGenerationRun({ accountId: "account_a", runId: queued.run.id,
      leaseOwner: "fixture", leaseMs: 60_000 });
    const publication = { accountId: "account_a", fence, currentSnapshot: source,
      synthesizerProfile: "fixture", verifierProfile: "fixture",
      items: [{ section: "progress" as const, text: "Supported progress", sourceRefs: ["wrs_source_1"],
        verificationState: "verified" as const, sortOrder: 0 }] };
    expect(() => repository.publishSystemVersion({ ...publication,
      qualityAssessment: { status: "needs_review", reviewIssues: [] } })).toThrow("weekly_quality_assessment_invalid");
    expect(() => repository.publishSystemVersion({ ...publication, qualityAssessment: { status: "needs_review",
      reviewIssues: [{ sourceRef: "wrs_other_account", reasonCode: "missing_key_content" }] } }))
      .toThrow("weekly_source_not_allowlisted");
    expect(db.prepare("SELECT count(*) AS n FROM wr_weekly_system_versions").get()).toEqual({ n: 0 });
    repository.publishSystemVersion({ ...publication, qualityAssessment: { status: "needs_review",
      reviewIssues: [{ sourceRef: "wrs_source_1", reasonCode: "missing_key_content" }] } });
    if (mode === "reconcile") {
      repository.reconcileSourceValidity({ accountId: "account_a", reviewId: queued.review.id, snapshot: snapshot("d", false) });
    } else {
      db.transaction(() => invalidateWorkWeeklySourcesWithinTransaction(db, {
        accountId: "account_a", now: "2026-09-07T00:00:00.000Z", meetingId: "meeting_1"
      })).immediate();
    }
    const quality = repository.getDisplayedGeneration("account_a", queued.review.id);
    expect(quality).toMatchObject({ qualityStatus: "needs_review",
      reviewIssues: [{ sourceRef: null, reasonCode: "source_unavailable" }] });
    expect(JSON.stringify(quality)).not.toContain("wrs_source_1");
    expect(db.prepare("SELECT quality_assessment_json FROM wr_weekly_review_runs WHERE id = ?").get(queued.run.id))
      .toEqual({ quality_assessment_json: JSON.stringify({ status: "needs_review",
        reviewIssues: [{ sourceRef: null, reasonCode: "source_unavailable" }] }) });
    expect(repository.listItems("account_a", queued.review.id)[0]!.verificationState).toBe("invalidated");
  });

  it("adds V8 metadata without reclassifying or rewriting populated V7 publications", () => {
    const db = database();
    const source = snapshot();
    const repository = new WorkWeeklyRepository(db, { now: () => "2026-09-07T00:00:00.000Z",
      currentSnapshotBuilder: () => source });
    const queued = repository.queueGeneration({ accountId: "account_a", snapshot: source,
      operationKey: "migration_quality", expectedVersion: null, kind: "generate" });
    const fence = repository.claimGenerationRun({ accountId: "account_a", runId: queued.run.id,
      leaseOwner: "fixture", leaseMs: 60_000 });
    repository.publishSystemVersion({ accountId: "account_a", fence, currentSnapshot: source,
      synthesizerProfile: "legacy", verifierProfile: "legacy", items: [{ section: "progress",
        text: "Legacy stored item", sourceRefs: ["wrs_source_1"], verificationState: "verified", sortOrder: 0 }] });
    db.exec("ALTER TABLE wr_weekly_review_runs DROP COLUMN quality_assessment_json; DELETE FROM wr_schema_migrations WHERE version=8; PRAGMA user_version=7;");
    const before = db.prepare("SELECT * FROM wr_weekly_system_versions").all();
    migrateWorkReviewSchema(db);
    migrateWorkReviewSchema(db);
    expect(db.pragma("user_version", { simple: true })).toBe(8);
    expect(db.prepare("SELECT * FROM wr_weekly_system_versions").all()).toEqual(before);
    expect(db.prepare("SELECT quality_assessment_json FROM wr_weekly_review_runs").get()).toEqual({ quality_assessment_json: null });
    expect(repository.getDisplayedGeneration("account_a", queued.review.id)?.qualityStatus).toBe("not_assessed");
    db.prepare("UPDATE wr_weekly_review_runs SET pipeline_version = 'work_weekly_v2' WHERE id=?").run(queued.run.id);
    expect(repository.getDisplayedGeneration("account_a", queued.review.id)?.qualityStatus).toBe("passed");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("retains the immutable prior version, user edit and note when new coverage is insufficient", () => {
    const db = database();
    let id = 0;
    const source = snapshot();
    const repository = new WorkWeeklyRepository(db, {
      now: () => "2026-09-07T00:00:00.000Z", idFactory: () => `quality_${++id}`,
      currentSnapshotBuilder: () => source
    });
    const queued = repository.queueGeneration({ accountId: "account_a", snapshot: source,
      operationKey: "quality_seed", expectedVersion: null, kind: "generate" });
    const firstFence = repository.claimGenerationRun({ accountId: "account_a", runId: queued.run.id,
      leaseOwner: "seed", leaseMs: 60_000 });
    const first = repository.publishSystemVersion({ accountId: "account_a", fence: firstFence,
      currentSnapshot: source, synthesizerProfile: "fixture", verifierProfile: "fixture",
      items: [{ section: "decisions", text: "Original decision", sourceRefs: ["wrs_source_1"],
        verificationState: "verified", sortOrder: 0 }] });
    expect(repository.getLatestGeneration("account_a", first.review.id)).toMatchObject({ executionStatus: "completed",
      sourceCheckStatus: "completed", qualityStatus: "not_assessed", displayingPreviousVersion: false });
    repository.updateItem({ accountId: "account_a", reviewId: first.review.id, itemId: first.items[0]!.id,
      operationKey: "quality_edit", expectedVersion: first.items[0]!.version, text: "User clarification" });
    repository.createUserNote({ accountId: "account_a", reviewId: first.review.id,
      operationKey: "quality_note", expectedVersion: repository.getReview("account_a", first.review.id).version,
      section: "overview", text: "Personal note", sortOrder: 1 });
    const oldItems = repository.listItems("account_a", first.review.id);
    const oldVersions = db.prepare("SELECT * FROM wr_weekly_system_versions").all();
    const regenerate = repository.queueGeneration({ accountId: "account_a", snapshot: source,
      operationKey: "quality_regenerate", expectedVersion: repository.getReview("account_a", first.review.id).version,
      kind: "regenerate" });
    expect(repository.getLatestGeneration("account_a", first.review.id)).toMatchObject({
      executionStatus: "pending", qualityStatus: "not_assessed", displayingPreviousVersion: true });
    const fence = repository.claimGenerationRun({ accountId: "account_a", runId: regenerate.run.id,
      leaseOwner: "new_worker", leaseMs: 60_000 });
    expect(() => repository.publishSystemVersion({ accountId: "account_a", fence,
      currentSnapshot: source, synthesizerProfile: "fixture", verifierProfile: "fixture",
      qualityAssessment: { status: "insufficient" }, items: [{ section: "decisions", text: "Incomplete replacement",
        sourceRefs: ["wrs_source_1"], verificationState: "verified", sortOrder: 0 }] }))
      .toThrow("weekly_generation_quality_insufficient");
    repository.markGenerationFailed({ accountId: "account_a", fence,
      errorCode: "weekly_generation_quality_insufficient", qualityAssessment: { status: "insufficient" } });
    const detail = repository.getDetail("account_a", first.review.id);
    expect(detail.review).toMatchObject({ status: "failed", currentSystemVersion: 1 });
    expect(detail.items).toEqual(oldItems);
    expect(db.prepare("SELECT * FROM wr_weekly_system_versions").all()).toEqual(oldVersions);
    expect(detail.latestGeneration).toMatchObject({ runId: regenerate.run.id,
      executionStatus: "completed", sourceCheckStatus: "completed", qualityStatus: "insufficient",
      displayingPreviousVersion: true, errorCode: "weekly_generation_quality_insufficient" });
    expect(() => repository.getDetail("account_b", first.review.id)).toThrow(WorkWeeklyNotFoundError);
    expect(repository.canCaptureGeneration("account_a", fence)).toBe(false);
    expect(repository.canCaptureGeneration("account_a", fence, true)).toBe(true);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("does not present a fresh insufficient generation as ready or as an old system version", () => {
    const db = database();
    const source = snapshot();
    const repository = new WorkWeeklyRepository(db, { now: () => "2026-09-07T00:00:00.000Z",
      currentSnapshotBuilder: () => source });
    const queued = repository.queueGeneration({ accountId: "account_a", snapshot: source,
      operationKey: "fresh_quality", expectedVersion: null, kind: "generate" });
    const fence = repository.claimGenerationRun({ accountId: "account_a", runId: queued.run.id,
      leaseOwner: "worker", leaseMs: 60_000 });
    repository.markGenerationFailed({ accountId: "account_a", fence,
      errorCode: "weekly_generation_quality_insufficient", qualityAssessment: { status: "insufficient" } });
    expect(repository.getDetail("account_a", queued.review.id)).toMatchObject({
      review: { status: "failed", currentSystemVersion: 0 }, items: [], latestGeneration: {
        executionStatus: "completed", sourceCheckStatus: "completed", qualityStatus: "insufficient",
        displayingPreviousVersion: false }
    });
    expect(db.prepare("SELECT count(*) AS count FROM wr_weekly_system_items").get()).toEqual({ count: 0 });
  });

  it("requires nonempty verified output for an explicit quality pass and keeps the original publication fence", () => {
    const db = database();
    const source = snapshot();
    const repository = new WorkWeeklyRepository(db, { now: () => "2026-09-07T00:00:00.000Z",
      currentSnapshotBuilder: () => source });
    const queued = repository.queueGeneration({ accountId: "account_a", snapshot: source,
      operationKey: "quality_pass", expectedVersion: null, kind: "generate" });
    const fence = repository.claimGenerationRun({ accountId: "account_a", runId: queued.run.id,
      leaseOwner: "worker", leaseMs: 60_000 });
    const input = { accountId: "account_a", fence, currentSnapshot: source,
      synthesizerProfile: "fixture", verifierProfile: "fixture", qualityAssessment: { status: "passed" as const },
      items: [{ section: "decisions" as const, text: "Ship", sourceRefs: ["wrs_source_1"],
        verificationState: "verified" as const, sortOrder: 0 }] };
    expect(() => repository.publishSystemVersion({ ...input, items: [] })).toThrow("weekly_generation_quality_insufficient");
    expect(() => repository.publishSystemVersion({ ...input, verifierProfile: null })).toThrow("weekly_generation_quality_insufficient");
    expect(() => repository.publishSystemVersion({ ...input, accountId: "account_b" })).toThrow("weekly_snapshot_account_mismatch");
    const result = repository.publishSystemVersion(input);
    expect(repository.getLatestGeneration("account_a", result.review.id)).toMatchObject({ executionStatus: "completed", sourceCheckStatus: "completed",
      qualityStatus: "passed", displayingPreviousVersion: false });
    expect(() => repository.publishSystemVersion(input)).toThrow("Work Weekly lease is no longer owned");
    expect(db.prepare("SELECT count(*) AS count FROM wr_weekly_system_versions").get()).toEqual({ count: 1 });
  });

  it.each([
    ["weekly_generation_provider_timeout", "failed"],
    ["weekly_generation_provider_outcome_unknown", "unknown"],
    ["weekly_generation_quality_insufficient", "failed"],
    ["unsafe raw error body", "failed"]
  ] as const)("does not infer coverage from an unassessed %s run", (errorCode, executionStatus) => {
    const db = database();
    const source = snapshot();
    const repository = new WorkWeeklyRepository(db, { now: () => "2026-09-07T00:00:00.000Z",
      currentSnapshotBuilder: () => source });
    const queued = repository.queueGeneration({ accountId: "account_a", snapshot: source,
      operationKey: "unassessed", expectedVersion: null, kind: "generate" });
    const fence = repository.claimGenerationRun({ accountId: "account_a", runId: queued.run.id,
      leaseOwner: "worker", leaseMs: 60_000 });
    repository.markGenerationFailed({ accountId: "account_a", fence, errorCode });
    expect(repository.getLatestGeneration("account_a", queued.review.id)).toMatchObject({
      executionStatus, sourceCheckStatus: "not_established", qualityStatus: "not_assessed",
      errorCode: errorCode.startsWith("weekly_") ? errorCode : null
    });
  });

  it("rejects capture after lease expiry, account mismatch, replacement or deletion", () => {
    const db = database();
    const source = snapshot();
    let now = "2026-09-07T00:00:00.000Z";
    const repository = new WorkWeeklyRepository(db, { now: () => now, currentSnapshotBuilder: () => source });
    const first = repository.queueGeneration({ accountId: "account_a", snapshot: source,
      operationKey: "capture_first", expectedVersion: null, kind: "generate" });
    const fence = repository.claimGenerationRun({ accountId: "account_a", runId: first.run.id,
      leaseOwner: "worker", leaseMs: 1_000 });
    expect(repository.canCaptureGeneration("account_a", fence)).toBe(true);
    expect(repository.canCaptureGeneration("account_b", fence)).toBe(false);
    expect(repository.canCaptureGeneration("account_a", { ...fence, sourceSnapshotDigest: "c".repeat(64) })).toBe(false);
    now = fence.leaseExpiresAt;
    expect(repository.canCaptureGeneration("account_a", fence)).toBe(false);
    const next = repository.queueGeneration({ accountId: "account_a", snapshot: source,
      operationKey: "capture_next", expectedVersion: repository.getReview("account_a", first.review.id).version,
      kind: "regenerate" });
    expect(repository.canCaptureGeneration("account_a", fence, true)).toBe(false);
    const nextFence = repository.claimGenerationRun({ accountId: "account_a", runId: next.run.id,
      leaseOwner: "new_worker", leaseMs: 60_000 });
    repository.deleteReview({ accountId: "account_a", reviewId: first.review.id,
      operationKey: "capture_delete", expectedVersion: repository.getReview("account_a", first.review.id).version });
    expect(repository.canCaptureGeneration("account_a", nextFence)).toBe(false);
    expect(repository.canCaptureGeneration("account_a", nextFence, true)).toBe(false);
  });

  it("requires source invalidation to run inside the caller transaction", () => {
    const db = database();
    expect(() => invalidateWorkWeeklySourcesWithinTransaction(db, {
      accountId: "account_a", meetingId: "meeting_1", now: "2026-09-07T00:00:00.000Z"
    })).toThrow("work_weekly_invalidation_requires_transaction");
  });

  it("queues idempotently, fences publication, and preserves immutable system output", () => {
    const db = database();
    let clock = "2026-09-07T00:00:00.000Z";
    let id = 0;
    const source = snapshot();
    const repository = new WorkWeeklyRepository(db, {
      now: () => clock,
      idFactory: () => `id_${++id}`,
      currentSnapshotBuilder: () => source
    });
    const queued = repository.queueGeneration({
      accountId: "account_a", snapshot: source, operationKey: "generate_1",
      expectedVersion: null, kind: "generate"
    });
    const replay = repository.queueGeneration({
      accountId: "account_a", snapshot: source, operationKey: "generate_1",
      expectedVersion: null, kind: "generate"
    });
    expect(replay.reused).toBe(true);
    expect(replay.run.id).toBe(queued.run.id);
    clock = "2026-09-07T00:01:00.000Z";
    const fence = repository.claimGenerationRun({
      accountId: "account_a", runId: queued.run.id, leaseOwner: "worker_1", leaseMs: 60_000
    });
    const published = repository.publishSystemVersion({
      accountId: "account_a", fence, currentSnapshot: source,
      items: [{ section: "decisions", text: "Ship", sourceRefs: ["wrs_source_1"],
        verificationState: "verified", sortOrder: 0 }],
      synthesizerProfile: "future_text_owner", verifierProfile: null
    });
    expect(published.review).toMatchObject({ status: "ready", currentSystemVersion: 1 });
    expect(published.items[0]).toMatchObject({ systemText: "Ship", sourceRefs: ["wrs_source_1"] });
    expect(db.prepare(`SELECT count(*) AS count FROM wr_weekly_system_items`).get())
      .toEqual({ count: 1 });
    expect(db.prepare(`SELECT count(*) AS count FROM wr_weekly_system_item_sources`).get())
      .toEqual({ count: 1 });
    expect(() => db.prepare(`
      UPDATE wr_weekly_system_versions SET source_summary_json = '{}'
      WHERE account_id = 'account_a'
    `).run()).toThrow("work_weekly_system_version_immutable");
    expect(() => db.prepare(`
      UPDATE wr_weekly_system_items SET body_text = 'mutated'
      WHERE account_id = 'account_a'
    `).run()).toThrow("work_weekly_system_item_immutable");
    expect(() => db.prepare(`
      UPDATE wr_weekly_system_item_sources SET source_ref = 'mutated'
      WHERE account_id = 'account_a'
    `).run()).toThrow("work_weekly_system_item_source_immutable");

    const regenerated = repository.queueGeneration({
      accountId: "account_a", snapshot: source, operationKey: "regenerate_1",
      expectedVersion: published.review.version, kind: "regenerate"
    });
    const regenerateFence = repository.claimGenerationRun({
      accountId: "account_a", runId: regenerated.run.id,
      leaseOwner: "worker_2", leaseMs: 60_000
    });
    repository.publishSystemVersion({
      accountId: "account_a", fence: regenerateFence, currentSnapshot: source,
      items: [{ section: "decisions", text: "Ship again", sourceRefs: ["wrs_source_1"],
        verificationState: "verified", sortOrder: 0 }],
      synthesizerProfile: "future_text_owner", verifierProfile: null
    });
    expect(db.prepare(`SELECT count(*) AS count FROM wr_weekly_system_versions`).get())
      .toEqual({ count: 2 });
    expect(db.prepare(`SELECT count(*) AS count FROM wr_weekly_system_item_sources`).get())
      .toEqual({ count: 2 });
  });

  it("preserves edited GPT overlays across regeneration and discards them only on reset", () => {
    const db = database();
    let id = 0;
    const source = snapshot();
    const repository = new WorkWeeklyRepository(db, {
      now: () => "2026-09-07T00:00:00.000Z",
      idFactory: () => `id_${++id}`,
      currentSnapshotBuilder: () => source
    });
    const queued = repository.queueGeneration({
      accountId: "account_a", snapshot: source, operationKey: "generate_overlay",
      expectedVersion: null, kind: "generate"
    });
    const fence = repository.claimGenerationRun({
      accountId: "account_a", runId: queued.run.id, leaseOwner: "worker_v1", leaseMs: 60_000
    });
    const first = repository.publishSystemVersion({
      accountId: "account_a", fence, currentSnapshot: source,
      items: [
        { section: "decisions", text: "Edit target", sourceRefs: ["wrs_source_1"],
          verificationState: "verified", sortOrder: 0 },
        { section: "progress", text: "Hide target", sourceRefs: ["wrs_source_1"],
          verificationState: "verified", sortOrder: 1 },
        { section: "next_week", text: "Reorder target", sourceRefs: ["wrs_source_1"],
          verificationState: "qualified", sortOrder: 2 },
        { section: "completed", text: "Clean target", sourceRefs: ["wrs_source_1"],
          verificationState: "verified", sortOrder: 3 }
      ],
      synthesizerProfile: "future", verifierProfile: null
    });
    const [editTarget, hideTarget, reorderTarget, cleanTarget] = first.items;
    const firstEdit = repository.updateItem({
      accountId: "account_a", reviewId: first.review.id, itemId: editTarget!.id,
      operationKey: "overlay_edit_v1", expectedVersion: editTarget!.version,
      text: "Edited before regenerate"
    });
    repository.updateItem({
      accountId: "account_a", reviewId: first.review.id, itemId: hideTarget!.id,
      operationKey: "overlay_hide_v1", expectedVersion: hideTarget!.version, hidden: true
    });
    repository.updateItem({
      accountId: "account_a", reviewId: first.review.id, itemId: reorderTarget!.id,
      operationKey: "overlay_reorder_v1", expectedVersion: reorderTarget!.version, sortOrder: 9
    });
    const note = repository.createUserNote({
      accountId: "account_a", reviewId: first.review.id, operationKey: "overlay_note",
      expectedVersion: repository.getReview("account_a", first.review.id).version,
      section: "overview", text: "Original note", sortOrder: 4
    });
    const editedNote = repository.updateItem({
      accountId: "account_a", reviewId: first.review.id, itemId: note.item.id,
      operationKey: "overlay_note_edit", expectedVersion: note.item.version,
      text: "Edited user note"
    });
    expect(editedNote.item.verificationState).toBe("user_authored");

    const regenerate = repository.queueGeneration({
      accountId: "account_a", snapshot: source, operationKey: "regenerate_overlay",
      expectedVersion: repository.getReview("account_a", first.review.id).version,
      kind: "regenerate"
    });
    const regenerateFence = repository.claimGenerationRun({
      accountId: "account_a", runId: regenerate.run.id,
      leaseOwner: "worker_v2", leaseMs: 60_000
    });
    const reviewVersionBeforeLateEdit = repository.getReview("account_a", first.review.id).version;
    const lateEditRequest = {
      accountId: "account_a", reviewId: first.review.id, itemId: editTarget!.id,
      operationKey: "overlay_edit_after_claim", expectedVersion: firstEdit.item.version,
      text: "Edited after worker claim"
    };
    const lateEdit = repository.updateItem(lateEditRequest);
    const reviewVersionAfterLateEdit = repository.getReview("account_a", first.review.id).version;
    expect(reviewVersionAfterLateEdit).toBe(reviewVersionBeforeLateEdit + 1);
    expect(repository.updateItem(lateEditRequest)).toMatchObject({ reused: true });
    expect(repository.getReview("account_a", first.review.id).version)
      .toBe(reviewVersionAfterLateEdit);
    expect(() => repository.updateItem({ ...lateEditRequest, text: "Different replay" }))
      .toThrow(WorkWeeklyConflictError);
    expect(() => repository.queueGeneration({
      accountId: "account_a", snapshot: source, operationKey: "stale_regenerate_overlay",
      expectedVersion: reviewVersionBeforeLateEdit, kind: "regenerate"
    })).toThrow(WorkWeeklyVersionConflictError);
    expect(() => repository.resetToCurrentSystemVersion({
      accountId: "account_a", reviewId: first.review.id,
      operationKey: "stale_reset_overlay", expectedVersion: reviewVersionBeforeLateEdit
    })).toThrow(WorkWeeklyVersionConflictError);
    expect(() => repository.resetToCurrentSystemVersion({
      accountId: "account_b", reviewId: first.review.id,
      operationKey: "cross_account_reset_overlay", expectedVersion: reviewVersionAfterLateEdit
    })).toThrow(WorkWeeklyNotFoundError);

    const second = repository.publishSystemVersion({
      accountId: "account_a", fence: regenerateFence, currentSnapshot: source,
      items: [{ section: "overview", text: "Current system item",
        sourceRefs: ["wrs_source_1"], verificationState: "qualified", sortOrder: 5 }],
      synthesizerProfile: "future", verifierProfile: null
    });
    const beforeReset = repository.listItems("account_a", first.review.id);
    expect(beforeReset.find((item) => item.id === editTarget!.id)).toMatchObject({
      systemText: "Edit target", userText: "Edited after worker claim",
      systemVersion: 1, sourceRefs: ["wrs_source_1"], version: lateEdit.item.version
    });
    expect(beforeReset.find((item) => item.id === hideTarget!.id)).toMatchObject({
      systemVersion: 1, sourceRefs: ["wrs_source_1"]
    });
    expect(beforeReset.find((item) => item.id === hideTarget!.id)!.hiddenAt).not.toBeNull();
    expect(beforeReset.find((item) => item.id === reorderTarget!.id)).toMatchObject({
      systemVersion: 1, sortOrder: 9, sourceRefs: ["wrs_source_1"]
    });
    expect(beforeReset.some((item) => item.id === cleanTarget!.id)).toBe(false);
    expect(beforeReset.find((item) => item.id === note.item.id)).toMatchObject({
      origin: "user_note", userText: "Edited user note", verificationState: "user_authored"
    });
    expect(beforeReset.find((item) => item.id === second.items[0]!.id)).toMatchObject({
      systemText: "Current system item", userText: null, systemVersion: 2,
      verificationState: "qualified", sortOrder: 5
    });
    const reviewVersionBeforePostPublishReplay = repository.getReview(
      "account_a", first.review.id).version;
    expect(repository.updateItem(lateEditRequest)).toMatchObject({
      reused: true, item: { id: editTarget!.id, userText: "Edited after worker claim" }
    });
    expect(repository.getReview("account_a", first.review.id).version)
      .toBe(reviewVersionBeforePostPublishReplay);

    const currentEdit = repository.updateItem({
      accountId: "account_a", reviewId: first.review.id, itemId: second.items[0]!.id,
      operationKey: "edit_current_before_reset", expectedVersion: second.items[0]!.version,
      text: "Current user edit", hidden: true, sortOrder: 42
    });
    expect(currentEdit.item).toMatchObject({
      userText: "Current user edit", verificationState: "qualified", sortOrder: 42
    });
    expect(currentEdit.item.hiddenAt).not.toBeNull();
    const resetRequest = {
      accountId: "account_a", reviewId: first.review.id, operationKey: "explicit_overlay_reset",
      expectedVersion: repository.getReview("account_a", first.review.id).version
    };
    const reset = repository.resetToCurrentSystemVersion(resetRequest);
    const versionAfterReset = reset.review.version;
    expect(repository.resetToCurrentSystemVersion(resetRequest)).toMatchObject({ reused: true });
    expect(repository.getReview("account_a", first.review.id).version).toBe(versionAfterReset);
    const afterReset = repository.listItems("account_a", first.review.id);
    expect(afterReset.filter((item) => item.origin === "gpt")).toHaveLength(1);
    expect(afterReset.find((item) => item.id === second.items[0]!.id)).toMatchObject({
      systemText: "Current system item", userText: null, hiddenAt: null,
      verificationState: "qualified", sortOrder: 5, systemVersion: 2
    });
    expect(afterReset.find((item) => item.id === note.item.id)).toMatchObject({
      origin: "user_note", userText: "Edited user note", verificationState: "user_authored"
    });
    expect(afterReset.some((item) => [editTarget!.id, hideTarget!.id, reorderTarget!.id]
      .includes(item.id))).toBe(false);
    expect(() => repository.updateItem(lateEditRequest)).toThrow(WorkWeeklyNotFoundError);
    expect(repository.listItems("account_a", first.review.id)
      .some((item) => item.id === editTarget!.id)).toBe(false);

    const reviewVersionBeforeNoteDelete = repository.getReview("account_a", first.review.id).version;
    const deleteNoteRequest = {
      accountId: "account_a", reviewId: first.review.id, itemId: note.item.id,
      operationKey: "delete_overlay_note", expectedVersion: editedNote.item.version
    };
    expect(repository.deleteUserNote(deleteNoteRequest)).toEqual({ deleted: true, reused: false });
    expect(repository.getReview("account_a", first.review.id).version)
      .toBe(reviewVersionBeforeNoteDelete + 1);
    expect(repository.deleteUserNote(deleteNoteRequest)).toEqual({ deleted: true, reused: true });
    expect(repository.getReview("account_a", first.review.id).version)
      .toBe(reviewVersionBeforeNoteDelete + 1);
    expect(() => repository.resetToCurrentSystemVersion({
      accountId: "account_a", reviewId: first.review.id,
      operationKey: "stale_reset_after_note_delete",
      expectedVersion: reviewVersionBeforeNoteDelete
    })).toThrow(WorkWeeklyVersionConflictError);
  });

  it("marks stale, invalidates the whole GPT item, and preserves user notes", () => {
    const db = database();
    let clock = "2026-09-07T00:00:00.000Z";
    let id = 0;
    const source = snapshot();
    const repository = new WorkWeeklyRepository(db, {
      now: () => clock,
      idFactory: () => `id_${++id}`,
      currentSnapshotBuilder: () => source
    });
    const queued = repository.queueGeneration({
      accountId: "account_a", snapshot: source, operationKey: "generate",
      expectedVersion: null, kind: "generate"
    });
    const fence = repository.claimGenerationRun({
      accountId: "account_a", runId: queued.run.id, leaseOwner: "worker", leaseMs: 60_000
    });
    const published = repository.publishSystemVersion({
      accountId: "account_a", fence, currentSnapshot: source,
      items: [{ section: "decisions", text: "Sensitive sourced text",
        sourceRefs: ["wrs_source_1"], verificationState: "verified", sortOrder: 0 }],
      synthesizerProfile: "future", verifierProfile: null
    });
    const note = repository.createUserNote({
      accountId: "account_a", reviewId: published.review.id, operationKey: "note",
      expectedVersion: published.review.version, section: "overview",
      text: "My private note", sortOrder: 1
    });
    const changed = snapshot("d", false);
    const reconciled = repository.reconcileSourceValidity({
      accountId: "account_a", reviewId: published.review.id, snapshot: changed
    });
    expect(reconciled.stale).toBe(true);
    const items = repository.listItems("account_a", published.review.id);
    expect(items.find((item) => item.origin === "gpt")).toMatchObject({
      systemText: "来源已失效，内容不可用", verificationState: "invalidated"
    });
    expect(items.find((item) => item.id === note.item.id)?.userText).toBe("My private note");
    expect(db.prepare(`
      SELECT body_text, erased_at IS NOT NULL AS erased
      FROM wr_weekly_system_items LIMIT 1
    `).get()).toEqual({ body_text: "来源已失效，内容不可用", erased: 1 });
    expect(db.prepare(`
      SELECT count(*) AS count FROM wr_weekly_system_item_sources
      WHERE invalidated_at IS NOT NULL
    `).get()).toEqual({ count: 1 });
  });

  it("reconciles only missing source edges and keeps later hard deletion idempotent", () => {
    const db = database();
    let id = 0;
    const source = snapshotWithIndependentMeetingSource();
    const repository = new WorkWeeklyRepository(db, {
      now: () => "2026-09-07T00:00:00.000Z",
      idFactory: () => `id_${++id}`,
      currentSnapshotBuilder: () => source
    });
    const queued = repository.queueGeneration({
      accountId: "account_a", snapshot: source, operationKey: "generate_reconcile_partial",
      expectedVersion: null, kind: "generate"
    });
    const fence = repository.claimGenerationRun({
      accountId: "account_a", runId: queued.run.id, leaseOwner: "worker", leaseMs: 60_000
    });
    const published = repository.publishSystemVersion({
      accountId: "account_a", fence, currentSnapshot: source,
      items: [{ section: "decisions", text: "Reconcile two-source result",
        sourceRefs: ["wrs_source_1", "wrs_meeting_2"],
        verificationState: "verified", sortOrder: 0 }],
      synthesizerProfile: "future", verifierProfile: null
    });
    const edited = repository.updateItem({
      accountId: "account_a", reviewId: published.review.id,
      itemId: published.items[0]!.id, operationKey: "edit_before_reconcile",
      expectedVersion: published.items[0]!.version, text: "Keep my edit"
    });
    const note = repository.createUserNote({
      accountId: "account_a", reviewId: published.review.id,
      operationKey: "reconcile_note",
      expectedVersion: repository.getReview("account_a", published.review.id).version,
      section: "overview", text: "Keep my note", sortOrder: 1
    });
    const question = repository.queueQuestion({
      accountId: "account_a", reviewId: published.review.id, snapshot: source,
      question: "What changed?", operationKey: "reconcile_question", expectedVersion: null
    });
    const qaFence = repository.claimQaRun({
      accountId: "account_a", runId: question.run.id, leaseOwner: "qa_worker", leaseMs: 60_000
    });
    const answer = repository.publishQaAnswer({
      accountId: "account_a", fence: qaFence, currentSnapshot: source,
      text: "Reconcile two-source answer", answerStatus: "answered",
      sourceRefs: ["wrs_source_1", "wrs_meeting_2"], providerProfile: "future",
      promptVersion: "future", verifierProfile: null
    });
    const before = {
      review: repository.getReview("account_a", published.review.id).version,
      item: edited.item.version,
      thread: repository.getQaThread("account_a", published.review.id)!.thread.version,
      message: answer.version
    };

    const reconciled = repository.reconcileSourceValidity({
      accountId: "account_a", reviewId: published.review.id, snapshot: snapshot("d")
    });
    expect(reconciled).toMatchObject({
      stale: true, invalidatedSystemItemIds: [], invalidatedItemIds: [],
      invalidatedMessageIds: []
    });
    const afterItems = repository.listItems("account_a", published.review.id);
    expect(afterItems.find((item) => item.id === published.items[0]!.id)).toMatchObject({
      systemText: "Reconcile two-source result", userText: "Keep my edit",
      sourceRefs: ["wrs_source_1"], verificationState: "qualified",
      invalidatedAt: null, version: before.item + 1
    });
    expect(afterItems.find((item) => item.id === note.item.id)).toMatchObject({
      origin: "user_note", userText: "Keep my note", verificationState: "user_authored"
    });
    const afterQa = repository.getQaThread("account_a", published.review.id)!;
    expect(afterQa.messages.find((message) => message.id === answer.id)).toMatchObject({
      text: "Reconcile two-source answer", answerStatus: "answered",
      sourceRefs: ["wrs_source_1"], invalidatedAt: null, version: before.message + 1
    });
    expect(afterQa.thread.version).toBe(before.thread + 1);
    expect(repository.getReview("account_a", published.review.id).version).toBe(before.review + 1);
    expect(db.prepare(`SELECT body_text, erased_at FROM wr_weekly_system_items`).get())
      .toEqual({ body_text: "Reconcile two-source result", erased_at: null });
    const generationManifest = db.prepare(`
      SELECT source_manifest_json FROM wr_weekly_review_runs
    `).get() as { source_manifest_json: string };
    const qaManifest = db.prepare(`
      SELECT source_manifest_json FROM wr_weekly_qa_runs
    `).get() as { source_manifest_json: string };
    expect(JSON.parse(generationManifest.source_manifest_json).identities
      .map((identity: { sourceRef: string }) => identity.sourceRef)).toEqual(["wrs_source_1"]);
    expect(JSON.parse(qaManifest.source_manifest_json).allowlistedSourceRefs)
      .toEqual(["wrs_source_1"]);

    const beforeHardDelete = {
      review: repository.getReview("account_a", published.review.id).version,
      item: repository.listItems("account_a", published.review.id)
        .find((item) => item.id === published.items[0]!.id)!.version,
      thread: repository.getQaThread("account_a", published.review.id)!.thread.version,
      message: repository.getQaThread("account_a", published.review.id)!.messages
        .find((message) => message.id === answer.id)!.version
    };
    const repeatedReconcile = repository.reconcileSourceValidity({
      accountId: "account_a", reviewId: published.review.id, snapshot: snapshot("d")
    });
    expect(repeatedReconcile).toMatchObject({
      invalidatedSystemItemIds: [], invalidatedItemIds: [], invalidatedMessageIds: []
    });
    expect({
      review: repository.getReview("account_a", published.review.id).version,
      item: repository.listItems("account_a", published.review.id)
        .find((item) => item.id === published.items[0]!.id)!.version,
      thread: repository.getQaThread("account_a", published.review.id)!.thread.version,
      message: repository.getQaThread("account_a", published.review.id)!.messages
        .find((message) => message.id === answer.id)!.version
    }).toEqual(beforeHardDelete);
    const deletionAfterReconcile = db.transaction(() =>
      invalidateWorkWeeklySourcesWithinTransaction(db, {
        accountId: "account_a", meetingId: "meeting_2", now: "2026-09-07T00:01:00.000Z"
      })).immediate();
    expect(deletionAfterReconcile.reviewIds).toEqual([]);
    expect({
      review: repository.getReview("account_a", published.review.id).version,
      item: repository.listItems("account_a", published.review.id)
        .find((item) => item.id === published.items[0]!.id)!.version,
      thread: repository.getQaThread("account_a", published.review.id)!.thread.version,
      message: repository.getQaThread("account_a", published.review.id)!.messages
        .find((message) => message.id === answer.id)!.version
    }).toEqual(beforeHardDelete);
    const generationManifestAfterDelete = db.prepare(`
      SELECT source_manifest_json FROM wr_weekly_review_runs
    `).get() as { source_manifest_json: string };
    const qaManifestAfterDelete = db.prepare(`
      SELECT source_manifest_json FROM wr_weekly_qa_runs
    `).get() as { source_manifest_json: string };
    expect(JSON.parse(generationManifestAfterDelete.source_manifest_json).identities
      .map((identity: { sourceRef: string }) => identity.sourceRef)).toEqual(["wrs_source_1"]);
    expect(JSON.parse(qaManifestAfterDelete.source_manifest_json).allowlistedSourceRefs)
      .toEqual(["wrs_source_1"]);
  });

  it("rejects late publication when the source digest changed", () => {
    const db = database();
    let id = 0;
    const queuedSnapshot = snapshot();
    let liveSnapshot = queuedSnapshot;
    const repository = new WorkWeeklyRepository(db, {
      now: () => "2026-09-07T00:00:00.000Z",
      idFactory: () => `id_${++id}`,
      currentSnapshotBuilder: () => liveSnapshot
    });
    const queued = repository.queueGeneration({
      accountId: "account_a", snapshot: queuedSnapshot, operationKey: "generate",
      expectedVersion: null, kind: "generate"
    });
    const fence = repository.claimGenerationRun({
      accountId: "account_a", runId: queued.run.id, leaseOwner: "worker", leaseMs: 60_000
    });
    liveSnapshot = snapshot("d");
    expect(() => repository.publishSystemVersion({
      accountId: "account_a", fence, currentSnapshot: queuedSnapshot, items: [],
      synthesizerProfile: "future", verifierProfile: null
    })).toThrow(WorkWeeklyConflictError);
    expect(repository.listRecoverableGenerationRuns()).toHaveLength(0);
    expect(db.prepare(`SELECT state, error_code FROM wr_weekly_review_runs WHERE id = ?`)
      .get(queued.run.id)).toEqual({ state: "superseded", error_code: "weekly_source_changed" });
    expect(repository.getReview("account_a", queued.review.id).status).toBe("stale");
  });

  it("binds generation publication to the exact queued Provider input pack", () => {
    const db = database();
    let id = 0;
    const source = snapshot();
    const repository = new WorkWeeklyRepository(db, {
      now: () => "2026-09-07T00:00:00.000Z",
      idFactory: () => `id_${++id}`,
      currentSnapshotBuilder: () => source
    });
    const queued = repository.queueGeneration({
      accountId: "account_a", snapshot: source, operationKey: "generate_pack",
      expectedVersion: null, kind: "generate"
    });
    const fence = repository.claimGenerationRun({
      accountId: "account_a", runId: queued.run.id, leaseOwner: "worker", leaseMs: 60_000
    });
    const differentProviderPack = WorkWeeklySourceSnapshotSchema.parse({
      ...source,
      inputPackDigest: "d".repeat(64)
    });
    expect(() => repository.publishSystemVersion({
      accountId: "account_a", fence, currentSnapshot: differentProviderPack, items: [],
      synthesizerProfile: "future", verifierProfile: null
    })).toThrow("weekly_input_pack_mismatch");
  });

  it("rejects an expired worker and atomically reclaims its generation run", () => {
    const db = database();
    let clock = "2026-09-07T00:00:00.000Z";
    let id = 0;
    const source = snapshot();
    const repository = new WorkWeeklyRepository(db, {
      now: () => clock,
      idFactory: () => `id_${++id}`,
      currentSnapshotBuilder: () => source
    });
    const queued = repository.queueGeneration({
      accountId: "account_a", snapshot: source, operationKey: "generate_recovery",
      expectedVersion: null, kind: "generate"
    });
    const expiredFence = repository.claimGenerationRun({
      accountId: "account_a", runId: queued.run.id, leaseOwner: "worker_old", leaseMs: 1_000
    });
    clock = expiredFence.leaseExpiresAt;
    expect(() => repository.markGenerationFailed({
      accountId: "account_a", fence: expiredFence, errorCode: "late_failure"
    })).toThrow("Work Weekly lease is no longer owned");
    const recovered = repository.claimGenerationRun({
      accountId: "account_a", runId: queued.run.id, leaseOwner: "worker_new", leaseMs: 1_000
    });
    expect(recovered.leaseOwner).toBe("worker_new");
    repository.markGenerationFailed({
      accountId: "account_a", fence: recovered, errorCode: "provider_failed"
    });
    expect(repository.getReview("account_a", queued.review.id).status).toBe("failed");
  });

  it("removes only the deleted source until multi-source GPT content has no evidence left", () => {
    const db = database();
    let id = 0;
    const source = snapshotWithIndependentMeetingSource();
    const repository = new WorkWeeklyRepository(db, {
      now: () => "2026-09-07T00:00:00.000Z",
      idFactory: () => `id_${++id}`,
      currentSnapshotBuilder: () => source
    });
    const queued = repository.queueGeneration({
      accountId: "account_a", snapshot: source, operationKey: "generate_multi_source",
      expectedVersion: null, kind: "generate"
    });
    const fence = repository.claimGenerationRun({
      accountId: "account_a", runId: queued.run.id, leaseOwner: "worker", leaseMs: 60_000
    });
    const published = repository.publishSystemVersion({
      accountId: "account_a", fence, currentSnapshot: source,
      items: [{ section: "decisions", text: "Two-source result",
        sourceRefs: ["wrs_source_1", "wrs_meeting_2"],
        verificationState: "verified", sortOrder: 0 }],
      synthesizerProfile: "future", verifierProfile: null
    });
    const note = repository.createUserNote({
      accountId: "account_a", reviewId: published.review.id, operationKey: "multi_note",
      expectedVersion: published.review.version, section: "overview",
      text: "User-authored note", sortOrder: 1
    });
    const question = repository.queueQuestion({
      accountId: "account_a", reviewId: published.review.id, snapshot: source,
      question: "What changed?", operationKey: "multi_question", expectedVersion: null
    });
    const qaFence = repository.claimQaRun({
      accountId: "account_a", runId: question.run.id, leaseOwner: "qa_worker", leaseMs: 60_000
    });
    const answer = repository.publishQaAnswer({
      accountId: "account_a", fence: qaFence, currentSnapshot: source,
      text: "Two-source answer", answerStatus: "answered",
      sourceRefs: ["wrs_source_1", "wrs_meeting_2"], providerProfile: "future",
      promptVersion: "future", verifierProfile: null
    });

    expect(() => db.transaction(() => {
      invalidateWorkWeeklySourcesWithinTransaction(db, {
        accountId: "account_a", meetingId: "meeting_2", now: "2026-09-07T00:00:15.000Z"
      });
      throw new Error("force_outer_rollback");
    }).immediate()).toThrow("force_outer_rollback");
    expect(repository.listItems("account_a", published.review.id)
      .find((item) => item.id === published.items[0]!.id)?.sourceRefs)
      .toEqual(["wrs_source_1", "wrs_meeting_2"]);
    expect(repository.getQaThread("account_a", published.review.id)!.messages
      .find((message) => message.id === answer.id)?.sourceRefs)
      .toEqual(["wrs_source_1", "wrs_meeting_2"]);

    const crossAccount = db.transaction(() => invalidateWorkWeeklySourcesWithinTransaction(db, {
      accountId: "account_b", meetingId: "meeting_2", now: "2026-09-07T00:00:30.000Z"
    })).immediate();
    expect(crossAccount.reviewIds).toEqual([]);

    const firstDeletion = db.transaction(() => invalidateWorkWeeklySourcesWithinTransaction(db, {
      accountId: "account_a", meetingId: "meeting_2", now: "2026-09-07T00:01:00.000Z"
    })).immediate();
    expect(firstDeletion).toMatchObject({
      invalidatedSystemItemIds: [], invalidatedItemIds: [], invalidatedMessageIds: []
    });
    const afterFirstItems = repository.listItems("account_a", published.review.id);
    expect(afterFirstItems.find((item) => item.id === published.items[0]!.id)).toMatchObject({
      systemText: "Two-source result", sourceRefs: ["wrs_source_1"],
      invalidatedAt: null, hiddenAt: null, version: 1
    });
    expect(afterFirstItems.find((item) => item.id === note.item.id)).toMatchObject({
      origin: "user_note", userText: "User-authored note", invalidatedAt: null
    });
    const afterFirstQa = repository.getQaThread("account_a", published.review.id)!;
    expect(afterFirstQa.messages.find((message) => message.id === answer.id)).toMatchObject({
      text: "Two-source answer", answerStatus: "answered",
      sourceRefs: ["wrs_source_1"], invalidatedAt: null, version: 1
    });
    expect(repository.hasActiveSourceReference(
      "account_a", published.review.id, "wrs_meeting_2"
    )).toBe(false);
    expect(repository.hasActiveSourceReference(
      "account_a", published.review.id, "wrs_source_1"
    )).toBe(true);
    expect(db.prepare(`SELECT body_text FROM wr_weekly_system_items`).get())
      .toEqual({ body_text: "Two-source result" });
    expect(db.prepare(`SELECT count(*) AS count FROM wr_weekly_run_sources`).get())
      .toEqual({ count: 1 });
    const generationManifest = db.prepare(`
      SELECT source_manifest_json FROM wr_weekly_review_runs
    `).get() as { source_manifest_json: string };
    const qaManifest = db.prepare(`
      SELECT source_manifest_json FROM wr_weekly_qa_runs
    `).get() as { source_manifest_json: string };
    expect(JSON.parse(generationManifest.source_manifest_json).identities).toHaveLength(1);
    expect(JSON.parse(qaManifest.source_manifest_json).allowlistedSourceRefs)
      .toEqual(["wrs_source_1"]);

    const beforeRepeat = {
      review: repository.getReview("account_a", published.review.id).version,
      item: repository.listItems("account_a", published.review.id)
        .find((item) => item.id === published.items[0]!.id)!.version,
      thread: repository.getQaThread("account_a", published.review.id)!.thread.version,
      message: repository.getQaThread("account_a", published.review.id)!.messages
        .find((message) => message.id === answer.id)!.version
    };
    const replayDeletion = db.transaction(() => invalidateWorkWeeklySourcesWithinTransaction(db, {
      accountId: "account_a", meetingId: "meeting_2", now: "2026-09-07T00:02:00.000Z"
    })).immediate();
    expect(replayDeletion.reviewIds).toEqual([]);
    expect({
      review: repository.getReview("account_a", published.review.id).version,
      item: repository.listItems("account_a", published.review.id)
        .find((item) => item.id === published.items[0]!.id)!.version,
      thread: repository.getQaThread("account_a", published.review.id)!.thread.version,
      message: repository.getQaThread("account_a", published.review.id)!.messages
        .find((message) => message.id === answer.id)!.version
    }).toEqual(beforeRepeat);

    const finalDeletion = db.transaction(() => invalidateWorkWeeklySourcesWithinTransaction(db, {
      accountId: "account_a", meetingId: "meeting_1", now: "2026-09-07T00:03:00.000Z"
    })).immediate();
    expect(finalDeletion.invalidatedItemIds).toEqual([published.items[0]!.id]);
    expect(finalDeletion.invalidatedMessageIds).toEqual([answer.id]);
    const finalItems = repository.listItems("account_a", published.review.id);
    expect(finalItems.find((item) => item.id === published.items[0]!.id)).toMatchObject({
      systemText: "来源已失效，内容不可用", userText: null, sourceRefs: [],
      verificationState: "invalidated"
    });
    expect(finalItems.find((item) => item.id === note.item.id)).toMatchObject({
      origin: "user_note", userText: "User-authored note", invalidatedAt: null
    });
    expect(repository.getQaThread("account_a", published.review.id)!.messages
      .find((message) => message.id === answer.id)).toMatchObject({
        text: null, answerStatus: "invalidated", sourceRefs: []
      });
    expect(db.prepare(`SELECT body_text FROM wr_weekly_system_items`).get())
      .toEqual({ body_text: "来源已失效，内容不可用" });
  });

  it("erases all derived edges and immutable text when a source is deleted", () => {
    const db = database();
    let id = 0;
    const source = snapshotWithMeetingSource();
    const repository = new WorkWeeklyRepository(db, {
      now: () => "2026-09-07T00:00:00.000Z",
      idFactory: () => `id_${++id}`,
      currentSnapshotBuilder: () => source
    });
    const queued = repository.queueGeneration({
      accountId: "account_a", snapshot: source, operationKey: "generate_delete",
      expectedVersion: null, kind: "generate"
    });
    const fence = repository.claimGenerationRun({
      accountId: "account_a", runId: queued.run.id, leaseOwner: "worker", leaseMs: 60_000
    });
    repository.publishSystemVersion({
      accountId: "account_a", fence, currentSnapshot: source,
      items: [{ section: "decisions", text: "Sensitive derived text",
        sourceRefs: ["wrs_source_1", "wrs_meeting_1"],
        verificationState: "verified", sortOrder: 0 }],
      synthesizerProfile: "future", verifierProfile: null
    });
    repository.queueQuestion({
      accountId: "account_a", reviewId: queued.review.id, snapshot: source,
      question: "What was decided?", operationKey: "question_before_delete",
      expectedVersion: null
    });
    db.transaction(() => invalidateWorkWeeklySourcesWithinTransaction(db, {
      accountId: "account_a", meetingId: "meeting_1", now: "2026-09-07T00:01:00.000Z"
    })).immediate();
    expect(db.prepare(`
      SELECT count(*) AS count FROM wr_weekly_item_sources WHERE invalidated_at IS NOT NULL
    `).get()).toEqual({ count: 2 });
    expect(db.prepare(`
      SELECT count(*) AS count FROM wr_weekly_system_item_sources WHERE invalidated_at IS NOT NULL
    `).get()).toEqual({ count: 2 });
    expect(db.prepare(`SELECT body_text FROM wr_weekly_system_items`).get())
      .toEqual({ body_text: "来源已失效，内容不可用" });
    expect(db.prepare(`SELECT source_manifest_json FROM wr_weekly_review_runs`).get())
      .toEqual({ source_manifest_json: JSON.stringify({ erased: true }) });
    expect(db.prepare(`SELECT count(*) AS count FROM wr_weekly_run_sources`).get())
      .toEqual({ count: 0 });
    expect(db.prepare(`SELECT source_manifest_json FROM wr_weekly_qa_runs`).get())
      .toEqual({ source_manifest_json: JSON.stringify({ erased: true }) });
  });

  it("deletes Weekly-owned source metadata behind a replayable tombstone", () => {
    const db = database();
    let id = 0;
    const source = snapshot();
    const repository = new WorkWeeklyRepository(db, {
      now: () => "2026-09-07T00:00:00.000Z",
      idFactory: () => `id_${++id}`,
      currentSnapshotBuilder: () => source
    });
    const queued = repository.queueGeneration({
      accountId: "account_a", snapshot: source, operationKey: "generate_for_delete",
      expectedVersion: null, kind: "generate"
    });
    const fence = repository.claimGenerationRun({
      accountId: "account_a", runId: queued.run.id, leaseOwner: "worker", leaseMs: 60_000
    });
    const published = repository.publishSystemVersion({
      accountId: "account_a", fence, currentSnapshot: source,
      items: [{ section: "decisions", text: "Delete me", sourceRefs: ["wrs_source_1"],
        verificationState: "verified", sortOrder: 0 }],
      synthesizerProfile: "future", verifierProfile: null
    });
    const pendingRegenerate = repository.queueGeneration({
      accountId: "account_a", snapshot: source, operationKey: "regenerate_before_delete",
      expectedVersion: published.review.version, kind: "regenerate"
    });
    const lateFence = repository.claimGenerationRun({
      accountId: "account_a", runId: pendingRegenerate.run.id,
      leaseOwner: "late_worker", leaseMs: 60_000
    });
    const request = {
      accountId: "account_a", reviewId: published.review.id,
      operationKey: "delete_weekly",
      expectedVersion: repository.getReview("account_a", published.review.id).version
    };
    expect(repository.deleteReview(request)).toEqual({ deleted: true, reused: false });
    expect(repository.deleteReview(request)).toEqual({ deleted: true, reused: true });
    expect(() => repository.publishSystemVersion({
      accountId: "account_a", fence: lateFence, currentSnapshot: source,
      items: [{ section: "decisions", text: "Late overwrite", sourceRefs: ["wrs_source_1"],
        verificationState: "verified", sortOrder: 0 }],
      synthesizerProfile: "future", verifierProfile: null
    })).toThrow(WorkWeeklyNotFoundError);
    expect(() => repository.getReview("account_a", published.review.id))
      .toThrow(WorkWeeklyNotFoundError);
    expect(db.prepare(`SELECT count(*) AS count FROM wr_weekly_review_runs`).get())
      .toEqual({ count: 0 });
    expect(db.prepare(`SELECT count(*) AS count FROM wr_weekly_system_items`).get())
      .toEqual({ count: 0 });
    expect(db.prepare(`SELECT count(*) AS count FROM wr_weekly_tombstones`).get())
      .toEqual({ count: 1 });
  });

  it("persists a separately fenced QA skeleton and clears it version-safely", () => {
    const db = database();
    let id = 0;
    const source = snapshot();
    let clock = "2026-09-07T00:00:00.000Z";
    const repository = new WorkWeeklyRepository(db, {
      now: () => clock,
      idFactory: () => `id_${++id}`,
      currentSnapshotBuilder: () => source
    });
    const queued = repository.queueGeneration({
      accountId: "account_a", snapshot: source, operationKey: "generate",
      expectedVersion: null, kind: "generate"
    });
    const generationFence = repository.claimGenerationRun({
      accountId: "account_a", runId: queued.run.id, leaseOwner: "worker", leaseMs: 60_000
    });
    const published = repository.publishSystemVersion({
      accountId: "account_a", fence: generationFence, currentSnapshot: source,
      items: [{ section: "decisions", text: "Ship", sourceRefs: ["wrs_source_1"],
        verificationState: "verified", sortOrder: 0 }],
      synthesizerProfile: "future", verifierProfile: null
    });
    const question = repository.queueQuestion({
      accountId: "account_a", reviewId: published.review.id, snapshot: source,
      question: "What changed?", operationKey: "question", expectedVersion: null
    });
    const qaFence = repository.claimQaRun({
      accountId: "account_a", runId: question.run.id, leaseOwner: "qa_worker", leaseMs: 60_000
    });
    const differentQaPack = WorkWeeklySourceSnapshotSchema.parse({
      ...source,
      inputPackDigest: "d".repeat(64)
    });
    expect(() => repository.publishQaAnswer({
      accountId: "account_a", fence: qaFence, currentSnapshot: differentQaPack,
      text: "Unsafe mismatch", answerStatus: "answered",
      sourceRefs: ["wrs_source_1"], providerProfile: "future",
      promptVersion: "future", verifierProfile: null
    })).toThrow("weekly_input_pack_mismatch");
    const answer = repository.publishQaAnswer({
      accountId: "account_a", fence: qaFence, currentSnapshot: source,
      text: "The decision changed.", answerStatus: "answered",
      sourceRefs: ["wrs_source_1"], providerProfile: "future",
      promptVersion: "future", verifierProfile: null
    });
    expect(answer.sourceRefs).toEqual(["wrs_source_1"]);
    const current = repository.getQaThread("account_a", published.review.id)!;
    expect(current.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const second = repository.queueQuestion({
      accountId: "account_a", reviewId: published.review.id, snapshot: source,
      question: "And now?", operationKey: "question_2",
      expectedVersion: current.thread.version
    });
    const expiredQaFence = repository.claimQaRun({
      accountId: "account_a", runId: second.run.id, leaseOwner: "qa_old", leaseMs: 1_000
    });
    clock = expiredQaFence.leaseExpiresAt;
    expect(() => repository.markQaRunFailed({
      accountId: "account_a", fence: expiredQaFence, errorCode: "late_failure"
    })).toThrow("Work Weekly lease is no longer owned");
    const recoveredQaFence = repository.claimQaRun({
      accountId: "account_a", runId: second.run.id, leaseOwner: "qa_new", leaseMs: 1_000
    });
    repository.markQaRunFailed({
      accountId: "account_a", fence: recoveredQaFence, errorCode: "provider_failed"
    });
    const failed = repository.getQaThread("account_a", published.review.id)!;
    expect(failed.messages.at(-1)).toMatchObject({ role: "assistant", answerStatus: "failed" });
    const cleared = repository.clearQaThread({
      accountId: "account_a", reviewId: published.review.id,
      operationKey: "clear", expectedVersion: failed.thread.version
    });
    expect(cleared).toMatchObject({ cleared: true, reused: false });
    expect(repository.getQaThread("account_a", published.review.id)?.messages).toEqual([]);
    expect(db.prepare(`SELECT operation_type, count(*) AS count FROM wr_weekly_qa_operations`)
      .get()).toEqual({ operation_type: "clear", count: 1 });
    expect(() => repository.getReview("account_b", published.review.id))
      .toThrow(WorkWeeklyNotFoundError);
  });
});
