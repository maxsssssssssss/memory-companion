import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import type { DateCompanionHomeContentState } from "@/lib/client/date-companion-proactive-value";

import { CompanionHome, type CompanionUploadPresentation } from "./companion-home";
import { bookHomeReading, clearBookHomeReading, keepBookHomeReadingFor, rememberBookHomeReading } from "./book-home-reading-state";

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

const generatedHomeContent: DateCompanionHomeContentState = {
  status: "ready",
  content: {
    fingerprint: "b".repeat(64),
    about: [{
      kind: "recent_update",
      text: "小林最近在准备重要考试。",
      evidenceIds: ["source-1"],
      sources: [{ ...recentItem.sources[0], canOpenTranscript: true }]
    }],
    beforeMeeting: [{
      kind: "follow_up",
      text: "可以问问考试准备得怎么样了。",
      reason: "Ta 上次提到刷题时遇到了一些难题。",
      evidenceIds: ["source-2"],
      sources: [{ ...recentItem.sources[0], id: "source-2", segmentIds: ["segment-2"], quote: "这周刷题遇到了些难题。", canOpenTranscript: true }]
    }]
  }
};

const homeBook = { lastSaved: null, currentRecapHref: "/date-companion/a/recap?recording=current", href: (path: string) => path };
const uploadToggle = () => screen.getByRole("button", { name: "上传这次相处的录音" });
const toyToggle = () => screen.getByRole("button", { name: "连接玩偶" });

function renderHome(uploadState: CompanionUploadPresentation) {
  return render(
    <CompanionHome
      book={homeBook}
      currentInteraction={null}
      uploadState={uploadState}
      onRetryRead={vi.fn()}
      onUpload={vi.fn(async () => true)}
    />
  );
}

