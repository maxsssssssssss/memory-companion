import path from 'node:path';
import { readdirSync } from 'node:fs';
export function assertCleanConfig(repo) {
  const files = readdirSync(repo).filter(name => /^\.env(?:\.|$)/u.test(name) && name !== '.env.example');
  if (files.length) throw Error('Cloud checkout contains runtime .env files; use a fresh checkout, never import production configuration');
}
export function cloudEnvironment(repo, input = process.env, preview = false) {
  // OS/tool discovery only: no inherited app credentials, remote Redis or NODE_OPTIONS.
  const env = {};
  for (const [key, value] of Object.entries(input)) {
    if (/^(path|home|lang|lc_all|tmpdir|temp|tmp|systemroot|windir|comspec|pathext|userprofile|localappdata|appdata|homedrive|homepath|xdg_cache_home|playwright_browsers_path)$/iu.test(key) && value !== undefined) env[key] = value;
  }
  const data = path.join(repo, 'output', 'codex-cloud', preview ? 'preview-data' : 'test-data');
  Object.assign(env, { APP_DATA_DIR: data, DATA_DIR: data, APP_STORAGE_MODE: preview ? 'server' : 'local',
    PIPELINE_EXECUTION_MODE: preview ? 'queue' : 'inline', REDIS_URL: 'redis://127.0.0.1:6380',
    PIPELINE_QUEUE_NAME: 'daily-brief-cloud-fixture', PIPELINE_WORKER_CONCURRENCY: '1',
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: `--require=${JSON.stringify(path.join(repo, 'scripts/cloud/offline.cjs'))}` });
  if (preview) Object.assign(env, { DAILY_BRIEF_INVITE_CODES: 'cloud-synthetic-only',
    DAILY_REFLECTION_UPLOAD_ENABLED: 'true', DAILY_REFLECTION_BROWSER_RECORDING_ENABLED: 'true',
    DAILY_REFLECTION_AI_REVIEW_MODE: 'on', WORK_REVIEW_ENABLED: 'true' });
  return env;
}
