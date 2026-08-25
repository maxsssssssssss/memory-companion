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
  DailyReflectionCardView,
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

function card(
  ordinal: number,
  cardKind: DailyReflectionCardView["cardKind"],
  evidenceIds: string[],
  overrides: Partial<DailyReflectionCardView> = {}
): DailyReflectionCardView {
  return {
    id: `card-${ordinal}`,
    reflectionId: "reflection-1",
    cardKind,
    proposedTitle: `整理重点 ${ordinal + 1}`,
    proposedText: `卡片内容 ${ordinal + 1}`,
    userTitle: null,
    userText: null,
    sourceCandidateIds: [`candidate-v2-${ordinal}`],
    evidenceIds,
    clusterId: `cluster-${ordinal % 2}`,
    clusterTitle: ordinal % 2 === 0 ? "工作与选择" : "关系与感受",
    displayTier: ordinal < 2 ? "primary" : "more",
    rank: ordinal,
    confidence: 0.9,
    importance: 0.8,
    durability: 0.7,
    novelty: 0.6,
    epistemicStatus: "explicit_user_statement",
    riskFlags: [],
    actionClaimed: false,
    reviewStatus: ordinal < 2 ? "pending" : "not_proposed",
    version: 0,
    createdAt: "2026-08-13T08:04:00.000Z",
    updatedAt: "2026-08-13T08:04:00.000Z",
    evidence: evidenceIds.map((sourceSegmentId) => {
      const source = SEGMENTS.find((item) => item.id === sourceSegmentId)!;
      return {
        sourceSegmentId,
        uploadId: source.uploadId,
        effectiveOrigin: "direct_conversation" as const,
        startSeconds: source.startSeconds,
        endSeconds: source.endSeconds,
        text: source.text
      };
    }),
    ...overrides
  };
}

