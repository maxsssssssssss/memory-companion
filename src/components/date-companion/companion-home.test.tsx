import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RecapItemVM } from "@/lib/domain/date-companion";
import {
  createEmptyToySyncState,
  type ToySyncDirectoryHandle,
  type ToySyncFileHandle,
  type ToySyncState
} from "@/lib/client/daily-reflection-toy-sync";
import type {
  ToySyncRuntime,
  ToySyncPermissionDirectoryHandle,
  ToySyncPermissionState
} from "@/lib/client/daily-reflection-toy-sync-storage";
import type { DateCompanionUploadOptions } from "@/lib/client/date-companion-session";

import { CompanionHome, type CompanionUploadPresentation } from "./companion-home";

function toyRuntimeFixture(options: { oversized?: boolean; filename?: string } = {}) {
  const filename = options.filename ?? "toy-date.wav";
  const audioHandle: ToySyncFileHandle = {
    kind: "file",
    name: filename,
    async getFile() {
      const file = new File(["toy audio"], filename, {
        type: "audio/wav",
        lastModified: Date.parse("2026-08-14T10:30:00.000Z")
      });
      if (options.oversized) {
        Object.defineProperty(file, "size", { value: 300 * 1024 * 1024 + 1 });
      }
      return file;
    }
  };
  const handle: ToySyncPermissionDirectoryHandle = {
    kind: "directory",
    name: "recordings",
    async *entries() {
      yield [filename, audioHandle] as [string, ToySyncFileHandle | ToySyncDirectoryHandle];
    }
  };
  let storedHandle: ToySyncPermissionDirectoryHandle | null = null;
  let state: ToySyncState = createEmptyToySyncState();
  const runtime: ToySyncRuntime = {
    isSupported: vi.fn(() => true),
    pickDirectory: vi.fn(async () => handle),
    queryPermission: vi.fn(async (): Promise<ToySyncPermissionState> => "granted"),
    requestPermission: vi.fn(async (): Promise<ToySyncPermissionState> => "granted"),
    persistence: {
      loadDirectory: vi.fn(async () => storedHandle),
      saveDirectory: vi.fn(async (_accountId, nextHandle) => {
        storedHandle = nextHandle;
      }),
      clearDirectory: vi.fn(async () => {
        storedHandle = null;
      }),
      loadState: vi.fn(async () => state),
      saveState: vi.fn(async (_accountId, nextState) => {
        state = nextState;
      })
    }
  };
  return { handle, runtime, getState: () => state };
}

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
      onUpload={vi.fn(async () => true)}
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
        onUpload={vi.fn(async () => true)}
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
    const onUpload = vi.fn().mockResolvedValue(true);
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
    const manualDateInput = screen.getByLabelText("这次相处发生在");
    expect(manualDateInput).toBeEnabled();
    fireEvent.change(manualDateInput, { target: { value: "2026-08-12" } });

    const submit = screen.getByRole("button", { name: "开始上传" });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));
    expect(onUpload.mock.calls[0]?.[0]).toBe(nextFile);
    expect(onUpload.mock.calls[0]?.[1]).toBe("2026-08-12");
    expect(onUpload.mock.calls[0]?.[2]).toBeUndefined();
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

  it("automatically uses the Toy recording date while reserving the date picker for manual files", async () => {
    const fixture = toyRuntimeFixture();
    let resolveUpload!: (receiptReceived: boolean) => void;
    const onUpload = vi.fn(async (
      _file: File,
      _recordingDate: string,
      options?: DateCompanionUploadOptions
    ) => {
      await options?.onServerAccepted?.({
        uploadId: "upload_1",
        jobId: "job_1",
        status: "uploaded"
      });
      return new Promise<boolean>((resolve) => {
        resolveUpload = resolve;
      });
    });
    render(
      <CompanionHome
        accountId="account-1"
        currentInteraction={null}
        onRetryRead={vi.fn()}
        onUpload={onUpload}
        relationshipId="relationship_1"
        toySyncEnabled
        toySyncRuntime={fixture.runtime}
        uploadState={{ status: "idle" }}
      />
    );

    fireEvent.click(screen.getByText("上传这次相处的录音").closest("summary")!);
    const connect = await screen.findByRole("button", { name: "连接玩偶" });
    expect(fixture.runtime.pickDirectory).not.toHaveBeenCalled();
    fireEvent.click(connect);

    const toyFilename = await screen.findByText("toy-date.wav");
    const toyCard = toyFilename.closest("li")!;
    fireEvent.click(screen.getByRole("button", { name: "选择这条录音" }));

    expect(onUpload).not.toHaveBeenCalled();
    expect(screen.getByText("已从玩偶带入 · 录音日期已自动填写")).toBeInTheDocument();
    expect(screen.getByText("2026-08-14")).toBeInTheDocument();
    expect(screen.queryByLabelText("这次相处发生在")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始上传" }));

    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));
    expect(onUpload.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ name: "toy-date.wav" })
    );
    expect(onUpload.mock.calls[0]?.[1]).toBe("2026-08-14");
    expect(onUpload.mock.calls[0]?.[2]?.onServerAccepted).toEqual(expect.any(Function));
    expect(onUpload.mock.calls[0]?.[2]?.toyOperation).toEqual(expect.objectContaining({
      destination: "date_companion",
      relationshipId: "relationship_1",
      operationKey: expect.stringMatching(/^toyop_v1_[a-f0-9]{64}$/u)
    }));
    const savedStates = vi.mocked(fixture.runtime.persistence.saveState).mock.calls
      .map((call) => call[1]);
    const stateBeforeNetwork = [...savedStates].reverse()
      .find((state) => state.records.some((record) => record.status === "uploading"));
    expect(stateBeforeNetwork?.records[0]).toMatchObject({
      status: "uploading",
      operationKey: onUpload.mock.calls[0]?.[2]?.toyOperation?.operationKey,
      relationshipId: "relationship_1"
    });
    expect(await screen.findByText("录音已收到")).toBeInTheDocument();
    expect(screen.getByText("已从玩偶带入 · 录音日期已自动填写")).toBeInTheDocument();
    expect(fixture.runtime.persistence.loadState).toHaveBeenCalledWith(
      "account-1",
      "date_companion"
    );
    expect(fixture.runtime.persistence.saveState).toHaveBeenCalledWith(
      "account-1",
      expect.anything(),
      "date_companion"
    );
    expect(within(toyCard).queryByRole("button", { name: "选择这条录音" })).not.toBeInTheDocument();
    await act(async () => resolveUpload(true));
    await waitFor(() => expect(
      screen.queryByText("已从玩偶带入 · 录音日期已自动填写")
    ).not.toBeInTheDocument());
    expect(screen.getByLabelText(/选择一段完整录音/u)).toBeInTheDocument();
    expect(screen.getByLabelText("这次相处发生在")).toBeInTheDocument();
  });

  it("rejects an oversized toy file through the same client gate without beginning upload", async () => {
    const fixture = toyRuntimeFixture({ oversized: true });
    const onUpload = vi.fn(async () => true);
    render(
      <CompanionHome
        accountId="account-1"
        currentInteraction={null}
        onRetryRead={vi.fn()}
        onUpload={onUpload}
        relationshipId="relationship_1"
        toySyncEnabled
        toySyncRuntime={fixture.runtime}
        uploadState={{ status: "idle" }}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "连接玩偶" }));
    fireEvent.click(await screen.findByRole("button", { name: "选择这条录音" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("文件超过 300MB");
    expect(screen.queryByText("已从玩偶带入 · 录音日期已自动填写")).not.toBeInTheDocument();
    expect(onUpload).not.toHaveBeenCalled();
    const savedStates = vi.mocked(fixture.runtime.persistence.saveState).mock.calls;
    expect(savedStates.at(-1)?.[1].records).toEqual([
      expect.objectContaining({ filename: "toy-date.wav", status: "new" })
    ]);
  });

  it("locks the confirmed Toy date after a pre-receipt failure and reuses it on retry", async () => {
    const fixture = toyRuntimeFixture();
    const onUpload = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    render(
      <CompanionHome
        accountId="account-1"
        currentInteraction={null}
        onRetryRead={vi.fn()}
        onUpload={onUpload}
        relationshipId="relationship_1"
        toySyncEnabled
        toySyncRuntime={fixture.runtime}
        uploadState={{ status: "idle" }}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "连接玩偶" }));
    fireEvent.click(await screen.findByRole("button", { name: "选择这条录音" }));
    expect(screen.queryByLabelText("这次相处发生在")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始上传" }));

    expect(await screen.findByText("这条录音正在重试，将沿用第一次上传时记录的录音日期。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始上传" }));

    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
    expect(onUpload.mock.calls[0]?.[1]).toBe("2026-08-14");
    expect(onUpload.mock.calls[1]?.[1]).toBe("2026-08-14");
    expect(onUpload.mock.calls[0]?.[2]?.toyOperation?.operationKey)
      .toBe(onUpload.mock.calls[1]?.[2]?.toyOperation?.operationKey);
    expect(await screen.findByText("录音已收到")).toBeInTheDocument();
  });

});
