// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUserDataRootDir } from "@/lib/server/auth/session";
import { LearningRepository } from "@/lib/server/learning/repository";
import { JsonStore } from "@/lib/server/storage/json-store";
import { syntheticLearningPdf } from "../../../../scripts/fixtures/learning-pdf.mjs";
import { LEARNING_PDF_MAX_BYTES } from "@/lib/domain/learning";
const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/server/auth/request-context", async (original) => ({ ...await original<typeof import("@/lib/server/auth/request-context")>(), requireAuthContext: auth }));
import { POST as create } from "./pages/route";
import { GET as get, DELETE as deletePage } from "./pages/[pageId]/route";
import { POST as save } from "./pages/[pageId]/materials/route";
import { GET as original, HEAD as head } from "./pages/[pageId]/materials/[materialId]/pdf/route";
import { GET as source, DELETE as remove } from "./pages/[pageId]/materials/[materialId]/route";
import { GET as parsed, POST as parsePdf, PATCH as pdfScope } from "./pages/[pageId]/materials/[materialId]/parsed/route";
import { GET as asset } from "./pdf-assets/[...asset]/route";
import { GET as sharedDay } from "../days/[uploadId]/route";

let root: string; let pageId: string;
const origin = "http://localhost";
function req(method = "GET", account = "a", body?: FormData) { return new Request(`${origin}/api/learning/pages/${pageId}`, { method, headers: { "x-synthetic-account": account, origin }, body }); }
const pp = () => ({ params: Promise.resolve({ pageId }) });
const mp = (materialId: string, page = pageId) => ({ params: Promise.resolve({ pageId: page, materialId }) });
function batch(items: Array<{ id?: string; kind?: string; bytes?: Buffer; filename?: string; title?: string }> = [{}]) {
  const form = new FormData();
  const materials = items.map((item) => ({ id: item.id ?? randomUUID(), title: item.title ?? "合成 PDF", kind: item.kind ?? "pdf" }));
  form.set("materials", JSON.stringify(materials));
  items.forEach((item) => form.append("files", new Blob([new Uint8Array(item.bytes ?? syntheticLearningPdf())]), item.filename ?? "same.pdf"));
  return form;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "synthetic-learning-pdf-api-")); pageId = randomUUID();
  auth.mockImplementation(async (request: Request) => {
    const id = request.headers.get("x-synthetic-account"); if (!id) throw new Error("unauthenticated");
    const dataRootDir = getUserDataRootDir(id, root);
    return { user: { id }, dataRootDir, uploadsRootDir: join(dataRootDir, "uploads"), store: new JsonStore(dataRootDir) };
  });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No Provider/network in PDF tests"); }));
  await create(new Request(`${origin}/api/learning/pages`, { method: "POST", headers: { "x-synthetic-account": "a", "content-type": "application/json", origin }, body: JSON.stringify({ id: pageId, title: "合成 PDF 页" }) }));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

