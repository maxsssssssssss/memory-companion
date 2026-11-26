import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyDateCompanionViewModel, type DateCompanionMemoryBridgeState } from "@/lib/domain/date-companion";
import type { DateCompanionSessionValue } from "@/lib/client/date-companion-session";
import { CompanionPersonScrapbook } from "./companion-person-scrapbook";

const environment = vi.hoisted(() => ({ search: "view=book", reduced: false, mobile: false }));
const claim = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  usePathname: () => "/date-companion/a/people/person",
  useSearchParams: () => new URLSearchParams(environment.search)
}));
vi.mock("motion/react", async importOriginal => ({
  ...await importOriginal<typeof import("motion/react")>(),
  useReducedMotion: () => environment.reduced
}));
// Ticket creation/consumption is covered by person-book-entrance.test.tsx.
// These tests exercise the mounted paper group after that one navigation claim.
vi.mock("./person-book-entrance", () => ({ claimPersonBookEntry: claim, hasPersonBookEntry: () => false }));
vi.mock("./person-book-navigation", () => ({
  usePersonBookNavigation: () => ({ sourceId: null, fullId: null, openSource: vi.fn(), rememberMeeting: vi.fn() })
}));

const date = "2026-11-01T12:00:00.000Z";
const person = (id: string) => ({ id, displayName: id, status: "confirmed" as const, explicitlyConfirmed: true as const,
  version: 1, confirmedAt: date, createdAt: date, updatedAt: date });
const mapping = { id: "mapping", selfPersonId: "self", companionPersonId: "person", status: "confirmed" as const,
  relationshipType: "friend" as const, version: 1, confirmedAt: date, createdAt: date, updatedAt: date };
const setting = { enabled: false, version: 1, enabledAt: null, disabledAt: date, createdAt: date, updatedAt: date };
const bridge: DateCompanionMemoryBridgeState = { status: "ready", mapping, people: [person("self"), person("person")], setting,
  selfBinding: { personId: "self", status: "active", version: 1, setAt: date, clearedAt: null, updatedAt: date },
  review: { mapping, retention: setting, interactions: [] }, retainedSubjects: {}, memoryRetainedSourceKeys: [],
  relationshipPersonSources: [], personQaSources: [] };

function props(pending = false): ComponentProps<typeof CompanionPersonScrapbook> {
  const vm = emptyDateCompanionViewModel();
  vm.relationship = { id: "relationship", status: "active", participantState: "confirmed" };
  vm.recap.history = [{ id: "upload", relationshipInteractionId: "meeting", sourceUploadId: "upload", uploadIds: ["upload"],
    persistenceStatus: "confirmed", sourceState: "available", recordingDate: "2026-11-01", fileName: "散步.m4a", title: "一起散步",
    status: "ready", transcript: [], detailLoaded: !pending, savedExcerpt: pending ? null : "已保存的见面摘要。" }];
  if (!pending) {
    const item = { id: "remembered", interactionId: "meeting", kind: "mentioned" as const, title: "提到", proposedText: "正在做画册",
      displayedText: "正在做画册", disposition: "kept" as const, sources: [{ id: "source", uploadId: "upload", segmentIds: ["segment"],
        quote: "正在做画册", recordingDate: "2026-11-01", startSeconds: 1, endSeconds: 2, kind: "relationship" as const,
        presentation: "direct_quote" as const }], version: 1, sortOrder: 0 };
    vm.person.remembered = [item];
    vm.person.relationship = [{ ...item, id: "shared", displayedText: "一起看了画展" }];
  }
  const session = { memoryBridgeState: bridge, viewModel: vm, relationshipDetailsLoaded: !pending,
    detailReadState: { status: pending ? "loading" : "ready" }, mutationState: { status: "idle" }, searchState: { status: "idle" }
  } as unknown as DateCompanionSessionValue;
  return { screen: "person", accountId: "account", relationshipId: "relationship", personId: "person", session,
    archiveState: pending ? { status: "loading" } : { status: "ready", archive: { person: person("person"), entries: [] } },
    onRetryArchive: vi.fn(), directoryHref: "/people", personHref: id => "/people/" + id,
    managementHref: () => "/manage", meetingHref: () => "/recap" };
}

