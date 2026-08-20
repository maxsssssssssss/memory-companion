import type Database from "better-sqlite3";
import {
  DC_EVIDENCE_PROVENANCE_VERSION,
  DC_EVIDENCE_SOURCE_KIND,
  dateCompanionEvidenceDigest
} from "./memory-bridge-digest";

export const DATE_COMPANION_SCHEMA_VERSION = 11;

const DATE_COMPANION_SCHEMA_V1 = `
  CREATE TABLE dc_relationships (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, user_id)
  );

  CREATE UNIQUE INDEX idx_dc_relationships_one_active
    ON dc_relationships(user_id) WHERE status = 'active';
  CREATE INDEX idx_dc_relationships_user_updated
    ON dc_relationships(user_id, updated_at DESC);

  CREATE TABLE dc_interactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    source_upload_id TEXT NOT NULL,
    recording_date TEXT NOT NULL,
    original_name TEXT NOT NULL,
    duration_seconds REAL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'confirmed')),
    source_state TEXT NOT NULL CHECK (source_state IN ('available', 'server_cleaned', 'explicitly_deleted')),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    confirmed_at TEXT,
    UNIQUE (id, user_id),
    UNIQUE (user_id, source_upload_id),
    FOREIGN KEY (relationship_id, user_id)
      REFERENCES dc_relationships(id, user_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_dc_interactions_relationship_date
    ON dc_interactions(user_id, relationship_id, recording_date DESC, created_at DESC);

  CREATE TABLE dc_participant_assignments (
    user_id TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    speaker_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('self', 'companion', 'unresolved')),
    confirmed_by TEXT,
    confirmed_at TEXT,
    PRIMARY KEY (user_id, interaction_id, speaker_id),
    FOREIGN KEY (interaction_id, user_id)
      REFERENCES dc_interactions(id, user_id) ON DELETE CASCADE
  );

  CREATE TABLE dc_recap_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('moment', 'mentioned', 'promise', 'continue')),
    proposed_text TEXT NOT NULL,
    user_text TEXT,
    disposition TEXT NOT NULL CHECK (disposition IN ('pending', 'kept', 'excluded')),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, user_id),
    FOREIGN KEY (interaction_id, user_id)
      REFERENCES dc_interactions(id, user_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_dc_recap_items_interaction_order
    ON dc_recap_items(user_id, interaction_id, sort_order, id);

  CREATE TABLE dc_evidence_snapshots (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    recap_item_id TEXT NOT NULL,
    upload_id TEXT NOT NULL,
    source_segment_id TEXT NOT NULL,
    start_seconds REAL NOT NULL CHECK (start_seconds >= 0),
    end_seconds REAL NOT NULL CHECK (end_seconds > start_seconds),
    speaker_id TEXT,
    quote TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (id, user_id),
    UNIQUE (user_id, recap_item_id, upload_id, source_segment_id),
    FOREIGN KEY (recap_item_id, user_id)
      REFERENCES dc_recap_items(id, user_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_dc_evidence_upload_segment
    ON dc_evidence_snapshots(user_id, upload_id, source_segment_id);

  CREATE TABLE dc_promises (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    originating_recap_item_id TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'done')),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, user_id),
    UNIQUE (user_id, originating_recap_item_id),
    FOREIGN KEY (relationship_id, user_id)
      REFERENCES dc_relationships(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (originating_recap_item_id, user_id)
      REFERENCES dc_recap_items(id, user_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_dc_promises_relationship_status
    ON dc_promises(user_id, relationship_id, status, updated_at DESC);
`;

const DATE_COMPANION_SCHEMA_V2 = `
  ALTER TABLE dc_interactions
    ADD COLUMN confirmation_fingerprint TEXT;
`;

const DATE_COMPANION_SCHEMA_V3 = `
  CREATE TABLE dc_participant_audio_samples (
    user_id TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    speaker_id TEXT NOT NULL,
    mime_type TEXT NOT NULL CHECK (mime_type = 'audio/mpeg'),
    duration_milliseconds INTEGER NOT NULL CHECK (duration_milliseconds > 0),
    audio BLOB NOT NULL CHECK (length(audio) > 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, interaction_id, speaker_id),
    FOREIGN KEY (user_id, interaction_id, speaker_id)
      REFERENCES dc_participant_assignments(user_id, interaction_id, speaker_id)
      ON DELETE CASCADE
  );
`;

