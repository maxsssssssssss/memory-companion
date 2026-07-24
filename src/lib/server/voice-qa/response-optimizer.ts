import type { QuestionAnswer } from "@/lib/domain/types";
import type { VoiceQaResponseMode } from "./types";

export const VOICE_RESPONSE_PREFERRED_MIN_WORDS = 30;
export const VOICE_RESPONSE_MAX_WORDS = 80;

export const VOICE_RESPONSE_EMPTY_FALLBACK =
  "我暂时没有找到足够的信息来回答这个问题。";

export type VoiceResponseOmissionReason =
  | "citations"
  | "length"
  | "list_compaction"
  | "markdown"
  | "robotic_preamble";

export type VoiceResponseOmittedDetails = {
  omitted: boolean;
  reason_codes: VoiceResponseOmissionReason[];
  omitted_sentence_count: number;
  original_word_estimate: number;
  spoken_word_estimate: number;
};

export type VoiceResponseSource<TEvidence = unknown, TCitation = unknown> = {
  answer: string;
  evidence?: readonly TEvidence[];
  confidence?: number;
  citations?: readonly TCitation[];
};

export type VoiceResponseOptimizerInput<TEvidence = unknown, TCitation = unknown> = {
  responseMode: VoiceQaResponseMode;
  response: VoiceResponseSource<TEvidence, TCitation>;
  /**
   * Follow-up questions remain opt-in. This prevents a projection layer from
   * changing a complete QA answer into unsolicited guidance.
   */
  allowFollowUpQuestion?: boolean;
};

export type VoiceResponseOptimizerResult<TEvidence = unknown, TCitation = unknown> = {
  spoken_text: string;
  omitted_details: VoiceResponseOmittedDetails;
  follow_up_question?: string;
  /** Evidence-bearing data is retained for the caller and is never spoken. */
  internal: {
    original_answer: string;
    evidence?: readonly TEvidence[];
    confidence?: number;
    citations?: readonly TCitation[];
  };
};

type SanitizedVoiceText = {
  text: string;
  reasons: Set<VoiceResponseOmissionReason>;
};

const UNCERTAINTY_PATTERN =
  /可能|也许|或许|似乎|不确定|不能|无法|不足以|未必|不代表|目前|暂时|还没有足够|只能|\b(?:may|might|could|seems?|uncertain|cannot|can't|not enough|does not mean|doesn't mean|so far)\b/iu;

const CITATION_DETECTION_PATTERN =
  /(?:\[(?:E|M)\d+(?:\s*[,，-]\s*(?:(?:E|M)\d+|\d+))*\]|【(?:E|M)\d+】|\((?:E|M)\d+\))/iu;
const CITATION_REPLACEMENT_PATTERN =
  /(?:\[(?:E|M)\d+(?:\s*[,，-]\s*(?:(?:E|M)\d+|\d+))*\]|【(?:E|M)\d+】|\((?:E|M)\d+\))/giu;
