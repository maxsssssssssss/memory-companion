import { createHash } from "node:crypto";
import { z } from "zod";

import {
  CandidateKindV2Schema,
  PendingCandidateV2InputSchema,
  ProcessingPlanV2Schema,
  type DailyReflectionV2Input,
  type PendingCandidateV2Input
} from "@/lib/domain/daily-reflection";
import { TranscriptSegmentSchema, type TranscriptSegment } from "@/lib/domain/types";
import { createOpenAIClient } from "@/lib/server/openai/client";
import { parseStructuredJsonResponse } from "@/lib/server/openai/structured-json";
import { getOpenAIClientRuntimeConfig } from "@/lib/server/settings/provider-config";

export const DailyReflectionCandidateProviderItemSchema = z.object({
  candidateKind: CandidateKindV2Schema,
  proposedText: z.string().trim().min(1).max(20_000),
  evidenceIds: z.array(z.string().trim().min(1).max(512)).min(1).max(64),
  confidence: z.number().min(0).max(1),
  caution: z.string().trim().min(1).max(4_000),
  actionClaimed: z.boolean()
}).strict().superRefine((candidate, context) => {
  if (candidate.candidateKind !== "user_action" && candidate.actionClaimed) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["actionClaimed"],
      message: "only user_action candidates may claim an action"
    });
  }
});

export const DailyReflectionCandidateProviderResponseSchema = z.object({
  items: z.array(DailyReflectionCandidateProviderItemSchema).min(1).max(32)
}).strict();

export type DailyReflectionCandidateProviderInput = {
  accountId: string;
  reflectionId: string;
  input: DailyReflectionV2Input;
  processingPlan: z.infer<typeof ProcessingPlanV2Schema>;
  segments: TranscriptSegment[];
  signal?: AbortSignal;
};

export interface DailyReflectionCandidateProvider {
  readonly providerName: string;
  generate(
    input: DailyReflectionCandidateProviderInput
  ): Promise<z.infer<typeof DailyReflectionCandidateProviderResponseSchema>>;
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

  constructor(options?: ErrorOptions) {
    super("Daily Reflection Candidate Provider failed", options);
  }
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
    ...input.candidate
  })).digest("hex");
  return `daily_reflection_candidate_${digest}`;
}

export function validateDailyReflectionProviderCandidates(input: {
  accountId: string;
  reflectionId: string;
  segments: TranscriptSegment[];
  candidateLimit: number;
  response: unknown;
}): PendingCandidateV2Input[] {
  const segments = z.array(TranscriptSegmentSchema).min(1).parse(input.segments);
  const candidateLimit = z.number().int().min(1).max(7).parse(input.candidateLimit);
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
  if (selected.length === 0) {
    throw new DailyReflectionCandidateValidationError("candidates_missing");
  }
  return selected.map((candidate, ordinal) => {
    const pending = PendingCandidateV2InputSchema.parse({
      ordinal,
      candidateKind: candidate.candidateKind,
      proposedText: candidate.proposedText,
      evidenceIds: candidate.evidenceIds,
      confidence: candidate.confidence,
      caution: candidate.caution,
      actionClaimed: candidate.actionClaimed
    });
    return {
      ...pending,
      id: candidateId({
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        candidate: {
          candidateKind: pending.candidateKind,
          proposedText: pending.proposedText,
          evidenceIds: pending.evidenceIds,
          confidence: pending.confidence,
          caution: pending.caution,
          actionClaimed: pending.actionClaimed
        }
      })
    };
  });
}

function transcriptPrompt(segments: TranscriptSegment[]) {
  return segments.map((segment) =>
    `[${segment.id}] ${segment.startSeconds}-${segment.endSeconds}s: ${segment.text}`
  ).join("\n");
}

function candidateModel() {
  return process.env.OPENAI_TEXT_MODEL?.trim() || "gpt-4.1-mini";
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
              "你是 Daily Reflection 结构化 Candidate 提取器。只根据整段 Canonical Transcript 提取 insight、open_question、decision、user_action。" +
              "每项必须引用给定 segment id；不得编造身份、事实或来源。只有说话者明确认领自己将采取的行动时，user_action.actionClaimed 才能为 true。" +
              "未认领的行动线索必须保持 actionClaimed=false。输出按重要性与可审阅性排序，短录音最多3项，长录音通常3到5项。"
          },
          {
            role: "user",
            content:
              `sourceOrigin=${input.input.sourceOrigin}\n` +
              `capturePurpose=${input.input.capturePurpose}\n` +
              `candidateLimit=${input.processingPlan.candidateLimit}\n` +
              transcriptPrompt(input.segments)
          }
        ],
        jsonInstruction:
          "输出 {items:[...]}。每项严格包含 candidateKind、proposedText、evidenceIds、confidence、caution、actionClaimed。",
        ...(input.signal ? { requestOptions: { signal: input.signal } } : {})
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      throw new DailyReflectionCandidateProviderFailedError({ cause: error });
    }
  }
};
