import {
  expect,
  request as playwrightRequest,
  test,
  type BrowserContext,
  type Page,
  type Route
} from "@playwright/test";
import Database from "better-sqlite3";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

type UploadReceipt = {
  uploadId: string;
  jobId: string;
  status: string;
  ingestionReceipt: {
    receiptId: string;
    operationKey: string;
    relationshipId: string;
    generation?: number;
    uploadId: string;
    jobId: string;
    state: "reserving" | "accepted" | "processing" | "completed" | "failed";
    decision: "accepted" | "replayed";
    recordingDate: string;
    serverAcceptedAt?: string;
  };
};

type ImportResponse = {
  interactionId: string;
  reused: boolean;
  view: {
    relationship: { id: string };
    interactions: Array<{
      id: string;
      sourceUploadId: string;
      sourceState: string;
      status: string;
    }>;
  };
};

type NetworkAudit = {
  externalHttp: string[];
  externalWebSockets: string[];
};

const password = "DateToyE2e!2026";
const pickerCountKey = "date-companion-toy-sync-e2e-picker-count";
const expectedRecordingDate = "2026-08-18";

function progress(completed: number, total: number, message: string) {
  console.log(`[date-companion-toy-sync-fixture] ${completed}/${total} ${message}`);
}

function applicationPath(rawUrl: string) {
  return new URL(rawUrl).pathname;
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

async function installImportGate(context: BrowserContext) {
  let requestCount = 0;
  let releaseGate: () => void = () => undefined;
  let markSeen: () => void = () => undefined;
  const released = new Promise<void>((resolveRelease) => {
    releaseGate = () => resolveRelease();
  });
  const seen = new Promise<void>((resolveSeen) => {
    markSeen = () => resolveSeen();
  });
  await context.route("**/api/date-companion/relationships/*/interactions/import", async (route) => {
    if (route.request().method() === "POST") {
      requestCount += 1;
      markSeen();
      await released;
    }
    await route.fallback();
  });
  let releasedOnce = false;
  return {
    seen,
    release() {
      if (releasedOnce) return;
      releasedOnce = true;
      releaseGate();
    },
    requestCount: () => requestCount
  };
}

async function registerFixtureUser(baseURL: string, email: string) {
  const api = await playwrightRequest.newContext({ baseURL });
  try {
    const response = await api.post("/api/auth/register", {
      data: {
        email,
        password,
        name: "Date Toy Sync Fixture User",
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
  await page.goto("/date-companion", { timeout: 20_000, waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "把重要的人和片段，轻轻放在这里。" })).toBeVisible();
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/date-companion\/modules$/u, { timeout: 20_000 });
}

async function enterCompanionAndCreateRelationship(page: Page) {
  const companionLink = page.getByRole("link", { name: /约会陪伴/u });
  await expect(companionLink).toBeVisible();
  await companionLink.click();
  await expect(page).toHaveURL(/\/date-companion\/a$/u, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "你想怎样称呼 Ta？" })).toBeVisible();

  const responsePromise = page.waitForResponse((response) =>
    applicationPath(response.url()) === "/api/date-companion/relationships"
    && response.request().method() === "POST"
  );
  const createButton = page.getByRole("button", { name: /开始记录这段关系/u });
  await expect(createButton).toBeEnabled();
  await createButton.click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const payload = await response.json() as {
    relationship: { id: string };
    reused: boolean;
  };
  expect(payload.reused).toBe(false);
  await expect(page.getByRole("heading", { name: "今天，有什么值得留在心里？" })).toBeVisible();
  return payload.relationship.id;
}

async function seedToyDirectory(page: Page, fixturePath: string) {
  const fixtureBase64 = (await readFile(fixturePath)).toString("base64");
  await page.evaluate(async ({ encodedFixture }) => {
    const binary = atob(encodedFixture);
    const audio = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const root = await navigator.storage.getDirectory();
    const recordings = await root.getDirectoryHandle("recordings", { create: true });

    const writeFixture = async (
      directory: FileSystemDirectoryHandle,
      name: string,
      contents: FileSystemWriteChunkType
    ) => {
      const handle = await directory.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(contents);
      await writable.close();
    };

    await writeFixture(recordings, "older.mp3", audio);
    await writeFixture(recordings, "latest.mp3", audio);
    await writeFixture(root, "manifest.json", JSON.stringify({
      recordings: [
        { filename: "older.mp3", created_at: "2026-08-17T08:00:00+08:00" },
        { filename: "latest.mp3", created_at: "2026-08-18T09:30:00+08:00" }
      ]
    }));
  }, { encodedFixture: fixtureBase64 });
}

async function pickerCallCount(page: Page) {
  return page.evaluate(
    (countKey) => Number.parseInt(localStorage.getItem(countKey) ?? "0", 10),
    pickerCountKey
  );
}

async function clearPersistedToyDirectory(page: Page, accountId: string) {
  await page.evaluate(async (targetAccountId) => {
    const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
      const request = indexedDB.open("daily-brief-toy-sync");
      request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    try {
      await new Promise<void>((resolveDelete, reject) => {
        const transaction = database.transaction("directories", "readwrite");
        transaction.objectStore("directories").delete(targetAccountId);
        transaction.addEventListener("complete", () => resolveDelete(), { once: true });
        transaction.addEventListener("error", () => reject(transaction.error), { once: true });
        transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
      });
    } finally {
      database.close();
    }
  }, accountId);
}

async function readToySyncRecord(page: Page, accountId: string, filename: string) {
  return page.evaluate(async ({ targetAccountId, targetFilename }) => {
    const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
      const request = indexedDB.open("daily-brief-toy-sync");
      request.addEventListener("success", () => resolveDatabase(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    try {
      const row = await new Promise<{ state?: string } | undefined>((resolveRow, reject) => {
        const transaction = database.transaction("destination-states", "readonly");
        const request = transaction.objectStore("destination-states")
          .get([targetAccountId, "date_companion"]);
        request.addEventListener(
          "success",
          () => resolveRow(request.result as { state?: string } | undefined),
          { once: true }
        );
        request.addEventListener("error", () => reject(request.error), { once: true });
      });
      const state = typeof row?.state === "string"
        ? JSON.parse(row.state) as {
            records?: Array<{
              filename?: string;
              status?: string;
              recordingDate?: string;
              operationKey?: string;
              receiptId?: string;
              uploadId?: string;
              jobId?: string;
              receiptStatus?: string;
              serverAcceptedAt?: string;
              sourceCleanedAt?: string;
            }>;
          }
        : null;
      return state?.records?.find((record) => record.filename === targetFilename) ?? null;
    } finally {
      database.close();
    }
  }, { targetAccountId: accountId, targetFilename: filename });
}

async function readPersistedSessionReceipt(page: Page, accountId: string) {
  return page.evaluate((targetAccountId) => {
    const raw = localStorage.getItem(`daily-brief:${targetAccountId}:date-companion:session`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      receipt?: { ingestionReceipt?: UploadReceipt["ingestionReceipt"] };
    };
    return parsed.receipt?.ingestionReceipt ?? null;
  }, accountId);
}

async function jsonNames(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

async function allFileNames(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = join(directory, entry.name);
    return entry.isDirectory() ? allFileNames(target) : [target];
  }));
  return nested.flat().sort();
}

async function readJsonFile(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function assertUploadJobCheckpoint(input: {
  dataRoot: string;
  accountId: string;
  receipt: UploadReceipt;
}) {
  const userRoot = resolve(input.dataRoot, "users", input.accountId);
  const uploadsRoot = resolve(userRoot, "uploads");
  const jobsRoot = resolve(userRoot, "jobs");
  const jobsByUploadRoot = resolve(userRoot, "jobs-by-upload");
  expect(await jsonNames(uploadsRoot)).toEqual([`${input.receipt.uploadId}.json`]);
  expect(await jsonNames(jobsRoot)).toEqual([`${input.receipt.jobId}.json`]);
  expect(await jsonNames(jobsByUploadRoot)).toEqual([`${input.receipt.uploadId}.json`]);

  const upload = await readJsonFile(resolve(uploadsRoot, `${input.receipt.uploadId}.json`));
  expect(upload).toMatchObject({
    id: input.receipt.uploadId,
    originalName: "latest.mp3",
    recordingDate: expectedRecordingDate,
    status: "ready",
    dateCompanionAudioSnapshotVersion: 1
  });
  const job = await readJsonFile(resolve(jobsRoot, `${input.receipt.jobId}.json`));
  expect(job).toMatchObject({
    id: input.receipt.jobId,
    uploadId: input.receipt.uploadId,
    status: "ready"
  });
}

async function assertCleanupRemovedTransientUpload(input: {
  dataRoot: string;
  accountId: string;
  receipt: UploadReceipt;
}) {
  const userRoot = resolve(input.dataRoot, "users", input.accountId);
  expect(await allFileNames(resolve(userRoot, "uploads"))).toEqual([]);
  expect(await jsonNames(resolve(userRoot, "jobs"))).toEqual([]);
  expect(await jsonNames(resolve(userRoot, "jobs-by-upload"))).toEqual([]);
  expect(await readJsonFile(resolve(
    userRoot,
    "deleted-uploads",
    `${input.receipt.uploadId}.json`
  ))).toMatchObject({ uploadId: input.receipt.uploadId });
}

function assertCanonicalToyReceipt(input: {
  dataRoot: string;
  accountId: string;
  relationshipId: string;
  receipt: UploadReceipt;
}) {
  const database = new Database(resolve(
    input.dataRoot,
    "users",
    input.accountId,
    "toy-ingestion.sqlite"
  ), {
    readonly: true,
    fileMustExist: true
  });
  try {
    const row = database.prepare(`
      SELECT receipt_id, account_id, destination, relationship_id, operation_key,
             upload_id, job_id, state, accepted_at
      FROM toy_ingestion_recovery_receipts
      WHERE account_id = ? AND receipt_id = ?
    `).get(
      input.accountId,
      input.receipt.ingestionReceipt.receiptId
    ) as Record<string, unknown> | undefined;
    expect(row).toMatchObject({
      receipt_id: input.receipt.ingestionReceipt.receiptId,
      account_id: input.accountId,
      destination: "date_companion",
      relationship_id: input.relationshipId,
      operation_key: input.receipt.ingestionReceipt.operationKey,
      upload_id: input.receipt.uploadId,
      job_id: input.receipt.jobId,
      state: expect.stringMatching(/^(?:accepted|processing|completed)$/u),
      accepted_at: expect.any(String)
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM toy_ingestion_recovery_receipts WHERE account_id = ?
    `).get(input.accountId)).toEqual({ count: 1 });
  } finally {
    database.close();
  }
}

function assertDraftConfirmationBoundary(input: {
  dataRoot: string;
  accountId: string;
  relationshipId: string;
  receipt: UploadReceipt;
  interactionId: string;
}) {
  const database = new Database(resolve(input.dataRoot, "date-companion.sqlite"), {
    readonly: true,
    fileMustExist: true
  });
  try {
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM dc_relationships WHERE user_id = ?
    `).get(input.accountId)).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM dc_interactions
      WHERE user_id = ? AND source_upload_id = ?
    `).get(input.accountId, input.receipt.uploadId)).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT id, relationship_id, source_upload_id, recording_date, original_name,
             status, source_state, confirmed_at, confirmation_fingerprint
      FROM dc_interactions
      WHERE id = ? AND user_id = ?
    `).get(input.interactionId, input.accountId)).toEqual({
      id: input.interactionId,
      relationship_id: input.relationshipId,
      source_upload_id: input.receipt.uploadId,
      recording_date: expectedRecordingDate,
      original_name: "latest.mp3",
      status: "draft",
      source_state: "server_cleaned",
      confirmed_at: null,
      confirmation_fingerprint: null
    });

    const participants = database.prepare(`
      SELECT role, confirmed_by, confirmed_at
      FROM dc_participant_assignments
      WHERE interaction_id = ? AND user_id = ?
      ORDER BY speaker_id
    `).all(input.interactionId, input.accountId) as Array<{
      role: string;
      confirmed_by: string | null;
      confirmed_at: string | null;
    }>;
    expect(participants.length).toBeGreaterThan(0);
    expect(participants.every((participant) =>
      participant.role === "unresolved"
      && participant.confirmed_by === null
      && participant.confirmed_at === null
    )).toBe(true);

    const recap = database.prepare(`
      SELECT disposition FROM dc_recap_items
      WHERE interaction_id = ? AND user_id = ?
    `).all(input.interactionId, input.accountId) as Array<{ disposition: string }>;
    expect(recap.length).toBeGreaterThan(0);
    expect(recap.every((item) => item.disposition === "pending")).toBe(true);
    for (const table of [
      "dc_memory_subject_selections",
      "dc_memory_bridge_outbox",
      "dc_promises"
    ]) {
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`
      ).get(input.accountId), `${table} must remain empty before recap confirmation`)
        .toEqual({ count: 0 });
    }
  } finally {
    database.close();
  }
}

async function assertNoLongTermMemory(input: { dataRoot: string; accountId: string }) {
  const path = resolve(input.dataRoot, "memory.sqlite");
  const file = await stat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!file) return;
  const database = new Database(path, {
    readonly: true,
    fileMustExist: true
  });
  try {
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM memory_items WHERE user_id = ?"
    ).get(input.accountId)).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_evidence").get())
      .toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dc_memory_bridge_receipts WHERE account_id = ?"
    ).get(input.accountId)).toEqual({ count: 0 });
  } finally {
    database.close();
  }
}

function assertRetentionMetadataOnly(input: {
  dataRoot: string;
  accountId: string;
  relationshipId: string;
  interactionId: string;
  uploadId: string;
}) {
  const database = new Database(resolve(input.dataRoot, "memory.sqlite"), {
    readonly: true,
    fileMustExist: true
  });
  try {
    expect(database.prepare(`
      SELECT user_id, upload_id, dc_relationship_id, dc_interaction_id,
             provenance_count, status
      FROM dc_retained_uploads
      WHERE user_id = ? AND upload_id = ?
    `).get(input.accountId, input.uploadId)).toEqual({
      user_id: input.accountId,
      upload_id: input.uploadId,
      dc_relationship_id: input.relationshipId,
      dc_interaction_id: input.interactionId,
      provenance_count: 0,
      status: "active"
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM memory_evidence_provenance
      WHERE user_id = ? AND upload_id = ?
    `).get(input.accountId, input.uploadId)).toEqual({ count: 0 });
  } finally {
    database.close();
  }
}