const DATE_COMPANION_SCHEMA_V4 = `
  ALTER TABLE dc_participant_assignments
    ADD COLUMN continuity_key TEXT;

  CREATE TABLE dc_relationship_speaker_bindings (
    user_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    continuity_key TEXT NOT NULL,
    source_interaction_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('self', 'companion')),
    confirmed_by TEXT NOT NULL,
    confirmed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, relationship_id, continuity_key),
    FOREIGN KEY (relationship_id, user_id)
      REFERENCES dc_relationships(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (source_interaction_id, user_id)
      REFERENCES dc_interactions(id, user_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_dc_relationship_speaker_bindings_role
    ON dc_relationship_speaker_bindings(user_id, relationship_id, role);
`;

const DATE_COMPANION_SCHEMA_V5 = `
  CREATE TABLE dc_voice_enrollment_snapshots (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    review_group_id TEXT NOT NULL,
    source_upload_id TEXT NOT NULL,
    provider_record_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    local_speaker TEXT NOT NULL,
    audit_status TEXT NOT NULL CHECK (audit_status IN ('verified', 'pending', 'unknown')),
    audit_reason TEXT NOT NULL,
    audit_digest TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (id, user_id),
    UNIQUE (user_id, interaction_id, review_group_id),
    FOREIGN KEY (relationship_id, user_id)
      REFERENCES dc_relationships(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (interaction_id, user_id)
      REFERENCES dc_interactions(id, user_id) ON DELETE CASCADE
  );

  CREATE TABLE dc_voice_enrollment_snapshot_members (
    user_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    speaker_id TEXT NOT NULL,
    PRIMARY KEY (user_id, snapshot_id, speaker_id),
    UNIQUE (user_id, interaction_id, speaker_id),
    FOREIGN KEY (snapshot_id, user_id)
      REFERENCES dc_voice_enrollment_snapshots(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, interaction_id, speaker_id)
      REFERENCES dc_participant_assignments(user_id, interaction_id, speaker_id)
      ON DELETE CASCADE
  );

  CREATE TABLE dc_voice_enrollment_outbox (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    provider_speaker_id TEXT NOT NULL,
    expected_global_speaker_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    claim_token TEXT,
    lease_expires_at TEXT,
    last_error_code TEXT,
    profile_global_speaker_id TEXT,
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (id, user_id),
    UNIQUE (user_id, idempotency_key),
    UNIQUE (user_id, interaction_id),
    FOREIGN KEY (relationship_id, user_id)
      REFERENCES dc_relationships(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (interaction_id, user_id)
      REFERENCES dc_interactions(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (snapshot_id, user_id)
      REFERENCES dc_voice_enrollment_snapshots(id, user_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_dc_voice_enrollment_outbox_status
    ON dc_voice_enrollment_outbox(status, updated_at, id);
`;

