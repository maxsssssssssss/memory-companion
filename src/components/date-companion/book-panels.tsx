"use client";

import {
  createContext, type ReactNode, type RefObject, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState
} from "react";
import { createPortal } from "react-dom";

import type { DateCompanionProactiveValuePresentation } from "@/lib/client/date-companion-proactive-value";
import type { DateCompanionMemorySubject, InteractionVM, RecapItemVM, SourceRefVM, TranscriptLineVM } from "@/lib/domain/date-companion";

import { CompanionTranscript, formatTimestamp, type TranscriptChapterPresentation } from "./companion-transcript";
import styles from "./book-panels.module.css";
import { containBookModalScroll } from "./book-modal-scroll";
import { sourcePaperEntry, useSourcePaperMotion, type SourcePaperEntry } from "./source-paper-motion";
import paperStyles from "./source-paper-motion.module.css";
import { PaperChoiceInk, usePaperChoiceMotion } from "./paper-state-motion";

type ReturnPoint = { element: HTMLElement; x: number; y: number; selection?: [number, number, "forward" | "backward" | "none"]; innerScroll?: number };
type PanelContext = {
  meetingTitle: string;
  lines: readonly TranscriptLineVM[];
  full: boolean;
  speakerLabel: (speakerId?: string, segmentId?: string) => string;
  open: (id?: string, trigger?: HTMLElement, editor?: HTMLTextAreaElement | null, detail?: number) => void;
};
const BookContext = createContext<PanelContext | null>(null);
export const useBookPanels = () => useContext(BookContext);

// A source reader can sit above a note or the memory booklet. Keep the page
// locked until the last book dialog leaves, including route/unmount cleanup.
const pageScrollLocks = new Set<symbol>();
let previousPageOverflow: {body:string; root:string} | null = null;
export function lockBookPageScroll() {
  const token = Symbol("book-dialog");
  if (!pageScrollLocks.size) {
    previousPageOverflow = {body:document.body.style.overflow,root:document.documentElement.style.overflow};
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
  }
  pageScrollLocks.add(token);
  return () => {
    if (!pageScrollLocks.delete(token) || pageScrollLocks.size || !previousPageOverflow) return;
    document.body.style.overflow = previousPageOverflow.body;
    document.documentElement.style.overflow = previousPageOverflow.root;
    previousPageOverflow = null;
  };
}

function remember(element: HTMLElement, position?: {x: number; y: number}): ReturnPoint {
  const point = {element, x: position?.x ?? window.scrollX, y: position?.y ?? window.scrollY};
  if (!(element instanceof HTMLTextAreaElement)) return point;
  return {...point, selection:[element.selectionStart,element.selectionEnd,element.selectionDirection], innerScroll:element.scrollTop};
}

function restore(point?: ReturnPoint | null) {
  if (!point?.element.isConnected) return;
  point.element.focus({preventScroll:true});
  if (point.element instanceof HTMLTextAreaElement && point.selection) {
    point.element.setSelectionRange(...point.selection);
    point.element.scrollTop = point.innerScroll ?? 0;
  }
  window.scrollTo({left:point.x, top:point.y, behavior:"instant"});
}