async function assertNoDailyReflection(input: { dataRoot: string; accountId: string }) {
  const path = resolve(input.dataRoot, "daily-reflection.sqlite");
  const file = await stat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!file) return;
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const table = database.prepare(`
      SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'dr_reflections'
    `).get() as { found: number } | undefined;
    if (!table) return;
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_reflections WHERE account_id = ?"
    ).get(input.accountId)).toEqual({ count: 0 });
  } finally {
    database.close();
  }
}

test("Toy response loss survives page close and resumes the existing Date Companion review gate", async ({
  browser,
  baseURL
}) => {
  test.setTimeout(480_000);
  if (!baseURL) throw new Error("DATE_COMPANION_E2E_BASE_URL is required");
  const fixturePath = process.env.DATE_COMPANION_E2E_FIXTURE_PATH;
  const dataRoot = process.env.DATE_COMPANION_E2E_DATA_DIR;
  const artifactDir = process.env.DATE_COMPANION_E2E_ARTIFACT_DIR;
  if (!fixturePath || !dataRoot || !artifactDir) {
    throw new Error("Date Companion Toy Sync fixture path, data directory, and artifact directory are required");
  }
  await mkdir(artifactDir, { recursive: true });

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `date-toy-sync-${suffix}@example.com`;
  const accountId = await registerFixtureUser(baseURL, email);
  progress(1, 13, "fixture user registered through the real auth API");

  const audit: NetworkAudit = { externalHttp: [], externalWebSockets: [] };
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1440, height: 1000 }
  });
  await installNetworkGuard(context, audit);
  await installDirectoryPickerFixture(context);
  const importGate = await installImportGate(context);
  let page = await context.newPage();
  let uploadPostCount = 0;
  let receiptGetCount = 0;
  let dailyReflectionRequestCount = 0;
  let recapMutationCount = 0;
  let droppedUploadResponse = false;
  let allowReceiptRecovery = false;
  let resolveDroppedReceipt: (receipt: UploadReceipt) => void = () => undefined;
  let resolveBlockedReceiptLookup: () => void = () => undefined;
  const droppedReceiptPromise = new Promise<UploadReceipt>((resolveReceipt) => {
    resolveDroppedReceipt = resolveReceipt;
  });
  const blockedReceiptLookupPromise = new Promise<void>((resolveLookup) => {
    resolveBlockedReceiptLookup = resolveLookup;
  });
  await context.route("**/api/uploads/toy-receipts**", async (route) => {
    if (
      route.request().method() === "GET"
      && droppedUploadResponse
      && !allowReceiptRecovery
    ) {
      resolveBlockedReceiptLookup();
      await route.abort("failed");
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/uploads", async (route) => {
    if (route.request().method() !== "POST" || droppedUploadResponse) {
      await route.continue();
      return;
    }
    droppedUploadResponse = true;
    const response = await route.fetch();
    if (response.status() !== 201) {
      throw new Error(`expected canonical Toy upload 201 before response loss, received ${response.status()}`);
    }
    resolveDroppedReceipt(await response.json() as UploadReceipt);
    await route.abort("failed");
  });
  context.on("request", (request) => {
    const path = applicationPath(request.url());
    if (path === "/api/uploads" && request.method() === "POST") uploadPostCount += 1;
    if (path === "/api/uploads/toy-receipts" && request.method() === "GET") receiptGetCount += 1;
    if (path.startsWith("/api/daily-reflections")) dailyReflectionRequestCount += 1;
    if (/\/api\/date-companion\/interactions\/[^/]+\/recap$/u.test(path)) recapMutationCount += 1;
  });

  try {
    await login(page, email);
    const relationshipId = await enterCompanionAndCreateRelationship(page);
    progress(2, 13, "user explicitly established one relationship before selecting audio");

    await seedToyDirectory(page, fixturePath);
    const uploadSummary = page.locator("summary").filter({ hasText: "上传这次相处的录音" }).first();
    await expect(uploadSummary).toBeVisible();
    await uploadSummary.click();
    await expect(page.getByRole("heading", { name: "从玩偶选择这次相处" })).toBeVisible();
    await page.getByRole("button", { name: "连接玩偶", exact: true }).click();
    await expect(page.getByText("已连接玩偶", { exact: true })).toBeVisible();
    await expect(page.getByText("发现 2 条录音", { exact: true })).toBeVisible();
    expect(await pickerCallCount(page)).toBe(1);
    progress(3, 13, "real OPFS DirectoryHandle scanned two recordings after one fixture picker gesture");

    await page.reload({ timeout: 20_000, waitUntil: "domcontentloaded" });
    const restoredSummary = page.locator("summary").filter({ hasText: "上传这次相处的录音" }).first();
    await restoredSummary.click();
    await expect(page.getByText("已连接玩偶", { exact: true })).toBeVisible();
    await expect(page.getByText("发现 2 条录音", { exact: true })).toBeVisible();
    expect(await pickerCallCount(page)).toBe(1);
    progress(4, 13, "reload restored the granted handle without reopening a real directory picker");

    const latestCard = page.locator("li").filter({ hasText: "latest.mp3" }).first();
    await expect(latestCard.getByText("最新录音", { exact: true })).toBeVisible();
    await latestCard.getByRole("button", { name: "选择这条录音", exact: true }).click();
    await expect(page.getByText("已从玩偶带入 · 录音日期已自动填写", { exact: true })).toBeVisible();
    await expect(page.getByText(expectedRecordingDate, { exact: true })).toBeVisible();
    await expect(page.getByLabel("这次相处发生在")).toHaveCount(0);
    progress(5, 13, "latest recording selected with its manifest date automatically applied");

    await page.getByRole("button", { name: "开始上传", exact: true }).click();

    const receipt = await droppedReceiptPromise;
    await blockedReceiptLookupPromise;
    await expect.poll(
      () => readToySyncRecord(page, accountId, "latest.mp3"),
      { timeout: 20_000 }
    ).toMatchObject({
      status: expect.stringMatching(/^(?:uploading|failed)$/u),
      recordingDate: expectedRecordingDate,
      operationKey: receipt.ingestionReceipt.operationKey
    });
    expect(importGate.requestCount()).toBe(0);
    await clearPersistedToyDirectory(page, accountId);
    await page.close();

    allowReceiptRecovery = true;
    page = await context.newPage();
    const recoveredReceiptResponsePromise = page.waitForResponse((response) =>
      applicationPath(response.url()) === "/api/uploads/toy-receipts"
      && response.request().method() === "GET"
      && response.status() === 200
    );
    const importResponsePromise = page.waitForResponse((response) =>
      /\/api\/date-companion\/relationships\/[^/]+\/interactions\/import$/u.test(applicationPath(response.url()))
      && response.request().method() === "POST"
    );
    const cleanupResponsePromise = page.waitForResponse((response) =>
      /\/api\/uploads\/[^/]+$/u.test(applicationPath(response.url()))
      && response.request().method() === "DELETE"
    );
    await page.goto("/date-companion/a", { timeout: 20_000, waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "今天，有什么值得留在心里？" })).toBeVisible();
    const recoveredReceiptResponse = await recoveredReceiptResponsePromise;
    const recoveredReceipt = await recoveredReceiptResponse.json() as {
      ingestionReceipt: UploadReceipt["ingestionReceipt"];
    };
    expect(receipt.uploadId).toBeTruthy();
    expect(receipt.jobId).toBeTruthy();
    expect(receipt.uploadId).not.toBe(receipt.jobId);
    expect(receipt.ingestionReceipt.serverAcceptedAt).toBeTruthy();
    expect(recoveredReceipt.ingestionReceipt).toMatchObject({
      receiptId: receipt.ingestionReceipt.receiptId,
      operationKey: receipt.ingestionReceipt.operationKey,
      uploadId: receipt.uploadId,
      jobId: receipt.jobId,
      relationshipId
    });
    expect(uploadPostCount).toBe(1);
    expect(receiptGetCount).toBeGreaterThanOrEqual(2);
    expect(await pickerCallCount(page)).toBe(1);
    progress(6, 13, "after response loss and page close, a new page adopted the same receipt without a directory handle or second audio POST");

    await importGate.seen;
    try {
      await expect.poll(
        () => readToySyncRecord(page, accountId, "latest.mp3"),
        { timeout: 20_000 }
      ).toMatchObject({
        status: expect.stringMatching(/^(?:failed|uploaded)$/u),
        recordingDate: expectedRecordingDate,
        operationKey: receipt.ingestionReceipt.operationKey
      });
      await expect.poll(
        () => readPersistedSessionReceipt(page, accountId),
        { timeout: 20_000 }
      ).toMatchObject({
        receiptId: receipt.ingestionReceipt.receiptId,
        operationKey: receipt.ingestionReceipt.operationKey,
        relationshipId,
        uploadId: receipt.uploadId,
        jobId: receipt.jobId,
        serverAcceptedAt: expect.any(String)
      });
      await assertUploadJobCheckpoint({ dataRoot, accountId, receipt });
      assertCanonicalToyReceipt({
        dataRoot,
        accountId,
        relationshipId,
        receipt
      });
      await assertNoLongTermMemory({ dataRoot, accountId });
    } finally {
      importGate.release();
    }
    progress(7, 13, "receipt checkpoint persisted Toy=uploaded and exactly one Upload/Job while pre-confirmation Memory stayed empty");

    const importResponse = await importResponsePromise;
    expect(importResponse.status()).toBe(201);
    const imported = await importResponse.json() as ImportResponse;
    expect(imported.reused).toBe(false);
    expect(imported.view.relationship.id).toBe(relationshipId);
    expect(imported.view.interactions.find((item) => item.id === imported.interactionId)).toMatchObject({
      sourceUploadId: receipt.uploadId,
      status: "draft",
      sourceState: "available"
    });
    const cleanupResponse = await cleanupResponsePromise;
    expect(cleanupResponse.ok()).toBe(true);
    expect(importGate.requestCount()).toBe(1);
    await expect.poll(
      () => readToySyncRecord(page, accountId, "latest.mp3"),
      { timeout: 20_000 }
    ).toMatchObject({
      status: "uploaded",
      operationKey: receipt.ingestionReceipt.operationKey,
      receiptId: receipt.ingestionReceipt.receiptId,
      uploadId: receipt.uploadId,
      jobId: receipt.jobId,
      receiptStatus: expect.stringMatching(/^(?:accepted|processing|completed)$/u),
      serverAcceptedAt: expect.any(String)
    });
    progress(8, 13, "existing cache -> relationship import -> browser-cache cleanup chain completed once");

    const recapLink = page.getByRole("link", { name: /查看这次复盘/u }).first();
    await expect(recapLink).toBeVisible();
    await recapLink.click();
    await expect(page).toHaveURL(/\/date-companion\/a\/recap(?:\?.*)?$/u, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "这次录音里的说话人" })).toBeVisible();
    expect(recapMutationCount).toBe(0);
    progress(9, 13, "browser stopped at the speaker confirmation gate without assigning me or Ta");

    assertDraftConfirmationBoundary({
      dataRoot,
      accountId,
      relationshipId,
      receipt,
      interactionId: imported.interactionId
    });
    progress(10, 13, "Date Companion persisted one draft with unresolved participants, pending recap, and zero Memory outbox");

    await assertCleanupRemovedTransientUpload({ dataRoot, accountId, receipt });
    assertCanonicalToyReceipt({
      dataRoot,
      accountId,
      relationshipId,
      receipt
    });
    progress(11, 13, "browser-cache cleanup removed transient Upload and Job records while the minimal recovery receipt stayed canonical");

    await assertNoLongTermMemory({ dataRoot, accountId });
    assertRetentionMetadataOnly({
      dataRoot,
      accountId,
      relationshipId,
      interactionId: imported.interactionId,
      uploadId: receipt.uploadId
    });
    await assertNoDailyReflection({ dataRoot, accountId });
    expect(dailyReflectionRequestCount).toBe(0);
    progress(12, 13, "long-term Memory and Daily Reflection stayed empty; only zero-provenance retention metadata remained");

    expect(audit.externalHttp).toEqual([]);
    expect(audit.externalWebSockets).toEqual([]);
    expect(uploadPostCount).toBe(1);
    expect(receiptGetCount).toBeGreaterThanOrEqual(1);
    expect(importGate.requestCount()).toBe(1);
    expect(recapMutationCount).toBe(0);
    progress(13, 13, `Toy Sync Date Companion fixture complete artifact_dir=${artifactDir}`);
  } finally {
    importGate.release();
    await context.close();
  }
});
