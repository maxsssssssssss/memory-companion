import type Database from "better-sqlite3";

export const MEMORY_SCHEMA_VERSION = 13;

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

const MEMORY_SCHEMA_V4 = `
  CREATE TABLE person_entities (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN (
      'transcript_candidate',
      'identity_profile',
      'date_companion_review',
      'manual_confirmation'
    )),
    status TEXT NOT NULL CHECK (status IN ('candidate', 'confirmed', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, account_id)
  );

  CREATE INDEX idx_person_entities_account_status
    ON person_entities(account_id, status, updated_at DESC);
  CREATE INDEX idx_person_entities_account_display_name
    ON person_entities(account_id, display_name);

  CREATE TABLE person_evidence (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    upload_id TEXT NOT NULL,
    source_segment_id TEXT NOT NULL,
    quote TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    UNIQUE (account_id, upload_id, source_segment_id)
  );

  CREATE INDEX idx_person_evidence_account_upload
    ON person_evidence(account_id, upload_id, source_segment_id);

  CREATE TABLE person_names (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('display_name', 'alias')),
    status TEXT NOT NULL CHECK (status IN ('candidate', 'confirmed', 'rejected')),
    source TEXT NOT NULL CHECK (source IN (
      'transcript_candidate',
      'identity_profile',
      'date_companion_review',
      'manual_confirmation'
    )),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    FOREIGN KEY (person_id, account_id)
      REFERENCES person_entities(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (evidence_id, account_id)
      REFERENCES person_evidence(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_person_names_account_person
    ON person_names(account_id, person_id, status, kind);
  CREATE INDEX idx_person_names_account_normalized
    ON person_names(account_id, normalized_name);

  CREATE TABLE person_identity_links (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('candidate', 'confirmed', 'rejected')),
    source TEXT NOT NULL CHECK (source IN ('identity_profile', 'manual_confirmation')),
    confirmed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    UNIQUE (account_id, person_id, identity_id, evidence_id),
    CHECK (identity_id <> person_id),
    FOREIGN KEY (person_id, account_id)
      REFERENCES person_entities(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (evidence_id, account_id)
      REFERENCES person_evidence(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_person_identity_links_account_person
    ON person_identity_links(account_id, person_id, status);
  CREATE UNIQUE INDEX idx_person_identity_links_confirmed_identity
    ON person_identity_links(account_id, identity_id)
    WHERE status = 'confirmed';

  CREATE TABLE person_subject_observations (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    person_id TEXT,
    evidence_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('candidate', 'confirmed', 'unknown', 'rejected')),
    source TEXT NOT NULL CHECK (source IN ('manual_review', 'confirmed_identity', 'unknown')),
    reason TEXT NOT NULL,
    confirmed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    CHECK (
      (status = 'unknown' AND person_id IS NULL) OR
      (status <> 'unknown' AND person_id IS NOT NULL)
    ),
    FOREIGN KEY (person_id, account_id)
      REFERENCES person_entities(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (evidence_id, account_id)
      REFERENCES person_evidence(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_person_subject_observations_account_person
    ON person_subject_observations(account_id, person_id, status);
  CREATE INDEX idx_person_subject_observations_account_evidence
    ON person_subject_observations(account_id, evidence_id, status);
  CREATE UNIQUE INDEX idx_person_subject_observations_confirmed_evidence
    ON person_subject_observations(account_id, evidence_id)
    WHERE status = 'confirmed';
`;

