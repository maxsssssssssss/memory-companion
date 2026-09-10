import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createDailyReflectionVisualFixture, resolveDailyReflectionVisualRequest } from "./daily-reflection-visual-fixture";
import type { DailyReflectionOperationUploadState } from "../../src/lib/domain/daily-reflection-api";

async function syntheticRecorder(context: BrowserContext, unavailableStorage = false) {
  await context.addInitScript(({ unavailable }) => {
    if (unavailable) Object.defineProperty(window, "indexedDB", { configurable: true, value: undefined });
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
          this.ondataavailable?.({ data: new Blob(["SYNTHETIC_RECOVERY_AUDIO"], { type: this.mimeType }) });
          this.onstop?.(new Event("stop"));
        });
      }
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: Recorder });
  }, { unavailable: unavailableStorage });
}

async function setup(page: Page, mode: "delayed" | "offline" | "lost" | "persistence" = "delayed") {
  const fixture = createDailyReflectionVisualFixture("populated");
  const target = JSON.parse(JSON.stringify(fixture)
    .replaceAll(fixture.ids.sessionReflectionId, "dr_recovery_uploaded")
    .replaceAll(fixture.ids.uploadId, "dr_recovery_upload")
    .replaceAll(fixture.ids.jobId, "dr_recovery_job")) as typeof fixture;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const posts: string[] = [];
  const unexpected: string[] = [];
  let received = false;
  let uploadState: DailyReflectionOperationUploadState | null = null;
  let lookupCount = 0;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:3210") { unexpected.push("external"); await route.abort(); return; }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    const json = async (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname.endsWith("/ai-review/summary")) {
      await json({ schemaVersion: 1, exposureMode: "off", pendingCount: 0, unseenReadyCount: 0, items: [] }); return;
    }
    if (url.pathname.includes("/operations/")) {
      lookupCount += 1;
      await json(received || uploadState ? { found: true, uploadState: uploadState ?? "accepted", reflectionId: target.ids.sessionReflectionId,
        uploadId: target.ids.uploadId, jobId: target.ids.jobId, contentHash: "a".repeat(64), status: uploadState ? "uploading" : "review_pending" }
        : { found: false }); return;
    }
    if (url.pathname === "/api/daily-reflections" && route.request().method() === "POST") {
      const body = route.request().postData() ?? "";
      posts.push(body);
      if (mode === "offline" && posts.length === 1) { await route.abort("internetdisconnected"); return; }
      if (mode === "lost") { received = true; await route.abort("connectionreset"); return; }
      if (mode === "delayed") await gate;
      received = true;
      uploadState = mode === "persistence" ? "still_persisting" : "accepted";
      const operationKey = body.match(/name="operationKey"\r\n\r\n([^\r]+)/u)?.[1];
      await json({ reflectionId: target.ids.sessionReflectionId, uploadId: target.ids.uploadId,
        jobId: target.ids.jobId, operationKey, contentHash: "a".repeat(64), capturePurpose: "inspiration_capture",
        status: "uploading", executionMode: "queue", ...(mode === "persistence" ? { persistencePending: true } : {}) });
      return;
    }
    if (received && url.pathname === "/api/daily-reflections") {
      await json({ reflections: [target.history.reflections[0], ...fixture.history.reflections] }); return;
    }
    if (url.pathname.startsWith(`/api/daily-reflections/${target.ids.sessionReflectionId}`)) {
      const result = resolveDailyReflectionVisualRequest(target, route.request().method(), url);
      if (result.action === "fulfill" && result.status === 200) { await json(result.body); return; }
    }
    const result = resolveDailyReflectionVisualRequest(fixture, route.request().method(), url);
    if (result.action === "fulfill" && result.status === 200) { await json(result.body); return; }
    unexpected.push(`${route.request().method()} ${url.pathname}`);
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "fixture_unhandled" }) });
  });
  return { fixture: target, existing: fixture, posts, unexpected, release,
    lookupCount: () => lookupCount,
    setUploadState: (state: DailyReflectionOperationUploadState) => { uploadState = state; }
  };
}

async function record(page: Page) {
  await page.goto("/reflection");
  await page.getByRole("button", { name: "开始讲述，进入录音" }).click();
  await page.getByRole("button", { name: "结束表达", exact: true }).click();
  await expect(page.getByText("录音已结束 · 尚未上传")).toBeVisible();
  await page.getByRole("combobox", { name: "这段录音来自" }).selectOption("direct_conversation");
  await expect(page.getByRole("button", { name: "核对进度并继续上传" })).toBeEnabled();
}

