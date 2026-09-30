"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FrameworkChapter } from "@/lib/domain/learning-framework";
import { readLearningReadingState, saveLearningReadingState, type ReadingPosition } from "./learning-reading-state";

/** Restore once on entry, never on background refresh. Node identity survives chapter moves. */
export function useLearningReadingPosition({ readingKey, chapters, ready, active, pageId }: {
  readingKey?: string; chapters: FrameworkChapter[]; ready: boolean; active: boolean; pageId: string;
}) {
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(true);
  const [navigation, setNavigation] = useState<{ chapterId: string; nodeId?: string } | null>(null);
  const reader = useRef<HTMLElement>(null), map = useRef<HTMLDetailsElement>(null);
  const initialized = useRef(false), restored = useRef(false);
  const pending = useRef<ReadingPosition | null>(null), latest = useRef<ReadingPosition | null>(null);
  const frame = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = useRef({ chapters, chapterId, active });
  current.current = { chapters, chapterId, active };

  useLayoutEffect(() => {
    if (!ready || initialized.current) return;
    initialized.current = true;
    const saved = readLearningReadingState(readingKey), query = new URLSearchParams(window.location.search);
    setMapOpen(saved.mapOpen ?? true);
    const explicit = query.get("chapter");
    // A refresh keeps our history marker; a link opened elsewhere takes precedence over local history.
    const fromReader = window.history.state?.learningReadingPage === pageId;
    const position = (!explicit || (fromReader && explicit === saved.position?.chapterId)) ? saved.position : undefined;
    const movedChapter = position?.nodeId ? chapters.find(c => c.nodes.some(n => n.id === position.nodeId)) : undefined;
    const selected = movedChapter ?? chapters.find(c => c.id === (position?.chapterId ?? explicit)) ?? chapters[0];
    setChapterId(selected?.id ?? null);
    if (selected && !query.has("material")) {
      const nodeExists = position?.nodeId && selected.nodes.some(n => n.id === position.nodeId);
      pending.current = position ? { ...position, chapterId: selected.id,
        nodeId: nodeExists ? position.nodeId : undefined,
        offset: nodeExists || (!position.nodeId && selected.id === position.chapterId) ? position.offset : 0,
      } : explicit ? { chapterId: selected.id, offset: 0 } : null;
    }
  }, [ready, chapters, readingKey, pageId]);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (latest.current) saveLearningReadingState(readingKey, { position: latest.current });
  }, [readingKey]);

  const capture = useCallback(() => {
    const state = current.current;
    if (!state.active || !restored.current || !reader.current || document.querySelector('[role="dialog"], dialog[open]')) return;
    const chapter = state.chapters.find(c => c.id === state.chapterId) ?? state.chapters[0];
    if (!chapter) return;
    const chapterElement = document.getElementById(`chapter-${chapter.id}`);
    if (!chapterElement || chapterElement.hidden) return;
    let target: HTMLElement = chapterElement;
    let nodeId: string | undefined, section: "map" | undefined;
    if (chapterElement.getBoundingClientRect().top > 140 && map.current) { target = map.current; section = "map"; }
    else for (const node of chapter.nodes) {
      const element = document.getElementById(`knowledge-${node.id}`);
      if (element && element.getBoundingClientRect().top <= 140) { target = element; nodeId = node.id; }
    }
    latest.current = { chapterId: chapter.id, nodeId, section, offset: -target.getBoundingClientRect().top };
    clearTimeout(timer.current); timer.current = setTimeout(flush, 200);
  }, [flush]);

  useEffect(() => {
    if (!ready || !active || !initialized.current) return;
    restored.current = false;
    let cancelled = false, first = 0, second = 0;
    first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      if (cancelled) return;
      const position = pending.current ?? latest.current;
      if (position) {
        const target = position.section === "map" ? map.current : document.getElementById(position.nodeId ? `knowledge-${position.nodeId}` : `chapter-${position.chapterId}`);
        if (target && !target.closest("[hidden]")) window.scrollTo({ top: Math.max(0, window.scrollY + target.getBoundingClientRect().top + position.offset), behavior: "instant" });
      }
      pending.current = null; restored.current = true;
      capture();
    }); });
    return () => { cancelled = true; cancelAnimationFrame(first); cancelAnimationFrame(second); restored.current = false; flush(); };
    // Chapter refreshes must not re-run scroll restoration.
  }, [ready, active, capture, flush]);

  useEffect(() => {
    const onScroll = () => { cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(capture); };
    const leaving = () => { capture(); flush(); };
    const hidden = () => { if (document.visibilityState === "hidden") leaving(); };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", leaving); document.addEventListener("visibilitychange", hidden);
    return () => {
      cancelAnimationFrame(frame.current); flush();
      window.removeEventListener("scroll", onScroll); window.removeEventListener("pagehide", leaving); document.removeEventListener("visibilitychange", hidden);
    };
  }, [capture, flush]);

  const chooseChapter = (id: string, nodeId?: string) => {
    setChapterId(id);
    const url = new URL(window.location.href); url.searchParams.set("chapter", id);
    window.history.replaceState({ ...window.history.state, learningReadingPage: pageId }, "", url);
    latest.current = { chapterId: id, ...(nodeId ? { nodeId } : {}), offset: 0 }; flush();
  };
  const readInMap = (id: string, nodeId?: string) => {
    chooseChapter(id, nodeId);
    setNavigation({ chapterId: id, nodeId });
  };
  useLayoutEffect(() => {
    if (!navigation || !active || chapterId !== navigation.chapterId) return;
    const target = document.getElementById(navigation.nodeId ? `knowledge-${navigation.nodeId}` : `chapter-${navigation.chapterId}`);
    if (!target || target.closest("[hidden]")) return;
    // Navigate after React has exposed the destination chapter, rather than racing its render with rAF.
    target.scrollIntoView({ block: "start" }); target.focus({ preventScroll: true });
    setNavigation(null); capture();
  }, [navigation, chapterId, active, capture]);
  const toggleMap = (open: boolean) => { setMapOpen(open); saveLearningReadingState(readingKey, { mapOpen: open }); };
  return { reader, map, chapterId, chooseChapter, readInMap, mapOpen, toggleMap };
}