const MEMORY_SCHEMA_V5 = `
  CREATE TABLE person_subject_resolution_audits (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    upload_id TEXT NOT NULL,
    source_segment_id TEXT NOT NULL,
    evidence_id TEXT,
    decision TEXT NOT NULL CHECK (decision IN (
      'confirmed',
      'candidate',
      'unknown',
      'ambiguous',
      'failed'
    )),
    person_id TEXT,
    identity_id TEXT,
    subject_observation_id TEXT,
    subject_observation_created INTEGER NOT NULL DEFAULT 0
      CHECK (subject_observation_created IN (0, 1)),
    candidate_person_ids_json TEXT NOT NULL DEFAULT '[]',
    reason_codes_json TEXT NOT NULL DEFAULT '[]',
    resolver_version INTEGER NOT NULL CHECK (resolver_version = 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    UNIQUE (account_id, upload_id, source_segment_id),
    CHECK (
      decision <> 'confirmed' OR
      (
        evidence_id IS NOT NULL AND
        person_id IS NOT NULL AND
        identity_id IS NOT NULL AND
        subject_observation_id IS NOT NULL
      )
    ),
    CHECK (
      decision = 'confirmed' OR
      (subject_observation_id IS NULL AND subject_observation_created = 0)
    ),
    CHECK (decision = 'failed' OR evidence_id IS NOT NULL),
    FOREIGN KEY (evidence_id, account_id)
      REFERENCES person_evidence(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (person_id, account_id)
      REFERENCES person_entities(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (subject_observation_id, account_id)
      REFERENCES person_subject_observations(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_person_subject_resolution_audits_account_upload
    ON person_subject_resolution_audits(account_id, upload_id, source_segment_id);
  CREATE INDEX idx_person_subject_resolution_audits_account_decision
    ON person_subject_resolution_audits(account_id, decision, updated_at DESC);
`;

const MEMORY_SCHEMA_V6 = `
  DROP INDEX idx_person_subject_observations_confirmed_evidence;

  CREATE UNIQUE INDEX idx_person_subject_observations_confirmed_person_evidence
    ON person_subject_observations(account_id, evidence_id, person_id)
    WHERE status = 'confirmed';

  CREATE TABLE person_relationships (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    person_a_id TEXT NOT NULL,
    person_b_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (
      length(type) BETWEEN 1 AND 64 AND
      type = lower(type) AND
      type GLOB '[a-z]*' AND
      type NOT GLOB '*[^a-z0-9_-]*'
    ),
    status TEXT NOT NULL CHECK (status IN ('candidate', 'confirmed', 'conflict', 'archived')),
    explicitly_confirmed INTEGER NOT NULL DEFAULT 0
      CHECK (explicitly_confirmed IN (0, 1)),
    confirmed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    UNIQUE (account_id, person_a_id, person_b_id, type),
    CHECK (person_a_id <> person_b_id),
    CHECK (
      status <> 'confirmed' OR
      (explicitly_confirmed = 1 AND confirmed_at IS NOT NULL)
    ),
    FOREIGN KEY (person_a_id, account_id)
      REFERENCES person_entities(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (person_b_id, account_id)
      REFERENCES person_entities(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_person_relationships_account_a
    ON person_relationships(account_id, person_a_id, status, updated_at DESC);
  CREATE INDEX idx_person_relationships_account_b
    ON person_relationships(account_id, person_b_id, status, updated_at DESC);

  CREATE TABLE person_relationship_evidence (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    UNIQUE (account_id, relationship_id, evidence_id),
    FOREIGN KEY (relationship_id, account_id)
      REFERENCES person_relationships(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (evidence_id, account_id)
      REFERENCES person_evidence(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_person_relationship_evidence_relationship
    ON person_relationship_evidence(account_id, relationship_id, created_at);
  CREATE INDEX idx_person_relationship_evidence_evidence
    ON person_relationship_evidence(account_id, evidence_id);
`;

