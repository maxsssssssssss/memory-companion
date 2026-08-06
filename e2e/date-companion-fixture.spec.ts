import { expect, request as playwrightRequest, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";

type QaRequestBody = {
  uploadId: string;
  scope: string;
  promptPresetId: string;
  question: string;
  segments: Array<{
    id: string;
    startSeconds: number;
    endSeconds: number;
    text: string;
  }>;
  [key: string]: unknown;
};

const password = "DateE2e!2026";

function progress(completed: number, total: number, message: string) {
  console.log(`[date-companion-fixture] ${completed}/${total} ${message}`);
}

function isLoopbackUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ws:" && url.protocol !== "wss:") {
    return true;
  }
  return url.hostname === "localhost" || url.hostname === "::1" || url.hostname.startsWith("127.");
}

async function registerFixtureUser(baseURL: string, email: string) {
  const api = await playwrightRequest.newContext({ baseURL });
  try {
    const response = await api.post("/api/auth/register", {
      data: {
        email,
        password,
        name: "Fixture User",
        inviteCode: "date-e2e"
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

async function enterCompanion(page: Page) {
  await page.getByRole("link", { name: /约会陪伴/u }).click();
  await expect(page).toHaveURL(/\/date-companion\/a$/u);
  const setupHeading = page.getByRole("heading", { name: "你想怎样称呼 Ta？" });
  const homeHeading = page.getByRole("heading", { name: "今天，有什么值得留在心里？" });
  await expect(setupHeading.or(homeHeading)).toBeVisible();
  if (await setupHeading.isVisible()) {
    await page.getByRole("button", { name: "开始记录这段关系" }).click();
  }
  await expect(homeHeading).toBeVisible();
}

function deterministicQaResponse(body: QaRequestBody) {
  const segment = body.segments[0];
  if (!segment) throw new Error("QA fixture requires at least one real transcript segment");
  const answerId = `answer_fixture_${Date.now()}`;
  const frames = [
    {
      type: "meta",
      version: 1,
      streamId: "11111111-1111-4111-8111-111111111111"
    },
    {
      type: "sentence",
      sequence: 1,
      text: "这次相处里记录了一条可以回到文字稿核对的内容。",
      supportIds: [segment.id],
      citedSegmentIds: [segment.id],
      groundingValidated: true
    },
    {
      type: "final",
      answer: {
        id: answerId,
        uploadId: body.uploadId,
        question: body.question,
        answer: "这次相处里记录了一条可以回到文字稿核对的内容。",
        citedSegmentIds: [segment.id],
        citations: [
          {
            id: "E1",
            title: "当前相处的文字片段",
            startSeconds: segment.startSeconds,
            endSeconds: segment.endSeconds,
            excerpt: segment.text,
            sourceSegmentIds: [segment.id]
          }
        ],
        createdAt: new Date().toISOString()
      },
      source: "provider_stream"
    },
    {
      type: "complete",
      status: "completed"
    }
  ];
  return `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`;
}

async function installTransportGuards(input: {
  context: BrowserContext;
  page: Page;
  externalRequests: string[];
  onQaRequest: (body: QaRequestBody) => void;
  onDelete: (input: { uploadId: string; cachePresent: boolean; cleanupMode: string | null }) => void;
}) {
  let delayedUpload = false;
  let delayedDayRead = false;

  await input.context.route("**/*", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!isLoopbackUrl(request.url())) {
      input.externalRequests.push(request.url());
      await route.abort("blockedbyclient");
      return;
    }

    if (url.pathname === "/api/days/context/qa" && request.method() === "POST") {
      const body = request.postDataJSON() as QaRequestBody;
      input.onQaRequest(body);
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson; charset=utf-8",
        body: deterministicQaResponse(body)
      });
      return;
    }

    if (url.pathname === "/api/uploads" && request.method() === "POST" && !delayedUpload) {
      delayedUpload = true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (url.pathname.startsWith("/api/days/") && request.method() === "GET" && !delayedDayRead) {
      delayedDayRead = true;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    if (url.pathname.startsWith("/api/uploads/") && request.method() === "DELETE") {
      const uploadId = url.pathname.split("/").at(-1) ?? "";
      const cachePresent = await input.page.evaluate((targetUploadId) => {
        const userId = window.localStorage.getItem("daily-brief:active-user-id");
        return Boolean(userId && window.localStorage.getItem(`daily-brief:${userId}:local-day:${targetUploadId}`));
      }, uploadId);
      input.onDelete({
        uploadId,
        cachePresent,
        cleanupMode: request.headers()["x-daily-brief-cleanup-mode"] ?? null
      });
    }

    await route.continue();
  });
}

test("real local fixture closes the current-interaction browser loop without external providers", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  if (!baseURL) throw new Error("DATE_COMPANION_E2E_BASE_URL is required");
  const fixturePath = process.env.DATE_COMPANION_E2E_FIXTURE_PATH;
  const artifactDir = process.env.DATE_COMPANION_E2E_ARTIFACT_DIR;
  if (!fixturePath || !artifactDir) throw new Error("Fixture path and artifact directory are required");
  await mkdir(artifactDir, { recursive: true });

  const runSuffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const firstEmail = `date-e2e-${runSuffix}@example.com`;
  const secondEmail = `date-e2e-other-${runSuffix}@example.com`;
  const firstUserId = await registerFixtureUser(baseURL, firstEmail);
  progress(1, 20, "fixture user registered through the real API");

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    serviceWorkers: "block"
  });
  const page = await context.newPage();
  const externalRequests: string[] = [];
  const qaRequests: QaRequestBody[] = [];
  const deletes: Array<{ uploadId: string; cachePresent: boolean; cleanupMode: string | null }> = [];
  page.on("websocket", (webSocket) => {
    if (!isLoopbackUrl(webSocket.url())) externalRequests.push(webSocket.url());
  });
  await installTransportGuards({
    context,
    page,
    externalRequests,
    onQaRequest: (body) => qaRequests.push(body),
    onDelete: (event) => deletes.push(event)
  });

  await login(page, firstEmail);
  progress(2, 20, "real login reached module selection");
  await enterCompanion(page);
  await expect(page.getByText("整理完成并找到真实来源后，这里才会出现值得回看的片段。")).toBeVisible();
  await page.screenshot({ path: `${artifactDir}/phase-a-empty-home-1920x1080.png`, fullPage: true });
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.screenshot({ path: `${artifactDir}/phase-a-empty-home-2560x1440.png`, fullPage: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  progress(3, 20, "authenticated empty home verified at two desktop sizes");

  await page.getByText("上传这次相处的录音", { exact: true }).click();
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(fixturePath);
  await expect(page.getByText(basename(fixturePath))).toBeVisible();
  await page.locator('input[type="date"]').fill("2026-08-03");

  const uploadResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/uploads") && response.request().method() === "POST"
  );
  const deleteResponsePromise = page.waitForResponse((response) =>
    response.url().includes("/api/uploads/") && response.request().method() === "DELETE"
  );
  await page.getByRole("button", { name: "开始上传" }).click();
  await expect(page.getByText("正在把这次相处交进来").first()).toBeVisible();
  progress(4, 20, "real multipart upload entered the uploading state");

  const uploadResponse = await uploadResponsePromise;
  expect(uploadResponse.status()).toBe(201);
  const uploadReceipt = await uploadResponse.json() as { uploadId: string; jobId: string; status: string };
  expect(uploadReceipt.uploadId).toBeTruthy();
  expect(uploadReceipt.jobId).toBeTruthy();
  await expect(page.getByText("录音已收到").first()).toBeVisible();
  progress(5, 20, "real inline Pipeline entered the processing state");

  await expect(page.getByRole("link", { name: /查看这次复盘/u }).first()).toBeVisible({ timeout: 120_000 });
  const deleteResponse = await deleteResponsePromise;
  expect(deleteResponse.status()).toBe(200);
  expect(deletes).toEqual([
    {
      uploadId: uploadReceipt.uploadId,
      cachePresent: true,
      cleanupMode: "browser-cache"
    }
  ]);
  progress(6, 20, "ready payload was cached before the real browser-cache DELETE");

  const cachedPayload = await page.evaluate(({ userId, uploadId }) => {
    const raw = window.localStorage.getItem(`daily-brief:${userId}:local-day:${uploadId}`);
    return raw ? JSON.parse(raw) as { segments: Array<{ id: string }> } : null;
  }, { userId: firstUserId, uploadId: uploadReceipt.uploadId });
  expect(cachedPayload?.segments.length).toBeGreaterThan(0);
  const segmentIds = cachedPayload!.segments.map((segment) => segment.id);
  await page.screenshot({ path: `${artifactDir}/phase-a-ready-home.png`, fullPage: true });
  progress(7, 20, "ready home and cached transcript verified");

  await page.getByRole("link", { name: /查看这次复盘/u }).first().click();
  await expect(page.getByRole("heading", { name: "这次相处，已经整理好了" })).toBeVisible();
  await page.locator("summary").filter({ hasText: /^未留下 \d+ 条$/u }).first().click();
  const sourceSummary = page.locator("summary").filter({ hasText: "个真实来源" }).first();
  const sourceDetails = sourceSummary.locator("xpath=..");
  await expect(sourceDetails).toBeVisible();
  await sourceSummary.click();
  await expect(sourceDetails.getByRole("button", { name: "在文字稿中查看" })).toBeVisible();
  await page.screenshot({ path: `${artifactDir}/phase-a-recap-source-expanded.png`, fullPage: true });
  progress(8, 20, "recap rendered a real evidence source");

  await sourceDetails.getByRole("button", { name: "在文字稿中查看" }).click();
  const recapSourceSegmentId = new URL(page.url()).searchParams.get("segment");
  expect(recapSourceSegmentId).toBeTruthy();
  expect(segmentIds).toContain(recapSourceSegmentId);
  await expect(page.locator(`[data-segment-id="${recapSourceSegmentId}"]`)).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("heading", { name: "完整文字稿" })).toBeVisible();
  await page.screenshot({ path: `${artifactDir}/phase-a-transcript-located.png`, fullPage: true });
  progress(9, 20, "source URL and transcript highlight used the real segment id");

  await page.getByRole("button", { name: "问问这次相处" }).click();
  await page.getByRole("textbox", { name: "针对这次相处提问" }).fill("这次相处记录了什么？");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("这次相处里记录了一条可以回到文字稿核对的内容。")).toBeVisible();
  expect(qaRequests).toHaveLength(1);
  expect(qaRequests[0]).toMatchObject({
    uploadId: uploadReceipt.uploadId,
    scope: "current",
    promptPresetId: "date"
  });
  expect(Object.keys(qaRequests[0]).filter((key) => /model|provider/iu.test(key))).toEqual([]);
  const requestedSegmentIds = new Set(qaRequests[0].segments.map((segment) => segment.id));
  expect(requestedSegmentIds.size).toBeGreaterThan(0);
  expect([...requestedSegmentIds].every((segmentId) => segmentIds.includes(segmentId))).toBe(true);
  const evidenceGroup = page.locator("[data-evidence-group]");
  await evidenceGroup.locator(":scope > summary").click();
  const firstEvidence = evidenceGroup.locator('[data-evidence-id="E1"]');
  await firstEvidence.locator(":scope > summary").click();
  await expect(firstEvidence.getByRole("link", { name: "在完整文字稿中查看" })).toHaveAttribute(
    "href",
    new RegExp(`segment=${encodeURIComponent(segmentIds[0])}`, "u")
  );
  await page.screenshot({ path: `${artifactDir}/phase-a-qa-answer-source.png`, fullPage: true });
  progress(10, 20, "current/date QA request and deterministic NDJSON citation passed");

  const serverDayAfterDelete = await page.request.get(`/api/days/${uploadReceipt.uploadId}`);
  expect(serverDayAfterDelete.status()).toBe(404);
  await page.reload();
  await expect(page.getByRole("heading", { name: "这次相处，已经整理好了" })).toBeVisible();
  progress(11, 20, "reload restored the cleaned upload from the same-user browser cache");

  await page.goto("/date-companion/modules");
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page).toHaveURL(/\/date-companion$/u);
  await login(page, firstEmail);
  await enterCompanion(page);
  await expect(page.getByRole("link", { name: /查看这次复盘/u }).first()).toBeVisible();
  progress(12, 20, "logout and real re-login restored the first user's local result");

  const secondUserId = await registerFixtureUser(baseURL, secondEmail);
  await page.goto("/date-companion/modules");
  await page.getByRole("button", { name: "退出" }).click();
  await login(page, secondEmail);
  await enterCompanion(page);
  await expect(page.getByText("整理完成并找到真实来源后，这里才会出现值得回看的片段。")).toBeVisible();
  const activeUserId = await page.evaluate(() => window.localStorage.getItem("daily-brief:active-user-id"));
  expect(activeUserId).toBe(secondUserId);
  expect(activeUserId).not.toBe(firstUserId);
  const secondUserIndex = await page.evaluate((userId) =>
    window.localStorage.getItem(`daily-brief:${userId}:local-day-index`), secondUserId
  );
  expect(secondUserIndex).toBeNull();
  progress(13, 20, "a second real user could not read the first user's local data");

  expect(externalRequests).toEqual([]);
  progress(14, 20, "browser external request count is zero");
  progress(15, 20, "auth APIs were never mocked");
  progress(16, 20, "upload API and inline Pipeline were never mocked");
  progress(17, 20, "Day polling API was never mocked");
  progress(18, 20, "browser-cache DELETE API was never mocked");
  progress(19, 20, "QA transport fixture was the only intercepted application API");
  progress(20, 20, `Phase A complete artifacts=${artifactDir}`);

  await context.close();
});
