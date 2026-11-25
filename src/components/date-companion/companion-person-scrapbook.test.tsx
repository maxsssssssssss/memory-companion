import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { emptyDateCompanionViewModel, type DateCompanionMemoryBridgeState } from "@/lib/domain/date-companion";
import type { DateCompanionSessionValue } from "@/lib/client/date-companion-session";
import { CompanionPersonScrapbook } from "./companion-person-scrapbook";

let search = "view=book";
vi.mock("next/navigation", () => ({ usePathname: () => "/date-companion/a/people/person", useSearchParams: () => new URLSearchParams(search) }));
vi.mock("./person-book-navigation", () => ({ usePersonBookNavigation: () => ({ sourceId: null, fullId: null, openSource: vi.fn(), rememberMeeting: vi.fn() }) }));
const date = "2026-11-01T12:00:00.000Z";
const person = (id: string) => ({ id, displayName: id, status: "confirmed" as const, explicitlyConfirmed: true as const, version: 1, confirmedAt: date, createdAt: date, updatedAt: date });
const mapping = { id: "mapping", selfPersonId: "self", companionPersonId: "person", status: "confirmed" as const,
  relationshipType: "friend" as const, version: 1, confirmedAt: date, createdAt: date, updatedAt: date };
const setting = { enabled: false, version: 1, enabledAt: null, disabledAt: date, createdAt: date, updatedAt: date };
const bridge: DateCompanionMemoryBridgeState = { status: "ready", mapping, people: [person("self"), person("person")], setting,
  selfBinding: { personId: "self", status: "active", version: 1, setAt: date, clearedAt: null, updatedAt: date },
  review: { mapping, retention: setting, interactions: [] }, retainedSubjects: {}, memoryRetainedSourceKeys: [], relationshipPersonSources: [], personQaSources: [] };

function props(pending: boolean): ComponentProps<typeof CompanionPersonScrapbook> {
  const vm = emptyDateCompanionViewModel();
  vm.relationship = { id: "relationship", status: "active", participantState: "confirmed" };
  vm.recap.history = [{ id: "upload", relationshipInteractionId: "meeting", sourceUploadId: "upload", uploadIds: ["upload"],
    persistenceStatus: "confirmed", sourceState: "available", recordingDate: "2026-11-01", fileName: "散步.m4a", title: "一起散步", status: "ready", transcript: [], detailLoaded: !pending,
    savedExcerpt: pending ? null : "很长的已保存摘要。".repeat(12) }];
  if (!pending) vm.person.remembered = [{ id: "remembered", interactionId: "meeting", kind: "mentioned", title: "提到", proposedText: "正在做画册", displayedText: "正在做画册", disposition: "kept", sources: [{
    id: "source", uploadId: "upload", segmentIds: ["segment"], quote: "正在做画册", recordingDate: "2026-11-01", startSeconds: 1, endSeconds: 2, kind: "relationship", presentation: "direct_quote" }], version: 1, sortOrder: 0 }];
  const session = { memoryBridgeState: bridge, viewModel: vm, relationshipDetailsLoaded: !pending,
    detailReadState: { status: pending ? "loading" : "ready" }, mutationState: { status: "idle" }, searchState: { status: "idle" } } as unknown as DateCompanionSessionValue;
  return { screen: "person", accountId: "account", relationshipId: "relationship", personId: "person", session,
    archiveState: pending ? { status: "loading" } : { status: "ready", archive: { person: person("person"), entries: [] } },
    onRetryArchive: vi.fn(), directoryHref: "/people", personHref: id => "/people/" + id, managementHref: () => "/manage", meetingHref: () => "/recap" };
}

