/** Cross-meeting facts only. Meetings, Findings, Todos and AgentRuntime keep their authorities. */
export const WORK_AGENT_SCHEMA_V10 = `
  CREATE TABLE wr_work_threads (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, project_id TEXT NOT NULL,
    anchor_finding_id TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(id, account_id, project_id), UNIQUE(account_id, project_id, anchor_finding_id),
    FOREIGN KEY(project_id, account_id) REFERENCES wr_projects(id, account_id)
  );
  CREATE TABLE wr_work_thread_events (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, project_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    relation TEXT NOT NULL CHECK(relation IN ('records','suspends','supersedes','withdraws','resolves','reopens','tracks','retracts')),
    finding_id TEXT, target_finding_id TEXT, todo_id TEXT, retracts_id TEXT, label TEXT,
    operation_key TEXT NOT NULL, semantic_key TEXT NOT NULL,
    confirmed_by TEXT NOT NULL, confirmed_at TEXT NOT NULL, meeting_date TEXT NOT NULL,
    invalidated INTEGER NOT NULL DEFAULT 0 CHECK(invalidated IN (0,1)),
    UNIQUE(account_id, project_id, operation_key),
    FOREIGN KEY(thread_id, account_id, project_id) REFERENCES wr_work_threads(id, account_id, project_id)
  );
  CREATE INDEX idx_wr_work_event_semantics ON wr_work_thread_events(account_id, project_id, semantic_key);
  CREATE TABLE wr_work_thread_event_sources (
    event_id TEXT NOT NULL REFERENCES wr_work_thread_events(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL, project_id TEXT NOT NULL, meeting_id TEXT NOT NULL,
    finding_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    PRIMARY KEY(event_id, finding_id)
  );
  CREATE INDEX idx_wr_work_sources_meeting ON wr_work_thread_event_sources(account_id, meeting_id, project_id);
  CREATE TABLE wr_work_agent_artifacts (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, project_id TEXT NOT NULL, meeting_id TEXT NOT NULL,
    task_id TEXT NOT NULL, task_version INTEGER NOT NULL, source_fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('compared','preview','applied','invalidated')),
    comparison_json TEXT, coverage_json TEXT, preview_json TEXT, applied_json TEXT,
    apply_action_id TEXT, created_at TEXT NOT NULL,
    UNIQUE(account_id, task_id, task_version), UNIQUE(account_id, apply_action_id),
    FOREIGN KEY(project_id, account_id) REFERENCES wr_projects(id, account_id)
  );
  CREATE TABLE wr_work_agent_artifact_sources (
    artifact_id TEXT NOT NULL REFERENCES wr_work_agent_artifacts(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL, project_id TEXT NOT NULL, meeting_id TEXT NOT NULL,
    finding_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    PRIMARY KEY(artifact_id, finding_id)
  );
  CREATE INDEX idx_wr_work_artifacts_project ON wr_work_agent_artifacts(account_id, project_id, created_at);

  -- Invalid transitions remain as content-free barriers; removing B must not revive A.
  CREATE TRIGGER wr_work_agent_unlink_meeting AFTER DELETE ON wr_meeting_projects BEGIN
    UPDATE wr_work_thread_events SET invalidated=1, label=NULL
      WHERE account_id=OLD.account_id AND project_id=OLD.project_id AND id IN
        (SELECT event_id FROM wr_work_thread_event_sources WHERE account_id=OLD.account_id AND project_id=OLD.project_id AND meeting_id=OLD.meeting_id);
    UPDATE wr_work_agent_artifacts SET state='invalidated', comparison_json=NULL, preview_json=NULL, coverage_json=NULL
      WHERE account_id=OLD.account_id AND project_id=OLD.project_id AND
        (meeting_id=OLD.meeting_id OR id IN (SELECT artifact_id FROM wr_work_agent_artifact_sources
          WHERE account_id=OLD.account_id AND project_id=OLD.project_id AND meeting_id=OLD.meeting_id));
  END;
  CREATE TRIGGER wr_work_agent_delete_finding BEFORE DELETE ON wr_findings BEGIN
    UPDATE wr_work_thread_events SET invalidated=1, label=NULL WHERE id IN
      (SELECT event_id FROM wr_work_thread_event_sources WHERE account_id=OLD.account_id AND finding_id=OLD.id);
    UPDATE wr_work_agent_artifacts SET state='invalidated', comparison_json=NULL, preview_json=NULL, coverage_json=NULL WHERE id IN
      (SELECT artifact_id FROM wr_work_agent_artifact_sources WHERE account_id=OLD.account_id AND finding_id=OLD.id);
  END;
  CREATE TRIGGER wr_work_agent_change_finding AFTER UPDATE ON wr_findings WHEN
    NEW.version<>OLD.version OR NEW.body<>OLD.body OR NEW.title<>OLD.title OR NEW.structured_data_json<>OLD.structured_data_json BEGIN
    UPDATE wr_work_thread_events SET invalidated=1, label=NULL WHERE id IN
      (SELECT event_id FROM wr_work_thread_event_sources WHERE account_id=OLD.account_id AND finding_id=OLD.id);
    UPDATE wr_work_agent_artifacts SET state='invalidated', comparison_json=NULL, preview_json=NULL, coverage_json=NULL WHERE id IN
      (SELECT artifact_id FROM wr_work_agent_artifact_sources WHERE account_id=OLD.account_id AND finding_id=OLD.id);
  END;
  CREATE TRIGGER wr_work_agent_delete_project AFTER UPDATE OF deleted_at ON wr_projects WHEN NEW.deleted_at IS NOT NULL BEGIN
    UPDATE wr_work_thread_events SET invalidated=1, label=NULL WHERE account_id=NEW.account_id AND project_id=NEW.id;
    UPDATE wr_work_agent_artifacts SET state='invalidated', comparison_json=NULL, preview_json=NULL, coverage_json=NULL
      WHERE account_id=NEW.account_id AND project_id=NEW.id;
  END;
  CREATE TRIGGER wr_work_agent_delete_todo AFTER UPDATE OF deleted_at ON wr_todos WHEN NEW.deleted_at IS NOT NULL BEGIN
    UPDATE wr_work_thread_events SET invalidated=1, label=NULL WHERE account_id=NEW.account_id AND todo_id=NEW.id;
    UPDATE wr_work_agent_artifacts SET state='invalidated', comparison_json=NULL, preview_json=NULL, coverage_json=NULL
      WHERE account_id=NEW.account_id AND preview_json IS NOT NULL AND EXISTS
        (SELECT 1 FROM json_each(preview_json, '$.changes') WHERE json_extract(value, '$.change.todoId')=NEW.id);
  END;
  CREATE TRIGGER wr_work_agent_unlink_todo AFTER DELETE ON wr_todo_projects BEGIN
    UPDATE wr_work_thread_events SET invalidated=1,label=NULL WHERE account_id=OLD.account_id AND project_id=OLD.project_id AND todo_id=OLD.todo_id;
    UPDATE wr_work_agent_artifacts SET state='invalidated',comparison_json=NULL,preview_json=NULL,coverage_json=NULL
      WHERE account_id=OLD.account_id AND project_id=OLD.project_id AND preview_json IS NOT NULL AND EXISTS
        (SELECT 1 FROM json_each(preview_json,'$.changes') WHERE json_extract(value,'$.change.todoId')=OLD.todo_id);
  END;
  CREATE TRIGGER wr_work_agent_delete_canonical BEFORE DELETE ON wr_canonical_publications BEGIN
    UPDATE wr_work_thread_events SET invalidated=1,label=NULL WHERE id IN
      (SELECT event_id FROM wr_work_thread_event_sources WHERE account_id=OLD.account_id AND meeting_id=OLD.meeting_id);
    UPDATE wr_work_agent_artifacts SET state='invalidated',comparison_json=NULL,preview_json=NULL,coverage_json=NULL WHERE id IN
      (SELECT artifact_id FROM wr_work_agent_artifact_sources WHERE account_id=OLD.account_id AND meeting_id=OLD.meeting_id);
  END;
  CREATE TRIGGER wr_work_agent_change_canonical AFTER UPDATE OF payload_json ON wr_canonical_publications WHEN NEW.payload_json<>OLD.payload_json BEGIN
    UPDATE wr_work_thread_events SET invalidated=1,label=NULL WHERE id IN
      (SELECT event_id FROM wr_work_thread_event_sources WHERE account_id=OLD.account_id AND meeting_id=OLD.meeting_id);
    UPDATE wr_work_agent_artifacts SET state='invalidated',comparison_json=NULL,preview_json=NULL,coverage_json=NULL WHERE id IN
      (SELECT artifact_id FROM wr_work_agent_artifact_sources WHERE account_id=OLD.account_id AND meeting_id=OLD.meeting_id);
  END;
`;
