import { test, expect, type APIRequestContext, type BrowserContext, type Page, type Request as BrowserRequest } from "@playwright/test";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DailyReflectionOperationLookupResponseSchema } from "../src/lib/domain/daily-reflection-api";

const dataDir = process.env.REFLECTION_ACCEPTANCE_DATA!;
const artifacts = process.env.REFLECTION_ACCEPTANCE_ARTIFACTS!;
const fixtureProvider = process.env.REFLECTION_ACCEPTANCE_PROVIDER!;
const audioPath = process.env.REFLECTION_ACCEPTANCE_AUDIO!;
const databasePath = join(dataDir, "daily-reflection.sqlite");
test.use({ actionTimeout: 20000, navigationTimeout: 30000 });
type Receipt = { reflectionId: string; uploadId: string; jobId: string; contentHash: string };
type Submission = { fields: Record<string, string>; name: string; bytes: Buffer; hash: string };
type Backup = { operationKey: string; recordingDate: string; sourceOrigin: string | null; hash: string; size: number };
function barrier<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((done) => { release = done; });
  return { promise, release };
}
function database<T>(run: (db: Database.Database) => T) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try { return run(db); } finally { db.close(); }
}
function counts(accountId: string, reflectionId: string) {
  return database((db) => Object.fromEntries([
    "dr_reflections", "dr_v2_input_receipts", "dr_v2_reflection_inputs", "dr_processing_plans",
    "dr_processing_plans_v2", "dr_reflection_cards", "dr_admission_operations"
  ].map((table) => [table, (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id = ? AND ${table === "dr_reflections" ? "id" : "reflection_id"} = ?`)
    .get(accountId, reflectionId) as { n: number }).n])));
}
function canonicalUpload(accountId: string, reflectionId: string) {
  return database((db) => {
    const row = db.prepare("SELECT payload_json FROM dr_asset_publications WHERE account_id = ? AND reflection_id = ? AND asset_kind = 'upload'")
      .get(accountId, reflectionId) as { payload_json: string };
    return JSON.parse(row.payload_json) as { filePath: string };
  });
}
async function register(api: APIRequestContext, label: string) {
  const response = await api.post("/api/auth/register", { data: {
    email: `${label}-${Date.now()}@acceptance.invalid`, password: "SyntheticLocalOnly!2026", name: "合成验收", inviteCode: "reflection-e2e"
  } });
  expect(response.status()).toBe(201);
  return (await response.json() as { user: { id: string } }).user.id;
}
async function lookup(api: APIRequestContext, key: string) {
  const response = await api.get(`/api/daily-reflections/operations/${encodeURIComponent(key)}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  return DailyReflectionOperationLookupResponseSchema.parse(await response.json());
}
async function submit(api: APIRequestContext, submission: Submission) {
  return api.post("/api/daily-reflections", { multipart: { ...submission.fields,
    file: { name: submission.name, mimeType: "audio/webm;codecs=opus", buffer: submission.bytes } } });
}
async function parseSubmission(request: BrowserRequest): Promise<Submission> {
  const body = new Uint8Array(request.postDataBuffer()!);
  const form = await new Request("http://127.0.0.1/", { method: "POST", body,
    headers: { "content-type": request.headers()["content-type"] } }).formData();
  const file = form.get("file") as File;
  const bytes = Buffer.from(await file.arrayBuffer());
  const fields: Record<string, string> = {};
  for (const [key, value] of form) if (typeof value === "string") fields[key] = value;
  return { fields, bytes, name: file.name, hash: createHash("sha256").update(bytes).digest("hex") };
}
async function backup(page: Page, accountId: string): Promise<Backup | null> {
  return page.evaluate(async (id) => {
    const row = await new Promise<{ operationKey: string; recordingDate: string; sourceOrigin: string | null; file: Blob } | undefined>((done, reject) => {
      const request = indexedDB.open("daily-reflection-recording-recovery", 1);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("recordings")) { db.close(); done(undefined); return; }
        const read = db.transaction("recordings", "readonly").objectStore("recordings").get(id);
        read.onsuccess = () => { db.close(); done(read.result); };
        read.onerror = () => { db.close(); reject(new Error("backup_read_failed")); };
      };
      request.onerror = () => reject(new Error("backup_open_failed"));
    });
    if (!row) return null;
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await row.file.arrayBuffer())))
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return { operationKey: row.operationKey, sourceOrigin: row.sourceOrigin, recordingDate: row.recordingDate, size: row.file.size, hash };
  }, accountId);
}
async function recorder(context: BrowserContext) {
  await context.addInitScript(({ encoded }) => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
      const track = { kind: "audio", readyState: "live", stop() { this.readyState = "ended"; } };
      return { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] };
    } });
    class Recorder {
      static isTypeSupported(type: string) { return type.startsWith("audio/webm"); }
      state = "inactive";
      mimeType = "audio/webm;codecs=opus";
      onstart: ((event: Event) => void) | null = null;
      onstop: ((event: Event) => void) | null = null;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      start() { this.state = "recording"; this.onstart?.(new Event("start")); }
      stop() {
        this.state = "inactive";
        queueMicrotask(() => {
          const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
          this.ondataavailable?.({ data: new Blob([bytes], { type: this.mimeType }) });
          this.onstop?.(new Event("stop"));
        });
      }
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: Recorder });
  }, { encoded: (await readFile(audioPath)).toString("base64") });
}
async function record(page: Page) {
  await page.goto("/reflection");
  await page.getByRole("button", { name: "开始讲述，进入录音" }).click();
  await page.getByRole("button", { name: "结束表达", exact: true }).click();
  await expect(page.getByText("录音已结束 · 尚未上传")).toBeVisible();
  await page.getByRole("combobox", { name: "这段录音来自" }).selectOption("direct_conversation");
  await expect(page.getByRole("button", { name: "核对进度并继续上传" })).toBeEnabled();
}
async function home(page: Page) {
  await page.locator('a[href="/reflection"]').filter({ visible: true }).first().click();
  await expect(page.getByRole("button", { name: "开始讲述，进入录音" })).toBeVisible();
}
async function reviewPending(api: APIRequestContext, key: string) {
  await expect.poll(async () => {
    const found = await lookup(api, key);
    return found.found ? found.status : "missing";
  }, { timeout: 90000, intervals: [200, 500, 1000] }).toBe("review_pending");
}
async function evidence(name: string, value: unknown) {
  await writeFile(join(artifacts, `${name}.json`), JSON.stringify({ databasePath, ...value as object }, null, 2));
}
test.beforeEach(async ({ context }) => {
  // No API fixtures: guard only. Test-specific routes inject transport faults
  // before sending or after route.fetch completed against the real local app.
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") { await route.abort(); throw new Error("browser_external_request_blocked"); }
    await route.continue();
  });
  await context.routeWebSocket((url) => url.hostname !== "127.0.0.1", (socket) => socket.close());
  await recorder(context);
});

