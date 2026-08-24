import { NextResponse } from "next/server";

import { DailyReflectionIdSchema } from "@/lib/domain/daily-reflection";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  getDailyReflectionMemoryProposalService,
  isDailyReflectionUploadEnabled
} from "@/lib/server/daily-reflection";

import {
  memoryProposalRouteError,
  proposalProvenanceResponse,
  publicProposal
} from "../shared";

function missing() {
  return NextResponse.json({ error: "daily_reflection_not_found" }, { status: 404 });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ proposalId: string }> }
) {
  if (!isDailyReflectionUploadEnabled()) return missing();
  const proposalId = DailyReflectionIdSchema.safeParse((await params).proposalId);
  if (!proposalId.success) return missing();
  let accountId: string;
  try {
    accountId = (await requireAuthContext(request)).user.id;
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
  try {
    const service = getDailyReflectionMemoryProposalService();
    const search = new URL(request.url).searchParams;
    if (
      [...search.keys()].some((key) => key !== "include")
      || search.getAll("include").length > 1
      || (search.has("include") && search.get("include") !== "provenance")
    ) {
      return NextResponse.json(
        { error: "invalid_memory_proposal_query" },
        { status: 400 }
      );
    }
    if (search.get("include") === "provenance") {
      const provenance = service.provenance(accountId, proposalId.data);
      return NextResponse.json(proposalProvenanceResponse(provenance));
    }
    return NextResponse.json({
      proposal: publicProposal(service.get(accountId, proposalId.data))
    });
  } catch (error) {
    return memoryProposalRouteError(error);
  }
}
