import OpenAI from "openai";
import { z } from "zod";

import {
  DateCompanionProactiveValueContextSchema,
  DateCompanionProactiveValueSchema,
  type DateCompanionProactiveValue,
  type DateCompanionProactiveValueContext
} from "@/lib/domain/date-companion-proactive-value";
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
  | "invalid_evidence"
  | "unsafe_date_language"
  | "unsafe_source_attribution"
  | "provider_disabled"
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

export type DateCompanionProactiveValueRunResult = {
  status: "generated" | "fallback";
  value: DateCompanionProactiveValue | null;
  provider: "deepseek";
  model: string;
  elapsedMs: number;
  sourceFingerprint: string;
  failureCode?: ProactiveInsightFailureCode;
  sourceDiagnostic?: DateCompanionProactiveSourceDiagnostic;
};

export const DATE_COMPANION_PROACTIVE_SOURCE_ATTRIBUTION_VERSION = 4 as const;

export type DateCompanionProactiveSourceField =
  | "observation"
  | `suggestedQuestion:${number}`
  | "reason"
  | "caution";

export type DateCompanionProactiveSourceDiagnostic = {
  ruleVersion: typeof DATE_COMPANION_PROACTIVE_SOURCE_ATTRIBUTION_VERSION;
  scopeOriginMismatch: boolean;
  failedAttribution: boolean;
  unsafeFields: DateCompanionProactiveSourceField[];
  sourceMarkerFields: DateCompanionProactiveSourceField[];
  certaintyFields: DateCompanionProactiveSourceField[];
  normalizedSourceFields: DateCompanionProactiveSourceField[];
  cautionBoundaryMissing: boolean;
  cautionSourceNormalized: boolean;
  referencedOrigins: Array<"direct_conversation" | "user_reflection" | "unknown">;
};

type DateCompanionValueValidation = {
  value: DateCompanionProactiveValue | null;
  failureCode?: ProactiveInsightFailureCode;
  diagnostic: DateCompanionProactiveSourceDiagnostic;
};

const singleDateHistoricalPattern = /上次|之前|此前|过去|历史|再次|又一次|重复|反复|趋势|模式|长期|一直|经常|总是|每次|previous|earlier|again|repeat|trend|pattern|long[- ]term|always|often/iu;
const multiDatePattern = /模式|趋势|长期|一直|经常|总是|每次|反复|pattern|trend|long[- ]term|always|usually|often/iu;
const tentativePattern = /暂时|暂定|待观察|初步|可能|也许|仍需确认|tentative|possible|may|might|needs? confirmation/iu;
const unsafeCertaintyPattern = /(?:已经|已)(?:作出决定|确认|决定|确定)|确认(?:要|将|会)|明确表示(?:会|将)|一定|肯定|必然|绝对|确定(?:会|要|是|在|已|已经)?/gu;
const negatedCertaintyPattern = /(?:不是|并非|不能|不可|不应|不要|未|没有|尚未|并未).{0,18}$/u;
const interrogativeCertaintyPattern = /(?:是否|有没有|有无|想确认|需要确认|需确认|仍需确认).{0,18}$/u;
const tentativeCertaintyPattern = /(?:可能|也许|或许|似乎|看起来|待核实|有待核实|尚待核实|还需核实|需要核实|仍需核实).{0,18}$/u;
const sourceMarkerPatterns = [
  /复盘(?:中|里)(?:也)?提到/u,
  /基于[^，。！？!?；\n]{0,120}复盘/u,
  /交流记录(?:中|里)(?:也)?提到/u,
  /基于[^，。！？!?；\n]{0,120}交流记录/u,
  /复盘内容属于你的转述/u,
  /不是\s*Ta\/第三方已确认的直接事实或原话/u,
  /交流记录只支持当时直接出现的内容/u,
  /这条派生提示不是新增第三方事实/u
] as const;
const NORMALIZED_REASON_CORE = "这条线索比较具体，适合后续核实。";
const NORMALIZED_CAUTION_CORE = "信息仍有限，需要继续核实。";

type ReferencedEvidence = DateCompanionProactiveValueContext["evidence"];

type SourceProfile = {
  origins: Array<"direct_conversation" | "user_reflection">;
  directConversationDates: string[];
  reflectionDates: string[];
};

type SourceFrames = {
  observationPrefix: string;
  questionPrefix: string;
  reasonPrefix: string;
  cautionBoundary: string;
};

