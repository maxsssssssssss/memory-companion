import { createHash } from "node:crypto";

export const DC_EVIDENCE_PROVENANCE_VERSION = 1;
export const DC_EVIDENCE_SOURCE_KIND = "date_companion_recap" as const;
export const DC_MEMORY_PROJECTION_VERSION = 2;

export function dateCompanionMemoryProjectionIdempotencyKey(idempotencyKey: string) {
  return `${idempotencyKey}:memory-projection:v${DC_MEMORY_PROJECTION_VERSION}`;
}

export function isDateCompanionMemoryProjectionIdempotencyKey(idempotencyKey: string) {
  return idempotencyKey.endsWith(`:memory-projection:v${DC_MEMORY_PROJECTION_VERSION}`);
}

function normalizedText(value: string) {
  return value.normalize("NFKC").replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
}

export function dateCompanionEvidenceDigest(input: {
  userId: string;
  uploadId: string;
  sourceSegmentId: string;
  startSeconds: number;
  endSeconds: number;
  speakerId?: string | null;
  quote: string;
}) {
  return createHash("sha256").update(JSON.stringify({
    provenanceVersion: DC_EVIDENCE_PROVENANCE_VERSION,
    sourceKind: DC_EVIDENCE_SOURCE_KIND,
    userId: input.userId,
    uploadId: input.uploadId,
    sourceSegmentId: input.sourceSegmentId,
    startSeconds: input.startSeconds,
    endSeconds: input.endSeconds,
    speakerId: input.speakerId?.normalize("NFKC").trim() || null,
    quote: normalizedText(input.quote)
  })).digest("hex");
}

export function stableBridgeDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
