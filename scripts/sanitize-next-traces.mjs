import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function collectTraceManifests(directory) {
  const manifests = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      manifests.push(...await collectTraceManifests(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".nft.json")) {
      manifests.push(entryPath);
    }
  }

  return manifests;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (
    !relative.startsWith(`..${path.sep}`)
    && relative !== ".."
    && !path.isAbsolute(relative)
  );
}

function isForbiddenReference(manifestPath, file, forbiddenRoots, distDir) {
  const resolved = path.resolve(path.dirname(manifestPath), file);
  // Local validation builds may themselves live in output/. Keep that build's
  // chunks/manifests, while excluding neighboring data and historical artifacts.
  return !isInside(distDir, resolved)
    && forbiddenRoots.some((root) => isInside(root, resolved));
}

export async function sanitizeNextTraceManifests({
  projectDir = process.cwd(),
  distDir = ".next"
} = {}) {
  const resolvedProjectDir = path.resolve(projectDir);
  const resolvedDistDir = path.resolve(resolvedProjectDir, distDir);
  const forbiddenRoots = [
    // With a custom dist, .next is an older build, not a runtime dependency.
    // The selected build is exempted above, including the default .next case.
    path.resolve(resolvedProjectDir, ".next"),
    path.resolve(resolvedProjectDir, ".data"),
    path.resolve(resolvedProjectDir, "test-data"),
    path.resolve(resolvedProjectDir, "output"),
    path.resolve(resolvedProjectDir, "reports"),
    path.resolve(resolvedProjectDir, "tmp")
  ];
  const manifests = await collectTraceManifests(resolvedDistDir);

  if (manifests.length === 0) {
    throw new Error("Next build produced no .nft.json manifests");
  }

  let entriesBefore = 0;
  let removed = 0;

  for (const manifestPath of manifests) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!Array.isArray(manifest.files) || manifest.files.some((file) => typeof file !== "string")) {
      throw new Error("Invalid Next trace manifest files contract");
    }

    entriesBefore += manifest.files.length;
    const retainedFiles = manifest.files.filter((file) => (
      !isForbiddenReference(manifestPath, file, forbiddenRoots, resolvedDistDir)
    ));
    removed += manifest.files.length - retainedFiles.length;

    if (retainedFiles.length !== manifest.files.length) {
      await writeFile(
        manifestPath,
        `${JSON.stringify({ ...manifest, files: retainedFiles })}\n`,
        "utf8"
      );
    }
  }

  let forbiddenAfter = 0;
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    forbiddenAfter += manifest.files.filter((file) => (
      isForbiddenReference(manifestPath, file, forbiddenRoots, resolvedDistDir)
    )).length;
  }

  if (forbiddenAfter !== 0) {
    throw new Error("Forbidden runtime or evaluation data remains in Next traces");
  }

  return {
    manifestCount: manifests.length,
    entriesBefore,
    removed,
    forbiddenAfter
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await sanitizeNextTraceManifests({
    distDir: process.env.DAILY_BRIEF_E2E_DIST_DIR?.trim() || ".next"
  });
  console.log(
    `Next trace sanitization: manifests=${result.manifestCount} removed=${result.removed} forbidden=${result.forbiddenAfter}`
  );
}
