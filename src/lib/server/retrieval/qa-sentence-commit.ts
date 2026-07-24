import { QuestionAnswerSchema, type QuestionAnswer } from "@/lib/domain/types";

const DEFAULT_MAX_BUFFERED_CHARACTERS = 256_000;
const STRICT_CITATION_ID_PATTERN = /^E[1-9]\d*$/u;
const CITATION_LIKE_TOKEN_PATTERN = /^[EeMm][A-Za-z0-9_-]*$/u;
const HARD_SENTENCE_BOUNDARIES = new Set(["。", "！", "？", "!", "?"]);
const SOFT_SENTENCE_BOUNDARIES = new Set(["；", ";", "，", ","]);
const SENTENCE_CLOSERS = new Set(["\"", "'", "”", "’", "」", "』", "）", ")", "]", "}"]);

type SentenceBoundaryKind = "hard" | "soft";

export type SentenceCommitEvidence = {
  citationId: string;
  supportIds: readonly string[];
};

export type SentenceCommitCandidate = {
  sequence: number;
  sentence: string;
  citationIds: string[];
  validated: false;
  safeForSpeech: false;
};

export type ProvisionalSentenceCommitInput = {
  sequence: number;
  sentence: string;
  citationIds: string[];
  supportIds: string[];
};

export type SentenceCommitReason =
  | "grounded"
  | "missing_sentence_support"
  | "invalid_citation"
  | "citation_metadata_mismatch"
  | "safety_boundary"
  | "response_not_fully_committable"
  | "empty_sentence";

export type SentenceCommit = {
  sequence: number;
  /** Citation-free sentence projection. The final QuestionAnswer remains unchanged. */
  sentence: string;
  citationIds: string[];
  /** Trusted transcript/source IDs resolved from the current evidence allowlist. */
  supportIds: string[];
  /** Backward-compatible explicit alias used by text and voice stream consumers. */
  citedSegmentIds: string[];
  validated: true;
  /** Full-answer validation and sentence-local grounding both succeeded. */
  groundingValidated: boolean;
  /** Voice Response Optimizer has not run in this phase. */
  safeForSpeech: false;
  safeForPersistence: false;
  status: "committed" | "withheld";
  reason: SentenceCommitReason;
};

export type SentenceCommitDiagnostics = {
  sentenceUnits: number;
  committedUnits: number;
  missingSentenceSupport: number;
  citationMetadataMismatch: number;
  responseNotFullyCommittable: number;
};

export type SentenceCommitSnapshot = {
  state: "open" | "finalized" | "cancelled";
  bufferedCharacters: number;
  candidates: SentenceCommitCandidate[];
};

export type SentenceCommitManager = {
  ingestDelta(delta: string): SentenceCommitSnapshot;
  /** Returns each independently grounded incremental sentence exactly once. */
  drainCommitted(): SentenceCommit[];
  commitValidatedAnswer(answer: QuestionAnswer): SentenceCommit[];
  cancel(reason?: string): boolean;
  snapshot(): SentenceCommitSnapshot;
  getCommitted(): SentenceCommit[];
};

type SplitResult = {
  units: string[];
  hasUnresolvedCitationSuffix: boolean;
};

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isBlankParagraph(value: string) {
  return /\n\s*\n/u.test(value);
}

function isPeriodBoundary(text: string, index: number) {
  if (text[index] !== ".") return false;
  const previous = text[index - 1] ?? "";
  const next = text[index + 1] ?? "";
  if (/\d/u.test(previous) && /\d/u.test(next)) return false;
  return next === "" || /\s/u.test(next) || SENTENCE_CLOSERS.has(next) || next === "[";
}

function sentenceBoundaryKind(text: string, index: number): SentenceBoundaryKind | null {
  const character = text[index] ?? "";
  if (character === "\n") return "hard";
  if (HARD_SENTENCE_BOUNDARIES.has(character) || isPeriodBoundary(text, index)) return "hard";
  if (SOFT_SENTENCE_BOUNDARIES.has(character)) return "soft";
  return null;
}

