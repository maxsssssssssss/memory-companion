import { expect, it } from 'vitest';
import { credentialSelection, trialCredentialEnvironment } from './credential-adapter.mjs';

it('offline mode never inspects a supplied credential source', () => {
  const input = new Proxy({}, { get() { throw Error('credential_read_in_offline_mode'); } });
  expect(trialCredentialEnvironment(input, { real: false, credentialEnv: 'OPENAI_API_KEY' })).toEqual({ OPENAI_API_KEY: 'offline-fixture', LEARNING_AGENT_API_KEY: 'offline-fixture' });
});
it('retains the dedicated variable and explicitly maps a confirmed OPENAI key only into returned child aliases', () => {
  const input = Object.freeze({ DAILY_BRIEF_OPENAI_API_KEY: 'synthetic-dedicated', OPENAI_API_KEY: 'synthetic-confirmed-tokenhub' });
  expect(trialCredentialEnvironment(input, { real: true })).toEqual({ OPENAI_API_KEY: 'synthetic-dedicated', LEARNING_AGENT_API_KEY: 'synthetic-dedicated' });
  expect(trialCredentialEnvironment(input, { real: true, credentialEnv: 'OPENAI_API_KEY' })).toEqual({ OPENAI_API_KEY: 'synthetic-confirmed-tokenhub', LEARNING_AGENT_API_KEY: 'synthetic-confirmed-tokenhub' });
  expect(input).toEqual({ DAILY_BRIEF_OPENAI_API_KEY: 'synthetic-dedicated', OPENAI_API_KEY: 'synthetic-confirmed-tokenhub' });
});
it('does not implicitly substitute unknown providers or disclose credential values on errors', () => {
  const input = { OPENAI_API_KEY: 'synthetic-secret-do-not-disclose', UNRELATED_TOKEN: 'synthetic-other-secret' };
  expect(() => trialCredentialEnvironment(input, { real: true })).toThrow('Configured trial credential missing: DAILY_BRIEF_OPENAI_API_KEY');
  expect(() => trialCredentialEnvironment(input, { real: true, credentialEnv: 'UNRELATED_TOKEN' })).toThrow('Unsupported trial credential variable');
  expect(() => trialCredentialEnvironment({ OPENAI_API_KEY: ' ' }, { real: true, credentialEnv: 'OPENAI_API_KEY' })).toThrow('Configured trial credential missing: OPENAI_API_KEY');
});
it('accepts one explicit selector and rejects missing or repeated selectors', () => {
  expect(credentialSelection(['start', '--real', '--credential-env', 'OPENAI_API_KEY'])).toBe('OPENAI_API_KEY');
  expect(credentialSelection(['start'])).toBeUndefined();
  expect(() => credentialSelection(['--credential-env', '--real'])).toThrow();
  expect(() => credentialSelection(['--credential-env', 'OPENAI_API_KEY', '--credential-env', 'DAILY_BRIEF_OPENAI_API_KEY'])).toThrow();
});
