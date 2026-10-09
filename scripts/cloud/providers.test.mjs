import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { generateKeyPairSync } from 'node:crypto';
import { cloudEnvironment } from './environment.mjs';
import { assertProviderNode, assertProviderTransport, providerEnvironment, providerConfigurationReport } from './providers.mjs';
import { providerLogRedactor } from './redact.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Provider whitelist forwards business configuration but retains local storage authority', () => {
  const env = providerEnvironment(repo, { OPENAI_BASE_URL: 'https://provider.invalid/v1',
    OPENAI_TEXT_MODEL: 'synthetic-model', WORK_REVIEW_WEEKLY_QA_ANSWERER_TIMEOUT_MS: '30000',
    OPENAI_CLUSTER: 'platform-control', RANDOM_API_KEY: 'unrelated', NEXT_PUBLIC_API_KEY: 'unsafe',
    APP_DATA_DIR: '/production', REDIS_URL: 'redis://production.invalid',
    NODE_OPTIONS: '--require=unsafe', NODE_PATH: '/unsafe',
    DAILY_BRIEF_INVITE_CODES: 'real-invite', LEARNING_PDF_SERVICE_TOKEN_FILE: '/private',
    DAILY_BRIEF_TOY_SYNC_ENABLED: 'true', TRANSCRIPTION_FALLBACK_PROVIDER: 'openai' });
  assert.equal(env.OPENAI_TEXT_MODEL, 'synthetic-model');
  assert.equal(env.WORK_REVIEW_WEEKLY_QA_ANSWERER_TIMEOUT_MS, '30000');
  for (const key of ['OPENAI_CLUSTER', 'RANDOM_API_KEY', 'NEXT_PUBLIC_API_KEY', 'NODE_PATH',
    'LEARNING_PDF_SERVICE_TOKEN_FILE', 'DAILY_BRIEF_TOY_SYNC_ENABLED']) assert.equal(env[key], undefined);
  assert.equal(env.DAILY_BRIEF_INVITE_CODES, 'cloud-synthetic-only');
  assert.equal(env.REDIS_URL, 'redis://127.0.0.1:6381');
  assert.equal(env.APP_DATA_DIR, path.join(repo, 'output/codex-cloud/provider-data'));
  assert.equal(env.PIPELINE_QUEUE_NAME, 'daily-brief-cloud-providers');
  assert.equal(env.TRANSCRIPTION_FALLBACK_PROVIDER, 'none');
  assert.equal(env.EXTRACTION_FALLBACK_PROVIDER, 'none');
  assert.ok(!env.NODE_OPTIONS.includes('unsafe'));
});

test('Network secret aliases preserve proxy placeholders and reject ambiguous credentials', () => {
  const placeholder = 'synthetic-platform-placeholder';
  const env = providerEnvironment(repo, { DAILY_BRIEF_OPENAI_API_KEY: placeholder });
  assert.equal(env.OPENAI_API_KEY, placeholder);
  assert.equal(env.DAILY_BRIEF_OPENAI_API_KEY, placeholder);
  assert.equal(providerEnvironment(repo, { OPENAI_API_KEY: placeholder }).OPENAI_API_KEY, placeholder);
  assert.throws(() => providerEnvironment(repo, { OPENAI_API_KEY: placeholder,
    DAILY_BRIEF_OPENAI_API_KEY: 'another-synthetic-placeholder' }), /Conflicting Provider credential sources/);
});

test('offline entry continues to discard business settings, aliases, proxies and CA settings', () => {
  const env = cloudEnvironment(repo, { OPENAI_API_KEY: 'synthetic', DAILY_BRIEF_OPENAI_API_KEY: 'synthetic',
    OPENAI_TEXT_MODEL: 'synthetic-model', HTTPS_PROXY: 'http://proxy.invalid',
    NODE_EXTRA_CA_CERTS: '/untrusted', NODE_TLS_REJECT_UNAUTHORIZED: '0' }, true);
  for (const key of ['OPENAI_API_KEY', 'DAILY_BRIEF_OPENAI_API_KEY', 'OPENAI_TEXT_MODEL',
    'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED']) assert.equal(env[key], undefined);
  assert.notEqual(env.APP_DATA_DIR, providerEnvironment(repo, {}).APP_DATA_DIR);
  assert.ok(env.NODE_OPTIONS.includes('offline.cjs'));
});