test("1/4 navigation, lost real receipt, reopen, accepted cleanup, replay and account isolation", async ({ page, context, browser }) => {
  const accountId = await register(context.request, "reopen");
  const received = barrier<{ receipt: Receipt; submission: Submission }>();
  const release = barrier<void>();
  let posts = 0;
  context.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/daily-reflections") posts++;
  });
  let blockLookup = true;
  await context.route("**/api/daily-reflections/operations/*", async (route) => {
    if (blockLookup) await route.abort("connectionreset"); else await route.fallback();
  });
  await page.route("**/api/daily-reflections", async (route) => {
    if (route.request().method() !== "POST") { await route.fallback(); return; }
    const submission = await parseSubmission(route.request());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const body = await response.json() as Receipt;
    const receipt = { reflectionId: body.reflectionId, uploadId: body.uploadId, jobId: body.jobId, contentHash: body.contentHash };
    received.release({ receipt, submission });
    await release.promise;
    await route.abort("connectionreset").catch(() => {});
  });
  try {
    await record(page);
    await page.getByRole("button", { name: "核对进度并继续上传" }).click();
    const { receipt, submission } = await received.promise;
    const key = submission.fields.operationKey;
    expect(receipt.contentHash).toBe(submission.hash);
    await home(page);
    await expect(page.getByText("正在上传 · 尚未确认保存")).toBeVisible();
    await page.getByRole("button", { name: "开始讲述，进入录音" }).click();
    await expect(page.getByRole("button", { name: "结束表达", exact: true })).toHaveCount(0);
    await home(page);
    await page.getByRole("link", { name: "卡片", exact: true }).filter({ visible: true }).click();
    await home(page);
    await page.getByRole("link", { name: "最近复盘", exact: true }).click();
    expect((await backup(page, accountId))?.hash).toBe(submission.hash);
    expect(posts).toBe(1);
    release.release();
    await page.reload();
    const preserved = await backup(page, accountId);
    expect(preserved).toMatchObject({ operationKey: key, hash: submission.hash, sourceOrigin: "direct_conversation" });
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto("/reflection");
    expect(await backup(reopened, accountId)).toEqual(preserved);
    blockLookup = false;
    await reopened.getByRole("link", { name: "继续这次复盘", exact: true }).click();
    // Entering capture resumes the lookup. Accepted removes this button itself.
    await expect.poll(() => backup(reopened, accountId)).toBeNull();
    const recovered = await lookup(context.request, key);
    expect(recovered).toMatchObject({ found: true, uploadState: "accepted", ...receipt });
    expect(posts).toBe(1);
    await reviewPending(context.request, key);
    const upload = canonicalUpload(accountId, receipt.reflectionId);
    await expect.poll(async () => access(upload.filePath).then(() => false, () => true)).toBe(true);
    expect(await lookup(context.request, key)).toMatchObject({ found: true, status: "review_pending", uploadState: "accepted" });
    const beforeReplay = counts(accountId, receipt.reflectionId);
    const replays = await Promise.all([submit(context.request, submission), submit(context.request, submission)]);
    for (const response of replays) {
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject(receipt);
    }
    expect(counts(accountId, receipt.reflectionId)).toEqual(beforeReplay);
    expect(beforeReplay).toMatchObject({ dr_reflections: 1, dr_v2_input_receipts: 1, dr_v2_reflection_inputs: 1,
      dr_processing_plans: 1, dr_processing_plans_v2: 1, dr_reflection_cards: 1, dr_admission_operations: 0 });
    const conflict = await submit(context.request, { ...submission, fields: { ...submission.fields, sourceOrigin: "user_reflection" } });
    expect(conflict.status()).toBe(409);
    const other = await browser.newContext({ baseURL: process.env.DATE_COMPANION_E2E_BASE_URL });
    try {
      expect((await other.request.get(`/api/daily-reflections/operations/${encodeURIComponent(key)}`)).status()).toBe(401);
      await register(other.request, "other-account");
      expect(await lookup(other.request, key)).toEqual({ found: false });
      expect((await other.request.get(`/api/daily-reflections/${receipt.reflectionId}`)).status()).toBe(404);
      expect((await other.request.delete(`/api/daily-reflections/${receipt.reflectionId}`)).status()).toBe(404);
    } finally { await other.close(); }
    expect((await context.request.delete(`/api/daily-reflections/${receipt.reflectionId}`)).status()).toBe(204);
    expect(await lookup(context.request, key)).toMatchObject({ found: true, uploadState: "terminated", status: "deleted" });
    expect((await submit(context.request, submission)).status()).toBe(404);
    await evidence("reopen-receipt", { receipt, browserPosts: posts, samePayloadHash: true, countsBeforeReplay: beforeReplay,
      countsAfterDelete: counts(accountId, receipt.reflectionId), normalCleanupAccepted: true, accountIsolation: true });
  } finally { release.release(); }
});

