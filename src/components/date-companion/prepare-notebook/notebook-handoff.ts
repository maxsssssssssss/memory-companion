"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { preparationChoiceState, type PreparationItem, type PreviewAdapter } from "./model";

// Motion Prompt #161 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#161
// Motion Prompt #122 · MIT License (c) 2026 Shohei Ohtaki · https://showheyohtaki.github.io/motion-prompt/#122
// Project adaptation: one real suggestion connects two simultaneously live pages.
// The receipt owns the state; this short-lived paper never owns content or focus.
interface SelectionTicket {
  adapter: PreviewAdapter;
  owner: string;
  discussionId: string;
  itemId: string;
  source: HTMLElement | null;
  trigger: HTMLButtonElement;
  keepFocus: boolean;
  spatial: boolean;
  interrupted: boolean;
  consumed: boolean;
}

const ownerOf = (adapter: PreviewAdapter) => {
  const state = adapter.getSnapshot();
  return JSON.stringify([state.accountId, state.relationshipId, state.currentDiscussionId, state.loggedOut]);
};

const reducedQuery = "(prefers-reduced-motion: reduce)";
const reducedNow = () => typeof window !== "undefined" && (window.matchMedia?.(reducedQuery).matches ?? false);
const subscribeReduced = (notify: () => void) => {
  const query = window.matchMedia?.(reducedQuery);
  query?.addEventListener("change", notify);
  return () => query?.removeEventListener("change", notify);
};
const serverReduced = () => false;

/** Motion's preference value can be the initial mount value. The notebook also
 * needs a live subscription when the system preference changes while reading. */
export function useNotebookReducedMotion() {
  return useSyncExternalStore(subscribeReduced, reducedNow, serverReduced);
}

/** A useful first-line area must be inside both the page and its scrollport.
 * Merely intersecting the viewport would send paper to a clipped/offscreen note. */
function readableStart(rect: DOMRect, clip: DOMRect, height: number) {
  return rect.width >= 160 && rect.height > 0
    && rect.left >= Math.max(0, clip.left) - 1 && rect.right <= Math.min(innerWidth, clip.right) + 1
    && rect.top >= Math.max(0, clip.top) - 1
    && rect.top + height <= Math.min(innerHeight, clip.bottom) - 2;
}