// Motion Prompt #050 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#050
// Book adaptation: the whole readable sheet comes from the existing right-hand
// direction, 32px / 310ms in and 32px / 200ms out, without scaling its text.
function useBookAppendixMotion(paper:RefObject<HTMLDialogElement|null>,active:boolean,entry?:SourcePaperEntry) {
  const running=useRef<Animation|null>(null);
  const frame=useRef(0),generation=useRef(0);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const closing=useRef<(()=>void)|null>(null);
  const played=useRef<SourcePaperEntry|null>(null);
  const reduced=()=>window.matchMedia?.("(prefers-reduced-motion: reduce)").matches??false;
  const cancel=useCallback(()=>{
    generation.current++;
    cancelAnimationFrame(frame.current);frame.current=0;
    if(timer.current)clearTimeout(timer.current);timer.current=null;
    closing.current=null;
    running.current?.cancel();running.current=null;
  },[]);
  const dismiss=useCallback((close:()=>void,detail:number)=>{
    if(closing.current){closing.current();return;}
    const node=paper.current;
    const transform=node?getComputedStyle(node).transform:"none";
    cancel();
    if(!active||!detail||reduced()||!node?.animate){close();return;}
    const owner=generation.current;
    const animation=node.animate([{transform,opacity:1},{transform:"translateX(32px)",opacity:0}],{
      duration:200,easing:"cubic-bezier(.23,1,.32,1)",fill:"forwards"
    });
    running.current=animation;
    let requested=false;
    const finish=()=>{
      if(owner!==generation.current||requested)return;
      requested=true;
      if(timer.current)clearTimeout(timer.current);timer.current=null;
      // Keep the last frame until the native dialog actually leaves. Cancelling
      // here would reveal a complete sheet for one frame before React unmounts.
      try{animation.finish();}catch{/* Closing does not depend on WAAPI events. */}
      close();
    };
    closing.current=finish;
    timer.current=setTimeout(finish,200);
  },[active,cancel,paper]);
  useLayoutEffect(()=>{
    if(!active)return;
    const node=paper.current,media=window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const settle=()=>{if(closing.current)closing.current();else cancel();};
    const preference=()=>{if(media?.matches)settle();};
    const pointer=(event:Event)=>{
      const target=event.target instanceof HTMLElement?event.target:null;
      if(!closing.current&&!target?.closest('[data-book-appendix-return]'))cancel();
    };
    const focus=(event:Event)=>{if((event.target as HTMLElement)?.matches('input,textarea,[contenteditable=true]'))settle();};
    media?.addEventListener?.("change",preference);
    node?.addEventListener("keydown",settle,true);
    node?.addEventListener("wheel",settle,{passive:true});
    node?.addEventListener("touchmove",settle,{passive:true});
    node?.addEventListener("pointerdown",pointer,true);
    node?.addEventListener("focusin",focus);
    window.addEventListener("popstate",settle);
    return()=>{
      media?.removeEventListener?.("change",preference);
      node?.removeEventListener("keydown",settle,true);
      node?.removeEventListener("wheel",settle);
      node?.removeEventListener("touchmove",settle);
      node?.removeEventListener("pointerdown",pointer,true);
      node?.removeEventListener("focusin",focus);
      window.removeEventListener("popstate",settle);
      cancel();
    };
  },[active,cancel,paper]);
  useLayoutEffect(()=>{
    if(!active||!entry||played.current===entry)return;
    cancel();
    frame.current=requestAnimationFrame(()=>{
      played.current=entry;
      if(!entry.pointer||reduced()||!paper.current?.animate)return;
      running.current=paper.current.animate([{transform:"translateX(32px)"},{transform:"translateX(0)"}],{
        duration:310,easing:"cubic-bezier(.23,1,.32,1)"
      });
    });
    return()=>cancelAnimationFrame(frame.current);
  },[active,cancel,entry,paper]);
  return {dismiss,finishClosing:()=>{if(!closing.current)return false;closing.current();return true;}};
}

function PaperDialog({label, variant, onDismiss, onDismissStart, children,entry}:{
  label:string; variant:"note"|"book"|"transcript"; onDismiss:()=>void; onDismissStart?:()=>void; children:ReactNode|((dismiss:(detail:number)=>void)=>ReactNode);entry?:SourcePaperEntry;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const edge=useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const unlock = variant==='transcript'?()=>{}:lockBookPageScroll();
    // showModal owns initial focus, including when the same native dialog reopens.
    // Let it choose the cited line without repeating the transcript's scroll step.
    if (variant === "transcript") {
      const citedLine = dialog.querySelector<HTMLElement>('[data-segment-id][aria-current="true"]');
      citedLine?.setAttribute("autofocus", "");
    }
    try { dialog.showModal(); }
    catch (error) { unlock(); throw error; }
    const contain=variant==='transcript'?containBookModalScroll(dialog):()=>{};
    return () => { if (dialog.open) dialog.close(); contain();unlock(); };
  }, []);
  const decoration=useSourcePaperMotion({paper:ref,edge,active:variant==='transcript',entry,edgeOnly:true});
  const appendix=useBookAppendixMotion(ref,variant==='book',entry);
  const dismiss=(detail:number)=>{
    onDismissStart?.();
    if(variant==='transcript') decoration.dismiss(onDismiss,detail);
    else if(variant==='book') appendix.dismiss(onDismiss,detail);
    else onDismiss();
  };
  return createPortal(
    <dialog ref={ref} className={styles.surface} data-book-panel={variant} aria-label={label}
      onClickCapture={variant==='book'?event=>{if(appendix.finishClosing()){event.preventDefault();event.stopPropagation();}}:undefined}
      onCancel={event=>{event.preventDefault(); dismiss(0);}}
      onClick={event=>{
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dismiss(event.detail);
      }}>
      {variant==='transcript'&&<span ref={edge} className={paperStyles.edge} data-source-paper-edge aria-hidden="true"/>}
      {typeof children==='function'?children(dismiss):children}
    </dialog>,document.body);
}

