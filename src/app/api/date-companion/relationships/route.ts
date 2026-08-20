import { NextResponse } from "next/server";

import {
  DcCreateRelationshipRequestSchema,
  DcCreateRelationshipResponseSchema,
  DcRelationshipsResponseSchema
} from "@/lib/domain/date-companion-stage2";
import { getDateCompanionRepository } from "@/lib/server/date-companion";
import {
  dateCompanionAuth,
  dateCompanionErrorResponse,
  readJson
} from "@/lib/server/date-companion/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return auth.response;
  const relationships = getDateCompanionRepository().listRelationships(auth.authContext.user.id);
  return NextResponse.json(DcRelationshipsResponseSchema.parse({ relationships }));
}

export async function POST(request: Request) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return auth.response;
  const raw = await readJson(request);
  if ("response" in raw) return raw.response;
  const body = DcCreateRelationshipRequestSchema.safeParse(raw.value);
  if (!body.success) {
    return NextResponse.json({ error: "invalid_relationship_request" }, { status: 400 });
  }
  try {
    const result = getDateCompanionRepository().createOrGetRelationship(
      auth.authContext.user.id,
      body.data.displayName
    );
    return NextResponse.json(
      DcCreateRelationshipResponseSchema.parse(result),
      { status: result.reused ? 200 : 201 }
    );
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
