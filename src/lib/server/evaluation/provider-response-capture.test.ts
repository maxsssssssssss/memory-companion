import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureProviderValidationFailure,
  collectProviderRawResponseCaptureReport,
  deleteProviderRawResponseCaptures
} from "./provider-response-capture";

const roots: string[] = [];

async function temporaryEvaluationRoot() {
  const root = await mkdtemp(join(tmpdir(), "provider-response-capture-"));
  roots.push(root);
  return join(root, ".data", "evaluation");
}

function captureInput(overrides: Record<string, unknown> = {}) {
  return {
    provider: "relationship_signal",
    uploadId: "upload_1",
    chunkIndex: 6,
    attempt: 1,
    model: "test-model",
    capturedAt: "2026-07-17T08:00:00.000Z",
    rawResponse: '{"items":[{"confidence":"unexpected-confidence"}]}',
    validationIssueCount: 1,
    validationIssues: [
      { path: "items[0].confidence", code: "invalid_type", message: "Invalid value type" }
    ],
    validationIssueSummary: [{ code: "invalid_type", count: 1 }],
    validationIssuesTruncated: false,
    evaluationRetention: true,
    ...overrides
  } as const;
}

function captureOptions(evaluationRootDir: string, overrides: Record<string, unknown> = {}) {
  return {
    evaluationRootDir,
    evaluationMode: "true",
    debugSaveProviderResponse: "true",
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("evaluation provider raw response capture", () => {
  it.each([
    [undefined, undefined],
    ["true", "false"],
    ["false", "true"],
    ["1", "true"],
    ["true", "yes"]
  ])("does not touch disk unless both strict environment gates are true (%s/%s)", async (evaluationMode, debugMode) => {
    const evaluationRootDir = await temporaryEvaluationRoot();
    const result = await captureProviderValidationFailure(captureInput(), {
      evaluationRootDir,
      evaluationMode,
      debugSaveProviderResponse: debugMode
    });

    expect(result.captured).toBe(false);
    await expect(stat(join(evaluationRootDir, "provider-raw-responses"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("also requires the current upload to be explicitly retained for evaluation", async () => {
    const evaluationRootDir = await temporaryEvaluationRoot();
    const result = await captureProviderValidationFailure(
      captureInput({ evaluationRetention: false }),
      captureOptions(evaluationRootDir)
    );

    expect(result.captured).toBe(false);
    await expect(stat(join(evaluationRootDir, "provider-raw-responses"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes exact raw content and a hash-only report under the evaluation root", async () => {
    const evaluationRootDir = await temporaryEvaluationRoot();
    const rawResponse = '{"items":[{"confidence":"unexpected-confidence","summary":"private marker"}]}';
    const result = await captureProviderValidationFailure(
      captureInput({ rawResponse }),
      captureOptions(evaluationRootDir)
    );
    const report = await collectProviderRawResponseCaptureReport(
      { uploadId: "upload_1", evaluationRetention: true },
      captureOptions(evaluationRootDir)
    );

    expect(result.captured).toBe(true);
    expect(report).toMatchObject({ enabled: true, fileCount: 1 });
    expect(report.files).toHaveLength(1);
    expect(report.aggregateSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(report)).not.toContain("private marker");
    expect(JSON.stringify(report)).not.toContain(resolve(evaluationRootDir));

    const artifactPath = join(evaluationRootDir, "provider-raw-responses", report.files[0].relativePath);
    const artifactBytes = await readFile(artifactPath);
    const artifact = JSON.parse(artifactBytes.toString("utf8"));
    expect(artifact).toMatchObject({
      provider: "relationship_signal",
      chunkIndex: 6,
      chunkIndexBase: 0,
      attempt: 1,
      model: "test-model",
      capturedAt: "2026-07-17T08:00:00.000Z",
      rawResponse,
      validationIssues: [
        { path: "items[0].confidence", code: "invalid_type", message: "Invalid value type" }
      ]
    });
    expect(report.files[0].sha256).toBe(createHash("sha256").update(artifactBytes).digest("hex"));
  });

  it("contains traversal-shaped upload and provider values inside the evaluation root", async () => {
    const evaluationRootDir = await temporaryEvaluationRoot();
    await captureProviderValidationFailure(
      captureInput({ uploadId: "../..\\outside", provider: "openai/../../outside" }),
      captureOptions(evaluationRootDir)
    );
    const root = resolve(evaluationRootDir, "provider-raw-responses");
    const entries = await readdir(root, { recursive: true });

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => !String(entry).includes(".."))).toBe(true);
    await expect(stat(resolve(evaluationRootDir, "outside"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent captures without overwrites or temporary files", async () => {
    const evaluationRootDir = await temporaryEvaluationRoot();
    await Promise.all(Array.from({ length: 12 }, (_, index) => captureProviderValidationFailure(
      captureInput({ attempt: index + 1, rawResponse: `{"items":[{"confidence":"bad-${index}"}]}` }),
      captureOptions(evaluationRootDir)
    )));
    const report = await collectProviderRawResponseCaptureReport(
      { uploadId: "upload_1", evaluationRetention: true },
      captureOptions(evaluationRootDir)
    );

    expect(report.fileCount).toBe(12);
    expect(new Set(report.files.map((file) => file.relativePath)).size).toBe(12);
    expect(report.files.every((file) => /^[a-f0-9]{64}$/u.test(file.sha256))).toBe(true);
    const allEntries = await readdir(join(evaluationRootDir, "provider-raw-responses"), { recursive: true });
    expect(allEntries.some((entry) => String(entry).includes(".tmp"))).toBe(false);
    await Promise.all(report.files.map(async (file) => {
      const content = await readFile(join(evaluationRootDir, "provider-raw-responses", file.relativePath), "utf8");
      expect(() => JSON.parse(content)).not.toThrow();
    }));
  });

  it("removes the isolated raw capture directory on explicit evaluation cleanup", async () => {
    const evaluationRootDir = await temporaryEvaluationRoot();
    await captureProviderValidationFailure(captureInput(), captureOptions(evaluationRootDir));
    const report = await collectProviderRawResponseCaptureReport(
      { uploadId: "upload_1", evaluationRetention: true },
      captureOptions(evaluationRootDir)
    );
    const uploadDirectory = dirname(join(
      evaluationRootDir,
      "provider-raw-responses",
      report.files[0].relativePath
    ));
    const captureUploadDirectory = dirname(uploadDirectory);

    await deleteProviderRawResponseCaptures("upload_1", { evaluationRootDir });

    await expect(stat(captureUploadDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