function isCitationSuffixToken(token: string) {
  return /^[EeMm]/u.test(token.trim()) || /[EeMm]\s*\d/u.test(token);
}

function normalizeUnit(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function scanSentenceUnits(text: string, includeRemainder: boolean): SplitResult {
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) return { units: [], hasUnresolvedCitationSuffix: false };

  const units: string[] = [];
  let buffer = "";
  let pendingBoundary: SentenceBoundaryKind | null = null;
  let boundaryHasCitation = false;
  let pendingWhitespace = "";
  let hasUnresolvedCitationSuffix = false;

  const flush = () => {
    const sentence = normalizeUnit(buffer);
    if (sentence) units.push(sentence);
    buffer = "";
    pendingBoundary = null;
    boundaryHasCitation = false;
    pendingWhitespace = "";
  };

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index] ?? "";
    if (pendingBoundary === null) {
      if (character === "\n") {
        pendingBoundary = "hard";
        pendingWhitespace = character;
        continue;
      }
      buffer += character;
      pendingBoundary = sentenceBoundaryKind(normalized, index);
      continue;
    }

    if (/\s/u.test(character)) {
      pendingWhitespace += character;
      if (character === "\n") pendingBoundary = "hard";
      continue;
    }

    if (!isBlankParagraph(pendingWhitespace) && SENTENCE_CLOSERS.has(character)) {
      buffer += pendingWhitespace + character;
      pendingWhitespace = "";
      continue;
    }

    if (!isBlankParagraph(pendingWhitespace) && (character === "[" || character === "［")) {
      const closingCharacter = character === "[" ? "]" : "］";
      const closingIndex = normalized.indexOf(closingCharacter, index + 1);
      if (closingIndex < 0) {
        hasUnresolvedCitationSuffix = true;
        if (includeRemainder) buffer += pendingWhitespace + normalized.slice(index);
        pendingWhitespace = "";
        break;
      }
      const token = normalized.slice(index + 1, closingIndex);
      if (isCitationSuffixToken(token)) {
        buffer += pendingWhitespace + normalized.slice(index, closingIndex + 1);
        boundaryHasCitation = true;
        pendingWhitespace = "";
        index = closingIndex;
        continue;
      }
    }

    if (
      pendingBoundary === "soft" &&
      !boundaryHasCitation &&
      !isBlankParagraph(pendingWhitespace) &&
      character !== "[" &&
      character !== "［"
    ) {
      buffer += pendingWhitespace + character;
      pendingWhitespace = "";
      pendingBoundary = sentenceBoundaryKind(normalized, index);
      continue;
    }

    flush();
    buffer = character;
    pendingBoundary = sentenceBoundaryKind(normalized, index);
  }

  if (
    pendingBoundary !== null &&
    !hasUnresolvedCitationSuffix &&
    (includeRemainder || boundaryHasCitation)
  ) {
    flush();
  } else if (includeRemainder) {
    buffer += pendingWhitespace;
    const remainder = normalizeUnit(buffer);
    if (remainder) units.push(remainder);
  }

  return { units, hasUnresolvedCitationSuffix };
}

/**
 * Splits final, already validated answer text into deterministic sentence units.
 * Immediate citation suffixes stay attached; citations across blank paragraphs do not.
 */
export function splitSentenceCommitUnits(text: string) {
  return scanSentenceUnits(text, true).units;
}

function extractPartialJsonAnswer(buffer: string) {
  const match = /(?:^|[,{}]\s*)"answer"\s*:\s*"/u.exec(buffer);
  if (!match || match.index === undefined) return null;
  const contentStart = match.index + match[0].length;
  let escaped = false;
  let contentEnd = buffer.length;

  for (let index = contentStart; index < buffer.length; index += 1) {
    const character = buffer[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "\"") {
      contentEnd = index;
      break;
    }
  }

  const escapedContent = buffer.slice(contentStart, contentEnd);
  try {
    return JSON.parse(`"${escapedContent}"`) as string;
  } catch {
    // A token may end in the middle of a JSON escape sequence. Wait for more data.
    return null;
  }
}

