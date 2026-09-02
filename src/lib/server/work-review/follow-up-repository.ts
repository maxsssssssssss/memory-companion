import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

import {
  WorkMeetingFollowUpBodySchema,
  WorkMeetingFollowUpDigestSchema
} from "@/lib/domain/work-follow-up";
import { WorkReviewIdSchema } from "@/lib/domain/work-review";

import {
  WorkReviewConflictError,
  WorkReviewNotFoundError,
  WorkReviewVersionConflictError
} from "./repository";

export type WorkMeetingFollowUpDraftRecord = {
  accountId: string;
  meetingId: string;
  bodyMarkdown: string;
  systemBodyMarkdown: string;
  systemSnapshotDigest: string;
  decisionsMarkdown: string;
  actionsMarkdown: string;
  sourceManifest: unknown;
  version: number;
  generatedAt: string;
  userEditedAt: string | null;
  updatedAt: string;
};

type FollowUpRow = {
  account_id: string;
  meeting_id: string;
  body_markdown: string;
  system_body_markdown: string;
  system_snapshot_digest: string;
  decisions_markdown: string;
  actions_markdown: string;
  source_manifest_json: string;
  version: number;
  generated_at: string;
  user_edited_at: string | null;
  updated_at: string;
};

type FollowUpOperationRow = {
  request_fingerprint: string;
  response_json: string;
};

type FollowUpRepositoryOptions = {
  now?: () => string;
};

function parseId(value: string, code: string) {
  const parsed = WorkReviewIdSchema.safeParse(value);
  if (!parsed.success) throw new WorkReviewConflictError(code);
  return parsed.data;
}

function digest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function fromRow(row: FollowUpRow): WorkMeetingFollowUpDraftRecord {
  return {
    accountId: row.account_id,
    meetingId: row.meeting_id,
    bodyMarkdown: row.body_markdown,
    systemBodyMarkdown: row.system_body_markdown,
    systemSnapshotDigest: row.system_snapshot_digest,
    decisionsMarkdown: row.decisions_markdown,
    actionsMarkdown: row.actions_markdown,
    sourceManifest: JSON.parse(row.source_manifest_json) as unknown,
    version: row.version,
    generatedAt: row.generated_at,
    userEditedAt: row.user_edited_at,
    updatedAt: row.updated_at
  };
}

export class WorkMeetingFollowUpRepository {
  private readonly now: () => string;

