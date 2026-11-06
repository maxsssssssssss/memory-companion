// @vitest-environment node
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { installGuard } = require('./reflection-thinking-real-network-guard.cjs');
const guardPath = path.resolve('scripts/reflection-thinking-real-network-guard.cjs');
const endpoint = 'https://tokenhub.vision-intelligence.tech/v1/responses';
const encoder = new TextEncoder();
const frame = event => `data: ${JSON.stringify(event)}\n\n`;
const completed = (overrides = {}) => ({ type: 'response.completed', response: {
  id: 'safe_response_id', status: 'completed', error: null, incomplete_details: null,
  usage: { input_tokens: 17, output_tokens: 9 }, output: [
    { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'PRIVATE_REASONING_MUST_NOT_PERSIST' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"finish":"仅讨论当前问题。"}' }] },
  ], ...overrides,
} });
const eventResponse = event => new Response(frame(event), { headers: { 'content-type': 'text/event-stream' } });

function fixture(transport = async () => eventResponse(completed()), captureSyntheticInput = false, dateScenario = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-real-guard-test-'));
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(root, 'AUTHORIZATION.json'), JSON.stringify({ mode: 'real', maxRequests: 12, model: 'deepseek-v4-pro',
    ...(dateScenario ? { scenario: 'date_companion_preparation_v1' } : {}),
    ...(captureSyntheticInput ? { captureSyntheticInput: true, accountScope: 'new local synthetic account only' } : {}) }));
  const shared = new Database(path.join(data, dateScenario ? 'date-companion.sqlite' : 'daily-reflection.sqlite'));
  const dateScope = { preparationId: 'synthetic-preparation', generationId: 'synthetic-generation', version: 4 };
  if (dateScenario) {
    shared.exec('CREATE TABLE agent_calls(id TEXT PRIMARY KEY,status TEXT NOT NULL,kind TEXT NOT NULL,task_id TEXT NOT NULL); CREATE TABLE agent_tasks(id TEXT PRIMARY KEY,scenario TEXT NOT NULL,resource_id TEXT NOT NULL,scope_json TEXT NOT NULL)');
    shared.prepare("INSERT INTO agent_tasks VALUES('synthetic-task','date_companion_preparation_v1',?,?)").run(dateScope.preparationId, JSON.stringify(dateScope));
  } else shared.exec('CREATE TABLE agent_calls(id TEXT PRIMARY KEY,status TEXT NOT NULL)');
  const environment = { THINKING_P1_REAL_DIR: root, APP_DATA_DIR: data, OPENAI_API_KEY: 'SYNTHETIC_SECRET_KEY' };
  if (captureSyntheticInput) environment.THINKING_REAL_CAPTURE_SYNTHETIC_INPUT = '1';
  let calls = 0;
  const redirects = [], progress = [];
  const api = installGuard({ environment, stdout: line => progress.push(line), fetch: async (request, options) => {
    calls++; redirects.push(options?.redirect); return transport(request, options);
  } });
  const body = { model: 'deepseek-v4-pro', stream: true, store: false, reasoning: { effort: 'none' }, max_output_tokens: 4000,
    input: [{ role: 'system', content: 'PRIVATE_REQUEST_BODY' }, { role: 'user', content: JSON.stringify({
      observation: { matter: { id: 'matter_safe_id', version: 3, arrangements: [{ id: 'arrangement_safe_id', status: 'adopted', text: 'PRIVATE_ADOPTED_TEXT' }] },
        latestFeedback: { text: 'PRIVATE_FEEDBACK_TEXT' }, historyCount: 7 },
    }) }],
  };
  if (dateScenario) body.input[1].content = JSON.stringify({ authorizedScope: dateScope,
    observation: { items: [{ id: 'saved', status: 'selected', text: 'PRIVATE_SELECTED_TEXT' },
      { id: 'other', status: 'suggested', text: 'PRIVATE_SUGGESTION' }], latestFeedback: { text: 'PRIVATE_FEEDBACK_TEXT' },
      historyCount: 7, historyAllowed: false } });
  function request(overrides = {}) {
    const id = overrides.id ?? crypto.randomUUID();
    if (!shared.prepare('SELECT 1 FROM agent_calls WHERE id=?').get(id)) {
      const insert = dateScenario ? "INSERT INTO agent_calls VALUES(?,'running','agent_decision','synthetic-task')" : "INSERT INTO agent_calls VALUES(?,'running')";
      shared.prepare(insert).run(id);
    }
    return { id, value: new Request(overrides.url ?? endpoint, { method: overrides.method ?? 'POST',
      headers: { authorization: 'SYNTHETIC_SECRET_KEY', 'content-type': 'application/json', 'x-client-request-id': id,
        'x-stainless-retry-count': overrides.retry ?? '0' }, body: JSON.stringify(overrides.body ?? body), signal: overrides.signal }) };
  }
  const settle = (id, status = 'succeeded') => shared.prepare('UPDATE agent_calls SET status=? WHERE id=?').run(status, id);
  return { root, data, environment, shared, api, body, request, settle, progress, redirects, calls: () => calls,
    artifact: () => JSON.parse(fs.readFileSync(path.join(root, 'response-001.json'), 'utf8')),
    close() { api.close(); shared.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function setSyntheticStartupPause(root, reason = 'unresolved_previous_request') {
  const ledger = new Database(path.join(root, 'network-ledger.sqlite'));
  ledger.prepare('UPDATE guard_state SET halted=1,halt_reason=?,halted_at=? WHERE id=1').run(reason, '2026-11-03T02:47:33.964Z');
  ledger.close();
}
function networkRows(root) {
  const ledger = new Database(path.join(root, 'network-ledger.sqlite'), { readonly: true });
  try { return ledger.prepare('SELECT * FROM requests ORDER BY id').all(); } finally { ledger.close(); }
}
const rowsHash = rows => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');

test('reserves all 12 attempts persistently, correlates shared IDs, stores only safe proof/final answer and denies number 13', async () => {
  const h = fixture();
  try {
    for (let index = 0; index < 12; index++) {
      const request = h.request();
      await (await globalThis.fetch(request.value)).text(); h.settle(request.id);
    }
    assert.equal(h.calls(), 12); assert.ok(h.redirects.every(value => value === 'error'));
    assert.equal(h.api.snapshot().completed, 12); assert.equal(h.api.snapshot().sent, 12);
    assert.equal(h.progress[0], '[thinking-p1-real] 1/12 sent\n'); assert.equal(h.progress.at(-1), '[thinking-p1-real] 12/12 sent\n');
    const extra = h.request();
    await assert.rejects(globalThis.fetch(extra.value), /request_budget_exhausted/u);
    assert.equal(h.calls(), 12); assert.equal(h.api.snapshot().sent, 12);
    const artifact = h.artifact();
    assert.equal(artifact.requestProof.matterId, 'matter_safe_id'); assert.equal(artifact.requestProof.matterVersion, 3);
    assert.equal(artifact.requestProof.historyCount, 7); assert.match(artifact.requestBodySha256, /^[a-f0-9]{64}$/u);
    assert.equal(artifact.requestProof.arrangements[0].textSha256, crypto.createHash('sha256').update('PRIVATE_ADOPTED_TEXT').digest('hex'));
    assert.equal(artifact.requestProof.latestFeedbackTextSha256, crypto.createHash('sha256').update('PRIVATE_FEEDBACK_TEXT').digest('hex'));
    assert.deepEqual(artifact.usage, { inputTokens: 17, outputTokens: 9 });
    assert.equal(artifact.finalAssistantText, '{"finish":"仅讨论当前问题。"}');
    assert.doesNotMatch(JSON.stringify(artifact), /PRIVATE_|SYNTHETIC_SECRET|authorization|reasoning_text/u);
    assert.equal(fs.existsSync(path.join(h.root, 'input-001.json')), false);
    const ledger = new Database(path.join(h.root, 'network-ledger.sqlite'), { readonly: true });
    assert.equal(ledger.prepare('SELECT count(*) n FROM requests').get().n, 12); ledger.close();
  } finally { h.close(); }
});

test('P3 synthetic input proof is opt-in, account-scoped and redacts configured secrets', async () => {
  const h = fixture(undefined, true);
  try {
    h.body.input[0].content = 'Synthetic source and SYNTHETIC_SECRET_KEY';
    await (await globalThis.fetch(h.request().value)).text();
    const input = JSON.parse(fs.readFileSync(path.join(h.root, 'input-001.json'), 'utf8'));
    assert.equal(input.evidenceMode, 'authorized_synthetic_input');
    assert.equal(input.body.input[0].content, 'Synthetic source and [REDACTED]');
    assert.doesNotMatch(JSON.stringify(input), /SYNTHETIC_SECRET_KEY|reasoning_text/u);
    assert.match(input.requestBodySha256, /^[a-f0-9]{64}$/u);
  } finally { h.close(); }
});

test('valid completion followed by SDK cleanup cancellation remains completed without a false unknown', async () => {
  let cancelled = 0;
  const h = fixture(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(frame(completed()))); }, cancel() { cancelled++; },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  try {
    const reader = (await globalThis.fetch(h.request().value)).body.getReader();
    await reader.read(); await reader.cancel();
    assert.equal(cancelled, 1); assert.equal(h.api.snapshot().completed, 1); assert.equal(h.api.snapshot().unknown, 0);
    assert.equal(h.api.snapshot().halted, false);
  } finally { h.close(); }
});

test('successful installation writes a PID-bound readiness proof without credentials', () => {
  const h = fixture();
  try {
    const ready = JSON.parse(fs.readFileSync(path.join(h.root, `guard-ready-${process.pid}.json`), 'utf8'));
    assert.deepEqual(ready, { pid: process.pid,
      authorizationSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(h.root, 'AUTHORIZATION.json'))).digest('hex'),
      evidenceMode: 'real', model: 'deepseek-v4-pro', maxRequests: 12 });
    assert.doesNotMatch(JSON.stringify(ready), /SYNTHETIC_SECRET|PRIVATE_/u);
  } finally { h.close(); }
});

