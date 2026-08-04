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
      id: "citation-1",
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
    expect(screen.queryByLabelText("提问建议")).not.toBeInTheDocument();
    expect(onAsk).not.toHaveBeenCalled();
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

    expect(screen.getByText(completedAnswer.question)).toBeInTheDocument();
    expect(screen.getByText(completedAnswer.answer)).toBeInTheDocument();
    expect(screen.getByText("来自这次相处 · 电影计划")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "在完整文字稿中查看" })).toHaveAttribute(
      "href",
      "/date-companion/a/recap?segment=segment-1#full-transcript"
    );
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
    expect(screen.getByText("来自这次相处 · 文字片段")).toBeInTheDocument();
  });
});
