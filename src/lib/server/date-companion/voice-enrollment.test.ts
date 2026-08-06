import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

import { openDateCompanionDatabase } from "./db";
import { DateCompanionRepository } from "./repository";
import type { DcVoiceEnrollmentDispatchJob } from "./types";
import { dispatchDateCompanionVoiceEnrollment } from "./voice-enrollment";

describe("Date Companion voice enrollment dispatcher boundary", () => {
  let database: Database.Database;
  let repository: DateCompanionRepository;

  beforeEach(() => {
    database = openDateCompanionDatabase({ filePath: ":memory:" });
    repository = new DateCompanionRepository(database);
  });

  afterEach(() => database.close());

  function pendingJob() {
    const relationship = repository.createOrGetRelationship("user_dispatch", "Ta").relationship;
    const imported = repository.importInteraction({
      userId: "user_dispatch",
      relationshipId: relationship.id,
      sourceUploadId: "upload_dispatch",
      recordingDate: "2026-08-05",
      originalName: "dispatch.wav",
      participants: [{ speakerId: "partner_raw" }],
      recapCandidates: [{
        kind: "moment",
        proposedText: "一起散步",
        sortOrder: 0,
        evidence: [{
          uploadId: "upload_dispatch",
          sourceSegmentId: "segment_partner",
          startSeconds: 0,
          endSeconds: 2,
          speakerId: "partner_raw",
          quote: "一起散步"
        }]
      }]
    });
    repository.saveVoiceEnrollmentSnapshots({
      userId: "user_dispatch",
      relationshipId: relationship.id,
      interactionId: imported.interactionId,
      snapshots: [{
        reviewGroupId: "partner_raw",
        speakerIds: ["partner_raw"],
        sourceUploadId: "upload_dispatch",
        providerRecordId: "provider_record_dispatch",
        chunkId: "chunk_dispatch",
        localSpeaker: "speaker_1",
        auditStatus: "unknown",
        auditReason: "no_matching_evidence",
        auditDigest: "c".repeat(64),
        expiresAt: "2099-01-01T00:00:00.000Z"
      }]
    });
    const detail = repository.getRelationshipView("user_dispatch", relationship.id).interactions[0];
    repository.updateRecap({
      userId: "user_dispatch",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [{ speakerId: "partner_raw", role: "companion" }],
      mutations: [{ id: detail.recapItems[0].id, version: 0, disposition: "kept" }],
      voiceEnrollmentIntents: [{ speakerIds: ["partner_raw"] }],
      voiceEnrollmentEnabled: true,
      finalize: true
    });
    const outbox = database.prepare(`
      SELECT id, expected_global_speaker_id
      FROM dc_voice_enrollment_outbox
      WHERE user_id = 'user_dispatch' AND interaction_id = ?
    `).get(imported.interactionId) as {
      id: string;
      expected_global_speaker_id: string;
    };
    return { relationship, imported, outbox };
  }

  it("keeps confirmed recap after Provider failure and retries with one deterministic request id", async () => {
    const { relationship, imported, outbox } = pendingJob();
    const requestIds: string[] = [];
    const dispatcher = {
      enroll: vi.fn(async (job: DcVoiceEnrollmentDispatchJob) => {
        requestIds.push(job.idempotencyKey);
        if (requestIds.length === 1) {
          const error = new Error("timeout") as Error & { code: string };
          error.code = "provider_timeout";
          throw error;
        }
        return { profileGlobalSpeakerId: job.expectedGlobalSpeakerId };
      })
    };

    await expect(dispatchDateCompanionVoiceEnrollment({
      repository,
      dispatcher,
      userId: "user_dispatch",
      outboxId: outbox.id
    })).resolves.toEqual({ status: "failed" });
    expect(repository.getRelationshipView("user_dispatch", relationship.id)
      .interactions[0]).toMatchObject({
        id: imported.interactionId,
        status: "confirmed",
        voiceEnrollment: { status: "failed" }
      });
    expect(database.prepare(`
      SELECT continuity_key FROM dc_participant_assignments
      WHERE user_id = 'user_dispatch' AND interaction_id = ?
    `).get(imported.interactionId)).toEqual({ continuity_key: null });

    await expect(dispatchDateCompanionVoiceEnrollment({
      repository,
      dispatcher,
      userId: "user_dispatch",
      outboxId: outbox.id
    })).resolves.toMatchObject({ status: "completed", idempotent: false });
    expect(requestIds).toHaveLength(2);
    expect(new Set(requestIds).size).toBe(1);
    expect(repository.getRelationshipView("user_dispatch", relationship.id)
      .interactions[0].voiceEnrollment).toEqual({ status: "completed" });
  });
});