function v2Candidate(
  ordinal: number,
  candidateKind: "insight" | "open_question" | "decision" | "user_action",
  sourceSegmentIds: string[] = ["segment-early"],
  overrides: Record<string, unknown> = {}
): DailyReflectionCandidateView {
  const actionClaimed = Boolean(overrides.actionClaimed);
  return {
    contractVersion: 2,
    id: `candidate-v2-${ordinal}`,
    reflectionId: "reflection-1",
    ordinal,
    proposedText: `V2 候选 ${ordinal + 1}`,
    userText: null,
    status: "pending",
    candidateKind,
    candidateType: candidateKind === "open_question"
      ? "question"
      : candidateKind === "user_action" && actionClaimed
        ? "commitment"
        : "summary",
    evidenceIds: sourceSegmentIds,
    sourceSegmentIds,
    confidence: 0.8,
    caution: "请按你的实际感受判断。",
    actionClaimed,
    subjectPersonId: null,
    subjectConfirmed: false,
    version: 0,
    createdAt: "2026-08-13T08:04:00.000Z",
    updatedAt: "2026-08-13T08:04:00.000Z",
    evidence: sourceSegmentIds.map((sourceSegmentId) => {
      const source = SEGMENTS.find((item) => item.id === sourceSegmentId)!;
      return {
        sourceSegmentId,
        uploadId: source.uploadId,
        effectiveOrigin: "direct_conversation" as const,
        startSeconds: source.startSeconds,
        endSeconds: source.endSeconds,
        text: source.text
      };
    }),
    ...overrides
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
    cards: [],
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
    operationReceipt: null,
    history: [],
    historyState: "ready",
    historyErrorMessage: null,
    activeCandidateId: null,
    workingCardStates: {},
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
    updateCandidates: vi.fn(async () => undefined),
    updateCard: vi.fn(async () => undefined),
    updateCards: vi.fn(async () => undefined),
    saveWorkingCard: vi.fn(async () => undefined),
    archiveWorkingCard: vi.fn(async () => undefined),
    restoreWorkingCard: vi.fn(async () => undefined),
    removeWorkingCard: vi.fn(async () => undefined),
    acceptAllCandidates: vi.fn(async () => undefined),
    createManualCandidate: vi.fn(async () => undefined),
    excludeCandidate: vi.fn(async () => undefined),
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

function chooseBrowserRecordingSource() {
  const section = screen.getByRole("heading", { name: "开始说" }).closest("section");
  if (!section) throw new Error("recording section is missing");
  fireEvent.click(within(section).getByRole("radio", { name: "我自己的复盘" }));
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

    expect(screen.queryByRole("button", { name: "开始说" })).not.toBeInTheDocument();
    expect(screen.getByRole("form", { name: "上传日常复盘录音" })).toBeVisible();
    expect(screen.getByText("来源需要由你明确选择；初始不会替你预选。")).toBeVisible();

    rerender(
      <DailyReflectionShellContent
        browserRecordingEnabled
        createBrowserRecorder={factory}
        session={session()}
      />
    );

    const recordingButton = screen.getByRole("button", { name: "开始说" });
    expect(recordingButton).toBeVisible();
    expect(screen.getByText("提交前请不要刷新或离开", { exact: false })).toBeVisible();
    expect(screen.queryByRole("form", { name: "上传日常复盘录音" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "上传录音" }));
    expect(screen.getByRole("form", { name: "上传日常复盘录音" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "开始说" })).not.toBeInTheDocument();
  });

  it("keeps toy sync off by default and preserves manual upload when it is enabled", () => {
    const { rerender } = render(<DailyReflectionShellContent session={session()} />);
    expect(screen.queryByRole("heading", { name: "连接玩偶录音" })).not.toBeInTheDocument();

    rerender(<DailyReflectionShellContent session={session()} toySyncEnabled />);
    expect(screen.queryByRole("heading", { name: "连接玩偶录音" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "从玩偶导入" }));
    expect(screen.getByRole("heading", { name: "连接玩偶录音" })).toBeVisible();
    expect(screen.queryByRole("form", { name: "上传日常复盘录音" })).not.toBeInTheDocument();
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

    chooseBrowserRecordingSource();
    fireEvent.click(screen.getByRole("button", { name: "开始说" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
    fireEvent.click(screen.getByRole("tab", { name: "上传录音" }));
    expect(screen.getByRole("form", { name: "上传日常复盘录音" })).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "开始说" }));
    expect(screen.getByRole("button", { name: "开始说" })).toBeEnabled();
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

    chooseBrowserRecordingSource();
    fireEvent.click(screen.getByRole("button", { name: "开始说" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "结束表达" })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "取消这次表达" }));
    expect(recorder.cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "开始说" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "开始说" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "结束表达" })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "结束表达" }));
    expect(screen.getByText("正在整理这次复盘……")).toBeVisible();
    act(() => recorder.finishStop(181_000));
    await waitFor(() => expect(screen.getByText("本地录音已准备好")).toBeVisible());

    fireEvent.click(screen.getByRole("button", { name: "重新录制" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "结束表达" })).toBeVisible());
    expect(recorder.rerecord).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "结束表达" }));
    act(() => recorder.finishStop(182_000));
    await waitFor(() => expect(screen.getByRole("button", { name: "删除本地录音" })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "删除本地录音" }));
    expect(screen.getByRole("button", { name: "开始说" })).toBeVisible();

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

    chooseBrowserRecordingSource();
    fireEvent.click(screen.getByRole("button", { name: "开始说" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "结束表达" })).toBeVisible());
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
      chooseBrowserRecordingSource();
      fireEvent.click(screen.getByRole("button", { name: "开始说" }));
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "结束表达" })).toBeVisible();

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
    expect(screen.getByRole("button", { name: "结束表达" })).toBeEnabled();
  });

  it("submits one ready recording with one stable key and the user's editable source", async () => {
    let finishUpload!: () => void;
    const pendingUpload = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    const uploadBrowserRecording = vi.fn((
      _file: File,
      _clientReportedDurationMs: number | undefined,
      _recordingDate: string,
      _idempotencyKey: string,
      _sourceOrigin?: "user_reflection" | "direct_conversation"
    ) => pendingUpload);
    const { factory, instances } = controlledRecorderFactory();
    render(
      <DailyReflectionShellContent
        browserRecordingEnabled
        createBrowserRecorder={factory}
        createOperationKey={() => "stable-browser-key"}
        session={session({ uploadBrowserRecording })}
      />
    );
    const recorder = instances[0]!;

    chooseBrowserRecordingSource();
    fireEvent.click(screen.getByRole("button", { name: "开始说" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "结束表达" })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "结束表达" }));
    act(() => recorder.finishStop(181_000, "audio/webm;codecs=opus"));
    const recorderSection = screen.getByRole("heading", { name: "开始说" })
      .closest("section")!;
    const submitButton = await within(recorderSection).findByRole("button", { name: "开始整理" });
    fireEvent.click(within(recorderSection).getByRole("radio", {
      name: "我和其他人的真实交流"
    }));
    fireEvent.click(submitButton);
    fireEvent.click(submitButton);

    expect(uploadBrowserRecording).toHaveBeenCalledTimes(1);
    const [submittedFile, durationMs, date, operationKey, submittedSource] =
      uploadBrowserRecording.mock.calls[0]!;
    expect(submittedFile).toBeInstanceOf(File);
    expect(submittedFile.name).toMatch(/^daily-reflection-\d{4}-\d{2}-\d{2}\.webm$/u);
    expect(submittedFile.type).toBe("audio/webm;codecs=opus");
    expect(durationMs).toBe(181_000);
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(operationKey).toBe("stable-browser-key");
    expect(submittedSource).toBe("direct_conversation");
    expect(screen.getByText("正在整理这次复盘……")).toBeVisible();

    await act(async () => finishUpload());
  });

  it("requires an explicit source, a supported file, and a date before upload", () => {
    const upload = vi.fn(async () => true);
    render(<DailyReflectionShellContent session={session({ upload })} />);

    const choices = screen.getAllByRole("radio");
    expect(choices).toHaveLength(2);
    expect(choices.every((choice) => !(choice as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText("我自己的复盘")).toBeInTheDocument();
    expect(screen.getByText("我和其他人的真实交流")).toBeInTheDocument();
    expect(screen.queryByText("其他或暂时无法确定")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始整理" })).toBeDisabled();

    const audioFile = new File(["audio"], "reflection.m4a", { type: "audio/mp4" });
    fireEvent.change(screen.getByLabelText(/选择一段已有录音/u), {
      target: { files: [audioFile] }
    });
    expect(screen.getByText("reflection.m4a")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始整理" })).toBeDisabled();

    fireEvent.click(screen.getByRole("radio", { name: "我自己的复盘" }));
    const submit = screen.getByRole("button", { name: "开始整理" });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    const recordingDate = (screen.getByLabelText("录音发生在") as HTMLInputElement).value;
    expect(recordingDate).not.toBe("");
    expect(upload).toHaveBeenCalledWith(audioFile, "user_reflection", recordingDate, {
      operationKey: expect.any(String),
      inputAdapter: "file_picker"
    });
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

  it("shows all five candidates immediately, expands Evidence, and keeps canonical source jumps", async () => {
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

    expect(screen.getByText(/周三散步\.m4a/u)).toBeInTheDocument();
    expect(screen.getByText("我和其他人的真实交流")).toBeInTheDocument();
    expect(screen.getByText("这次表达里有什么值得带走")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "展开全部原话" })).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "查看全部" })).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("待确认内容 4")).toBeVisible();
    expect(screen.getByDisplayValue("待确认内容 5")).toBeVisible();
    expect(screen.getByText("发生的事")).toBeInTheDocument();
    expect(screen.getByText("约定与行动")).toBeInTheDocument();
    expect(screen.getByText("仍待回答的问题")).toBeInTheDocument();
    expect(screen.getByText("这段内容的整理")).toBeInTheDocument();
    expect(screen.getByText("表达的偏好")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开 5 段" }));
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

    fireEvent.click(screen.getAllByRole("button", { name: "展开全部原话" })[4]);
    expect(screen.getByText("第五段补充完整想法。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "在完整文字稿中查看" }));
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

  it("keeps every candidate pending, supports batch accept, and preserves individual edits", () => {
    const updateCandidate = vi.fn(async () => undefined);
    const acceptAllCandidates = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => undefined);
    render(<DailyReflectionShellContent session={session({
      state: "review_pending",
      reflectionId: "reflection-1",
      detail: detail({ candidates: [candidate(0, "event", "segment-early")] }),
      updateCandidate,
      acceptAllCandidates,
      finalize
    })} />);

    expect(screen.getByRole("button", { name: "完成这次复盘" })).toBeEnabled();
    expect(screen.getByText(/还有 1 条可以以后再看/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "长期记住" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "不保存" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "长期记住这些重点" }));
    expect(acceptAllCandidates).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "完成这次复盘" }));
    expect(finalize).toHaveBeenCalledWith("recap_only");

    fireEvent.change(screen.getByLabelText("编辑发生的事"), { target: { value: "我重新写过的内容" } });
    fireEvent.click(screen.getByRole("button", { name: "长期记住" }));
    expect(updateCandidate).toHaveBeenLastCalledWith({
      candidateId: "candidate-0",
      status: "kept",
      userText: "我重新写过的内容",
      subjectPersonId: null
    });

    fireEvent.change(screen.getByLabelText("编辑发生的事"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "不保存" }));
    expect(updateCandidate).toHaveBeenLastCalledWith({
      candidateId: "candidate-0",
      status: "excluded",
      userText: null,
      subjectPersonId: null
    });
  });

  it("restores the proposed text without exposing any Person selector", () => {
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
      updateCandidate
    })} />);

    const editor = screen.getByLabelText("编辑发生的事");
    expect(editor).toHaveValue("我改过的内容");
    fireEvent.click(screen.getByRole("button", { name: "恢复最初整理" }));
    expect(editor).toHaveValue("AI 原文内容");

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    expect(updateCandidate).toHaveBeenCalledWith({
      candidateId: "candidate-0",
      status: "kept",
      userText: null,
      subjectPersonId: null
    });
  });

  it("expands every Evidence item, explicitly claims an action, deletes one card, and creates a manual card", () => {
    const updateCandidate = vi.fn(async () => undefined);
    const excludeCandidate = vi.fn(async () => undefined);
    const createManualCandidate = vi.fn(async () => undefined);
    const action = v2Candidate(0, "user_action", ["segment-early", "segment-second"]);
    render(<DailyReflectionShellContent session={session({
      state: "review_pending",
      reflectionId: "reflection-1",
      detail: detail({ candidates: [action] }),
      updateCandidate,
      excludeCandidate,
      createManualCandidate
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "展开全部原话" }));
    expect(screen.getAllByText("第一段真实原话。")).toHaveLength(1);
    expect(screen.getAllByText("第二段提到散步。")).toHaveLength(1);

    fireEvent.click(screen.getByRole("checkbox", { name: /这是我要做的/u }));
    expect(updateCandidate).toHaveBeenCalledWith(expect.objectContaining({
      candidateId: action.id,
      actionClaimed: true
    }));

    fireEvent.click(screen.getByRole("button", { name: "删除这张卡" }));
    expect(excludeCandidate).toHaveBeenCalledWith(action.id);

    fireEvent.click(screen.getByRole("button", { name: "手写补充一张卡片" }));
    fireEvent.change(screen.getByLabelText("这张卡片是什么"), {
      target: { value: "user_action" }
    });
    fireEvent.change(screen.getByLabelText("手写卡片内容"), {
      target: { value: "  明天散步十分钟  " }
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "第一段真实原话。" }));
    fireEvent.click(screen.getAllByRole("checkbox", { name: /这是我要做的/u })[1]);
    fireEvent.click(screen.getByRole("button", { name: "保存这张手写卡" }));

    expect(createManualCandidate).toHaveBeenCalledWith({
      candidateKind: "user_action",
      proposedText: "明天散步十分钟",
      evidenceIds: ["segment-early"],
      confidence: 1,
      caution: "这是你手写补充的内容，请按原话核对。",
      actionClaimed: true
    });
    expect(screen.queryByRole("combobox", { name: /人物/u })).not.toBeInTheDocument();
  });

  it("keeps an Evidence-free manual card recap-only", () => {
    const manual = v2Candidate(0, "insight", [], {
      id: "manual-no-evidence",
      status: "kept",
      proposedText: "只留在这次复盘。"
    });
    render(<DailyReflectionShellContent session={session({
      state: "review_pending",
      reflectionId: "reflection-1",
      detail: detail({ candidates: [manual] })
    })} />);

    expect(screen.getByText("有 1 条手写内容没有原话，只能随本次复盘保存。")).toBeVisible();
    expect(screen.getByRole("button", { name: "完成这次复盘" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /长期保留所选/u })).not.toBeInTheDocument();
  });

  it("requires an explicit action claim before a kept action can be retained", () => {
    const action = v2Candidate(0, "user_action", ["segment-early"], {
      status: "kept",
      actionClaimed: false
    });
    const finalize = vi.fn(async () => undefined);
    const { rerender } = render(<DailyReflectionShellContent session={session({
      state: "review_pending",
      reflectionId: "reflection-1",
      detail: detail({ candidates: [action] }),
      finalize
    })} />);

    expect(screen.getByText("有 1 条行动还没有由你认领，只能随本次复盘保存。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "完成这次复盘" }));
    expect(finalize).toHaveBeenLastCalledWith("recap_only");

    rerender(<DailyReflectionShellContent session={session({
      state: "review_pending",
      reflectionId: "reflection-1",
      detail: detail({
        candidates: [{ ...action, actionClaimed: true, candidateType: "commitment" }]
      }),
      finalize
    })} />);
    expect(screen.queryByText(/行动还没有由你认领/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "完成这次复盘" }));
    expect(finalize).toHaveBeenLastCalledWith("retain_selected");
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

    fireEvent.click(screen.getByRole("button", { name: "重新保存" }));
    expect(finalize).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("internal-safe-code");
  });

  it("shows every server-selected quick-review candidate without a hidden remainder", () => {
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

    expect(screen.getByText("这次表达里有什么值得带走")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "展开全部原话" })).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "查看全部" })).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("待确认内容 4")).toBeVisible();
    expect(screen.getByDisplayValue("待确认内容 5")).toBeVisible();
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
    expect(screen.getByRole("button", { name: "删除原始记录" })).not.toBeVisible();
    fireEvent.click(screen.getByText("更多"));
    expect(screen.getByRole("button", { name: "删除原始记录" })).toBeVisible();
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

  it("keeps the transcript available and offers retry or a manual card after candidate generation fails", () => {
    const base = detail();
    const failedDetail = {
      ...base,
      reflection: {
        ...base.reflection,
        status: "failed" as const,
        errorCode: "daily_reflection_candidate_provider_failed",
        errorMessage: "internal provider detail"
      },
      job: base.job ? { ...base.job, status: "failed" as const } : null
    };
    render(<DailyReflectionShellContent session={session({
      state: "failed",
      reflectionId: "reflection-1",
      detail: failedDetail
    })} />);

    expect(screen.getByText("这次整理还不完整")).toBeVisible();
    expect(screen.getByRole("button", { name: "重新整理重点" })).toBeVisible();
    expect(screen.getByRole("button", { name: "手写补充一张卡片" })).toBeVisible();
    expect(screen.getByText("完整文字记录")).toBeVisible();
    expect(screen.queryByText("第一段真实原话。")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开 5 段" }));
    expect(screen.getByLabelText("完整文字稿")).toBeVisible();
    expect(screen.getByText("第一段真实原话。")).toBeVisible();
  });

  it("presents Card digest with Primary first, More collapsed, risks conditional, and Evidence before Transcript", async () => {
    const updateCard = vi.fn(async () => undefined);
    const saveWorkingCard = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => undefined);
    const acceptAllCandidates = vi.fn(async () => undefined);
    const onLocalReviewMetric = vi.fn();
    const primaryAction = card(0, "user_action", ["segment-early"], {
      proposedTitle: "确认明天的安排",
      proposedText: "明天散步十分钟。",
      epistemicStatus: "ai_inference",
      riskFlags: ["low_evidence"]
    });
    const primaryInsight = card(1, "insight", ["segment-second"], {
      proposedTitle: "散步让我更放松"
    });
    const more = card(2, "open_question", ["segment-fifth"], {
      proposedTitle: "还要想清楚的事"
    });
    const { container } = render(
      <DailyReflectionShellContent
        onLocalReviewMetric={onLocalReviewMetric}
        session={session({
          state: "review_pending",
          reflectionId: "reflection-1",
          detail: detail({ candidates: [], cards: [more, primaryInsight, primaryAction] }),
          updateCard,
          saveWorkingCard,
          finalize,
          acceptAllCandidates
        })}
      />
    );

    expect(screen.getByText("这次表达里有什么值得带走")).toBeVisible();
    expect(screen.getByRole("heading", { name: "确认明天的安排" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "散步让我更放松" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "还要想清楚的事" })).not.toBeInTheDocument();
    expect(screen.getByText("含 AI 推断，请核对 · 可核对依据较少")).not.toBeVisible();
    expect(screen.queryByText("0.9")).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("Provider");
    expect(container.textContent).not.toContain("Candidate #");
    expect(screen.queryByText("第一段真实原话。")).not.toBeInTheDocument();
    await waitFor(() => expect(onLocalReviewMetric).toHaveBeenCalledWith({
      name: "cards_shown",
      value: 3,
      reflectionId: "reflection-1"
    }));

    fireEvent.click(screen.getByRole("button", { name: /还有 1 条可能有用的内容/u }));
    expect(screen.getByRole("heading", { name: "还要想清楚的事" })).toBeVisible();
    expect(onLocalReviewMetric).toHaveBeenCalledWith({
      name: "more_expanded",
      value: 1,
      reflectionId: "reflection-1",
      tier: "more"
    });
    fireEvent.click(screen.getAllByLabelText("更多选择").at(-1)!);
    fireEvent.click(screen.getByRole("button", { name: "设为重点" }));
    expect(updateCard).toHaveBeenCalledWith(expect.objectContaining({
      cardId: more.id,
      reviewStatus: "pending",
      promoteToPrimary: true
    }));
    expect(onLocalReviewMetric).toHaveBeenCalledWith({
      name: "card_promoted",
      value: 1,
      reflectionId: "reflection-1",
      tier: "more"
    });

    fireEvent.click(screen.getAllByRole("button", { name: "查看来源" })[0]);
    expect(screen.getByText("第一段真实原话。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "在完整文字记录中查看" }));
    await waitFor(() => {
      const source = container.querySelector('[data-segment-id="segment-early"]');
      expect(source).toHaveAttribute("data-highlighted", "true");
    });

    fireEvent.click(screen.getByRole("checkbox", { name: /这是我要做的/u }));
    expect(updateCard).toHaveBeenCalledWith(expect.objectContaining({
      cardId: primaryAction.id,
      actionClaimed: true
    }));
    fireEvent.click(screen.getAllByLabelText("更多选择")[0]);
    expect(screen.getByText("含 AI 推断，请核对 · 可核对依据较少")).toBeVisible();
    fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]);
    fireEvent.change(screen.getByRole("textbox", { name: "编辑标题：确认明天的安排" }), {
      target: { value: "我编辑后的安排" }
    });
    fireEvent.change(screen.getByRole("textbox", { name: "编辑内容：确认明天的安排" }), {
      target: { value: "我编辑后的散步计划。" }
    });
    fireEvent.click(screen.getAllByRole("button", { name: "保存为卡片" })[0]);
    expect(saveWorkingCard).toHaveBeenCalledWith(primaryAction.id, {
      userTitle: "我编辑后的安排",
      userText: "我编辑后的散步计划。"
    });
    expect(finalize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存这些重点为卡片" }));
    await waitFor(() => expect(saveWorkingCard).toHaveBeenCalledWith(primaryInsight.id, {
      userTitle: primaryInsight.userTitle,
      userText: primaryInsight.userText
    }));
    expect(acceptAllCandidates).not.toHaveBeenCalled();
  });

  it("opens and highlights a valid deep-linked Transcript segment", async () => {
    const { container } = render(<DailyReflectionShellContent
      initialReflectionId="reflection-1"
      initialSegmentId="segment-second"
      session={session({
        state: "review_pending",
        reflectionId: "reflection-1",
        detail: detail()
      })}
    />);

    await waitFor(() => {
      const source = container.querySelector('[data-segment-id="segment-second"]');
      expect(source).toHaveAttribute("data-highlighted", "true");
    });
    expect(screen.getByLabelText("完整文字稿")).toBeVisible();
  });

  it.each([
    ["another-reflection", "segment-second"],
    ["reflection-1", "segment-missing"]
  ])("does not focus an invalid Transcript deep link (%s, %s)", async (
    initialReflectionId,
    initialSegmentId
  ) => {
    render(<DailyReflectionShellContent
      initialReflectionId={initialReflectionId}
      initialSegmentId={initialSegmentId}
      session={session({
        state: "review_pending",
        reflectionId: "reflection-1",
        detail: detail()
      })}
    />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "展开 5 段" })).toBeVisible();
    });
    expect(screen.queryByLabelText("完整文字稿")).not.toBeInTheDocument();
  });

  it("offers archive and restore for a saved Card without finalizing", () => {
    const savedCard = card(0, "insight", ["segment-early"]);
    const archiveWorkingCard = vi.fn(async () => undefined);
    const restoreWorkingCard = vi.fn(async () => undefined);
    const removeWorkingCard = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => undefined);
    const base = session({
      state: "review_pending",
      reflectionId: "reflection-1",
      detail: detail({ candidates: [], cards: [savedCard] }),
      workingCardStates: { [savedCard.id]: { status: "saved", version: 1 } },
      archiveWorkingCard,
      restoreWorkingCard,
      removeWorkingCard,
      finalize
    });
    const { rerender } = render(<DailyReflectionShellContent session={base} />);

    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    expect(archiveWorkingCard).toHaveBeenCalledWith(savedCard.id);
    expect(removeWorkingCard).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();

    rerender(<DailyReflectionShellContent session={{
      ...base,
      workingCardStates: { [savedCard.id]: { status: "archived", version: 2 } }
    }} />);
    fireEvent.click(screen.getByRole("button", { name: "恢复卡片" }));
    expect(restoreWorkingCard).toHaveBeenCalledWith(savedCard.id);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("does not invent source or recording date while a recovered record is loading", () => {
    render(<DailyReflectionShellContent initialReflectionId="reflection-1" session={session({
      state: "loading",
      operation: "loading",
      reflectionId: "reflection-1"
    })} />);

    expect(screen.getAllByText("正在读取")).toHaveLength(2);
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
      "/reflection/sessions/reflection-1"
    ));

    rerender(<DailyReflectionShellContent session={session()} />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith(
      "/reflection"
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

    expect(screen.getByRole("button", { name: "开始说" })).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "上传录音" }));
    expect(screen.getByRole("form", { name: "上传日常复盘录音" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "产品空间" })).toHaveTextContent("约会陪伴日常复盘");
    expect(screen.getByText("你在 2026-08-12 的复盘中提到……")).toBeVisible();
    expect(screen.getByText("记住 1 · 未保存 1")).toBeVisible();
    expect(screen.queryByText("林澄")).not.toBeInTheDocument();
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
      revokeCandidate
    })} />);

    expect(screen.getByText("在 2026-08-13 的交流中提到……")).toBeVisible();
    expect(screen.getByText("已经记住")).toBeVisible();
    expect(screen.getByText("你选择不保存")).toBeVisible();
    expect(screen.queryByText(/关联人物/u)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "撤销保存" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "撤销保存" }));
    expect(screen.getByRole("alertdialog", { name: "只撤销这一条保存？" })).toHaveTextContent(
      "不会修改原始复盘文字，也不会删除整次复盘"
    );
    expect(screen.getByRole("button", { name: "删除原始记录" })).not.toBeVisible();
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

    fireEvent.click(screen.getByRole("button", { name: "删除原始记录" }));
    expect(deleteReflection).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "删除这次复盘和原始记录？" })).toBeVisible();
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
    expect(css).toMatch(/\.finalizeActions\s*\{[^}]*flex-direction:\s*column;/u);
    expect(css).toMatch(/\.candidateActions button\s*\{[^}]*min-height:\s*46px;/u);
    expect(css).toMatch(/\.manualCandidateForm > \.primaryButton\s*\{[^}]*min-height:\s*46px;/u);
    expect(css).toMatch(/\.revocationConfirmation > div:last-child\s*\{[^}]*flex-direction:\s*column;/u);
  });
});
