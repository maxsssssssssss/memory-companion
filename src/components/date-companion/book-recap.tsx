"use client";

import Link from "next/link";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { DateCompanionParticipantRole, InteractionVM, RecapItemVM } from "@/lib/domain/date-companion";

import { BookSource, BookTranscriptButton, lockBookPageScroll } from "./book-panels";
import { formatTimestamp } from "./companion-transcript";
import { PaperFeedbackMarks, usePaperFeedback } from "./paper-state-motion";
import styles from "./book-recap.module.css";

export function bookMeetingTitle(interaction: InteractionVM | null) {
  if (!interaction) return "单次复盘";
  if (interaction.title.trim() && interaction.title !== "这次相处") return interaction.title.trim();
  const name = interaction.fileName.replace(/\.[^.]+$/, "").trim();
  if (name && !/^[\d_\-.\s]+$/.test(name)) return name;
  const [, month, day] = /^(?:\d{4})-(\d{2})-(\d{2})/.exec(interaction.recordingDate) || [];
  return month && day ? `${Number(month)} 月 ${Number(day)} 日的相处` : "这次相处";
}

export function formatRecapDuration(seconds?: number) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} 秒`;
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}

function RecapFolio({interaction, children}: {interaction: InteractionVM | null; children?: ReactNode}) {
  const title = bookMeetingTitle(interaction);
  const duration = formatRecapDuration(interaction?.durationSeconds);
  return <aside className={styles.folio}>
    <header className={styles.folioHeading}>
      {interaction?.recordingDate && <time dateTime={interaction.recordingDate}>{interaction.recordingDate.replaceAll("-",".")}</time>}
      <h1 className={Array.from(title).length > 32 ? styles.longTitle : undefined}>{title}</h1>
      {duration && <p className={styles.duration}>录音 {duration}</p>}
      {interaction && <p className={styles.file}>{interaction.fileName} <span>{interaction.status === "ready" ? "已整理" : interaction.status === "failed" ? "处理失败" : "正在处理"}</span></p>}
    </header>
    {children}
  </aside>;
}

export function BookRecapDetailReading({interaction, error, onRetry}: {
  interaction: InteractionVM | null; error?: string; onRetry: () => void;
}) {
  return <article className={styles.spread} data-book-detail-reading aria-label="单次复盘">
    <RecapFolio interaction={interaction}>
      {interaction && <div className={styles.folioRule} aria-hidden="true"/>}
    </RecapFolio>
    <div className={styles.readingSheet}>
      <div className={styles.paperEdge} aria-hidden="true"/>
      <p role="status">{error ?? "正在读取相处内容…"}</p>
      {!error && <div className={styles.directoryInk} data-directory-ink="" aria-hidden="true"><i/><i/></div>}
      {error && <button className={styles.link} type="button" onClick={onRetry}>重新读取</button>}
    </div>
  </article>;
}

const genericTitles = new Set(["这次值得记住","Ta 提到的","你答应的","可以自然继续","这次出现的约定","下次自然接上","Ta 说起了什么","一次值得记住的互动"]);
const unassignedLabels: Record<RecapItemVM["kind"], string> = {
  moment:"待核对的片段", mentioned:"待核对的话题", promise:"待核对的约定", continue:"待核对的后续话题"
};

export function bookItemCopy(item: RecapItemVM, text: string, withholdAttribution: boolean) {
  if (withholdAttribution) {
    const first = item.sources[0];
    const title = first ? `${unassignedLabels[item.kind]} · ${formatTimestamp(first.startSeconds)}` : unassignedLabels[item.kind];
    return {title, text:"这条内容的说话人归属需要核对。"};
  }
  const title = item.title.trim();
  // Persisted records currently expose a group label, not a separate editorial
  // title. Once the summary changes, it is also the only current title source.
  const shortTitle = title && !genericTitles.has(title) && Array.from(title).length <= 32
    && text.trim() === item.proposedText.trim();
  // A directory previews the first sentence of that summary. The full summary
  // remains below the sources; never assemble a new title from evidence quotes.
  const preview = text.trim().match(/^[^\r\n。！？]+[。！？]?[”’」』]?/u)?.[0].trim() || text.trim();
  return {title:shortTitle ? title : preview || unassignedLabels[item.kind], text};
}

export function bookRetentionReason(
  item: RecapItemVM,
  disposition: RecapItemVM["disposition"],
  manuallyExcluded: boolean,
  knownRole: (id?: string, segmentId?: string) => DateCompanionParticipantRole | undefined,
) {
  if (disposition !== "excluded") return null;
  if (manuallyExcluded) return "你选择不留下这条。恢复后仍按来源判断能否保留。";
  if (!item.sources.length) return "没有可核对的来源，本次不保留。";
  if (item.sources.some(source => !source.speakerId)) return "有来源尚未识别说话人，本次暂不保留。可先查看原话。";
  const roles = item.sources.map(source => knownRole(source.speakerId, source.segmentIds[0]));
  if (roles.some(role => !role || role === "unresolved")) return "有来源的说话人身份尚未确认，核对后再决定能否保留。";
  if (item.kind === "mentioned" && roles.some(role => role !== "companion")) {
    return roles.every(role => role === "self")
      ? "这条来源已确认由我说出，不符合「Ta 说起了什么」的保留条件。原话仍可查看。"
      : "这条来源包含我和 Ta 的话，不能整条归为 Ta 说起的内容。原话仍可逐句查看。";
  }
  if (item.kind === "promise" && roles.some(role => role !== "self")) {
    return roles.every(role => role === "companion")
      ? "这条来源已确认由 Ta 说出，不是我作出的约定，本次不保留。"
      : "这条来源包含多人，不能整条认定为我作出的约定，本次不保留。";
  }
  return "这条在完成复盘时没有留下，仍可核对来源。";
}

function summaryMatchesQuotes(entry: BookItem, interaction: InteractionVM | null) {
  if (!entry.item.sources.length || entry.pendingIdentity) return false;
  const quotes: string[] = [];
  for (const source of entry.item.sources) {
    if (source.presentation !== "direct_quote" || !source.quote.trim()) return false;
    const basis = source.segmentIds.flatMap(id => interaction?.transcript.filter(line => line.id === id && line.uploadId === source.uploadId) ?? []);
    if (basis.length && (basis.length !== source.segmentIds.length || basis.map(line => line.text).join(" ").trim() !== source.quote.trim())) return false;
    quotes.push(source.quote);
  }
  const compact = (value: string) => value.replace(/\s+/gu, "");
  return compact(entry.text) === compact(quotes.join(" "));
}

export type BookItem = {
  item: RecapItemVM;
  title: string;
  text: string;
  disposition: RecapItemVM["disposition"];
  exclusionReason: string | null;
  manuallyExcluded: boolean;
  pendingIdentity: boolean;
  subjects: string[];
};

type Props = {
  interaction: InteractionVM | null;
  entries: BookItem[];
  groups: ReadonlyArray<{kind: RecapItemVM["kind"]; title: string}>;
  confirmed: boolean;
  editable: boolean;
  saving: boolean;
  participantReviewComplete: boolean;
  participantPanel: ReactNode;
  hasTranscript: boolean;
  question: ReactNode;
  observation: ReactNode;
  memory: ReactNode;
  canFinalize: boolean;
  submitting: boolean;
  error: string | null;
  memoryNote: string;
  homeHref?: string;
  speakerLabel: (id?: string, segmentId?: string) => string;
  editingId: string | null;
  editingText: string;
  onEdit: (item: RecapItemVM) => void;
  onText: (value: string) => void;
  onApply: () => void;
  onCancel: () => void;
  onChangeRetention: (item: RecapItemVM) => void;
  onFinalize: () => void;
};

// Motion Prompt #140 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#140
// A local adaptation of the fold/back/shadow relationship: the real text never
// flips. The CSS transition shares the disclosure's state and can reverse.
function LeafCurl({id}: {id:string}) {
  return <svg className={styles.curl} data-book-curl="" viewBox="0 0 96 28" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}-back`} x1="80%" y1="0%" x2="47%" y2="100%">
        <stop offset="0" stopColor="#fff7ec"/>
        <stop offset=".42" stopColor="#edd8cc"/>
        <stop offset=".76" stopColor="#c99f9a"/>
        <stop offset="1" stopColor="#f5e5da"/>
      </linearGradient>
      <linearGradient id={`${id}-shadow`} x1="80%" y1="15%" x2="40%" y2="100%">
        <stop offset="0" stopColor="#73504c" stopOpacity=".30"/>
        <stop offset="1" stopColor="#73504c" stopOpacity="0"/>
      </linearGradient>
    </defs>
    <path className={styles.curlUnder} d="M0 26 Q60 24 96 2 L96 28 H0Z" fill="#ecded5"/>
    <path className={styles.curlShadow} d="M0 26 Q58 23 96 2 L96 28 H0Z" fill={`url(#${id}-shadow)`}/>
    <g className={styles.curlBack}>
      <path d="M0 26 Q61 25 96 2 Q93 20 77 25 Q41 31 0 26Z" fill={`url(#${id}-back)`}/>
      <path d="M0 26 Q61 25 96 2" fill="none" stroke="#fffaf2" strokeWidth="1.1"/>
      <path d="M3 27 Q48 30 77 25 Q93 20 96 2" fill="none" stroke="#aa7e7b" strokeOpacity=".5" strokeWidth=".65"/>
    </g>
  </svg>;
}

