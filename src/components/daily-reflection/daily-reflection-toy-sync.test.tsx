// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TOY_SYNC_DESTINATION,
  createEmptyToySyncState,
  type ToySyncDestination,
  type ToySyncDirectoryHandle,
  type ToySyncFileHandle,
  type ToySyncState
} from "@/lib/client/daily-reflection-toy-sync";
import type {
  DailyReflectionToySyncPersistence,
  ToySyncRuntime,
  ToySyncPermissionDirectoryHandle,
  ToySyncPermissionState
} from "@/lib/client/daily-reflection-toy-sync-storage";
import type { ToyIngestionReceipt } from "@/lib/domain/date-companion";

import {
  DailyReflectionToySync,
  ToyAudioSync,
  type ToySyncSelection,
  type ToySyncUploadAttempt
} from "./daily-reflection-toy-sync";

function fileHandle(
  name: string,
  lastModified: number
): ToySyncFileHandle {
  return {
    kind: "file",
    name,
    async getFile() {
      return new File([`audio-${name}`], name, {
        type: "audio/wav",
        lastModified
      });
    }
  };
}

function directoryHandle(): ToySyncPermissionDirectoryHandle {
  const entries: Array<[string, ToySyncFileHandle | ToySyncDirectoryHandle]> = [
    ["older.wav", fileHandle("older.wav", Date.parse("2026-08-16T08:00:00.000Z"))],
    ["latest.wav", fileHandle("latest.wav", Date.parse("2026-08-17T09:30:00.000Z"))]
  ];
  return {
    kind: "directory",
    name: "recordings",
    async *entries() {
      for (const entry of entries) yield entry;
    },
    async queryPermission() {
      return "granted";
    },
    async requestPermission() {
      return "granted";
    }
  };
}

function singleRecordingDirectoryHandle(
  directoryName: string,
  filename: string,
  lastModified: number
): ToySyncPermissionDirectoryHandle {
  return {
    kind: "directory",
    name: directoryName,
    async *entries() {
      yield [filename, fileHandle(filename, lastModified)] as [
        string,
        ToySyncFileHandle | ToySyncDirectoryHandle
      ];
    }
  };
}

function directoryHandleWithPartialManifest(): ToySyncPermissionDirectoryHandle {
  const base = directoryHandle();
  const manifest: ToySyncFileHandle = {
    kind: "file",
    name: "manifest.json",
    async getFile() {
      return new File([JSON.stringify({
        recordings: [{
          filename: "older.wav",
          created_at: "2026-08-16T08:00:00.000Z"
        }]
      })], "manifest.json", { type: "application/json" });
    }
  };
  return {
    ...base,
    async *entries() {
      yield ["manifest.json", manifest];
      for await (const entry of base.entries()) yield entry;
    }
  };
}

function runtimeFixture(options: {
  supported?: boolean;
  storedHandle?: ToySyncPermissionDirectoryHandle | null;
  permission?: "granted" | "prompt" | "denied";
  requestedPermission?: "granted" | "prompt" | "denied";
  selectedHandle?: ToySyncPermissionDirectoryHandle;
} = {}) {
  const storedHandles = new Map<string, ToySyncPermissionDirectoryHandle>();
  const storedStates = new Map<string, ToySyncState>();
  const stateKey = (
    accountId: string,
    destination: ToySyncDestination = DEFAULT_TOY_SYNC_DESTINATION
  ) => `${accountId}:${destination}`;
  if (options.storedHandle) storedHandles.set("account-1", options.storedHandle);
  const persistence: DailyReflectionToySyncPersistence = {
    loadDirectory: vi.fn(async (accountId) => storedHandles.get(accountId) ?? null),
    saveDirectory: vi.fn(async (accountId, handle) => {
      storedHandles.set(accountId, handle);
    }),
    clearDirectory: vi.fn(async (accountId) => {
      storedHandles.delete(accountId);
    }),
    loadState: vi.fn(async (accountId, destination) => (
      storedStates.get(stateKey(accountId, destination)) ?? createEmptyToySyncState()
    )),
    saveState: vi.fn(async (accountId, state, destination) => {
      storedStates.set(stateKey(accountId, destination), state);
    })
  };
  const handle = options.selectedHandle ?? directoryHandle();
  const runtime: ToySyncRuntime = {
    isSupported: vi.fn(() => options.supported ?? true),
    pickDirectory: vi.fn(async () => handle),
    queryPermission: vi.fn(async (): Promise<ToySyncPermissionState> => (
      options.permission ?? "granted"
    )),
    requestPermission: vi.fn(async (): Promise<ToySyncPermissionState> => (
      options.requestedPermission ?? "granted"
    )),
    persistence
  };
  return {
    runtime,
    handle,
    getState: (
      accountId = "account-1",
      destination: ToySyncDestination = DEFAULT_TOY_SYNC_DESTINATION
    ) => storedStates.get(stateKey(accountId, destination)) ?? createEmptyToySyncState()
  };
}

