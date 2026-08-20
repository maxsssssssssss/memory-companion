import { dirname } from "path";
import { fileURLToPath } from "url";

const projectDir = dirname(fileURLToPath(import.meta.url));
const fixtureDistDir = process.env.DAILY_BRIEF_E2E_DIST_DIR?.trim();
const fixtureTsconfig = process.env.DAILY_BRIEF_E2E_TSCONFIG?.trim();

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(fixtureDistDir ? { distDir: fixtureDistDir } : {}),
  ...(fixtureTsconfig ? { typescript: { tsconfigPath: fixtureTsconfig } } : {}),
  outputFileTracingRoot: projectDir,
  serverExternalPackages: ["better-sqlite3", "bullmq", "ffmpeg-static", "ffprobe-static", "ioredis", "ws"],
  async redirects() {
    return [
      {
        source: "/",
        destination: "/date-companion",
        permanent: false
      }
    ];
  }
};

export default nextConfig;