function diagnosticOrigins(evidence: Array<{ origin: unknown }> | undefined) {
  const origins = new Set<"direct_conversation" | "user_reflection" | "unknown">();
  for (const item of evidence ?? []) {
    origins.add(item.origin === "direct_conversation" || item.origin === "user_reflection"
      ? item.origin
      : "unknown");
  }
  return (["direct_conversation", "user_reflection", "unknown"] as const)
    .filter((origin) => origins.has(origin));
}

function sourceDiagnostic(input: {
  context: DateCompanionProactiveValueContext;
  referencedOrigins?: DateCompanionProactiveSourceDiagnostic["referencedOrigins"];
  unsafeFields?: DateCompanionProactiveSourceField[];
  sourceMarkerFields?: DateCompanionProactiveSourceField[];
  certaintyFields?: DateCompanionProactiveSourceField[];
  normalizedSourceFields?: DateCompanionProactiveSourceField[];
  cautionBoundaryMissing?: boolean;
  cautionSourceNormalized?: boolean;
}) {
  const referencedOrigins = input.referencedOrigins ?? diagnosticOrigins(input.context.evidence);
  const unsafeFields = [...new Set(input.unsafeFields ?? [])];
  return {
    ruleVersion: DATE_COMPANION_PROACTIVE_SOURCE_ATTRIBUTION_VERSION,
    scopeOriginMismatch: input.context.scope === "current_interaction"
      && referencedOrigins.some((origin) => origin !== "direct_conversation"),
    failedAttribution: unsafeFields.length > 0,
    unsafeFields,
    sourceMarkerFields: [...new Set(input.sourceMarkerFields ?? [])],
    certaintyFields: [...new Set(input.certaintyFields ?? [])],
    normalizedSourceFields: [...new Set(input.normalizedSourceFields ?? [])],
    cautionBoundaryMissing: input.cautionBoundaryMissing ?? false,
    cautionSourceNormalized: input.cautionSourceNormalized ?? false,
    referencedOrigins
  } satisfies DateCompanionProactiveSourceDiagnostic;
}

function sourceDiagnosticLog(diagnostic: DateCompanionProactiveSourceDiagnostic) {
  return `source_rule=${diagnostic.ruleVersion} `
    + `scope_origin_mismatch=${diagnostic.scopeOriginMismatch} `
    + `failed_attribution=${diagnostic.failedAttribution} `
    + `caution_boundary_missing=${diagnostic.cautionBoundaryMissing} `
    + `caution_source_normalized=${diagnostic.cautionSourceNormalized} `
    + `referenced_origins=${diagnostic.referencedOrigins.join(",") || "none"} `
    + `unsafe_fields=${diagnostic.unsafeFields.join(",") || "none"} `
    + `source_marker_fields=${diagnostic.sourceMarkerFields.join(",") || "none"} `
    + `certainty_fields=${diagnostic.certaintyFields.join(",") || "none"} `
    + `normalized_source_fields=${diagnostic.normalizedSourceFields.join(",") || "none"}`;
}

function sourceFields(value: DateCompanionProactiveValue) {
  return [
    { field: "observation" as const, text: value.observation },
    ...value.suggestedQuestions.map((text, index) => ({
      field: `suggestedQuestion:${index}` as const,
      text
    })),
    { field: "reason" as const, text: value.reason },
    { field: "caution" as const, text: value.caution }
  ];
}

function hasUnsafeCertainty(text: string) {
  for (const match of text.matchAll(unsafeCertaintyPattern)) {
    const matchIndex = match.index ?? 0;
    const before = text.slice(Math.max(0, matchIndex - 24), matchIndex);
    if (
      before.endsWith("不")
      || negatedCertaintyPattern.test(before)
      || interrogativeCertaintyPattern.test(before)
      || tentativeCertaintyPattern.test(before)
    ) continue;
    return true;
  }
  return false;
}

function hasSourceMarker(text: string) {
  return sourceMarkerPatterns.some((pattern) => pattern.test(text));
}

function requiresThirdPartyCertaintyGuard(evidence: ReferencedEvidence) {
  return evidence.some((item) => item.origin === "user_reflection"
    && (item.subject === "companion" || item.subject === "both"));
}

