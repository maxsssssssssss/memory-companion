import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { DcConflictError, DcNotFoundError } from "./errors";
import { stableBridgeDigest } from "./memory-bridge-digest";
import {
  cleanupDateCompanionGrantProjection,
  fenceDateCompanionGrantProjection,
  getFencedDateCompanionGrantCategory,
  hasDateCompanionGrantProjection
} from "./memory-grant-projection";

type Scope = {
  dateCompanionDatabase: Database.Database;
  memoryDatabase: Database.Database;
  userId: string;
  relationshipId: string;
};

type Grant = {
  userId: string;
  relationshipId: string;
  interactionId: string;
  uploadId: string;
  generation: number;
  outboxId: string;
  idempotencyKey: string;
  payloadDigest: string;
};

function readScope(input: Scope) {
  const { dateCompanionDatabase: db, userId, relationshipId } = input;
  if (!db.prepare("SELECT 1 FROM dc_relationships WHERE id = ? AND user_id = ? AND status='active'").get(relationshipId, userId)) {
    throw new DcNotFoundError("Relationship not found");
  }
  // Only a submitted outbox is an authorization. Drafts, saved recaps and
  // subject-suggestion batches have independent lifetimes.
  const authorized = db.prepare(`
    SELECT o.user_id AS userId, o.relationship_id AS relationshipId, o.interaction_id AS interactionId,
           i.source_upload_id AS uploadId, o.id AS outboxId, o.idempotency_key AS idempotencyKey,
           o.payload_digest AS payloadDigest, COALESCE(json_extract(o.payload_json, '$.grantGeneration'), 1) AS generation,
           o.status
    FROM dc_memory_bridge_outbox o
    JOIN dc_interactions i ON i.id=o.interaction_id AND i.user_id=o.user_id AND i.relationship_id=o.relationship_id
    WHERE o.user_id=? AND o.relationship_id=? AND o.status <> 'cancelled'
      AND i.status='confirmed' AND i.source_state <> 'explicitly_deleted'
    ORDER BY o.interaction_id
  `).all(userId, relationshipId) as Array<Grant & {status: string}>;
  const grants = authorized.flatMap(({status, ...grant}): Array<Grant & {category: "processing" | "retained"}> => {
    // Historical upload tombstones are a separate, stronger barrier.
    if (input.memoryDatabase.prepare("SELECT 1 FROM memory_upload_tombstones WHERE user_id=? AND upload_id=?")
      .get(userId, grant.uploadId)) return [];
    // A process may have stopped after committing the Memory fence but before
    // committing Date. Preserve its original impact for a retry of that preview.
    const fencedCategory = getFencedDateCompanionGrantCategory(input.memoryDatabase, grant);
    if (fencedCategory) return [{ ...grant, category: fencedCategory }];
    if (hasDateCompanionGrantProjection(input.memoryDatabase, grant)) return [{ ...grant, category: "retained" }];
    return status === "completed" ? [] : [{ ...grant, category: "processing" }];
  });
  const retainedCount = grants.filter(grant => grant.category === "retained").length;
  return {
    grants,
    preview: {
      version: stableBridgeDigest({ userId, relationshipId, grants }),
      totalCount: grants.length,
      retainedCount,
      processingCount: grants.length - retainedCount
    }
  };
}

function receipt(db: Database.Database, id: string) {
  const row = db.prepare(`
    SELECT w.id AS purgeId, w.preview_version AS previewVersion, w.updated_at AS updatedAt,
      COUNT(*) AS totalCount, SUM(g.category='retained') AS retainedCount,
      SUM(g.category='processing') AS processingCount, SUM(g.status='completed') AS completedCount,
      SUM(g.status='retryable_failed') AS failedCount
    FROM dc_memory_withdrawals w JOIN dc_memory_withdrawn_grants g ON g.withdrawal_id=w.id
    WHERE w.id=? GROUP BY w.id
  `).get(id) as {
    purgeId: string; previewVersion: string; updatedAt: string; totalCount: number; retainedCount: number;
    processingCount: number; completedCount: number; failedCount: number;
  } | undefined;
  if (!row) throw new DcConflictError("retained_memory_purge_missing");
  const status = row.completedCount === row.totalCount ? "completed" : row.failedCount ? "retryable_failed" : "processing";
  return { ...row, status, retryable: status !== "completed", usageStopped: true };
}

