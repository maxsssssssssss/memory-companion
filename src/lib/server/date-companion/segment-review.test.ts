// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDateCompanionDatabase } from "./db";
import { openMemoryDatabase } from "../memory/db";
import { DateCompanionRepository } from "./repository";
import { PreparationSources } from "./preparation-sources";
import { processDateCompanionMemoryBridgeInteraction } from "./memory-bridge-consumer";
import { createDateCompanionMemoryBridgeRepository } from "./memory-bridge-repository";
import { getOrCreateDateCompanionSubjectSuggestionBatch } from "./subject-suggestions";
import { buildDateCompanionRelationshipQaContext } from "./relationship-qa";

describe("recording-local segment review", () => {
  let database: ReturnType<typeof openDateCompanionDatabase>, memory: ReturnType<typeof openMemoryDatabase>;
  beforeEach(() => {
    database = openDateCompanionDatabase({filePath:":memory:"});
    memory = openMemoryDatabase({filePath:":memory:"});
  });
  afterEach(() => { database.close(); memory.close(); });

  function seed() {
    const repo = new DateCompanionRepository(database);
    const userId = "r06-reviewer", uploadId = "r06-recording", speakerId = "same-provider-label";
    const relationshipId = repo.createOrGetRelationship(userId).relationship.id;
    const quotes = ["我会发样图。地址还没有确定。", "我答应周五前寄纸样。", "画册没有下单。"];
    const { interactionId } = repo.importInteraction({ userId, relationshipId, sourceUploadId:uploadId, recordingDate:"2026-11-12",
      originalName:"双人合成测试.wav", participants:[{speakerId}], recapCandidates:quotes.map((quote, i) => ({
        kind:i === 1 ? "promise" : "mentioned", proposedText:quote, sortOrder:i, evidence:[{
          uploadId, sourceSegmentId:"seg-"+i, startSeconds:i*5, endSeconds:i*5+4, speakerId, quote
        }]
      }))
    });
    const detail = () => repo.getInteractionDetail(userId,relationshipId,interactionId);
    const draft = detail();
    const reviewedSegments = draft.recapItems.slice(1).map((item,i) => ({
      sourceSegmentId:item.evidence[0].sourceSegmentId, contentDigest:item.evidence[0].contentDigest!,
      role:i === 0 ? "self" as const : "companion" as const
    }));
    const assignments = [{ speakerId, role:"unresolved" as const, reviewedSegments }];
    const mutations = draft.recapItems.map((item,i) => ({
      id:item.id, version:item.version, disposition:i === 0 ? "excluded" as const : "kept" as const,
      ...(i === 1 ? {userText:"在周五前寄纸样（编辑后的概括）"} : {})
    }));
    return {repo,userId,uploadId,speakerId,relationshipId,interactionId,draft,detail,assignments,mutations,reviewedSegments};
  }

  it("binds each confirmation to an existing snapshot and protects saved split drafts against old group updates", () => {
    const s = seed();
    const update = (assignments: typeof s.assignments) => s.repo.updateParticipants({...s, version:0, assignments});
    const withSegments = (segments: typeof s.reviewedSegments) => [{...s.assignments[0], reviewedSegments:segments}];
    expect(() => update(withSegments([{...s.reviewedSegments[0], sourceSegmentId:"different-recording-segment"}]))).toThrow("segment_review_evidence_mismatch");
    expect(() => update(withSegments([{...s.reviewedSegments[0], contentDigest:"0".repeat(64)}]))).toThrow("segment_review_evidence_mismatch");
    expect(() => update(withSegments([s.reviewedSegments[0], s.reviewedSegments[0]]))).toThrow("invalid_segment_review");
    update(s.assignments);
    expect(s.detail()).toMatchObject({status:"draft", version:1, participants:[{role:"unresolved", reviewedSegments:s.reviewedSegments}]});
    expect(() => s.repo.updateParticipants({...s, version:1, assignments:[{speakerId:s.speakerId,role:"self"}]})).toThrow("individual_speaker_review_required");
    expect(() => s.repo.updateRecap({...s, version:1, finalize:true, mutations:s.mutations.map(m=>({...m,disposition:"kept"}))})).toThrow("participant_assignment_required");
    expect(s.detail().recapItems.every(i=>i.disposition==="pending")).toBe(true);
    expect(s.repo.getRelationshipView(s.userId,s.relationshipId).promises).toEqual([]);
  });

  it("persists an explicit all-unknown draft without admitting anything or fabricating a completed recap", () => {
    const s = seed();
    s.repo.updateParticipants({...s,version:0,assignments:[{...s.assignments[0],reviewedSegments:[]}]});
    const draft = s.detail();
    expect(draft).toMatchObject({status:"draft", participants:[{role:"unresolved",reviewedSegments:[]}]});
    expect(draft.recapItems.map(i=>i.evidence)).toEqual(s.draft.recapItems.map(i=>i.evidence));
    expect(buildDateCompanionRelationshipQaContext(s.repo.getRelationshipView(s.userId,s.relationshipId)).segments).toEqual([]);
    expect(database.prepare("SELECT count(*) AS n FROM dc_memory_bridge_outbox").get()).toEqual({n:0});
  });

  it("carries only audited pure segments through finalization, source review and actual cross-database admission", async () => {
    const s = seed();
    const people = memory.prepare("INSERT INTO person_entities(id,account_id,display_name,source,status,created_at,updated_at) VALUES(?,?,?,'manual_confirmation','confirmed',?,?)");
    const time = new Date().toISOString();
    people.run("r06-i",s.userId,"我",time,time); people.run("r06-ta",s.userId,"Ta",time,time);
    memory.prepare("INSERT INTO person_self_bindings(account_id,person_id,status,version,set_at,created_at,updated_at) VALUES(?,?,'active',1,?,?,?)").run(s.userId,"r06-i",time,time,time);
    const bridge = createDateCompanionMemoryBridgeRepository(database);
    const mapping = bridge.putPersonMapping({...s,selfPersonId:"r06-i",companionPersonId:"r06-ta",relationshipType:"dating",expectedVersion:0});
    // Only the subject-classification provider is replaced. Selection, validation, queue payload and consumer are real.
    const batch = await getOrCreateDateCompanionSubjectSuggestionBatch({database,userId:s.userId,interactionId:s.interactionId,
      draftPreview:{version:0,itemIds:s.draft.recapItems.slice(1).map(i=>i.id),assignments:s.assignments},provider:{
      model:"Qwen/Qwen3.6-27B", suggest:async sources=>sources.map(source=>({
        canonicalSourceKey:source.canonicalSourceKey,confidence:1,
        ...(source.quote === "我答应周五前寄纸样。" ? {proposedSubject:"self" as const, reasonCode:"explicit_self_reference" as const}
          : {proposedSubject:"companion" as const,reasonCode:"explicit_companion_reference" as const})
      }))
    }});
    const finalize = {...s,version:0,finalize:true,memoryAdmission:{
      mappingVersion:mapping.version,subjectSuggestionConfirmation:{batchId:batch.batchId,evidenceDigest:batch.evidenceDigest,
      proposalDigest:batch.proposalDigest,confirmationFingerprint:batch.confirmationFingerprint,confirmedVisibleSuggestions:true as const},
      selections:s.draft.recapItems.slice(1).map((item,i)=>({evidenceSnapshotId:item.evidence[0].id,subject:i===0?"self" as const:"companion" as const}))
    }};
    s.repo.updateRecap(finalize);
    s.repo.updateRecap(finalize);
    expect(() => s.repo.updateRecap({...finalize,assignments:[{...s.assignments[0],reviewedSegments:[]}]})).toThrow("confirmation_payload_conflict");
    const saved = s.detail();
    expect(saved.recapItems.map(i=>i.evidence)).toEqual(s.draft.recapItems.map(i=>i.evidence));
    expect(saved.recapItems[1].displayedText).not.toEqual(saved.recapItems[1].evidence[0].quote);
    expect(saved.participants[0]).toMatchObject({role:"unresolved",reviewedSegments:s.reviewedSegments});
    const view = s.repo.getRelationshipView(s.userId,s.relationshipId);
    expect(view.promises).toHaveLength(1);
    expect(buildDateCompanionRelationshipQaContext(view).segments.map(line=>[line.id,line.speaker])).toEqual([["seg-1","我"],["seg-2","Ta"]]);
    const sourceReader = new PreparationSources(database,{memoryDatabase:memory});
    const selected = sourceReader.reviewSources(s.userId,s.relationshipId,s.interactionId);
    expect(selected.map(source=>source.speakerRole)).toEqual(["self","companion"]);
    expect(sourceReader.read(s.userId,s.relationshipId,[s.interactionId],s.draft.recapItems[0].evidence[0].id)).toBeNull();
    s.repo.markUploadSourceState(s.userId,s.uploadId,"server_cleaned");
    await processDateCompanionMemoryBridgeInteraction({dateCompanionDatabase:database,memoryDatabase:memory,userId:s.userId,interactionId:s.interactionId});
    expect(s.detail().memoryBridge?.status).toBe("completed");
    expect(memory.prepare("SELECT DISTINCT source_segment_id FROM person_evidence ORDER BY source_segment_id").all())
      .toEqual([{source_segment_id:"seg-1"},{source_segment_id:"seg-2"}]);
    const retained = sourceReader.personSources(s.userId,s.relationshipId,true);
    expect(retained.map(source => [source.quote,source.speakerRole])).toContainEqual(["画册没有下单。","companion"]);
    expect(retained.map(source=>source.quote)).not.toContain(s.draft.recapItems[0].evidence[0].quote);
    database.prepare("UPDATE dc_evidence_snapshots SET quote=? WHERE user_id=? AND source_segment_id=?")
      .run("同 ID 的替换原文",s.userId,"seg-2");
    expect(s.detail().participants[0].reviewedSegments?.map(segment=>segment.sourceSegmentId)).toEqual(["seg-1"]);
    expect(sourceReader.reviewSources(s.userId,s.relationshipId,s.interactionId).map(source=>source.speakerRole)).toEqual(["self"]);
  });
});
