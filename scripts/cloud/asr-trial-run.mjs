import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { cloudEnvironment, assertCleanConfig } from './environment.mjs';
import { assertProviderNode } from './providers.mjs';
import { providerLogRedactor } from './redact.mjs';
import { spawnOwned, stopOwned, completion } from '../lib/owned-process.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2), mode = args[0];
if (!['prepare','status','run','cleanup'].includes(mode) ||
  (mode === 'run' ? args.length !== 3 || args[1] !== '--submit-budget=1' || args[2] !== '--query-budget=30' : args.length !== 1)) {
  console.error('Usage: npm run cloud:asr -- prepare|status|cleanup; run requires --submit-budget=1 --query-budget=30 and task authorization.');
  process.exit(2);
}
assertCleanConfig(repo); assertProviderNode();
const env = cloudEnvironment(repo, process.env);
env.APP_DATA_DIR = env.DATA_DIR = path.join(repo, 'output/codex-cloud/asr-trial-data');
const cosKeys = ['DAILY_BRIEF_COS_BUCKET','DAILY_BRIEF_COS_REGION','DAILY_BRIEF_COS_PREFIX','DAILY_BRIEF_COS_SECRET_ID','DAILY_BRIEF_COS_SECRET_KEY'];
if (mode === 'run' || mode === 'cleanup') {
  for (const key of [...cosKeys,'SPEAKER_ASR_BASE_URL','HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy',
    'NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR','REQUESTS_CA_BUNDLE','CURL_CA_BUNDLE']) if (process.env[key]) env[key] = process.env[key];
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || !(env.HTTP_PROXY ?? env.http_proxy) || !(env.HTTPS_PROXY ?? env.https_proxy)) throw Error('ASR trial requires verified TLS and the platform HTTP/HTTPS proxy');
  env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1,::1';
  env.NODE_OPTIONS = '--use-env-proxy --use-system-ca';
  Object.assign(env,{SPEAKER_ASR_LANGUAGE:'cn',SPEAKER_ASR_SPEAKER:'0',SPEAKER_ASR_TIMEOUT_MS:'60000',
    SPEAKER_ASR_POLL_INTERVAL_MS:'2000',SPEAKER_ASR_EMPTY_RESULT_GRACE_MS:'60000'});
}
await mkdir(env.TMPDIR,{recursive:true});
const child = spawnOwned(process.execPath, ['node_modules/tsx/dist/cli.mjs','scripts/cloud/asr-trial.ts',...args],
  {cwd:repo,env,stdio:['ignore','pipe','pipe']});
const done=completion(child); void done.catch(()=>{});
child.stdout.pipe(providerLogRedactor(env,cosKeys.slice(-2))).pipe(process.stdout,{end:false});
child.stderr.pipe(providerLogRedactor(env,cosKeys.slice(-2))).pipe(process.stderr,{end:false});
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{void stopOwned(child).finally(()=>{process.exitCode=signal==='SIGINT'?130:143;});});
try {await done;} catch {console.error('[asr trial] incomplete; inspect the sanitized report and durable request counters.');process.exitCode=1;}
finally {await stopOwned(child);}
