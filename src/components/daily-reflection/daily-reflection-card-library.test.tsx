import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createDailyReflectionApi } from "@/lib/client/daily-reflection-api";

import { DailyReflectionCardLibrary } from "./daily-reflection-card-library";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function card(status: "saved" | "archived" | "removed" = "saved", sourceUnavailable = false) {
  return {
    id: "card_1",
    sourceReflectionIds: ["reflection_1"],
    title: "散步后的洞察",
    content: "散步让我更容易整理思路。",
    cardKind: "insight" as const,
    evidenceIds: ["segment_1"],
    status,
    importance: 0.8,
    novelty: 0.7,
    relatedCardIds: [],
    tags: ["散步"],
    visibility: "private" as const,
    sourceUnavailable,
    memoryLifecycleStatus: "not_admitted" as const,
    memoryLifecycleVersion: 0,
    memoryLifecycleUpdatedAt: null,
    version: status === "saved" ? 1 : status === "archived" ? 2 : 3,
    createdAt: "2026-08-13T08:00:00.000Z",
    updatedAt: "2026-08-13T08:00:00.000Z"
  };
}

function detail(status: "saved" | "archived" | "removed" = "saved", sourceUnavailable = false) {
  return {
    card: {
      ...card(status, sourceUnavailable),
      evidence: sourceUnavailable ? [] : [{
        sourceSegmentId: "segment_1",
        uploadId: "upload_1",
        effectiveOrigin: "user_reflection" as const,
        startSeconds: 5,
        endSeconds: 12,
        text: "散步以后，我觉得思路更清楚了。"
      }]
    }
  };
}

