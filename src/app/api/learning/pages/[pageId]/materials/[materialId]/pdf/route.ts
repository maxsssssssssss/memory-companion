import { LearningId } from "@/lib/domain/learning";
import { withLearning } from "../../../../../route-utils";

export const runtime = "nodejs";
type Context = { params: Promise<{ pageId: string; materialId: string }> };
export async function GET(request: Request, context: Context) {
  return withLearning(request, async (repository) => {
    const params = await context.params;
    const { material, bytes } = repository.pdfOriginal(LearningId.parse(params.pageId), LearningId.parse(params.materialId), request.method !== "HEAD");
    const size = material.byteLength;
    const headers = new Headers({ "Content-Type": "application/pdf", "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie",
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'",
      "Content-Disposition": `attachment; filename="material.pdf"; filename*=UTF-8''${encodeURIComponent(material.filename ?? "material.pdf")}`,
      "Accept-Ranges": "bytes", "Content-Length": String(size), "X-Content-SHA256": material.pdf!.sha256 });
    const range = request.headers.get("range");
    if (range && request.method !== "HEAD") {
      const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
      const from = match?.[1] ? Number(match[1]) : Math.max(0, size - Number(match?.[2]));
      const to = match?.[1] ? (match[2] ? Math.min(size - 1, Number(match[2])) : size - 1) : size - 1;
      if (!match || !(match[1] || match[2]) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from >= size || to < from) {
        headers.set("Content-Range", `bytes */${size}`); headers.set("Content-Length", "0");
        return new Response(null, { status: 416, headers });
      }
      headers.set("Content-Range", `bytes ${from}-${to}/${size}`); headers.set("Content-Length", String(to - from + 1));
      return new Response(new Uint8Array(bytes!.subarray(from, to + 1)), { status: 206, headers });
    }
    return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes!), { headers });
  });
}
export async function HEAD(request: Request, context: Context) {
  const response = await GET(request, context);
  return new Response(null, { status: response.status, headers: response.headers });
}