function savedLines(sources:readonly SourceRefVM[], uploadId:string) {
  const lines = new Map<string,TranscriptLineVM>();
  for (const source of sources) {
    if (source.uploadId !== uploadId || source.presentation !== "direct_quote" || source.segmentIds.length !== 1 || !source.quote.trim()) continue;
    const [id] = source.segmentIds;
    if (!lines.has(id)) lines.set(id, {id,uploadId,speakerId:source.speakerId,
      startSeconds:source.startSeconds,endSeconds:source.endSeconds,text:source.quote});
  }
  return [...lines.values()];
}

export function BookPanelsProvider({interaction, meetingTitle=interaction?.title ?? "单次复盘", chapters, initialSegmentId, onReturnToSourceOrigin, speakerLabel, sources = [], children}:{
  interaction:InteractionVM|null; meetingTitle?:string; chapters?:TranscriptChapterPresentation[]; initialSegmentId?:string|null;
  onReturnToSourceOrigin?:()=>void;
  speakerLabel:(id?:string, segmentId?:string, line?:TranscriptLineVM)=>string; sources?:readonly SourceRefVM[]; children:ReactNode;
}) {
  const uploadId = interaction?.sourceUploadId ?? interaction?.uploadIds[0] ?? interaction?.id ?? "";
  const full = Boolean(interaction?.transcript.some(line => line.uploadId === uploadId));
  const lines = useMemo(()=>{
    const available = full ? interaction!.transcript : savedLines(sources,uploadId);
    return available.filter(line=>line.uploadId===uploadId).map(line=>({...line,speakerLabel:speakerLabel(line.speakerId, line.id, line)}));
  },[full,interaction?.transcript,sources,speakerLabel,uploadId]);
  const [reader,setReader] = useState<{id?:string; initial?:boolean;entry?:SourcePaperEntry}|null>(null);
  const lastLink = useRef<string|null>(null);
  const mark = useRef<ReturnPoint | null>(null);
  const urlBeforeRead = useRef("");
  const editorPosition = useRef<{field:HTMLTextAreaElement;x:number;y:number}|null>(null);
  useEffect(()=>{
    const track = (event:Event) => {
      const field = event.target;
      if (field instanceof HTMLTextAreaElement && field.closest("[data-book-item]")) {
        editorPosition.current = {field,x:window.scrollX,y:window.scrollY};
      }
    };
    for (const name of ["focusin","input","keyup","pointerup"]) document.addEventListener(name,track,true);
    return ()=>{for (const name of ["focusin","input","keyup","pointerup"]) document.removeEventListener(name,track,true);};
  },[]);
  useEffect(()=>{
    if (!initialSegmentId || lastLink.current===initialSegmentId || !lines.some(line=>line.id===initialSegmentId)) return;
    lastLink.current=initialSegmentId;
    setReader({id:initialSegmentId,initial:true});
  },[initialSegmentId,lines]);
  function open(id?:string,trigger?:HTMLElement,editor?:HTMLTextAreaElement|null,detail=0) {
    if (!lines.length || (id && !lines.some(line=>line.id===id))) return;
    const origin = editor || trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    if (origin) mark.current = remember(origin, origin === editorPosition.current?.field ? editorPosition.current : undefined);
    const url = new URL(location.href);
    urlBeforeRead.current=url.pathname+url.search+url.hash;
    if (id) {
      url.searchParams.set("segment",id);
      url.hash="full-transcript";
      window.history.replaceState(window.history.state,"",url);
    }
    setReader({id,entry:sourcePaperEntry(trigger,detail)});
  }
  function close() {
    if (reader?.initial && onReturnToSourceOrigin) {
      setReader(null);
      onReturnToSourceOrigin();
      return;
    }
    const previous=urlBeforeRead.current;
    if (previous) window.history.replaceState(window.history.state,"",previous);
    else if (location.hash==="#full-transcript") {
      const url=new URL(location.href);
      url.searchParams.delete("segment");
      url.hash="";
      window.history.replaceState(window.history.state,"",url);
    }
    setReader(null);
    requestAnimationFrame(()=>{
      if (mark.current) restore(mark.current);
      else document.querySelector<HTMLButtonElement>("[data-book-transcript-entry]")?.focus({preventScroll:true});
    });
  }
  return <BookContext.Provider value={{lines,full,speakerLabel,open,meetingTitle}}>{children}
    {reader && <PaperDialog variant="transcript" label={full?"完整文字稿":"已保存的来源片段"} onDismiss={close} entry={reader.entry}>{dismiss=><>
      <header className={styles.readerHead}><button type="button" onClick={e=>dismiss(e.detail)} className={styles.returnButton}>← 返回刚才的位置</button></header>
      <CompanionTranscript scope={full ? "full" : "saved"} lines={lines} chapters={full?chapters:[]} highlightedSegmentId={reader.id} readerTitle={full?"完整文字稿":"已保存的来源片段"}/>
    </>}</PaperDialog>}
  </BookContext.Provider>;
}

