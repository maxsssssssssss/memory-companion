import { expect, test, type APIRequestContext, type BrowserContext, type Route } from "@playwright/test";
import Database from "better-sqlite3";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

test.use({ trace: "off", screenshot: "off", video: "off" });

type Receipt = {
  reflectionId: string;
  uploadId: string;
  executionMode: string;
};

type Detail = {
  reflection: { id: string; status: string };
  processingPlan: {
    uploadId: string;
    inputMethod: string;
    sourceOrigin: string;
    processingProfile: string;
    ingestionContext: string;
  } | null;
  job: { status: string; progress: number } | null;
  upload: { durationSeconds?: number; effectiveDurationMs?: number; durationSource?: string } | null;
  segments: Array<{ id: string; uploadId: string; text: string; identity?: unknown }>;
  effectiveOrigin: string | null;
  candidates: Array<{
    id: string;
    reflectionId: string;
    status: string;
    subjectPersonId: string | null;
    subjectConfirmed: boolean;
    sourceSegmentIds: string[];
  }>;
};

type CaseResult = {
  name: "short" | "long";
  status: "passed";
  httpStatusClass: "2xx";
  elapsedMs: number;
  durationSeconds: number;
  processingProfile: "quick_reflection" | "full_recording";
  transcriptCharacters: number;
  segmentCount: number;
  candidateCount: number;
  semanticMarkers: Record<string, boolean>;
  semanticMarkerCount: number;
};

const forbiddenCollections = [
  "analysis-chunks",
  "audio-chunks",
  "audio-insights",
  "brief-items",
  "daily-reflection-asset-attempts",
  "date-companion-audio-staging",
  "memory-owner-audits",
  "memory-owner-review-candidates",
  "memory-owner-review-operations",
  "proactive-insights",
  "relationship-lifecycle",
  "relationship-signals",
  "semantic-segments",
  "speaker-identities",
  "transcript-chunks",
  "voiceprint-self-enrollment-operations",
  "voiceprint-training-candidates"
] as const;

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`required_environment_missing:${name}`);
  return value;
}

function progress(completed: number, total: number, message: string) {
  console.log(`[daily-reflection-real-asr] ${completed}/${total} ${message}`);
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  return (await Promise.all(entries.map(async (entry) => {
    const target = join(root, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  }))).flat().sort();
}

function exactLoopbackOrigin(rawBaseUrl: string) {
  const url = new URL(rawBaseUrl);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("browser_base_url_invalid");
  }
  if (!(url.hostname === "localhost" || url.hostname === "::1" || url.hostname.startsWith("127."))) {
    throw new Error("browser_base_url_not_loopback");
  }
  return url.origin;
}

async function installBrowserGuard(context: BrowserContext, allowedOrigin: string) {
  let blocked = 0;
  await context.route("**/*", async (route: Route) => {
    const url = new URL(route.request().url());
    if (["data:", "blob:", "about:"].includes(url.protocol) || url.origin === allowedOrigin) {
      await route.continue();
      return;
    }
    blocked += 1;
    await route.abort("blockedbyclient");
  });
  return {
    count: () => blocked,
    noteWebSocket: (rawUrl: string) => {
      const url = new URL(rawUrl);
      const allowedWebSocketOrigin = allowedOrigin.replace(/^http/u, "ws");
      if (url.origin !== allowedWebSocketOrigin) blocked += 1;
    }
  };
}

async function register(request: APIRequestContext, inviteCode: string) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await request.post("/api/auth/register", {
    data: {
      email: `dr31-${suffix}@example.com`,
      password: "DailyReflectionSmoke!2026",
      name: "DR31 Evaluation",
      inviteCode
    }
  });
  expect(response.status(), "auth registration must succeed").toBe(201);
  return (await response.json() as { user: { id: string } }).user.id;
}

