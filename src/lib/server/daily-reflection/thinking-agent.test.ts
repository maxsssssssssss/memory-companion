// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { openDailyReflectionDatabase } from "./db";
import { ThinkingAgentService, explicitThinkingChoice, explicitComparisonChoice, THINKING_PROMPT_VERSION } from "./thinking-agent";
import { agentDecisionRequest } from "@/lib/server/agent/model";
import { AgentFailure, type AgentDecisionProvider, type AgentDecision } from "@/lib/server/agent/types";
import type { DailyReflectionThinkingSource } from "@/lib/domain/daily-reflection-thinking";
import type { ThinkingMatterView, ThinkingMatterComparisonInput } from "@/lib/domain/reflection-thinking-matter";
import { ThinkingMatterComparisonInputSchema } from "@/lib/domain/reflection-thinking-matter";
import { DailyReflectionWorkingCardSchema } from "@/lib/domain/daily-reflection-working-card";
import type { DailyReflectionRepository } from "./repository";

const instances: ThinkingAgentService[] = [];
afterEach(() => { for (const service of instances.splice(0)) { service.close(); service.store.close(); } vi.restoreAllMocks(); });
const answer = (reply: string, suggestion?: string): AgentDecision => ({ tool: "respond", args: { reply, understanding: reply,
  judgments: ["待确认：目前的困难是否主要来自范围。"], suggestions: suggestion ? [{ text: suggestion, kind: "action" }] : [] } });
function setup(choose: AgentDecisionProvider, sourceReader?: () => DailyReflectionThinkingSource[], cardReader?: DailyReflectionRepository["readWorkingCardWithEvidence"]) {
  const decision: AgentDecisionProvider = (input, context) => context.call({ kind: "offline_fixture_decision", model: "synthetic_no_provider", inputChars: JSON.stringify(input.observation).length, maxOutputTokens: 1000 },
    async () => ({ value: await choose(input, context), usage: { inputTokens: 5, outputTokens: 7 } }));
  const resolver = { resolve: vi.fn(() => ({ sources: sourceReader?.() ?? [], promptExcerpts: [], usedPersonalContext: Boolean(sourceReader?.().length), pastClues: null })) };
  const service = new ThinkingAgentService(openDailyReflectionDatabase({ filePath: ":memory:" }), { decision, resolver, cardReader });
  instances.push(service);
  const created = service.repository.create("account_a", { question: "我总是修改作品计划，一直没有开始。", operationKey: "create" });
  let sequence = 0;
  return { service, resolver, created,
    turn: (view: ThinkingMatterView, text: string, extra = {}) => service.turn("account_a", view.matter.id, { operationKey: `turn_${++sequence}`, expectedVersion: view.matter.version, text, ...extra }) };
}
function source(): DailyReflectionThinkingSource { return { sourceId: "card_one", claim: { text: "用户曾保存：希望展示自己的手工作品。", sourceCardIds: ["card_one"], sourceMemoryIds: [],
  evidenceIds: ["seg_one"], epistemicStatuses: ["explicit_user_statement"], evidence: [{ sourceSegmentId: "seg_one", cardId: "card_one", reflectionId: "reflection_one", sourceOrigin: "user_reflection",
    recordingDate: "2026-11-02", startSeconds: 0, endSeconds: 5, snippet: "我想展示自己的手工作品。" }] } }; }

