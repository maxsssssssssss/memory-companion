import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "@/lib/domain/types";
import { MemoryItemSchema } from "@/lib/server/memory";
import { buildEvaluationAuditReport } from "./audit-report";

const generatedAt = "2026-07-16T02:00:00.000Z";
const segment: TranscriptSegment = {
  id: "segment_1",
  uploadId: "upload_1",
  startSeconds: 0,
  endSeconds: 12,
  speaker: "speaker_1",
  text: "我会在周六晚上帮你检查简历。",
  confidence: 0.95,
  sceneLabels: [],
  valueLabels: []
};

function baseInput() {
  return {
    generatedAt,
    uploadId: "upload_1",
    userId: "evaluation-user",
    recordingDate: "2026-07-16",
    uploadFilePathRetained: true,
    uploadFileExists: true,
    segments: [segment],
    audioInsights: [],
    semanticSegments: [],
    briefItems: [],
    relationshipCards: [],
    proactiveInsights: [],
    audioChunks: [],
    transcriptChunks: [],
    analysisCheckpoints: [],
    relationshipStats: {},
    relationshipReducerAudit: null,
    memoryRelations: [],
    orphanEvidenceCount: 0,
    memoriesWithoutEvidenceCount: 0
  };
}

describe("evaluation audit report", () => {
  it("audits every evidence source type and duplicate source reference", () => {
    const memory = MemoryItemSchema.parse({
      id: "memory_1",
      userId: "evaluation-user",
      type: "commitment",
      title: "检查简历",
      summary: "周六检查简历",
      importance: 0.7,
      importanceScore: 0.7,
      importanceReasons: ["future_commitment"],
      status: "active",
      occurrenceCount: 1,
      firstSeenDate: "2026-07-16",
      lastSeenDate: "2026-07-16",
      accessCount: 0,
      lastAccessedAt: null,
      date: "2026-07-16",
      createdAt: generatedAt,
      updatedAt: generatedAt,
      evidence: [
        {
          id: "evidence_1",
          memoryId: "memory_1",
          sourceType: "transcript",
          sourceId: segment.id,
          uploadId: "upload_1",
          date: "2026-07-16",
          quote: "  我会在周六晚上帮你检查简历。  ",
          createdAt: generatedAt
        },
        {
          id: "evidence_distinct_quote",
          memoryId: "memory_1",
          sourceType: "transcript",
          sourceId: segment.id,
          uploadId: "upload_1",
          date: "2026-07-16",
          quote: "周六晚上",
          createdAt: generatedAt
        },
        {
          id: "evidence_2",
          memoryId: "memory_1",
          sourceType: "transcript",
          sourceId: segment.id,
          uploadId: "upload_1",
          date: "2026-07-16",
          quote: segment.text,
          createdAt: generatedAt
        },
        {
          id: "evidence_3",
          memoryId: "memory_1",
          sourceType: "brief",
          sourceId: "missing_brief",
          uploadId: "upload_1",
          date: "2026-07-16",
          quote: segment.text,
          createdAt: generatedAt
        }
      ]
    });

    const report = buildEvaluationAuditReport({
      ...baseInput(),
      memoryStage: {
        status: "completed",
        update: { inputCount: 1, memoryCount: 1, mergedCount: 0, relationCount: 0 },
        admission: {}
      },
      memoryAuditStatus: "completed",
      memories: [memory]
    });

    expect(report.evidenceFirst).toMatchObject({
      audited: true,
      evidenceCount: 4,
      invalidSourceIds: 1,
      nonVerbatimQuotes: 0,
      duplicateEvidence: 1,
      memoriesWithoutEvidence: 0,
      orphanEvidence: 0
    });
  });

  it("uses null metrics instead of false zeroes when memory indexing failed", () => {
    const report = buildEvaluationAuditReport({
      ...baseInput(),
      memoryStage: { status: "failed", error: "memory unavailable" },
      memoryAuditStatus: "failed",
      memoryAuditError: "memory unavailable",
      memories: [],
      orphanEvidenceCount: null,
      memoriesWithoutEvidenceCount: null
    });

    expect(report.memory).toMatchObject({
      auditStatus: "failed",
      auditError: "memory unavailable",
      audited: false
    });
    expect(report.evidenceFirst).toMatchObject({
      audited: false,
      invalidSourceIds: null,
      nonVerbatimQuotes: null,
      duplicateEvidence: null,
      memoriesWithoutEvidence: null,
      orphanEvidence: null
    });
  });

  it("records only provider capture counts and hashes in the retained report", () => {
    const report = buildEvaluationAuditReport({
      ...baseInput(),
      memoryStage: { status: "skipped", reason: "missing_user_id" },
      memoryAuditStatus: "skipped",
      memories: [],
      providerRawResponses: {
        version: 1,
        enabled: true,
        fileCount: 1,
        aggregateSha256: "a".repeat(64),
        files: [{ relativePath: "upload-ref/relationship/chunk.json", bytes: 123, sha256: "b".repeat(64) }]
      }
    });

    expect(report.artifacts.providerRawResponses).toMatchObject({
      enabled: true,
      fileCount: 1,
      aggregateSha256: "a".repeat(64)
    });
    expect(JSON.stringify(report)).not.toContain("rawResponse");
    expect(JSON.stringify(report)).not.toContain("private marker");
  });
});
