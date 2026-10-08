import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(':memory:');
if (db.prepare('select 1 as ok').get().ok !== 1) throw Error('SQLite probe failed');
db.close();
for (const command of [require('ffmpeg-static'), require('ffprobe-static').path]) {
  if (!command || spawnSync(command, ['-version'], { stdio: 'ignore', windowsHide: true }).status !== 0) throw Error('Audio binary probe failed');
}
console.log('[cloud] in-memory SQLite, FFmpeg and FFprobe ready; no Provider calls');
