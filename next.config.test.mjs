import { describe, expect, it } from "vitest";

import nextConfig from "./next.config.mjs";

describe("Next server package configuration", () => {
  it("keeps Node runtime packages external", () => {
    expect(nextConfig.serverExternalPackages).toEqual(
      expect.arrayContaining(["better-sqlite3", "bullmq", "ffmpeg-static", "ffprobe-static", "ioredis", "ws"])
    );
  });

  it("keeps the root route available for the neutral product entry", () => {
    expect(nextConfig.redirects).toBeUndefined();
  });

  it("excludes runtime data and historical local artifacts from every server trace", () => {
    expect(nextConfig.outputFileTracingExcludes).toEqual({
      "/*": ["./.data/**/*", "./test-data/**/*", "./output/**/*", "./reports/**/*", "./tmp/**/*"]
    });
  });
});
