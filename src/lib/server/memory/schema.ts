import type Database from "better-sqlite3";

export const MEMORY_SCHEMA_VERSION = 3;

const MEMORY_SCHEMA_V1 = `
  CREATE TABLE memory_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('event', 'commitment', 'question', 'relationship_signal', 'preference', 'summary')),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
    date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE memory_evidence (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('transcript', 'brief', 'timeline', 'audio_insight', 'relationship_signal')),
    source_id TEXT NOT NULL,
    upload_id TEXT NOT NULL,
    date TEXT NOT NULL,
    quote TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
  );

  CREATE INDEX idx_memory_items_user_date ON memory_items(user_id, date DESC);
  CREATE INDEX idx_memory_items_user_type_date ON memory_items(user_id, type, date DESC);
  CREATE INDEX idx_memory_evidence_memory ON memory_evidence(memory_id);
  CREATE INDEX idx_memory_evidence_upload ON memory_evidence(upload_id);
`;

const MEMORY_SCHEMA_V2 = `
  ALTER TABLE memory_items ADD COLUMN importance_score REAL NOT NULL DEFAULT 0.5
    CHECK (importance_score >= 0 AND importance_score <= 1);
  ALTER TABLE memory_items ADD COLUMN importance_reason TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE memory_items ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'resolved', 'expired', 'superseded'));
  ALTER TABLE memory_items ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1
    CHECK (occurrence_count >= 1);
  ALTER TABLE memory_items ADD COLUMN first_seen_date TEXT NOT NULL DEFAULT '';
  ALTER TABLE memory_items ADD COLUMN last_seen_date TEXT NOT NULL DEFAULT '';
  ALTER TABLE memory_items ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0
    CHECK (access_count >= 0);
  ALTER TABLE memory_items ADD COLUMN last_accessed_at TEXT;

  UPDATE memory_items
  SET importance_score = importance,
      first_seen_date = date,
      last_seen_date = date;

  CREATE TABLE memory_relations (
    id TEXT PRIMARY KEY,
    source_memory_id TEXT NOT NULL,
    target_memory_id TEXT NOT NULL,
    relation_type TEXT NOT NULL CHECK (relation_type IN ('related', 'repeated', 'resolved_by', 'contradicted_by', 'follow_up')),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    created_at TEXT NOT NULL,
    FOREIGN KEY (source_memory_id) REFERENCES memory_items(id) ON DELETE CASCADE,
    FOREIGN KEY (target_memory_id) REFERENCES memory_items(id) ON DELETE CASCADE,
    CHECK (source_memory_id <> target_memory_id)
  );

  CREATE UNIQUE INDEX idx_memory_relations_unique
    ON memory_relations(source_memory_id, target_memory_id, relation_type);
  CREATE INDEX idx_memory_relations_source ON memory_relations(source_memory_id);
  CREATE INDEX idx_memory_relations_target ON memory_relations(target_memory_id);
  CREATE INDEX idx_memory_items_user_status_importance
    ON memory_items(user_id, status, importance_score DESC);
`;

const MEMORY_SCHEMA_V3 = `
  CREATE TABLE memory_owner_observations (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    upload_id TEXT NOT NULL,
    owner_scope TEXT NOT NULL CHECK (owner_scope IN ('individual', 'shared', 'unknown')),
    owner_type TEXT NOT NULL CHECK (owner_type IN ('known_identity', 'local_speaker', 'unknown')),
    identity_id TEXT,
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    source TEXT NOT NULL CHECK (source IN ('speaker_identity', 'manual_mapping', 'explicit_statement', 'unknown')),
    participants_json TEXT NOT NULL DEFAULT '[]',
    evidence_segment_ids_json TEXT NOT NULL DEFAULT '[]',
    reasons_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
  );

  CREATE INDEX idx_memory_owner_observations_memory
    ON memory_owner_observations(memory_id);
  CREATE INDEX idx_memory_owner_observations_upload
    ON memory_owner_observations(upload_id);
`;

const MIGRATIONS = [
  { version: 1, sql: MEMORY_SCHEMA_V1 },
  { version: 2, sql: MEMORY_SCHEMA_V2 },
  { version: 3, sql: MEMORY_SCHEMA_V3 }
] as const;

export function migrateMemorySchema(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const hasMigration = database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
  const recordMigration = database.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
  );

  for (const migration of MIGRATIONS) {
    if (hasMigration.get(migration.version)) {
      continue;
    }
    database.transaction(() => {
      database.exec(migration.sql);
      recordMigration.run(migration.version, new Date().toISOString());
    })();
  }
}
