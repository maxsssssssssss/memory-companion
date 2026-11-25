import type Database from "better-sqlite3";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import { recalculatePersonLifecycle } from "@/lib/server/person/lifecycle-recalculation";
import { DcConflictError } from "./errors";

type Grant = {
  userId: string;
  relationshipId: string;
  interactionId: string;
  uploadId: string;
  generation: number;
  outboxId: string;
  category?: "retained" | "processing";
};

// v9–14 retained rows have no outbox column. The matching first-generation
// interaction and account/upload identify the legacy contribution.
const retainedGrant = `
  SELECT 1 FROM dc_retained_uploads retained
  WHERE retained.user_id = @userId AND retained.upload_id = @uploadId
    AND retained.dc_relationship_id = @relationshipId AND retained.dc_interaction_id = @interactionId
    AND retained.status = 'active'
    AND (retained.grant_outbox_id = @outboxId OR (
      retained.grant_outbox_id IS NULL AND @generation = 1
    ))
`;

export function hasDateCompanionGrantProjection(db: Database.Database, grant: Grant) {
  if (getFencedDateCompanionGrantCategory(db, grant)) return false;
  return Boolean(db.prepare(`${retainedGrant}
    AND EXISTS (
      SELECT 1 FROM memory_evidence_provenance provenance
      JOIN memory_evidence evidence ON evidence.id = provenance.memory_evidence_id
      JOIN memory_items memory ON memory.id = evidence.memory_id AND memory.user_id = retained.user_id
      WHERE provenance.user_id = retained.user_id AND provenance.upload_id = retained.upload_id
    )`).get(grant) || db.prepare(`
      SELECT 1 FROM person_evidence_dc_links link
      JOIN person_evidence person ON person.id = link.person_evidence_id AND person.account_id = link.account_id
      JOIN dc_memory_bridge_receipts receipt ON receipt.account_id = link.account_id
        AND receipt.dc_relationship_id = link.dc_relationship_id AND receipt.dc_interaction_id = link.dc_interaction_id
      WHERE link.account_id = @userId AND link.dc_relationship_id = @relationshipId
        AND link.dc_interaction_id = @interactionId AND receipt.dc_outbox_id = @outboxId AND person.upload_id = @uploadId
    `).get(grant));
}

function detachPersonProjection(db: Database.Database, grant: Grant) {
  const links = db.prepare(`
    SELECT l.person_evidence_id AS id, MAX(l.independent_person_evidence) AS independentEvidence,
      MAX(l.independent_relationship_edge) AS independentEdge FROM person_evidence_dc_links l
    JOIN person_evidence e ON e.account_id = l.account_id AND e.id = l.person_evidence_id
    WHERE l.account_id = @userId AND l.dc_relationship_id = @relationshipId
      AND l.dc_interaction_id = @interactionId AND e.upload_id = @uploadId
    GROUP BY l.person_evidence_id
  `).all(grant) as Array<{ id: string; independentEvidence: number; independentEdge: number }>;

  db.prepare(`DELETE FROM person_evidence_dc_links
    WHERE account_id = @userId AND dc_relationship_id = @relationshipId
      AND dc_interaction_id = @interactionId
      AND EXISTS (SELECT 1 FROM person_evidence e WHERE e.account_id = @userId
        AND e.id = person_evidence_dc_links.person_evidence_id AND e.upload_id = @uploadId)`).run(grant);

  let removed = false;
  for (const { id, independentEvidence, independentEdge } of links) {
    const params = { ...grant, id, independentEdge };
    if (!independentEvidence && !db.prepare(`
      SELECT 1 FROM person_evidence_dc_links WHERE account_id = @userId AND person_evidence_id = @id
      UNION ALL
      SELECT 1 FROM memory_daily_reflection_candidate_person_sources
      WHERE user_id = @userId AND person_evidence_id = @id AND status = 'active'
      UNION ALL
      SELECT 1 FROM person_evidence person JOIN memory_evidence evidence
        ON evidence.source_id = person.source_segment_id AND evidence.upload_id = person.upload_id
      JOIN memory_items memory ON memory.id = evidence.memory_id AND memory.user_id = person.account_id
      WHERE person.account_id = @userId AND person.id = @id
    `).get(params)) {
      // All references to this source were derivatives of the withdrawn grant.
      // Foreign keys remove its observations, fact/commitment evidence and audits.
      db.prepare("DELETE FROM person_evidence WHERE account_id = ? AND id = ?").run(grant.userId, id);
      removed = true;
      continue;
    }
    // The canonical source is independently supported. Detach only this
    // relationship edge and the bridge's observations if no other grant uses them.
    db.prepare(`
      DELETE FROM person_relationship_evidence WHERE account_id = @userId AND evidence_id = @id
        AND @independentEdge = 0
        AND relationship_id IN (SELECT person_relationship_id FROM dc_person_relationship_links
          WHERE account_id = @userId AND dc_relationship_id = @relationshipId)
        AND NOT EXISTS (
          SELECT 1 FROM person_evidence_dc_links l
          JOIN dc_person_relationship_links r ON r.account_id = l.account_id
            AND r.dc_relationship_id = l.dc_relationship_id
          WHERE l.account_id = @userId AND l.person_evidence_id = @id
            AND r.person_relationship_id = person_relationship_evidence.relationship_id
        )
    `).run(params);
    // A second product can have its own current admission while holding a
    // snapshot of the old observation to restore when *its* grant ends.
    // Drop that restoration only when it points at this bridge's old grant.
    db.prepare(`
      UPDATE memory_daily_reflection_candidate_person_sources
      SET previous_subject_admission_json = NULL, previous_subject_observation_json = NULL,
          owns_subject_observation = 1, owns_subject_admission = 1
      WHERE user_id = @userId AND person_evidence_id = @id AND status = 'active'
        AND json_extract(previous_subject_observation_json, '$.reason') IN (
          'date_companion_explicit_subject_v1', 'date_companion_qwen_batch_review_v1')
        AND NOT EXISTS (SELECT 1 FROM person_evidence_dc_links WHERE account_id = @userId AND person_evidence_id = @id)
    `).run(params);
    db.prepare(`
      DELETE FROM person_subject_observations WHERE account_id = @userId AND evidence_id = @id
        AND source = 'manual_review'
        AND reason IN ('date_companion_explicit_subject_v1','date_companion_qwen_batch_review_v1')
        AND NOT EXISTS (SELECT 1 FROM person_evidence_dc_links
          WHERE account_id = @userId AND person_evidence_id = @id)
        AND NOT EXISTS (SELECT 1 FROM memory_daily_reflection_candidate_person_sources
          WHERE user_id = @userId AND subject_observation_id = person_subject_observations.id AND status = 'active')
    `).run(params);
  }
  if (removed) recalculatePersonLifecycle(db, { accountId: grant.userId, now: new Date().toISOString() });
}

