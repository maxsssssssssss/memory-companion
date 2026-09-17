import type OpenAI from "openai";

import {
  DAILY_REFLECTION_THINKING_SAFETY_BOUNDARY_VERSION,
  DailyReflectionThinkingProviderOutputSchema,
  type ContextMode,
  type DailyReflectionThinkingMessage,
  type DailyReflectionThinkingProviderOutput,
  type DailyReflectionThinkingSource,
  type ThinkingMode
} from "@/lib/domain/daily-reflection-thinking";
import type { JsonStore } from "@/lib/server/storage/json-store";
import {
  createThinkingTokenHubClient,
  requestThinkingTokenHubText,
  THINKING_MODEL
} from "./thinking-tokenhub-transport";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_ATTEMPTS = 2;

const MODE_INSTRUCTIONS: Record<ThinkingMode, string> = {
  brainstorm: "先抓住用户真正想解决的点，再自然展开几个有实质差异的方向，并给出可继续探索的切入点；不要机械凑固定数量或只列关键词。",
  clarify_decision: "直接点明核心取舍，梳理目标、约束、未知项和可逆下一步；帮助用户看清决定，但不替用户做最终选择。",
  compare_directions: "先给出清晰的比较结论或主要分歧，再用一致维度解释取舍；使用自然段或普通编号，不使用 Markdown 表格。",
  extend_idea: "沿用户当前想法形成连贯、具体的延伸，补充机制、边界、变体和小实验；不要把延伸内容冒充用户原话。",
  past_clues: "直接说明可信来源里有哪些相关线索、为什么相关、还不能确认什么；没有来源时不得自由补造过去。"
};

const REDUNDANT_PRESENTATION_HEADINGS = [
  "一起想（模型分析与建议）",
  "模型解释（不代表你的历史记录或原话）",
  "模型解释",
  "新的推演（不代表你的历史记录或原话）",
  "新的推演",
  "新推演"
] as const;

export type DailyReflectionThinkingProviderInput = {
  mode: ThinkingMode;
  contextMode: ContextMode;
  message: string;
  history: DailyReflectionThinkingMessage[];
  sources: DailyReflectionThinkingSource[];
  settingsStore: JsonStore;
  signal?: AbortSignal;
};

export interface ThinkingConversationProvider {
  readonly model: string;
  generate(input: DailyReflectionThinkingProviderInput): Promise<DailyReflectionThinkingProviderOutput>;
}

export class DailyReflectionThinkingProviderUnavailableError extends Error {
  constructor(options: { cause?: unknown } = {}) {
    super("Daily Reflection Thinking Provider is unavailable", options);
    this.name = "DailyReflectionThinkingProviderUnavailableError";
  }
}

export class DailyReflectionThinkingProviderTimeoutError extends Error {
  constructor() {
    super("Daily Reflection Thinking Provider timed out");
    this.name = "DailyReflectionThinkingProviderTimeoutError";
  }
}

type ProviderDependencies = {
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxAttempts?: number;
  fetch?: typeof globalThis.fetch;
  clientFactory?: (store: JsonStore) => Promise<OpenAI>;
  requestText?: (
    client: OpenAI,
    model: string,
    systemPrompt: string,
    userPrompt: string,
    signal: AbortSignal
  ) => Promise<string>;
};

