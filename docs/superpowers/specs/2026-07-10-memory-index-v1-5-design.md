# Memory Index v1.5 Design

## Goal

Extend the existing SQLite memory index with explainable importance scoring, deterministic cross-upload deduplication, and evidence-backed memory relations without changing QA retrieval or adding model calls.

## Data Model

`memory_items` keeps the v1 `importance` column for backward compatibility and adds:

- `importance_score`: authoritative v1.5 score in `[0, 1]`; mirrored to `importance`.
- `importance_reason`: JSON array of deterministic reason strings.
- `status`: `active`, `resolved`, `expired`, or `superseded`.
- `occurrence_count`: number of distinct uploads represented by the memory evidence.
- `first_seen_date` / `last_seen_date`: minimum and maximum evidence dates.
- `access_count` / `last_accessed_at`: reserved access metadata; reads remain side-effect free in v1.5.

`memory_relations` stores deterministic directed edges with a unique `(source_memory_id, target_memory_id, relation_type)` key. Evidence dates remain the source of truth for occurrence history, so no duplicated JSON dates column is added.

## Importance

`calculateImportance` starts from a type weight and adds bounded bonuses for explicit dates, people, future actions, unresolved state, multiple occurrences, multiple dates, and diverse evidence. It returns a rounded score and stable, explainable reason list. Recalculation is deterministic and idempotent.

## Deduplication

Candidates can merge only when they belong to the same user and memory type. Similarity uses normalized title/summary text, CJK bigrams and word tokens, keyword overlap, and date proximity. Exact or high-overlap records inside conservative time windows merge; unrelated records remain separate.

The existing canonical ID remains stable. The representative title and summary come from the higher-scoring candidate, with earlier creation time as the tie-breaker. Evidence is unioned by evidence ID, occurrences are recomputed from distinct upload IDs, and first/last seen dates are recomputed from evidence. Reprocessing an upload first removes only that upload's evidence and deletes only orphaned memories.

## Relations

Relations are rebuilt deterministically per user after indexing or upgrade:

- `resolved_by`: active question/commitment followed by an overlapping completion event.
- `follow_up`: later overlapping event/question/commitment follows an earlier question/commitment.
- `contradicted_by`: later overlapping evidence contains explicit cancellation or contradiction cues.
- `repeated`: related same-type memories recur on different dates but were not safe enough to merge.
- `related`: conservative lexical overlap without a stronger relation.

Only `resolved_by` changes the source memory status to `resolved`. No automatic `expired` or `superseded` inference is attempted in v1.5.

## Pipeline And Upgrade

The upload pipeline continues to extract memories after relationship signals. Repository indexing then scores, deduplicates, and rebuilds relations in SQLite. Any failure remains non-blocking and the upload still becomes `ready`.

`npm run memory:upgrade` migrates the schema, recalculates all existing items, consolidates duplicates, and rebuilds relations. It runs in transactions and is idempotent.

## Boundaries

No embeddings, vector database, LLM calls, QA migration, DeepSeek changes, JSON retrieval replacement, long-term trend generation, or cross-day speaker identity are included.
