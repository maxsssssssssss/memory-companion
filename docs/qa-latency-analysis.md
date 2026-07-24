# QA Latency Analysis

## Scope

This document covers the server-side QA portion of Browser Voice QA:

```text
ASR final
  -> trusted context / Memory retrieval
  -> Relationship evidence construction
  -> deterministic evidence ranking
  -> prompt construction
  -> one QA Provider request
  -> citation and safety validation
  -> deterministic voice response optimization
  -> TTS
```

It does not change long-recording ASR, Memory admission, Relationship extraction, lifecycle resolution, citations, or TTS.

## Observed baseline

The retained real trace `f98c70f5-0f0e-404e-9a35-89f8f824fb33` recorded:

| Stage | Real elapsed |
| --- | ---: |
| Volcengine ASR | 473 ms |
| QA aggregate | 42,126 ms |
| Volcengine TTS | 3,293 ms |

The matching QA log reported a successful, non-fallback `gpt-5.5` request in 42,101 ms. The current QA implementation performs one logical SDK generation call; it does not run a reranking LLM or a second Relationship LLM.

This request used `scope=current` with retained browser context. It did not query the SQLite long-term Memory Index. `memories_used=0` in that trace therefore means that no long-term Memory prompt was attached; the request still used the retained transcript, Brief, Audio Insight, and Relationship evidence.

## Offline breakdown

Using the retained 45-minute artifacts and the same broad question class (`总结一下今天的事情`), local deterministic measurements were:

| Measurement | Result |
| --- | ---: |
| Transcript segments considered | 232 |
| Audio Insights considered | 68 |
| Semantic segments considered | 6 |
| Brief items considered | 30 |
| Relationship Cards considered | 23 |
| Ranked evidence sent | 16 |
| Evidence prompt | 9,776 characters |
| Approximate Agent prompt | 11,344 characters |
| Relationship context construction | about 0.018 ms |
| Evidence construction, deduplication, and ranking | about 6.4 ms |

These are offline CPU measurements, not Tokenhub/Provider latency measurements. They show that the 42-second critical path is the non-streaming Provider generation wait, not local Relationship context building or deterministic ranking.

The OpenAI-compatible client is configured globally with bounded SDK retries. A single logical SDK call may therefore contain transport retries; the current SDK wrapper does not expose per-attempt timing. The retained successful trace does not prove that a transport retry occurred.

## Added latency breakdown

Each QA execution can now report these content-free fields:

- `memoryRetrievalMs`: trusted store/context and Memory Index loading; `null` when a caller already supplied retained context.
- `relationshipContextBuildingMs`: Relationship Card evidence construction.
- `rerankingMs`: evidence conversion, deterministic deduplication, scoring, sorting, and limiting.
- `promptConstructionMs`: Memory prompt, response intent/style, and final system/user prompt construction. Provider settings/model resolution is excluded and currently appears only in the unallocated gap inside total QA time.
- `llmGenerationMs`: the complete non-streaming Provider call.
- `responseValidationMs`: JSON/citation/scope/safety validation and deterministic answer normalization.
- `responseOptimizationMs`: the Voice response projection after the evidence-bearing answer is complete.
- `endToEndQaMs`: Voice bridge QA start through response optimization.

Missing or inapplicable timings are stored as `null`; they are not reported as zero. The nested breakdown is stored with the existing Voice Session trace record. The structured comparison log is:

```text
VOICE_QA_BENCHMARK: {
  session_id,
  answer_mode,
  retrieval_ms,
  reasoning_ms,
  generation_ms,
  total_latency_ms,
  response_length
}
```

Additional stage durations, counts, and character counts are included. Questions, transcripts, raw Memory text, evidence text, credentials, and Provider responses are not logged. In this log, `reasoning_ms` means local prompt construction plus deterministic response validation; it is not hidden model reasoning time.

## Safe optimization changes

1. The production `agent` mode retains its existing prompt, retrieval ranking, citation validation, owner rules, Relationship boundaries, and deterministic fallback.
2. Week/all QA previously ran `retrieveQaEvidence()` once for the shadow comparison and again for the real answer. The shadow observer now consumes the exact ranked evidence emitted by the real QA execution. This reduces that deterministic work from two passes to one without changing ordering or evidence.
3. The experimental `direct` mode uses the same already-retrieved context and the same post-generation safety pipeline, but uses a smaller system instruction packet.

No model, timeout, concurrency, Evidence limit, Memory ownership rule, or SDK retry setting was changed. In particular, evidence was not removed merely to improve latency.

## Before / after

| Metric | Before | After |
| --- | ---: | ---: |
| Production Agent logical LLM calls | 1 | 1 |
| Week/all deterministic evidence passes | 2 | 1 |
| Agent system prompt, local measurement | 1,726 chars | 1,726 chars |
| Experimental Direct system prompt | n/a | 605 chars |
| Experimental system-prompt reduction | n/a | 64.95% |
| Approximate retained Agent total prompt | 11,363 chars | unchanged |
| Approximate retained Direct total prompt | n/a | about 10,242 chars |
| Real Provider generation | 42,101 ms | not rerun |

The system-prompt measurement uses the fixed instruction `Keep the answer concise.`. The Direct total-prompt estimate holds the previously measured 9,637-character user/evidence packet constant and substitutes only the current system prompt (an estimated 9.87% total reduction). It is not a real Provider benchmark. No remote QA call was made during this change, so a real before/after latency improvement must not yet be claimed.

## Debugging workflow

1. Locate the terminal `VOICE_TRACE` line by its per-request `session_id`.
2. Locate the `VOICE_QA_BENCHMARK` line with the same per-request `session_id`. A reusable conversation/session identifier is deliberately not used as the benchmark correlation key.
3. If `generation_ms` dominates, compare answer mode, model, prompt characters, response characters, fallback reason, and logical model-call count.
4. If `memory_retrieval_ms` dominates only for week/all, inspect store and SQLite retrieval separately; current retained-context requests legitimately report it as `null`.
5. If `reranking_ms` rises, compare input counts and evidence count without logging their content.
6. If `response_validation_ms` rises or fallback is non-`none`, inspect the existing safe QA fallback logs and citation/scope validators.
7. Run controlled Agent/Direct comparisons with the same user, scope, question, retained context, Provider, and model. Restart the web process after changing the server-side feature flag.

## Remaining limitations

- The Provider response is non-streaming, so first-token latency is not available.
- SDK-internal HTTP retry attempts are not individually exposed.
- Provider settings/model resolution is not yet a separately reported stage; it is the small unallocated difference between detailed stages and total QA time.
- The production trace that motivated this work predates the detailed breakdown.
- Direct mode is an experiment, not a production replacement, and requires a controlled real benchmark before adoption.