for (const [name, transport] of [
  ['transport exception', async () => { throw Error('PRIVATE_TRANSPORT_ERROR SYNTHETIC_SECRET_KEY'); }],
  ['HTTP 503', async () => new Response('PRIVATE_HTTP_ERROR SYNTHETIC_SECRET_KEY', { status: 503 })],
  ['EOF without completion', async () => eventResponse({ type: 'response.output_text.delta', delta: 'PRIVATE_PARTIAL_OUTPUT' })],
  ['failed event with misleading completed metadata', async () => eventResponse({ ...completed(), type: 'response.failed' })],
  ['incomplete event with misleading completed metadata', async () => eventResponse({ ...completed(), type: 'response.incomplete' })],
  ['invalid completion status', async () => eventResponse(completed({ status: 'incomplete' }))],
  ['completion with error', async () => eventResponse(completed({ error: { message: 'PRIVATE_PROVIDER_ERROR' } }))],
  ['completion with incomplete details', async () => eventResponse(completed({ incomplete_details: { reason: 'max_output_tokens' } }))],
  ['stream exception', async () => new Response(new ReadableStream({ pull(controller) { controller.error(Error('PRIVATE_STREAM_ERROR')); } }))],
  ['malformed SSE', async () => new Response('data: PRIVATE_INVALID_JSON\n\n')],
]) test(`${name} consumes one request, persists unknown and stops every later Provider request`, async () => {
  const h = fixture(transport);
  try {
    try { await (await globalThis.fetch(h.request().value)).text(); } catch { /* Expected transport/parser rejection. */ }
    assert.equal(h.api.snapshot().sent, 1); assert.equal(h.api.snapshot().unknown, 1); assert.equal(h.api.snapshot().halted, true);
    if (name.startsWith('failed event') || name.startsWith('incomplete event')) assert.deepEqual(h.artifact().usage, { inputTokens: 17, outputTokens: 9 });
    const second = h.request(); await assert.rejects(globalThis.fetch(second.value), /batch_halted/u);
    assert.equal(h.calls(), 1); assert.doesNotMatch(JSON.stringify(h.artifact()), /PRIVATE_|SYNTHETIC_SECRET/u);
  } finally { h.close(); }
});

