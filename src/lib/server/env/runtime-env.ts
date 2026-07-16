import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Loads the same local environment files for standalone Node entrypoints that
 * Next.js loads for the web process. Existing process environment variables
 * keep precedence, which lets PM2 inject production configuration safely.
 */
export function loadRuntimeEnv(cwd = process.cwd(), nodeEnv = process.env.NODE_ENV ?? "development") {
  const candidates = [
    `.env.${nodeEnv}.local`,
    ...(nodeEnv === "test" ? [] : [".env.local"]),
    `.env.${nodeEnv}`,
    ".env"
  ];

  for (const candidate of candidates) {
    const filePath = resolve(cwd, candidate);
    if (existsSync(filePath)) {
      process.loadEnvFile(filePath);
    }
  }
}
