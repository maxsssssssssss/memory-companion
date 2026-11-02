import {render,screen,fireEvent,within,waitFor,cleanup} from "@testing-library/react";
import {afterEach,describe,it,expect,vi} from "vitest";
import {WorkPreparationPanel} from "./work-preparation-panel";
import type {WorkPreparationProject,WorkAgendaItem} from "@/lib/domain/work-preparation";

afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function fixture():WorkPreparationProject{
  const item=(id:string,title:string)=>({id,title,reason:"需要确认",background:"已确认会议",currentStatus:"待确认",question:`确认${title}`,expectedOutcome:"确定安排",ownerLabel:null,priority:"high" as const,sourceFindingIds:[`finding_${id}`],todoIds:[],threadIds:[],userEdited:false,sourceInvalid:false});
  return {tasks:[],meetings:[{id:"meeting_4",title:"合成M4",meetingDate:"2026-11-03",reviewed:true}],preparations:[{id:"prep_1",projectId:"project_1",taskId:"task_1",goal:"准备下次会议",version:1,status:"draft",createdAt:"2026-10-30T00:00:00Z",updatedAt:"2026-10-30T00:00:00Z",meetingId:null,meetingTitle:null,meetingAvailable:true,stale:false,sourceInvalid:false,snapshot:null,sources:[],review:null,followUpTaskId:null,
    statusAsOf:"2026-10-30T00:00:00Z",meetingDate:null,agenda:[item("deploy","B方案部署进度"),item("logs","日志保留期限"),item("vendor","供应商回复")]}]};
}
describe("P3 actual preparation editor",()=>{
  it("separates unverified discussion from system facts and distinguishes state time from meeting date",async()=>{
    const data=fixture(),p=data.preparations[0];p.agenda[0].currentStatus="当前正式方案为B；待办截止日期 2026-10-30；尚无完成确认记录，实际进展需要核实。";
    p.agenda[0].question="B已经上线，需要检查运行情况";
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json(data)));
    render(<WorkPreparationPanel projectId="project_1" onSource={vi.fn()} onFollowUp={vi.fn()}/>);
    await screen.findByRole("form",{name:"编辑会议议程"});expect(screen.getAllByText("Agent 讨论建议 · 待核实")).toHaveLength(3);
    expect(screen.getByText(/状态更新于.*会议时间：未指定/)).toBeInTheDocument();
    const facts=screen.getByLabelText("系统业务记录 1");expect(facts).toHaveTextContent("尚无完成确认记录");expect(facts).not.toHaveTextContent("B已经上线");
    expect(screen.getByText(/下方标题、讨论重点和预期结果是待核实的讨论建议/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("B已经上线，需要检查运行情况")).toBeInTheDocument();
  });
  it("shows an explicitly linked meeting date separately from the status timestamp",async()=>{
    const data=fixture();Object.assign(data.preparations[0],{status:"linked",meetingId:"meeting_4",meetingTitle:"合成M4",meetingDate:"2026-11-03"});
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json(data)));
    render(<WorkPreparationPanel projectId="project_1" onSource={vi.fn()} onFollowUp={vi.fn()}/>);
    expect(await screen.findByText(/状态更新于.*会议时间：2026-11-03/)).toBeInTheDocument();
  });
  it("edits, reorders, removes, adds a temporary topic and submits only the saved user version",async()=>{
    const data=fixture(),writes:Record<string,unknown>[]=[];
    vi.stubGlobal("fetch",vi.fn(async(_url:string,init?:RequestInit)=>{if(init?.method==="PATCH"){const body=JSON.parse(init.body as string);writes.push(body);
      data.preparations[0]={...data.preparations[0],status:"saved",version:2,agenda:(body.agenda as WorkAgendaItem[]).map(a=>({...a,userEdited:true,sourceInvalid:false}))};return Response.json({preparation:data.preparations[0]});}return Response.json(data);}));
    const props={projectId:"project_1",onSource:vi.fn(),onFollowUp:vi.fn()};const ui=render(<WorkPreparationPanel {...props}/>);
    await screen.findByRole("form",{name:"编辑会议议程"});
    fireEvent.click(screen.getByRole("button",{name:"删除议题 3"}));fireEvent.click(screen.getByRole("button",{name:"上移议题 2"}));
    fireEvent.change(screen.getAllByLabelText("讨论重点")[0],{target:{value:"确定日志保留时间与负责人"}});
    fireEvent.click(screen.getByRole("button",{name:"增加临时议题"}));fireEvent.change(screen.getAllByLabelText("议题名称")[2],{target:{value:"临时支持交接"}});
    fireEvent.click(screen.getByRole("button",{name:"保存会议准备"}));await waitFor(()=>expect(writes).toHaveLength(1));
    const agenda=writes[0].agenda as WorkAgendaItem[];expect(agenda.map(a=>a.title)).toEqual(["日志保留期限","B方案部署进度","临时支持交接"]);
    expect(agenda[0].question).toBe("确定日志保留时间与负责人");expect(agenda[2].sourceFindingIds).toEqual([]);
    await screen.findByRole("heading",{name:"已保存 · 版本 2"});ui.unmount();render(<WorkPreparationPanel {...props}/>);
    expect(await screen.findByDisplayValue("确定日志保留时间与负责人")).toBeInTheDocument();
  });
  it("shows stale/source-invalid states and does not claim unmentioned work completed",async()=>{
    const data=fixture(),p=data.preparations[0];p.status="awaiting_review";p.stale=true;p.meetingId="meeting_4";p.meetingTitle="合成M4";
    p.review={taskId:"review_1",fingerprint:"a".repeat(64),confirmed:false,stale:false,coverage:"已读三场历史及M4",items:[{agendaId:"vendor",status:"unresolved",text:"供应商仍未回复",sourceFindingIds:["source_vendor"]},
      {agendaId:"logs",status:"not_discussed",text:"没有后续记录不等于已完成",sourceFindingIds:[]}],addedFindingIds:[]};
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json(data)));const source=vi.fn();render(<WorkPreparationPanel projectId="project_1" onSource={source} onFollowUp={vi.fn()}/>);
    expect(await screen.findByText("这份会议准备可能已经过期")).toBeInTheDocument();
    const review=screen.getByRole("region",{name:"会前会后对照"});expect(within(review).getByText("日志保留期限 · 本次未见讨论记录")).toBeInTheDocument();
    fireEvent.click(within(review).getByRole("button",{name:"会后原文 1"}));expect(source).toHaveBeenCalledWith("source_vendor");
    expect(screen.getByRole("button",{name:"确认对照，整理会后工作"})).toBeEnabled();
  });
  it("preserves local edits after version-conflict errors and disables automatic restart for unknown tasks",async()=>{
    const data=fixture();data.tasks=[{id:"task_unknown",preparationId:"prep_other",mode:"prepare",status:"needs_attention",version:1,message:"结果未知，不会自动重发"}];
    vi.stubGlobal("fetch",vi.fn(async(_url:string,init?:RequestInit)=>init?.method==="PATCH"?Response.json({message:"另一处已保存了新版本"},{status:409}):Response.json(data)));
    render(<WorkPreparationPanel projectId="project_1" onSource={vi.fn()} onFollowUp={vi.fn()}/>);
    await screen.findByRole("form",{name:"编辑会议议程"});fireEvent.change(screen.getAllByLabelText("讨论重点")[0],{target:{value:"我的未保存修改"}});
    fireEvent.click(screen.getByRole("button",{name:"保存会议准备"}));await screen.findByText("另一处已保存了新版本");
    expect(screen.getByDisplayValue("我的未保存修改")).toBeInTheDocument();expect(screen.queryByRole("button",{name:"继续原整理"})).not.toBeInTheDocument();
  });
});
