"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { MotionConfig } from "motion/react";
import type { PreparationSource } from "@/lib/domain/date-companion-preparation";
import { DayPayloadSchema } from "@/lib/domain/day-payload";
import { dateCompanionEvidenceSpeakerRole, dateCompanionParticipantKey, dateCompanionReadingSpeakerRole } from "@/lib/domain/date-companion-speaker";
import { preparationDiscussionFromQuery } from "@/lib/domain/date-companion-book-navigation";
import { createDateCompanionApi } from "@/lib/client/date-companion-api";
import { readLocalDayPayload } from "@/lib/client/local-analysis";
import type { DateCompanionSessionValue } from "@/lib/client/date-companion-session";
import { createFormalNotebookAdapter, type FormalNotebookAdapter } from "@/lib/client/date-companion-notebook";
import { forgetPreparationSourceReturn, preparationSourceReturn, rememberPreparationSourceReturn } from "@/lib/client/preparation-source-return";
import { buildNotebookPastClues, preparationSourceTime } from "@/lib/client/date-companion-notebook-materials";
import { PreviewError, type PreviewRecord, type PreviewSnapshot } from "./prepare-notebook/model";
import { Notebook, type DiscussionFocusRequest } from "./prepare-notebook/notebook";
import "./prepare-notebook/notebook.css";

export interface CompanionPreparationBookProps {
  session: DateCompanionSessionValue;
  initialDiscussionId?: string | null;
  recordHref?: (source: PreparationSource) => string;
  onVisitSource?: (href: string) => void;
  onUnauthorized?: () => void;
}

export const preparationRestoreLabel = "正在恢复这次讨论";

const narrowSpread = "(max-width: 980px)";
const onSpreadResize = (notify: () => void) => {
  const viewport = window.matchMedia?.(narrowSpread);
  if (!viewport) return () => {};
  viewport.addEventListener("change", notify);
  return () => viewport.removeEventListener("change", notify);
};

function OpeningChat() {
  return <>
    <div className="prep-chat-scroll" aria-hidden="true"><div className="prep-opening-chat-lines"><i /><i /></div></div>
    <div className="prep-composer prep-opening-composer" aria-hidden="true">
      <span className="prep-opening-field" /><div className="prep-composer-actions" />
    </div>
  </>;
}

export function PreparationRestoring({ existing = false, chatTab = false, error, retry }: {
  existing?: boolean; chatTab?: boolean; error?: string; retry?: () => void;
}) {
  const narrow = useSyncExternalStore(onSpreadResize, () => window.matchMedia?.(narrowSpread).matches ?? false, () => false);
  const showContours = existing && !error;
  const mobileChat = showContours && narrow && chatTab;
  return <div className="prep-app prep-opening" data-embedded="true" data-mobile-view={mobileChat ? "chat" : "preparations"}>
    <div className="prep-toolbar" aria-hidden="true"><span className="prep-opening-title" /><div className="prep-opening-tools" /></div>
    <div className="prep-mobile-tabs" aria-hidden="true"><span>留下的准备</span><span>继续聊聊</span></div>
    <section className="prep-book" aria-label="准备手帐">
      <section className={mobileChat ? "prep-right prep-right-content prep-opening-mobile-chat" : "prep-left"}><header className="prep-page-head">
        <h1>{mobileChat ? "继续聊聊" : "这次想记得的事"}</h1>
        {error ? <><p role="alert">{error}</p><button className="prep-text-button" onClick={retry}>重新读取</button></> :
          <p role="status">{preparationRestoreLabel}</p>}
      </header>{mobileChat ? <OpeningChat /> : showContours ? <>
        <div className="prep-section-tabs" aria-hidden="true" />
        <div className="prep-notes-scroll" aria-hidden="true"><div className="prep-notes">
          <div className="prep-note prep-opening-note">
            <div className="prep-note-text prep-opening-ink"><i /><i /></div>
          </div>
        </div></div>
      </> : null}</section>
      {!mobileChat && <section className="prep-right"><div className="prep-right-content"><header className="prep-page-head">
        <h2>继续聊聊</h2>
        {showContours && <p className="prep-opening-subtitle" aria-hidden="true" />}
      </header>{showContours && <OpeningChat />}</div></section>}
      {mobileChat && <div className="prep-side-tabs prep-opening-side-space" aria-hidden="true" />}
    </section>
    <div className="prep-footer" aria-hidden="true" />
  </div>;
}

const subscribeWhileUnbound = () => () => {};
const unboundSnapshot = () => null;

function notebookIdentity(hasRelationship: boolean, bridge: DateCompanionSessionValue["memoryBridgeState"]): PreviewSnapshot["relationshipStatus"] {
  if (!hasRelationship) return "none";
  if (bridge.status === "ready") return bridge.mapping?.status === "confirmed" ? "established" : "unmapped";
  return bridge.status === "error" ? "unavailable" : "loading";
}