test('Provider mode preserves platform transport and enforces loopback bypass and TLS', () => {
  const env = providerEnvironment(repo, { HTTPS_PROXY: 'http://proxy.invalid', NO_PROXY: 'existing.invalid' });
  assert.equal(env.HTTPS_PROXY, 'http://proxy.invalid');
  assert.match(env.NODE_OPTIONS, /--use-env-proxy/);
  assert.match(env.NODE_OPTIONS, /--use-system-ca/);
  for (const host of ['localhost', '127.0.0.1', '::1', 'existing.invalid']) assert.ok(env.NO_PROXY.split(',').includes(host));
  assert.equal(env.no_proxy, env.NO_PROXY);
  assertProviderTransport(env);
  assert.throws(() => assertProviderTransport(providerEnvironment(repo, {})), /requires the platform HTTPS_PROXY/);
  assert.throws(() => assertProviderTransport(providerEnvironment(repo, { HTTPS_PROXY: 'http://proxy.invalid', NO_PROXY: '*' })), /wildcard proxy bypass/);
  assert.throws(() => providerEnvironment(repo, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }), /refuses disabled TLS/);
  assert.throws(() => providerEnvironment(repo, { NODE_EXTRA_CA_CERTS: '/nonexistent-synthetic-ca' }), /CA file unavailable/);
});

test('native proxy Node requirement is explicit without changing offline minimum', () => {
  for (const version of ['22.13.0', '23.10.0', '24.4.0']) assert.throws(() => assertProviderNode(version), /Node >=24.5/);
  for (const version of ['24.5.0', '24.19.0', '25.0.0']) assertProviderNode(version);
});

test('configuration reporting contains names and status only', () => {
  const report = providerConfigurationReport(repo, { OPENAI_BASE_URL: 'https://provider.invalid/v1',
    OPENAI_TEXT_MODEL: 'synthetic-private-model', DAILY_BRIEF_OPENAI_API_KEY: 'synthetic-private-placeholder' });
  const serialized = JSON.stringify(report);
  for (const value of ['provider.invalid', 'synthetic-private-model', 'synthetic-private-placeholder']) assert.ok(!serialized.includes(value));
  assert.equal(report.credentials.find(value => value.target === 'OPENAI_API_KEY').present, true);
  assert.deepEqual(report.missing.openaiCompatible, []);
  assert.ok(report.missing.learningGeneration.includes('LEARNING_AI_PROVIDER'));
});

