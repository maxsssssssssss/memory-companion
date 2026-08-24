import { NextResponse } from "next/server";

import {
  DailyReflectionMemoryProposalAdmissionResponseSchema,
  DailyReflectionMemoryProposalListResponseSchema,
  DailyReflectionMemoryProposalProvenanceSchema,
  DailyReflectionMemoryProposalPublicSchema,
  type DailyReflectionMemoryProposal
} from "@/lib/domain/daily-reflection-memory-proposal";
import {
  DailyReflectionConflictError,
  DailyReflectionMemoryProposalBusyError,
  DailyReflectionMemoryProposalLeaseLostError,
  DailyReflectionMemoryProposalServiceError,
  DailyReflectionNotFoundError,
  DailyReflectionVersionConflictError
} from "@/lib/server/daily-reflection";
import { DailyReflectionProposalAdmissionError } from
  "@/lib/server/memory/daily-reflection-proposal-admission";

export function publicProposal(proposal: DailyReflectionMemoryProposal) {
  return DailyReflectionMemoryProposalPublicSchema.parse(proposal);
}

export function proposalListResponse(input: {
  proposals: DailyReflectionMemoryProposal[];
  total: number;
  limit: number;
  offset: number;
}) {
  return DailyReflectionMemoryProposalListResponseSchema.parse(input);
}

export function proposalAdmissionResponse(input: {
  status: "approved" | "rejected" | "admitted" | "already_exists";
  proposal: DailyReflectionMemoryProposal;
  memoryId: string | null;
  reasons: string[];
}) {
  return DailyReflectionMemoryProposalAdmissionResponseSchema.parse(input);
}

export function proposalProvenanceResponse(input: Parameters<
  typeof DailyReflectionMemoryProposalProvenanceSchema.parse
>[0]) {
  return DailyReflectionMemoryProposalProvenanceSchema.parse(input);
}

export function memoryProposalRouteError(error: unknown): NextResponse {
  if (error instanceof DailyReflectionNotFoundError) {
    return NextResponse.json(
      { error: "daily_reflection_memory_proposal_not_found" },
      { status: 404 }
    );
  }
  if (error instanceof DailyReflectionVersionConflictError) {
    return NextResponse.json(
      { error: "version_conflict", currentVersion: error.currentVersion },
      { status: 409 }
    );
  }
  if (
    error instanceof DailyReflectionConflictError
    || error instanceof DailyReflectionMemoryProposalBusyError
    || error instanceof DailyReflectionMemoryProposalLeaseLostError
    || error instanceof DailyReflectionProposalAdmissionError
  ) {
    const candidateCode = "code" in error && typeof error.code === "string"
      ? error.code
      : null;
    const safeCode = candidateCode
      && candidateCode.length <= 128
      && /^daily_reflection_[a-z0-9_]+$/u.test(candidateCode)
      ? candidateCode
      : "daily_reflection_memory_proposal_conflict";
    return NextResponse.json(
      { error: safeCode },
      { status: 409 }
    );
  }
  if (error instanceof DailyReflectionMemoryProposalServiceError) {
    const retryable = error.code === "daily_reflection_memory_proposal_publication_failed";
    return NextResponse.json(
      { error: error.code, retryable },
      { status: retryable ? 503 : 409 }
    );
  }
  throw error;
}
