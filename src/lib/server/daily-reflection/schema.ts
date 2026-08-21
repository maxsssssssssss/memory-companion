import type Database from "better-sqlite3";

export const DAILY_REFLECTION_SCHEMA_VERSION = 8;

// Version one intentionally represents the pre-provenance workflow shape.
// Version two adds source_origin with a fail-closed legacy backfill and the
// persisted processing plan.
const DAILY_REFLECTION_SCHEMA_V1 = `
  CREATE TABLE dr_reflections (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    upload_id TEXT,
    input_method TEXT NOT NULL
      CHECK (input_method IN ('file_upload', 'browser_recording')),
    processing_profile TEXT NOT NULL
      CHECK (processing_profile IN ('full_recording', 'quick_reflection')),
    ingestion_context TEXT NOT NULL
      CHECK (ingestion_context = 'daily_reflection'),
    status TEXT NOT NULL
      CHECK (status IN (
        'created', 'uploading', 'transcribing', 'extracting',
        'review_pending', 'failed', 'cancelled', 'deleted'
      )),
    version INTEGER NOT NULL CHECK (version >= 0),
    idempotency_key TEXT,
    create_fingerprint TEXT NOT NULL,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    UNIQUE (account_id, idempotency_key)
  );

  CREATE INDEX idx_dr_reflections_account_updated
    ON dr_reflections(account_id, updated_at DESC, id);

  CREATE TABLE dr_candidates (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    proposed_text TEXT NOT NULL CHECK (length(trim(proposed_text)) > 0),
    user_text TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'kept', 'excluded')),
    candidate_type TEXT NOT NULL
      CHECK (candidate_type IN ('event', 'commitment', 'question', 'preference', 'summary')),
    subject_person_id TEXT,
    subject_confirmed INTEGER NOT NULL CHECK (subject_confirmed IN (0, 1)),
    version INTEGER NOT NULL CHECK (version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    UNIQUE (account_id, reflection_id, ordinal),
    CHECK (subject_confirmed = 0 OR subject_person_id IS NOT NULL),
    FOREIGN KEY (reflection_id, account_id)
      REFERENCES dr_reflections(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_dr_candidates_reflection_order
    ON dr_candidates(account_id, reflection_id, ordinal, id);

  CREATE TABLE dr_candidate_sources (
    account_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    source_segment_id TEXT NOT NULL CHECK (length(trim(source_segment_id)) > 0),
    PRIMARY KEY (account_id, candidate_id, position),
    UNIQUE (account_id, candidate_id, source_segment_id),
    FOREIGN KEY (candidate_id, account_id)
      REFERENCES dr_candidates(id, account_id) ON DELETE CASCADE
  );
`;

const DAILY_REFLECTION_SCHEMA_V2 = `
  ALTER TABLE dr_reflections
    ADD COLUMN source_origin TEXT NOT NULL DEFAULT 'legacy_unknown'
      CHECK (source_origin IN (
        'direct_conversation', 'user_reflection', 'manual_note',
        'ai_derived_observation', 'unknown', 'legacy_unknown'
      ));

  CREATE UNIQUE INDEX idx_dr_reflections_account_upload
    ON dr_reflections(account_id, upload_id)
    WHERE upload_id IS NOT NULL;

  CREATE UNIQUE INDEX idx_dr_reflections_plan_binding
    ON dr_reflections(
      id, account_id, upload_id, input_method, source_origin,
      processing_profile, ingestion_context
    );

  CREATE TABLE dr_processing_plans (
    reflection_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    upload_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL CHECK (plan_version = 1),
    input_method TEXT NOT NULL
      CHECK (input_method IN ('file_upload', 'browser_recording')),
    source_origin TEXT NOT NULL
      CHECK (source_origin IN (
        'direct_conversation', 'user_reflection', 'manual_note',
        'ai_derived_observation', 'unknown', 'legacy_unknown'
      )),
    processing_profile TEXT NOT NULL
      CHECK (processing_profile IN ('full_recording', 'quick_reflection')),
    ingestion_context TEXT NOT NULL
      CHECK (ingestion_context IN ('standard_upload', 'date_companion', 'daily_reflection')),
    review_policy TEXT NOT NULL CHECK (review_policy = 'required'),
    PRIMARY KEY (account_id, reflection_id),
    UNIQUE (account_id, upload_id),
    FOREIGN KEY (
      reflection_id, account_id, upload_id, input_method, source_origin,
      processing_profile, ingestion_context
    ) REFERENCES dr_reflections(
      id, account_id, upload_id, input_method, source_origin,
      processing_profile, ingestion_context
    ) ON DELETE CASCADE
  );

  CREATE TRIGGER dr_candidates_proposed_text_immutable
  BEFORE UPDATE OF proposed_text ON dr_candidates
  WHEN NEW.proposed_text IS NOT OLD.proposed_text
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_candidate_proposed_text_immutable');
  END;
`;

