# Voiceprint Provider Controlled Smoke Test

This runbook prepares a controlled real-Provider check for the company
Voiceprint and Speaker Diarization APIs. It does not make the check part of the
production Pipeline.

## Safety boundary

- Use synthetic voices only. Do not upload real users, contacts, or private
  recordings.
- Use an isolated local data root and a dedicated test account.
- Keep Provider credentials in `.env.local` or the process environment.
- Do not retain audio, embeddings, Provider-private voiceprint material,
  transcripts, or response bodies in identity metadata or reports.
- Retain only operation status, request identifiers, field names, numeric
  ranges, safe hashes, and the Speaker Identity audit.
- Stop after the first failed terminal step. Do not rename speakers or tune
  thresholds until the failed run has been reviewed.

## Prerequisites

1. Prepare two short recordings with the same two synthetic voices but
   different spoken content:
   - recording A: initial diarization and contact confirmation;
   - recording B: cross-recording identity observation.
   Both uploads must still retain their audio files. A standard production
   upload removes its source audio after reaching `ready`; use the project's
   explicit evaluation-retention path for this controlled test. The train API
   returns `voiceprint_training_audio_unavailable` instead of sending a dead URL.
2. Configure the existing Speaker ASR URL delivery path with an HTTPS URL that
   the Provider can reach.
3. Configure:
   - `SPEAKER_ASR_BASE_URL`;
   - `SPEAKER_ASR_AUDIO_BASE_URL`;
   - `SPEAKER_ASR_AUDIO_ACCESS_TOKEN`;
   - optional `VOICEPRINT_BASE_URL`;
   - `VOICEPRINT_TIMEOUT_MS`;
   - `VOICEPRINT_MAX_RETRIES=1`;
   - `VOICEPRINT_RETRY_DELAY_MS=500`.
4. Use a stable client request ID for every train/save mutation. Repeating the
   same logical action must reuse that ID.

## Speaker-label prerequisite diagnostic

Before permitting any Voiceprint mutation, run the dedicated diagnostic:

```powershell
$env:RUN_VOICEPRINT_REMOTE_VERIFY = "1"
npm run voiceprint:diarization:smoke -- --remote
```

This command hard-disables `voiceprint/train` and `voiceprint/save`. It uses a
synthetic two-speaker sample of at least 60 seconds and:

1. submits combined ASR with `speaker: 2`;
2. polls until `data.speaker_result` is non-empty;
3. does not treat `asr_result` alone as diarization completion;
4. after a bounded speaker-result grace period, projects the returned ASR
   `text + timestamp(s)` into the documented standalone
   `/api/ai/non-realtime-speaker-diarization` request;
5. polls standalone diarization until `data.result` is non-empty or the
   explicit timeout is reached.

The current development endpoint accepts numeric `speaker: 2`. A compatibility
probe that also sent the documentation's separate
`speaker_diarization: true` field returned Provider `code=1`, so the production
diagnostic omits that boolean field. Reports retain only request-field
summaries, response field names/counts, Provider codes, label counts, source,
and latency. They do not retain transcript text, audio URLs, request/user IDs,
or raw responses.

Only `nextVoiceprintTestReady=true` permits a later, separately authorized
train/save smoke. Local `speaker_<index>` labels are not global identities.

## Scenario

### 1. Diarize recording A

Run the normal chunk ASR path and record only:

- upload and AudioChunk IDs;
- the Provider `record_id` used for that chunk;
- returned local speaker labels;
- request status and elapsed time.

Do not assume `speaker_0` or `speaker_1` identifies a person.

### 2. Confirm and save one contact

After a human confirms the local speaker, call the authenticated
`POST /api/speaker-identity/voiceprint/save` route with:

- a stable client `requestId`;
- recording A's upload ID;
- its TranscriptChunk ID;
- the confirmed local speaker label;
- a test-only global contact ID and display name.

The server must send the corresponding `AudioChunk.id` as Provider
`record_id`. Expected local operation transitions are:

```text
pending -> provider_succeeded -> succeeded
```

Repeat the same API request once with the same request ID. Expected result:

- `reused=true`;
- no second completed local identity or mapping;
- unchanged input digest.

If the first request times out, retain the operation and review Provider
idempotency before retrying. The adapter reuses the same Provider `req_id`, but
the supplied Provider document does not prove remote deduplication semantics.

### 3. Diarize recording B

Run the same ASR + diarization path for recording B. Record whether the
Provider returns:

- the saved contact label;
- an opaque stable ID;
- only a fresh chunk-local label;
- any confidence field.

Do not normalize or infer undocumented fields.

### 4. Resolve identity

Pass recording B's real TranscriptChunks through the existing repository and
resolver path:

```text
ASR speaker label
-> JsonSpeakerIdentityRepository.loadVoiceprintHints()
-> resolveSpeakerIdentities()
-> optional identity metadata
-> Transcript Merge
```

Acceptance criteria:

- an exact, unique Provider match may produce `known_contact`;
- no match remains `unknown_person`;
- conflicting hints remain `unknown_person`;
- the original local `speaker`, segment ID, timestamps, and transcript text are
  unchanged;
- no Memory item is rewritten by this test.

## Failure checks

Run controlled adapter tests, not destructive Provider mutations, for:

- timeout and network failure;
- HTTP 408, 429, and 5xx bounded retry;
- malformed or oversized response;
- Provider `code != 0`;
- same request ID with a different input digest;
- two stored profiles sharing one Provider label;
- two local speakers receiving the same Provider identity in one chunk.

## Report

The smoke report should include:

- API availability and status code;
- observed response field structure;
- operation transitions and attempt count;
- whether repeated request IDs are deduplicated;
- recording A/B local labels;
- resolved identity type/source/confidence;
- ambiguous-match count;
- hashes of safe report artifacts.

It must explicitly distinguish:

1. application integration success;
2. Provider cross-recording label stability;
3. actual acoustic identity accuracy.

Only the first is currently covered by automated tests.
