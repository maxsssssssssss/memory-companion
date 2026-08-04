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
    mockedUseDateCompanionSession.mockReturnValue(makeSession({
      auth: {
        status: "authenticated",
        user: { id: "user-1", email: "user@example.com" }
      },
      viewModel: viewModelWithInteraction(interaction),
      relationshipState: {
        status: "ready",
        relationship: { id: "relationship-1", displayName: "", participantState: "confirmed", version: 1 }
      },
      uploadState: {
        status: "ready",
        uploadId: interaction.id,
        cacheStatus: "saved",
        serverCleanupStatus: "completed"
      }
    }));

    render(<DateCompanionShell entry="companion" screen="home" />);

    expect(screen.getByRole("link", { name: "此刻" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("约会陪伴 · Ta")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "问问这次相处" }));
    expect(screen.getByRole("textbox", { name: "针对这次相处提问" })).toBeEnabled();
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
