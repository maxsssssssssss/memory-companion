import { createHash } from "node:crypto";
import type { LearningRepository } from "./repository";
import { LearningError } from "./repository";

export type LearningAgentArtifact = { id: string; task_id: string; task_version: number; page_id: string; account_id: string; kind: "quiz" | "explanation" | "note_proposal" | "review_summary" | "review_plan" | "completion_assessment" | "evidence_proposal" | "explanation_feedback" | "check_purpose" | "completion_feedback";
  action_id: string; binding_hash: string; state: "reserved" | "completed" | "failed" | "unknown" | "invalidated"; body_json: string | null };

export function learningAgentOperationId(actionId: string, kind: string) {
  const hex = createHash("sha256").update(`learning-agent-v1:${kind}:${actionId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Learning owns explanations and quiz links; shared Agent storage owns tasks,
 * actions and waiting. This table is not another checkpoint authority. */
export class LearningAgentRepository {
  constructor(private learning: LearningRepository) {
    learning.database.exec(`CREATE TABLE IF NOT EXISTS learning_agent_artifacts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, task_version INTEGER NOT NULL DEFAULT 1, page_id TEXT NOT NULL, account_id TEXT NOT NULL,
      kind TEXT NOT NULL, action_id TEXT NOT NULL, binding_hash TEXT NOT NULL,
      material_ids TEXT NOT NULL, state TEXT NOT NULL, body_json TEXT, created_at TEXT NOT NULL,
      UNIQUE(task_id,action_id)
    );
    CREATE INDEX IF NOT EXISTS learning_agent_artifacts_task ON learning_agent_artifacts(task_id,page_id);
    CREATE TRIGGER IF NOT EXISTS learning_agent_material_removed AFTER UPDATE OF deleted_at ON learning_materials
      WHEN NEW.deleted_at IS NOT NULL BEGIN
      UPDATE learning_agent_artifacts SET state='invalidated',body_json=NULL WHERE page_id=NEW.page_id
        AND EXISTS(SELECT 1 FROM json_each(material_ids) WHERE value=NEW.id);
    END;
    CREATE TRIGGER IF NOT EXISTS learning_agent_page_removed AFTER UPDATE OF deleted_at ON learning_pages
      WHEN NEW.deleted_at IS NOT NULL BEGIN
      DELETE FROM learning_agent_artifacts WHERE page_id=NEW.id;
    END;`);
    const columns = learning.database.prepare("PRAGMA table_info(learning_agent_artifacts)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "task_version")) learning.database.exec("ALTER TABLE learning_agent_artifacts ADD COLUMN task_version INTEGER NOT NULL DEFAULT 1");
  }
  get(pageId: string, taskId: string, id: string) {
    this.learning.get(pageId);
    return this.learning.database.prepare("SELECT * FROM learning_agent_artifacts WHERE id=? AND task_id=? AND page_id=? AND account_id=?")
      .get(id, taskId, pageId, this.learning.accountId) as LearningAgentArtifact | undefined;
  }
  list(pageId: string, taskId: string) {
    this.learning.get(pageId);
    return this.learning.database.prepare("SELECT * FROM learning_agent_artifacts WHERE task_id=? AND page_id=? AND account_id=? ORDER BY rowid")
      .all(taskId, pageId, this.learning.accountId) as LearningAgentArtifact[];
  }
  quizOwners(pageId: string, attemptId: string) {
    this.learning.get(pageId);
    return this.learning.database.prepare("SELECT task_id,task_version FROM learning_agent_artifacts WHERE page_id=? AND account_id=? AND kind='quiz' AND state='completed' AND json_extract(body_json,'$.attemptId')=?")
      .all(pageId, this.learning.accountId, attemptId) as Array<{ task_id: string; task_version: number }>;
  }
  reserve(value: { id: string; taskId: string; taskVersion?: number; pageId: string; kind: LearningAgentArtifact["kind"]; actionId: string; binding: string; materialIds: string[] }) {
    this.learning.get(value.pageId);
    return this.learning.database.transaction(() => {
      const old = this.get(value.pageId, value.taskId, value.id);
      if (old) {
        if (old.action_id !== value.actionId || old.binding_hash !== value.binding || old.kind !== value.kind || old.task_version !== (value.taskVersion ?? 1)) throw new LearningError(409, "submission_conflict");
        return old;
      }
      this.learning.database.prepare("INSERT INTO learning_agent_artifacts(id,task_id,task_version,page_id,account_id,kind,action_id,binding_hash,material_ids,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,'reserved',?)")
        .run(value.id, value.taskId, value.taskVersion ?? 1, value.pageId, this.learning.accountId, value.kind, value.actionId, value.binding, JSON.stringify(value.materialIds), new Date().toISOString());
      return undefined;
    }).immediate();
  }
  savePreview(pageId: string, taskId: string, id: string, body: unknown) {
    this.learning.get(pageId);
    const saved = this.learning.database.prepare("UPDATE learning_agent_artifacts SET body_json=? WHERE id=? AND task_id=? AND page_id=? AND account_id=? AND kind='note_proposal' AND state='reserved' AND body_json IS NULL")
      .run(JSON.stringify(body), id, taskId, pageId, this.learning.accountId);
    if (!saved.changes) throw new LearningError(409, "agent_preview_conflict");
  }
  invalidateNotePreviews(pageId: string, taskId: string, keepVersion?: number) {
    this.learning.get(pageId);
    this.learning.database.prepare("UPDATE learning_agent_artifacts SET state='invalidated',body_json=NULL WHERE task_id=? AND page_id=? AND account_id=? AND kind='note_proposal' AND state='reserved' AND (? IS NULL OR task_version<>?)")
      .run(taskId, pageId, this.learning.accountId, keepVersion ?? null, keepVersion ?? null);
  }
  complete(pageId: string, taskId: string, id: string, body: unknown) {
    this.learning.get(pageId);
    const result = this.learning.database.prepare("UPDATE learning_agent_artifacts SET state='completed',body_json=? WHERE id=? AND task_id=? AND page_id=? AND account_id=? AND state='reserved'")
      .run(JSON.stringify(body), id, taskId, pageId, this.learning.accountId);
    if (!result.changes) throw new LearningError(409, "agent_artifact_invalidated");
  }
  fail(pageId: string, taskId: string, id: string, unknown: boolean) {
    this.learning.database.prepare("UPDATE learning_agent_artifacts SET state=? WHERE id=? AND task_id=? AND page_id=? AND account_id=? AND state='reserved'")
      .run(unknown ? "unknown" : "failed", id, taskId, pageId, this.learning.accountId);
  }
  retryKnownFailure(pageId: string, taskId: string, id: string, version: number, binding: string) {
    this.learning.get(pageId);
    const result = this.learning.database.prepare("UPDATE learning_agent_artifacts SET state='reserved',body_json=NULL WHERE id=? AND task_id=? AND page_id=? AND account_id=? AND task_version=? AND binding_hash=? AND state='failed'")
      .run(id, taskId, pageId, this.learning.accountId, version, binding);
    if (!result.changes) throw new LearningError(409, "agent_retry_conflict");
  }
  dispute(pageId: string, taskId: string, attemptId: string, eventId?: string) {
    this.learning.get(pageId);
    this.learning.database.prepare("UPDATE learning_agent_artifacts SET body_json=json_set(body_json,'$.disputed',json('true'),'$.disputeEventId',coalesce(json_extract(body_json,'$.disputeEventId'),?)) WHERE task_id=? AND page_id=? AND account_id=? AND kind='quiz' AND state='completed' AND json_extract(body_json,'$.attemptId')=?")
      .run(eventId ?? null, taskId, pageId, this.learning.accountId, attemptId);
    this.learning.database.prepare("UPDATE learning_agent_artifacts SET state='invalidated',body_json=NULL WHERE task_id=? AND page_id=? AND account_id=? AND kind IN ('review_summary','completion_assessment') AND state IN ('reserved','completed')")
      .run(taskId, pageId, this.learning.accountId);
  }
}
