import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";
import type { FrameworkChapter } from "@/lib/domain/learning-framework";
import { ProductDialog } from "@/components/product-system/product-primitives";
import { readLearningReadingState, saveLearningReadingState } from "./learning-reading-state";
import { LearningMindMap } from "./learning-mind-map";

const chapters: FrameworkChapter[] = [1, 2].map(n => ({ id: `chapter-${n}`, runId: `run-${n}`, title: `[合成] 章节${n}`, explanation: "已保存的解释", revision: 0, edited: false,
  nodes: [{ id: `node-${n}`, title: `[合成] 知识点${n}`, explanation: "正文", supplement: null, note: n === 1 ? "个人笔记" : "", edited: false, sources: [] }] }));
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  window.localStorage.clear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setViewportGeometry() {
  const viewport = screen.getByRole("region", { name: "章节思维导图" });
  Object.defineProperties(viewport, { clientWidth: { configurable: true, value: 400 }, clientHeight: { configurable: true, value: 240 } });
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ x: 30, y: 40, top: 40, left: 30, right: 430, bottom: 280, width: 400, height: 240, toJSON: () => ({}) });
  return viewport;
}

function pointer(target: Element, type: string, init: MouseEventInit & { pointerType?: string; pointerId?: number } = {}) {
  const { pointerType = "mouse", pointerId = 1, ...mouse } = init;
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...mouse });
  Object.defineProperties(event, { pointerType: { value: pointerType }, pointerId: { value: pointerId } });
  fireEvent(target, event);
  return event;
}

it("collapses branches and root without losing the original chapter/node navigation identities", () => {
  const onChapter = vi.fn(), onNode = vi.fn();
  render(<LearningMindMap chapters={chapters} relations={[]} onChapter={onChapter} onNode={onNode} renderRelation={() => null} />);
  expect(screen.getByRole("button", { name: /知识点1/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: /知识点2/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /章节 2.*章节2/ }));
  fireEvent.click(screen.getByRole("button", { name: /知识点2/ }));
  expect(onNode).toHaveBeenCalledWith("chapter-2", "node-2");
  fireEvent.click(screen.getByRole("button", { name: "阅读章节：[合成] 章节2" }));
  expect(onChapter).toHaveBeenCalledWith("chapter-2");
  fireEvent.click(screen.getByRole("button", { name: "收起分支" }));
  expect(screen.queryByRole("button", { name: /知识点1/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "展开全部" }));
  expect(screen.getByRole("button", { name: /知识点2/ })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /学习脉络/ }));
  expect(screen.queryByRole("button", { name: /知识点2/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /学习脉络/ }));
  expect(screen.getByRole("button", { name: /知识点2/ })).toBeVisible();
});

it("opens only the selected saved relation and never invents relations when none exist", () => {
  const renderRelation = vi.fn(index => <p>{`[合成] 关系正文${index}`}</p>);
  const ui = render(<LearningMindMap chapters={chapters} relations={[{ kind: "conflict", title: "两份材料不同", explanation: "保留不同条件", chapterIds: ["chapter-1", "chapter-2"], sources: [] }]} renderRelation={renderRelation} />);
  expect(renderRelation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /材料冲突.*两份材料不同/ }));
  expect(screen.getByText("[合成] 关系正文0")).toBeVisible();
  expect(renderRelation).toHaveBeenLastCalledWith(0, expect.objectContaining({ beforeSource: expect.any(Function), navigateChapter: expect.any(Function) }));
  fireEvent.click(screen.getByRole("button", { name: "收起详情" }));
  expect(screen.queryByText("[合成] 关系正文0")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /材料冲突.*两份材料不同/ })).toHaveFocus();
  ui.rerender(<LearningMindMap chapters={chapters} relations={[]} renderRelation={renderRelation} />);
  expect(screen.queryByText("跨章节联系")).not.toBeInTheDocument();
});

it("retains collapsed state across ordinary chapter refreshes and displays updated titles", () => {
  const onNode = vi.fn();
  const ui = render(<LearningMindMap chapters={chapters} relations={[]} onNode={onNode} renderRelation={() => null} />);
  fireEvent.click(screen.getByRole("button", { name: /章节 1.*章节1/ }));
  ui.rerender(<LearningMindMap chapters={chapters.map(c => ({ ...c, revision: 1, title: c.title + " 已编辑" }))} relations={[]} onNode={onNode} renderRelation={() => null} />);
  expect(screen.getByRole("button", { name: /章节 1.*已编辑/ })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: /知识点1/ })).not.toBeInTheDocument();
});