test('AbortSignal and explicit stream cancellation each persist unknown immediately', async () => {
  for (const abort of [true, false]) {
    const h = fixture(async () => new Response(new ReadableStream({}))); const controller = new AbortController();
    try {
      const response = await globalThis.fetch(h.request({ signal: controller.signal }).value);
      if (abort) controller.abort();
      else await response.body.cancel();
      assert.equal(h.api.snapshot().halted, true); assert.equal(h.api.snapshot().unknown, 1); assert.equal(h.calls(), 1);
      if (abort) await response.body.cancel();
    } finally { h.close(); }
  }
});

test('a completed wire response with missing usage is complete but its token usage stays null', async () => {
  const h = fixture(async () => eventResponse(completed({ usage: undefined })));
  try {
    await (await globalThis.fetch(h.request().value)).text();
    assert.equal(h.api.snapshot().completed, 1); assert.equal(h.api.snapshot().halted, false);
    assert.deepEqual(h.artifact().usage, { inputTokens: null, outputTokens: null });
  } finally { h.close(); }
});

test('an unterminated EOF event cannot be promoted to a framed completed response', async () => {
  const h = fixture(async () => new Response(frame(completed()).trimEnd(), { headers: { 'content-type': 'text/event-stream' } }));
  try {
    await (await globalThis.fetch(h.request().value)).text();
    assert.equal(h.api.snapshot().completed, 0);
    assert.equal(h.api.snapshot().unknown, 1); assert.equal(h.api.snapshot().halted, true);
    assert.deepEqual(h.artifact().stream, { bytes: Buffer.byteLength(frame(completed()).trimEnd()), framedEventCount: 0,
      completionReceived: false, eofWithPendingEvent: true });
    await assert.rejects(globalThis.fetch(h.request().value), /batch_halted/u);
    assert.equal(h.calls(), 1);
  } finally { h.close(); }
});

