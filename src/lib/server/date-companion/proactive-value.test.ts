// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DateCompanionProactiveValue,
  DateCompanionProactiveValueContext
} from "@/lib/domain/date-companion-proactive-value";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import type { DateCompanionProactiveValueProvider } from "@/lib/server/proactive-insights/provider";
import {
  frameDateCompanionProactiveValueDraft,
  validateCanonicalDateCompanionProactiveValue
} from "@/lib/server/proactive-insights/deepseek-provider";

import { openDateCompanionDatabase } from "./db";
import {
  DATE_COMPANION_PROACTIVE_VALUE_LEASE_MS,
  createDateCompanionProactiveValueService
} from "./proactive-value";

let dateDatabase: Database.Database;
let memoryDatabase: Database.Database;
const now = "2026-08-19T10:00:00.000Z";

function value(context: DateCompanionProactiveValueContext = currentContext()): DateCompanionProactiveValue {
  const framed = frameDateCompanionProactiveValueDraft({
    context,
    value: {
      observation: "有一件事值得继续留意。",
      suggestedQuestions: ["这件事后来有新进展吗？"],
      reason: "这条提示来自可回溯的当次来源。",
      evidenceIds: ["evidence_1"],
      confidence: 0.72,
      caution: "这只是局部线索，不能形成长期关系结论。"
    }
  });
  if (!framed.value) throw new Error("Failed to frame proactive test value");
  return framed.value;
}

function currentContext(overrides: Partial<DateCompanionProactiveValueContext> = {}): DateCompanionProactiveValueContext {
  return {
    schemaVersion: 1,
    scope: "current_interaction",
    relationshipId: "relationship_1",
    interactionId: "interaction_1",
    mappingVersion: 1,
    interactionVersion: 2,
    confirmationFingerprint: "a".repeat(64),
    evidence: [{
      evidenceId: "evidence_1",
      uploadId: "upload_1",
      sourceSegmentId: "segment_1",
      recordingDate: "2026-08-19",
      startSeconds: 0,
      endSeconds: 3,
      quote: "Ta 说周末想去看展。",
      contentDigest: "b".repeat(64),
      origin: "direct_conversation",
      subject: "companion",
      subjectVersion: 1
    }],
    ...overrides
  };
}

function relationshipContext(): DateCompanionProactiveValueContext {
  const base = currentContext();
  return {
    ...base,
    scope: "person_relationship",
    interactionId: undefined,
    interactionVersion: undefined,
    confirmationFingerprint: undefined,
    personId: "person_companion"
  };
}

function currentContextWithDates(dates: string[]): DateCompanionProactiveValueContext {
  const base = currentContext();
  return currentContext({
    evidence: dates.map((recordingDate, index) => ({
      ...base.evidence[0]!,
      evidenceId: `evidence_${index + 1}`,
      uploadId: `upload_${index + 1}`,
      sourceSegmentId: `segment_${index + 1}`,
      recordingDate,
      contentDigest: String((index + 1) % 10).repeat(64)
    }))
  });
}

function provider(input: { generated?: boolean } = {}) {
  const generate = vi.fn(async ({ context, sourceFingerprint }: {
    context: DateCompanionProactiveValueContext;
    sourceFingerprint: string;
  }) => ({
    status: input.generated === false ? "fallback" as const : "generated" as const,
    value: input.generated === false ? null : value(context),
    provider: "deepseek" as const,
    model: "deepseek-v4-flash",
    elapsedMs: 1,
    sourceFingerprint,
    ...(input.generated === false ? { failureCode: "api_error" as const } : {})
  }));
  return {
    provider: { provider: "deepseek", model: "deepseek-v4-flash", generate } satisfies DateCompanionProactiveValueProvider,
    generate
  };
}

