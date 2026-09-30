// Learning-only resumable generation parts. Published objects retain their authority.
export const LEARNING_GENERATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS learning_generation_parts (
 page_id TEXT NOT NULL REFERENCES learning_pages(id), kind TEXT NOT NULL, run_id TEXT NOT NULL,
 part_id TEXT NOT NULL, input_hash TEXT NOT NULL, material_ids TEXT NOT NULL,
 state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, token TEXT, deadline INTEGER NOT NULL DEFAULT 0,
 result_json TEXT, failure TEXT, diagnostics_json TEXT,
 PRIMARY KEY(page_id,kind,run_id,part_id)
);
CREATE INDEX IF NOT EXISTS learning_generation_page ON learning_generation_parts(page_id,kind,run_id);
`;
