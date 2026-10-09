import path from 'node:path';
import { accessSync, constants } from 'node:fs';
import { cloudEnvironment } from './environment.mjs';

// Exact application contracts only. Never inherit arbitrary app, storage,
// device, tunnel, public/browser, mock, evaluation or platform control settings.
export const providerConfigKeys = Object.freeze([
  'OPENAI_BASE_URL', 'OPENAI_TEXT_MODEL', 'OPENAI_QA_MODEL', 'OPENAI_WIRE_API',
  'OPENAI_QA_WIRE_API', 'OPENAI_AUTH_HEADER_MODE', 'OPENAI_REQUEST_TIMEOUT_MS',
  'OPENAI_MAX_RETRIES', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID',
  'OPENROUTER_BASE_URL', 'OPENROUTER_QA_MODEL', 'OPENROUTER_HTTP_REFERER', 'OPENROUTER_APP_TITLE',
  'TRANSCRIPTION_PROVIDER', 'EXTRACTION_PROVIDER', 'OPENAI_TRANSCRIBE_BASE_URL',
  'OPENAI_TRANSCRIBE_MODEL', 'OPENAI_TRANSCRIBE_LANGUAGE', 'OPENROUTER_TRANSCRIBE_CHUNK_SECONDS',
  'SPEAKER_ASR_BASE_URL', 'SPEAKER_ASR_AUDIO_BASE_URL', 'SPEAKER_ASR_AUDIO_URL_TEMPLATE',
  'SPEAKER_ASR_SPEAKER', 'SPEAKER_ASR_LANGUAGE', 'SPEAKER_ASR_TIMEOUT_MS',
  'SPEAKER_ASR_POLL_INTERVAL_MS', 'SPEAKER_ASR_EMPTY_RESULT_GRACE_MS',
  'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'DEEPSEEK_AUDIO_INSIGHT_MODEL',
  'AUDIO_INSIGHT_BASE_URL', 'AUDIO_INSIGHT_TIMEOUT_MS', 'AUDIO_INSIGHT_MAX_RETRIES',
  'PROACTIVE_INSIGHT_BASE_URL', 'PROACTIVE_INSIGHT_TIMEOUT_MS', 'PROACTIVE_INSIGHT_MAX_RETRIES',
  'MEMORY_RELEVANCE_BASE_URL', 'MEMORY_RELEVANCE_TIMEOUT_MS',
  'LEARNING_AI_PROVIDER', 'LEARNING_AI_MODEL', 'LEARNING_AI_MAX_INPUT_CHARS',
  'LEARNING_AI_MAX_OUTPUT_TOKENS', 'LEARNING_AI_REQUEST_TIMEOUT_MS',
  'LEARNING_PDF_SERVICE_URL', 'LEARNING_PDF_SERVICE_EPOCH', 'LEARNING_PDF_SERVICE_INSTANCE',
  'WORK_REVIEW_TARGET_INPUT_TOKENS_PER_WINDOW', 'WORK_REVIEW_MAX_INPUT_TOKENS_PER_WINDOW',
  ...['EXTRACTOR', 'VERIFIER', 'WEEKLY_SYNTHESIZER', 'WEEKLY_VERIFIER',
    'WEEKLY_QA_ANSWERER', 'WEEKLY_QA_VERIFIER'].flatMap(role =>
    ['PROVIDER', 'MODEL', 'TIMEOUT_MS', 'REASONING_EFFORT', 'MAX_OUTPUT_TOKENS']
      .map(setting => `WORK_REVIEW_${role}_${setting}`))
]);
// Network-secret target names must avoid the platform's reserved OPENAI_ prefix.
// Placeholder values stay intact; the platform proxy replaces them on the
// declared HTTPS destination. Application names are assigned only in memory.
export const providerSecretAliases = Object.freeze({
  OPENAI_API_KEY: 'DAILY_BRIEF_OPENAI_API_KEY',
  OPENROUTER_API_KEY: 'DAILY_BRIEF_OPENROUTER_API_KEY',
  DEEPSEEK_API_KEY: 'DAILY_BRIEF_DEEPSEEK_API_KEY',
  OPENAI_TRANSCRIBE_API_KEY: 'DAILY_BRIEF_OPENAI_TRANSCRIBE_API_KEY',
  SPEAKER_ASR_AUDIO_ACCESS_TOKEN: 'DAILY_BRIEF_SPEAKER_ASR_AUDIO_ACCESS_TOKEN',
  LEARNING_PDF_SERVICE_TOKEN: 'DAILY_BRIEF_LEARNING_PDF_SERVICE_TOKEN'
});
const transportKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'];
const present = value => typeof value === 'string' && value.trim().length > 0;