export function useNotebookHandoff({ adapter, book, left, chat, disabled, blocked }: {
  adapter: PreviewAdapter;
  book: RefObject<HTMLElement | null>;
  left: RefObject<HTMLDivElement | null>;
  chat: RefObject<HTMLDivElement | null>;
  disabled: boolean;
  blocked: boolean;
}) {
  const owner = ownerOf(adapter);
  const current = useRef({ adapter, owner, disabled, blocked });
  current.current = { adapter, owner, disabled, blocked };
  const pending = useRef<SelectionTicket | null>(null);
  const active = useRef<(() => void) | null>(null);
  const activeReadPoint = useRef<{ x: number; y: number; left: number; chat: number } | null>(null);
  const suppressed = useRef({ adapter, owner, items: new Set<string>() });
  if (suppressed.current.adapter !== adapter || suppressed.current.owner !== owner) {
    suppressed.current = { adapter, owner, items: new Set<string>() };
  }
  const [arrival, setArrival] = useState<SelectionTicket | null>(null);

  const interrupt = useCallback(() => {
    if (pending.current) pending.current.interrupted = true;
    active.current?.();
    active.current = null;
  }, []);

  useLayoutEffect(() => {
    interrupt();
    pending.current = null;
    return interrupt;
  }, [adapter, owner, interrupt]);
  useLayoutEffect(() => { if (disabled || blocked) interrupt(); }, [disabled, blocked, interrupt]);
  useEffect(() => {
    // Cancel decoration as soon as reading resumes. Never reposition a moving
    // copy after scrolling, and never intercept or prevent the user's action.
    const events = ["wheel", "touchstart", "pointerdown", "keydown", "input", "compositionstart"] as const;
    events.forEach(name => document.addEventListener(name, interrupt, { capture: true, passive: true }));
    const onFocusIn = (event: FocusEvent) => {
      // Assistive technology and programmatic focus need not produce pointer or
      // key events. Returning to the initiating button is harmless; moving to
      // another reading/editing target means the user's next task has begun.
      if (pending.current && event.target === pending.current.trigger) return;
      interrupt();
    };
    document.addEventListener("focusin", onFocusIn);
    const onScroll = () => {
      const point = activeReadPoint.current;
      // Focus/scrollIntoView can dispatch a queued scroll after the click.
      // Before the receipt there is no travelling paper; use fresh geometry at
      // success. While flying, only a changed read point invalidates that path.
      if (active.current && point && (Math.abs(scrollX - point.x) > .5 || Math.abs(scrollY - point.y) > .5
        || Math.abs((left.current?.scrollTop ?? 0) - point.left) > .5 || Math.abs((chat.current?.scrollTop ?? 0) - point.chat) > .5)) interrupt();
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", interrupt);
    document.addEventListener("visibilitychange", interrupt);
    const preference = window.matchMedia?.(reducedQuery);
    const onPreferenceChange = () => { if (preference?.matches) interrupt(); };
    preference?.addEventListener("change", onPreferenceChange);
    return () => {
      events.forEach(name => document.removeEventListener(name, interrupt, true));
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", interrupt);
      document.removeEventListener("visibilitychange", interrupt);
      preference?.removeEventListener("change", onPreferenceChange);
      interrupt();
    };
  }, [interrupt, left, chat]);

  const prepare = useCallback((item: PreparationItem, trigger: HTMLButtonElement, keyboard: boolean) => {
    interrupt();
    const state = adapter.getSnapshot();
    const latest = state.discussions.find(value => value.id === state.currentDiscussionId)?.items.find(value => value.id === item.id);
    if (!state.currentDiscussionId || state.loggedOut || item.status !== "suggested" || latest?.status !== "suggested") return null;
    const ticket: SelectionTicket = {
      adapter, owner: ownerOf(adapter), discussionId: state.currentDiscussionId, itemId: item.id,
      source: trigger.closest<HTMLElement>(".prep-candidate"), trigger,
      keepFocus: document.activeElement === trigger, spatial: !keyboard && !current.current.disabled && !reducedNow(),
      interrupted: false, consumed: false,
    };
    pending.current = ticket;
    // Set before the adapter can publish its successful response. The new note
    // is immediately readable, with no old y8 entrance or second layout move.
    suppressed.current.items.add(item.id);
    return ticket;
  }, [adapter, interrupt]);

  const reject = useCallback((ticket: SelectionTicket | null) => {
    if (ticket && pending.current === ticket) { ticket.interrupted = true; pending.current = null; }
  }, []);

  const confirm = useCallback((ticket: SelectionTicket | null) => {
    if (!ticket || ticket.consumed || ticket.adapter !== current.current.adapter
      || ticket.owner !== ownerOf(ticket.adapter)) return;
    const discussion = ticket.adapter.getDiscussion(ticket.discussionId);
    const item = discussion?.items.find(value => value.id === ticket.itemId);
    if (!discussion || !item || preparationChoiceState(discussion, item) !== "current") return;
    if (reducedNow()) ticket.spatial = false;
    ticket.consumed = true;
    setArrival(ticket);
  }, []);

  useLayoutEffect(() => {
    if (!arrival || arrival.adapter !== adapter || arrival.owner !== owner) return;
    const ticket = arrival;
    if (pending.current === ticket) pending.current = null;
    const source = ticket.source;
    // Replacing the select button must not abandon keyboard/pointer focus.
    // A subsequent action elsewhere wins; late receipts must not steal it back.
    if (ticket.keepFocus && !ticket.interrupted
      && (document.activeElement === document.body || document.activeElement === ticket.trigger)) {
      document.getElementById(`choice-${ticket.itemId}`)?.focus({ preventScroll: true });
    }
    if (!ticket.spatial || ticket.interrupted || current.current.disabled || reducedNow() || current.current.blocked
      || document.visibilityState === "hidden" || !source?.isConnected || !source.animate) return;
    const discussion = adapter.getDiscussion(ticket.discussionId);
    const item = discussion?.items.find(value => value.id === ticket.itemId);
    if (!discussion || !item || preparationChoiceState(discussion, item) !== "current") return;

    const target = document.getElementById(`note-${ticket.itemId}`);
    const content = source.querySelector<HTMLElement>(".prep-note-content") ?? source;
    // Read all geometry before attaching the visual copy or starting animations.
    const from = content.getBoundingClientRect();
    const to = target?.getBoundingClientRect();
    const sourcePort = chat.current?.getBoundingClientRect();
    const targetPort = left.current?.getBoundingClientRect();
    const textBounds = target?.querySelector<HTMLElement>(".prep-note-text")?.getBoundingClientRect();
    const wide = innerWidth > 980;
    const width = Math.min(232, Math.max(180, from.width * .68));
    // A one-line paper docks in the blank upper edge. Its 44px face and 6px
    // downward shadow stay above the real text, which is readable immediately.
    const dockY = textBounds ? textBounds.top - 51 : 0;
    const leftPage = left.current?.closest(".prep-left") ?? left.current;
    const obstacles = leftPage ? [...leftPage.querySelectorAll<HTMLElement>(
      ".prep-note-text, .prep-note-actions, button, a, input, textarea, [contenteditable=true]"
    )].map(node => node.getBoundingClientRect()) : [];
    const clearEdge = to && textBounds && dockY >= 2 && !obstacles.some(rect =>
      rect.width > 0 && rect.height > 0 && rect.left < to.right + 26 + width
      && rect.right > to.left + 14 && rect.top < dockY + 50 && rect.bottom > dockY - 2);
    const cross = wide && clearEdge && to && sourcePort && targetPort
      && readableStart(from, sourcePort, 74) && readableStart(to, targetPort, 96);
    const animations: Animation[] = [];
    let decoration: HTMLElement | null = null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      animations.forEach(animation => animation.cancel());
      decoration?.remove();
      delete source.dataset.handoff;
      if (active.current === finish) { active.current = null; activeReadPoint.current = null; }
    };
    active.current?.();
    active.current = finish;
    activeReadPoint.current = { x: scrollX, y: scrollY, left: left.current?.scrollTop ?? 0, chat: chat.current?.scrollTop ?? 0 };
    if (cross) {
      const startX = from.left + Math.min(12, Math.max(0, from.width - width));
      const startY = from.top;
      const dx = to.left + 20 - startX, dy = dockY - startY;
      // Finish lifting/rotation outside the left sheet. From here to docking,
      // the complete paper and shadow travel through the same checked corridor.
      const edgeX = to.right + 20 - startX;
      decoration = document.createElement("div");
      decoration.className = "prep-handoff-copy";
      decoration.dataset.itemId = item.id;
      decoration.setAttribute("aria-hidden", "true");
      decoration.style.cssText = `left:${startX}px;top:${startY}px;width:${width}px;`;
      const text = document.createElement("span");
      text.textContent = item.text.split(/(?<=[。！？])/u)[0] || item.text;
      decoration.append(text);
      const corner = document.createElement("i");
      decoration.append(corner);
      document.body.append(decoration);
      source.dataset.handoff = "cross";
      animations.push(decoration.animate([
        { transform: "translate(0,0) rotate(0deg)", opacity: .96, offset: 0, easing: "cubic-bezier(.23,1,.32,1)" },
        { transform: "translate(0,-12px) rotate(-2.4deg)", opacity: .96, offset: .17, easing: "cubic-bezier(.65,0,.35,1)" },
        { transform: `translate(${edgeX}px,${dy}px) rotate(0deg)`, opacity: .96, offset: .4, easing: "cubic-bezier(.65,0,.35,1)" },
        { transform: `translate(${dx}px,${dy}px) rotate(0deg)`, opacity: .96, offset: .84, easing: "ease-out" },
        { transform: `translate(${dx}px,${dy}px) rotate(0deg)`, opacity: 0, offset: 1 },
      ], { duration: 420, fill: "both" }));
      animations.push(corner.animate([
        { transform: "rotate(-3deg) translateY(1px)", offset: 0 },
        { transform: "rotate(-3deg) translateY(1px)", offset: .78 },
        { transform: "rotate(0deg) translateY(0)", offset: 1 },
      ], { duration: 420, fill: "both", easing: "ease-out" }));
    } else {
      // The destination is out of sight. A full paper behind the current
      // candidate answers here; the count changes without switching/scrolling.
      source.dataset.handoff = "local";
      decoration = document.createElement("i");
      decoration.className = "prep-handoff-local-paper";
      decoration.setAttribute("aria-hidden", "true");
      source.prepend(decoration);
      animations.push(source.animate([
        { transform: "translateY(0)" },
        { transform: "translateY(-12px)", offset: .34 },
        { transform: "translateY(0)", offset: 1 },
      ], { duration: 300, easing: "cubic-bezier(.23,1,.32,1)" }));
      animations.push(decoration.animate([{ opacity: 0 }, { opacity: .94, offset: .2 }, { opacity: .78, offset: .7 }, { opacity: 0 }], { duration: 300 }));
      const count = book.current?.parentElement?.querySelector<HTMLElement>('.prep-mobile-tabs [role="tab"]');
      if (!wide && count?.animate) animations.push(count.animate([
        { transform: "translateY(0)" }, { transform: "translateY(-4px)", offset: .35 }, { transform: "translateY(0)" },
      ], { duration: 280, easing: "cubic-bezier(.23,1,.32,1)" }));
    }
    void Promise.all(animations.map(animation => animation.finished)).then(finish, finish);
    return finish;
  }, [arrival, adapter, owner, book, left, chat]);

  return { prepare, reject, confirm, suppressEntrance: (itemId: string) => suppressed.current.items.has(itemId) };
}
