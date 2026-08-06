import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QuestionAnswer } from "@/lib/domain/types";

import { CompanionQuestionDrawer } from "./companion-question-drawer";

const completedAnswer: QuestionAnswer = {
  id: "answer-1",
  uploadId: "upload-1",
  question: "Ta 提到了什么？",
  answer: "Ta 提到最近想看一部电影。",
  citedSegmentIds: ["segment-1"],
  citations: [
    {
      id: "E2",
      title: "电影计划",
      startSeconds: 65,
      endSeconds: 72,
      excerpt: "下次可以一起看那部电影。",
      sourceSegmentIds: ["segment-1"]
    }
  ],
  createdAt: "2026-08-04T08:00:00.000Z"
};

describe("CompanionQuestionDrawer", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  it("disables current-interaction QA until the interaction is ready", () => {
    const onAsk = vi.fn();
    render(
      <CompanionQuestionDrawer
        answers={[]}
        enabled={false}
        qaState={{ status: "idle" }}
        validSegmentIds={new Set()}
        onAsk={onAsk}
        onCancel={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "问问这次相处" }));

    expect(screen.getByRole("textbox", { name: "针对这次相处提问" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.queryByLabelText("猜你想问")).not.toBeInTheDocument();
    expect(onAsk).not.toHaveBeenCalled();
  });

  it("opens a left-side conversation panel and lets a suggested question use the real QA callback", () => {
    const onAsk = vi.fn(async () => undefined);
    render(
      <CompanionQuestionDrawer
        answers={[]}
        enabled
        qaState={{ status: "idle" }}
        validSegmentIds={new Set()}
        onAsk={onAsk}
        onCancel={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "问问这次相处" }));

    const dialog = screen.getByRole("dialog", { name: "问问 Daily Brief" });
    expect(dialog).toHaveAttribute("data-drawer-side", "left");
    expect(dialog).toHaveAttribute("data-panel-kind", "conversation");
    expect(screen.getByRole("heading", { name: "猜你想问" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /这次相处里明确聊到了什么/u }));
    const composer = screen.getByRole("textbox", { name: "针对这次相处提问" });
    expect(composer).toHaveValue("这次相处里明确聊到了什么？");
    expect(onAsk).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onAsk).toHaveBeenCalledWith("这次相处里明确聊到了什么？");
  });

  it("cancels a streaming question and closes the drawer on Escape", () => {
    const onCancel = vi.fn();
    render(
      <CompanionQuestionDrawer
        answers={[]}
        enabled
        qaState={{ status: "streaming", committedText: "正在整理" }}
        validSegmentIds={new Set()}
        onAsk={vi.fn()}
        onCancel={onCancel}
      />
    );

    const trigger = screen.getByRole("button", { name: "问问这次相处" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "问问 Daily Brief" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "问问 Daily Brief" })).not.toBeInTheDocument();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
  });

  it("renders a completed answer in history with a link to its valid transcript citation", () => {
    render(
      <CompanionQuestionDrawer
        answers={[completedAnswer]}
        enabled
        qaState={{ status: "complete" }}
        validSegmentIds={new Set(["segment-1"])}
        onAsk={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "问问这次相处" }));

    const questionTurn = screen.getByRole("article", { name: "你的问题" });
    expect(questionTurn).toHaveTextContent("你问");
    expect(questionTurn).toHaveTextContent(completedAnswer.question);
    expect(screen.getByText(completedAnswer.answer)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "猜你想问" })).toBeInTheDocument();
    const evidenceGroup = screen.getByText("回答证据").closest("details");
    expect(evidenceGroup).not.toHaveAttribute("open");
    expect(evidenceGroup).toHaveTextContent("1 条");
    const evidenceItem = screen.getByText("E2").closest("details");
    expect(evidenceItem).not.toHaveAttribute("open");
    fireEvent.click(evidenceGroup!.querySelector(":scope > summary")!);
    expect(evidenceGroup).toHaveAttribute("open");
    expect(evidenceItem).not.toHaveAttribute("open");
    expect(screen.getByText("来自这次相处 · 电影计划")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "在完整文字稿中查看", hidden: true })).toHaveAttribute(
      "href",
      "/date-companion/a/recap?segment=segment-1#full-transcript"
    );
  });

  it("renders the active question as a conversation turn while streaming and restores it after failure", () => {
    const props = {
      answers: [],
      enabled: true,
      validSegmentIds: new Set<string>(),
      onAsk: vi.fn(),
      onCancel: vi.fn()
    };
    const { rerender } = render(
      <CompanionQuestionDrawer
        {...props}
        qaState={{ status: "streaming", question: "Ta 这次最在意什么？", committedText: "Ta 提到了" }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "问问这次相处" }));
    expect(screen.getByRole("log", { name: "当前相处对话" })).toHaveTextContent("Ta 这次最在意什么？");
    expect(screen.getByLabelText("正在生成回答")).toHaveTextContent("Ta 提到了");

    rerender(
      <CompanionQuestionDrawer
        {...props}
        qaState={{ status: "failed", question: "Ta 这次最在意什么？", errorMessage: "回答服务暂时没有完成这次提问，请重新发送。" }}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("回答服务暂时没有完成这次提问");
    expect(screen.getByRole("textbox", { name: "针对这次相处提问" })).toHaveValue("Ta 这次最在意什么？");
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  it("does not present a citation as valid when any referenced segment is outside this interaction", () => {
    const mixedSourceAnswer: QuestionAnswer = {
      ...completedAnswer,
      citations: [
        {
          ...completedAnswer.citations![0],
          sourceSegmentIds: ["segment-1", "another-upload-segment"]
        }
      ]
    };

    render(
      <CompanionQuestionDrawer
        answers={[mixedSourceAnswer]}
        enabled
        qaState={{ status: "complete" }}
        segmentTextById={new Map([["segment-1", "下次可以一起看那部电影。"]])}
        validSegmentIds={new Set(["segment-1"])}
        onAsk={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "问问这次相处" }));

    expect(screen.queryByText("来自这次相处 · 电影计划")).not.toBeInTheDocument();
    expect(screen.getByText("回答证据").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("片段")).toBeInTheDocument();
    expect(screen.getByText("来自这次相处 · 文字片段")).toBeInTheDocument();
    expect(screen.queryByText(/^E\d+$/u)).not.toBeInTheDocument();
  });
});