const MEMORY_SCHEMA_V7 = `
  CREATE TABLE person_facts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    subject_person_id TEXT NOT NULL,
    relationship_id TEXT,
    kind TEXT NOT NULL CHECK (
      length(kind) BETWEEN 1 AND 64 AND
      kind = lower(kind) AND
      kind GLOB '[a-z]*' AND
      kind NOT GLOB '*[^a-z0-9_-]*'
    ),
    fact_key TEXT NOT NULL CHECK (
      length(fact_key) BETWEEN 1 AND 128 AND
      fact_key = lower(fact_key) AND
      fact_key GLOB '[a-z]*' AND
      fact_key NOT GLOB '*[^a-z0-9_.:-]*'
    ),
    derived_text TEXT NOT NULL CHECK (length(derived_text) BETWEEN 1 AND 4000),
    observed_at TEXT NOT NULL,
    valid_from TEXT,
    valid_to TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'resolved', 'superseded')),
    superseded_by TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from <= valid_to),
    CHECK (
      (status = 'superseded' AND superseded_by IS NOT NULL) OR
      (status <> 'superseded' AND superseded_by IS NULL)
    ),
    FOREIGN KEY (subject_person_id, account_id)
      REFERENCES person_entities(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (relationship_id, account_id)
      REFERENCES person_relationships(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_person_facts_account_subject
    ON person_facts(account_id, subject_person_id, status, observed_at DESC);
  CREATE INDEX idx_person_facts_account_key
    ON person_facts(account_id, subject_person_id, kind, fact_key, observed_at DESC);
  CREATE INDEX idx_person_facts_relationship
    ON person_facts(account_id, relationship_id, status);

  CREATE TABLE person_fact_evidence (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    UNIQUE (account_id, fact_id, evidence_id),
    FOREIGN KEY (fact_id, account_id)
      REFERENCES person_facts(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (evidence_id, account_id)
      REFERENCES person_evidence(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_person_fact_evidence_fact
    ON person_fact_evidence(account_id, fact_id, created_at);
  CREATE INDEX idx_person_fact_evidence_evidence
    ON person_fact_evidence(account_id, evidence_id);

  CREATE TABLE person_fact_transitions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    from_status TEXT NOT NULL CHECK (from_status = 'active'),
    to_status TEXT NOT NULL CHECK (to_status IN ('resolved', 'superseded')),
    observed_at TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    valid_to TEXT,
    replacement_fact_id TEXT,
    evidence_id TEXT NOT NULL,
    expected_version INTEGER NOT NULL CHECK (expected_version >= 1),
    resulting_version INTEGER NOT NULL CHECK (resulting_version = expected_version + 1),
    is_applied INTEGER NOT NULL DEFAULT 1 CHECK (is_applied IN (0, 1)),
    invalid_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    UNIQUE (account_id, fact_id, evidence_id, to_status),
    CHECK (
      (to_status = 'superseded' AND replacement_fact_id IS NOT NULL) OR
      (to_status = 'resolved' AND replacement_fact_id IS NULL)
    ),
    CHECK (
      (is_applied = 1 AND invalid_reason IS NULL) OR
      (is_applied = 0 AND invalid_reason IS NOT NULL)
    ),
    FOREIGN KEY (fact_id, account_id)
      REFERENCES person_facts(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (replacement_fact_id, account_id)
      REFERENCES person_facts(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (evidence_id, account_id)
      REFERENCES person_evidence(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_person_fact_transitions_fact
    ON person_fact_transitions(account_id, fact_id, occurred_at, created_at);
  CREATE INDEX idx_person_fact_transitions_evidence
    ON person_fact_transitions(account_id, evidence_id);

  CREATE TABLE person_commitments (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    relationship_id TEXT,
    promisor_person_id TEXT NOT NULL,
    promisee_person_id TEXT NOT NULL,
    text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
    status TEXT NOT NULL CHECK (
      status IN ('created', 'active', 'completed', 'cancelled', 'superseded')
    ),
    observed_at TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    resolved_at TEXT,
    superseded_by TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    CHECK (promisor_person_id <> promisee_person_id),
    CHECK (
      (status IN ('completed', 'cancelled', 'superseded') AND resolved_at IS NOT NULL) OR
      (status IN ('created', 'active') AND resolved_at IS NULL)
    ),
    CHECK (
      (status = 'superseded' AND superseded_by IS NOT NULL) OR
      (status <> 'superseded' AND superseded_by IS NULL)
    ),
    FOREIGN KEY (relationship_id, account_id)
      REFERENCES person_relationships(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (promisor_person_id, account_id)
      REFERENCES person_entities(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (promisee_person_id, account_id)
      REFERENCES person_entities(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_person_commitments_promisor
    ON person_commitments(account_id, promisor_person_id, status, occurred_at DESC);
  CREATE INDEX idx_person_commitments_promisee
    ON person_commitments(account_id, promisee_person_id, status, occurred_at DESC);
  CREATE INDEX idx_person_commitments_relationship
    ON person_commitments(account_id, relationship_id, status);

  CREATE TABLE person_commitment_evidence (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    commitment_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    UNIQUE (account_id, commitment_id, evidence_id),
    FOREIGN KEY (commitment_id, account_id)
      REFERENCES person_commitments(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (evidence_id, account_id)
      REFERENCES person_evidence(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_person_commitment_evidence_commitment
    ON person_commitment_evidence(account_id, commitment_id, created_at);
  CREATE INDEX idx_person_commitment_evidence_evidence
    ON person_commitment_evidence(account_id, evidence_id);

  CREATE TABLE person_commitment_transitions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    commitment_id TEXT NOT NULL,
    from_status TEXT NOT NULL CHECK (from_status IN ('created', 'active')),
    to_status TEXT NOT NULL CHECK (
      to_status IN ('active', 'completed', 'cancelled', 'superseded')
    ),
    observed_at TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    replacement_commitment_id TEXT,
    evidence_id TEXT NOT NULL,
    expected_version INTEGER NOT NULL CHECK (expected_version >= 1),
    resulting_version INTEGER NOT NULL CHECK (resulting_version = expected_version + 1),
    is_applied INTEGER NOT NULL DEFAULT 1 CHECK (is_applied IN (0, 1)),
    invalid_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    UNIQUE (account_id, commitment_id, evidence_id, to_status),
    CHECK (
      (from_status = 'created' AND to_status IN ('active', 'cancelled', 'superseded')) OR
      (from_status = 'active' AND to_status IN ('completed', 'cancelled', 'superseded'))
    ),
    CHECK (
      (to_status = 'superseded' AND replacement_commitment_id IS NOT NULL) OR
      (to_status <> 'superseded' AND replacement_commitment_id IS NULL)
    ),
    CHECK (
      (is_applied = 1 AND invalid_reason IS NULL) OR
      (is_applied = 0 AND invalid_reason IS NOT NULL)
    ),
    FOREIGN KEY (commitment_id, account_id)
      REFERENCES person_commitments(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (replacement_commitment_id, account_id)
      REFERENCES person_commitments(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (evidence_id, account_id)
      REFERENCES person_evidence(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_person_commitment_transitions_commitment
    ON person_commitment_transitions(account_id, commitment_id, occurred_at, created_at);
  CREATE INDEX idx_person_commitment_transitions_evidence
    ON person_commitment_transitions(account_id, evidence_id);
`;