test("2/4 interrupted before receipt, refresh preserves bytes and safe retransmission creates one operation", async ({ page, context }) => {
  const accountId = await register(context.request, "retransmit");
  const submissions: Submission[] = [];
  await page.route("**/api/daily-reflections", async (route) => {
    if (route.request().method() !== "POST") { await route.fallback(); return; }
    submissions.push(await parseSubmission(route.request()));
    if (submissions.length === 1) await route.abort("connectionreset"); else await route.fallback();
  });
  await record(page);
  await page.getByRole("button", { name: "核对进度并继续上传" }).click();
  await expect.poll(() => submissions.length).toBe(1);
  await expect(page.getByRole("button", { name: "核对进度并继续上传" })).toBeEnabled();
  const before = await backup(page, accountId);
  expect(before?.hash).toBe(submissions[0].hash);
  expect(await lookup(context.request, submissions[0].fields.operationKey)).toEqual({ found: false });
  await page.reload();
  expect(await backup(page, accountId)).toEqual(before);
  await page.getByRole("button", { name: "核对进度并继续上传" }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1].fields).toEqual(submissions[0].fields);
  expect(submissions[1].bytes.equals(submissions[0].bytes)).toBe(true);
  await expect.poll(() => backup(page, accountId), { timeout: 60000 }).toBeNull();
  const key = submissions[0].fields.operationKey;
  await reviewPending(context.request, key);
  const found = await lookup(context.request, key);
  expect(found.found).toBe(true);
  if (!found.found) throw new Error("missing_retransmitted_operation");
  expect(counts(accountId, found.reflectionId)).toMatchObject({ dr_reflections: 1, dr_v2_input_receipts: 1, dr_processing_plans_v2: 1, dr_admission_operations: 0 });
  await evidence("safe-retransmit", { browserPosts: submissions.length, sameBytesAndFields: true, lookup: found,
    counts: counts(accountId, found.reflectionId) });
});

