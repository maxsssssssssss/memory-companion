import { NextResponse } from "next/server";
import { z } from "zod";

import {
  DcIdSchema,
  DcSearchResponseSchema
} from "@/lib/domain/date-companion-stage2";
import { getDateCompanionRepository } from "@/lib/server/date-companion";
import {
  dateCompanionAuth,
  dateCompanionErrorResponse
} from "@/lib/server/date-companion/http";

export const runtime = "nodejs";
const QuerySchema = z.string().trim().min(1).max(120);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ relationshipId: string }> }
) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return auth.response;
  const relationshipId = DcIdSchema.safeParse((await params).relationshipId);
  const query = QuerySchema.safeParse(new URL(request.url).searchParams.get("q"));
  if (!relationshipId.success || !query.success) {
    return NextResponse.json({ error: "invalid_search_request" }, { status: 400 });
  }
  try {
    const results = getDateCompanionRepository().search(
      auth.authContext.user.id,
      relationshipId.data,
      query.data
    );
    return NextResponse.json(DcSearchResponseSchema.parse({ results }));
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
