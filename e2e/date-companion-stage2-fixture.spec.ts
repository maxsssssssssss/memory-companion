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
    version: number;
    participants: Array<{
      speakerId: string;
      audioSampleAvailable?: true;
    }>;
    recapItems: Array<{
      id: string;
      kind: "moment" | "mentioned" | "promise" | "continue";
      displayedText: string;
      disposition: "pending" | "kept" | "excluded";
      version: number;
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
const keptKeyword = "报价方案";
const absentKeyword = "火星咖啡";
function fixtureRoleForParticipant(speakerId: string) {
  if (/(?:^|_)speaker_1$/u.test(speakerId)) return "self" as const;
  if (/(?:^|_)speaker_2$/u.test(speakerId)) return "companion" as const;
  return undefined;
}

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

function expectedDisposition(
  item: RelationshipView["interactions"][number]["recapItems"][number]
) {
  const roles = item.evidence.map((evidence) => evidence.speakerId
    ? fixtureRoleForParticipant(evidence.speakerId)
    : undefined);
  const hasResolvedSources = roles.length > 0 && roles.every(Boolean);
  if (!hasResolvedSources) return "excluded" as const;
  if (item.kind === "mentioned") return roles.every((role) => role === "companion") ? "kept" as const : "excluded" as const;
  if (item.kind === "promise") return roles.every((role) => role === "self") ? "kept" as const : "excluded" as const;
  return "kept" as const;
}

async function assertParticipantAudio(input: {
  page: Page;
  interactionId: string;
  speakerId: string;
  speakerCard: ReturnType<Page["locator"]>;
}) {
  const { page, interactionId, speakerId, speakerCard } = input;
  const audio = speakerCard.locator("audio");
  const expectedPath = `/api/date-companion/interactions/${interactionId}/participants/${speakerId}/audio`;
  await expect(audio).toHaveAttribute("src", expectedPath);

  const full = await page.request.get(expectedPath);
  expect(full.status()).toBe(200);
  expect(full.headers()["content-type"]).toMatch(/^audio\/mpeg\b/u);
  expect(full.headers()["accept-ranges"]).toBe("bytes");
  expect((await full.body()).length).toBeGreaterThan(128);

  const range = await page.request.get(expectedPath, { headers: { Range: "bytes=0-63" } });
  expect(range.status()).toBe(206);
  expect(range.headers()["content-range"]).toMatch(/^bytes 0-63\/\d+$/u);
  expect((await range.body()).length).toBe(64);

  const playable = await audio.evaluate(async (element) => {
    const player = element as HTMLAudioElement;
    player.muted = true;
    player.load();
    if (player.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("audio metadata timeout")), 10_000);
        player.addEventListener("loadedmetadata", () => {
          window.clearTimeout(timeout);
          resolve();
        }, { once: true });
        player.addEventListener("error", () => {
          window.clearTimeout(timeout);
          reject(new Error("audio metadata failed"));
        }, { once: true });
      });
    }
    await player.play();
    const result = !player.paused && Number.isFinite(player.duration) && player.duration > 0;
    player.pause();
    return result;
  });
  expect(playable).toBe(true);
}

