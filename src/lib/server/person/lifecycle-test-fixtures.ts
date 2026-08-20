import type Database from "better-sqlite3";
import type { AudioUpload, TranscriptSegment } from "@/lib/domain/types";
import type { JsonStore } from "@/lib/server/storage/json-store";
import { validatePersonTranscriptEvidence } from "./evidence";
import { createPersonRelationshipRepository } from "./relationship-repository";
import { createPersonRepository } from "./repository";

export class LifecycleTranscriptStore implements Pick<JsonStore, "read"> {
  private readonly values = new Map<string, unknown>();

  async read<T>(collection: string, id: string) {
    return (this.values.get(`${collection}/${id}`) ?? null) as T | null;
  }

  put(input: {
    uploadId: string;
    segmentId: string;
    identityId: string;
    text: string;
    recordingDate?: string;
  }) {
    const upload: AudioUpload = {
      id: input.uploadId,
      originalName: `${input.uploadId}.wav`,
      mimeType: "audio/wav",
      sizeBytes: 1024,
      recordingDate: input.recordingDate ?? "2026-08-10",
      status: "ready"
    };
    const segment: TranscriptSegment = {
      id: input.segmentId,
      uploadId: input.uploadId,
      startSeconds: 0,
      endSeconds: 5,
      speaker: input.identityId,
      identity: {
        globalSpeakerId: input.identityId,
        displayName: input.identityId,
        identityType: "known_contact",
        confidence: 0.98,
        source: "voiceprint"
      },
      text: input.text,
      confidence: 0.98,
      sceneLabels: ["private_content"],
      valueLabels: ["notable_quote"]
    };
    this.values.set(`uploads/${input.uploadId}`, upload);
    this.values.set(`segments/${input.uploadId}`, [segment]);
    return segment;
  }
}

export async function validatedLifecycleEvidence(input: {
  store: LifecycleTranscriptStore;
  accountId?: string;
  uploadId: string;
  segmentId: string;
  identityId: string;
  text: string;
}) {
  const accountId = input.accountId ?? "account_user";
  input.store.put(input);
  return validatePersonTranscriptEvidence({
    store: input.store,
    authenticatedAccountId: accountId,
    accountId,
    uploadId: input.uploadId,
    sourceSegmentId: input.segmentId,
    quote: input.text
  });
}

export async function createConfirmedLifecyclePerson(input: {
  database: Database.Database;
  store: LifecycleTranscriptStore;
  accountId?: string;
  displayName: string;
  identityId: string;
  uploadId: string;
  segmentId: string;
}) {
  const accountId = input.accountId ?? "account_user";
  const evidence = await validatedLifecycleEvidence({
    store: input.store,
    accountId,
    uploadId: input.uploadId,
    segmentId: input.segmentId,
    identityId: input.identityId,
    text: `I am ${input.displayName}.`
  });
  const repository = createPersonRepository(input.database);
  const candidate = repository.createCandidate({
    accountId,
    displayName: input.displayName,
    source: "transcript_candidate",
    evidence
  });
  repository.confirmPerson({ accountId, personId: candidate.id, evidence });
  const link = repository.createIdentityLinkCandidate({
    accountId,
    personId: candidate.id,
    identityId: input.identityId,
    source: "manual_confirmation",
    evidence
  });
  repository.confirmIdentityLink({ accountId, linkId: link.id, evidence });
  repository.recordConfirmedSubject({
    accountId,
    personId: candidate.id,
    identityId: input.identityId,
    reason: "explicit lifecycle fixture",
    evidence
  });
  return {
    person: repository.getConfirmedPerson(accountId, candidate.id)!,
    identityId: input.identityId,
    evidence
  };
}

export async function exactSubjectEvidence(input: {
  database: Database.Database;
  store: LifecycleTranscriptStore;
  accountId?: string;
  personId: string;
  identityId: string;
  uploadId: string;
  segmentId: string;
  text: string;
}) {
  const accountId = input.accountId ?? "account_user";
  const evidence = await validatedLifecycleEvidence({ ...input, store: input.store, accountId });
  createPersonRepository(input.database).recordConfirmedSubject({
    accountId,
    personId: input.personId,
    identityId: input.identityId,
    reason: "explicit lifecycle evidence Subject",
    evidence
  });
  return evidence;
}

export async function exactSharedSubjectEvidence(input: {
  database: Database.Database;
  store: LifecycleTranscriptStore;
  accountId?: string;
  primaryPersonId: string;
  primaryIdentityId: string;
  secondaryPersonId: string;
  uploadId: string;
  segmentId: string;
  text: string;
}) {
  const accountId = input.accountId ?? "account_user";
  const evidence = await exactSubjectEvidence({
    database: input.database,
    store: input.store,
    accountId,
    personId: input.primaryPersonId,
    identityId: input.primaryIdentityId,
    uploadId: input.uploadId,
    segmentId: input.segmentId,
    text: input.text
  });
  const now = "2026-08-10T00:00:00.000Z";
  input.database.prepare(`
    INSERT INTO person_subject_observations (
      id, account_id, person_id, evidence_id, status, source, reason,
      confirmed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'confirmed', 'manual_review', ?, ?, ?, ?)
  `).run(
    `shared_subject_${input.segmentId}_${input.secondaryPersonId}`,
    accountId,
    input.secondaryPersonId,
    evidence.id,
    "explicit shared lifecycle fixture",
    now,
    now,
    now
  );
  return evidence;
}

export async function confirmedLifecycleRelationship(input: {
  database: Database.Database;
  store: LifecycleTranscriptStore;
  accountId?: string;
  personAId: string;
  personBId: string;
  uploadId: string;
  segmentId: string;
  now?: string;
}) {
  const accountId = input.accountId ?? "account_user";
  const evidence = await validatedLifecycleEvidence({
    store: input.store,
    accountId,
    uploadId: input.uploadId,
    segmentId: input.segmentId,
    identityId: "relationship_reviewer",
    text: "The relationship was explicitly confirmed."
  });
  const repository = createPersonRelationshipRepository(input.database);
  const candidate = repository.createCandidate({
    accountId,
    personAId: input.personAId,
    personBId: input.personBId,
    type: "friend",
    evidence,
    now: input.now
  });
  return repository.confirmRelationship({
    accountId,
    relationshipId: candidate.id,
    now: input.now
  });
}
