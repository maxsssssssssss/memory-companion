// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { createAsrHttpForwardTransport, speakerAsrFetch } from "./speaker-asr-transport";
import { requestCompanyAsr, speakerAsrTranscriptionProvider, speakerAsrChunkTranscriptionAdapter } from "./speaker-asr-provider";
import { buildAudioChunkId, type AudioChunk } from "@/lib/domain/chunks";

// The Vitest HTTP guard checks the logical target before proxy selection.
// Keep it loopback too; the proxy must still observe every absolute-form call.
const base = "http://127.0.0.1:8790/gateway";
const endpoint = base + "/api/ai/non-realtime-asr";
const data = { asr_result: { sentences: [{ text: "合成三角形", timestamp: [{ start: 0, end: 500 }] }] } };
const secret = "SYNTHETIC_SECRET_MUST_NOT_APPEAR_IN_ERRORS";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function select() {
  vi.stubEnv("SPEAKER_ASR_BASE_URL", base);
  vi.stubEnv("DAILY_BRIEF_CLOUD_ASR_HTTP_BASE_URL", base);
}
async function withProxy(handler: (req: IncomingMessage, res: ServerResponse) => void, work: () => Promise<void>) {
  const sockets = new Set<Socket>(); let connects = 0;
  const proxy = createServer(handler);
  proxy.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  proxy.on("connect", (_, socket) => { connects++; socket.destroy(); });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address(); if (!address || typeof address === "string") throw Error("synthetic proxy unavailable");
  vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${address.port}`);
  // The explicit ASR agent must not let inherited bypass lists cause direct I/O.
  vi.stubEnv("NO_PROXY", "*"); vi.stubEnv("no_proxy", "*");
  try { await work(); expect(connects).toBe(0); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
}

describe("Cloud-only ASR transport selection", () => {
  it.each(["http://asr.synthetic.invalid:8790", "https://asr.synthetic.invalid"])("keeps default fetch for %s even with general proxy settings", async url => {
    vi.stubEnv("DAILY_BRIEF_CLOUD_ASR_HTTP_BASE_URL", "");
    vi.stubEnv("HTTP_PROXY", "http://proxy.invalid");
    const response = Response.json({ code: 0 }); const mocked = vi.fn().mockResolvedValue(response); vi.stubGlobal("fetch", mocked);
    const init = { method: "POST", body: "{}", signal: AbortSignal.timeout(1000) };
    expect(await speakerAsrFetch(url, init)).toBe(response); expect(mocked).toHaveBeenCalledWith(url, init);
  });
  it("fails closed when the pinned base changes, rather than falling back to fetch", async () => {
    select(); vi.stubEnv("SPEAKER_ASR_BASE_URL", "http://other.invalid");
    const mocked = vi.fn(); vi.stubGlobal("fetch", mocked);
    await expect(speakerAsrFetch(endpoint, { method: "POST" })).rejects.toThrow("asr_http_base_changed");
    expect(mocked).not.toHaveBeenCalled();
  });
  it.each([
    ["http://other.invalid/api/ai/non-realtime-asr", "POST"],
    [base + "/other", "GET"], [endpoint, "DELETE"],
    [endpoint + "/query?reqid=a&extra=b", "GET"], [endpoint + "/query?reqid=", "GET"],
    [endpoint + "?x=y", "POST"], [endpoint + "#fragment", "POST"]
  ])("rejects unapproved ASR operation %s %s", async (url, method) => {
    select(); await expect(speakerAsrFetch(url, { method })).rejects.toThrow("asr_destination_blocked");
  });
  it("requires a proxy and produces only sanitized configuration errors", async () => {
    select(); vi.stubEnv("HTTP_PROXY", ""); vi.stubEnv("http_proxy", "");
    await expect(speakerAsrFetch(endpoint, { method: "POST" })).rejects.toThrow("asr_http_proxy_required");
    vi.stubEnv("HTTP_PROXY", secret);
    try { await speakerAsrFetch(endpoint, { method: "POST" }); throw Error("expected rejection"); }
    catch (error) { expect(String(error)).toContain("asr_http_proxy_required"); expect(String(error)).not.toContain(secret); }
  });
});

describe("real local forward proxy and application ASR contracts", () => {
  it("preserves submit fields, gateway prefix and query-only resume through the existing application entry", async () => {
    select(); const calls: { method?: string; url?: string; body: Record<string, unknown> }[] = [];
    const originalFetch = globalThis.fetch;
    await withProxy((req, res) => {
      const chunks: Buffer[] = []; req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        calls.push({ method: req.method, url: req.url, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {} });
        res.end(JSON.stringify(req.method === "POST" ? { code: 0 } : { code: 0, data }));
      });
    }, async () => {
      const input = { requestId: "learning_synthetic_stable", materialId: "synthetic-material", userId: "synthetic-owner",
        audioUrl: "https://audio.synthetic.invalid/file?capability=synthetic", resume: false, signal: AbortSignal.timeout(2000) };
      expect(await requestCompanyAsr(input)).toEqual(data);
      expect(await requestCompanyAsr({ ...input, resume: true })).toEqual(data);
      expect(globalThis.fetch).toBe(originalFetch);
      expect(calls.map(x => x.method)).toEqual(["POST", "GET", "GET"]);
      expect(calls[0].url).toBe(endpoint);
      expect(calls[0].body).toEqual({ req_id: input.requestId, record_id: input.requestId, user_id: input.userId, audio_url: input.audioUrl, language: ["cn"], speaker: 0 });
      expect(calls.slice(1).every(x => x.url === endpoint + "/query?reqid=" + input.requestId)).toBe(true);
    });
  });
  it("preserves the normal transcription and chunk adapter contracts using the same selection", async () => {
    select(); vi.stubEnv("SPEAKER_ASR_AUDIO_BASE_URL", "https://audio.synthetic.invalid");
    vi.stubEnv("SPEAKER_ASR_AUDIO_ACCESS_TOKEN", "synthetic-audio-token");
    const bodies: Record<string, unknown>[] = [];
    await withProxy((req, res) => {
      const chunks: Buffer[] = []; req.on("data", (chunk: Buffer) => chunks.push(chunk)); req.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString())); res.end(JSON.stringify({ code: 0, data }));
      });
    }, async () => {
      const result = await speakerAsrTranscriptionProvider.transcribe({ uploadId: "synthetic-upload", filePath: "/synthetic/users/owner/uploads/audio.mp3", mimeType: "audio/mpeg" });
      expect(result[0].text).toBe("合成三角形");
      const chunk: AudioChunk = { id: buildAudioChunkId("synthetic-upload", 0), uploadId: "synthetic-upload", index: 0, startSeconds: 0, endSeconds: 1,
        durationSeconds: 1, source: { type: "generated_chunk", path: "/synthetic/users/owner/uploads/chunk.mp3" },
        status: "processing", retryCount: 0, createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z", metadata: { mimeType: "audio/mpeg" } };
      const transcript = await speakerAsrChunkTranscriptionAdapter.transcribeChunk({ chunk, userId: "owner", signal: AbortSignal.timeout(2000) });
      expect(transcript.segments[0].text).toBe("合成三角形"); expect(bodies).toHaveLength(2);
      expect(bodies[0].record_id).toBe("synthetic-upload"); expect(bodies[1].record_id).toBe(chunk.id);
    });
  });
  it("does not replay a POST after a lost receipt or fall back to fetch", async () => {
    select(); let posts = 0; const mocked = vi.fn(); vi.stubGlobal("fetch", mocked);
    await withProxy((req) => { posts++; req.socket.destroy(); }, async () => {
      await expect(requestCompanyAsr({ requestId: "synthetic-lost", materialId: "material", userId: "owner",
        audioUrl: "https://audio.synthetic.invalid", resume: false, signal: AbortSignal.timeout(1000) })).rejects.toThrow("asr_http_transport_failed");
      expect(posts).toBe(1); expect(mocked).not.toHaveBeenCalled();
    });
  });
  it("rejects redirects without forwarding the audio URL or following Location", async () => {
    select(); let requests = 0;
    await withProxy((_, res) => { requests++; res.writeHead(307, { location: "http://other.invalid/" + secret }); res.end(); }, async () => {
      await expect(speakerAsrFetch(endpoint, { method: "POST", body: "{}" })).rejects.toThrow("asr_redirect_blocked"); expect(requests).toBe(1);
    });
  });
  it.each([false, true])("aborts while waiting for %s and closes the in-flight socket", async bodyStarted => {
    select(); const controller = new AbortController(); let closed!: () => void;
    const socketClosed = new Promise<void>(resolve => { closed = resolve; });
    await withProxy((req, res) => {
      req.socket.on("close", closed);
      if (bodyStarted) { res.writeHead(200); res.write('{"code":'); }
      controller.abort(secret);
    }, async () => {
      await expect(speakerAsrFetch(endpoint, { method: "POST", body: "{}", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError", message: "ASR request aborted" });
      await socketClosed;
    });
  });
  it("preserves HTTP errors and decodes compressed responses without imposing the CLI's 128KiB cap on the app", async () => {
    select(); const large = JSON.stringify({ code: 0, synthetic: "x".repeat(150 * 1024) });
    let count = 0;
    await withProxy((_, res) => {
      count++; res.writeHead(count === 1 ? 200 : 429, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gzipSync(count === 1 ? large : '{"code":429}'));
    }, async () => {
      expect(await (await speakerAsrFetch(endpoint, { method: "POST", body: "{}" })).text()).toBe(large);
      const response = await speakerAsrFetch(endpoint + "/query?reqid=synthetic");
      expect(response.status).toBe(429); expect(await response.json()).toEqual({ code: 429 });
    });
  });
  it("rejects an already aborted request without sending it", async () => {
    const controller = new AbortController(); controller.abort(secret);
    await expect(createAsrHttpForwardTransport(new URL(base).origin)(endpoint, { method: "POST", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
