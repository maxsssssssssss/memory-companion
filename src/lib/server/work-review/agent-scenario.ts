import type Database from "better-sqlite3";
import { z } from "zod";
import { WORK_AGENT_SCENARIO, WorkAgentChangeKey, type WorkAgentContext, type WorkAgentComparison } from "@/lib/domain/work-agent";
import { WorkReviewIdSchema } from "@/lib/domain/work-review";
import { AgentFailure, type AgentContext, type AgentDecisionProvider, type AgentScenario, type AgentToolResult } from "@/lib/server/agent/types";
import { WorkAgentRepository } from "./agent-repository";
import { readWorkAgentSource } from "./agent-context";
import { compareWorkMeeting, decideWorkAgent } from "./agent-model";

const empty = z.object({}).strict();
export const WorkAgentSelection = z.object({previewId:WorkReviewIdSchema,fingerprint:z.string().length(64),keys:z.array(WorkAgentChangeKey).max(20)}).strict();
export type WorkCompare = (context:WorkAgentContext,ctx:AgentContext)=>Promise<WorkAgentComparison>;
export function createWorkAgentScenario(db: Database.Database, compare: WorkCompare = compareWorkMeeting): AgentScenario {
  const repo = new WorkAgentRepository(db);
  const appliedResult = (id:string):AgentToolResult => ({ref:{kind:"work_comparison",id},summary:"已核对实际保存结果。",handoff:"选中的后续工作已保存；未选中的建议未写入。"});
  const read = async (_receipt:unknown,ctx:AgentContext) => repo.read(ctx.task);
  return {
    id:WORK_AGENT_SCENARIO,
    instructions:`这是同项目会后连续复盘。先按目标读取上下文，调用work.compare_meeting保存比较。若用户只问比较，可在有比较成果后finish；不能说安排已保存。
若用户要整理后续工作，调用work.preview_follow_up_changes后等待用户选择。用户选择后系统会固定批准项，不要再调用模型更换。
只能访问当前账号、项目和当前已核对会议。不存在邮件或外部服务工具。不要重复已有比较；具体关系在用户批准前都只是建议。`,
    async validate(ctx) {
      if (ctx.task.scenario !== WORK_AGENT_SCENARIO) throw new AgentFailure("forbidden","办公场景不匹配。");
      const artifact=repo.read(ctx.task);
      if (artifact?.state === "invalidated") throw new AgentFailure("source_changed","比较来源已失效。");
      repo.context(ctx.task,!artifact?.applied);
    },
    async observe(ctx) {
      const context=repo.context(ctx.task), artifact=repo.read(ctx.task);
      return {project:context.project,meetingId:context.meetingId,coverage:context.coverage,
        comparisonSaved:!!artifact?.comparison,previewSaved:!!artifact?.preview,
        selectionSaved:!!artifact?.preview?.selectedKeys,applied:!!artifact?.applied};
    },
    async validateEvent(event,ctx) {
      if (!event.id || event.id.length>180 || (event.message?.length??0)>2000) throw new AgentFailure("invalid_action","反馈事件超过允许长度，尚未固定选择。");
      if (event.kind === "work_selection") {
        const input=WorkAgentSelection.parse(JSON.parse(event.message ?? "null"));
        if (event.refId !== input.previewId) throw new AgentFailure("invalid_action","选择不属于当前预览。");
        repo.select(ctx.task,input);
      } else if (event.kind !== "feedback" || !event.message?.trim() || event.message.length>2000) throw new AgentFailure("invalid_action","反馈格式无效。");
    },
    async finish(_reason,ctx) {
      const artifact=repo.read(ctx.task);
      if (!artifact?.comparison) throw new AgentFailure("invalid_action","必须先保存有依据的比较结果。");
      if (artifact.applied) return "后续工作已保存。";
      return "比较结果已保存；关系和待办建议尚未应用。可回到结果中选择并确认后续工作。";
    },
    tools:{
      "work.read_project_context":{description:"读取本次项目已确认结果、有效直接原文、当前Todo与已确认关系；显示覆盖范围。",parameters:empty,
        async execute(_args,ctx){repo.context(ctx.task);return {ref:{kind:"work_context",id:ctx.task.resourceId},summary:"已读取当前项目上下文。"};},
        async readResult(_receipt,ctx){return repo.context(ctx.task);}},
      "work.read_meeting_evidence":{description:"查看已读取Finding的直接会议原文。",parameters:z.object({findingId:WorkReviewIdSchema}).strict(),
        async execute(args,ctx){const {findingId}=args as {findingId:string};if(!repo.context(ctx.task).sources.some(s=>s.findingId===findingId))throw new AgentFailure("forbidden","来源不在本次读取范围。");return {ref:{kind:"work_finding",id:findingId},summary:"已定位会议原文。"};},
        async readResult(receipt,ctx){return readWorkAgentSource(db,ctx.task.accountId,ctx.task.resourceId,receipt.resultRef!.id);}},
      "work.compare_meeting":{description:"比较已确认会议事实并持久保存有依据的结果和待确认建议。不会修改关系或Todo。",parameters:empty,
        async execute(_args,ctx){const old=repo.read(ctx.task);if(old)return {ref:{kind:"work_comparison",id:old.id},summary:"已复用本轮比较成果。"};
          const context=repo.context(ctx.task),comparison=await compare(context,ctx);await ctx.assertActive();
          const artifact=repo.saveComparison(ctx.task,comparison);return {ref:{kind:"work_comparison",id:artifact.id},summary:"比较已保存，建议尚未应用。"};},
        readResult:read,
        async recover(_actionId,ctx){const a=repo.read(ctx.task);return a?{ref:{kind:"work_comparison",id:a.id},summary:"已找到本轮比较成果。"}:null;}},
      "work.preview_follow_up_changes":{description:"固定本轮修改预览并等待用户逐项选择；不写业务关系或Todo。",parameters:empty,
        async execute(_args,ctx){await ctx.assertActive();const p=repo.preview(ctx.task);return {ref:{kind:"work_preview",id:p.id},summary:"修改预览已固定。",
          wait:{kind:"work_selection",refId:p.id,message:"请选择需要保存的修改；未选中的建议不会执行。"}};},readResult:read},
      "work.apply_confirmed_changes":{description:"仅执行用户选中且明确批准的固定预览；事务保存并核对真实结果。",parameters:empty,
        async confirmation(_args,ctx){return repo.confirmation(ctx.task);},
        async execute(_args,ctx){await ctx.assertActive();const a=repo.apply(ctx.task,ctx.actionId);return appliedResult(a.id);},
        async validateResult(_result,ctx){repo.assertApplied(ctx.task,ctx.actionId);},readResult:read,
        async recover(actionId,ctx){const a=repo.recover(ctx.task,actionId);return a?appliedResult(a.id):null;}},
    },
  };
}
/** Business-event routing, not a second loop: after selection there is no further model generation. */
export function withWorkSelection(db:Database.Database, decision:AgentDecisionProvider=decideWorkAgent):AgentDecisionProvider {
  return async (input,ctx)=>{
    const artifact=new WorkAgentRepository(db).read(ctx.task);
    if(ctx.task.approval?.status==="rejected")return {finish:"用户拒绝修改，保留比较成果。"};
    if (artifact?.preview?.selectedKeys && !artifact.applied) return {tool:"work.apply_confirmed_changes",args:{}};
    if (artifact?.preview && !artifact.applied) return {tool:"work.preview_follow_up_changes",args:{}};
    if (artifact?.comparison && /保存|安排|整理.*(?:工作|后续|待办)/u.test(ctx.task.goal)) return {tool:"work.preview_follow_up_changes",args:{}};
    return decision(input,ctx);
  };
}
