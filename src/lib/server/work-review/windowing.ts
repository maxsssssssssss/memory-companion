import { WorkCanonicalSegmentsSchema } from "@/lib/domain/work-review";
import type { TranscriptSegment } from "@/lib/domain/types";

export type WorkMeetingTranscriptWindow = {
  index: number;
  count: number;
  segments: TranscriptSegment[];
  evidenceIds: string[];
  startSeconds: number;
  endSeconds: number;
  characterCount: number;
  estimatedInputTokens: number;
};

export type WorkMeetingWindowingOptions = {
  /** Emergency guard only. Normal windows are sized by token budgets. */
  maxSegments?: number;
  /** Emergency guard only. Normal windows are sized by token budgets. */
  maxCharacters?: number;
  targetInputTokens?: number;
  preferredMinInputTokens?: number;
  preferredMaxInputTokens?: number;
  /** Hard maximum, except when one canonical Segment is oversized by itself. */
  maxInputTokens?: number;
  overlapTurns?: number;
  overlapSegmentHardCap?: number;
};

const DEFAULTS = {
  maxSegments: 96,
  maxCharacters: 24_000,
  targetInputTokens: 1_000,
  preferredMinInputTokens: 800,
  preferredMaxInputTokens: 1_200,
  maxInputTokens: 1_500,
  overlapTurns: 1,
  overlapSegmentHardCap: 8
} as const;

