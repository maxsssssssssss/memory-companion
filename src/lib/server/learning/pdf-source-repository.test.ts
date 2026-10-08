// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LearningPdfMetadata } from "@/lib/domain/learning";
import { syntheticLearningPdf } from "../../../../scripts/fixtures/learning-pdf.mjs";
import { LearningRepository, type CreatePdfSourceInput } from "./repository";

// Local, synthetic metadata/SQLite checks only; no user data, HTTP or OCR.
const bytes = syntheticLearningPdf({ pages: 2 });
const sha256 = createHash("sha256").update(bytes).digest("hex");
const metadata: LearningPdfMetadata = { sha256, originalVersion: 1, parsing: "not_parsed", pageCount: 2,
  pages: [1, 2].map(physicalPage => ({ physicalPage, width: 600, height: 800, rotation: 0,
    view: [0, 0, 600, 800], userUnit: 1 })) };
const expiresAt = "2030-01-01T00:00:00.000Z";
let root: string, repo: LearningRepository, pageId: string, materialId: string;
function input(overrides: Partial<CreatePdfSourceInput> = {}): CreatePdfSourceInput {
  return { sourceId: randomUUID(), materialId, sha256, originalVersion: 1, byteSize: bytes.length, pageCount: 2,
    serviceUrl: "https://ocr.synthetic.invalid/internal/ocr", serviceEpoch: "a".repeat(64), instance: "session-1", ...overrides };
}
function addMaterial(page = pageId) {
  const id = randomUUID();
  repo.saveMaterials(page, [{ id, title: "SYNTHETIC", kind: "pdf", filename: "synthetic.pdf", bytes, pdf: metadata }]);
  return id;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "learning-source-receipt-"));
  repo = new LearningRepository(root, "synthetic-owner");
  pageId = randomUUID(); repo.create({ id: pageId, title: "SYNTHETIC" }); materialId = addMaterial();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("External I/O forbidden"); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); repo.close(); rmSync(root, { recursive: true, force: true });
});

it("reserves once, replays exact identity, and stores only source metadata in creation order", () => {
  const firstInput = input(), first = repo.createPdfSource(pageId, firstInput);
  expect(first).toMatchObject({ ...firstInput, pageId, status: "pending", expiresAt: null, deleteRequested: false, remoteCleanup: null });
  expect(repo.createPdfSource(pageId, firstInput)).toEqual(first);
  const second = repo.createPdfSource(pageId, input());
  expect(repo.listPdfSources(pageId, materialId).map(s => s.sourceId)).toEqual([first.sourceId, second.sourceId]);
  expect(repo.getPdfSource(pageId, materialId, first.sourceId)).toEqual(first);
  const columns = (repo.database.pragma("table_info(learning_pdf_sources)") as Array<{ name: string }>).map(c => c.name);
  expect(columns).not.toContain("original"); expect(columns).not.toContain("response_json");
  expect(columns.some(c => /token|secret|body|base64/u.test(c))).toBe(false);
});

it.each([
  { sha256: "b".repeat(64) }, { originalVersion: 2 }, { byteSize: bytes.length + 1 }, { pageCount: 1 }
])("rejects an original binding mismatch before creating a receipt: %j", mismatch => {
  expect(() => repo.createPdfSource(pageId, input(mismatch))).toThrow("source_changed");
  expect(repo.listPdfSources(pageId, materialId)).toEqual([]);
});

