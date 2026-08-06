import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RecapItemVM } from "@/lib/domain/date-companion";

import { CompanionHome, type CompanionUploadPresentation } from "./companion-home";

const recentItem: RecapItemVM = {
  id: "recent-1",
  kind: "mentioned",
  title: "Ta 最近",
  proposedText: "Ta 最近在准备一场重要考试",
  displayedText: "Ta 最近在准备一场重要考试",
  disposition: "kept",
  sources: [{
    id: "source-1",
    uploadId: "upload-1",
    segmentIds: ["segment-1"],
    recordingDate: "2026-08-04",
    startSeconds: 12,
    endSeconds: 18,
    quote: "最近都在准备考试。",
    kind: "transcript",
    presentation: "direct_quote"
  }]
};

function renderHome(uploadState: CompanionUploadPresentation) {
  return render(
    <CompanionHome
      currentInteraction={null}
      uploadState={uploadState}
      onRetryRead={vi.fn()}
      onUpload={vi.fn()}
    />
  );
}

describe("CompanionHome", () => {
  it("shows a local-time greeting without inventing a person name", async () => {
    renderHome({ status: "idle" });

    await waitFor(() => expect(document.querySelector("[data-local-time-greeting]")).toHaveTextContent(
      /^(早上好|上午好|中午好|下午好|晚上好)$/u
    ));
    expect(screen.getByRole("heading", { name: "关于 Ta" })).toBeInTheDocument();
    expect(screen.getByText("还没有留下关于 Ta 的近况")).toBeInTheDocument();
  });

  it("presents only the real relationship name and confirmed recent item", () => {
    render(
      <CompanionHome
        currentInteraction={null}
        onRetryRead={vi.fn()}
        onUpload={vi.fn()}
        recentItem={recentItem}
        relationshipName="小林"
        uploadState={{ status: "idle" }}
      />
    );

    expect(screen.getByRole("heading", { name: "你和 小林" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开关于 小林" })).toHaveAttribute("href", "/date-companion/a/person");
    expect(screen.getByText("Ta 最近在准备一场重要考试")).toBeInTheDocument();
    expect(screen.queryByText(/认识.*天|河边|周六/u)).not.toBeInTheDocument();
  });

  it("uses an indeterminate uploading state instead of displaying a fabricated percentage", () => {
    renderHome({ status: "uploading", progress: 73 });

    expect(screen.getByLabelText("正在上传，暂无百分比")).toBeInTheDocument();
    expect(screen.queryByText("73%")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/上传进度 \d+%/)).not.toBeInTheDocument();
  });

  it("closes the upload details when ready while keeping a recap entry point outside it", async () => {
    const props = {
      currentInteraction: null,
      onRetryRead: vi.fn(),
      onUpload: vi.fn()
    };
    const { container, rerender } = render(
      <CompanionHome {...props} uploadState={{ status: "processing", jobStatus: "transcribing", progress: 45 }} />
    );
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    details?.setAttribute("open", "");

    rerender(<CompanionHome {...props} uploadState={{ status: "ready" }} />);

    await waitFor(() => expect(details).not.toHaveAttribute("open"));
    const recapLinks = screen.getAllByRole("link", { name: /查看这次复盘/ });
    expect(recapLinks.some((link) => !details?.contains(link))).toBe(true);
  });

  it("allows another recording to be selected and uploaded after a recap is ready", async () => {
    const onUpload = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <CompanionHome
        currentInteraction={null}
        onRetryRead={vi.fn()}
        onUpload={onUpload}
        uploadState={{ status: "ready" }}
      />
    );

    expect(screen.getAllByRole("link", { name: /查看这次复盘/u }).length).toBeGreaterThan(0);
    fireEvent.click(container.querySelector("summary")!);
    const nextFile = new File(["next"], "next-date.wav", { type: "audio/wav" });
    fireEvent.change(screen.getByLabelText(/选择一段完整录音/u), { target: { files: [nextFile] } });

    const submit = screen.getByRole("button", { name: "开始上传" });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(onUpload).toHaveBeenCalledWith(
      nextFile,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u)
    ));
  });

  it("keeps a processing failure visible and opens its backend detail", () => {
    const errorMessage = "转写服务超时";
    const { container } = renderHome({ status: "failed", errorMessage });

    const failureAction = screen.getByRole("button", { name: /转写服务超时.*查看详情/ });
    expect(failureAction).toBeInTheDocument();
    fireEvent.click(failureAction);

    expect(container.querySelector("details")).toHaveAttribute("open");
    expect(screen.getByRole("alert")).toHaveTextContent(errorMessage);
  });
});
