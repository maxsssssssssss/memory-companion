import { NextResponse } from "next/server";

import {
  DailyReflectionMemoryProposalAdmitRequestSchema
} from "@/lib/domain/daily-reflection-memory-proposal";
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
  proposalAdmissionResponse
} from "../../shared";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ proposalId: string }> }
) {
  if (!isDailyReflectionUploadEnabled()) {
    return NextResponse.json({ error: "daily_reflection_not_found" }, { status: 404 });
  }
  const proposalId = DailyReflectionIdSchema.safeParse((await params).proposalId);
  if (!proposalId.success) {
    return NextResponse.json({ error: "daily_reflection_not_found" }, { status: 404 });
  }
  let accountId: string;
  try {
    accountId = (await requireAuthContext(request)).user.id;
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
  const payload = DailyReflectionMemoryProposalAdmitRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!payload.success) {
    return NextResponse.json({ error: "invalid_memory_proposal_admission" }, { status: 400 });
  }
  try {
    const admitted = await getDailyReflectionMemoryProposalService().admit({
      accountId,
      proposalId: proposalId.data,
      ...payload.data
    });
    return NextResponse.json(proposalAdmissionResponse(admitted));
  } catch (error) {
    return memoryProposalRouteError(error);
  }
}
