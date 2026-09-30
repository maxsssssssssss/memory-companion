# Validation Tools

## Current-source release checks (2026-09-30)

`npm test` discovers the current Vitest suites, including product API, repository,
component and script tests. The root configuration does not load developer `.env`
files and excludes `output/`, `reports/`, `tmp/` and other generated evidence.
Historical checkout snapshots are not another copy of the current test suite.
Tests still need isolated application data and explicit network guards when a
runner can invoke external services; disabling environment loading alone is not
a network sandbox.

The following Node-runner suites are deliberately separate from Vitest:

```powershell
node --test scripts/lib/work-review-evaluation-diagnostics.test.mjs scripts/learning-local/runtime.test.mjs scripts/learning-local/ocr-runtime.test.mjs
node scripts/learning-mode-comparison/native-fetch.test.mjs
python -m unittest discover -s scripts/learning-local -p test_ocr_resource_policy.py
```

`npm run lint` generates the current Next route types and checks TypeScript without
scanning saved `output/` checkouts, temporary files or application data. Keep
`next-env.d.ts` on the standard `.next/types/routes.d.ts` reference when preparing
a commit; isolated local Next runners may temporarily generate a different path.
Production build evidence must identify the actual source revision, configuration,
exit code and output directory. A build stopped for local memory pressure is not
a passing build. Run memory-heavy checks sequentially on constrained machines.

The `scripts/learning-compact-generation/`, `learning-input-scope/`,
`learning-mode-comparison/`, `learning-multisource-closure/` and
`learning-synthetic-course/` experiments, and `scripts/learning-local/` launchers,
are local development/acceptance tools. Some
refer to historical synthetic courses, Windows paths or an explicitly authorized
OCR runtime. They are not production startup or deployment commands. Running a
historical real-service script requires current authorization and an independent
budget; committing a script grants neither.

This page indexes existing validation entry points. A command launched locally can still connect to Redis, publish a tunnel, call a remote Provider, or write application data. Select the runner for the affected product and the required evidence; its name alone does not establish isolation.

## Command scope and evidence

The table reflects the entry points checked on 2026-09-14. Follow the linked runner when arguments or configuration change; this is not a requirement to run every command. User authorization and the root `AGENTS.md` govern environment access. Local implementation authorization permits necessary local checks, but does not authorize a server connection or remote Provider call. A missing external authorization or prerequisite blocks only the dependent validation, which should be reported as `NOT RUN` or `BLOCKED` while independent local work continues.

| Entry point | Scope and evidence | Processes, writes, and connections |
| --- | --- | --- |
| `npm test -- <affected test paths>` / `npm test` | Tests selected by [Vitest config](../vitest.config.ts); fixture/unit/integration evidence according to the actual tests. | Does not itself start a production service; individual tests determine mocks, temporary storage, and connections. Inspect the selected tests for relevant boundaries. Confirm discovered files and case counts, including existence of every explicitly requested path. |
| `npm run lint` | Next.js typegen and TypeScript; defined in [package.json](../package.json). | Writes generated Next.js types; no application service startup or Provider request is intended. This already includes TypeScript, so do not repeat a separate `tsc` without a reason. |
| `npm run fixtures:audio` | Synthetic audio preparation through [generate-audio-fixtures.mjs](../scripts/generate-audio-fixtures.mjs); not an ASR result. | Runs Windows SAPI and ffmpeg locally; writes `fixtures/audio/`. `--force` replaces existing generated fixtures. No remote TTS/ASR call. |
| `npm run test:e2e` | Legacy Relationship card and empty-state Browser mock smoke through [run-playwright-e2e.mjs](../scripts/run-playwright-e2e.mjs). | Starts local Next.js and Chromium, and mocks the tested API responses. Next.js generates local build/cache files; this is not a blanket network-isolation guarantee for unmocked requests. It does not validate a real Provider or the three current products end to end. |
| `npm run validate:pipeline` | Real upload/pipeline observation through [validate-pipeline.mjs](../scripts/validate-pipeline.mjs); scope depends on enabled providers and resulting payload. | Starts Next.js and, by default, `cloudflared`; publishes the local port, authenticates/registers a test account, uploads audio, and writes application/job data to configured storage. May call remote Providers and configured Redis. Requires explicit authorization for those external targets and Provider budget. |
| `npm run worker` / `npm run worker:local` | Operational Worker execution, not a test assertion; [Worker](../src/worker/pipeline-worker.ts) / [local supervisor](../scripts/run-local-worker.ts). | Consumes jobs from configured Redis, writes processing state, and may call Providers. `worker:local` additionally publishes a tunnel and writes `.env.audio-tunnel.local`. Confirm target queue/storage and authorized external scope before starting. |
| `npm run queue:health` | Configured Queue/storage health through [queue-health.ts](../scripts/queue-health.ts); not product or Provider acceptance. | Connects to configured Redis and inspects configured storage; its [storage probe](../src/lib/server/queue/storage-probe.ts) may create a local shared-storage marker. Do not classify it as offline or assume a remote target is authorized because the command is diagnostic. |
| `npm run queue:smoke` | Queue recovery integration with deterministic mock Providers through [queue-worker-smoke.ts](../scripts/queue-worker-smoke.ts). | Requires Redis (defaults to `127.0.0.1:6380` only when `REDIS_URL` is unset); creates/cleans its generated smoke queue, resets `.data/evaluation/queue-worker-v1/workspace`, and writes reports under `.data/evaluation/queue-worker-v1/`. Verify Redis is the intended local test instance; remote Redis needs explicit authorization. |

For affected product flows, use their current tests and acceptance runners rather than treating the legacy E2E command as a universal gate. Other scripts in `package.json`, including real-ASR, Provider smoke, migration, replay, and benchmark commands, retain their own arguments, side effects, and authorization requirements; inspect the relevant runner before invoking it.

