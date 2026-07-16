# Proactive QA Observation And Question Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate AI observations from editable suggested questions without changing Memory, Relationship Signal, QA retrieval, or remote model behavior.

**Architecture:** Keep the server-side `ProactiveInsight` as the Agent output contract, then add a client presentation layer that validates and maps each insight into independent `ProactiveObservation` and `SuggestedQuestion` records. `QaPanel` renders observations as evidence-backed read-only cards and questions as input-fill actions.

**Tech Stack:** Next.js, React, TypeScript, Zod, Vitest, Testing Library.

## Global Constraints

- Do not modify Memory Index, Relationship Signal schema, QA Agent, or QA retrieval.
- Do not add LLM calls.
- Observation cards never submit QA.
- Suggested-question clicks only fill and focus the composer.
- Preserve current/week/all scope behavior and evidence traceability.

---

### Task 1: Client Presentation Model

**Files:**
- Create: `src/lib/client/proactive-qa-presentation.ts`
- Modify: `src/lib/client/proactive-insight-suggestions.ts`
- Modify: `src/lib/client/proactive-qa-suggestions.ts`
- Test: `src/lib/client/proactive-insight-suggestions.test.ts`

- [x] Define strict `ProactiveObservation` and `SuggestedQuestion` schemas.
- [x] Reject question-shaped observations and unsafe suggested questions.
- [x] Normalize Agent second-person questions into user-sendable first-person wording.
- [x] Build independent observation and question arrays with stable limits and de-duplication.
- [x] Verify invalid observations fail and user-voice questions pass.

### Task 2: QA Panel Interaction

**Files:**
- Modify: `src/components/qa-panel.tsx`
- Modify: `src/components/qa-panel.test.tsx`

- [x] Replace the combined suggestions prop with independent observations and questions.
- [x] Render observation cards with expandable evidence and no submit action.
- [x] Render suggested questions in a dedicated section.
- [x] Fill and focus the textarea on question click without calling the QA API.
- [x] Verify history, loading, and normal manual submit behavior remain intact.

### Task 3: Page Wiring And Styles

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/app/page.test.tsx`
- Modify: `src/app/globals.css`

- [x] Build current presentation from Agent insights plus rule suggestions.
- [x] Build week/all presentation from scope-aware rule suggestions.
- [x] Pass split arrays to every `QaPanel` instance.
- [x] Add restrained observation/evidence styles and responsive layout.
- [x] Verify the page requires an explicit send after selecting a question.

### Task 4: Verification

**Files:**
- Verify only.

- [x] Run focused client and component tests.
- [x] Run page tests covering proactive QA.
- [x] Run `npm run lint`.
- [x] Inspect `git diff` and confirm no protected subsystem changed.
