import type Database from "better-sqlite3";

export const DATE_COMPANION_SCHEMA_VERSION = 2;

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

const MIGRATIONS = [
  { version: 1, sql: DATE_COMPANION_SCHEMA_V1 },
  { version: 2, sql: DATE_COMPANION_SCHEMA_V2 }
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
