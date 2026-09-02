// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/lib/server/auth/request-context";

const state = vi.hoisted(() => ({
  authContext: null as AuthContext | null
}));

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  generate: vi.fn(),
  update: vi.fn(),
  reset: vi.fn()
}));

vi.mock("@/lib/server/auth/request-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/auth/request-context")>()),
  requireAuthContext: vi.fn(async () => {
    if (!state.authContext) throw new Error("unauthenticated");
    return state.authContext;
  })
}));

vi.mock("@/lib/server/work-review/db", () => ({
  getWorkReviewDatabase: () => ({})
}));

vi.mock("@/lib/server/work-review/follow-up-service", () => ({
  WorkMeetingFollowUpService: class {
    get = mocks.get;
    generate = mocks.generate;
    update = mocks.update;
    reset = mocks.reset;
  }
}));

import { POST as generateFollowUp } from "./generate/route";
import { GET as getFollowUp, PATCH as updateFollowUp } from "./route";
import { POST as resetFollowUp } from "./reset/route";

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

function context(meetingId = "meeting_1") {
  return { params: Promise.resolve({ meetingId }) };
}

function jsonRequest(method: string, body?: unknown) {
  return new Request("http://localhost/api/work-reviews/meetings/meeting_1/follow-up", {
    method,
    ...(body === undefined ? {} : {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
  });
}

beforeEach(() => {
  process.env.WORK_REVIEW_ENABLED = "true";
  process.env.WORK_REVIEW_UPLOAD_ENABLED = "true";
  process.env.WORK_REVIEW_ANALYSIS_ENABLED = "true";
  process.env.WORK_REVIEW_FOLLOW_UP_ENABLED = "true";
  state.authContext = {
    user: { id: "account_a", email: "a@example.test", name: "A" },
    store: {} as AuthContext["store"],
    dataRootDir: "C:\\test-data\\account_a",
    uploadsRootDir: "C:\\test-data\\account_a\\uploads"
  };
  mocks.get.mockReset().mockReturnValue({ draft: null, sourceStats });
  mocks.generate.mockReset().mockReturnValue({ draft, reused: false });
  mocks.update.mockReset().mockReturnValue({ draft: { ...draft, version: 1 }, reused: false });
  mocks.reset.mockReset().mockReturnValue({ draft: { ...draft, version: 2 }, reused: false });
});

afterEach(() => {
  state.authContext = null;
  delete process.env.WORK_REVIEW_ENABLED;
  delete process.env.WORK_REVIEW_UPLOAD_ENABLED;
  delete process.env.WORK_REVIEW_ANALYSIS_ENABLED;
  delete process.env.WORK_REVIEW_FOLLOW_UP_ENABLED;
});

describe("Work Review follow-up routes", () => {
  it("fails closed behind the dedicated feature dependency chain", async () => {
    process.env.WORK_REVIEW_ANALYSIS_ENABLED = "false";
    const response = await getFollowUp(jsonRequest("GET"), context());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "follow_up_disabled" });
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("requires auth and rejects a client-supplied account scope", async () => {
    state.authContext = null;
    const unauthenticated = await generateFollowUp(jsonRequest("POST", {
      expectedVersion: null,
      operationKey: "generate_once"
    }), context());
    expect(unauthenticated.status).toBe(401);
    state.authContext = {
      user: { id: "account_a", email: "a@example.test", name: "A" },
      store: {} as AuthContext["store"],
      dataRootDir: "C:\\test-data\\account_a",
      uploadsRootDir: "C:\\test-data\\account_a\\uploads"
    };
    const forgedScope = await generateFollowUp(jsonRequest("POST", {
      expectedVersion: null,
      operationKey: "generate_once",
      accountId: "account_b"
    }), context());
    expect(forgedScope.status).toBe(400);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("returns stats before generation and scopes GET to the server account", async () => {
    const response = await getFollowUp(jsonRequest("GET"), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ draft: null, sourceStats });
    expect(mocks.get).toHaveBeenCalledWith("account_a", "meeting_1");
  });

  it("forwards generate, update, and reset with operation/version contracts", async () => {
    const generated = await generateFollowUp(jsonRequest("POST", {
      expectedVersion: null,
      operationKey: "generate_once"
    }), context());
    const updated = await updateFollowUp(jsonRequest("PATCH", {
      bodyMarkdown: "# 用户编辑",
      expectedVersion: 0,
      operationKey: "save_once"
    }), context());
    const reset = await resetFollowUp(jsonRequest("POST", {
      expectedVersion: 1,
      operationKey: "reset_once"
    }), context());

    expect(generated.status).toBe(200);
    expect(updated.status).toBe(200);
    expect(reset.status).toBe(200);
    expect(mocks.generate).toHaveBeenCalledWith({
      accountId: "account_a",
      meetingId: "meeting_1",
      expectedVersion: null,
      operationKey: "generate_once"
    });
    expect(mocks.update).toHaveBeenCalledWith({
      accountId: "account_a",
      meetingId: "meeting_1",
      bodyMarkdown: "# 用户编辑",
      expectedVersion: 0,
      operationKey: "save_once"
    });
    expect(mocks.reset).toHaveBeenCalledWith({
      accountId: "account_a",
      meetingId: "meeting_1",
      expectedVersion: 1,
      operationKey: "reset_once"
    });
  });
});
