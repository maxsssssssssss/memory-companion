"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type MouseEvent } from "react";
import { useReducedMotion } from "motion/react";
import type { DateCompanionPersonArchiveState } from "@/lib/client/date-companion-people";
import type { DateCompanionSessionValue } from "@/lib/client/date-companion-session";
import { PERSON_MATERIAL_READ_TIMEOUT_MS } from "@/lib/client/date-companion-read-deadline";
import type { DateCompanionConfirmedPerson, InteractionVM } from "@/lib/domain/date-companion";
import { bookMeetingTitle } from "./book-recap";
import { CompanionPersonReader } from "./companion-person-reader";
import { usePersonBookNavigation } from "./person-book-navigation";
import { claimPersonBookEntry, hasPersonBookEntry } from "./person-book-entrance";
import { PaperChoiceInk, usePaperChoiceMotion } from "./paper-state-motion";
import { confirmedDirectory, currentScrapbookPerson, personScrapbookContent, scrapbookReaderKey, type ScrapbookMaterial } from "./companion-person-scrapbook-model";
// These two visual stylesheets and their relative assets are shared with the calibrated
// scrapbook. Next emits the assets locally; the independent fixture app is never imported.
import "./person-scrapbook/featured.css";
import "./person-scrapbook/panels.css";
import "./companion-person-scrapbook.css";

type Props = {
  screen: "people" | "person";
  accountId: string;
  relationshipId: string | null;
  session: DateCompanionSessionValue;
  personId: string | null;
  archiveState: DateCompanionPersonArchiveState;
  onRetryArchive: () => void;
  directoryHref: string;
  personHref: (id: string) => string;
  managementHref: (kind: "people" | "privacy" | "records") => string;
  meetingHref: (id: string) => string;
};

const filterNames = { all: "全部", meeting: "历次见面", recent: "最近提到", shared: "共同经历", promise: "明确约定", archive: "人物档案", suggestion:"续聊建议" } as const;
type Filter = keyof typeof filterNames;
const dotted = (iso: string) => iso.slice(0, 10).replaceAll("-", ".");
const normalize = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
const nameOf = (person: DateCompanionConfirmedPerson) => person.displayName?.trim() || "未命名人物";
const arrow = <span aria-hidden="true" className="pa-arrow"> →</span>;
const mobileQuery = "(max-width:760px)";
function listenWidth(callback: () => void) {
  const mq = window.matchMedia(mobileQuery);
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}
function isMobile() { return window.matchMedia(mobileQuery).matches; }
function isDesktopServer() { return false; }

