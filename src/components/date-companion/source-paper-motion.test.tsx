import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sourcePaperEntry, useSourcePaperMotion, type SourcePaperEntry } from "./source-paper-motion";

type Clip={node:HTMLElement;frames:Keyframe[];options:KeyframeAnimationOptions;cancel:ReturnType<typeof vi.fn>;finish:ReturnType<typeof vi.fn>};
let clips:Clip[],frames:Map<number,FrameRequestCallback>,nextFrame:number;
let media:EventTarget&{matches:boolean};
const close=vi.fn();
function Harness({entry,active=true,edgeOnly=false,label="正文"}:{entry?:SourcePaperEntry|null;active?:boolean;edgeOnly?:boolean;label?:string}){
  const paper=useRef<HTMLDivElement>(null),edge=useRef<HTMLSpanElement>(null);
  const motion=useSourcePaperMotion({paper,edge,active,entry,edgeOnly});
  return <div ref={paper} data-testid="paper"><span ref={edge} data-testid="edge"/>
    <p data-segment-id="line" aria-current="true">{label}</p><input aria-label="查找"/>
    <button onClick={e=>motion.layer(1,e.detail)}>全文</button>
    <button onClick={e=>motion.dismiss(close,e.detail)}>关闭</button></div>;
}
function flush(){act(()=>{const callbacks=[...frames.values()];frames.clear();callbacks.forEach(fn=>fn(16));});}
function preference(matches:boolean){act(()=>{media.matches=matches;media.dispatchEvent(new Event("change"));});}
const papers=()=>clips.filter(c=>c.node.dataset.testid==='paper');
describe("source paper operation ownership",()=>{
  beforeEach(()=>{
    vi.useFakeTimers();clips=[];frames=new Map();nextFrame=0;close.mockReset();
    media=Object.assign(new EventTarget(),{matches:false});
    vi.stubGlobal('matchMedia',()=>media);
    vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.set(++nextFrame,callback);return nextFrame;});
    vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
    vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({x:0,y:80,top:80,bottom:680,left:0,right:660,width:660,height:600,toJSON(){}});
    Object.defineProperty(HTMLElement.prototype,'animate',{configurable:true,value:function(this:HTMLElement,keys:Keyframe[],options:KeyframeAnimationOptions){
      const clip={node:this,frames:keys,options,cancel:vi.fn(),finish:vi.fn()};clips.push(clip);return clip;
    }});
  });
  afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();delete (HTMLElement.prototype as unknown as {animate?:unknown}).animate;});
  it("replays three new operations on the same mounted paper, not repeated data renders",()=>{
    let entry=sourcePaperEntry(undefined,1);const view=render(<Harness entry={entry}/>);flush();
    for(let i=0;i<3;i++)view.rerender(<Harness entry={entry} label={'数据更新'+i}/>);
    expect(papers()).toHaveLength(1);
    for(let i=0;i<2;i++){view.rerender(<Harness active={false} entry={entry}/>);entry=sourcePaperEntry(undefined,1);view.rerender(<Harness entry={entry}/>);flush();}
    expect(papers()).toHaveLength(3);expect(papers().every(c=>c.options.duration===300)).toBe(true);
    expect(papers()[0].frames[0].transform).toContain('28px');
  });
  it("does not double-start during StrictMode setup/cleanup",()=>{
    render(<StrictMode><Harness entry={sourcePaperEntry(undefined,1)}/></StrictMode>);flush();expect(papers()).toHaveLength(1);
  });
  it("cancels an unpainted open and allows the next independent operation",()=>{
    const view=render(<Harness entry={sourcePaperEntry(undefined,1)}/>);
    view.rerender(<Harness active={false}/>);flush();expect(papers()).toHaveLength(0);
    view.rerender(<Harness entry={sourcePaperEntry(undefined,1)}/>);flush();expect(papers()).toHaveLength(1);
  });
  it("keyboard and reading restoration stay static without consuming a future pointer open",()=>{
    const view=render(<Harness entry={sourcePaperEntry(undefined,0)}/>);flush();
    view.rerender(<Harness entry={null}/>);flush();expect(clips).toHaveLength(0);
    view.rerender(<Harness entry={sourcePaperEntry(undefined,1)}/>);flush();expect(papers()).toHaveLength(1);
  });
  it("reduced first visit and preference changes apply only to the current operation",()=>{
    media.matches=true;const view=render(<Harness entry={sourcePaperEntry(undefined,1)}/>);flush();expect(clips).toHaveLength(0);
    preference(false);flush();expect(clips).toHaveLength(0);
    view.rerender(<Harness entry={sourcePaperEntry(undefined,1)}/>);flush();expect(papers()).toHaveLength(1);
    preference(true);expect(papers()[0].cancel).toHaveBeenCalled();
    preference(false);flush();expect(papers()).toHaveLength(1);
    view.rerender(<Harness entry={sourcePaperEntry(undefined,1)}/>);flush();expect(papers()).toHaveLength(2);
  });
  it("an interrupted exit cannot close a newer open",()=>{
    const view=render(<Harness entry={sourcePaperEntry(undefined,1)}/>);flush();
    fireEvent.click(screen.getByText('关闭'),{detail:1});act(()=>vi.advanceTimersByTime(60));
    view.rerender(<Harness entry={sourcePaperEntry(undefined,1)}/>);flush();act(()=>vi.advanceTimersByTime(300));
    expect(close).not.toHaveBeenCalled();expect(papers()).toHaveLength(3);
  });
  it("finishes bounded UI close even without animation finish events",()=>{
    render(<Harness entry={sourcePaperEntry(undefined,1)}/>);flush();fireEvent.click(screen.getByText('关闭'),{detail:1});
    act(()=>vi.advanceTimersByTime(180));expect(close).toHaveBeenCalledTimes(1);
  });
  it("holds the transparent exit frame while the host has not committed its close",()=>{
    const entry=sourcePaperEntry(undefined,1),view=render(<Harness entry={entry}/>);flush();
    fireEvent.click(screen.getByText('关闭'),{detail:1});const exit=papers().at(-1)!;
    expect(exit.options).toMatchObject({duration:180,fill:'forwards'});
    expect(exit.frames.at(-1)).toEqual({transform:'translateY(18px)',opacity:0});
    act(()=>vi.advanceTimersByTime(180));
    expect(close).toHaveBeenCalledTimes(1);expect(exit.finish).toHaveBeenCalledTimes(1);
    expect(exit.cancel).not.toHaveBeenCalled();
    act(()=>vi.advanceTimersByTime(300));expect(exit.cancel).not.toHaveBeenCalled();
    view.rerender(<Harness active={false} entry={entry}/>);
    expect(exit.cancel).toHaveBeenCalledTimes(1);
  });
  it("rapid repeated close requests finish the same exit once without revealing its base style",()=>{
    render(<Harness entry={sourcePaperEntry(undefined,1)}/>);flush();
    fireEvent.click(screen.getByText('关闭'),{detail:1});const exit=papers().at(-1)!;
    act(()=>vi.advanceTimersByTime(60));
    fireEvent.click(screen.getByText('关闭'),{detail:1});
    fireEvent.click(screen.getByText('关闭'),{detail:0});
    preference(true);act(()=>vi.advanceTimersByTime(300));
    expect(close).toHaveBeenCalledTimes(1);expect(exit.finish).toHaveBeenCalledTimes(1);
    expect(exit.cancel).not.toHaveBeenCalled();expect(papers()).toHaveLength(2);
  });
  it("a new entry releases an already held exit and owns all later callbacks",()=>{
    const view=render(<Harness entry={sourcePaperEntry(undefined,1)}/>);flush();
    fireEvent.click(screen.getByText('关闭'),{detail:1});const exit=papers().at(-1)!;
    act(()=>vi.advanceTimersByTime(180));expect(close).toHaveBeenCalledTimes(1);
    view.rerender(<Harness entry={sourcePaperEntry(undefined,1)}/>);flush();
    expect(exit.cancel).toHaveBeenCalledTimes(1);expect(papers()).toHaveLength(3);
    expect(papers().at(-1)!.options).toMatchObject({duration:300,fill:'none'});
    expect(papers().at(-1)!.frames[0].transform).toContain('28px');
    act(()=>vi.advanceTimersByTime(300));expect(close).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('关闭'),{detail:1});act(()=>vi.advanceTimersByTime(180));
    expect(close).toHaveBeenCalledTimes(2);
  });
  it("unmount invalidates old exit callbacks",()=>{
    const view=render(<Harness entry={sourcePaperEntry(undefined,1)}/>);flush();fireEvent.click(screen.getByText('关闭'),{detail:1});
    view.unmount();act(()=>vi.advanceTimersByTime(300));expect(close).not.toHaveBeenCalled();
  });
  it("runtime reduce immediately completes an exiting modal",()=>{
    render(<Harness entry={sourcePaperEntry(undefined,1)}/>);flush();fireEvent.click(screen.getByText('关闭'),{detail:1});
    const exit=papers().at(-1)!;
    preference(true);expect(close).toHaveBeenCalledTimes(1);expect(exit.finish).toHaveBeenCalledTimes(1);
    expect(exit.cancel).not.toHaveBeenCalled();act(()=>vi.advanceTimersByTime(300));expect(close).toHaveBeenCalledTimes(1);
  });
  it("repeated full-text operations animate only the edge and already visible tint",()=>{
    render(<Harness entry={sourcePaperEntry(undefined,1)}/>);flush();
    for(let i=0;i<3;i++){fireEvent.click(screen.getByText('全文'),{detail:1});flush();}
    expect(papers()).toHaveLength(1);
    expect(clips.filter(c=>c.node.dataset.testid==='edge'&&c.options.duration===240)).toHaveLength(3);
    expect(clips.filter(c=>c.node.dataset.segmentId==='line')).toHaveLength(3);
  });
  it("typing, touch reading and wheel stop the decoration at the base final state",()=>{
    const view=render(<Harness entry={sourcePaperEntry(undefined,1)}/>);flush();
    fireEvent.focusIn(screen.getByLabelText('查找'));expect(papers()[0].cancel).toHaveBeenCalled();
    view.rerender(<Harness entry={sourcePaperEntry(undefined,1)}/>);flush();fireEvent.touchMove(screen.getByTestId('paper'));expect(papers()[1].cancel).toHaveBeenCalled();
  });
  it("a reader that focuses evidence immediately moves its edge without moving text",()=>{
    render(<Harness edgeOnly entry={sourcePaperEntry(undefined,1)}/>);flush();expect(papers()).toHaveLength(0);expect(clips).toHaveLength(1);
  });
});
