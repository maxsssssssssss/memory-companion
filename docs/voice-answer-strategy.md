# Voice Answer Strategy

## Purpose

Browser Voice QA supports two server-owned answer strategies for controlled latency and quality comparison. Both strategies keep Volcengine limited to realtime ASR/TTS; the Daily Brief QA/Memory Agent remains responsible for retrieval, reasoning boundaries, citations, and the answer.

The default remains the existing production path.

## Production Agent QA (`agent`)

```text
ASR final
  -> existing trusted context / Memory retrieval
  -> Relationship-aware evidence ranking
  -> existing Agent QA prompt
  -> one QA Provider call
  -> citation, owner, lifecycle, and safety validation
  -> Voice Response Optimizer
  -> Volcengine TTS
```

`AgentQAAnswerStrategy` wraps the existing `answerQuestionWithAI` behavior. It does not add a model call or bypass deterministic validation.

## Experimental Direct Context (`direct`)

```text
ASR final
  -> the same existing retrieval output
  -> compact constrained context prompt
  -> one QA Provider call
  -> the same citation, owner, lifecycle, and safety validation
  -> the same Voice Response Optimizer
  -> Volcengine TTS
```

`DirectContextAnswerStrategy` changes only the Provider instruction layer. It does not:

- rerun retrieval;
- write or alter Memory items, evidence, relations, owner attribution, or lifecycle state;
- use a different Provider or model;
- bypass source ID or citation validation;
- bypass Relationship safety boundaries;
- change the public `QuestionAnswer` or Voice response shape.

Normal QA answer/session history persistence may still occur. That is separate from Memory mutation.

## Configuration

Set the server environment variable:

```env
VOICE_ANSWER_MODE=agent
```

Allowed values are exactly:

- `agent`: production default.
- `direct`: isolated experimental path.

Unset or blank configuration resolves to `agent`. Any other value fails closed with an explicit configuration error. The browser cannot select the mode in form data or query parameters.

After changing the value, restart the Next.js web process so the server reads the new environment. The Pipeline worker does not execute Browser Voice QA and does not need the flag for this comparison.

## Compatibility and safety

Both modes consume the same `AnswerQuestionWithAIInput`, including:

- ranked original evidence;
- long-term Memory context where the selected scope supports it;
- Memory owner attribution metadata;
- Relationship Cards and lifecycle-backed context;
- conversation context;
- the same source segment IDs.

Both produce the existing `QuestionAnswer`. The bridge then derives a shorter spoken projection while keeping citations and evidence in the internal answer.

## Benchmark methodology

For a useful A/B comparison:

1. Use the same retained upload/context, user, scope, question, Provider endpoint, and model.
2. Run one mode at a time and restart the web process after changing the flag.
3. Compare `VOICE_QA_BENCHMARK` fields:
   - `answer_mode`
   - `retrieval_ms`
   - `reasoning_ms`
   - `generation_ms`
   - `total_latency_ms`
   - `response_length`
   - `evidence_count`
   - `prompt_chars`
   - `fallback_reason`
4. Verify answer citations, uncertainty, owner attribution boundaries, and Relationship safety; latency alone is not sufficient.
5. Do not compare two modes with different retrieval inputs or different models.

The structured log contains only identifiers, timings, counts, lengths, and status-like fields. It excludes the question, answer, transcript, raw Memory/evidence text, credentials, and Provider response.

## Current measurements

Local prompt measurement with the same short Voice instruction:

| Strategy | System prompt |
| --- | ---: |
| Agent | 1,726 characters |
| Direct | 605 characters |

Using the fixed instruction `Keep the answer concise.`, Direct reduces the system instruction by 64.95%. Holding the previously measured 9,637-character retained evidence/user packet constant gives an estimated total-prompt reduction from about 11,363 to 10,242 characters (about 9.87%). This is a character-count comparison only; no real remote Direct benchmark was run as part of this implementation.

## Rollback

Set `VOICE_ANSWER_MODE=agent` (or remove the variable) and restart the web process. No data migration is required because neither strategy changes public schemas or Memory storage.

## Limitations

- The existing production Agent QA is already deterministic retrieval plus one LLM generation call; Direct mode does not remove a hidden second LLM call.
- Provider first-token and SDK-internal retry timings are not currently available.
- Prompt size is only one possible contributor to Provider latency.
- Direct mode must remain experimental until real A/B latency and grounding quality are both verified.
