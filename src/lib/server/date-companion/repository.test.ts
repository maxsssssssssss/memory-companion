import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { openDateCompanionDatabase } from "./db";
import {
  DateCompanionRepository,
  DcConflictError,
  DcNotFoundError,
  DcValidationError,
  DcVersionConflictError
} from "./repository";

describe("DateCompanionRepository", () => {
  let database: Database.Database;
  let repository: DateCompanionRepository;

  beforeEach(() => {
    database = openDateCompanionDatabase({ filePath: ":memory:" });
    repository = new DateCompanionRepository(database);
  });

  afterEach(() => database.close());

  function importDraft(userId = "user_a", uploadId = "upload_1") {
    const relationship = repository.createOrGetRelationship(userId, "小满").relationship;
    const imported = repository.importInteraction({
      userId,
      relationshipId: relationship.id,
      sourceUploadId: uploadId,
      recordingDate: "2026-08-04",
      originalName: "fixture.wav",
      participants: [{ speakerId: "speaker_0" }, { speakerId: "speaker_1" }],
      recapCandidates: [
        {
          kind: "moment",
          proposedText: "一起认真讨论了下一次安排",
          sortOrder: 0,
          evidence: [{
            uploadId,
            sourceSegmentId: "shared_segment_id",
            startSeconds: 0,
            endSeconds: 3,
            speakerId: "speaker_1",
            quote: "我们下次可以早点见面"
          }]
        },
        {
          kind: "mentioned",
          proposedText: "Ta 最近想尝试徒步",
          sortOrder: 1,
          evidence: [{
            uploadId,
            sourceSegmentId: "segment_companion",
            startSeconds: 3,
            endSeconds: 7,
            speakerId: "speaker_1",
            quote: "我最近想试试徒步"
          }]
        },
        {
          kind: "promise",
          proposedText: "我来订周末的餐厅",
          sortOrder: 2,
          evidence: [{
            uploadId,
            sourceSegmentId: "segment_self",
            startSeconds: 7,
            endSeconds: 10,
            speakerId: "speaker_0",
            quote: "餐厅我来订"
          }]
        },
        {
          kind: "continue",
          proposedText: "这条内容会被排除",
          sortOrder: 3,
          evidence: [{
            uploadId,
            sourceSegmentId: "segment_excluded",
            startSeconds: 10,
            endSeconds: 13,
            speakerId: "speaker_1",
            quote: "排除关键词火星咖啡"
          }]
        }
      ]
    });
    return { relationship, imported };
  }

  function importVoiceEnrollmentDraft(userId: string, uploadId: string) {
    const relationship = repository.createOrGetRelationship(userId, "Ta").relationship;
    const imported = repository.importInteraction({
      userId,
      relationshipId: relationship.id,
      sourceUploadId: uploadId,
      recordingDate: "2026-08-05",
      originalName: "voice.wav",
      participants: [{ speakerId: "self_raw" }, { speakerId: "partner_raw" }],
      recapCandidates: [{
        kind: "moment",
        proposedText: "一起散步",
        sortOrder: 0,
        evidence: [{
          uploadId,
          sourceSegmentId: "partner_segment",
          startSeconds: 0,
          endSeconds: 2,
          speakerId: "partner_raw",
          quote: "一起散步"
        }]
      }]
    });
    repository.saveVoiceEnrollmentSnapshots({
      userId,
      relationshipId: relationship.id,
      interactionId: imported.interactionId,
      snapshots: [{
        reviewGroupId: "partner_raw",
        speakerIds: ["partner_raw"],
        sourceUploadId: uploadId,
        providerRecordId: `record_${uploadId}`,
        chunkId: `chunk_${uploadId}`,
        localSpeaker: "speaker_1",
        auditStatus: "unknown",
        auditReason: "no_matching_evidence",
        auditDigest: "a".repeat(64),
        expiresAt: "2099-01-01T00:00:00.000Z"
      }]
    });
    const detail = repository.getRelationshipView(userId, relationship.id).interactions[0];
    return { relationship, imported, recapItem: detail.recapItems[0] };
  }

  it("stores participant audio inside the user-scoped interaction and cascades it on delete", () => {
    const { imported } = importDraft();
    repository.saveParticipantAudioSamples({
      userId: "user_a",
      interactionId: imported.interactionId,
      samples: [{
        speakerId: "speaker_0",
        mimeType: "audio/mpeg",
        durationMilliseconds: 1_200,
        audio: new Uint8Array([1, 2, 3, 4])
      }]
    });

    expect(repository.participantAudioSpeakerIds("user_a", imported.interactionId)).toEqual(["speaker_0"]);
    expect(repository.getParticipantAudioSample("user_a", imported.interactionId, "speaker_0")).toEqual({
      mimeType: "audio/mpeg",
      durationMilliseconds: 1_200,
      audio: new Uint8Array([1, 2, 3, 4])
    });
    expect(repository.getParticipantAudioSample("user_b", imported.interactionId, "speaker_0")).toBeNull();

    expect(repository.deleteInteraction("user_a", imported.interactionId, 0)).toBeTruthy();
    expect(repository.getParticipantAudioSample("user_a", imported.interactionId, "speaker_0")).toBeNull();
  });

  it("rejects an audio sample for a speaker outside the interaction", () => {
    const { imported } = importDraft();
    expect(() => repository.saveParticipantAudioSamples({
      userId: "user_a",
      interactionId: imported.interactionId,
      samples: [{
        speakerId: "speaker_unknown",
        mimeType: "audio/mpeg",
        durationMilliseconds: 1_000,
        audio: new Uint8Array([1])
      }]
    })).toThrowError(DcValidationError);
  });

  it("hides participant audio after seven days and physically cleans expired bytes", () => {
    const { relationship, imported } = importDraft("user_audio_ttl", "upload_audio_ttl");
    repository.saveParticipantAudioSamples({
      userId: "user_audio_ttl",
      interactionId: imported.interactionId,
      samples: [{
        speakerId: "speaker_1",
        mimeType: "audio/mpeg",
        durationMilliseconds: 1_000,
        audio: new Uint8Array([1, 2, 3])
      }]
    });
    database.prepare(`
      UPDATE dc_participant_audio_samples
      SET created_at = '2026-07-01T00:00:00.000Z'
      WHERE user_id = ? AND interaction_id = ?
    `).run("user_audio_ttl", imported.interactionId);

    expect(repository.participantAudioSpeakerIds(
      "user_audio_ttl",
      imported.interactionId
    )).toEqual([]);
    expect(repository.getParticipantAudioSample(
      "user_audio_ttl",
      imported.interactionId,
      "speaker_1"
    )).toBeNull();
    expect(repository.getRelationshipView("user_audio_ttl", relationship.id)
      .interactions[0].participants.find((item) => item.speakerId === "speaker_1"))
      .not.toHaveProperty("audioSampleAvailable");
    expect(repository.cleanupExpiredParticipantAudioSamples(
      "2026-08-05T00:00:00.000Z"
    )).toBe(1);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dc_participant_audio_samples"
    ).get()).toEqual({ count: 0 });
  });

  it("migrates an isolated schema and enforces one current relationship per user", () => {
    const tables = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'dc_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
      "dc_relationships",
      "dc_interactions",
      "dc_participant_assignments",
      "dc_participant_audio_samples",
      "dc_relationship_speaker_bindings",
      "dc_recap_items",
      "dc_evidence_snapshots",
      "dc_promises",
      "dc_schema_migrations"
    ]));
    const interactionColumns = database.prepare(
      "PRAGMA table_info(dc_interactions)"
    ).all() as Array<{ name: string }>;
    expect(interactionColumns.map((row) => row.name)).toContain("confirmation_fingerprint");
    expect(database.prepare(
      "SELECT version FROM dc_schema_migrations ORDER BY version"
    ).all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 }
    ]);
    expect(repository.createOrGetRelationship("user_a").reused).toBe(false);
    expect(repository.createOrGetRelationship("user_a", "不应覆盖").reused).toBe(true);
    expect(repository.listRelationships("user_a")).toHaveLength(1);
    expect(repository.listRelationships("user_b")).toHaveLength(0);
  });

  it("isolates every lookup by user and returns not found across users", () => {
    const { relationship, imported } = importDraft();
    expect(() => repository.getRelationshipView("user_b", relationship.id)).toThrow(DcNotFoundError);
    expect(() => repository.getInteractionRelationshipId("user_b", imported.interactionId)).toThrow(DcNotFoundError);
    expect(repository.getInteractionVersionByUpload("user_b", "upload_1")).toBeNull();
    expect(repository.getInteractionVersionByUpload("user_a", "upload_1")).toEqual({
      interactionId: imported.interactionId,
      version: 0
    });
    expect(() => repository.deleteInteraction("user_b", imported.interactionId, 0)).toThrow(DcNotFoundError);
  });

  it("suggests a relationship role across recordings but still requires confirmation", () => {
    const relationship = repository.createOrGetRelationship("user_a", "Ta").relationship;
    const first = repository.importInteraction({
      userId: "user_a",
      relationshipId: relationship.id,
      sourceUploadId: "upload_continuity_1",
      recordingDate: "2026-08-04",
      originalName: "first.wav",
      participants: [
        { speakerId: "speaker_self_1", continuityKey: "user_profile" },
        { speakerId: "speaker_partner_1", continuityKey: "partner_profile" }
      ],
      recapCandidates: [{
        kind: "moment",
        proposedText: "一起散步",
        sortOrder: 0,
        evidence: [{
          uploadId: "upload_continuity_1",
          sourceSegmentId: "segment_partner_1",
          startSeconds: 0,
          endSeconds: 2,
          speakerId: "speaker_partner_1",
          quote: "今晚一起散步"
        }]
      }]
    });
    const firstView = repository.getRelationshipView("user_a", relationship.id);
    expect(firstView.interactions[0].participants).toEqual([
      expect.objectContaining({ speakerId: "speaker_partner_1", role: "unresolved" }),
      expect.objectContaining({ speakerId: "speaker_self_1", role: "unresolved" })
    ]);
    expect(firstView.interactions[0].participants.every(
      (participant) => participant.roleSuggestion === undefined
    )).toBe(true);

    repository.updateRecap({
      userId: "user_a",
      interactionId: first.interactionId,
      version: 0,
      assignments: [
        { speakerId: "speaker_self_1", role: "self" },
        { speakerId: "speaker_partner_1", role: "companion" }
      ],
      mutations: [{
        id: firstView.interactions[0].recapItems[0].id,
        version: 0,
        disposition: "kept"
      }],
      finalize: true
    });

    const secondImport = repository.importInteraction({
      userId: "user_a",
      relationshipId: relationship.id,
      sourceUploadId: "upload_continuity_2",
      recordingDate: "2026-08-05",
      originalName: "second.wav",
      participants: [
        { speakerId: "speaker_self_2", continuityKey: "user_profile" },
        { speakerId: "speaker_partner_2", continuityKey: "partner_profile" },
        { speakerId: "speaker_partner_2b", continuityKey: "partner_profile" }
      ],
      recapCandidates: []
    });
    repository.saveParticipantAudioSamples({
      userId: "user_a",
      interactionId: secondImport.interactionId,
      samples: [{
        speakerId: "speaker_partner_2",
        mimeType: "audio/mpeg",
        durationMilliseconds: 1_000,
        audio: new Uint8Array([1, 2, 3])
      }]
    });
    const second = repository.getRelationshipView("user_a", relationship.id).interactions
      .find((interaction) => interaction.sourceUploadId === "upload_continuity_2");
    expect(second?.participants).toEqual([
      expect.objectContaining({
        speakerId: "speaker_partner_2",
        audioSampleAvailable: true,
        role: "unresolved",
        roleSuggestion: { role: "companion", source: "previous_confirmation" }
      }),
      expect.objectContaining({
        speakerId: "speaker_partner_2b",
        role: "unresolved",
        roleSuggestion: { role: "companion", source: "previous_confirmation" }
      }),
      expect.objectContaining({
        speakerId: "speaker_self_2",
        role: "unresolved",
        roleSuggestion: { role: "self", source: "previous_confirmation" }
      })
    ]);
    const partnerReviewGroupIds = second?.participants
      .filter((participant) => participant.speakerId.startsWith("speaker_partner"))
      .map((participant) => participant.reviewGroupId);
    expect(new Set(partnerReviewGroupIds).size).toBe(1);
    expect(database.prepare(`
      SELECT source_interaction_id, role
      FROM dc_relationship_speaker_bindings
      WHERE user_id = ? AND relationship_id = ? AND continuity_key = ?
    `).get("user_a", relationship.id, "user_profile")).toEqual({
      source_interaction_id: first.interactionId,
      role: "self"
    });

    expect(repository.deleteInteraction("user_a", first.interactionId, 1)).toBe(relationship.id);
    const afterSourceDeletion = repository.getRelationshipView("user_a", relationship.id)
      .interactions.find((interaction) => interaction.sourceUploadId === "upload_continuity_2");
    expect(afterSourceDeletion?.participants.every(
      (participant) => participant.roleSuggestion === undefined
    )).toBe(true);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM dc_relationship_speaker_bindings
      WHERE user_id = ? AND relationship_id = ?
    `).get("user_a", relationship.id)).toEqual({ count: 0 });

    const otherRelationship = repository.createOrGetRelationship("user_b", "Ta").relationship;
    repository.importInteraction({
      userId: "user_b",
      relationshipId: otherRelationship.id,
      sourceUploadId: "upload_other_user",
      recordingDate: "2026-08-05",
      originalName: "other.wav",
      participants: [{ speakerId: "speaker_other", continuityKey: "partner_profile" }],
      recapCandidates: []
    });
    expect(repository.getRelationshipView("user_b", otherRelationship.id)
      .interactions[0].participants[0].roleSuggestion).toBeUndefined();
  });

  it.each([
    ["unresolved", "user_unresolved"],
    ["companion", "user_conflict"]
  ] as const)("does not retain continuity when the same candidate is self plus %s", (
    secondRole,
    userId
  ) => {
    const relationship = repository.createOrGetRelationship(userId, "Ta").relationship;
    const seed = repository.importInteraction({
      userId,
      relationshipId: relationship.id,
      sourceUploadId: `${userId}_seed`,
      recordingDate: "2026-08-03",
      originalName: "seed.wav",
      participants: [{ speakerId: "seed_speaker", continuityKey: "shared_profile" }],
      recapCandidates: [{
        kind: "moment",
        proposedText: "第一次确认",
        sortOrder: 0,
        evidence: [{
          uploadId: `${userId}_seed`,
          sourceSegmentId: "seed_segment",
          startSeconds: 0,
          endSeconds: 1,
          speakerId: "seed_speaker",
          quote: "第一次确认"
        }]
      }]
    });
    const seedItem = repository.getRelationshipView(userId, relationship.id)
      .interactions[0].recapItems[0];
    repository.updateRecap({
      userId,
      interactionId: seed.interactionId,
      version: 0,
      assignments: [{ speakerId: "seed_speaker", role: "self" }],
      mutations: [{ id: seedItem.id, version: 0, disposition: "kept" }],
      finalize: true
    });

    const challenged = repository.importInteraction({
      userId,
      relationshipId: relationship.id,
      sourceUploadId: `${userId}_challenged`,
      recordingDate: "2026-08-04",
      originalName: "challenged.wav",
      participants: [
        { speakerId: "candidate_a", continuityKey: "shared_profile" },
        { speakerId: "candidate_b", continuityKey: "shared_profile" }
      ],
      recapCandidates: [{
        kind: "moment",
        proposedText: "重新核对",
        sortOrder: 0,
        evidence: [{
          uploadId: `${userId}_challenged`,
          sourceSegmentId: "challenged_segment",
          startSeconds: 0,
          endSeconds: 1,
          speakerId: "candidate_a",
          quote: "重新核对"
        }]
      }]
    });
    const challengedItem = repository.getRelationshipView(userId, relationship.id)
      .interactions.find((interaction) => interaction.id === challenged.interactionId)!
      .recapItems[0];
    repository.updateRecap({
      userId,
      interactionId: challenged.interactionId,
      version: 0,
      assignments: [
        { speakerId: "candidate_a", role: "self" },
        { speakerId: "candidate_b", role: secondRole }
      ],
      mutations: [{ id: challengedItem.id, version: 0, disposition: "kept" }],
      finalize: true
    });

    repository.importInteraction({
      userId,
      relationshipId: relationship.id,
      sourceUploadId: `${userId}_next`,
      recordingDate: "2026-08-05",
      originalName: "next.wav",
      participants: [{ speakerId: "next_speaker", continuityKey: "shared_profile" }],
      recapCandidates: []
    });
    const next = repository.getRelationshipView(userId, relationship.id)
      .interactions.find((interaction) => interaction.sourceUploadId === `${userId}_next`);
    expect(next?.participants[0].roleSuggestion).toBeUndefined();
  });

  it("imports an upload idempotently and permits repeated fixture segment ids across uploads", () => {
    const first = importDraft("user_a", "upload_1");
    const reused = repository.importInteraction({
      userId: "user_a",
      relationshipId: first.relationship.id,
      sourceUploadId: "upload_1",
      recordingDate: "1970-01-01",
      originalName: "ignored.wav",
      participants: [],
      recapCandidates: []
    });
    expect(reused).toEqual({ interactionId: first.imported.interactionId, reused: true });
    importDraft("user_a", "upload_2");
    const evidence = database.prepare(`
      SELECT upload_id, source_segment_id FROM dc_evidence_snapshots
      WHERE user_id = ? AND source_segment_id = ? ORDER BY upload_id
    `).all("user_a", "shared_segment_id");
    expect(evidence).toEqual([
      { upload_id: "upload_1", source_segment_id: "shared_segment_id" },
      { upload_id: "upload_2", source_segment_id: "shared_segment_id" }
    ]);
  });

  it("guards source-upload deletion with user, interaction id and version", () => {
    const { relationship, imported } = importDraft("user_a", "upload_guarded");
    expect(repository.deleteInteractionByUpload(
      "user_b",
      "upload_guarded",
      imported.interactionId,
      0
    )).toBe(false);
    expect(() => repository.deleteInteractionByUpload(
      "user_a",
      "upload_guarded",
      "different_interaction",
      0
    )).toThrowError(expect.objectContaining({ code: "interaction_source_mismatch" }));

    repository.updateParticipants({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [{ speakerId: "speaker_0", role: "self" }]
    });
    expect(() => repository.deleteInteractionByUpload(
      "user_a",
      "upload_guarded",
      imported.interactionId,
      0
    )).toThrowError(expect.objectContaining({ code: "version_conflict", currentVersion: 1 }));
    expect(repository.getRelationshipView("user_a", relationship.id).interactions).toHaveLength(1);

    expect(repository.deleteInteractionByUpload(
      "user_a",
      "upload_guarded",
      imported.interactionId,
      1
    )).toBe(true);
    expect(repository.getRelationshipView("user_a", relationship.id).interactions).toHaveLength(0);
  });

  it("rejects missing evidence, invalid speakers, and stale versions", () => {
    const relationship = repository.createOrGetRelationship("user_a").relationship;
    expect(() => repository.importInteraction({
      userId: "user_a",
      relationshipId: relationship.id,
      sourceUploadId: "bad_upload",
      recordingDate: "2026-08-04",
      originalName: "bad.wav",
      participants: [],
      recapCandidates: [{ kind: "moment", proposedText: "无来源", sortOrder: 0, evidence: [] }]
    })).toThrow(DcValidationError);
    expect(repository.getRelationshipView("user_a", relationship.id).interactions).toHaveLength(0);

    const { imported } = importDraft();
    expect(() => repository.updateParticipants({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [{ speakerId: "provider_alice", role: "companion" }]
    })).toThrowError(expect.objectContaining({ code: "invalid_speaker_id" }));
    repository.updateParticipants({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [{ speakerId: "speaker_0", role: "self" }]
    });
    expect(() => repository.updateParticipants({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [{ speakerId: "speaker_1", role: "companion" }]
    })).toThrow(DcVersionConflictError);
  });

  it("blocks unresolved confirmation, excludes hidden items, and creates promises once", () => {
    const { relationship, imported } = importDraft();
    let view = repository.getRelationshipView("user_a", relationship.id);
    let interaction = view.interactions[0];
    expect(() => repository.updateRecap({
      userId: "user_a",
      interactionId: interaction.id,
      version: interaction.version,
      mutations: interaction.recapItems.map((item) => ({
        id: item.id,
        version: item.version,
        disposition: "kept" as const
      })),
      finalize: true
    })).toThrowError(expect.objectContaining({ code: "participant_assignment_required" }));

    view = repository.getRelationshipView("user_a", relationship.id);
    interaction = view.interactions[0];
    const confirmationRequest = {
      userId: "user_a",
      interactionId: interaction.id,
      version: interaction.version,
      assignments: [
        { speakerId: "speaker_0", role: "self" as const },
        { speakerId: "speaker_1", role: "companion" as const }
      ],
      mutations: interaction.recapItems.map((item) => ({
        id: item.id,
        version: item.version,
        ...(item.kind === "promise" ? { userText: "我来预订周末餐厅" } : {}),
        disposition: item.kind === "continue" ? "excluded" as const : "kept" as const
      })),
      finalize: true
    };
    expect(repository.updateRecap(confirmationRequest)).toEqual({ idempotent: false });

    view = repository.getRelationshipView("user_a", relationship.id);
    interaction = view.interactions[0];
    expect(interaction.status).toBe("confirmed");
    expect(view.promises).toHaveLength(1);
    expect(view.promises[0].text).toBe("我来预订周末餐厅");
    expect(repository.search("user_a", relationship.id, "徒步")).toHaveLength(1);
    expect(repository.search("user_a", relationship.id, "火星咖啡")).toHaveLength(0);

    expect(repository.updateRecap({
      ...confirmationRequest,
      assignments: [...confirmationRequest.assignments].reverse(),
      mutations: [...confirmationRequest.mutations].reverse()
    })).toEqual({ idempotent: true });
    expect(repository.getRelationshipView("user_a", relationship.id).promises).toHaveLength(1);
    expect(() => repository.updateRecap({
      ...confirmationRequest,
      mutations: []
    })).toThrowError(expect.objectContaining({ code: "confirmation_payload_conflict" }));
    expect(() => repository.updateRecap({
      ...confirmationRequest,
      assignments: confirmationRequest.assignments.map((assignment) =>
        assignment.speakerId === "speaker_1"
          ? { ...assignment, role: "unresolved" as const }
          : assignment
      )
    })).toThrowError(expect.objectContaining({ code: "confirmation_payload_conflict" }));

    database.prepare(`
      UPDATE dc_interactions SET confirmation_fingerprint = NULL
      WHERE id = ? AND user_id = ?
    `).run(interaction.id, "user_a");
    expect(() => repository.updateRecap(confirmationRequest)).toThrowError(
      expect.objectContaining({ code: "confirmation_payload_conflict" })
    );
  });

  it("does not confirm an interaction when every recap item is excluded or no recap item exists", () => {
    const { relationship, imported } = importDraft();
    const interaction = repository.getRelationshipView("user_a", relationship.id).interactions[0];

    expect(() => repository.updateRecap({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: interaction.version,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      mutations: interaction.recapItems.map((item) => ({
        id: item.id,
        version: item.version,
        disposition: "excluded" as const
      })),
      finalize: true
    })).toThrowError(expect.objectContaining({ code: "recap_confirmation_empty" }));
    expect(repository.getRelationshipView("user_a", relationship.id).interactions[0].status).toBe("draft");

    const empty = repository.importInteraction({
      userId: "user_a",
      relationshipId: relationship.id,
      sourceUploadId: "upload_empty",
      recordingDate: "2026-08-05",
      originalName: "empty.wav",
      participants: [],
      recapCandidates: []
    });
    expect(() => repository.updateRecap({
      userId: "user_a",
      interactionId: empty.interactionId,
      version: 0,
      mutations: [],
      finalize: true
    })).toThrowError(expect.objectContaining({ code: "recap_confirmation_empty" }));
  });

  it("rolls back participant assignments when atomic recap confirmation is invalid", () => {
    const { relationship, imported } = importDraft();
    const interaction = repository.getRelationshipView("user_a", relationship.id).interactions[0];
    expect(() => repository.updateRecap({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: interaction.version,
      assignments: [
        { speakerId: "speaker_0", role: "companion" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      mutations: interaction.recapItems.map((item) => ({
        id: item.id,
        version: item.version,
        disposition: "kept" as const
      })),
      finalize: true
    })).toThrowError(expect.objectContaining({ code: "promise_requires_self_speaker" }));

    const retained = repository.getRelationshipView("user_a", relationship.id).interactions[0];
    expect(retained.status).toBe("draft");
    expect(retained.version).toBe(0);
    expect(retained.participants).toEqual([
      { speakerId: "speaker_0", role: "unresolved" },
      { speakerId: "speaker_1", role: "unresolved" }
    ]);
    expect(retained.recapItems.every((item) => item.disposition === "pending" && item.version === 0)).toBe(true);
  });

  it("persists promise done/open transitions and cascades explicit interaction deletion", () => {
    const { relationship, imported } = importDraft();
    repository.updateParticipants({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ]
    });
    let interaction = repository.getRelationshipView("user_a", relationship.id).interactions[0];
    const recapMutations = interaction.recapItems.map((item) => ({
      id: item.id,
      version: item.version,
      disposition: item.kind === "continue" ? "excluded" as const : "kept" as const
    }));
    expect(() => repository.updateRecap({
      userId: "user_a",
      interactionId: interaction.id,
      version: interaction.version,
      mutations: recapMutations,
      finalize: true
    })).toThrowError(expect.objectContaining({ code: "participant_assignment_required" }));
    interaction = repository.getRelationshipView("user_a", relationship.id).interactions[0];
    repository.updateRecap({
      userId: "user_a",
      interactionId: interaction.id,
      version: interaction.version,
      assignments: interaction.participants.map((participant) => ({
        speakerId: participant.speakerId,
        role: participant.role
      })),
      mutations: recapMutations,
      finalize: true
    });
    let promise = repository.getRelationshipView("user_a", relationship.id).promises[0];
    repository.patchPromise({
      userId: "user_a",
      promiseId: promise.id,
      version: promise.version,
      status: "done"
    });
    promise = repository.getRelationshipView("user_a", relationship.id).promises[0];
    expect(promise.status).toBe("done");
    expect(promise.resolvedAt).toBeTruthy();
    repository.patchPromise({
      userId: "user_a",
      promiseId: promise.id,
      version: promise.version,
      status: "open"
    });
    promise = repository.getRelationshipView("user_a", relationship.id).promises[0];
    expect(promise.status).toBe("open");
    expect(promise).not.toHaveProperty("resolvedAt");

    const currentInteraction = repository.getRelationshipView(
      "user_a",
      relationship.id
    ).interactions[0];
    expect(() => repository.deleteInteraction(
      "user_a",
      interaction.id,
      currentInteraction.version - 1
    )).toThrowError(expect.objectContaining({
      code: "version_conflict",
      currentVersion: currentInteraction.version
    }));
    repository.deleteInteraction("user_a", interaction.id, currentInteraction.version);
    const view = repository.getRelationshipView("user_a", relationship.id);
    expect(view.interactions).toHaveLength(0);
    expect(view.promises).toHaveLength(0);
  });

  it("creates an enrollment outbox only with an enabled explicit companion intent", () => {
    const draft = importVoiceEnrollmentDraft("user_voice_disabled", "upload_voice_disabled");
    expect(() => repository.updateRecap({
      userId: "user_voice_disabled",
      interactionId: draft.imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "self_raw", role: "self" },
        { speakerId: "partner_raw", role: "companion" }
      ],
      mutations: [{ id: draft.recapItem.id, version: 0, disposition: "kept" }],
      voiceEnrollmentIntents: [{ speakerIds: ["partner_raw"] }],
      voiceEnrollmentEnabled: false,
      finalize: true
    })).toThrowError(expect.objectContaining({ code: "voice_enrollment_disabled" }));

    const view = repository.getRelationshipView("user_voice_disabled", draft.relationship.id);
    expect(view.interactions[0]).toMatchObject({ status: "draft", version: 0 });
    expect(view.interactions[0].recapItems[0].disposition).toBe("pending");
    expect(database.prepare("SELECT COUNT(*) AS count FROM dc_voice_enrollment_outbox").get())
      .toEqual({ count: 0 });
  });

  it("leases enrollment atomically, rejects profile and claim drift, then cascades delete", () => {
    const draft = importVoiceEnrollmentDraft("user_voice", "upload_voice");
    const eligibility = repository.getRelationshipView("user_voice", draft.relationship.id)
      .interactions[0].participants;
    expect(eligibility.find((item) => item.speakerId === "partner_raw"))
      .toMatchObject({ voiceEnrollmentEligible: true });
    expect(eligibility.find((item) => item.speakerId === "self_raw"))
      .not.toHaveProperty("voiceEnrollmentEligible");
    repository.updateRecap({
      userId: "user_voice",
      interactionId: draft.imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "self_raw", role: "self" },
        { speakerId: "partner_raw", role: "companion" }
      ],
      mutations: [{ id: draft.recapItem.id, version: 0, disposition: "kept" }],
      voiceEnrollmentIntents: [{ speakerIds: ["partner_raw"] }],
      voiceEnrollmentEnabled: true,
      finalize: true
    });
    expect(repository.getRelationshipView("user_voice", draft.relationship.id)
      .interactions[0].voiceEnrollment).toEqual({ status: "pending" });
    const outbox = database.prepare(`
      SELECT id, provider_speaker_id, expected_global_speaker_id
      FROM dc_voice_enrollment_outbox
      WHERE user_id = ? AND interaction_id = ?
    `).get("user_voice", draft.imported.interactionId) as {
      id: string;
      provider_speaker_id: string;
      expected_global_speaker_id: string;
    };
    expect(outbox.provider_speaker_id).not.toBe(outbox.expected_global_speaker_id);
    expect(() => repository.claimVoiceEnrollment("other_user", outbox.id))
      .toThrowError(DcNotFoundError);
    expect(repository.listVoiceEnrollmentDispatchCandidates({
      now: "2026-08-05T00:00:00.000Z",
      limit: 10,
      maxAttempts: 3
    })).toEqual([expect.objectContaining({
      outboxId: outbox.id,
      userId: "user_voice",
      status: "pending",
      attemptCount: 0
    })]);

    const firstClaim = repository.claimVoiceEnrollment("user_voice", outbox.id);
    expect(firstClaim).toMatchObject({
      id: outbox.id,
      expectedGlobalSpeakerId: outbox.expected_global_speaker_id,
      sourceUploadId: "upload_voice",
      providerRecordId: "record_upload_voice",
      speakerIds: ["partner_raw"],
      attemptCount: 1
    });
    expect(() => repository.claimVoiceEnrollment("user_voice", outbox.id))
      .toThrowError(expect.objectContaining({ code: "voice_enrollment_already_claimed" }));
    expect(() => repository.completeVoiceEnrollment({
      userId: "user_voice",
      outboxId: outbox.id,
      claimToken: firstClaim.claimToken,
      profileGlobalSpeakerId: "another_contact"
    })).toThrowError(expect.objectContaining({ code: "voice_enrollment_profile_mismatch" }));
    expect(database.prepare(`
      SELECT continuity_key FROM dc_participant_assignments
      WHERE user_id = 'user_voice' AND interaction_id = ? AND speaker_id = 'partner_raw'
    `).get(draft.imported.interactionId)).toEqual({ continuity_key: null });

    database.prepare(`
      UPDATE dc_voice_enrollment_outbox
      SET lease_expires_at = '2000-01-01T00:00:00.000Z'
      WHERE id = ? AND user_id = ?
    `).run(outbox.id, "user_voice");
    const secondClaim = repository.claimVoiceEnrollment("user_voice", outbox.id);
    expect(secondClaim.claimToken).not.toBe(firstClaim.claimToken);
    expect(secondClaim.attemptCount).toBe(2);
    expect(() => repository.completeVoiceEnrollment({
      userId: "user_voice",
      outboxId: outbox.id,
      claimToken: firstClaim.claimToken,
      profileGlobalSpeakerId: outbox.expected_global_speaker_id
    })).toThrowError(expect.objectContaining({ code: "voice_enrollment_stale_claim" }));

    expect(repository.completeVoiceEnrollment({
      userId: "user_voice",
      outboxId: outbox.id,
      claimToken: secondClaim.claimToken,
      profileGlobalSpeakerId: outbox.expected_global_speaker_id
    }).idempotent).toBe(false);
    expect(repository.completeVoiceEnrollment({
      userId: "user_voice",
      outboxId: outbox.id,
      claimToken: secondClaim.claimToken,
      profileGlobalSpeakerId: outbox.expected_global_speaker_id
    }).idempotent).toBe(true);
    expect(repository.getRelationshipView("user_voice", draft.relationship.id)
      .interactions[0].voiceEnrollment).toEqual({ status: "completed" });

    repository.deleteInteraction("user_voice", draft.imported.interactionId, 1);
    expect(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM dc_voice_enrollment_snapshots) AS snapshots,
        (SELECT COUNT(*) FROM dc_voice_enrollment_snapshot_members) AS members,
        (SELECT COUNT(*) FROM dc_voice_enrollment_outbox) AS outbox
    `).get()).toEqual({ snapshots: 0, members: 0, outbox: 0 });
  });

  it("fails closed for an expired snapshot or a non-companion enrollment group", () => {
    const expired = importVoiceEnrollmentDraft("user_expired", "upload_expired");
    database.prepare(`
      UPDATE dc_voice_enrollment_snapshots
      SET expires_at = '2000-01-01T00:00:00.000Z'
      WHERE user_id = ? AND interaction_id = ?
    `).run("user_expired", expired.imported.interactionId);
    expect(repository.getRelationshipView("user_expired", expired.relationship.id)
      .interactions[0].participants.every(
        (participant) => participant.voiceEnrollmentEligible !== true
      )).toBe(true);
    expect(() => repository.updateRecap({
      userId: "user_expired",
      interactionId: expired.imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "self_raw", role: "self" },
        { speakerId: "partner_raw", role: "companion" }
      ],
      mutations: [{ id: expired.recapItem.id, version: 0, disposition: "kept" }],
      voiceEnrollmentIntents: [{ speakerIds: ["partner_raw"] }],
      voiceEnrollmentEnabled: true,
      finalize: true
    })).toThrowError(expect.objectContaining({ code: "voice_enrollment_snapshot_expired" }));
    expect(repository.getRelationshipView("user_expired", expired.relationship.id)
      .interactions[0].status).toBe("draft");

    const wrongRole = importVoiceEnrollmentDraft("user_wrong_role", "upload_wrong_role");
    expect(() => repository.updateRecap({
      userId: "user_wrong_role",
      interactionId: wrongRole.imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "self_raw", role: "companion" },
        { speakerId: "partner_raw", role: "self" }
      ],
      mutations: [{ id: wrongRole.recapItem.id, version: 0, disposition: "kept" }],
      voiceEnrollmentIntents: [{ speakerIds: ["partner_raw"] }],
      voiceEnrollmentEnabled: true,
      finalize: true
    })).toThrowError(DcValidationError);
    expect(repository.getRelationshipView("user_wrong_role", wrongRole.relationship.id)
      .interactions[0].status).toBe("draft");
  });

  it("never offers or accepts bootstrap enrollment for an existing continuity profile", () => {
    const relationship = repository.createOrGetRelationship("user_existing_profile", "Ta").relationship;
    const imported = repository.importInteraction({
      userId: "user_existing_profile",
      relationshipId: relationship.id,
      sourceUploadId: "upload_existing_profile",
      recordingDate: "2026-08-05",
      originalName: "existing.wav",
      participants: [{ speakerId: "partner_existing", continuityKey: "identity_existing" }],
      recapCandidates: [{
        kind: "moment",
        proposedText: "一起散步",
        sortOrder: 0,
        evidence: [{
          uploadId: "upload_existing_profile",
          sourceSegmentId: "segment_existing",
          startSeconds: 0,
          endSeconds: 2,
          speakerId: "partner_existing",
          quote: "一起散步"
        }]
      }]
    });
    repository.saveVoiceEnrollmentSnapshots({
      userId: "user_existing_profile",
      relationshipId: relationship.id,
      interactionId: imported.interactionId,
      snapshots: [{
        reviewGroupId: "partner_existing",
        speakerIds: ["partner_existing"],
        sourceUploadId: "upload_existing_profile",
        providerRecordId: "record_existing",
        chunkId: "chunk_existing",
        localSpeaker: "speaker_1",
        auditStatus: "verified",
        auditReason: "voiceprint_match",
        auditDigest: "d".repeat(64),
        expiresAt: "2099-01-01T00:00:00.000Z"
      }]
    });
    const detail = repository.getRelationshipView("user_existing_profile", relationship.id)
      .interactions[0];
    expect(detail.participants[0]).not.toHaveProperty("voiceEnrollmentEligible");
    expect(() => repository.updateRecap({
      userId: "user_existing_profile",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [{ speakerId: "partner_existing", role: "companion" }],
      mutations: [{ id: detail.recapItems[0].id, version: 0, disposition: "kept" }],
      voiceEnrollmentIntents: [{ speakerIds: ["partner_existing"] }],
      voiceEnrollmentEnabled: true,
      finalize: true
    })).toThrowError(expect.objectContaining({
      code: "voice_enrollment_bootstrap_requires_empty_profile"
    }));
    expect(database.prepare("SELECT COUNT(*) AS count FROM dc_voice_enrollment_outbox").get())
      .toEqual({ count: 0 });
    expect(repository.getRelationshipView("user_existing_profile", relationship.id)
      .interactions[0].status).toBe("draft");
  });

  it("atomically cancels unclaimed enrollment before delete and blocks an in-flight Provider save", () => {
    const finalizeEnrollment = (userId: string, uploadId: string) => {
      const draft = importVoiceEnrollmentDraft(userId, uploadId);
      repository.updateRecap({
        userId,
        interactionId: draft.imported.interactionId,
        version: 0,
        assignments: [
          { speakerId: "self_raw", role: "self" },
          { speakerId: "partner_raw", role: "companion" }
        ],
        mutations: [{ id: draft.recapItem.id, version: 0, disposition: "kept" }],
        voiceEnrollmentIntents: [{ speakerIds: ["partner_raw"] }],
        voiceEnrollmentEnabled: true,
        finalize: true
      });
      const outbox = database.prepare(`
        SELECT id FROM dc_voice_enrollment_outbox
        WHERE user_id = ? AND interaction_id = ?
      `).get(userId, draft.imported.interactionId) as { id: string };
      return { ...draft, outboxId: outbox.id };
    };

    const pending = finalizeEnrollment("user_delete_pending", "upload_delete_pending");
    expect(repository.prepareInteractionDeletion(
      "user_delete_pending",
      pending.imported.interactionId,
      1
    )).toMatchObject({ sourceUploadId: "upload_delete_pending", version: 1 });
    expect(database.prepare(`
      SELECT status, claim_token, lease_expires_at
      FROM dc_voice_enrollment_outbox WHERE id = ?
    `).get(pending.outboxId)).toEqual({
      status: "cancelled",
      claim_token: null,
      lease_expires_at: null
    });
    expect(() => repository.claimVoiceEnrollment(
      "user_delete_pending",
      pending.outboxId
    )).toThrowError(expect.objectContaining({ code: "voice_enrollment_cancelled" }));

    const processing = finalizeEnrollment("user_delete_processing", "upload_delete_processing");
    repository.claimVoiceEnrollment("user_delete_processing", processing.outboxId);
    expect(() => repository.prepareInteractionDeletion(
      "user_delete_processing",
      processing.imported.interactionId,
      1
    )).toThrowError(expect.objectContaining({ code: "voice_enrollment_in_progress" }));
    expect(repository.getRelationshipView(
      "user_delete_processing",
      processing.relationship.id
    ).interactions).toHaveLength(1);
  });
});
