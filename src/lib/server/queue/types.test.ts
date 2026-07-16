// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildPipelineJobId, PipelineJobDataSchema } from "./types";

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