type RecordedAnimation = {
  part: string;
  shadow: boolean;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  cancel: ReturnType<typeof vi.fn>;
};
let animations: RecordedAnimation[];
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let reducedQuery: EventTarget & { matches: boolean };
let belowFold: Set<string>;
const papers = () => animations.filter(animation => !animation.shadow);
function flushFrame() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(16));
  });
}
function changeReduced(matches: boolean) {
  environment.reduced = matches;
  reducedQuery.matches = matches;
  act(() => reducedQuery.dispatchEvent(new Event("change")));
}

describe("person paper group navigation lifetime", () => {
  beforeEach(() => {
    environment.search = "view=book";
    environment.reduced = false;
    environment.mobile = false;
    animations = [];
    frames = new Map();
    frameId = 0;
    belowFold = new Set();
    claim.mockReset().mockReturnValueOnce(true).mockReturnValue(false);
    reducedQuery = Object.assign(new EventTarget(), { matches: false });
    const widthQuery = Object.assign(new EventTarget(), { get matches() { return environment.mobile; } });
    Object.defineProperty(widthQuery, "matches", { get: () => environment.mobile });
    vi.stubGlobal("matchMedia", vi.fn((query: string) => query.includes("prefers-reduced-motion") ? reducedQuery : widthQuery));
    vi.stubGlobal("innerHeight", 1000);
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const top = belowFold.has(this.dataset.paperPart ?? "") ? 1200 : 200;
      return { x: 0, y: top, top, left: 0, right: 300, bottom: top + 200, width: 300, height: 200, toJSON: () => ({}) };
    });
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, writable: true, value:
      vi.fn(function (this: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
        const entry: RecordedAnimation = { part: this.closest<HTMLElement>("[data-paper-part]")!.dataset.paperPart!,
          shadow: this.classList.contains("scrap-landing-shadow"), frames: keyframes, options, cancel: vi.fn() };
        animations.push(entry);
        return { cancel: entry.cancel } as unknown as Animation;
      }) });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("keeps the approved desktop sequence and readable content while starting one paper group", () => {
    render(<CompanionPersonScrapbook {...props()} />);
    expect(screen.getByText("正在做画册")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /翻开这次复盘/ })).toBeInTheDocument();
    flushFrame();
    expect(papers().map(animation => [animation.part, animation.options.duration, animation.options.delay])).toEqual([
      ["landscape", 400, 0], ["lead", 460, 65], ["shared", 330, 140], ["meeting", 330, 180]
    ]);
    expect(papers().map(animation => animation.frames[0].transform)).toEqual([
      "translate3d(-14px,-28px,0) rotate(-2deg)", "translate3d(18px,-34px,0) rotate(2.5deg)",
      "translate3d(-7px,-16px,0) rotate(-1deg)", "translate3d(8px,-18px,0) rotate(1.2deg)"
    ]);
    expect(papers().every(animation => animation.options.easing === "cubic-bezier(.23,1,.32,1)" && animation.options.fill === "backwards")).toBe(true);
    expect(animations.filter(animation => animation.shadow).map(animation => animation.options.duration)).toEqual([455, 515, 385, 385]);
  });

  it("starts one live sequence after StrictMode lifecycle replay, rather than cancelling its only visible run", () => {
    render(<StrictMode><CompanionPersonScrapbook {...props()} /></StrictMode>);
    flushFrame();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(papers()).toHaveLength(4);
    expect(animations.every(animation => animation.cancel.mock.calls.length === 0)).toBe(true);
  });

  it("does not replay seen papers for new model objects, background reads, or source query changes", () => {
    const { container, rerender } = render(<CompanionPersonScrapbook {...props()} />);
    flushFrame();
    const originalLead = container.querySelector(".scrap-lead");
    rerender(<CompanionPersonScrapbook {...props()} archiveState={{ status: "loading" }} />);
    flushFrame();
    expect(container.querySelector(".scrap-reading")).toBeNull();
    expect(originalLead).toBeInTheDocument();
    environment.search = "view=book&personSource=remembered&personFull=source";
    rerender(<CompanionPersonScrapbook {...props()} />);
    flushFrame();
    environment.search = "view=book";
    rerender(<CompanionPersonScrapbook {...props()} />);
    flushFrame();
    expect(papers()).toHaveLength(4);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("only adds unseen papers when the initial reads finish, without moving the already visible watercolor again", () => {
    const { rerender } = render(<CompanionPersonScrapbook {...props(true)} />);
    flushFrame();
    expect(papers().map(animation => animation.part)).toEqual(["landscape", "lead", "meeting"]);
    rerender(<CompanionPersonScrapbook {...props()} />);
    flushFrame();
    rerender(<CompanionPersonScrapbook {...props()} />);
    flushFrame();
    expect(papers().map(animation => animation.part)).toEqual(["landscape", "lead", "meeting", "shared"]);
  });

  it("keeps an arrival without a navigation claim static, but lets a later new claim animate", () => {
    claim.mockReset().mockReturnValue(false);
    const first = render(<CompanionPersonScrapbook {...props(true)} />);
    flushFrame();
    first.rerender(<CompanionPersonScrapbook {...props()} />);
    flushFrame();
    expect(animations).toHaveLength(0);
    first.unmount();
    claim.mockReturnValueOnce(true);
    render(<CompanionPersonScrapbook {...props()} />);
    flushFrame();
    expect(papers()).toHaveLength(4);
  });

  it("stops running papers immediately for reduced motion and does not catch up when the preference is disabled", () => {
    const first = render(<CompanionPersonScrapbook {...props()} />);
    flushFrame();
    const current = [...animations];
    changeReduced(true);
    expect(current.every(animation => animation.cancel.mock.calls.length > 0)).toBe(true);
    first.rerender(<CompanionPersonScrapbook {...props()} />);
    changeReduced(false);
    first.rerender(<CompanionPersonScrapbook {...props()} />);
    flushFrame();
    expect(papers()).toHaveLength(4);
    first.unmount();
    claim.mockReturnValueOnce(true);
    render(<CompanionPersonScrapbook {...props()} />);
    flushFrame();
    expect(papers()).toHaveLength(8);
    expect(animations.slice(current.length).every(animation => animation.cancel.mock.calls.length === 0)).toBe(true);
  });

  it("keeps a reduced-motion arrival static for that visit only", () => {
    environment.reduced = true;
    reducedQuery.matches = true;
    const first = render(<CompanionPersonScrapbook {...props(true)} />);
    flushFrame();
    changeReduced(false);
    first.rerender(<CompanionPersonScrapbook {...props()} />);
    flushFrame();
    expect(animations).toHaveLength(0);
    first.unmount();
    claim.mockReturnValueOnce(true);
    render(<CompanionPersonScrapbook {...props()} />);
    flushFrame();
    expect(papers()).toHaveLength(4);
  });

  it("cancels after reader input and never animates late materials in that interrupted visit", () => {
    const first = render(<CompanionPersonScrapbook {...props(true)} />);
    flushFrame();
    fireEvent.wheel(document);
    expect(animations.every(animation => animation.cancel.mock.calls.length > 0)).toBe(true);
    first.rerender(<CompanionPersonScrapbook {...props()} />);
    flushFrame();
    expect(papers().map(animation => animation.part)).toEqual(["landscape", "lead", "meeting"]);
    first.unmount();
    claim.mockReturnValueOnce(true);
    render(<CompanionPersonScrapbook {...props()} />);
    flushFrame();
    expect(papers()).toHaveLength(7);
  });

  it("cancels a departing visit without letting its deferred start reach the next visit", () => {
    const first = render(<CompanionPersonScrapbook {...props()} />);
    first.unmount();
    flushFrame();
    expect(animations).toHaveLength(0);
    claim.mockReturnValueOnce(true);
    const next = render(<CompanionPersonScrapbook {...props()} />);
    flushFrame();
    expect(papers()).toHaveLength(4);
    expect(animations.every(animation => animation.cancel.mock.calls.length === 0)).toBe(true);
    next.unmount();
    expect(animations.every(animation => animation.cancel.mock.calls.length > 0)).toBe(true);
  });

  it("retains the mobile visible-paper policy and does not later replay an offscreen paper", () => {
    environment.mobile = true;
    vi.stubGlobal("innerHeight", 844);
    belowFold.add("lead");
    const { rerender } = render(<CompanionPersonScrapbook {...props()} />);
    flushFrame();
    expect(papers().map(animation => [animation.part, animation.options.duration])).toEqual([["landscape", 420]]);
    expect(papers()[0].frames[0].transform).toBe("translate3d(-9.799999999999999px,-24px,0) rotate(-1.5deg)");
    belowFold.clear();
    rerender(<CompanionPersonScrapbook {...props()} />);
    flushFrame();
    expect(papers()).toHaveLength(1);
  });
});
