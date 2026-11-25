import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

import { openDateCompanionDatabase } from "./db";
import { createDateCompanionMemoryBridgeRepository } from "./memory-bridge-repository";
import { DateCompanionRepository } from "./repository";
import { DateCompanionSubjectSuggestionRepository } from "./subject-suggestion-repository";
import {
  getDateCompanionSubjectSuggestionBatchStatus,
  getOrCreateDateCompanionSubjectSuggestionBatch,
  validateDateCompanionSubjectSuggestionConfirmation
} from "./subject-suggestions";
import {
  SubjectSuggestionProviderUnavailableError,
  type DateCompanionSubjectSuggestionProvider
} from "./subject-suggestion-provider";

describe("Date Companion Subject suggestion batches", () => {
  let database: Database.Database;
  let repository: DateCompanionRepository;

  beforeEach(() => {
    database = openDateCompanionDatabase({ filePath: ":memory:" });
    repository = new DateCompanionRepository(database);
  });

  afterEach(() => database.close());

  function seed(userId = "user_a", draft = false) {
    const relationship = repository.createOrGetRelationship(userId, "Ta").relationship;
    const imported = repository.importInteraction({
      userId,
      relationshipId: relationship.id,
      sourceUploadId: `upload_${userId}`,
      recordingDate: "2026-08-18",
      originalName: "subject.wav",
      participants: [{ speakerId: "speaker_1" }],
      recapCandidates: [
        {
          kind: "moment",
          proposedText: "一起去看展",
          sortOrder: 0,
          evidence: [{
            uploadId: `upload_${userId}`,
            sourceSegmentId: "segment_shared",
            startSeconds: 1,
            endSeconds: 4,
            speakerId: "speaker_1",
            quote: "我们下周一起去看展吧"
          }]
        },
        {
          kind: "continue",
          proposedText: "下周看展",
          sortOrder: 1,
          evidence: [{
            uploadId: `upload_${userId}`,
            sourceSegmentId: "segment_shared",
            startSeconds: 1,
            endSeconds: 4,
            speakerId: "speaker_1",
            quote: "我们下周一起去看展吧"
          }]
        }
      ]
    });
    const bridge = createDateCompanionMemoryBridgeRepository(database);
    bridge.putRetentionSetting({ userId, enabled: true, expectedVersion: 0 });
    const mapping = bridge.putPersonMapping({
      userId,
      relationshipId: relationship.id,
      selfPersonId: `person_${userId}_self`,
      companionPersonId: `person_${userId}_companion`,
      relationshipType: "dating",
      expectedVersion: 0
    });
    const interactionId = imported.interactionId;
    const detail = repository.getInteractionDetail(userId, relationship.id, interactionId);
    const assignments = [{ speakerId: "speaker_1", role: "companion" as const }];
    const draftPreview = { version: detail.version, itemIds: detail.recapItems.map(item => item.id), assignments };
    if (!draft) repository.updateRecap({
      userId, interactionId, version: detail.version, assignments,
      mutations: detail.recapItems.map(item => ({id:item.id,version:item.version,disposition:"kept"})),
      finalize: true, skipMemoryAdmission: true
    });
    return { relationship, interactionId, mapping, draftPreview };
  }

  function provider(
    suggest = vi.fn<DateCompanionSubjectSuggestionProvider["suggest"]>(async (sources) =>
      sources.map((source) => ({
        canonicalSourceKey: source.canonicalSourceKey,
        proposedSubject: "both" as const,
        confidence: 0.97,
        reasonCode: "mutual_relationship_context" as const
      }))
    )
  ): DateCompanionSubjectSuggestionProvider & { suggest: typeof suggest } {
    return { model: "Qwen/Qwen3.6-27B", suggest };
  }

  it("deduplicates canonical Evidence once and safely expands to every snapshot", async () => {
    const { interactionId, mapping } = seed();
    const mocked = provider();
    const batch = await getOrCreateDateCompanionSubjectSuggestionBatch({
      database,
      userId: "user_a",
      interactionId,
      provider: mocked
    });
    expect(mocked.suggest).toHaveBeenCalledTimes(1);
    expect(mocked.suggest.mock.calls[0][0]).toHaveLength(1);
    expect(batch.mappingVersion).toBe(mapping.version);
    expect(batch.suggestions).toHaveLength(1);
    expect(batch.suggestions[0].recapItemIds).toHaveLength(2);
    expect(batch.suggestions[0].evidenceSnapshotIds).toHaveLength(2);

    const repeated = await getOrCreateDateCompanionSubjectSuggestionBatch({
      database,
      userId: "user_a",
      interactionId,
      provider: mocked
    });
    expect(repeated).toEqual(batch);
    expect(mocked.suggest).toHaveBeenCalledTimes(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM dc_memory_subject_selections").get())
      .toEqual({ count: 0 });
  });

  it("reports the current immutable key without invoking Provider generation", async () => {
    const { relationship, interactionId, mapping } = seed();
    const before = getDateCompanionSubjectSuggestionBatchStatus({
      database,
      userId: "user_a",
      interactionId
    });
    expect(before).toMatchObject({
      status: "idle",
      interactionId,
      interactionVersion: 1,
      mappingVersion: mapping.version
    });
    const claims = new DateCompanionSubjectSuggestionRepository(database);
    const claimToken = "status-reader-owner";
    expect(claims.claimGeneration({
      key: {
        userId: "user_a",
        interactionId,
        interactionVersion: before.interactionVersion,
        mappingVersion: before.mappingVersion,
        evidenceDigest: before.evidenceDigest
      },
      relationshipId: relationship.id,
      claimToken,
      now: "2026-08-18T08:00:00.000Z",
      leaseExpiresAt: "2026-08-18T08:05:00.000Z"
    })).toEqual({ kind: "owner", claimToken });
    expect(getDateCompanionSubjectSuggestionBatchStatus({
      database,
      userId: "user_a",
      interactionId,
      now: "2026-08-18T08:01:00.000Z"
    }).status).toBe("processing");
    expect(claims.releaseGeneration({
      userId: "user_a",
      interactionId,
      interactionVersion: before.interactionVersion,
      mappingVersion: before.mappingVersion,
      evidenceDigest: before.evidenceDigest
    }, claimToken)).toBe(1);

    const mocked = provider();
    const batch = await getOrCreateDateCompanionSubjectSuggestionBatch({
      database,
      userId: "user_a",
      interactionId,
      provider: mocked
    });
    const after = getDateCompanionSubjectSuggestionBatchStatus({
      database,
      userId: "user_a",
      interactionId
    });
    expect(after).toEqual({
      status: "ready",
      interactionId,
      interactionVersion: batch.interactionVersion,
      mappingVersion: batch.mappingVersion,
      evidenceDigest: batch.evidenceDigest,
      batch
    });
    expect(mocked.suggest).toHaveBeenCalledTimes(1);
  });

  it("single-flights concurrent requests for the same immutable batch key", async () => {
    const { interactionId } = seed();
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const suggest = vi.fn<DateCompanionSubjectSuggestionProvider["suggest"]>(async (sources) => {
      expect(database.inTransaction).toBe(false);
      await providerGate;
      return sources.map((source) => ({
        canonicalSourceKey: source.canonicalSourceKey,
        proposedSubject: "both" as const,
        confidence: 0.97,
        reasonCode: "mutual_relationship_context" as const
      }));
    });
    const mocked = provider(suggest);
    const first = getOrCreateDateCompanionSubjectSuggestionBatch({
      database,
      userId: "user_a",
      interactionId,
      provider: mocked,
      singleflight: { pollIntervalMs: 1, waitTimeoutMs: 1_000 }
    });
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1));
    expect(database.prepare("SELECT COUNT(*) AS count FROM dc_subject_suggestion_claims").get())
      .toEqual({ count: 1 });

    const second = getOrCreateDateCompanionSubjectSuggestionBatch({
      database,
      userId: "user_a",
      interactionId,
      provider: mocked,
      singleflight: { pollIntervalMs: 1, waitTimeoutMs: 1_000 }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(suggest).toHaveBeenCalledTimes(1);
    releaseProvider();

    const [firstBatch, secondBatch] = await Promise.all([first, second]);
    expect(secondBatch).toEqual(firstBatch);
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM dc_subject_suggestion_batches").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dc_subject_suggestion_claims").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dc_relationship_person_mappings").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dc_memory_subject_selections").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dc_memory_bridge_outbox").get())
      .toEqual({ count: 0 });
  });

  it("allows a stale lease takeover and fences the previous Provider owner from writing", async () => {
    const { interactionId } = seed();
    let releaseStaleProvider!: () => void;
    const staleProviderGate = new Promise<void>((resolve) => {
      releaseStaleProvider = resolve;
    });
    const staleSuggest = vi.fn<DateCompanionSubjectSuggestionProvider["suggest"]>(async (sources) => {
      await staleProviderGate;
      return sources.map((source) => ({
        canonicalSourceKey: source.canonicalSourceKey,
        proposedSubject: "self" as const,
        confidence: 0.91,
        reasonCode: "explicit_self_reference" as const
      }));
    });
    const winningSuggest = vi.fn<DateCompanionSubjectSuggestionProvider["suggest"]>(async (sources) =>
      sources.map((source) => ({
        canonicalSourceKey: source.canonicalSourceKey,
        proposedSubject: "both" as const,
        confidence: 0.98,
        reasonCode: "mutual_relationship_context" as const
      }))
    );
    const staleRequest = getOrCreateDateCompanionSubjectSuggestionBatch({
      database,
      userId: "user_a",
      interactionId,
      provider: provider(staleSuggest),
      singleflight: { leaseMs: 5, pollIntervalMs: 1, waitTimeoutMs: 1_000 }
    });
    await vi.waitFor(() => expect(staleSuggest).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 15));

    const winningBatch = await getOrCreateDateCompanionSubjectSuggestionBatch({
      database,
      userId: "user_a",
      interactionId,
      provider: provider(winningSuggest),
      singleflight: { leaseMs: 1_000, pollIntervalMs: 1, waitTimeoutMs: 1_000 }
    });
    expect(winningBatch.suggestions[0].proposedSubject).toBe("both");
    releaseStaleProvider();
    const fencedBatch = await staleRequest;

    expect(fencedBatch).toEqual(winningBatch);
    expect(staleSuggest).toHaveBeenCalledTimes(1);
    expect(winningSuggest).toHaveBeenCalledTimes(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM dc_subject_suggestion_batches").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dc_subject_suggestion_claims").get())
      .toEqual({ count: 0 });
  });

  it("releases an owned claim after a retryable Provider failure", async () => {
    const { interactionId } = seed();
    const unavailable = provider(vi.fn(async () => {
      throw new SubjectSuggestionProviderUnavailableError();
    }));
    await expect(getOrCreateDateCompanionSubjectSuggestionBatch({
      database,
      userId: "user_a",
      interactionId,
      provider: unavailable
    })).rejects.toThrowError(/subject_suggestion_provider_unavailable/u);
    expect(database.prepare("SELECT COUNT(*) AS count FROM dc_subject_suggestion_claims").get())
      .toEqual({ count: 0 });

    const retried = provider();
    await getOrCreateDateCompanionSubjectSuggestionBatch({
      database,
      userId: "user_a",
      interactionId,
      provider: retried
    });
    expect(retried.suggest).toHaveBeenCalledTimes(1);
  });

  it("does not turn proposed Subjects into formal selections without explicit batch confirmation", async () => {
    const { relationship, interactionId, mapping, draftPreview } = seed("user_a", true);
    const batch = await getOrCreateDateCompanionSubjectSuggestionBatch({
      database,
      userId: "user_a",
      interactionId,
      provider: provider(), draftPreview
    });
    const interaction = repository.getRelationshipView("user_a", relationship.id)
      .interactions.find((item) => item.id === interactionId)!;
    expect(() => repository.updateRecap({
      userId: "user_a",
      interactionId,
      version: interaction.version,
      assignments: [{ speakerId: "speaker_1", role: "companion" }],
      mutations: interaction.recapItems.map((item) => ({
        id: item.id,
        version: item.version,
        disposition: "kept" as const
      })),
      memoryAdmission: {
        mappingVersion: mapping.version,
        selections: batch.suggestions.flatMap((suggestion) =>
          suggestion.evidenceSnapshotIds.map((evidenceSnapshotId) => ({
            evidenceSnapshotId,
            subject: suggestion.proposedSubject
          }))
        )
      },
      finalize: true
    })).toThrowError(/subject_suggestion_confirmation_required/u);
    expect(database.prepare("SELECT COUNT(*) AS count FROM dc_memory_subject_selections").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM dc_memory_bridge_outbox").get())
      .toEqual({ count: 0 });
  });

  it("stores malformed batch output only as unknown degraded proposals", async () => {
    const { interactionId } = seed();
    const mocked = provider(vi.fn(async () => []));
    const batch = await getOrCreateDateCompanionSubjectSuggestionBatch({
      database,
      userId: "user_a",
      interactionId,
      provider: mocked
    });
    expect(batch.status).toBe("degraded");
    expect(batch.suggestions).toEqual([
      expect.objectContaining({
        proposedSubject: "unknown",
        confidence: 0,
        reasonCode: "provider_output_invalid"
      })
    ]);
  });

  it("keeps the Evidence-level Subject batch valid when the user edits final recap text", async () => {
    const { interactionId, mapping } = seed();
    const batch = await getOrCreateDateCompanionSubjectSuggestionBatch({
      database,
      userId: "user_a",
      interactionId,
      provider: provider()
    });
    const evidenceSnapshotIds = batch.suggestions.flatMap((item) => item.evidenceSnapshotIds).sort();
    database.prepare(`
      UPDATE dc_recap_items SET user_text = ?
      WHERE user_id = ? AND interaction_id = ? AND id = (
        SELECT id FROM dc_recap_items
        WHERE user_id = ? AND interaction_id = ?
        ORDER BY sort_order, id LIMIT 1
      )
    `).run("用户修改后的整理文字", "user_a", interactionId, "user_a", interactionId);

    const current = getDateCompanionSubjectSuggestionBatchStatus({
      database,
      userId: "user_a",
      interactionId
    });
    expect(current.status).toBe("ready");
    expect(current.evidenceDigest).toBe(batch.evidenceDigest);
    expect(validateDateCompanionSubjectSuggestionConfirmation({
      database,
      userId: "user_a",
      interactionId,
      interactionVersion: batch.interactionVersion,
      mappingVersion: mapping.version,
      confirmation: {
        batchId: batch.batchId,
        evidenceDigest: batch.evidenceDigest,
        proposalDigest: batch.proposalDigest,
        confirmationFingerprint: batch.confirmationFingerprint,
        confirmedVisibleSuggestions: true
      },
      selections: batch.suggestions.flatMap((suggestion) =>
        suggestion.evidenceSnapshotIds.map((evidenceSnapshotId) => ({
          evidenceSnapshotId,
          subject: suggestion.proposedSubject
        }))
      ),
      keptEvidenceSnapshotIds: evidenceSnapshotIds
    })).toEqual(batch);
  });

  it("invalidates the batch when its immutable proposed recap context changes", async () => {
    const { interactionId, mapping } = seed();
    const batch = await getOrCreateDateCompanionSubjectSuggestionBatch({
      database,
      userId: "user_a",
      interactionId,
      provider: provider()
    });
    const evidenceSnapshotIds = batch.suggestions.flatMap((item) => item.evidenceSnapshotIds).sort();
    database.prepare(`
      UPDATE dc_recap_items SET proposed_text = ?
      WHERE user_id = ? AND interaction_id = ? AND id = (
        SELECT id FROM dc_recap_items
        WHERE user_id = ? AND interaction_id = ?
        ORDER BY sort_order, id LIMIT 1
      )
    `).run("不可变建议上下文发生变化", "user_a", interactionId, "user_a", interactionId);

    expect(() => validateDateCompanionSubjectSuggestionConfirmation({
      database,
      userId: "user_a",
      interactionId,
      interactionVersion: batch.interactionVersion,
      mappingVersion: mapping.version,
      confirmation: {
        batchId: batch.batchId,
        evidenceDigest: batch.evidenceDigest,
        proposalDigest: batch.proposalDigest,
        confirmationFingerprint: batch.confirmationFingerprint,
        confirmedVisibleSuggestions: true
      },
      selections: batch.suggestions.flatMap((suggestion) =>
        suggestion.evidenceSnapshotIds.map((evidenceSnapshotId) => ({
          evidenceSnapshotId,
          subject: suggestion.proposedSubject
        }))
      ),
      keptEvidenceSnapshotIds: evidenceSnapshotIds
    })).toThrowError(/subject_suggestion_evidence_stale/u);
  });

  it("validates the current batch, mapping, digest and complete Evidence selection set", async () => {
    const { interactionId, mapping } = seed();
    const batch = await getOrCreateDateCompanionSubjectSuggestionBatch({
      database,
      userId: "user_a",
      interactionId,
      provider: provider()
    });
    const evidenceSnapshotIds = batch.suggestions.flatMap((item) => item.evidenceSnapshotIds).sort();
    expect(validateDateCompanionSubjectSuggestionConfirmation({
      database,
      userId: "user_a",
      interactionId,
      interactionVersion: batch.interactionVersion,
      mappingVersion: mapping.version,
      confirmation: {
        batchId: batch.batchId,
        evidenceDigest: batch.evidenceDigest,
        proposalDigest: batch.proposalDigest,
        confirmationFingerprint: batch.confirmationFingerprint,
        confirmedVisibleSuggestions: true
      },
      selections: evidenceSnapshotIds.map((evidenceSnapshotId) => ({
        evidenceSnapshotId,
        subject: "both" as const
      })),
      keptEvidenceSnapshotIds: evidenceSnapshotIds
    })).toEqual(batch);

    expect(() => validateDateCompanionSubjectSuggestionConfirmation({
      database,
      userId: "user_a",
      interactionId,
      interactionVersion: batch.interactionVersion,
      mappingVersion: mapping.version,
      confirmation: {
        batchId: batch.batchId,
        evidenceDigest: batch.evidenceDigest,
        proposalDigest: batch.proposalDigest,
        confirmationFingerprint: batch.confirmationFingerprint,
        confirmedVisibleSuggestions: true
      },
      selections: [],
      keptEvidenceSnapshotIds: evidenceSnapshotIds
    })).toThrowError(/subject_suggestion_selection_set_mismatch/u);

    expect(() => validateDateCompanionSubjectSuggestionConfirmation({
      database,
      userId: "user_a",
      interactionId,
      interactionVersion: batch.interactionVersion,
      mappingVersion: mapping.version,
      confirmation: {
        batchId: batch.batchId,
        evidenceDigest: batch.evidenceDigest,
        proposalDigest: batch.proposalDigest,
        confirmationFingerprint: batch.confirmationFingerprint,
        confirmedVisibleSuggestions: true
      },
      selections: evidenceSnapshotIds.map((evidenceSnapshotId) => ({
        evidenceSnapshotId,
        subject: "companion" as const
      })),
      keptEvidenceSnapshotIds: evidenceSnapshotIds
    })).toThrowError(/subject_suggestion_selection_set_mismatch/u);
  });

  it("does not expose or reuse another account's interaction batch", async () => {
    const { interactionId } = seed("user_a");
    expect(() => getDateCompanionSubjectSuggestionBatchStatus({
      database,
      userId: "user_b",
      interactionId
    })).toThrowError(/not found/u);
    await expect(getOrCreateDateCompanionSubjectSuggestionBatch({
      database,
      userId: "user_b",
      interactionId,
      provider: provider()
    })).rejects.toThrowError(/not found/u);
  });

  it("requires a scoped draft preview, preserves excluded decisions and sends only the selected context", async () => {
    const { interactionId, draftPreview } = seed("user_a", true);
    const mocked = provider(), input = {database, userId:"user_a", interactionId, provider:mocked};
    await expect(getOrCreateDateCompanionSubjectSuggestionBatch(input)).rejects.toThrow("subject_suggestion_draft_preview_required");
    await expect(getOrCreateDateCompanionSubjectSuggestionBatch({...input, draftPreview:{
      ...draftPreview, assignments:[]
    }})).rejects.toThrow("subject_suggestion_evidence_empty");
    await expect(getOrCreateDateCompanionSubjectSuggestionBatch({...input, draftPreview:{
      ...draftPreview, version:draftPreview.version + 1
    }})).rejects.toThrow("subject_suggestion_batch_stale");
    expect(mocked.suggest).not.toHaveBeenCalled();
    const [first,second] = draftPreview.itemIds;
    const batch = await getOrCreateDateCompanionSubjectSuggestionBatch({...input, draftPreview:{...draftPreview, itemIds:[first]}});
    expect(batch.suggestions[0].recapItemIds).toEqual([first]);
    expect(mocked.suggest.mock.calls[0][0][0].recapContexts.map(c=>c.recapItemId)).toEqual([first]);
    database.prepare("UPDATE dc_recap_items SET disposition='excluded' WHERE id=?").run(first);
    expect(() => getDateCompanionSubjectSuggestionBatchStatus({...input,draftPreview:{...draftPreview,itemIds:[first]}}))
      .toThrow("subject_suggestion_evidence_empty");
    const next = await getOrCreateDateCompanionSubjectSuggestionBatch({...input, draftPreview});
    expect(next.suggestions[0].recapItemIds).toEqual([second]);
    expect(next.batchId).not.toBe(batch.batchId);
    expect(mocked.suggest.mock.calls[1][0][0].recapContexts.map(c=>c.recapItemId)).toEqual([second]);
  });

  it("rejects a group-only preview for a persisted mixed group and keeps incomplete multi-source recaps out of model context", async () => {
    const { relationship, interactionId, draftPreview } = seed("user_a", true);
    const draft=repository.getInteractionDetail("user_a",relationship.id,interactionId);
    const [valid, other] = draft.recapItems;
    const source = valid.evidence[0];
    // One item has an additional unreviewed line. Neither its quote nor its summary may travel.
    database.prepare(`INSERT INTO dc_evidence_snapshots
      (id,user_id,recap_item_id,upload_id,source_segment_id,start_seconds,end_seconds,speaker_id,quote,content_digest,created_at)
      SELECT 'extra','user_a',?,upload_id,'mixed_extra',5,6,speaker_id,'额外未核对原话',content_digest,created_at
      FROM dc_evidence_snapshots WHERE id=?`).run(other.id,source.id);
    const review={speakerId:source.speakerId!,role:"unresolved" as const,reviewedSegments:[{
      sourceSegmentId:source.sourceSegmentId,contentDigest:source.contentDigest!,role:"companion" as const
    }]};
    repository.updateParticipants({userId:"user_a",interactionId,version:0,assignments:[review]});
    const mocked=provider(), input={database,userId:"user_a",interactionId,provider:mocked};
    await expect(getOrCreateDateCompanionSubjectSuggestionBatch({...input,draftPreview:{...draftPreview,version:1}}))
      .rejects.toThrow("subject_suggestion_evidence_empty");
    expect(mocked.suggest).not.toHaveBeenCalled();
    const scoped=await getOrCreateDateCompanionSubjectSuggestionBatch({...input,draftPreview:{...draftPreview,version:1,assignments:[review]}});
    expect(scoped.suggestions).toHaveLength(1);
    expect(scoped.suggestions[0].recapItemIds).toEqual([valid.id]);
    const outgoing=mocked.suggest.mock.calls[0][0];
    expect(outgoing[0].recapContexts.map(c=>c.recapItemId)).toEqual([valid.id]);
    expect(JSON.stringify(outgoing)).not.toContain("额外未核对原话");
    // Simulate a legacy saved row with insufficient proof: the full item's context stays excluded.
    database.prepare("UPDATE dc_interactions SET status='confirmed' WHERE id=?").run(interactionId);
    database.prepare("UPDATE dc_recap_items SET disposition='kept' WHERE interaction_id=?").run(interactionId);
    const saved = await getOrCreateDateCompanionSubjectSuggestionBatch(input);
    expect(saved.suggestions[0].recapItemIds).toEqual([valid.id]);
  });

  it("discards an in-flight suggestion when the current evidence is no longer eligible", async () => {
    const { interactionId } = seed();
    const input={database,userId:"user_a",interactionId};
    const mocked=provider(vi.fn(async sources=>{
      database.prepare("UPDATE dc_recap_items SET disposition='excluded' WHERE interaction_id=?").run(interactionId);
      return sources.map(s=>({canonicalSourceKey:s.canonicalSourceKey,proposedSubject:"both" as const,
        confidence:1,reasonCode:"mutual_relationship_context" as const}));
    }));
    await expect(getOrCreateDateCompanionSubjectSuggestionBatch({...input,provider:mocked})).rejects.toThrow("subject_suggestion_evidence_empty");
    for (const table of ["dc_subject_suggestion_claims","dc_subject_suggestion_batches","dc_memory_bridge_outbox"]) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({count:0});
    }
    await expect(getOrCreateDateCompanionSubjectSuggestionBatch({...input,provider:mocked})).rejects.toThrow("subject_suggestion_evidence_empty");
    expect(mocked.suggest).toHaveBeenCalledTimes(1);
  });
});
