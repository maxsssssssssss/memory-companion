import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const artifactDir = resolve(process.env.DATE_COMPANION_E2E_ARTIFACT_DIR ?? "output/playwright/date-companion-home-content");
const now = "2026-09-08T08:00:00.000Z";
const recordingDate = "2026-09-07";
const userId = "home_fixture_user";
const uploadId = "upload_home_fixture";
const relationshipId = "relationship_home_fixture";
const interactionId = "interaction_home_fixture";
const rawTranscript = "嗯你看这个，然后那个镜头太近了，咖啡豆炒牛舌，就是这个，然后怎么说呢。";
const aboutText = "Love 最近在准备摄影展。";
const beforeText = "可以问问展览的照片选得怎么样了。";
const setting = { enabled: true, version: 1, createdAt: now, updatedAt: now, enabledAt: now, disabledAt: null };
const mapping = { id: "home_mapping", selfPersonId: "home_self", companionPersonId: "home_ta", relationshipType: "dating", status: "confirmed", version: 2, confirmedAt: now, createdAt: now, updatedAt: now };
const people = [
  { id: "home_self", displayName: "我", status: "confirmed", version: 1, explicitlyConfirmed: true, confirmedAt: now, createdAt: now, updatedAt: now },
  { id: "home_ta", displayName: "Love", status: "confirmed", version: 1, explicitlyConfirmed: true, confirmedAt: now, createdAt: now, updatedAt: now }
];
const evidence = [
  { id: "home_evidence_about", recapItemId: "home_recap_about", uploadId, sourceSegmentId: "home_segment_about", startSeconds: 10, endSeconds: 15, speakerId: "home_speaker_ta", quote: "我最近正在准备摄影展。", contentDigest: "a".repeat(64), createdAt: now },
  { id: "home_evidence_before", recapItemId: "home_recap_before", uploadId, sourceSegmentId: "home_segment_before", startSeconds: 20, endSeconds: 25, speakerId: "home_speaker_ta", quote: "这次展览的照片还没选好。", contentDigest: "b".repeat(64), createdAt: now }
];
const relationship = { id: relationshipId, displayName: "Love", status: "active", version: 1, createdAt: now, updatedAt: now };
const interaction = {
  id: interactionId, relationshipId, sourceUploadId: uploadId, recordingDate, originalName: "首页测试录音.m4a", durationSeconds: 60,
  status: "confirmed", sourceState: "server_cleaned", version: 2, createdAt: now, updatedAt: now, confirmedAt: now,
  participants: [{ speakerId: "home_speaker_ta", role: "companion", confirmedAt: now }],
  recapItems: evidence.map((source, index) => ({
    id: source.recapItemId, interactionId, kind: "mentioned", proposedText: rawTranscript, displayedText: rawTranscript,
    disposition: "kept", version: 1, sortOrder: index, evidence: [source]
  })),
  memoryBridge: { status: "completed", attemptCount: 1, updatedAt: now, retryable: false }
};
const payload = {
  upload: { id: uploadId, originalName: interaction.originalName, mimeType: "audio/mp4", sizeBytes: 1000, recordingDate, createdAt: now, status: "ready", durationSeconds: 60 },
  job: { id: "home_job", uploadId, status: "ready", progress: 100 },
  segments: evidence.map((source) => ({
    id: source.sourceSegmentId, uploadId, startSeconds: source.startSeconds, endSeconds: source.endSeconds,
    speaker: source.speakerId, text: source.quote, confidence: 0.95, sceneLabels: ["unknown"], valueLabels: []
  })),
  audioInsights: [], semanticSegments: [], semanticSegmentsAvailable: true, briefItems: [], relationshipSignals: [],
  relationshipSignalsAvailable: true, proactiveInsights: [], proactiveInsightsAvailable: true, speakerAliases: {}
};

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify(body) });
}

