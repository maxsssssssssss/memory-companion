"use client";

import Link from "next/link";
import { type FormEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ToySyncSelection } from "@/components/daily-reflection/daily-reflection-toy-sync";
import type { SourceRefVM } from "@/lib/domain/date-companion";
import type { DateCompanionHomeContentState } from "@/lib/client/date-companion-proactive-value";
import type { CompanionHomeProps } from "./companion-home";
import { formatTimestamp } from "./companion-transcript";
import { LocalTimeGreeting } from "./local-time-greeting";
import { bookHomeForm, bookHomeReading, clearBookHomeReading, rememberBookHomeForm, rememberBookHomeReading } from "./book-home-reading-state";
import { preparationRequest, type PreparationCatalog } from "@/lib/client/date-companion-preparation-api";
import { presentBookHomeMaterial } from "./book-home-material";
import { BookToyDialog } from "./book-toy-dialog";
import styles from "./book-home.module.css";

export type BookHomeContext = {
  scopeKey?: string;
  relationshipId?: string;
  lastSaved: { id: string; title: string; date: string; summary?: string | null } | null;
  historyStatus?: "loading" | "ready" | "error";
  historyError?: string;
  onRetryHistory?: () => void;
  onRetryContent?: () => void;
  currentRecapHref?: string;
  href: (path: string) => string;
};

