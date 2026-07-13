import { dirname } from "path";
import { fileURLToPath } from "url";

const projectDir = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: projectDir,
  serverExternalPackages: ["better-sqlite3", "ffmpeg-static", "ffprobe-static"]
};

export default nextConfig;