function setQueryParam(key: string, value: string) {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set(key, value);
  else url.searchParams.delete(key);
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

function Retry({ message, retry }: { message: string; retry: () => void }) {
  return <div className="scrap-warning" role="alert"><span>{message}</span><button type="button" onClick={retry}>重新读取</button></div>;
}

export function PersonScrapbookLoading() {
  return <section className="person-scrapbook scrap-loading" aria-label="人物">
    <div className="scrap-pagebar"><p role="status">正在翻开人物剪贴册…</p></div>
    <div className="scrap-feature" aria-hidden="true"><div className="scrap-board" data-has-lead="true" data-has-meeting="false">
      <div className="scrap-portrait"><div className="scrap-sheet scrap-landscape"><span /></div></div>
      <div className="scrap-sheet scrap-lead"><div className="prep-opening-ink"><i /><i /></div></div>
    </div></div>
  </section>;
}

function Directory({ session, personHref, managementHref }: Pick<Props, "session" | "personHref" | "managementHref">) {
  const params = useSearchParams();
  const query = params?.get("q") ?? "";
  const people = confirmedDirectory(session.memoryBridgeState);
  const currentId = currentScrapbookPerson(session.memoryBridgeState);
  const listed = people.map(person => {
    const name = nameOf(person);
    const duplicates = people.filter(other => nameOf(other) === name);
    const label = duplicates.length > 1 ? name + " · 同名人物 " + (duplicates.findIndex(other => other.id === person.id) + 1) : name;
    return { person, name, label };
  }).filter(entry => normalize(entry.label).includes(normalize(query)));
  const last = session.viewModel.recap.history.filter(m => m.persistenceStatus === "confirmed" && m.sourceState !== "explicitly_deleted")
    .sort((a, b) => b.recordingDate.localeCompare(a.recordingDate))[0];
  return <section className="pa-page pa-directory" aria-labelledby="person-directory-title">
    <div className="pa-head"><div><h1 id="person-directory-title">全部人物</h1><p>由你确认的 {people.length} 位人物</p></div>
      <Link className="pa-quiet" href={managementHref("people").split("#")[0] + "#new-person-name"}>新增人物 ＋</Link></div>
    {!currentId && <p className="scrap-warning">当前关系的人物尚待核对。 <Link href={managementHref("people")}>核对我和 Ta</Link></p>}
    {people.length > 0 && <label className="pa-search"><span>搜索人物</span><input type="search" value={query}
      onChange={e => setQueryParam("q", e.currentTarget.value)} placeholder="输入人物称呼" /></label>}
    {listed.length ? <ul className="pa-people">{listed.map(({ person, name, label }) =>
      <li key={person.id}><Link className="person-directory-link" href={personHref(person.id)}>
        <span className="pa-person-mark" aria-hidden="true">{Array.from(name)[0]}</span>
        <span className="pa-person-label"><span className="pa-person-name">{label}</span>
          <small>{person.id === currentId && last ? "最近一次见面　" + dotted(last.recordingDate) : "由你确认　" + dotted(person.confirmedAt)}</small></span>
        {person.id === currentId && <span className="pa-current">当前 Ta</span>}{arrow}
      </Link></li>)}</ul> : <div className="pa-empty"><h2>{people.length ? "没有找到这位人物" : "还没有已确认的人物"}</h2>
        {people.length ? <button type="button" onClick={() => setQueryParam("q", "")}>清除搜索</button> : <p>确认一位人物后，可以从这里翻看这个人的记录。</p>}</div>}
    <div className="pa-directory-foot"><Link className="pa-row-link" href={managementHref("privacy")}>人物设置与数据管理 {arrow}</Link></div>
  </section>;
}

type SourceButton = (material: ScrapbookMaterial, trigger: HTMLButtonElement, detail: number) => void;
function SourceLink({ material, onSource, className }: { material: ScrapbookMaterial; onSource: SourceButton; className: string }) {
  const direct = material.archiveEntry ? material.archiveEntry.sourceOrigin === "direct_conversation" :
    material.sources.length > 0 && material.sources.every(s => s.presentation === "direct_quote" && (!s.sourceOrigin || s.sourceOrigin === "direct_conversation"));
  return <button type="button" className={className} data-person-reading-key={"material-" + material.id}
    onClick={e => onSource(material, e.currentTarget, e.detail)}>{direct ? "查看原话" : "查看依据"}{arrow}</button>;
}

type MeetingLinkProps = { meeting: InteractionVM; href: (id: string) => string; remember: (trigger: HTMLElement) => void; className: string };
function MeetingLink({ meeting, href, remember, className }: MeetingLinkProps) {
  const id = meeting.relationshipInteractionId!;
  return <Link className={className} href={href(id)} data-person-reading-key={"meeting-" + id}
    onClick={(e: MouseEvent<HTMLAnchorElement>) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) remember(e.currentTarget); }}>
    翻开这次复盘{arrow}</Link>;
}

type Content = ReturnType<typeof personScrapbookContent>;
type MaterialRead = { status: "idle" | "loading" | "error" | "ready"; empty: boolean; retry: () => void; message?: string };
function MaterialReadStatus({ details, archive, recovered, archiveHref }: {
  details: MaterialRead | null; archive: MaterialRead; recovered: boolean; archiveHref: string;
}) {
  const [retried, setRetried] = useState<string[]>([]);
  const reads = [...(details ? [{ label: "相处材料", read: details }] : []), { label: "人物档案", read: archive }];
  const cold = reads.filter(({ label, read }) => !retried.includes(label) && (read.status === "idle" || read.status === "loading") && read.empty);
  const statusText = cold.length === reads.length ? "正在读取人物材料…" : cold.map(({ label }) => `正在读取${label}…`).join("");
  return <div className="scrap-read-status">
    {statusText && <p role="status">{statusText}</p>}
    {reads.map(({ label, read }) => {
      const retrying = retried.includes(label);
      const updating = (read.status === "loading" || read.status === "idle") && !read.empty;
      if (!retrying && read.status !== "error" && !updating) return null;
      const status = read.status === "error" ? read.message || `${label}读取失败。`
        : read.status === "ready" ? `${label}已读好。`
        : updating ? `正在更新${label}，已读内容仍可查看。` : "";
      return <div key={label} className="scrap-read-row" data-read-status={read.status}>
        <p role="status" tabIndex={-1}>{status || (retrying ? `正在重新读取${label}…` : "")}</p>
        {read.status === "error" && <button type="button" onClick={event => {
          // Hand off while the retry still owns focus. Later responses never reclaim it.
          if (event.currentTarget === document.activeElement) event.currentTarget.parentElement?.querySelector("p")?.focus({ preventScroll: true });
          setRetried(previous => previous.includes(label) ? previous : [...previous, label]);
          read.retry();
        }}>重新读取{label}</button>}
      </div>;
    })}
    {recovered && <p><Link href={archiveHref}>在全部经历查看补齐的材料{arrow}</Link></p>}
  </div>;
}

