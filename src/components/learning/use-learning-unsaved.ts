"use client";

import { useEffect } from "react";

/** Keep drafts in mounted learning panels; warn before a navigation discards them. */
export function useLearningUnsaved(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    // On browsers with the Navigation API, cancel Back/Forward before React's
    // history handler can unmount the editor. No extra history entries are added.
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    const traverse = (event: Event) => {
      if ((event as Event & { navigationType?: string }).navigationType === "traverse" && event.cancelable
        && !window.confirm("还有未保存的输入。返回会丢失这些内容，确定离开？")) event.preventDefault();
    };
    const leave = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || event.defaultPrevented || link.target === "_blank" || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const target = new URL(link.href, window.location.href);
      if (target.pathname === window.location.pathname && target.search === window.location.search && target.hash) return;
      if (!window.confirm("还有未保存的输入。离开会丢失这些内容，确定离开？")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", leave, true);
    navigation?.addEventListener("navigate", traverse);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", leave, true); navigation?.removeEventListener("navigate", traverse); };
  }, [dirty]);
}
