export const LEARNING_QUIZ_SCHEMA = `
CREATE TABLE IF NOT EXISTS learning_quiz_runs (
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES learning_pages(id), settings_json TEXT NOT NULL,
  binding_json TEXT NOT NULL, binding_hash TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, deadline INTEGER NOT NULL, failure TEXT, result_json TEXT, diagnostics_json TEXT
);
CREATE INDEX IF NOT EXISTS learning_quiz_page ON learning_quiz_runs(page_id);
CREATE UNIQUE INDEX IF NOT EXISTS learning_quiz_active ON learning_quiz_runs(page_id) WHERE status='generating';
CREATE TABLE IF NOT EXISTS learning_quiz_attempts (
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES learning_pages(id), quiz_id TEXT NOT NULL UNIQUE REFERENCES learning_quiz_runs(id),
  mode TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, progress_json TEXT NOT NULL, events_json TEXT NOT NULL, evaluation_json TEXT NOT NULL,
  created_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX IF NOT EXISTS learning_quiz_attempt_page ON learning_quiz_attempts(page_id);
`;
