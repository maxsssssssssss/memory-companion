import { readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { JsonStore } from "@/lib/server/storage/json-store";
import { JsonChunkCheckpointStore } from "@/lib/server/transcription/chunks/checkpoint-store";

function assertAccountUploadPath(uploadsRootDir: string, targetPath: string) {
  const root = resolve(uploadsRootDir);
  const target = resolve(targetPath);
  const pathFromRoot = relative(root, target);
  if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error("work_review_cleanup_outside_account_upload_root");
  }
  return target;
}

export async function cleanupWorkReviewUploadArtifacts(input: {
  store: JsonStore;
  uploadsRootDir: string;
  uploadId: string;
  filePath?: string | null;
}) {
  const fixedTargets = input.filePath
    ? [
        assertAccountUploadPath(input.uploadsRootDir, input.filePath),
        assertAccountUploadPath(
          input.uploadsRootDir,
          join(dirname(input.filePath), `${input.uploadId}-chunks`)
        )
      ]
    : [assertAccountUploadPath(
        input.uploadsRootDir,
        join(input.uploadsRootDir, `${input.uploadId}-chunks`)
      )];
  const attemptTargets: string[] = [];
  if (/^work-meeting-[a-zA-Z0-9_-]+$/u.test(input.uploadId)) {
    try {
      const entries = await readdir(resolve(input.uploadsRootDir), { withFileTypes: true });
      const attemptPrefix = `${input.uploadId}.request-`;
      for (const entry of entries) {
        if (entry.isFile() && entry.name.startsWith(attemptPrefix)) {
          attemptTargets.push(assertAccountUploadPath(
            input.uploadsRootDir,
            join(input.uploadsRootDir, entry.name)
          ));
        }
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        return { ok: false, failures: ["filesystem_cleanup_failed"] };
      }
    }
  }
  const targets = [...new Set([...fixedTargets, ...attemptTargets])];
  const failures: string[] = [];
  for (const target of targets) {
    try {
      await rm(target, { recursive: target.endsWith("-chunks"), force: true });
    } catch {
      failures.push("filesystem_cleanup_failed");
    }
  }
  try {
    await new JsonChunkCheckpointStore(input.store).deleteUpload(input.uploadId);
  } catch {
    failures.push("checkpoint_cleanup_failed");
  }
  return { ok: failures.length === 0, failures: [...new Set(failures)] };
}
