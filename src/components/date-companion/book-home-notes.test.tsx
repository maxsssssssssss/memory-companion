import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DateCompanionHomeContentPresentation, DateCompanionHomeContentState } from "@/lib/client/date-companion-proactive-value";
import type { SourceRefVM } from "@/lib/domain/date-companion";
import { CompanionHome, type CompanionHomeProps } from "./companion-home";
import { clearBookHomeReading } from "./book-home-reading-state";

function source(id: string, overrides: Partial<SourceRefVM> = {}): SourceRefVM {
  return {
    id, uploadId: "synthetic-recording", segmentIds: [id + "-segment"],
    recordingDate: "2026-11-04", startSeconds: 20, endSeconds: 24,
    speakerId: "synthetic-self", speakerLabel: "我", quote: "下次带上那张路线图。",
    kind: "transcript", presentation: "direct_quote", canOpenTranscript: true,
    ...overrides
  };
}

function content(overrides: Partial<DateCompanionHomeContentPresentation> = {}): DateCompanionHomeContentState {
  return { status: "ready", content: {
    fingerprint: "d".repeat(64), about: [], beforeMeeting: [], ...overrides
  } };
}

function props(homeContent: DateCompanionHomeContentState): CompanionHomeProps {
  return {
    currentInteraction: null, uploadState: { status: "idle" },
    onRetryRead: vi.fn(), onUpload: vi.fn(async () => true), onOpenSource: vi.fn(),
    homeContent, relationshipName: "阿岚",
    book: { lastSaved: null, href: (href) => href + (href.includes("?") ? "&" : "?") + "from=book-home" }
  };
}

