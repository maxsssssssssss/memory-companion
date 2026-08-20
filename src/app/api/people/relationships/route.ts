import { z } from "zod";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  getPersonAdmissionRepository,
  validateCanonicalEvidenceReference
} from "@/lib/server/person";
import {
  admissionErrorResponse,
  admissionJson,
  privateNoStore,
  relationshipAdmissionDto
} from "../admission-http";

export const runtime = "nodejs";

const RelationshipCandidateRequestSchema = z.object({
  personAId: z.string().trim().min(1).max(512).regex(/^[^\s]+$/u),
  personBId: z.string().trim().min(1).max(512).regex(/^[^\s]+$/u),
  type: z.string().trim().min(1).max(64)
    .regex(/^[a-z][a-z0-9_-]*$/u),
  expectedVersion: z.number().int().min(0),
  uploadId: z.string().trim().min(1).max(512).regex(/^[^\s]+$/u),
  sourceSegmentId: z.string().trim().min(1).max(512).regex(/^[^\s]+$/u)
}).strict();

export async function POST(request: Request) {
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
  const parsed = RelationshipCandidateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return admissionJson({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const evidence = await validateCanonicalEvidenceReference({
      store: authContext.store,
      accountId: authContext.user.id,
      uploadId: parsed.data.uploadId,
      sourceSegmentId: parsed.data.sourceSegmentId
    });
    const relationship = getPersonAdmissionRepository().createRelationshipCandidate({
      accountId: authContext.user.id,
      personAId: parsed.data.personAId,
      personBId: parsed.data.personBId,
      type: parsed.data.type,
      expectedVersion: parsed.data.expectedVersion,
      evidence
    });
    return admissionJson(
      { relationship: relationshipAdmissionDto(relationship) },
      { status: 201 }
    );
  } catch (error) {
    const response = admissionErrorResponse(error, "relationship_not_found");
    if (response) return response;
    throw error;
  }
}
