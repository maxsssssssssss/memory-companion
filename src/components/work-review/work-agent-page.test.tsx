import {act,fireEvent,render,screen,waitFor,within,cleanup} from "@testing-library/react";
import {afterEach,describe,expect,it,vi} from "vitest";
import {WorkAgentPage} from "./work-agent-page";
import type {WorkAgentProjectView,WorkAgentTaskView} from "@/lib/domain/work-agent";
// P3 has its own actual-editor suite. Keep these P1/P2 fixtures scoped to their API.
vi.mock("./work-preparation-panel",()=>({WorkPreparationPanel:()=>null}));

afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function view():WorkAgentProjectView {
  const task:WorkAgentTaskView={task:{id:"task-example-1234",version:1,goal:"整理本次会议后续工作",status:"waiting",wait:{kind:"work_selection",refId:"preview_1",message:"选择修改"},
    budget:{maxCalls:16,maxInputChars:48000,maxOutputTokens:8000,maxComputeMs:600000,maxSteps:16,maxNoProgress:3},usage:{calls:2,inputTokens:null,outputTokens:null,unknownUsageCalls:2,computeMs:10,steps:2}},
    artifact:{id:"preview_1",taskId:"task-example-1234",taskVersion:1,meetingId:"meeting_3",state:"preview",createdAt:"2026-10-28T00:00:00Z",sources:[],applied:null,
      coverage:{meetingsRead:3,meetingsAvailable:3,findingsRead:10,findingsAvailable:10,todosRead:3,todosAvailable:3,limited:false,notice:"已读取3/3场会议；缺少记录不证明未完成。"},
      comparison:{items:[{category:"changed",text:"B正式替代A",status:"suggestion",sourceFindingIds:["finding_b"]},{category:"uncertain",text:"日志期限仍待核实",status:"uncertain",sourceFindingIds:["finding_logs"]}],changes:[]},
      preview:{id:"preview_1",fingerprint:"a".repeat(64),sourceFingerprint:"b".repeat(64),selectedKeys:null,changes:[
        {change:{key:"deploy",kind:"update_todo",todoId:"todo_1",title:"B方案部署",ownerLabel:"林晨",dueDate:"2026-10-30",label:"调整原部署待办",sourceFindingIds:["finding_b"]},before:JSON.stringify({title:"A方案部署",status:"open",owner:"林晨",due:"2026-10-28"}),after:JSON.stringify({title:"B方案部署",owner:"林晨",due:"2026-10-30"})},
        {change:{key:"vendor",kind:"complete_todo",todoId:"todo_2",label:"完成供应商等待",sourceFindingIds:["finding_logs"]},before:"等待供应商",after:"已完成"},
      ]}}};
  for(const item of task.artifact!.preview!.changes)item.review=item.change.key==="vendor"
    ?{status:"blocked",reason:"会议明确说尚未回复，完成操作与依据矛盾。",sourceFindingIds:["finding_logs"]}
    :{status:"confirmable",reason:"未发现明确矛盾，仍需用户核对。",sourceFindingIds:[]};
  return {project:{id:"project_1",name:"合成工单项目"},tasks:[task],threads:[],timeline:[],openLoops:[{id:"todo_2",kind:"todo",todoId:"todo_2",title:"供应商等待",status:"waiting",basis:"record",text:"供应商等待仍需核实",reasons:["等待记录尚未完成。"],sources:[],linkedTodos:[]}]};
}
describe("Work Agent actual confirmation page",()=>{
  it("expands dated facts and radar evidence, filters waiting work, and marks invalid history",async()=>{
    const data=view();data.tasks=[];
    const source={findingId:"finding_b",meetingId:"meeting_3",meetingTitle:"合成M3",meetingDate:"2026-10-27"};
    data.timeline=[{id:"b",date:source.meetingDate,title:"B替代A",text:"因为配额不足，正式采用B。",status:"confirmed_relation",label:"替代决定",sources:[source],canRetract:true,eventId:"event_b"},
      {id:"lost",date:"2026-10-28",title:"历史关系依据已失效",text:"不再使用旧依据。",status:"source_invalid",label:"解决问题",sources:[],canRetract:false}];
    data.openLoops.push({id:"logs",title:"日志期限",kind:"question",status:"unresolved",basis:"record",text:"日志期限仍未解决",sources:[source],reasons:["尚无解决关系。"],linkedTodos:[]});
    const fetcher=vi.fn(async(url:string)=>url.includes("findingId=")?Response.json({source:{...source,body:"正式采用B",evidence:[{segmentId:"s",text:"原文：配额不足，正式采用B。",startSeconds:0,endSeconds:20,timestampQuality:"synthetic"}]}}):Response.json(data));
    vi.stubGlobal("fetch",fetcher);render(<WorkAgentPage projectId="project_1"/>);
    const timeline=await screen.findByRole("region",{name:"决策时间线"});
    fireEvent.click(within(timeline).getByText("查看历史与来源（2 条）"));
    fireEvent.click(within(timeline).getByText("2026-10-27",{selector:"time"}).closest("summary")!);
    fireEvent.click(within(timeline).getByRole("button",{name:/查看原文 · 合成M3/}));
    expect(await screen.findByRole("dialog")).toHaveTextContent("原文：配额不足");
    fireEvent.keyDown(document,{key:"Escape"});
    const radar=screen.getByRole("region",{name:"未闭环事项雷达"});
    expect(within(radar).getByText("日志期限")).toBeInTheDocument();
    fireEvent.click(within(radar).getByRole("button",{name:"等待他人"}));
    expect(within(radar).queryByText("日志期限")).not.toBeInTheDocument();
    expect(within(radar).getByText("供应商等待")).toBeInTheDocument();
    fireEvent.click(within(timeline).getByText("2026-10-28",{selector:"time"}).closest("summary")!);
    expect(within(timeline).getAllByRole("button",{name:"撤回错误关联"})).toHaveLength(1);
    expect(fetcher.mock.calls.at(-1)?.[0]).toContain("findingId=finding_b");
  });
  it("shows empty/loading/error states and drops the previous project's data during navigation",async()=>{
    const data=view();data.tasks=[];data.openLoops=[];
    let release!:(value:Response)=>void;
    vi.stubGlobal("fetch",vi.fn(async(url:string)=>url.includes("project_2")?new Promise<Response>(resolve=>{release=resolve;}):Response.json(data)));
    const page=render(<WorkAgentPage projectId="project_1"/>);
    expect(screen.getByText("正在读取项目成果…")).toBeInTheDocument();
    await screen.findByText("还没有可展示的历史");expect(screen.getByText("暂未发现需要关注的记录")).toBeInTheDocument();
    page.rerender(<WorkAgentPage projectId="project_2"/>);
    expect(screen.queryByText("合成工单项目")).not.toBeInTheDocument();
    release(Response.json({error:"forbidden"},{status:404}));
    await screen.findByText("需要核对");expect(screen.queryByText("正在读取项目成果…")).not.toBeInTheDocument();
    expect(screen.queryByRole("region",{name:"决策时间线"})).not.toBeInTheDocument();
  });
  it("does not show a late source response after changing projects",async()=>{
    let release!:(value:Response)=>void;
    const next=view();next.project={id:"project_2",name:"另一个项目"};next.tasks=[];
    vi.stubGlobal("fetch",vi.fn(async(url:string)=>url.includes("findingId=")?new Promise<Response>(resolve=>{release=resolve;}):Response.json(url.includes("project_2")?next:view())));
    const page=render(<WorkAgentPage projectId="project_1"/>);
    await screen.findByText("合成工单项目");fireEvent.click(screen.getAllByRole("button",{name:"查看原文 1"})[0]);
    page.rerender(<WorkAgentPage projectId="project_2"/>);await screen.findByText("另一个项目");
    await act(async()=>release(Response.json({source:{meetingTitle:"旧项目原文",meetingDate:"2026-10-27",body:"旧项目内容",evidence:[]}})));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();expect(screen.queryByText("旧项目内容")).not.toBeInTheDocument();
  });
  it("shows old/new state, submits only selected items and requires a final confirmation",async()=>{
    let data=view();const writes:Record<string,unknown>[]=[];
    vi.stubGlobal("fetch",vi.fn(async(_url:string,init?:RequestInit)=>{
      if(init?.method==="PATCH"){
        const body=JSON.parse(init.body as string);writes.push(body);
        if(body.action==="select"){
          data=structuredClone(data);data.tasks[0].artifact!.preview!.selectedKeys=body.selection.keys;
          data.tasks[0].task.wait={kind:"confirmation",message:"确认",refId:"approval_1"};
          data.tasks[0].task.approval={id:"approval_1",actionId:"approval_1",taskVersion:1,tool:"work.apply_confirmed_changes",fingerprint:"c".repeat(64),status:"pending",createdAt:"2026-10-28T00:00:00Z",title:"保存选中修改",summary:"固定预览",target:"project_1",content:"",sourceFingerprint:"b".repeat(64)};
        }else if(body.action==="approval"){
          data=structuredClone(data);data.tasks[0].task.status="ended";data.tasks[0].task.approval=undefined;
          data.tasks[0].artifact!.state="applied";data.tasks[0].artifact!.applied={selectedKeys:["deploy"],rejectedKeys:["vendor"],eventIds:[],todoIds:["todo_1"],confirmedAt:"2026-10-28T00:00:00Z"};
        }
        return Response.json({task:data.tasks[0]});
      }
      return Response.json(data);
    }));
    const rendered=render(<WorkAgentPage projectId="project_1"/>);
    await screen.findByText("B正式替代A",{exact:false});
    expect(screen.getByText(/内容：A方案部署/)).toBeInTheDocument();
    expect(screen.getByText(/内容：B方案部署/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox",{name:"完成供应商等待"})).toBeDisabled();
    expect(screen.getByText(/完成操作与依据矛盾/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"选中全部"}));
    expect(screen.getByRole("checkbox",{name:"完成供应商等待"})).not.toBeChecked();
    fireEvent.click(screen.getByRole("button",{name:"核对选中的 1 项修改"}));
    await screen.findByRole("button",{name:"确认保存选中的修改"});
    expect(writes).toHaveLength(1);expect(writes[0]).toMatchObject({selection:{keys:["deploy"]}});
    fireEvent.click(screen.getByRole("button",{name:"确认保存选中的修改"}));
    const dialog=screen.getByRole("dialog",{name:"保存固定预览"});
    fireEvent.click(within(dialog).getByRole("button",{name:"确认保存 1 项"}));
    await screen.findByText("已保存 1 项，未采用 1 项");
    expect(screen.getByText("已确认并保存",{exact:true})).toBeInTheDocument();
    expect(screen.queryByText("待用户确认",{exact:true})).not.toBeInTheDocument();
    expect(writes[1]).toMatchObject({action:"approval",fingerprint:"c".repeat(64),decision:"approve"});
    expect(screen.getByText("供应商等待仍需核实")).toBeInTheDocument();
    rendered.unmount();render(<WorkAgentPage projectId="project_1"/>);
    await screen.findByText("已保存 1 项，未采用 1 项");expect(writes).toHaveLength(2);
  });
  it("disables uncertain edits and an already-selected legacy contradiction",async()=>{
    const data=view(),task=data.tasks[0];
    task.artifact!.preview!.changes[0].review={status:"needs_review",reason:"实际新内容无法确认，请调整后重新比较。",sourceFindingIds:[]};
    task.artifact!.preview!.selectedKeys=["vendor"];
    task.task.wait={kind:"confirmation",message:"确认",refId:"approval_1"};
    task.task.approval={id:"approval_1",actionId:"approval_1",taskVersion:1,tool:"work.apply_confirmed_changes",fingerprint:"c".repeat(64),status:"pending",createdAt:"2026-10-29T00:00:00Z",title:"保存",summary:"固定预览",target:"project_1",content:"",sourceFingerprint:"b".repeat(64)};
    const fetcher=vi.fn(async()=>Response.json(data));vi.stubGlobal("fetch",fetcher);
    render(<WorkAgentPage projectId="project_1"/>);
    expect(await screen.findByRole("button",{name:"确认保存选中的修改"})).toBeDisabled();
    expect(screen.getByRole("checkbox",{name:"调整原部署待办"})).toBeDisabled();
    expect(screen.getByText(/实际新内容无法确认/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"确认保存选中的修改"}));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("renders completed work separately from an unresolved independent question",async()=>{
    const data=view();
    const common={state:"open" as const,currentFindingId:null,events:[],linkedTodos:[{id:"test_todo",title:"回滚测试",status:"completed" as const}]};
    data.threads=[{...common,id:"work_thread",anchorFindingId:"test",title:"回滚测试",kind:"work"},
      {...common,id:"question_thread",anchorFindingId:"question",title:"回滚问题",kind:"question"}];
    data.openLoops.push({id:"question_thread",kind:"question",threadId:"question_thread",title:"回滚问题",status:"unresolved",basis:"confirmed_relation",text:"回滚问题：问题仍未解决；关联待办已完成。",reasons:[],sources:[],linkedTodos:[]});
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json(data)));
    render(<WorkAgentPage projectId="project_1"/>);
    await screen.findByRole("heading",{name:"回滚测试 · 工作记录"});
    expect(screen.getByRole("heading",{name:"回滚问题 · 问题未解决"})).toBeInTheDocument();
    expect(screen.getAllByText("关联待办：回滚测试 · 已完成")).toHaveLength(2);
    expect(screen.getByText(/独立问题仍未解决/)).toBeInTheDocument();
    expect(screen.queryByText(/回滚测试.*尚无已确认的关闭关系/)).not.toBeInTheDocument();
  });
  it("keeps comparison-only results, explains limits and requests sources afresh",async()=>{
    const data=view();data.tasks[0].task.status="ended";data.tasks[0].task.wait=undefined;data.tasks[0].artifact!.preview=null;
    const fetcher=vi.fn(async(url:string)=>url.includes("findingId=")?Response.json({error:"source_changed"},{status:409}):Response.json(data));vi.stubGlobal("fetch",fetcher);
    render(<WorkAgentPage projectId="project_1" meetingId="meeting_3"/>);
    await screen.findByRole("button",{name:"选择并保存这次比较的后续工作"});
    expect(screen.getByText(/缺少记录不证明未完成/)).toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"确认保存选中的修改"})).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button",{name:"查看原文 1"})[0]);
    await waitFor(()=>expect(screen.getByText(/会议、待办或任务状态已变化/)).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetcher.mock.calls.some(([url])=>url.endsWith("findingId=finding_b"))).toBe(true);
  });
});
