import type { AudioInsight, BriefItem, SemanticSegment, SpeakerAliasesByUploadId, SpeakerAliasMap, TranscriptSegment } from "./types";

const speakerAliasKeyPattern = /^[A-Za-z0-9_-]+$/;
const maxAliasLength = 40;

type AliasablePayload = {
  segments: TranscriptSegment[];
  audioInsights?: AudioInsight[];
  semanticSegments?: SemanticSegment[];
  briefItems: BriefItem[];
};

export type StoredSpeakerAliases = {
  aliases: SpeakerAliasMap;
  updatedAt: string;
};

export type SpeakerAliasLookup = SpeakerAliasMap | SpeakerAliasesByUploadId;

export function sanitizeSpeakerAliases(input: unknown): SpeakerAliasMap {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input)
      .map(([speakerId, alias]) => [speakerId.trim(), typeof alias === "string" ? alias.trim() : ""])
      .filter(([speakerId, alias]) => speakerAliasKeyPattern.test(speakerId) && alias.length > 0)
      .map(([speakerId, alias]) => [speakerId, alias.slice(0, maxAliasLength)])
  );
}

export function speakerDisplayName(speakerId: string | undefined, aliases: SpeakerAliasMap) {
  if (!speakerId) {
    return speakerId;
  }

  return aliases[speakerId] ?? speakerId;
}

export function sanitizeSpeakerAliasesByUploadId(input: unknown): SpeakerAliasesByUploadId {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input)
      .map(([uploadId, aliases]): [string, SpeakerAliasMap] => [uploadId.trim(), sanitizeSpeakerAliases(aliases)])
      .filter(([uploadId, aliases]) => speakerAliasKeyPattern.test(uploadId) && Object.keys(aliases).length > 0)
  );
}

function isAliasesByUploadId(aliases: SpeakerAliasLookup): aliases is SpeakerAliasesByUploadId {
  return Object.values(aliases).some((value) => Boolean(value) && typeof value === "object" && !Array.isArray(value));
}

export function aliasesForUpload(uploadId: string, aliases: SpeakerAliasLookup): SpeakerAliasMap {
  if (isAliasesByUploadId(aliases)) {
    return sanitizeSpeakerAliases(aliases[uploadId] ?? {});
  }

  return sanitizeSpeakerAliases(aliases);
}

export function speakerAliasForUpload(uploadId: string, speakerId: string | undefined, aliases: SpeakerAliasLookup) {
  if (!speakerId) {
    return undefined;
  }

  return aliasesForUpload(uploadId, aliases)[speakerId];
}

export function speakerDisplayNameForUpload(uploadId: string, speakerId: string | undefined, aliases: SpeakerAliasLookup) {
  return speakerAliasForUpload(uploadId, speakerId, aliases) ?? speakerId;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function replaceSpeakerIdsForUpload(uploadId: string, text: string, aliases: SpeakerAliasLookup) {
  return Object.entries(aliasesForUpload(uploadId, aliases))
    .sort(([leftId], [rightId]) => rightId.length - leftId.length)
    .reduce((nextText, [speakerId, alias]) => nextText.replace(new RegExp(`${escapeRegExp(speakerId)}(?![A-Za-z0-9_-])`, "g"), alias), text);
}

export function applySpeakerAliasesToPayload<T extends AliasablePayload>(payload: T, aliases: SpeakerAliasLookup): T {
  const hasAliases = isAliasesByUploadId(aliases) ? Object.keys(sanitizeSpeakerAliasesByUploadId(aliases)).length > 0 : Object.keys(sanitizeSpeakerAliases(aliases)).length > 0;

  if (!hasAliases) {
    return payload;
  }

  return {
    ...payload,
    segments: payload.segments,
    audioInsights: (payload.audioInsights ?? []).map((insight) => ({
      ...insight,
      speaker: {
        ...insight.speaker,
        displayName: speakerAliasForUpload(insight.uploadId, insight.speaker.id, aliases) ?? insight.speaker.displayName
      },
      summary: replaceSpeakerIdsForUpload(insight.uploadId, insight.summary, aliases),
      evidence: replaceSpeakerIdsForUpload(insight.uploadId, insight.evidence, aliases)
    })),
    semanticSegments: (payload.semanticSegments ?? []).map((segment) => ({
      ...segment,
      title: replaceSpeakerIdsForUpload(segment.uploadId, segment.title, aliases),
      summary: replaceSpeakerIdsForUpload(segment.uploadId, segment.summary, aliases),
      transcriptExcerpt: replaceSpeakerIdsForUpload(segment.uploadId, segment.transcriptExcerpt, aliases)
    })),
    briefItems: payload.briefItems.map((item) => ({
      ...item,
      title: replaceSpeakerIdsForUpload(item.uploadId, item.title, aliases),
      body: replaceSpeakerIdsForUpload(item.uploadId, item.body, aliases),
      transcriptExcerpt: replaceSpeakerIdsForUpload(item.uploadId, item.transcriptExcerpt, aliases),
      people: item.people.map((person) => speakerAliasForUpload(item.uploadId, person, aliases) ?? person)
    }))
  };
}

export function collectSpeakerIds(payload: Pick<AliasablePayload, "segments" | "audioInsights">) {
  return [
    ...new Set(
      [
        ...payload.segments.map((segment) => segment.speaker),
        ...(payload.audioInsights ?? []).map((insight) => insight.speaker.id)
      ].filter((speakerId): speakerId is string => typeof speakerId === "string" && /^speaker_/i.test(speakerId))
    )
  ].sort((a, b) => a.localeCompare(b, "en"));
}

export function collectSpeakerAliasTargets(payload: Pick<AliasablePayload, "segments" | "audioInsights">) {
  const byKey = new Map<string, { uploadId: string; speakerId: string }>();

  payload.segments.forEach((segment) => {
    if (typeof segment.speaker === "string" && /^speaker_/i.test(segment.speaker)) {
      byKey.set(`${segment.uploadId}:${segment.speaker}`, { uploadId: segment.uploadId, speakerId: segment.speaker });
    }
  });
  (payload.audioInsights ?? []).forEach((insight) => {
    if (/^speaker_/i.test(insight.speaker.id)) {
      byKey.set(`${insight.uploadId}:${insight.speaker.id}`, { uploadId: insight.uploadId, speakerId: insight.speaker.id });
    }
  });

  return [...byKey.values()].sort(
    (left, right) => left.uploadId.localeCompare(right.uploadId, "en") || left.speakerId.localeCompare(right.speakerId, "en")
  );
}