const MEMORY_SCHEMA_V8 = `
  CREATE TABLE person_entity_admissions (
    account_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    is_unnamed INTEGER NOT NULL DEFAULT 0 CHECK (is_unnamed IN (0, 1)),
    explicitly_confirmed INTEGER NOT NULL DEFAULT 0
      CHECK (explicitly_confirmed IN (0, 1)),
    confirmed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, person_id),
    CHECK (
      (explicitly_confirmed = 1 AND confirmed_at IS NOT NULL) OR
      (explicitly_confirmed = 0 AND confirmed_at IS NULL)
    ),
    FOREIGN KEY (person_id, account_id)
      REFERENCES person_entities(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_person_entity_admissions_account_updated
    ON person_entity_admissions(account_id, updated_at DESC, person_id);

  CREATE TABLE person_relationship_admissions (
    account_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, relationship_id),
    FOREIGN KEY (relationship_id, account_id)
      REFERENCES person_relationships(id, account_id) ON DELETE CASCADE
  );

  CREATE TABLE person_subject_admissions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    person_id TEXT,
    subject_key TEXT NOT NULL,
    observation_id TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK (
      disposition IN ('candidate', 'confirmed', 'rejected', 'unknown')
    ),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    UNIQUE (account_id, evidence_id, subject_key),
    UNIQUE (account_id, observation_id),
    CHECK (
      (disposition = 'unknown' AND person_id IS NULL AND subject_key = 'unknown') OR
      (disposition <> 'unknown' AND person_id IS NOT NULL AND subject_key = person_id)
    ),
    FOREIGN KEY (evidence_id, account_id)
      REFERENCES person_evidence(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (person_id, account_id)
      REFERENCES person_entities(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (observation_id, account_id)
      REFERENCES person_subject_observations(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_person_subject_admissions_evidence
    ON person_subject_admissions(account_id, evidence_id, disposition);
  CREATE INDEX idx_person_subject_admissions_person
    ON person_subject_admissions(account_id, person_id, disposition);

  CREATE TABLE person_self_bindings (
    account_id TEXT PRIMARY KEY,
    person_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'cleared')),
    version INTEGER NOT NULL CHECK (version >= 1),
    set_at TEXT,
    cleared_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (status = 'active' AND person_id IS NOT NULL AND set_at IS NOT NULL AND cleared_at IS NULL) OR
      (status = 'cleared' AND person_id IS NULL AND set_at IS NULL AND cleared_at IS NOT NULL)
    ),
    FOREIGN KEY (person_id, account_id)
      REFERENCES person_entities(id, account_id) ON DELETE CASCADE
  );

  CREATE TABLE person_admission_audits (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (
      entity_type IN ('person', 'self_binding', 'subject', 'relationship')
    ),
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN (
      'person_created', 'person_confirmed', 'person_renamed', 'person_archived',
      'self_set', 'self_replaced', 'self_cleared',
      'subject_candidate', 'subject_confirmed', 'subject_rejected', 'subject_unknown',
      'relationship_candidate', 'relationship_confirmed',
      'relationship_conflict', 'relationship_archived'
    )),
    from_state TEXT,
    to_state TEXT NOT NULL,
    previous_value TEXT,
    new_value TEXT,
    evidence_id TEXT,
    resulting_version INTEGER NOT NULL CHECK (resulting_version >= 1),
    created_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    UNIQUE (
      account_id, entity_type, entity_id, action, resulting_version
    ),
    FOREIGN KEY (evidence_id, account_id)
      REFERENCES person_evidence(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_person_admission_audits_entity
    ON person_admission_audits(account_id, entity_type, entity_id, created_at);
  CREATE INDEX idx_person_admission_audits_evidence
    ON person_admission_audits(account_id, evidence_id);
`;

