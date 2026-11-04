import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { AgentTask } from "@/lib/domain/agent";
import {
  ThinkingMatterBeginTurnSchema, ThinkingMatterMutationSchema,
  ThinkingMatterSourceSchema,
  ThinkingMatterCreateSchema, ThinkingMatterComparisonInputSchema, ThinkingMatterChoiceInputSchema,
  type ThinkingMatterSource, type ThinkingMatterView, type ThinkingMatterMutation,
} from "@/lib/domain/reflection-thinking-matter";
import type { DailyReflectionThinkingSource } from "@/lib/domain/daily-reflection-thinking";
import { AgentRuntime } from "@/lib/server/agent/runtime";
import { AgentStore } from "@/lib/server/agent/store";
import { createAgentDecisionProvider } from "@/lib/server/agent/model";
import { AgentFailure, type AgentContext, type AgentDecisionProvider, type AgentScenario } from "@/lib/server/agent/types";
import { ThinkingMatterRepository } from "./thinking-matter-repository";
import { getDailyReflectionThinkingContextResolver } from "./thinking-context-resolver";
import { createThinkingTokenHubClient, THINKING_MODEL } from "./thinking-tokenhub-transport";
import { createDailyReflectionRepository, type DailyReflectionRepository } from "./repository";

export const THINKING_SCENARIO = "daily_reflection_thinking_v1";
export const THINKING_PROMPT_VERSION = "reflection_thinking_p3_v1";
const Scope = z.object({ matterId: z.string(), generationId: z.string(), matterVersion: z.number().int(), contextMode: z.enum(["none", "auto", "personal"]), inheritedSources: z.array(ThinkingMatterSourceSchema), explicitLinkedSources: z.array(ThinkingMatterSourceSchema).default([]) }).strict();
const CardId = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/u);
export const ThinkingMatterPublicCreateSchema = ThinkingMatterCreateSchema.omit({ source: true }).extend({
  sourceCardId: CardId.optional(), sourceCardVersion: z.number().int().nonnegative().optional(),
}).strict().refine(input => (input.sourceCardId === undefined) === (input.sourceCardVersion === undefined), "卡片和版本必须同时提供。");
export const ThinkingMatterLinkCardSchema = z.object({ operationKey: z.string().trim().min(1).max(512), expectedVersion: z.number().int().nonnegative(), cardId: CardId, cardVersion: z.number().int().nonnegative() }).strict();
export const ThinkingMatterUnlinkCardSchema = ThinkingMatterLinkCardSchema.omit({ cardVersion: true });
export const ThinkingMatterPublicTurnSchema = ThinkingMatterBeginTurnSchema.omit({ taskId: true, arrangementId: true, arrangementStatus: true, choice: true });
export const ThinkingMatterPublicMutationSchema = ThinkingMatterMutationSchema.refine(input => input.kind !== "link_source" && input.kind !== "unlink_source", "请通过卡片关联接口核对资料。 ");
const Query = z.object({ query: z.string().trim().min(1).max(512) }).strict();
const ReadSource = z.object({ sourceId: z.string().min(1).max(200), version: z.string().length(64), kind: z.enum(["card", "memory", "record"]) }).strict();
const Reply = z.object({
  reply: z.string().trim().min(1).max(8_000),
  understanding: z.string().trim().max(4_000),
  judgments: z.array(z.string().trim().min(1).max(2_000)).max(12),
  suggestions: z.array(z.object({ text: z.string().trim().min(1).max(2_000), kind: z.enum(["action", "decision"]) }).strict()).max(4)
    .describe("正文提出独立可执行尝试或行动性下一步时，必须同步为待采纳建议。候选方案、方向比较、倾向和推荐只写comparison，不因此生成安排；只讨论时为空。这里不会保存为已采纳安排。"),
  comparison: ThinkingMatterComparisonInputSchema.optional().describe("保存方案、理由、限制、成本和未知；推荐不是用户选择。新方案必须省略id，由服务端分配；仅更新已有方案时使用当前观察中的原id。首轮推荐必须optionId:null，在text用方案名称说明推荐对象；不得编造plan_a/plan_b等id。"),
}).strict();
type Resolver = ReturnType<typeof getDailyReflectionThinkingContextResolver>;
type CardReader = DailyReflectionRepository["readWorkingCardWithEvidence"];
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function reference(source: DailyReflectionThinkingSource): ThinkingMatterSource {
  return { sourceId: source.sourceId, kind: source.claim.sourceMemoryIds.includes(source.sourceId) ? "memory" : "card", version: digest(source.claim) };
}
function pack(refs: ThinkingMatterSource[]) { return Buffer.from(JSON.stringify(refs)).toString("base64url"); }
function unpack(id: string): ThinkingMatterSource[] { return z.array(ReadSource).parse(JSON.parse(Buffer.from(id, "base64url").toString())); }
function sameSource(left: ThinkingMatterSource, right: ThinkingMatterSource) { return left.kind === right.kind && left.sourceId === right.sourceId && left.version === right.version; }
function correctedInterpretations(view: ThinkingMatterView) {
  const corrections = view.events.filter(event => event.kind === "corrected");
  const last = corrections.at(-1)?.ordinal ?? -1;
  return new Set([...corrections.flatMap(event => Array.isArray(event.data.correctedEventIds) ? event.data.correctedEventIds.filter((id): id is string => typeof id === "string") : []),
    ...view.events.filter(event => event.kind === "assistant_message" && event.ordinal < last).map(event => event.id)]);
}

