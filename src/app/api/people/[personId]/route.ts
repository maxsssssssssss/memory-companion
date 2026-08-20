import { NextResponse } from "next/server";
import { z } from "zod";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  getPersonAdmissionRepository,
  getPersonRepository,
  PersonRepositoryError
} from "@/lib/server/person";
import {
  admissionErrorResponse,
  admissionJson,
  personAdmissionDto,
  privateNoStore
} from "../admission-http";

const ExpectedVersionSchema = z.number().int().min(0);
const UpdatePersonRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("confirm"),
    expectedVersion: ExpectedVersionSchema
  }).strict(),
  z.object({
    action: z.literal("rename"),
    displayName: z.string().trim().min(1).max(500).nullable(),
    expectedVersion: ExpectedVersionSchema
  }).strict(),
  z.object({
    action: z.literal("archive"),
    expectedVersion: ExpectedVersionSchema
  }).strict()
]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ personId: string }> }
) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return unauthorizedResponse();
    }
    throw error;
  }
  const { personId } = await params;
  try {
    const person = getPersonRepository().getConfirmedPerson(authContext.user.id, personId);
    return person
      ? NextResponse.json({ person })
      : NextResponse.json({ error: "person_not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof PersonRepositoryError) {
      return NextResponse.json({ error: "invalid_person_id" }, { status: 400 });
    }
    throw error;
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ personId: string }> }
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
  const parsed = UpdatePersonRequestSchema.safeParse(body);
  if (!parsed.success) {
    return admissionJson({ error: "invalid_request" }, { status: 400 });
  }
  const { personId } = await params;
  try {
    const repository = getPersonAdmissionRepository();
    const person = parsed.data.action === "confirm"
      ? repository.confirmPerson({
        accountId: authContext.user.id,
        personId,
        expectedVersion: parsed.data.expectedVersion
      })
      : parsed.data.action === "rename"
        ? repository.renamePerson({
          accountId: authContext.user.id,
          personId,
          displayName: parsed.data.displayName,
          expectedVersion: parsed.data.expectedVersion
        })
        : repository.archivePerson({
          accountId: authContext.user.id,
          personId,
          expectedVersion: parsed.data.expectedVersion
        });
    return admissionJson({ person: personAdmissionDto(person) });
  } catch (error) {
    const response = admissionErrorResponse(error, "person_not_found");
    if (response) return response;
    throw error;
  }
}
