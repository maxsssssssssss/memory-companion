// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDateCompanionDatabase } from "@/lib/server/date-companion/db";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createPersonCommitmentRepository } from "./commitments";
import { createRelationshipContextBuilder } from "./relationship-context";
import { createTemporalFactRepository } from "./temporal-facts";
import {
  LifecycleTranscriptStore,
  createConfirmedLifecyclePerson,
  exactSharedSubjectEvidence,
  exactSubjectEvidence
} from "./lifecycle-test-fixtures";

let database: Database.Database;
let dateCompanionDatabase: Database.Database | undefined;
let store: LifecycleTranscriptStore;

beforeEach(() => {
  database = openMemoryDatabase({ filePath: ":memory:" });
  store = new LifecycleTranscriptStore();
});

afterEach(() => {
  dateCompanionDatabase?.close();
  dateCompanionDatabase = undefined;
  database.close();
});

describe("Relationship context builder", () => {
  it("projects facts, changes, commitments, and Evidence references without leaking future transitions", async () => {
    const alice = await createConfirmedLifecyclePerson({
      database,
      store,
      displayName: "Alice",
      identityId: "identity_alice",
      uploadId: "upload_alice",
      segmentId: "segment_alice"
    });
    const bob = await createConfirmedLifecyclePerson({
      database,
      store,
      displayName: "Bob",
      identityId: "identity_bob",
      uploadId: "upload_bob",
      segmentId: "segment_bob"
    });
    const facts = createTemporalFactRepository(database);
    const oldEvidence = await exactSubjectEvidence({
      database,
      store,
      personId: alice.person.id,
      identityId: alice.identityId,
      uploadId: "upload_old_fact",
      segmentId: "segment_old_fact",
      text: "I like coffee."
    });
    const newEvidence = await exactSubjectEvidence({
      database,
      store,
      personId: alice.person.id,
      identityId: alice.identityId,
      uploadId: "upload_new_fact",
      segmentId: "segment_new_fact",
      text: "I now prefer tea."
    });
    const oldFact = facts.createFact({
      accountId: "account_user",
      subjectPersonId: alice.person.id,
      kind: "preference",
      factKey: "beverage.preference",
      derivedText: "Alice likes coffee.",
      observedAt: "2026-08-01T12:00:00.000Z",
      validFrom: "2026-08-01T09:00:00.000Z",
      evidence: oldEvidence
    });
    const newFact = facts.createFact({
      accountId: "account_user",
      subjectPersonId: alice.person.id,
      kind: "preference",
      factKey: "beverage.preference",
      derivedText: "Alice prefers tea.",
      observedAt: "2026-08-05T12:00:00.000Z",
      validFrom: "2026-08-05T09:00:00.000Z",
      evidence: newEvidence
    });
    const factTransitionEvidence = await exactSubjectEvidence({
      database,
      store,
      personId: alice.person.id,
      identityId: alice.identityId,
      uploadId: "upload_fact_change",
      segmentId: "segment_fact_change",
      text: "Tea explicitly replaces coffee as my preference."
    });
    facts.supersedeFact({
      accountId: "account_user",
      factId: oldFact.id,
      replacementFactId: newFact.id,
      observedAt: "2026-08-06T12:00:00.000Z",
      occurredAt: "2026-08-06T09:00:00.000Z",
      validTo: newFact.validFrom,
      expectedVersion: 1,
      evidence: factTransitionEvidence
    });

    const commitments = createPersonCommitmentRepository(database);
    const commitmentEvidence = await exactSharedSubjectEvidence({
      database,
      store,
      primaryPersonId: alice.person.id,
      primaryIdentityId: alice.identityId,
      secondaryPersonId: bob.person.id,
      uploadId: "upload_commitment",
      segmentId: "segment_commitment",
      text: "Alice promised Bob to send the notes."
    });
    const commitmentResult = commitments.createCommitment({
      accountId: "account_user",
      promisorPersonId: alice.person.id,
      promiseePersonId: bob.person.id,
      text: "Send Bob the notes.",
      observedAt: "2026-08-01T13:00:00.000Z",
      occurredAt: "2026-08-01T10:00:00.000Z",
      evidence: commitmentEvidence
    });
    if (!commitmentResult.known) throw new Error("Expected canonical Commitment");
    const activeEvidence = await exactSharedSubjectEvidence({
      database,
      store,
      primaryPersonId: alice.person.id,
      primaryIdentityId: alice.identityId,
      secondaryPersonId: bob.person.id,
      uploadId: "upload_commitment_active",
      segmentId: "segment_commitment_active",
      text: "The notes promise is active."
    });
    commitments.transitionCommitment({
      accountId: "account_user",
      commitmentId: commitmentResult.commitment.id,
      toStatus: "active",
      observedAt: "2026-08-02T13:00:00.000Z",
      occurredAt: "2026-08-02T10:00:00.000Z",
      expectedVersion: 1,
      evidence: activeEvidence
    });
    const completedEvidence = await exactSharedSubjectEvidence({
      database,
      store,
      primaryPersonId: alice.person.id,
      primaryIdentityId: alice.identityId,
      secondaryPersonId: bob.person.id,
      uploadId: "upload_commitment_completed",
      segmentId: "segment_commitment_completed",
      text: "Alice sent Bob the notes."
    });
    commitments.transitionCommitment({
      accountId: "account_user",
      commitmentId: commitmentResult.commitment.id,
      toStatus: "completed",
      observedAt: "2026-08-07T13:00:00.000Z",
      occurredAt: "2026-08-07T10:00:00.000Z",
      expectedVersion: 2,
      evidence: completedEvidence
    });

    const builder = createRelationshipContextBuilder(database);
    const before = builder.buildRelationshipContext({
      accountId: "account_user",
      personId: alice.person.id,
      asOf: "2026-08-04T23:59:59.000Z"
    });
    expect(before).toMatchObject({
      known: true,
      activeFacts: [{ id: oldFact.id, status: "active" }],
      previousFacts: [],
      activeCommitments: [{ id: commitmentResult.commitment.id, status: "active" }],
      completedCommitments: []
    });
    expect(before.recentChanges.map((change) => change.toStatus)).toEqual(["active"]);
    const beforeEvidenceIds = before.evidenceReferences.map((evidence) => evidence.id);
    expect(beforeEvidenceIds).toEqual(expect.arrayContaining([
      oldEvidence.id,
      commitmentEvidence.id,
      activeEvidence.id
    ]));
    expect(beforeEvidenceIds).not.toEqual(expect.arrayContaining([
      newEvidence.id,
      factTransitionEvidence.id,
      completedEvidence.id
    ]));

    const after = builder.buildRelationshipContext({
      accountId: "account_user",
      personId: alice.person.id,
      asOf: "2026-08-08T23:59:59.000Z"
    });
    expect(after.known).toBe(true);
    expect(after.activeFacts).toEqual([expect.objectContaining({ id: newFact.id, status: "active" })]);
    expect(after.previousFacts).toEqual([
      expect.objectContaining({ id: oldFact.id, status: "superseded", supersededBy: newFact.id })
    ]);
    expect(after.activeCommitments).toEqual([]);
    expect(after.completedCommitments).toEqual([
      expect.objectContaining({ id: commitmentResult.commitment.id, status: "completed" })
    ]);
    expect(after.continuationCandidates).toEqual([]);
    expect(after.recentChanges.map((change) => change.toStatus))
      .toEqual(["completed", "superseded", "active"]);
    expect(after.evidenceReferences.map((evidence) => evidence.id)).toEqual(
      expect.arrayContaining([
        oldEvidence.id,
        newEvidence.id,
        factTransitionEvidence.id,
        commitmentEvidence.id,
        activeEvidence.id,
        completedEvidence.id
      ])
    );
  });

  it("returns insufficient_evidence for unknown/empty Person scope and ignores Date Companion done state", async () => {
    const alice = await createConfirmedLifecyclePerson({
      database,
      store,
      displayName: "Alice",
      identityId: "identity_alice",
      uploadId: "upload_alice",
      segmentId: "segment_alice"
    });
    dateCompanionDatabase = openDateCompanionDatabase({ filePath: ":memory:" });
    const now = "2026-08-10T00:00:00.000Z";
    dateCompanionDatabase.exec(`
      INSERT INTO dc_relationships (
        id, user_id, display_name, status, version, created_at, updated_at
      ) VALUES ('dc_relationship', 'account_user', 'Alice', 'active', 0, '${now}', '${now}');
      INSERT INTO dc_interactions (
        id, user_id, relationship_id, source_upload_id, recording_date,
        original_name, status, source_state, version, created_at, updated_at, confirmed_at
      ) VALUES (
        'dc_interaction', 'account_user', 'dc_relationship', 'dc_upload', '2026-08-10',
        'dc.wav', 'confirmed', 'available', 0, '${now}', '${now}', '${now}'
      );
      INSERT INTO dc_recap_items (
        id, user_id, interaction_id, kind, proposed_text, disposition,
        version, sort_order, created_at, updated_at
      ) VALUES (
        'dc_recap', 'account_user', 'dc_interaction', 'promise',
        'Send the draft', 'kept', 0, 0, '${now}', '${now}'
      );
      INSERT INTO dc_promises (
        id, user_id, relationship_id, originating_recap_item_id, text,
        status, version, resolved_at, created_at, updated_at
      ) VALUES (
        'dc_promise', 'account_user', 'dc_relationship', 'dc_recap', 'Send the draft',
        'done', 1, '${now}', '${now}', '${now}'
      );
    `);

    const builder = createRelationshipContextBuilder(database);
    expect(builder.buildRelationshipContext({
      accountId: "account_user",
      personId: "missing_person",
      asOf: now
    })).toMatchObject({
      known: false,
      reason: "insufficient_evidence",
      person: null,
      activeFacts: [],
      activeCommitments: [],
      evidenceReferences: []
    });
    expect(builder.buildRelationshipContext({
      accountId: "account_user",
      personId: alice.person.id,
      asOf: now
    })).toMatchObject({
      known: false,
      reason: "insufficient_evidence",
      person: { id: alice.person.id },
      confirmedRelationships: [],
      activeFacts: [],
      activeCommitments: [],
      completedCommitments: [],
      evidenceReferences: []
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM person_commitments").get())
      .toEqual({ count: 0 });
  });
});
