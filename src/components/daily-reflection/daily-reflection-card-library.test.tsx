import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDailyReflectionApi, type DailyReflectionApi } from "@/lib/client/daily-reflection-api";
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

function memoryProposal(overrides: Record<string, unknown> = {}) {
  return {
    id: "proposal_1",
    cardId: "card_1",
    reflectionId: "reflection_1",
    title: "散步后的洞察",
    cardKind: "insight",
    actionClaimed: false,
    memoryType: "summary",
    content: "散步让我更容易整理思路。",
    evidenceIds: ["segment_1"],
    evidenceSnapshots: [{
      sourceSegmentId: "segment_1",
      uploadId: "upload_1",
      startSeconds: 0,
      endSeconds: 8,
      effectiveOrigin: "user_reflection"
    }],
    riskFlags: [],
    subjectPersonId: null,
    importance: 0.8,
    durability: 0.8,
    novelty: 0.7,
    sensitivity: 0.1,
    epistemicStatus: "explicit_user_statement",
    epistemicCaution: null,
    status: "pending",
    policyVersion: "unassessed",
    score: 0,
    reasons: [],
    confirmationRequirements: [],
    memoryId: null,
    sourceOrigin: "user_reflection",
    recordingDate: "2026-08-13",
    version: 0,
    createdAt: "2026-08-13T08:00:00.000Z",
    updatedAt: "2026-08-13T08:00:00.000Z",
    admittedAt: null,
    ...overrides
  };
}

function testApi(fetcher: typeof fetch, overrides: Partial<DailyReflectionApi> = {}): DailyReflectionApi {
  return {
    ...createDailyReflectionApi(fetcher),
    getWorkingCardMemoryProposal: vi.fn(async () => ({
      proposal: null, publicationStatus: null, revoked: false, actionClaimed: false
    })),
    evaluateMemoryProposal: vi.fn(async () => ({
      status: "approved", proposal: memoryProposal({ status: "approved" }),
      memoryId: null, reasons: [], confirmationRequirements: []
    })) as DailyReflectionApi["evaluateMemoryProposal"],
    ...overrides
  };
}

async function confirmRemember() {
  fireEvent.click(await screen.findByRole("button", { name: "确认长期记住" }));
}

