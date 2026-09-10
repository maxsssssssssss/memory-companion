import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { WorkTodoRepository } from "./todo-repository";
import { openWorkReviewDatabase } from "./db";
import {
  buildWorkWeeklySourceSnapshot,
  deriveWorkWeeklyScope
} from "./weekly-source-builder";

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

function seedConfirmedFinding(db: Database.Database, accountId = "account_a", options: { payload?: unknown } = {}) {
  const digest = "a".repeat(64);
  db.prepare(`
    INSERT INTO wr_meetings(
      id, account_id, product_space, title, meeting_date, source_upload_id,
      ingestion_status, analysis_status, review_status, canonical_publication_id,
      canonical_content_digest, canonical_segment_count, version, created_at, updated_at,
      transcript_ready_at, review_ready_at
    ) VALUES (
      'meeting_1', ?, 'office_review', 'Core planning', '2026-08-31', 'upload_1',
      'transcript_ready', 'review_ready', 'in_progress', 'publication_1', ?, 2, 3,
      '2026-08-31T01:00:00.000Z', '2026-08-31T02:00:00.000Z',
      '2026-08-31T01:30:00.000Z', '2026-08-31T02:00:00.000Z'
    )
  `).run(accountId, digest);
  db.prepare(`
    INSERT INTO wr_canonical_publications(
      publication_id, account_id, meeting_id, source_upload_id, product_space,
      asset_kind, attempt_version, content_digest, segment_count, payload_json, created_at
    ) VALUES ('publication_1', ?, 'meeting_1', 'upload_1', 'office_review',
      'segments', 1, ?, 2, ?, '2026-08-31T01:30:00.000Z')
  `).run(accountId, digest, JSON.stringify(options.payload === undefined ? [
    { id: "segment_direct", uploadId: "upload_1", startSeconds: 0, endSeconds: 2,
      speaker: "SPEAKER_00", text: "The launch decision is final." },
    { id: "segment_unreferenced", uploadId: "upload_1", startSeconds: 2, endSeconds: 4,
      speaker: "SPEAKER_01", text: "TRANSCRIPT SENTINEL MUST NOT LEAK" }
  ] : options.payload));
  for (const [id, ordinal, status, title] of [
    ["candidate_confirmed", 0, "accepted", "Launch decision"],
    ["candidate_pending", 1, "pending_review", "PENDING SENTINEL MUST NOT LEAK"]
  ] as const) {
    db.prepare(`
      INSERT INTO wr_meeting_candidates(
        id, account_id, meeting_id, publication_id, ordinal, kind, title, body,
        structured_data_json, status, publication_action, risk_level,
        generator_profile, generator_prompt_version, analysis_attempt_version,
        created_at, updated_at
      ) VALUES (?, ?, 'meeting_1', 'publication_1', ?, 'decision', ?, 'body', '{}', ?,
        'show_as_candidate', 'low', 'fixture', 'prompt_v1', 1,
        '2026-08-31T02:00:00.000Z', '2026-08-31T02:00:00.000Z')
    `).run(id, accountId, ordinal, title, status);
  }
  db.prepare(`
    INSERT INTO wr_findings(
      id, account_id, meeting_id, source_candidate_id, kind, title, body,
      structured_data_json, user_confirmed_at, version, created_at, updated_at
    ) VALUES ('finding_1', ?, 'meeting_1', 'candidate_confirmed', 'decision',
      'Launch decision', 'Ship on Friday', '{}', '2026-08-31T03:00:00.000Z', 2,
      '2026-08-31T03:00:00.000Z', '2026-08-31T03:00:00.000Z')
  `).run(accountId);
  db.prepare(`
    INSERT INTO wr_finding_evidence(
      account_id, meeting_id, finding_id, publication_id, position, segment_id,
      start_seconds, end_seconds, raw_speaker_label, timestamp_quality
    ) VALUES (?, 'meeting_1', 'finding_1', 'publication_1', 0, 'segment_direct',
      0, 2, 'SPEAKER_00', 'provider_exact')
  `).run(accountId);
}

