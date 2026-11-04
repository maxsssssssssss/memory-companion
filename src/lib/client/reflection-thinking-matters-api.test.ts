import { describe, expect, it, vi } from "vitest";

import { createThinkingMattersApi, ThinkingMattersApiError } from "./reflection-thinking-matters-api";

describe("saved thinking matters client", () => {
  it.each(["linkCard", "unlinkCard"] as const)("sends only explicit card identity/version for %s", async action => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
    const api = createThinkingMattersApi(fetcher);
    const input = { operationKey: "card_operation", expectedVersion: 2, cardId: "card_1", ...(action === "linkCard" ? { cardVersion: 3 } : {}) };
    const result = action === "linkCard" ? api.linkCard("matter_1", { ...input, cardVersion: 3 }) : api.unlinkCard("matter_1", input);
    await expect(result).rejects.toMatchObject({ status: 404 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("/api/daily-reflections/thinking/matters/matter_1", expect.objectContaining({
      method: "POST", cache: "no-store", credentials: "same-origin",
      body: JSON.stringify({ action: action === "linkCard" ? "link_card" : "unlink_card", ...input }),
    }));
  });

  it("passes explicit single-card permission when creating without enabling general history", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
    const api = createThinkingMattersApi(fetcher);
    const input = { operationKey: "create_from_card", question: "只比较两个方向。", contextMode: "none" as const, sourceCardId: "card_1", sourceCardVersion: 3 };
    await expect(api.create(input)).rejects.toMatchObject({ status: 404 });
    expect(fetcher).toHaveBeenCalledWith("/api/daily-reflections/thinking/matters", expect.objectContaining({ body: JSON.stringify(input) }));
  });

  it("uses same-account private no-store requests and passes the explicit feedback event", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "thinking_matter_not_found" }), { status: 404 }));
    const api = createThinkingMattersApi(fetcher);
    await expect(api.turn("matter_1", { operationKey: "operation_1", expectedVersion: 2, text: "我试过了。", feedback: true })).rejects.toMatchObject({ status: 404 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("/api/daily-reflections/thinking/matters/matter_1", expect.objectContaining({
      method: "POST", credentials: "same-origin", cache: "no-store",
      body: JSON.stringify({ action: "turn", operationKey: "operation_1", expectedVersion: 2, text: "我试过了。", feedback: true }),
    }));
  });

  it("does not automatically resend a request after a disconnected save", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("private transport details"));
    const api = createThinkingMattersApi(fetcher);
    await expect(api.mutate("matter_1", { operationKey: "operation_1", expectedVersion: 2, kind: "adopt", suggestionId: "suggestion_1" })).rejects.toMatchObject({
      status: 0, code: "unknown", message: "连接中断，保存或回复的结果尚未确认。请先重新读取进展。",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("requests recovery inspection without a retry or model turn", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "thinking_matter_not_found" }), { status: 404 }));
    const api = createThinkingMattersApi(fetcher);
    await expect(api.recover("matter_1", { operationKey: "inspect_1" })).rejects.toMatchObject({ status: 404 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("/api/daily-reflections/thinking/matters/matter_1", expect.objectContaining({
      body: JSON.stringify({ action: "recover", operationKey: "inspect_1" }),
    }));
  });

  it("keeps malformed replies out of the page and hides schema details", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ matter: { databaseId: "private-id" }, events: [] })));
    const api = createThinkingMattersApi(fetcher);
    await expect(api.get("matter_1")).rejects.toEqual(expect.objectContaining({ code: "invalid_response", message: "暂时无法读取已保存的进展，请稍后重新读取。" }));
  });

  it("keeps backend error bodies private and explains authentication failure", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "private-backend-error" }), { status: 401 }));
    const api = createThinkingMattersApi(fetcher);
    try { await api.list(); throw new Error("must fail"); }
    catch (error) {
      expect(error).toBeInstanceOf(ThinkingMattersApiError);
      expect((error as Error).message).toBe("登录已失效，请重新登录。");
    }
  });
});