async function installFixture(page: Page) {
  let mode: "ready" | "empty" | "failure" = "ready";
  const unexpectedRequests: string[] = [];
  const externalRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      externalRequests.push(url.origin);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  await page.addInitScript(({ userId, payload }) => {
    localStorage.setItem("daily-brief:active-user-id", userId);
    localStorage.setItem(`daily-brief:${userId}:local-day:${payload.upload.id}`, JSON.stringify(payload));
    localStorage.setItem(`daily-brief:${userId}:local-day-index`, JSON.stringify([{
      uploadId: payload.upload.id, recordingDate: payload.upload.recordingDate,
      originalName: payload.upload.originalName, createdAt: payload.upload.createdAt
    }]));
  }, { userId, payload });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method !== "GET") {
      unexpectedRequests.push(`${method} ${path}`);
      return fulfill(route, { error: "unexpected_fixture_mutation" }, 500);
    }
    if (path === "/api/auth/me") return fulfill(route, { user: { id: userId, email: "home-fixture@example.com" } });
    if (path === "/api/date-companion/relationships") return fulfill(route, { relationships: [relationship] });
    if (path === `/api/date-companion/relationships/${relationshipId}/view`) return fulfill(route, { view: { relationship, interactions: [interaction], promises: [] } });
    if (path === "/api/people") return fulfill(route, { people });
    if (path === "/api/people/self") return fulfill(route, { selfBinding: { personId: "home_self", status: "active", version: 1, setAt: now, clearedAt: null, updatedAt: now } });
    if (path === "/api/people/home_self/memories") return fulfill(route, { person: people[0], memories: [] });
    if (path === "/api/people/home_ta/memories") return fulfill(route, { person: people[1], memories: [] });
    if (path === `/api/date-companion/relationships/${relationshipId}/memory-review`) return fulfill(route, {
      review: { retention: setting, mapping, interactions: [{ interactionId, sourceUploadId: uploadId, recordingDate, sourceState: "server_cleaned", status: "completed", attemptCount: 1, selectionCount: 2, unknownCount: 0, updatedAt: now }] }
    });
    if (path === `/api/date-companion/relationships/${relationshipId}/person-source-catalog`) return fulfill(route, {
      relationshipId, companionPersonId: "home_ta", mappingVersion: 2, status: "ready",
      sources: evidence.map((source) => ({
        evidenceSnapshotId: source.id, interactionId, uploadId, sourceSegmentId: source.sourceSegmentId,
        recordingDate, startSeconds: source.startSeconds, endSeconds: source.endSeconds,
        speakerId: source.speakerId, quote: source.quote, contentDigest: source.contentDigest, subject: "companion"
      }))
    });
    if (path === `/api/date-companion/relationships/${relationshipId}/proactive-value`) {
      if (mode === "failure") return fulfill(route, { error: "home_fixture_generation_unavailable" }, 503);
      return fulfill(route, {
        schemaVersion: 2, scope: "person_relationship", relationshipId, personId: "home_ta", mappingVersion: 2,
        status: "ready", sourceFingerprint: "c".repeat(64), cacheHit: false,
        value: mode === "empty" ? { home: { about: [], beforeMeeting: [] }, evidenceIds: [] } : {
          home: {
            about: [{ kind: "recent_update", text: aboutText, evidenceIds: [evidence[0].id] }],
            beforeMeeting: [{ kind: "follow_up", text: beforeText, reason: "Ta 上次说还在挑选参展照片。", evidenceIds: [evidence[1].id] }]
          }, evidenceIds: evidence.map((source) => source.id)
        },
        evidenceReferences: mode === "empty" ? [] : evidence.map((source) => ({
          evidenceId: source.id, uploadId, sourceSegmentId: source.sourceSegmentId, recordingDate,
          startSeconds: source.startSeconds, endSeconds: source.endSeconds, speakerId: source.speakerId,
          quote: source.quote, contentDigest: source.contentDigest, origin: "direct_conversation", subject: "companion"
        }))
      });
    }
    if (path === `/api/date-companion/interactions/${interactionId}/proactive-value`) return fulfill(route, {
      schemaVersion: 2, scope: "current_interaction", relationshipId, interactionId, mappingVersion: 2,
      status: "unavailable", cacheHit: false, evidenceReferences: []
    });
    if (path === `/api/date-companion/interactions/${interactionId}/participants/home_speaker_ta/audio`) {
      return fulfill(route, { error: "participant_audio_unavailable" }, 404);
    }
    unexpectedRequests.push(`${method} ${path}`);
    return fulfill(route, { error: "unexpected_fixture_request" }, 500);
  });
  return { setMode: (next: typeof mode) => { mode = next; }, unexpectedRequests, externalRequests, pageErrors };
}