it("does not rebind a reserved ID to another material, page, service or epoch", () => {
  const request = input(); repo.createPdfSource(pageId, request);
  const anotherMaterial = addMaterial(), anotherPage = randomUUID(); repo.create({ id: anotherPage, title: "SYNTHETIC SECOND" });
  const pageMaterial = addMaterial(anotherPage);
  for (const change of [{ materialId: anotherMaterial }, { serviceUrl: "https://other.synthetic.invalid" },
    { serviceEpoch: "b".repeat(64) }, { instance: "session-2" }]) {
    expect(() => repo.createPdfSource(pageId, { ...request, ...change })).toThrow("submission_conflict");
  }
  expect(() => repo.createPdfSource(anotherPage, { ...request, materialId: pageMaterial })).toThrow("submission_conflict");
  expect(() => repo.getPdfSource(pageId, anotherMaterial, request.sourceId)).toThrow("pdf_source_not_found");
  expect(repo.listPdfSources(pageId, materialId)).toHaveLength(1);
});

it("rejects credentials or payload fields instead of persisting them", () => {
  for (const serviceUrl of ["https://name:SYNTHETIC_SECRET@ocr.synthetic.invalid", "https://ocr.synthetic.invalid/?token=SYNTHETIC",
    "https://ocr.synthetic.invalid/#SYNTHETIC", "http://ocr.synthetic.invalid"]) {
    expect(() => repo.createPdfSource(pageId, input({ serviceUrl }))).toThrow();
  }
  expect(() => repo.createPdfSource(pageId, { ...input(), body: "SYNTHETIC NOT SOURCE CONTENT" } as CreatePdfSourceInput)).toThrow();
  expect(repo.listPdfSources(pageId, materialId)).toEqual([]);
});

it("checks account ownership even when another account opens the same isolated database", () => {
  const source = repo.createPdfSource(pageId, input()), other = new LearningRepository(root, "synthetic-other");
  try {
    expect(() => other.getPdfSource(pageId, materialId, source.sourceId)).toThrow("page_not_found");
    expect(() => other.listPdfSources(pageId, materialId)).toThrow("page_not_found");
    expect(() => other.createPdfSource(pageId, input())).toThrow("page_not_found");
    expect(() => other.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "pending", status: "uploading" })).toThrow("page_not_found");
    repo.deleteMaterial(pageId, materialId);
    expect(other.listPdfSourcesPendingCleanup()).toEqual([]);
    expect(() => other.listPdfSourcesPendingCleanup(pageId)).toThrow("page_not_found");
    expect(() => other.markPdfSourceCleanup(pageId, materialId, source.sourceId, "deleted")).toThrow("page_not_found");
  } finally { other.close(); }
});

it("CAS fences stale writers across connections and never revives a terminal handle", () => {
  const source = repo.createPdfSource(pageId, input()), second = new LearningRepository(root, "synthetic-owner");
  try {
    repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "pending", status: "uploading" });
    expect(() => second.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "pending", status: "ready", expiresAt })).toThrow("source_changed");
    repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "uploading", status: "unknown" });
    expect(repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: ["uploading", "unknown"], status: "ready", expiresAt })).toMatchObject({ status: "ready", expiresAt });
    expect(repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "ready", status: "expired" }).status).toBe("expired");
    expect(() => second.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "expired", status: "ready", expiresAt })).toThrow("source_changed");
    const replacement = repo.createPdfSource(pageId, input());
    expect(replacement.sourceId).not.toBe(source.sourceId);
    expect(repo.getPdfSource(pageId, materialId, source.sourceId).status).toBe("expired");
  } finally { second.close(); }
});

it("requires the ready expiry and accepts a later bound failure without changing its identity", () => {
  const source = repo.createPdfSource(pageId, input());
  repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "pending", status: "uploading" });
  expect(() => repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "uploading", status: "ready" })).toThrow("pdf_source_receipt_invalid");
  repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "uploading", status: "ready", expiresAt });
  expect(repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "ready", status: "failed" })).toMatchObject({ status: "failed", sourceId: source.sourceId });
  expect(() => repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "failed", status: "ready", expiresAt })).toThrow("source_changed");
});

