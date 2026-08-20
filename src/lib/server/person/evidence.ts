import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AudioUploadSchema,
  TranscriptSegmentSchema,
  type TranscriptSegment
} from "@/lib/domain/types";
import type { JsonStore } from "@/lib/server/storage/json-store";

const VALIDATED_PERSON_EVIDENCE = Symbol("validated-person-transcript-evidence");
const RecordIdSchema = z.string().trim().min(1).max(512);

export type PersonEvidenceValidationErrorCode =
  | "account_mismatch"
  | "upload_not_found"
  | "upload_invalid"
  | "upload_not_ready"
  | "upload_id_mismatch"
  | "segments_invalid"
  | "segment_not_found"
  | "segment_upload_mismatch"
  | "quote_mismatch";

export class PersonEvidenceValidationError extends Error {
  constructor(
    readonly code: PersonEvidenceValidationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PersonEvidenceValidationError";
  }
}

export type ValidatedPersonTranscriptEvidence = {
  readonly [VALIDATED_PERSON_EVIDENCE]: true;
  id: string;
  accountId: string;
  uploadId: string;
  sourceSegmentId: string;
  quote: string;
  segment: TranscriptSegment;
};

export type ValidatePersonTranscriptEvidenceInput = {
  store: Pick<JsonStore, "read">;
  authenticatedAccountId: string;
  accountId: string;
  uploadId: string;
  sourceSegmentId: string;
  quote: string;
};

function normalizeEvidenceText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/\s+/gu, " ")
    .trim();
}

function evidenceId(accountId: string, uploadId: string, sourceSegmentId: string) {
  const digest = createHash("sha256")
    .update(`${accountId}\u0000${uploadId}\u0000${sourceSegmentId}`)
    .digest("hex")
    .slice(0, 32);
  return `person_evidence_${digest}`;
}

function parseRecordId(value: string, field: string) {
  const parsed = RecordIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new PersonEvidenceValidationError("segments_invalid", `Invalid ${field}`);
  }
  return parsed.data;
}

export function isValidatedPersonTranscriptEvidence(
  value: unknown
): value is ValidatedPersonTranscriptEvidence {
  return Boolean(
    value &&
    typeof value === "object" &&
    VALIDATED_PERSON_EVIDENCE in value &&
    (value as Record<PropertyKey, unknown>)[VALIDATED_PERSON_EVIDENCE] === true
  );
}

export function assertValidatedPersonTranscriptEvidence(
  value: unknown
): asserts value is ValidatedPersonTranscriptEvidence {
  if (!isValidatedPersonTranscriptEvidence(value)) {
    throw new PersonEvidenceValidationError(
      "segments_invalid",
      "Person evidence must be validated against the authenticated Transcript store"
    );
  }
}

export async function validatePersonTranscriptEvidence(
  input: ValidatePersonTranscriptEvidenceInput
): Promise<ValidatedPersonTranscriptEvidence> {
  const authenticatedAccountId = parseRecordId(input.authenticatedAccountId, "authenticated account id");
  const accountId = parseRecordId(input.accountId, "account id");
  const uploadId = parseRecordId(input.uploadId, "upload id");
  const sourceSegmentId = parseRecordId(input.sourceSegmentId, "source segment id");

  if (authenticatedAccountId !== accountId) {
    throw new PersonEvidenceValidationError(
      "account_mismatch",
      "Authenticated account cannot validate another account's Transcript evidence"
    );
  }

  const rawUpload = await input.store.read<unknown>("uploads", uploadId);
  if (rawUpload === null) {
    throw new PersonEvidenceValidationError("upload_not_found", "Transcript upload was not found");
  }
  const upload = AudioUploadSchema.safeParse(rawUpload);
  if (!upload.success) {
    throw new PersonEvidenceValidationError("upload_invalid", "Transcript upload record is invalid");
  }
  if (upload.data.id !== uploadId) {
    throw new PersonEvidenceValidationError("upload_id_mismatch", "Transcript upload id does not match its store key");
  }
  if (upload.data.status !== "ready") {
    throw new PersonEvidenceValidationError("upload_not_ready", "Only a ready Transcript upload can support Person facts");
  }

  const rawSegments = await input.store.read<unknown>("segments", uploadId);
  const segments = z.array(TranscriptSegmentSchema).safeParse(rawSegments);
  if (!segments.success) {
    throw new PersonEvidenceValidationError("segments_invalid", "Transcript segments are missing or invalid");
  }
  const segment = segments.data.find((candidate) => candidate.id === sourceSegmentId);
  if (!segment) {
    throw new PersonEvidenceValidationError("segment_not_found", "Transcript segment was not found in the upload");
  }
  if (segment.uploadId !== uploadId) {
    throw new PersonEvidenceValidationError(
      "segment_upload_mismatch",
      "Transcript segment does not belong to the requested upload"
    );
  }

  const quote = normalizeEvidenceText(input.quote);
  const sourceText = normalizeEvidenceText(segment.text);
  const canonicalQuote = segment.text.trim();
  if (!quote || !canonicalQuote || canonicalQuote.length > 4_000 || !sourceText.includes(quote)) {
    throw new PersonEvidenceValidationError(
      "quote_mismatch",
      "Person evidence quote must be a non-empty excerpt of the canonical Transcript segment"
    );
  }

  return {
    [VALIDATED_PERSON_EVIDENCE]: true,
    id: evidenceId(accountId, uploadId, sourceSegmentId),
    accountId,
    uploadId,
    sourceSegmentId,
    quote: canonicalQuote,
    segment
  };
}
