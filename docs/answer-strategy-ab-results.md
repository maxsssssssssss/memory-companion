# Agent QA vs Direct Context A/B Results

## Test scope

- Dataset: `long-recording-60m-v1`
- Questions: 34
- Rounds: 3
- Total executions: 204
- Execution: real remote QA Provider, serialized
- Scope: current
- Context: 307 transcript segments, 93 Audio Insights, 8 semantic segments, 30 Brief items, 23 Relationship Cards
- Pair integrity: 102/102 pairs have matching evidence digests

The schedule uses a seeded, counterbalanced order. Each question runs in both orders across three rounds. Agent and Direct share the same immutable retained context, deterministic evidence retrieval, model configuration, citation validation, Relationship boundaries, and response optimizer. The answer strategy is the intended variable.

Current-scope provided-context QA does not query the SQLite long-term Memory index, so both modes share the same empty current-memory context. This result must not be generalized to week/all Memory retrieval.

## Overall performance

| Mode | Completed | Mean total ms | Median total ms | P95 total ms | Mean generation ms | Fallbacks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| agent | 102/102 | 9,412 | 8,219 | 15,720 | 9,399 | 0 |
| direct | 102/102 | 12,327 | 8,332 | 16,702 | 12,315 | 2 |

## Category breakdown

| Category | Mode | Completed | Mean total ms | Mean generation ms | Mean citations |
| --- | --- | ---: | ---: | ---: | ---: |
| fact | agent | 15/15 | 8,066 | 8,054 | 2 |
| fact | direct | 15/15 | 6,585 | 6,573 | 2 |
| relationship | agent | 24/24 | 10,466 | 10,455 | 2 |
| relationship | direct | 24/24 | 11,159 | 11,148 | 2 |
| lifecycle | agent | 24/24 | 9,392 | 9,379 | 2 |
| lifecycle | direct | 24/24 | 22,071 | 22,058 | 2 |
| preference | agent | 15/15 | 10,760 | 10,744 | 2 |
| preference | direct | 15/15 | 10,933 | 10,920 | 2 |
| ambiguous | agent | 12/12 | 8,227 | 8,217 | 2 |
| ambiguous | direct | 12/12 | 8,263 | 8,252 | 2 |
| companion | agent | 12/12 | 8,528 | 8,513 | 2 |
| companion | direct | 12/12 | 8,159 | 8,144 | 2 |

## Grounding and failures

- Evidence digest mismatches: 0
- Missing evidence digests: 0
- Failed executions: 0
- Fallback responses: 2
- Citation validation violations: 0
- Manual quality scores completed: 0/204

No strategy winner is declared automatically. Factual correctness, evidence grounding, relationship understanding, and companion quality remain manual 0–5 fields in the JSON report.

## Latency distribution note

The slowest retained call was `r02-q017-direct` (direct, lifecycle) at 321,617 ms. Means include every real call, including Provider queueing and retry long tails; inspect median, P95, and individual runs before interpreting a mean difference.

## Manual spot-check findings

- Direct returned `unsupported_answer` for `q022` in rounds 1 and 3; the same Direct question succeeded in round 2, while Agent succeeded in all three rounds.
- Both strategies missed the later recorded resolution for `q017` and `q018` in all three rounds. Because the paired context and evidence digests match, this is a shared retrieval/context coverage issue rather than evidence that either answer prompt is better.
- The four formal quality score fields remain unfilled. These spot checks identify review targets but do not replace blind scoring and do not establish a winner.

## Live progress monitoring

The runner writes an append-only `*.progress.jsonl` event log and atomically replaces a `*.partial.json` snapshot after every completed provider call. These files make completed work observable even when the terminal buffers stdout.

Use a one-shot status check:

```powershell
npm run answer-strategy:benchmark:status
```

Or keep a local terminal watching the partial report:

```powershell
npm run answer-strategy:benchmark:status -- --watch
```

The status includes completed and total runs, per-mode counts, failures, fallbacks, mean latency, ETA, and seconds since the last completed call. A growing `stale_for_seconds` value identifies a slow or stalled provider request without exposing questions, answers, evidence text, or credentials.

## Follow-up

1. Review all answer pairs blind to mode and fill the four manual score fields.
2. Inspect failures and fallback cases before comparing aggregate latency.
3. Repeat on week/all scopes with a separately frozen non-empty Memory context before drawing conclusions about long-term Memory QA.
4. Treat Provider latency as environment-specific; keep the serialized randomized schedule for future comparisons.
