import {
  CreateWorkProjectRequestSchema,
  WorkProjectListStatusSchema
} from "@/lib/domain/work-project";
import { requireAuthContext } from "@/lib/server/auth/request-context";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import { WorkProjectService } from "@/lib/server/work-review/project-service";
import { isWorkReviewProjectsEnabled } from "@/lib/server/work-review/runtime-config";

import {
  workProjectFeatureDisabled,
  workProjectPrivateJson,
  workProjectRouteError
} from "./route-utils";

function statusQuery(request: Request) {
  const search = new URL(request.url).searchParams;
  const keys = [...new Set(search.keys())];
  if (keys.some((key) => key !== "status") || search.getAll("status").length > 1) {
    throw new SyntaxError("invalid_project_query");
  }
  return WorkProjectListStatusSchema.parse(search.get("status") ?? "active");
}

export async function GET(request: Request) {
  if (!isWorkReviewProjectsEnabled()) return workProjectFeatureDisabled();
  try {
    const auth = await requireAuthContext(request);
    const projects = new WorkProjectService(getWorkReviewDatabase())
      .listProjects(auth.user.id, statusQuery(request));
    return workProjectPrivateJson({ projects });
  } catch (error) {
    return workProjectRouteError(error);
  }
}

export async function POST(request: Request) {
  if (!isWorkReviewProjectsEnabled()) return workProjectFeatureDisabled();
  try {
    const auth = await requireAuthContext(request);
    const body = CreateWorkProjectRequestSchema.parse(await request.json());
    const result = new WorkProjectService(getWorkReviewDatabase())
      .createProject(auth.user.id, body);
    return workProjectPrivateJson(result, result.reused ? 200 : 201);
  } catch (error) {
    return workProjectRouteError(error);
  }
}