describe("Thinking Agent P1 business loop (synthetic decisions, formal SQLite service)", () => {
  it("A/B creates, clarifies, proposes, explicitly adopts, reopens and changes direction on actual feedback", async () => {
    const observations: unknown[] = [];
    const h = setup(async input => { observations.push(input.observation);
      if (input.task.goal.includes("技术其实没问题")) return answer("既然技术已验证，我们改为讨论展示什么内容：先选一件最能说明过程的作品。", "选一件作品，写出想展示的过程和结果。");
      if (input.task.goal.includes("功能范围太大")) return answer("先只做一个能展示作品的最小页面。", "先做一个最小页面，看看真正卡在哪里。");
      return { wait: { kind: "feedback", message: "你现在最难开始的是功能范围，还是对展示内容没有把握？" } };
    });
    let view = await h.turn(h.created, h.created.matter.question);
    expect(view.matter.arrangements).toEqual([]);
    view = await h.turn(view, "主要是功能范围太大，不知道删什么。");
    expect(view.matter.suggestions[0].status).toBe("proposed");
    expect(view.matter.arrangements).toHaveLength(0);
    view = await h.turn(view, "就按这个做");
    expect(view.matter.arrangements).toHaveLength(1);
    expect(view.matter.arrangements[0].status).toBe("adopted");
    const priorHistory = view.events.length;
    view = await h.service.get("account_a", view.matter.id);
    view = await h.turn(view, "我试过了，技术其实没问题，主要是不知道展示什么内容。");
    expect(view.matter.arrangements[0].status).toBe("tried");
    expect(view.matter.arrangements[0].status).not.toBe("completed");
    expect(view.events.length).toBeGreaterThan(priorHistory);
    expect(view.events.filter(event => event.kind === "feedback").at(-1)?.text).toContain("技术其实没问题");
    expect(view.matter.understanding).toContain("讨论展示什么内容");
    expect(JSON.stringify(observations.at(-1))).toContain("先做一个最小页面");
    expect((await h.service.get("account_a", view.matter.id))).toEqual(view);
    const task = h.service.task("account_a", view.matter.id)!;
    expect(task.status).toBe("ended"); expect(view.matter.status).toBe("active");
    expect(task.usage.calls).toBe(1); expect(task.usage.inputTokens).toBe(5);
  });
  it("C discussion-only suppresses proposed actions even if a decision fixture tries to add one", async () => {
    const h = setup(async () => answer("方向一更快验证，方向二表达更完整；取舍还需知道你最在意的标准。", "今天完成页面"));
    const view = await h.turn(h.created, "帮我比较两个方向，但今天不要安排计划。");
    expect(view.matter.suggestions).toEqual([]); expect(view.matter.arrangements).toEqual([]);
  });
  it("D unapproved history cannot be searched or opened, yet discussion works", async () => {
    const h = setup(async input => input.results.length ? answer("没有获准的历史，我们就从你现在的想法比较。") : { tool: "search_records", args: { query: "过去的作品" } });
    const view = await h.turn(h.created, "没有历史资料也能聊聊吗？");
    expect(h.resolver.resolve).not.toHaveBeenCalled(); expect(view.matter.understanding).toContain("现在的想法");
    expect(view.matter.arrangements).toEqual([]);
  });
  it("E saves pause verbatim without a model call and permits a correction after explicit resume", async () => {
    const decide = vi.fn(async () => answer("按你纠正后的目标，我们讨论内容表达。"));
    const h = setup(decide);
    let view = await h.turn(h.created, "先暂停这件事");
    expect(view.matter.status).toBe("paused"); expect(decide).not.toHaveBeenCalled();
    expect(view.events.at(-1)?.text).toBe("先暂停这件事");
    view = h.service.mutate("account_a", view.matter.id, { operationKey: "resume", expectedVersion: view.matter.version, kind: "status", status: "active" });
    view = await h.turn(view, "纠正一下，不是技术问题，我要讨论展示内容。");
    expect(view.matter.status).toBe("active"); expect(view.matter.understanding).toContain("内容表达");
  });
  it("isolates accounts across matter reads, turns, sources and task projections", async () => {
    const h = setup(async () => answer("讨论"));
    await expect(h.service.get("account_b", h.created.matter.id)).rejects.toThrow("not_found");
    expect(() => h.service.mutate("account_b", h.created.matter.id, { kind: "status", status: "paused", operationKey: "x", expectedVersion: 0 })).toThrow("not_found");
    await expect(h.service.turn("account_b", h.created.matter.id, { operationKey: "x", expectedVersion: 0, text: "偷看" })).rejects.toThrow("not_found");
    expect(await h.service.list("account_b")).toEqual([]);
  });
  it("repeats a successful turn or natural adoption without another model call or action write", async () => {
    const choose = vi.fn(async () => answer("可以先试一个页面。", "做一个最小页面"));
    const h = setup(choose), input = { operationKey: "same", expectedVersion: 0, text: "帮我开始" };
    let view = await h.service.turn("account_a", h.created.matter.id, input);
    expect(await h.service.turn("account_a", h.created.matter.id, input)).toEqual(view); expect(choose).toHaveBeenCalledTimes(1);
    const adoption = { operationKey: "accept_same", expectedVersion: view.matter.version, text: "把这一步记下来" };
    view = await h.service.turn("account_a", view.matter.id, adoption);
    expect(await h.service.turn("account_a", view.matter.id, adoption)).toEqual(view);
    expect(view.matter.arrangements).toHaveLength(1); expect(choose).toHaveBeenCalledTimes(1);
  });
  it("fences cancellation and a late successful decision", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const h = setup(async () => { entered(); await gate; return answer("晚到结果", "不能保存的旧建议"); });
    const pending = h.turn(h.created, "开始讨论"); await ready;
    const active = h.service.repository.get("account_a", h.created.matter.id);
    h.service.mutate("account_a", active.matter.id, { kind: "cancel", operationKey: "cancel", expectedVersion: active.matter.version });
    release(); const result = await pending;
    expect(result.matter.suggestions).toEqual([]); expect(result.matter.activeGeneration).toBeNull();
    expect(result.events.some(event => event.text === "晚到结果")).toBe(false);
  });
  it("fences edits while a generation is in flight", async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; });
    const h = setup(async () => { entered(); await gate; return answer("旧理解"); });
    const pending = h.turn(h.created, "讨论"); await ready;
    const active = h.service.repository.get("account_a", h.created.matter.id);
    h.service.mutate("account_a", active.matter.id, { kind: "edit", goal: "用户修改的新目标", operationKey: "edit", expectedVersion: active.matter.version });
    release(); const view = await pending; expect(view.matter.goal).toBe("用户修改的新目标"); expect(view.matter.understanding).not.toBe("旧理解");
  });
  it.each(["known_failure", "unknown"] as const)("keeps %s distinct, saves user input, and never silently reissues", async code => {
    const choose = vi.fn(async () => { throw new AgentFailure(code, "fixture_failure"); });
    const h = setup(choose); const view = await h.turn(h.created, "用户还没有丢失的输入");
    expect(view.events.some(event => event.text === "用户还没有丢失的输入")).toBe(true);
    expect(view.events.at(-1)?.data.status).toBe(code === "unknown" ? "unknown" : "known_failed");
    expect(view.matter.activeGeneration?.status ?? null).toBe(code === "unknown" ? "unknown" : null);
    if (code === "unknown") await expect(h.turn(view, "再说一次")).rejects.toThrow("pending");
    expect(choose).toHaveBeenCalledTimes(1);
  });
  it("revalidates granted canonical sources and removes withdrawn auto excerpts from later model inputs", async () => {
    let available = true; const observations: unknown[] = [];
    const h = setup(async input => { observations.push(input.observation);
      if (input.task.goal === "查找我的资料" && !input.results.length) return { tool: "search_records", args: { query: "作品" } };
      return answer(input.task.goal === "查找我的资料" ? "根据记录，你希望展示手工作品。" : "从你当前的问题重新讨论。", "选一件手工作品。");
    }, () => available ? [source()] : []);
    let view = await h.turn(h.created, "查找我的资料", { contextMode: "personal" });
    expect(view.events.at(-1)?.sources).toHaveLength(1);
    view = h.service.mutate("account_a", view.matter.id, { kind: "adopt", suggestionId: view.matter.suggestions[0].id, operationKey: "source_adoption", expectedVersion: view.matter.version });
    available = false;
    const raw = h.service.repository.get("account_a", view.matter.id); expect(raw.events.at(-1)?.text).toContain("手工作品");
    view = await h.service.get("account_a", view.matter.id);
    expect(view.events.at(-1)?.text).not.toContain("手工作品");
    await h.turn(view, "现在重新讨论");
    expect(JSON.stringify(observations.at(-1))).not.toContain("根据记录，你希望展示手工作品");
    expect(JSON.stringify(observations.at(-1))).not.toContain("选一件手工作品");
  });
  it("keeps over 100 history events while bounding only the model projection", async () => {
    let count = 0;
    const h = setup(async input => { count = (input.observation as { historyCount: number }).historyCount;
      expect((input.observation as { history: unknown[] }).history.length).toBeLessThanOrEqual(12);
      return answer("继续讨论，今天没有安排。"); });
    let view = h.created;
    for (let index = 0; index < 52; index += 1) view = await h.turn(view, `第${index + 1}轮的真实合成用户表达`);
    expect(count).toBeGreaterThan(100); expect(view.events).toHaveLength(105);
    expect(view.events[1].text).toBe("第1轮的真实合成用户表达");
    expect((await h.service.get("account_a", view.matter.id)).events).toHaveLength(105);
  });
  it("inspects unknown without issuing a second decision and accepts explicit cancellation", async () => {
    const choose = vi.fn(async () => { throw new AgentFailure("unknown", "synthetic_unknown"); });
    const h = setup(choose); let view = await h.turn(h.created, "先讨论");
    view = await h.service.recover("account_a", view.matter.id, "inspect");
    expect(view.matter.activeGeneration?.status).toBe("unknown"); expect(choose).toHaveBeenCalledTimes(1);
    view = h.service.mutate("account_a", view.matter.id, { kind: "cancel", operationKey: "cancel_unknown", expectedVersion: view.matter.version });
    expect(view.matter.activeGeneration).toBeNull(); expect(choose).toHaveBeenCalledTimes(1);
  });
  it("does not adopt ambiguous or negated acceptance", () => {
    expect(explicitThinkingChoice("不要就按这个做")).toBeNull(); expect(explicitThinkingChoice("可能可以")).toBeNull();
    expect(explicitThinkingChoice("就按这个做")).toBe("adopt");
  });
});

