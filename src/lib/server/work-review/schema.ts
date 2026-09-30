import type Database from "better-sqlite3";

export const WORK_REVIEW_SCHEMA_VERSION = 9;

const WORK_REVIEW_SCHEMA_V1 = `
  CREATE TABLE wr_meetings (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    product_space TEXT NOT NULL CHECK (product_space = 'office_review'),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    meeting_date TEXT NOT NULL CHECK (length(trim(meeting_date)) > 0),
    source_upload_id TEXT NOT NULL CHECK (length(trim(source_upload_id)) > 0),
    source_duration_seconds REAL CHECK (
      source_duration_seconds IS NULL OR source_duration_seconds > 0
    ),
    ingestion_status TEXT NOT NULL CHECK (ingestion_status IN (
      'created', 'queued', 'transcribing', 'transcript_ready', 'failed', 'deleted'
    )),
    analysis_status TEXT NOT NULL CHECK (analysis_status IN (
      'not_started', 'queued', 'extracting', 'verifying', 'review_ready', 'failed', 'deleted'
    )),
    review_status TEXT NOT NULL CHECK (review_status IN (
      'not_started', 'in_progress', 'completed'
    )),
    canonical_publication_id TEXT,
    canonical_content_digest TEXT CHECK (
      canonical_content_digest IS NULL OR length(canonical_content_digest) = 64
    ),
    canonical_segment_count INTEGER NOT NULL DEFAULT 0
      CHECK (canonical_segment_count >= 0),
    current_transcription_attempt INTEGER NOT NULL DEFAULT 0
      CHECK (current_transcription_attempt >= 0),
    current_analysis_attempt INTEGER NOT NULL DEFAULT 0
      CHECK (current_analysis_attempt >= 0),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    transcript_ready_at TEXT,
    review_ready_at TEXT,
    review_completed_at TEXT,
    failed_at TEXT,
    deleted_at TEXT,
    error_stage TEXT CHECK (
      error_stage IS NULL OR error_stage IN ('transcription', 'meeting_analysis')
    ),
    error_code TEXT,
    UNIQUE (id, account_id),
    UNIQUE (account_id, source_upload_id),
    UNIQUE (id, account_id, source_upload_id),
    CHECK (
      (canonical_publication_id IS NULL AND canonical_content_digest IS NULL
        AND canonical_segment_count = 0)
      OR
      (canonical_publication_id IS NOT NULL AND canonical_content_digest IS NOT NULL
        AND canonical_segment_count > 0)
    ),
    CHECK (
      ingestion_status IN ('transcript_ready', 'deleted')
      OR analysis_status = 'not_started'
    ),
    CHECK (
      review_status = 'not_started'
      OR analysis_status IN ('review_ready', 'deleted')
    ),
    CHECK ((ingestion_status = 'deleted') = (deleted_at IS NOT NULL)),
    CHECK (ingestion_status <> 'deleted' OR analysis_status = 'deleted')
  );

  CREATE INDEX idx_wr_meetings_account_updated
    ON wr_meetings(account_id, updated_at DESC, id);

  CREATE TABLE wr_input_receipts (
    receipt_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    operation_key TEXT NOT NULL CHECK (length(trim(operation_key)) > 0),
    idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
    state TEXT NOT NULL CHECK (state IN (
      'reserved', 'accepted', 'processing', 'completed', 'failed', 'deleted'
    )),
    created_at TEXT NOT NULL,
    completed_at TEXT,
    error_code TEXT,
    UNIQUE (receipt_id, account_id),
    UNIQUE (account_id, operation_key),
    UNIQUE (account_id, idempotency_key),
    FOREIGN KEY (meeting_id, account_id)
      REFERENCES wr_meetings(id, account_id) ON DELETE CASCADE
  );

  CREATE TRIGGER wr_input_receipt_identity_immutable
  BEFORE UPDATE OF account_id, meeting_id, operation_key, idempotency_key,
                   content_hash, request_fingerprint
  ON wr_input_receipts
  BEGIN
    SELECT RAISE(ABORT, 'work_review_input_receipt_immutable');
  END;

  CREATE TABLE wr_source_uploads (
    account_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    upload_id TEXT NOT NULL,
    original_name TEXT NOT NULL CHECK (length(trim(original_name)) > 0),
    mime_type TEXT NOT NULL CHECK (length(trim(mime_type)) > 0),
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    recording_date TEXT NOT NULL CHECK (length(trim(recording_date)) > 0),
    file_path TEXT,
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    created_at TEXT NOT NULL,
    cleaned_at TEXT,
    PRIMARY KEY (account_id, meeting_id),
    UNIQUE (account_id, upload_id),
    FOREIGN KEY (meeting_id, account_id, upload_id)
      REFERENCES wr_meetings(id, account_id, source_upload_id) ON DELETE CASCADE
  );

  CREATE TRIGGER wr_source_upload_identity_immutable
  BEFORE UPDATE OF account_id, meeting_id, upload_id, original_name, mime_type,
                   size_bytes, recording_date, content_hash, created_at
  ON wr_source_uploads
  BEGIN
    SELECT RAISE(ABORT, 'work_review_source_upload_immutable');
  END;

  CREATE TABLE wr_processing_attempts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('transcription', 'meeting_analysis')),
    attempt_version INTEGER NOT NULL CHECK (attempt_version > 0),
    lease_owner TEXT,
    lease_expires_at TEXT,
    pipeline_version TEXT NOT NULL CHECK (length(trim(pipeline_version)) > 0),
    provider_profile TEXT NOT NULL CHECK (length(trim(provider_profile)) > 0),
    prompt_version TEXT,
    state TEXT NOT NULL CHECK (state IN (
      'queued', 'processing', 'completed', 'failed', 'superseded', 'deleted'
    )),
    created_at TEXT NOT NULL,
    completed_at TEXT,
    error_code TEXT,
    UNIQUE (account_id, meeting_id, stage, attempt_version),
    CHECK (
      (state = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
        AND completed_at IS NULL)
      OR
      (state <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    FOREIGN KEY (meeting_id, account_id)
      REFERENCES wr_meetings(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_wr_processing_attempts_lease
    ON wr_processing_attempts(stage, state, lease_expires_at, meeting_id);

  CREATE UNIQUE INDEX idx_wr_processing_attempts_one_active
    ON wr_processing_attempts(account_id, meeting_id, stage)
    WHERE state = 'processing';

  CREATE TABLE wr_canonical_publications (
    publication_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    source_upload_id TEXT NOT NULL,
    product_space TEXT NOT NULL CHECK (product_space = 'office_review'),
    asset_kind TEXT NOT NULL CHECK (asset_kind = 'segments'),
    attempt_version INTEGER NOT NULL CHECK (attempt_version > 0),
    content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
    segment_count INTEGER NOT NULL CHECK (segment_count > 0),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    tombstoned_at TEXT,
    UNIQUE (publication_id, account_id, meeting_id),
    UNIQUE (account_id, meeting_id, asset_kind),
    FOREIGN KEY (meeting_id, account_id, source_upload_id)
      REFERENCES wr_meetings(id, account_id, source_upload_id) ON DELETE CASCADE
  );

  CREATE TRIGGER wr_canonical_publication_immutable
  BEFORE UPDATE OF account_id, meeting_id, source_upload_id, product_space,
                   asset_kind, attempt_version, content_digest, segment_count,
                   payload_json, created_at
  ON wr_canonical_publications
  BEGIN
    SELECT RAISE(ABORT, 'work_review_canonical_publication_immutable');
  END;

  CREATE TABLE wr_meeting_candidates (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    kind TEXT NOT NULL CHECK (kind IN (
      'discussion_topic', 'proposal', 'decision', 'commitment',
      'open_question', 'plan_change', 'action_item'
    )),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    body TEXT NOT NULL CHECK (length(trim(body)) > 0),
    structured_data_json TEXT NOT NULL CHECK (json_valid(structured_data_json)),
    status TEXT NOT NULL CHECK (status IN (
      'pending_review', 'accepted', 'edited_and_accepted',
      'retyped_and_accepted', 'ignored', 'invalidated'
    )),
    publication_action TEXT NOT NULL CHECK (publication_action IN (
      'show_as_candidate', 'show_as_question', 'suppress'
    )),
    risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
    generator_profile TEXT NOT NULL,
    generator_prompt_version TEXT NOT NULL,
    analysis_attempt_version INTEGER NOT NULL CHECK (analysis_attempt_version > 0),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, account_id, meeting_id),
    UNIQUE (account_id, meeting_id, ordinal),
    FOREIGN KEY (meeting_id, account_id)
      REFERENCES wr_meetings(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (publication_id, account_id, meeting_id)
      REFERENCES wr_canonical_publications(publication_id, account_id, meeting_id)
      ON DELETE CASCADE
  );

  CREATE TABLE wr_candidate_evidence (
    account_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    segment_id TEXT NOT NULL CHECK (length(trim(segment_id)) > 0),
    start_seconds REAL NOT NULL CHECK (start_seconds >= 0),
    end_seconds REAL NOT NULL CHECK (end_seconds > start_seconds),
    raw_speaker_label TEXT,
    timestamp_quality TEXT NOT NULL CHECK (timestamp_quality IN (
      'provider_exact', 'provider_estimated', 'synthetic', 'unknown'
    )),
    PRIMARY KEY (account_id, candidate_id, position),
    UNIQUE (account_id, candidate_id, segment_id),
    FOREIGN KEY (candidate_id, account_id, meeting_id)
      REFERENCES wr_meeting_candidates(id, account_id, meeting_id) ON DELETE CASCADE,
    FOREIGN KEY (publication_id, account_id, meeting_id)
      REFERENCES wr_canonical_publications(publication_id, account_id, meeting_id)
      ON DELETE CASCADE
  );

  CREATE TABLE wr_atomic_claims (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    claim_type TEXT NOT NULL CHECK (claim_type IN (
      'topic', 'proposal', 'decision_existence', 'decision_finality',
      'speaker_attribution', 'commitment_existence', 'commitment_owner',
      'deadline', 'open_question', 'question_resolution', 'plan_change', 'action_item'
    )),
    text TEXT NOT NULL CHECK (length(trim(text)) > 0),
    created_at TEXT NOT NULL,
    UNIQUE (id, account_id, meeting_id),
    UNIQUE (account_id, candidate_id, ordinal),
    FOREIGN KEY (candidate_id, account_id, meeting_id)
      REFERENCES wr_meeting_candidates(id, account_id, meeting_id) ON DELETE CASCADE
  );

  CREATE TABLE wr_claim_evidence (
    account_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    segment_id TEXT NOT NULL,
    PRIMARY KEY (account_id, claim_id, position),
    UNIQUE (account_id, claim_id, segment_id),
    FOREIGN KEY (claim_id, account_id, meeting_id)
      REFERENCES wr_atomic_claims(id, account_id, meeting_id) ON DELETE CASCADE,
    FOREIGN KEY (publication_id, account_id, meeting_id)
      REFERENCES wr_canonical_publications(publication_id, account_id, meeting_id)
      ON DELETE CASCADE
  );

  CREATE TABLE wr_claim_evaluations (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    support_verdict TEXT NOT NULL CHECK (support_verdict IN (
      'entailed', 'partially_entailed', 'unsupported', 'contradicted', 'unverifiable'
    )),
    issue_codes_json TEXT NOT NULL CHECK (json_valid(issue_codes_json)),
    risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
    publication_action TEXT NOT NULL CHECK (publication_action IN (
      'show_as_candidate', 'show_as_question', 'suppress'
    )),
    confirmation_required INTEGER NOT NULL CHECK (confirmation_required IN (0, 1)),
    supported_evidence_ids_json TEXT NOT NULL CHECK (json_valid(supported_evidence_ids_json)),
    generator_profile TEXT NOT NULL,
    verifier_profile TEXT NOT NULL,
    verifier_prompt_version TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    UNIQUE (id, account_id, meeting_id),
    UNIQUE (account_id, claim_id),
    FOREIGN KEY (claim_id, account_id, meeting_id)
      REFERENCES wr_atomic_claims(id, account_id, meeting_id) ON DELETE CASCADE
  );

  CREATE TRIGGER wr_claim_evaluation_immutable
  BEFORE UPDATE ON wr_claim_evaluations
  BEGIN
    SELECT RAISE(ABORT, 'work_review_claim_evaluation_immutable');
  END;

  CREATE TABLE wr_findings (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    source_candidate_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (
      'discussion_topic', 'proposal', 'decision', 'commitment',
      'open_question', 'plan_change', 'action_item'
    )),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    body TEXT NOT NULL CHECK (length(trim(body)) > 0),
    structured_data_json TEXT NOT NULL CHECK (json_valid(structured_data_json)),
    user_confirmed_at TEXT NOT NULL,
    user_edited_at TEXT,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, account_id, meeting_id),
    UNIQUE (account_id, meeting_id, source_candidate_id),
    FOREIGN KEY (source_candidate_id, account_id, meeting_id)
      REFERENCES wr_meeting_candidates(id, account_id, meeting_id) ON DELETE CASCADE
  );

  CREATE TABLE wr_finding_evidence (
    account_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    finding_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    segment_id TEXT NOT NULL,
    start_seconds REAL NOT NULL CHECK (start_seconds >= 0),
    end_seconds REAL NOT NULL CHECK (end_seconds > start_seconds),
    raw_speaker_label TEXT,
    timestamp_quality TEXT NOT NULL CHECK (timestamp_quality IN (
      'provider_exact', 'provider_estimated', 'synthetic', 'unknown'
    )),
    PRIMARY KEY (account_id, finding_id, position),
    UNIQUE (account_id, finding_id, segment_id),
    FOREIGN KEY (finding_id, account_id, meeting_id)
      REFERENCES wr_findings(id, account_id, meeting_id) ON DELETE CASCADE,
    FOREIGN KEY (publication_id, account_id, meeting_id)
      REFERENCES wr_canonical_publications(publication_id, account_id, meeting_id)
      ON DELETE CASCADE
  );

  CREATE TABLE wr_review_operations (
    account_id TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    candidate_id TEXT,
    finding_id TEXT,
    action TEXT NOT NULL CHECK (action IN (
      'accept', 'edit_and_accept', 'retype_and_accept', 'ignore', 'edit_finding',
      'complete_review', 'set_speaker_alias'
    )),
    request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, operation_key),
    FOREIGN KEY (meeting_id, account_id)
      REFERENCES wr_meetings(id, account_id) ON DELETE CASCADE
  );

  CREATE TABLE wr_review_events (
    event_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    candidate_id TEXT,
    finding_id TEXT,
    operation_key TEXT,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'candidate_confirmed', 'candidate_edited_and_confirmed',
      'candidate_retyped_and_confirmed', 'candidate_ignored',
      'finding_edited', 'review_completed'
    )),
    candidate_version INTEGER,
    finding_version INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE (event_id, account_id),
    FOREIGN KEY (meeting_id, account_id)
      REFERENCES wr_meetings(id, account_id) ON DELETE CASCADE
  );

  CREATE UNIQUE INDEX idx_wr_review_completed_once
    ON wr_review_events(account_id, meeting_id, event_type)
    WHERE event_type = 'review_completed';

  CREATE TABLE wr_speaker_aliases (
    account_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    raw_label TEXT NOT NULL CHECK (length(trim(raw_label)) > 0),
    display_label TEXT NOT NULL CHECK (length(trim(display_label)) > 0),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, meeting_id, raw_label),
    FOREIGN KEY (meeting_id, account_id)
      REFERENCES wr_meetings(id, account_id) ON DELETE CASCADE
  );

  CREATE TABLE wr_tombstones (
    account_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    source_upload_id TEXT NOT NULL,
    transcription_attempt_version INTEGER NOT NULL CHECK (transcription_attempt_version >= 0),
    analysis_attempt_version INTEGER NOT NULL CHECK (analysis_attempt_version >= 0),
    cleanup_status TEXT NOT NULL CHECK (cleanup_status IN ('pending', 'completed', 'failed')),
    cleanup_error_code TEXT,
    deleted_at TEXT NOT NULL,
    cleanup_completed_at TEXT,
    PRIMARY KEY (account_id, meeting_id),
    FOREIGN KEY (meeting_id, account_id)
      REFERENCES wr_meetings(id, account_id) ON DELETE CASCADE
  );
`;

