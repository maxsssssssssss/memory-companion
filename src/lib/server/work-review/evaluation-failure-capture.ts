import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { StructuredJsonResponseText } from "../openai/structured-json";

export type WorkAnalysisFailureCapture = {
  requestTraceId: string;
  stage: "extractor" | "verifier" | "deduplicator";
  model: string;
  schemaName: string;
  errorCode: string;
  elapsedMs: number;
  diagnostics: Record<string, unknown>;
  requestInput: unknown;
  jsonInstruction: string;
  response: StructuredJsonResponseText | null;
};
export type WorkAnalysisFailureSink = (capture: WorkAnalysisFailureCapture) => Promise<void>;

function assertContained(root: string, target: string) {
  const part = relative(root, target);
  if (!part || part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) {
    throw new Error("work_evaluation_capture_scope_invalid");
  }
}

/** Local synthetic evaluation only; never a product database or upload authority. */
export async function createWorkAnalysisEvaluationFailureSink(
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<WorkAnalysisFailureSink | undefined> {
  if (env.NODE_ENV === "production" || env.APP_STORAGE_MODE !== "local"
    || env.EVALUATION_MODE !== "true" || env.DEBUG_SAVE_PROVIDER_RESPONSE !== "true"
    || !env.WORK_REVIEW_EVALUATION_RUN_ID) return undefined;
  const runId = env.WORK_REVIEW_EVALUATION_RUN_ID;
  if (!/^[A-Za-z0-9_-]{1,90}$/u.test(runId)) throw new Error("work_evaluation_capture_scope_invalid");
  const root = await realpath(process.cwd());
  const evaluationRoot = await realpath(join(root, ".data", "evaluation", "work-review-analysis-core-stabilization"));
  assertContained(root, evaluationRoot);
  const runDir = await realpath(join(evaluationRoot, runId));
  assertContained(evaluationRoot, runDir);
  const scopePath = await realpath(join(runDir, "failure-capture-scope.json"));
  assertContained(runDir, scopePath);
  const scope = JSON.parse(await readFile(scopePath, "utf8"));
  const dataDir = await realpath(env.APP_DATA_DIR ?? "");
  assertContained(root, dataDir);
  if (scope.version !== 1 || scope.synthetic !== true || scope.runId !== runId
    || typeof scope.dataDirectory !== "string" || resolve(scope.dataDirectory) !== dataDir
    || !/^wrb-[a-f0-9]{8}$/u.test(relative(join(root, ".data"), dataDir))) {
    throw new Error("work_evaluation_capture_scope_invalid");
  }
  return async (capture) => {
    if (!/^[a-f0-9-]{36}$/u.test(capture.requestTraceId)) throw new Error("work_evaluation_capture_trace_invalid");
    const directory = join(runDir, "provider-failures");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const canonicalDirectory = await realpath(directory);
    assertContained(runDir, canonicalDirectory);
    const raw = capture.response?.rawResponse ?? null;
    // One immutable artifact holds the exact answer text, request and safe cause;
    // no credentials, HTTP headers, upstream error body or reasoning events.
    const artifact = {
      version: 1, runId, capturedAt: new Date().toISOString(),
      ...capture,
      rawResponseAvailability: raw === null || (raw.length === 0 && capture.response?.state === "partial") ? "not_received"
        : raw.length === 0 ? "empty" : capture.response!.state,
      rawResponseSha256: raw === null ? null : createHash("sha256").update(raw).digest("hex")
    };
    await writeFile(join(canonicalDirectory, `${capture.requestTraceId}.json`),
      `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  };
}
