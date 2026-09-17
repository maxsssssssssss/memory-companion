import { test, expect, request as requestFactory, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  DailyReflectionDetailResponseSchema,
  DailyReflectionHistoryResponseSchema,
  DailyReflectionOperationLookupResponseSchema
} from "../src/lib/domain/daily-reflection-api";
import { ProcessingPlanV2Schema } from "../src/lib/domain/daily-reflection";

const media = process.env.REFLECTION_DURATION_MEDIA!;
const artifacts = process.env.REFLECTION_DURATION_ARTIFACTS!;
const dataDir = process.env.APP_DATA_DIR!;
const fixtureUrl = process.env.REFLECTION_DURATION_FIXTURE!;
const baseUrl = process.env.REFLECTION_DURATION_BASE_URL!;
const missingEnvironment = [
  "REFLECTION_DURATION_MEDIA", "REFLECTION_DURATION_ARTIFACTS", "APP_DATA_DIR",
  "REFLECTION_DURATION_FIXTURE", "REFLECTION_DURATION_BASE_URL"
].filter(name => !process.env[name]?.trim());
const configured = missingEnvironment.length === 0;
const databasePath = configured ? join(dataDir, "daily-reflection.sqlite") : "";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Sample = { id: string; file: string; nominalMs: number | null; expectedInvalid: boolean; noAudio: boolean; sha256: string };
type Submission = { fields: Record<string, string>; file: string; bytes: number; hash: string };
type Backup = { operationKey: string; hash: string; bytes: number; inputAdapter?: string; sourceOrigin: string; recordingDate: string };
const samples = configured
  ? (JSON.parse(await readFile(join(media, "manifest.json"), "utf8")) as { cases: Sample[] }).cases
  : [];

