import { z } from "zod";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import { getPersonAdmissionRepository } from "@/lib/server/person";
import {
  admissionErrorResponse,
  admissionJson,
  privateNoStore,
  relationshipAdmissionDto
} from "../../admission-http";

export const runtime = "nodejs";

const RelationshipTransitionRequestSchema = z.object({
  action: z.enum(["confirm", "conflict", "archive"]),
  expectedVersion: z.number().int().min(1)
}).strict();

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ relationshipId: string }> }
) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return privateNoStore(unauthorizedResponse());
    }
    throw error;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return admissionJson({ error: "invalid_request" }, { status: 400 });
  }
  const parsed = RelationshipTransitionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return admissionJson({ error: "invalid_request" }, { status: 400 });
  }
  const { relationshipId } = await params;
  try {
    const relationship = getPersonAdmissionRepository().transitionRelationship({
      accountId: authContext.user.id,
      relationshipId,
      action: parsed.data.action,
      expectedVersion: parsed.data.expectedVersion
    });
    return admissionJson({ relationship: relationshipAdmissionDto(relationship) });
  } catch (error) {
    const response = admissionErrorResponse(error, "relationship_not_found");
    if (response) return response;
    throw error;
  }
}
