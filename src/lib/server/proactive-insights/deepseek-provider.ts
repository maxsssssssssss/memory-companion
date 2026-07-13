import OpenAI from "openai";
import { z } from "zod";

import type { ProactiveInsight, ProactiveInsightContext } from "@/lib/domain/proactive-insights";
import { parseJsonObjectFromModelText } from "@/lib/server/openai/structured-json";

import {
  summarizeProactiveInsightSchemaIssues,
  validateProactiveInsights,
  type ProactiveInsightRejectionReason
} from "./validator";
import type { ProactiveInsightMemoryContext } from "./memory-context";

import { createHash } from "node:crypto";

export type ProactiveInsightFailureCode =
  | "missing_api_key"
  | "invalid_base_url"
  | "invalid_model"
  | "empty_response"
  | "invalid_json"
  | "invalid_schema"
  | "api_error"
  | "timeout";

export type ProactiveInsightRunResult = {
  status: "generated" | "fallback" | "disabled";
  items: ProactiveInsight[];
  provider: "deepseek" | "none";
  model?: string;
  elapsedMs: number;
  failureCode?: ProactiveInsightFailureCode;
  sourceFingerprint: string;
};

type DeepseekClient = {
  chat: {
    completions: {
      create: (request: Record<string, unknown>) => Promise<{
        choices?: Array<{
          message?: {
            content?: string | null;
          };
        }>;
      }>;
    };
  };
};

type DeepseekClientConfig = {
  apiKey: string;
  baseURL: string;
  timeout: number;
  maxRetries: number;
};

type Logger = Pick<Console, "info" | "warn">;

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 0;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_800;
const DEFAULT_MAX_ITEMS = 3;
const allowedModels = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
const ModelResponseSchema = z.object({
  items: z.array(z.unknown())
});

function readStringEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readIntEnv(name: string, fallback: number) {
  const value = readStringEnv(name);
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeDeepseekBaseUrl(value: string | undefined) {
  const candidate = value?.trim();
  if (!candidate) {
    return DEFAULT_BASE_URL;
  }

  return candidate.replace(/\/+$/, "");
}

function isAllowedDeepseekBaseUrl(value: string) {
  return value === DEFAULT_BASE_URL;
}

function resolveTimeoutMs() {
  const rawValue = readStringEnv("PROACTIVE_INSIGHT_TIMEOUT_MS");
  if (!rawValue) {
    return DEFAULT_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.min(parsed, DEFAULT_TIMEOUT_MS);
}

function resolveMaxRetries() {
  const parsed = readIntEnv("PROACTIVE_INSIGHT_MAX_RETRIES", DEFAULT_MAX_RETRIES);
  return parsed === 0 ? 0 : DEFAULT_MAX_RETRIES;
}

function isTimeoutError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "APIUserAbortError" || error.name === "APIConnectionTimeoutError")
  );
}

