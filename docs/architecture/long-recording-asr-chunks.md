# Long Recording Speaker-ASR Chunk Processing

## Runtime Flow

```text
uploaded audio
  -> fixed-duration AudioChunk planner (default 300 seconds)
  -> ffmpeg materialization for long recordings
  -> bounded worker-pool scheduler
  -> speaker-ASR chunk adapter
  -> TranscriptChunk checkpoints
  -> deterministic upload-global merge
  -> existing TranscriptSegment[] pipeline contract
```

The production `speaker-asr` path uses the unified chunk domain model. OpenRouter transcription
also uses the shared AudioChunk planner and Transcript Merge Service while preserving its existing
request protocol and 60-second compatibility limit. Fixture and direct OpenAI SDK transcription
keep their existing non-chunked paths.

## Modules

- `src/lib/server/transcription/chunks/audio-planner.ts`: ffprobe duration, strategy-based
  ranges, ffmpeg materialization, and generated-file cleanup.
- `src/lib/server/transcription/chunks/checkpoint-store.ts`: one JSON checkpoint per
  audio/transcript chunk.
- `src/lib/server/transcription/chunks/scheduler.ts`: bounded concurrency, attempt timeout,
  retry, backpressure, and failure isolation.
- `src/lib/server/transcription/chunks/adapter.ts`: provider-neutral chunk transcription
  contract.
- `src/lib/server/transcription/chunks/transcript-merge.ts`: local timestamp offset, stable
  segment IDs, ordering, boundary deduplication, source tracing, merge statistics, warnings,
  and a future speaker reconciliation hook.
- `src/lib/server/transcription/chunks/process-audio.ts`: configured provider routing and
  speaker-ASR orchestration.
- `src/lib/server/transcription/openai-provider.ts`: OpenRouter response-to-TranscriptChunk
  adapter and unified merge integration.

## Lifecycle And Checkpoints

Audio chunks move through `created -> processing -> completed|failed`. Retry attempts update
`retryCount`, `updatedAt`, and the redacted structured `error`. Completed transcript chunks are
stored separately.

The user-scoped JsonStore collections are:

- `audio-chunks/{chunkId}.json`
- `transcript-chunks/{transcriptChunkId}.json`

A failed chunk does not cancel unrelated chunks. After all chunks settle, any final failure
prevents an incomplete transcript from entering Audio Insight, Daily Brief, Relationship Signal,
or Memory. Generated chunk files are temporary; checkpoint metadata remains after processing.

## Configuration

```env
ASR_CHUNK_DURATION_SECONDS=300
ASR_CHUNK_CONCURRENCY=3
ASR_CHUNK_MAX_RETRIES=1
ASR_CHUNK_RETRY_DELAY_MS=1000
ASR_CHUNK_ATTEMPT_TIMEOUT_MS=600000
```

The scheduler starts only `ASR_CHUNK_CONCURRENCY` workers, so a 100-chunk upload never creates
100 simultaneous ASR requests.

## Speaker Semantics

The current adapter preserves provider speaker labels and records an identity `speakerMap`.
Automatic cross-chunk speaker identity reconciliation is intentionally not claimed. The merge
API exposes a reconciliation hook so a future implementation can map chunk-local speakers before
the final transcript is produced.

## Transcript Merge Contract

`mergeTranscriptChunks()` returns a structured result containing the existing
`TranscriptSegment[]`, merge statistics, warnings, and a `segmentSources` lookup. Source records
identify the transcript chunk, chunk index, original provider segment ID, and speaker ID scope.
The core `TranscriptSegment` schema remains unchanged; checkpoints and the deterministic segment
ID retain traceability without adding provider-specific fields to downstream evidence objects.

Boundary deduplication is intentionally conservative. It only compares adjacent chunks and removes
a candidate when the global time ranges substantially overlap, normalized text is highly similar,
and the non-empty speaker labels are identical. Different-speaker segments are never collapsed.

## Future Queue/Worker Boundary

The planner, adapter, scheduler, checkpoint store, and merge are separate contracts. A future
queue can enqueue stable AudioChunk IDs; workers can claim `created` or retryable `failed` chunks,
write the same checkpoints, and invoke the same adapter. The downstream pipeline continues to
consume only merged `TranscriptSegment[]`.
