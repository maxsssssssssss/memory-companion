import { NextResponse } from "next/server";

import type { ProcessingJob } from "@/lib/domain/types";
import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import { getDateCompanionRepository } from "@/lib/server/date-companion";
import { enqueuePipelineJob } from "@/lib/server/queue/producer";
import {
  getToyIngestionDatabasePath,
  openToyIngestionDatabase,
  resolveToyIngestionMode,
  TOY_DATE_COMPANION_DESTINATION
} from "@/lib/server/uploads/toy-ingestion-receipt";
import {
  publicToyRecoveryReceipt,
  ToyRecoveryReceiptRepository
} from "@/lib/server/uploads/toy-ingestion-recovery";

const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;

function parseLookup(request: Request) {
  const url = new URL(request.url);
  const operationKey = url.searchParams.get("operationKey")?.trim() ?? "";
  const destination = url.searchParams.get("destination")?.trim() ?? "";
  const relationshipId = url.searchParams.get("relationshipId")?.trim() ?? "";
  if (
    !SAFE_IDENTIFIER.test(operationKey)
    || destination !== TOY_DATE_COMPANION_DESTINATION
    || !SAFE_IDENTIFIER.test(relationshipId)
  ) {
    return null;
  }
  return {
    operationKey,
    destination: TOY_DATE_COMPANION_DESTINATION as typeof TOY_DATE_COMPANION_DESTINATION,
    relationshipId
  };
}

export async function GET(request: Request) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) return unauthorizedResponse();
    throw error;
  }

  let toyMode: ReturnType<typeof resolveToyIngestionMode>;
  try {
    toyMode = resolveToyIngestionMode();
  } catch {
    return NextResponse.json(
      { error: "toy_ingestion_mode_not_supported" },
      { status: 503 }
    );
  }
  if (toyMode !== "recovery") {
    return NextResponse.json({ error: "toy_ingestion_disabled" }, { status: 503 });
  }
  const lookup = parseLookup(request);
  if (!lookup) {
    return NextResponse.json({ error: "invalid_toy_ingestion_metadata" }, { status: 400 });
  }
  try {
    getDateCompanionRepository().getRelationshipView(
      authContext.user.id,
      lookup.relationshipId
    );
  } catch {
    return NextResponse.json(
      { error: "toy_ingestion_relationship_scope_invalid" },
      { status: 409 }
    );
  }

  const database = openToyIngestionDatabase({
    filePath: getToyIngestionDatabasePath(authContext.dataRootDir)
  });
  try {
    const repository = new ToyRecoveryReceiptRepository(database);
    let receipt = repository.getByOperation({
      accountId: authContext.user.id,
      destination: lookup.destination,
      operationKey: lookup.operationKey
    });
    if (!receipt) {
      return NextResponse.json(
        { error: "toy_ingestion_receipt_not_found" },
        { status: 404 }
      );
    }
    if (receipt.relationshipId !== lookup.relationshipId) {
      return NextResponse.json(
        { error: "toy_ingestion_relationship_conflict" },
        { status: 409 }
      );
    }

    const job = await authContext.store.read<ProcessingJob>(
      "jobs-by-upload",
      receipt.uploadId
    );
    receipt = repository.reconcileJob(
      authContext.user.id,
      receipt.receiptId,
      job
    ) ?? receipt;
    if (receipt.executionMode === "queue" && job?.status === "waiting") {
      await enqueuePipelineJob({
        version: 1,
        uploadId: receipt.uploadId,
        userRef: authContext.user.id
      }).catch((error) => {
        console.error(
          `[pipeline-queue] enqueue failed upload_id=${receipt!.uploadId} error_name=${error instanceof Error ? error.name : "unknown"}`
        );
      });
    }
    return NextResponse.json(
      {
        ingestionReceipt: publicToyRecoveryReceipt({
          receipt,
          decision: "replayed"
        })
      },
      { status: receipt.serverAcceptedAt ? 200 : receipt.state === "failed" ? 500 : 202 }
    );
  } finally {
    database.close();
  }
}
