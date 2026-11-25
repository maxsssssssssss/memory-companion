import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimPersonBookEntry, hasPersonBookEntry, usePersonBookEntryCapture } from "./person-book-entrance";

const home = "/date-companion/a";
const personPath = (id = "person") => "/date-companion/a/people/" + id;
function Capture({ scope = "account/relationship", href = personPath(), readingReturn, openPerson }: {
  scope?: string; href?: string; readingReturn?: boolean; openPerson?: string;
}) {
  usePersonBookEntryCapture(scope || undefined);
  return <><a href={href} data-person-book-return={readingReturn ? "" : undefined}
    onClick={event => event.preventDefault()}>人物</a>{openPerson && <div data-person-book-id={openPerson} />}</>;
}

function pointerVisit(link: HTMLElement) {
  fireEvent.pointerDown(link);
  fireEvent.click(link, { detail: 1, button: 0 });
  history.replaceState(null, "", link.getAttribute("href")!);
}

describe("person paper entrance navigation ticket", () => {
  beforeEach(() => {
    history.replaceState(null, "", home);
    // Exercise the real capture lifecycle to reset the previous test's scope.
    render(<Capture scope="" />).unmount();
  });
  afterEach(() => { cleanup(); history.replaceState(null, "", "/"); vi.restoreAllMocks(); });

  it("allows three new active visits to the same person, but consumes each visit only once", () => {
    const { getByRole, rerender } = render(<Capture />);
    for (let visit = 0; visit < 3; visit++) {
      history.replaceState(null, "", home);
      pointerVisit(getByRole("link"));
      expect(hasPersonBookEntry("account/relationship", "person")).toBe(true);
      expect(claimPersonBookEntry("account/relationship", "person")).toBe(true);
      rerender(<Capture />);
      expect(claimPersonBookEntry("account/relationship", "person")).toBe(false);
      // Reading effects can still distinguish the claimed active arrival.
      expect(hasPersonBookEntry("account/relationship", "person")).toBe(true);
    }
  });

  it("does not consume a newer ticket for an old account, person, or route", () => {
    const { getByRole } = render(<Capture />);
    fireEvent.click(getByRole("link"), { detail: 1 });
    expect(claimPersonBookEntry("account/relationship", "person")).toBe(false);
    history.replaceState(null, "", personPath());
    expect(claimPersonBookEntry("another-account/relationship", "person")).toBe(false);
    expect(claimPersonBookEntry("account/another-relationship", "person")).toBe(false);
    expect(claimPersonBookEntry("account/relationship", "other-person")).toBe(false);
    expect(hasPersonBookEntry("account/relationship", null)).toBe(false);
    expect(claimPersonBookEntry("account/relationship", "person")).toBe(true);
  });

  it("supersedes a rapid earlier person navigation without letting its late claim consume the final one", () => {
    const { getByRole, rerender } = render(<Capture href={personPath("a")} />);
    fireEvent.click(getByRole("link"), { detail: 1 });
    rerender(<Capture href={personPath("b")} />);
    pointerVisit(getByRole("link"));
    expect(claimPersonBookEntry("account/relationship", "a")).toBe(false);
    expect(claimPersonBookEntry("account/relationship", "b")).toBe(true);
    history.replaceState(null, "", home);
    rerender(<Capture href={personPath("a")} />);
    pointerVisit(getByRole("link"));
    expect(claimPersonBookEntry("account/relationship", "a")).toBe(true);
  });

  it("does not let a cold/refresh or keyboard arrival block the next pointer visit", () => {
    const { getByRole } = render(<Capture />);
    history.replaceState(null, "", personPath());
    expect(claimPersonBookEntry("account/relationship", "person")).toBe(false);
    history.replaceState(null, "", home);
    fireEvent.click(getByRole("link"), { detail: 0 });
    history.replaceState(null, "", personPath());
    expect(claimPersonBookEntry("account/relationship", "person")).toBe(false);
    history.replaceState(null, "", home);
    pointerVisit(getByRole("link"));
    expect(claimPersonBookEntry("account/relationship", "person")).toBe(true);
  });

  it.each(["ctrlKey", "metaKey", "altKey", "shiftKey"] as const)("keeps %s navigation static without reserving future visits", modifier => {
    const { getByRole } = render(<Capture />);
    fireEvent.click(getByRole("link"), { detail: 1, [modifier]: true });
    history.replaceState(null, "", personPath());
    expect(claimPersonBookEntry("account/relationship", "person")).toBe(false);
    history.replaceState(null, "", home);
    pointerVisit(getByRole("link"));
    expect(claimPersonBookEntry("account/relationship", "person")).toBe(true);
  });

  it.each(["pointerdown", "keydown", "wheel", "touchstart", "popstate", "pagehide"])("cancels %s only for the current navigation", event => {
    const { getByRole } = render(<Capture />);
    fireEvent.click(getByRole("link"), { detail: 1 });
    const target = event === "popstate" || event === "pagehide" ? window : document;
    fireEvent(target, new Event(event, { bubbles: true }));
    history.replaceState(null, "", personPath());
    expect(claimPersonBookEntry("account/relationship", "person")).toBe(false);
    history.replaceState(null, "", home);
    pointerVisit(getByRole("link"));
    expect(claimPersonBookEntry("account/relationship", "person")).toBe(true);
  });

  it("expires an old intention without stopping a later fresh click", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const { getByRole } = render(<Capture />);
    pointerVisit(getByRole("link"));
    clock.mockReturnValue(10_100);
    expect(hasPersonBookEntry("account/relationship", "person")).toBe(false);
    expect(claimPersonBookEntry("account/relationship", "person")).toBe(false);
    history.replaceState(null, "", home);
    pointerVisit(getByRole("link"));
    expect(claimPersonBookEntry("account/relationship", "person")).toBe(true);
  });

  it("clears a pending intention on account/relationship scope change and supports the new scope", () => {
    const { getByRole, rerender } = render(<Capture />);
    pointerVisit(getByRole("link"));
    rerender(<Capture scope="another-account/another-relationship" />);
    expect(claimPersonBookEntry("account/relationship", "person")).toBe(false);
    expect(claimPersonBookEntry("another-account/another-relationship", "person")).toBe(false);
    history.replaceState(null, "", home);
    pointerVisit(getByRole("link"));
    expect(claimPersonBookEntry("another-account/another-relationship", "person")).toBe(true);
    rerender(<Capture scope="" />);
    expect(hasPersonBookEntry("another-account/another-relationship", "person")).toBe(false);
  });

  it("does not classify an explicit return to the saved paper as a new active entry", () => {
    const { getByRole, rerender } = render(<Capture readingReturn />);
    pointerVisit(getByRole("link"));
    expect(claimPersonBookEntry("account/relationship", "person")).toBe(false);
    history.replaceState(null, "", home);
    rerender(<Capture />);
    pointerVisit(getByRole("link"));
    expect(claimPersonBookEntry("account/relationship", "person")).toBe(true);
  });

  it("keeps the current pathname and a canonical link to the already open alias static", () => {
    history.replaceState(null, "", personPath());
    const { getByRole, rerender } = render(<Capture />);
    pointerVisit(getByRole("link"));
    expect(claimPersonBookEntry("account/relationship", "person")).toBe(false);
    history.replaceState(null, "", "/date-companion/a/people?from=book-home");
    rerender(<Capture openPerson="person" />);
    pointerVisit(getByRole("link"));
    expect(claimPersonBookEntry("account/relationship", "person")).toBe(false);
    rerender(<Capture openPerson="person" href={personPath("another-person")} />);
    pointerVisit(getByRole("link"));
    expect(claimPersonBookEntry("account/relationship", "another-person")).toBe(true);
  });

  it("supports the verified single-person alias without requiring a redirect", () => {
    const { getByRole } = render(<Capture href="/date-companion/a/people?from=book-home" />);
    pointerVisit(getByRole("link"));
    expect(claimPersonBookEntry("account/relationship", "person")).toBe(true);
    expect(claimPersonBookEntry("account/relationship", "person")).toBe(false);
  });

  it.each(["section=archive", "section=directory", "personSource=source", "personFull=source"])("excludes the reading subroute %s", query => {
    const { getByRole } = render(<Capture href={personPath() + "&" + query} />);
    pointerVisit(getByRole("link"));
    expect(claimPersonBookEntry("account/relationship", "person")).toBe(false);
  });
});