/** Only an explicit exact existing name/ID is a saved choice; ambiguity stays dialogue. */
export function explicitComparisonChoice(text: string, view: ThinkingMatterView) {
  const value = text.trim().replace(/[。！!]+$/u, "");
  // Questions, quoted examples and hypothetical/negated commands remain discussion.
  if (/[？?“”「」『』"]/u.test(value) || /(?:如果|假如|假设|要是|没有说|比如|例如)/u.test(value)) return null;
  const last = value.split(/[。；;\n]/u).at(-1)?.trim() ?? "";
  const command = last.replace(/^新约束[：:][^，,]*[，,]\s*/u, "");
  const previous = view.matter.userChoice;
  if (/^(?:先不决定|暂不决定|暂时不决定)(?:了)?$/u.test(command))
    return { status: "undecided" as const, optionId: null, reason: "", rejectedIds: previous.rejectedIds };
  const selected = /^(?:我(?:决定)?(?:改选|选择|选)|就选)\s*(.+?)(?:[，,]\s*(?:因为|理由是)\s*(.+))?$/u.exec(command);
  const leaning = /^我(?:目前|现在)?(?:更)?倾向(?:于)?\s*(.+?)(?:[，,]\s*(?:因为|理由是)\s*(.+))?$/u.exec(command);
  const rejected = /^(.+?)先不考虑(?:了)?$/u.exec(command);
  const match = selected ?? leaning ?? rejected;
  if (!match) return null;
  const target = match[1].trim();
  const matches = view.matter.comparison?.options.filter(option => option.id === target || option.name.normalize("NFKC") === target.normalize("NFKC")) ?? [];
  if (matches.length !== 1) return null;
  const optionId = matches[0].id;
  if (rejected) return { status: previous.optionId === optionId ? "undecided" as const : previous.status,
    optionId: previous.optionId === optionId ? null : previous.optionId, reason: "", rejectedIds: [...new Set([...previous.rejectedIds, optionId])] };
  return { status: selected ? "selected" as const : "leaning" as const, optionId, reason: match[2]?.trim() ?? "", rejectedIds: previous.rejectedIds.filter(id => id !== optionId) };
}

/** This policy is deliberately narrow: ambiguous assent stays a suggestion. */
export function explicitThinkingChoice(text: string) {
  const value = text.trim().replace(/[。！!\s]/gu, "");
  if (/^(?:就按这个做|把这一步记下来|好，就按这个做|就这么做|采纳这一步|把这个决定记下来)$/u.test(value)) return "adopt";
  if (/^(?:先暂停这件事|先暂停|暂停这件事|先放下这件事|这个方向先不考虑了)$/u.test(value)) return "pause";
  return null;
}
function feedbackStatus(text: string) {
  const value = text.trim();
  // A conditional question or quoted denial is feedback, not proof of execution.
  if (/^(?:如果|假如|假设|要是|我没有说|我不是说|不是说)/u.test(value)) return undefined;
  if (/^(?:我)?(?:还没(?:开始|做)|尚未开始|没有开始)/u.test(value)) return "not_started" as const;
  if (/^(?:我(?:已经)?试过了?|我已经做过|已经试过了?|已经做过)/u.test(value)) return "tried" as const;
  if (/^(?:我想换(?:一个|个)方向|(?:上次的|这个)建议不适合我)/u.test(value)) return "changed" as const;
  return undefined;
}
const INSTRUCTIONS = `你是日常复盘中的“一起想”。围绕当前事项自然讨论，保留五种思考模式。
按matter.mode回应：brainstorm打开不同方向；clarify_decision看清目标约束与取舍；compare_directions用一致维度比较；extend_idea延伸机制与边界；past_clues只依据获准可信来源找过去线索，没有来源则如实说明并可讨论当前问题。
先理解本轮用户的真实问题及已保存反馈。用户反馈是当前事实；过去建议和待确认判断不是个人事实。
自主决定直接分析、比较、追问，还是使用日常来源工具。已有观察足够时不搜索，不要求固定问题数量。
只使用当前账号的日常复盘获准资料；没有历史或未授权时照常讨论，不补造个人经历，不推断永久人格。
read_source 才是原始证据。引用、解释和猜测分开，judgments只放明确标为“待确认”的假设。
通过 respond 保存给用户的自然中文回答、当前理解及可选建议。它不会将建议变为已采纳行动。
如果正文已提出一个独立可执行的小尝试或行动性下一步，必须把同一内容同步写入 respond.args.suggestions，供用户明确采纳；不能只在 reply 里给出行动计划而让 suggestions 为空。建议文本应说明动作及最小范围，不扩充成任务清单。
信息已足够形成一个小尝试时可以直接提出，不必为每个非关键细节继续追问。只有纯讨论、比较或必要追问且没有具体下一步时，suggestions 才可以为空。
只有当前观察的 arrangements 中已经存在记录时才能说安排已保存；刚提出的建议、用户口头同意和实际执行仍分别处理，不虚构保存或完成结果。
用户只讨论或明确不要计划时 suggestions 必须为空；不要用行动建议绕过用户意愿。
已采纳安排不等于已执行，tried不等于完成；暂停不等于解决。用户纠正此前理解时按新信息改变方向，保留旧历史。
需要多方案比较时使用respond.comparison，比较同一问题的维度、各方案理由/限制/成本/未知信息。推荐只是Agent建议；userChoice只能由用户明确操作保存，绝不能把推荐描述成用户已选。
候选方向、比较取舍、倾向和推荐保存在comparison，不能仅因推荐方向就强制生成suggestions。用户只选择方向时记录choice即可，不要求行动安排或待办。
已有comparison更新保留方案id；用户反馈新约束时调整比较，不覆盖用户已保存选择或改选理由。只讨论比较不要求安排计划。
comparison.options中的id由服务端分配：新方案必须省略id字段，不填null、空字符串或自定义id；仅更新已有方案时使用当前观察comparison.options里的原id，不能编造plan_a/plan_b等id。
comparison.recommendation.optionId只能引用当前观察中已有方案的原id，或为null。首轮推荐必须optionId:null，并在text用方案名称说明推荐对象；本轮新增方案尚无服务端id，也应以null和文字表达推荐。
history中标为corrected的旧自动解释已经被用户修正，不是当前事实；以当前understanding和用户纠正为准。
linkedRecords是用户为此事项单独关联的日常卡片，只表明有该记录，不表示卡片中的推测已被确认，也不授权检索其他历史。
本轮回复完成后交回用户，事项仍可能进行中。不能写长期Memory、办公Todo或其他产品。
例：用户已经试过最小页面并反馈“技术没问题，不知道展示什么内容”，应讨论展示内容，不重复建议学技术或缩小技术范围。`;

export class ThinkingAgentService {
  readonly repository: ThinkingMatterRepository;
  readonly store: AgentStore;
  readonly runtime: AgentRuntime;
  private readonly resolver: Resolver;
  private readonly cardReader: CardReader;
  private readonly inspections = new Set<string>();
  constructor(database: Database.Database, options: { decision?: AgentDecisionProvider; resolver?: Resolver; checkpointPath?: string; cardReader?: CardReader } = {}) {
    this.repository = new ThinkingMatterRepository(database);
    this.store = new AgentStore(database);
    this.resolver = options.resolver ?? getDailyReflectionThinkingContextResolver();
    const cards = createDailyReflectionRepository(database);
    this.cardReader = options.cardReader ?? ((accountId, cardId) => cards.readWorkingCardWithEvidence(accountId, cardId));
    this.runtime = new AgentRuntime({ store: this.store,
      checkpointPath: options.checkpointPath ?? (database.name === ":memory:" ? ":memory:" : join(dirname(database.name), "reflection-thinking-checkpoints.sqlite")),
      scenario: this.scenario(), decision: options.decision ?? createAgentDecisionProvider(() => {
        // Reuse the existing product's allowlisted endpoint, model and credential policy.
        let client;
        try { client = createThinkingTokenHubClient({ environment: process.env, timeoutMs: 45_000 }); }
        catch { throw new AgentFailure("known_failure", "一起想暂未配置可用模型，本轮没有发出请求。"); }
        return { baseURL: client.baseURL, apiKey: client.apiKey, model: THINKING_MODEL, maxInputChars: 48_000,
          maxOutputTokens: 4_000, requestTimeoutMs: 45_000,
          ...(process.env.OPENAI_AUTH_HEADER_MODE?.trim().toLowerCase() === "raw" ? { defaultHeaders: { Authorization: client.apiKey } } : {}) };
      }),
    });
  }
  close() { this.runtime.close(); }
  private canonicalCard(accountId: string, cardId: string, expectedVersion?: number) {
    const detail = this.cardReader(accountId, cardId);
    if (detail.card.accountId !== accountId || detail.card.id !== cardId || detail.card.status !== "saved" || detail.card.sourceUnavailable || !detail.evidence.length
      || (expectedVersion !== undefined && detail.card.version !== expectedVersion)) throw new AgentFailure("source_changed", "卡片不存在、已变化或原始依据不可用，请重新查看后关联。");
    return detail;
  }
  private cardReference(accountId: string, cardId: string, expectedVersion: number): ThinkingMatterSource {
    try { return { sourceId: cardId, kind: "card", version: digest(this.canonicalCard(accountId, cardId, expectedVersion)) }; }
    catch { throw new AgentFailure("source_changed", "卡片不存在、无权访问或版本已变化。"); }
  }
  create(accountId: string, raw: unknown) {
    const publicInput = ThinkingMatterPublicCreateSchema.parse(raw);
    const { sourceCardId, sourceCardVersion, ...input } = publicInput;
    const result = this.repository.create(accountId, input, sourceCardId === undefined ? undefined : {
      receiptInput: publicInput,
      beforeWrite: parsed => ({ ...parsed, source: this.cardReference(accountId, sourceCardId, sourceCardVersion!) }),
    });
    return this.safeView(accountId, result);
  }
  linkCard(accountId: string, matterId: string, raw: unknown) {
    const publicInput = ThinkingMatterLinkCardSchema.parse(raw);
    const { cardId, cardVersion, ...input } = publicInput;
    // A draft is only a stable request identity. The guarded resolver replaces it
    // inside the repository transaction, after an exact receipt lookup.
    return this.saveMutation(accountId, matterId, { ...input, kind: "link_source", source: { sourceId: cardId, kind: "card", version: String(cardVersion) } }, {
      receiptInput: publicInput, resolveSource: () => this.cardReference(accountId, cardId, cardVersion),
    });
  }
  unlinkCard(accountId: string, matterId: string, raw: unknown) {
    const { cardId, ...input } = ThinkingMatterUnlinkCardSchema.parse(raw);
    return this.mutate(accountId, matterId, { ...input, kind: "unlink_source", sourceId: cardId });
  }
  private source(accountId: string, ref: ThinkingMatterSource) {
    if (ref.kind === "card") {
      try {
        const detail = this.canonicalCard(accountId, ref.sourceId);
        if (digest(detail) === ref.version) return { sourceId: ref.sourceId, savedCard: detail.card, evidence: detail.evidence };
      } catch { /* Existing retrieval references still use their canonical claim version. */ }
    }
    const result = this.resolver.resolve({ accountId, message: "核对这条记录", mode: "brainstorm", contextMode: "personal",
      pinnedCardIds: ref.kind === "card" ? [ref.sourceId] : [], pinnedMemoryIds: ref.kind === "memory" ? [ref.sourceId] : [],
    });
    return result.sources.find(source => source.sourceId === ref.sourceId && reference(source).version === ref.version);
  }
  private authorizedSource(accountId: string, view: ThinkingMatterView, ref: ThinkingMatterSource, permission = view.matter.contextMode !== "none") {
    const source = this.source(accountId, ref);
    const linked = view.matter.linkedSources.some(item => sameSource(item, ref));
    return source && (linked || (permission && !("savedCard" in source))) ? source : undefined;
  }
  private safeView(accountId: string, view: ThinkingMatterView, permission = view.matter.contextMode !== "none", allowedSources?: ThinkingMatterSource[]) {
    // Do not resend cached assistant excerpts/interpretations after a source is withdrawn.
    const valid = new Map<string, boolean>();
    for (const event of view.events) valid.set(event.id, event.sources.length === 0 || event.sources.every(ref =>
      (!allowedSources || allowedSources.some(allowed => sameSource(allowed, ref))) && Boolean(this.authorizedSource(accountId, view, ref, permission))));
    const corrected = correctedInterpretations(view);
    const suggestionValid = (id: unknown) => {
      const suggestion = view.matter.suggestions.find(item => item.id === id);
      return Boolean(suggestion && valid.get(suggestion.sourceEventId));
    };
    const events = view.events.map(event => {
      const allowed = valid.get(event.id) && (event.kind !== "adopted" || suggestionValid(event.data.suggestionId));
      const { previousText: _previous, suggestionText: _suggestion, previousUnderstanding: _understanding, previousJudgments: _judgments,
        previousComparison: _comparison, comparison: _currentComparison, ...data } = event.data;
      if (!allowed) return { ...event, text: "此前自动分析的来源已失效或未获准，本轮不可使用。", data: { interpretationStatus: "unavailable" }, sources: [] };
      return corrected.has(event.id) ? { ...event, text: `【此前解释已被用户修正，不再是当前判断】${event.text}`, data: { interpretationStatus: "corrected" } } : { ...event, data };
    }).map(event => {
      const linked = view.matter.linkedSources.filter(source => source.sourceEventId === event.id);
      return linked.length ? { ...event, data: { ...event.data, linkedSourceAvailability: linked.map(({ sourceId, kind, version }) => ({ sourceId, kind, version,
        status: this.authorizedSource(accountId, view, { sourceId, kind, version }, false) ? "available" : "unavailable" })) } } : event;
    });
    const latestAssistant = [...view.events].reverse().find(event => event.kind === "assistant_message");
    const understandingEventId = view.matter.understandingSourceEventId ?? latestAssistant?.id;
    const judgmentsEventId = view.matter.judgmentsSourceEventId ?? latestAssistant?.id;
    const contaminated = understandingEventId && (!valid.get(understandingEventId) || corrected.has(understandingEventId));
    const invalidJudgments = judgmentsEventId && (!valid.get(judgmentsEventId) || corrected.has(judgmentsEventId));
    const safeSuggestions = view.matter.suggestions.filter(suggestion => valid.get(suggestion.sourceEventId) && !corrected.has(suggestion.sourceEventId));
    const comparison = view.matter.comparison;
    const activeInterpretation = (eventId: string) => Boolean(valid.get(eventId)) && !corrected.has(eventId);
    const safeComparison = comparison ? { ...comparison,
      question: activeInterpretation(comparison.sourceEventId) ? comparison.question : "此前比较的依据已失效或解释已被修正。",
      dimensions: activeInterpretation(comparison.sourceEventId) ? comparison.dimensions : [],
      options: comparison.options.map((option, index) => activeInterpretation(option.sourceEventId) ? option : { ...option,
        name: `此前方案 ${index + 1}（依据已失效或已修正）`, content: "旧自动内容不可作为当前依据，请重新核对。", reasons: [], limits: [], costs: [], unknowns: [] }),
      recommendation: comparison.recommendation && activeInterpretation(comparison.recommendation.sourceEventId) ? comparison.recommendation : null,
    } : null;
    return { matter: { ...view.matter,
      understanding: contaminated ? "此前自动理解不可作为本轮依据，请以用户新表达为准。" : view.matter.understanding,
      judgments: invalidJudgments ? [] : view.matter.judgments,
      comparison: safeComparison,
      suggestions: safeSuggestions,
      arrangements: view.matter.arrangements.map(item => suggestionValid(item.suggestionId) || view.events.some(event => event.kind === "edited" && event.data.arrangementId === item.id)
        ? item : { ...item, text: "用户曾采纳安排；此前自动摘录来源现不可用。" }),
    }, events };
  }
  async get(accountId: string, matterId: string) { return this.safeView(accountId, this.repository.get(accountId, matterId)); }
  async list(accountId: string) {
    return Promise.all(this.repository.list(accountId).map(async matter => (await this.get(accountId, matter.id)).matter));
  }
  async recover(accountId: string, matterId: string, operationKey: string) {
    const view = this.repository.get(accountId, matterId);
    const taskId = view.matter.activeGeneration?.taskId;
    if (!taskId) return this.get(accountId, matterId);
    const task = this.store.getTask(accountId, taskId);
    if (task.scenario !== THINKING_SCENARIO || task.resourceId !== matterId) throw new AgentFailure("forbidden", "事项与回复任务不匹配。");
    // Inspection only. The shared runtime forbids model calls in recovery checks.
    if (this.inspections.has(taskId)) return this.get(accountId, matterId);
    this.inspections.add(taskId);
    try { await this.runtime.recover(accountId, taskId, { expectedVersion: task.version ?? 1, mode: "inspect", eventId: operationKey, defer: true }); }
    finally { this.inspections.delete(taskId); }
    return this.get(accountId, matterId);
  }
  private scope(ctx: AgentContext) { return Scope.parse(ctx.task.scope); }
  private committed(ctx: AgentContext) {
    const scope = this.scope(ctx);
    return this.repository.get(ctx.task.accountId, scope.matterId).events.find(event => event.kind === "assistant_message" && event.data.generationId === scope.generationId);
  }
  private exposed(ctx: AgentContext) {
    const refs: ThinkingMatterSource[] = [];
    for (const action of this.store.getTask(ctx.task.accountId, ctx.task.id).actions) {
      if (action.status !== "succeeded" || action.resultRef?.kind !== "reflection_thinking_sources") continue;
      refs.push(...unpack(action.resultRef.id));
    }
    return [...new Map(refs.map(ref => [`${ref.sourceId}:${ref.version}`, ref])).values()];
  }
  private responseSources(accountId: string, inherited: ThinkingMatterSource[], exposed: ThinkingMatterSource[]) {
    if ([...inherited, ...exposed].some(ref => !this.source(accountId, ref))) throw new AgentFailure("source_changed", "本轮资料已变化，请重新讨论。");
    const sources = [...new Map([...inherited, ...exposed].map(ref => [ref.sourceId, ref])).values()];
    if (sources.length > 32) throw new AgentFailure("budget", "本轮来源数量超出可验证上限，请缩小资料范围或仅根据当前表达讨论。");
    return sources;
  }
  private async publish(ctx: AgentContext, input: z.infer<typeof Reply>) {
    const scope = this.scope(ctx);
    const view = this.repository.get(ctx.task.accountId, scope.matterId);
    // Carry live provenance forward when summaries use prior assistant reasoning.
    const sources = this.responseSources(ctx.task.accountId, scope.inheritedSources, this.exposed(ctx));
    const latest = [...view.events].reverse().find(event => event.kind === "user_message" || event.kind === "feedback");
    // This is an enforceable user choice, in addition to the model instruction.
    const discussionOnly = /(?:只想讨论|只讨论|不要(?:安排)?计划|不需要行动计划|今天不(?:要|安排).*计划)/u.test(latest?.text ?? "");
    await ctx.assertActive();
    this.repository.commitResponse(ctx.task.accountId, scope.matterId, { generationId: scope.generationId, expectedVersion: scope.matterVersion,
      ...input, suggestions: discussionOnly ? [] : input.suggestions, sources, taskId: ctx.task.id, promptVersion: THINKING_PROMPT_VERSION, model: THINKING_MODEL });
    return { ref: { kind: "reflection_thinking_response", id: scope.generationId }, summary: "本轮回复已保存，等待用户继续。", handoff: "本轮讨论已交回用户；事项状态与行动执行状态保持独立。" };
  }
  private scenario(): AgentScenario {
    return { id: THINKING_SCENARIO, instructions: INSTRUCTIONS,
      validate: async ctx => {
        const scope = this.scope(ctx), view = this.repository.get(ctx.task.accountId, scope.matterId);
        if (this.committed(ctx)) return;
        // Failure bookkeeping increments business version. Inspection may examine
        // that same unresolved binding, but publish retains the original strict fence.
        if (this.inspections.has(ctx.task.id) && view.matter.activeGeneration?.status === "unknown"
          && view.matter.activeGeneration.id === scope.generationId && view.matter.activeGeneration.taskId === ctx.task.id) return;
        if (view.matter.status !== "active" || view.matter.version !== scope.matterVersion || view.matter.activeGeneration?.id !== scope.generationId)
          throw new AgentFailure("source_changed", "事项已被修改、暂停或取消，本轮结果不能写回。");
        if (scope.inheritedSources.length > 32) throw new AgentFailure("budget", "本轮来源超过可核实上限，请缩小资料范围。");
        if (scope.inheritedSources.some(ref => !this.authorizedSource(ctx.task.accountId, view, ref, scope.contextMode !== "none"))) throw new AgentFailure("source_changed", "本轮使用的历史资料已经变化或已撤回授权。");
      },
      observe: async ctx => {
        const scope = this.scope(ctx), view = await this.safeView(ctx.task.accountId, this.repository.get(ctx.task.accountId, scope.matterId), scope.contextMode !== "none", scope.inheritedSources);
        // Full history is durable; only the model projection is bounded. Keep the first problem,
        // current arrangements and the latest feedback outside the message window.
        const compact = (event: ThinkingMatterView["events"][number]) => ({ ...event,
          text: event.data.interpretationStatus === "corrected" ? "此前自动解释已被用户修正，不再作为当前事实。" : event.text.slice(0, 1_200),
          data: event.data.interpretationStatus === "corrected" ? { interpretationStatus: "corrected" } : {} });
        return { matter: { ...view.matter, question: view.matter.question.slice(0, 2_000), goal: view.matter.goal.slice(0, 2_000),
            understanding: view.matter.understanding.slice(0, 2_000), judgments: view.matter.judgments.slice(-8).map(text => text.slice(0, 300)),
            suggestions: view.matter.suggestions.slice(-8), arrangements: view.matter.arrangements.slice(-8) },
          history: view.events.slice(-12).map(compact), historyCount: view.events.length,
          latestFeedback: (() => { const event = [...view.events].reverse().find(event => event.kind === "feedback"); return event ? compact(event) : null; })(),
          recentChanges: view.events.filter(event => ["choice_changed", "corrected", "comparison_edited", "status_changed"].includes(event.kind)).slice(-6).map(event => ({ ...compact(event),
            data: event.kind === "choice_changed" ? { previousChoice: event.data.previousChoice, choice: event.data.choice, reason: event.data.reason }
              : event.kind === "corrected" ? { correctedEventIds: event.data.correctedEventIds, reason: event.data.reason } : {} })),
          linkedRecords: scope.explicitLinkedSources.flatMap(ref => { const source = this.authorizedSource(ctx.task.accountId, view, ref, false); return source ? [{ ref,
            text: ("savedCard" in source ? `${source.savedCard.title}\n${source.savedCard.content}` : source.claim.text).slice(0, 2_000),
            caution: "这是用户关联的已保存记录；其中的自动解释或推测不表示已确认事实。" }] : []; }),
          historyNotice: view.events.length > 18 ? "较早对话已保存，可用read_matter按序读取；不是丢失。" : null };
      },
      finish: async (reason, ctx) => { await this.publish(ctx, { reply: reason, understanding: "", judgments: [], suggestions: [] }); return "本轮已回复，事项并未自动解决。"; },
      tools: {
        read_matter: { description: "读取当前事项、已采纳安排和保存历史；offset用于读取更早对话。", parameters: z.object({ offset: z.number().int().nonnegative().default(0) }).strict(),
          execute: async (_args, ctx) => ({ ref: { kind: "reflection_thinking_matter", id: ctx.actionId }, summary: "已读取事项的当前进展。" }),
          readResult: async (receipt, ctx) => { const args = this.store.action(ctx.task.accountId, ctx.task.id, receipt.id).args as { offset: number };
            const scope = this.scope(ctx);
            const view = await this.safeView(ctx.task.accountId, this.repository.get(ctx.task.accountId, scope.matterId), scope.contextMode !== "none", scope.inheritedSources);
            return { events: view.events.slice(args.offset, args.offset + 8).map(event => ({ ...event,
              text: event.data.interpretationStatus === "corrected" ? "此前自动解释已被用户修正，不再作为当前事实。" : event.text.slice(0, 2_000),
              data: event.data.interpretationStatus === "corrected" ? { interpretationStatus: "corrected" } : {} })), total: view.events.length }; },
        },
        search_records: { description: "按需查找用户允许的日常卡片和已保存记忆；未获准时返回无资料，不能跨产品查找。", parameters: Query,
          execute: async (args, ctx) => {
            const scope = this.scope(ctx); if (scope.contextMode === "none") return { summary: "用户本轮未允许使用日常资料。" };
            const { query } = Query.parse(args);
            const sources = this.resolver.resolve({ accountId: ctx.task.accountId, message: query, mode: "brainstorm", contextMode: "personal" }).sources;
            return { ref: { kind: "reflection_thinking_sources", id: pack(sources.map(reference)) }, summary: `找到${sources.length}条当前可用日常来源。` };
          },
          readResult: async (receipt, ctx) => ({ sources: receipt.resultRef ? unpack(receipt.resultRef.id).flatMap(ref => { const source = this.source(ctx.task.accountId, ref); return source ? [{ ...ref, text: "savedCard" in source ? `${source.savedCard.title}\n${source.savedCard.content}` : source.claim.text }] : []; }) : [] }),
        },
        read_source: { description: "重新核对一条检索来源的版本与原始证据；来源失效不返回旧摘录。", parameters: ReadSource,
          execute: async (args, ctx) => {
            const ref = ReadSource.parse(args);
            const scope = this.scope(ctx);
            if (!scope.explicitLinkedSources.some(item => sameSource(item, ref)) && (scope.contextMode === "none" || !this.exposed(ctx).some(item => sameSource(item, ref)))) throw new AgentFailure("forbidden", "来源不在本轮获准范围。");
            if (!this.source(ctx.task.accountId, ref)) throw new AgentFailure("source_changed", "来源已失效。");
            return { ref: { kind: "reflection_thinking_sources", id: pack([ref]) }, summary: "已核对原始依据。" };
          },
          readResult: async (receipt, ctx) => ({ sources: receipt.resultRef ? unpack(receipt.resultRef.id).flatMap(ref => { const source = this.source(ctx.task.accountId, ref); return source ? [{ ...ref, value: source }] : []; }) : [] }),
        },
        respond: { description: "保存自然回答、当前理解与待确认判断。正文提出独立可执行尝试或行动性下一步时，在suggestions同步登记待采纳建议；方向比较和推荐仅用comparison，纯讨论时suggestions为空。不会自动采纳或完成。", parameters: Reply,
          execute: async (args, ctx) => this.publish(ctx, Reply.parse(args)),
          validateResult: async (_result, ctx) => { if (!this.committed(ctx)) throw new AgentFailure("unknown", "尚未核实本轮回复回执。"); },
          recover: async (_id, ctx) => this.committed(ctx) ? { ref: { kind: "reflection_thinking_response", id: this.scope(ctx).generationId }, summary: "已找到原回复，没有重复生成。", handoff: "已交回用户。" } : null,
        },
      },
    };
  }
  mutate(accountId: string, matterId: string, raw: unknown) {
    const input = ThinkingMatterMutationSchema.parse(raw);
    return this.saveMutation(accountId, matterId, input);
  }
  private saveMutation(accountId: string, matterId: string, input: ThinkingMatterMutation, prepared?: { receiptInput: unknown; resolveSource: () => ThinkingMatterSource }) {
    const before = this.repository.get(accountId, matterId);
    const result = this.repository.mutate(accountId, matterId, input, { ...(prepared ? { receiptInput: prepared.receiptInput } : {}), beforeWrite: parsed => {
      if (parsed.kind === "adopt") {
        const suggestion = before.matter.suggestions.find(item => item.id === parsed.suggestionId);
        const origin = before.events.find(event => event.id === suggestion?.sourceEventId);
        if (suggestion?.status === "proposed" && origin && (correctedInterpretations(before).has(origin.id) || origin.sources.some(ref => !this.authorizedSource(accountId, before, ref))))
          throw new AgentFailure("source_changed", "建议使用的资料已失效或撤回，请先重新讨论再采纳。");
      }
      if (parsed.kind === "choice") this.validateChoice(accountId, before, parsed);
      if (parsed.kind === "link_source") {
        const source = prepared?.resolveSource() ?? parsed.source;
        if (source.kind !== "card" || !this.source(accountId, source)) throw new AgentFailure("source_changed", "关联卡片已失效。");
        return { ...parsed, source };
      }
      return parsed;
    } });
    if (before.matter.activeGeneration?.taskId && !result.matter.activeGeneration) {
      try { this.runtime.control(accountId, before.matter.activeGeneration.taskId, "cancel"); } catch { /* Business fence already invalidated the generation. */ }
    }
    return this.safeView(accountId, result);
  }
  private validateChoice(accountId: string, view: ThinkingMatterView, input: z.infer<typeof ThinkingMatterChoiceInputSchema>) {
    for (const id of [input.optionId, ...input.rejectedIds ?? []].filter(Boolean)) {
      const option = view.matter.comparison?.options.find(item => item.id === id);
      const origin = view.events.find(event => event.id === option?.sourceEventId);
      if (origin && (correctedInterpretations(view).has(origin.id) || origin.sources.some(ref => !this.authorizedSource(accountId, view, ref))))
        throw new AgentFailure("source_changed", "方案的自动依据已失效或被修正，请先重新核对方案。");
    }
  }
  async turn(accountId: string, matterId: string, raw: unknown, signal?: AbortSignal) {
    const input = ThinkingMatterPublicTurnSchema.parse(raw);
    const taskId = digest([accountId, matterId, input.operationKey]);
    const before = this.repository.get(accountId, matterId);
    // Begin with one stable, idempotent receipt, before any explicit business command.
    const choice = explicitThinkingChoice(input.text);
    const previousTurn = before.events.find(event => event.data.taskId === taskId && ["user_message", "feedback"].includes(event.kind));
    // The saved command belongs to this exact input, even after an option is renamed.
    // Choice, user message and generation share the repository's single transaction.
    const comparisonChoice = previousTurn
      ? (previousTurn.data.choice ? ThinkingMatterChoiceInputSchema.parse(previousTurn.data.choice) : null)
      : explicitComparisonChoice(input.text, before);
    if (comparisonChoice && !previousTurn) this.validateChoice(accountId, before, comparisonChoice);
    const feedback = input.feedback === true || /试过|还没|尚未|不适合我|换个?方向|发现/u.test(input.text);
    const arrangement = before.matter.arrangements.length === 1 ? before.matter.arrangements[0] : undefined;
    const status = feedbackStatus(input.text);
    const progress = previousTurn ? (previousTurn.data.arrangementId ? { arrangementId: previousTurn.data.arrangementId as string,
      arrangementStatus: previousTurn.data.arrangementStatus as "tried" | "not_started" | "changed" } : {})
      : (feedback && arrangement && status ? { arrangementId: arrangement.id, arrangementStatus: status } : {});
    const started = this.repository.beginTurn(accountId, matterId, { ...input, feedback, taskId,
      ...progress, ...(comparisonChoice ? { choice: comparisonChoice } : {}) });
    const current = this.repository.get(accountId, matterId);
    if (current.events.some(event => event.kind === "assistant_message" && event.data.generationId === started.generationId)) return this.get(accountId, matterId);
    if (current.matter.activeGeneration?.status === "unknown") return this.get(accountId, matterId);
    if (choice === "pause") return this.mutate(accountId, matterId, { kind: "status", status: "paused", reason: input.text,
      operationKey: `${input.operationKey}:pause`, expectedVersion: started.version });
    if (choice === "adopt") {
      if (current.events.some(event => event.kind === "adopted" && event.matterVersion === started.version + 1)) return this.get(accountId, matterId);
      const proposed = this.safeView(accountId, current).matter.suggestions.filter(item => item.status === "proposed");
      if (proposed.length === 1) {
        return this.mutate(accountId, matterId, { kind: "adopt", suggestionId: proposed[0].id, operationKey: `${input.operationKey}:adopt`, expectedVersion: started.version });
      }
    }
    const corrected = correctedInterpretations(current);
    const explicitLinkedSources = current.matter.linkedSources.filter(ref => Boolean(this.authorizedSource(accountId, current, ref, false))).map(({ sourceId, kind, version }) => ({ sourceId, kind, version }));
    const inheritedSources = [...new Map([...explicitLinkedSources, ...current.events.filter(event => event.kind === "assistant_message" && !corrected.has(event.id))
      .flatMap(event => event.sources).filter(ref => Boolean(this.authorizedSource(accountId, current, ref)))].map(ref => [`${ref.sourceId}:${ref.version}`, ref])).values()];
    const task = this.store.listTasks(accountId, matterId).find(task => task.id === taskId) ?? this.store.createTask({ id: taskId, accountId, scenario: THINKING_SCENARIO, resourceId: matterId, goal: input.text.slice(0, 1_800),
      scope: { matterId, generationId: started.generationId, matterVersion: started.version, contextMode: current.matter.contextMode, inheritedSources, explicitLinkedSources },
      budget: { maxCalls: 8, maxSteps: 10, maxInputChars: 48_000, maxOutputTokens: 4_000, maxComputeMs: 180_000, maxNoProgress: 3 } });
    const abort = () => { try { this.mutate(accountId, matterId, { kind: "cancel", generationId: started.generationId, operationKey: `${input.operationKey}:abort`, expectedVersion: started.version }); } catch { /* A concurrent edit is already a fence. */ } };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) { abort(); return this.get(accountId, matterId); }
      const result = task.status === "ready" ? await this.runtime.advance(accountId, taskId) : this.store.getTask(accountId, taskId);
      const latest = this.repository.get(accountId, matterId);
      if (latest.matter.activeGeneration?.id === started.generationId) {
        if (result.status === "waiting" && result.wait?.kind === "feedback") {
          const exposed = result.actions.flatMap(action => action.resultRef?.kind === "reflection_thinking_sources" ? unpack(action.resultRef.id) : []);
          const sources = this.responseSources(accountId, Scope.parse(result.scope).inheritedSources, exposed);
          this.repository.commitResponse(accountId, matterId, { generationId: started.generationId, expectedVersion: started.version, reply: result.wait.message,
            suggestions: [], sources, taskId, promptVersion: THINKING_PROMPT_VERSION, model: THINKING_MODEL });
        } else if (result.status !== "running") {
          const unknown = result.recovery?.kind === "unknown";
          this.repository.failResponse(accountId, matterId, { generationId: started.generationId, expectedVersion: started.version,
            status: unknown ? "unknown" : "known_failed", text: unknown ? "本轮回复结果未知，已停止自动推进。请先核对或取消本轮。" : "本轮回复未完成，用户输入已保存。可以修正后继续讨论。" });
        }
      }
      return this.get(accountId, matterId);
    } catch (error) {
      const latest = this.repository.get(accountId, matterId);
      if (latest.matter.version === started.version && latest.matter.activeGeneration?.id === started.generationId) {
        const known = error instanceof AgentFailure && error.code !== "unknown";
        this.repository.failResponse(accountId, matterId, { generationId: started.generationId, expectedVersion: started.version,
          status: known ? "known_failed" : "unknown", text: known ? "本轮未能核实当前资料，已停止回复；原输入保留。" : "本轮结果尚未确认，不会自动重发。" });
        return this.get(accountId, matterId);
      }
      throw error;
    } finally { signal?.removeEventListener("abort", abort); }
  }
  task(accountId: string, matterId: string): Pick<AgentTask, "id" | "status" | "usage" | "recovery"> | undefined {
    this.repository.get(accountId, matterId);
    const task = this.store.listTasks(accountId, matterId).find(task => task.scenario === THINKING_SCENARIO);
    return task ? { id: task.id, status: task.status, usage: task.usage, recovery: task.recovery ? { ...task.recovery, message: "请核对本轮结果或明确取消，不会自动重发。" } : undefined } : undefined;
  }
}
