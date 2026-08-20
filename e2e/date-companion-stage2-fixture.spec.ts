import { expect, request as playwrightRequest, test, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { openDateCompanionDatabase } from "../src/lib/server/date-companion/db";
import { processDateCompanionMemoryBridgeInteraction } from "../src/lib/server/date-companion/memory-bridge-consumer";
import type { DateCompanionSubjectSuggestionProvider } from "../src/lib/server/date-companion/subject-suggestion-provider";
import { getOrCreateDateCompanionSubjectSuggestionBatch } from "../src/lib/server/date-companion/subject-suggestions";
import { openMemoryDatabase } from "../src/lib/server/memory/db";

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
      evidence: Array<{
        id: string;
        uploadId: string;
        speakerId?: string;
        sourceSegmentId: string;
        quote: string;
      }>;
    }>;
  }>;
  promises: Array<{
    id: string;
    text: string;
    status: "open" | "done";
    version: number;
  }>;
};

type PersonMapping = {
  selfPersonId: string;
  companionPersonId: string;
  relationshipType: "dating" | "partner" | "friend" | "other";
  status: "confirmed";
  version: number;
};

type MemorySubject = "self" | "companion" | "both" | "unknown";
type SubjectSuggestionBatch = Awaited<ReturnType<typeof getOrCreateDateCompanionSubjectSuggestionBatch>>;

type PersonSourceCatalog = {
  relationshipId: string;
  companionPersonId: string | null;
  mappingVersion: number | null;
  status: "ready" | "needs_review" | "unavailable";
  sources: Array<{
    evidenceSnapshotId: string;
    interactionId: string;
    uploadId: string;
    sourceSegmentId: string;
    quote: string;
    subject: "companion" | "both";
  }>;
};

type RelationshipSearchResult = {
  recapItemId: string;
  interactionId: string;
  kind: RelationshipView["interactions"][number]["recapItems"][number]["kind"];
  text: string;
  recordingDate: string;
  evidence: RelationshipView["interactions"][number]["recapItems"][number]["evidence"];
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
  subjectSuggestionMethods: string[];
};

const password = "DateE2e!2026";
const firstDate = "2026-08-02";
const secondDate = "2026-08-03";
const keptKeyword = "报价方案";
const absentKeyword = "火星咖啡";
const admittedKeyword = "证据链";
const companionKeyword = "用户不会信";
const unknownKeyword = "战略假设";
const stage2Total = 42;
function fixtureRoleForParticipant(speakerId: string) {
  if (/(?:^|_)speaker_1$/u.test(speakerId)) return "self" as const;
  if (/(?:^|_)speaker_2$/u.test(speakerId)) return "companion" as const;
  return undefined;
}

function progress(completed: number, _total: number, message: string) {
  console.log(`[date-companion-stage2-fixture] ${completed}/${stage2Total} ${message}`);
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
  await page.goto("/date-companion", { timeout: 20_000, waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/date-companion$/u, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "把重要的人和片段，轻轻放在这里。" })).toBeVisible();
  const emailInput = page.getByLabel("邮箱");
  const passwordInput = page.getByLabel("密码");
  const loginButton = page.getByRole("button", { name: "登录" });
  await expect(emailInput).toBeVisible();
  await expect(passwordInput).toBeVisible();
  await emailInput.fill(email, { timeout: 20_000 });
  await passwordInput.fill(password, { timeout: 20_000 });
  await expect(loginButton).toBeEnabled();
  await loginButton.click({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/date-companion\/modules$/u, { timeout: 20_000 });
}

async function enterCompanion(page: Page) {
  const companionLink = page.getByRole("link", { name: /约会陪伴/u });
  await expect(companionLink).toBeVisible();
  await companionLink.click({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/date-companion\/a$/u, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "你想怎样称呼 Ta？" })).toBeVisible({ timeout: 20_000 });
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

    if (/\/api\/date-companion\/interactions\/[^/]+\/subject-suggestions$/u.test(path)) {
      audit.subjectSuggestionMethods.push(request.method());
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
  const createButton = page.getByRole("button", { name: /开始记录这段关系/u });
  await expect(createButton).toBeEnabled();
  await createButton.click({ timeout: 20_000 });
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const payload = await response.json() as { relationship: { id: string; displayName?: string }; reused: boolean };
  expect(payload.reused).toBe(false);
  expect(payload.relationship.displayName).toBeUndefined();
  await expect(page.getByRole("heading", { name: "今天，有什么值得留在心里？" })).toBeVisible();
  return payload.relationship.id;
}

