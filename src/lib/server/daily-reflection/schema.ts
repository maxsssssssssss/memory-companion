import type Database from "better-sqlite3";

export const DAILY_REFLECTION_SCHEMA_VERSION = 12;

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

// V9 adds a user-facing Card projection without changing the frozen Memory
// schema. Hidden extraction candidates and Card admission projections remain
// distinguishable and the existing admission foreign keys stay intact.
const DAILY_REFLECTION_SCHEMA_V9 = `
  CREATE TABLE dr_candidate_v2_roles (
    account_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    candidate_role TEXT NOT NULL CHECK (
      candidate_role IN ('hidden_extraction', 'card_projection')
    ),
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, candidate_id),
    FOREIGN KEY (candidate_id, account_id)
      REFERENCES dr_candidates(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (reflection_id, account_id)
      REFERENCES dr_reflections(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_dr_candidate_v2_role_reflection
    ON dr_candidate_v2_roles(account_id, reflection_id, candidate_role, candidate_id);

  CREATE TABLE dr_reflection_cards (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    card_kind TEXT NOT NULL CHECK (
      card_kind IN ('insight', 'open_question', 'decision', 'user_action')
    ),
    proposed_title TEXT NOT NULL CHECK (length(trim(proposed_title)) > 0),
    proposed_text TEXT NOT NULL CHECK (length(trim(proposed_text)) > 0),
    user_title TEXT,
    user_text TEXT,
    source_candidate_ids_json TEXT NOT NULL CHECK (json_valid(source_candidate_ids_json)),
    evidence_ids_json TEXT NOT NULL CHECK (json_valid(evidence_ids_json)),
    cluster_id TEXT NOT NULL CHECK (length(trim(cluster_id)) > 0),
    cluster_title TEXT NOT NULL CHECK (length(trim(cluster_title)) > 0),
    display_tier TEXT NOT NULL CHECK (display_tier IN ('primary', 'more')),
    rank INTEGER NOT NULL CHECK (rank >= 0),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
    durability REAL NOT NULL CHECK (durability >= 0 AND durability <= 1),
    novelty REAL NOT NULL CHECK (novelty >= 0 AND novelty <= 1),
    epistemic_status TEXT NOT NULL CHECK (
      epistemic_status IN (
        'explicit_user_statement', 'reported_event', 'ai_inference', 'unknown'
      )
    ),
    risk_flags_json TEXT NOT NULL CHECK (json_valid(risk_flags_json)),
    action_claimed INTEGER NOT NULL CHECK (action_claimed IN (0, 1)),
    review_status TEXT NOT NULL CHECK (
      review_status IN ('not_proposed', 'pending', 'kept', 'excluded')
    ),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    UNIQUE (account_id, reflection_id, rank),
    FOREIGN KEY (id, account_id)
      REFERENCES dr_candidates(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (reflection_id, account_id)
      REFERENCES dr_reflections(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_dr_reflection_cards_display
    ON dr_reflection_cards(account_id, reflection_id, display_tier, rank, id);

  CREATE TABLE dr_card_pipeline_runs (
    account_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    model_name TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
    window_count INTEGER NOT NULL CHECK (window_count > 0),
    provider_call_count INTEGER NOT NULL CHECK (provider_call_count > 0),
    hidden_candidate_count INTEGER NOT NULL CHECK (hidden_candidate_count > 0),
    cluster_count INTEGER NOT NULL CHECK (cluster_count > 0),
    card_count INTEGER NOT NULL CHECK (card_count > 0),
    input_token_estimate INTEGER NOT NULL CHECK (input_token_estimate >= 0),
    output_token_budget INTEGER NOT NULL CHECK (output_token_budget > 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, reflection_id),
    FOREIGN KEY (reflection_id, account_id)
      REFERENCES dr_reflections(id, account_id) ON DELETE CASCADE
  );

  CREATE TRIGGER dr_candidate_v2_role_scope_insert
  BEFORE INSERT ON dr_candidate_v2_roles
  WHEN NOT EXISTS (
    SELECT 1 FROM dr_candidates candidate
    WHERE candidate.id = NEW.candidate_id
      AND candidate.account_id = NEW.account_id
      AND candidate.reflection_id = NEW.reflection_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_v2_candidate_scope_mismatch');
  END;

  CREATE TRIGGER dr_reflection_cards_locked_after_confirmation
  BEFORE UPDATE ON dr_reflection_cards
  WHEN EXISTS (
    SELECT 1 FROM dr_reflection_confirmations confirmation
    WHERE confirmation.account_id = OLD.account_id
      AND confirmation.reflection_id = OLD.reflection_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_card_finalized');
  END;

  CREATE TRIGGER dr_reflection_cards_delete_locked_after_confirmation
  BEFORE DELETE ON dr_reflection_cards
  WHEN EXISTS (
    SELECT 1 FROM dr_reflection_confirmations confirmation
    WHERE confirmation.account_id = OLD.account_id
      AND confirmation.reflection_id = OLD.reflection_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_card_finalized');
  END;

  CREATE TRIGGER dr_card_pipeline_runs_immutable
  BEFORE UPDATE ON dr_card_pipeline_runs
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_card_pipeline_run_immutable');
  END;
`;