const WORK_REVIEW_SCHEMA_V2 = `
  CREATE TABLE IF NOT EXISTS wr_processing_operations (
    account_id TEXT NOT NULL,
    operation_key TEXT NOT NULL CHECK (length(trim(operation_key)) > 0),
    meeting_id TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('transcription', 'meeting_analysis')),
    request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, operation_key),
    FOREIGN KEY (meeting_id, account_id)
      REFERENCES wr_meetings(id, account_id) ON DELETE CASCADE
  );
`;

const WORK_REVIEW_SCHEMA_V3 = `
  CREATE TABLE wr_todos (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('self', 'waiting_for_other')),
    status TEXT NOT NULL CHECK (status IN ('open', 'completed')),
    origin TEXT NOT NULL CHECK (origin IN (
      'manual', 'meeting_finding', 'detached_meeting_finding'
    )),
    title TEXT NOT NULL CHECK (
      length(trim(title)) BETWEEN 1 AND 240
    ),
    notes TEXT CHECK (notes IS NULL OR length(notes) <= 5000),
    owner_label TEXT CHECK (
      owner_label IS NULL OR length(trim(owner_label)) BETWEEN 1 AND 512
    ),
    current_due_date TEXT CHECK (
      current_due_date IS NULL OR (
        length(current_due_date) = 10
        AND current_due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      )
    ),
    is_important INTEGER NOT NULL DEFAULT 0 CHECK (is_important IN (0, 1)),
    my_day_date TEXT CHECK (
      my_day_date IS NULL OR (
        length(my_day_date) = 10
        AND my_day_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      )
    ),
    source_meeting_id TEXT,
    source_finding_id TEXT,
    source_finding_version INTEGER CHECK (
      source_finding_version IS NULL OR source_finding_version >= 0
    ),
    source_finding_kind TEXT CHECK (
      source_finding_kind IS NULL OR source_finding_kind IN ('action_item', 'commitment')
    ),
    source_owner_label TEXT CHECK (
      source_owner_label IS NULL OR length(trim(source_owner_label)) BETWEEN 1 AND 512
    ),
    source_original_due_at TEXT,
    source_original_due_expression TEXT CHECK (
      source_original_due_expression IS NULL
      OR length(trim(source_original_due_expression)) BETWEEN 1 AND 2000
    ),
    source_action_basis TEXT CHECK (
      source_action_basis IS NULL OR source_action_basis IN (
        'explicit_commitment', 'assignment_without_acceptance',
        'suggested_action', 'unowned_follow_up'
      )
    ),
    source_detached_at TEXT,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    reopened_at TEXT,
    deleted_at TEXT,
    UNIQUE (id, account_id),
    CHECK (kind <> 'waiting_for_other' OR owner_label IS NOT NULL),
    CHECK (
      (status = 'completed' AND completed_at IS NOT NULL)
      OR (status = 'open')
    ),
    CHECK (
      (origin = 'meeting_finding'
        AND source_meeting_id IS NOT NULL
        AND source_finding_id IS NOT NULL
        AND source_finding_version IS NOT NULL
        AND source_finding_kind IS NOT NULL
        AND source_detached_at IS NULL)
      OR
      (origin = 'manual'
        AND source_meeting_id IS NULL
        AND source_finding_id IS NULL
        AND source_finding_version IS NULL
        AND source_finding_kind IS NULL
        AND source_owner_label IS NULL
        AND source_original_due_at IS NULL
        AND source_original_due_expression IS NULL
        AND source_action_basis IS NULL
        AND source_detached_at IS NULL)
      OR
      (origin = 'detached_meeting_finding'
        AND source_meeting_id IS NULL
        AND source_finding_id IS NULL
        AND source_finding_version IS NULL
        AND source_finding_kind IS NULL
        AND source_owner_label IS NULL
        AND source_original_due_at IS NULL
        AND source_original_due_expression IS NULL
        AND source_action_basis IS NULL
        AND source_detached_at IS NOT NULL)
    )
  );

  CREATE INDEX idx_wr_todos_account_status
    ON wr_todos(account_id, status, updated_at DESC, id);
  CREATE INDEX idx_wr_todos_account_kind_status
    ON wr_todos(account_id, kind, status, updated_at DESC, id);
  CREATE INDEX idx_wr_todos_account_my_day_status
    ON wr_todos(account_id, my_day_date, status, updated_at DESC, id);
  CREATE INDEX idx_wr_todos_account_due_status
    ON wr_todos(account_id, current_due_date, status, updated_at DESC, id);
  CREATE INDEX idx_wr_todos_account_completed
    ON wr_todos(account_id, completed_at DESC, id);
  CREATE INDEX idx_wr_todos_source_finding
    ON wr_todos(account_id, source_finding_id);
  CREATE UNIQUE INDEX idx_wr_todos_one_active_source
    ON wr_todos(account_id, source_finding_id)
    WHERE source_finding_id IS NOT NULL AND deleted_at IS NULL;

  CREATE TABLE wr_todo_operations (
    account_id TEXT NOT NULL,
    operation_key TEXT NOT NULL CHECK (length(trim(operation_key)) > 0),
    todo_id TEXT NOT NULL,
    operation_type TEXT NOT NULL CHECK (operation_type IN (
      'create_manual', 'create_from_finding', 'update', 'complete', 'reopen',
      'add_to_my_day', 'remove_from_my_day', 'delete'
    )),
    request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
    result_version INTEGER NOT NULL CHECK (result_version >= 0),
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, operation_key),
    FOREIGN KEY (todo_id, account_id)
      REFERENCES wr_todos(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_wr_todo_operations_todo
    ON wr_todo_operations(account_id, todo_id, created_at DESC);

  CREATE TABLE wr_todo_events (
    event_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    todo_id TEXT NOT NULL,
    operation_key TEXT,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'todo.created_manual', 'todo.created_from_finding', 'todo.updated',
      'todo.completed', 'todo.reopened', 'todo.added_to_my_day',
      'todo.removed_from_my_day', 'todo.deleted', 'todo.detached_from_source'
    )),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    UNIQUE (event_id, account_id),
    FOREIGN KEY (todo_id, account_id)
      REFERENCES wr_todos(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_wr_todo_events_todo
    ON wr_todo_events(account_id, todo_id, created_at, event_id);
`;

