import { NextResponse } from "next/server";

import {
  DcIdSchema,
  DcPatchPromiseRequestSchema,
  DcRelationshipViewResponseSchema
} from "@/lib/domain/date-companion-stage2";
import { getDateCompanionRepository } from "@/lib/server/date-companion";
import {
  dateCompanionAuth,
  dateCompanionErrorResponse,
  readJson
} from "@/lib/server/date-companion/http";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ promiseId: string }> }
) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return auth.response;
  const promiseId = DcIdSchema.safeParse((await params).promiseId);
  if (!promiseId.success) {
    return NextResponse.json({ error: "invalid_promise_id" }, { status: 400 });
  }
  const raw = await readJson(request);
  if ("response" in raw) return raw.response;
  const body = DcPatchPromiseRequestSchema.safeParse(raw.value);
  if (!body.success) {
    return NextResponse.json({ error: "invalid_promise_request" }, { status: 400 });
  }
  try {
    const repository = getDateCompanionRepository();
    const relationshipId = repository.patchPromise({
      userId: auth.authContext.user.id,
      promiseId: promiseId.data,
      version: body.data.version,
      status: body.data.status
    });
    const view = repository.getRelationshipView(auth.authContext.user.id, relationshipId);
    return NextResponse.json(DcRelationshipViewResponseSchema.parse({ view }));
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
