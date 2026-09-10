import { createHash } from "node:crypto";
import { mkdir, realpath, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type { WorkWeeklyGenerationTrace } from "./weekly-publication-policy";

export type WorkWeeklyDiagnosticRun = {
  accountId: string;
  weeklyReviewId: string;
  runId: string;
  runVersion: number;
  sourceSnapshotDigest: string;
  inputPackDigest: string;
};
export type WorkWeeklyDiagnosticEvent = {
  run: WorkWeeklyDiagnosticRun;
  event: { stage: "started" }
    | { stage: "pipeline"; trace: WorkWeeklyGenerationTrace }
    | { stage: "finished"; outcome: "published" | "failed" | "quality_insufficient"; errorCode: string | null;
      qualityStatus?: "passed" | "needs_review"; publicationStatus?: "persisted" };
  /** Rechecked after asynchronous filesystem work so deleted/cancelled runs emit no late body. */
  canCapture: () => boolean;
};
export type WorkWeeklyDiagnosticSink = (event: WorkWeeklyDiagnosticEvent) => Promise<void>;

function contained(root: string, target: string) {
  const part = relative(root, target);
  if (!part || part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) {
    throw new Error("weekly_diagnostics_scope_invalid");
  }
}

/** Explicit local evaluation injection only. No env flag, transport observer or DB authority. */
export async function createWorkWeeklyEvaluationDiagnosticSink(input: {
  directory: string;
  accountId: string;
  weeklyReviewId: string;
}): Promise<WorkWeeklyDiagnosticSink> {
  if (process.env.NODE_ENV === "production" || !input.accountId || !input.weeklyReviewId) {
    throw new Error("weekly_diagnostics_scope_invalid");
  }
  const workspace = await realpath(process.cwd());
  const directory = await realpath(input.directory);
  contained(workspace, directory);
  const scopedPath = relative(workspace, directory).split(sep).join("/");
  if (!scopedPath.startsWith("output/") && !scopedPath.startsWith(".data/evaluation/")) {
    throw new Error("weekly_diagnostics_scope_invalid");
  }
  const bindings = new Map<string, { value: string; nextSequence: number }>();
  return async ({ run, event, canCapture }) => {
    if (run.accountId !== input.accountId || run.weeklyReviewId !== input.weeklyReviewId || !canCapture()) return;
    if (!/^[A-Za-z0-9_-]{1,160}$/u.test(run.runId) || !Number.isSafeInteger(run.runVersion)
      || run.runVersion < 1 || !/^[a-f0-9]{64}$/u.test(run.sourceSnapshotDigest)
      || !/^[a-f0-9]{64}$/u.test(run.inputPackDigest)) {
      throw new Error("weekly_diagnostics_scope_invalid");
    }
    const binding = JSON.stringify(run);
    let previous = bindings.get(run.runId);
    if (previous && previous.value !== binding) throw new Error("weekly_diagnostics_binding_changed");
    if (!previous) {
      previous = { value: binding, nextSequence: 1 };
      bindings.set(run.runId, previous);
    }
    if (event.stage === "pipeline" && (event.trace.snapshotDigest !== run.sourceSnapshotDigest
      || event.trace.inputPackDigest !== run.inputPackDigest)) {
      throw new Error("weekly_diagnostics_binding_changed");
    }
    const runDirectory = join(directory, run.runId);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const canonicalRunDirectory = await realpath(runDirectory);
    contained(directory, canonicalRunDirectory);
    if (!canCapture()) return;
    const sequence = previous.nextSequence++;
    const phase = event.stage === "pipeline" ? event.trace.stage : event.stage;
    const safeEvent = event.stage === "finished" ? {
      ...event,
      errorCode: event.errorCode && /^(?:work|weekly)_[a-z0-9_]{1,120}$/u.test(event.errorCode)
        ? event.errorCode : null
    } : event;
    const serialized = JSON.stringify(safeEvent);
    const artifact = {
      version: 1,
      run,
      sequence,
      capturedAt: new Date().toISOString(),
      phaseMeaning: phase === "published" ? "policy_candidates_before_sqlite_publication"
        : event.stage === "finished" ? "executor_outcome_after_persistence_attempt" : "pipeline_stage",
      payloadSha256: createHash("sha256").update(serialized).digest("hex"),
      event: safeEvent
    };
    const artifactPath = join(canonicalRunDirectory, `${String(sequence).padStart(3, "0")}-${phase}.json`);
    await writeFile(artifactPath, JSON.stringify(artifact, null, 2) + "\n",
      { encoding: "utf8", flag: "wx", mode: 0o600 });
    // Remove only the file this call just created if cancellation/deletion raced the write.
    if (!canCapture()) await unlink(artifactPath);
  };
}
