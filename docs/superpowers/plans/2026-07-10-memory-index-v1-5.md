# Memory Index v1.5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic importance scoring, cross-upload memory deduplication, evidence-backed relations, and an idempotent upgrade command to Memory Index v1.

**Architecture:** Schema v2 extends `memory_items` and adds `memory_relations`. Pure scoring, similarity, merge, and relation functions feed repository transactions; pipeline indexing and the upgrade script share the same deterministic operations.

**Tech Stack:** TypeScript, Zod, better-sqlite3, Vitest, Next.js server runtime.

## Global Constraints

- Do not add embeddings, vector databases, or LLM calls.
- Do not modify QA retrieval, DeepSeek proactive insight, or JSON retrieval behavior.
- Every memory remains traceable to transcript evidence.
- Memory indexing failure must not block upload `ready`.
- All schema migration and upgrade operations must be idempotent.
- The workspace has no Git metadata, so verification replaces commit steps.

---

### Task 1: Schema And Domain Types

**Files:**
- Modify: `src/lib/server/memory/schema.ts`
- Modify: `src/lib/server/memory/types.ts`
- Test: `src/lib/server/memory/db.test.ts`

**Interfaces:**
- Produces: `MemoryStatus`, `MemoryRelationType`, v1.5 `MemoryItem`, `MemoryRelation`, and schema v2.

- [ ] Add failing tests for v2 columns, relation table, constraints, and migration versions.
- [ ] Run `npm test -- src/lib/server/memory/db.test.ts` and confirm failure due to missing v2 schema.
- [ ] Add sequential v1/v2 migrations and extend Zod schemas while retaining legacy `importance`.
- [ ] Re-run the test and confirm it passes.

### Task 2: Explainable Importance Scoring

**Files:**
- Create: `src/lib/server/memory/importance.ts`
- Test: `src/lib/server/memory/importance.test.ts`

**Interfaces:**
- Produces: `calculateImportance(memory): { score: number; reasons: string[] }`.

- [ ] Add failing tests proving commitment scores above an equivalent event, recurrence raises score, and reasons identify contributing factors.
- [ ] Run the focused test and confirm missing implementation failure.
- [ ] Implement bounded deterministic scoring using type, date/person/action/unresolved cues, occurrence dates, and evidence diversity.
- [ ] Re-run and confirm green.

### Task 3: Deterministic Deduplication

**Files:**
- Create: `src/lib/server/memory/deduplication.ts`
- Test: `src/lib/server/memory/deduplication.test.ts`

**Interfaces:**
- Produces: `findSimilarMemories`, `mergeMemories`, `consolidateMemories`, and reusable lexical similarity helpers.

- [ ] Add failing tests for matching same-type memories, rejecting unrelated/different-type memories, preserving evidence, and recomputing occurrence metadata.
- [ ] Run the focused test and confirm red.
- [ ] Implement Unicode normalization, token overlap, date proximity, canonical representative selection, and evidence union.
- [ ] Re-run and confirm green.

### Task 4: Memory Relations

**Files:**
- Create: `src/lib/server/memory/relations.ts`
- Test: `src/lib/server/memory/relations.test.ts`

**Interfaces:**
- Produces: `detectMemoryRelations(memories): MemoryRelationWrite[]` with deterministic IDs.

- [ ] Add failing tests for `related`, `resolved_by`, `follow_up`, `repeated`, and duplicate suppression.
- [ ] Run the focused test and confirm red.
- [ ] Implement conservative chronological relation rules and stable edge IDs.
- [ ] Re-run and confirm green.

### Task 5: Repository v1.5 Transactions And Queries

**Files:**
- Modify: `src/lib/server/memory/repository.ts`
- Modify: `src/lib/server/memory/types.ts`
- Test: `src/lib/server/memory/repository.test.ts`

**Interfaces:**
- Produces: upload indexing with dedup, safe upload evidence deletion, relation replacement, and query helpers `getImportantMemories`, `getActiveCommitments`, `getUnresolvedQuestions`, `getRepeatedMemories`, `getRelatedMemories`.

- [ ] Add failing repository tests for cross-upload merge, idempotent reindex, safe deletion, query helpers, and relation uniqueness.
- [ ] Run focused tests and confirm red.
- [ ] Implement transaction-safe indexing, metadata recalculation, relation rebuild, and query helpers.
- [ ] Re-run and confirm green.

### Task 6: Pipeline Integration

**Files:**
- Modify: `src/lib/server/pipeline/process-upload.ts`
- Test: `src/lib/server/pipeline/process-upload.test.ts`

**Interfaces:**
- Consumes: v1.5 repository `replaceUploadMemories` behavior.
- Produces: non-blocking upload indexing with scoring/dedup/relation logging.

- [ ] Update the pipeline failure test to cover relation/index processing failure while retaining `ready`.
- [ ] Run the focused test and confirm red against the new repository contract.
- [ ] Wire the v1.5 repository operation and safe summary logging without transcript text.
- [ ] Re-run and confirm green.

### Task 7: Idempotent Upgrade Command

**Files:**
- Create: `src/lib/server/memory/upgrade.ts`
- Create: `scripts/upgrade-memory.ts`
- Modify: `src/lib/server/memory/index.ts`
- Modify: `package.json`
- Test: `src/lib/server/memory/upgrade.test.ts`

**Interfaces:**
- Produces: `upgradeMemoryIndex()` and `npm run memory:upgrade`.

- [ ] Add failing tests that upgrade legacy rows, merge duplicates, rebuild relations, preserve evidence, and return the same result on rerun.
- [ ] Run the focused test and confirm red.
- [ ] Implement per-user transactional consolidation and relation rebuilding plus the CLI summary.
- [ ] Re-run and confirm green.

### Task 8: Demo Data Validation And Regression Verification

**Files:**
- Modify only if a test exposes a defect in the files above.

**Interfaces:**
- Validates: real `.data/memory.sqlite` upgrade and all existing Memory Index behavior.

- [ ] Capture pre-upgrade item/evidence/type counts.
- [ ] Run `npm run memory:upgrade` twice and compare summaries for idempotence.
- [ ] Query importance distribution, duplicate reduction, relation counts, status counts, and missing transcript evidence.
- [ ] Run focused memory and pipeline tests.
- [ ] Run `npm run lint`.
- [ ] Run `npm run build`.
- [ ] Review all changed files against the scope and report any unrelated pre-existing test failures separately.
