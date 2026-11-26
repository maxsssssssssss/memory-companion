// Bundled against the archived pre-PR implementation, including its actual Worker.
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { openDateCompanionDatabase } = require("@/lib/server/date-companion/db");
const { openMemoryDatabase } = require("@/lib/server/memory/db");
const { validateCanonicalEvidenceReference } = require("@/lib/server/person/admission-evidence");
const { createPersonAdmissionRepository } = require("@/lib/server/person/admission-repository");
const { DateCompanionRepository } = require("@/lib/server/date-companion/repository");
const { createDateCompanionMemoryBridgeRepository } = require("@/lib/server/date-companion/memory-bridge-repository");
const { getOrCreateDateCompanionSubjectSuggestionBatch } = require("@/lib/server/date-companion/subject-suggestions");
const { captureRetainedMemoryEvidenceProvenance } = require("@/lib/server/memory/retention-provenance");
const { processNextDateCompanionMemoryBridge } = require("@/lib/server/date-companion/memory-bridge-consumer");
const { inspectDateCompanionMemoryBridgePreflight } = require("@/lib/server/date-companion/memory-bridge-preflight");
const { purgeDateCompanionRetainedMemory } = require("@/lib/server/date-companion/memory-bridge-purge");

async function main([directory, scenario]) {
  if (scenario === "inspect") {
    console.log(JSON.stringify(inspectDateCompanionMemoryBridgePreflight({ dataDirectory: directory })));
    return;
  }
  const database = openDateCompanionDatabase({ filePath: join(directory, "date-companion.sqlite") });
  const memory = openMemoryDatabase({ filePath: join(directory, "memory.sqlite") });
  const accountId = "test_account";
  const uploadId = "test_upload";
  const sourceSegmentId = "test_segment";
  const quote = "我最近想去看展";
  const recordingDate = "2026-11-26";
  const now = "2026-11-26T02:00:00.000Z";
  const store = { read: async (key) => ({
    uploads: { id: uploadId, originalName: "date.wav", mimeType: "audio/wav", sizeBytes: 1024, recordingDate, status: "ready" },
    segments: [{ id: sourceSegmentId, uploadId, startSeconds: 0, endSeconds: 4, speaker: "speaker_ta",
      text: quote, confidence: 0.99, sceneLabels: [], valueLabels: [] }]
  })[key] ?? null };
  try {
    if (scenario === "fail-old-purge") {
      const { id: relationshipId } = database.prepare("SELECT id FROM dc_relationships WHERE user_id=?").get(accountId);
      memory.exec(`CREATE TEMP TRIGGER simulate_write_failure BEFORE INSERT ON memory_upload_tombstones
        BEGIN SELECT RAISE(ABORT, 'synthetic_write_failure'); END`);
      const result = purgeDateCompanionRetainedMemory({ dateCompanionDatabase: database, memoryDatabase: memory,
        userId: accountId, relationshipId });
      assert.equal(result.status, "retryable_failed");
      console.log(JSON.stringify(result));
      return;
    }
    for (const id of ["person_self", "person_ta", "person_friend"]) {
      memory.prepare(`INSERT INTO person_entities(id,account_id,display_name,source,status,created_at,updated_at)
        VALUES (?,?,?,'manual_confirmation','confirmed',?,?)`).run(id, accountId, id, now, now);
    }
    memory.prepare(`INSERT INTO person_self_bindings(account_id,person_id,status,version,set_at,created_at,updated_at)
      VALUES (?,?,'active',1,?,?,?)`).run(accountId, "person_self", now, now, now);
    let independentRelationshipId = null;
    if (scenario === "shared" || scenario === "same-edge") {
      const sameEdge = scenario === "same-edge";
      const evidence = await validateCanonicalEvidenceReference({ store, accountId, uploadId, sourceSegmentId });
      const admission = createPersonAdmissionRepository(memory);
      const candidate = admission.createRelationshipCandidate({ accountId, personAId: "person_self",
        personBId: sameEdge ? "person_ta" : "person_friend", type: sameEdge ? "dating" : "friend",
        expectedVersion: 0, evidence, now });
      const confirmed = admission.transitionRelationship({ accountId, relationshipId: candidate.id,
        action: "confirm", expectedVersion: candidate.version, now });
      assert.equal(confirmed.status, "confirmed");
      assert.equal(confirmed.evidence.length, 1);
      independentRelationshipId = confirmed.id;
    }

    const repository = new DateCompanionRepository(database);
    const { relationship } = repository.createOrGetRelationship(accountId, "Ta");
    const relationshipId = relationship.id;
    const { interactionId } = repository.importInteraction({ userId: accountId, relationshipId, sourceUploadId: uploadId,
      originalName: "date.wav", recordingDate, participants: [{ speakerId: "speaker_self" }, { speakerId: "speaker_ta" }],
      recapCandidates: [{ kind: "mentioned", proposedText: "Ta 想去看展", sortOrder: 0,
        evidence: [{ uploadId, sourceSegmentId, startSeconds: 0, endSeconds: 4, speakerId: "speaker_ta", quote }] }] });
    const bridge = createDateCompanionMemoryBridgeRepository(database);
    const mapping = bridge.putPersonMapping({ userId: accountId, relationshipId, selfPersonId: "person_self",
      companionPersonId: "person_ta", relationshipType: "dating", expectedVersion: 0 });
    const item = repository.getRelationshipView(accountId, relationshipId).interactions[0].recapItems[0];
    const batch = await getOrCreateDateCompanionSubjectSuggestionBatch({ database, userId: accountId, interactionId,
      provider: { model: "Qwen/Qwen3.6-27B", suggest: async sources => sources.map(source => ({
        canonicalSourceKey: source.canonicalSourceKey, proposedSubject: "companion",
        confidence: 1, reasonCode: "explicit_companion_reference"
      })) } });
    repository.updateRecap({ userId: accountId, interactionId, version: 0,
      assignments: [{ speakerId: "speaker_self", role: "self" }, { speakerId: "speaker_ta", role: "companion" }],
      mutations: [{ id: item.id, version: item.version, disposition: "kept" }],
      memoryAdmission: { mappingVersion: mapping.version,
        subjectSuggestionConfirmation: { batchId: batch.batchId, evidenceDigest: batch.evidenceDigest,
          proposalDigest: batch.proposalDigest, confirmationFingerprint: batch.confirmationFingerprint,
          confirmedVisibleSuggestions: true },
        selections: [{ evidenceSnapshotId: item.evidence[0].id, subject: "companion" }] }, finalize: true });
    await captureRetainedMemoryEvidenceProvenance({ database: memory, store, userId: accountId, uploadId,
      relationshipId, interactionId, now });
    assert.equal(repository.markUploadSourceState(accountId, uploadId, "server_cleaned"), true);
    const worker = await processNextDateCompanionMemoryBridge({ dateCompanionDatabase: database, memoryDatabase: memory });
    assert.equal(worker?.completed, true);
    console.log(JSON.stringify({ scenario, relationshipId, interactionId, independentRelationshipId, worker }));
  } finally {
    database.close();
    memory.close();
  }
}
main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
