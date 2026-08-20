import {
  expect,
  request as playwrightRequest,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Route
} from "@playwright/test";
import Database from "better-sqlite3";
import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

type ProcessingProfile = "quick_reflection" | "full_recording";

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
    processingProfile: ProcessingProfile;
    ingestionContext: string;
    status: string;
  };
  processingPlan: {
    reflectionId: string;
    uploadId: string;
    inputMethod: string;
    sourceOrigin: string;
    processingProfile: ProcessingProfile;
    ingestionContext: string;
    reviewPolicy: string;
  } | null;
  upload: {
    id: string;
    originalName: string;
    mimeType: string;
    durationSeconds?: number;
  } | null;
  effectiveOrigin: string | null;
  segments: Array<{ id: string; uploadId: string; text: string }>;
  candidates: Array<{
    id: string;
    status: string;
    sourceSegmentIds: string[];
  }>;
};

type StoredBrowserUpload = {
  id: string;
  filePath: string;
  originalName: string;
  mimeType: string;
  durationSeconds: number;
  effectiveDurationMs: number;
  clientReportedDurationMs: number | null;
  durationSource: string;
  processingProfile: ProcessingProfile;
  ingestionContext: string;
  reflectionId: string;
};

type BrowserNetworkAudit = {
  externalHttp: string[];
  externalWebSockets: string[];
};

type RecorderAudit = {
  getUserMediaCalls: unknown[];
  constructorMimeTypes: Array<string | null>;
  startTimeslices: Array<number | null>;
  stopCalls: number;
  trackStopCalls: number;
};

type ScenarioResult = {
  accountId: string;
  context: BrowserContext;
  page: Page;
  network: BrowserNetworkAudit;
  receipt: DailyReflectionReceipt;
  detail: DailyReflectionDetail;
  storedUpload: StoredBrowserUpload;
  profile: ProcessingProfile;
  expectedClientDurationMs: number;
};

const password = "ReflectionE2e!2026";
const fixedNow = new Date("2026-08-13T08:00:00+08:00");

const forbiddenBusinessCollections = [
  "audio-insights",
  "semantic-segments",
  "brief-items",
  "relationship-signals",
  "relationship-lifecycle",
  "memory-owner-audits",
  "memory-owner-review-candidates",
  "memory-owner-review-operations",
  "proactive-insights",
  "speaker-identities",
  "voiceprint-training-candidates",
  "answers",
  "answers-by-upload",
  "answers-by-scope",
  "jobs",
  "jobs-by-upload"
] as const;

const completedStagingCollections = [
  "audio-chunks",
  "transcript-chunks",
  "daily-reflection-asset-attempts"
] as const;

function progress(completed: number, total: number, message: string) {
  console.log(`[daily-reflection-browser-fixture] ${completed}/${total} ${message}`);
}

function isLoopbackUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return true;
  return url.hostname === "localhost"
    || url.hostname === "::1"
    || url.hostname === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
}

