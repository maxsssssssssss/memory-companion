export type DiarizationResultSource = "combined_asr" | "standalone_diarization";

export type VoiceprintSmokeDiarizationSource =
  | "combined_asr"
  | "fallback_diarization_api";

export type CanonicalSpeakerResultItem = {
  speaker: string;
  text: string;
};

export type CanonicalSpeakerResult = {
  speaker_result: CanonicalSpeakerResultItem[];
};

export type VoiceprintDiarizationAcquisition = {
  diarizationSource: VoiceprintSmokeDiarizationSource;
  speakerResultAvailable: boolean;
  voiceprintStage: "executed" | "blocked";
  failureReason?: "diarization_gate_missing_speaker_result";
  canonical: CanonicalSpeakerResult;
};

export type DiarizationTimestampPoint = {
  start: number;
  end: number;
};

export type StandaloneDiarizationSentence = {
  text: string;
  timestamps: DiarizationTimestampPoint | DiarizationTimestampPoint[];
};

export type ParsedDiarizationLabels = {
  source: DiarizationResultSource;
  resultCount: number;
  validLabelEntryCount: number;
  labels: string[];
};

export type CombinedDiarizationQualityGate = {
  passed: boolean;
  reason:
    | "passed"
    | "missing_speaker_result"
    | "unexpected_speaker_count"
    | "speaker_without_text"
    | "required_speaker_missing";
  expectedSpeakerCount: number;
  uniqueSpeakerCount: number;
  speakersWithTextCount: number;
  emptyTextSpeakerCount: number;
  labels: string[];
};

export type DiarizationResponseShapeSummary = {
  topLevelFields: string[];
  dataFields: string[];
  asrResultFields: string[];
  sentenceCount: number;
  combinedSpeakerResultCount: number;
  standaloneResultCount: number;
};

export type DiarizationInputErrorCode =
  | "asr_sentences_missing"
  | "asr_sentence_text_missing"
  | "asr_sentence_timestamps_missing"
  | "asr_sentence_timestamps_invalid";