const DATE_COMPANION_SCHEMA_V6 = `
  ALTER TABLE dc_evidence_snapshots
    ADD COLUMN provenance_version INTEGER NOT NULL DEFAULT 1
      CHECK (provenance_version = 1);
  ALTER TABLE dc_evidence_snapshots
    ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'date_companion_recap'
      CHECK (source_kind = 'date_companion_recap');
  ALTER TABLE dc_evidence_snapshots
    ADD COLUMN content_digest TEXT;

  CREATE TABLE dc_memory_retention_settings (
    user_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    enabled_at TEXT,
    disabled_at TEXT,
    CHECK (
      (enabled = 1 AND enabled_at IS NOT NULL AND disabled_at IS NULL) OR
      (enabled = 0 AND disabled_at IS NOT NULL)
    )
  );

  CREATE TABLE dc_memory_retention_setting_audits (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    previous_enabled INTEGER NOT NULL CHECK (previous_enabled IN (0, 1)),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    resulting_version INTEGER NOT NULL CHECK (resulting_version >= 1),
    created_at TEXT NOT NULL,
    UNIQUE (user_id, resulting_version)
  );

  CREATE TABLE dc_relationship_person_mappings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    self_person_id TEXT NOT NULL,
    companion_person_id TEXT NOT NULL,
    relationship_type TEXT NOT NULL CHECK (
      relationship_type IN ('dating', 'partner', 'friend', 'other')
    ),
    status TEXT NOT NULL CHECK (status IN ('confirmed', 'needs_review', 'archived')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    confirmed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, user_id),
    UNIQUE (user_id, relationship_id),
    CHECK (self_person_id <> companion_person_id),
    CHECK (status <> 'confirmed' OR confirmed_at IS NOT NULL),
    FOREIGN KEY (relationship_id, user_id)
      REFERENCES dc_relationships(id, user_id) ON DELETE CASCADE
  );

  CREATE TABLE dc_relationship_person_mapping_audits (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    mapping_id TEXT NOT NULL,
    self_person_id TEXT NOT NULL,
    companion_person_id TEXT NOT NULL,
    relationship_type TEXT NOT NULL CHECK (
      relationship_type IN ('dating', 'partner', 'friend', 'other')
    ),
    status TEXT NOT NULL CHECK (status IN ('confirmed', 'needs_review', 'archived')),
    resulting_version INTEGER NOT NULL CHECK (resulting_version >= 1),
    created_at TEXT NOT NULL,
    UNIQUE (user_id, relationship_id, resulting_version),
    FOREIGN KEY (mapping_id, user_id)
      REFERENCES dc_relationship_person_mappings(id, user_id) ON DELETE CASCADE
  );

  CREATE TABLE dc_memory_subject_selections (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    recap_item_id TEXT NOT NULL,
    evidence_snapshot_id TEXT NOT NULL,
    subject TEXT NOT NULL CHECK (subject IN ('self', 'companion', 'both', 'unknown')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, user_id),
    UNIQUE (user_id, evidence_snapshot_id),
    FOREIGN KEY (relationship_id, user_id)
      REFERENCES dc_relationships(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (interaction_id, user_id)
      REFERENCES dc_interactions(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (recap_item_id, user_id)
      REFERENCES dc_recap_items(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (evidence_snapshot_id, user_id)
      REFERENCES dc_evidence_snapshots(id, user_id) ON DELETE CASCADE
  );

  CREATE TABLE dc_memory_bridge_outbox (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    mapping_version INTEGER,
    source_version INTEGER NOT NULL CHECK (source_version >= 0),
    confirmation_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'pending', 'processing', 'completed', 'retryable_failed', 'needs_review', 'cancelled'
    )),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    claim_token TEXT,
    lease_expires_at TEXT,
    last_error_code TEXT,
    requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (id, user_id),
    UNIQUE (user_id, idempotency_key),
    UNIQUE (user_id, interaction_id),
    FOREIGN KEY (relationship_id, user_id)
      REFERENCES dc_relationships(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (interaction_id, user_id)
      REFERENCES dc_interactions(id, user_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_dc_memory_bridge_outbox_claim
    ON dc_memory_bridge_outbox(status, updated_at, id);

  CREATE TABLE dc_retained_memory_purges (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'retryable_failed')),
    total_count INTEGER NOT NULL CHECK (total_count >= 0),
    completed_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
    failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    last_error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (user_id, relationship_id),
    FOREIGN KEY (relationship_id, user_id)
      REFERENCES dc_relationships(id, user_id) ON DELETE CASCADE
  );

  CREATE TABLE dc_retained_memory_purge_items (
    purge_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    upload_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'retryable_failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error_code TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (purge_id, upload_id),
    UNIQUE (user_id, relationship_id, upload_id),
    FOREIGN KEY (purge_id)
      REFERENCES dc_retained_memory_purges(id) ON DELETE CASCADE,
    FOREIGN KEY (interaction_id, user_id)
      REFERENCES dc_interactions(id, user_id) ON DELETE CASCADE
  );
`;