export function assertProviderNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 5)) {
    throw Error('Cloud Provider mode requires Node >=24.5 for native fetch/HTTP proxy support; offline commands retain >=22.13');
  }
}

export function assertProviderTransport(env) {
  if (!present(env.HTTPS_PROXY ?? env.https_proxy)) throw Error('Cloud Provider mode requires the platform HTTPS_PROXY');
  if (env.NO_PROXY.split(',').some(value => value.trim() === '*')) throw Error('Cloud Provider mode refuses a wildcard proxy bypass');
}

export function providerEnvironment(repo, input = process.env, { verifyNoCalls = false } = {}) {
  assertProviderNode();
  if (input.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw Error('Cloud Provider mode refuses disabled TLS verification');
  const env = cloudEnvironment(repo, input, true);
  for (const key of [...providerConfigKeys, ...transportKeys]) if (present(input[key])) env[key] = input[key];
  for (const [target, alias] of Object.entries(providerSecretAliases)) {
    if (present(input[target]) && present(input[alias]) && input[target] !== input[alias]) {
      throw Error(`Conflicting Provider credential sources for ${target}`);
    }
    const value = present(input[alias]) ? input[alias] : input[target];
    if (present(value)) env[target] = value;
    if (present(input[alias])) env[alias] = input[alias];
  }
  // CA errors must fail before launching services, rather than silently losing trust.
  for (const key of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']) {
    if (env[key]) {
      try { accessSync(env[key], constants.R_OK); } catch { throw Error(`Cloud Provider CA file unavailable: ${key}`); }
    }
  }
  const noProxy = [...new Set(['localhost', '127.0.0.1', '::1',
    ...(input.NO_PROXY ?? input.no_proxy ?? '').split(',').map(value => value.trim()).filter(Boolean)])].join(',');
  env.NO_PROXY = noProxy; env.no_proxy = noProxy;
  // Construct trusted options; never reuse inherited NODE_OPTIONS or NODE_PATH.
  env.NODE_OPTIONS = '--use-env-proxy --use-system-ca';
  if (verifyNoCalls) env.NODE_OPTIONS += ` --require=${JSON.stringify(path.join(repo, 'scripts/cloud/offline.cjs'))}`;
  const data = path.join(repo, 'output/codex-cloud/provider-data');
  Object.assign(env, { APP_DATA_DIR: data, DATA_DIR: data, REDIS_URL: 'redis://127.0.0.1:6381',
    PIPELINE_QUEUE_NAME: 'daily-brief-cloud-providers', TRANSCRIPTION_FALLBACK_PROVIDER: 'none',
    EXTRACTION_FALLBACK_PROVIDER: 'none' });
  return env;
}

export function providerConfigurationReport(repo, input = process.env) {
  const env = providerEnvironment(repo, input);
  const missing = keys => keys.filter(key => !present(env[key]));
  return {
    configuredNames: providerConfigKeys.filter(key => present(env[key])),
    credentials: Object.entries(providerSecretAliases).map(([target, alias]) => ({
      target, networkSecretVariable: alias, present: present(env[target]), aliasPresent: present(env[alias])
    })),
    transport: { httpProxy: present(env.HTTP_PROXY ?? env.http_proxy),
      httpsProxy: present(env.HTTPS_PROXY ?? env.https_proxy), extraCa: present(env.NODE_EXTRA_CA_CERTS),
      tlsVerification: true, loopbackBypassesProxy: true },
    missing: {
      openaiCompatible: missing(['OPENAI_BASE_URL', 'OPENAI_API_KEY']),
      learningGeneration: missing(['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'LEARNING_AI_PROVIDER',
        'LEARNING_AI_MODEL', 'LEARNING_AI_MAX_INPUT_CHARS', 'LEARNING_AI_MAX_OUTPUT_TOKENS']),
      speakerAsr: missing(['SPEAKER_ASR_BASE_URL', 'SPEAKER_ASR_AUDIO_BASE_URL']),
      pdfOcr: missing(['LEARNING_PDF_SERVICE_URL', 'LEARNING_PDF_SERVICE_TOKEN',
        'LEARNING_PDF_SERVICE_EPOCH', 'LEARNING_PDF_SERVICE_INSTANCE'])
    }
  };
}