test('startup verification blocks external requests even with proxy credentials present', () => {
  const env = providerEnvironment(repo, { HTTPS_PROXY: 'http://proxy.invalid',
    DAILY_BRIEF_OPENAI_API_KEY: 'synthetic-placeholder' }, { verifyNoCalls: true });
  const child = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    (async () => {
      await assert.rejects(fetch('https://provider.invalid/v1/responses'), /External network access/);
      assert.throws(() => require('node:https').get('https://provider.invalid/'), /External network access/);
      assert.throws(() => require('node:net').connect({host:'proxy.invalid',port:443}), /external socket blocked/);
    })().catch(() => process.exit(1));
  `], { env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});

test('Web and Worker children receive the same explicitly selected Provider configuration', () => {
  const env = providerEnvironment(repo, { OPENAI_TEXT_MODEL: 'synthetic-model',
    WORK_REVIEW_WEEKLY_VERIFIER_TIMEOUT_MS: '30000', DAILY_BRIEF_OPENAI_API_KEY: 'synthetic-placeholder',
    HTTPS_PROXY: 'http://proxy.invalid' }, { verifyNoCalls: true });
  for (const role of ['web', 'worker']) {
    const child = spawnSync(process.execPath, ['-e', `
      const a=require('node:assert/strict');
      a.equal(process.env.OPENAI_API_KEY,'synthetic-placeholder');
      a.equal(process.env.OPENAI_TEXT_MODEL,'synthetic-model');
      a.equal(process.env.WORK_REVIEW_WEEKLY_VERIFIER_TIMEOUT_MS,'30000');
      a.equal(process.env.HTTPS_PROXY,'http://proxy.invalid');
      a.equal(process.env.APP_DATA_DIR,${JSON.stringify(env.APP_DATA_DIR)});
      a.equal(process.env.PIPELINE_QUEUE_NAME,'daily-brief-cloud-providers');
    `], { env, encoding: 'utf8' });
    assert.equal(child.status, 0, `${role} configuration mismatch`);
  }
});

test('Provider log redaction protects split tokens and proxy authentication', async () => {
  const secret = 'synthetic-secret-crossing-chunks';
  const proxy = 'http://fixture-user:synthetic-proxy-password@proxy.invalid';
  const redactor = providerLogRedactor({ OPENAI_API_KEY: secret, HTTPS_PROXY: proxy });
  let output = ''; redactor.on('data', value => { output += value; });
  const input = `中文 ${secret} ${proxy} synthetic-proxy-password ${Buffer.from('fixture-user:synthetic-proxy-password').toString('base64')} done`;
  await new Promise((resolve, reject) => {
    redactor.once('end', resolve); redactor.once('error', reject);
    Readable.from([...Buffer.from(input)].map(value => Buffer.from([value]))).pipe(redactor);
  });
  assert.ok(output.startsWith('中文 ')); assert.ok(output.endsWith(' done'));
  for (const value of [secret, proxy, 'synthetic-proxy-password', Buffer.from('fixture-user:synthetic-proxy-password').toString('base64')]) assert.ok(!output.includes(value));
  assert.equal((output.match(/\[REDACTED\]/gu) ?? []).length, 4);
});

test('both development profiles refuse an occupied counterpart Web port', async () => {
  for (const [mode, port] of [['providers', 3000], ['dev', 3001]]) {
    const server = net.createServer();
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    try {
      const child = spawnSync(process.execPath, ['scripts/cloud/run.mjs', mode], {
        cwd: repo, env: process.env, encoding: 'utf8', timeout: 10000
      });
      assert.equal(child.status, 1);
      assert.match(child.stderr, /EADDRINUSE/);
      assert.ok(!child.stdout.includes('1/3 isolated Redis'));
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
});

test('overlapping credential tokens are redacted as a complete range', async () => {
  const redactor = providerLogRedactor({ OPENAI_API_KEY: 'abcDEFgh', DEEPSEEK_API_KEY: 'DEFghijk' });
  let output = ''; redactor.on('data', value => { output += value; });
  await new Promise((resolve, reject) => {
    redactor.once('end', resolve); redactor.once('error', reject);
    Readable.from(['prefix abcDEFghijk suffix']).pipe(redactor);
  });
  assert.equal(output, 'prefix [REDACTED] suffix');
});

test('native fetch, HTTP and HTTPS use a local proxy, respect bypass, and require CA trust', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cloud-proxy-ca-'));
  // This synthetic TLS private key never goes to disk or logs. Only the public
  // certificate is written for NODE_EXTRA_CA_CERTS, then removed.
  const { privateKey: key } = generateKeyPairSync('ec', { namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  // Node uses a socket for child stdin; cat supplies an actual anonymous pipe
  // that OpenSSL can open without a temporary private-key file.
  const cert = execFileSync('bash', ['-c', 'cat | openssl req -x509 -key /dev/stdin -days 1 -subj /CN=provider.invalid -addext subjectAltName=DNS:provider.invalid'],
    { input: key, stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf8' });
  const ca = path.join(dir, 'public-ca.pem'); writeFileSync(ca, cert);
  const sockets = new Set(); let connectRequests = 0, httpRequests = 0, authorizedRequests = 0;
  const target = https.createServer({ key, cert }, (request, response) => {
    if (request.headers.authorization === 'Bearer synthetic-platform-placeholder') authorizedRequests++;
    response.end('tls-ok');
  });
  const loopback = http.createServer((request, response) => response.end('loopback-ok'));
  const proxy = http.createServer((request, response) => { httpRequests++; response.end('proxy-ok'); });
  for (const server of [target, loopback, proxy]) server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const run = (script, env) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stderr.on('data', value => { output += value; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(`Local proxy test child failed (${code}): ${output}`)));
  });
  try {
    await Promise.all([target, loopback, proxy].map(listen));
    proxy.on('connect', (request, socket, head) => {
      assert.equal(request.url, `provider.invalid:${target.address().port}`);
      connectRequests++;
      const upstream = net.connect(target.address().port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
      });
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    });
    const input = { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`, HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`,
      DAILY_BRIEF_OPENAI_API_KEY: 'synthetic-platform-placeholder', NODE_EXTRA_CA_CERTS: ca };
    const url = `https://provider.invalid:${target.address().port}/status`;
    await run(`
      const a=require('node:assert/strict');
      const request=(module,url)=>new Promise((resolve,reject)=>module.get(url,r=>{let text='';r.on('data',b=>text+=b);r.on('end',()=>resolve(text));}).on('error',reject));
      (async()=>{
        a.equal(await (await fetch(${JSON.stringify(url)},{headers:{Authorization:'Bearer '+process.env.OPENAI_API_KEY}})).text(),'tls-ok');
        a.equal(await request(require('node:https'),${JSON.stringify(url)}),'tls-ok');
        a.equal(await request(require('node:http'),'http://provider.invalid/status'),'proxy-ok');
        a.equal(await (await fetch('http://127.0.0.1:${loopback.address().port}/')).text(),'loopback-ok');
      })().catch(()=>process.exit(1));
    `, providerEnvironment(repo, input));
    assert.equal(authorizedRequests, 1); assert.ok(connectRequests >= 2); assert.equal(httpRequests, 1);
    await run(`require('node:assert/strict').rejects(fetch(${JSON.stringify(url)})).catch(()=>process.exit(1))`,
      providerEnvironment(repo, { ...input, NODE_EXTRA_CA_CERTS: undefined }));
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([target, loopback, proxy].map(server => new Promise(resolve => server.close(resolve))));
    rmSync(dir, { recursive: true, force: true });
  }
});