async function clickHome(page: Page) {
  await page.locator('a[href="/reflection"]').filter({ visible: true }).first().click();
  await expect(page.getByRole("button", { name: "开始讲述，进入录音" })).toBeVisible();
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`keeps one recording through upload, home, cards, history and return at ${viewport.width}px`, async ({ page, context }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    await syntheticRecorder(context);
    const fixture = await setup(page);
    await record(page);
    await expect(page.getByText(/原录音已暂存在本机/u)).toBeVisible();
    await page.getByRole("button", { name: "核对进度并继续上传" }).click();
    await expect.poll(() => fixture.posts.length).toBe(1);
    await clickHome(page);
    await page.getByRole("button", { name: "开始讲述，进入录音" }).click();
    await expect(page.getByText("正在上传 · 尚未确认保存")).toBeVisible();
    await expect(page.getByRole("button", { name: "结束表达", exact: true })).toHaveCount(0);
    await clickHome(page);
    await page.getByRole("link", { name: "卡片", exact: true }).filter({ visible: true }).click();
    await clickHome(page);
    await page.getByRole("link", { name: "最近复盘", exact: true }).click();
    await expect(page.getByRole("heading", { name: "最近复盘", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "继续这次复盘", exact: true }).click();
    await expect(page).toHaveURL(/\/reflection\/capture\?resume=1$/u);
    await expect(page.getByText("正在上传 · 尚未确认保存")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    const smallTargets = await page.getByRole("complementary", { name: "这次录音的保存状态" })
      .locator("a,button,select").evaluateAll((elements) => elements.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44);
      }).length);
    expect(smallTargets).toBe(0);
    await page.screenshot({ path: `output/playwright/reflection-recovery/upload-${viewport.width}.png`, fullPage: true });
    await clickHome(page);
    await page.getByRole("link", { name: "最近复盘", exact: true }).click();
    await page.locator(`a[href="/reflection/sessions/${fixture.existing.ids.sessionReflectionId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${fixture.existing.ids.sessionReflectionId}$`, "u"));
    fixture.release();
    await expect.poll(() => fixture.posts.length).toBe(1);
    await expect(page).toHaveURL(new RegExp(`${fixture.existing.ids.sessionReflectionId}$`, "u"));
    await clickHome(page);
    await expect(page.getByText("录音已接收", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "继续这次复盘", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/reflection/sessions/${fixture.fixture.ids.sessionReflectionId}$`, "u"));
    await expect(page.getByText("录音已接收", { exact: true })).toBeVisible();
    expect(fixture.posts).toHaveLength(1);
    expect(fixture.unexpected).toEqual([]);
  });
}

test("restores an interrupted upload after page reload and retries the same operation and bytes", async ({ page, context }) => {
  test.setTimeout(90_000);
  await syntheticRecorder(context);
  const fixture = await setup(page, "offline");
  await record(page);
  await page.getByRole("button", { name: "核对进度并继续上传" }).click();
  await expect(page.getByText("上传中断 · 需要核对进度")).toBeVisible();
  await page.reload();
  await expect(page.getByText(/原录音已暂存在本机/u)).toBeVisible();
  await page.getByRole("button", { name: "核对进度并继续上传" }).click();
  await expect(page.getByText("录音已接收", { exact: true })).toBeVisible();
  expect(fixture.posts).toHaveLength(2);
  for (const name of ["operationKey", "sourceOrigin", "recordingDate"]) {
    const field = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]+)`, "u");
    expect(fixture.posts[0].match(field)?.[1]).toBeTruthy();
    expect(fixture.posts[1].match(field)?.[1]).toBe(fixture.posts[0].match(field)?.[1]);
  }
  expect(fixture.posts.every((body) => body.includes("SYNTHETIC_RECOVERY_AUDIO"))).toBe(true);
  expect(fixture.unexpected).toEqual([]);
});

test("recovers the same local operation after closing the page and reopening this site", async ({ page, context }) => {
  await syntheticRecorder(context);
  const first = await setup(page, "offline");
  await record(page);
  await page.getByRole("button", { name: "核对进度并继续上传" }).click();
  await expect(page.getByText("上传中断 · 需要核对进度")).toBeVisible();
  await page.close();
  const reopened = await context.newPage();
  const next = await setup(reopened, "lost");
  await reopened.goto("/reflection");
  await reopened.getByRole("link", { name: "继续这次复盘", exact: true }).click();
  await expect(reopened.getByText(/原录音已暂存在本机/u)).toBeVisible();
  expect(next.posts).toHaveLength(0);
  await reopened.getByRole("button", { name: "核对进度并继续上传" }).click();
  await expect(reopened.getByText("录音已接收", { exact: true })).toBeVisible();
  const operation = /name="operationKey"\r\n\r\n([^\r]+)/u;
  expect(first.posts[0].match(operation)?.[1]).toBeTruthy();
  expect(next.posts[0].match(operation)?.[1]).toBe(first.posts[0].match(operation)?.[1]);
  expect(next.posts[0]).toContain("SYNTHETIC_RECOVERY_AUDIO");
  expect(next.unexpected).toEqual([]);
});

