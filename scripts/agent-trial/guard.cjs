// Explicit A0/A1 trial only. Fail closed, one persistent ledger across processes.
// It is not a product Provider, and never writes request/response bodies or secrets.
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { assertEvidenceDirectory } = require('./evidence-directory.cjs');
const root = process.env.AGENT_TRIAL_DIR;
if (!root || !path.isAbsolute(root)) throw Error('agent_trial_directory_required');
if (process.env.AGENT_TRIAL_MODE === 'offline') throw Error('agent_trial_evidence_mode_conflict');
assertEvidenceDirectory(root, 'real');
globalThis.__DAILY_BRIEF_AGENT_TRIAL_GUARD__ = true;
fs.mkdirSync(root, { recursive: true });
const db = new Database(path.join(root, 'network-ledger.sqlite'));
db.pragma('busy_timeout = 10000');
db.pragma('synchronous = FULL');
db.exec(`CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY, phase TEXT, started TEXT, state TEXT,
 model TEXT, input_chars INTEGER, output_limit INTEGER, status INTEGER, input_tokens INTEGER, output_tokens INTEGER)`);
const reserve = db.transaction((phase, body, chars) => {
  if (db.prepare('SELECT count(*) n FROM requests').get().n >= 36) throw Error('trial_total_budget_exhausted');
  if (phase === 'protocol' && db.prepare("SELECT count(*) n FROM requests WHERE phase='protocol'").get().n >= 6)
    throw Error('trial_protocol_budget_exhausted');
  return db.prepare('INSERT INTO requests(phase,started,state,model,input_chars,output_limit) VALUES(?,?,?,?,?,?)')
    .run(phase, new Date().toISOString(), 'dispatched', body.model, chars, body.max_output_tokens).lastInsertRowid;
});
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init), url = new URL(req.url);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return realFetch(input, init);
  if (url.origin !== 'https://tokenhub.vision-intelligence.tech' || url.pathname !== '/v1/responses'
      || url.search || req.method !== 'POST') throw Error('agent_trial_external_destination_denied');
  const text = await req.clone().text(), body = JSON.parse(text);
  if (body.model !== 'deepseek-v4-pro' || text.length > 48000 || !Number.isInteger(body.max_output_tokens)
      || body.max_output_tokens < 1 || body.max_output_tokens > 8000 || body.store !== false || body.stream !== true)
    throw Error('agent_trial_request_contract_rejected');
  const id = reserve.immediate(process.env.AGENT_TRIAL_PHASE || 'trajectory', body, text.length);
  let response;
  try { response = await realFetch(req, { redirect: 'error' }); }
  catch { db.prepare("UPDATE requests SET state='unknown' WHERE id=?").run(id); throw Error('agent_trial_transport_unknown'); }
  db.prepare('UPDATE requests SET status=?,state=? WHERE id=?').run(response.status, response.ok ? 'streaming' : 'failed', id);
  if (!response.ok || !response.body) return response;
  const decoder = new TextDecoder(); let tail = '', completed = false;
  const stream = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      tail += decoder.decode(chunk, { stream: true });
      let at;
      while ((at = tail.indexOf('\n')) >= 0) {
        const line = tail.slice(0, at); tail = tail.slice(at + 1);
        if (line.startsWith('data:')) try {
          const event = JSON.parse(line.slice(5));
          if (event.type === 'response.completed') {
            completed = true; const usage = event.response?.usage;
            db.prepare("UPDATE requests SET state='completed',input_tokens=?,output_tokens=? WHERE id=?")
              .run(usage?.input_tokens ?? null, usage?.output_tokens ?? null, id);
          }
        } catch { /* Not a JSON SSE data line. Never log its body. */ }
      }
      if (tail.length > 2_000_000) throw Error('agent_trial_stream_limit');
      controller.enqueue(chunk);
    },
    flush() { if (!completed) db.prepare("UPDATE requests SET state='unknown' WHERE id=?").run(id); }
  }));
  return new Response(stream, { status: response.status, headers: response.headers });
};
// The selected model transport uses fetch. Reject alternate external HTTP clients.
for (const name of ['node:http', 'node:https']) {
  const mod = require(name), original = mod.request;
  mod.request = function (...args) {
    const target = args[0];
    let host;
    try { host = typeof target === 'string' || target instanceof URL ? new URL(target).hostname : target.hostname || target.host || 'localhost'; }
    catch { throw Error('agent_trial_http_destination_denied'); }
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw Error('agent_trial_http_destination_denied');
    return original.apply(this, args);
  };
  mod.get = function (...args) { const req = mod.request(...args); req.end(); return req; };
}