// V10 adds an account-scoped Working Card snapshot inside the Daily Reflection
// workflow database. It deliberately has no foreign key to transient
// Reflections or Candidates: saved Cards must survive Reflection deletion while
// retaining their original, immutable provenance ids.
const DAILY_REFLECTION_SCHEMA_V10 = `
  CREATE TABLE dr_working_cards (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    source_reflection_ids_json TEXT NOT NULL CHECK (json_valid(source_reflection_ids_json)),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    content TEXT NOT NULL CHECK (length(trim(content)) > 0),
    card_kind TEXT NOT NULL CHECK (
      card_kind IN ('idea', 'insight', 'question', 'decision', 'event', 'action')
    ),
    evidence_ids_json TEXT NOT NULL CHECK (json_valid(evidence_ids_json)),
    status TEXT NOT NULL CHECK (
      status IN ('generated', 'review_pending', 'saved', 'archived', 'removed')
    ),
    importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
    novelty REAL NOT NULL CHECK (novelty >= 0 AND novelty <= 1),
    related_card_ids_json TEXT NOT NULL CHECK (json_valid(related_card_ids_json)),
    tags_json TEXT NOT NULL CHECK (json_valid(tags_json)),
    visibility TEXT NOT NULL CHECK (visibility = 'private'),
    source_unavailable INTEGER NOT NULL DEFAULT 0 CHECK (source_unavailable IN (0, 1)),
    saved_at TEXT,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, account_id)
  );

  CREATE INDEX idx_dr_working_cards_library
    ON dr_working_cards(account_id, status, updated_at DESC, id);

  CREATE INDEX idx_dr_working_cards_kind_created
    ON dr_working_cards(account_id, card_kind, created_at DESC, id);

  CREATE TABLE dr_working_card_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (
      event_type IN ('saved', 'updated', 'archived', 'restored', 'removed', 'source_unavailable')
    ),
    from_status TEXT,
    to_status TEXT NOT NULL,
    card_version INTEGER NOT NULL CHECK (card_version >= 0),
    created_at TEXT NOT NULL,
    FOREIGN KEY (card_id, account_id)
      REFERENCES dr_working_cards(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_dr_working_card_events_card
    ON dr_working_card_events(account_id, card_id, event_id);

  INSERT INTO dr_working_cards (
    id, account_id, source_reflection_ids_json, title, content, card_kind,
    evidence_ids_json, status, importance, novelty, related_card_ids_json,
    tags_json, visibility, source_unavailable, saved_at, version,
    created_at, updated_at
  )
  SELECT
    card.id,
    card.account_id,
    json_array(card.reflection_id),
    COALESCE(NULLIF(trim(card.user_title), ''), card.proposed_title),
    COALESCE(NULLIF(trim(card.user_text), ''), card.proposed_text),
    CASE card.card_kind
      WHEN 'open_question' THEN 'question'
      WHEN 'user_action' THEN 'action'
      ELSE card.card_kind
    END,
    card.evidence_ids_json,
    CASE card.review_status
      WHEN 'not_proposed' THEN 'generated'
      WHEN 'pending' THEN 'review_pending'
      WHEN 'kept' THEN 'saved'
      ELSE 'removed'
    END,
    card.importance,
    card.novelty,
    json_array(),
    json_array(),
    'private',
    CASE WHEN reflection.status IN ('cancelled', 'deleted')
      OR NOT EXISTS (
        SELECT 1
        FROM dr_asset_publications AS publication
        WHERE publication.account_id = card.account_id
          AND publication.reflection_id = card.reflection_id
          AND publication.asset_kind = 'segments'
      )
      THEN 1 ELSE 0 END,
    CASE WHEN card.review_status = 'kept' THEN card.updated_at ELSE NULL END,
    0,
    card.created_at,
    card.updated_at
  FROM dr_reflection_cards AS card
  JOIN dr_reflections AS reflection
    ON reflection.id = card.reflection_id
   AND reflection.account_id = card.account_id
  WHERE card.review_status = 'kept'
     OR reflection.status NOT IN ('cancelled', 'deleted');
`;