function Featured({ data, onSource, meetingHref, remember, archiveHref, manageHref, pending, complete, emptyConfirmed, entryScope }: {
  data: Content; onSource: SourceButton; meetingHref: Props["meetingHref"]; remember: MeetingLinkProps["remember"];
  archiveHref: string; manageHref: string; pending: boolean; complete: boolean; emptyConfirmed: boolean; entryScope: string;
}) {
  const narrow = useSyncExternalStore(listenWidth, isMobile, isDesktopServer);
  const entryPath = usePathname();
  const reduce = useReducedMotion();
  const board = useRef<HTMLDivElement>(null);
  const entrance = useRef<{ permitted: boolean } | null>(null);
  const seenPapers = useRef(new Set<string>());
  const stopped = useRef(false);
  const motions = useRef<Animation[]>([]);
  const startFrame = useRef<number | null>(null);
  const lead = data.materials.find(item => item.kind === "recent") ?? data.materials.find(item => item.kind === "archive");
  const shared = data.materials.find(item => item.kind === "shared");
  const latest = data.meetings[0];
  const reserveLead = useRef(Boolean(latest && pending));
  const excerptSlot = useRef(latest && !latest.detailLoaded ? latest.relationshipInteractionId : null);
  const reserveExcerpt = Boolean(latest && excerptSlot.current === latest.relationshipInteractionId);
  const footerShown = useRef(false);
  if (!pending) footerShown.current = true;
  const leadSlot = Boolean(lead || pending || (latest && reserveLead.current));
  useLayoutEffect(() => {
    const cancel = () => {
      if (startFrame.current !== null) cancelAnimationFrame(startFrame.current);
      startFrame.current = null;
      motions.current.forEach(animation => animation.cancel()); motions.current = [];
    };
    const stop = () => { stopped.current = true; cancel(); };
    for (const event of ["pointerdown", "keydown", "focusin", "wheel", "touchstart"] as const) document.addEventListener(event, stop, { capture: true, passive: true });
    const hidden = () => { if (document.hidden) stop(); };
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changedPreference = () => { if (preference.matches) stop(); };
    preference.addEventListener("change", changedPreference);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("resize", stop);
    return () => {
      for (const event of ["pointerdown", "keydown", "focusin", "wheel", "touchstart"] as const) document.removeEventListener(event, stop, true);
      document.removeEventListener("visibilitychange", hidden);
      preference.removeEventListener("change", changedPreference);
      window.removeEventListener("resize", stop);
      cancel();
    };
  }, []);
  useLayoutEffect(() => {
    // /people can resolve the sole verified person without another navigation.
    // Directory and management views never render Featured or claim an entrance.
    if (!/^\/date-companion\/a\/people(?:\/[^/]+)?$/.test(entryPath ?? "")) return;
    if (!entrance.current) entrance.current = { permitted: claimPersonBookEntry(entryScope, data.person!.id) };
    if (reduce || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      stopped.current = true;
      motions.current.forEach(animation => animation.cancel()); motions.current = [];
    }
    if (!entrance.current.permitted || stopped.current) return;
    // Schedule only the decoration. Content is already readable and usable.
    // StrictMode can dispose/recreate an effect before paint without starting
    // two paper groups or marking never-started papers as already seen.
    const frame = requestAnimationFrame(() => {
      startFrame.current = null;
      if (stopped.current || !board.current?.isConnected) return;
      const papers = [...(board.current?.querySelectorAll<HTMLElement>("[data-paper-key]") ?? [])];
      const mobile = window.matchMedia(mobileQuery).matches;
      const first = seenPapers.current.size === 0;
      const fresh = papers.filter(paper => !seenPapers.current.has(paper.dataset.paperKey!));
      fresh.forEach(paper => seenPapers.current.add(paper.dataset.paperKey!));
      // Motion Prompt #143 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#143
      // Motion Prompt #002 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#002
      // Project adaptation: complete sheets settle once per active navigation; no exploded-phone loop,
      // bar growth or text scaling. The normal-speed sequence ends in the original B layout.
      const parts = {
        landscape: { x: -14, y: -28, angle: -2, duration: 400, delay: 0 },
        lead: { x: 18, y: -34, angle: 2.5, duration: 460, delay: 65 },
        shared: { x: -7, y: -16, angle: -1, duration: 330, delay: 140 },
        meeting: { x: 8, y: -18, angle: 1.2, duration: 330, delay: 180 }
      };
      // Batch geometry reads before starting any visual writes.
      const visible = fresh.map(paper => ({ paper, box: paper.getBoundingClientRect() })).filter(({ paper, box }) =>
        box.bottom > 0 && box.top < innerHeight && (!mobile || ["landscape", "lead"].includes(paper.dataset.paperPart!)));
      const firstDelay = Math.min(...visible.map(({ paper }) => parts[paper.dataset.paperPart as keyof typeof parts].delay));
      for (const { paper } of visible) {
        if (typeof paper.animate !== "function") continue;
        const part = parts[paper.dataset.paperPart as keyof typeof parts];
        const duration = mobile ? 420 : part.duration;
        const delay = first ? part.delay : part.delay - firstDelay;
        const x = mobile ? part.x * .7 : part.x, y = mobile ? Math.max(part.y, -24) : part.y;
        const angle = mobile ? Math.max(-1.5, Math.min(1.5, part.angle)) : part.angle;
        motions.current.push(paper.animate([
          { transform: `translate3d(${x}px,${y}px,0) rotate(${angle}deg)` },
          { transform: "translate3d(0,0,0) rotate(0deg)" }
        ], { duration, delay, easing: "cubic-bezier(.23,1,.32,1)", fill: "backwards" }));
        const shadow = paper.querySelector<HTMLElement>(".scrap-landing-shadow");
        if (shadow) motions.current.push(shadow.animate([{ opacity: .7, transform: "translate3d(7px,10px,0)" }, { opacity: 0, transform: "translate3d(0,0,0)" }],
          { duration: duration + 55, delay, easing: "cubic-bezier(.23,1,.32,1)", fill: "backwards" }));
      }
    });
    startFrame.current = frame;
    return () => {
      cancelAnimationFrame(frame);
      if (startFrame.current === frame) startFrame.current = null;
    };
  }, [entryPath, entryScope, data.person, lead?.id, shared?.id, latest?.id, narrow, reduce, leadSlot]);
  const name = nameOf(data.person!);
  const longName = Array.from(name).length > 9;
  const parts = longName ? /^(.+?)(（[^（）]+）|\([^()]+\))$/u.exec(name) : null;
  const byline = (item: ScrapbookMaterial) => <div className="scrap-byline"><time dateTime={item.date}>{dotted(item.date)}</time>
    <SourceLink material={item} onSource={onSource} className="scrap-action" /></div>;
  const shadow = <span className="scrap-landing-shadow" aria-hidden="true" />;
  const sharedLeaf = shared && <section key="shared" className="scrap-sheet scrap-shared"
    data-paper-part="shared" data-paper-key="shared">{shadow}
    <span className="scrap-tape">我们一起</span><p>{shared.text}</p>{byline(shared)}</section>;
  const meetingLeaf = latest && <section key="meeting" className="scrap-sheet scrap-meeting" data-paper-part="meeting" data-paper-key="meeting">{shadow}
    <div className="scrap-meeting-head"><span className="scrap-tape">最近一次见面</span><time className="scrap-date" dateTime={latest.recordingDate}>{dotted(latest.recordingDate)}</time></div>
    <h2>{bookMeetingTitle(latest)}</h2>{latest.savedExcerpt ? <p className={reserveExcerpt ? "scrap-excerpt-space" : undefined}>{latest.savedExcerpt}</p> :
      reserveExcerpt && <p className="scrap-excerpt-space" aria-hidden="true">{!latest.detailLoaded && <span className="prep-opening-ink"><i /></span>}</p>}
    <MeetingLink meeting={latest} href={meetingHref} remember={remember} className="scrap-action" /></section>;
  return <div className="scrap-feature">
    <div ref={board} className="scrap-board" data-reserve-lead={reserveLead.current} data-has-lead={leadSlot} data-has-meeting={!!latest}>
      <div className="scrap-portrait"><div className="scrap-identity"><h1 data-long-name={longName}>
        {parts ? <>{parts[1]}<span className="scrap-name-aside">{parts[2]}</span></> : name}</h1>
        {data.isCurrent && <span className="scrap-current">当前 Ta</span>}</div>
        <div className="scrap-sheet scrap-landscape" aria-hidden="true" data-paper-part="landscape" data-paper-key="landscape"><span />{shadow}</div></div>
      {leadSlot && <section className="scrap-sheet scrap-lead" data-paper-part="lead" data-paper-key="lead">{shadow}
        <span className="scrap-tape">{lead?.kind === "archive" ? "人物档案" : "最近提到"}</span>
        {lead ? <><h2>{lead.text}</h2>{byline(lead)}</> : <>
          <h2 className="scrap-lead-space" aria-hidden={pending || undefined}>{pending ? <span aria-hidden="true" className="prep-opening-ink"><i /><i /></span> :
            complete ? "还没有可展示的近况" : "近况暂未读好"}</h2>
          <div className="scrap-byline" aria-hidden="true" />
        </>}
      </section>}
      {narrow ? [meetingLeaf, sharedLeaf] : [sharedLeaf, meetingLeaf]}
      {!lead && !shared && !latest && emptyConfirmed && <div className="scrap-empty"><h2>这里还没有可翻看的内容</h2>
        <p>{data.isCurrent ? "有了已保存的见面，便可从这里重开。" : "有可核对出处的人物材料时，会出现在这里。"}</p></div>}
    </div>
    {footerShown.current && <><div className="scrap-end"><Link className="scrap-all" href={archiveHref}>全部经历 {arrow}</Link></div>
      {data.isCurrent && <footer className="scrap-foot"><Link href={manageHref}>人物与数据设置</Link></footer>}</>}
  </div>;
}

