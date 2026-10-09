import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
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

test('Learning ASR retains HTTP and shares a raw local signing secret across both child roles', () => {
  const env = providerEnvironment(repo, { SPEAKER_ASR_BASE_URL: 'http://asr.synthetic.invalid:8300/gateway',
    LEARNING_ASR_AUDIO_BASE_URL: 'https://audio.synthetic.invalid',
    LEARNING_ASR_AUDIO_CAPABILITY_SECRET: 'SYNTHETIC_ONLY_LOCAL_SIGNING_32_CHARACTERS' }, { verifyNoCalls: true });
  for (const role of ['web', 'worker']) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import a from 'node:assert/strict';
      import {learningAsrConfig,learningAudioUrl,verifyLearningAudioUrl} from './src/lib/server/learning/audio-service.ts';
      a.equal(process.env.SPEAKER_ASR_BASE_URL,'http://asr.synthetic.invalid:8300/gateway');
      const config=learningAsrConfig();
      const address={userId:'synthetic',pageId:'synthetic-page',runId:'synthetic-run',materialId:'synthetic-material',index:0};
      const url=new URL(learningAudioUrl(config,address));
      a.equal(url.origin,'https://audio.synthetic.invalid');
      a.ok(verifyLearningAudioUrl(config.secret,address,url.searchParams));
    `], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(child.status, 0, `${role} Learning ASR configuration mismatch`);
  }
  assert.deepEqual(providerConfigurationReport(repo, env).missing.learningAsr, []);
  assert.throws(() => providerEnvironment(repo, { LEARNING_ASR_AUDIO_CAPABILITY_SECRET: 'too-short' }), /signing secret is too short/);
});

test('OCR alias and reviewed findings path reach the real application config without invented instance values', () => {
  mkdirSync(path.join(repo, 'output'), { recursive: true });
  const dir = mkdtempSync(path.join(repo, 'output', 'cloud-ocr-config-'));
  const findings = path.join(dir, 'synthetic-config-findings.json');
  // Config-only synthetic schema fixture; no OCR quality or historical evidence claim.
  writeFileSync(findings, '[]');
  try {
    const env = providerEnvironment(repo, { LEARNING_PDF_SERVICE_URL: 'https://ocr.synthetic.invalid/internal/ocr',
      DAILY_BRIEF_LEARNING_PDF_SERVICE_TOKEN: 'synthetic-ocr-proxy-placeholder',
      LEARNING_PDF_KNOWN_FINDINGS_FILE: findings }, { verifyNoCalls: true });
    for (const role of ['web', 'worker']) {
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        import a from 'node:assert/strict';
        import {pdfParserConfig} from './src/lib/server/learning/pdf-parser-service.ts';
        a.equal(process.env.LEARNING_PDF_SERVICE_TOKEN,process.env.DAILY_BRIEF_LEARNING_PDF_SERVICE_TOKEN);
        const config=pdfParserConfig();
        a.equal(config.token,'synthetic-ocr-proxy-placeholder');
        a.equal(config.url,'https://ocr.synthetic.invalid/internal/ocr');
        a.equal(config.discoverInstance,true);
        a.equal(config.serviceEpoch,undefined);
      `], { cwd: repo, env, encoding: 'utf8' });
      assert.equal(child.status, 0, `${role} OCR configuration mismatch`);
    }
    assert.deepEqual(providerConfigurationReport(repo, env).missing.pdfOcr, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('OCR findings reject unavailable, external and symlinked paths without reading secrets', () => {
  mkdirSync(path.join(repo, 'output'), { recursive: true });
  const dir = mkdtempSync(path.join(repo, 'output', 'cloud-ocr-path-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'cloud-ocr-outside-'));
  const file = path.join(outside, 'synthetic.json'); writeFileSync(file, '[]');
  const link = path.join(dir, 'link.json'); symlinkSync(file, link);
  try {
    for (const value of [file, link, dir, path.join(dir, 'missing.json')]) {
      assert.throws(() => providerEnvironment(repo, { LEARNING_PDF_KNOWN_FINDINGS_FILE: value }), /readable regular file inside/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('local signing secrets and signed audio query credentials are redacted across chunks', async () => {
  const secret = 'SYNTHETIC_ONLY_LOCAL_SIGNING_32_CHARACTERS';
  const redactor = providerLogRedactor({ LEARNING_ASR_AUDIO_CAPABILITY_SECRET: secret });
  let output = ''; redactor.on('data', value => { output += value; });
  const input = `${secret} https://audio.synthetic.invalid/file?capability=${'a'.repeat(64)}&expires=123 token=synthetic-query-token end`;
  await new Promise((resolve, reject) => {
    redactor.once('end', resolve); redactor.once('error', reject);
    Readable.from([...Buffer.from(input)].map(value => Buffer.from([value]))).pipe(redactor);
  });
  assert.ok(!output.includes(secret)); assert.ok(!output.includes('a'.repeat(64)));
  assert.ok(!output.includes('synthetic-query-token'));
  assert.ok(output.includes('capability=[REDACTED]&expires=123'));
  assert.ok(output.endsWith('token=[REDACTED] end'));
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
  const sockets = new Set(); let connectRequests = 0, httpRequests = 0, authorizedRequests = 0, asrRequests = 0, ocrUploads = 0;
  const target = https.createServer({ key, cert }, (request, response) => {
    if (request.method === 'PUT') {
      assert.equal(request.headers.authorization, 'Bearer synthetic-ocr-platform-placeholder');
      assert.equal(request.headers['content-length'], '4');
      const chunks = [];
      request.on('data', value => chunks.push(value));
      request.on('end', () => {
        assert.deepEqual(Buffer.concat(chunks), Buffer.from([37, 80, 68, 70]));
        ocrUploads++; response.writeHead(201, { 'content-type': 'application/json' });
        response.end('{"status":"ready"}');
      });
      return;
    }
    if (request.headers.authorization === 'Bearer synthetic-platform-placeholder') authorizedRequests++;
    response.end('tls-ok');
  });
  const loopback = http.createServer((request, response) => response.end('loopback-ok'));
  const serveAsr = (request, response) => {
    if (request.url === '/gateway/api/ai/non-realtime-asr'
      || request.url === 'http://asr.synthetic.invalid:8300/gateway/api/ai/non-realtime-asr') {
      assert.equal(request.method, 'POST');
      const chunks = []; request.on('data', value => chunks.push(value));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(body.req_id, 'synthetic-request');
        assert.equal(body.audio_url, 'https://audio.synthetic.invalid/learning?capability=synthetic-signed-url');
        asrRequests++; response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ code: 0, data: { asr_result: { sentences: [
          { text: '[合成] ASR代理返回', timestamp: [{ start: 0, end: 100 }] }
        ] } } }));
      });
      return;
    }
    response.writeHead(404); response.end();
  };
  const asrTarget = http.createServer(serveAsr);
  const proxy = http.createServer((request, response) => {
    if (request.url?.startsWith('http://asr.synthetic.invalid:8300/')) return serveAsr(request, response);
    httpRequests++; response.end('proxy-ok');
  });
  for (const server of [target, loopback, proxy, asrTarget]) server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const run = (script, env) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stderr.on('data', value => { output += value; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(`Local proxy test child failed (${code}): ${output}`)));
  });
  try {
    await Promise.all([target, loopback, proxy, asrTarget].map(listen));
    proxy.on('connect', (request, socket, head) => {
      const plainAsr = request.url === 'asr.synthetic.invalid:8300';
      if (!plainAsr) assert.equal(request.url, `provider.invalid:${target.address().port}`);
      connectRequests++;
      const upstream = net.connect(plainAsr ? asrTarget.address().port : target.address().port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
      });
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    });
    const input = { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`, HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`,
      DAILY_BRIEF_OPENAI_API_KEY: 'synthetic-platform-placeholder', NODE_EXTRA_CA_CERTS: ca,
      DAILY_BRIEF_LEARNING_PDF_SERVICE_TOKEN: 'synthetic-ocr-platform-placeholder',
      SPEAKER_ASR_BASE_URL: 'http://asr.synthetic.invalid:8300/gateway' };
    const url = `https://provider.invalid:${target.address().port}/status`;
    await run(`
      const a=require('node:assert/strict');
      const request=(module,url)=>new Promise((resolve,reject)=>module.get(url,r=>{let text='';r.on('data',b=>text+=b);r.on('end',()=>resolve(text));}).on('error',reject));
      (async()=>{
        a.equal(await (await fetch(${JSON.stringify(url)},{headers:{Authorization:'Bearer '+process.env.OPENAI_API_KEY}})).text(),'tls-ok');
        a.equal(await request(require('node:https'),${JSON.stringify(url)}),'tls-ok');
        a.equal(await request(require('node:http'),'http://provider.invalid/status'),'proxy-ok');
        a.equal(await (await fetch('http://127.0.0.1:${loopback.address().port}/')).text(),'loopback-ok');
        const {requestCompanyAsr}=await import('./src/lib/server/transcription/speaker-asr-provider.ts');
        const asr=await requestCompanyAsr({requestId:'synthetic-request',materialId:'synthetic-material',userId:'synthetic-user',
          audioUrl:'https://audio.synthetic.invalid/learning?capability=synthetic-signed-url',resume:false,signal:AbortSignal.timeout(5000)});
        a.equal(asr.asr_result.sentences[0].text,'[合成] ASR代理返回');
        const {pdfParserTransport}=await import('./src/lib/server/learning/pdf-source-http.ts');
        const upload=await pdfParserTransport(${JSON.stringify(url)}, {method:'PUT',body:new Uint8Array([37,80,68,70]),
          headers:{Authorization:'Bearer '+process.env.LEARNING_PDF_SERVICE_TOKEN,'Content-Length':'4','Content-Type':'application/pdf'},
          signal:AbortSignal.timeout(5000)});
        a.equal(upload.status,201);a.deepEqual(await upload.json(),{status:'ready'});
      })().catch(()=>process.exit(1));
    `, providerEnvironment(repo, input));
    assert.equal(authorizedRequests, 1); assert.ok(connectRequests >= 2); assert.equal(httpRequests, 1);
    assert.equal(asrRequests, 1); assert.equal(ocrUploads, 1);
    await run(`require('node:assert/strict').rejects(fetch(${JSON.stringify(url)})).catch(()=>process.exit(1))`,
      providerEnvironment(repo, { ...input, NODE_EXTRA_CA_CERTS: undefined }));
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([target, loopback, proxy, asrTarget].map(server => new Promise(resolve => server.close(resolve))));
    rmSync(dir, { recursive: true, force: true });
  }
});
