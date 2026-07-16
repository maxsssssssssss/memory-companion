import { describe, expect, it } from "vitest";

import nextConfig from "./next.config.mjs";

describe("Next server package configuration", () => {
  it("keeps native database, queue, and ffmpeg path packages external", () => {
    expect(nextConfig.serverExternalPackages).toEqual(
      expect.arrayContaining(["better-sqlite3", "bullmq", "ffmpeg-static", "ffprobe-static", "ioredis"])
    );
  });
});