async function configureConfirmedPeopleAndRetention(input: {
  page: Page;
  relationshipId: string;
  suffix: string;
}) {
  const { page, relationshipId, suffix } = input;
  const selfName = `Fixture Self ${suffix}`;
  const companionName = `Fixture Ta ${suffix}`;
  await page.goto("/date-companion/a/people", { timeout: 20_000, waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/date-companion\/a\/people$/u, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "由你确认，谁是我，谁是 Ta" })).toBeVisible();

  const createConfirmedPerson = async (displayName: string) => {
    const createdPromise = page.waitForResponse((response) =>
      applicationPath(response.url()) === "/api/people"
      && response.request().method() === "POST"
    );
    const confirmedPromise = page.waitForResponse((response) =>
      /^\/api\/people\/[^/]+$/u.test(applicationPath(response.url()))
      && response.request().method() === "PATCH"
    );
    const nameInput = page.getByPlaceholder("输入你能认出的称呼");
    const createButton = page.getByRole("button", { name: "新增并确认" });
    await expect(nameInput).toBeVisible();
    await nameInput.fill(displayName, { timeout: 20_000 });
    await expect(createButton).toBeEnabled();
    await createButton.click({ timeout: 20_000 });
    const created = await createdPromise;
    const confirmed = await confirmedPromise;
    expect(created.status()).toBe(201);
    expect(confirmed.ok()).toBe(true);
    const payload = await confirmed.json() as {
      person: { id: string; status: string; explicitlyConfirmed: boolean; confirmedAt: string | null };
    };
    expect(payload.person).toMatchObject({
      status: "confirmed",
      explicitlyConfirmed: true
    });
    expect(payload.person.confirmedAt).toBeTruthy();
    await expect(page.getByRole("option", { name: displayName })).toHaveCount(2);
    return payload.person.id;
  };

  const selfPersonId = await createConfirmedPerson(selfName);
  const companionPersonId = await createConfirmedPerson(companionName);
  expect(selfPersonId).not.toBe(companionPersonId);

  const selfSelect = page.getByRole("combobox", { name: "我", exact: true });
  const companionSelect = page.getByRole("combobox", { name: "Ta", exact: true });
  const relationshipSelect = page.getByRole("combobox", { name: "你们现在的关系", exact: true });
  await expect(selfSelect).toBeVisible();
  await expect(companionSelect).toBeVisible();
  await expect(relationshipSelect).toBeVisible();
  await selfSelect.selectOption(selfPersonId, { timeout: 20_000 });
  await companionSelect.selectOption(companionPersonId, { timeout: 20_000 });
  await relationshipSelect.selectOption("dating", { timeout: 20_000 });
  const mappingPromise = page.waitForResponse((response) =>
    applicationPath(response.url()) === `/api/date-companion/relationships/${relationshipId}/person-mapping`
    && response.request().method() === "PUT"
  );
  const mappingButton = page.getByRole("button", { name: "确认人物设置" });
  await expect(mappingButton).toBeEnabled();
  await mappingButton.click({ timeout: 20_000 });
  const mappingResponse = await mappingPromise;
  expect(mappingResponse.ok()).toBe(true);
  const mappingPayload = await mappingResponse.json() as { mapping: PersonMapping };
  expect(mappingPayload.mapping).toMatchObject({
    selfPersonId,
    companionPersonId,
    relationshipType: "dating",
    status: "confirmed"
  });
  await expect(page.getByText("已生效", { exact: true })).toBeVisible();

  const retentionResponse = await page.request.get("/api/date-companion/memory-settings");
  expect(retentionResponse.ok()).toBe(true);
  const retentionPayload = await retentionResponse.json() as {
    setting: {
      enabled: boolean;
      version: number;
      createdAt: string;
      updatedAt: string;
      enabledAt: string | null;
      disabledAt: string | null;
    };
  };
  expect(retentionPayload.setting).toMatchObject({
    enabled: true,
    version: 0,
    enabledAt: null,
    disabledAt: null
  });
  expect(retentionPayload.setting.createdAt).toBeTruthy();
  expect(retentionPayload.setting.updatedAt).toBeTruthy();
  const retentionSwitch = page.getByRole("switch");
  await expect(retentionSwitch).toHaveAttribute("aria-checked", "true");
  await expect(retentionSwitch).toBeEnabled();

  const readMapping = await page.request.get(
    `/api/date-companion/relationships/${relationshipId}/person-mapping`
  );
  expect(readMapping.ok()).toBe(true);
  const persisted = await readMapping.json() as { mapping: PersonMapping };
  expect(persisted.mapping).toEqual(mappingPayload.mapping);
  return { selfName, companionName, mapping: persisted.mapping };
}

function fixtureSubjectProposal(quote: string) {
  if (quote.includes(companionKeyword)) {
    return {
      proposedSubject: "companion" as const,
      confidence: 0.97,
      reasonCode: "explicit_companion_reference" as const
    };
  }
  if (quote.includes(admittedKeyword)) {
    return {
      proposedSubject: "both" as const,
      confidence: 0.97,
      reasonCode: "mutual_relationship_context" as const
    };
  }
  if (quote.includes(keptKeyword)) {
    return {
      proposedSubject: "self" as const,
      confidence: 0.97,
      reasonCode: "explicit_self_reference" as const
    };
  }
  return {
    proposedSubject: "unknown" as const,
    confidence: 0.97,
    reasonCode: "insufficient_context" as const
  };
}

async function seedSubjectSuggestionBatch(input: {
  userId: string;
  interaction: RelationshipView["interactions"][number];
}) {
  const dataDirectory = process.env.DATE_COMPANION_E2E_DATA_DIR;
  if (!dataDirectory) throw new Error("DATE_COMPANION_E2E_DATA_DIR is required");
  const database = openDateCompanionDatabase({
    filePath: resolve(dataDirectory, "date-companion.sqlite")
  });
  let providerCallCount = 0;
  let canonicalSourceCount = 0;
  const provider: DateCompanionSubjectSuggestionProvider = {
    model: "Qwen/Qwen3.6-27B",
    async suggest(sources) {
      providerCallCount += 1;
      canonicalSourceCount = sources.length;
      return sources.map((source) => ({
        canonicalSourceKey: source.canonicalSourceKey,
        ...fixtureSubjectProposal(source.quote)
      }));
    }
  };
  try {
    const batch = await getOrCreateDateCompanionSubjectSuggestionBatch({
      database,
      userId: input.userId,
      interactionId: input.interaction.id,
      provider
    });
    expect(providerCallCount).toBe(1);
    expect(canonicalSourceCount).toBeGreaterThan(0);
    expect(batch.suggestions).toHaveLength(canonicalSourceCount);
    expect(new Set(batch.suggestions.map((suggestion) => suggestion.proposedSubject))).toEqual(
      new Set<MemorySubject>(["self", "companion", "both", "unknown"])
    );
    expect(batch.suggestions.flatMap((suggestion) => suggestion.evidenceSnapshotIds).sort()).toEqual(
      input.interaction.recapItems.flatMap((item) => item.evidence.map((source) => source.id)).sort()
    );
    return batch;
  } finally {
    database.close();
  }
}

async function consumeMemoryBridge(input: {
  userId: string;
  interactionId: string;
}) {
  const dataDirectory = process.env.DATE_COMPANION_E2E_DATA_DIR;
  if (!dataDirectory) throw new Error("DATE_COMPANION_E2E_DATA_DIR is required");
  const dateCompanionDatabase = openDateCompanionDatabase({
    filePath: resolve(dataDirectory, "date-companion.sqlite")
  });
  const memoryDatabase = openMemoryDatabase({
    filePath: resolve(dataDirectory, "memory.sqlite")
  });
  try {
    const result = await processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase,
      memoryDatabase,
      userId: input.userId,
      interactionId: input.interactionId
    });
    expect(result).toMatchObject({ completed: true });
    return result;
  } finally {
    memoryDatabase.close();
    dateCompanionDatabase.close();
  }
}

async function readPersonSourceCatalog(page: Page, relationshipId: string) {
  const response = await page.request.get(
    `/api/date-companion/relationships/${relationshipId}/person-source-catalog`
  );
  expect(response.ok()).toBe(true);
  return await response.json() as PersonSourceCatalog;
}

async function expectBridgeCompleted(page: Page, relationshipId: string, interactionId: string) {
  await expect.poll(async () => {
    const response = await page.request.get(
      `/api/date-companion/relationships/${relationshipId}/memory-review`
    );
    if (!response.ok()) return `http_${response.status()}`;
    const payload = await response.json() as {
      review: { interactions: Array<{ interactionId: string; status: string }> };
    };
    return payload.review.interactions.find((item) => item.interactionId === interactionId)?.status ?? "missing";
  }, { timeout: 20_000 }).toBe("completed");
}

