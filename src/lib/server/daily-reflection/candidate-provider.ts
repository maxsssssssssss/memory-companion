import { createHash } from "node:crypto";
import { z } from "zod";

import {
  CandidateKindV2Schema,
  PendingReflectionCardInputSchema,
  PendingCandidateV2InputSchema,
  ProcessingPlanV2Schema,
  type DailyReflectionV2Input,
  type PendingReflectionCardInput,
  type PendingCandidateV2Input
} from "@/lib/domain/daily-reflection";
import { TranscriptSegmentSchema, type TranscriptSegment } from "@/lib/domain/types";
import { createOpenAIClient } from "@/lib/server/openai/client";
import {
  parseStructuredJsonResponse,
  type StructuredJsonDiagnostics
} from "@/lib/server/openai/structured-json";
import { getOpenAIClientRuntimeConfig } from "@/lib/server/settings/provider-config";
import {
  dailyReflectionCardDisplayPlan,
  estimateDailyReflectionTokens,
  type DailyReflectionCardDisplayPlan,
  type DailyReflectionCardPipelinePolicy
} from "./card-pipeline-policy";

export const DailyReflectionCandidateProviderItemSchema = z.object({
  candidateKind: CandidateKindV2Schema,
  proposedText: z.string().trim().min(1).max(20_000),
  evidenceIds: z.array(z.string().trim().min(1).max(512)).min(1).max(64),
  confidence: z.number().min(0).max(1),
  caution: z.string().trim().min(1).max(4_000),
  actionClaimed: z.boolean().optional(),
  topicHint: z.string().trim().min(1).max(160).optional()
}).strict();

export const DailyReflectionCandidateProviderResponseSchema = z.object({
  items: z.array(DailyReflectionCandidateProviderItemSchema).max(32)
}).strict();

export type DailyReflectionCandidateProviderInput = {
  accountId: string;
  reflectionId: string;
  input: DailyReflectionV2Input;
  processingPlan: z.infer<typeof ProcessingPlanV2Schema>;
  segments: TranscriptSegment[];
  windowIndex?: number;
  windowCount?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  onDiagnostics?: (diagnostics: DailyReflectionCandidateProviderDiagnostics) => void;
};

export type DailyReflectionHiddenCandidate = PendingCandidateV2Input & {
  topicHint: string | null;
};

export interface DailyReflectionCandidateProvider {
  readonly providerName: string;
  generate(
    input: DailyReflectionCandidateProviderInput
  ): Promise<z.infer<typeof DailyReflectionCandidateProviderResponseSchema>>;
}

export const DailyReflectionCardOrganizerItemSchema = z.object({
  cardKind: CandidateKindV2Schema,
  proposedTitle: z.string().trim().min(1).max(240),
  proposedText: z.string().trim().min(1).max(20_000),
  sourceCandidateIds: z.array(z.string().trim().min(1).max(512)).min(1).max(64),
  clusterTitle: z.string().trim().min(1).max(240),
  confidence: z.number().min(0).max(1),
  importance: z.number().min(0).max(1),
  durability: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  epistemicStatus: z.enum([
    "explicit_user_statement",
    "reported_event",
    "ai_inference",
    "unknown"
  ]),
  riskFlags: z.array(z.enum([
    "ai_inference",
    "attribution_uncertain",
    "low_evidence",
    "sensitive"
  ])).max(8),
  actionClaimed: z.boolean().optional()
}).strict();

export const DailyReflectionCardOrganizerResponseSchema = z.object({
  items: z.array(DailyReflectionCardOrganizerItemSchema).min(1).max(32)
}).strict();

export type DailyReflectionCardOrganizerInput = {
  accountId: string;
  reflectionId: string;
  input: DailyReflectionV2Input;
  processingPlan: z.infer<typeof ProcessingPlanV2Schema>;
  candidates: DailyReflectionHiddenCandidate[];
  evidenceSnippets: Record<string, string>;
  displayPlan: DailyReflectionCardDisplayPlan;
  maxOutputTokens: number;
  signal?: AbortSignal;
  onDiagnostics?: (diagnostics: DailyReflectionCandidateProviderDiagnostics) => void;
};