const DAILY_REFLECTION_SCHEMA_V3 = `
  ALTER TABLE dr_reflections ADD COLUMN lease_owner TEXT;
  ALTER TABLE dr_reflections ADD COLUMN lease_until TEXT;
  ALTER TABLE dr_reflections ADD COLUMN upload_fingerprint TEXT;
  ALTER TABLE dr_reflections
    ADD COLUMN attempt_version INTEGER NOT NULL DEFAULT 0
      CHECK (attempt_version >= 0);

  CREATE INDEX idx_dr_reflections_active_lease
    ON dr_reflections(lease_until, lease_owner)
    WHERE lease_owner IS NOT NULL;
`;

const DAILY_REFLECTION_SCHEMA_V4 = `
  CREATE TABLE dr_asset_publications (
    account_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    asset_kind TEXT NOT NULL CHECK (asset_kind IN ('upload', 'segments')),
    attempt_version INTEGER NOT NULL CHECK (attempt_version > 0),
    payload_json TEXT NOT NULL,
    published_at TEXT NOT NULL,
    PRIMARY KEY (account_id, reflection_id, asset_kind),
    FOREIGN KEY (reflection_id, account_id)
      REFERENCES dr_reflections(id, account_id) ON DELETE CASCADE
  );
`;

const DAILY_REFLECTION_SCHEMA_V5 = `
  ALTER TABLE dr_reflections ADD COLUMN review_status TEXT
    CHECK (review_status IN (
      'confirmation_ready', 'admitting', 'completed', 'admission_failed'
    ));

  CREATE TABLE dr_reflection_confirmations (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    confirmation_fingerprint TEXT NOT NULL,
    source_origin TEXT NOT NULL,
    input_method TEXT NOT NULL,
    processing_profile TEXT NOT NULL,
    candidate_snapshots_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    UNIQUE (account_id, reflection_id),
    UNIQUE (account_id, idempotency_key),
    FOREIGN KEY (reflection_id, account_id)
      REFERENCES dr_reflections(id, account_id) ON DELETE CASCADE
  );

  CREATE TABLE dr_admission_operations (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    confirmation_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'confirmation_ready', 'admitting', 'completed',
      'admission_failed', 'delete_requested'
    )),
    admitted_count INTEGER NOT NULL DEFAULT 0 CHECK (admitted_count >= 0),
    rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
    excluded_count INTEGER NOT NULL DEFAULT 0 CHECK (excluded_count >= 0),
    error_code TEXT,
    attempt_version INTEGER NOT NULL DEFAULT 0 CHECK (attempt_version >= 0),
    lease_owner TEXT,
    lease_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (id, account_id),
    UNIQUE (account_id, reflection_id),
    UNIQUE (account_id, confirmation_id),
    UNIQUE (id, account_id, reflection_id, confirmation_id),
    CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
    FOREIGN KEY (reflection_id, account_id)
      REFERENCES dr_reflections(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (confirmation_id, account_id)
      REFERENCES dr_reflection_confirmations(id, account_id) ON DELETE CASCADE
  );

  CREATE TABLE dr_candidate_admission_receipts (
    account_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    confirmation_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'admitted', 'rejected', 'already_admitted', 'retryable_error'
    )),
    memory_id TEXT,
    reason_code TEXT,
    error_code TEXT,
    operation_key TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, operation_id, candidate_id),
    UNIQUE (account_id, operation_key),
    CHECK ((status IN ('admitted', 'already_admitted')) = (memory_id IS NOT NULL)),
    CHECK ((status = 'rejected') = (reason_code IS NOT NULL)),
    CHECK ((status = 'retryable_error') = (error_code IS NOT NULL)),
    FOREIGN KEY (operation_id, account_id, reflection_id, confirmation_id)
      REFERENCES dr_admission_operations(
        id, account_id, reflection_id, confirmation_id
      ) ON DELETE CASCADE,
    FOREIGN KEY (candidate_id, account_id)
      REFERENCES dr_candidates(id, account_id) ON DELETE CASCADE
  );

  CREATE TRIGGER dr_admission_receipt_candidate_scope_insert
  BEFORE INSERT ON dr_candidate_admission_receipts
  WHEN NOT EXISTS (
    SELECT 1 FROM dr_candidates candidate
    WHERE candidate.id = NEW.candidate_id
      AND candidate.account_id = NEW.account_id
      AND candidate.reflection_id = NEW.reflection_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_admission_receipt_scope_mismatch');
  END;

  CREATE TRIGGER dr_admission_receipt_candidate_scope_update
  BEFORE UPDATE ON dr_candidate_admission_receipts
  WHEN NOT EXISTS (
    SELECT 1 FROM dr_candidates candidate
    WHERE candidate.id = NEW.candidate_id
      AND candidate.account_id = NEW.account_id
      AND candidate.reflection_id = NEW.reflection_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_admission_receipt_scope_mismatch');
  END;

  CREATE TRIGGER dr_reflection_confirmations_immutable
  BEFORE UPDATE ON dr_reflection_confirmations
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_confirmation_immutable');
  END;

  CREATE TRIGGER dr_candidates_locked_after_confirmation
  BEFORE UPDATE ON dr_candidates
  WHEN EXISTS (
    SELECT 1 FROM dr_reflection_confirmations confirmation
    WHERE confirmation.account_id = OLD.account_id
      AND confirmation.reflection_id = OLD.reflection_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_candidate_finalized');
  END;

  CREATE TRIGGER dr_candidates_delete_locked_after_confirmation
  BEFORE DELETE ON dr_candidates
  WHEN EXISTS (
    SELECT 1 FROM dr_reflection_confirmations confirmation
    WHERE confirmation.account_id = OLD.account_id
      AND confirmation.reflection_id = OLD.reflection_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_candidate_finalized');
  END;
`;

