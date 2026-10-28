# Server Deployment

## Server Assumptions

The target server is not assumed to be a dedicated or clean machine. It may be managed by 1Panel and may already host multiple Docker Compose stacks, Redis or database services, and unrelated PM2 applications.

The deployment inspection observed an existing 1Panel Redis container using `redis:8.4.0` and publishing `0.0.0.0:6379->6379`. Treat it as an environment-owned service and leave it unchanged.

Before starting or changing any service:

- inspect existing Docker containers, Compose projects, published ports, PM2 applications, and persistent volumes;
- do not assume host port `6379`, port `3000`, or any other default port is available;
- do not stop, restart, reconfigure, rename, or remove an unknown service;
- operate only on the Daily Brief Compose project and the `daily-brief` / `daily-brief-worker` PM2 processes;
- keep Web and Worker on the same host with access to the same `APP_DATA_DIR`.

The repository Compose file creates a project-owned Redis container. It does not modify the existing 1Panel Redis or any other Redis instance.

## Port Allocation

| Component | Host binding | Container/internal port | Notes |
| --- | --- | --- | --- |
| Daily Brief Web | `3200` | n/a | PM2 starts Next.js with `npm start -- -p 3200`. |
| Daily Brief Redis | `127.0.0.1:6380` | `6379` | Loopback-only project Redis used by BullMQ. |
| Existing 1Panel Redis | Environment-owned | Environment-owned | Do not modify or stop it. |
| Daily Brief Worker | No port | No port | Connects to Redis and the shared data directory. |

The default project environment is:

```env
REDIS_URL=redis://127.0.0.1:6380
```

Port `6380` is the host-side mapping only. Redis continues to listen on `6379` inside its container.

Before deployment, confirm the selected ports are free:

```bash
ss -lntp
docker ps --format 'table {{.Names}}\t{{.Ports}}'
pm2 list
```

Do not resolve a conflict by stopping an unknown container or PM2 process. Change only the Daily Brief deployment configuration in a reviewed maintenance window.

## Shared Data Directory

Production Web and Worker processes must use the same persistent absolute data root:

```env
APP_DATA_DIR=/opt/daily-brief/shared/.data
```

This is a deployment environment value, not a path hardcoded in application or PM2 configuration. Create the directory outside the release tree and grant the deployment user read/write permissions. A new release must reuse the same shared directory.

The previously observed server data root was:

```text
/var/data/daily-brief
```

Do not point the new deployment at `release/.data` and do not migrate only `memory.sqlite`.

## Data Migration

The first deployment must migrate the complete old `APP_DATA_DIR` to the new shared directory:

```text
/var/data/daily-brief
-> /opt/daily-brief/shared/.data
```

The migration must preserve the full directory tree, including at least:

```text
users/
uploads/
jobs/
jobs-by-upload/
segments/
semantic-segments/
sessions/
settings/
memory.sqlite
memory.sqlite-wal
memory.sqlite-shm
```

Also preserve any existing transcript, analysis checkpoint, audio insight, brief item, relationship signal, evidence, relation, and evaluation-retention artifacts found under the data root.

Memory SQLite is only one part of the application state. Authentication users and sessions, upload records, product jobs, transcript artifacts, AnalysisChunk checkpoints, and settings depend on the filesystem hierarchy. Copying only the SQLite files produces an incomplete deployment that can lose account, Job, upload, recovery, and audit continuity.

Migration procedure:

1. Identify the exact old `APP_DATA_DIR` used by the running Web and Worker.
2. Stop only the Daily Brief Web and Worker processes. Do not stop unrelated PM2 or Docker services.
3. Back up the complete old data root before changing it.
4. Copy the entire directory tree while preserving file ownership, permissions, timestamps, and SQLite sidecar files.
5. Set `APP_DATA_DIR=/opt/daily-brief/shared/.data` for both PM2 processes.
6. Verify the deployment user can read and write the shared directory.
7. Start Web and Worker, then confirm users, uploads, jobs, checkpoints, Memory, Evidence, and Relations are visible.
8. Keep the old data root and backup unchanged until the new deployment has passed acceptance.

If SQLite is actively writing, use an application maintenance window or a SQLite-consistent backup method. Do not copy only the main database while omitting an active `-wal` or `-shm` file.

## Redis Deployment

Start only the project Redis service:

```bash
docker compose -f compose.redis.yml up -d redis
docker compose -f compose.redis.yml ps
docker compose -f compose.redis.yml exec redis redis-cli ping
npm run queue:health
```