function buildSourceFingerprint(
  context: ProactiveInsightContext,
  memoryContext?: ProactiveInsightMemoryContext
) {
  const payload = {
    scope: context.scope,
    referenceDate: context.referenceDate,
    uploads: context.sourceUploadIds,
    dates: context.distinctDates,
    evidence: context.evidence.map((item) => ({
      evidenceId: item.evidenceId,
      sourceId: item.sourceId,
      sourceType: item.sourceType,
      uploadId: item.uploadId,
      recordingDate: item.recordingDate,
      sourceSegmentIds: item.sourceSegmentIds,
      title: item.title,
      summary: item.summary,
      excerpt: item.excerpt
    })),
    memories: memoryContext?.memories.map((memory) => ({
      memoryId: memory.memoryId,
      type: memory.type,
      status: memory.status,
      lifecycleKind: memory.lifecycleKind,
      summary: memory.summary,
      importanceScore: memory.importanceScore,
      occurrenceCount: memory.occurrenceCount,
      dates: memory.dates,
      evidence: memory.evidence
    })) ?? [],
    relations: memoryContext?.relations ?? []
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function longTermMemoryPrompt(memoryContext?: ProactiveInsightMemoryContext) {
  if (!memoryContext || memoryContext.memories.length === 0) {
    return "";
  }

  const memoryBlocks = [
    "[Long-term Memory]",
    "These memories are compressed observations derived from earlier evidence, not ground truth.",
    "Use them only to suggest useful reflections that are also grounded in current evidence.",
    ...memoryContext.memories.map((memory, index) =>
      [
        `[M${index + 1}] evidenceId=${memory.evidenceId}`,
        `Type: ${memory.type}`,
        `Lifecycle: ${memory.lifecycleKind}`,
        `Status: ${memory.status}`,
        `Observation: ${memory.title}: ${memory.summary}`,
        `Date: ${memory.dates.join(", ")}`,
        `Confidence: ${memory.confidence}`,
        `Occurrences: ${memory.occurrenceCount}`,
        "Evidence:",
        ...memory.evidence.map(
          (evidence) =>
            `- ${evidence.recordingDate} transcript ${evidence.sourceId}: ${evidence.excerpt}`
        )
      ].join("\n")
    )
  ];
  if (memoryContext.relations.length > 0) {
    memoryBlocks.push(
      "[Memory Relations]",
      ...memoryContext.relations.map(
        (relation) =>
          `relation=${relation.relationType} source=${relation.sourceMemoryRef} target=${relation.targetMemoryRef} confidence=${relation.confidence.toFixed(2)}`
      )
    );
  }
  return memoryBlocks.join("\n\n");
}

function buildPrompt(
  context: ProactiveInsightContext,
  maxItems: number,
  memoryContext?: ProactiveInsightMemoryContext
) {
  const evidenceLines = context.evidence.map((item) => ({
    evidenceId: item.evidenceId,
    kind: item.kind,
    uploadId: item.uploadId,
    recordingDate: item.recordingDate,
    title: item.title,
    summary: item.summary,
    excerpt: item.excerpt,
    caution: item.caution,
    signalCategory: item.signalCategory
  }));

  const systemPrompt = [
    "你是一个陪伴型助手，不是心理咨询师，也不是关系裁判。",
    "你的任务不是分析关系好坏，而是从用户已有记录里发现值得留意的小事情。",
    "语气像了解上下文的朋友：自然、温和、简短，不使用咨询报告式表达。",
    "问题必须具体、基于某个事件或说过的话，并且让用户可以自然回答。",
    "observation 和 reason 至少复用一个证据中的具体名词、人物、计划、担忧或短语，便于本地校验。",
    "优先生成 reminder、follow_up 和具体 reflection；不要提出宏大的关系判断或人生建议。",
    "避免这些抽象表达：关系质量、长期方向、沟通一致性、认知偏差、互动模式、关系模式、未来发展、双方关系发展。",
    "不要问‘你们是否保持了良好的沟通一致性’；有对应证据时，改问‘你们之前提到的这个问题，后来有继续聊吗？’。",
    "不要问‘这是否有助于减少认知偏差’；有跨日期证据时，改问‘这次和上次相比，你觉得有什么变化？’。",
    "只输出一个 JSON 对象，根对象必须包含 items 数组。",
    `最多输出 ${maxItems} 条，每条只能引用提供的 evidenceIds 和 memoryRefs。`,
    "如果证据不足，返回 {\"items\":[]}。",
    "不要做人格定性、心理诊断、关系裁决、劝分手。",
    "不要编造 transcript、时间戳、来源或新的 evidenceIds。",
    "You receive current conversation evidence and optional long-term memories.",
    "Long-term memories are compressed observations derived from previous evidence; they are not ground truth.",
    "Unresolved questions are reminders to clarify, not proof that a problem definitely exists.",
    "Active commitments may be mentioned as reminders only. Do not claim that a commitment was broken or violated.",
    "Use memories only to suggest useful reflections. Do not make permanent conclusions.",
    "Ignore unrelated memories and still generate current-only insights from current evidence.",
    "A single dated memory may only support tentative wording: 过去曾出现类似情况，可以进一步关注。",
    "Do not return an empty array solely because optional memory is unrelated or covers only one date.",
    "Do not infer personality. Do not diagnose relationships or recommend ending one.",
    "Do not claim long-term patterns unless multiple dated memory evidence exists.",
    "pattern_observation requires evidence spanning at least two distinct dates.",
    "For current scope, type must be one of: relationship_question | follow_up_question | unresolved_issue | reflection.",
    "insightType must be one of: reminder | reflection | follow_up | pattern_observation.",
    "category must be one of: summary | relationship | tone | follow_up | memory.",
    "observation, question, reason, and caution must be non-empty strings; confidence must be a number from 0 to 1.",
    "evidenceIds must contain 1 to 4 exact IDs copied from current evidence only.",
    "memoryRefs must contain only exact memory:* IDs and may be empty for current-only insights.",
    "Each item must contain exactly these fields: type, insightType, category, observation, question, reason, evidenceIds, memoryRefs, confidence, caution.",
    "Do not output Markdown, comments, or additional fields.",
    "If an item mentions previous, earlier, 之前, 过去, 历史, 再次, or 重复, memoryRefs must include a relevant memory:* ID."
  ].join("\n");

  const memoryPrompt = longTermMemoryPrompt(memoryContext);
  const currentEvidenceIds = context.evidence.map((item) => item.evidenceId);
  const memoryEvidenceIds = memoryContext?.memories.map((memory) => memory.evidenceId) ?? [];
  const exampleCurrentEvidenceId =
    context.evidence.find((item) => item.kind === "brief")?.evidenceId ?? currentEvidenceIds[0];

  const userPrompt = [
    `scope=${context.scope}`,
    `referenceDate=${context.referenceDate}`,
    `dateRange=${context.dateRange.startDate}..${context.dateRange.endDate}`,
    `maxItems=${maxItems}`,
    `Allowed current evidence IDs: ${currentEvidenceIds.join(", ")}`,
    `Allowed memory evidence IDs: ${memoryEvidenceIds.join(", ") || "none"}`,
    "返回格式示例：",
    JSON.stringify(
      {
        items: [
          {
            type: "follow_up_question",
            insightType: memoryEvidenceIds.length > 0 ? "reminder" : "follow_up",
            category: "follow_up",
            observation: memoryEvidenceIds.length > 0
              ? "这次又提到了上次还没定下来的具体安排。"
              : "这次提到了一个还没定下来的具体安排。",
            question: memoryEvidenceIds.length > 0
              ? "你们之前提到的这个安排，后来有继续确认吗？"
              : "这个安排后来有继续确认吗？",
            reason: memoryEvidenceIds.length > 0
              ? "当前记录和已有记忆都提到了这项安排，可以顺手确认后续。"
              : "当前记录提到了这项安排，但后续还不清楚。",
            evidenceIds: exampleCurrentEvidenceId ? [exampleCurrentEvidenceId] : [],
            memoryRefs: memoryEvidenceIds.length > 0 ? [memoryEvidenceIds[0]] : [],
            confidence: 0.68,
            caution: memoryEvidenceIds.length > 0
              ? "已有记忆只能作为待确认线索，不能据此判断承诺是否履行。"
              : "这只是基于当前记录的复盘提示，需要结合完整上下文确认。"
          }
        ]
      },
      null,
      2
    ),
    "Every item must cite at least one current evidence ID. If it uses long-term memory, also list the relevant memory ID in memoryRefs.",
    ...(memoryPrompt ? [memoryPrompt] : []),
    "证据：",
    JSON.stringify(evidenceLines)
  ].join("\n");

  return {
    systemPrompt,
    userPrompt
  };
}

function modelFromEnv() {
  return readStringEnv("DEEPSEEK_MODEL") ?? DEFAULT_MODEL;
}

function validateModelName(model: string) {
  return !model.includes("/") && allowedModels.has(model);
}

function defaultClientFactory(config: DeepseekClientConfig): DeepseekClient {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.timeout,
    maxRetries: config.maxRetries
  }) as unknown as DeepseekClient;
}

