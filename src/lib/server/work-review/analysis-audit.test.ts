// @vitest-environment node
import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkExtractorCandidateDraftSchema } from "@/lib/domain/work-review";
import { openWorkReviewDatabase } from "./db";
import { WorkReviewRepository } from "./repository";
import { assembleWorkMeetingCandidates } from "./candidate-normalization";
import { applyWorkMeetingOrganization } from "./candidate-deduplication";
import { WORK_MEETING_ANALYSIS_AUDIT_VERSION } from "./analysis-audit";
import { migrateWorkReviewSchema } from "./schema";

const now = "2026-09-08T00:00:00.000Z", hash = "a".repeat(64);
let database: Database.Database, repository: WorkReviewRepository;
beforeEach(() => { database = openWorkReviewDatabase({ filePath: ":memory:" }); repository = new WorkReviewRepository(database, { now: () => now }); });
afterEach(() => database.close());

function setup() {
  const meeting = repository.reserveMeeting({ accountId: "account_a", idempotencyKey: "upload_once", contentHash: hash,
    sourceUploadId: "upload_a", title: "审计 fixture", meetingDate: "2026-09-08" }).meeting;
  repository.publishSourceUpload({ accountId: "account_a", meetingId: meeting.id, uploadId: "upload_a", originalName: "fixture.wav",
    mimeType: "audio/wav", sizeBytes: 1024, recordingDate: "2026-09-08", filePath: "C:\\safe-fixtures\\fixture.wav", contentHash: hash });
  const scope = { accountId: "account_a", meetingId: meeting.id };
  const claim = (stage: "transcription" | "meeting_analysis") => {
    repository.queueStage({ ...scope, stage });
    return repository.claimProcessingAttempt({ ...scope, stage, leaseOwner: "fixture", leaseDurationMs: 60_000,
      pipelineVersion: "fixture", providerProfile: "fixture" })!;
  };
  const publication = repository.publishCanonicalTranscript({ ...scope, fence: claim("transcription"), segments: [{ id: "s_1",
    uploadId: "upload_a", startSeconds: 0, endSeconds: 4, text: "我认领接口；其余人员待确认。",
    confidence: 0.9, sceneLabels: [], valueLabels: [] }] }).publication;
  const fence = claim("meeting_analysis");
  return { ...scope, fence, publication, canonicalContentDigest: publication.contentDigest };
}

function auditFixture(context: ReturnType<typeof setup>) {
  const batches = [{ windowIndex: 0, candidates: ["接口交付", "其他待认领工作"].map((text, i) => WorkExtractorCandidateDraftSchema.parse({
    clientCandidateKey: `draft_${i}`, kind: "commitment", title: text, body: text, evidenceIds: ["s_1"],
    structuredData: { actionBasis: "explicit_commitment" }, claims: [{ clientClaimKey: `claim_${i}`, claimType: "commitment_existence",
      text, evidenceIds: ["s_1"] }]
  })) }];
  const sources = assembleWorkMeetingCandidates({ ...context, publicationId: context.publication.publicationId,
    canonicalDigest: context.canonicalContentDigest, segments: context.publication.segments, batches });
  const organization = applyWorkMeetingOrganization(sources, {}, context.publication.segments);
  const evaluated = sources.map(c => ({ id: c.id, kind: c.kind, title: c.title, body: c.body, structuredData: { ...c.structuredData, planStages: [] },
    publicationAction: "show_as_candidate" as const, riskLevel: "high" as const, generatorProfile: "fixture", generatorPromptVersion: "fixture",
    evidenceSegmentIds: c.evidenceIds, claims: c.claims.map(claim => ({ id: claim.id, claimType: claim.claimType, text: claim.text,
      evidenceSegmentIds: claim.evidenceIds, evaluation: { supportVerdict: "entailed" as const, issueCodes: [], riskLevel: "high" as const,
        publicationAction: "show_as_candidate" as const, confirmationRequired: true, supportedEvidenceIds: claim.evidenceIds,
        generatorProfile: "fixture", verifierProfile: "fixture", verifierPromptVersion: "fixture", policyVersion: "fixture" } })) }));
  const audit = { version: WORK_MEETING_ANALYSIS_AUDIT_VERSION, batches, sources, organized: sources, evaluated,
    organization: { state: "applied", reason: "completed", response: organization.acceptedPlan, skippedInvalidCount: 0 },
    sourceToResult: organization.sourceToResult, removed: [], priorityIds: [], primaryIds: [sources[0].id], overflowIds: [sources[1].id],
    fates: sources.map((c, i) => ({ sourceCandidateId: c.id, resultCandidateId: c.id, fate: i ? "overflow" : "primary",
      reason: i ? "review_capacity" : "review_priority", coveredByIds: [] })) };
  return { audit, candidates: [evaluated[0]] };
}

