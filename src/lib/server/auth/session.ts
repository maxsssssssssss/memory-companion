import { scrypt as nodeScrypt, timingSafeEqual, randomBytes, randomUUID, createHash } from "crypto";
import { promisify } from "util";
import { join } from "path";
import { JsonStore, appStore } from "@/lib/server/storage/json-store";
import { getDataRootDir } from "@/lib/server/storage/paths";

const scrypt = promisify(nodeScrypt);

export const SESSION_COOKIE_NAME = "daily_brief_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const EMAIL_INDEX_COLLECTION = "users-by-email";
const USERS_COLLECTION = "users";
const SESSIONS_COLLECTION = "sessions";
const SAFE_USER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

type StoredUser = {
  id: string;
  email: string;
  name?: string;
  passwordHash: string;
  passwordSalt: string;
  createdAt: string;
};

type StoredSession = {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
};

export type PublicUser = {
  id: string;
  email: string;
  name?: string;
};

export type AuthenticatedSession = {
  id: string;
  token: string;
  userId: string;
  expiresAt: string;
};

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function emailIndexId(email: string) {
  return createHash("sha256").update(email).digest("hex");
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function publicUser(user: StoredUser): PublicUser {
  return {
    id: user.id,
    email: user.email,
    ...(user.name ? { name: user.name } : {})
  };
}

async function hashPassword(password: string, salt: string) {
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return hash.toString("hex");
}

async function verifyPassword(password: string, user: StoredUser) {
  const expected = Buffer.from(user.passwordHash, "hex");
  const actual = Buffer.from(await hashPassword(password, user.passwordSalt), "hex");

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function parseCookie(header: string | null, name: string) {
  if (!header) {
    return null;
  }

  const cookies = header.split(";").map((item) => item.trim());
  const match = cookies.find((item) => item.startsWith(`${name}=`));

  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function assertSafeUserId(userId: string) {
  if (!SAFE_USER_ID_PATTERN.test(userId)) {
    throw new Error(`Invalid user id: ${userId}`);
  }
}

export function getUserDataRootDir(userId: string, dataRoot = getDataRootDir()) {
  assertSafeUserId(userId);
  return join(dataRoot, "users", userId);
}

export function getUserUploadsRootDir(userId: string, dataRoot = getDataRootDir()) {
  return join(getUserDataRootDir(userId, dataRoot), "uploads");
}

export function getUserScopedStore(userId: string, dataRoot = getDataRootDir()) {
  return new JsonStore(getUserDataRootDir(userId, dataRoot));
}

export async function createUser(input: { email: string; password: string; name?: string }, store: JsonStore = appStore): Promise<PublicUser> {
  const email = normalizeEmail(input.email);
  const password = input.password;
  const name = input.name?.trim();

  if (!email || !email.includes("@")) {
    throw new Error("invalid_email");
  }

  if (password.length < 8) {
    throw new Error("weak_password");
  }

  const indexId = emailIndexId(email);
  const existing = await store.read<{ userId: string }>(EMAIL_INDEX_COLLECTION, indexId);
  if (existing) {
    throw new Error("user_exists");
  }

  const id = randomUUID();
  const salt = randomBytes(16).toString("hex");
  const user: StoredUser = {
    id,
    email,
    ...(name ? { name } : {}),
    passwordSalt: salt,
    passwordHash: await hashPassword(password, salt),
    createdAt: new Date().toISOString()
  };

  await store.write(USERS_COLLECTION, id, user);
  await store.write(EMAIL_INDEX_COLLECTION, indexId, { userId: id });

  return publicUser(user);
}

export async function authenticateUser(input: { email: string; password: string }, store: JsonStore = appStore): Promise<PublicUser> {
  const email = normalizeEmail(input.email);
  const index = await store.read<{ userId: string }>(EMAIL_INDEX_COLLECTION, emailIndexId(email));
  const user = index ? await store.read<StoredUser>(USERS_COLLECTION, index.userId) : null;

  if (!user || !(await verifyPassword(input.password, user))) {
    throw new Error("invalid_credentials");
  }

  return publicUser(user);
}

export async function createAuthenticatedSession(userId: string, store: JsonStore = appStore): Promise<AuthenticatedSession> {
  assertSafeUserId(userId);
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const token = `${id}.${secret}`;
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  const session: StoredSession = {
    id,
    userId,
    tokenHash: tokenHash(token),
    createdAt: new Date().toISOString(),
    expiresAt
  };

  await store.write(SESSIONS_COLLECTION, id, session);

  return { id, token, userId, expiresAt };
}

export function sessionCookieHeader(token: string) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`;
}

export function clearSessionCookieHeader() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

async function readSessionFromRequest(request: Request, store: JsonStore) {
  const token = parseCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME);
  if (!token) {
    return null;
  }

  const [sessionId] = token.split(".");
  if (!sessionId || !SAFE_USER_ID_PATTERN.test(sessionId)) {
    return null;
  }

  const session = await store.read<StoredSession>(SESSIONS_COLLECTION, sessionId);
  if (!session || session.tokenHash !== tokenHash(token) || Date.parse(session.expiresAt) <= Date.now()) {
    return null;
  }

  return { token, session };
}

export async function getAuthenticatedUser(request: Request, store: JsonStore = appStore): Promise<PublicUser | null> {
  const resolvedSession = await readSessionFromRequest(request, store);
  const user = resolvedSession ? await store.read<StoredUser>(USERS_COLLECTION, resolvedSession.session.userId) : null;

  return user ? publicUser(user) : null;
}

export async function requireAuthenticatedUser(request: Request, store: JsonStore = appStore): Promise<PublicUser> {
  const user = await getAuthenticatedUser(request, store);
  if (!user) {
    throw new Error("unauthenticated");
  }

  return user;
}

export async function deleteSessionForRequest(request: Request, store: JsonStore = appStore) {
  const resolvedSession = await readSessionFromRequest(request, store);
  if (resolvedSession) {
    await store.delete(SESSIONS_COLLECTION, resolvedSession.session.id);
  }
}
