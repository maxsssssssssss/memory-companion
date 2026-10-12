import { Agent, request, type AgentOptions } from "node:http";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

// Set only by the Cloud Provider launcher, never inherited by its whitelist.
// Pin the full base (including an optional gateway prefix), not just a hostname.
const CLOUD_HTTP_BASE = "DAILY_BRIEF_CLOUD_ASR_HTTP_BASE_URL";
const failure = (code: string) => Object.assign(new Error(code), { code });

/** Plain HTTP forward proxy; unlike native fetch this does not CONNECT to the
 * HTTP origin. The explicit agent cannot fall back to direct/NO_PROXY access.
 * No global fetch/agent mutation, retries, redirects, or credential logging. */
export function createAsrHttpForwardTransport(origin: string, maxResponseBytes?: number): typeof fetch {
  return async (input, init = {}) => {
    let url: URL;
    try { url = new URL(String(input)); } catch { throw failure("asr_destination_blocked"); }
    if (url.origin !== origin || url.protocol !== "http:" || url.username || url.password || url.hash) {
      throw failure("asr_destination_blocked");
    }
    if (init.body !== undefined && typeof init.body !== "string") throw failure("submission_body_invalid");
    if (init.signal?.aborted) throw new DOMException("ASR request aborted", "AbortError");
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 24 || (major === 24 && minor < 5)) throw failure("asr_http_proxy_node_unsupported");
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw failure("asr_http_proxy_tls_required");
    const proxy = process.env.HTTP_PROXY ?? process.env.http_proxy;
    try {
      const parsed = new URL(proxy ?? "");
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.search || parsed.hash || parsed.pathname !== "/") throw Error();
    } catch { throw failure("asr_http_proxy_required"); }
    // @types/node follows the offline Node minimum; this runtime-only option
    // is checked above and supported by the Cloud Node >=24.5 contract.
    const options: AgentOptions & { proxyEnv: Record<string, string> } = {
      keepAlive: false,
      proxyEnv: { HTTP_PROXY: proxy!, http_proxy: proxy!, NO_PROXY: "", no_proxy: "" }
    };
    let agent: Agent;
    try { agent = new Agent(options); } catch { throw failure("asr_http_proxy_required"); }
    try {
      return await new Promise<Response>((resolve, reject) => {
        const headers = Object.fromEntries(new Headers(init.headers).entries());
        // JSON is normally uncompressed; decode standard content codings if an
        // upstream still supplies one. The trial byte cap is not an app limit.
        headers["accept-encoding"] = "identity";
        const failed = () => reject(init.signal?.aborted
          ? new DOMException("ASR request aborted", "AbortError") : failure("asr_http_transport_failed"));
        let outgoing;
        try {
          outgoing = request(url, { method: init.method ?? "GET", headers, agent, signal: init.signal ?? undefined }, incoming => {
            incoming.on("error", failed);
            incoming.on("aborted", failed);
            const status = incoming.statusCode ?? 502;
            if (status >= 300 && status < 400) {
              reject(failure("asr_redirect_blocked")); incoming.destroy(); return;
            }
            const chunks: Buffer[] = []; let size = 0;
            incoming.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (maxResponseBytes !== undefined && size > maxResponseBytes) {
                reject(failure("response_too_large")); incoming.destroy(); return;
              }
              chunks.push(chunk);
            });
            incoming.on("end", () => {
              try {
                let bytes: Buffer = Buffer.concat(chunks);
                const noBody = init.method === "HEAD" || [204, 205, 304].includes(status);
                const codings = noBody ? [] : String(incoming.headers["content-encoding"] ?? "identity").split(",").map(x => x.trim().toLowerCase()).reverse();
                const decodeOptions = maxResponseBytes === undefined ? {} : { maxOutputLength: maxResponseBytes };
                for (const coding of codings) {
                  if (coding === "gzip") bytes = gunzipSync(bytes, decodeOptions);
                  else if (coding === "deflate") bytes = inflateSync(bytes, decodeOptions);
                  else if (coding === "br") bytes = brotliDecompressSync(bytes, decodeOptions);
                  else if (coding !== "identity") throw Error();
                }
                resolve(new Response(noBody ? null : new Uint8Array(bytes), {
                  status, headers: { "Content-Type": String(incoming.headers["content-type"] ?? "application/json") }
                }));
              } catch { reject(failure("asr_http_response_invalid")); }
            });
          });
          outgoing.on("error", failed);
          outgoing.end(init.body);
        } catch { failed(); }
      });
    } finally { agent.destroy(); }
  };
}

/** The application's two ASR operations share this selection. Ordinary local
 * and server launches retain fetch, even when general proxy variables exist. */
export function speakerAsrFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const pinned = process.env[CLOUD_HTTP_BASE];
  if (!pinned) return fetch(url, init);
  const configured = process.env.SPEAKER_ASR_BASE_URL?.trim().replace(/\/+$/, "");
  if (pinned !== configured) return Promise.reject(failure("asr_http_base_changed"));
  let target: URL, base: URL;
  try { target = new URL(url); base = new URL(pinned); }
  catch { return Promise.reject(failure("asr_destination_blocked")); }
  const operation = `${base.pathname.replace(/\/+$/, "")}/api/ai/non-realtime-asr`;
  const method = (init.method ?? "GET").toUpperCase();
  const allowed = (method === "POST" && target.pathname === operation && !target.search)
    || (method === "GET" && target.pathname === operation + "/query" && target.searchParams.size === 1 && !!target.searchParams.get("reqid"));
  if (base.protocol !== "http:" || base.username || base.password || base.search || base.hash
    || target.origin !== base.origin || !allowed) return Promise.reject(failure("asr_destination_blocked"));
  return createAsrHttpForwardTransport(base.origin)(url, init);
}
