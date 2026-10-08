import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

/** Only original upload uses Node's bounded HTTP request. Native fetch also has
 * an internal 300 s response-header timer, which can expire before the agreed
 * 600 s slow-upload deadline. Do not alter global agents or other products. */
export const pdfParserTransport: typeof fetch = async (input, init) => {
  if (init?.method !== "PUT") return fetch(input, init);
  const url = new URL(String(input));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
    throw new Error("invalid_pdf_upload_endpoint");
  if (!(init.body instanceof Uint8Array) || !init.signal) throw new Error("invalid_pdf_upload_request");
  const body = init.body;
  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "PUT", headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal!
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) { request.destroy(new Error("oversized_response")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined)
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        const status = response.statusCode ?? 502;
        const content = Buffer.concat(chunks);
        resolve(new Response([204, 205, 304].includes(status) ? null : content, { status, headers }));
      });
    });
    request.on("error", reject);
    // No redirects, retries, content rewriting or shared/global dispatcher.
    request.end(body);
  });
};
