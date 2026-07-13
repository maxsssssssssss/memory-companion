import { NextResponse } from "next/server";
import type { ProcessingJob } from "@/lib/domain/types";
import { isUnauthenticatedError, requireAuthContext, unauthorizedResponse } from "@/lib/server/auth/request-context";

const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;

  if (!STORE_KEY_PATTERN.test(jobId)) {
    return NextResponse.json({ error: "invalid_job_id" }, { status: 400 });
  }

  let authContext;
  try {
    authContext = await requireAuthContext(_request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return unauthorizedResponse();
    }
    throw error;
  }

  const job = await authContext.store.read<ProcessingJob>("jobs", jobId);
  if (!job) {
    return NextResponse.json({ error: "job_not_found" }, { status: 404 });
  }

  return NextResponse.json(job);
}
