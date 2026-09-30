import { NextResponse } from "next/server";

import {
  DcIdSchema,
  DcRelationshipSummaryResponseSchema,
  DcRelationshipViewResponseSchema
} from "@/lib/domain/date-companion-stage2";
import { getDateCompanionRepository } from "@/lib/server/date-companion";
import {
  dateCompanionAuth,
  dateCompanionErrorResponse
} from "@/lib/server/date-companion/http";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ relationshipId: string }> }
) {
  const scope = new URL(request.url).searchParams.get("scope");
  const headers = scope !== null ? { "Cache-Control": "private, no-store" } : undefined;
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) {
    if (headers) auth.response.headers.set("Cache-Control", headers["Cache-Control"]);
    return auth.response;
  }
  const relationshipId = DcIdSchema.safeParse((await params).relationshipId);
  if (!relationshipId.success) {
    return NextResponse.json({ error: "invalid_relationship_id" }, { status: 400, headers });
  }
  try {
    if (scope !== null && scope !== "summary") {
      return NextResponse.json({ error: "invalid_relationship_view_scope" }, { status: 400, headers });
    }
    if (scope === "summary") {
      const summary = getDateCompanionRepository().getRelationshipSummary(auth.authContext.user.id, relationshipId.data);
      return NextResponse.json(DcRelationshipSummaryResponseSchema.parse({ summary }), { headers });
    }
    const view = getDateCompanionRepository().getRelationshipView(
      auth.authContext.user.id,
      relationshipId.data
    );
    return NextResponse.json(DcRelationshipViewResponseSchema.parse({ view }));
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) {
      if (headers) response.headers.set("Cache-Control", headers["Cache-Control"]);
      return response;
    }
    throw error;
  }
}
