import { describe, expect, it } from "vitest";
import {
  assertFrozenMemoryManifest,
  assertRetrievalHoldoutManifest,
  holdoutManifestHash
} from "./holdout-manifest";

function frozenMemoryManifest() {
  const value = {
    version: 1 as const,
    kind: "daily_brief_holdout_memory_manifest" as const,
    frozenAt: "2026-07-29T06:00:00.000Z",
    generatedBeforeQuestions: true as const,
    source: {
      sourceId: "independent-recording",
      datasetId: "dataset-v1",
      runtimePath: ".data/holdout",
      userId: "holdout-user",
      benchmarkReportPath: ".data/holdout/source-report.json",
      uploads: [{
        uploadId: "holdout-upload",
        recordingDate: "2026-07-15",
        transcriptSegmentCount: 1,
        transcriptHash: "a".repeat(64),
        eventClusterIds: ["independent-event"]
      }],
      transcriptSegmentCount: 1,
      transcriptHash: "a".repeat(64),
      eventClusterIds: ["independent-event"]
    },
    repository: {
      schemaVersion: 9,
      sourceBuild: "pipeline-generated",
      memoryModelRevision: null
    },
    canonicalUniverse: {
      evidenceCount: 1,
      identityHash: "b".repeat(64),
      contentHash: "c".repeat(64)
    },
    counts: {
      total: 1,
      active: 1,
      resolved: 0,
      superseded: 0,
      expired: 0,
      verifiedOwner: 0,
      localOwner: 0,
      unknownOwner: 1,
      conflictOwner: 0,
      canonicalMappable: 1,
      unmappable: 0,
      evidenceRows: 1
    },
    memories: [{
      memoryId: "memory-1",
      type: "event" as const,
      status: "active" as const,
      title: "Event",
      summary: "An independently generated event.",
      importance: 0.8,
      importanceScore: 0.8,
      firstSeenDate: "2026-07-15",
      lastSeenDate: "2026-07-15",
      occurrenceCount: 1,
      owner: {
        scope: "unknown" as const,
        type: "unknown" as const,
        identityId: null,
        confidence: 0,
        source: "unknown" as const,
        conflict: false
      },
      evidence: [{
        id: "memory-evidence-1",
        sourceType: "transcript" as const,
        sourceId: "segment-1",
        uploadId: "holdout-upload",
        recordingDate: "2026-07-15",
        canonicalEvidenceIds: ["raw:segment-1"],
        canonicalSourceSegmentIds: ["segment-1"],
        mappable: true
      }],
      contentHash: "d".repeat(64),
      modelRevision: null
    }]
  };
  return { ...value, manifestHash: holdoutManifestHash(value) };
}

function retrievalManifest(memoryManifestHash: string) {
  const value = {
    version: 1 as const,
    kind: "daily_brief_retrieval_holdout_manifest" as const,
    role: "holdout" as const,
    splitUnit: "recording_upload_date_group" as const,
    frozenAt: "2026-07-29T07:00:00.000Z",
    memoryManifests: [{
      sourceId: "independent-recording",
      manifestPath: ".data/holdout/memory-manifest.json",
      manifestHash: memoryManifestHash,
      frozenAt: "2026-07-29T06:00:00.000Z"
    }],
    developmentSet: {
      name: "hybrid_phase31_shadow_v1" as const,
      uploadIds: ["dev-upload"],
      transcriptHashes: ["e".repeat(64)],
      eventClusterIds: ["dev-event"]
    },
    sources: [{
      sourceId: "independent-recording",
      datasetId: "dataset-v1",
      runtimePath: ".data/holdout",
      userId: "holdout-user",
      benchmarkReportPath: ".data/holdout/source-report.json",
      uploads: [{
        uploadId: "holdout-upload",
        recordingDate: "2026-07-15",
        transcriptSegmentCount: 1,
        transcriptHash: "a".repeat(64),
        eventClusterIds: ["independent-event"]
      }],
      transcriptSegmentCount: 1,
      transcriptHash: "a".repeat(64),
      eventClusterIds: ["independent-event"]
    }],
    cases: [{
      caseId: "h01",
      question: "What happened?",
      scope: "all" as const,
      category: "fact" as const,
      queryIntent: ["fact"],
      requiredAnswerAspects: ["event"],
      goldEvidenceGroups: [{ id: "g1", sourceSegmentIds: ["segment-1"] }],
      acceptableAlternativeEvidenceGroups: [],
      requiredLifecycleStates: [],
      requiredDates: ["2026-07-15"],
      requiredEntities: [],
      memoryShouldHelp: false,
      expectedMemoryIds: [],
      evaluability: "retrieval-evaluable" as const,
      exclusionReasons: [],
      sourceId: "independent-recording"
    }]
  };
  return { ...value, manifestHash: holdoutManifestHash(value) };
}

describe("retrieval holdout manifests", () => {
  it("accepts a Memory-first, upload-group-isolated holdout", () => {
    const memory = assertFrozenMemoryManifest(frozenMemoryManifest());
    const retrieval = retrievalManifest(memory.manifestHash);
    expect(assertRetrievalHoldoutManifest({
      value: retrieval,
      memoryManifests: [memory],
      forbiddenCaseIds: new Set(["c02"])
    }).cases).toHaveLength(1);
  });

  it("rejects a mutated embedded hash", () => {
    const value = frozenMemoryManifest();
    value.memories[0]!.summary = "mutated";
    expect(() => assertFrozenMemoryManifest(value)).toThrow(/hash mismatch/u);
  });

  it("rejects upload-level leakage from development", () => {
    const memory = assertFrozenMemoryManifest(frozenMemoryManifest());
    const retrieval = retrievalManifest(memory.manifestHash);
    retrieval.sources[0]!.uploads[0]!.uploadId = "dev-upload";
    retrieval.manifestHash = holdoutManifestHash(retrieval);
    expect(() => assertRetrievalHoldoutManifest({
      value: retrieval,
      memoryManifests: [memory]
    })).toThrow(/upload overlaps/u);
  });

  it("rejects development regression case reuse", () => {
    const memory = assertFrozenMemoryManifest(frozenMemoryManifest());
    const retrieval = retrievalManifest(memory.manifestHash);
    retrieval.cases[0]!.caseId = "c02";
    retrieval.manifestHash = holdoutManifestHash(retrieval);
    expect(() => assertRetrievalHoldoutManifest({
      value: retrieval,
      memoryManifests: [memory],
      forbiddenCaseIds: new Set(["c02"])
    })).toThrow(/reuses a development regression case/u);
  });
});
