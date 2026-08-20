import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BrowserAudioRecorderSnapshot,
  BrowserAudioRecording
} from "@/lib/client/browser-audio-recorder";
import type { DailyReflectionSessionValue } from "@/lib/client/daily-reflection-session";
import type {
  DailyReflectionCandidateView,
  DailyReflectionDetailResponse,
  DailyReflectionTranscriptSegmentView
} from "@/lib/domain/daily-reflection-api";

import {
  DailyReflectionShellContent,
  type DailyReflectionBrowserRecorder
} from "./daily-reflection-shell";

const routerMocks = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn()
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerMocks.replace, push: routerMocks.push })
}));

function segment(
  id: string,
  startSeconds: number,
  text: string
): DailyReflectionTranscriptSegmentView {
  return {
    id,
    uploadId: "upload-reflection",
    startSeconds,
    endSeconds: startSeconds + 6,
    speaker: startSeconds === 8 ? "我" : "说话人 2",
    text,
    confidence: 0.96,
    sceneLabels: [],
    valueLabels: []
  };
}

const SEGMENTS = [
  segment("segment-late", 42, "第四段在最后。"),
  segment("segment-early", 8, "第一段真实原话。"),
  segment("segment-third", 31, "第三段继续说明。"),
  segment("segment-second", 17, "第二段提到散步。"),
  segment("segment-fifth", 55, "第五段补充完整想法。")
];

function candidate(
  ordinal: number,
  candidateType: DailyReflectionCandidateView["candidateType"],
  sourceSegmentId: string,
  proposedText = `待确认内容 ${ordinal + 1}`
): DailyReflectionCandidateView {
  const source = SEGMENTS.find((item) => item.id === sourceSegmentId)!;
  return {
    id: `candidate-${ordinal}`,
    reflectionId: "reflection-1",
    ordinal,
    proposedText,
    userText: null,
    status: "pending",
    candidateType,
    sourceSegmentIds: [sourceSegmentId],
    subjectPersonId: null,
    subjectConfirmed: false,
    version: 0,
    createdAt: "2026-08-13T08:04:00.000Z",
    updatedAt: "2026-08-13T08:04:00.000Z",
    evidence: [{
      sourceSegmentId,
      uploadId: source.uploadId,
      effectiveOrigin: "direct_conversation",
      startSeconds: source.startSeconds,
      endSeconds: source.endSeconds,
      text: source.text
    }]
  };
}

function detail(
  overrides: Partial<DailyReflectionDetailResponse> = {}
): DailyReflectionDetailResponse {
  return {
    reflection: {
      id: "reflection-1",
      accountId: "user-1",
      uploadId: "upload-reflection",
      inputMethod: "file_upload",
      sourceOrigin: "direct_conversation",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      status: "review_pending",
      version: 4,
      idempotencyKey: "upload-once",
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-08-13T08:00:00.000Z",
      updatedAt: "2026-08-13T08:04:00.000Z"
    },
    processingPlan: {
      planVersion: 1,
      reflectionId: "reflection-1",
      uploadId: "upload-reflection",
      inputMethod: "file_upload",
      sourceOrigin: "direct_conversation",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      reviewPolicy: "required"
    },
    job: {
      id: "job-reflection",
      reflectionId: "reflection-1",
      uploadId: "upload-reflection",
      status: "completed",
      progress: 100,
      executionMode: "inline",
      updatedAt: "2026-08-13T08:04:00.000Z",
      finishedAt: "2026-08-13T08:04:00.000Z"
    },
    upload: {
      id: "upload-reflection",
      originalName: "周三散步.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 2_048,
      recordingDate: "2026-08-13",
      durationSeconds: 48,
      status: "ready"
    },
    segments: SEGMENTS,
    effectiveOrigin: "direct_conversation",
    candidates: [
      candidate(3, "summary", "segment-late"),
      candidate(0, "event", "segment-early"),
      candidate(2, "question", "segment-third"),
      candidate(1, "commitment", "segment-second"),
      candidate(4, "preference", "segment-fifth")
    ],
    confirmation: null,
    admissionOperation: null,
    admissionResults: [],
    ...overrides
  };
}

function session(
  overrides: Partial<DailyReflectionSessionValue> = {}
): DailyReflectionSessionValue {
  return {
    auth: {
      status: "authenticated",
      user: { id: "user-1", email: "user@example.com", name: "小满" }
    },
    state: "idle",
    operation: "idle",
    reflectionId: null,
    detail: null,
    selectedFile: null,
    sourceOrigin: null,
    recordingDate: "",
    confirmedPeople: [],
    peopleState: "idle",
    history: [],
    historyState: "ready",
    historyErrorMessage: null,
    activeCandidateId: null,
    errorMessage: null,
    initialize: vi.fn(async () => undefined),
    setSelectedFile: vi.fn(),
    setSourceOrigin: vi.fn(),
    setRecordingDate: vi.fn(),
    upload: vi.fn(async () => true),
    uploadBrowserRecording: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    refreshHistory: vi.fn(async () => undefined),
    startNew: vi.fn(),
    updateCandidate: vi.fn(async () => undefined),
    finalize: vi.fn(async () => undefined),
    revokeCandidate: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    dispose: vi.fn(),
    ...overrides
  };
}

