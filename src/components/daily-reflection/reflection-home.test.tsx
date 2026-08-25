import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReflectionHome } from "./reflection-home";

const state = vi.hoisted(() => ({
  app: {} as Record<string, unknown>
}));

vi.mock("./reflection-app-shell", () => ({
  useReflectionApp: () => state.app
}));

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function today() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function session(history: unknown[] = []) {
  return {
    history,
    historyState: "ready",
    reflectionId: null
  };
}

function dailyReturn() {
  const evidence = [{
    reflectionId: "reflection_1",
    cardId: "card_1",
    recordingDate: "2026-08-24",
    sourceOrigin: "user_reflection",
    sourceSegmentId: "segment_1",
    startSeconds: 4,
    endSeconds: 12,
    snippet: "我想继续把这个问题想清楚。"
  }];
  return {
    referenceDate: "2026-08-24",
    timeZone: "Asia/Shanghai",
    openLoops: [{
      id: "return_1",
      type: "open_loop",
      title: "继续把产品价值想清楚",
      body: "这个问题还没有结束。",
      sourceMemoryIds: ["memory_1"],
      sourceCardIds: ["card_1"],
      evidenceIds: ["segment_1"],
      evidence,
      epistemicStatuses: ["explicit_user_statement"],
      createdAt: "2026-08-24T01:00:00.000Z"
    }],
    resurfacedMemories: [],
    reflectionPrompts: []
  };
}

beforeEach(() => {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const path = String(input);
    if (path.startsWith("/api/daily-reflections/returns/daily")) return jsonResponse(dailyReturn());
    if (path.startsWith("/api/daily-reflections/cards?")) {
      return jsonResponse({ cards: [], total: 0, limit: 1, offset: 0 });
    }
    return jsonResponse({ error: "daily_reflection_not_found" }, 404);
  });
  vi.stubGlobal("fetch", fetcher);
  state.app = {
    browserRecordingEnabled: false,
    handleApiError: vi.fn(() => false),
    session: session(),
    toySyncEnabled: false
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReflectionHome", () => {
  it("introduces first-use value and trust without exposing disabled inputs", async () => {
    render(<ReflectionHome />);

    expect(screen.getByRole("heading", { name: "给今天留下一点真实的东西。" })).toBeVisible();
    expect(screen.getByRole("link", { name: "开始表达" })).toHaveAttribute("href", "/reflection/capture?new=1");
    expect(screen.getByText(/原始表达会保留为可核对的来源/u)).toBeVisible();
    expect(screen.getByRole("link", { name: "上传录音" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "从玩偶导入" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "我最近反复在想什么？" }))
      .toHaveAttribute("href", "/reflection/ask?q=%E6%88%91%E6%9C%80%E8%BF%91%E5%8F%8D%E5%A4%8D%E5%9C%A8%E6%83%B3%E4%BB%80%E4%B9%88%EF%BC%9F");
    expect(await screen.findByRole("heading", { name: "值得继续" })).toBeVisible();
  });

  it("shows a returning user's real session state and only enabled input methods", async () => {
    state.app = {
      ...state.app,
      browserRecordingEnabled: true,
      toySyncEnabled: true,
      session: session([{
        id: "reflection_1",
        status: "completed",
        inputMethod: "file_upload",
        sourceOrigin: "user_reflection",
        recordingDate: today(),
        sourceStatement: "你在今天的复盘中提到了一些值得留下的内容。",
        candidateCount: 2,
        pendingCount: 0,
        keptCount: 1,
        excludedCount: 1,
        rememberedCount: 1,
        notSavedCount: 1,
        subjectPersonIds: [],
        transcriptAvailable: true,
        createdAt: "2026-08-25T01:00:00.000Z",
        updatedAt: "2026-08-25T01:10:00.000Z"
      }])
    };
    render(<ReflectionHome />);

    expect(screen.queryByText("给今天留下一点真实的东西。")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "开始表达" })).toBeVisible();
    expect(screen.getByRole("link", { name: "上传录音" })).toBeVisible();
    expect(screen.getByRole("link", { name: "从玩偶导入" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "今天的内容" })).toBeVisible();
    expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
    expect(screen.getAllByText("长期记住 1 条").length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByRole("heading", { name: "值得继续" })).toBeVisible());
  });
});