function sourceProfile(evidence: ReferencedEvidence): SourceProfile {
  const directConversationDates = [...new Set(evidence
    .filter((item) => item.origin === "direct_conversation")
    .map((item) => item.recordingDate))].sort();
  const reflectionDates = [...new Set(evidence
    .filter((item) => item.origin === "user_reflection")
    .map((item) => item.recordingDate))].sort();
  return {
    origins: [
      ...(directConversationDates.length > 0 ? ["direct_conversation" as const] : []),
      ...(reflectionDates.length > 0 ? ["user_reflection" as const] : [])
    ],
    directConversationDates,
    reflectionDates
  };
}

function formatSourceDates(dates: string[]) {
  if (dates.length <= 3) return dates.join("、");
  return `${dates[0]} 至 ${dates.at(-1)}（共 ${dates.length} 个日期）`;
}

function sourceFrames(profile: SourceProfile): SourceFrames {
  const directDates = formatSourceDates(profile.directConversationDates);
  const reflectionDates = formatSourceDates(profile.reflectionDates);
  const hasDirectConversation = profile.directConversationDates.length > 0;
  const hasReflection = profile.reflectionDates.length > 0;
  if (hasDirectConversation && hasReflection) {
    return {
      observationPrefix: `你在 ${reflectionDates} 的复盘中提到相关内容；在 ${directDates} 的交流记录中也提到相关内容：`,
      questionPrefix: `关于你在 ${reflectionDates} 的复盘中提到的内容，以及 ${directDates} 的交流记录中提到的内容，`,
      reasonPrefix: `基于你在 ${reflectionDates} 的复盘与 ${directDates} 的交流记录：`,
      cautionBoundary: "复盘内容属于你的转述，不是 Ta/第三方已确认的直接事实或原话；交流记录只支持当时直接出现的内容，这条派生提示不是新增第三方事实。"
    };
  }
  if (hasReflection) {
    return {
      observationPrefix: `你在 ${reflectionDates} 的复盘中提到：`,
      questionPrefix: `关于你在 ${reflectionDates} 的复盘中提到的内容，`,
      reasonPrefix: `基于你在 ${reflectionDates} 的复盘：`,
      cautionBoundary: "复盘内容属于你的转述，不是 Ta/第三方已确认的直接事实或原话。"
    };
  }
  return {
    observationPrefix: `在 ${directDates} 的交流记录中提到：`,
    questionPrefix: `关于 ${directDates} 的交流记录中提到的内容，`,
    reasonPrefix: `基于 ${directDates} 的交流记录：`,
    cautionBoundary: "交流记录只支持当时直接出现的内容；这条派生提示不是新增第三方事实。"
  };
}

function clipText(value: string, maxLength: number) {
  return Array.from(value).slice(0, Math.max(0, maxLength)).join("").trim();
}

function prependFrame(prefix: string, core: string, maxLength: number) {
  return `${prefix}${clipText(core, maxLength - Array.from(prefix).length)}`;
}

function appendBoundary(core: string, boundary: string, maxLength: number) {
  const maxCoreLength = maxLength - Array.from(`；${boundary}`).length;
  const clippedCore = clipText(core, maxCoreLength);
  const separator = /[。！？!?]$/u.test(clippedCore) ? "" : "；";
  return `${clippedCore}${separator}${boundary}`;
}

function frameValue(value: DateCompanionProactiveValue, frames: SourceFrames) {
  return DateCompanionProactiveValueSchema.safeParse({
    ...value,
    observation: prependFrame(frames.observationPrefix, value.observation, 360),
    suggestedQuestions: value.suggestedQuestions.map((question) =>
      prependFrame(frames.questionPrefix, question, 280)),
    reason: prependFrame(frames.reasonPrefix, value.reason, 480),
    caution: appendBoundary(value.caution, frames.cautionBoundary, 360)
  });
}

function hasCompleteSourceFrames(value: DateCompanionProactiveValue, frames: SourceFrames) {
  return value.observation.startsWith(frames.observationPrefix)
    && value.suggestedQuestions.every((question) => question.startsWith(frames.questionPrefix))
    && value.reason.startsWith(frames.reasonPrefix)
    && value.caution.endsWith(frames.cautionBoundary);
}

function fieldHasEmbeddedSourceMarker(text: string, prefix: string) {
  return text.startsWith(prefix) && hasSourceMarker(text.slice(prefix.length));
}

