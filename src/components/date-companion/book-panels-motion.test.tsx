import {act,cleanup,fireEvent,render,screen,within} from "@testing-library/react";
import {StrictMode} from "react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {BookMemory,BookPanelsProvider,BookSource,BookTranscriptButton} from "./book-panels";
import type {InteractionVM,RecapItemVM,SourceRefVM} from "@/lib/domain/date-companion";

const sources:SourceRefVM[]=["self","companion","both","unknown"].map((subject,i)=>({
  id:`evidence-${i}`,uploadId:"appendix-fixture",segmentIds:[`line-${i}`],recordingDate:"2026-11-20",
  startSeconds:i*10,endSeconds:i*10+4,speakerId:"speaker",quote:`独立虚构来源${i}`,kind:"transcript",presentation:"direct_quote",memorySubject:subject as SourceRefVM["memorySubject"]
}));
const items:RecapItemVM[]=sources.map((source,i)=>({id:`item-${i}`,interactionId:"interaction-fixture",kind:"moment",title:`片段${i}`,proposedText:`片段${i}`,displayedText:`片段${i}`,disposition:"kept",sources:[source]}));
const interaction:InteractionVM={id:"interaction-fixture",uploadIds:["appendix-fixture"],sourceUploadId:"appendix-fixture",recordingDate:"2026-11-20",fileName:"虚构附册.wav",title:"虚构附册",status:"ready",transcript:sources.map(source=>({id:source.segmentIds[0],uploadId:source.uploadId,text:source.quote,startSeconds:source.startSeconds,endSeconds:source.endSeconds}))};
type Clip={node:HTMLElement;keys:Keyframe[];options:KeyframeAnimationOptions;cancel:ReturnType<typeof vi.fn>;finish:ReturnType<typeof vi.fn>};
let clips:Clip[],frames:Map<number,FrameRequestCallback>,frameId:number,media:EventTarget&{matches:boolean};
const consent=vi.fn(),submit=vi.fn();
function App({status="not_queued"}:{status?:string}){
  return <BookPanelsProvider interaction={interaction} speakerLabel={()=>"我"} sources={sources}>
    <BookMemory meetingTitle="虚构附册" items={items} suggestedSubjects={new Map()} status={status} statusLabel="尚未选择长期保留"
      controls={<><label><input type="checkbox" onChange={consent}/>这次也整理进长期记忆</label><button onClick={submit}>开始长期整理</button></>}/>
  </BookPanelsProvider>;
}
const open=(detail=1)=>fireEvent.click(screen.getByRole("button",{name:"查看内容与归属"}),{detail});
const flush=()=>act(()=>{const pending=[...frames.values()];frames.clear();pending.forEach(callback=>callback(16));});
const tick=(ms=200)=>act(()=>vi.advanceTimersByTime(ms));
const reduce=(matches:boolean)=>act(()=>{media.matches=matches;media.dispatchEvent(new Event("change"));});
const book=()=>screen.getByRole("dialog",{name:"长期记忆"});
const bookClips=()=>clips.filter(clip=>clip.node.dataset.bookPanel==="book");
const close=(detail=1)=>fireEvent.click(within(book()).getByRole("button",{name:"← 返回复盘"}),{detail});

