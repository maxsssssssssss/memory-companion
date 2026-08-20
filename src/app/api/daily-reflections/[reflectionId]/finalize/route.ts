import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { DailyReflectionIdSchema } from "@/lib/domain/daily-reflection";
import {
  DailyReflectionFinalizeRequestSchema,
  DailyReflectionFinalizeResponseSchema
} from "@/lib/domain/daily-reflection-api";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  DailyReflectionConflictError,
  DailyReflectionMemoryAdmissionError,
  DailyReflectionNotFoundError,
  DailyReflectionVersionConflictError,
  getDailyReflectionMemoryAdmissionService,
  getDailyReflectionRepository,
  isDailyReflectionUploadEnabled
} from "@/lib/server/daily-reflection";

const ADMISSION_LEASE_DURATION_MS = 60_000;

function missing() {
  return NextResponse.json({ error: "daily_reflection_not_found" }, { status: 404 });
}

function conflict(error: string, retryable = false) {
  return NextResponse.json({ error, retryable }, { status: 409 });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ reflectionId: string }> }
) {
  if (!isDailyReflectionUploadEnabled()) return missing();
  const reflectionId = DailyReflectionIdSchema.safeParse((await params).reflectionId);
  if (!reflectionId.success) {
    return NextResponse.json({ error: "invalid_reflection_id" }, { status: 400 });
  }

  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }
  const payload = DailyReflectionFinalizeRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!payload.success) {
    return NextResponse.json({ error: "invalid_finalize_input" }, { status: 400 });
  }

  const repository = getDailyReflectionRepository();
  let finalized;
  try {
    finalized = repository.finalizeReview({
      accountId: authContext.user.id,
      reflectionId: reflectionId.data,
      expectedVersion: payload.data.expectedVersion,
      idempotencyKey: payload.data.idempotencyKey
    });
  } catch (error) {
    if (error instanceof DailyReflectionNotFoundError) return missing();
    if (error instanceof DailyReflectionVersionConflictError) {
      return NextResponse.json(
        { error: "version_conflict", currentVersion: error.currentVersion },
        { status: 409 }
      );
    }
    if (error instanceof DailyReflectionConflictError) {
      return conflict("daily_reflection_finalize_conflict");
    }
    throw error;
  }

  try {
    await getDailyReflectionMemoryAdmissionService().admitUnderLease({
      accountId: authContext.user.id,
      reflectionId: reflectionId.data,
      leaseOwner: `daily-reflection-finalize:${randomUUID()}`,
      leaseDurationMs: ADMISSION_LEASE_DURATION_MS
    });
  } catch (error) {
    if (error instanceof DailyReflectionNotFoundError) return missing();
    if (error instanceof DailyReflectionConflictError) {
      if (
        error.code === "daily_reflection_admission_busy"
        || error.code === "daily_reflection_admission_claim_conflict"
        || error.code === "daily_reflection_admission_lease_lost"
      ) {
        return conflict("daily_reflection_admission_in_progress", true);
      }
      if (error.code === "daily_reflection_delete_requested") return missing();
    }
    if (error instanceof DailyReflectionMemoryAdmissionError || error instanceof Error) {
      return NextResponse.json({
        error: "daily_reflection_memory_admission_failed",
        retryable: true
      }, { status: 503 });
    }
    throw error;
  }

  const reflection = repository.getReflection(authContext.user.id, reflectionId.data);
  const confirmation = repository.getConfirmation(authContext.user.id, reflectionId.data);
  const admissionOperation = repository.getAdmissionOperation(
    authContext.user.id,
    reflectionId.data
  );
  if (!confirmation || !admissionOperation) {
    return conflict("daily_reflection_finalize_conflict", true);
  }
  return NextResponse.json(DailyReflectionFinalizeResponseSchema.parse({
    reflection,
    confirmation,
    admissionOperation,
    admissionResults: repository.listAdmissionResults(
      authContext.user.id,
      admissionOperation.id
    ),
    reused: finalized.reused
  }));
}
