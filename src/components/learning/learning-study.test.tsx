import { fireEvent, render, screen, waitFor, cleanup, act, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LearningNodeConversation, LearningRelations } from "./learning-study";
import { learningApi, LearningApiError } from "@/lib/client/learning-api";
import type { NodeConversation, OverviewView } from "@/lib/domain/learning-study";
import { LearningMindMap } from "./learning-mind-map";
vi.mock("./learning-mind-map", () => ({ LearningMindMap: vi.fn(({ relations, renderRelation }: Parameters<typeof LearningMindMap>[0]) => <div aria-label="学习导图">{relations.map((_, i) => <div key={i}>{renderRelation(i)}</div>)}</div>) }));
vi.mock("@/lib/client/learning-api",async original=>({...await original<typeof import("@/lib/client/learning-api")>(),learningApi:{conversations:vi.fn(),askNode:vi.fn(),saveAnswerNote:vi.fn(),studySource:vi.fn(),overview:vi.fn(),updateOverview:vi.fn()}}));
const source={materialId:"m",paragraph:1,start:0,end:3,originalSha256:"mock",paragraphSha256:"mock"};
const node={id:"n",title:"合成点",explanation:"旧框架",supplement:null,note:"旧笔记",edited:false,sources:[source]};
const chapter={id:"c",runId:"r",title:"合成章",explanation:"含反例",edited:false,revision:4,nodes:[node]};
const materials=[{id:"m",title:"合成原文",kind:"text" as const,byteLength:3,createdAt:"",filename:null,selected:true}];
let conversations:NodeConversation[];const onSource=vi.fn(),onSaved=vi.fn();
const mount=()=>render(<LearningNodeConversation pageId="p" chapter={chapter} node={node} materials={materials} onSource={onSource} onSaved={onSaved}/>);
beforeEach(()=>{vi.clearAllMocks();conversations=[{id:"conversation",title:"合成点",state:"current",turns:[{id:"turn",question:"[合成] 第一问",action:"ask",createdAt:"",status:"completed",failure:null,contextTurnIds:[],omittedTurns:0,savedSections:[],answer:{materialAnswer:"[模拟] 材料内说明",supplements:[{kind:"explanation",text:"[模拟] 基础补充"}],items:[source]}}]}];vi.mocked(learningApi.conversations).mockImplementation(async()=>({conversations:structuredClone(conversations)}));onSaved.mockResolvedValue(undefined);});
afterEach(()=>{cleanup();vi.useRealTimers();});
it("lets a slow polling response settle instead of superseding it every interval",async()=>{
 vi.useFakeTimers();conversations[0].turns[0].status="generating";
 let settle!:(v:{conversations:NodeConversation[]})=>void;
 vi.mocked(learningApi.conversations).mockResolvedValueOnce({conversations:structuredClone(conversations)}).mockImplementation(()=>new Promise(resolve=>{settle=resolve;}));
 mount();await act(async()=>{});await act(async()=>{await vi.advanceTimersByTimeAsync(1500);});
 expect(learningApi.conversations).toHaveBeenCalledTimes(2);
 await act(async()=>{await vi.advanceTimersByTimeAsync(6000);});expect(learningApi.conversations).toHaveBeenCalledTimes(2);
 conversations[0].turns[0].status="completed";await act(async()=>{settle({conversations:structuredClone(conversations)});});
 expect(screen.getByText("[模拟] 基础补充")).toBeVisible();
 await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});expect(learningApi.conversations).toHaveBeenCalledTimes(2);
});
it("keeps a question draft when its drawer closes and prevents note writes while editing", async()=>{
 const props={pageId:"p",chapter,node,materials,onSource,onSaved,onClose:vi.fn(),noteLocked:true};
 const ui=render(<LearningNodeConversation {...props} open />);
 await screen.findByText("[模拟] 基础补充");fireEvent.change(screen.getByLabelText("继续追问"),{target:{value:"未保存的提问"}});
 expect(screen.getByRole("button",{name:"将这条补充存为笔记"})).toBeDisabled();
 ui.rerender(<LearningNodeConversation {...props} open={false}/>);expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
 ui.rerender(<LearningNodeConversation {...props} open/>);expect(screen.getByLabelText("继续追问")).toHaveValue("未保存的提问");
 expect(learningApi.askNode).not.toHaveBeenCalled();expect(learningApi.saveAnswerNote).not.toHaveBeenCalled();
});
it("reopens separated answer/supplement and sends a continuous question without automatically saving a note",async()=>{
 mount();await screen.findByText("[模拟] 基础补充");expect(screen.getByText("补充解释 · 材料外")).toBeVisible();expect(learningApi.saveAnswerNote).not.toHaveBeenCalled();
 vi.mocked(learningApi.askNode).mockResolvedValue({conversations});fireEvent.change(screen.getByLabelText("继续追问"),{target:{value:"[合成] 继续第二问"}});fireEvent.click(screen.getByRole("button",{name:"发送问题"}));await waitFor(()=>expect(learningApi.askNode).toHaveBeenCalledWith("p",expect.objectContaining({conversationId:"conversation",question:"[合成] 继续第二问",nodeId:"n"})));
 const references=screen.getByText("引用 · 1").closest("details")!;expect(references).not.toHaveAttribute("open");expect(screen.getByText("合成原文 · 第 1 段")).not.toBeVisible();expect(learningApi.studySource).not.toHaveBeenCalled();
 fireEvent.click(screen.getByText("引用 · 1"));
 vi.mocked(learningApi.studySource).mockResolvedValue({source:{materialId:"m",title:"合成原文",paragraph:{number:1,text:"原文",start:0,end:2}}});fireEvent.click(screen.getByRole("button",{name:"合成原文 · 第 1 段"}));await waitFor(()=>expect(onSource).toHaveBeenCalledWith("m",1,undefined));expect(learningApi.studySource).toHaveBeenCalledWith("p","answer","turn",0,0);
});
it("explicit note save carries CAS revision; a conflict preserves the explanation and current draft",async()=>{
 mount();await screen.findByText("[模拟] 基础补充");fireEvent.change(screen.getByLabelText("继续追问"),{target:{value:"未发出的草稿"}});vi.mocked(learningApi.saveAnswerNote).mockRejectedValue(new LearningApiError(409,"framework_edit_conflict"));fireEvent.click(screen.getByRole("button",{name:"将这条补充存为笔记"}));await screen.findByRole("alert");expect(screen.getByLabelText("继续追问")).toHaveValue("未发出的草稿");expect(learningApi.saveAnswerNote).toHaveBeenCalledWith("p",expect.objectContaining({turnId:"turn",revision:4,section:0}));expect(onSaved).not.toHaveBeenCalled();
});
it("stale conversation needs explicit new conversation and cannot silently continue old context",async()=>{
 conversations[0].state="study_content_changed";mount();await screen.findByText(/不能直接续聊/);expect(screen.getByRole("button",{name:"换个说法"})).toBeDisabled();fireEvent.click(screen.getByRole("button",{name:"基于当前知识点开始新对话"}));vi.mocked(learningApi.askNode).mockResolvedValue({conversations});fireEvent.click(screen.getByRole("button",{name:"换个说法"}));await waitFor(()=>expect(learningApi.askNode).toHaveBeenCalled());expect(vi.mocked(learningApi.askNode).mock.calls[0][1].conversationId).not.toBe("conversation");
});
it("retains old overview after failure, labels stale sources and never disguises directory text as generated relations",async()=>{
 vi.mocked(learningApi.overview).mockResolvedValue({overview:{latest:{id:"new",status:"failed",failure:"framework_provider_failed"},published:{id:"old",stale:true,sourceState:"material_deleted",result:{summary:"旧关系说明",items:[]}}}});
 render(<LearningRelations pageId="p" materials={[]} onSource={onSource} refreshKey="test" chapters={[chapter,{...chapter,id:"c2",runId:"r2"}]} />);await screen.findByText("旧关系说明");expect(screen.getByText("旧关系说明")).not.toBeVisible();expect(screen.getByText("总览说明").closest("details")).not.toHaveAttribute("open");expect(screen.getByText(/相关来源已删除/)).toBeVisible();expect(screen.getByText(/关系更新未完成/)).toBeVisible();fireEvent.click(screen.getByText("总览说明"));expect(screen.getByText("旧关系说明")).toBeVisible();expect(learningApi.updateOverview).not.toHaveBeenCalled();
});
it("discloses partial publication and rejected relation reasons separately from the saved summary",async()=>{
 const validation={submitted:3,accepted:1,rejected:[{index:1,reason:'same_batch'},{index:2,reason:'unknown_chapter'}]};
 vi.mocked(learningApi.overview).mockResolvedValue({overview:{latest:{id:'new',status:'completed',failure:null,validation},published:{id:'new',stale:false,sourceState:'available',result:{summary:'已保留一条关系，范围不完整',items:[],validation,generatedSummary:'不应直接展示的原概括'}}}});
 render(<LearningRelations pageId='p' materials={materials} onSource={onSource} refreshKey='partial' chapters={[chapter,{...chapter,id:'c2',runId:'r2'}]}/>);
 await screen.findByText('已保留一条关系，范围不完整');expect(screen.getByText(/1\/3 条关系通过检查/)).toBeVisible();expect(screen.queryByText('不应直接展示的原概括')).not.toBeInTheDocument();fireEvent.click(screen.getByText(/1\/3 条关系通过检查/));expect(screen.getByText('第 2 条：仅涉及同一批次')).toBeVisible();expect(screen.getByText('第 3 条：章节引用不在本次范围')).toBeVisible();
});
it("keeps answer references collapsed, preserves deleted sources and shows source failures without closing the conversation",async()=>{
 conversations[0].turns[0].answer!.items.push({...source,materialId:"deleted"});
 const onClose=vi.fn();render(<LearningNodeConversation pageId="p" chapter={chapter} node={node} materials={materials} onSource={onSource} onSaved={onSaved} onClose={onClose} open/>);
 const summary=await screen.findByText("引用 · 2");expect(summary.closest("details")).not.toHaveAttribute("open");expect(screen.getByText("来源已删除")).not.toBeVisible();
 fireEvent.click(summary);expect(screen.getByRole("button",{name:"来源已删除"})).toBeDisabled();
 vi.mocked(learningApi.studySource).mockRejectedValue(new LearningApiError(410,"learning_material_not_found"));fireEvent.click(screen.getByRole("button",{name:"合成原文 · 第 1 段"}));
 await screen.findByRole("alert");expect(screen.getByText("[模拟] 材料内说明")).toBeVisible();expect(onClose).not.toHaveBeenCalled();expect(onSource).not.toHaveBeenCalled();
});
it("opens a parsed answer reference using its physical page and closes the conversation only after the source resolves",async()=>{
 const parsed={documentId:"doc",version:2,blockId:"block",physicalPage:8,sourceHash:"mock"};conversations[0].turns[0].answer!.items=[{...source,parsed}];
 const onClose=vi.fn();render(<LearningNodeConversation pageId="p" chapter={chapter} node={node} materials={materials} onSource={onSource} onSaved={onSaved} onClose={onClose} open/>);
 fireEvent.click(await screen.findByText("引用 · 1"));vi.mocked(learningApi.studySource).mockResolvedValue({source:{materialId:"m",title:"合成原文",paragraph:{number:1,text:"原文",start:0,end:2,parsed}}});
 fireEvent.click(screen.getByRole("button",{name:"合成原文 · 第 8 物理页 · 来源区域"}));await waitFor(()=>expect(onSource).toHaveBeenCalledWith("m",8,parsed));expect(onClose).toHaveBeenCalledOnce();expect(learningApi.studySource).toHaveBeenCalledWith("p","answer","turn",0,0);
});
it("renders chapters without a published overview and keeps chapter/node navigation connected",async()=>{
 vi.mocked(learningApi.overview).mockResolvedValue({overview:{latest:null,published:null}});const onChapter=vi.fn(),onNode=vi.fn();
 render(<LearningRelations pageId="p" materials={materials} onSource={onSource} refreshKey="empty" chapters={[chapter]} onChapter={onChapter} onNode={onNode}/>);
 await waitFor(()=>expect(learningApi.overview).toHaveBeenCalledWith("p"));expect(screen.getByLabelText("学习导图")).toBeVisible();expect(screen.getByRole("button",{name:"更新关系总览"})).toBeDisabled();
 const props=vi.mocked(LearningMindMap).mock.calls.at(-1)![0];expect(props.chapters).toEqual([chapter]);expect(props.relations).toEqual([]);props.onChapter?.("c");props.onNode?.("c","n");expect(onChapter).toHaveBeenCalledWith("c");expect(onNode).toHaveBeenCalledWith("c","n");expect(learningApi.updateOverview).not.toHaveBeenCalled();
});
it("keeps relation references collapsed and preserves selected relation/source indexes, deleted labels and parsed navigation",async()=>{
 const parsed={documentId:"doc",version:2,blockId:"block",physicalPage:8,sourceHash:"mock"};
 const overview:OverviewView={latest:{id:"published",status:"completed",failure:null},published:{id:"published",stale:false,sourceState:"available",result:{summary:"[模拟] 关系概括",items:[{kind:"connection",title:"第一条联系",explanation:"[模拟] 说明一",chapterIds:["c","c2"],sources:[source]},{kind:"distinction",title:"第二条联系",explanation:"[模拟] 说明二",chapterIds:["c","c2"],sources:[{...source,materialId:"deleted"},{...source,parsed}]}]}}};
 vi.mocked(learningApi.overview).mockResolvedValue({overview});const onChapter=vi.fn();render(<LearningRelations pageId="p" materials={materials} onSource={onSource} refreshKey="references" chapters={[chapter,{...chapter,id:"c2",runId:"r2",title:"第二章"}]} onChapter={onChapter}/>);
 const article=(await screen.findByRole("heading",{name:"概念区别 · 第二条联系"})).closest("article")!;const references=within(article).getByText("引用 · 2");
 expect(references.closest("details")).not.toHaveAttribute("open");expect(within(article).getByText("来源已删除")).not.toBeVisible();expect(learningApi.studySource).not.toHaveBeenCalled();
 fireEvent.click(within(article).getByRole("link",{name:"第二章"}));expect(onChapter).toHaveBeenCalledWith("c2");fireEvent.click(references);expect(within(article).getByRole("button",{name:"来源已删除"})).toBeDisabled();
 vi.mocked(learningApi.studySource).mockRejectedValueOnce(new LearningApiError(410,"learning_material_not_found"));fireEvent.click(within(article).getByRole("button",{name:"合成原文 · 第 8 物理页 · 来源区域"}));await screen.findByRole("alert");expect(screen.getByText("[模拟] 说明二")).toBeVisible();expect(onSource).not.toHaveBeenCalled();
 vi.mocked(learningApi.studySource).mockResolvedValue({source:{materialId:"m",title:"合成原文",paragraph:{number:1,text:"原文",start:0,end:2,parsed}}});fireEvent.click(within(article).getByRole("button",{name:"合成原文 · 第 8 物理页 · 来源区域"}));
 await waitFor(()=>expect(onSource).toHaveBeenCalledWith("m",8,parsed));expect(learningApi.studySource).toHaveBeenLastCalledWith("p","overview","published",1,1);
});