export function getDateCompanionWithdrawalPreview(input: Scope) {
  const db = input.dateCompanionDatabase;
  const {preview} = readScope(input);
  const pending = db.prepare(`
    SELECT w.id FROM dc_memory_withdrawals w
    WHERE w.user_id=? AND w.relationship_id=? AND EXISTS (
      SELECT 1 FROM dc_memory_withdrawn_grants g WHERE g.withdrawal_id=w.id AND g.status <> 'completed'
    ) ORDER BY w.created_at, w.id LIMIT 1
  `).get(input.userId, input.relationshipId) as {id:string} | undefined;
  return { preview, ...(pending ? { pendingCleanup: receipt(db, pending.id) } : {}) };
}

export function purgeDateCompanionRetainedMemory(input: Scope & { previewVersion: string }) {
  const { dateCompanionDatabase: db, memoryDatabase, userId, relationshipId } = input;
  const id = db.transaction(() => {
    const previous = db.prepare(`
      SELECT id FROM dc_memory_withdrawals WHERE user_id=? AND relationship_id=? AND preview_version=?
    `).get(userId, relationshipId, input.previewVersion) as {id:string} | undefined;
    if (previous) return previous.id;
    const {grants, preview} = readScope(input);
    if (input.previewVersion !== preview.version) throw new DcConflictError("withdrawal_preview_stale");
    if (!grants.length) throw new DcConflictError("withdrawal_nothing_to_remove");

    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO dc_memory_withdrawals (id,user_id,relationship_id,preview_version,created_at,updated_at)
      VALUES (?,?,?,?,?,?)
    `).run(id, userId, relationshipId, preview.version, now, now);
    const record = db.prepare(`
      INSERT INTO dc_memory_withdrawn_grants (
        withdrawal_id,user_id,relationship_id,interaction_id,upload_id,generation,outbox_id,idempotency_key,
        payload_digest,category,status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,'pending')
    `);
    for (const grant of grants) {
      record.run(id, userId, relationshipId, grant.interactionId, grant.uploadId, grant.generation,
        grant.outboxId, grant.idempotencyKey, grant.payloadDigest, grant.category);
      db.prepare("DELETE FROM dc_memory_bridge_outbox WHERE user_id=? AND id=?").run(userId, grant.outboxId);
      db.prepare("DELETE FROM dc_memory_subject_selections WHERE user_id=? AND interaction_id=?").run(userId, grant.interactionId);
      db.prepare(`UPDATE dc_relationship_reconfirmation_authorizations SET status='cancelled', updated_at=?
        WHERE user_id=? AND interaction_id=? AND status='authorized'`).run(now, userId, grant.interactionId);
    }

    // A relationship-level recap can combine several sources. Its cached text
    // and any provider claim for that text share the withdrawn input scope.
    db.prepare(`DELETE FROM dc_proactive_value_cache WHERE user_id = ? AND relationship_id = ?
      AND scope = 'person_relationship'`).run(userId, relationshipId);

    // Serialize consumers on the Date write lock; install all Memory read fences
    // together before acknowledging a committed withdrawal, including leased jobs.
    memoryDatabase.transaction(() => {
      for (const grant of grants) fenceDateCompanionGrantProjection(memoryDatabase, grant);
    }).immediate();
    return id;
  }).immediate();

  const items = db.prepare(`
    SELECT user_id AS userId, relationship_id AS relationshipId, interaction_id AS interactionId, upload_id AS uploadId,
           generation,outbox_id AS outboxId,idempotency_key AS idempotencyKey,payload_digest AS payloadDigest
    FROM dc_memory_withdrawn_grants WHERE withdrawal_id=? AND status <> 'completed'
  `).all(id) as Grant[];
  for (const grant of items) {
    let errorCode: string | null = null;
    try {
      cleanupDateCompanionGrantProjection(memoryDatabase, grant);
    } catch {
      errorCode = "retained_memory_cleanup_failed";
    }
    db.transaction(() => {
      db.prepare(`UPDATE dc_memory_withdrawn_grants SET status=?,attempt_count=attempt_count+1,last_error_code=?
        WHERE withdrawal_id=? AND outbox_id=? AND status <> 'completed'`)
        .run(errorCode ? "retryable_failed" : "completed", errorCode, id, grant.outboxId);
      db.prepare("UPDATE dc_memory_withdrawals SET updated_at=? WHERE id=?").run(new Date().toISOString(), id);
    })();
  }
  return receipt(db, id);
}
