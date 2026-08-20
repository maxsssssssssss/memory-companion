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
      return fulfill(route, { view: relationshipView });
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
    if (url.pathname === "/api/date-companion/relationships/relationship_1/retained-memory" && method === "DELETE") {
      return fulfill(route, { purge: { purgeId: "purge_1", status: "completed", totalCount: 1, completedCount: 1, failedCount: 0, retryable: false, updatedAt: now } });
    }
    return fulfill(route, { error: `unexpected_fixture_request:${method}:${url.pathname}` }, 500);
  });
  return {
    getAuthCount: () => authCount,
    getSyncBody: () => syncBody,
    getSubjectSuggestionGetCount: () => subjectSuggestionGetCount,
    getSubjectSuggestionPostCount: () => subjectSuggestionPostCount
  };
}

test("Memory bridge UI wiring uses deterministic server-shaped fixture data", async ({ page }) => {
  const fixture = await installFixture(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/date-companion/a/people");
  await expect(page.getByRole("heading", { name: "由你确认，谁是我，谁是 Ta" })).toBeVisible();
  await expect(page.getByLabel("我")).toHaveValue("person_self");
  await expect(page.getByLabel("我").locator("option")).toHaveCount(3);
  expect(await page.getByLabel("我").locator("option").nth(1).textContent()).toContain("人物号");
  await expect(page.getByText("尚未选择长期保留")).toBeVisible();
  await page.screenshot({ path: resolve(artifactDir, "people-1920x1080.png"), fullPage: true });

  await page.getByRole("link", { name: "关于 Ta" }).click();
  await expect(page).toHaveURL(/\/date-companion\/a\/person$/u);
  const rememberedCard = page.locator("#profile-card-remembered");
  await expect(rememberedCard.getByText("Ta 想一起去看展。")).toBeVisible();
  await page.getByRole("button", { name: "你记得的 Ta" }).click();
  await rememberedCard.getByText("核对原话 · 1").click();
  await expect(rememberedCard.getByText(oldEvidence.quote)).toBeVisible();
  await page.screenshot({ path: resolve(artifactDir, "person-relationship-only-1920x1080.png"), fullPage: true });

  await page.goto("/date-companion/a/people");

  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.getByRole("button", { name: "准备删除" }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "准备删除" }).click();
  await expect(page.getByRole("button", { name: "确认删除已保留内容" })).toBeVisible();
  await page.screenshot({ path: resolve(artifactDir, "people-delete-confirm-2560x1440.png"), fullPage: true });

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/date-companion/a/recap?interaction=interaction_review");
  await expect(page.getByText("已经整理好", { exact: true })).toBeVisible();
  const subjectSummary = page.getByLabel("内容范围统计");
  await expect(subjectSummary).toContainText("关于 Ta 1");
  await expect(page.getByText("这条原话主要关于谁？")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "关于 Ta", exact: true })).toHaveCount(0);
  await page.getByText("查看每条归属", { exact: true }).click();
  const sourceSubject = page.getByLabel("Ta 说起了什么第 1 条原话的内容范围");
  await expect(sourceSubject).toContainText("关于 Ta");
  await expect(sourceSubject.locator("..")).toContainText(reviewEvidence.quote);
  await subjectSummary.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(artifactDir, "recap-subject-1920x1080.png"), fullPage: true });

  await page.getByRole("button", { name: "接受以上归属并开始整理" }).click();
  await expect(page.getByText("等待整理").last()).toBeVisible();
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

  expect(fixture.getAuthCount()).toBe(3); // Three full page.goto calls; the People -> Person switch remains Provider-owned.
});
