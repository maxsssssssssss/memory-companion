import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { isUnauthenticatedError } from "@/lib/server/auth/request-context";
import {
  WorkProjectConflictError,
  WorkProjectNotFoundError,
  WorkProjectVersionConflictError
} from "@/lib/server/work-review/project-repository";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export function workProjectPrivateJson(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: PRIVATE_HEADERS });
}

export function workProjectFeatureDisabled() {
  return workProjectPrivateJson({ error: "projects_disabled" }, 404);
}

export function workProjectRouteError(error: unknown) {
  if (isUnauthenticatedError(error)) {
    return workProjectPrivateJson({ error: "unauthenticated" }, 401);
  }
  if (error instanceof WorkProjectNotFoundError) {
    return workProjectPrivateJson({ error: error.code }, 404);
  }
  if (error instanceof WorkProjectVersionConflictError) {
    return workProjectPrivateJson({
      error: "version_conflict",
      currentVersion: error.currentVersion
    }, 409);
  }
  if (error instanceof WorkProjectConflictError) {
    const conflictCodes = new Set([
      "project_name_conflict",
      "project_operation_conflict",
      "project_link_limit",
      "project_not_archived"
    ]);
    return workProjectPrivateJson(
      { error: error.code },
      conflictCodes.has(error.code) ? 409 : 400
    );
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return workProjectPrivateJson({ error: "invalid_request" }, 400);
  }
  console.error("[work-review-projects] route_failed", {
    errorName: error instanceof Error ? error.name : "unknown"
  });
  return workProjectPrivateJson({ error: "internal_error" }, 500);
}
