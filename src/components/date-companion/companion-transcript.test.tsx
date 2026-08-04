import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TranscriptLineVM } from "@/lib/domain/date-companion";

import { CompanionTranscript } from "./companion-transcript";

const scrollIntoView = vi.fn();

const lines: TranscriptLineVM[] = [
  {
    id: "segment-later",
    uploadId: "upload-1",
    startSeconds: 65,
    endSeconds: 72,
    speakerId: "speaker_b",
    text: "下次可以一起看那部电影。"
  },
  {
    id: "segment-earlier",
    uploadId: "upload-1",
    startSeconds: 5,
    endSeconds: 12,
    speakerId: "speaker_a",
    speakerLabel: "我",
    text: "我记得你喜欢手冲咖啡。"
  }
];

describe("CompanionTranscript", () => {
  beforeEach(() => {
    scrollIntoView.mockClear();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView
    });
  });

  it("sorts transcript lines by time and focuses the requested source segment", async () => {
    render(<CompanionTranscript highlightedSegmentId="segment-earlier" lines={lines} />);

    const renderedLines = screen.getAllByRole("listitem");
    expect(renderedLines[0]).toHaveAttribute("data-segment-id", "segment-earlier");
    expect(renderedLines[1]).toHaveAttribute("data-segment-id", "segment-later");

    const highlightedLine = document.getElementById("transcript-segment-earlier");
    expect(highlightedLine).toHaveAttribute("aria-current", "true");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" }));
    expect(highlightedLine).toHaveFocus();
  });

  it("searches only the loaded transcript and reports the filtered count", () => {
    render(<CompanionTranscript lines={lines} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索完整文字稿" }), {
      target: { value: "电影" }
    });

    expect(screen.getByText("下次可以一起看那部电影。")).toBeInTheDocument();
    expect(screen.queryByText("我记得你喜欢手冲咖啡。")).not.toBeInTheDocument();
    expect(screen.getByText("1 / 2 条")).toBeInTheDocument();
  });
});
