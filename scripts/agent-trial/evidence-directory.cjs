// Read-only guard shared by the launcher and both transport preloads. A trial
// directory never changes evidence tier merely because a later command has a flag.
const fs = require('node:fs');
const path = require('node:path');
function assertEvidenceDirectory(root, mode) {
  if (!['offline', 'real'].includes(mode)) throw Error('agent_trial_evidence_mode_invalid');
  const oppositeLedger = mode === 'real' ? 'offline-provider.sqlite' : 'network-ledger.sqlite';
  if (fs.existsSync(path.join(root, oppositeLedger))) throw Error('agent_trial_evidence_mode_conflict');
  const ownLedger = mode === 'real' ? 'network-ledger.sqlite' : 'offline-provider.sqlite';
  if (fs.existsSync(path.join(root, ownLedger))) {
    // File names are not provenance. Inspect only schema, never saved bodies or
    // user databases; renaming a fixture ledger cannot turn it into real calls.
    let db;
    try {
      const Database = require('better-sqlite3');
      db = new Database(path.join(root, ownLedger), { readonly: true, fileMustExist: true });
      const names = new Set(db.prepare('PRAGMA table_info(requests)').all().map(column => column.name));
      const offline = names.has('actual_network_requests') && names.has('kind');
      const real = names.has('phase') && names.has('model') && names.has('input_tokens');
      if (mode === 'real' && offline || mode === 'offline' && real) throw Error('agent_trial_evidence_mode_conflict');
      if (!(mode === 'real' ? real : offline)) throw Error('agent_trial_evidence_ledger_invalid');
    } catch (error) {
      if (error.message === 'agent_trial_evidence_mode_conflict') throw error;
      throw Error('agent_trial_evidence_ledger_invalid');
    } finally { db?.close(); }
  }
  const runtimePath = path.join(root, 'runtime.json');
  if (!fs.existsSync(runtimePath)) return;
  let runtime;
  try { runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8')); }
  catch { throw Error('agent_trial_runtime_invalid'); }
  if (runtime?.evidenceMode !== undefined) {
    if (runtime.evidenceMode !== mode) throw Error('agent_trial_evidence_mode_conflict');
  } else {
    // Earlier trial launchers omitted the label. Only an existing same-tier
    // ledger can establish their mode; do not guess from a directory name.
    if (!fs.existsSync(path.join(root, ownLedger))) throw Error('agent_trial_evidence_mode_unknown');
  }
}
module.exports = { assertEvidenceDirectory };
