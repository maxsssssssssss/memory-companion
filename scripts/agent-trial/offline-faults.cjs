// Explicit offline-only acceptance faults. The control file contains only
// synthetic task identities and fault instructions, never app state or scores.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
function initializeFaultLedger(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS offline_fault_claims(id TEXT PRIMARY KEY, point TEXT NOT NULL,
    effect TEXT NOT NULL, claimed_at TEXT NOT NULL, completed_at TEXT)`);
}
function readControl(root) {
  const filename = path.join(root, 'offline-control.json');
  if (!fs.existsSync(filename)) return { version: 1, faults: [] };
  const control = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert(control.version === 1 && Array.isArray(control.faults), 'offline_fault_control_invalid');
  return control;
}
function claimFault(db, root, match) {
  const fault = readControl(root).faults.find(item => typeof item.id === 'string' && match(item) &&
    !db.prepare('SELECT id FROM offline_fault_claims WHERE id=?').get(item.id));
  if (!fault) return null;
  const inserted = db.prepare('INSERT OR IGNORE INTO offline_fault_claims(id,point,effect,claimed_at) VALUES(?,?,?,?)')
    .run(fault.id, fault.point, fault.effect, new Date().toISOString());
  return inserted.changes ? fault : null;
}
async function providerFault(db, root, kind, payload) {
  const fault = claimFault(db, root, item => item.point === 'provider' && item.kind === kind &&
    (!item.pageId || payload.authorizedScope?.pageId === item.pageId));
  if (!fault) return null;
  assert(['delay', 'unknown', 'known_failure'].includes(fault.effect), 'offline_fault_effect_invalid');
  if (fault.effect === 'delay') {
    assert(Number.isInteger(fault.delayMs) && fault.delayMs >= 1 && fault.delayMs <= 60000, 'offline_delay_bound');
    // Deliberately deliver even if the caller revoked authorization meanwhile:
    // the product must fence publication of this late result itself.
    await new Promise(resolve => setTimeout(resolve, fault.delayMs));
  }
  db.prepare('UPDATE offline_fault_claims SET completed_at=? WHERE id=?').run(new Date().toISOString(), fault.id);
  if (fault.effect === 'unknown') throw Error('offline_injected_unknown_transport');
  return fault.effect;
}
function installReceiptFault(Database, ledger, root) {
  assert(process.env.AGENT_TRIAL_MODE === 'offline', 'offline_receipt_fault_only');
  const prepare = Database.prototype.prepare;
  const receiptSQL = 'UPDATE agent_actions SET status=?,ref_json=?,wait_json=?,summary=?,handoff=? WHERE id=? AND task_id=? AND version=?';
  Database.prototype.prepare = function (sql, ...args) {
    const statement = prepare.call(this, sql, ...args);
    if (sql !== receiptSQL || !this.name) return statement;
    const relative = path.relative(path.join(root, 'data', 'users'), path.resolve(this.name)).split(path.sep);
    if (relative.length !== 2 || relative[0] === '..' || relative[1] !== 'agent-tasks.sqlite') return statement;
    const run = statement.run;
    statement.run = function (...bindings) {
      let ref;
      try { ref = bindings[1] && JSON.parse(bindings[1]); } catch { /* Not a result reference. */ }
      if (bindings[0] === 'succeeded' && ref) {
        const fault = claimFault(ledger, root, item => item.point === 'receipt' && ['throw_once', 'exit_once'].includes(item.effect) &&
          item.accountId === relative[0] && item.taskId === bindings[6] && item.version === bindings[7] && item.refKind === ref.kind);
        if (fault?.effect === 'exit_once') {
          fs.writeFileSync(path.join(root, 'offline-fault-exit.json'), JSON.stringify({ evidence: 'offline_fault_injection',
            faultId: fault.id, pid: process.pid, taskId: bindings[6], actionId: bindings[5], version: bindings[7], ref, exitCode: 86, at: new Date().toISOString() }, null, 2));
          process.exit(86);
        }
        if (fault) throw Error('offline_injected_business_receipt_lost');
      }
      return run.apply(this, bindings);
    };
    return statement;
  };
}
module.exports = { initializeFaultLedger, claimFault, providerFault, readControl, installReceiptFault };
