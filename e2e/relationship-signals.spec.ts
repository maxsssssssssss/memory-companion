import { expect, test, type Page } from "@playwright/test";

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

function dayPayload(relationshipSignals: unknown[]) {
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

async function routeAppApis(page: Page, relationshipSignals: unknown[]) {
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
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(settingsPayload())
    })
  );
  await page.route("**/api/uploads/latest", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ uploadId: "upload_e2e" })
    })
  );
  await page.route("**/api/uploads/dates", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ dates: ["2026-07-09"] })
    })
  );
  await page.route("**/api/uploads/by-date?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ uploadId: "upload_e2e", uploadIds: ["upload_e2e"], recordingDate: "2026-07-09" })
    })
  );
  await page.route("**/api/days/upload_e2e", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(dayPayload(relationshipSignals))
    })
  );
}

test("renders relationship signal card details", async ({ page }) => {
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

  await page.goto("/");

  const section = page.locator(".relationship-signal-section");
  await expect(section).toBeVisible();
  await expect(section.locator(".relationship-signal-card")).toHaveCount(1);
  await expect(section.getByText("边界表达被温和接住。")).toBeVisible();
  await section.locator("summary").click();
  await expect(section.getByText("我想表达一个边界，今晚需要自己休息。")).toBeVisible();
});

test("renders relationship signal empty state without cards", async ({ page }) => {
  await routeAppApis(page, []);

  await page.goto("/");

  const section = page.locator(".relationship-signal-section");
  await expect(section).toBeVisible();
  await expect(section.locator(".relationship-signal-card")).toHaveCount(0);
});