// V11 adds a Daily Reflection-local proposal ledger between saved Working
// Cards and the existing Memory admission boundary. It freezes the reviewed
// Card and canonical Evidence snapshot used by policy evaluation; it neither
// changes the Memory schema nor duplicates the admission receipt.
const DAILY_REFLECTION_SCHEMA_V11 = `
  CREATE TABLE dr_memory_proposals (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0 AND length(title) <= 240),
    card_kind TEXT NOT NULL CHECK (
      card_kind IN ('idea', 'insight', 'question', 'decision', 'event', 'action')
    ),
    action_claimed INTEGER NOT NULL CHECK (action_claimed IN (0, 1)),
    memory_type TEXT NOT NULL CHECK (
      memory_type IN ('decision', 'commitment', 'preference', 'person_fact', 'event')
    ),
    content TEXT NOT NULL CHECK (
      length(trim(content)) > 0 AND length(content) <= 20000
    ),
    evidence_ids_json TEXT NOT NULL CHECK (
      json_valid(evidence_ids_json)
      AND json_type(evidence_ids_json) = 'array'
      AND json_array_length(evidence_ids_json) > 0
      AND json_array_length(evidence_ids_json) <= 64
    ),
    evidence_snapshots_json TEXT NOT NULL CHECK (
      json_valid(evidence_snapshots_json)
      AND json_type(evidence_snapshots_json) = 'array'
      AND json_array_length(evidence_snapshots_json) = json_array_length(evidence_ids_json)
    ),
    risk_flags_json TEXT NOT NULL CHECK (
      json_valid(risk_flags_json)
      AND json_type(risk_flags_json) = 'array'
      AND json_array_length(risk_flags_json) <= 8
    ),
    subject_person_id TEXT,
    importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
    durability REAL NOT NULL CHECK (durability >= 0 AND durability <= 1),
    novelty REAL NOT NULL CHECK (novelty >= 0 AND novelty <= 1),
    sensitivity REAL NOT NULL CHECK (sensitivity >= 0 AND sensitivity <= 1),
    epistemic_status TEXT NOT NULL CHECK (
      epistemic_status IN (
        'explicit_user_statement', 'reported_event', 'ai_inference', 'unknown'
      )
    ),
    epistemic_caution TEXT CHECK (
      epistemic_caution IS NULL OR epistemic_caution = 'reported_inference'
    ),
    status TEXT NOT NULL CHECK (
      status IN ('pending', 'approved', 'rejected', 'admitted')
    ),
    policy_version TEXT NOT NULL CHECK (
      length(trim(policy_version)) > 0 AND length(policy_version) <= 128
    ),
    score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
    reasons_json TEXT NOT NULL CHECK (
      json_valid(reasons_json)
      AND json_type(reasons_json) = 'array'
      AND json_array_length(reasons_json) <= 32
    ),
    operation_key TEXT NOT NULL CHECK (
      length(trim(operation_key)) > 0 AND length(operation_key) <= 512
      AND operation_key = 'daily-reflection-card:' || card_id
    ),
    request_fingerprint TEXT NOT NULL CHECK (
      length(request_fingerprint) = 64
      AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    memory_id TEXT,
    source_origin TEXT NOT NULL CHECK (
      source_origin IN ('user_reflection', 'direct_conversation')
    ),
    input_adapter TEXT NOT NULL CHECK (
      input_adapter IN ('file_picker', 'browser_recorder', 'toy_sync')
    ),
    capture_purpose TEXT NOT NULL CHECK (
      capture_purpose = 'inspiration_capture'
    ),
    recording_date TEXT NOT NULL CHECK (
      recording_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    ),
    created_by TEXT NOT NULL CHECK (created_by = 'user'),
    admission_method TEXT NOT NULL CHECK (
      admission_method = 'daily_reflection_memory_proposal_v1'
    ),
    card_version INTEGER NOT NULL CHECK (card_version >= 0),
    version INTEGER NOT NULL CHECK (version >= 0),
    lease_owner TEXT CHECK (
      lease_owner IS NULL OR (length(trim(lease_owner)) > 0 AND length(lease_owner) <= 512)
    ),
    lease_until TEXT,
    attempt_version INTEGER NOT NULL DEFAULT 0 CHECK (attempt_version >= 0),
    error_code TEXT CHECK (
      error_code IS NULL OR (length(trim(error_code)) > 0 AND length(error_code) <= 128)
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    admitted_at TEXT,
    UNIQUE (id, account_id),
    UNIQUE (account_id, card_id),
    UNIQUE (account_id, operation_key),
    FOREIGN KEY (card_id, account_id)
      REFERENCES dr_working_cards(id, account_id) ON DELETE RESTRICT,
    CHECK (
      (status = 'admitted' AND memory_id IS NOT NULL AND admitted_at IS NOT NULL)
      OR
      (status <> 'admitted' AND memory_id IS NULL AND admitted_at IS NULL)
    ),
    CHECK (status <> 'rejected' OR json_array_length(reasons_json) > 0),
    CHECK (
      (lease_owner IS NULL AND lease_until IS NULL)
      OR
      (lease_owner IS NOT NULL AND lease_until IS NOT NULL)
    ),
    CHECK (card_kind = 'action' OR action_claimed = 0),
    CHECK (
      status NOT IN ('approved', 'admitted')
      OR memory_type <> 'commitment'
      OR (card_kind = 'action' AND action_claimed = 1)
    ),
    CHECK (
      status NOT IN ('approved', 'admitted')
      OR memory_type <> 'person_fact'
      OR subject_person_id IS NOT NULL
    )
  );

  CREATE INDEX idx_dr_memory_proposals_status
    ON dr_memory_proposals(account_id, status, updated_at DESC, id);

  CREATE TABLE dr_memory_proposal_events (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    proposal_version INTEGER NOT NULL CHECK (proposal_version >= 0),
    event_type TEXT NOT NULL CHECK (
      event_type IN (
        'created', 'evaluated', 'admission_started', 'admission_failed',
        'admitted', 'recovered', 'revoked'
      )
    ),
    reason_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
      json_valid(reason_metadata_json)
      AND json_type(reason_metadata_json) = 'object'
    ),
    created_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    FOREIGN KEY (proposal_id, account_id)
      REFERENCES dr_memory_proposals(id, account_id) ON DELETE RESTRICT
  );

  CREATE INDEX idx_dr_memory_proposal_events_proposal
    ON dr_memory_proposal_events(account_id, proposal_id, created_at, id);
`;