beforeEach(() => {
  dateDatabase = openDateCompanionDatabase({ filePath: ":memory:" });
  memoryDatabase = openMemoryDatabase({ filePath: ":memory:" });
  dateDatabase.prepare(`
    INSERT INTO dc_relationships (
      id, user_id, display_name, status, version, created_at, updated_at
    ) VALUES ('relationship_1', 'account_a', 'Ta', 'active', 1, ?, ?)
  `).run(now, now);
  dateDatabase.prepare(`
    INSERT INTO dc_interactions (
      id, user_id, relationship_id, source_upload_id, recording_date,
      original_name, duration_seconds, status, source_state, version,
      created_at, updated_at, confirmed_at, confirmation_fingerprint
    ) VALUES ('interaction_1', 'account_a', 'relationship_1', 'upload_1',
      '2026-08-19', 'date.wav', 30, 'confirmed', 'available', 2, ?, ?, ?, ?)
  `).run(now, now, now, "a".repeat(64));
});

afterEach(() => {
  dateDatabase.close();
  memoryDatabase.close();
});

describe("Date Companion proactive value cache service", () => {
  it("calls the provider at most once for one fingerprint and reuses the complete cached value", async () => {
    const mock = provider();
    const service = createDateCompanionProactiveValueService({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      provider: mock.provider,
      now: () => now,
      currentContextBuilder: () => ({ status: "ready", context: currentContext() })
    });
    const first = await service.getCurrentInteraction({ accountId: "account_a", interactionId: "interaction_1" });
    const second = await service.getCurrentInteraction({ accountId: "account_a", interactionId: "interaction_1" });
    expect(mock.generate).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ status: "ready", cacheHit: false, value: value() });
    expect(first.evidenceReferences).toEqual([
      expect.objectContaining({ quote: "Ta 说周末想去看展。" })
    ]);
    expect(second).toMatchObject({ status: "ready", cacheHit: true, value: value() });
    expect(dateDatabase.prepare("SELECT COUNT(*) AS count FROM dc_proactive_value_cache").get())
      .toEqual({ count: 1 });
  });

  it("returns canonical quotes only for Evidence actually cited by the card", async () => {
    const context = currentContextWithDates(["2026-08-18", "2026-08-19"]);
    const mock = provider();
    const service = createDateCompanionProactiveValueService({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      provider: mock.provider,
      now: () => now,
      currentContextBuilder: () => ({ status: "ready", context })
    });

    const result = await service.getCurrentInteraction({
      accountId: "account_a",
      interactionId: "interaction_1"
    });

    expect(result.evidenceReferences).toEqual([
      expect.objectContaining({ evidenceId: "evidence_1", quote: "Ta 说周末想去看展。" })
    ]);
  });

  it("ignores a v2-keyed cache row after the source framing contract moves to v3", async () => {
    dateDatabase.prepare(`
      INSERT INTO dc_proactive_value_cache (
        id, user_id, scope, relationship_id, interaction_id, person_id,
        mapping_version, source_fingerprint, contract_version, provider, model,
        status, payload_json, failure_code, created_at, updated_at, completed_at
      ) VALUES (
        'cache_v2', 'account_a', 'current_interaction', 'relationship_1',
        'interaction_1', NULL, 1, ?, 1, 'deepseek', 'deepseek-v4-flash',
        'generated', ?, NULL, ?, ?, ?
      )
    `).run("2".repeat(64), JSON.stringify(value()), now, now, now);
    const mock = provider();
    const service = createDateCompanionProactiveValueService({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      provider: mock.provider,
      now: () => now,
      currentContextBuilder: () => ({ status: "ready", context: currentContext() })
    });
    const result = await service.getCurrentInteraction({
      accountId: "account_a",
      interactionId: "interaction_1"
    });
    expect(mock.generate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "ready", cacheHit: false });
    expect(result.sourceFingerprint).not.toBe("2".repeat(64));
    expect(dateDatabase.prepare("SELECT COUNT(*) AS count FROM dc_proactive_value_cache").get())
      .toEqual({ count: 2 });
  });

  it("fences concurrent requests so one fingerprint starts only one provider call", async () => {
    let finish!: (result: Awaited<ReturnType<DateCompanionProactiveValueProvider["generate"]>>) => void;
    let sourceFingerprint = "";
    const generate = vi.fn((input: { sourceFingerprint: string }) => new Promise<Awaited<ReturnType<
      DateCompanionProactiveValueProvider["generate"]
    >>>((resolve) => {
      sourceFingerprint = input.sourceFingerprint;
      finish = resolve;
    }));
    const service = createDateCompanionProactiveValueService({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      provider: { provider: "deepseek", model: "deepseek-v4-flash", generate },
      now: () => now,
      currentContextBuilder: () => ({ status: "ready", context: currentContext() })
    });
    const firstPromise = service.getCurrentInteraction({
      accountId: "account_a",
      interactionId: "interaction_1"
    });
    await Promise.resolve();
    const concurrent = await service.getCurrentInteraction({
      accountId: "account_a",
      interactionId: "interaction_1"
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(concurrent).toMatchObject({
      status: "processing",
      cacheHit: true,
      failureCode: "generation_in_progress"
    });
    expect(concurrent).not.toHaveProperty("value");
    expect(concurrent.evidenceReferences).toEqual([]);
    finish({
      status: "generated",
      value: value(),
      provider: "deepseek",
      model: "deepseek-v4-flash",
      elapsedMs: 1,
      sourceFingerprint
    });
    await expect(firstPromise).resolves.toMatchObject({ status: "ready", cacheHit: false });
  });

  it("takes over an expired processing lease once and fences the late owner", async () => {
    let clock = now;
    const pending: Array<{
      sourceFingerprint: string;
      resolve: (result: Awaited<ReturnType<DateCompanionProactiveValueProvider["generate"]>>) => void;
    }> = [];
    const generate = vi.fn(({ sourceFingerprint }: { sourceFingerprint: string }) =>
      new Promise<Awaited<ReturnType<DateCompanionProactiveValueProvider["generate"]>>>((resolve) => {
        pending.push({ sourceFingerprint, resolve });
      })
    );
    const service = createDateCompanionProactiveValueService({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      provider: { provider: "deepseek", model: "deepseek-v4-flash", generate },
      now: () => clock,
      currentContextBuilder: () => ({ status: "ready", context: currentContext() })
    });

    const original = service.getCurrentInteraction({
      accountId: "account_a",
      interactionId: "interaction_1"
    });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const beforeExpiry = await service.getCurrentInteraction({
      accountId: "account_a",
      interactionId: "interaction_1"
    });
    expect(beforeExpiry.status).toBe("processing");
    expect(generate).toHaveBeenCalledTimes(1);

    clock = new Date(Date.parse(now) + DATE_COMPANION_PROACTIVE_VALUE_LEASE_MS + 1).toISOString();
    const takeover = service.getCurrentInteraction({
      accountId: "account_a",
      interactionId: "interaction_1"
    });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(generate).toHaveBeenCalledTimes(2);

    pending[1]!.resolve({
      status: "fallback",
      value: null,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      elapsedMs: 1,
      sourceFingerprint: pending[1]!.sourceFingerprint,
      failureCode: "api_error"
    });
    await expect(takeover).resolves.toMatchObject({
      status: "fallback",
      cacheHit: false,
      failureCode: "api_error"
    });

    pending[0]!.resolve({
      status: "generated",
      value: value(),
      provider: "deepseek",
      model: "deepseek-v4-flash",
      elapsedMs: 1,
      sourceFingerprint: pending[0]!.sourceFingerprint
    });
    await expect(original).resolves.toMatchObject({
      status: "fallback",
      cacheHit: true,
      failureCode: "api_error"
    });
    expect(dateDatabase.prepare(`
      SELECT status, attempt_count, claim_token, lease_expires_at
      FROM dc_proactive_value_cache WHERE user_id = 'account_a'
    `).get()).toEqual({
      status: "fallback",
      attempt_count: 2,
      claim_token: null,
      lease_expires_at: null
    });
  });

  it("uses a new fingerprint after mapping or Evidence digest changes and never serves the stale card", async () => {
    const mock = provider();
    let activeContext = currentContext();
    const service = createDateCompanionProactiveValueService({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      provider: mock.provider,
      now: () => now,
      currentContextBuilder: () => ({ status: "ready", context: activeContext })
    });
    const first = await service.getCurrentInteraction({ accountId: "account_a", interactionId: "interaction_1" });
    activeContext = currentContext({
      mappingVersion: 2,
      evidence: [{ ...currentContext().evidence[0]!, contentDigest: "c".repeat(64) }]
    });
    const second = await service.getCurrentInteraction({ accountId: "account_a", interactionId: "interaction_1" });
    expect(mock.generate).toHaveBeenCalledTimes(2);
    expect(second.sourceFingerprint).not.toBe(first.sourceFingerprint);
    expect(second.cacheHit).toBe(false);
  });

  it("returns a safe six-field rule fallback and does not retry a failed fingerprint", async () => {
    const mock = provider({ generated: false });
    const service = createDateCompanionProactiveValueService({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      provider: mock.provider,
      now: () => now,
      currentContextBuilder: () => ({ status: "ready", context: currentContext() })
    });
    const first = await service.getCurrentInteraction({ accountId: "account_a", interactionId: "interaction_1" });
    const second = await service.getCurrentInteraction({ accountId: "account_a", interactionId: "interaction_1" });
    expect(mock.generate).toHaveBeenCalledTimes(1);
    expect(first.status).toBe("fallback");
    expect(first.failureCode).toBe("api_error");
    expect(first.value).toEqual(expect.objectContaining({
      observation: expect.any(String),
      suggestedQuestions: [expect.any(String)],
      reason: expect.any(String),
      evidenceIds: ["evidence_1"],
      confidence: expect.any(Number),
      caution: expect.any(String)
    }));
    expect(second.cacheHit).toBe(true);
  });

  it.each([
    ["two dates", ["2026-08-19", "2026-08-19", "2026-08-19", "2026-08-19", "2026-08-18"]],
    ["three dates", [
      "2026-08-19", "2026-08-19", "2026-08-19", "2026-08-19", "2026-08-18", "2026-08-17"
    ]]
  ])("derives fallback language only from its first four referenced Evidence for %s", async (_label, dates) => {
    const context = currentContextWithDates(dates);
    const mock = provider({ generated: false });
    const service = createDateCompanionProactiveValueService({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      provider: mock.provider,
      now: () => now,
      currentContextBuilder: () => ({ status: "ready", context })
    });
    const result = await service.getCurrentInteraction({
      accountId: "account_a",
      interactionId: "interaction_1"
    });
    expect(result).toMatchObject({
      status: "fallback",
      cacheHit: false,
      value: { evidenceIds: ["evidence_1", "evidence_2", "evidence_3", "evidence_4"] }
    });
    expect(result.value?.observation).not.toMatch(/再次|模式/u);
    expect(validateCanonicalDateCompanionProactiveValue({ context, value: result.value }).value)
      .toEqual(result.value);
    expect(dateDatabase.prepare(`
      SELECT status FROM dc_proactive_value_cache WHERE user_id = 'account_a'
    `).get()).toEqual({ status: "fallback" });
  });

  it("repairs an invalid completed cache payload with a canonical fallback", async () => {
    const context = currentContext();
    const mock = provider();
    const service = createDateCompanionProactiveValueService({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      provider: mock.provider,
      now: () => now,
      currentContextBuilder: () => ({ status: "ready", context })
    });
    const first = await service.getCurrentInteraction({
      accountId: "account_a",
      interactionId: "interaction_1"
    });
    dateDatabase.prepare(`
      UPDATE dc_proactive_value_cache SET payload_json = '{}' WHERE user_id = 'account_a'
    `).run();
    const recovered = await service.getCurrentInteraction({
      accountId: "account_a",
      interactionId: "interaction_1"
    });
    expect(mock.generate).toHaveBeenCalledTimes(1);
    expect(recovered).toMatchObject({
      status: "fallback",
      cacheHit: true,
      sourceFingerprint: first.sourceFingerprint,
      failureCode: "cache_invalid"
    });
    const cache = dateDatabase.prepare(`
      SELECT status, payload_json, failure_code FROM dc_proactive_value_cache
      WHERE user_id = 'account_a'
    `).get() as { status: string; payload_json: string; failure_code: string };
    expect(cache).toMatchObject({ status: "fallback", failure_code: "cache_invalid" });
    expect(validateCanonicalDateCompanionProactiveValue({
      context,
      value: JSON.parse(cache.payload_json) as unknown
    }).value).toEqual(recovered.value);
  });

  it("clears its processing claim and returns unavailable if fallback framing has no valid Evidence", async () => {
    const invalidContext = currentContext({ evidence: [] });
    const mock = provider({ generated: false });
    const service = createDateCompanionProactiveValueService({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      provider: mock.provider,
      now: () => now,
      currentContextBuilder: () => ({ status: "ready", context: invalidContext })
    });
    await expect(service.getCurrentInteraction({
      accountId: "account_a",
      interactionId: "interaction_1"
    })).resolves.toMatchObject({
      status: "unavailable",
      failureCode: "fallback_invalid",
      evidenceReferences: []
    });
    expect(dateDatabase.prepare(`
      SELECT COUNT(*) AS count FROM dc_proactive_value_cache WHERE status = 'processing'
    `).get()).toEqual({ count: 0 });
    expect(dateDatabase.prepare("SELECT COUNT(*) AS count FROM dc_proactive_value_cache").get())
      .toEqual({ count: 0 });
  });

  it("keeps field-level source diagnostics internal and exposes only the aggregate failure code", async () => {
    const generate = vi.fn(async ({ sourceFingerprint }: { sourceFingerprint: string }) => ({
      status: "fallback" as const,
      value: null,
      provider: "deepseek" as const,
      model: "deepseek-v4-flash",
      elapsedMs: 1,
      sourceFingerprint,
      failureCode: "unsafe_source_attribution" as const,
      sourceDiagnostic: {
        ruleVersion: 4 as const,
        scopeOriginMismatch: false,
        failedAttribution: true,
        unsafeFields: ["reason" as const],
        sourceMarkerFields: [],
        certaintyFields: ["reason" as const],
        normalizedSourceFields: [],
        cautionBoundaryMissing: true,
        cautionSourceNormalized: false,
        referencedOrigins: ["user_reflection" as const]
      }
    }));
    const service = createDateCompanionProactiveValueService({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      provider: { provider: "deepseek", model: "deepseek-v4-flash", generate },
      now: () => now,
      currentContextBuilder: () => ({ status: "ready", context: currentContext() })
    });
    const result = await service.getCurrentInteraction({
      accountId: "account_a",
      interactionId: "interaction_1"
    });
    expect(result).toMatchObject({
      status: "fallback",
      failureCode: "unsafe_source_attribution"
    });
    expect(result).not.toHaveProperty("sourceDiagnostic");
  });

  it("keeps both reflection and conversation attribution in every mixed-source fallback field", async () => {
    const mock = provider({ generated: false });
    const base = relationshipContext();
    const mixedContext: DateCompanionProactiveValueContext = {
      ...base,
      evidence: [
        {
          ...base.evidence[0]!,
          evidenceId: "reflection_evidence",
          uploadId: "reflection_upload",
          sourceSegmentId: "reflection_segment",
          quote: "用户在复盘里说 Alice 可能想换工作。",
          contentDigest: "c".repeat(64),
          origin: "user_reflection"
        },
        {
          ...base.evidence[0]!,
          evidenceId: "conversation_evidence",
          contentDigest: "d".repeat(64),
          origin: "direct_conversation"
        }
      ]
    };
    const service = createDateCompanionProactiveValueService({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      provider: mock.provider,
      now: () => now,
      relationshipContextBuilder: () => ({ status: "ready", context: mixedContext })
    });
    const result = await service.getPersonRelationship({
      accountId: "account_a",
      relationshipId: "relationship_1"
    });
    expect(mock.generate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "fallback", failureCode: "api_error" });
    expect(validateCanonicalDateCompanionProactiveValue({
      context: mixedContext,
      value: result.value
    }).value).toEqual(result.value);
  });

  it("makes old cards immediately unavailable after delete/revoke/archive resolution and writes no Memory or Evidence", async () => {
    const mock = provider();
    let available = true;
    const service = createDateCompanionProactiveValueService({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      provider: mock.provider,
      now: () => now,
      currentContextBuilder: () => available
        ? { status: "ready", context: currentContext() }
        : { status: "unavailable", context: null }
    });
    await service.getCurrentInteraction({ accountId: "account_a", interactionId: "interaction_1" });
    available = false;
    const hidden = await service.getCurrentInteraction({ accountId: "account_a", interactionId: "interaction_1" });
    expect(hidden).toMatchObject({ status: "unavailable", evidenceReferences: [] });
    expect(hidden.value).toBeUndefined();
    expect(mock.generate).toHaveBeenCalledTimes(1);
    expect(memoryDatabase.prepare("SELECT COUNT(*) AS count FROM memory_items").get()).toEqual({ count: 0 });
    expect(memoryDatabase.prepare("SELECT COUNT(*) AS count FROM memory_evidence").get()).toEqual({ count: 0 });
    expect(memoryDatabase.prepare("SELECT COUNT(*) AS count FROM person_evidence").get()).toEqual({ count: 0 });
    expect(memoryDatabase.prepare("SELECT COUNT(*) AS count FROM person_entities").get()).toEqual({ count: 0 });
    expect(memoryDatabase.prepare("SELECT COUNT(*) AS count FROM person_relationships").get())
      .toEqual({ count: 0 });
  });

  it("does not return an AI card when deletion or mapping change wins during the provider request", async () => {
    let available = true;
    const generate = vi.fn(async ({ sourceFingerprint }: { sourceFingerprint: string }) => {
      available = false;
      return {
        status: "generated" as const,
        value: value(),
        provider: "deepseek" as const,
        model: "deepseek-v4-flash",
        elapsedMs: 1,
        sourceFingerprint
      };
    });
    const service = createDateCompanionProactiveValueService({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      provider: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        generate
      },
      now: () => now,
      currentContextBuilder: () => available
        ? { status: "ready", context: currentContext() }
        : { status: "unavailable", context: null }
    });
    const result = await service.getCurrentInteraction({
      accountId: "account_a",
      interactionId: "interaction_1"
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "unavailable",
      failureCode: "source_changed",
      evidenceReferences: []
    });
    expect(result.value).toBeUndefined();
  });

  it("keeps current-interaction and stable Person/relationship scopes separate", async () => {
    const mock = provider();
    const service = createDateCompanionProactiveValueService({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      provider: mock.provider,
      now: () => now,
      currentContextBuilder: () => ({ status: "ready", context: currentContext() }),
      relationshipContextBuilder: () => ({ status: "ready", context: relationshipContext() })
    });
    const current = await service.getCurrentInteraction({ accountId: "account_a", interactionId: "interaction_1" });
    const relationship = await service.getPersonRelationship({ accountId: "account_a", relationshipId: "relationship_1" });
    expect(mock.generate).toHaveBeenCalledTimes(2);
    expect(current).toMatchObject({ scope: "current_interaction", interactionId: "interaction_1" });
    expect(relationship).toMatchObject({ scope: "person_relationship", personId: "person_companion" });
    expect(relationship.sourceFingerprint).not.toBe(current.sourceFingerprint);
  });
});
