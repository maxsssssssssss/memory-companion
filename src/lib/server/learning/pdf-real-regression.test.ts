// @vitest-environment node
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { inspectLearningPdf } from "./pdf-inspect";
import { LearningRepository } from "./repository";
const original = process.env.LEARNING_BERTOLOGY_PDF;
it.skipIf(!original)("real delivered BERTology original: hash, all 25 pages, save/reopen, unchanged bytes (offline, no OCR)", async () => {
  const bytes = await readFile(original!);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("ba1255964007358db90742cf4051324ffadee69775a2dee86d3471be0e520ac1");
  const metadata = await inspectLearningPdf(bytes);
  expect(metadata.pageCount).toBe(25);
  expect(metadata.compatibilityWarnings).toHaveLength(2);
  expect(metadata.compatibilityWarnings?.every((w) => w.code === "long_name_preserved" && w.length === 139)).toBe(true);
  const root = await mkdtemp(join(tmpdir(), "learning-bertology-offline-")); let repository = new LearningRepository(root, "isolated-handoff-regression");
  try {
    const id = randomUUID(); const materialId = randomUUID(); repository.create({ id, title: "[离线公开样本] BERTology" });
    repository.saveMaterials(id, [{ id: materialId, kind: "pdf", title: "BERTology 原件", filename: "bertology.pdf", bytes, pdf: metadata }]);
    repository.close(); repository = new LearningRepository(root, "isolated-handoff-regression");
    expect(repository.pdfOriginal(id, materialId).bytes).toEqual(bytes);
    expect(repository.pdfOriginal(id, materialId).material.pdf).toEqual(metadata);
    expect(() => repository.source(id, materialId)).toThrow("pdf_not_parsed");
  } finally { repository.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);