const MEMORY_SCHEMA_V9 = `
  CREATE TABLE memory_evidence_provenance (
    memory_evidence_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    upload_id TEXT NOT NULL,
    source_segment_id TEXT NOT NULL,
    start_seconds REAL NOT NULL CHECK (start_seconds >= 0),
    end_seconds REAL NOT NULL CHECK (end_seconds > start_seconds),
    speaker_id TEXT,
    source_kind TEXT NOT NULL CHECK (source_kind = 'transcript'),
    origin TEXT NOT NULL CHECK (origin = 'date_companion_retention'),
    content_digest TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    UNIQUE (user_id, memory_evidence_id),
    FOREIGN KEY (memory_evidence_id)
      REFERENCES memory_evidence(id) ON DELETE CASCADE
  );

  CREATE INDEX idx_memory_evidence_provenance_upload
    ON memory_evidence_provenance(user_id, upload_id, source_segment_id);

  CREATE TABLE dc_retained_uploads (
    user_id TEXT NOT NULL,
    upload_id TEXT NOT NULL,
    dc_relationship_id TEXT NOT NULL,
    dc_interaction_id TEXT NOT NULL,
    provenance_count INTEGER NOT NULL CHECK (provenance_count >= 0),
    provenance_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'purged')),
    captured_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, upload_id)
  );

  CREATE INDEX idx_dc_retained_uploads_relationship
    ON dc_retained_uploads(user_id, dc_relationship_id, status, updated_at);

  CREATE TABLE person_evidence_dc_links (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    person_evidence_id TEXT NOT NULL,
    dc_relationship_id TEXT NOT NULL,
    dc_interaction_id TEXT NOT NULL,
    dc_evidence_snapshot_id TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    UNIQUE (account_id, person_evidence_id, dc_evidence_snapshot_id),
    FOREIGN KEY (person_evidence_id, account_id)
      REFERENCES person_evidence(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_person_evidence_dc_links_relationship
    ON person_evidence_dc_links(account_id, dc_relationship_id, dc_interaction_id);

  CREATE TABLE dc_person_relationship_links (
    account_id TEXT NOT NULL,
    dc_relationship_id TEXT NOT NULL,
    person_relationship_id TEXT NOT NULL,
    mapping_version INTEGER NOT NULL CHECK (mapping_version >= 1),
    self_person_id TEXT NOT NULL,
    companion_person_id TEXT NOT NULL,
    relationship_type TEXT NOT NULL CHECK (
      relationship_type IN ('dating', 'partner', 'friend', 'other')
    ),
    status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, dc_relationship_id),
    CHECK (self_person_id <> companion_person_id),
    FOREIGN KEY (person_relationship_id, account_id)
      REFERENCES person_relationships(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (self_person_id, account_id)
      REFERENCES person_entities(id, account_id) ON DELETE CASCADE,
    FOREIGN KEY (companion_person_id, account_id)
      REFERENCES person_entities(id, account_id) ON DELETE CASCADE
  );

  CREATE TABLE dc_memory_bridge_receipts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    dc_relationship_id TEXT NOT NULL,
    dc_interaction_id TEXT NOT NULL,
    dc_outbox_id TEXT NOT NULL,
    mapping_version INTEGER NOT NULL CHECK (mapping_version >= 1),
    committed_at TEXT NOT NULL,
    UNIQUE (id, account_id),
    UNIQUE (account_id, idempotency_key)
  );

  CREATE INDEX idx_dc_memory_bridge_receipts_interaction
    ON dc_memory_bridge_receipts(account_id, dc_interaction_id, committed_at);
`;

