import { spawn } from "node:child_process";
import { chromium } from "playwright";

const port = Number(process.env.E2E_PORT || 3210);
const baseURL = `http://127.0.0.1:${port}`;

function startNextServer() {
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.output = "";
  const capture = (chunk) => {
    child.output += chunk.toString();
    if (child.output.length > 12000) {
      child.output = child.output.slice(-12000);
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return child;
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer() {
  const deadline = Date.now() + 120000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseURL);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(1000);
  }
  throw new Error(`Timed out waiting for ${baseURL}: ${lastError?.message ?? "unknown error"}`);
}

function settingsPayload() {
  return {
    apiKeyMode: "default",
    hasCustomApiKey: false,
    defaultApiKeyAvailable: true,
    activeApiKeySource: "default",
    providerDisplayName: "OpenAI compatible",
    storageMode: "server",
    canOpenDataFolder: false,
    dataDirectory: ".data",
    uploadsDirectory: ".data/uploads",
    apiKeyStoragePath: ".data/settings/provider-config.json",
    qaPromptPresetId: "date",
    customQaPrompt: "",
    qaPromptPresets: []
  };
}

function dayPayload(relationshipSignals) {
  return {
    upload: {
      id: "upload_e2e",
      originalName: "relationship_fixture.wav",
      mimeType: "audio/wav",
      sizeBytes: 1024,
      recordingDate: "2026-07-09",
      createdAt: "2026-07-09T00:00:00.000Z",
      status: "ready",
      durationSeconds: 72
    },
    job: {
      id: "job_e2e",
      uploadId: "upload_e2e",
      status: "ready",
      progress: 100
    },
    segments: [
      {
        id: "seg_1",
        uploadId: "upload_e2e",
        startSeconds: 0,
        endSeconds: 10,
        speaker: "speaker_1",
        text: "我想表达一个边界，今晚需要自己休息。",
        confidence: 0.9,
        sceneLabels: ["unknown"],
        valueLabels: []
      }
    ],
    audioInsights: [],
    semanticSegments: [],
    semanticSegmentsAvailable: true,
    briefItems: [],
    relationshipSignals,
    relationshipSignalsAvailable: true,
    speakerAliases: {},
    speakerAliasesByUploadId: {
      upload_e2e: {}
    }
  };
}

async function routeAppApis(page, relationshipSignals) {
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "user_e2e", email: "e2e@example.com", name: "E2E" }
      })
    })
  );
  await page.route("**/api/settings", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(settingsPayload()) })
  );
  await page.route("**/api/uploads/latest", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ uploadId: "upload_e2e" }) })
  );
  await page.route("**/api/uploads/dates", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dates: ["2026-07-09"] }) })
  );
  await page.route("**/api/uploads/by-date?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ uploadId: "upload_e2e", uploadIds: ["upload_e2e"], recordingDate: "2026-07-09" })
    })
  );
  await page.route("**/api/days/upload_e2e", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dayPayload(relationshipSignals)) })
  );
}

async function assertRelationshipCardState(page) {
  await routeAppApis(page, [
    {
      id: "relationship_signal_upload_e2e_1",
      uploadId: "upload_e2e",
      date: "2026-07-09",
      signalType: "boundary_respect",
      signalCategory: "positive",
      severity: "low",
      confidence: 0.72,
      summary: "边界表达被温和接住。",
      explanation: "这只说明当前片段里出现了尊重边界的回应，不代表长期关系结论。",
      involvedSpeakers: ["speaker_1"],
      timeRange: { startSeconds: 0, endSeconds: 10 },
      evidenceSegments: [
        {
          segmentId: "seg_1",
          speaker: "speaker_1",
          startSeconds: 0,
          endSeconds: 10,
          text: "我想表达一个边界，今晚需要自己休息。"
        }
      ],
      textEvidence: ["我想表达一个边界"],
      suggestedReflection: "可以观察这种尊重边界的回应是否稳定出现。",
      createdAt: "2026-07-09T00:00:00.000Z"
    }
  ]);
  await page.goto(baseURL);
  await page.waitForSelector(".relationship-signal-section", { state: "visible" });
  const cardCount = await page.locator(".relationship-signal-card").count();
  if (cardCount !== 1) {
    throw new Error(`Expected one relationship signal card, got ${cardCount}`);
  }
  await page.locator(".relationship-signal-card h4").filter({ hasText: "边界表达被温和接住。" }).waitFor({ state: "visible" });
  await page.locator(".relationship-signal-details summary").click();
  await page.getByText("我想表达一个边界，今晚需要自己休息。").waitFor({ state: "visible" });
}

async function assertRelationshipEmptyState(page) {
  await routeAppApis(page, []);
  await page.goto(baseURL);
  await page.waitForSelector(".relationship-signal-section", { state: "visible" });
  const cardCount = await page.locator(".relationship-signal-card").count();
  if (cardCount !== 0) {
    throw new Error(`Expected no relationship signal cards, got ${cardCount}`);
  }
}

const server = startNextServer();
let browser;

try {
  await waitForServer();
  browser = await chromium.launch();
  const pageWithCard = await browser.newPage();
  await assertRelationshipCardState(pageWithCard);
  await pageWithCard.close();

  const pageEmpty = await browser.newPage();
  await assertRelationshipEmptyState(pageEmpty);
  await pageEmpty.close();

  console.log(JSON.stringify({ ok: true, tests: ["relationship card state", "relationship empty state"] }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, serverOutput: server.output }, null, 2));
  process.exitCode = 1;
} finally {
  if (browser) {
    await browser.close();
  }
  server.kill();
}