const TOPIC_TRANSITION_PATTERN = /^(?:接下来|下面|然后(?:我们)?(?:再)?(?:看|说|讨论)|换(?:一个|个)?(?:话题|问题)|另一个(?:话题|问题|事项)|再说(?:一个|下)|回到|至于|关于.{0,24}(?:方面|部分|问题)|next\b|moving\s+on\b|on\s+another\s+note\b|another\s+(?:topic|issue)\b|now\s+(?:let(?:'s|\s+us)\s+)?(?:discuss|consider|turn\s+to)\b|turning\s+to\b)/iu;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

/**
 * Conservative Work Review-only estimate for mixed Chinese/English meeting text.
 * Non-ASCII code points count as one token; ASCII code points count as 0.35.
 * Canonical Segment text is never sliced to satisfy this estimate.
 */
export function estimateWorkMeetingInputTokens(text: string) {
  let tokens = 0;
  for (const character of text) {
    tokens += (character.codePointAt(0) ?? 0) > 0x7f ? 1 : 0.35;
  }
  return Math.max(1, Math.ceil(tokens));
}

function transcriptSegmentPrompt(segment: TranscriptSegment) {
  const speaker = segment.speaker?.trim() || "unknown";
  return `[${segment.id}] ${segment.startSeconds}-${segment.endSeconds}s speaker=${speaker}: ${segment.text}`;
}

function windowInputMetrics(segments: TranscriptSegment[]) {
  const prompt = segments.map(transcriptSegmentPrompt).join("\n");
  return {
    characterCount: prompt.length,
    estimatedInputTokens: estimateWorkMeetingInputTokens(prompt)
  };
}

function transcriptWindowFromSegments(
  segments: TranscriptSegment[],
  index: number,
  count: number
): WorkMeetingTranscriptWindow {
  const metrics = windowInputMetrics(segments);
  return {
    index,
    count,
    segments,
    evidenceIds: segments.map((segment) => segment.id),
    startSeconds: segments[0].startSeconds,
    endSeconds: segments.at(-1)!.endSeconds,
    ...metrics
  };
}

/** Recovery never adds overlap, so recursive splitting cannot amplify evidence. */
export function splitWorkMeetingTranscriptWindow(
  window: WorkMeetingTranscriptWindow
): WorkMeetingTranscriptWindow[] {
  if (window.segments.length < 2) return [window];
  const midpoint = Math.ceil(window.segments.length / 2);
  const parts = [
    window.segments.slice(0, midpoint),
    window.segments.slice(midpoint)
  ];
  return parts.map((segments, index) => transcriptWindowFromSegments(
    segments,
    index,
    parts.length
  ));
}

function knownSpeaker(segment: TranscriptSegment | undefined) {
  const speaker = segment?.speaker?.trim();
  if (!speaker) return null;
  const normalized = speaker.normalize("NFKC").toLocaleLowerCase("zh-CN");
  return /^(?:unknown(?:\s+speaker)?|unidentified|未知|未识别|无法识别)$/u.test(normalized)
    ? null
    : normalized;
}

function isTopicTransition(segment: TranscriptSegment | undefined) {
  return segment ? TOPIC_TRANSITION_PATTERN.test(segment.text.trim()) : false;
}

function boundarySignals(segments: TranscriptSegment[], end: number) {
  if (end <= 0 || end >= segments.length) {
    return { speakerTurn: false, pause: false, topicTransition: false, score: 0 };
  }
  const previous = segments[end - 1];
  const next = segments[end];
  const previousSpeaker = knownSpeaker(previous);
  const nextSpeaker = knownSpeaker(next);
  const speakerTurn = previousSpeaker !== null
    && nextSpeaker !== null
    && previousSpeaker !== nextSpeaker;
  const pause = next.startSeconds - previous.endSeconds >= 2;
  const topicTransition = isTopicTransition(next);
  return {
    speakerTurn,
    pause,
    topicTransition,
    score: Number(speakerTurn) * 4 + Number(pause) * 2 + Number(topicTransition) * 2
  };
}

function isTurnBoundary(segments: TranscriptSegment[], index: number) {
  if (index <= 0 || index >= segments.length) return true;
  const previousSpeaker = knownSpeaker(segments[index - 1]);
  const nextSpeaker = knownSpeaker(segments[index]);
  // Unknown labels must not create one unbounded synthetic speaker turn.
  if (previousSpeaker === null || nextSpeaker === null) return true;
  return previousSpeaker !== nextSpeaker
    || segments[index].startSeconds - segments[index - 1].endSeconds >= 2
    || isTopicTransition(segments[index]);
}

function overlapStartForCompleteTurns(input: {
  segments: TranscriptSegment[];
  windowStart: number;
  windowEnd: number;
  overlapTurns: number;
  overlapSegmentHardCap: number;
}) {
  if (input.overlapTurns === 0 || input.windowEnd >= input.segments.length) {
    return input.windowEnd;
  }
  // A hard token/Segment cut in the middle of a turn is not a complete turn.
  if (!isTurnBoundary(input.segments, input.windowEnd)) return input.windowEnd;

  let turnStart = input.windowEnd;
  let includedTurns = 0;
  while (turnStart > input.windowStart && includedTurns < input.overlapTurns) {
    let previousBoundary = turnStart - 1;
    while (
      previousBoundary > input.windowStart
      && !isTurnBoundary(input.segments, previousBoundary)
    ) {
      previousBoundary -= 1;
    }
    if (input.windowEnd - previousBoundary > input.overlapSegmentHardCap) break;
    turnStart = previousBoundary;
    includedTurns += 1;
  }
  // Never produce a context-only window or lose forward progress.
  return turnStart > input.windowStart ? turnStart : input.windowEnd;
}

type CandidateBoundary = {
  end: number;
  metrics: ReturnType<typeof windowInputMetrics>;
  boundaryScore: number;
};

function chooseWindowEnd(input: {
  segments: TranscriptSegment[];
  start: number;
  minimumEnd: number;
  maximumEnd: number;
  targetInputTokens: number;
  preferredMinInputTokens: number;
  preferredMaxInputTokens: number;
}) {
  const candidates: CandidateBoundary[] = [];
  for (let end = input.minimumEnd; end <= input.maximumEnd; end += 1) {
    const metrics = windowInputMetrics(input.segments.slice(input.start, end));
    candidates.push({
      end,
      metrics,
      boundaryScore: boundarySignals(input.segments, end).score
    });
  }
  const completeRemainder = candidates.at(-1);
  if (
    completeRemainder?.end === input.segments.length
    && completeRemainder.metrics.estimatedInputTokens <= input.preferredMaxInputTokens
  ) {
    return completeRemainder;
  }

  const preferred = candidates.filter(({ metrics }) =>
    metrics.estimatedInputTokens >= input.preferredMinInputTokens
    && metrics.estimatedInputTokens <= input.preferredMaxInputTokens
  );
  const pool = preferred.length > 0 ? preferred : candidates;
  return [...pool].sort((left, right) => {
    if (preferred.length > 0) {
      const leftHasBoundary = Number(left.boundaryScore > 0);
      const rightHasBoundary = Number(right.boundaryScore > 0);
      if (leftHasBoundary !== rightHasBoundary) return rightHasBoundary - leftHasBoundary;
      if (left.boundaryScore !== right.boundaryScore) {
        return right.boundaryScore - left.boundaryScore;
      }
    }
    return Math.abs(left.metrics.estimatedInputTokens - input.targetInputTokens)
      - Math.abs(right.metrics.estimatedInputTokens - input.targetInputTokens)
      || right.boundaryScore - left.boundaryScore
      || left.end - right.end;
  })[0];
}

export function buildWorkMeetingTranscriptWindows(
  rawSegments: unknown[],
  options: WorkMeetingWindowingOptions = {}
): WorkMeetingTranscriptWindow[] {
  const segments = [...WorkCanonicalSegmentsSchema.parse(rawSegments)].sort((left, right) =>
    left.startSeconds - right.startSeconds
    || left.endSeconds - right.endSeconds
    || left.id.localeCompare(right.id)
  );
  const maxSegments = boundedInteger(
    options.maxSegments,
    DEFAULTS.maxSegments,
    1,
    1_000,
    "maxSegments"
  );
  const maxCharacters = boundedInteger(
    options.maxCharacters,
    DEFAULTS.maxCharacters,
    256,
    1_000_000,
    "maxCharacters"
  );
  const maxInputTokens = boundedInteger(
    options.maxInputTokens,
    DEFAULTS.maxInputTokens,
    64,
    1_000_000,
    "maxInputTokens"
  );
  const targetInputTokens = boundedInteger(
    options.targetInputTokens,
    DEFAULTS.targetInputTokens,
    64,
    maxInputTokens,
    "targetInputTokens"
  );
  const preferredMinInputTokens = boundedInteger(
    options.preferredMinInputTokens,
    DEFAULTS.preferredMinInputTokens,
    64,
    maxInputTokens,
    "preferredMinInputTokens"
  );
  const preferredMaxInputTokens = boundedInteger(
    options.preferredMaxInputTokens,
    DEFAULTS.preferredMaxInputTokens,
    64,
    maxInputTokens,
    "preferredMaxInputTokens"
  );
  if (
    preferredMinInputTokens > targetInputTokens
    || targetInputTokens > preferredMaxInputTokens
  ) {
    throw new Error(
      "token budgets must satisfy preferredMinInputTokens <= targetInputTokens <= preferredMaxInputTokens <= maxInputTokens"
    );
  }
  const overlapTurns = boundedInteger(
    options.overlapTurns,
    DEFAULTS.overlapTurns,
    0,
    2,
    "overlapTurns"
  );
  const overlapSegmentHardCap = boundedInteger(
    options.overlapSegmentHardCap,
    Math.min(DEFAULTS.overlapSegmentHardCap, maxSegments),
    1,
    maxSegments,
    "overlapSegmentHardCap"
  );

  const pending: Array<Omit<WorkMeetingTranscriptWindow, "index" | "count">> = [];
  let start = 0;
  let nextUncovered = 0;
  while (nextUncovered < segments.length) {
    let maximumEnd = start;
    while (maximumEnd < segments.length && maximumEnd - start < maxSegments) {
      const nextMetrics = windowInputMetrics(segments.slice(start, maximumEnd + 1));
      if (
        maximumEnd > start
        && (
          nextMetrics.characterCount > maxCharacters
          || nextMetrics.estimatedInputTokens > maxInputTokens
        )
      ) break;
      maximumEnd += 1;
    }
    const minimumEnd = nextUncovered + 1;
    // If overlap leaves no room for new Evidence, safely drop it for this window.
    if (maximumEnd < minimumEnd && start < nextUncovered) {
      start = nextUncovered;
      continue;
    }
    const selected = chooseWindowEnd({
      segments,
      start,
      minimumEnd,
      maximumEnd: Math.max(minimumEnd, maximumEnd),
      targetInputTokens,
      preferredMinInputTokens,
      preferredMaxInputTokens
    });
    const end = selected.end;
    const windowSegments = segments.slice(start, end);
    pending.push({
      segments: windowSegments,
      evidenceIds: windowSegments.map((segment) => segment.id),
      startSeconds: windowSegments[0].startSeconds,
      endSeconds: windowSegments.at(-1)!.endSeconds,
      ...selected.metrics
    });
    if (end >= segments.length) break;
    nextUncovered = end;
    start = overlapStartForCompleteTurns({
      segments,
      windowStart: start,
      windowEnd: end,
      overlapTurns,
      overlapSegmentHardCap
    });
  }
  return pending.map((window, index) => ({
    ...window,
    index,
    count: pending.length
  }));
}
