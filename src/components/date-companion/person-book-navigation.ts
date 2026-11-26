"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { sourcePaperEntry, type SourcePaperEntry } from "./source-paper-motion";

type ReaderRoute = { sourceId: string | null; fullId: string | null };
type ReadingPoint = { x: number; y: number; focus: string; top: number };
const closed: ReaderRoute = { sourceId: null, fullId: null };

function readerRoute(): ReaderRoute {
  const query = new URLSearchParams(location.search);
  const sourceId = query.get("personSource");
  return { sourceId, fullId: sourceId ? query.get("personFull") : null };
}

function pointKey(scope: string) {
  const url = new URL(location.href);
  url.searchParams.delete("personSource");
  url.searchParams.delete("personFull");
  url.searchParams.delete("resumeMeeting");
  // Preserve the storage key that existing read points used. Clean and old
  // URLs still name the same page and can restore the same point.
  url.searchParams.set("view", "book");
  url.searchParams.set("from", "book-home");
  url.searchParams.sort();
  return JSON.stringify(["db:person-book:return:1", scope, url.pathname, url.search]);
}

function writePoint(scope: string, trigger: HTMLElement) {
  const focus = trigger.dataset.personReadingKey;
  if (!focus) return;
  const key = pointKey(scope);
  const point: ReadingPoint = { x: scrollX, y: scrollY, focus, top: trigger.getBoundingClientRect().top };
  // Entry-specific state serves browser Back. The one-shot fallback serves the
  // recap's explicit return link, which can create a new App Router entry.
  history.replaceState({ ...history.state, personBookPoint: { key, point } }, "");
  try { sessionStorage.setItem(key, JSON.stringify(point)); } catch { /* History still works. */ }
}

export function usePersonBookNavigation(scope: string, ready: boolean, isActiveEntry?: () => boolean) {
  const [locationState, setLocationState] = useState<ReaderRoute>(closed);
  const [sourceEntry, setSourceEntry] = useState<SourcePaperEntry | null>(null);
  const restoring = useRef<{ key: string; point: ReadingPoint } | null>(null);
  const arrival = useRef({ scope, isActiveEntry });
  if (arrival.current.scope !== scope) arrival.current = { scope, isActiveEntry };
  useLayoutEffect(() => {
    const sync = (restore = true) => {
      setSourceEntry(null); // History/refresh restores a layer, never a new open.
      const next = readerRoute();
      restoring.current = null;
      if (restore && !next.sourceId) {
        const key = pointKey(scope);
        const saved = history.state?.personBookPoint;
        const url = new URL(location.href);
        const meetingId = url.searchParams.get("resumeMeeting");
        let point: ReadingPoint | null = saved?.key === key ? saved.point : null;
        if (meetingId) {
          // Only the recap's explicit return carries this record identity. Capture at
          // arrival: a late read on the departing page cannot consume its own marker.
          try {
            const stored = JSON.parse(sessionStorage.getItem(key) || "null") as ReadingPoint | null;
            if (stored?.focus === "meeting-" + meetingId) point = stored;
          } catch { /* Entry state is still available. */ }
          url.searchParams.delete("resumeMeeting");
          history.replaceState({ ...history.state, personBookPoint: { key, point } }, "", url);
        }
        if (point?.focus && Number.isFinite(point.y)) restoring.current = { key, point };
      }
      setLocationState(next);
    };
    // App Router can render the destination before committing location. Read
    // the ticket here, not during render; the child's claim keeps it identifiable.
    const activeEntry = arrival.current.isActiveEntry?.() ?? false;
    if (activeEntry) {
      // This new history entry has no application read point yet. Its explicit
      // empty marker prevents a later Back from borrowing an older visit's
      // one-shot fallback. Neither the old history entry nor storage is cleared.
      history.replaceState({ ...history.state, personBookPoint: { key: pointKey(scope), point: null } }, "");
    }
    sync(!activeEntry);
    const pop = () => sync();
    window.addEventListener("popstate", pop);
    const cancel = () => { restoring.current = null; };
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("keydown", cancel, true);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("keydown", cancel, true);
    };
  }, [scope]);

  const navigate = useCallback((route: ReaderRoute, replace = false) => {
    const url = new URL(location.href);
    for (const [name, value] of [["personSource", route.sourceId], ["personFull", route.fullId]] as const) {
      if (value) url.searchParams.set(name, value);
      else url.searchParams.delete(name);
    }
    const mark = { personBookReader: { scope, ...route } };
    if (replace) history.replaceState(mark, "", url);
    else history.pushState(mark, "", url);
    restoring.current = null;
    setLocationState(route);
  }, [scope]);

  const backReader = useCallback(() => {
    const here = readerRoute();
    const mark = history.state?.personBookReader;
    if (mark?.scope === scope && mark.sourceId === here.sourceId && mark.fullId === here.fullId && !mark.deepLink) {
      history.back();
      return;
    }
    // A copied link or a hard refresh without a previous layer must stay in
    // this person's book when the reader dismisses the insert.
    const next = here.fullId ? { sourceId: here.sourceId, fullId: null } : closed;
    navigate(next, true);
    history.replaceState({ ...history.state, personBookReader: { scope, ...next, deepLink: true } }, "");
  }, [navigate, scope]);

  useLayoutEffect(() => {
    if (!ready || !scope || locationState.sourceId || readerRoute().sourceId || !restoring.current) return;
    const { key, point } = restoring.current;
    if (key !== pointKey(scope) || document.querySelector("dialog:modal")) return;
    const target = document.querySelector<HTMLElement>('[data-person-reading-key="' + CSS.escape(point.focus) + '"]');
    const resultHeading = document.getElementById("person-history-results");
    const destination = target?.getClientRects().length ? target : resultHeading;
    if (!destination) return;
    restoring.current = null;
    destination.focus({ preventScroll: true });
    if (destination === target) {
      window.scrollTo({ top: Math.max(0, scrollY + target.getBoundingClientRect().top - point.top), left: point.x, behavior: "instant" });
    } else {
      destination.scrollIntoView({ block: "nearest", behavior: "instant" });
    }
    try { sessionStorage.removeItem(key); } catch { /* Optional storage. */ }
  }, [locationState, ready, scope]);

  return {
    ...locationState,
    sourceEntry,
    openSource(materialId: string, trigger: HTMLElement, detail = 0) {
      writePoint(scope, trigger);
      setSourceEntry(sourcePaperEntry(trigger, detail));
      navigate({ sourceId: materialId, fullId: null });
    },
    openFull(sourceId: string) {
      const route = readerRoute();
      if (route.sourceId && route.fullId !== sourceId) navigate({ sourceId: route.sourceId, fullId: sourceId });
    },
    backReader,
    rememberMeeting(trigger: HTMLElement) { restoring.current = null; writePoint(scope, trigger); }
  };
}