export interface DailyReflectionCardOrganizerProvider {
  readonly providerName: string;
  organize(
    input: DailyReflectionCardOrganizerInput
  ): Promise<z.infer<typeof DailyReflectionCardOrganizerResponseSchema>>;
}

export class DailyReflectionCandidateProviderUnavailableError extends Error {
  readonly name = "DailyReflectionCandidateProviderUnavailableError";
  readonly code = "daily_reflection_candidate_provider_unavailable";

  constructor(options?: ErrorOptions) {
    super("Daily Reflection Candidate Provider is unavailable", options);
  }
}

export class DailyReflectionCandidateProviderFailedError extends Error {
  readonly name = "DailyReflectionCandidateProviderFailedError";
  readonly code = "daily_reflection_candidate_provider_failed";
  readonly diagnostics: DailyReflectionCandidateProviderDiagnostics | null;

  constructor(options?: {
    cause?: unknown;
    diagnostics?: DailyReflectionCandidateProviderDiagnostics | null;
  }) {
    super(
      "Daily Reflection Candidate Provider failed",
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
    this.diagnostics = options?.diagnostics ?? null;
  }
}

export type DailyReflectionCandidateProviderDiagnostics = {
  responseStatus?: string;
  incompleteReason?: string;
  responseTextLength: number;
  parseResult: StructuredJsonDiagnostics["parseResult"];
  validationResult: StructuredJsonDiagnostics["validationResult"];
  responseCompleteDurationMs?: number;
  parseDurationMs?: number;
  validationDurationMs?: number;
  totalDurationMs?: number;
  validationIssueCount?: number;
  validationIssues?: Array<{ path: string; code: string }>;
  validationIssueSummary?: Array<{ code: string; count: number }>;
  validationIssuesTruncated?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

const SAFE_RESPONSE_STATUSES = new Set([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "queued",
  "in_progress"
]);
const SAFE_INCOMPLETE_REASONS = new Set(["max_output_tokens", "content_filter"]);

function safeDiagnosticLabel(value: string | undefined, allowed: Set<string>) {
  if (value === undefined) return undefined;
  return allowed.has(value) ? value : "other";
}

function safeDiagnosticNumber(value: number | undefined) {
  return value === undefined || !Number.isFinite(value)
    ? undefined
    : Math.max(0, Math.round(value));
}

function safeValidationCode(value: string) {
  return /^[a-z_]{1,64}$/u.test(value) ? value : "schema_validation_error";
}

function safeValidationPath(value: string) {
  return value.replace(/[^A-Za-z0-9_.\[\]-]/gu, "_").slice(0, 240) || "$";
}

export function safeDailyReflectionProviderDiagnostics(
  diagnostics: StructuredJsonDiagnostics | undefined
): DailyReflectionCandidateProviderDiagnostics | null {
  if (!diagnostics) return null;

  return {
    ...(diagnostics.responseStatus === undefined
      ? {}
      : { responseStatus: safeDiagnosticLabel(diagnostics.responseStatus, SAFE_RESPONSE_STATUSES) }),
    ...(diagnostics.incompleteReason === undefined
      ? {}
      : {
          incompleteReason: safeDiagnosticLabel(
            diagnostics.incompleteReason,
            SAFE_INCOMPLETE_REASONS
          )
        }),
    responseTextLength: safeDiagnosticNumber(diagnostics.responseTextLength) ?? 0,
    parseResult: diagnostics.parseResult,
    validationResult: diagnostics.validationResult,
    ...(safeDiagnosticNumber(diagnostics.responseCompleteDurationMs) === undefined
      ? {}
      : { responseCompleteDurationMs: safeDiagnosticNumber(diagnostics.responseCompleteDurationMs) }),
    ...(safeDiagnosticNumber(diagnostics.parseDurationMs) === undefined
      ? {}
      : { parseDurationMs: safeDiagnosticNumber(diagnostics.parseDurationMs) }),
    ...(safeDiagnosticNumber(diagnostics.validationDurationMs) === undefined
      ? {}
      : { validationDurationMs: safeDiagnosticNumber(diagnostics.validationDurationMs) }),
    ...(safeDiagnosticNumber(diagnostics.totalDurationMs) === undefined
      ? {}
      : { totalDurationMs: safeDiagnosticNumber(diagnostics.totalDurationMs) }),
    ...(safeDiagnosticNumber(diagnostics.validationIssueCount) === undefined
      ? {}
      : { validationIssueCount: safeDiagnosticNumber(diagnostics.validationIssueCount) }),
    ...(diagnostics.validationIssues
      ? {
          validationIssues: diagnostics.validationIssues.slice(0, 10).map((issue) => ({
            path: safeValidationPath(issue.path),
            code: safeValidationCode(issue.code)
          }))
        }
      : {}),
    ...(diagnostics.validationIssueSummary
      ? {
          validationIssueSummary: diagnostics.validationIssueSummary.slice(0, 10).map((issue) => ({
            code: safeValidationCode(issue.code),
            count: safeDiagnosticNumber(issue.count) ?? 0
          }))
        }
      : {}),
    ...(diagnostics.validationIssuesTruncated === undefined
      ? {}
      : { validationIssuesTruncated: diagnostics.validationIssuesTruncated }),
    ...(safeDiagnosticNumber(diagnostics.inputTokens) === undefined
      ? {}
      : { inputTokens: safeDiagnosticNumber(diagnostics.inputTokens) }),
    ...(safeDiagnosticNumber(diagnostics.outputTokens) === undefined
      ? {}
      : { outputTokens: safeDiagnosticNumber(diagnostics.outputTokens) }),
    ...(safeDiagnosticNumber(diagnostics.totalTokens) === undefined
      ? {}
      : { totalTokens: safeDiagnosticNumber(diagnostics.totalTokens) })
  };
}

function captureDailyReflectionProviderDiagnostics(
  diagnostics: StructuredJsonDiagnostics,
  observer: ((diagnostics: DailyReflectionCandidateProviderDiagnostics) => void) | undefined
) {
  const safe = safeDailyReflectionProviderDiagnostics(diagnostics);
  if (!safe || !observer) return;
  try {
    observer(safe);
  } catch {
    console.warn("[daily-reflection-provider] diagnostics_observer_failed");
  }
}

function reportDailyReflectionProviderFailure(
  stage: "extraction" | "organization",
  diagnostics: DailyReflectionCandidateProviderDiagnostics | null
) {
  if (!diagnostics) return;
  console.warn("[daily-reflection-provider] structured_json_failed", {
    stage,
    diagnostics
  });
}

export class DailyReflectionCandidateValidationError extends Error {
  readonly name = "DailyReflectionCandidateValidationError";
  readonly code = "daily_reflection_candidate_validation_failed";

  constructor(readonly reason: string) {
    super("Daily Reflection Candidate Provider output failed validation");
  }
}

function normalizedCandidateText(value: string) {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
}

function candidateId(input: {
  accountId: string;
  reflectionId: string;
  candidate: Omit<PendingCandidateV2Input, "id" | "ordinal">;
}) {
  const digest = createHash("sha256").update(JSON.stringify({
    version: 2,
    accountId: input.accountId,
    reflectionId: input.reflectionId,
    candidateKind: input.candidate.candidateKind,
    proposedText: normalizedCandidateText(input.candidate.proposedText),
    evidenceIds: input.candidate.evidenceIds
  })).digest("hex");
  return `daily_reflection_candidate_${digest}`;
}

export function validateDailyReflectionProviderCandidates(input: {
  accountId: string;
  reflectionId: string;
  segments: TranscriptSegment[];
  candidateLimit: number;
  response: unknown;
}): DailyReflectionHiddenCandidate[] {
  const segments = z.array(TranscriptSegmentSchema).min(1).parse(input.segments);
  const candidateLimit = z.number().int().min(1).max(64).parse(input.candidateLimit);
  const response = DailyReflectionCandidateProviderResponseSchema.safeParse(input.response);
  if (!response.success) {
    throw new DailyReflectionCandidateValidationError("provider_schema_invalid");
  }
  const evidenceOrder = new Map(segments.map((segment, index) => [segment.id, index]));
  const normalized = response.data.items.map((candidate) => {
    const evidenceIds = [...new Set(candidate.evidenceIds)].sort(
      (left, right) => (evidenceOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
        - (evidenceOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
    );
    if (
      evidenceIds.length === 0
      || evidenceIds.some((evidenceId) => !evidenceOrder.has(evidenceId))
    ) {
      throw new DailyReflectionCandidateValidationError("canonical_evidence_missing");
    }
    return {
      ...candidate,
      proposedText: candidate.proposedText.trim().replace(/\s+/gu, " "),
      caution: candidate.caution.trim().replace(/\s+/gu, " "),
      evidenceIds,
      firstEvidenceOrder: evidenceOrder.get(evidenceIds[0])!
    };
  }).sort((left, right) =>
    right.confidence - left.confidence
    || left.firstEvidenceOrder - right.firstEvidenceOrder
    || left.candidateKind.localeCompare(right.candidateKind)
    || left.proposedText.localeCompare(right.proposedText, "zh-CN")
  );

  const seen = new Set<string>();
  const selected = normalized.filter((candidate) => {
    const key = `${candidate.candidateKind}\u0000${normalizedCandidateText(candidate.proposedText)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, candidateLimit);
  return selected.map((candidate, ordinal) => {
    const pending = PendingCandidateV2InputSchema.parse({
      ordinal,
      candidateKind: candidate.candidateKind,
      proposedText: candidate.proposedText,
      evidenceIds: candidate.evidenceIds,
      confidence: candidate.confidence,
      caution: candidate.caution,
      // Provider output is never identity or intent proof. Only an explicit
      // user update may claim an action after extraction.
      actionClaimed: false
    });
    return {
      ...pending,
      topicHint: candidate.topicHint ?? null,
      id: candidateId({
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        candidate: {
          candidateKind: pending.candidateKind,
          proposedText: pending.proposedText,
          evidenceIds: pending.evidenceIds,
          confidence: pending.confidence,
          caution: pending.caution,
          actionClaimed: false
        }
      })
    };
  });
}

function stableId(prefix: string, value: unknown) {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function organizerScore(item: z.infer<typeof DailyReflectionCardOrganizerItemSchema>) {
  return item.importance * 0.45
    + item.durability * 0.25
    + item.novelty * 0.15
    + item.confidence * 0.15;
}

export function validateDailyReflectionOrganizedCards(input: {
  accountId: string;
  reflectionId: string;
  effectiveDurationMs: number;
  policy: DailyReflectionCardPipelinePolicy;
  candidates: DailyReflectionHiddenCandidate[];
  response: unknown;
}): PendingReflectionCardInput[] {
  const response = DailyReflectionCardOrganizerResponseSchema.safeParse(input.response);
  if (!response.success) {
    throw new DailyReflectionCandidateValidationError("organizer_schema_invalid");
  }
  const candidateById = new Map(input.candidates.map((candidate) => [candidate.id!, candidate]));
  if (candidateById.size !== input.candidates.length) {
    throw new DailyReflectionCandidateValidationError("candidate_identity_ambiguous");
  }
  const candidateOrder = new Map(
    input.candidates.map((candidate, index) => [candidate.id!, index] as const)
  );

  const normalized = response.data.items.map((item) => {
    const sourceCandidateIds = [...new Set(item.sourceCandidateIds)].sort(
      (left, right) => (candidateOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
        - (candidateOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
    );
    if (
      sourceCandidateIds.length === 0
      || sourceCandidateIds.some((candidateId) => !candidateById.has(candidateId))
    ) {
      throw new DailyReflectionCandidateValidationError("organizer_candidate_missing");
    }
    const sourceCandidates = sourceCandidateIds.map((candidateId) => candidateById.get(candidateId)!);
    const evidenceIds = [...new Set(sourceCandidates.flatMap((candidate) => candidate.evidenceIds))];
    if (evidenceIds.length === 0) {
      throw new DailyReflectionCandidateValidationError("organizer_evidence_missing");
    }
    const cardKind = sourceCandidates.some((candidate) => candidate.candidateKind === item.cardKind)
      ? item.cardKind
      : sourceCandidates[0].candidateKind;
    const clusterTitle = item.clusterTitle.trim().replace(/\s+/gu, " ");
    const clusterId = stableId("daily_reflection_cluster", {
      accountId: input.accountId,
      reflectionId: input.reflectionId,
      clusterTitle: normalizedCandidateText(clusterTitle)
    });
    const riskFlags = [...new Set([
      ...item.riskFlags,
      ...(item.epistemicStatus === "ai_inference" ? ["ai_inference" as const] : [])
    ])].sort();
    return {
      ...item,
      cardKind,
      proposedTitle: item.proposedTitle.trim().replace(/\s+/gu, " "),
      proposedText: item.proposedText.trim().replace(/\s+/gu, " "),
      sourceCandidateIds,
      evidenceIds,
      clusterId,
      clusterTitle,
      riskFlags,
      actionClaimed: false,
      score: organizerScore(item),
      firstCandidateOrder: Math.min(...sourceCandidateIds.map((id) => candidateOrder.get(id)!))
    };
  }).sort((left, right) =>
    right.score - left.score
    || left.firstCandidateOrder - right.firstCandidateOrder
    || left.clusterId.localeCompare(right.clusterId)
    || left.proposedText.localeCompare(right.proposedText, "zh-CN")
  );

  const seenText = new Set<string>();
  const deduplicated = normalized.filter((item) => {
    const key = `${item.cardKind}\u0000${normalizedCandidateText(item.proposedText)}`;
    if (seenText.has(key)) return false;
    seenText.add(key);
    return true;
  });
  const plan = dailyReflectionCardDisplayPlan(input.effectiveDurationMs, input.policy);
  const byCluster = new Map<string, typeof deduplicated>();
  for (const item of deduplicated) {
    const group = byCluster.get(item.clusterId) ?? [];
    group.push(item);
    byCluster.set(item.clusterId, group);
  }
  const roundRobin: typeof deduplicated = [];
  const allClusterIds = [...byCluster.keys()];
  const clusterIds = plan.maxClusters === null
    ? allClusterIds
    : allClusterIds.slice(0, plan.maxClusters);
  for (let depth = 0; roundRobin.length < plan.maxCards; depth += 1) {
    if (plan.maxCardsPerCluster !== null && depth >= plan.maxCardsPerCluster) break;
    let added = false;
    for (const clusterId of clusterIds) {
      const item = byCluster.get(clusterId)?.[depth];
      if (!item) continue;
      roundRobin.push(item);
      added = true;
      if (roundRobin.length >= plan.maxCards) break;
    }
    if (!added) break;
  }
  if (roundRobin.length === 0) {
    throw new DailyReflectionCandidateValidationError("cards_missing");
  }

  return roundRobin.map((item, rank) => PendingReflectionCardInputSchema.parse({
    id: stableId("daily_reflection_card", {
      accountId: input.accountId,
      reflectionId: input.reflectionId,
      sourceCandidateIds: item.sourceCandidateIds,
      cardKind: item.cardKind,
      proposedText: normalizedCandidateText(item.proposedText)
    }),
    cardKind: item.cardKind,
    proposedTitle: item.proposedTitle,
    proposedText: item.proposedText,
    sourceCandidateIds: item.sourceCandidateIds,
    evidenceIds: item.evidenceIds,
    clusterId: item.clusterId,
    clusterTitle: item.clusterTitle,
    displayTier: rank < Math.min(plan.primaryCount, roundRobin.length) ? "primary" : "more",
    rank,
    confidence: item.confidence,
    importance: item.importance,
    durability: item.durability,
    novelty: item.novelty,
    epistemicStatus: item.epistemicStatus,
    riskFlags: item.riskFlags,
    actionClaimed: false,
    reviewStatus: rank < Math.min(plan.primaryCount, roundRobin.length)
      ? "pending"
      : "not_proposed"
  }));
}

function transcriptPrompt(segments: TranscriptSegment[]) {
  return segments.map((segment) =>
    `[${segment.id}] ${segment.startSeconds}-${segment.endSeconds}s: ${segment.text}`
  ).join("\n");
}

function candidateModel() {
  return process.env.OPENAI_TEXT_MODEL?.trim() || "gpt-4.1-mini";
}

export const DAILY_REFLECTION_CANDIDATE_JSON_INSTRUCTION =
  "输出严格的 {items:[...]} JSON 对象。" +
  "candidateKind 只能是 insight、open_question、decision、user_action；" +
  "每项必须包含 proposedText、evidenceIds、confidence、caution，actionClaimed 与 topicHint 可省略。" +
  "evidenceIds 只能使用输入中的 segment id；confidence 必须是 0 到 1 的数字。";

export const DAILY_REFLECTION_CARD_ORGANIZER_JSON_INSTRUCTION =
  "输出严格的 {items:[...]} JSON 对象。" +
  "每项必须包含 cardKind、proposedTitle、proposedText、sourceCandidateIds、clusterTitle、" +
  "confidence、importance、durability、novelty、epistemicStatus、riskFlags；actionClaimed 可省略。" +
  "cardKind 只能是 insight、open_question、decision、user_action；" +
  "epistemicStatus 只能是 explicit_user_statement、reported_event、ai_inference、unknown；" +
  "riskFlags 只能包含 ai_inference、attribution_uncertain、low_evidence、sensitive；" +
  "sourceCandidateIds 只能使用输入 Candidate id，所有分数字段必须是 0 到 1 的数字。";

export function dailyReflectionCandidateModelName() {
  return candidateModel();
}

export const structuredDailyReflectionCandidateProvider: DailyReflectionCandidateProvider = {
  providerName: "openai-compatible-structured-json",
  async generate(input) {
    let client;
    try {
      client = createOpenAIClient(await getOpenAIClientRuntimeConfig());
    } catch (error) {
      throw new DailyReflectionCandidateProviderUnavailableError({ cause: error });
    }
    let structuredDiagnostics: StructuredJsonDiagnostics | undefined;
    try {
      return await parseStructuredJsonResponse({
        client,
        model: candidateModel(),
        name: "daily_reflection_candidate_v2",
        schema: DailyReflectionCandidateProviderResponseSchema,
        mode: "json",
        requestInput: [
          {
            role: "system",
            content:
              "你是 Daily Reflection 结构化提取器。只根据当前 Canonical Transcript 窗口提取 insight、open_question、decision、user_action。" +
              "每项必须引用给定 segment id；不得编造身份、事实或来源。只有说话者明确认领自己将采取的行动时，user_action.actionClaimed 才能为 true。" +
              "未认领的行动线索必须保持 actionClaimed=false。topicHint 只用于跨窗口整理，不是新事实。输出按重要性与可审阅性排序。"
          },
          {
            role: "user",
            content:
              `sourceOrigin=${input.input.sourceOrigin}\n` +
              `capturePurpose=${input.input.capturePurpose}\n` +
              `window=${(input.windowIndex ?? 0) + 1}/${input.windowCount ?? 1}\n` +
              transcriptPrompt(input.segments)
          }
        ],
        jsonInstruction: DAILY_REFLECTION_CANDIDATE_JSON_INSTRUCTION,
        onDiagnostics: (diagnostics) => {
          structuredDiagnostics = diagnostics;
          captureDailyReflectionProviderDiagnostics(diagnostics, input.onDiagnostics);
        },
        ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
        ...(input.signal ? { requestOptions: { signal: input.signal } } : {})
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      const diagnostics = safeDailyReflectionProviderDiagnostics(structuredDiagnostics);
      reportDailyReflectionProviderFailure("extraction", diagnostics);
      throw new DailyReflectionCandidateProviderFailedError({ cause: error, diagnostics });
    }
  }
};

function compressedCandidatePayload(input: Pick<
  DailyReflectionCardOrganizerInput,
  "candidates" | "evidenceSnippets"
>) {
  return {
    candidates: input.candidates.map((candidate) => ({
      id: candidate.id,
      text: candidate.proposedText,
      kind: candidate.candidateKind,
      evidenceIds: candidate.evidenceIds,
      confidence: candidate.confidence,
      topicHint: candidate.topicHint
    })),
    evidenceSnippets: input.evidenceSnippets
  };
}

function compressedCandidatePrompt(input: DailyReflectionCardOrganizerInput) {
  return JSON.stringify(compressedCandidatePayload(input));
}

export function estimateDailyReflectionOrganizerInputTokens(input: Pick<
  DailyReflectionCardOrganizerInput,
  "candidates" | "evidenceSnippets"
>) {
  return estimateDailyReflectionTokens(JSON.stringify(compressedCandidatePayload(input)));
}

export const structuredDailyReflectionCardOrganizerProvider:
DailyReflectionCardOrganizerProvider = {
  providerName: "openai-compatible-card-organizer",
  async organize(input) {
    let client;
    try {
      client = createOpenAIClient(await getOpenAIClientRuntimeConfig());
    } catch (error) {
      throw new DailyReflectionCandidateProviderUnavailableError({ cause: error });
    }
    let structuredDiagnostics: StructuredJsonDiagnostics | undefined;
    try {
      return await parseStructuredJsonResponse({
        client,
        model: candidateModel(),
        name: "daily_reflection_card_organizer_v1",
        schema: DailyReflectionCardOrganizerResponseSchema,
        mode: "json",
        requestInput: [
          {
            role: "system",
            content:
              "你是 Daily Reflection Card 整理器。输入只有压缩后的 Hidden Candidates 和短 Evidence snippet，不能重读或扩写 Transcript。" +
              "跨窗口去重、聚类并合成少量可审核 Card。sourceCandidateIds 必须来自输入；不得引入新人物、事实或身份归属。" +
              "actionClaimed 不是你的权限，输出即使包含也不会被接受。普通 Card 不加风险；只有推断、归属不确定、证据弱或敏感时加对应 riskFlags。"
          },
          {
            role: "user",
            content:
              `sourceOrigin=${input.input.sourceOrigin}\n` +
              `durationMs=${input.processingPlan.effectiveDurationMs}\n` +
              `presentation=${input.displayPlan.presentation}\n` +
              `primaryTarget=${input.displayPlan.primaryCount}\n` +
              `maxCards=${input.displayPlan.maxCards}\n` +
              `maxClusters=${input.displayPlan.maxClusters ?? "unbounded"}\n` +
              `maxCardsPerCluster=${input.displayPlan.maxCardsPerCluster ?? "unbounded"}\n` +
              compressedCandidatePrompt(input)
          }
        ],
        jsonInstruction: DAILY_REFLECTION_CARD_ORGANIZER_JSON_INSTRUCTION,
        onDiagnostics: (diagnostics) => {
          structuredDiagnostics = diagnostics;
          captureDailyReflectionProviderDiagnostics(diagnostics, input.onDiagnostics);
        },
        maxOutputTokens: input.maxOutputTokens,
        ...(input.signal ? { requestOptions: { signal: input.signal } } : {})
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      const diagnostics = safeDailyReflectionProviderDiagnostics(structuredDiagnostics);
      reportDailyReflectionProviderFailure("organization", diagnostics);
      throw new DailyReflectionCandidateProviderFailedError({ cause: error, diagnostics });
    }
  }
};
