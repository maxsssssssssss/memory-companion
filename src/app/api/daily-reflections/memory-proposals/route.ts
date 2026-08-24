import { NextResponse } from "next/server";

import { DailyReflectionMemoryProposalStatusSchema } from
  "@/lib/domain/daily-reflection-memory-proposal";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  getDailyReflectionMemoryProposalService,
  isDailyReflectionUploadEnabled
} from "@/lib/server/daily-reflection";

import { proposalListResponse } from "./shared";

function missing() {
  return NextResponse.json({ error: "daily_reflection_not_found" }, { status: 404 });
}

export async function GET(request: Request) {
  if (!isDailyReflectionUploadEnabled()) return missing();
  let accountId: string;
  try {
    accountId = (await requireAuthContext(request)).user.id;
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
  const search = new URL(request.url).searchParams;
  const allowedKeys = new Set(["status", "limit", "offset"]);
  if (
    [...search.keys()].some((key) => !allowedKeys.has(key))
    || [...allowedKeys].some((key) => search.getAll(key).length > 1)
  ) {
    return NextResponse.json({ error: "invalid_memory_proposal_query" }, { status: 400 });
  }
  const status = search.get("status");
  const parsedStatus = status === null
    ? undefined
    : DailyReflectionMemoryProposalStatusSchema.safeParse(status);
  const limit = search.get("limit") ?? undefined;
  const offset = search.get("offset") ?? undefined;
  if (parsedStatus && !parsedStatus.success) {
    return NextResponse.json({ error: "invalid_memory_proposal_query" }, { status: 400 });
  }
  const parsedLimit = limit === undefined ? 24 : Number(limit);
  const parsedOffset = offset === undefined ? 0 : Number(offset);
  if (
    !Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100
    || !Number.isInteger(parsedOffset) || parsedOffset < 0 || parsedOffset > 100_000
  ) {
    return NextResponse.json({ error: "invalid_memory_proposal_query" }, { status: 400 });
  }
  const result = getDailyReflectionMemoryProposalService().list({
    accountId,
    ...(parsedStatus?.success ? { status: parsedStatus.data } : {}),
    limit: parsedLimit,
    offset: parsedOffset
  });
  return NextResponse.json(proposalListResponse(result));
}
