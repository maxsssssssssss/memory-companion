import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DateCompanionProactiveValuePresentation } from "@/lib/client/date-companion-proactive-value";

import { CompanionProactiveObservation } from "./companion-proactive-observation";

function presentation(): DateCompanionProactiveValuePresentation {
  return {
    fingerprint: "a".repeat(64),
    status: "fallback",
    observation: "Ta 这次更在意你有没有先听完。",
    caution: "这只是一次相处中的线索，可以继续听 Ta 自己怎么说。",
    suggestedQuestions: ["Ta 之前还提到过类似感受吗？"],
    sources: [{
      id: "evidence_1",
      uploadId: "upload_1",
      segmentIds: ["segment_1"],
      recordingDate: "2026-08-18",
      startSeconds: 61,
      endSeconds: 68,
      quote: "我希望你先听我说完。",
      kind: "transcript",
      presentation: "direct_quote",
      canOpenTranscript: true
    }]
  };
}

describe("CompanionProactiveObservation", () => {
  it("renders one gentle observation with canonical raw text and no internal scoring fields", () => {
    const onOpenSource = vi.fn();
    render(<CompanionProactiveObservation presentation={presentation()} onOpenSource={onOpenSource} />);

    expect(screen.getAllByText("Ta 这次更在意你有没有先听完。")).toHaveLength(1);
    expect(screen.getByText("这只是一次相处中的线索，可以继续听 Ta 自己怎么说。")).toBeInTheDocument();
    expect(screen.queryByText(/confidence|reason|模型|Provider/u)).not.toBeInTheDocument();
    expect(screen.getByText("“我希望你先听我说完。”")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "在完整文字稿中查看" }));
    expect(onOpenSource).toHaveBeenCalledWith(expect.objectContaining({ id: "evidence_1" }), "segment_1");
  });

  it("keeps an inaccurate action local and does not mutate source data", () => {
    const original = presentation();
    render(<CompanionProactiveObservation presentation={original} />);

    fireEvent.click(screen.getByRole("button", { name: "这条不准确" }));

    expect(screen.getByRole("status")).toHaveTextContent("本次浏览中收起");
    expect(screen.queryByText(original.observation)).not.toBeInTheDocument();
    expect(original.sources[0].quote).toBe("我希望你先听我说完。");
    fireEvent.click(screen.getByRole("button", { name: "重新显示" }));
    expect(screen.getByText(original.observation)).toBeInTheDocument();
  });

  it("never creates a transcript action for a snapshot-only source", () => {
    const value = presentation();
    value.sources[0] = { ...value.sources[0], canOpenTranscript: false };
    render(<CompanionProactiveObservation presentation={value} />);

    expect(screen.getByText("已保留可核对原话")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "在完整文字稿中查看" })).not.toBeInTheDocument();
  });
});
