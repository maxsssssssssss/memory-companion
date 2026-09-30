// Learning-owned additions to schema 5. No source text cache or generic task authority.
export const LEARNING_STUDY_SCHEMA = `
CREATE TABLE IF NOT EXISTS learning_overview_runs (
 id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES learning_pages(id), binding_hash TEXT NOT NULL,
 binding_json TEXT NOT NULL, status TEXT NOT NULL, failure TEXT, deadline INTEGER NOT NULL,
 created_at TEXT NOT NULL, result_json TEXT, diagnostics_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS learning_overview_active ON learning_overview_runs(page_id) WHERE status='generating';
CREATE TABLE IF NOT EXISTS learning_node_conversations (
 id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES learning_pages(id), chapter_id TEXT NOT NULL,
 node_id TEXT NOT NULL, binding_hash TEXT NOT NULL, binding_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS learning_conversation_node ON learning_node_conversations(page_id,node_id);
CREATE TABLE IF NOT EXISTS learning_node_turns (
 id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES learning_pages(id), conversation_id TEXT NOT NULL REFERENCES learning_node_conversations(id),
 action TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL, failure TEXT, deadline INTEGER NOT NULL,
 created_at TEXT NOT NULL, answer_json TEXT, context_ids TEXT NOT NULL, omitted_turns INTEGER NOT NULL, diagnostics_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS learning_node_active ON learning_node_turns(conversation_id) WHERE status='generating';
CREATE TABLE IF NOT EXISTS learning_answer_notes (
 turn_id TEXT NOT NULL REFERENCES learning_node_turns(id), section INTEGER NOT NULL, page_id TEXT NOT NULL REFERENCES learning_pages(id),
 PRIMARY KEY(turn_id,section)
);`;