class ControlledBrowserRecorder implements DailyReflectionBrowserRecorder {
  private snapshot: BrowserAudioRecorderSnapshot = {
    state: "idle",
    durationHint: "none",
    clientReportedDurationMs: null,
    recording: null
  };
  private finishStopRequest: ((recording: BrowserAudioRecording) => void) | null = null;

  constructor(
    private readonly onSnapshot: (snapshot: BrowserAudioRecorderSnapshot) => void,
    private readonly startError?: DOMException
  ) {}

  readonly getSnapshot = vi.fn(() => this.snapshot);

  readonly start = vi.fn(async () => {
    this.publish({
      state: "starting",
      durationHint: "none",
      clientReportedDurationMs: null,
      recording: null
    });
    await Promise.resolve();
    if (this.startError) {
      this.publish({
        state: "idle",
        durationHint: "none",
        clientReportedDurationMs: null,
        recording: null
      });
      throw this.startError;
    }
    this.publish({
      state: "recording",
      durationHint: "none",
      clientReportedDurationMs: 0,
      recording: null
    });
  });

  readonly stop = vi.fn(() => {
    this.publish({ ...this.snapshot, state: "stopping", recording: null });
    return new Promise<BrowserAudioRecording>((resolve) => {
      this.finishStopRequest = resolve;
    });
  });

  readonly cancel = vi.fn(() => {
    this.finishStopRequest = null;
    this.publish({
      state: "idle",
      durationHint: "none",
      clientReportedDurationMs: null,
      recording: null
    });
  });

  readonly rerecord = vi.fn(async () => {
    this.finishStopRequest = null;
    this.publish({
      state: "recording",
      durationHint: "none",
      clientReportedDurationMs: 0,
      recording: null
    });
  });

  readonly dispose = vi.fn(() => {
    this.finishStopRequest = null;
    this.publish({
      state: "disposed",
      durationHint: "none",
      clientReportedDurationMs: null,
      recording: null
    });
  });

  setDuration(durationMs: number, emit = true) {
    this.snapshot = {
      ...this.snapshot,
      durationHint: durationMs >= 150_000 ? "continue_or_finish" : "none",
      clientReportedDurationMs: durationMs
    };
    if (emit) this.onSnapshot(this.snapshot);
  }

  finishStop(
    durationMs = this.snapshot.clientReportedDurationMs ?? 181_000,
    mimeType = "audio/webm;codecs=opus"
  ) {
    const recording: BrowserAudioRecording = {
      blob: new Blob(["browser audio"], { type: mimeType }),
      clientReportedDurationMs: durationMs
    };
    const resolve = this.finishStopRequest;
    this.finishStopRequest = null;
    this.publish({
      state: "ready",
      durationHint: "none",
      clientReportedDurationMs: durationMs,
      recording
    });
    resolve?.(recording);
  }

  private publish(snapshot: BrowserAudioRecorderSnapshot) {
    this.snapshot = snapshot;
    this.onSnapshot(snapshot);
  }
}

function controlledRecorderFactory(startError?: DOMException) {
  const instances: ControlledBrowserRecorder[] = [];
  const factory = vi.fn((onSnapshot: (snapshot: BrowserAudioRecorderSnapshot) => void) => {
    const recorder = new ControlledBrowserRecorder(onSnapshot, startError);
    instances.push(recorder);
    return recorder;
  });
  return { factory, instances };
}

