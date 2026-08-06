import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AudioUpload } from "@/lib/domain/types";
import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";
import type { EmbeddingModelConfig } from "@/lib/server/retrieval/hybrid/embedding-provider";
import type { EmbeddingIndexMetadata } from "@/lib/server/retrieval/hybrid/embedding-index";

type VerifierExpectedEvidence = {
  objectId: string;
  contentHash: string;
  sourceUploadId: string;
};

type VerifierDeletion = {
  uploadId: string;
  status: "pending" | "completed";
  evidence: ReadonlyArray<{ objectId: string; contentHash: string }>;
};

type VerifierInteraction = {
  sourceUploadId: string;
  sourceState: "available" | "server_cleaned" | "explicitly_deleted";
};

export type HybridSidecarReadResult =
  | { state: "available"; metadata: EmbeddingIndexMetadata[] }
  | { state: "missing"; metadata: [] }
  | { state: "error"; metadata: []; errorName: string };

function errorName(error: unknown) {
  return error instanceof Error ? error.name : "unknown";
}

function isMissingFileError(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Missing is the only tolerated open failure. Existing-but-unreadable,
 * malformed, locked, or permission-denied sidecars are explicit errors.
 */
export async function readHybridSidecarAllMetadata(input: {
  sidecarPath: string;
  model: EmbeddingModelConfig;
}): Promise<HybridSidecarReadResult> {
  try {
    await stat(input.sidecarPath);
  } catch (error) {
    if (isMissingFileError(error)) return { state: "missing", metadata: [] };
    return { state: "error", metadata: [], errorName: errorName(error) };
  }

  try {
    const { SqliteEmbeddingIndex } = await import(
      "@/lib/server/retrieval/hybrid/embedding-index"
    );
    const reader = new SqliteEmbeddingIndex(input.sidecarPath, input.model, {
      readonly: true
    });
    try {
      return { state: "available", metadata: reader.listAllMetadata() };
    } finally {
      reader.close();
    }
  } catch (error) {
    return { state: "error", metadata: [], errorName: errorName(error) };
  }
}

function fingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function metadataHash(entries: ReadonlyArray<{
  objectId: string;
  contentHash: string;
  sourceUploadId: string | null;
  objectType?: string;
  modelName?: string;
  modelVersion?: string;
  dimension?: number;
}>) {
  const canonical = entries
    .map((entry) => ({
      objectId: entry.objectId,
      contentHash: entry.contentHash,
      sourceUploadId: entry.sourceUploadId,
      objectType: entry.objectType ?? "evidence",
      modelName: entry.modelName ?? "",
      modelVersion: entry.modelVersion ?? "",
      dimension: entry.dimension ?? 0
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 16);
}

function addExpected(
  target: Map<string, VerifierExpectedEvidence>,
  entry: VerifierExpectedEvidence
) {
  const existing = target.get(entry.objectId);
  if (
    existing &&
    (
      existing.contentHash !== entry.contentHash ||
      existing.sourceUploadId !== entry.sourceUploadId
    )
  ) {
    throw new Error(
      "Hybrid verifier found a conflicting canonical Evidence id or owner"
    );
  }
  target.set(entry.objectId, entry);
}

function expectedMap(entries: readonly VerifierExpectedEvidence[]) {
  const result = new Map<string, VerifierExpectedEvidence>();
  for (const entry of entries) addExpected(result, entry);
  return result;
}

function isCurrentEvidencePartition(
  row: EmbeddingIndexMetadata,
  model: EmbeddingModelConfig
) {
  return (
    row.objectType === "evidence" &&
    row.modelName === model.modelName &&
    row.modelVersion === model.modelVersion &&
    row.dimension === model.dimension
  );
}

function partitionKey(row: EmbeddingIndexMetadata) {
  return [
    row.objectType,
    row.modelName,
    row.modelVersion,
    String(row.dimension)
  ].join("\0");
}

export function evaluateHybridUserCoverage(input: {
  model: EmbeddingModelConfig;
  sidecarState: HybridSidecarReadResult["state"];
  metadata: readonly EmbeddingIndexMetadata[];
  liveExpected: readonly VerifierExpectedEvidence[];
  retainedExpected: readonly VerifierExpectedEvidence[];
  retentionUploadIds: ReadonlySet<string>;
  deletions: readonly VerifierDeletion[];
  allUploadIds: ReadonlySet<string>;
  liveUploadIds: ReadonlySet<string>;
  interactions: readonly VerifierInteraction[];
}) {
  const liveExpected = expectedMap(input.liveExpected);
  const retainedExpected = expectedMap(input.retainedExpected);
  const desired = new Map(liveExpected);
  for (const entry of retainedExpected.values()) addExpected(desired, entry);

  const rowMatchesExpected = (row: EmbeddingIndexMetadata) => {
    const expected = desired.get(row.objectId);
    return Boolean(
      expected &&
      isCurrentEvidencePartition(row, input.model) &&
      row.sourceUploadId === expected.sourceUploadId &&
      row.contentHash === expected.contentHash
    );
  };
  const matchedObjectIds = new Set(
    input.metadata.filter(rowMatchesExpected).map((row) => row.objectId)
  );
  const liveMatched = [...liveExpected.keys()]
    .filter((objectId) => matchedObjectIds.has(objectId)).length;
  const retainedMatched = [...retainedExpected.keys()]
    .filter((objectId) => matchedObjectIds.has(objectId)).length;
  const matched = [...desired.keys()]
    .filter((objectId) => matchedObjectIds.has(objectId)).length;
  const wrongPartitionRows = input.metadata
    .filter((row) => !isCurrentEvidencePartition(row, input.model)).length;
  const unownedRows = input.metadata
    .filter((row) => row.sourceUploadId === null).length;
  const ownershipMismatchRows = input.metadata.filter((row) => {
    const expected = desired.get(row.objectId);
    return Boolean(expected && row.sourceUploadId !== expected.sourceUploadId);
  }).length;
  const unexpectedRows = input.metadata.filter((row) => !rowMatchesExpected(row)).length;
  const modelPartitions = new Set(input.metadata.map(partitionKey)).size;

  const pendingDeletions = input.deletions
    .filter((deletion) => deletion.status === "pending");
  const completedDeletions = input.deletions
    .filter((deletion) => deletion.status === "completed");
  const completedUploadIds = new Set(
    completedDeletions.map((deletion) => deletion.uploadId)
  );
  const completedLegacyObjectIds = new Set(
    completedDeletions.flatMap((deletion) =>
      deletion.evidence.map((entry) => entry.objectId)
    )
  );
  const completedDeletionResidue = input.metadata.filter((row) =>
    (
      row.sourceUploadId !== null &&
      completedUploadIds.has(row.sourceUploadId)
    ) || (
      row.sourceUploadId === null &&
      completedLegacyObjectIds.has(row.objectId)
    )
  ).length;
  const completedSourceResidue = completedDeletions
    .filter((deletion) => input.allUploadIds.has(deletion.uploadId)).length;

  const activeInteractions = input.interactions
    .filter((interaction) => interaction.sourceState !== "explicitly_deleted");
  const interactionUploadIds = new Set(
    activeInteractions.map((interaction) => interaction.sourceUploadId)
  );
  const preparedTransitions = [...input.retentionUploadIds]
    .filter((uploadId) => input.allUploadIds.has(uploadId)).length;
  const orphanRetentions = [...input.retentionUploadIds].filter((uploadId) =>
    !input.allUploadIds.has(uploadId) &&
    !interactionUploadIds.has(uploadId)
  ).length;
  const availableInteractionsMissingSource = activeInteractions.filter((interaction) =>
    interaction.sourceState === "available" &&
    !input.allUploadIds.has(interaction.sourceUploadId)
  ).length;
  const deletionUploadIds = new Set(
    input.deletions.map((deletion) => deletion.uploadId)
  );
  const legacyGaps = activeInteractions.filter((interaction) =>
    interaction.sourceState === "server_cleaned" &&
    !input.liveUploadIds.has(interaction.sourceUploadId) &&
    !input.retentionUploadIds.has(interaction.sourceUploadId) &&
    !deletionUploadIds.has(interaction.sourceUploadId)
  ).length;
  const eligibleInteractions = activeInteractions.filter((interaction) =>
    input.liveUploadIds.has(interaction.sourceUploadId) ||
    input.retentionUploadIds.has(interaction.sourceUploadId)
  ).length;

  const sidecarHealthy =
    input.sidecarState === "available" ||
    (
      input.sidecarState === "missing" &&
      desired.size === 0 &&
      input.deletions.length === 0
    );
  const failed =
    !sidecarHealthy ||
    matched !== desired.size ||
    unexpectedRows !== 0 ||
    wrongPartitionRows !== 0 ||
    unownedRows !== 0 ||
    ownershipMismatchRows !== 0 ||
    pendingDeletions.length !== 0 ||
    completedDeletions.length !== 0 ||
    completedDeletionResidue !== 0 ||
    completedSourceResidue !== 0 ||
    preparedTransitions !== 0 ||
    orphanRetentions !== 0 ||
    availableInteractionsMissingSource !== 0 ||
    legacyGaps !== 0;

  return {
    failed,
    sidecarHealthy,
    liveMatched,
    liveExpected: liveExpected.size,
    retainedMatched,
    retainedExpected: retainedExpected.size,
    matched,
    expected: desired.size,
    unexpectedRows,
    wrongPartitionRows,
    modelPartitions,
    unownedRows,
    ownershipMismatchRows,
    pendingDeletions: pendingDeletions.length,
    completedDeletions: completedDeletions.length,
    completedDeletionResidue,
    completedSourceResidue,
    preparedTransitions,
    orphanRetentions,
    availableInteractionsMissingSource,
    legacyGaps,
    interactions: activeInteractions.length,
    eligibleInteractions,
    desired: [...desired.values()]
  };
}

export function summarizeHybridVerification(input: {
  users: number;
  allowEmptyUsers?: boolean;
  failedUsers: number;
  matchedRecoverableEvidence: number;
  totalRecoverableEvidence: number;
  eligibleInteractions: number;
  totalInteractions: number;
  legacyGaps: number;
  model: EmbeddingModelConfig;
}) {
  const hardPassed =
    (input.users > 0 || input.allowEmptyUsers === true) &&
    input.failedUsers === 0 &&
    input.matchedRecoverableEvidence === input.totalRecoverableEvidence &&
    input.legacyGaps === 0;
  return {
    status: hardPassed ? "passed" as const : "failed" as const,
    exitCode: hardPassed ? 0 : 1,
    users: input.users,
    failedUsers: input.failedUsers,
    matchedRecoverableEvidence: input.matchedRecoverableEvidence,
    totalRecoverableEvidence: input.totalRecoverableEvidence,
    recoverableIndexCoverage: input.totalRecoverableEvidence === 0
      ? 1
      : input.matchedRecoverableEvidence / input.totalRecoverableEvidence,
    eligibleInteractions: input.eligibleInteractions,
    totalInteractions: input.totalInteractions,
    interactionEligibilityCoverage: input.totalInteractions === 0
      ? 1
      : input.eligibleInteractions / input.totalInteractions,
    legacyGaps: input.legacyGaps,
    model: input.model
  };
}

export async function runHybridIndexCoverageVerification() {
  loadRuntimeEnv();
  const { getUserScopedStore } = await import("@/lib/server/auth/session");
  const { getDateCompanionRepository } = await import(
    "@/lib/server/date-companion"
  );
  const { appStore } = await import("@/lib/server/storage/json-store");
  const { canonicalEvidenceEmbeddingText } = await import(
    "@/lib/server/retrieval/hybrid/dense-retrieval"
  );
  const { embeddingContentHash } = await import(
    "@/lib/server/retrieval/hybrid/embedding-index"
  );
  const { loadHybridEvidenceCorpus } = await import(
    "@/lib/server/retrieval/hybrid/index-refresh"
  );
  const {
    assertLocalQwen4BConfig,
    hybridEmbeddingIndexPath,
    qwenEmbeddingProviderForPurpose
  } = await import("@/lib/server/retrieval/hybrid/runtime-config");

  const provider = qwenEmbeddingProviderForPurpose("query");
  assertLocalQwen4BConfig(provider);
  const users = await appStore.list<{ id?: string }>("users");
  const allowEmptyUsers = process.argv.includes("--allow-empty");
  const repository = getDateCompanionRepository();
  let totalRecoverableEvidence = 0;
  let totalMatchedEvidence = 0;
  let totalInteractions = 0;
  let totalEligibleInteractions = 0;
  let totalLegacyGaps = 0;
  let failedUsers = 0;

  for (const [userIndex, record] of users.entries()) {
    const userRef =
      typeof record.value.id === "string" && record.value.id.trim()
        ? record.value.id
        : record.id;
    const userFingerprint = fingerprint(userRef);
    const sidecarPath = hybridEmbeddingIndexPath(userRef);
    const pathFingerprint = fingerprint(sidecarPath);
    const sidecar = await readHybridSidecarAllMetadata({
      sidecarPath,
      model: provider.config
    });
    try {
      const store = getUserScopedStore(userRef);
      const corpus = await loadHybridEvidenceCorpus({ store });
      const allUploads = await store.list<AudioUpload>("uploads");
      const allUploadIds = new Set(allUploads.map((item) => item.value.id));
      const liveUploadIds = new Set(corpus.uploads.map((upload) => upload.id));
      const retentionUploadIds = new Set(
        corpus.retainedManifests.map((manifest) => manifest.uploadId)
      );
      const liveExpected: VerifierExpectedEvidence[] = [];
      for (const snapshot of corpus.uploadEvidence) {
        for (const evidence of snapshot.evidence) {
          liveExpected.push({
            objectId: evidence.id,
            contentHash: embeddingContentHash(
              canonicalEvidenceEmbeddingText(evidence)
            ),
            sourceUploadId: snapshot.upload.id
          });
        }
      }
      const retainedExpected = corpus.retainedManifests.flatMap((manifest) =>
        manifest.evidence.map((evidence) => ({
          objectId: evidence.objectId,
          contentHash: evidence.contentHash,
          sourceUploadId: manifest.uploadId
        }))
      );
      const interactions = repository.listInteractionSourceMetadata(userRef);
      const verification = evaluateHybridUserCoverage({
        model: provider.config,
        sidecarState: sidecar.state,
        metadata: sidecar.metadata,
        liveExpected,
        retainedExpected,
        retentionUploadIds,
        deletions: corpus.deletions,
        allUploadIds,
        liveUploadIds,
        interactions
      });
      if (verification.failed) failedUsers += 1;
      totalRecoverableEvidence += verification.expected;
      totalMatchedEvidence += verification.matched;
      totalInteractions += verification.interactions;
      totalEligibleInteractions += verification.eligibleInteractions;
      totalLegacyGaps += verification.legacyGaps;
      console.info(
        `[hybrid-index-verify] progress=${userIndex + 1}/${users.length} ` +
        `user=${userFingerprint} sidecar=${pathFingerprint} state=${sidecar.state} ` +
        `live=${verification.liveMatched}/${verification.liveExpected} ` +
        `retained=${verification.retainedMatched}/${verification.retainedExpected} ` +
        `partitions=${verification.modelPartitions} wrong_partition=${verification.wrongPartitionRows} ` +
        `unowned=${verification.unownedRows} ownership_mismatch=${verification.ownershipMismatchRows} ` +
        `pending_delete=${verification.pendingDeletions} ` +
        `completed_delete=${verification.completedDeletions} ` +
        `completed_delete_residue=${verification.completedDeletionResidue} ` +
        `unexpected=${verification.unexpectedRows} ` +
        `available_missing_source=${verification.availableInteractionsMissingSource} ` +
        `legacy_gap=${verification.legacyGaps} ` +
        `corpus_hash=${metadataHash(verification.desired)} ` +
        `sidecar_hash=${metadataHash(sidecar.metadata)}`
      );
    } catch (error) {
      failedUsers += 1;
      console.error(
        `[hybrid-index-verify] progress=${userIndex + 1}/${users.length} ` +
        `user=${userFingerprint} sidecar=${pathFingerprint} state=${sidecar.state} ` +
        `failed=true error_name=${errorName(error)}`
      );
    }
  }

  const summary = summarizeHybridVerification({
    users: users.length,
    allowEmptyUsers,
    failedUsers,
    matchedRecoverableEvidence: totalMatchedEvidence,
    totalRecoverableEvidence,
    eligibleInteractions: totalEligibleInteractions,
    totalInteractions,
    legacyGaps: totalLegacyGaps,
    model: provider.config
  });
  const { exitCode, ...report } = summary;
  console.info(JSON.stringify(report, null, 2));
  process.exitCode = exitCode;
  return summary;
}

const directEntryUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (directEntryUrl === import.meta.url) {
  try {
    await runHybridIndexCoverageVerification();
  } catch (error) {
    console.error(JSON.stringify({
      status: "failed",
      errorName: errorName(error)
    }));
    process.exitCode = 1;
  }
}
