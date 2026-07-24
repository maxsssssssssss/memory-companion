# Lifecycle-aware Retrieval Improvement

## Problem

The `long-recording-60m-v1` Agent-versus-Direct benchmark showed that answer strategy was not the main cause of several factual failures. Both modes consumed the same ranked Evidence packet, and that packet favored early or generic observations over later state transitions.

- `q017` asked how the pottery reservation changed from an unconfirmed state. The retained transcript contained payment, confirmation, and completion evidence, but the original Top 16 was dominated by earlier “not yet checked” evidence.
- `q018` asked how the invitation question was resolved. The retained transcript and Daily Brief contained the final two-person/no-friends decision, but it was absent from the original Top 16.
- `q022` correctly retrieved two future commitments to send the discussion questions and outline. Direct mode sometimes returned structured `unsupported`; the old deterministic fallback then matched unrelated `open_question` items through the generic word “问题”.

The failures were therefore split into retrieval recall/ranking (`q017`, `q018`) and unsupported-answer routing (`q022`). They were not JSON, schema, source-ID, or citation-validation failures.

## Query Intent

Retrieval now performs deterministic intent analysis before ranking. Questions containing lifecycle direction such as the following are classified as:

```json
{
  "intent": "lifecycle_resolution",
  "preferLatestState": true
}
```

Recognized forms include:

- 后来怎么样 / 后来如何解决；
- 最终状态 / 最后结果；
- 有没有完成 / 是否确认；
- 后续如何；
- 现在或目前是什么状态；
- 是否有证据表明某项动作已经完成。

General questions keep the previous ranking and earlier-first tie break.

## Ranking Changes

The Evidence limit remains 16. The change selects a better packet instead of making the packet larger.

For lifecycle questions only:

1. The query is converted into deterministic meaningful text tokens using the existing text-feature normalizer.
2. Generic lifecycle/question tokens are removed. State and recency boosts require at least two shared topic tokens, so a single generic overlap such as “讨论” cannot connect unrelated events.
3. Topic-matched terminal states receive a `+14` boost. Controlled markers cover completed, confirmed, resolved, fulfilled, scheduled, paid/booked, explicit final decisions, and equivalent Chinese phrases.
4. Pending or provisional states receive `-4`. Markers include not confirmed, not completed, waiting, undecided, “之后再说”, and planned commitments.
5. Topic-matched Evidence receives a normalized `0..8` recency boost. Brief and raw transcript evidence receive small deterministic specificity boosts (`+3` and `+2`).
6. The selector reserves representatives for the resolved and pending sides of the same topic chain before filling the remaining slots with the normal ranked list. This keeps both the transition and its earlier state auditable.
7. Lifecycle ties prefer the later timestamp. Non-lifecycle ties continue to prefer the earlier timestamp.

State boosts are topic-gated and do not apply globally. A later rehearsal completion, for example, is not promoted for a pottery-reservation question.

## Unsupported Answer Handling

Structured `mode="unsupported"` no longer immediately enters the broad category fallback for lifecycle completion questions.

The grounded fallback inspects the full topic-relevant lifecycle candidate set and then uses only Evidence already present in the selected packet:

- If a terminal state exists, it reports the latest confirmable state and cites it.
- If only plans, commitments, or pending evidence exist, it states what those records support, states that no completion record was found, and does not infer completion.
- If no reliable same-topic Evidence exists, it returns a scoped uncertainty boundary without searching unrelated `open_question` items.

All citations are still constructed through the existing `buildAnswerFromAI` path. Source IDs, excerpts, and citation validation are unchanged.

## Retained Artifact Check

The implementation was checked offline against the retained `long-recording-60m-v1` context. No Provider was called and the full A/B benchmark was not rerun.

| Question | Previous observed failure | Updated retained ranking |
|---|---|---|
| q017 | Later completion missing from Top 16 | Rank 1 is the later Audio Insight whose source says the pottery reservation is complete; focused completion Brief evidence also remains in Top 16 |
| q018 | Final no-friends decision missing | `brief_21` (“只预约两人，不邀请朋友”) is rank 1; the provisional `brief_11` is rank 2 |
| q022 | Relevant promises at E11/E13; unrelated fallback | The two send commitments are ranks 1 and 2; unsupported fallback cites those commitments and does not switch to unrelated “问题” items |

The packet remains exactly 16 Evidence items where at least 16 candidates are available.

## Regression Coverage

The focused regression suite covers:

- lifecycle intent recognition;
- `q017` pending-to-completed ranking under Top-16 pressure;
- `q018` undecided-to-final-decision ranking;
- rejection of a later completion from another event;
- unchanged ordering for non-lifecycle questions;
- Agent and Direct access to the same corrected Evidence with valid source IDs;
- grounded `unsupported` handling for `q022` in both modes;
- exclusion of unrelated open-question evidence.

## Expected Impact

The change should improve answers that ask for a later, final, completed, confirmed, or resolved state without changing the Answer Strategy interface or Provider prompt. It also prevents a semantically valid “no completion evidence” result from being replaced by unrelated deterministic search output.

## Limitations

- Topic and state matching is deterministic and lexical. It does not add embeddings or another LLM call.
- Controlled lifecycle markers cannot cover every paraphrase or language.
- Very short follow-up questions without a topic in the current utterance may still need conversation-aware topic carry-over in a later iteration.
- This validation proves ranking and fallback behavior offline. It does not claim new real-Provider answer quality or latency measurements because the full A/B benchmark was intentionally not rerun.
