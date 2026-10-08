import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertCleanConfig, cloudEnvironment } from './environment.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('drops credentials, remote storage, proxies and injected Node options', () => {
  const env = cloudEnvironment(repo, { PATH: process.env.PATH, OPENAI_API_KEY: 'not-a-real-key', APP_DATA_DIR: '/production', REDIS_URL: 'redis://remote.invalid', NODE_OPTIONS: '--require=bad', HTTPS_PROXY: 'http://remote.invalid' });
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.REDIS_URL, 'redis://127.0.0.1:6380');
  assert.equal(env.APP_DATA_DIR, path.join(repo, 'output/codex-cloud/test-data'));
  assert.ok(!env.NODE_OPTIONS.includes('bad'));
});
test('preview preserves product gates and queue storage requirements without credentials', () => {
  const env = cloudEnvironment(repo, {}, true);
  assert.equal(env.DAILY_REFLECTION_UPLOAD_ENABLED, 'true');
  assert.equal(env.DAILY_REFLECTION_BROWSER_RECORDING_ENABLED, 'true');
  assert.equal(env.WORK_REVIEW_ENABLED, 'true');
  assert.equal(env.DAILY_REFLECTION_AI_REVIEW_MODE, 'on');
  assert.equal(env.PIPELINE_EXECUTION_MODE, 'queue');
  assert.equal(env.APP_STORAGE_MODE, 'server'); assert.ok(path.isAbsolute(env.APP_DATA_DIR));
  assert.notEqual(env.APP_DATA_DIR, cloudEnvironment(repo, {}).APP_DATA_DIR);
});
test('runtime env files are refused while public example is allowed', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cloud-env-'));
  try { writeFileSync(path.join(dir, '.env.example'), 'SYNTHETIC='); assertCleanConfig(dir);
    for (const name of ['.env', '.env.local', '.env.production']) {
      writeFileSync(path.join(dir, name), 'SYNTHETIC=');
      assert.throws(() => assertCleanConfig(dir), /runtime .env files/); rmSync(path.join(dir, name));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('development preload blocks unmocked external fetch, HTTP and sockets before connection', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    (async () => {
      await assert.rejects(fetch('https://external.invalid/'), /External network access/);
      assert.throws(() => require('node:https').get('https://external.invalid/'), /External network access/);
      assert.throws(() => require('node:net').connect({host:'external.invalid',port:443}), /external socket blocked/);
    })().catch(() => process.exit(1));
  `], { cwd: repo, env: cloudEnvironment(repo), encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
});
