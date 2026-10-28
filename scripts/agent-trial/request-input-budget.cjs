// Acceptance-only transport ceiling; never changes the request-count ledger.
function trialInputBudget(env) {
  const raw = env.LEARNING_AGENT_DECISION_MAX_INPUT_CHARS === undefined ? '200000' : env.LEARNING_AGENT_DECISION_MAX_INPUT_CHARS.trim();
  const chars = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(chars) || chars < 1000 || chars > 1000000)
    throw Error('agent_trial_input_limit_invalid');
  return env.AGENT_TRIAL_PHASE === 'protocol' ? 48000 : chars;
}
function withinTrialInputBudget(text, maxOutputTokens, env) {
  return text.length <= trialInputBudget(env)
    && Buffer.byteLength(text, 'utf8') + maxOutputTokens + 32768 <= 1048576;
}
module.exports = { trialInputBudget, withinTrialInputBudget };
