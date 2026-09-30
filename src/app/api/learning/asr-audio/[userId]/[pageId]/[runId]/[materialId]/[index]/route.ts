import { LearningId } from "@/lib/domain/learning";
import { getUserDataRootDir } from "@/lib/server/auth/session";
import { LearningRepository } from "@/lib/server/learning/repository";
import { LearningAudioRepository } from "@/lib/server/learning/audio-repository";
import { verifyLearningAudioUrl } from "@/lib/server/learning/audio-service";
export const runtime = "nodejs";
type Context = { params: Promise<{ userId: string; pageId: string; runId: string; materialId: string; index: string }> };
async function serve(request: Request, context: Context) {
  let repository: LearningRepository | undefined;
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  try {
    const p = await context.params; const index = Number(p.index);
    if (!/^[A-Za-z0-9_-]+$/u.test(p.userId) || ![p.pageId, p.runId, p.materialId].every((id) => LearningId.safeParse(id).success)
      || !/^\d+$/u.test(p.index) || !Number.isSafeInteger(index) || index > 24) return new Response(null, { status: 404, headers });
    const secret = process.env.LEARNING_ASR_AUDIO_CAPABILITY_SECRET?.trim();
    if (!secret || !verifyLearningAudioUrl(secret, { ...p, index }, new URL(request.url).searchParams)) return new Response(null, { status: 401, headers });
    repository = new LearningRepository(getUserDataRootDir(p.userId), p.userId);
    const bytes = new LearningAudioRepository(repository).servedChunk(p.pageId, p.runId, p.materialId, index);
    // Range is deliberately unsupported; authenticated full GET/HEAD only.
    if (request.headers.has("range")) return new Response(null, { status: 416, headers });
    return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes), { headers: { ...headers, "Content-Type": "audio/mpeg", "Content-Length": String(bytes.length) } });
  } catch { return new Response(null, { status: 404, headers }); }
  finally { repository?.close(); }
}
export const GET = serve;
export const HEAD = serve;
