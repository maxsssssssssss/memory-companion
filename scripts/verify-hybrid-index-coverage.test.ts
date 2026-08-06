import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EmbeddingIndexMetadata } from "@/lib/server/retrieval/hybrid/embedding-index";
import {
  evaluateHybridUserCoverage,
  readHybridSidecarAllMetadata,
  summarizeHybridVerification
} from "./verify-hybrid-index-coverage";

const model = {
  modelName: "Qwen/Qwen3-Embedding-4B",
  modelVersion: "5cf2132abc99cad020ac570b19d031efec650f2b",
  dimension: 2560
};
const hash = "a".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

function metadata(
  overrides: Partial<EmbeddingIndexMetadata> = {}
): EmbeddingIndexMetadata {
  return {
    id: "row_1",
    objectType: "evidence",
    objectId: "evidence_1",
    sourceUploadId: "upload_1",
    modelName: model.modelName,
    modelVersion: model.modelVersion,
    dimension: model.dimension,
    contentHash: hash,
    createdAt: "2026-08-06T00:00:00.000Z",
    ...overrides
  };
}

function evaluate(
  overrides: Partial<Parameters<typeof evaluateHybridUserCoverage>[0]> = {}
) {
  return evaluateHybridUserCoverage({
    model,
    sidecarState: "available",
    metadata: [metadata()],
    liveExpected: [{
      objectId: "evidence_1",
      contentHash: hash,
      sourceUploadId: "upload_1"
    }],
    retainedExpected: [],
    retentionUploadIds: new Set<string>(),
    deletions: [],
    allUploadIds: new Set(["upload_1"]),
    liveUploadIds: new Set(["upload_1"]),
    interactions: [],
    ...overrides
  });
}

describe("Hybrid index coverage deployment verifier", () => {
  it("distinguishes a missing sidecar from an existing corrupt sidecar", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hybrid-verifier-sidecar-"));
    temporaryDirectories.push(directory);
    const sidecarPath = join(directory, "hybrid.sqlite");

    await expect(readHybridSidecarAllMetadata({ sidecarPath, model }))
      .resolves.toEqual({ state: "missing", metadata: [] });

    expect(evaluate({
      sidecarState: "missing",
      metadata: [],
      liveExpected: [],
      allUploadIds: new Set<string>(),
      liveUploadIds: new Set<string>()
    })).toMatchObject({ failed: false, sidecarHealthy: true });

    await writeFile(sidecarPath, "not a sqlite database", "utf8");
    const corrupt = await readHybridSidecarAllMetadata({ sidecarPath, model });
    expect(corrupt.state).toBe("error");
    expect(corrupt.metadata).toEqual([]);
    expect(evaluate({
      sidecarState: corrupt.state,
      metadata: corrupt.metadata,
      liveExpected: [],
      allUploadIds: new Set<string>(),
      liveUploadIds: new Set<string>()
    })).toMatchObject({ failed: true, sidecarHealthy: false });
  });

  it("passes only exact current-model rows with their source upload owner", () => {
    expect(evaluate()).toMatchObject({
      failed: false,
      sidecarHealthy: true,
      matched: 1,
      expected: 1,
      modelPartitions: 1,
      wrongPartitionRows: 0,
      unownedRows: 0,
      ownershipMismatchRows: 0,
      unexpectedRows: 0
    });
  });

  it("fails old model partitions and rows without source-upload ownership", () => {
    const result = evaluate({
      metadata: [
        metadata(),
        metadata({
          id: "row_old",
          sourceUploadId: null,
          modelVersion: "old-revision",
          dimension: 1024
        })
      ]
    });

    expect(result).toMatchObject({
      failed: true,
      modelPartitions: 2,
      wrongPartitionRows: 1,
      unownedRows: 1,
      ownershipMismatchRows: 1,
      unexpectedRows: 1
    });
  });

  it("finds completed-deletion residue in every model partition", () => {
    const result = evaluate({
      metadata: [metadata({
        sourceUploadId: "upload_deleted",
        modelName: "legacy/model",
        modelVersion: "legacy-revision",
        dimension: 1024
      })],
      liveExpected: [],
      allUploadIds: new Set<string>(),
      liveUploadIds: new Set<string>(),
      deletions: [{
        uploadId: "upload_deleted",
        status: "completed",
        evidence: [{ objectId: "other_evidence", contentHash: hash }]
      }]
    });

    expect(result).toMatchObject({
      failed: true,
      completedDeletions: 1,
      completedDeletionResidue: 1,
      wrongPartitionRows: 1,
      unexpectedRows: 1
    });
  });

  it("hard-fails an available interaction whose server source is absent", () => {
    const result = evaluate({
      metadata: [],
      liveExpected: [],
      allUploadIds: new Set<string>(),
      liveUploadIds: new Set<string>(),
      interactions: [{
        sourceUploadId: "upload_missing",
        sourceState: "available"
      }]
    });

    expect(result).toMatchObject({
      failed: true,
      availableInteractionsMissingSource: 1,
      interactions: 1,
      eligibleInteractions: 0
    });
  });

  it("keeps legacy gaps out of passed status and returns a failing exit code", () => {
    const result = evaluate({
      metadata: [],
      liveExpected: [],
      allUploadIds: new Set<string>(),
      liveUploadIds: new Set<string>(),
      interactions: [{
        sourceUploadId: "upload_legacy",
        sourceState: "server_cleaned"
      }]
    });
    expect(result).toMatchObject({ failed: true, legacyGaps: 1 });

    expect(summarizeHybridVerification({
      users: 1,
      failedUsers: 0,
      matchedRecoverableEvidence: 0,
      totalRecoverableEvidence: 0,
      eligibleInteractions: 0,
      totalInteractions: 1,
      legacyGaps: 1,
      model
    })).toMatchObject({
      status: "failed",
      exitCode: 1,
      legacyGaps: 1
    });
  });

  it("rejects an empty user root unless the operator explicitly allows it", () => {
    const empty = {
      users: 0,
      failedUsers: 0,
      matchedRecoverableEvidence: 0,
      totalRecoverableEvidence: 0,
      eligibleInteractions: 0,
      totalInteractions: 0,
      legacyGaps: 0,
      model
    };

    expect(summarizeHybridVerification(empty)).toMatchObject({
      status: "failed",
      exitCode: 1,
      users: 0
    });
    expect(summarizeHybridVerification({
      ...empty,
      allowEmptyUsers: true
    })).toMatchObject({
      status: "passed",
      exitCode: 0,
      users: 0
    });
  });
});
