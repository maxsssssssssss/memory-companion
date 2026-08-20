import { NextResponse } from "next/server";

import {
  DcIdSchema,
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
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return auth.response;
  const relationshipId = DcIdSchema.safeParse((await params).relationshipId);
  if (!relationshipId.success) {
    return NextResponse.json({ error: "invalid_relationship_id" }, { status: 400 });
  }
  try {
    const view = getDateCompanionRepository().getRelationshipView(
      auth.authContext.user.id,
      relationshipId.data
    );
    return NextResponse.json(DcRelationshipViewResponseSchema.parse({ view }));
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