for (const [index, action] of ["cancel", "delete"].entries()) {
  test(`${index + 3}/4 ${action} while real local Provider request is pending rejects late publication and replay`, async ({ context }) => {
    const accountId = await register(context.request, action);
    const bytes = await readFile(audioPath);
    const key = `acceptance-${action}`;
    const submission: Submission = { bytes, name: "synthetic.webm", hash: createHash("sha256").update(bytes).digest("hex"), fields: {
      operationKey: key, idempotencyKey: key, inputMethod: "browser_recording", inputAdapter: "browser_recorder",
      sourceOrigin: "direct_conversation", capturePurpose: "inspiration_capture", recordingDate: "2026-09-07", clientReportedDurationMs: "90000"
    } };
    expect((await context.request.post(`${fixtureProvider}/control/hold`)).ok()).toBe(true);
    try {
      const posted = await submit(context.request, submission);
      expect(posted.ok()).toBe(true);
      const receipt = await posted.json() as Receipt;
      await expect.poll(async () => (await (await context.request.get(`${fixtureProvider}/control/status`)).json() as { heldRequests: number }).heldRequests,
        { timeout: 60000 }).toBe(1);
      expect(await lookup(context.request, key)).toMatchObject({ found: true, uploadState: "accepted" });
      const terminal = action === "cancel"
        ? await context.request.post(`/api/daily-reflections/${receipt.reflectionId}/cancel`)
        : await context.request.delete(`/api/daily-reflections/${receipt.reflectionId}`);
      expect(terminal.status()).toBe(action === "cancel" ? 200 : 204);
      await context.request.post(`${fixtureProvider}/control/release`);
      await expect.poll(() => database((db) => (db.prepare("SELECT lease_owner FROM dr_reflections WHERE id = ?").get(receipt.reflectionId) as { lease_owner: string | null }).lease_owner)).toBeNull();
      expect(await lookup(context.request, key)).toMatchObject({ found: true, status: action === "cancel" ? "cancelled" : "deleted", uploadState: "terminated" });
      expect((await submit(context.request, submission)).status()).toBe(action === "cancel" ? 409 : 404);
      expect(counts(accountId, receipt.reflectionId)).toMatchObject({ dr_reflections: 1, dr_v2_input_receipts: 1, dr_reflection_cards: 0, dr_admission_operations: 0 });
      await evidence(`late-${action}`, { receipt, terminalStatus: terminal.status(), counts: counts(accountId, receipt.reflectionId), lateProviderReleased: true });
    } finally { await context.request.post(`${fixtureProvider}/control/release`); }
  });
}
