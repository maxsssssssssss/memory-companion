# Voice Response Style

## Purpose

`VoiceResponseOptimizer` is a deterministic projection layer for spoken QA. The evidence-bearing QA answer remains the source of truth; the optimizer derives a shorter, TTS-safe view only when `responseMode` is `VOICE`.

It does not call another model, change retrieval, rewrite citations, or alter normal text QA output.

## Data flow

```text
QuestionAnswer
  answer + citedSegmentIds + citations
        |
        v
VoiceResponseOptimizer (VOICE only)
  formatting cleanup
  citation removal from speech
  sentence-aware length control
  uncertainty preservation
        |
        +--> spoken_text -> TTS
        |
        +--> internal evidence/citations -> caller/audit
```

The output is:

```ts
{
  spoken_text: string;
  omitted_details: {
    omitted: boolean;
    reason_codes: Array<
      "citations" |
      "length" |
      "list_compaction" |
      "markdown" |
      "robotic_preamble"
    >;
    omitted_sentence_count: number;
    original_word_estimate: number;
    spoken_word_estimate: number;
  };
  follow_up_question?: string;
  internal: {
    original_answer: string;
    evidence?: readonly unknown[];
    confidence?: number;
    citations?: readonly unknown[];
  };
}
```

`omitted_details` contains counts and reason codes, never omitted answer text or transcript quotes.

## Length policy

- The preferred spoken range is 30–80 words.
- Short, complete answers are not padded to reach 30 words. Padding would invent content and make a direct answer less natural.
- Answers over 80 words are compressed by sentence, not by summarizing with a second LLM.
- The first direct-answer sentence is prioritized.
- Sentences that carry uncertainty or a safety boundary (for example, “可能”, “还不足以”, “不代表”, “might”, or “not enough”) are prioritized before secondary detail.
- When a long opening sentence would otherwise consume all 80 words, the
  optimizer reserves a bounded part of the budget for a later uncertainty or
  safety-boundary sentence. The spoken projection therefore does not become
  more certain merely because the original answer was long.
- Chinese length uses `Intl.Segmenter("zh-CN", { granularity: "word" })` rather than treating every Han character as one English word.
- If a single retained sentence exceeds the remaining budget, truncation occurs only on a word boundary and a spoken sentence ending is restored.

The policy is intentionally conservative: it may return fewer than 30 words, but it never manufactures filler to meet the target.

## Formatting policy

VOICE projection removes presentation syntax that should not be spoken:

- Markdown headings, bullets, checkboxes, block quotes, code fences, emphasis markers, and raw link URLs;
- citation markers such as `[E1]`, `[M2]`, `【E1】`, and `(E1)`;
- narrow mechanical preambles such as “根据记忆记录 #123” or “According to memory record #123”.

The original answer, evidence IDs, confidence, and citation objects remain under `internal`. The optimizer never mutates its input.

TEXT mode is an identity operation: the answer is returned byte-for-byte, including Markdown and citations.

## Follow-up questions

Follow-up generation is opt-in through `allowFollowUpQuestion`. This avoids turning every answer into an unsolicited prompt.

When enabled, the deterministic generator asks a neutral clarification question only if support is absent or finite confidence is below `0.55`:

> 你愿意再补充一点相关细节吗？

It does not guess missing facts or generate advice. High-confidence, evidence-backed answers do not receive a follow-up.

## Empty answers

An empty VOICE answer falls back to:

> 我暂时没有找到足够的信息来回答这个问题。

This fallback states the evidence boundary and does not imply a retrieved fact. Empty TEXT answers remain unchanged because the optimizer does not govern normal QA validation.

## Integration

`VoiceQaBridge` adapts the existing `QuestionAnswer` with
`voiceResponseSourceFromQuestionAnswer`, then calls `optimizeVoiceResponse`.
VOICE sends only `spoken_text` to TTS while retaining the original
`QuestionAnswer` for evidence display and diagnostics. TEXT is the optimizer's
identity path and therefore remains byte-for-byte unchanged.

The optimizer is not a replacement for the existing response-style prompt or companion-style normalizer. Those layers guide wording; this layer enforces the transport-specific spoken projection after QA.
