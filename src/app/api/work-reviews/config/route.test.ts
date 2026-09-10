// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ authenticated: true }));

vi.mock("@/lib/server/auth/request-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/auth/request-context")>()),
  requireAuthContext: vi.fn(async () => {
    if (!state.authenticated) throw new Error("unauthenticated");
    return { user: { id: "account_a" } };
  })
}));

import { GET } from "./route";

beforeEach(() => {
  state.authenticated = true;
  delete process.env.WORK_REVIEW_ENABLED;
  process.env.WORK_REVIEW_MAX_UPLOAD_BYTES = "1048576";
  process.env.WORK_REVIEW_MAX_AUDIO_DURATION_SECONDS = "3600";
});

afterEach(() => {
  delete process.env.WORK_REVIEW_ENABLED;
  delete process.env.WORK_REVIEW_MAX_UPLOAD_BYTES;
  delete process.env.WORK_REVIEW_MAX_AUDIO_DURATION_SECONDS;
});

describe("GET /api/work-reviews/config", () => {
  it("returns authenticated Work-owned limits and enabled capabilities by default", async () => {
    const response = await GET(new Request("http://localhost/api/work-reviews/config"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      limits: { maxUploadBytes: 1_048_576, maxAudioDurationSeconds: 3_600 },
      capabilities: {
        projects: true,
        weekly: true,
        weeklyAi: true,
        weeklyVerifier: true,
        weeklyQa: true,
        weeklyQaVerifier: true
      }
    });
  });

  it("requires auth", async () => {
    state.authenticated = false;
    const response = await GET(new Request("http://localhost/api/work-reviews/config"));
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  it("closes the capability endpoint when Work Review is explicitly disabled", async () => {
    process.env.WORK_REVIEW_ENABLED = "false";
    const response = await GET(new Request("http://localhost/api/work-reviews/config"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "feature_disabled" });
  });
});
