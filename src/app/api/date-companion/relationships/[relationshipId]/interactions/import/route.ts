import { NextResponse } from "next/server";

import {
  DcIdSchema,
  DcImportInteractionRequestSchema,
  DcImportInteractionResponseSchema
} from "@/lib/domain/date-companion-stage2";
import {
  DateCompanionService,
  getDateCompanionRepository
} from "@/lib/server/date-companion";
import {
  dateCompanionAuth,
  dateCompanionErrorResponse,
  readJson
} from "@/lib/server/date-companion/http";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ relationshipId: string }> }
) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return auth.response;
  const relationshipId = DcIdSchema.safeParse((await params).relationshipId);
  if (!relationshipId.success) {
    return NextResponse.json({ error: "invalid_relationship_id" }, { status: 400 });
  }
  const raw = await readJson(request);
  if ("response" in raw) return raw.response;
  const body = DcImportInteractionRequestSchema.safeParse(raw.value);
  if (!body.success) {
    return NextResponse.json({ error: "invalid_import_request" }, { status: 400 });
  }
  try {
    const result = await new DateCompanionService(getDateCompanionRepository()).importInteraction({
      store: auth.authContext.store,
      userId: auth.authContext.user.id,
      relationshipId: relationshipId.data,
      uploadId: body.data.uploadId,
      uploadsRootDir: auth.authContext.uploadsRootDir
    });
    return NextResponse.json(
      DcImportInteractionResponseSchema.parse(result),
      { status: result.reused ? 200 : 201 }
    );
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
