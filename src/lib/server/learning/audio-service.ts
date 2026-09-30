import { z } from "zod";
import { createTranscriptionAudioAccessCapability, verifyTranscriptionAudioAccessCapability,
  TRANSCRIPTION_AUDIO_ACCESS_TTL_SECONDS } from "@/lib/server/transcription/audio-access-capability";
import { requestCompanyAsr } from "@/lib/server/transcription/speaker-asr-provider";
import { prepareLearningAudio, learningAudioTempPath } from "./audio-files";
import { AudioScope, LearningAudioRepository, TimedText } from "./audio-repository";
import { LearningError, type LearningRepository } from "./repository";

export function learningAsrConfig(env: Readonly<Record<string, string | undefined>> = process.env) {
  const secret = env.LEARNING_ASR_AUDIO_CAPABILITY_SECRET?.trim();
  let origin: URL; let service: URL;
  try { origin = new URL(env.LEARNING_ASR_AUDIO_BASE_URL ?? env.SPEAKER_ASR_AUDIO_BASE_URL ?? ""); service = new URL(env.SPEAKER_ASR_BASE_URL ?? ""); }
  catch { throw new LearningError(503, "learning_asr_not_configured"); }
  if (!secret || secret.length < 32 || ![origin, service].every((u) => ["https:", "http:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash)
    || !["", "/"].includes(origin.pathname)) throw new LearningError(503, "learning_asr_not_configured");
  return { secret, origin: origin.origin };
}
type Address = { userId: string; pageId: string; runId: string; materialId: string; index: number };
const bound = (a: Address) => ({ userId: a.userId, uploadId: `learning:${a.pageId}:${a.runId}:${a.materialId}`, chunkId: String(a.index) });
export function learningAudioUrl(config: ReturnType<typeof learningAsrConfig>, address: Address) {
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + TRANSCRIPTION_AUDIO_ACCESS_TTL_SECONDS;
  const url = new URL(`/api/learning/asr-audio/${encodeURIComponent(address.userId)}/${address.pageId}/${address.runId}/${address.materialId}/${address.index}`, config.origin);
  url.search = new URLSearchParams({ purpose: "transcription", expires: String(expiresAtSeconds),
    capability: createTranscriptionAudioAccessCapability(config.secret, { ...bound(address), expiresAtSeconds }) }).toString();
  return url.toString();
}
export function verifyLearningAudioUrl(secret: string, address: Address, query: URLSearchParams) {
  return verifyTranscriptionAudioAccessCapability({ secret, ...bound(address), purpose: query.get("purpose"),
    capability: query.get("capability"), expiresAtSeconds: Number(query.get("expires")) });
}
export function companyTimedText(data: Awaited<ReturnType<typeof requestCompanyAsr>>, start: number, end: number) {
  const sentences = data.asr_result?.sentences?.filter((s) => s.text?.trim());
  if (!sentences?.length) throw new LearningError(422, "audio_empty_transcript");
  const segments = sentences.map((s) => {
    const timestamps = s.timestamp ?? s.timestamps;
    const points = Array.isArray(timestamps) ? timestamps : timestamps ? [timestamps] : [];
    if (!points.length || points.some((p) => typeof p.start !== "number" || typeof p.end !== "number" || !Number.isFinite(p.start)
      || !Number.isFinite(p.end) || p.start < 0 || p.end <= p.start)) throw new LearningError(422, "audio_invalid_timestamps");
    const localStart = Math.min(...points.map((p) => p.start!)) / 1000;
    const localEnd = Math.max(...points.map((p) => p.end!)) / 1000;
    if (localEnd > end - start) throw new LearningError(422, "audio_invalid_timestamps");
    return { text: s.text!.trim(), startSeconds: start + localStart, endSeconds: start + localEnd };
  });
  return TimedText.parse(segments);
}

export async function transcribeLearningAudio(learning: LearningRepository, pageId: string, input: unknown,
  dependencies = { configure: learningAsrConfig, prepare: prepareLearningAudio, request: requestCompanyAsr }) {
  const scope = AudioScope.parse(input); const repository = new LearningAudioRepository(learning);
  const existing = repository.list(pageId).find((r) => r.id === scope.id);
  if (existing) {
    if (JSON.stringify(existing.materialIds) !== JSON.stringify([...scope.materialIds].sort())) throw new LearningError(409, "submission_conflict");
    return { runs: repository.list(pageId), page: learning.get(pageId) };
  }
  const config = dependencies.configure();
  const started = repository.begin(pageId, scope);
  if (!started.created) return { runs: repository.list(pageId), page: learning.get(pageId) };
  let failure: string | null = null;
  try {
    // Sequential materials and chunks bound CPU, provider concurrency and storage.
    for (const materialId of started.run.materialIds) {
      repository.assertActive(pageId, scope.id, materialId);
      const original = repository.original(pageId, materialId);
      if (original.audio.transcription === "completed") continue;
      const controller = new AbortController();
      const fence = setInterval(() => { try { repository.assertActive(pageId, scope.id, materialId); } catch { controller.abort(); } }, 250);
      try {
        if (!repository.chunks(pageId, materialId).length) repository.savePlan(pageId, scope.id, materialId,
          await dependencies.prepare(original.bytes, original.audio, materialId, controller.signal,
            { directory: learningAudioTempPath(learning.accountDataRoot, pageId, materialId), assertWritable: () => repository.assertActive(pageId, scope.id, materialId) }));
        for (const planned of repository.chunks(pageId, materialId)) {
          if (planned.state === "completed") continue;
          const chunk = repository.claimChunk(pageId, scope.id, materialId, planned.chunk_index);
          const address = { userId: learning.accountId, pageId, runId: scope.id, materialId, index: planned.chunk_index };
          const result = await dependencies.request({ requestId: chunk.requestId, materialId, userId: learning.accountId,
            audioUrl: learningAudioUrl(config, address), resume: chunk.resume,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60000)]) });
          repository.completeChunk(pageId, scope.id, materialId, planned.chunk_index, chunk.requestId,
            companyTimedText(result, planned.start_seconds, planned.end_seconds));
        }
        repository.publish(pageId, scope.id, materialId);
      } catch (error) {
        repository.assertActive(pageId, scope.id, materialId); // A deletion must stop the remaining batch.
        failure = error instanceof LearningError ? error.code : error instanceof z.ZodError ? "audio_invalid_transcript" : "audio_transcription_failed";
        repository.markMaterialFailed(pageId, materialId, failure);
      } finally { clearInterval(fence); controller.abort(); }
    }
    repository.finish(pageId, scope.id, failure);
  } catch (error) {
    repository.fail(pageId, scope.id, error instanceof LearningError ? error.code : "audio_transcription_failed");
  }
  return { runs: repository.list(pageId), page: learning.get(pageId) };
}
