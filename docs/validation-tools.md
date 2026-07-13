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

## Frontend E2E

Run the stable Playwright smoke test:

```bash
npm run test:e2e
```

It starts a local Next.js server, mocks backend API responses in the browser, and checks:

- relationship card state;
- relationship empty state.

The standard Playwright spec is also available under `e2e/`, but the default npm script uses `scripts/run-playwright-e2e.mjs` because Playwright webServer shutdown can hang on this Windows setup.
