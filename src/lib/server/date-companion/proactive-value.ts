import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import {
  DATE_COMPANION_PROACTIVE_VALUE_CONTRACT_VERSION,
  DATE_COMPANION_PROACTIVE_VALUE_RESPONSE_VERSION,
  DateCompanionProactiveValueResponseSchema,
  type DateCompanionProactiveEvidence,
  type DateCompanionProactiveValue,
  type DateCompanionProactiveValueContext,
  type DateCompanionProactiveValueResponse
} from "@/lib/domain/date-companion-proactive-value";
import { getMemoryDatabase } from "@/lib/server/memory/db";
import {
  createDateCompanionProactiveValueProvider,
  type DateCompanionProactiveValueProvider
} from "@/lib/server/proactive-insights/provider";
import {
  DATE_COMPANION_PROACTIVE_SOURCE_ATTRIBUTION_VERSION,
  frameDateCompanionProactiveValueDraft,
  validateCanonicalDateCompanionProactiveValue
} from "@/lib/server/proactive-insights/deepseek-provider";

import { getDateCompanionDatabase } from "./db";
import {
  buildCurrentInteractionProactiveValueContext,
  buildPersonRelationshipProactiveValueContext
} from "./proactive-value-context";

type CacheRow = {
  source_fingerprint: string;
  status: "processing" | "generated" | "fallback";
  payload_json: string | null;
  failure_code: string | null;
  claim_token: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
};

