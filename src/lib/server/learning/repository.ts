import { PdfStudySelection, type ParsedTextBinding } from "@/lib/domain/learning-pdf-study";
import { parsedLearningSource } from "./parsed-learning";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  CreateLearningPage, LearningBatch, LearningSelection, LEARNING_BATCH_MAX_BYTES,
  LEARNING_TEXT_MAX_BYTES, LEARNING_AUDIO_MAX_BYTES, LEARNING_AUDIO_BATCH_MAX_BYTES, LEARNING_AUDIO_MAX_SECONDS, LEARNING_PDF_MAX_BYTES, LEARNING_PDF_BATCH_MAX_BYTES, LEARNING_PDF_MAX_PAGES, learningParagraphs,
  type LearningAudioMetadata, type LearningParagraph, type LearningMaterial, type LearningPage, type LearningPageSummary, type LearningSource, type LearningPdfMetadata
} from "@/lib/domain/learning";
import {
  CreateParsedDocument, ParsedFailureCode, PARSED_DOCUMENT_MAX_BYTES,
  type ParsedDocument, type ParsedBlockSource, type ParsedScopeInspection
} from "@/lib/domain/learning-parsed-document";
import { parsedSource, prepareParsedResult, readParsedResult } from "./parsed-document-core";
import { LEARNING_STUDY_SCHEMA } from "./study-schema";
import { LEARNING_QUIZ_SCHEMA } from "./quiz-schema";
import { LEARNING_PREPARATION_SCHEMA } from "./preparation-schema";
import { LEARNING_GENERATION_SCHEMA } from "./generation-schema";

export class LearningError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}

export type LearningTextInput = {
  id: string; title: string; kind: "text" | "txt"; filename: string | null; bytes: Buffer;
};
export type LearningOriginalInput = LearningTextInput | {
  id: string; title: string; kind: "pdf"; filename: string | null; bytes: Buffer; pdf: LearningPdfMetadata;
} | { id: string; title: string; kind: "audio"; filename: string; bytes: Buffer; audio: LearningAudioMetadata };
type PageRow = { id: string; account_id: string; title: string; created_at: string; updated_at: string; revision: number; deleted_at: string | null };
type MaterialRow = {
  id: string; page_id: string; title: string; kind: "text" | "txt" | "pdf" | "audio"; filename: string | null;
  original: Buffer | null; fingerprint: string | null; created_at: string; selected: number; deleted_at: string | null;
  pdf_metadata: string | null; audio_metadata: string | null;
};
type ParsedDocumentRow = {
  id: string; page_id: string; material_id: string; version: number; parser_name: string; parser_version: string;
  original_sha256: string | null; created_at: string; updated_at: string; status: ParsedDocument["status"];
  failure_code: ParsedDocument["failureCode"]; result_json: string | null; result_hash: string | null; invalidated_at: string | null;
  requested_pages: string | null;
};
function parsedDocumentView(row: ParsedDocumentRow): ParsedDocument {
  return { id: row.id, learningPageId: row.page_id, materialId: row.material_id, version: row.version,
    parser: { name: row.parser_name, version: row.parser_version }, originalSha256: row.original_sha256, originalVersion: 1,
    createdAt: row.created_at, updatedAt: row.updated_at, status: row.status, failureCode: row.failure_code,
    sourceState: row.invalidated_at ? "source_deleted" : "available",
    requestedPages: row.requested_pages ? JSON.parse(row.requested_pages) as number[] : null,
    ...(row.result_json ? readParsedResult(row.result_json, { id: row.id, materialId: row.material_id, version: row.version, originalSha256: row.original_sha256! })
      : { pages: null, coverage: null, parserRun: null, contractVersion: null }) };
}

export function decodeLearningText(bytes: Uint8Array): string {
  if (bytes.length > LEARNING_TEXT_MAX_BYTES) throw new LearningError(413, "text_too_large");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new LearningError(400, "invalid_utf8"); }
  if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) {
    throw new LearningError(400, "invalid_text");
  }
  return text;
}

function materialView(row: Omit<MaterialRow, "original"> & { byte_length: number }): LearningMaterial {
  return { id: row.id, title: row.title, kind: row.kind, filename: row.filename,
    byteLength: row.byte_length, createdAt: row.created_at, selected: Boolean(row.selected),
    ...(row.audio_metadata ? { audio: JSON.parse(row.audio_metadata) as LearningAudioMetadata } : {}),
    ...(row.pdf_metadata ? { pdf: JSON.parse(row.pdf_metadata) as LearningPdfMetadata } : {}) };
}

const materialTable = `CREATE TABLE IF NOT EXISTS learning_materials (
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES learning_pages(id),
  title TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('text','txt','pdf','audio')), filename TEXT,
  original BLOB, fingerprint TEXT, created_at TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, pdf_metadata TEXT, audio_metadata TEXT
);`;

/** Learning owns this database inside the authenticated account directory.
 * No uploads, Memory, retrieval, queue or Provider records are created here.
 * Immediate transactions serialize writes across connections/processes. Tombstones
 * retain only identifiers needed to reject replays; source bytes are cleared.
 */