function comparison(options?: Array<{ id?: string; name: string }>): ThinkingMatterComparisonInput {
  return { question: "展示什么内容", dimensions: ["验证速度", "表达深度"],
    options: (options ?? [{ name: "方案A" }, { name: "方案B" }]).map(option => ({ ...option,
      content: `${option.name}的内容`, reasons: ["当前理由"], limits: ["范围限制"], costs: ["一天"], unknowns: ["真实反馈"] })), recommendation: null };
}
function addComparison(service: ThinkingAgentService, view: ThinkingMatterView, operationKey = "comparison") {
  return service.mutate("account_a", view.matter.id, { kind: "comparison", operationKey, expectedVersion: view.matter.version, comparison: comparison() });
}
function canonicalCard() {
  return { card: DailyReflectionWorkingCardSchema.parse({ id: "linked_card", accountId: "account_a", sourceReflectionIds: ["reflection_one"],
    title: "PRIVATE_LINKED_TITLE", content: "PRIVATE_LINKED_CONTENT", cardKind: "idea", evidenceIds: ["seg_one"], status: "saved", importance: 0.5,
    novelty: 0.5, relatedCardIds: [], tags: [], visibility: "private", sourceUnavailable: false, version: 3,
    createdAt: "2026-11-03T00:00:00.000Z", updatedAt: "2026-11-03T00:00:00.000Z" }),
    evidence: [{ sourceSegmentId: "seg_one", uploadId: "upload_one", effectiveOrigin: "user_reflection" as const, startSeconds: 0, endSeconds: 2, text: "PRIVATE_LINKED_EVIDENCE" }] };
}