for (const ending of ['\n', '\r\n']) test(`the guard preserves byte-fragmented ${JSON.stringify(ending)} SSE framing and records safe completion proof`, async () => {
  const wire = frame(completed()).replaceAll('\n', ending), bytes = Buffer.from(wire);
  let index = 0;
  const h = fixture(async () => new Response(new ReadableStream({
    pull(controller) { if (index < bytes.length) controller.enqueue(bytes.subarray(index, ++index)); else controller.close(); },
  }, { highWaterMark: 0 })));
  try {
    assert.equal(await (await globalThis.fetch(h.request().value)).text(), wire);
    assert.equal(h.api.snapshot().completed, 1);
    assert.deepEqual(h.artifact().stream, { bytes: bytes.length, framedEventCount: 1, completionReceived: true, eofWithPendingEvent: false });
    assert.equal(h.calls(), 1);
  } finally { h.close(); }
});

test('a subsequent business unknown halts the batch even after the prior wire response completed', async () => {
  const h = fixture();
  try {
    const first = h.request(); await (await globalThis.fetch(first.value)).text(); h.settle(first.id, 'unknown');
    await assert.rejects(globalThis.fetch(h.request().value), /shared_unresolved_request/u);
    assert.equal(h.calls(), 1); assert.equal(h.api.snapshot().halted, true); assert.equal(h.api.snapshot().sent, 1);
  } finally { h.close(); }
});

test('duplicate request IDs and another unfinished shared call cannot dispatch twice', async () => {
  for (const duplicate of [true, false]) {
    const h = fixture();
    try {
      const first = h.request(); await (await globalThis.fetch(first.value)).text(); h.settle(first.id);
      const next = h.request(duplicate ? { id: first.id } : {});
      if (!duplicate) h.shared.prepare("INSERT INTO agent_calls VALUES(?,'running')").run(crypto.randomUUID());
      await assert.rejects(globalThis.fetch(next.value), duplicate ? /duplicate_request_id/u : /shared_unresolved_request/u);
      assert.equal(h.calls(), 1); assert.equal(h.api.snapshot().halted, true);
    } finally { h.close(); }
  }
});