it("does not reuse a selected relation index for a newly published relation", () => {
  const oldRelation = { kind: "connection" as const, title: "旧联系", explanation: "旧正文", chapterIds: ["chapter-1", "chapter-2"], sources: [] };
  const renderRelation = vi.fn(() => <p>仅在明确选中后阅读</p>);
  const ui = render(<LearningMindMap chapters={chapters} relations={[oldRelation]} renderRelation={renderRelation} />);
  fireEvent.click(screen.getByRole("button", { name: /相关联系.*旧联系/ }));
  expect(screen.getByText("仅在明确选中后阅读")).toBeVisible();
  renderRelation.mockClear();
  ui.rerender(<LearningMindMap chapters={chapters} relations={[{ ...oldRelation, title: "新联系" }]} renderRelation={renderRelation} />);
  expect(renderRelation).not.toHaveBeenCalled();
  expect(screen.queryByText("仅在明确选中后阅读")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /相关联系.*新联系/ })).toHaveAttribute("aria-expanded", "false");
});

it("offers bounded zoom controls and preserves the reading scale while folding branches", () => {
  render(<LearningMindMap chapters={chapters} relations={[]} onNode={vi.fn()} renderRelation={() => null} />);
  const zoom = () => screen.getByLabelText("思维导图缩放比例");
  const plus = screen.getByRole("button", { name: "放大思维导图" });
  const minus = screen.getByRole("button", { name: "缩小思维导图" });
  expect(zoom()).toHaveTextContent("100%");
  fireEvent.click(plus);
  expect(zoom()).toHaveTextContent("110%");
  fireEvent.click(screen.getByRole("button", { name: "收起分支" }));
  fireEvent.click(screen.getByRole("button", { name: "展开全部" }));
  expect(zoom()).toHaveTextContent("110%");
  for (let i = 0; i < 20; i++) fireEvent.click(plus);
  expect(zoom()).toHaveTextContent("200%");
  expect(plus).toBeDisabled();
  for (let i = 0; i < 20; i++) fireEvent.click(minus);
  expect(zoom()).toHaveTextContent("50%");
  expect(minus).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "恢复原大小" }));
  expect(zoom()).toHaveTextContent("100%");
  expect(plus).toBeEnabled();
  expect(minus).toBeEnabled();
});

it("only captures Ctrl wheel inside the map, leaving ordinary and page scrolling alone", () => {
  render(<LearningMindMap chapters={chapters} relations={[]} renderRelation={() => null} />);
  const viewport = screen.getByRole("region", { name: "章节思维导图" });
  const ordinary = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
  fireEvent(viewport, ordinary);
  expect(ordinary.defaultPrevented).toBe(false);
  expect(screen.getByLabelText("思维导图缩放比例")).toHaveTextContent("100%");
  const mapZoom = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 });
  fireEvent(viewport, mapZoom);
  expect(mapZoom.defaultPrevented).toBe(true);
  const zoomed = screen.getByLabelText("思维导图缩放比例").textContent!;
  expect(Number.parseInt(zoomed)).toBeGreaterThan(100);
  const pageZoom = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 });
  fireEvent(document.body, pageZoom);
  expect(pageZoom.defaultPrevented).toBe(false);
  expect(screen.getByLabelText("思维导图缩放比例")).toHaveTextContent(zoomed);
});

it("keeps the same map point under the cursor when Ctrl wheel changes scale", () => {
  render(<LearningMindMap chapters={chapters} relations={[]} renderRelation={() => null} />);
  const viewport = setViewportGeometry();
  viewport.scrollLeft = 100; viewport.scrollTop = 80;
  const cursor = { x: 120, y: 60 };
  const originalPoint = { x: viewport.scrollLeft + cursor.x, y: viewport.scrollTop + cursor.y };
  fireEvent(viewport, new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, clientX: 30 + cursor.x, clientY: 40 + cursor.y }));
  const scale = Number.parseInt(screen.getByLabelText("思维导图缩放比例").textContent!) / 100;
  expect((viewport.scrollLeft + cursor.x) / scale).toBeCloseTo(originalPoint.x);
  expect((viewport.scrollTop + cursor.y) / scale).toBeCloseTo(originalPoint.y);
});

