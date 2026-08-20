import { createHash } from "node:crypto";

import {
  PendingCandidateInputSchema,
  ProcessingProfileSchema,
  SourceOriginSchema,
  type CandidateKind,
  type PendingCandidateInput,
  type ProcessingProfile,
  type SourceOrigin
} from "@/lib/domain/daily-reflection";
import {
  DAILY_REFLECTION_QUICK_CANDIDATE_LIMIT
} from "@/lib/domain/daily-reflection-duration";
import {
  TranscriptSegmentSchema,
  type TranscriptSegment
} from "@/lib/domain/types";

export type BuildDailyReflectionCandidatesInput = {
  segments: readonly TranscriptSegment[];
  sourceOrigin: SourceOrigin;
  processingProfile: ProcessingProfile;
};

export class DailyReflectionCandidateBuildError extends Error {
  readonly code = "daily_reflection_segments_required";

  constructor() {
    super("Daily Reflection candidate building requires at least one transcript segment");
  }
}

type CandidateDraft = {
  proposedText: string;
  candidateType: CandidateKind;
  sourceSegmentIds: string[];
  sourceUploadIds: string[];
};

function compareStrings(left: string, right: string) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareSegments(left: TranscriptSegment, right: TranscriptSegment) {
  return left.startSeconds - right.startSeconds
    || left.endSeconds - right.endSeconds
    || compareStrings(left.uploadId, right.uploadId)
    || compareStrings(left.id, right.id)
    || compareStrings(left.text, right.text);
}

function normalizeCandidateText(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

function candidateDedupKey(text: string) {
  return text.normalize("NFKC").toLowerCase();
}

function classifyCandidate(text: string, sourceOrigin: SourceOrigin): CandidateKind {
  if (
    sourceOrigin === "user_reflection"
    || sourceOrigin === "unknown"
    || sourceOrigin === "legacy_unknown"
  ) {
    // These origins cannot establish that a mentioned third-party event is a
    // fact. Preserve the source wording and keep the neutral review category.
    return "summary";
  }
  if (
    /[?？]\s*$/u.test(text)
    || /^(?:什么|为何|为什么|怎么|怎样|是否|能否|可否|谁|哪(?:里|个|些)|何时|几时)/u.test(text)
    || /^(?:what|why|how|when|where|who|which|can|could|would|should|do|does|did|is|are)\b/iu.test(text)
  ) {
    return "question";
  }
  if (
    /(?:我|我们)(?:会|将|要|打算|计划|准备|答应|承诺|决定)/u.test(text)
    || /\b(?:i|we)\s+(?:will|shall|plan|promise|intend)(?:\s|\b)/iu.test(text)
  ) {
    return "commitment";
  }
  if (
    /(?:喜欢|不喜欢|偏好|更想|更愿意|希望|讨厌|最爱)/u.test(text)
    || /\b(?:prefer|like|dislike|hate|hope|would rather)\b/iu.test(text)
  ) {
    return "preference";
  }
  if (
    /(?:发生|完成|结束|开始|去了|见到|收到|发现|今天|昨天|刚才|上周)/u.test(text)
    || /\b(?:happened|finished|started|went|met|received|noticed|today|yesterday)\b/iu.test(text)
  ) {
    return "event";
  }
  return "summary";
}

function deterministicCandidateId(input: {
  sourceOrigin: SourceOrigin;
  processingProfile: ProcessingProfile;
  candidate: CandidateDraft;
}) {
  const digest = createHash("sha256").update(JSON.stringify({
    version: 1,
    sourceOrigin: input.sourceOrigin,
    processingProfile: input.processingProfile,
    proposedText: input.candidate.proposedText,
    candidateType: input.candidate.candidateType,
    sourceSegmentIds: input.candidate.sourceSegmentIds,
    sourceUploadIds: input.candidate.sourceUploadIds
  })).digest("hex");
  return `daily_reflection_candidate_${digest}`;
}

/**
 * Builds review candidates directly from canonical transcript evidence.
 *
 * Candidate text stays in the source's own words for every source origin. In
 * particular, user reflections and unknown-origin text are never rewritten as
 * claims about a third party. The only textual normalization is whitespace.
 */
export function buildDailyReflectionCandidates(
  input: BuildDailyReflectionCandidatesInput
): PendingCandidateInput[] {
  const sourceOrigin = SourceOriginSchema.parse(input.sourceOrigin);
  const processingProfile = ProcessingProfileSchema.parse(input.processingProfile);
  const segments = input.segments
    .map((segment) => TranscriptSegmentSchema.parse(segment))
    .sort(compareSegments);

  const draftsByText = new Map<string, CandidateDraft>();
  for (const segment of segments) {
    const proposedText = normalizeCandidateText(segment.text);
    if (!proposedText) continue;

    const dedupKey = candidateDedupKey(proposedText);
    const existing = draftsByText.get(dedupKey);
    if (existing) {
      if (!existing.sourceSegmentIds.includes(segment.id)) {
        existing.sourceSegmentIds.push(segment.id);
        existing.sourceUploadIds.push(segment.uploadId);
      }
      continue;
    }

    draftsByText.set(dedupKey, {
      proposedText,
      candidateType: classifyCandidate(proposedText, sourceOrigin),
      sourceSegmentIds: [segment.id],
      sourceUploadIds: [segment.uploadId]
    });
  }

  const allDrafts = [...draftsByText.values()];
  if (allDrafts.length === 0) {
    throw new DailyReflectionCandidateBuildError();
  }

  const selectedDrafts = processingProfile === "quick_reflection"
    ? allDrafts.slice(0, DAILY_REFLECTION_QUICK_CANDIDATE_LIMIT)
    : allDrafts;

  return selectedDrafts.map((candidate, ordinal) => PendingCandidateInputSchema.parse({
    id: deterministicCandidateId({ sourceOrigin, processingProfile, candidate }),
    ordinal,
    proposedText: candidate.proposedText,
    candidateType: candidate.candidateType,
    sourceSegmentIds: candidate.sourceSegmentIds
  }));
}