async function installNetworkGuard(
  context: BrowserContext,
  audit: BrowserNetworkAudit
) {
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

async function installFakeRecorder(
  context: BrowserContext,
  fixtureBase64: string
) {
  await context.addInitScript(({ encodedFixture }) => {
    const audit: RecorderAudit = {
      getUserMediaCalls: [],
      constructorMimeTypes: [],
      startTimeslices: [],
      stopCalls: 0,
      trackStopCalls: 0
    };
    (window as typeof window & {
      __dailyReflectionRecorderAudit?: RecorderAudit;
    }).__dailyReflectionRecorderAudit = audit;

    const getUserMedia = async (constraints: MediaStreamConstraints) => {
      audit.getUserMediaCalls.push(JSON.parse(JSON.stringify(constraints)) as unknown);
      let readyState: "live" | "ended" = "live";
      const track = {
        kind: "audio",
        get readyState() {
          return readyState;
        },
        stop() {
          if (readyState === "ended") return;
          readyState = "ended";
          audit.trackStopCalls += 1;
        }
      } as unknown as MediaStreamTrack;
      return {
        getTracks: () => [track],
        getAudioTracks: () => [track],
        getVideoTracks: () => []
      } as unknown as MediaStream;
    };

    const mediaDevices = navigator.mediaDevices;
    Object.defineProperty(mediaDevices, "getUserMedia", {
      configurable: true,
      value: getUserMedia
    });

    class FixtureMediaRecorder {
      static isTypeSupported(mimeType: string) {
        return mimeType === "audio/webm;codecs=opus" || mimeType === "audio/webm";
      }

      readonly stream: MediaStream;
      readonly mimeType: string;
      state: "inactive" | "recording" | "paused" = "inactive";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onstart: ((event: Event) => void) | null = null;
      onstop: ((event: Event) => void) | null = null;

      constructor(stream: MediaStream, options?: MediaRecorderOptions) {
        this.stream = stream;
        this.mimeType = options?.mimeType || "audio/webm;codecs=opus";
        audit.constructorMimeTypes.push(options?.mimeType ?? null);
      }

      start(timeslice?: number) {
        if (this.state !== "inactive") throw new DOMException("already recording", "InvalidStateError");
        this.state = "recording";
        audit.startTimeslices.push(timeslice ?? null);
        this.onstart?.(new Event("start"));
      }

      stop() {
        if (this.state !== "recording") throw new DOMException("not recording", "InvalidStateError");
        audit.stopCalls += 1;
        this.state = "inactive";
        const binary = atob(encodedFixture);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        const blob = new Blob([bytes], { type: this.mimeType });
        queueMicrotask(() => {
          this.ondataavailable?.({ data: blob } as BlobEvent);
          this.onstop?.(new Event("stop"));
        });
      }
    }

    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      writable: true,
      value: FixtureMediaRecorder
    });
  }, { encodedFixture: fixtureBase64 });
}

async function guardedPage(input: {
  browser: Browser;
  fixtureBase64?: string;
  clock?: boolean;
}) {
  const context = await input.browser.newContext({
    viewport: { width: 1440, height: 960 },
    serviceWorkers: "block",
    timezoneId: "Asia/Shanghai"
  });
  const network: BrowserNetworkAudit = {
    externalHttp: [],
    externalWebSockets: []
  };
  await installNetworkGuard(context, network);
  if (input.fixtureBase64) {
    await installFakeRecorder(context, input.fixtureBase64);
  }
  const page = await context.newPage();
  if (input.clock) await page.clock.install({ time: fixedNow });
  return { context, page, network };
}