function extractPartialJsonMode(buffer: string) {
  const match = /(?:^|[,{}]\s*)"mode"\s*:\s*"([^"\\]*)"/u.exec(buffer);
  if (!match) return null;
  const mode = match[1];
  return mode === "assistant_meta" || mode === "memory_answer" || mode === "unsupported"
    ? mode
    : null;
}

function citationTokens(sentence: string) {
  const valid: string[] = [];
  let invalid = false;
  for (const match of sentence.matchAll(/(\[([^\]\r\n]{1,80})\]|［([^］\r\n]{1,80})］)/gu)) {
    const token = (match[2] ?? match[3] ?? "").trim();
    const usesAsciiBrackets = match[0]?.startsWith("[") && match[0]?.endsWith("]");
    if (usesAsciiBrackets && STRICT_CITATION_ID_PATTERN.test(token)) {
      valid.push(token);
    } else if (
      CITATION_LIKE_TOKEN_PATTERN.test(token) ||
      /^[EeMm]/u.test(token) ||
      /[EeMm]\s*\d/u.test(token)
    ) {
      invalid = true;
    }
  }
  return { citationIds: uniqueStrings(valid), invalid };
}

function citationFreeSentence(sentence: string) {
  return sentence
    .replace(/\s*\[E[1-9]\d*\]/gu, "")
    .replace(/\s+([，。！？；：,.!?;:])/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function sameStringSet(left: readonly string[], right: readonly string[]) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function cloneCommit(commit: SentenceCommit): SentenceCommit {
  return {
    ...commit,
    citationIds: [...commit.citationIds],
    supportIds: [...commit.supportIds],
    citedSegmentIds: [...commit.citedSegmentIds]
  };
}

export function summarizeSentenceCommits(
  commits: readonly SentenceCommit[]
): SentenceCommitDiagnostics {
  const countReason = (reason: SentenceCommitReason) =>
    commits.filter((commit) => commit.reason === reason).length;
  return {
    sentenceUnits: commits.length,
    committedUnits: commits.filter((commit) => commit.status === "committed").length,
    missingSentenceSupport: countReason("missing_sentence_support"),
    citationMetadataMismatch: countReason("citation_metadata_mismatch"),
    responseNotFullyCommittable: countReason("response_not_fully_committable")
  };
}

export function createSentenceCommitManager(options: {
  evidence: readonly SentenceCommitEvidence[];
  maxBufferedCharacters?: number;
  /**
   * Optional deterministic policy gate supplied by the QA layer. Citation and
   * source mapping are already proven before this callback runs.
   */
  validateProvisionalSentence?: (
    input: ProvisionalSentenceCommitInput
  ) => SentenceCommitReason | null;
}): SentenceCommitManager {
  const maxBufferedCharacters = options.maxBufferedCharacters ?? DEFAULT_MAX_BUFFERED_CHARACTERS;
  const evidence = new Map<string, string[]>();
  for (const item of options.evidence) {
    if (!STRICT_CITATION_ID_PATTERN.test(item.citationId)) {
      throw new Error(`SentenceCommitManager invalid citation ID: ${item.citationId}`);
    }
    if (evidence.has(item.citationId)) {
      throw new Error(`SentenceCommitManager duplicate citation ID: ${item.citationId}`);
    }
    const supportIds = uniqueStrings(item.supportIds);
    if (supportIds.length === 0) {
      throw new Error(`SentenceCommitManager citation ${item.citationId} has no support IDs`);
    }
    evidence.set(item.citationId, supportIds);
  }
  let state: SentenceCommitSnapshot["state"] = "open";
  let buffer = "";
  let candidates: SentenceCommitCandidate[] = [];
  let committed: SentenceCommit[] = [];
  let incrementalResults: SentenceCommit[] = [];
  let drainedCommitCount = 0;
  let processedCandidateCount = 0;
  let finalizedSignature: string | null = null;

  const snapshot = (): SentenceCommitSnapshot => ({
    state,
    bufferedCharacters: buffer.length,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      citationIds: [...candidate.citationIds]
    }))
  });

  const ingestDelta = (delta: string) => {
    if (state !== "open") {
      throw new Error(`SentenceCommitManager is ${state}; token deltas are no longer accepted`);
    }
    if (!delta) return snapshot();
    if (buffer.length + delta.length > maxBufferedCharacters) {
      state = "cancelled";
      buffer = "";
      candidates = [];
      throw new Error("SentenceCommitManager buffer limit exceeded");
    }
    buffer += delta;
    const mode = extractPartialJsonMode(buffer);
    const partialAnswer = extractPartialJsonAnswer(buffer);
    if (partialAnswer !== null) {
      candidates = scanSentenceUnits(partialAnswer, false).units.map((sentence, index) => ({
        sequence: index + 1,
        sentence,
        citationIds: citationTokens(sentence).citationIds,
        validated: false,
        safeForSpeech: false
      }));
    }
    if (mode === "memory_answer" && candidates.length > processedCandidateCount) {
      for (const candidate of candidates.slice(processedCandidateCount)) {
        const tokenResult = citationTokens(candidate.sentence);
        const sentence = citationFreeSentence(candidate.sentence);
        let reason: SentenceCommitReason = "grounded";
        const supportIds: string[] = [];

        if (!sentence) {
          reason = "empty_sentence";
        } else if (tokenResult.invalid) {
          reason = "invalid_citation";
        } else if (tokenResult.citationIds.length === 0) {
          reason = "missing_sentence_support";
        } else {
          for (const citationId of tokenResult.citationIds) {
            const mappedSupportIds = evidence.get(citationId);
            if (!mappedSupportIds) {
              reason = "invalid_citation";
              break;
            }
            supportIds.push(...mappedSupportIds);
          }
        }

        const canonicalSupportIds = reason === "grounded" ? uniqueStrings(supportIds) : [];
        if (reason === "grounded" && options.validateProvisionalSentence) {
          reason = options.validateProvisionalSentence({
            sequence: candidate.sequence,
            sentence: candidate.sentence,
            citationIds: [...tokenResult.citationIds],
            supportIds: [...canonicalSupportIds]
          }) ?? "grounded";
        }
        const grounded = reason === "grounded";
        incrementalResults.push({
          sequence: candidate.sequence,
          sentence,
          citationIds: [...tokenResult.citationIds],
          supportIds: grounded ? canonicalSupportIds : [],
          citedSegmentIds: grounded ? [...canonicalSupportIds] : [],
          validated: true,
          groundingValidated: grounded,
          safeForSpeech: false,
          safeForPersistence: false,
          status: grounded ? "committed" : "withheld",
          reason
        });
      }
      processedCandidateCount = candidates.length;
    }
    return snapshot();
  };

  const commitValidatedAnswer = (rawAnswer: QuestionAnswer) => {
    if (state === "cancelled") {
      throw new Error("SentenceCommitManager is cancelled; no sentence can be committed");
    }
    const answer = QuestionAnswerSchema.parse(rawAnswer);
    const signature = JSON.stringify({
      answer: answer.answer,
      citedSegmentIds: answer.citedSegmentIds,
      citations: answer.citations
    });
    if (state === "finalized") {
      if (signature !== finalizedSignature) {
        throw new Error("SentenceCommitManager was finalized with a different answer");
      }
      return committed.map(cloneCommit);
    }

    const finalCitationMetadata = new Map<string, string[]>();
    let duplicateFinalCitationId = false;
    for (const citation of answer.citations ?? []) {
      if (finalCitationMetadata.has(citation.id)) duplicateFinalCitationId = true;
      finalCitationMetadata.set(citation.id, uniqueStrings(citation.sourceSegmentIds));
    }
    const citedSegmentIds = uniqueStrings(answer.citedSegmentIds);
    const citedSegmentIdSet = new Set(citedSegmentIds);
    const citedSentences = splitSentenceCommitUnits(answer.answer);
    const sentenceTokenResults = citedSentences.map(citationTokens);
    const inlineCitationIds = uniqueStrings(
      sentenceTokenResults.flatMap((result) => result.citationIds)
    );
    const metadataCitationIds = [...finalCitationMetadata.keys()];
    const expectedSupportIds = uniqueStrings(
      inlineCitationIds.flatMap((citationId) => evidence.get(citationId) ?? [])
    );
    const metadataSupportIds = uniqueStrings([...finalCitationMetadata.values()].flat());
    const globalCitationAlignment =
      !duplicateFinalCitationId &&
      metadataCitationIds.every((citationId) => STRICT_CITATION_ID_PATTERN.test(citationId)) &&
      sameStringSet(inlineCitationIds, metadataCitationIds) &&
      sameStringSet(expectedSupportIds, metadataSupportIds) &&
      sameStringSet(metadataSupportIds, citedSegmentIds);

    const localResults = citedSentences.map((citedSentence, index) => {
      const tokenResult = sentenceTokenResults[index] ?? { citationIds: [], invalid: false };
      const spokenSentence = citationFreeSentence(citedSentence);
      let reason: SentenceCommitReason = "grounded";
      const supportIds: string[] = [];

      if (!spokenSentence) {
        reason = "empty_sentence";
      } else if (tokenResult.invalid) {
        reason = "invalid_citation";
      } else if (tokenResult.citationIds.length === 0) {
        reason = "missing_sentence_support";
      } else {
        for (const citationId of tokenResult.citationIds) {
          const allowlistedSupport = evidence.get(citationId);
          const metadataSupport = finalCitationMetadata.get(citationId);
          if (!allowlistedSupport) {
            reason = "invalid_citation";
            break;
          }
          if (
            !metadataSupport ||
            !sameStringSet(allowlistedSupport, metadataSupport) ||
            allowlistedSupport.some((supportId) => !citedSegmentIdSet.has(supportId))
          ) {
            reason = "citation_metadata_mismatch";
            break;
          }
          supportIds.push(...allowlistedSupport);
        }
      }

      if (reason === "grounded" && !globalCitationAlignment) {
        reason = "citation_metadata_mismatch";
      }
      const locallyGrounded = reason === "grounded";
      return {
        sequence: index + 1,
        sentence: spokenSentence,
        citationIds: tokenResult.citationIds,
        supportIds: locallyGrounded ? uniqueStrings(supportIds) : [],
        citedSegmentIds: locallyGrounded ? uniqueStrings(supportIds) : [],
        validated: true,
        groundingValidated: locallyGrounded,
        safeForSpeech: false,
        safeForPersistence: false,
        status: locallyGrounded ? "committed" : "withheld",
        reason
      } satisfies SentenceCommit;
    });
    const responseFullyCommittable = localResults.every((result) => result.status === "committed");
    committed = responseFullyCommittable
      ? localResults
      : localResults.map((result): SentenceCommit =>
        result.status === "withheld"
          ? result
          : {
              ...result,
              supportIds: [],
              citedSegmentIds: [],
              groundingValidated: false,
              status: "withheld",
              reason: "response_not_fully_committable"
            }
      );
    state = "finalized";
    finalizedSignature = signature;
    buffer = "";
    candidates = [];
    return committed.map(cloneCommit);
  };

  return {
    ingestDelta,
    drainCommitted() {
      const next = incrementalResults
        .slice(drainedCommitCount)
        .filter((item) => item.status === "committed" && item.groundingValidated)
        .map(cloneCommit);
      drainedCommitCount = incrementalResults.length;
      return next;
    },
    commitValidatedAnswer,
    cancel() {
      if (state !== "open") return false;
      state = "cancelled";
      buffer = "";
      candidates = [];
      incrementalResults = [];
      drainedCommitCount = 0;
      processedCandidateCount = 0;
      return true;
    },
    snapshot,
    getCommitted() {
      return committed.filter((item) => item.status === "committed").map(cloneCommit);
    }
  };
}
