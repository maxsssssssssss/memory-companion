import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { LearningId, type LearningAudioMetadata, type LearningParagraph } from "@/lib/domain/learning";
import { LearningError, type LearningRepository } from "./repository";
import type { PreparedAudioChunk } from "./audio-files";

export const AudioScope = z.object({ id: LearningId, materialIds: z.array(LearningId).min(1).max(50)
  .refine((ids) => new Set(ids).size === ids.length) }).strict();
export type AudioRun = { id: string; materialIds: string[]; status: string; deadline: number; failure: string | null };
type Run = { id: string; page_id: string; scope_json: string; status: string; deadline: number; failure: string | null };
export type AudioChunkRow = { material_id: string; chunk_index: number; original_sha256: string; start_seconds: number; end_seconds: number;
  bytes: Buffer | null; request_id: string | null; transcript_json: string | null; state: "pending" | "submitted" | "completed" };
const toRun = (r: Run): AudioRun => ({ id: r.id, materialIds: JSON.parse(r.scope_json), status: r.status, deadline: r.deadline, failure: r.failure });
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
export const TimedText = z.array(z.object({ text: z.string().trim().min(1).max(20000), startSeconds: z.number().finite().nonnegative(),
  endSeconds: z.number().finite().positive() }).strict()).min(1).max(20000);