test('a second process preloading the guard preserves unknown halt and cannot reset its budget', async () => {
  const h = fixture(async () => { throw Error('synthetic failure'); });
  try {
    await assert.rejects(globalThis.fetch(h.request().value));
    h.api.close();
    const child = spawnSync(process.execPath, ['--require', guardPath, '-e',
      'const {installGuard}=require(process.argv[1]); console.log(JSON.stringify(installGuard().snapshot()));', guardPath], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, ...h.environment, NODE_OPTIONS: '', OPENAI_API_KEY: 'SYNTHETIC_SECRET_KEY' },
    });
    assert.equal(child.status, 0, child.stderr); const state = JSON.parse(child.stdout.trim());
    assert.equal(state.sent, 1); assert.equal(state.halted, true); assert.equal(state.unknown, 1);
    const ready = JSON.parse(fs.readFileSync(path.join(h.root, `guard-ready-${child.pid}.json`), 'utf8'));
    assert.equal(ready.pid, child.pid); assert.equal(ready.maxRequests, 12); assert.equal(ready.evidenceMode, 'real');
  } finally { h.close(); }
});

test('install preserves dispatched/streaming reservations but any new dispatch still permanently halts', async () => {
  for (const state of ['dispatched', 'streaming']) {
    const h = fixture();
    try {
      h.api.close();
      const ledger = new Database(path.join(h.root, 'network-ledger.sqlite'));
      ledger.prepare(`INSERT INTO requests(request_id,state,started_at,model,input_chars,output_limit,request_body_sha256)
        VALUES(?,?,?,'deepseek-v4-pro',10,4000,'synthetic_hash')`).run(crypto.randomUUID(), state, new Date().toISOString()); ledger.close();
      const next = installGuard({ environment: h.environment, fetch: async () => { throw Error('must not dispatch'); }, stdout: () => {} });
      assert.equal(next.snapshot().halted, false); assert.equal(next.snapshot().sent, 1); assert.equal(next.snapshot().active, 1);
      await assert.rejects(globalThis.fetch(h.request().value), /unresolved_request/u);
      assert.equal(next.snapshot().halted, true); assert.equal(next.snapshot().sent, 1); next.close();
    } finally { h.close(); }
  }
});

test('a new process may install during a legitimate request and the original completion remains usable', async () => {
  let producer;
  const h = fixture(async () => new Response(new ReadableStream({ start(controller) { producer = controller; } })));
  try {
    const request = h.request(), response = await globalThis.fetch(request.value);
    assert.equal(h.api.snapshot().active, 1);
    const child = spawnSync(process.execPath, ['--require', guardPath, '-e',
      'console.log(JSON.stringify(require(process.argv[1]).installGuard().snapshot()));', guardPath], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...h.environment, NODE_OPTIONS: '' },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout.trim()), { evidenceMode: 'real', model: 'deepseek-v4-pro', maxRequests: 12,
      sent: 1, completed: 0, unknown: 0, active: 1, halted: false, haltReason: null, haltedAt: null });
    producer.enqueue(encoder.encode(frame(completed()))); producer.close();
    await response.text(); h.settle(request.id);
    assert.equal(h.api.snapshot().completed, 1); assert.equal(h.api.snapshot().halted, false); assert.equal(h.calls(), 1);
  } finally { h.close(); }
});