  constructor(
    private readonly database: Database.Database,
    options: FollowUpRepositoryOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private assertLiveMeeting(accountId: string, meetingId: string) {
    const row = this.database.prepare(`
      SELECT meeting.id
      FROM wr_meetings AS meeting
      LEFT JOIN wr_tombstones AS tombstone
        ON tombstone.account_id = meeting.account_id
       AND tombstone.meeting_id = meeting.id
      WHERE meeting.account_id = ? AND meeting.id = ?
        AND meeting.deleted_at IS NULL
        AND meeting.ingestion_status <> 'deleted'
        AND tombstone.meeting_id IS NULL
    `).get(accountId, meetingId);
    if (!row) throw new WorkReviewNotFoundError();
  }

  private draftRow(accountId: string, meetingId: string) {
    return this.database.prepare(`
      SELECT * FROM wr_follow_up_drafts
      WHERE account_id = ? AND meeting_id = ?
    `).get(accountId, meetingId) as FollowUpRow | undefined;
  }

  private replayOperation(input: {
    accountId: string;
    operationKey: string;
    requestFingerprint: string;
  }) {
    const row = this.database.prepare(`
      SELECT request_fingerprint, response_json
      FROM wr_follow_up_operations
      WHERE account_id = ? AND operation_key = ?
    `).get(input.accountId, input.operationKey) as FollowUpOperationRow | undefined;
    if (!row) return null;
    if (row.request_fingerprint !== input.requestFingerprint) {
      throw new WorkReviewConflictError("work_review_follow_up_operation_conflict");
    }
    const response = JSON.parse(row.response_json) as { draft: WorkMeetingFollowUpDraftRecord };
    return { draft: response.draft, reused: true };
  }

  private recordOperation(input: {
    accountId: string;
    meetingId: string;
    operationKey: string;
    operationType: "generate" | "update" | "reset";
    requestFingerprint: string;
    draft: WorkMeetingFollowUpDraftRecord;
    now: string;
  }) {
    this.database.prepare(`
      INSERT INTO wr_follow_up_operations (
        account_id, operation_key, meeting_id, operation_type,
        request_fingerprint, response_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.accountId,
      input.operationKey,
      input.meetingId,
      input.operationType,
      input.requestFingerprint,
      JSON.stringify({ draft: input.draft }),
      input.now
    );
  }

  getDraft(accountId: string, meetingId: string) {
    const parsedAccountId = parseId(accountId, "work_review_invalid_account");
    const parsedMeetingId = parseId(meetingId, "work_review_invalid_meeting_id");
    this.assertLiveMeeting(parsedAccountId, parsedMeetingId);
    const row = this.draftRow(parsedAccountId, parsedMeetingId);
    return row ? fromRow(row) : null;
  }

  generate(input: {
    accountId: string;
    meetingId: string;
    operationKey: string;
    expectedVersion: number | null;
    bodyMarkdown: string;
    systemSnapshotDigest: string;
    decisionsMarkdown: string;
    actionsMarkdown: string;
    sourceManifest: unknown;
  }) {
    const accountId = parseId(input.accountId, "work_review_invalid_account");
    const meetingId = parseId(input.meetingId, "work_review_invalid_meeting_id");
    const operationKey = parseId(input.operationKey, "work_review_operation_key_required");
    const bodyMarkdown = WorkMeetingFollowUpBodySchema.parse(input.bodyMarkdown);
    const systemSnapshotDigest = WorkMeetingFollowUpDigestSchema.parse(
      input.systemSnapshotDigest
    );
    const decisionsMarkdown = input.decisionsMarkdown.slice(0, 100_000);
    const actionsMarkdown = input.actionsMarkdown.slice(0, 100_000);
    const requestFingerprint = digest({
      operation: "generate",
      meetingId,
      expectedVersion: input.expectedVersion
    });
    const run = this.database.transaction(() => {
      this.assertLiveMeeting(accountId, meetingId);
      const replay = this.replayOperation({ accountId, operationKey, requestFingerprint });
      if (replay) return replay;
      const existing = this.draftRow(accountId, meetingId);
      if (existing && existing.version !== input.expectedVersion) {
        throw new WorkReviewVersionConflictError(existing.version);
      }
      if (!existing && input.expectedVersion !== null) {
        throw new WorkReviewVersionConflictError(0);
      }
      const now = this.now();
      const version = existing ? existing.version + 1 : 0;
      this.database.prepare(`
        INSERT INTO wr_follow_up_drafts (
          account_id, meeting_id, body_markdown, system_body_markdown,
          system_snapshot_digest, decisions_markdown, actions_markdown,
          source_manifest_json, version, generated_at, user_edited_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(account_id, meeting_id) DO UPDATE SET
          body_markdown = excluded.body_markdown,
          system_body_markdown = excluded.system_body_markdown,
          system_snapshot_digest = excluded.system_snapshot_digest,
          decisions_markdown = excluded.decisions_markdown,
          actions_markdown = excluded.actions_markdown,
          source_manifest_json = excluded.source_manifest_json,
          version = excluded.version,
          generated_at = excluded.generated_at,
          user_edited_at = NULL,
          updated_at = excluded.updated_at
      `).run(
        accountId,
        meetingId,
        bodyMarkdown,
        bodyMarkdown,
        systemSnapshotDigest,
        decisionsMarkdown,
        actionsMarkdown,
        JSON.stringify(input.sourceManifest),
        version,
        now,
        now
      );
      const draft = fromRow(this.draftRow(accountId, meetingId)!);
      this.recordOperation({
        accountId,
        meetingId,
        operationKey,
        operationType: "generate",
        requestFingerprint,
        draft,
        now
      });
      return { draft, reused: false };
    });
    return run.immediate();
  }

  update(input: {
    accountId: string;
    meetingId: string;
    operationKey: string;
    expectedVersion: number;
    bodyMarkdown: string;
  }) {
    const accountId = parseId(input.accountId, "work_review_invalid_account");
    const meetingId = parseId(input.meetingId, "work_review_invalid_meeting_id");
    const operationKey = parseId(input.operationKey, "work_review_operation_key_required");
    const bodyMarkdown = WorkMeetingFollowUpBodySchema.parse(input.bodyMarkdown);
    const requestFingerprint = digest({
      operation: "update",
      meetingId,
      expectedVersion: input.expectedVersion,
      bodyMarkdown
    });
    const run = this.database.transaction(() => {
      this.assertLiveMeeting(accountId, meetingId);
      const replay = this.replayOperation({ accountId, operationKey, requestFingerprint });
      if (replay) return replay;
      const existing = this.draftRow(accountId, meetingId);
      if (!existing) {
        throw new WorkReviewConflictError("work_review_follow_up_not_generated");
      }
      if (existing.version !== input.expectedVersion) {
        throw new WorkReviewVersionConflictError(existing.version);
      }
      const now = this.now();
      const updated = this.database.prepare(`
        UPDATE wr_follow_up_drafts
        SET body_markdown = ?, version = version + 1,
            user_edited_at = ?, updated_at = ?
        WHERE account_id = ? AND meeting_id = ? AND version = ?
      `).run(bodyMarkdown, now, now, accountId, meetingId, input.expectedVersion);
      if (updated.changes !== 1) {
        const current = this.draftRow(accountId, meetingId);
        throw new WorkReviewVersionConflictError(current?.version ?? input.expectedVersion);
      }
      const draft = fromRow(this.draftRow(accountId, meetingId)!);
      this.recordOperation({
        accountId,
        meetingId,
        operationKey,
        operationType: "update",
        requestFingerprint,
        draft,
        now
      });
      return { draft, reused: false };
    });
    return run.immediate();
  }

  reset(input: {
    accountId: string;
    meetingId: string;
    operationKey: string;
    expectedVersion: number;
  }) {
    const accountId = parseId(input.accountId, "work_review_invalid_account");
    const meetingId = parseId(input.meetingId, "work_review_invalid_meeting_id");
    const operationKey = parseId(input.operationKey, "work_review_operation_key_required");
    const requestFingerprint = digest({
      operation: "reset",
      meetingId,
      expectedVersion: input.expectedVersion
    });
    const run = this.database.transaction(() => {
      this.assertLiveMeeting(accountId, meetingId);
      const replay = this.replayOperation({ accountId, operationKey, requestFingerprint });
      if (replay) return replay;
      const existing = this.draftRow(accountId, meetingId);
      if (!existing) {
        throw new WorkReviewConflictError("work_review_follow_up_not_generated");
      }
      if (existing.version !== input.expectedVersion) {
        throw new WorkReviewVersionConflictError(existing.version);
      }
      const now = this.now();
      const updated = this.database.prepare(`
        UPDATE wr_follow_up_drafts
        SET body_markdown = system_body_markdown, version = version + 1,
            user_edited_at = NULL, updated_at = ?
        WHERE account_id = ? AND meeting_id = ? AND version = ?
      `).run(now, accountId, meetingId, input.expectedVersion);
      if (updated.changes !== 1) {
        const current = this.draftRow(accountId, meetingId);
        throw new WorkReviewVersionConflictError(current?.version ?? input.expectedVersion);
      }
      const draft = fromRow(this.draftRow(accountId, meetingId)!);
      this.recordOperation({
        accountId,
        meetingId,
        operationKey,
        operationType: "reset",
        requestFingerprint,
        draft,
        now
      });
      return { draft, reused: false };
    });
    return run.immediate();
  }
}

export function createWorkMeetingFollowUpRepository(
  database: Database.Database,
  options: FollowUpRepositoryOptions = {}
) {
  return new WorkMeetingFollowUpRepository(database, options);
}
