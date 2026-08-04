import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { openDateCompanionDatabase } from "./db";
import {
  DateCompanionRepository,
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
      speakerIds: ["speaker_0", "speaker_1"],
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

  it("migrates an isolated schema and enforces one current relationship per user", () => {
    const tables = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'dc_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
      "dc_relationships",
      "dc_interactions",
      "dc_participant_assignments",
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
    ).all()).toEqual([{ version: 1 }, { version: 2 }]);
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

  it("imports an upload idempotently and permits repeated fixture segment ids across uploads", () => {
    const first = importDraft("user_a", "upload_1");
    const reused = repository.importInteraction({
      userId: "user_a",
      relationshipId: first.relationship.id,
      sourceUploadId: "upload_1",
      recordingDate: "1970-01-01",
      originalName: "ignored.wav",
      speakerIds: [],
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
      speakerIds: [],
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

    repository.updateParticipants({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ]
    });
    view = repository.getRelationshipView("user_a", relationship.id);
    interaction = view.interactions[0];
    const confirmationRequest = {
      userId: "user_a",
      interactionId: interaction.id,
      version: interaction.version,
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
      mutations: [...confirmationRequest.mutations].reverse()
    })).toEqual({ idempotent: true });
    expect(repository.getRelationshipView("user_a", relationship.id).promises).toHaveLength(1);
    expect(() => repository.updateRecap({
      ...confirmationRequest,
      mutations: []
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
      speakerIds: [],
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
    repository.updateRecap({
      userId: "user_a",
      interactionId: interaction.id,
      version: interaction.version,
      mutations: interaction.recapItems.map((item) => ({
        id: item.id,
        version: item.version,
        disposition: item.kind === "continue" ? "excluded" as const : "kept" as const
      })),
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
});