test('completed startup-pause reconciliation appends exact-ID audit and changes no request or business rows/counts', async () => {
  const h = fixture();
  try {
    const request = h.request(); await (await globalThis.fetch(request.value)).text(); h.settle(request.id);
    setSyntheticStartupPause(h.root);
    const before = networkRows(h.root), sharedBefore = h.shared.serialize();
    const result = h.api.reconcileCompletedStartupPause();
    assert.equal(result.reconciled, true); assert.equal(result.sent, 1); assert.equal(result.snapshot.halted, false);
    assert.equal(result.networkRowsSha256, rowsHash(before)); assert.deepEqual(networkRows(h.root), before);
    assert.deepEqual(h.shared.serialize(), sharedBefore); assert.equal(h.api.snapshot().sent, 1);
    const auditLines = fs.readFileSync(path.join(h.root, 'guard-reconciliation-audit.jsonl'), 'utf8').trim().split('\n');
    assert.equal(auditLines.length, 1);
    const audit = JSON.parse(auditLines[0]);
    assert.equal(audit.previousHalt.reason, 'unresolved_previous_request'); assert.equal(audit.previousHalt.haltedAt, '2026-11-03T02:47:33.964Z');
    assert.equal(audit.auditId, result.auditId); assert.equal(audit.networkCount, 1); assert.equal(audit.sharedCount, 1);
    assert.equal(audit.networkRowsSha256, rowsHash(before)); assert.equal(audit.perRequestProof[0].requestId, request.id);
    assert.match(audit.perRequestProof[0].proofSha256, /^[a-f0-9]{64}$/u);
    assert.equal(audit.perRequestProofSha256, rowsHash(audit.perRequestProof));
    assert.doesNotMatch(JSON.stringify(audit), /PRIVATE_|SYNTHETIC_SECRET/u);
    const ledger = new Database(path.join(h.root, 'network-ledger.sqlite'), { readonly: true });
    assert.equal(ledger.prepare('SELECT count(*) n FROM guard_reconciliations').get().n, 1); ledger.close();
    assert.throws(() => h.api.reconcileCompletedStartupPause(), /not_applicable/u);
    assert.equal(fs.readFileSync(path.join(h.root, 'guard-reconciliation-audit.jsonl'), 'utf8').trim().split('\n').length, 1);
  } finally { h.close(); }
});

test('an actual unknown can never use startup-pause reconciliation, even if it has the legacy halt label', async () => {
  const h = fixture(async () => { throw Error('synthetic transport unknown'); });
  try {
    await assert.rejects(globalThis.fetch(h.request().value));
    setSyntheticStartupPause(h.root);
    const before = networkRows(h.root);
    assert.throws(() => h.api.reconcileCompletedStartupPause(), /network_not_completed/u);
    assert.equal(h.api.snapshot().halted, true); assert.equal(h.api.snapshot().unknown, 1);
    assert.deepEqual(networkRows(h.root), before); assert.equal(h.calls(), 1);
    assert.equal(fs.existsSync(path.join(h.root, 'guard-reconciliation-audit.jsonl')), false);
  } finally { h.close(); }
});

for (const issue of ['other halt cause', 'shared unknown', 'shared running', 'shared ID mismatch', 'extra shared ID', 'authorization changed', '12 exhausted']) {
  test(`startup-pause reconciliation rejects ${issue} without changing requests/count or clearing halt`, async () => {
    const h = fixture();
    try {
      for (let index = 0; index < (issue === '12 exhausted' ? 12 : 1); index++) {
        const request = h.request(); await (await globalThis.fetch(request.value)).text(); h.settle(request.id);
      }
      setSyntheticStartupPause(h.root, issue === 'other halt cause' ? 'request_aborted' : 'unresolved_previous_request');
      const first = h.shared.prepare('SELECT id FROM agent_calls LIMIT 1').get().id;
      if (issue === 'shared unknown') h.settle(first, 'unknown');
      if (issue === 'shared running') h.settle(first, 'running');
      if (issue === 'shared ID mismatch') h.shared.prepare('UPDATE agent_calls SET id=? WHERE id=?').run(crypto.randomUUID(), first);
      if (issue === 'extra shared ID') h.shared.prepare("INSERT INTO agent_calls VALUES(?,'succeeded')").run(crypto.randomUUID());
      if (issue === 'authorization changed') fs.appendFileSync(path.join(h.root, 'AUTHORIZATION.json'), '\n');
      const before = networkRows(h.root), businessBefore = h.shared.serialize();
      assert.throws(() => h.api.reconcileCompletedStartupPause(), /startup_reconciliation/u);
      assert.equal(h.api.snapshot().halted, true); assert.equal(h.api.snapshot().sent, before.length);
      assert.deepEqual(networkRows(h.root), before); assert.deepEqual(h.shared.serialize(), businessBefore);
      assert.equal(fs.existsSync(path.join(h.root, 'guard-reconciliation-audit.jsonl')), false);
    } finally { h.close(); }
  });
}

test('an unfinished response cannot reconcile a legacy startup pause', async () => {
  const h = fixture(async () => new Response(new ReadableStream({})));
  try {
    const response = await globalThis.fetch(h.request().value); setSyntheticStartupPause(h.root);
    const before = networkRows(h.root);
    assert.throws(() => h.api.reconcileCompletedStartupPause(), /network_not_completed/u);
    assert.equal(h.api.snapshot().halted, true); assert.deepEqual(networkRows(h.root), before);
    await response.body.cancel();
  } finally { h.close(); }
});