function validateDateLanguage(value: DateCompanionProactiveValue, evidence: ReferencedEvidence) {
  const text = [value.observation, ...value.suggestedQuestions, value.reason].join("\n");
  const distinctDateCount = new Set(evidence.map((item) => item.recordingDate)).size;
  return !(
    distinctDateCount <= 1 && singleDateHistoricalPattern.test(text)
    || distinctDateCount === 2 && multiDatePattern.test(text)
    || distinctDateCount >= 3 && multiDatePattern.test(text) && !tentativePattern.test(text)
  );
}

function resolveValueBasics(input: {
  context: DateCompanionProactiveValueContext;
  value: unknown;
}): {
  ok: true;
  context: DateCompanionProactiveValueContext;
  value: DateCompanionProactiveValue;
  referencedEvidence: ReferencedEvidence;
  diagnostic: DateCompanionProactiveSourceDiagnostic;
} | {
  ok: false;
  result: DateCompanionValueValidation;
} {
  const initialDiagnostic = sourceDiagnostic({ context: input.context });
  const parsedContext = DateCompanionProactiveValueContextSchema.safeParse(input.context);
  if (!parsedContext.success) {
    return {
      ok: false,
      result: {
        value: null,
        failureCode: "unsafe_source_attribution",
        diagnostic: initialDiagnostic
      }
    };
  }
  const parsedValue = DateCompanionProactiveValueSchema.safeParse(input.value);
  if (!parsedValue.success) {
    return {
      ok: false,
      result: { value: null, failureCode: "invalid_schema", diagnostic: initialDiagnostic }
    };
  }
  const evidenceById = new Map(parsedContext.data.evidence.map((item) => [item.evidenceId, item]));
  const referencedEvidence = parsedValue.data.evidenceIds
    .map((evidenceId) => evidenceById.get(evidenceId))
    .filter((item): item is ReferencedEvidence[number] => Boolean(item));
  if (referencedEvidence.length !== parsedValue.data.evidenceIds.length) {
    return {
      ok: false,
      result: { value: null, failureCode: "invalid_evidence", diagnostic: initialDiagnostic }
    };
  }
  const diagnostic = sourceDiagnostic({
    context: parsedContext.data,
    referencedOrigins: diagnosticOrigins(referencedEvidence)
  });
  if (!validateDateLanguage(parsedValue.data, referencedEvidence)) {
    return {
      ok: false,
      result: { value: null, failureCode: "unsafe_date_language", diagnostic }
    };
  }
  return {
    ok: true,
    context: parsedContext.data,
    value: parsedValue.data,
    referencedEvidence,
    diagnostic
  };
}

function sourceLabel(origin: DateCompanionProactiveValueContext["evidence"][number]["origin"]) {
  return origin === "user_reflection"
    ? "user_reflection：用户事后复盘中的转述，不是第三方直接事实或原话"
    : "direct_conversation：真实交流记录，只支持记录中直接出现的内容";
}

