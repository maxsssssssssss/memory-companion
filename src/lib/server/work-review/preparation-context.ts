import type Database from "better-sqlite3";
import type { WorkPreparationContext, WorkAgendaSuggestion } from "@/lib/domain/work-preparation";
import { readWorkAgentContext, workAgentHash } from "./agent-context";
import { readWorkAgentProject } from "./agent-service";

/** P1's bounded confirmed evidence + P2's authoritative projections, not a new state calculator. */
export function readWorkPreparationContext(db: Database.Database, accountId: string, projectId: string): WorkPreparationContext {
  const context = readWorkAgentContext(db, accountId, projectId);
  const project = readWorkAgentProject(db, accountId, projectId);
  const read = new Set(context.sources.map(s => s.findingId));
  const todoIds = new Set(context.todos.map(t => t.id));
  let remaining=Math.max(0,36_000-JSON.stringify(context).length);
  const fits=(value:unknown)=>{const size=JSON.stringify(value).length;if(size>remaining)return false;remaining-=size;return true;};
  const currentDecisions = project.threads.filter(t => t.state === "active" && t.currentFindingId).flatMap(t => {
    const source = context.sources.find(s => s.findingId === t.currentFindingId);
    return source ? [{ threadId: t.id, findingId: source.findingId, title: source.title, body: source.body }] : [];
  }).filter(fits);
  const openLoops = project.openLoops.filter(l => l.basis !== "agent_suggestion" && l.sources.every(s => read.has(s.findingId))
    && (!l.todoId || todoIds.has(l.todoId))).slice(0,40).filter(fits);
  const recentChanges = project.timeline.filter(t => t.sources.every(s => read.has(s.findingId))).slice(-30).filter(fits);
  const limited = context.coverage.limited || recentChanges.length < project.timeline.length || openLoops.length < project.openLoops.length
    || currentDecisions.length < project.threads.filter(t => t.state === "active").length;
  return {...context, asOf:new Date().toISOString(), meetingDate:null, currentDecisions, recentChanges, openLoops,
    fingerprint: workAgentHash([context.fingerprint, currentDecisions, recentChanges, openLoops]),
    coverage: {...context.coverage, limited, notice: context.coverage.notice +
      ` 会前补充读取 ${currentDecisions.length} 条当前决定、${recentChanges.length}/${project.timeline.length} 条历史变化、${openLoops.length}/${project.openLoops.length} 条关注记录。${limited ? "未纳入的事实不在本次准备范围内。" : ""}`}};
}

/** A record projection, never an inference that adoption means execution or silence means completion. */
export function workPreparationAgendaFacts(item:WorkAgendaSuggestion,context:WorkPreparationContext) {
  const sources=context.sources.filter(s=>item.sourceFindingIds.includes(s.findingId));
  const todos=context.todos.filter(t=>item.todoIds.includes(t.id));
  const threads=context.threads.filter(t=>item.threadIds.includes(t.id)||sources.some(s=>s.findingId===t.anchorFindingId||s.findingId===t.currentFindingId)
    ||t.linkedTodos.some(todo=>item.todoIds.includes(todo.id)));
  const loops=context.openLoops.filter(l=>l.todoId?item.todoIds.includes(l.todoId):l.threadId?threads.some(t=>t.id===l.threadId):l.sources.some(s=>item.sourceFindingIds.includes(s.findingId)));
  const threadStates={active:"当前有效",suspended:"已暂停",withdrawn:"已撤回",resolved:"已解决",open:"仍未解决",unknown:"依据或状态待核实"};
  const lines=[
    ...context.currentDecisions.filter(d=>threads.some(t=>t.id===d.threadId)||item.sourceFindingIds.includes(d.findingId)).map(d=>`当前正式决定：${d.title}。采用决定不代表相关工作已完成。`),
    ...todos.map(t=>`待办「${t.title}」：${t.status==="completed"?"已完成（正式待办记录）":t.kind==="waiting_for_other"?"等待他人回复（open）":"open"}；${t.currentDueDate?`待办截止日期 ${t.currentDueDate}`:"未设截止日期"}。${t.status==="open"?"该待办尚无完成确认记录，实际进展需要核实；不能据此断言现实中尚未完成。":""}`),
    ...threads.filter(t=>t.kind==="question"||t.state!=="active").map(t=>`议题「${t.title}」：${threadStates[t.state]}。${t.kind==="question"?"问题状态依据已确认关系，与待办完成分别判断。":""}`),
    ...loops.filter(l=>!l.todoId&&!threads.some(t=>t.id===l.threadId)).map(l=>`「${l.title}」：${l.status==="unresolved"?"仍未解决":l.status==="waiting"?"仍在等待":l.status==="source_invalid"?"来源失效":l.status==="no_follow_up"?"当前读取范围内没有找到后续记录，不代表现实未处理":"当前状态需要核实"}。`),
  ];
  const reason=todos.some(t=>t.status==="open")?"核实关联待办的实际进展、阻塞与后续安排。":loops.length?"核对项目记录中的待处理问题及所需决定。":"核对关联记录与本次讨论目标，不预设工作已完成。";
  // Historical record labels remain historical. No model-written connective narrative is retained.
  const background=sources.map(s=>`${s.meetingDate} · ${s.meetingTitle} · ${s.title}（${s.kind==="decision"?(s.finality==="final"?"会议当时的正式决定":"提议或暂定，非当前决定"):"已确认会议记录"}；详见原文）`).join("\n");
  return {reason,background,currentStatus:lines.join("\n")||(sources.length?"仅有历史依据，当前实际状态需要核实。":"尚未关联业务记录，作为讨论计划保留。")};
}
