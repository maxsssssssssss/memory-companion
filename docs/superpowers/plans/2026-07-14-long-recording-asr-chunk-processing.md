# Long Recording ASR Chunk Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded, retryable, checkpointed speaker-ASR chunk processing that still produces the existing `TranscriptSegment[]` contract.

**Architecture:** A provider-neutral planner materializes fixed-duration audio chunks, a bounded scheduler executes a chunk adapter and persists JSON checkpoints, and a deterministic merge restores the upload-global transcript. `processUpload` uses this path only for the configured `speaker-asr` provider; fixture/OpenAI and injected test providers retain their existing behavior.

**Tech Stack:** TypeScript, Zod, Vitest, ffmpeg-static/ffprobe-static, existing JsonStore, Next.js route handlers.

## Global Constraints

- Do not call remote ASR in tests or verification.
- Do not modify Memory, Relationship Signal, Daily Brief, QA, or evidence schemas.
- Do not add Redis, a queue, a worker, or a database migration.
- Keep the downstream result as the existing `TranscriptSegment[]`.
- Never continue downstream with a silently incomplete transcript.

---

### Task 1: Audio chunk planning and materialization

**Files:**
- Create: `src/lib/server/transcription/chunks/audio-planner.ts`
- Create: `src/lib/server/transcription/chunks/audio-planner.test.ts`

**Interfaces:**
- Consumes: `{ uploadId, filePath, chunkDurationSeconds?, now? }`
- Produces: `planAudioChunks(input, dependencies?): Promise<AudioChunk[]>`, `AudioChunkPlanningStrategy`, and cleanup helpers.

- [ ] Write tests for a 30-minute input producing six 5-minute chunks, a short input reusing the uploaded file, stable IDs, and strategy metadata.
- [ ] Run `npm test -- src/lib/server/transcription/chunks/audio-planner.test.ts` and confirm the missing module failure.
- [ ] Implement ffprobe duration detection, a fixed-duration strategy, ffmpeg materialization, injectable test dependencies, and generated-file cleanup.
- [ ] Re-run the focused test and confirm it passes without invoking ffmpeg in unit tests.

### Task 2: JSON checkpoint store and bounded scheduler

**Files:**
- Create: `src/lib/server/transcription/chunks/checkpoint-store.ts`
- Create: `src/lib/server/transcription/chunks/checkpoint-store.test.ts`
- Create: `src/lib/server/transcription/chunks/scheduler.ts`
- Create: `src/lib/server/transcription/chunks/scheduler.test.ts`

**Interfaces:**
- Consumes: `AudioChunk[]`, `ChunkTranscriptionAdapter`, concurrency/retry/timeout options.
- Produces: `{ completed: TranscriptChunk[], failed: AudioChunk[] }` and per-chunk JSON checkpoints.

- [ ] Write tests proving per-user JSON checkpoint isolation, bounded concurrency, retry after submit/query/timeout-class failures, and partial failure isolation.
- [ ] Run focused tests and confirm missing module failures.
- [ ] Implement one JSON record per audio/transcript chunk, redacted error serialization, worker-pool scheduling, abortable attempt timeouts, and chunk lifecycle updates.
- [ ] Re-run focused tests and confirm all scheduler/checkpoint tests pass.

### Task 3: Speaker-ASR chunk adapter and transcript merge

**Files:**
- Create: `src/lib/server/transcription/chunks/adapter.ts`
- Create: `src/lib/server/transcription/chunks/transcript-merge.ts`
- Create: `src/lib/server/transcription/chunks/transcript-merge.test.ts`
- Modify: `src/lib/server/transcription/speaker-asr-provider.ts`
- Modify: `src/lib/server/transcription/speaker-asr-provider.test.ts`

**Interfaces:**
- Consumes: `AudioChunk` and speaker-ASR responses with chunk-local timestamps.
- Produces: a completed `TranscriptChunk`, then `mergeTranscriptChunks(chunks): TranscriptSegment[]`.

- [ ] Write tests for chunk URL generation, request metadata isolation, local-to-global offsets, deterministic unique segment IDs, chronological ordering, and speaker preservation.
- [ ] Run focused tests and confirm failures before implementation.
- [ ] Add a generic chunk adapter contract, refactor speaker-ASR request internals to accept an explicit chunk URL and abort signal, and return provider metadata only inside chunk metadata.
- [ ] Implement deterministic merge with an optional future speaker reconciliation hook.
- [ ] Re-run focused tests and confirm they pass.

### Task 4: Upload orchestration and internal chunk streaming

**Files:**
- Create: `src/lib/server/transcription/chunks/process-audio.ts`
- Create: `src/lib/server/transcription/chunks/process-audio.test.ts`
- Modify: `src/lib/server/transcription/provider.ts`
- Modify: `src/app/api/internal/audio/[userId]/[uploadId]/route.ts`
- Modify: `src/app/api/internal/audio/route.test.ts`
- Modify: `src/lib/server/pipeline/process-upload.ts`
- Modify: `src/app/api/uploads/[uploadId]/route.ts`

**Interfaces:**
- Consumes: upload path, user-scoped store, selected provider runtime.
- Produces: complete merged `TranscriptSegment[]` or an explicit incomplete-chunk error after all chunks settle.

- [ ] Write integration tests for a simulated 30-minute/six-chunk run, internal authenticated chunk streaming, cleanup, and unchanged direct provider behavior.
- [ ] Run focused tests and confirm failures.
- [ ] Add a speaker-ASR-only orchestration path, persist plans before scheduling, reject partial transcripts, and extend upload deletion/cancellation cleanup to chunk artifacts.
- [ ] Parallelize only the dependency-independent emotion signal branch with text/acoustic insight processing; preserve output behavior.
- [ ] Re-run pipeline, route, provider, and chunk integration tests.

### Task 5: Configuration, documentation, and regression verification

**Files:**
- Modify: `.env.example`
- Modify: `docs/architecture/unified-chunk-model.md`

**Interfaces:**
- Documents: `ASR_CHUNK_DURATION_SECONDS`, `ASR_CHUNK_CONCURRENCY`, `ASR_CHUNK_MAX_RETRIES`, `ASR_CHUNK_RETRY_DELAY_MS`, and `ASR_CHUNK_ATTEMPT_TIMEOUT_MS`.

- [ ] Document defaults, failure semantics, checkpoint collections, and the future queue/worker replacement boundary.
- [ ] Run all chunk/transcription/internal-audio/process-upload tests.
- [ ] Run Relationship Signal and Memory regression tests.
- [ ] Run `npm run lint`.
- [ ] Run the full Vitest suite and report unrelated existing failures separately rather than hiding them.
