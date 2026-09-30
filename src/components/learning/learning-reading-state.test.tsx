import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrameworkChapter } from "@/lib/domain/learning-framework";
import { LearningReadingAccount, clearLearningReadingState, learningReadingKey, readLearningReadingState,
  saveLearningReadingState, useLearningReadingKey, type LearningReadingState } from "./learning-reading-state";
import { useLearningReadingPosition } from "./use-learning-reading-position";

// All identities, contents, storage and geometry in this file are synthetic.
const chapters: FrameworkChapter[] = [1, 2].map(n => ({ id: `synthetic-chapter-${n}`, runId: `synthetic-run-${n}`,
  title: `[合成] 章节${n}`, explanation: "合成正文，不应保存在阅读偏好", revision: 0, edited: false,
  nodes: [{ id: `synthetic-node-${n}`, title: `[合成] 节点${n}`, explanation: "合成节点正文", supplement: null,
    note: "合成私人笔记，不应保存在阅读偏好", sources: [], edited: false }] }));
const pageId = "synthetic-page";
let key: string, sequence = 0, scrollY = 0, rafId = 0;
let frames: Map<number, FrameRequestCallback>;
let positions: Record<string, number>;
let scrollTo: ReturnType<typeof vi.fn>;

type ReaderProps = { readingKey?: string; chapters?: FrameworkChapter[]; ready?: boolean; active?: boolean };
function Reader({ readingKey = key, chapters: value = chapters, ready = true, active = true }: ReaderProps) {
  const reading = useLearningReadingPosition({ readingKey, chapters: value, ready, active, pageId });
  return <main ref={reading.reader} hidden={!active}>
    <output data-testid="current-chapter">{reading.chapterId}</output>
    <details id="synthetic-map" ref={reading.map} open={reading.mapOpen}><summary>合成导图</summary></details>
    <button onClick={() => reading.toggleMap(!reading.mapOpen)}>切换导图</button>
    {value.map(c => <button key={`select-${c.id}`} onClick={() => reading.chooseChapter(c.id)}>选择 {c.id}</button>)}
    {value.flatMap(c => c.nodes.map(n => <button key={`map-${n.id}`} onClick={() => reading.readInMap(c.id, n.id)}>导图定位 {n.id}</button>))}
    {value.map(c => <section key={c.id} id={`chapter-${c.id}`} hidden={c.id !== reading.chapterId}>
      {c.nodes.map(n => <article key={n.id} id={`knowledge-${n.id}`} tabIndex={-1}>{n.title}</article>)}
    </section>)}
  </main>;
}
function flushFrames() {
  for (let round = 0; frames.size && round < 10; round++) {
    const queued = [...frames.entries()]; frames.clear();
    act(() => { for (const [, callback] of queued) callback(round * 16); });
  }
  expect(frames.size).toBe(0);
}
function persistScroll(top: number) {
  scrollY = top; fireEvent.scroll(window); flushFrames(); act(() => vi.advanceTimersByTime(201));
}
beforeEach(() => {
  vi.useFakeTimers(); window.localStorage.clear(); window.history.replaceState(null, "", "/learning/synthetic-page");
  key = learningReadingKey(`synthetic-account-${++sequence}`, pageId); scrollY = 0; rafId = 0; frames = new Map();
  positions = { "synthetic-map": 100, "chapter-synthetic-chapter-1": 400, "knowledge-synthetic-node-1": 500,
    "chapter-synthetic-chapter-2": 1200, "knowledge-synthetic-node-2": 1300 };
  vi.spyOn(window, "scrollY", "get").mockImplementation(() => scrollY);
  scrollTo = vi.fn((options: ScrollToOptions) => { scrollY = options.top ?? scrollY; });
  vi.stubGlobal("scrollTo", scrollTo);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++rafId, callback); return rafId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = (positions[this.id] ?? 0) - scrollY;
    return { x: 0, y: top, top, bottom: top + 100, left: 0, right: 600, width: 600, height: 100, toJSON: () => ({}) };
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("optional account/page-scoped reading preferences", () => {
  it("isolates both account and page and refuses anonymous persistence keys", () => {
    const otherAccount = learningReadingKey("synthetic-other-account", pageId);
    const otherPage = learningReadingKey("synthetic-account", "synthetic-other-page");
    saveLearningReadingState(key, { mapOpen: false });
    expect(readLearningReadingState(otherAccount)).toEqual({}); expect(readLearningReadingState(otherPage)).toEqual({});
    expect(learningReadingKey("a:b", "c")).not.toBe(learningReadingKey("a", "b:c"));
    function Probe() { return <output>{useLearningReadingKey(pageId) ?? "anonymous"}</output>; }
    const ui = render(<Probe />); expect(screen.getByText("anonymous")).toBeInTheDocument();
    ui.rerender(<LearningReadingAccount.Provider value="synthetic-other-account"><Probe /></LearningReadingAccount.Provider>);
    expect(screen.getByText(otherAccount)).toBeInTheDocument();
    saveLearningReadingState(undefined, { mapOpen: false }); expect(localStorage.length).toBe(1);
  });

  it("persists only whitelisted IDs/coordinates and merges map and reading preferences", () => {
    saveLearningReadingState(key, { mapOpen: false, position: { chapterId: "chapter", nodeId: "node", offset: 23,
      explanation: "PRIVATE BODY", sourceUrl: "PRIVATE URL" }, note: "PRIVATE NOTE", materialText: "PRIVATE ORIGINAL",
      map: { zoom: 1.3, expanded: ["chapter", "chapter"], rootOpen: true, relationsOpen: false, left: 20, top: 30,
        title: "PRIVATE TITLE" } } as unknown as LearningReadingState);
    saveLearningReadingState(key, { mapOpen: true });
    expect(readLearningReadingState(key)).toEqual({ mapOpen: true, position: { chapterId: "chapter", nodeId: "node", offset: 23 },
      map: { zoom: 1.3, expanded: ["chapter"], rootOpen: true, relationsOpen: false, left: 20, top: 30 } });
    expect(localStorage.getItem(key)).not.toContain("PRIVATE");
  });

  it("ignores malformed/incomplete storage and clamps untrusted view coordinates", () => {
    localStorage.setItem(key, "{broken"); expect(readLearningReadingState(key)).toEqual({});
    localStorage.setItem(key, JSON.stringify({ mapOpen: "true", position: { chapterId: "", offset: 3 }, map: { zoom: 1 } }));
    expect(readLearningReadingState(key)).toEqual({});
    saveLearningReadingState(key, { position: { chapterId: "chapter", offset: 9_000_000 },
      map: { zoom: 9, left: -40, top: 9_000_000, expanded: ["chapter", "", null], rootOpen: true, relationsOpen: false } } as unknown as LearningReadingState);
    expect(readLearningReadingState(key)).toMatchObject({ position: { offset: 1_000_000 },
      map: { zoom: 2, left: 0, top: 1_000_000, expanded: ["chapter"] } });
  });

  it("keeps reading functional if browser storage access is denied", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("quota", "QuotaExceededError"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    expect(readLearningReadingState(key)).toEqual({});
    expect(() => saveLearningReadingState(key, { mapOpen: false })).not.toThrow();
    expect(() => clearLearningReadingState(key)).not.toThrow();
    render(<Reader />); flushFrames(); expect(screen.getByTestId("current-chapter")).toHaveTextContent(chapters[0].id);
    fireEvent.click(screen.getByText("切换导图")); expect(document.getElementById("synthetic-map")).not.toHaveAttribute("open");
  });

  it("clears a deleted page preference and prevents an unmount's late write from resurrecting it", () => {
    saveLearningReadingState(key, { mapOpen: false }); clearLearningReadingState(key);
    expect(localStorage.getItem(key)).toBeNull();
    saveLearningReadingState(key, { position: { chapterId: "deleted-chapter", offset: 10 } });
    expect(localStorage.getItem(key)).toBeNull();
  });
});

describe("reading position hook with synthetic scroll geometry", () => {
  it("waits for chapters, then restores the saved node, offset and mapOpen", () => {
    saveLearningReadingState(key, { position: { chapterId: chapters[1].id, nodeId: chapters[1].nodes[0].id, offset: 34 }, mapOpen: false });
    const ui = render(<Reader ready={false} chapters={[]} />); flushFrames(); expect(scrollTo).not.toHaveBeenCalled();
    ui.rerender(<Reader />); flushFrames();
    expect(screen.getByTestId("current-chapter")).toHaveTextContent(chapters[1].id);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1334, behavior: "instant" });
    expect(document.getElementById("synthetic-map")).not.toHaveAttribute("open");
  });

  it("prioritizes an external explicit chapter link over browser reading history", () => {
    saveLearningReadingState(key, { position: { chapterId: chapters[0].id, nodeId: chapters[0].nodes[0].id, offset: 90 } });
    window.history.replaceState(null, "", `?chapter=${chapters[1].id}`);
    render(<Reader />); flushFrames();
    expect(screen.getByTestId("current-chapter")).toHaveTextContent(chapters[1].id);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1200, behavior: "instant" });
  });

  it("restores an own-reader refresh URL without losing the deeper node offset", () => {
    saveLearningReadingState(key, { position: { chapterId: chapters[1].id, nodeId: chapters[1].nodes[0].id, offset: 75 } });
    window.history.replaceState({ learningReadingPage: pageId }, "", `?chapter=${chapters[1].id}`);
    render(<Reader />); flushFrames();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1375, behavior: "instant" });
  });

  it("leaves explicit material/source navigation in charge of scrolling", () => {
    saveLearningReadingState(key, { position: { chapterId: chapters[1].id, nodeId: chapters[1].nodes[0].id, offset: 75 } });
    window.history.replaceState(null, "", "?material=synthetic-material");
    render(<Reader />); flushFrames(); expect(scrollTo).not.toHaveBeenCalled();
  });

  it("follows a moved node's identity and restores its offset in the destination chapter", () => {
    saveLearningReadingState(key, { position: { chapterId: chapters[0].id, nodeId: chapters[0].nodes[0].id, offset: 22 } });
    positions[`knowledge-${chapters[0].nodes[0].id}`] = 1400;
    const moved = [{ ...chapters[0], nodes: [] }, { ...chapters[1], nodes: [...chapters[1].nodes, chapters[0].nodes[0]] }];
    render(<Reader chapters={moved} />); flushFrames();
    expect(screen.getByTestId("current-chapter")).toHaveTextContent(chapters[1].id);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1422, behavior: "instant" });
  });

  it("falls back to the surviving chapter when a saved node was deleted", () => {
    saveLearningReadingState(key, { position: { chapterId: chapters[1].id, nodeId: "deleted-node", offset: 220 } });
    render(<Reader />); flushFrames();
    expect(screen.getByTestId("current-chapter")).toHaveTextContent(chapters[1].id);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1200, behavior: "instant" });
  });

  it("falls back to an existing chapter when the saved chapter was deleted", () => {
    saveLearningReadingState(key, { position: { chapterId: "deleted-chapter", offset: 220 } });
    render(<Reader />); flushFrames();
    expect(screen.getByTestId("current-chapter")).toHaveTextContent(chapters[0].id);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 400, behavior: "instant" });
  });

  it("captures new progress but does not scroll back on background chapter reload", () => {
    saveLearningReadingState(key, { position: { chapterId: chapters[0].id, nodeId: chapters[0].nodes[0].id, offset: 30 } });
    const ui = render(<Reader />); flushFrames(); persistScroll(580);
    expect(readLearningReadingState(key).position).toMatchObject({ nodeId: chapters[0].nodes[0].id, offset: 80 });
    const calls = scrollTo.mock.calls.length;
    ui.rerender(<Reader chapters={chapters.map(c => ({ ...c, revision: 1, title: c.title + " 新编辑" }))} />); flushFrames();
    expect(scrollTo).toHaveBeenCalledTimes(calls); expect(scrollY).toBe(580);
  });

  it("reveals the destination chapter before a mind-map node navigation scrolls and focuses it", () => {
    render(<Reader />); flushFrames();
    const destination = document.getElementById(`knowledge-${chapters[1].nodes[0].id}`)!;
    expect(destination.closest("[hidden]")).not.toBeNull();
    const scroll = vi.fn(() => {
      expect(destination.closest("[hidden]")).toBeNull();
      scrollY = positions[destination.id];
    });
    Object.defineProperty(destination, "scrollIntoView", { configurable: true, value: scroll });
    fireEvent.click(screen.getByRole("button", { name: `导图定位 ${chapters[1].nodes[0].id}` }));
    expect(screen.getByTestId("current-chapter")).toHaveTextContent(chapters[1].id);
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "start" });
    expect(destination).toHaveFocus();
    expect(new URLSearchParams(window.location.search).get("chapter")).toBe(chapters[1].id);
    act(() => vi.advanceTimersByTime(201));
    expect(readLearningReadingState(key).position).toEqual({ chapterId: chapters[1].id, nodeId: chapters[1].nodes[0].id, offset: 0 });
  });

  it("ignores Quiz and source-dialog scrolling while keeping the last reading position", () => {
    saveLearningReadingState(key, { position: { chapterId: chapters[0].id, nodeId: chapters[0].nodes[0].id, offset: 30 } });
    const ui = render(<Reader />); flushFrames(); persistScroll(575);
    const saved = readLearningReadingState(key).position;
    const dialog = document.createElement("section"); dialog.setAttribute("role", "dialog"); document.body.append(dialog);
    persistScroll(1900); expect(readLearningReadingState(key).position).toEqual(saved); dialog.remove();
    ui.rerender(<Reader active={false} />); persistScroll(2500);
    expect(readLearningReadingState(key).position).toEqual(saved);
    ui.rerender(<Reader active />); flushFrames();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 575, behavior: "instant" });
  });

  it("preserves map position and folded state across a normal unmount/remount", () => {
    saveLearningReadingState(key, { position: { chapterId: chapters[0].id, section: "map", offset: 15 }, mapOpen: true });
    const ui = render(<Reader />); flushFrames();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 115, behavior: "instant" });
    fireEvent.click(screen.getByText("切换导图")); ui.unmount();
    expect(readLearningReadingState(key).mapOpen).toBe(false);
    scrollY = 0; render(<Reader />); flushFrames();
    expect(document.getElementById("synthetic-map")).not.toHaveAttribute("open");
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 115, behavior: "instant" });
  });
});