const MEMORY_SCHEMA_V10 = `
  CREATE TABLE memory_daily_reflection_publications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    confirmation_id TEXT NOT NULL,
    upload_id TEXT NOT NULL,
    confirmation_fingerprint TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    source_origin TEXT NOT NULL CHECK (source_origin = 'user_reflection'),
    status TEXT NOT NULL CHECK (status IN ('unpublished', 'published', 'deleted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE (id, user_id),
    UNIQUE (user_id, reflection_id),
    UNIQUE (user_id, confirmation_id),
    UNIQUE (user_id, upload_id),
    CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
  );

  CREATE INDEX idx_memory_daily_reflection_publications_visibility
    ON memory_daily_reflection_publications(user_id, status, upload_id);

  CREATE TABLE memory_daily_reflection_candidate_receipts (
    user_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('admitted', 'rejected')),
    memory_id TEXT,
    reason_code TEXT,
    operation_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, publication_id, candidate_id),
    UNIQUE (user_id, operation_key),
    CHECK ((status = 'admitted') = (memory_id IS NOT NULL)),
    CHECK ((status = 'rejected') = (reason_code IS NOT NULL)),
    FOREIGN KEY (publication_id, user_id)
      REFERENCES memory_daily_reflection_publications(id, user_id) ON DELETE CASCADE
  );

  CREATE TABLE memory_daily_reflection_evidence_provenance (
    memory_evidence_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    confirmation_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    upload_id TEXT NOT NULL,
    source_segment_id TEXT NOT NULL,
    source_origin TEXT NOT NULL CHECK (source_origin = 'user_reflection'),
    content_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, publication_id, candidate_id, source_segment_id),
    FOREIGN KEY (publication_id, user_id)
      REFERENCES memory_daily_reflection_publications(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (memory_evidence_id)
      REFERENCES memory_evidence(id) ON DELETE CASCADE
  );

  CREATE INDEX idx_memory_daily_reflection_evidence_source
    ON memory_daily_reflection_evidence_provenance(
      user_id, upload_id, source_segment_id, candidate_id
    );

  CREATE TABLE memory_upload_tombstones (
    user_id TEXT NOT NULL,
    upload_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason = 'upload_deleted'),
    deleted_at TEXT NOT NULL,
    PRIMARY KEY (user_id, upload_id)
  );
`;

