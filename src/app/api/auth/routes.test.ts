import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({
  authenticateUser: vi.fn(),
  clearSessionCookieHeader: vi.fn(() => "daily_brief_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"),
  createAuthenticatedSession: vi.fn(),
  createUser: vi.fn(),
  deleteSessionForRequest: vi.fn(),
  getAuthenticatedUser: vi.fn(),
  sessionCookieHeader: vi.fn((token: string) => `daily_brief_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`)
}));

vi.mock("@/lib/server/auth/session", () => authMock);

import { GET as getMe } from "./me/route";
import { POST as postLogin } from "./login/route";
import { POST as postLogout } from "./logout/route";
import { POST as postRegister } from "./register/route";

const ORIGINAL_ENV = { ...process.env };

describe("auth API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DAILY_BRIEF_INVITE_CODES = "alpha-invite,beta-invite";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("registers a user and sets a session cookie", async () => {
    authMock.createUser.mockResolvedValue({
      id: "user_1",
      email: "alice@example.com",
      name: "Alice"
    });
    authMock.createAuthenticatedSession.mockResolvedValue({ token: "session_token" });

    const response = await postRegister(
      new Request("http://localhost/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ email: "alice@example.com", password: "password-123", name: "Alice", inviteCode: "alpha-invite" }),
        headers: { "content-type": "application/json" }
      })
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toContain("daily_brief_session=session_token");
    await expect(response.json()).resolves.toEqual({
      user: {
        id: "user_1",
        email: "alice@example.com",
        name: "Alice"
      }
    });
    expect(authMock.createUser).toHaveBeenCalledWith({
      email: "alice@example.com",
      password: "password-123",
      name: "Alice"
    });
  });

  it("rejects registration when the invite code is missing or invalid", async () => {
    const response = await postRegister(
      new Request("http://localhost/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ email: "alice@example.com", password: "password-123", name: "Alice", inviteCode: "wrong-code" }),
        headers: { "content-type": "application/json" }
      })
    );

    expect(response.status).toBe(403);
    expect(authMock.createUser).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: "invalid_invite_code" });
  });

  it("disables registration when invite codes are not configured", async () => {
    delete process.env.DAILY_BRIEF_INVITE_CODES;

    const response = await postRegister(
      new Request("http://localhost/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ email: "alice@example.com", password: "password-123", inviteCode: "alpha-invite" }),
        headers: { "content-type": "application/json" }
      })
    );

    expect(response.status).toBe(503);
    expect(authMock.createUser).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: "invite_not_configured" });
  });

  it("logs in an existing user and returns the public user", async () => {
    authMock.authenticateUser.mockResolvedValue({
      id: "user_1",
      email: "alice@example.com",
      name: "Alice"
    });
    authMock.createAuthenticatedSession.mockResolvedValue({ token: "session_token" });

    const response = await postLogin(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "alice@example.com", password: "password-123" }),
        headers: { "content-type": "application/json" }
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("daily_brief_session=session_token");
    await expect(response.json()).resolves.toEqual({
      user: {
        id: "user_1",
        email: "alice@example.com",
        name: "Alice"
      }
    });
  });

  it("returns the current authenticated user", async () => {
    authMock.getAuthenticatedUser.mockResolvedValue({
      id: "user_1",
      email: "alice@example.com",
      name: "Alice"
    });

    const response = await getMe(new Request("http://localhost/api/auth/me"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      user: {
        id: "user_1",
        email: "alice@example.com",
        name: "Alice"
      }
    });
  });

  it("returns 401 when there is no authenticated user", async () => {
    authMock.getAuthenticatedUser.mockResolvedValue(null);

    const response = await getMe(new Request("http://localhost/api/auth/me"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthenticated" });
  });

  it("clears the current session on logout", async () => {
    const response = await postLogout(new Request("http://localhost/api/auth/logout", { method: "POST" }));

    expect(response.status).toBe(200);
    expect(authMock.deleteSessionForRequest).toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