function Leaf({entry, page, onReview}: {entry:BookItem; page:Props; onReview:()=>void}) {
  const {item, disposition, manuallyExcluded, pendingIdentity} = entry;
  const id = useId();
  const [open,setOpen] = useState(false);
  const [keyboardToggle,setKeyboardToggle] = useState(false);
  const heading = useRef<HTMLButtonElement>(null);
  const edit = useRef<HTMLButtonElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const feedbackTarget = useRef<HTMLDivElement>(null);
  const operationSequence = useRef(0);
  const focusFrame = useRef(0);
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const scope = `${page.interaction?.relationshipInteractionId ?? page.interaction?.id ?? "none"}:${item.id}`;
  const {confirm, cancel: cancelFeedback} = usePaperFeedback(scope);
  const pendingFeedback = useRef<{
    id:string; scope:string; detail:number;
    expectedText?:string; expectedExcluded?:boolean;
  } | null>(null);
  const editing = page.editingId === item.id;
  const editingNow = useRef(editing);
  editingNow.current = editing;
  const canChange = page.editable && !page.confirmed;
  const firstSource = item.sources[0];
  let sourceMeta = `${item.sources.length} 条来源`;
  if (firstSource && item.sources.length === 1) {
    if (firstSource.presentation === "direct_quote") sourceMeta = `${page.speakerLabel(firstSource.speakerId, firstSource.segmentIds[0])} · ${formatTimestamp(firstSource.startSeconds)}`;
    else sourceMeta = firstSource.presentation === "suggestion" ? "根据原话整理的建议" : "根据原话整理";
  }
  const retention = disposition === "kept" ? page.confirmed ? "已保留" : "将保留" : manuallyExcluded ? "已移除" : pendingIdentity ? "待核对 · 未保留" : "未保留";
  const summaryMatches = summaryMatchesQuotes(entry, page.interaction);
  const titleIsSummary = entry.title.trim() === entry.text.trim();
  const summaryLabel = item.kind === "continue" ? "接续建议" : "摘要";
  useLayoutEffect(() => {
    const field = textarea.current;
    if (!editing || !field) return;

    // Replacing a wrapped summary can put its editor above the tapped button.
    // Reveal it before handing off focus, so the first keystroke keeps its place.
    const bounds = field.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0;
    const height = viewport?.height ?? window.innerHeight;
    if (bounds.top < top || bounds.bottom > top + height) {
      const editor = field.parentElement;
      const target = editor && editor.getBoundingClientRect().height <= height ? editor : field;
      target.scrollIntoView({block: "nearest", inline: "nearest", behavior: "instant"});
    }
    field.focus({preventScroll: true});
  }, [editing]);
  useEffect(()=>()=>{
    pendingFeedback.current = null;
    cancelAnimationFrame(focusFrame.current);
  },[scope]);
  useLayoutEffect(()=>{
    const operation = pendingFeedback.current;
    if (!operation) return;
    // Only this explicit action can confirm a receipt. A later render, source
    // return or formal save response cannot create another draft operation.
    pendingFeedback.current = null;
    if (operation.scope !== scope) return;
    const applied = operation.expectedText !== undefined;
    if (applied ? editing || entry.text !== operation.expectedText : manuallyExcluded !== operation.expectedExcluded) return;
    setFeedbackMessage(applied ? "修改已应用到本次草稿。" : manuallyExcluded
      ? "这条已从本次保留选择中移除，仍可恢复。"
      : disposition === "kept" ? "这条已恢复，将随本次复盘保留。" : "已恢复来源判断，这条目前仍未保留。");
    confirm({id:operation.id, target:()=>feedbackTarget.current, detail:operation.detail, kind:applied ? "applied" : "selection"});
  });
  function beginEdit() {
    pendingFeedback.current = null;
    cancelAnimationFrame(focusFrame.current);
    cancelFeedback();
    setFeedbackMessage("");
    page.onEdit(item);
  }
  function finishEdit(apply:boolean, detail=0) {
    pendingFeedback.current = null;
    cancelFeedback();
    if (apply) {
      if (!canChange || page.saving || !editing || !page.editingText.trim()) return;
      const expectedText = page.editingText.trim();
      if (expectedText !== entry.text) pendingFeedback.current = {
        id:`${id}:apply:${++operationSequence.current}`, scope, detail, expectedText,
      };
      page.onApply();
    } else page.onCancel();
    cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(()=> {
      if (!editingNow.current) (edit.current || heading.current)?.focus({preventScroll:true});
    });
  }
  function changeRetention(detail:number) {
    if (!canChange || page.saving || disposition !== "kept" && !manuallyExcluded) return;
    pendingFeedback.current = {
      id:`${id}:selection:${++operationSequence.current}`, scope, detail, expectedExcluded:!manuallyExcluded,
    };
    page.onChangeRetention(item);
  }
  return (
    <article className={styles.leaf} data-book-item={item.id} data-disposition={disposition} data-open={open} data-keyboard-toggle={keyboardToggle}
      onFocusCapture={event=>{
        // A reader/editor reached during expansion must not keep moving after
        // focus lands. Pointer toggles on the heading can still animate normally.
        if (event.target !== heading.current) setKeyboardToggle(true);
      }}>
      <h4><button ref={heading} className={styles.opener} type="button" aria-controls={id}
        aria-expanded={open} onClick={event=>{setKeyboardToggle(event.detail === 0);setOpen(value=>!value);}}>
        <span className={styles.leafTitle}>{titleIsSummary && <small className={styles.titleKind}>{summaryLabel}</small>}{entry.title}</span>
        <span className={styles.leafMeta}>{retention}</span>
        <span className={styles.leafSource}>{sourceMeta}</span><i className={styles.chevron} aria-hidden="true"/>
      </button></h4>
      {entry.exclusionReason && <div className={styles.reason}>
        <p>{entry.exclusionReason}</p>
        {canChange && pendingIdentity && <button className={styles.link} onClick={onReview} type="button">核对说话人</button>}
      </div>}
      <div className={styles.reveal} id={id} inert={!open} aria-hidden={!open}>
        <div className={styles.clip}><div className={styles.leafContent}>
          {item.sources.map(source=><BookSource key={source.id} source={source}/>)}
          <div className={styles.editLine} ref={feedbackTarget} data-recap-feedback="">
            <PaperFeedbackMarks/>
            {editing ? <div className={styles.editor}>
              <label htmlFor={`book-edit-${item.id}`}>修改摘要</label>
              <textarea ref={textarea} id={`book-edit-${item.id}`} value={page.editingText} disabled={page.saving}
                onChange={event=>page.onText(event.currentTarget.value)} rows={3}
                onKeyDown={event=>{if (event.nativeEvent.isComposing) return; if (event.key==="Escape") {event.preventDefault();finishEdit(false);}
                  if ((event.ctrlKey || event.metaKey) && event.key==="Enter" && page.editingText.trim()) finishEdit(true);}}/>
              <div><button disabled={page.saving || !page.editingText.trim()} type="button" onClick={event=>finishEdit(true,event.detail)}>应用修改</button>
              <button disabled={page.saving} type="button" onClick={()=>finishEdit(false)}>取消</button></div>
            </div> : <>
              {!titleIsSummary && <><span className={styles.caption}>{summaryLabel}</span>
                <p className={summaryMatches ? styles.sameText : undefined}>{summaryMatches ? item.sources.length === 1 ? "与上方原话一致" : "由上方原话组成" : entry.text}</p></>}
              {canChange && disposition==="kept" && <button ref={edit} className={styles.link} disabled={page.saving} onClick={beginEdit} type="button">修改</button>}
              {canChange && (disposition==="kept" || manuallyExcluded) && <button className={styles.remove} type="button" disabled={page.saving} onClick={event=>changeRetention(event.detail)}>{manuallyExcluded?"恢复这条":"这条不留下"}</button>}
            </>}
            <span className={styles.feedbackStatus} role="status" aria-live="polite" aria-atomic="true">{feedbackMessage}</span>
          </div>
          {entry.subjects.length>0 && <p className={styles.subjects}>长期归属 · {entry.subjects.join("、")}</p>}
        </div></div>
      </div>
      <LeafCurl id={id}/>
    </article>
  );
}