describe("DailyReflectionShellContent", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps file upload available while the independent browser flag controls only recording", () => {
    const { factory } = controlledRecorderFactory();
    const { rerender } = render(
      <DailyReflectionShellContent session={session()} />
    );

    expect(screen.queryByRole("button", { name: "开始快速复盘" })).not.toBeInTheDocument();
    expect(screen.getByRole("form", { name: "上传日常复盘录音" })).toBeVisible();
    expect(screen.getByText("选择已有录音并说明来源。", { exact: false })).toBeVisible();

    rerender(
      <DailyReflectionShellContent
        browserRecordingEnabled
        createBrowserRecorder={factory}
        session={session()}
      />
    );

    const recordingButton = screen.getByRole("button", { name: "开始快速复盘" });
    const uploadForm = screen.getByRole("form", { name: "上传日常复盘录音" });
    expect(recordingButton).toBeVisible();
    expect(uploadForm).toBeVisible();
    expect(recordingButton.closest("section")?.parentElement).toBe(uploadForm.parentElement);
    expect(screen.getByText("提交前请不要刷新或离开", { exact: false })).toBeVisible();
  });

  it("keeps toy sync off by default and preserves manual upload when it is enabled", () => {
    const { rerender } = render(<DailyReflectionShellContent session={session()} />);
    expect(screen.queryByRole("heading", { name: "连接玩偶录音" })).not.toBeInTheDocument();

    rerender(<DailyReflectionShellContent session={session()} toySyncEnabled />);
    expect(screen.getByRole("heading", { name: "连接玩偶录音" })).toBeVisible();
    expect(screen.getByRole("form", { name: "上传日常复盘录音" })).toBeVisible();
  });

  it.each([
    ["NotAllowedError", "没有获得麦克风权限"],
    ["NotSupportedError", "当前浏览器不支持直接录音"]
  ])("shows a safe recording error for %s without weakening upload", async (name, message) => {
    const { factory } = controlledRecorderFactory(new DOMException("private detail", name));
    render(
      <DailyReflectionShellContent
        browserRecordingEnabled
        createBrowserRecorder={factory}
        session={session()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "开始快速复盘" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
    expect(screen.getByRole("form", { name: "上传日常复盘录音" })).toBeVisible();
    expect(screen.getByRole("button", { name: "开始快速复盘" })).toBeEnabled();
    expect(screen.queryByText("private detail")).not.toBeInTheDocument();
  });

  it("supports start, stop, cancel, rerecord, local deletion, and recorder disposal", async () => {
    const { factory, instances } = controlledRecorderFactory();
    const view = render(
      <DailyReflectionShellContent
        browserRecordingEnabled
        createBrowserRecorder={factory}
        session={session()}
      />
    );
    const recorder = instances[0]!;

    fireEvent.click(screen.getByRole("button", { name: "开始快速复盘" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "停止录音" })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "取消录音" }));
    expect(recorder.cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "开始快速复盘" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "开始快速复盘" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "停止录音" })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "停止录音" }));
    expect(screen.getByText("正在整理这次复盘……")).toBeVisible();
    act(() => recorder.finishStop(181_000));
    await waitFor(() => expect(screen.getByText("本地录音已准备好")).toBeVisible());

    fireEvent.click(screen.getByRole("button", { name: "重新录制" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "停止录音" })).toBeVisible());
    expect(recorder.rerecord).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "停止录音" }));
    act(() => recorder.finishStop(182_000));
    await waitFor(() => expect(screen.getByRole("button", { name: "删除本地录音" })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "删除本地录音" }));
    expect(screen.getByRole("button", { name: "开始快速复盘" })).toBeVisible();

    view.unmount();
    expect(recorder.dispose).toHaveBeenCalledTimes(1);
  });

  it("releases an active microphone before logout can wait on the network", async () => {
    let finishLogout!: () => void;
    const logout = vi.fn(() => new Promise<void>((resolve) => {
      finishLogout = resolve;
    }));
    const { factory, instances } = controlledRecorderFactory();
    render(
      <DailyReflectionShellContent
        browserRecordingEnabled
        createBrowserRecorder={factory}
        session={session({ logout })}
      />
    );
    const recorder = instances[0]!;

    fireEvent.click(screen.getByRole("button", { name: "开始快速复盘" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "停止录音" })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "退出" }));

    expect(recorder.cancel).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledTimes(1);
    expect(routerMocks.replace).not.toHaveBeenCalledWith("/date-companion");
    await act(async () => finishLogout());
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/date-companion"));
  });

  it("keeps a live timer and treats 150, 180, and 181 seconds as presentation hints only", async () => {
    vi.useFakeTimers();
    const uploadBrowserRecording = vi.fn(async () => undefined);
    const { factory, instances } = controlledRecorderFactory();
    render(
      <DailyReflectionShellContent
        browserRecordingEnabled
        createBrowserRecorder={factory}
        session={session({ uploadBrowserRecording })}
      />
    );
    const recorder = instances[0]!;

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "开始快速复盘" }));
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "停止录音" })).toBeVisible();

    act(() => {
      recorder.setDuration(1_000, false);
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByLabelText("录音时长 00:01")).toBeVisible();

    act(() => recorder.setDuration(149_999));
    expect(screen.getByText("正在记录")).toBeVisible();
    act(() => recorder.setDuration(150_000));
    expect(screen.getByText("已经说了两分半。你可以继续，也可以开始整理。")).toBeVisible();
    act(() => recorder.setDuration(180_000));
    expect(screen.getByText("已经说了两分半。你可以继续，也可以开始整理。")).toBeVisible();
    act(() => recorder.setDuration(181_000));
    expect(screen.getByText("你可以继续说。我会按完整复盘为你整理。")).toBeVisible();

    expect(recorder.stop).not.toHaveBeenCalled();
    expect(uploadBrowserRecording).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "停止录音" })).toBeEnabled();
  });

  it("submits one ready recording with one stable key and no client-selected source", async () => {
    let finishUpload!: () => void;
    const pendingUpload = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    const uploadBrowserRecording = vi.fn((
      _file: File,
      _clientReportedDurationMs: number | undefined,
      _recordingDate: string,
      _idempotencyKey: string
    ) => pendingUpload);
    const { factory, instances } = controlledRecorderFactory();
    render(
      <DailyReflectionShellContent
        browserRecordingEnabled
        createBrowserRecorder={factory}
        createBrowserRecordingIdempotencyKey={() => "stable-browser-key"}
        session={session({ uploadBrowserRecording })}
      />
    );
    const recorder = instances[0]!;

    fireEvent.click(screen.getByRole("button", { name: "开始快速复盘" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "停止录音" })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "停止录音" }));
    act(() => recorder.finishStop(181_000, "audio/webm;codecs=opus"));
    const submitButton = await screen.findByRole("button", { name: "提交并开始整理" });
    fireEvent.click(submitButton);
    fireEvent.click(submitButton);

    expect(uploadBrowserRecording).toHaveBeenCalledTimes(1);
    const [submittedFile, durationMs, date, idempotencyKey] = uploadBrowserRecording.mock.calls[0]!;
    expect(submittedFile).toBeInstanceOf(File);
    expect(submittedFile.name).toMatch(/^daily-reflection-\d{4}-\d{2}-\d{2}\.webm$/u);
    expect(submittedFile.type).toBe("audio/webm;codecs=opus");
    expect(durationMs).toBe(181_000);
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(idempotencyKey).toBe("stable-browser-key");
    expect(screen.getByText("正在整理这次复盘……")).toBeVisible();

    await act(async () => finishUpload());
  });

  it("requires an explicit source, a supported file, and a date before upload", () => {
    const upload = vi.fn(async () => true);
    render(<DailyReflectionShellContent session={session({ upload })} />);

    const choices = screen.getAllByRole("radio");
    expect(choices).toHaveLength(3);
    expect(choices.every((choice) => !(choice as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText("我自己的复盘")).toBeInTheDocument();
    expect(screen.getByText("我和其他人的真实交流")).toBeInTheDocument();
    expect(screen.getByText("其他或暂时无法确定")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始上传" })).toBeDisabled();

    const audioFile = new File(["audio"], "reflection.m4a", { type: "audio/mp4" });
    fireEvent.change(screen.getByLabelText(/选择一段已有录音/u), {
      target: { files: [audioFile] }
    });
    expect(screen.getByText("reflection.m4a")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始上传" })).toBeDisabled();

    fireEvent.click(screen.getByRole("radio", { name: "我自己的复盘" }));
    const submit = screen.getByRole("button", { name: "开始上传" });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    const recordingDate = (screen.getByLabelText("录音发生在") as HTMLInputElement).value;
    expect(recordingDate).not.toBe("");
    expect(upload).toHaveBeenCalledWith(audioFile, "user_reflection", recordingDate);
  });

  it("gives friendly format and 300MB prechecks while leaving the service authoritative", () => {
    render(<DailyReflectionShellContent session={session()} />);
    const input = screen.getByLabelText(/选择一段已有录音/u);

    fireEvent.change(input, {
      target: { files: [new File(["plain"], "notes.txt", { type: "text/plain" })] }
    });
    expect(screen.getByRole("alert")).toHaveTextContent("暂不支持这种录音格式");
    expect(screen.getByRole("alert")).toHaveTextContent("最终仍以实际上传检查为准");

    const oversized = new File(["audio"], "too-large.wav", { type: "audio/wav" });
    Object.defineProperty(oversized, "size", { value: 300 * 1024 * 1024 + 1 });
    fireEvent.change(input, { target: { files: [oversized] } });
    expect(screen.getByRole("alert")).toHaveTextContent("文件超过 300MB");
  });

  it("shows three of five full candidates first, expands all persisted candidates, and keeps source jumps", async () => {
    const review = detail();
    const { container } = render(
      <DailyReflectionShellContent
        initialReflectionId="reflection-1"
        session={session({
          state: "review_pending",
          reflectionId: "reflection-1",
          detail: review
        })}
      />
    );

    expect(screen.getByText("周三散步.m4a")).toBeInTheDocument();
    expect(screen.getByText("我和其他人的真实交流")).toBeInTheDocument();
    expect(screen.getByText("我先整理出了最值得记住的几件事")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "查看原话" })).toHaveLength(3);
    expect(screen.getByText("还有2件可能值得记住")).toBeVisible();
    expect(screen.queryByDisplayValue("待确认内容 4")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("待确认内容 5")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看全部" }));
    expect(screen.getAllByRole("button", { name: "查看原话" })).toHaveLength(5);
    expect(screen.getByDisplayValue("待确认内容 4")).toBeVisible();
    expect(screen.getByDisplayValue("待确认内容 5")).toBeVisible();
    expect(screen.getByText("发生的事")).toBeInTheDocument();
    expect(screen.getByText("约定与行动")).toBeInTheDocument();
    expect(screen.getByText("仍待回答的问题")).toBeInTheDocument();
    expect(screen.getByText("这段内容的整理")).toBeInTheDocument();
    expect(screen.getByText("表达的偏好")).toBeInTheDocument();

    const transcript = screen.getByRole("region", { name: "完整文字稿" });
    expect(within(transcript).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("第一段真实原话。"),
      expect.stringContaining("第二段提到散步。"),
      expect.stringContaining("第三段继续说明。"),
      expect.stringContaining("第四段在最后。"),
      expect.stringContaining("第五段补充完整想法。")
    ]);

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索文字稿" }), {
      target: { value: "第二段" }
    });
    expect(within(transcript).getAllByRole("listitem")).toHaveLength(1);
    expect(within(transcript).getByText("第二段提到散步。")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "查看原话" })[4]);
    await waitFor(() => {
      const source = container.querySelector('[data-segment-id="segment-fifth"]');
      expect(source).toHaveAttribute("data-highlighted", "true");
      expect(document.activeElement).toBe(source);
    });

    const visibleCopy = container.textContent ?? "";
    for (const forbidden of [
      "Memory",
      "Provider",
      "Pipeline",
      "Retrieval",
      "Citation",
      "sourceSegmentId",
      "processingProfile",
      "ASR",
      "已记住",
      "人物选择",
      "快速录音",
      "finalize"
    ]) {
      expect(visibleCopy).not.toContain(forbidden);
    }
  });

  it("keeps every candidate pending by default and requires an explicit remember or exclude choice", () => {
    const updateCandidate = vi.fn(async () => undefined);
    render(<DailyReflectionShellContent session={session({
      state: "review_pending",
      reflectionId: "reflection-1",
      detail: detail({ candidates: [candidate(0, "event", "segment-early")] }),
      updateCandidate
    })} />);

    const finalizeButton = screen.getByRole("button", { name: "确认并完成这次复盘" });
    expect(finalizeButton).toBeDisabled();
    expect(screen.getByText("还有 1 条待选择")).toBeVisible();
    expect(screen.getByRole("button", { name: "记住" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "不记" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("编辑发生的事"), { target: { value: "我重新写过的内容" } });
    fireEvent.click(screen.getByRole("button", { name: "记住" }));
    expect(updateCandidate).toHaveBeenLastCalledWith({
      candidateId: "candidate-0",
      status: "kept",
      userText: "我重新写过的内容",
      subjectPersonId: null
    });

    fireEvent.change(screen.getByLabelText("编辑发生的事"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "不记" }));
    expect(updateCandidate).toHaveBeenLastCalledWith({
      candidateId: "candidate-0",
      status: "excluded",
      userText: null,
      subjectPersonId: null
    });
  });

  it("allows only kept candidates to restore text and select a confirmed person", () => {
    const keptCandidate: DailyReflectionCandidateView = {
      ...candidate(0, "event", "segment-early", "AI 原文内容"),
      userText: "我改过的内容",
      status: "kept",
      subjectPersonId: null,
      version: 2
    };
    const updateCandidate = vi.fn(async () => undefined);
    render(<DailyReflectionShellContent session={session({
      state: "review_pending",
      reflectionId: "reflection-1",
      detail: detail({ candidates: [keptCandidate] }),
      confirmedPeople: [{
        id: "person-alpha-001",
        displayName: "林澄",
        status: "confirmed",
        version: 1,
        explicitlyConfirmed: true,
        confirmedAt: "2026-08-13T08:00:00.000Z",
        createdAt: "2026-08-13T08:00:00.000Z",
        updatedAt: "2026-08-13T08:00:00.000Z"
      }, {
        id: "person-beta-002",
        displayName: "林澄",
        status: "confirmed",
        version: 1,
        explicitlyConfirmed: true,
        confirmedAt: "2026-08-13T08:00:00.000Z",
        createdAt: "2026-08-13T08:00:00.000Z",
        updatedAt: "2026-08-13T08:00:00.000Z"
      }],
      peopleState: "ready",
      updateCandidate
    })} />);

    const editor = screen.getByLabelText("编辑发生的事");
    expect(editor).toHaveValue("我改过的内容");
    fireEvent.click(screen.getByRole("button", { name: "恢复最初整理" }));
    expect(editor).toHaveValue("AI 原文内容");

    const select = screen.getByRole("combobox", { name: "为发生的事选择人物" });
    const options = within(select).getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual([
      "暂不关联人物",
      "林澄 · ha-001",
      "林澄 · ta-002"
    ]);
    expect(within(select).queryByRole("option", { name: "我" })).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: "person-beta-002" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    expect(updateCandidate).toHaveBeenCalledWith({
      candidateId: "candidate-0",
      status: "kept",
      userText: null,
      subjectPersonId: "person-beta-002"
    });
  });

  it("shows completed counts in user language without internal admission terms", () => {
    const completed = detail({
      reflection: { ...detail().reflection, status: "completed", version: 9 },
      candidates: [{ ...candidate(0, "event", "segment-early"), status: "kept" }],
      admissionOperation: {
        id: "operation-1",
        reflectionId: "reflection-1",
        confirmationId: "confirmation-1",
        accountId: "user-1",
        status: "completed",
        admittedCount: 2,
        rejectedCount: 1,
        excludedCount: 3,
        errorCode: null,
        createdAt: "2026-08-13T08:04:00.000Z",
        updatedAt: "2026-08-13T08:05:00.000Z",
        completedAt: "2026-08-13T08:05:00.000Z"
      }
    });
    const { container } = render(<DailyReflectionShellContent session={session({
      state: "completed",
      reflectionId: "reflection-1",
      detail: completed
    })} />);

    expect(screen.getByText("这次复盘已经整理好")).toBeVisible();
    expect(screen.getByText("我记住了 2 件事，另有 1 件暂时没有保存。你选择不记 3 件。")).toBeVisible();
    expect(container.textContent).not.toMatch(/Admission|owner|operation/iu);
  });

  it("states clearly when the user excludes every candidate", () => {
    const completed = detail({
      reflection: { ...detail().reflection, status: "completed", version: 9 },
      candidates: [{ ...candidate(0, "event", "segment-early"), status: "excluded" }],
      admissionOperation: {
        id: "operation-all-excluded",
        reflectionId: "reflection-1",
        confirmationId: "confirmation-all-excluded",
        accountId: "user-1",
        status: "completed",
        admittedCount: 0,
        rejectedCount: 0,
        excludedCount: 1,
        errorCode: null,
        createdAt: "2026-08-13T08:04:00.000Z",
        updatedAt: "2026-08-13T08:05:00.000Z",
        completedAt: "2026-08-13T08:05:00.000Z"
      }
    });
    render(<DailyReflectionShellContent session={session({
      state: "completed",
      reflectionId: "reflection-1",
      detail: completed
    })} />);

    expect(screen.getByText("这次没有保存长期内容。")).toBeVisible();
  });

  it("does not present provisional admission counts as a completed result", () => {
    const admitting = detail({
      reflection: { ...detail().reflection, status: "admitting", version: 8 },
      admissionOperation: {
        id: "operation-1",
        reflectionId: "reflection-1",
        confirmationId: "confirmation-1",
        accountId: "user-1",
        status: "admitting",
        admittedCount: 0,
        rejectedCount: 0,
        excludedCount: 2,
        errorCode: null,
        createdAt: "2026-08-13T08:04:00.000Z",
        updatedAt: "2026-08-13T08:04:30.000Z",
        completedAt: null
      }
    });
    render(<DailyReflectionShellContent session={session({
      state: "admitting",
      reflectionId: "reflection-1",
      detail: admitting
    })} />);

    expect(screen.getByText("正在安全保存你刚刚确认的内容。")).toBeVisible();
    expect(screen.queryByText(/已留下/u)).not.toBeInTheDocument();
  });

  it("offers the same safe finalize retry after admission failure", () => {
    const finalize = vi.fn(async () => undefined);
    const failed = detail({
      reflection: { ...detail().reflection, status: "admission_failed", version: 9 },
      admissionOperation: {
        id: "operation-failed",
        reflectionId: "reflection-1",
        confirmationId: "confirmation-failed",
        accountId: "user-1",
        status: "admission_failed",
        admittedCount: 0,
        rejectedCount: 0,
        excludedCount: 0,
        errorCode: "internal-safe-code",
        createdAt: "2026-08-13T08:04:00.000Z",
        updatedAt: "2026-08-13T08:05:00.000Z",
        completedAt: null
      }
    });
    const { container } = render(<DailyReflectionShellContent session={session({
      state: "admission_failed",
      reflectionId: "reflection-1",
      detail: failed,
      finalize
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "重新安全保存" }));
    expect(finalize).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("internal-safe-code");
  });

  it("uses the server-selected quick review copy and never presents more than three candidates", () => {
    const quickDetail = detail({
      reflection: {
        ...detail().reflection,
        inputMethod: "browser_recording",
        sourceOrigin: "user_reflection",
        processingProfile: "quick_reflection"
      },
      processingPlan: {
        ...detail().processingPlan!,
        inputMethod: "browser_recording",
        sourceOrigin: "user_reflection",
        processingProfile: "quick_reflection"
      },
      effectiveOrigin: "user_reflection"
    });
    render(<DailyReflectionShellContent session={session({
      state: "review_pending",
      reflectionId: "reflection-1",
      detail: quickDetail
    })} />);

    expect(screen.getByText("我整理出了最多3件可能值得记住的事")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "查看原话" })).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "查看全部" })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("待确认内容 4")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("待确认内容 5")).not.toBeInTheDocument();
  });

  it("shows real progress and only the actions allowed while processing", () => {
    const processingDetail = detail({
      reflection: { ...detail().reflection, status: "extracting" },
      job: { ...detail().job!, status: "processing", progress: 37 }
    });
    render(<DailyReflectionShellContent session={session({
      state: "extracting",
      reflectionId: "reflection-1",
      detail: processingDetail
    })} />);

    expect(screen.getByLabelText("整理进度 37%")).toBeInTheDocument();
    expect(screen.getByText("37%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消整理" })).toBeVisible();
    expect(screen.getByRole("button", { name: "删除本次复盘" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "重试整理" })).not.toBeInTheDocument();
  });

  it("keeps upload percentage indeterminate and exposes retry only after failure", () => {
    const { rerender } = render(<DailyReflectionShellContent session={session({
      state: "uploading",
      operation: "uploading"
    })} />);

    expect(screen.getByLabelText("正在上传，暂无百分比")).toBeInTheDocument();
    expect(screen.queryByText(/\d+%/u)).not.toBeInTheDocument();

    const retry = vi.fn(async () => undefined);
    const failedDetail = detail({
      reflection: {
        ...detail().reflection,
        status: "failed",
        errorCode: "queue_unavailable",
        errorMessage: "internal detail"
      },
      job: { ...detail().job!, status: "failed", progress: 37 }
    });
    rerender(<DailyReflectionShellContent session={session({
      state: "failed",
      reflectionId: "reflection-1",
      detail: failedDetail,
      retry
    })} />);

    expect(screen.getByRole("alert")).toHaveTextContent("整理暂时没有开始，请稍后重试");
    expect(screen.getByRole("button", { name: "重试整理" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "取消整理" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试整理" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("does not invent source or recording date while a recovered record is loading", () => {
    render(<DailyReflectionShellContent initialReflectionId="reflection-1" session={session({
      state: "loading",
      operation: "loading",
      reflectionId: "reflection-1"
    })} />);

    expect(screen.getAllByText("正在读取")).toHaveLength(3);
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 10);
    expect(screen.queryByText(local)).not.toBeInTheDocument();
  });

  it("redirects anonymous access and clears the reflection query after deletion", async () => {
    render(<DailyReflectionShellContent
      initialReflectionId="reflection-1"
      session={session({
        auth: { status: "anonymous" }
      })}
    />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/date-companion"));
    expect(routerMocks.replace).toHaveBeenLastCalledWith("/date-companion");

    cleanup();
    routerMocks.replace.mockClear();
    const { rerender } = render(<DailyReflectionShellContent session={session({
      state: "review_pending",
      reflectionId: "reflection-1",
      detail: detail()
    })} />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith(
      "/date-companion/reflection?reflectionId=reflection-1"
    ));

    rerender(<DailyReflectionShellContent session={session()} />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith(
      "/date-companion/reflection"
    ));
  });

  it("keeps both entry points and opens source-aware recent records from the same home", () => {
    const reload = vi.fn(async () => undefined);
    const refreshHistory = vi.fn(async () => undefined);
    const { factory } = controlledRecorderFactory();
    render(<DailyReflectionShellContent
      browserRecordingEnabled
      createBrowserRecorder={factory}
      session={session({
        confirmedPeople: [{
          id: "person-1",
          displayName: "林澄",
          status: "confirmed",
          version: 1,
          explicitlyConfirmed: true,
          confirmedAt: "2026-08-13T08:00:00.000Z",
          createdAt: "2026-08-13T08:00:00.000Z",
          updatedAt: "2026-08-13T08:00:00.000Z"
        }],
        history: [{
          id: "reflection-history-1",
          status: "completed",
          inputMethod: "browser_recording",
          sourceOrigin: "user_reflection",
          recordingDate: "2026-08-12",
          sourceStatement: "你在 2026-08-12 的复盘中提到……",
          candidateCount: 2,
          pendingCount: 0,
          keptCount: 1,
          excludedCount: 1,
          rememberedCount: 1,
          notSavedCount: 1,
          subjectPersonIds: ["person-1"],
          transcriptAvailable: true,
          createdAt: "2026-08-12T08:00:00.000Z",
          updatedAt: "2026-08-12T08:05:00.000Z"
        }],
        reload,
        refreshHistory
      })}
    />);

    expect(screen.getByRole("button", { name: "开始快速复盘" })).toBeVisible();
    expect(screen.getByRole("form", { name: "上传日常复盘录音" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "产品空间" })).toHaveTextContent("约会陪伴日常复盘");
    expect(screen.getByText("你在 2026-08-12 的复盘中提到……")).toBeVisible();
    expect(screen.getByText("记住 1 · 未保存 1")).toBeVisible();
    expect(screen.getByText("林澄")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /2026-08-12/u }));
    expect(reload).toHaveBeenCalledWith("reflection-history-1");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(refreshHistory).toHaveBeenCalledOnce();
  });

  it("shows completed choices, explicit people, source copy, and canonical source jumps", async () => {
    const revokeCandidate = vi.fn(async () => undefined);
    const remembered = {
      ...candidate(0, "event", "segment-early", "我决定周末去散步。"),
      status: "kept" as const,
      subjectPersonId: "person-1",
      subjectConfirmed: true
    };
    const excluded = {
      ...candidate(1, "commitment", "segment-second", "这条不要保存。"),
      status: "excluded" as const
    };
    const completed = detail({
      reflection: { ...detail().reflection, status: "completed", version: 7 },
      candidates: [remembered, excluded],
      admissionOperation: {
        id: "operation-1",
        reflectionId: "reflection-1",
        confirmationId: "confirmation-1",
        accountId: "user-1",
        status: "completed",
        admittedCount: 1,
        rejectedCount: 0,
        excludedCount: 1,
        errorCode: null,
        createdAt: "2026-08-13T08:05:00.000Z",
        updatedAt: "2026-08-13T08:05:00.000Z",
        completedAt: "2026-08-13T08:05:00.000Z"
      },
      admissionResults: [{
        candidateId: remembered.id,
        status: "admitted",
        memoryId: "saved-1",
        reasonCode: null,
        errorCode: null,
        operationKey: "operation-key-1",
        updatedAt: "2026-08-13T08:05:00.000Z"
      }],
      rememberedCount: 1,
      revokedCandidateIds: []
    });
    render(<DailyReflectionShellContent session={session({
      state: "completed",
      reflectionId: "reflection-1",
      detail: completed,
      revokeCandidate,
      confirmedPeople: [{
        id: "person-1",
        displayName: "林澄",
        status: "confirmed",
        version: 1,
        explicitlyConfirmed: true,
        confirmedAt: "2026-08-13T08:00:00.000Z",
        createdAt: "2026-08-13T08:00:00.000Z",
        updatedAt: "2026-08-13T08:00:00.000Z"
      }]
    })} />);

    expect(screen.getByText("在 2026-08-13 的交流中提到……")).toBeVisible();
    expect(screen.getByText("已经记住")).toBeVisible();
    expect(screen.getByText("你选择不保存")).toBeVisible();
    expect(screen.getByText("关联人物：林澄")).toBeVisible();
    expect(screen.getByRole("button", { name: "撤销保存" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "撤销保存" }));
    expect(screen.getByRole("alertdialog", { name: "只撤销这一条保存？" })).toHaveTextContent(
      "不会修改原始复盘文字，也不会删除整次复盘"
    );
    expect(screen.getByRole("button", { name: "删除本次复盘" })).toBeVisible();
    expect(revokeCandidate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认撤销" }));
    expect(revokeCandidate).toHaveBeenCalledWith(remembered.id);
    fireEvent.click(screen.getAllByRole("button", { name: "查看原话" })[0]);
    await waitFor(() => expect(document.querySelector('[data-segment-id="segment-early"]'))
      .toHaveAttribute("data-highlighted", "true"));
  });

  it("renders durable revoked state, updated count, and no repeat revoke action", async () => {
    const remembered = {
      ...candidate(0, "event", "segment-early", "我决定周末去散步。"),
      status: "kept" as const
    };
    const base = detail();
    const completed = detail({
      reflection: { ...base.reflection, status: "completed", version: 9 },
      candidates: [remembered],
      admissionOperation: {
        id: "operation-1",
        reflectionId: "reflection-1",
        confirmationId: "confirmation-1",
        accountId: "user-1",
        status: "completed",
        admittedCount: 1,
        rejectedCount: 0,
        excludedCount: 0,
        errorCode: null,
        createdAt: "2026-08-13T08:05:00.000Z",
        updatedAt: "2026-08-13T08:05:00.000Z",
        completedAt: "2026-08-13T08:05:00.000Z"
      },
      admissionResults: [{
        candidateId: remembered.id,
        status: "admitted",
        memoryId: "saved-1",
        reasonCode: null,
        errorCode: null,
        operationKey: "operation-key-1",
        updatedAt: "2026-08-13T08:05:00.000Z"
      }],
      rememberedCount: 0,
      revokedCandidateIds: [remembered.id]
    });
    render(<DailyReflectionShellContent session={session({
      state: "completed",
      reflectionId: "reflection-1",
      detail: completed
    })} />);

    expect(screen.getByText("已撤销保存")).toBeVisible();
    expect(screen.getByText("这次没有保存长期内容。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "撤销保存" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看原话" }));
    await waitFor(() => expect(document.querySelector('[data-segment-id="segment-early"]'))
      .toHaveAttribute("data-highlighted", "true"));
  });

  it("keeps a retryable candidate revoke visible and disables duplicates in flight", async () => {
    const remembered = {
      ...candidate(0, "event", "segment-early"),
      status: "kept" as const
    };
    const base = detail();
    const completed = detail({
      reflection: { ...base.reflection, status: "completed", version: 8 },
      candidates: [remembered],
      admissionOperation: {
        id: "operation-1",
        reflectionId: "reflection-1",
        confirmationId: "confirmation-1",
        accountId: "user-1",
        status: "completed",
        admittedCount: 1,
        rejectedCount: 0,
        excludedCount: 0,
        errorCode: null,
        createdAt: "2026-08-13T08:05:00.000Z",
        updatedAt: "2026-08-13T08:05:00.000Z",
        completedAt: "2026-08-13T08:05:00.000Z"
      },
      admissionResults: [{
        candidateId: remembered.id,
        status: "already_admitted",
        memoryId: "saved-1",
        reasonCode: null,
        errorCode: null,
        operationKey: "operation-key-1",
        updatedAt: "2026-08-13T08:05:00.000Z"
      }],
      rememberedCount: 1,
      revokedCandidateIds: []
    });
    const { rerender } = render(<DailyReflectionShellContent session={session({
      state: "completed",
      reflectionId: "reflection-1",
      detail: completed,
      activeCandidateId: remembered.id,
      errorMessage: "这条内容暂时没有撤销成功，请稍后重试。"
    })} />);

    expect(await screen.findByRole("alertdialog", { name: "只撤销这一条保存？" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "重试撤销" })).toHaveLength(2);

    rerender(<DailyReflectionShellContent session={session({
      state: "completed",
      reflectionId: "reflection-1",
      detail: completed,
      operation: "revoking_candidate",
      activeCandidateId: remembered.id
    })} />);
    const revokingButtons = screen.getAllByRole("button", { name: "正在撤销…" });
    expect(revokingButtons).toHaveLength(2);
    revokingButtons.forEach((button) => expect(button).toBeDisabled());
  });

  it("requires an explicit second deletion action and retains a retry surface", () => {
    const deleteReflection = vi.fn(async () => undefined);
    render(<DailyReflectionShellContent session={session({
      state: "failed",
      reflectionId: "reflection-1",
      detail: detail({
        reflection: { ...detail().reflection, status: "failed" }
      }),
      errorMessage: "删除没有完成，请稍后再试。",
      delete: deleteReflection
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "删除本次复盘" }));
    expect(deleteReflection).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "确定删除这次复盘吗？" })).toBeVisible();
    expect(screen.getByText("删除没有完成，请稍后再试。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(deleteReflection).toHaveBeenCalledOnce();
  });

  it("keeps the key recording, review, history, and deletion actions reachable on small screens", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/components/daily-reflection/daily-reflection.module.css"),
      "utf8"
    );
    expect(css).toContain("@media (max-width: 620px)");
    expect(css).toMatch(/\.historyList\s*\{\s*grid-template-columns:\s*1fr;/u);
    expect(css).toMatch(/\.candidateEditor textarea\s*\{\s*min-height:\s*150px;/u);
    expect(css).toContain("min-height: 46px");
    expect(css).toMatch(/\.revocationConfirmation > div:last-child\s*\{[^}]*flex-direction:\s*column;/u);
  });
});
