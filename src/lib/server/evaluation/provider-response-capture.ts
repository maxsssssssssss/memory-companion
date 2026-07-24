import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type {
  StructuredJsonValidationIssue,
  StructuredJsonValidationIssueSummary
} from "@/lib/server/openai/structured-json";
import { isEvaluationMode } from "./retention";

const CAPTURE_VERSION = 1 as const;
const CAPTURE_DIRECTORY_NAME = "provider-raw-responses";
const CAPTURE_REPORT_NAME = "report.json";

export type ProviderRawResponseCaptureFile = {
  relativePath: string;
  bytes: number;
  sha256: string;
};

export type ProviderRawResponseCaptureReport = {
  version: typeof CAPTURE_VERSION;
  enabled: boolean;
  fileCount: number;
  aggregateSha256: string | null;
  files: ProviderRawResponseCaptureFile[];
};

export type ProviderValidationFailureCapture = {
  provider: string;
  uploadId: string;
  chunkIndex: number;
  attempt: number;
  model: string;
  schemaName?: string;
  capturedAt: string;
  rawResponse: string;
  validationIssueCount: number;
  validationIssues: readonly StructuredJsonValidationIssue[];
  validationIssueSummary: readonly StructuredJsonValidationIssueSummary[];
  validationIssuesTruncated: boolean;
  evaluationRetention: boolean;
};

type CaptureRuntimeOptions = {
  evaluationRootDir?: string;
  evaluationMode?: string;
  debugSaveProviderResponse?: string;
};

type CaptureResult =
  | { captured: false }
  | { captured: true; relativePath: string; sha256: string };

const uploadLocks = new Map<string, Promise<void>>();

function strictTrue(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

function captureEnabled(evaluationRetention: boolean, options?: CaptureRuntimeOptions) {
  const testOverridesAllowed = process.env.NODE_ENV === "test";
  const evaluationMode = testOverridesAllowed && options?.evaluationMode !== undefined
    ? options.evaluationMode
    : process.env.EVALUATION_MODE;
  const debugMode = testOverridesAllowed && options?.debugSaveProviderResponse !== undefined
    ? options.debugSaveProviderResponse
    : process.env.DEBUG_SAVE_PROVIDER_RESPONSE;
  return evaluationRetention && isEvaluationMode(evaluationMode) && strictTrue(debugMode);
}

function evaluationRootDir(options?: CaptureRuntimeOptions) {
  const testRoot = process.env.NODE_ENV === "test" ? options?.evaluationRootDir : undefined;
  return resolve(testRoot ?? join(process.cwd(), ".data", "evaluation"));
}

function assertContained(root: string, target: string) {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || resolve(pathFromRoot) === pathFromRoot) {
    throw new Error("provider response capture path escaped evaluation root");
  }
}