// Reserve the intrinsic size of the current API's finite error messages, rather
// than fixing a height or clipping a longer explanation on a narrow screen.
const searchStatusReserve = [
  "本次检索未完成。内容已经在别处更新，请重新读取后再试。",
  "本次检索未完成。这段记录不存在，或已经无法访问。",
  "本次检索未完成。这项内容还不符合保存条件，请核对人物和原话来源。",
  "本次关系材料检索已完成，查到 999 条匹配材料。"
];


function searchFailureText(message: string) {
  // Transport errors are not user-facing explanations. Do not guess their
  // cause, but keep meaningful Chinese business errors supplied by the API.
  const detail = message.trim();
  return detail !== "搜索没有完成" && /[\u3400-\u9fff]/.test(detail) && !/Failed to fetch|NetworkError|Load failed|Network request failed|fetch failed/i.test(detail)
    ? "本次检索未完成。" + detail
    : "关系材料检索未完成。";
}

function Archive({ data, name, sectionHref, managementHref, filter, query, onSource, meetingHref, remember, session, complete, scope }: {
  data: Content; name: string; sectionHref: string; managementHref: Props["managementHref"];
  filter: Filter; query: string; onSource: SourceButton; meetingHref: Props["meetingHref"];
  remember: MeetingLinkProps["remember"]; session: DateCompanionSessionValue; complete: boolean; scope: string;
}) {
  const [failed, setFailed] = useState<{ id: string; message: string; target: "open" | "done" } | null>(null);
  const options: Filter[] = data.isCurrent ? ["all", "meeting", "recent", "shared", "promise", "archive"] : ["all", "archive"];
  if (data.isCurrent && data.materials.some(m => m.kind === "suggestion")) options.push("suggestion");
  const selected = options.includes(filter) ? filter : "all";
  const filterRail = useRef<HTMLDivElement>(null);
  const choice = usePaperChoiceMotion({ container: filterRail, value: selected, scope });
  const needle = normalize(query);
  const search = session.searchState;
  const isSearch = data.isCurrent && search.status !== "idle" && search.query === query.trim();
  const searchPhase = isSearch ? search.status : "idle";
  const searching = searchPhase === "loading";
  const searchIds = new Set(isSearch && search.status === "ready" ? search.results.map(r => r.id) : []);
  const searchCount = data.materials.filter(m => searchIds.has(m.promise?.originatingRecapItemId ?? m.id)).length;
  const expandedResults = isSearch && search.status === "ready";
  const searchMessage = isSearch && search.status === "error" ? searchFailureText(search.message)
    : searching ? "正在检索关系材料…"
    : expandedResults ? `关系材料匹配 ${searchCount} 条，已合并到下方结果。`
    : "";
  const matches = [
    ...data.meetings.map(meeting => ({ kind: "meeting" as const, id: meeting.relationshipInteractionId!,
      date: meeting.recordingDate, text: bookMeetingTitle(meeting), summary: meeting.savedExcerpt, meeting })),
    ...data.materials.map(material => ({ kind: material.kind, id: material.id,
      date: material.date, text: material.text, summary: material.archiveEntry?.title, material }))
  ].filter(row => !needle ||
    normalize([row.text, row.summary, row.date, dotted(row.date), filterNames[row.kind]].join(" ")).includes(needle) ||
    row.kind !== "meeting" && searchIds.has(row.material.promise?.originatingRecapItemId ?? row.id))
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const rows = selected === "all" ? matches : matches.filter(row => row.kind === selected);
  const saving = session.mutationState.status === "saving";
  async function changePromise(material: ScrapbookMaterial) {
    const promise = material.promise;
    if (!data.isCurrent || !promise || saving) return;
    const retry = failed?.id === promise.id;
    const target = retry ? failed.target : promise.status === "done" ? "open" : "done";
    try { await session.updatePromise(promise.id, promise.version, target, { reconcile: retry }); setFailed(null); }
    catch (error) { setFailed({ id: promise.id, target, message: error instanceof Error ? error.message : "约定状态暂时没有保存，请重试。" }); }
  }
  function submitSearch(event: FormEvent) {
    event.preventDefault();
    if (data.isCurrent && query.trim() && !searching) void session.searchRelationship(query.trim());
  }
  return <section className="pa-page pa-archive" aria-labelledby="person-history-title">
    <Link className="pa-back" href={sectionHref}>← 返回{name}</Link>
    <div className="pa-head"><div><h1 id="person-history-title">全部经历</h1>
      <p>{data.isCurrent ? name + "的已确认材料与本段关系已保存的见面" : name + "的可追溯人物档案"}</p></div></div>
    <form className="pa-search" onSubmit={submitSearch}>
      <label htmlFor="person-history-search">筛选已读经历</label>
      <input id="person-history-search" type="search" value={query} placeholder="关键词或日期"
        onChange={e => setQueryParam("q", e.target.value)} />
      {data.isCurrent && <button type="submit" data-search-submit="" aria-disabled={!query.trim() || searching}
        aria-busy={searching}>{searchPhase === "error" ? "重试检索" : "检索关系材料"}</button>}
    </form>
    {data.isCurrent && <div className="scrap-search-status" data-search-phase={searchPhase}>
      {searchStatusReserve.map(message => <div className="scrap-search-reserve" aria-hidden="true" key={message}>{message}</div>)}
      <div id="person-history-search-status" role="status" aria-atomic="true"><p>{searchMessage}</p></div>
    </div>}
    {data.isCurrent && <div ref={filterRail} className="pa-filters" role="group" aria-label="按内容筛选">{options.map(key =>
      <button type="button" key={key} data-paper-choice-value={key} aria-pressed={selected === key}
        onClick={event => { if (choice.choose(key, event.detail)) setQueryParam("filter", key === "all" ? "" : key); }}>{filterNames[key]}</button>)}
      <PaperChoiceInk inkRef={choice.ink} /></div>}
    <div className="pa-order"><h2 id="person-history-results" tabIndex={-1} aria-live="polite">{filterNames[selected]} · {expandedResults ? "匹配" : needle ? "已读匹配" : "已读"} {rows.length} 条</h2><span>按记录日期，从近到远</span></div>
    {rows.length ? <ol className="pa-timeline">{rows.map(row => <li key={row.kind + row.id}>
      <time dateTime={row.date}>{dotted(row.date)}</time>
      <div className="pa-entry"><small>{row.kind === "meeting" ? "已保存的复盘" : filterNames[row.kind]}{row.kind === "promise" && row.material.promise && (row.material.promise.status === "done" ? " · 已完成" : " · 仍在继续")}</small>
        {row.kind === "meeting" ? <><h2>{row.text}</h2>{row.summary && <p>{row.summary}</p>}</> :
          <>{row.material.archiveEntry && row.summary && row.summary !== row.text && <h2>{row.summary}</h2>}<p className="pa-entry-main">{row.text}</p></>}</div>
      <div className="pa-entry-actions">{row.kind === "meeting" ?
        <MeetingLink meeting={row.meeting} href={meetingHref} remember={remember} className="pa-text" /> :
        <><SourceLink material={row.material} onSource={onSource} className="pa-text" />
          {row.material.promise && <button type="button" className="pa-text pa-secondary" disabled={saving} onClick={() => void changePromise(row.material)}>
            {failed?.id === row.material.promise.id ? "重试保存" : row.material.promise.status === "done" ? "恢复为仍在继续" : "标为已完成"}</button>}
          {failed?.id === row.id && <span role="alert">{failed.message}</span>}</>}</div>
    </li>)}</ol> : <div className="pa-empty"><h2>{matches.length ? "匹配的记录在其他分类" : needle ? "已读经历中没有匹配记录" : complete ? "这一栏还没有记录" : "当前还没有读到这一栏的记录"}</h2></div>}
    {data.isCurrent && <div className="pa-directory-foot"><Link className="pa-row-link" href={managementHref("records")}>管理相处记录 {arrow}</Link></div>}
  </section>;
}