describe("authenticated PDF originals, never uploads/ASR/OCR", () => {
  it("saves originals with explicit unavailable preparation, and rejects malformed processing intent", async () => {
    const form=batch();form.set("prepare","yes");
    const r=await save(req("POST","a",form),pp());expect(r.status).toBe(200);
    const result=await r.json();expect(result.page.materialCount).toBe(1);
    expect(result.preparation[0]).toMatchObject({status:"unavailable",error:"pdf_parser_not_configured"});
    expect(fetch).not.toHaveBeenCalled();
    const invalid=batch();invalid.set("prepare","force");expect((await save(req("POST","a",invalid),pp())).status).toBe(400);
    const summary=new Request(`${origin}/api/learning/pages/${pageId}/materials/${result.page.materials[0].id}/parsed?summary=1`,{headers:{"x-synthetic-account":"b"}});
    expect((await parsed(summary,mp(result.page.materials[0].id))).status).toBe(404);
  },30000);
  it("persists multiple PDFs mixed with text, replays once, and appends without overwriting names", async () => {
    const a = randomUUID(); const b = randomUUID(); const txt = randomUUID();
    const items = [{ id: a }, { id: b }, { id: txt, kind: "text", bytes: Buffer.from("[合成] 一\n\n二"), filename: "text.txt" }];
    const first = await save(req("POST", "a", batch(items)), pp()); expect(first.status).toBe(200);
    expect((await (await save(req("POST", "a", batch(items)), pp())).json()).page.materialCount).toBe(3);
    expect((await (await save(req("POST", "a", batch()), pp())).json()).page.materialCount).toBe(4);
    const response = await original(req(), mp(a));
    expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(syntheticLearningPdf());
    expect(response.headers.get("cache-control")).toContain("no-store"); expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("content-security-policy")).toContain("sandbox"); expect(response.headers.get("content-disposition")).toContain("attachment");
    expect((await source(req(), mp(a))).status).toBe(409);
    expect((await (await source(req(), mp(txt))).json()).source.paragraphs).toHaveLength(2);
    expect((await sharedDay(req(), { params: Promise.resolve({ uploadId: a }) })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  }, 30000);
  it("authenticates full, HEAD and Range reads and validates page ownership on every request", async () => {
    const id = randomUUID(); await save(req("POST", "a", batch([{ id }])), pp());
    const header = await head(req("HEAD"), mp(id)); expect(header.status).toBe(200); expect(await header.text()).toBe("");
    expect(Number(header.headers.get("content-length"))).toBe(syntheticLearningPdf().length);
    for (const [range, expected] of [["bytes=0-15", syntheticLearningPdf().subarray(0, 16)], ["bytes=-8", syntheticLearningPdf().subarray(-8)]] as const) {
      const request = req(); request.headers.set("range", range); const response = await original(request, mp(id));
      expect(response.status).toBe(206); expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
    }
    for (const range of ["bytes=9999999-", "bytes=3-1", "bytes=0-1,3-4", "bytes=-0", "bytes=-"]) {
      const request = req(); request.headers.set("range", range); expect((await original(request, mp(id))).status).toBe(416);
    }
    for (const account of ["", "b"]) for (const method of ["GET", "HEAD"]) {
      const request = req(method, account); request.headers.set("range", "bytes=0-5");
      expect((await (method === "HEAD" ? head : original)(request, mp(id))).status).toBe(account ? 404 : 401);
    }
    const wrong = randomUUID(); const r = new LearningRepository(getUserDataRootDir("a", root), "a"); r.create({ id: wrong, title: "其他" }); r.close();
    expect((await original(req(), mp(id, wrong))).status).toBe(404);
  }, 30000);
  it("rejects invalid, damaged, encrypted and too-large originals atomically", async () => {
    for (const bytes of [Buffer.from("pretend.pdf"), Buffer.from("%PDF-1.7\nBROKEN\n%%EOF\n"), syntheticLearningPdf({ password: "secret" }), Buffer.alloc(LEARNING_PDF_MAX_BYTES + 1)]) {
      const response = await save(req("POST", "a", batch([{ kind: "text", bytes: Buffer.from("[合成] 也不能部分保存") }, { bytes }])), pp());
      expect([400, 413, 422]).toContain(response.status);
      expect((await (await get(req(), pp())).json()).page.materialCount).toBe(0);
    }
    expect((await save(req("POST", "a", batch(Array.from({ length: 6 }, () => ({})))), pp())).status).toBe(400);
    const oversized = req("POST", "a", batch()); oversized.headers.set("content-length", "999999999");
    expect((await save(oversized, pp())).status).toBe(413);
  }, 30000);
  it("keeps a failed batch retryable and never reports success with missing binary content", async () => {
    const id = randomUUID(); vi.spyOn(LearningRepository.prototype, "saveMaterials").mockImplementationOnce(() => { throw new Error("synthetic disk failure private/path"); });
    const failed = await save(req("POST", "a", batch([{ id }])), pp()); expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "learning_storage_unavailable" });
    expect((await original(req(), mp(id))).status).toBe(404);
    expect((await save(req("POST", "a", batch([{ id }])), pp())).status).toBe(200);
    expect((await head(req("HEAD"), mp(id))).status).toBe(200);
  }, 30000);
  it("deletes originals and metadata and denies cached conditional/range requests and late writes", async () => {
    const id = randomUUID(); await save(req("POST", "a", batch([{ id }])), pp());
    expect((await remove(req("DELETE"), mp(id))).status).toBe(200);
    const cached = req(); cached.headers.set("range", "bytes=0-8"); cached.headers.set("if-none-match", "previous");
    expect((await original(cached, mp(id))).status).toBe(410);
    expect((await head(req("HEAD"), mp(id))).status).toBe(410);
    expect((await save(req("POST", "a", batch([{ id }])), pp())).status).toBe(410);
    await deletePage(req("DELETE"), pp());
    expect((await save(req("POST", "a", batch()), pp())).status).toBe(410);
  }, 30000);
  it("blocks a PDF upload arriving after its page is deleted during body reading", async () => {
    const prepared = req("POST", "a", batch()); const bytes = new Uint8Array(await prepared.arrayBuffer());
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const ready = new Promise<void>((resolve) => { started = resolve; });
    const body = new ReadableStream({ async pull(controller) { started(); await gate; controller.enqueue(bytes); controller.close(); } }, { highWaterMark: 0 });
    const delayed = new Request(prepared.url, { method: "POST", headers: prepared.headers, body, duplex: "half" } as RequestInit & { duplex: string });
    const pending = save(delayed, pp()); await ready; await deletePage(req("DELETE"), pp()); release();
    expect((await pending).status).toBe(410);
  });
  it("serves only allowlisted library assets under authentication, never PDF JS execution machinery or paths", async () => {
    const call = (name: string, account = "a") => asset(req("GET", account), { params: Promise.resolve({ asset: name.split("/") }) });
    expect((await call("worker.mjs", "")).status).toBe(401);
    expect((await call("worker.mjs")).headers.get("content-type")).toBe("text/javascript");
    for (const path of ["../../package.json", "wasm/quickjs-eval.js", "wasm/quickjs-eval.wasm", "private.pdf"]) expect((await call(path)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("bounds total PDF bytes separately from text and releases its upload slot after rejection", async () => {
    const piece = Buffer.alloc(17 * 1024 * 1024, 32);
    const oversized = await save(req("POST", "a", batch([{ bytes: piece }, { bytes: piece }, { bytes: piece }])), pp());
    expect(oversized.status).toBe(413); expect(await oversized.json()).toEqual({ error: "pdf_batch_too_large" });
    expect((await save(req("POST", "a", batch()), pp())).status).toBe(200);
  }, 30000);
  it("rejects excess concurrent uploads before reading their bodies and accepts a later retry", async () => {
    const waiting: Array<() => void> = []; const pending: Array<Promise<Response>> = [];
    for (let i = 0; i < 2; i++) {
      const request = req("POST", "a", batch([{ kind: "text", bytes: Buffer.from("[合成] 并发上传") }]));
      const bytes = new Uint8Array(await request.arrayBuffer());
      let started!: () => void;
      const ready = new Promise<void>((resolve) => { started = resolve; });
      const gate = new Promise<void>((resolve) => waiting.push(resolve));
      const body = new ReadableStream({ async pull(controller) { started(); await gate; controller.enqueue(bytes); controller.close(); } }, { highWaterMark: 0 });
      pending.push(save(new Request(request.url, { method: "POST", headers: request.headers, body, duplex: "half" } as RequestInit & { duplex: string }), pp()));
      await ready;
    }
    try {
      const busy = await save(req("POST", "a", batch()), pp()); expect(busy.status).toBe(503);
      expect(await busy.json()).toEqual({ error: "learning_upload_busy" });
    } finally { waiting.forEach((release) => release()); await Promise.all(pending); }
    expect((await save(req("POST", "a", batch()), pp())).status).toBe(200);
  }, 30000);
});

it("learning parse/scope routes authenticate original ownership before configuration and never call providers when unconfigured",async()=>{
  const id=randomUUID();await save(req("POST","a",batch([{id}])),pp());
  expect((await parsed(req(),mp(id))).status).toBe(200);expect((await parsed(req("GET","b"),mp(id))).status).toBe(404);
  const request=(account:string)=>new Request(`${origin}/api/learning/pages/${pageId}/materials/${id}/parsed`,{method:"POST",headers:{origin,"x-synthetic-account":account,"content-type":"application/json"},body:JSON.stringify({id:randomUUID(),physicalPages:[1]})});
  expect((await parsePdf(request("b"),mp(id))).status).toBe(404);
  vi.stubEnv("LEARNING_PDF_SERVICE_URL","");const response=await parsePdf(request("a"),mp(id));expect(response.status).toBe(503);expect(await response.json()).toEqual({error:"pdf_parser_not_configured"});vi.unstubAllEnvs();expect(fetch).not.toHaveBeenCalled();
  const cross=new Request(`${origin}/api/learning/pages/${pageId}`,{method:"PATCH",headers:{origin:"https://untrusted.invalid","x-synthetic-account":"a"},body:"{}"});expect((await pdfScope(cross,mp(id))).status).toBe(403);
},30000);
