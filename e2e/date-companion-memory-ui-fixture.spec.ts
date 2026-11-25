import { expect, test, type Page, type Route } from "@playwright/test";
import { resolve } from "node:path";

const now = "2026-08-11T10:00:00.000Z";
const artifactDir = resolve(process.env.DATE_COMPANION_E2E_ARTIFACT_DIR ?? "test-results/date-companion-memory-ui");
const setting = { enabled: true, version: 1, createdAt: now, updatedAt: now, enabledAt: now, disabledAt: null };
const mapping = { id: "mapping_1", selfPersonId: "person_self", companionPersonId: "person_ta", relationshipType: "dating", status: "confirmed", version: 2, confirmedAt: now, createdAt: now, updatedAt: now };
const people = [
  { id: "person_self", displayName: "林澄", status: "confirmed", version: 2, explicitlyConfirmed: true, confirmedAt: now, createdAt: now, updatedAt: now },
  { id: "person_ta", displayName: "林澄", status: "confirmed", version: 3, explicitlyConfirmed: true, confirmedAt: now, createdAt: now, updatedAt: now }
];

function evidence(id: string, recapItemId: string, uploadId: string, sourceSegmentId: string, speakerId: string, quote: string) {
  return {
    id,
    recapItemId,
    uploadId,
    sourceSegmentId,
    startSeconds: 10,
    endSeconds: 15,
    speakerId,
    quote,
    contentDigest: "e".repeat(64),
    createdAt: now
  };
}

const oldEvidence = evidence("evidence_old", "recap_old", "upload_old", "segment_old", "speaker_1", "我们说好下个月一起去看展。");
const reviewEvidence = evidence("evidence_review", "recap_review", "upload_review", "segment_review", "speaker_1", "我最近在准备一次重要的考试。");
const reviewSubjectBatch = {
  batchId: "batch_review",
  interactionId: "interaction_review",
  interactionVersion: 3,
  mappingVersion: 2,
  evidenceDigest: "a".repeat(64),
  proposalDigest: "b".repeat(64),
  confirmationFingerprint: "c".repeat(64),
  model: "Qwen/Qwen3.6-27B",
  status: "ready",
  suggestions: [{
    canonicalSourceKey: "d".repeat(64),
    uploadId: reviewEvidence.uploadId,
    sourceSegmentId: reviewEvidence.sourceSegmentId,
    contentDigest: reviewEvidence.contentDigest,
    recapItemIds: ["recap_review"],
    evidenceSnapshotIds: [reviewEvidence.id],
    proposedSubject: "companion",
    confidence: 0.96,
    reasonCode: "explicit_companion_reference"
  }],
  createdAt: now
} as const;
const relationshipView = {
  relationship: { id: "relationship_1", displayName: "Ta", status: "active", version: 1, createdAt: now, updatedAt: now },
  interactions: [
    {
      id: "interaction_old", relationshipId: "relationship_1", sourceUploadId: "upload_old", recordingDate: "2026-08-01", originalName: "八月初的散步.m4a", durationSeconds: 1800,
      status: "confirmed", sourceState: "server_cleaned", version: 2, createdAt: now, updatedAt: now, confirmedAt: now,
      participants: [{ speakerId: "speaker_1", role: "companion", confirmedAt: now }],
      recapItems: [{ id: "recap_old", interactionId: "interaction_old", kind: "mentioned", proposedText: "Ta 想一起去看展。", displayedText: "Ta 想一起去看展。", disposition: "kept", version: 1, sortOrder: 0, evidence: [oldEvidence] }],
      memoryBridge: { status: "completed", attemptCount: 1, updatedAt: now, retryable: false }
    },
    {
      id: "interaction_review", relationshipId: "relationship_1", sourceUploadId: "upload_review", recordingDate: "2026-08-10", originalName: "周末晚餐.m4a", durationSeconds: 2700,
      status: "confirmed", sourceState: "server_cleaned", version: 3, createdAt: now, updatedAt: now, confirmedAt: now,
      participants: [{ speakerId: "speaker_1", role: "companion", confirmedAt: now }],
      recapItems: [{ id: "recap_review", interactionId: "interaction_review", kind: "mentioned", proposedText: "Ta 正在准备一次重要考试。", displayedText: "Ta 正在准备一次重要考试。", disposition: "kept", version: 1, sortOrder: 0, evidence: [reviewEvidence] }]
    }
  ],
  promises: []
};

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify(body) });
}

