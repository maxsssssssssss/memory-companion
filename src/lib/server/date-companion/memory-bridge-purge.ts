import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import { DcConflictError, DcNotFoundError } from "./errors";
import { prepareMemoryBridgeInteractionDeletion } from "./memory-bridge-repository";

function stableId(prefix: string, ...values: string[]) {
  return `${prefix}_${createHash("sha256")
    .update(values.join("\u0000"))
    .digest("hex")
    .slice(0, 32)}`;
}

export function purgeDateCompanionRetainedMemory(input: {
  dateCompanionDatabase: Database.Database;
  memoryDatabase: Database.Database;
  userId: string;
  relationshipId: string;
}) {
  const now = new Date().toISOString();
  const purgeId = stableId("dc_retained_memory_purge", input.userId, input.relationshipId);
  input.dateCompanionDatabase.transaction(() => {
    const relationship = input.dateCompanionDatabase.prepare(`
      SELECT 1 FROM dc_relationships WHERE id = ? AND user_id = ?
    `).get(input.relationshipId, input.userId);
    if (!relationship) throw new DcNotFoundError("Relationship not found");
    const interactions = input.dateCompanionDatabase.prepare(`
      SELECT id, source_upload_id
      FROM dc_interactions
      WHERE user_id = ? AND relationship_id = ?
      ORDER BY id
    `).all(input.userId, input.relationshipId) as Array<{
      id: string;
      source_upload_id: string;
    }>;
    for (const interaction of interactions) {
      prepareMemoryBridgeInteractionDeletion(
        input.dateCompanionDatabase,
        input.userId,
        interaction.id,
        now
      );
    }
    input.dateCompanionDatabase.prepare(`
      INSERT INTO dc_retained_memory_purges (
        id, user_id, relationship_id, status, total_count, completed_count,
        failed_count, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', 0, 0, 0, ?, ?)
      ON CONFLICT(user_id, relationship_id) DO UPDATE SET
        status = CASE
          WHEN dc_retained_memory_purges.status = 'completed'
            THEN dc_retained_memory_purges.status
          ELSE 'pending'
        END,
        last_error_code = NULL, updated_at = excluded.updated_at
    `).run(purgeId, input.userId, input.relationshipId, now, now);
    const insertItem = input.dateCompanionDatabase.prepare(`
      INSERT INTO dc_retained_memory_purge_items (
        purge_id, user_id, relationship_id, interaction_id, upload_id,
        status, attempt_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)
      ON CONFLICT(user_id, relationship_id, upload_id) DO NOTHING
    `);
    for (const interaction of interactions) {
      insertItem.run(
        purgeId,
        input.userId,
        input.relationshipId,
        interaction.id,
        interaction.source_upload_id,
        now
      );
    }
    const total = (input.dateCompanionDatabase.prepare(`
      SELECT COUNT(*) AS count FROM dc_retained_memory_purge_items WHERE purge_id = ?
    `).get(purgeId) as { count: number }).count;
    input.dateCompanionDatabase.prepare(`
      UPDATE dc_retained_memory_purges
      SET total_count = ?, status = 'processing', updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(total, now, purgeId, input.userId);
  })();

  const items = input.dateCompanionDatabase.prepare(`
    SELECT upload_id FROM dc_retained_memory_purge_items
    WHERE purge_id = ? AND status <> 'completed'
    ORDER BY upload_id
  `).all(purgeId) as Array<{ upload_id: string }>;
  const memoryRepository = createMemoryRepository(input.memoryDatabase);
  for (const [index, item] of items.entries()) {
    console.info(
      `[memory-retention-purge] ${index + 1}/${items.length} relationship_id=${input.relationshipId}`
    );
    try {
      memoryRepository.deleteByUpload(input.userId, item.upload_id);
      input.memoryDatabase.prepare(`
        UPDATE dc_retained_uploads
        SET status = 'purged', updated_at = ?
        WHERE user_id = ? AND upload_id = ?
      `).run(new Date().toISOString(), input.userId, item.upload_id);
      input.dateCompanionDatabase.prepare(`
        UPDATE dc_retained_memory_purge_items
        SET status = 'completed', attempt_count = attempt_count + 1,
            last_error_code = NULL, updated_at = ?
        WHERE purge_id = ? AND upload_id = ?
      `).run(new Date().toISOString(), purgeId, item.upload_id);
    } catch (error) {
      const errorCode = error instanceof Error && /^[A-Za-z0-9_-]+$/u.test(error.message)
        ? error.message
        : "retained_memory_purge_failed";
      input.dateCompanionDatabase.prepare(`
        UPDATE dc_retained_memory_purge_items
        SET status = 'retryable_failed', attempt_count = attempt_count + 1,
            last_error_code = ?, updated_at = ?
        WHERE purge_id = ? AND upload_id = ?
      `).run(errorCode, new Date().toISOString(), purgeId, item.upload_id);
    }
  }
  const counts = input.dateCompanionDatabase.prepare(`
    SELECT COUNT(*) AS total_count,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
      SUM(CASE WHEN status = 'retryable_failed' THEN 1 ELSE 0 END) AS failed_count
    FROM dc_retained_memory_purge_items WHERE purge_id = ?
  `).get(purgeId) as {
    total_count: number;
    completed_count: number;
    failed_count: number;
  };
  const status = counts.failed_count > 0 ? "retryable_failed" : "completed";
  input.dateCompanionDatabase.prepare(`
    UPDATE dc_retained_memory_purges
    SET status = ?, total_count = ?, completed_count = ?, failed_count = ?,
        last_error_code = ?, completed_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    status,
    counts.total_count,
    counts.completed_count,
    counts.failed_count,
    counts.failed_count > 0 ? "retained_memory_purge_failed" : null,
    status === "completed" ? new Date().toISOString() : null,
    new Date().toISOString(),
    purgeId,
    input.userId
  );
  const result = input.dateCompanionDatabase.prepare(`
    SELECT status, total_count, completed_count, failed_count, last_error_code, updated_at
    FROM dc_retained_memory_purges WHERE id = ? AND user_id = ?
  `).get(purgeId, input.userId) as {
    status: string;
    total_count: number;
    completed_count: number;
    failed_count: number;
    last_error_code: string | null;
    updated_at: string;
  } | undefined;
  if (!result) throw new DcConflictError("retained_memory_purge_missing");
  return {
    purgeId,
    status: result.status,
    totalCount: result.total_count,
    completedCount: result.completed_count,
    failedCount: result.failed_count,
    retryable: result.status === "retryable_failed",
    updatedAt: result.updated_at
  };
}
