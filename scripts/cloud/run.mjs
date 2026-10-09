import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnOwned, stopOwned, completion } from '../lib/owned-process.mjs';
import { assertCleanConfig, cloudEnvironment } from './environment.mjs';
import { providerEnvironment, providerConfigurationReport, assertProviderTransport } from './providers.mjs';
import { providerLogRedactor } from './redact.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [mode, ...args] = process.argv.slice(2);
if (!['check', 'test', 'build', 'dev', 'providers'].includes(mode)) throw Error('Expected check, test, build, dev or providers');
const providers = mode === 'providers';
if (providers && args.some(arg => arg !== '--verify-no-calls')) throw Error('Provider mode accepts only --verify-no-calls');
assertCleanConfig(repo);
const env = providers ? providerEnvironment(repo, process.env, { verifyNoCalls: args.includes('--verify-no-calls') })
  : cloudEnvironment(repo, process.env, mode === 'dev');
if (providers) assertProviderTransport(env);
const children = [];
let stopping;
async function stop() {
  stopping ??= (async () => {
    let failed = false;
    for (const child of [...children].reverse()) {
      try { await stopOwned(child); } catch { failed = true; }
    }
    if (failed) throw Error('Cloud child cleanup failed');
  })();
  return stopping;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().then(() => process.exit(signal === 'SIGINT' ? 130 : 143), () => process.exit(1)); });
function launch(command, values) {
  const child = spawnOwned(command, values, { cwd: repo, env, stdio: providers ? ['inherit', 'pipe', 'pipe'] : 'inherit' });
  if (providers) {
    child.stdout.pipe(providerLogRedactor(env)).pipe(process.stdout, { end: false });
    child.stderr.pipe(providerLogRedactor(env)).pipe(process.stderr, { end: false });
  }
  children.push(child);
  const done = completion(child);
  void done.catch(() => {});
  return { child, done };
}
async function run(values) { await launch(process.execPath, values).done; }
async function freePort(port) {
  await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(port, '127.0.0.1', () => server.close(resolve)); });
}
try {
  await mkdir(env.TMPDIR, { recursive: true });
  await run(['scripts/cloud/preflight.mjs']);
  if (mode === 'check') {
    console.log('[cloud check] 1/2 migration contracts');
    await run(['--test', 'scripts/cloud/environment.test.mjs', 'scripts/lib/owned-process.test.mjs']);
    console.log('[cloud check] 2/2 project lint (Next typegen + TypeScript)');
    await run(['node_modules/next/dist/bin/next', 'typegen']);
    await run(['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false']);
  } else if (mode === 'test') {
    await run(['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=2', ...args]);
  } else if (mode === 'build') {
    env.NODE_ENV = 'production';
    await run(['node_modules/next/dist/bin/next', 'build']);
    await run(['scripts/sanitize-next-traces.mjs']);
  } else {
    const webPort = providers ? 3001 : 3000, redisPort = providers ? 6381 : 6380;
    // Both profiles share .next; refuse concurrent development without taking
    // over any existing service, even though their data/Redis are independent.
    await freePort(3000); await freePort(3001); await freePort(redisPort);
    const redisDir = path.join(repo, 'output/codex-cloud', providers ? 'provider-redis' : 'redis');
    await mkdir(redisDir, { recursive: true });
    if (providers) {
      console.log('[cloud providers] configuration metadata (no values or requests)');
      console.log(JSON.stringify(providerConfigurationReport(repo)));
      if (args.includes('--verify-no-calls')) console.log('[cloud providers] external calls blocked for startup verification');
    }
    console.log('[cloud preview] 1/3 isolated Redis');
    const redis = launch('redis-server', ['--bind', '127.0.0.1', '--port', String(redisPort), '--dir', redisDir,
      '--appendonly', 'yes', '--appendfsync', 'everysec', '--maxmemory-policy', 'noeviction', '--daemonize', 'no']);
    const { default: Redis } = await import('ioredis');
    const client = new Redis(env.REDIS_URL, { lazyConnect: true, retryStrategy: () => null, connectTimeout: 1000 });
    client.on('error', () => {});
    try {
      const deadline = Date.now() + 10000;
      while (true) {
        try { await client.connect(); if (await client.ping() === 'PONG') break; } catch {}
        if (redis.child.exitCode !== null || Date.now() > deadline) throw Error('Isolated Redis failed to start');
        await delay(100);
      }
    } finally { client.disconnect(); }
    console.log('[cloud preview] 2/3 project Worker');
    const worker = launch(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/worker/pipeline-worker.ts']);
    console.log(`[cloud preview] 3/3 Next.js on port ${webPort}; synthetic data only; fixture invite: cloud-synthetic-only`);
    const web = launch(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '0.0.0.0', '-p', String(webPort)]);
    await Promise.race([redis.done, worker.done, web.done]);
    throw Error('A preview service exited; stopping owned services');
  }
} finally { await stop(); }