async function installFixture(page: Page) {
  let reviewStatus = "not_queued";
  let syncBody: unknown = null;
  let authCount = 0;
  let subjectSuggestionGetCount = 0;
  let subjectSuggestionPostCount = 0;
  const unexpected: string[] = [];
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? route.continue() : route.abort("blockedbyclient");
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/auth/me" && method === "GET") {
      authCount += 1;
      return fulfill(route, { user: { id: "user_1", email: "fixture@example.com" } });
    }
    if (url.pathname === "/api/date-companion/relationships" && method === "GET") {
      return fulfill(route, { relationships: [relationshipView.relationship] });
    }
    if (url.pathname === "/api/date-companion/relationships/relationship_1/view" && method === "GET") {
      if (url.searchParams.get("scope") === "summary") {
        return fulfill(route, { summary: { ...relationshipView, interactions: relationshipView.interactions.map(({ recapItems, ...interaction }) =>
          ({ ...interaction, promiseRecapItems: recapItems.filter(item => item.kind === "promise") })) } });
      }
      return fulfill(route, { view: relationshipView });
    }
    if (method === "GET") {
      const detail = relationshipView.interactions.find(interaction => url.pathname === `/api/date-companion/interactions/${interaction.id}`);
      if (detail) return fulfill(route, { interaction: detail });
    }
    if (url.pathname === "/api/people" && method === "GET") return fulfill(route, { people });
    if (url.pathname === "/api/people/self" && method === "GET") {
      return fulfill(route, { selfBinding: { personId: "person_self", status: "active", version: 1, setAt: now, clearedAt: null, updatedAt: now } });
    }
    if (url.pathname === "/api/date-companion/relationships/relationship_1/memory-review" && method === "GET") {
      return fulfill(route, { review: { retention: setting, mapping, interactions: [
        { interactionId: "interaction_review", sourceUploadId: "upload_review", recordingDate: "2026-08-10", sourceState: "server_cleaned", status: reviewStatus, attemptCount: 0, selectionCount: reviewStatus === "not_queued" ? 0 : 1, unknownCount: 0, updatedAt: reviewStatus === "not_queued" ? null : now },
        { interactionId: "interaction_old", sourceUploadId: "upload_old", recordingDate: "2026-08-01", sourceState: "server_cleaned", status: "completed", attemptCount: 1, selectionCount: 1, unknownCount: 0, updatedAt: now }
      ] } });
    }
    if (url.pathname === "/api/date-companion/relationships/relationship_1/person-source-catalog" && method === "GET") {
      return fulfill(route, {
        relationshipId: "relationship_1",
        companionPersonId: "person_ta",
        mappingVersion: 2,
        status: "ready",
        sources: [{
          evidenceSnapshotId: oldEvidence.id,
          interactionId: "interaction_old",
          uploadId: oldEvidence.uploadId,
          sourceSegmentId: oldEvidence.sourceSegmentId,
          recordingDate: "2026-08-01",
          startSeconds: oldEvidence.startSeconds,
          endSeconds: oldEvidence.endSeconds,
          speakerId: oldEvidence.speakerId,
          quote: oldEvidence.quote,
          contentDigest: oldEvidence.contentDigest,
          subject: "both"
        }]
      });
    }
    if (url.pathname === "/api/people/person_self/memories" && method === "GET") {
      return fulfill(route, { person: people[0], memories: [] });
    }
    if (url.pathname === "/api/people/person_ta/memories" && method === "GET") {
      return fulfill(route, { person: people[1], memories: [] });
    }
    if (url.pathname === "/api/people/person_ta/timeline" && method === "GET") {
      return fulfill(route, { person: people[1], timeline: [] });
    }
    if (url.pathname === "/api/date-companion/relationships/relationship_1/proactive-value" && method === "GET") {
      return fulfill(route, { schemaVersion: 2, scope: "person_relationship", relationshipId: "relationship_1",
        personId: "person_ta", mappingVersion: 2, status: "unavailable", cacheHit: false, evidenceReferences: [] });
    }
    if (url.pathname === "/api/date-companion/interactions/interaction_review/proactive-value" && method === "GET") {
      return fulfill(route, { schemaVersion: 2, scope: "current_interaction", relationshipId: "relationship_1",
        interactionId: "interaction_review", mappingVersion: 2, status: "unavailable", cacheHit: false, evidenceReferences: [] });
    }
    if (url.pathname === "/api/date-companion/interactions/interaction_review/subject-suggestions") {
      if (method === "GET") {
        subjectSuggestionGetCount += 1;
        return fulfill(route, {
          status: "ready",
          interactionId: reviewSubjectBatch.interactionId,
          interactionVersion: reviewSubjectBatch.interactionVersion,
          mappingVersion: reviewSubjectBatch.mappingVersion,
          evidenceDigest: reviewSubjectBatch.evidenceDigest,
          batch: reviewSubjectBatch
        });
      }
      subjectSuggestionPostCount += 1;
      return fulfill(route, { error: `unexpected_subject_suggestion_mutation:${method}` }, 500);
    }
    if (url.pathname === "/api/date-companion/interactions/interaction_review/memory-sync" && method === "POST") {
      syncBody = route.request().postDataJSON();
      reviewStatus = "pending";
      return fulfill(route, { bridge: { status: "pending", attemptCount: 0, updatedAt: now, retryable: false } });
    }
    if (url.pathname === "/api/date-companion/relationships/relationship_1/retained-memory" && method === "GET") {
      return fulfill(route, { preview: { version: "scope_v1", totalCount: 1, retainedCount: 1, processingCount: 0 } });
    }
    unexpected.push(`${method} ${url.pathname}`);
    return fulfill(route, { error: `unexpected_fixture_request:${method}:${url.pathname}` }, 500);
  });
  return {
    getAuthCount: () => authCount,
    getSyncBody: () => syncBody,
    getSubjectSuggestionGetCount: () => subjectSuggestionGetCount,
    getSubjectSuggestionPostCount: () => subjectSuggestionPostCount,
    unexpected
  };
}

