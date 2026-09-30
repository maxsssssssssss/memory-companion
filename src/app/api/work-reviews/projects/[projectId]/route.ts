import { NextResponse } from "next/server";

import { DeleteWorkProjectRequestSchema, UpdateWorkProjectRequestSchema } from "@/lib/domain/work-project";
import { WorkReviewIdSchema } from "@/lib/domain/work-review";
import { requireAuthContext } from "@/lib/server/auth/request-context";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import { WorkProjectService } from "@/lib/server/work-review/project-service";
import { isWorkReviewProjectsEnabled } from "@/lib/server/work-review/runtime-config";

import {
  workProjectFeatureDisabled,
  workProjectPrivateJson,
  workProjectRouteError
} from "../route-utils";

type ProjectRouteContext = { params: Promise<{ projectId: string }> };

function projectIdFrom(raw: string) {
  const parsed = WorkReviewIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function invalidProjectId() {
  return NextResponse.json(
    { error: "invalid_project_id" },
    { status: 400, headers: { "Cache-Control": "private, no-store" } }
  );
}

export async function GET(request: Request, { params }: ProjectRouteContext) {
  if (!isWorkReviewProjectsEnabled()) return workProjectFeatureDisabled();
  const projectId = projectIdFrom((await params).projectId);
  if (!projectId) return invalidProjectId();
  try {
    const auth = await requireAuthContext(request);
    const project = new WorkProjectService(getWorkReviewDatabase())
      .getProject(auth.user.id, projectId);
    return workProjectPrivateJson({ project });
  } catch (error) {
    return workProjectRouteError(error);
  }
}

export async function PATCH(request: Request, { params }: ProjectRouteContext) {
  if (!isWorkReviewProjectsEnabled()) return workProjectFeatureDisabled();
  const projectId = projectIdFrom((await params).projectId);
  if (!projectId) return invalidProjectId();
  try {
    const auth = await requireAuthContext(request);
    const body = UpdateWorkProjectRequestSchema.parse(await request.json());
    const result = new WorkProjectService(getWorkReviewDatabase())
      .updateProject(auth.user.id, projectId, body);
    return workProjectPrivateJson(result);
  } catch (error) {
    return workProjectRouteError(error);
  }
}

export async function DELETE(request: Request, { params }: ProjectRouteContext) {
  if (!isWorkReviewProjectsEnabled()) return workProjectFeatureDisabled();
  const projectId = projectIdFrom((await params).projectId);
  if (!projectId) return invalidProjectId();
  try {
    const auth = await requireAuthContext(request);
    const body = DeleteWorkProjectRequestSchema.parse(await request.json());
    const result = new WorkProjectService(getWorkReviewDatabase())
      .deleteProject(auth.user.id, projectId, body);
    return workProjectPrivateJson(result);
  } catch (error) {
    return workProjectRouteError(error);
  }
}