const DAILY_REFLECTION_SCHEMA_V6 = `
  CREATE TABLE dr_candidate_revocation_operations (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    confirmation_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    admission_status TEXT NOT NULL CHECK (admission_status IN (
      'admitted', 'already_admitted', 'rejected', 'no_receipt'
    )),
    memory_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('ready', 'revoking', 'completed', 'failed')),
    attempt_version INTEGER NOT NULL DEFAULT 0 CHECK (attempt_version >= 0),
    lease_owner TEXT,
    lease_until TEXT,
    error_code TEXT,
    index_refresh_status TEXT NOT NULL DEFAULT 'not_required' CHECK (
      index_refresh_status IN ('not_required', 'pending', 'enqueued', 'failed')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (id, account_id),
    UNIQUE (account_id, operation_key),
    UNIQUE (account_id, idempotency_key),
    UNIQUE (account_id, reflection_id, candidate_id),
    CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
    CHECK ((admission_status IN ('admitted', 'already_admitted')) = (memory_id IS NOT NULL)),
    FOREIGN KEY (reflection_id, account_id)
      REFERENCES dr_reflections(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (confirmation_id, account_id)
      REFERENCES dr_reflection_confirmations(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (candidate_id, account_id)
      REFERENCES dr_candidates(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_dr_candidate_revocation_claim
    ON dr_candidate_revocation_operations(status, lease_until, updated_at);

  CREATE TABLE dr_candidate_revocation_receipts (
    account_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    confirmation_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('revoked', 'no_long_term_object')),
    memory_id TEXT,
    removed_memory_evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (
      removed_memory_evidence_count >= 0
    ),
    removed_person_source_count INTEGER NOT NULL DEFAULT 0 CHECK (
      removed_person_source_count >= 0
    ),
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, operation_id),
    UNIQUE (account_id, reflection_id, candidate_id),
    FOREIGN KEY (operation_id, account_id)
      REFERENCES dr_candidate_revocation_operations(id, account_id) ON DELETE CASCADE
  );

  CREATE TRIGGER dr_candidate_revocation_receipts_immutable
  BEFORE UPDATE ON dr_candidate_revocation_receipts
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_revocation_receipt_immutable');
  END;
`;

