import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DailyReflectionApiError,
  type DailyReflectionApi
} from "@/lib/client/daily-reflection-api";
import type { DailyReflectionMemoryView } from "@/lib/domain/daily-reflection-memory-view";

import { DailyReflectionMemory } from "./daily-reflection-memory";

const navigation = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn()
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation
}));

const memory: DailyReflectionMemoryView = {
  id: "memory_1",
  cardId: "card_1",
  reflectionId: "reflection_1",
  recordingDate: "2026-08-13",
  memoryType: "decision",
  cardKind: "decision",
  epistemicStatus: "explicit_user_statement",
  epistemicCaution: null,
  title: "决定先完成一个小版本",
  content: "先把最小版本完成，再继续扩展。",
  sourceCount: 1,
  evidence: [{
    reflectionId: "reflection_1",
    cardId: "card_1",
    recordingDate: "2026-08-13",
    sourceOrigin: "user_reflection",
    sourceSegmentId: "segment_1",
    startSeconds: 4,
    endSeconds: 12,
    snippet: "我决定先完成一个小版本。"
  }]
};

function api(overrides: Partial<DailyReflectionApi> = {}) {
  return {
    listMemories: vi.fn(async () => ({ memories: [memory], total: 1 })),
    getMemory: vi.fn(async () => ({ memory })),
    getWorkingCard: vi.fn(async () => ({
      card: {
        id: "card_1",
        status: "saved",
        memoryLifecycleStatus: "active",
        memoryLifecycleVersion: 3
      }
    })),
    getWorkingCardMemoryRevocation: vi.fn(),
    revokeWorkingCardMemory: vi.fn(async () => ({})),
    ...overrides
  } as unknown as DailyReflectionApi;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DailyReflectionMemory", () => {
  it("shows only durable user-controlled memories without invented actions", async () => {
    render(<DailyReflectionMemory api={api()} />);

    expect(await screen.findByRole("heading", { name: memory.title })).toBeVisible();
    expect(screen.getByText(/你明确表达过/u)).toBeVisible();
    expect(screen.getByText(/1 段来源/u)).toBeVisible();
    expect(screen.getByRole("heading", { name: memory.title }).closest("a")).toHaveAttribute(
      "href",
      "/reflection/memory/memory_1"
    );
    expect(screen.queryByRole("button", { name: /修正|发生变化|暂停/u })).not.toBeInTheDocument();
  });

  it("explains why a memory exists, preserves canonical source jumps, and revokes explicitly", async () => {
    const client = api();
    render(<DailyReflectionMemory api={client} memoryId="memory_1" />);

    expect(await screen.findByRole("heading", { name: memory.title })).toBeVisible();
    expect(screen.getByRole("heading", { name: "为什么记住？" })).toBeVisible();
    expect(screen.getByText("我决定先完成一个小版本。")).toBeVisible();
    expect(screen.getByRole("link", { name: "查看来源" })).toHaveAttribute(
      "href",
      "/reflection/sessions/reflection_1?segment=segment_1"
    );

    fireEvent.click(screen.getByRole("button", { name: "撤销这条记忆" }));
    expect(screen.getByRole("dialog", { name: "撤销这条长期记忆？" })).toBeVisible();
    expect(screen.getByText(/原始复盘和已保存卡片不会删除/u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "确认撤销" }));

    await waitFor(() => expect(client.revokeWorkingCardMemory).toHaveBeenCalledWith(
      "card_1",
      {
        expectedMemoryLifecycleVersion: 3,
        idempotencyKey: "daily-reflection-card-revoke:card_1:v3"
      }
    ));
    expect(navigation.replace).toHaveBeenCalledWith("/reflection/memory");
    expect(navigation.refresh).toHaveBeenCalled();
  });

  it("keeps the detail visible and explains a concurrent update", async () => {
    const client = api({
      revokeWorkingCardMemory: vi.fn(async () => {
        throw new DailyReflectionApiError(409, "working_card_memory_version_conflict");
      })
    });
    render(<DailyReflectionMemory api={client} memoryId="memory_1" />);
    await screen.findByRole("heading", { name: memory.title });

    fireEvent.click(screen.getByRole("button", { name: "撤销这条记忆" }));
    fireEvent.click(screen.getByRole("button", { name: "确认撤销" }));

    expect((await screen.findAllByRole("alert")).some((item) => item.textContent ===
      "这条记忆已经在其他页面更新，请重新加载最新内容。"
    )).toBe(true);
    expect(screen.getByText(memory.content)).toBeVisible();
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});
