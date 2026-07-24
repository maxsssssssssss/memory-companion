import { describe, expect, it } from "vitest";

import nextConfig from "./next.config.mjs";

describe("Next server package configuration", () => {
  it("keeps Node runtime packages external", () => {
    expect(nextConfig.serverExternalPackages).toEqual(
      expect.arrayContaining(["better-sqlite3", "bullmq", "ffmpeg-static", "ffprobe-static", "ioredis", "ws"])
    );
  });
});