function logRun(logger: Logger, input: {
  model?: string;
  scope: string;
  evidenceCount: number;
  memoryCount: number;
  relationCount: number;
  acceptedCount: number;
  rejectedCount: number;
  rejectionReasons?: Partial<Record<ProactiveInsightRejectionReason, number>>;
  schemaRejectionDetails?: Partial<Record<string, number>>;
  failureCode?: string;
  elapsedMs: number;
}) {
  const rejectionReasons = Object.entries(input.rejectionReasons ?? {})
    .filter(([, count]) => (count ?? 0) > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}:${count}`)
    .join(",");
  const schemaRejectionDetails = Object.entries(input.schemaRejectionDetails ?? {})
    .filter(([, count]) => (count ?? 0) > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([detail, count]) => `${detail}:${count}`)
    .join(",");
  const message =
    `[proactive-insights] provider=deepseek model=${input.model ?? "unresolved"} scope=${input.scope} ` +
    `evidence=${input.evidenceCount} memories=${input.memoryCount} relations=${input.relationCount} accepted=${input.acceptedCount} rejected=${input.rejectedCount} ` +
    `rejection_reasons=${rejectionReasons || "none"} ` +
    `schema_rejections=${schemaRejectionDetails || "none"} ` +
    `failure=${input.failureCode ?? "none"} elapsed_ms=${input.elapsedMs}`;

  if (input.failureCode) {
    logger.warn(message);
  } else {
    logger.info(message);
  }
}

export function createDeepseekProactiveInsightProvider(deps: {
  clientFactory?: (config: DeepseekClientConfig) => DeepseekClient;
  now?: () => number;
  logger?: Logger;
} = {}) {
  const clientFactory = deps.clientFactory ?? defaultClientFactory;
  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger ?? console;

  return {
    async generate(input: {
      context: ProactiveInsightContext;
      memoryContext?: ProactiveInsightMemoryContext;
      sourceFingerprint?: string;
      createdAt?: string;
      maxItems?: number;
    }): Promise<ProactiveInsightRunResult> {
      const startedAt = now();
      const sourceFingerprint =
        input.sourceFingerprint ?? buildSourceFingerprint(input.context, input.memoryContext);
      const rejectionReasons: Partial<Record<ProactiveInsightRejectionReason, number>> = {};
      const schemaRejectionDetails: Partial<Record<string, number>> = {};
      let candidateCount = 0;
      const model = modelFromEnv();
      const configuredMaxItems = input.maxItems ?? readIntEnv("PROACTIVE_INSIGHT_MAX_ITEMS", DEFAULT_MAX_ITEMS);
      const maxItems = Math.min(DEFAULT_MAX_ITEMS, Math.max(0, configuredMaxItems));
      const complete = (result: Omit<ProactiveInsightRunResult, "elapsedMs" | "sourceFingerprint">) => {
        const elapsedMs = Math.max(0, now() - startedAt);
        logRun(logger, {
          model: result.model,
          scope: input.context.scope,
          evidenceCount: input.context.evidence.length,
          memoryCount: input.memoryContext?.memories.length ?? 0,
          relationCount: input.memoryContext?.relations.length ?? 0,
          acceptedCount: result.items.length,
          rejectedCount: Math.max(0, candidateCount - result.items.length),
          rejectionReasons,
          schemaRejectionDetails,
          failureCode: result.failureCode,
          elapsedMs
        });

        return {
          ...result,
          elapsedMs,
          sourceFingerprint
        };
      };

      if (input.context.evidence.length === 0) {
        return complete({
          status: "generated",
          items: [],
          provider: "deepseek",
          model
        });
      }

      const apiKey = readStringEnv("DEEPSEEK_API_KEY");
      if (!apiKey) {
        return complete({
          status: "fallback",
          items: [],
          provider: "deepseek",
          model,
          failureCode: "missing_api_key"
        });
      }
      const baseURL = normalizeDeepseekBaseUrl(readStringEnv("DEEPSEEK_BASE_URL"));
      if (!isAllowedDeepseekBaseUrl(baseURL)) {
        return complete({
          status: "fallback",
          items: [],
          provider: "deepseek",
          model,
          failureCode: "invalid_base_url"
        });
      }
      if (!validateModelName(model)) {
        return complete({
          status: "fallback",
          items: [],
          provider: "deepseek",
          model,
          failureCode: "invalid_model"
        });
      }

      try {
        const client = clientFactory({
          apiKey,
          baseURL,
          timeout: resolveTimeoutMs(),
          maxRetries: resolveMaxRetries()
        });
        const prompt = buildPrompt(input.context, maxItems, input.memoryContext);
        const response = await client.chat.completions.create({
          model,
          stream: false,
          response_format: {
            type: "json_object"
          },
          messages: [
            {
              role: "system",
              content: prompt.systemPrompt
            },
            {
              role: "user",
              content: prompt.userPrompt
            }
          ],
          max_tokens: readIntEnv("PROACTIVE_INSIGHT_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS),
          thinking: {
            type: "disabled"
          }
        });
        const content = response.choices?.[0]?.message?.content?.trim();
        if (!content) {
          return complete({
            status: "fallback",
            items: [],
            provider: "deepseek",
            model,
            failureCode: "empty_response"
          });
        }

        let parsedJson: unknown;
        try {
          parsedJson = parseJsonObjectFromModelText(content);
        } catch {
          return complete({
            status: "fallback",
            items: [],
            provider: "deepseek",
            model,
            failureCode: "invalid_json"
          });
        }
        const parsedResponse = ModelResponseSchema.safeParse(parsedJson);
        if (!parsedResponse.success) {
          const detail = summarizeProactiveInsightSchemaIssues(parsedResponse.error);
          schemaRejectionDetails[detail] = (schemaRejectionDetails[detail] ?? 0) + 1;
          rejectionReasons.invalid_schema = (rejectionReasons.invalid_schema ?? 0) + 1;
          return complete({
            status: "fallback",
            items: [],
            provider: "deepseek",
            model,
            failureCode: "invalid_schema"
          });
        }
        const parsed: z.infer<typeof ModelResponseSchema> = parsedResponse.data;
        candidateCount = parsed.items.length;

        const items = validateProactiveInsights({
          context: input.context,
          memoryContext: input.memoryContext,
          rawItems: parsed.items,
          createdAt: input.createdAt,
          maxItems,
          onReject: (reason, detail) => {
            rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
            if (detail) {
              schemaRejectionDetails[detail] = (schemaRejectionDetails[detail] ?? 0) + 1;
            }
          }
        });

        if (
          candidateCount > 0 &&
          items.length === 0 &&
          rejectionReasons.invalid_schema === candidateCount
        ) {
          return complete({
            status: "fallback",
            items: [],
            provider: "deepseek",
            model,
            failureCode: "invalid_schema"
          });
        }

        return complete({
          status: "generated",
          items,
          provider: "deepseek",
          model
        });
      } catch (error) {
        return complete({
          status: "fallback",
          items: [],
          provider: "deepseek",
          model,
          failureCode: isTimeoutError(error) ? "timeout" : "api_error"
        });
      }
    }
  };
}
