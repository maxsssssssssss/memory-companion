# Compact Evidence A/B Report

## Scope

- Dataset: `long-recording-60m-v1`
- Questions: q017, q018, q034, q025, q026, q022, q012
- Rounds: 3
- Runs: 42/42
- Model: `gpt-5.5`
- Provider: `openai-compatible`
- Answer strategy: Agent QA
- Pair integrity: 21/21
- Long-term Memory context entries: 0
- Token estimate: `ceil_chars_div_2`

The only intended Provider-input difference is the Evidence block. Retrieval, canonical Evidence, system prompt, question, model, Agent strategy, final validation, citation mapping, and SentenceCommit allowlists remain shared.

## Aggregate performance and quality

| Evidence view | Completed | Mean input chars | Est. input tokens | Mean TTFT ms | Median TTFT ms | P95 TTFT ms | Mean generation ms | Mean total ms | Quality pass | Fallbacks | Streaming success | Safe fallback |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| original | 21/21 | 8,526 | 4,263 | 6,824 | 5,923 | 11,285 | 9,620 | 9,654 | 12/21 | 0 | 9 | 12 |
| compact | 21/21 | 6,158 | 3,079 | 7,030 | 5,770 | 16,552 | 9,646 | 9,679 | 12/21 | 0 | 13 | 8 |

## Relative change

- Input characters reduced: 27.8%
- Estimated input tokens reduced: 27.8%
- Mean TTFT improvement: -3.0%
- Mean generation improvement: -0.3%
- Mean total latency improvement: -0.3%

## Quality and safety comparison

- Quality regression pairs: 0
- Citation regression pairs: 0
- Source-ID regression pairs: 0
- Lifecycle regression pairs: 0
- Unsupported regression pairs: 0
- Owner-boundary regression pairs: 0
- Streaming regression pairs: 1
- Compact runs with projection fallback items: 0
- Shared quality-failure questions: q025, q026, q012

## Per-run results

