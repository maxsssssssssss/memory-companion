"use client";

import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { containBookModalScroll } from "./book-modal-scroll";
import { useSourcePaperMotion, type SourcePaperEntry } from "./source-paper-motion";
import paperStyles from "./source-paper-motion.module.css";
import type { DateCompanionMemorySubject, SourceRefVM, TranscriptLineVM } from "@/lib/domain/date-companion";
import { CompanionTranscript } from "./companion-transcript";

export type ReaderSource = {
  id: string;
  recordTitle: string;
  date: string;
  presentation: SourceRefVM["presentation"];
  sourceOrigin?: SourceRefVM["sourceOrigin"];
  sourceStatement?: string;
  state: "ok" | "mismatch" | "pending" | "withdrawn";
  text: string | null;
  speaker: string | null;
  subject: DateCompanionMemorySubject;
  subjectLabel?: string;
  time: string | null;
  segmentId: string | null;
  lines: TranscriptLineVM[];
  fragmentNote?: string;
};
type Source = ReaderSource;
const labels: Record<Source["subject"], string> = { self: "我", companion: "Ta", both: "我们", unknown: "暂不确定" };
const day = (value: string) => value.slice(0, 10).replaceAll("-", ".");
export function verifiedWords(source: Source) {
  return source.state === "ok" && Boolean(source.text) && source.presentation === "direct_quote" &&
    (!source.sourceOrigin || source.sourceOrigin === "direct_conversation");
}
function Arrow() { return <span className="pa-arrow" aria-hidden="true">→</span>; }

/** Reserve the source's reading structure, without placing unverified words or
 * attribution in the DOM. The bars reuse the existing paper loading rhythm. */
export function SourceReadLoading({ count=1 }: { count?:number }) {
  return <div data-person-source-loading>{Array.from({length:Math.max(1,count)},(_,index)=><section key={index} className="pa-evidence pa-source-loading">
    {index===0 ? <p className="pa-note">正在核对这条来源…</p> : <div className="pa-source-loading-label prep-opening-ink" aria-hidden="true"><i /></div>}
    <div aria-hidden="true">
      <div className="pa-source-loading-quote prep-opening-ink"><i /><i /></div>
      <div className="pa-source-meta pa-source-loading-meta prep-opening-ink">
        <i /><i /><i className="pa-source-loading-action" />
      </div>
      <div className="pa-citation pa-source-loading-citation prep-opening-ink"><i /><i /></div>
    </div>
  </section>)}</div>;
}

function SourceEvidence({source, onTranscript}: {source: Source; onTranscript: (id: string, detail: number) => void}) {
  if(source.state==="withdrawn") return <section className="pa-evidence"><h3>来源已撤回</h3><p>这段依据已停止展示。</p></section>;
  const direct = verifiedWords(source);
  const readable = Boolean(source.text?.trim());
  const linked = source.state==="ok" && source.segmentId && source.lines.some(line=>line.id===source.segmentId);
  let tag = direct ? "保存的原话" : source.presentation === "suggestion" ? "根据原话整理的建议" : "根据原话整理";
  if (source.state==="mismatch" || source.state==="pending") tag="已保存的来源片段";
  if (source.sourceOrigin==="user_reflection") tag="保存的自述";
  if (source.sourceOrigin==="unknown") tag="已保存的依据";
  return <section className="pa-evidence"><span className="pa-evidence-type">{tag}</span>
    {readable && (direct ? <blockquote>“{source.text}”</blockquote> : <p className="pa-prose">{source.text}</p>)}
    {source.state==="mismatch" && <p className="pa-note">这条记录与本机文字稿不一致，暂时无法定位到原句。</p>}
    {source.state==="pending" && <p className="pa-note">说话人身份待核对。</p>}
    {!readable && source.state==="ok" && <p className="pa-note">这条来源暂时没有可核对的原文。</p>}
    <div className="pa-source-meta">
      {source.sourceOrigin && source.sourceOrigin!=="direct_conversation" && source.sourceStatement && <span>{source.sourceStatement}</span>}
      {direct && <b>{source.speaker || "未提供可核对的署名"}</b>}
      <time dateTime={source.date}>{day(source.date)}</time>{source.time&&<span>{source.time}</span>}
      {linked && <button type="button" className="pa-text" data-return-key={"full-"+source.id} data-person-reading-key={"full-"+source.id} onClick={e=>onTranscript(source.id,e.detail)}>查看完整文字稿 <Arrow /></button>}
    </div>
    <div className="pa-citation"><span>{source.recordTitle}</span><span>内容归属 · {source.subjectLabel ?? labels[source.subject]}</span></div>
    {!linked && readable && source.state==="ok" && <small className="pa-note">{source.fragmentNote || "本机只保存了这段来源。"}</small>}
  </section>;
}

