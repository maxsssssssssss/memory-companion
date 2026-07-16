# Memory Fixture Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a development/test-only, network-blocked multi-day fixture replay command that drives the production downstream pipeline and evaluates Memory/Agent behavior without audio upload or remote providers.

**Architecture:** Add a narrowly scoped dependency injection seam to `processUpload` while preserving all production defaults. A fixture replay module will parse the existing manifest and transcripts into stable transcript segments, inject deterministic providers for remote stages, then reuse production normalization, storage, Memory Index, relevance gate, proactive validation, and scope helpers. A separate evaluator will inspect persisted JSON/SQLite data and emit a reproducible report with a stable digest.

**Tech Stack:** TypeScript, tsx, Vitest, Zod, JsonStore, better-sqlite3.

## Global Constraints

- Never call ASR, Tokenhub, DeepSeek, OpenAI, TTS, tunnel, deployment, or public APIs.
- Reject production execution and keep production upload/date behavior unchanged.
- Do not alter Memory algorithms, Relationship Signal schema, or relevance gate algorithms.
- Preserve real source IDs, evidence normalization, Zod validation, Memory writer, deduplication, and relation detection.

---

### Task 1: Development-only pipeline injection

**Files:**
- Modify: `src/lib/server/pipeline/process-upload.ts`
- Test: `src/lib/server/pipeline/process-upload.test.ts`

- [ ] Add typed optional dependencies for transcription, audio insight, acoustic enrichment, emotion signal, extraction, relationship signal, relevance judge, proactive provider, and deterministic clock.
- [ ] Reject custom dependencies when `NODE_ENV=production`.
- [ ] Keep no-dependency production behavior byte-for-byte equivalent at each provider call site.
- [ ] Test production rejection and injected transcript/provider execution.

### Task 2: Fixture transcript and provider layer

**Files:**
- Create: `src/lib/server/fixture-replay/types.ts`
- Create: `src/lib/server/fixture-replay/dataset.ts`
- Create: `src/lib/server/fixture-replay/providers.ts`
- Test: `src/lib/server/fixture-replay/dataset.test.ts`
- Test: `src/lib/server/fixture-replay/providers.test.ts`

- [ ] Validate manifest/expected-results with Zod and constrain all paths to the dataset root.
- [ ] Parse `A: text`/`B: text` into stable transcript IDs and deterministic non-overlapping time ranges.
- [ ] Implement deterministic extraction and relationship providers grounded only in real segments.
- [ ] Route relationship candidates through existing response normalization and final card validation.
- [ ] Implement deterministic relevance judge and proactive provider using existing gate/validator interfaces.

### Task 3: Replay orchestration and evaluation

**Files:**
- Create: `src/lib/server/fixture-replay/reset.ts`
- Create: `src/lib/server/fixture-replay/evaluation.ts`
- Create: `src/lib/server/fixture-replay/replay.ts`
- Test: `src/lib/server/fixture-replay/replay.test.ts`
- Test: `src/lib/server/fixture-replay/evaluation.test.ts`

- [ ] Add scoped user reset with pre-delete counts and fixture artifact cleanup.
- [ ] Replay selected sessions in manifest date order through `processUpload` with explicit local dependencies.
- [ ] Block `fetch` during replay and fail the report on any network attempt.
- [ ] Evaluate memory/evidence/relations, current/week/all scopes, proactive output, must/should/mustNot, and orphan evidence.
- [ ] Write a JSON report with deterministic digest excluding execution timestamps and elapsed timings.

### Task 4: CLI and documentation

**Files:**
- Create: `scripts/replay-memory-fixtures.ts`
- Modify: `package.json`
- Modify: `test-data/memory-multiday-v1/README.md`

- [ ] Parse `--dataset`, `--user`, `--from-day`, `--to-day`, `--reset-user`, `--report`, and `--fail-fast`.
- [ ] Add `npm run memory:replay-fixtures` and usage examples.
- [ ] Document no-network guarantees, scoped reset behavior, report path, and deterministic digest.

### Task 5: Verification

- [ ] Run focused fixture/pipeline tests.
- [ ] Run `npm run lint`.
- [ ] Run full fixture replay twice with scoped reset.
- [ ] Compare deterministic digests and explain intentionally dynamic fields.
- [ ] Inspect report, SQLite counts, orphan evidence, network attempts, and `git status`.