export class LearningRepository {
  readonly database: Database.Database;
  constructor(readonly accountDataRoot: string, readonly accountId: string) {
    mkdirSync(accountDataRoot, { recursive: true });
    this.database = new Database(join(accountDataRoot, "learning-organizer.sqlite"));
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("foreign_keys = OFF"); // Rebuild the material CHECK in one transaction, without renaming FK targets.
    this.database.pragma("secure_delete = ON");
    // Bounded binary transactions need no persistent WAL source copies.
    this.database.pragma("journal_mode = DELETE");
    this.database.pragma("synchronous = FULL");
    try { this.database.transaction(() => {
      if (Number(this.database.pragma("user_version", { simple: true })) > 10) throw new Error("unsupported_learning_schema");
      this.database.exec(`
      CREATE TABLE IF NOT EXISTS learning_pages (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, title TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT
      );
      ${materialTable}
    `);
      const columns = this.database.pragma("table_info(learning_materials)") as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "pdf_metadata")) {
        // Rebuild the stage-1 CHECK constraint atomically; preserve original BLOBs,
        // IDs, fingerprints, scope, timestamps and tombstones byte-for-byte.
        this.database.exec(`ALTER TABLE learning_materials RENAME TO learning_materials_stage1;
          ${materialTable}
          INSERT INTO learning_materials(id,page_id,title,kind,filename,original,fingerprint,created_at,selected,deleted_at)
            SELECT id,page_id,title,kind,filename,original,fingerprint,created_at,selected,deleted_at FROM learning_materials_stage1 ORDER BY rowid;
          DROP TABLE learning_materials_stage1;`);
      }
      const audioColumns = this.database.pragma("table_info(learning_materials)") as Array<{ name: string }>;
      if (!audioColumns.some((column) => column.name === "audio_metadata")) {
        this.database.exec(`${materialTable.replace("learning_materials (", "learning_materials_audio_upgrade (")}
          INSERT INTO learning_materials_audio_upgrade(id,page_id,title,kind,filename,original,fingerprint,created_at,selected,deleted_at,pdf_metadata)
            SELECT id,page_id,title,kind,filename,original,fingerprint,created_at,selected,deleted_at,pdf_metadata FROM learning_materials ORDER BY rowid;
          DROP TABLE learning_materials;
          ALTER TABLE learning_materials_audio_upgrade RENAME TO learning_materials;`);
      }
      this.database.exec(`CREATE INDEX IF NOT EXISTS learning_material_page ON learning_materials(page_id);
        CREATE TABLE IF NOT EXISTS learning_parsed_documents (
          id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES learning_pages(id),
          material_id TEXT NOT NULL REFERENCES learning_materials(id), version INTEGER NOT NULL CHECK(version > 0),
          parser_name TEXT NOT NULL, parser_version TEXT NOT NULL, original_sha256 TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','processing','completed','failed')),
          failure_code TEXT, result_json TEXT, result_hash TEXT, invalidated_at TEXT,
          UNIQUE(material_id, version),
          CHECK((invalidated_at IS NOT NULL AND original_sha256 IS NULL AND result_json IS NULL AND result_hash IS NULL)
            OR (invalidated_at IS NULL AND original_sha256 IS NOT NULL AND
              ((status = 'completed' AND result_json IS NOT NULL AND result_hash IS NOT NULL)
                OR (status <> 'completed' AND result_json IS NULL AND result_hash IS NULL))))
        );
        CREATE INDEX IF NOT EXISTS learning_parsed_page ON learning_parsed_documents(page_id);
        `);
      const parsedColumns = this.database.pragma("table_info(learning_parsed_documents)") as Array<{ name: string }>;
      if (!parsedColumns.some((column) => column.name === "requested_pages")) this.database.exec("ALTER TABLE learning_parsed_documents ADD COLUMN requested_pages TEXT");
      if (!parsedColumns.some((column) => column.name === "pdf_execution_token")) this.database.exec("ALTER TABLE learning_parsed_documents ADD COLUMN pdf_execution_token TEXT");
      if (!parsedColumns.some((column) => column.name === "pdf_execution_lease_until")) this.database.exec("ALTER TABLE learning_parsed_documents ADD COLUMN pdf_execution_lease_until INTEGER NOT NULL DEFAULT 0");
      this.database.exec(`CREATE TABLE IF NOT EXISTS learning_framework_runs (
        id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES learning_pages(id), scope_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('generating','validating','completed','failed')),
        created_at TEXT NOT NULL, deadline INTEGER NOT NULL, failure TEXT, overview TEXT
      );
      CREATE INDEX IF NOT EXISTS learning_framework_page ON learning_framework_runs(page_id);
      CREATE UNIQUE INDEX IF NOT EXISTS learning_framework_active ON learning_framework_runs(page_id)
        WHERE status IN ('generating','validating');
      CREATE TABLE IF NOT EXISTS learning_framework_chapters (
        id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES learning_pages(id),
        run_id TEXT NOT NULL REFERENCES learning_framework_runs(id), revision INTEGER NOT NULL,
        original_json TEXT NOT NULL, current_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS learning_framework_chapter_page ON learning_framework_chapters(page_id);`);
      const runColumns = this.database.pragma("table_info(learning_framework_runs)") as Array<{ name: string }>;
      if (!runColumns.some((c) => c.name === "diagnostics_json")) this.database.exec("ALTER TABLE learning_framework_runs ADD COLUMN diagnostics_json TEXT");
      this.database.exec(`CREATE TABLE IF NOT EXISTS learning_audio_runs (
        id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES learning_pages(id), scope_json TEXT NOT NULL,
        status TEXT NOT NULL, deadline INTEGER NOT NULL, failure TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS learning_audio_active ON learning_audio_runs(page_id) WHERE status='processing';
      CREATE TABLE IF NOT EXISTS learning_audio_chunks (
        material_id TEXT NOT NULL REFERENCES learning_materials(id), chunk_index INTEGER NOT NULL,
        original_sha256 TEXT NOT NULL, start_seconds REAL NOT NULL, end_seconds REAL NOT NULL,
        bytes BLOB, request_id TEXT, transcript_json TEXT, state TEXT NOT NULL,
        PRIMARY KEY(material_id,chunk_index)
      );
      CREATE TABLE IF NOT EXISTS learning_audio_transcripts (
        material_id TEXT PRIMARY KEY REFERENCES learning_materials(id), original_sha256 TEXT NOT NULL,
        text TEXT NOT NULL, paragraphs_json TEXT NOT NULL
      );`);
      if ((this.database.pragma("foreign_key_check") as unknown[]).length) throw new Error("learning_migration_foreign_key_failed");
      this.database.exec(LEARNING_STUDY_SCHEMA);
      this.database.exec(LEARNING_QUIZ_SCHEMA);
      this.database.exec(LEARNING_PREPARATION_SCHEMA);
      this.database.exec(`CREATE TABLE IF NOT EXISTS learning_pdf_scopes (material_id TEXT PRIMARY KEY REFERENCES learning_materials(id), page_id TEXT NOT NULL REFERENCES learning_pages(id), selection_json TEXT NOT NULL);`);
      this.database.exec(`CREATE TABLE IF NOT EXISTS learning_pdf_requests (document_id TEXT NOT NULL REFERENCES learning_parsed_documents(id), material_id TEXT NOT NULL, page_id TEXT NOT NULL, physical_page INTEGER NOT NULL, request_id TEXT NOT NULL, status TEXT NOT NULL, response_json TEXT, remote_cleanup TEXT, PRIMARY KEY(document_id,physical_page));`);
      if (!(this.database.pragma("table_info(learning_pdf_requests)") as Array<{name:string}>).some(c=>c.name==="remote_cleanup")) this.database.exec("ALTER TABLE learning_pdf_requests ADD COLUMN remote_cleanup TEXT");
      if (!(this.database.pragma("table_info(learning_pdf_requests)") as Array<{name:string}>).some(c=>c.name==="request_context_json")) this.database.exec("ALTER TABLE learning_pdf_requests ADD COLUMN request_context_json TEXT");
      this.database.exec(LEARNING_GENERATION_SCHEMA);
      this.database.pragma("user_version = 10");
    }).immediate(); this.database.pragma("foreign_keys = ON"); } catch (error) { this.database.close(); throw error; }
  }
  close() { this.database.close(); }
  assertMaterialWritable(pageId: string, materialId: string) {
    this.pageRow(pageId);
    const row = this.database.prepare("SELECT page_id,deleted_at FROM learning_materials WHERE id=?").get(materialId) as { page_id: string; deleted_at: string | null } | undefined;
    if (row && row.page_id !== pageId) throw new LearningError(409, "submission_conflict");
    if (row?.deleted_at) throw new LearningError(410, "material_deleted");
  }

  private pageRow(id: string, includeDeleted = false): PageRow {
    const row = this.database.prepare("SELECT * FROM learning_pages WHERE id = ? AND account_id = ?")
      .get(id, this.accountId) as PageRow | undefined;
    if (!row) throw new LearningError(404, "page_not_found");
    if (row.deleted_at && !includeDeleted) throw new LearningError(410, "page_deleted");
    return row;
  }
  private touch(id: string) {
    this.database.prepare("UPDATE learning_pages SET updated_at = ?, revision = revision + 1 WHERE id = ?")
      .run(new Date().toISOString(), id);
  }
  list(): LearningPageSummary[] {
    return this.database.prepare(`SELECT p.id, p.title, p.created_at AS createdAt, p.updated_at AS updatedAt,
      (SELECT count(*) FROM learning_materials m WHERE m.page_id = p.id AND m.deleted_at IS NULL) AS materialCount
      FROM learning_pages p WHERE p.account_id = ? AND p.deleted_at IS NULL ORDER BY p.updated_at DESC, p.id`)
      .all(this.accountId) as LearningPageSummary[];
  }
  get(id: string): LearningPage {
    return this.database.transaction(() => {
      const row = this.pageRow(id);
      const materials = (this.database.prepare(`SELECT id, page_id, title, kind, filename, created_at, selected, pdf_metadata, audio_metadata,
        length(original) AS byte_length FROM learning_materials WHERE page_id = ? AND deleted_at IS NULL ORDER BY created_at, rowid`)
        .all(id) as Array<Omit<MaterialRow, "original"> & { byte_length: number }>).map(row => { const material = materialView(row);
        const scope = this.database.prepare("SELECT selection_json FROM learning_pdf_scopes WHERE material_id=? AND page_id=?").get(material.id,id) as { selection_json: string } | undefined;
        return scope ? { ...material, pdfStudy: JSON.parse(scope.selection_json) as PdfStudySelection } : material; });
      return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at,
        revision: row.revision, materialCount: materials.length, materials };
    })();
  }
  create(input: { id: string; title: string }): LearningPage {
    const value = CreateLearningPage.parse(input);
    return this.database.transaction(() => {
      const exists = this.database.prepare("SELECT id FROM learning_pages WHERE id = ?").get(value.id);
      if (exists) {
        const row = this.pageRow(value.id);
        if (row.title !== value.title) throw new LearningError(409, "submission_conflict");
      } else {
        const now = new Date().toISOString();
        this.database.prepare("INSERT INTO learning_pages(id, account_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
          .run(value.id, this.accountId, value.title, now, now);
      }
      return this.get(value.id);
    }).immediate();
  }
  saveMaterials(pageId: string, input: LearningOriginalInput[]): LearningPage {
    const metadata = LearningBatch.parse(input.map(({ id, title, kind }) => ({ id, title, kind })));
    if (input.filter((item) => item.kind === "text" || item.kind === "txt").reduce((sum, item) => sum + item.bytes.length, 0) > LEARNING_BATCH_MAX_BYTES) throw new LearningError(413, "batch_too_large");
    if (input.filter((item) => item.kind === "pdf").reduce((sum, item) => sum + item.bytes.length, 0) > LEARNING_PDF_BATCH_MAX_BYTES) throw new LearningError(413, "pdf_batch_too_large");
    if (input.filter((item) => item.kind === "audio").reduce((sum, item) => sum + item.bytes.length, 0) > LEARNING_AUDIO_BATCH_MAX_BYTES) throw new LearningError(413, "audio_batch_too_large");
    const prepared = input.map((item, index) => {
      if (item.kind === "pdf") {
        if (item.bytes.length > LEARNING_PDF_MAX_BYTES) throw new LearningError(413, "pdf_too_large");
        if (!item.filename || !/\.pdf$/iu.test(item.filename) || item.filename.length > 255 || /[\\/\u0000-\u001f]/u.test(item.filename)) throw new LearningError(400, "invalid_pdf_filename");
        if (!item.pdf || item.pdf.parsing !== "not_parsed" || item.pdf.originalVersion !== 1
          || item.pdf.sha256 !== createHash("sha256").update(item.bytes).digest("hex")
          || item.pdf.pageCount < 1 || item.pdf.pageCount > LEARNING_PDF_MAX_PAGES
          || item.pdf.pages.length !== item.pdf.pageCount) throw new LearningError(400, "invalid_pdf");
      } else if (item.kind === "audio") {
        if (item.bytes.length > LEARNING_AUDIO_MAX_BYTES) throw new LearningError(413, "audio_too_large");
        if (!item.filename || item.filename.length > 255 || /[\\/\u0000-\u001f]/u.test(item.filename)
          || !item.audio || item.audio.sha256 !== createHash("sha256").update(item.bytes).digest("hex")
          || item.audio.originalVersion !== 1 || item.audio.transcription !== "not_transcribed"
          || !Number.isFinite(item.audio.durationSeconds) || item.audio.durationSeconds <= 0 || item.audio.durationSeconds > LEARNING_AUDIO_MAX_SECONDS) throw new LearningError(400, "invalid_audio");
      } else decodeLearningText(item.bytes);
      if (item.kind === "txt" && (!item.filename || !/\.txt$/iu.test(item.filename) || item.filename.length > 255 || /[\\/\u0000-\u001f]/u.test(item.filename))) {
        throw new LearningError(400, "invalid_txt_filename");
      }
      const value = { ...item, ...metadata[index], filename: item.kind === "text" ? null : item.filename };
      const fingerprint = createHash("sha256").update(JSON.stringify([value.title, value.kind, value.filename])).update(value.bytes).digest("hex");
      return { ...value, fingerprint, pdfMetadata: item.kind === "pdf" ? JSON.stringify(item.pdf) : null, audioMetadata: item.kind === "audio" ? JSON.stringify(item.audio) : null };
    });
    return this.database.transaction(() => {
      this.pageRow(pageId);
      let added = false;
      for (const item of prepared) {
        const old = this.database.prepare("SELECT page_id, fingerprint, deleted_at FROM learning_materials WHERE id = ?")
          .get(item.id) as Pick<MaterialRow, "page_id" | "fingerprint" | "deleted_at"> | undefined;
        if (old) {
          if (old.page_id !== pageId) throw new LearningError(409, "submission_conflict");
          if (old.deleted_at) throw new LearningError(410, "material_deleted");
          if (old.fingerprint !== item.fingerprint) throw new LearningError(409, "submission_conflict");
          continue;
        }
        this.database.prepare(`INSERT INTO learning_materials(id, page_id, title, kind, filename, original, fingerprint, created_at, pdf_metadata, audio_metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(item.id, pageId, item.title, item.kind, item.filename, item.bytes, item.fingerprint, new Date().toISOString(), item.pdfMetadata, item.audioMetadata);
        added = true;
      }
      if (added) this.touch(pageId);
      return this.get(pageId);
    }).immediate();
  }
  source(pageId: string, materialId: string, historical?: ParsedTextBinding): LearningSource {
    return this.database.transaction(() => {
      this.pageRow(pageId);
      const row = this.database.prepare("SELECT *, length(original) AS byte_length FROM learning_materials WHERE id = ? AND page_id = ?")
        .get(materialId, pageId) as (MaterialRow & { byte_length: number }) | undefined;
      if (!row) throw new LearningError(404, "material_not_found");
      if (row.deleted_at || !row.original) throw new LearningError(410, "material_deleted");
      if (row.kind === "pdf") {
        const saved = this.database.prepare("SELECT selection_json FROM learning_pdf_scopes WHERE material_id=? AND page_id=?").get(materialId,pageId) as {selection_json:string}|undefined;
        if (!saved && !historical) throw new LearningError(409, "pdf_not_parsed");
        const selection: PdfStudySelection = historical ? { documentId: historical.documentId, physicalPages:[historical.physicalPage], acknowledgeUnverified:true, acknowledgeWarnings:false, excludedBlockIds:[] } : JSON.parse(saved!.selection_json);
        return parsedLearningSource(this,pageId,materialView(row),selection,historical);
      }
      if (row.kind === "audio") {
        const transcript = this.database.prepare("SELECT * FROM learning_audio_transcripts WHERE material_id=?").get(materialId) as { original_sha256: string; text: string; paragraphs_json: string } | undefined;
        if (!transcript) throw new LearningError(409, "audio_not_transcribed");
        if (transcript.original_sha256 !== createHash("sha256").update(row.original).digest("hex")) throw new LearningError(409, "source_changed");
        return { material: materialView(row), text: transcript.text, paragraphs: JSON.parse(transcript.paragraphs_json) as LearningParagraph[] };
      }
      const text = decodeLearningText(row.original);
      return { material: materialView(row), text, paragraphs: learningParagraphs(text) };
    })();
  }
  selectPdfStudy(pageId: string, materialId: string, input: unknown, revision: number): LearningPage {
    const selection = PdfStudySelection.parse(input);
    selection.physicalPages.sort((a,b)=>a-b);
    return this.database.transaction(()=>{
      const page=this.get(pageId), material=this.pdfOriginal(pageId,materialId,false).material;
      parsedLearningSource(this,pageId,material,selection);
      const json=JSON.stringify(selection), old=this.database.prepare("SELECT selection_json FROM learning_pdf_scopes WHERE material_id=? AND page_id=?").get(materialId,pageId) as {selection_json:string}|undefined;
      if(old?.selection_json===json)return page;
      if(page.revision!==revision)throw new LearningError(409,"source_changed");
      this.database.prepare("INSERT INTO learning_pdf_scopes(material_id,page_id,selection_json) VALUES(?,?,?) ON CONFLICT(material_id) DO UPDATE SET selection_json=excluded.selection_json").run(materialId,pageId,json);
      this.touch(pageId);return this.get(pageId);
    }).immediate();
  }
  pdfOriginal(pageId: string, materialId: string, includeBytes = true): { material: LearningMaterial; bytes?: Buffer } {
    return this.database.transaction(() => {
      this.pageRow(pageId);
      const row = this.database.prepare(`SELECT id,page_id,title,kind,filename,created_at,selected,deleted_at,pdf_metadata,audio_metadata,
        length(original) AS byte_length ${includeBytes ? ",original" : ""} FROM learning_materials WHERE id = ? AND page_id = ?`)
        .get(materialId, pageId) as MaterialRow & { byte_length: number } | undefined;
      if (!row) throw new LearningError(404, "material_not_found");
      if (row.deleted_at || !row.byte_length) throw new LearningError(410, "material_deleted");
      if (row.kind !== "pdf" || !row.pdf_metadata) throw new LearningError(404, "pdf_not_found");
      return { material: materialView(row), ...(includeBytes ? { bytes: row.original! } : {}) };
    })();
  }
  select(pageId: string, input: { revision: number; materialIds: string[] }): LearningPage {
    const value = LearningSelection.parse(input);
    return this.database.transaction(() => {
      const current = this.get(pageId);
      const wanted = new Set(value.materialIds);
      if (value.materialIds.some((id) => !current.materials.some((m) => m.id === id))) throw new LearningError(409, "source_changed");
      const unchanged = current.materials.every((m) => m.selected === wanted.has(m.id));
      if (unchanged) return current; // Safe replay after a lost response.
      if (current.revision !== value.revision) throw new LearningError(409, "source_changed");
      this.database.prepare("UPDATE learning_materials SET selected = 0 WHERE page_id = ?").run(pageId);
      const select = this.database.prepare("UPDATE learning_materials SET selected = 1 WHERE id = ? AND page_id = ? AND deleted_at IS NULL");
      for (const id of value.materialIds) select.run(id, pageId);
      this.touch(pageId);
      return this.get(pageId);
    }).immediate();
  }

  private parsedRow(pageId: string, documentId: string): ParsedDocumentRow {
    this.pageRow(pageId); // Check account before any document/content lookup.
    const row = this.database.prepare("SELECT * FROM learning_parsed_documents WHERE id = ? AND page_id = ?")
      .get(documentId, pageId) as ParsedDocumentRow | undefined;
    if (!row) throw new LearningError(404, "parsed_document_not_found");
    return row;
  }
  private parsedOriginal(row: ParsedDocumentRow): LearningPdfMetadata {
    if (row.invalidated_at) throw new LearningError(410, "material_deleted");
    const pdf = this.pdfOriginal(row.page_id, row.material_id, false).material.pdf!;
    if (pdf.sha256 !== row.original_sha256) throw new LearningError(409, "source_changed");
    return pdf;
  }
  /** One ID per parse attempt; a retry of that ID never creates a second version. */
  createParsedDocument(pageId: string, input: CreateParsedDocument): ParsedDocument {
    const value = CreateParsedDocument.parse(input);
    return this.database.transaction(() => {
      const original = this.pdfOriginal(pageId, value.materialId, false).material.pdf!;
      if (original.sha256 !== value.originalSha256 || original.originalVersion !== value.originalVersion) {
        throw new LearningError(409, "source_changed");
      }
      const requested = [...(value.requestedPages ?? original.pages.map((p) => p.physicalPage))].sort((a, b) => a - b);
      if (requested.some((p) => p > original.pageCount)) throw new LearningError(400, "parsed_page_coverage_mismatch");
      const requestedJson = JSON.stringify(requested);
      const old = this.database.prepare("SELECT * FROM learning_parsed_documents WHERE id = ?").get(value.id) as ParsedDocumentRow | undefined;
      if (old) {
        if (old.page_id !== pageId || old.material_id !== value.materialId || old.original_sha256 !== value.originalSha256
          || old.parser_name !== value.parser.name || old.parser_version !== value.parser.version
          || (old.requested_pages ?? JSON.stringify(original.pages.map((p) => p.physicalPage))) !== requestedJson) throw new LearningError(409, "submission_conflict");
        return parsedDocumentView(old);
      }
      const next = this.database.prepare("SELECT coalesce(max(version), 0) + 1 AS version FROM learning_parsed_documents WHERE material_id = ?")
        .get(value.materialId) as { version: number };
      const now = new Date().toISOString();
      this.database.prepare(`INSERT INTO learning_parsed_documents
        (id,page_id,material_id,version,parser_name,parser_version,original_sha256,created_at,updated_at,status,requested_pages)
        VALUES (?,?,?,?,?,?,?,?,?,'pending',?)`)
        .run(value.id, pageId, value.materialId, next.version, value.parser.name, value.parser.version, value.originalSha256, now, now, requestedJson);
      return parsedDocumentView(this.parsedRow(pageId, value.id));
    }).immediate();
  }
  getParsedDocument(pageId: string, documentId: string): ParsedDocument {
    return this.database.transaction(() => {
      const row = this.parsedRow(pageId, documentId);
      if (!row.invalidated_at) this.parsedOriginal(row);
      return parsedDocumentView(row);
    })();
  }
  listParsedDocuments(pageId: string, materialId: string): Array<Omit<ParsedDocument, "pages">> {
    return this.database.transaction(() => {
      this.pageRow(pageId);
      if (!this.database.prepare("SELECT id FROM learning_materials WHERE id = ? AND page_id = ?").get(materialId, pageId)) {
        throw new LearningError(404, "material_not_found");
      }
      // Do not load all old result bodies just to show version/status receipts.
      const rows = this.database.prepare(`SELECT id,page_id,material_id,version,parser_name,parser_version,original_sha256,
        created_at,updated_at,status,failure_code,invalidated_at,requested_pages,NULL AS result_json,NULL AS result_hash
        FROM learning_parsed_documents WHERE page_id = ? AND material_id = ? ORDER BY version`)
        .all(pageId, materialId) as ParsedDocumentRow[];
      return rows.map((row) => { const { pages: _pages, ...receipt } = parsedDocumentView(row); return receipt; });
    })();
  }
  startParsedDocument(pageId: string, documentId: string): ParsedDocument {
    return this.database.transaction(() => {
      const row = this.parsedRow(pageId, documentId); this.parsedOriginal(row);
      if (row.status === "processing") return parsedDocumentView(row);
      if (row.status !== "pending") throw new LearningError(409, "parsed_document_terminal");
      this.database.prepare("UPDATE learning_parsed_documents SET status = 'processing', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), documentId);
      return parsedDocumentView(this.parsedRow(pageId, documentId));
    }).immediate();
  }
  /** Input is normalized parser output, never a provider response or an arbitrary JSON blob. */
  completeParsedDocument(pageId: string, documentId: string, input: unknown): ParsedDocument {
    return this.database.transaction(() => {
      const row = this.parsedRow(pageId, documentId); const original = this.parsedOriginal(row);
      let result;
      try { result = prepareParsedResult(input, { id: row.id, materialId: row.material_id, version: row.version, originalSha256: row.original_sha256! }, original,
        row.requested_pages ? JSON.parse(row.requested_pages) as number[] : original.pages.map((p) => p.physicalPage)); }
      catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (["parsed_identity_mismatch", "parsed_page_coverage_mismatch", "invalid_issue_scope", "invalid_page_execution", "invalid_reading_order",
          "render_geometry_mismatch", "invalid_source_mapping", "region_outside_render"].includes(code)) throw new LearningError(400, code);
        throw error;
      }
      const json = JSON.stringify(result);
      if (Buffer.byteLength(json, "utf8") > PARSED_DOCUMENT_MAX_BYTES) throw new LearningError(413, "parsed_result_too_large");
      const hash = createHash("sha256").update(json).digest("hex");
      if (row.status === "completed") {
        if (row.result_hash !== hash) throw new LearningError(409, "submission_conflict");
        return parsedDocumentView(row);
      }
      if (row.status !== "processing") throw new LearningError(409, "parsed_document_not_processing");
      this.database.prepare(`UPDATE learning_parsed_documents SET status = 'completed', result_json = ?, result_hash = ?, updated_at = ?, pdf_execution_token=NULL,pdf_execution_lease_until=0 WHERE id = ?`)
        .run(json, hash, new Date().toISOString(), documentId);
      return parsedDocumentView(this.parsedRow(pageId, documentId));
    }).immediate();
  }
  failParsedDocument(pageId: string, documentId: string, failure: ParsedDocument["failureCode"]): ParsedDocument {
    const code = ParsedFailureCode.parse(failure); // Never persist raw provider errors/paths/credentials.
    return this.database.transaction(() => {
      const row = this.parsedRow(pageId, documentId); this.parsedOriginal(row);
      if (row.status === "failed" && row.failure_code === code) return parsedDocumentView(row);
      if (row.status === "completed" || row.status === "failed") throw new LearningError(409, "parsed_document_terminal");
      this.database.prepare("UPDATE learning_parsed_documents SET status = 'failed', failure_code = ?, updated_at = ?,pdf_execution_token=NULL,pdf_execution_lease_until=0 WHERE id = ?")
        .run(code, new Date().toISOString(), documentId);
      return parsedDocumentView(this.parsedRow(pageId, documentId));
    }).immediate();
  }
  parsedBlockSource(pageId: string, documentId: string, blockId: string): ParsedBlockSource {
    return this.database.transaction((): ParsedBlockSource => {
      const document = this.getParsedDocument(pageId, documentId);
      if (document.sourceState === "source_deleted") return { state: "source_deleted", documentId, materialId: document.materialId };
      if (document.status !== "completed") throw new LearningError(409, "parsed_document_not_completed");
      for (const page of document.pages!) {
        const block = page.blocks.find((b) => b.id === blockId);
        if (block) return { state: "available", source: parsedSource(document, block), block,
          pageIssues: document.pages!.filter((p) => block.source_regions.some((r) => r.physical_page === p.physical_page)).flatMap((p) => p.issues) };
      }
      throw new LearningError(404, "parsed_block_not_found");
    })();
  }
  /** Observations/necessary conditions only. This does not decide generation admission. */
  inspectParsedScope(pageId: string, documentId: string, selectedPages?: number[]): ParsedScopeInspection {
    return this.database.transaction((): ParsedScopeInspection => {
      const document = this.getParsedDocument(pageId, documentId);
      if (document.sourceState === "source_deleted") throw new LearningError(410, "material_deleted");
      if (document.status !== "completed") throw new LearningError(409, "parsed_document_not_completed");
      const selected = selectedPages ?? document.coverage!.requested_pages;
      if (!selected.length || new Set(selected).size !== selected.length || selected.some((p) => !Number.isInteger(p) || p < 1 || p > document.coverage!.original_page_count)) throw new LearningError(400, "invalid_scope");
      const blocks = document.pages!.flatMap((p) => p.blocks.filter((b) => selected.includes(p.physical_page) || b.source_regions.some((r) => selected.includes(r.physical_page))))
        .map((block) => ({ block, source: parsedSource(document, block) }));
      const involved = new Set([...selected, ...blocks.flatMap(({ block }) => block.source_regions.map((r) => r.physical_page))]);
      const ids = new Set(blocks.map(({ block }) => block.id));
      const memberKey = (r: typeof blocks[number]["block"]["source_regions"][number]) => JSON.stringify([r.member_id, r.physical_page, r.parser_ref]);
      const members = new Set(blocks.flatMap(({ block }) => block.source_regions.map(memberKey)));
      for (const b of document.pages!.flatMap((p) => p.blocks)) {
        if (b.source_regions.some((r) => members.has(memberKey(r)))) ids.add(b.id);
      }
      const issues = document.pages!.flatMap((p) => [...p.issues, ...p.blocks.flatMap((b) => [...b.quality.automatic_signals, ...b.quality.text_layer_signals, ...b.quality.prior_findings ?? []])])
        .filter((i) => i.scope.physical_pages.some((p) => involved.has(p)) && (!i.scope.block_ids.length || i.scope.block_ids.some((id) => ids.has(id))));
      const missing = selected.filter((p) => !document.coverage!.requested_pages.includes(p));
      const failed = selected.filter((p) => document.coverage!.failed_pages.includes(p));
      const pageAssessments = document.pages!.filter((p) => involved.has(p.physical_page)).map((p) => p.reading_order.assessment);
      return { documentId, version: document.version, selected_pages: [...selected], coverage: document.coverage!, missing_pages: missing, failed_pages: failed, issues, blocks,
        conditions: { selected_pages_succeeded: !missing.length && !failed.length,
          has_warning: issues.some((i) => i.severity === "warning") || pageAssessments.some((q) => q.status === "warning") || blocks.some(({ block }) => block.quality.status === "warning"),
          has_blocked: !!missing.length || !!failed.length || issues.some((i) => i.severity === "blocked") || pageAssessments.some((q) => q.status === "blocked") || blocks.some(({ block }) => block.quality.status === "blocked"),
          content_completeness: "not_established" } };
    })();
  }
  deleteMaterial(pageId: string, materialId: string): LearningPage {
    return this.database.transaction(() => {
      this.pageRow(pageId);
      const row = this.database.prepare("SELECT deleted_at FROM learning_materials WHERE id = ? AND page_id = ?")
        .get(materialId, pageId) as { deleted_at: string | null } | undefined;
      if (!row) throw new LearningError(404, "material_not_found");
      if (!row.deleted_at) {
        this.database.prepare("DELETE FROM learning_generation_parts WHERE page_id=? AND EXISTS (SELECT 1 FROM json_each(material_ids) WHERE value=?)").run(pageId, materialId);
        this.database.prepare(`DELETE FROM learning_preparation_runs WHERE page_id=? AND EXISTS
          (SELECT 1 FROM json_each(binding_json) WHERE json_extract(value,'$.materialId')=?)`).run(pageId, materialId);
        this.database.prepare(`UPDATE learning_quiz_runs SET status='failed',failure='material_deleted' WHERE page_id=? AND status='generating'
          AND EXISTS (SELECT 1 FROM json_each(binding_json,'$.materials') WHERE json_extract(value,'$.materialId')=?)`).run(pageId, materialId);
        this.database.prepare(`UPDATE learning_overview_runs SET status='failed',failure='material_deleted' WHERE page_id=? AND status='generating'
          AND EXISTS (SELECT 1 FROM json_each(binding_json,'$.sources') WHERE json_extract(value,'$.materialId')=?)`).run(pageId, materialId);
        this.database.prepare(`UPDATE learning_node_turns SET status='failed',failure='material_deleted' WHERE page_id=? AND status='generating'
          AND conversation_id IN (SELECT id FROM learning_node_conversations WHERE page_id=? AND EXISTS
          (SELECT 1 FROM json_each(binding_json,'$.sources') WHERE json_extract(value,'$.materialId')=?))`).run(pageId, pageId, materialId);
        this.database.prepare("DELETE FROM learning_audio_chunks WHERE material_id=?").run(materialId);
        this.database.prepare("DELETE FROM learning_audio_transcripts WHERE material_id=?").run(materialId);
        this.database.prepare(`UPDATE learning_audio_runs SET status='failed',failure='material_deleted' WHERE page_id=? AND status='processing'
          AND EXISTS (SELECT 1 FROM json_each(scope_json) WHERE value=?)`).run(pageId, materialId);
        // Keep published learning results; fence only unfinished work using this source.
        this.database.prepare(`UPDATE learning_framework_runs SET status='failed',failure='material_deleted'
          WHERE page_id=? AND status IN ('generating','validating') AND EXISTS
          (SELECT 1 FROM json_each(scope_json) WHERE json_extract(value,'$.materialId')=?)`).run(pageId, materialId);
        this.database.prepare("DELETE FROM learning_pdf_requests WHERE page_id=? AND material_id=?").run(pageId,materialId);
        this.database.prepare("DELETE FROM learning_pdf_scopes WHERE page_id=? AND material_id=?").run(pageId,materialId);
        this.database.prepare(`UPDATE learning_parsed_documents SET result_json = NULL, result_hash = NULL,
          original_sha256 = NULL, requested_pages = NULL, pdf_execution_token=NULL,pdf_execution_lease_until=0, invalidated_at = ?, updated_at = ? WHERE material_id = ? AND page_id = ?`)
          .run(new Date().toISOString(), new Date().toISOString(), materialId, pageId);
        this.database.prepare(`UPDATE learning_materials SET title = '', filename = NULL, original = NULL,
          fingerprint = NULL, pdf_metadata = NULL, audio_metadata = NULL, selected = 0, deleted_at = ? WHERE id = ? AND page_id = ?`)
          .run(new Date().toISOString(), materialId, pageId);
        this.touch(pageId);
      }
      return this.get(pageId);
    }).immediate();
  }
  deletePage(pageId: string): void {
    this.database.transaction(() => {
      const page = this.pageRow(pageId, true);
      if (page.deleted_at) return;
      this.database.prepare("DELETE FROM learning_generation_parts WHERE page_id=?").run(pageId);
      this.database.prepare("DELETE FROM learning_preparation_runs WHERE page_id=?").run(pageId);
      this.database.prepare("DELETE FROM learning_quiz_attempts WHERE page_id=?").run(pageId);
      this.database.prepare("DELETE FROM learning_quiz_runs WHERE page_id=?").run(pageId);
      this.database.prepare("DELETE FROM learning_answer_notes WHERE page_id=?").run(pageId);
      this.database.prepare("DELETE FROM learning_node_turns WHERE page_id=?").run(pageId);
      this.database.prepare("DELETE FROM learning_node_conversations WHERE page_id=?").run(pageId);
      this.database.prepare("DELETE FROM learning_overview_runs WHERE page_id=?").run(pageId);
      this.database.prepare("DELETE FROM learning_audio_chunks WHERE material_id IN (SELECT id FROM learning_materials WHERE page_id=?)").run(pageId);
      this.database.prepare("DELETE FROM learning_audio_transcripts WHERE material_id IN (SELECT id FROM learning_materials WHERE page_id=?)").run(pageId);
      this.database.prepare("DELETE FROM learning_audio_runs WHERE page_id=?").run(pageId);
      this.database.prepare("DELETE FROM learning_framework_chapters WHERE page_id = ?").run(pageId);
      this.database.prepare("DELETE FROM learning_framework_runs WHERE page_id = ?").run(pageId);
      this.database.prepare("DELETE FROM learning_pdf_requests WHERE page_id = ?").run(pageId);
      this.database.prepare("DELETE FROM learning_pdf_scopes WHERE page_id = ?").run(pageId);
      this.database.prepare("DELETE FROM learning_parsed_documents WHERE page_id = ?").run(pageId);
      this.database.prepare("DELETE FROM learning_materials WHERE page_id = ?").run(pageId);
      this.database.prepare("UPDATE learning_pages SET title = '', deleted_at = ?, revision = revision + 1 WHERE id = ?")
        .run(new Date().toISOString(), pageId);
    }).immediate();
  }
}
