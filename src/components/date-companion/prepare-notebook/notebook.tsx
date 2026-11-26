"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { animate, AnimatePresence, MotionConfig, motion } from 'motion/react';
import { GrowingEditor, NoteContent, NotebookOverlay } from './notebook-interactions';
import { useEditVisibility } from './notebook-scroll';
import { useNotebookHandoff, useNotebookReducedMotion } from './notebook-handoff';
import { sourcePaperEntry, useSourcePaperMotion, type SourcePaperEntry } from '../source-paper-motion';
import { PaperChoiceInk, PaperFeedbackMarks, usePaperChoiceMotion, usePaperFeedback } from '../paper-state-motion';
import { missingSuggestionTurn, preparationChoiceState, PreviewError, type PreparationItem, type PreparationSource, type PreviewAdapter, type PreviewDraft, type PreviewMutation, type PreviewRecord } from './model';

const scopeIdentityNotice = {
  established: '',
  none: '建立关系并核对人物后，才能参考已获准保留的长期资料。现在仍可以从自己的表达聊起。',
  loading: '正在读取人物资料…',
  unmapped: '关系人物待核对，长期人物资料暂不可用。',
  unavailable: '人物资料暂时未能读取，长期资料暂不可用。'
};
const key = () => crypto.randomUUID();
const dateLabel = (date: string) => { const parts=date.split('-'); return parts.length===3 ? `${Number(parts[1])} 月 ${Number(parts[2])} 日` : date; };
type Panel = 'history'|'scope'|'review'|'options'|'delete'|'clues'|'account'|'product'|'sources'|'reader'|null;
type ReaderState = 'loading'|'success-empty'|'success-full'|'error';
function Arrow({down=false}:{down?:boolean}) {return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={down?{transform:'rotate(90deg)'}:undefined}><path d="m9 5 7 7-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;}
function Check(){return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>;}

export type DiscussionFocusRequest = {adapter:PreviewAdapter; id:string|null; target:'history'|'heading'|'released'};

export function Notebook({adapter,embedded=false,formalMode=false,previewProductOrigin='',recordHref,onVisitSource,onRetryMaterials,discussionFocus}:{adapter:PreviewAdapter;discussionFocus?:RefObject<DiscussionFocusRequest|null>;embedded?:boolean;formalMode?:boolean;previewProductOrigin?:string;recordHref?:(source:PreparationSource)=>string;onVisitSource?:(href:string)=>void;onRetryMaterials?:()=>void}){
  const state=useSyncExternalStore(adapter.subscribe,adapter.getSnapshot,adapter.getSnapshot);
  const discussion=state.discussions.find(v=>v.id===state.currentDiscussionId)??null;
  const discussionId=state.currentDiscussionId;
  const draft=adapter.readDraft(discussionId);
  const [panel,setPanel]=useState<Panel>(null);
  const [sourceEntry,setSourceEntry]=useState<SourcePaperEntry|null>(null);
  const sourcePaper=useRef<HTMLDivElement>(null),sourceEdge=useRef<HTMLSpanElement>(null);
  const sourceDecoration=useSourcePaperMotion({paper:sourcePaper,edge:sourceEdge,active:panel==='sources'||panel==='reader',entry:sourceEntry});
  const pendingSourceLayer=useRef<{direction:1|-1;detail:number}|null>(null);
  const [reader,setReader]=useState<{record:PreviewRecord,source?:PreparationSource}|null>(null);
  const returnPanel=useRef<Panel>(null);
  const returnPanelScroll=useRef(0);
  const [error,setError]=useState('');
  const [conflict,setConflict]=useState(false);
  const [busy,setBusy]=useState(false);
  const [waiting,setWaiting]=useState<string|null>(null);
  const [retryOperation,setRetryOperation]=useState<string|null>(null);
  const [notice,setNotice]=useState('');
  const [unseen,setUnseen]=useState(false);
  const expandedHistory=draft.showEarlier??false;
  const historyCut=useRef({id:discussionId,index:Math.max(0,(discussion?.messages.length??0)-2),loaded:!!discussion});
  if(historyCut.current.id!==discussionId||!historyCut.current.loaded&&discussion)historyCut.current={id:discussionId,index:Math.max(0,(discussion?.messages.length??0)-2),loaded:!!discussion};
  const [scope,setScope]=useState<string[]>([]);
  const [retained,setRetained]=useState(false);
  const [review,setReview]=useState('');
  const [search,setSearch]=useState('');
  const [readerState,setReaderState]=useState<ReaderState>('success-empty');
  const [readerError,setReaderError]=useState('');
  const readerRequest=useRef(0);
  const chat=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null),left=useRef<HTMLDivElement>(null),book=useRef<HTMLElement>(null);
  const editing=useRef<HTMLTextAreaElement>(null);
  const discussionHeading=useRef<HTMLSpanElement>(null);
  const historyTrigger=useRef<HTMLButtonElement>(null);
  const localDiscussionFocus=useRef<DiscussionFocusRequest|null>(null);
  const pendingDiscussionFocus=discussionFocus??localDiscussionFocus;
  const pendingComposerFocus=useRef<HTMLButtonElement|null>(null);
  const editVisibility=useEditVisibility(left,draft.editingId);
  const latch=useRef(false),mounted=useRef(true),nearBottom=useRef(true);
  const chatMotion=useRef<{stop:()=>void}|null>(null);
  const chatMotionGeneration=useRef(0);
  const stopChatFollow=useCallback(()=>{
    // Motion stop() can synchronously tick its last value. Invalidate first so
    // that tick cannot overwrite a wheel/touch position the browser just applied.
    chatMotionGeneration.current++;
    const animation=chatMotion.current;chatMotion.current=null;animation?.stop();
  },[]);
  const activeSend=useRef<string|null>(null);
  const lastCount=useRef({id:discussionId,count:discussion?.messages.length??0});
  const restoredContext=useRef<{adapter:PreviewAdapter,id:string|null}|null>(null);
  const restoring=useRef(true);
  const resumeFocus=useRef<PreviewDraft['sourceReturn']|null>(null);
  const panelRef=useRef<Panel>(panel);panelRef.current=panel;
  const [newNote,setNewNote]=useState<string|null>(null);
  const [moreNotes,setMoreNotes]=useState(false);
  const preferReduced=useNotebookReducedMotion();
  const [keyboard,setKeyboard]=useState(false);
  const duration=preferReduced||keyboard?0:.22;
  const transition={duration,ease:[.22,1,.36,1] as [number,number,number,number]};
  const handoff=useNotebookHandoff({adapter,book,left,chat,disabled:!!preferReduced||keyboard,blocked:!!panel});
  const patch=useCallback((next:Partial<PreviewDraft>)=>adapter.writeDraft(adapter.getSnapshot().currentDiscussionId,next),[adapter]);
  const selected=discussion?.items.filter(i=>preparationChoiceState(discussion,i)==='current')??[];
  const past=discussion?.items.filter(i=>['earlier','withdrawn'].includes(preparationChoiceState(discussion,i)??''))??[];
  const tab=draft.selectedTab??'current';
  const mobileView=draft.mobileView??'preparations';
  const choiceScope=`${state.accountId}:${state.relationshipId}:${discussionId??'new'}`;
  const categoryTabs=useRef<HTMLDivElement>(null),mobileTabs=useRef<HTMLDivElement>(null);
  const categoryChoice=usePaperChoiceMotion({container:categoryTabs,value:tab,scope:choiceScope});
  const mobileChoice=usePaperChoiceMotion({container:mobileTabs,value:mobileView,scope:choiceScope});
  const saveFeedback=usePaperFeedback(choiceScope);
  // These are notebook view positions, not business state. A short/empty tab
  // must not overwrite the other tab's read point when its scroll range clamps.
  const categoryReadpoints=useRef(new Map<string,Record<string,number>>());
  const visibleNotebookView=useRef<{scope:string,tab:typeof tab,mobileView:typeof mobileView}|null>(null);
  const rememberLeft=()=>{
    const area=left.current;
    if(!area||getComputedStyle(area.closest('.prep-left')!).display==='none')return;
    const positions=categoryReadpoints.current.get(choiceScope)??{};
    positions[tab]=area.scrollTop;categoryReadpoints.current.set(choiceScope,positions);
    patch({leftScroll:area.scrollTop});
  };
  const chooseCategory=(next:typeof tab,detail:number)=>{
    if(!categoryChoice.choose(next,detail))return;
    rememberLeft();patch({selectedTab:next,leftScroll:categoryReadpoints.current.get(choiceScope)?.[next]??0});
  };
  const reviewChoices=state.availableSources.filter(record=>record.reviewAvailable!==false);
  const currentOperation=Object.values(state.operations).filter(op=>op.discussionId===(discussionId??'') && op.kind==='send').at(-1);
  const failedSuggestion=formalMode&&discussion&&currentOperation?.status==='failed' ? missingSuggestionTurn(discussion) : undefined;
  const running=currentOperation?.status==='running'&&!currentOperation.waitCancelled;
  const sourceMap=useMemo(()=>new Map(state.availableSources.flatMap(r=>r.sources.map(s=>[s.id,r] as const))),[state.availableSources]);
  const groups=useMemo(()=>{
    const map=new Map<string,{title:string,sources:PreparationSource[]}>();
    for(const item of discussion?.items??[])for(const place of ['left','chat'])map.set(place+'-'+item.id,{title:'这条准备的依据',sources:item.sources});
    for(const message of discussion?.messages??[])map.set('message-'+message.id,{title:'这段回复的依据',sources:message.sources.filter(s=>!discussion?.items.some(i=>i.sourceMessageId===message.id&&i.sources.some(a=>a.id===s.id)))});
    for(const clue of state.clues)map.set('clue-'+clue.id,{title:'过往线索的依据',sources:clue.sources});
    return map;
  },[discussion,state.clues]);
  const sheet=draft.sourceSheetId?groups.get(draft.sourceSheetId):null;
  const readingState=useRef({panel,draft,groups,sourceMap});readingState.current={panel,draft,groups,sourceMap};
  useEffect(()=>{
    if(!reader?.source||!sheet)return;
    const fresh=sheet.sources.find(s=>s.id===reader.source?.id);
    if(!fresh?.valid||fresh.fingerprint!==reader.source.fingerprint){
      readerRequest.current++;setReader(null);setReaderState('success-empty');setPanel('sources');
    }
  },[reader,sheet]);

  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    // The product adapter has already resolved this URL before mounting the
    // notebook. Selecting it again would clear its read error and change owner.
    if(formalMode)return;
    const requested=new URLSearchParams(location.search).get('preparation');
    if(requested&&adapter.getDiscussion(requested)) adapter.setCurrentDiscussion(requested);
  },[adapter,formalMode]);
  useLayoutEffect(()=>{
    if(state.loading){restoring.current=true;return;}
    if(restoredContext.current?.adapter===adapter&&restoredContext.current.id===discussionId&&!restoring.current)return;
    stopChatFollow();restoring.current=true;
    const url=new URL(location.href);
    if(discussionId){url.searchParams.set('preparation',discussionId);url.searchParams.delete('draft');}else url.searchParams.delete('preparation');
    history.replaceState(history.state,'',url);
    setError('');setRetryOperation(null);setWaiting(null);setUnseen(false);setNewNote(null);
    const saved=adapter.readDraft(discussionId);
    if(saved.sourceSheetId){resumeFocus.current=saved.sourceReturn;setPanel('sources');}else setPanel(null);
    if(chat.current){chat.current.scrollTop=saved.chatScroll??chat.current.scrollHeight;nearBottom.current=chat.current.scrollHeight-chat.current.scrollTop-chat.current.clientHeight<60;}
    if(left.current)left.current.scrollTop=saved.leftScroll??0;
    const positions=categoryReadpoints.current.get(choiceScope)??{};
    positions[saved.selectedTab??'current']=saved.leftScroll??0;
    categoryReadpoints.current.set(choiceScope,positions);
    const focusRequest=pendingDiscussionFocus.current;
    if(!(focusRequest?.adapter===adapter&&focusRequest.id===discussionId&&focusRequest.target==='released')){
      window.scrollTo({top:saved.windowScroll??0});
    }
    // Server hydration is history, not an arriving reply. Restore before paint
    // and establish the baseline before the following message-count effect.
    lastCount.current={id:discussionId,count:discussion?.messages.length??0};
    restoredContext.current={adapter,id:discussionId};restoring.current=false;
  },[adapter,discussionId,state.loading,discussion?.messages.length,stopChatFollow,choiceScope,pendingDiscussionFocus]);
  useLayoutEffect(()=>{
    if(state.loading)return;
    const previous=visibleNotebookView.current;
    visibleNotebookView.current={scope:choiceScope,tab,mobileView};
    if(previous?.scope!==choiceScope)return;
    // Restore only a real view change. Source returns and data publishes retain
    // their own authoritative read points and never run this restoration.
    if(previous.tab!==tab||previous.mobileView!==mobileView){
      if(left.current&&getComputedStyle(left.current.closest('.prep-left')!).display!=='none'){
        left.current.scrollTop=categoryReadpoints.current.get(choiceScope)?.[tab]??0;
      }
      if(chat.current&&previous.mobileView!==mobileView&&getComputedStyle(chat.current.closest('.prep-right')!).display!=='none'){
        chat.current.scrollTop=adapter.readDraft(discussionId).chatScroll??0;
      }
    }
  },[adapter,choiceScope,discussionId,mobileView,state.loading,tab]);
  // The formal loading paper unmounts this book during a history switch.
  // The owner keeps only this navigation's focus request, outside draft storage.
  useLayoutEffect(()=>{
    const request=pendingDiscussionFocus.current;
    if(!request||state.loading)return;
    pendingDiscussionFocus.current=null;
    if(request.adapter!==adapter||request.id!==discussionId||request.target==='released'||panel||draft.sourceSheetId)return;
    const active=document.activeElement;
    if(active===document.body||active?.closest('.prep-overlay')){
      const target=request.target==='history'?historyTrigger.current:discussionHeading.current;
      target?.focus({preventScroll:true});
      if(request.target==='heading')target?.scrollIntoView({block:'nearest',behavior:'instant'});
    }
  },[adapter,discussionId,state.loading,panel,draft.sourceSheetId,pendingDiscussionFocus]);
  useLayoutEffect(()=>{
    const trigger=pendingComposerFocus.current;
    if(!trigger||mobileView!=='chat')return;
    pendingComposerFocus.current=null;
    if(document.activeElement===trigger||document.activeElement===document.body)input.current?.focus();
  },[mobileView]);
  useLayoutEffect(()=>{
    const count=discussion?.messages.length??0;
    if(!state.loading&&!restoring.current&&lastCount.current.id===discussionId&&count>lastCount.current.count){
      const area=chat.current,last=area?.querySelector<HTMLElement>('.prep-message:last-of-type');
      if(area&&last&&nearBottom.current&&!panelRef.current&&!currentOperation?.waitCancelled){
        stopChatFollow();
        // This commit contains both reply and candidates. Read their real bounds
        // before paint; follow to the reply's beginning if it exceeds one page.
        // Never jump to the bottom of a still-transparent candidate block.
        const view=area.getBoundingClientRect(),bounds=last.getBoundingClientRect();
        const start=area.scrollTop+bounds.top-view.top-12;
        const end=area.scrollTop+bounds.bottom-view.bottom+16;
        const maximum=area.scrollHeight-area.clientHeight;
        // A sent user message is followed by the waiting row. Include that row
        // so it does not accidentally turn a bottom reader into a history reader.
        const target=last.dataset.role==='user'?maximum:Math.max(0,Math.min(maximum,bounds.height>area.clientHeight-28?start:end));
        if(preferReduced||keyboard||Math.abs(target-area.scrollTop)<1){area.scrollTop=target;nearBottom.current=area.scrollHeight-area.scrollTop-area.clientHeight<60;}
        else {
          const generation=chatMotionGeneration.current;
          chatMotion.current=animate(area.scrollTop,target,{duration:.22,ease:[.22,1,.36,1],onUpdate:value=>{if(chatMotionGeneration.current===generation)area.scrollTop=value;},onComplete:()=>{if(chatMotionGeneration.current!==generation)return;chatMotion.current=null;nearBottom.current=area.scrollHeight-area.scrollTop-area.clientHeight<60;}});
        }
        setUnseen(false);
      }else if(discussion?.messages.at(-1)?.role==='assistant')setUnseen(true);
    }
    lastCount.current={id:discussionId,count};
  },[discussionId,discussion?.messages.length,state.loading,stopChatFollow,preferReduced,keyboard,currentOperation?.waitCancelled]);
  useEffect(()=>{
    const area=chat.current;if(!area)return;
    const interrupt=()=>{stopChatFollow();nearBottom.current=area.scrollHeight-area.scrollTop-area.clientHeight<60;};
    const events=['wheel','touchstart','pointerdown','keydown'] as const;
    events.forEach(name=>area.addEventListener(name,interrupt,{passive:true}));
    return()=>{stopChatFollow();events.forEach(name=>area.removeEventListener(name,interrupt));};
  },[discussionId,stopChatFollow]);
  useEffect(()=>{
    const persist=()=>patch({windowScroll:window.scrollY});
    window.addEventListener('scroll',persist,{passive:true});return()=>window.removeEventListener('scroll',persist);
  },[patch]);
  useEffect(()=>{
    const resize=()=>{
      document.documentElement.style.setProperty('--prep-viewport-height',`${window.visualViewport?.height??innerHeight}px`);
      // Embedded books share the shell's remaining space directly in CSS.
      if(!embedded&&book.current)book.current.style.setProperty('--prep-book-height',`${Math.max(560,Math.min(1000,innerHeight-(book.current.getBoundingClientRect().top+scrollY)-48))}px`);
    };
    resize();window.visualViewport?.addEventListener('resize',resize);window.addEventListener('resize',resize);
    const observer=new ResizeObserver(resize);const mast=document.querySelector('.prep-mast');const toolbar=document.querySelector('.prep-toolbar');if(mast)observer.observe(mast);if(toolbar)observer.observe(toolbar);
    return()=>{observer.disconnect();window.visualViewport?.removeEventListener('resize',resize);window.removeEventListener('resize',resize);};
  },[embedded]);
  useEffect(()=>{
    const el=left.current;if(!el)return;
    const check=()=>setMoreNotes(el.scrollHeight-el.scrollTop-el.clientHeight>4);
    const observer=new ResizeObserver(check);observer.observe(el);if(el.firstElementChild)observer.observe(el.firstElementChild);el.addEventListener('scroll',check,{passive:true});check();
    return()=>{observer.disconnect();el.removeEventListener('scroll',check);};
  },[discussionId,selected.length,tab,state.loading]);
  const recordFocus=useRef('');
  // Keep the original read points while the short, text-free evidence insert is
  // on screen. Its temporary scroll range can be smaller than the real sheet.
  const sourceTrip=useRef(state.sourceRefresh ? adapter.readDraft(discussionId) : null);
  useLayoutEffect(()=>{
    if(panel!=='sources')return;
    const body=document.querySelector<HTMLElement>('.prep-dialog-content');
    const saved=sourceTrip.current??adapter.readDraft(discussionId);
    if(body)body.scrollTop=saved.sourceSheetScroll??0;
    if(sourceTrip.current&&!state.sourceRefresh){
      if(left.current)left.current.scrollTop=saved.leftScroll??0;
      if(chat.current)chat.current.scrollTop=saved.chatScroll??0;
      const trigger=saved.focusId&&document.getElementById(saved.focusId);
      if(trigger&&(document.activeElement===document.body||document.activeElement?.closest('.prep-dialog-header')))trigger.focus({preventScroll:true});
      sourceTrip.current=null;
    }
  },[panel,adapter,discussionId,state.sourceRefresh]);
  const closePanel=useCallback((restoreEditor=false)=>{
    readerRequest.current++;
    setReaderState('success-empty');setReaderError('');
    const current=readingState.current;
    if(current.panel==='reader'&&current.draft.sourceSheetId){
      setPanel('sources');setReader(null);patch({sourceRecordId:null});
      requestAnimationFrame(()=>{const body=document.querySelector<HTMLElement>('.prep-dialog-content');if(body)body.scrollTop=current.draft.sourceSheetScroll??0;document.getElementById(recordFocus.current)?.focus({preventScroll:true});});return;
    }
    if(location.hash.startsWith('#source-'))history.replaceState(history.state,'',location.pathname+location.search);
    if(current.panel==='sources'){sourceTrip.current=null;patch({sourceSheetId:null,sourceRecordId:null,focusId:undefined});}
    if(returnPanel.current){setPanel(returnPanel.current);returnPanel.current=null;setReader(null);const restore=resumeFocus.current;resumeFocus.current=null;requestAnimationFrame(()=>{const body=document.querySelector<HTMLElement>('.prep-dialog-content');if(body)body.scrollTop=returnPanelScroll.current;if(restore)document.getElementById(restore.id)?.focus({preventScroll:true});});return;}
    setPanel(null);setReader(null);
    const restore=resumeFocus.current;resumeFocus.current=null;
    if(restore)requestAnimationFrame(()=>{
      window.scrollTo({top:restore.scroll,behavior:'instant'});if(chat.current)chat.current.scrollTop=restore.chat;if(left.current)left.current.scrollTop=restore.left;
      const target=document.getElementById(restoreEditor&&restore.editId?restore.editId:restore.id)??document.getElementById(restore.editId?.replace('prep-edit-','note-')??'')??left.current;
      target?.focus({preventScroll:true});
      if(target instanceof HTMLTextAreaElement&&restore.selection)target.setSelectionRange(...restore.selection);
      // This is an explicit return to editing, not a typing-time auto-scroll.
      // Preserve both read points, then reveal only a clipped local action row.
      if(restoreEditor&&restore.editId)editVisibility.begin(restore.editId.replace('prep-edit-',''));
    });
  },[patch,editVisibility.begin]);
  const requestClosePanel=(restoreEditor=false,detail=0)=>{
    if(panelRef.current==='reader'){
      sourceDecoration.settle();pendingSourceLayer.current={direction:-1,detail};closePanel(restoreEditor);
    }else if(panelRef.current==='sources')sourceDecoration.dismiss(()=>closePanel(restoreEditor),detail);
    else closePanel(restoreEditor);
  };
  useLayoutEffect(()=>{
    const pending=pendingSourceLayer.current;pendingSourceLayer.current=null;
    if(pending&&(panel==='sources'||panel==='reader'))sourceDecoration.layer(pending.direction,pending.detail);
  },[panel,sourceDecoration.layer]);
  useEffect(()=>{
    const pop=()=>{
      setSourceEntry(null);sourceDecoration.settle();pendingSourceLayer.current=null;
      const requested=new URLSearchParams(location.search).get('preparation');
      if(requested!==adapter.getSnapshot().currentDiscussionId){
        stopChatFollow();readerRequest.current++;
        if(requested&&adapter.openDiscussion)void adapter.openDiscussion(requested).catch(()=>{});
        else adapter.setCurrentDiscussion(requested);
      }else if(!location.hash.startsWith('#source-'))closePanel();
      else {
        const id=decodeURIComponent(location.hash.slice(8));
        if(readingState.current.groups.has(id)){patch({sourceSheetId:id});setPanel('sources');}
      }
    };window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);
  },[adapter,closePanel,patch,stopChatFollow,sourceDecoration.settle]);
  const openSources=(id:string,trigger:HTMLButtonElement,detail:number)=>{
    stopChatFollow();editVisibility.cancel();
    const group=groups.get(id);if(!group)return;
    setSourceEntry(sourcePaperEntry(trigger,detail));
    const ed=adapter.readDraft(discussionId),field=ed.editingId?editing.current:input.current;
    const selection:[number,number]|undefined=field?[field.selectionStart,field.selectionEnd]:undefined;
    const point={id:'source-toggle-'+id,editId:ed.editingId?'prep-edit-'+ed.editingId:undefined,selection,scroll:scrollY,left:left.current?.scrollTop??0,chat:chat.current?.scrollTop??0};
    resumeFocus.current=point;returnPanel.current=panel==='clues'?'clues':null;returnPanelScroll.current=document.querySelector<HTMLElement>('.prep-dialog-content')?.scrollTop??0;
    patch({sourceSheetId:id,sourceRecordId:null,sourceSheetScroll:0,sourceReturn:point,...(selection?(ed.editingId?{editSelection:selection}:{inputSelection:selection}):{})});
    setReader(null);setPanel('sources');
    history.pushState({source:id},'',`${location.pathname}${location.search}#source-${id}`);
    requestAnimationFrame(()=>{const body=document.querySelector<HTMLElement>('.prep-dialog-content');if(body)body.scrollTop=0;});
  };
  const openReader=async(source:PreparationSource,detail=0)=>{
    const record=sourceMap.get(source.id)??state.availableSources.find(r=>r.id===source.interactionId);
    if(!source.valid||!record){setNotice('这条来源已不可用，无法打开原记录。');return;}
    sourceDecoration.settle();
    if(panelRef.current!=='reader')pendingSourceLayer.current={direction:1,detail};
    const request=++readerRequest.current,owner=discussionId;
    if(panelRef.current!=='reader')recordFocus.current=(document.activeElement as HTMLElement)?.id??'';
    patch({sourceRecordId:source.id,...(panelRef.current==='sources'?{sourceSheetScroll:document.querySelector<HTMLElement>('.prep-dialog-content')?.scrollTop??0}:{})});
    // Retrying this read must not replace the already visible record or search.
    if(panelRef.current!=='reader'){setSearch('');setReader({record,source});}
    setPanel('reader');setReaderError('');
    setReaderState(adapter.loadRecord?'loading':record.fullTranscript?'success-full':'success-empty');
    if(adapter.loadRecord)try{
      const loaded=await adapter.loadRecord(source);
      if(request!==readerRequest.current||adapter.getSnapshot().currentDiscussionId!==owner)return;
      if(loaded){setReader({record:loaded,source});setReaderState(loaded.fullTranscript?'success-full':'success-empty');}
      else{setReaderState('error');setReaderError('暂时未能核实完整文字稿，仍可核对这份已保存的依据。');}
    }catch(cause){if(request===readerRequest.current){setReaderState('error');setReaderError(cause instanceof Error&&!/Failed to fetch|NetworkError|Load failed|fetch failed|^http_\d+$/i.test(cause.message)?cause.message:'文字稿暂时没能读取，已保存的依据仍可核对。');}}
  };
  const run=async(action:()=>Promise<unknown>,success?:()=>void,mutationKind?:PreviewMutation['kind'])=>{
    if(latch.current)return;latch.current=true;setBusy(true);setError('');
    const owner=discussionId;
    try{await action();if(mounted.current&&adapter.getSnapshot().currentDiscussionId===owner){setConflict(false);success?.();}}
    catch(cause){if(mounted.current&&adapter.getSnapshot().currentDiscussionId===owner){
      let message=cause instanceof Error?cause.message:'暂时没有保存，请重试。';
      if(mutationKind==='edit'&&cause instanceof PreviewError){
        if(cause.code==='unknown_result')message='保存结果尚未确认，修改仍在。请再次保存以核对这次结果。';
        else if(cause.code==='write_failed'&&message==='暂时没有收到可确认的结果。')message='这次修改未能保存，编辑中的文字仍在。请检查后再试。';
      }
      setError(message);setConflict(cause instanceof PreviewError&&cause.code==='conflict');const id=adapter.readDraft(owner).editingId;if(id)editVisibility.begin(id);
    }}
    finally{latch.current=false;if(mounted.current)setBusy(false);}
  };
  const mutate=(body:Omit<PreviewMutation,'operationKey'|'expectedVersion'>,success?:(operationKey:string)=>void)=>{
    if(!discussion)return;
    if(body.kind==='edit'&&!latch.current)setNotice('');
    const operationKey=key();let receiptKey=operationKey;
    const pending=Object.values(adapter.getSnapshot().operations).find(op=>op.discussionId===discussion.id&&op.kind==='mutation'&&['running','unknown','cancelled'].includes(op.status))?.key;
    void run(async()=>{
      const result=await adapter.mutate(discussion.id,{...body,operationKey,expectedVersion:discussion.version});
      // The adapter may recover the original receipt instead of issuing this
      // click's new key. Observe its public metadata, never alter write dedup.
      const operations=adapter.getSnapshot().operations;
      if(!operations[operationKey]&&pending&&operations[pending]?.status==='succeeded')receiptKey=pending;
      return result;
    },()=>success?.(receiptKey),body.kind);
  };
  const editItem=(item:PreparationItem)=>{setNotice('');setError('');setConflict(false);editVisibility.cancel();patch({editingId:item.id,editText:item.text,editSelection:[item.text.length,item.text.length]});if(item.status==='selected')editVisibility.begin(item.id);requestAnimationFrame(()=>document.getElementById('prep-edit-'+item.id)?.focus({preventScroll:true}));};
  const choose=(item:PreparationItem,trigger:HTMLButtonElement,keyboardAction:boolean)=>{
    if(!discussion||latch.current||item.status!=='suggested')return;
    const ticket=handoff.prepare(item,trigger,keyboardAction);
    void run(async()=>{
      try{return await adapter.mutate(discussion.id,{kind:'select',itemId:item.id,operationKey:key(),expectedVersion:discussion.version});}
      catch(cause){handoff.reject(ticket);throw cause;}
    },()=>{setNotice('已留下这条准备。');setNewNote(item.id);handoff.confirm(ticket);});
  };
  const remove=(item:PreparationItem)=>mutate({kind:'remove',itemId:item.id},()=>{patch({editingId:null});setNotice('这条不再留在本次准备里。');});
  const send=async()=>{
    const text=(draft.input??'').trim();if(!text||latch.current||running)return;
    const operationKey=key();latch.current=true;activeSend.current=operationKey;setWaiting(operationKey);setError('');setRetryOperation(null);
    const owner=discussionId;
    try{
      const promise=adapter.send({discussionId,operationKey,text,kind:draft.feedback?'feedback':'message',expectedVersion:discussion?.version,interactionIds:discussion?.interactionIds??draft.scope??[],allowRetained:discussion?.allowRetained??draft.allowRetained??false});
      const actualId=adapter.getSnapshot().currentDiscussionId;
      adapter.writeDraft(actualId,{input:'',feedback:false});
      await promise;
    }catch(cause){
      const op=adapter.getSnapshot().operations[operationKey];
      if(activeSend.current===operationKey&&!(cause instanceof PreviewError&&cause.code==='cancelled')&&adapter.getSnapshot().currentDiscussionId===(op?.discussionId??owner)){
        setError(cause instanceof Error?cause.message:'回答没有完成。');setRetryOperation(operationKey);
      }
    }finally{if(activeSend.current===operationKey){latch.current=false;activeSend.current=null;if(mounted.current)setWaiting(null);}}
  };
  const reconcile=(opKey:string)=>void run(()=>adapter.reconcile(opKey),()=>{
    setRetryOperation(null);
    const view=discussionId&&adapter.getDiscussion(discussionId);
    if(formalMode&&view&&missingSuggestionTurn(view)){setNotice('');return;}
    setNotice(adapter.getSnapshot().operations[opKey]?.status==='failed'?(formalMode?'消息已保存，但回复没有完成。你可以接着说。':'已确认回复失败。可以重试这一轮，不会重复保存你的消息。'):'已重新读取这次请求的结果。');
  });
  const retryAnswer=(opKey:string)=>void run(async()=>{
    setNotice('');setRetryOperation(null);
    try {
      const view=await adapter.retryOperation(opKey,failedSuggestion&&discussion?{retryMessageId:failedSuggestion.id,expectedVersion:discussion.version}:undefined);
      if(mounted.current&&adapter.getSnapshot().currentDiscussionId===discussionId&&view.generationStatus==='idle')setNotice('这轮回复已补回。');
    } catch(cause) {
      if(mounted.current&&adapter.getSnapshot().currentDiscussionId===discussionId&&cause instanceof PreviewError)setRetryOperation(cause.operationKey??opKey);
      throw cause;
    }
  });
  const switchDiscussion=(id:string|null)=>{
    if(id===discussionId){
      setPanel(null);
      // Keep the existing access check without pushing a duplicate history entry
      // or consuming the current discussion's mobile tab and draft.
      if(id&&adapter.openDiscussion){
        pendingDiscussionFocus.current={adapter,id,target:'history'};
        void adapter.openDiscussion(id).catch(()=>{});
      }
      return;
    }
    pendingDiscussionFocus.current={adapter,id,target:'heading'};
    if(currentOperation&&['running','unknown'].includes(currentOperation.status))adapter.cancelWait(currentOperation.key);
    stopChatFollow();readerRequest.current++;activeSend.current=null;latch.current=false;setBusy(false);setPanel(null);
    const url=new URL(location.href);url.hash='';if(id){url.searchParams.set('preparation',id);url.searchParams.delete('draft');}else{url.searchParams.delete('preparation');if(formalMode)url.searchParams.set('draft','new');}
    history.pushState(history.state,'',url);
    if(id&&adapter.openDiscussion)void adapter.openDiscussion(id).catch(()=>{});else adapter.setCurrentDiscussion(id);
    adapter.writeDraft(id,{mobileView:'preparations'});
  };
  const openScope=()=>{setScope(discussion?.interactionIds??draft.scope??[]);setRetained(discussion?.allowRetained??draft.allowRetained??false);setPanel('scope');};
  const fill=(value:string)=>{patch({input:draft.input?`${draft.input}\n${value}`:value,mobileView:'chat'});requestAnimationFrame(()=>input.current?.focus());};
  const sourceBlock=(sources:PreparationSource[],id:string)=>{
    if(!sources.length)return null;
    return <div className="prep-sources"><button id={'source-toggle-'+id} className="prep-text-button" aria-expanded={draft.sourceSheetId===id} aria-haspopup="dialog" onClick={e=>openSources(id,e.currentTarget,e.detail)}>{`查看依据${sources.length>1?` · ${sources.length}`:''}`}<Arrow/></button></div>;
  };
  const sourceContents=(sources:PreparationSource[],id:string)=><div className="prep-source-list">{sources.map(source=>{
    const record=sourceMap.get(source.id)??state.availableSources.find(r=>r.id===source.interactionId);
    const detail=record?.sourceDetails?.[source.id];
    const href=source.valid && source.href && recordHref ? recordHref(source) : '';
    const target=href ? new URL(href,'http://preview.local').pathname : '';
    const linkLabel=target==='/date-companion/a/recap'?'打开来源复盘':target==='/date-companion/a/person'||target.startsWith('/date-companion/a/people/')?'查看人物资料':null;
    const presentation=detail?.presentation??(source.origin==='direct_conversation'?'direct_quote':'derived_summary');
    const segmentId=source.valid&&source.href?new URL(source.href,'http://preview.local').searchParams.get('segment'):null;
    const segment=record?.segments.find(s=>s.id===segmentId);
    return <div className="prep-source" key={source.id}>
          {!source.valid?<p className="prep-notice">这条来源已不可用；不会再用于讨论。你留下的文字仍在。</p>:<>
            <span className="prep-source-kind">{presentation==='suggestion'?'根据原话整理的建议':presentation==='derived_summary'?(source.origin==='user_reflection'?'你的转述':'根据原话整理'):source.speakerRole==='self'?'你的原话':source.speakerRole==='companion'?'Ta 的原话':'记录原话 · 说话人待核对'}</span>
            {presentation==='direct_quote'?<blockquote className="prep-source-quote">“{source.quote}”</blockquote>:<p>{source.quote}</p>}
            {presentation==='direct_quote'&&<p className="prep-source-signature">{detail?.speakerLabel??segment?.speaker??(source.speakerRole==='self'?'我':source.speakerRole==='companion'?state.relationshipName:'说话人待核对')}{detail?.time||segment?.time?` · ${detail?.time??segment?.time}`:''}</p>}
            <div className="prep-source-meta"><span>{dateLabel(source.recordingDate)} · {record?.title??(source.origin==='user_reflection'?'已保留的自述':'已保存来源片段')}</span>{record&&<button id={`record-${id}-${source.id}`} className="prep-text-button" onClick={e=>void openReader(source,e.detail)}>{adapter.loadRecord?'查看文字稿':record.fullTranscript?'查看全文':'查看已存片段'}<Arrow/></button>}{href&&linkLabel&&<a id={`source-recap-${id}-${source.id}`} className="prep-text-button" href={href} onClick={event=>{
              if(!onVisitSource||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
              event.preventDefault();
              patch({focusId:event.currentTarget.id,sourceSheetScroll:document.querySelector<HTMLElement>('.prep-dialog-content')?.scrollTop??0});
              onVisitSource(href);
            }}>{linkLabel}<Arrow/></a>}</div>
          </>}
        </div>;})}</div>;
  const editingAt=(item:PreparationItem,place:string)=>draft.editingId===item.id && (item.status==='selected'?place==='left':place==='chat');
  const editor=(item:PreparationItem,place:string)=>{
    return editingAt(item,place)?<><GrowingEditor id={'prep-edit-'+item.id} value={draft.editText??item.text} field={editing} onChange={text=>patch({editText:text})} onSelect={selection=>patch({editSelection:selection})} onActions={place==='left'&&editVisibility.oversizedId===item.id?()=>editVisibility.showActions(item.id):undefined}/>{conflict&&adapter.resumeEditingAfterReview&&discussion&&<div className="prep-conflict"><p>现在保存的文字</p><p>{item.text}</p><button className="prep-text-button" disabled={busy} onClick={()=>void run(()=>adapter.resumeEditingAfterReview!(discussion.id,item.id),()=>{setConflict(false);setNotice('已核对当前版本。你的编辑仍未保存，可继续修改。');requestAnimationFrame(()=>{editing.current?.focus({preventScroll:true});if(draft.editSelection)editing.current?.setSelectionRange(...draft.editSelection);});})}>按最新版本继续编辑</button></div>}</>:null;
  };
  const finishEdit=(item:PreparationItem,place:string)=>{editVisibility.cancel();patch({editingId:null,editText:'',editSelection:[0,0]});requestAnimationFrame(()=>document.getElementById(`edit-${place}-${item.id}`)?.focus({preventScroll:true}));};
  const saveEdit=(item:PreparationItem,place:string,detail:number)=>mutate({kind:'edit',itemId:item.id,text:draft.editText},operationKey=>{
    finishEdit(item,place);setNotice('文字已修改，选用状态不变。');
    saveFeedback.confirm({id:operationKey,detail,kind:'saved',target:()=>place==='left'?document.getElementById('note-'+item.id):Array.from(document.querySelectorAll<HTMLElement>('.prep-candidate')).find(node=>node.dataset.itemId===item.id)??null});
  });
  const itemActions=(item:PreparationItem,place:string)=>{
    const choice=discussion?preparationChoiceState(discussion,item):null;
    if(choice==='withdrawn')return <span className="prep-note-help">后来放下了</span>;
    if(editingAt(item,place))return <div className="prep-edit-actions"><button className="prep-button prep-primary" disabled={busy||!(draft.editText??'').trim()} onClick={e=>saveEdit(item,place,e.detail)}>{busy?'正在保存…':'保存修改'}</button><button className="prep-text-button" disabled={busy} onClick={()=>{finishEdit(item,place);setError('');}}>取消修改</button><span className="prep-edit-state">{item.status==='selected'?'仍是已留准备':'仍是未选建议'}</span></div>;
    return <div className="prep-item-actions">
      {item.status==='suggested'&&<button id={`choice-${item.id}`} className="prep-button prep-primary" disabled={busy||item.sources.some(s=>!s.valid)} onClick={event=>choose(item,event.currentTarget,event.detail===0)}>留下这条</button>}
      {item.status==='selected'&&place==='chat'?<button id={`choice-${item.id}`} className="prep-text-button" onClick={()=>{patch({mobileView:'preparations',selectedTab:choice==='earlier'?'past':'current'});requestAnimationFrame(()=>document.getElementById('note-'+item.id)?.focus({preventScroll:false}));}}><Check/>{choice==='earlier'?'那次留下的':'已留下'}</button>:<button id={`edit-${place}-${item.id}`} className="prep-text-button" disabled={busy} onClick={()=>editItem(item)}>修改</button>}
      <button className="prep-text-button prep-remove" disabled={busy} onClick={()=>remove(item)}>{item.status==='selected'?'这条不留了':'这条先不留'}</button>
    </div>;
  };
  const note=(item:PreparationItem)=>{const first=item.text.match(/^(.{1,35}?[。！？])([\s\S]+)$/u);const linked=handoff.suppressEntrance(item.id);return <motion.article layout={linked?false:'position'} layoutDependency={selected.length} initial={linked||preferReduced||keyboard?false:{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0}} transition={transition} className="prep-note" data-status={item.status} data-editing={editingAt(item,'left')} id={'note-'+item.id} tabIndex={-1} key={item.id}>
    <NoteContent duration={duration}>{editingAt(item,'left')?editor(item,'left'):first?<div className="prep-note-text"><h3>{first[1]}</h3><p>{first[2]}</p></div>:<p className="prep-note-text">{item.text}</p>}</NoteContent>
    {editingAt(item,'left')&&error&&<p className="prep-edit-error" role="alert">{error}</p>}
    <div className="prep-note-actions">{itemActions(item,'left')}{sourceBlock(item.sources,'left-'+item.id)}</div>
    <PaperFeedbackMarks/>
  </motion.article>;};

  const panelTitles:Record<Exclude<Panel,null>,string>={history:'聊过的',scope:'资料范围',review:'关联一份复盘',options:'这段讨论',delete:'删除这段讨论？',clues:'过往线索',account:'虚构账号',product:'Daily Brief',sources:sheet?.title??'这条准备的依据',reader:reader?.record.title??'原记录'};
  return <div className="prep-app" data-embedded={embedded||undefined} data-mobile-view={mobileView} onKeyDownCapture={()=>{setKeyboard(true);saveFeedback.cancel();}} onPointerDownCapture={()=>{setKeyboard(false);saveFeedback.cancel();}} onWheelCapture={()=>saveFeedback.cancel()}>
    <a className="prep-skip" href="#preparations">跳到这次留下的准备</a>
    {!embedded&&<header className="prep-mast"><button className="prep-brand" onClick={()=>setPanel('product')}>Daily Brief</button><div className="prep-context"><span>约会陪伴</span><span>{state.relationshipName}</span></div><nav className="prep-nav" aria-label="主要导航"><a href={previewProductOrigin+'/date-companion/a'}>首页</a><a href={location.pathname+location.search} aria-current="page">准备</a><a href={previewProductOrigin+'/date-companion/a/recap'}>复盘</a><a href={previewProductOrigin+'/date-companion/a/people'}>人物</a></nav><button className="prep-account" aria-label="账号菜单" onClick={()=>setPanel('account')}>访客</button></header>}
    <div className="prep-toolbar"><span role="heading" aria-level={2} tabIndex={-1} ref={discussionHeading}>{discussion?.title??'准备手帐'}</span><div><button onClick={openScope}>资料范围</button><button onClick={()=>{setReview(discussion?.reviewLink?.available?discussion.reviewLink.interactionId:'');setPanel('review');}}>关联复盘{discussion?.reviewLink?.available?' · 已关联':discussion?.reviewLink?' · 已失效':''}</button><button aria-label="更多讨论操作" onClick={()=>setPanel('options')}>更多<Arrow down/></button></div></div>
    <div className="prep-mobile-tabs" ref={mobileTabs} role="tablist" aria-label="手帐视图">{(['preparations','chat'] as const).map((v,i)=><button key={v} role="tab" data-paper-choice-value={v} aria-selected={mobileView===v} tabIndex={mobileView===v?0:-1} onKeyDown={e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const next=v==='chat'?'preparations':'chat';if(mobileChoice.choose(next,0))patch({mobileView:next});(e.currentTarget.parentElement?.children[1-i] as HTMLElement)?.focus();}}} onClick={e=>{if(mobileChoice.choose(v,e.detail))patch({mobileView:v});}}>{v==='preparations'?`留下的准备 · ${selected.length}`:'继续聊聊'}</button>)}<PaperChoiceInk inkRef={mobileChoice.ink}/></div>
    <main className="prep-book" ref={book} aria-label="准备手帐">
      <section className="prep-left" id="preparations"><header className="prep-page-head"><h1>这次想记得的事</h1>{selected.length>0&&<p className="prep-desktop-count">已留下 {selected.length} 条</p>}</header>
        <div className="prep-section-tabs" ref={categoryTabs}><button data-paper-choice-value="current" aria-pressed={tab==='current'} onClick={e=>chooseCategory('current',e.detail)}>自己留下的准备</button><button data-paper-choice-value="past" aria-pressed={tab==='past'} onClick={e=>chooseCategory('past',e.detail)}>以前留下的{past.length?` · ${past.length}`:''}</button><PaperChoiceInk inkRef={categoryChoice.ink}/></div>
        <motion.div className="prep-notes-scroll" ref={left} layoutScroll role="region" aria-label="留下的准备列表" tabIndex={0} onScroll={rememberLeft}>
        {state.loading?<p className="prep-notice" role="status">正在翻开手帐…</p>:state.error?<div className="prep-error" role="alert"><p>{state.error}</p><button className="prep-button" onClick={()=>void adapter.load().catch(()=>{})}>重新读取</button></div>:<div className="prep-notes"><AnimatePresence key={tab} initial={false}>
          {tab==='current'?selected.map(note):Array.from(new Set(past.map(i=>i.meetingId??discussion?.id))).map(meeting=><div className="prep-past-group" key={meeting}><h2>{meeting===(discussion?.currentMeetingId??discussion?.id)?'这次后来放下的':meeting===discussion?.reviewLink?.originalMeetingId?'这次见面前留下的':'先前那次见面'}</h2>{past.filter(i=>(i.meetingId??discussion?.id)===meeting).map(note)}</div>)}
        </AnimatePresence>
        {!(tab==='current'?selected:past).length&&<div className="prep-empty"><h2>{tab==='current'?'还没有留下准备':'以前的选择会留在这里'}</h2><p>{tab==='current'?'点「留下这条」，建议才会收进准备。':'每次见面的准备分开放，放下的也有自己的来处。'}</p>{tab==='current'&&<button className="prep-button" onClick={event=>{if(mobileView==='chat'){input.current?.focus();return;}pendingComposerFocus.current=event.currentTarget;patch({mobileView:'chat'});}}>聊聊这次见面<Arrow/></button>}</div>}
        </div>}</motion.div>
        <footer className="prep-page-footer"><span>{discussion?.date?`下次见面 · ${dateLabel(discussion.date)}`:'下次见面时间还没有定'}</span>{newNote?<button className="prep-text-button prep-new-note" onClick={()=>{patch({selectedTab:'current',mobileView:'preparations'});requestAnimationFrame(()=>{const target=document.getElementById('note-'+newNote);if(target&&left.current){if(left.current.scrollHeight>left.current.clientHeight)left.current.scrollTo({top:left.current.scrollTop+target.getBoundingClientRect().top-left.current.getBoundingClientRect().top-12,behavior:preferReduced?'instant':'smooth'});else target.scrollIntoView({block:'nearest',behavior:preferReduced?'instant':'smooth'});target.focus({preventScroll:true});}setNewNote(null);});}}>查看新留下的准备<Arrow down/></button>:moreNotes?<button className="prep-text-button prep-notes-more" onClick={()=>left.current?.scrollBy({top:left.current.clientHeight*.7,behavior:preferReduced?'instant':'smooth'})}>继续往下读<Arrow down/></button>:null}</footer>
      </section>
      <section className="prep-right" aria-label="继续聊聊"><div className="prep-right-content"><header className="prep-page-head"><h2>继续聊聊</h2><p>{discussion?.status==='paused'?'讨论已暂停，再发一句就会继续。':draft.feedback?'回来记一下 · 说说这次的感受':'慢慢说，不必急着有答案。'}</p></header>
        {state.relationshipStatus==='unmapped'&&<p className="prep-notice">人物关系尚待核对，暂不使用长期人物资料。仍可以聊你现在的想法。</p>}
        {state.relationshipStatus==='unavailable'&&<p className="prep-notice" role="status">人物资料暂时未能读取，仍可以继续聊。{onRetryMaterials&&<button className="prep-text-button" onClick={onRetryMaterials}>重新读取人物资料</button>}</p>}
        <motion.div className="prep-chat-scroll" ref={chat} layoutScroll role="region" aria-label="讨论内容" tabIndex={0} onScroll={()=>{if(chat.current&&getComputedStyle(chat.current.closest('.prep-right')!).display!=='none'){if(!chatMotion.current){nearBottom.current=chat.current.scrollHeight-chat.current.scrollTop-chat.current.clientHeight<60;if(nearBottom.current)setUnseen(false);}patch({chatScroll:chat.current.scrollTop});}}}>
          {!state.error&&!state.loading&&!discussion?.messages.length&&<div className="prep-chat-welcome"><h3>可以这样开头</h3><button className="prep-example" onClick={()=>fill('我想轻松一点，别像在完成任务。')}>我想轻松一点，别像在完成任务。<Arrow/></button><button className="prep-example" onClick={()=>fill('下次见面，可以从什么聊起？')}>下次见面，可以从什么聊起？<Arrow/></button></div>}
          {!!historyCut.current.index&&<button className="prep-text-button prep-earlier" aria-expanded={expandedHistory} onClick={()=>{nearBottom.current=expandedHistory;patch({showEarlier:!expandedHistory});requestAnimationFrame(()=>{if(chat.current)chat.current.scrollTop=0;});}}>{expandedHistory?'收起前面的讨论':`前面聊过的 · ${historyCut.current.index} 条`}<Arrow down={!expandedHistory}/></button>}
          <AnimatePresence initial={false}>{discussion?.messages.filter((_,i)=>expandedHistory||i>=historyCut.current.index).map(message=>{
            const items=discussion.items.filter(i=>i.sourceMessageId===message.id&&(i.status!=='removed'||preparationChoiceState(discussion,i)==='withdrawn'));
            const bodyText=message.text||(state.sourceRefresh&&message.sources.length?'需要核对这段回复的依据。':'');
            return <article className="prep-message" data-role={message.role} data-message-id={message.id} key={message.id}>
              <span className="prep-message-label">{message.role==='user'?(message.kind==='feedback'?'你 · 回来记一下':'你'):'Daily Brief'}</span>
              {bodyText&&<motion.div initial={{opacity:preferReduced?1:.68,y:preferReduced?0:6}} animate={{opacity:1,y:0}} transition={transition} className="prep-bubble"><p>{bodyText}</p></motion.div>}
              {items.map(item=><div className="prep-candidate" key={item.id} data-item-id={item.id} data-status={item.status}><span className="prep-candidate-label">{item.status==='selected'?'你留下的准备':item.status==='removed'?'后来放下了':'一个可选的准备'}</span>{item.status==='suggested'&&item.sources.some(s=>!s.valid)?<p className="prep-notice">{state.sourceRefresh?'需要核对这条建议的依据。':'这条建议的来源已不可用，暂不能选用。'}</p>:<><NoteContent duration={duration}>{editingAt(item,'chat')?editor(item,'chat'):<p>{item.text}</p>}</NoteContent>{editingAt(item,'chat')&&error&&<p className="prep-edit-error" role="alert">{error}</p>}{itemActions(item,'chat')}</>}{sourceBlock(item.sources,'chat-'+item.id)}<PaperFeedbackMarks/></div>)}
              {sourceBlock(message.sources.filter(s=>!items.some(i=>i.sources.some(a=>a.id===s.id))),'message-'+message.id)}
            </article>;
          })}</AnimatePresence>
          {running&&<p className="prep-answering" role="status">{currentOperation.responseMode==='slow'?'还在想，可能需要多等一会儿…':'正在想这句话…'}<button className="prep-text-button" onClick={()=>{adapter.cancelWait(currentOperation.key);activeSend.current=null;latch.current=false;setWaiting(null);setRetryOperation(currentOperation.key);setNotice('已停止等待。刚才发出的消息仍在，可以稍后重新读取结果。');}}>先不等回复</button></p>}
        </motion.div>
        {unseen&&<button className="prep-new-message" onClick={()=>{if(chat.current)chat.current.scrollTop=chat.current.scrollHeight;setUnseen(false);}}>有新的回复<Arrow down/></button>}
        {error&&!draft.editingId&&(!failedSuggestion||error!==discussion?.generationMessage)&&<div className="prep-error" role="alert"><p>{error}</p>{retryOperation?<button onClick={()=>reconcile(retryOperation)} className="prep-text-button">重新读取这次结果</button>:<button className="prep-text-button" onClick={()=>{void adapter.load().catch(()=>{});setError('');}}>重新读取</button>}</div>}
        {failedSuggestion&&currentOperation?<div className="prep-notice" role="status"><p>{discussion?.generationMessage}</p><button className="prep-button" disabled={busy} onClick={()=>retryAnswer(currentOperation.key)}>重试这一轮建议</button></div>:
        currentOperation&&['unknown','failed','running'].includes(currentOperation.status)&&!running&&(!retryOperation||!error)&&(currentOperation.status==='failed'&&currentOperation.reconciled?formalMode?<p className="prep-notice">消息已经保存在这段讨论中，本轮回复没有完成。可以继续聊。</p>:<button className="prep-button" disabled={busy} onClick={()=>retryAnswer(currentOperation.key)}>重试这一轮回复</button>:currentOperation.status==='unknown'&&currentOperation.reconciled&&currentOperation.key.startsWith('retry:')?<button className="prep-text-button" onClick={()=>retryAnswer(currentOperation.key)}>用原请求重试</button>:<button className="prep-text-button" onClick={()=>reconcile(currentOperation.key)}>重新读取这次结果</button>)}
        <form className="prep-composer" onSubmit={e=>{e.preventDefault();void send();}}><label className="prep-input-label" htmlFor="prep-input">{draft.feedback?'记下这次的感受':'还有什么想聊的？'}</label><textarea id="prep-input" ref={input} placeholder="还有什么想聊的？" maxLength={6000} rows={2} value={draft.input??''} onChange={e=>patch({input:e.target.value})} onSelect={e=>patch({inputSelection:[e.currentTarget.selectionStart,e.currentTarget.selectionEnd]})} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&e.keyCode!==229){e.preventDefault();void send();}}}/><div className="prep-composer-actions"><button type="button" className="prep-text-button" aria-pressed={!!draft.feedback} onClick={()=>patch({feedback:!draft.feedback})}>{draft.feedback?'取消记反馈':'回来记一下'}</button><button className="prep-button prep-primary" type="submit" disabled={state.loading||!!state.error||running||!!waiting||!(draft.input??'').trim()}>{running||waiting?'正在回答…':'发送'}</button></div></form>
      </div></section>
      <aside className="prep-side-tabs" aria-label="手帐附页"><button ref={historyTrigger} onClick={()=>setPanel('history')}>聊过的</button><button onClick={()=>setPanel('clues')}>过往线索</button></aside>
    </main>
    {state.sourceRefresh==='error'&&panel!=='sources'&&<div className="prep-error" role="alert"><p>{state.sourceRefreshError}</p><button className="prep-text-button" onClick={()=>void adapter.load().catch(()=>{})}>重新读取来源</button></div>}
    <footer className="prep-footer">{!formalMode&&<><a href="?fixtures=1">本地交互样稿 · 虚构资料</a><span>输入与选择只保存在这个浏览器，不写入正式准备服务。</span></>}<span role="status" className="prep-status">{notice}</span></footer>
    <NotebookOverlay open={!!panel} restoreOpen={!!sourceTrip.current&&panel==='sources'} title={panel?panelTitles[panel]:''} onClose={detail=>requestClosePanel(false,detail)} sourcePaper={sourcePaper} sourceEdge={sourceEdge} reading={panel==='sources'||panel==='reader'} fullReading={panel==='reader'} onReadingScroll={panel==='sources'?scroll=>patch({sourceSheetScroll:scroll}):undefined} footer={panel==='reader'?<button className="prep-button" onClick={e=>requestClosePanel(false,e.detail)}>返回来源<Arrow/></button>:panel==='sources'?<button className="prep-button" onClick={e=>requestClosePanel(true,e.detail)}>{returnPanel.current==='clues'?'返回过往线索':'返回刚才的位置'}<Arrow/></button>:undefined}>
      {error&&panel&&!['sources','reader'].includes(panel)&&<p className="prep-error" role="alert">{error}</p>}{panel==='history'&&<><p>打开一段讨论，找回当时的表达与选择。</p><div className="prep-history-list">{state.discussions.length?state.discussions.map(v=><button className="prep-history-row" key={v.id} onClick={()=>switchDiscussion(v.id)}><span>{v.title}</span><small>{dateLabel(v.updatedAt.slice(0,10))} · 留下 {v.items.filter(i=>i.status==='selected').length} 条{v.status==='paused'?' · 已暂停':''}</small><Arrow/></button>):<p className="prep-empty">还没有聊过的内容。第一次发送后，会留在这里。</p>}</div><button className="prep-button prep-primary" onClick={()=>switchDiscussion(null)}>聊点新的</button></>}
      {panel==='scope'&&<><p>仅供这段讨论参考。可以不选，从现在的表达开始聊。</p>{state.availableSources.some(r=>r.scopeAvailable!==false)?state.availableSources.filter(r=>r.scopeAvailable!==false).map(r=><label className="prep-check-row" key={r.id}><input type="checkbox" checked={scope.includes(r.id)} onChange={()=>setScope(scope.includes(r.id)?scope.filter(id=>id!==r.id):[...scope,r.id])}/><span>{r.title}<small>{dateLabel(r.date)}</small></span></label>):<p className="prep-notice">还没有可选的已确认相处记录。</p>}<label className="prep-check-row"><input type="checkbox" disabled={state.relationshipStatus!=='established'} checked={retained} onChange={e=>setRetained(e.target.checked)}/><span>参考已获准保留的长期资料<small>不会新增任何长期整理授权。</small></span></label>{scopeIdentityNotice[state.relationshipStatus]&&<p>{scopeIdentityNotice[state.relationshipStatus]}</p>}<button className="prep-button prep-primary" disabled={busy} onClick={()=>{if(discussion)mutate({kind:'scope',interactionIds:scope,allowRetained:retained},()=>setPanel(null));else{patch({scope,allowRetained:retained});setPanel(null);}}}>用这些资料</button><p className="prep-note-help">关联复盘是独立设置，取消这里的选择不会自动取消关联。</p></>}
      {panel==='review'&&<>
        <p>只关联一份复盘，资料范围另选。</p>
        {discussion?.reviewLink && !discussion.reviewLink.available && <p className="prep-notice">先前关联的复盘已不可用。取消关联后可以另选一份。</p>}
        {discussion&&reviewChoices.map(r=><label className="prep-check-row" key={r.id}>
          <input type="radio" name="review" checked={review===r.id} disabled={Boolean(discussion.reviewLink&&(!discussion.reviewLink.available||discussion.reviewLink.interactionId!==r.id))} onChange={()=>setReview(r.id)}/>
          <span>{r.title}<small>{dateLabel(r.date)}</small></span>
        </label>)}
        {!reviewChoices.length?<p className="prep-notice">还没有可关联的已确认复盘。</p>:
          !discussion&&<p className="prep-notice">发出第一句话建立讨论后，就可以关联复盘。</p>}
        <div className="prep-dialog-actions">
          {(!discussion||!reviewChoices.length)&&<button className="prep-button" onClick={()=>setPanel(null)}>返回手帐</button>}
          {discussion&&reviewChoices.length>0&&<button className="prep-button prep-primary" disabled={!reviewChoices.some(choice=>choice.id===review)||busy||discussion.reviewLink?.available===false}
            onClick={()=>mutate({kind:'link_review',interactionId:review},()=>setPanel(null))}>用这份记录</button>}
          {discussion?.reviewLink&&<button className="prep-button" onClick={()=>mutate({kind:'unlink_review'},()=>setPanel(null))}>取消关联</button>}
        </div>
        {discussion?.reviewLink?.available&&<><p>取消关联后，如果资料范围仍选着同一份记录，还需在那里另行撤回。</p>
          <button className="prep-text-button" onClick={()=>{fill('这次见面后，我想调整一下原来的准备。');setPanel(null);}}>这次见面后，我想调整一下原来的准备。</button></>}
      </>}
      {panel==='options'&&<div className="prep-menu-list"><button onClick={()=>switchDiscussion(null)}>聊点新的<Arrow/></button><button disabled={!discussion||discussion.status==='paused'} onClick={()=>mutate({kind:'pause'},()=>{setPanel(null);setNotice('已暂停；再次发送就会继续。');})}>暂停这段讨论</button><button disabled={!discussion} className="prep-danger" onClick={()=>setPanel('delete')}>删除这段讨论</button></div>}
      {panel==='delete'&&<><p>这段对话、其中的准备和本机编辑草稿会一并删除。来源复盘不会被删除。</p><p>删除后不能恢复，晚到的回复也不会重新出现。</p><div className="prep-dialog-actions"><button className="prep-button" onClick={()=>setPanel('options')}>先留着</button><button className="prep-button prep-danger" disabled={busy||!discussion} onClick={()=>{if(discussion)void run(()=>adapter.removeDiscussion(discussion.id,{operationKey:key(),expectedVersion:discussion.version}),()=>setPanel(null));setPanel(null);}}>确认删除讨论</button></div></>}
      {panel==='clues'&&<><p>来自已确认且允许使用的过往材料；不是聊天里留下的准备。</p>{state.materialsStatus==='loading'?<p className="prep-notice" role="status">正在读取符合条件的过往线索…</p>:state.materialsStatus==='error'?<div className="prep-error" role="alert"><p>{state.materialsError??'过往线索暂时未能读取。'}</p>{onRetryMaterials&&<button className="prep-text-button" onClick={onRetryMaterials}>重新读取过往线索</button>}</div>:state.relationshipStatus==='unmapped'?<p className="prep-notice">人物待核对，确认关系身份后才能查看对应的过往线索。</p>:<div className="prep-clues">{(['recent','together','promise','continue'] as const).map((group,i)=><section className="prep-clue" key={group}><h3>{['Ta 最近在意的','一起经历的事','你答应过','可以自然继续'][i]}</h3>{state.clues.filter(c=>c.group===group).map(c=><article key={c.id}><p>{c.text}</p>{c.reason&&<p className="prep-note-help">{c.reason}</p>}{sourceBlock(c.sources,'clue-'+c.id)}</article>)}{!state.clues.some(c=>c.group===group)&&<p className="prep-note-help">暂时没有符合条件的线索。</p>}</section>)}</div>}</>}
      {panel==='sources'&&(state.sourceRefresh || state.error
        ? <div className="prep-source-list">{state.sourceRefresh==='reading'
          ? <p className="prep-notice" role="status">正在核对这份来源…</p>
          : <div className="prep-error" role="alert"><p>{state.sourceRefreshError??state.error}</p><button className="prep-text-button" onClick={()=>void adapter.load().catch(()=>{})}>重新读取来源</button></div>}</div>
        : sheet ? sourceContents(sheet.sources,draft.sourceSheetId!) : <p className="prep-notice">这份来源已不可用。</p>)}
      {panel==='reader'&&reader&&<RecordReader record={reader.record} source={reader.source} search={search} setSearch={setSearch} state={readerState} error={readerError} onRetry={reader.source?()=>void openReader(reader.source!):undefined}/>}
      {panel==='account'&&<><p>当前为隔离的虚构账号：{state.accountId}。</p><p>退出仅清除此账号的样稿草稿，不影响正式账号、复盘和授权。</p><button className="prep-button" onClick={()=>adapter.logout()}>退出样稿账号</button></>}
      {panel==='product'&&<div className="prep-menu-list"><p>这些入口会前往已有本地产品；样稿草稿保留在这里。</p>{[['约会陪伴','/date-companion/a'],['日常复盘','/daily-reflection'],['办公复盘','/work-review'],['学习整理','/learning']].map(([label,href])=><a key={href} href={previewProductOrigin+href}>{label}<Arrow/></a>)}</div>}
    </NotebookOverlay>
  </div>;
}

