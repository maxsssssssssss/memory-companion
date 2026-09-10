// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DateCompanionHomeContent,
  DateCompanionProactiveValueContext,
  DateCompanionProactiveValueResponse
} from "@/lib/domain/date-companion-proactive-value";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import type {
  DateCompanionProactiveValueProvider,
  DateCompanionProactiveValueRunResult
} from "@/lib/server/proactive-insights/provider";

import { openDateCompanionDatabase } from "./db";
import { DcNotFoundError } from "./errors";
import { dateCompanionEvidenceDigest, stableBridgeDigest } from "./memory-bridge-digest";
import { processDateCompanionMemoryBridgeInteraction } from "./memory-bridge-consumer";
import { createDateCompanionMemoryBridgeRepository } from "./memory-bridge-repository";
import { resolveDateCompanionPersonSourceCatalog } from "./person-source-catalog";
import { createDateCompanionProactiveValueService } from "./proactive-value";
import {
  buildCurrentInteractionProactiveValueContext,
  buildPersonRelationshipProactiveValueContext,
  withDateCompanionHomeContext
} from "./proactive-value-context";
import { createDateCompanionRepository } from "./repository";
import { getOrCreateDateCompanionSubjectSuggestionBatch } from "./subject-suggestions";

let dateDatabase: Database.Database;
let memoryDatabase: Database.Database;
let clock: string;

const timestamp = "2026-09-08T10:00:00.000Z";
const accountId = "home_account_a";
const relationshipId = "home_relationship";
const interactionId = "home_interaction";
const uploadId = "home_upload";
const request = { accountId, relationshipId };
const companionEvidenceId = "dc_snapshot:home_snapshot_companion";
const promiseEvidenceId = "dc_snapshot:home_snapshot_promise";
const promiseId = "home_promise";
const rawCompanionQuote = "我下周三要做项目汇报，这几天在准备讲稿。";
const rawPromiseQuote = "我答应下次把那本书带给你。";

