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

## PM2

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
