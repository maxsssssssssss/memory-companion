import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { isUnauthenticatedError } from "@/lib/server/auth/request-context";

import {
  WorkReviewConflictError,
  WorkReviewFeatureDisabledError,
  WorkReviewLeaseLostError,
  WorkReviewLinkedTodosPolicyRequiredError,
  WorkReviewNotFoundError,
  WorkReviewVersionConflictError
} from "./repository";
import { WorkTodoNotFoundError } from "./todo-repository";
import {
  WorkWeeklyConflictError,
  WorkWeeklyLeaseLostError,
  WorkWeeklyNotFoundError,
  WorkWeeklyQaNotFoundError,
  WorkWeeklyVersionConflictError
} from "./weekly-repository";
import { WorkWeeklySourceError } from "./weekly-source-builder";

export function workReviewFeatureDisabled(code = "feature_disabled") {
  return workReviewPrivateJson({ error: code }, 404);
}

export function workReviewPrivateJson(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" }
  });
}

export function workReviewRouteError(error: unknown) {
  if (isUnauthenticatedError(error)) return workReviewPrivateJson({ error: "unauthenticated" }, 401);
  if (error instanceof WorkReviewFeatureDisabledError) {
    return workReviewFeatureDisabled(error.code);
  }
  if (error instanceof WorkReviewNotFoundError) {
    return workReviewPrivateJson({ error: "meeting_not_found" }, 404);
  }
  if (error instanceof WorkTodoNotFoundError) {
    return workReviewPrivateJson({ error: error.code }, 404);
  }
  if (error instanceof WorkWeeklyNotFoundError || error instanceof WorkWeeklyQaNotFoundError) {
    return workReviewPrivateJson({ error: error.code }, 404);
  }
  if (error instanceof WorkReviewLinkedTodosPolicyRequiredError) {
    return workReviewPrivateJson({
      error: error.code,
      linkedTodoCount: error.linkedTodoCount,
      linkedTodoIds: error.linkedTodoIds
    }, 409);
  }
  if (error instanceof WorkReviewVersionConflictError) {
    return workReviewPrivateJson({
      error: "version_conflict",
      currentVersion: error.currentVersion
    }, 409);
  }
  if (error instanceof WorkWeeklyVersionConflictError) {
    return workReviewPrivateJson({
      error: error.code,
      currentVersion: error.currentVersion
    }, 409);
  }
  if (error instanceof WorkReviewLeaseLostError) {
    return workReviewPrivateJson({ error: "processing_busy" }, 409);
  }
  if (error instanceof WorkWeeklyLeaseLostError) {
    return workReviewPrivateJson({ error: "weekly_processing_busy" }, 409);
  }
  if (error instanceof WorkWeeklyConflictError) {
    return workReviewPrivateJson({ error: error.code }, 409);
  }
  if (error instanceof WorkWeeklySourceError) {
    const status = error.code.endsWith("not_found") ? 404 : 400;
    return workReviewPrivateJson({ error: error.code }, status);
  }
  if (error instanceof WorkReviewConflictError) {
    const status = error.code === "work_review_idempotency_conflict"
      || error.code === "work_review_operation_conflict"
      || error.code === "work_review_candidates_pending"
      || error.code === "work_todo_operation_conflict"
      || error.code === "work_todo_ownership_override_required"
      || error.code === "work_todo_not_open"
      || error.code === "work_todo_source_unavailable"
      || error.code === "work_review_follow_up_operation_conflict"
      || error.code === "work_review_follow_up_review_incomplete"
      || error.code === "work_review_follow_up_not_generated"
      ? 409
      : error.code === "work_review_tombstoned"
        ? 404
        : 400;
    const publicCode = error.code
      .replace(/^work_review_/u, "")
      .replace(/^work_/u, "");
    return workReviewPrivateJson({ error: publicCode }, status);
  }
  if (error instanceof ZodError) {
    return workReviewPrivateJson({ error: "invalid_request" }, 400);
  }
  if (error instanceof SyntaxError) {
    return workReviewPrivateJson({ error: "invalid_request" }, 400);
  }
  console.error("[work-review] route_failed", {
    errorName: error instanceof Error ? error.name : "unknown"
  });
  return workReviewPrivateJson({ error: "internal_error" }, 500);
}
