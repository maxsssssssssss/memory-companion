# Voice QA Smoke Test

## Purpose

This smoke framework checks the Voice QA control flow without contacting Volcengine or any other remote service:

```text
mock audio bytes
-> ASR partial event
-> ASR final + ASREnded
-> persisted VoiceSessionManager context
-> existing VoiceQaBridge
-> mock memory-aware QA answerer
-> TTS response or simulated TTS failure
```

The required Python entry point is `tests/e2e/test_voice_pipeline.py`. It is deliberately a thin `unittest` runner around `tests/e2e/voice_pipeline_smoke.ts`; the TypeScript harness imports the real `VoiceQaBridge`, so the smoke test does not maintain a second partial/final gate or fallback implementation.

This is an offline contract test. A passing result is not evidence that credentials, the Volcengine WebSocket endpoint, browser microphone permissions, or remote latency are healthy.

## Environment

The checked-in examples are safe defaults:

```env
VOICE_PROVIDER=volcengine
VOICE_TEST_MODE=false
VOICE_DEBUG=false
```

The variables have the following roles:

| Variable | Meaning |
| --- | --- |
| `VOICE_PROVIDER` | Selected runtime provider. The current production adapter is Volcengine. The offline harness accepts `volcengine` or `mock`, but always reports that its actual transport is `mock`. |
| `VOICE_TEST_MODE` | Must be `true` for the offline harness. The harness refuses to start otherwise, which prevents an accidental remote smoke call. Keep it `false` in normal development/production runtime. |
| `VOICE_DEBUG` | Enables bounded, metadata-only smoke diagnostics on stderr. It never prints transcript text, answer text, audio content, credentials, or provider payloads. Keep it `false` unless diagnosing a test. |

Real browser validation additionally needs the existing Volcengine variables in `.env.local`:

```env
VOLCENGINE_APP_ID=
VOLCENGINE_ACCESS_KEY=
VOLCENGINE_APP_KEY=
VOLCENGINE_RESOURCE_ID=volc.speech.dialog
VOLCENGINE_TTS_SPEAKER=
```

Do not put credential values in this document, `.env.example`, logs, screenshots, or test reports.

## Automated offline smoke test

Run from the repository root:

```powershell
npm run voice:smoke
```

The npm command runs:

```powershell
python tests/e2e/test_voice_pipeline.py
```

The Python runner sets `VOICE_PROVIDER=volcengine` and `VOICE_TEST_MODE=true` for its child process. No Volcengine credential is read and no socket is opened; the report explicitly distinguishes `configuredProvider=volcengine` from `transport=mock`.

To inspect the event sequence:

```powershell
$env:VOICE_DEBUG="true"
npm run voice:smoke
Remove-Item Env:VOICE_DEBUG
```

Expected result:

```text
Ran 4 tests

OK
```

The four assertions verify:

1. Provider and logical application sessions are created, short-term context is persisted, and mock audio reaches the provider boundary;
2. a partial ASR hypothesis does not invoke QA;
3. final ASR invokes QA exactly once and produces TTS audio;
4. a TTS provider failure preserves the text answer and reports `tts_failed` without audio.

## Debug output

With `VOICE_DEBUG=true`, the offline harness emits bounded lines such as:

```text
[voice-smoke-debug] event=websocket_connected transport="mock"
[voice-smoke-debug] event=asr_message finality="partial" text_chars=6
[voice-smoke-debug] event=asr_message finality="final" text_chars=10
[voice-smoke-debug] event=qa_completed elapsed_ms=0 evidence_count=1
[voice-smoke-debug] event=tts_started text_chars=14
[voice-smoke-debug] event=websocket_event event_name="TTSResponse" audio_bytes=4
```

Only event names, finality, sizes, counts, elapsed time, and mock session identifiers are logged. Transcript/answer contents, evidence excerpts, binary audio, raw WebSocket payloads, tokens, and credentials are intentionally excluded.

## Manual browser validation

Manual validation uses the real provider and is separate from the offline smoke test. Confirm `.env.local` contains the required credentials, while retaining:

```env
VOICE_PROVIDER=volcengine
VOICE_TEST_MODE=false
```

Start the web application on port 3200:

```powershell
npm run dev -- -p 3200
```

Redis and the pipeline worker are not required to ask about memory that is already present. If the same local session also needs upload processing, start the existing services in separate terminals:

```powershell
docker compose -f compose.redis.yml up -d redis
npm run worker:local -- --port 3200
```

Then open [http://localhost:3200](http://localhost:3200), sign in, select **问答 AI**, and use the **语音问答** panel on the right. There is no separate `/voice` page.

Expected user-visible sequence:

```text
idle -> listening -> thinking -> speaking -> idle
```

Expected server evidence includes the existing Voice QA trace/log entries and a successful `/api/voice/qa` response. Do not treat the offline `[voice-smoke-debug]` lines as remote-provider logs: they describe only the mock transport.

## Debugging workflow

1. Run `npm run voice:smoke`. If it fails, fix the deterministic bridge/event contract before testing credentials.
2. Run the focused TypeScript Voice QA tests to distinguish provider-event parsing from browser/API failures.
3. For a manual run, verify the browser has microphone permission and `.env.local` contains all required Volcengine fields.
4. Confirm the final ASR boundary occurs only once. Repeated partial messages must not create QA calls.
5. If text appears but audio does not, inspect the TTS error classification. The expected graceful degradation is a text response with `tts_failed`.
6. Use `docs/voice-observability.md` for persisted session trace timestamps and latency calculations.

## Current limitations

- The automated smoke uses deterministic mock audio/events; it does not encode a real speech waveform or validate acoustic recognition quality.
- It does not start Next.js, exercise browser `MediaRecorder`, authenticate `/api/voice/qa`, or play WAV audio.
- It does not contact Volcengine and therefore cannot validate account entitlement, speaker IDs, WebSocket framing changes, rate limits, or network recovery.
- `VOICE_DEBUG` covers both the offline harness and the runtime Voice adapter/Bridge. Runtime diagnostics are separately implemented as bounded structural logs and never include transcript text, answer text, Provider payloads, audio, or credentials.