Expected host endpoint:

```text
127.0.0.1:6380
```

The Compose project uses a dedicated named volume, AOF persistence with `appendfsync everysec`, `maxmemory-policy=noeviction`, and a healthcheck. Confirm the Compose project name and volume ownership before making changes on a server that hosts other Docker projects.

## Daily Reflection Release Contract

Daily Reflection is an enabled production capability in this release. Web and
Worker must receive the same release flags:

```env
DAILY_REFLECTION_UPLOAD_ENABLED=true
DAILY_REFLECTION_BROWSER_RECORDING_ENABLED=true
DAILY_REFLECTION_AI_REVIEW_MODE=on
```

`DAILY_REFLECTION_UPLOAD_ENABLED` is the product-wide gate for file upload,
Cards, Memory recommendations and confirmation, Reflect/Return, and Together
Think. Browser recording additionally requires
`DAILY_REFLECTION_BROWSER_RECORDING_ENABLED=true`; the upload route enforces the
recording-origin gate again on the server.

`DAILY_REFLECTION_AI_REVIEW_MODE=on` makes GPT the user-visible asynchronous
high-quality review role. Rules-based Daily/Weekly Return remains immediately
available; the independent AI Review queue upgrades the page only after the
validated result is ready. The AI Review uses the reviewed GPT alias
(`gpt-5.5`, or `openai/gpt-5.5` through OpenRouter) and does not inherit a
mutable per-account QA model choice. It performs one Provider attempt with no
application fallback; a failure leaves the rules-based review intact.

Web and Worker must receive the same AI Review mode, shared absolute
`APP_DATA_DIR`, `REDIS_URL`, and Provider credentials. `on` requires
`PIPELINE_EXECUTION_MODE=queue` and exactly one project Worker, which starts the
separate AI Review queue at concurrency 1. Before accepting traffic, run
`npm run queue:health` and confirm the AI Review mode is `on`, its worker count
is 1, and waiting/active/recent-failed counts are acceptable. Only current-v2
shadow results may become visible after switching to `on`; pre-safety prompt
versions become stale because prompt version participates in the source
fingerprint, and are never exposed as current results.

When `TRANSCRIPTION_PROVIDER=speaker-asr`, both processes must also receive the
same non-empty `DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET` and the reviewed
`SPEAKER_ASR_AUDIO_BASE_URL`. The capability secret is deployment-only, must not
be committed, and must not reuse `SPEAKER_ASR_AUDIO_ACCESS_TOKEN`. Candidate,
Card-organizer, and Thinking Provider credentials/models must likewise be
injected through the deployment environment rather than committed files.

Toy Sync remains a separate release decision. Unless it has its own approval,
keep these values fail-closed:

```env
DAILY_BRIEF_TOY_SYNC_ENABLED=false
DAILY_BRIEF_TOY_INGESTION_MODE=off
```

The PM2 configuration in this release pins the two Daily Reflection capability
flags to `true` and AI Review to `on` for both processes. Changing `.env.local`
alone will not override those entries. A rollback must use a reviewed PM2
configuration (or the previous release) that sets the capability flags to
`false` and AI Review to `shadow` or `off`, followed by `--update-env` on both
processes. Disabling the surface does not delete existing Reflection, Card,
Memory, Evidence, or AI Review records.

## PM2

Production transcription uses `speaker-asr` without a fallback for all three
product entry points. The versioned PM2 configuration pins these values for
both Web and Worker:

```env
TRANSCRIPTION_PROVIDER=speaker-asr
TRANSCRIPTION_FALLBACK_PROVIDER=none
```

Keep the production environment file and any generated PM2 configuration in
sync with these values. Apply the configuration with `--update-env`, verify
both running processes, and persist the updated PM2 process list. Removing the
fallback variable is not equivalent to `none`: the resolver defaults an unset
value to `fixture`, and Work Review rejects any configured fallback before
calling the transcription provider. If `speaker-asr` fails, transcription now
reports that failure instead of invoking another provider. Provider credentials
and product audio capability secrets remain deployment-only.

The PM2 configuration defines exactly two application processes:

- `daily-brief`: Next.js Web on port `3200`;
- `daily-brief-worker`: independent Queue Worker with no listening port.

Install dependencies and build before starting PM2:

```bash
npm ci
npm run build
pm2 start ecosystem.config.cjs
pm2 list
```