test("adopts a saved operation after a lost response without posting again", async ({ page, context }) => {
  await syntheticRecorder(context);
  const fixture = await setup(page, "lost");
  await record(page);
  await page.getByRole("button", { name: "核对进度并继续上传" }).click();
  await expect(page.getByText("录音已接收", { exact: true })).toBeVisible();
  await page.reload();
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
});

test("offers the original download when local audio storage is unavailable", async ({ page, context }) => {
  await syntheticRecorder(context, true);
  await setup(page);
  await record(page);
  await expect(page.getByText(/本机暂存不可用/u)).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "下载原录音" }).click();
  expect((await download).suggestedFilename()).toMatch(/daily-reflection-.*\.webm/u);
  await expect(page.getByText(/原录音已暂存在本机/u)).toHaveCount(0);
});

test("uses accepted uploadState after persistence waiting without hijacking another history detail", async ({ page, context }) => {
  test.setTimeout(60_000);
  await syntheticRecorder(context);
  const fixture = await setup(page, "persistence");
  await record(page);
  await page.getByRole("button", { name: "核对进度并继续上传" }).click();
  await expect(page.getByText("服务器正在保存录音", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "下载原录音" })).toBeVisible();
  await clickHome(page);
  await page.getByRole("link", { name: "最近复盘", exact: true }).click();
  await page.locator(`a[href="/reflection/sessions/${fixture.existing.ids.sessionReflectionId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`${fixture.existing.ids.sessionReflectionId}$`, "u"));
  fixture.setUploadState("accepted");
  await expect.poll(() => fixture.lookupCount()).toBeGreaterThan(1);
  await expect(page).toHaveURL(new RegExp(`${fixture.existing.ids.sessionReflectionId}$`, "u"));
  await clickHome(page);
  await expect(page.getByText("录音已接收", { exact: true })).toBeVisible();
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
});

test("retains the recording after five still_persisting checks", async ({ page, context }) => {
  test.setTimeout(60_000);
  await syntheticRecorder(context);
  const fixture = await setup(page, "persistence");
  await record(page);
  await page.getByRole("button", { name: "核对进度并继续上传" }).click();
  await expect.poll(() => fixture.lookupCount()).toBe(5);
  await expect(page.getByText("服务器仍在保存录音。已保留现有录音，可稍后重新核对。")).toBeVisible();
  await expect(page.getByRole("link", { name: "下载原录音" })).toBeVisible();
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
});

test("reuploads the same operation only when the lookup explicitly allows it", async ({ page, context }) => {
  await syntheticRecorder(context);
  const fixture = await setup(page, "offline");
  await record(page);
  await page.getByRole("button", { name: "核对进度并继续上传" }).click();
  await expect(page.getByText("上传中断 · 需要核对进度")).toBeVisible();
  fixture.setUploadState("reupload_allowed");
  await page.getByRole("button", { name: "核对进度并继续上传" }).click();
  await expect(page.getByText("录音已接收", { exact: true })).toBeVisible();
  expect(fixture.posts).toHaveLength(2);
  for (const name of ["operationKey", "recordingDate", "sourceOrigin"]) {
    const field = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]+)`, "u");
    const original = fixture.posts[0].match(field)?.[1];
    expect(original).toBeTruthy();
    expect(fixture.posts[1].match(field)?.[1]).toBe(original);
  }
  expect(fixture.posts[1]).toContain("SYNTHETIC_RECOVERY_AUDIO");
  expect(fixture.unexpected).toEqual([]);
});

test("keeps the local original and does not POST for unresolved persistence", async ({ page, context }) => {
  await syntheticRecorder(context);
  const fixture = await setup(page, "offline");
  await record(page);
  await page.getByRole("button", { name: "核对进度并继续上传" }).click();
  await expect(page.getByText("上传中断 · 需要核对进度")).toBeVisible();
  fixture.setUploadState("unresolved");
  await page.getByRole("button", { name: "核对进度并继续上传" }).click();
  await expect(page.getByText("尚未确认录音保存状态。已保留现有录音，请稍后重新核对。")).toBeVisible();
  await expect(page.getByRole("link", { name: "下载原录音" })).toBeVisible();
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
});