const MEMORY_SCHEMA_V11 = `
  CREATE TRIGGER memory_daily_reflection_candidate_receipts_immutable
  BEFORE UPDATE ON memory_daily_reflection_candidate_receipts
  BEGIN
    SELECT RAISE(ABORT, 'memory_daily_reflection_candidate_receipt_immutable');
  END;

  CREATE TABLE memory_daily_reflection_candidate_payloads (
    user_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    confirmation_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    memory_json TEXT NOT NULL,
    owner_attribution_json TEXT NOT NULL,
    subject_person_id TEXT,
    payload_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, publication_id, candidate_id),
    FOREIGN KEY (publication_id, user_id)
      REFERENCES memory_daily_reflection_publications(id, user_id) ON DELETE CASCADE
  );

  CREATE TABLE memory_daily_reflection_candidate_current_memories (
    user_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    confirmation_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    current_memory_id TEXT,
    revocation_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revoked_at TEXT,
    PRIMARY KEY (user_id, publication_id, candidate_id),
    CHECK ((status = 'active') = (current_memory_id IS NOT NULL)),
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
    FOREIGN KEY (publication_id, user_id)
      REFERENCES memory_daily_reflection_publications(id, user_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_memory_daily_reflection_current_memory
    ON memory_daily_reflection_candidate_current_memories(
      user_id, current_memory_id, status
    );

  CREATE TABLE memory_daily_reflection_candidate_person_sources (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    confirmation_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    person_evidence_id TEXT NOT NULL,
    subject_admission_id TEXT NOT NULL,
    subject_observation_id TEXT NOT NULL,
    source_segment_id TEXT NOT NULL,
    owns_person_evidence INTEGER NOT NULL CHECK (owns_person_evidence IN (0, 1)),
    owns_subject_admission INTEGER NOT NULL CHECK (owns_subject_admission IN (0, 1)),
    owns_subject_observation INTEGER NOT NULL CHECK (owns_subject_observation IN (0, 1)),
    previous_subject_admission_json TEXT,
    previous_subject_observation_json TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    revocation_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revoked_at TEXT,
    UNIQUE (user_id, publication_id, candidate_id, person_evidence_id, person_id),
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
    FOREIGN KEY (publication_id, user_id)
      REFERENCES memory_daily_reflection_publications(id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (person_id, user_id)
      REFERENCES person_entities(id, account_id) ON DELETE CASCADE
  );

  CREATE INDEX idx_memory_daily_reflection_person_source_active
    ON memory_daily_reflection_candidate_person_sources(
      user_id, person_evidence_id, person_id, status
    );

  CREATE TABLE memory_daily_reflection_candidate_revocations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    reflection_id TEXT NOT NULL,
    confirmation_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    upload_id TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome = 'revoked'),
    historical_memory_id TEXT NOT NULL,
    removed_memory_evidence_count INTEGER NOT NULL CHECK (
      removed_memory_evidence_count >= 0
    ),
    removed_person_source_count INTEGER NOT NULL CHECK (
      removed_person_source_count >= 0
    ),
    created_at TEXT NOT NULL,
    UNIQUE (id, user_id),
    UNIQUE (user_id, operation_key),
    UNIQUE (user_id, reflection_id, candidate_id),
    FOREIGN KEY (publication_id, user_id)
      REFERENCES memory_daily_reflection_publications(id, user_id) ON DELETE CASCADE
  );

  INSERT INTO memory_daily_reflection_candidate_current_memories (
    user_id, publication_id, reflection_id, confirmation_id, candidate_id,
    status, current_memory_id, revocation_id, created_at, updated_at, revoked_at
  )
  SELECT receipt.user_id, receipt.publication_id, publication.reflection_id,
    publication.confirmation_id, receipt.candidate_id, 'active',
    COALESCE(MIN(evidence.memory_id), receipt.memory_id), NULL,
    receipt.created_at, receipt.created_at, NULL
  FROM memory_daily_reflection_candidate_receipts receipt
  INNER JOIN memory_daily_reflection_publications publication
    ON publication.id = receipt.publication_id AND publication.user_id = receipt.user_id
  LEFT JOIN memory_daily_reflection_evidence_provenance provenance
    ON provenance.user_id = receipt.user_id
    AND provenance.publication_id = receipt.publication_id
    AND provenance.candidate_id = receipt.candidate_id
  LEFT JOIN memory_evidence evidence ON evidence.id = provenance.memory_evidence_id
  WHERE receipt.status = 'admitted'
  GROUP BY receipt.user_id, receipt.publication_id, publication.reflection_id,
    publication.confirmation_id, receipt.candidate_id, receipt.memory_id, receipt.created_at;
`;