describe("DailyReflectionToySync", () => {
  it("connects on a user gesture, finds the newest recording, allows a date edit, and uploads once", async () => {
    const fixture = runtimeFixture();
    const onUpload = vi.fn(async (
      _file: File,
      _recordingDate: string,
      _idempotencyKey: string
    ) => true);
    render(
      <DailyReflectionToySync
        accountId="account-1"
        onUpload={onUpload}
        runtime={fixture.runtime}
      />
    );

    const connect = await screen.findByRole("button", { name: "连接玩偶" });
    expect(fixture.runtime.pickDirectory).not.toHaveBeenCalled();
    fireEvent.click(connect);

    expect(await screen.findByText("已连接玩偶")).toBeInTheDocument();
    expect(screen.getByText("发现 2 条录音")).toBeInTheDocument();
    const latestCard = screen.getByText("latest.wav").closest("li");
    expect(latestCard).not.toBeNull();
    expect(within(latestCard!).getByText("最新录音")).toBeInTheDocument();
    expect(within(latestCard!).getByText(/录音日期：/u)).toBeInTheDocument();
    expect(within(latestCard!).queryByText(/MB$/u)).not.toBeInTheDocument();

    fireEvent.click(within(latestCard!).getByRole("button", { name: "修改日期" }));
    fireEvent.change(within(latestCard!).getByLabelText("latest.wav 的录音日期"), {
      target: { value: "2026-08-15" }
    });
    fireEvent.click(within(latestCard!).getByRole("button", { name: "确认日期" }));
    fireEvent.click(within(latestCard!).getByRole("button", { name: "作为我的复盘上传" }));

    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));
    expect(onUpload.mock.calls[0]?.[0]).toBeInstanceOf(File);
    expect(onUpload.mock.calls[0]?.[1]).toBe("2026-08-15");
    expect(onUpload.mock.calls[0]?.[2]).toMatch(/^daily-reflection-toy-v1-[a-f0-9]{64}$/u);
    expect(await within(latestCard!).findByText("录音已收到")).toBeInTheDocument();
    expect(fixture.runtime.pickDirectory).toHaveBeenCalledTimes(1);
  });

  it("restores a previously authorized directory without opening the picker", async () => {
    const handle = directoryHandle();
    const fixture = runtimeFixture({ storedHandle: handle, permission: "granted" });
    render(
      <DailyReflectionToySync
        accountId="account-1"
        onUpload={vi.fn(async () => true)}
        runtime={fixture.runtime}
      />
    );

    expect(await screen.findByText("已连接玩偶")).toBeInTheDocument();
    expect(fixture.runtime.queryPermission).toHaveBeenCalledWith(handle);
    expect(fixture.runtime.pickDirectory).not.toHaveBeenCalled();
  });

  it("lets the user replace the connected recording folder from a small action", async () => {
    const initialHandle = directoryHandle();
    const replacementHandle = singleRecordingDirectoryHandle(
      "replacement-recordings",
      "replacement.wav",
      Date.parse("2026-08-18T09:00:00.000Z")
    );
    const fixture = runtimeFixture({ storedHandle: initialHandle, permission: "granted" });
    vi.mocked(fixture.runtime.pickDirectory).mockResolvedValueOnce(replacementHandle);
    render(
      <DailyReflectionToySync
        accountId="account-1"
        onUpload={vi.fn(async () => true)}
        runtime={fixture.runtime}
      />
    );

    expect(await screen.findByText("latest.wav")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新选择文件夹" }));

    expect(await screen.findByText("replacement.wav")).toBeInTheDocument();
    expect(screen.queryByText("latest.wav")).not.toBeInTheDocument();
    expect(fixture.runtime.persistence.saveDirectory).toHaveBeenCalledWith(
      "account-1",
      replacementHandle
    );
  });

  it("keeps the current recording folder when replacement selection is cancelled", async () => {
    const initialHandle = directoryHandle();
    const fixture = runtimeFixture({ storedHandle: initialHandle, permission: "granted" });
    vi.mocked(fixture.runtime.pickDirectory).mockRejectedValueOnce(
      new DOMException("picker cancelled", "AbortError")
    );
    render(
      <DailyReflectionToySync
        accountId="account-1"
        onUpload={vi.fn(async () => true)}
        runtime={fixture.runtime}
      />
    );

    expect(await screen.findByText("latest.wav")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新选择文件夹" }));

    expect(await screen.findByText("已连接玩偶")).toBeInTheDocument();
    expect(screen.getByText("latest.wav")).toBeInTheDocument();
    expect(fixture.runtime.persistence.saveDirectory).not.toHaveBeenCalled();
  });

  it("serializes rapid upload clicks across different recordings", async () => {
    const fixture = runtimeFixture();
    let finishUpload: ((value: boolean) => void) | null = null;
    const onUpload = vi.fn((
      _file: File,
      _recordingDate: string,
      _idempotencyKey: string
    ) => new Promise<boolean>((resolve) => {
      finishUpload = resolve;
    }));
    render(
      <DailyReflectionToySync
        accountId="account-1"
        onUpload={onUpload}
        runtime={fixture.runtime}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: "连接玩偶" }));
    await screen.findByText("已连接玩偶");

    const latestCard = screen.getByText("latest.wav").closest("li")!;
    const olderCard = screen.getByText("older.wav").closest("li")!;
    fireEvent.click(within(latestCard).getByRole("button", { name: "作为我的复盘上传" }));
    fireEvent.click(within(olderCard).getByRole("button", { name: "作为我的复盘上传" }));

    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));
    expect(onUpload.mock.calls[0]?.[0].name).toBe("latest.wav");
    await act(async () => {
      finishUpload?.(true);
    });
    expect(await within(latestCard).findByText("录音已收到")).toBeInTheDocument();
  });

  it("keeps ignored recordings out of upload and retries a failed upload with the same key and date", async () => {
    const fixture = runtimeFixture();
    const onUpload = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    render(
      <DailyReflectionToySync
        accountId="account-1"
        onUpload={onUpload}
        runtime={fixture.runtime}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: "连接玩偶" }));
    await screen.findByText("已连接玩偶");

    const olderCard = screen.getByText("older.wav").closest("li")!;
    fireEvent.click(within(olderCard).getByRole("button", { name: "忽略" }));
    expect(await within(olderCard).findByText("已忽略")).toBeInTheDocument();

    const latestCard = screen.getByText("latest.wav").closest("li")!;
    fireEvent.click(within(latestCard).getByRole("button", { name: "作为我的复盘上传" }));
    expect(await within(latestCard).findByText("上传没有完成，请重试。")).toBeInTheDocument();
    fireEvent.click(within(latestCard).getByRole("button", { name: "重试上传" }));

    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
    expect(onUpload.mock.calls[0]?.[1]).toBe(onUpload.mock.calls[1]?.[1]);
    expect(onUpload.mock.calls[0]?.[2]).toBe(onUpload.mock.calls[1]?.[2]);
    expect(await within(latestCard).findByText("录音已收到")).toBeInTheDocument();
    expect(onUpload).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "older.wav" }),
      expect.anything(),
      expect.anything()
    );
  });

  it("shows a safe compatibility message and leaves directory selection untouched", async () => {
    const fixture = runtimeFixture({ supported: false });
    render(
      <DailyReflectionToySync
        accountId="account-1"
        onUpload={vi.fn(async () => true)}
        runtime={fixture.runtime}
      />
    );

    expect(await screen.findByText("当前浏览器暂不支持连接玩偶。")).toBeInTheDocument();
    expect(screen.getByText(/上传已有录音/u)).toBeInTheDocument();
    expect(fixture.runtime.pickDirectory).not.toHaveBeenCalled();
  });

  it("requests a stored prompt permission only after the user clicks reconnect", async () => {
    const handle = directoryHandle();
    const fixture = runtimeFixture({ storedHandle: handle, permission: "prompt" });
    render(
      <DailyReflectionToySync
        accountId="account-1"
        onUpload={vi.fn(async () => true)}
        runtime={fixture.runtime}
      />
    );

    const reconnect = await screen.findByRole("button", { name: "重新连接玩偶" });
    expect(fixture.runtime.requestPermission).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(reconnect));
    expect(fixture.runtime.requestPermission).toHaveBeenCalledWith(handle);
    expect(await screen.findByText("已连接玩偶")).toBeInTheDocument();
  });

  it("clears a denied stored handle and opens the picker only on the next user click", async () => {
    const handle = directoryHandle();
    const fixture = runtimeFixture({
      storedHandle: handle,
      permission: "prompt",
      requestedPermission: "denied"
    });
    render(
      <DailyReflectionToySync
        accountId="account-1"
        onUpload={vi.fn(async () => true)}
        runtime={fixture.runtime}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "重新连接玩偶" }));
    expect(await screen.findByText("请再次点击连接，并重新选择玩偶录音文件夹。")).toBeInTheDocument();
    expect(fixture.runtime.persistence.clearDirectory).toHaveBeenCalledWith("account-1");
    expect(fixture.runtime.pickDirectory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "连接玩偶" }));
    expect(await screen.findByText("已连接玩偶")).toBeInTheDocument();
    expect(fixture.runtime.pickDirectory).toHaveBeenCalledTimes(1);
  });

  it("does not reuse another account's restored handle when the account changes", async () => {
    const handle = directoryHandle();
    const fixture = runtimeFixture({ storedHandle: handle, permission: "prompt" });
    const { rerender } = render(
      <DailyReflectionToySync
        accountId="account-1"
        onUpload={vi.fn(async () => true)}
        runtime={fixture.runtime}
      />
    );
    expect(await screen.findByRole("button", { name: "重新连接玩偶" })).toBeInTheDocument();

    rerender(
      <DailyReflectionToySync
        accountId="account-2"
        onUpload={vi.fn(async () => true)}
        runtime={fixture.runtime}
      />
    );
    const connect = await screen.findByRole("button", { name: "连接玩偶" });
    fireEvent.click(connect);

    expect(await screen.findByText("已连接玩偶")).toBeInTheDocument();
    expect(fixture.runtime.requestPermission).not.toHaveBeenCalled();
    expect(fixture.runtime.persistence.loadDirectory).toHaveBeenCalledWith("account-2");
    expect(fixture.runtime.persistence.saveDirectory).toHaveBeenCalledWith("account-2", fixture.handle);
  });

  it("warns when a valid manifest does not provide reliable time for every recording", async () => {
    const fixture = runtimeFixture({ selectedHandle: directoryHandleWithPartialManifest() });
    render(
      <DailyReflectionToySync
        accountId="account-1"
        onUpload={vi.fn(async () => true)}
        runtime={fixture.runtime}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "连接玩偶" }));
    expect(await screen.findByText(/复制或移动录音可能改变它/u)).toBeInTheDocument();
  });

  it("shows immediate picker feedback after the click while the chooser is opening", async () => {
    const fixture = runtimeFixture();
    let resolvePicker!: (handle: ToySyncPermissionDirectoryHandle) => void;
    fixture.runtime.pickDirectory = vi.fn(() => new Promise<ToySyncPermissionDirectoryHandle>((resolve) => {
      resolvePicker = resolve;
    }));
    render(
      <DailyReflectionToySync
        accountId="account-1"
        onUpload={vi.fn(async () => true)}
        runtime={fixture.runtime}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "连接玩偶" }));
    expect(await screen.findByText("正在打开文件夹选择器…")).toBeInTheDocument();
    expect(screen.getByText(/最新版 Chrome 或 Edge/u)).toBeInTheDocument();
    expect(fixture.runtime.pickDirectory).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.persistence.loadState).toHaveBeenCalledWith(
      "account-1",
      "daily_reflection"
    );

    resolvePicker(fixture.handle);
    expect(await screen.findByText("已连接玩偶")).toBeInTheDocument();
  });

  it("selects for Date Companion without uploading or inferring identity, then records the form outcome", async () => {
    const fixture = runtimeFixture();
    const onSelect = vi.fn<(selection: ToySyncSelection) => void>();
    render(
      <ToyAudioSync
        accountId="account-1"
        destination="date_companion"
        mode="select"
        onSelect={onSelect}
        relationshipId="relationship_1"
        runtime={fixture.runtime}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "连接玩偶" }));
    const latestCard = (await screen.findByText("latest.wav")).closest("li")!;
    fireEvent.click(within(latestCard).getByRole("button", { name: "选择这条录音" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    const selection = onSelect.mock.calls[0]![0];
    expect(selection).toMatchObject({
      filename: "latest.wav",
      recordingDate: "2026-08-17",
      recordingDateLocked: false
    });
    expect(selection).not.toHaveProperty("personId");
    expect(selection).not.toHaveProperty("speakerId");
    expect(fixture.runtime.persistence.loadState).toHaveBeenCalledWith(
      "account-1",
      "date_companion"
    );
    expect(fixture.getState("account-1", "daily_reflection").records).toHaveLength(0);

    let attempt: ToySyncUploadAttempt | null = null;
    await act(async () => {
      attempt = await selection.beginUpload("2026-08-15");
    });
    expect(attempt!.operation).toEqual(expect.objectContaining({
      destination: "date_companion",
      relationshipId: "relationship_1",
      operationKey: expect.stringMatching(/^toyop_v1_[a-f0-9]{64}$/u)
    }));
    expect(await within(latestCard).findByText("正在上传…")).toBeInTheDocument();
    await act(async () => {
      await attempt!.finish(true);
    });
    expect(await within(latestCard).findByText("录音已收到")).toBeInTheDocument();
    expect(fixture.getState("account-1", "date_companion").records).toEqual(
      expect.arrayContaining([expect.objectContaining({
        filename: "latest.wav",
        recordingDate: "2026-08-15",
        status: "uploaded"
      })])
    );
  });

  it("retries the same accepted Toy outcome after its first local state save fails", async () => {
    const fixture = runtimeFixture();
    const onSelect = vi.fn<(selection: ToySyncSelection) => void>();
    render(
      <ToyAudioSync
        accountId="account-1"
        destination="date_companion"
        mode="select"
        onSelect={onSelect}
        relationshipId="relationship_1"
        runtime={fixture.runtime}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "连接玩偶" }));
    const latestCard = (await screen.findByText("latest.wav")).closest("li")!;
    fireEvent.click(within(latestCard).getByRole("button", { name: "选择这条录音" }));
    const selection = onSelect.mock.calls[0]![0];

    let attempt: ToySyncUploadAttempt | null = null;
    await act(async () => {
      attempt = await selection.beginUpload("2026-08-15");
    });
    expect(await within(latestCard).findByText("正在上传…")).toBeInTheDocument();

    vi.mocked(fixture.runtime.persistence.saveState)
      .mockRejectedValueOnce(new Error("transient indexed db failure"));
    await expect(attempt!.finish(true)).rejects.toThrow("transient indexed db failure");
    expect(within(latestCard).getByText("正在上传…")).toBeInTheDocument();

    await act(async () => {
      await attempt!.finish(true);
    });
    expect(await within(latestCard).findByText("录音已收到")).toBeInTheDocument();
    expect(fixture.getState("account-1", "date_companion").records).toEqual(
      expect.arrayContaining([expect.objectContaining({
        filename: "latest.wav",
        recordingDate: "2026-08-15",
        status: "uploaded"
      })])
    );
  });

  it("shows received versus completed receipt states", async () => {
    const fixture = runtimeFixture();
    const onSelect = vi.fn<(selection: ToySyncSelection) => void>();
    render(
      <ToyAudioSync
        accountId="account-1"
        destination="date_companion"
        mode="select"
        onSelect={onSelect}
        relationshipId="relationship_1"
        runtime={fixture.runtime}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: "连接玩偶" }));
    const latestCard = (await screen.findByText("latest.wav")).closest("li")!;
    fireEvent.click(within(latestCard).getByRole("button", { name: "选择这条录音" }));
    const selection = onSelect.mock.calls[0]![0];
    let attempt: ToySyncUploadAttempt | null = null;
    await act(async () => {
      attempt = await selection.beginUpload("2026-08-15");
    });
    const baseReceipt: ToyIngestionReceipt = {
      receiptId: "receipt_1",
      operationKey: attempt!.operation!.operationKey,
      destination: "date_companion",
      relationshipId: "relationship_1",
      uploadId: "upload_1",
      jobId: "job_1",
      state: "accepted",
      decision: "accepted",
      recordingDate: "2026-08-15",
      serverAcceptedAt: "2026-08-19T08:00:00.000Z"
    };
    await act(async () => {
      await attempt!.acceptReceipt(baseReceipt);
    });
    expect(await within(latestCard).findByText("录音已收到，正在整理")).toBeInTheDocument();

    await act(async () => {
      await attempt!.acceptReceipt({
        ...baseReceipt,
        state: "completed",
        completedAt: "2026-08-19T08:05:00.000Z"
      });
    });
    expect(await within(latestCard).findByText("整理完成")).toBeInTheDocument();
  });

  it("keeps a pre-accept failed receipt retryable instead of marking audio received", async () => {
    const fixture = runtimeFixture();
    const onSelect = vi.fn<(selection: ToySyncSelection) => void>();
    render(
      <ToyAudioSync
        accountId="account-1"
        destination="date_companion"
        mode="select"
        onSelect={onSelect}
        relationshipId="relationship_1"
        runtime={fixture.runtime}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: "连接玩偶" }));
    const latestCard = (await screen.findByText("latest.wav")).closest("li")!;
    fireEvent.click(within(latestCard).getByRole("button", { name: "选择这条录音" }));
    const selection = onSelect.mock.calls[0]![0];
    let attempt: ToySyncUploadAttempt | null = null;
    await act(async () => {
      attempt = await selection.beginUpload("2026-08-15");
    });
    const operation = attempt!.operation!;
    const preAcceptFailed: ToyIngestionReceipt = {
      receiptId: "receipt_preaccept_failed",
      ...operation,
      uploadId: "upload_preaccept_failed",
      jobId: "job_preaccept_failed",
      state: "failed",
      decision: "accepted",
      recordingDate: "2026-08-15",
      failedAt: "2026-08-19T08:01:00.000Z"
    };

    await act(async () => {
      expect(await attempt!.acceptReceipt(preAcceptFailed)).toBe(false);
      await attempt!.finish(false);
    });

    expect(await within(latestCard).findByText("上传没有完成，可以重试。")).toBeInTheDocument();
    expect(within(latestCard).queryByText(/录音已收到/u)).not.toBeInTheDocument();
    expect(fixture.getState("account-1", "date_companion").records).toEqual(
      expect.arrayContaining([expect.objectContaining({
        operationKey: operation.operationKey,
        receiptStatus: "failed",
        status: "failed"
      })])
    );

    fireEvent.click(within(latestCard).getByRole("button", { name: "选择这条录音" }));
    let retryAttempt: ToySyncUploadAttempt | null = null;
    await act(async () => {
      retryAttempt = await onSelect.mock.calls[1]![0].beginUpload("2026-08-15");
    });
    expect(retryAttempt!.operation?.operationKey).toBe(operation.operationKey);
  });

  it("restores a response-lost operation from receipt lookup without selecting or posting again", async () => {
    const fixture = runtimeFixture();
    const onSelect = vi.fn<(selection: ToySyncSelection) => void>();
    const first = render(
      <ToyAudioSync
        accountId="account-1"
        destination="date_companion"
        mode="select"
        onSelect={onSelect}
        relationshipId="relationship_1"
        runtime={fixture.runtime}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: "连接玩偶" }));
    const latestCard = (await screen.findByText("latest.wav")).closest("li")!;
    fireEvent.click(within(latestCard).getByRole("button", { name: "选择这条录音" }));
    const selection = onSelect.mock.calls[0]![0];
    let attempt: ToySyncUploadAttempt | null = null;
    await act(async () => {
      attempt = await selection.beginUpload("2026-08-15");
    });
    const operation = attempt!.operation!;
    expect(fixture.getState("account-1", "date_companion").records).toEqual(
      expect.arrayContaining([expect.objectContaining({
        operationKey: operation.operationKey,
        relationshipId: "relationship_1",
        status: "uploading"
      })])
    );
    // Closing immediately after the click leaves only the durable operation
    // anchor; no local finish callback or second file POST is required.
    first.unmount();
    await fixture.runtime.persistence.clearDirectory("account-1");
    const onResolveReceipt = vi.fn(async () => ({
      receiptId: "receipt_recovered",
      operationKey: operation.operationKey,
      destination: "date_companion" as const,
      relationshipId: operation.relationshipId,
      uploadId: "upload_recovered",
      jobId: "job_recovered",
      state: "accepted" as const,
      decision: "accepted" as const,
      recordingDate: "2026-08-15",
      serverAcceptedAt: "2026-08-19T08:00:00.000Z"
    }));

    render(
      <ToyAudioSync
        accountId="account-1"
        destination="date_companion"
        mode="select"
        onResolveReceipt={onResolveReceipt}
        onSelect={onSelect}
        relationshipId="relationship_1"
        runtime={fixture.runtime}
      />
    );

    expect(await screen.findByRole("button", { name: "连接玩偶" })).toBeInTheDocument();
    await waitFor(() => expect(fixture.getState("account-1", "date_companion").records)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        operationKey: operation.operationKey,
        receiptId: "receipt_recovered",
        status: "uploaded"
      })])));
    expect(onResolveReceipt).toHaveBeenCalledWith(operation);
  });

  it("ignores a late receipt after the relationship scope changes", async () => {
    const fixture = runtimeFixture();
    const onSelect = vi.fn<(selection: ToySyncSelection) => void>();
    const first = render(
      <ToyAudioSync
        accountId="account-1"
        destination="date_companion"
        mode="select"
        onSelect={onSelect}
        relationshipId="relationship_1"
        runtime={fixture.runtime}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: "连接玩偶" }));
    const latestCard = (await screen.findByText("latest.wav")).closest("li")!;
    fireEvent.click(within(latestCard).getByRole("button", { name: "选择这条录音" }));
    let attempt: ToySyncUploadAttempt | null = null;
    await act(async () => {
      attempt = await onSelect.mock.calls[0]![0].beginUpload("2026-08-15");
    });
    const operation = attempt!.operation!;
    first.unmount();

    let resolveLookup!: (receipt: ToyIngestionReceipt | null) => void;
    const onResolveReceipt = vi.fn(() => new Promise<ToyIngestionReceipt | null>((resolve) => {
      resolveLookup = resolve;
    }));
    const second = render(
      <ToyAudioSync
        accountId="account-1"
        destination="date_companion"
        mode="select"
        onResolveReceipt={onResolveReceipt}
        onSelect={onSelect}
        relationshipId="relationship_1"
        runtime={fixture.runtime}
      />
    );
    await waitFor(() => expect(onResolveReceipt).toHaveBeenCalledWith(operation));

    second.rerender(
      <ToyAudioSync
        accountId="account-1"
        destination="date_companion"
        mode="select"
        onResolveReceipt={onResolveReceipt}
        onSelect={onSelect}
        relationshipId="relationship_2"
        runtime={fixture.runtime}
      />
    );
    await screen.findByText("latest.wav");
    await waitFor(() => expect(fixture.getState("account-1", "date_companion").records)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        relationshipId: "relationship_2",
        status: "new"
      })])));
    const savesBeforeLateReceipt = vi.mocked(fixture.runtime.persistence.saveState).mock.calls.length;

    await act(async () => {
      resolveLookup({
        receiptId: "receipt_late",
        operationKey: operation.operationKey,
        destination: "date_companion",
        relationshipId: operation.relationshipId,
        uploadId: "upload_late",
        jobId: "job_late",
        state: "accepted",
        decision: "accepted",
        recordingDate: "2026-08-15",
        serverAcceptedAt: "2026-08-20T08:00:00.000Z"
      });
      await Promise.resolve();
    });

    expect(vi.mocked(fixture.runtime.persistence.saveState)).toHaveBeenCalledTimes(
      savesBeforeLateReceipt
    );
    expect(fixture.getState("account-1", "date_companion").records).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ receiptId: "receipt_late" })])
    );
  });

  it("does not let an upload from a previous relationship hide the same recording", async () => {
    const fixture = runtimeFixture();
    const onSelect = vi.fn<(selection: ToySyncSelection) => void>();
    const { rerender } = render(
      <ToyAudioSync
        accountId="account-1"
        destination="date_companion"
        mode="select"
        onSelect={onSelect}
        relationshipId="relationship_1"
        runtime={fixture.runtime}
      />
    );
    fireEvent.click(await screen.findByRole("button", { name: "连接玩偶" }));
    const latestCard = (await screen.findByText("latest.wav")).closest("li")!;
    fireEvent.click(within(latestCard).getByRole("button", { name: "选择这条录音" }));
    const firstSelection = onSelect.mock.calls[0]![0];
    let firstAttempt: ToySyncUploadAttempt | null = null;
    await act(async () => {
      firstAttempt = await firstSelection.beginUpload("2026-08-15");
      await firstAttempt.finish(true);
    });
    const firstOperationKey = firstAttempt!.operation?.operationKey;
    expect(await within(latestCard).findByText("录音已收到")).toBeInTheDocument();

    await act(async () => {
      rerender(
        <ToyAudioSync
          accountId="account-1"
          destination="date_companion"
          mode="select"
          onSelect={onSelect}
          relationshipId="relationship_2"
          runtime={fixture.runtime}
        />
      );
    });

    const rescopedCard = (await screen.findByText("latest.wav")).closest("li")!;
    expect(await within(rescopedCard).findByRole("button", { name: "选择这条录音" }))
      .toBeInTheDocument();
    const rescopedRecord = fixture.getState("account-1", "date_companion").records
      .find((record) => (
        record.filename === "latest.wav" && record.relationshipId === "relationship_2"
      ));
    expect(rescopedRecord).toEqual(expect.objectContaining({
      relationshipId: "relationship_2",
      status: "new"
    }));
    expect(rescopedRecord).not.toHaveProperty("operationKey");

    await act(async () => {
      rerender(
        <ToyAudioSync
          accountId="account-1"
          destination="date_companion"
          mode="select"
          onSelect={onSelect}
          relationshipId="relationship_1"
          runtime={fixture.runtime}
        />
      );
    });
    const restoredCard = (await screen.findByText("latest.wav")).closest("li")!;
    expect(await within(restoredCard).findByText("录音已收到")).toBeInTheDocument();
    expect(within(restoredCard).queryByRole("button", { name: "选择这条录音" }))
      .not.toBeInTheDocument();
    expect(fixture.getState("account-1", "date_companion").records.find((record) => (
      record.filename === "latest.wav" && record.relationshipId === "relationship_1"
    ))).toEqual(expect.objectContaining({
      status: "uploaded",
      operationKey: firstOperationKey,
      recordingDate: "2026-08-15"
    }));
  });
});