function historyForPrompt(
  history: DailyReflectionThinkingMessage[],
  sources: DailyReflectionThinkingSource[]
) {
  const allowedSourceIds = new Set(sources.map((source) => source.sourceId));
  return history
    .filter((message) => {
      if (message.role === "user") return true;
      if (
        message.safetyBoundaryVersion
        !== DAILY_REFLECTION_THINKING_SAFETY_BOUNDARY_VERSION
      ) return false;
      if (message.sources.length === 0) return true;
      return message.sources.every((source) => allowedSourceIds.has(source.sourceId));
    })
    .slice(-12)
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content}`)
    .join("\n");
}

function sourcesForPrompt(sources: DailyReflectionThinkingSource[]) {
  if (sources.length === 0) return "无个人来源。";
  return sources.map((source) => {
    const evidence = source.claim.evidence.map((item) => (
      `${item.recordingDate} ${item.sourceSegmentId}: ${item.snippet}`
    )).join(" | ");
    return `[${source.sourceId}] ${source.claim.text}\n证据：${evidence}`;
  }).join("\n\n");
}

export function buildDailyReflectionThinkingSystemPrompt(mode: ThinkingMode) {
  return [
    "你是 Daily Reflection 的‘一起想’助手。你的职责是帮助用户继续思考，不是替用户创造个人历史。",
    "answer 必须是可以直接展示给用户的自然中文纯文本回答：开门见山、连贯、具体，不要先评价这个请求、复述任务或解释你将如何回答。",
    "answer 可以使用自然段、换行和 1. 2. 3. 形式的普通编号；禁止 Markdown heading、星号强调、代码围栏、Markdown 链接、表格以及以 - 开头的模板列表。",
    "优先使用短自然段；只有并列方向或步骤确有帮助时才使用普通编号，不要把整篇回答机械写成清单。",
    "不要在 answer 中输出 JSON 字段名、分类标签、安全声明或‘模型解释／新的推演／不代表你的历史记录或原话’等展示前缀。",
    "严格区分结构化信息：personalContextClaims 只选择有 sourceId 支持的用户既有事实；interpretations 是补充解释；hypotheses 是新假设。后两个数组保持简短，不要机械重复 answer。",
    "answer 若自然提及用户过去的事实、决定、偏好或承诺，必须同时在 personalContextClaims 中给出支持它的 sourceId；没有支持时只能写成建议、问题或明确的可能性。",
    "只允许使用输入中列出的 sourceId；没有个人来源时 personalContextClaims 必须为空，但前四种开放模式仍要正常、完整地回答。",
    "回答保持克制、可继续对话，不做人格、心理或医学诊断。",
    `当前模式要求：${MODE_INSTRUCTIONS[mode]}`,
    "只输出一个 JSON 对象，字段必须且只能是 answer、personalContextClaims、interpretations、hypotheses。",
    "personalContextClaims 的每项格式为 {\"text\": string, \"sourceIds\": string[]}；其它两个字段为 string[]。"
  ].join("\n");
}

export function buildDailyReflectionThinkingUserPrompt(input: {
  message: string;
  history: DailyReflectionThinkingMessage[];
  sources: DailyReflectionThinkingSource[];
}) {
  const history = historyForPrompt(input.history, input.sources);
  return [
    "本轮用户消息：",
    input.message,
    "",
    "可用对话历史：",
    history || "无。",
    "",
    "本轮可信个人来源：",
    sourcesForPrompt(input.sources)
  ].join("\n");
}

function stripRedundantPresentationHeading(value: string) {
  let normalized = value.trim();
  for (const heading of REDUNDANT_PRESENTATION_HEADINGS) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    normalized = normalized.replace(
      new RegExp(`^(?:#{1,6}\\s*)?${escaped}\\s*[:：]\\s*`, "u"),
      ""
    );
  }
  return normalized.trim();
}

function normalizePlainTextLine(value: string) {
  let normalized = value
    .replace(/^\s*#{1,6}\s+/u, "")
    .replace(/^\s*>\s?/u, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, "$1（$2）")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/\*([^*\n]+)\*/gu, "$1")
    .replace(/_([^_\n]+)_/gu, "$1")
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/~~([^~]+)~~/gu, "$1")
    .replace(/\*\*|__/gu, "");

  if (normalized.includes("|")) {
    const cells = normalized.trim()
      .replace(/^\|/u, "")
      .replace(/\|$/u, "")
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    normalized = cells.join("；");
  }
  return normalized.trimEnd();
}

