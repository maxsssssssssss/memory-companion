import { expect, request as playwrightRequest, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import Database from "better-sqlite3";
import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

type DailyReflectionReceipt = {
  reflectionId: string;
  uploadId: string;
  jobId: string;
  status: string;
  executionMode: string;
};

const password = "ReflectionE2e!2026";

function progress(completed: number, total: number, message: string) {
  console.log(`[daily-reflection-fixture] ${completed}/${total} ${message}`);
}

function isLoopbackUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return true;
  return url.hostname === "localhost" || url.hostname === "::1" || url.hostname.startsWith("127.");
}

async function installNetworkGuard(context: BrowserContext, externalRequests: string[]) {
  await context.route("**/*", async (route: Route) => {
    if (!isLoopbackUrl(route.request().url())) {
      externalRequests.push(route.request().url());
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

async function registerFixtureUser(baseURL: string, email: string) {
  const api = await playwrightRequest.newContext({ baseURL });
  try {
    const response = await api.post("/api/auth/register", {
      data: {
        email,
        password,
        name: "Reflection Fixture User",
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
  await expect(page.getByRole("heading", { name: "把重要的人和片段，轻轻放在这里。" })).toBeVisible();
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/date-companion\/modules$/u);
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

async function expectMissing(path: string) {
  await expect(access(path).then(() => false).catch(() => true)).resolves.toBe(true);
}

async function rejectNonUploadOrigins(page: Page, fixturePath: string) {
  const fixture = await readFile(fixturePath);
  for (const sourceOrigin of ["manual_note", "ai_derived_observation"] as const) {
    const response = await page.request.post("/api/daily-reflections", {
      multipart: {
        file: {
          name: `forbidden-${sourceOrigin}.mp3`,
          mimeType: "audio/mpeg",
          buffer: fixture
        },
        sourceOrigin,
        recordingDate: "2026-08-13",
        idempotencyKey: `forbidden-${sourceOrigin}-${Date.now()}`
      }
    });
    expect(response.status()).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_source_origin" });
  }
}

function assertNoLongTermProjection(dataRoot: string) {
  const memoryPath = resolve(dataRoot, "memory.sqlite");
  const database = new Database(memoryPath, { readonly: true, fileMustExist: true });
  try {
    for (const table of [
      "memory_items",
      "memory_evidence",
      "person_entities",
      "person_evidence",
      "person_subject_observations",
      "person_relationships"
    ]) {
      const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      expect(row.count, `${table} must remain empty before confirmation`).toBe(0);
    }
  } finally {
    database.close();
  }
}

test("stages a daily reflection for review without external providers or long-term writes", async ({ browser, baseURL }) => {
  test.setTimeout(300_000);
  if (!baseURL) throw new Error("DAILY_REFLECTION_E2E_BASE_URL is required");
  const fixturePath = process.env.DAILY_REFLECTION_E2E_FIXTURE_PATH;
  const artifactDir = process.env.DAILY_REFLECTION_E2E_ARTIFACT_DIR;
  const dataRoot = process.env.DAILY_REFLECTION_E2E_DATA_DIR;
  if (!fixturePath || !artifactDir || !dataRoot) {
    throw new Error("Daily Reflection fixture path, artifact directory, and data directory are required");
  }
  await mkdir(artifactDir, { recursive: true });

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const firstEmail = `reflection-${suffix}@example.com`;
  const secondEmail = `reflection-other-${suffix}@example.com`;
  const firstUserId = await registerFixtureUser(baseURL, firstEmail);
  progress(1, 18, "first account registered through the real auth API");

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    serviceWorkers: "block"
  });
  const externalRequests: string[] = [];
  await installNetworkGuard(context, externalRequests);
  const page = await context.newPage();
  page.on("websocket", (socket) => {
    if (!isLoopbackUrl(socket.url())) externalRequests.push(socket.url());
  });

  await login(page, firstEmail);
  await expect(page.getByRole("link", { name: /日常复盘/u })).toBeVisible();
  await page.screenshot({ path: resolve(artifactDir, "01-modules-entry-1920x1080.png"), fullPage: true });
  progress(2, 18, "real login reached the feature-flagged module entry");

  await page.getByRole("link", { name: /日常复盘/u }).click();
  await expect(page).toHaveURL(/\/date-companion\/reflection$/u);
  await expect(page.getByRole("heading", { name: "把一天里值得回看的话，慢慢整理出来。" })).toBeVisible();
  const sourceChoices = page.getByRole("radio");
  await expect(sourceChoices).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) await expect(sourceChoices.nth(index)).not.toBeChecked();
  await expect(page.getByRole("button", { name: "开始上传" })).toBeDisabled();
  await page.screenshot({ path: resolve(artifactDir, "02-upload-no-source-default.png"), fullPage: true });
  progress(3, 18, "the source is fail-closed and has no default selection");

  await rejectNonUploadOrigins(page, fixturePath);
  progress(4, 18, "file upload rejected manual-note and AI-derived origins");

  await page.getByRole("radio", { name: "我自己的复盘" }).check();
  await page.getByLabel(/选择一段已有录音/u).setInputFiles(fixturePath);
  await expect(page.getByText(basename(fixturePath))).toBeVisible();
  await page.getByLabel("录音发生在").fill("2026-08-13");

  const uploadResponsePromise = page.waitForResponse((response) => (
    response.url().endsWith("/api/daily-reflections")
    && response.request().method() === "POST"
    && response.status() < 300
  ));
  await page.getByRole("button", { name: "开始上传" }).click();
  await expect(page.getByLabel("正在上传，暂无百分比")).toBeVisible();
  const uploadResponse = await uploadResponsePromise;
  expect(uploadResponse.status()).toBe(201);
  const receipt = await uploadResponse.json() as DailyReflectionReceipt;
  expect(receipt).toMatchObject({ executionMode: "inline" });
  expect(receipt.reflectionId).toBeTruthy();
  expect(receipt.uploadId).toBeTruthy();
  progress(5, 18, "real multipart upload entered the inline staging processor");

  await expect(page.getByRole("heading", { name: "整理好了，待你确认" }))
    .toBeVisible({ timeout: 180_000 });
  await expect(page).toHaveURL(new RegExp(`reflectionId=${encodeURIComponent(receipt.reflectionId)}`, "u"));
  await expect(page.getByText("我自己的复盘").last()).toBeVisible();
  const candidateItems = page.locator(
    'section[aria-labelledby="daily-reflection-candidates-title"] ol > li'
  );
  await expect(candidateItems).toHaveCount(3);
  await expect(page.getByText("4 条", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看全部" }).click();
  expect(await candidateItems.count()).toBeGreaterThanOrEqual(4);
  const transcript = page.getByRole("region", { name: "完整文字稿" });
  expect(await transcript.getByRole("listitem").count()).toBeGreaterThanOrEqual(4);
  const visibleReviewCopy = await page.locator("main").innerText();
  for (const forbidden of [
    "Memory",
    "Provider",
    "Pipeline",
    "Retrieval",
    "Citation",
    "sourceSegmentId",
    "已记住"
  ]) {
    expect(visibleReviewCopy).not.toContain(forbidden);
  }
  await page.screenshot({ path: resolve(artifactDir, "03-review-pending.png"), fullPage: true });
  progress(6, 18, "fixture ASR produced a full transcript and at least four uncapped candidates");

  const uploadFilesAtReview = await listFiles(resolve(dataRoot, "users", firstUserId, "uploads"));
  expect(
    uploadFilesAtReview.filter((filePath) => !filePath.endsWith(".json")),
    "review_pending must not retain the raw uploaded audio"
  ).toEqual([]);
  progress(7, 18, "raw audio was removed after canonical transcript staging");

  await page.getByRole("button", { name: "查看原话" }).first().click();
  const highlighted = page.locator('[data-highlighted="true"]');
  await expect(highlighted).toHaveCount(1);
  await expect(highlighted).toBeFocused();
  const highlightedId = await highlighted.getAttribute("data-segment-id");
  expect(highlightedId).toBeTruthy();
  await page.screenshot({ path: resolve(artifactDir, "04-source-jump.png"), fullPage: true });
  progress(8, 18, "candidate source jump focused a canonical transcript segment");

  const dayResponse = await page.request.get(`/api/days/${receipt.uploadId}`);
  expect(dayResponse.status()).toBe(404);
  const currentQaResponse = await page.request.get(`/api/days/${receipt.uploadId}/qa`);
  expect(currentQaResponse.status()).toBe(404);
  const peopleResponse = await page.request.get("/api/people");
  expect(peopleResponse.status()).toBe(200);
  await expect(peopleResponse.json()).resolves.toEqual({ people: [] });
  const memoryQaHistory = await page.request.get("/api/memory/all/qa");
  expect(memoryQaHistory.status()).toBe(200);
  await expect(memoryQaHistory.json()).resolves.toEqual({ answers: [] });
  assertNoLongTermProjection(dataRoot);
  progress(9, 18, "pending transcript and candidates stayed outside Day QA, Memory, and Person projections");

  await page.reload();
  await expect(page.getByRole("heading", { name: "整理好了，待你确认" })).toBeVisible();
  await expect(page.getByRole("region", { name: "完整文字稿" })).toBeVisible();
  await page.getByRole("button", { name: "返回日常复盘首页" }).click();
  await expect(page.getByRole("heading", { name: "最近复盘" })).toBeVisible();
  const recentRecord = page.getByRole("button", { name: /2026-08-13.*待你确认/u });
  await expect(recentRecord).toContainText("你在 2026-08-13 的复盘中提到……");
  await recentRecord.click();
  await expect(page.getByRole("heading", { name: "整理好了，待你确认" })).toBeVisible();
  progress(10, 18, "reload and recent history restored the server-side review state");

  const secondUserId = await registerFixtureUser(baseURL, secondEmail);
  const secondContext = await browser.newContext({ serviceWorkers: "block" });
  const secondExternalRequests: string[] = [];
  await installNetworkGuard(secondContext, secondExternalRequests);
  const secondPage = await secondContext.newPage();
  await login(secondPage, secondEmail);
  const crossUserResponse = await secondPage.request.get(`/api/daily-reflections/${receipt.reflectionId}`);
  expect(crossUserResponse.status()).toBe(404);
  await secondPage.goto(`/date-companion/reflection?reflectionId=${encodeURIComponent(receipt.reflectionId)}`);
  await expect(secondPage.locator("p[role='alert']")).toHaveText("这条复盘不存在或已被删除。");
  expect(secondUserId).not.toBe(firstUserId);
  expect(secondExternalRequests).toEqual([]);
  await secondContext.close();
  progress(11, 18, "a second authenticated account received a uniform 404");

  const deleteResponsePromise = page.waitForResponse((response) => (
    response.url().endsWith(`/api/daily-reflections/${receipt.reflectionId}`)
    && response.request().method() === "DELETE"
  ));
  await page.getByRole("button", { name: "删除本次复盘" }).click();
  await expect(page.getByRole("alertdialog", { name: "确定删除这次复盘吗？" })).toBeVisible();
  await page.getByRole("button", { name: "确认删除" }).click();
  expect((await deleteResponsePromise).status()).toBe(204);
  await expect(page).toHaveURL(/\/date-companion\/reflection$/u);
  await expect(page.getByRole("heading", { name: "上传已有录音" })).toBeVisible();
  await expect(page.getByText("还没有复盘记录。你可以从上面的任一入口开始。")).toBeVisible();
  expect((await page.request.get(`/api/daily-reflections/${receipt.reflectionId}`)).status()).toBe(404);
  await expectMissing(resolve(dataRoot, "users", firstUserId, "uploads", `${receipt.uploadId}.mp3`));
  await expectMissing(resolve(dataRoot, "users", firstUserId, "uploads", `${receipt.uploadId}.wav`));
  await expectMissing(resolve(dataRoot, "users", firstUserId, "uploads", `${receipt.uploadId}.m4a`));
  await expectMissing(resolve(dataRoot, "users", firstUserId, "uploads", `${receipt.uploadId}.webm`));
  await expectMissing(resolve(dataRoot, "users", firstUserId, "uploads", `${receipt.uploadId}.mp4`));
  await expectMissing(resolve(dataRoot, "users", firstUserId, "uploads", `${receipt.uploadId}-chunks`));
  await expectMissing(resolve(dataRoot, "users", firstUserId, "segments", `${receipt.uploadId}.json`));
  await expectMissing(resolve(dataRoot, "users", firstUserId, "uploads", `${receipt.uploadId}.json`));
  await expectMissing(resolve(dataRoot, "users", firstUserId, "daily-reflection-jobs", `${receipt.reflectionId}.json`));
  expect(await listFiles(resolve(dataRoot, "users", firstUserId, "uploads"))).toEqual([]);
  progress(12, 18, "delete made the detail inaccessible and removed staging assets");

  expect(externalRequests).toEqual([]);
  progress(13, 18, "browser external request count is zero");
  progress(14, 18, "auth, upload, polling, and delete APIs were not mocked");
  progress(15, 18, "fixture transcription was local and deterministic");
  progress(16, 18, "no Redis or queue worker was used");
  progress(17, 18, "no real Provider or remote network was used");
  progress(18, 18, `Daily Reflection fixture loop complete artifacts=${artifactDir}`);

  await context.close();
});
