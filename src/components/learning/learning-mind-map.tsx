"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import type { FrameworkChapter } from "@/lib/domain/learning-framework";
import type { OverviewResult } from "@/lib/domain/learning-study";
import { ProductDialog } from "@/components/product-system/product-primitives";
import { readLearningReadingState, saveLearningReadingState, type MindMapReadingState } from "./learning-reading-state";
import styles from "./learning-mind-map.module.css";

const relationKinds = { prerequisite: "前置知识", distinction: "概念区别", complement: "互补内容", connection: "相关联系", conflict: "材料冲突" };
const minZoom = 0.5, maxZoom = 2;

/** A view of saved chapters and relations, never a second editable knowledge graph. */
export function LearningMindMap({ chapters, relations, onChapter, onNode, renderRelation, readingKey }: {
  chapters: FrameworkChapter[];
  relations: OverviewResult["items"];
  onChapter?: (id: string) => void;
  onNode?: (chapterId: string, nodeId: string) => void;
  renderRelation: (index: number, actions?: { beforeSource: (open: () => void) => void; navigateChapter: (id: string) => void }) => ReactNode;
  readingKey?: string;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(chapters[0] ? [chapters[0].id] : []));
  const [rootOpen, setRootOpen] = useState(true);
  const [relationsOpen, setRelationsOpen] = useState(true);
  const [selectedRelation, setSelectedRelation] = useState<number | null>(null);
  const selectedRelationContent = useRef<OverviewResult["items"][number] | null>(null);
  useEffect(() => { selectedRelationContent.current = null; setSelectedRelation(null); }, [relations]);
  const relationStillCurrent = selectedRelation !== null && relations[selectedRelation] === selectedRelationContent.current;
  const viewport = useRef<HTMLDivElement>(null), canvas = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1), zoomRef = useRef(1);
  const [size, setSize] = useState({ width: 0, height: 0, viewportWidth: 0 });
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const inlineHost = useRef<HTMLDivElement>(null), fullscreenButton = useRef<HTMLButtonElement>(null);
  const [inlineHeight, setInlineHeight] = useState(0);
  const pagePosition = useRef({ left: 0, top: 0 });
  const afterClose = useRef<(() => void) | null>(null), wasFullscreen = useRef(false);
  const rememberedScroll = useRef({ left: 0, top: 0 });
  const restoreScroll = useRef<{ left: number; top: number } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readyKey = useRef<string | undefined>(undefined);
  const hasReadPreferences = useRef(false);
  const latest = useRef<MindMapReadingState>({ zoom, expanded: [...expanded], rootOpen, relationsOpen, left: 0, top: 0 });
  latest.current = { zoom, expanded: [...expanded], rootOpen, relationsOpen, ...rememberedScroll.current };
  const flushReading = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (readyKey.current === undefined) return;
    const area = viewport.current;
    if (area?.clientWidth && !restoreScroll.current) rememberedScroll.current = { left: Math.max(0, area.scrollLeft), top: Math.max(0, area.scrollTop) };
    saveLearningReadingState(readyKey.current, { map: { ...latest.current, ...rememberedScroll.current } });
  }, []);
  const scheduleReading = useCallback(() => {
    if (saveTimer.current || readyKey.current === undefined) return;
    saveTimer.current = setTimeout(flushReading, 250);
  }, [flushReading]);
  useLayoutEffect(() => {
    const saved = readLearningReadingState(readingKey).map;
    readyKey.current = readingKey;
    const scroll = saved ? { left: saved.left, top: saved.top } : { left: 0, top: 0 };
    rememberedScroll.current = scroll; restoreScroll.current = saved || hasReadPreferences.current ? scroll : null;
    hasReadPreferences.current = true;
    setZoom(saved?.zoom ?? 1); zoomRef.current = saved?.zoom ?? 1;
    setExpanded(new Set(saved?.expanded ?? (chapters[0] ? [chapters[0].id] : [])));
    setRootOpen(saved?.rootOpen ?? true); setRelationsOpen(saved?.relationsOpen ?? true);
    return () => { flushReading(); readyKey.current = undefined; };
    // Chapters are reconciled separately after their asynchronous load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readingKey, flushReading]);
  useEffect(() => {
    if (!chapters.length) return;
    const valid = new Set(chapters.map(chapter => chapter.id));
    setExpanded(previous => {
      const next = new Set([...previous].filter(chapter => valid.has(chapter)));
      return next.size === previous.size ? previous : next;
    });
  }, [chapters]);
  useEffect(scheduleReading, [zoom, expanded, rootOpen, relationsOpen, scheduleReading]);
  useEffect(() => {
    window.addEventListener("pagehide", flushReading);
    return () => { window.removeEventListener("pagehide", flushReading); flushReading(); };
  }, [flushReading]);

  const rememberViewport = useCallback(() => {
    const area = viewport.current;
    if (!area || restoreScroll.current) return;
    rememberedScroll.current = { left: Math.max(0, area.scrollLeft), top: Math.max(0, area.scrollTop) };
    scheduleReading();
  }, [scheduleReading]);
  const closeFullscreen = useCallback(() => {
    const area = viewport.current;
    if (area) rememberedScroll.current = { left: Math.max(0, area.scrollLeft), top: Math.max(0, area.scrollTop) };
    restoreScroll.current = { ...rememberedScroll.current };
    setFullscreen(false);
  }, []);
  const leaveFor = (action: () => void) => {
    if (!fullscreen) { action(); return; }
    afterClose.current = action; closeFullscreen();
  };
  useEffect(() => {
    if (fullscreen) { wasFullscreen.current = true; return; }
    if (!wasFullscreen.current) return;
    wasFullscreen.current = false;
    const frame = requestAnimationFrame(() => {
      window.scrollTo(pagePosition.current.left, pagePosition.current.top);
      fullscreenButton.current?.focus({ preventScroll: true });
      const action = afterClose.current; afterClose.current = null; action?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [fullscreen]);
  const openFullscreen = () => {
    rememberViewport(); restoreScroll.current = { ...rememberedScroll.current };
    pagePosition.current = { left: window.scrollX, top: window.scrollY };
    setInlineHeight(inlineHost.current?.getBoundingClientRect().height ?? 0);
    setFullscreen(true);
  };

  useLayoutEffect(() => {
    const area = viewport.current, content = canvas.current;
    if (!area || !content) return;
    const measure = () => {
      if (!area.clientWidth) return; // A collapsed outer disclosure is measured when it reopens.
      const next = { width: content.offsetWidth, height: content.offsetHeight, viewportWidth: area.clientWidth };
      setSize(previous => previous.width === next.width && previous.height === next.height && previous.viewportWidth === next.viewportWidth ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area); observer.observe(content);
    return () => observer.disconnect();
  }, [fullscreen]);

  useLayoutEffect(() => {
    const area = viewport.current, content = canvas.current, position = restoreScroll.current;
    if (!area?.clientWidth || !content?.offsetWidth || !position || !size.width || size.width !== content.offsetWidth || size.height !== content.offsetHeight || size.viewportWidth !== area.clientWidth) return;
    area.scrollLeft = position.left; area.scrollTop = position.top;
    restoreScroll.current = null;
    rememberedScroll.current = { left: Math.max(0, area.scrollLeft), top: Math.max(0, area.scrollTop) };
  }, [size, fullscreen, zoom, readingKey]);

  const changeZoom = useCallback((requested: number, point?: { x: number; y: number }, fit = false) => {
    const area = viewport.current;
    if (!area) return;
    const next = Math.min(maxZoom, Math.max(minZoom, Math.round(requested * 100) / 100));
    const x = point?.x ?? area.clientWidth / 2, y = point?.y ?? area.clientHeight / 2;
    const target = fit ? { left: 0, top: 0 } : {
      left: (area.scrollLeft + x) * next / zoomRef.current - x,
      top: (area.scrollTop + y) * next / zoomRef.current - y,
    };
    if (next === zoomRef.current) {
      if (fit) { area.scrollLeft = 0; area.scrollTop = 0; rememberViewport(); }
      return;
    }
    pendingScroll.current = target;
    zoomRef.current = next; setZoom(next);
  }, [rememberViewport]);

  useLayoutEffect(() => {
    const area = viewport.current, target = pendingScroll.current;
    if (!area || !target) return;
    area.scrollLeft = target.left; area.scrollTop = target.top;
    pendingScroll.current = null;
    rememberViewport();
  }, [zoom, rememberViewport]);

  useEffect(() => {
    const area = viewport.current;
    if (!area) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const rect = area.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? area.clientHeight : 1);
      changeZoom(zoomRef.current * Math.exp(-delta * 0.002), {
        x: event.clientX - rect.left - area.clientLeft, y: event.clientY - rect.top - area.clientTop,
      });
    };
    area.addEventListener("wheel", wheel, { passive: false });
    return () => area.removeEventListener("wheel", wheel);
  }, [changeZoom, fullscreen]);

  const fit = () => {
    const area = viewport.current, content = canvas.current;
    if (!area || !content?.offsetWidth || !content.offsetHeight) return;
    changeZoom(Math.floor(Math.min(area.clientWidth / content.offsetWidth, area.clientHeight / content.offsetHeight, 1) * 100) / 100, undefined, true);
  };
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || event.button !== 0 || (event.target as Element).closest("button, a, input, select, textarea, summary")) return;
    const area = event.currentTarget, rect = area.getBoundingClientRect();
    if (event.clientX - rect.left >= area.clientWidth || event.clientY - rect.top >= area.clientHeight) return;
    event.preventDefault();
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: area.scrollLeft, top: area.scrollTop };
    area.setPointerCapture(event.pointerId); setDragging(true);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (!from || from.id !== event.pointerId) return;
    event.currentTarget.scrollLeft = from.left + from.x - event.clientX;
    event.currentTarget.scrollTop = from.top + from.y - event.clientY;
    rememberViewport();
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null; setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const toggle = (chapter: string) => setExpanded(previous => {
    const next = new Set(previous); if (next.has(chapter)) next.delete(chapter); else next.add(chapter); return next;
  });
  const content = <>
    <div className={styles.toolbar}>
      <div><button type="button" onClick={() => { setRootOpen(true); setRelationsOpen(true); setExpanded(new Set(chapters.map(c => c.id))); }}>展开全部</button>
        <button type="button" onClick={() => { setExpanded(new Set()); setRelationsOpen(false); setSelectedRelation(null); }}>收起分支</button></div>
      <div className={styles.zoomControls} role="group" aria-label="导图缩放">
        <button type="button" aria-label="缩小思维导图" title="缩小" disabled={zoom <= minZoom} onClick={() => changeZoom(zoomRef.current - 0.1)}><Fold expanded /></button>
        <output aria-label="思维导图缩放比例">{Math.round(zoom * 100)}%</output>
        <button type="button" aria-label="放大思维导图" title="放大" disabled={zoom >= maxZoom} onClick={() => changeZoom(zoomRef.current + 0.1)}><Fold expanded={false} /></button>
        <button type="button" onClick={fit} title="按当前展开分支适应窗口，最低 50%">适应窗口</button>
        <button type="button" onClick={() => changeZoom(1)}>恢复原大小</button>
        <button type="button" ref={fullscreen ? undefined : fullscreenButton} onClick={fullscreen ? closeFullscreen : openFullscreen}>{fullscreen ? "退出全屏" : "全屏查看"}</button>
      </div>
    </div>
    <div ref={viewport} className={styles.viewport} data-dragging={dragging || undefined} role="region" aria-label="章节思维导图" aria-describedby={`${id}-controls-hint`} tabIndex={0}
      onScroll={rememberViewport} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
      <div className={styles.scaledArea} style={{ width: size.width * zoom, height: size.height * zoom }}>
      <div ref={canvas} className={styles.canvas} style={{ transform: `scale(${zoom})`, minWidth: size.viewportWidth || undefined, "--map-width": `${size.viewportWidth}px` } as CSSProperties}>
        <button type="button" className={styles.root} aria-expanded={rootOpen} aria-controls={`${id}-branches`} onClick={() => setRootOpen(v => !v)}>
          <span>学习脉络</span><small>{chapters.length} 个章节</small><Fold expanded={rootOpen} />
        </button>
        <ul className={styles.branches} id={`${id}-branches`} hidden={!rootOpen}>
          {chapters.map((chapter, index) => <li className={styles.branch} key={chapter.id}>
            <div className={styles.chapter}>
              <button type="button" className={styles.branchLabel} aria-expanded={expanded.has(chapter.id)} aria-controls={`${id}-chapter-${index}`} onClick={() => toggle(chapter.id)}>
                <small>章节 {index + 1}</small><span>{chapter.title}</span><span className={styles.count}>{chapter.nodes.length} 个知识点 <Fold expanded={expanded.has(chapter.id)} /></span>
              </button>
              {onChapter ? <button type="button" className={styles.readChapter} aria-label={`阅读章节：${chapter.title}`} onClick={() => leaveFor(() => onChapter(chapter.id))}>阅读</button> : null}
            </div>
            <ul className={styles.leaves} id={`${id}-chapter-${index}`} hidden={!expanded.has(chapter.id)}>
              {expanded.has(chapter.id) ? chapter.nodes.map(node => <li key={node.id} className={styles.leaf}>
                <button type="button" onClick={() => leaveFor(() => onNode ? onNode(chapter.id, node.id) : onChapter?.(chapter.id))} disabled={!onNode && !onChapter} className={styles.node}>
                  {node.title}{node.note ? <small>有个人笔记</small> : null}
                </button>
              </li>) : null}
              {!chapter.nodes.length ? <li className={styles.empty}>本章暂无知识点</li> : null}
            </ul>
          </li>)}
          {relations.length ? <li className={`${styles.branch} ${styles.relationBranch}`}>
            <button type="button" className={styles.branchLabel} aria-expanded={relationsOpen} aria-controls={`${id}-relations`} onClick={() => setRelationsOpen(v => !v)}>
              <small>有材料依据的联系</small><span>跨章节联系</span><span className={styles.count}>{relations.length} 条联系 <Fold expanded={relationsOpen} /></span>
            </button>
            <ul className={styles.leaves} id={`${id}-relations`} hidden={!relationsOpen}>
              {relations.map((relation, index) => <li key={index} className={styles.leaf}>
                <button type="button" id={`${id}-relation-${index}`} className={styles.node} aria-expanded={relationStillCurrent && selectedRelation === index} aria-controls={`${id}-relation-detail`} onClick={() => {
                  selectedRelationContent.current = relation;
                  setSelectedRelation(v => v === index ? null : index);
                }}>
                  <small>{relationKinds[relation.kind]}</small>{relation.title}
                </button>
              </li>)}
            </ul>
          </li> : null}
        </ul>
      </div>
      </div>
    </div>
    <p id={`${id}-controls-hint`} className={styles.hint}>拖动空白处移动 · Ctrl + 滚轮缩放 · 点击知识点阅读</p>
    {rootOpen && relationsOpen && selectedRelation !== null && relationStillCurrent ? <div className={styles.detail} id={`${id}-relation-detail`}>
      <div className={styles.detailHeader}><span>联系详情</span><button type="button" onClick={() => {
        document.getElementById(`${id}-relation-${selectedRelation}`)?.focus({ preventScroll: true });
        setSelectedRelation(null);
      }}>收起详情</button></div>
      {renderRelation(selectedRelation, { beforeSource: leaveFor, navigateChapter: chapter => leaveFor(() => onChapter?.(chapter)) })}
    </div> : null}
  </>;
  return <div className={styles.map}>
    <div ref={inlineHost}>{fullscreen ? <div aria-hidden="true" style={{ height: inlineHeight }} /> : content}</div>
    <div className={styles.fullscreen}><ProductDialog open={fullscreen} onClose={closeFullscreen} title="思维导图">
      <div className={styles.fullscreenContent}>{fullscreen ? content : null}</div>
    </ProductDialog></div>
  </div>;
}

function Fold({ expanded }: { expanded: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 8h8" />{expanded ? null : <path d="M8 4v8" />}</svg>;
}
