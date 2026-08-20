// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { AudioUpload, TranscriptSegment } from "@/lib/domain/types";
import {
  CanonicalEvidenceReferenceError,
  validateCanonicalEvidenceReference
} from "./admission-evidence";

class AdmissionTranscriptStore {
  private readonly values = new Map<string, unknown>();

  async read<T>(collection: string, id: string) {
    return (this.values.get(`${collection}/${id}`) ?? null) as T | null;
  }

  putUpload(upload: AudioUpload, segments: TranscriptSegment[]) {
    this.values.set(`uploads/${upload.id}`, upload);
    this.values.set(`segments/${upload.id}`, segments);
  }

  putSegments(uploadId: string, segments: TranscriptSegment[]) {
    this.values.set(`segments/${uploadId}`, segments);
  }
}

function upload(id: string): AudioUpload {
  return {
    id,
    originalName: `${id}.wav`,
    mimeType: "audio/wav",
    sizeBytes: 100,
    recordingDate: "2026-08-10",
    status: "ready"
  };
}

function segment(id: string, uploadId = "upload_1"): TranscriptSegment {
  return {
    id,
    uploadId,
    startSeconds: 0,
    endSeconds: 4,
    speaker: "speaker_1",
    text: "Alice explicitly discussed the museum visit.",
    confidence: 0.98,
    sceneLabels: ["private_content"],
    valueLabels: ["notable_quote"]
  };
}

describe("explicit Person admission canonical Evidence lookup", () => {
  it("rereads the server-owned segment and returns its full canonical quote", async () => {
    const store = new AdmissionTranscriptStore();
    store.putUpload(upload("upload_1"), [segment("segment_1")]);

    const evidence = await validateCanonicalEvidenceReference({
      store,
      accountId: "account_user",
      uploadId: "upload_1",
      sourceSegmentId: "segment_1"
    });

    expect(evidence).toMatchObject({
      accountId: "account_user",
      uploadId: "upload_1",
      sourceSegmentId: "segment_1",
      quote: "Alice explicitly discussed the museum visit."
    });
  });

  it("rejects missing, ambiguous, cross-upload, and invalid canonical references", async () => {
    const missing = new AdmissionTranscriptStore();
    await expect(validateCanonicalEvidenceReference({
      store: missing,
      accountId: "account_user",
      uploadId: "upload_missing",
      sourceSegmentId: "segment_missing"
    })).rejects.toMatchObject({ code: "evidence_not_found" });

    const ambiguous = new AdmissionTranscriptStore();
    ambiguous.putUpload(upload("upload_1"), [segment("segment_1"), segment("segment_1")]);
    await expect(validateCanonicalEvidenceReference({
      store: ambiguous,
      accountId: "account_user",
      uploadId: "upload_1",
      sourceSegmentId: "segment_1"
    })).rejects.toMatchObject({ code: "ambiguous_evidence" });

    const crossUpload = new AdmissionTranscriptStore();
    crossUpload.putUpload(upload("upload_1"), [segment("segment_1", "upload_other")]);
    await expect(validateCanonicalEvidenceReference({
      store: crossUpload,
      accountId: "account_user",
      uploadId: "upload_1",
      sourceSegmentId: "segment_1"
    })).rejects.toMatchObject({ code: "invalid_evidence_reference" });

    const noUpload = new AdmissionTranscriptStore();
    noUpload.putSegments("upload_1", [segment("segment_1")]);
    await expect(validateCanonicalEvidenceReference({
      store: noUpload,
      accountId: "account_user",
      uploadId: "upload_1",
      sourceSegmentId: "segment_1"
    })).rejects.toBeInstanceOf(CanonicalEvidenceReferenceError);
  });
});
