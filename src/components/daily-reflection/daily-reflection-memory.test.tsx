import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const earlierMemory: DailyReflectionMemoryView = {
  ...memory,
  id: "memory_2",
  cardId: "card_2",
  reflectionId: "reflection_2",
  recordingDate: "2026-07-21",
  memoryType: "preference",
  cardKind: "insight",
  title: "先看重点再展开细节",
  content: "我更喜欢先看最重要的内容，再按需要回到完整记录。",
  evidence: [{
    ...memory.evidence[0],
    reflectionId: "reflection_2",
    cardId: "card_2",
    recordingDate: "2026-07-21",
    sourceSegmentId: "segment_2",
    snippet: "我更喜欢先看重点。"
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
  it("ignores an aborted detail response after navigating to another memory", async () => {
    let finishFirst!: (value: { memory: DailyReflectionMemoryView }) => void;
    const first = new Promise<{ memory: DailyReflectionMemoryView }>((resolve) => { finishFirst = resolve; });
    const getMemory = vi.fn<DailyReflectionApi["getMemory"]>()
      .mockImplementationOnce(() => first)
      .mockResolvedValue({ memory: earlierMemory });
    const client = api({ getMemory });
    const view = render(<DailyReflectionMemory api={client} memoryId={memory.id} />);
    view.rerender(<DailyReflectionMemory api={client} memoryId={earlierMemory.id} />);
    expect(await screen.findByRole("heading", { name: earlierMemory.title })).toBeVisible();
    expect(getMemory.mock.calls[0]?.[1]?.aborted).toBe(true);
    await act(async () => { finishFirst({ memory }); await first; });
    expect(screen.getByRole("heading", { name: earlierMemory.title })).toBeVisible();
    expect(screen.queryByRole("heading", { name: memory.title })).not.toBeInTheDocument();
  });

  it("presents durable memories as a recent collection and month-grouped archive", async () => {
    render(<DailyReflectionMemory api={api({
      listMemories: vi.fn(async () => ({ memories: [memory, earlierMemory], total: 2 }))
    })} />);

    expect(await screen.findByRole("heading", { name: "长期记忆" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "最近记住" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "2026 年 8 月" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "2026 年 7 月" })).toBeVisible();
    expect(screen.getByText("2 条记忆正在长期保留")).toBeVisible();
    expect(screen.getAllByText(/你明确表达过/u).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1 段来源/u).length).toBeGreaterThan(0);
    const stateLine = screen.getAllByText("决定").at(-1)?.parentElement;
    expect(stateLine).toHaveTextContent("决定长期有效");
    expect(stateLine?.querySelector("i[aria-hidden=\"true\"]")).not.toBeNull();
    expect(screen.queryByText("为什么记住")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /修正|发生变化|暂停/u })).not.toBeInTheDocument();
  });

  it("searches the loaded archive without changing the recent collection", async () => {
    render(<DailyReflectionMemory api={api({
      listMemories: vi.fn(async () => ({ memories: [memory, earlierMemory], total: 2 }))
    })} />);
    const archive = await screen.findByRole("region", { name: "全部记忆" });

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索长期记忆" }), {
      target: { value: "重点" }
    });

    expect(within(archive).getByRole("button", { name: earlierMemory.title })).toBeVisible();
    expect(within(archive).queryByRole("button", { name: memory.title })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: memory.title }).length).toBe(1);
  });

  it("opens a lightweight evidence-backed preview and restores focus when it closes", async () => {
    render(<DailyReflectionMemory api={api()} />);
    const opener = (await screen.findAllByRole("button", { name: memory.title }))[0];

    fireEvent.click(opener);

    const preview = screen.getByRole("dialog", { name: memory.title });
    expect(preview).toBeVisible();
    expect(within(preview).getByText(memory.content)).toBeVisible();
    expect(within(preview).getByText(/我决定先完成一个小版本/u)).toBeVisible();
    expect(within(preview).getByRole("link", { name: "查看原话" })).toHaveAttribute(
      "href",
      "/reflection/sessions/reflection_1?segment=segment_1"
    );
    expect(within(preview).getByRole("link", { name: /查看完整详情/u })).toHaveAttribute(
      "href",
      "/reflection/memory/memory_1"
    );
    expect(within(preview).queryByText("为什么记住")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: memory.title })).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe("");
    expect(opener).toHaveFocus();
  });

  it("removes a memory from the archive only after the real revoke call succeeds", async () => {
    const client = api();
    render(<DailyReflectionMemory api={client} />);
    const pageHeading = await screen.findByRole("heading", { name: "长期记忆" });
    fireEvent.click((await screen.findAllByRole("button", { name: memory.title }))[0]);
    fireEvent.click(screen.getByRole("button", { name: "撤销这条记忆" }));
    fireEvent.click(screen.getByRole("button", { name: "确认撤销" }));

    await waitFor(() => expect(client.revokeWorkingCardMemory).toHaveBeenCalledWith("card_1", {
      expectedMemoryLifecycleVersion: 3,
      idempotencyKey: "daily-reflection-card-revoke:card_1:v3"
    }));
    await waitFor(() => expect(screen.queryByRole("button", { name: memory.title })).not.toBeInTheDocument());
    await waitFor(() => expect(pageHeading).toHaveFocus());
  });

  it("preserves canonical source jumps, omits an unsupported reason, and revokes explicitly", async () => {
    const client = api();
    render(<DailyReflectionMemory api={client} memoryId="memory_1" />);

    expect(await screen.findByRole("heading", { name: memory.title })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "为什么记住？" })).not.toBeInTheDocument();
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

  it("shows one recoverable load error instead of a false empty archive", async () => {
    const listMemories = vi.fn()
      .mockRejectedValueOnce(new Error("database details must stay hidden"))
      .mockResolvedValueOnce({ memories: [memory], total: 1 });
    render(<DailyReflectionMemory api={api({ listMemories })} />);

    expect(await screen.findByRole("heading", { name: "长期记忆暂时没有加载完成" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "还没有长期记忆" })).not.toBeInTheDocument();
    expect(screen.queryByText(/database details/u)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新尝试" }));

    expect((await screen.findAllByRole("button", { name: memory.title })).length).toBeGreaterThan(0);
    expect(listMemories).toHaveBeenCalledTimes(2);
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
