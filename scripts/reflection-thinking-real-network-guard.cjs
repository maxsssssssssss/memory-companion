// Local, explicitly authorized acceptance only. This is not a product Provider.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { AsyncLocalStorage } = require('node:async_hooks');
const { syncBuiltinESMExports } = require('node:module');
const Database = require('better-sqlite3');

const INSTALLED = Symbol.for('daily-brief.reflection-thinking-real-network-guard');
const ENDPOINT = 'https://tokenhub.vision-intelligence.tech/v1/responses';
const MODEL = 'deepseek-v4-pro';
const MAX_REQUESTS = 12;
const DATE_SCENARIO = 'date_companion_preparation_v1';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function fail(code) { throw new Error(`thinking_real_guard:${code}`); }
function loopback(host) {
  const value = String(host ?? '').toLowerCase().replace(/^\[|\]$/gu, '');
  return value === 'localhost' || value === '::1' || (net.isIP(value) === 4 && value.startsWith('127.'));
}
function samePath(left, right) { return path.relative(left, right) === ''; }
function identifier(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/u.test(value) ? value : null; }
function proof(body, dateScenario) {
  try {
    const payload = JSON.parse(body.input.find(item => item.role === 'user').content);
    const observation = payload.observation, matter = observation?.matter;
    if (dateScenario) {
      return {
        preparationId: identifier(payload.authorizedScope?.preparationId),
        preparationVersion: Number.isSafeInteger(payload.authorizedScope?.version) ? payload.authorizedScope.version : null,
        selectedItems: Array.isArray(observation?.items) ? observation.items.filter(item => item.status === 'selected')
          .map(item => ({ id: identifier(item.id), textSha256: typeof item.text === 'string' ? sha(item.text) : null })) : [],
        latestFeedbackTextSha256: typeof observation?.latestFeedback?.text === 'string' ? sha(observation.latestFeedback.text) : null,
        historyCount: Number.isSafeInteger(observation?.historyCount) ? observation.historyCount : null,
        historyAllowed: observation?.historyAllowed === true,
      };
    }
    return { matterId: identifier(matter?.id), matterVersion: Number.isSafeInteger(matter?.version) ? matter.version : null,
      arrangements: Array.isArray(matter?.arrangements) ? matter.arrangements.map(item => ({
        id: identifier(item.id), status: ['adopted', 'tried', 'not_started', 'changed', 'completed'].includes(item.status) ? item.status : null,
        textSha256: typeof item.text === 'string' ? sha(item.text) : null,
      })) : [], latestFeedbackTextSha256: typeof observation?.latestFeedback?.text === 'string' ? sha(observation.latestFeedback.text) : null,
      historyCount: Number.isSafeInteger(observation?.historyCount) ? observation.historyCount : null };
  } catch { return null; }
}

