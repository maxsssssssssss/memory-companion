// An unpublished reflection can share an upload with a separately authorized
// Date Companion card. Only positive, exclusive provenance exempts that row.
export function isIndependentDateEvidence(evidenceAlias: string) {
  return `EXISTS (
    SELECT 1 FROM memory_evidence_provenance dc
    JOIN dc_retained_uploads retained ON retained.user_id = dc.user_id AND retained.upload_id = dc.upload_id
    WHERE dc.memory_evidence_id = ${evidenceAlias}.id AND retained.status = 'active'
      AND (retained.grant_outbox_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM dc_memory_bridge_receipts receipt WHERE receipt.account_id = retained.user_id
          AND receipt.dc_relationship_id = retained.dc_relationship_id AND receipt.dc_interaction_id = retained.dc_interaction_id
      ))
      AND NOT EXISTS (SELECT 1 FROM memory_daily_reflection_evidence_provenance other
        WHERE other.memory_evidence_id = dc.memory_evidence_id)
  )`;
}