function seedConfirmedSources() {
  const person = memoryDatabase.prepare(`
    INSERT INTO person_entities (
      id, account_id, display_name, source, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'manual_confirmation', 'confirmed', ?, ?)
  `);
  person.run("home_self", accountId, "我", timestamp, timestamp);
  person.run("home_companion", accountId, "Love", timestamp, timestamp);
  memoryDatabase.prepare(`
    INSERT INTO person_self_bindings (
      account_id, person_id, status, version, set_at, created_at, updated_at
    ) VALUES (?, 'home_self', 'active', 1, ?, ?, ?)
  `).run(accountId, timestamp, timestamp, timestamp);
  dateDatabase.prepare(`
    INSERT INTO dc_relationships (
      id, user_id, display_name, status, version, created_at, updated_at
    ) VALUES (?, ?, 'Love', 'active', 1, ?, ?)
  `).run(relationshipId, accountId, timestamp, timestamp);
  dateDatabase.prepare(`
    INSERT INTO dc_relationship_person_mappings (
      id, user_id, relationship_id, self_person_id, companion_person_id,
      relationship_type, status, version, confirmed_at, created_at, updated_at
    ) VALUES ('home_mapping', ?, ?, 'home_self', 'home_companion', 'partner',
      'confirmed', 1, ?, ?, ?)
  `).run(accountId, relationshipId, timestamp, timestamp, timestamp);
  dateDatabase.prepare(`
    INSERT INTO dc_interactions (
      id, user_id, relationship_id, source_upload_id, recording_date, original_name,
      duration_seconds, status, source_state, version, created_at, updated_at,
      confirmed_at, confirmation_fingerprint
    ) VALUES (?, ?, ?, ?, '2026-09-07', 'home.wav', 120, 'confirmed',
      'available', 2, ?, ?, ?, ?)
  `).run(interactionId, accountId, relationshipId, uploadId,
    timestamp, timestamp, timestamp, "a".repeat(64));
  const participant = dateDatabase.prepare(`
    INSERT INTO dc_participant_assignments (
      user_id, interaction_id, speaker_id, role, confirmed_by, confirmed_at, continuity_key
    ) VALUES (?, ?, ?, ?, 'user', ?, ?)
  `);
  participant.run(accountId, interactionId, "home_speaker_companion", "companion",
    timestamp, "home_continuity_companion");
  participant.run(accountId, interactionId, "home_speaker_self", "self",
    timestamp, "home_continuity_self");
  const sources = [
    { id: "companion", quote: rawCompanionQuote, subject: "companion", role: "companion", disposition: "kept", kind: "mentioned" },
    { id: "promise", quote: rawPromiseQuote, subject: "self", role: "self", disposition: "kept", kind: "promise" },
    { id: "excluded", quote: "被排除的私密话题不得进入模型。", subject: "companion", role: "companion", disposition: "excluded", kind: "mentioned" },
    { id: "unknown", quote: "不知道是谁说的内容不得关联 Love。", subject: "unknown", role: "companion", disposition: "kept", kind: "mentioned" }
  ];
  const selections = sources.map((source, index) => {
    const recapId = `home_recap_${source.id}`;
    const snapshotId = `home_snapshot_${source.id}`;
    const segmentId = `home_segment_${source.id}`;
    const speakerId = `home_speaker_${source.role}`;
    const startSeconds = index * 15;
    const endSeconds = startSeconds + 10;
    const contentDigest = dateCompanionEvidenceDigest({
      userId: accountId, uploadId, sourceSegmentId: segmentId,
      startSeconds, endSeconds, speakerId, quote: source.quote
    });
    dateDatabase.prepare(`
      INSERT INTO dc_recap_items (
        id, user_id, interaction_id, kind, proposed_text, disposition,
        version, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '旧的混乱摘要，不应作为模型上下文', ?, 1, ?, ?, ?)
    `).run(recapId, accountId, interactionId, source.kind, source.disposition,
      index, timestamp, timestamp);
    dateDatabase.prepare(`
      INSERT INTO dc_evidence_snapshots (
        id, user_id, recap_item_id, upload_id, source_segment_id, start_seconds,
        end_seconds, speaker_id, quote, created_at, provenance_version, source_kind, content_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'date_companion_recap', ?)
    `).run(snapshotId, accountId, recapId, uploadId, segmentId,
      startSeconds, endSeconds, speakerId, source.quote, timestamp, contentDigest);
    dateDatabase.prepare(`
      INSERT INTO dc_memory_subject_selections (
        id, user_id, relationship_id, interaction_id, recap_item_id,
        evidence_snapshot_id, subject, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(`home_selection_${source.id}`, accountId, relationshipId, interactionId,
      recapId, snapshotId, source.subject, timestamp, timestamp);
    return { evidenceSnapshotId: snapshotId, recapItemId: recapId,
      uploadId, sourceSegmentId: segmentId, contentDigest, subject: source.subject };
  });
  const payload = {
    version: 1, userId: accountId, relationshipId, interactionId,
    sourceUploadId: uploadId, sourceVersion: 2, confirmationFingerprint: "a".repeat(64),
    mapping: { version: 1, selfPersonId: "home_self", companionPersonId: "home_companion",
      relationshipType: "partner" },
    selections
  };
  dateDatabase.prepare(`
    INSERT INTO dc_memory_bridge_outbox (
      id, user_id, relationship_id, interaction_id, idempotency_key,
      payload_digest, payload_json, mapping_version, source_version,
      confirmation_fingerprint, status, attempt_count, requested_at, updated_at
    ) VALUES ('home_outbox', ?, ?, ?, 'home_sync', ?, ?, 1, 2, ?, 'pending', 0, ?, ?)
  `).run(accountId, relationshipId, interactionId, stableBridgeDigest(payload),
    JSON.stringify(payload), "a".repeat(64), timestamp, timestamp);
  dateDatabase.prepare(`
    INSERT INTO dc_promises (
      id, user_id, relationship_id, originating_recap_item_id, text,
      status, version, created_at, updated_at
    ) VALUES (?, ?, ?, 'home_recap_promise', ?, 'open', 1, ?, ?)
  `).run(promiseId, accountId, relationshipId, rawPromiseQuote, timestamp, timestamp);
}

function homeValue(includePromise = true): DateCompanionHomeContent {
  return {
    home: {
      about: [{ kind: "recent_update", text: "Love 最近在准备项目汇报的讲稿。",
        evidenceIds: [companionEvidenceId] }],
      beforeMeeting: includePromise ? [{ kind: "open_promise", text: "见面时把答应借给 Love 的书带上。",
        reason: "上次答应了带书，仍未完成。", promiseId, evidenceIds: [promiseEvidenceId] }] : []
    },
    evidenceIds: includePromise ? [companionEvidenceId, promiseEvidenceId] : [companionEvidenceId]
  };
}

async function seedAdmittedHomeInteraction(companionSourceCount = 1) {
  const repository = createDateCompanionRepository(dateDatabase);
  createDateCompanionMemoryBridgeRepository(dateDatabase).putRetentionSetting({
    userId: accountId, enabled: true, expectedVersion: 0
  });
  const admittedUploadId = "home_admitted_upload";
  const sources = [
    { sourceId: "admitted_promise", subject: "self" as const, speakerId: "admitted_self",
      kind: "promise" as const, quote: rawPromiseQuote },
    ...Array.from({ length: companionSourceCount }, (_, index) => ({
      sourceId: `admitted_companion_${index}`, subject: "companion" as const,
      speakerId: "admitted_companion", kind: "mentioned" as const,
      quote: `我最近在准备第 ${index + 1} 个项目的汇报讲稿。`
    }))
  ];
  const imported = repository.importInteraction({
    userId: accountId, relationshipId, sourceUploadId: admittedUploadId,
    recordingDate: "2026-09-07", originalName: "admitted.wav",
    participants: [{ speakerId: "admitted_self" }, { speakerId: "admitted_companion" }],
    recapCandidates: sources.map((source, index) => ({
      kind: source.kind, proposedText: source.quote, sortOrder: index,
      evidence: [{ uploadId: admittedUploadId, sourceSegmentId: source.sourceId,
        startSeconds: index * 10, endSeconds: index * 10 + 8,
        speakerId: source.speakerId, quote: source.quote }]
    }))
  });
  const interaction = repository.getRelationshipView(accountId, relationshipId).interactions
    .find((item) => item.id === imported.interactionId)!;
  const batch = await getOrCreateDateCompanionSubjectSuggestionBatch({
    database: dateDatabase, userId: accountId, interactionId: imported.interactionId,
    provider: {
      model: "Qwen/Qwen3.6-27B",
      suggest: async (requested) => requested.map((source) => {
        const subject = source.quote === rawPromiseQuote ? "self" as const : "companion" as const;
        return { canonicalSourceKey: source.canonicalSourceKey, proposedSubject: subject,
          confidence: 1, reasonCode: subject === "self"
            ? "explicit_self_reference" as const : "explicit_companion_reference" as const };
      })
    }
  });
  const selectedSubjects = new Map(batch.suggestions.flatMap((suggestion) =>
    suggestion.evidenceSnapshotIds.map((id) => [id, suggestion.proposedSubject] as const)));
  repository.updateRecap({
    userId: accountId, interactionId: imported.interactionId, version: 0,
    assignments: [{ speakerId: "admitted_self", role: "self" },
      { speakerId: "admitted_companion", role: "companion" }],
    mutations: interaction.recapItems.map((item) => ({ id: item.id, version: item.version, disposition: "kept" })),
    memoryAdmission: {
      mappingVersion: 1,
      subjectSuggestionConfirmation: { batchId: batch.batchId, evidenceDigest: batch.evidenceDigest,
        proposalDigest: batch.proposalDigest, confirmationFingerprint: batch.confirmationFingerprint,
        confirmedVisibleSuggestions: true },
      selections: interaction.recapItems.map((item) => ({
        evidenceSnapshotId: item.evidence[0]!.id,
        subject: selectedSubjects.get(item.evidence[0]!.id)!
      }))
    },
    finalize: true
  });
  repository.markUploadSourceState(accountId, admittedUploadId, "server_cleaned");
  await processDateCompanionMemoryBridgeInteraction({
    dateCompanionDatabase: dateDatabase, memoryDatabase, userId: accountId,
    interactionId: imported.interactionId
  });
  expect(dateDatabase.prepare("SELECT status FROM dc_memory_bridge_outbox WHERE interaction_id = ?")
    .get(imported.interactionId)).toEqual({ status: "completed" });
  const promise = repository.getRelationshipView(accountId, relationshipId).promises
    .find((item) => item.originatingRecapItemId === interaction.recapItems[0]!.id)!;
  expect(promise).toBeDefined();
  return { admittedUploadId, promise, interaction, imported };
}

function admittedRelationshipContext(input: Parameters<typeof buildPersonRelationshipProactiveValueContext>[0]) {
  return buildPersonRelationshipProactiveValueContext({
    ...input,
    // Direct Date Companion sources still pass the real catalog and Person
    // admission resolver. Disable the unrelated generic Reflection lookup.
    resolveMemorySource: () => ({ eligible: false, origin: "unknown" })
  });
}

function createProvider(value: (context: DateCompanionProactiveValueContext) => DateCompanionHomeContent | null
  = (context) => homeValue(context.promises?.some((promise) => promise.status === "open"))) {
  const generate = vi.fn(async ({ context, sourceFingerprint }: {
    context: DateCompanionProactiveValueContext; sourceFingerprint: string;
  }): Promise<DateCompanionProactiveValueRunResult> => {
    const result = value(context);
    return { status: result ? "generated" : "fallback", value: result,
      provider: "tokenhub", model: "deepseek-v4-pro", elapsedMs: 1, sourceFingerprint,
      ...(result ? {} : { failureCode: "api_error" }) };
  });
  return { provider: { provider: "tokenhub", model: "deepseek-v4-pro", generate } satisfies DateCompanionProactiveValueProvider,
    generate };
}

function service(provider: DateCompanionProactiveValueProvider, includeSelfEvidence = true) {
  return createDateCompanionProactiveValueService({
    dateCompanionDatabase: dateDatabase, memoryDatabase, provider, now: () => clock,
    // This is a service/SQLite integration fixture. The real current-source
    // builder checks canonical kept snapshots; this seam supplies the already
    // admitted relationship scope without pretending to test Memory admission.
    relationshipContextBuilder: (input) => {
      const resolution = buildCurrentInteractionProactiveValueContext({ ...input, interactionId });
      if (!resolution.context) return resolution;
      const context = resolution.context;
      return { status: "ready", context: {
        schemaVersion: 1, scope: "person_relationship", relationshipId,
        personId: "home_companion", mappingVersion: context.mappingVersion,
        evidence: context.evidence.filter((evidence) => includeSelfEvidence || evidence.subject !== "self")
      } };
    }
  });
}

function expectNoHomeItems(result: DateCompanionProactiveValueResponse) {
  if (result.value && "home" in result.value) {
    expect(result.value.home).toEqual({ about: [], beforeMeeting: [] });
  } else {
    expect(result.value).toBeUndefined();
  }
  expect(result.evidenceReferences).toEqual([]);
}

beforeEach(() => {
  clock = timestamp;
  dateDatabase = openDateCompanionDatabase({ filePath: ":memory:" });
  memoryDatabase = openMemoryDatabase({ filePath: ":memory:" });
  seedConfirmedSources();
});

afterEach(() => {
  dateDatabase.close();
  memoryDatabase.close();
});

describe("Date Companion home content independent local acceptance", () => {
  it("adds an actually admitted Self promise only to home context and refreshes it after completion", async () => {
    const fixture = await seedAdmittedHomeInteraction();
    const input = { dateCompanionDatabase: dateDatabase, memoryDatabase, accountId, relationshipId };
    const catalog = resolveDateCompanionPersonSourceCatalog(input);
    expect(catalog.status).toBe("ready");
    expect(catalog.sources.map((source) => source.sourceSegmentId)).toEqual(["admitted_companion_0"]);
    expect(catalog.sources.every((source) => source.subject === "companion")).toBe(true);
    const base = admittedRelationshipContext(input);
    expect(base.status).toBe("ready");
    expect(base.context!.evidence.every((source) => source.subject === "companion")).toBe(true);
    const home = withDateCompanionHomeContext({ ...input, context: base.context!, referenceDate: "2026-09-08" })!;
    const selfEvidence = home.evidence.find((source) => source.sourceSegmentId === "admitted_promise")!;
    expect(selfEvidence).toMatchObject({ subject: "self", quote: rawPromiseQuote,
      evidenceId: `dc_snapshot:${fixture.interaction.recapItems[0]!.evidence[0]!.id}` });
    expect(home.promises).toEqual([{ id: fixture.promise.id, text: rawPromiseQuote,
      status: "open", version: fixture.promise.version, evidenceIds: [selfEvidence.evidenceId] }]);
    const mock = createProvider((context) => {
      const promise = context.promises?.find((item) => item.status === "open");
      return { home: { about: [], beforeMeeting: promise ? [{ kind: "open_promise",
        text: "见面时把答应的书带上。", reason: "上次明确答应了带书。", promiseId: promise.id,
        evidenceIds: promise.evidenceIds }] : [] }, evidenceIds: promise?.evidenceIds ?? [] };
    });
    const instance = createDateCompanionProactiveValueService({
      dateCompanionDatabase: dateDatabase, memoryDatabase, provider: mock.provider, now: () => clock,
      relationshipContextBuilder: admittedRelationshipContext
    });
    const first = await instance.getPersonRelationship(request);
    expect(first).toMatchObject({ status: "ready", value: { home: {
      about: [], beforeMeeting: [{ kind: "open_promise", promiseId: fixture.promise.id }]
    } } });
    createDateCompanionRepository(dateDatabase).patchPromise({
      userId: accountId, promiseId: fixture.promise.id, version: fixture.promise.version, status: "done"
    });
    const done = await instance.getPersonRelationship(request);
    expect(done).toMatchObject({ status: "ready", cacheHit: false });
    expectNoHomeItems(done);
    expect(done.sourceFingerprint).not.toBe(first.sourceFingerprint);
    expect(mock.generate.mock.calls[1]![0].context.promises).toEqual([{ id: fixture.promise.id,
      text: rawPromiseQuote, status: "done", version: fixture.promise.version + 1,
      evidenceIds: [selfEvidence.evidenceId] }]);
    expect(resolveDateCompanionPersonSourceCatalog(input)).toEqual(catalog);
    expect(memoryDatabase.prepare(`
      SELECT observation.person_id FROM person_subject_observations observation
      INNER JOIN person_evidence evidence ON evidence.id = observation.evidence_id
        AND evidence.account_id = observation.account_id
      WHERE evidence.account_id = ? AND evidence.upload_id = ?
        AND evidence.source_segment_id = 'admitted_promise' AND observation.status = 'confirmed'
    `).all(accountId, fixture.admittedUploadId)).toEqual([{ person_id: "home_self" }]);
  });

  it("reserves the 24-source budget for an admitted open Self promise without widening the companion catalog", async () => {
    const fixture = await seedAdmittedHomeInteraction(24);
    const input = { dateCompanionDatabase: dateDatabase, memoryDatabase, accountId, relationshipId };
    const base = admittedRelationshipContext(input);
    expect(base.context?.evidence).toHaveLength(24);
    expect(base.context!.evidence.every((source) => source.subject === "companion")).toBe(true);
    const home = withDateCompanionHomeContext({ ...input, context: base.context!, referenceDate: "2026-09-08" })!;
    expect(home.evidence).toHaveLength(24);
    expect(home.evidence.filter((source) => source.subject === "self"))
      .toEqual([expect.objectContaining({ sourceSegmentId: "admitted_promise" })]);
    expect(home.evidence.filter((source) => source.subject === "companion")).toHaveLength(23);
    expect(home.promises).toEqual([expect.objectContaining({ id: fixture.promise.id, status: "open" })]);
    const catalog = resolveDateCompanionPersonSourceCatalog(input);
    expect(catalog.sources).toHaveLength(24);
    expect(catalog.sources.map((source) => source.subject)).not.toContain("self");
  });

  it("supports a genuinely admitted Self-only promise without inventing companion facts or catalog sources", async () => {
    const fixture = await seedAdmittedHomeInteraction(0);
    const input = { dateCompanionDatabase: dateDatabase, memoryDatabase, accountId, relationshipId };
    expect(resolveDateCompanionPersonSourceCatalog(input)).toMatchObject({ status: "ready", sources: [] });
    const resolved = admittedRelationshipContext(input);
    expect(resolved.status).toBe("ready");
    expect(resolved.context?.evidence).toEqual([expect.objectContaining({
      subject: "self", sourceSegmentId: "admitted_promise", quote: rawPromiseQuote
    })]);
    expect(resolved.context?.promises).toEqual([expect.objectContaining({ id: fixture.promise.id, status: "open" })]);
    const mock = createProvider((context) => {
      const promise = context.promises?.find((candidate) => candidate.status === "open");
      return { home: { about: [], beforeMeeting: promise ? [{ kind: "open_promise",
        text: "记得带上答应的书。", reason: "这是上次明确答应的事。", promiseId: promise.id,
        evidenceIds: promise.evidenceIds }] : [] }, evidenceIds: promise?.evidenceIds ?? [] };
    });
    const instance = createDateCompanionProactiveValueService({
      dateCompanionDatabase: dateDatabase, memoryDatabase, provider: mock.provider, now: () => clock,
      relationshipContextBuilder: admittedRelationshipContext
    });
    expect(await instance.getPersonRelationship(request)).toMatchObject({ status: "ready", value: {
      home: { about: [], beforeMeeting: [{ promiseId: fixture.promise.id, kind: "open_promise" }] }
    } });
    expect(mock.generate).toHaveBeenCalledTimes(1);
    expect(resolveDateCompanionPersonSourceCatalog(input)).toMatchObject({ status: "ready", sources: [] });
  });

  it("drops a previously admitted Self promise when its canonical projection digest conflicts", async () => {
    const fixture = await seedAdmittedHomeInteraction();
    memoryDatabase.prepare(`
      UPDATE person_evidence_dc_links SET snapshot_digest = ?
      WHERE account_id = ? AND dc_evidence_snapshot_id = ?
    `).run("f".repeat(64), accountId, fixture.interaction.recapItems[0]!.evidence[0]!.id);
    const input = { dateCompanionDatabase: dateDatabase, memoryDatabase, accountId, relationshipId };
    const base = admittedRelationshipContext(input);
    expect(base.status).toBe("ready");
    const home = withDateCompanionHomeContext({ ...input, context: base.context!, referenceDate: "2026-09-08" })!;
    expect(home.evidence.map((source) => source.sourceSegmentId)).toEqual(["admitted_companion_0"]);
    expect(home.promises).toEqual([]);
  });

  it("uses canonical original quotes, excludes unknown/excluded material and caches distinct sourced sections", async () => {
    const mock = createProvider();
    const instance = service(mock.provider);
    const first = await instance.getPersonRelationship(request);
    const second = await instance.getPersonRelationship(request);
    expect(mock.generate).toHaveBeenCalledTimes(1);
    const context = mock.generate.mock.calls[0]![0].context;
    expect(context.evidence.map((evidence) => evidence.quote)).toEqual([rawCompanionQuote, rawPromiseQuote]);
    expect(context.referenceDate).toBe("2026-09-08");
    expect(context.promises).toEqual([{ id: promiseId, text: rawPromiseQuote,
      status: "open", version: 1, evidenceIds: [promiseEvidenceId] }]);
    expect(first).toMatchObject({ status: "ready", cacheHit: false, value: homeValue() });
    expect(second).toMatchObject({ status: "ready", cacheHit: true, value: homeValue() });
    expect(first.evidenceReferences.map((evidence) => evidence.evidenceId))
      .toEqual([companionEvidenceId, promiseEvidenceId]);
    expect(dateDatabase.prepare("SELECT provider, model, status FROM dc_proactive_value_cache").get())
      .toEqual({ provider: "tokenhub", model: "deepseek-v4-pro", status: "generated" });
    for (const table of ["memory_items", "memory_evidence", "person_evidence", "person_relationships"]) {
      expect(memoryDatabase.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(memoryDatabase.prepare("SELECT COUNT(*) AS count FROM person_entities").get()).toEqual({ count: 2 });
  });

  it("caches an intentional empty AI selection without substituting raw recap text or generic rules", async () => {
    const empty: DateCompanionHomeContent = { home: { about: [], beforeMeeting: [] }, evidenceIds: [] };
    const mock = createProvider(() => empty);
    const instance = service(mock.provider);
    const first = await instance.getPersonRelationship(request);
    const second = await instance.getPersonRelationship(request);
    expect(first).toMatchObject({ status: "ready", cacheHit: false, value: empty });
    expect(second).toMatchObject({ status: "ready", cacheHit: true, value: empty });
    expect(first.evidenceReferences).toEqual([]);
    expect(mock.generate).toHaveBeenCalledTimes(1);
  });

  it("does not add a self promise from a DC snapshot without canonical Person admission", async () => {
    const mock = createProvider(() => homeValue(false));
    const result = await service(mock.provider, false).getPersonRelationship(request);
    expect(result).toMatchObject({ status: "ready", value: homeValue(false) });
    const context = mock.generate.mock.calls[0]![0].context;
    expect(context.evidence.map((evidence) => evidence.evidenceId)).toEqual([companionEvidenceId]);
    expect(context.promises).toEqual([]);
  });

  it("requires the real relationship admission path before invoking AI", async () => {
    const mock = createProvider();
    const instance = createDateCompanionProactiveValueService({
      dateCompanionDatabase: dateDatabase, memoryDatabase, provider: mock.provider, now: () => clock
    });
    expectNoHomeItems(await instance.getPersonRelationship(request));
    expect(mock.generate).not.toHaveBeenCalled();
    expect(dateDatabase.prepare("SELECT COUNT(*) AS count FROM dc_proactive_value_cache").get())
      .toEqual({ count: 0 });
  });

  it("keeps both home sections empty on provider failure and does not retry the same fingerprint", async () => {
    const mock = createProvider(() => null);
    const instance = service(mock.provider);
    expectNoHomeItems(await instance.getPersonRelationship(request));
    expectNoHomeItems(await instance.getPersonRelationship(request));
    expect(mock.generate).toHaveBeenCalledTimes(1);
  });

  it("revalidates completed cached citations and replaces a poisoned payload with empty home sections", async () => {
    const mock = createProvider();
    const instance = service(mock.provider);
    const initial = await instance.getPersonRelationship(request);
    dateDatabase.prepare("UPDATE dc_proactive_value_cache SET payload_json = ? WHERE user_id = ?")
      .run(JSON.stringify({ home: { about: [{ kind: "recent_update", text: "另一账号的内容",
        evidenceIds: ["foreign_evidence"] }], beforeMeeting: [] }, evidenceIds: ["foreign_evidence"] }), accountId);
    const cached = await instance.getPersonRelationship(request);
    expectNoHomeItems(cached);
    expect(cached).toMatchObject({ status: "fallback", cacheHit: true,
      sourceFingerprint: initial.sourceFingerprint, failureCode: "cache_invalid" });
    expect(mock.generate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["foreign citation", () => ({ home: { about: [{ kind: "recent_update" as const,
      text: "另一账号的近况", evidenceIds: ["foreign_evidence"] }], beforeMeeting: [] },
    evidenceIds: ["foreign_evidence"] })],
    ["excluded citation", () => ({ home: { about: [{ kind: "recent_update" as const,
      text: "被排除的内容", evidenceIds: ["dc_snapshot:home_snapshot_excluded"] }], beforeMeeting: [] },
    evidenceIds: ["dc_snapshot:home_snapshot_excluded"] })],
    ["self attributed to companion", () => ({ home: { about: [{ kind: "preference" as const,
      text: "Love 喜欢读书。", evidenceIds: [promiseEvidenceId] }], beforeMeeting: [] },
    evidenceIds: [promiseEvidenceId] })]
  ])("rejects a %s returned by the model at the service boundary", async (_label, value) => {
    const mock = createProvider(value);
    expectNoHomeItems(await service(mock.provider).getPersonRelationship(request));
  });

  it("rejects cross-account resource IDs before invoking the provider or reading another account cache", async () => {
    const mock = createProvider();
    const instance = service(mock.provider);
    await instance.getPersonRelationship(request);
    await expect(instance.getPersonRelationship({ ...request, accountId: "home_account_b" }))
      .rejects.toBeInstanceOf(DcNotFoundError);
    expect(mock.generate).toHaveBeenCalledTimes(1);
    expect(dateDatabase.prepare("SELECT COUNT(*) AS count FROM dc_proactive_value_cache WHERE user_id = ?")
      .get("home_account_b")).toEqual({ count: 0 });
  });

  it("refreshes the dated cache and removes a completed promise on the next read", async () => {
    const mock = createProvider();
    const instance = service(mock.provider);
    const first = await instance.getPersonRelationship(request);
    clock = "2026-09-09T10:00:00.000Z";
    const nextDay = await instance.getPersonRelationship(request);
    expect(nextDay.sourceFingerprint).not.toBe(first.sourceFingerprint);
    createDateCompanionRepository(dateDatabase).patchPromise({
      userId: accountId, promiseId, version: 1, status: "done"
    });
    const completed = await instance.getPersonRelationship(request);
    expect(completed.sourceFingerprint).not.toBe(nextDay.sourceFingerprint);
    expect(completed).toMatchObject({ status: "ready", cacheHit: false, value: homeValue(false) });
    expect(mock.generate).toHaveBeenCalledTimes(3);
  });

  it("rejects completed promises even if the model still emits the previous open promise", async () => {
    createDateCompanionRepository(dateDatabase).patchPromise({
      userId: accountId, promiseId, version: 1, status: "done"
    });
    const mock = createProvider(() => homeValue());
    expectNoHomeItems(await service(mock.provider).getPersonRelationship(request));
  });

  it.each(["delete", "exclude", "unknown", "archive", "promise_done"] as const)(
    "fences a late generated response when %s wins while the model is running", async (change) => {
      let finish!: (value: DateCompanionProactiveValueRunResult) => void;
      let fingerprint = "";
      const generate = vi.fn(({ sourceFingerprint }: { sourceFingerprint: string }) =>
        new Promise<DateCompanionProactiveValueRunResult>((resolve) => {
          fingerprint = sourceFingerprint;
          finish = resolve;
        }));
      const pending = service({ provider: "tokenhub", model: "deepseek-v4-pro", generate })
        .getPersonRelationship(request);
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
      if (change === "delete") {
        createDateCompanionRepository(dateDatabase).deleteInteraction(accountId, interactionId, 2);
      } else if (change === "exclude") {
        dateDatabase.prepare("UPDATE dc_recap_items SET disposition = 'excluded' WHERE id = 'home_recap_companion'").run();
      } else if (change === "unknown") {
        dateDatabase.prepare("UPDATE dc_memory_subject_selections SET subject = 'unknown', version = version + 1 WHERE id = 'home_selection_companion'").run();
      } else if (change === "archive") {
        dateDatabase.prepare("UPDATE dc_relationships SET status = 'archived' WHERE id = ?").run(relationshipId);
      } else {
        createDateCompanionRepository(dateDatabase).patchPromise({
          userId: accountId, promiseId, version: 1, status: "done"
        });
      }
      finish({ status: "generated", value: homeValue(), provider: "tokenhub",
        model: "deepseek-v4-pro", elapsedMs: 1, sourceFingerprint: fingerprint });
      const result = await pending;
      expectNoHomeItems(result);
      expect(dateDatabase.prepare("SELECT COUNT(*) AS count FROM dc_proactive_value_cache WHERE source_fingerprint = ?")
        .get(fingerprint)).toEqual({ count: 0 });
    }
  );
});