Report the exact command, exit code, discovered cases or processed count, artifact location when produced, and evidence tier. A successful process or HTTP response alone does not establish product-schema or semantic acceptance. Fixture, Browser mock, real Provider, and target-environment results are separate evidence. If a test selection discovers no tests, it cannot establish acceptance; a mixed selection must also be checked for missing files. Preserve failed and unrun cases instead of converting them to PASS.

## Installed Dependencies

- `ffmpeg-static`: bundled ffmpeg binary used by server audio feature extraction, audio chunking, and fixture generation.
- `ffprobe-static`: bundled ffprobe binary used for duration probing.
- `@playwright/test`: Playwright browser tooling for frontend E2E checks.

The service still respects `FFMPEG_PATH` and `FFPROBE_PATH` when you need to override the bundled binaries.

## Audio Fixtures

Generate privacy-safe test audio:

```bash
npm run fixtures:audio
npm run fixtures:audio -- --force
```

Files:

- `fixtures/audio/non_relationship_60s.wav`: technical discussion; expected `relationshipSignals = []`.
- `fixtures/audio/relationship_dialogue_90s.wav`: synthetic dating/relationship dialogue; expected relationship cards.
- `fixtures/audio/two_speaker_relationship.wav`: synthetic two-role dialogue for diarization smoke tests.

The third file is synthetic. If you need a stronger speaker diarization benchmark, replace it later with a consented two-speaker recording or higher-quality multi-voice TTS.

## Pipeline Validation

After the required external scope and budget are authorized, run a real pipeline validation:

```bash
npm run validate:pipeline -- --fixture non_relationship_60s --date 2026-07-09
npm run validate:pipeline -- --fixture relationship_dialogue_90s --date 2026-07-09
```

Useful options:

```bash
npm run validate:pipeline -- --help
npm run validate:pipeline -- --audio fixtures/audio/two_speaker_relationship.wav --tunnel cloudflared
npm run validate:pipeline -- --fixture relationship_dialogue_90s --tunnel ngrok
npm run validate:pipeline -- --fixture relationship_dialogue_90s --tunnel frp
```

Tunnel notes:

- The default is `--tunnel cloudflared`. `--tunnel none` skips tunnel creation but does not disable remote Providers, configured Redis, authentication, uploads, or persistence.
- `cloudflared` quick tunnels are convenient but not guaranteed stable.
- `ngrok` is usually more stable if the local machine already has auth configured.
- `frp` requires `FRP_PUBLIC_BASE_URL`; `FRP_COMMAND` is optional if frp is already running.

The script does not print API keys or internal audio access tokens. Error messages are token-redacted.

## Local Queue Worker with a Public Audio Tunnel

This is an operational upload setup, not an offline check. Use only for an authorized local Worker/tunnel task with the required Provider access; the commands below do not grant access to a remote Redis or server.

Manual uploads from `localhost` still need a public HTTPS audio URL so the
remote speaker-ASR service can download each audio chunk. A Cloudflare Quick
Tunnel URL is temporary and must not be left in `.env.local`.

Start Redis and Next.js first:

```powershell
docker compose -f compose.redis.yml up -d redis
npm run dev -- -p 3200
```

Then run the local Worker supervisor in a separate terminal:

```powershell
npm run worker:local -- --port 3200
```

The supervisor starts `cloudflared`, waits for the new public URL, verifies it,
atomically writes only `SPEAKER_ASR_AUDIO_BASE_URL` to the Git-ignored,
supervisor-owned `.env.audio-tunnel.local`, and starts the existing Queue Worker
runtime with that URL. It never copies the audio access token or other
credentials into the generated file. Keep the supervisor terminal open while
uploading.

If the tunnel exits, the supervisor gracefully closes the Worker so it cannot
consume Queue jobs with a stale URL. Pressing `Ctrl+C` stops both and removes the
generated file. The ordinary Worker never loads this dedicated file, so a file
left by a forced process termination cannot silently become its ASR address.
Local `npm run worker` and `worker:local` also share an exclusive development
lease and refuse to run together. Production workers do not use this local
lease.

The Quick Tunnel forwards the whole local Next.js port, not only the internal
audio route. Use it only on a trusted development machine, keep the audio access
token configured, and stop the supervisor when the upload finishes.

On shutdown, a first `Ctrl+C` stops the Worker from accepting new jobs and keeps
the Tunnel available until the current BullMQ job has drained. It then closes
the Tunnel and removes the generated URL. If a provider call keeps shutdown
open for too long, a second `Ctrl+C` uses the operating system's normal forced
exit behavior; a job interrupted that way follows the existing BullMQ
stalled-job recovery policy, and the next supervisor start safely removes any
stale generated file and recovers a stale local lease.

Quick Tunnels still do not provide a permanent hostname. Use a Cloudflare named
tunnel, a fixed ngrok domain, or FRP when a stable long-lived address is needed.

## Frontend E2E

Run the legacy Relationship Browser mock smoke when that flow is affected:

```bash
npm run test:e2e
```

It starts a local Next.js server, mocks backend API responses in the browser, and checks:

- relationship card state;
- relationship empty state.

This does not cover the full Date Companion, Daily Reflection, or Work Review user flows, real API persistence, or real Providers. Select the corresponding product tests for those claims.

Playwright specs are also available under `e2e/` via `npm run test:e2e:spec`. Unlike the default wrapper, the current [Playwright config](../playwright.config.ts) does not start a web server; check each spec's setup and mocking before using it. The default npm script uses `scripts/run-playwright-e2e.mjs` because Playwright webServer shutdown has historically hung on this Windows setup.