describe("Work Meeting analysis audit persistence", () => {
  it("commits full overflow alongside review, keeps it outside Finding authority, and erases it on deletion", () => {
    const context = setup(), fixture = auditFixture(context);
    repository.markAnalysisVerifying(context);
    repository.publishAnalysisResult({ ...context, candidates: fixture.candidates, analysisAudit: fixture.audit });
    const stored = repository.readAnalysisAudit(context.accountId, context.meetingId)!;
    expect(stored.evaluated).toHaveLength(2);
    expect(stored.overflowIds).toEqual(fixture.audit.overflowIds);
    expect(repository.getMeetingDetail(context.accountId, context.meetingId)).toMatchObject({ findings: [], meeting: { analysisStatus: "review_ready" } });
    expect(repository.listCandidates(context.accountId, context.meetingId)).toHaveLength(1);
    expect(() => repository.readAnalysisAudit("account_b", context.meetingId)).toThrow();
    repository.deleteMeeting(context);
    expect(database.prepare("SELECT count(*) AS n FROM wr_analysis_audits").get()).toEqual({ n: 0 });
    expect(() => repository.readAnalysisAudit(context.accountId, context.meetingId)).toThrow();
    expect(() => repository.publishAnalysisResult({ ...context, candidates: fixture.candidates, analysisAudit: fixture.audit })).toThrow();
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it.each(["foreign_evidence", "evaluation_scope", "changed_primary", "missing_fate", "false_mapping", "unknown_candidate", "limit"])(
    "rolls back all publication writes when audit validation fails: %s", mode => {
      const context = setup(), fixture = auditFixture(context), audit = structuredClone(fixture.audit);
      if (mode === "foreign_evidence") audit.sources[1].evidenceIds = ["foreign"];
      if (mode === "evaluation_scope") audit.evaluated[1].claims[0].evaluation.supportedEvidenceIds = ["foreign"];
      if (mode === "changed_primary") audit.evaluated[0].body = "unpublished";
      if (mode === "missing_fate") audit.fates.pop();
      if (mode === "false_mapping") audit.sourceToResult[1].resultCandidateId = audit.sources[0].id;
      if (mode === "unknown_candidate") audit.overflowIds[0] = "unknown";
      if (mode === "limit") audit.evaluated[0].body = "x".repeat(8 * 1024 * 1024);
      repository.markAnalysisVerifying(context);
      expect(() => repository.publishAnalysisResult({ ...context, candidates: fixture.candidates, analysisAudit: audit })).toThrow();
      for (const table of ["wr_meeting_candidates", "wr_atomic_claims", "wr_claim_evaluations", "wr_analysis_audits", "wr_findings"]) {
        expect(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
      expect(repository.getMeetingDetail(context.accountId, context.meetingId).meeting.analysisStatus).toBe("verifying");
      repository.publishAnalysisResult({ ...context, candidates: fixture.candidates, analysisAudit: fixture.audit });
      expect(database.pragma("foreign_key_check")).toEqual([]);
    });

  it("rejects tampered audit payloads", () => {
    const context = setup(), fixture = auditFixture(context);
    repository.markAnalysisVerifying(context);
    repository.publishAnalysisResult({ ...context, candidates: fixture.candidates, analysisAudit: fixture.audit });
    database.prepare("UPDATE wr_analysis_audits SET payload_digest = ?").run("b".repeat(64));
    expect(() => repository.readAnalysisAudit(context.accountId, context.meetingId)).toThrow();
  });

  it("rejects an internally consistent audit assembled for another account", () => {
    const context = setup(), other = auditFixture({ ...context, accountId: "account_b" });
    repository.markAnalysisVerifying(context);
    expect(() => repository.publishAnalysisResult({ ...context, candidates: other.candidates, analysisAudit: other.audit })).toThrow();
    expect(database.prepare("SELECT count(*) AS n FROM wr_meeting_candidates").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT count(*) AS n FROM wr_analysis_audits").get()).toEqual({ n: 0 });
  });

  it("migrates a populated V6 checkpoint table without changing rows or breaking scope/FKs", () => {
    // Use the immutable previous migration's actual DDL, not the new schema.
    const source = readFileSync("src/lib/server/work-review/schema.ts", "utf8");
    const v6 = source.split("const WORK_REVIEW_SCHEMA_V6 = `")[1].split("`;")[0];
    database.exec("DROP TABLE wr_analysis_audits; DROP TABLE wr_analysis_checkpoints;");
    database.exec(v6.slice(v6.indexOf("CREATE TABLE wr_analysis_checkpoints")));
    database.exec("DELETE FROM wr_schema_migrations WHERE version = 7; PRAGMA user_version = 6;");
    const context = setup();
    const checkpoint = { ...context, publicationId: context.publication.publicationId, checkpointKind: "extractor_block" as const,
      logicalInputDigest: hash, providerContractDigest: "b".repeat(64), outputSchemaVersion: "fixture", payload: { groups: [] } };
    repository.saveAnalysisCheckpoint(checkpoint);
    const before = database.prepare("SELECT * FROM wr_analysis_checkpoints").all();
    migrateWorkReviewSchema(database);
    expect(database.pragma("user_version", { simple: true })).toBe(7);
    expect(database.prepare("SELECT * FROM wr_analysis_checkpoints").all()).toEqual(before);
    repository.saveAnalysisCheckpoint({ ...checkpoint, checkpointKind: "organization_plan" });
    expect(() => repository.saveAnalysisCheckpoint({ ...checkpoint, checkpointKind: "organization_plan", accountId: "account_b" })).toThrow();
    expect(() => repository.saveAnalysisCheckpoint({ ...checkpoint, checkpointKind: "organization_plan", fence: { ...context.fence, leaseOwner: "stale" } })).toThrow();
    expect(repository.readAnalysisCheckpoint({ ...checkpoint, checkpointKind: "organization_plan" })?.payload).toEqual({ groups: [] });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    repository.deleteMeeting(context);
    expect(database.prepare("SELECT count(*) AS n FROM wr_analysis_checkpoints").get()).toEqual({ n: 0 });
  });
});
