// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createPersonRepository } from "./repository";
import { PersonLifecycleError } from "./lifecycle-support";
import { createTemporalFactRepository } from "./temporal-facts";
import {
  LifecycleTranscriptStore,
  confirmedLifecycleRelationship,
  createConfirmedLifecyclePerson,
  exactSharedSubjectEvidence,
  exactSubjectEvidence,
  validatedLifecycleEvidence
} from "./lifecycle-test-fixtures";

let database: Database.Database;
let store: LifecycleTranscriptStore;

beforeEach(() => {
  database = openMemoryDatabase({ filePath: ":memory:" });
  store = new LifecycleTranscriptStore();
});

afterEach(() => database.close());

function expectCode(action: () => unknown, code: string) {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(PersonLifecycleError);
    expect((error as PersonLifecycleError).code).toBe(code);
  }
}

describe("Evidence-backed temporal Person Facts", () => {
  it("keeps independent facts active until an explicit ordered Evidence transition supersedes one", async () => {
    const alice = await createConfirmedLifecyclePerson({
      database,
      store,
      displayName: "Alice",
      identityId: "identity_alice",
      uploadId: "upload_alice_profile",
      segmentId: "segment_alice_profile"
    });
    const coffeeEvidence = await exactSubjectEvidence({
      database,
      store,
      personId: alice.person.id,
      identityId: alice.identityId,
      uploadId: "upload_coffee",
      segmentId: "segment_coffee",
      text: "I like coffee."
    });
    const teaEvidence = await exactSubjectEvidence({
      database,
      store,
      personId: alice.person.id,
      identityId: alice.identityId,
      uploadId: "upload_tea",
      segmentId: "segment_tea",
      text: "I have started drinking tea."
    });
    const repository = createTemporalFactRepository(database);
    const coffee = repository.createFact({
      accountId: "account_user",
      subjectPersonId: alice.person.id,
      kind: "preference",
      factKey: "beverage.preference",
      derivedText: "Alice likes coffee.",
      observedAt: "2026-08-01T12:00:00.000Z",
      validFrom: "2026-08-01T09:00:00.000Z",
      evidence: coffeeEvidence
    });
    const tea = repository.createFact({
      accountId: "account_user",
      subjectPersonId: alice.person.id,
      kind: "preference",
      factKey: "beverage.preference",
      derivedText: "Alice drinks tea.",
      observedAt: "2026-08-05T12:00:00.000Z",
      validFrom: "2026-08-05T09:00:00.000Z",
      evidence: teaEvidence
    });

    expect(repository.listFactsForPerson("account_user", alice.person.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: coffee.id, status: "active" }),
        expect.objectContaining({ id: tea.id, status: "active" })
      ]));

    const replacementEvidence = await exactSubjectEvidence({
      database,
      store,
      personId: alice.person.id,
      identityId: alice.identityId,
      uploadId: "upload_replacement",
      segmentId: "segment_replacement",
      text: "Tea replaces coffee as my current drink preference."
    });
    const transitionInput = {
      accountId: "account_user",
      factId: coffee.id,
      replacementFactId: tea.id,
      observedAt: "2026-08-06T12:00:00.000Z",
      occurredAt: "2026-08-06T09:00:00.000Z",
      validTo: "2026-08-05T09:00:00.000Z",
      expectedVersion: 1,
      evidence: replacementEvidence
    };
    const superseded = repository.supersedeFact(transitionInput);

    expect(superseded).toMatchObject({
      id: coffee.id,
      status: "superseded",
      validTo: tea.validFrom,
      supersededBy: tea.id,
      version: 2
    });
    expect(superseded.transitions).toHaveLength(1);
    expect(superseded.transitions[0]).toMatchObject({
      toStatus: "superseded",
      replacementFactId: tea.id,
      applied: true,
      evidence: { id: replacementEvidence.id }
    });
    expect(repository.supersedeFact(transitionInput)).toEqual(superseded);
    expectCode(
      () => repository.supersedeFact({
        ...transitionInput,
        observedAt: "2026-08-07T12:00:00.000Z"
      }),
      "persisted_state_conflict"
    );
  });

  it("fails closed for missing Evidence, unconfirmed Persons, ambiguous Subjects, and cross-account Evidence", async () => {
    const alice = await createConfirmedLifecyclePerson({
      database,
      store,
      displayName: "Alice",
      identityId: "identity_alice",
      uploadId: "upload_alice_profile",
      segmentId: "segment_alice_profile"
    });
    const bob = await createConfirmedLifecyclePerson({
      database,
      store,
      displayName: "Bob",
      identityId: "identity_bob",
      uploadId: "upload_bob_profile",
      segmentId: "segment_bob_profile"
    });
    const repository = createTemporalFactRepository(database);
    expectCode(() => repository.createFact({
      accountId: "account_user",
      subjectPersonId: alice.person.id,
      kind: "event",
      factKey: "event.photo",
      derivedText: "Alice attended a photo walk.",
      observedAt: "2026-08-02T12:00:00.000Z",
      evidence: null
    }), "insufficient_evidence");

    const candidateEvidence = await validatedLifecycleEvidence({
      store,
      uploadId: "upload_candidate",
      segmentId: "segment_candidate",
      identityId: "identity_candidate",
      text: "I am Candidate."
    });
    const candidate = createPersonRepository(database).createCandidate({
      accountId: "account_user",
      displayName: "Candidate",
      source: "transcript_candidate",
      evidence: candidateEvidence
    });
    expectCode(() => repository.createFact({
      accountId: "account_user",
      subjectPersonId: candidate.id,
      kind: "event",
      factKey: "event.candidate",
      derivedText: "Candidate event.",
      observedAt: "2026-08-02T12:00:00.000Z",
      evidence: candidateEvidence
    }), "unavailable_person");

    const ambiguousEvidence = await exactSharedSubjectEvidence({
      database,
      store,
      primaryPersonId: alice.person.id,
      primaryIdentityId: alice.identityId,
      secondaryPersonId: bob.person.id,
      uploadId: "upload_shared",
      segmentId: "segment_shared",
      text: "Alice and Bob attended together."
    });
    expectCode(() => repository.createFact({
      accountId: "account_user",
      subjectPersonId: alice.person.id,
      kind: "event",
      factKey: "event.shared",
      derivedText: "Alice attended.",
      observedAt: "2026-08-03T12:00:00.000Z",
      evidence: ambiguousEvidence
    }), "subject_evidence_mismatch");

    const other = await createConfirmedLifecyclePerson({
      database,
      store,
      accountId: "account_other",
      displayName: "Other Alice",
      identityId: "identity_other",
      uploadId: "upload_other_profile",
      segmentId: "segment_other_profile"
    });
    const otherEvidence = await exactSubjectEvidence({
      database,
      store,
      accountId: "account_other",
      personId: other.person.id,
      identityId: other.identityId,
      uploadId: "upload_other_fact",
      segmentId: "segment_other_fact",
      text: "I like film."
    });
    expectCode(() => repository.createFact({
      accountId: "account_user",
      subjectPersonId: alice.person.id,
      kind: "preference",
      factKey: "media.preference",
      derivedText: "Alice likes film.",
      observedAt: "2026-08-04T12:00:00.000Z",
      evidence: otherEvidence
    }), "evidence_account_mismatch");

    const carol = await createConfirmedLifecyclePerson({
      database,
      store,
      displayName: "Carol",
      identityId: "identity_carol",
      uploadId: "upload_carol_profile",
      segmentId: "segment_carol_profile"
    });
    const aliceBobRelationship = await confirmedLifecycleRelationship({
      database,
      store,
      personAId: alice.person.id,
      personBId: bob.person.id,
      uploadId: "upload_alice_bob_relationship",
      segmentId: "segment_alice_bob_relationship"
    });
    const carolEvidence = await exactSubjectEvidence({
      database,
      store,
      personId: carol.person.id,
      identityId: carol.identityId,
      uploadId: "upload_carol_fact",
      segmentId: "segment_carol_fact",
      text: "I visited the gallery."
    });
    expectCode(() => repository.createFact({
      accountId: "account_user",
      subjectPersonId: carol.person.id,
      relationshipId: aliceBobRelationship.id,
      kind: "event",
      factKey: "event.gallery",
      derivedText: "Carol visited the gallery.",
      observedAt: "2026-08-05T12:00:00.000Z",
      evidence: carolEvidence
    }), "unavailable_relationship");

    const archivedEvidence = await exactSubjectEvidence({
      database,
      store,
      personId: bob.person.id,
      identityId: bob.identityId,
      uploadId: "upload_archived_fact",
      segmentId: "segment_archived_fact",
      text: "I visited the park."
    });
    database.prepare(`
      UPDATE person_entities SET status = 'archived' WHERE id = ? AND account_id = 'account_user'
    `).run(bob.person.id);
    expectCode(() => repository.createFact({
      accountId: "account_user",
      subjectPersonId: bob.person.id,
      kind: "event",
      factKey: "event.park",
      derivedText: "Bob visited the park.",
      observedAt: "2026-08-05T12:00:00.000Z",
      evidence: archivedEvidence
    }), "unavailable_person");
  });

  it("rejects unordered or incompatible supersession and deterministically replays after privacy deletion", async () => {
    const alice = await createConfirmedLifecyclePerson({
      database,
      store,
      displayName: "Alice",
      identityId: "identity_alice",
      uploadId: "upload_profile",
      segmentId: "segment_profile"
    });
    const repository = createTemporalFactRepository(database);
    const baseEvidence = await exactSubjectEvidence({
      database,
      store,
      personId: alice.person.id,
      identityId: alice.identityId,
      uploadId: "upload_fact_old",
      segmentId: "segment_fact_old",
      text: "I prefer the old plan."
    });
    const replacementEvidence = await exactSubjectEvidence({
      database,
      store,
      personId: alice.person.id,
      identityId: alice.identityId,
      uploadId: "upload_fact_new",
      segmentId: "segment_fact_new",
      text: "I prefer the new plan."
    });
    const oldFact = repository.createFact({
      accountId: "account_user",
      subjectPersonId: alice.person.id,
      kind: "preference",
      factKey: "plan.preference",
      derivedText: "Alice prefers the old plan.",
      observedAt: "2026-08-01T12:00:00.000Z",
      validFrom: "2026-08-01T09:00:00.000Z",
      evidence: baseEvidence
    });
    const newFact = repository.createFact({
      accountId: "account_user",
      subjectPersonId: alice.person.id,
      kind: "preference",
      factKey: "plan.preference",
      derivedText: "Alice prefers the new plan.",
      observedAt: "2026-08-05T12:00:00.000Z",
      validFrom: "2026-08-05T09:00:00.000Z",
      evidence: replacementEvidence
    });
    const transitionEvidence = await exactSubjectEvidence({
      database,
      store,
      personId: alice.person.id,
      identityId: alice.identityId,
      uploadId: "upload_fact_transition",
      segmentId: "segment_fact_transition",
      text: "The new plan explicitly replaces the old plan."
    });
    expectCode(() => repository.supersedeFact({
      accountId: "account_user",
      factId: oldFact.id,
      replacementFactId: newFact.id,
      observedAt: "2026-08-05T12:00:00.000Z",
      occurredAt: "2026-08-05T09:00:00.000Z",
      validTo: newFact.validFrom,
      expectedVersion: 1,
      evidence: transitionEvidence
    }), "invalid_time_order");

    repository.supersedeFact({
      accountId: "account_user",
      factId: oldFact.id,
      replacementFactId: newFact.id,
      observedAt: "2026-08-06T12:00:00.000Z",
      occurredAt: "2026-08-06T09:00:00.000Z",
      validTo: newFact.validFrom,
      expectedVersion: 1,
      evidence: transitionEvidence
    });
    const deletion = createPersonRepository(database).deleteByUpload(
      "account_user",
      "upload_fact_transition",
      "2026-08-10T12:00:00.000Z"
    );
    expect(deletion).toMatchObject({
      deletedFactTransitionCount: 1,
      deletedFactCount: 0,
      recalculatedFactCount: 2
    });
    expect(repository.getFact("account_user", oldFact.id)).toMatchObject({
      status: "active",
      validTo: null,
      supersededBy: null,
      version: 1,
      transitions: []
    });
    expect(repository.getFact("account_user", newFact.id)?.status).toBe("active");

    const baseDeletion = createPersonRepository(database).deleteByUpload(
      "account_user",
      "upload_fact_old",
      "2026-08-10T13:00:00.000Z"
    );
    expect(baseDeletion.deletedFactCount).toBe(1);
    expect(repository.getFact("account_user", oldFact.id)).toBeNull();
    expect(repository.getFact("account_user", newFact.id)?.status).toBe("active");
  });

  it("never supersedes a Fact with another Subject's Fact", async () => {
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
    const repository = createTemporalFactRepository(database);
    const aliceEvidence = await exactSubjectEvidence({
      database,
      store,
      personId: alice.person.id,
      identityId: alice.identityId,
      uploadId: "upload_alice_fact",
      segmentId: "segment_alice_fact",
      text: "I like coffee."
    });
    const bobEvidence = await exactSubjectEvidence({
      database,
      store,
      personId: bob.person.id,
      identityId: bob.identityId,
      uploadId: "upload_bob_fact",
      segmentId: "segment_bob_fact",
      text: "I like tea."
    });
    const aliceFact = repository.createFact({
      accountId: "account_user",
      subjectPersonId: alice.person.id,
      kind: "preference",
      factKey: "beverage.preference",
      derivedText: "Alice likes coffee.",
      observedAt: "2026-08-01T12:00:00.000Z",
      validFrom: "2026-08-01T09:00:00.000Z",
      evidence: aliceEvidence
    });
    const bobFact = repository.createFact({
      accountId: "account_user",
      subjectPersonId: bob.person.id,
      kind: "preference",
      factKey: "beverage.preference",
      derivedText: "Bob likes tea.",
      observedAt: "2026-08-05T12:00:00.000Z",
      validFrom: "2026-08-05T09:00:00.000Z",
      evidence: bobEvidence
    });
    const transitionEvidence = await exactSubjectEvidence({
      database,
      store,
      personId: alice.person.id,
      identityId: alice.identityId,
      uploadId: "upload_cross_subject_transition",
      segmentId: "segment_cross_subject_transition",
      text: "This explicitly changes my preference."
    });
    expectCode(() => repository.supersedeFact({
      accountId: "account_user",
      factId: aliceFact.id,
      replacementFactId: bobFact.id,
      observedAt: "2026-08-06T12:00:00.000Z",
      occurredAt: "2026-08-06T09:00:00.000Z",
      validTo: bobFact.validFrom,
      expectedVersion: 1,
      evidence: transitionEvidence
    }), "incompatible_replacement");
    expect(repository.getFact("account_user", aliceFact.id)?.status).toBe("active");
    expect(repository.getFact("account_user", bobFact.id)?.status).toBe("active");
  });
});