it("fits the visible map to the viewport and keeps very large maps readable at the minimum scale", () => {
  render(<LearningMindMap chapters={chapters} relations={[]} renderRelation={() => null} />);
  const viewport = setViewportGeometry();
  const canvas = screen.getByRole("button", { name: /学习脉络/ }).parentElement!;
  Object.defineProperties(canvas, { offsetWidth: { configurable: true, value: 600 }, offsetHeight: { configurable: true, value: 400 } });
  viewport.scrollLeft = 100; viewport.scrollTop = 80;
  fireEvent.click(screen.getByRole("button", { name: "适应窗口" }));
  expect(screen.getByLabelText("思维导图缩放比例")).toHaveTextContent("60%");
  expect(viewport.scrollLeft).toBe(0);
  expect(viewport.scrollTop).toBe(0);
  Object.defineProperty(canvas, "offsetWidth", { configurable: true, value: 1600 });
  fireEvent.click(screen.getByRole("button", { name: "适应窗口" }));
  expect(screen.getByLabelText("思维导图缩放比例")).toHaveTextContent("50%");
});

it("pans blank space with the mouse but leaves node clicks and touch scrolling available", () => {
  const onNode = vi.fn();
  render(<LearningMindMap chapters={chapters} relations={[]} onNode={onNode} renderRelation={() => null} />);
  const viewport = setViewportGeometry();
  Object.assign(viewport, { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => true), releasePointerCapture: vi.fn() });
  viewport.scrollLeft = 100; viewport.scrollTop = 80;
  const start = pointer(viewport, "pointerdown", { clientX: 150, clientY: 100 });
  expect(start.defaultPrevented).toBe(true);
  pointer(viewport, "pointermove", { clientX: 110, clientY: 70 });
  expect(viewport.scrollLeft).toBe(140);
  expect(viewport.scrollTop).toBe(110);
  pointer(viewport, "pointerup");
  pointer(viewport, "pointermove", { clientX: 90, clientY: 60 });
  expect(viewport.scrollLeft).toBe(140);
  const node = screen.getByRole("button", { name: /知识点1/ });
  const nodeStart = pointer(node, "pointerdown", { clientX: 150, clientY: 100 });
  pointer(viewport, "pointermove", { clientX: 110, clientY: 70 });
  expect(nodeStart.defaultPrevented).toBe(false);
  expect(viewport.scrollLeft).toBe(140);
  fireEvent.click(node);
  expect(onNode).toHaveBeenCalledWith("chapter-1", "node-1");
  const touchStart = pointer(viewport, "pointerdown", { pointerType: "touch", clientX: 150, clientY: 100 });
  pointer(viewport, "pointermove", { pointerType: "touch", clientX: 110, clientY: 70 });
  expect(touchStart.defaultPrevented).toBe(false);
  expect(viewport.scrollLeft).toBe(140);
});