describe("book appendix operation motion",()=>{
  beforeEach(()=>{
    vi.useFakeTimers();clips=[];frames=new Map();frameId=0;consent.mockClear();submit.mockClear();
    document.body.style.overflow="";document.documentElement.style.overflow="";
    media=Object.assign(new EventTarget(),{matches:false});vi.stubGlobal("matchMedia",()=>media);
    vi.stubGlobal("requestAnimationFrame",(callback:FrameRequestCallback)=>{frames.set(++frameId,callback);return frameId;});vi.stubGlobal("cancelAnimationFrame",(id:number)=>frames.delete(id));
    vi.stubGlobal("scrollTo",vi.fn());
    Object.defineProperty(HTMLElement.prototype,"scrollIntoView",{configurable:true,value:vi.fn()});
    Object.defineProperty(HTMLDialogElement.prototype,"showModal",{configurable:true,value:function(this:HTMLDialogElement){this.open=true;}});
    Object.defineProperty(HTMLDialogElement.prototype,"close",{configurable:true,value:function(this:HTMLDialogElement){this.open=false;this.dispatchEvent(new Event("close"));}});
    vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(function(this:HTMLElement){const x=["self","companion","both","unknown"].indexOf(this.dataset.paperChoiceValue||"")*100;return {x,y:10,left:x,top:10,right:x+90,bottom:54,width:90,height:44,toJSON(){}};});
    Object.defineProperty(HTMLElement.prototype,"animate",{configurable:true,value:function(this:HTMLElement,keys:Keyframe[],options:KeyframeAnimationOptions){const clip={node:this,keys,options,cancel:vi.fn(),finish:vi.fn()};clips.push(clip);return clip;}});
  });
  afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();delete (HTMLElement.prototype as unknown as {animate?:unknown}).animate;});

  it("three explicit openings each animate once; rerenders and reading never authorize retention",()=>{
    const view=render(<App/>);
    for(let i=0;i<3;i++){
      open();flush();expect(bookClips().filter(clip=>clip.options.duration===310)).toHaveLength(i+1);
      view.rerender(<App/>);flush();expect(bookClips().filter(clip=>clip.options.duration===310)).toHaveLength(i+1);
      fireEvent.click(within(book()).getByRole("tab",{name:"我们 1"}),{detail:1});
      expect(within(book()).getByRole("checkbox")).not.toBeChecked();
      close();expect(book()).toBeInTheDocument();tick();flush();expect(screen.queryByRole("dialog",{name:"长期记忆"})).not.toBeInTheDocument();
    }
    expect(consent).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();
  });

  it("keyboard and reduced openings do not consume the next pointer opening",()=>{
    render(<App/>);open(0);flush();expect(bookClips()).toHaveLength(0);close(0);flush();
    reduce(true);open();flush();expect(bookClips()).toHaveLength(0);close();flush();
    reduce(false);open();flush();expect(bookClips()).toHaveLength(1);
    reduce(true);expect(bookClips()[0].cancel).toHaveBeenCalled();reduce(false);flush();expect(bookClips()).toHaveLength(1);
    close(0);flush();open();flush();expect(bookClips()).toHaveLength(2);
  });

  it("close before the scheduled entrance cancels it, keeps the exit frame, and reopens cleanly",()=>{
    render(<App/>);open();close();flush();expect(bookClips()).toHaveLength(1);expect(bookClips()[0].options.duration).toBe(200);
    tick(199);expect(book()).toBeInTheDocument();tick(1);expect(bookClips()[0].finish).toHaveBeenCalled();
    open();flush();tick(400);expect(book()).toBeInTheDocument();expect(bookClips().filter(clip=>clip.options.duration===310)).toHaveLength(1);
  });

  it("closing a moving sheet uses its current transform and a repeat close cannot activate consent",()=>{
    render(<App/>);open();flush();const paper=book();paper.style.transform="translateX(17px)";close();
    expect(bookClips()[0].cancel).toHaveBeenCalled();expect(bookClips()[1].keys[0].transform).toBe("translateX(17px)");
    fireEvent.click(within(paper).getByRole("checkbox"),{detail:1});flush();
    expect(consent).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();expect(screen.queryByRole("dialog",{name:"长期记忆"})).not.toBeInTheDocument();
  });

  it("runtime reduced motion completes a pending exit without a stale timer or later replay",()=>{
    render(<App/>);open();flush();close();reduce(true);flush();expect(screen.queryByRole("dialog",{name:"长期记忆"})).not.toBeInTheDocument();
    reduce(false);open();flush();tick(500);expect(book()).toBeInTheDocument();expect(bookClips().filter(clip=>clip.options.duration===310)).toHaveLength(2);
  });

  it("classification repeats, same tab is a no-op, keyboard is static and source return preserves the booklet",()=>{
    render(<App/>);open();flush();
    const inkClips=()=>clips.filter(clip=>clip.node.hasAttribute("data-paper-choice-ink"));
    for(let i=0;i<3;i++)for(const name of ["Ta 1","我 1"])fireEvent.click(within(book()).getByRole("tab",{name}),{detail:1});
    expect(inkClips()).toHaveLength(6);fireEvent.click(within(book()).getByRole("tab",{name:"我 1"}),{detail:1});expect(inkClips()).toHaveLength(6);
    fireEvent.keyDown(within(book()).getByRole("tab",{name:"我 1"}),{key:"ArrowRight"});expect(within(book()).getByRole("tab",{name:"Ta 1"})).toHaveFocus();expect(inkClips()).toHaveLength(6);
    const source=within(book()).getByRole("button",{name:"查看文字稿"});source.focus();fireEvent.click(source,{detail:1});flush();
    const reader=screen.getByRole("dialog",{name:"完整文字稿"});fireEvent.click(within(reader).getByRole("button",{name:"← 返回刚才的位置"}),{detail:0});flush();
    expect(source).toHaveFocus();expect(within(book()).getByRole("tab",{name:"Ta 1"})).toHaveAttribute("aria-selected","true");expect(bookClips().filter(clip=>clip.options.duration===310)).toHaveLength(1);
    expect(document.body.style.overflow).toBe("hidden");expect(consent).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();
  });

  it("primes the initially hidden native-dialog mark so the very first classification animates",()=>{
    vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(function(this:HTMLElement){
      const hidden=this.closest('dialog')?.open===false;
      const x=["self","companion","both","unknown"].indexOf(this.dataset.paperChoiceValue||"")*100;
      return {x,y:10,left:x,top:10,right:x+(hidden?0:90),bottom:hidden?10:54,width:hidden?0:90,height:hidden?0:44,toJSON(){}};
    });
    render(<App/>);
    for(let i=0;i<3;i++){
      open();flush();const before=clips.filter(clip=>clip.node.hasAttribute("data-paper-choice-ink")).length;
      const next=within(book()).getByRole("tab",{name:i%2?"我 1":"Ta 1"});
      fireEvent.pointerDown(next);fireEvent.click(next,{detail:1});
      expect(clips.filter(clip=>clip.node.hasAttribute("data-paper-choice-ink"))).toHaveLength(before+1);
      close(0);flush();
    }
  });

  it("unmount cancels pending work and restores only its modal lock",()=>{
    const view=render(<App/>);open();flush();close();view.unmount();tick(500);flush();
    expect(document.querySelector("dialog")).toBeNull();expect(document.body.style.overflow).toBe("");expect(document.documentElement.style.overflow).toBe("");
    expect(bookClips().every(clip=>clip.cancel.mock.calls.length>0)).toBe(true);
  });

  it("gives the native reader the cited line on every setup and preserves the default for a general opening",()=>{
    const initialTargets:HTMLElement[]=[];
    Object.defineProperty(HTMLDialogElement.prototype,"showModal",{configurable:true,value:function(this:HTMLDialogElement){
      this.open=true;
      const target=this.querySelector<HTMLElement>("[autofocus]") ?? this.querySelector<HTMLElement>("button");
      if(target){initialTargets.push(target);target.focus();}
    }});
    render(<StrictMode><BookPanelsProvider interaction={interaction} speakerLabel={()=>"我"}>
      <BookSource source={sources[0]}/><BookTranscriptButton/>
    </BookPanelsProvider></StrictMode>);
    const source=screen.getByRole("button",{name:"查看文字稿"});
    fireEvent.click(source);flush();
    const reader=screen.getByRole("dialog",{name:"完整文字稿"});
    const line=reader.querySelector('[data-segment-id="line-0"]');
    expect(initialTargets.length).toBeGreaterThan(1);
    expect(initialTargets.every(target=>target===line)).toBe(true);
    expect(line).toHaveFocus();
    fireEvent.click(within(reader).getByRole("button",{name:"← 返回刚才的位置"}));flush();
    expect(source).toHaveFocus();
    initialTargets.length=0;
    fireEvent.click(screen.getByRole("button",{name:"完整文字稿"}));flush();
    const back=screen.getByRole("button",{name:"← 返回刚才的位置"});
    expect(initialTargets.length).toBeGreaterThan(0);
    expect(initialTargets.every(target=>target===back)).toBe(true);
  });
});