async function registerFixtureUser(baseURL: string, email: string, name: string) {
  const api = await playwrightRequest.newContext({ baseURL });
  try {
    const response = await api.post("/api/auth/register", {
      data: {
        email,
        password,
        name,
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
  await expect(page.getByRole("heading", {
    name: "把重要的人和片段，轻轻放在这里。"
  })).toBeVisible();
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

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function recorderAudit(page: Page) {
  return await page.evaluate(() => {
    const value = (window as typeof window & {
      __dailyReflectionRecorderAudit?: RecorderAudit;
    }).__dailyReflectionRecorderAudit;
    if (!value) throw new Error("Fake MediaRecorder audit is unavailable");
    return value;
  });
}

async function assertRecorderStartContract(page: Page) {
  const audit = await recorderAudit(page);
  expect(audit.getUserMediaCalls).toEqual([{
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true
    }
  }]);
  expect(audit.constructorMimeTypes).toEqual(["audio/webm;codecs=opus"]);
  expect(audit.startTimeslices).toEqual([1_000]);
  expect(audit.stopCalls).toBe(0);
  expect(audit.trackStopCalls).toBe(0);
}

async function assertSourceJump(page: Page) {
  const candidates = page.locator(
    'section[aria-labelledby="daily-reflection-candidates-title"] ol > li'
  );
  await candidates.first().getByRole("button", { name: "查看原话" }).click();
  const transcript = page.getByRole("region", { name: "完整文字稿" });
  const highlighted = transcript.locator('[data-highlighted="true"]');
  await expect(highlighted).toHaveCount(1);
  await expect(highlighted).toBeFocused();
  expect(await highlighted.getAttribute("data-segment-id")).toBeTruthy();
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function assertSqliteBusinessTablesEmpty(
  filePath: string,
  ignoredTables: ReadonlySet<string>
) {
  const database = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    const businessTables = tables
      .map((row) => row.name)
      .filter((name) => !name.startsWith("sqlite_") && !ignoredTables.has(name));
    expect(businessTables.length, `${basename(filePath)} must expose its business schema`).toBeGreaterThan(0);
    for (const table of businessTables) {
      const row = database.prepare(
        `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`
      ).get() as { count: number };
      expect(row.count, `${basename(filePath)}:${table} must remain empty`).toBe(0);
    }
  } finally {
    database.close();
  }
}

function assertDailyReflectionPersistence(input: {
  dataRoot: string;
  accountId: string;
  receipt: DailyReflectionReceipt;
  profile: ProcessingProfile;
  expectedCandidateCount: number;
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
      SELECT id, upload_id, input_method, source_origin, processing_profile,
             ingestion_context, status
      FROM dr_reflections
      WHERE id = ? AND account_id = ?
    `).get(input.receipt.reflectionId, input.accountId)).toEqual({
      id: input.receipt.reflectionId,
      upload_id: input.receipt.uploadId,
      input_method: "browser_recording",
      source_origin: "user_reflection",
      processing_profile: input.profile,
      ingestion_context: "daily_reflection",
      status: "review_pending"
    });
    expect(database.prepare(`
      SELECT upload_id, input_method, source_origin, processing_profile,
             ingestion_context, review_policy
      FROM dr_processing_plans
      WHERE reflection_id = ? AND account_id = ?
    `).get(input.receipt.reflectionId, input.accountId)).toEqual({
      upload_id: input.receipt.uploadId,
      input_method: "browser_recording",
      source_origin: "user_reflection",
      processing_profile: input.profile,
      ingestion_context: "daily_reflection",
      review_policy: "required"
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_candidates WHERE reflection_id = ? AND account_id = ?"
    ).get(input.receipt.reflectionId, input.accountId)).toEqual({
      count: input.expectedCandidateCount
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_asset_publications WHERE reflection_id = ? AND account_id = ?"
    ).get(input.receipt.reflectionId, input.accountId)).toEqual({ count: 2 });
  } finally {
    database.close();
  }
}

async function assertStoredBrowserUpload(input: {
  dataRoot: string;
  accountId: string;
  receipt: DailyReflectionReceipt;
  profile: ProcessingProfile;
  expectedClientDurationMs: number;
}) {
  const userRoot = resolve(input.dataRoot, "users", input.accountId);
  const uploadsRoot = resolve(userRoot, "uploads");
  const metadataPath = resolve(uploadsRoot, `${input.receipt.uploadId}.json`);
  const stored = await readJson<StoredBrowserUpload>(metadataPath);
  expect(stored).toMatchObject({
    id: input.receipt.uploadId,
    reflectionId: input.receipt.reflectionId,
    ingestionContext: "daily_reflection",
    clientReportedDurationMs: input.expectedClientDurationMs,
    durationSource: "server_ffprobe",
    processingProfile: input.profile
  });
  expect(stored.originalName).toMatch(/^daily-reflection-2026-08-13\.webm$/u);
  expect(stored.mimeType).toContain("audio/webm");
  expect(stored.durationSeconds).toBeGreaterThan(
    input.profile === "quick_reflection" ? 89 : 180
  );
  expect(stored.durationSeconds).toBeLessThan(
    input.profile === "quick_reflection" ? 91 : 182
  );
  if (input.profile === "quick_reflection") {
    expect(stored.effectiveDurationMs).toBeGreaterThanOrEqual(89_000);
    expect(stored.effectiveDurationMs).toBeLessThanOrEqual(90_999);
  } else {
    expect(stored.effectiveDurationMs).toBeGreaterThan(180_000);
    expect(stored.effectiveDurationMs).toBeLessThan(182_000);
  }

  const uploadFiles = await listFiles(uploadsRoot);
  expect(uploadFiles.filter((path) => path.endsWith(".json")).map((path) => basename(path)))
    .toEqual([`${input.receipt.uploadId}.json`]);
  expect(
    uploadFiles.filter((path) => !path.endsWith(".json")),
    "review_pending must not retain the original browser audio"
  ).toEqual([]);
  await expectMissing(stored.filePath);
  await expectMissing(resolve(uploadsRoot, `${input.receipt.uploadId}-chunks`));
  await expect(access(resolve(userRoot, "segments", `${input.receipt.uploadId}.json`)))
    .resolves.toBeUndefined();
  return stored;
}

async function assertPendingIsolation(page: Page, result: ScenarioResult) {
  const day = await page.request.get(`/api/days/${result.receipt.uploadId}`);
  expect(day.status()).toBe(404);
  const dayQa = await page.request.get(`/api/days/${result.receipt.uploadId}/qa`);
  expect(dayQa.status()).toBe(404);

  const people = await page.request.get("/api/people");
  expect(people.status()).toBe(200);
  await expect(people.json()).resolves.toEqual({ people: [] });

  const relationships = await page.request.get("/api/date-companion/relationships");
  expect(relationships.status()).toBe(200);
  await expect(relationships.json()).resolves.toEqual({ relationships: [] });

  const memoryQa = await page.request.get("/api/memory/all/qa");
  expect(memoryQa.status()).toBe(200);
  await expect(memoryQa.json()).resolves.toEqual({ answers: [] });

  const indexFiles = await listFiles(resolve(
    process.env.DAILY_REFLECTION_E2E_DATA_DIR!,
    "users",
    result.accountId,
    "indexes"
  ));
  expect(indexFiles, "review_pending must not enter a Hybrid index").toEqual([]);
}

async function assertForbiddenCollectionsEmpty(dataRoot: string, accountIds: string[]) {
  for (const accountId of accountIds) {
    const userRoot = resolve(dataRoot, "users", accountId);
    for (const collection of [
      ...forbiddenBusinessCollections,
      ...completedStagingCollections
    ]) {
      expect(
        await listFiles(resolve(userRoot, collection)),
        `${accountId}:${collection} must remain empty`
      ).toEqual([]);
    }
  }
}

async function runBrowserRecordingScenario(input: {
  browser: Browser;
  baseURL: string;
  artifactDir: string;
  dataRoot: string;
  email: string;
  accountId: string;
  fixtureBase64: string;
  profile: ProcessingProfile;
}) : Promise<ScenarioResult> {
  const expectedClientDurationMs = input.profile === "quick_reflection" ? 90_000 : 181_000;
  const expectedCandidateCount = input.profile === "quick_reflection" ? 3 : 4;
  const guarded = await guardedPage({
    browser: input.browser,
    fixtureBase64: input.fixtureBase64,
    clock: true
  });
  const { context, page, network } = guarded;
  const postRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/daily-reflections") {
      postRequests.push(request.url());
    }
  });

  await login(page, input.email);
  await page.getByRole("link", { name: /日常复盘/u }).click();
  await expect(page).toHaveURL(/\/date-companion\/reflection$/u);
  await expect(page.getByRole("heading", {
    name: "把一天里值得回看的话，慢慢整理出来。"
  })).toBeVisible();

  const pauseTarget = await page.evaluate(() => Date.now() + 60_000);
  await page.clock.pauseAt(pauseTarget);
  await page.getByRole("button", { name: "开始快速复盘" }).click();
  await expect(page.getByRole("button", { name: "停止录音" })).toBeVisible();
  await assertRecorderStartContract(page);
  expect(postRequests).toHaveLength(0);

  if (input.profile === "quick_reflection") {
    await page.clock.fastForward(90_000);
    await expect(page.getByLabel("录音时长 01:30")).toBeVisible();
    await expect(page.getByText("正在记录", { exact: true })).toBeVisible();
    expect((await recorderAudit(page)).stopCalls).toBe(0);
    expect(postRequests).toHaveLength(0);
    await page.screenshot({
      path: resolve(input.artifactDir, "01-quick-recording-90s.png"),
      fullPage: true
    });
  } else {
    await page.clock.fastForward(149_000);
    await expect(page.getByLabel("录音时长 02:29")).toBeVisible();
    await expect(page.getByText("正在记录", { exact: true })).toBeVisible();
    expect((await recorderAudit(page)).stopCalls).toBe(0);

    await page.clock.fastForward(1_000);
    await expect(page.getByLabel("录音时长 02:30")).toBeVisible();
    await expect(page.getByText(
      "已经说了两分半。你可以继续，也可以开始整理。",
      { exact: true }
    )).toBeVisible();

    await page.clock.fastForward(30_000);
    await expect(page.getByLabel("录音时长 03:00")).toBeVisible();
    await expect(page.getByText(
      "已经说了两分半。你可以继续，也可以开始整理。",
      { exact: true }
    )).toBeVisible();
    expect((await recorderAudit(page)).stopCalls).toBe(0);

    await page.clock.fastForward(1_000);
    await expect(page.getByLabel("录音时长 03:01")).toBeVisible();
    await expect(page.getByText(
      "你可以继续说。我会按完整复盘为你整理。",
      { exact: true }
    )).toBeVisible();
    expect((await recorderAudit(page)).stopCalls).toBe(0);
    expect(postRequests).toHaveLength(0);
    await page.screenshot({
      path: resolve(input.artifactDir, "05-full-recording-181s.png"),
      fullPage: true
    });
  }

  await page.getByRole("button", { name: "停止录音" }).click();
  await expect(page.getByText("本地录音已准备好", { exact: true })).toBeVisible();
  await expect(page.getByLabel(
    `本地录音时长 ${input.profile === "quick_reflection" ? "01:30" : "03:01"}`
  )).toBeVisible();
  const stoppedAudit = await recorderAudit(page);
  expect(stoppedAudit.stopCalls).toBe(1);
  expect(stoppedAudit.trackStopCalls).toBe(1);
  expect(postRequests, "stopping only creates a local Blob").toHaveLength(0);
  if (input.profile === "quick_reflection") {
    await page.screenshot({
      path: resolve(input.artifactDir, "02-quick-local-ready.png"),
      fullPage: true
    });
  }

  const uploadResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/api/daily-reflections"
    && response.request().method() === "POST"
  ));
  await page.clock.resume();
  await page.getByRole("button", { name: "提交并开始整理" }).click();
  const uploadResponse = await uploadResponsePromise;
  expect(uploadResponse.status()).toBe(201);
  expect(postRequests, "one user submission must produce one real POST").toHaveLength(1);
  expect(uploadResponse.request().headers()["content-type"]).toContain("multipart/form-data");
  const receipt = await uploadResponse.json() as DailyReflectionReceipt;
  expect(receipt).toMatchObject({ executionMode: "inline" });
  expect(receipt.reflectionId).toBeTruthy();
  expect(receipt.uploadId).toBeTruthy();

  await expect(page.getByRole("heading", { name: "整理好了，待你确认" }))
    .toBeVisible({ timeout: 180_000 });
  await expect(page).toHaveURL(new RegExp(
    `reflectionId=${encodeURIComponent(receipt.reflectionId)}`,
    "u"
  ));

  const detailResponse = await page.request.get(
    `/api/daily-reflections/${receipt.reflectionId}`
  );
  expect(detailResponse.status()).toBe(200);
  const detail = await detailResponse.json() as DailyReflectionDetail;
  expect(detail.reflection).toMatchObject({
    id: receipt.reflectionId,
    accountId: input.accountId,
    uploadId: receipt.uploadId,
    inputMethod: "browser_recording",
    sourceOrigin: "user_reflection",
    processingProfile: input.profile,
    ingestionContext: "daily_reflection",
    status: "review_pending"
  });
  expect(detail.processingPlan).toMatchObject({
    reflectionId: receipt.reflectionId,
    uploadId: receipt.uploadId,
    inputMethod: "browser_recording",
    sourceOrigin: "user_reflection",
    processingProfile: input.profile,
    ingestionContext: "daily_reflection",
    reviewPolicy: "required"
  });
  expect(detail.effectiveOrigin).toBe("user_reflection");
  expect(detail.upload?.id).toBe(receipt.uploadId);
  expect(detail.segments.length).toBeGreaterThanOrEqual(4);
  expect(detail.candidates).toHaveLength(expectedCandidateCount);
  expect(detail.candidates.every((candidate) => candidate.status === "pending")).toBe(true);

  const candidateItems = page.locator(
    'section[aria-labelledby="daily-reflection-candidates-title"] ol > li'
  );
  await expect(candidateItems).toHaveCount(3);
  if (input.profile === "quick_reflection") {
    await expect(page.getByRole("button", { name: "查看全部" })).toHaveCount(0);
    await page.screenshot({
      path: resolve(input.artifactDir, "03-quick-review-pending.png"),
      fullPage: true
    });
    await assertSourceJump(page);
    await page.screenshot({
      path: resolve(input.artifactDir, "04-quick-source-jump.png"),
      fullPage: true
    });
  } else {
    await expect(page.getByRole("button", { name: "查看全部" })).toBeVisible();
    await page.screenshot({
      path: resolve(input.artifactDir, "06-full-review-first-three.png"),
      fullPage: true
    });
    await page.getByRole("button", { name: "查看全部" }).click();
    await expect(candidateItems).toHaveCount(expectedCandidateCount);
    await expect(page.getByRole("button", { name: "收起" })).toBeVisible();
    await assertSourceJump(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: resolve(input.artifactDir, "07-full-expanded-source-mobile-390x844.png"),
      fullPage: true
    });
  }

  assertDailyReflectionPersistence({
    dataRoot: input.dataRoot,
    accountId: input.accountId,
    receipt,
    profile: input.profile,
    expectedCandidateCount
  });
  const storedUpload = await assertStoredBrowserUpload({
    dataRoot: input.dataRoot,
    accountId: input.accountId,
    receipt,
    profile: input.profile,
    expectedClientDurationMs
  });

  return {
    accountId: input.accountId,
    context,
    page,
    network,
    receipt,
    detail,
    storedUpload,
    profile: input.profile,
    expectedClientDurationMs
  };
}

async function deleteScenario(dataRoot: string, result: ScenarioResult) {
  const responsePromise = result.page.waitForResponse((response) => (
    new URL(response.url()).pathname
      === `/api/daily-reflections/${result.receipt.reflectionId}`
    && response.request().method() === "DELETE"
  ));
  await result.page.getByRole("button", { name: "删除记录" }).click();
  expect((await responsePromise).status()).toBe(204);
  await expect(result.page).toHaveURL(/\/date-companion\/reflection$/u);
  expect((await result.page.request.get(
    `/api/daily-reflections/${result.receipt.reflectionId}`
  )).status()).toBe(404);

  const userRoot = resolve(dataRoot, "users", result.accountId);
  await expectMissing(resolve(userRoot, "uploads", `${result.receipt.uploadId}.json`));
  await expectMissing(resolve(userRoot, "segments", `${result.receipt.uploadId}.json`));
  await expectMissing(resolve(
    userRoot,
    "daily-reflection-jobs",
    `${result.receipt.reflectionId}.json`
  ));
  await expectMissing(result.storedUpload.filePath);
  expect(await listFiles(resolve(userRoot, "uploads"))).toEqual([]);

  const database = new Database(resolve(dataRoot, "daily-reflection.sqlite"), {
    readonly: true,
    fileMustExist: true
  });
  try {
    expect(database.prepare(
      "SELECT status FROM dr_reflections WHERE id = ? AND account_id = ?"
    ).get(result.receipt.reflectionId, result.accountId)).toEqual({ status: "deleted" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_candidates WHERE reflection_id = ? AND account_id = ?"
    ).get(result.receipt.reflectionId, result.accountId)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_asset_publications WHERE reflection_id = ? AND account_id = ?"
    ).get(result.receipt.reflectionId, result.accountId)).toEqual({ count: 0 });
  } finally {
    database.close();
  }
}

test("records quick and full browser reflections through the real local staging boundary", async ({
  browser,
  baseURL
}) => {
  test.setTimeout(480_000);
  if (!baseURL) throw new Error("DAILY_REFLECTION_E2E_BASE_URL is required");
  const quickFixturePath = process.env.DAILY_REFLECTION_E2E_QUICK_FIXTURE_PATH;
  const fullFixturePath = process.env.DAILY_REFLECTION_E2E_FULL_FIXTURE_PATH;
  const artifactDir = process.env.DAILY_REFLECTION_E2E_ARTIFACT_DIR;
  const dataRoot = process.env.DAILY_REFLECTION_E2E_DATA_DIR;
  if (!quickFixturePath || !fullFixturePath || !artifactDir || !dataRoot) {
    throw new Error("Browser fixture paths, artifact directory, and data directory are required");
  }
  await mkdir(artifactDir, { recursive: true });
  const [quickFixture, fullFixture] = await Promise.all([
    readFile(quickFixturePath).then((buffer) => buffer.toString("base64")),
    readFile(fullFixturePath).then((buffer) => buffer.toString("base64"))
  ]);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const quickEmail = `reflection-browser-quick-${suffix}@example.com`;
  const fullEmail = `reflection-browser-full-${suffix}@example.com`;
  const isolationEmail = `reflection-browser-isolation-${suffix}@example.com`;
  const [quickAccountId, fullAccountId, isolationAccountId] = await Promise.all([
    registerFixtureUser(baseURL, quickEmail, "Quick Reflection Fixture"),
    registerFixtureUser(baseURL, fullEmail, "Full Reflection Fixture"),
    registerFixtureUser(baseURL, isolationEmail, "Isolation Reflection Fixture")
  ]);
  expect(new Set([quickAccountId, fullAccountId, isolationAccountId]).size).toBe(3);
  progress(1, 12, "three isolated accounts registered through the real local auth API");

  const quick = await runBrowserRecordingScenario({
    browser,
    baseURL,
    artifactDir,
    dataRoot,
    email: quickEmail,
    accountId: quickAccountId,
    fixtureBase64: quickFixture,
    profile: "quick_reflection"
  });
  progress(2, 12, "90s remained recording, stopped locally, posted once, and staged three candidates");

  const full = await runBrowserRecordingScenario({
    browser,
    baseURL,
    artifactDir,
    dataRoot,
    email: fullEmail,
    accountId: fullAccountId,
    fixtureBase64: fullFixture,
    profile: "full_recording"
  });
  progress(3, 12, "149/150/180/181s UI boundaries passed without automatic stop");
  progress(4, 12, "181s posted once and staged four fixture candidates with three initially visible");

  await assertPendingIsolation(quick.page, quick);
  await assertPendingIsolation(full.page, full);
  progress(5, 12, "both pending uploads stayed outside Day QA, Memory, People, relationships, and indexes");

  await assertForbiddenCollectionsEmpty(dataRoot, [quickAccountId, fullAccountId]);
  assertSqliteBusinessTablesEmpty(
    resolve(dataRoot, "memory.sqlite"),
    new Set(["schema_migrations"])
  );
  assertSqliteBusinessTablesEmpty(
    resolve(dataRoot, "date-companion.sqlite"),
    new Set(["dc_schema_migrations"])
  );
  progress(6, 12, "Memory, Person, Relationship, Lifecycle, Proactive, Voice, QA, and index stores stayed empty");

  const isolation = await guardedPage({ browser });
  await login(isolation.page, isolationEmail);
  for (const result of [quick, full]) {
    expect((await isolation.page.request.get(
      `/api/daily-reflections/${result.receipt.reflectionId}`
    )).status()).toBe(404);
    expect((await isolation.page.request.get(
      `/api/days/${result.receipt.uploadId}`
    )).status()).toBe(404);
  }
  progress(7, 12, "the third account received uniform 404s for both reflection and upload IDs");

  await deleteScenario(dataRoot, quick);
  await deleteScenario(dataRoot, full);
  progress(8, 12, "real DELETE requests removed both review records and canonical staging assets");

  await Promise.all([
    quick.context.close(),
    full.context.close(),
    isolation.context.close()
  ]);
  for (const network of [quick.network, full.network, isolation.network]) {
    expect(network.externalHttp).toEqual([]);
    expect(network.externalWebSockets).toEqual([]);
  }
  progress(9, 12, "browser external HTTP and WebSocket request counts are zero");
  progress(10, 12, "auth, recording submission, polling, evidence reads, and deletion APIs were not mocked");
  progress(11, 12, "server profile selection came from persisted audio and server_ffprobe");
  console.log(
    "[daily-reflection-browser-fixture] evidence_boundary "
    + "fake_media_recorder=true fixture_asr=true real_microphone=false real_provider=false"
  );
  progress(12, 12, `fixture gate complete screenshots=7 artifacts=${artifactDir}`);
});