type BookHomeProps = Pick<CompanionHomeProps, "currentInteraction" | "uploadState" | "onRetryRead" | "onOpenSource" | "participantNotice" | "participantReviewHref"> & {
  book: BookHomeContext;
  file: File | null;
  fileError: string | null;
  recordingDate: string;
  dateMax: string;
  toySelection: ToySyncSelection | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectFile: (file: File | null) => void;
  onDate: (date: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  statusLabel: string;
  homeContent: DateCompanionHomeContentState;
  relationshipName: string;
  renderToy?: (close: () => void) => ReactNode;
};

const paths = {
  go: "M4 12h16m-6-6 6 6-6 6",
  upload: "M4 14v6h16v-6M12 15V4m-5 5 5-5 5 5",
  file: "M6 3.5h8l4 4v13H6zM14 3.5v4h4M9 14h6m-6 3h4",
  plug: "M8 4v5m6-5v5M6 9h10v3a5 5 0 0 1-10 0zm5 8v2a2 2 0 0 0 2 2h5",
  close: "m6 6 12 12M18 6 6 18",
  up: "m5 15 7-7 7 7"
};

function Icon({ name }: { name: keyof typeof paths }) {
  return <svg className={styles.icon} aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}

function fileSize(bytes: number) {
  const unit = bytes >= 1048576 ? 1048576 : bytes >= 1024 ? 1024 : 1;
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(bytes / unit) +
    (unit === 1 ? " B" : unit === 1024 ? " KB" : " MB");
}

function RelationSources({ sources, onOpenSource, readingKey }: { sources: SourceRefVM[]; onOpenSource: CompanionHomeProps["onOpenSource"]; readingKey: string }) {
  const dates = [...new Set(sources.map(source => source.recordingDate))].sort();
  const kind = sources.every(source => source.presentation === "direct_quote" && (!source.sourceOrigin || source.sourceOrigin === "direct_conversation")) ? "原话" : "依据";
  return <details className={styles.sources} data-home-source-group={readingKey}>
    <summary onClick={event => { event.currentTarget.parentElement!.dataset.motion = event.detail ? "pointer" : "instant"; }}>
      <span className={styles.materialDate}>记录于 {dates.join("、")}</span>
      <span className={styles.sourceAction}><span className={styles.onClosed}>查看{kind}</span><span className={styles.onOpen}>收起{kind}</span> <Icon name="up" /></span></summary>
    <div className={styles.sourceSheet}>
      {sources.map((source, index) => <figure className={styles.source} key={source.uploadId + ":" + source.id}>
        <div className={styles.sourceType}>
          <span>{source.sourceOrigin === "user_reflection" ? "保存的自述" : source.sourceOrigin === "unknown" ? "已保存的依据" : source.presentation === "direct_quote" ? "原话片段" : source.presentation === "suggestion" ? "根据原话整理的建议" : "根据原话整理"}</span>
          {sources.length > 1 && <span>{index + 1} / {sources.length}</span>}
        </div>
        {source.presentation === "direct_quote" ? <blockquote>“{source.quote}”</blockquote> : <p>{source.quote}</p>}
        <figcaption>
          <div className={styles.sourceSignature}>
            {source.presentation === "direct_quote" && <span>{source.sourceOrigin === "user_reflection" ? source.sourceStatement || "来自用户自述" : source.speakerLabel || "说话人待核对"}{source.timeKnown !== false && ` · ${formatTimestamp(source.startSeconds)}`}</span>}
            {dates.length > 1 && <time dateTime={source.recordingDate}>{source.recordingDate}</time>}
          </div>
          {source.canOpenTranscript && source.segmentIds[0] && onOpenSource
            ? <button type="button" data-home-source-link={JSON.stringify([readingKey,source.id,source.segmentIds[0]])} onClick={() => void onOpenSource(source, source.segmentIds[0])}>在完整文字稿中查看 <Icon name="go" /></button>
            : <span className={styles.fragmentNote}>已保留来源片段</span>}
        </figcaption>
      </figure>)}
    </div>
  </details>;
}

function RightPage({ book, homeContent, participantNotice, participantReviewHref, relationshipName, onOpenSource }:
  Pick<BookHomeProps, "book" | "homeContent" | "participantNotice" | "participantReviewHref" | "relationshipName" | "onOpenSource">) {
  const history = book.lastSaved;
  const batches = [
    { title: "下次见面前", variant: "meeting", items: homeContent.status === "ready" ? homeContent.content.beforeMeeting : [],
      href: "/date-companion/a/prepare?section=records", entry: "回看准备卡", empty: "暂时没有可展示的见面准备。" },
    { title: "人物近况", variant: "person", items: homeContent.status === "ready" ? homeContent.content.about : [],
      href: "/date-companion/a/person", entry: "关于" + relationshipName, empty: "暂时没有可展示的人物近况。" }
  ];
  const labels = { open_promise: "你答应过", follow_up: "可以问问 Ta", preference: "Ta 的偏好", shared_moment: "一起经历的事", recent_update: "Ta 的近况" };
  const noHistory = book.historyStatus === "error" ? "上次的复盘暂时未能读取" :
    book.historyStatus === "loading" ? "正在翻找上次的复盘…" : "还没有已保存的复盘";
  return <section className={styles.memories} aria-label="上次留下的内容">
    <div className={styles.frame}>
      <article className={styles.leaf} data-home-history="" data-interaction-id={history?.id} aria-labelledby="home-saved-title">
        <div className={styles.leafHead}><p>上一次保存的复盘</p>{history && <time dateTime={history.date}>{history.date.replaceAll("-", ".")}</time>}</div>
        <h2 id="home-saved-title">{history?.title || noHistory}</h2>
        {history?.summary && <p className={styles.savedSummary}>{history.summary}</p>}
        {history && !history.summary && book.historyStatus === "loading" && <div className={styles.savedSummary} data-summary-placeholder="">
          <span className={styles.summaryPaper} aria-hidden="true"><i /><i /><i /><i /><i /></span>
          <span className={styles.srOnly} role="status">正在读取这次复盘的摘要…</span>
        </div>}
        {book.historyStatus === "error" && <p className={styles.historyNotice} role="alert">{book.historyError || "这次复盘的摘要暂时未能读取，记录仍然保留。"}{history && " 可以重新读取，或翻开复盘查看。"}</p>}
        {history && <Link className={styles.read} href={book.href("/date-companion/a/recap?interaction=" + encodeURIComponent(history.id))} aria-label={`翻开最近复盘：${history.title}`}>翻开最近复盘 <Icon name="go" /></Link>}
        {book.historyStatus === "error" && book.onRetryHistory && <button className={styles.textAction} type="button" onClick={book.onRetryHistory}>重新读取复盘</button>}
      </article>
    </div>
    <div className={styles.relations} data-home-relations="" tabIndex={-1} aria-label="人物近况与见面准备">
      <div className={styles.materialLinks}>
        {batches.map(({href, entry}) => <Link key={href} className={styles.directory} href={book.href(href)}>{entry}<Icon name="go" /></Link>)}
      </div>
      {!participantNotice && (homeContent.status === "loading" || homeContent.status === "ready" && homeContent.refresh === "reading") &&
        <p className={styles.materialReadState} role="status" data-material-refresh={homeContent.status === "ready" ? "" : undefined}>
          {homeContent.status === "ready" ? "正在更新人物近况与见面准备…" : "正在读取人物近况与见面准备…"}
        </p>}
      {participantNotice && <div role="status" className={styles.stateNote}><p>{participantNotice}</p>
        {participantReviewHref && <Link className={styles.textAction} href={participantReviewHref}>核对人物身份 <Icon name="go" /></Link>}</div>}
      {homeContent.status === "empty" && homeContent.note && <p className={styles.stateNote} role="status">{homeContent.note}</p>}
      {homeContent.status === "unavailable" && <div className={styles.stateNote} role="status">
        <p>{homeContent.reason === "generation" ? "人物近况与见面准备暂时未能整理。" : "人物近况与见面准备暂时未能读取。"}</p>
        <span>{homeContent.reason === "access" ? "当前账号暂时无法访问这段关系的材料。" :
          homeContent.reason === "generation" ? "这次整理未得到可用结果，可以再试一次。" :
          homeContent.reason === "qualification" ? "这段关系的人物资格仍需核实。" :
          homeContent.reason === "sources" ? "原有依据已经变更或无法核对，请重新读取。" :
          homeContent.reason === "processing" ? "材料仍在整理，稍后可以再读一次。" : "请重新读取后继续查看。"}</span>
        {book.onRetryContent && <button className={styles.textAction} type="button" onClick={book.onRetryContent}>重新读取相关内容 <Icon name="go" /></button>}
      </div>}
      {homeContent.status === "ready" && homeContent.refresh === "failed" && <div className={styles.stateNote} role="status">
        <p>暂时未能更新，下面仍是上次读到的材料。</p>
        {book.onRetryContent && <button className={styles.textAction} type="button" onClick={book.onRetryContent}>重新读取相关内容 <Icon name="go" /></button>}
      </div>}
      <div className={styles.appendices}>
        {batches.map(({title, variant, items, empty}) => <section key={title} className={`${styles.group} ${variant === "meeting" ? styles.meetingNote : styles.personJournal}`} data-home-note={variant} aria-label={title}>
          <h3>{title}</h3>
          {items.slice(0, 2).sort((a,b) => Number(b.kind === "open_promise") - Number(a.kind === "open_promise")).map(item => {
            const copy = presentBookHomeMaterial(item);
            return <article className={styles.material} data-home-material="" data-kind={item.kind} key={item.kind + ":" + item.sources.map(s => s.id).join(",")}>
              <div className={styles.materialHeading}>
                <small className={styles.materialKind}>{copy.followUpTopic ? "可以接着聊" : labels[item.kind]}</small>
                {copy.status && <span className={styles.materialStatus} data-material-status="">{copy.status}</span>}
              </div>
              <p className={styles.materialCopy} data-material-copy="">{copy.text}</p>
              {copy.reason && <p className={styles.reason} data-material-reason="">{copy.reason}</p>}
              <RelationSources sources={item.sources} onOpenSource={onOpenSource} readingKey={JSON.stringify([title,item.kind,...item.sources.map(source=>source.id)])} />
            </article>;
          })}
          {!items.length && !participantNotice && (homeContent.status === "empty" && !homeContent.note || homeContent.status === "ready") &&
            <p className={styles.notice}>{empty}</p>}
          {homeContent.status === "loading" && !participantNotice && <div className={styles.materialWaiting} aria-hidden="true">
            <span className={styles.summaryPaper}><i/><i/><i/></span>
          </div>}
        </section>)}
      </div>
    </div>
  </section>;
}

export function BookHome(props: BookHomeProps) {
  const { book, currentInteraction, uploadState: state, file, recordingDate, dateMax, toySelection,
    open, onOpenChange, onDate, onSelectFile, onSubmit, renderToy, onRetryRead } = props;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [reading, setReading] = useState(false);
  const [resumeScope, setResumeScope] = useState<string>();
  useEffect(() => {
    if (!book.scopeKey || !book.relationshipId) return;
    const abort = new AbortController();
    const scope = book.scopeKey;
    void preparationRequest<PreparationCatalog>("", { signal: abort.signal }).then(catalog => {
      if (!abort.signal.aborted) setResumeScope(catalog.preparations[0]?.relationshipId === book.relationshipId ? scope : undefined);
    }).catch(() => { if (!abort.signal.aborted) setResumeScope(undefined); });
    return () => abort.abort();
  }, [book.scopeKey, book.relationshipId]);
  const readLatch = useRef(false);
  const previousForm = bookHomeForm(book.scopeKey);
  const lastAttempt = useRef<File | null>(previousForm?.uploadStateKey === JSON.stringify([state.status,state.uploadId]) ? previousForm.attemptedFile : null);
  const returnPoint = useRef(bookHomeReading(book.scopeKey));
  const fileInput = useRef<HTMLInputElement>(null);
  const progressAction = useRef<HTMLButtonElement>(null);
  const readyAction = useRef<HTMLAnchorElement>(null);
  const retryAction = useRef<HTMLButtonElement>(null);
  const waitingForNextAction = useRef(false);
  const uploadFold = useRef<HTMLDivElement>(null);
  const foldIntent = useRef<{ open: boolean; pointer: boolean } | null>(null);
  const busy = state.status === "uploading" || state.status === "processing";
  const current = !state.uploadId || state.uploadId === currentInteraction?.sourceUploadId ||
    state.uploadId === currentInteraction?.id ? currentInteraction : null;
  const acceptedFailure = state.status === "failed" && Boolean(state.hasReceipt || state.failureStage && state.failureStage !== "upload");
  const uploadFailed = state.status === "failed" && !acceptedFailure;
  const ready = state.status === "ready" || (state.status === "idle" && current?.status === "ready");
  const confirmed = ready && current?.persistenceStatus === "confirmed";
  const savedOnRight = confirmed && book.lastSaved?.id === current?.relationshipInteractionId;
  const title = state.fileName || (busy ? file?.name : null) || current?.fileName;
  const meetingDate = state.recordingDate || (busy && file ? recordingDate : null) || current?.recordingDate;
  const formVisible = open && !busy;
  const previousFormVisible = useRef(formVisible);
  const canReadAgain = acceptedFailure || Boolean(state.cacheErrorMessage || state.cleanupWarningMessage);
  function settleUploadFold() {
    const sheet = uploadFold.current;
    if (!sheet) return;
    sheet.dataset.foldMotion = "static";
    // End already-created CSS transitions as well as disabling future ones.
    // This also covers a media preference changing between compositor frames.
    for (const animation of sheet.getAnimations?.() ?? []) animation.cancel();
  }
  useLayoutEffect(() => {
    if (previousFormVisible.current === formVisible) return;
    const intent = foldIntent.current;
    if (uploadFold.current) {
      uploadFold.current.dataset.foldMotion = intent?.open === formVisible && intent.pointer
        && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "active" : "static";
    }
    previousFormVisible.current = formVisible;
    foldIntent.current = null;
  }, [formVisible]);
  useEffect(() => {
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const onPreference = () => { if (preference?.matches) settleUploadFold(); };
    preference?.addEventListener("change", onPreference);
    window.addEventListener("pagehide", settleUploadFold);
    return () => {
      preference?.removeEventListener("change", onPreference);
      window.removeEventListener("pagehide", settleUploadFold);
    };
  }, []);
  useEffect(() => {
    // A source visit is consumed even when its old button is no longer present.
    // This mounted page retains only its pending focus/position restoration.
    clearBookHomeReading(book.scopeKey);
    const abandonPendingFocus = () => { returnPoint.current = null; };
    for (const event of ["pointerdown","keydown","input"]) document.addEventListener(event,abandonPendingFocus,true);
    return () => {
      for (const event of ["pointerdown","keydown","input"]) document.removeEventListener(event,abandonPendingFocus,true);
    };
  }, [book.scopeKey]);
  useEffect(() => {
    rememberBookHomeForm(book.scopeKey, {uploadStateKey:JSON.stringify([state.status,state.uploadId]),
      attemptedFile:lastAttempt.current,file,recordingDate,fileError:props.fileError,toySelection,open});
  }, [book.scopeKey,state.status,state.uploadId,file,recordingDate,props.fileError,toySelection,open]);
  useEffect(() => {
    const point = returnPoint.current;
    if (!point) return;
    const target = [...document.querySelectorAll<HTMLButtonElement>("[data-home-source-link]")]
      .find(button => button.dataset.homeSourceLink === point.focusKey);
    if (!target && props.homeContent.status === "loading") return;
    const fallback = document.querySelector<HTMLElement>("[data-home-relations]");
    for (const details of document.querySelectorAll<HTMLDetailsElement>("[data-home-source-group]")) {
      details.open = point.openSources.includes(details.dataset.homeSourceGroup || "");
    }
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      if (returnPoint.current !== point) return;
      if (target) {
        target.focus({preventScroll:true});
        window.scrollTo({left:point.scrollX,top:point.scrollY,behavior:"instant"});
      } else {
        fallback?.focus({preventScroll:true});
        fallback?.scrollIntoView({block:"center",behavior:"instant"});
      }
      returnPoint.current = null;
    }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [book.scopeKey, props.homeContent]);
  const openSource: CompanionHomeProps["onOpenSource"] = props.onOpenSource ? async (source, segmentId) => {
    if (book.scopeKey) {
      rememberBookHomeReading({scopeKey:book.scopeKey,uploadId:source.uploadId,segmentId,
        focusKey:(document.activeElement as HTMLElement | null)?.dataset.homeSourceLink || "",
        openSources:[...document.querySelectorAll<HTMLDetailsElement>("[data-home-source-group]")].filter(item=>item.open).map(item=>item.dataset.homeSourceGroup || ""),
        scrollX:window.scrollX,scrollY:window.scrollY,
        form:{uploadStateKey:JSON.stringify([state.status,state.uploadId]),attemptedFile:lastAttempt.current,file,recordingDate,fileError:props.fileError,toySelection,open}
      });
    }
    await props.onOpenSource?.(source,segmentId);
  } : undefined;
  useEffect(() => {
    if ((!file || toySelection) && fileInput.current) fileInput.current.value = "";
    if (!waitingForNextAction.current) return;
    if (document.activeElement !== document.body && !document.activeElement?.closest("[data-home-current],#home-upload-form")) {
      waitingForNextAction.current = false;
      return;
    }
    if (state.status === "processing") progressAction.current?.focus({preventScroll: true});
    if (ready || state.status === "failed") {
      (ready ? readyAction.current : retryAction.current)?.focus({preventScroll: true});
      waitingForNextAction.current = false;
    }
  }, [file, ready, state.status, toySelection]);
  async function readAgain() {
    if (readLatch.current) return;
    readLatch.current = true;
    setReading(true);
    try { await onRetryRead(); }
    finally { readLatch.current = false; setReading(false); }
  }
  function closeForm(pointer = false) {
    foldIntent.current = { open: false, pointer };
    onOpenChange(false);
    toggleRef.current?.focus({ preventScroll: true });
  }
  return <div className={styles.spread} data-book-home="">
    <section className={styles.today} aria-labelledby="home-today">
      <div className={styles.words}>
        <LocalTimeGreeting className={styles.greeting} />
        <h1 id="home-today">今天，有什么<br />值得留在心里？</h1>
        <div className={styles.actions}>
          {(busy || ready || acceptedFailure) && <section className={styles.current} data-home-current="" aria-label="本次录音">
            {title && <p className={styles.fileTitle}>{title}</p>}
            <div className={styles.recordMeta} role="status">
              <span>{confirmed ? "本次复盘已保存" : ready ? book.currentRecapHref ? "整理完成 · 可查看复盘" : "录音已整理" : props.statusLabel}</span>
              {meetingDate && <time dateTime={meetingDate}>{meetingDate}</time>}
              {state.status === "processing" && typeof state.progress === "number" && <span>{Math.round(state.progress)}%</span>}
            </div>
            {ready && !savedOnRight && book.currentRecapHref && <Link ref={readyAction} className={styles.recapAction} href={book.currentRecapHref} aria-label={`查看录音复盘：${title || current?.title || meetingDate || "本次录音"}`}>查看录音复盘 <Icon name="go" /></Link>}
            {state.status === "processing" && <button ref={progressAction} className={styles.recapAction} type="button" disabled={reading} onClick={() => void readAgain()}>{reading ? "正在查询进度…" : "查看整理进度"} <Icon name="go" /></button>}
          </section>}
          {state.errorMessage && <p role="alert" className={styles.error}>{state.errorMessage}</p>}
          {state.cacheErrorMessage && <p role="alert" className={styles.error}>{state.cacheErrorMessage}</p>}
          {state.cleanupWarningMessage && <p role="alert" className={styles.error}>{state.cleanupWarningMessage}</p>}
          {canReadAgain && <button ref={acceptedFailure ? retryAction : undefined} type="button" className={styles.textAction} disabled={reading} onClick={() => void readAgain()}>{reading ? "正在读取…" : "重新读取结果"}</button>}
          <div className={styles.controls}>
            {!busy && <button id="home-upload-toggle" className={formVisible || (ready && !savedOnRight) ? styles.toggleOpen : styles.primary} ref={toggleRef}
              type="button" aria-expanded={formVisible} aria-controls="home-upload-form" onClick={event => {
                if (open) closeForm(event.detail > 0);
                else { foldIntent.current = { open: true, pointer: event.detail > 0 }; onOpenChange(true); }
              }}>
              {(!formVisible || ready) && <Icon name="upload" />} 上传这次相处的录音 {formVisible && <Icon name="up" />}
            </button>}
            {renderToy && <BookToyDialog busy={busy} scope={book.scopeKey} triggerClassName={styles.toyTrigger}
              trigger={<><Icon name="plug" />连接玩偶</>} renderToy={renderToy} />}
          </div>
          <div ref={uploadFold} className={styles.uploadFold} data-upload-fold="" data-open={formVisible} data-fold-motion="static"
            aria-hidden={!formVisible} inert={!formVisible}>
          <div className={styles.uploadClip}>
          <form id="home-upload-form" aria-label="上传相处录音" className={styles.form}
            onFocusCapture={settleUploadFold} onPointerDownCapture={settleUploadFold} onInputCapture={settleUploadFold} onSubmit={event => {
            if (acceptedFailure && lastAttempt.current === file) { event.preventDefault(); return; }
            lastAttempt.current = file;
            waitingForNextAction.current = true;
            void onSubmit(event);
          }}
            onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); closeForm(); } }}>
            <div className={styles.fileRow} data-selected={!!file}>
              {file && <span className={styles.fileInfo}><Icon name="file" /><span>{file.name}
                <small>{toySelection && "已从玩偶带入 · "}{fileSize(file.size)}</small></span></span>}
              <label className={file ? styles.replace : styles.pick}><input ref={fileInput} id="home-audio-file" type="file" aria-label={file ? "更换录音文件" : "选择录音文件"}
                accept="audio/*,.m4a,.mp3,.wav,.aac,.flac,.ogg,.opus,.mp4,.mov,.webm"
                onChange={event => onSelectFile(event.target.files?.[0] ?? null)} />
                {!file && <Icon name="file" />}{file ? "更换" : "选择录音文件"}
              </label>
              {!file && <small className={styles.fileLimit}>单个文件不超过 300 MB</small>}
            </div>
            {props.fileError && <p className={styles.error} role="alert">{props.fileError}</p>}
            <div className={styles.dateRow}>
              {toySelection ? <><span>相处日期</span><time dateTime={recordingDate}>{recordingDate}</time></> :
                <><label htmlFor="home-date">相处日期</label>
                  <input id="home-date" type="date" required max={dateMax} value={recordingDate} onChange={event => onDate(event.target.value)} /></>}
            </div>
            {toySelection && <p className={styles.consent}>{toySelection.recordingDateLocked ? "重试沿用第一次上传的录音日期。" : "日期来自玩偶录音。"}</p>}
            <p className={styles.consent}>复盘内容由你逐条确认。长期记忆可另行选择。</p>
            <button ref={uploadFailed ? retryAction : undefined} type="submit" className={styles.submit} disabled={!file || !recordingDate || recordingDate > dateMax || (acceptedFailure && lastAttempt.current === file)}>
              {uploadFailed && lastAttempt.current === file ? "重新上传" : "开始上传"} <Icon name="go" />
            </button>
          </form>
          </div>
          </div>
          <Link className={styles.prepare} href={book.href("/date-companion/a/prepare")}>{resumeScope && resumeScope === book.scopeKey ? "继续这次讨论" : "打开准备手帐"} <Icon name="go" /></Link>
        </div>
      </div>
      <div className={styles.art} aria-hidden="true" />
    </section>
    <RightPage {...props} onOpenSource={openSource} />
  </div>;
}