describe("Work Weekly source builder", () => {
  it("excludes an explicitly revoked canonical publication from eligible identities", () => {
    const db = database();
    seedConfirmedFinding(db);
    const input = { database: db, accountId: "account_a",
      scope: { weekStart: "2026-08-31", timeZone: "Asia/Shanghai",
        scopeKind: "all" as const, projectId: null },
      now: new Date("2026-09-07T00:00:00.000Z") };
    const before = buildWorkWeeklySourceSnapshot(input);
    db.prepare(`UPDATE wr_canonical_publications SET tombstoned_at = ?
      WHERE account_id = ? AND publication_id = ?`)
      .run("2026-09-07T00:00:00.000Z", "account_a", "publication_1");
    const after = buildWorkWeeklySourceSnapshot(input);
    expect(after.identities).toEqual([]);
    expect(after.allowlistedSourceRefs).toEqual([]);
    expect(after.findings).toEqual([]);
    expect(after.evidence).toEqual([]);
    expect(after.digest).not.toBe(before.digest);
  });

  it.each([
    ["digest", "work_weekly_canonical_publication_missing"],
    ["payload", "work_weekly_canonical_payload_invalid"],
    ["missing", "work_weekly_canonical_publication_missing"]
  ])("still fails closed for an unexpectedly invalid canonical %s", (failure, code) => {
    const db = database();
    // Insert valid JSON with an invalid segment envelope; immutable published rows stay untouched.
    seedConfirmedFinding(db, "account_a", failure === "payload" ? { payload: { segments: [] } } : {});
    if (failure === "digest") {
      db.prepare(`UPDATE wr_meetings SET canonical_content_digest = ? WHERE id = 'meeting_1'`).run("b".repeat(64));
    } else if (failure === "missing") {
      // A broken meeting pointer leaves the required Finding/Evidence present for the reader check.
      db.prepare(`UPDATE wr_meetings SET canonical_publication_id = 'missing_publication'
        WHERE id = 'meeting_1'`).run();
    }
    expect(db.prepare(`SELECT count(*) AS count FROM wr_findings`).get()).toEqual({ count: 1 });
    expect(db.prepare(`SELECT count(*) AS count FROM wr_finding_evidence`).get()).toEqual({ count: 1 });
    expect(() => buildWorkWeeklySourceSnapshot({
      database: db, accountId: "account_a",
      scope: { weekStart: "2026-08-31", timeZone: "Asia/Shanghai", scopeKind: "all", projectId: null },
      now: new Date("2026-09-07T00:00:00.000Z")
    })).toThrow(code);
  });

  it.each([
    ["content_digest", "b".repeat(64)],
    ["payload_json", JSON.stringify({ segments: [] })]
  ])("rejects mutation of published canonical %s before it can corrupt a snapshot", (column, value) => {
    const db = database();
    seedConfirmedFinding(db);
    const before = db.prepare(`SELECT * FROM wr_canonical_publications WHERE publication_id = 'publication_1'`).get();
    expect(() => db.prepare(`UPDATE wr_canonical_publications SET ${column} = ?
      WHERE publication_id = 'publication_1'`).run(value)).toThrow("work_review_canonical_publication_immutable");
    expect(db.prepare(`SELECT * FROM wr_canonical_publications WHERE publication_id = 'publication_1'`).get()).toEqual(before);
    expect(buildWorkWeeklySourceSnapshot({ database: db, accountId: "account_a",
      scope: { weekStart: "2026-08-31", timeZone: "Asia/Shanghai", scopeKind: "all", projectId: null },
      now: new Date("2026-09-07T00:00:00.000Z") }).evidence).toHaveLength(1);
  });

  it("removes all dependent sources through the existing canonical deletion cascade", () => {
    const db = database();
    seedConfirmedFinding(db);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    const input = { database: db, accountId: "account_a",
      scope: { weekStart: "2026-08-31", timeZone: "Asia/Shanghai", scopeKind: "all" as const, projectId: null },
      now: new Date("2026-09-07T00:00:00.000Z") };
    const before = buildWorkWeeklySourceSnapshot(input);
    expect(before.findings).toHaveLength(1);
    expect(before.evidence).toHaveLength(1);
    db.prepare(`DELETE FROM wr_canonical_publications WHERE publication_id = 'publication_1'`).run();
    for (const table of ["wr_canonical_publications", "wr_meeting_candidates", "wr_findings", "wr_finding_evidence"]) {
      expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    const after = buildWorkWeeklySourceSnapshot(input);
    expect(after.identities).toEqual([]);
    expect(after.allowlistedSourceRefs).toEqual([]);
    expect(after.findings).toEqual([]);
    expect(after.evidence).toEqual([]);
    expect(after.digest).not.toBe(before.digest);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("derives natural-week/DST boundaries from an IANA timezone", () => {
    const spring = deriveWorkWeeklyScope({
      weekStart: "2026-03-02", timeZone: "America/Los_Angeles",
      scopeKind: "all", projectId: null
    }, new Date("2026-03-10T00:00:00.000Z"));
    expect((Date.parse(spring.endExclusive) - Date.parse(spring.startInstant)) / 3_600_000)
      .toBe(167);
    const fall = deriveWorkWeeklyScope({
      weekStart: "2026-10-26", timeZone: "America/Los_Angeles",
      scopeKind: "all", projectId: null
    }, new Date("2026-11-03T00:00:00.000Z"));
    expect((Date.parse(fall.endExclusive) - Date.parse(fall.startInstant)) / 3_600_000)
      .toBe(169);
    expect(() => deriveWorkWeeklyScope({
      weekStart: "2026-03-03", timeZone: "America/Los_Angeles",
      scopeKind: "all", projectId: null
    }, new Date("2026-03-10T00:00:00.000Z"))).toThrow("work_weekly_week_start_must_be_monday");
  });

  it("uses only confirmed Findings, direct Canonical Evidence, and versioned Todo events", () => {
    const db = database();
    seedConfirmedFinding(db);
    let now = "2026-09-01T01:00:00.000Z";
    let nextId = 0;
    const todos = new WorkTodoRepository(db, {
      now: () => now,
      idFactory: () => `id_${++nextId}`
    });
    const created = todos.createManualTodo({
      accountId: "account_a", operationKey: "create_todo", title: "Prepare rollout",
      kind: "self", notes: null, ownerLabel: null, currentDueDate: "2026-09-04",
      isImportant: true, myDayDate: null
    }).todo;
    now = "2026-09-03T01:00:00.000Z";
    todos.completeTodo({
      accountId: "account_a", todoId: created.id,
      expectedVersion: created.version, operationKey: "complete_todo"
    });
    const snapshot = buildWorkWeeklySourceSnapshot({
      database: db,
      accountId: "account_a",
      scope: { weekStart: "2026-08-31", timeZone: "Asia/Shanghai",
        scopeKind: "all", projectId: null },
      now: new Date("2026-09-04T06:00:00.000Z")
    });
    expect(snapshot.scope).toMatchObject({
      weekEnd: "2026-09-06", observedThrough: "2026-09-04", windowComplete: false
    });
    expect(snapshot.findings.map((finding) => finding.id)).toEqual(["finding_1"]);
    expect(snapshot.evidence.map((evidence) => evidence.segmentId)).toEqual(["segment_direct"]);
    expect(snapshot.todoEvents.some((event) =>
      event.eventType === "todo.completed" && event.historyCompleteness === "exact"
    )).toBe(true);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("PENDING SENTINEL");
    expect(serialized).not.toContain("TRANSCRIPT SENTINEL");
    expect(snapshot.summary.pendingCandidateCount).toBe(1);
    expect(snapshot.summary.historyCompleteness).toBe("exact");
    const rebuilt = buildWorkWeeklySourceSnapshot({
      database: db,
      accountId: "account_a",
      scope: { weekStart: "2026-08-31", timeZone: "Asia/Shanghai",
        scopeKind: "all", projectId: null },
      now: new Date("2026-09-04T07:00:00.000Z")
    });
    expect(rebuilt.digest).toBe(snapshot.digest);
  });

  it("trims whole semantic units deterministically while the full digest keeps omitted identities", () => {
    const db = database();
    seedConfirmedFinding(db);
    let nextId = 0;
    const todos = new WorkTodoRepository(db, {
      now: () => "2026-09-01T01:00:00.000Z",
      idFactory: () => `id_${++nextId}`
    });
    todos.createManualTodo({
      accountId: "account_a", operationKey: "create_todo", title: "Lower priority",
      kind: "self", notes: null, ownerLabel: null, currentDueDate: null,
      isImportant: false, myDayDate: null
    });
    const snapshot = buildWorkWeeklySourceSnapshot({
      database: db,
      accountId: "account_a",
      scope: { weekStart: "2026-08-31", timeZone: "Asia/Shanghai",
        scopeKind: "all", projectId: null },
      now: new Date("2026-09-04T06:00:00.000Z"),
      capacity: { maxSemanticUnits: 1 }
    });
    expect(snapshot.findings).toHaveLength(1);
    expect(snapshot.todos).toHaveLength(0);
    expect(snapshot.summary).toMatchObject({ truncated: true, omittedTodoCount: 1 });
    expect(snapshot.identities.some((identity) =>
      identity.sourceKind === "todo" && identity.included === false
    )).toBe(true);
  });

  it("excludes future-in-week Meetings from a current-week snapshot", () => {
    const db = database();
    seedConfirmedFinding(db);
    db.prepare(`UPDATE wr_meetings SET meeting_date = '2026-09-03' WHERE id = 'meeting_1'`).run();
    const snapshot = buildWorkWeeklySourceSnapshot({
      database: db,
      accountId: "account_a",
      scope: { weekStart: "2026-08-31", timeZone: "Asia/Shanghai",
        scopeKind: "all", projectId: null },
      now: new Date("2026-09-01T06:00:00.000Z")
    });
    expect(snapshot.scope.observedThrough).toBe("2026-09-01");
    expect(snapshot.meetings).toEqual([]);
    expect(snapshot.findings).toEqual([]);
    expect(snapshot.summary.pendingCandidateCount).toBe(0);
  });

  it("does not reconstruct a legacy week-end Todo from unsafe post-cutoff V2 fields", () => {
    const db = database();
    db.prepare(`
      INSERT INTO wr_todos(
        id, account_id, kind, status, origin, title, is_important, version,
        created_at, updated_at
      ) VALUES (
        'todo_legacy', 'account_a', 'self', 'open', 'manual', 'Post-week title', 0, 2,
        '2026-08-31T01:00:00.000Z', '2026-09-08T01:00:00.000Z'
      )
    `).run();
    db.prepare(`
      INSERT INTO wr_todo_events(event_id, account_id, todo_id, event_type, payload_json, created_at)
      VALUES (
        'event_legacy', 'account_a', 'todo_legacy', 'todo.created_manual',
        '{"changedFields":["title"],"newVersion":0}', '2026-08-31T01:00:00.000Z'
      ), (
        'event_v2_after', 'account_a', 'todo_legacy', 'todo.updated', ?,
        '2026-09-08T01:00:00.000Z'
      )
    `).run(JSON.stringify({
      schemaVersion: 2,
      changedFields: ["title"],
      oldVersion: 1,
      newVersion: 2,
      occurredAt: "2026-09-08T01:00:00.000Z",
      stateAfter: {
        title: "Post-week title", kind: "self", status: "open", ownerLabel: null,
        currentDueDate: null, completedAt: null, deletedAt: null, version: 2
      }
    }));
    const snapshot = buildWorkWeeklySourceSnapshot({
      database: db,
      accountId: "account_a",
      scope: { weekStart: "2026-08-31", timeZone: "Asia/Shanghai",
        scopeKind: "all", projectId: null },
      now: new Date("2026-09-10T00:00:00.000Z")
    });
    expect(snapshot.todos).toHaveLength(1);
    expect(snapshot.todos[0]).toMatchObject({
      stateAtWeekEnd: null,
      historyCompleteness: "legacy_limited"
    });
  });

  it("enforces account and current Project scope without duplicating multi-project sources", () => {
    const db = database();
    seedConfirmedFinding(db);
    db.prepare(`
      INSERT INTO wr_projects(id, account_id, name, name_key, status, created_at, updated_at)
      VALUES ('project_a', 'account_a', 'Alpha', 'alpha', 'active', ?, ?),
             ('project_b', 'account_a', 'Beta', 'beta', 'active', ?, ?)
    `).run("2026-08-30T00:00:00.000Z", "2026-08-30T00:00:00.000Z",
      "2026-08-30T00:00:00.000Z", "2026-08-30T00:00:00.000Z");
    db.prepare(`
      INSERT INTO wr_meeting_projects(account_id, meeting_id, project_id, created_at)
      VALUES ('account_a', 'meeting_1', 'project_a', ?),
             ('account_a', 'meeting_1', 'project_b', ?)
    `).run("2026-08-30T00:00:00.000Z", "2026-08-30T00:00:00.000Z");
    const project = buildWorkWeeklySourceSnapshot({
      database: db, accountId: "account_a",
      scope: { weekStart: "2026-08-31", timeZone: "Asia/Shanghai",
        scopeKind: "project", projectId: "project_a" },
      now: new Date("2026-09-04T06:00:00.000Z")
    });
    expect(project.findings).toHaveLength(1);
    expect(project.meetings).toHaveLength(1);
    const other = buildWorkWeeklySourceSnapshot({
      database: db, accountId: "account_b",
      scope: { weekStart: "2026-08-31", timeZone: "Asia/Shanghai",
        scopeKind: "all", projectId: null },
      now: new Date("2026-09-04T06:00:00.000Z")
    });
    expect(other.summary.findingCount).toBe(0);
    expect(other.allowlistedSourceRefs).toEqual([]);
  });
});
