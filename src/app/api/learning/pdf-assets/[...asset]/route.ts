import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isUnauthenticatedError, requireAuthContext } from "@/lib/server/auth/request-context";
import { learningPdfAssetRoot } from "@/lib/server/learning/pdf-inspect";
import { learningJson } from "../../route-utils";

export const runtime = "nodejs";
// Only installed PDF.js code/fonts/codecs; this route cannot address user files.
export async function GET(request: Request, context: { params: Promise<{ asset: string[] }> }) {
  try {
    await requireAuthContext(request);
    const { asset } = await context.params;
    const name = asset.join("/");
    const allowed = name === "worker.mjs"
      || /^cmaps\/[A-Za-z0-9_-]+\.bcmap$/u.test(name)
      || /^standard_fonts\/[A-Za-z0-9_-]+\.(?:pfb|ttf)$/u.test(name)
      || /^iccs\/[A-Za-z0-9_-]+\.icc$/u.test(name)
      || /^wasm\/(?:openjpeg|jbig2|qcms_bg)\.wasm$/u.test(name)
      || /^wasm\/(?:openjpeg|jbig2)_nowasm_fallback\.js$/u.test(name);
    if (!allowed) return learningJson({ error: "asset_not_found" }, 404);
    const bytes = await readFile(join(learningPdfAssetRoot(), name === "worker.mjs" ? "build/pdf.worker.min.mjs" : name));
    const type = /\.(?:mjs|js)$/u.test(name) ? "text/javascript" : name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
    return new Response(bytes, { headers: { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", Vary: "Cookie" } });
  } catch (error) {
    return learningJson({ error: isUnauthenticatedError(error) ? "unauthenticated" : "asset_unavailable" }, isUnauthenticatedError(error) ? 401 : 404);
  }
}