// V12 closes the Working Card -> Durable Memory lifecycle without adding a
// second Memory delete system. The operation and immutable receipt only fence
// the cross-database orchestration; Existing Memory remains authoritative for
// the actual revocation, Evidence cleanup, publication and index lifecycle.
const DAILY_REFLECTION_SCHEMA_V12 = `
  ALTER TABLE dr_working_cards
    ADD COLUMN memory_lifecycle_status TEXT NOT NULL DEFAULT 'not_admitted'
      CHECK (memory_lifecycle_status IN (
        'not_admitted', 'active', 'revocation_requested', 'revoked'
      ));

  ALTER TABLE dr_working_cards
    ADD COLUMN memory_lifecycle_version INTEGER NOT NULL DEFAULT 0
      CHECK (memory_lifecycle_version >= 0);

  ALTER TABLE dr_working_cards
    ADD COLUMN memory_lifecycle_updated_at TEXT;

  UPDATE dr_working_cards
  SET memory_lifecycle_status = CASE
        WHEN EXISTS (
          SELECT 1 FROM dr_memory_proposals proposal
          WHERE proposal.account_id = dr_working_cards.account_id
            AND proposal.card_id = dr_working_cards.id
            AND proposal.status = 'admitted'
            AND EXISTS (
              SELECT 1 FROM dr_memory_proposal_events event
              WHERE event.account_id = proposal.account_id
                AND event.proposal_id = proposal.id
                AND event.event_type = 'revoked'
            )
        ) OR EXISTS (
          SELECT 1 FROM dr_candidate_revocation_receipts legacy_revocation
          WHERE legacy_revocation.account_id = dr_working_cards.account_id
            AND legacy_revocation.candidate_id = dr_working_cards.id
            AND legacy_revocation.outcome = 'revoked'
            AND EXISTS (
              SELECT 1 FROM json_each(
                dr_working_cards.source_reflection_ids_json
              ) source_reflection
              WHERE source_reflection.value = legacy_revocation.reflection_id
            )
        ) THEN 'revoked'
        WHEN EXISTS (
          SELECT 1 FROM dr_memory_proposals proposal
          WHERE proposal.account_id = dr_working_cards.account_id
            AND proposal.card_id = dr_working_cards.id
            AND proposal.status = 'admitted'
        ) OR EXISTS (
          SELECT 1 FROM dr_candidate_admission_receipts legacy_admission
          WHERE legacy_admission.account_id = dr_working_cards.account_id
            AND legacy_admission.candidate_id = dr_working_cards.id
            AND legacy_admission.status IN ('admitted', 'already_admitted')
            AND EXISTS (
              SELECT 1 FROM json_each(
                dr_working_cards.source_reflection_ids_json
              ) source_reflection
              WHERE source_reflection.value = legacy_admission.reflection_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM dr_candidate_revocation_receipts legacy_revocation
              WHERE legacy_revocation.account_id = legacy_admission.account_id
                AND legacy_revocation.candidate_id = legacy_admission.candidate_id
                AND legacy_revocation.reflection_id = legacy_admission.reflection_id
                AND legacy_revocation.outcome = 'revoked'
            )
        ) THEN 'active'
        ELSE 'not_admitted'
      END,
      memory_lifecycle_version = CASE
        WHEN EXISTS (
          SELECT 1 FROM dr_memory_proposals proposal
          WHERE proposal.account_id = dr_working_cards.account_id
            AND proposal.card_id = dr_working_cards.id
            AND proposal.status = 'admitted'
        ) OR EXISTS (
          SELECT 1 FROM dr_candidate_admission_receipts legacy_admission
          WHERE legacy_admission.account_id = dr_working_cards.account_id
            AND legacy_admission.candidate_id = dr_working_cards.id
            AND legacy_admission.status IN ('admitted', 'already_admitted')
            AND EXISTS (
              SELECT 1 FROM json_each(
                dr_working_cards.source_reflection_ids_json
              ) source_reflection
              WHERE source_reflection.value = legacy_admission.reflection_id
            )
        ) THEN 1 ELSE 0 END,
      memory_lifecycle_updated_at = COALESCE(
        (
          SELECT MAX(legacy_revocation.created_at)
          FROM dr_candidate_revocation_receipts legacy_revocation
          WHERE legacy_revocation.account_id = dr_working_cards.account_id
            AND legacy_revocation.candidate_id = dr_working_cards.id
            AND legacy_revocation.outcome = 'revoked'
            AND EXISTS (
              SELECT 1 FROM json_each(
                dr_working_cards.source_reflection_ids_json
              ) source_reflection
              WHERE source_reflection.value = legacy_revocation.reflection_id
            )
        ),
        (
          SELECT MAX(proposal.updated_at)
          FROM dr_memory_proposals proposal
          WHERE proposal.account_id = dr_working_cards.account_id
            AND proposal.card_id = dr_working_cards.id
            AND proposal.status = 'admitted'
        ),
        (
          SELECT MAX(legacy_admission.updated_at)
          FROM dr_candidate_admission_receipts legacy_admission
          WHERE legacy_admission.account_id = dr_working_cards.account_id
            AND legacy_admission.candidate_id = dr_working_cards.id
            AND legacy_admission.status IN ('admitted', 'already_admitted')
            AND EXISTS (
              SELECT 1 FROM json_each(
                dr_working_cards.source_reflection_ids_json
              ) source_reflection
              WHERE source_reflection.value = legacy_admission.reflection_id
            )
        )
      );

  CREATE TABLE dr_working_card_memory_revocation_operations (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    proposal_id TEXT,
    authority_confirmation_id TEXT,
    authority_memory_id TEXT,
    operation_key TEXT NOT NULL CHECK (
      operation_key = 'daily-reflection-card-revocation:' || card_id
    ),
    idempotency_key TEXT NOT NULL CHECK (
      length(trim(idempotency_key)) > 0 AND length(idempotency_key) <= 512
    ),
    request_fingerprint TEXT NOT NULL CHECK (
      length(request_fingerprint) = 64
      AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    requested_lifecycle_version INTEGER NOT NULL CHECK (
      requested_lifecycle_version >= 0
    ),
    status TEXT NOT NULL CHECK (
      status IN ('ready', 'revoking', 'completed', 'failed')
    ),
    attempt_version INTEGER NOT NULL DEFAULT 0 CHECK (attempt_version >= 0),
    lease_owner TEXT,
    lease_until TEXT,
    error_code TEXT CHECK (
      error_code IS NULL OR (length(trim(error_code)) > 0 AND length(error_code) <= 128)
    ),
    index_refresh_status TEXT NOT NULL DEFAULT 'not_required' CHECK (
      index_refresh_status IN ('not_required', 'pending', 'enqueued', 'failed')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (id, account_id),
    UNIQUE (account_id, card_id),
    UNIQUE (account_id, operation_key),
    UNIQUE (account_id, idempotency_key),
    CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
    CHECK (
      (authority_confirmation_id IS NULL AND authority_memory_id IS NULL)
      OR
      (authority_confirmation_id IS NOT NULL AND authority_memory_id IS NOT NULL)
    ),
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
    FOREIGN KEY (card_id, account_id)
      REFERENCES dr_working_cards(id, account_id) ON DELETE RESTRICT,
    FOREIGN KEY (proposal_id, account_id)
      REFERENCES dr_memory_proposals(id, account_id) ON DELETE RESTRICT
  );

  CREATE INDEX idx_dr_working_card_memory_revocation_claim
    ON dr_working_card_memory_revocation_operations(status, lease_until, updated_at);

  CREATE TABLE dr_working_card_memory_revocation_receipts (
    account_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    proposal_id TEXT,
    outcome TEXT NOT NULL CHECK (
      outcome IN ('revoked', 'no_long_term_object')
    ),
    historical_memory_id TEXT,
    removed_memory_evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (
      removed_memory_evidence_count >= 0
    ),
    removed_person_source_count INTEGER NOT NULL DEFAULT 0 CHECK (
      removed_person_source_count >= 0
    ),
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, operation_id),
    UNIQUE (account_id, card_id),
    CHECK (
      (outcome = 'revoked' AND historical_memory_id IS NOT NULL)
      OR
      (outcome = 'no_long_term_object' AND historical_memory_id IS NULL)
    ),
    FOREIGN KEY (operation_id, account_id)
      REFERENCES dr_working_card_memory_revocation_operations(id, account_id)
      ON DELETE RESTRICT
  );

  CREATE TRIGGER dr_working_card_memory_revocation_receipt_immutable
  BEFORE UPDATE ON dr_working_card_memory_revocation_receipts
  BEGIN
    SELECT RAISE(ABORT, 'daily_reflection_card_memory_revocation_receipt_immutable');
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
  { version: 8, sql: DAILY_REFLECTION_SCHEMA_V8 },
  { version: 9, sql: DAILY_REFLECTION_SCHEMA_V9 },
  { version: 10, sql: DAILY_REFLECTION_SCHEMA_V10 },
  { version: 11, sql: DAILY_REFLECTION_SCHEMA_V11 },
  { version: 12, sql: DAILY_REFLECTION_SCHEMA_V12 }
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
