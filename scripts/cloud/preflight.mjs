import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudEnvironment, cloudToolPaths } from './environment.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const paths = cloudToolPaths(repo);
const env = cloudEnvironment(repo);
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(':memory:');
if (db.prepare('select 1 as ok').get().ok !== 1) throw Error('SQLite probe failed');
db.close();
for (const command of [require('ffmpeg-static'), require('ffprobe-static').path]) {
  if (!command || spawnSync(command, ['-version'], { stdio: 'ignore', windowsHide: true }).status !== 0) throw Error('Audio binary probe failed');
}
const python = spawnSync(path.join(paths.venvBin, process.platform === 'win32' ? 'python.exe' : 'python'), ['-c',
  'import pypdf; v=tuple(map(int,pypdf.__version__.split("."))); assert (6,14,2)<=v<(7,0,0), v'], { env, encoding: 'utf8' });
if (python.status !== 0) throw Error('Project Python venv/pypdf unavailable; run npm run cloud:setup');
for (const [command, args] of [['redis-server', ['--version']], ['/usr/bin/chromium', ['--version']]]) {
  if (spawnSync(command, args, { env, stdio: 'ignore' }).status !== 0) throw Error(`${command} unavailable; run npm run cloud:setup`);
}
console.log('[cloud] project Python/pypdf, SQLite, FFmpeg/FFprobe, Redis and Chromium ready; no Provider calls');
