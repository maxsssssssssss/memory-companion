import { NextResponse } from "next/server";
import { z } from "zod";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  getPersonAdmissionRepository,
  getPersonRepository
} from "@/lib/server/person";
import {
  admissionErrorResponse,
  admissionJson,
  personAdmissionDto,
  privateNoStore
} from "./admission-http";

export const runtime = "nodejs";

const CreatePersonRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(128).regex(/^[^\s]+$/u),
  displayName: z.string().trim().min(1).max(500).nullable().optional()
}).strict();

export async function GET(request: Request) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return unauthorizedResponse();
    }
    throw error;
  }
  return NextResponse.json({
    people: getPersonRepository().listConfirmedPersons(authContext.user.id)
  });
}

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
  const parsed = CreatePersonRequestSchema.safeParse(body);
  if (!parsed.success) {
    return admissionJson({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const person = getPersonAdmissionRepository().createPersonCandidate({
      accountId: authContext.user.id,
      idempotencyKey: parsed.data.idempotencyKey,
      displayName: parsed.data.displayName
    });
    return admissionJson({ person: personAdmissionDto(person) }, { status: 201 });
  } catch (error) {
    const response = admissionErrorResponse(error, "person_not_found");
    if (response) return response;
    throw error;
  }
}