Web and Worker must receive the same `APP_DATA_DIR`, `REDIS_URL`, queue configuration, retention configuration, and provider environment. Do not add a port to the Worker.

After changing environment variables, a plain restart may retain the old PM2 environment. Use:

```bash
pm2 restart daily-brief --update-env
pm2 restart daily-brief-worker --update-env
```

After verification:

```bash
pm2 save
```

Do not use broad commands that restart or delete every PM2 application on a shared server.

## Deployment Verification

### Learning Agent task limits

Learning task limits are server-owned deployment settings. The authenticated
start API snapshots them into the existing task budget; clients and model
actions cannot supply or increase them. Configure the Web process before
starting new tasks:

```env
LEARNING_AGENT_TASK_MAX_CALLS=64
# Optional: defaults to twice MAX_CALLS, so raising calls does not retain 16 steps.
LEARNING_AGENT_TASK_MAX_STEPS=128
LEARNING_AGENT_TASK_MAX_COMPUTE_MS=1800000
LEARNING_AGENT_DECISION_MAX_INPUT_CHARS=200000
```

All values must be positive decimal integers. An explicitly blank, zero,
malformed or numerically unsafe value prevents new task creation with
`agent_not_configured`; it never means unlimited. Execution time is cumulative
active work, excluding waits for the user, and must fit Node's timer range
(at most 2147483647 ms). Step counts must also permit a safe graph recursion
limit. When only the call limit is configured, the step limit follows it;
an explicitly configured step/time limit remains an independent stop condition.

The defaults for new Learning tasks are 64 model calls, 128 actions and
30 minutes of cumulative active execution. Calls include decisions and content
generation, including failed and unknown attempts. No cumulative input/output
token quota is imposed; token usage remains recorded. Per-request bounds
(200000 input characters by default and at most 8000 output tokens), the existing no-progress
threshold (3), source/authorization checks, bounded Quiz repair and unknown
result recovery remain enforced. Task limits are safety ceilings, not criteria
for a learning goal to count as completed.

Changing the environment affects only newly created tasks. Existing tasks keep
their saved budget and usage when reopened, retried, paused, resumed or adjusted;
an exhausted task is not revived by changing deployment settings. The shared
Agent store's fallback policy and historical tasks are unchanged. These settings
do not alter `AGENT_TRIAL_*` caps or the Windows acceptance ledger.

The Learning-only `LEARNING_AGENT_DECISION_MAX_INPUT_CHARS` accepts 1000..1000000
characters, defaults to 200000, and sets both decision configuration and the new
task's saved request budget. The actual decision uses the smaller of the current
server setting and the saved task budget. Explicit older settings such as 47000
still apply; update the process environment to opt into the new capacity. Other
Agent scenarios and Learning generation-role limits are unchanged.

DeepSeek's published V4 Pro context is 1048576 tokens
([official model metadata](https://api-docs.deepseek.com/zh-cn/api/list-models/)).
Characters are not tokens: decisions also enforce a conservative UTF-8 byte
allowance plus the requested output and a 32768-token reserve before dispatch.
This is a protective estimate, not an exact tokenizer. The adopted TokenHub
gateway may expose a smaller window; lower the setting to its confirmed limit.
No real gateway capacity probe was performed for this change. The optional
Windows trial guard follows this input setting for trajectories while retaining
the protocol smoke's 48000-character ceiling and all existing ledger counts.

This policy otherwise retains the required `LEARNING_AGENT_DECISION_*` and
`LEARNING_AGENT_GENERATION_*` model settings. Apply environment changes with
the normal process-manager environment update; do not copy test credentials,
mock accounts or Windows runtime data into production.

Before accepting traffic:

1. Confirm `127.0.0.1:6380` belongs to the Daily Brief Redis container.
2. Confirm the existing Redis and other Docker projects remain unchanged.
3. Confirm `daily-brief` listens on `3200`.
4. Confirm `daily-brief-worker` has no listening port and connects to the configured queue.
5. Run `npm run queue:health`.
6. Confirm Web and Worker resolve the same absolute `APP_DATA_DIR`.
7. Verify migrated users, uploads, jobs, checkpoints, Memory, Evidence, and Relations.
8. Run a small controlled fixture/smoke validation before any real long-recording acceptance.

This deployment hardening changes ports, environment guidance, PM2 startup arguments, and migration documentation only. It does not change Pipeline, ASR, Chunk, Checkpoint, Memory, Relationship, or QA behavior.
