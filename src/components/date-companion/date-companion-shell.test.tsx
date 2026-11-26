import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDateCompanionSession, type DateCompanionSessionValue } from "@/lib/client/date-companion-session";
import { useDateCompanionPersonArchive } from "@/lib/client/date-companion-people";
import {
  emptyDateCompanionViewModel,
  type DateCompanionMemoryBridgeState,
  type DateCompanionViewModel,
  type InteractionVM,
  type SourceRefVM
} from "@/lib/domain/date-companion";

import { DateCompanionShell } from "./date-companion-shell";
import { clearQaDrafts } from "./companion-qa-drafts";

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  searchParams: null as URLSearchParams | null
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerMocks.push, replace: routerMocks.replace, back:routerMocks.back }),
  usePathname: () => window.location.pathname,
  useSearchParams: () => routerMocks.searchParams
}));

vi.mock("@/lib/client/date-companion-session", () => ({
  useDateCompanionSession: vi.fn()
}));

vi.mock("@/lib/client/date-companion-people", () => ({
  useDateCompanionPersonArchive: vi.fn()
}));
vi.mock("./companion-preparation-book", async (importOriginal) => {
  const original = await importOriginal<typeof import("./companion-preparation-book")>();
  return { ...original, CompanionPreparationBook: (props: import("./companion-preparation-book").CompanionPreparationBookProps) => {
    if (props.session.auth.status !== "authenticated" || ["idle", "loading"].includes(props.session.relationshipState.status)) {
      return <original.CompanionPreparationBook {...props} />;
    }
    const id = props.initialDiscussionId;
    return <section data-testid="formal-book-preparation" data-target={id === null ? "new" : id === undefined ? "latest" : "existing"}>{id || "new discussion"}</section>;
  } };
});

vi.mock("@/components/daily-reflection/daily-reflection-toy-sync", () => ({
  ToyAudioSync: ({ accountId }: { accountId: string }) => (
    <div data-testid="date-companion-toy-sync">{accountId}</div>
  )
}));

const mockedUseDateCompanionSession = vi.mocked(useDateCompanionSession);
const mockedUseDateCompanionPersonArchive = vi.mocked(useDateCompanionPersonArchive);

function makeSession(overrides: Partial<DateCompanionSessionValue> = {}): DateCompanionSessionValue {
  return {
    relationshipDetailsLoaded: true,
    detailReadState: { status: "idle" },
    ensureRelationshipDetailsLoaded: vi.fn(async () => undefined),
    readSavedMeeting: vi.fn(async () => undefined),
    readProcessingProgress: vi.fn(async () => undefined),
    sourceSpeakerLabel: vi.fn(() => undefined),
    retryInteractionDetail: vi.fn(async () => undefined),
    readRecordingForRecap: vi.fn(async () => false),
    auth: { status: "checking" },
    viewModel: emptyDateCompanionViewModel(),
    uploadState: { status: "idle" },
    activeQaMode: "person",
    currentQaState: { status: "idle" },
    currentQaHistory: [],
    qaState: { status: "idle" },
    qaHistory: [],
    relationshipState: { status: "idle" },
    mutationState: { status: "idle" },
    searchState: { status: "idle" },
    memoryBridgeState: { status: "idle" },
    memoryMutationState: { status: "idle" },
    login: vi.fn(async () => undefined),
    register: vi.fn(async () => undefined),
    clearAuthError: vi.fn(),
    logout: vi.fn(async () => undefined),
    upload: vi.fn(async () => true),
    adoptToyIngestionReceipt: vi.fn(async () => null),
    retryRead: vi.fn(async () => undefined),
    refreshRelationship: vi.fn(async () => undefined),
    createRelationship: vi.fn(async () => undefined),
    updateParticipants: vi.fn(async () => undefined),
    updateRecap: vi.fn(async () => undefined),
    finalizeRecap: vi.fn(async () => undefined),
    updatePromise: vi.fn(async () => undefined),
    searchRelationship: vi.fn(async () => undefined),
    deleteInteraction: vi.fn(async () => undefined),
    selectCachedInteraction: vi.fn(() => false),
    selectRelationshipInteraction: vi.fn(() => false),
    relationshipQaSources: vi.fn(() => []),
    personQaSources: vi.fn(() => []),
    scopedPersonQaSources: vi.fn(() => []),
    qaSourceDay: vi.fn(() => null),
    recordingSpeakerReview: vi.fn(() => undefined),
    personQaAvailability: vi.fn(() => ({ enabled: false as const, message: "先确认人物设置。" })),
    currentInteractionQaAvailability: vi.fn(() => ({ enabled: false as const, message: "先打开一次完整记录。" })),
    activateQaMode: vi.fn(),
    ensureMemoryBridgeLoaded: vi.fn(async () => undefined),
    createConfirmedPerson: vi.fn(async () => undefined),
    savePersonMapping: vi.fn(async () => undefined),
    setLongTermRetention: vi.fn(async () => undefined),
    syncInteractionMemory: vi.fn(async () => undefined),
    checkOpenQaCatalog: vi.fn(async () => undefined),
    previewRetainedMemory: vi.fn(async () => ({preview: {version: "scope-v1", totalCount: 2, retainedCount: 1, processingCount: 1}})),
    purgeRetainedMemory: vi.fn(async () => ({ purgeId: "w1", usageStopped: true as const, status: "completed", totalCount: 2, retainedCount: 1, processingCount: 1, completedCount: 2, failedCount: 0, retryable: false, updatedAt: "2026-11-24T12:00:00Z" })),
    ask: vi.fn(async () => null),
    askCurrentInteraction: vi.fn(async () => null),
    cancelQa: vi.fn(),
    ...overrides
  };
}

function readyInteraction(): InteractionVM {
  return {
    id: "upload-1",
    uploadIds: ["upload-1"],
    recordingDate: "2026-08-04",
    fileName: "date.m4a",
    title: "这次相处",
    durationSeconds: 2_700,
    status: "ready",
    transcript: [
      {
        id: "segment-1",
        uploadId: "upload-1",
        startSeconds: 10,
        endSeconds: 15,
        speakerId: "speaker_1",
        text: "下次可以一起看电影。"
      }
    ]
  };
}

function viewModelWithInteraction(interaction: InteractionVM): DateCompanionViewModel {
  const viewModel = emptyDateCompanionViewModel();
  return {
    ...viewModel,
    currentInteraction: interaction,
    recap: { ...viewModel.recap, interaction }
  };
}

function readyMemoryBridgeState(personQaSources: SourceRefVM[] = []): Extract<DateCompanionMemoryBridgeState, {status:"ready"}> {
  const personRecord = (id: string, displayName: string) => ({
    id,
    displayName,
    status: "confirmed" as const,
    version: 1,
    explicitlyConfirmed: true as const,
    confirmedAt: "2026-08-04T10:00:00.000Z",
    createdAt: "2026-08-04T10:00:00.000Z",
    updatedAt: "2026-08-04T10:00:00.000Z"
  });
  return {
    status: "ready",
    people: [personRecord("person-self", "我"), personRecord("person-ta", "林澄")],
    selfBinding: null,
    setting: { enabled: true, version: 1, createdAt: "2026-08-04T10:00:00.000Z", updatedAt: "2026-08-04T10:00:00.000Z", enabledAt: "2026-08-04T10:00:00.000Z", disabledAt: null },
    mapping: { id: "mapping-1", selfPersonId: "person-self", companionPersonId: "person-ta", relationshipType: "dating", status: "confirmed", version: 2, confirmedAt: "2026-08-04T10:00:00.000Z", createdAt: "2026-08-04T10:00:00.000Z", updatedAt: "2026-08-04T10:00:00.000Z" },
    review: {
      retention: { enabled: true, version: 1, createdAt: "2026-08-04T10:00:00.000Z", updatedAt: "2026-08-04T10:00:00.000Z", enabledAt: "2026-08-04T10:00:00.000Z", disabledAt: null },
      mapping: null,
      interactions: []
    },
    retainedSubjects: {},
    memoryRetainedSourceKeys: [],
    relationshipPersonSources: [],
    personQaSources
  };
}

const qaSource: SourceRefVM = {
  id: "source-1", uploadId: "upload-1", segmentIds: ["segment-1"], recordingDate: "2026-08-04",
  startSeconds: 10, endSeconds: 15, speakerId: "speaker_1", quote: "下次可以一起看电影。",
  kind: "transcript", presentation: "direct_quote"
};

