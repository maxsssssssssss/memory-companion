import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { isUnauthenticatedError, unauthorizedResponse } from "@/lib/server/auth/request-context";

import {
  WorkReviewConflictError,
  WorkReviewFeatureDisabledError,
  WorkReviewLeaseLostError,
  WorkReviewLinkedTodosPolicyRequiredError,
  WorkReviewNotFoundError,
  WorkReviewVersionConflictError
} from "./repository";
import { WorkTodoNotFoundError } from "./todo-repository";

export function workReviewFeatureDisabled(code = "feature_disabled") {
  return NextResponse.json({ error: code }, { status: 404 });
}

export function workReviewPrivateJson(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" }
  });
}

export function workReviewRouteError(error: unknown) {
  if (isUnauthenticatedError(error)) return unauthorizedResponse();
  if (error instanceof WorkReviewFeatureDisabledError) {
    return workReviewFeatureDisabled(error.code);
  }
  if (error instanceof WorkReviewNotFoundError) {
    return NextResponse.json({ error: "meeting_not_found" }, { status: 404 });
  }
  if (error instanceof WorkTodoNotFoundError) {
    return NextResponse.json({ error: error.code }, { status: 404 });
  }
  if (error instanceof WorkReviewLinkedTodosPolicyRequiredError) {
    return NextResponse.json({
      error: error.code,
      linkedTodoCount: error.linkedTodoCount,
      linkedTodoIds: error.linkedTodoIds
    }, { status: 409 });
  }
  if (error instanceof WorkReviewVersionConflictError) {
    return NextResponse.json({
      error: "version_conflict",
      currentVersion: error.currentVersion
    }, { status: 409 });
  }
  if (error instanceof WorkReviewLeaseLostError) {
    return NextResponse.json({ error: "processing_busy" }, { status: 409 });
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
    return NextResponse.json({ error: publicCode }, { status });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  console.error("[work-review] route_failed", {
    errorName: error instanceof Error ? error.name : "unknown"
  });
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
