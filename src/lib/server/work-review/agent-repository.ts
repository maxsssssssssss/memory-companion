import type Database from "better-sqlite3";
import type { AgentTask } from "@/lib/domain/agent";
import { WorkAgentComparison, type WorkAgentArtifact, WorkAgentChange, type WorkAgentContext,
  type WorkAgentPreview, type WorkAgentScope } from "@/lib/domain/work-agent";
import { AgentFailure } from "@/lib/server/agent/types";
import { WorkTodoRepository } from "./todo-repository";
import { readWorkAgentContext, readWorkAgentSource, readWorkThreads, requireWorkAgentProject, workAgentHash, workAgentId } from "./agent-context";
import { reviewWorkAgentChange } from "./agent-consistency";

type ArtifactRow = {
  id: string; account_id: string; project_id: string; meeting_id: string; task_id: string; task_version: number;
  source_fingerprint: string; state: WorkAgentArtifact["state"]; comparison_json: string | null;
  coverage_json: string | null; preview_json: string | null; applied_json: string | null; apply_action_id: string | null; created_at: string;
};
const decode = <T>(value: string | null): T | null => value === null ? null : JSON.parse(value) as T;
function changed(): never { throw new AgentFailure("source_changed", "会议、项目或待办已变化，请重新比较并确认新的预览。"); }
function invalid(message: string): never { throw new AgentFailure("invalid_action", message); }

