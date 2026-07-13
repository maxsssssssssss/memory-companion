import { describe, expect, it, vi } from "vitest";
import { createStageLogger, formatStageLog } from "./pipeline-stage-logger.mjs";

describe("pipeline stage logger", () => {
  it("formats stage logs with elapsed time and details", () => {
    expect(
      formatStageLog({
        message: "upload created",
        startedAt: 1000,
        now: 66000,
        details: { uploadId: "upload_123", progress: "25%" }
      })
    ).toBe("[validate 01:05] upload created uploadId=upload_123 progress=25%");
  });

  it("redacts sensitive URL details before printing", () => {
    expect(
      formatStageLog({
        message: "internal audio ready",
        startedAt: 0,
        now: 1000,
        details: { url: "https://example.test/api/internal/audio/u/upload?token=secret-token-value" }
      })
    ).toBe("[validate 00:01] internal audio ready url=https://example.test/api/internal/audio/u/upload?token=****");
  });

  it("writes stage logs to the provided stream", () => {
    const write = vi.fn();
    const logger = createStageLogger({
      stream: { write },
      startedAt: 0,
      now: () => 2000
    });

    logger.log("Next.js ready", { url: "http://localhost:3201" });

    expect(write).toHaveBeenCalledWith("[validate 00:02] Next.js ready url=http://localhost:3201\n");
  });
});
