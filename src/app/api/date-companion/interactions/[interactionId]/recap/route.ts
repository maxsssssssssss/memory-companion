import { NextResponse } from "next/server";

import {
  DcIdSchema,
  DcRelationshipViewResponseSchema,
  DcUpdateRecapRequestSchema
} from "@/lib/domain/date-companion-stage2";
import { getDateCompanionRepository } from "@/lib/server/date-companion";
import { isDateCompanionVoiceEnrollmentRuntimeAvailable } from "@/lib/server/date-companion/voice-enrollment";
import {
  dateCompanionAuth,
  dateCompanionErrorResponse,
  readJson
} from "@/lib/server/date-companion/http";

export const runtime = "nodejs";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ interactionId: string }> }
) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return auth.response;
  const interactionId = DcIdSchema.safeParse((await params).interactionId);
  if (!interactionId.success) {
    return NextResponse.json({ error: "invalid_interaction_id" }, { status: 400 });
  }
  const raw = await readJson(request);
  if ("response" in raw) return raw.response;
  const body = DcUpdateRecapRequestSchema.safeParse(raw.value);
  if (!body.success) {
    return NextResponse.json({ error: "invalid_recap_request" }, { status: 400 });
  }
  try {
    const repository = getDateCompanionRepository();
    const relationshipId = repository.getInteractionRelationshipId(
      auth.authContext.user.id,
      interactionId.data
    );
    repository.updateRecap({
      userId: auth.authContext.user.id,
      interactionId: interactionId.data,
      version: body.data.version,
      ...(body.data.assignments ? { assignments: body.data.assignments } : {}),
      mutations: body.data.items,
      ...(body.data.voiceEnrollmentIntents
        ? { voiceEnrollmentIntents: body.data.voiceEnrollmentIntents }
        : {}),
      ...(body.data.memoryAdmission
        ? { memoryAdmission: body.data.memoryAdmission }
        : {}),
      voiceEnrollmentEnabled: isDateCompanionVoiceEnrollmentRuntimeAvailable(),
      finalize: body.data.finalize
    });
    const view = repository.getRelationshipView(auth.authContext.user.id, relationshipId);
    return NextResponse.json(DcRelationshipViewResponseSchema.parse({ view }));
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
