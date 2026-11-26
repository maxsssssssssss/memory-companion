import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safePersonReturnTo } from "@/lib/domain/date-companion-book-navigation";
import { usePersonBookNavigation } from "./person-book-navigation";

function Book({ scope = "account/relationship/person", activeEntry = false, ready = true, missing = false }: { scope?: string; activeEntry?: boolean; ready?: boolean; missing?: boolean }) {
  const navigation = usePersonBookNavigation(scope, ready, () => activeEntry);
  if (missing) return <h2 tabIndex={-1} id="person-history-results">已读记录</h2>;
  return <a href="/recap" data-person-reading-key="meeting-1" onClick={event => {
    event.preventDefault();
    navigation.rememberMeeting(event.currentTarget);
  }}>翻开这次复盘</a>;
}

describe("person book reading-point return", () => {
  beforeEach(() => {
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.stubGlobal("scrollTo", vi.fn());
    // jsdom has neither layout rectangles nor the browser's :modal selector.
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 44, 44)] as unknown as DOMRectList);
    const querySelector = document.querySelector.bind(document);
    vi.spyOn(document, "querySelector").mockImplementation(selector => querySelector(selector === "dialog:modal" ? "dialog[open]" : selector));
    sessionStorage.clear();
  });
  afterEach(() => { cleanup(); sessionStorage.clear(); history.replaceState(null, "", "/"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("creates a fresh source operation for each click and clears it on history restoration",()=>{
    history.replaceState(null,"","/date-companion/a/people/person?view=book");
    const entries:unknown[]=[];
    function ReaderBook(){
      const nav=usePersonBookNavigation('account/relationship/person',true);
      entries.push(nav.sourceEntry);
      return <button data-person-reading-key="material-one" onClick={e=>nav.openSource('one',e.currentTarget,e.detail)}>原话</button>;
    }
    const view=render(<ReaderBook/>);expect(entries.at(-1)).toBeNull();
    fireEvent.click(screen.getByText('原话'),{detail:0});const keyboard=entries.at(-1);expect(keyboard).toMatchObject({pointer:false});
    fireEvent.click(screen.getByText('原话'),{detail:1});const first=entries.at(-1);expect(first).toMatchObject({pointer:true});expect(first).not.toBe(keyboard);
    view.rerender(<ReaderBook/>);expect(entries.at(-1)).toBe(first);
    fireEvent.click(screen.getByText('原话'),{detail:1});expect(entries.at(-1)).not.toBe(first);
    fireEvent.popState(window);expect(entries.at(-1)).toBeNull();
  });

  it.each(["", "from=book-home", "view=book", "view=classic"])("restores the same alias after returning through the canonical link: %s", query => {
    history.replaceState(null, "", "/date-companion/a/people" + (query ? "?" + query : ""));
    const { unmount } = render(<Book />);
    fireEvent.click(screen.getByRole("link"));
    const target = safePersonReturnTo(location.pathname + location.search, "person", "person");
    expect(target).not.toBeNull();
    unmount();
    const returnUrl = new URL(target!, location.origin);
    returnUrl.searchParams.set("resumeMeeting", "1");
    history.replaceState(null, "", returnUrl);
    render(<Book />);
    expect(screen.getByRole("link")).toHaveFocus();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "instant" });
  });

  it.each(["different-scope", "different-path"])("does not restore another book: %s", difference => {
    history.replaceState(null, "", "/date-companion/a/people?from=book-home");
    const { unmount } = render(<Book />);
    fireEvent.click(screen.getByRole("link"));
    unmount();
    history.replaceState(null, "", difference === "different-path"
      ? "/date-companion/a/people/other?view=book&from=book-home"
      : "/date-companion/a/people?view=book&from=book-home");
    render(<Book scope={difference === "different-scope" ? "another-account/relationship/person" : undefined} />);
    expect(screen.getByRole("link")).not.toHaveFocus();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("preserves the saved reading point without taking focus or scrolling on a new active arrival", () => {
    history.replaceState(null, "", "/date-companion/a/people/person?view=book");
    const previous = render(<Book />);
    fireEvent.click(screen.getByRole("link"));
    const key = sessionStorage.key(0)!;
    const saved = sessionStorage.getItem(key);
    previous.unmount();
    history.replaceState(null, "", "/date-companion/a/people/person?view=book&from=book-home");
    render(<Book activeEntry />);
    expect(screen.getByRole("link")).not.toHaveFocus();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBe(saved);
    expect(sessionStorage.length).toBe(1);
  });

  it("can still restore the saved point on a later browser traversal after an active arrival", () => {
    history.replaceState(null, "", "/date-companion/a/people/person?view=book");
    const previous = render(<Book />);
    fireEvent.click(screen.getByRole("link"));
    const savedState = history.state;
    previous.unmount();
    history.replaceState(null, "", "/date-companion/a/people/person?view=book&from=book-home");
    render(<Book activeEntry />);
    expect(scrollTo).not.toHaveBeenCalled();
    history.replaceState(savedState, "", location.href);
    fireEvent.popState(window);
    expect(screen.getByRole("link")).toHaveFocus();
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "instant" });
    expect(sessionStorage.length).toBe(0);
  });

  it("does not confuse a consumed active ticket or late data with a reading return", () => {
    history.replaceState(null, "", "/date-companion/a/people/person?view=book");
    const previous = render(<Book />);
    fireEvent.click(screen.getByRole("link"));
    const key = sessionStorage.key(0)!;
    const saved = sessionStorage.getItem(key);
    previous.unmount();
    history.replaceState(null, "", location.href);
    const current = render(<Book activeEntry ready={false} />);
    current.rerender(<Book activeEntry={false} ready />);
    current.rerender(<Book activeEntry={false} ready />);
    expect(screen.getByRole("link")).not.toHaveFocus();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBe(saved);
    current.unmount();
    // The explicit recap return creates another entry, rather than restoring
    // the new active arrival's intentionally empty history marker.
    history.replaceState(null, "", location.pathname + "?view=book&resumeMeeting=1");
    render(<Book />);
    expect(screen.getByRole("link")).toHaveFocus();
    expect(scrollTo).toHaveBeenCalledOnce();
  });

  it("cannot consume an outgoing marker when a pending read finishes before the recap navigation commits", () => {
    const url = "/date-companion/a/people/person?section=archive&q=画册&filter=meeting";
    history.replaceState(null, "", url);
    const departure = render(<Book ready={false} />);
    fireEvent.click(screen.getByRole("link"));
    const key = sessionStorage.key(0)!;
    departure.rerender(<Book ready />);
    expect(sessionStorage.getItem(key)).toBeTruthy();
    expect(scrollTo).not.toHaveBeenCalled();
    departure.unmount();
    history.replaceState(null, "", url + "&resumeMeeting=1");
    const arrival = render(<Book ready={false} />);
    expect(screen.getByRole("link")).not.toHaveFocus();
    arrival.rerender(<Book ready />);
    expect(screen.getByRole("link")).toHaveFocus();
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(scrollTo).toHaveBeenCalledOnce();
  });

  it("falls back to the filtered result heading only after the matching return has settled", () => {
    const url = "/date-companion/a/people/person?section=archive&q=画册";
    history.replaceState(null, "", url);
    const old = render(<Book />);
    fireEvent.click(screen.getByRole("link"));
    old.unmount();
    history.replaceState(null, "", url + "&resumeMeeting=1");
    const arrival = render(<Book missing ready={false} />);
    const heading = screen.getByRole("heading");
    heading.scrollIntoView = vi.fn();
    expect(heading).not.toHaveFocus();
    arrival.rerender(<Book missing ready />);
    expect(heading).toHaveFocus();
    expect(heading.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "instant" });
  });

  it("checks active entry after the router commits location instead of freezing the earlier render result", () => {
    const destination = "/date-companion/a/people/person?view=book";
    history.replaceState(null, "", destination);
    const previous = render(<Book />);
    fireEvent.click(screen.getByRole("link"));
    const key = sessionStorage.key(0)!;
    const saved = sessionStorage.getItem(key);
    previous.unmount();
    history.replaceState(null, "", "/date-companion/a/recap?view=book");
    let committed = false;
    const renderChecks: boolean[] = [];
    const activeAtCommit = vi.fn(() => committed && location.pathname === "/date-companion/a/people/person");
    function CommittingBook() {
      renderChecks.push(activeAtCommit());
      useLayoutEffect(() => {
        history.replaceState(null, "", destination);
        committed = true;
      }, []);
      usePersonBookNavigation("account/relationship/person", true, activeAtCommit);
      return <a href="/recap" data-person-reading-key="meeting-1">翻开这次复盘</a>;
    }
    render(<CommittingBook />);
    expect(renderChecks[0]).toBe(false);
    expect(activeAtCommit).toHaveReturnedWith(true);
    expect(screen.getByRole("link")).not.toHaveFocus();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBe(saved);
    expect(history.state.personBookPoint).toEqual({ key, point: null });
  });

  it("uses the new entry's empty marker on Back/Forward without losing the older entry's actual reading point", () => {
    const destination = "/date-companion/a/people/person?view=book";
    history.replaceState(null, "", destination);
    const previous = render(<Book />);
    fireEvent.click(screen.getByRole("link"));
    const savedState = history.state;
    const key = sessionStorage.key(0)!;
    const saved = sessionStorage.getItem(key);
    previous.unmount();
    history.replaceState({ routerMarker: "new-navigation" }, "", destination);
    const active = render(<Book activeEntry />);
    const newEntryState = history.state;
    expect(newEntryState).toEqual({ routerMarker: "new-navigation", personBookPoint: { key, point: null } });
    fireEvent.popState(window);
    expect(screen.getByRole("link")).not.toHaveFocus();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBe(saved);
    active.unmount();
    // Restoring/remounting this same new entry must not borrow the old fallback.
    render(<Book />);
    expect(screen.getByRole("link")).not.toHaveFocus();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBe(saved);
    // A traversal to the earlier entry still has its original saved point.
    history.replaceState(savedState, "", destination);
    fireEvent.popState(window);
    expect(screen.getByRole("link")).toHaveFocus();
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(savedState.personBookPoint.point).not.toBeNull();
    expect(newEntryState.personBookPoint.point).toBeNull();
  });
});
