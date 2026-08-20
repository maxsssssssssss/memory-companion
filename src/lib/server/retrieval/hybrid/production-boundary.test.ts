import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FORMAL_RETRIEVAL_AND_QA_FILES = [
  "src/lib/server/retrieval/memory-scope-qa.ts",
  "src/lib/server/voice-qa/adapter.ts",
  "src/lib/server/voice-qa/bridge.ts",
  "src/app/api/voice/qa/route.ts"
] as const;

describe("Hybrid production boundary", () => {
  it("allows only the shared AI QA core to consume Hybrid candidates", async () => {
    const sources = await Promise.all(
      FORMAL_RETRIEVAL_AND_QA_FILES.map(async (path) => ({
        path,
        source: await readFile(resolve(path), "utf8")
      }))
    );

    for (const { path, source } of sources) {
      expect(
        source,
        `${path} must not consume shadow Hybrid candidates`
      ).not.toMatch(/from\s+["'][^"']*retrieval\/hybrid(?:\/|["'])/u);
      expect(
        source,
        `${path} must not consume the frozen Phase 3.1 shadow baseline`
      ).not.toContain("HYBRID_PHASE31_SHADOW_V1");
    }

    const sharedQaSource = await readFile(
      resolve("src/lib/server/retrieval/ai-qa.ts"),
      "utf8"
    );
    expect(sharedQaSource).toContain("./hybrid/runtime-config");
    expect(sharedQaSource).toContain("./hybrid/production-retrieval");
    expect(sharedQaSource).not.toContain("HYBRID_PHASE31_SHADOW_V1");
  });
});