function RecordReader({record,source,search,setSearch,state,error,onRetry}:{record:PreviewRecord,source?:PreparationSource,search:string,setSearch:(v:string)=>void,state:ReaderState,error:string,onRetry?:()=>void}){
  const sourceSegment=source?new URL(source.href,'http://preview.local').searchParams.get('segment'):null;
  const located=useRef<string|null>(null);
  const userReading=useRef(false);
  const region=useRef<HTMLDivElement>(null);
  // Late preceding context cannot be inserted above an already readable quote.
  // Reserve its control from the first render; only an explicit action reveals it.
  const deferPreceding=useRef(state==='loading'&&!record.fullTranscript&&!!sourceSegment);
  const [precedingOpen,setPrecedingOpen]=useState(false);
  const [retryOffered,setRetryOffered]=useState(false);
  useEffect(()=>{if(state==='error')setRetryOffered(true);},[state]);
  useLayoutEffect(()=>{
    // The button that opened this layer has left the DOM. Give the reading
    // region a stable focus immediately, without waiting for local data.
    const focused=document.activeElement;
    if(focused===document.body||!focused?.isConnected)region.current?.focus({preventScroll:true});
  },[]);
  useLayoutEffect(()=>{
    if(userReading.current||!sourceSegment||located.current===sourceSegment)return;
    const body=document.querySelector<HTMLElement>('.prep-dialog-content'),target=document.getElementById('segment-'+sourceSegment);
    if(!body||!target)return;
    located.current=sourceSegment;
    body.scrollTop+=target.getBoundingClientRect().top-body.getBoundingClientRect().top-Math.max(62,body.clientHeight*.3);
    target.focus({preventScroll:true});
  },[sourceSegment,record.segments]);
  const sourceIndex=record.segments.findIndex(s=>s.id===sourceSegment);
  const preceding=sourceIndex>0?record.segments.slice(0,sourceIndex):[];
  const matches=record.segments.filter(s=>!search||s.text.includes(search)||s.speaker.includes(search));
  const segments=deferPreceding.current&&!precedingOpen&&!search?matches.filter(s=>!preceding.some(p=>p.id===s.id)):matches;
  const stateText={loading:'正在读取本机文字稿…','success-empty':'仅有已保存片段','success-full':'完整文字稿已读取',error:'文字稿读取失败'}[state];
  return <div className="prep-reader" ref={region} tabIndex={-1} onPointerDownCapture={()=>{userReading.current=true;}} onKeyDownCapture={()=>{userReading.current=true;}} onWheelCapture={()=>{userReading.current=true;}} onTouchMoveCapture={()=>{userReading.current=true;}} onFocusCapture={e=>{if(e.target instanceof HTMLInputElement)userReading.current=true;}}>
    <div className="prep-reader-meta"><span>{dateLabel(record.date)}</span><span>原文核对</span></div>
    <div className="prep-reader-state" data-reader-state={state}>
      <span role="status">{stateText}</span>
      <span className="prep-reader-retry">{(state==='error'||retryOffered)&&onRetry&&<button className="prep-text-button" aria-label={state==='error'?'重新读取文字稿':state==='loading'?'正在重新读取文字稿':'文字稿已核对'} aria-disabled={state!=='error'||undefined} onClick={()=>{if(state==='error')onRetry();}}>{state==='error'?'重试':state==='loading'?'读取中':'已核对'}</button>}</span>
    </div>
    <label className="prep-search">查找原文<input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="输入关键词"/></label>
    {search&&<p>{matches.length} 处匹配</p>}
    {deferPreceding.current&&<div className="prep-reader-context">
      {search?<span>已显示全部搜索结果</span>:preceding.length>0?<button className="prep-text-button" aria-expanded={precedingOpen} onClick={()=>setPrecedingOpen(!precedingOpen)}>{precedingOpen?'收起':'查看'}原句前文（{preceding.length} 段）</button>:<span>{state==='loading'?'正在核对原句前文…':state==='error'?'前文暂未核实':state==='success-full'?'原句位于文字稿开头':'当前仅有已保存片段'}</span>}
    </div>}
    <div className="prep-transcript">{segments.map(s=><article key={s.id} id={'segment-'+s.id} data-highlight={s.id===sourceSegment} tabIndex={-1}><div className="prep-source-meta">{s.speaker}{s.time?` · ${s.time}`:""}</div><p>{s.text}</p></article>)}</div>
    {state==='success-empty'&&<p className="prep-notice">本机没有完整文字稿，仍可以核对已保存的来源片段。</p>}
    {state==='error'&&<p className="prep-notice" role="alert">{error}</p>}
  </div>;
}
