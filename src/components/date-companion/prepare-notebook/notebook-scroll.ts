"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

const inset = 10;

/** Reveal the controls only when clipped. Long edits can use the explicit
 * action shortcut without scrolling a writer away from the text. */
export function editVisibilityDelta(
  viewTop: number, viewBottom: number, fieldTop: number, actionsTop: number, actionsBottom: number,
) {
  if (actionsTop >= viewTop && actionsBottom <= viewBottom) return 0;
  if (actionsBottom - fieldTop > viewBottom - viewTop - 2 * inset) {
    return fieldTop < viewTop || fieldTop >= viewBottom ? fieldTop - viewTop - inset : 0;
  }
  return actionsBottom > viewBottom ? actionsBottom - viewBottom + inset : actionsTop - viewTop - inset;
}

export function useEditVisibility(left: RefObject<HTMLDivElement | null>, editingId?: string | null) {
  const following = useRef<string | null>(null);
  const [oversizedId, setOversizedId] = useState<string | null>(null);
  const cancel = useCallback(() => { following.current = null; }, []);

  const geometry = useCallback((id: string) => {
    const area = left.current;
    const field = document.getElementById('prep-edit-' + id);
    const note = field?.closest<HTMLElement>('.prep-note');
    const row = note?.querySelector<HTMLElement>('.prep-edit-actions');
    const controls = row?.querySelectorAll<HTMLButtonElement>('button');
    if (!area || !field || !note || !row || !controls?.length || !area.contains(field) || !field.getClientRects().length) return null;
    const viewport = window.visualViewport;
    const screenTop = viewport?.offsetTop ?? 0;
    const screenBottom = screenTop + (viewport?.height ?? innerHeight);
    const internal = /auto|scroll/.test(getComputedStyle(area).overflowY);
    const bounds = area.getBoundingClientRect();
    const viewTop = internal ? Math.max(bounds.top, screenTop) : screenTop;
    const viewBottom = internal ? Math.min(bounds.bottom, screenBottom) : screenBottom;
    const buttons = Array.from(controls, control => control.getBoundingClientRect());
    return {
      area, field, note, row, controls, internal, viewTop, viewBottom,
      fieldTop: field.getBoundingClientRect().top,
      actionsTop: Math.min(...buttons.map(box => box.top)),
      actionsBottom: Math.max(...buttons.map(box => box.bottom)),
    };
  }, [left]);

  const move = useCallback((g: NonNullable<ReturnType<typeof geometry>>, delta: number) => {
    if (Math.abs(delta) < 0.5) return;
    // Desktop has its own left-page scroller. Narrow layouts read in normal document flow.
    if (g.internal) g.area.scrollTop += delta;
    else window.scrollBy({ top: delta, behavior: 'instant' });
  }, []);

  const measure = useCallback((id: string, resized: boolean) => {
    const g = geometry(id);
    if (!g || g.viewBottom <= g.viewTop) return;
    const oversized = g.actionsBottom - g.fieldTop > g.viewBottom - g.viewTop - 2 * inset;
    const clipped = g.actionsBottom > g.viewBottom || g.actionsTop < g.viewTop;
    if (resized && following.current === id) {
      move(g, editVisibilityDelta(g.viewTop, g.viewBottom, g.fieldTop, g.actionsTop, g.actionsBottom));
    }
    // A shortcut is useful for a tall note or someone who deliberately scrolled.
    // Adding one during a normal reveal would change the very height being measured.
    setOversizedId(oversized || (clipped && following.current !== id) ? id : null);
  }, [geometry, move]);

  const begin = useCallback((id: string) => {
    following.current = id;
    measure(id, true);
  }, [measure]);

  const showActions = useCallback((id: string) => {
    cancel();
    const g = geometry(id);
    if (!g) return;
    move(g, editVisibilityDelta(g.viewTop, g.viewBottom, g.actionsTop, g.actionsTop, g.actionsBottom));
    Array.from(g.controls).find(button => !button.disabled)?.focus({ preventScroll: true });
  }, [cancel, geometry, move]);

  useLayoutEffect(() => {
    if (!editingId) { setOversizedId(null); return; }
    const g = geometry(editingId);
    if (!g) { setOversizedId(null); return; }
    const update = () => measure(editingId, true);
    const onScroll = () => measure(editingId, false);
    update();
    // Motion changes the note's actual height. Measure that layout and textarea
    // wraps even when the user starts typing before the opening motion finishes.
    const observer = new ResizeObserver(update);
    for (const element of [g.note, g.field, g.area, g.row]) observer.observe(element);
    const scroller = g.internal ? g.area : window;
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, [editingId, geometry, measure]);

  useEffect(() => {
    const onPointer = (event: Event) => {
      if (!(event.target instanceof HTMLTextAreaElement)) cancel();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab' || (!(event.target instanceof HTMLTextAreaElement)
          && ['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(event.key))) cancel();
    };
    document.addEventListener('wheel', cancel, { capture: true, passive: true });
    document.addEventListener('touchmove', cancel, { capture: true, passive: true });
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      cancel();
      document.removeEventListener('wheel', cancel, true);
      document.removeEventListener('touchmove', cancel, true);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [cancel]);

  return { begin, cancel, oversizedId, showActions };
}
