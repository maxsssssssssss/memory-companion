import type Database from "better-sqlite3";

export type DateCompanionSubjectSuggestionBatchKey = {
  userId: string;
  interactionId: string;
  interactionVersion: number;
  mappingVersion: number;
  evidenceDigest: string;
};

export type DateCompanionSubjectSuggestionBatchRow = {
  id: string;
  payload_json: string;
};

type SubjectSuggestionClaimRow = {
  claim_token: string;
  lease_expires_at: string;
};

export type DateCompanionSubjectSuggestionClaimResult =
  | { kind: "completed"; row: DateCompanionSubjectSuggestionBatchRow }
  | { kind: "owner"; claimToken: string }
  | { kind: "waiting"; leaseExpiresAt: string };

function keyValues(key: DateCompanionSubjectSuggestionBatchKey) {
  return [
    key.userId,
    key.interactionId,
    key.interactionVersion,
    key.mappingVersion,
    key.evidenceDigest
  ] as const;
}

export class DateCompanionSubjectSuggestionRepository {
  constructor(private readonly database: Database.Database) {}

  findBatch(key: DateCompanionSubjectSuggestionBatchKey) {
    return this.database.prepare(`
      SELECT id, payload_json FROM dc_subject_suggestion_batches
      WHERE user_id = ? AND interaction_id = ? AND interaction_version = ?
        AND mapping_version = ? AND evidence_digest = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(...keyValues(key)) as DateCompanionSubjectSuggestionBatchRow | undefined;
  }

  findClaim(key: DateCompanionSubjectSuggestionBatchKey) {
    return this.database.prepare(`
      SELECT claim_token, lease_expires_at
      FROM dc_subject_suggestion_claims
      WHERE user_id = ? AND interaction_id = ? AND interaction_version = ?
        AND mapping_version = ? AND evidence_digest = ?
    `).get(...keyValues(key)) as SubjectSuggestionClaimRow | undefined;
  }

  claimGeneration(input: {
    key: DateCompanionSubjectSuggestionBatchKey;
    relationshipId: string;
    claimToken: string;
    now: string;
    leaseExpiresAt: string;
  }): DateCompanionSubjectSuggestionClaimResult {
    return this.database.transaction((): DateCompanionSubjectSuggestionClaimResult => {
      const completed = this.findBatch(input.key);
      if (completed) return { kind: "completed", row: completed };

      const inserted = this.database.prepare(`
        INSERT INTO dc_subject_suggestion_claims (
          user_id, relationship_id, interaction_id, interaction_version,
          mapping_version, evidence_digest, claim_token, lease_expires_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (
          user_id, interaction_id, interaction_version,
          mapping_version, evidence_digest
        ) DO NOTHING
      `).run(
        input.key.userId,
        input.relationshipId,
        input.key.interactionId,
        input.key.interactionVersion,
        input.key.mappingVersion,
        input.key.evidenceDigest,
        input.claimToken,
        input.leaseExpiresAt,
        input.now,
        input.now
      );
      if (inserted.changes === 1) {
        return { kind: "owner", claimToken: input.claimToken };
      }

      const current = this.database.prepare(`
        SELECT claim_token, lease_expires_at
        FROM dc_subject_suggestion_claims
        WHERE user_id = ? AND interaction_id = ? AND interaction_version = ?
          AND mapping_version = ? AND evidence_digest = ?
      `).get(...keyValues(input.key)) as SubjectSuggestionClaimRow | undefined;
      if (!current) {
        throw new Error("subject_suggestion_claim_missing");
      }
      if (current.lease_expires_at <= input.now) {
        const takenOver = this.database.prepare(`
          UPDATE dc_subject_suggestion_claims
          SET claim_token = ?, lease_expires_at = ?, updated_at = ?
          WHERE user_id = ? AND interaction_id = ? AND interaction_version = ?
            AND mapping_version = ? AND evidence_digest = ?
            AND claim_token = ? AND lease_expires_at = ?
        `).run(
          input.claimToken,
          input.leaseExpiresAt,
          input.now,
          ...keyValues(input.key),
          current.claim_token,
          current.lease_expires_at
        );
        if (takenOver.changes === 1) {
          return { kind: "owner", claimToken: input.claimToken };
        }
      }
      return { kind: "waiting", leaseExpiresAt: current.lease_expires_at };
    }).immediate();
  }

  completeGeneration(input: {
    key: DateCompanionSubjectSuggestionBatchKey;
    claimToken: string;
    batch: {
      id: string;
      relationshipId: string;
      proposalDigest: string;
      confirmationFingerprint: string;
      model: string;
      status: "ready" | "degraded";
      payloadJson: string;
      createdAt: string;
    };
  }):
    | { kind: "completed"; row: DateCompanionSubjectSuggestionBatchRow }
    | { kind: "lost" } {
    return this.database.transaction(() => {
      const completed = this.findBatch(input.key);
      if (completed) {
        this.deleteOwnedClaim(input.key, input.claimToken);
        return { kind: "completed" as const, row: completed };
      }

      const current = this.database.prepare(`
        SELECT claim_token, lease_expires_at
        FROM dc_subject_suggestion_claims
        WHERE user_id = ? AND interaction_id = ? AND interaction_version = ?
          AND mapping_version = ? AND evidence_digest = ?
      `).get(...keyValues(input.key)) as SubjectSuggestionClaimRow | undefined;
      if (!current || current.claim_token !== input.claimToken) {
        return { kind: "lost" as const };
      }

      this.database.prepare(`
        INSERT INTO dc_subject_suggestion_batches (
          id, user_id, relationship_id, interaction_id, interaction_version,
          mapping_version, evidence_digest, proposal_digest,
          confirmation_fingerprint, model, status, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.batch.id,
        input.key.userId,
        input.batch.relationshipId,
        input.key.interactionId,
        input.key.interactionVersion,
        input.key.mappingVersion,
        input.key.evidenceDigest,
        input.batch.proposalDigest,
        input.batch.confirmationFingerprint,
        input.batch.model,
        input.batch.status,
        input.batch.payloadJson,
        input.batch.createdAt
      );
      const released = this.deleteOwnedClaim(input.key, input.claimToken);
      if (released !== 1) throw new Error("subject_suggestion_claim_fence_lost");
      const persisted = this.findBatch(input.key);
      if (!persisted) throw new Error("subject_suggestion_batch_write_failed");
      return { kind: "completed" as const, row: persisted };
    }).immediate();
  }

  releaseGeneration(key: DateCompanionSubjectSuggestionBatchKey, claimToken: string) {
    return this.database.transaction(() => this.deleteOwnedClaim(key, claimToken)).immediate();
  }

  private deleteOwnedClaim(key: DateCompanionSubjectSuggestionBatchKey, claimToken: string) {
    return this.database.prepare(`
      DELETE FROM dc_subject_suggestion_claims
      WHERE user_id = ? AND interaction_id = ? AND interaction_version = ?
        AND mapping_version = ? AND evidence_digest = ? AND claim_token = ?
    `).run(...keyValues(key), claimToken).changes;
  }
}
