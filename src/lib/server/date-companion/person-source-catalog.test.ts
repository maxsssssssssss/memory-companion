// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createMemoryRepository } from "@/lib/server/memory/repository";

import { openDateCompanionDatabase } from "./db";
import { processDateCompanionMemoryBridgeInteraction } from "./memory-bridge-consumer";
import { dateCompanionMemoryProjectionIdempotencyKey } from "./memory-bridge-digest";
import { createDateCompanionMemoryBridgeRepository } from "./memory-bridge-repository";
import { resolveDateCompanionPersonSourceCatalog } from "./person-source-catalog";
import { DateCompanionRepository } from "./repository";
import { getOrCreateDateCompanionSubjectSuggestionBatch } from "./subject-suggestions";
import { openDateCompanionPersonQaScope } from "./person-qa-scope";
import { getDateCompanionWithdrawalPreview, purgeDateCompanionRetainedMemory } from "./memory-bridge-purge";
import { verifiedPriorSources } from "./qa-prior-sources";
import { createRelationshipContextBuilder } from "@/lib/server/person/relationship-context";
import { answerPersonRelationshipQuestionStream, buildPersonRelationshipQaInput } from "@/lib/server/person/person-relationship-qa";
import { resolveTrustedPersonQaEvidence } from "@/lib/server/person/person-relationship-qa-evidence-resolver";
import { JsonStore } from "@/lib/server/storage/json-store";
import { createTextQaBrowserStream } from "@/lib/server/retrieval/text-qa-stream";

const NOW = "2026-08-11T00:00:00.000Z";

type SourceInput = {
  segmentId: string;
  quote: string;
  subject: "self" | "companion" | "both" | "unknown";
  startSeconds?: number;
  disposition?: "kept" | "excluded";
  speakerId?: string;
};

