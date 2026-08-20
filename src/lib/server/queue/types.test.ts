// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildDailyReflectionQueueJobId,
  buildEmbeddingIndexQueueJobId,
  buildPipelineJobId,
  DailyReflectionQueuePayloadSchema,
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

describe("daily reflection queue payload", () => {
  it("keeps only the discriminated workflow reference and uses a stable opaque id", () => {
    const payload = DailyReflectionQueuePayloadSchema.parse({
      version: 1,
      ingestionContext: "daily_reflection",
      reflectionId: "reflection_1",
      userRef: "account_1"
    });
    const expected = createHash("sha256")
      .update("account_1\u0000reflection_1")
      .digest("hex");

    expect(payload).toEqual({
      version: 1,
      ingestionContext: "daily_reflection",
      reflectionId: "reflection_1",
      userRef: "account_1"
    });
    expect(buildDailyReflectionQueueJobId(payload))
      .toBe(`daily-reflection-${expected}`);
    expect(() => DailyReflectionQueuePayloadSchema.parse({
      ...payload,
      uploadId: "must-be-reread-from-the-plan"
    })).toThrow();
    expect(() => DailyReflectionQueuePayloadSchema.parse({
      ...payload,
      ingestionContext: "standard_upload"
    })).toThrow();
  });
});

describe("embedding index queue payload", () => {
  it("uses one stable content-free job id per user", () => {
    const payload = EmbeddingIndexQueuePayloadSchema.parse({
      version: 1,
      userRef: "user_1",
      reason: "upload_ready"
    });
    const expected = createHash("sha256").update("user_1").digest("hex");
    expect(buildEmbeddingIndexQueueJobId(payload)).toBe(`hybrid-index-${expected}`);
    expect(() => EmbeddingIndexQueuePayloadSchema.parse({
      ...payload,
      apiKey: "must-not-enter-redis"
    })).toThrow();
  });
});
