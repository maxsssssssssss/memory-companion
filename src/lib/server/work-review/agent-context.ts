import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { WorkAgentContext, WorkAgentSource, WorkThreadView } from "@/lib/domain/work-agent";
import { WorkMeetingCandidateStructuredDataSchema } from "@/lib/domain/work-review";
import type { WorkTodo } from "@/lib/domain/work-todo";
import { AgentFailure } from "@/lib/server/agent/types";
import { WorkProjectRepository } from "./project-repository";
import { WorkReviewRepository } from "./repository";
import { WorkTodoRepository } from "./todo-repository";

export function workAgentHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function workAgentId(value: unknown) { return `wra_${workAgentHash(value).slice(0,40)}`; }
export function requireWorkAgentProject(db: Database.Database, accountId: string, projectId: string) {
  try { return new WorkProjectRepository(db).getProject(accountId, projectId); }
  catch { throw new AgentFailure("forbidden", "项目不存在或无权访问。"); }
}
export function workAgentTodoInScope(db: Database.Database, accountId: string, projectId: string, todo: WorkTodo, meetingIds: Set<string>) {
  if (!todo.sourceMeetingId) return true; // Manual or deliberately detached Todo remains its own authority.
  if (!meetingIds.has(todo.sourceMeetingId) || !todo.sourceFindingId) return false;
  try { readWorkAgentSource(db,accountId,projectId,todo.sourceFindingId); return true; } catch { return false; }
}
/** Only user-confirmed Findings and their direct canonical evidence. Never candidates or old summaries. */
export function readWorkAgentSource(db: Database.Database, accountId: string, projectId: string, findingId: string): WorkAgentSource {
  requireWorkAgentProject(db, accountId, projectId);
  const row = db.prepare(`SELECT f.meeting_id FROM wr_findings f
    JOIN wr_meetings m ON m.id=f.meeting_id AND m.account_id=f.account_id
    JOIN wr_meeting_projects p ON p.meeting_id=m.id AND p.account_id=m.account_id
    WHERE f.account_id=? AND p.project_id=? AND f.id=? AND f.user_confirmed_at IS NOT NULL
      AND m.deleted_at IS NULL AND m.ingestion_status<>'deleted'`).get(accountId, projectId, findingId) as { meeting_id: string } | undefined;
  if (!row) throw new AgentFailure("source_changed", "会议依据已失效或不属于这个项目。");
  const meetings = new WorkReviewRepository(db), meeting = meetings.getMeeting(accountId, row.meeting_id);
  const finding = meetings.listFindings(accountId, meeting.id).find(f => f.id === findingId);
  const publication = meetings.readCanonicalPublication(accountId, meeting.id);
  if (!finding || !publication || !finding.evidenceRefs.length) throw new AgentFailure("source_changed", "缺少有效的会议原文依据。");
  const evidence = finding.evidenceRefs.map(ref => {
    const segment = publication.segments.find(s => s.id === ref.segmentId);
    if (!segment || ref.publicationId !== publication.publicationId) throw new AgentFailure("source_changed", "会议原文已变化。");
    return { publicationId: ref.publicationId, segmentId: ref.segmentId, text: segment.text,
      startSeconds: ref.startSeconds, endSeconds: ref.endSeconds, timestampQuality: ref.timestampQuality };
  });
  const data = WorkMeetingCandidateStructuredDataSchema.parse(finding.structuredData);
  return { findingId, meetingId: meeting.id, meetingTitle: meeting.title, meetingDate: meeting.meetingDate,
    version: finding.version, kind: finding.kind, title: finding.title, body: finding.body,
    finality: data.decisionFinality, actionBasis: data.actionBasis, evidence,
    fingerprint: workAgentHash([meeting.id, meeting.version, meeting.meetingDate, publication.contentDigest, finding, evidence]),
  };
}
export type WorkThreadEventRow = {
  id: string; thread_id: string; relation: string; finding_id: string | null; todo_id: string | null;
  retracts_id: string | null; label: string | null; invalidated: number; confirmed_at: string; meeting_date: string;
};
export function readWorkThreads(db: Database.Database, accountId: string, projectId: string): WorkThreadView[] {
  requireWorkAgentProject(db, accountId, projectId);
  const todoRepository=new WorkTodoRepository(db);
  const meetingIds=new Set(new WorkProjectRepository(db).listMeetingIdsByScope(accountId,{kind:"project",projectId}));
  const threads = db.prepare("SELECT id,anchor_finding_id FROM wr_work_threads WHERE account_id=? AND project_id=? ORDER BY created_at,id")
    .all(accountId, projectId) as { id: string; anchor_finding_id: string }[];
  return threads.map(thread => {
    const rows = db.prepare("SELECT * FROM wr_work_thread_events WHERE account_id=? AND project_id=? AND thread_id=? ORDER BY meeting_date,rowid")
      .all(accountId, projectId, thread.id) as WorkThreadEventRow[];
    const retracted = new Set(rows.filter(r => r.relation === "retracts").map(r => r.retracts_id));
    let state: WorkThreadView["state"] = "open", currentFindingId: string | null = null, title = "来源已失效的议题";
    let kind: WorkThreadView["kind"] = "other";
    const linkedTodos = new Map<string,WorkThreadView["linkedTodos"][number]>();
    const events = rows.map(row => {
      if(row.relation === "retracts") return {id:row.id,relation:row.relation,label:"用户撤回错误关联；不自动恢复旧决定。",
        valid:true,retracted:false,findingId:null,todoId:null,retractsId:row.retracts_id,meetingDate:row.meeting_date,sources:[],confirmedAt:row.confirmed_at};
      let valid = !row.invalidated;
      const sources: WorkAgentSource[] = [];
      const bindings = db.prepare("SELECT finding_id,fingerprint FROM wr_work_thread_event_sources WHERE event_id=? AND account_id=? AND project_id=?")
        .all(row.id, accountId, projectId) as { finding_id: string; fingerprint: string }[];
      if (!bindings.length) valid = false;
      if (valid) for (const binding of bindings) {
        try {
          const source = readWorkAgentSource(db, accountId, projectId, binding.finding_id);
          if (source.fingerprint !== binding.fingerprint) { valid = false; break; }
          sources.push(source);
        } catch { valid = false; break; }
      }
      if (valid && row.todo_id) {
        const linked = db.prepare(`SELECT 1 FROM wr_todos t JOIN wr_todo_projects p ON p.todo_id=t.id AND p.account_id=t.account_id
          WHERE t.id=? AND t.account_id=? AND p.project_id=? AND t.deleted_at IS NULL`).get(row.todo_id, accountId, projectId);
        if (!linked) valid = false;
      }
      if (!valid && !row.invalidated) db.prepare("UPDATE wr_work_thread_events SET invalidated=1,label=NULL WHERE id=?").run(row.id);
      const isRetracted = retracted.has(row.id);
      // An invalidated or explicitly retracted transition is an uncertainty barrier, not a rollback.
      if ((!valid || isRetracted) && row.relation !== "tracks") { state = "unknown"; currentFindingId = null; }
      else if (valid && !isRetracted) {
        if (title === "来源已失效的议题") title = (sources.find(s=>s.findingId===thread.anchor_finding_id) ?? sources[0])?.title ?? title;
        const anchor=sources.find(s=>s.findingId===thread.anchor_finding_id);
        if(anchor)kind=anchor.kind==="open_question"?"question":anchor.kind==="decision"?"decision":["action_item","commitment"].includes(anchor.kind)?"work":"other";
        if(row.relation==="tracks" && row.todo_id){
          const todo=todoRepository.getTodo(accountId,row.todo_id);
          if(workAgentTodoInScope(db,accountId,projectId,todo,meetingIds))linkedTodos.set(todo.id,{id:todo.id,title:todo.title,status:todo.status});
        }
        const fact = sources.find(s => s.findingId === row.finding_id);
        if (row.relation === "supersedes" || (row.relation === "records" && fact?.kind === "decision" && fact.finality === "final" && state === "open")) {
          state = "active"; currentFindingId = row.finding_id;
        } else if (row.relation === "suspends") { state = "suspended"; currentFindingId = null; }
        else if (row.relation === "withdraws") { state = "withdrawn"; currentFindingId = null; }
        else if (row.relation === "resolves") state = "resolved";
        else if (row.relation === "reopens") state = "open";
      }
      return { id: row.id, relation: row.relation, label: valid ? row.label ?? "已确认关系" : "来源已变化或不再属于项目；当前状态待核实。",
        valid, retracted: isRetracted, findingId: valid ? row.finding_id : null, todoId:valid?row.todo_id:null,
        retractsId:null,meetingDate:row.meeting_date,sources: valid ? sources : [], confirmedAt: row.confirmed_at };
    });
    return { id: thread.id, anchorFindingId: thread.anchor_finding_id, title, state, currentFindingId, kind, linkedTodos:[...linkedTodos.values()], events };
  });
}

