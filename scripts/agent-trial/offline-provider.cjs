// Acceptance-only preload. The preceding scripts/cloud/offline.cjs socket guard
// remains active. This replaces Responses payloads, never any application API.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { respond } = require('./offline-fixtures.cjs');
const { assertEvidenceDirectory } = require('./evidence-directory.cjs');
assert.equal(process.env.AGENT_TRIAL_MODE, 'offline', 'offline_mode_must_be_explicit');
const root = process.env.AGENT_TRIAL_DIR;
assert(root && path.isAbsolute(root), 'offline_absolute_trial_directory_required');
assert.equal(path.resolve(process.env.APP_DATA_DIR), path.join(root, 'data'), 'offline_isolated_data_required');
assertEvidenceDirectory(root, 'offline');
fs.mkdirSync(root, { recursive: true });
const db = new Database(path.join(root, 'offline-provider.sqlite'));
db.pragma('busy_timeout = 10000'); db.pragma('synchronous = FULL');
db.exec(`CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY, started TEXT, kind TEXT, state TEXT,
  input_chars INTEGER, output_limit INTEGER, selected_action TEXT, actual_network_requests INTEGER NOT NULL DEFAULT 0)`);
const upstream = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init), url = new URL(request.url);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return upstream(input, init);
  if (url.origin !== 'https://tokenhub.vision-intelligence.tech' || url.pathname !== '/v1/responses' || url.search || request.method !== 'POST')
    throw Error('offline_external_destination_denied');
  const raw = await request.text(), body = JSON.parse(raw);
  assert(body.stream === true && body.store === false && raw.length <= 48000 && body.max_output_tokens <= 8000, 'offline_response_contract_required');
  const message = body.input?.findLast(item => item.role === 'user');
  assert(typeof message?.content === 'string', 'offline_json_user_input_required');
  const payload = JSON.parse(message.content), id = db.prepare('INSERT INTO requests(started,kind,state,input_chars,output_limit) VALUES(?,?,?,?,?)')
    .run(new Date().toISOString(), 'unclassified', 'received', raw.length, body.max_output_tokens).lastInsertRowid;
  let result;
  try { result = respond(payload); }
  catch (error) { db.prepare("UPDATE requests SET state='fixture_rejected' WHERE id=?").run(id); throw error; }
  db.prepare("UPDATE requests SET state='completed',kind=?,selected_action=? WHERE id=?")
    .run(result.kind, result.value.tool ?? (result.value.finish ? 'finish' : result.value.wait ? 'wait' : null), id);
  // Usage is deliberately absent: fixture requests have no Provider tokens.
  // The actual Agent ledger must report unknown usage instead of invented zero.
  const response = { id: `resp_offline_${id}`, object: 'response', status: 'completed', error: null, incomplete_details: null,
    output: [{ id: `msg_offline_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(result.value), annotations: [] }] }] };
  const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.completed', response }];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
