# Streaming QA Phase 1

> This document records the historical Phase 1 full-response commit boundary.
> The active implementation is Sentence Commit v2, documented in
> [qa-sentence-streaming-commit.md](./qa-sentence-streaming-commit.md). Raw token
> quarantine remains unchanged, but independently grounded sentences can now be
> released before the complete Provider JSON finishes.

## Scope

Phase 1 adds an opt-in streaming interface to the existing QA implementation. It does not replace `answerQuestionWithAI()` or alter Agent/Direct strategies. The later Streaming Voice closure consumes only its fully validated sentence commits; raw Phase 1 token events remain disconnected from TTS and the browser.

The installed OpenAI SDK supports both configured QA wire formats:

- Chat Completions with `stream: true` and `choices[].delta.content`;
- Responses with `stream: true` and `response.output_text.delta`.

The current Tokenhub/OpenAI-compatible gateway has not yet been verified with a real streaming smoke test. SDK support therefore does not prove that the deployed gateway supports SSE correctly. An unsupported, empty, incomplete, or failed stream falls back to the existing non-streaming `answerQuestionWithAI()` path.

## Event flow

```text
answerQuestionStream()
-> stream_started
-> token (zero or more, quarantined, unvalidated, and unsafe for speech/persistence)
-> accumulate complete provider JSON
-> require an explicit Provider completion event
-> existing relationship/citation/scope validation
-> sentence_completed (zero or more, QA-valid but still requires Voice Response Optimizer)
-> final (validated QuestionAnswer + trace)
```

The final event reports whether the result came from the provider stream or the non-streaming fallback. `answerQuestionWithAI()` remains the production default.

## Safety boundary

The QA Provider returns structured JSON containing `mode`, `answer`, and `citationIds`. A partial stream cannot prove that a sentence has valid citations or that a later part of the response will preserve the required uncertainty and relationship boundaries.

For that reason:

- `token` events expose raw content only as `quarantinedText`, with `safeForSpeech: false`, `safeForPersistence: false`, and `validated: false`;
- token content is not logged, persisted, sent to TTS, or connected to the browser;
- sentence events are emitted only after the entire response passes the same parser, citation allowlist, Evidence mapping, lifecycle fallback, relationship safety, Memory scope, and companion-style normalization used by the non-streaming path;
- validated sentence events still carry `safeForSpeech: false` and `requiresResponseOptimization: true`, because citation removal and spoken-text compaction belong to the unchanged Voice Response Optimizer;
- Chat streams must end with `finish_reason=stop`; Responses streams must emit `response.completed`. Clean EOF is treated as incomplete and falls back.

This quarantine preserves Evidence First, but it also means Phase 1 does not reduce production time-to-audio. It measures provider time-to-first-token and establishes a safe interface for a later sentence-commit protocol.

## Trace

Each run emits a content-free `QA_STREAM_TRACE` summary and can notify an optional observer. The trace records:

- `stream_started`;
- `first_token_received`;
- `first_sentence_completed` (first sentence released after final QA validation);
- `stream_completed`;
- Provider request start/end timestamps, Provider TTFT, validated first-sentence latency, Provider stream duration, and total operation latency;
- token chunk count, validated sentence count, Provider call count, status, and an enumerated fallback reason.

No prompt, question, Evidence text, answer, API key, or provider response is written to the trace.

`firstTokenMs` is measured from the Provider request start and is the Provider TTFT observed by this process. `totalStreamMs` is the observed async-iterator duration; because token events use an async generator, deliberate consumer backpressure is included. `providerCallCount` counts logical SDK calls, not internal HTTP retries performed by the OpenAI client.

## Usage

```ts
for await (const event of answerQuestionStream(input)) {
  if (event.type === "token") {
    // Diagnostics only. Never persist or route quarantinedText to TTS or UI.
  }
  if (event.type === "sentence_completed") {
    // QA-valid, but it still must pass Voice Response Optimizer before speech.
  }
  if (event.type === "final") {
    // Persist or display event.answer using the existing application flow.
  }
}
```

## Remaining work

- Run one explicitly approved provider-only smoke test to verify Tokenhub Responses SSE compatibility.
- Add cancellation/turn-generation guards before integrating streaming with a request timeout or multi-turn session.
- If pure network stream duration is required, drain deltas into a bounded internal queue so consumer backpressure can be measured separately.
- Define sentence-level citation and safety commits before allowing LLM generation to overlap with TTS.
- Add a streaming server transport before exposing sentence events to the browser.