function finishClose() {
  const dialog = screen.getByRole("dialog");
  fireEvent.transitionEnd(dialog, { propertyName: "transform" });
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
  it("ignores an aborted list response after the sort request changes", async () => {
    let finishFirst!: (value: ReturnType<typeof listResponse>) => void;
    const first = new Promise<ReturnType<typeof listResponse>>((resolve) => { finishFirst = resolve; });
    const listWorkingCards = vi.fn<DailyReflectionApi["listWorkingCards"]>()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(listResponse([cardTwo()]));
    render(<DailyReflectionCardLibrary api={testApi(vi.fn(), { listWorkingCards })} />);
    fireEvent.change(screen.getByRole("combobox", { name: "卡片排序" }), { target: { value: "created_asc" } });
    expect(await screen.findByRole("button", { name: `打开卡片：${cardTwo().title}` })).toBeVisible();
    expect(listWorkingCards.mock.calls[0]?.[1]?.aborted).toBe(true);
    await act(async () => { finishFirst(listResponse([card()])); await first; });
    expect(screen.getByRole("button", { name: `打开卡片：${cardTwo().title}` })).toBeVisible();
    expect(screen.queryByRole("button", { name: `打开卡片：${card().title}` })).not.toBeInTheDocument();
  });

  it("reads and edits the card while its memory status is still pending", async () => {
    const getWorkingCardMemoryProposal = vi.fn<DailyReflectionApi["getWorkingCardMemoryProposal"]>(
      () => new Promise(() => undefined)
    );
    const client = testApi(vi.fn(), {
      listWorkingCards: vi.fn(async () => listResponse([card()])),
      getWorkingCard: vi.fn(async () => detail()),
      getWorkingCardMemoryProposal
    });
    render(<DailyReflectionCardLibrary api={client} initialCardId="card_1" />);
    const dialog = await screen.findByRole("dialog", { name: card().title });
    expect(within(dialog).getByText(card().content)).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "编辑卡片" }));
    expect(within(dialog).getByDisplayValue(card().content)).toBeVisible();
    expect(getWorkingCardMemoryProposal).toHaveBeenCalledTimes(1);
  });

  it("opens a direct deep link over the Card Library and keeps Canonical Evidence", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) return jsonResponse(listResponse([card()]));
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "GET") return jsonResponse(detail());
      return jsonResponse({ error: "not_found" }, 404);
    });

    render(<DailyReflectionCardLibrary api={testApi(fetcher)} initialCardId="card_1" />);

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
        <DailyReflectionCardLibrary api={testApi(fetcher)} initialCardId="card_1" />
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
    render(<DailyReflectionCardLibrary api={testApi(fetcher)} />);

    const trigger = await screen.findByRole("button", { name: "打开卡片：散步后的洞察" });
    trigger.focus();
    fireEvent.click(trigger, { detail: 1 });

    const dialog = await screen.findByRole("dialog", { name: "散步后的洞察" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "关闭卡片详情" })).toHaveFocus());
    expect(window.location.pathname).toBe("/reflection/cards/card_1");
    expect(document.body.style.overflow).toBe("hidden");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger.closest("[data-card-id]"))?.toHaveAttribute("data-expanded", "true");

    fireEvent.click(within(dialog).getByRole("button", { name: "收起卡片：散步后的洞察" }), { detail: 1 });
    expect(dialog).toHaveAttribute("data-phase", "closing");
    finishClose();

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "散步后的洞察" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    await waitFor(() => expect(window.location.pathname).toBe("/reflection/cards"));
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
    render(<DailyReflectionCardLibrary api={testApi(fetcher)} />);

    fireEvent.click(await screen.findByRole("button", { name: "打开卡片：散步后的洞察" }));
    expect(await screen.findByRole("dialog", { name: "散步后的洞察" })).toBeVisible();

    window.history.pushState({ __dailyReflectionCardOverlay: "card_2" }, "", "/reflection/cards/card_2");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("dialog", { name: "还没回答的问题" })).toBeVisible();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(window.location.pathname).toBe("/reflection/cards/card_1"));
    window.history.replaceState({}, "", "/reflection/cards");
  });

  it("browser Back closes an expanded Card without losing the Library", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) return jsonResponse(listResponse([card()]));
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "GET") return jsonResponse(detail());
      return jsonResponse({ error: "not_found" }, 404);
    });
    render(<DailyReflectionCardLibrary api={testApi(fetcher)} />);
    fireEvent.click(await screen.findByRole("button", { name: "打开卡片：散步后的洞察" }));
    expect(await screen.findByRole("dialog", { name: "散步后的洞察" })).toBeVisible();

    window.history.replaceState({}, "", "/reflection/cards");
    window.dispatchEvent(new PopStateEvent("popstate"));
    finishClose();

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "你的卡片" })).toBeVisible();
  });

  it("keeps the error state distinct from an empty Library and retries safely", async () => {
    let listCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (!String(input).startsWith("/api/daily-reflections/cards?")) {
        return jsonResponse({ error: "not_found" }, 404);
      }
      listCalls += 1;
      return listCalls === 1
        ? jsonResponse({ error: "daily_reflection_cards_unavailable" }, 503)
        : jsonResponse(listResponse([card()]));
    });
    render(<DailyReflectionCardLibrary api={testApi(fetcher)} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("卡片暂时没有加载完成");
    expect(screen.queryByText("这里还没有卡片")).not.toBeInTheDocument();
    expect(screen.getByText("读取失败")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重新尝试" }));

    expect(await screen.findByRole("button", { name: "打开卡片：散步后的洞察" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(listCalls).toBe(2);
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
    render(<DailyReflectionCardLibrary api={testApi(fetcher)} now={() => new Date("2026-08-24T00:00:00.000Z")} />);

    expect(await screen.findByRole("tab", { name: /洞察\s*2/u })).toBeVisible();
    const allTab = screen.getByRole("tab", { name: /全部\s*3/u });
    allTab.focus();
    fireEvent.keyDown(allTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /洞察\s*2/u })).toHaveFocus();
    expect(screen.getByRole("tab", { name: /洞察\s*2/u })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("tab", { name: /洞察\s*2/u }), { key: "End" });
    expect(screen.getByRole("tab", { name: /行动\s*0/u })).toHaveFocus();
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

  it("shows a visible Memory action in the list and detail, then creates and admits once", async () => {
    let current = detail();
    const admitted = memoryProposal({
      status: "admitted",
      policyVersion: "daily_reflection_memory_proposal_policy_v1",
      score: 0.82,
      reasons: ["policy_threshold_met"],
      memoryId: "memory_1",
      version: 3,
      admittedAt: "2026-08-13T08:01:00.000Z"
    });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) {
        const { evidence: _evidence, ...summary } = current.card;
        return jsonResponse(listResponse([summary]));
      }
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "GET") {
        return jsonResponse(current);
      }
      if (path.endsWith("/cards/card_1/memory-proposals")) {
        return jsonResponse({ proposal: memoryProposal(), reused: false }, 201);
      }
      if (path.endsWith("/memory-proposals/proposal_1/admit")) {
        current = {
          card: {
            ...current.card,
            memoryLifecycleStatus: "active",
            memoryLifecycleVersion: 1,
            memoryLifecycleUpdatedAt: "2026-08-13T08:01:00.000Z"
          }
        };
        return jsonResponse({
          status: "admitted",
          proposal: admitted,
          memoryId: "memory_1",
          reasons: ["policy_threshold_met"],
          confirmationRequirements: []
        });
      }
      return jsonResponse({ error: "not_found" }, 404);
    });
    render(<DailyReflectionCardLibrary api={testApi(fetcher)} />);

    expect(await screen.findByRole("button", { name: "长期记住：散步后的洞察" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "打开卡片：散步后的洞察" }));
    const dialog = await screen.findByRole("dialog", { name: "散步后的洞察" });
    const remember = within(dialog).getByRole("button", { name: "长期记住：散步后的洞察" });
    fireEvent.click(remember);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    await confirmRemember();

    expect(await within(dialog).findByRole("status")).toHaveTextContent("已长期记住");
    expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith("/cards/card_1/memory-proposals")))
      .toHaveLength(1);
    expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith("/memory-proposals/proposal_1/admit")))
      .toHaveLength(1);
  });

  it("continues the same Proposal after explicit inference confirmation", async () => {
    const requirement = {
      code: "acknowledge_inference" as const,
      resolution: "acknowledgement" as const
    };
    const waiting = memoryProposal({
      policyVersion: "daily_reflection_memory_proposal_policy_v2",
      reasons: ["confirmation_required:acknowledge_inference"],
      confirmationRequirements: [requirement],
      version: 1
    });
    const admitted = memoryProposal({
      status: "admitted",
      policyVersion: "daily_reflection_memory_proposal_policy_v2",
      reasons: ["user_confirmation:acknowledge_inference"],
      confirmationRequirements: [],
      memoryId: "memory_1",
      version: 3,
      admittedAt: "2026-08-13T08:01:00.000Z"
    });
    let admitAttempt = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) return jsonResponse(listResponse([card()]));
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "GET") return jsonResponse(detail());
      if (path.endsWith("/cards/card_1/memory-proposals")) {
        return jsonResponse({ proposal: memoryProposal(), reused: false }, 201);
      }
      if (path.endsWith("/memory-proposals/proposal_1/admit")) {
        admitAttempt += 1;
        if (admitAttempt === 1) {
          return jsonResponse({
            status: "needs_confirmation",
            proposal: waiting,
            memoryId: null,
            reasons: waiting.reasons,
            confirmationRequirements: [requirement]
          });
        }
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedVersion: 1,
          acknowledgements: ["acknowledge_inference"]
        });
        return jsonResponse({
          status: "admitted",
          proposal: admitted,
          memoryId: "memory_1",
          reasons: admitted.reasons,
          confirmationRequirements: []
        });
      }
      return jsonResponse({ error: "not_found" }, 404);
    });
    render(<DailyReflectionCardLibrary api={testApi(fetcher)} />);

    fireEvent.click(await screen.findByRole("button", { name: "长期记住：散步后的洞察" }));
    await confirmRemember();
    expect(await screen.findByText("需要确认后才能长期记住")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "打开卡片确认" }));
    const dialog = await screen.findByRole("dialog", { name: "散步后的洞察" });
    const checkbox = await within(dialog).findByRole("checkbox", {
      name: "这部分包含系统整理出的推测；请确认它符合你的意思。"
    });
    const confirm = within(dialog).getByRole("button", { name: "确认并长期记住" });
    expect(confirm).toBeDisabled();
    fireEvent.click(checkbox);
    fireEvent.click(confirm);

    expect(await within(dialog).findByRole("status")).toHaveTextContent("已长期记住");
    expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith("/cards/card_1/memory-proposals")))
      .toHaveLength(1);
    expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith("/memory-proposals/proposal_1/admit")))
      .toHaveLength(2);
  });

  it("fails closed when the server requires verified ownership", async () => {
    const requirement = {
      code: "verify_fact_owner" as const,
      resolution: "verified_owner" as const
    };
    const waiting = memoryProposal({
      policyVersion: "daily_reflection_memory_proposal_policy_v2",
      reasons: ["confirmation_required:verify_fact_owner"],
      confirmationRequirements: [requirement],
      version: 1
    });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) return jsonResponse(listResponse([card()]));
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "GET") return jsonResponse(detail());
      if (path.endsWith("/cards/card_1/memory-proposals")) {
        return jsonResponse({ proposal: memoryProposal(), reused: false }, 201);
      }
      if (path.endsWith("/memory-proposals/proposal_1/admit")) {
        return jsonResponse({
          status: "needs_confirmation",
          proposal: waiting,
          memoryId: null,
          reasons: waiting.reasons,
          confirmationRequirements: [requirement]
        });
      }
      return jsonResponse({ error: "not_found" }, 404);
    });
    render(<DailyReflectionCardLibrary api={testApi(fetcher)} />);

    fireEvent.click(await screen.findByRole("button", { name: "长期记住：散步后的洞察" }));
    await confirmRemember();
    expect(await screen.findByText("需要先确认内容归属")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "打开卡片确认" }));
    const dialog = await screen.findByRole("dialog", { name: "散步后的洞察" });
    expect(await within(dialog).findByText(
      "这条内容的归属还需要先在复盘中确认；确认前不会加入长期记忆。"
    )).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "确认并长期记住" })).not.toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith("/memory-proposals/proposal_1/admit")))
      .toHaveLength(1);
  });

  it("keeps a hard-rejected Card and explains that the Card itself remains", async () => {
    const rejected = memoryProposal({
      status: "rejected",
      policyVersion: "daily_reflection_memory_proposal_policy_v1",
      score: 0.25,
      reasons: ["summary_score_below_threshold"],
      version: 1
    });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) return jsonResponse(listResponse([card()]));
      if (path.endsWith("/cards/card_1/memory-proposals")) {
        return jsonResponse({ proposal: memoryProposal(), reused: false }, 201);
      }
      if (path.endsWith("/memory-proposals/proposal_1/admit")) {
        return jsonResponse({
          status: "rejected",
          proposal: rejected,
          memoryId: null,
          reasons: rejected.reasons,
          confirmationRequirements: []
        });
      }
      return jsonResponse({ error: "not_found" }, 404);
    });
    render(<DailyReflectionCardLibrary api={testApi(fetcher)} />);

    fireEvent.click(await screen.findByRole("button", { name: "长期记住：散步后的洞察" }));
    await confirmRemember();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "未通过长期记忆审核；卡片本身仍会保留。"
    );
    expect(screen.getByRole("button", { name: "打开卡片：散步后的洞察" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("fails closed for action Cards without a public claim and unavailable sources", async () => {
    const action = card("saved", false, {
      id: "card_action",
      cardKind: "action",
      title: "下周整理三条样本"
    });
    const unavailable = card("saved", true, {
      id: "card_unavailable",
      title: "来源已经不可用"
    });
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input).startsWith("/api/daily-reflections/cards?")
      ? jsonResponse(listResponse([action, unavailable]))
      : jsonResponse({ error: "not_found" }, 404));
    render(<DailyReflectionCardLibrary api={testApi(fetcher)} />);

    const disabled = await screen.findByRole("button", { name: "长期记住" });
    expect(disabled).toBeDisabled();
    expect(screen.getByText("打开卡片核对行动认领状态")).toBeVisible();
    expect(screen.getByText("来源不可用，无法长期记住")).toBeVisible();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("reuses the same Proposal after a retryable admit failure", async () => {
    let admitAttempt = 0;
    let listCalls = 0;
    const admitted = memoryProposal({
      status: "admitted",
      policyVersion: "daily_reflection_memory_proposal_policy_v1",
      score: 0.82,
      reasons: ["policy_threshold_met"],
      memoryId: "memory_1",
      version: 3,
      admittedAt: "2026-08-13T08:01:00.000Z"
    });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) {
        listCalls += 1;
        return jsonResponse(listResponse([card()]));
      }
      if (path.endsWith("/cards/card_1/memory-proposals")) {
        return jsonResponse({ proposal: memoryProposal(), reused: false }, 201);
      }
      if (path.endsWith("/memory-proposals/proposal_1/admit")) {
        admitAttempt += 1;
        if (admitAttempt === 1) {
          return jsonResponse({
            error: "daily_reflection_memory_proposal_publication_failed",
            retryable: true
          }, 503);
        }
        if (admitAttempt === 2) {
          return jsonResponse({
            status: "admitted",
            proposal: admitted,
            memoryId: "memory_1",
            reasons: ["policy_threshold_met"],
            confirmationRequirements: []
          });
        }
        return jsonResponse({ error: "version_conflict", currentVersion: 4 }, 409);
      }
      return jsonResponse({ error: "not_found" }, 404);
    });
    render(<DailyReflectionCardLibrary api={testApi(fetcher)} />);

    fireEvent.click(await screen.findByRole("button", { name: "长期记住：散步后的洞察" }));
    await confirmRemember();
    expect(await screen.findByRole("alert")).toHaveTextContent("长期记忆还没有完成保存");
    fireEvent.click(screen.getByRole("button", { name: "长期记住：散步后的洞察" }));
    await confirmRemember();
    expect(await screen.findByRole("status")).toHaveTextContent("已长期记住");
    expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith("/cards/card_1/memory-proposals")))
      .toHaveLength(1);
    expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith("/memory-proposals/proposal_1/admit")))
      .toHaveLength(2);
    expect(listCalls).toBeGreaterThan(1);
  });

  it("refreshes server truth after a Proposal version conflict without retrying", async () => {
    let listCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) {
        listCalls += 1;
        return jsonResponse(listResponse([card()]));
      }
      if (path.endsWith("/cards/card_1/memory-proposals")) {
        return jsonResponse({ error: "version_conflict", currentVersion: 2 }, 409);
      }
      return jsonResponse({ error: "not_found" }, 404);
    });
    render(<DailyReflectionCardLibrary api={testApi(fetcher)} />);

    fireEvent.click(await screen.findByRole("button", { name: "长期记住：散步后的洞察" }));
    await confirmRemember();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "这张卡片已经在其他页面更新，已重新加载最新内容。"
    );
    expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith("/cards/card_1/memory-proposals")))
      .toHaveLength(1);
    expect(listCalls).toBeGreaterThan(1);
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
    render(<DailyReflectionCardLibrary api={testApi(fetcher)} />);
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
    render(<DailyReflectionCardLibrary api={testApi(fetcher)} />);
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
    render(<DailyReflectionCardLibrary api={testApi(fetcher)} />);
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
    render(<DailyReflectionCardLibrary api={testApi(fetcher)} initialCardId="card_1" />);
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
    render(<DailyReflectionCardLibrary api={testApi(fetcher)} />);
    fireEvent.click(await screen.findByRole("button", { name: "打开卡片：散步后的洞察" }));
    const dialog = await screen.findByRole("dialog", { name: "散步后的洞察" });
    expect(dialog).toHaveAttribute("data-phase", "open");
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭卡片详情" }));
    expect(screen.queryByRole("dialog", { name: "散步后的洞察" })).not.toBeInTheDocument();
  });
});

