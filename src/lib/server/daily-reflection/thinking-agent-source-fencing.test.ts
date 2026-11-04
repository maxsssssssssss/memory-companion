// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDecision, AgentDecisionProvider } from "@/lib/server/agent/types";
import type { DailyReflectionThinkingSource } from "@/lib/domain/daily-reflection-thinking";
import type { ThinkingMatterView } from "@/lib/domain/reflection-thinking-matter";
import { openDailyReflectionDatabase } from "./db";
import { ThinkingAgentService } from "./thinking-agent";

const ACCOUNT = "source_fencing_account";
const services: ThinkingAgentService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) { service.close(); service.store.close(); }
  vi.restoreAllMocks();
});

function canonicalSource(id = "source_one", text = "PRIVATE_CANONICAL_SOURCE"): DailyReflectionThinkingSource {
  return { sourceId: id, claim: { text, sourceCardIds: [id], sourceMemoryIds: [], evidenceIds: [`segment_${id}`],
    epistemicStatuses: ["explicit_user_statement"], evidence: [{ sourceSegmentId: `segment_${id}`, cardId: id,
      reflectionId: `reflection_${id}`, sourceOrigin: "user_reflection", recordingDate: "2026-11-02",
      startSeconds: 0, endSeconds: 5, snippet: text }] } };
}
function reply(text: string): AgentDecision {
  return { tool: "respond", args: { reply: text, understanding: text, judgments: [], suggestions: [] } };
}
function search(): AgentDecision { return { tool: "search_records", args: { query: "作品资料" } }; }

function fixture(choose: AgentDecisionProvider, readSources: () => DailyReflectionThinkingSource[]) {
  const model = vi.fn<AgentDecisionProvider>(choose);
  const decision: AgentDecisionProvider = (input, context) => context.call({ kind: "offline_source_fencing_decision",
    model: "synthetic_no_provider", inputChars: JSON.stringify(input.observation).length, maxOutputTokens: 1000 },
  async () => ({ value: await model(input, context), usage: { inputTokens: 7, outputTokens: 5 } }));
  const resolver = { resolve: vi.fn(() => ({ sources: readSources(), promptExcerpts: [], usedPersonalContext: true, pastClues: null })) };
  const service = new ThinkingAgentService(openDailyReflectionDatabase({ filePath: ":memory:" }), { decision, resolver });
  services.push(service);
  const created = service.repository.create(ACCOUNT, { operationKey: "create", question: "讨论作品展示", contextMode: "personal" });
  let sequence = 0;
  return { service, model, created, turn: (view: ThinkingMatterView, text: string) => service.turn(ACCOUNT, view.matter.id,
    { operationKey: `source_turn_${++sequence}`, expectedVersion: view.matter.version, text }) };
}

