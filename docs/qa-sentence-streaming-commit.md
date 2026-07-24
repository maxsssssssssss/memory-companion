# Sentence Commit v2 and Text QA Streaming

## Scope

Sentence Commit v2 lets an independently grounded sentence become visible or
audible before the Provider finishes the complete structured answer. It does
not change Retrieval, Memory, lifecycle resolution, the QA Provider contract,
or the final `QuestionAnswer` schema.

The non-streaming `answerQuestionWithAI()` path remains available as the
fail-closed fallback. The canonical final answer remains the only answer that
can be saved to QA history.

## v1 versus v2

Sentence Commit v1 detected boundaries while tokens arrived, but did not
release a sentence until the complete JSON response had passed whole-answer
validation:

```text
Provider tokens
-> complete JSON
-> whole-answer validation
-> sentence commit
-> TTS / UI
```

Sentence Commit v2 adds a conservative sentence-local proof:

```text
Provider tokens
-> partial JSON answer buffer
-> complete sentence + inline [E#]
-> citation allowlist lookup
-> canonical source-ID mapping
-> relationship / lifecycle / owner / scope policy gate
-> groundingValidated sentence event
-> Text UI or Voice optimizer

Provider completion
-> existing whole-answer validation
-> canonical final QuestionAnswer
-> final-only persistence
```

Raw Provider deltas are still emitted only as quarantined internal events. They
are never sent to the browser, TTS, logs, or persistence.

## Sentence boundaries

Hard boundaries are Chinese `。！？`, ASCII `.?!`, and newline. Chinese/ASCII
semicolons are citation-aware soft boundaries: `A；[E1] B。[E2]` can become two
units, while `A；B。[E1]` stays one unit. This prevents an early clause from
being detached from the citation that supports the complete compound sentence.
Commas remain soft boundaries.

The parser understands JSON string escaping and waits when a citation token is
split across Provider chunks.

## Early grounding contract

Every released sentence has this internal shape:

```ts
{
  text: string;
  supportIds: string[];
  citedSegmentIds: string[];
  groundingValidated: true;
}
```

An early sentence is released only when:

1. the partial response mode is `memory_answer`;
2. the sentence has one or more strict inline citations such as `[E1]`;
3. every citation exists in the current turn's immutable Evidence allowlist;
4. citations resolve deterministically to canonical source segment IDs;
5. the sentence and selected Evidence share a meaningful lexical anchor;
6. the existing relationship, Memory-scope, and companion-safety finalizer
   accepts the isolated sentence;
7. lifecycle completion language is supported by resolved lifecycle Evidence;
8. unresolved or upload-local owner metadata is not promoted to a named owner.

`unsupported` and `assistant_meta` responses wait for complete-answer
validation. Invalid, uncited, or policy-rejected sentences remain quarantined.

The final response still undergoes the original JSON parser, citation
validation, lifecycle handling, relationship boundaries, response style, and
canonical `QuestionAnswer` construction. A later invalid suffix does not
retroactively make an already grounded prefix false, but the suffix is not
released.

## Browser Text QA

Server-backed text QA opts into `application/x-ndjson`. The server projects the
internal stream to a strict browser protocol:

```text
meta
sentence (zero or more, grounded only)
final (canonical QuestionAnswer)
complete
```

Raw token events are deliberately absent. The browser:

- appends validated sentences in sequence;
- hides the typing indicator after the first visible sentence;
- atomically replaces the provisional text with the canonical final answer;
- saves history only after `final`;
- removes partial text if the stream fails;
- aborts the request on scope change or component unmount.

The current client-side local-first/OpenRouter QA implementation remains on the
legacy full-answer path because it does not use the server streaming gateway.

## Voice QA

The Voice adapter forwards grounded sentence events immediately. Each sentence
then passes the existing streaming Voice optimizer, which removes citation
syntax without changing uncertainty, lifecycle state, or ownership language.
An async sentence queue lets TTS consume the first safe sentence while the QA
Provider is still generating later sentences.

If streaming TTS fails before any audio is emitted, Voice uses the validated
full-answer TTS fallback. If audio has already been emitted, it does not replay
a conflicting full answer. Session state, cancellation, audio ordering,
backpressure inside the TTS adapter, and browser audio queue behavior remain
unchanged.

## Trace

The content-free QA stream trace now records:

- `first_token_received`;
- `first_sentence_candidate`;
- `first_sentence_validated`;
- `first_sentence_completed`;
- `stream_completed`.

The browser logs `first_text_render` only after React has rendered the first
validated sentence. Voice continues to record `first_safe_sentence`,
`tts_stream_started`, `first_audio_chunk_received`, and `playback_started`
(`speechToFirstAudioPlayMs`).

No prompt, question, Evidence text, answer, token, credential, or raw Provider
response is included in these trace records.

## Failure behavior

- Empty, incomplete, or failed Provider streams use the existing full-answer
  fallback.
- Unknown or malformed citations fail closed.
- A sentence without local support is never projected to UI or speech.
- A failed final persistence step produces a stream error instead of a false
  success.
- Browser sentence sequence numbers are re-numbered contiguously so withheld
  internal candidates do not create protocol gaps.
- The final canonical answer is never persisted from a provisional sentence.

## Current limitations

- Early commit depends on the Provider placing `mode` before a progressively
  readable `answer` string and placing inline citations directly after the
  sentence they support.
- Conservative lexical and policy gates can delay a valid sentence until final
  validation; this is an intentional false-negative preference.
- A sentence already played cannot be retracted if a later suffix fails. The
  sentence itself has independent canonical support, and the failed suffix is
  withheld.
- No real Provider latency benchmark was run as part of this implementation;
  latency improvement is architectural and must be measured in a controlled
  smoke test.
