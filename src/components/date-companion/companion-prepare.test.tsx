import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PromiseVM, RecapItemVM } from "@/lib/domain/date-companion";

import { CompanionPrepare } from "./companion-prepare";

const source = {
  id: "source-1",
  uploadId: "upload-1",
  segmentIds: ["segment-1"],
  recordingDate: "2026-08-03",
  startSeconds: 12,
  endSeconds: 16,
  quote: "下次我把书带给你。",
  kind: "transcript" as const,
  presentation: "direct_quote" as const
};

const kept: RecapItemVM = {
  id: "mentioned-1",
  kind: "mentioned",
  title: "Ta 最近",
  proposedText: "Ta 最近在准备考试",
  displayedText: "Ta 最近在准备考试",
  disposition: "kept",
  sources: [source]
};

const openPromise: PromiseVM = {
  id: "promise-open",
  relationshipId: "relationship-1",
  originatingRecapItemId: "recap-1",
  text: "下次把书带给 Ta",
  status: "open",
  version: 1,
  sources: [source]
};

describe("CompanionPrepare", () => {
  it("uses only kept items and open promises", () => {
    const { container } = render(
      <CompanionPrepare
        items={[kept, { ...kept, id: "excluded", displayedText: "不该出现", disposition: "excluded" }]}
        openPromises={[openPromise, { ...openPromise, id: "promise-done", text: "已经做完", status: "done" }]}
        relationshipName="小林"
      />
    );

    expect(screen.getByRole("heading", { name: "见 小林 之前，花半分钟想一想" })).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("date-companion-prepare-page");
    expect(container.querySelector(".date-companion-prepare-header")).toBeInTheDocument();
    expect(container.querySelector(".date-companion-prepare-letter-stack")).toBeInTheDocument();
    expect(container.querySelector(".date-companion-prepare-boundary")).not.toBeInTheDocument();
    expect(screen.queryByText(/被排除、尚未确认/u)).not.toBeInTheDocument();
    expect(screen.getByText("不用准备很多。见面时，认真听 小林 说话就好。")).toBeInTheDocument();
    expect(screen.getByText("Ta 最近在准备考试")).toBeInTheDocument();
    expect(screen.queryByText("不该出现")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("你答应过"));
    expect(screen.getByText("下次把书带给 Ta")).toBeInTheDocument();
    expect(screen.queryByText("已经做完")).not.toBeInTheDocument();
  });

  it("offers two real navigation paths without inventing a readiness action", () => {
    render(<CompanionPrepare items={[]} openPromises={[]} />);

    expect(screen.getByRole("link", { name: "查看最近一次相处" })).toHaveAttribute("href", "/date-companion/a/recap");
    expect(screen.getByRole("link", { name: "回到关于 Ta" })).toHaveAttribute("href", "/date-companion/a/person");
    expect(screen.queryByText("我准备好了")).not.toBeInTheDocument();
    expect(screen.queryByText(/周六|河边|18:30/)).not.toBeInTheDocument();
  });

  it("deep-links the latest confirmed interaction when only server evidence is available", () => {
    render(
      <CompanionPrepare
        items={[]}
        latestInteractionId="interaction-history"
        openPromises={[]}
      />
    );

    expect(screen.getByRole("link", { name: "查看最近一次相处" })).toHaveAttribute(
      "href",
      "/date-companion/a/recap?interaction=interaction-history"
    );
  });

  it("does not create a dead transcript action when only a saved evidence quote exists", () => {
    render(<CompanionPrepare items={[kept]} openPromises={[]} />);

    fireEvent.click(screen.getByText("展开"));
    expect(screen.getByText("已保留可核对原话")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "在完整文字稿中查看" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "在完整文字稿中查看" })).not.toBeInTheDocument();
  });

  it("delegates a local full-transcript source without changing long-term evidence", () => {
    const onOpenSource = vi.fn();
    const localSource = { ...source, canOpenTranscript: true };
    render(<CompanionPrepare items={[{ ...kept, sources: [localSource] }]} onOpenSource={onOpenSource} />);

    fireEvent.click(screen.getByText("展开"));
    fireEvent.click(screen.getByRole("button", { name: "在完整文字稿中查看" }));
    expect(onOpenSource).toHaveBeenCalledWith(localSource, "segment-1");
  });
});
