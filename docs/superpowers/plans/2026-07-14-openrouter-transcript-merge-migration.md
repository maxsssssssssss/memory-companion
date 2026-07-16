# OpenRouter Transcript Merge Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route OpenRouter transcription chunks through the Unified Chunk Model and Transcript Merge Service while preserving transcript text and timestamps.

**Architecture:** Reuse the shared `AudioChunk` planner for known-duration files. Convert each OpenRouter response into a chunk-local segment list and then a `TranscriptChunk`; merge all chunks through `mergeTranscriptChunks()`. Preserve a one-chunk fallback when ffprobe cannot determine duration, but still construct a `TranscriptChunk` and invoke the same merge service.

**Tech Stack:** TypeScript, Zod domain chunks, ffmpeg/ffprobe wrappers, Vitest.

## Global Constraints

- Do not change `TranscriptSegment`, Memory, QA, or Relationship Signal schemas or logic.
- Do not call remote APIs or deploy.
- Preserve OpenRouter request routing and response parsing.

---

### Task 1: Lock the OpenRouter merge contract

**Files:**
- Modify: `src/lib/server/transcription/openai-provider.test.ts`

- [ ] Update long-audio expectations to unified stable segment IDs.
- [ ] Assert unchanged global timestamps and text.
- [ ] Assert merge statistics and segment source tracking.
- [ ] Run the focused test and confirm it fails before implementation.

### Task 2: Migrate OpenRouter to unified chunks

**Files:**
- Modify: `src/lib/server/transcription/openai-provider.ts`

- [ ] Remove provider-local ffmpeg chunk creation and offset/index options.
- [ ] Reuse `planAudioChunks()` and `cleanupGeneratedAudioChunks()`.
- [ ] Convert each OpenRouter response into a `TranscriptChunk` with `createTranscriptChunkFromLocalSegments()`.
- [ ] Return `mergeTranscriptChunks()` results and log safe merge statistics.
- [ ] Keep the provider's public return type as `TranscriptSegment[]`.

### Task 3: Verify behavior and regressions

**Files:**
- Test: `src/lib/server/transcription/openai-provider.test.ts`
- Test: transcription/chunk/pipeline suites.

- [ ] Run focused OpenRouter tests.
- [ ] Run transcription and upload-pipeline regression tests.
- [ ] Run `npm test` and report any unrelated residual failures exactly.
- [ ] Run `npm run lint` and `git diff --check`.
