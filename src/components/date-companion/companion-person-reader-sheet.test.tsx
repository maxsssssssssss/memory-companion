import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceInsert, type ReaderSource } from './companion-person-reader-sheet';
import { sourcePaperEntry } from './source-paper-motion';

const source:ReaderSource={id:'evidence',recordTitle:'虚构的见面',date:'2026-11-19',presentation:'direct_quote',state:'ok',text:'一起看那本相册。',speaker:'我',subject:'both',time:'0:12',segmentId:'line',lines:[{id:'line',uploadId:'upload',startSeconds:12,endSeconds:18,text:'一起看那本相册。',speakerId:'self'}]};
let frames:Map<number,FrameRequestCallback>,frameId:number;
let animations:{element:HTMLElement;options:KeyframeAnimationOptions;cancel:ReturnType<typeof vi.fn>}[];
function flush(){act(()=>{const list=[...frames.values()];frames.clear();list.forEach(cb=>cb(16));});}
const whole=()=>animations.filter(a=>a.element.tagName==='DIALOG'&&a.options.duration===300);
describe('person source paper layers',()=>{
  beforeEach(()=>{
    frames=new Map();frameId=0;animations=[];history.replaceState({},'',location.pathname);
    vi.stubGlobal('matchMedia',()=>Object.assign(new EventTarget(),{matches:false}));
    vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{frames.set(++frameId,cb);return frameId;});
    vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
    vi.stubGlobal('CSS',{escape:(value:string)=>value});
    Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.open=true;}});
    Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.open=false;}});
    Object.defineProperty(HTMLElement.prototype,'animate',{configurable:true,value:function(this:HTMLElement,_frames:Keyframe[],options:KeyframeAnimationOptions){const a={element:this,options,cancel:vi.fn()};animations.push(a);return a;}});
  });
  afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();delete (HTMLElement.prototype as unknown as {animate?:unknown}).animate;});
  it('keeps reflection attribution on the source and transcript layers and never invents a recording for a fragment',()=>{
    const reflection = {...source,sourceOrigin:'user_reflection' as const,sourceStatement:'依据你保存的自述',speaker:null,subjectLabel:'小夏'};
    const view=render(<SourceInsert material={{sources:[reflection]}} mode="source" onTranscript={vi.fn()} onBack={vi.fn()}/>);
    expect(screen.getByText('保存的自述')).toBeVisible();
    expect(screen.getByText('依据你保存的自述')).toBeVisible();
    expect(screen.getByText('内容归属 · 小夏')).toBeVisible();
    expect(screen.queryByText('保存的原话')).toBeNull();
    view.rerender(<SourceInsert material={{sources:[reflection]}} mode="transcript" sourceId={source.id} onTranscript={vi.fn()} onBack={vi.fn()}/>);
    expect(screen.getByText(/依据你保存的自述/)).toBeVisible();
    view.rerender(<SourceInsert material={{sources:[{...reflection,lines:[],segmentId:null}]}} mode="source" onTranscript={vi.fn()} onBack={vi.fn()}/>);
    expect(screen.queryByRole('button',{name:/查看完整文字稿/})).toBeNull();
    expect(screen.getByText(reflection.text!)).toBeVisible();
  });
  it('repeats explicit opens on a retained instance, while late data and retries never replay the whole sheet',()=>{
    const base={material:{sources:[source]},mode:'source' as const,onTranscript:vi.fn(),onBack:vi.fn()};
    let entry=sourcePaperEntry(undefined,1);const view=render(<SourceInsert {...base} entry={entry}/>);const dialog=screen.getByRole('dialog');flush();
    view.rerender(<SourceInsert {...base} entry={entry} notice={<p>读取失败，请重试</p>}/>);flush();
    view.rerender(<SourceInsert {...base} entry={entry}/>);flush();expect(whole()).toHaveLength(1);
    for(let i=0;i<2;i++){entry=sourcePaperEntry(undefined,1);view.rerender(<SourceInsert {...base} entry={entry}/>);flush();expect(screen.getByRole('dialog')).toBe(dialog);}
    expect(whole()).toHaveLength(3);
  });
  it('goes deeper and back three times with immediate stable evidence focus and the original source read point',()=>{
    const entry=sourcePaperEntry(undefined,1),onTranscript=vi.fn(),onBack=vi.fn();
    const base={material:{sources:[source]},entry,onTranscript,onBack};
    const view=render(<SourceInsert {...base} mode='source'/>);flush();
    for(let i=0;i<3;i++){
      const port=document.querySelector<HTMLElement>('[data-insert-scroll]')!;port.scrollTop=77;
      fireEvent.click(screen.getByRole('button',{name:/查看完整文字稿/}),{detail:1});
      view.rerender(<SourceInsert {...base} mode='transcript' sourceId='evidence'/>);flush();
      expect(document.querySelector('[data-segment-id="line"]')).toHaveFocus();
      fireEvent.click(screen.getByRole('button',{name:/返回来源/}),{detail:1});
      view.rerender(<SourceInsert {...base} mode='source'/>);flush();
      expect(screen.getByRole('button',{name:/查看完整文字稿/})).toHaveFocus();
      expect(document.querySelector<HTMLElement>('[data-insert-scroll]')!.scrollTop).toBe(77);
    }
    expect(whole()).toHaveLength(1);expect(onTranscript).toHaveBeenCalledTimes(3);expect(onBack).toHaveBeenCalledTimes(3);
    expect(animations.filter(a=>a.element.hasAttribute('data-source-paper-edge')&&a.options.duration===240)).toHaveLength(6);
  });
  it('history restoration has no active entry and does not block a later pointer open',()=>{
    const base={material:{sources:[source]},onTranscript:vi.fn(),onBack:vi.fn(),mode:'source' as const};
    const view=render(<SourceInsert {...base}/>);flush();expect(whole()).toHaveLength(0);
    view.rerender(<SourceInsert {...base} entry={sourcePaperEntry(undefined,0)}/>);flush();expect(whole()).toHaveLength(0);
    view.rerender(<SourceInsert {...base} entry={sourcePaperEntry(undefined,1)}/>);flush();expect(whole()).toHaveLength(1);
  });
});