const DAILY_REFLECTION_SCHEMA_V7 = `
  CREATE TABLE dr_v2_reflection_inputs (
    account_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    contract_fingerprint TEXT NOT NULL CHECK (length(contract_fingerprint) = 64),
    input_adapter TEXT NOT NULL CHECK (
      input_adapter IN ('file_picker', 'browser_recorder', 'toy_sync')
    ),
    source_origin TEXT NOT NULL CHECK (
      source_origin IN ('user_reflection', 'direct_conversation')
    ),
    capture_purpose TEXT NOT NULL CHECK (capture_purpose = 'inspiration_capture'),
    recording_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, reflection_id),
    UNIQUE (account_id, operation_key),
    FOREIGN KEY (reflection_id, account_id)
      REFERENCES dr_reflections(id, account_id) ON DELETE CASCADE
  );

  CREATE TABLE dr_candidate_v2_metadata (
    account_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    candidate_kind TEXT NOT NULL CHECK (
      candidate_kind IN ('insight', 'open_question', 'decision', 'user_action')
    ),
    evidence_ids_json TEXT NOT NULL CHECK (json_valid(evidence_ids_json)),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    caution TEXT NOT NULL CHECK (length(trim(caution)) > 0),
    action_claimed INTEGER NOT NULL CHECK (action_claimed IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, candidate_id),
    FOREIGN KEY (candidate_id, account_id)
      REFERENCES dr_candidates(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (reflection_id, account_id)
      REFERENCES dr_reflections(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_dr_candidate_v2_reflection
    ON dr_candidate_v2_metadata(account_id, reflection_id, candidate_id);

  ALTER TABLE dr_reflection_confirmations
    ADD COLUMN contract_version INTEGER NOT NULL DEFAULT 1
      CHECK (contract_version IN (1, 2));
  ALTER TABLE dr_reflection_confirmations
    ADD COLUMN save_intent TEXT CHECK (
      save_intent IS NULL OR save_intent IN ('recap_only', 'retain_selected')
    );
  ALTER TABLE dr_reflection_confirmations ADD COLUMN operation_key TEXT;
  ALTER TABLE dr_reflection_confirmations
    ADD COLUMN input_adapter TEXT CHECK (
      input_adapter IS NULL OR input_adapter IN ('file_picker', 'browser_recorder', 'toy_sync')
    );
  ALTER TABLE dr_reflection_confirmations
    ADD COLUMN capture_purpose TEXT CHECK (
      capture_purpose IS NULL OR capture_purpose = 'inspiration_capture'
    );
  ALTER TABLE dr_reflection_confirmations ADD COLUMN recording_date TEXT;

  CREATE UNIQUE INDEX idx_dr_confirmation_v2_operation
    ON dr_reflection_confirmations(account_id, operation_key)
    WHERE operation_key IS NOT NULL;

  CREATE TRIGGER dr_candidate_v2_scope_insert
  BEFORE INSERT ON dr_candidate_v2_metadata
  WHEN NOT EXISTS (
    SELECT 1 FROM dr_candidates candidate
    WHERE candidate.id = NEW.candidate_id
      AND candidate.account_id = NEW.account_id
      AND candidate.reflection_id = NEW.reflection_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_v2_candidate_scope_mismatch');
  END;

  CREATE TRIGGER dr_candidate_v2_scope_update
  BEFORE UPDATE ON dr_candidate_v2_metadata
  WHEN NOT EXISTS (
    SELECT 1 FROM dr_candidates candidate
    WHERE candidate.id = NEW.candidate_id
      AND candidate.account_id = NEW.account_id
      AND candidate.reflection_id = NEW.reflection_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_v2_candidate_scope_mismatch');
  END;

  CREATE TRIGGER dr_v2_reflection_inputs_immutable
  BEFORE UPDATE ON dr_v2_reflection_inputs
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_v2_input_immutable');
  END;

  CREATE TRIGGER dr_confirmation_v2_contract_insert
  BEFORE INSERT ON dr_reflection_confirmations
  WHEN (
    NEW.contract_version = 2 AND (
      NEW.save_intent IS NULL OR NEW.operation_key IS NULL
      OR NEW.input_adapter IS NULL OR NEW.capture_purpose IS NULL
      OR NEW.recording_date IS NULL
    )
  ) OR (
    NEW.contract_version = 1 AND (
      NEW.save_intent IS NOT NULL OR NEW.operation_key IS NOT NULL
      OR NEW.input_adapter IS NOT NULL OR NEW.capture_purpose IS NOT NULL
      OR NEW.recording_date IS NOT NULL
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_confirmation_contract_mismatch');
  END;

  CREATE TRIGGER dr_candidate_v2_metadata_locked_insert_after_confirmation
  BEFORE INSERT ON dr_candidate_v2_metadata
  WHEN EXISTS (
    SELECT 1 FROM dr_reflection_confirmations confirmation
    WHERE confirmation.account_id = NEW.account_id
      AND confirmation.reflection_id = NEW.reflection_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_candidate_finalized');
  END;

  CREATE TRIGGER dr_candidate_v2_metadata_locked_after_confirmation
  BEFORE UPDATE ON dr_candidate_v2_metadata
  WHEN EXISTS (
    SELECT 1 FROM dr_reflection_confirmations confirmation
    WHERE confirmation.account_id = OLD.account_id
      AND confirmation.reflection_id = OLD.reflection_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_candidate_finalized');
  END;

  CREATE TRIGGER dr_candidate_v2_metadata_locked_delete_after_confirmation
  BEFORE DELETE ON dr_candidate_v2_metadata
  WHEN EXISTS (
    SELECT 1 FROM dr_reflection_confirmations confirmation
    WHERE confirmation.account_id = OLD.account_id
      AND confirmation.reflection_id = OLD.reflection_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_candidate_finalized');
  END;
`;

