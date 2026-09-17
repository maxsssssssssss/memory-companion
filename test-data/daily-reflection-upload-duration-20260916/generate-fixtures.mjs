import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pure silence/video color and intentionally damaged derivatives. No private
// audio, application imports, network requests, Provider configuration or DB.
const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(repo, 'output/daily-reflection-upload-duration-20260916/evaluation/media');
assert.ok(!existsSync(resolve(out, 'manifest.json')), 'fixture generation is immutable');
mkdirSync(out, { recursive: true });
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|TEMP|TMP|COMSPEC|USERPROFILE|LOCALAPPDATA|APPDATA|HOMEDRIVE|HOMEPATH)$/i.test(key)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function command(binary, args, maxBuffer = 1024 * 1024) {
  const result = spawnSync(binary, args, { env, windowsHide: true, timeout: 30000, maxBuffer, encoding: 'utf8' });
  return { code: result.status, error: result.error?.code ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
const header = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n'];
const audio = seconds => ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', String(seconds)];
const opus = ['-codec:a', 'libopus', '-b:a', '24k', '-application', 'voip', '-ac', '1', '-ar', '48000'];
const webm = live => [...opus, '-fflags', '+bitexact', '-flags:a', '+bitexact', '-f', 'webm', ...(live ? ['-live', '1'] : [])];
const cases = [
  { id: 'webm-live', file: 'webm-live.webm', nominalMs: 12000, missingDuration: true, args: [...audio(12), ...webm(true)] },
  { id: 'webm-metadata', file: 'webm-metadata.webm', nominalMs: 12000, args: [...audio(12), ...webm(false)] },
  { id: 'wav-pcm', file: 'wav-pcm.wav', nominalMs: 12000, args: [...audio(12), '-c:a', 'pcm_s16le', '-f', 'wav'] },
  { id: 'mp3', file: 'synthetic.mp3', nominalMs: 12000, args: [...audio(12), '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3'] },
  { id: 'm4a-aac', file: 'synthetic.m4a', nominalMs: 12000, args: [...audio(12), '-c:a', 'aac', '-b:a', '64k', '-f', 'mp4'] },
  { id: 'ogg-opus', file: 'synthetic.ogg', nominalMs: 12000, args: [...audio(12), ...opus, '-f', 'ogg'] },
  { id: 'flac', file: 'synthetic.flac', nominalMs: 12000, args: [...audio(12), '-c:a', 'flac', '-f', 'flac'] },
  { id: 'aac-adts', file: 'synthetic.aac', nominalMs: 12000, args: [...audio(12), '-c:a', 'aac', '-b:a', '64k', '-f', 'adts'] },
  { id: 'pcm-contract', file: 'synthetic.pcm', nominalMs: 12000, rawPcm: true,
    args: [...audio(12), '-c:a', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-f', 's16le'] },
  ...[179999, 180000, 180001].map(ms => ({ id: `boundary-${ms}`, file: `boundary-${ms}.webm`, nominalMs: ms,
    missingDuration: true, args: [...audio(ms / 1000), ...webm(true)] })),
  { id: 'short-21ms', file: 'short-21ms.webm', nominalMs: 21, missingDuration: true, args: [...audio(0.021), ...webm(true)] },
  { id: 'no-audio-track', file: 'no-audio-track.webm', noAudio: true,
    args: ['-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=1:d=2', '-an', '-c:v', 'libvpx', '-deadline', 'realtime', '-f', 'webm'] },
  { id: 'long-video-short-audio', file: 'long-video-short-audio.webm', nominalMs: 2000, videoMs: 12000,
    args: ['-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=1:d=12', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=2',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libvpx', '-deadline', 'realtime', ...webm(false)] },
  { id: 'corrupt-header', file: 'corrupt-header.webm', invalid: true, bytes: Buffer.from('SYNTHETIC_INVALID_WEBM_ONLY\n') },
  { id: 'truncated-live', file: 'truncated-live.webm', invalid: true, truncate: 'webm-live.webm' },
  { id: 'truncated-metadata', file: 'truncated-metadata.webm', invalid: true, truncate: 'webm-metadata.webm' },
];
async function decodedPcm(path, rawPcm) {
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', ...(rawPcm ? ['-f', 's16le', '-ar', '16000', '-ac', '1'] : []),
    '-i', path, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'];
  return new Promise(done => {
    const child = spawn(ffmpeg, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0, stderr = '', error = null;
    child.stdout.on('data', chunk => { bytes += chunk.length; });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); if (stderr.length > 32768) child.kill(); });
    const timer = setTimeout(() => { error = 'timeout'; child.kill(); }, 30000);
    child.once('error', failure => { error = failure.code ?? 'spawn_failed'; });
    child.once('close', code => { clearTimeout(timer); done({ code, error, pcmBytes: bytes, decodedMs: bytes / 96,
      errorDiagnostic: stderr.trim().length > 0, stderr: stderr.replaceAll(path, '<synthetic-file>') }); });
  });
}
const records = [];
const started = performance.now();
console.log(`[duration-fixtures] 0/${cases.length} preparing only synthetic media`);
for (const fixture of cases) {
  const path = resolve(out, fixture.file);
  assert.ok(!existsSync(path), fixture.file);
  if (fixture.bytes) writeFileSync(path, fixture.bytes, { flag: 'wx' });
  else if (fixture.truncate) {
    const original = readFileSync(resolve(out, fixture.truncate));
    writeFileSync(path, original.subarray(0, Math.floor(original.length * 0.65) + 3), { flag: 'wx' });
  } else {
    const result = command(ffmpeg, [...header, ...fixture.args, path]);
    assert.equal(result.error, null, fixture.id);
    assert.equal(result.code, 0, fixture.id + ': ' + result.stderr);
  }
  const probe = command(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path]);
  let metadata = null;
  try { metadata = JSON.parse(probe.stdout); } catch { /* intentional corrupt fixture */ }
  const decoded = await decodedPcm(path, fixture.rawPcm);
  const bytes = readFileSync(path);
  const record = { id: fixture.id, file: fixture.file, bytes: bytes.length, sha256: sha(bytes),
    nominalMs: fixture.nominalMs ?? null, expectedInvalid: fixture.invalid ?? false, noAudio: fixture.noAudio ?? false,
    rawPcmContract: fixture.rawPcm ? '16 kHz mono signed PCM16LE; application wraps WAV before probe' : null,
    probe: { code: probe.code, error: probe.error, stderr: probe.stderr.replaceAll(path, '<synthetic-file>'), metadata }, decoded };
  records.push(record);
  if (fixture.missingDuration) {
    assert.ok(!Number.isFinite(Number(metadata?.format?.duration)), fixture.id + ': format.duration must be absent');
    assert.equal(decoded.code, 0, fixture.id);
    assert.equal(decoded.errorDiagnostic, false, fixture.id);
    assert.equal(decoded.decodedMs, fixture.nominalMs, fixture.id + ': Opus padding must not shift expected time');
  }
  if (fixture.noAudio) assert.ok(!metadata?.streams?.some(stream => stream.codec_type === 'audio'));
  console.log(`[duration-fixtures] ${records.length}/${cases.length} ${fixture.id} probe=${probe.code} decode=${decoded.code} ms=${decoded.decodedMs} diagnostics=${decoded.errorDiagnostic}`);
}
const versions = { ffmpeg: command(ffmpeg, ['-version']).stdout.split('\n')[0], ffprobe: command(ffprobe, ['-version']).stdout.split('\n')[0] };
const result = { syntheticOnly: true, createdAt: new Date().toISOString(), durationSeconds: (performance.now() - started) / 1000,
  externalRequests: 0, providerCalls: 0, applicationExecution: false, versions, cases: records };
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ complete: records.length, total: cases.length, externalRequests: 0, durationSeconds: result.durationSeconds }));
