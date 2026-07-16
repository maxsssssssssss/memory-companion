# Unified Chunk Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-neutral, validated chunk data contract without changing the production upload pipeline.

**Architecture:** Introduce strict Zod schemas under `src/lib/domain/chunks/` for audio, transcript, and analysis chunks. Transcript timestamps use the upload-global timebase; set and merge envelope schemas enforce cross-chunk identity, upload ownership, and ordering invariants. Existing ASR, extraction, semantic, relationship, and pipeline code remain untouched.

**Tech Stack:** TypeScript 5.8, Zod 3.24, Vitest 4.1.

## Global Constraints

- Do not modify ASR, Daily Brief, Relationship Signal, queue/worker, or production pipeline behavior.
- Do not call remote APIs or deploy.
- Provider-specific state belongs only in `metadata`.
- Preserve the existing `TranscriptSegment` schema and global evidence IDs.

---

### Task 1: Contract tests

**Files:**
- Create: `src/lib/domain/chunks/chunks.test.ts`

**Interfaces:**
- Consumes: existing `TranscriptSegmentSchema` from `src/lib/domain/types.ts`.
- Produces: failing tests for `AudioChunkSchema`, `AudioChunkSetSchema`, `TranscriptChunkSchema`, `TranscriptChunkMergeInputSchema`, and `TranscriptChunkMergeResultSchema`.

- [ ] Write tests for valid audio chunks, invalid time ranges, duplicate indices, global transcript timestamps, unique segment IDs, merge envelopes, and strict provider-neutral fields.
- [ ] Run `npm test -- src/lib/domain/chunks/chunks.test.ts` and confirm the missing module failure.

### Task 2: Domain schemas

**Files:**
- Create: `src/lib/domain/chunks/chunk-status.ts`
- Create: `src/lib/domain/chunks/audio-chunk.ts`
- Create: `src/lib/domain/chunks/transcript-chunk.ts`
- Create: `src/lib/domain/chunks/analysis-chunk.ts`
- Create: `src/lib/domain/chunks/index.ts`

**Interfaces:**
- Produces: `ChunkProcessingStatus`, `ChunkProcessingError`, `AudioChunk`, `TranscriptChunk`, `AnalysisChunk`, their Zod schemas, chunk set schemas, and transcript merge input/result schemas.

- [ ] Implement shared lifecycle fields with failed-state error validation.
- [ ] Implement strict `AudioChunk` validation, deterministic `buildAudioChunkId()`, and unique set validation.
- [ ] Implement `TranscriptChunk` validation with global timestamps, upload ownership, speaker scope/mapping, and unique set validation.
- [ ] Implement provider-neutral `AnalysisChunk` envelope.
- [ ] Export the public contract from `index.ts`.
- [ ] Run the focused Vitest file and confirm all tests pass.

### Task 3: Architecture documentation

**Files:**
- Create: `docs/architecture/unified-chunk-model.md`

**Interfaces:**
- Documents: current chunk implementations, invariants, architecture, and incremental migration order.

- [ ] Document OpenRouter, Daily Brief, and Semantic Timeline chunk behavior with exact source paths.
- [ ] Document global timestamp, stable ID, speaker reconciliation, metadata, checkpoint, and merge rules.
- [ ] Document the no-big-bang migration path for ASR, downstream analysis, and future workers.

### Task 4: Verification

**Files:**
- Verify only; no additional production edits.

- [ ] Run `npm test -- src/lib/domain/chunks/chunks.test.ts`.
- [ ] Run `npm run lint`.
- [ ] Run `git diff --check` and inspect `git status --short` to confirm scope.
