// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AudioUpload, TranscriptSegment } from "@/lib/domain/types";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import { migrateMemorySchema } from "@/lib/server/memory/schema";
import { validatePersonTranscriptEvidence } from "./evidence";
import {
  createPersonRepository,
  persistValidatedPersonEvidence
} from "./repository";
import {
  isSubjectResolutionShadowEnabled,
  listSubjectResolutionAudits,
  runSubjectResolutionShadow
} from "./subject-resolution";

class CanonicalTranscriptStore {
  private readonly values = new Map<string, unknown>();

  putReadyUpload(uploadId: string, segments: TranscriptSegment[]) {
    const upload: AudioUpload = {
      id: uploadId,
      originalName: `${uploadId}.wav`,
      mimeType: "audio/wav",
      sizeBytes: 1024,
      recordingDate: "2026-08-10",
      status: "ready"
    };
    this.values.set(`uploads/${uploadId}`, upload);
    this.values.set(`segments/${uploadId}`, segments);
  }

  async read<T>(collection: string, id: string) {
    return (this.values.get(`${collection}/${id}`) ?? null) as T | null;
  }
}

let database: Database.Database;

beforeEach(() => {
  database = openMemoryDatabase({ filePath: ":memory:" });
});

afterEach(() => {
  database.close();
});

function segment(input: {
  uploadId: string;
  segmentId: string;
  identityId?: string;
  speaker?: string;
  text?: string;
  identityKind?: "trusted" | "unknown" | "low_confidence" | "none";
}): TranscriptSegment {
  const identityKind = input.identityKind ?? "trusted";
  return {
    id: input.segmentId,
    uploadId: input.uploadId,
    startSeconds: 0,
    endSeconds: 5,
    speaker: input.speaker,
    identity: identityKind === "none" ? undefined : {
      globalSpeakerId: input.identityId ?? "identity_alice",
      displayName: input.speaker,
      identityType: identityKind === "unknown" ? "unknown_person" : "known_contact",
      confidence: identityKind === "trusted" ? 0.96 : identityKind === "low_confidence" ? 0.4 : null,
      source: identityKind === "unknown" ? "cross_chunk_matching" : "voiceprint"
    },
    text: input.text ?? "我喜欢摄影。",
    confidence: 0.97,
    sceneLabels: ["private_content"],
    valueLabels: ["notable_quote"]
  };
}

async function evidence(
  store: CanonicalTranscriptStore,
  accountId: string,
  source: TranscriptSegment
) {
  return validatePersonTranscriptEvidence({
    store,
    authenticatedAccountId: accountId,
    accountId,
    uploadId: source.uploadId,
    sourceSegmentId: source.id,
    quote: source.text
  });
}

async function createConfirmedPerson(input: {
  store: CanonicalTranscriptStore;
  accountId: string;
  source: TranscriptSegment;
  displayName: string;
  identityId: string;
}) {
  const repository = createPersonRepository(database);
  const validated = await evidence(input.store, input.accountId, input.source);
  const person = repository.createCandidate({
    accountId: input.accountId,
    displayName: input.displayName,
    source: "identity_profile",
    evidence: validated
  });
  repository.confirmPerson({
    accountId: input.accountId,
    personId: person.id,
    evidence: validated
  });
  const link = repository.createIdentityLinkCandidate({
    accountId: input.accountId,
    personId: person.id,
    identityId: input.identityId,
    source: "manual_confirmation",
    evidence: validated
  });
  repository.confirmIdentityLink({
    accountId: input.accountId,
    linkId: link.id,
    evidence: validated
  });
  return { person, link, evidence: validated };
}