async function pollTerminalDetail(request: APIRequestContext, reflectionId: string) {
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const response = await request.get(`/api/daily-reflections/${reflectionId}`);
    if (response.status() !== 200) throw new Error(`reflection_poll_http_${response.status()}`);
    const detail = await response.json() as Detail;
    if (detail.reflection.status === "review_pending") return detail;
    if (["failed", "cancelled", "deleted"].includes(detail.reflection.status)) {
      throw new Error(`reflection_terminal_${detail.reflection.status}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_200));
  }
  throw new Error("reflection_poll_timeout");
}

async function networkSubmitCounts(auditPath: string) {
  const lines = (await readFile(auditPath, "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; classification: string });
  return {
    starts: lines.filter((entry) => entry.event === "request_start" && entry.classification === "submit").length,
    ends: lines.filter((entry) => entry.event === "request_end" && entry.classification === "submit").length,
    errors: lines.filter((entry) => entry.event === "request_error").length,
    blocked: lines.filter((entry) => entry.event === "request_blocked").length
  };
}

function assertSemanticMarkers(name: "short" | "long", transcript: string) {
  const markers: Record<string, boolean> = {
    futurePlan: /下周/u.test(transcript),
    boundaryOrRest: /(?:边界|休息)/u.test(transcript),
    responseCommitment: /(?:答复|回复|回应)/u.test(transcript)
  };
  if (name === "long") {
    Object.assign(markers, {
      technicalContext: /(?:接口|日志|API)/iu.test(transcript),
      laterThursday: /(?:周四|星期四)/u.test(transcript),
      explicitResponse: /(?:明确.{0,12}(?:答复|回复|回应)|(?:答复|回复|回应).{0,12}明确)/u.test(transcript)
    });
  }
  for (const [marker, matched] of Object.entries(markers)) {
    expect(matched, `${name} semantic marker ${marker} must be present`).toBe(true);
  }
  return markers;
}

async function runCase(input: {
  request: APIRequestContext;
  name: "short" | "long";
  fixturePath: string;
  expectedDurationSeconds: number;
  expectedProfile: "quick_reflection" | "full_recording";
  recordingDate: string;
  onReceipt: (receipt: Receipt) => void;
}) {
  const audio = await readFile(input.fixturePath);
  const started = Date.now();
  const response = await input.request.post("/api/daily-reflections", {
    multipart: {
      file: {
        name: basename(input.fixturePath),
        mimeType: "audio/wav",
        buffer: audio
      },
      sourceOrigin: "user_reflection",
      inputMethod: "browser_recording",
      clientReportedDurationMs: String(Math.round(input.expectedDurationSeconds * 1_000)),
      recordingDate: input.recordingDate,
      idempotencyKey: `dr31-${input.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    }
  });
  expect(response.status(), `${input.name} multipart upload must succeed`).toBe(201);
  const receipt = await response.json() as Receipt;
  input.onReceipt(receipt);
  expect(receipt.executionMode).toBe("inline");
  const detail = await pollTerminalDetail(input.request, receipt.reflectionId);
  expect(detail.processingPlan).toMatchObject({
    uploadId: receipt.uploadId,
    inputMethod: "browser_recording",
    sourceOrigin: "user_reflection",
    processingProfile: input.expectedProfile,
    ingestionContext: "daily_reflection"
  });
  expect(detail.effectiveOrigin).toBe("user_reflection");
  expect(detail.upload?.durationSource).toBe("server_ffprobe");
  expect(detail.upload?.durationSeconds).toBeCloseTo(input.expectedDurationSeconds, 3);
  expect(detail.segments.length).toBeGreaterThan(0);
  expect(detail.segments.every((segment) => segment.text.trim().length > 0)).toBe(true);
  expect(detail.segments.every((segment) => segment.identity === undefined)).toBe(true);
  const segmentIds = new Set(detail.segments.map((segment) => segment.id));
  expect(segmentIds.size).toBe(detail.segments.length);
  expect(detail.candidates.length).toBeGreaterThan(0);
  if (input.name === "short") expect(detail.candidates.length).toBeLessThanOrEqual(3);
  expect(detail.candidates.every((candidate) =>
    candidate.status === "pending"
    && candidate.subjectPersonId === null
    && candidate.subjectConfirmed === false
  )).toBe(true);
  for (const candidate of detail.candidates) {
    expect(candidate.sourceSegmentIds.length, "candidate source evidence must be nonempty").toBeGreaterThan(0);
    expect(
      candidate.sourceSegmentIds.every((segmentId) => segmentIds.has(segmentId)),
      "candidate source evidence must reference canonical returned segments"
    ).toBe(true);
  }
  const semanticMarkers = assertSemanticMarkers(
    input.name,
    detail.segments.map((segment) => segment.text).join("\n")
  );
  expect(detail.job).toMatchObject({ status: "completed", progress: 100 });
  return {
    receipt,
    detail,
    result: {
      name: input.name,
      status: "passed",
      httpStatusClass: "2xx",
      elapsedMs: Date.now() - started,
      durationSeconds: detail.upload!.durationSeconds!,
      processingProfile: input.expectedProfile,
      transcriptCharacters: detail.segments.reduce((total, segment) => total + segment.text.length, 0),
      segmentCount: detail.segments.length,
      candidateCount: detail.candidates.length,
      semanticMarkers,
      semanticMarkerCount: Object.values(semanticMarkers).filter(Boolean).length
    } satisfies CaseResult
  };
}