describe("Book home meeting notes and person journal", () => {
  afterEach(() => { clearBookHomeReading(); vi.restoreAllMocks(); });

  it("keeps the two-item cap while putting an existing promise before a suggestion, without creating a completion control", () => {
    const follow = { kind: "follow_up" as const, text: "可以问问路线是否已经定下。", reason: "上次还没有决定走哪一段。", evidenceIds: ["follow"], sources: [source("follow")] };
    const promise = { kind: "open_promise" as const, text: "我答应下次带上路线图。", reason: "这项约定仍然待办。", promiseId: "promise-1", evidenceIds: ["promise"], sources: [source("promise")] };
    const about = { kind: "recent_update" as const, text: "阿岚最近在准备徒步。", evidenceIds: ["about"], sources: [source("about")] };
    const state = content({
      beforeMeeting: [follow, promise, { ...follow, text: "不应扩展展示的第三条建议。", evidenceIds: ["third"], sources: [source("third")] }],
      about: [about, { ...about, kind: "shared_moment", text: "一起标了两处可休息的屋檐。", evidenceIds: ["shared"], sources: [source("shared")] }, { ...about, text: "不应扩展展示的第三条近况。", evidenceIds: ["third-about"], sources: [source("third-about")] }]
    });
    const snapshot = JSON.stringify(state);
    render(<CompanionHome {...props(state)} />);
    const meeting = screen.getByRole("region", { name: "下次见面前" });
    const journal = screen.getByRole("region", { name: "人物近况" });
    const notes = within(meeting).getAllByRole("article");
    expect(notes).toHaveLength(2);
    expect(notes[0]).toHaveTextContent("你答应过");
    expect(notes[0]).toHaveTextContent("我答应下次带上路线图。");
    expect(notes[0]).toHaveTextContent("仍待办");
    expect(notes[1]).toHaveTextContent("可以问问路线是否已经定下。");
    expect(within(journal).getAllByRole("article")).toHaveLength(2);
    expect(screen.queryByText(/不应扩展展示/)).not.toBeInTheDocument();
    expect(within(meeting).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(meeting).queryByRole("button", { name: /完成|已完成/ })).not.toBeInTheDocument();
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it("keeps each direct quote attached to its own speaker, time and original source target", () => {
    const first = source("line-self", { quote: "我们可以先走河边。", startSeconds: 30 });
    const second = source("line-ta", { quote: "好，不过我周六还不确定能不能出门。", speakerId: "synthetic-ta", speakerLabel: "阿岚", startSeconds: 41, endSeconds: 45 });
    const config = props(content({ about: [{ kind: "shared_moment", text: "聊过河边散步，周六仍未确定。", evidenceIds: [first.id, second.id], sources: [first, second] }] }));
    render(<CompanionHome {...config} />);
    const journal = screen.getByRole("region", { name: "人物近况" });
    fireEvent.click(within(journal).getByText("查看原话"));
    const figures = within(journal).getAllByRole("figure");
    expect(figures).toHaveLength(2);
    expect(figures[0].querySelector("blockquote")).toHaveTextContent("“我们可以先走河边。”");
    expect(figures[0]).toHaveTextContent("我 · 0:30");
    expect(figures[0]).not.toHaveTextContent("阿岚");
    expect(figures[1].querySelector("blockquote")).toHaveTextContent("“好，不过我周六还不确定能不能出门。”");
    expect(figures[1]).toHaveTextContent("阿岚 · 0:41");
    expect(within(figures[0]).getByText("原话片段")).toBeInTheDocument();
    fireEvent.click(within(figures[1]).getByRole("button", { name: "在完整文字稿中查看" }));
    expect(config.onOpenSource).toHaveBeenCalledWith(second, "line-ta-segment");
    expect(journal.querySelector("details")).toHaveAttribute("open");
    expect(within(journal).getByText("聊过河边散步，周六仍未确定。").closest("blockquote")).toBeNull();
  });

  it("does not promote a saved summary or suggestion into a speaker's verbatim words", () => {
    const derived = source("summary", { presentation: "derived_summary", quote: "整理所得：月底是否出行还没有决定。" });
    const suggestion = source("suggestion", { presentation: "suggestion", quote: "建议先问问月底是否方便。", speakerLabel: "阿岚" });
    render(<CompanionHome {...props(content({ beforeMeeting: [{ kind: "follow_up", text: "可以继续聊月底的安排。", reason: "是否出行尚未决定。", evidenceIds: [derived.id, suggestion.id], sources: [derived, suggestion] }] }))} />);
    const meeting = screen.getByRole("region", { name: "下次见面前" });
    fireEvent.click(within(meeting).getByText("查看依据"));
    const figures = within(meeting).getAllByRole("figure");
    expect(figures[0].querySelector("blockquote")).toBeNull();
    expect(figures[1].querySelector("blockquote")).toBeNull();
    expect(within(figures[0]).getByText("根据原话整理")).toBeInTheDocument();
    expect(within(figures[1]).getByText("根据原话整理的建议")).toBeInTheDocument();
    expect(within(figures[0]).getByText(derived.quote).tagName).toBe("P");
    expect(within(figures[1]).getByText(suggestion.quote).tagName).toBe("P");
    expect(figures[0]).not.toHaveTextContent("我 ·");
    expect(figures[1]).not.toHaveTextContent("阿岚 ·");
    expect(within(meeting).getByText("是否出行尚未决定。")).toBeInTheDocument();
  });

  it("retains the exact saved fragment and an unknown speaker when full transcript access is unavailable", () => {
    const saved = source("fragment", { quote: "并不是不想去，只是时间还没确定。", speakerLabel: undefined, canOpenTranscript: false });
    render(<CompanionHome {...props(content({ about: [{ kind: "recent_update", text: "行程还没有确定。", evidenceIds: [saved.id], sources: [saved] }] }))} />);
    const journal = screen.getByRole("region", { name: "人物近况" });
    fireEvent.click(within(journal).getByText("查看原话"));
    const figure = within(journal).getByRole("figure");
    expect(figure.querySelector("blockquote")).toHaveTextContent("“并不是不想去，只是时间还没确定。”");
    expect(figure).toHaveTextContent("说话人待核对 · 0:20");
    expect(within(figure).getByText("已保留来源片段")).toBeInTheDocument();
    expect(within(figure).queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps the footer destinations and relationship name while separating pending, empty, loading and failed material", () => {
    const config = props({ status: "empty" });
    config.relationshipName = "林知遥与海边书店的朋友";
    config.book!.onRetryContent = vi.fn();
    const { rerender } = render(<CompanionHome {...config} />);
    expect(screen.getByText("暂时没有可展示的见面准备。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "关于林知遥与海边书店的朋友" })).toHaveAttribute("href", "/date-companion/a/person?from=book-home");
    expect(screen.getByRole("link", { name: "回看准备卡" })).toHaveAttribute("href", "/date-companion/a/prepare?section=records&from=book-home");
    rerender(<CompanionHome {...config} homeContent={{ status: "loading" }} />);
    expect(screen.getByText("正在读取人物近况与见面准备…")).toHaveAttribute("role", "status");
    expect(within(screen.getByRole("region", { name: "上次留下的内容" })).getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByText("暂时没有可展示的见面准备。")).not.toBeInTheDocument();
    rerender(<CompanionHome {...config} participantNotice="人物身份需要先核对。" participantReviewHref="/date-companion/a/people?from=book-home#people-mapping-title" />);
    expect(screen.getAllByText("人物身份需要先核对。")).toHaveLength(1);
    expect(screen.queryByText("暂时没有可展示的人物近况。")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "核对人物身份" })).toHaveAttribute("href", "/date-companion/a/people?from=book-home#people-mapping-title");
    rerender(<CompanionHome {...config} homeContent={{ status: "unavailable" }} />);
    expect(screen.getAllByText("人物近况与见面准备暂时未能读取。")).toHaveLength(1);
    expect(screen.queryByText("暂时没有可展示的人物近况。")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新读取相关内容" }));
    expect(config.book!.onRetryContent).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "回看准备卡" })).toBeInTheDocument();
  });
});