/** Learning-only ASR checkpoints. No JsonStore uploads, identities or retrieval. */
export class LearningAudioRepository {
  constructor(readonly learning: LearningRepository) {}
  private get db() { return this.learning.database; }
  original(pageId: string, materialId: string) {
    const material = this.learning.get(pageId).materials.find((m) => m.id === materialId);
    if (!material || material.kind !== "audio" || !material.audio) throw new LearningError(404, "material_not_found");
    const row = this.db.prepare("SELECT original FROM learning_materials WHERE id=? AND page_id=? AND deleted_at IS NULL").get(materialId, pageId) as { original: Buffer };
    if (!row?.original || hash(row.original) !== material.audio.sha256) throw new LearningError(409, "source_changed");
    return { material, bytes: row.original, audio: material.audio };
  }
  private expire(pageId: string) {
    const rows = this.db.prepare("SELECT * FROM learning_audio_runs WHERE page_id=? AND status='processing' AND deadline<=?").all(pageId, Date.now()) as Run[];
    for (const row of rows) this.fail(pageId, row.id, "audio_interrupted");
  }
  list(pageId: string) {
    return this.db.transaction(() => {
      this.learning.get(pageId); this.expire(pageId);
      const active = this.db.prepare("SELECT id FROM learning_audio_runs WHERE page_id=? AND status='processing'").get(pageId);
      if (!active) for (const m of this.learning.get(pageId).materials) {
        if (m.audio?.transcription === "processing") this.metadata(pageId, m.id, { transcription: "failed", failure: "audio_interrupted" });
      }
      return (this.db.prepare("SELECT * FROM learning_audio_runs WHERE page_id=? ORDER BY rowid").all(pageId) as Run[]).map(toRun);
    }).immediate();
  }
  begin(pageId: string, input: unknown) {
    const value = AudioScope.parse(input); const scope = JSON.stringify([...value.materialIds].sort());
    return this.db.transaction(() => {
      this.learning.get(pageId); this.expire(pageId);
      const old = this.db.prepare("SELECT * FROM learning_audio_runs WHERE id=?").get(value.id) as Run | undefined;
      if (old) {
        if (old.page_id !== pageId || old.scope_json !== scope) throw new LearningError(409, "submission_conflict");
        return { created: false, run: toRun(old) };
      }
      if (this.db.prepare("SELECT id FROM learning_audio_runs WHERE page_id=? AND status='processing'").get(pageId)) throw new LearningError(409, "audio_busy");
      for (const id of value.materialIds) this.original(pageId, id);
      this.db.prepare("INSERT INTO learning_audio_runs(id,page_id,scope_json,status,deadline) VALUES(?,?,?,'processing',?)").run(value.id, pageId, scope, Date.now() + 12 * 60000);
      for (const id of value.materialIds) if (this.original(pageId, id).audio.transcription !== "completed") this.metadata(pageId, id, { transcription: "processing", failure: undefined });
      return { created: true, run: toRun(this.row(pageId, value.id)) };
    }).immediate();
  }
  private row(pageId: string, id: string) {
    this.learning.get(pageId);
    const row = this.db.prepare("SELECT * FROM learning_audio_runs WHERE page_id=? AND id=?").get(pageId, id) as Run | undefined;
    if (!row) throw new LearningError(409, "audio_terminal");
    return row;
  }
  assertActive(pageId: string, runId: string, materialId?: string) {
    const run = this.row(pageId, runId);
    if (run.status !== "processing" || run.deadline <= Date.now()) throw new LearningError(409, "audio_terminal");
    if (materialId) {
      if (!(JSON.parse(run.scope_json) as string[]).includes(materialId)) throw new LearningError(404, "material_not_found");
      this.original(pageId, materialId);
    }
  }
  private metadata(pageId: string, materialId: string, patch: Partial<LearningAudioMetadata>) {
    const material = this.learning.get(pageId).materials.find((m) => m.id === materialId);
    if (!material?.audio) throw new LearningError(404, "material_not_found");
    this.db.prepare("UPDATE learning_materials SET audio_metadata=? WHERE id=? AND page_id=? AND deleted_at IS NULL").run(JSON.stringify({ ...material.audio, ...patch }), materialId, pageId);
  }
  chunks(pageId: string, materialId: string): AudioChunkRow[] {
    this.original(pageId, materialId);
    return this.db.prepare("SELECT * FROM learning_audio_chunks WHERE material_id=? ORDER BY chunk_index").all(materialId) as AudioChunkRow[];
  }
  savePlan(pageId: string, runId: string, materialId: string, chunks: PreparedAudioChunk[]) {
    this.db.transaction(() => {
      this.assertActive(pageId, runId, materialId);
      if (this.chunks(pageId, materialId).length) return;
      const original = this.original(pageId, materialId);
      if (!chunks.length || chunks.length > 25 || chunks.some((c, i) => c.index !== i || !c.bytes.length || c.bytes.length > 3 * 1024 * 1024
        || !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end <= c.start || c.start !== (i ? chunks[i - 1].end : 0))
        || Math.abs(chunks.at(-1)!.end - original.audio.durationSeconds) > 0.01) throw new LearningError(422, "audio_invalid_plan");
      for (const c of chunks) this.db.prepare(`INSERT INTO learning_audio_chunks(material_id,chunk_index,original_sha256,start_seconds,end_seconds,bytes,state)
        VALUES(?,?,?,?,?,?,'pending')`).run(materialId, c.index, original.audio.sha256, c.start, c.end, c.bytes);
      this.metadata(pageId, materialId, { totalChunks: chunks.length });
    }).immediate();
  }
  claimChunk(pageId: string, runId: string, materialId: string, index: number) {
    return this.db.transaction(() => {
      this.assertActive(pageId, runId, materialId);
      const chunk = this.chunks(pageId, materialId)[index];
      if (!chunk || chunk.state === "completed" || !chunk.bytes) throw new LearningError(409, "audio_terminal");
      if (chunk.original_sha256 !== this.original(pageId, materialId).audio.sha256) throw new LearningError(409, "source_changed");
      const resume = chunk.state === "submitted";
      const requestId = chunk.request_id ?? `learning_${randomUUID()}`;
      // Persist the intent before network I/O. Unknown outcomes can only query this ID.
      this.db.prepare("UPDATE learning_audio_chunks SET request_id=?,state='submitted' WHERE material_id=? AND chunk_index=?").run(requestId, materialId, index);
      this.db.prepare("UPDATE learning_audio_runs SET deadline=? WHERE id=?").run(Date.now() + 12 * 60000, runId);
      return { ...chunk, requestId, resume };
    }).immediate();
  }
  completeChunk(pageId: string, runId: string, materialId: string, index: number, requestId: string, value: unknown) {
    const segments = TimedText.parse(value);
    this.db.transaction(() => {
      this.assertActive(pageId, runId, materialId);
      const chunk = this.chunks(pageId, materialId)[index];
      if (!chunk || chunk.state !== "submitted" || chunk.request_id !== requestId) throw new LearningError(409, "audio_terminal");
      if (segments.some((s, i) => s.startSeconds < chunk.start_seconds || s.endSeconds > chunk.end_seconds || s.endSeconds <= s.startSeconds
        || (i > 0 && s.startSeconds < segments[i - 1].startSeconds))) throw new LearningError(422, "audio_invalid_timestamps");
      this.db.prepare("UPDATE learning_audio_chunks SET transcript_json=?,state='completed',bytes=NULL WHERE material_id=? AND chunk_index=?")
        .run(JSON.stringify(segments), materialId, index);
      this.metadata(pageId, materialId, { completedChunks: this.chunks(pageId, materialId).filter((c) => c.state === "completed").length });
    }).immediate();
  }
  publish(pageId: string, runId: string, materialId: string) {
    this.db.transaction(() => {
      this.assertActive(pageId, runId, materialId);
      const chunks = this.chunks(pageId, materialId);
      if (!chunks.length || chunks.some((c) => c.state !== "completed")) throw new LearningError(409, "audio_incomplete");
      const segments = chunks.flatMap((c) => TimedText.parse(JSON.parse(c.transcript_json!)));
      let text = ""; const paragraphs: LearningParagraph[] = [];
      for (const s of segments) {
        if (text) text += "\n\n";
        const start = text.length; text += s.text;
        paragraphs.push({ number: paragraphs.length + 1, start, end: text.length, ...s });
      }
      if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new LearningError(413, "text_too_large");
      this.db.prepare("INSERT OR IGNORE INTO learning_audio_transcripts(material_id,original_sha256,text,paragraphs_json) VALUES(?,?,?,?)")
        .run(materialId, this.original(pageId, materialId).audio.sha256, text, JSON.stringify(paragraphs));
      this.metadata(pageId, materialId, { transcription: "completed", failure: undefined });
    }).immediate();
  }
  finish(pageId: string, runId: string, failure: string | null) {
    this.db.transaction(() => {
      this.assertActive(pageId, runId);
      this.db.prepare("UPDATE learning_audio_runs SET status=?,failure=? WHERE id=?").run(failure ? "failed" : "completed", failure, runId);
    }).immediate();
  }
  fail(pageId: string, runId: string, code: string) {
    this.db.transaction(() => {
      const run = this.row(pageId, runId);
      if (run.status !== "processing") return;
      this.db.prepare("UPDATE learning_audio_runs SET status='failed',failure=? WHERE id=?").run(code, runId);
      for (const id of JSON.parse(run.scope_json) as string[]) {
        const material = this.learning.get(pageId).materials.find((m) => m.id === id);
        if (material?.audio && material.audio.transcription !== "completed") this.metadata(pageId, id, { transcription: "failed", failure: code });
      }
    }).immediate();
  }
  markMaterialFailed(pageId: string, materialId: string, code: string) {
    this.metadata(pageId, materialId, { transcription: "failed", failure: code });
  }
  servedChunk(pageId: string, runId: string, materialId: string, index: number) {
    this.assertActive(pageId, runId, materialId);
    const row = this.chunks(pageId, materialId)[index];
    if (!row?.bytes || row.state !== "submitted") throw new LearningError(404, "audio_unavailable");
    return row.bytes;
  }
}