function dateCompanionValuePrompt(context: DateCompanionProactiveValueContext) {
  const distinctDates = [...new Set(context.evidence.map((item) => item.recordingDate))].sort();
  const dateRule = distinctDates.length === 1
    ? "只有一个日期：只能使用‘这次/当天’等单次措辞，禁止‘再次/重复/模式/长期’。"
    : distinctDates.length === 2
      ? "恰好两个日期：最多谨慎说‘再次出现’，禁止声称模式、趋势或长期规律。"
      : "至少三个日期：可以提出暂定、待观察的模式线索，但必须明确不确定性并保留 caution。";
  const includesReflection = context.evidence.some((item) => item.origin === "user_reflection");
  const includesDirectConversation = context.evidence.some(
    (item) => item.origin === "direct_conversation"
  );
  const systemPrompt = [
    "你是 Daily Brief 的主动价值助手，不是心理咨询师或关系裁判。",
    "只根据提供的已确认 canonical Evidence 给出一条温和、具体、可行动的观察。",
    "不要创造新事实，不要推断人格、关系好坏或承诺是否违背。",
    "Evidence 的 sourceLabel 是硬事实边界，不能省略、互换或升级。unknown 来源不得使用。",
    "[user_reflection] 是用户事后复盘中的转述，不是 Ta/第三方已确认的直接事实或原话。",
    "服务器会在 evidenceIds allowlist 校验后，按实际引用来源和日期确定性附加来源框架；你只写自然、简洁的内容核心，不要在每个字段机械重复来源前缀。",
    "reason 只解释为什么值得留意，caution 只写来源中性的局限或下一步，例如‘信息仍有限，需要继续核实。’；不要在 reason 或 caution 中写复盘、交流记录、转述、第三方事实或原话等来源说明，服务器会统一添加。",
    "即使服务器会附加来源框架，也禁止把 user_reflection 强化成‘Alice/Ta 已确认、一定、肯定、确定会’等第三方确定性事实。",
    "[direct_conversation] 是真实交流记录，只能整理记录中直接出现的内容，不能扩展为关系或人格结论。",
    "混合来源仍需在语义上分别尊重转述与交流记录，服务器会负责最终双来源标注。",
    includesReflection
      ? "本次包含 user_reflection：保持不确定性；固定的非直接事实 caution 由服务器附加。"
      : "本次不包含 user_reflection：不要虚构复盘来源。",
    includesDirectConversation
      ? "本次包含 direct_conversation：只整理交流记录支持的内容核心。"
      : "本次不包含 direct_conversation：不要虚构交流记录来源。",
    dateRule,
    "只输出一个 JSON 对象，不要 Markdown、注释或额外字段。",
    "对象必须且只能包含 observation、suggestedQuestions、reason、evidenceIds、confidence、caution 六个字段。",
    "suggestedQuestions 必须包含 1–2 个不同的问题。",
    "evidenceIds 必须包含 1–4 个不同 ID，并且只能逐字复制 allowlist 中的 ID。",
    "confidence 必须是 0 到 1 的数字；caution 必须是非空字符串。",
    "AI 输出只是派生提示，不是 Evidence，也不能引用其他 AI 输出。"
  ].join("\n");
  const userPrompt = [
    `scope=${context.scope}`,
    `relationshipId=${context.relationshipId}`,
    context.interactionId ? `interactionId=${context.interactionId}` : `personId=${context.personId}`,
    `mappingVersion=${context.mappingVersion}`,
    `distinctDates=${distinctDates.join(",")}`,
    `containsUserReflection=${includesReflection}`,
    `Allowed evidence IDs: ${context.evidence.map((item) => item.evidenceId).join(", ")}`,
    "Evidence:",
    JSON.stringify(context.evidence.map((item) => ({
      evidenceId: item.evidenceId,
      recordingDate: item.recordingDate,
      origin: item.origin,
      sourceLabel: sourceLabel(item.origin),
      subject: item.subject,
      quote: item.quote
    })))
  ].join("\n");
  return { systemPrompt, userPrompt };
}

export function validateCanonicalDateCompanionProactiveValue(input: {
  context: DateCompanionProactiveValueContext;
  value: unknown;
}): DateCompanionValueValidation {
  const basics = resolveValueBasics(input);
  if (!basics.ok) return basics.result;
  const profile = sourceProfile(basics.referencedEvidence);
  const frames = sourceFrames(profile);
  const unsafeFields: DateCompanionProactiveSourceField[] = [];
  const sourceMarkerFields: DateCompanionProactiveSourceField[] = [];
  const certaintyFields: DateCompanionProactiveSourceField[] = [];
  const observationHasEmbeddedSourceMarker = fieldHasEmbeddedSourceMarker(
    basics.value.observation,
    frames.observationPrefix
  );
  if (
    !basics.value.observation.startsWith(frames.observationPrefix)
    || observationHasEmbeddedSourceMarker
  ) {
    unsafeFields.push("observation");
    if (observationHasEmbeddedSourceMarker) sourceMarkerFields.push("observation");
  }
  basics.value.suggestedQuestions.forEach((question, index) => {
    const field = `suggestedQuestion:${index}` as const;
    const hasEmbeddedMarker = fieldHasEmbeddedSourceMarker(question, frames.questionPrefix);
    if (
      !question.startsWith(frames.questionPrefix)
      || hasEmbeddedMarker
    ) {
      unsafeFields.push(field);
      if (hasEmbeddedMarker) sourceMarkerFields.push(field);
    }
  });
  const reasonHasEmbeddedSourceMarker = fieldHasEmbeddedSourceMarker(
    basics.value.reason,
    frames.reasonPrefix
  );
  if (
    !basics.value.reason.startsWith(frames.reasonPrefix)
    || reasonHasEmbeddedSourceMarker
  ) {
    unsafeFields.push("reason");
    if (reasonHasEmbeddedSourceMarker) sourceMarkerFields.push("reason");
  }
  const cautionBoundaryMissing = !basics.value.caution.endsWith(frames.cautionBoundary);
  const cautionCore = cautionBoundaryMissing
    ? basics.value.caution
    : basics.value.caution.slice(0, -frames.cautionBoundary.length);
  const cautionHasSourceMarker = hasSourceMarker(cautionCore);
  if (cautionBoundaryMissing || cautionHasSourceMarker) unsafeFields.push("caution");
  if (cautionHasSourceMarker) sourceMarkerFields.push("caution");
  if (requiresThirdPartyCertaintyGuard(basics.referencedEvidence)) {
    for (const { field, text } of sourceFields(basics.value)) {
      if (hasUnsafeCertainty(text)) {
        unsafeFields.push(field);
        certaintyFields.push(field);
      }
    }
  }
  const diagnostic = sourceDiagnostic({
    context: basics.context,
    referencedOrigins: profile.origins,
    unsafeFields,
    sourceMarkerFields,
    certaintyFields,
    cautionBoundaryMissing
  });
  if (diagnostic.failedAttribution || diagnostic.cautionBoundaryMissing) {
    return { value: null, failureCode: "unsafe_source_attribution", diagnostic };
  }
  return { value: basics.value, diagnostic };
}

