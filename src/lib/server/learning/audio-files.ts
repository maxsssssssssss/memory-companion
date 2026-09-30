import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep, toNamespacedPath } from "node:path";
import { LearningId, LEARNING_AUDIO_MAX_BYTES, LEARNING_AUDIO_MAX_SECONDS, type LearningAudioMetadata } from "@/lib/domain/learning";
import { validateAudioUpload } from "@/lib/server/uploads/validation";
import { measureDailyReflectionAudio, DailyReflectionDurationProbeError } from "@/lib/server/daily-reflection/duration-audio-tools";
import { planAudioChunks, splitAudioWithFfmpeg } from "@/lib/server/transcription/chunks/audio-planner";
import { LearningError } from "./repository";

// Only disposable private processing copies live on disk. Originals/checkpoints are
// transactional account SQLite BLOBs. No generic uploads or analysis pipeline.
export function learningAudioTempPath(accountRoot: string, pageId: string, materialId?: string) {
  LearningId.parse(pageId); if (materialId) LearningId.parse(materialId);
  return join(accountRoot, "learning-audio-temp", pageId, ...(materialId ? [materialId] : []));
}
export async function cleanupLearningAudioTemp(accountRoot: string, pageId: string, materialId?: string) {
  const target = resolve(learningAudioTempPath(accountRoot, pageId, materialId));
  if (!target.startsWith(resolve(accountRoot, "learning-audio-temp") + sep)) throw new LearningError(503, "learning_cleanup_failed");
  try { await rm(toNamespacedPath(target), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch { throw new LearningError(503, "learning_cleanup_failed"); }
}
type TemporaryScope = { directory: string; assertWritable: () => void };
async function withAudioFile<T>(bytes: Buffer, work: (path: string) => Promise<T>, scope?: TemporaryScope) {
  scope?.assertWritable();
  const parent = scope?.directory ?? tmpdir();
  await mkdir(toNamespacedPath(parent), { recursive: true });
  // Windows mkdtemp does not automatically prefix paths beyond MAX_PATH.
  const root = (await mkdtemp(toNamespacedPath(join(parent, "learning-audio-")))).replace(/^\\\\\?\\/u, "");
  try { scope?.assertWritable(); const file = toNamespacedPath(join(root, "original")); await writeFile(file, bytes, { flag: "wx" }); scope?.assertWritable(); return await work(file); }
  finally {
    const target = resolve(root);
    if (!target.startsWith(resolve(parent) + sep) || !target.split(sep).at(-1)?.startsWith("learning-audio-")) throw new Error("invalid_temporary_path");
    await rm(toNamespacedPath(target), { recursive: true, force: true });
  }
}
export async function inspectLearningAudio(bytes: Buffer, filename: string, mimeType: string, signal?: AbortSignal, scope?: TemporaryScope): Promise<LearningAudioMetadata> {
  if (bytes.length > LEARNING_AUDIO_MAX_BYTES) throw new LearningError(413, "audio_too_large");
  if (!bytes.length || filename.length > 255 || /[\\/\u0000-\u001f]/u.test(filename)
    || !validateAudioUpload({ name: filename, type: mimeType, size: bytes.length }).ok) throw new LearningError(400, "invalid_audio");
  try {
    const measured = await withAudioFile(bytes, (filePath) => measureDailyReflectionAudio(filePath, { signal, budgetMs: 75000, localFilesOnly: true, assertWritable: scope?.assertWritable }), scope);
    if (measured.durationSeconds > LEARNING_AUDIO_MAX_SECONDS) throw new LearningError(413, "audio_too_long");
    return { sha256: createHash("sha256").update(bytes).digest("hex"), originalVersion: 1, mimeType,
      durationSeconds: measured.durationSeconds, transcription: "not_transcribed", completedChunks: 0, totalChunks: 0 };
  } catch (error) {
    if (error instanceof LearningError) throw error;
    if (error instanceof DailyReflectionDurationProbeError) {
      // Enum only; never emit file paths, tool stderr or source bytes.
      console.warn("[learning-audio] validation_failed", { code: error.code });
      if (error.code === "daily_reflection_duration_tool_unavailable") throw new LearningError(503, "audio_tools_unavailable");
      if (error.code.includes("timeout")) throw new LearningError(422, "audio_resource_limit");
    }
    throw new LearningError(422, "invalid_audio");
  }
}
export type PreparedAudioChunk = { index: number; start: number; end: number; bytes: Buffer };
export async function prepareLearningAudio(bytes: Buffer, metadata: LearningAudioMetadata, materialId: string, signal?: AbortSignal, scope?: TemporaryScope): Promise<PreparedAudioChunk[]> {
  return withAudioFile(bytes, async (filePath) => {
    // Force the existing first-track -> mono 16k MP3 normalization even for one
    // short chunk. The source BLOB remains byte-for-byte unchanged.
    const chunks = await planAudioChunks({ uploadId: materialId, filePath, mimeType: metadata.mimeType, chunkDurationSeconds: 300,
      authoritativeAudio: { uploadId: materialId, effectiveDurationMs: Math.round(metadata.durationSeconds * 1000), extractFirstAudioTrack: true } },
      { splitAudio: (input) => splitAudioWithFfmpeg({ ...input, signal, timeoutMs: 120000 }) });
    const result: PreparedAudioChunk[] = [];
    for (const chunk of chunks) result.push({ index: chunk.index, start: chunk.startSeconds, end: chunk.endSeconds, bytes: await readFile(chunk.source.path!) });
    return result;
  }, scope);
}