it("rechecks the immutable original binding on every active read, list and update", () => {
  const source = repo.createPdfSource(pageId, input());
  repo.database.prepare("UPDATE learning_materials SET pdf_metadata=? WHERE id=?")
    .run(JSON.stringify({ ...metadata, sha256: "b".repeat(64) }), materialId);
  expect(() => repo.getPdfSource(pageId, materialId, source.sourceId)).toThrow("source_changed");
  expect(() => repo.listPdfSources(pageId, materialId)).toThrow("source_changed");
  expect(() => repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "pending", status: "uploading" })).toThrow("source_changed");
});

it("material deletion preserves cleanup identity, rejects late publication and recovers cleanup after reopen", () => {
  const request = input(), source = repo.createPdfSource(pageId, request);
  repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "pending", status: "uploading" });
  expect(() => repo.markPdfSourceCleanup(pageId, materialId, source.sourceId, "deleted")).toThrow("pdf_source_cleanup_not_requested");
  repo.deleteMaterial(pageId, materialId);
  expect(repo.listPdfSourcesPendingCleanup(pageId, materialId)).toMatchObject([{ sourceId: source.sourceId, status: "uploading", deleteRequested: true, remoteCleanup: "pending" }]);
  expect(repo.database.prepare("SELECT original,pdf_metadata FROM learning_materials WHERE id=?").get(materialId)).toEqual({ original: null, pdf_metadata: null });
  expect(() => repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "uploading", status: "ready", expiresAt })).toThrow("material_deleted");
  expect(() => repo.createPdfSource(pageId, request)).toThrow("material_deleted");
  repo.markPdfSourceCleanup(pageId, materialId, source.sourceId, "failed");
  repo.close(); repo = new LearningRepository(root, "synthetic-owner");
  expect(repo.listPdfSourcesPendingCleanup()).toMatchObject([{ sourceId: source.sourceId, remoteCleanup: "failed" }]);
  repo.markPdfSourceCleanup(pageId, materialId, source.sourceId, "deleted");
  expect(repo.markPdfSourceCleanup(pageId, materialId, source.sourceId, "failed").remoteCleanup).toBe("deleted");
  expect(repo.listPdfSourcesPendingCleanup()).toEqual([]);
  expect(() => repo.getPdfSource(pageId, materialId, source.sourceId)).toThrow("material_deleted");
});

it("page deletion retains only inaccessible cleanup receipts while removing the material and parses", () => {
  const source = repo.createPdfSource(pageId, input());
  repo.createParsedDocument(pageId, { id: randomUUID(), materialId, originalSha256: sha256, originalVersion: 1,
    requestedPages: [1, 2], parser: { name: "SYNTHETIC", version: "1" } });
  repo.deletePage(pageId);
  expect(repo.database.prepare("SELECT count(*) n FROM learning_materials").get()).toEqual({ n: 0 });
  expect(repo.database.prepare("SELECT count(*) n FROM learning_parsed_documents").get()).toEqual({ n: 0 });
  expect(repo.database.pragma("foreign_key_check")).toEqual([]);
  repo.close(); repo = new LearningRepository(root, "synthetic-owner");
  expect(repo.listPdfSourcesPendingCleanup(pageId)).toMatchObject([{ sourceId: source.sourceId, deleteRequested: true }]);
  expect(() => repo.getPdfSource(pageId, materialId, source.sourceId)).toThrow("page_deleted");
  expect(() => repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "pending", status: "ready", expiresAt })).toThrow("page_deleted");
  expect(() => repo.createPdfSource(pageId, input())).toThrow("page_deleted");
  repo.markPdfSourceCleanup(pageId, materialId, source.sourceId, "deleted");
  expect(repo.listPdfSourcesPendingCleanup(pageId)).toEqual([]);
});

