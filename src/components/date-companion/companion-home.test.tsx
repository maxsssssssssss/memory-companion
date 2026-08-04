import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CompanionHome, type CompanionUploadPresentation } from "./companion-home";

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
