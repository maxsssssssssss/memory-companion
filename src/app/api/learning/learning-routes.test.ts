// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUserDataRootDir } from "@/lib/server/auth/session";
import { JsonStore } from "@/lib/server/storage/json-store";
import { LearningRepository } from "@/lib/server/learning/repository";

const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/server/auth/request-context", async (original) => ({
  ...await original<typeof import("@/lib/server/auth/request-context")>(), requireAuthContext: auth
}));
import { GET as list, POST as create } from "./pages/route";
import { GET as get, PATCH as select, DELETE as deletePage } from "./pages/[pageId]/route";
import { POST as save } from "./pages/[pageId]/materials/route";
import { GET as source, DELETE as deleteMaterial } from "./pages/[pageId]/materials/[materialId]/route";
import { GET as sharedDay } from "../days/[uploadId]/route";
import { GET as sharedDate } from "../uploads/by-date/route";

let root: string;
const pageId = randomUUID();
const params = { params: Promise.resolve({ pageId }) };
const origin = "http://localhost";
const headers = { "x-synthetic-account": "a", "content-type": "application/json", origin };
function req(method = "GET", body?: unknown, account = "a") {
  return new Request(`${origin}/api/learning/pages/${pageId}`, { method, headers: { ...headers, "x-synthetic-account": account }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function form(id = randomUUID(), bytes = Buffer.from("[合成测试] 原文\n\nsecond paragraph")) {
  const value = new FormData();
  value.set("materials", JSON.stringify([{ id, title: "合成 TXT", kind: "txt" }]));
  value.append("files", new Blob([bytes], { type: "text/plain" }), "synthetic.txt");
  return value;
}
function upload(body: FormData) { return new Request(`${origin}/api/learning/pages/${pageId}/materials`, { method: "POST", headers: { "x-synthetic-account": "a", origin }, body }); }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "daily-brief-learning-api-"));
  auth.mockImplementation(async (request: Request) => {
    const id = request.headers.get("x-synthetic-account");
    if (!id || !["a", "b"].includes(id)) throw new Error("unauthenticated");
    const dataRootDir = getUserDataRootDir(id, root);
    return { user: { id, email: `${id}@synthetic.invalid` }, dataRootDir, uploadsRootDir: join(dataRootDir, "uploads"), store: new JsonStore(dataRootDir) };
  });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Provider/network prohibited"); }));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { force: true, recursive: true }); });

describe("learning-only APIs with isolated synthetic accounts", () => {
  it("requires authentication on every read and mutation", async () => {
    const materialParams = { params: Promise.resolve({ pageId, materialId: randomUUID() }) };
    const calls = [list(req("GET", undefined, "")), create(req("POST", {}, "")), get(req("GET", undefined, ""), params), select(req("PATCH", {}, ""), params),
      deletePage(req("DELETE", undefined, ""), params), save(req("POST", {}, ""), params), source(req("GET", undefined, ""), materialParams), deleteMaterial(req("DELETE", undefined, ""), materialParams)];
    for (const response of await Promise.all(calls)) expect(response.status).toBe(401);
  });
  it("saves and reopens exact text and paragraphs, with private no-store responses and no model calls", async () => {
    const created = await create(req("POST", { id: pageId, title: "合成课程" })); expect(created.status).toBe(200);
    const id = randomUUID(); const first = await save(upload(form(id)), params); expect(first.status).toBe(200);
    const retry = await save(upload(form(id)), params); expect((await retry.json()).page.materialCount).toBe(1);
    const page = (await (await get(req(), params)).json()).page;
    expect((await select(req("PATCH", { revision: page.revision, materialIds: [id] }), params)).status).toBe(200);
    const response = await source(req(), { params: Promise.resolve({ pageId, materialId: id }) });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.json()).source.paragraphs).toHaveLength(2);
    expect((await (await list(req())).json()).pages).toHaveLength(1);
    expect((await (await get(req(), params)).json()).page.materials[0].selected).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("denies another account and wrong page for source reads, selection, append and deletion", async () => {
    await create(req("POST", { id: pageId, title: "合成课程" }));
    const id = randomUUID(); await save(upload(form(id)), params);
    const mp = { params: Promise.resolve({ pageId, materialId: id }) };
    for (const response of await Promise.all([get(req("GET", undefined, "b"), params), source(req("GET", undefined, "b"), mp),
      select(req("PATCH", { revision: 0, materialIds: [id] }, "b"), params), deleteMaterial(req("DELETE", undefined, "b"), mp), deletePage(req("DELETE", undefined, "b"), params)])) expect(response.status).toBe(404);
    const otherUpload = upload(form()); otherUpload.headers.set("x-synthetic-account", "b");
    expect((await save(otherUpload, params)).status).toBe(404);
    const otherPage = randomUUID(); await create(req("POST", { id: otherPage, title: "其他合成页" }));
    expect((await source(req(), { params: Promise.resolve({ pageId: otherPage, materialId: id }) })).status).toBe(404);
    expect((await (await list(req("GET", undefined, "b"))).json()).pages).toEqual([]);
  });
  it("never exposes learning through the shared Daily/Date day source and upload catalog", async () => {
    await create(req("POST", { id: pageId, title: "合成" }));
    const id = randomUUID(); await save(upload(form(id)), params);
    expect((await sharedDay(req(), { params: Promise.resolve({ uploadId: id }) })).status).toBe(404);
    const response = await sharedDate(new Request(`${origin}/api/uploads/by-date?date=2026-09-18`, { headers }));
    expect((await response.json()).uploadIds).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects cross-origin mutations, unsupported input and oversized bodies", async () => {
    const foreign = req("POST", { id: pageId, title: "合成" }); foreign.headers.set("origin", "https://untrusted.invalid");
    expect((await create(foreign)).status).toBe(403);
    await create(req("POST", { id: pageId, title: "合成" }));
    expect((await save(upload(form(randomUUID(), Buffer.from([0xff, 0xfe]))), params)).status).toBe(400);
    const huge = upload(form()); huge.headers.set("content-length", "999999999");
    expect((await save(huge, params)).status).toBe(413);
    expect((await get(req(), { params: Promise.resolve({ pageId: "../uploads" }) })).status).toBe(400);
  });
  it("uses the browser-facing Host when Next internally normalizes the URL to localhost", async () => {
    const local = req("POST", { id: pageId, title: "合成" });
    local.headers.set("host", "127.0.0.1:3201"); local.headers.set("origin", "http://127.0.0.1:3201");
    expect((await create(local)).status).toBe(200);
    const foreign = req("DELETE"); foreign.headers.set("host", "127.0.0.1:3201"); foreign.headers.set("origin", "https://untrusted.invalid");
    expect((await deletePage(foreign, params)).status).toBe(403);
  });
  it("preserves content on save failure and returns no paths, SQL or source text", async () => {
    await create(req("POST", { id: pageId, title: "合成" }));
    vi.spyOn(LearningRepository.prototype, "saveMaterials").mockImplementationOnce(() => { throw new Error("C:/private/source SECRET test text"); });
    const id = randomUUID(); const failed = await save(upload(form(id)), params);
    expect(failed.status).toBe(503); expect(await failed.json()).toEqual({ error: "learning_storage_unavailable" });
    expect((await save(upload(form(id)), params)).status).toBe(200);
  });
  it("rejects an upload arriving after page deletion, including while the body was being read", async () => {
    await create(req("POST", { id: pageId, title: "合成" }));
    const prepared = upload(form()); const bytes = new Uint8Array(await prepared.arrayBuffer());
    let release!: () => void;
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) { reading(); await gate; controller.enqueue(bytes); controller.close(); } }, { highWaterMark: 0 });
    const delayed = new Request(prepared.url, { method: "POST", headers: prepared.headers, body: stream, duplex: "half" } as RequestInit & { duplex: string });
    const pending = save(delayed, params); await started;
    expect((await deletePage(req("DELETE"), params)).status).toBe(200); release();
    expect((await pending).status).toBe(410);
    expect((await create(req("POST", { id: pageId, title: "合成" }))).status).toBe(410);
    expect((await (await list(req())).json()).pages).toEqual([]);
  });
});
