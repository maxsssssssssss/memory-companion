import {
  expect,
  request as playwrightRequest,
  test,
  type BrowserContext,
  type Page,
  type Route
} from "@playwright/test";
import Database from "better-sqlite3";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

type DailyReflectionReceipt = {
  reflectionId: string;
  uploadId: string;
  jobId: string;
  status: string;
  executionMode: string;
};

type DailyReflectionDetail = {
  reflection: {
    id: string;
    accountId: string;
    uploadId: string | null;
    inputMethod: string;
    sourceOrigin: string;
    status: string;
  };
  processingPlan: {
    reflectionId: string;
    uploadId: string;
    inputMethod: string;
    sourceOrigin: string;
    ingestionContext: string;
    reviewPolicy: string;
  } | null;
  upload: {
    id: string;
    originalName: string;
    recordingDate?: string;
  } | null;
  candidates: Array<{ id: string; status: string }>;
};

type NetworkAudit = {
  externalHttp: string[];
  externalWebSockets: string[];
};

const password = "ReflectionE2e!2026";
const pickerCountKey = "daily-reflection-toy-sync-e2e-picker-count";
const confirmedRecordingDate = "2026-08-16";

function progress(completed: number, total: number, message: string) {
  console.log(`[daily-reflection-toy-sync-fixture] ${completed}/${total} ${message}`);
}

function isLoopbackUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return true;
  return url.hostname === "localhost"
    || url.hostname === "::1"
    || url.hostname === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
}

async function installNetworkGuard(context: BrowserContext, audit: NetworkAudit) {
  await context.route("**/*", async (route: Route) => {
    const requestUrl = route.request().url();
    if (!isLoopbackUrl(requestUrl)) {
      audit.externalHttp.push(requestUrl);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await context.routeWebSocket(
    (url) => !isLoopbackUrl(url.toString()),
    async (webSocket) => {
      audit.externalWebSockets.push(webSocket.url());
      await webSocket.close({ code: 1008, reason: "external_websocket_blocked" });
    }
  );
  context.on("page", (page) => {
    page.on("websocket", (socket) => {
      if (!isLoopbackUrl(socket.url())) audit.externalWebSockets.push(socket.url());
    });
  });
}

async function installDirectoryPickerFixture(context: BrowserContext) {
  await context.addInitScript(({ countKey }) => {
    Object.defineProperty(globalThis, "showDirectoryPicker", {
      configurable: true,
      value: async () => {
        const previous = Number.parseInt(localStorage.getItem(countKey) ?? "0", 10);
        localStorage.setItem(countKey, String(Number.isFinite(previous) ? previous + 1 : 1));
        return navigator.storage.getDirectory();
      }
    });
  }, { countKey: pickerCountKey });
}

async function registerFixtureUser(baseURL: string, email: string) {
  const api = await playwrightRequest.newContext({ baseURL });
  try {
    const response = await api.post("/api/auth/register", {
      data: {
        email,
        password,
        name: "Toy Sync Fixture User",
        inviteCode: "reflection-e2e"
      }
    });
    expect(response.status()).toBe(201);
    const body = await response.json() as { user: { id: string } };
    return body.user.id;
  } finally {
    await api.dispose();
  }
}

async function login(page: Page, email: string) {
  await page.goto("/date-companion");
  await expect(page.getByRole("heading", { name: "把重要的人和片段，轻轻放在这里。" }))
    .toBeVisible();
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/date-companion\/modules$/u);
}

async function seedToyDirectory(page: Page, fixturePath: string) {
  const fixtureBase64 = (await readFile(fixturePath)).toString("base64");
  await page.evaluate(async ({ encodedFixture }) => {
    const binary = atob(encodedFixture);
    const audio = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const root = await navigator.storage.getDirectory();
    const recordings = await root.getDirectoryHandle("recordings", { create: true });

    const writeFile = async (
      directory: FileSystemDirectoryHandle,
      name: string,
      contents: FileSystemWriteChunkType
    ) => {
      const handle = await directory.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(contents);
      await writable.close();
    };

    await writeFile(recordings, "older.mp3", audio);
    await writeFile(recordings, "latest.mp3", audio);
    await writeFile(root, "manifest.json", JSON.stringify({
      recordings: [
        { filename: "older.mp3", created_at: "2026-08-17T08:00:00+08:00" },
        { filename: "latest.mp3", created_at: "2026-08-18T09:30:00+08:00" }
      ]
    }));
  }, { encodedFixture: fixtureBase64 });
}

async function pickerCallCount(page: Page) {
  return page.evaluate((countKey) => Number.parseInt(localStorage.getItem(countKey) ?? "0", 10), pickerCountKey);
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = join(root, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  }));
  return nested.flat().sort();
}