const DATE_COMPANION_SCHEMA_V7 = `
  CREATE TABLE dc_subject_suggestion_batches (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    interaction_version INTEGER NOT NULL CHECK (interaction_version >= 0),
    mapping_version INTEGER NOT NULL CHECK (mapping_version >= 1),
    evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
    proposal_digest TEXT NOT NULL CHECK (length(proposal_digest) = 64),
    confirmation_fingerprint TEXT NOT NULL CHECK (length(confirmation_fingerprint) = 64),
    model TEXT NOT NULL CHECK (model = 'Qwen/Qwen3.6-27B'),
    status TEXT NOT NULL CHECK (status IN ('ready', 'degraded')),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (id, user_id),
    UNIQUE (
      user_id, interaction_id, interaction_version,
      mapping_version, evidence_digest
    ),
    FOREIGN KEY (relationship_id, user_id)
      REFERENCES dc_relationships(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (interaction_id, user_id)
      REFERENCES dc_interactions(id, user_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_dc_subject_suggestion_batches_interaction
    ON dc_subject_suggestion_batches(user_id, interaction_id, created_at DESC);
`;

const DATE_COMPANION_SCHEMA_V8 = `
  CREATE TABLE dc_proactive_value_cache (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('current_interaction', 'person_relationship')),
    relationship_id TEXT NOT NULL,
    interaction_id TEXT,
    person_id TEXT,
    mapping_version INTEGER NOT NULL CHECK (mapping_version >= 1),
    source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) = 64),
    contract_version INTEGER NOT NULL CHECK (contract_version = 1),
    provider TEXT NOT NULL CHECK (provider IN ('deepseek', 'none')),
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('processing', 'generated', 'fallback')),
    payload_json TEXT,
    failure_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (id, user_id),
    UNIQUE (user_id, source_fingerprint),
    CHECK (
      (scope = 'current_interaction' AND interaction_id IS NOT NULL AND person_id IS NULL) OR
      (scope = 'person_relationship' AND interaction_id IS NULL AND person_id IS NOT NULL)
    ),
    CHECK (
      (status = 'processing' AND payload_json IS NULL AND completed_at IS NULL) OR
      (status IN ('generated', 'fallback') AND payload_json IS NOT NULL AND completed_at IS NOT NULL)
    ),
    FOREIGN KEY (relationship_id, user_id)
      REFERENCES dc_relationships(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (interaction_id, user_id)
      REFERENCES dc_interactions(id, user_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_dc_proactive_value_scope
    ON dc_proactive_value_cache(user_id, scope, relationship_id, updated_at DESC);
`;

const DATE_COMPANION_SCHEMA_V9 = `
  ALTER TABLE dc_proactive_value_cache ADD COLUMN claim_token TEXT;
  ALTER TABLE dc_proactive_value_cache ADD COLUMN lease_expires_at TEXT;
  ALTER TABLE dc_proactive_value_cache
    ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
`;

const DATE_COMPANION_SCHEMA_V10 = `
  CREATE TABLE dc_subject_suggestion_claims (
    user_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    interaction_version INTEGER NOT NULL CHECK (interaction_version >= 0),
    mapping_version INTEGER NOT NULL CHECK (mapping_version >= 1),
    evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
    claim_token TEXT NOT NULL CHECK (length(claim_token) > 0),
    lease_expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (
      user_id, interaction_id, interaction_version,
      mapping_version, evidence_digest
    ),
    FOREIGN KEY (relationship_id, user_id)
      REFERENCES dc_relationships(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (interaction_id, user_id)
      REFERENCES dc_interactions(id, user_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_dc_subject_suggestion_claims_lease
    ON dc_subject_suggestion_claims(lease_expires_at, updated_at);
`;

