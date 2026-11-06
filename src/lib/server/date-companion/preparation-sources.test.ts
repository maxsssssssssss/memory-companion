// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDateCompanionDatabase } from "./db";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { DateCompanionRepository } from "./repository";
import { PreparationSources } from "./preparation-sources";
import { createDateCompanionMemoryBridgeRepository } from "./memory-bridge-repository";
import { getOrCreateDateCompanionSubjectSuggestionBatch } from "./subject-suggestions";
import { processDateCompanionMemoryBridgeInteraction } from "./memory-bridge-consumer";

describe("preparation source authorization", () => {
  let db: Database.Database;
  let memory: Database.Database;
  let repo: DateCompanionRepository;
  let sources: PreparationSources;
  beforeEach(() => {
    db = openDateCompanionDatabase({ filePath: ":memory:" });
    memory = openMemoryDatabase({ filePath: ":memory:" });
    repo = new DateCompanionRepository(db);
    sources = new PreparationSources(db, { memoryDatabase: memory });
  });
  afterEach(() => { db.close(); memory.close(); });

  function seed(userId = "source_user", upload = "source_upload") {
    const relationship = repo.createOrGetRelationship(userId).relationship;
    const imported = repo.importInteraction({ userId, relationshipId: relationship.id,
      sourceUploadId: upload, recordingDate: "2026-11-01", originalName: "synthetic.wav",
      participants: [{ speakerId: "self" }, { speakerId: "ta" }],
      recapCandidates: [
        { kind: "mentioned", proposedText: "想聊旅行", sortOrder: 0,
          evidence: [{ uploadId: upload, sourceSegmentId: `${upload}_travel`, startSeconds: 0, endSeconds: 3, speakerId: "ta", quote: "下次想去云南旅行" }] },
        { kind: "promise", proposedText: "我答应发旅行攻略", sortOrder: 1,
          evidence: [{ uploadId: upload, sourceSegmentId: `${upload}_promise`, startSeconds: 3, endSeconds: 5, speakerId: "self", quote: "我把旅行攻略发给你" }] },
        { kind: "moment", proposedText: "排除的旅行", sortOrder: 2,
          evidence: [{ uploadId: upload, sourceSegmentId: `${upload}_excluded`, startSeconds: 5, endSeconds: 7, speakerId: "ta", quote: "这句旅行内容不保留" }] }
      ] });
    const draft = repo.getInteractionDetail(userId, relationship.id, imported.interactionId);
    repo.updateRecap({ userId, interactionId: imported.interactionId, version: 0,
      assignments: [{ speakerId: "self", role: "self" }, { speakerId: "ta", role: "companion" }],
      mutations: draft.recapItems.map((item, index) => ({ id: item.id, version: 0, disposition: index === 2 ? "excluded" : "kept" })), finalize: true });
    return { relationshipId: relationship.id, interactionId: imported.interactionId };
  }

  it("loads just the authorized interaction for a review and read without loading the full relationship", () => {
    const first = seed();
    const other = seed("source_user", "different-upload");
    const foreign = seed("other_user", "foreign-upload");
    const full = vi.spyOn(DateCompanionRepository.prototype, "getRelationshipView");
    const detail = vi.spyOn(DateCompanionRepository.prototype, "getInteractionDetail");
    try {
      const quotes = sources.reviewSources("source_user", first.relationshipId, first.interactionId);
      expect(quotes.map(source => source.interactionId)).toEqual([first.interactionId, first.interactionId]);
      expect(sources.read("source_user", first.relationshipId, [first.interactionId], quotes[0].id)).toEqual(quotes[0]);
      expect(detail.mock.calls.map(call => call[2])).toEqual([first.interactionId, first.interactionId]);
      expect(detail.mock.calls.some(call => call[2] === other.interactionId)).toBe(false);
      expect(sources.reviewSources("source_user", first.relationshipId, foreign.interactionId)).toEqual([]);
      expect(full).not.toHaveBeenCalled();
    } finally {
      full.mockRestore();
      detail.mockRestore();
    }
  });

  it("uses only selected confirmed canonical sources without creating Memory or Person records", () => {
    const seedResult = seed();
    const { relationshipId, interactionId } = seedResult;
    expect(sources.available("source_user", relationshipId)).toEqual([{ id: interactionId, recordingDate: "2026-11-01", title: "synthetic.wav", reviewAvailable: true }]);
    expect(sources.search("source_user", relationshipId, [], "旅行")).toEqual([]);
    const result = sources.search("source_user", relationshipId, [interactionId], "旅行");
    expect(result).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("不保留");
    expect(result.every(item => item.origin === "direct_conversation" && item.fingerprint.length === 64)).toBe(true);
    expect(sources.read("source_user", relationshipId, [interactionId], result[0].id)).toEqual(result[0]);
    expect(memory.prepare("SELECT COUNT(*) AS n FROM person_entities").get()).toEqual({ n: 0 });
    expect(memory.prepare("SELECT COUNT(*) AS n FROM memory_items").get()).toEqual({ n: 0 });
    expect(sources.personSources("source_user", relationshipId, true)).toEqual([]);
  });

  it("rejects cross-account and cross-relationship scope and never turns empty scope into all history", () => {
    const first = seed();
    const second = seed("other_user", "other_upload");
    expect(() => sources.available("other_user", first.relationshipId)).toThrow();
    expect(() => sources.validateScope("source_user", first.relationshipId, [second.interactionId])).toThrow();
    expect(() => sources.validateScope("source_user", first.relationshipId, [first.interactionId, first.interactionId])).toThrow();
    expect(sources.search("source_user", first.relationshipId, [second.interactionId], "旅行")).toEqual([]);
    const source = sources.search("source_user", first.relationshipId, [first.interactionId], "旅行")[0];
    expect(sources.read("source_user", first.relationshipId, [], source.id)).toBeNull();
  });

  it("returns existing Promise authority only when all its original sources remain authorized", () => {
    const { relationshipId, interactionId } = seed();
    expect(sources.promises("source_user", relationshipId, [])).toEqual([]);
    const promises = sources.promises("source_user", relationshipId, [interactionId]);
    expect(promises).toHaveLength(1);
    expect(promises[0]).toMatchObject({ text: "我答应发旅行攻略", status: "open", sources: [expect.objectContaining({ quote: "我把旅行攻略发给你" })] });
    repo.patchPromise({ userId: "source_user", promiseId: promises[0].id, version: 0, status: "done" });
    expect(sources.promises("source_user", relationshipId, [interactionId])[0].status).toBe("done");
  });

  it("revalidates deletion, speaker correction and canonical digest before a saved citation can be reused", () => {
    const { relationshipId, interactionId } = seed();
    const source = sources.search("source_user", relationshipId, [interactionId], "云南")[0];
    db.prepare("UPDATE dc_evidence_snapshots SET quote = '篡改的旅行原话' WHERE id = ?").run(source.id);
    expect(sources.read("source_user", relationshipId, [interactionId], source.id)).toBeNull();
    const promise = sources.search("source_user", relationshipId, [interactionId], "攻略")[0];
    db.prepare("UPDATE dc_participant_assignments SET role = 'unresolved', confirmed_at = NULL WHERE interaction_id = ? AND speaker_id = 'self'").run(interactionId);
    expect(sources.read("source_user", relationshipId, [interactionId], promise.id)).toBeNull();
    db.prepare("UPDATE dc_interactions SET source_state = 'explicitly_deleted' WHERE id = ?").run(interactionId);
    expect(sources.available("source_user", relationshipId)).toEqual([]);
    expect(sources.search("source_user", relationshipId, [interactionId], "旅行")).toEqual([]);
  });

  it("retains canonical quotes after ordinary server cleanup but fences an archived relationship", () => {
    const { relationshipId, interactionId } = seed();
    const source = sources.search("source_user", relationshipId, [interactionId], "云南")[0];
    db.prepare("UPDATE dc_interactions SET source_state = 'server_cleaned' WHERE id = ?").run(interactionId);
    expect(sources.read("source_user", relationshipId, [interactionId], source.id)?.quote).toBe("下次想去云南旅行");
    db.prepare("UPDATE dc_relationships SET status = 'archived' WHERE id = ?").run(relationshipId);
    expect(() => sources.read("source_user", relationshipId, [interactionId], source.id)).toThrow();
  });

  it("reuses formally admitted Person sources only inside allowed scope and immediately fences mapping withdrawal", async () => {
    const userId = "retained_user", now = "2026-11-01T00:00:00.000Z";
    const relationshipId = repo.createOrGetRelationship(userId).relationship.id;
    const insertPerson = memory.prepare("INSERT INTO person_entities(id,account_id,display_name,source,status,created_at,updated_at) VALUES(?,?,?,'manual_confirmation','confirmed',?,?)");
    insertPerson.run("retained_self", userId, "我", now, now);
    insertPerson.run("retained_ta", userId, "Ta", now, now);
    memory.prepare("INSERT INTO person_self_bindings(account_id,person_id,status,version,set_at,created_at,updated_at) VALUES(?,?,'active',1,?,?,?)").run(userId,"retained_self",now,now,now);
    const bridge = createDateCompanionMemoryBridgeRepository(db);
    const mappingVersion = bridge.putPersonMapping({userId,relationshipId,selfPersonId:"retained_self",companionPersonId:"retained_ta",relationshipType:"dating",expectedVersion:0}).version;
    const imported = repo.importInteraction({userId,relationshipId,sourceUploadId:"retained_upload",recordingDate:"2026-11-01",originalName:"synthetic.wav",participants:[{speakerId:"ta"}],recapCandidates:[{
      kind:"mentioned",proposedText:"Ta喜欢旅行",sortOrder:0,evidence:[{uploadId:"retained_upload",sourceSegmentId:"retained_segment",startSeconds:0,endSeconds:4,speakerId:"ta",quote:"我喜欢在秋天旅行"}]
    }]});
    const draft = repo.getInteractionDetail(userId,relationshipId,imported.interactionId);
    const batch = await getOrCreateDateCompanionSubjectSuggestionBatch({database:db,userId,interactionId:imported.interactionId,provider:{model:"Qwen/Qwen3.6-27B",suggest:async entries=>entries.map(entry=>({canonicalSourceKey:entry.canonicalSourceKey,proposedSubject:"companion" as const,confidence:1,reasonCode:"explicit_companion_reference" as const}))}});
    repo.updateRecap({userId,interactionId:imported.interactionId,version:0,assignments:[{speakerId:"ta",role:"companion"}],mutations:draft.recapItems.map(item=>({id:item.id,version:0,disposition:"kept"})),finalize:true,memoryAdmission:{mappingVersion,subjectSuggestionConfirmation:{batchId:batch.batchId,evidenceDigest:batch.evidenceDigest,proposalDigest:batch.proposalDigest,confirmationFingerprint:batch.confirmationFingerprint,confirmedVisibleSuggestions:true},selections:draft.recapItems.flatMap(item=>item.evidence.map(source=>({evidenceSnapshotId:source.id,subject:"companion" as const})))}});
    repo.markUploadSourceState(userId,"retained_upload","server_cleaned");
    await processDateCompanionMemoryBridgeInteraction({dateCompanionDatabase:db,memoryDatabase:memory,userId,interactionId:imported.interactionId});
    expect(sources.personSources(userId,relationshipId)).toEqual([]);
    const retained = sources.personSources(userId,relationshipId,true);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({quote:"我喜欢在秋天旅行",origin:"direct_conversation",speakerRole:"companion"});
    expect(sources.read(userId,relationshipId,[],retained[0].id,false)).toBeNull();
    expect(sources.search(userId,relationshipId,[],"旅行",true)).toHaveLength(1);
    db.prepare("UPDATE dc_relationship_person_mappings SET status='needs_review', version=version+1 WHERE user_id=?").run(userId);
    expect(sources.read(userId,relationshipId,[],retained[0].id,true)).toBeNull();
  });
});
