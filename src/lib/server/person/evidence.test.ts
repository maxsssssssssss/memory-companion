// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { AudioUpload, TranscriptSegment } from "@/lib/domain/types";
import {
  PersonEvidenceValidationError,
  isValidatedPersonTranscriptEvidence,
  validatePersonTranscriptEvidence
} from "./evidence";

function upload(overrides: Partial<AudioUpload> = {}): AudioUpload {
  return {
    id: "upload_1",
    originalName: "conversation.wav",
    mimeType: "audio/wav",
    sizeBytes: 1024,
    recordingDate: "2026-08-10",
    status: "ready",
    ...overrides
  };
}

function segment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: "segment_1",
    uploadId: "upload_1",
    startSeconds: 0,
    endSeconds: 4,
    speaker: "Alice",
    text: "Alice 最近喜欢摄影，也准备周末去拍照。",
    confidence: 0.96,
    sceneLabels: ["private_content"],
    valueLabels: ["notable_quote"],
    ...overrides
  };
}

function storeWith(input: { upload?: unknown; segments?: unknown } = {}) {
  const values = new Map<string, unknown>([
    ["uploads/upload_1", input.upload === undefined ? upload() : input.upload],
    ["segments/upload_1", input.segments === undefined ? [segment()] : input.segments]
  ]);
  return {
    async read<T>(collection: string, id: string) {
      return (values.get(`${collection}/${id}`) ?? null) as T | null;
    }
  };
}

function validate(
  overrides: Partial<Parameters<typeof validatePersonTranscriptEvidence>[0]> = {}
) {
  return validatePersonTranscriptEvidence({
    store: storeWith(),
    authenticatedAccountId: "account_alice",
    accountId: "account_alice",
    uploadId: "upload_1",
    sourceSegmentId: "segment_1",
    quote: "最近喜欢摄影",
    ...overrides
  });
}

async function expectCode(
  promise: Promise<unknown>,
  code: PersonEvidenceValidationError["code"]
) {
  await expect(promise).rejects.toMatchObject({
    name: "PersonEvidenceValidationError",
    code
  });
}

describe("Person Transcript Evidence validation", () => {
  it("returns a server-branded, deterministic reference to a canonical ready Transcript segment", async () => {
    const first = await validate({ quote: "Ａlice 最近喜欢摄影" });
    const second = await validate({ quote: "Alice 最近喜欢摄影" });

    expect(isValidatedPersonTranscriptEvidence(first)).toBe(true);
    expect(first).toMatchObject({
      accountId: "account_alice",
      uploadId: "upload_1",
      sourceSegmentId: "segment_1",
      quote: "Alice 最近喜欢摄影，也准备周末去拍照。"
    });
    expect(first.id).toBe(second.id);
  });

  it("rejects cross-account validation before consulting a user-scoped store", async () => {
    let reads = 0;
    await expectCode(validate({
      accountId: "account_bob",
      store: {
        async read() {
          reads += 1;
          return null;
        }
      }
    }), "account_mismatch");
    expect(reads).toBe(0);
  });

  it.each([
    ["missing upload", storeWith({ upload: null }), {}, "upload_not_found"],
    ["invalid upload", storeWith({ upload: { id: "upload_1" } }), {}, "upload_invalid"],
    ["non-ready upload", storeWith({ upload: upload({ status: "failed" }) }), {}, "upload_not_ready"],
    ["mismatched upload key", storeWith({ upload: upload({ id: "upload_other" }) }), {}, "upload_id_mismatch"],
    ["missing segment collection", storeWith({ segments: null }), {}, "segments_invalid"],
    ["unknown segment", storeWith({ segments: [segment({ id: "segment_other" })] }), {}, "segment_not_found"],
    [
      "segment from another upload",
      storeWith({ segments: [segment({ uploadId: "upload_other" })] }),
      {},
      "segment_upload_mismatch"
    ],
    ["quote outside transcript", storeWith(), { quote: "Alice 喜欢滑雪" }, "quote_mismatch"]
  ] as const)("rejects %s", async (_label, store, overrides, code) => {
    await expectCode(validate({ store, ...overrides }), code);
  });
});
