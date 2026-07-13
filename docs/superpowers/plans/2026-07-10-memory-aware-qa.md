# Memory-aware QA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SQLite Memory Index as a non-citeable navigation layer that improves week/all QA evidence ranking without replacing JSON retrieval.

**Architecture:** A synchronous server adapter retrieves bounded memories and their original source IDs. Existing JSON evidence is boosted by matching source IDs; a compact memory block references only selected `E` evidence, so current citation validation remains authoritative.

**Tech Stack:** TypeScript, better-sqlite3, Zod domain types, Vitest, Next.js route handlers, existing Tokenhub OpenAI-compatible QA.

## Global Constraints

- Do not replace JSON retrieval or transcript citations.
- Do not add embeddings, vector databases, or LLM calls.
- Do not modify Memory Extraction, importance scoring, DeepSeek, or Relationship Signal Cards.
- Memory retrieval failure must not affect QA availability.
- Current scope must not load historical memory.
- Long-term claims require original evidence from at least two distinct dates.

---

### Task 1: Memory Retrieval Adapter

**Files:**
- Create: `src/lib/server/retrieval/memory-index-evidence.ts`
- Test: `src/lib/server/retrieval/memory-index-evidence.test.ts`

**Interfaces:**
- Produces: `retrieveMemoryIndexEvidence({ userId, scope, query, dateRange, repository? }): MemoryIndexQaContext`.

- [ ] Add failing tests for current isolation, type filtering, importance threshold, active/resolved ordering, date range, evidence traceability, and bounded generic results.
- [ ] Run the focused test and confirm the adapter is missing.
- [ ] Implement deterministic intent filtering and memory ranking over the existing repository.
- [ ] Re-run and confirm all adapter tests pass.

### Task 2: QA Ranking, Prompt, Citation Boundary

**Files:**
- Modify: `src/lib/server/retrieval/ai-qa.ts`
- Test: `src/lib/server/retrieval/ai-qa.test.ts`

**Interfaces:**
- Consumes: optional `memoryContext` and `memoryIndexFallback` on `AnswerQuestionWithAIInput`.
- Produces: memory-source boosting, a non-citeable prompt block, scope safety, and `[memory-qa]` logs.

- [ ] Add failing tests proving mapped original evidence is promoted, memory appears only with `E` references, citations still resolve to transcript segments, and one-date all-memory claims fall back.
- [ ] Run focused tests and confirm red.
- [ ] Add source-ID ranking boosts and compact memory prompt construction without extending `QaRetrievedEvidence.kind`.
- [ ] Add system-prompt rules and general all/week long-term claim validation.
- [ ] Re-run and confirm green.

### Task 3: Week/All Orchestration And Failure Isolation

**Files:**
- Modify: `src/lib/server/retrieval/memory-scope-qa.ts`
- Modify: `src/app/api/days/context/qa/route.ts`
- Test: `src/lib/server/retrieval/memory-scope-qa.test.ts`
- Test: `src/app/api/routes.test.ts`

**Interfaces:**
- Consumes: authenticated `userId`, scope, question, and week date range.
- Produces: optional `memoryContext`; catches all adapter failures before QA.

- [ ] Add failing tests that week/all pass memory context and adapter failure still returns the unchanged QA answer.
- [ ] Run focused tests and confirm red.
- [ ] Wire the adapter into direct week/all QA and browser-provided context QA; leave current routes unchanged.
- [ ] Preserve existing shadow comparison logging and re-run tests.

### Task 4: Demo And Regression Verification

**Files:**
- Modify only if verification exposes an in-scope defect.

**Interfaces:**
- Validates: current/week/all behavior, original citations, adapter logs, and local demo account behavior.

- [ ] Run focused retrieval, memory, route, and QA tests.
- [ ] Run the three requested demo questions against the local account and record memory/citation outcomes without exposing credentials or keys.
- [ ] Run `npm run lint`.
- [ ] Run `npm run build`.
- [ ] Confirm `http://localhost:3200` returns HTTP 200 and report unrelated pre-existing full-suite failures separately.
