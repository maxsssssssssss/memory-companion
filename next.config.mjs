import { dirname } from "path";
import { fileURLToPath } from "url";

const projectDir = dirname(fileURLToPath(import.meta.url));
const fixtureDistDir = process.env.DAILY_BRIEF_E2E_DIST_DIR?.trim();
const fixtureTsconfig = process.env.DAILY_BRIEF_E2E_TSCONFIG?.trim();
const releaseOutputFileTracingExcludes = Object.freeze([
  "./.data/**/*",
  "./test-data/**/*",
  "./output/**/*",
  "./reports/**/*",
  "./tmp/**/*"
]);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Avoid retaining both string and Buffer copies while compiling this multi-product app.
  experimental: { webpackMemoryOptimizations: true },
  // ASR fetch URLs contain short-lived learning capabilities; omit only these
  // requests from Next's development access log. Other product logging is unchanged.
  logging: { incomingRequests: { ignore: [/^\/api\/learning\/asr-audio\//] } },
  ...(fixtureDistDir ? { distDir: fixtureDistDir } : {}),
  ...(fixtureTsconfig ? { typescript: { tsconfigPath: fixtureTsconfig } } : {}),
  outputFileTracingRoot: projectDir,
  outputFileTracingExcludes: {
    "/*": releaseOutputFileTracingExcludes
  },
  // PDF inspection runs in an isolated Node worker, beyond Webpack's imports.
  outputFileTracingIncludes: {
    "/api/learning/*": [
      "./node_modules/pdfjs-dist/package.json",
      "./node_modules/pdfjs-dist/legacy/build/*.mjs",
      "./node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
      "./node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm,iccs}/**/*",
      "./node_modules/@napi-rs/canvas*/**/*"
    ]
  },
  serverExternalPackages: ["better-sqlite3", "bullmq", "ffmpeg-static", "ffprobe-static", "ioredis", "ws", "pdfjs-dist"]
};

export default nextConfig;