export function frameDateCompanionProactiveValueDraft(input: {
  context: DateCompanionProactiveValueContext;
  value: unknown;
}): DateCompanionValueValidation {
  const basics = resolveValueBasics(input);
  if (!basics.ok) return basics.result;
  const profile = sourceProfile(basics.referencedEvidence);
  const frames = sourceFrames(profile);
  const canonical = validateCanonicalDateCompanionProactiveValue({
    context: basics.context,
    value: basics.value
  });
  if (canonical.value || hasCompleteSourceFrames(basics.value, frames)) return canonical;
  const sourceMarkerFields = sourceFields(basics.value)
    .filter(({ text }) => hasSourceMarker(text))
    .map(({ field }) => field);
  const certaintyFields = requiresThirdPartyCertaintyGuard(basics.referencedEvidence)
    ? sourceFields(basics.value)
        .filter(({ text }) => hasUnsafeCertainty(text))
        .map(({ field }) => field)
    : [];
  const blockingSourceMarkerFields = sourceMarkerFields.filter(
    (field) => field !== "reason" && field !== "caution"
  );
  const normalizableSourceFields = sourceMarkerFields.filter(
    (field) => field === "reason" || field === "caution"
  );
  const normalizedSourceFields = blockingSourceMarkerFields.length === 0
    && certaintyFields.length === 0
    ? normalizableSourceFields
    : [];
  const cautionSourceNormalized = normalizedSourceFields.includes("caution")
    && blockingSourceMarkerFields.length === 0
    && certaintyFields.length === 0;
  const unsafeFields = [...blockingSourceMarkerFields, ...certaintyFields];
  const cautionBoundaryMissing = !basics.value.caution.endsWith(frames.cautionBoundary);
  const diagnostic = sourceDiagnostic({
    context: basics.context,
    referencedOrigins: profile.origins,
    unsafeFields,
    sourceMarkerFields,
    certaintyFields,
    normalizedSourceFields,
    cautionBoundaryMissing,
    cautionSourceNormalized
  });
  if (diagnostic.failedAttribution) {
    return { value: null, failureCode: "unsafe_source_attribution", diagnostic };
  }
  const draftValue = {
    ...basics.value,
    ...(normalizedSourceFields.includes("reason") ? { reason: NORMALIZED_REASON_CORE } : {}),
    ...(cautionSourceNormalized ? { caution: NORMALIZED_CAUTION_CORE } : {})
  };
  const framed = frameValue(draftValue, frames);
  if (!framed.success) {
    return { value: null, failureCode: "invalid_schema", diagnostic };
  }
  const framedCanonical = validateCanonicalDateCompanionProactiveValue({
    context: basics.context,
    value: framed.data
  });
  if (!framedCanonical.value) return framedCanonical;
  return { value: framedCanonical.value, diagnostic };
}

