import type { AudioInsight, TranscriptSegment, VoiceExplanation, VoicePause, VoiceVolume } from "@/lib/domain/types";

export type AcousticSegmentFeature = {
  segmentId: string;
  volume: VoiceVolume;
  pause: VoicePause;
  overlap: boolean;
  confidence: number;
  explanations?: VoiceExplanation[];
};

export function classifyVolumeFromDb(meanVolumeDb: number | undefined): VoiceVolume {
  if (typeof meanVolumeDb !== "number" || !Number.isFinite(meanVolumeDb)) {
    return "unknown";
  }

  if (meanVolumeDb <= -35) {
    return "low";
  }

  if (meanVolumeDb >= -18) {
    return "high";
  }

  return "normal";
}

export function classifyPauseFromSilenceRatio(silenceRatio: number | undefined): VoicePause {
  if (typeof silenceRatio !== "number" || !Number.isFinite(silenceRatio)) {
    return "unknown";
  }

  if (silenceRatio >= 0.35) {
    return "many";
  }

  if (silenceRatio >= 0.12) {
    return "normal";
  }

  return "few";
}

function pauseRank(pause: VoicePause) {
  return { unknown: 0, few: 1, normal: 2, many: 3 }[pause];
}

function strongestPause(pauses: VoicePause[]): VoicePause {
  return pauses.reduce<VoicePause>((selected, pause) => (pauseRank(pause) > pauseRank(selected) ? pause : selected), "unknown");
}

function mostCertainVolume(volumes: VoiceVolume[]): VoiceVolume {
  return volumes.find((volume) => volume !== "unknown") ?? "unknown";
}

function uniqueExplanations(explanations: VoiceExplanation[]) {
  const seen = new Set<string>();

  return explanations.filter((explanation) => {
    const key = `${explanation.kind}:${explanation.label}:${explanation.detail}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function hasOverlappingSpeech(segment: TranscriptSegment, segments: TranscriptSegment[]) {
  if (!segment.speaker) {
    return false;
  }

  return segments.some(
    (other) =>
      other.id !== segment.id &&
      Boolean(other.speaker) &&
      other.speaker !== segment.speaker &&
      other.startSeconds < segment.endSeconds &&
      other.endSeconds > segment.startSeconds
  );
}

export function applyAcousticFeaturesToAudioInsights(
  insights: AudioInsight[],
  features: AcousticSegmentFeature[]
): AudioInsight[] {
  if (features.length === 0) {
    return insights;
  }

  const featureBySegmentId = new Map(features.map((feature) => [feature.segmentId, feature]));

  return insights.map((insight) => {
    const sourceFeatures = insight.sourceSegmentIds.flatMap((segmentId) => {
      const feature = featureBySegmentId.get(segmentId);
      return feature ? [feature] : [];
    });

    if (sourceFeatures.length === 0) {
      return insight;
    }

    const confidence = Math.max(insight.voice.confidence, ...sourceFeatures.map((feature) => feature.confidence));

    return {
      ...insight,
      voice: {
        ...insight.voice,
        volume: mostCertainVolume(sourceFeatures.map((feature) => feature.volume)),
        pause: strongestPause(sourceFeatures.map((feature) => feature.pause)),
        overlap: insight.voice.overlap || sourceFeatures.some((feature) => feature.overlap),
        confidence: Math.min(0.9, confidence),
        explanations: uniqueExplanations([
          ...(insight.voice.explanations ?? []),
          ...sourceFeatures.flatMap((feature) => feature.explanations ?? [])
        ])
      }
    };
  });
}
