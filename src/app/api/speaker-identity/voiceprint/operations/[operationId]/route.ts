import { NextResponse } from "next/server";

import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import { VoiceprintSelfEnrollmentOperationRepository } from "@/lib/server/speaker-identity/voiceprint-self-enrollment";
import { isVoiceprintSelfEnrollmentEnabled } from "@/lib/server/speaker-identity/voiceprint-training-candidates";

export const runtime = "nodejs";

const SAFE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

export async function GET(
  request: Request,
  {
    params
  }: {
    params: Promise<{ operationId: string }>;
  }
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
  if (!isVoiceprintSelfEnrollmentEnabled()) {
    return NextResponse.json({ error: "feature_disabled" }, { status: 404 });
  }
  const { operationId } = await params;
  if (!SAFE_KEY_PATTERN.test(operationId)) {
    return NextResponse.json(
      { error: "invalid_operation_id" },
      { status: 400 }
    );
  }
  const operation = await new VoiceprintSelfEnrollmentOperationRepository(
    authContext.store
  ).get(operationId);
  if (!operation) {
    return NextResponse.json(
      { error: "voiceprint_enrollment_operation_not_found" },
      { status: 404 }
    );
  }
  return NextResponse.json({
    operation: {
      id: operation.operationId,
      status: operation.status,
      attemptCount: operation.attemptCount,
      durationMilliseconds: operation.durationMilliseconds ?? null,
      providerCode: operation.providerCode ?? null,
      errorReason: operation.errorReason ?? null,
      createdAt: operation.createdAt,
      startedAt: operation.startedAt ?? null,
      finishedAt: operation.finishedAt ?? null
    }
  });
}