test("Memory bridge UI wiring uses deterministic server-shaped fixture data", async ({ page }) => {
  const fixture = await installFixture(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/date-companion/a/people?section=manage#people-mapping-title");
  await expect(page.getByRole("heading", { name: "确认当前这段关系" })).toBeVisible();
  await expect(page.getByLabel("我")).toHaveValue("person_self");
  await expect(page.getByLabel("我").locator("option")).toHaveCount(3);
  expect(await page.getByLabel("我").locator("option").nth(1).textContent()).toContain("同名人物");
  await expect(page.getByText("尚未选择长期保留")).toBeVisible();
  await page.screenshot({ path: resolve(artifactDir, "people-1920x1080.png"), fullPage: true });

  await page.getByRole("link", { name: "← 全部人物" }).click();
  await page.getByRole("link", { name: /林澄.*当前 Ta/u }).click();
  await expect(page).toHaveURL(/\/date-companion\/a\/people\/person_ta$/u);
  await page.getByRole("link", { name: /^全部经历/u }).click();
  const rememberedCard = page.getByRole("listitem").filter({ hasText: "Ta 想一起去看展。" });
  await rememberedCard.getByRole("button", { name: /查看原话/u }).click();
  await expect(page.getByRole("dialog").getByText(oldEvidence.quote)).toBeVisible();
  await page.screenshot({ path: resolve(artifactDir, "person-relationship-only-1920x1080.png"), fullPage: true });

  await page.goto("/date-companion/a/people?section=manage");

  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.getByRole("button", { name: "查看撤回影响" }).click();
  const withdrawal = page.getByRole("dialog", { name: "撤回这段关系的长期资料？" });
  await expect(withdrawal.getByText("共 1 场 · 已纳入 1 场 · 仅在处理 0 场")).toBeVisible();
  await expect(withdrawal.getByRole("button", { name: "确认撤回长期资料" })).toBeVisible();
  await page.screenshot({ path: resolve(artifactDir, "people-delete-confirm-2560x1440.png"), fullPage: true });

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/date-companion/a/recap?interaction=interaction_review");
  await expect(page.getByRole("heading", { name: "本次复盘已完成" })).toBeVisible();
  await page.getByRole("button", { name: "查看内容与归属" }).click();
  const appendix = page.getByRole("dialog", { name: "长期记忆" });
  await expect(appendix.getByRole("button", { name: "生成归属建议" })).toBeVisible();
  expect(fixture.getSubjectSuggestionGetCount()).toBe(0);
  expect(fixture.getSubjectSuggestionPostCount()).toBe(0);
  expect(fixture.getSyncBody()).toBeNull();
  await appendix.getByRole("button", { name: "生成归属建议" }).click();
  await appendix.getByRole("tab", { name: /Ta.*1/u }).click();
  await expect(appendix.getByRole("tabpanel")).toContainText(reviewEvidence.quote);
  await expect(appendix.getByText("这条原话主要关于谁？")).toHaveCount(0);
  await expect(appendix.getByRole("combobox")).toHaveCount(0);
  expect(fixture.getSyncBody()).toBeNull();
  expect(fixture.getSubjectSuggestionPostCount()).toBe(0);
  await page.screenshot({ path: resolve(artifactDir, "recap-subject-1920x1080.png"), fullPage: true });

  await appendix.getByRole("button", { name: "开始长期整理" }).click();
  await expect(appendix.getByText(/等待整理|后台继续/u).last()).toBeVisible();
  expect(fixture.getSyncBody()).toEqual({
    mappingVersion: 2,
    subjectSuggestionConfirmation: {
      batchId: reviewSubjectBatch.batchId,
      evidenceDigest: reviewSubjectBatch.evidenceDigest,
      proposalDigest: reviewSubjectBatch.proposalDigest,
      confirmationFingerprint: reviewSubjectBatch.confirmationFingerprint,
      confirmedVisibleSuggestions: true
    },
    selections: [{ evidenceSnapshotId: "evidence_review", subject: "companion" }]
  });
  expect(JSON.stringify(fixture.getSyncBody())).not.toContain("quote");
  expect(fixture.getSubjectSuggestionGetCount()).toBeGreaterThanOrEqual(1);
  expect(fixture.getSubjectSuggestionPostCount()).toBe(0);
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.screenshot({ path: resolve(artifactDir, "recap-pending-2560x1440.png"), fullPage: true });

  expect(fixture.getAuthCount()).toBe(3); // Same three full navigations, settings -> person remains provider-owned.
  expect(fixture.unexpected).toEqual([]);
});
