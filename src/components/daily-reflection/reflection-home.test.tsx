import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { consumeVoiceAutostartIntent } from "./reflection-capture-intent";
import { ReflectionHome } from "./reflection-home";

const state = vi.hoisted(() => ({
  app: {} as Record<string, unknown>,
  router: {
    push: vi.fn()
  }
}));

vi.mock("next/navigation", () => ({
  useRouter: () => state.router
}));

vi.mock("./reflection-app-shell", () => ({
  useReflectionApp: () => state.app
}));

const HOME_DATE = {
  dateKey: "2026-08-26",
  dateLabel: "8 月 26 日",
  weekdayLabel: "星期三"
};

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  state.app = {
    browserRecordingEnabled: true,
    toySyncEnabled: true,
    session: { recordingRecovery: null, reflectionId: null }
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReflectionHome", () => {
  it("keeps the recording entrance and adds a permanent recent sessions link without dashboard reads", () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    render(<ReflectionHome {...HOME_DATE} />);

    expect(screen.getByText("8 月 26 日").closest("time")).toHaveAttribute("dateTime", "2026-08-26");
    expect(screen.getByText("星期三")).toBeVisible();
    expect(screen.getByRole("button", { name: "开始讲述，进入录音" })).toBeEnabled();
    expect(screen.getByText("开始讲述")).toBeVisible();
    expect(screen.getByRole("link", { name: "玩偶导入" }))
      .toHaveAttribute("href", "/reflection/capture?new=1&method=toy");
    expect(screen.getByRole("link", { name: "上传文件" }))
      .toHaveAttribute("href", "/reflection/capture?new=1&method=upload");
    expect(screen.getByRole("link", { name: "最近复盘" })).toHaveAttribute("href", "/reflection/sessions");

    for (const removedCopy of [
      "早上好",
      "今天想留下什么？",
      "值得继续",
      "查看回看",
      "今天还没有记录",
      "过去的表达",
      "更多方式导入"
    ]) {
      expect(screen.queryByText(removedCopy)).not.toBeInTheDocument();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("arms one session-scoped voice intent and navigates through the existing capture route", () => {
    render(<ReflectionHome {...HOME_DATE} />);

    fireEvent.click(screen.getByRole("button", { name: "开始讲述，进入录音" }));

    expect(state.router.push).toHaveBeenCalledWith("/reflection/capture?new=1&method=record");
    expect(consumeVoiceAutostartIntent()).toBe(true);
    expect(consumeVoiceAutostartIntent()).toBe(false);
  });

  it("keeps disabled input methods honest instead of exposing fake actions", () => {
    state.app = {
      ...state.app,
      browserRecordingEnabled: false,
      toySyncEnabled: false
    };
    render(<ReflectionHome {...HOME_DATE} />);

    expect(screen.getByRole("button", { name: "开始讲述，进入录音" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "玩偶导入" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "上传文件" })).toBeVisible();
    expect(state.router.push).not.toHaveBeenCalled();
  });

  it("keeps an interrupted local operation reachable before a reflection ID exists", () => {
    const resumeRecording = vi.fn();
    state.app.session = { resumeRecording, reflectionId: null, recordingRecovery: {
      phase: "interrupted", reflectionId: null, localCopy: "saved", file: null, errorMessage: null
    } };
    render(<ReflectionHome {...HOME_DATE} />);
    const resume = screen.getByRole("link", { name: "继续这次复盘" });
    expect(resume).toHaveAttribute("href", "/reflection/capture?resume=1");
    fireEvent.click(resume);
    expect(resumeRecording).toHaveBeenCalledOnce();
    expect(screen.getByText(/原录音已暂存在本机/u)).toBeVisible();
  });
});