async function confirmSpeakersAndFinalize(input: {
  page: Page;
  interaction: RelationshipView["interactions"][number];
  screenshotPath?: string;
}) {
  const { page, interaction, screenshotPath } = input;
  await expect(page.getByRole("heading", { name: "这次录音里的说话人" })).toBeVisible();
  const selfParticipant = interaction.participants.find((participant) =>
    fixtureRoleForParticipant(participant.speakerId) === "self"
  );
  const companionParticipant = interaction.participants.find((participant) =>
    fixtureRoleForParticipant(participant.speakerId) === "companion"
  );
  if (!selfParticipant || !companionParticipant) {
    throw new Error("fixture participants could not be mapped to self and companion");
  }
  const speakerCard = (speakerId: string) => {
    const expectedPath = `/api/date-companion/interactions/${interaction.id}/participants/${speakerId}/audio`;
    return page.locator("article").filter({ has: page.locator(`audio[src="${expectedPath}"]`) }).first();
  };
  const selfSpeaker = speakerCard(selfParticipant.speakerId);
  const companionSpeaker = speakerCard(companionParticipant.speakerId);
  await expect(selfSpeaker).toBeVisible();
  await expect(companionSpeaker).toBeVisible();
  await assertParticipantAudio({
    page,
    interactionId: interaction.id,
    speakerId: selfParticipant.speakerId,
    speakerCard: selfSpeaker
  });
  await assertParticipantAudio({
    page,
    interactionId: interaction.id,
    speakerId: companionParticipant.speakerId,
    speakerCard: companionSpeaker
  });

  const recapBodies: Record<string, unknown>[] = [];
  const participantBodies: Record<string, unknown>[] = [];
  const captureMutation = (request: { method(): string; url(): string; postDataJSON(): unknown }) => {
    const path = applicationPath(request.url());
    if (request.method() !== "PUT") return;
    if (/\/api\/date-companion\/interactions\/[^/]+\/recap$/u.test(path)) recapBodies.push(postBody(request));
    if (/\/api\/date-companion\/interactions\/[^/]+\/participants$/u.test(path)) participantBodies.push(postBody(request));
  };
  page.on("request", captureMutation);

  await selfSpeaker.getByRole("button", { name: "我", exact: true }).click();
  await companionSpeaker.getByRole("button", { name: "Ta", exact: true }).click();
  await expect(selfSpeaker.getByRole("button", { name: "我", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(companionSpeaker.getByRole("button", { name: "Ta", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "保存说话人判断" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "留下", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "不留下", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);

  const finalizeResponsePromise = page.waitForResponse((response) =>
    /\/api\/date-companion\/interactions\/[^/]+\/recap$/u.test(applicationPath(response.url()))
    && response.request().method() === "PUT"
    && postBody(response.request()).finalize === true
  );
  const confirmButton = page.getByRole("button", { name: "确认并留下这次相处" });
  await expect(confirmButton).toHaveCount(1);
  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
  await confirmButton.click();
  const finalizeResponse = await finalizeResponsePromise;
  page.off("request", captureMutation);
  expect(finalizeResponse.ok()).toBe(true);
  await expect(page.getByText("已确认：我", { exact: true })).toBeVisible();
  await expect(page.getByText("已确认：Ta", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认并留下这次相处" })).toHaveCount(0);

  const expectedItems = interaction.recapItems.map((item) => ({
    id: item.id,
    version: item.version,
    disposition: expectedDisposition(item)
  }));
  expect(recapBodies).toHaveLength(1);
  expect(participantBodies).toHaveLength(0);
  expect(recapBodies[0]).toEqual({
    version: interaction.version,
    assignments: [
      { speakerId: selfParticipant.speakerId, role: "self" },
      { speakerId: companionParticipant.speakerId, role: "companion" }
    ],
    items: expectedItems,
    finalize: true
  });

  const finalized = await finalizeResponse.json() as { view: RelationshipView };
  return { view: finalized.view, expectedItems };
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
  const firstDraftInteraction = firstUpload.view.interactions.find((item) => item.id === firstUpload.imported.interactionId);
  if (!firstDraftInteraction) throw new Error("first imported interaction is missing from the relationship view");
  const firstFinalization = await confirmSpeakersAndFinalize({
    page,
    interaction: firstDraftInteraction,
    screenshotPath: `${artifactDir}/stage2-recap-speaker-confirm.png`
  });
  progress(6, 30, "one confirmation assigned the two fixture voices to me and Ta and submitted every automatic decision");

  const firstFinalView = firstFinalization.view;
  const firstInteraction = firstFinalView.interactions.find((item) => item.id === firstUpload.imported.interactionId);
  expect(firstInteraction?.status).toBe("confirmed");
  const firstExpectedById = new Map(firstFinalization.expectedItems.map((item) => [item.id, item.disposition]));
  expect(firstInteraction?.recapItems.map((item) => ({ id: item.id, disposition: item.disposition }))).toEqual(
    firstDraftInteraction.recapItems.map((item) => ({ id: item.id, disposition: firstExpectedById.get(item.id) }))
  );
  const firstKeptItems = firstInteraction?.recapItems.filter((item) => item.disposition === "kept") ?? [];
  const firstExcludedItems = firstInteraction?.recapItems.filter((item) => item.disposition === "excluded") ?? [];
  expect(firstKeptItems.length).toBeGreaterThan(0);
  expect(firstExcludedItems.length).toBeGreaterThan(0);
  expect(firstKeptItems.some((item) => item.displayedText.includes(keptKeyword))).toBe(true);
  const firstKeptPromises = firstKeptItems.filter((item) => item.kind === "promise");
  expect(firstKeptPromises.length).toBeGreaterThan(0);
  expect(firstFinalView.promises).toHaveLength(firstKeptPromises.length);
  progress(7, 30, "automatic kept/excluded semantics matched the single request and created only self-sourced promises");

  await page.getByRole("link", { name: "关于 Ta", exact: true }).click();
  await expect(page.getByText(keptKeyword, { exact: false }).first()).toBeVisible();
  await expect(page.getByText(absentKeyword, { exact: false })).toHaveCount(0);
  await expect(page.getByText("待完成").first()).toBeVisible();
  await page.screenshot({ path: `${artifactDir}/stage2-person-1920x1080.png`, fullPage: true });
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.screenshot({ path: `${artifactDir}/stage2-person-2560x1440.png`, fullPage: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  progress(8, 30, "person view showed only confirmed kept content at 1920 and 2560 widths");

  await page.getByRole("link", { name: "见面前" }).click();
  await expect(page).toHaveURL(/\/date-companion\/a\/prepare$/u);
  await expect(page.getByRole("heading", { name: "见 Ta 之前，花半分钟想一想", exact: true })).toBeVisible();
  await page.locator("summary").filter({ hasText: "你答应过" }).click();
  await expect(page.getByText(keptKeyword, { exact: false }).first()).toBeVisible();
  await expect(page.getByText(absentKeyword, { exact: false })).toHaveCount(0);
  await page.screenshot({ path: `${artifactDir}/stage2-prepare.png`, fullPage: true });
  progress(9, 30, "prepare view used the open kept promise and excluded the rejected item");

  await page.getByRole("link", { name: "关于 Ta", exact: true }).click();
  await page.getByRole("button", { name: "你答应了", exact: true }).click();
  const promiseResponsePromise = page.waitForResponse((response) =>
    /\/api\/date-companion\/promises\/[^/]+$/u.test(applicationPath(response.url()))
    && response.request().method() === "PATCH"
  );
  await page.getByRole("button", { name: "标为已完成" }).first().click();
  expect((await promiseResponsePromise).ok()).toBe(true);
  await expect(page.getByText("已完成").first()).toBeVisible();
  progress(10, 30, "the promise changed from open to done through the real API");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Ta", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "你答应了", exact: true }).click();
  await expect(page.getByText("已完成").first()).toBeVisible();
  await expect(page.getByText(keptKeyword, { exact: false }).first()).toBeVisible();
  progress(11, 30, "reload restored the confirmed recap and completed promise");

  const secondUpload = await uploadFixture({ page, fixturePath, recordingDate: secondDate, expectedRelationshipId: relationshipId });
  assertOrderedLifecycle(primaryAudit, secondUpload.receipt.uploadId);
  progress(12, 30, "second date used the same relationship and strict persistence order");

  await page.getByRole("link", { name: /查看这次复盘/u }).first().click();
  const secondDraftInteraction = secondUpload.view.interactions.find((item) => item.id === secondUpload.imported.interactionId);
  if (!secondDraftInteraction) throw new Error("second imported interaction is missing from the relationship view");
  const secondFinalization = await confirmSpeakersAndFinalize({
    page,
    interaction: secondDraftInteraction
  });
  const secondFinalView = secondFinalization.view;
  expect(secondFinalView.interactions.filter((interaction) => interaction.status === "confirmed")).toHaveLength(2);
  const secondInteraction = secondFinalView.interactions.find((item) => item.id === secondUpload.imported.interactionId);
  const secondExpectedById = new Map(secondFinalization.expectedItems.map((item) => [item.id, item.disposition]));
  expect(secondInteraction?.recapItems.map((item) => ({ id: item.id, disposition: item.disposition }))).toEqual(
    secondDraftInteraction.recapItems.map((item) => ({ id: item.id, disposition: secondExpectedById.get(item.id) }))
  );
  progress(13, 30, "second interaction used the same one-click speaker confirmation and automatic decisions");

  await page.getByRole("link", { name: "关于 Ta", exact: true }).click();
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
  progress(15, 30, "relationship search found a fixture keyword retained by automatic confirmation");

  const excludedIds = new Set([
    ...firstExcludedItems.map((item) => item.id),
    ...(secondInteraction?.recapItems.filter((item) => item.disposition === "excluded").map((item) => item.id) ?? [])
  ]);
  const excludedProbe = firstExcludedItems[0];
  if (!excludedProbe) throw new Error("fixture did not produce an automatically excluded recap item");
  const excludedProbeQuery = excludedProbe.displayedText.slice(0, 120).trim();
  const excludedProbeResponse = await page.request.get(
    `/api/date-companion/relationships/${relationshipId}/search?q=${encodeURIComponent(excludedProbeQuery)}`
  );
  expect(excludedProbeResponse.ok()).toBe(true);
  const excludedProbePayload = await excludedProbeResponse.json() as {
    results: Array<{ recapItemId: string; text: string }>;
  };
  expect(excludedProbePayload.results.every((result) => !excludedIds.has(result.recapItemId))).toBe(true);

  await searchInput.fill(absentKeyword);
  const absentSearchPromise = page.waitForResponse((response) =>
    /\/api\/date-companion\/relationships\/[^/]+\/search$/u.test(applicationPath(response.url()))
    && new URL(response.url()).searchParams.get("q") === absentKeyword
  );
  await page.getByRole("button", { name: "找一找" }).click();
  expect((await absentSearchPromise).ok()).toBe(true);
  await expect(page.getByText("没有找到已确认内容")).toBeVisible();
  await expect(page.getByText(absentKeyword, { exact: false })).toHaveCount(0);
  progress(16, 30, "search omitted excluded recap IDs and returned no fabricated absent keyword");

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
  await restoredPage.getByRole("button", { name: "你答应了", exact: true }).click();
  await expect(restoredPage.getByText(keptKeyword, { exact: false }).first()).toBeVisible();
  await expect(restoredPage.getByText(absentKeyword, { exact: false })).toHaveCount(0);
  await expect(restoredPage.locator("ol").locator("li")).toHaveCount(2);
  await restoredPage.locator("summary").filter({ hasText: "核对原话" }).first().click();
  await expect(restoredPage.getByText("已保留可核对原话").first()).toBeVisible();
  const restoredHistory = restoredPage.locator("section").filter({
    has: restoredPage.getByRole("heading", { name: "一起走过的几次" })
  });
  await restoredHistory.locator("ol > li").filter({ hasText: "8 月 2 日" })
    .getByRole("button", { name: "查看保留的复盘" }).click();
  await expect(restoredPage).toHaveURL(
    new RegExp(`/date-companion/a/recap\\?interaction=${firstUpload.imported.interactionId}$`, "u")
  );
  await expect(restoredPage.getByRole("heading", { name: "这次录音里的说话人" })).toBeVisible();
  await expect(restoredPage.getByText(/这台设备没有完整文字稿/u)).toBeVisible();
  await expect(restoredPage.getByRole("button", { name: "查看完整文字稿" })).toHaveCount(0);
  progress(17, 30, "a new browser context restored confirmed server content and evidence snapshots");
  progress(18, 30, "the new context opened an evidence-only historical recap without broken transcript actions");

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
  const crossUserSpeakerId = firstDraftInteraction.participants[0]?.speakerId;
  if (!crossUserSpeakerId) throw new Error("first fixture interaction has no participant for the isolation check");
  const crossUserAudio = await isolatedPage.request.get(
    `/api/date-companion/interactions/${firstUpload.imported.interactionId}/participants/${crossUserSpeakerId}/audio`
  );
  expect(crossUserAudio.status()).toBe(404);
  progress(19, 30, "another user saw no relationship and both cross-user view/audio IDs returned 404");

  expect(primaryAudit.externalRequests).toEqual([]);
  expect(restoredAudit.externalRequests).toEqual([]);
  expect(isolatedAudit.externalRequests).toEqual([]);
  progress(20, 30, "all three browser contexts made zero non-loopback requests");
  progress(21, 30, "auth, relationship creation, upload, Pipeline, polling and Day APIs were never mocked");
  progress(22, 30, "relationship import and browser-cache DELETE were never mocked");
  progress(23, 30, "participant, recap, promise and search APIs were never mocked");
  progress(24, 30, "both uploads retained fixed Evidence and playable speaker audio snapshots after server cleanup");
  progress(25, 30, "speaker aliases and provider labels were not used as identity proof");
  progress(26, 30, "unresolved and excluded content stayed outside long-term surfaces");
  progress(27, 30, "current-interaction QA was intentionally not exercised or intercepted in this Stage 2 flow");
  progress(28, 30, "fixture transcription used the fixed office sample and synthetic silent transport audio, not dating-content or voice-quality evidence");
  progress(29, 30, `screenshots saved under ${artifactDir}`);

  await isolatedContext.close();
  await restoredContext.close();
  await context.close();
  progress(30, 30, "Stage 2 fixture browser closure complete");
});