export function BookTranscriptButton({className}: {className?: string}) {
  const book=useBookPanels();
  if (!book?.lines.length) return null;
  return <button type="button" className={className} data-book-transcript-entry aria-haspopup="dialog" onClick={event=>book.open(undefined,event.currentTarget,null,event.detail)}>{book.full?"完整文字稿":"已保存的来源片段"}</button>;
}

const chineseWords = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("zh-CN",{granularity:"word"}) : null;

function QuoteText({text}:{text:string}) {
  const phrases = useMemo(() => {
    const parts:string[]=[];
    for (const clause of text.match(/[^，。；！？、]+[，。；！？、]*|[，。；！？、]+/gu) ?? [text]) {
      if (!chineseWords || Array.from(clause).length <= 8) { parts.push(clause); continue; }
      for (const word of chineseWords.segment(clause)) {
        if (!word.isWordLike && parts.length && /^[，。；！？、）】》”’]+$/u.test(word.segment)) parts[parts.length-1]+=word.segment;
        else parts.push(word.segment);
      }
    }
    return parts;
  },[text]);
  return <blockquote>{phrases.map((part,index)=><span className={styles.phrase} key={index}>{part}</span>)}</blockquote>;
}

export function BookSource({source,onReturnFocus,linkableIds,onOpenSource}:{
  source:SourceRefVM; onReturnFocus?:HTMLTextAreaElement|null;
  linkableIds?:ReadonlySet<string>; onOpenSource?:(id:string)=>boolean;
}) {
  const book=useBookPanels();
  if (!book) return null;
  const basis=source.segmentIds.flatMap(id=>book.lines.filter(line=>line.uploadId===source.uploadId && line.id===id));
  const links=linkableIds ? basis.filter(line=>linkableIds.has(line.id)) : basis;
  const exact=source.presentation==="direct_quote" && Boolean(source.quote.trim())
    && (!basis.length || (basis.length===source.segmentIds.length && basis.map(line=>line.text).join(" ").trim()===source.quote.trim()));
  const changed=source.presentation==="direct_quote" && basis.length>0 && !exact;
  const kind=exact?"原话片段":source.presentation==="suggestion"?"根据原话整理的建议":source.presentation==="derived_summary"?"根据原话整理":changed?"已保存片段 · 与当前文字稿不同":"待核对的文字";
  return <figure className={styles.source} data-book-source={source.id} data-source-kind={exact?"direct_quote":source.presentation==="suggestion"?"suggestion":"derived_summary"}>
    {exact?<QuoteText text={source.quote}/>:<><small>{kind}</small><p>{source.quote}</p></>}
    <figcaption>
      {exact && <span>{book.speakerLabel(source.speakerId, source.segmentIds[0])} · <time>{formatTimestamp(source.startSeconds)}</time></span>}
      {links.map(line=><button key={line.id} type="button" className={styles.textButton} data-source-segment={line.id}
        onClick={event=>{
          if (onOpenSource && !onOpenSource(line.id)) return;
          const editor=event.currentTarget.closest("[data-book-item]")?.querySelector<HTMLTextAreaElement>("textarea");
          book.open(line.id,event.currentTarget,onReturnFocus || (editor?.getClientRects().length ? editor : null),event.detail);
        }}>{!exact?"查看依据":book.full?"查看文字稿":"核对保存的原话"}{basis.length>1 || !exact?" · "+formatTimestamp(line.startSeconds):""}</button>)}
      {!links.length && <small>{exact?"已保存的原话片段":"没有可逐字核对的片段。"}</small>}
    </figcaption>
  </figure>;
}