| Question | Round | View | Order | Status | Input chars | TTFT ms | Generation ms | Total ms | Quality | Fallback | Streaming |
| --- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| q012 | 1 | original | 1 | completed | 6,825 | 7,944 | 11,091 | 11,153 | fail | none | streaming_success |
| q012 | 1 | compact | 2 | completed | 5,522 | 9,726 | 12,794 | 12,843 | fail | none | streaming_success |
| q026 | 1 | original | 1 | completed | 10,032 | 4,851 | 6,845 | 6,857 | fail | none | safe_fallback |
| q026 | 1 | compact | 2 | completed | 7,108 | 6,002 | 7,266 | 7,273 | fail | none | streaming_success |
| q025 | 1 | original | 1 | completed | 10,034 | 11,285 | 14,419 | 14,426 | fail | none | streaming_success |
| q025 | 1 | compact | 2 | completed | 7,110 | 16,552 | 19,559 | 19,569 | fail | none | streaming_success |
| q022 | 1 | original | 1 | completed | 8,348 | 4,907 | 6,282 | 6,321 | pass | none | safe_fallback |
| q022 | 1 | compact | 2 | completed | 5,958 | 4,498 | 7,213 | 7,254 | pass | none | safe_fallback |
| q017 | 1 | original | 1 | completed | 11,078 | 4,332 | 8,023 | 8,068 | pass | none | safe_fallback |
| q017 | 1 | compact | 2 | completed | 7,000 | 5,571 | 8,443 | 8,488 | pass | none | streaming_success |
| q018 | 1 | original | 1 | completed | 5,899 | 5,272 | 11,070 | 11,113 | pass | none | streaming_success |
| q018 | 1 | compact | 2 | completed | 5,105 | 6,250 | 8,469 | 8,512 | pass | none | streaming_success |
| q034 | 1 | original | 1 | completed | 7,467 | 6,805 | 8,510 | 8,551 | pass | none | safe_fallback |
| q034 | 1 | compact | 2 | completed | 5,300 | 6,326 | 9,338 | 9,379 | pass | none | safe_fallback |
| q017 | 2 | compact | 1 | completed | 7,000 | 5,477 | 7,964 | 8,010 | pass | none | streaming_success |
| q017 | 2 | original | 2 | completed | 11,078 | 7,268 | 11,277 | 11,327 | pass | none | streaming_success |
| q022 | 2 | compact | 1 | completed | 5,958 | 6,496 | 8,298 | 8,339 | pass | none | safe_fallback |
| q022 | 2 | original | 2 | completed | 8,348 | 6,969 | 8,718 | 8,755 | pass | none | safe_fallback |
| q018 | 2 | compact | 1 | completed | 5,105 | 4,005 | 8,677 | 8,727 | pass | none | streaming_success |
| q018 | 2 | original | 2 | completed | 5,899 | 4,643 | 8,504 | 8,541 | pass | none | safe_fallback |
| q012 | 2 | compact | 1 | completed | 5,522 | 4,354 | 6,865 | 6,905 | fail | none | streaming_success |
| q012 | 2 | original | 2 | completed | 6,825 | 4,645 | 7,153 | 7,192 | fail | none | streaming_success |
| q026 | 2 | compact | 1 | completed | 7,108 | 5,607 | 7,356 | 7,363 | fail | none | safe_fallback |
| q026 | 2 | original | 2 | completed | 10,032 | 4,258 | 6,609 | 6,619 | fail | none | streaming_success |
| q025 | 2 | compact | 1 | completed | 7,110 | 16,957 | 17,754 | 17,762 | fail | none | streaming_success |
| q025 | 2 | original | 2 | completed | 10,034 | 15,279 | 17,593 | 17,600 | fail | none | streaming_success |
| q034 | 2 | compact | 1 | completed | 5,300 | 7,256 | 9,028 | 9,074 | pass | none | safe_fallback |
| q034 | 2 | original | 2 | completed | 7,467 | 10,174 | 11,379 | 11,420 | pass | none | safe_fallback |
| q022 | 3 | original | 1 | completed | 8,348 | 5,145 | 6,675 | 6,714 | pass | none | safe_fallback |
| q022 | 3 | compact | 2 | completed | 5,958 | 5,322 | 8,827 | 8,869 | pass | none | safe_fallback |
| q012 | 3 | original | 1 | completed | 6,825 | 4,237 | 6,574 | 6,616 | fail | none | streaming_success |
| q012 | 3 | compact | 2 | completed | 5,522 | 3,048 | 5,629 | 5,668 | fail | none | streaming_success |
| q026 | 3 | original | 1 | completed | 10,032 | 4,458 | 6,361 | 6,371 | fail | none | safe_fallback |
| q026 | 3 | compact | 2 | completed | 7,108 | 5,770 | 7,710 | 7,719 | fail | none | streaming_success |
| q025 | 3 | original | 1 | completed | 10,034 | 10,120 | 13,054 | 13,067 | fail | none | streaming_success |
| q025 | 3 | compact | 2 | completed | 7,110 | 10,106 | 11,533 | 11,541 | fail | none | streaming_success |
| q018 | 3 | original | 1 | completed | 5,899 | 8,509 | 13,866 | 13,903 | pass | none | safe_fallback |
| q018 | 3 | compact | 2 | completed | 5,105 | 4,847 | 11,110 | 11,144 | pass | none | safe_fallback |
| q034 | 3 | original | 1 | completed | 7,467 | 5,923 | 7,963 | 8,004 | pass | none | safe_fallback |
| q034 | 3 | compact | 2 | completed | 5,300 | 8,014 | 9,804 | 9,841 | pass | none | safe_fallback |
| q017 | 3 | original | 1 | completed | 11,078 | 6,275 | 10,061 | 10,115 | pass | none | safe_fallback |
| q017 | 3 | compact | 2 | completed | 7,000 | 5,442 | 8,933 | 8,977 | pass | none | streaming_success |

