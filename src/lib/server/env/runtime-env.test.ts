// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeEnv } from "./runtime-env";

const touched = new Set<string>();

afterEach(async () => {
  for (const entry of touched) {
    delete process.env[entry];
  }
  touched.clear();
});

describe("loadRuntimeEnv", () => {
  it("loads .env.local without overriding PM2-provided variables", async () => {
    const root = await mkdtemp(join(tmpdir(), "daily-brief-runtime-env-"));
    touched.add("QUEUE_ENV_FROM_FILE");
    touched.add("QUEUE_ENV_FROM_PM2");
    process.env.QUEUE_ENV_FROM_PM2 = "pm2";
    try {
      await writeFile(
        join(root, ".env.local"),
        "QUEUE_ENV_FROM_FILE=local\nQUEUE_ENV_FROM_PM2=file\n",
        "utf8"
      );

      loadRuntimeEnv(root, "development");

      expect(process.env.QUEUE_ENV_FROM_FILE).toBe("local");
      expect(process.env.QUEUE_ENV_FROM_PM2).toBe("pm2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