export function createDeepseekDateCompanionProactiveValueProvider(deps: {
  clientFactory?: (config: DeepseekClientConfig) => DeepseekClient;
  now?: () => number;
  logger?: Logger;
} = {}) {
  const clientFactory = deps.clientFactory ?? defaultClientFactory;
  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger ?? console;
  const model = modelFromEnv();
  return {
    provider: "deepseek" as const,
    model,
    async generate(input: {
      context: DateCompanionProactiveValueContext;
      sourceFingerprint: string;
    }): Promise<DateCompanionProactiveValueRunResult> {
      const startedAt = now();
      const complete = (result: Omit<DateCompanionProactiveValueRunResult, "elapsedMs" | "sourceFingerprint">) => ({
        ...result,
        elapsedMs: Math.max(0, now() - startedAt),
        sourceFingerprint: input.sourceFingerprint
      });
      const parsedContext = DateCompanionProactiveValueContextSchema.safeParse(input.context);
      if (!parsedContext.success) {
        const diagnostic = sourceDiagnostic({ context: input.context });
        logger.warn(
          `[date-companion-proactive] provider=deepseek model=${model} scope=${input.context.scope} `
          + `status=fallback failure=unsafe_source_attribution ${sourceDiagnosticLog(diagnostic)}`
        );
        return complete({
          status: "fallback",
          value: null,
          provider: "deepseek",
          model,
          failureCode: "unsafe_source_attribution",
          sourceDiagnostic: diagnostic
        });
      }
      const apiKey = readStringEnv("DEEPSEEK_API_KEY");
      if (!apiKey) {
        return complete({ status: "fallback", value: null, provider: "deepseek", model, failureCode: "missing_api_key" });
      }
      const baseURL = normalizeDeepseekBaseUrl(readStringEnv("DEEPSEEK_BASE_URL"));
      if (!isAllowedDeepseekBaseUrl(baseURL)) {
        return complete({ status: "fallback", value: null, provider: "deepseek", model, failureCode: "invalid_base_url" });
      }
      if (model !== DEFAULT_MODEL) {
        return complete({ status: "fallback", value: null, provider: "deepseek", model, failureCode: "invalid_model" });
      }
      try {
        const client = clientFactory({
          apiKey,
          baseURL,
          timeout: resolveTimeoutMs(),
          maxRetries: 0
        });
        const prompt = dateCompanionValuePrompt(parsedContext.data);
        const response = await client.chat.completions.create({
          model,
          stream: false,
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: prompt.systemPrompt },
            { role: "user", content: prompt.userPrompt }
          ],
          max_tokens: Math.min(
            1_200,
            readIntEnv("PROACTIVE_INSIGHT_MAX_OUTPUT_TOKENS", 1_200)
          ),
          thinking: { type: "disabled" }
        });
        const content = response.choices?.[0]?.message?.content?.trim();
        if (!content) {
          return complete({ status: "fallback", value: null, provider: "deepseek", model, failureCode: "empty_response" });
        }
        let parsed: unknown;
        try {
          parsed = parseJsonObjectFromModelText(content);
        } catch {
          return complete({ status: "fallback", value: null, provider: "deepseek", model, failureCode: "invalid_json" });
        }
        const validated = frameDateCompanionProactiveValueDraft({
          context: parsedContext.data,
          value: parsed
        });
        if (!validated.value) {
          logger.warn(
            `[date-companion-proactive] provider=deepseek model=${model} scope=${input.context.scope} `
            + `status=fallback failure=${validated.failureCode ?? "invalid_schema"} `
            + sourceDiagnosticLog(validated.diagnostic)
          );
          return complete({
            status: "fallback",
            value: null,
            provider: "deepseek",
            model,
            failureCode: validated.failureCode ?? "invalid_schema",
            sourceDiagnostic: validated.diagnostic
          });
        }
        logger.info(
          `[date-companion-proactive] provider=deepseek model=${model} scope=${input.context.scope} `
          + `evidence=${input.context.evidence.length} status=generated `
          + `${sourceDiagnosticLog(validated.diagnostic)} elapsed_ms=${Math.max(0, now() - startedAt)}`
        );
        return complete({
          status: "generated",
          value: validated.value,
          provider: "deepseek",
          model,
          sourceDiagnostic: validated.diagnostic
        });
      } catch (error) {
        const failureCode = isTimeoutError(error) ? "timeout" : "api_error";
        logger.warn(
          `[date-companion-proactive] provider=deepseek model=${model} scope=${input.context.scope} `
          + `evidence=${input.context.evidence.length} status=fallback failure=${failureCode}`
        );
        return complete({ status: "fallback", value: null, provider: "deepseek", model, failureCode });
      }
    }
  };
}
