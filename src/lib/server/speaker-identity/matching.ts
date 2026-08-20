import { createHash } from "node:crypto";
import type { TranscriptChunk } from "@/lib/domain/chunks";
import type {
  SpeakerIdentityAssignment,
  SpeakerIdentityAssignmentReason,
  SpeakerIdentityCandidate,
  SpeakerIdentityComparisonAudit,
  SpeakerIdentityMatcher
} from "./types";

export const DEFAULT_SPEAKER_MATCH_THRESHOLD = 0.8;
export const DEFAULT_SPEAKER_MATCH_MARGIN = 0.08;

export function speakerIdentityCandidateKey(chunkId: string, localSpeaker: string) {
  return `${chunkId}::${localSpeaker}`;
}

export function buildSpeakerIdentityCandidates(input: {
  uploadId: string;
  chunks: TranscriptChunk[];
  matcherFeatures?: Record<string, unknown>;
}): SpeakerIdentityCandidate[] {
  return [...input.chunks]
    .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))
    .flatMap((chunk) => {
      if (chunk.uploadId !== input.uploadId) {
        throw new Error(`Transcript chunk ${chunk.id} does not belong to upload ${input.uploadId}`);
      }

      const bySpeaker = new Map<string, TranscriptChunk["segments"]>();
      for (const segment of chunk.segments) {
        const localSpeaker = segment.speaker;
        if (!localSpeaker?.trim()) continue;
        const group = bySpeaker.get(localSpeaker) ?? [];
        group.push(segment);
        bySpeaker.set(localSpeaker, group);
      }

      return [...bySpeaker.entries()]
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([localSpeaker, segments]): SpeakerIdentityCandidate => {
          const key = speakerIdentityCandidateKey(chunk.id, localSpeaker);
          return {
            key,
            uploadId: input.uploadId,
            chunkId: chunk.id,
            chunkIndex: chunk.index,
            localSpeaker,
            segmentIds: segments.map((segment) => segment.id),
            segmentCount: segments.length,
            startSeconds: Math.min(...segments.map((segment) => segment.startSeconds)),
            endSeconds: Math.max(...segments.map((segment) => segment.endSeconds)),
            ...(Object.prototype.hasOwnProperty.call(input.matcherFeatures ?? {}, key)
              ? { matcherFeatures: input.matcherFeatures?.[key] }
              : {})
          };
        });
    });
}

export function stableUnknownSpeakerId(candidate: SpeakerIdentityCandidate) {
  const digest = createHash("sha256")
    .update(`${candidate.uploadId}\u001f${candidate.chunkId}\u001f${candidate.localSpeaker}`)
    .digest("hex")
    .slice(0, 16);
  return `unknown_${digest}`;
}

type MatchTarget = {
  candidate: SpeakerIdentityCandidate;
  assignment: SpeakerIdentityAssignment;
};

type ScoredTarget = MatchTarget & {
  score: number;
};

export type CrossChunkMatchResult = {
  target?: MatchTarget;
  confidence: number;
  matched: boolean;
  reason: Extract<
    SpeakerIdentityAssignmentReason,
    | "cross_chunk_match"
    | "no_matching_evidence"
    | "below_confidence_threshold"
    | "ambiguous_match"
    | "same_chunk_identity_conflict"
  >;
  comparisons: SpeakerIdentityComparisonAudit[];
};

function validMatcherScore(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function bestTargetPerIdentity(targets: ScoredTarget[]) {
  const best = new Map<string, ScoredTarget>();
  for (const target of targets) {
    const globalSpeakerId = target.assignment.identity.globalSpeakerId;
    const previous = best.get(globalSpeakerId);
    if (
      !previous ||
      target.score > previous.score ||
      (target.score === previous.score && target.candidate.key.localeCompare(previous.candidate.key) < 0)
    ) {
      best.set(globalSpeakerId, target);
    }
  }
  return [...best.values()].sort(
    (left, right) =>
      right.score - left.score ||
      left.assignment.identity.globalSpeakerId.localeCompare(right.assignment.identity.globalSpeakerId)
  );
}

export async function matchSpeakerIdentityCandidate(input: {
  candidate: SpeakerIdentityCandidate;
  targets: MatchTarget[];
  matcher?: SpeakerIdentityMatcher;
  threshold: number;
  margin: number;
  occupiedGlobalSpeakerIds: Set<string>;
}): Promise<CrossChunkMatchResult> {
  if (!input.matcher) {
    return {
      confidence: 0,
      matched: false,
      reason: "no_matching_evidence",
      comparisons: []
    };
  }

  const scored: ScoredTarget[] = [];
  for (const target of input.targets) {
    if (target.candidate.chunkId === input.candidate.chunkId) continue;
    const score = validMatcherScore(await input.matcher.score({
      left: input.candidate,
      right: target.candidate
    }));
    if (score !== null) {
      scored.push({ ...target, score });
    }
  }

  const ranked = bestTargetPerIdentity(scored);
  const best = ranked[0];
  const second = ranked[1];
  if (!best) {
    return {
      confidence: 0,
      matched: false,
      reason: "no_matching_evidence",
      comparisons: []
    };
  }

  let reason: CrossChunkMatchResult["reason"] = "cross_chunk_match";
  if (best.score < input.threshold) {
    reason = "below_confidence_threshold";
  } else if (input.occupiedGlobalSpeakerIds.has(best.assignment.identity.globalSpeakerId)) {
    reason = "same_chunk_identity_conflict";
  } else if (second && best.score - second.score < input.margin) {
    reason = "ambiguous_match";
  }

  const accepted = reason === "cross_chunk_match";
  const rejectedBestReason = reason === "cross_chunk_match" ? "not_selected" : reason;
  const comparisons = scored.map((target): SpeakerIdentityComparisonAudit => {
    const isBest = target.candidate.key === best.candidate.key &&
      target.assignment.identity.globalSpeakerId === best.assignment.identity.globalSpeakerId;
    return {
      leftCandidateKey: input.candidate.key,
      rightCandidateKey: target.candidate.key,
      targetGlobalSpeakerId: target.assignment.identity.globalSpeakerId,
      score: target.score,
      accepted: accepted && isBest,
      reason: isBest
        ? accepted
          ? "accepted"
          : rejectedBestReason
        : "not_selected"
    };
  });

  return {
    ...(accepted ? { target: best } : {}),
    confidence: best.score,
    matched: accepted,
    reason,
    comparisons
  };
}
