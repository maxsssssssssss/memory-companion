import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chatCreateMock = vi.hoisted(() => vi.fn());
const createOpenAIClientMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/openai/client", () => ({
  createOpenAIClient: createOpenAIClientMock,
  resolveOpenAIClientProvider: vi.fn(() => "openai-compatible")
}));

vi.mock("@/lib/server/settings/provider-config", () => ({
  getOpenAIClientRuntimeConfig: vi.fn(async () => ({ openAiApiKey: "deterministic-test-key" })),
  getQaModelPreference: vi.fn(async () => "deterministic-test-model"),
  getQaPromptPreference: vi.fn(async () => "")
}));

import type { AudioUpload, TranscriptSegment } from "@/lib/domain/types";
import { openDateCompanionDatabase } from "@/lib/server/date-companion/db";
import {
  dateCompanionEvidenceDigest,
  dateCompanionMemoryProjectionIdempotencyKey,
  stableBridgeDigest
} from "@/lib/server/date-companion/memory-bridge-digest";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import { captureRetainedMemoryEvidenceProvenance } from "@/lib/server/memory/retention-provenance";
import { answerQuestionWithAI, retrieveQaEvidence } from "@/lib/server/retrieval/ai-qa";
import { createRelationshipContextBuilder } from "./relationship-context";
import {
  createConfirmedLifecyclePerson,
  exactSubjectEvidence,
  LifecycleTranscriptStore
} from "./lifecycle-test-fixtures";
import { createTemporalFactRepository } from "./temporal-facts";
import type {
  PersonCommitment,
  PersonEvidence,
  PersonFact,
  PersonFactTransition
} from "./types";
import {
  answerPersonRelationshipQuestion,
  buildPersonRelationshipQaContext,
  buildPersonRelationshipQaInput,
  type PersonRelationshipQaSourceContext
} from "./person-relationship-qa";
import { resolveTrustedPersonQaEvidence } from "./person-relationship-qa-evidence-resolver";

const SAFE_UNCERTAINTY_ANSWER = "没有找到足够证据确认这个信息。";
const originalQaWireApi = process.env.OPENAI_QA_WIRE_API;

class CanonicalTranscriptStore {
  private readonly values = new Map<string, unknown>();

  put(
    evidence: PersonEvidence,
    startSeconds = 1,
    endSeconds = 5,
    speaker?: string
  ) {
    const upload: AudioUpload = {
      id: evidence.uploadId,
      originalName: `${evidence.uploadId}.wav`,
      mimeType: "audio/wav",
      sizeBytes: 1024,
      recordingDate: "2026-08-10",
      status: "ready"
    };
    const segment: TranscriptSegment = {
      id: evidence.sourceSegmentId,
      uploadId: evidence.uploadId,
      startSeconds,
      endSeconds,
      text: evidence.quote,
      confidence: 0.98,
      speaker,
      sceneLabels: ["private_content"],
      valueLabels: []
    };
    this.values.set(`uploads/${evidence.uploadId}`, upload);
    const existing = (this.values.get(`segments/${evidence.uploadId}`) ?? []) as TranscriptSegment[];
    this.values.set(`segments/${evidence.uploadId}`, [...existing, segment]);
  }

  async read<T>(collection: string, id: string) {
    return (this.values.get(`${collection}/${id}`) ?? null) as T | null;
  }
}

function evidence(input: {
  id: string;
  text: string;
  accountId?: string;
  uploadId?: string;
  segmentId?: string;
}): PersonEvidence {
  return {
    id: input.id,
    accountId: input.accountId ?? "account_a",
    uploadId: input.uploadId ?? `upload_${input.id}`,
    sourceSegmentId: input.segmentId ?? `segment_${input.id}`,
    quote: input.text,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z"
  };
}

function fact(input: {
  id: string;
  evidence: PersonEvidence[];
  status?: PersonFact["status"];
  supersededBy?: string | null;
  transitions?: PersonFactTransition[];
}): PersonFact {
  return {
    id: input.id,
    accountId: "account_a",
    subjectPersonId: "person_a",
    relationshipId: null,
    kind: "preference",
    factKey: `preference.${input.id}`,
    derivedText: `DERIVED ${input.id}`,
    observedAt: "2026-08-01T10:00:00.000Z",
    validFrom: "2026-08-01T09:00:00.000Z",
    validTo: input.status === "superseded" ? "2026-08-05T09:00:00.000Z" : null,
    status: input.status ?? "active",
    supersededBy: input.supersededBy ?? null,
    version: input.status === "superseded" ? 2 : 1,
    evidence: input.evidence,
    transitions: input.transitions ?? [],
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z"
  };
}

function commitment(input: {
  evidence: PersonEvidence[];
  transitionEvidence: PersonEvidence;
  status?: Extract<
    PersonCommitment["status"],
    "active" | "completed" | "cancelled" | "superseded"
  >;
}): PersonCommitment {
  const status = input.status ?? "active";
  return {
    id: `commitment_${status}`,
    accountId: "account_a",
    relationshipId: null,
    promisorPersonId: "person_a",
    promiseePersonId: "person_b",
    text: "DERIVED commitment text",
    status,
    observedAt: "2026-08-02T10:00:00.000Z",
    occurredAt: "2026-08-02T09:00:00.000Z",
    resolvedAt: status === "completed" ? "2026-08-03T09:00:00.000Z" : null,
    supersededBy: null,
    version: 2,
    evidence: input.evidence,
    transitions: [{
      id: `transition_${status}`,
      accountId: "account_a",
      commitmentId: `commitment_${status}`,
      fromStatus: "created",
      toStatus: status,
      observedAt: "2026-08-03T10:00:00.000Z",
      occurredAt: "2026-08-03T09:00:00.000Z",
      replacementCommitmentId: null,
      evidence: input.transitionEvidence,
      expectedVersion: 1,
      resultingVersion: 2,
      applied: true,
      invalidReason: null,
      createdAt: "2026-08-03T10:00:00.000Z",
      updatedAt: "2026-08-03T10:00:00.000Z"
    }],
    createdAt: "2026-08-02T10:00:00.000Z",
    updatedAt: "2026-08-03T10:00:00.000Z"
  };
}

