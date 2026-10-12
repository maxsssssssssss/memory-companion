// This journal is not source storage or ASR authority. It holds only owned
// remote object identities, survives page deletion and never stores signed URLs.
export const LEARNING_AUDIO_COS_SCHEMA = `CREATE TABLE IF NOT EXISTS learning_audio_cos_objects (
  object_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, page_id TEXT NOT NULL,
  material_id TEXT NOT NULL, run_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
  original_sha256 TEXT NOT NULL, chunk_sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL,
  bucket TEXT NOT NULL, region TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE,
  upload_state TEXT NOT NULL CHECK(upload_state IN ('uploading','ready','unknown')),
  version_id TEXT, expires_at INTEGER NOT NULL,
  delete_requested INTEGER NOT NULL DEFAULT 0,
  cleanup TEXT NOT NULL DEFAULT 'pending' CHECK(cleanup IN ('pending','unknown','confirmed')),
  next_cleanup_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(account_id,material_id,chunk_index)
);`;
