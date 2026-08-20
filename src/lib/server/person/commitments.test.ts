// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createPersonCommitmentRepository } from "./commitments";
import { PersonLifecycleError } from "./lifecycle-support";
import { createPersonRepository } from "./repository";
import {
  LifecycleTranscriptStore,
  confirmedLifecycleRelationship,
  createConfirmedLifecyclePerson,
  exactSharedSubjectEvidence
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

async function twoPeople(accountId = "account_user", suffix = "main") {
  const alice = await createConfirmedLifecyclePerson({
    database,
    store,
    accountId,
    displayName: "Alice",
    identityId: `identity_alice_${suffix}`,
    uploadId: `upload_alice_${suffix}`,
    segmentId: `segment_alice_${suffix}`
  });
  const bob = await createConfirmedLifecyclePerson({
    database,
    store,
    accountId,
    displayName: "Bob",
    identityId: `identity_bob_${suffix}`,
    uploadId: `upload_bob_${suffix}`,
    segmentId: `segment_bob_${suffix}`
  });
  return { alice, bob };
}

async function sharedEvidence(input: {
  alice: Awaited<ReturnType<typeof createConfirmedLifecyclePerson>>;
  bob: Awaited<ReturnType<typeof createConfirmedLifecyclePerson>>;
  uploadId: string;
  segmentId: string;
  text: string;
  accountId?: string;
}) {
  return exactSharedSubjectEvidence({
    database,
    store,
    accountId: input.accountId,
    primaryPersonId: input.alice.person.id,
    primaryIdentityId: input.alice.identityId,
    secondaryPersonId: input.bob.person.id,
    uploadId: input.uploadId,
    segmentId: input.segmentId,
    text: input.text
  });
}

describe("Evidence-backed Person Commitments", () => {
  it("returns unknown for incomplete roles and enforces the explicit created-active-completed state machine", async () => {
    const { alice, bob } = await twoPeople();
    const repository = createPersonCommitmentRepository(database);
    expect(repository.createCommitment({
      accountId: "account_user",
      promisorPersonId: alice.person.id,
      promiseePersonId: null,
      text: "Send the draft.",
      observedAt: "2026-08-01T12:00:00.000Z",
      occurredAt: "2026-08-01T09:00:00.000Z",
      evidence: null
    })).toEqual({ known: false, reason: "insufficient_evidence", commitment: null });
    expect(repository.createCommitment({
      accountId: "account_user",
      promisorPersonId: alice.person.id,
      promiseePersonId: alice.person.id,
      text: "Send the draft.",
      observedAt: "2026-08-01T12:00:00.000Z",
      occurredAt: "2026-08-01T09:00:00.000Z",
      evidence: null
    })).toEqual({ known: false, reason: "insufficient_evidence", commitment: null });

    const baseEvidence = await sharedEvidence({
      alice,
      bob,
      uploadId: "upload_commitment_base",
      segmentId: "segment_commitment_base",
      text: "Alice explicitly promised Bob to send the draft."
    });
    const created = repository.createCommitment({
      accountId: "account_user",
      promisorPersonId: alice.person.id,
      promiseePersonId: bob.person.id,
      text: "Send the draft.",
      observedAt: "2026-08-01T12:00:00.000Z",
      occurredAt: "2026-08-01T09:00:00.000Z",
      evidence: baseEvidence
    });
    expect(created).toMatchObject({ known: true, commitment: { status: "created", version: 1 } });
    expect(repository.createCommitment({
      accountId: "account_user",
      promisorPersonId: alice.person.id,
      promiseePersonId: bob.person.id,
      text: "Send the draft.",
      observedAt: "2026-08-01T12:00:00.000Z",
      occurredAt: "2026-08-01T09:00:00.000Z",
      evidence: baseEvidence
    })).toEqual(created);
    if (!created.known) throw new Error("Expected a canonical Commitment");

    const prematureCompletionEvidence = await sharedEvidence({
      alice,
      bob,
      uploadId: "upload_premature_completion",
      segmentId: "segment_premature_completion",
      text: "The draft was sent."
    });
    expectCode(() => repository.transitionCommitment({
      accountId: "account_user",
      commitmentId: created.commitment.id,
      toStatus: "completed",
      observedAt: "2026-08-02T12:00:00.000Z",
      occurredAt: "2026-08-02T09:00:00.000Z",
      expectedVersion: 1,
      evidence: prematureCompletionEvidence
    }), "invalid_transition");

    const activeEvidence = await sharedEvidence({
      alice,
      bob,
      uploadId: "upload_commitment_active",
      segmentId: "segment_commitment_active",
      text: "Alice confirmed the promise is active."
    });
    const activeInput = {
      accountId: "account_user",
      commitmentId: created.commitment.id,
      toStatus: "active" as const,
      observedAt: "2026-08-02T12:00:00.000Z",
      occurredAt: "2026-08-02T09:00:00.000Z",
      expectedVersion: 1,
      evidence: activeEvidence
    };
    const active = repository.transitionCommitment(activeInput);
    expect(active).toMatchObject({ status: "active", version: 2, resolvedAt: null });
    expect(repository.transitionCommitment(activeInput)).toEqual(active);

    const completedEvidence = await sharedEvidence({
      alice,
      bob,
      uploadId: "upload_commitment_completed",
      segmentId: "segment_commitment_completed",
      text: "Alice sent Bob the draft."
    });
    expectCode(() => repository.transitionCommitment({
      accountId: "account_user",
      commitmentId: created.commitment.id,
      toStatus: "completed",
      observedAt: "2026-08-03T12:00:00.000Z",
      occurredAt: "2026-08-03T09:00:00.000Z",
      expectedVersion: 1,
      evidence: completedEvidence
    }), "version_conflict");
    const completed = repository.transitionCommitment({
      accountId: "account_user",
      commitmentId: created.commitment.id,
      toStatus: "completed",
      observedAt: "2026-08-03T12:00:00.000Z",
      occurredAt: "2026-08-03T09:00:00.000Z",
      expectedVersion: 2,
      evidence: completedEvidence
    });
    expect(completed).toMatchObject({
      status: "completed",
      version: 3,
      resolvedAt: "2026-08-03T09:00:00.000Z"
    });
    expect(completed.transitions).toHaveLength(2);
    expectCode(() => repository.transitionCommitment({
      accountId: "account_user",
      commitmentId: created.commitment.id,
      toStatus: "cancelled",
      observedAt: "2026-08-04T12:00:00.000Z",
      occurredAt: "2026-08-04T09:00:00.000Z",
      expectedVersion: 3,
      evidence: completedEvidence
    }), "invalid_transition");
  });

  it("supports Evidence-backed cancellation and supersession without deleting the old Commitment", async () => {
    const { alice, bob } = await twoPeople();
    const repository = createPersonCommitmentRepository(database);
    const oldEvidence = await sharedEvidence({
      alice,
      bob,
      uploadId: "upload_old_commitment",
      segmentId: "segment_old_commitment",
      text: "Alice promised Bob the first draft."
    });
    const replacementEvidence = await sharedEvidence({
      alice,
      bob,
      uploadId: "upload_new_commitment",
      segmentId: "segment_new_commitment",
      text: "Alice promised Bob a revised draft instead."
    });
    const oldResult = repository.createCommitment({
      accountId: "account_user",
      promisorPersonId: alice.person.id,
      promiseePersonId: bob.person.id,
      text: "Send the first draft.",
      observedAt: "2026-08-01T12:00:00.000Z",
      occurredAt: "2026-08-01T09:00:00.000Z",
      evidence: oldEvidence
    });
    const replacementResult = repository.createCommitment({
      accountId: "account_user",
      promisorPersonId: alice.person.id,
      promiseePersonId: bob.person.id,
      text: "Send the revised draft.",
      observedAt: "2026-08-05T12:00:00.000Z",
      occurredAt: "2026-08-05T09:00:00.000Z",
      evidence: replacementEvidence
    });
    if (!oldResult.known || !replacementResult.known) throw new Error("Expected canonical Commitments");
    const oldActiveEvidence = await sharedEvidence({
      alice,
      bob,
      uploadId: "upload_old_active",
      segmentId: "segment_old_active",
      text: "The first-draft promise became active."
    });
    repository.transitionCommitment({
      accountId: "account_user",
      commitmentId: oldResult.commitment.id,
      toStatus: "active",
      observedAt: "2026-08-02T12:00:00.000Z",
      occurredAt: "2026-08-02T09:00:00.000Z",
      expectedVersion: 1,
      evidence: oldActiveEvidence
    });
    const replacementActiveEvidence = await sharedEvidence({
      alice,
      bob,
      uploadId: "upload_new_active",
      segmentId: "segment_new_active",
      text: "The revised-draft promise became active."
    });
    repository.transitionCommitment({
      accountId: "account_user",
      commitmentId: replacementResult.commitment.id,
      toStatus: "active",
      observedAt: "2026-08-06T12:00:00.000Z",
      occurredAt: "2026-08-06T09:00:00.000Z",
      expectedVersion: 1,
      evidence: replacementActiveEvidence
    });
    const supersedeEvidence = await sharedEvidence({
      alice,
      bob,
      uploadId: "upload_commitment_supersede",
      segmentId: "segment_commitment_supersede",
      text: "The revised-draft promise explicitly replaces the first-draft promise."
    });
    const superseded = repository.supersedeCommitment({
      accountId: "account_user",
      commitmentId: oldResult.commitment.id,
      replacementCommitmentId: replacementResult.commitment.id,
      observedAt: "2026-08-07T12:00:00.000Z",
      occurredAt: "2026-08-07T09:00:00.000Z",
      expectedVersion: 2,
      evidence: supersedeEvidence
    });
    expect(superseded).toMatchObject({
      status: "superseded",
      supersededBy: replacementResult.commitment.id,
      version: 3
    });
    expect(repository.getCommitment("account_user", oldResult.commitment.id)).not.toBeNull();
    expect(repository.getCommitment("account_user", replacementResult.commitment.id)?.status).toBe("active");

    const cancelEvidence = await sharedEvidence({
      alice,
      bob,
      uploadId: "upload_cancel",
      segmentId: "segment_cancel",
      text: "The revised-draft promise was cancelled."
    });
    expect(repository.transitionCommitment({
      accountId: "account_user",
      commitmentId: replacementResult.commitment.id,
      toStatus: "cancelled",
      observedAt: "2026-08-08T12:00:00.000Z",
      occurredAt: "2026-08-08T09:00:00.000Z",
      expectedVersion: 2,
      evidence: cancelEvidence
    }).status).toBe("cancelled");
  });

  it("fails closed on extra Subjects/cross-account Evidence and replays after transition or base Evidence deletion", async () => {
    const { alice, bob } = await twoPeople();
    const repository = createPersonCommitmentRepository(database);
    const baseEvidence = await sharedEvidence({
      alice,
      bob,
      uploadId: "upload_commitment_base",
      segmentId: "segment_commitment_base",
      text: "Alice promised Bob to call."
    });
    const result = repository.createCommitment({
      accountId: "account_user",
      promisorPersonId: alice.person.id,
      promiseePersonId: bob.person.id,
      text: "Call Bob.",
      observedAt: "2026-08-01T12:00:00.000Z",
      occurredAt: "2026-08-01T09:00:00.000Z",
      evidence: baseEvidence
    });
    if (!result.known) throw new Error("Expected a canonical Commitment");
    const activeEvidence = await sharedEvidence({
      alice,
      bob,
      uploadId: "upload_commitment_active",
      segmentId: "segment_commitment_active",
      text: "The call promise is active."
    });
    repository.transitionCommitment({
      accountId: "account_user",
      commitmentId: result.commitment.id,
      toStatus: "active",
      observedAt: "2026-08-02T12:00:00.000Z",
      occurredAt: "2026-08-02T09:00:00.000Z",
      expectedVersion: 1,
      evidence: activeEvidence
    });
    const completedEvidence = await sharedEvidence({
      alice,
      bob,
      uploadId: "upload_commitment_completed",
      segmentId: "segment_commitment_completed",
      text: "Alice called Bob."
    });
    repository.transitionCommitment({
      accountId: "account_user",
      commitmentId: result.commitment.id,
      toStatus: "completed",
      observedAt: "2026-08-03T12:00:00.000Z",
      occurredAt: "2026-08-03T09:00:00.000Z",
      expectedVersion: 2,
      evidence: completedEvidence
    });

    const transitionDeletion = createPersonRepository(database).deleteByUpload(
      "account_user",
      "upload_commitment_completed",
      "2026-08-10T12:00:00.000Z"
    );
    expect(transitionDeletion).toMatchObject({
      deletedCommitmentTransitionCount: 1,
      deletedCommitmentCount: 0,
      recalculatedCommitmentCount: 1
    });
    expect(repository.getCommitment("account_user", result.commitment.id)).toMatchObject({
      status: "active",
      version: 2,
      resolvedAt: null
    });

    const other = await twoPeople("account_other", "other");
    const otherEvidence = await sharedEvidence({
      alice: other.alice,
      bob: other.bob,
      accountId: "account_other",
      uploadId: "upload_other_commitment",
      segmentId: "segment_other_commitment",
      text: "Other Alice promised Other Bob to call."
    });
    const otherCommitment = repository.createCommitment({
      accountId: "account_other",
      promisorPersonId: other.alice.person.id,
      promiseePersonId: other.bob.person.id,
      text: "Call Other Bob.",
      observedAt: "2026-08-04T12:00:00.000Z",
      occurredAt: "2026-08-04T09:00:00.000Z",
      evidence: otherEvidence
    });
    if (!otherCommitment.known) throw new Error("Expected other-account Commitment");
    expectCode(() => repository.createCommitment({
      accountId: "account_user",
      promisorPersonId: alice.person.id,
      promiseePersonId: bob.person.id,
      text: "Cross-account call.",
      observedAt: "2026-08-04T12:00:00.000Z",
      occurredAt: "2026-08-04T09:00:00.000Z",
      evidence: otherEvidence
    }), "evidence_account_mismatch");

    const carol = await createConfirmedLifecyclePerson({
      database,
      store,
      displayName: "Carol",
      identityId: "identity_carol",
      uploadId: "upload_carol",
      segmentId: "segment_carol"
    });
    const aliceCarolRelationship = await confirmedLifecycleRelationship({
      database,
      store,
      personAId: alice.person.id,
      personBId: carol.person.id,
      uploadId: "upload_alice_carol_relationship",
      segmentId: "segment_alice_carol_relationship"
    });
    const mismatchedRelationshipEvidence = await sharedEvidence({
      alice,
      bob,
      uploadId: "upload_mismatched_relationship_commitment",
      segmentId: "segment_mismatched_relationship_commitment",
      text: "Alice promised Bob another call."
    });
    expectCode(() => repository.createCommitment({
      accountId: "account_user",
      relationshipId: aliceCarolRelationship.id,
      promisorPersonId: alice.person.id,
      promiseePersonId: bob.person.id,
      text: "Call Bob again.",
      observedAt: "2026-08-04T12:00:00.000Z",
      occurredAt: "2026-08-04T09:00:00.000Z",
      evidence: mismatchedRelationshipEvidence
    }), "unavailable_relationship");

    const archivedRoleEvidence = await exactSharedSubjectEvidence({
      database,
      store,
      primaryPersonId: alice.person.id,
      primaryIdentityId: alice.identityId,
      secondaryPersonId: carol.person.id,
      uploadId: "upload_archived_role_commitment",
      segmentId: "segment_archived_role_commitment",
      text: "Alice promised Carol to call."
    });
    database.prepare(`
      INSERT INTO person_subject_observations (
        id, account_id, person_id, evidence_id, status, source, reason,
        confirmed_at, created_at, updated_at
      ) VALUES (?, 'account_user', ?, ?, 'confirmed', 'manual_review', ?, ?, ?, ?)
    `).run(
      "extra_subject_commitment",
      carol.person.id,
      activeEvidence.id,
      "explicit test conflict",
      "2026-08-10T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z"
    );
    expectCode(() => repository.createCommitment({
      accountId: "account_user",
      promisorPersonId: alice.person.id,
      promiseePersonId: bob.person.id,
      text: "Ambiguous roles.",
      observedAt: "2026-08-04T12:00:00.000Z",
      occurredAt: "2026-08-04T09:00:00.000Z",
      evidence: activeEvidence
    }), "subject_evidence_mismatch");

    database.prepare(`
      UPDATE person_entities SET status = 'archived' WHERE id = ? AND account_id = 'account_user'
    `).run(carol.person.id);
    expectCode(() => repository.createCommitment({
      accountId: "account_user",
      promisorPersonId: alice.person.id,
      promiseePersonId: carol.person.id,
      text: "Call Carol.",
      observedAt: "2026-08-04T12:00:00.000Z",
      occurredAt: "2026-08-04T09:00:00.000Z",
      evidence: archivedRoleEvidence
    }), "unavailable_person");

    const baseDeletion = createPersonRepository(database).deleteByUpload(
      "account_user",
      "upload_commitment_base",
      "2026-08-10T13:00:00.000Z"
    );
    expect(baseDeletion.deletedCommitmentCount).toBe(1);
    expect(repository.getCommitment("account_user", result.commitment.id)).toBeNull();
    expect(repository.getCommitment("account_other", otherCommitment.commitment.id)).not.toBeNull();
  });
});
