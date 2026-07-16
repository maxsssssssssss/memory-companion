# Analysis Chunk Checkpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded Daily Brief chunk execution and resumable checkpoints for Audio Insight, Daily Brief, and Relationship candidate chunks without changing their output schemas or deterministic reducers.

**Architecture:** A generic server-side checkpoint service stores validated chunk outputs in the authenticated user's existing `JsonStore`. Each analysis stage supplies stable source identity, deterministic input and processor fingerprints, a strict Zod output schema, and its existing provider/fallback executor; the service owns lifecycle persistence, cache validation, atomic writes, and in-process single-flight. Existing bounded schedulers continue to control provider work and existing merge/reducer functions run after ordered chunk outputs are restored.

**Tech Stack:** TypeScript, Zod, Vitest, Node crypto/fs, existing JsonStore and bounded scheduler.

## Global Constraints

- No remote ASR/LLM calls, deployment, push, commit, Queue, Worker, Redis, or distributed lease.
- Do not change Daily Brief prompts/schemas, provider retry/timeout, Relationship reducer, Memory admission, or Evidence First rules.
- Preserve existing final `AudioInsight[]`, `BriefItem[]`, and `RelationshipSignalCard[]` contracts.
- Keep all dirty-worktree changes and avoid reset/clean/staging.

---

### Task 1: Generic Analysis Checkpoint Contract

**Files:**
- Create: `src/lib/server/analysis-chunks/checkpoint.ts`
- Create: `src/lib/server/analysis-chunks/checkpoint.test.ts`
- Modify: `src/lib/server/storage/json-store.ts`
- Modify: `src/lib/server/storage/json-store.test.ts`

**Interfaces:**
- Produces `AnalysisChunkCheckpointSchema`, `JsonAnalysisChunkCheckpointStore`, fingerprint helpers, and `executeWithAnalysisCheckpoint()`.
- Consumes the existing user-scoped `JsonStore` and Zod output schemas.

- [ ] Write failing tests for completed hits, input/processor invalidation, corrupt JSON, invalid output, failed/stale processing records, atomic writes, sanitised errors, isolation, cleanup, and single-flight.
- [ ] Run the focused tests and confirm the missing module/behaviour failures.
- [ ] Implement deterministic canonical hashing and stable checkpoint IDs.
- [ ] Implement lifecycle reads/writes, strict output validation, stale/corrupt handling, and process-local single-flight.
- [ ] Make `JsonStore.write()` atomic using a same-directory temporary file and rename.
- [ ] Run focused tests until green.

### Task 2: Daily Brief Bounded Chunk Runner

**Files:**
- Create: `src/lib/server/extraction/chunk-processing.ts`
- Create: `src/lib/server/extraction/chunk-processing.test.ts`
- Modify: `src/lib/server/extraction/openai-provider.ts`
- Modify: `src/lib/server/extraction/provider.ts`
- Modify: `src/lib/server/extraction/openai-provider.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces `processDailyBriefChunks()` with bounded concurrency, ordered results, per-chunk fallback isolation, checkpoint support, and deterministic merge.
- Consumes existing `planExtractionChunks()`, rule fallback, strict brief item schema, and `mergeBriefItemsWithStats()`.

- [ ] Add failing tests for concurrency 1/2/3, max active work, out-of-order completion, digest equivalence, fallback isolation, and invalid concurrency.
- [ ] Extract orchestration from the serial `for...of` while preserving provider request and fallback behaviour.
- [ ] Restore index order before merge and report completion-count progress.
- [ ] Add `DAILY_BRIEF_CHUNK_CONCURRENCY=2` with strict positive-integer validation.
- [ ] Run extraction tests until green.

### Task 3: Audio Insight And Relationship Candidate Integration

**Files:**
- Modify: `src/lib/server/audio-insights/chunk-processing.ts`
- Modify: `src/lib/server/audio-insights/chunk-processing.test.ts`
- Modify: `src/lib/server/relationship-signals/chunk-processing.ts`
- Modify: `src/lib/server/relationship-signals/chunk-processing.test.ts`

**Interfaces:**
- Both processors accept optional checkpoint context (`store`, `userId`, processor version override).
- Completed cached outputs are revalidated against current evidence before reuse; reducers still execute every run.

- [ ] Add failing hit/miss/invalidation tests for both stages.
- [ ] Wrap Audio Insight per-chunk provider/fallback work in the generic executor.
- [ ] Preload valid Relationship candidate checkpoints, run only misses through the existing initial/recovery queues, and persist validated outputs.
- [ ] Verify fallback provenance remains explicit and failed checkpoints never count as completed.
- [ ] Run both chunk suites until green.

### Task 4: Pipeline And Cleanup Integration

**Files:**
- Modify: `src/lib/server/pipeline/process-upload.ts`
- Modify: `src/lib/server/pipeline/process-upload.test.ts`
- Modify: `src/app/api/uploads/[uploadId]/route.ts`
- Modify: route cleanup tests.

**Interfaces:**
- `processUpload()` passes its user-scoped store/user ID into all three chunk processors.
- Upload deletion and cancellation cleanup call `deleteUpload()` on the analysis checkpoint store.

- [ ] Add failing tests for second-run provider suppression, partial resume, monotonic progress, and scoped cleanup.
- [ ] Wire checkpoint context into Audio Insight, Daily Brief, and Relationship candidate processing.
- [ ] Preserve checkpoints after `ready`; delete them only when the upload is deleted/cancelled.
- [ ] Run pipeline and route suites until green.

### Task 5: Offline Replay, Performance, And Regression Gate

**Files:**
- Create: `scripts/verify-analysis-checkpoints.ts`
- Modify: `package.json`
- Generate (ignored): `.data/evaluation/analysis-checkpoint-v1/*`

**Interfaces:**
- Produces first-run, second-run, partial-invalidation, mock benchmark, JSON and Markdown reports.
- Reuses fixture providers and disables network access.

- [ ] Benchmark six 100ms Daily Brief chunks at concurrency 1, 2, and 3 and verify equal digests.
- [ ] Run both fixture datasets twice without deleting checkpoints and verify second-run provider calls are zero for supported chunk stages.
- [ ] Invalidate one source fingerprint and verify only the affected stage/chunk executes.
- [ ] Verify Evidence First metrics remain zero.
- [ ] Run focused tests, `npm run lint`, `npm test`, `git diff --check`, and `git status --short`; classify only known unrelated full-suite failures separately.