const WORK_REVIEW_SCHEMA_V4 = `
  CREATE TABLE wr_follow_up_drafts (
    account_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    body_markdown TEXT NOT NULL CHECK (length(trim(body_markdown)) BETWEEN 1 AND 100000),
    system_body_markdown TEXT NOT NULL CHECK (
      length(trim(system_body_markdown)) BETWEEN 1 AND 100000
    ),
    system_snapshot_digest TEXT NOT NULL CHECK (length(system_snapshot_digest) = 64),
    decisions_markdown TEXT NOT NULL CHECK (length(decisions_markdown) <= 100000),
    actions_markdown TEXT NOT NULL CHECK (length(actions_markdown) <= 100000),
    source_manifest_json TEXT NOT NULL CHECK (json_valid(source_manifest_json)),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    generated_at TEXT NOT NULL,
    user_edited_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, meeting_id),
    FOREIGN KEY (meeting_id, account_id)
      REFERENCES wr_meetings(id, account_id) ON DELETE CASCADE
  );

  CREATE TABLE wr_follow_up_operations (
    account_id TEXT NOT NULL,
    operation_key TEXT NOT NULL CHECK (length(trim(operation_key)) > 0),
    meeting_id TEXT NOT NULL,
    operation_type TEXT NOT NULL CHECK (operation_type IN ('generate', 'update', 'reset')),
    request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, operation_key),
    FOREIGN KEY (meeting_id, account_id)
      REFERENCES wr_meetings(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_wr_follow_up_operations_meeting
    ON wr_follow_up_operations(account_id, meeting_id, created_at DESC);
`;

