import { NextResponse } from "next/server";
import { z } from "zod";

import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import {
  VoiceprintEnrollmentQueueUnavailableError,
  enqueueVoiceprintEnrollment
} from "@/lib/server/speaker-identity/voiceprint-enrollment-queue";
import {
  VoiceprintSelfEnrollmentError,
  VoiceprintSelfEnrollmentOperationRepository,
  createVoiceprintSelfEnrollment
} from "@/lib/server/speaker-identity/voiceprint-self-enrollment";
import {
  VoiceprintTrainingCandidateRepository,
  isVoiceprintSelfEnrollmentEnabled
} from "@/lib/server/speaker-identity/voiceprint-training-candidates";

export const runtime = "nodejs";

const RequestSchema = z.object({
  requestId: z.string().trim().min(1).max(512),
  candidateId: z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(512),
  confirmation: z.literal("self")
}).strict();

function enrollmentErrorResponse(error: VoiceprintSelfEnrollmentError) {
  const status =
    error.reason === "request_id_conflict"
      ? 409
      : error.reason === "candidate_expired"
        ? 410
        : error.reason === "invalid_candidate"
          ? 409
          : 404;
  return NextResponse.json(
    { error: `voiceprint_self_enrollment_${error.reason}` },
    { status }
  );
}

export async function POST(request: Request) {
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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_voiceprint_self_enrollment_request" },
      { status: 400 }
    );
  }

  try {
    const created = await createVoiceprintSelfEnrollment({
      store: authContext.store,
      userId: authContext.user.id,
      uploadsRootDir: authContext.uploadsRootDir,
      requestId: parsed.data.requestId,
      candidateId: parsed.data.candidateId
    });
    if (!created.reused) {
      try {
        await enqueueVoiceprintEnrollment({
          version: 1,
          userId: authContext.user.id,
          operationId: created.operation.operationId
        });
      } catch (error) {
        if (!(error instanceof VoiceprintEnrollmentQueueUnavailableError)) {
          throw error;
        }
        const operations = new VoiceprintSelfEnrollmentOperationRepository(
          authContext.store
        );
        const failed = await operations.update(
          created.operation.operationId,
          (current) => ({
            ...current,
            status: "failed",
            errorReason: "queue_unavailable",
            finishedAt: new Date().toISOString()
          })
        );
        await new VoiceprintTrainingCandidateRepository(
          authContext.store
        ).update(parsed.data.candidateId, (current) => ({
          ...current,
          status: "failed",
          failureReason: "queue_unavailable"
        })).catch(() => undefined);
        return NextResponse.json(
          {
            error: "voiceprint_enrollment_queue_unavailable",
            operation: {
              id: failed.operationId,
              status: failed.status,
              attemptCount: failed.attemptCount,
              errorReason: failed.errorReason
            }
          },
          { status: 503 }
        );
      }
    }
    return NextResponse.json(
      {
        operation: {
          id: created.operation.operationId,
          status: created.operation.status,
          attemptCount: created.operation.attemptCount,
          reused: created.reused
        }
      },
      { status: 202 }
    );
  } catch (error) {
    if (error instanceof VoiceprintSelfEnrollmentError) {
      return enrollmentErrorResponse(error);
    }
    console.error(
      `[voiceprint-enrollment] create_failed error_name=${error instanceof Error ? error.name : "unknown"}`
    );
    return NextResponse.json(
      { error: "voiceprint_self_enrollment_failed" },
      { status: 500 }
    );
  }
}
