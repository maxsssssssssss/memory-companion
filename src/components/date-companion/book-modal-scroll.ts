/**
 * The book's native toy dialog keeps the root scrollbar and all root styles.
 * CSS containment remains the first layer; this guard also covers engines that
 * ignore containment on a non-overflowing dialog/backdrop. No UA sniffing.
 */
type Guard = { dialogs: Map<HTMLDialogElement, number>; dispose: () => void };
const guards = new WeakMap<Document, Guard>();

function inside(dialog: HTMLDialogElement, x: number, y: number) {
  const rect = dialog.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** Register one open native modal. Releases are idempotent and independently owned. */
export function containBookModalScroll(dialog: HTMLDialogElement): () => void {
  const doc = dialog.ownerDocument;
  const win = doc.defaultView;
  if (!win) return () => {};
  let guard = guards.get(doc);
  if (!guard) {
    const dialogs = new Map<HTMLDialogElement, number>();
    const origin = { x: win.scrollX, y: win.scrollY };
    let touch: { id: number; x: number; y: number } | null = null;
    const active = () => [...dialogs.keys()].filter(node => node.isConnected && node.open);
    const boundary = (event: Event) => {
      const roots = active();
      if (!roots.length) return null;
      // A nested native modal owns its own scroll region, including its backdrop.
      // Native inert/top-layer handling still owns focus, Tab and Escape.
      const target = event.composedPath().find(node => node instanceof win.HTMLElement) as HTMLElement | undefined;
      const nested = target?.closest<HTMLDialogElement>("dialog[open]");
      if (nested && (roots.includes(nested) || nested.matches(":modal"))) return { dialog: nested, target: target! };
      const owner = [...roots].reverse().find(node => target && node.contains(target));
      return { dialog: owner ?? roots.at(-1)!, target: target ?? roots.at(-1)! };
    };
    type Move = { node: HTMLElement; axis: "scrollTop" | "scrollLeft"; delta: number };
    const planAxis = (target: HTMLElement, limit: HTMLDialogElement, delta: number, vertical: boolean): Move | null => {
      if (!delta) return null;
      for (let node: HTMLElement | null = target; node && limit.contains(node); node = node.parentElement) {
        const style = win.getComputedStyle(node);
        const overflow = vertical ? style.overflowY : style.overflowX;
        if (!/auto|scroll|overlay/.test(overflow)) continue;
        const axis = vertical ? "scrollTop" : "scrollLeft";
        const max = vertical ? node.scrollHeight - node.clientHeight : node.scrollWidth - node.clientWidth;
        // RTL horizontal scrollLeft ranges from -max to 0.
        const min = !vertical && style.direction === "rtl" ? -max : 0;
        const end = min < 0 ? 0 : max;
        const available = delta > 0 ? end - node[axis] : node[axis] - min;
        if (max > 0 && available > 0.5) return { node, axis, delta: Math.sign(delta) * Math.min(Math.abs(delta), available) };
        if (node === limit) break;
      }
      return null;
    };
    const contain = (event: Event, x: number, y: number, dx: number, dy: number, alwaysManual = false) => {
      const current = boundary(event);
      if (!current || !event.cancelable) return;
      const inContent = current.dialog.contains(current.target) && inside(current.dialog, x, y);
      const moves = inContent ? [planAxis(current.target, current.dialog, dx, false), planAxis(current.target, current.dialog, dy, true)] : [null, null];
      const rootScroller = doc.scrollingElement ?? doc.documentElement;
      // A vertical pan/trackpad gesture normally has a little horizontal drift.
      // Keep native momentum if that drift cannot scroll either modal or page.
      const harmlessDrift = inContent && !moves[0] && Math.abs(dx) < Math.abs(dy) && rootScroller.scrollWidth <= rootScroller.clientWidth;
      const fits = (!dx || moves[0]?.delta === dx || harmlessDrift) && (!dy || moves[1]?.delta === dy);
      if (fits && !alwaysManual) return; // Preserve native interior scrolling/momentum.
      event.preventDefault();
      // Consume the remaining distance inside the modal, never its overshoot in the page.
      for (const move of moves) if (move) move.node[move.axis] += move.delta;
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) return; // Trackpad pinch/browser zoom is not page scrolling.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? win.innerHeight : 1;
      const dx = (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit;
      const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY * unit;
      contain(event, event.clientX, event.clientY, dx, dy);
    };
    const touchStart = (event: TouchEvent) => {
      const point = event.touches.length === 1 ? event.touches[0] : null;
      touch = point ? { id: point.identifier, x: point.clientX, y: point.clientY } : null;
    };
    const touchMove = (event: TouchEvent) => {
      if (!touch || event.touches.length !== 1) { touch = null; return; }
      const point = event.touches[0];
      if (point.identifier !== touch.id) { touch = null; return; }
      const dx = touch.x - point.clientX, dy = touch.y - point.clientY;
      touch = { id: point.identifier, x: point.clientX, y: point.clientY };
      contain(event, point.clientX, point.clientY, dx, dy);
    };
    const touchEnd = () => { touch = null; };
    const key = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const current = boundary(event);
      if (!current) return;
      if (current.target.closest("input,textarea,select,[contenteditable]:not([contenteditable=false])")) return;
      if (event.key === " " && current.target.closest("button,a[href],[role=button]")) return;
      const page = current.dialog.clientHeight * 0.9;
      const dy = ({ ArrowDown: 40, ArrowUp: -40, PageDown: page, PageUp: -page, Home: -Number.MAX_SAFE_INTEGER, End: Number.MAX_SAFE_INTEGER, " ": event.shiftKey ? -page : page } as Record<string, number>)[event.key];
      const dx = event.key === "ArrowRight" ? 40 : event.key === "ArrowLeft" ? -40 : 0;
      if (dy === undefined && !dx) return;
      const rect = current.dialog.getBoundingClientRect();
      contain(event, rect.left + 1, rect.top + 1, dx, dy ?? 0, true);
    };
    const restoreUnexpectedRootScroll = () => {
      if (active().length && (win.scrollX !== origin.x || win.scrollY !== origin.y)) {
        win.scrollTo({ left: origin.x, top: origin.y, behavior: "instant" });
      }
    };
    doc.addEventListener("wheel", wheel, { capture: true, passive: false });
    doc.addEventListener("touchstart", touchStart, { capture: true, passive: true });
    doc.addEventListener("touchmove", touchMove, { capture: true, passive: false });
    doc.addEventListener("touchend", touchEnd, true);
    doc.addEventListener("touchcancel", touchEnd, true);
    doc.addEventListener("keydown", key, true);
    win.addEventListener("scroll", restoreUnexpectedRootScroll);
    guard = { dialogs, dispose: () => {
      doc.removeEventListener("wheel", wheel, true);
      doc.removeEventListener("touchstart", touchStart, true);
      doc.removeEventListener("touchmove", touchMove, true);
      doc.removeEventListener("touchend", touchEnd, true);
      doc.removeEventListener("touchcancel", touchEnd, true);
      doc.removeEventListener("keydown", key, true);
      win.removeEventListener("scroll", restoreUnexpectedRootScroll);
      guards.delete(doc);
    } };
    guards.set(doc, guard);
  }
  guard.dialogs.set(dialog, (guard.dialogs.get(dialog) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    dialog.removeEventListener("close", closed);
    const count = guard!.dialogs.get(dialog) ?? 0;
    if (count > 1) guard!.dialogs.set(dialog, count - 1);
    else guard!.dialogs.delete(dialog);
    if (!guard!.dialogs.size) guard!.dispose();
  };
  // close is queued; a rapid reopen must not release the new session.
  const closed = () => { if (!dialog.open) release(); };
  dialog.addEventListener("close", closed);
  return release;
}