describe("Card to Durable Memory explicit entry", () => {
  const fetchCards = async (input: RequestInfo | URL) => String(input).startsWith("/api/daily-reflections/cards?")
    ? jsonResponse(listResponse([card()])) : jsonResponse(detail());

  it("cancels the initial confirmation with zero Proposal or Memory writes", async () => {
    const api = testApi(fetchCards, { createWorkingCardMemoryProposal: vi.fn(), admitMemoryProposal: vi.fn() });
    render(<DailyReflectionCardLibrary api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "长期记住：散步后的洞察" }));
    expect(screen.getByText(/确认将.*加入长期记忆/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "先只保留卡片" }));
    expect(api.createWorkingCardMemoryProposal).not.toHaveBeenCalled();
    expect(api.evaluateMemoryProposal).not.toHaveBeenCalled();
    expect(api.admitMemoryProposal).not.toHaveBeenCalled();
  });

  it("shows the actual evaluation rejection and never calls Admission", async () => {
    const api = testApi(fetchCards, {
      createWorkingCardMemoryProposal: vi.fn(async () => ({ proposal: memoryProposal(), reused: false })) as DailyReflectionApi["createWorkingCardMemoryProposal"],
      evaluateMemoryProposal: vi.fn(async () => ({ status: "rejected", proposal: memoryProposal({ status: "rejected", reasons: ["canonical_evidence_invalid"], version: 2 }), memoryId: null, reasons: ["canonical_evidence_invalid"], confirmationRequirements: [] })) as DailyReflectionApi["evaluateMemoryProposal"],
      admitMemoryProposal: vi.fn()
    });
    render(<DailyReflectionCardLibrary api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "长期记住：散步后的洞察" }));
    await confirmRemember();
    expect(await screen.findByText(/原话依据未通过核对/)).toBeVisible();
    expect(screen.queryByText("已长期记住")).not.toBeInTheDocument();
    expect(api.admitMemoryProposal).not.toHaveBeenCalled();
  });

  it.each(["pending", "approved", "rejected", "admitted"] as const)("restores %s state from the server when a Card is reopened, without mutations", async (status) => {
    const api = testApi(fetchCards, {
      getWorkingCardMemoryProposal: vi.fn(async () => ({ proposal: memoryProposal({ status, reasons: status === "rejected" ? ["canonical_evidence_invalid"] : [], memoryId: status === "admitted" ? "memory_1" : null, admittedAt: status === "admitted" ? "2026-08-13T08:01:00.000Z" : null }), publicationStatus: "unpublished", revoked: false, actionClaimed: false })) as DailyReflectionApi["getWorkingCardMemoryProposal"],
      createWorkingCardMemoryProposal: vi.fn(), admitMemoryProposal: vi.fn()
    });
    render(<DailyReflectionCardLibrary api={api} initialCardId="card_1" />);
    const dialog = await screen.findByRole("dialog", { name: "散步后的洞察" });
    const message = status === "pending" ? "待审核或确认，尚未加入长期记忆。"
      : status === "approved" ? "已通过审核，尚未加入长期记忆。"
      : status === "rejected" ? "未通过长期记忆审核；卡片本身仍会保留。"
      : "已接纳，正在等待完成发布；暂不可作为长期记忆读取。";
    expect(await within(dialog).findByText(message)).toBeVisible();
    expect(within(dialog).queryByText("已长期记住")).not.toBeInTheDocument();
    expect(api.createWorkingCardMemoryProposal).not.toHaveBeenCalled();
    expect(api.evaluateMemoryProposal).not.toHaveBeenCalled();
    expect(api.admitMemoryProposal).not.toHaveBeenCalled();
  });

  it("allows an already claimed action only after reading the stored claim and explicit confirmation", async () => {
    const action = { ...detail().card, cardKind: "action" as const };
    const api = testApi(fetchCards, {
      getWorkingCard: vi.fn(async () => ({ card: action })),
      getWorkingCardMemoryProposal: vi.fn(async () => ({ proposal: null, publicationStatus: null, revoked: false, actionClaimed: true })),
      createWorkingCardMemoryProposal: vi.fn(async () => { throw new Error("stop before evaluation"); })
    });
    render(<DailyReflectionCardLibrary api={api} initialCardId="card_1" />);
    const dialog = await screen.findByRole("dialog", { name: "散步后的洞察" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "长期记住：散步后的洞察" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "确认长期记住" }));
    await waitFor(() => expect(api.createWorkingCardMemoryProposal).toHaveBeenCalledWith("card_1", { expectedCardVersion: 1, memoryType: "commitment" }));
  });
});