test('foreign endpoints, alternate external HTTP/raw sockets and retry headers are rejected without a real send', async () => {
  const h = fixture();
  try {
    await assert.rejects(globalThis.fetch(h.request({ url: 'https://example.invalid/v1/responses' }).value), /external_destination_denied/u);
    await assert.rejects(globalThis.fetch(h.request({ retry: '1' }).value), /request_contract_rejected/u);
    assert.throws(() => require('node:https').get('https://example.invalid/'), /alternate_http_denied/u);
    assert.throws(() => require('node:net').connect({ host: '203.0.113.1', port: 443 }), /raw_socket_denied/u);
    const registry = await globalThis.fetch('https://registry.npmjs.org/-/package/next/dist-tags');
    assert.equal((await registry.json()).latest, require('next/package.json').version);
    assert.equal(h.calls(), 0); assert.equal(h.api.snapshot().sent, 0);
  } finally { h.close(); }
});

test('authorization changes permanently halt instead of silently extending the batch', async () => {
  const h = fixture();
  try {
    fs.writeFileSync(path.join(h.root, 'AUTHORIZATION.json'), JSON.stringify({ mode: 'real', maxRequests: 13, model: 'deepseek-v4-pro' }));
    await assert.rejects(globalThis.fetch(h.request().value), /authorization_changed/u);
    assert.equal(h.calls(), 0); assert.equal(h.api.snapshot().halted, true);
  } finally { h.close(); }
});

test('date authorization binds the running decision and preparation scope to its own database and records redacted progress proof', async () => {
  const h = fixture(undefined, false, true);
  try {
    assert.equal(fs.existsSync(path.join(h.data, 'daily-reflection.sqlite')), false);
    const request = h.request();
    await (await globalThis.fetch(request.value)).text();
    h.settle(request.id);
    assert.equal(h.calls(), 1);
    assert.deepEqual(h.artifact().requestProof, { preparationId: 'synthetic-preparation', preparationVersion: 4,
      selectedItems: [{ id: 'saved', textSha256: crypto.createHash('sha256').update('PRIVATE_SELECTED_TEXT').digest('hex') }],
      latestFeedbackTextSha256: crypto.createHash('sha256').update('PRIVATE_FEEDBACK_TEXT').digest('hex'), historyCount: 7, historyAllowed: false });
    assert.doesNotMatch(JSON.stringify(h.artifact()), /PRIVATE_|SYNTHETIC_SECRET/u);
    assert.throws(() => h.api.reconcileCompletedStartupPause(), /not_applicable/u);
  } finally { h.close(); }
});

for (const reason of ['kind', 'scenario', 'saved scope', 'request scope', 'generation', 'version', 'not running']) {
  test(`date authorization refuses ${reason} mismatch before transport`, async () => {
    const h = fixture(undefined, false, true);
    try {
      const payload = JSON.parse(h.body.input[1].content);
      if (reason === 'request scope') payload.authorizedScope.preparationId = 'other';
      if (reason === 'generation') payload.authorizedScope.generationId = 'other-generation';
      if (reason === 'version') payload.authorizedScope.version++;
      h.body.input[1].content = JSON.stringify(payload);
      const request = h.request();
      if (reason === 'kind') h.shared.exec("UPDATE agent_calls SET kind='other'");
      if (reason === 'scenario') h.shared.exec("UPDATE agent_tasks SET scenario='daily_reflection_thinking_v1'");
      if (reason === 'saved scope') h.shared.exec("UPDATE agent_tasks SET resource_id='other'");
      if (reason === 'not running') h.settle(request.id);
      await assert.rejects(globalThis.fetch(request.value), /date_scenario_mismatch|date_scope_mismatch|shared_request_not_running/u);
      assert.equal(h.calls(), 0); assert.equal(h.api.snapshot().sent, 0); assert.equal(h.api.snapshot().halted, true);
    } finally { h.close(); }
  });
}
