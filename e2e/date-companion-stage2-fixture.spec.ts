import { expect, request as playwrightRequest, test, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";

type RelationshipView = {
  relationship: {
    id: string;
    displayName?: string;
  };
  interactions: Array<{
    id: string;
    sourceUploadId: string;
    sourceState: "available" | "server_cleaned" | "explicitly_deleted";
    status: "draft" | "confirmed";
    recapItems: Array<{
      id: string;
      kind: "moment" | "mentioned" | "promise" | "continue";
      displayedText: string;
      disposition: "pending" | "kept" | "excluded";
      evidence: Array<{ speakerId?: string; sourceSegmentId: string }>;
    }>;
  }>;
  promises: Array<{
    id: string;
    text: string;
    status: "open" | "done";
    version: number;
  }>;
};

type ImportResponse = {
  interactionId: string;
  reused: boolean;
  view: RelationshipView;
};

type RequestOrderEvent = {
  type: "cache_saved" | "import_requested" | "import_succeeded" | "cleanup_requested" | "cleanup_succeeded";
  uploadId: string;
  sequence: number;
};

type NetworkAudit = {
  externalRequests: string[];
  order: RequestOrderEvent[];
  cacheAtImport: Map<string, boolean>;
  cleanupHeaders: Map<string, string | null>;
};

const password = "DateE2e!2026";
const firstDate = "2026-08-02";
const secondDate = "2026-08-03";
const keptKeyword = "星河计划";
const excludedKeyword = "火星咖啡";

function progress(completed: number, total: number, message: string) {
  console.log(`[date-companion-stage2-fixture] ${completed}/${total} ${message}`);
}

function isLoopbackUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return true;
  return url.hostname === "localhost" || url.hostname === "::1" || url.hostname.startsWith("127.");
}