it("adds source receipts to an old schema without changing saved materials or parsed attempts", () => {
  const parsed = repo.createParsedDocument(pageId, { id: randomUUID(), materialId, originalSha256: sha256, originalVersion: 1,
    requestedPages: [1, 2], parser: { name: "SYNTHETIC", version: "1" } });
  const before = repo.get(pageId);
  repo.database.exec("DROP TABLE learning_pdf_sources; PRAGMA user_version=10;");
  repo.close(); repo = new LearningRepository(root, "synthetic-owner");
  expect(repo.database.pragma("user_version", { simple: true })).toBe(11);
  expect(repo.get(pageId)).toEqual(before); expect(repo.pdfOriginal(pageId, materialId).bytes).toEqual(bytes);
  expect(repo.getParsedDocument(pageId, parsed.id)).toEqual(parsed);
  expect(repo.listPdfSources(pageId, materialId)).toEqual([]);
  const source = repo.createPdfSource(pageId, input());
  repo.close(); repo = new LearningRepository(root, "synthetic-owner");
  expect(repo.getPdfSource(pageId, materialId, source.sourceId)).toEqual(source);
});

it("retires a completed upload cache without deleting the live PDF or its saved result identity", () => {
  const request = input(), source = repo.createPdfSource(pageId, request);
  repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "pending", status: "ready", expiresAt });
  const parsed = repo.createParsedDocument(pageId, { id: randomUUID(), materialId, originalSha256: sha256, originalVersion: 1,
    requestedPages: [1, 2], parser: { name: "SYNTHETIC", version: "1" } });
  const before = repo.get(pageId);
  repo.retirePdfSource(pageId, materialId, source.sourceId);
  expect(repo.get(pageId)).toEqual(before); expect(repo.pdfOriginal(pageId, materialId).bytes).toEqual(bytes);
  expect(repo.getParsedDocument(pageId, parsed.id)).toEqual(parsed);
  expect(repo.listPdfSources(pageId, materialId)).toEqual([]);
  expect(repo.listPdfSourcesPendingCleanup(pageId, materialId)).toMatchObject([{ sourceId: source.sourceId,
    status: "expired", deleteRequested: true, remoteCleanup: "pending" }]);
  expect(() => repo.createPdfSource(pageId, request)).toThrow("material_deleted");
  expect(() => repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "expired", status: "ready", expiresAt })).toThrow("material_deleted");
  const replacement = repo.createPdfSource(pageId, input());
  expect(repo.listPdfSources(pageId, materialId).map(s => s.sourceId)).toEqual([replacement.sourceId]);
  repo.markPdfSourceCleanup(pageId, materialId, source.sourceId, "deleted");
  expect(repo.listPdfSourcesPendingCleanup(pageId, materialId)).toEqual([]);
  expect(repo.getPdfSource(pageId, materialId, replacement.sourceId).status).toBe("pending");
});

it.each(["pending", "uploading", "unknown", "failed", "expired"] as const)("refuses to retire a non-ready %s cache", status => {
  const source = repo.createPdfSource(pageId, input());
  if (status !== "pending") repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "pending", status });
  expect(() => repo.retirePdfSource(pageId, materialId, source.sourceId)).toThrow("source_changed");
  expect(repo.getPdfSource(pageId, materialId, source.sourceId)).toMatchObject({ status, deleteRequested: false, remoteCleanup: null });
  expect(repo.listPdfSourcesPendingCleanup(pageId, materialId)).toEqual([]);
});

it("retirement enforces account and material ownership", () => {
  const source = repo.createPdfSource(pageId, input()), other = new LearningRepository(root, "synthetic-other");
  repo.updatePdfSource(pageId, materialId, source.sourceId, { expectedStatus: "pending", status: "ready", expiresAt });
  try {
    expect(() => other.retirePdfSource(pageId, materialId, source.sourceId)).toThrow("page_not_found");
    expect(() => repo.retirePdfSource(pageId, addMaterial(), source.sourceId)).toThrow("pdf_source_not_found");
    expect(repo.getPdfSource(pageId, materialId, source.sourceId)).toMatchObject({ status: "ready", deleteRequested: false });
  } finally { other.close(); }
});
