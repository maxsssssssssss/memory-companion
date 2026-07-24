const STRICT_CITATION_TOKEN_PATTERN =
  /(?:\[(?:E|M)[1-9]\d*\]|【(?:E|M)[1-9]\d*】|\((?:E|M)[1-9]\d*\))/gu;

const CITATION_RESIDUE_PATTERNS = [
  /\[\s*[EeMm][^\]]*\]/u,
  /【\s*[EeMm][^】]*】/u,
  /［\s*[EeMm][^］]*］/u,
  /\(\s*[EeMm][^)]*\)/u,
  /（\s*[EeMm][^）]*）/u,
  /\b[EM]\s*\d+\b/u
] as const;

/**
 * These anchors are not used to infer meaning. They are a defence-in-depth
 * check that a presentation-only projection did not erase a safety boundary.
 */
const PROTECTED_SEMANTIC_ANCHORS = [
  "目前没有证据",
  "没有证据",
  "尚未",
  "还没有",
  "未完成",
  "不确定",
  "不能",
  "无法",
  "不足以",
  "不代表",
  "可能",
  "似乎",
  "仍未知",
  "只能",
  "计划",
  "承诺",
  "答应",
  "未确认",
  "已确认",
  "部分完成",
  "已完成",
  "兑现",
  "履行",
  "取消",
  "解决",
  "对方",
  "双方",
  "我们",
  "共同",
  "归属"
] as const;

export type StreamingVoiceSentenceInput = {
  sequence: number;
  sentence: string;
  /** Sentence-local source IDs resolved by SentenceCommitManager. */
  supportIds: readonly string[];
  /** Current final answer's trusted source-ID allowlist. */
  citedSegmentIds: readonly string[];
  groundingValidated: boolean;
};

export type StreamingSpeechSentence = {
  sequence: number;
  spokenSentence: string;
  supportIds: string[];
  safeForSpeech: true;
};

export type StreamingVoiceOptimizationFailureReason =
  | "invalid_sequence"
  | "grounding_not_validated"
  | "empty_sentence"
  | "missing_support"
  | "support_not_allowlisted"
  | "citation_residue"
  | "semantic_boundary_changed";

export type StreamingVoiceSentenceResult =
  | ({ ok: true } & StreamingSpeechSentence)
  | {
      ok: false;
      sequence: number;
      safeForSpeech: false;
      reason: StreamingVoiceOptimizationFailureReason;
    };

export type StreamingVoicePreflightFailureReason =
  | StreamingVoiceOptimizationFailureReason
  | "empty_turn";

export type StreamingVoicePreflightResult =
  | {
      ok: true;
      safeForSpeech: true;
      sentences: StreamingSpeechSentence[];
    }
  | {
      ok: false;
      safeForSpeech: false;
      reason: StreamingVoicePreflightFailureReason;
      failedSequence?: number;
      /** Always empty: a failed turn must not expose an earlier safe prefix. */
      sentences: [];
    };

function uniqueTrimmedStrings(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function validSequence(sequence: number) {
  return Number.isSafeInteger(sequence) && sequence > 0;
}

function containsCitationResidue(value: string) {
  return CITATION_RESIDUE_PATTERNS.some((pattern) => pattern.test(value));
}

function stripPresentationOnlySyntax(value: string) {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s*>\s?/gmu, "")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gmu, "")
    .replace(/^\s*[-*+]\s+/gmu, "")
    .replace(/^\s*\d+[.)]\s+/gmu, "")
    .replace(/(?:\*\*|__|`)/gu, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/gu, " ")
    .replace(/\s+([，。！？；：,.!?;:])/gu, "$1")
    .replace(/([，。！？；：])\s+/gu, "$1")
    .trim();
}

function occurrenceCount(value: string, token: string) {
  let count = 0;
  let offset = 0;
  while (offset <= value.length - token.length) {
    const index = value.indexOf(token, offset);
    if (index < 0) break;
    count += 1;
    offset = index + token.length;
  }
  return count;
}

function semanticBoundariesPreserved(source: string, spoken: string) {
  return PROTECTED_SEMANTIC_ANCHORS.every(
    (anchor) => occurrenceCount(source, anchor) === occurrenceCount(spoken, anchor)
  );
}

function failure(
  sequence: number,
  reason: StreamingVoiceOptimizationFailureReason
): StreamingVoiceSentenceResult {
  return { ok: false, sequence, safeForSpeech: false, reason };
}

/**
 * Converts one already-grounded sentence into a narrow spoken projection.
 *
 * This is intentionally not the full-response optimizer: it never summarizes,
 * rewords, reorders, or truncates content. Only citation/presentation syntax is
 * removed, so uncertainty, lifecycle state, and ownership language remains in
 * the exact grounded sentence.
 */
export function optimizeStreamingVoiceSentence(
  input: StreamingVoiceSentenceInput
): StreamingVoiceSentenceResult {
  if (!validSequence(input.sequence)) return failure(input.sequence, "invalid_sequence");
  if (input.groundingValidated !== true) {
    return failure(input.sequence, "grounding_not_validated");
  }

  const supportIds = uniqueTrimmedStrings(input.supportIds);
  if (supportIds.length === 0) return failure(input.sequence, "missing_support");
  const citedSegmentIds = new Set(uniqueTrimmedStrings(input.citedSegmentIds));
  if (supportIds.some((supportId) => !citedSegmentIds.has(supportId))) {
    return failure(input.sequence, "support_not_allowlisted");
  }

  const source = input.sentence.trim();
  if (!source) return failure(input.sequence, "empty_sentence");
  const withoutStrictCitations = source.replace(STRICT_CITATION_TOKEN_PATTERN, "");
  if (containsCitationResidue(withoutStrictCitations)) {
    return failure(input.sequence, "citation_residue");
  }
  const spokenSentence = stripPresentationOnlySyntax(withoutStrictCitations);
  if (!spokenSentence) return failure(input.sequence, "empty_sentence");
  if (!semanticBoundariesPreserved(withoutStrictCitations, spokenSentence)) {
    return failure(input.sequence, "semantic_boundary_changed");
  }

  return {
    ok: true,
    sequence: input.sequence,
    spokenSentence,
    supportIds,
    safeForSpeech: true
  };
}

/**
 * Validates the complete committed turn before exposing its first speech event.
 * A failure in any later sentence withholds the earlier prefix as well, allowing
 * callers to use the existing full-response QA + TTS fallback without duplicate
 * or selectively omitted speech.
 */
export function preflightStreamingVoiceSentences(
  inputs: readonly StreamingVoiceSentenceInput[]
): StreamingVoicePreflightResult {
  if (inputs.length === 0) {
    return {
      ok: false,
      safeForSpeech: false,
      reason: "empty_turn",
      sentences: []
    };
  }

  let previousSequence = 0;
  const sentences: StreamingSpeechSentence[] = [];
  for (const input of inputs) {
    if (!validSequence(input.sequence) || input.sequence <= previousSequence) {
      return {
        ok: false,
        safeForSpeech: false,
        reason: "invalid_sequence",
        failedSequence: input.sequence,
        sentences: []
      };
    }
    previousSequence = input.sequence;
    const result = optimizeStreamingVoiceSentence(input);
    if (!result.ok) {
      return {
        ok: false,
        safeForSpeech: false,
        reason: result.reason,
        failedSequence: result.sequence,
        sentences: []
      };
    }
    const { ok: _ok, ...sentence } = result;
    sentences.push(sentence);
  }

  return {
    ok: true,
    safeForSpeech: true,
    sentences
  };
}