// V2 keeps the frozen V1 ProcessingPlan row as its relational binding and
// stores the additional server-authoritative input contract in one immutable
// extension row. The operation receipt is also immutable: progress remains in
// the reflection/job records, while replay identity cannot drift.
const DAILY_REFLECTION_SCHEMA_V8 = `
  CREATE TABLE dr_v2_input_receipts (
    account_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    capture_purpose TEXT NOT NULL CHECK (capture_purpose = 'inspiration_capture'),
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    upload_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, reflection_id),
    UNIQUE (account_id, capture_purpose, operation_key),
    FOREIGN KEY (account_id, reflection_id)
      REFERENCES dr_v2_reflection_inputs(account_id, reflection_id) ON DELETE CASCADE
  );

  CREATE TABLE dr_processing_plans_v2 (
    account_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL CHECK (plan_version = 2),
    input_adapter TEXT NOT NULL CHECK (
      input_adapter IN ('file_picker', 'browser_recorder', 'toy_sync')
    ),
    capture_purpose TEXT NOT NULL CHECK (capture_purpose = 'inspiration_capture'),
    effective_duration_ms INTEGER NOT NULL CHECK (effective_duration_ms > 0),
    duration_source TEXT NOT NULL CHECK (duration_source = 'server_ffprobe'),
    candidate_limit INTEGER NOT NULL CHECK (candidate_limit BETWEEN 1 AND 7),
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, reflection_id),
    FOREIGN KEY (account_id, reflection_id)
      REFERENCES dr_processing_plans(account_id, reflection_id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, reflection_id)
      REFERENCES dr_v2_reflection_inputs(account_id, reflection_id) ON DELETE CASCADE
  );

  CREATE TABLE dr_candidate_v2_review_exclusion_events (
    id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    event_kind TEXT NOT NULL CHECK (event_kind IN ('excluded', 'restored')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, id),
    FOREIGN KEY (candidate_id, account_id)
      REFERENCES dr_candidates(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (reflection_id, account_id)
      REFERENCES dr_reflections(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_dr_candidate_v2_review_exclusion
    ON dr_candidate_v2_review_exclusion_events(
      account_id, reflection_id, candidate_id, created_at, id
    );

  CREATE TRIGGER dr_v2_input_receipts_immutable
  BEFORE UPDATE ON dr_v2_input_receipts
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_v2_receipt_immutable');
  END;

  CREATE TRIGGER dr_processing_plans_v2_immutable
  BEFORE UPDATE ON dr_processing_plans_v2
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_v2_plan_immutable');
  END;

  CREATE TRIGGER dr_candidate_v2_review_exclusion_scope
  BEFORE INSERT ON dr_candidate_v2_review_exclusion_events
  WHEN NOT EXISTS (
    SELECT 1 FROM dr_candidates candidate
    WHERE candidate.id = NEW.candidate_id
      AND candidate.account_id = NEW.account_id
      AND candidate.reflection_id = NEW.reflection_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_v2_candidate_scope_mismatch');
  END;
`;

