import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createDailyReflectionApi } from "@/lib/client/daily-reflection-api";

import { DailyReflectionQuery } from "./daily-reflection-query";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function evidence() {
  return {
    reflectionId: "reflection_1",
    cardId: "card_1",
    recordingDate: "2026-08-20",
    sourceOrigin: "user_reflection",
    sourceSegmentId: "segment_1",
    startSeconds: 65,
    endSeconds: 72,
    snippet: "我最开始考虑继续原来的方向，后来决定换一个方向。"
  };
}

function response(answer = "你先比较了两个方向，后来明确选择了新的方向。") {
  return {
    answer,
    intent: "belief_change",
    confidence: 0.92,
    insufficientEvidence: false,
    claims: [{
      text: "你的决定是在比较之后发生变化的。",
      sourceMemoryIds: ["memory_1"],
      sourceCardIds: ["card_1"],
      evidenceIds: ["segment_1"],
      evidence: [evidence()],
      epistemicStatuses: ["explicit_user_statement"]
    }],
    resurfacing: {
      title: "也可以回看最初的考虑",
      body: "这条记录保留了决定变化前的想法。",
      earliestDate: "2026-08-20",
      evidence: evidence()
    },
    createdAt: "2026-08-24T06:00:00.000Z"
  };
}

describe("DailyReflectionQuery", () => {
  it("posts one scoped question and displays only sourced, user-facing results", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(response()));
    const { container } = render(
      <DailyReflectionQuery api={createDailyReflectionApi(fetcher)} />
    );

    fireEvent.change(screen.getByLabelText("你想问什么"), {
      target: { value: "  我为什么后来换了方向？  " }
    });
    fireEvent.change(screen.getByLabelText("查找范围"), {
      target: { value: "last_30_days" }
    });
    fireEvent.click(screen.getByRole("button", { name: "查找" }));

    expect(await screen.findByText("你先比较了两个方向，后来明确选择了新的方向。")).toBeVisible();
    expect(screen.getByText("想法如何变化")).toBeVisible();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/daily-reflections/query",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "我为什么后来换了方向?",
          scope: "last_30_days"
        })
      })
    );
    expect(screen.getByText("我最开始考虑继续原来的方向，后来决定换一个方向。")).toBeVisible();
    expect(screen.getByText("你在 2026-08-20 的复盘中提到 · 录音 1:05")).toBeVisible();
    expect(screen.getByRole("link", { name: "查看完整来源" })).toHaveAttribute(
      "href",
      "/reflection/sessions/reflection_1?segment=segment_1"
    );
    expect(screen.queryByRole("button", { name: "查看第 1 条回答来源" })).not.toBeInTheDocument();
    expect(screen.getByText("这次回答参考了 1 张卡片、1 次复盘和 1 条长期记忆。")).toBeVisible();

    expect(screen.getByRole("heading", { name: "也可以回看最初的考虑" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭回看提示" }));
    expect(screen.queryByRole("heading", { name: "也可以回看最初的考虑" })).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);

    for (const forbidden of [
      "belief_change",
      "0.92",
      "memory_1",
      "card_1",
      "segment_1",
      "Provider",
      "Candidate",
      "Admission",
      "pipeline",
      "token",
      "confidence"
    ]) {
      expect(container.textContent).not.toContain(forbidden);
    }
  });

  it("uses the full evidence timeline only when an answer has multiple sources", async () => {
    const first = response();
    const secondEvidence = {
      ...evidence(),
      reflectionId: "reflection_2",
      cardId: "card_2",
      recordingDate: "2026-08-22",
      sourceSegmentId: "segment_2",
      startSeconds: 18,
      endSeconds: 25,
      snippet: "后来我确认先做桌面端，验证完整记录的阅读体验。"
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      ...first,
      claims: [
        first.claims[0],
        {
          text: "之后你再次确认了这个选择。",
          sourceMemoryIds: ["memory_2"],
          sourceCardIds: ["card_2"],
          evidenceIds: ["segment_2"],
          evidence: [secondEvidence],
          epistemicStatuses: ["explicit_user_statement"]
        }
      ]
    }));
    render(<DailyReflectionQuery api={createDailyReflectionApi(fetcher)} />);

    fireEvent.change(screen.getByLabelText("你想问什么"), {
      target: { value: "这个选择是怎样确定下来的？" }
    });
    fireEvent.click(screen.getByRole("button", { name: "查找" }));

    expect(await screen.findByRole("button", { name: "查看第 1 条回答来源" })).toBeVisible();
    expect(screen.getByRole("button", { name: "查看第 2 条回答来源" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "查看完整来源" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看第 2 条回答来源" }));
    expect(screen.getByText(secondEvidence.snippet)).toBeVisible();
    expect(screen.getByRole("link", { name: "在原复盘中查看" })).toHaveAttribute(
      "href",
      "/reflection/sessions/reflection_2?segment=segment_2"
    );
  });

  it("replaces the previous answer instead of building chat history", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(response("第一次回答。")))
      .mockResolvedValueOnce(jsonResponse(response("第二次回答。")));
    render(<DailyReflectionQuery api={createDailyReflectionApi(fetcher)} />);

    fireEvent.change(screen.getByLabelText("你想问什么"), { target: { value: "第一个问题" } });
    fireEvent.click(screen.getByRole("button", { name: "查找" }));
    expect(await screen.findByText("第一次回答。")).toBeVisible();

    fireEvent.change(screen.getByLabelText("你想问什么"), { target: { value: "第二个问题" } });
    fireEvent.click(screen.getByRole("button", { name: "查找" }));
    expect(await screen.findByText("第二次回答。")).toBeVisible();
    expect(screen.queryByText("第一次回答。")).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("renders an explicit insufficient-evidence result without inventing sources", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      ...response("现有记录不足以回答这个问题。"),
      confidence: 0,
      insufficientEvidence: true,
      claims: [],
      resurfacing: null
    }));
    render(<DailyReflectionQuery api={createDailyReflectionApi(fetcher)} />);

    fireEvent.change(screen.getByLabelText("你想问什么"), { target: { value: "没有证据的问题" } });
    fireEvent.click(screen.getByRole("button", { name: "查找" }));

    expect(await screen.findByText("现有记录不足以回答这个问题。")).toBeVisible();
    expect(screen.getByText("现有记录还不足以支持确定结论。")).toBeVisible();
    expect(screen.getByText("没有足够来源可以展开。")).toBeVisible();
    expect(screen.queryByRole("button", { name: /回答来源/u })).not.toBeInTheDocument();
  });

  it("fails closed for malformed or unsourced success responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      ...response("不应显示的回答。"),
      claims: [],
      provider: "must-not-leak"
    }));
    render(<DailyReflectionQuery api={createDailyReflectionApi(fetcher)} />);

    fireEvent.change(screen.getByLabelText("你想问什么"), { target: { value: "测试问题" } });
    fireEvent.click(screen.getByRole("button", { name: "查找" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法查找你的复盘，请稍后重试。");
    expect(screen.queryByText("不应显示的回答。")).not.toBeInTheDocument();
  });

  it("keeps a one-character question local and makes no request", () => {
    const fetcher = vi.fn<typeof fetch>();
    render(<DailyReflectionQuery api={createDailyReflectionApi(fetcher)} />);
    const submit = screen.getByRole("button", { name: "查找" });
    fireEvent.change(screen.getByLabelText("你想问什么"), {
      target: { value: "问" }
    });
    expect(submit).toBeDisabled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