function assertStagingOnlyPersistence(input: {
  dataRoot: string;
  accountId: string;
  receipt: DailyReflectionReceipt;
}) {
  const database = new Database(resolve(input.dataRoot, "daily-reflection.sqlite"), {
    readonly: true,
    fileMustExist: true
  });
  try {
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_reflections WHERE account_id = ?"
    ).get(input.accountId)).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT id, upload_id, input_method, source_origin, ingestion_context, status
      FROM dr_reflections
      WHERE id = ? AND account_id = ?
    `).get(input.receipt.reflectionId, input.accountId)).toEqual({
      id: input.receipt.reflectionId,
      upload_id: input.receipt.uploadId,
      input_method: "file_upload",
      source_origin: "user_reflection",
      ingestion_context: "daily_reflection",
      status: "review_pending"
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_processing_plans WHERE account_id = ?"
    ).get(input.accountId)).toEqual({ count: 1 });
    for (const table of [
      "dr_reflection_confirmations",
      "dr_admission_operations",
      "dr_candidate_admission_receipts"
    ]) {
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE account_id = ?`
      ).get(input.accountId), `${table} must remain empty before confirmation`).toEqual({ count: 0 });
    }
  } finally {
    database.close();
  }

  const memoryDatabase = new Database(resolve(input.dataRoot, "memory.sqlite"), {
    readonly: true,
    fileMustExist: true
  });
  try {
    for (const table of [
      "memory_items",
      "memory_evidence",
      "person_entities",
      "person_evidence",
      "person_subject_observations",
      "person_relationships"
    ]) {
      const row = memoryDatabase.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      };
      expect(row.count, `${table} must remain empty before confirmation`).toBe(0);
    }
  } finally {
    memoryDatabase.close();
  }
}