const WORK_REVIEW_SCHEMA_V5 = `
  CREATE INDEX idx_wr_meetings_account_date
    ON wr_meetings(account_id, meeting_date, id);
  CREATE INDEX idx_wr_todo_events_account_created
    ON wr_todo_events(account_id, created_at, event_id);

  CREATE TABLE wr_projects (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    name_key TEXT NOT NULL CHECK (length(trim(name_key)) >= 1),
    description TEXT CHECK (description IS NULL OR length(description) <= 2000),
    status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE (id, account_id),
    CHECK ((status = 'archived') = (archived_at IS NOT NULL))
  );

  CREATE UNIQUE INDEX idx_wr_projects_active_name
    ON wr_projects(account_id, name_key) WHERE status = 'active';
  CREATE INDEX idx_wr_projects_account_status
    ON wr_projects(account_id, status, updated_at DESC, id);

  CREATE TABLE wr_meeting_projects (
    account_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, meeting_id, project_id),
    FOREIGN KEY (meeting_id, account_id)
      REFERENCES wr_meetings(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, account_id)
      REFERENCES wr_projects(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_wr_meeting_projects_project
    ON wr_meeting_projects(account_id, project_id, meeting_id);

  CREATE TRIGGER wr_meeting_projects_limit
  BEFORE INSERT ON wr_meeting_projects
  WHEN (SELECT count(*) FROM wr_meeting_projects
        WHERE account_id = NEW.account_id AND meeting_id = NEW.meeting_id) >= 3
  BEGIN
    SELECT RAISE(ABORT, 'work_project_link_limit');
  END;

  CREATE TABLE wr_todo_projects (
    account_id TEXT NOT NULL,
    todo_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, todo_id, project_id),
    FOREIGN KEY (todo_id, account_id)
      REFERENCES wr_todos(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, account_id)
      REFERENCES wr_projects(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_wr_todo_projects_project
    ON wr_todo_projects(account_id, project_id, todo_id);

  CREATE TRIGGER wr_todo_projects_limit
  BEFORE INSERT ON wr_todo_projects
  WHEN (SELECT count(*) FROM wr_todo_projects
        WHERE account_id = NEW.account_id AND todo_id = NEW.todo_id) >= 3
  BEGIN
    SELECT RAISE(ABORT, 'work_project_link_limit');
  END;

  CREATE TABLE wr_project_operations (
    account_id TEXT NOT NULL,
    operation_key TEXT NOT NULL CHECK (length(trim(operation_key)) > 0),
    target_kind TEXT NOT NULL CHECK (target_kind IN (
      'project', 'meeting_projects', 'todo_projects'
    )),
    target_id TEXT NOT NULL CHECK (length(trim(target_id)) > 0),
    operation_type TEXT NOT NULL CHECK (operation_type IN (
      'create', 'update', 'set_meeting_projects', 'set_todo_projects'
    )),
    request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, operation_key)
  );

  CREATE INDEX idx_wr_project_operations_target
    ON wr_project_operations(account_id, target_kind, target_id, created_at DESC);

  CREATE TABLE wr_weekly_reviews (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    week_start TEXT NOT NULL,
    week_end TEXT NOT NULL,
    observed_through TEXT NOT NULL,
    window_complete INTEGER NOT NULL CHECK (window_complete IN (0, 1)),
    time_zone TEXT NOT NULL CHECK (length(trim(time_zone)) BETWEEN 1 AND 128),
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('all', 'project', 'unassigned')),
    project_id TEXT,
    status TEXT NOT NULL CHECK (status IN (
      'queued', 'generating', 'verifying', 'ready', 'stale', 'failed', 'deleted'
    )),
    source_snapshot_digest TEXT NOT NULL CHECK (length(source_snapshot_digest) = 64),
    source_summary_json TEXT NOT NULL CHECK (json_valid(source_summary_json)),
    current_system_version INTEGER NOT NULL DEFAULT 0 CHECK (current_system_version >= 0),
    current_run_version INTEGER NOT NULL DEFAULT 0 CHECK (current_run_version >= 0),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    generated_at TEXT,
    failed_at TEXT,
    deleted_at TEXT,
    error_code TEXT,
    UNIQUE (id, account_id),
    FOREIGN KEY (project_id, account_id)
      REFERENCES wr_projects(id, account_id),
    CHECK ((scope_kind = 'project') = (project_id IS NOT NULL)),
    CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
  );

  CREATE UNIQUE INDEX idx_wr_weekly_reviews_active_scope
    ON wr_weekly_reviews(account_id, week_start, scope_kind, COALESCE(project_id, ''))
    WHERE deleted_at IS NULL;
  CREATE INDEX idx_wr_weekly_reviews_account_week
    ON wr_weekly_reviews(account_id, week_start DESC, scope_kind, project_id);

  CREATE TABLE wr_weekly_review_runs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    weekly_review_id TEXT NOT NULL,
    run_version INTEGER NOT NULL CHECK (run_version > 0),
    run_kind TEXT NOT NULL CHECK (run_kind IN ('generate', 'regenerate')),
    source_snapshot_digest TEXT NOT NULL CHECK (length(source_snapshot_digest) = 64),
    source_manifest_json TEXT NOT NULL CHECK (json_valid(source_manifest_json)),
    source_summary_json TEXT NOT NULL CHECK (json_valid(source_summary_json)),
    state TEXT NOT NULL CHECK (state IN (
      'queued', 'processing', 'verifying', 'completed', 'failed', 'superseded', 'deleted'
    )),
    lease_owner TEXT,
    lease_expires_at TEXT,
    pipeline_version TEXT NOT NULL CHECK (length(trim(pipeline_version)) > 0),
    synthesizer_profile TEXT,
    verifier_profile TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    error_code TEXT,
    UNIQUE (id, account_id, weekly_review_id),
    UNIQUE (account_id, weekly_review_id, run_version),
    FOREIGN KEY (weekly_review_id, account_id)
      REFERENCES wr_weekly_reviews(id, account_id) ON DELETE CASCADE,
    CHECK (
      (state IN ('processing', 'verifying') AND lease_owner IS NOT NULL
        AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
      OR
      (state NOT IN ('processing', 'verifying') AND lease_owner IS NULL
        AND lease_expires_at IS NULL)
    )
  );

  CREATE UNIQUE INDEX idx_wr_weekly_runs_one_active
    ON wr_weekly_review_runs(account_id, weekly_review_id)
    WHERE state IN ('queued', 'processing', 'verifying');
  CREATE INDEX idx_wr_weekly_runs_recovery
    ON wr_weekly_review_runs(state, lease_expires_at, created_at, id);

  CREATE TABLE wr_weekly_run_sources (
    account_id TEXT NOT NULL,
    weekly_review_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'meeting', 'finding', 'todo', 'todo_event', 'project', 'evidence'
    )),
    source_entity_id TEXT NOT NULL,
    source_version INTEGER CHECK (source_version IS NULL OR source_version >= 0),
    source_digest TEXT CHECK (source_digest IS NULL OR length(source_digest) = 64),
    meeting_id TEXT,
    todo_id TEXT,
    publication_id TEXT,
    segment_id TEXT,
    included INTEGER NOT NULL CHECK (included IN (0, 1)),
    PRIMARY KEY (account_id, run_id, source_ref),
    FOREIGN KEY (run_id, account_id, weekly_review_id)
      REFERENCES wr_weekly_review_runs(id, account_id, weekly_review_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_wr_weekly_run_sources_entity
    ON wr_weekly_run_sources(account_id, source_kind, source_entity_id, run_id);

  CREATE TABLE wr_weekly_system_versions (
    account_id TEXT NOT NULL,
    weekly_review_id TEXT NOT NULL,
    system_version INTEGER NOT NULL CHECK (system_version > 0),
    run_id TEXT NOT NULL,
    source_snapshot_digest TEXT NOT NULL CHECK (length(source_snapshot_digest) = 64),
    source_summary_json TEXT NOT NULL CHECK (json_valid(source_summary_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, weekly_review_id, system_version),
    UNIQUE (run_id, account_id, weekly_review_id),
    FOREIGN KEY (weekly_review_id, account_id)
      REFERENCES wr_weekly_reviews(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (run_id, account_id, weekly_review_id)
      REFERENCES wr_weekly_review_runs(id, account_id, weekly_review_id)
  );

  CREATE TABLE wr_weekly_system_items (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    weekly_review_id TEXT NOT NULL,
    system_version INTEGER NOT NULL CHECK (system_version > 0),
    section_kind TEXT NOT NULL CHECK (section_kind IN (
      'overview', 'progress', 'decisions', 'completed', 'in_progress',
      'waiting_for_others', 'open_questions', 'next_week'
    )),
    body_text TEXT NOT NULL CHECK (length(trim(body_text)) BETWEEN 1 AND 20000),
    verification_state TEXT NOT NULL CHECK (verification_state IN ('verified', 'qualified')),
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    created_at TEXT NOT NULL,
    erased_at TEXT,
    UNIQUE (id, account_id, weekly_review_id),
    FOREIGN KEY (account_id, weekly_review_id, system_version)
      REFERENCES wr_weekly_system_versions(account_id, weekly_review_id, system_version)
      ON DELETE CASCADE
  );

  CREATE TRIGGER wr_weekly_system_versions_immutable
  BEFORE UPDATE ON wr_weekly_system_versions
  BEGIN
    SELECT RAISE(ABORT, 'work_weekly_system_version_immutable');
  END;

  CREATE TRIGGER wr_weekly_system_items_immutable
  BEFORE UPDATE ON wr_weekly_system_items
  WHEN NOT (
    OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL
    AND NEW.body_text = '来源已失效，内容不可用'
    AND NEW.id IS OLD.id
    AND NEW.account_id IS OLD.account_id
    AND NEW.weekly_review_id IS OLD.weekly_review_id
    AND NEW.system_version IS OLD.system_version
    AND NEW.section_kind IS OLD.section_kind
    AND NEW.verification_state IS OLD.verification_state
    AND NEW.sort_order IS OLD.sort_order
    AND NEW.created_at IS OLD.created_at
  )
  BEGIN
    SELECT RAISE(ABORT, 'work_weekly_system_item_immutable');
  END;

  CREATE TABLE wr_weekly_system_item_sources (
    account_id TEXT NOT NULL,
    weekly_review_id TEXT NOT NULL,
    system_item_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    source_ref TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'meeting', 'finding', 'todo', 'todo_event', 'project', 'evidence'
    )),
    source_entity_id TEXT NOT NULL,
    source_version INTEGER CHECK (source_version IS NULL OR source_version >= 0),
    meeting_id TEXT,
    todo_id TEXT,
    publication_id TEXT,
    segment_id TEXT,
    invalidated_at TEXT,
    PRIMARY KEY (account_id, system_item_id, position),
    UNIQUE (account_id, system_item_id, source_ref),
    FOREIGN KEY (system_item_id, account_id, weekly_review_id)
      REFERENCES wr_weekly_system_items(id, account_id, weekly_review_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_wr_weekly_system_item_sources_entity
    ON wr_weekly_system_item_sources(account_id, source_kind, source_entity_id, system_item_id);

  CREATE TRIGGER wr_weekly_system_item_sources_immutable
  BEFORE UPDATE ON wr_weekly_system_item_sources
  WHEN NOT (
    OLD.invalidated_at IS NULL AND NEW.invalidated_at IS NOT NULL
    AND NEW.account_id IS OLD.account_id
    AND NEW.weekly_review_id IS OLD.weekly_review_id
    AND NEW.system_item_id IS OLD.system_item_id
    AND NEW.position IS OLD.position
    AND NEW.source_ref IS OLD.source_ref
    AND NEW.source_kind IS OLD.source_kind
    AND NEW.source_entity_id IS OLD.source_entity_id
    AND NEW.source_version IS OLD.source_version
    AND NEW.meeting_id IS OLD.meeting_id
    AND NEW.todo_id IS OLD.todo_id
    AND NEW.publication_id IS OLD.publication_id
    AND NEW.segment_id IS OLD.segment_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'work_weekly_system_item_source_immutable');
  END;

  CREATE TABLE wr_weekly_review_items (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    weekly_review_id TEXT NOT NULL,
    system_item_id TEXT,
    section_kind TEXT NOT NULL CHECK (section_kind IN (
      'overview', 'progress', 'decisions', 'completed', 'in_progress',
      'waiting_for_others', 'open_questions', 'next_week'
    )),
    origin TEXT NOT NULL CHECK (origin IN ('gpt', 'user_note')),
    system_text TEXT,
    user_text TEXT,
    verification_state TEXT NOT NULL CHECK (verification_state IN (
      'verified', 'qualified', 'user_authored', 'invalidated'
    )),
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    system_version INTEGER CHECK (system_version IS NULL OR system_version > 0),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    user_edited_at TEXT,
    hidden_at TEXT,
    invalidated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, account_id, weekly_review_id),
    UNIQUE (account_id, weekly_review_id, system_item_id),
    FOREIGN KEY (weekly_review_id, account_id)
      REFERENCES wr_weekly_reviews(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (system_item_id, account_id, weekly_review_id)
      REFERENCES wr_weekly_system_items(id, account_id, weekly_review_id) ON DELETE CASCADE,
    CHECK (
      (origin = 'gpt' AND system_item_id IS NOT NULL AND system_text IS NOT NULL
        AND system_version IS NOT NULL)
      OR
      (origin = 'user_note' AND system_item_id IS NULL AND system_text IS NULL
        AND user_text IS NOT NULL AND system_version IS NULL
        AND verification_state = 'user_authored')
    )
  );

  CREATE INDEX idx_wr_weekly_review_items_order
    ON wr_weekly_review_items(account_id, weekly_review_id, section_kind, sort_order, id);

  CREATE TABLE wr_weekly_item_sources (
    account_id TEXT NOT NULL,
    weekly_review_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    source_ref TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'meeting', 'finding', 'todo', 'todo_event', 'project', 'evidence'
    )),
    source_entity_id TEXT NOT NULL,
    source_version INTEGER CHECK (source_version IS NULL OR source_version >= 0),
    meeting_id TEXT,
    todo_id TEXT,
    publication_id TEXT,
    segment_id TEXT,
    invalidated_at TEXT,
    PRIMARY KEY (account_id, item_id, position),
    UNIQUE (account_id, item_id, source_ref),
    FOREIGN KEY (item_id, account_id, weekly_review_id)
      REFERENCES wr_weekly_review_items(id, account_id, weekly_review_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_wr_weekly_item_sources_entity
    ON wr_weekly_item_sources(account_id, source_kind, source_entity_id, item_id);

  CREATE TABLE wr_weekly_review_operations (
    account_id TEXT NOT NULL,
    operation_key TEXT NOT NULL CHECK (length(trim(operation_key)) > 0),
    weekly_review_id TEXT NOT NULL,
    target_id TEXT,
    operation_type TEXT NOT NULL CHECK (operation_type IN (
      'generate', 'regenerate', 'update_item', 'create_note', 'delete_note',
      'reset', 'delete_review'
    )),
    request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, operation_key),
    FOREIGN KEY (weekly_review_id, account_id)
      REFERENCES wr_weekly_reviews(id, account_id) ON DELETE CASCADE
  );

  CREATE TABLE wr_weekly_tombstones (
    account_id TEXT NOT NULL,
    weekly_review_id TEXT NOT NULL,
    last_version INTEGER NOT NULL CHECK (last_version >= 0),
    deleted_at TEXT NOT NULL,
    PRIMARY KEY (account_id, weekly_review_id),
    FOREIGN KEY (weekly_review_id, account_id)
      REFERENCES wr_weekly_reviews(id, account_id) ON DELETE CASCADE
  );

  CREATE TABLE wr_weekly_qa_threads (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    weekly_review_id TEXT NOT NULL,
    source_snapshot_digest TEXT NOT NULL CHECK (length(source_snapshot_digest) = 64),
    current_run_version INTEGER NOT NULL DEFAULT 0 CHECK (current_run_version >= 0),
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    cleared_at TEXT,
    deleted_at TEXT,
    UNIQUE (id, account_id, weekly_review_id),
    UNIQUE (account_id, weekly_review_id),
    FOREIGN KEY (weekly_review_id, account_id)
      REFERENCES wr_weekly_reviews(id, account_id) ON DELETE CASCADE
  );

  CREATE TABLE wr_weekly_qa_messages (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    weekly_review_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    question_message_id TEXT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    body_text TEXT,
    answer_status TEXT CHECK (answer_status IS NULL OR answer_status IN (
      'answered', 'partially_answered', 'insufficient_evidence', 'failed', 'invalidated'
    )),
    source_snapshot_digest TEXT NOT NULL CHECK (length(source_snapshot_digest) = 64),
    provider_profile TEXT,
    prompt_version TEXT,
    verifier_profile TEXT,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at TEXT NOT NULL,
    invalidated_at TEXT,
    UNIQUE (id, account_id, weekly_review_id, thread_id),
    FOREIGN KEY (thread_id, account_id, weekly_review_id)
      REFERENCES wr_weekly_qa_threads(id, account_id, weekly_review_id) ON DELETE CASCADE,
    CHECK ((role = 'user' AND question_message_id IS NULL AND answer_status IS NULL)
      OR (role = 'assistant' AND question_message_id IS NOT NULL AND answer_status IS NOT NULL)),
    CHECK (body_text IS NOT NULL OR invalidated_at IS NOT NULL)
  );

  CREATE TABLE wr_weekly_qa_runs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    weekly_review_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    question_message_id TEXT NOT NULL,
    run_version INTEGER NOT NULL CHECK (run_version > 0),
    source_snapshot_digest TEXT NOT NULL CHECK (length(source_snapshot_digest) = 64),
    source_manifest_json TEXT NOT NULL CHECK (json_valid(source_manifest_json)),
    state TEXT NOT NULL CHECK (state IN (
      'queued', 'processing', 'verifying', 'completed', 'failed', 'superseded', 'deleted'
    )),
    lease_owner TEXT,
    lease_expires_at TEXT,
    provider_profile TEXT,
    prompt_version TEXT,
    verifier_profile TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    error_code TEXT,
    UNIQUE (id, account_id, weekly_review_id, thread_id),
    UNIQUE (account_id, thread_id, run_version),
    FOREIGN KEY (thread_id, account_id, weekly_review_id)
      REFERENCES wr_weekly_qa_threads(id, account_id, weekly_review_id) ON DELETE CASCADE,
    CHECK (
      (state IN ('processing', 'verifying') AND lease_owner IS NOT NULL
        AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
      OR
      (state NOT IN ('processing', 'verifying') AND lease_owner IS NULL
        AND lease_expires_at IS NULL)
    )
  );

  CREATE UNIQUE INDEX idx_wr_weekly_qa_runs_one_active
    ON wr_weekly_qa_runs(account_id, thread_id)
    WHERE state IN ('queued', 'processing', 'verifying');
  CREATE INDEX idx_wr_weekly_qa_runs_recovery
    ON wr_weekly_qa_runs(state, lease_expires_at, created_at, id);

  CREATE TABLE wr_weekly_qa_message_sources (
    account_id TEXT NOT NULL,
    weekly_review_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    source_ref TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'meeting', 'finding', 'todo', 'todo_event', 'project', 'evidence'
    )),
    source_entity_id TEXT NOT NULL,
    source_version INTEGER CHECK (source_version IS NULL OR source_version >= 0),
    meeting_id TEXT,
    todo_id TEXT,
    publication_id TEXT,
    segment_id TEXT,
    invalidated_at TEXT,
    PRIMARY KEY (account_id, message_id, position),
    UNIQUE (account_id, message_id, source_ref),
    FOREIGN KEY (message_id, account_id, weekly_review_id, thread_id)
      REFERENCES wr_weekly_qa_messages(id, account_id, weekly_review_id, thread_id)
      ON DELETE CASCADE
  );

  CREATE INDEX idx_wr_weekly_qa_sources_entity
    ON wr_weekly_qa_message_sources(account_id, source_kind, source_entity_id, message_id);

  CREATE TABLE wr_weekly_qa_operations (
    account_id TEXT NOT NULL,
    operation_key TEXT NOT NULL CHECK (length(trim(operation_key)) > 0),
    weekly_review_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    operation_type TEXT NOT NULL CHECK (operation_type IN ('ask', 'clear')),
    request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, operation_key),
    FOREIGN KEY (thread_id, account_id, weekly_review_id)
      REFERENCES wr_weekly_qa_threads(id, account_id, weekly_review_id) ON DELETE CASCADE
  );
`;

