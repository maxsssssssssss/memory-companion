// @vitest-environment node
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { syntheticLearningPdf } from "../../../../scripts/fixtures/learning-pdf.mjs";
import { LearningRepository, type LearningOriginalInput } from "./repository";
import { inspectLearningPdf } from "./pdf-inspect";
import type { LearningPdfMetadata } from "@/lib/domain/learning";

const bytes = syntheticLearningPdf();
let metadata: LearningPdfMetadata;
let root: string; let repository: LearningRepository;
const open: LearningRepository[] = [];
beforeAll(async () => { metadata = await inspectLearningPdf(bytes); }, 30000);
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "synthetic-learning-pdf-repo-")); repository = new LearningRepository(root, "synthetic-a"); open.push(repository); });
afterEach(async () => { for (const r of open.splice(0)) if (r.database.open) r.close(); await rm(root, { recursive: true, force: true }); });
function pdf(): LearningOriginalInput { return { id: randomUUID(), kind: "pdf", title: "合成 PDF", filename: "same-name.pdf", bytes, pdf: metadata }; }
const text = (): LearningOriginalInput => ({ id: randomUUID(), kind: "text", title: "合成文本", filename: null, bytes: Buffer.from("[合成] 第一段\n\n第二段") });

describe("PDF original authority and stage-1 migration", () => {
  it("saves mixed batches and same-name originals separately, supports exact replay and reopening scope", async () => {
    const page = repository.create({ id: randomUUID(), title: "合成课程" }); const a = pdf(); const b = pdf(); const t = text();
    const first = repository.saveMaterials(page.id, [a, b, t]);
    expect(repository.saveMaterials(page.id, [a, b, t]).revision).toBe(first.revision);
    repository.select(page.id, { revision: first.revision, materialIds: [a.id, t.id] });
    repository.close(); repository = new LearningRepository(root, "synthetic-a"); open.push(repository);
    const reopened = repository.get(page.id);
    expect(reopened.materialCount).toBe(3);
    expect(reopened.materials.filter((m) => m.selected).map((m) => m.id)).toEqual([a.id, t.id]);
    expect(repository.pdfOriginal(page.id, a.id).bytes).toEqual(bytes);
    expect(repository.pdfOriginal(page.id, b.id).material.pdf).toEqual(metadata);
    expect(repository.source(page.id, t.id).paragraphs).toHaveLength(2);
    expect(() => repository.source(page.id, a.id)).toThrow("pdf_not_parsed");
    expect(await readdir(root)).toEqual(["learning-organizer.sqlite"]);
  });
  it("rolls back binary bytes and metadata together on disk failure, with no orphan files", async () => {
    const page = repository.create({ id: randomUUID(), title: "合成" }); const a = pdf(); const b = { ...pdf(), title: "FAIL" };
    repository.database.exec("CREATE TRIGGER synthetic_fail BEFORE INSERT ON learning_materials WHEN NEW.title = 'FAIL' BEGIN SELECT RAISE(ABORT, 'synthetic_disk_failure'); END;");
    expect(() => repository.saveMaterials(page.id, [a, b])).toThrow("synthetic_disk_failure");
    expect(repository.get(page.id).materialCount).toBe(0);
    expect(repository.database.prepare("SELECT count(*) AS n FROM learning_materials").get()).toEqual({ n: 0 });
    expect(await readdir(root)).toEqual(["learning-organizer.sqlite"]);
    repository.database.exec("DROP TRIGGER synthetic_fail");
    expect(repository.saveMaterials(page.id, [a, b]).materialCount).toBe(2);
  });
  it("fences deletes against already-inspected and late same-ID PDF writes across connections", async () => {
    const page = repository.create({ id: randomUUID(), title: "合成" }); const a = pdf();
    repository.saveMaterials(page.id, [a]);
    const second = new LearningRepository(root, "synthetic-a"); open.push(second);
    second.deleteMaterial(page.id, a.id);
    expect(() => repository.saveMaterials(page.id, [text(), a])).toThrow("material_deleted");
    expect(() => repository.pdfOriginal(page.id, a.id)).toThrow("material_deleted");
    expect(repository.database.prepare("SELECT original,pdf_metadata,fingerprint,filename FROM learning_materials WHERE id=?").get(a.id))
      .toEqual({ original: null, pdf_metadata: null, fingerprint: null, filename: null });
    expect(repository.get(page.id).materialCount).toBe(0);
    second.deletePage(page.id);
    expect(() => repository.saveMaterials(page.id, [pdf()])).toThrow("page_deleted");
    repository.close(); second.close();
    expect((await readFile(join(root, "learning-organizer.sqlite"))).includes(Buffer.from("SYNTHETIC LOCAL PDF"))).toBe(false);
  });
  it("denies wrong-account and wrong-page PDF reads, including metadata-only HEAD reads", () => {
    const page = repository.create({ id: randomUUID(), title: "合成" }); const other = repository.create({ id: randomUUID(), title: "其他" }); const a = pdf();
    repository.saveMaterials(page.id, [a]); const stranger = new LearningRepository(root, "synthetic-b"); open.push(stranger);
    for (const include of [true, false]) {
      expect(() => stranger.pdfOriginal(page.id, a.id, include)).toThrow("page_not_found");
      expect(() => repository.pdfOriginal(other.id, a.id, include)).toThrow("material_not_found");
    }
  });
  it("atomically migrates an actual stage-1 table while preserving bytes, source offsets, choices and tombstones", () => {
    repository.close();
    const db = new Database(join(root, "learning-organizer.sqlite"));
    db.exec("DROP TABLE learning_parsed_documents; DROP TABLE learning_materials; PRAGMA user_version = 0; CREATE TABLE learning_materials(id TEXT PRIMARY KEY,page_id TEXT NOT NULL REFERENCES learning_pages(id),title TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('text','txt')),filename TEXT,original BLOB,fingerprint TEXT,created_at TEXT NOT NULL,selected INTEGER NOT NULL DEFAULT 0,deleted_at TEXT);");
    const pageId = randomUUID(); const item = text(); const deleted = randomUUID(); const time = "2026-09-18T00:00:00.000Z";
    db.prepare("INSERT INTO learning_pages(id,account_id,title,created_at,updated_at,revision) VALUES (?,?,?,?,?,?)").run(pageId, "synthetic-a", "旧合成页", time, time, 7);
    const fingerprint = createHash("sha256").update(JSON.stringify([item.title, item.kind, null])).update(item.bytes).digest("hex");
    db.prepare("INSERT INTO learning_materials VALUES (?,?,?,?,?,?,?,?,?,?)").run(item.id, pageId, item.title, "text", null, item.bytes, fingerprint, time, 1, null);
    db.prepare("INSERT INTO learning_materials VALUES (?,?,?,?,?,?,?,?,?,?)").run(deleted, pageId, "", "text", null, null, null, time, 0, time); db.close();
    repository = new LearningRepository(root, "synthetic-a"); open.push(repository);
    expect(repository.get(pageId)).toMatchObject({ title: "旧合成页", revision: 7, createdAt: time, materials: [{ id: item.id, selected: true }] });
    expect(repository.source(pageId, item.id).text).toBe(item.bytes.toString());
    expect(repository.source(pageId, item.id).paragraphs[1].start).toBe(item.bytes.toString().indexOf("第二段"));
    expect(repository.saveMaterials(pageId, [item]).revision).toBe(7);
    expect(() => repository.saveMaterials(pageId, [{ ...text(), id: deleted }])).toThrow("material_deleted");
    expect(repository.saveMaterials(pageId, [pdf()]).materialCount).toBe(2);
    repository.close(); repository = new LearningRepository(root, "synthetic-a"); open.push(repository);
    expect(repository.database.pragma("user_version", { simple: true })).toBe(11);
    expect(repository.get(pageId).materials[0].selected).toBe(true);
  });
});