export function BookObservation({presentation}:{presentation:DateCompanionProactiveValuePresentation}) {
  const [open,setOpen]=useState(false);
  const [hidden,setHidden]=useState<string|null>(null);
  const mark=useRef<ReturnPoint|null>(null);
  const title=presentation.status==="ready"?"AI 观察":"原话线索";
  const dismiss=()=>{setOpen(false);requestAnimationFrame(()=>restore(mark.current));};
  return <>
    <button className={styles.noteEntry} type="button" aria-haspopup="dialog" onClick={event=>{
      mark.current=remember(event.currentTarget);setHidden(null);setOpen(true);
    }}><span aria-hidden="true">▤</span> {title}{hidden===presentation.fingerprint?"已收起 · 重新显示":""}</button>
    {open && <PaperDialog label={title} variant="note" onDismiss={dismiss}>
      <header className={styles.noteHead}><h2>{title}</h2><button className={styles.close} type="button" aria-label={"关闭"+title} onClick={dismiss}>×</button></header>
      <div className={styles.noteContent}>
        <p className={styles.observation}>{presentation.observation}</p>
        {presentation.sources.map(source=><BookSource key={source.uploadId+":"+source.id} source={source}/>)}
        <details className={styles.caution}><summary>{presentation.status==="ready"?"观察边界":"线索边界"}</summary><p>{presentation.caution}</p></details>
        <button className={styles.textButton} type="button" onClick={()=>{setHidden(presentation.fingerprint);dismiss();}}>觉得不太准确，先收起</button>
      </div>
    </PaperDialog>}
  </>;
}

const subjects:ReadonlyArray<[DateCompanionMemorySubject,string]>=[["self","我"],["companion","Ta"],["both","我们"],["unknown","暂不确定"]];

function MemorySubjectTabs({subject,counts,groupId,onChange}:{subject:DateCompanionMemorySubject;counts:Record<DateCompanionMemorySubject,number>;groupId:string;onChange:(subject:DateCompanionMemorySubject)=>void}) {
  const tabs=useRef<HTMLDivElement>(null);
  const choice=usePaperChoiceMotion({container:tabs,value:subject,scope:groupId});
  const placed=useRef(false);
  const placeAfterOpening=useCallback(()=>{
    if(placed.current)return;
    const host=tabs.current,mark=choice.ink.current,target=host?.querySelector<HTMLElement>('[aria-selected="true"]');
    if(!host||!mark||!target)return;
    const box=target.getBoundingClientRect(),root=host.getBoundingClientRect();
    if(!box.width||!box.height)return;
    // Child layout effects run while the parent native dialog is still closed.
    // Prime only its static mark once showModal has made the geometry readable;
    // the shared controller still owns every later selection and interruption.
    mark.style.left=`${box.left-root.left+host.scrollLeft-host.clientLeft}px`;
    mark.style.top=`${box.bottom-root.top+host.scrollTop-host.clientTop-4}px`;
    mark.style.width=`${box.width}px`;
    mark.style.visibility="visible";
    placed.current=true;
  },[choice.ink]);
  useLayoutEffect(()=>{
    const frame=requestAnimationFrame(placeAfterOpening);
    return()=>cancelAnimationFrame(frame);
  },[placeAfterOpening]);
  return <div ref={tabs} className={styles.tabs} role="tablist" aria-label="内容归属" onPointerDownCapture={placeAfterOpening}>
    {subjects.map(([key,label],i)=><button key={key} id={groupId+key} type="button" role="tab" tabIndex={subject===key?0:-1}
      data-paper-choice-value={key} aria-selected={subject===key} aria-controls={groupId+"page"}
      onClick={event=>{if(choice.choose(key,event.detail))onChange(key);}}
      onKeyDown={event=>{
        const next=event.key==="ArrowRight"?(i+1)%4:event.key==="ArrowLeft"?(i+3)%4:event.key==="Home"?0:event.key==="End"?3:-1;
        if(next<0)return;
        event.preventDefault();const [key]=subjects[next];
        if(choice.choose(key,0))onChange(key);
        document.getElementById(groupId+key)?.focus();
      }}>{label}<small>{counts[key]}</small></button>)}
    <PaperChoiceInk inkRef={choice.ink}/>
  </div>;
}