function installGuard(options = {}) {
  const env = options.environment ?? process.env;
  const directory = env.THINKING_P1_REAL_DIR;
  if (!directory || !path.isAbsolute(directory)) fail('absolute_evidence_directory_required');
  const root = fs.realpathSync(directory);
  const data = path.join(root, 'data');
  if (!env.APP_DATA_DIR || !samePath(path.resolve(env.APP_DATA_DIR), data)
      || !samePath(fs.realpathSync(data), data)) fail('isolated_data_directory_required');
  if (globalThis[INSTALLED]) {
    if (!samePath(globalThis[INSTALLED].directory, root)) fail('already_installed_for_another_directory');
    return globalThis[INSTALLED];
  }
  const authorizationPath = path.join(root, 'AUTHORIZATION.json');
  if (!samePath(fs.realpathSync(authorizationPath), authorizationPath)) fail('authorization_path_invalid');
  const authorizationBytes = fs.readFileSync(authorizationPath);
  const authorization = JSON.parse(authorizationBytes.toString('utf8'));
  if (authorization.mode !== 'real' || authorization.maxRequests !== MAX_REQUESTS || authorization.model !== MODEL) fail('authorization_invalid');
  const dateScenario = authorization.scenario === DATE_SCENARIO;
  if (authorization.scenario !== undefined && !dateScenario && authorization.scenario !== 'daily_reflection_thinking_v1') fail('authorization_scenario_invalid');
  const sharedPath = path.join(data, dateScenario ? 'date-companion.sqlite' : 'daily-reflection.sqlite');
  const authorizationHash = sha(authorizationBytes);
  const captureInput = env.THINKING_REAL_CAPTURE_SYNTHETIC_INPUT === '1';
  if (captureInput && (authorization.captureSyntheticInput !== true || authorization.accountScope !== 'new local synthetic account only'))
    fail('synthetic_input_capture_not_authorized');
  const ledgerPath = path.join(root, 'network-ledger.sqlite');
  if (fs.existsSync(ledgerPath) && !samePath(fs.realpathSync(ledgerPath), ledgerPath)) fail('ledger_path_invalid');
  const db = new Database(ledgerPath);
  db.pragma('busy_timeout = 10000'); db.pragma('synchronous = FULL');
  db.exec(`CREATE TABLE IF NOT EXISTS guard_state (
    id INTEGER PRIMARY KEY CHECK(id=1), authorization_sha256 TEXT NOT NULL,
    mode TEXT NOT NULL, model TEXT NOT NULL, max_requests INTEGER NOT NULL CHECK(max_requests=12),
    halted INTEGER NOT NULL DEFAULT 0, halt_reason TEXT, halted_at TEXT);
    CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
    started_at TEXT NOT NULL, finished_at TEXT, http_status INTEGER, model TEXT NOT NULL,
    input_chars INTEGER NOT NULL, output_limit INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
    response_id TEXT, final_output_sha256 TEXT, stream_sha256 TEXT, reason_code TEXT,
    request_body_sha256 TEXT NOT NULL, request_proof_json TEXT);
    CREATE TABLE IF NOT EXISTS guard_reconciliations (
    id TEXT PRIMARY KEY, recorded_at TEXT NOT NULL, proof_json TEXT NOT NULL);`);
  const now = options.now ?? (() => new Date().toISOString());
  const writeJson = (name, value) => {
    const target = path.join(root, name), temporary = `${target}.${crypto.randomUUID()}.tmp`;
    if (fs.existsSync(target) && !samePath(fs.realpathSync(target), target)) fail('artifact_path_invalid');
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  };
  function snapshot() {
    const state = db.prepare('SELECT halted,halt_reason,halted_at FROM guard_state WHERE id=1').get();
    const count = db.prepare(`SELECT COUNT(*) sent,
      SUM(state='completed') completed, SUM(state='unknown') unknown,
      SUM(state IN ('dispatched','streaming')) active FROM requests`).get();
    return { evidenceMode: 'real', model: MODEL, maxRequests: MAX_REQUESTS, sent: count.sent,
      completed: count.completed ?? 0, unknown: count.unknown ?? 0, active: count.active ?? 0,
      halted: Boolean(state?.halted), haltReason: state?.halt_reason ?? null, haltedAt: state?.halted_at ?? null };
  }
  const persistState = () => writeJson('state.json', snapshot());
  function halt(reason) {
    db.prepare('UPDATE guard_state SET halted=1,halt_reason=?,halted_at=? WHERE id=1 AND halted=0').run(reason, now());
    persistState();
  }
  db.transaction(() => {
    const previous = db.prepare('SELECT * FROM guard_state WHERE id=1').get();
    if (!previous) db.prepare('INSERT INTO guard_state(id,authorization_sha256,mode,model,max_requests) VALUES(1,?,?,?,?)')
      .run(authorizationHash, 'real', MODEL, MAX_REQUESTS);
    else if (previous.authorization_sha256 !== authorizationHash || previous.mode !== 'real'
      || previous.model !== MODEL || previous.max_requests !== MAX_REQUESTS) {
      db.prepare('UPDATE guard_state SET halted=1,halt_reason=?,halted_at=? WHERE id=1').run('authorization_changed', now());
    }
    // Another Next process may install while the original guarded request is
    // legitimately streaming. Installation does not dispatch anything; reserve
    // still rejects every new request while any prior operation is unfinished.
    if (db.prepare("SELECT 1 FROM requests WHERE state='unknown' LIMIT 1").get()) {
      db.prepare('UPDATE guard_state SET halted=1,halt_reason=COALESCE(halt_reason,?),halted_at=COALESCE(halted_at,?) WHERE id=1')
        .run('unknown_previous_request', now());
    }
  }).immediate();
  persistState();
  const permits = new AsyncLocalStorage();
  const realFetch = options.fetch ?? globalThis.fetch;
  const originalFetch = globalThis.fetch;
  const originalConnect = net.Socket.prototype.connect;
  const savedHttp = [];
  let closed = false;
  const safeTokens = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const safeText = text => {
    const key = env.OPENAI_API_KEY;
    return key && key.length > 0 ? text.replaceAll(key, '[REDACTED]') : text;
  };
  function recordArtifact(id, extra = {}) {
    const row = db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    writeJson(`response-${String(id).padStart(3, '0')}.json`, {
      evidenceMode: 'real', index: row.id, requestId: row.request_id, state: row.state, startedAt: row.started_at,
      finishedAt: row.finished_at, httpStatus: row.http_status, model: row.model, inputChars: row.input_chars,
      outputLimit: row.output_limit, usage: { inputTokens: row.input_tokens, outputTokens: row.output_tokens },
      responseId: row.response_id, finalOutputSha256: row.final_output_sha256, streamSha256: row.stream_sha256,
      reasonCode: row.reason_code, requestBodySha256: row.request_body_sha256,
      requestProof: row.request_proof_json ? JSON.parse(row.request_proof_json) : null, ...extra,
    });
    persistState();
  }
  function checkShared(requestId, body) {
    const file = sharedPath;
    let shared;
    try {
      if (!samePath(fs.realpathSync(file), file)) fail('shared_ledger_path_invalid');
      shared = new Database(file, { readonly: true, fileMustExist: true });
      shared.pragma('busy_timeout = 5000');
      const current = shared.prepare('SELECT status FROM agent_calls WHERE id=?').get(requestId);
      if (!current || current.status !== 'running') return 'shared_request_not_running';
      if (dateScenario) {
        const task = shared.prepare(`SELECT c.kind,t.scenario,t.resource_id,t.scope_json FROM agent_calls c
          JOIN agent_tasks t ON t.id=c.task_id WHERE c.id=?`).get(requestId);
        if (!task || task.kind !== 'agent_decision' || task.scenario !== DATE_SCENARIO || !identifier(task.resource_id))
          return 'date_scenario_mismatch';
        let savedScope, requestScope;
        try {
          savedScope = JSON.parse(task.scope_json);
          requestScope = JSON.parse(body.input.find(message => message.role === 'user').content).authorizedScope;
        } catch { return 'date_scope_mismatch'; }
        if (savedScope?.preparationId !== task.resource_id || requestScope?.preparationId !== task.resource_id
          || !identifier(savedScope.generationId) || requestScope.generationId !== savedScope.generationId
          || !Number.isSafeInteger(savedScope.version) || requestScope.version !== savedScope.version) return 'date_scope_mismatch';
      }
      if (shared.prepare("SELECT 1 FROM agent_calls WHERE status='unknown' OR (status='running' AND id<>?) LIMIT 1").get(requestId)) return 'shared_unresolved_request';
      return null;
    } catch { return 'shared_ledger_unavailable'; }
    finally { shared?.close(); }
  }
  function reconcileCompletedStartupPause() {
    if (closed) fail('guard_closed');
    if (dateScenario) fail('startup_reconciliation_not_applicable');
    // This is solely a repair for the old install-time false positive. A real
    // unknown, another halt cause or incomplete/mismatched receipts cannot use it.
    const result = db.transaction(() => {
      const state = db.prepare('SELECT * FROM guard_state WHERE id=1').get();
      if (state.halted !== 1 || state.halt_reason !== 'unresolved_previous_request') fail('startup_reconciliation_not_applicable');
      if (state.authorization_sha256 !== authorizationHash || sha(fs.readFileSync(authorizationPath)) !== authorizationHash
        || state.mode !== 'real' || state.model !== MODEL || state.max_requests !== MAX_REQUESTS) fail('startup_reconciliation_authorization_changed');
      const networkRows = db.prepare('SELECT * FROM requests ORDER BY id').all();
      if (networkRows.length < 1 || networkRows.length >= MAX_REQUESTS) fail('startup_reconciliation_budget_ineligible');
      if (networkRows.some(row => row.state !== 'completed' || row.model !== MODEL || !uuid(row.request_id))) fail('startup_reconciliation_network_not_completed');
      let shared, sharedRows;
      try {
        if (!samePath(fs.realpathSync(sharedPath), sharedPath)) fail('startup_reconciliation_shared_path_invalid');
        shared = new Database(sharedPath, { readonly: true, fileMustExist: true });
        shared.pragma('busy_timeout = 5000');
        sharedRows = shared.prepare('SELECT id,status FROM agent_calls ORDER BY id').all();
      } finally { shared?.close(); }
      const networkIds = networkRows.map(row => row.request_id).sort();
      if (sharedRows.length !== networkRows.length || sharedRows.some(row => !uuid(row.id) || row.status !== 'succeeded')
        || sharedRows.some((row, index) => row.id !== networkIds[index])) fail('startup_reconciliation_shared_mismatch');
      const perRequestProof = networkRows.map(row => ({ requestId: row.request_id,
        proofSha256: sha(JSON.stringify({ requestId: row.request_id, networkIndex: row.id, networkState: row.state, sharedState: 'succeeded' })) }));
      const audit = { auditId: crypto.randomUUID(), stage: 'validated_before_control_release',
        action: 'reconcile_completed_startup_pause', recordedAt: now(), pid: process.pid,
        previousHalt: { halted: true, reason: state.halt_reason, haltedAt: state.halted_at },
        authorizationSha256: authorizationHash, model: MODEL, maxRequests: MAX_REQUESTS,
        networkCount: networkRows.length, sharedCount: sharedRows.length,
        networkRowsSha256: sha(JSON.stringify(networkRows)), sharedRowsSha256: sha(JSON.stringify(sharedRows)),
        perRequestProof, perRequestProofSha256: sha(JSON.stringify(perRequestProof)) };
      const auditPath = path.join(root, 'guard-reconciliation-audit.jsonl');
      if (fs.existsSync(auditPath) && !samePath(fs.realpathSync(auditPath), auditPath)) fail('startup_reconciliation_audit_path_invalid');
      // Append the independent proof before changing the control flag. A failed
      // transaction may leave a pre-release audit, never a false success record.
      fs.appendFileSync(auditPath, JSON.stringify(audit) + '\n', { mode: 0o600 });
      db.prepare('INSERT INTO guard_reconciliations(id,recorded_at,proof_json) VALUES(?,?,?)').run(audit.auditId, audit.recordedAt, JSON.stringify(audit));
      const update = db.prepare("UPDATE guard_state SET halted=0,halt_reason=NULL,halted_at=NULL WHERE id=1 AND halted=1 AND halt_reason='unresolved_previous_request'").run();
      if (update.changes !== 1) fail('startup_reconciliation_control_changed');
      const afterRows = db.prepare('SELECT * FROM requests ORDER BY id').all();
      if (sha(JSON.stringify(afterRows)) !== audit.networkRowsSha256) fail('startup_reconciliation_requests_changed');
      return { reconciled: true, auditId: audit.auditId, networkRowsSha256: audit.networkRowsSha256, sent: networkRows.length };
    }).immediate();
    persistState();
    return { ...result, snapshot: snapshot() };
  }
  const reserve = db.transaction((requestId, body, text) => {
    const denied = (reason, permanent = false) => {
      if (permanent) db.prepare('UPDATE guard_state SET halted=1,halt_reason=?,halted_at=? WHERE id=1 AND halted=0').run(reason, now());
      return { denied: reason, halt: permanent };
    };
    const state = db.prepare('SELECT halted FROM guard_state WHERE id=1').get();
    if (state.halted) return denied('batch_halted');
    if (sha(fs.readFileSync(authorizationPath)) !== authorizationHash) return denied('authorization_changed', true);
    if (db.prepare("SELECT 1 FROM requests WHERE state IN ('dispatched','streaming','unknown') LIMIT 1").get()) return denied('unresolved_request', true);
    if (db.prepare('SELECT 1 FROM requests WHERE request_id=?').get(requestId)) return denied('duplicate_request_id', true);
    if (db.prepare('SELECT count(*) n FROM requests').get().n >= MAX_REQUESTS) return denied('request_budget_exhausted');
    const sharedIssue = checkShared(requestId, body);
    if (sharedIssue) return denied(sharedIssue, true);
    const inserted = db.prepare(`INSERT INTO requests(request_id,state,started_at,model,input_chars,output_limit,request_body_sha256,request_proof_json)
      VALUES(?,'dispatched',?,?,?,?,?,?)`).run(requestId, now(), MODEL, text.length, body.max_output_tokens, sha(text), JSON.stringify(proof(body, dateScenario)));
    return { id: Number(inserted.lastInsertRowid) };
  });
  async function guardedFetch(input, init) {
    if (closed) fail('guard_closed');
    const request = new Request(input, init), url = new URL(request.url);
    if (loopback(url.hostname)) return realFetch(input, init);
    if (url.href === 'https://registry.npmjs.org/-/package/next/dist-tags' && request.method === 'GET') {
      const version = require('next/package.json').version;
      return new Response(JSON.stringify({ latest: version, canary: version }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.href !== ENDPOINT || request.method !== 'POST' || url.username || url.password) fail('external_destination_denied');
    const text = await request.clone().text();
    let body;
    try { body = JSON.parse(text); } catch { fail('request_contract_rejected'); }
    const requestId = request.headers.get('x-client-request-id');
    if (!uuid(requestId) || request.headers.get('x-stainless-retry-count') !== '0'
      || body.model !== MODEL || body.stream !== true || body.store !== false || body.reasoning?.effort !== 'none'
      || !Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens < 1 || body.max_output_tokens > 4000
      || !Array.isArray(body.input) || body.tools?.length || text.length > 52_000) fail('request_contract_rejected');
    if (request.signal.aborted) fail('aborted_before_dispatch');
    const reservation = reserve.immediate(requestId, body, text);
    if (reservation.denied) {
      if (reservation.halt) halt(reservation.denied);
      fail(reservation.denied);
    }
    const id = reservation.id;
    if (captureInput) writeJson(`input-${String(id).padStart(3, '0')}.json`, {
      evidenceMode: 'authorized_synthetic_input', requestId, requestBodySha256: sha(text),
      body: JSON.parse(safeText(text)),
    });
    recordArtifact(id);
    (options.stdout ?? (line => process.stdout.write(line)))(`[thinking-p1-real] ${id}/${MAX_REQUESTS} sent\n`);
    let completed = false, unknown = false, finalText = '', detached = false;
    let bytes = 0, framedEventCount = 0, eofWithPendingEvent = false;
    const streamHash = crypto.createHash('sha256');
    const extra = () => ({ finalAssistantText: finalText,
      stream: { bytes, framedEventCount, completionReceived: completed, eofWithPendingEvent } });
    const markUnknown = reason => {
      if (completed || unknown) return;
      unknown = true;
      db.prepare("UPDATE requests SET state='unknown',finished_at=?,reason_code=?,stream_sha256=? WHERE id=?")
        .run(now(), reason, streamHash.copy().digest('hex'), id);
      halt(reason); recordArtifact(id, extra());
    };
    const onAbort = () => markUnknown('request_aborted');
    const detach = () => { if (!detached) { request.signal.removeEventListener('abort', onAbort); detached = true; } };
    request.signal.addEventListener('abort', onAbort, { once: true });
    let response;
    try { response = await permits.run(true, () => realFetch(request, { redirect: 'error' })); }
    catch { markUnknown('transport_unknown'); detach(); fail('transport_unknown'); }
    db.prepare('UPDATE requests SET http_status=? WHERE id=?').run(response.status, id);
    if (!response.ok || !response.body) {
      markUnknown(response.ok ? 'response_body_missing' : 'http_not_ok'); detach();
      return response;
    }
    if (!unknown) db.prepare("UPDATE requests SET state='streaming' WHERE id=?").run(id);
    recordArtifact(id, extra());
    let reader;
    try { reader = response.body.getReader(); }
    catch { markUnknown('response_body_unreadable'); detach(); fail('response_body_unreadable'); }
    const decoder = new TextDecoder();
    let pending = '', dataLines = [], eventName = '';
    const eventFrame = () => {
      const dataText = dataLines.join('\n'), declaredEvent = eventName;
      dataLines = []; eventName = '';
      if (!dataText || completed || unknown || dataText.trim() === '[DONE]') return;
      framedEventCount++;
      let event;
      try { event = JSON.parse(dataText); } catch { markUnknown('invalid_stream_event'); return; }
      if (!event || typeof event !== 'object' || typeof event.type !== 'string'
        || (declaredEvent && declaredEvent !== event.type)) { markUnknown('invalid_stream_event'); return; }
      if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) {
        db.prepare('UPDATE requests SET input_tokens=?,output_tokens=? WHERE id=?')
          .run(safeTokens(event.response?.usage?.input_tokens), safeTokens(event.response?.usage?.output_tokens), id);
        markUnknown('provider_not_completed'); return;
      }
      if (event.type !== 'response.completed') return;
      const value = event.response;
      if (!value || typeof value !== 'object' || value.status !== 'completed' || value.error != null || value.incomplete_details != null) {
        markUnknown('invalid_completion'); return;
      }
      finalText = safeText((Array.isArray(value.output) ? value.output : []).filter(item => item.type === 'message' && item.role === 'assistant')
        .flatMap(item => Array.isArray(item.content) ? item.content : [])
        .filter(item => item.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join(''));
      const responseId = identifier(value.id);
      db.prepare("UPDATE requests SET state='completed',finished_at=?,input_tokens=?,output_tokens=?,response_id=?,final_output_sha256=?,stream_sha256=? WHERE id=?")
        .run(now(), safeTokens(value.usage?.input_tokens), safeTokens(value.usage?.output_tokens),
          responseId && safeText(responseId) === responseId ? responseId : null, sha(finalText), streamHash.copy().digest('hex'), id);
      completed = true;
      recordArtifact(id, extra());
    };
    const parseText = (value, eof = false) => {
      pending += value;
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index).replace(/\r$/u, ''); pending = pending.slice(index + 1);
        if (!line) eventFrame();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /u, ''));
        else if (line.startsWith('event:')) eventName = line.slice(6).trim();
      }
      if (eof) {
        // Match the SDK's SSE framing: EOF does not dispatch a pending event.
        // Recording a JSON envelope here would claim completion that the app
        // never received, even though both observers saw the same wire bytes.
        eofWithPendingEvent = !completed && Boolean(pending || dataLines.length || eventName);
        pending = ''; dataLines = []; eventName = '';
      }
    };
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) {
            parseText(decoder.decode(), true);
            if (!completed) markUnknown('missing_completion');
            detach(); controller.close(); return;
          }
          streamHash.update(part.value); bytes += part.value.byteLength;
          if (bytes > 2_000_000) { markUnknown('stream_limit'); await reader.cancel(); detach(); controller.error(new Error('thinking_real_guard:stream_limit')); return; }
          parseText(decoder.decode(part.value, { stream: true }));
          controller.enqueue(part.value);
        } catch {
          markUnknown('stream_unknown'); detach(); controller.error(new Error('thinking_real_guard:stream_unknown'));
        }
      },
      async cancel() {
        if (!completed) markUnknown('stream_cancelled');
        detach();
        try { await reader.cancel(); } catch { if (!completed) markUnknown('stream_unknown'); }
      },
    }, { highWaterMark: 0 });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  function targetHost(input, overrides) {
    if (typeof input === 'string' || input instanceof URL) {
      const url = new URL(input); return overrides?.hostname ?? overrides?.host ?? url.hostname;
    }
    return overrides?.hostname ?? overrides?.host ?? input?.hostname ?? input?.host ?? 'localhost';
  }
  for (const module of [http, https]) {
    savedHttp.push([module, module.request, module.get]);
    const request = module.request;
    module.request = function (...args) {
      let host;
      try { host = targetHost(args[0], args[1]); } catch { fail('alternate_http_denied'); }
      if (!loopback(host)) fail('alternate_http_denied');
      return request.apply(this, args);
    };
    module.get = function (...args) { const request = module.request(...args); request.end(); return request; };
  }
  net.Socket.prototype.connect = function (...args) {
    const values = Array.isArray(args[0]) ? args[0] : args;
    const value = values[0];
    const host = typeof value === 'object' && value ? value.host ?? value.hostname ?? 'localhost'
      : typeof values[1] === 'string' ? values[1] : 'localhost';
    if (!loopback(host) && !(permits.getStore() && host === 'tokenhub.vision-intelligence.tech')) fail('raw_socket_denied');
    return originalConnect.apply(this, args);
  };
  globalThis.fetch = guardedFetch;
  syncBuiltinESMExports();
  const api = { directory: root, snapshot, reconcileCompletedStartupPause,
    close() {
      if (closed) return;
      if (globalThis.fetch === guardedFetch) globalThis.fetch = originalFetch;
      net.Socket.prototype.connect = originalConnect;
      for (const [module, request, get] of savedHttp) { module.request = request; module.get = get; }
      syncBuiltinESMExports(); db.close(); closed = true; delete globalThis[INSTALLED];
    },
  };
  globalThis[INSTALLED] = api;
  try { writeJson(`guard-ready-${process.pid}.json`, { pid: process.pid, authorizationSha256: authorizationHash,
    evidenceMode: 'real', model: MODEL, maxRequests: MAX_REQUESTS }); }
  catch { api.close(); fail('guard_readiness_write_failed'); }
  return api;
}
module.exports = { installGuard };
if (module.parent?.id === 'internal/preload') installGuard();
