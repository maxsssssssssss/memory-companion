import type { AudioInsight, AudioInsightUserCorrection } from "./types";

const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_CORRECTION_TEXT_LENGTH = 80;
const MAX_NOTE_LENGTH = 240;

export type StoredAudioInsightCorrection = {
  labelCorrections: Array<{ from: string; to: string }>;
  note?: string;
  updatedAt: string;
};

export type StoredAudioInsightCorrections = {
  corrections: Record<string, StoredAudioInsightCorrection>;
  updatedAt: string;
};

type AudioInsightCorrectionInput = {
  labelCorrections?: unknown;
  note?: unknown;
  updatedAt?: unknown;
};

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function sanitizeAudioInsightCorrection(input: unknown): StoredAudioInsightCorrection | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const candidate = input as AudioInsightCorrectionInput;
  const labelCorrections = Array.isArray(candidate.labelCorrections)
    ? candidate.labelCorrections
        .flatMap((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return [];
          }

          const pair = item as { from?: unknown; to?: unknown };
          const from = cleanText(pair.from, MAX_CORRECTION_TEXT_LENGTH);
          const to = cleanText(pair.to, MAX_CORRECTION_TEXT_LENGTH);

          return from && to ? [{ from, to }] : [];
        })
        .slice(0, 8)
    : [];
  const note = cleanText(candidate.note, MAX_NOTE_LENGTH);

  if (labelCorrections.length === 0 && !note) {
    return null;
  }

  return {
    labelCorrections,
    ...(note ? { note } : {}),
    updatedAt: typeof candidate.updatedAt === "string" && candidate.updatedAt ? candidate.updatedAt : new Date().toISOString()
  };
}

export function sanitizeAudioInsightCorrections(input: unknown): Record<string, StoredAudioInsightCorrection> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input).flatMap(([insightId, correction]) => {
      const cleanInsightId = insightId.trim();
      const sanitized = sanitizeAudioInsightCorrection(correction);

      return STORE_KEY_PATTERN.test(cleanInsightId) && sanitized ? [[cleanInsightId, sanitized]] : [];
    })
  );
}

function toUserCorrection(correction: StoredAudioInsightCorrection): AudioInsightUserCorrection {
  return {
    labelCorrections: correction.labelCorrections,
    ...(correction.note ? { note: correction.note } : {}),
    updatedAt: correction.updatedAt
  };
}

export function applyAudioInsightCorrections(
  audioInsights: AudioInsight[],
  corrections: Record<string, StoredAudioInsightCorrection>
): AudioInsight[] {
  if (Object.keys(corrections).length === 0) {
    return audioInsights;
  }

  return audioInsights.map((insight) => {
    const correction = corrections[insight.id];

    if (!correction) {
      return insight;
    }

    return {
      ...insight,
      userCorrections: [toUserCorrection(correction)]
    };
  });
}

export function correctionsFromAudioInsights(audioInsights: AudioInsight[]) {
  return Object.fromEntries(
    audioInsights.flatMap((insight) => {
      const correction = insight.userCorrections?.[0];

      if (!correction) {
        return [];
      }

      const sanitized = sanitizeAudioInsightCorrection(correction);
      return sanitized ? [[insight.id, sanitized]] : [];
    })
  );
}