export function BookRecap(page:Props) {
  const {interaction,entries,groups}=page;
  const ready = interaction?.status==="ready";
  const speakers = useRef<HTMLDialogElement>(null);
  const speakerReturn = useRef<{element:HTMLElement|null;x:number;y:number}|null>(null);
  const unlockSpeakers = useRef<(()=>void)|null>(null);
  useEffect(()=>()=>{
    unlockSpeakers.current?.();
    unlockSpeakers.current=null;
  },[ready,Boolean(page.participantPanel)]);
  const closeSpeakers = () => {
    unlockSpeakers.current?.();
    unlockSpeakers.current=null;
    const point=speakerReturn.current;
    speakerReturn.current=null;
    if (!point) return;
    point.element?.isConnected && point.element.focus({preventScroll:true});
    window.scrollTo({left:point.x,top:point.y,behavior:"instant"});
  };
  const openSpeakers = () => {
    if (!speakers.current || speakers.current.open) return;
    // A native close event is queued. Release the previous visit before a
    // rapid reopen, rather than letting that late event unlock the new one.
    if (unlockSpeakers.current) closeSpeakers();
    speakerReturn.current={element:document.activeElement instanceof HTMLElement ? document.activeElement : null,
      x:window.scrollX,y:window.scrollY};
    unlockSpeakers.current=lockBookPageScroll();
    try { speakers.current.showModal(); }
    catch (error) { closeSpeakers(); throw error; }
  };
  const dismissSpeakers = () => {
    speakers.current?.close();
    closeSpeakers();
  };
  const kept = entries.filter(entry=>entry.disposition==="kept").length;
  const group = (section:Props["groups"][number]) => {
    const members=entries.filter(entry=>entry.item.kind===section.kind);
    if (!members.length) return null;
    return <section className={styles.group} key={section.kind} data-book-group={section.kind}>
      <header><h2>{section.title}</h2>
        {section.kind==="mentioned" && page.participantPanel && <button className={styles.link} type="button" onClick={openSpeakers}>{page.participantReviewComplete?"查看已核对的身份":"核对说话人身份"}</button>}
      </header>
      {members.map(entry=><Leaf key={entry.item.id} entry={entry} page={page} onReview={openSpeakers}/>)}
    </section>;
  };
  return <article className={styles.spread} data-book-recap aria-label="单次复盘">
    <RecapFolio interaction={interaction}>
      <div className={styles.sideLinks}>
        {ready && page.participantPanel && <button type="button" onClick={openSpeakers}>核对说话人</button>}
        {ready && page.hasTranscript && <BookTranscriptButton/>}
        {page.question}
      </div>
    </RecapFolio>
    <div className={styles.pages}>
      {ready ? <>
        {groups.slice(0,2).map(group)}
        {groups.slice(2).some(g=>entries.some(e=>e.item.kind===g.kind)) && <section className={styles.more}>
          <p>更多可能有用的内容</p>{groups.slice(2).map(group)}</section>}
        {page.observation}
        {page.memory}
        <section className={styles.end} aria-labelledby="book-ending-title">
          <div><h2 id="book-ending-title">{page.confirmed?"本次复盘已完成":!entries.length?"这次没有可保存的条目":!page.editable?"只读查看":"这次留下的内容"}</h2>
            {entries.length>0 && <p className={styles.total}>{page.confirmed?"已保留":page.editable?"将保留":"有依据的条目"} {kept} 条　未保留 {entries.length-kept} 条</p>}
            <p>{!entries.length ? (page.hasTranscript?"仍可核对这次录音的原话。":"这次没有提取出复盘条目。") :
              page.confirmed?"留下的文字和当时的原话，随时可以回来翻看。" : !page.editable?"这份记录目前仅可查看。" : page.memoryNote}</p>
            {page.editable && !page.confirmed && kept===0 && <p id="book-completion-reason">需要先确认至少一条有真实来源、且说话人归属一致的内容。{entries.some(entry=>entry.manuallyExcluded) ? "可以恢复已移除的条目。" : ""}</p>}
            {!!page.error && <p className={styles.error} role="alert">{page.error}</p>}
          </div>
          {page.editable && !page.confirmed && <button type="button" disabled={!page.canFinalize} aria-describedby={kept===0?"book-completion-reason":undefined} onClick={page.onFinalize}>{page.submitting?"正在完成…":page.error?"重试完成本次复盘":"完成本次复盘"}</button>}
        </section>
      </> : <section className={styles.end}>
        <div><h2>{!interaction?"还没有相处记录":interaction.status==="failed"?"这次整理没有完成":"这次相处正在整理"}</h2>
        {!interaction && <p>上传一段录音后，这里会出现可核对的复盘。</p>}
        {interaction?.status==="processing" && <p>当前进度 {typeof interaction.progress==="number"?Math.round(interaction.progress)+"%":"正在更新"}</p>}
        {interaction?.status==="failed" && <p>{interaction.errorMessage || "回到首页查看失败原因或重试。"}</p>}
        <Link href={page.homeHref ?? "/date-companion/a"}>返回首页</Link></div></section>}
    </div>
    {ready && page.participantPanel && <dialog ref={speakers} data-book-speakers aria-label="核对说话人" className={styles.speakers}
      onClose={()=>{if (!speakers.current?.open) closeSpeakers();}}
      onCancel={event=>{event.preventDefault();dismissSpeakers();}}>
      <header><span>本次录音</span><button type="button" onClick={dismissSpeakers}>返回复盘</button></header>
      {page.participantPanel}
    </dialog>}
  </article>;
}
