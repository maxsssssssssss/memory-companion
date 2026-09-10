// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { createWorkReviewApi } from "./work-review-api";

const sourceStats = {
  findingCount: 2,
  todoCount: 1,
  confirmedResultCount: 2,
  myTodoCount: 1,
  waitingForOtherTodoCount: 0,
  unresolvedQuestionCount: 1
};

const draft = {
  contractVersion: 1,
  meetingId: "meeting_1",
  accountId: "account_a",
  bodyMarkdown: "# 会后纪要草稿",
  systemSnapshotDigest: "a".repeat(64),
  currentSnapshotDigest: "a".repeat(64),
  stale: false,
  version: 0,
  generatedAt: "2026-09-02T08:00:00.000Z",
  userEditedAt: null,
  updatedAt: "2026-09-02T08:00:00.000Z",
  copySlices: {
    full: "# 会后纪要草稿",
    decisions: "## 最终决定",
    actions: "## 我的待办",
    selectiveSlicesSource: "system_snapshot"
  },
  sourceStats
};

describe("WorkReviewApi V1-4 contracts", () => {
  it("reads server-owned capacity limits and pre-generation follow-up stats", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/work-reviews/config") {
        return Response.json({
          limits: { maxUploadBytes: 314_572_800, maxAudioDurationSeconds: 14_400 }
        });
      }
      return Response.json({ draft: null, sourceStats });
    }) as unknown as typeof fetch;
    const api = createWorkReviewApi(fetchImpl);

    await expect(api.getRuntimeConfig()).resolves.toEqual({
      maxUploadBytes: 314_572_800,
      maxAudioDurationSeconds: 14_400
    });
    await expect(api.getMeetingFollowUp("meeting_1")).resolves.toEqual({
      draft: null,
      sourceStats
    });
  });

  it("uses the exact generate, update, and reset endpoints and mutation bodies", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ draft, reused: false }));
    const api = createWorkReviewApi(fetchImpl as unknown as typeof fetch);

    await api.generateMeetingFollowUp("meeting_1", {
      expectedVersion: null,
      operationKey: "generate_once"
    });
    await api.updateMeetingFollowUp("meeting_1", {
      bodyMarkdown: "# 用户编辑",
      expectedVersion: 0,
      operationKey: "save_once"
    });
    await api.resetMeetingFollowUp("meeting_1", {
      expectedVersion: 1,
      operationKey: "reset_once"
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(1,
      "/api/work-reviews/meetings/meeting_1/follow-up/generate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ expectedVersion: null, operationKey: "generate_once" })
      }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2,
      "/api/work-reviews/meetings/meeting_1/follow-up",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          bodyMarkdown: "# 用户编辑",
          expectedVersion: 0,
          operationKey: "save_once"
        })
      }));
    expect(fetchImpl).toHaveBeenNthCalledWith(3,
      "/api/work-reviews/meetings/meeting_1/follow-up/reset",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ expectedVersion: 1, operationKey: "reset_once" })
      }));
  });

  it("exposes the frozen Project and Weekly Core routes without a parallel client", async () => {
    const summary = {
      meetingCount: 0, findingCount: 0, todoCount: 0, todoEventCount: 0,
      evidenceCount: 0, projectCount: 0, pendingCandidateCount: 0,
      includedFindingCount: 0, includedTodoCount: 0, includedTodoEventCount: 0,
      includedEvidenceCount: 0, omittedFindingCount: 0, omittedTodoCount: 0,
      omittedTodoEventCount: 0, omittedEvidenceCount: 0, truncated: false,
      historyCompleteness: "exact"
    } as const;
    const project = {
      contractVersion: 1, id: "project_1", accountId: "account_a", name: "Alpha",
      description: null, status: "active", version: 0,
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z", archivedAt: null
    } as const;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/work-reviews/config") return Response.json({
        limits: { maxUploadBytes: 1, maxAudioDurationSeconds: 1 },
        capabilities: {
          projects: true, weekly: true, weeklyAi: false,
          weeklyVerifier: false, weeklyQa: false, weeklyQaVerifier: false
        }
      });
      if (path.startsWith("/api/work-reviews/projects?")) {
        return Response.json({ projects: [project] });
      }
      if (path.endsWith("/projects")) return Response.json({
        resourceId: "meeting_1", resourceVersion: 2,
        projects: [{ id: "project_1", name: "Alpha", status: "active", version: 0 }],
        changed: true, reused: false
      });
      return Response.json({ review: null, items: [], sourceSummary: summary });
    });
    const api = createWorkReviewApi(fetchImpl as unknown as typeof fetch);
    await expect(api.getCapabilities()).resolves.toMatchObject({ projects: true, weekly: true });
    await expect(api.listProjects()).resolves.toEqual([project]);
    await expect(api.setMeetingProjects("meeting_1", {
      operationKey: "set_projects", expectedVersion: 1, projectIds: ["project_1"]
    })).resolves.toMatchObject({ resourceVersion: 2 });
    await expect(api.getWeeklyReview({
      weekStart: "2026-08-31", timeZone: "Asia/Shanghai",
      scopeKind: "unassigned", projectId: null
    })).resolves.toEqual({ review: null, items: [], sourceSummary: summary });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "/api/work-reviews/weekly?weekStart=2026-08-31&timeZone=Asia%2FShanghai&scopeKind=unassigned",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("rejects a live-source payload whose type disagrees with its identity", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      identity: {
        sourceRef: "wrs_source",
        sourceKind: "meeting",
        sourceId: "meeting_1",
        version: 1,
        digest: "a".repeat(64),
        publicationId: "publication_1",
        segmentId: null,
        included: true
      },
      source: { id: "meeting_1", name: "Not a Meeting", status: "active", version: 1 }
    }));
    const api = createWorkReviewApi(fetchImpl as unknown as typeof fetch);
    await expect(api.getWeeklySource!("weekly_1", "wrs_source")).rejects.toThrow();
  });
});