it("uses the real client create/evaluate/admit transport only after confirmation, with the evaluated version", async () => {
  let active = false;
  const admitted = memoryProposal({ status: "admitted", memoryId: "memory_1", admittedAt: "2026-08-13T08:01:00.000Z", version: 5 });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/daily-reflections/cards?")) return jsonResponse(listResponse([card("saved", false, { memoryLifecycleStatus: active ? "active" : "not_admitted" })]));
    if (url.endsWith("/cards/card_1/memory-proposals")) return jsonResponse({ proposal: memoryProposal(), reused: false }, 201);
    if (url.endsWith("/evaluate")) return jsonResponse({ status: "approved", proposal: memoryProposal({ status: "approved", version: 2 }), memoryId: null, reasons: [], confirmationRequirements: [] });
    if (url.endsWith("/admit")) {
      expect(JSON.parse(String(init?.body))).toEqual({ expectedVersion: 2, acknowledgements: [] });
      active = true;
      return jsonResponse({ status: "admitted", proposal: admitted, memoryId: "memory_1", reasons: [], confirmationRequirements: [] });
    }
    return jsonResponse({ error: "not_found" }, 404);
  });
  render(<DailyReflectionCardLibrary api={createDailyReflectionApi(fetcher)} />);
  fireEvent.click(await screen.findByRole("button", { name: "长期记住：散步后的洞察" }));
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  await confirmRemember();
  expect(await screen.findByText("已长期记住")).toBeVisible();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST").map(([url]) => String(url))).toEqual([
    "/api/daily-reflections/cards/card_1/memory-proposals",
    "/api/daily-reflections/memory-proposals/proposal_1/evaluate",
    "/api/daily-reflections/memory-proposals/proposal_1/admit"
  ]);
});

it.each([
  card("archived"), card("removed"), card("saved", true),
  card("saved", false, { memoryLifecycleStatus: "revoked" }),
  card("saved", false, { memoryLifecycleStatus: "revocation_requested" })
])("offers no promotion for ineligible lifecycle $status / $memoryLifecycleStatus / source=$sourceUnavailable", async (item) => {
  const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(listResponse([item])));
  render(<DailyReflectionCardLibrary api={testApi(fetcher)} />);
  await screen.findByRole("button", { name: "打开卡片：散步后的洞察" });
  expect(screen.queryByRole("button", { name: "长期记住：散步后的洞察" })).not.toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
});