export function SourceInsert({material,sourceId,mode,onTranscript,onBack,notice,readingScope,entry,loading=false}: {
  material: {sources: Source[]}; notice?: ReactNode; readingScope?:string; loading?:boolean;
  entry?:SourcePaperEntry|null;
  sourceId?:string|null; mode:"source"|"transcript"; onTranscript:(sourceId:string)=>void; onBack:()=>void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const paper = useRef<HTMLDialogElement>(null);
  const edge = useRef<HTMLSpanElement>(null);
  const title=useId();
  const previous=useRef(mode);
  const lastSource=useRef(sourceId);
  const readAt=useRef(0);
  const pendingLayer=useRef<{direction:1|-1;detail:number}|null>(null);
  const content=useRef<HTMLDivElement>(null);
  const segment=material.sources.find(s=>s.id===sourceId && s.state==="ok" && s.segmentId && s.lines.some(l=>l.id===s.segmentId));
  const full=mode==="transcript" && Boolean(segment);
  const readingTranscript=mode==="transcript";
  const pointKey=JSON.stringify([readingScope,mode,sourceId ?? ""]);
  const readable=!notice && material.sources.length>0;
  function rememberInsert(focus=document.activeElement) {
    if(!readingScope || !readable || !content.current) return;
    const element=focus instanceof HTMLElement ? focus : undefined;
    const point={key:pointKey,top:content.current.scrollTop,focus:element?.dataset.returnKey,segment:element?.dataset.segmentId};
    history.replaceState({...history.state,personBookInsertPoint:point},"");
  }
  useLayoutEffect(()=>{
    const d=dialog.current;
    if(!d) return;
    d.showModal();
    const release=containBookModalScroll(d);
    return ()=>{if(d.open)d.close();release();};
  },[]);
  const decoration=useSourcePaperMotion({paper,edge,active:true,entry});
  useLayoutEffect(()=>{
    const scroller=content.current;
    // Forward navigation and copied links can select a transcript without
    // invoking the original button in this component instance.
    if(mode==="transcript" && sourceId) lastSource.current=sourceId;
    if(mode==="transcript") decoration.settle();
    if(mode==="source" && previous.current==="transcript" && scroller){
      scroller.scrollTop=readAt.current;
      const button=scroller.querySelector<HTMLElement>('[data-return-key="full-'+CSS.escape(lastSource.current??"")+'"]');
      (button??dialog.current?.querySelector<HTMLButtonElement>("header button"))?.focus({preventScroll:true});
    }
    previous.current=mode;
    const pending=pendingLayer.current;pendingLayer.current=null;
    if(pending)decoration.layer(pending.direction,pending.detail);
  },[mode,sourceId,decoration.settle,decoration.layer]);
  useLayoutEffect(()=>{
    if(!readingScope || !readable) return;
    const point=history.state?.personBookInsertPoint;
    let frame=0;
    if(point?.key===pointKey && Number.isFinite(point.top)) {
      // The canonical transcript focuses its highlighted segment on mount.
      // A genuine prior reading point takes precedence after that commit.
      frame=requestAnimationFrame(()=>{
        const pane=content.current;
        if(!pane)return;
        const selector=point.focus ? '[data-return-key="'+CSS.escape(point.focus)+'"]'
          : point.segment ? '[data-segment-id="'+CSS.escape(point.segment)+'"]' : null;
        if(selector)pane.querySelector<HTMLElement>(selector)?.focus({preventScroll:true});
        pane.scrollTop=point.top;
      });
    }
    const save=()=>rememberInsert();
    window.addEventListener("pagehide",save);
    return ()=>{cancelAnimationFrame(frame);window.removeEventListener("pagehide",save);};
  },[pointKey,readable,readingScope]);
  const clickedBack=(detail:number)=>{
    if(mode==="transcript") {pendingLayer.current={direction:-1,detail};onBack();}
    else decoration.dismiss(onBack,detail);
  };
  return <dialog className="pa-dialog pa-source-insert" aria-labelledby={title} ref={node=>{dialog.current=node;paper.current=node;}} onCancel={e=>{e.preventDefault();clickedBack(0);}}>
    <span aria-hidden="true" ref={edge} className={paperStyles.edge} data-source-paper-edge />
    <div className="pa-insert">
      <header className="pa-insert-head"><h2 id={title}>{readingTranscript?"完整文字稿":"来源插页"}</h2><button className="pa-back" type="button" onClick={e=>void clickedBack(e.detail)}>
        {readingTranscript?"← 返回来源":"关闭插页"} {!readingTranscript && <span aria-hidden="true">×</span>}</button></header>
      <div ref={content} className="pa-insert-body" data-insert-scroll aria-busy={loading} key={full?"full":"sources"}>
        {notice ?? (full&&segment ? <><p className="pa-record-heading">{segment.recordTitle} <time>{day(segment.date)}</time>{segment.sourceOrigin && segment.sourceOrigin!=="direct_conversation" && segment.sourceStatement && <> · {segment.sourceStatement}</>}</p>
          <CompanionTranscript lines={segment.lines} highlightedSegmentId={segment.segmentId} readerTitle="完整记录" readingScrollRef={content} /></> :
          readingTranscript ? <p className="pa-note">当前无法定位到对应原句。返回来源可以核对仍可用的片段。</p> :
          material.sources.length ? material.sources.map(s=><SourceEvidence key={s.id} source={s} onTranscript={(id,detail)=>{lastSource.current=id;readAt.current=content.current?.scrollTop??0;rememberInsert();decoration.settle();pendingLayer.current={direction:1,detail};onTranscript(id);}}/>) :
          <p>暂时没有可核对的来源。</p>)}
      </div>
    </div>
  </dialog>;
}
