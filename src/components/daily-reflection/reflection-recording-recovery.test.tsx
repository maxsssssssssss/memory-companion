import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DailyReflectionSessionValue, ReflectionRecordingRecovery as Recovery } from "@/lib/client/daily-reflection-session";
import { ReflectionRecordingRecovery } from "./reflection-recording-recovery";
import { ReflectionRecentSessions } from "./reflection-recent-sessions";

const app = vi.hoisted(() => ({ session: {} as DailyReflectionSessionValue }));
vi.mock("./reflection-app-shell", () => ({ useReflectionApp: () => app }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function recovery(overrides: Partial<Recovery> = {}): Recovery {
  return { accountId: "fixture-account", operationKey: "fixture-operation", reflectionId: "fixture-record",
    inputAdapter: "file_picker", recordingDate: "2026-09-16", sourceOrigin: "user_reflection", submitted: true,
    file: new File(["synthetic bytes"], "original.webm", { type: "audio/webm" }), localCopy: "saved",
    phase: "interrupted", errorMessage: null, uploadState: "reupload_allowed",
    uploadFailure: { code: "daily_reflection_duration_probe_timeout", retryable: true }, ...overrides };
}
function session(value: Recovery): DailyReflectionSessionValue {
  return { recordingRecovery: value, detail: null, operation: "idle", retryRecordingUpload: vi.fn(),
    setRecordingRecoveryFile: vi.fn(), cancelRecordingUpload: vi.fn(), discardRecordingDraft: vi.fn(),
    history: [], historyState: "ready", refreshHistory: vi.fn() } as unknown as DailyReflectionSessionValue;
}

describe("recording recovery save feedback", () => {
  it("shows the save failure, safe code and original download while retaining retry", () => {
    const createObjectURL = vi.fn(() => "blob:original-audio");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const value = recovery();
    const state = session(value);
    const view = render(<ReflectionRecordingRecovery session={state} />);
    expect(screen.getByText("录音保存失败")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("超时");
    expect(screen.getByRole("alert")).toHaveTextContent("daily_reflection_duration_probe_timeout");
    expect(screen.getByText("记录编号：fixture-record")).toBeVisible();
    expect(screen.getByRole("link", { name: "下载原录音" })).toHaveAttribute("download", "original.webm");
    expect(screen.getByRole("link", { name: "下载原录音" })).toHaveAttribute("href", "blob:original-audio");
    expect(createObjectURL).toHaveBeenCalledWith(value.file);
    fireEvent.click(screen.getByRole("button", { name: "重试上传" }));
    expect(state.retryRecordingUpload).toHaveBeenCalledOnce();
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:original-audio");
  });

  it("does not claim a saved local copy without a Blob and allows a status check and original file selection", () => {
    const state = session(recovery({ file: null }));
    render(<ReflectionRecordingRecovery session={state} />);
    expect(screen.queryByText(/原录音已暂存在本机/u)).not.toBeInTheDocument();
    expect(screen.getByText(/此浏览器没有可用的本地副本/u)).toBeVisible();
    expect(screen.queryByRole("link", { name: "下载原录音" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "核对保存状态" }));
    expect(state.retryRecordingUpload).toHaveBeenCalledOnce();
    const original = new File(["original"], "original.webm");
    fireEvent.change(screen.getByLabelText("重新选择原文件"), { target: { files: [original] } });
    expect(state.setRecordingRecoveryFile).toHaveBeenCalledWith(original);
  });

  it("requires explicit confirmation to delete a corrupt record and does not offer the same-file retry", () => {
    const state = session(recovery({ uploadState: "unresolved", uploadFailure: { code: "daily_reflection_audio_invalid", retryable: false } }));
    render(<ReflectionRecordingRecovery session={state} />);
    expect(screen.getByRole("alert")).toHaveTextContent("音频损坏或不完整");
    expect(screen.queryByRole("button", { name: /重试上传|核对进度并继续上传/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消这次上传" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除失败记录" }));
    expect(state.cancelRecordingUpload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除失败记录" }));
    expect(state.cancelRecordingUpload).toHaveBeenCalledOnce();
  });

  it.each([
    ["unresolved", "interrupted", "录音保存尚未确认"],
    ["reupload_allowed", "interrupted", "录音保存尚未确认"],
    ["still_persisting", "persisting", "服务器正在保存录音"]
  ] as const)("keeps %s without failure distinct from failed save", (uploadState, phase, title) => {
    render(<ReflectionRecordingRecovery session={session(recovery({ uploadState, phase, uploadFailure: null }))} />);
    expect(screen.getByText(title)).toBeVisible();
    expect(screen.queryByText("录音保存失败")).not.toBeInTheDocument();
  });

  it("uses the same authoritative distinction in recent history even when every record status is uploading", () => {
    const state = session(recovery());
    app.session = { ...state, recordingRecovery: null, history: [
      { id: "failed", status: "uploading", recordingDate: "2026-09-16", uploadState: "reupload_allowed", uploadFailure: recovery().uploadFailure },
      { id: "unknown", status: "uploading", recordingDate: "2026-09-15", uploadState: "unresolved", uploadFailure: null },
      { id: "saving", status: "uploading", recordingDate: "2026-09-14", uploadState: "still_persisting", uploadFailure: null }
    ] } as DailyReflectionSessionValue;
    render(<ReflectionRecentSessions />);
    expect(screen.getByRole("link", { name: /2026-09-16/u })).toHaveTextContent("录音保存失败");
    expect(screen.getByRole("link", { name: /2026-09-16/u })).toHaveTextContent("daily_reflection_duration_probe_timeout");
    expect(screen.getByRole("link", { name: /2026-09-15/u })).toHaveTextContent("录音保存尚未确认");
    expect(screen.getByRole("link", { name: /2026-09-14/u })).toHaveTextContent("服务器正在保存录音");
  });
});