test.use({ actionTimeout: 20000, navigationTimeout: 45000 });
async function register(api: APIRequestContext, label: string) {
  const response = await api.post("/api/auth/register", { data: {
    email: `${label}-${Date.now()}@synthetic.invalid`, password: "LocalFixtureOnly2026!", name: "合成验收", inviteCode: "reflection-duration-evaluation"
  } });
  expect(response.status()).toBe(201);
  return (await response.json() as { user: { id: string } }).user.id;
}
async function control(api: APIRequestContext, command: string) {
  const response = await api.post(`${fixtureUrl}/control/${command}`);
  expect(response.ok()).toBe(true);
}
async function lookup(api: APIRequestContext, key: string) {
  const response = await api.get(`/api/daily-reflections/operations/${encodeURIComponent(key)}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  return DailyReflectionOperationLookupResponseSchema.parse(await response.json());
}
async function detail(api: APIRequestContext, id: string) {
  const response = await api.get(`/api/daily-reflections/${id}`);
  expect(response.status()).toBe(200);
  return DailyReflectionDetailResponseSchema.parse(await response.json());
}
async function completed(api: APIRequestContext, key: string) {
  await expect.poll(async () => {
    const found = await lookup(api, key); return found.found ? found.status : "missing";
  }, { timeout: 60000, intervals: [100, 250, 500] }).toBe("review_pending");
  const found = await lookup(api, key);
  if (!found.found) throw new Error("fixture_receipt_missing");
  expect(found.uploadState).toBe("accepted"); expect(found.uploadFailure).toBeNull();
  const value = await detail(api, found.reflectionId);
  expect(value.cards.length).toBeGreaterThan(0);
  expect(value.cards.every(card => card.reviewStatus === "pending")).toBe(true);
  return value;
}
function readDatabase<T>(callback: (db: Database.Database) => T) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try { return callback(db); } finally { db.close(); }
}
function counts(account: string, reflection: string) {
  return readDatabase(db => Object.fromEntries([
    "dr_reflections", "dr_v2_input_receipts", "dr_processing_plans_v2", "dr_reflection_cards", "dr_admission_operations"
  ].map(table => [table, (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=? AND ${table === "dr_reflections" ? "id" : "reflection_id"}=?`)
    .get(account, reflection) as { n: number }).n])));
}
async function watchPosts(context: BrowserContext) {
  const posts: Submission[] = [];
  await context.exposeBinding("__captureSyntheticUpload", (_source, value: Submission) => { posts.push(value); });
  await context.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async function (input, init) {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === "/api/daily-reflections" && init?.method === "POST" && init.body instanceof FormData) {
        const file = init.body.get("file") as File;
        const fields = Object.fromEntries([...init.body].filter((entry): entry is [string, string] => typeof entry[1] === "string"));
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))]
          .map(byte => byte.toString(16).padStart(2, "0")).join("");
        await (window as unknown as { __captureSyntheticUpload: (value: unknown) => Promise<void> }).__captureSyntheticUpload(
          { fields, file: file.name, bytes: file.size, hash: digest });
      }
      return original.call(this, input, init);
    };
  });
  return { posts, async first() { await expect.poll(() => posts.length).toBeGreaterThan(0); return posts[0]; } };
}
async function backup(page: Page, account: string): Promise<Backup | null> {
  return page.evaluate(async accountId => {
    const row = await new Promise<{ operationKey: string; file: Blob; inputAdapter?: string; sourceOrigin: string; recordingDate: string } | undefined>((done, reject) => {
      const opening = indexedDB.open("daily-reflection-recording-recovery", 1);
      opening.onsuccess = () => {
        const db = opening.result;
        if (!db.objectStoreNames.contains("recordings")) { db.close(); done(undefined); return; }
        const request = db.transaction("recordings", "readonly").objectStore("recordings").get(accountId);
        request.onsuccess = () => { db.close(); done(request.result); };
        request.onerror = () => { db.close(); reject(new Error("fixture_backup_read_failed")); };
      };
      opening.onerror = () => reject(new Error("fixture_backup_open_failed"));
    });
    if (!row) return null;
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await row.file.arrayBuffer()))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    return { operationKey: row.operationKey, hash: digest, bytes: row.file.size, inputAdapter: row.inputAdapter,
      sourceOrigin: row.sourceOrigin, recordingDate: row.recordingDate };
  }, account);
}
async function recorder(context: BrowserContext) {
  await context.addInitScript(({ encoded }) => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => {
      const track = { kind: "audio", readyState: "live", stop() { this.readyState = "ended"; } };
      return { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] };
    } } });
    class Recorder {
      static isTypeSupported(type: string) { return type.startsWith("audio/webm"); }
      state = "inactive"; mimeType = "audio/webm;codecs=opus";
      onstart: ((event: Event) => void) | null = null;
      onstop: ((event: Event) => void) | null = null;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      start() { this.state = "recording"; this.onstart?.(new Event("start")); }
      stop() { this.state = "inactive"; queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob([Uint8Array.from(atob(encoded), character => character.charCodeAt(0))], { type: this.mimeType }) });
        this.onstop?.(new Event("stop"));
      }); }
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: Recorder });
  }, { encoded: (await readFile(join(media, "webm-live.webm"))).toString("base64") });
}
async function record(page: Page) {
  await page.goto("/reflection");
  await page.getByRole("button", { name: "开始讲述，进入录音" }).click();
  await page.getByRole("button", { name: "结束表达", exact: true }).click();
  await expect(page.getByText("原音频尚未上传", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "这段录音来自" }).selectOption("direct_conversation");
}
async function pick(page: Page, filename = "webm-live.webm") {
  await page.goto("/reflection/capture?new=1&method=upload");
  const form = page.getByRole("form", { name: "上传日常复盘录音" });
  await form.getByRole("radio", { name: "我自己的复盘", exact: true }).check();
  await form.locator('input[type="file"]').setInputFiles(join(media, filename));
  await form.getByRole("button", { name: "开始整理", exact: true }).click();
}
const recovery = (page: Page) => page.getByRole("complementary", { name: "这次录音的保存状态" }).filter({ visible: true });
async function screenshot(page: Page, name: string) { await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true }); }
async function saveEvidence(name: string, value: unknown) { await writeFile(join(artifacts, `${name}.json`), JSON.stringify(value, null, 2)); }

