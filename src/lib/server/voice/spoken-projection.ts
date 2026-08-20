const MAX_SPOKEN_PROJECTION_UTF8_BYTES = 64 * 1024;

const CITATION_RESIDUE_PATTERNS = [
  /\[\s*[EeMm][^\]]*\]/u,
  /【\s*[EeMm][^】]*】/u,
  /［\s*[EeMm][^］]*］/u,
  /\(\s*[EeMm][^)]*\)/u,
  /（\s*[EeMm][^）]*）/u,
  /\b[EM]\s*\d+\b/u,
  /(?:引用|证据|记忆记录|memory record|evidence)\s*(?:编号\s*)?(?:[EM]\d+|#\s*\d+)/iu
] as const;

const SERIALIZED_METADATA_PATTERN =
  /["']?(?:citations?|citedSegmentIds|sourceIds?|source[_-]?ids?|metadata)["']?\s*[:=]/iu;
const UNSUPPORTED_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

export type SpokenProjectionFailureReason =
  | "empty_text"
  | "citation_residue"
  | "metadata_residue"
  | "unsupported_characters"
  | "text_too_long";

export class SpokenProjectionError extends Error {
  constructor(readonly reason: SpokenProjectionFailureReason) {
    super(`Voice spoken projection is not TTS-safe: ${reason}`);
    this.name = "SpokenProjectionError";
  }
}

export type SpokenProjection = string & {
  readonly __spokenProjection: unique symbol;
};

function containsUnpairedSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/**
 * Final fail-closed boundary immediately before Provider TTS.
 *
 * The canonical answer and its citation metadata remain outside this value.
 * This function validates presentation output only and never rewrites content.
 */
export function requireSpokenProjection(value: string): SpokenProjection {
  const normalized = value.trim();
  if (!normalized) throw new SpokenProjectionError("empty_text");
  if (CITATION_RESIDUE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw new SpokenProjectionError("citation_residue");
  }
  if (SERIALIZED_METADATA_PATTERN.test(normalized)) {
    throw new SpokenProjectionError("metadata_residue");
  }
  if (
    UNSUPPORTED_CONTROL_PATTERN.test(normalized) ||
    containsUnpairedSurrogate(normalized)
  ) {
    throw new SpokenProjectionError("unsupported_characters");
  }
  if (Buffer.byteLength(normalized, "utf8") > MAX_SPOKEN_PROJECTION_UTF8_BYTES) {
    throw new SpokenProjectionError("text_too_long");
  }
  return normalized as SpokenProjection;
}