describe("Date Companion relationship Person source catalog", () => {
  let dateCompanionDatabase: Database.Database;
  let memoryDatabase: Database.Database;
  let repository: DateCompanionRepository;
  let relationshipId: string;
  let mappingVersion: number;

  beforeEach(() => {
    dateCompanionDatabase = openDateCompanionDatabase({ filePath: ":memory:" });
    memoryDatabase = openMemoryDatabase({ filePath: ":memory:" });
    repository = new DateCompanionRepository(dateCompanionDatabase);
    relationshipId = repository.createOrGetRelationship("user_a", "Ta").relationship.id;
    const insertPerson = memoryDatabase.prepare(`
      INSERT INTO person_entities (
        id, account_id, display_name, source, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'manual_confirmation', 'confirmed', ?, ?)
    `);
    insertPerson.run("person_self", "user_a", "我", NOW, NOW);
    insertPerson.run("person_ta", "user_a", "Alice", NOW, NOW);
    insertPerson.run("person_same_name", "user_a", "Alice", NOW, NOW);
    insertPerson.run("person_other", "user_a", "Bob", NOW, NOW);
    insertPerson.run("person_ta_b", "user_b", "Alice", NOW, NOW);
    memoryDatabase.prepare(`
      INSERT INTO person_self_bindings (
        account_id, person_id, status, version, set_at, cleared_at, created_at, updated_at
      ) VALUES ('user_a', 'person_self', 'active', 1, ?, NULL, ?, ?)
    `).run(NOW, NOW, NOW);
    const bridge = createDateCompanionMemoryBridgeRepository(dateCompanionDatabase);
    bridge.putRetentionSetting({ userId: "user_a", enabled: true, expectedVersion: 0 });
    mappingVersion = bridge.putPersonMapping({
      userId: "user_a",
      relationshipId,
      selfPersonId: "person_self",
      companionPersonId: "person_ta",
      relationshipType: "dating",
      expectedVersion: 0
    }).version;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    dateCompanionDatabase.close();
    memoryDatabase.close();
  });

  async function completeInteraction(input: {
    uploadId: string;
    recordingDate: string;
    sources: SourceInput[];
    beforeConsume?: (interactionId: string) => void;
  }) {
    const speakers = [...new Set(input.sources.map((source) => source.speakerId ?? "speaker_1"))];
    const imported = repository.importInteraction({
      userId: "user_a",
      relationshipId,
      sourceUploadId: input.uploadId,
      recordingDate: input.recordingDate,
      originalName: `${input.uploadId}.wav`,
      participants: speakers.map((speakerId) => ({ speakerId })),
      recapCandidates: input.sources.map((source, index) => {
        const startSeconds = source.startSeconds ?? index * 5;
        return {
          kind: "mentioned" as const,
          proposedText: `source-${index}-${source.quote}`,
          sortOrder: index,
          evidence: [{
            uploadId: input.uploadId,
            sourceSegmentId: source.segmentId,
            startSeconds,
            endSeconds: startSeconds + 4,
            speakerId: source.speakerId ?? "speaker_1",
            quote: source.quote
          }]
        };
      })
    });
    const interaction = repository.getRelationshipView("user_a", relationshipId)
      .interactions.find((candidate) => candidate.id === imported.interactionId);
    if (!interaction) throw new Error("fixture interaction missing");
    const suggestionBatch = await getOrCreateDateCompanionSubjectSuggestionBatch({
      database: dateCompanionDatabase,
      userId: "user_a",
      interactionId: imported.interactionId,
      draftPreview: {
        version: interaction.version,
        itemIds: interaction.recapItems.filter((_, i) => input.sources[i]?.disposition !== "excluded").map(item => item.id),
        assignments: speakers.map(speakerId => ({ speakerId, role: "companion" }))
      },
      provider: {
        model: "Qwen/Qwen3.6-27B",
        suggest: async (sources) => {
          const requestedByQuote = new Map(
            input.sources.map((source) => [source.quote, source.subject])
          );
          return sources.map((source) => {
            const proposedSubject = requestedByQuote.get(source.quote) ?? "unknown";
            const reasonCode = proposedSubject === "self"
              ? "explicit_self_reference" as const
              : proposedSubject === "companion"
                ? "explicit_companion_reference" as const
                : proposedSubject === "both"
                  ? "mutual_relationship_context" as const
                  : "insufficient_context" as const;
            return {
              canonicalSourceKey: source.canonicalSourceKey,
              proposedSubject,
              confidence: 1,
              reasonCode
            };
          });
        }
      }
    });
    const proposedSubjectBySnapshot = new Map(
      suggestionBatch.suggestions.flatMap((suggestion) =>
        suggestion.evidenceSnapshotIds.map((evidenceSnapshotId) => [
          evidenceSnapshotId,
          suggestion.proposedSubject
        ] as const)
      )
    );
    repository.updateRecap({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: speakers.map((speakerId) => ({ speakerId, role: "companion" as const })),
      mutations: interaction.recapItems.map((item, index) => ({
        id: item.id,
        version: item.version,
        disposition: input.sources[index]?.disposition ?? "kept"
      })),
      memoryAdmission: {
        mappingVersion,
        subjectSuggestionConfirmation: {
          batchId: suggestionBatch.batchId,
          evidenceDigest: suggestionBatch.evidenceDigest,
          proposalDigest: suggestionBatch.proposalDigest,
          confirmationFingerprint: suggestionBatch.confirmationFingerprint,
          confirmedVisibleSuggestions: true
        },
        selections: interaction.recapItems.flatMap((item, index) => {
          const source = input.sources[index];
          const evidenceSnapshotId = item.evidence[0]?.id;
          return source?.disposition === "excluded" || !evidenceSnapshotId
            ? []
            : [{
                evidenceSnapshotId,
                subject: proposedSubjectBySnapshot.get(evidenceSnapshotId) ?? "unknown"
              }];
        })
      },
      finalize: true
    });
    repository.markUploadSourceState("user_a", input.uploadId, "server_cleaned");
    input.beforeConsume?.(imported.interactionId);
    await processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase,
      memoryDatabase,
      userId: "user_a",
      interactionId: imported.interactionId
    });
    return {
      interactionId: imported.interactionId,
      snapshots: interaction.recapItems.map((item) => item.evidence[0]?.id as string)
    };
  }

  function resolve(accountId = "user_a") {
    return resolveDateCompanionPersonSourceCatalog({
      dateCompanionDatabase,
      memoryDatabase,
      accountId,
      relationshipId
    });
  }

  it("distinguishes a verified mapping awaiting its first projection from a failed lookup, admitting neither", () => {
    expect(resolve()).toMatchObject({status: "unlinked", mappingVersion, sources: []});
    const identity = {accountId: "user_a", relationshipId, personId: "person_ta", mappingVersion};
    expect(() => openDateCompanionPersonQaScope(identity, () => resolve())).toThrow();
    memoryDatabase.exec("ALTER TABLE dc_person_relationship_links RENAME TO temporarily_unreadable");
    expect(resolve()).toMatchObject({status: "unavailable", sources: []});
  });

  it("keeps a saved recap pending until the consumer has admitted its source", async () => {
    const review = () => createDateCompanionMemoryBridgeRepository(dateCompanionDatabase).getMemoryReview("user_a", relationshipId);
    expect(review().interactions).toEqual([]);
    await completeInteraction({
      uploadId: "upload_first_recap", recordingDate: "2026-08-11",
      sources: [{segmentId: "seg_first", quote: "我喜欢这里的树影。", subject: "companion"}],
      beforeConsume: interactionId => {
        expect(review().interactions).toMatchObject([{interactionId, status: "pending"}]);
        expect(resolve()).toMatchObject({status: "unlinked", sources: []});
      }
    });
    expect(review().interactions).toMatchObject([{status: "completed"}]);
    expect(resolve()).toMatchObject({status: "ready", sources: [{sourceSegmentId: "seg_first"}]});
  });

  it("keeps a second relationship for the same person out of the real provider prompt, browser sentences and final", async () => {
    const otherQuote = "另一段关系的屏风暗号是灰鲸。";
    const currentQuote = "画册封面采用蓝色水彩。";
    await completeInteraction({ uploadId: "old_upload", recordingDate: "2026-08-01",
      sources: [{ segmentId: "old_other", quote: otherQuote, subject: "companion" }] });
    const oldRelationshipId = relationshipId;
    // Production allows only one active relationship per account. Retain the
    // previous record and its projection while explicitly choosing the new one.
    dateCompanionDatabase.prepare("UPDATE dc_relationships SET status = 'archived' WHERE id = ?").run(oldRelationshipId);
    relationshipId = repository.createOrGetRelationship("user_a", "同一位 Ta").relationship.id;
    mappingVersion = createDateCompanionMemoryBridgeRepository(dateCompanionDatabase).putPersonMapping({
      userId: "user_a", relationshipId, selfPersonId: "person_self", companionPersonId: "person_ta",
      relationshipType: "dating", expectedVersion: 0
    }).version;
    await completeInteraction({ uploadId: "current_upload", recordingDate: "2026-08-12",
      sources: [{ segmentId: "current_seg", quote: currentQuote, subject: "companion" }] });
    const read = (ids: { accountId: string; relationshipId: string }) =>
      resolveDateCompanionPersonSourceCatalog({ ...ids, dateCompanionDatabase, memoryDatabase });
    const identity = { accountId: "user_a", relationshipId, personId: "person_ta", mappingVersion };
    const scope = openDateCompanionPersonQaScope(identity, read);
    for (const changed of [{ accountId: "user_b" }, { personId: "person_other" },
      { relationshipId: oldRelationshipId }, { mappingVersion: mappingVersion + 1 }]) {
      expect(() => openDateCompanionPersonQaScope({ ...identity, ...changed }, read)).toThrow("qa_scope_changed");
    }
    const sourceContext = createRelationshipContextBuilder(memoryDatabase).buildRelationshipContext(identity);
    const qa = await buildPersonRelationshipQaInput({
      userId: identity.accountId, personId: identity.personId, sourceContext,
      // A missing local upload makes the resolver use its authorized, digest-checked snapshot.
      settingsStore: new JsonStore(join(tmpdir(), randomUUID())), question: "画册封面是什么颜色？",
      conversation: [], admitsEvidence: scope.includes,
      trustedEvidenceResolver: input => resolveTrustedPersonQaEvidence({ ...input, dateCompanionDatabase, memoryDatabase })
    });
    expect(qa.segments.map(s => s.id)).toEqual(["current_seg"]);
    qa.requireExplicitRetry = true;
    qa.disableHybridRetrieval = true;
    qa.assertSourceScope = () => scope.assertCurrent(["current_seg"]);
    qa.conversation = verifiedPriorSources(qa.segments, [
      { sourceSegmentId: "old_other", excerpt: otherQuote },
      { sourceSegmentId: "current_seg", excerpt: "旧内容已变" },
      { sourceSegmentId: "current_seg", excerpt: currentQuote }
    ], scope.matchesRevision);
    expect(qa.conversation).toEqual([{ role: "assistant", content: "上轮使用的已核实依据：" + currentQuote }]);
    vi.stubEnv("LLM_PROVIDER", "qwen-vllm");
    vi.stubEnv("VLLM_BASE_URL", "http://127.0.0.1:1/v1");
    let prompt = "";
    // Intercept exactly at the OpenAI-compatible HTTP transport. All prompt
    // construction, retrieval, JSON parsing and browser projection remain real.
    const provider = vi.fn(async (_url: unknown, init: RequestInit) => {
      prompt = JSON.parse(String(init.body)).messages.at(-1).content;
      const frame = { choices: [{ delta: { content: JSON.stringify({
        mode: "memory_answer", answer: currentQuote + "[E1]", citationIds: ["E1"]
      }) }, finish_reason: "stop" }] };
      return new Response("data: " + JSON.stringify(frame) + "\n\ndata: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", provider);
    const events = (await new Response(createTextQaBrowserStream({ input: qa, dependencies: {
      answerQuestionStream: input => answerPersonRelationshipQuestionStream(input, ["current_seg"])
    } })).text()).trim().split("\n").map(line => JSON.parse(line));
    expect(provider, JSON.stringify(events)).toHaveBeenCalledTimes(1);
    expect(prompt).toContain(currentQuote);
    expect(prompt).not.toContain(otherQuote);
    expect(prompt).not.toContain("旧内容已变");
    expect(events.map(event => event.type)).toEqual(["meta", "sentence", "final", "complete"]);
    expect(events[1].citedSegmentIds).toEqual(["current_seg"]);
    expect(events[2].answer.citedSegmentIds).toEqual(["current_seg"]);
    expect(JSON.stringify(events)).not.toContain(otherQuote);

    dateCompanionDatabase.prepare("UPDATE dc_evidence_snapshots SET quote = '同 ID 的新文本' WHERE source_segment_id = ?").run("current_seg");
    expect(qa.assertSourceScope).toThrow("qa_scope_changed");
    expect(read(identity).sources).toHaveLength(0);
  });

  it.each(["before dispatch", "before first sentence", "before final"] as const)(
    "stops a real relationship QA scope withdrawn %s", async phase => {
      const quote = "画册封面采用蓝色水彩。";
      const uploadId = "isolated_book", segmentId = "bookmark";
      await completeInteraction({uploadId, recordingDate: "2026-11-24",
        sources: [{segmentId, quote, subject: "both"}]});
      const identity = {accountId: "user_a", relationshipId, personId: "person_ta", mappingVersion};
      const scope = openDateCompanionPersonQaScope(identity, () => resolve());
      const qa = await buildPersonRelationshipQaInput({
        userId: identity.accountId, personId: identity.personId, question: "画册封面是什么颜色？", conversation: [],
        admitsEvidence: scope.includes, settingsStore: new JsonStore(join(tmpdir(), randomUUID())),
        sourceContext: createRelationshipContextBuilder(memoryDatabase).buildRelationshipContext(identity),
        trustedEvidenceResolver: input => resolveTrustedPersonQaEvidence({...input, relationshipId, dateCompanionDatabase, memoryDatabase})
      });
      expect(qa.segments.map(s => s.id)).toEqual([segmentId]);
      qa.requireExplicitRetry = true;
      qa.disableHybridRetrieval = true;
      qa.assertSourceScope = () => scope.assertCurrent([segmentId]);
      const withdraw = () => {
        const input = {dateCompanionDatabase, memoryDatabase, userId: identity.accountId, relationshipId};
        const {preview} = getDateCompanionWithdrawalPreview(input);
        expect(purgeDateCompanionRetainedMemory({...input, previewVersion: preview.version})).toMatchObject({usageStopped: true, completedCount: 1});
      };
      vi.stubEnv("LLM_PROVIDER", "qwen-vllm");
      vi.stubEnv("VLLM_BASE_URL", "http://127.0.0.1:1/v1");
      const provider = vi.fn(async () => {
        if (phase === "before first sentence") withdraw();
        const chunk = {choices: [{delta: {content: JSON.stringify({mode: "memory_answer", answer: quote + "[E1]", citationIds: ["E1"]})}, finish_reason: "stop"}]};
        return new Response("data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n", {headers: {"Content-Type": "text/event-stream"}});
      });
      vi.stubGlobal("fetch", provider);
      if (phase === "before dispatch") withdraw();
      const text = await new Response(createTextQaBrowserStream({input: qa,
        ...(phase === "before final" ? {onFinal: async () => withdraw()} : {}),
        dependencies: {answerQuestionStream: input => answerPersonRelationshipQuestionStream(input, [segmentId])}
      })).text();
      const events = text.trim().split("\n").map(line => JSON.parse(line));
      expect(provider).toHaveBeenCalledTimes(phase === "before dispatch" ? 0 : 1);
      expect(events.slice(-2)).toEqual([expect.objectContaining({type: "error", code: "qa_scope_changed"}), {type:"complete",status:"failed"}]);
      expect(events.filter(e => e.type === "final")).toHaveLength(0);
      expect(events.filter(e => e.type === "sentence")).toHaveLength(phase === "before final" ? 1 : 0);
      expect(resolve()).toMatchObject({status: "withdrawn", mappingVersion, sources: []});
    }
  );

  it("requires the new authorization binding even when an older verified quote is identical", async () => {
    await completeInteraction({uploadId:"upload_renewal",recordingDate:"2026-11-24",sources:[{segmentId:"blue",quote:"蓝色书签",subject:"both"}]});
    const catalog = resolve();
    const [source] = catalog.sources;
    const revision = "a".repeat(64);
    const identity = {accountId:"user_a",relationshipId,personId:"person_ta",mappingVersion};
    const withdrawalVersion = randomUUID();
    const read = () => ({...catalog,withdrawalVersion,sources:[{...source,authorizationRevision:revision}]});
    expect(() => openDateCompanionPersonQaScope(identity, read)).toThrow("qa_scope_changed");
    const scope = openDateCompanionPersonQaScope({...identity,withdrawalVersion}, read);
    const citation = {sourceSegmentId:"blue",uploadId:source.uploadId,excerpt:source.quote};
    const segments = [{id:"blue",uploadId:source.uploadId,startSeconds:0,endSeconds:4,text:source.quote,confidence:1,sceneLabels:[],valueLabels:[]}];
    const prior = (bindings: Parameters<typeof verifiedPriorSources>[1]) =>
      verifiedPriorSources(segments, bindings, scope.matchesRevision, scope.requiresRevision);
    expect(prior([citation,{...citation,revision:source.contentDigest}])).toEqual([]);
    expect(prior([{...citation,revision:source.contentDigest,authorizationRevision:revision}])).toHaveLength(1);
  });

  it("returns formally admitted companion/both snapshots in stable order", async () => {
    await completeInteraction({
      uploadId: "upload_later",
      recordingDate: "2026-08-11",
      sources: [{
        segmentId: "segment_both",
        quote: "我们下次去看展",
        subject: "both",
        startSeconds: 8
      }]
    });
    await completeInteraction({
      uploadId: "upload_earlier",
      recordingDate: "2026-08-10",
      sources: [{
        segmentId: "segment_companion",
        quote: "我最近喜欢摄影",
        subject: "companion",
        startSeconds: 2
      }]
    });

    expect(memoryDatabase.prepare("SELECT COUNT(*) AS count FROM memory_items").get())
      .toEqual({ count: 2 });
    expect(resolve()).toMatchObject({
      relationshipId,
      companionPersonId: "person_ta",
      mappingVersion: 1,
      status: "ready",
      sources: [
        {
          uploadId: "upload_earlier",
          sourceSegmentId: "segment_companion",
          recordingDate: "2026-08-10",
          quote: "我最近喜欢摄影",
          subject: "companion"
        },
        {
          uploadId: "upload_later",
          sourceSegmentId: "segment_both",
          recordingDate: "2026-08-11",
          quote: "我们下次去看展",
          subject: "both"
        }
      ]
    });
    for (const source of resolve().sources) {
      expect(source.contentDigest).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("excludes self-only, unknown and excluded recap sources", async () => {
    await completeInteraction({
      uploadId: "upload_dispositions",
      recordingDate: "2026-08-11",
      sources: [
        { segmentId: "segment_companion", quote: "Ta 喜欢摄影", subject: "companion" },
        { segmentId: "segment_self", quote: "我喜欢跑步", subject: "self" },
        { segmentId: "segment_unknown", quote: "不知道关于谁", subject: "unknown" },
        {
          segmentId: "segment_excluded",
          quote: "不保留这一条",
          subject: "companion",
          disposition: "excluded"
        }
      ]
    });
    expect(resolve().sources.map((source) => source.sourceSegmentId))
      .toEqual(["segment_companion"]);
  });

  it("excludes draft and participant-unresolved sources", async () => {
    const completed = await completeInteraction({
      uploadId: "upload_unresolved",
      recordingDate: "2026-08-11",
      sources: [{ segmentId: "segment_unresolved", quote: "Ta 想学陶艺", subject: "companion" }]
    });
    dateCompanionDatabase.prepare(`
      UPDATE dc_participant_assignments
      SET role = 'unresolved', confirmed_by = NULL, confirmed_at = NULL
      WHERE user_id = 'user_a' AND interaction_id = ?
    `).run(completed.interactionId);
    repository.importInteraction({
      userId: "user_a",
      relationshipId,
      sourceUploadId: "upload_draft",
      recordingDate: "2026-08-12",
      originalName: "draft.wav",
      participants: [{ speakerId: "speaker_1" }],
      recapCandidates: [{
        kind: "mentioned",
        proposedText: "草稿内容",
        sortOrder: 0,
        evidence: [{
          uploadId: "upload_draft",
          sourceSegmentId: "segment_draft",
          startSeconds: 0,
          endSeconds: 4,
          speakerId: "speaker_1",
          quote: "草稿内容"
        }]
      }]
    });
    expect(resolve().sources).toEqual([]);
  });

  it.each([
    ["missing receipt", "DELETE FROM dc_memory_bridge_receipts"],
    ["missing candidate receipt", "DELETE FROM dc_memory_bridge_candidate_receipts"],
    ["missing canonical provenance", "DELETE FROM memory_evidence_provenance"],
    ["missing outbox", "DELETE FROM dc_memory_bridge_outbox"],
    ["missing snapshot link", "DELETE FROM person_evidence_dc_links"],
    ["pending outbox", "UPDATE dc_memory_bridge_outbox SET status = 'pending', completed_at = NULL"],
    ["processing outbox", "UPDATE dc_memory_bridge_outbox SET status = 'processing', completed_at = NULL"],
    ["retryable outbox", "UPDATE dc_memory_bridge_outbox SET status = 'retryable_failed', completed_at = NULL"],
    ["needs-review outbox", "UPDATE dc_memory_bridge_outbox SET status = 'needs_review', completed_at = NULL"],
    ["cancelled outbox", "UPDATE dc_memory_bridge_outbox SET status = 'cancelled', completed_at = NULL"]
  ])("fails closed for %s", async (_label, mutation) => {
    await completeInteraction({
      uploadId: "upload_fail_closed",
      recordingDate: "2026-08-11",
      sources: [{ segmentId: "segment_fail_closed", quote: "Ta 喜欢咖啡", subject: "companion" }]
    });
    const target = mutation.includes("dc_memory_bridge_receipts")
      || mutation.includes("dc_memory_bridge_candidate_receipts")
      || mutation.includes("memory_evidence_provenance")
      || mutation.includes("person_evidence_dc_links")
      ? memoryDatabase
      : dateCompanionDatabase;
    target.exec(mutation);
    expect(resolve().sources).toEqual([]);
  });

  it("ignores a historical projection receipt and binds the catalog to the current outbox receipt", async () => {
    const completed = await completeInteraction({
      uploadId: "upload_duplicate_receipt",
      recordingDate: "2026-08-11",
      sources: [{ segmentId: "segment_duplicate_receipt", quote: "Ta 喜欢咖啡", subject: "companion" }]
    });
    const receipt = memoryDatabase.prepare(`
      SELECT * FROM dc_memory_bridge_receipts
      WHERE account_id = 'user_a' AND dc_interaction_id = ?
    `).get(completed.interactionId) as Record<string, string | number>;
    memoryDatabase.prepare(`
      INSERT INTO dc_memory_bridge_receipts (
        id, account_id, idempotency_key, payload_digest, dc_relationship_id,
        dc_interaction_id, dc_outbox_id, mapping_version, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "receipt_duplicate",
      receipt.account_id,
      dateCompanionMemoryProjectionIdempotencyKey("duplicate_idempotency_key"),
      receipt.payload_digest,
      receipt.dc_relationship_id,
      receipt.dc_interaction_id,
      receipt.dc_outbox_id,
      receipt.mapping_version,
      receipt.committed_at
    );
    expect(resolve().sources).toHaveLength(1);
  });

  it("fails closed for digest drift and archived Person/Relationship state", async () => {
    const completed = await completeInteraction({
      uploadId: "upload_integrity",
      recordingDate: "2026-08-11",
      sources: [{ segmentId: "segment_integrity", quote: "Ta 喜欢咖啡", subject: "companion" }]
    });
    dateCompanionDatabase.prepare(`
      UPDATE dc_evidence_snapshots SET quote = 'tampered'
      WHERE user_id = 'user_a' AND id = ?
    `).run(completed.snapshots[0]);
    expect(resolve().sources).toEqual([]);

    dateCompanionDatabase.prepare(`
      UPDATE dc_evidence_snapshots SET quote = 'Ta 喜欢咖啡'
      WHERE user_id = 'user_a' AND id = ?
    `).run(completed.snapshots[0]);
    memoryDatabase.prepare(`
      UPDATE person_entities SET status = 'archived'
      WHERE account_id = 'user_a' AND id = 'person_ta'
    `).run();
    expect(resolve()).toMatchObject({ status: "needs_review", sources: [] });

    memoryDatabase.prepare(`
      UPDATE person_entities SET status = 'confirmed'
      WHERE account_id = 'user_a' AND id = 'person_ta'
    `).run();
    memoryDatabase.prepare(`
      UPDATE person_relationships SET status = 'archived'
      WHERE account_id = 'user_a'
    `).run();
    expect(resolve()).toMatchObject({ status: "needs_review", sources: [] });
  });

  it("returns an empty catalog for mapping review and archived Date Companion relationship", async () => {
    await completeInteraction({
      uploadId: "upload_mapping_state",
      recordingDate: "2026-08-11",
      sources: [{ segmentId: "segment_mapping_state", quote: "Ta 喜欢咖啡", subject: "companion" }]
    });
    dateCompanionDatabase.prepare(`
      UPDATE dc_relationship_person_mappings
      SET status = 'needs_review'
      WHERE user_id = 'user_a' AND relationship_id = ?
    `).run(relationshipId);
    expect(resolve()).toMatchObject({ status: "needs_review", sources: [] });

    dateCompanionDatabase.prepare(`
      UPDATE dc_relationship_person_mappings
      SET status = 'confirmed'
      WHERE user_id = 'user_a' AND relationship_id = ?
    `).run(relationshipId);
    dateCompanionDatabase.prepare(`
      UPDATE dc_relationships SET status = 'archived'
      WHERE user_id = 'user_a' AND id = ?
    `).run(relationshipId);
    expect(resolve()).toMatchObject({ status: "unavailable", sources: [] });
  });

  it("blocks same-name Person remapping after a formal projection is frozen", async () => {
    await completeInteraction({
      uploadId: "upload_mapping_v1",
      recordingDate: "2026-08-11",
      sources: [{ segmentId: "segment_mapping_v1", quote: "Alice 喜欢摄影", subject: "companion" }]
    });
    expect(resolve()).toMatchObject({ companionPersonId: "person_ta", status: "ready" });

    expect(() => createDateCompanionMemoryBridgeRepository(dateCompanionDatabase).putPersonMapping({
      userId: "user_a",
      relationshipId,
      selfPersonId: "person_self",
      companionPersonId: "person_same_name",
      relationshipType: "dating",
      expectedVersion: mappingVersion
    })).toThrowError("person_mapping_change_requires_review");
    expect(resolve()).toMatchObject({
      companionPersonId: "person_ta",
      mappingVersion: 1,
      status: "ready"
    });
  });

  it("deduplicates identical snapshot rows by upload and segment deterministically", async () => {
    const completed = await completeInteraction({
      uploadId: "upload_duplicate",
      recordingDate: "2026-08-11",
      sources: [
        { segmentId: "segment_duplicate", quote: "Ta 喜欢拍照", subject: "companion", startSeconds: 0 },
        { segmentId: "segment_duplicate", quote: "Ta 喜欢拍照", subject: "companion", startSeconds: 0 }
      ]
    });
    const catalog = resolve();
    expect(catalog.sources).toHaveLength(1);
    expect(catalog.sources[0]?.evidenceSnapshotId)
      .toBe([...completed.snapshots].sort()[0]);
  });

  it("returns 404 for another account and empties the catalog after explicit deletion", async () => {
    const completed = await completeInteraction({
      uploadId: "upload_deleted",
      recordingDate: "2026-08-11",
      sources: [{ segmentId: "segment_deleted", quote: "Ta 喜欢散步", subject: "companion" }]
    });
    expect(() => resolve("user_b")).toThrowError("Relationship not found");
    expect(resolve().sources).toHaveLength(1);

    createMemoryRepository(memoryDatabase).deleteByUpload("user_a", "upload_deleted");
    const interactionVersion = dateCompanionDatabase.prepare(`
      SELECT version FROM dc_interactions WHERE id = ? AND user_id = 'user_a'
    `).get(completed.interactionId) as { version: number };
    repository.deleteInteraction("user_a", completed.interactionId, interactionVersion.version);
    expect(resolve()).toMatchObject({ sources: [] });
  });
});
