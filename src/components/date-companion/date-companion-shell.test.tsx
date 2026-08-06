import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDateCompanionSession, type DateCompanionSessionValue } from "@/lib/client/date-companion-session";
import {
  emptyDateCompanionViewModel,
  type DateCompanionViewModel,
  type InteractionVM
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

const mockedUseDateCompanionSession = vi.mocked(useDateCompanionSession);

function makeSession(overrides: Partial<DateCompanionSessionValue> = {}): DateCompanionSessionValue {
  return {
    auth: { status: "checking" },
    viewModel: emptyDateCompanionViewModel(),
    uploadState: { status: "idle" },
    qaState: { status: "idle" },
    qaHistory: [],
    relationshipState: { status: "idle" },
    mutationState: { status: "idle" },
    searchState: { status: "idle" },
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    upload: vi.fn(async () => undefined),
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
    ask: vi.fn(async () => null),
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
  });

  it("shows a private-space loading state while authentication is being checked", () => {
    mockedUseDateCompanionSession.mockReturnValue(makeSession());

    render(<DateCompanionShell entry="login" />);

    expect(screen.getByRole("status")).toHaveTextContent("正在确认你的私人空间…");
    expect(screen.queryByLabelText("邮箱")).not.toBeInTheDocument();
  });

  it("shows the real login form for an anonymous user without a demo-account action", () => {
    mockedUseDateCompanionSession.mockReturnValue(makeSession({ auth: { status: "anonymous" } }));

    render(<DateCompanionShell entry="login" />);

    expect(screen.getByLabelText("邮箱")).toBeInTheDocument();
    expect(screen.getByLabelText("密码")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /演示/ })).not.toBeInTheDocument();
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
      ask
    }));

    render(<DateCompanionShell entry="companion" screen="home" />);

    expect(screen.getByRole("link", { name: "此刻" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("约会陪伴 · 小林")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "你和 小林" })).toBeInTheDocument();
    expect(screen.getByText("Ta 最近在准备考试")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "问问这次相处" }));
    expect(screen.getByRole("textbox", { name: "针对这次相处提问" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /这次相处里明确聊到了什么/u }));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(ask).toHaveBeenCalledWith("这次相处里明确聊到了什么？");
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
    expect(updateParticipants).not.toHaveBeenCalled();
  });

  it("selects a confirmed historical recap from the URL and clears it on the plain recap route", async () => {
    const selectRelationshipInteraction = vi.fn(() => true);
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
  });

  it("keeps an evidence-only historical recap read-only and outside current-interaction QA", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "问问这次相处" }));

    expect(screen.getByRole("alert")).toHaveTextContent("回答服务暂时没有完成这次提问，请重新发送。");
    expect(screen.queryByText("qa_stream_failed")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "针对这次相处提问" })).toHaveValue("Ta 这次最在意什么？");
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
