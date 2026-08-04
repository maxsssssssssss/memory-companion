import { NextResponse } from "next/server";

import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse,
  type AuthContext
} from "@/lib/server/auth/request-context";

import {
  DcConflictError,
  DcNotFoundError,
  DcValidationError,
  DcVersionConflictError
} from "./repository";

export async function dateCompanionAuth(
  request: Request
): Promise<{ authContext: AuthContext } | { response: Response }> {
  try {
    return { authContext: await requireAuthContext(request) };
  } catch (error) {
    if (isUnauthenticatedError(error)) return { response: unauthorizedResponse() };
    throw error;
  }
}

export function dateCompanionErrorResponse(error: unknown): Response | null {
  if (error instanceof DcNotFoundError) {
    return NextResponse.json({ error: error.code }, { status: 404 });
  }
  if (error instanceof DcVersionConflictError) {
    return NextResponse.json(
      { error: error.code, currentVersion: error.currentVersion },
      { status: 409 }
    );
  }
  if (error instanceof DcConflictError) {
    return NextResponse.json({ error: error.code }, { status: 409 });
  }
  if (error instanceof DcValidationError) {
    return NextResponse.json({ error: error.code }, { status: 422 });
  }
  return null;
}

export async function readJson(request: Request) {
  try {
    return { value: await request.json() } as const;
  } catch {
    return {
      response: NextResponse.json({ error: "invalid_json" }, { status: 400 })
    } as const;
  }
}