/** Bounded, explicitly reported selection. Digests use identities for the entire eligible scope. */
export function readWorkAgentContext(db: Database.Database, accountId: string, projectId: string, meetingId: string): WorkAgentContext;
export function readWorkAgentContext(db: Database.Database, accountId: string, projectId: string): Omit<WorkAgentContext,"meetingId"> & {meetingId:null};
export function readWorkAgentContext(db: Database.Database, accountId: string, projectId: string, meetingId?: string): Omit<WorkAgentContext,"meetingId"> & {meetingId:string|null} {
  const project = requireWorkAgentProject(db, accountId, projectId);
  const meetings = new WorkReviewRepository(db), todosRepo = new WorkTodoRepository(db);
  const all = meetings.listMeetings(accountId, { kind: "project", projectId });
  const anchor = all.find(m => m.id === meetingId);
  if (meetingId && (!anchor || anchor.reviewStatus !== "completed")) throw new AgentFailure("source_changed", "请先完成会议核对，并明确关联本次项目。");
  const eligible = all.filter(m => !anchor || m.meetingDate <= anchor.meetingDate)
    .sort((a,b) => a.id === meetingId ? -1 : b.id === meetingId ? 1 : b.meetingDate.localeCompare(a.meetingDate) || a.id.localeCompare(b.id));
  const identities = db.prepare(`SELECT f.id,f.version,f.meeting_id FROM wr_findings f JOIN wr_meetings m ON m.id=f.meeting_id AND m.account_id=f.account_id
    JOIN wr_meeting_projects p ON p.meeting_id=m.id AND p.account_id=m.account_id
    WHERE f.account_id=? AND p.project_id=? AND m.deleted_at IS NULL AND m.meeting_date<=? AND f.user_confirmed_at IS NOT NULL ORDER BY f.id`)
    .all(accountId, projectId, anchor?.meetingDate ?? "9999-12-31");
  const todoIds = new WorkProjectRepository(db).listTodoIdsByScope(accountId, { kind: "project", projectId });
  const meetingIds = new Set(all.map(m=>m.id));
  const allTodos = todoIds.map(id => todosRepo.getTodo(accountId,id))
    .filter(t => workAgentTodoInScope(db,accountId,projectId,t,meetingIds));
  const sources: WorkAgentSource[] = [], readMeetings = new Set<string>();
  let chars = 0;
  for (const meeting of eligible.slice(0,8)) {
    readMeetings.add(meeting.id);
    for (const finding of meetings.listFindings(accountId, meeting.id)) {
      let source: WorkAgentSource;
      try { source = readWorkAgentSource(db, accountId, projectId, finding.id); } catch { continue; }
      const size = JSON.stringify(source).length;
      if (sources.length >= 60 || chars + size > 18_000) continue;
      sources.push(source); chars += size;
    }
  }
  // Notes are user-authored prose, not needed for P1 status/owner/deadline comparison.
  let todoChars=0,threadChars=0;
  const todos = allTodos.slice(0,40).map(({id,title,status,kind,version,ownerLabel,currentDueDate,sourceFindingId,sourceMeetingId,origin})=>
    ({id,title,status,kind,version,ownerLabel,currentDueDate,sourceFindingId,sourceMeetingId,origin}))
    .filter(todo=>{const size=JSON.stringify(todo).length;if(todoChars+size>12_000)return false;todoChars+=size;return true;});
  const allThreads = readWorkThreads(db,accountId,projectId);
  const threads = allThreads.slice(-20).map(t=>({...t,events:t.events.slice(-6).map(e=>({...e,sources:[]}))}))
    .filter(thread=>{const size=JSON.stringify(thread).length;if(threadChars+size>4000)return false;threadChars+=size;return true;});
  const limited = readMeetings.size < eligible.length || sources.length < identities.length || todos.length < allTodos.length || threads.length<allThreads.length || allThreads.some(t=>t.events.length>6);
  const fingerprint = workAgentHash({ project: [project.id,project.version], meetingId,
    meetings: eligible.map(m => [m.id,m.version,m.canonicalContentDigest]), identities,
    sources: sources.map(s => [s.findingId,s.fingerprint]), todos: allTodos,
    events: db.prepare("SELECT id,invalidated FROM wr_work_thread_events WHERE account_id=? AND project_id=? ORDER BY id").all(accountId,projectId) });
  return { project: { id: project.id, name: project.name }, meetingId:meetingId??null, fingerprint, sources, todos, threads,
    coverage: { meetingsRead: readMeetings.size, meetingsAvailable: eligible.length, findingsRead: sources.length, findingsAvailable: identities.length,
      todosRead: todos.length, todosAvailable: allTodos.length, limited,
      notice: `读取 ${readMeetings.size}/${eligible.length} 场会议的 ${sources.length}/${identities.length} 条已确认结果、${todos.length}/${allTodos.length} 条项目待办的状态字段（不含备注）、${threads.length}/${allThreads.length} 个议题的最近最多6条关系。仅使用已确认结果的直接原文；未读取待核对、已忽略候选或会议全部讨论。${limited ? "达到容量或来源限制，其余内容未检查。" : ""}同日会议不推定先后；没有后续记录不证明实际未完成。` } };
}