describe("DailyReflectionCardLibrary", () => {
  it("opens a deep-linked Card without exposing the id as page text", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) {
        return jsonResponse({ cards: [card()], total: 1, limit: 50, offset: 0 });
      }
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "GET") {
        return jsonResponse(detail());
      }
      return jsonResponse({ error: "not_found" }, 404);
    });
    render(<DailyReflectionCardLibrary
      api={createDailyReflectionApi(fetcher)}
      initialCardId="card_1"
    />);

    expect(await screen.findByText("散步以后，我觉得思路更清楚了。")).toBeVisible();
    expect(fetcher.mock.calls.filter(([path, init]) => (
      String(path) === "/api/daily-reflections/cards/card_1" && init?.method === "GET"
    ))).toHaveLength(1);
    expect(screen.getByRole("link", { name: "查看来源复盘" }))
      .toHaveAttribute("href", "/date-companion/reflection?reflectionId=reflection_1");
  });

  it("searches and filters scoped Cards, edits details, and shows Canonical Evidence", async () => {
    let current = detail();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) {
        return jsonResponse({
          cards: [current.card].map(({ evidence: _evidence, ...item }) => item),
          total: 1,
          limit: 50,
          offset: 0
        });
      }
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "GET") {
        return jsonResponse(current);
      }
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "PATCH") {
        const payload = JSON.parse(String(init.body)) as { title: string; content: string };
        current = {
          card: {
            ...current.card,
            title: payload.title,
            content: payload.content,
            version: current.card.version + 1
          }
        };
        return jsonResponse(current);
      }
      return jsonResponse({ error: "not_found" }, 404);
    });
    render(<DailyReflectionCardLibrary
      api={createDailyReflectionApi(fetcher)}
      now={() => new Date("2026-08-24T00:00:00.000Z")}
    />);

    expect(await screen.findByText("散步后的洞察")).toBeVisible();
    fireEvent.change(screen.getByLabelText("搜索 My Cards"), { target: { value: "散步" } });
    fireEvent.change(screen.getByLabelText("按类型筛选"), { target: { value: "insight" } });
    fireEvent.change(screen.getByLabelText("按状态筛选"), { target: { value: "removed" } });
    fireEvent.change(screen.getByLabelText("按时间筛选"), { target: { value: "30d" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() => {
      const listCall = [...fetcher.mock.calls].reverse().find(([path]) => String(path).includes("cards?"));
      expect(String(listCall?.[0])).toContain("type=insight");
      expect(String(listCall?.[0])).toContain("status=removed");
      expect(String(listCall?.[0])).toContain("q=%E6%95%A3%E6%AD%A5");
      expect(String(listCall?.[0])).toContain("from=2026-07-25T00%3A00%3A00.000Z");
    });

    fireEvent.click(screen.getByRole("button", { name: "查看详情" }));
    expect(await screen.findByText("散步以后，我觉得思路更清楚了。")).toBeVisible();
    expect(screen.getByRole("link", { name: "查看来源复盘" }))
      .toHaveAttribute("href", "/date-companion/reflection?reflectionId=reflection_1");
    fireEvent.change(screen.getByLabelText("编辑 Card 标题"), {
      target: { value: "更新后的洞察" }
    });
    fireEvent.change(screen.getByLabelText("编辑 Card 内容"), {
      target: { value: "更新后的内容。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      "/api/daily-reflections/cards/card_1",
      expect.objectContaining({ method: "PATCH" })
    ));
    expect(await screen.findByDisplayValue("更新后的洞察")).toBeVisible();
    expect(document.body.textContent).not.toContain("Provider");
    expect(document.body.textContent).not.toContain("Candidate");
    expect(document.body.textContent).not.toContain("confidence");
  });

  it("shows unavailable provenance and keeps archive, restore, and remove recoverable", async () => {
    let status: "saved" | "archived" | "removed" = "saved";
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) {
        return jsonResponse({
          cards: status === "removed" ? [] : [card(status, true)],
          total: status === "removed" ? 0 : 1,
          limit: 50,
          offset: 0
        });
      }
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "GET") {
        return jsonResponse(detail(status, true));
      }
      if (path.endsWith("/archive")) status = "archived";
      else if (path.endsWith("/restore")) status = "saved";
      else if (path === "/api/daily-reflections/cards/card_1" && init?.method === "DELETE") status = "removed";
      return jsonResponse(detail(status, true));
    });
    render(<DailyReflectionCardLibrary api={createDailyReflectionApi(fetcher)} />);

    fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));
    expect(await screen.findByText(/原始来源已不可用/u)).toBeVisible();
    expect(screen.queryByRole("link", { name: /查看来源复盘/u })).not.toBeInTheDocument();
    expect(screen.queryByText("散步以后，我觉得思路更清楚了。")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    expect(await screen.findByRole("button", { name: "恢复" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    expect(await screen.findByRole("button", { name: "归档" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "从 My Cards 移除" }));
    expect(await screen.findByRole("button", { name: "恢复" })).toBeVisible();
    expect(fetcher.mock.calls.map(([path, init]) => [String(path), init?.method]))
      .toEqual(expect.arrayContaining([
        ["/api/daily-reflections/cards/card_1/archive", "POST"],
        ["/api/daily-reflections/cards/card_1/restore", "POST"],
        ["/api/daily-reflections/cards/card_1", "DELETE"]
      ]));
  });

  it("revokes an active long-term source and then shows the authoritative state", async () => {
    let current = {
      card: {
        ...detail().card,
        memoryLifecycleStatus: "active" as "active" | "revoked",
        memoryLifecycleVersion: 1,
        memoryLifecycleUpdatedAt: "2026-08-24T08:00:00.000Z"
      }
    };
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/daily-reflections/cards?")) {
        const { evidence: _evidence, ...summary } = current.card;
        return jsonResponse({ cards: [summary], total: 1, limit: 50, offset: 0 });
      }
      if (path === "/api/daily-reflections/cards/card_1/revoke") {
        current = {
          card: {
            ...current.card,
            memoryLifecycleStatus: "revoked",
            memoryLifecycleVersion: 2
          }
        };
        const { evidence: _evidence, ...publicCard } = current.card;
        return jsonResponse({
          card: publicCard,
          lifecycleStatus: "revoked",
          operation: {
            status: "completed",
            attemptVersion: 1,
            requestedMemoryLifecycleVersion: 1,
            indexRefreshStatus: "not_required",
            errorCode: null,
            updatedAt: "2026-08-24T08:00:00.000Z",
            completedAt: "2026-08-24T08:00:00.000Z"
          },
          receipt: {
            cardId: "card_1",
            proposalId: "proposal_1",
            outcome: "revoked",
            historicalMemoryId: "memory_1",
            removedMemoryEvidenceCount: 1,
            removedPersonSourceCount: 0,
            createdAt: "2026-08-24T08:00:00.000Z"
          },
          reused: false
        });
      }
      if (path === "/api/daily-reflections/cards/card_1" && init?.method === "GET") {
        return jsonResponse(current);
      }
      return jsonResponse({ error: "not_found" }, 404);
    });
    render(<DailyReflectionCardLibrary api={createDailyReflectionApi(fetcher)} />);

    fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));
    fireEvent.click(await screen.findByRole("button", { name: "撤销长期记忆来源" }));
    expect(await screen.findByText("长期记忆来源已撤销")).toBeVisible();
    const revokeCall = fetcher.mock.calls.find(([path]) => String(path).endsWith("/revoke"));
    expect(revokeCall?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(revokeCall?.[1]?.body))).toEqual({
      expectedMemoryLifecycleVersion: 1,
      idempotencyKey: "daily-reflection-card-revoke:card_1"
    });
  });
});