const WORK_REVIEW_SCHEMA_V6 = `
  ALTER TABLE wr_processing_attempts ADD COLUMN deadline_at TEXT;

  CREATE TRIGGER wr_processing_attempt_deadline_immutable
  BEFORE UPDATE OF deadline_at ON wr_processing_attempts
  WHEN NEW.deadline_at IS NOT OLD.deadline_at
  BEGIN
    SELECT RAISE(ABORT, 'work_review_processing_deadline_immutable');
  END;

  CREATE TABLE wr_analysis_checkpoints (
    account_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    canonical_content_digest TEXT NOT NULL CHECK (length(canonical_content_digest) = 64),
    checkpoint_kind TEXT NOT NULL CHECK (checkpoint_kind IN (
      'extractor_block', 'verifier_batch'
    )),
    logical_input_digest TEXT NOT NULL CHECK (length(logical_input_digest) = 64),
    provider_contract_digest TEXT NOT NULL CHECK (length(provider_contract_digest) = 64),
    output_schema_version TEXT NOT NULL CHECK (length(trim(output_schema_version)) > 0),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
    origin_attempt_version INTEGER NOT NULL CHECK (origin_attempt_version > 0),
    attempt_stage TEXT NOT NULL DEFAULT 'meeting_analysis'
      CHECK (attempt_stage = 'meeting_analysis'),
    created_at TEXT NOT NULL,
    PRIMARY KEY (
      account_id, meeting_id, publication_id, checkpoint_kind,
      logical_input_digest, provider_contract_digest
    ),
    FOREIGN KEY (publication_id, account_id, meeting_id)
      REFERENCES wr_canonical_publications(publication_id, account_id, meeting_id)
      ON DELETE CASCADE,
    FOREIGN KEY (account_id, meeting_id, attempt_stage, origin_attempt_version)
      REFERENCES wr_processing_attempts(account_id, meeting_id, stage, attempt_version)
      ON DELETE CASCADE
  );

  CREATE INDEX idx_wr_analysis_checkpoints_origin
    ON wr_analysis_checkpoints(
      account_id, meeting_id, origin_attempt_version, checkpoint_kind
    );
`;

