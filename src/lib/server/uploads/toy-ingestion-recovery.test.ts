import { describe, expect, it } from "vitest";

import { openToyIngestionDatabase } from "./toy-ingestion-receipt";
import {
  prepareToyRecovery,
  publicToyRecoveryReceipt,
  ToyRecoveryReceiptRepository
} from "./toy-ingestion-recovery";

function prepared(input: Partial<{
  operationKey: string;
  relationshipId: string;
  contentSha256: string;
  recordingDate: string;
}> = {}) {
  return prepareToyRecovery({
    accountId: "account_1",
    request: {
      operationKey: input.operationKey ?? "operation_1",
      destination: "date_companion",
      relationshipId: input.relationshipId ?? "relationship_1"
    },
    contentSha256: input.contentSha256 ?? "a".repeat(64),
    recordingDate: input.recordingDate ?? "2026-08-20",
    normalizationContext: "passthrough",
    executionMode: "inline"
  });
}

describe("minimal Toy recovery receipt", () => {
  it("replays the same operation with one canonical Upload and Job", () => {
    const database = openToyIngestionDatabase({ filePath: ":memory:" });
    try {
      const repository = new ToyRecoveryReceiptRepository(database);
      const first = repository.claim(prepared());
      expect(first.kind).toBe("owner");
      if (first.kind !== "owner") throw new Error("expected owner");
      const accepted = repository.markAccepted({
        accountId: "account_1",
        receiptId: first.receipt.receiptId,
        reservationToken: first.reservationToken,
        responseStatus: 201,
        response: { uploadId: first.receipt.uploadId, jobId: first.receipt.jobId }
      });
      const replay = repository.claim(prepared());
      expect(replay).toMatchObject({
        kind: "replay",
        receipt: {
          receiptId: accepted.receiptId,
          uploadId: accepted.uploadId,
          jobId: accepted.jobId
        }
      });
    } finally {
      database.close();
    }
  });

  it("binds relationship and payload to the original operation key", () => {
    const database = openToyIngestionDatabase({ filePath: ":memory:" });
    try {
      const repository = new ToyRecoveryReceiptRepository(database);
      expect(repository.claim(prepared()).kind).toBe("owner");
      expect(repository.claim(prepared({ relationshipId: "relationship_2" })))
        .toMatchObject({ kind: "conflict", conflict: "relationship_mismatch" });
      expect(repository.claim(prepared({ contentSha256: "b".repeat(64) })))
        .toMatchObject({ kind: "conflict", conflict: "payload_mismatch" });
      expect(repository.claim(prepared({ recordingDate: "2026-08-19" })))
        .toMatchObject({ kind: "conflict", conflict: "payload_mismatch" });
    } finally {
      database.close();
    }
  });

  it("does not deduplicate different operation keys with identical content", () => {
    const database = openToyIngestionDatabase({ filePath: ":memory:" });
    try {
      const repository = new ToyRecoveryReceiptRepository(database);
      const first = repository.claim(prepared({ operationKey: "operation_1" }));
      const second = repository.claim(prepared({ operationKey: "operation_2" }));
      expect(first.kind).toBe("owner");
      expect(second.kind).toBe("owner");
      if (first.kind !== "owner" || second.kind !== "owner") throw new Error("expected owners");
      expect(second.receipt.uploadId).not.toBe(first.receipt.uploadId);
      expect(second.receipt.jobId).not.toBe(first.receipt.jobId);
    } finally {
      database.close();
    }
  });

  it("never steals an in-flight owner after the advisory reservation time", () => {
    const database = openToyIngestionDatabase({ filePath: ":memory:" });
    try {
      const repository = new ToyRecoveryReceiptRepository(database);
      const first = repository.claim({
        ...prepared(),
        now: () => "2026-08-20T00:00:00.000Z",
        leaseMs: 1
      });
      const concurrent = repository.claim({
        ...prepared(),
        now: () => "2026-08-20T00:10:00.000Z"
      });
      expect(first.kind).toBe("owner");
      expect(concurrent).toMatchObject({ kind: "replay", receipt: { state: "reserving" } });
    } finally {
      database.close();
    }
  });

  it("does not publish generation, reimport or deletion lifecycle fields", () => {
    const database = openToyIngestionDatabase({ filePath: ":memory:" });
    try {
      const repository = new ToyRecoveryReceiptRepository(database);
      const claim = repository.claim(prepared());
      if (claim.kind !== "owner") throw new Error("expected owner");
      const receipt = publicToyRecoveryReceipt({ receipt: claim.receipt, decision: "accepted" });
      expect(receipt).not.toHaveProperty("generation");
      expect(receipt).not.toHaveProperty("reimportOfReceiptId");
      expect(receipt).not.toHaveProperty("deletedAt");
    } finally {
      database.close();
    }
  });
});
