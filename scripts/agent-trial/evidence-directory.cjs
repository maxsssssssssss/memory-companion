// Read-only guard shared by the launcher and both transport preloads. A trial
// directory never changes evidence tier merely because a later command has a flag.
const fs = require('node:fs');
const path = require('node:path');
function assertEvidenceDirectory(root, mode) {
  if (!['offline', 'real'].includes(mode)) throw Error('agent_trial_evidence_mode_invalid');
  const oppositeLedger = mode === 'real' ? 'offline-provider.sqlite' : 'network-ledger.sqlite';
  if (fs.existsSync(path.join(root, oppositeLedger))) throw Error('agent_trial_evidence_mode_conflict');
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
    const ownLedger = mode === 'real' ? 'network-ledger.sqlite' : 'offline-provider.sqlite';
    if (!fs.existsSync(path.join(root, ownLedger))) throw Error('agent_trial_evidence_mode_unknown');
  }
}
module.exports = { assertEvidenceDirectory };