const WORK_REVIEW_SCHEMA_V7 = `
  CREATE TABLE wr_analysis_checkpoints_v7 (
    account_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    canonical_content_digest TEXT NOT NULL CHECK (length(canonical_content_digest) = 64),
    checkpoint_kind TEXT NOT NULL CHECK (checkpoint_kind IN ('extractor_block', 'organization_plan', 'verifier_batch')),
    logical_input_digest TEXT NOT NULL CHECK (length(logical_input_digest) = 64),
    provider_contract_digest TEXT NOT NULL CHECK (length(provider_contract_digest) = 64),
    output_schema_version TEXT NOT NULL CHECK (length(trim(output_schema_version)) > 0),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
    origin_attempt_version INTEGER NOT NULL CHECK (origin_attempt_version > 0),
    attempt_stage TEXT NOT NULL DEFAULT 'meeting_analysis' CHECK (attempt_stage = 'meeting_analysis'),
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, meeting_id, publication_id, checkpoint_kind, logical_input_digest, provider_contract_digest),
    FOREIGN KEY (publication_id, account_id, meeting_id)
      REFERENCES wr_canonical_publications(publication_id, account_id, meeting_id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, meeting_id, attempt_stage, origin_attempt_version)
      REFERENCES wr_processing_attempts(account_id, meeting_id, stage, attempt_version) ON DELETE CASCADE
  );
  INSERT INTO wr_analysis_checkpoints_v7 SELECT * FROM wr_analysis_checkpoints;
  DROP TABLE wr_analysis_checkpoints;
  ALTER TABLE wr_analysis_checkpoints_v7 RENAME TO wr_analysis_checkpoints;
  CREATE INDEX idx_wr_analysis_checkpoints_origin
    ON wr_analysis_checkpoints(account_id, meeting_id, origin_attempt_version, checkpoint_kind);

  -- Diagnostic history; existing review tables retain publication authority.
  CREATE TABLE wr_analysis_audits (
    account_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    canonical_content_digest TEXT NOT NULL CHECK (length(canonical_content_digest) = 64),
    attempt_version INTEGER NOT NULL CHECK (attempt_version > 0),
    attempt_stage TEXT NOT NULL DEFAULT 'meeting_analysis' CHECK (attempt_stage = 'meeting_analysis'),
    schema_version TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, meeting_id, publication_id, attempt_version),
    FOREIGN KEY (publication_id, account_id, meeting_id)
      REFERENCES wr_canonical_publications(publication_id, account_id, meeting_id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, meeting_id, attempt_stage, attempt_version)
      REFERENCES wr_processing_attempts(account_id, meeting_id, stage, attempt_version) ON DELETE CASCADE
  );
`;