describe("CompanionHome", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true,
      value: function(this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true,
      value: function(this: HTMLDialogElement) { this.open = false; } });
  });
  afterEach(() => {
    clearBookHomeReading();
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  });
  it("keeps the saved title while explaining detail loading and retryable failures", () => {
    const retry = vi.fn();
    const props = { currentInteraction:null, uploadState:{status:"idle" as const}, onRetryRead:vi.fn(),onUpload:vi.fn(async()=>true),
      book:{lastSaved:{id:"saved-1",title:"最后留下的一页",date:"2026-01-08"},href:(path:string)=>path,onRetryHistory:retry} };
    const {rerender}=render(<CompanionHome {...props} book={{...props.book,historyStatus:"loading"}}/>);
    expect(screen.getByRole("heading",{name:"最后留下的一页"})).toBeVisible();
    expect(screen.getByText("正在读取这次复盘的摘要…")).toHaveAttribute("role","status");
    rerender(<CompanionHome {...props} book={{...props.book,historyStatus:"error"}}/>);
    expect(screen.getByRole("alert")).toHaveTextContent("这次复盘的摘要暂时未能读取，记录仍然保留");
    fireEvent.click(screen.getByRole("button",{name:"重新读取复盘"}));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByRole("link",{name:"翻开最近复盘：最后留下的一页"})).toHaveAttribute("href","/date-companion/a/recap?interaction=saved-1");
  });

  it("restores a home-source visit with its open passage, focus, file and date without sharing them across accounts", async () => {
    const scroll=vi.spyOn(window,"scrollTo").mockImplementation(()=>undefined);
    const onUpload=vi.fn(async()=>true);
    const props={book:{lastSaved:null,href:(path:string)=>path,scopeKey:"account-a:relationship-a"},currentInteraction:null,
      homeContent:generatedHomeContent,onOpenSource:vi.fn(),onRetryRead:vi.fn(),onUpload,uploadState:{status:"idle" as const}};
    const first=render(<CompanionHome {...props}/>);
    fireEvent.click(screen.getByRole("button",{name:"上传这次相处的录音"}));
    const file=new File(["local audio"],"下次再上传.wav",{type:"audio/wav"});
    fireEvent.change(screen.getByLabelText("选择录音文件"),{target:{files:[file]}});
    fireEvent.change(screen.getByLabelText("相处日期"),{target:{value:"2026-01-08"}});
    const section=screen.getByRole("region",{name:"人物近况"});
    fireEvent.click(within(section).getByText("查看原话"));
    const source=within(section).getByRole("button",{name:"在完整文字稿中查看"});
    source.focus(); fireEvent.click(source);
    expect(props.onOpenSource).toHaveBeenCalledWith(expect.objectContaining({id:"source-1"}),"segment-1");
    first.unmount();
    const returned=render(<CompanionHome {...props}/>);
    expect(screen.getByText("下次再上传.wav")).toBeVisible();
    expect(screen.getByLabelText("相处日期")).toHaveValue("2026-01-08");
    const restored=within(screen.getByRole("region",{name:"人物近况"})).getByRole("button",{name:"在完整文字稿中查看"});
    await waitFor(()=>expect(restored).toHaveFocus());
    expect(scroll).toHaveBeenCalledWith({left:0,top:0,behavior:"instant"});
    expect(restored.closest("details")).toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button",{name:"开始上传"}));
    await waitFor(()=>expect(onUpload).toHaveBeenCalledWith(file,"2026-01-08",undefined));
    returned.unmount();
    keepBookHomeReadingFor("account-b:relationship-b");
    render(<CompanionHome {...props} book={{...props.book,scopeKey:"account-b:relationship-b"}}/>);
    expect(screen.queryByText("下次再上传.wav")).not.toBeInTheDocument();
  });
  it("consumes an unavailable source return without reviving its old file after a later page visit", async () => {
    vi.spyOn(window,"scrollTo").mockImplementation(()=>undefined);
    const scrollIntoView=vi.fn();
    Object.defineProperty(HTMLElement.prototype,"scrollIntoView",{configurable:true,value:scrollIntoView});
    const retry=vi.fn();
    const props={book:{lastSaved:null,href:(path:string)=>path,scopeKey:"failure-return",onRetryContent:retry},currentInteraction:null,
      onOpenSource:vi.fn(),onRetryRead:vi.fn(),onUpload:vi.fn(async()=>true),uploadState:{status:"idle" as const}};
    const first=render(<CompanionHome {...props} homeContent={generatedHomeContent}/>);
    fireEvent.click(screen.getByRole("button",{name:"上传这次相处的录音"}));
    fireEvent.change(screen.getByLabelText("选择录音文件"),{target:{files:[new File(["A"],"原先.wav")]}});
    fireEvent.change(screen.getByLabelText("相处日期"),{target:{value:"2026-01-08"}});
    const about=screen.getByRole("region",{name:"人物近况"});
    fireEvent.click(within(about).getByText("查看原话"));
    const source=within(about).getByRole("button",{name:"在完整文字稿中查看"});
    source.focus();fireEvent.click(source);first.unmount();
    const returned=render(<CompanionHome {...props} homeContent={{status:"unavailable"}}/>);
    await waitFor(()=>expect(screen.getByLabelText("人物近况与见面准备")).toHaveFocus());
    expect(bookHomeReading("failure-return")).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"重新读取相关内容"}));
    expect(retry).toHaveBeenCalledOnce();
    const latest=new File(["B"],"后来选择.wav");
    fireEvent.change(screen.getByLabelText("更换录音文件"),{target:{files:[latest]}});
    fireEvent.change(screen.getByLabelText("相处日期"),{target:{value:"2026-01-10"}});
    returned.unmount();
    const revisited=render(<CompanionHome {...props} homeContent={{status:"unavailable"}}/>);
    expect(screen.getByText("后来选择.wav")).toBeVisible();
    expect(screen.getByLabelText("相处日期")).toHaveValue("2026-01-10");
    expect(screen.queryByText("原先.wav")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"开始上传"}));
    await waitFor(()=>expect(props.onUpload).toHaveBeenCalledWith(latest,"2026-01-10",undefined));
    revisited.unmount();
    render(<CompanionHome {...props} homeContent={generatedHomeContent} uploadState={{status:"ready",uploadId:"different-upload"}}/>);
    expect(screen.queryByText("后来选择.wav")).not.toBeInTheDocument();
  });
  it("keeps one local file through book-form collapse and sends the same saved object after a rejected transfer", async () => {
    const onUpload = vi.fn(async () => false);
    const props = { book: {lastSaved: null, href: (path: string) => path}, onUpload,
      currentInteraction: null, onRetryRead: vi.fn() };
    const { rerender } = render(<CompanionHome {...props} uploadState={{status: "idle"}} />);
    const toggle = screen.getByRole("button", {name: "上传这次相处的录音"});
    fireEvent.click(toggle);
    const localFile = new File(["sample"], "读到这里.wav", {type: "audio/wav"});
    fireEvent.change(screen.getByLabelText("选择录音文件"), {target: {files: [localFile]}});
    fireEvent.change(screen.getByLabelText("相处日期"), {target: {value: "2026-01-08"}});
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(screen.getByLabelText<HTMLInputElement>("更换录音文件").files?.[0]).toBe(localFile);
    expect(screen.getByLabelText("相处日期")).toHaveValue("2026-01-08");
    fireEvent.click(screen.getByRole("button", {name:"开始上传"}));
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));
    rerender(<CompanionHome {...props} uploadState={{status: "failed", failureStage:"upload", errorMessage:"上传失败"}} />);
    fireEvent.click(screen.getByRole("button", {name: "重新上传"}));
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
    expect(onUpload).toHaveBeenLastCalledWith(localFile,"2026-01-08",undefined);
  });

  it("does not pull focus away from new input when source content finishes loading late", async () => {
    const props={book:{lastSaved:null,href:(path:string)=>path,scopeKey:"slow-source-return"},currentInteraction:null,
      onOpenSource:vi.fn(),onRetryRead:vi.fn(),onUpload:vi.fn(async()=>true),uploadState:{status:"idle" as const}};
    rememberBookHomeReading({scopeKey:props.book.scopeKey,uploadId:"upload-1",segmentId:"segment-1",focusKey:"source-that-is-no-longer-visible",
      openSources:[],scrollX:0,scrollY:900,form:{uploadStateKey:JSON.stringify(["idle",undefined]),attemptedFile:null,
        file:new File(["test"],"正在填写的录音.wav"),recordingDate:"2026-01-08",fileError:null,toySelection:null,open:true}});
    const {rerender}=render(<CompanionHome {...props} homeContent={{status:"loading"}}/>);
    const date=screen.getByLabelText("相处日期");
    date.focus();
    fireEvent.input(date,{target:{value:"2026-01-10"}});
    rerender(<CompanionHome {...props} homeContent={generatedHomeContent}/>);
    await act(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
    expect(date).toHaveFocus();
    expect(date).toHaveValue("2026-01-10");
    expect(bookHomeReading(props.book.scopeKey)).toBeNull();
  });

  it("allows rereading the accepted recording without resending its file", async () => {
    vi.spyOn(window,"scrollTo").mockImplementation(()=>undefined);
    const props = { book:{scopeKey:"receipt-source-return",lastSaved:{id:"saved-walk", title:"散步", date:"2026-01-01"}, href:(path:string)=>path},
      homeContent:generatedHomeContent,onOpenSource:vi.fn(),onUpload:vi.fn(async () => true), currentInteraction:null, onRetryRead:vi.fn() };
    const {rerender,unmount} = render(<CompanionHome {...props} uploadState={{status: "idle"}}/>);
    fireEvent.click(screen.getByRole("button", {name:"上传这次相处的录音"}));
    fireEvent.change(screen.getByLabelText("选择录音文件"), {target:{files:[new File(["test"],"相处.wav")]}});
    fireEvent.click(screen.getByRole("button", {name:"开始上传"}));
    await waitFor(() => expect(props.onUpload).toHaveBeenCalledTimes(1));
    rerender(<CompanionHome {...props} uploadState={{status:"failed", hasReceipt:true, failureStage:"processing", errorMessage:"转写暂未完成"}}/>);
    expect(screen.getByRole("button", {name:"开始上传"})).toBeDisabled();
    fireEvent.click(screen.getByRole("button", {name:"重新读取结果"}));
    await waitFor(() => expect(props.onRetryRead).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("link", {name:"翻开最近复盘：散步"})).toHaveAttribute("href", "/date-companion/a/recap?interaction=saved-walk");
    const about=screen.getByRole("region",{name:"人物近况"});
    fireEvent.click(within(about).getByText("查看原话"));
    const source=within(about).getByRole("button",{name:"在完整文字稿中查看"});
    source.focus();fireEvent.click(source);unmount();
    render(<CompanionHome {...props} uploadState={{status:"failed",hasReceipt:true,failureStage:"processing",errorMessage:"转写暂未完成"}}/>);
    expect(screen.getByText("相处.wav")).toBeVisible();
    expect(screen.getByRole("button",{name:"开始上传"})).toBeDisabled();
    fireEvent.click(screen.getByRole("button",{name:"开始上传"}));
    expect(props.onUpload).toHaveBeenCalledTimes(1);
  });
  it("shows a local-time greeting without inventing a person name", async () => {
    renderHome({ status: "idle" });

    await waitFor(() => expect(document.querySelector("[data-local-time-greeting]")).toHaveTextContent(
      /^(早上好|上午好|中午好|下午好|晚上好)$/u
    ));
    expect(screen.getByRole("link", { name: "关于Ta" })).toBeInTheDocument();
    expect(screen.getByText("暂时没有可展示的人物近况。")).toBeInTheDocument();
  });

  it("shows distinct generated content with each item's own original sources and safe source action", () => {
    const onOpenSource = vi.fn();
    render(
      <CompanionHome
        book={homeBook}
      currentInteraction={null}
        onRetryRead={vi.fn()}
        onUpload={vi.fn(async () => true)}
        homeContent={generatedHomeContent}
        onOpenSource={onOpenSource}
        relationshipName="小林"
        uploadState={{ status: "idle" }}
      />
    );

    expect(screen.getByRole("heading", { name: /今天，有什么\s*值得留在心里/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "关于小林" })).toHaveAttribute("href", "/date-companion/a/person");
    const about = screen.getByRole("region", { name: "人物近况" });
    const beforeMeeting = screen.getByRole("region", { name: "下次见面前" });
    expect(within(about).getByText("小林最近在准备重要考试。")).toBeInTheDocument();
    expect(within(about).queryByText("可以问问考试准备得怎么样了。")).not.toBeInTheDocument();
    expect(within(beforeMeeting).getByText("可以问问考试准备得怎么样了。")).toBeInTheDocument();
    expect(within(beforeMeeting).queryByText("小林最近在准备重要考试。")).not.toBeInTheDocument();
    expect(within(about).getByText(/最近都在准备考试。/u).closest("details")).not.toHaveAttribute("open");
    expect(within(about).queryByText("这周刷题遇到了些难题。")).not.toBeInTheDocument();
    fireEvent.click(within(beforeMeeting).getByText("查看原话"));
    fireEvent.click(within(beforeMeeting).getByRole("button", { name: "在完整文字稿中查看" }));
    expect(onOpenSource).toHaveBeenCalledWith(expect.objectContaining({ id: "source-2", quote: "这周刷题遇到了些难题。" }), "segment-2");
    expect(screen.getByRole("link", { name: /回看准备卡/u })).toHaveAttribute("href", "/date-companion/a/prepare?section=records");
    expect(screen.queryByText(/认识.*天|河边|周六/u)).not.toBeInTheDocument();
  });

  it.each([
    ["empty", ["暂时没有可展示的人物近况。", "暂时没有可展示的见面准备。"]],
    ["loading", ["正在读取人物近况与见面准备…"]],
    ["unavailable", ["人物近况与见面准备暂时未能读取。"]]
  ] as const)("keeps %s truthful without retaining generated content", (status, copies) => {
    const props = { book: homeBook, currentInteraction: null, onRetryRead: vi.fn(), onUpload: vi.fn(async () => true), uploadState: { status: "idle" as const } };
    const { rerender } = render(<CompanionHome {...props} homeContent={generatedHomeContent} />);
    rerender(<CompanionHome {...props} homeContent={{ status }} />);
    for (const copy of copies) expect(screen.getByText(copy)).toBeInTheDocument();
    expect(screen.queryByText("小林最近在准备重要考试。")).not.toBeInTheDocument();
    expect(screen.queryByText("可以问问考试准备得怎么样了。")).not.toBeInTheDocument();
    expect(screen.queryByText("最近都在准备考试。")).not.toBeInTheDocument();
  });

  it("uses an indeterminate uploading state instead of displaying a fabricated percentage", () => {
    renderHome({ status: "uploading", progress: 73 });

    expect(screen.getByText("正在把这次相处交进来")).toBeInTheDocument();
    expect(screen.queryByText("73%")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/上传进度 \d+%/)).not.toBeInTheDocument();
  });

  it("closes the upload details when ready while keeping a recap entry point outside it", async () => {
    const props = { book: homeBook, currentInteraction: null, onRetryRead: vi.fn(), onUpload: vi.fn() };
    const { container, rerender } = render(<CompanionHome {...props} uploadState={{ status: "idle" }} />);
    fireEvent.click(uploadToggle());
    expect(uploadToggle()).toHaveAttribute("aria-expanded", "true");
    rerender(<CompanionHome {...props} uploadState={{ status: "processing", jobStatus: "transcribing", progress: 45 }} />);
    rerender(<CompanionHome {...props} uploadState={{ status: "ready" }} />);
    await waitFor(() => expect(uploadToggle()).toHaveAttribute("aria-expanded", "false"));
    const recap = screen.getByRole("link", { name: /查看录音复盘/ });
    expect(container.querySelector("#home-upload-form")).not.toContainElement(recap);
  });

  it("allows another recording to be selected and uploaded after a recap is ready", async () => {
    const onUpload = vi.fn().mockResolvedValue(true);
    render(
      <CompanionHome
        book={homeBook}
      currentInteraction={null}
        onRetryRead={vi.fn()}
        onUpload={onUpload}
        uploadState={{ status: "ready" }}
      />
    );

    expect(screen.getByRole("link", { name: /查看录音复盘/u })).toBeVisible();
    fireEvent.click(uploadToggle());
    const nextFile = new File(["next"], "next-date.wav", { type: "audio/wav" });
    fireEvent.change(screen.getByLabelText(/选择录音文件/u), { target: { files: [nextFile] } });
    const manualDateInput = screen.getByLabelText("相处日期");
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

  it("keeps a processing failure visible and only retries reading", async () => {
    const errorMessage = "转写服务超时";
    const onRetryRead = vi.fn();
    render(<CompanionHome book={homeBook} currentInteraction={null} uploadState={{ status: "failed", errorMessage, failureStage: "processing", hasReceipt: true }}
      onRetryRead={onRetryRead} onUpload={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(errorMessage);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "重新读取结果" })));
    expect(onRetryRead).toHaveBeenCalledOnce();
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
        book={homeBook}
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

    fireEvent.click(toyToggle());
    const connect = await screen.findByRole("button", { name: "选择录音文件夹" });
    expect(fixture.runtime.pickDirectory).not.toHaveBeenCalled();
    fireEvent.click(connect);

    const toyFilename = await screen.findByText("toy-date.wav");
    const toyCard = toyFilename.closest("li")!;
    fireEvent.click(screen.getByRole("button", { name: "选择这条录音" }));

    expect(onUpload).not.toHaveBeenCalled();
    expect(screen.getByText("日期来自玩偶录音。")).toBeInTheDocument();
    expect(screen.getByText("2026-08-14")).toBeInTheDocument();
    expect(screen.queryByLabelText("相处日期")).not.toBeInTheDocument();
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
      operationKey: expect.stringMatching(/^toyop_v2_[a-f0-9]{64}$/u)
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
    expect(screen.getByText("日期来自玩偶录音。")).toBeInTheDocument();
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
      screen.queryByText("日期来自玩偶录音。")
    ).not.toBeInTheDocument());
    expect(screen.getByLabelText(/选择录音文件/u)).toBeInTheDocument();
    expect(screen.getByLabelText("相处日期")).toBeInTheDocument();
  });

  it("rejects an oversized toy file through the same client gate without beginning upload", async () => {
    const fixture = toyRuntimeFixture({ oversized: true });
    const onUpload = vi.fn(async () => true);
    render(
      <CompanionHome
        book={homeBook}
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

    fireEvent.click(toyToggle());
    fireEvent.click(await screen.findByRole("button", { name: "选择录音文件夹" }));
    fireEvent.click(await screen.findByRole("button", { name: "选择这条录音" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("文件超过 300MB");
    expect(screen.queryByText("日期来自玩偶录音。")).not.toBeInTheDocument();
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
        book={homeBook}
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

    fireEvent.click(toyToggle());
    fireEvent.click(await screen.findByRole("button", { name: "选择录音文件夹" }));
    fireEvent.click(await screen.findByRole("button", { name: "选择这条录音" }));
    expect(screen.queryByLabelText("相处日期")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始上传" }));

    expect(await screen.findByText("重试沿用第一次上传的录音日期。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始上传" }));

    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
    expect(onUpload.mock.calls[0]?.[1]).toBe("2026-08-14");
    expect(onUpload.mock.calls[1]?.[1]).toBe("2026-08-14");
    expect(onUpload.mock.calls[0]?.[2]?.toyOperation?.operationKey)
      .toBe(onUpload.mock.calls[1]?.[2]?.toyOperation?.operationKey);
    expect(await screen.findByText("录音已收到")).toBeInTheDocument();
  });

});
