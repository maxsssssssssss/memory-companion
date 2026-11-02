import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sanitizeNextTraceManifests } from "./sanitize-next-traces.mjs";

async function writeManifest(manifestPath, files) {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({ version: 1, files }), "utf8");
}

describe("sanitizeNextTraceManifests", () => {
  it("removes acceptance databases and auth samples from all project artifact roots without deleting their files", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "daily-brief-trace-data-"));
    try {
      const blocked = [".data/work-review.sqlite", "test-data/fixture.json", "output/trial/work-review.sqlite",
        "output/trial/work-review.sqlite-wal", "output/trial/users/synthetic.json", "output/trial/sessions/synthetic.json",
        "reports/provider-response.json", "tmp/validation/private.json"].map(p => path.join(projectDir, p));
      const safe = ["node_modules/example-package/index.js", "node_modules/example-package/output/runtime.json",
        "node_modules/example-package/test-data/safe.json", ".next/server/chunks/runtime.js"].map(p => path.join(projectDir, p));
      const payload = "synthetic acceptance evidence must remain unchanged";
      for (const p of [...blocked, ...safe]) { await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, payload); }
      const manifests = [path.join(projectDir, ".next/server/app/api/route.js.nft.json"), path.join(projectDir, ".next/next-server.js.nft.json")];
      for (const p of manifests) await writeManifest(p, [...blocked, ...safe].map(f => path.relative(path.dirname(p), f)));
      expect(await sanitizeNextTraceManifests({ projectDir })).toEqual({ manifestCount: 2, entriesBefore: 24, removed: 16, forbiddenAfter: 0 });
      for (const p of manifests) expect(JSON.parse(await readFile(p, "utf8")).files).toEqual(safe.map(f => path.relative(path.dirname(p), f)));
      for (const p of [...blocked, ...safe]) expect(await readFile(p, "utf8")).toBe(payload);
      expect((await sanitizeNextTraceManifests({ projectDir })).removed).toBe(0);
    } finally { await rm(projectDir, { recursive: true, force: true }); }
  });

  it("keeps the selected custom build's own chunks while excluding neighboring acceptance data", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "daily-brief-trace-custom-"));
    try {
      const distDir = "output/local-build/next", manifest = path.join(projectDir, distDir, "server/app/page.js.nft.json");
      const compiled = path.join(projectDir, distDir, "server/chunks/runtime.js");
      const dependency = path.join(projectDir, "node_modules/example-package/index.js");
      const blocked = ["output/local-build/data/work-review.sqlite", "output/local-build/data/users/synthetic.json", "reports/result.json",
        ".next/server/chunks/previous.js", ".next/server/app/api/route.js.nft.json"]
        .map(p => path.join(projectDir, p));
      await writeManifest(manifest, [compiled, dependency, ...blocked].map(f => path.relative(path.dirname(manifest), f)));
      expect(await sanitizeNextTraceManifests({ projectDir, distDir })).toEqual({ manifestCount: 1, entriesBefore: 7, removed: 5, forbiddenAfter: 0 });
      expect(JSON.parse(await readFile(manifest, "utf8")).files).toEqual([compiled, dependency].map(f => path.relative(path.dirname(manifest), f)));
    } finally { await rm(projectDir, { recursive: true, force: true }); }
  });

  it("cleans the same custom dist selected by Next's CLI environment without rewriting the previous build", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "daily-brief-trace-cli-"));
    try {
      const distDir = "output/local-build/next", manifest = path.join(projectDir, distDir, "server/app/page.js.nft.json");
      const previous = path.join(projectDir, ".next/next-server.js.nft.json");
      const blocked = path.join(projectDir, "output/local-build/data/sessions/synthetic.json");
      const compiled = path.join(projectDir, distDir, "server/chunks/runtime.js");
      await writeManifest(previous, [path.relative(path.dirname(previous), path.join(projectDir, ".data/previous.sqlite"))]);
      const original = await readFile(previous);
      await writeManifest(manifest, [blocked, compiled].map(f => path.relative(path.dirname(manifest), f)));
      const result = spawnSync(process.execPath, [path.resolve("scripts/sanitize-next-traces.mjs")], {
        cwd: projectDir, env: { ...process.env, DAILY_BRIEF_E2E_DIST_DIR: distDir }, encoding: "utf8"
      });
      expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
      expect(JSON.parse(await readFile(manifest, "utf8")).files).toEqual([path.relative(path.dirname(manifest), compiled)]);
      expect(await readFile(previous)).toEqual(original);
    } finally { await rm(projectDir, { recursive: true, force: true }); }
  });

  it("fails the build for an invalid trace contract or a missing build", async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "daily-brief-trace-invalid-"));
    try {
      await mkdir(path.join(projectDir, ".next"));
      await expect(sanitizeNextTraceManifests({ projectDir })).rejects.toThrow("no .nft.json");
      await writeManifest(path.join(projectDir, ".next/broken.nft.json"), [null]);
      await expect(sanitizeNextTraceManifests({ projectDir })).rejects.toThrow("Invalid Next trace");
    } finally { await rm(projectDir, { recursive: true, force: true }); }
  });

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