const DATE_COMPANION_SCHEMA_V11 = `
  CREATE TABLE dc_relationship_reconfirmation_authorizations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    person_relationship_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action = 'reconfirm_archived_relationship'),
    idempotency_key TEXT NOT NULL,
    epoch INTEGER NOT NULL CHECK (epoch >= 1),
    expected_admission_version INTEGER NOT NULL CHECK (expected_admission_version >= 1),
    expected_self_binding_version INTEGER NOT NULL CHECK (expected_self_binding_version >= 1),
    mapping_version INTEGER NOT NULL CHECK (mapping_version >= 1),
    interaction_version INTEGER NOT NULL CHECK (interaction_version >= 0),
    batch_id TEXT NOT NULL,
    evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
    proposal_digest TEXT NOT NULL CHECK (length(proposal_digest) = 64),
    confirmation_fingerprint TEXT NOT NULL CHECK (length(confirmation_fingerprint) = 64),
    status TEXT NOT NULL CHECK (status IN ('authorized', 'consumed', 'cancelled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    consumed_at TEXT,
    UNIQUE (id, user_id),
    UNIQUE (user_id, idempotency_key),
    UNIQUE (user_id, relationship_id, epoch),
    CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
    FOREIGN KEY (relationship_id, user_id)
      REFERENCES dc_relationships(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (interaction_id, user_id)
      REFERENCES dc_interactions(id, user_id) ON DELETE CASCADE
  );

  CREATE UNIQUE INDEX idx_dc_relationship_reconfirmation_active
    ON dc_relationship_reconfirmation_authorizations(user_id, relationship_id)
    WHERE status = 'authorized';
`;

const MIGRATIONS = [
  { version: 1, sql: DATE_COMPANION_SCHEMA_V1 },
  { version: 2, sql: DATE_COMPANION_SCHEMA_V2 },
  { version: 3, sql: DATE_COMPANION_SCHEMA_V3 },
  { version: 4, sql: DATE_COMPANION_SCHEMA_V4 },
  { version: 5, sql: DATE_COMPANION_SCHEMA_V5 },
  { version: 6, sql: DATE_COMPANION_SCHEMA_V6 },
  { version: 7, sql: DATE_COMPANION_SCHEMA_V7 },
  { version: 8, sql: DATE_COMPANION_SCHEMA_V8 },
  { version: 9, sql: DATE_COMPANION_SCHEMA_V9 },
  { version: 10, sql: DATE_COMPANION_SCHEMA_V10 },
  { version: 11, sql: DATE_COMPANION_SCHEMA_V11 }
] as const;

function backfillEvidenceProvenance(database: Database.Database) {
  const rows = database.prepare(`
    SELECT id, user_id, upload_id, source_segment_id, start_seconds, end_seconds,
           speaker_id, quote, content_digest
    FROM dc_evidence_snapshots
    ORDER BY user_id, upload_id, source_segment_id, id
  `).all() as Array<{
    id: string;
    user_id: string;
    upload_id: string;
    source_segment_id: string;
    start_seconds: number;
    end_seconds: number;
    speaker_id: string | null;
    quote: string;
    content_digest: string | null;
  }>;
  const update = database.prepare(`
    UPDATE dc_evidence_snapshots
    SET provenance_version = ?, source_kind = ?, content_digest = ?
    WHERE id = ?
  `);
  const digestBySource = new Map<string, string>();
  for (const row of rows) {
    const digest = dateCompanionEvidenceDigest({
      userId: row.user_id,
      uploadId: row.upload_id,
      sourceSegmentId: row.source_segment_id,
      startSeconds: row.start_seconds,
      endSeconds: row.end_seconds,
      speakerId: row.speaker_id,
      quote: row.quote
    });
    if (row.content_digest !== null && row.content_digest !== digest) {
      throw new Error("date_companion_evidence_digest_conflict");
    }
    const sourceKey = `${row.user_id}\u0000${row.upload_id}\u0000${row.source_segment_id}`;
    const existing = digestBySource.get(sourceKey);
    if (existing && existing !== digest) {
      throw new Error("date_companion_evidence_source_conflict");
    }
    digestBySource.set(sourceKey, digest);
    update.run(DC_EVIDENCE_PROVENANCE_VERSION, DC_EVIDENCE_SOURCE_KIND, digest, row.id);
  }
}

export function migrateDateCompanionSchema(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS dc_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const hasMigration = database.prepare(
    "SELECT 1 FROM dc_schema_migrations WHERE version = ?"
  );
  const recordMigration = database.prepare(
    "INSERT INTO dc_schema_migrations (version, applied_at) VALUES (?, ?)"
  );

  for (const migration of MIGRATIONS) {
    if (hasMigration.get(migration.version)) continue;
    database.transaction(() => {
      database.exec(migration.sql);
      if (migration.version === 6) backfillEvidenceProvenance(database);
      recordMigration.run(migration.version, new Date().toISOString());
    })();
  }
}