export const DATE_COMPANION_PROACTIVE_VALUE_LEASE_MS = 45_000;

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32)}`;
}

function leaseExpiry(now: string) {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) throw new Error("invalid_proactive_value_time");
  return new Date(timestamp + DATE_COMPANION_PROACTIVE_VALUE_LEASE_MS).toISOString();
}

function cacheRow(input: {
  database: Database.Database;
  accountId: string;
  fingerprint: string;
}) {
  return input.database.prepare(`
    SELECT source_fingerprint, status, payload_json, failure_code,
           claim_token, lease_expires_at, attempt_count
    FROM dc_proactive_value_cache
    WHERE user_id = ? AND source_fingerprint = ?
  `).get(input.accountId, input.fingerprint) as CacheRow | undefined;
}

export function dateCompanionProactiveValueFingerprint(input: {
  accountId: string;
  context: DateCompanionProactiveValueContext;
  provider: string;
  model: string;
}) {
  return createHash("sha256").update(JSON.stringify({
    contractVersion: DATE_COMPANION_PROACTIVE_VALUE_CONTRACT_VERSION,
    sourceAttributionVersion: DATE_COMPANION_PROACTIVE_SOURCE_ATTRIBUTION_VERSION,
    accountId: input.accountId,
    provider: input.provider,
    model: input.model,
    scope: input.context.scope,
    relationshipId: input.context.relationshipId,
    interactionId: input.context.interactionId ?? null,
    personId: input.context.personId ?? null,
    mappingVersion: input.context.mappingVersion,
    interactionVersion: input.context.interactionVersion ?? null,
    confirmationFingerprint: input.context.confirmationFingerprint ?? null,
    evidence: input.context.evidence.map((evidence) => ({
      evidenceId: evidence.evidenceId,
      uploadId: evidence.uploadId,
      sourceSegmentId: evidence.sourceSegmentId,
      recordingDate: evidence.recordingDate,
      contentDigest: evidence.contentDigest,
      origin: evidence.origin,
      subject: evidence.subject,
      subjectVersion: evidence.subjectVersion ?? null
    }))
  })).digest("hex");
}

function ruleFallback(context: DateCompanionProactiveValueContext): DateCompanionProactiveValue | null {
  const selectedEvidence = context.evidence.slice(0, 4);
  if (selectedEvidence.length === 0) return null;
  const selectedContext = { ...context, evidence: selectedEvidence };
  const distinctDateCount = new Set(selectedEvidence.map((item) => item.recordingDate)).size;
  const observation = distinctDateCount === 1
    ? "有一条值得之后继续留意的内容。"
    : distinctDateCount === 2
      ? "相关内容在两个不同日期再次出现。"
      : "相关内容出现在三个或更多日期，暂时只能作为待观察的模式线索。";
  const framed = frameDateCompanionProactiveValueDraft({
    context: selectedContext,
    value: {
      observation,
      suggestedQuestions: ["你下次想确认什么新进展？"],
      reason: "这条提示只使用可回溯的来源。",
      evidenceIds: selectedEvidence.map((item) => item.evidenceId),
      confidence: distinctDateCount >= 3 ? 0.52 : 0.45,
      caution: "这只是局部线索，不能据此形成长期关系结论。"
    }
  });
  return framed.value;
}

function evidenceReferences(
  evidence: DateCompanionProactiveEvidence[],
  selectedEvidenceIds: string[]
) {
  const selected = new Set(selectedEvidenceIds);
  return evidence
    .filter((item) => selected.has(item.evidenceId))
    .map((item) => ({ ...item }));
}

function parseCachedValue(row: CacheRow, context: DateCompanionProactiveValueContext) {
  if (!row.payload_json) return null;
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    return validateCanonicalDateCompanionProactiveValue({ context, value: parsed }).value;
  } catch {
    return null;
  }
}

function cacheClaim(input: {
  database: Database.Database;
  accountId: string;
  context: DateCompanionProactiveValueContext;
  fingerprint: string;
  provider: string;
  model: string;
  now: string;
}) {
  const claimToken = randomUUID();
  const leaseExpiresAt = leaseExpiry(input.now);
  return input.database.transaction(() => {
    const inserted = input.database.prepare(`
      INSERT INTO dc_proactive_value_cache (
        id, user_id, scope, relationship_id, interaction_id, person_id,
        mapping_version, source_fingerprint, contract_version, provider, model,
        status, payload_json, failure_code, created_at, updated_at, completed_at,
        claim_token, lease_expires_at, attempt_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', NULL, NULL, ?, ?, NULL, ?, ?, 1)
      ON CONFLICT(user_id, source_fingerprint) DO NOTHING
    `).run(
      stableId("dc_proactive", input.accountId, input.fingerprint),
      input.accountId,
      input.context.scope,
      input.context.relationshipId,
      input.context.interactionId ?? null,
      input.context.personId ?? null,
      input.context.mappingVersion,
      input.fingerprint,
      DATE_COMPANION_PROACTIVE_VALUE_CONTRACT_VERSION,
      input.provider,
      input.model,
      input.now,
      input.now,
      claimToken,
      leaseExpiresAt
    );
    if (inserted.changes === 1) {
      const row = cacheRow(input);
      if (!row) throw new Error("proactive_value_claim_missing");
      return { claimed: true, claimToken, row };
    }

    const existing = cacheRow(input);
    if (!existing) throw new Error("proactive_value_cache_missing");
    if (
      existing.status === "processing"
      && (!existing.lease_expires_at || existing.lease_expires_at <= input.now)
    ) {
      const takenOver = input.database.prepare(`
        UPDATE dc_proactive_value_cache
        SET claim_token = ?, lease_expires_at = ?, attempt_count = attempt_count + 1,
            failure_code = NULL, updated_at = ?
        WHERE user_id = ? AND source_fingerprint = ? AND status = 'processing'
          AND claim_token IS ? AND lease_expires_at IS ?
      `).run(
        claimToken,
        leaseExpiresAt,
        input.now,
        input.accountId,
        input.fingerprint,
        existing.claim_token,
        existing.lease_expires_at
      );
      if (takenOver.changes === 1) {
        const row = cacheRow(input);
        if (!row) throw new Error("proactive_value_takeover_missing");
        return { claimed: true, claimToken, row };
      }
    }
    const row = cacheRow(input);
    if (!row) throw new Error("proactive_value_cache_missing");
    return { claimed: false, claimToken: null, row };
  })();
}

function completeCache(input: {
  database: Database.Database;
  accountId: string;
  fingerprint: string;
  status: "generated" | "fallback";
  value: DateCompanionProactiveValue;
  failureCode?: string;
  now: string;
  claimToken: string;
}) {
  return input.database.prepare(`
    UPDATE dc_proactive_value_cache
    SET status = ?, payload_json = ?, failure_code = ?, updated_at = ?, completed_at = ?,
        claim_token = NULL, lease_expires_at = NULL
    WHERE user_id = ? AND source_fingerprint = ? AND status = 'processing'
      AND claim_token = ?
  `).run(
    input.status,
    JSON.stringify(input.value),
    input.failureCode ?? null,
    input.now,
    input.now,
    input.accountId,
    input.fingerprint,
    input.claimToken
  );
}

function repairInvalidCache(input: {
  database: Database.Database;
  accountId: string;
  fingerprint: string;
  value: DateCompanionProactiveValue;
  failureCode: string;
  now: string;
}) {
  input.database.prepare(`
    UPDATE dc_proactive_value_cache
    SET status = 'fallback', payload_json = ?, failure_code = ?, updated_at = ?, completed_at = ?
    WHERE user_id = ? AND source_fingerprint = ? AND status IN ('generated', 'fallback')
  `).run(
    JSON.stringify(input.value),
    input.failureCode,
    input.now,
    input.now,
    input.accountId,
    input.fingerprint
  );
}

function clearProcessingCache(input: {
  database: Database.Database;
  accountId: string;
  fingerprint: string;
  claimToken: string;
}) {
  return input.database.prepare(`
    DELETE FROM dc_proactive_value_cache
    WHERE user_id = ? AND source_fingerprint = ? AND status = 'processing'
      AND claim_token = ?
  `).run(input.accountId, input.fingerprint, input.claimToken);
}

function response(input: {
  context: DateCompanionProactiveValueContext;
  status: "ready" | "fallback";
  fingerprint: string;
  cacheHit: boolean;
  value: DateCompanionProactiveValue;
  failureCode?: string;
}): DateCompanionProactiveValueResponse {
  return DateCompanionProactiveValueResponseSchema.parse({
    schemaVersion: DATE_COMPANION_PROACTIVE_VALUE_RESPONSE_VERSION,
    scope: input.context.scope,
    relationshipId: input.context.relationshipId,
    ...(input.context.interactionId ? { interactionId: input.context.interactionId } : {}),
    ...(input.context.personId ? { personId: input.context.personId } : {}),
    mappingVersion: input.context.mappingVersion,
    status: input.status,
    sourceFingerprint: input.fingerprint,
    cacheHit: input.cacheHit,
    value: input.value,
    evidenceReferences: evidenceReferences(input.context.evidence, input.value.evidenceIds),
    ...(input.failureCode ? { failureCode: input.failureCode } : {})
  });
}

function unavailableResponse(input: {
  scope: "current_interaction" | "person_relationship";
  relationshipId: string;
  interactionId?: string;
  personId?: string;
  mappingVersion?: number | null;
  failureCode: string;
}): DateCompanionProactiveValueResponse {
  return DateCompanionProactiveValueResponseSchema.parse({
    schemaVersion: DATE_COMPANION_PROACTIVE_VALUE_RESPONSE_VERSION,
    scope: input.scope,
    relationshipId: input.relationshipId,
    ...(input.interactionId ? { interactionId: input.interactionId } : {}),
    ...(input.personId ? { personId: input.personId } : {}),
    mappingVersion: input.mappingVersion ?? null,
    status: "unavailable",
    cacheHit: false,
    evidenceReferences: [],
    failureCode: input.failureCode
  });
}

function processingResponse(input: {
  context: DateCompanionProactiveValueContext;
}): DateCompanionProactiveValueResponse {
  return DateCompanionProactiveValueResponseSchema.parse({
    schemaVersion: DATE_COMPANION_PROACTIVE_VALUE_RESPONSE_VERSION,
    scope: input.context.scope,
    relationshipId: input.context.relationshipId,
    ...(input.context.interactionId ? { interactionId: input.context.interactionId } : {}),
    ...(input.context.personId ? { personId: input.context.personId } : {}),
    mappingVersion: input.context.mappingVersion,
    status: "processing",
    cacheHit: true,
    evidenceReferences: [],
    failureCode: "generation_in_progress"
  });
}

export function createDateCompanionProactiveValueService(input: {
  dateCompanionDatabase: Database.Database;
  memoryDatabase: Database.Database;
  provider?: DateCompanionProactiveValueProvider;
  now?: () => string;
  currentContextBuilder?: typeof buildCurrentInteractionProactiveValueContext;
  relationshipContextBuilder?: typeof buildPersonRelationshipProactiveValueContext;
}) {
  const provider = input.provider ?? createDateCompanionProactiveValueProvider();
  const now = input.now ?? (() => new Date().toISOString());
  const currentContextBuilder = input.currentContextBuilder
    ?? buildCurrentInteractionProactiveValueContext;
  const relationshipContextBuilder = input.relationshipContextBuilder
    ?? buildPersonRelationshipProactiveValueContext;

  async function generate(accountId: string, context: DateCompanionProactiveValueContext) {
    const fingerprint = dateCompanionProactiveValueFingerprint({
      accountId,
      context,
      provider: provider.provider,
      model: provider.model
    });
    const claim = cacheClaim({
      database: input.dateCompanionDatabase,
      accountId,
      context,
      fingerprint,
      provider: provider.provider,
      model: provider.model,
      now: now()
    });
    if (!claim.claimed) {
      if (claim.row.status === "processing") {
        return processingResponse({ context });
      }
      const cached = parseCachedValue(claim.row, context);
      if (cached) {
        return response({
          context,
          status: claim.row.status === "generated" ? "ready" : "fallback",
          fingerprint,
          cacheHit: true,
          value: cached,
          ...(claim.row.failure_code ? { failureCode: claim.row.failure_code } : {})
        });
      }
      const fallback = ruleFallback(context);
      if (!fallback) {
        input.dateCompanionDatabase.prepare(`
          DELETE FROM dc_proactive_value_cache
          WHERE user_id = ? AND source_fingerprint = ? AND status IN ('generated', 'fallback')
        `).run(accountId, fingerprint);
        return unavailableResponse({
          scope: context.scope,
          relationshipId: context.relationshipId,
          ...(context.interactionId ? { interactionId: context.interactionId } : {}),
          ...(context.personId ? { personId: context.personId } : {}),
          mappingVersion: context.mappingVersion,
          failureCode: "fallback_invalid"
        });
      }
      const failureCode = "cache_invalid";
      repairInvalidCache({
        database: input.dateCompanionDatabase,
        accountId,
        fingerprint,
        value: fallback,
        failureCode,
        now: now()
      });
      return response({
        context,
        status: "fallback",
        fingerprint,
        cacheHit: true,
        value: fallback,
        failureCode
      });
    }

    if (!claim.claimToken) throw new Error("proactive_value_claim_token_missing");

    const run = await provider.generate({ context, sourceFingerprint: fingerprint });
    const value = run.value ?? ruleFallback(context);
    if (!value) {
      const cleared = clearProcessingCache({
        database: input.dateCompanionDatabase,
        accountId,
        fingerprint,
        claimToken: claim.claimToken
      });
      if (cleared.changes === 0) {
        const latest = cacheRow({ database: input.dateCompanionDatabase, accountId, fingerprint });
        if (latest?.status === "processing") return processingResponse({ context });
        const cached = latest ? parseCachedValue(latest, context) : null;
        if (latest && cached) {
          return response({
            context,
            status: latest.status === "generated" ? "ready" : "fallback",
            fingerprint,
            cacheHit: true,
            value: cached,
            ...(latest.failure_code ? { failureCode: latest.failure_code } : {})
          });
        }
      }
      return unavailableResponse({
        scope: context.scope,
        relationshipId: context.relationshipId,
        ...(context.interactionId ? { interactionId: context.interactionId } : {}),
        ...(context.personId ? { personId: context.personId } : {}),
        mappingVersion: context.mappingVersion,
        failureCode: "fallback_invalid"
      });
    }
    const status = run.value ? "generated" as const : "fallback" as const;
    const completed = completeCache({
      database: input.dateCompanionDatabase,
      accountId,
      fingerprint,
      status,
      value,
      ...(run.failureCode ? { failureCode: run.failureCode } : {}),
      now: now(),
      claimToken: claim.claimToken
    });
    if (completed.changes === 0) {
      const latest = cacheRow({ database: input.dateCompanionDatabase, accountId, fingerprint });
      if (latest?.status === "processing") return processingResponse({ context });
      const cached = latest ? parseCachedValue(latest, context) : null;
      if (latest && cached) {
        return response({
          context,
          status: latest.status === "generated" ? "ready" : "fallback",
          fingerprint,
          cacheHit: true,
          value: cached,
          ...(latest.failure_code ? { failureCode: latest.failure_code } : {})
        });
      }
      return unavailableResponse({
        scope: context.scope,
        relationshipId: context.relationshipId,
        ...(context.interactionId ? { interactionId: context.interactionId } : {}),
        ...(context.personId ? { personId: context.personId } : {}),
        mappingVersion: context.mappingVersion,
        failureCode: "claim_lost"
      });
    }
    return response({
      context,
      status: run.value ? "ready" : "fallback",
      fingerprint,
      cacheHit: false,
      value,
      ...(run.failureCode ? { failureCode: run.failureCode } : {})
    });
  }

  async function getCurrentInteraction(inputValue: { accountId: string; interactionId: string }) {
    const owned = input.dateCompanionDatabase.prepare(`
      SELECT relationship_id FROM dc_interactions WHERE user_id = ? AND id = ?
    `).get(inputValue.accountId, inputValue.interactionId) as { relationship_id: string } | undefined;
    const resolution = currentContextBuilder({
      dateCompanionDatabase: input.dateCompanionDatabase,
      memoryDatabase: input.memoryDatabase,
      ...inputValue
    });
    if (!resolution.context) {
      return unavailableResponse({
        scope: "current_interaction",
        relationshipId: owned!.relationship_id,
        interactionId: inputValue.interactionId,
        failureCode: resolution.status
      });
    }
    const generated = await generate(inputValue.accountId, resolution.context);
    if (generated.status === "processing" || generated.status === "unavailable") return generated;
    try {
      const latest = currentContextBuilder({
        dateCompanionDatabase: input.dateCompanionDatabase,
        memoryDatabase: input.memoryDatabase,
        ...inputValue
      });
      const latestFingerprint = latest.context
        ? dateCompanionProactiveValueFingerprint({
            accountId: inputValue.accountId,
            context: latest.context,
            provider: provider.provider,
            model: provider.model
          })
        : null;
      if (!latest.context || latestFingerprint !== generated.sourceFingerprint) {
        return unavailableResponse({
          scope: "current_interaction",
          relationshipId: owned!.relationship_id,
          interactionId: inputValue.interactionId,
          failureCode: "source_changed"
        });
      }
    } catch {
      return unavailableResponse({
        scope: "current_interaction",
        relationshipId: owned!.relationship_id,
        interactionId: inputValue.interactionId,
        failureCode: "source_changed"
      });
    }
    return generated;
  }

  async function getPersonRelationship(inputValue: { accountId: string; relationshipId: string }) {
    const resolution = relationshipContextBuilder({
      dateCompanionDatabase: input.dateCompanionDatabase,
      memoryDatabase: input.memoryDatabase,
      ...inputValue
    });
    if (!resolution.context) {
      return unavailableResponse({
        scope: "person_relationship",
        relationshipId: inputValue.relationshipId,
        failureCode: resolution.status
      });
    }
    const generated = await generate(inputValue.accountId, resolution.context);
    if (generated.status === "processing" || generated.status === "unavailable") return generated;
    try {
      const latest = relationshipContextBuilder({
        dateCompanionDatabase: input.dateCompanionDatabase,
        memoryDatabase: input.memoryDatabase,
        ...inputValue
      });
      const latestFingerprint = latest.context
        ? dateCompanionProactiveValueFingerprint({
            accountId: inputValue.accountId,
            context: latest.context,
            provider: provider.provider,
            model: provider.model
          })
        : null;
      if (!latest.context || latestFingerprint !== generated.sourceFingerprint) {
        return unavailableResponse({
          scope: "person_relationship",
          relationshipId: inputValue.relationshipId,
          failureCode: "source_changed"
        });
      }
    } catch {
      return unavailableResponse({
        scope: "person_relationship",
        relationshipId: inputValue.relationshipId,
        failureCode: "source_changed"
      });
    }
    return generated;
  }

  return { getCurrentInteraction, getPersonRelationship };
}

export function getDateCompanionProactiveValueService() {
  return createDateCompanionProactiveValueService({
    dateCompanionDatabase: getDateCompanionDatabase(),
    memoryDatabase: getMemoryDatabase()
  });
}
