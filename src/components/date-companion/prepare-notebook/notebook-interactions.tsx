"use client";

import { useEffect, useLayoutEffect, useRef, useState, useId, type ReactNode, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useNotebookReducedMotion } from './notebook-handoff';
import { containBookModalScroll } from '../book-modal-scroll';
import paperStyles from '../source-paper-motion.module.css';

/** Notebook overlays keep their existing menu behavior. Reading layers share
 * one native modal below, in both the formal book and its isolated preview. */
export function NotebookOverlay({open,restoreOpen=false,title,children,footer,onClose,reading=false,fullReading=false,onReadingScroll,sourcePaper,sourceEdge}:{
  open:boolean; restoreOpen?:boolean; title:string; children:ReactNode; footer?:ReactNode;
  onClose:(detail?:number)=>void; reading?:boolean; fullReading?:boolean; onReadingScroll?:(scroll:number)=>void;
  sourcePaper?:RefObject<HTMLDivElement|null>;sourceEdge?:RefObject<HTMLSpanElement|null>;
}){
  const region=useRef<HTMLDivElement>(null),close=useRef(onClose);
  close.current=onClose;
  const titleId=useId(),reduce=useNotebookReducedMotion();
  useEffect(()=>{
    if(!open||reading)return;
    const trigger=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    region.current?.querySelector<HTMLButtonElement>('header button')?.focus({preventScroll:true});
    const keydown=(e:KeyboardEvent)=>{
      if(e.key==='Escape'){e.preventDefault();close.current();return;}
      if(e.key!=='Tab')return;
      const nodes=Array.from(region.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),[tabindex="0"]')??[]).filter(n=>!n.hidden&&n.getClientRects().length);
      const first=nodes[0],last=nodes.at(-1);
      if(!first){e.preventDefault();region.current?.focus({preventScroll:true});}
      else if(e.shiftKey&&(document.activeElement===first||document.activeElement===region.current)){e.preventDefault();last?.focus({preventScroll:true});}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus({preventScroll:true});}
    };
    document.addEventListener('keydown',keydown);
    const dialog=region.current;
    return()=>{
      document.removeEventListener('keydown',keydown);document.body.style.overflow=overflow;
      if(trigger?.isConnected&&(document.activeElement===document.body||dialog?.contains(document.activeElement)))trigger.focus({preventScroll:true});
    };
  },[open,reading]);
  if(open&&reading)return <NotebookSourceDialog titleId={titleId} title={title} onClose={onClose} paper={sourcePaper} edge={sourceEdge} fullReading={fullReading} onReadingScroll={onReadingScroll} footer={footer}>{children}</NotebookSourceDialog>;
  return <AnimatePresence>{open&&<motion.div className="prep-overlay" data-reading={reading} initial={restoreOpen?false:{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} transition={{duration:reduce?0:.14}} onMouseDown={e=>{if(e.target===e.currentTarget)close.current();}}>
    <motion.div className="prep-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={region} initial={restoreOpen?false:{y:reduce?0:8}} animate={{y:0}} exit={{y:reduce?0:4}} transition={{duration:reduce?0:.18,ease:[.22,1,.36,1]}}>
      <header className="prep-dialog-header"><h2 id={titleId}>{title}</h2><button type="button" aria-label="关闭" onClick={()=>close.current()}>×</button></header>
      <div className="prep-dialog-content" onScroll={e=>onReadingScroll?.(e.currentTarget.scrollTop)}>{children}</div>
      {footer&&<footer className="prep-dialog-footer">{footer}</footer>}
    </motion.div>
  </motion.div>}</AnimatePresence>;
}

/** Sources and full text share one native focus scope and a fixed paper top. */
function NotebookSourceDialog({titleId,title,onClose,paper,edge,fullReading,onReadingScroll,children,footer}:{
  titleId:string;title:string;onClose:(detail?:number)=>void;paper?:RefObject<HTMLDivElement|null>;edge?:RefObject<HTMLSpanElement|null>;
  fullReading:boolean;onReadingScroll?:(scroll:number)=>void;children:ReactNode;footer?:ReactNode;
}){
  const dialog=useRef<HTMLDialogElement>(null);
  useLayoutEffect(()=>{
    const node=dialog.current;if(!node)return;
    node.showModal();
    const release=containBookModalScroll(node);
    return()=>{if(node.open)node.close();release();};
  },[]);
  return <dialog ref={dialog} className="prep-overlay prep-native-source" data-reading="true" data-full-reading={fullReading} aria-labelledby={titleId}
    onCancel={e=>{e.preventDefault();onClose(0);}} onClick={e=>{if(e.target===e.currentTarget)onClose(e.detail);}}>
    <div className="prep-dialog" ref={paper}>
      <span aria-hidden="true" ref={edge} className={paperStyles.edge} data-source-paper-edge />
      <header className="prep-dialog-header"><h2 id={titleId}>{title}</h2><button type="button" aria-label="关闭" onClick={e=>onClose(e.detail)}>×</button></header>
      <div className="prep-dialog-content" onScroll={e=>onReadingScroll?.(e.currentTarget.scrollTop)}>{children}</div>
      {footer&&<footer className="prep-dialog-footer">{footer}</footer>}
    </div>
  </dialog>;
}

/** Animate only this area's actual height; never scale paper, text, or borders. */
export function NoteContent({children,duration}:{children:ReactNode,duration:number}){
  const inner=useRef<HTMLDivElement>(null);
  const [height,setHeight]=useState<number>();
  useLayoutEffect(()=>{
    const el=inner.current;if(!el)return;
    const measure=()=>setHeight(el.getBoundingClientRect().height);
    measure();const observer=new ResizeObserver(measure);observer.observe(el);return()=>observer.disconnect();
  },[]);
  return <motion.div className="prep-note-content" initial={false} animate={{height:height??'auto'}} transition={{duration,ease:[.22,1,.36,1]}}><div ref={inner}>{children}</div></motion.div>;
}

export function GrowingEditor({id,value,field,onChange,onSelect,onActions}:{id:string,value:string,field:RefObject<HTMLTextAreaElement|null>,onChange:(value:string)=>void,onSelect:(selection:[number,number])=>void,onActions?:()=>void}){
  useLayoutEffect(()=>{
    const el=field.current;if(!el)return;
    const resize=()=>{const prior=el.style.height;el.style.height='0px';const h=el.scrollHeight;el.style.height=h?`${h}px`:prior;};
    resize();let width=el.clientWidth;
    const observer=new ResizeObserver(()=>{if(width!==el.clientWidth){width=el.clientWidth;resize();}});observer.observe(el);return()=>observer.disconnect();
  },[value,field]);
  return <div className="prep-edit"><label htmlFor={id}>修改这条准备</label>{onActions&&<button type="button" className="prep-text-button" onClick={onActions}>前往保存与取消</button>}<textarea id={id} ref={field} rows={1} maxLength={500} value={value} onChange={e=>onChange(e.target.value)} onSelect={e=>onSelect([e.currentTarget.selectionStart,e.currentTarget.selectionEnd])}/></div>;
}
