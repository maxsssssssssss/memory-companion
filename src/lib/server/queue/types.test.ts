// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildEmbeddingIndexQueueJobId,
  buildEmbeddingIndexQueueJobIds,
  buildPipelineJobId,
  EmbeddingIndexQueuePayloadSchema,
  PipelineJobDataSchema
} from "./types";

describe("pipeline queue payload", () => {
  it("contains only the version and opaque upload/user references", () => {
    expect(
      PipelineJobDataSchema.parse({ version: 1, uploadId: "upload_1", userRef: "user_1" })
    ).toEqual({ version: 1, uploadId: "upload_1", userRef: "user_1" });
    expect(() =>
      PipelineJobDataSchema.parse({
        version: 1,
        uploadId: "upload_1",
        userRef: "user_1",
        apiKey: "must-not-enter-redis"
      })
    ).toThrow();
  });

  it("uses the required stable sha256 user-plus-upload id", () => {
    const expected = createHash("sha256").update("user_1upload_1").digest("hex");
    expect(buildPipelineJobId({ version: 1, userRef: "user_1", uploadId: "upload_1" })).toBe(
      `pipeline-${expected}`
    );
    expect(buildPipelineJobId({ version: 1, userRef: "user_1", uploadId: "upload_2" })).not.toBe(
      `pipeline-${expected}`
    );
  });
});

describe("embedding index queue payload", () => {
  it("uses two stable, content-free coalescing slots per user", () => {
    const payload = EmbeddingIndexQueuePayloadSchema.parse({
      version: 1,
      userRef: "user_1",
      reason: "speaker_aliases"
    });
    const expected = createHash("sha256").update("user_1").digest("hex");
    expect(buildEmbeddingIndexQueueJobId(payload)).toBe(`hybrid-index-${expected}-0`);
    expect(buildEmbeddingIndexQueueJobIds(payload)).toEqual([
      `hybrid-index-${expected}-0`,
      `hybrid-index-${expected}-1`
    ]);
    expect(() => EmbeddingIndexQueuePayloadSchema.parse({
      ...payload,
      apiKey: "must-not-enter-redis"
    })).toThrow();
  });
});
