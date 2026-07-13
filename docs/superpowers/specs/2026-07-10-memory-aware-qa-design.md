# Memory-aware QA Design

## Goal

Use SQLite Memory Index as a bounded navigation and supporting-context layer for week/all QA while preserving JSON retrieval and original evidence citations as the answer's source of truth.

## Architecture

The new adapter retrieves high-value, query-relevant memories for the authenticated user. Memory items are not added to the citeable `E` evidence array. Instead, their evidence `source_id` values boost matching transcript, brief, timeline, audio-insight, or relationship-signal entries during existing JSON evidence ranking.

After ranking, only memories that map to selected `E` entries appear in a compact `[Long-term memory]` prompt block. Each memory block lists its compressed observation, score/status/occurrence metadata, uncertainty caution, and the original `[E]` IDs that must support any answer. Citation validation remains unchanged and therefore cannot emit a memory-only citation.

## Adapter

`src/lib/server/retrieval/memory-index-evidence.ts` accepts `userId`, `scope`, `query`, and an optional week date range. It returns a bounded context containing normalized memory summaries, original evidence metadata, source IDs, counts, and retrieval latency.

Rules:

- `current` returns no historical context.
- `week` filters evidence to the requested week.
- `all` queries all indexed history.
- Importance score below `0.6`, expired/superseded items, and items without transcript evidence are excluded.
- Active, repeated, multi-date, high-importance memories rank first.
- Query intent restricts memory types; generic queries receive at most three memories, typed queries at most six.
- Resolved memories may appear when relevant but rank below active memories.

## Prompt And Safety

The system prompt states that long-term memories are compressed observations, not ground truth; original evidence must be prioritized; and one occurrence cannot establish a long-term pattern. The user prompt includes only memory items that can point to selected `E` evidence.

For all-scope pattern claims, at least two distinct dates among cited original evidence are required. Otherwise the existing deterministic fallback is used. Relationship safety filters remain unchanged.

## Failure Handling

SQLite retrieval is wrapped at the week/all orchestration boundary. Missing, damaged, or unavailable memory data produces no memory context and never blocks JSON retrieval or QA. A compact `[memory-qa]` log records scope, mapped memories, mapped original evidence, and whether memory retrieval fell back.

## Boundaries

No replacement of JSON retrieval, no memory-only citations, no embeddings, no vector database, no new LLM calls, no Memory Extraction or scoring changes, and no DeepSeek or Relationship Signal changes.