function sourceContext(input: {
  activeFacts?: PersonFact[];
  previousFacts?: PersonFact[];
  recentChanges?: PersonRelationshipQaSourceContext["recentChanges"];
  activeCommitments?: PersonCommitment[];
  completedCommitments?: PersonCommitment[];
  relationshipEvidence?: PersonEvidence[];
  known?: boolean;
} = {}): PersonRelationshipQaSourceContext {
  const activeFacts = input.activeFacts ?? [];
  const previousFacts = input.previousFacts ?? [];
  return {
    known: input.known ?? true,
    asOf: "2026-08-10T23:59:59.000Z",
    person: { id: "person_a", accountId: "account_a" },
    confirmedRelationships: input.relationshipEvidence
      ? [{ evidence: input.relationshipEvidence }]
      : [],
    recentFacts: [...activeFacts, ...previousFacts],
    activeFacts,
    previousFacts,
    recentChanges: input.recentChanges ?? [],
    activeCommitments: input.activeCommitments ?? [],
    completedCommitments: input.completedCommitments ?? []
  };
}

async function installTrustedSnapshotFixture(input: {
  quote?: string;
  subject?: "self" | "companion" | "both" | "unknown";
} = {}) {
  const now = "2026-08-10T10:00:00.000Z";
  const quote = input.quote ?? "Alice said the old blue notebook is in Lisbon.";
  const subject = input.subject ?? "companion";
  const snapshotEvidence = evidence({
    id: "snapshot",
    text: quote,
    uploadId: "upload_snapshot",
    segmentId: "segment_snapshot"
  });
  for (const [personId, name] of [
    ["person_self", "Self"],
    ["person_a", "Alice"],
    ["person_other", "Alice"]
  ]) {
    database.prepare(`
      INSERT INTO person_entities (
        id, account_id, display_name, source, status, created_at, updated_at
      ) VALUES (?, 'account_a', ?, 'manual_confirmation', 'confirmed', ?, ?)
    `).run(personId, name, now, now);
  }
  database.prepare(`
    INSERT INTO person_evidence (
      id, account_id, upload_id, source_segment_id, quote, created_at, updated_at
    ) VALUES (?, 'account_a', ?, ?, ?, ?, ?)
  `).run(
    snapshotEvidence.id,
    snapshotEvidence.uploadId,
    snapshotEvidence.sourceSegmentId,
    snapshotEvidence.quote,
    now,
    now
  );
  database.prepare(`
    INSERT INTO person_self_bindings (
      account_id, person_id, status, version, set_at, created_at, updated_at
    ) VALUES ('account_a', 'person_self', 'active', 1, ?, ?, ?)
  `).run(now, now, now);
  database.prepare(`
    INSERT INTO person_relationships (
      id, account_id, person_a_id, person_b_id, type, status,
      explicitly_confirmed, confirmed_at, created_at, updated_at
    ) VALUES (
      'person_relationship_1', 'account_a', 'person_a', 'person_self', 'dating',
      'confirmed', 1, ?, ?, ?
    )
  `).run(now, now, now);
  database.prepare(`
    INSERT INTO person_relationship_evidence (
      id, account_id, relationship_id, evidence_id, created_at
    ) VALUES ('person_relationship_evidence_1', 'account_a',
      'person_relationship_1', ?, ?)
  `).run(snapshotEvidence.id, now);

  dateCompanionDatabase.prepare(`
    INSERT INTO dc_relationships (
      id, user_id, display_name, status, version, created_at, updated_at
    ) VALUES ('dc_relationship_1', 'account_a', 'Alice', 'active', 1, ?, ?)
  `).run(now, now);
  dateCompanionDatabase.prepare(`
    INSERT INTO dc_interactions (
      id, user_id, relationship_id, source_upload_id, recording_date,
      original_name, duration_seconds, status, source_state, version,
      created_at, updated_at, confirmed_at, confirmation_fingerprint
    ) VALUES (
      'dc_interaction_1', 'account_a', 'dc_relationship_1', ?, '2026-08-01',
      'snapshot.wav', 30, 'confirmed', 'server_cleaned', 2, ?, ?, ?, 'fingerprint_1'
    )
  `).run(snapshotEvidence.uploadId, now, now, now);
  dateCompanionDatabase.prepare(`
    INSERT INTO dc_participant_assignments (
      user_id, interaction_id, speaker_id, role, confirmed_by, confirmed_at
    ) VALUES ('account_a', 'dc_interaction_1', 'speaker_alice',
      'companion', 'account_a', ?)
  `).run(now);
  dateCompanionDatabase.prepare(`
    INSERT INTO dc_recap_items (
      id, user_id, interaction_id, kind, proposed_text, user_text,
      disposition, version, sort_order, created_at, updated_at
    ) VALUES ('recap_1', 'account_a', 'dc_interaction_1', 'mentioned',
      'DERIVED recap text', NULL, 'kept', 1, 0, ?, ?)
  `).run(now, now);
  const snapshotDigest = dateCompanionEvidenceDigest({
    userId: "account_a",
    uploadId: snapshotEvidence.uploadId,
    sourceSegmentId: snapshotEvidence.sourceSegmentId,
    startSeconds: 10,
    endSeconds: 15,
    speakerId: "speaker_alice",
    quote
  });
  dateCompanionDatabase.prepare(`
    INSERT INTO dc_evidence_snapshots (
      id, user_id, recap_item_id, upload_id, source_segment_id,
      start_seconds, end_seconds, speaker_id, quote, created_at,
      provenance_version, source_kind, content_digest
    ) VALUES ('snapshot_1', 'account_a', 'recap_1', ?, ?, 10, 15,
      'speaker_alice', ?, ?, 1, 'date_companion_recap', ?)
  `).run(
    snapshotEvidence.uploadId,
    snapshotEvidence.sourceSegmentId,
    quote,
    now,
    snapshotDigest
  );
  dateCompanionDatabase.prepare(`
    INSERT INTO dc_relationship_person_mappings (
      id, user_id, relationship_id, self_person_id, companion_person_id,
      relationship_type, status, version, confirmed_at, created_at, updated_at
    ) VALUES ('mapping_1', 'account_a', 'dc_relationship_1', 'person_self',
      'person_a', 'dating', 'confirmed', 1, ?, ?, ?)
  `).run(now, now, now);
  dateCompanionDatabase.prepare(`
    INSERT INTO dc_memory_subject_selections (
      id, user_id, relationship_id, interaction_id, recap_item_id,
      evidence_snapshot_id, subject, version, created_at, updated_at
    ) VALUES ('selection_1', 'account_a', 'dc_relationship_1',
      'dc_interaction_1', 'recap_1', 'snapshot_1', ?, 1, ?, ?)
  `).run(subject, now, now);
  const payload = {
    version: 1,
    userId: "account_a",
    relationshipId: "dc_relationship_1",
    interactionId: "dc_interaction_1",
    sourceUploadId: snapshotEvidence.uploadId,
    sourceVersion: 2,
    confirmationFingerprint: "fingerprint_1",
    mapping: {
      version: 1,
      selfPersonId: "person_self",
      companionPersonId: "person_a",
      relationshipType: "dating"
    },
    selections: [{
      evidenceSnapshotId: "snapshot_1",
      recapItemId: "recap_1",
      uploadId: snapshotEvidence.uploadId,
      sourceSegmentId: snapshotEvidence.sourceSegmentId,
      contentDigest: snapshotDigest,
      subject
    }]
  };
  const payloadDigest = stableBridgeDigest(payload);
  dateCompanionDatabase.prepare(`
    INSERT INTO dc_memory_bridge_outbox (
      id, user_id, relationship_id, interaction_id, idempotency_key,
      payload_digest, payload_json, mapping_version, source_version,
      confirmation_fingerprint, status, attempt_count, requested_at,
      updated_at, completed_at
    ) VALUES ('outbox_1', 'account_a', 'dc_relationship_1', 'dc_interaction_1',
      'idempotency_1', ?, ?, 1, 2, 'fingerprint_1', 'completed', 1, ?, ?, ?)
  `).run(payloadDigest, JSON.stringify(payload), now, now, now);

  createMemoryRepository(database).replaceUploadMemories({
    userId: "account_a",
    uploadId: snapshotEvidence.uploadId,
    memories: [{
      id: "memory_snapshot",
      type: "event",
      title: "Old notebook",
      summary: "DERIVED Memory summary",
      importance: 0.8,
      date: "2026-08-10",
      createdAt: now,
      updatedAt: now,
      evidence: [{
        id: "memory_evidence_snapshot",
        sourceType: "transcript",
        sourceId: snapshotEvidence.sourceSegmentId,
        uploadId: snapshotEvidence.uploadId,
        date: "2026-08-10",
        quote: snapshotEvidence.quote,
        createdAt: now
      }]
    }]
  });
  const captureStore = new CanonicalTranscriptStore();
  captureStore.put(snapshotEvidence, 10, 15, "speaker_alice");
  await captureRetainedMemoryEvidenceProvenance({
    database,
    store: captureStore as never,
    userId: "account_a",
    uploadId: snapshotEvidence.uploadId,
    relationshipId: "dc_relationship_1",
    interactionId: "dc_interaction_1",
    now
  });
  database.prepare(`
    INSERT INTO dc_person_relationship_links (
      account_id, dc_relationship_id, person_relationship_id, mapping_version,
      self_person_id, companion_person_id, relationship_type, status,
      created_at, updated_at
    ) VALUES ('account_a', 'dc_relationship_1', 'person_relationship_1', 1,
      'person_self', 'person_a', 'dating', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO person_evidence_dc_links (
      id, account_id, person_evidence_id, dc_relationship_id,
      dc_interaction_id, dc_evidence_snapshot_id, snapshot_digest, created_at
    ) VALUES ('evidence_link_1', 'account_a', ?, 'dc_relationship_1',
      'dc_interaction_1', 'snapshot_1', ?, ?)
  `).run(snapshotEvidence.id, snapshotDigest, now);
  const projectionKey = dateCompanionMemoryProjectionIdempotencyKey("idempotency_1");
  database.prepare(`
    INSERT INTO dc_memory_bridge_receipts (
      id, account_id, idempotency_key, payload_digest, dc_relationship_id,
      dc_interaction_id, dc_outbox_id, mapping_version, committed_at
    ) VALUES ('receipt_1', 'account_a', ?, ?,
      'dc_relationship_1', 'dc_interaction_1', 'outbox_1', 1, ?)
  `).run(projectionKey, payloadDigest, now);
  database.prepare(`
    INSERT INTO dc_memory_bridge_candidate_receipts (
      id, account_id, operation_receipt_id, dc_outbox_id, dc_interaction_id,
      recap_item_id, origin_key, status, memory_id, score, reasons_json,
      evidence_digest, created_at
    ) VALUES (
      'candidate_receipt_1', 'account_a', 'receipt_1', 'outbox_1',
      'dc_interaction_1', 'recap_1', 'date_companion:recap_1', 'admitted',
      'memory_snapshot', 1, '[]', ?, ?
    )
  `).run(snapshotDigest, now);

  return {
    snapshotEvidence,
    resolver: ({ accountId, personId, evidence: selectedEvidence }: {
      accountId: string;
      personId: string;
      evidence: readonly PersonEvidence[];
    }) => resolveTrustedPersonQaEvidence({
      memoryDatabase: database,
      dateCompanionDatabase,
      accountId,
      personId,
      evidence: selectedEvidence
    })
  };
}