describe("Thinking Agent P2 comparisons, explicit choices and canonical single-card grants", () => {
  it("keeps hypothetical headings in discussion and applies an explicit retitle with a follow-up in the same turn", async () => {
    const observations: unknown[] = [];
    const h = setup(async input => {
      observations.push((input.observation as ThinkingMatterView).matter.comparison?.question);
      return { tool: "respond", args: { reply: "按最新约束继续比较。", understanding: "讨论用户提出的问题", judgments: [], suggestions: [],
        comparison: { ...comparison(), question: observations.length === 1 ? null : observations.length === 2 ? "" : "自动生成的错题" } } };
    });
    let view = addComparison(h.service, h.created);
    const original = view.matter.comparison!.question;
    view = await h.turn(view, "如果把标题改为周日，会不会更好？");
    view = await h.turn(view, "把标题改为「周日安排」好吗？");
    view = await h.turn(view, "比较题目应该是周日吗？");
    view = await h.turn(view, "把标题改成「周日」的话会怎样？");
    expect(view.matter.comparison?.question).toBe(original);
    view = await h.turn(view, "请把题目改为「午饭前如何安排？」。然后按备餐时间重新比较。");
    expect(view.matter.comparison?.question).toBe("午饭前如何安排？");
    expect(observations).toEqual([original, original, original, original, "午饭前如何安排？"]);
    expect(view.events.filter(event => event.kind === "comparison_edited" && event.data.fromChat)).toHaveLength(1);
  });
  it("projects comparison input fields to model observation while retaining server provenance in business state", async () => {
    let observed: unknown;
    const h = setup(async input => {
      observed = (input.observation as { matter: { comparison: unknown } }).matter.comparison;
      return answer("今天只讨论现有方向。");
    });
    const saved = addComparison(h.service, h.created);
    await h.turn(saved, "补充新约束，继续比较。");
    const projected = ThinkingMatterComparisonInputSchema.safeParse(observed);
    expect(projected.success).toBe(true);
    expect(JSON.stringify(observed)).not.toContain("sourceEventId");
    const durable = h.service.repository.get("account_a", saved.matter.id).matter.comparison!;
    expect(durable.sourceEventId).toBeTruthy();
    expect(durable.options.every(option => Boolean(option.sourceEventId))).toBe(true);
    if (projected.success) expect(projected.data.options.map(option => option.id)).toEqual(durable.options.map(option => option.id));
  });

  it("describes server-assigned option IDs in the actual model request and updates only observed IDs", async () => {
    let originalIds: string[] = [];
    const h = setup(async input => {
      const request = agentDecisionRequest(input), system = request.messages[0].content;
      const payload = JSON.parse(request.messages[1].content) as { tools: Array<{ name: string; parameters: { properties: { comparison: { description: string } } } }> };
      const description = payload.tools.find(tool => tool.name === "respond")!.parameters.properties.comparison.description;
      for (const instructions of [system, description]) {
        expect(instructions).toContain("新方案必须省略id");
        expect(instructions).toContain("首轮推荐必须optionId:null");
        expect(instructions).toContain("当前观察");
        expect(instructions).toMatch(/(?:不能|不得)编造/u);
      }
      const observed = (input.observation as { matter: ThinkingMatterView["matter"] }).matter;
      const updated = observed.comparison;
      if (updated) originalIds = updated.options.map(option => option.id);
      return { tool: "respond", args: { reply: "比较之后建议先看方案B，仍由你决定。", understanding: "比较展示方向", judgments: [], suggestions: [],
        comparison: { ...comparison(updated?.options.map(option => ({ id: option.id, name: option.name }))),
          recommendation: { optionId: updated?.options[1].id ?? null, text: "建议方案B，因为更符合当前表达目标。" } } } };
    });
    let view = await h.turn(h.created, "首次比较");
    expect(view.matter.comparison?.options.every(option => option.id.startsWith("think_option_"))).toBe(true);
    expect(view.matter.comparison?.recommendation).toMatchObject({ optionId: null, text: expect.stringContaining("方案B") });
    expect(view.events.at(-1)?.data.promptVersion).toBe(THINKING_PROMPT_VERSION);
    expect(THINKING_PROMPT_VERSION).toBe("reflection_thinking_p3_v3");
    const savedIds = view.matter.comparison!.options.map(option => option.id);
    view = await h.turn(view, "更新已有比较");
    expect(originalIds).toEqual(savedIds); expect(view.matter.comparison?.options.map(option => option.id)).toEqual(savedIds);
    expect(view.matter.comparison?.recommendation?.optionId).toBe(savedIds[1]);
    expect(view.matter.userChoice.status).toBe("undecided"); expect(view.matter.arrangements).toEqual([]);
  });

  it("still rejects invented model option IDs without converting aliases or reissuing an unresolved tool write", async () => {
    const h = setup(async () => ({ tool: "respond", args: { reply: "比较建议", understanding: "比较方向", judgments: [], suggestions: [],
      comparison: { ...comparison([{ id: "plan_a", name: "方案A" }, { id: "plan_b", name: "方案B" }]), recommendation: { optionId: "plan_b", text: "推荐方案B" } } } }));
    const view = await h.turn(h.created, "比较两个新方向");
    expect(view.matter.comparison).toBeNull(); expect(view.matter.userChoice.status).toBe("undecided"); expect(view.matter.arrangements).toEqual([]);
    expect(view.events.at(-1)?.data.status).toBe("unknown");
    expect(view.events.some(event => event.kind === "assistant_message")).toBe(false);
    expect(h.service.task("account_a", view.matter.id)?.usage.calls).toBe(1);
    await expect(h.turn(view, "不要靠重发猜结果")).rejects.toThrow("generation_pending");
  });

  it("stores model comparison and recommendation without selecting or adopting anything", async () => {
    const h = setup(async () => ({ tool: "respond", args: { reply: "A更快，B更深入，尚需你决定。", understanding: "需要比较展示方向", judgments: [], suggestions: [],
      comparison: { ...comparison(), recommendation: { optionId: null, text: "倾向A只是建议" } } } }));
    const view = await h.turn(h.created, "比较两个方向，今天不要安排计划");
    expect(view.matter.comparison?.options).toHaveLength(2);
    expect(view.matter.comparison?.recommendation?.text).toContain("只是建议");
    expect(view.matter.userChoice.status).toBe("undecided"); expect(view.matter.userChoice.sourceEventId).toBeNull();
    expect(view.matter.arrangements).toEqual([]); expect(view.matter.suggestions).toEqual([]);
    expect(view.events.some(event => event.kind === "choice_changed")).toBe(false);
  });

  it.each([
    ["我选方案A", "selected", "方案A"], ["我选择方案A", "selected", "方案A"], ["就选方案B", "selected", "方案B"],
    ["我决定选方案A，因为想先快速验证", "selected", "方案A"], ["新约束：只有一天，我决定改选方案B，因为时间有限", "selected", "方案B"],
    ["我目前更倾向方案B", "leaning", "方案B"], ["方案A先不考虑", "undecided", null], ["先不决定", "undecided", null],
  ])("recognizes exact bounded business choice %s", (text, status, name) => {
    const h = setup(async () => answer("继续讨论")), view = addComparison(h.service, h.created);
    const result = explicitComparisonChoice(text, view)!;
    expect(result.status).toBe(status);
    expect(result.optionId).toBe(name ? view.matter.comparison?.options.find(option => option.name === name)?.id : null);
    if (text.includes("先不考虑")) expect(result.rejectedIds).toEqual([view.matter.comparison!.options[0].id]);
  });

  it.each(["如果我选方案A", "我不选方案A", "我没有说我选方案A", "我选方案A？", "他说“我选方案A”", "我选方案A或方案B", "我选一个快的方案", "我选方案A，方案B也选"])("keeps ambiguous, negated, hypothetical or quoted choice as discussion: %s", text => {
    const h = setup(async () => answer("请明确想选哪个方向。")), view = addComparison(h.service, h.created);
    expect(explicitComparisonChoice(text, view)).toBeNull();
  });

  it("saves exact choice and changed reason before model observation and keeps recent changes outside the chat window", async () => {
    const observations: Array<{ matter: ThinkingMatterView["matter"]; recentChanges: ThinkingMatterView["events"] }> = [];
    const h = setup(async input => { observations.push(input.observation as typeof observations[number]); return answer("按当前选择继续讨论。 "); });
    let view = addComparison(h.service, h.created);
    view = await h.turn(view, "我决定选方案A，因为想先快速验证");
    const selected = view.matter.comparison!.options[0].id;
    expect(observations.at(-1)?.matter.userChoice).toMatchObject({ optionId: selected, status: "selected", reason: "想先快速验证" });
    view = await h.turn(view, "新约束：希望表达过程，我决定改选方案B，因为现在内容更重要");
    expect(view.matter.userChoice).toMatchObject({ optionId: view.matter.comparison!.options[1].id, reason: "现在内容更重要" });
    expect(view.events.filter(event => event.kind === "choice_changed")).toHaveLength(2);
    for (let index = 0; index < 7; index += 1) view = await h.turn(view, `讨论补充${index}`);
    expect(observations.at(-1)?.recentChanges.some(event => event.data.reason === "现在内容更重要")).toBe(true);
    expect(view.matter.arrangements).toEqual([]);
  });

  it("keeps choice, message and receipt atomic, and stale replay cannot override subsequent edits", async () => {
    const decide = vi.fn(async () => answer("不应调用"));
    const h = setup(decide); let view = addComparison(h.service, h.created);
    const rawBefore = h.service.repository.get("account_a", view.matter.id);
    const input = { operationKey: "atomic_choice", expectedVersion: view.matter.version, text: "我选方案A" };
    const begin = vi.spyOn(h.service.repository, "beginTurn").mockImplementationOnce(() => { throw new Error("synthetic interruption before transaction"); });
    await expect(h.service.turn("account_a", view.matter.id, input)).rejects.toThrow("synthetic interruption"); begin.mockRestore();
    expect(h.service.repository.get("account_a", view.matter.id)).toEqual(rawBefore);
    view = h.service.mutate("account_a", view.matter.id, { kind: "edit", operationKey: "new_user_edit", expectedVersion: view.matter.version, goal: "用户新的目标" });
    await expect(h.service.turn("account_a", view.matter.id, input)).rejects.toThrow("version_conflict");
    expect(h.service.repository.get("account_a", view.matter.id).matter.userChoice.status).toBe("undecided");
    const retry = { ...input, operationKey: "atomic_choice_new", expectedVersion: view.matter.version };
    const controller = new AbortController(); controller.abort();
    view = await h.service.turn("account_a", view.matter.id, retry, controller.signal);
    expect(view.matter.userChoice.optionId).toBe(view.matter.comparison!.options[0].id);
    const choiceEvent = view.events.find(event => event.kind === "choice_changed")!;
    expect(view.events.find(event => event.kind === "user_message")?.matterVersion).toBe(choiceEvent.matterVersion);
    view = h.service.mutate("account_a", view.matter.id, { kind: "comparison", operationKey: "rename", expectedVersion: view.matter.version,
      comparison: comparison(view.matter.comparison!.options.map((option, index) => ({ id: option.id, name: index ? option.name : "新名称A" }))) });
    view = h.service.mutate("account_a", view.matter.id, { kind: "choice", operationKey: "manual_new_choice", expectedVersion: view.matter.version,
      status: "selected", optionId: view.matter.comparison!.options[1].id, reason: "用户后来手动改选" });
    expect(await h.service.turn("account_a", view.matter.id, retry)).toEqual(view);
    expect(view.events.filter(event => event.kind === "choice_changed")).toHaveLength(2);
    expect(view.events.filter(event => event.kind === "user_message")).toHaveLength(1); expect(decide).not.toHaveBeenCalled();
  });

  it("corrects prior interpretation in the API and excludes the old interpretation from both observation and read_matter", async () => {
    const inputs: unknown[] = [];
    const h = setup(async input => {
      if (input.task.goal === "第一次") return answer("WRONG_OLD_JUDGMENT：你不擅长技术", "按旧判断补技术课");
      inputs.push({ observation: input.observation, results: input.results });
      return input.results.length ? answer("按用户纠正后的内容目标讨论。 ") : { tool: "read_matter", args: { offset: 0 } };
    });
    let view = await h.turn(h.created, "第一次");
    const staleSuggestion = view.matter.suggestions[0].id;
    view = h.service.mutate("account_a", view.matter.id, { kind: "correct", operationKey: "correct", expectedVersion: view.matter.version, understanding: "技术已经验证，我需要讨论展示内容", reason: "原判断不准确" });
    const safe = await h.service.get("account_a", view.matter.id);
    expect(safe.matter.understanding).toContain("展示内容"); expect(safe.matter.judgments).toEqual([]);
    expect(safe.events.find(event => event.kind === "assistant_message")?.text).toContain("已被用户修正");
    expect(safe.events.at(-1)?.data).not.toHaveProperty("previousUnderstanding");
    expect(() => h.service.mutate("account_a", view.matter.id, { kind: "adopt", suggestionId: staleSuggestion, operationKey: "stale_corrected_adopt", expectedVersion: view.matter.version })).toThrow("建议使用的资料已失效或撤回");
    await h.turn(safe, "按纠正继续");
    expect(JSON.stringify(inputs)).not.toContain("WRONG_OLD_JUDGMENT");
    expect(h.service.repository.get("account_a", view.matter.id).events.some(event => event.text.includes("WRONG_OLD_JUDGMENT"))).toBe(true);
  });

  it("uses only explicitly linked canonical card with none mode and removes its derived comparison after unlink", async () => {
    const detail = canonicalCard(), observations: unknown[] = [];
    const h = setup(async input => { observations.push(input.observation); return { tool: "respond", args: { reply: "PRIVATE_LINKED_DERIVED", understanding: "PRIVATE_LINKED_DERIVED", judgments: [], suggestions: [],
      comparison: { ...comparison([{ name: "PRIVATE_LINKED_OPTION" }, { name: "当前表达方案" }]), question: "PRIVATE_LINKED_TITLE" } } }; }, undefined,
    (accountId, cardId) => { if (accountId !== detail.card.accountId || cardId !== detail.card.id) throw new Error("not_found"); return detail; });
    const linked = h.service.create("account_a", { operationKey: "with_card", question: "只讨论这张卡", sourceCardId: detail.card.id, sourceCardVersion: 3 });
    let view = await h.turn(linked, "比较这张卡里的方向");
    expect(view.matter.contextMode).toBe("none"); expect(JSON.stringify(observations.at(-1))).toContain("PRIVATE_LINKED_CONTENT");
    expect(h.resolver.resolve).not.toHaveBeenCalled(); expect(view.events.at(-1)?.sources[0].kind).toBe("card");
    const optionId = view.matter.comparison!.options[0].id;
    view = h.service.mutate("account_a", view.matter.id, { kind: "choice", status: "selected", optionId, reason: "我希望这样表达", operationKey: "choose_card_option", expectedVersion: view.matter.version });
    view = h.service.unlinkCard("account_a", view.matter.id, { operationKey: "unlink", expectedVersion: view.matter.version, cardId: detail.card.id });
    const safe = await h.service.get("account_a", view.matter.id);
    expect(JSON.stringify(safe)).not.toContain("PRIVATE_LINKED_");
    expect(safe.matter.comparison?.question).toBe("只讨论这张卡");
    expect(safe.matter.comparison?.options.map(option => option.name)).toEqual(["此前方案 1（依据已失效或已修正）", "此前方案 2（依据已失效或已修正）"]);
    expect(safe.matter.comparison?.options.map(option => option.id)).toEqual(view.matter.comparison?.options.map(option => option.id));
    const origin = safe.events.find(event => event.id === safe.matter.comparison!.options[0].sourceEventId)!;
    expect(origin.data.interpretationStatus).toBe("unavailable"); expect(origin.sources).toEqual([]);
    expect(h.service.repository.get("account_a", view.matter.id).events.find(event => event.id === origin.id)?.data).not.toHaveProperty("interpretationStatus");
    expect(safe.matter.userChoice).toMatchObject({ optionId, reason: "我希望这样表达" });
    expect(() => h.service.mutate("account_a", view.matter.id, { kind: "choice", status: "selected", optionId, reason: "", operationKey: "stale_card_choice", expectedVersion: view.matter.version })).toThrow("方案的自动依据已失效");
    expect(h.service.repository.get("account_a", view.matter.id).events.some(event => event.text.includes("PRIVATE_LINKED_DERIVED"))).toBe(true);
  });

  it("rejects cross-account, stale, unsaved or unavailable card grants without a business write or model call", () => {
    const detail = canonicalCard(), decide = vi.fn(async () => answer("不应调用"));
    const h = setup(decide, undefined, () => detail);
    expect(() => h.service.create("account_b", { operationKey: "foreign", question: "关联", sourceCardId: detail.card.id, sourceCardVersion: 3 })).toThrow("卡片不存在");
    expect(() => h.service.linkCard("account_a", h.created.matter.id, { operationKey: "stale", expectedVersion: 0, cardId: detail.card.id, cardVersion: 2 })).toThrow("卡片不存在");
    detail.card.status = "review_pending";
    expect(() => h.service.linkCard("account_a", h.created.matter.id, { operationKey: "not_saved", expectedVersion: 0, cardId: detail.card.id, cardVersion: 3 })).toThrow("卡片不存在");
    detail.card.status = "saved"; detail.card.sourceUnavailable = true;
    expect(() => h.service.linkCard("account_a", h.created.matter.id, { operationKey: "unavailable", expectedVersion: 0, cardId: detail.card.id, cardVersion: 3 })).toThrow("卡片不存在");
    expect(h.service.repository.get("account_a", h.created.matter.id)).toEqual(h.created); expect(decide).not.toHaveBeenCalled();
  });

  it("blocks linked-card generated content when the canonical version changes during the call", async () => {
    const detail = canonicalCard(); let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const h = setup(async input => { expect(JSON.stringify(input.observation)).toContain("PRIVATE_LINKED_CONTENT"); entered(); await gate; return answer("PRIVATE_LATE_CARD_RESULT"); }, undefined, () => detail);
    const linked = h.service.linkCard("account_a", h.created.matter.id, { operationKey: "link", expectedVersion: h.created.matter.version, cardId: detail.card.id, cardVersion: 3 });
    expect(linked.events.find(event => event.id === linked.matter.linkedSources[0].sourceEventId)?.data.linkedSourceAvailability).toEqual([
      expect.objectContaining({ sourceId: detail.card.id, kind: "card", status: "available" })]);
    const pending = h.turn(linked, "继续分析关联卡片"); await ready;
    detail.card.version += 1; detail.card.content = "用户改写后的卡片"; release();
    const view = await pending;
    expect(JSON.stringify(view)).not.toContain("PRIVATE_LATE_CARD_RESULT");
    expect(view.matter.activeGeneration).toBeNull(); expect(h.service.task("account_a", view.matter.id)?.recovery?.kind).toBe("source_invalid");
    expect(view.events.find(event => event.id === view.matter.linkedSources[0].sourceEventId)?.data.linkedSourceAvailability).toEqual([
      expect.objectContaining({ sourceId: detail.card.id, kind: "card", status: "unavailable" })]);
    expect(JSON.stringify((await h.service.list("account_a")).find(matter => matter.id === view.matter.id))).not.toContain("PRIVATE_");
  });

  it.each(["unlink", "deleted", "corrected"])("replays only an exact successful choice receipt after its source is %s", async invalidation => {
    const detail = canonicalCard(); let deleted = false;
    const h = setup(async () => ({ tool: "respond", args: { reply: "PRIVATE_LINKED_DERIVED", understanding: "PRIVATE_LINKED_DERIVED", judgments: [], suggestions: [],
      comparison: comparison([{ name: "PRIVATE_LINKED_OPTION" }, { name: "另一个方向" }]) } }), undefined, () => { if (deleted) throw new Error("source removed"); return detail; });
    let view = h.service.create("account_a", { operationKey: "choice_source", question: "讨论卡片", sourceCardId: detail.card.id, sourceCardVersion: 3 });
    view = await h.turn(view, "比较");
    const original = { kind: "choice" as const, status: "selected" as const, optionId: view.matter.comparison!.options[0].id,
      reason: "用户明确选择理由", operationKey: "successful_choice", expectedVersion: view.matter.version };
    view = h.service.mutate("account_a", view.matter.id, original);
    if (invalidation === "unlink") view = h.service.unlinkCard("account_a", view.matter.id, { operationKey: "revoke", expectedVersion: view.matter.version, cardId: detail.card.id });
    else if (invalidation === "corrected") view = h.service.mutate("account_a", view.matter.id, { kind: "correct", operationKey: "correct_choice", expectedVersion: view.matter.version, understanding: "用户已经纠正原解释" });
    else deleted = true;
    const expected = await h.service.get("account_a", view.matter.id), before = h.service.repository.get("account_a", view.matter.id);
    expect(h.service.mutate("account_a", view.matter.id, original)).toEqual(expected);
    expect(() => h.service.mutate("account_a", view.matter.id, { ...original, reason: "同key改动请求" })).toThrow("operation_conflict");
    expect(() => h.service.mutate("account_a", view.matter.id, { ...original, operationKey: "new_choice_attempt", expectedVersion: view.matter.version })).toThrow("方案的自动依据已失效");
    const other = h.service.create("account_a", { operationKey: "other_matter", question: "另一个事项" });
    expect(() => h.service.mutate("account_a", other.matter.id, original)).toThrow("operation_conflict");
    expect(() => h.service.mutate("account_b", view.matter.id, original)).toThrow("not_found");
    expect(h.service.repository.get("account_a", view.matter.id)).toEqual(before);
  });

  it("replays exact card-create receipt after deletion without resurrecting the link or bypassing new-source checks", async () => {
    const detail = canonicalCard(); let deleted = false;
    const h = setup(async () => answer("PRIVATE_LINKED_DERIVED"), undefined, () => { if (deleted) throw new Error("source removed"); return detail; });
    const original = { operationKey: "successful_card_create", question: "讨论卡片", sourceCardId: detail.card.id, sourceCardVersion: 3 };
    let view = h.service.create("account_a", original);
    view = await h.turn(view, "比较关联资料");
    view = h.service.unlinkCard("account_a", view.matter.id, { operationKey: "unlink_created", expectedVersion: view.matter.version, cardId: detail.card.id }); deleted = true;
    const expected = await h.service.get("account_a", view.matter.id), before = h.service.repository.get("account_a", view.matter.id);
    expect(h.service.create("account_a", original)).toEqual(expected);
    expect(JSON.stringify(h.service.create("account_a", original))).not.toContain("PRIVATE_LINKED_DERIVED");
    expect(() => h.service.create("account_a", { ...original, question: "同key改动内容" })).toThrow("operation_conflict");
    expect(() => h.service.create("account_a", { ...original, operationKey: "new_card_create" })).toThrow("卡片不存在");
    expect(() => h.service.create("account_b", original)).toThrow("卡片不存在");
    expect(h.service.repository.get("account_a", view.matter.id)).toEqual(before);
  });

  it("replays exact link receipt after unlink/version change while rejecting changed payloads, other matters and fresh links", async () => {
    const detail = canonicalCard(), h = setup(async () => answer("讨论"), undefined, () => detail);
    const original = { operationKey: "successful_card_link", expectedVersion: h.created.matter.version, cardId: detail.card.id, cardVersion: 3 };
    let view = h.service.linkCard("account_a", h.created.matter.id, original);
    view = h.service.unlinkCard("account_a", view.matter.id, { operationKey: "unlink_linked", expectedVersion: view.matter.version, cardId: detail.card.id });
    detail.card.version += 1;
    const expected = await h.service.get("account_a", view.matter.id), before = h.service.repository.get("account_a", view.matter.id);
    expect(h.service.linkCard("account_a", view.matter.id, original)).toEqual(expected);
    expect(expected.matter.linkedSources).toEqual([]);
    expect(() => h.service.linkCard("account_a", view.matter.id, { ...original, cardVersion: 4 })).toThrow("operation_conflict");
    expect(() => h.service.linkCard("account_a", view.matter.id, { ...original, operationKey: "new_link_attempt", expectedVersion: view.matter.version })).toThrow("卡片不存在");
    const other = h.service.create("account_a", { operationKey: "other_link_matter", question: "另一个事项" });
    expect(() => h.service.linkCard("account_a", other.matter.id, original)).toThrow("operation_conflict");
    expect(() => h.service.linkCard("account_b", view.matter.id, original)).toThrow("not_found");
    expect(h.service.repository.get("account_a", view.matter.id)).toEqual(before);
  });

  it("archives and reopens with no model call and fences the generation already in flight", async () => {
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const h = setup(async () => { entered(); await gate; return answer("LATE_ARCHIVED_RESPONSE"); });
    const pending = h.turn(h.created, "开始"); await ready;
    let view = h.service.repository.get("account_a", h.created.matter.id);
    view = h.service.mutate("account_a", view.matter.id, { kind: "status", status: "archived", operationKey: "archive", expectedVersion: view.matter.version });
    expect(view.matter.status).toBe("archived"); release();
    view = await pending; expect(view.events.some(event => event.text.includes("LATE_ARCHIVED_RESPONSE"))).toBe(false);
    view = h.service.mutate("account_a", view.matter.id, { kind: "status", status: "active", operationKey: "reopen", expectedVersion: view.matter.version });
    expect(view.matter.status).toBe("active"); expect(view.matter.activeGeneration).toBeNull();
  });

  it("keeps current choice, corrected understanding, feedback and recent changes beyond 100 durable events and reads an early history page", async () => {
    const observations: unknown[] = [];
    const h = setup(async input => {
      const observation = input.observation as { matter: ThinkingMatterView["matter"]; history: ThinkingMatterView["events"]; historyCount: number; latestFeedback: { text: string }; recentChanges: ThinkingMatterView["events"] };
      observations.push(observation);
      expect(observation.history).toHaveLength(12); expect(observation.historyCount).toBeGreaterThan(100);
      expect(observation.matter.userChoice).toMatchObject({ status: "selected", reason: "LONG_HISTORY_CHOICE_REASON" });
      expect(observation.matter.understanding).toBe("用户纠正：需要讨论展示内容");
      expect(observation.latestFeedback.text).toBe("最新真实反馈：技术已经验证");
      expect(observation.recentChanges.some(event => event.kind === "choice_changed" && event.text === "LONG_HISTORY_CHOICE_REASON")).toBe(true);
      expect(observation.history.some(event => event.kind === "choice_changed")).toBe(false);
      if (!input.results.length) return { tool: "read_matter", args: { offset: 0 } };
      expect(JSON.stringify(input.results)).toContain(h.created.matter.question);
      expect(JSON.stringify(input.results)).not.toContain("WRONG_OLD_HISTORY_JUDGMENT");
      return answer("按持续保存的选择与反馈继续讨论");
    });
    let view = addComparison(h.service, h.created);
    let started = h.service.repository.beginTurn("account_a", view.matter.id, { operationKey: "history_initial_turn", expectedVersion: view.matter.version, text: "原始用户说明" });
    view = h.service.repository.commitResponse("account_a", view.matter.id, { generationId: started.generationId, expectedVersion: started.version, reply: "WRONG_OLD_HISTORY_JUDGMENT", understanding: "旧理解", judgments: ["旧判断"] });
    view = h.service.mutate("account_a", view.matter.id, { kind: "choice", operationKey: "history_choice", expectedVersion: view.matter.version, status: "selected", optionId: view.matter.comparison!.options[0].id, reason: "LONG_HISTORY_CHOICE_REASON" });
    view = h.service.mutate("account_a", view.matter.id, { kind: "correct", operationKey: "history_correct", expectedVersion: view.matter.version, understanding: "用户纠正：需要讨论展示内容" });
    view = h.service.mutate("account_a", view.matter.id, { kind: "feedback", operationKey: "history_feedback", expectedVersion: view.matter.version, text: "最新真实反馈：技术已经验证" });
    for (let index = 0; index < 52; index += 1) {
      started = h.service.repository.beginTurn("account_a", view.matter.id, { operationKey: `history_user_${index}`, expectedVersion: view.matter.version, text: `后续用户补充${index}` });
      view = h.service.repository.commitResponse("account_a", view.matter.id, { generationId: started.generationId, expectedVersion: started.version, reply: `后续讨论${index}` });
    }
    const durableCount = view.events.length;
    view = await h.turn(view, "长历史之后继续");
    expect(observations).toHaveLength(2); expect(view.events.length).toBe(durableCount + 2);
    expect((await h.service.get("account_a", view.matter.id)).events).toHaveLength(view.events.length);
    expect(h.service.task("account_a", view.matter.id)?.usage.calls).toBe(2);
  });

  it("reopens physical SQLite/checkpoints and inspects an unknown generation without another model call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reflection-thinking-p3-unknown-"));
    const filePath = join(directory, "daily-reflection.sqlite");
    const decide = vi.fn<AgentDecisionProvider>((input, context) => context.call({ kind: "offline_restart_fixture", model: "synthetic_no_provider", inputChars: JSON.stringify(input.observation).length, maxOutputTokens: 100 },
      async () => { throw new AgentFailure("unknown", "synthetic unknown after dispatch"); }));
    const resolver = { resolve: vi.fn(() => ({ sources: [], promptExcerpts: [], usedPersonalContext: false, pastClues: null })) };
    let service: ThinkingAgentService | undefined;
    try {
      service = new ThinkingAgentService(openDailyReflectionDatabase({ filePath }), { decision: decide, resolver });
      const created = service.create("account_a", { operationKey: "restart_create", question: "物理重开后继续同一事项" });
      const input = { operationKey: "restart_unknown", expectedVersion: created.matter.version, text: "原请求结果未知" };
      const unknown = await service.turn("account_a", created.matter.id, input);
      expect(unknown.matter.activeGeneration?.status).toBe("unknown"); expect(decide).toHaveBeenCalledTimes(1);
      service.close(); service.store.close();
      service = new ThinkingAgentService(openDailyReflectionDatabase({ filePath }), { decision: decide, resolver });
      expect((await service.get("account_a", created.matter.id))).toEqual(unknown);
      const inspected = await service.recover("account_a", created.matter.id, "restart_inspect");
      expect(inspected.matter.activeGeneration?.status).toBe("unknown");
      expect(await service.turn("account_a", created.matter.id, input)).toEqual(inspected);
      await expect(service.turn("account_a", created.matter.id, { ...input, operationKey: "new_unknown_attempt", expectedVersion: inspected.matter.version })).rejects.toThrow("generation_pending");
      expect(service.task("account_a", created.matter.id)?.recovery?.kind).toBe("unknown"); expect(decide).toHaveBeenCalledTimes(1);
      const cancelled = service.mutate("account_a", created.matter.id, { kind: "cancel", operationKey: "restart_cancel", expectedVersion: inspected.matter.version });
      expect(cancelled.matter.activeGeneration).toBeNull(); expect(decide).toHaveBeenCalledTimes(1);
    } finally {
      if (service?.store.database.open) { service.close(); service.store.close(); }
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("reflection-thinking-p3-unknown-")) throw new Error("Unexpected test cleanup directory");
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
