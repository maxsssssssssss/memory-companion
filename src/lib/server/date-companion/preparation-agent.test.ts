// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDateCompanionDatabase } from "./db";
import { DateCompanionRepository } from "./repository";
import { dateCompanionEvidenceDigest } from "./memory-bridge-digest";
import { PreparationAgentService } from "./preparation-agent";
import { agentDecisionRequest, createAgentDecisionProvider } from "@/lib/server/agent/model";
import type { AgentDecision, AgentDecisionInput, AgentDecisionProvider } from "@/lib/server/agent/types";
const resources: Array<() => void> = [];
afterEach(() => {
  for (const close of resources.splice(0).reverse())
    close();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => {
    throw new Error("network forbidden");
  }));
});
const answer = (reply = "可以先轻松聊聊。", suggestions: string[] = [], sourceIds: string[] = []): AgentDecision => ({ tool: "respond", args: {
    reply, suggestions, sourceIds
  } });
function setup(decide: (input: AgentDecisionInput) => AgentDecision | Promise<AgentDecision>) {
  const db = openDateCompanionDatabase({ filePath: ":memory:" });
  resources.push(() => db.close());
  const observations: AgentDecisionInput[] = [];
  const decision: AgentDecisionProvider = async (input, ctx) => {
    observations.push(input);
    return ctx.call({
      kind: "agent_decision", model: "fixture", inputChars: JSON.stringify(input.observation).length, maxOutputTokens: 500
    }, async () => ({ value: await decide(input), usage: { inputTokens: 10, outputTokens: 5 } }));
  };
  const service = new PreparationAgentService(db, { decision });
  resources.push(() => service.close());
  return {
    db, service, observations, decision
  };
}
function seed(db: Database.Database) {
  const repo = new DateCompanionRepository(db), relationship = repo.createOrGetRelationship("alice").relationship;
  const imported = repo.importInteraction({
    userId: "alice", relationshipId: relationship.id, sourceUploadId: "synthetic-upload", recordingDate: "2026-11-01", originalName: "synthetic.wav", participants: [{ speakerId: "ta" }], recapCandidates: [{
        kind: "mentioned", proposedText: "聊过旅行", sortOrder: 0, evidence: [{
            uploadId: "synthetic-upload", sourceSegmentId: "synthetic-travel", startSeconds: 0, endSeconds: 3, speakerId: "ta", quote: "我想去云南旅行"
          }]
      }]
  });
  const detail = repo.getInteractionDetail("alice", relationship.id, imported.interactionId);
  repo.updateRecap({
    userId: "alice", interactionId: detail.id, version: 0, assignments: [{ speakerId: "ta", role: "companion" }], mutations: detail.recapItems.map(i => ({
      id: i.id, version: 0, disposition: "kept"
    })), finalize: true
  });
  return detail.id;
}
describe("date companion preparation business runtime", () => {
  it("can broaden an empty linked-review query without exposing quotes before read_source", async () => {
    const {service, db, observations} = setup(input => {
      if (input.task.goal === "先留一条准备") return answer("", ["找个轻松的机会聊聊。"]) ;
      if (!input.results.length) return {tool:"list_review_sources",args:{query:"散步",offset:0}};
      if (input.results.length === 1) {
        expect(input.results[0].value).toMatchObject({sources:[],notice:expect.stringContaining("不代表整份关联复盘没有原话")});
        expect(agentDecisionRequest(input).messages[0].content).toContain("工具返回之后仍只输出同样的 JSON 工具动作");
        return {tool:"list_review_sources",args:{offset:0}};
      }
      const source = (input.results[1].value as {sources:{id:string}[]}).sources[0];
      if (input.results.length === 2) {
        expect(JSON.stringify(input.results)).not.toContain("我想去云南旅行");
        return {tool:"read_source",args:{sourceId:source.id}};
      }
      expect(JSON.stringify(input.results[2])).toContain("我想去云南旅行");
      return answer("记录中谈了旅行；这段原话不能确定其他时刻有没有散步。", [], [source.id]);
    });
    const interactionId=seed(db);
    let view=await service.create("alice",{operationKey:"initial",text:"先留一条准备"});
    view=service.mutate("alice",view.id,{operationKey:"select",expectedVersion:view.version,kind:"select",itemId:view.items[0].id});
    view=service.mutate("alice",view.id,{operationKey:"link",expectedVersion:view.version,kind:"link_review",interactionId});
    view=await service.turn("alice",view.id,{operationKey:"review",expectedVersion:view.version,text:"请核对记录有没有聊过散步。"});
    expect(view.generationStatus).toBe("idle");
    expect(view.messages.at(-1)?.sources[0].quote).toBe("我想去云南旅行");
    expect(observations).toHaveLength(5);
    expect(view.interactionIds).toEqual([]); expect(view.allowRetained).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM dc_promises").get()).toEqual({n:0});
  });

  it("keeps a completed plain-text real-response failure out of history without retrying or losing the choice", async () => {
    const {service, db}=setup(()=>answer("",["准备一个自己最近想去或去过的地方。"]));
    let view=await service.create("alice",{operationKey:"initial",text:"只给一条旅行准备"});
    view=service.mutate("alice",view.id,{operationKey:"select",expectedVersion:view.version,kind:"select",itemId:view.items[0].id});
    const selected=view.items[0];
    // Exact synthetic final-acceptance response #3. Replay tests the parser and
    // persistence contract, not the quality of a new model generation.
    const text='list_review_sources 返回空，说明这份关联复盘里没有可读的录音原话来源，所以读不到 Ta 的原话。旅行没有被录下来，无法据此确定你们聊过或没聊过；录音只覆盖录下的片段，没录到不等于没发生。你原来留下的是“准备一个自己最近想去或去过的地方，等聊到空闲时间时自然提一句”，这也只是当时的打算，不能推断你实际提过。就这份记录而言，它只支持“你当时准备过这个方向”，不支持任何结论说旅行一定聊过或一定没聊过。';
    const transport=vi.fn(async()=>new Response('data: '+JSON.stringify({type:'response.completed',response:{id:'synthetic-replay',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}],usage:{input_tokens:10,output_tokens:10}}})+'\n\n',{headers:{'content-type':'text/event-stream'}}));
    vi.stubGlobal("fetch",transport);
    const replay=new PreparationAgentService(db,{decision:createAgentDecisionProvider(()=>({apiKey:'synthetic',baseURL:'https://offline.invalid/v1',model:'fixture',maxInputChars:48000,maxOutputTokens:4000,requestTimeoutMs:1000}))});
    resources.push(()=>replay.close());
    view=await replay.turn("alice",view.id,{operationKey:"review",expectedVersion:view.version,text:"请读原话核对这次的记录。"});
    expect(transport).toHaveBeenCalledTimes(1);
    expect(view.generationStatus).toBe("failed");
    expect(view.items).toEqual([selected]);
    expect(view.messages.at(-1)).toMatchObject({role:"user",text:"请读原话核对这次的记录。"});
    expect(JSON.stringify(view.messages)).not.toContain(text);
    expect(db.prepare("SELECT status FROM agent_calls ORDER BY rowid DESC LIMIT 1").get()).toEqual({status:"failed"});
  });

  it("starts from text, saves input before generation, persists an explicit choice and changes help after feedback", async () => {
    let service: PreparationAgentService;
    const setupResult = setup(input => {
      const state = service.repository.get("alice", input.task.resourceId);
      expect(state.messages.at(-1)?.role).toBe("user");
      const o = input.observation as {
        latestFeedback?: {
          text: string;
        };
      };
      return o.latestFeedback ? answer("既然后来聊的是工作，我们先聊你当时的感受。", ["下次先问问这周过得怎么样"]) : answer("可以轻松开始。", ["见面先问问最近过得怎么样"]);
    });
    service = setupResult.service;
    let view = await service.create("alice", { operationKey: "first", text: "明天见 Ta，想轻松一点" });
    expect(view.generationStatus).toBe("idle");
    expect(view.items[0].status).toBe("suggested");
    expect(view.messages).toHaveLength(2);
    view = service.mutate("alice", view.id, {
      operationKey: "select", expectedVersion: view.version, kind: "select", itemId: view.items[0].id
    });
    expect(view.items[0].status).toBe("selected");
    const reopened = new PreparationAgentService(setupResult.db, { decision: setupResult.decision });
    resources.push(() => reopened.close());
    view = await reopened.turn("alice", view.id, {
      operationKey: "feedback", expectedVersion: view.version, text: "上次准备的内容没用上，后来聊了工作。"
    });
    expect(view.messages.at(-2)).toMatchObject({
      kind: "feedback", origin: "user_reflection", text: "上次准备的内容没用上，后来聊了工作。"
    });
    expect(view.messages.at(-1)?.text).toBe("");
    expect(view.items.at(-1)).toMatchObject({ text: "下次先问问这周过得怎么样", sourceMessageId: view.messages.at(-1)?.id });
    expect(view.items.map(i => i.status)).toEqual(["selected", "suggested"]);
    expect(setupResult.db.prepare("SELECT COUNT(*) AS n FROM dc_promises").get()).toEqual({ n: 0 });
    expect(setupResult.db.prepare("SELECT COUNT(*) AS n FROM dc_memory_bridge_outbox").get()).toEqual({ n: 0 });
    expect(setupResult.db.prepare("SELECT COUNT(*) AS n FROM agent_calls").get()).toEqual({ n: 2 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses actual search and read tools then fences withdrawn original quotes from all later model observations", async () => {
    let revoked = false;
    const { service, db, observations } = setup(input => {
      if (revoked) {
        expect(JSON.stringify(input)).not.toContain("我想去云南旅行");
        return answer("按你现在说的，我们先聊这次见面。");
      }
      const search = input.results.find(r => r.tool === "search_records");
      if (!search)
        return { tool: "search_records", args: { query: "旅行" } };
      const source = (search.value as {
        sources: {
          id: string;
        }[];
      }).sources[0];
      if (!input.results.some(r => r.tool === "read_source"))
        return { tool: "read_source", args: { sourceId: source.id } };
      return {tool:"respond",args:{reply:"之前有聊到云南旅行。",suggestions:["可以问问最近还想去哪里"],sourceIds:[source.id],constraints:["我想去云南旅行"],date:"2026-11-01"}};
    });
    const interactionId = seed(db);
    let view = await service.create("alice", {
      operationKey: "history", text: "帮找上次旅行", interactionIds: [interactionId]
    });
    expect(view.messages[0].kind).toBe("message");
    expect(view.messages.at(-1)?.sources[0].quote).toBe("我想去云南旅行");
    expect(observations).toHaveLength(3);
    expect(JSON.stringify(observations[1].results)).not.toContain("我想去云南旅行");
    expect(JSON.stringify(observations[2].results.find(result => result.tool === "read_source"))).toContain("我想去云南旅行");
    const sourceReceipts = db.prepare("SELECT ref_json FROM agent_actions WHERE tool IN ('search_records','read_source')").all() as {
      ref_json: string;
    }[];
    for (const receipt of sourceReceipts) {
      const reference = JSON.parse(receipt.ref_json);
      const refs = JSON.parse(Buffer.from(reference.id, "base64url").toString()) as Record<string, unknown>[];
      expect(refs.every(ref => Object.keys(ref).sort().join(",") === "fingerprint,id")).toBe(true);
    }
    view = service.mutate("alice", view.id, {
      operationKey: "selected", expectedVersion: view.version, kind: "select", itemId: view.items[0].id
    });
    view = service.mutate("alice", view.id, {
      operationKey: "revoke", expectedVersion: view.version, kind: "scope", interactionIds: [], allowRetained: false
    });
    expect(view.items[0].status).toBe("selected");
    expect(view.items[0].sources[0]).toMatchObject({ valid: false, quote: "" });
    revoked = true;
    view = await service.turn("alice", view.id, {
      operationKey: "correct", expectedVersion: view.version, text: "不对，这次我只是想聊聊。"
    });
    expect(view.messages.at(-2)?.kind).toBe("correction");
    expect(view.messages.at(-1)?.text).toContain("现在");
  });
  it("does not adopt vague assent; exact single-object command saves without a model request", async () => {
    const { service, db } = setup(() => answer("可以先随便聊聊。", ["先问问这周过得怎么样"]));
    let view = await service.create("alice", { operationKey: "first", text: "见面怎么开始" });
    view = await service.turn("alice", view.id, {
      operationKey: "vague", expectedVersion: view.version, text: "不错"
    });
    expect(view.items.every(i => i.status === "suggested")).toBe(true);
    const calls = db.prepare("SELECT COUNT(*) AS n FROM agent_calls").get();
    view = await service.turn("alice", view.id, {
      operationKey: "exact", expectedVersion: view.version, text: "这条留下"
    });
    expect(view.items.filter(i => i.status === "selected")).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_calls").get()).toEqual(calls);
  });
  it("supports no-history discussion, safe idempotency, version and account isolation", async () => {
    const { service, db } = setup(() => answer("可以，我们先聊你拿不准的地方。"));
    const request = { operationKey: "same", text: "只想聊聊，不想准备" };
    const first = await service.create("alice", request), again = await service.create("alice", request);
    expect(again.id).toBe(first.id);
    expect(again.items).toEqual([]);
    expect(again.messages).toHaveLength(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_calls").get()).toEqual({ n: 1 });
    await expect(service.create("alice", { ...request, text: "different" })).rejects.toThrow();
    expect(() => service.get("bob", first.id)).toThrow();
    expect(() => service.mutate("alice", first.id, {
      operationKey: "stale", expectedVersion: 0, kind: "pause"
    })).toThrow();
    const paused = await service.turn("alice", first.id, {
      operationKey: "pause", expectedVersion: first.version, text: "这次先不聊"
    });
    expect(paused.status).toBe("paused");
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_calls").get()).toEqual({ n: 1 });
  });
  it("keeps saved input after model failure and never retries an identical failed turn", async () => {
    const { service, db } = setup(() => {
      throw new Error("fixture failure");
    });
    const request = { operationKey: "failure", text: "我不确定要不要提那件事" };
    const view = await service.create("alice", request);
    expect(view.generationStatus).toBe("failed");
    expect(view.messages[0].text).toBe(request.text);
    await service.create("alice", request);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_calls").get()).toEqual({ n: 1 });
  });
  it("prevents late model responses after manual changes and deletion while retaining call accounting", async () => {
    let release: (value: AgentDecision) => void = () => {
    };
    let entered: () => void = () => {
    };
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const { service, db } = setup(() => new Promise<AgentDecision>(resolve => {
      release = resolve;
      entered();
    }));
    const pending = service.create("alice", { operationKey: "late", text: "先聊聊" });
    await started;
    const view = service.list("alice").preparations[0];
    expect(view.messages).toHaveLength(1);
    service.delete("alice", view.id, { operationKey: "delete", expectedVersion: view.version });
    release(answer("晚到回答", ["晚到建议"]));
    await expect(pending).rejects.toThrow();
    expect(service.list("alice").preparations).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_calls").get()).toEqual({ n: 1 });
    service.delete("alice", view.id, { operationKey: "delete", expectedVersion: view.version });
  });
  it("revokes history before the next model call when the user says so naturally", async () => {
    let revoked = false;
    const { service, db } = setup(input => {
      if (revoked) {
        expect((input.observation as {
          historyAllowed: boolean;
        }).historyAllowed).toBe(false);
        expect(JSON.stringify(input)).not.toContain("我想去云南旅行");
      }
      return answer("可以，只聊你现在的想法。");
    });
    const interactionId = seed(db);
    let view = await service.create("alice", {
      operationKey: "history", text: "明天见 Ta", interactionIds: [interactionId]
    });
    revoked = true;
    view = await service.turn("alice", view.id, {
      operationKey: "natural-revoke", expectedVersion: view.version, text: "这次不用历史资料，只想聊聊。"
    });
    expect(view.interactionIds).toEqual([]);
    expect(view.allowRetained).toBe(false);
    expect(view.events.some(e => e.kind === "scope_changed")).toBe(true);
  });
  it("does not let late generation overwrite manual selections and keeps interrupted input recoverable without replay", async () => {
    let delayed = false, release: (v: AgentDecision) => void = () => {
    }, entered: () => void = () => {
    };
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const { service, db } = setup(() => delayed ? new Promise<AgentDecision>(resolve => {
      release = resolve;
      entered();
    }) : answer("可以", ["轻松开场"]));
    let view = await service.create("alice", { operationKey: "first", text: "想聊聊" });
    delayed = true;
    const pending = service.turn("alice", view.id, {
      operationKey: "late", expectedVersion: view.version, text: "再想想"
    });
    await started;
    view = service.get("alice", view.id);
    service.mutate("alice", view.id, {
      operationKey: "choose-during-run", expectedVersion: view.version, kind: "select", itemId: view.items[0].id
    });
    release(answer("晚到的旧判断", ["旧建议"]));
    view = await pending;
    expect(view.items[0].status).toBe("selected");
    expect(view.messages.some(m => m.text === "晚到的旧判断")).toBe(false);
    const begun = service.repository.begin("alice", view.id, {
      operationKey: "crash", expectedVersion: view.version, text: "崩溃前已保存", kind: "feedback"
    });
    const state = JSON.parse((db.prepare("SELECT body_json FROM dc_preparations WHERE id=?").get(view.id) as {
      body_json: string;
    }).body_json);
    state.updatedAt = "2026-01-01T00:00:00.000Z";
    db.prepare("UPDATE dc_preparations SET body_json=? WHERE id=?").run(JSON.stringify(state), view.id);
    const before = db.prepare("SELECT COUNT(*) AS n FROM agent_calls").get();
    const reopened = new PreparationAgentService(db, { decision: async () => {
        throw new Error("must not generate");
      } });
    resources.push(() => reopened.close());
    const recovered = reopened.get("alice", begun.id);
    expect(recovered.generationStatus).toBe("failed");
    expect(recovered.messages.at(-1)?.text).toBe("崩溃前已保存");
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_calls").get()).toEqual(before);
  });
  it("rejects invented or unread citations without publishing a false source or saved suggestion", async () => {
    const { service } = setup(() => answer("Ta以前说过这件事", ["虚构的准备"], ["invented-source"]));
    const view = await service.create("alice", { operationKey: "invented", text: "以前有没有说过这件事" });
    expect(view.generationStatus).toBe("failed");
    expect(view.messages).toHaveLength(1);
    expect(view.items).toEqual([]);
  });
});

describe("date companion feedback and requested suggestions", () => {
  const firstIntent = "2026-11-06 下午要见 Ta，想在海边找个安静的地方。";
  const feedback = "上次没有聊旅行。我觉得 Ta 那天工作很累，我们后来只是安静地散了会儿步。请根据这次实际情况调整一个下次见面的小建议，别替我留下。";
  const earlierPlan = "如果氛围合适，轻轻问一句海边散步的事。";
  const initialAnswer: AgentDecision = { tool: "respond", args: {
    reply: "可以把这当作一条备选。", suggestions: [earlierPlan], sourceIds: [],
    date: "2026-11-06", constraints: ["在海边", "安静的地方"],
  } };

  it("treats past plans as history after feedback and keeps the user's exact impression and selection recoverable", async () => {
    const { service, observations } = setup(input => {
      if (input.task.goal === firstIntent) return initialAnswer;
      if (!input.results.length) return { tool: "read_progress", args: { offset: 0 } };
      return answer("你说后来散了步，也觉得 Ta 那天有些累。", ["下次先问问 Ta 想坐坐还是走走。"]);
    });
    let view = await service.create("alice", { operationKey: "prepare", text: firstIntent });
    expect(view).toMatchObject({ date: "2026-11-06", constraints: ["在海边", "安静的地方"] });
    const chosenId = view.items[0].id;
    view = service.mutate("alice", view.id, {
      operationKey: "select", expectedVersion: view.version, kind: "select", itemId: chosenId,
    });
    view = await service.turn("alice", view.id, {
      operationKey: "return", expectedVersion: view.version, text: feedback,
    });
    expect(view.generationStatus).toBe("idle");
    expect(observations).toHaveLength(3);
    expect(observations[1].observation).toMatchObject({
      intent: feedback, date: null, constraints: [], maxSuggestions: 1,
      messages: [{ role: "user", text: feedback, kind: "feedback", origin: "user_reflection", earlierMeeting: false }],
      latestFeedback: { text: feedback, origin: "user_reflection", sources: [] },
      items: [{ id: chosenId, text: earlierPlan, status: "selected", earlierMeeting: true }],
    });
    const history = observations[2].results.find(result => result.tool === "read_progress")?.value;
    expect(history).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ text: firstIntent, earlierMeeting: true }),
        expect.objectContaining({ text: feedback, earlierMeeting: false }),
      ]),
      events: expect.arrayContaining([
        expect.objectContaining({ text: firstIntent, earlierMeeting: true }),
        expect.objectContaining({ text: feedback, earlierMeeting: false }),
      ]),
    });
    const reopened = service.get("alice", view.id);
    expect(reopened.messages[0].text).toBe(firstIntent);
    expect(reopened.messages.at(-2)).toMatchObject({ text: feedback, kind: "feedback", origin: "user_reflection", sources: [] });
    expect(reopened.items).toMatchObject([
      { id: chosenId, text: earlierPlan, status: "selected" },
      { status: "suggested" },
    ]);
    expect(reopened).toMatchObject({ date: null, constraints: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves a same-meeting rescheduling discussion and a new date the user gives after returning", async () => {
    const sameMeeting = "还是这次见面，只改去附近的书店。";
    const newDate = "回来记一下，那次坐了会儿。下次定在 2026-11-12 晚上，约在地铁口。";
    const { service, observations } = setup(input => {
      if (input.task.goal === firstIntent) return initialAnswer;
      if (input.task.goal === newDate) return { tool: "respond", args: {
        reply: "记下你说的下次安排了。", suggestions: [], sourceIds: [], date: "2026-11-12", constraints: ["在地铁口"],
      } };
      return answer("可以，接着说。");
    });
    let view = await service.create("alice", { operationKey: "before", text: firstIntent });
    view = await service.turn("alice", view.id, { operationKey: "adjust", expectedVersion: view.version, text: sameMeeting });
    expect(observations[1].observation).toMatchObject({
      date: "2026-11-06", intent: firstIntent,
      messages: expect.arrayContaining([expect.objectContaining({ text: firstIntent, earlierMeeting: false })]),
    });
    view = await service.turn("alice", view.id, {
      operationKey: "explicit-date", expectedVersion: view.version, text: newDate, kind: "feedback",
    });
    expect(observations[2].observation).toMatchObject({ intent: newDate, date: null, constraints: [], latestFeedback: { text: newDate } });
    expect(service.get("alice", view.id)).toMatchObject({ date: "2026-11-12", constraints: ["在地铁口"] });
    view = await service.turn("alice", view.id, {
      operationKey: "continue", expectedVersion: view.version, text: "还想聊聊到时候怎么开口。",
    });
    expect(view.generationStatus).toBe("idle");
    expect(observations[3].observation).toMatchObject({
      intent: newDate, date: "2026-11-12", constraints: ["在地铁口"],
      messages: expect.arrayContaining([expect.objectContaining({ text: newDate, earlierMeeting: false })]),
    });
    expect(JSON.stringify(observations[3].observation)).not.toContain(firstIntent);
  });

  function wireSuggestionLimit(input: AgentDecisionInput) {
    const wire = agentDecisionRequest(input);
    const payload = JSON.parse(wire.messages[1].content) as {
      tools: Array<{ name: string; parameters: { properties: { suggestions: { maxItems: number } } } }>;
    };
    return payload.tools.find(tool => tool.name === "respond")?.parameters.properties.suggestions.maxItems;
  }

  it("rejects the earlier two-action feedback response to a single-suggestion request before publishing or retrying", async () => {
    const badReply = "明天下午如果 Ta 工作也比较累，可以选一个不费力、随时能停下来的地方，比如找个安静的咖啡馆坐一会儿，或者附近有树荫的河边/公园慢慢走。";
    const badSuggestions = [
      "如果看 Ta 有点累，先问一句：“今天想坐着还是慢慢走走？”按 Ta 的答案来，不主动安排更多行程。",
      "散步时保持少话也没关系；等 Ta 先说话，再简单接一句，比如“那会儿累坏了吧”，不追问细节。",
    ];
    const { service, observations, db } = setup(input => input.task.goal === firstIntent ? initialAnswer : answer(badReply, badSuggestions));
    let view = await service.create("alice", { operationKey: "first", text: firstIntent });
    const originalId = view.items[0].id;
    view = service.mutate("alice", view.id, { operationKey: "keep", expectedVersion: view.version, itemId: originalId, kind: "select" });
    const turn = { operationKey: "return", expectedVersion: view.version, text: feedback, kind: "feedback" as const };
    view = await service.turn("alice", view.id, turn);
    expect(wireSuggestionLimit(observations[1])).toBe(1);
    expect(view.generationStatus).toBe("failed");
    expect(view.messages.at(-1)).toMatchObject({ text: feedback, role: "user", origin: "user_reflection" });
    expect(view.messages.some(message => message.text === badReply)).toBe(false);
    expect(view.items).toMatchObject([{ id: originalId, text: earlierPlan, status: "selected" }]);
    await service.turn("alice", view.id, turn);
    expect(observations).toHaveLength(2);
    expect(db.prepare("SELECT COUNT(*) AS calls FROM agent_calls").get()).toEqual({ calls: 2 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("publishes two distinct optional preparations when the user explicitly asks for two", async () => {
    const options = ["从最近看过的一本书聊起。", "问问最近一次有趣的散步。"];
    const { service, observations } = setup(() => answer("这两个方向都可以轻松开场。", options));
    const view = await service.create("alice", { operationKey: "two", text: "下午一点见 Ta。给我两个不同的开场说法。" });
    expect(wireSuggestionLimit(observations[0])).toBe(2);
    expect(view.generationStatus).toBe("idle");
    expect(view.items.map(item => [item.text, item.status])).toEqual(options.map(text => [text, "suggested"]));
    expect(observations).toHaveLength(1);
  });

  it("opens pre-fix feedback without treating its previous date as current or rewriting the saved conversation", async () => {
    const { service, db, observations } = setup(() => answer("可以，接着聊。"));
    let view = await service.create("alice", { operationKey: "old", text: firstIntent });
    view = await service.turn("alice", view.id, { operationKey: "return", expectedVersion: view.version, text: feedback });
    const row = db.prepare("SELECT body_json FROM dc_preparations WHERE id=?");
    const body = JSON.parse((row.get(view.id) as {body_json:string}).body_json);
    delete body.planningAfterFeedback;
    Object.assign(body, {date: "2026-11-06", constraints: ["在海边"], intent: firstIntent});
    const original = JSON.stringify(body);
    db.prepare("UPDATE dc_preparations SET body_json=? WHERE id=?").run(original, view.id);
    expect(service.get("alice", view.id)).toMatchObject({ intent: feedback, date: null, constraints: [], messages: view.messages });
    expect(row.get(view.id)).toEqual({body_json: original});
    await service.turn("alice", view.id, { operationKey: "continue", expectedVersion: view.version, text: "接着聊下次吧" });
    expect(observations.at(-1)?.observation).toMatchObject({ intent: feedback, date: null, constraints: [] });
  });

  it("keeps a suggestion-only reply editable without leaving a second copy in the conversation", async () => {
    const { service } = setup(() => answer(earlierPlan, [earlierPlan]));
    let view = await service.create("alice", {operationKey: "one", text: "只给我一条就行。"});
    expect(view.messages.at(-1)?.text).toBe("");
    const id = view.items[0].id;
    view = service.mutate("alice", view.id, {operationKey: "edit", expectedVersion: view.version, kind: "edit", itemId: id, text: "我想先问问最近过得怎么样。"});
    expect(view.messages.some(m => m.text === earlierPlan)).toBe(false);
    expect(view.items[0]).toMatchObject({id, status: "suggested", text: "我想先问问最近过得怎么样。"});
  });
});

describe("using a confirmed recap in its preparation", () => {
  it("keeps an old P1 feedback preamble in the audit trail but out of ordinary and paged model input without a scope change", async () => {
    const preamble = "照顾到 Ta 累了的错误前言";
    const option = "先问问今天想怎么走。";
    const {service,db,observations} = setup(input => {
      if (input.task.goal === "会前想安静一点。") return answer("想从哪儿聊起？");
      if (input.task.goal === "还想接着聊。") {
        if (!input.results.length) return {tool:"read_progress",args:{offset:0}};
        return answer("你现在最想聊的是哪部分？");
      }
      return answer(preamble,[option]);
    });
    let view = await service.create("alice",{operationKey:"first",text:"会前想安静一点。"});
    view = await service.turn("alice",view.id,{operationKey:"after",expectedVersion:view.version,kind:"feedback",text:"我觉得 Ta 那天有点累。"});
    const row = db.prepare("SELECT body_json FROM dc_preparations WHERE id=?").get(view.id) as {body_json:string};
    const stored = JSON.parse(row.body_json) as typeof view;
    // Recreate the pre-fix business projection, keeping the genuine Runtime
    // action arguments.
    const old = stored.messages.at(-1)!;
    old.text = preamble;
    const event = stored.events.find(e => e.id === old.id)!;
    event.text = preamble;
    delete event.data.contextChecked;
    db.prepare("UPDATE dc_preparations SET body_json=? WHERE id=?").run(JSON.stringify(stored),view.id);
    const before = observations.length;
    view = await service.turn("alice",view.id,{operationKey:"continue",expectedVersion:view.version,text:"还想接着聊。"});
    expect(view.generationStatus).toBe("idle");
    expect(observations.slice(before)).toHaveLength(2);
    for (const input of observations.slice(before)) {
      const wire = JSON.stringify(agentDecisionRequest(input).messages);
      expect(wire).not.toContain(preamble);
      expect(wire).toContain(option);
    }
    expect(service.repository.get("alice",view.id).messages.find(m => m.id === old.id)?.text).toBe(preamble);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE tool='respond' AND instr(args_json,?)>0").get(preamble)).toMatchObject({n:1});
  });

  it("does not let untracked P1 derivatives survive source deletion through a new turn or older progress", async () => {
    const legacyText = "旧准备中的云南细节";
    const legacySummary = "旧对照中推测的云南行程";
    const legacyConstraint = "旧摘要中的行程限制";
    const derivedAgain = "根据前次准备提出的新路线";
    const fresh = "回到我自己的感受。";
    const {service,db,observations} = setup(input => {
      if (input.task.goal === fresh && !input.results.length) return {tool:"read_progress",args:{offset:0}};
      return input.task.goal === fresh ? answer("可以从这里接着聊。") : answer("",[derivedAgain]);
    });
    const interactionId = seed(db);
    const relations = new DateCompanionRepository(db);
    const relationshipId = relations.listRelationships("alice")[0].id;
    const store = service.repository;
    const {id} = store.create("alice",relationshipId,{operationKey:"p1",text:"旅行话题",interactionIds:[interactionId],allowRetained:false});
    const first = store.begin("alice",id,{operationKey:"p1-1",expectedVersion:0,text:"查旅行",kind:"message"});
    const sources = service.sources.reviewSources("alice",relationshipId,interactionId);
    let view = store.commit("alice",id,{generationId:first.generationId!,version:first.version!,text:"原有依据",sources,suggestions:["原有建议"]});
    const old = store.begin("alice",id,{operationKey:"p1-2",expectedVersion:view.version,text:"想一个准备",kind:"message"});
    view = store.commit("alice",id,{generationId:old.generationId!,version:old.version!,text:legacySummary,sources:[],
      suggestions:[legacyText],date:"2027-03-16",constraints:[legacyConstraint]});
    view = service.mutate("alice",id,{operationKey:"old-selection",expectedVersion:view.version,kind:"select",itemId:view.items[1].id});
    view = service.mutate("alice",id,{operationKey:"remove-first",expectedVersion:view.version,kind:"remove",itemId:view.items[0].id});
    view = await service.turn("alice",id,{operationKey:"p2",expectedVersion:view.version,text:"基于上次的内容再想一条。"});
    expect(view.items.at(-1)?.sources.map(s => s.id)).toEqual(sources.map(s => s.id));
    relations.deleteInteraction("alice",interactionId,relations.getInteractionDetail("alice",relationshipId,interactionId).version);
    const before = observations.length;
    view = await service.turn("alice",id,{operationKey:"without-source",expectedVersion:view.version,text:fresh});
    expect(view.items[1]).toMatchObject({status:"selected",text:legacyText});
    expect(view.generationStatus).toBe("idle");
    expect(observations.slice(before)).toHaveLength(2);
    for (const input of observations.slice(before)) {
      const wire = JSON.stringify(agentDecisionRequest(input).messages);
      for (const unavailable of [legacyText,legacySummary,legacyConstraint,derivedAgain,"2027-03-16",sources[0].quote]) {
        expect(wire).not.toContain(unavailable);
      }
    }
  });

  it.each(["unlink", "delete"] as const)("fences direct and inherited recap text after %s, including paged progress", async disposition => {
    const rawQuote = "我想去云南旅行";
    const fromQuote = "从那段关于云南的原话接着说";
    const inferred = "参考此前那条云南话题的准备";
    const initial = "明天下午见面，先给我一条准备。";
    const feedback = "上次没聊旅行，我觉得 Ta 有点累。帮我核对这次的记录。";
    const {service, db, observations} = setup(input => {
      if (input.task.goal === initial) return answer("", ["找个轻松的机会聊聊旅行。"]);
      if (input.task.goal === feedback) {
        const result = input.results.find(r => r.tool === "list_review_sources");
        if (!result) return {tool:"list_review_sources", args:{}};
        const source = (result.value as {sources:{id:string}[]}).sources[0];
        if (!input.results.some(r => r.tool === "read_source")) return {tool:"read_source", args:{sourceId:source.id}};
        return {tool:"respond",args:{reply:"这里有记录可以核对。",suggestions:[fromQuote],sourceIds:[source.id],
          date:"2026-11-01",constraints:["Ta 工作很累"]}};
      }
      if (input.task.goal === "接着想一个下一次的开场。") return answer("另一个自由前言", [inferred]);
      if (!input.results.length) return {tool:"read_progress", args:{offset:0}};
      if (input.results.length === 1) return {tool:"read_progress", args:{offset:8}};
      return answer("可以继续说说你当时的感受。");
    });
    const interactionId = seed(db);
    let view = await service.create("alice", {operationKey:"start", text:initial, interactionIds:[interactionId]});
    const original = view.items[0];
    view = service.mutate("alice", view.id, {operationKey:"keep", expectedVersion:view.version, kind:"select", itemId:original.id});
    view = service.mutate("alice", view.id, {operationKey:"associate", expectedVersion:view.version, kind:"link_review", interactionId});
    view = service.mutate("alice", view.id, {operationKey:"edit", expectedVersion:view.version, kind:"edit", itemId:original.id, text:"改过的旅行话题"});
    view = await service.turn("alice", view.id, {operationKey:"review", expectedVersion:view.version, text:feedback, kind:"feedback"});
    expect(view.generationStatus).toBe("idle");
    expect(observations[1].observation).toMatchObject({
      linkedReview:{interactionId, originalItemIds:[original.id]},
      items:[{id:original.id, earlierMeeting:true, textWhenLinked:original.text}],
      latestFeedback:{text:feedback,origin:"user_reflection"},
    });
    expect(JSON.stringify(observations[2].results)).not.toContain(rawQuote);
    expect(JSON.stringify(observations[3].results)).toContain(rawQuote);
    expect(view.messages.at(-1)?.sources[0].quote).toBe(rawQuote);
    expect(view.date).toBeNull();
    expect(view.constraints).toEqual([]);
    view = await service.turn("alice", view.id, {operationKey:"adjust", expectedVersion:view.version, text:"接着想一个下一次的开场。"});
    expect(view.items.at(-1)).toMatchObject({text:inferred, sources:[{quote:rawQuote}], meetingId:view.reviewLink?.nextMeetingId});
    expect(view.messages.at(-1)?.text).toBe("");
    if (disposition === "unlink") {
      const callsBeforeUnlink = observations.length;
      view = await service.turn("alice", view.id, {operationKey:"unlink", expectedVersion:view.version, text:"不再用这份记录。"});
      expect(observations.length).toBe(callsBeforeUnlink);
      expect(view.reviewLink).toBeNull();
      // This separate P1 grant still permits a fresh search, but the old
      // comparison was made under the withdrawn link and must not be replayed.
      expect(view.interactionIds).toEqual([interactionId]);
    } else {
      const repo = new DateCompanionRepository(db);
      repo.deleteInteraction("alice", interactionId, repo.getInteractionDetail("alice",view.relationshipId,interactionId).version);
      view = service.get("alice",view.id);
      expect(view.reviewLink?.available).toBe(false);
    }
    expect(view.items.at(-1)?.sources[0]).toMatchObject({valid:false,quote:""});
    const after = observations.length;
    view = await service.turn("alice", view.id, {operationKey:"after", expectedVersion:view.version, text:"只想谈谈我自己的感受。"});
    expect(view.generationStatus).toBe("idle");
    for (const input of observations.slice(after)) {
      const wire = JSON.stringify(agentDecisionRequest(input).messages);
      expect(wire).not.toContain(rawQuote);
      expect(wire).not.toContain(fromQuote);
      expect(wire).not.toContain(inferred);
      expect(wire).toContain(feedback);
    }
    expect(view.items[0]).toMatchObject({id:original.id,status:"selected",text:"改过的旅行话题"});
  });

  it("a replayed link request cannot cancel a newer generation; a real unlink fences its late answer", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pause = new Promise<void>(resolve => { release = resolve; });
    const {service,db} = setup(async input => {
      if (input.task.goal === "请看看这次说了什么。") { entered(); await pause; }
      return answer("这是一段回答。");
    });
    const interactionId = seed(db);
    let view = await service.create("alice",{operationKey:"create",text:"准备见面"});
    const link = {operationKey:"link",expectedVersion:view.version,kind:"link_review",interactionId};
    view = service.mutate("alice",view.id,link);
    const pending = service.turn("alice",view.id,{operationKey:"review",expectedVersion:view.version,text:"请看看这次说了什么。"});
    await started;
    const during = service.mutate("alice",view.id,link);
    expect(during.generationStatus).toBe("running");
    const taskId = service.repository.active("alice",view.id).taskId!;
    expect(service.store.getTask("alice",taskId).status).toBe("running");
    const unlinked = service.mutate("alice",view.id,{operationKey:"unlink",expectedVersion:during.version,kind:"unlink_review"});
    release();
    const after = await pending;
    expect(after.messages).toEqual(unlinked.messages);
    expect(after.reviewLink).toBeNull();
    expect(after.version).toBe(unlinked.version);
  });

  it("keeps current intent, feedback and choice ownership under the wire limit and pages the original selection wording", async () => {
    const original="碰面时问问最近想去的地方。", edited="如果聊得自然，再问问最近想去哪里。";
    const initial="11月6日见面，帮我想一条准备。", feedback="上次没聊旅行，后来安静地走了一会。";
    const correction="纠正一下，我更在意能不能自在相处。", probe="请找回我最早留下的内容，接着想一条。";
    const {service,observations}=setup(input=>{
      if(input.task.goal===initial)return {tool:"respond",args:{reply:"",suggestions:[original],sourceIds:[],date:"2026-11-06"}};
      if(input.task.goal===probe && !input.results.length)return {tool:"read_progress",args:{offset:0}};
      return answer("这次先从你的感觉聊起。",input.task.goal===probe?["见面时直接问问 Ta 今天想怎么过。"]:[]);
    });
    let view=await service.create("alice",{operationKey:"start",text:initial});
    const itemId=view.items[0].id;
    view=service.mutate("alice",view.id,{operationKey:"select",expectedVersion:view.version,kind:"select",itemId});
    view=service.mutate("alice",view.id,{operationKey:"edit",expectedVersion:view.version,kind:"edit",itemId,text:edited});
    view=await service.turn("alice",view.id,{operationKey:"feedback",expectedVersion:view.version,text:feedback,kind:"feedback"});
    view=await service.turn("alice",view.id,{operationKey:"correct",expectedVersion:view.version,text:correction});
    for(let i=0;i<14;i++){
      const turn=service.repository.begin("alice",view.id,{operationKey:`middle-${i}`,expectedVersion:view.version,kind:"message",text:`中间的第${i}次交流。`+"这是一段较长的合成文字。".repeat(420)});
      view=service.repository.commit("alice",view.id,{generationId:turn.generationId!,version:turn.version!,text:"我听到了你的想法。".repeat(580),suggestions:[],sources:[],contextChecked:true});
    }
    const count=observations.length;
    view=await service.turn("alice",view.id,{operationKey:"continue",expectedVersion:view.version,text:probe});
    const requests=observations.slice(count);
    expect(requests).toHaveLength(2);
    for(const input of requests){
      expect(agentDecisionRequest(input).inputChars).toBeLessThanOrEqual(48_000);
      expect(input.observation).toMatchObject({intent:correction,date:null,latestFeedback:{text:feedback},latestCorrection:{text:correction},
        items:expect.arrayContaining([expect.objectContaining({id:itemId,text:edited,choiceState:"earlier",earlierMeeting:true})])});
      expect((input.observation as {messages:unknown[]}).messages.length).toBeLessThan(12);
    }
    expect(requests[1].results[0].value).toMatchObject({nextOffset:8,events:expect.arrayContaining([
      expect.objectContaining({kind:"select",itemId,text:original,currentChoiceState:"earlier",earlierMeeting:true}),
      expect.objectContaining({kind:"edit",itemId,text:edited,currentChoiceState:"earlier",earlierMeeting:true})])});
    expect(view.items.at(-1)?.status).toBe("suggested");expect(view.messages).toHaveLength(36);
  });

  it("marks only an explicitly withdrawn current choice historical and keeps later decisions idempotent",async()=>{
    const firstText="先聊聊这周的工作。", request="我改主意了，这条准备不用了，我们聊聊自己的感受。";
    const {service,observations}=setup(input=>input.task.goal==="给我一个准备"?answer("",[firstText]):answer("可以，我们从现在的感受说起。"));
    let view=await service.create("alice",{operationKey:"initial",text:"给我一个准备"});
    const itemId=view.items[0].id;
    view=service.mutate("alice",view.id,{operationKey:"choose",kind:"select",expectedVersion:view.version,itemId});
    view=await service.turn("alice",view.id,{operationKey:"uncertain",text:"是不是这条准备不用了？我还没决定。",expectedVersion:view.version});
    expect(view.items[0].status).toBe("selected");
    const turn={operationKey:"withdraw",text:request,expectedVersion:view.version};
    view=await service.turn("alice",view.id,turn);
    expect(observations.at(-1)?.observation).toMatchObject({intent:request,latestCorrection:{text:request},items:[{id:itemId,choiceState:"withdrawn",status:"removed",text:firstText}]});
    expect(view.items[0]).toMatchObject({id:itemId,status:"removed",text:firstText});
    const duplicate=await service.turn("alice",view.id,turn);
    expect(duplicate.events).toEqual(view.events);
  });

  it("stops a continuing tool loop when an already-read canonical quote changes; only a fresh turn may read the new version",async()=>{
    const beforeQuote="我想去云南旅行", afterQuote="我想去广西旅行";
    const {service,db,observations}=setup(input=>{
      const located=input.results.find(r=>r.tool==="search_records");
      if(!located)return {tool:"search_records",args:{query:"旅行"}};
      const id=(located.value as {sources:Array<{id:string}>}).sources[0].id;
      const read=input.results.find(r=>r.tool==="read_source");
      if(!read)return {tool:"read_source",args:{sourceId:id}};
      const seen=(read.value as {sources:Array<{quote:string}>}).sources[0].quote;
      if(input.task.goal==="帮我核对上次的旅行原话"){
        expect(seen).toBe(beforeQuote);
        const digest=dateCompanionEvidenceDigest({userId:"alice",uploadId:"synthetic-upload",sourceSegmentId:"synthetic-travel",startSeconds:0,endSeconds:3,speakerId:"ta",quote:afterQuote});
        db.prepare('UPDATE dc_evidence_snapshots SET quote=?,content_digest=? WHERE id=?').run(afterQuote,digest,id);
        return {tool:"read_progress",args:{offset:0}};
      }
      expect(seen).toBe(afterQuote);return answer(`这次核对到的原话是：${seen}`,[],[id]);
    });
    const interactionId=seed(db);
    let view=await service.create("alice",{operationKey:"first",text:"帮我核对上次的旅行原话",interactionIds:[interactionId]});
    expect(observations).toHaveLength(3);expect(view.generationStatus).toBe("failed");expect(view.messages.map(m=>m.role)).toEqual(["user"]);
    view=await service.turn("alice",view.id,{operationKey:"fresh",expectedVersion:view.version,text:"请重新核对当前旅行记录。"});
    expect(view.messages.at(-1)?.sources[0].quote).toBe(afterQuote);
    expect(observations.slice(3)).toHaveLength(3);
    for(const input of observations.slice(3))expect(JSON.stringify(agentDecisionRequest(input).messages)).not.toContain(beforeQuote);
  });

  it("declining the newest suggestion does not retract a different selected choice",async()=>{
    const {service}=setup(input=>input.task.goal==="开始准备"?answer("",["聊聊学校的近况"]):input.task.goal==="再给一个想法"?answer("",["到河边坐坐"]):answer("我们接着聊。"));
    let view=await service.create("alice",{operationKey:"first",text:"开始准备"});
    const original=view.items[0].id;
    view=service.mutate("alice",view.id,{operationKey:"select",expectedVersion:view.version,kind:"select",itemId:original});
    view=await service.turn("alice",view.id,{operationKey:"second",expectedVersion:view.version,text:"再给一个想法"});
    const latest=view.items[1].id;
    view=await service.turn("alice",view.id,{operationKey:"remove",expectedVersion:view.version,text:"这条先不留了。"});
    expect(view.items).toMatchObject([{id:original,status:"selected"},{id:latest,status:"removed"}]);
  });

  it("tracks a valid source from a withdrawn choice and fences the later derived response after source deletion",async()=>{
    const first="找一条旅行原话", historical="曾选过的云南话题", derived="核对过的滇池意向";
    const {service,db,observations}=setup(input=>{
      if(input.task.goal===first){
        if(!input.results.length)return {tool:"search_records",args:{query:"旅行"}};
        const id=(input.results[0].value as {sources:Array<{id:string}>}).sources[0].id;
        if(input.results.length===1)return {tool:"read_source",args:{sourceId:id}};
        return answer("",[historical],[id]);
      }
      if(input.task.goal==="现在只想聊聊当时的顾虑")return answer(derived);
      return input.results.length?answer("说说现在的想法吧。"): {tool:"read_progress",args:{offset:0}};
    });
    const interaction=seed(db);let view=await service.create("alice",{operationKey:"find",text:first,interactionIds:[interaction]});
    const id=view.items[0].id;
    for(const kind of ["select","remove"])view=service.mutate("alice",view.id,{operationKey:kind,expectedVersion:view.version,kind,itemId:id});
    view=await service.turn("alice",view.id,{operationKey:"discuss",expectedVersion:view.version,text:"现在只想聊聊当时的顾虑"});
    expect(observations.at(-1)?.observation).toMatchObject({items:[{id,choiceState:"withdrawn",text:historical}]});
    expect(view.messages.at(-1)).toMatchObject({text:derived,sources:[{quote:"我想去云南旅行"}]});
    const repo=new DateCompanionRepository(db);
    repo.deleteInteraction("alice",interaction,repo.getInteractionDetail("alice",view.relationshipId,interaction).version);
    const count=observations.length;view=await service.turn("alice",view.id,{operationKey:"again",expectedVersion:view.version,text:"回看当时的选择，接着谈心情。"});
    expect(view.generationStatus).toBe("idle");expect(observations.slice(count)).toHaveLength(2);
    for(const input of observations.slice(count)){const wire=JSON.stringify(agentDecisionRequest(input).messages);for(const forbidden of [historical,derived,"我想去云南旅行"])expect(wire).not.toContain(forbidden);}
  });
});
