import type Database from "better-sqlite3";

export const DATE_COMPANION_SCHEMA_VERSION = 5;

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

const MIGRATIONS = [
  { version: 1, sql: DATE_COMPANION_SCHEMA_V1 },
  { version: 2, sql: DATE_COMPANION_SCHEMA_V2 },
  { version: 3, sql: DATE_COMPANION_SCHEMA_V3 },
  { version: 4, sql: DATE_COMPANION_SCHEMA_V4 },
  { version: 5, sql: DATE_COMPANION_SCHEMA_V5 }
] as const;

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
      recordMigration.run(migration.version, new Date().toISOString());
    })();
  }
}
