import { dirname } from "path";
import { fileURLToPath } from "url";

const projectDir = dirname(fileURLToPath(import.meta.url));
const fixtureDistDir = process.env.DAILY_BRIEF_E2E_DIST_DIR?.trim();
const fixtureTsconfig = process.env.DAILY_BRIEF_E2E_TSCONFIG?.trim();
const releaseOutputFileTracingExcludes = Object.freeze([
  "./.data/**/*",
  "./test-data/**/*"
]);

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(fixtureDistDir ? { distDir: fixtureDistDir } : {}),
  ...(fixtureTsconfig ? { typescript: { tsconfigPath: fixtureTsconfig } } : {}),
  outputFileTracingRoot: projectDir,
  outputFileTracingExcludes: {
    "/*": releaseOutputFileTracingExcludes
  },
  serverExternalPackages: ["better-sqlite3", "bullmq", "ffmpeg-static", "ffprobe-static", "ioredis", "ws"]
};

export default nextConfig;
