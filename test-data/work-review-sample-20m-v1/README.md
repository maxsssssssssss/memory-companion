# Work Review 20-minute synthetic meeting sample

This directory contains a fully fictional, locally generated Chinese work meeting for Work Review upload testing.

## Contents

- `audio/work-review-sample-20m-v1.wav`: generated 16 kHz mono PCM WAV.
- `transcript.md`: speaker-labeled transcript with timestamps derived from the generated utterance audio.
- `manifest.json`: actual duration, format, size, SHA-256, voices, and generation method.
- `dialogue.json`: single source of truth for both TTS and transcript text.
- `expected-results.json`: semantic `must` / `mustNot` boundaries for manual Work Review evaluation.
- `source.json`: deterministic generation configuration.
- `generate-audio.mjs` and `validate-audio.mjs`: local generation and validation scripts.

All people, organizations, projects, events, metrics, and dates are fictional. No user data or external Provider is used.

## Generate and validate

```powershell
node test-data/work-review-sample-20m-v1/generate-audio.mjs --force
node test-data/work-review-sample-20m-v1/validate-audio.mjs
```

Windows OneCore voices and FFmpeg versions may change future byte-level output. Always trust the newly generated `manifest.json` SHA-256 for that run.