async function uploadFixture(input: {
  page: Page;
  fixturePath: string;
  recordingDate: string;
  expectedRelationshipId: string;
}) {
  const { page, fixturePath, recordingDate, expectedRelationshipId } = input;
  await page.goto("/date-companion/a", { timeout: 20_000, waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/date-companion\/a$/u, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "今天，有什么值得留在心里？" })).toBeVisible();
  const uploadSummary = page.locator("details").first().locator("summary");
  await expect(uploadSummary).toBeVisible();
  await uploadSummary.click({ timeout: 20_000 });
  const fileInput = page.locator('input[type="file"]');
  const dateInput = page.locator('input[type="date"]');
  const uploadButton = page.getByRole("button", { name: "开始上传" });
  await fileInput.setInputFiles(fixturePath, { timeout: 20_000 });
  await expect(page.getByText(basename(fixturePath))).toBeVisible();
  await expect(dateInput).toBeVisible();
  await dateInput.fill(recordingDate, { timeout: 20_000 });

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

  await expect(uploadButton).toBeEnabled();
  await uploadButton.click({ timeout: 20_000 });
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
  mappingVersion: number;
  subjectBatch: SubjectSuggestionBatch;
  screenshotPath?: string;
}) {
  const { page, interaction, mappingVersion, subjectBatch, screenshotPath } = input;
  await expect(page.getByRole("heading", { name: "这次录音里的说话人" })).toBeVisible();
  expect(subjectBatch).toMatchObject({
    interactionId: interaction.id,
    interactionVersion: interaction.version,
    mappingVersion,
    model: "Qwen/Qwen3.6-27B"
  });
  const proposedSubjectByEvidenceId = new Map(subjectBatch.suggestions.flatMap((suggestion) =>
    suggestion.evidenceSnapshotIds.map((evidenceSnapshotId) => [
      evidenceSnapshotId,
      suggestion.proposedSubject
    ] as const)
  ));
  const subjectSuggestionConfirmation = {
    batchId: subjectBatch.batchId,
    evidenceDigest: subjectBatch.evidenceDigest,
    proposalDigest: subjectBatch.proposalDigest,
    confirmationFingerprint: subjectBatch.confirmationFingerprint,
    confirmedVisibleSuggestions: true
  } as const;
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

  const selfRoleButton = selfSpeaker.getByRole("button", { name: "我", exact: true });
  const companionRoleButton = companionSpeaker.getByRole("button", { name: "Ta", exact: true });
  await expect(selfRoleButton).toBeEnabled();
  await expect(companionRoleButton).toBeEnabled();
  await selfRoleButton.click({ timeout: 20_000 });
  await companionRoleButton.click({ timeout: 20_000 });
  await expect(selfRoleButton).toHaveAttribute("aria-pressed", "true");
  await expect(companionRoleButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "保存说话人判断" })).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);

  const defaultExpectedItems = interaction.recapItems.map((item) => ({
    id: item.id,
    version: item.version,
    disposition: expectedDisposition(item)
  }));
  const groupTitles = {
    moment: "这次值得记住",
    mentioned: "Ta 说起了什么",
    promise: "这次出现的约定",
    continue: "下次自然接上"
  } as const;
  const defaultKeptEvidenceIds = new Set(defaultExpectedItems.flatMap((mutation) => {
    if (mutation.disposition !== "kept") return [];
    return interaction.recapItems.find((item) => item.id === mutation.id)?.evidence.map((source) => source.id) ?? [];
  }));
  const visibleSuggestions = subjectBatch.suggestions.filter((suggestion) =>
    suggestion.evidenceSnapshotIds.some((evidenceSnapshotId) => defaultKeptEvidenceIds.has(evidenceSnapshotId))
  );
  const subjectCounts = new Map<MemorySubject, number>([
    ["self", 0],
    ["companion", 0],
    ["both", 0],
    ["unknown", 0]
  ]);
  for (const suggestion of visibleSuggestions) {
    subjectCounts.set(suggestion.proposedSubject, (subjectCounts.get(suggestion.proposedSubject) ?? 0) + 1);
  }
  const subjectPanel = page.locator("section").filter({
    has: page.getByRole("heading", { name: "看看哪些内容值得留下", exact: true })
  });
  await expect(subjectPanel.getByText("已经整理好", { exact: true })).toBeVisible();
  const subjectSummary = subjectPanel.getByLabel("内容范围统计");
  for (const [subject, label] of [
    ["companion", "关于 Ta"],
    ["both", "关于我们"],
    ["self", "关于我"],
    ["unknown", "暂不确定"]
  ] as const) {
    await expect(subjectSummary).toContainText(`${label} ${subjectCounts.get(subject) ?? 0}`);
    await expect(subjectPanel.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  }
  const subjectDetails = subjectPanel.locator("details").filter({ hasText: "查看每条归属" }).first();
  await expect(subjectDetails).toBeVisible();
  await subjectDetails.locator("summary").click({ timeout: 20_000 });
  const displayedSuggestion = subjectDetails.locator("li").first();
  await expect(displayedSuggestion).toBeVisible();
  await expect(displayedSuggestion.getByRole("button")).toHaveCount(0);
  const displayedSuggestionText = await displayedSuggestion.textContent();
  expect(interaction.recapItems.some((item) => item.evidence.some((source) =>
    displayedSuggestionText?.includes(source.quote)
  ))).toBe(true);

  const manuallyRemovedItem = interaction.recapItems.find((item) =>
    expectedDisposition(item) === "kept"
    && item.evidence.some((source) => proposedSubjectByEvidenceId.get(source.id) === "unknown")
  );
  if (!manuallyRemovedItem) throw new Error("fixture did not produce a kept unknown-subject item for explicit deletion");
  const manuallyRemovedGroup = page.locator("article").filter({
    has: page.getByRole("heading", { name: groupTitles[manuallyRemovedItem.kind], exact: true })
  });
  let manuallyRemovedCard = manuallyRemovedGroup.locator('div[data-disposition="kept"]').filter({
    hasText: manuallyRemovedItem.displayedText
  }).first();
  if (await manuallyRemovedCard.count() === 0) {
    const expandButton = manuallyRemovedGroup.getByRole("button", { name: /展开其余/u });
    if (await expandButton.count() > 0) await expandButton.click({ timeout: 20_000 });
    manuallyRemovedCard = manuallyRemovedGroup.locator('div[data-disposition="kept"]').filter({
      hasText: manuallyRemovedItem.displayedText
    }).first();
  }
  await expect(manuallyRemovedCard).toBeVisible();
  await manuallyRemovedCard.getByRole("button", { name: "这条不留下", exact: true }).click({ timeout: 20_000 });
  const excludedSummary = manuallyRemovedGroup.locator("summary").filter({ hasText: "未留下" }).first();
  await expect(excludedSummary).toBeVisible();
  await excludedSummary.click({ timeout: 20_000 });
  await expect(manuallyRemovedGroup.getByText("你选择不留下这条", { exact: true })).toBeVisible();

  const expectedItems = defaultExpectedItems.map((mutation) => mutation.id === manuallyRemovedItem.id
    ? { ...mutation, disposition: "excluded" as const }
    : mutation);
  const expectedSelections = expectedItems.flatMap((mutation) => {
    if (mutation.disposition !== "kept") return [];
    const item = interaction.recapItems.find((candidate) => candidate.id === mutation.id);
    if (!item) throw new Error(`missing recap item ${mutation.id}`);
    return item.evidence.map((source) => {
      const subject = proposedSubjectByEvidenceId.get(source.id);
      if (!subject) throw new Error(`Subject batch did not cover kept Evidence ${source.id}`);
      return { evidenceSnapshotId: source.id, subject };
    });
  });
  expect(expectedSelections.some((selection) => selection.subject === "companion")).toBe(true);
  expect(expectedSelections.some((selection) => selection.subject === "both")).toBe(true);
  expect(expectedSelections.some((selection) => selection.subject === "self")).toBe(true);
  expect(expectedSelections.every((selection) =>
    !manuallyRemovedItem.evidence.some((source) => source.id === selection.evidenceSnapshotId)
  )).toBe(true);

  const finalizeResponsePromise = page.waitForResponse((response) =>
    /\/api\/date-companion\/interactions\/[^/]+\/recap$/u.test(applicationPath(response.url()))
    && response.request().method() === "PUT"
    && postBody(response.request()).finalize === true
  );
  const confirmButton = page.getByRole("button", { name: "接受以上归属并留下" });
  await expect(confirmButton).toHaveCount(1);
  await expect(confirmButton).toBeEnabled();
  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
  await confirmButton.click({ timeout: 20_000 });
  const finalizeResponse = await finalizeResponsePromise;
  page.off("request", captureMutation);
  expect(finalizeResponse.ok()).toBe(true);
  await expect(page.getByText("已确认：我", { exact: true })).toBeVisible();
  await expect(page.getByText("已确认：Ta", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "接受以上归属并留下" })).toHaveCount(0);
  await expect(page).toHaveURL(
    new RegExp(`/date-companion/a/recap\\?interaction=${interaction.id}$`, "u"),
    { timeout: 20_000 }
  );

  expect(recapBodies).toHaveLength(1);
  expect(participantBodies).toHaveLength(0);
  expect(recapBodies[0]).toEqual({
    version: interaction.version,
    assignments: [
      { speakerId: selfParticipant.speakerId, role: "self" },
      { speakerId: companionParticipant.speakerId, role: "companion" }
    ],
    items: expectedItems,
    memoryAdmission: {
      mappingVersion,
      subjectSuggestionConfirmation,
      selections: expectedSelections
    },
    finalize: true
  });
  const excludedRecapItemIds = new Set(expectedItems
    .filter((item) => item.disposition === "excluded")
    .map((item) => item.id));
  const excludedSnapshotIds = new Set(interaction.recapItems
    .filter((item) => excludedRecapItemIds.has(item.id))
    .flatMap((item) => item.evidence.map((source) => source.id)));
  expect(expectedSelections.every((selection) => !excludedSnapshotIds.has(selection.evidenceSnapshotId))).toBe(true);

  const finalized = await finalizeResponse.json() as { view: RelationshipView };
  return { view: finalized.view, expectedItems, expectedSelections, excludedSnapshotIds };
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
  const firstUserId = await registerFixtureUser(baseURL, firstEmail, "Stage 2 Fixture User");
  progress(1, 30, "first fixture user registered through the real auth API");

  const primaryAudit: NetworkAudit = {
    externalRequests: [],
    order: [],
    cacheAtImport: new Map(),
    cleanupHeaders: new Map(),
    subjectSuggestionMethods: []
  };
  const context = await createGuardedContext(browser, primaryAudit);
  const page = await context.newPage();
  await login(page, firstEmail);
  await enterCompanion(page);
  progress(2, 30, "real login reached the explicit relationship setup");

  const relationshipId = await createRelationship(page);
  progress(3, 30, "the user explicitly created one unnamed relationship displayed as Ta");

  const people = await configureConfirmedPeopleAndRetention({
    page,
    relationshipId,
    suffix: runSuffix
  });
  expect(people.mapping.selfPersonId).not.toBe(people.mapping.companionPersonId);
  progress(4, 30, "the user explicitly created two distinct confirmed people and bound the active self");
  progress(5, 30, "the confirmed relationship mapping and default-enabled long-term retention were verified before upload");

  const firstUpload = await uploadFixture({ page, fixturePath, recordingDate: firstDate, expectedRelationshipId: relationshipId });
  assertOrderedLifecycle(primaryAudit, firstUpload.receipt.uploadId);
  progress(6, 30, "first real upload completed cache -> import -> cleanup in strict order");
  const firstDraftInteraction = firstUpload.view.interactions.find((item) => item.id === firstUpload.imported.interactionId);
  if (!firstDraftInteraction) throw new Error("first imported interaction is missing from the relationship view");
  const firstSubjectBatch = await seedSubjectSuggestionBatch({
    userId: firstUserId,
    interaction: firstDraftInteraction
  });
  progress(7, 30, "first server Day was cleaned and one deterministic whole-interaction Subject batch was persisted from canonical Evidence");

  const firstRecapLink = page.getByRole("link", { name: /查看这次复盘/u }).first();
  await expect(firstRecapLink).toBeVisible();
  await expect(firstRecapLink).toHaveAttribute("href", "/date-companion/a/recap");
  await firstRecapLink.click({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/date-companion\/a\/recap(?:\?.*)?$/u, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "这次录音里的说话人" })).toBeVisible({ timeout: 20_000 });
  const firstFinalization = await confirmSpeakersAndFinalize({
    page,
    interaction: firstDraftInteraction,
    mappingVersion: people.mapping.version,
    subjectBatch: firstSubjectBatch,
    screenshotPath: `${artifactDir}/stage2-recap-speaker-confirm.png`
  });
  progress(8, 30, "one confirmation assigned the voices, accepted the read-only Subject batch and excluded the item the user deleted");

  const firstFinalView = firstFinalization.view;
  const firstInteraction = firstFinalView.interactions.find((item) => item.id === firstUpload.imported.interactionId);
  if (!firstInteraction) throw new Error("first finalized interaction is missing from the relationship view");
  expect(firstInteraction.status).toBe("confirmed");
  const firstExpectedById = new Map(firstFinalization.expectedItems.map((item) => [item.id, item.disposition]));
  expect(firstInteraction?.recapItems.map((item) => ({ id: item.id, disposition: item.disposition }))).toEqual(
    firstDraftInteraction.recapItems.map((item) => ({ id: item.id, disposition: firstExpectedById.get(item.id) }))
  );
  const firstKeptItems = firstInteraction.recapItems.filter((item) => item.disposition === "kept");
  const firstExcludedItems = firstInteraction.recapItems.filter((item) => item.disposition === "excluded");
  expect(firstKeptItems.length).toBeGreaterThan(0);
  expect(firstExcludedItems.length).toBeGreaterThan(0);
  expect(firstKeptItems.some((item) => item.displayedText.includes(keptKeyword))).toBe(true);
  const firstKeptPromises = firstKeptItems.filter((item) => item.kind === "promise");
  expect(firstKeptPromises.length).toBeGreaterThan(0);
  expect(firstFinalView.promises).toHaveLength(firstKeptPromises.length);
  progress(9, 30, "kept/excluded semantics and the exact current proposal/Evidence confirmation were submitted in one request");

  const repeatedBootstrapRequests: string[] = [];
  const captureRepeatedBootstrap = (request: { method(): string; url(): string }) => {
    if (request.method() !== "GET") return;
    const path = applicationPath(request.url());
    if (
      path === "/api/auth/me"
      || path === "/api/date-companion/relationships"
      || /\/api\/date-companion\/relationships\/[^/]+\/view$/u.test(path)
    ) {
      repeatedBootstrapRequests.push(path);
    }
  };
  page.on("request", captureRepeatedBootstrap);

  const initialPersonLink = page.getByRole("link", { name: "关于 Ta", exact: true });
  await expect(initialPersonLink).toBeVisible();
  await initialPersonLink.click({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/date-companion\/a\/person$/u, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Ta", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(keptKeyword, { exact: false })).toHaveCount(0);
  await expect(page.getByText(absentKeyword, { exact: false })).toHaveCount(0);
  await expect(page.getByText("待完成")).toHaveCount(0);
  await expect(page.getByText("还没有确认过的相处")).toBeVisible();
  await page.screenshot({ path: `${artifactDir}/stage2-person-1920x1080.png`, fullPage: true });
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.screenshot({ path: `${artifactDir}/stage2-person-2560x1440.png`, fullPage: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  progress(10, 30, "person view stayed fail-closed before the queued long-term admission was consumed");

  const prepareLink = page.getByRole("link", { name: "见面前" });
  await expect(prepareLink).toBeVisible();
  await prepareLink.click({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/date-companion\/a\/prepare$/u, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "见 Ta 之前，花半分钟想一想", exact: true })).toBeVisible();
  const promiseSummary = page.locator("summary").filter({ hasText: "你答应过" });
  await expect(promiseSummary).toBeVisible();
  await promiseSummary.click({ timeout: 20_000 });
  await expect(page.getByText(keptKeyword, { exact: false })).toHaveCount(0);
  await expect(page.getByText(absentKeyword, { exact: false })).toHaveCount(0);
  await page.screenshot({ path: `${artifactDir}/stage2-prepare.png`, fullPage: true });
  progress(11, 30, "prepare view did not promote a kept promise before explicit long-term admission");

  const pendingPersonLink = page.getByRole("link", { name: "关于 Ta", exact: true });
  await expect(pendingPersonLink).toBeVisible();
  await pendingPersonLink.click({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/date-companion\/a\/person$/u, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Ta", exact: true })).toBeVisible({ timeout: 20_000 });
  expect(repeatedBootstrapRequests).toEqual([]);
  page.off("request", captureRepeatedBootstrap);
  const firstPromise = firstFinalView.promises[0];
  if (!firstPromise) throw new Error("fixture did not create a server promise");
  const promiseResponse = await page.request.patch(`/api/date-companion/promises/${firstPromise.id}`, {
    data: { version: firstPromise.version, status: "done" }
  });
  expect(promiseResponse.ok()).toBe(true);
  const promisePayload = await promiseResponse.json() as { view: RelationshipView };
  expect(promisePayload.view.promises.find((item) => item.id === firstPromise.id)?.status).toBe("done");
  progress(12, 30, "the server promise changed from open to done through the real API while its unadmitted UI stayed hidden");

  await page.reload({ timeout: 20_000, waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/date-companion\/a\/person$/u, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Ta", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("已完成")).toHaveCount(0);
  await expect(page.getByText(keptKeyword, { exact: false })).toHaveCount(0);
  const reloadedViewResponse = await page.request.get(`/api/date-companion/relationships/${relationshipId}/view`);
  expect(reloadedViewResponse.ok()).toBe(true);
  const reloadedView = await reloadedViewResponse.json() as { view: RelationshipView };
  expect(reloadedView.view.promises.find((item) => item.id === firstPromise.id)?.status).toBe("done");
  progress(13, 30, "reload preserved the server promise while the pending long-term UI remained fail-closed");

  const pendingReview = await page.request.get(
    `/api/date-companion/relationships/${relationshipId}/memory-review`
  );
  expect(pendingReview.ok()).toBe(true);
  expect((await pendingReview.json() as {
    review: { interactions: Array<{ interactionId: string; status: string }> };
  }).review.interactions.find((item) => item.interactionId === firstInteraction?.id)?.status).toBe("pending");
  const firstBridge = await consumeMemoryBridge({
    userId: firstUserId,
    interactionId: firstUpload.imported.interactionId
  });
  expect(firstBridge?.idempotent).toBe(false);
  await expectBridgeCompleted(page, relationshipId, firstUpload.imported.interactionId);
  progress(14, 30, "the production Bridge consumer committed the first pending admission into Memory SQLite");

  const firstCatalog = await readPersonSourceCatalog(page, relationshipId);
  expect(firstCatalog).toMatchObject({
    relationshipId,
    companionPersonId: people.mapping.companionPersonId,
    mappingVersion: people.mapping.version,
    status: "ready"
  });
  expect(firstCatalog.sources.length).toBeGreaterThan(0);
  expect(firstCatalog.sources.every((source) => ["companion", "both"].includes(source.subject))).toBe(true);
  expect(firstCatalog.sources.some((source) => source.quote.includes(admittedKeyword))).toBe(true);
  expect(firstCatalog.sources.some((source) => source.quote.includes(companionKeyword))).toBe(true);
  expect(firstCatalog.sources.every((source) => !source.quote.includes(unknownKeyword))).toBe(true);
  expect(firstCatalog.sources.every((source) => !source.quote.includes(keptKeyword))).toBe(true);
  expect(firstCatalog.sources.every((source) => !firstFinalization.excludedSnapshotIds.has(source.evidenceSnapshotId))).toBe(true);
  progress(15, 30, "the first catalog established kept companion/both trusted sources without invoking Person QA transport");

  await page.reload({ timeout: 20_000, waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/date-companion\/a\/person$/u, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Ta", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(admittedKeyword, { exact: false }).first()).toBeVisible();
  await expect(page.getByText(unknownKeyword, { exact: false })).toHaveCount(0);
  await expect(page.getByText(keptKeyword, { exact: false })).toHaveCount(0);
  const firstHistorySection = page.locator("section").filter({ has: page.getByRole("heading", { name: "一起走过的几次" }) });
  await expect(firstHistorySection.locator("ol > li")).toHaveCount(1);
  await page.screenshot({ path: `${artifactDir}/stage2-admitted-person-first.png`, fullPage: true });
  progress(16, 30, "the admitted person view recovered exactly one interaction after reload");

  const secondUpload = await uploadFixture({ page, fixturePath, recordingDate: secondDate, expectedRelationshipId: relationshipId });
  assertOrderedLifecycle(primaryAudit, secondUpload.receipt.uploadId);
  const secondDraftInteraction = secondUpload.view.interactions.find((item) => item.id === secondUpload.imported.interactionId);
  if (!secondDraftInteraction) throw new Error("second imported interaction is missing from the relationship view");
  const secondSubjectBatch = await seedSubjectSuggestionBatch({
    userId: firstUserId,
    interaction: secondDraftInteraction
  });
  progress(17, 30, "second date used the same relationship, strict persistence order and a separate server-owned Subject batch");

  const secondRecapLink = page.getByRole("link", { name: /查看这次复盘/u }).first();
  await expect(secondRecapLink).toBeVisible();
  await expect(secondRecapLink).toHaveAttribute("href", "/date-companion/a/recap");
  await secondRecapLink.click({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/date-companion\/a\/recap(?:\?.*)?$/u, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "这次录音里的说话人" })).toBeVisible({ timeout: 20_000 });
  const secondFinalization = await confirmSpeakersAndFinalize({
    page,
    interaction: secondDraftInteraction,
    mappingVersion: people.mapping.version,
    subjectBatch: secondSubjectBatch
  });
  const secondFinalView = secondFinalization.view;
  expect(secondFinalView.interactions.filter((interaction) => interaction.status === "confirmed")).toHaveLength(2);
  const secondInteraction = secondFinalView.interactions.find((item) => item.id === secondUpload.imported.interactionId);
  if (!secondInteraction) throw new Error("second finalized interaction is missing from the relationship view");
  const secondExpectedById = new Map(secondFinalization.expectedItems.map((item) => [item.id, item.disposition]));
  expect(secondInteraction.recapItems.map((item) => ({ id: item.id, disposition: item.disposition }))).toEqual(
    secondDraftInteraction.recapItems.map((item) => ({ id: item.id, disposition: secondExpectedById.get(item.id) }))
  );
  progress(18, 30, "second interaction reused the same read-only Subject and explicit deletion confirmation contract");

  const secondBridge = await consumeMemoryBridge({
    userId: firstUserId,
    interactionId: secondUpload.imported.interactionId
  });
  expect(secondBridge?.idempotent).toBe(false);
  await expectBridgeCompleted(page, relationshipId, secondUpload.imported.interactionId);
  progress(19, 30, "the production Bridge consumer completed the second interaction without duplicate state");

  const admittedPersonLink = page.getByRole("link", { name: "关于 Ta", exact: true });
  await expect(admittedPersonLink).toBeVisible();
  await admittedPersonLink.click({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/date-companion\/a\/person$/u, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Ta", exact: true })).toBeVisible({ timeout: 20_000 });
  const historySection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "一起走过的几次" })
  });
  // The production Bridge consumer runs out-of-band from the browser session, so the
  // client-side relationship snapshot remains on the first interaction until reload.
  await expect(historySection.locator("ol > li")).toHaveCount(1);
  await page.reload({ timeout: 20_000, waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/date-companion\/a\/person$/u, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Ta", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(historySection.locator("ol > li")).toHaveCount(2);
  await expect(page.getByText(admittedKeyword, { exact: false }).first()).toBeVisible();
  await expect(page.getByText(unknownKeyword, { exact: false })).toHaveCount(0);
  await expect(page.getByText(keptKeyword, { exact: false })).toHaveCount(0);
  await page.screenshot({ path: `${artifactDir}/stage2-two-interactions.png`, fullPage: true });
  progress(20, 30, "two completed admissions appeared as two server-restored relationship interactions");

  const finalCatalog = await readPersonSourceCatalog(page, relationshipId);
  expect(finalCatalog).toMatchObject({
    relationshipId,
    companionPersonId: people.mapping.companionPersonId,
    mappingVersion: people.mapping.version,
    status: "ready"
  });
  expect(new Set(finalCatalog.sources.map((source) => source.interactionId))).toEqual(new Set([
    firstUpload.imported.interactionId,
    secondUpload.imported.interactionId
  ]));
  expect(finalCatalog.sources.length).toBeGreaterThan(0);
  expect(finalCatalog.sources.every((source) => ["companion", "both"].includes(source.subject))).toBe(true);
  expect(finalCatalog.sources.some((source) => source.quote.includes(admittedKeyword))).toBe(true);
  expect(finalCatalog.sources.some((source) => source.quote.includes(companionKeyword))).toBe(true);
  const excludedSnapshotIds = new Set([
    ...firstFinalization.excludedSnapshotIds,
    ...secondFinalization.excludedSnapshotIds
  ]);
  expect(finalCatalog.sources.every((source) => !excludedSnapshotIds.has(source.evidenceSnapshotId))).toBe(true);
  expect(finalCatalog.sources.every((source) => !source.quote.includes(unknownKeyword))).toBe(true);
  expect(finalCatalog.sources.every((source) => !source.quote.includes(keptKeyword))).toBe(true);

  const admittedCatalogSourceIds = new Set(finalCatalog.sources
    .filter((source) => source.quote.includes(admittedKeyword))
    .map((source) => source.evidenceSnapshotId));
  const catalogSourceIds = new Set(finalCatalog.sources.map((source) => source.evidenceSnapshotId));
  const catalogSubjectById = new Map(finalCatalog.sources.map((source) => [source.evidenceSnapshotId, source.subject]));
  const eligibleAdmittedRecapIds = new Set([firstInteraction, secondInteraction]
    .flatMap((interaction) => interaction.recapItems)
    .filter((item) =>
      item.kind === "moment"
      && item.disposition === "kept"
      && item.evidence.length > 0
      && item.evidence.every((source) => catalogSourceIds.has(source.id))
      && item.evidence.every((source) => catalogSubjectById.get(source.id) === "both")
      && item.evidence.some((source) => admittedCatalogSourceIds.has(source.id))
    )
    .map((item) => item.id));
  expect(eligibleAdmittedRecapIds.size).toBeGreaterThan(0);
  progress(21, 30, "the two-date catalog established the trusted kept companion/both source precondition for future Person QA");

  const searchInput = page.getByRole("searchbox", { name: "关系内关键词" });
  const searchButton = page.getByRole("button", { name: "找一找" });
  await expect(searchInput).toBeVisible();
  await expect(searchButton).toBeDisabled();
  await searchInput.fill(admittedKeyword, { timeout: 20_000 });
  await expect(searchButton).toBeEnabled();
  const keptSearchPromise = page.waitForResponse(
    (response) =>
      response.request().method() === "GET"
      && applicationPath(response.url()) === `/api/date-companion/relationships/${relationshipId}/search`
      && new URL(response.url()).searchParams.get("q") === admittedKeyword,
    { timeout: 20_000 }
  );
  await searchButton.click({ timeout: 20_000 });
  const keptSearchResponse = await keptSearchPromise;
  expect(keptSearchResponse.ok()).toBe(true);
  const keptSearchPayload = await keptSearchResponse.json() as { results: RelationshipSearchResult[] };
  const matchedSearchResult = keptSearchPayload.results.find((result) =>
    eligibleAdmittedRecapIds.has(result.recapItemId)
    && [firstInteraction.id, secondInteraction.id].includes(result.interactionId)
    && result.evidence.length > 0
    && result.evidence.every((source) => catalogSourceIds.has(source.id))
    && result.evidence.every((source) => catalogSubjectById.get(source.id) === "both")
    && result.evidence.some((source) => admittedCatalogSourceIds.has(source.id))
  );
  if (!matchedSearchResult) throw new Error("search did not return an eligible recap backed by the queried catalog source");
  const matchedSearchEvidence = matchedSearchResult.evidence.find((source) =>
    admittedCatalogSourceIds.has(source.id) && source.quote.includes(admittedKeyword)
  );
  if (!matchedSearchEvidence) throw new Error("eligible search result did not preserve its queried Evidence source");
  const searchRegion = page.getByRole("region", { name: "在这段关系里找一找" });
  const searchResultItem = searchRegion.locator("li").filter({ hasText: matchedSearchResult.text }).first();
  await expect(searchResultItem).toBeVisible();
  await expect(searchResultItem.getByText(matchedSearchResult.text, { exact: true })).toBeVisible();
  const evidenceToggle = searchResultItem.locator("summary").filter({ hasText: "核对原话" }).first();
  await expect(evidenceToggle).toBeVisible();
  await evidenceToggle.click({ timeout: 20_000 });
  await expect(searchResultItem.getByText(matchedSearchEvidence.quote, { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: `${artifactDir}/stage2-search-results.png`, fullPage: true });
  progress(22, 30, "relationship search displayed the returned eligible recap and its actually bound Evidence");

  await searchInput.fill(keptKeyword, { timeout: 20_000 });
  await expect(searchButton).toBeEnabled();
  const selfOnlySearchPromise = page.waitForResponse(
    (response) =>
      response.request().method() === "GET"
      && applicationPath(response.url()) === `/api/date-companion/relationships/${relationshipId}/search`
      && new URL(response.url()).searchParams.get("q") === keptKeyword,
    { timeout: 20_000 }
  );
  await searchButton.click({ timeout: 20_000 });
  expect((await selfOnlySearchPromise).ok()).toBe(true);
  await expect(searchRegion.getByText("没有找到已确认内容")).toBeVisible();
  await expect(searchRegion.locator("ul")).toHaveCount(0);
  progress(23, 30, "relationship search kept self-only Evidence outside the Ta projection");

  const excludedIds = new Set([
    ...firstExcludedItems.map((item) => item.id),
    ...secondInteraction.recapItems.filter((item) => item.disposition === "excluded").map((item) => item.id)
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

  await searchInput.fill(absentKeyword, { timeout: 20_000 });
  await expect(searchButton).toBeEnabled();
  const absentSearchPromise = page.waitForResponse(
    (response) =>
      response.request().method() === "GET"
      && applicationPath(response.url()) === `/api/date-companion/relationships/${relationshipId}/search`
      && new URL(response.url()).searchParams.get("q") === absentKeyword,
    { timeout: 20_000 }
  );
  await searchButton.click({ timeout: 20_000 });
  expect((await absentSearchPromise).ok()).toBe(true);
  await expect(searchRegion.getByText("没有找到已确认内容")).toBeVisible();
  await expect(searchRegion.locator("ul")).toHaveCount(0);
  progress(24, 30, "search and the final catalog excluded unknown, self-only, excluded and fabricated content");

  const restoredAudit: NetworkAudit = {
    externalRequests: [],
    order: [],
    cacheAtImport: new Map(),
    cleanupHeaders: new Map(),
    subjectSuggestionMethods: []
  };
  const restoredContext = await createGuardedContext(browser, restoredAudit);
  const restoredPage = await restoredContext.newPage();
  await login(restoredPage, firstEmail);
  await restoredPage.goto("/date-companion/a/person", { timeout: 20_000, waitUntil: "domcontentloaded" });
  await expect(restoredPage).toHaveURL(/\/date-companion\/a\/person$/u, { timeout: 20_000 });
  await expect(restoredPage.getByRole("heading", { name: "Ta", exact: true })).toBeVisible();
  const restoredPersonProjection = restoredPage.getByRole("region", { name: "关于 Ta 的四类内容" });
  await expect(restoredPersonProjection.getByText(admittedKeyword, { exact: false }).first()).toBeVisible();
  await expect(restoredPersonProjection.getByText(keptKeyword, { exact: false })).toHaveCount(0);
  await expect(restoredPersonProjection.getByText(unknownKeyword, { exact: false })).toHaveCount(0);
  await expect(restoredPersonProjection.getByText(absentKeyword, { exact: false })).toHaveCount(0);
  const restoredHistory = restoredPage.locator("section").filter({
    has: restoredPage.getByRole("heading", { name: "一起走过的几次" })
  });
  await expect(restoredHistory.locator("ol > li")).toHaveCount(2);
  await restoredPage.goto(`/date-companion/a/recap?interaction=${firstUpload.imported.interactionId}`, {
    timeout: 20_000,
    waitUntil: "domcontentloaded"
  });
  await expect(restoredPage).toHaveURL(
    new RegExp(`/date-companion/a/recap\\?interaction=${firstUpload.imported.interactionId}$`, "u"),
    { timeout: 20_000 }
  );
  await expect(restoredPage.getByRole("heading", { name: "这次录音里的说话人" })).toBeVisible();
  await expect(restoredPage.getByText(/这台设备没有完整文字稿/u)).toBeVisible();
  await expect(restoredPage.getByRole("button", { name: "查看完整文字稿" })).toHaveCount(0);
  progress(25, 30, "a new browser context restored only the two admitted relationship interactions from server state");
  progress(26, 30, "the new context still opened an Evidence-only recap without a broken full-transcript action");

  await registerFixtureUser(baseURL, secondEmail, "Other Fixture User");
  const isolatedAudit: NetworkAudit = {
    externalRequests: [],
    order: [],
    cacheAtImport: new Map(),
    cleanupHeaders: new Map(),
    subjectSuggestionMethods: []
  };
  const isolatedContext = await createGuardedContext(browser, isolatedAudit);
  const isolatedPage = await isolatedContext.newPage();
  await login(isolatedPage, secondEmail);
  await isolatedPage.goto("/date-companion/a", { timeout: 20_000, waitUntil: "domcontentloaded" });
  await expect(isolatedPage).toHaveURL(/\/date-companion\/a$/u, { timeout: 20_000 });
  await expect(isolatedPage.getByRole("heading", { name: "你想怎样称呼 Ta？" })).toBeVisible();
  const otherRelationships = await isolatedPage.request.get("/api/date-companion/relationships");
  expect(otherRelationships.ok()).toBe(true);
  expect(await otherRelationships.json()).toEqual({ relationships: [] });
  const crossUserView = await isolatedPage.request.get(`/api/date-companion/relationships/${relationshipId}/view`);
  expect(crossUserView.status()).toBe(404);
  const crossUserMapping = await isolatedPage.request.get(
    `/api/date-companion/relationships/${relationshipId}/person-mapping`
  );
  expect(crossUserMapping.status()).toBe(404);
  const crossUserCatalog = await isolatedPage.request.get(
    `/api/date-companion/relationships/${relationshipId}/person-source-catalog`
  );
  expect(crossUserCatalog.status()).toBe(404);
  const crossUserSearch = await isolatedPage.request.get(
    `/api/date-companion/relationships/${relationshipId}/search?q=${encodeURIComponent(admittedKeyword)}`
  );
  expect(crossUserSearch.status()).toBe(404);
  const crossUserPerson = await isolatedPage.request.get(
    `/api/people/${people.mapping.companionPersonId}/memories`
  );
  expect(crossUserPerson.status()).toBe(404);
  const crossUserSubjectStatus = await isolatedPage.evaluate(async (interactionId) => {
    const response = await fetch(
      `/api/date-companion/interactions/${interactionId}/subject-suggestions`,
      { method: "GET", credentials: "same-origin", cache: "no-store" }
    );
    return response.status;
  }, firstUpload.imported.interactionId);
  expect(crossUserSubjectStatus).toBe(404);
  const crossUserSpeakerId = firstDraftInteraction.participants[0]?.speakerId;
  if (!crossUserSpeakerId) throw new Error("first fixture interaction has no participant for the isolation check");
  const crossUserAudio = await isolatedPage.request.get(
    `/api/date-companion/interactions/${firstUpload.imported.interactionId}/participants/${crossUserSpeakerId}/audio`
  );
  expect(crossUserAudio.status()).toBe(404);
  progress(27, 30, "another user saw no relationship and cross-user view, mapping, catalog, search, person, Subject batch and audio IDs returned 404");

  await isolatedContext.close();
  await restoredContext.close();
  await context.close();
  expect(primaryAudit.externalRequests).toEqual([]);
  expect(restoredAudit.externalRequests).toEqual([]);
  expect(isolatedAudit.externalRequests).toEqual([]);
  expect(primaryAudit.subjectSuggestionMethods.length).toBeGreaterThanOrEqual(2);
  expect(primaryAudit.subjectSuggestionMethods.every((method) => method === "GET")).toBe(true);
  expect(restoredAudit.subjectSuggestionMethods.every((method) => method === "GET")).toBe(true);
  expect(isolatedAudit.subjectSuggestionMethods).toContain("GET");
  expect(isolatedAudit.subjectSuggestionMethods.every((method) => method === "GET")).toBe(true);
  progress(28, 30, "all three browser contexts closed before their captured non-loopback request counts were asserted as zero");
  progress(29, 30, "auth, Person confirmation, self binding, relationship mapping and retention default GET were never mocked");
  progress(30, 30, "upload, Pipeline, polling, Day, import and browser-cache DELETE APIs were never mocked");
  progress(31, 30, "participant, recap, promise, search and person source APIs were never mocked");
  progress(32, 30, "both Bridge jobs used the production consumer against the isolated Date Companion and Memory SQLite files");
  progress(33, 30, "both uploads retained fixed Evidence and playable speaker audio snapshots after server cleanup");
  progress(34, 30, "speaker aliases and provider labels were not used as identity proof");
  progress(35, 30, "unresolved, excluded, unknown-subject and self-only content stayed outside Ta surfaces");
  progress(36, 30, "Person QA transport was intentionally not invoked; only its trusted-source preconditions were verified");
  progress(37, 30, "fixture transcription used the fixed office sample and synthetic silent transport audio, not dating-content or voice-quality evidence");
  progress(38, 30, `screenshots saved under ${artifactDir}`);

  progress(39, 30, "the closed-context browser audit remained stable and contained no external URL");
  progress(40, 30, "two-date strict-admission browser closure complete");
  progress(41, 30, "the server used fixture/rule/none providers while Subject batches were preseeded through the injected deterministic provider seam; this is configuration/log evidence, not packet capture");
  progress(42, 30, "Stage 2 current strict-admission gate complete");
});
