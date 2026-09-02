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
};

export type WorkMeetingWindowingOptions = {
  maxSegments?: number;
  maxCharacters?: number;
  overlapSegments?: number;
  minimumSegmentsBeforeBoundary?: number;
};

const DEFAULTS = {
  maxSegments: 80,
  maxCharacters: 24_000,
  overlapSegments: 4,
  minimumSegmentsBeforeBoundary: 8
} as const;

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

function segmentCharacters(segment: TranscriptSegment) {
  return segment.id.length
    + segment.text.length
    + (segment.speaker?.length ?? 0)
    + 32;
}

function preferredSpeakerBoundary(input: {
  segments: TranscriptSegment[];
  start: number;
  end: number;
  minimumSegmentsBeforeBoundary: number;
}) {
  const minimumBoundary = input.start + input.minimumSegmentsBeforeBoundary;
  if (input.end <= minimumBoundary) return input.end;
  const searchFloor = Math.max(minimumBoundary, input.end - Math.max(4, Math.floor((input.end - input.start) / 3)));
  for (let index = input.end - 1; index >= searchFloor; index -= 1) {
    const previousSpeaker = input.segments[index - 1]?.speaker?.trim();
    const nextSpeaker = input.segments[index]?.speaker?.trim();
    if (previousSpeaker && nextSpeaker && previousSpeaker !== nextSpeaker) {
      return index;
    }
  }
  return input.end;
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
  const maxSegments = boundedInteger(options.maxSegments, DEFAULTS.maxSegments, 1, 1_000, "maxSegments");
  const maxCharacters = boundedInteger(
    options.maxCharacters,
    DEFAULTS.maxCharacters,
    256,
    1_000_000,
    "maxCharacters"
  );
  const overlapSegments = boundedInteger(
    options.overlapSegments,
    DEFAULTS.overlapSegments,
    0,
    Math.max(0, maxSegments - 1),
    "overlapSegments"
  );
  const minimumSegmentsBeforeBoundary = boundedInteger(
    options.minimumSegmentsBeforeBoundary,
    Math.min(DEFAULTS.minimumSegmentsBeforeBoundary, maxSegments),
    1,
    maxSegments,
    "minimumSegmentsBeforeBoundary"
  );

  const pending: Array<Omit<WorkMeetingTranscriptWindow, "index" | "count">> = [];
  let start = 0;
  while (start < segments.length) {
    let end = start;
    let characterCount = 0;
    while (end < segments.length && end - start < maxSegments) {
      const nextCharacters = segmentCharacters(segments[end]);
      if (end > start && characterCount + nextCharacters > maxCharacters) break;
      characterCount += nextCharacters;
      end += 1;
    }
    if (end === start) {
      end = start + 1;
      characterCount = segmentCharacters(segments[start]);
    }
    if (end < segments.length) {
      const preferredEnd = preferredSpeakerBoundary({
        segments,
        start,
        end,
        minimumSegmentsBeforeBoundary
      });
      if (preferredEnd !== end) {
        end = preferredEnd;
        characterCount = segments.slice(start, end).reduce(
          (total, segment) => total + segmentCharacters(segment),
          0
        );
      }
    }
    const windowSegments = segments.slice(start, end);
    pending.push({
      segments: windowSegments,
      evidenceIds: windowSegments.map((segment) => segment.id),
      startSeconds: windowSegments[0].startSeconds,
      endSeconds: windowSegments.at(-1)!.endSeconds,
      characterCount
    });
    if (end >= segments.length) break;
    start = Math.max(start + 1, end - overlapSegments);
  }
  return pending.map((window, index) => ({
    ...window,
    index,
    count: pending.length
  }));
}