const WORK_REVIEW_SCHEMA_V8 = `
  -- Quality belongs to its generation run; current system versions already reference that run.
  -- Leave historical rows NULL instead of reclassifying or republishing old attempts.
  ALTER TABLE wr_weekly_review_runs ADD COLUMN quality_assessment_json TEXT
    CHECK (quality_assessment_json IS NULL OR json_valid(quality_assessment_json));
`;

const WORK_REVIEW_SCHEMA_V9 = `
  -- Keep the project identity for historical Weekly references and replay fencing.
  ALTER TABLE wr_projects ADD COLUMN deleted_at TEXT;
`;

const MIGRATIONS = [
  { version: 1, sql: WORK_REVIEW_SCHEMA_V1 },
  { version: 2, sql: WORK_REVIEW_SCHEMA_V2 },
  { version: 3, sql: WORK_REVIEW_SCHEMA_V3 },
  { version: 4, sql: WORK_REVIEW_SCHEMA_V4 },
  { version: 5, sql: WORK_REVIEW_SCHEMA_V5 },
  { version: 6, sql: WORK_REVIEW_SCHEMA_V6 },
  { version: 7, sql: WORK_REVIEW_SCHEMA_V7 },
  { version: 8, sql: WORK_REVIEW_SCHEMA_V8 },
  { version: 9, sql: WORK_REVIEW_SCHEMA_V9 }
] as const;

export function migrateWorkReviewSchema(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS wr_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const hasMigration = database.prepare(
    "SELECT 1 FROM wr_schema_migrations WHERE version = ?"
  );
  const recordMigration = database.prepare(
    "INSERT INTO wr_schema_migrations(version, applied_at) VALUES (?, ?)"
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
