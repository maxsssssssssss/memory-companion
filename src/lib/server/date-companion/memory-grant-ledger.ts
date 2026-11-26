import type Database from "better-sqlite3";
import { DcConflictError } from "./errors";

export function getInteractionGrantGeneration(db: Database.Database, userId: string, interactionId: string) {
  return (db.prepare(`
    SELECT COALESCE(MAX(generation), 0) + 1 AS next FROM dc_memory_withdrawn_grants
    WHERE user_id = ? AND interaction_id = ?
  `).get(userId, interactionId) as { next: number }).next;
}

export function relationshipWithdrawalVersion(db: Database.Database, userId: string, relationshipId: string) {
  const latest = db.prepare(`
    SELECT id FROM dc_memory_withdrawals WHERE user_id = ? AND relationship_id = ? ORDER BY rowid DESC LIMIT 1
  `).get(userId, relationshipId) as {id: string} | undefined;
  return latest?.id;
}

export function assertUploadCanBeAuthorized(db: Database.Database, userId: string, uploadId: string) {
  if (db.prepare("SELECT 1 FROM memory_upload_tombstones WHERE user_id = ? AND upload_id = ?").get(userId, uploadId)) {
    throw new DcConflictError("memory_bridge_source_deleted");
  }
}
