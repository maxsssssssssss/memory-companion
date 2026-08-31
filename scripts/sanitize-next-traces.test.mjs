import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeNextTraceManifests } from "./sanitize-next-traces.mjs";

async function writeManifest(manifestPath, files) {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({ version: 1, files }), "utf8");
}

describe("sanitizeNextTraceManifests", () => {
  it("removes only project runtime and evaluation data from every Next trace", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "daily-brief-next-trace-"));

    try {
      const routeManifest = path.join(
        projectDir,
        ".next",
        "server",
        "app",
        "api",
        "route.js.nft.json"
      );
      const serverManifest = path.join(projectDir, ".next", "next-server.js.nft.json");
      const runtimeData = path.join(projectDir, ".data", "memory.sqlite");
      const evaluationData = path.join(projectDir, "test-data", "fixture.json");
      const dependencyTestData = path.join(
        projectDir,
        "node_modules",
        "example-package",
        "test-data",
        "safe.json"
      );
      const safeDependency = path.join(projectDir, "node_modules", "example-package", "index.js");

      const routeFiles = [runtimeData, evaluationData, dependencyTestData, safeDependency]
        .map((file) => path.relative(path.dirname(routeManifest), file));
      const serverFiles = [runtimeData, evaluationData, dependencyTestData]
        .map((file) => path.relative(path.dirname(serverManifest), file));

      await writeManifest(routeManifest, routeFiles);
      await writeManifest(serverManifest, serverFiles);

      const result = await sanitizeNextTraceManifests({ projectDir });

      expect(result).toEqual({
        manifestCount: 2,
        entriesBefore: 7,
        removed: 4,
        forbiddenAfter: 0
      });
      const routeTrace = JSON.parse(await readFile(routeManifest, "utf8"));
      const serverTrace = JSON.parse(await readFile(serverManifest, "utf8"));
      expect(routeTrace.files).toEqual([routeFiles[2], routeFiles[3]]);
      expect(serverTrace.files).toEqual([serverFiles[2]]);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