for (const viewport of [{ width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
  test(`generated home content at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await mkdir(artifactDir, { recursive: true });
    const fixture = await installFixture(page);
    await page.setViewportSize(viewport);
    const label = `${viewport.width}x${viewport.height}`;
    console.log(`[home-content-${label}] 0/4 opening fixture home`);
    await page.goto("/date-companion/a");
    const about = page.getByRole("region", { name: "关于 Love 的首页摘要" });
    const before = page.getByRole("region", { name: "下次见面前的首页建议" });
    await expect(about.getByText(aboutText, { exact: true })).toBeVisible();
    await expect(before.getByText(beforeText, { exact: true })).toBeVisible();
    await expect(about.getByText(beforeText, { exact: true })).toHaveCount(0);
    await expect(before.getByText(aboutText, { exact: true })).toHaveCount(0);
    await expect(page.getByText(rawTranscript, { exact: true })).toHaveCount(0);
    await expect(about.getByText(evidence[0].quote, { exact: true })).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(artifactDir, `home-ready-${label}.png`), fullPage: true });
    console.log(`[home-content-${label}] 1/4 distinct summaries and viewport verified`);

    await before.getByText("查看原话", { exact: true }).click();
    await expect(before.getByText(evidence[1].quote, { exact: true })).toBeVisible();
    await expect(before.getByText(evidence[0].quote, { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(artifactDir, `home-source-${label}.png`), fullPage: true });
    await before.getByRole("button", { name: "在完整文字稿中查看" }).click();
    await expect(page).toHaveURL(/\/date-companion\/a\/recap\?segment=home_segment_before#full-transcript$/u);
    await expect(page.locator("#full-transcript")).toBeVisible();
    await expect(page.locator("#full-transcript").getByText(evidence[1].quote, { exact: true })).toBeVisible();
    console.log(`[home-content-${label}] 2/4 canonical source opened in transcript`);

    fixture.setMode("empty");
    await page.goto("/date-companion/a");
    await expect(about.getByText("还没有适合放在这里的近况。", { exact: true })).toBeVisible();
    await expect(before.getByText("暂时没有需要跟进的事。", { exact: true })).toBeVisible();
    await expect(page.getByText(rawTranscript, { exact: true })).toHaveCount(0);
    await expect(page.getByText(aboutText, { exact: true })).toHaveCount(0);
    await page.screenshot({ path: resolve(artifactDir, `home-empty-${label}.png`), fullPage: true });
    console.log(`[home-content-${label}] 3/4 empty result has no transcript fallback`);

    fixture.setMode("failure");
    await page.reload();
    await expect(about.getByText("近况暂时未能整理，请稍后再看。", { exact: true })).toBeVisible();
    await expect(before.getByText("见面前的建议暂时未能整理，请稍后再看。", { exact: true })).toBeVisible();
    await expect(page.getByText(rawTranscript, { exact: true })).toHaveCount(0);
    await expect(page.getByText(beforeText, { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(artifactDir, `home-failure-${label}.png`), fullPage: true });
    expect(fixture.unexpectedRequests).toEqual([]);
    expect(fixture.externalRequests).toEqual([]);
    expect(fixture.pageErrors).toEqual([]);
    console.log(`[home-content-${label}] 4/4 failure remains empty; all API requests mocked`);
  });
}
