import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDailyReflectionApi } from "@/lib/client/daily-reflection-api";
import type {
  DailyReflectionWorkingCardDetailResponse,
  DailyReflectionWorkingCardView
} from "@/lib/domain/daily-reflection-api";

import { DailyReflectionCardLibrary } from "./daily-reflection-card-library";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function card(
  status: "saved" | "archived" | "removed" = "saved",
  sourceUnavailable = false,
  overrides: Partial<DailyReflectionWorkingCardView> = {}
): DailyReflectionWorkingCardView {
  return { ...cardBase(), status, sourceUnavailable, ...overrides };
}

function cardBase(): DailyReflectionWorkingCardView {
  return {
    id: "card_1",
    sourceReflectionIds: ["reflection_1"],
    title: "散步后的洞察",
    content: "散步让我更容易整理思路。",
    cardKind: "insight" as const,
    evidenceIds: ["segment_1"],
    status: "saved" as const,
    importance: 0.8,
    novelty: 0.7,
    relatedCardIds: [],
    tags: ["散步"],
    visibility: "private" as const,
    sourceUnavailable: false,
    memoryLifecycleStatus: "not_admitted" as const,
    memoryLifecycleVersion: 0,
    memoryLifecycleUpdatedAt: null,
    version: 1,
    createdAt: "2026-08-13T08:00:00.000Z",
    updatedAt: "2026-08-13T08:00:00.000Z"
  };
}

function detail(
  status: "saved" | "archived" | "removed" = "saved",
  sourceUnavailable = false,
  overrides: Partial<DailyReflectionWorkingCardView> = {}
): DailyReflectionWorkingCardDetailResponse {
  return {
    card: {
      ...card(status, sourceUnavailable, overrides),
      evidence: sourceUnavailable ? [] : [{
        sourceSegmentId: overrides.id === "card_2" ? "segment_2" : "segment_1",
        uploadId: overrides.id === "card_2" ? "upload_2" : "upload_1",
        effectiveOrigin: "user_reflection" as const,
        startSeconds: 5,
        endSeconds: 12,
        text: overrides.id === "card_2"
          ? "我还想继续想清楚这个问题。"
          : "散步以后，我觉得思路更清楚了。"
      }]
    }
  };
}

function listResponse(cards: DailyReflectionWorkingCardView[]) {
  return { cards, total: cards.length, limit: 50, offset: 0 };
}

function cardTwo() {
  return card("saved", false, {
    id: "card_2",
    title: "还没回答的问题",
    content: "我为什么总是在事情快完成时改变方向？",
    cardKind: "question",
    evidenceIds: ["segment_2"],
    sourceReflectionIds: ["reflection_2"]
  });
}

function finishClose() {
  const dialog = screen.getByRole("dialog");
  fireEvent.transitionEnd(dialog);
}

beforeEach(() => {
  window.history.replaceState({}, "", "/reflection/cards");
  document.body.style.cssText = "";
});

afterEach(() => {
  document.body.style.cssText = "";
  vi.unstubAllGlobals();
});

