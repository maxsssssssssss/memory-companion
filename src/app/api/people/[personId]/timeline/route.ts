import { NextResponse } from "next/server";
import type { MemoryItemType, MemoryStatus } from "@/lib/server/memory/types";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import { getPersonMemoryRepository, PersonRepositoryError } from "@/lib/server/person";

function values(searchParams: URLSearchParams, singular: string, plural: string) {
  return [...searchParams.getAll(singular), ...searchParams.getAll(plural)]
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

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
  const searchParams = new URL(request.url).searchParams;
  const rawLimit = searchParams.get("limit");
  try {
    const result = getPersonMemoryRepository().getPersonTimeline({
      accountId: authContext.user.id,
      personId,
      startDate: searchParams.get("startDate") ?? undefined,
      endDate: searchParams.get("endDate") ?? undefined,
      types: values(searchParams, "type", "types") as MemoryItemType[],
      statuses: values(searchParams, "status", "statuses") as MemoryStatus[],
      limit: rawLimit === null ? undefined : Number(rawLimit)
    });
    return result
      ? NextResponse.json(result)
      : NextResponse.json({ error: "person_not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof PersonRepositoryError || error instanceof Error && error.name === "ZodError") {
      return NextResponse.json({ error: "invalid_person_timeline_query" }, { status: 400 });
    }
    throw error;
  }
}