export class WorkAgentRepository {
  constructor(readonly database: Database.Database) {}
  scope(task: AgentTask): WorkAgentScope {
    const scope = task.scope as WorkAgentScope;
    if (!scope || scope.projectId !== task.resourceId || !scope.meetingId || !scope.fingerprint) invalid("办公任务范围不完整。");
    return scope;
  }
  context(task: AgentTask, frozen = true) {
    const scope = this.scope(task), context = readWorkAgentContext(this.database, task.accountId, scope.projectId, scope.meetingId);
    if (frozen && context.fingerprint !== scope.fingerprint) changed();
    return context;
  }
  private row(task: AgentTask): ArtifactRow | undefined {
    return this.database.prepare("SELECT * FROM wr_work_agent_artifacts WHERE account_id=? AND project_id=? AND task_id=? AND task_version=?")
      .get(task.accountId, task.resourceId, task.id, task.version ?? 1) as ArtifactRow | undefined;
  }
  private invalidate(id: string) {
    this.database.prepare("UPDATE wr_work_agent_artifacts SET state='invalidated',comparison_json=NULL,preview_json=NULL,coverage_json=NULL WHERE id=?").run(id);
  }
  read(task: AgentTask): WorkAgentArtifact | null {
    requireWorkAgentProject(this.database, task.accountId, task.resourceId);
    let row = this.row(task);
    if (!row) return null;
    let sources: WorkAgentArtifact["sources"] = [];
    let context: WorkAgentContext | undefined;
    if (row.state !== "invalidated") {
      try {
        const bindings = this.database.prepare("SELECT finding_id,fingerprint FROM wr_work_agent_artifact_sources WHERE artifact_id=? AND account_id=? AND project_id=?")
          .all(row.id,task.accountId,task.resourceId) as {finding_id:string;fingerprint:string}[];
        sources = bindings.map(binding => {
          const source = readWorkAgentSource(this.database,task.accountId,task.resourceId,binding.finding_id);
          if (source.fingerprint !== binding.fingerprint) changed();
          return source;
        });
        if (row.state !== "applied") context = this.context(task);
      } catch {
        this.invalidate(row.id); row = this.row(task)!; sources = [];
      }
    }
    const preview=decode<WorkAgentPreview>(row.preview_json);
    // Recheck pending legacy previews as well; do not rewrite their fingerprint,
    // original payload, selected keys or any already-applied historical result.
    if(preview && context)for(const item of preview.changes)item.review=reviewWorkAgentChange(context,item.change);
    return { id:row.id,taskId:row.task_id,taskVersion:row.task_version,meetingId:row.meeting_id,state:row.state,
      comparison:decode(row.comparison_json),coverage:decode(row.coverage_json),preview,
      applied:decode(row.applied_json),sources,createdAt:row.created_at };
  }
  private assertConfirmable(preview:WorkAgentPreview,keys:string[]) {
    for(const key of keys){
      const item=preview.changes.find(c=>c.change.key===key);
      if(!item || item.review?.status!=="confirmable")invalid(item?.review?.reason ?? "操作尚未核对依据，不能批准。");
    }
  }
  private validateComparison(accountId: string, context: WorkAgentContext, comparison: WorkAgentComparison) {
    const sources = new Map(context.sources.map(s=>[s.findingId,s]));
    const todos = new Map(context.todos.map(t=>[t.id,t]));
    const known = (ids: string[]) => {
      if (new Set(ids).size !== ids.length || ids.some(id=>!sources.has(id))) invalid("只能引用本次实际读取的项目内已确认结果。");
    };
    for (const item of comparison.items) {
      known(item.sourceFindingIds);
      if (["changed","resolved"].includes(item.category) && item.status === "confirmed_fact") item.status = "suggestion";
    }
    const keys = new Set<string>(), targetTodos = new Set<string>(), relations = new Set<string>();
    for (const change of comparison.changes) {
      known(change.sourceFindingIds);
      if (keys.has(change.key)) invalid("修改项标识重复。");
      keys.add(change.key);
      if (change.kind === "relation") {
        const signature = workAgentHash([change.relation,change.anchorFindingId,change.findingId,change.todoId]);
        if (relations.has(signature)) invalid("同一批包含重复关系。");
        relations.add(signature);
        const anchor = sources.get(change.anchorFindingId), finding = sources.get(change.findingId);
        if (!anchor || !finding) invalid("关系缺少两端的有效原文依据。");
        // Endpoints are explicit operation fields, not inferred citations. Complete
        // their references only from the freshly validated, scoped input context,
        // before saving the comparison or fixing any preview/approval fingerprint.
        // Retain all supplied references and the existing schema capacity limit.
        const normalized = WorkAgentChange.safeParse({...change,
          sourceFindingIds:[...new Set([...change.sourceFindingIds,anchor.findingId,finding.findingId])].sort(),
        });
        if (!normalized.success) invalid("补齐关系端点后的原文引用超出允许范围。");
        change.sourceFindingIds = normalized.data.sourceFindingIds;
        known(change.sourceFindingIds);
        if (finding.meetingDate < anchor.meetingDate) invalid("后续关系不能早于原议题；请核对会议日期。");
        if (change.relation === "supersedes" && (anchor.kind !== "decision" || finding.kind !== "decision" || finding.finality !== "final")) invalid("新提议或暂定方案不能替代正式决定。");
        if (["suspends","withdraws"].includes(change.relation) && (anchor.kind !== "decision" || !["decision","plan_change"].includes(finding.kind) || finding.kind === "decision" && finding.finality !== "final")) invalid("暂停或撤回必须有明确决定或计划变化依据。");
        if (["resolves","reopens"].includes(change.relation) && (anchor.kind !== "open_question" || ["proposal","discussion_topic"].includes(finding.kind))) invalid("问题状态变化需要已确认的后续依据，不能只凭讨论或未提及。");
        if (change.relation === "tracks" && (!change.todoId || !todos.has(change.todoId))) invalid("只能关联本项目内的有效待办。");
        if (change.relation !== "tracks" && change.todoId) invalid("此关系不需要待办标识。");
      } else if (change.kind === "create_todo") {
        const finding = sources.get(change.findingId);
        if (!finding || !change.sourceFindingIds.includes(change.findingId) || !["action_item","commitment"].includes(finding.kind)) invalid("新待办必须来自已确认的行动事项或承诺。");
        if (["suggested_action","assignment_without_acceptance","unowned_follow_up"].includes(finding.actionBasis ?? "")) invalid("讨论、未接受的分配或无主事项不能自动提升为承诺；请先在会议中确认。");
        if (change.todoKind === "waiting_for_other" && !change.ownerLabel) invalid("等待他人的事项需要明确负责人。");
        if (this.database.prepare("SELECT 1 FROM wr_todos WHERE account_id=? AND source_finding_id=? AND deleted_at IS NULL")
          .get(accountId,finding.findingId)) invalid("该结果已有待办，请使用已有待办。");
      } else {
        if (!todos.has(change.todoId) || targetTodos.has(change.todoId)) invalid("待办不在本项目范围，或同一批包含重复修改。");
        if (!change.sourceFindingIds.some(id=>sources.get(id)?.meetingId === context.meetingId)) invalid("调整待办需要本次会议的明确依据。");
        const todo = todos.get(change.todoId)!;
        if (change.kind === "update_todo" && todo.kind === "waiting_for_other" && !change.ownerLabel) invalid("等待事项不能清空负责人。");
        targetTodos.add(change.todoId);
      }
    }
  }
  saveComparison(task: AgentTask, raw: unknown) {
    return this.database.transaction(() => {
      const current=this.database.prepare("SELECT status,version FROM agent_tasks WHERE id=? AND account_id=?").get(task.id,task.accountId) as {status:string;version:number}|undefined;
      if(!current || current.version!==(task.version??1) || !["ready","running"].includes(current.status))throw new AgentFailure("inactive","本轮已经停止，不能发布晚到比较。");
      const existing = this.row(task);
      if (existing) {
        if (existing.state === "invalidated") changed();
        return this.read(task)!;
      }
      const context = this.context(task), comparison = WorkAgentComparison.parse(raw);
      this.validateComparison(task.accountId,context,comparison);
      const id = workAgentId([task.id,task.version ?? 1,"comparison"]);
      this.database.prepare(`INSERT INTO wr_work_agent_artifacts
        (id,account_id,project_id,meeting_id,task_id,task_version,source_fingerprint,state,comparison_json,coverage_json,created_at)
        VALUES (?,?,?,?,?,?,?,'compared',?,?,?)`).run(id,task.accountId,task.resourceId,context.meetingId,task.id,task.version ?? 1,
          context.fingerprint,JSON.stringify(comparison),JSON.stringify(context.coverage),new Date().toISOString());
      // All inputs are required provenance, including statements about absence of a follow-up.
      for (const source of context.sources) this.database.prepare(`INSERT INTO wr_work_agent_artifact_sources
        (artifact_id,account_id,project_id,meeting_id,finding_id,fingerprint) VALUES (?,?,?,?,?,?)`)
        .run(id,task.accountId,task.resourceId,source.meetingId,source.findingId,source.fingerprint);
      return this.read(task)!;
    }).immediate();
  }
  preview(task: AgentTask) {
    return this.database.transaction(() => {
      const artifact = this.read(task);
      if (!artifact?.comparison || artifact.state === "invalidated") changed();
      if (artifact.preview) return artifact.preview;
      const context = this.context(task);
      const threads = readWorkThreads(this.database,task.accountId,task.resourceId);
      const changes = artifact.comparison.changes.map(change => {
        const todo = "todoId" in change ? context.todos.find(t=>t.id === change.todoId) : undefined;
        const thread = change.kind === "relation" ? threads.find(t=>t.anchorFindingId===change.anchorFindingId || t.events.some(e=>e.findingId===change.anchorFindingId)) : undefined;
        const state = thread ? ({open:"未关闭",active:"当前有效",suspended:"已暂停",withdrawn:"已撤回",resolved:"已解决",unknown:"待核实"})[thread.state] : "尚未建立已确认关系";
        const before = todo ? JSON.stringify({ title:todo.title,status:todo.status,owner:todo.ownerLabel,due:todo.currentDueDate,version:todo.version })
          : change.kind === "relation" ? `项目当前状态：${state}。原会议结果：${context.sources.find(s=>s.findingId === change.anchorFindingId)!.body}` : "尚未创建";
        const after = change.kind === "update_todo" ? JSON.stringify({title:change.title,owner:change.ownerLabel,due:change.dueDate})
          : change.kind === "complete_todo" ? "已完成" : change.kind === "create_todo" ? JSON.stringify({title:change.title,kind:change.todoKind,owner:change.ownerLabel,due:change.dueDate}) : change.label;
        return { change,before,after,review:reviewWorkAgentChange(context,change) };
      });
      const preview: WorkAgentPreview = {id:artifact.id,fingerprint:workAgentHash([artifact.id,task.version,context.fingerprint,changes]),
        sourceFingerprint:context.fingerprint,changes,selectedKeys:null};
      this.database.prepare("UPDATE wr_work_agent_artifacts SET state='preview',preview_json=? WHERE id=? AND state='compared'").run(JSON.stringify(preview),artifact.id);
      return preview;
    }).immediate();
  }
  select(task: AgentTask, input: { previewId: string; fingerprint: string; keys: string[] }) {
    return this.database.transaction(() => {
      const artifact = this.read(task), preview = artifact?.preview;
      if (!preview || artifact.state === "invalidated" || preview.id !== input.previewId || preview.fingerprint !== input.fingerprint) changed();
      const keys = [...new Set(input.keys)].sort();
      if (keys.length !== input.keys.length || keys.some(k=>!preview.changes.some(c=>c.change.key===k))) invalid("选择中存在未知修改项。");
      if (preview.selectedKeys && JSON.stringify(preview.selectedKeys)!==JSON.stringify(keys)) throw new AgentFailure("conflict","本次选择已固定，请重新比较以改变选择。");
      if (artifact.state === "applied") return preview;
      this.assertConfirmable(preview,keys);
      preview.selectedKeys = keys;
      this.database.prepare("UPDATE wr_work_agent_artifacts SET preview_json=? WHERE id=? AND state='preview'").run(JSON.stringify(preview),artifact.id);
      return preview;
    }).immediate();
  }
  confirmation(task: AgentTask) {
    const artifact = this.read(task), preview = artifact?.preview;
    if (!preview || !preview.selectedKeys || artifact.state !== "preview") changed();
    this.context(task);
    this.assertConfirmable(preview,preview.selectedKeys);
    return {title:`保存选中的 ${preview.selectedKeys.length} 项后续工作`,summary:"其余建议不会写入；此预览已固定。",
      target:task.resourceId,content:JSON.stringify({previewId:preview.id,fingerprint:preview.fingerprint,
        selection:preview.changes.filter(c=>preview.selectedKeys!.includes(c.change.key)).map(({change,before,after})=>({key:change.key,label:change.label,before,after}))}),
      sourceFingerprint:workAgentHash([preview.fingerprint,preview.sourceFingerprint,preview.selectedKeys,task.accountId,task.version])};
  }
  /** Called only by the Runtime tool after its approval check; same DB serializes cancellation and writes. */
  apply(task: AgentTask, actionId: string) {
    return this.database.transaction(() => {
      const prior = this.row(task);
      if (prior?.applied_json && prior.apply_action_id === actionId) return this.read(task)!;
      const approval = this.database.prepare(`SELECT 1 FROM agent_approvals a JOIN agent_tasks t ON t.id=a.task_id
        WHERE a.id=? AND a.task_id=? AND a.status='approved' AND a.version=? AND t.account_id=?
          AND t.status='running' AND t.version=? AND t.lease IS NOT NULL AND t.lease_until>?`)
        .get(actionId,task.id,task.version ?? 1,task.accountId,task.version ?? 1,Date.now());
      if (!approval) throw new AgentFailure("forbidden","缺少本次固定预览的有效批准。");
      const project = requireWorkAgentProject(this.database,task.accountId,task.resourceId);
      if (project.status !== "active") changed();
      const context = this.context(task), artifact = this.read(task), preview = artifact?.preview;
      if (!artifact || !preview?.selectedKeys || artifact.state !== "preview") changed();
      this.assertConfirmable(preview,preview.selectedKeys);
      const now = new Date().toISOString(), eventIds:string[]=[], todoIds:string[]=[];
      const todoRepo = new WorkTodoRepository(this.database);
      for (const {change} of preview.changes.filter(c=>preview.selectedKeys!.includes(c.change.key))) {
        const operationKey = workAgentId([artifact.id,change.key,"apply"]);
        if (change.kind === "relation") {
          const direct = this.database.prepare("SELECT id AS thread_id FROM wr_work_threads WHERE account_id=? AND project_id=? AND anchor_finding_id=?")
            .get(task.accountId,task.resourceId,change.anchorFindingId) as {thread_id:string}|undefined;
          const memberships = this.database.prepare(`SELECT DISTINCT thread_id FROM wr_work_thread_events
            WHERE account_id=? AND project_id=? AND finding_id=? AND invalidated=0`)
            .all(task.accountId,task.resourceId,change.anchorFindingId) as {thread_id:string}[];
          if(!direct && memberships.length>1)throw new AgentFailure("conflict","议题关联不唯一，请使用原始议题重新比较。");
          const existing=direct??memberships[0];
          const threadId = existing?.thread_id ?? workAgentId([task.accountId,task.resourceId,change.anchorFindingId,"thread"]);
          this.database.prepare("INSERT OR IGNORE INTO wr_work_threads(id,account_id,project_id,anchor_finding_id,created_at) VALUES (?,?,?,?,?)")
            .run(threadId,task.accountId,task.resourceId,change.anchorFindingId,now);
          const bindings = change.sourceFindingIds.map(id=>context.sources.find(s=>s.findingId===id)!).sort((a,b)=>a.findingId.localeCompare(b.findingId));
          const semantic = workAgentHash([threadId,change.relation,change.anchorFindingId,change.findingId,change.todoId,bindings.map(s=>[s.findingId,s.fingerprint])]);
          const duplicate = this.database.prepare(`SELECT e.id FROM wr_work_thread_events e
            WHERE e.account_id=? AND e.project_id=? AND e.semantic_key=? AND e.invalidated=0
              AND NOT EXISTS (SELECT 1 FROM wr_work_thread_events r WHERE r.retracts_id=e.id)
            ORDER BY e.rowid DESC LIMIT 1`).get(task.accountId,task.resourceId,semantic) as {id:string}|undefined;
          if (duplicate) { eventIds.push(duplicate.id); continue; }
          // A fresh explicit confirmation can re-establish a retracted relation without changing its history.
          const eventId = workAgentId([operationKey,"relation"]);
          this.database.prepare(`INSERT INTO wr_work_thread_events
            (id,account_id,project_id,thread_id,relation,finding_id,target_finding_id,todo_id,label,operation_key,semantic_key,confirmed_by,confirmed_at,meeting_date)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(eventId,task.accountId,task.resourceId,threadId,change.relation,change.findingId,change.anchorFindingId,change.todoId,change.label,operationKey,semantic,task.accountId,now,context.sources.find(s=>s.findingId===change.findingId)!.meetingDate);
          for (const source of bindings) {
            this.database.prepare(`INSERT OR IGNORE INTO wr_work_thread_event_sources(event_id,account_id,project_id,meeting_id,finding_id,fingerprint)
              VALUES (?,?,?,?,?,?)`).run(eventId,task.accountId,task.resourceId,source.meetingId,source.findingId,source.fingerprint);
          }
          eventIds.push(eventId);
        } else if (change.kind === "create_todo") {
          const source = context.sources.find(s=>s.findingId===change.findingId)!;
          const {todo} = todoRepo.createTodoFromFinding({accountId:task.accountId,meetingId:source.meetingId,findingId:source.findingId,
            operationKey,title:change.title,kind:change.todoKind,ownerLabel:change.ownerLabel,currentDueDate:change.dueDate,
            notes:null,isImportant:false,myDayDate:null,projectIds:[task.resourceId],ownershipOverrideConfirmed:false});
          todoIds.push(todo.id);
        } else {
          const todo = context.todos.find(t=>t.id===change.todoId)!;
          const input = {accountId:task.accountId,todoId:todo.id,expectedVersion:todo.version,operationKey};
          if (change.kind === "complete_todo") todoRepo.completeTodo(input);
          else todoRepo.updateTodo({...input,title:change.title,ownerLabel:change.ownerLabel,currentDueDate:change.dueDate});
          todoIds.push(todo.id);
        }
      }
      const applied: NonNullable<WorkAgentArtifact["applied"]> = {selectedKeys:preview.selectedKeys,
        rejectedKeys:preview.changes.map(c=>c.change.key).filter(k=>!preview.selectedKeys!.includes(k)),eventIds,todoIds,confirmedAt:now};
      this.database.prepare("UPDATE wr_work_agent_artifacts SET state='applied',applied_json=?,apply_action_id=? WHERE id=?")
        .run(JSON.stringify(applied),actionId,artifact.id);
      return this.read(task)!;
    }).immediate();
  }
  recover(task: AgentTask, actionId: string) {
    const row = this.row(task);
    return row?.apply_action_id === actionId && row.applied_json ? this.read(task) : null;
  }
  assertApplied(task: AgentTask, actionId: string) {
    const artifact = this.recover(task,actionId);
    if (!artifact?.applied) throw new AgentFailure("unknown","尚未找到已提交的业务回执。");
    if (artifact.state === "invalidated") changed();
    for (const id of artifact.applied.eventIds) {
      const row = this.database.prepare(`SELECT 1 FROM wr_work_thread_events e WHERE id=? AND account_id=? AND project_id=? AND invalidated=0
        AND NOT EXISTS (SELECT 1 FROM wr_work_thread_events r WHERE r.retracts_id=e.id)`)
        .get(id,task.accountId,task.resourceId);
      if (!row) changed();
    }
    const todos = new WorkTodoRepository(this.database);
    for (const item of artifact.preview!.changes.filter(c=>artifact.applied!.selectedKeys.includes(c.change.key))) {
      const change = item.change;
      if (change.kind === "relation") continue;
      const receipt = this.database.prepare("SELECT response_json FROM wr_todo_operations WHERE account_id=? AND operation_key=?")
        .get(task.accountId,workAgentId([artifact.id,change.key,"apply"])) as {response_json:string} | undefined;
      if (!receipt) throw new AgentFailure("unknown","待办操作回执未找到。");
      // The operation receipt proves the historical write; current deletions or later changes are reported, never replayed.
      if (change.kind === "create_todo") {
        const result=JSON.parse(receipt.response_json) as {todo:{id:string}};
        const current=todos.getTodo(task.accountId,result.todo.id);
        if(current.sourceFindingId!==change.findingId || current.title!==change.title)changed();
      } else {
        const current = todos.getTodo(task.accountId,change.todoId);
        if (change.kind === "complete_todo" && current.status !== "completed") changed();
        if (change.kind === "update_todo" && (current.title!==change.title || current.ownerLabel!==change.ownerLabel || current.currentDueDate!==change.dueDate)) changed();
      }
    }
    return artifact;
  }
  retract(accountId: string, projectId: string, eventId: string, operationKey: string) {
    return this.database.transaction(() => {
      const project = requireWorkAgentProject(this.database,accountId,projectId);
      if (project.status !== "active") changed();
      const event = this.database.prepare("SELECT thread_id FROM wr_work_thread_events WHERE account_id=? AND project_id=? AND id=? AND relation<>'retracts'")
        .get(accountId,projectId,eventId) as {thread_id:string} | undefined;
      if (!event) throw new AgentFailure("forbidden","关联不存在。");
      const semantic=workAgentHash(["retract",eventId]);
      this.database.prepare(`INSERT OR IGNORE INTO wr_work_thread_events
        (id,account_id,project_id,thread_id,relation,retracts_id,label,operation_key,semantic_key,confirmed_by,confirmed_at,meeting_date)
        VALUES (?,?,?,?,'retracts',?,'用户撤回错误关联',?,?,?,?,?)`)
        .run(workAgentId([projectId,semantic]),accountId,projectId,event.thread_id,eventId,operationKey,semantic,accountId,new Date().toISOString(),new Date().toISOString().slice(0,10));
    }).immediate();
  }
}