describe("DailyReflectionCardLibrary", () => {
  it("opens a direct deep link over the Card Library and keeps Canonical Evidence", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) return jsonResponse(listResponse([card()]));
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "GET") return jsonResponse(detail());
      return jsonResponse({ error: "not_found" }, 404);
    });

    render(<DailyReflectionCardLibrary api={createDailyReflectionApi(fetcher)} initialCardId="card_1" />);

    const dialog = await screen.findByRole("dialog", { name: "散步后的洞察" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.querySelector("main")).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector("main h1")).toHaveTextContent("你的卡片");
    expect(document.querySelector<HTMLButtonElement>('[aria-label="打开卡片：散步后的洞察"]')).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    fireEvent.click(within(dialog).getByText("查看来源 · 1 段"));
    expect(await within(dialog).findByText("散步以后，我觉得思路更清楚了。")).toBeVisible();
    expect(within(dialog).getByRole("link", { name: "查看来源复盘" })).toHaveAttribute("href", "/reflection/sessions/reflection_1");
    expect(within(dialog).getByRole("link", { name: "在完整文字记录中查看" })).toHaveAttribute("href", "/reflection/sessions/reflection_1?segment=segment_1");
    expect(window.location.pathname).toBe("/reflection/cards/card_1");
    expect(fetcher.mock.calls.filter(([path, init]) => String(path) === "/api/daily-reflections/cards/card_1" && init?.method === "GET")).toHaveLength(1);
  });

  it("restarts a direct deep-link detail request after StrictMode effect cleanup", async () => {
    let detailCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) return jsonResponse(listResponse([card()]));
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "GET") {
        detailCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 12));
        return jsonResponse(detail());
      }
      return jsonResponse({ error: "not_found" }, 404);
    });

    render(
      <StrictMode>
        <DailyReflectionCardLibrary api={createDailyReflectionApi(fetcher)} initialCardId="card_1" />
      </StrictMode>
    );

    const dialog = await screen.findByRole("dialog", { name: "散步后的洞察" });
    expect(within(dialog).getByRole("button", { name: "编辑卡片" })).toBeVisible();
    expect(detailCalls).toBeGreaterThanOrEqual(2);
    expect(window.location.pathname).toBe("/reflection/cards/card_1");
  });

  it("expands from the title, updates the URL, closes from the expanded title, and restores focus", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) return jsonResponse(listResponse([card()]));
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "GET") return jsonResponse(detail());
      return jsonResponse({ error: "not_found" }, 404);
    });
    render(<DailyReflectionCardLibrary api={createDailyReflectionApi(fetcher)} />);

    const trigger = await screen.findByRole("button", { name: "打开卡片：散步后的洞察" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "散步后的洞察" });
    expect(window.location.pathname).toBe("/reflection/cards/card_1");
    expect(document.body.style.overflow).toBe("hidden");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger.closest("[data-card-id]"))?.toHaveAttribute("data-expanded", "true");

    fireEvent.click(within(dialog).getByRole("button", { name: "收起卡片：散步后的洞察" }));
    expect(dialog).toHaveAttribute("data-phase", "closing");
    finishClose();

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "散步后的洞察" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(document.body.style.overflow).toBe("");
  });

  it("uses one dialog while route history switches Cards, then Escape closes it", async () => {
    const first = card();
    const second = cardTwo();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) return jsonResponse(listResponse([first, second]));
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "GET") return jsonResponse(detail());
      if (path === "/api/daily-reflections/cards/card_2" && init?.method === "GET") return jsonResponse(detail("saved", false, second));
      return jsonResponse({ error: "not_found" }, 404);
    });
    render(<DailyReflectionCardLibrary api={createDailyReflectionApi(fetcher)} />);

    fireEvent.click(await screen.findByRole("button", { name: "打开卡片：散步后的洞察" }));
    expect(await screen.findByRole("dialog", { name: "散步后的洞察" })).toBeVisible();

    window.history.pushState({ __dailyReflectionCardOverlay: "card_2" }, "", "/reflection/cards/card_2");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("dialog", { name: "还没回答的问题" })).toBeVisible();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    fireEvent.keyDown(document, { key: "Escape" });
    finishClose();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("browser Back closes an expanded Card without losing the Library", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) return jsonResponse(listResponse([card()]));
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "GET") return jsonResponse(detail());
      return jsonResponse({ error: "not_found" }, 404);
    });
    render(<DailyReflectionCardLibrary api={createDailyReflectionApi(fetcher)} />);
    fireEvent.click(await screen.findByRole("button", { name: "打开卡片：散步后的洞察" }));
    expect(await screen.findByRole("dialog", { name: "散步后的洞察" })).toBeVisible();

    window.history.replaceState({}, "", "/reflection/cards");
    window.dispatchEvent(new PopStateEvent("popstate"));
    finishClose();

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "你的卡片" })).toBeVisible();
  });

  it("searches, sorts, filters, and applies the four-type presentation mapping", async () => {
    const legacyEvent = card("saved", false, {
      id: "card_event",
      title: "一段值得留下的经历",
      cardKind: "event"
    });
    const question = cardTwo();
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).startsWith("/api/daily-reflections/cards?")) return jsonResponse(listResponse([card(), legacyEvent, question]));
      return jsonResponse({ error: "not_found" }, 404);
    });
    render(<DailyReflectionCardLibrary api={createDailyReflectionApi(fetcher)} now={() => new Date("2026-08-24T00:00:00.000Z")} />);

    expect(await screen.findByRole("tab", { name: /洞察\s*2/u })).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: /问题\s*1/u }));
    expect(screen.getByRole("button", { name: "打开卡片：还没回答的问题" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "打开卡片：散步后的洞察" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /全部\s*3/u }));
    fireEvent.change(screen.getByLabelText("搜索卡片"), { target: { value: "散步" } });
    fireEvent.change(screen.getByLabelText("卡片排序"), { target: { value: "title_asc" } });
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    fireEvent.change(screen.getByLabelText("按状态筛选"), { target: { value: "removed" } });
    fireEvent.change(screen.getByLabelText("按时间筛选"), { target: { value: "30d" } });
    fireEvent.click(screen.getByRole("button", { name: "应用筛选" }));
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() => {
      const listCall = [...fetcher.mock.calls].reverse().find(([path]) => String(path).includes("cards?"));
      expect(String(listCall?.[0])).toContain("status=removed");
      expect(String(listCall?.[0])).toContain("sort=title_asc");
      expect(String(listCall?.[0])).toContain("q=%E6%95%A3%E6%AD%A5");
      expect(String(listCall?.[0])).toContain("from=2026-07-25T00%3A00%3A00.000Z");
      expect(String(listCall?.[0])).not.toContain("type=");
    });
  });

  it("edits inside the expanded Card and preserves the versioned request contract", async () => {
    let current = detail();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) {
        const { evidence: _evidence, ...summary } = current.card;
        return jsonResponse(listResponse([summary]));
      }
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "GET") return jsonResponse(current);
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "PATCH") {
        const payload = JSON.parse(String(init.body)) as { title: string; content: string; expectedVersion: number };
        current = { card: { ...current.card, title: payload.title, content: payload.content, version: 2 } };
        return jsonResponse(current);
      }
      return jsonResponse({ error: "not_found" }, 404);
    });
    render(<DailyReflectionCardLibrary api={createDailyReflectionApi(fetcher)} />);
    fireEvent.click(await screen.findByRole("button", { name: "打开卡片：散步后的洞察" }));
    const dialog = await screen.findByRole("dialog", { name: "散步后的洞察" });
    fireEvent.click(within(dialog).getByRole("button", { name: "编辑卡片" }));
    fireEvent.change(within(dialog).getByLabelText("编辑卡片标题"), { target: { value: "更新后的洞察" } });
    fireEvent.change(within(dialog).getByLabelText("编辑卡片正文"), { target: { value: "更新后的内容。" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存修改" }));

    expect(await screen.findByRole("dialog", { name: "更新后的洞察" })).toBeVisible();
    const patchCall = fetcher.mock.calls.find(([path, init]) => String(path) === "/api/daily-reflections/cards/card_1" && init?.method === "PATCH");
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ expectedVersion: 1, title: "更新后的洞察", content: "更新后的内容。" });
    expect(screen.queryByLabelText("编辑卡片标题")).not.toBeInTheDocument();
  });

  it("reloads server truth after a 409 conflict and does not retry the mutation", async () => {
    let getCount = 0;
    const serverDetail = detail("saved", false, { title: "服务器上的最新标题", content: "另一页面已经保存的正文。", version: 2 });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) return jsonResponse(listResponse([card()]));
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "GET") {
        getCount += 1;
        return jsonResponse(getCount === 1 ? detail() : serverDetail);
      }
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "PATCH") return jsonResponse({ error: "working_card_version_conflict" }, 409);
      return jsonResponse({ error: "not_found" }, 404);
    });
    render(<DailyReflectionCardLibrary api={createDailyReflectionApi(fetcher)} />);
    fireEvent.click(await screen.findByRole("button", { name: "打开卡片：散步后的洞察" }));
    const dialog = await screen.findByRole("dialog", { name: "散步后的洞察" });
    fireEvent.click(within(dialog).getByRole("button", { name: "编辑卡片" }));
    fireEvent.change(within(dialog).getByLabelText("编辑卡片标题"), { target: { value: "冲突草稿" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存修改" }));

    expect(await screen.findByRole("dialog", { name: "服务器上的最新标题" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("这张卡片已经在其他页面更新，已重新加载最新内容。");
    expect(fetcher.mock.calls.filter(([path, init]) => String(path) === "/api/daily-reflections/cards/card_1" && init?.method === "PATCH")).toHaveLength(1);
  });

  it("protects unsaved edits when the title tries to close", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) return jsonResponse(listResponse([card()]));
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "GET") return jsonResponse(detail());
      return jsonResponse({ error: "not_found" }, 404);
    });
    render(<DailyReflectionCardLibrary api={createDailyReflectionApi(fetcher)} />);
    fireEvent.click(await screen.findByRole("button", { name: "打开卡片：散步后的洞察" }));
    const dialog = await screen.findByRole("dialog", { name: "散步后的洞察" });
    fireEvent.click(within(dialog).getByRole("button", { name: "编辑卡片" }));
    fireEvent.change(within(dialog).getByLabelText("编辑卡片标题"), { target: { value: "还没保存的标题" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "收起卡片：散步后的洞察" }));

    const warning = screen.getByRole("alertdialog", { name: "放弃未保存的修改？" });
    expect(warning).toBeVisible();
    fireEvent.click(within(warning).getByRole("button", { name: "取消" }));
    expect(within(dialog).getByLabelText("编辑卡片标题")).toHaveValue("还没保存的标题");
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭卡片详情" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "放弃未保存的修改？" })).getByRole("button", { name: "放弃并关闭" }));
    finishClose();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "散步后的洞察" })).not.toBeInTheDocument());
  });

  it("keeps unavailable provenance safe and preserves archive, restore, remove, and revoke", async () => {
    let current: DailyReflectionWorkingCardDetailResponse = {
      card: {
        ...detail("saved", true).card,
        memoryLifecycleStatus: "active",
        memoryLifecycleVersion: 1,
        memoryLifecycleUpdatedAt: "2026-08-24T08:00:00.000Z"
      }
    };
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) {
        const { evidence: _evidence, ...summary } = current.card;
        return jsonResponse(listResponse([summary]));
      }
      if (path === "/api/daily-reflections/cards/card_1/revoke") {
        current = { card: { ...current.card, memoryLifecycleStatus: "revoked", memoryLifecycleVersion: 2 } };
        const { evidence: _evidence, ...publicCard } = current.card;
        return jsonResponse({ card: publicCard, lifecycleStatus: "revoked", operation: { status: "completed", attemptVersion: 1, requestedMemoryLifecycleVersion: 1, indexRefreshStatus: "not_required", errorCode: null, updatedAt: "2026-08-24T08:00:00.000Z", completedAt: "2026-08-24T08:00:00.000Z" }, receipt: { cardId: "card_1", proposalId: "proposal_1", outcome: "revoked", historicalMemoryId: "memory_1", removedMemoryEvidenceCount: 1, removedPersonSourceCount: 0, createdAt: "2026-08-24T08:00:00.000Z" }, reused: false });
      }
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "GET") return jsonResponse(current);
      if (path.endsWith("/archive")) return jsonResponse({ card: { ...current.card, status: "archived", version: 2 } });
      if (path.endsWith("/restore")) return jsonResponse({ card: { ...current.card, status: "saved", version: 3 } });
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "DELETE") return jsonResponse({ card: { ...current.card, status: "removed", version: 4 } });
      return jsonResponse({ error: "not_found" }, 404);
    });
    render(<DailyReflectionCardLibrary api={createDailyReflectionApi(fetcher)} initialCardId="card_1" />);
    const dialog = await screen.findByRole("dialog", { name: "散步后的洞察" });
    fireEvent.click(within(dialog).getByText("查看来源 · 0 段"));
    expect(within(dialog).getByText(/原始来源已不可用/u)).toBeVisible();
    expect(within(dialog).queryByRole("link", { name: /查看来源复盘/u })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByText("管理这张卡片"));
    fireEvent.click(within(dialog).getByRole("button", { name: "撤销这条记忆" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "撤销这条长期记忆？" })).getByRole("button", { name: "确认撤销" }));
    expect(await within(dialog).findByText("已撤销")).toBeVisible();
    const revokeCall = fetcher.mock.calls.find(([path]) => String(path).endsWith("/revoke"));
    expect(JSON.parse(String(revokeCall?.[1]?.body))).toEqual({ expectedMemoryLifecycleVersion: 1, idempotencyKey: "daily-reflection-card-revoke:card_1:v1" });
  });

  it("uses the reduced-motion fallback without a positional closing transition", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) return jsonResponse(listResponse([card()]));
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "GET") return jsonResponse(detail());
      return jsonResponse({ error: "not_found" }, 404);
    });
    render(<DailyReflectionCardLibrary api={createDailyReflectionApi(fetcher)} />);
    fireEvent.click(await screen.findByRole("button", { name: "打开卡片：散步后的洞察" }));
    const dialog = await screen.findByRole("dialog", { name: "散步后的洞察" });
    expect(dialog).toHaveAttribute("data-phase", "open");
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭卡片详情" }));
    expect(screen.queryByRole("dialog", { name: "散步后的洞察" })).not.toBeInTheDocument();
  });
});
