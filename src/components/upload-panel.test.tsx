import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UploadPanel } from "./upload-panel";

describe("UploadPanel", () => {
  it("shows a helpful message when the browser reports a failed upload fetch", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    render(<UploadPanel defaultRecordingDate="2026-06-09" onUploaded={vi.fn()} />);

    const file = new File(["audio"], "meeting.mp3", { type: "audio/mpeg" });
    fireEvent.change(screen.getByLabelText("音频文件"), {
      target: { files: [file] }
    });
    fireEvent.submit(screen.getByRole("button", { name: "开始分析" }).closest("form") as HTMLFormElement);

    expect(await screen.findByText(/上传请求被浏览器或网络中断/)).toBeInTheDocument();
  });

  it("rejects files larger than the upload limit before sending them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<UploadPanel defaultRecordingDate="2026-06-09" onUploaded={vi.fn()} />);

    const file = new File(["audio"], "all-day.mp3", { type: "audio/mpeg" });
    Object.defineProperty(file, "size", { value: 301 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText("音频文件"), {
      target: { files: [file] }
    });
    fireEvent.submit(screen.getByRole("button", { name: "开始分析" }).closest("form") as HTMLFormElement);

    expect(await screen.findByText(/单个音频最大支持 300MB/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not upload the audio file to the server in local-first mode", async () => {
    const fetchMock = vi.fn();
    const onLocalAnalyze = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);

    render(
      <UploadPanel
        defaultRecordingDate="2026-06-09"
        processingMode="local"
        onUploaded={vi.fn()}
        onLocalAnalyze={onLocalAnalyze}
      />
    );

    const file = new File(["audio"], "meeting.mp3", { type: "audio/mpeg" });
    fireEvent.change(screen.getByLabelText("音频文件"), {
      target: { files: [file] }
    });
    fireEvent.submit(screen.getByRole("button", { name: "开始本地分析" }).closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(onLocalAnalyze).toHaveBeenCalledWith({
        file,
        recordingDate: "2026-06-09"
      });
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
