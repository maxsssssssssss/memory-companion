import {act, cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {InteractionVM, ParticipantReviewVM, RecapItemVM, SourceRefVM} from "@/lib/domain/date-companion";
import {CompanionRecap} from "./companion-recap";

const source:SourceRefVM={id:"feedback-evidence",uploadId:"feedback-upload",segmentIds:["feedback-line"],recordingDate:"2026-11-20",startSeconds:12,endSeconds:18,speakerId:"speaker-ta",quote:"我最近在准备摄影展。",kind:"transcript",presentation:"direct_quote"};
const item:RecapItemVM={id:"feedback-item",kind:"mentioned",title:"摄影展",proposedText:"正在准备摄影展。",displayedText:"正在准备摄影展。",disposition:"kept",sources:[source],version:1};
const participants:ParticipantReviewVM[]=[{speakerId:"speaker-ta",displayLabel:"小夏",state:"confirmed",role:"companion",sampleQuotes:[]}];
const interaction:InteractionVM={id:"feedback-upload",sourceUploadId:"feedback-upload",uploadIds:["feedback-upload"],relationshipInteractionId:"feedback-interaction",recordingDate:"2026-11-20",fileName:"虚构复盘.wav",title:"摄影展",status:"ready",persistenceStatus:"draft",transcript:[{id:"feedback-line",uploadId:"feedback-upload",startSeconds:12,endSeconds:18,speakerId:"speaker-ta",text:source.quote}]};

describe("book recap operation-owned draft feedback",()=>{
  let reduced=false;
  let listeners:Set<()=>void>;
  let animations:Array<{cancel:ReturnType<typeof vi.fn>;target:Element}>;
  const view=(props:Partial<React.ComponentProps<typeof CompanionRecap>>={})=><CompanionRecap interaction={interaction} items={[item]} participants={participants} onFinalize={vi.fn()} {...props}/>;
  const leaf=()=>document.querySelector('[data-book-item="feedback-item"]') as HTMLElement;
  const click=(name:string,detail=1)=>fireEvent.click(within(leaf()).getByRole("button",{name}),{detail});
  const open=()=>fireEvent.click(leaf().querySelector("h4 button")!,{detail:1});
  const apply=(text:string,detail=1)=>{click("修改",detail);fireEvent.change(screen.getByLabelText("修改摘要"),{target:{value:text}});click("应用修改",detail);};
  const changeReduced=(value:boolean)=>act(()=>{reduced=value;listeners.forEach(listener=>listener());});
  beforeEach(()=>{
    reduced=false;listeners=new Set();animations=[];
    vi.stubGlobal("matchMedia",()=>({get matches(){return reduced;},addEventListener:(_type:string,listener:()=>void)=>listeners.add(listener),removeEventListener:(_type:string,listener:()=>void)=>listeners.delete(listener)}));
    vi.stubGlobal("requestAnimationFrame",(callback:FrameRequestCallback)=>{callback(0);return 1;});
    vi.stubGlobal("cancelAnimationFrame",vi.fn());
    vi.stubGlobal("scrollTo",vi.fn());
    vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockReturnValue({x:0,y:100,top:100,left:0,bottom:300,right:600,width:600,height:200,toJSON:()=>({})});
    Object.defineProperty(HTMLElement.prototype,"animate",{configurable:true,value:vi.fn(function(this:Element){const animation={cancel:vi.fn(),target:this};animations.push(animation);return animation;})});
    Object.defineProperty(HTMLElement.prototype,"scrollIntoView",{configurable:true,value:vi.fn()});
    Object.defineProperty(HTMLDialogElement.prototype,"showModal",{configurable:true,value:function(this:HTMLDialogElement){this.open=true;}});
    Object.defineProperty(HTMLDialogElement.prototype,"close",{configurable:true,value:function(this:HTMLDialogElement){this.open=false;this.dispatchEvent(new Event("close"));}});
  });
  afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

  it("confirms each of three changed summaries only after the local draft updates, never on reread",()=>{
    const finalize=vi.fn(),ui=render(view({onFinalize:finalize}));open();
    ["草稿摘要一。","草稿摘要二。","草稿摘要三。"].forEach((text,index)=>{
      apply(text);expect(leaf().querySelector("h4")).toHaveTextContent(text);
      expect(animations).toHaveLength((index+1)*2);
      expect(within(leaf()).getByRole("status")).toHaveTextContent("修改已应用到本次草稿");
    });
    ui.rerender(view({onFinalize:finalize,items:[{...item}],participants:[...participants]}));
    expect(animations).toHaveLength(6);expect(finalize).not.toHaveBeenCalled();
    expect(leaf()).not.toHaveTextContent("已保存");
    expect(animations.every(animation=>animation.target.hasAttribute("data-paper-feedback-edge")||animation.target.hasAttribute("data-paper-feedback-ink"))).toBe(true);
  });

  it("does not animate unchanged text or cancelled editing",()=>{
    render(view());open();apply(item.displayedText);
    click("修改");fireEvent.change(screen.getByLabelText("修改摘要"),{target:{value:"不应用的文字"}});click("取消");
    expect(animations).toHaveLength(0);expect(leaf()).toHaveTextContent(item.displayedText);expect(leaf().querySelector("h4")).toHaveTextContent(item.title);
    apply("后来实际应用。 ");expect(animations).toHaveLength(2);expect(leaf().querySelector("h4")).toHaveTextContent("后来实际应用。");
  });

  it("replays each remove/restore, updates true counts immediately, and preserves the quote",()=>{
    const finalize=vi.fn();render(view({onFinalize:finalize}));open();
    for(let i=0;i<3;i++){
      click("这条不留下");expect(leaf()).toHaveAttribute("data-disposition","excluded");expect(screen.getByText("将保留 0 条 未保留 1 条",{exact:false})).toBeInTheDocument();
      expect(leaf()).toHaveTextContent(source.quote);expect(within(leaf()).getByRole("status")).toHaveTextContent("仍可恢复");
      click("恢复这条");expect(leaf()).toHaveAttribute("data-disposition","kept");expect(screen.getByText("将保留 1 条 未保留 0 条",{exact:false})).toBeInTheDocument();
      expect(animations).toHaveLength((i+1)*4);
    }
    expect(finalize).not.toHaveBeenCalled();expect(animations.slice(0,-2).every(animation=>animation.cancel.mock.calls.length>0)).toBe(true);
  });

  it("does not grant retention when restoring an entry whose source role is no longer eligible",()=>{
    const ui=render(view());open();click("这条不留下");
    ui.rerender(view({participants:[{...participants[0],role:"self",version:2}]}));
    click("恢复这条");expect(leaf()).toHaveAttribute("data-disposition","excluded");
    expect(within(leaf()).getByRole("status")).toHaveTextContent("目前仍未保留");
    expect(animations).toHaveLength(4);expect(leaf()).toHaveTextContent(source.quote);
  });

  it("keeps keyboard and reduced actions static without blocking a later pointer action",()=>{
    render(view());open();apply("键盘应用。",0);expect(animations).toHaveLength(0);
    changeReduced(true);apply("减少动效应用。");expect(animations).toHaveLength(0);
    changeReduced(false);expect(animations).toHaveLength(0);apply("恢复正常后的应用。");expect(animations).toHaveLength(2);
    changeReduced(true);expect(animations.every(animation=>animation.cancel.mock.calls.length>0)).toBe(true);
    changeReduced(false);expect(animations).toHaveLength(2);click("这条不留下");expect(animations).toHaveLength(4);
  });

  it("cancels interrupted decoration when editing resumes and starts a fresh operation after cancellation",()=>{
    render(view());open();apply("先应用。");const first=[...animations];
    click("修改");expect(first.every(animation=>animation.cancel.mock.calls.length>0)).toBe(true);
    fireEvent.change(screen.getByLabelText("修改摘要"),{target:{value:"取消这一稿"}});click("取消");expect(animations).toHaveLength(2);
    apply("下一次主动应用。");expect(animations).toHaveLength(4);
    act(()=>window.dispatchEvent(new PopStateEvent("popstate")));expect(animations.every(animation=>animation.cancel.mock.calls.length>0)).toBe(true);
    expect(animations).toHaveLength(4);
  });

  it("keeps draft choices after a failed formal submit without replaying draft receipts on retry",async()=>{
    const finalize=vi.fn().mockRejectedValueOnce(new Error("提交失败，草稿仍在。")).mockResolvedValue(undefined);
    render(view({items:[item,{...item,id:"second-feedback-item"}],onFinalize:finalize}));open();apply("应用但尚未正式提交。");click("这条不留下");
    expect(animations).toHaveLength(4);fireEvent.click(screen.getByRole("button",{name:"完成本次复盘"}));
    await screen.findByText("提交失败，草稿仍在。");expect(animations).toHaveLength(4);expect(leaf()).toHaveAttribute("data-disposition","excluded");
    fireEvent.click(screen.getByRole("button",{name:"重试完成本次复盘"}));await waitFor(()=>expect(finalize).toHaveBeenCalledTimes(2));
    expect(finalize.mock.calls[1]).toEqual(finalize.mock.calls[0]);expect(animations).toHaveLength(4);
  });
});
