import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { isUnauthenticatedError, requireAuthContext } from "@/lib/server/auth/request-context";
import { LearningError, LearningRepository } from "@/lib/server/learning/repository";

export function learningJson(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
}

export async function withLearning(request: Request, work: (repository: LearningRepository) => Promise<Response> | Response) {
  let repository: LearningRepository | undefined;
  try {
    const auth = await requireAuthContext(request);
    if (request.method !== "GET") {
      const origin = request.headers.get("origin");
      // Next's internal request URL can use localhost while the browser uses
      // 127.0.0.1. Compare with the HTTP Host, not that internal hostname.
      const url = new URL(request.url);
      const host = request.headers.get("host") ?? url.host;
      const forwardedProtocol = request.headers.get("x-forwarded-proto");
      const protocol = forwardedProtocol === "http" || forwardedProtocol === "https" ? `${forwardedProtocol}:` : url.protocol;
      let sameOrigin = !origin;
      try { if (origin) sameOrigin = new URL(origin).origin === new URL(`${protocol}//${host}`).origin; } catch { sameOrigin = false; }
      if (!sameOrigin || request.headers.get("sec-fetch-site") === "cross-site") {
        throw new LearningError(403, "cross_origin_forbidden");
      }
    }
    repository = new LearningRepository(auth.dataRootDir, auth.user.id);
    return await work(repository);
  } catch (error) {
    if (isUnauthenticatedError(error)) return learningJson({ error: "unauthenticated" }, 401);
    if (error instanceof LearningError) return learningJson({ error: error.code }, error.status);
    if (error instanceof ZodError || error instanceof SyntaxError) return learningJson({ error: "invalid_input" }, 400);
    // Never return/log source text, paths, SQL errors or credentials.
    return learningJson({ error: "learning_storage_unavailable" }, 503);
  } finally { repository?.close(); }
}

export async function boundedLearningBody(request: Request, limit: number, limitCode = "batch_too_large"): Promise<Uint8Array> {
  const length = Number(request.headers.get("content-length"));
  if (length > limit) throw new LearningError(413, limitCode);
  const reader = request.body?.getReader();
  if (!reader) throw new LearningError(400, "invalid_input");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new LearningError(413, limitCode);
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function learningJsonBody(request: Request) {
  const body = await boundedLearningBody(request, 512 * 1024);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown; }
  catch { throw new LearningError(400, "invalid_input"); }
}