test("restores a granted toy directory and stages its newest recording exactly once", async ({
  browser,
  baseURL
}) => {
  test.setTimeout(300_000);
  if (!baseURL) throw new Error("DAILY_REFLECTION_E2E_BASE_URL is required");
  const fixturePath = process.env.DAILY_REFLECTION_E2E_FIXTURE_PATH;
  const artifactDir = process.env.DAILY_REFLECTION_E2E_ARTIFACT_DIR;
  const dataRoot = process.env.DAILY_REFLECTION_E2E_DATA_DIR;
  if (!fixturePath || !artifactDir || !dataRoot) {
    throw new Error("Toy Sync fixture path, artifact directory, and data directory are required");
  }
  await mkdir(artifactDir, { recursive: true });

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `reflection-toy-${suffix}@example.com`;
  const accountId = await registerFixtureUser(baseURL, email);
  progress(1, 12, "fixture account registered through the real local auth API");

  const context = await browser.newContext({
    locale: "zh-CN",
    serviceWorkers: "block",
    timezoneId: "Asia/Shanghai",
    viewport: { width: 1440, height: 1100 }
  });
  const network: NetworkAudit = { externalHttp: [], externalWebSockets: [] };
  await installNetworkGuard(context, network);
  await installDirectoryPickerFixture(context);
  const page = await context.newPage();
  const postRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/daily-reflections") {
      postRequests.push(request.url());
    }
  });

  await login(page, email);
  await page.getByRole("link", { name: /日常复盘/u }).click();
  await expect(page).toHaveURL(/\/date-companion\/reflection$/u);
  await expect(page.getByRole("heading", { name: "连接玩偶录音" })).toBeVisible();
  await seedToyDirectory(page, fixturePath);
  progress(2, 12, "real OPFS root seeded with recordings plus optional device manifest");

  await page.getByRole("button", { name: "连接玩偶" }).click();
  await expect(page.getByText("已连接玩偶", { exact: true })).toBeVisible();
  await expect(page.getByText("发现 2 条录音", { exact: true })).toBeVisible();
  await expect(page.getByText("发现新的录音 2 条", { exact: true })).toBeVisible();
  const latestRow = page.getByRole("listitem").filter({ hasText: "latest.mp3" });
  await expect(latestRow).toContainText("最新录音");
  await expect(latestRow).toContainText("录音日期：2026-08-18");
  expect(await pickerCallCount(page)).toBe(1);
  await page.screenshot({ path: resolve(artifactDir, "01-toy-directory-connected.png"), fullPage: true });
  progress(3, 12, "one user gesture selected the root and manifest time chose the newest recording");

  await page.reload();
  await expect(page.getByText("已连接玩偶", { exact: true })).toBeVisible();
  await expect(page.getByText("发现 2 条录音", { exact: true })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "latest.mp3" }))
    .toContainText("最新录音");
  expect(await pickerCallCount(page)).toBe(1);
  progress(4, 12, "reload restored the IndexedDB handle and granted read permission without reopening the picker");

  const restoredLatestRow = page.getByRole("listitem").filter({ hasText: "latest.mp3" });
  await restoredLatestRow.getByRole("button", { name: "修改日期" }).click();
  await restoredLatestRow.getByLabel("latest.mp3 的录音日期").fill(confirmedRecordingDate);
  await restoredLatestRow.getByRole("button", { name: "确认日期" }).click();
  await expect(restoredLatestRow).toContainText(`录音日期：${confirmedRecordingDate}`);
  progress(5, 12, "the user replaced the suggested date before upload");

  const uploadResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/api/daily-reflections"
    && response.request().method() === "POST"
  ));
  await restoredLatestRow.getByRole("button", { name: "作为我的复盘上传" }).click();
  const uploadResponse = await uploadResponsePromise;
  expect(uploadResponse.status()).toBe(201);
  expect(uploadResponse.request().headers()["content-type"]).toContain("multipart/form-data");
  expect(postRequests, "one Toy Sync confirmation must produce one upload request").toHaveLength(1);
  const receipt = await uploadResponse.json() as DailyReflectionReceipt;
  expect(receipt).toMatchObject({ executionMode: "inline" });
  expect(receipt.reflectionId).toBeTruthy();
  expect(receipt.uploadId).toBeTruthy();
  progress(6, 12, "the existing Daily Reflection multipart endpoint accepted exactly one upload");

  await expect(page.getByRole("heading", { name: "整理好了，待你确认" }))
    .toBeVisible({ timeout: 180_000 });
  await expect(page).toHaveURL(new RegExp(
    `reflectionId=${encodeURIComponent(receipt.reflectionId)}`,
    "u"
  ));
  const detailResponse = await page.request.get(`/api/daily-reflections/${receipt.reflectionId}`);
  expect(detailResponse.status()).toBe(200);
  const detail = await detailResponse.json() as DailyReflectionDetail;
  expect(detail.reflection).toMatchObject({
    id: receipt.reflectionId,
    accountId,
    uploadId: receipt.uploadId,
    inputMethod: "file_upload",
    sourceOrigin: "user_reflection",
    status: "review_pending"
  });
  expect(detail.processingPlan).toMatchObject({
    reflectionId: receipt.reflectionId,
    uploadId: receipt.uploadId,
    inputMethod: "file_upload",
    sourceOrigin: "user_reflection",
    ingestionContext: "daily_reflection",
    reviewPolicy: "required"
  });
  expect(detail.upload).toMatchObject({
    id: receipt.uploadId,
    originalName: "latest.mp3",
    recordingDate: confirmedRecordingDate
  });
  expect(detail.candidates.length).toBeGreaterThan(0);
  expect(detail.candidates.every((candidate) => candidate.status === "pending")).toBe(true);
  await page.screenshot({ path: resolve(artifactDir, "02-toy-review-pending.png"), fullPage: true });
  progress(7, 12, "ASR and candidate staging reached review_pending with server-owned source metadata");

  assertStagingOnlyPersistence({ dataRoot, accountId, receipt });
  const uploadFiles = await listFiles(resolve(dataRoot, "users", accountId, "uploads"));
  expect(uploadFiles.filter((filePath) => filePath.endsWith(".json")).map((filePath) => basename(filePath)))
    .toEqual([`${receipt.uploadId}.json`]);
  expect(
    uploadFiles.filter((filePath) => !filePath.endsWith(".json")),
    "review_pending must not retain the original Toy audio"
  ).toEqual([]);
  progress(8, 12, "Upload=1 Reflection=1 and Memory Admission=0 were verified in isolated persistence");

  const visibleCopy = await page.locator("main").innerText();
  for (const forbidden of ["DirectoryHandle", "FileSystemAccess", "lastModified"]) {
    expect(visibleCopy).not.toContain(forbidden);
  }
  progress(9, 12, "the user-visible flow contains no filesystem implementation terms");

  await page.getByRole("button", { name: "返回日常复盘首页" }).click();
  await expect(page.getByText("已连接玩偶", { exact: true })).toBeVisible();
  const uploadedRow = page.getByRole("listitem").filter({ hasText: "latest.mp3" });
  await expect(uploadedRow).toContainText("已上传");
  expect(await pickerCallCount(page)).toBe(1);
  expect(postRequests).toHaveLength(1);
  progress(10, 12, "uploaded state survived remount and duplicate scanning did not submit again");

  expect(network.externalHttp).toEqual([]);
  expect(network.externalWebSockets).toEqual([]);
  progress(11, 12, "browser external HTTP and WebSocket request counts are zero");

  await context.close();
  progress(12, 12, `Toy Sync fixture complete artifacts=${artifactDir}`);
});