function count(table: string) {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

describe("deterministic Subject Resolution shadow", () => {
  it("confirms only a unique, explicit first-person statement backed by a confirmed Person/Identity link", async () => {
    const store = new CanonicalTranscriptStore();
    const source = segment({
      uploadId: "upload_confirmed",
      segmentId: "segment_confirmed",
      speaker: "Alice",
      identityId: "identity_alice",
      text: "我喜欢摄影。"
    });
    store.putReadyUpload(source.uploadId, [source]);
    const { person } = await createConfirmedPerson({
      store,
      accountId: "account_user",
      source,
      displayName: "Alice",
      identityId: "identity_alice"
    });

    const first = await runSubjectResolutionShadow({
      store,
      database,
      accountId: "account_user",
      uploadId: source.uploadId,
      segments: [source],
      now: () => "2026-08-10T01:00:00.000Z"
    });
    const retry = await runSubjectResolutionShadow({
      store,
      database,
      accountId: "account_user",
      uploadId: source.uploadId,
      segments: [source],
      now: () => "2026-08-10T01:01:00.000Z"
    });

    expect(first).toMatchObject({
      status: "completed",
      confirmedCount: 1,
      candidateCount: 0,
      unknownCount: 0,
      ambiguousCount: 0,
      failedCount: 0
    });
    expect(first.audits[0]).toMatchObject({
      decision: "confirmed",
      personId: person.id,
      identityId: "identity_alice",
      reasonCodes: ["confirmed_first_person"],
      subjectObservationCreated: true
    });
    expect(retry.audits[0].id).toBe(first.audits[0].id);
    expect(retry.audits[0].subjectObservationId).toBe(first.audits[0].subjectObservationId);
    expect(count("person_subject_resolution_audits")).toBe(1);
    expect(count("person_subject_observations")).toBe(1);
    expect(createPersonRepository(database).getConfirmedSubjectPersonId({
      accountId: "account_user",
      uploadId: source.uploadId,
      sourceSegmentId: source.id
    })).toBe(person.id);
  });

  it("fails closed for candidate/archived Person and candidate/rejected Identity links", async () => {
    const store = new CanonicalTranscriptStore();
    const sources = [
      segment({ uploadId: "upload_states", segmentId: "segment_candidate_person", speaker: "A", identityId: "identity_a" }),
      segment({ uploadId: "upload_states", segmentId: "segment_candidate_link", speaker: "B", identityId: "identity_b" }),
      segment({ uploadId: "upload_states", segmentId: "segment_rejected_link", speaker: "C", identityId: "identity_c" }),
      segment({ uploadId: "upload_states", segmentId: "segment_archived_person", speaker: "D", identityId: "identity_d" })
    ];
    store.putReadyUpload("upload_states", sources);
    const repository = createPersonRepository(database);

    const candidateEvidence = await evidence(store, "account_user", sources[0]);
    const candidatePerson = repository.createCandidate({
      accountId: "account_user",
      displayName: "Candidate A",
      source: "identity_profile",
      evidence: candidateEvidence
    });
    repository.createIdentityLinkCandidate({
      accountId: "account_user",
      personId: candidatePerson.id,
      identityId: "identity_a",
      source: "identity_profile",
      evidence: candidateEvidence
    });

    const confirmedB = await createConfirmedPerson({
      store,
      accountId: "account_user",
      source: sources[1],
      displayName: "Confirmed B",
      identityId: "identity_b"
    });
    database.prepare("UPDATE person_identity_links SET status = 'candidate', confirmed_at = NULL WHERE id = ?")
      .run(confirmedB.link.id);

    const confirmedC = await createConfirmedPerson({
      store,
      accountId: "account_user",
      source: sources[2],
      displayName: "Confirmed C",
      identityId: "identity_c"
    });
    database.prepare("UPDATE person_identity_links SET status = 'rejected', confirmed_at = NULL WHERE id = ?")
      .run(confirmedC.link.id);

    const confirmedD = await createConfirmedPerson({
      store,
      accountId: "account_user",
      source: sources[3],
      displayName: "Archived D",
      identityId: "identity_d"
    });
    database.prepare("UPDATE person_entities SET status = 'archived' WHERE id = ?")
      .run(confirmedD.person.id);

    const result = await runSubjectResolutionShadow({
      store,
      database,
      accountId: "account_user",
      uploadId: "upload_states",
      segments: sources
    });
    const bySegment = Object.fromEntries(result.audits.map((audit) => [audit.sourceSegmentId, audit]));

    expect(result.confirmedCount).toBe(0);
    expect(bySegment.segment_candidate_person).toMatchObject({
      decision: "candidate",
      reasonCodes: ["identity_link_not_confirmed"]
    });
    expect(bySegment.segment_candidate_link).toMatchObject({
      decision: "candidate",
      reasonCodes: ["identity_link_not_confirmed"]
    });
    expect(bySegment.segment_rejected_link).toMatchObject({
      decision: "unknown",
      reasonCodes: ["identity_link_missing"]
    });
    expect(bySegment.segment_archived_person).toMatchObject({
      decision: "candidate",
      reasonCodes: ["person_not_confirmed"]
    });
    expect(count("person_subject_observations")).toBe(0);
  });

  it("treats missing/chunk-local speakers and unknown or low-confidence identities as unknown", async () => {
    const store = new CanonicalTranscriptStore();
    const sources = [
      segment({ uploadId: "upload_unknowns", segmentId: "segment_no_speaker", identityId: "identity_a" }),
      segment({ uploadId: "upload_unknowns", segmentId: "segment_local", speaker: "speaker_1", identityId: "identity_b" }),
      segment({ uploadId: "upload_unknowns", segmentId: "segment_unknown_identity", speaker: "Alice", identityId: "identity_c", identityKind: "unknown" }),
      segment({ uploadId: "upload_unknowns", segmentId: "segment_low_confidence", speaker: "Alice", identityId: "identity_d", identityKind: "low_confidence" })
    ];
    store.putReadyUpload("upload_unknowns", sources);

    const result = await runSubjectResolutionShadow({
      store,
      database,
      accountId: "account_user",
      uploadId: "upload_unknowns",
      segments: sources
    });
    const bySegment = Object.fromEntries(result.audits.map((audit) => [audit.sourceSegmentId, audit]));

    expect(result.unknownCount).toBe(4);
    expect(bySegment.segment_no_speaker.reasonCodes).toEqual(["missing_speaker"]);
    expect(bySegment.segment_local.reasonCodes).toEqual(["chunk_local_speaker"]);
    expect(bySegment.segment_unknown_identity.reasonCodes).toEqual(["untrusted_identity"]);
    expect(bySegment.segment_low_confidence.reasonCodes).toEqual(["untrusted_identity"]);
  });

  it("marks reported, quoted, third-person, multi-person, and non-first-person text without guessing", async () => {
    const setupStore = new CanonicalTranscriptStore();
    const setup = segment({
      uploadId: "upload_text_setup",
      segmentId: "segment_text_setup",
      speaker: "Alice",
      identityId: "identity_alice"
    });
    setupStore.putReadyUpload(setup.uploadId, [setup]);
    await createConfirmedPerson({
      store: setupStore,
      accountId: "account_user",
      source: setup,
      displayName: "Alice",
      identityId: "identity_alice"
    });

    const store = new CanonicalTranscriptStore();
    const texts = [
      ["segment_reported", "Alice 转述 Bob 喜欢摄影。"],
      ["segment_quoted", "“我喜欢摄影。”"],
      ["segment_third_person", "我听她说她喜欢摄影。"],
      ["segment_multiple", "我和 Bob 最近都喜欢摄影。"],
      ["segment_not_first_person", "Bob 喜欢摄影。"]
    ] as const;
    const sources = texts.map(([segmentId, text]) => segment({
      uploadId: "upload_text_boundaries",
      segmentId,
      speaker: "Alice",
      identityId: "identity_alice",
      text
    }));
    store.putReadyUpload("upload_text_boundaries", sources);

    const result = await runSubjectResolutionShadow({
      store,
      database,
      accountId: "account_user",
      uploadId: "upload_text_boundaries",
      segments: sources
    });
    const bySegment = Object.fromEntries(result.audits.map((audit) => [audit.sourceSegmentId, audit]));

    expect(result.confirmedCount).toBe(0);
    expect(bySegment.segment_reported).toMatchObject({ decision: "ambiguous" });
    expect(bySegment.segment_reported.reasonCodes).toContain("reported_speech");
    expect(bySegment.segment_quoted).toMatchObject({
      decision: "ambiguous",
      reasonCodes: ["quoted_speech"]
    });
    expect(bySegment.segment_third_person).toMatchObject({ decision: "ambiguous" });
    expect(bySegment.segment_third_person.reasonCodes).toContain("third_person_statement");
    expect(bySegment.segment_multiple).toMatchObject({ decision: "ambiguous" });
    expect(bySegment.segment_multiple.reasonCodes).toContain("multiple_people");
    expect(bySegment.segment_not_first_person).toMatchObject({
      decision: "candidate",
      reasonCodes: ["not_explicit_first_person"]
    });
    expect(count("person_subject_observations")).toBe(0);
  });

  it("uses Identity IDs and account scope, not equal display names, to select one Person", async () => {
    const accountAStore = new CanonicalTranscriptStore();
    const aliceA = segment({ uploadId: "upload_alice_a", segmentId: "segment_alice_a", speaker: "Alice", identityId: "identity_a" });
    const aliceB = segment({ uploadId: "upload_alice_b", segmentId: "segment_alice_b", speaker: "Alice", identityId: "identity_b" });
    accountAStore.putReadyUpload(aliceA.uploadId, [aliceA]);
    accountAStore.putReadyUpload(aliceB.uploadId, [aliceB]);
    const personA = await createConfirmedPerson({
      store: accountAStore,
      accountId: "account_a",
      source: aliceA,
      displayName: "Alice",
      identityId: "identity_a"
    });
    const personB = await createConfirmedPerson({
      store: accountAStore,
      accountId: "account_a",
      source: aliceB,
      displayName: "Alice",
      identityId: "identity_b"
    });

    const accountBStore = new CanonicalTranscriptStore();
    const otherAccountAlice = segment({ uploadId: "upload_other", segmentId: "segment_other", speaker: "Alice", identityId: "identity_a" });
    accountBStore.putReadyUpload(otherAccountAlice.uploadId, [otherAccountAlice]);
    const personOtherAccount = await createConfirmedPerson({
      store: accountBStore,
      accountId: "account_b",
      source: otherAccountAlice,
      displayName: "Alice",
      identityId: "identity_a"
    });

    const result = await runSubjectResolutionShadow({
      store: accountAStore,
      database,
      accountId: "account_a",
      uploadId: aliceA.uploadId,
      segments: [aliceA]
    });
    expect(result.audits[0]).toMatchObject({ decision: "confirmed", personId: personA.person.id });
    expect(result.audits[0].candidatePersonIds).toEqual([personA.person.id]);
    expect(result.audits[0].personId).not.toBe(personB.person.id);
    expect(result.audits[0].personId).not.toBe(personOtherAccount.person.id);
  });

  it("fails closed when one Identity has multiple possible Persons", async () => {
    const store = new CanonicalTranscriptStore();
    const source = segment({ uploadId: "upload_conflict", segmentId: "segment_conflict", speaker: "Alice", identityId: "identity_shared" });
    const otherSource = segment({ uploadId: "upload_conflict_other", segmentId: "segment_conflict_other", speaker: "Alice", identityId: "identity_other" });
    store.putReadyUpload(source.uploadId, [source]);
    store.putReadyUpload(otherSource.uploadId, [otherSource]);
    await createConfirmedPerson({
      store,
      accountId: "account_user",
      source,
      displayName: "Alice One",
      identityId: "identity_shared"
    });
    const repository = createPersonRepository(database);
    const otherEvidence = await evidence(store, "account_user", otherSource);
    const otherPerson = repository.createCandidate({
      accountId: "account_user",
      displayName: "Alice Two",
      source: "identity_profile",
      evidence: otherEvidence
    });
    repository.confirmPerson({
      accountId: "account_user",
      personId: otherPerson.id,
      evidence: otherEvidence
    });
    repository.createIdentityLinkCandidate({
      accountId: "account_user",
      personId: otherPerson.id,
      identityId: "identity_shared",
      source: "identity_profile",
      evidence: otherEvidence
    });

    const result = await runSubjectResolutionShadow({
      store,
      database,
      accountId: "account_user",
      uploadId: source.uploadId,
      segments: [source]
    });
    expect(result.audits[0]).toMatchObject({
      decision: "ambiguous",
      personId: null,
      reasonCodes: ["identity_person_conflict"]
    });
    expect(result.audits[0].candidatePersonIds).toHaveLength(2);
    expect(count("person_subject_observations")).toBe(0);
  });

  it("does not overwrite an existing conflicting confirmed Subject", async () => {
    const store = new CanonicalTranscriptStore();
    const alice = segment({ uploadId: "upload_existing_conflict", segmentId: "segment_existing_conflict", speaker: "Alice", identityId: "identity_alice" });
    const bob = segment({ uploadId: "upload_bob_setup", segmentId: "segment_bob_setup", speaker: "Bob", identityId: "identity_bob" });
    store.putReadyUpload(alice.uploadId, [alice]);
    store.putReadyUpload(bob.uploadId, [bob]);
    await createConfirmedPerson({
      store,
      accountId: "account_user",
      source: alice,
      displayName: "Alice",
      identityId: "identity_alice"
    });
    const bobPerson = await createConfirmedPerson({
      store,
      accountId: "account_user",
      source: bob,
      displayName: "Bob",
      identityId: "identity_bob"
    });
    const aliceEvidence = await evidence(store, "account_user", alice);
    persistValidatedPersonEvidence(database, {
      accountId: "account_user",
      evidence: aliceEvidence,
      now: "2026-08-10T00:00:00.000Z"
    });
    database.prepare(`
      INSERT INTO person_subject_observations (
        id, account_id, person_id, evidence_id, status, source, reason,
        confirmed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'confirmed', 'confirmed_identity', ?, ?, ?, ?)
    `).run(
      "manual_conflicting_subject",
      "account_user",
      bobPerson.person.id,
      aliceEvidence.id,
      "preexisting manual assertion",
      "2026-08-10T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z"
    );

    const result = await runSubjectResolutionShadow({
      store,
      database,
      accountId: "account_user",
      uploadId: alice.uploadId,
      segments: [alice]
    });
    expect(result.audits[0]).toMatchObject({
      decision: "ambiguous",
      personId: null,
      reasonCodes: ["existing_subject_conflict"]
    });
    expect(database.prepare("SELECT person_id FROM person_subject_observations WHERE id = ?")
      .get("manual_conflicting_subject")).toEqual({ person_id: bobPerson.person.id });
  });

  it("records a partial failure per segment and retries without duplicate audits or observations", async () => {
    const setupStore = new CanonicalTranscriptStore();
    const setup = segment({ uploadId: "upload_retry_setup", segmentId: "segment_retry_setup", speaker: "Alice", identityId: "identity_alice" });
    setupStore.putReadyUpload(setup.uploadId, [setup]);
    await createConfirmedPerson({
      store: setupStore,
      accountId: "account_user",
      source: setup,
      displayName: "Alice",
      identityId: "identity_alice"
    });
    const store = new CanonicalTranscriptStore();
    const sources = [
      segment({ uploadId: "upload_retry", segmentId: "segment_ok", speaker: "Alice", identityId: "identity_alice" }),
      segment({ uploadId: "upload_retry", segmentId: "segment_retry", speaker: "Alice", identityId: "identity_alice" })
    ];
    store.putReadyUpload("upload_retry", sources);
    database.exec(`
      CREATE TRIGGER fail_one_shadow_audit
      BEFORE INSERT ON person_subject_resolution_audits
      WHEN NEW.source_segment_id = 'segment_retry' AND NEW.decision <> 'failed'
      BEGIN
        SELECT RAISE(ABORT, 'forced shadow audit failure');
      END;
    `);

    const partial = await runSubjectResolutionShadow({
      store,
      database,
      accountId: "account_user",
      uploadId: "upload_retry",
      segments: sources
    });
    expect(partial).toMatchObject({ status: "partial", confirmedCount: 1, failedCount: 1 });
    expect(count("person_subject_resolution_audits")).toBe(2);
    expect(count("person_subject_observations")).toBe(1);

    database.exec("DROP TRIGGER fail_one_shadow_audit");
    const retry = await runSubjectResolutionShadow({
      store,
      database,
      accountId: "account_user",
      uploadId: "upload_retry",
      segments: sources
    });
    expect(retry).toMatchObject({ status: "completed", confirmedCount: 2, failedCount: 0 });
    expect(count("person_subject_resolution_audits")).toBe(2);
    expect(count("person_subject_observations")).toBe(2);
  });

  it("cleans upload-owned audit/Subject rows without touching other uploads or accounts", async () => {
    const storeA = new CanonicalTranscriptStore();
    const sourceA = segment({ uploadId: "upload_delete", segmentId: "segment_delete", speaker: "Alice", identityId: "identity_alice" });
    const sourceOtherUpload = segment({ uploadId: "upload_keep", segmentId: "segment_keep", speaker: "speaker_1", identityId: "identity_keep" });
    storeA.putReadyUpload(sourceA.uploadId, [sourceA]);
    storeA.putReadyUpload(sourceOtherUpload.uploadId, [sourceOtherUpload]);
    await createConfirmedPerson({
      store: storeA,
      accountId: "account_a",
      source: sourceA,
      displayName: "Alice",
      identityId: "identity_alice"
    });
    await runSubjectResolutionShadow({
      store: storeA,
      database,
      accountId: "account_a",
      uploadId: sourceA.uploadId,
      segments: [sourceA]
    });
    await runSubjectResolutionShadow({
      store: storeA,
      database,
      accountId: "account_a",
      uploadId: sourceOtherUpload.uploadId,
      segments: [sourceOtherUpload]
    });

    const storeB = new CanonicalTranscriptStore();
    const sourceB = segment({ uploadId: "upload_delete", segmentId: "segment_delete", speaker: "speaker_1", identityId: "identity_b" });
    storeB.putReadyUpload(sourceB.uploadId, [sourceB]);
    await runSubjectResolutionShadow({
      store: storeB,
      database,
      accountId: "account_b",
      uploadId: sourceB.uploadId,
      segments: [sourceB]
    });

    const deleted = createPersonRepository(database).deleteByUpload("account_a", "upload_delete");
    expect(deleted.deletedSubjectResolutionAuditCount).toBe(1);
    expect(listSubjectResolutionAudits(database, { accountId: "account_a", uploadId: "upload_delete" }))
      .toEqual([]);
    expect(listSubjectResolutionAudits(database, { accountId: "account_a", uploadId: "upload_keep" }))
      .toHaveLength(1);
    expect(listSubjectResolutionAudits(database, { accountId: "account_b", uploadId: "upload_delete" }))
      .toHaveLength(1);
  });

  it("does not change existing Memory retrieval output and is disabled unless explicitly enabled", async () => {
    const memoryRepository = createMemoryRepository(database);
    const store = new CanonicalTranscriptStore();
    const source = segment({ uploadId: "upload_memory_contract", segmentId: "segment_memory_contract", speaker: "speaker_1", identityId: "identity_local" });
    store.putReadyUpload(source.uploadId, [source]);
    memoryRepository.replaceUploadMemories({
      userId: "account_user",
      uploadId: source.uploadId,
      sourceSegments: [source],
      memories: [{
        id: "memory_contract",
        type: "event",
        title: "记录摄影计划",
        summary: "记录了一项摄影计划。",
        importance: 0.6,
        date: "2026-08-10",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
        evidence: [{
          id: "memory_contract_evidence",
          sourceType: "transcript",
          sourceId: source.id,
          uploadId: source.uploadId,
          date: "2026-08-10",
          quote: source.text,
          createdAt: "2026-08-10T00:00:00.000Z"
        }]
      }]
    });
    const before = memoryRepository.getRelevantMemories({ userId: "account_user" });

    await runSubjectResolutionShadow({
      store,
      database,
      accountId: "account_user",
      uploadId: source.uploadId,
      segments: [source]
    });

    expect(memoryRepository.getRelevantMemories({ userId: "account_user" })).toEqual(before);
    expect(isSubjectResolutionShadowEnabled({})).toBe(false);
    expect(isSubjectResolutionShadowEnabled({ PERSON_SUBJECT_RESOLUTION_SHADOW_ENABLED: "true" })).toBe(true);
  });

  it("migrates a v4 Person database through v5/v6 without changing Phase 1A rows", async () => {
    const store = new CanonicalTranscriptStore();
    const source = segment({ uploadId: "upload_v4", segmentId: "segment_v4", speaker: "Alice", identityId: "identity_v4" });
    store.putReadyUpload(source.uploadId, [source]);
    const person = await createConfirmedPerson({
      store,
      accountId: "account_user",
      source,
      displayName: "Alice",
      identityId: "identity_v4"
    });
    const phase1RowsBefore = {
      persons: count("person_entities"),
      evidence: count("person_evidence"),
      names: count("person_names"),
      links: count("person_identity_links")
    };
    database.exec(`
      DROP TRIGGER IF EXISTS dc_memory_bridge_candidate_receipts_immutable;
      DROP TABLE dc_memory_bridge_candidate_receipts;
      DROP TRIGGER IF EXISTS memory_daily_reflection_candidate_receipts_immutable;
      DROP TABLE memory_daily_reflection_candidate_revocations;
      DROP TABLE memory_daily_reflection_candidate_person_sources;
      DROP TABLE memory_daily_reflection_candidate_current_memories;
      DROP TABLE memory_daily_reflection_candidate_payloads;
      DROP TABLE memory_daily_reflection_evidence_provenance;
      DROP TABLE memory_daily_reflection_candidate_receipts;
      DROP TABLE memory_daily_reflection_publications;
      DROP TABLE memory_upload_tombstones;
      DROP TABLE dc_memory_bridge_receipts;
      DROP TABLE dc_person_relationship_links;
      DROP TABLE person_evidence_dc_links;
      DROP TABLE dc_retained_uploads;
      DROP TABLE memory_evidence_provenance;
      DROP TABLE person_admission_audits;
      DROP TABLE person_self_bindings;
      DROP TABLE person_subject_admissions;
      DROP TABLE person_relationship_admissions;
      DROP TABLE person_entity_admissions;
      DROP TABLE person_fact_transitions;
      DROP TABLE person_commitment_transitions;
      DROP TABLE person_fact_evidence;
      DROP TABLE person_commitment_evidence;
      DROP TABLE person_facts;
      DROP TABLE person_commitments;
      DROP TABLE person_relationship_evidence;
      DROP TABLE person_relationships;
      DROP TABLE person_subject_resolution_audits;
      DROP INDEX idx_person_subject_observations_confirmed_person_evidence;
      CREATE UNIQUE INDEX idx_person_subject_observations_confirmed_evidence
        ON person_subject_observations(account_id, evidence_id)
        WHERE status = 'confirmed';
      DELETE FROM schema_migrations WHERE version >= 5;
    `);

    migrateMemorySchema(database);

    expect(database.prepare("SELECT version FROM schema_migrations WHERE version = 5").get())
      .toEqual({ version: 5 });
    expect(database.prepare("SELECT version FROM schema_migrations WHERE version = 6").get())
      .toEqual({ version: 6 });
    expect(database.prepare("SELECT version FROM schema_migrations WHERE version = 7").get())
      .toEqual({ version: 7 });
    expect(database.prepare("SELECT version FROM schema_migrations WHERE version = 8").get())
      .toEqual({ version: 8 });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("person_subject_resolution_audits")).toEqual({ name: "person_subject_resolution_audits" });
    expect({
      persons: count("person_entities"),
      evidence: count("person_evidence"),
      names: count("person_names"),
      links: count("person_identity_links")
    }).toEqual(phase1RowsBefore);
    expect(createPersonRepository(database).getConfirmedPerson("account_user", person.person.id)?.id)
      .toBe(person.person.id);
  });
});