describe("Thinking Agent canonical source fencing through the formal service", () => {
  it("inherits sources in a waiting reply and excludes withdrawn excerpts from later observation and history tools", async () => {
    let available = true;
    const laterInputs: unknown[] = [];
    const h = fixture(async input => {
      if (input.task.goal === "先参考记录") return input.results.length ? reply("PRIVATE_SOURCE_ANALYSIS") : search();
      if (input.task.goal === "继续追问") return { wait: { kind: "feedback", message: "PRIVATE_WAIT_QUESTION：这件作品想表达什么？" } };
      laterInputs.push({ observation: input.observation, results: input.results });
      return input.results.length ? reply("只依据你现在的表达继续讨论。") : { tool: "read_matter", args: { offset: 0 } };
    }, () => available ? [canonicalSource()] : []);
    let view = await h.turn(h.created, "先参考记录");
    view = await h.turn(view, "继续追问");
    expect(view.events.at(-1)?.text).toContain("PRIVATE_WAIT_QUESTION");
    expect(view.events.at(-1)?.sources).toHaveLength(1);
    available = false;
    expect(JSON.stringify(await h.service.get(ACCOUNT, view.matter.id))).not.toContain("PRIVATE_");
    await h.turn(view, "以现在的问题为准");
    expect(laterInputs).toHaveLength(2);
    expect(JSON.stringify(laterInputs)).not.toContain("PRIVATE_");
    expect(h.service.repository.get(ACCOUNT, view.matter.id).events.some(event => event.text.includes("PRIVATE_WAIT_QUESTION"))).toBe(true);
  });

  it("blocks a late reply when an inherited source is withdrawn during generation without another search", async () => {
    let available = true;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = fixture(async input => {
      if (input.task.goal === "参考资料") return input.results.length ? reply("PRIVATE_SOURCE_ANALYSIS") : search();
      expect(JSON.stringify(input.observation)).toContain("PRIVATE_SOURCE_ANALYSIS");
      entered(); await gate;
      return reply("PRIVATE_LATE_DERIVED_REPLY");
    }, () => available ? [canonicalSource()] : []);
    const original = await h.turn(h.created, "参考资料");
    const pending = h.turn(original, "继续分析");
    await ready;
    available = false; release();
    const view = await pending;
    expect(view.matter.activeGeneration).toBeNull();
    expect(h.service.repository.get(ACCOUNT, view.matter.id).events.some(event => event.text.includes("PRIVATE_LATE_DERIVED_REPLY"))).toBe(false);
    expect(h.service.task(ACCOUNT, view.matter.id)?.recovery?.kind).toBe("source_invalid");
    expect(h.service.task(ACCOUNT, view.matter.id)?.usage).toMatchObject({ calls: 1, inputTokens: 7, outputTokens: 5 });
  });

  it("projects only safe task metadata instead of wait, scope, goal or action bodies", async () => {
    const h = fixture(async () => ({ wait: { kind: "feedback", message: "PRIVATE_TASK_WAIT_BODY" } }), () => []);
    const view = await h.turn(h.created, "PRIVATE_TASK_GOAL");
    const raw = h.service.store.listTasks(ACCOUNT, view.matter.id)[0];
    expect(raw.wait?.message).toBe("PRIVATE_TASK_WAIT_BODY");
    expect(raw.goal).toBe("PRIVATE_TASK_GOAL");
    const projection = h.service.task(ACCOUNT, view.matter.id)!;
    expect(Object.keys(projection).sort()).toEqual(["id", "recovery", "status", "usage"]);
    expect(JSON.stringify({ task: projection })).not.toContain("PRIVATE_");
    expect(projection.status).toBe("waiting");
    expect(projection.usage.calls).toBe(1);
    expect(() => h.service.task("another_account", view.matter.id)).toThrow("not_found");
  });

  it("stops before any new model call when restored historical permissions expose over 32 inherited sources", async () => {
    const batches = [Array.from({ length: 11 }, (_, index) => canonicalSource(`batch_a_${index}`, `source_a_${index}`)),
      Array.from({ length: 11 }, (_, index) => canonicalSource(`batch_b_${index}`, `source_b_${index}`)),
      Array.from({ length: 11 }, (_, index) => canonicalSource(`batch_c_${index}`, `source_c_${index}`))];
    let available = batches[0];
    const h = fixture(async input => input.results.length ? reply("依据这次获准资料讨论。") : search(), () => available);
    let view = h.created;
    for (let index = 0; index < batches.length; index += 1) {
      // Earlier grants are absent while the next independently granted batch is discussed.
      available = batches[index];
      view = await h.turn(view, `讨论第${index + 1}批获准资料`);
      expect(view.events.at(-1)?.sources).toHaveLength(11);
    }
    available = batches.flat();
    const callsBefore = h.model.mock.calls.length;
    view = await h.turn(view, "所有此前资料恢复授权后继续");
    expect(h.model).toHaveBeenCalledTimes(callsBefore);
    expect(h.service.task(ACCOUNT, view.matter.id)).toMatchObject({ status: "budget_exhausted", usage: { calls: 0 } });
    expect(view.matter.activeGeneration).toBeNull();
    expect(view.events.at(-1)?.data.status).toBe("known_failed");
    expect(h.service.repository.get(ACCOUNT, view.matter.id).events.filter(event => event.kind === "assistant_message")).toHaveLength(3);
  });

  it("retains both exposed versions of one source and refuses to publish after the earlier version changes", async () => {
    let current = canonicalSource("same_source", "PRIVATE_OLD_VERSION");
    const h = fixture(async input => {
      if (input.results.length === 0) return search();
      if (input.results.length === 1) { current = canonicalSource("same_source", "PRIVATE_NEW_VERSION"); return search(); }
      return reply("PRIVATE_MIXED_VERSION_REPLY");
    }, () => [current]);
    const view = await h.turn(h.created, "读取记录并核对版本变化");
    expect(h.model).toHaveBeenCalledTimes(3);
    expect(view.events.some(event => event.kind === "assistant_message")).toBe(false);
    expect(view.matter.activeGeneration).toBeNull();
    const raw = h.service.store.listTasks(ACCOUNT, view.matter.id)[0];
    expect(raw.actions.filter(action => action.tool === "search_records" && action.status === "succeeded")).toHaveLength(2);
    expect(raw.recovery?.kind).toBe("source_invalid");
    expect(raw.usage).toMatchObject({ calls: 3, inputTokens: 21, outputTokens: 15 });
    expect(JSON.stringify(await h.service.get(ACCOUNT, view.matter.id))).not.toContain("PRIVATE_MIXED_VERSION_REPLY");
  });
});
