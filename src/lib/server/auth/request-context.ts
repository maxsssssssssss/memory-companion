import { NextResponse } from "next/server";
import {
  getUserDataRootDir,
  getUserScopedStore,
  getUserUploadsRootDir,
  requireAuthenticatedUser,
  type PublicUser
} from "@/lib/server/auth/session";
import type { JsonStore } from "@/lib/server/storage/json-store";

export type AuthContext = {
  user: PublicUser;
  store: JsonStore;
  dataRootDir: string;
  uploadsRootDir: string;
};

export async function requireAuthContext(request: Request): Promise<AuthContext> {
  const user = await requireAuthenticatedUser(request);

  return {
    user,
    store: getUserScopedStore(user.id),
    dataRootDir: getUserDataRootDir(user.id),
    uploadsRootDir: getUserUploadsRootDir(user.id)
  };
}

export function unauthorizedResponse() {
  return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
}

export function isUnauthenticatedError(error: unknown) {
  return error instanceof Error && error.message === "unauthenticated";
}