if (!configured) {
  test.skip(`Duration acceptance requires dedicated fixture environment: ${missingEnvironment.join(", ")}`, () => {});
} else {
test.afterEach(async ({ request }) => {
  await control(request, "probe-restore"); await control(request, "release-ai");
});

for (const [index, sample] of samples.entries()) {
test(`HTTP ${index + 1}/18 ${sample.id}: canonical save and real processing or safe rejection`, async ({ request }) => {
  const context = { request };
  const account = await register(context.request, `matrix-${sample.id}`);
  const evidence = [];
  const mimeByExtension: Record<string, string> = { webm: "audio/webm", wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac", aac: "audio/aac", pcm: "audio/x-pcm" };
    await control(context.request, "hold-ai");
    const key = `duration-matrix-${sample.id}`;
    const bytes = await readFile(join(media, sample.file));
    const multipart = {
      operationKey: key, idempotencyKey: key, inputMethod: "file_upload", inputAdapter: "file_picker",
      sourceOrigin: "user_reflection", capturePurpose: "inspiration_capture", recordingDate: "2026-09-16", clientReportedDurationMs: "999999999",
      file: { name: sample.file, mimeType: mimeByExtension[sample.file.split(".").at(-1)!], buffer: bytes }
    };
    const response = await context.request.post("/api/daily-reflections", { multipart });
    const found = await lookup(context.request, key);
    expect(found.found).toBe(true); if (!found.found) throw new Error("fixture_operation_missing");
    if (sample.expectedInvalid || sample.noAudio) {
      expect(response.status()).toBeGreaterThanOrEqual(400);
      expect(found.uploadState).toBe("unresolved");
      expect(found.uploadFailure).toEqual({ code: sample.noAudio ? "daily_reflection_audio_no_track" : "daily_reflection_audio_invalid", retryable: false });
      const saved = counts(account, found.reflectionId);
      expect(saved.dr_processing_plans_v2).toBe(0); expect(saved.dr_reflection_cards).toBe(0);
      const view = await detail(context.request, found.reflectionId);
      expect(view.uploadFailure).toEqual(found.uploadFailure);
      evidence.push({ id: sample.id, http: response.status(), state: found.uploadState, failure: found.uploadFailure });
    } else {
      expect(response.status()).toBe(201);
      expect(found.uploadState).toBe("accepted"); expect(found.uploadFailure).toBeNull();
      const view = await detail(context.request, found.reflectionId);
      const plan = ProcessingPlanV2Schema.parse(view.processingPlan);
      expect(plan.processingProfile).toBe(sample.nominalMs! <= 180000 ? "quick_reflection" : "full_recording");
      expect(Math.abs(plan.effectiveDurationMs - sample.nominalMs!)).toBeLessThanOrEqual(200);
      const publication = readDatabase(db => db.prepare("SELECT payload_json FROM dr_asset_publications WHERE account_id=? AND reflection_id=? AND asset_kind='upload'")
        .get(account, found.reflectionId) as { payload_json: string });
      const upload = JSON.parse(publication.payload_json) as { filePath: string };
      expect(resolve(upload.filePath).startsWith(resolve(dataDir) + sep)).toBe(true);
      const storedBytes = await readFile(upload.filePath);
      expect(hash(sample.id === "pcm-contract" ? storedBytes.subarray(44) : storedBytes)).toBe(sample.sha256);
      await control(context.request, "release-ai");
      const final = await completed(context.request, key);
      const saved = counts(account, found.reflectionId);
      expect(saved.dr_v2_input_receipts).toBe(1); expect(saved.dr_processing_plans_v2).toBe(1); expect(saved.dr_admission_operations).toBe(0);
      evidence.push({ id: sample.id, http: response.status(), state: found.uploadState, plan: final.processingPlan, cards: final.cards.length, counts: saved });
      if (sample.id === "webm-live") {
        const repeated = await context.request.post("/api/daily-reflections", { multipart });
        expect(repeated.status()).toBe(200);
        expect(await lookup(context.request, key)).toMatchObject({ reflectionId: found.reflectionId, uploadState: "accepted" });
        expect(counts(account, found.reflectionId)).toEqual(saved);
        const conflicting = await context.request.post("/api/daily-reflections", { multipart: { ...multipart, sourceOrigin: "direct_conversation" } });
        expect(conflicting.status()).toBe(409);
        const foreign = await requestFactory.newContext({ baseURL: baseUrl });
        try {
          await register(foreign, "foreign-account");
          expect(await lookup(foreign, key)).toEqual({ found: false });
          expect((await foreign.get(`/api/daily-reflections/${found.reflectionId}`)).status()).toBe(404);
        } finally { await foreign.dispose(); }
      }
    }
    console.log(`[duration-http] ${index + 1}/${samples.length} ${sample.id}`);
  const history = DailyReflectionHistoryResponseSchema.parse(await (await context.request.get("/api/daily-reflections")).json());
  expect(history.reflections).toHaveLength(1);
  await saveEvidence(`http-${sample.id}`, { evidence: "real local HTTP/SQLite/tools; ASR and AI fixture", cases: evidence });
});
}

test.describe("Browser recovery", () => {
test.beforeEach(async ({ context }) => {
  const allowed = new Set([new URL(baseUrl).origin, new URL(fixtureUrl).origin]);
  await context.route("**/*", async route => {
    if (!allowed.has(new URL(route.request().url()).origin)) { await route.abort(); throw new Error("browser_external_request_blocked"); }
    await route.continue();
  });
  await context.routeWebSocket(url => url.hostname !== "127.0.0.1", socket => socket.close());
  await recorder(context);
  await control(context.request, "probe-restore"); await control(context.request, "release-ai");
});
test("Browser recording without duration reaches the final review and releases backup only after accepted", async ({ page, context }) => {
  const account = await register(context.request, "browser-recording"); const capture = await watchPosts(context);
  await record(page);
  await expect.poll(async () => (await backup(page, account))?.bytes ?? 0).toBeGreaterThan(0);
  await page.getByRole("button", { name: "核对进度并继续上传" }).click();
  const first = await capture.first();
  expect(first.fields.inputAdapter).toBe("browser_recorder"); expect(first.hash).toBe(samples.find(sample => sample.id === "webm-live")!.sha256);
  const final = await completed(context.request, first.fields.operationKey);
  await expect.poll(() => backup(page, account)).toBeNull();
  await expect(page.getByText(final.cards[0].proposedTitle, { exact: true }).first()).toBeVisible();
  expect(capture.posts).toHaveLength(1);
  expect(ProcessingPlanV2Schema.parse(final.processingPlan).effectiveDurationMs).toBe(12000);
  await screenshot(page, "desktop-recording-complete");
});

test("Mobile file picker without duration uses the same canonical processing result", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const account = await register(context.request, "mobile-picker"); const capture = await watchPosts(context);
  await pick(page);
  const first = await capture.first(); expect(first.fields.inputAdapter).toBe("file_picker");
  const final = await completed(context.request, first.fields.operationKey);
  await expect(page.getByText(final.cards[0].proposedTitle, { exact: true }).first()).toBeVisible();
  await expect.poll(() => backup(page, account)).toBeNull();
  expect(capture.posts).toHaveLength(1); expect(ProcessingPlanV2Schema.parse(final.processingPlan).effectiveDurationMs).toBe(12000);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await screenshot(page, "mobile-file-picker-complete");
});

test("Safe tool failure stays visible across navigation and refresh; download and same-key retry preserve the original", async ({ page, context }) => {
  const account = await register(context.request, "retryable"); const capture = await watchPosts(context);
  await control(context.request, "probe-missing"); await pick(page);
  const first = await capture.first();
  await expect(recovery(page).getByText("录音保存失败", { exact: true })).toBeVisible();
  await expect(recovery(page).getByRole("alert").filter({ hasText: "daily_reflection_duration_tool_unavailable" })).toBeVisible();
  const failed = await lookup(context.request, first.fields.operationKey);
  expect(failed.found && failed.uploadState).toBe("reupload_allowed");
  expect(await backup(page, account)).toMatchObject({ hash: first.hash, operationKey: first.fields.operationKey, inputAdapter: "file_picker" });
  await page.locator('a[href="/reflection"]').filter({ visible: true }).first().click();
  await expect(page.getByText("录音保存失败", { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("录音保存失败", { exact: true }).first()).toBeVisible();
  // A pending capture is restored directly after refresh; no extra link is required.
  await expect(page.getByRole("heading", { name: "继续这次复盘", exact: true })).toBeVisible();
  await expect(recovery(page).getByRole("button", { name: "重试上传", exact: true })).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await recovery(page).getByRole("link", { name: "下载原录音" }).click();
  const download = await downloadEvent; const downloaded = await download.path(); expect(downloaded).not.toBeNull();
  expect(hash(await readFile(downloaded!))).toBe(first.hash);
  await screenshot(page, "desktop-persisted-failure");
  expect(capture.posts).toHaveLength(1);
  await control(context.request, "probe-restore");
  await recovery(page).getByRole("button", { name: "重试上传", exact: true }).click();
  await completed(context.request, first.fields.operationKey);
  await expect.poll(() => capture.posts.length).toBe(2);
  expect(capture.posts[1].hash).toBe(first.hash); expect(capture.posts[1].fields).toEqual(first.fields);
  const found = await lookup(context.request, first.fields.operationKey); if (!found.found) throw new Error("missing_after_retry");
  expect(counts(account, found.reflectionId)).toMatchObject({ dr_reflections: 1, dr_v2_input_receipts: 1, dr_processing_plans_v2: 1 });
  await expect.poll(() => backup(page, account)).toBeNull();
});

test("Mobile missing local copy requests the same original file and does not auto-upload", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const account = await register(context.request, "missing-copy"); const capture = await watchPosts(context);
  await control(context.request, "probe-missing"); await pick(page);
  const first = await capture.first();
  await expect(recovery(page).getByText("录音保存失败", { exact: true })).toBeVisible();
  expect(first.hash).toBe(samples.find(sample => sample.id === "webm-live")!.sha256);
  await page.evaluate(async accountId => {
    await new Promise<void>((done, reject) => {
      const request = indexedDB.open("daily-reflection-recording-recovery", 1);
      request.onsuccess = () => { const db = request.result; const tx = db.transaction("recordings", "readwrite");
        tx.objectStore("recordings").delete(accountId); tx.oncomplete = () => { db.close(); done(); }; tx.onerror = () => reject(new Error("fixture_remove_backup_failed")); };
    });
  }, account);
  await page.reload();
  await expect(page.getByText(/此浏览器没有可用的本地副本/)).toBeVisible();
  expect(capture.posts).toHaveLength(1);
  await control(context.request, "probe-restore");
  await page.getByLabel("重新选择原文件").setInputFiles(join(media, "webm-live.webm"));
  await recovery(page).getByRole("button", { name: "重试上传", exact: true }).click();
  await completed(context.request, first.fields.operationKey);
  await expect.poll(() => capture.posts.length).toBe(2);
  expect(capture.posts[1].fields.operationKey).toBe(first.fields.operationKey); expect(capture.posts[1].hash).toBe(first.hash);
});

test("Corrupt file cannot be accepted or retried as valid; delete failed record and start a new recording", async ({ page, context }) => {
  const account = await register(context.request, "bad-file"); const capture = await watchPosts(context);
  await pick(page, "truncated-live.webm"); const first = await capture.first();
  await expect(recovery(page).getByText("录音保存失败", { exact: true })).toBeVisible();
  await expect(recovery(page).getByRole("button", { name: "重试上传", exact: true })).toHaveCount(0);
  await expect(recovery(page).getByRole("alert").filter({ hasText: "daily_reflection_audio_invalid" })).toBeVisible();
  expect((await backup(page, account))?.hash).toBe(first.hash);
  await recovery(page).getByRole("button", { name: "删除失败记录", exact: true }).click();
  await page.getByRole("button", { name: "确认删除失败记录", exact: true }).click();
  await expect.poll(() => backup(page, account)).toBeNull();
  const terminal = await lookup(context.request, first.fields.operationKey);
  expect(terminal.found && terminal.uploadState).toBe("terminated");
  await record(page); await page.getByRole("button", { name: "核对进度并继续上传" }).click();
  await expect.poll(() => capture.posts.length).toBe(2);
  expect(capture.posts[1].fields.operationKey).not.toBe(first.fields.operationKey);
  await completed(context.request, capture.posts[1].fields.operationKey);
  expect((await lookup(context.request, first.fields.operationKey))).toEqual(terminal);
});

test("An in-flight local AI result cannot resurrect a cancelled persisted recording", async ({ context }) => {
  const account = await register(context.request, "late-result"); const key = "duration-late-result";
  await control(context.request, "hold-ai");
  const response = await context.request.post("/api/daily-reflections", { multipart: {
    operationKey: key, idempotencyKey: key, inputMethod: "browser_recording", inputAdapter: "browser_recorder", sourceOrigin: "user_reflection",
    capturePurpose: "inspiration_capture", recordingDate: "2026-09-16", file: { name: "webm-live.webm", mimeType: "audio/webm", buffer: await readFile(join(media, "webm-live.webm")) }
  } });
  expect(response.status()).toBe(201);
  await expect.poll(async () => (await (await context.request.get(`${fixtureUrl}/control/status`)).json() as { heldRequests: number }).heldRequests).toBeGreaterThan(0);
  const found = await lookup(context.request, key); if (!found.found) throw new Error("fixture_receipt_missing");
  const cancelled = await context.request.post(`/api/daily-reflections/${found.reflectionId}/cancel`);
  expect(cancelled.status()).toBe(200);
  await control(context.request, "release-ai");
  await expect.poll(async () => { const value = await lookup(context.request, key); return value.found ? value.uploadState : "missing"; }).toBe("terminated");
  expect(counts(account, found.reflectionId).dr_reflection_cards).toBe(0);
  await saveEvidence("late-result", { lookup: await lookup(context.request, key), counts: counts(account, found.reflectionId), providerEvidence: "local held fixture only" });
});

test("IndexedDB quota failure truthfully retains the current file and offers download without promising refresh recovery", async ({ page, context }) => {
  await register(context.request, "quota");
  await context.addInitScript(() => {
    const original = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (name: string, version?: number) {
      if (name === "daily-reflection-recording-recovery") throw new DOMException("Synthetic quota failure", "QuotaExceededError");
      return original.call(this, name, version);
    };
  });
  const capture = await watchPosts(context);
  await control(context.request, "probe-missing"); await pick(page);
  const first = await capture.first();
  await expect(page.getByText(/本机暂存不可用。原音频仍在当前页面/)).toBeVisible();
  await expect(recovery(page).getByRole("link", { name: "下载原录音" })).toBeVisible();
  await expect(page.getByText(/原录音已暂存在本机/)).toHaveCount(0);
  expect(capture.posts).toHaveLength(1);
  await expect(recovery(page).getByText("录音保存失败", { exact: true })).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await recovery(page).getByRole("link", { name: "下载原录音" }).click();
  const downloadPath = await (await downloadEvent).path();
  expect(downloadPath).not.toBeNull();
  expect(hash(await readFile(downloadPath!))).toBe(first.hash);
  await screenshot(page, "quota-failure-preserves-current-file");
  expect(first.hash).toBe(samples.find(sample => sample.id === "webm-live")!.sha256);
});

test("A real oversized local file is rejected before upload or a recovery promise", async ({ page, context }) => {
  await register(context.request, "oversize"); const capture = await watchPosts(context);
  const path = join(artifacts, "synthetic-oversize-webm.webm");
  const handle = await open(path, "wx");
  await handle.truncate(300 * 1024 * 1024 + 1); await handle.close();
  try {
    await page.goto("/reflection/capture?new=1&method=upload");
    const form = page.getByRole("form", { name: "上传日常复盘录音" });
    await form.getByRole("radio", { name: "我自己的复盘", exact: true }).check();
    await form.locator('input[type="file"]').setInputFiles(path);
    await expect(form.getByRole("alert")).toContainText("文件超过 300MB");
    await expect(form.getByRole("button", { name: "开始整理", exact: true })).toBeDisabled();
    expect(capture.posts).toHaveLength(0);
    await expect(page.getByText(/原录音已暂存在本机/)).toHaveCount(0);
    await saveEvidence("oversized-file", { bytes: 300 * 1024 * 1024 + 1, uploads: 0, accepted: false,
      fixture: "local size-only zero file; never submitted as audio" });
  } finally {
    // Delete only this explicitly named large size-only fixture, not a folder.
    expect(resolve(path).startsWith(resolve(artifacts) + sep)).toBe(true);
    await unlink(path);
  }
});

test("UI transport fixture: active lease and unknown are not guessed terminal; permission without failure is not labelled failed", async ({ page, context }) => {
  const account = await register(context.request, "state-fixture"); const capture = await watchPosts(context);
  await control(context.request, "probe-missing"); await pick(page);
  const first = await capture.first();
  await expect(recovery(page).getByText("录音保存失败", { exact: true })).toBeVisible();
  let state: "still_persisting" | "unresolved" | "reupload_allowed" = "still_persisting";
  // Only this case injects DTO states. Backend lease truth is separately tested
  // against SQLite; this case proves browser consumption of those contracts.
  await context.route("**/api/daily-reflections/**", async route => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    const response = await route.fetch();
    if (!response.ok()) { await route.fulfill({ response }); return; }
    const body = await response.json() as Record<string, unknown>;
    if (body.found === true) Object.assign(body, { status: "uploading", uploadState: state, uploadFailure: null });
    if (body.reflection && typeof body.reflection === "object") {
      Object.assign(body.reflection, { status: "uploading", errorCode: null });
      Object.assign(body, { uploadState: state, uploadFailure: null });
    }
    await route.fulfill({ response, json: body });
  });
  for (const next of ["still_persisting", "unresolved", "reupload_allowed"] as const) {
    state = next; await page.reload();
    await expect(recovery(page).getByText(next === "still_persisting" ? "服务器正在保存录音" : "录音保存尚未确认", { exact: true })).toBeVisible();
    await expect(recovery(page).getByText("录音保存失败", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/可以关闭页面/)).toHaveCount(0);
    expect((await backup(page, account))?.hash).toBe(first.hash);
    if (next !== "reupload_allowed") {
      await recovery(page).getByRole("button", { name: "核对进度并继续上传", exact: true }).click();
      await expect(recovery(page).getByText(next === "still_persisting" ? "服务器正在保存录音" : "录音保存尚未确认", { exact: true })).toBeVisible();
    }
    expect(capture.posts).toHaveLength(1);
  }
  await screenshot(page, "state-permission-without-failure");
});
});
}