function assertDatabaseBusinessTablesEmpty(filePath: string, migrationTable: string) {
  const database = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> ?
      ORDER BY name
    `).all(migrationTable) as Array<{ name: string }>;
    expect(tables.length, `${basename(filePath)} must expose business schema`).toBeGreaterThan(0);
    for (const { name } of tables) {
      const escaped = name.replaceAll('"', '""');
      const row = database.prepare(`SELECT COUNT(*) AS count FROM "${escaped}"`).get() as { count: number };
      expect(row.count, `${basename(filePath)} business rows must stay zero`).toBe(0);
    }
    return tables.length;
  } finally {
    database.close();
  }
}

async function assertPendingIsolation(input: {
  request: APIRequestContext;
  dataRoot: string;
  accountId: string;
  cases: Array<{ receipt: Receipt; detail: Detail }>;
}) {
  for (const item of input.cases) {
    expect((await input.request.get(`/api/days/${item.receipt.uploadId}`)).status()).toBe(404);
    expect((await input.request.get(`/api/days/${item.receipt.uploadId}/qa`)).status()).toBe(404);
  }
  const people = await input.request.get("/api/people");
  expect(people.status()).toBe(200);
  await expect(people.json()).resolves.toEqual({ people: [] });
  const relationships = await input.request.get("/api/date-companion/relationships");
  expect(relationships.status()).toBe(200);
  await expect(relationships.json()).resolves.toEqual({ relationships: [] });
  const memoryQa = await input.request.get("/api/memory/all/qa");
  expect(memoryQa.status()).toBe(200);
  await expect(memoryQa.json()).resolves.toEqual({ answers: [] });

  const memoryTables = assertDatabaseBusinessTablesEmpty(
    resolve(input.dataRoot, "memory.sqlite"),
    "schema_migrations"
  );
  const dateCompanionTables = assertDatabaseBusinessTablesEmpty(
    resolve(input.dataRoot, "date-companion.sqlite"),
    "dc_schema_migrations"
  );
  const userRoot = resolve(input.dataRoot, "users", input.accountId);
  for (const collection of forbiddenCollections) {
    expect(await listFiles(resolve(userRoot, collection)), `${collection} must remain empty`).toEqual([]);
  }
  expect(await listFiles(resolve(userRoot, "indexes"))).toEqual([]);
  expect((await listFiles(resolve(userRoot, "uploads"))).filter((file) => !file.endsWith(".json"))).toEqual([]);
  expect((await listFiles(userRoot)).filter((file) => /(?:\.tmp|\.attempt-|[\\/]chunks[\\/])/u.test(file))).toEqual([]);

  const database = new Database(resolve(input.dataRoot, "daily-reflection.sqlite"), {
    readonly: true,
    fileMustExist: true
  });
  try {
    expect(database.prepare("SELECT COUNT(*) AS count FROM dr_reflections").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(DISTINCT upload_id) AS count FROM dr_reflections").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(DISTINCT idempotency_key) AS count FROM dr_reflections").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dr_processing_plans").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dr_asset_publications").get()).toEqual({ count: 4 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM dr_candidates c
      LEFT JOIN dr_reflections r ON r.id = c.reflection_id AND r.account_id = c.account_id
      WHERE r.id IS NULL
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM dr_candidate_sources s
      LEFT JOIN dr_candidates c ON c.id = s.candidate_id AND c.account_id = s.account_id
      WHERE c.id IS NULL
    `).get()).toEqual({ count: 0 });
  } finally {
    database.close();
  }
  return {
    scope: "persistence_write_audit_only",
    functionCallAudit: "not_instrumented_in_browser_e2e",
    memoryBusinessRows: 0,
    dateCompanionBusinessRows: 0,
    forbiddenCollectionFiles: 0,
    retrievalIndexFiles: 0,
    memoryBusinessTablesChecked: memoryTables,
    dateCompanionBusinessTablesChecked: dateCompanionTables
  };
}

async function deleteReceipts(
  request: APIRequestContext,
  receipts: Receipt[],
  options: { allowAlreadyMissing?: boolean } = {}
) {
  for (const receipt of receipts) {
    const response = await request.delete(`/api/daily-reflections/${receipt.reflectionId}`);
    if (options.allowAlreadyMissing && response.status() === 404) continue;
    expect(response.status()).toBe(204);
    expect((await request.get(`/api/daily-reflections/${receipt.reflectionId}`)).status()).toBe(404);
  }
}