describe("person scrapbook progressive reading", () => {
  beforeEach(() => {
    search = "view=book";
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }) });
  });

  it("lists confirmed people without self and links only the current person to the latest available meeting", () => {
    const directory = props(false);
    const latest = directory.session.viewModel.recap.history[0];
    directory.session.viewModel.recap.history = [latest,
      {...latest, id:"deleted", relationshipInteractionId:"deleted", recordingDate:"2026-11-02", sourceState:"explicitly_deleted"},
      {...latest, id:"draft", relationshipInteractionId:"draft", recordingDate:"2026-11-03", persistenceStatus:"draft"}];
    directory.session.memoryBridgeState = {...bridge, people:[...bridge.people, person("林澄")]};
    render(<CompanionPersonScrapbook {...directory} screen="people" />);
    expect(screen.getByRole("heading", {name:"全部人物"})).toBeVisible();
    expect(screen.queryByRole("link", {name:/self/u})).not.toBeInTheDocument();
    const current = screen.getByRole("link", {name:/person.*当前 Ta/u});
    expect(current).toHaveAttribute("href", "/people/person");
    expect(current).toHaveTextContent(/2026.11.01/u);
    expect(current).not.toHaveTextContent(/2026.11.02|2026.11.03/u);
    expect(screen.getByRole("link", {name:/林澄/u})).toHaveAttribute("href", "/people/林澄");
    expect(screen.queryByText(/关系评分|亲密度|匹配度/u)).not.toBeInTheDocument();
  });

  it("filters confirmed names and explains an empty directory search", () => {
    const directory = props(false);
    directory.session.memoryBridgeState = {...bridge, people:[...bridge.people, person("周岚")]};
    search = "q=周";
    const {rerender} = render(<CompanionPersonScrapbook {...directory} screen="people" />);
    expect(screen.getByRole("link", {name:/周岚/u})).toBeVisible();
    expect(screen.queryByRole("link", {name:/person/u})).not.toBeInTheDocument();
    search = "q=不存在";
    rerender(<CompanionPersonScrapbook {...directory} screen="people" />);
    expect(screen.getByRole("heading", {name:"没有找到这位人物"})).toBeVisible();
    expect(screen.getByRole("button", {name:"清除搜索"})).toBeVisible();
  });
  it("keeps a known meeting immediately usable without showing a paper group that will move", () => {
    const { container } = render(<CompanionPersonScrapbook {...props(true)} />);
    expect(screen.getByRole("link", { name: /翻开这次复盘/ })).toBeInTheDocument();
    expect(container.querySelector(".scrap-lead-space")).toBeInTheDocument();
    expect(container.querySelector(".scrap-meeting")).toContainElement(screen.getByRole("link", { name: /翻开这次复盘/ }));
    expect(screen.queryByRole("link", { name: /全部经历/ })).not.toBeInTheDocument();
  });
  it("does not remove the focused loading entry when arbitrary-length material arrives", () => {
    const { container, rerender } = render(<CompanionPersonScrapbook {...props(true)} />);
    const entry = screen.getByRole("link", { name: /翻开这次复盘/ });
    act(() => entry.focus());
    rerender(<CompanionPersonScrapbook {...props(false)} />);
    expect(entry).toHaveFocus();expect(entry).toBeInTheDocument();
    expect(container.querySelector(".scrap-meeting")).toContainElement(entry);
    expect(container.querySelector(".scrap-lead-space")).toBeNull();
    expect(container.querySelector(".scrap-meeting")).not.toBeNull();
    expect(screen.getByText("很长的已保存摘要。".repeat(12))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /全部经历/ })).toBeInTheDocument();
  });
  it("keeps an existing paper group available during a background recheck", () => {
    const ready = props(false);
    const { container, rerender } = render(<CompanionPersonScrapbook {...ready} />);
    rerender(<CompanionPersonScrapbook {...ready} archiveState={{ status: "loading" }} />);
    expect(container.querySelector(".scrap-reading")).toBeNull();
    expect(container.querySelector(".scrap-meeting")).not.toBeNull();
    expect(screen.getByText("正在做画册")).toBeInTheDocument();
  });

  it("distinguishes unknown and failed reads from a confirmed empty book", () => {
    const base = props(true);
    base.session.detailReadState = { status: "idle" };
    const { rerender } = render(<CompanionPersonScrapbook {...base} archiveState={{ status: "idle" }} />);
    expect(screen.getByText("正在读取人物材料…")).toBeInTheDocument();
    expect(screen.queryByText("这里还没有可翻看的内容")).not.toBeInTheDocument();
    rerender(<CompanionPersonScrapbook {...base} session={{ ...base.session, detailReadState: { status: "error", message: "相处材料读取失败。" } }}
      archiveState={{ status: "error", message: "档案读取失败。" }} />);
    expect(screen.getByText("相处材料读取失败。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /翻开这次复盘/ })).toBeInTheDocument();
    expect(screen.queryByText("这里还没有可翻看的内容")).not.toBeInTheDocument();
    const empty = props(false);
    empty.session.viewModel.recap.history = [];
    empty.session.viewModel.person.remembered = [];
    rerender(<CompanionPersonScrapbook {...empty} accountId="different-account" />);
    expect(screen.getByText("这里还没有可翻看的内容")).toBeInTheDocument();
  });

  it("does not treat one failure as completion of the other independent read", () => {
    const pending = props(true);
    pending.session.detailReadState = { status: "error", message: "相处材料读取失败。" };
    const { container } = render(<CompanionPersonScrapbook {...pending} />);
    expect(container.querySelector(".scrap-lead-space")).not.toBeNull();
    expect(screen.getByText("正在读取人物档案…")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /翻开这次复盘/ })).toBeInTheDocument();
  });

  it("keeps retry focus and read paper positions while recovered material becomes available in history", () => {
    const partial = props(true);
    partial.session.detailReadState = { status: "error", message: "相处材料读取失败。" };
    partial.session.ensureRelationshipDetailsLoaded = vi.fn(async () => {});
    partial.archiveState = { status: "ready", archive: { person: person("person"), entries: [{ id: "archive", type: "event", status: "active",
      title: "已读档案", summary: "已读档案", date, updatedAt: date, sourceStatement: "直接交流", sourceOrigin: "direct_conversation", shared: false,
      sources: [{ id: "archive-source", uploadId: "upload", sourceSegmentId: "segment", quote: "已读档案", date }] }] } };
    const { container, rerender } = render(<CompanionPersonScrapbook {...partial} />);
    const retry = screen.getByRole("button", { name: "重新读取相处材料" });
    act(() => retry.focus());fireEvent.click(retry);
    expect(partial.session.ensureRelationshipDetailsLoaded).toHaveBeenCalledWith({ timeoutMs: 12000 });
    const source = screen.getByRole("button", { name: /查看原话/ });
    rerender(<CompanionPersonScrapbook {...partial} session={{ ...partial.session, detailReadState: { status: "loading" } }} />);
    expect(retry).not.toBeInTheDocument();
    const progress = screen.getByText("正在重新读取相处材料…");
    expect(progress).toHaveFocus();
    const ready = { ...props(false), archiveState: partial.archiveState };
    rerender(<CompanionPersonScrapbook {...ready} />);
    expect(progress).toHaveFocus();expect(progress).toHaveTextContent("相处材料已读好。");
    expect(screen.queryByRole("button", { name: /重新读取/ })).not.toBeInTheDocument();expect(source).toBeInTheDocument();
    expect(container.querySelector(".scrap-lead")).toHaveTextContent("已读档案");
    expect(container.querySelector(".scrap-meeting")).not.toHaveTextContent("很长的已保存摘要");
    expect(screen.getByRole("link", { name: /在全部经历查看/ })).toBeInTheDocument();
    search = "view=book&section=archive";
    rerender(<CompanionPersonScrapbook {...ready} />);
    expect(screen.getByText("正在做画册")).toBeInTheDocument();
    expect(screen.getByText("很长的已保存摘要。".repeat(12))).toBeInTheDocument();
  });

  it("keeps the reader's new focus when a retried section finishes", () => {
    const ready = props(false);
    const { rerender } = render(<CompanionPersonScrapbook {...ready} archiveState={{ status: "error", message: "档案读取失败。" }} />);
    const retry = screen.getByRole("button", { name: "重新读取人物档案" });
    act(() => retry.focus());
    fireEvent.click(retry);
    rerender(<CompanionPersonScrapbook {...ready} archiveState={{ status: "loading" }} />);
    const meeting = screen.getByRole("link", { name: /翻开这次复盘/ });
    act(() => meeting.focus());
    rerender(<CompanionPersonScrapbook {...ready} />);
    expect(meeting).toHaveFocus();
    expect(screen.getByText("人物档案已读好。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /重新读取/ })).not.toBeInTheDocument();
  });

  it("does not retain invalidated sources or current-person access in the held composition", () => {
    const partial = props(false);
    partial.archiveState = { status: "error", message: "档案读取失败。" };
    const { rerender } = render(<CompanionPersonScrapbook {...partial} />);
    expect(screen.getByText("正在做画册")).toBeInTheDocument();
    const noAccess = { ...partial.session, memoryBridgeState: { ...bridge, mapping: null } };
    rerender(<CompanionPersonScrapbook {...partial} session={noAccess} />);
    expect(screen.queryByText("正在做画册")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /翻开这次复盘/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "person" })).toBeInTheDocument();
  });

  it("removes or updates an already displayed excerpt when authoritative content changes", () => {
    const partial = props(false);
    partial.archiveState = { status: "error", message: "档案读取失败。" };
    const { container, rerender } = render(<CompanionPersonScrapbook {...partial} />);
    expect(container.querySelector(".scrap-meeting")).toHaveTextContent("很长的已保存摘要");
    const latest = (savedExcerpt: string | null) => ({ ...partial.session, viewModel: { ...partial.session.viewModel,
      recap: { ...partial.session.viewModel.recap, history: partial.session.viewModel.recap.history.map(meeting => ({ ...meeting, savedExcerpt })) } } });
    rerender(<CompanionPersonScrapbook {...partial} session={latest(null)} />);
    expect(container.querySelector(".scrap-meeting")).not.toHaveTextContent("很长的已保存摘要");
    expect(screen.getByRole("link", { name: /翻开这次复盘/ })).toBeInTheDocument();
    rerender(<CompanionPersonScrapbook {...partial} session={latest("已经核对更新的摘要。")} />);
    expect(container.querySelector(".scrap-meeting")).toHaveTextContent("已经核对更新的摘要。");
  });

  it("filters three consecutive round trips without replacing controls or replaying a current choice", () => {
    search = "view=book&section=archive";
    window.history.replaceState(null, "", "/?" + search);
    const ready = props(false);
    const { container, rerender } = render(<CompanionPersonScrapbook {...ready} />);
    const all = screen.getByRole("button", { name: "全部" });
    const meeting = screen.getByRole("button", { name: "历次见面" });
    const replace = vi.spyOn(window.history, "replaceState");
    fireEvent.click(all, { detail: 1 });
    expect(replace).not.toHaveBeenCalled();
    for (let round = 0; round < 3; round++) {
      fireEvent.click(meeting, { detail: 1 });
      search = window.location.search.slice(1);
      rerender(<CompanionPersonScrapbook {...ready} />);
      expect(meeting).toHaveAttribute("aria-pressed", "true");
      expect(container.querySelectorAll(".pa-timeline > li")).toHaveLength(1);
      expect(screen.queryByText("正在做画册")).not.toBeInTheDocument();
      fireEvent.click(all, { detail: 1 });
      search = window.location.search.slice(1);
      rerender(<CompanionPersonScrapbook {...ready} />);
      expect(all).toHaveAttribute("aria-pressed", "true");
      expect(container.querySelectorAll(".pa-timeline > li")).toHaveLength(2);
      expect(screen.getByRole("button", { name: "历次见面" })).toBe(meeting);
    }
    expect(replace).toHaveBeenCalledTimes(6);
    replace.mockRestore();
  });

  it("keeps the current search and control focus when a keyboard choice is followed by a pointer choice", () => {
    search = "view=book&section=archive&q=画册";
    window.history.replaceState(null, "", "/?" + search);
    const ready = props(false);
    const { rerender } = render(<CompanionPersonScrapbook {...ready} />);
    const recent = screen.getByRole("button", { name: "最近提到" });
    act(() => recent.focus());
    fireEvent.click(recent, { detail: 0 });
    search = window.location.search.slice(1);
    rerender(<CompanionPersonScrapbook {...ready} />);
    expect(recent).toHaveFocus();
    expect(recent).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("searchbox")).toHaveValue("画册");
    fireEvent.click(screen.getByRole("button", { name: "全部" }), { detail: 1 });
    search = window.location.search.slice(1);
    rerender(<CompanionPersonScrapbook {...ready} />);
    expect(screen.getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("searchbox")).toHaveValue("画册");
    expect(screen.getByText("正在做画册")).toBeInTheDocument();
  });

  it("applies externally restored filters without changing the URL or refreshing material", () => {
    search = "view=book&section=archive";
    const ready = props(false);
    const { rerender } = render(<CompanionPersonScrapbook {...ready} />);
    const replace = vi.spyOn(window.history, "replaceState");
    search = "view=book&section=archive&filter=meeting";
    rerender(<CompanionPersonScrapbook {...ready} />);
    expect(screen.getByRole("button", { name: "历次见面" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("正在做画册")).not.toBeInTheDocument();
    rerender(<CompanionPersonScrapbook {...ready} />);
    expect(replace).not.toHaveBeenCalled();
    replace.mockRestore();
  });

  it("keeps a selected readable meeting and search while an independent archive reread fails", () => {
    search = "view=book&section=archive&filter=meeting&q=散步";
    const ready = props(false);
    const { rerender } = render(<CompanionPersonScrapbook {...ready} />);
    const meeting = screen.getByRole("button", { name: "历次见面" });
    const recap = screen.getByRole("link", { name: /翻开这次复盘/ });
    act(() => meeting.focus());
    for (const archiveState of [{ status: "loading" as const }, { status: "error" as const, message: "档案暂未读好。" }]) {
      rerender(<CompanionPersonScrapbook {...ready} archiveState={archiveState} />);
      expect(meeting).toHaveFocus();
      expect(meeting).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("searchbox")).toHaveValue("散步");
      expect(screen.getByRole("link", { name: /翻开这次复盘/ })).toBe(recap);
    }
  });

  it("keeps one focused search control through failure, retry and completion without exposing transport errors", () => {
    search = "view=book&section=archive&q=画册";
    const base = props(false);
    const searchRelationship = vi.fn(async () => {});
    const withSearch = (state: DateCompanionSessionValue["searchState"]) => ({ ...base,
      session: { ...base.session, searchState: state, searchRelationship } });
    const { container, rerender } = render(<CompanionPersonScrapbook {...withSearch({ status: "error", query: "画册", message: "Failed to fetch" })} />);
    const button = screen.getByRole("button", { name: "重试检索" });
    const status = container.querySelector("#person-history-search-status")!;
    expect(status).toHaveTextContent("关系材料检索未完成。");
    expect(screen.getByRole("heading", { name: /全部 · 已读匹配/ })).toBeInTheDocument();
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
    act(() => button.focus());fireEvent.click(button);
    expect(searchRelationship).toHaveBeenCalledWith("画册");
    rerender(<CompanionPersonScrapbook {...withSearch({ status: "loading", query: "画册" })} />);
    expect(button).toHaveFocus();expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();fireEvent.click(button);
    expect(searchRelationship).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("searchbox")).toHaveValue("画册");
    expect(screen.getByText("正在做画册")).toBeInTheDocument();
    rerender(<CompanionPersonScrapbook {...withSearch({ status: "ready", query: "画册", results: [] })} />);
    expect(button).toHaveFocus();expect(button).toHaveAttribute("aria-disabled", "false");
    expect(screen.getByRole("button", { name: "检索关系材料" })).toBe(button);
    expect(status).toHaveTextContent("关系材料匹配 0 条");
  });

  it("does not present another query's results or errors as the current query's search", () => {
    search = "view=book&section=archive&q=散步";
    const base = props(false);
    const { container, rerender } = render(<CompanionPersonScrapbook {...base} session={{ ...base.session,
      searchState: { status: "error", query: "画册", message: "这段记录不存在，或已经无法访问。" } }} />);
    const status = container.querySelector("#person-history-search-status")!;
    expect(screen.getByRole("heading", { name: "全部 · 已读匹配 1 条" })).toBeInTheDocument();
    expect(status).not.toHaveTextContent("检索未完成");
    expect(container.querySelectorAll(".pa-timeline > li")).toHaveLength(1);
    expect(screen.queryByText("正在做画册")).not.toBeInTheDocument();
    rerender(<CompanionPersonScrapbook {...base} session={{ ...base.session,
      searchState: { status: "ready", query: "画册", results: [] } }} />);
    expect(status).not.toHaveTextContent("检索已完成");
    expect(status).toHaveTextContent(/^$/);
  });

  it("keeps meaningful Chinese search errors intact and retains the stable control when the query is cleared", () => {
    search = "view=book&section=archive&q=画册";
    const base = props(false);
    const message = "这段记录已被更新，请核对当前查询和人物材料后重试。".repeat(12);
    const searchRelationship = vi.fn(async () => {});
    const session = { ...base.session, searchRelationship, searchState: { status: "error" as const, query: "画册", message } };
    const { container, rerender } = render(<CompanionPersonScrapbook {...base} session={session} />);
    expect(container.querySelector("#person-history-search-status")).toHaveTextContent(message);
    const button = screen.getByRole("button", { name: "重试检索" });
    search = "view=book&section=archive";
    rerender(<CompanionPersonScrapbook {...base} session={session} />);
    expect(screen.getByRole("button", { name: "检索关系材料" })).toBe(button);
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);expect(searchRelationship).not.toHaveBeenCalled();
    expect(screen.getByRole("searchbox", { name: "筛选已读经历" })).toHaveAttribute("placeholder", "关键词或日期");
    expect(container.querySelector("#person-history-search-status")).not.toHaveTextContent(message);
    expect(container.querySelectorAll(".pa-timeline > li")).toHaveLength(2);
  });
});
