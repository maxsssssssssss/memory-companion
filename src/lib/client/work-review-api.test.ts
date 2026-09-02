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
});
