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
  selfBindingDto
} from "../admission-http";

export const runtime = "nodejs";

const SetSelfRequestSchema = z.object({
  personId: z.string().trim().min(1).max(512).regex(/^[^\s]+$/u).nullable(),
  expectedVersion: z.number().int().min(0)
}).strict();

async function auth(request: Request) {
  try {
    return await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return null;
    throw error;
  }
}

export async function GET(request: Request) {
  const authContext = await auth(request);
  if (!authContext) return privateNoStore(unauthorizedResponse());
  const binding = getPersonAdmissionRepository().getSelfBinding(authContext.user.id);
  return admissionJson({ selfBinding: selfBindingDto(binding) });
}

export async function PUT(request: Request) {
  const authContext = await auth(request);
  if (!authContext) return privateNoStore(unauthorizedResponse());
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return admissionJson({ error: "invalid_request" }, { status: 400 });
  }
  const parsed = SetSelfRequestSchema.safeParse(body);
  if (!parsed.success) {
    return admissionJson({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const binding = getPersonAdmissionRepository().setSelfBinding({
      accountId: authContext.user.id,
      personId: parsed.data.personId,
      expectedVersion: parsed.data.expectedVersion
    });
    return admissionJson({ selfBinding: selfBindingDto(binding) });
  } catch (error) {
    const response = admissionErrorResponse(error, "person_not_found");
    if (response) return response;
    throw error;
  }
}
