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
  subjectAdmissionDto
} from "../admission-http";

export const runtime = "nodejs";

const SubjectAdmissionRequestSchema = z.object({
  personId: z.string().trim().min(1).max(512).regex(/^[^\s]+$/u).nullable().optional(),
  uploadId: z.string().trim().min(1).max(512).regex(/^[^\s]+$/u),
  sourceSegmentId: z.string().trim().min(1).max(512).regex(/^[^\s]+$/u),
  disposition: z.enum(["candidate", "confirmed", "rejected", "unknown"]),
  expectedVersion: z.number().int().min(0)
}).strict();

export async function PUT(request: Request) {
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
  const parsed = SubjectAdmissionRequestSchema.safeParse(body);
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
    const admission = getPersonAdmissionRepository().recordSubjectAdmission({
      accountId: authContext.user.id,
      personId: parsed.data.personId ?? null,
      disposition: parsed.data.disposition,
      expectedVersion: parsed.data.expectedVersion,
      evidence
    });
    return admissionJson({ subjectAdmission: subjectAdmissionDto(admission) });
  } catch (error) {
    const response = admissionErrorResponse(error, "person_not_found");
    if (response) return response;
    throw error;
  }
}