export class DiarizationEvaluationInputError extends Error {
  constructor(
    readonly code: DiarizationInputErrorCode,
    readonly sentenceIndex?: number
  ) {
    super(
      sentenceIndex === undefined
        ? code
        : `${code} at sentence index ${sentenceIndex}`
    );
    this.name = "DiarizationEvaluationInputError";
  }
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function objectFields(value: unknown) {
  return Object.keys(asRecord(value) ?? {}).sort();
}

function arrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function normalizeSpeakerLabel(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim();
  return normalized || undefined;
}

function canonicalizeSpeakerResults(
  payload: unknown,
  resultField: "speaker_result" | "result"
): CanonicalSpeakerResult {
  const data = asRecord(asRecord(payload)?.data);
  const rawResults = Array.isArray(data?.[resultField])
    ? data[resultField]
    : [];
  const speakerResult: CanonicalSpeakerResultItem[] = [];

  for (const rawResult of rawResults) {
    const result = asRecord(rawResult);
    const speaker = normalizeSpeakerLabel(result?.speaker);
    if (!speaker) continue;
    speakerResult.push({
      speaker,
      text: typeof result?.text === "string" ? result.text.trim() : ""
    });
  }

  return { speaker_result: speakerResult };
}

/**
 * Selects the first documented diarization result and converts both Provider
 * response shapes to the same `{ speaker_result: [{ speaker, text }] }`
 * contract. The Provider does not return per-speaker time boundaries, so this
 * adapter deliberately does not invent `start` or `end` values.
 */
export async function acquireCanonicalSpeakerResult(input: {
  combinedPayload: unknown;
  requestFallback: () => Promise<unknown>;
}): Promise<VoiceprintDiarizationAcquisition> {
  const combined = canonicalizeSpeakerResults(
    input.combinedPayload,
    "speaker_result"
  );
  if (combined.speaker_result.length > 0) {
    return {
      diarizationSource: "combined_asr",
      speakerResultAvailable: true,
      voiceprintStage: "executed",
      canonical: combined
    };
  }

  const fallbackPayload = await input.requestFallback();
  const fallback = canonicalizeSpeakerResults(fallbackPayload, "result");
  if (fallback.speaker_result.length > 0) {
    return {
      diarizationSource: "fallback_diarization_api",
      speakerResultAvailable: true,
      voiceprintStage: "executed",
      canonical: fallback
    };
  }

  return {
    diarizationSource: "fallback_diarization_api",
    speakerResultAvailable: false,
    voiceprintStage: "blocked",
    failureReason: "diarization_gate_missing_speaker_result",
    canonical: fallback
  };
}

function parseLabels(
  payload: unknown,
  source: DiarizationResultSource
): ParsedDiarizationLabels {
  const data = asRecord(asRecord(payload)?.data);
  const rawResults = source === "combined_asr"
    ? data?.speaker_result
    : data?.result;
  const results = Array.isArray(rawResults) ? rawResults : [];
  const labels: string[] = [];
  let validLabelEntryCount = 0;

  for (const result of results) {
    const label = normalizeSpeakerLabel(asRecord(result)?.speaker);
    if (!label) continue;
    validLabelEntryCount += 1;
    if (!labels.includes(label)) labels.push(label);
  }

  return {
    source,
    resultCount: results.length,
    validLabelEntryCount,
    labels
  };
}

function parseTimestampPoint(value: unknown): DiarizationTimestampPoint | undefined {
  const point = asRecord(value);
  const start = point?.start;
  const end = point?.end;
  if (
    typeof start !== "number" ||
    !Number.isFinite(start) ||
    start < 0 ||
    typeof end !== "number" ||
    !Number.isFinite(end) ||
    end < start
  ) {
    return undefined;
  }
  return { start, end };
}

function normalizeTimestamps(
  sentence: UnknownRecord,
  sentenceIndex: number
): DiarizationTimestampPoint | DiarizationTimestampPoint[] {
  const rawTimestamps = sentence.timestamp ?? sentence.timestamps;
  if (rawTimestamps === undefined || rawTimestamps === null) {
    throw new DiarizationEvaluationInputError(
      "asr_sentence_timestamps_missing",
      sentenceIndex
    );
  }

  if (Array.isArray(rawTimestamps)) {
    if (rawTimestamps.length === 0) {
      throw new DiarizationEvaluationInputError(
        "asr_sentence_timestamps_invalid",
        sentenceIndex
      );
    }
    const timestamps = rawTimestamps.map(parseTimestampPoint);
    if (timestamps.some((point) => point === undefined)) {
      throw new DiarizationEvaluationInputError(
        "asr_sentence_timestamps_invalid",
        sentenceIndex
      );
    }
    return timestamps as DiarizationTimestampPoint[];
  }

  const timestamp = parseTimestampPoint(rawTimestamps);
  if (!timestamp) {
    throw new DiarizationEvaluationInputError(
      "asr_sentence_timestamps_invalid",
      sentenceIndex
    );
  }
  return timestamp;
}

export function parseCombinedAsrSpeakerLabels(
  payload: unknown
): ParsedDiarizationLabels {
  return parseLabels(payload, "combined_asr");
}

export function parseStandaloneDiarizationLabels(
  payload: unknown
): ParsedDiarizationLabels {
  return parseLabels(payload, "standalone_diarization");
}

/**
 * Evaluates the strict gate used before a real Voiceprint mutation. The
 * returned audit contains labels and counts only; transcript text is never
 * copied into the result.
 */
export function evaluateCombinedDiarizationQualityGate(
  payload: unknown,
  input: {
    expectedSpeakerCount: number;
    requiredSpeakerLabel?: string;
  }
): CombinedDiarizationQualityGate {
  const data = asRecord(asRecord(payload)?.data);
  const results = Array.isArray(data?.speaker_result)
    ? data.speaker_result
    : [];
  const textPresenceByLabel = new Map<string, boolean>();

  for (const result of results) {
    const record = asRecord(result);
    const label = normalizeSpeakerLabel(record?.speaker);
    if (!label) continue;
    const hasText =
      typeof record?.text === "string" && record.text.trim().length > 0;
    textPresenceByLabel.set(
      label,
      (textPresenceByLabel.get(label) ?? false) || hasText
    );
  }

  const labels = [...textPresenceByLabel.keys()];
  const speakersWithTextCount = [...textPresenceByLabel.values()].filter(Boolean).length;
  const requiredSpeakerLabel = normalizeSpeakerLabel(input.requiredSpeakerLabel);
  let reason: CombinedDiarizationQualityGate["reason"] = "passed";

  if (results.length === 0 || labels.length === 0) {
    reason = "missing_speaker_result";
  } else if (labels.length !== input.expectedSpeakerCount) {
    reason = "unexpected_speaker_count";
  } else if (speakersWithTextCount !== labels.length) {
    reason = "speaker_without_text";
  } else if (
    requiredSpeakerLabel &&
    !textPresenceByLabel.has(requiredSpeakerLabel)
  ) {
    reason = "required_speaker_missing";
  }

  return {
    passed: reason === "passed",
    reason,
    expectedSpeakerCount: input.expectedSpeakerCount,
    uniqueSpeakerCount: labels.length,
    speakersWithTextCount,
    emptyTextSpeakerCount: labels.length - speakersWithTextCount,
    labels
  };
}

/**
 * Projects completed ASR sentences into the only fields accepted by the
 * evaluation-only standalone diarization request. It does not retain any
 * ASR metadata beyond the text and timestamps required by that API.
 */
export function buildStandaloneDiarizationSentences(
  asrPayload: unknown
): StandaloneDiarizationSentence[] {
  const data = asRecord(asRecord(asrPayload)?.data);
  const asrResult = asRecord(data?.asr_result);
  const sentences = asrResult?.sentences;
  if (!Array.isArray(sentences) || sentences.length === 0) {
    throw new DiarizationEvaluationInputError("asr_sentences_missing");
  }

  return sentences.map((rawSentence, sentenceIndex) => {
    const sentence = asRecord(rawSentence);
    const text = typeof sentence?.text === "string"
      ? sentence.text.trim()
      : "";
    if (!sentence || !text) {
      throw new DiarizationEvaluationInputError(
        "asr_sentence_text_missing",
        sentenceIndex
      );
    }

    return {
      text,
      timestamps: normalizeTimestamps(sentence, sentenceIndex)
    };
  });
}

/**
 * Returns structural diagnostics only. Transcript text, speaker labels,
 * messages, response bodies, audio data, and provider-private values are
 * deliberately excluded.
 */
export function summarizeDiarizationResponseShape(
  payload: unknown
): DiarizationResponseShapeSummary {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const asrResult = asRecord(data?.asr_result);

  return {
    topLevelFields: objectFields(root),
    dataFields: objectFields(data),
    asrResultFields: objectFields(asrResult),
    sentenceCount: arrayLength(asrResult?.sentences),
    combinedSpeakerResultCount: arrayLength(data?.speaker_result),
    standaloneResultCount: arrayLength(data?.result)
  };
}