function safePathComponent(value: string, fallback: string) {
  const slug = value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || fallback;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${slug}-${digest}`;
}

function uploadDirectoryName(uploadId: string) {
  return safePathComponent(uploadId, "upload");
}

function providerDirectoryName(provider: string) {
  return safePathComponent(provider, "provider");
}

function timestampForFile(value: string) {
  return value.replace(/[^0-9A-Za-z_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48) || "timestamp";
}

async function captureRoots(uploadId: string, options?: CaptureRuntimeOptions) {
  const evaluationRoot = evaluationRootDir(options);
  await mkdir(evaluationRoot, { recursive: true, mode: 0o700 });
  const canonicalEvaluationRoot = await realpath(evaluationRoot);
  const captureRoot = resolve(evaluationRoot, CAPTURE_DIRECTORY_NAME);
  assertContained(evaluationRoot, captureRoot);
  await mkdir(captureRoot, { recursive: true, mode: 0o700 });
  const canonicalCaptureRoot = await realpath(captureRoot);
  assertContained(canonicalEvaluationRoot, canonicalCaptureRoot);
  const uploadRoot = resolve(captureRoot, uploadDirectoryName(uploadId));
  assertContained(captureRoot, uploadRoot);
  await mkdir(uploadRoot, { recursive: true, mode: 0o700 });
  const canonicalUploadRoot = await realpath(uploadRoot);
  assertContained(canonicalCaptureRoot, canonicalUploadRoot);
  return { captureRoot: canonicalCaptureRoot, uploadRoot: canonicalUploadRoot };
}

async function writeAtomic(filePath: string, content: string) {
  const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function listCaptureFiles(root: string, directory = root): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listCaptureFiles(root, path));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === CAPTURE_REPORT_NAME) continue;
    files.push(path);
  }
  return files;
}

async function buildReport(captureRoot: string, uploadRoot: string): Promise<ProviderRawResponseCaptureReport> {
  const paths = (await listCaptureFiles(uploadRoot)).sort((left, right) => left.localeCompare(right));
  const files = await Promise.all(paths.map(async (filePath) => {
    const [bytes, metadata] = await Promise.all([readFile(filePath), stat(filePath)]);
    return {
      relativePath: relative(captureRoot, filePath).split(sep).join("/"),
      bytes: metadata.size,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  }));
  const aggregateSha256 = files.length === 0
    ? null
    : createHash("sha256")
        .update(files.map((file) => `${file.relativePath}\u0000${file.sha256}`).join("\n"))
        .digest("hex");
  return {
    version: CAPTURE_VERSION,
    enabled: true,
    fileCount: files.length,
    aggregateSha256,
    files
  };
}

async function writeReport(captureRoot: string, uploadRoot: string) {
  const report = await buildReport(captureRoot, uploadRoot);
  await writeAtomic(join(uploadRoot, CAPTURE_REPORT_NAME), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function withUploadLock<T>(key: string, task: () => Promise<T>) {
  const previous = uploadLocks.get(key) ?? Promise.resolve();
  const execution = previous.catch(() => undefined).then(task);
  const tracked = execution.then(() => undefined, () => undefined);
  uploadLocks.set(key, tracked);
  try {
    return await execution;
  } finally {
    if (uploadLocks.get(key) === tracked) uploadLocks.delete(key);
  }
}

export async function captureProviderValidationFailure(
  input: ProviderValidationFailureCapture,
  options?: CaptureRuntimeOptions
): Promise<CaptureResult> {
  if (!captureEnabled(input.evaluationRetention, options)) return { captured: false };
  if (!input.uploadId.trim() || !input.provider.trim() || !Number.isInteger(input.chunkIndex) || input.chunkIndex < 0) {
    return { captured: false };
  }
  return await withUploadLock(uploadDirectoryName(input.uploadId), async () => {
    const { captureRoot, uploadRoot } = await captureRoots(input.uploadId, options);
    const providerRoot = resolve(uploadRoot, providerDirectoryName(input.provider));
    assertContained(uploadRoot, providerRoot);
    await mkdir(providerRoot, { recursive: true, mode: 0o700 });
    const canonicalProviderRoot = await realpath(providerRoot);
    assertContained(uploadRoot, canonicalProviderRoot);
    const fileName = `${[
      `chunk-${String(input.chunkIndex).padStart(5, "0")}`,
      `attempt-${String(Math.max(1, Math.trunc(input.attempt))).padStart(2, "0")}`,
      timestampForFile(input.capturedAt),
      randomUUID()
    ].join("-")}.json`;
    const filePath = resolve(canonicalProviderRoot, fileName);
    assertContained(canonicalProviderRoot, filePath);
    const artifact = {
      version: CAPTURE_VERSION,
      provider: input.provider,
      uploadId: input.uploadId,
      chunkIndex: input.chunkIndex,
      chunkIndexBase: 0,
      attempt: Math.max(1, Math.trunc(input.attempt)),
      model: input.model,
      ...(input.schemaName ? { schemaName: input.schemaName } : {}),
      capturedAt: input.capturedAt,
      rawResponse: input.rawResponse,
      rawResponseSha256: createHash("sha256").update(input.rawResponse).digest("hex"),
      validationIssueCount: input.validationIssueCount,
      validationIssues: input.validationIssues.slice(0, 10),
      validationIssueSummary: input.validationIssueSummary.slice(0, 10),
      validationIssuesTruncated: input.validationIssuesTruncated
    };
    const content = `${JSON.stringify(artifact, null, 2)}\n`;
    await writeAtomic(filePath, content);
    await writeReport(captureRoot, uploadRoot);
    return {
      captured: true,
      relativePath: relative(captureRoot, filePath).split(sep).join("/"),
      sha256: createHash("sha256").update(content).digest("hex")
    };
  });
}

export async function collectProviderRawResponseCaptureReport(
  input: { uploadId: string; evaluationRetention: boolean },
  options?: CaptureRuntimeOptions
): Promise<ProviderRawResponseCaptureReport> {
  if (!captureEnabled(input.evaluationRetention, options)) {
    return { version: CAPTURE_VERSION, enabled: false, fileCount: 0, aggregateSha256: null, files: [] };
  }
  return await withUploadLock(uploadDirectoryName(input.uploadId), async () => {
    const { captureRoot, uploadRoot } = await captureRoots(input.uploadId, options);
    return await writeReport(captureRoot, uploadRoot);
  });
}

export async function deleteProviderRawResponseCaptures(uploadId: string, options?: Pick<CaptureRuntimeOptions, "evaluationRootDir">) {
  const evaluationRoot = evaluationRootDir(options);
  const captureRoot = resolve(evaluationRoot, CAPTURE_DIRECTORY_NAME);
  const uploadRoot = resolve(captureRoot, uploadDirectoryName(uploadId));
  assertContained(captureRoot, uploadRoot);
  await rm(uploadRoot, { recursive: true, force: true });
}
