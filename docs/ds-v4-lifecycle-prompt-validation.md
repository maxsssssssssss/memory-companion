# DS v4 Lifecycle Prompt Validation

## Scope

This evaluation isolates the q034 question from the retained
`long-recording-60m-v1` run:

> 她答应的事情都做完了吗？

It compares the current DS v4 Agent QA system prompt with the same prompt plus
five explicit lifecycle rules. The production model, Agent QA implementation,
Retrieval, Evidence construction, citation mapping, and final validation are
unchanged.

The six real API requests were serialized and interleaved:

1. Current, enhanced
2. Enhanced, current
3. Current, enhanced

## Integrity

- Model: `deepseek-v4-flash`
- Requests: 6/6 completed
- Context digest:
  `efd3f1387b7417972029ed184ed50a4c4b23b42097b14c1f4efd54e20dc62bcd`
- Evidence digest for every request:
  `5f353545dd5dc7ac2a5a63a92810aa799bd46f2e59c764e1e9f210a178ef7af8`
- Evidence digest matched the prior GPT-5.5 versus DS v4 benchmark
- Current total prompt size: 7,467 characters in all three requests
- Enhanced total prompt size: 7,809 characters in all three requests
- Citation validation: 6/6 passed
- Fallback: 0/6
- Production default model changed: no

## Unchanged automated validation

| Prompt | Correct | Wrong | Fallback | Mean total latency |
| --- | ---: | ---: | ---: | ---: |
| Current DS | 2 | 1 | 0 | 8,804 ms |
| Lifecycle enhanced DS | 1 | 2 | 0 | 10,625 ms |

The enhanced prompt had a mean TTFT of 9,650 ms versus 7,824 ms for the current
prompt. Mean generation latency was 10,537 ms versus 8,728 ms. With only three
samples per prompt, these latency differences are descriptive rather than a
provider-performance conclusion.

## Manual lifecycle review

The unchanged q034 rubric checks for a pending Evidence state and a narrow set
of aggregate phrases such as “并非所有……完成”. Reviewing the complete answers
exposed both false positives and false negatives:

| Review lens | Current DS | Lifecycle enhanced DS |
| --- | ---: | ---: |
| Followed “planned/confirmed is not completed” | 0/3 | 3/3 |
| Fully clean latest-state lifecycle answer | 0/3 | 1/3 |

All three enhanced answers stopped treating the future rehearsal and
notification agreement as proof of execution. This is the narrow behavior the
extra rules targeted.

However, two enhanced answers still treated the earlier unconfirmed pottery
lookup as unfinished after later Evidence showed that the reservation had been
submitted, paid, and confirmed. Only the third enhanced answer cleanly separated
the completed pottery reservation from the future rehearsal and notification
arrangements.

The automated rubric also accepted two current-prompt answers that ended with a
matching “not all completed” phrase even though they incorrectly described
scheduled work as completed. Conversely, it rejected enhanced answers that used
valid wording such as “没有证据表明已经执行” and “不能算完成”.

## Conclusion

Prompt adaptation helps the specific commitment-versus-fulfillment boundary,
but it does not reliably solve the full q034 lifecycle chain. The remaining
failure is chronological state reconciliation: DS v4 can still retain an early
pending state after a later explicit completion.

Therefore:

- The result is not evidence that the current prompt is sufficient.
- The five added rules are useful but not a complete fix.
- DS v4 should remain an experimental model.
- The production default should remain unchanged.
- A future evaluation should pre-register a structured, contradiction-aware
  lifecycle rubric before making a model promotion decision.

The complete answers and per-request latency are retained in:

`.data/evaluation/ds-v4-q034-prompt-adaptation-v1/run-20260723-1410/report.md`