export function CompanionPersonScrapbook(props: Props) {
  const { session, screen, relationshipId, personId, archiveState } = props;
  const params = useSearchParams();
  const pathname = usePathname();
  const query = params?.get("q") ?? "";
  const sourceParams = new URLSearchParams(params?.toString());
  for (const key of ["personSource", "personFull", "resumeMeeting"]) sourceParams.delete(key);
  const pageHref = pathname + (sourceParams.size ? "?" + sourceParams : "");
  const section = sourceParams.get("section");
  const state = session.memoryBridgeState;
  const data = personScrapbookContent(personId, state, archiveState, session.viewModel, relationshipId);
  const details: MaterialRead | null = data.isCurrent ? {
    status: session.relationshipDetailsLoaded ? "ready" : session.detailReadState.status === "ready" ? "idle" : session.detailReadState.status,
    empty: !data.meetings.some(meeting => meeting.detailLoaded) && !data.materials.some(material => material.kind !== "archive"),
    message: session.detailReadState.status === "error" ? session.detailReadState.message : undefined,
    retry: () => void session.ensureRelationshipDetailsLoaded({ timeoutMs: PERSON_MATERIAL_READ_TIMEOUT_MS })
  } : null;
  const archive: MaterialRead = {
    status: archiveState.status === "not_found" ? "error" : archiveState.status === "ready" ? archiveState.refresh ?? "ready" : archiveState.status,
    empty: !data.materials.some(material => material.kind === "archive"), retry: props.onRetryArchive,
    message: archiveState.status === "error" || archiveState.status === "ready" ? archiveState.message : undefined
  };
  const pending = archiveState.status === "loading" || archiveState.status === "idle" || details?.status === "loading" || details?.status === "idle";
  const complete = (!data.isCurrent || session.relationshipDetailsLoaded) && archiveState.status === "ready";
  const hasError = details?.status === "error" || archive.status === "error";
  const scope = JSON.stringify([props.accountId, relationshipId, personId]);
  const presentation = useRef<{ scope: string; held: boolean; data: Content } | null>(null);
  if (!presentation.current || presentation.current.scope !== scope) presentation.current = { scope, held: false, data };
  // Only the exceptional, partially-read composition keeps its paper positions.
  // The latest authoritative model still supplies identities, source eligibility,
  // removals and all archive rows; this is not a second data or permission cache.
  if (!presentation.current.held) {
    presentation.current.data = data;
    if (!pending && hasError) presentation.current.held = true;
  }
  const displayed: Content = !presentation.current.held ? data : {
    ...data,
    materials: presentation.current.data.materials.flatMap(previous => {
      const current = data.materials.find(material => material.id === previous.id);
      return current ? [current] : [];
    }),
    meetings: presentation.current.data.meetings.flatMap(previous => {
      const current = data.meetings.find(meeting => meeting.relationshipInteractionId === previous.relationshipInteractionId);
      // An initially absent excerpt may wait for the archive page, but existing
      // text must follow authoritative edits/removals even if its height changes.
      return current ? [{ ...current, savedExcerpt: previous.savedExcerpt ? current.savedExcerpt : previous.savedExcerpt }] : [];
    })
  };
  const ready = Boolean(data.person && !pending);
  const entryScope = JSON.stringify([props.accountId, relationshipId]);
  const nav = usePersonBookNavigation(scope, ready, () => hasPersonBookEntry(entryScope, personId ?? data.person?.id ?? null));
  const onSource: SourceButton = (material, trigger, detail) => nav.openSource(scrapbookReaderKey(material), trigger, detail);
  const meetingHref = (id: string) => {
    const url = new URL(props.meetingHref(id), "http://localhost");
    const returnUrl = new URL(pageHref, url);
    returnUrl.searchParams.set("resumeMeeting", id);
    url.searchParams.set("returnTo", returnUrl.pathname + returnUrl.search);
    return url.pathname + url.search + url.hash;
  };
  if (state.status === "error") return <div className="person-scrapbook"><Retry message={state.message} retry={() => void session.ensureMemoryBridgeLoaded(true)} /></div>;
  if (state.status !== "ready") return <PersonScrapbookLoading />;
  if (screen === "people") return <div className="person-scrapbook"><Directory {...props} /></div>;
  if (!data.person || archiveState.status === "not_found") return <div className="person-scrapbook"><section className="pa-page">
    <Link className="pa-back" href={props.directoryHref}>← 全部人物</Link><h1>{personId ? "没有找到这位人物" : "当前关系的人物尚待核对"}</h1>
    <p>{personId ? "这位人物不存在、尚未确认，或不属于当前账号。" : "先核对这段关系中的我和 Ta，再翻开对应的剪贴册。"}</p>
    {!personId && <Link href={props.managementHref("people")}>核对我和 Ta</Link>}</section></div>;
  const detailHref = props.personHref(data.person.id);
  const archiveUrl = new URL(detailHref, "http://localhost");
  archiveUrl.searchParams.set("section", "archive");
  const name = nameOf(data.person);
  const archiveHref = archiveUrl.pathname + archiveUrl.search;
  return <div className="person-scrapbook" data-person-book-id={section ? undefined : data.person.id}>
    {section === "archive" ? <Archive data={data} name={name} sectionHref={detailHref} managementHref={props.managementHref}
      filter={(params?.get("filter") || "all") as Filter} query={query} onSource={onSource} session={session}
      meetingHref={meetingHref} remember={nav.rememberMeeting} complete={complete} scope={scope} /> : <>
      <div className="scrap-pagebar"><Link href={props.directoryHref}>← 全部人物</Link></div>
      <Featured key={scope} data={displayed} onSource={onSource} meetingHref={meetingHref} remember={nav.rememberMeeting}
        archiveHref={archiveHref} manageHref={props.managementHref("privacy")} pending={pending} complete={complete}
        emptyConfirmed={complete && !data.materials.length && !data.meetings.length}
        entryScope={entryScope} /></>}
    <MaterialReadStatus key={scope} details={details} archive={archive} archiveHref={archiveHref}
      recovered={presentation.current.held && complete && !hasError} />
    {nav.sourceId && <CompanionPersonReader material={data.materials.find(m => scrapbookReaderKey(m) === nav.sourceId)} fullId={nav.fullId}
      session={session} personId={data.person.id} personName={name} currentPerson={data.isCurrent}
      onFull={nav.openFull} onBack={nav.backReader} entry={nav.sourceEntry} />}
  </div>;
}