export function BookMemory({meetingTitle,items,suggestedSubjects,status,statusLabel,controls,itemTitle,onDismiss}:{
  meetingTitle:string; items:readonly RecapItemVM[]; suggestedSubjects:ReadonlyMap<string,DateCompanionMemorySubject>;
  status:string;statusLabel:string;controls:ReactNode;itemTitle?:(item:RecapItemVM)=>string;onDismiss?:()=>void;
}) {
  const [open,setOpen]=useState(false);
  const [entry,setEntry]=useState<SourcePaperEntry>();
  const [subject,setSubject]=useState<DateCompanionMemorySubject>("self");
  const [selected,setSelected]=useState<string|null>(null);
  const mark=useRef<ReturnPoint|null>(null);
  const returnFrame=useRef(0),operation=useRef(0);
  useEffect(()=>()=>{operation.current++;cancelAnimationFrame(returnFrame.current);},[]);
  const groupId=useId();
  const dir=useRef<HTMLElement>(null);
  const completed=status==="completed";
  const owner=(source:SourceRefVM)=>source.memorySubject ?? (!completed?suggestedSubjects.get(source.id):undefined) ?? "unknown";
  const title=(item:RecapItemVM)=>itemTitle?.(item)||item.displayedText||item.title;
  // The server can maintain separate evidence snapshots for the same recorded
  // passage cited by two recap items. Its retained-subject catalog is keyed by
  // upload and segment, so the reading tabs count those original passages once.
  const unique=new Map(items.flatMap(item=>item.sources.flatMap(source=>
    (source.segmentIds.length ? source.segmentIds : [source.id])
      .map(id=>[JSON.stringify([source.uploadId,id]),source] as const))));
  const counts={self:0,companion:0,both:0,unknown:0};
  for (const source of unique.values()) counts[owner(source)]++;
  const entries=items.filter(item=>item.sources.some(source=>owner(source)===subject));
  const picked=entries.find(item=>item.id===selected)??entries[0];
  const dismiss=()=>{
    const owner=operation.current,point=mark.current;
    setOpen(false);
    returnFrame.current=requestAnimationFrame(()=>{if(owner===operation.current)restore(point);});
  };
  const result=completed && unique.size>0?`已整理 ${unique.size-counts.unknown} 条来源${counts.unknown ? `，另有 ${counts.unknown} 条归属待确认，仍留在本次复盘。`:"。"}`:statusLabel;
  return <>
    <section className={styles.memoryEntry}>
      <div><h2>长期记忆</h2><p>{statusLabel}</p></div>
      <button type="button" className={styles.textButton} aria-haspopup="dialog" onClick={event=>{
        operation.current++;cancelAnimationFrame(returnFrame.current);
        mark.current=remember(event.currentTarget);
        const first=subjects.find(([key])=>counts[key]>0)?.[0]??"self";
        if(!counts[subject])setSubject(first);
        setEntry(sourcePaperEntry(event.currentTarget,event.detail));
        setOpen(true);
      }}>{completed?"翻看长期记忆":"查看内容与归属"}</button>
    </section>
    {open && <PaperDialog variant="book" label="长期记忆" onDismiss={dismiss} onDismissStart={onDismiss} entry={entry}>{close=>
      <div className={styles.bookPaper}>
        <button className={styles.returnButton} type="button" data-book-appendix-return onClick={event=>close(event.detail)}>← 返回复盘</button>
        <header className={styles.bookHead}><p>{meetingTitle}</p><h2>长期记忆</h2><div aria-live="polite">{result}</div></header>
        <MemorySubjectTabs subject={subject} counts={counts} groupId={groupId} onChange={key=>{setSubject(key);setSelected(null);}}/>
        <div id={groupId+"page"} role="tabpanel" aria-labelledby={groupId+subject} className={styles.spread}>
          {picked ? <>
            <nav className={styles.directory} aria-label="本页目录" ref={dir}>{entries.map(item=><button key={item.id} type="button" aria-current={picked.id===item.id?"true":undefined}
              onClick={()=>{setSelected(item.id);if(matchMedia("(max-width: 640px)").matches)requestAnimationFrame(()=>document.getElementById(groupId+"reading")?.scrollIntoView({block:"start"}));}}>
              {title(item)}
            </button>)}</nav>
            <article className={styles.reading} id={groupId+"reading"}>
              {picked.sources.filter(source=>owner(source)===subject).map(source=><BookSource key={source.id} source={source}/>)}
              {entries.length>1 && <button className={styles.mobileReturn} type="button" onClick={()=>{const entry=dir.current?.querySelector<HTMLButtonElement>('[aria-current="true"]');entry?.focus();entry?.scrollIntoView({block:"center"});}}>返回目录</button>}
            </article></>:<p className={styles.empty}>这一页还没有来源。</p>}
        </div>
        <div className={styles.memoryControls}>{controls}</div>
      </div>}
    </PaperDialog>}
  </>;
}