const SPOKEN_CITATION_REFERENCE_DETECTION_PATTERN =
  /(?:引用|证据|记忆记录|memory record|evidence)\s*(?:编号\s*)?(?:[EM]\d+|#\s*\d+)/iu;
const SPOKEN_CITATION_REFERENCE_REPLACEMENT_PATTERN =
  /(?:引用|证据|记忆记录|memory record|evidence)\s*(?:编号\s*)?(?:[EM]\d+|#\s*\d+)/giu;

const ROBOTIC_PREAMBLE_PATTERNS = [
  /^(?:简短回答|直接回答|总结|结论)\s*[，,:：\s]*/u,
  /^(?:根据|按照)(?:记忆)?(?:记录|证据|引用)(?:\s*#?\d+)?[，,:：\s]*/u,
  /^(?:从|由)(?:现有)?(?:记忆)?(?:记录|证据)来看[，,:：\s]*/u,
  /^according to (?:memory )?(?:record|evidence)(?:\s*#?\d+)?[,\s]*/iu
];

const MARKDOWN_PATTERN = /(?:^|\n)\s{0,3}(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+[.)]\s+)|```|`|\*\*|__/u;
const LIST_PATTERN = /(?:^|\n)\s*(?:[-*+]\s+|\d+[.)]\s+)/u;

function questionAnswerCitations(answer: QuestionAnswer) {
  return answer.citations as NonNullable<QuestionAnswer["citations"]> | undefined;
}

/**
 * Builds the optimizer source from the current public QA shape without moving
 * citations into the spoken projection.
 */
export function voiceResponseSourceFromQuestionAnswer(answer: QuestionAnswer) {
  return {
    answer: answer.answer,
    evidence: answer.citedSegmentIds,
    citations: questionAnswerCitations(answer)
  } satisfies VoiceResponseSource<string, NonNullable<QuestionAnswer["citations"]>[number]>;
}

function wordSegments(text: string) {
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  return [...segmenter.segment(text)].filter((segment) => segment.isWordLike);
}

/** Uses ICU word boundaries, which treat Chinese lexical words more naturally than character counts. */
export function estimateVoiceWordCount(text: string) {
  return wordSegments(text).length;
}

function normalizeMarkdown(text: string, reasons: Set<VoiceResponseOmissionReason>) {
  let normalized = text.replace(/\r\n?/gu, "\n");
  if (MARKDOWN_PATTERN.test(normalized)) {
    reasons.add("markdown");
  }
  if (LIST_PATTERN.test(normalized)) {
    reasons.add("list_compaction");
  }

  normalized = normalized
    .replace(/```(?:[A-Za-z0-9_-]+)?\s*/gu, "")
    .replace(/```/gu, "")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]+\)/giu, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s*>\s?/gmu, "")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gmu, "")
    .replace(/^\s*[-*+]\s+/gmu, "")
    .replace(/^\s*\d+[.)]\s+/gmu, "")
    .replace(/(?:\*\*|__|`)/gu, "");

  return normalized;
}

function sanitizeVoiceText(text: string): SanitizedVoiceText {
  const reasons = new Set<VoiceResponseOmissionReason>();
  let normalized = normalizeMarkdown(text.trim(), reasons);

  const hadCitation =
    CITATION_DETECTION_PATTERN.test(normalized) ||
    SPOKEN_CITATION_REFERENCE_DETECTION_PATTERN.test(normalized);

  for (const pattern of ROBOTIC_PREAMBLE_PATTERNS) {
    if (pattern.test(normalized)) {
      reasons.add("robotic_preamble");
      normalized = normalized.replace(pattern, "");
    }
  }

  if (hadCitation) {
    reasons.add("citations");
    normalized = normalized
      .replace(CITATION_REPLACEMENT_PATTERN, "")
      .replace(SPOKEN_CITATION_REFERENCE_REPLACEMENT_PATTERN, "");
  }

  return {
    text: normalized
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("。")
      .replace(/。{2,}/gu, "。")
      .replace(/\s+/gu, " ")
      .replace(/\s+([，。！？；：,.!?;:])/gu, "$1")
      .replace(/([，。！？；：])\s+/gu, "$1")
      .trim(),
    reasons
  };
}

function splitSentences(text: string) {
  const sentences = text.match(/[^。！？!?；;]+[。！？!?；;]?/gu) ?? [];
  return sentences.map((sentence) => sentence.trim()).filter(Boolean);
}

function ensureSentenceEnding(text: string) {
  const normalized = text.trim().replace(/[，、,:：;；\s]+$/gu, "");
  if (!normalized || /[。！？!?]$/u.test(normalized)) return normalized;
  return `${normalized}。`;
}

function truncateToWordBudget(text: string, maxWords: number) {
  if (maxWords <= 0) return "";
  const segments = wordSegments(text);
  if (segments.length <= maxWords) return text.trim();
  const last = segments[maxWords - 1];
  if (!last) return "";
  return ensureSentenceEnding(text.slice(0, last.index + last.segment.length));
}

function compactVoiceText(text: string) {
  const sentences = splitSentences(text);
  if (sentences.length === 0) {
    return { text: "", omittedSentenceCount: 0, lengthLimited: false };
  }
  if (estimateVoiceWordCount(text) <= VOICE_RESPONSE_MAX_WORDS) {
    return { text, omittedSentenceCount: 0, lengthLimited: false };
  }

  const boundaryIndexes = sentences.flatMap((sentence, index) =>
    index > 0 && UNCERTAINTY_PATTERN.test(sentence) ? [index] : []
  );
  const boundaryWordCount = boundaryIndexes.reduce(
    (total, index) => total + estimateVoiceWordCount(sentences[index] ?? ""),
    0
  );
  // A long opening sentence must not consume the budget needed to preserve a
  // later uncertainty/safety boundary. The cap still leaves at least 48 words
  // for the direct answer while short boundaries are retained in full.
  const boundaryReserve = boundaryIndexes.length > 0
    ? Math.max(12, Math.min(32, boundaryWordCount))
    : 0;
  const openingBudget = VOICE_RESPONSE_MAX_WORDS - boundaryReserve;
  const prioritizedIndexes = [
    0,
    ...boundaryIndexes,
    ...sentences.map((_, index) => index).filter((index) => index > 0)
  ].filter((index, position, all) => all.indexOf(index) === position);

  const selected: Array<{ index: number; sentence: string }> = [];
  let usedWords = 0;
  for (const index of prioritizedIndexes) {
    const sentence = sentences[index];
    if (!sentence) continue;
    const words = estimateVoiceWordCount(sentence);
    const remaining = VOICE_RESPONSE_MAX_WORDS - usedWords;
    const allowedWords = index === 0 && boundaryReserve > 0
      ? Math.min(remaining, openingBudget)
      : remaining;
    if (words <= allowedWords) {
      selected.push({ index, sentence });
      usedWords += words;
      continue;
    }

    const isRequiredBoundary = UNCERTAINTY_PATTERN.test(sentence);
    if ((selected.length === 0 || isRequiredBoundary) && allowedWords >= 4) {
      const shortened = truncateToWordBudget(sentence, allowedWords);
      if (shortened) {
        selected.push({ index, sentence: shortened });
        usedWords += estimateVoiceWordCount(shortened);
      }
    }
  }

  const selectedIndexes = new Set(selected.map((item) => item.index));
  const compacted = selected
    .sort((left, right) => left.index - right.index)
    .map((item) => item.sentence)
    .join("");

  return {
    text: compacted,
    omittedSentenceCount: sentences.filter((_, index) => !selectedIndexes.has(index)).length,
    lengthLimited: true
  };
}

function hasInternalSupport(input: VoiceResponseSource) {
  return Boolean(
    (input.evidence && input.evidence.length > 0) ||
    (input.citations && input.citations.length > 0)
  );
}

/**
 * Follow-ups are deliberately narrow and opt-in. They are generated only when
 * the QA confidence/support says clarification is needed, never from guessed facts.
 */
export function generateVoiceFollowUpQuestion(input: VoiceResponseSource) {
  const confidenceNeedsClarification =
    typeof input.confidence === "number" && Number.isFinite(input.confidence) && input.confidence < 0.55;
  if (!confidenceNeedsClarification && hasInternalSupport(input)) {
    return undefined;
  }
  return "你愿意再补充一点相关细节吗？";
}

function internalProjection<TEvidence, TCitation>(response: VoiceResponseSource<TEvidence, TCitation>) {
  return {
    original_answer: response.answer,
    ...(response.evidence !== undefined ? { evidence: response.evidence } : {}),
    ...(response.confidence !== undefined ? { confidence: response.confidence } : {}),
    ...(response.citations !== undefined ? { citations: response.citations } : {})
  };
}

/**
 * Produces a deterministic spoken projection. TEXT is an identity operation;
 * VOICE removes presentation-only syntax and bounds long answers without
 * mutating the evidence-bearing QA response.
 */
export function optimizeVoiceResponse<TEvidence = unknown, TCitation = unknown>(
  input: VoiceResponseOptimizerInput<TEvidence, TCitation>
): VoiceResponseOptimizerResult<TEvidence, TCitation> {
  const original = input.response.answer;
  const originalWordEstimate = estimateVoiceWordCount(original);

  if (input.responseMode === "TEXT") {
    return {
      spoken_text: original,
      omitted_details: {
        omitted: false,
        reason_codes: [],
        omitted_sentence_count: 0,
        original_word_estimate: originalWordEstimate,
        spoken_word_estimate: originalWordEstimate
      },
      internal: internalProjection(input.response)
    };
  }

  const sanitized = sanitizeVoiceText(original);
  const compacted = compactVoiceText(sanitized.text);
  if (compacted.lengthLimited) {
    sanitized.reasons.add("length");
  }
  const spokenText = compacted.text || VOICE_RESPONSE_EMPTY_FALLBACK;
  const reasonCodes = [...sanitized.reasons].sort();
  const followUpQuestion = input.allowFollowUpQuestion
    ? generateVoiceFollowUpQuestion(input.response)
    : undefined;

  return {
    spoken_text: spokenText,
    omitted_details: {
      omitted: reasonCodes.length > 0 || compacted.omittedSentenceCount > 0,
      reason_codes: reasonCodes,
      omitted_sentence_count: compacted.omittedSentenceCount,
      original_word_estimate: originalWordEstimate,
      spoken_word_estimate: estimateVoiceWordCount(spokenText)
    },
    ...(followUpQuestion ? { follow_up_question: followUpQuestion } : {}),
    internal: internalProjection(input.response)
  };
}
