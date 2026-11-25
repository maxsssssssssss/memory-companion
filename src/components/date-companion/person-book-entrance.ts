"use client";

import { useEffect } from "react";

type EntryIntent = { scope: string; personId: string | null; path: string; at: number; claimed: boolean };
let pending: EntryIntent | null = null;
let captureScope: string | undefined;

/** Ephemeral navigation intent only. It never stores material or changes a URL. */
export function usePersonBookEntryCapture(scope: string | undefined) {
  useEffect(() => {
    if (captureScope !== scope) pending = null;
    captureScope = scope;
    if (!scope) { pending = null; return; }
    const click = (event: MouseEvent) => {
      // Each click replaces the previous intention, including static keyboard
      // navigation and reading returns. No person/session-wide played flag.
      pending = null;
      if (event.defaultPrevented || event.button !== 0 || event.detail === 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.hasAttribute("data-person-book-return") || link.download || link.target && link.target !== "_self") return;
      const target = new URL(link.href, location.href);
      if (target.origin !== location.origin || target.pathname === location.pathname) return;
      const match = /^\/date-companion\/a\/people(?:\/([^/]+))?$/.exec(target.pathname);
      if (!match || target.searchParams.has("section") || target.searchParams.has("personSource") || target.searchParams.has("personFull")) return;
      let personId: string | null = null;
      try {
        if (match[1]) personId = decodeURIComponent(match[1]);
      } catch { return; }
      // The legal single-person /people alias and its canonical URL are the
      // same open book, even though their pathnames differ.
      if (personId && document.querySelector<HTMLElement>("[data-person-book-id]")?.dataset.personBookId === personId) return;
      pending = { scope, personId, path: target.pathname, at: performance.now(), claimed: false };
    };
    const cancel = () => { pending = null; };
    document.addEventListener("click", click, true);
    for (const event of ["pointerdown", "keydown", "wheel", "touchstart"] as const) document.addEventListener(event, cancel, { capture: true, passive: true });
    window.addEventListener("popstate", cancel);
    window.addEventListener("pagehide", cancel);
    return () => {
      document.removeEventListener("click", click, true);
      for (const event of ["pointerdown", "keydown", "wheel", "touchstart"] as const) document.removeEventListener(event, cancel, true);
      window.removeEventListener("popstate", cancel);
      window.removeEventListener("pagehide", cancel);
    };
  }, [scope]);
}

/** Also identifies a claimed arrival while its initial reading effects settle. */
export function hasPersonBookEntry(scope: string, personId: string | null) {
  return Boolean(pending && personId && pending.scope === scope &&
    (!pending.personId || pending.personId === personId) && pending.path === location.pathname &&
    performance.now() - pending.at < 10_000);
}

export function claimPersonBookEntry(scope: string, personId: string) {
  // A stale render for another account/person/path cannot consume the newer
  // navigation. The object itself is the one-use ticket; a new click gets a
  // new object, and old page cleanup never writes to it.
  if (!hasPersonBookEntry(scope, personId) || pending!.claimed) return false;
  pending!.claimed = true;
  return true;
}