const MIGRATIONS = [
  { version: 1, sql: DAILY_REFLECTION_SCHEMA_V1 },
  { version: 2, sql: DAILY_REFLECTION_SCHEMA_V2 },
  { version: 3, sql: DAILY_REFLECTION_SCHEMA_V3 },
  { version: 4, sql: DAILY_REFLECTION_SCHEMA_V4 },
  { version: 5, sql: DAILY_REFLECTION_SCHEMA_V5 },
  { version: 6, sql: DAILY_REFLECTION_SCHEMA_V6 },
  { version: 7, sql: DAILY_REFLECTION_SCHEMA_V7 },
  { version: 8, sql: DAILY_REFLECTION_SCHEMA_V8 }
] as const;

export function migrateDailyReflectionSchema(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS dr_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const hasMigration = database.prepare(
    "SELECT 1 FROM dr_schema_migrations WHERE version = ?"
  );
  const recordMigration = database.prepare(
    "INSERT INTO dr_schema_migrations (version, applied_at) VALUES (?, ?)"
  );

  for (const migration of MIGRATIONS) {
    if (hasMigration.get(migration.version)) continue;
    const applyMigration = database.transaction(() => {
      if (hasMigration.get(migration.version)) return;
      database.exec(migration.sql);
      recordMigration.run(migration.version, new Date().toISOString());
      database.pragma(`user_version = ${migration.version}`);
    });
    applyMigration.immediate();
  }
}