## Regression cases

| Pair | Question | Round | Reasons |
| --- | --- | ---: | --- |
| r02-q026 | q026 | 2 | streaming_regression |

## Production gray assessment

**not_eligible**

- Required questions have unresolved shared quality failures: q025, q026, q012
- Compact did not demonstrate mean total latency improvement

## Limitations

- Estimated tokens use ceil(characters / 2); Provider token usage is not available.
- Owner-boundary validation is limited to detecting invented local-speaker-to-global-identity mappings because retained current-scope data has no trusted global speaker identities.
- Preference and relationship semantic checks are deterministic dataset-specific concept coverage, not an LLM judge.
- Latency is Provider- and network-dependent; three rounds reduce but do not remove temporal variance.
- Three rounds create a 2:1 execution-direction split per question, so order and round effects remain partially confounded.
- This current-scope retained benchmark used zero long-term Memory-context entries; it exercised shared transcript, Audio Insight, Brief, and Relationship context instead.
- Compact item-level fallback_original is reported explicitly and is never counted as a projected item.

## Post-run paired latency analysis

The 21 matched Original/Compact pairs were also analyzed as paired
observations (`Compact - Original`). Compact reduced the mean Provider input
from `8,526` to `6,158` characters (`-27.77%`), but the latency deltas were
indistinguishable from Provider/network variance:

| Metric | Mean paired delta | Median paired delta | Approx. 95% CI | Exact sign-flip p |
| --- | ---: | ---: | ---: | ---: |
| TTFT | +206 ms | -14 ms | [-663, +1,075] ms | 0.6346 |
| Generation | +26 ms | +173 ms | [-869, +921] ms | 0.9534 |
| Total | +25 ms | +186 ms | [-870, +920] ms | 0.9550 |

Lifecycle questions showed a directional total-latency improvement of about
`9.8%`: q017 improved `13.7%` and q018 improved `15.4%`, while q034 was
effectively flat (`+1.1%` slower). The subset is too small and its confidence
interval crosses zero, so this is a follow-up signal rather than a demonstrated
gain.

The only clear latency outlier was q025 round 1, where Compact was about
`5.1 s` slower. Removing that pair changes the mean total delta to roughly
`-231 ms`, but the interval still crosses zero. The conclusion therefore does
not depend on the outlier.

## Quality audit

- q017, q018, q022, and q034 passed `3/3` rounds in both views after an
  offline scorer correction. The initial q034 failure was a rubric
  false-negative: the answer correctly said that pottery booking was completed
  while rehearsal and phone notification remained commitments, but the scorer
  did not recognize the wording "no evidence shows everything was done".
- Citation validity and canonical source-ID mapping were `42/42`; lifecycle
  correctness was `9/9` for both views; grounded unsupported handling was
  `3/3` for both views. Projection fallback was `0`.
- q025 and q026 failed in both views because the shared Top-16 retrieval
  selected early soup/pepper/draft evidence instead of the retained stable
  cilantro/spice/light-food/quiet-seat evidence. q012 failed in both views
  because the complete confirmed/tentative/unknown state distinction did not
  reach the answer. These failures occur before Compact projection and are not
  Compact-only regressions.
- Compact produced `13` fully committed streaming answers versus `9` for
  Original. One q026 pair moved in the opposite direction, but all q026
  answers in both views failed the shared preference coverage check.

## Experimental caveat and recommendation

The captured three-round run used a per-question `2:1` execution-direction
split, so order and round effects remain partly confounded. During this run the
Original arm also emitted one content-free shadow metric while the Compact arm
did not. The Provider payload remained controlled, but this small local logging
asymmetry is now removed for future runs.

Compact Evidence is **not eligible for production gray yet**. It materially
reduces payload size and did not introduce a verified citation, source,
lifecycle, unsupported, or owner-boundary regression, but this run did not
demonstrate a stable latency improvement and the required preference and
relationship questions still have shared retrieval coverage failures.
