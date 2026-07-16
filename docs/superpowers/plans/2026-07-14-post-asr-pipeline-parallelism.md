# Post-ASR Pipeline Parallelism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run independent post-ASR analysis stages concurrently while preserving existing output schemas, fallbacks, and downstream ordering.

**Architecture:** After transcript persistence, launch text Audio Insight generation, FFmpeg acoustic feature extraction, and external Emotion Signal analysis together. Each branch owns its fallback boundary and returns a timed result; deterministic fusion runs only after all three branches settle. Semantic Timeline, Daily Brief, Relationship Signal, Memory, and Proactive Insight retain their current order.

**Tech Stack:** TypeScript, Next.js server code, Vitest, existing provider abstractions and JSON store.

## Global Constraints

- Do not modify ASR, Chunk Model, Transcript Merge, Memory, Relationship Signal, QA, prompts, models, or schemas.
- Do not add Queue, Worker, Redis, deployment changes, or remote API calls.
- Preserve current result structures and deterministic fallback behavior.
- Logs must contain only stage names, counts, durations, fallback flags, and safe error classifications.

---

### Task 1: Lock the DAG with tests

**Files:**
- Modify: `src/lib/server/pipeline/process-upload.test.ts`

**Interfaces:**
- Consumes: `processUpload(input: ProcessUploadInput)` and development-only dependency injection.
- Produces: regression coverage proving all three branches start before any branch resolves, failures remain isolated, and extraction starts only after the fused analysis result exists.

- [ ] Add controllable deferred providers for Audio Insight, acoustic features, and Emotion Signals.
- [ ] Assert all three providers start before the shared gate is released.
- [ ] Assert extraction does not start before the parallel group completes and receives semantic segments.
- [ ] Add a rejected Audio Insight provider case and assert deterministic rule fallback, acoustic/emotion execution, and final `ready` status.
- [ ] Run `npx vitest run src/lib/server/pipeline/process-upload.test.ts` and confirm the new test fails before implementation.

### Task 2: Implement safe parallel analysis

**Files:**
- Modify: `src/lib/server/pipeline/process-upload.ts`
- Modify: `src/lib/server/fixture-replay/providers.ts`

**Interfaces:**
- Consumes: `AudioInsightProvider`, an acoustic feature extractor returning `AcousticSegmentFeature[]`, and `EmotionSignalProvider`.
- Produces: the existing `AudioInsight[]` after acoustic and emotion fusion, plus safe timing logs.

- [ ] Replace the development-only acoustic enricher dependency with an acoustic feature extractor dependency so feature extraction does not wait for Audio Insight generation.
- [ ] Start Audio Insight, acoustic extraction, and Emotion Signals in one `Promise.all` using stage-local try/catch fallbacks.
- [ ] Use the existing rule Audio Insight provider if the configured/custom provider still rejects after its own provider fallback.
- [ ] Use empty acoustic features or emotion evidence when those optional branches reject.
- [ ] Apply acoustic features and emotion evidence only after all branches settle.
- [ ] Keep Semantic Timeline and all later stages in their current order.
- [ ] Update fixture replay to return deterministic empty acoustic features through the new dependency contract.

### Task 3: Add observability and verify

**Files:**
- Modify: `src/lib/server/pipeline/process-upload.ts`
- Modify: `src/lib/server/pipeline/process-upload.test.ts`

**Interfaces:**
- Produces: `[analysis-parallel]` start, per-stage completion, and group completion logs.

- [ ] Log parallel-group start and completion.
- [ ] Log `audio_insight_duration_ms`, `acoustic_duration_ms`, `emotion_duration_ms`, total elapsed time, and fallback flags.
- [ ] Assert logs contain no transcript content.
- [ ] Run focused pipeline tests.
- [ ] Run transcription/pipeline regression tests.
- [ ] Run `npm run lint` and `npm test`; report any unrelated existing failures explicitly.
