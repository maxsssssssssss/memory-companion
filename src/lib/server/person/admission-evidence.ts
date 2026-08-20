import { z } from "zod";
import { TranscriptSegmentSchema } from "@/lib/domain/types";
import type { JsonStore } from "@/lib/server/storage/json-store";
import { validatePersonTranscriptEvidence } from "./evidence";

export type CanonicalEvidenceReferenceErrorCode =
  | "evidence_not_found"
  | "ambiguous_evidence"
  | "invalid_evidence_reference";

export class CanonicalEvidenceReferenceError extends Error {
  constructor(
    readonly code: CanonicalEvidenceReferenceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CanonicalEvidenceReferenceError";
  }
}

export async function validateCanonicalEvidenceReference(input: {
  store: Pick<JsonStore, "read">;
  accountId: string;
  uploadId: string;
  sourceSegmentId: string;
}) {
  const rawSegments = await input.store.read<unknown>("segments", input.uploadId);
  if (rawSegments === null) {
    throw new CanonicalEvidenceReferenceError(
      "evidence_not_found",
      "Canonical Transcript Evidence was not found"
    );
  }
  const segments = z.array(TranscriptSegmentSchema).safeParse(rawSegments);
  if (!segments.success) {
    throw new CanonicalEvidenceReferenceError(
      "invalid_evidence_reference",
      "Canonical Transcript segments are invalid"
    );
  }
  const matches = segments.data.filter((segment) => segment.id === input.sourceSegmentId);
  if (matches.length === 0) {
    throw new CanonicalEvidenceReferenceError(
      "evidence_not_found",
      "Canonical Transcript segment was not found"
    );
  }
  if (matches.length !== 1) {
    throw new CanonicalEvidenceReferenceError(
      "ambiguous_evidence",
      "Canonical Transcript segment reference is ambiguous"
    );
  }
  try {
    return await validatePersonTranscriptEvidence({
      store: input.store,
      authenticatedAccountId: input.accountId,
      accountId: input.accountId,
      uploadId: input.uploadId,
      sourceSegmentId: input.sourceSegmentId,
      quote: matches[0].text
    });
  } catch (error) {
    if (
      error instanceof Error &&
      ["upload_not_found", "segment_not_found"].includes(
        (error as { code?: string }).code ?? ""
      )
    ) {
      throw new CanonicalEvidenceReferenceError(
        "evidence_not_found",
        "Canonical Transcript Evidence was not found"
      );
    }
    throw new CanonicalEvidenceReferenceError(
      "invalid_evidence_reference",
      "Canonical Transcript Evidence failed server validation"
    );
  }
}
