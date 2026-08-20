import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDateCompanionSession, type DateCompanionSessionValue } from "@/lib/client/date-companion-session";
import {
  emptyDateCompanionViewModel,
  type DateCompanionMemoryBridgeState,
  type DateCompanionViewModel,
  type InteractionVM,
  type SourceRefVM
} from "@/lib/domain/date-companion";

import { DateCompanionShell } from "./date-companion-shell";

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn()
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerMocks.push, replace: routerMocks.replace })
}));

vi.mock("@/lib/client/date-companion-session", () => ({
  useDateCompanionSession: vi.fn()
}));

vi.mock("@/components/daily-reflection/daily-reflection-toy-sync", () => ({
  ToyAudioSync: ({ accountId }: { accountId: string }) => (
    <div data-testid="date-companion-toy-sync">{accountId}</div>
  )
}));

const mockedUseDateCompanionSession = vi.mocked(useDateCompanionSession);

function makeSession(overrides: Partial<DateCompanionSessionValue> = {}): DateCompanionSessionValue {
  return {
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
    personQaAvailability: vi.fn(() => ({ enabled: false as const, message: "先确认人物设置。" })),
    currentInteractionQaAvailability: vi.fn(() => ({ enabled: false as const, message: "先打开一次完整记录。" })),
    activateQaMode: vi.fn(),
    ensureMemoryBridgeLoaded: vi.fn(async () => undefined),
    createConfirmedPerson: vi.fn(async () => undefined),
    savePersonMapping: vi.fn(async () => undefined),
    setLongTermRetention: vi.fn(async () => undefined),
    syncInteractionMemory: vi.fn(async () => undefined),
    purgeRetainedMemory: vi.fn(async () => undefined),
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

function readyMemoryBridgeState(personQaSources: SourceRefVM[] = []): DateCompanionMemoryBridgeState {
  return {
    status: "ready",
    people: [],
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

describe("DateCompanionShell", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
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

  it("replaces the login route with module selection after authentication", async () => {
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: {
        status: "authenticated",
        user: { id: "user-1", email: "user@example.com" }
      }
    }));

    render(<DateCompanionShell entry="login" />);

    expect(screen.getByRole("status")).toHaveTextContent("正在进入你的空间…");
    await waitFor(() => expect(routerMocks.replace).toHaveBeenCalledWith("/date-companion/modules"));
  });

  it("logs out from module selection and replaces the route with login", async () => {
    const logout = vi.fn(async () => undefined);
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: {
        status: "authenticated",
        user: { id: "user-1", email: "user@example.com", name: "小满" }
      },
      logout
    }));

    render(<DateCompanionShell entry="modules" />);
    fireEvent.click(screen.getByRole("button", { name: "退出" }));

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    expect(routerMocks.replace).toHaveBeenCalledWith("/date-companion");
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
      ask
    }));

    render(<DateCompanionShell entry="companion" screen="home" />);

    expect(screen.getByRole("link", { name: "此刻" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("约会陪伴 · 小林")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "你和 小林" })).toBeInTheDocument();
    expect(screen.getByText("Ta 最近在准备考试")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "问问 Ta" }));
    expect(screen.getByRole("textbox", { name: "向 Ta 的相处记录提问" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Ta 以前明确提到过哪些在意的事/u }));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(ask).toHaveBeenCalledWith("Ta 以前明确提到过哪些在意的事？");
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
    expect(screen.getByTestId("date-companion-toy-sync")).toHaveTextContent("account-toy");
    expect(screen.getByRole("form", { name: "上传相处录音" })).toBeInTheDocument();

    const firstAccountFile = new File(["audio"], "first-account.wav", {
      type: "audio/wav"
    });
    fireEvent.change(screen.getByLabelText(/选择一段完整录音/u), {
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
      personQaAvailability: vi.fn(() => ({
        enabled: false as const,
        message: "先在“人物与长期保留”中确认“我”和“Ta”，再来提问。"
      }))
    }));

    render(<DateCompanionShell entry="companion" screen="home" />);
    fireEvent.click(screen.getByRole("button", { name: "问问 Ta" }));

    expect(screen.getByText("先在“人物与长期保留”中确认“我”和“Ta”，再来提问。")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "向 Ta 的相处记录提问" })).toBeDisabled();
  });

  it("wires the relationship observation and its editable suggested question without blocking the person page", async () => {
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
      memoryBridgeState: readyMemoryBridgeState([retainedSource]),
      personQaAvailability: vi.fn(() => ({ enabled: true as const, personId: "person-ta", mappingVersion: 2 })),
      personQaSources: vi.fn(() => [retainedSource])
    }));

    render(<DateCompanionShell entry="companion" screen="person" />);

    expect(screen.getByRole("heading", { name: "关于你们的一点观察" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Ta 这次更在意你有没有先听完。")).toBeInTheDocument());
    expect(fetcher).toHaveBeenCalledWith(
      "/api/date-companion/relationships/relationship-1/proactive-value",
      expect.objectContaining({ method: "GET", credentials: "same-origin" })
    );
    fireEvent.click(screen.getByRole("button", { name: "问问 Ta" }));
    fireEvent.click(screen.getByRole("button", { name: "Ta 之前还在哪些时刻提到过类似感受？" }));
    expect(screen.getByRole("textbox", { name: "向 Ta 的相处记录提问" })).toHaveValue(
      "Ta 之前还在哪些时刻提到过类似感受？"
    );
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

    mockedUseDateCompanionSession.mockReturnValue(restoredSession);
    rendered.rerender(
      <DateCompanionShell
        entry="companion"
        initialInteractionId="interaction-1"
        screen="recap"
      />
    );
    expect(screen.getByLabelText("本次录音整理阶段")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("这次你们都给下次相处留了一个自然入口。")).toBeInTheDocument());
    expect(fetcher).toHaveBeenCalledWith(
      "/api/date-companion/interactions/interaction-1/proactive-value",
      expect.objectContaining({ method: "GET", credentials: "same-origin" })
    );
    fireEvent.click(screen.getByRole("button", { name: "问问这次相处" }));
    fireEvent.click(screen.getByRole("button", { name: "这次提到的下次计划是什么？" }));
    expect(screen.getByRole("textbox", { name: "针对这次相处提问" })).toHaveValue(
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
    expect(screen.getByRole("main")).toHaveAttribute("data-screen", "recap");
    expect(screen.getByRole("region", { name: "这次相处详情" })).toHaveAttribute("tabindex", "0");
    fireEvent.click(screen.getByRole("button", { name: "Ta" }));
    fireEvent.click(screen.getByRole("radio", { name: /记住这段声音/u }));
    fireEvent.click(screen.getByRole("button", { name: "确认并留下这次相处" }));

    await waitFor(() => expect(finalizeRecap).toHaveBeenCalledWith(
      "interaction-1",
      7,
      [{ speakerId: "speaker_1", role: "companion" }],
      [{ id: "moment-1", version: 2, disposition: "kept" }],
      [{ speakerIds: ["speaker_1"] }]
    ));
    expect(routerMocks.replace).toHaveBeenCalledWith(
      "/date-companion/a/recap?interaction=interaction-1"
    );
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
        message: "这台设备没有保存这次相处的完整文字稿，仍可以使用“问问 Ta”回看已确认内容。"
      })),
      personQaAvailability: vi.fn(() => ({ enabled: true as const, personId: "person-ta", mappingVersion: 2 })),
      selectRelationshipInteraction: vi.fn(() => true)
    }));

    render(
      <DateCompanionShell entry="companion" initialInteractionId="interaction-history" screen="recap" />
    );

    expect(screen.getByText("一起认真聊了很久。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认并留下这次相处" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "在文字稿中查看" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "问问这次相处" }));
    expect(screen.getByRole("textbox", { name: "针对这次相处提问" })).toBeDisabled();
    expect(screen.getByText(/这台设备没有保存这次相处的完整文字稿/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: "问问 Ta" }));
    expect(screen.getByRole("textbox", { name: "向 Ta 的相处记录提问" })).toBeEnabled();
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
      activateQaMode,
      askCurrentInteraction,
      ask
    }));

    render(<DateCompanionShell entry="companion" screen="recap" />);

    expect(screen.getByRole("button", { name: "问问这次相处" })).toBeVisible();
    expect(screen.getByRole("button", { name: "问问 Ta" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "问问这次相处" }));
    expect(activateQaMode).toHaveBeenCalledWith("current-interaction");
    fireEvent.change(screen.getByRole("textbox", { name: "针对这次相处提问" }), {
      target: { value: "这次聊了什么？" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(askCurrentInteraction).toHaveBeenCalledWith("这次聊了什么？");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    fireEvent.click(screen.getByRole("button", { name: "问问 Ta" }));
    expect(activateQaMode).toHaveBeenCalledWith("person");
    fireEvent.change(screen.getByRole("textbox", { name: "向 Ta 的相处记录提问" }), {
      target: { value: "Ta 以前说过什么？" }
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(ask).toHaveBeenCalledWith("Ta 以前说过什么？");
  });

  it("keeps a failed QA question retryable without exposing an internal stream code", () => {
    const interaction = readyInteraction();
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
        serverCleanupStatus: "completed"
      },
      qaState: {
        status: "failed",
        question: "Ta 这次最在意什么？",
        message: "qa_stream_failed"
      }
    }));

    render(<DateCompanionShell entry="companion" screen="home" />);
    fireEvent.click(screen.getByRole("button", { name: "问问 Ta" }));

    expect(screen.getByRole("alert")).toHaveTextContent("回答服务暂时没有完成这次提问，请重新发送。");
    expect(screen.queryByText("qa_stream_failed")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "向 Ta 的相处记录提问" })).toHaveValue("Ta 这次最在意什么？");
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

    const { container } = render(<DateCompanionShell entry="companion" screen="home" />);

    const details = container.querySelector("details");
    expect(details).not.toHaveAttribute("open");
    const retryButton = screen.getByRole("button", { name: "重新读取" });
    expect(retryButton.closest('[role="alert"]')).toHaveTextContent(cacheMessage);
    const recapLinks = screen.getAllByRole("link", { name: /查看这次复盘/ });
    expect(recapLinks.some((link) => !details?.contains(link))).toBe(true);
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

    expect(screen.getAllByRole("link", { name: /查看这次复盘/u }).length).toBeGreaterThan(0);
    const warning = screen.getAllByRole("alert").find((candidate) => candidate.textContent?.includes("服务器原结果尚未清理"));
    expect(warning).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(retryRead).toHaveBeenCalledTimes(1);
  });

  it("requires the user to create the single relationship explicitly", async () => {
    const createRelationship = vi.fn(async () => undefined);
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: {
        status: "authenticated",
        user: { id: "user-1", email: "user@example.com" }
      },
      relationshipState: { status: "absent" },
      createRelationship
    }));

    render(<DateCompanionShell entry="companion" screen="home" />);
    expect(screen.getByRole("heading", { name: "你想怎样称呼 Ta？" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("称呼（可选）"), { target: { value: "  小林  " } });
    fireEvent.click(screen.getByRole("button", { name: /开始记录这段关系/u }));
    await waitFor(() => expect(createRelationship).toHaveBeenCalledWith("小林"));
  });
});