it("keeps one map state in fullscreen, closes with Escape and restores its entry focus", async () => {
  render(<LearningMindMap chapters={chapters} relations={[]} onNode={vi.fn()} renderRelation={() => null} />);
  fireEvent.click(screen.getByRole("button", { name: "放大思维导图" }));
  fireEvent.click(screen.getByRole("button", { name: /章节 2.*章节2/ }));
  const entry = screen.getByRole("button", { name: "全屏查看" }); entry.focus();
  fireEvent.click(entry);
  const dialog = screen.getByRole("dialog", { name: "思维导图" });
  expect(screen.getAllByRole("region", { name: "章节思维导图" })).toHaveLength(1);
  expect(within(dialog).getByLabelText("思维导图缩放比例")).toHaveTextContent("110%");
  expect(within(dialog).getByRole("button", { name: /知识点2/ })).toBeVisible();
  expect(document.body.style.overflow).toBe("hidden");
  fireEvent.click(within(dialog).getByRole("button", { name: "放大思维导图" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByLabelText("思维导图缩放比例")).toHaveTextContent("120%");
  expect(screen.getByRole("button", { name: /知识点2/ })).toBeVisible();
  await waitFor(() => expect(screen.getByRole("button", { name: "全屏查看" })).toHaveFocus());
  expect(document.body.style.overflow).not.toBe("hidden");
});

it("leaves fullscreen before navigating to a knowledge point", async () => {
  const navigate = vi.fn(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  render(<LearningMindMap chapters={chapters} relations={[]} onNode={navigate} renderRelation={() => null} />);
  fireEvent.click(screen.getByRole("button", { name: "全屏查看" }));
  fireEvent.click(screen.getByRole("button", { name: /知识点1/ }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("chapter-1", "node-1"));
});

it("releases the fullscreen dialog before opening a source dialog", async () => {
  function SourceFlow() {
    const [source, setSource] = useState(false);
    return <><LearningMindMap chapters={chapters} relations={[{ kind: "connection", title: "合成联系", explanation: "原文联系", chapterIds: ["chapter-1", "chapter-2"], sources: [] }]}
      renderRelation={(_, actions) => <button type="button" onClick={() => actions?.beforeSource(() => setSource(true))}>查看合成来源</button>} />
      <ProductDialog open={source} onClose={() => setSource(false)} title="合成来源"><p>合成原文</p></ProductDialog></>;
  }
  render(<SourceFlow />);
  fireEvent.click(screen.getByRole("button", { name: "全屏查看" }));
  fireEvent.click(screen.getByRole("button", { name: /相关联系.*合成联系/ }));
  fireEvent.click(screen.getByRole("button", { name: "查看合成来源" }));
  await screen.findByRole("dialog", { name: "合成来源" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(document.body.style.overflow).toBe("hidden");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(document.body.style.overflow).not.toBe("hidden");
});

it("saves only map preferences, throttles scrolling and restores them after remount", () => {
  vi.useFakeTimers();
  const key = "[synthetic] map-reader";
  saveLearningReadingState(key, { position: { chapterId: "chapter-2", offset: 20 } });
  const write = vi.spyOn(Storage.prototype, "setItem");
  const ui = render(<LearningMindMap readingKey={key} chapters={chapters} relations={[]} renderRelation={() => null} />);
  fireEvent.click(screen.getByRole("button", { name: "放大思维导图" }));
  fireEvent.click(screen.getByRole("button", { name: /章节 2.*章节2/ }));
  const viewport = setViewportGeometry();
  viewport.scrollLeft = 180; viewport.scrollTop = 95;
  fireEvent.scroll(viewport); fireEvent.scroll(viewport);
  expect(write).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(250); });
  expect(write).toHaveBeenCalledTimes(1);
  expect(readLearningReadingState(key)).toMatchObject({ position: { chapterId: "chapter-2", offset: 20 }, map: { zoom: 1.1, expanded: ["chapter-1", "chapter-2"], left: 180, top: 95 } });
  ui.unmount();
  render(<LearningMindMap readingKey={key} chapters={chapters} relations={[]} renderRelation={() => null} />);
  expect(screen.getByLabelText("思维导图缩放比例")).toHaveTextContent("110%");
  expect(screen.getByRole("button", { name: /章节 2.*章节2/ })).toHaveAttribute("aria-expanded", "true");
});

it("waits for measurable content before restoring pan and filters removed chapter IDs after data loads", () => {
  const key = "[synthetic] delayed-map";
  saveLearningReadingState(key, { map: { zoom: 1.4, expanded: ["chapter-2", "removed"], rootOpen: true, relationsOpen: false, left: 120, top: 75 } });
  const observers: Array<() => void> = [];
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} });
  const ui = render(<LearningMindMap readingKey={key} chapters={[]} relations={[]} renderRelation={() => null} />);
  expect(screen.getByLabelText("思维导图缩放比例")).toHaveTextContent("140%");
  const viewport = setViewportGeometry();
  const canvas = screen.getByRole("button", { name: /学习脉络/ }).parentElement!;
  Object.defineProperties(canvas, { offsetWidth: { configurable: true, value: 1000 }, offsetHeight: { configurable: true, value: 800 } });
  ui.rerender(<LearningMindMap readingKey={key} chapters={chapters} relations={[]} renderRelation={() => null} />);
  act(() => { observers.forEach(observer => observer()); });
  expect(viewport.scrollLeft).toBe(120); expect(viewport.scrollTop).toBe(75);
  expect(screen.getByRole("button", { name: /章节 2.*章节2/ })).toHaveAttribute("aria-expanded", "true");
  fireEvent(window, new Event("pagehide"));
  expect(readLearningReadingState(key).map?.expanded).toEqual(["chapter-2"]);
  expect(readLearningReadingState(key).map?.left).toBe(120);
});

it("keeps different reading keys separate and works when browser storage is unavailable", () => {
  const first = "[synthetic] account-a", second = "[synthetic] account-b";
  saveLearningReadingState(first, { map: { zoom: 1.5, expanded: [], rootOpen: true, relationsOpen: true, left: 0, top: 0 } });
  const ui = render(<LearningMindMap readingKey={first} chapters={chapters} relations={[]} renderRelation={() => null} />);
  expect(screen.getByLabelText("思维导图缩放比例")).toHaveTextContent("150%");
  ui.rerender(<LearningMindMap readingKey={second} chapters={chapters} relations={[]} renderRelation={() => null} />);
  expect(screen.getByLabelText("思维导图缩放比例")).toHaveTextContent("100%");
  expect(readLearningReadingState(first).map?.zoom).toBe(1.5);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
  fireEvent.click(screen.getByRole("button", { name: "放大思维导图" }));
  expect(() => fireEvent(window, new Event("pagehide"))).not.toThrow();
  expect(screen.getByLabelText("思维导图缩放比例")).toHaveTextContent("110%");
});