function browserDiscussionTarget(fallback: string | null | undefined) {
  if (typeof window === "undefined" || window.location.pathname !== "/date-companion/a/prepare") return fallback;
  const query = new URLSearchParams(window.location.search);
  return preparationDiscussionFromQuery(query.get("preparation"), query.get("draft"));
}

/** The wrapper owns API/session integration; Notebook stays the shared Motion
 * presentation used by both the independent sample and the real product. */
export function CompanionPreparationBook({ session, initialDiscussionId, recordHref, onVisitSource, onUnauthorized }: CompanionPreparationBookProps) {
  const current = useRef({ session, initialDiscussionId, onUnauthorized });
  current.current = { session, initialDiscussionId, onUnauthorized };
  const accountId = session.auth.status === "authenticated" ? session.auth.user.id : "";
  const relationshipKnown = session.relationshipState.status === "ready" || session.relationshipState.status === "absent";
  const relationship = session.relationshipState.status === "ready" ? session.relationshipState.relationship : null;
  const relationshipId = relationship?.id ?? "";
  const relationshipName = relationship?.displayName?.trim() || "Ta";
  const relationshipStatus = notebookIdentity(Boolean(relationshipId), session.memoryBridgeState);
  const [createdAdapter, setAdapter] = useState<FormalNotebookAdapter | null>(null);
  const owner = createdAdapter?.getSnapshot();
  const adapter = accountId && relationshipKnown && owner?.accountId === accountId && owner.relationshipId === relationshipId ? createdAdapter : null;
  const requestedNavigation = useRef<{ adapter: FormalNotebookAdapter; id: string | null | undefined } | null>(null);

  useLayoutEffect(() => {
    if (!accountId || !relationshipKnown) return;
    const api = createDateCompanionApi();
    const alive = () => current.current.session.auth.status === "authenticated" && current.current.session.auth.user.id === accountId
      && current.current.session.relationshipState.status === "ready" && current.current.session.relationshipState.relationship.id === relationshipId;
    const initialTarget = browserDiscussionTarget(current.current.initialDiscussionId);
    const returningDiscussion = preparationSourceReturn(accountId, relationshipId, initialTarget);
    const created = createFormalNotebookAdapter({ accountId, relationshipId, relationshipName,
      relationshipStatus, initialDiscussionId: initialTarget, returningDiscussion,
      onUnauthorized: () => current.current.onUnauthorized?.(),
      readRecord: async source => {
        if (!alive() || !relationshipId || !source.valid || !source.interactionId) return null;
        const detail = await api.getInteractionDetail(relationshipId, source.interactionId);
        if (!alive()) return null;
        if (detail.relationshipId !== relationshipId || detail.id !== source.interactionId || detail.sourceState === "explicitly_deleted"
          || detail.status !== "confirmed" || !detail.confirmedAt) throw new PreviewError("unavailable", "这份来源记录已不可用，请重新读取讨论。");
        const segmentId = new URL(source.href, "http://local.invalid").searchParams.get("segment");
        const evidence = detail.recapItems.filter(item => item.disposition === "kept").flatMap(item => item.evidence)
          .find(item => (item.id === source.id || `retained:${item.id}` === source.id || item.sourceSegmentId === segmentId)
            && item.quote.normalize("NFKC").trim() === source.quote.normalize("NFKC").trim());
        if (!evidence) throw new PreviewError("unavailable", "这条依据已变化或不再保留，请重新读取讨论核对。");
        const label = (role?: "self" | "companion") => role === "self" ? "我" : role === "companion" ? relationshipName : "说话人待核对";
        const savedSpeaker = label(dateCompanionEvidenceSpeakerRole(detail, evidence));
        const record: PreviewRecord = { id: detail.id, title: detail.originalName, date: detail.recordingDate, fullTranscript: false,
          sources: [source], segments: [{ id: evidence.sourceSegmentId, speaker: savedSpeaker, text: source.quote,
            time: preparationSourceTime(evidence.startSeconds) ?? "" }],
          sourceDetails: { [source.id]: { presentation: "direct_quote", speakerLabel: savedSpeaker, time: preparationSourceTime(evidence.startSeconds) } } };
        const parsed = DayPayloadSchema.safeParse(readLocalDayPayload(detail.sourceUploadId));
        if (!parsed.success || parsed.data.upload.id !== detail.sourceUploadId || (parsed.data.job?.status ?? parsed.data.upload.status) !== "ready") return record;
        const target = parsed.data.segments.find(segment => segment.id === evidence.sourceSegmentId);
        if (!target || target.text.normalize("NFKC").trim() !== source.quote.normalize("NFKC").trim()
          || target.startSeconds !== evidence.startSeconds || target.endSeconds !== evidence.endSeconds
          || (evidence.speakerId && dateCompanionParticipantKey(target) !== evidence.speakerId)) return record;
        record.fullTranscript = true;
        record.segments = [...parsed.data.segments].sort((a, b) => a.startSeconds - b.startSeconds).map(segment => ({
          id: segment.id, speaker: label(dateCompanionReadingSpeakerRole(detail, {
            uploadId: segment.uploadId, speakerId: dateCompanionParticipantKey(segment), segmentIds: [segment.id],
            quote: segment.text, startSeconds: segment.startSeconds, endSeconds: segment.endSeconds
          })), text: segment.text, time: preparationSourceTime(segment.startSeconds) ?? ""
        }));
        return alive() ? record : null;
      }
    });
    requestedNavigation.current = { adapter: created, id: initialTarget };
    setAdapter(created);
    let active = true;
    void created.load().catch(() => {}).finally(() => {
      if (active && returningDiscussion) forgetPreparationSourceReturn(returningDiscussion);
    });
    return () => {
      active = false;
      if (current.current.session.auth.status !== "authenticated" || current.current.session.auth.user.id !== accountId) created.logout();
      created.dispose();
    };
    // Material and mapping updates below do not replace a live discussion adapter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, relationshipId, relationshipKnown]);

  useEffect(() => {
    if (accountId && session.relationshipState.status === "ready") {
      void session.ensureRelationshipDetailsLoaded();
      void session.ensureMemoryBridgeLoaded();
    }
  }, [accountId, session.relationshipState.status, relationshipId, session.ensureRelationshipDetailsLoaded, session.ensureMemoryBridgeLoaded]);
  useEffect(() => {
    if (!adapter) return;
    // history.replaceState can bind a first send before Next's search-param
    // snapshot rerenders the shell. Its stale null prop must not erase that ID.
    const target = browserDiscussionTarget(initialDiscussionId);
    if (requestedNavigation.current?.adapter === adapter && requestedNavigation.current.id === target) return;
    requestedNavigation.current = { adapter, id: target };
    if (target && adapter.getSnapshot().currentDiscussionId !== target) void adapter.openDiscussion(target).catch(() => {});
    else if (target === null && adapter.getSnapshot().currentDiscussionId !== null) adapter.setCurrentDiscussion(null);
  }, [adapter, initialDiscussionId]);
  useLayoutEffect(() => { adapter?.updateContext({ relationshipName, relationshipStatus }); }, [adapter, relationshipName, relationshipStatus]);

  return <BookMaterials adapter={adapter} initialDiscussionId={initialDiscussionId} session={session} relationshipName={relationshipName} relationshipStatus={relationshipStatus} recordHref={recordHref} onVisitSource={onVisitSource} />;
}

function BookMaterials({ adapter, initialDiscussionId, session, relationshipName, relationshipStatus, recordHref, onVisitSource }: {
  initialDiscussionId?: string | null;
  adapter: FormalNotebookAdapter | null; session: DateCompanionSessionValue; relationshipName: string;
  relationshipStatus: PreviewSnapshot["relationshipStatus"];
  recordHref?: (source: PreparationSource) => string;
  onVisitSource?: (href: string) => void;
}) {
  const snapshot = useSyncExternalStore(adapter?.subscribe ?? subscribeWhileUnbound, adapter?.getSnapshot ?? unboundSnapshot, unboundSnapshot);
  const restoredAdapter = useRef<FormalNotebookAdapter | null>(null);
  const discussionFocus = useRef<DiscussionFocusRequest | null>(null);
  // The loading paper is deliberately inert. A Tab that leaves the book may
  // briefly land on BODY / browser chrome, so activeElement alone isn't enough.
  useLayoutEffect(() => {
    if (!snapshot?.loading || !discussionFocus.current) return;
    const releaseFocus = () => {
      if (discussionFocus.current) discussionFocus.current.target = "released";
    };
    document.addEventListener("keydown", releaseFocus, true);
    document.addEventListener("pointerdown", releaseFocus, true);
    return () => {
      document.removeEventListener("keydown", releaseFocus, true);
      document.removeEventListener("pointerdown", releaseFocus, true);
    };
  }, [snapshot?.loading]);
  const identityResolved = relationshipStatus !== "loading" && snapshot?.relationshipStatus === relationshipStatus;
  useLayoutEffect(() => {
    if (identityResolved && snapshot && !snapshot.loading && !snapshot.error) restoredAdapter.current = adapter;
  }, [adapter, identityResolved, snapshot]);
  const adoptedRelationship = useRef<string | null>(null);
  useEffect(() => {
    if (!snapshot) return;
    const actualId = snapshot.discussions[0]?.relationshipId;
    if (session.relationshipState.status === "absent" && actualId && adoptedRelationship.current !== actualId) {
      adoptedRelationship.current = actualId;
      // create/turn has already persisted the relationship; this only reloads
      // the shell. The adapter has moved temporary drafts to the real scope.
      // Settle the selected real ID before the shell's loading branch unmounts
      // Notebook; its own URL effect may otherwise lose the race to that branch.
      if (snapshot.currentDiscussionId && window.location.pathname === "/date-companion/a/prepare") {
        const url = new URL(window.location.href); url.searchParams.set("preparation", snapshot.currentDiscussionId); url.searchParams.delete("draft");
        window.history.replaceState(window.history.state, "", url);
      }
      void session.refreshRelationship();
    }
  }, [snapshot?.discussions, snapshot?.currentDiscussionId, session.relationshipState.status, session.refreshRelationship]);
  const materials = useMemo(() => buildNotebookPastClues({ prepare: session.viewModel.prepare, relationshipName,
    interactions: [...session.viewModel.person.interactions, ...session.viewModel.recap.history],
    speakerLabel: session.sourceSpeakerLabel
  }), [session.viewModel.prepare, session.viewModel.person.interactions, session.viewModel.recap.history, session.sourceSpeakerLabel, relationshipName]);
  useEffect(() => {
    if (!adapter) return;
    const detailError = session.detailReadState.status === "error" ? session.detailReadState.message : null;
    const memoryError = session.memoryBridgeState.status === "error" ? session.memoryBridgeState.message : null;
    const loading = session.relationshipState.status === "ready" && (!session.relationshipDetailsLoaded || session.memoryBridgeState.status === "idle" || session.memoryBridgeState.status === "loading");
    const unmapped = session.memoryBridgeState.status === "ready" && session.memoryBridgeState.mapping?.status !== "confirmed";
    adapter.updateMaterials({ ...materials,
      status: detailError || memoryError ? "error" : loading ? "loading" : unmapped && !materials.clues?.length ? "unmapped" : materials.status,
      error: detailError ?? memoryError });
  }, [adapter, materials, session.relationshipState.status, session.relationshipDetailsLoaded, session.detailReadState, session.memoryBridgeState]);
  const formalRecordHref = (source: PreparationSource) => {
    if (recordHref) return recordHref(source);
    const url = new URL(source.href, window.location.origin);
    if (url.pathname === "/date-companion/a/recap") {
      url.searchParams.delete("view");
      if (url.searchParams.get("from") === "book-home") url.searchParams.delete("from");
      url.searchParams.set("returnTo", window.location.pathname + window.location.search);
    }
    return url.pathname + url.search + url.hash;
  };
  // Read the discussion and mapping in parallel. Mount the editor only when its
  // account, discussion draft and identity projection all belong to this read.
  // A later refresh of optional person materials must not unmount a composer
  // that the user is already typing in.
  if (adapter && snapshot?.error && restoredAdapter.current !== adapter) {
    return <PreparationRestoring error={snapshot.error} retry={() => void adapter.load().catch(() => {})} />;
  }
  if (!adapter || !snapshot || snapshot.loading || (restoredAdapter.current !== adapter && !identityResolved)) {
    const target = snapshot?.currentDiscussionId ?? initialDiscussionId;
    const known = snapshot?.discussions.find(discussion => discussion.id === target);
    // A URL target is sufficient for abstract shapes, never for private text or
    // a cached mobile tab. Bind that preference to a confirmed discussion.
    const firstRead = !adapter || restoredAdapter.current !== adapter;
    const existing = firstRead && !!target && (!known || !!(known.items.length || known.messages.length));
    return <PreparationRestoring existing={existing} chatTab={!!known && adapter?.readDraft(known.id).mobileView === "chat"} />;
  }
  const visitSource = (href: string) => {
    const discussion = snapshot.currentDiscussionId && adapter.getDiscussion(snapshot.currentDiscussionId);
    if (discussion && new URL(href, window.location.origin).pathname === "/date-companion/a/recap") {
      rememberPreparationSourceReturn(snapshot.accountId, discussion);
    }
    onVisitSource?.(href);
  };
  return <MotionConfig reducedMotion="user"><Notebook adapter={adapter} embedded formalMode recordHref={formalRecordHref} discussionFocus={discussionFocus}
    onVisitSource={onVisitSource ? visitSource : undefined}
    onRetryMaterials={()=>{void session.ensureRelationshipDetailsLoaded();void session.ensureMemoryBridgeLoaded();}} /></MotionConfig>;
}
