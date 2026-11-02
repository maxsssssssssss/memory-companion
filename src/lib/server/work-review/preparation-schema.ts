/** Editable meeting documents; never an authority for project decisions or Todo status. */
export const WORK_PREPARATION_SCHEMA_V11 = `
  CREATE TABLE wr_meeting_preparations (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, project_id TEXT NOT NULL,
    task_id TEXT NOT NULL UNIQUE, goal TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL CHECK(state IN ('draft','saved','linked','awaiting_review','reviewed')),
    source_fingerprint TEXT NOT NULL, bindings_json TEXT NOT NULL,
    snapshot_json TEXT, generated_json TEXT, agenda_json TEXT NOT NULL,
    meeting_id TEXT, review_json TEXT, follow_up_task_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(id, account_id, project_id),
    FOREIGN KEY(project_id, account_id) REFERENCES wr_projects(id, account_id)
  );
  CREATE INDEX idx_wr_preparations_project ON wr_meeting_preparations(account_id, project_id, created_at);
  CREATE TABLE wr_meeting_preparation_operations (
    account_id TEXT NOT NULL, project_id TEXT NOT NULL, preparation_id TEXT NOT NULL,
    operation_key TEXT NOT NULL, payload_digest TEXT NOT NULL, action TEXT NOT NULL,
    result_version INTEGER NOT NULL, meeting_id TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY(account_id, operation_key),
    FOREIGN KEY(preparation_id, account_id, project_id) REFERENCES wr_meeting_preparations(id, account_id, project_id)
  );
  CREATE TRIGGER wr_preparation_delete_project AFTER UPDATE OF deleted_at ON wr_projects
    WHEN NEW.deleted_at IS NOT NULL BEGIN
    DELETE FROM wr_meeting_preparation_operations WHERE account_id=NEW.account_id AND project_id=NEW.id;
    DELETE FROM wr_meeting_preparations WHERE account_id=NEW.account_id AND project_id=NEW.id;
  END;
`;
