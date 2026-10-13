/** Explicit Windows acceptance adapter. Never reads files or mutates parent env.
 * OPENAI_API_KEY is usable only when the caller explicitly selects that already
 * confirmed TokenHub credential; the old dedicated variable remains the default. */
export function trialCredentialEnvironment(input, { real = false, credentialEnv } = {}) {
  if (!real) return { OPENAI_API_KEY: 'offline-fixture', LEARNING_AGENT_API_KEY: 'offline-fixture' };
  const selected = credentialEnv ?? 'DAILY_BRIEF_OPENAI_API_KEY';
  if (!['DAILY_BRIEF_OPENAI_API_KEY', 'OPENAI_API_KEY'].includes(selected)) throw Error('Unsupported trial credential variable');
  const value = input[selected];
  if (typeof value !== 'string' || !value.trim()) throw Error(`Configured trial credential missing: ${selected}`);
  return { OPENAI_API_KEY: value, LEARNING_AGENT_API_KEY: value };
}

export function credentialSelection(args) {
  const index = args.indexOf('--credential-env');
  if (index < 0) return undefined;
  if (args.indexOf('--credential-env', index + 1) >= 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw Error('Expected one --credential-env value');
  return args[index + 1];
}
