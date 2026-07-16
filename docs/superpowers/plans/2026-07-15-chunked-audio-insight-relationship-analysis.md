# Chunked Audio Insight and Relationship Analysis

## Current flow

- Audio Insight providers receive the complete `TranscriptSegment[]` and return final `AudioInsight[]`.
- Relationship Signal receives the complete transcript, semantic timeline, and audio insights, then normalizes model output into final cards.
- ASR checkpoints already persist `TranscriptChunk[]`, but `processUpload` currently discards that shape after transcript merge.
- `AnalysisChunk` exists as a domain contract but is not used by runtime orchestration.

## Implementation boundaries

1. Resolve analysis transcript chunks from ASR checkpoints, projecting them onto the final merged transcript. If checkpoints are unavailable, deterministically partition the merged transcript into valid `TranscriptChunk` records.
2. Extract the existing bounded worker-pool pattern into a shared server utility and retain ASR scheduler behavior.
3. Process Audio Insight per transcript chunk with bounded concurrency, per-attempt timeout/retry, chunk-local rule fallback, evidence validation, deterministic merge, and stable final IDs.
4. Add an internal Relationship Signal candidate schema. OpenAI extracts raw candidates per chunk; legacy/custom providers are adapted through their existing final-card output.
5. Reduce candidates deterministically against the full transcript, semantic timeline, and merged audio insights, then use the existing normalization and Zod validation to create unchanged `RelationshipSignalCard[]`.
6. Integrate both orchestrators into `processUpload`; preserve all downstream inputs and add aggregate performance logs.

## Compatibility and safety

- Do not change `TranscriptSegment`, `AudioInsight`, `RelationshipSignalCard`, Memory, QA, or frontend schemas.
- Every accepted output must resolve to a real final transcript segment.
- Relationship candidate text evidence is replaced with real transcript text before final validation.
- Optional chunk failures fall back locally and do not discard successful chunks.
- Tests use mocks and fixtures only; no remote API calls.

## Verification

- Unit tests: transcript chunk resolution, bounded concurrency, Audio Insight merge/failure isolation, candidate evidence validation, multi-chunk reduction, non-relationship empty result.
- Pipeline tests: multiple chunks, unchanged downstream output, logs, and failed chunk isolation.
- Regression: transcription, relationship, memory, QA, pipeline suites, then `npm run lint`.