let database: Database.Database;
let dateCompanionDatabase: Database.Database;

beforeEach(() => {
  database = openMemoryDatabase({ filePath: ":memory:" });
  dateCompanionDatabase = openDateCompanionDatabase({ filePath: ":memory:" });
  chatCreateMock.mockReset();
  createOpenAIClientMock.mockReturnValue({
    chat: { completions: { create: chatCreateMock } }
  });
  delete process.env.OPENAI_QA_WIRE_API;
});

afterEach(() => {
  dateCompanionDatabase.close();
  database.close();
  if (originalQaWireApi === undefined) delete process.env.OPENAI_QA_WIRE_API;
  else process.env.OPENAI_QA_WIRE_API = originalQaWireApi;
});

describe("Person-scoped Relationship QA Evidence allowlist", () => {
  it("keeps same-name People isolated by explicit personId and can retrieve an older Fact", async () => {
    const store = new LifecycleTranscriptStore();
    const aliceA = await createConfirmedLifecyclePerson({
      database,
      store,
      displayName: "Alice",
      identityId: "identity_alice_a",
      uploadId: "upload_alice_a",
      segmentId: "segment_alice_a"
    });
    const aliceB = await createConfirmedLifecyclePerson({
      database,
      store,
      displayName: "Alice",
      identityId: "identity_alice_b",
      uploadId: "upload_alice_b",
      segmentId: "segment_alice_b"
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
    const oldAliceEvidence = await exactSubjectEvidence({
      database,
      store,
      personId: aliceA.person.id,
      identityId: aliceA.identityId,
      uploadId: "upload_alice_old",
      segmentId: "segment_alice_old",
      text: "Alice said the old blue notebook is in Lisbon."
    });
    facts.createFact({
      accountId: "account_user",
      subjectPersonId: aliceA.person.id,
      kind: "location",
      factKey: "notebook.location",
      derivedText: "Alice's notebook is in Lisbon.",
      observedAt: "2026-08-01T12:00:00.000Z",
      evidence: oldAliceEvidence
    });
    const otherAliceEvidence = await exactSubjectEvidence({
      database,
      store,
      personId: aliceB.person.id,
      identityId: aliceB.identityId,
      uploadId: "upload_alice_b_secret",
      segmentId: "segment_alice_b_secret",
      text: "Other same-name Alice has a private Madrid note."
    });
    facts.createFact({
      accountId: "account_user",
      subjectPersonId: aliceB.person.id,
      kind: "location",
      factKey: "private.location",
      derivedText: "Other Alice is in Madrid.",
      observedAt: "2026-08-02T12:00:00.000Z",
      evidence: otherAliceEvidence
    });
    const bobEvidence = await exactSubjectEvidence({
      database,
      store,
      personId: bob.person.id,
      identityId: bob.identityId,
      uploadId: "upload_bob_mentions_alice",
      segmentId: "segment_bob_mentions_alice",
      text: "Bob's own fact mentions Alice but belongs to Bob."
    });
    facts.createFact({
      accountId: "account_user",
      subjectPersonId: bob.person.id,
      kind: "note",
      factKey: "bob.note",
      derivedText: "Bob mentioned Alice.",
      observedAt: "2026-08-03T12:00:00.000Z",
      evidence: bobEvidence
    });

    const context = createRelationshipContextBuilder(database).buildRelationshipContext({
      accountId: "account_user",
      personId: aliceA.person.id,
      asOf: "2026-08-10T23:59:59.000Z"
    });
    const qaInput = await buildPersonRelationshipQaInput({
      userId: "account_user",
      personId: aliceA.person.id,
      question: "蓝色笔记本在哪里？",
      conversation: [],
      settingsStore: store as never,
      sourceContext: context
    });

    expect(qaInput.segments.map((segment) => segment.id)).toEqual(["segment_alice_old"]);
    expect(JSON.stringify(qaInput)).not.toMatch(/Madrid|belongs to Bob|DERIVED/u);
    expect(retrieveQaEvidence(qaInput)[0]?.sourceSegmentIds).toEqual(["segment_alice_old"]);
  });

  it("uses transition plus related Fact Evidence for recent changes and commitment Evidence only for commitments", async () => {
    const oldEvidence = evidence({ id: "old", text: "Coffee was the earlier preference." });
    const newEvidence = evidence({ id: "new", text: "Tea is the current preference." });
    const factTransitionEvidence = evidence({
      id: "fact_transition",
      text: "Tea explicitly replaces coffee."
    });
    const commitmentEvidence = evidence({
      id: "commitment",
      text: "Alice explicitly promised Bob to send the notes."
    });
    const commitmentTransitionEvidence = evidence({
      id: "commitment_transition",
      text: "The notes promise became active."
    });
    const relationshipEvidence = evidence({
      id: "relationship",
      text: "Alice and Bob explicitly confirmed they are friends."
    });
    const store = new CanonicalTranscriptStore();
    [
      oldEvidence,
      newEvidence,
      factTransitionEvidence,
      commitmentEvidence,
      commitmentTransitionEvidence,
      relationshipEvidence
    ].forEach((item) => store.put(item));

    const previous = fact({
      id: "old_fact",
      evidence: [oldEvidence],
      status: "superseded",
      supersededBy: "new_fact"
    });
    const active = fact({ id: "new_fact", evidence: [newEvidence] });
    const activeCommitment = commitment({
      evidence: [commitmentEvidence],
      transitionEvidence: commitmentTransitionEvidence
    });
    const context = sourceContext({
      activeFacts: [active],
      previousFacts: [previous],
      recentChanges: [{
        kind: "fact",
        entityId: previous.id,
        fromStatus: "active",
        toStatus: "superseded",
        observedAt: "2026-08-05T10:00:00.000Z",
        occurredAt: "2026-08-05T09:00:00.000Z",
        evidence: factTransitionEvidence
      }, {
        kind: "commitment",
        entityId: activeCommitment.id,
        fromStatus: "created",
        toStatus: "active",
        observedAt: "2026-08-03T10:00:00.000Z",
        occurredAt: "2026-08-03T09:00:00.000Z",
        evidence: commitmentTransitionEvidence
      }],
      activeCommitments: [activeCommitment],
      relationshipEvidence: [relationshipEvidence]
    });

    const changes = await buildPersonRelationshipQaContext({
      sourceContext: context,
      question: "最近有什么变化？",
      conversation: [],
      settingsStore: store as never
    });
    expect(changes.eligibleSourceSegmentIds).toEqual(expect.arrayContaining([
      factTransitionEvidence.sourceSegmentId,
      commitmentTransitionEvidence.sourceSegmentId,
      oldEvidence.sourceSegmentId,
      newEvidence.sourceSegmentId
    ]));
    expect(changes.eligibleSourceSegmentIds).not.toEqual(expect.arrayContaining([
      commitmentEvidence.sourceSegmentId,
      relationshipEvidence.sourceSegmentId
    ]));

    const commitments = await buildPersonRelationshipQaContext({
      sourceContext: context,
      question: "Alice 明确承诺 Bob 什么？",
      conversation: [],
      settingsStore: store as never
    });
    expect(commitments.eligibleSourceSegmentIds).toEqual(expect.arrayContaining([
      commitmentEvidence.sourceSegmentId,
      commitmentTransitionEvidence.sourceSegmentId
    ]));
    expect(commitments.eligibleSourceSegmentIds).not.toEqual(expect.arrayContaining([
      oldEvidence.sourceSegmentId,
      newEvidence.sourceSegmentId,
      relationshipEvidence.sourceSegmentId
    ]));
  });

  it("fails closed for unavailable self-role questions, missing sources, account mismatches, and ambiguous source ids", async () => {
    const allowed = evidence({ id: "allowed", text: "Alice promised Bob to send the notes." });
    const crossAccount = evidence({
      id: "cross_account",
      accountId: "account_b",
      text: "Cross-account secret."
    });
    const ambiguousA = evidence({
      id: "ambiguous_a",
      uploadId: "upload_ambiguous_a",
      segmentId: "same_segment",
      text: "First ambiguous source."
    });
    const ambiguousB = evidence({
      id: "ambiguous_b",
      uploadId: "upload_ambiguous_b",
      segmentId: "same_segment",
      text: "Second ambiguous source."
    });
    const deleted = evidence({ id: "deleted", text: "Deleted source secret." });
    const store = new CanonicalTranscriptStore();
    [allowed, crossAccount, ambiguousA, ambiguousB].forEach((item) => store.put(item));
    const context = sourceContext({
      activeFacts: [fact({
        id: "mixed",
        evidence: [allowed, crossAccount, ambiguousA, ambiguousB, deleted]
      })]
    });

    const selfRole = await buildPersonRelationshipQaContext({
      sourceContext: context,
      question: "我答应 Bob 什么？",
      conversation: [],
      settingsStore: store as never
    });
    expect(selfRole).toMatchObject({
      blockedByUnavailableSelfRole: true,
      segments: [],
      eligibleSourceSegmentIds: []
    });

    const regular = await buildPersonRelationshipQaContext({
      sourceContext: context,
      question: "有哪些事实？",
      conversation: [],
      settingsStore: store as never
    });
    expect(regular.eligibleSourceSegmentIds).toEqual([allowed.sourceSegmentId]);
    expect(JSON.stringify(regular)).not.toMatch(/Cross-account|ambiguous|Deleted/u);
  });

  it("builds the canonical relationship input without Memory, derived text, Relationship Signals, or Hybrid", async () => {
    const factEvidence = evidence({ id: "fact", text: "Alice prefers tea." });
    const store = new CanonicalTranscriptStore();
    store.put(factEvidence, 12, 18);
    const qaInput = await buildPersonRelationshipQaInput({
      userId: "account_a",
      personId: "person_a",
      question: "Alice 喜欢什么？",
      conversation: [],
      settingsStore: store as never,
      sourceContext: sourceContext({
        activeFacts: [fact({ id: "tea", evidence: [factEvidence] })]
      })
    });

    expect(qaInput).toMatchObject({
      userId: "account_a",
      uploadId: "person_a",
      relationshipScope: true,
      disableHybridRetrieval: true,
      failClosedOnModelProviderMismatch: true,
      audioInsights: [],
      semanticSegments: [],
      briefItems: [],
      relationshipSignals: []
    });
    expect(qaInput.memoryContext).toBeUndefined();
    expect(qaInput.segments).toEqual([
      expect.objectContaining({
        id: factEvidence.sourceSegmentId,
        uploadId: factEvidence.uploadId,
        startSeconds: 12,
        endSeconds: 18,
        text: factEvidence.quote
      })
    ]);
    expect(JSON.stringify(qaInput)).not.toContain("DERIVED tea");
  });
});

describe("Person-scoped QA Phase 5A trusted snapshot resolver", () => {
  it("uses a confirmed kept snapshot only after the live JsonStore source is missing", async () => {
    const fixture = await installTrustedSnapshotFixture();
    const store = new CanonicalTranscriptStore();
    const context = sourceContext({
      activeFacts: [fact({ id: "snapshot_fact", evidence: [fixture.snapshotEvidence] })]
    });
    const resolved = await buildPersonRelationshipQaContext({
      sourceContext: context,
      question: "旧的蓝色笔记本在哪里？",
      conversation: [],
      settingsStore: store as never,
      trustedEvidenceResolver: fixture.resolver
    });

    expect(resolved).toMatchObject({
      eligibleSourceSegmentIds: ["segment_snapshot"],
      blockedByUnavailableSelfRole: false,
      activeSelfPersonId: "person_self"
    });
    expect(resolved.segments).toEqual([expect.objectContaining({
      id: "segment_snapshot",
      uploadId: "upload_snapshot",
      startSeconds: 10,
      endSeconds: 15,
      speaker: "speaker_alice",
      text: fixture.snapshotEvidence.quote
    })]);
    expect(JSON.stringify(resolved)).not.toContain("DERIVED recap text");

    database.prepare(
      "DELETE FROM dc_retained_uploads WHERE user_id = 'account_a' AND upload_id = 'upload_snapshot'"
    ).run();
    expect(fixture.resolver({
      accountId: "account_a",
      personId: "person_a",
      evidence: [fixture.snapshotEvidence]
    }).segments).toHaveLength(0);
  });

  it("does not use a snapshot when a partially present live source is invalid", async () => {
    const fixture = await installTrustedSnapshotFixture();
    const invalidStore = {
      async read(collection: string) {
        if (collection === "uploads") {
          return {
            id: fixture.snapshotEvidence.uploadId,
            originalName: "snapshot.wav",
            mimeType: "audio/wav",
            sizeBytes: 1024,
            recordingDate: "2026-08-01",
            status: "ready"
          };
        }
        return null;
      }
    };
    const resolved = await buildPersonRelationshipQaContext({
      sourceContext: sourceContext({
        activeFacts: [fact({ id: "snapshot_fact", evidence: [fixture.snapshotEvidence] })]
      }),
      question: "旧的蓝色笔记本在哪里？",
      conversation: [],
      settingsStore: invalidStore as never,
      trustedEvidenceResolver: fixture.resolver
    });
    expect(resolved.segments).toEqual([]);
  });

  it("revalidates non-empty retained Memory provenance before using the DC snapshot", async () => {
    const fixture = await installTrustedSnapshotFixture();
    database.prepare(
      "DELETE FROM dc_retained_uploads WHERE user_id = 'account_a' AND upload_id = 'upload_snapshot'"
    ).run();
    createMemoryRepository(database).replaceUploadMemories({
      userId: "account_a",
      uploadId: fixture.snapshotEvidence.uploadId,
      memories: [{
        id: "memory_snapshot",
        type: "event",
        title: "Old notebook",
        summary: "DERIVED Memory summary",
        importance: 0.8,
        date: "2026-08-10",
        createdAt: "2026-08-10T10:00:00.000Z",
        updatedAt: "2026-08-10T10:00:00.000Z",
        evidence: [{
          id: "memory_evidence_snapshot",
          sourceType: "transcript",
          sourceId: fixture.snapshotEvidence.sourceSegmentId,
          uploadId: fixture.snapshotEvidence.uploadId,
          date: "2026-08-10",
          quote: fixture.snapshotEvidence.quote,
          createdAt: "2026-08-10T10:00:00.000Z"
        }]
      }]
    });
    const captureStore = new CanonicalTranscriptStore();
    captureStore.put(fixture.snapshotEvidence, 10, 15, "speaker_alice");
    await captureRetainedMemoryEvidenceProvenance({
      database,
      store: captureStore as never,
      userId: "account_a",
      uploadId: fixture.snapshotEvidence.uploadId,
      relationshipId: "dc_relationship_1",
      interactionId: "dc_interaction_1",
      now: "2026-08-10T10:00:00.000Z"
    });

    expect(fixture.resolver({
      accountId: "account_a",
      personId: "person_a",
      evidence: [fixture.snapshotEvidence]
    }).segments).toHaveLength(1);
    database.prepare(`
      UPDATE memory_evidence_provenance SET content_digest = ?
      WHERE memory_evidence_id = 'memory_evidence_snapshot'
    `).run("0".repeat(64));
    expect(fixture.resolver({
      accountId: "account_a",
      personId: "person_a",
      evidence: [fixture.snapshotEvidence]
    }).segments).toEqual([]);
  });

  it("uses only the active v8 self binding to unblock self-role retrieval", async () => {
    const fixture = await installTrustedSnapshotFixture({
      quote: "Self explicitly promised Alice to bring the blue notebook.",
      subject: "both"
    });
    const activeCommitment = commitment({
      evidence: [fixture.snapshotEvidence],
      transitionEvidence: fixture.snapshotEvidence
    });
    const resolved = await buildPersonRelationshipQaContext({
      sourceContext: sourceContext({ activeCommitments: [activeCommitment] }),
      question: "我答应 Alice 什么？",
      conversation: [],
      settingsStore: new CanonicalTranscriptStore() as never,
      trustedEvidenceResolver: fixture.resolver
    });
    expect(resolved).toMatchObject({
      blockedByUnavailableSelfRole: false,
      activeSelfPersonId: "person_self",
      eligibleSourceSegmentIds: ["segment_snapshot"]
    });

    database.prepare(`
      UPDATE person_self_bindings
      SET status = 'cleared', person_id = NULL, set_at = NULL,
          cleared_at = '2026-08-11T00:00:00.000Z', version = 2
      WHERE account_id = 'account_a'
    `).run();
    const blocked = await buildPersonRelationshipQaContext({
      sourceContext: sourceContext({ activeCommitments: [activeCommitment] }),
      question: "我答应 Alice 什么？",
      conversation: [],
      settingsStore: new CanonicalTranscriptStore() as never,
      trustedEvidenceResolver: fixture.resolver
    });
    expect(blocked).toMatchObject({
      blockedByUnavailableSelfRole: true,
      activeSelfPersonId: null,
      segments: []
    });
  });

  it.each([
    ["excluded recap", () => dateCompanionDatabase.prepare(
      "UPDATE dc_recap_items SET disposition = 'excluded' WHERE id = 'recap_1'"
    ).run()],
    ["unknown subject", () => dateCompanionDatabase.prepare(
      "UPDATE dc_memory_subject_selections SET subject = 'unknown' WHERE id = 'selection_1'"
    ).run()],
    ["draft interaction", () => dateCompanionDatabase.prepare(
      "UPDATE dc_interactions SET status = 'draft' WHERE id = 'dc_interaction_1'"
    ).run()],
    ["explicit deletion", () => dateCompanionDatabase.prepare(
      "UPDATE dc_interactions SET source_state = 'explicitly_deleted' WHERE id = 'dc_interaction_1'"
    ).run()],
    ["unresolved speaker", () => dateCompanionDatabase.prepare(`
      UPDATE dc_participant_assignments
      SET role = 'unresolved', confirmed_by = NULL, confirmed_at = NULL
      WHERE interaction_id = 'dc_interaction_1'
    `).run()],
    ["stale mapping", () => dateCompanionDatabase.prepare(
      "UPDATE dc_relationship_person_mappings SET version = 2 WHERE id = 'mapping_1'"
    ).run()],
    ["stale self binding", () => database.prepare(`
      UPDATE person_self_bindings SET person_id = 'person_a', version = 2
      WHERE account_id = 'account_a'
    `).run()],
    ["purged retention", () => database.prepare(
      "UPDATE dc_retained_uploads SET status = 'purged' WHERE user_id = 'account_a'"
    ).run()],
    ["retained provenance digest mismatch", () => database.prepare(
      "UPDATE dc_retained_uploads SET provenance_digest = ? WHERE user_id = 'account_a'"
    ).run("0".repeat(64))],
    ["missing bridge receipt", () => database.prepare(
      "DELETE FROM dc_memory_bridge_receipts WHERE account_id = 'account_a'"
    ).run()],
    ["invalid snapshot digest", () => dateCompanionDatabase.prepare(
      "UPDATE dc_evidence_snapshots SET content_digest = ? WHERE id = 'snapshot_1'"
    ).run("0".repeat(64))]
  ])("excludes %s from the snapshot-only allowlist", async (_caseName, mutate) => {
    const fixture = await installTrustedSnapshotFixture();
    mutate();
    const resolved = fixture.resolver({
      accountId: "account_a",
      personId: "person_a",
      evidence: [fixture.snapshotEvidence]
    });
    expect(resolved.segments).toEqual([]);
  });

  it("fails closed for duplicate conflicting snapshots and full-key cross-person/account probes", async () => {
    const fixture = await installTrustedSnapshotFixture();
    const now = "2026-08-10T10:00:00.000Z";
    const conflictingQuote = "Conflicting snapshot content.";
    const conflictingDigest = dateCompanionEvidenceDigest({
      userId: "account_a",
      uploadId: fixture.snapshotEvidence.uploadId,
      sourceSegmentId: fixture.snapshotEvidence.sourceSegmentId,
      startSeconds: 10,
      endSeconds: 15,
      speakerId: "speaker_alice",
      quote: conflictingQuote
    });
    dateCompanionDatabase.prepare(`
      INSERT INTO dc_recap_items (
        id, user_id, interaction_id, kind, proposed_text, disposition,
        version, sort_order, created_at, updated_at
      ) VALUES ('recap_conflict', 'account_a', 'dc_interaction_1', 'mentioned',
        'conflict', 'kept', 1, 1, ?, ?)
    `).run(now, now);
    dateCompanionDatabase.prepare(`
      INSERT INTO dc_evidence_snapshots (
        id, user_id, recap_item_id, upload_id, source_segment_id,
        start_seconds, end_seconds, speaker_id, quote, created_at,
        provenance_version, source_kind, content_digest
      ) VALUES ('snapshot_conflict', 'account_a', 'recap_conflict', ?, ?,
        10, 15, 'speaker_alice', ?, ?, 1, 'date_companion_recap', ?)
    `).run(
      fixture.snapshotEvidence.uploadId,
      fixture.snapshotEvidence.sourceSegmentId,
      conflictingQuote,
      now,
      conflictingDigest
    );

    const conflict = fixture.resolver({
      accountId: "account_a",
      personId: "person_a",
      evidence: [fixture.snapshotEvidence]
    });
    expect(conflict.segments).toEqual([]);
    expect(conflict.conflictingEvidenceKeys).toHaveLength(1);
    expect(fixture.resolver({
      accountId: "account_b",
      personId: "person_a",
      evidence: [fixture.snapshotEvidence]
    }).segments).toEqual([]);
    expect(fixture.resolver({
      accountId: "account_a",
      personId: "person_other",
      evidence: [fixture.snapshotEvidence]
    }).segments).toEqual([]);
  });

  it("fails closed without a Provider call when live and trusted snapshot metadata disagree", async () => {
    const fixture = await installTrustedSnapshotFixture();
    const store = new CanonicalTranscriptStore();
    store.put(fixture.snapshotEvidence, 11, 16);
    const qaInput = await buildPersonRelationshipQaInput({
      userId: "account_a",
      personId: "person_a",
      question: "旧的蓝色笔记本在哪里？",
      conversation: [],
      settingsStore: store as never,
      sourceContext: sourceContext({
        activeFacts: [fact({ id: "snapshot_fact", evidence: [fixture.snapshotEvidence] })]
      }),
      trustedEvidenceResolver: fixture.resolver
    });

    expect(qaInput.segments).toEqual([]);
    const answer = await answerQuestionWithAI(qaInput);
    expect(answer).toMatchObject({
      answer: SAFE_UNCERTAINTY_ANSWER,
      citedSegmentIds: [],
      citations: []
    });
    expect(chatCreateMock).not.toHaveBeenCalled();
  });
});

describe("Person-scoped QA canonical fallback contract", () => {
  async function canonicalInput(withEvidence: boolean) {
    const factEvidence = evidence({ id: "canonical", text: "Alice prefers tea." });
    const store = new CanonicalTranscriptStore();
    if (withEvidence) store.put(factEvidence);
    return buildPersonRelationshipQaInput({
      userId: "account_a",
      personId: "person_a",
      question: "Alice 喜欢什么？",
      conversation: [],
      settingsStore: store as never,
      sourceContext: sourceContext({
        known: withEvidence,
        activeFacts: withEvidence ? [fact({ id: "canonical", evidence: [factEvidence] })] : []
      })
    });
  }

  it("returns short uncertainty without a Provider call when no Evidence is available", async () => {
    const answer = await answerQuestionWithAI(await canonicalInput(false));
    expect(answer).toMatchObject({
      answer: SAFE_UNCERTAINTY_ANSWER,
      citations: [],
      citedSegmentIds: []
    });
    expect(answer.answer.length).toBeLessThan(40);
    expect(chatCreateMock).not.toHaveBeenCalled();
  });

  it("keeps a bounded partial-evidence answer with a valid canonical citation", async () => {
    chatCreateMock.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            mode: "memory_answer",
            answer: "现有证据只确认 Alice 喜欢茶。[E1]",
            citationIds: ["E1"]
          })
        }
      }]
    });
    const answer = await answerQuestionWithAI(await canonicalInput(true));
    expect(answer.answer).toContain("Alice 喜欢茶");
    expect(answer.answer.length).toBeLessThanOrEqual(1200);
    expect(answer.citedSegmentIds).toEqual(["segment_canonical"]);
    expect(answer.citations?.map((citation) => citation.id)).toEqual(["E1"]);
  });

  it.each([
    ["invalid citation", () => chatCreateMock.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        mode: "memory_answer",
        answer: "无效引用回答。[E99]",
        citationIds: ["E99"]
      }) } }]
    })],
    ["Provider error", () => chatCreateMock.mockRejectedValue(new Error("deterministic provider failure"))],
    ["overlong answer", () => chatCreateMock.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        mode: "memory_answer",
        answer: `${"过长".repeat(700)} [E1]`,
        citationIds: ["E1"]
      }) } }]
    })]
  ])("fails closed on %s", async (_caseName, arrange) => {
    arrange();
    const answer = await answerQuestionWithAI(await canonicalInput(true));
    expect(answer).toMatchObject({
      answer: SAFE_UNCERTAINTY_ANSWER,
      citations: [],
      citedSegmentIds: []
    });
    expect(answer.answer.length).toBeLessThan(40);
  });

  it("rejects a cited Provider answer that guesses an unavailable self/Ta role", async () => {
    chatCreateMock.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            mode: "memory_answer",
            answer: "你答应了之后改成喝茶。[E1]",
            citationIds: ["E1"]
          })
        }
      }]
    });
    const input = await canonicalInput(true);
    const answer = await answerPersonRelationshipQuestion(
      input,
      input.segments.map((segment) => segment.id)
    );
    expect(answer).toMatchObject({
      answer: SAFE_UNCERTAINTY_ANSWER,
      citations: [],
      citedSegmentIds: []
    });
  });
});
