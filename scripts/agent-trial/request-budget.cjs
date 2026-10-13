// A new real acceptance task must supply its newly authorized bounds. Historical
// A0/A1 allowances are never inferred from code defaults or existing ledgers.
function realTrialBudget(input) {
  const parse = (name, maximum) => {
    const value = input[name];
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || Number(value) > maximum)
      throw Error(`agent_trial_explicit_budget_required:${name}:1..${maximum}`);
    return Number(value);
  };
  const total = parse('AGENT_TRIAL_MAX_REQUESTS', 36);
  const protocol = parse('AGENT_TRIAL_PROTOCOL_MAX_REQUESTS', total);
  return { total, protocol };
}
module.exports = { realTrialBudget };