async function registerFixtureUser(baseURL: string, email: string, name: string) {
  const api = await playwrightRequest.newContext({ baseURL });
  try {
    const response = await api.post("/api/auth/register", {
      data: { email, password, name, inviteCode: "date-e2e" }
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
}

function applicationPath(rawUrl: string) {
  return new URL(rawUrl).pathname;
}

function postBody(request: { postDataJSON(): unknown }) {
  return request.postDataJSON() as Record<string, unknown>;
}

async function hasCachedDay(page: Page, uploadId: string) {
  return page.evaluate((targetUploadId) => {
    const userId = window.localStorage.getItem("daily-brief:active-user-id");
    return Boolean(userId && window.localStorage.getItem(`daily-brief:${userId}:local-day:${targetUploadId}`));
  }, uploadId);
}

async function installNetworkAudit(context: BrowserContext, audit: NetworkAudit) {
  let sequence = 0;

  context.on("response", (response) => {
    const request = response.request();
    const path = applicationPath(request.url());
    if (response.ok() && request.method() === "POST" && /\/api\/date-companion\/relationships\/[^/]+\/interactions\/import$/u.test(path)) {
      const uploadId = String(postBody(request).uploadId ?? "");
      audit.order.push({ type: "import_succeeded", uploadId, sequence: ++sequence });
    }
    if (response.ok() && request.method() === "DELETE" && path.startsWith("/api/uploads/")) {
      const uploadId = path.split("/").at(-1) ?? "";
      audit.order.push({ type: "cleanup_succeeded", uploadId, sequence: ++sequence });
    }
  });

  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    const path = applicationPath(request.url());
    if (!isLoopbackUrl(request.url())) {
      audit.externalRequests.push(request.url());
      await route.abort("blockedbyclient");
      return;
    }

    // This delays, but never mocks, the real upload so the browser must render the uploading state.
    if (path === "/api/uploads" && request.method() === "POST") {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (request.method() === "POST" && /\/api\/date-companion\/relationships\/[^/]+\/interactions\/import$/u.test(path)) {
      const uploadId = String(postBody(request).uploadId ?? "");
      const requestPage = request.frame().page();
      const cachePresent = await hasCachedDay(requestPage, uploadId);
      audit.cacheAtImport.set(uploadId, cachePresent);
      if (cachePresent) audit.order.push({ type: "cache_saved", uploadId, sequence: ++sequence });
      audit.order.push({ type: "import_requested", uploadId, sequence: ++sequence });
    }

    if (request.method() === "DELETE" && path.startsWith("/api/uploads/")) {
      const uploadId = path.split("/").at(-1) ?? "";
      audit.cleanupHeaders.set(uploadId, request.headers()["x-daily-brief-cleanup-mode"] ?? null);
      audit.order.push({ type: "cleanup_requested", uploadId, sequence: ++sequence });
    }

    await route.continue();
  });
}

async function createGuardedContext(browser: Browser, audit: NetworkAudit, viewport = { width: 1920, height: 1080 }) {
  const context = await browser.newContext({ viewport, serviceWorkers: "block" });
  context.on("page", (page) => {
    page.on("websocket", (webSocket) => {
      if (!isLoopbackUrl(webSocket.url())) audit.externalRequests.push(webSocket.url());
    });
  });
  await installNetworkAudit(context, audit);
  return context;
}

async function createRelationship(page: Page) {
  await expect(page.getByRole("heading", { name: "你想怎样称呼 Ta？" })).toBeVisible();
  const responsePromise = page.waitForResponse((response) =>
    applicationPath(response.url()) === "/api/date-companion/relationships"
    && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: /开始记录这段关系/u }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const payload = await response.json() as { relationship: { id: string; displayName?: string }; reused: boolean };
  expect(payload.reused).toBe(false);
  expect(payload.relationship.displayName).toBeUndefined();
  await expect(page.getByRole("heading", { name: "今天，有什么值得留在心里？" })).toBeVisible();
  return payload.relationship.id;
}

async function uploadFixture(input: {
  page: Page;
  fixturePath: string;
  recordingDate: string;
  expectedRelationshipId: string;
}) {
  const { page, fixturePath, recordingDate, expectedRelationshipId } = input;
  await page.goto("/date-companion/a");
  await expect(page.getByRole("heading", { name: "今天，有什么值得留在心里？" })).toBeVisible();
  const uploadSummary = page.locator("details").first().locator("summary");
  await expect(uploadSummary).toBeVisible();
  await uploadSummary.click({ timeout: 20_000 });
  await page.locator('input[type="file"]').setInputFiles(fixturePath);
  await expect(page.getByText(basename(fixturePath))).toBeVisible();
  await page.locator('input[type="date"]').fill(recordingDate);

  const uploadResponsePromise = page.waitForResponse((response) =>
    applicationPath(response.url()) === "/api/uploads" && response.request().method() === "POST"
  );
  const importResponsePromise = page.waitForResponse((response) =>
    /\/api\/date-companion\/relationships\/[^/]+\/interactions\/import$/u.test(applicationPath(response.url()))
    && response.request().method() === "POST"
  );
  const cleanupResponsePromise = page.waitForResponse((response) =>
    applicationPath(response.url()).startsWith("/api/uploads/") && response.request().method() === "DELETE"
  );

  await page.getByRole("button", { name: "开始上传" }).click();
  await expect(page.getByText("正在把这次相处交进来").first()).toBeVisible();

  const uploadResponse = await uploadResponsePromise;
  expect(uploadResponse.status()).toBe(201);
  const receipt = await uploadResponse.json() as { uploadId: string; jobId: string };
  expect(receipt.uploadId).toBeTruthy();
  expect(receipt.jobId).toBeTruthy();
  await expect(page.getByText(/录音已收到|正在整理录音|正在转成文字|正在提取值得回看的片段/u).first()).toBeVisible();

  const importResponse = await importResponsePromise;
  expect(importResponse.ok()).toBe(true);
  const imported = await importResponse.json() as ImportResponse;
  expect(imported.view.relationship.id).toBe(expectedRelationshipId);
  const importedInteraction = imported.view.interactions.find((interaction) => interaction.id === imported.interactionId);
  expect(importedInteraction?.sourceUploadId).toBe(receipt.uploadId);
  expect(importedInteraction?.sourceState).toBe("available");
  expect(importedInteraction?.status).toBe("draft");
  expect(importedInteraction?.recapItems.length).toBeGreaterThan(1);

  const cleanupResponse = await cleanupResponsePromise;
  expect(cleanupResponse.ok()).toBe(true);
  await expect(page.getByRole("link", { name: /查看这次复盘/u }).first()).toBeVisible();

  const serverDay = await page.request.get(`/api/days/${receipt.uploadId}`);
  expect(serverDay.status()).toBe(404);
  const relationshipResponse = await page.request.get(`/api/date-companion/relationships/${expectedRelationshipId}/view`);
  expect(relationshipResponse.ok()).toBe(true);
  const relationshipPayload = await relationshipResponse.json() as { view: RelationshipView };
  const cleanedInteraction = relationshipPayload.view.interactions.find((interaction) => interaction.id === imported.interactionId);
  expect(cleanedInteraction?.sourceState).toBe("server_cleaned");
  return { receipt, imported, view: relationshipPayload.view };
}

async function setSpeakerRoles(page: Page) {
  await expect(page.getByRole("heading", { name: "这次录音里的说话人" })).toBeVisible();
  const firstSpeaker = page.locator("article").filter({ hasText: "原始编号 speaker_1" }).first();
  const secondSpeaker = page.locator("article").filter({ hasText: "原始编号 speaker_2" }).first();
  await expect(firstSpeaker).toBeVisible();
  await expect(secondSpeaker).toBeVisible();
  await firstSpeaker.getByRole("button", { name: "我", exact: true }).click();
  await secondSpeaker.getByRole("button", { name: "Ta", exact: true }).click();
  const responsePromise = page.waitForResponse((response) =>
    /\/api\/date-companion\/interactions\/[^/]+\/participants$/u.test(applicationPath(response.url()))
    && response.request().method() === "PUT"
  );
  await page.getByRole("button", { name: "保存说话人判断" }).click();
  expect((await responsePromise).ok()).toBe(true);
  await expect(firstSpeaker.getByRole("button", { name: "我", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(secondSpeaker.getByRole("button", { name: "Ta", exact: true })).toHaveAttribute("aria-pressed", "true");
}

async function decideAndFinalizeRecap(input: {
  page: Page;
  keptText: string;
  excludedText?: string;
  screenshotPath?: string;
}) {
  const { page, keptText, excludedText, screenshotPath } = input;
  const recapGrid = page.getByRole("region", { name: "这次相处复盘" });
  const promiseCard = recapGrid.locator("article").filter({ has: page.getByRole("heading", { name: "这次出现的约定" }) });
  const keptEditor = promiseCard.locator('[data-disposition]').first();
  await expect(keptEditor).toBeVisible();
  await keptEditor.getByRole("textbox").fill(keptText);
  await keptEditor.getByRole("button", { name: "留下", exact: true }).click();

  const editors = recapGrid.locator('[data-disposition]');
  expect(await editors.count()).toBeGreaterThan(1);
  let excludedEditorIndex = -1;
  for (let index = 0; index < await editors.count(); index += 1) {
    const editor = editors.nth(index);
    const text = await editor.getByRole("textbox").inputValue();
    if (text === keptText) continue;
    if (excludedText && excludedEditorIndex < 0) {
      await editor.getByRole("textbox").fill(excludedText);
      excludedEditorIndex = index;
    }
    const exclude = editor.getByRole("button", { name: "不留下", exact: true });
    if (await exclude.count()) await exclude.click();
  }
  if (excludedText) expect(excludedEditorIndex).toBeGreaterThanOrEqual(0);

  const saveResponsePromise = page.waitForResponse((response) =>
    /\/api\/date-companion\/interactions\/[^/]+\/recap$/u.test(applicationPath(response.url()))
    && response.request().method() === "PUT"
    && postBody(response.request()).finalize === false
  );
  await page.getByRole("button", { name: "保存本次修改" }).click();
  expect((await saveResponsePromise).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "最终确认" })).toBeEnabled();

  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });

  const finalizeResponsePromise = page.waitForResponse((response) =>
    /\/api\/date-companion\/interactions\/[^/]+\/recap$/u.test(applicationPath(response.url()))
    && response.request().method() === "PUT"
    && postBody(response.request()).finalize === true
  );
  await page.getByRole("button", { name: "最终确认" }).click();
  const finalizeResponse = await finalizeResponsePromise;
  expect(finalizeResponse.ok()).toBe(true);
  await expect(page.getByRole("button", { name: "已经确认留下" })).toBeDisabled();
  const finalized = await finalizeResponse.json() as { view: RelationshipView };
  return finalized.view;
}

function assertOrderedLifecycle(audit: NetworkAudit, uploadId: string) {
  const lifecycle = audit.order.filter((event) => event.uploadId === uploadId).map((event) => event.type);
  expect(audit.cacheAtImport.get(uploadId)).toBe(true);
  expect(audit.cleanupHeaders.get(uploadId)).toBe("browser-cache");
  expect(lifecycle).toEqual([
    "cache_saved",
    "import_requested",
    "import_succeeded",
    "cleanup_requested",
    "cleanup_succeeded"
  ]);
}

test("Stage 2 keeps one confirmed relationship across two fixture interactions and browser sessions", async ({ browser, baseURL }) => {
  test.setTimeout(480_000);
  if (!baseURL) throw new Error("DATE_COMPANION_E2E_BASE_URL is required");
  const fixturePath = process.env.DATE_COMPANION_E2E_FIXTURE_PATH;
  const artifactDir = process.env.DATE_COMPANION_E2E_ARTIFACT_DIR;
  if (!fixturePath || !artifactDir) throw new Error("Fixture path and artifact directory are required");
  await mkdir(artifactDir, { recursive: true });

  const runSuffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const firstEmail = `date-stage2-${runSuffix}@example.com`;
  const secondEmail = `date-stage2-other-${runSuffix}@example.com`;
  await registerFixtureUser(baseURL, firstEmail, "Stage 2 Fixture User");
  progress(1, 30, "first fixture user registered through the real auth API");

  const primaryAudit: NetworkAudit = {
    externalRequests: [],
    order: [],
    cacheAtImport: new Map(),
    cleanupHeaders: new Map()
  };
  const context = await createGuardedContext(browser, primaryAudit);
  const page = await context.newPage();
  await login(page, firstEmail);
  await enterCompanion(page);
  progress(2, 30, "real login reached the explicit relationship setup");

  const relationshipId = await createRelationship(page);
  progress(3, 30, "the user explicitly created one unnamed relationship displayed as Ta");

  const firstUpload = await uploadFixture({ page, fixturePath, recordingDate: firstDate, expectedRelationshipId: relationshipId });
  assertOrderedLifecycle(primaryAudit, firstUpload.receipt.uploadId);
  progress(4, 30, "first real upload completed cache -> import -> cleanup in strict order");
  progress(5, 30, "first server Day was cleaned while its relationship snapshot became server_cleaned");

  await page.getByRole("link", { name: /查看这次复盘/u }).first().click();
  await setSpeakerRoles(page);
  progress(6, 30, "speaker_1 was explicitly confirmed as me and speaker_2 as Ta");

  const firstFinalView = await decideAndFinalizeRecap({
    page,
    keptText: `${keptKeyword}：明天下午前把确认过的方案发给 Ta`,
    excludedText: `${excludedKeyword}：这条内容由用户明确排除`,
    screenshotPath: `${artifactDir}/stage2-recap-edit-confirm.png`
  });
  const firstInteraction = firstFinalView.interactions.find((item) => item.id === firstUpload.imported.interactionId);
  expect(firstInteraction?.status).toBe("confirmed");
  expect(firstInteraction?.recapItems.filter((item) => item.disposition === "kept")).toHaveLength(1);
  expect(firstInteraction?.recapItems.find((item) => item.disposition === "kept")?.displayedText).toContain(keptKeyword);
  expect(firstInteraction?.recapItems.find((item) => item.disposition === "excluded")?.displayedText).toContain(excludedKeyword);
  expect(firstFinalView.promises).toHaveLength(1);
  progress(7, 30, "the kept keyword was edited, all other items were decided, and one promise was created exactly once");

  await page.getByRole("link", { name: "关于 Ta" }).click();
  await expect(page.getByText(keptKeyword, { exact: false }).first()).toBeVisible();
  await expect(page.getByText(excludedKeyword, { exact: false })).toHaveCount(0);
  await expect(page.getByText("待完成")).toBeVisible();
  await page.screenshot({ path: `${artifactDir}/stage2-person-1920x1080.png`, fullPage: true });
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.screenshot({ path: `${artifactDir}/stage2-person-2560x1440.png`, fullPage: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  progress(8, 30, "person view showed only confirmed kept content at 1920 and 2560 widths");

  await page.getByRole("link", { name: "见面前" }).click();
  await expect(page).toHaveURL(/\/date-companion\/a\/prepare$/u);
  await expect(page.getByRole("heading", { name: "见 Ta 之前，花半分钟想一想", exact: true })).toBeVisible();
  await page.locator("summary").filter({ hasText: "你答应过" }).click();
  await expect(page.getByText(keptKeyword, { exact: false })).toBeVisible();
  await expect(page.getByText(excludedKeyword, { exact: false })).toHaveCount(0);
  await page.screenshot({ path: `${artifactDir}/stage2-prepare.png`, fullPage: true });
  progress(9, 30, "prepare view used the open kept promise and excluded the rejected item");

  await page.getByRole("link", { name: "关于 Ta" }).click();
  const promiseResponsePromise = page.waitForResponse((response) =>
    /\/api\/date-companion\/promises\/[^/]+$/u.test(applicationPath(response.url()))
    && response.request().method() === "PATCH"
  );
  await page.getByRole("button", { name: "标为已完成" }).click();
  expect((await promiseResponsePromise).ok()).toBe(true);
  await expect(page.getByText("已完成")).toBeVisible();
  progress(10, 30, "the promise changed from open to done through the real API");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Ta", exact: true })).toBeVisible();
  await expect(page.getByText("已完成")).toBeVisible();
  await expect(page.getByText(keptKeyword, { exact: false }).first()).toBeVisible();
  progress(11, 30, "reload restored the confirmed recap and completed promise");

  const secondUpload = await uploadFixture({ page, fixturePath, recordingDate: secondDate, expectedRelationshipId: relationshipId });
  assertOrderedLifecycle(primaryAudit, secondUpload.receipt.uploadId);
  progress(12, 30, "second date used the same relationship and strict persistence order");

  await page.getByRole("link", { name: /查看这次复盘/u }).first().click();
  await setSpeakerRoles(page);
  const secondFinalView = await decideAndFinalizeRecap({
    page,
    keptText: `${keptKeyword}：第二次相处继续跟进`,
    screenshotPath: undefined
  });
  expect(secondFinalView.interactions.filter((interaction) => interaction.status === "confirmed")).toHaveLength(2);
  progress(13, 30, "second interaction kept one sourced item and was finally confirmed");

  await page.getByRole("link", { name: "关于 Ta" }).click();
  const historySection = page.locator("section").filter({ has: page.getByRole("heading", { name: "一起走过的几次" }) });
  await expect(historySection.locator("ol > li")).toHaveCount(2);
  await expect(historySection.getByText("8 月 2 日")).toBeVisible();
  await expect(historySection.getByText("8 月 3 日")).toBeVisible();
  await page.screenshot({ path: `${artifactDir}/stage2-two-interactions.png`, fullPage: true });
  progress(14, 30, "relationship history aggregated two confirmed interactions");

  const searchInput = page.getByRole("searchbox", { name: "关系内关键词" });
  await searchInput.fill(keptKeyword);
  const keptSearchPromise = page.waitForResponse((response) =>
    /\/api\/date-companion\/relationships\/[^/]+\/search$/u.test(applicationPath(response.url()))
    && new URL(response.url()).searchParams.get("q") === keptKeyword
  );
  await page.getByRole("button", { name: "找一找" }).click();
  expect((await keptSearchPromise).ok()).toBe(true);
  await expect(page.locator("ul").filter({ hasText: keptKeyword }).first()).toBeVisible();
  await page.screenshot({ path: `${artifactDir}/stage2-search-results.png`, fullPage: true });
  progress(15, 30, "relationship search found the kept unique keyword");

  await searchInput.fill(excludedKeyword);
  const excludedSearchPromise = page.waitForResponse((response) =>
    /\/api\/date-companion\/relationships\/[^/]+\/search$/u.test(applicationPath(response.url()))
    && new URL(response.url()).searchParams.get("q") === excludedKeyword
  );
  await page.getByRole("button", { name: "找一找" }).click();
  expect((await excludedSearchPromise).ok()).toBe(true);
  await expect(page.getByText("没有找到已确认内容")).toBeVisible();
  await expect(page.getByText(excludedKeyword, { exact: false })).toHaveCount(0);
  progress(16, 30, "relationship search did not return the excluded unique keyword");

  const restoredAudit: NetworkAudit = {
    externalRequests: [],
    order: [],
    cacheAtImport: new Map(),
    cleanupHeaders: new Map()
  };
  const restoredContext = await createGuardedContext(browser, restoredAudit);
  const restoredPage = await restoredContext.newPage();
  await login(restoredPage, firstEmail);
  await restoredPage.goto("/date-companion/a/person");
  await expect(restoredPage.getByRole("heading", { name: "Ta", exact: true })).toBeVisible();
  await expect(restoredPage.getByText(keptKeyword, { exact: false }).first()).toBeVisible();
  await expect(restoredPage.getByText(excludedKeyword, { exact: false })).toHaveCount(0);
  await expect(restoredPage.locator("ol").locator("li")).toHaveCount(2);
  await expect(restoredPage.getByText("可核对原话已保留").first()).toBeVisible();
  await expect(restoredPage.getByRole("button", { name: "查看完整复盘" })).toHaveCount(0);
  progress(17, 30, "a new browser context restored confirmed server content and evidence snapshots");
  progress(18, 30, "the new context did not render broken complete-transcript actions");

  await registerFixtureUser(baseURL, secondEmail, "Other Fixture User");
  const isolatedAudit: NetworkAudit = {
    externalRequests: [],
    order: [],
    cacheAtImport: new Map(),
    cleanupHeaders: new Map()
  };
  const isolatedContext = await createGuardedContext(browser, isolatedAudit);
  const isolatedPage = await isolatedContext.newPage();
  await login(isolatedPage, secondEmail);
  await isolatedPage.goto("/date-companion/a");
  await expect(isolatedPage.getByRole("heading", { name: "你想怎样称呼 Ta？" })).toBeVisible();
  const otherRelationships = await isolatedPage.request.get("/api/date-companion/relationships");
  expect(otherRelationships.ok()).toBe(true);
  expect(await otherRelationships.json()).toEqual({ relationships: [] });
  const crossUserView = await isolatedPage.request.get(`/api/date-companion/relationships/${relationshipId}/view`);
  expect(crossUserView.status()).toBe(404);
  progress(19, 30, "another user saw no relationship and cross-user IDs returned 404");

  expect(primaryAudit.externalRequests).toEqual([]);
  expect(restoredAudit.externalRequests).toEqual([]);
  expect(isolatedAudit.externalRequests).toEqual([]);
  progress(20, 30, "all three browser contexts made zero non-loopback requests");
  progress(21, 30, "auth, relationship creation, upload, Pipeline, polling and Day APIs were never mocked");
  progress(22, 30, "relationship import and browser-cache DELETE were never mocked");
  progress(23, 30, "participant, recap, promise and search APIs were never mocked");
  progress(24, 30, "both uploads retained fixed Evidence snapshots after server cleanup");
  progress(25, 30, "speaker aliases and provider labels were not used as identity proof");
  progress(26, 30, "unresolved and excluded content stayed outside long-term surfaces");
  progress(27, 30, "current-interaction QA was intentionally not exercised or intercepted in this Stage 2 flow");
  progress(28, 30, "fixture transcription used the fixed office sample and does not validate dating content quality");
  progress(29, 30, `screenshots saved under ${artifactDir}`);

  await isolatedContext.close();
  await restoredContext.close();
  await context.close();
  progress(30, 30, "Stage 2 fixture browser closure complete");
});