function confirmedQaMemory(sources: SourceRefVM[] = [qaSource]) {
  const date = "2026-08-04T10:00:00.000Z";
  return {
    ...readyMemoryBridgeState(sources), qaCatalogStatus: "ready" as const,
    selfBinding: {personId:"person-self",status:"active" as const,version:1,setAt:date,clearedAt:null,updatedAt:date}
  };
}

function installDialogMethods() {
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: {configurable:true, value(this: HTMLDialogElement) { this.open = true; }},
      close: {configurable:true, value(this: HTMLDialogElement) { this.open = false; }}
    });
}

function openQaSuggestions() {
  const control = screen.getByRole("button", { name: "提问建议" });
  if (control.getAttribute("aria-expanded") !== "true") fireEvent.click(control);
}

describe("DateCompanionShell", () => {
  it("offers a local retry when the current Ta cannot be identified during a person-page read failure", () => {
    installDialogMethods();
    const session=makeSession({auth:{status:"authenticated",user:{id:"user-1",email:"user@example.com"}},
      relationshipState:{status:"ready",relationship:{id:"r1",participantState:"confirmed",version:1,displayName:"林澄"}},
      memoryBridgeState:{status:"error",message:"暂时无法读取。"}});
    mockedUseDateCompanionSession.mockReturnValue(session);
    render(<DateCompanionShell entry="companion" screen="person" initialPersonId="person-ta"/>);
    fireEvent.click(screen.getByRole("button",{name:"问问 Ta"}));
    const paper=screen.getByRole("dialog");
    expect(within(paper).queryByText(/另一位人物/)).toBeNull();
    fireEvent.click(within(paper).getByRole("button",{name:"重新读取人物资料"}));
    expect(session.ensureMemoryBridgeLoaded).toHaveBeenCalledWith(true);
  });
  it.each([false, true])("keeps a confirmed mapping after withdrawal and recognises a new pending grant (%s)", pending => {
    const memory = readyMemoryBridgeState();
    if (memory.status !== "ready") throw new Error("fixture");
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: {status:"authenticated", user:{id:"user-1",email:"user@example.com"}},
      relationshipState: {status:"ready", relationship:{id:"relationship-1", participantState:"confirmed", version:1,displayName:"林澄"}},
      personQaAvailability: () => ({enabled:true,personId:"person-ta",mappingVersion:2}),
      memoryBridgeState:{...memory,qaCatalogStatus:"withdrawn",review:{...memory.review,interactions:pending ? [{
        interactionId:"i",sourceUploadId:"u",recordingDate:"2026-11-24",sourceState:"available",status:"pending",
        attemptCount:0,selectionCount:1,unknownCount:0,updatedAt:null
      }] : []}}
    }));
    installDialogMethods();
    render(<DateCompanionShell entry="companion" screen="home"/>);
    fireEvent.click(screen.getByRole("button", {name:"问问 Ta"}));
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByText(pending ? /相关材料正在处理/ : /长期资料已撤回/)).toBeVisible();
    expect(within(drawer).getByRole("textbox")).toBeDisabled();
    expect(within(drawer).queryByRole("button", {name:/重新读取人物资料/})).toBeNull();
  });
  it("offers a home retry for a failed catalog read even if the saved recap list is empty", () => {
    const memory = readyMemoryBridgeState();
    if (memory.status !== "ready") throw new Error("fixture");
    const session = makeSession({
      auth: {status: "authenticated", user: {id: "user-1", email: "user@example.com"}},
      relationshipState: {status: "ready", relationship: {id: "relationship-1", participantState: "confirmed", version: 1, displayName: "林澄"}},
      personQaAvailability: () => ({enabled: true, personId: "person-ta", mappingVersion: 2}),
      memoryBridgeState: {...memory, qaCatalogStatus: "unavailable"}
    });
    mockedUseDateCompanionSession.mockReturnValue(session);
    render(<DateCompanionShell entry="companion" screen="home" />);
    expect(screen.queryByText(/可以先完成一次相处复盘/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name: "重新读取相关内容"}));
    expect(session.ensureMemoryBridgeLoaded).toHaveBeenCalledWith(true);
  });
  it("explains an unconfirmed relationship instead of claiming materials are empty", () => {
    const memory=readyMemoryBridgeState();
    if(memory.status!=="ready")throw new Error("fixture");
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth:{status:"authenticated",user:{id:"user-1",email:"user@example.com"}},
      relationshipState:{status:"ready",relationship:{id:"relationship-1",participantState:"confirmed",version:1,displayName:"林澄"}},
      memoryBridgeState:{...memory,mapping:null}
    }));
    render(<DateCompanionShell entry="companion" screen="home" />);
    expect(screen.getAllByText("先确认这段关系中的“我”和“Ta”，再查看人物近况与见面准备。").length).toBeGreaterThan(0);
    expect(screen.getByRole("link",{name:/核对人物身份/})).toHaveAttribute("href","/date-companion/a/people?section=manage#people-mapping-title");
    expect(screen.queryByText("暂时没有可展示的人物近况。")).not.toBeInTheDocument();
    expect(screen.queryByText("还没有适合放在这里的近况。")).not.toBeInTheDocument();
  });
  it.each(["home", "prepare"] as const)("handles first use of %s without loading any saved records", async (entryScreen) => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ preparations: [], availableSources: [] })));
    const session = makeSession({ auth: { status: "authenticated", user: { id: "user-1", email: "user@example.com" } }, relationshipState: { status: "absent" }, relationshipDetailsLoaded: false });
    mockedUseDateCompanionSession.mockReturnValue(session);
    render(<DateCompanionShell entry="companion" screen={entryScreen} />);
    if (entryScreen === "prepare") expect(screen.getByTestId("formal-book-preparation")).toBeInTheDocument();
    else expect(screen.getByRole("heading", { name: "你想怎样称呼 Ta？" })).toBeInTheDocument();
    expect(session.ensureRelationshipDetailsLoaded).not.toHaveBeenCalled();
    expect(session.createRelationship).not.toHaveBeenCalled();
    expect(screen.queryByText("正在读取相处内容…")).not.toBeInTheDocument();
    if (entryScreen === "home") {
      fireEvent.change(screen.getByLabelText("称呼（可选）"), { target: { value: "小满" } });
      fireEvent.click(screen.getByRole("button", { name: /开始记录这段关系/u }));
      expect(session.createRelationship).toHaveBeenCalledWith("小满");
    }
  });

  beforeEach(() => {
    installDialogMethods();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {configurable:true,value:vi.fn()});
    vi.stubGlobal("scrollTo", vi.fn());
    routerMocks.searchParams = null;
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn()
    }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    mockedUseDateCompanionPersonArchive.mockReturnValue({ status: "idle" });
  });

  afterEach(() => {
    cleanup();
    clearQaDrafts("user-1");
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows a private-space loading state while authentication is being checked", () => {
    mockedUseDateCompanionSession.mockReturnValue(makeSession());

    render(<DateCompanionShell entry="login" />);

    expect(screen.getByRole("status")).toHaveTextContent("正在确认你的私人空间…");
    expect(screen.queryByLabelText("邮箱")).not.toBeInTheDocument();
  });

  it("shows the real login form for an anonymous user without a demo-account action", () => {
    const session = makeSession({ auth: { status: "anonymous" } });
    mockedUseDateCompanionSession.mockReturnValue(session);

    render(<DateCompanionShell entry="login" />);

    expect(screen.getByLabelText("邮箱")).toBeInTheDocument();
    expect(screen.getByLabelText("密码")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "注册" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /演示/ })).not.toBeInTheDocument();
  });

  it("keeps registration reachable, translates failures, and clears the error when switching modes", () => {
    const session = makeSession({ auth: { status: "anonymous" } });
    mockedUseDateCompanionSession.mockReturnValue(session);
    const { rerender } = render(<DateCompanionShell entry="login" />);

    fireEvent.click(screen.getByRole("tab", { name: "注册" }));
    expect(screen.getByLabelText("昵称（可选）")).toBeInTheDocument();
    expect(screen.getByLabelText("邀请码")).toBeInTheDocument();

    mockedUseDateCompanionSession.mockReturnValue({
      ...session,
      auth: { status: "error", message: "invalid_invite_code" }
    });
    rerender(<DateCompanionShell entry="login" />);
    expect(screen.getByRole("alert")).toHaveTextContent("邀请码不正确，请重新输入。");
    expect(screen.getByRole("tab", { name: "注册" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("tab", { name: "登录" }));
    expect(session.clearAuthError).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText("邀请码")).not.toBeInTheDocument();
  });

  it.each([
    ["invalid_register_input", "请检查邮箱、密码和邀请码后再试。密码至少需要 8 位。"],
    ["invite_not_configured", "注册暂未开放，请联系管理员。"],
    ["user_exists", "这个邮箱已经注册过，可以直接登录。"],
    ["暂时无法连接注册服务，请稍后再试。", "暂时无法连接注册服务，请稍后再试。"]
  ])("shows a safe registration message for %s", (message, expected) => {
    const session = makeSession({ auth: { status: "error", message } });
    mockedUseDateCompanionSession.mockReturnValue(session);
    render(<DateCompanionShell entry="login" />);

    fireEvent.click(screen.getByRole("tab", { name: "注册" }));
    expect(screen.getByRole("alert")).toHaveTextContent(expected);
  });

  it("uses the shared fail-closed state when an authenticated session expires", () => {
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: { status: "error", message: "unauthenticated" }
    }));

    render(<DateCompanionShell entry="companion" screen="home" />);

    expect(screen.getByRole("alert")).toHaveTextContent("登录状态没有确认");
    expect(screen.getByRole("alert")).toHaveTextContent("登录状态已失效，请重新登录");
    expect(screen.getByRole("link", { name: "返回登录" })).toHaveAttribute("href", "/date-companion");
  });

  it("replaces the login route with module selection after authentication", async () => {
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: {
        status: "authenticated",
        user: { id: "user-1", email: "user@example.com" }
      }
    }));

    render(<DateCompanionShell entry="login" />);

    expect(screen.getByRole("status")).toHaveTextContent("正在进入你的空间…");
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/"));
  });

  it("returns to a local business deep link after authentication", async () => {
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: { status: "authenticated", user: { id: "user-1", email: "user@example.com" } }
    }));
    routerMocks.searchParams = new URLSearchParams({ returnTo: "/date-companion/a/recap?interaction=saved&segment=source#full-transcript" });
    render(<DateCompanionShell entry="login" />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/date-companion/a/recap?interaction=saved&segment=source#full-transcript"));
  });

  it("does not follow an external sign-in return address", async () => {
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: { status: "authenticated", user: { id: "user-1", email: "user@example.com" } }
    }));
    routerMocks.searchParams = new URLSearchParams({ returnTo: "//example.com/date-companion/a" });
    render(<DateCompanionShell entry="login" />);
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/"));
  });

  it("shows the current companion view and enables QA for a ready interaction", () => {
    const interaction = readyInteraction();
    const ask = vi.fn(async () => null);
    const viewModel = viewModelWithInteraction(interaction);
    viewModel.home.participantNotice = "这次相处中的人物还没有全部核对";
    viewModel.person.recent = [{
      id: "recent-1",
      kind: "mentioned",
      title: "Ta 最近",
      proposedText: "Ta 最近在准备考试",
      displayedText: "Ta 最近在准备考试",
      disposition: "kept",
      sources: [{
        id: "source-1",
        uploadId: interaction.id,
        segmentIds: ["segment-1"],
        recordingDate: interaction.recordingDate,
        startSeconds: 10,
        endSeconds: 15,
        quote: "最近都在准备考试。",
        kind: "transcript",
        presentation: "direct_quote"
      }]
    }];
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: {
        status: "authenticated",
        user: { id: "user-1", email: "user@example.com" }
      },
      viewModel,
      relationshipState: {
        status: "ready",
        relationship: { id: "relationship-1", displayName: "小林", participantState: "confirmed", version: 1 }
      },
      uploadState: {
        status: "ready",
        uploadId: interaction.id,
        cacheStatus: "saved",
        serverCleanupStatus: "completed"
      },
      personQaAvailability: vi.fn(() => ({ enabled: true as const, personId: "person-ta", mappingVersion: 2 })),
      memoryBridgeState: confirmedQaMemory(),
      scopedPersonQaSources: () => [qaSource],
      ask
    }));

    render(<DateCompanionShell entry="companion" screen="home" />);

    expect(screen.getByRole("link", { name: "首页" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("小林")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /今天，有什么/ })).toBeInTheDocument();
    expect(screen.queryByText("Ta 最近在准备考试")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "问问 Ta" }));
    expect(screen.getByRole("textbox", { name: "你的问题" })).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox", { name:"你的问题" }), {target:{value:"Ta 以前明确提到过哪些在意的事？"}});
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(ask).toHaveBeenCalledWith("Ta 以前明确提到过哪些在意的事？");
  });

  it("exposes the shared account contract inside the Date Companion shell", async () => {
    let finishLogout!: () => void;
    const logout = vi.fn(() => new Promise<void>(resolve => { finishLogout = resolve; }));
    const session = makeSession({
      auth: {
        status: "authenticated",
        user: { id: "user-1", email: "user@example.com", name: "小满" }
      },
      logout,
      relationshipState: {
        status: "ready",
        relationship: { id: "relationship-1", displayName: "小林", participantState: "confirmed", version: 1 }
      }
    });
    const page = () => <DateCompanionShell dailyReflectionEnabled entry="companion" screen="recap" />;
    window.history.replaceState(null,"","/date-companion/a/recap?recording=private-recording");
    try {
      mockedUseDateCompanionSession.mockReturnValue(session);
      const { rerender } = render(page());
      fireEvent.click(screen.getByRole("button", { name: /账号菜单/u }));
      expect(screen.getByText("小满")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

      expect(logout).toHaveBeenCalledTimes(1);
      mockedUseDateCompanionSession.mockReturnValue({...session, auth:{ status:"anonymous" }});
      rerender(page());
      expect(screen.getByRole("status")).toHaveTextContent("正在返回登录页");
      await act(async () => finishLogout());
      expect(routerMocks.replace.mock.calls).toEqual([["/date-companion"]]);
    } finally {
      window.history.replaceState(null,"","/");
    }
  });

  it("shows a single detail reading sheet only after matching the requested book record", () => {
    const interaction = { ...readyInteraction(), title: "河边的一天", detailLoaded: false, relationshipInteractionId: "meeting-a" };
    const session = makeSession({
      auth: { status: "authenticated", user: { id: "user-1", email: "user@example.com" } },
      relationshipState: { status: "ready", relationship: { id: "relationship-1", displayName: "小林", participantState: "confirmed", version: 1 } },
      selectRelationshipInteraction: vi.fn(() => true),
      viewModel: viewModelWithInteraction(interaction),
      detailReadState: { status: "loading" },
    });
    const page = (id:string) => <DateCompanionShell entry="companion" screen="recap" initialInteractionId={id}/>;
    mockedUseDateCompanionSession.mockReturnValue(session);
    const {container, rerender} = render(page("meeting-b"));
    expect(container.querySelector("[data-book-detail-reading]")).toBeNull();
    expect(screen.queryByText("河边的一天")).not.toBeInTheDocument();
    rerender(page("meeting-a"));
    const sheet = within(container.querySelector<HTMLElement>("[data-book-detail-reading]")!);
    expect(sheet.getByRole("heading", {name:"河边的一天"})).toBeVisible();
    expect(sheet.getByRole("status")).toHaveTextContent("正在读取相处内容");
    expect(sheet.queryByRole("button")).toBeNull();
    mockedUseDateCompanionSession.mockReturnValue({...session, detailReadState:{status:"error", interactionId:"meeting-a", message:"读取暂时失败，请重新读取。"}});
    rerender(page("meeting-a"));
    expect(sheet.getByRole("status")).toHaveTextContent("读取暂时失败");
    fireEvent.click(sheet.getByRole("button", {name:"重新读取"}));
    expect(session.retryInteractionDetail).toHaveBeenCalledTimes(1);
    mockedUseDateCompanionSession.mockReturnValue({...session, detailReadState:{status:"error", interactionId:"meeting-a", targetUnavailable:true, message:"这段记录不存在，或已经无法访问。"}});
    rerender(page("meeting-a"));
    expect(sheet.queryByText("河边的一天")).not.toBeInTheDocument();
    expect(sheet.getByRole("button", {name:"重新读取"})).toBeVisible();
    mockedUseDateCompanionSession.mockReturnValue({...session, viewModel:viewModelWithInteraction({...interaction, detailLoaded:true})});
    rerender(page("meeting-a"));
    expect(container.querySelector("[data-book-detail-reading]")).toBeNull();
    expect(container.querySelector("[data-book-recap]")).toBeInTheDocument();
  });

  it("keeps book recap navigation on its displayed record and returns to the book home", () => {
    const interaction: InteractionVM = {
      ...readyInteraction(),
      relationshipInteractionId: "interaction-history",
      persistenceStatus: "confirmed"
    };
    const viewModel = viewModelWithInteraction(interaction);
    viewModel.currentInteraction = { ...readyInteraction(), id: "another-current-upload" };
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: { status: "authenticated", user: { id: "user-1", email: "user@example.com" } },
      viewModel,
      relationshipState: {
        status: "ready",
        relationship: { id: "relationship-1", displayName: "小林", participantState: "confirmed", version: 1 }
      }
    }));

    render(<DateCompanionShell entry="companion" screen="recap" />);

    const nav = screen.getByRole("navigation", { name: "约会陪伴页面" });
    expect(screen.getByRole("button", { name: /切换产品/u })).toHaveTextContent("Daily Brief");
    expect(within(nav).getByRole("link", { name: "首页" })).toHaveAttribute("href", "/date-companion/a");
    expect(within(nav).getByRole("link", { name: "准备" })).toHaveAttribute("href", "/date-companion/a/prepare");
    expect(within(nav).getByRole("link", { name: "人物" })).toHaveAttribute("href", "/date-companion/a/people");
    expect(within(nav).getByRole("link", { name: "复盘" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "复盘" })).toHaveAttribute("href", "/date-companion/a/recap?interaction=interaction-history");
    expect(screen.queryByRole("link", { name: "切回旧版" })).not.toBeInTheDocument();
  });

  it.each(["home", "prepare", "recap"] as const)("opens the sole verified person's canonical book directly from %s", (entryScreen) => {
    const memory = readyMemoryBridgeState();
    if (memory.status !== "ready") throw new Error("fixture");
    const date = "2026-08-04T10:00:00.000Z";
    const session = makeSession({
      auth: { status: "authenticated", user: { id: "user-1", email: "user@example.com" } },
      relationshipState: { status: "ready", relationship: { id: "relationship-1", displayName: "林澄", participantState: "confirmed", version: 1 } },
      memoryBridgeState: { ...memory, selfBinding: { personId: "person-self", status: "active", version: 1, setAt: date, clearedAt: null, updatedAt: date } }
    });
    mockedUseDateCompanionSession.mockReturnValue(session);
    const page = <DateCompanionShell entry="companion" screen={entryScreen} />;
    const { rerender } = render(page);
    expect(screen.getByRole("link", { name: /^人物$/ })).toHaveAttribute("href", "/date-companion/a/people/person-ta");

    // More than one confirmed person must keep the directory choice available.
    mockedUseDateCompanionSession.mockReturnValue({ ...session, memoryBridgeState: {
      ...memory, selfBinding: session.memoryBridgeState.status === "ready" ? session.memoryBridgeState.selfBinding : null,
      people: [...memory.people, { ...memory.people[1], id: "person-other", displayName: "另一位" }]
    } });
    rerender(<DateCompanionShell entry="companion" screen={entryScreen} />);
    expect(screen.getByRole("link", { name: /^人物$/ })).toHaveAttribute("href", "/date-companion/a/people");

    // Losing verified identity must also remove the direct target immediately.
    mockedUseDateCompanionSession.mockReturnValue({ ...session, memoryBridgeState: memory });
    rerender(<DateCompanionShell entry="companion" screen={entryScreen} />);
    expect(screen.getByRole("link", { name: /^人物$/ })).toHaveAttribute("href", "/date-companion/a/people");
  });

  it("keeps a resolved sole-person alias mounted instead of replacing its route", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
    const memory = readyMemoryBridgeState();
    if (memory.status !== "ready") throw new Error("fixture");
    const date = "2026-08-04T10:00:00.000Z";
    const session = makeSession({
      auth: { status: "authenticated", user: { id: "user-1", email: "user@example.com" } },
      relationshipState: { status: "ready", relationship: { id: "relationship-1", displayName: "林澄", participantState: "confirmed", version: 1 } },
      memoryBridgeState: { ...memory, selfBinding: { personId: "person-self", status: "active", version: 1, setAt: date, clearedAt: null, updatedAt: date } }
    });
    mockedUseDateCompanionSession.mockReturnValue(session);
    const { container, rerender } = render(<DateCompanionShell entry="companion" screen="people" />);
    const board = container.querySelector(".scrap-board");
    expect(board).not.toBeNull();
    expect(screen.getByRole("heading", { name: "林澄", level: 1 })).toBeInTheDocument();
    mockedUseDateCompanionPersonArchive.mockReturnValue({ status: "ready", archive: { person: memory.people[1], entries: [] } });
    rerender(<DateCompanionShell entry="companion" screen="people" />);
    expect(container.querySelector(".scrap-board")).toBe(board);
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it("restores shared menu focus in the default book shell", () => {
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: { status: "authenticated", user: { id: "user-1", email: "user@example.com" } },
      relationshipState: {
        status: "ready",
        relationship: { id: "relationship-1", displayName: "小林", participantState: "confirmed", version: 1 }
      }
    }));
    render(<DateCompanionShell entry="companion" screen="home" />);
    expect(screen.getByRole("link", { name: "首页" })).toHaveAttribute("href", "/date-companion/a");
    expect(screen.getByRole("button", { name: /切换产品/u })).toHaveTextContent("Daily Brief");
    for (const name of [/切换产品/u, /账号菜单/u]) {
      const trigger = screen.getByRole("button", { name });
      trigger.focus();
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      fireEvent.keyDown(document, { key: "Escape" });
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(trigger).toHaveFocus();
    }
    expect(screen.getByRole("link", { name: "首页" })).toHaveAttribute("href", "/date-companion/a");
  });
  it("uses the real book shell for a new preparation without creating a relationship", () => {
    const session = makeSession({ auth: { status: "authenticated", user: { id: "book-user", email: "book@example.test" } }, relationshipState: { status: "absent" } });
    mockedUseDateCompanionSession.mockReturnValue(session);
    render(<DateCompanionShell entry="companion" screen="prepare" initialDiscussionId="actual-id" />);
    expect(screen.getByTestId("formal-book-preparation")).toHaveTextContent("actual-id");
    expect(screen.getByRole("button", { name: /切换产品/u })).toHaveTextContent("Daily Brief");
    expect(screen.queryByRole("link", { name: "切回旧版" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "准备" })).toHaveAttribute("aria-current", "page");
    expect(session.createRelationship).not.toHaveBeenCalled();
  });
  it("shows the discussion recovery status while account and relationship are still being read", () => {
    mockedUseDateCompanionSession.mockReturnValue(makeSession());
    const props = { entry: "companion", screen: "prepare", initialDiscussionId: "existing" } as const;
    const { rerender } = render(<DateCompanionShell {...props} />);
    const opening = screen.getByRole("status");
    expect(opening).toHaveTextContent("正在恢复这次讨论");
    expect(screen.getByRole("heading", { name: "这次想记得的事" })).toBeInTheDocument();
    mockedUseDateCompanionSession.mockReturnValue(makeSession({ auth: { status: "authenticated", user: { id: "a", email: "a@example.test" } }, relationshipState: { status: "loading" } }));
    rerender(<DateCompanionShell {...props} />);
    expect(screen.getByRole("status")).toBe(opening);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByTestId("formal-book-preparation")).not.toBeInTheDocument();
  });
  it("passes an intentional new draft from live query state without replacing a newly bound real ID", () => {
    mockedUseDateCompanionSession.mockReturnValue(makeSession({ auth: { status: "authenticated", user: { id: "book-user", email: "book@example.test" } }, relationshipState: { status: "absent" } }));
    routerMocks.searchParams = new URLSearchParams("view=book&draft=new");
    const { rerender } = render(<DateCompanionShell entry="companion" screen="prepare" initialDiscussionId="stale-server-id" />);
    expect(screen.getByTestId("formal-book-preparation")).toHaveAttribute("data-target", "new");
    routerMocks.searchParams = new URLSearchParams("view=book&draft=new&preparation=created-id");
    rerender(<DateCompanionShell entry="companion" screen="prepare" initialDiscussionId="stale-server-id" />);
    expect(screen.getByTestId("formal-book-preparation")).toHaveAttribute("data-target", "existing");
    expect(screen.getByTestId("formal-book-preparation")).toHaveTextContent("created-id");
  });

  it("keeps Toy Sync hidden by default and resets the upload form when the authenticated account changes", () => {
    const firstSession = makeSession({
      auth: {
        status: "authenticated",
        user: { id: "account-toy", email: "toy@example.com" }
      },
      relationshipState: {
        status: "ready",
        relationship: {
          id: "relationship-1",
          displayName: "Ta",
          participantState: "unresolved",
          version: 1
        }
      }
    });
    mockedUseDateCompanionSession.mockReturnValue(firstSession);
    const { rerender } = render(<DateCompanionShell entry="companion" screen="home" />);
    expect(screen.queryByTestId("date-companion-toy-sync")).not.toBeInTheDocument();

    rerender(<DateCompanionShell entry="companion" screen="home" toySyncEnabled />);
    fireEvent.click(screen.getByRole("button", {name:"连接玩偶"}));
    expect(screen.getByTestId("date-companion-toy-sync")).toHaveTextContent("account-toy");
    fireEvent.click(screen.getByRole("button", {name:"关闭连接玩偶"}));
    fireEvent.click(screen.getByRole("button", {name:"上传这次相处的录音"}));
    expect(screen.getByRole("form", { name: "上传相处录音" })).toBeInTheDocument();

    const firstAccountFile = new File(["audio"], "first-account.wav", {
      type: "audio/wav"
    });
    fireEvent.change(screen.getByLabelText(/选择录音文件/u), {
      target: { files: [firstAccountFile] }
    });
    expect(screen.getByText("first-account.wav")).toBeInTheDocument();

    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: {
        status: "authenticated",
        user: { id: "account-other", email: "other@example.com" }
      },
      relationshipState: firstSession.relationshipState
    }));
    rerender(<DateCompanionShell entry="companion" screen="home" toySyncEnabled />);

    fireEvent.click(screen.getByRole("button", {name:"连接玩偶"}));
    expect(screen.getByTestId("date-companion-toy-sync")).toHaveTextContent("account-other");
    expect(screen.queryByText("first-account.wav")).not.toBeInTheDocument();
  });

  it("keeps 问问 Ta fail closed with an actionable message until the two people are confirmed", () => {
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: { status: "authenticated", user: { id: "user-1", email: "user@example.com" } },
      relationshipState: {
        status: "ready",
        relationship: { id: "relationship-1", displayName: "Ta", participantState: "confirmed", version: 1 }
      },
      memoryBridgeState: {...readyMemoryBridgeState(), mapping:null},
      personQaAvailability: vi.fn(() => ({
        enabled: false as const,
        message: "先在“人物与长期保留”中确认“我”和“Ta”，再来提问。"
      }))
    }));

    render(<DateCompanionShell entry="companion" screen="home" />);
    fireEvent.click(screen.getByRole("button", { name: "问问 Ta" }));

    expect(screen.getByText(/到「人物」打开「核对我和 Ta」/u)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "你的问题" })).toBeDisabled();
  });

  it("keeps proactive inference out of the Person record while reusing its editable QA suggestion", async () => {
    const retainedSource = {
      id: "snapshot_1",
      uploadId: "upload-1",
      segmentIds: ["segment-1"],
      recordingDate: "2026-08-04",
      startSeconds: 10,
      endSeconds: 15,
      speakerId: "speaker_1",
      quote: "我希望你先听我说完。",
      contentDigest: "a".repeat(64),
      kind: "transcript" as const,
      presentation: "direct_quote" as const,
      canOpenTranscript: false
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 2,
      scope: "person_relationship",
      relationshipId: "relationship-1",
      personId: "person-ta",
      mappingVersion: 2,
      status: "ready",
      sourceFingerprint: "b".repeat(64),
      cacheHit: false,
      value: {
        observation: "Ta 这次更在意你有没有先听完。",
        suggestedQuestions: ["Ta 之前还在哪些时刻提到过类似感受？"],
        reason: "已确认原话与这个观察直接相关。",
        evidenceIds: ["memory_evidence:1"],
        confidence: 0.74,
        caution: "这只是现有记录中的线索，可以继续听 Ta 自己怎么说。"
      },
      evidenceReferences: [{
        evidenceId: "memory_evidence:1",
        uploadId: "upload-1",
        sourceSegmentId: "segment-1",
        recordingDate: "2026-08-04",
        startSeconds: 10,
        endSeconds: 15,
        speakerId: "speaker_1",
        quote: "我希望你先听我说完。",
        contentDigest: "a".repeat(64),
        origin: "direct_conversation",
        subject: "companion"
      }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: { status: "authenticated", user: { id: "user-1", email: "user@example.com" } },
      relationshipState: {
        status: "ready",
        relationship: { id: "relationship-1", displayName: "Ta", participantState: "confirmed", version: 1 }
      },
      memoryBridgeState: confirmedQaMemory([retainedSource]),
      scopedPersonQaSources: () => [retainedSource],
      personQaAvailability: vi.fn(() => ({ enabled: true as const, personId: "person-ta", mappingVersion: 2 })),
      personQaSources: vi.fn(() => [retainedSource])
    }));

    mockedUseDateCompanionPersonArchive.mockReturnValue({status:"ready", archive:{person:confirmedQaMemory().people[1],entries:[]}});
    render(<DateCompanionShell entry="companion" screen="person" />);

    expect(screen.getByRole("heading", { name: "林澄", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "人物" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText("Ta 这次更在意你有没有先听完。")).not.toBeInTheDocument();
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      "/api/date-companion/relationships/relationship-1/proactive-value",
      expect.objectContaining({ method: "GET", credentials: "same-origin" })
    ));
    expect(fetcher).toHaveBeenCalledWith(
      "/api/date-companion/relationships/relationship-1/proactive-value",
      expect.objectContaining({ method: "GET", credentials: "same-origin" })
    );
    fireEvent.click(screen.getByRole("button", { name: "问问 Ta" }));
    openQaSuggestions();
    fireEvent.click(screen.getByRole("button", { name: "Ta 之前还在哪些时刻提到过类似感受？" }));
    expect(screen.getByRole("textbox", { name: "你的问题" })).toHaveValue(
      "Ta 之前还在哪些时刻提到过类似感受？"
    );
  });

  it.each([false, true])("uses canonical home promise sources with self-only=%s and withdraws completed promises", async (selfOnly) => {
    const taSource: SourceRefVM = {
      id: "snapshot_ta", uploadId: "upload-1", segmentIds: ["segment-ta"], recordingDate: "2026-08-04",
      startSeconds: 10, endSeconds: 15, speakerId: "speaker_ta", quote: "我想去看这个展。",
      contentDigest: "a".repeat(64), kind: "transcript", presentation: "direct_quote",
      memorySubject: "companion", canOpenTranscript: true
    };
    const selfSource: SourceRefVM = {
      ...taSource, id: "snapshot_self", segmentIds: ["segment-self"], speakerId: "speaker_self",
      quote: "我来查一下展览的开放时间。", contentDigest: "c".repeat(64), memorySubject: "self"
    };
    const generated = {
      schemaVersion: 2, scope: "person_relationship", relationshipId: "relationship-1", personId: "person-ta",
      mappingVersion: 2, status: "ready", sourceFingerprint: "b".repeat(64), cacheHit: false,
      value: {
        home: {
          about: selfOnly ? [] : [{ kind: "preference", text: "Ta 想去看上次聊到的展览。", evidenceIds: ["snapshot_ta"] }],
          beforeMeeting: [{ kind: "open_promise", text: "查一下展览的开放时间。", reason: "你上次答应查好时间。", promiseId: "promise-1", evidenceIds: ["snapshot_self"] }]
        },
        evidenceIds: selfOnly ? ["snapshot_self"] : ["snapshot_ta", "snapshot_self"]
      },
      evidenceReferences: (selfOnly ? [selfSource] : [taSource, selfSource]).map((source) => ({
        evidenceId: source.id, uploadId: source.uploadId, sourceSegmentId: source.segmentIds[0],
        recordingDate: source.recordingDate, startSeconds: source.startSeconds, endSeconds: source.endSeconds,
        speakerId: source.speakerId, quote: source.quote, contentDigest: source.contentDigest,
        origin: "direct_conversation", subject: source.memorySubject
      }))
    };
    let resolveRefresh!: (value: Response) => void;
    const readProactiveValue = vi.fn()
      .mockResolvedValueOnce(Response.json(generated))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveRefresh = resolve; }));
    const fetcher = vi.fn(async (path: string) => {
      if (path === "/api/date-companion/preparations") return Response.json({preparations:[]});
      expect(path).toBe("/api/date-companion/relationships/relationship-1/proactive-value");
      return readProactiveValue();
    });
    vi.stubGlobal("fetch", fetcher);
    const model = emptyDateCompanionViewModel();
    model.person.promises = [{
      id: "promise-1", relationshipId: "relationship-1", originatingRecapItemId: "recap-1",
      text: selfSource.quote, status: "open", version: 1, sources: [selfSource]
    }];
    const rawItem = {
      id: "raw-1", kind: "mentioned" as const, title: "Ta 提到的", proposedText: "混乱的原始长转写不能作为首页摘要",
      displayedText: "混乱的原始长转写不能作为首页摘要", disposition: "kept" as const, sources: [taSource]
    };
    model.person.recent = [rawItem];
    model.home.preparePreview = rawItem;
    const personQaSources = vi.fn(() => selfOnly ? [] : [taSource]);
    const selectCachedInteraction = vi.fn(() => true);
    const session = makeSession({
      auth: { status: "authenticated", user: { id: "user-1", email: "user@example.com" } },
      viewModel: model,
      relationshipState: { status: "ready", relationship: { id: "relationship-1", displayName: "小林", participantState: "confirmed", version: 1 } },
      memoryBridgeState: confirmedQaMemory(personQaSources()), personQaSources, scopedPersonQaSources: personQaSources, selectCachedInteraction,
      personQaAvailability: vi.fn(() => selfOnly ? { enabled: false as const, message: "还没有可用于人物提问的内容。" }
        : { enabled: true as const, personId: "person-ta", mappingVersion: 2 })
    });
    mockedUseDateCompanionSession.mockReturnValue(session);
    const { rerender } = render(<DateCompanionShell entry="companion" screen="home" />);
    expect(await screen.findByText("查一下展览的开放时间。")).toBeInTheDocument();
    if (!selfOnly) expect(screen.getByText("Ta 想去看上次聊到的展览。")).toBeInTheDocument();
    expect(screen.queryByText(rawItem.displayedText)).not.toBeInTheDocument();
    expect(personQaSources()).toEqual(selfOnly ? [] : [taSource]);
    const preparation = screen.getByRole("region", { name: "下次见面前" });
    fireEvent.click(within(preparation).getByText("查看原话"));
    fireEvent.click(within(preparation).getByRole("button", { name: "在完整文字稿中查看" }));
    expect(routerMocks.push).toHaveBeenCalledWith("/date-companion/a/recap?recording=upload-1&segment=segment-self#full-transcript");
    if (!selfOnly) {
      fireEvent.click(screen.getByRole("button", { name: "问问 Ta" }));
      const question = "关于「Ta 想去看上次聊到的展览。」，当时具体说了什么？";
      openQaSuggestions();
      fireEvent.click(screen.getByRole("button", { name: question }));
      expect(screen.getByRole("textbox", { name: "你的问题" })).toHaveValue(question);
      expect(screen.queryByRole("button", { name: /关于「查一下展览的开放时间/u })).not.toBeInTheDocument();
    }

    mockedUseDateCompanionSession.mockReturnValue({
      ...session,
      viewModel: { ...model, person: { ...model.person, promises: [{ ...model.person.promises[0], status: "done", version: 2 }] } }
    });
    rerender(<DateCompanionShell entry="companion" screen="home" />);
    expect(screen.queryByText("查一下展览的开放时间。")).not.toBeInTheDocument();
    await waitFor(() => expect(readProactiveValue).toHaveBeenCalledTimes(2));
    expect(screen.getByText("正在读取人物近况与见面准备…")).toBeInTheDocument();
    await act(async () => resolveRefresh(new Response(JSON.stringify(generated), { status: 200 })));
    expect(screen.getByText("原有依据已经变更或无法核对，请重新读取。")).toBeInTheDocument();
    expect(screen.queryByText("查一下展览的开放时间。")).not.toBeInTheDocument();
    expect(screen.queryByText(rawItem.displayedText)).not.toBeInTheDocument();
  });

  it.each([
    ["person-self", "the current account self"],
    ["person-unknown", "an unavailable or cross-account id"]
  ])("fails closed for a Person deep link targeting %s (%s)", (initialPersonId) => {
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: { status: "authenticated", user: { id: "user-1", email: "user@example.com" } },
      relationshipState: {
        status: "ready",
        relationship: { id: "relationship-1", displayName: "Ta", participantState: "confirmed", version: 1 }
      },
      memoryBridgeState: readyMemoryBridgeState()
    }));

    render(<DateCompanionShell entry="companion" initialPersonId={initialPersonId} screen="person" />);
    expect(screen.getByRole("heading", { name: "没有找到这位人物" })).toBeVisible();
    expect(mockedUseDateCompanionPersonArchive).toHaveBeenCalledWith(null, expect.any(String), 0);
  });

  it("restores a confirmed recap from the URL and loads its current-interaction observation", async () => {
    const interaction = {
      ...readyInteraction(),
      relationshipInteractionId: "interaction-1",
      persistenceStatus: "confirmed" as const,
      version: 3
    };
    const viewModel = viewModelWithInteraction(interaction);
    const currentSource: SourceRefVM = {
      id: "snapshot-1",
      uploadId: "upload-1",
      segmentIds: ["segment-1"],
      recordingDate: "2026-08-04",
      startSeconds: 10,
      endSeconds: 15,
      speakerId: "speaker_1",
      quote: "下次可以一起看电影。",
      contentDigest: "d".repeat(64),
      kind: "transcript",
      presentation: "direct_quote",
      canOpenTranscript: true
    };
    viewModel.recap.items = [{
      id: "moment-1",
      kind: "moment",
      title: "这次值得记住",
      proposedText: "一起聊了下次想看的电影",
      displayedText: "一起聊了下次想看的电影",
      disposition: "kept",
      sources: [currentSource]
    }];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/interactions/interaction-1/")) {
        return new Response(JSON.stringify({
          schemaVersion: 2,
          scope: "current_interaction",
          relationshipId: "relationship-1",
          interactionId: "interaction-1",
          mappingVersion: 2,
          status: "fallback",
          sourceFingerprint: "c".repeat(64),
          cacheHit: false,
          value: {
            observation: "这次你们都给下次相处留了一个自然入口。",
            suggestedQuestions: ["这次提到的下次计划是什么？"],
            reason: "已有一段确认原话。",
            evidenceIds: ["dc_snapshot:snapshot-1"],
            confidence: 0.61,
            caution: "这只是这一次相处中的线索。"
          },
          evidenceReferences: [{
            evidenceId: "dc_snapshot:snapshot-1",
            uploadId: "upload-1",
            sourceSegmentId: "segment-1",
            recordingDate: "2026-08-04",
            startSeconds: 10,
            endSeconds: 15,
            speakerId: "speaker_1",
            quote: "下次可以一起看电影。",
            contentDigest: "d".repeat(64),
            origin: "direct_conversation",
            subject: "both"
          }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        schemaVersion: 2,
        scope: "person_relationship",
        relationshipId: "relationship-1",
        personId: "person-ta",
        mappingVersion: null,
        status: "unavailable",
        cacheHit: false,
        evidenceReferences: [],
        failureCode: "context_unavailable"
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);
    const selectRelationshipInteraction = vi.fn(() => true);
    const restoredSession = makeSession({
      auth: { status: "authenticated", user: { id: "user-1", email: "user@example.com" } },
      viewModel,
      relationshipState: {
        status: "ready",
        relationship: { id: "relationship-1", displayName: "Ta", participantState: "confirmed", version: 1 }
      },
      memoryBridgeState: readyMemoryBridgeState(),
      personQaAvailability: vi.fn(() => ({ enabled: true as const, personId: "person-ta", mappingVersion: 2 })),
      currentInteractionQaAvailability: vi.fn(() => ({ enabled: true as const, uploadId: "upload-1" })),
      selectRelationshipInteraction
    });
    const fallbackViewModel = viewModelWithInteraction({
      ...interaction,
      relationshipInteractionId: "interaction-old"
    });
    fallbackViewModel.recap.items = viewModel.recap.items;
    mockedUseDateCompanionSession.mockReturnValue({
      ...restoredSession,
      viewModel: fallbackViewModel
    });

    const rendered = render(
      <DateCompanionShell
        entry="companion"
        initialInteractionId="interaction-1"
        screen="recap"
      />
    );

    expect(screen.getByText("正在找回这次相处…")).toBeInTheDocument();
    await waitFor(() => expect(selectRelationshipInteraction).toHaveBeenCalledWith("interaction-1"));
    expect(fetcher.mock.calls.some(([input]) => String(input).includes("/interactions/interaction-old/"))).toBe(false);

    const summaryViewModel = { ...viewModel, recap: { ...viewModel.recap,
      interaction: { ...interaction, detailLoaded: false }, items: [] } };
    mockedUseDateCompanionSession.mockReturnValue({ ...restoredSession, viewModel: summaryViewModel });
    rendered.rerender(<DateCompanionShell entry="companion" initialInteractionId="interaction-1" screen="recap" />);
    expect(screen.getByText("正在读取相处内容…")).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([input]) => String(input).includes("/interactions/interaction-1/proactive-value"))).toBe(false);

    mockedUseDateCompanionSession.mockReturnValue(restoredSession);
    rendered.rerender(
      <DateCompanionShell
        entry="companion"
        initialInteractionId="interaction-1"
        screen="recap"
      />
    );
    expect(screen.getByRole("heading", { name: "本次复盘已完成" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", {name:"原话线索"}));
    expect(screen.getByText("这次你们都给下次相处留了一个自然入口。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name:"关闭原话线索"}));
    expect(fetcher).toHaveBeenCalledWith(
      "/api/date-companion/interactions/interaction-1/proactive-value",
      expect.objectContaining({ method: "GET", credentials: "same-origin" })
    );
    fireEvent.click(screen.getByRole("button", { name: "问问这次相处" }));
    openQaSuggestions();
    fireEvent.click(screen.getByRole("button", { name: "这次提到的下次计划是什么？" }));
    expect(screen.getByRole("textbox", { name: "你的问题" })).toHaveValue(
      "这次提到的下次计划是什么？"
    );
  });

  it("confirms speaker assignments and automatic recap decisions through one session mutation", async () => {
    const interaction = {
      ...readyInteraction(),
      relationshipInteractionId: "interaction-1",
      persistenceStatus: "draft" as const,
      version: 7
    };
    const viewModel = viewModelWithInteraction(interaction);
    viewModel.recap.items = [{
      id: "moment-1",
      kind: "moment",
      title: "这次值得记住",
      proposedText: "一起认真聊了很久",
      displayedText: "一起认真聊了很久",
      disposition: "pending",
      version: 2,
      sources: [{
        id: "source-1",
        uploadId: "upload-1",
        segmentIds: ["segment-1"],
        recordingDate: "2026-08-04",
        startSeconds: 10,
        endSeconds: 15,
        speakerId: "speaker_1",
        quote: "下次可以一起看电影。",
        kind: "transcript",
        presentation: "direct_quote"
      }]
    }];
    viewModel.recap.participants = [{
      speakerId: "speaker_1",
      audioSpeakerId: "speaker_1",
      voiceEnrollmentEligible: true,
      displayLabel: "说话人 1",
      state: "unresolved",
      role: "unresolved",
      sampleQuotes: []
    }];
    const finalizeRecap = vi.fn(async () => undefined);
    const updateParticipants = vi.fn(async () => undefined);
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: { status: "authenticated", user: { id: "user-1", email: "user@example.com" } },
      viewModel,
      relationshipState: {
        status: "ready",
        relationship: { id: "relationship-1", participantState: "unresolved", version: 1 }
      },
      finalizeRecap,
      updateParticipants
    }));

    render(<DateCompanionShell entry="companion" screen="recap" />);
    expect(document.querySelector('main[data-screen="recap"]')).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "单次复盘" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", {name:/^核对说话人$/u})[0]);
    const speakers=screen.getByRole("dialog", {name:"核对说话人"});
    fireEvent.click(within(speakers).getByRole("button", {name:"Ta"}));
    fireEvent.click(within(speakers).getByRole("checkbox", { name: /记住这段声音/u }));
    fireEvent.click(within(speakers).getByRole("button", {name:"返回复盘"}));
    fireEvent.click(screen.getByRole("button", { name: "完成本次复盘" }));

    await waitFor(() => expect(finalizeRecap).toHaveBeenCalledWith(
      "interaction-1",
      7,
      [{ speakerId: "speaker_1", role: "companion" }],
      [{ id: "moment-1", version: 2, disposition: "kept" }],
      [{ speakerIds: ["speaker_1"] }]
    ));
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(updateParticipants).not.toHaveBeenCalled();
  });

  it("selects a confirmed historical recap from the URL and safely rejects an unknown one", async () => {
    const selectRelationshipInteraction = vi.fn((interactionId: string | null) =>
      interactionId !== "interaction-missing"
    );
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: { status: "authenticated", user: { id: "user-1", email: "user@example.com" } },
      relationshipState: {
        status: "ready",
        relationship: { id: "relationship-1", participantState: "confirmed", version: 1 }
      },
      selectRelationshipInteraction
    }));

    const { rerender } = render(
      <DateCompanionShell entry="companion" initialInteractionId="interaction-history" screen="recap" />
    );
    await waitFor(() => expect(selectRelationshipInteraction).toHaveBeenCalledWith("interaction-history"));

    rerender(<DateCompanionShell entry="companion" screen="recap" />);
    await waitFor(() => expect(selectRelationshipInteraction).toHaveBeenLastCalledWith(null));

    rerender(
      <DateCompanionShell entry="companion" initialInteractionId="interaction-missing" screen="recap" />
    );
    await waitFor(() => expect(selectRelationshipInteraction).toHaveBeenLastCalledWith("interaction-missing"));
    expect(routerMocks.replace).toHaveBeenCalledWith("/date-companion/a");
  });

  it("opens the saved recap for an old recording link after raw upload cleanup", () => {
    const model = emptyDateCompanionViewModel();
    const saved: InteractionVM = {
      ...readyInteraction(), id: "upload-cleaned", sourceUploadId: "upload-cleaned",
      relationshipInteractionId: "meeting-saved", persistenceStatus: "confirmed", sourceState: "server_cleaned"
    };
    model.recap.history = [saved];
    const session = makeSession({
      auth: {status:"authenticated", user:{id:"user-1", email:"user@example.com"}},
      relationshipState: {status:"ready", relationship:{id:"relationship-1",participantState:"confirmed",version:1}},
      viewModel: model, selectRelationshipInteraction: vi.fn(() => true)
    });
    mockedUseDateCompanionSession.mockReturnValue(session);
    const page = () => <DateCompanionShell entry="companion" screen="recap" initialRecordingId="upload-cleaned" />;
    const { rerender } = render(page());
    expect(session.selectRelationshipInteraction).toHaveBeenCalledWith("meeting-saved");
    expect(session.readRecordingForRecap).not.toHaveBeenCalled();
    mockedUseDateCompanionSession.mockReturnValue({...session, viewModel:{...model,recap:{...model.recap,interaction:saved}}});
    rerender(page());
    expect(screen.getByRole("article", {name:"单次复盘"})).toBeVisible();
    expect(routerMocks.replace).not.toHaveBeenCalled();
  });

  it.each([false, true])("uses the owned-upload endpoint for a recording outside readable history (%s)", async expired => {
    const model = emptyDateCompanionViewModel();
    if (expired) model.recap.history = [{
      ...readyInteraction(), sourceUploadId: "upload-1", relationshipInteractionId:"deleted-meeting",
      persistenceStatus:"confirmed",sourceState:"explicitly_deleted"
    }];
    const session = makeSession({
      auth: {status:"authenticated",user:{id:"user-1",email:"user@example.com"}},
      relationshipState: {status:"ready",relationship:{id:"relationship-1",participantState:"confirmed",version:1}},
      viewModel: model
    });
    mockedUseDateCompanionSession.mockReturnValue(session);
    render(<DateCompanionShell entry="companion" screen="recap" initialRecordingId="upload-1" />);
    expect(session.readRecordingForRecap).toHaveBeenCalledWith("upload-1", expect.any(AbortSignal));
    expect(session.selectRelationshipInteraction).not.toHaveBeenCalled();
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/date-companion/a"));
  });

  it("keeps an evidence-only historical recap read-only while Person-scoped QA remains available", () => {
    const historicalInteraction: InteractionVM = {
      ...readyInteraction(),
      id: "upload-history",
      sourceUploadId: "upload-history",
      relationshipInteractionId: "interaction-history",
      persistenceStatus: "confirmed",
      transcript: []
    };
    const viewModel = emptyDateCompanionViewModel();
    viewModel.recap.interaction = historicalInteraction;
    viewModel.recap.items = [{
      id: "moment-history",
      kind: "moment",
      title: "这次值得记住",
      proposedText: "一起认真聊了很久。",
      displayedText: "一起认真聊了很久。",
      disposition: "kept",
      version: 1,
      sources: [{
        id: "source-history",
        uploadId: "upload-history",
        segmentIds: ["segment-history"],
        recordingDate: "2026-08-03",
        startSeconds: 10,
        endSeconds: 15,
        speakerId: "speaker_1",
        quote: "我们下次接着聊。",
        kind: "transcript",
        presentation: "direct_quote",
        canOpenTranscript: false
      }]
    }];
    viewModel.person.interactions = [historicalInteraction];
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: { status: "authenticated", user: { id: "user-1", email: "user@example.com" } },
      viewModel,
      relationshipState: {
        status: "ready",
        relationship: { id: "relationship-1", participantState: "confirmed", version: 1 }
      },
      currentInteractionQaAvailability: vi.fn(() => ({
        enabled: false as const,
        reason: "missing_local_transcript" as const,
        message: "这台设备没有这场录音的完整文字稿，暂时无法针对这场提问。"
      })),
      personQaAvailability: vi.fn(() => ({ enabled: true as const, personId: "person-ta", mappingVersion: 2 })),
      memoryBridgeState: confirmedQaMemory(),
      scopedPersonQaSources: () => [qaSource],
      selectRelationshipInteraction: vi.fn(() => true)
    }));

    render(
      <DateCompanionShell entry="companion" initialInteractionId="interaction-history" screen="recap" />
    );

    expect(screen.getByRole("heading", {name:"本次复盘已完成"})).toBeInTheDocument();
    expect(screen.getByRole("button", {name:"已保存的来源片段"})).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认并留下这次相处" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "在文字稿中查看" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "问问这次相处" }));
    expect(screen.getByRole("textbox", { name: "你的问题" })).toBeDisabled();
    expect(screen.getByText(/这台设备没有这场录音的完整文字稿/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭问答" }));
    fireEvent.click(screen.getByRole("button", { name: "问问 Ta" }));
    expect(screen.getByRole("textbox", { name: "你的问题" })).toBeEnabled();
  });

  it("shows both explicit QA entries on a ready recap and routes each drawer to its own session mode", () => {
    const interaction = readyInteraction();
    const activateQaMode = vi.fn();
    const askCurrentInteraction = vi.fn(async () => null);
    const ask = vi.fn(async () => null);
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: { status: "authenticated", user: { id: "user-1", email: "user@example.com" } },
      viewModel: viewModelWithInteraction(interaction),
      relationshipState: {
        status: "ready",
        relationship: { id: "relationship-1", participantState: "confirmed", version: 1 }
      },
      currentInteractionQaAvailability: vi.fn(() => ({ enabled: true as const, uploadId: "upload-1" })),
      personQaAvailability: vi.fn(() => ({ enabled: true as const, personId: "person-ta", mappingVersion: 2 })),
      memoryBridgeState: confirmedQaMemory(),
      scopedPersonQaSources: () => [qaSource],
      activateQaMode,
      askCurrentInteraction,
      ask
    }));

    render(<DateCompanionShell entry="companion" screen="recap" />);

    expect(screen.getByRole("button", { name: "问问这次相处" })).toBeVisible();
    expect(screen.getByRole("button", { name: "问问 Ta" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "问问这次相处" }));
    expect(activateQaMode).toHaveBeenCalledWith("current-interaction");
    fireEvent.change(screen.getByRole("textbox", { name: "你的问题" }), {
      target: { value: "这次聊了什么？" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(askCurrentInteraction).toHaveBeenCalledWith("这次聊了什么？");
    fireEvent.click(screen.getByRole("button", { name: "关闭问答" }));

    fireEvent.click(screen.getByRole("button", { name: "问问 Ta" }));
    expect(activateQaMode).toHaveBeenCalledWith("person");
    fireEvent.change(screen.getByRole("textbox", { name: "你的问题" }), {
      target: { value: "Ta 以前说过什么？" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(ask).toHaveBeenCalledWith("Ta 以前说过什么？");
  });

  it("keeps a failed QA question retryable without exposing an internal stream code", async () => {
    const interaction = readyInteraction();
    const question = "Ta 这次最在意什么？";
    const ask = vi.fn(() => new Promise<null>(() => {}));
    const session = makeSession({
      auth: { status: "authenticated", user: { id: "user-1", email: "user@example.com" } },
      viewModel: viewModelWithInteraction(interaction),
      relationshipState: { status: "ready", relationship: { id: "relationship-1", participantState: "confirmed", version: 1 } },
      memoryBridgeState: confirmedQaMemory(),
      personQaAvailability: () => ({ enabled:true,personId:"person-ta",mappingVersion:2 }),
      scopedPersonQaSources: () => [qaSource],
      ask
    });
    mockedUseDateCompanionSession.mockReturnValue(session);
    const { rerender } = render(<DateCompanionShell entry="companion" screen="home" />);
    fireEvent.click(screen.getByRole("button", { name: "问问 Ta" }));
    const input=screen.getByRole("textbox", {name:"你的问题"});
    fireEvent.change(input, {target:{value:question}});
    fireEvent.click(screen.getByRole("button", {name:"发送"}));
    mockedUseDateCompanionSession.mockReturnValue({...session,qaState:{status:"failed",question,message:"qa_stream_failed"}});
    rerender(<DateCompanionShell entry="companion" screen="home" />);
    const retry=await screen.findByRole("button", {name:"重试这次回答"});
    expect(screen.getByText("这次回答未能生成。")).toBeVisible();
    expect(screen.queryByText("qa_stream_failed")).not.toBeInTheDocument();
    fireEvent.click(retry);
    expect(ask.mock.calls).toEqual([[question],[question]]);
  });

  it("keeps a ready recap CTA and exposes a retryable warning when local caching fails but server data remains", () => {
    const interaction = readyInteraction();
    const retryRead = vi.fn(async () => undefined);
    const cacheMessage = "本机保存失败，服务端结果仍保留，尚未清理：浏览器存储空间不足";
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: {
        status: "authenticated",
        user: { id: "user-1", email: "user@example.com" }
      },
      viewModel: viewModelWithInteraction(interaction),
      relationshipState: {
        status: "ready",
        relationship: { id: "relationship-1", participantState: "confirmed", version: 1 }
      },
      uploadState: {
        status: "failed",
        uploadId: interaction.id,
        message: cacheMessage,
        failureStage: "cache",
        serverDataRetained: true
      },
      retryRead
    }));

    render(<DateCompanionShell entry="companion" screen="home" />);

    const retryButton = screen.getByRole("button", { name: "重新读取结果" });
    expect(screen.getByRole("alert")).toHaveTextContent(cacheMessage);
    expect(screen.getByRole("link", { name: /查看录音复盘/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /查看详情/ })).not.toBeInTheDocument();

    fireEvent.click(retryButton);
    expect(retryRead).toHaveBeenCalledTimes(1);
  });

  it("keeps the ready result visible and offers retry when server cleanup has not completed", () => {
    const interaction = readyInteraction();
    const retryRead = vi.fn(async () => undefined);
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: {
        status: "authenticated",
        user: { id: "user-1", email: "user@example.com" }
      },
      viewModel: viewModelWithInteraction(interaction),
      relationshipState: {
        status: "ready",
        relationship: { id: "relationship-1", participantState: "confirmed", version: 1 }
      },
      uploadState: {
        status: "ready",
        uploadId: interaction.id,
        cacheStatus: "saved",
        serverCleanupStatus: "not_completed",
        cleanupMessage: "服务器数据尚未清理"
      },
      retryRead
    }));

    render(<DateCompanionShell entry="companion" screen="home" />);

    expect(screen.getAllByRole("link", { name: /查看录音复盘/u }).length).toBeGreaterThan(0);
    const warning = screen.getAllByRole("alert").find((candidate) => candidate.textContent?.includes("服务器原结果尚未清理"));
    expect(warning).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "重新读取结果" }));
    expect(retryRead).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing explicit relationship setup for the recording recap entry", async () => {
    const createRelationship = vi.fn(async () => undefined);
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: {
        status: "authenticated",
        user: { id: "user-1", email: "user@example.com" }
      },
      relationshipState: { status: "absent" },
      createRelationship
    }));

    render(<DateCompanionShell entry="companion" screen="recap" />);
    expect(screen.getByRole("heading", { name: "你想怎样称呼 Ta？" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("称呼（可选）"), { target: { value: "  小林  " } });
    fireEvent.click(screen.getByRole("button", { name: /开始记录这段关系/u }));
    await waitFor(() => expect(createRelationship).toHaveBeenCalledWith("小林"));
  });
});
