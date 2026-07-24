# QA Provider Model Benchmark

## Purpose

This benchmark compares GPT-5.5 and DS v4 on the same retained
`long-recording-60m-v1` QA inputs. It fixes all application-owned variables:

- the question;
- the immutable retained Voice QA context;
- Evidence construction and ranking;
- the Agent QA system/user prompt;
- lifecycle-aware retrieval;
- citation mapping and validation;
- grounded unsupported handling.

The only intended answer-generation variable is the configured model runtime.
The production `OPENAI_QA_MODEL` value and saved user settings are never
rewritten.

## Dataset

The focused fixture is
`benchmark/qa-provider-model/long-recording-60m.json`:

| ID | Purpose |
| --- | --- |
| q017 | plan/unknown state to completed reservation |
| q018 | unresolved invitation question to final two-person decision |
| q022 | commitment without completion evidence |
| q034 | aggregate commitment completion |
| q040 | ordinary same-day summary |

The lifecycle and unsupported checks are deterministic, dataset-specific
rubrics. They do not invoke a judge model.

## Execution

Plan the schedule without remote calls:

```powershell
npm run qa-provider:model-benchmark -- `
  --user-id <evaluation-user-id> `
  --upload-id <retained-upload-id> `
  --rounds 3
```

Run the real benchmark explicitly:

```powershell
$env:RUN_QA_PROVIDER_MODEL_REMOTE_VERIFY = "1"
npm run qa-provider:model-benchmark -- `
  --remote `
  --user-id <evaluation-user-id> `
  --upload-id <retained-upload-id> `
  --rounds 3 `
  --output-dir .data/evaluation/qa-provider-model-benchmark-v1/<run-id>
```

The runner is serialized and seeded/counterbalanced. Each model call executes
in a short-lived child process, so the DS credentials/model mapping cannot
leak into a running Next.js process or alter `.env.local`. The parent writes:

- `report.json`;
- `report.md`;
- `progress.jsonl`;
- `partial.json` while the run is active.

`progress.jsonl` contains identifiers, timings, validation outcomes, and
fallback status, but not questions, answers, Evidence text, API keys, or
tokens.

## Metrics

- `ttft_ms`: Provider request start to first streamed token.
- `generation_latency_ms`: full Provider stream duration.
- `total_latency_ms`: QA invocation including retrieval, prompt construction,
  generation, and final validation.
- Evidence digest and prompt character count for pair integrity.
- Final citation allowlist and inline citation-metadata alignment.
- q017/q018/q034 lifecycle correctness.
- q022 grounded unsupported handling.
- `providerPath`: native answer, grounded unsupported, or validation fallback.

## Controlled run: 2026-07-23

The retained 60-minute fixture was executed for three rounds: 5 questions × 2
models × 3 rounds = 30 real calls. All 15 pairs used the same Evidence digest
and prompt size.

| Model | Completed | Mean TTFT | Median TTFT | P95 TTFT | Mean generation | Median generation | P95 generation | Mean total | Median total | P95 total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GPT-5.5 | 15/15 | 5,447 ms | 5,060 ms | 7,854 ms | 8,361 ms | 8,193 ms | 11,634 ms | 8,421 ms | 8,220 ms | 11,691 ms |
| DS v4 | 15/15 | 6,384 ms | 5,089 ms | 21,092 ms | 7,469 ms | 5,780 ms | 22,244 ms | 7,530 ms | 5,830 ms | 22,299 ms |

Quality results:

| Check | GPT-5.5 | DS v4 |
| --- | ---: | ---: |
| Final citation validity | 15/15 | 15/15 |
| q017 lifecycle | 3/3 | 3/3 |
| q018 lifecycle | 3/3 | 3/3 |
| q022 unsupported | 3/3 | 3/3 |
| q034 aggregate completion | 3/3 | 1/3 |
| Provider/native answers | 15/15 | 15/15 |
| Fallbacks | 0 | 0 |

DS v4 had lower median generation and total latency, but a much worse P95
caused by a 22.3-second q034 outlier. Its two q034 failures equated a confirmed
future rehearsal arrangement with fulfillment. GPT-5.5 preserved the
completed-versus-still-promised boundary in all three q034 runs.

No winner is declared from this small synthetic set. The result supports a
trade-off: DS v4 is usually faster on this run, while GPT-5.5 is more stable on
aggregate lifecycle reasoning and has a substantially tighter latency tail.

## Limitations

- GPT-5.5 used the configured OpenAI-compatible Responses path; DS v4 used the
  configured DeepSeek Chat Completions path. The observed difference therefore
  includes endpoint and wire behavior, not only model weights.
- Three rounds reduce order bias but are not a load test.
- The current-scope fixture does not measure week/all long-term Memory
  retrieval.
- Deterministic rubrics cover known lifecycle and unsupported boundaries;
  broader companion quality still needs human review.
