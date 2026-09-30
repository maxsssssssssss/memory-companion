// One Learning upload intent and receipt. Provider checkpoints retain authority
// for submitted ASR/OCR/framework work; this is not a general job queue.
export const LEARNING_PREPARATION_SCHEMA = `CREATE TABLE IF NOT EXISTS learning_preparation_runs (
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES learning_pages(id),
  binding_json TEXT NOT NULL, run_json TEXT NOT NULL,
  allow_partial INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS learning_preparation_page ON learning_preparation_runs(page_id);`;