const MEMORY_SCHEMA_V12 = `
  ALTER TABLE dc_person_relationship_links
    ADD COLUMN relationship_epoch INTEGER NOT NULL DEFAULT 0
      CHECK (relationship_epoch >= 0);
`;

const MEMORY_SCHEMA_V13 = `
  CREATE UNIQUE INDEX idx_dc_memory_bridge_receipts_account_receipt
    ON dc_memory_bridge_receipts(account_id, id);

  CREATE TABLE dc_memory_bridge_candidate_receipts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    operation_receipt_id TEXT NOT NULL,
    dc_outbox_id TEXT NOT NULL,
    dc_interaction_id TEXT NOT NULL,
    recap_item_id TEXT NOT NULL,
    origin_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('admitted', 'rejected')),
    memory_id TEXT,
    score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
    reasons_json TEXT NOT NULL,
    evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
    created_at TEXT NOT NULL,
    UNIQUE (account_id, operation_receipt_id, recap_item_id),
    CHECK (
      (status = 'admitted' AND memory_id IS NOT NULL)
      OR (status = 'rejected' AND memory_id IS NULL)
    ),
    FOREIGN KEY (account_id, operation_receipt_id)
      REFERENCES dc_memory_bridge_receipts(account_id, id) ON DELETE CASCADE
  );

  CREATE INDEX idx_dc_memory_bridge_candidate_receipts_interaction
    ON dc_memory_bridge_candidate_receipts(account_id, dc_interaction_id, created_at);

  CREATE TRIGGER dc_memory_bridge_candidate_receipts_immutable
  BEFORE UPDATE ON dc_memory_bridge_candidate_receipts
  BEGIN
    SELECT RAISE(ABORT, 'dc_memory_bridge_candidate_receipt_immutable');
  END;
`;

const MIGRATIONS = [
  { version: 1, sql: MEMORY_SCHEMA_V1 },
  { version: 2, sql: MEMORY_SCHEMA_V2 },
  { version: 3, sql: MEMORY_SCHEMA_V3 },
  { version: 4, sql: MEMORY_SCHEMA_V4 },
  { version: 5, sql: MEMORY_SCHEMA_V5 },
  { version: 6, sql: MEMORY_SCHEMA_V6 },
  { version: 7, sql: MEMORY_SCHEMA_V7 },
  { version: 8, sql: MEMORY_SCHEMA_V8 },
  { version: 9, sql: MEMORY_SCHEMA_V9 },
  { version: 10, sql: MEMORY_SCHEMA_V10 },
  { version: 11, sql: MEMORY_SCHEMA_V11 },
  { version: 12, sql: MEMORY_SCHEMA_V12 },
  { version: 13, sql: MEMORY_SCHEMA_V13 }
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
