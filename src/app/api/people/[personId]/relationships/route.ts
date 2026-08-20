import { NextResponse } from "next/server";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  getPersonRelationshipRepository,
  PersonRepositoryError
} from "@/lib/server/person";

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
    const relationships = getPersonRelationshipRepository()
      .listConfirmedForPerson(authContext.user.id, personId);
    return relationships
      ? NextResponse.json({ relationships })
      : NextResponse.json({ error: "person_not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof PersonRepositoryError) {
      return NextResponse.json({ error: "invalid_person_id" }, { status: 400 });
    }
    throw error;
  }
}