export function normalizeDailyReflectionThinkingPlainText(value: string) {
  const lines = stripRedundantPresentationHeading(value)
    .replace(/\r\n?/gu, "\n")
    .split("\n");
  const normalized: string[] = [];
  let bulletNumber = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(?:```|~~~)/u.test(trimmed)) continue;
    if (/^(?:[-*_]\s*){3,}$/u.test(trimmed)) continue;
    if (/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/u.test(trimmed)) continue;

    const bullet = line.match(/^\s*[-*+]\s+(.+)$/u);
    if (bullet) {
      bulletNumber += 1;
      normalized.push(`${bulletNumber}. ${normalizePlainTextLine(bullet[1] ?? "")}`);
      continue;
    }
    if (trimmed) bulletNumber = 0;
    normalized.push(normalizePlainTextLine(line));
  }
  return normalized.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function normalizeProviderPresentation(output: DailyReflectionThinkingProviderOutput) {
  return DailyReflectionThinkingProviderOutputSchema.parse({
    ...output,
    answer: normalizeDailyReflectionThinkingPlainText(output.answer),
    interpretations: output.interpretations.map(normalizeDailyReflectionThinkingPlainText),
    hypotheses: output.hypotheses.map(normalizeDailyReflectionThinkingPlainText)
  });
}

function parseProviderJson(text: string) {
  const trimmed = text.trim();
  const withoutFence = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "")
    : trimmed;
  return normalizeProviderPresentation(
    DailyReflectionThinkingProviderOutputSchema.parse(JSON.parse(withoutFence))
  );
}

export function projectDailyReflectionThinkingCanonicalClaims(
  claims: DailyReflectionThinkingProviderOutput["personalContextClaims"],
  sources: DailyReflectionThinkingSource[]
) {
  const sourcesById = new Map(sources.map((source) => [source.sourceId, source]));
  const projected = [];
  const projectedSourceIds = new Set<string>();
  for (const claim of claims) {
    for (const sourceId of claim.sourceIds) {
      const source = sourcesById.get(sourceId);
      if (!source) {
        throw new Error("Thinking Provider cited a source outside the allowlist");
      }
      if (projectedSourceIds.has(sourceId)) continue;
      projectedSourceIds.add(sourceId);
      projected.push({
        text: source.claim.text,
        sourceIds: [sourceId]
      });
    }
  }
  return projected;
}

function validateAndProjectProviderOutput(
  output: DailyReflectionThinkingProviderOutput,
  sources: DailyReflectionThinkingSource[]
) {
  const personalContextClaims = projectDailyReflectionThinkingCanonicalClaims(
    output.personalContextClaims,
    sources
  );
  return DailyReflectionThinkingProviderOutputSchema.parse({
    ...output,
    personalContextClaims
  });
}

function requestSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(
    parent?.reason instanceof Error
      ? parent.reason
      : new DOMException("Thinking request aborted", "AbortError")
  );
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(
    new DailyReflectionThinkingProviderTimeoutError()
  ), timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    }
  };
}

function abortedReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Thinking request aborted", "AbortError");
}

export class TokenHubThinkingConversationProvider implements ThinkingConversationProvider {
  readonly model = THINKING_MODEL;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly clientFactory: NonNullable<ProviderDependencies["clientFactory"]>;
  private readonly requestText: NonNullable<ProviderDependencies["requestText"]>;

  constructor(dependencies: ProviderDependencies = {}) {
    this.environment = dependencies.environment ?? process.env;
    this.timeoutMs = Math.max(1, Math.min(dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000));
    this.maxAttempts = Math.max(1, Math.min(dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 2));
    this.clientFactory = dependencies.clientFactory ?? (async () => (
      createThinkingTokenHubClient({
        environment: this.environment,
        timeoutMs: this.timeoutMs,
        fetch: dependencies.fetch
      })
    ));
    this.requestText = dependencies.requestText ?? requestThinkingTokenHubText;
  }

  async generate(input: DailyReflectionThinkingProviderInput) {
    const client = await this.clientFactory(input.settingsStore).catch((cause) => {
      throw new DailyReflectionThinkingProviderUnavailableError({ cause });
    });
    const systemPrompt = buildDailyReflectionThinkingSystemPrompt(input.mode);
    const userPrompt = buildDailyReflectionThinkingUserPrompt({
      message: input.message,
      history: input.history,
      sources: input.sources
    });
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const request = requestSignal(input.signal, this.timeoutMs);
      try {
        if (request.signal.aborted) throw abortedReason(request.signal);
        const text = await this.requestText(
          client,
          this.model,
          systemPrompt,
          userPrompt,
          request.signal
        );
        if (request.signal.aborted) throw abortedReason(request.signal);
        return validateAndProjectProviderOutput(parseProviderJson(text), input.sources);
      } catch (error) {
        lastError = request.signal.aborted ? abortedReason(request.signal) : error;
        if (input.signal?.aborted || lastError instanceof DailyReflectionThinkingProviderTimeoutError) {
          throw lastError;
        }
      } finally {
        request.cleanup();
      }
    }
    throw new DailyReflectionThinkingProviderUnavailableError({ cause: lastError });
  }
}

export function getThinkingConversationProvider() {
  return new TokenHubThinkingConversationProvider();
}
