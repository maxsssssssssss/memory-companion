# Validation Tools

This project includes a small local validation toolkit for ASR, diarization, LLM extraction, Relationship Signal Cards, and frontend rendering.

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

Run a real pipeline validation:

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

- `cloudflared` quick tunnels are convenient but not guaranteed stable.
- `ngrok` is usually more stable if the local machine already has auth configured.
- `frp` requires `FRP_PUBLIC_BASE_URL`; `FRP_COMMAND` is optional if frp is already running.

The script does not print API keys or internal audio access tokens. Error messages are token-redacted.

## Local Queue Worker with a Public Audio Tunnel

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

Run the stable Playwright smoke test:

```bash
npm run test:e2e
```

It starts a local Next.js server, mocks backend API responses in the browser, and checks:

- relationship card state;
- relationship empty state.

The standard Playwright spec is also available under `e2e/`, but the default npm script uses `scripts/run-playwright-e2e.mjs` because Playwright webServer shutdown can hang on this Windows setup.
