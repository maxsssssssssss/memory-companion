# Transcript Merge Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn completed `TranscriptChunk[]` into one validated, chronological, traceable global transcript without changing `TranscriptSegment`.

**Architecture:** Keep chunk-local to upload-global conversion at the ASR adapter boundary. Centralize validation, stable IDs, boundary deduplication, source tracing, statistics, warnings, and the future speaker reconciliation hook in one server merge service. The existing pipeline consumes only `result.segments`.

**Tech Stack:** TypeScript, Zod, Vitest, existing Unified Chunk Model.

## Global Constraints

- Do not modify Memory, QA, Relationship Signal, ASR providers, workers, or queues.
- Do not change the `TranscriptSegment` schema.
- Do not call remote ASR or deploy.

---

### Task 1: Specify the merge contract

**Files:**
- Modify: `src/lib/server/transcription/chunks/transcript-merge.test.ts`

**Interfaces:**
- Produces: expectations for `mergeTranscriptChunks(chunks): TranscriptMergeResult`.

- [ ] Add failing tests for global offsets, stable IDs, ordering, source tracing, boundary deduplication, speaker preservation, and invalid ranges.
- [ ] Run the focused test and confirm the new result-shape assertions fail.

### Task 2: Implement the merge service

**Files:**
- Modify: `src/lib/server/transcription/chunks/transcript-merge.ts`

**Interfaces:**
- Produces: `TranscriptMergeResult`, `TranscriptSegmentSource`, `TranscriptMergeStats`, and `mergeTranscriptChunks()`.

- [ ] Preserve original provider segment IDs in chunk metadata during local-to-global conversion.
- [ ] Parse completed chunks through the existing Zod merge input schema.
- [ ] Sort chunks and segments deterministically.
- [ ] Remove only cross-chunk duplicates with overlapping time, matching speaker, and high normalized-text similarity.
- [ ] Return segments, source map, stats, and warnings.
- [ ] Run focused tests until green.

### Task 3: Preserve the downstream contract

**Files:**
- Modify: `src/lib/server/transcription/chunks/process-audio.ts`
- Modify: `docs/architecture/long-recording-asr-chunks.md`

**Interfaces:**
- Consumes: `TranscriptMergeResult`.
- Produces: the existing `TranscriptSegment[]` transcription processor output.

- [ ] Pass only `mergeResult.segments` to the downstream pipeline.
- [ ] Log merge counts without transcript text or secrets.
- [ ] Document deduplication, source tracing, and speaker limitations.

### Task 4: Verify

**Files:**
- Test: transcription chunk/provider/pipeline regression suites.

- [ ] Run focused merge tests.
- [ ] Run transcription and upload pipeline regression tests.
- [ ] Run `npm run lint`.
- [ ] Run `git diff --check` and inspect the scoped diff.