export function getFencedDateCompanionGrantCategory(db: Database.Database, grant: Grant) {
  const row = db.prepare(`SELECT category FROM dc_memory_withdrawn_projections
    WHERE user_id = @userId AND outbox_id = @outboxId AND relationship_id = @relationshipId
      AND interaction_id = @interactionId AND upload_id = @uploadId AND generation = @generation
  `).get(grant) as { category: "retained" | "processing" } | undefined;
  return row?.category ?? null;
}

export function fenceDateCompanionGrantProjection(db: Database.Database, grant: Grant) {
  db.transaction(() => {
    const category = grant.category ?? (hasDateCompanionGrantProjection(db, grant) ? "retained" : "processing");
    const fenced = db.prepare(`INSERT INTO dc_memory_withdrawn_projections
      (user_id, relationship_id, interaction_id, upload_id, outbox_id, generation, category)
      VALUES (@userId, @relationshipId, @interactionId, @uploadId, @outboxId, @generation, @category)
      ON CONFLICT(user_id, outbox_id) DO NOTHING`).run({ ...grant, category });
    if (!fenced.changes) {
      if (!getFencedDateCompanionGrantCategory(db, grant)) throw new DcConflictError("memory_withdrawal_fence_conflict");
      return;
    }
    const retained = db.prepare(retainedGrant).get(grant);
    if (retained) {
      createMemoryRepository(db).replaceUploadMemories({
        userId: grant.userId, uploadId: grant.uploadId, projection: "date_companion", memories: []
      });
      // Legacy capture could attach DC provenance to an evidence row owned by
      // a second product. Its independent evidence survives the scoped rewrite.
      db.prepare(`DELETE FROM memory_evidence_provenance WHERE user_id = @userId AND upload_id = @uploadId`).run(grant);
      db.prepare(`DELETE FROM dc_retained_uploads WHERE user_id = @userId AND upload_id = @uploadId
        AND dc_relationship_id = @relationshipId AND dc_interaction_id = @interactionId
        AND status = 'active'`).run(grant);
    }
    // Covers the older bridge that wrote Person evidence without a Memory card.
    const legacyPersonReceipt = db.prepare(`SELECT 1 FROM dc_memory_bridge_receipts
      WHERE account_id = @userId AND dc_outbox_id = @outboxId
        AND dc_relationship_id = @relationshipId AND dc_interaction_id = @interactionId`).get(grant);
    if (retained || legacyPersonReceipt) detachPersonProjection(db, grant);
  }).immediate();
}

export function cleanupDateCompanionGrantProjection(db: Database.Database, grant: Grant) {
  if (!db.prepare(`SELECT 1 FROM dc_memory_withdrawn_projections WHERE user_id = @userId
    AND outbox_id = @outboxId AND relationship_id = @relationshipId AND interaction_id = @interactionId
    AND upload_id = @uploadId AND generation = @generation`).get(grant)) {
    throw new DcConflictError("memory_withdrawal_fence_missing");
  }
  db.prepare(`DELETE FROM dc_memory_bridge_receipts WHERE account_id = @userId
    AND dc_outbox_id = @outboxId AND dc_relationship_id = @relationshipId
    AND dc_interaction_id = @interactionId`).run(grant);
}
