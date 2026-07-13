import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonStore } from "@/lib/server/storage/json-store";
import {
  authenticateUser,
  createAuthenticatedSession,
  createUser,
  getAuthenticatedUser,
  getUserDataRootDir,
  getUserScopedStore,
  SESSION_COOKIE_NAME,
  sessionCookieHeader
} from "./session";

describe("auth session", () => {
  let tempDir: string;
  let store: JsonStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-auth-"));
    store = new JsonStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates users with normalized unique email addresses", async () => {
    const user = await createUser({ email: " Alice@Example.COM ", password: "password-123", name: "Alice" }, store);

    expect(user.email).toBe("alice@example.com");
    expect(user.name).toBe("Alice");
    await expect(createUser({ email: "alice@example.com", password: "password-456" }, store)).rejects.toThrow("user_exists");
  });

  it("authenticates a user and rejects the wrong password", async () => {
    await createUser({ email: "alice@example.com", password: "password-123" }, store);

    await expect(authenticateUser({ email: "alice@example.com", password: "wrong" }, store)).rejects.toThrow("invalid_credentials");
    const user = await authenticateUser({ email: "alice@example.com", password: "password-123" }, store);

    expect(user.email).toBe("alice@example.com");
  });

  it("creates an http-only session cookie and resolves the current user", async () => {
    const user = await createUser({ email: "alice@example.com", password: "password-123" }, store);
    const session = await createAuthenticatedSession(user.id, store);
    const cookie = sessionCookieHeader(session.token);
    const request = new Request("http://localhost/api/auth/me", {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${session.token}`
      }
    });

    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    await expect(getAuthenticatedUser(request, store)).resolves.toEqual(expect.objectContaining({ id: user.id }));
  });

  it("uses a separate data root and store for each user", async () => {
    const alice = await createUser({ email: "alice@example.com", password: "password-123" }, store);
    const bob = await createUser({ email: "bob@example.com", password: "password-123" }, store);
    const aliceStore = getUserScopedStore(alice.id, tempDir);
    const bobStore = getUserScopedStore(bob.id, tempDir);

    await aliceStore.write("uploads", "same_upload_id", { title: "alice upload" });
    await bobStore.write("uploads", "same_upload_id", { title: "bob upload" });

    await expect(aliceStore.read<{ title: string }>("uploads", "same_upload_id")).resolves.toEqual({ title: "alice upload" });
    await expect(bobStore.read<{ title: string }>("uploads", "same_upload_id")).resolves.toEqual({ title: "bob upload" });
    expect(getUserDataRootDir(alice.id, tempDir)).not.toBe(getUserDataRootDir(bob.id, tempDir));
  });
});