async function assertDeletedState(dataRoot: string, accountId: string, receipts: Receipt[]) {
  const userRoot = resolve(dataRoot, "users", accountId);
  const uploadFiles = await listFiles(resolve(userRoot, "uploads"));
  const segmentFiles = await listFiles(resolve(userRoot, "segments"));
  const jobFiles = await listFiles(resolve(userRoot, "daily-reflection-jobs"));
  for (const receipt of receipts) {
    expect(uploadFiles).not.toContain(resolve(userRoot, "uploads", `${receipt.uploadId}.json`));
    expect(segmentFiles).not.toContain(resolve(userRoot, "segments", `${receipt.uploadId}.json`));
    expect(jobFiles).not.toContain(resolve(userRoot, "daily-reflection-jobs", `${receipt.reflectionId}.json`));
  }
  const database = new Database(resolve(dataRoot, "daily-reflection.sqlite"), {
    readonly: true,
    fileMustExist: true
  });
  try {
    for (const receipt of receipts) {
      expect(database.prepare(
        "SELECT status FROM dr_reflections WHERE id = ? AND account_id = ?"
      ).get(receipt.reflectionId, accountId)).toEqual({ status: "deleted" });
    }
    expect(database.prepare("SELECT COUNT(*) AS count FROM dr_candidates").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dr_candidate_sources").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dr_asset_publications").get()).toEqual({ count: 0 });
  } finally {
    database.close();
  }
}

test("runs two serial real-ASR Daily Reflection staging cases with zero downstream writes", async ({ browser, baseURL }) => {
  test.setTimeout(30 * 60_000);
  if (!baseURL) throw new Error("base_url_missing");
  const allowedOrigin = exactLoopbackOrigin(baseURL);
  const dataRoot = requiredEnvironment("DAILY_REFLECTION_REAL_ASR_DATA_DIR");
  const shortPath = requiredEnvironment("DAILY_REFLECTION_REAL_ASR_SHORT_PATH");
  const longPath = requiredEnvironment("DAILY_REFLECTION_REAL_ASR_LONG_PATH");
  const resultPath = requiredEnvironment("DAILY_REFLECTION_REAL_ASR_RESULT_PATH");
  const auditPath = requiredEnvironment("DAILY_REFLECTION_REAL_ASR_NETWORK_AUDIT_PATH");
  const inviteCode = requiredEnvironment("DAILY_REFLECTION_REAL_ASR_INVITE_CODE");
  await Promise.all([access(shortPath), access(longPath), mkdir(dirname(resultPath), { recursive: true })]);

  const context = await browser.newContext({ serviceWorkers: "block" });
  const browserAudit = await installBrowserGuard(context, allowedOrigin);
  const page = await context.newPage();
  page.on("websocket", (socket) => browserAudit.noteWebSocket(socket.url()));
  const cases: Array<{ receipt: Receipt; detail: Detail; result: CaseResult }> = [];
  const receipts: Receipt[] = [];
  let hardGate = null;
  let stagedRecordsDeleted = false;
  let failureCode: string | null = "scenario_incomplete";
  try {
    await page.goto("/date-companion");
    const accountId = await register(page.request, inviteCode);
    progress(0, 2, "provider submits consumed");

    const short = await runCase({
      request: page.request,
      name: "short",
      fixturePath: shortPath,
      expectedDurationSeconds: 71.79551,
      expectedProfile: "quick_reflection",
      recordingDate: "2026-08-13",
      onReceipt: (receipt) => receipts.push(receipt)
    });
    cases.push(short);
    expect(await networkSubmitCounts(auditPath)).toEqual({ starts: 1, ends: 1, errors: 0, blocked: 0 });
    progress(1, 2, "short completed once; long may start");

    const long = await runCase({
      request: page.request,
      name: "long",
      fixturePath: longPath,
      expectedDurationSeconds: 186,
      expectedProfile: "full_recording",
      recordingDate: "2026-08-12",
      onReceipt: (receipt) => receipts.push(receipt)
    });
    cases.push(long);
    expect(await networkSubmitCounts(auditPath)).toEqual({ starts: 2, ends: 2, errors: 0, blocked: 0 });
    progress(2, 2, "long completed once; submit budget exhausted");

    hardGate = await assertPendingIsolation({ request: page.request, dataRoot, accountId, cases });
    await deleteReceipts(page.request, receipts);
    await assertDeletedState(dataRoot, accountId, receipts);
    stagedRecordsDeleted = true;
    failureCode = null;
  } catch (error) {
    failureCode = error instanceof Error && /^[a-z0-9_:-]+$/iu.test(error.message)
      ? error.message.slice(0, 160)
      : "scenario_failed";
    throw error;
  } finally {
    if (!stagedRecordsDeleted && receipts.length > 0) {
      await deleteReceipts(page.request, receipts, { allowAlreadyMissing: true }).then(() => {
        stagedRecordsDeleted = true;
      }).catch(() => undefined);
    }
    await writeFile(resultPath, `${JSON.stringify({
      schemaVersion: 1,
      status: failureCode === null ? "passed" : "failed",
      failureCode,
      cases: cases.map((item) => item.result),
      hardGate,
      browserExternalRequests: browserAudit.count(),
      cleanup: { stagedRecordsDeleted }
    }, null, 2)}\n`, "utf8");
    await context.close();
  }
  expect(browserAudit.count()).toBe(0);
});
