import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { QaBrowserStreamEvent } from "@/lib/qa-browser-stream";
import { QaPanel } from "./qa-panel";
import { QaVoiceWorkspace } from "./qa-voice-workspace";

function mockSettingsFetch() {
  return vi.fn((url: string | URL | Request) => {
    if (url === "/api/settings") {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          qaModel: "openai/gpt-5-mini",
          qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
        })
      });
    }

    throw new Error(`Unexpected request: ${String(url)}`);
  });
}

function qaPromptPresets() {
  return [
    { id: "work", label: "工作复盘", description: "决策、任务、风险" },
    { id: "date", label: "约会陪伴", description: "互动、感受、关系线索" },
    { id: "negotiation", label: "商务谈判", description: "诉求、筹码、风险" },
    { id: "learning", label: "听课学习", description: "知识点、例子、复习" },
    { id: "casual", label: "日常闲聊", description: "生活细节、轻松记录" },
    { id: "custom", label: "自定义", description: "使用你写的提示词" }
  ];
}

function controlledQaStreamResponse() {
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      }
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" }
    }
  );

  return {
    response,
    emit(event: QaBrowserStreamEvent) {
      streamController?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    },
    close() {
      streamController?.close();
    }
  };
}

function finalStreamAnswer(overrides: Record<string, unknown> = {}) {
  return {
    id: "answer_streamed",
    uploadId: "upload_1",
    question: "今天有什么重点？",
    answer: "第一句。第二句。",
    citedSegmentIds: ["seg_1", "seg_2"],
    citations: [
      {
        id: "E1",
        title: "第一条证据",
        startSeconds: 0,
        endSeconds: 5,
        excerpt: "第一条摘录",
        sourceSegmentIds: ["seg_1"]
      },
      {
        id: "E2",
        title: "第二条证据",
        startSeconds: 6,
        endSeconds: 10,
        excerpt: "第二条摘录",
        sourceSegmentIds: ["seg_2"]
      }
    ],
    createdAt: "2026-07-23T08:00:00.000Z",
    ...overrides
  };
}

describe("QaPanel", () => {
  it("renders restrained companion copy for the current day scope", async () => {
    vi.stubGlobal("fetch", mockSettingsFetch());

    render(<QaPanel uploadId="upload_1" scope="current" />);

    expect(screen.getByRole("heading", { name: "问问这一天" })).toBeInTheDocument();
    expect(screen.getByText("我会只根据这一天的录音回答，不确定的地方会直接说明。")).toBeInTheDocument();
    expect(screen.getByLabelText("问题")).toHaveValue("");
    expect(screen.getByRole("button", { name: /这一天最值得我记住的是什么？/ })).toBeInTheDocument();
    expect(screen.getByText("基于当天证据")).toBeInTheDocument();
  });

  it("renders suggested questions in their own section before static scope suggestions", async () => {
    vi.stubGlobal("fetch", mockSettingsFetch());

    render(
      <QaPanel
        uploadId="upload_1"
        scope="current"
        suggestedQuestions={[
          {
            id: "suggestion_relationship_1",
            scope: "current",
            question: "这次录音里的关系信号，原文证据是什么？",
            reason: "积极信号：对方先回应了疲惫感，再讨论下一步安排。",
            sourceType: "relationship_signal",
            sourceIds: ["signal_1"],
            sourceUploadIds: ["upload_1"]
          }
        ]}
      />
    );

    expect(screen.getByText("你可能想问")).toBeInTheDocument();
    expect(screen.queryByText("AI 主动观察")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /这次录音里的关系信号，原文证据是什么？/ })).toBeInTheDocument();
    expect(screen.getByText("积极信号：对方先回应了疲惫感，再讨论下一步安排。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /杩欎竴澶╂渶鍊煎緱鎴戣浣忕殑鏄粈涔堬紵/ })).not.toBeInTheDocument();
  });

  it("renders Agent observations and questions as independent records", async () => {
    vi.stubGlobal("fetch", mockSettingsFetch());

    render(
      <QaPanel
        uploadId="upload_1"
        scope="current"
        proactiveObservations={[
          {
            id: "agent_insight_1",
            scope: "current",
            type: "reminder",
            title: "可以确认",
            content: "对话里出现了下一次见面的意向，但时间还没有落定。",
            evidenceRefs: [
              {
                evidenceId: "relationship_signal:signal_1",
                kind: "relationship_signal",
                sourceType: "relationship_signal",
                sourceId: "signal_1",
                uploadId: "upload_1",
                recordingDate: "2026-07-09",
                sourceSegmentIds: ["seg_1"],
                timeRange: { startSeconds: 10, endSeconds: 20 },
                title: "见面时间仍待确认",
                summary: "双方提到下次见面，但时间尚未落定。",
                excerpt: "那我们之后再确认具体时间。"
              }
            ],
            relatedQuestions: ["这次互动里还有什么需要继续确认？"],
            memoryAware: true,
            caution: "这只是当前录音中的互动线索，需要结合后续沟通继续确认。"
          }
        ]}
        suggestedQuestions={[
          {
            id: "agent_insight_1_question",
            scope: "current",
            question: "这次互动里还有什么需要继续确认？",
            reason: "安排已经被提到，但具体时间仍需确认。",
            sourceType: "relationship_signal",
            sourceIds: ["signal_1"],
            sourceUploadIds: ["upload_1"],
            relatedObservationId: "agent_insight_1"
          }
        ]}
      />
    );

    expect(screen.getByText("AI 主动观察")).toBeInTheDocument();
    expect(screen.getByText("可以确认")).toBeInTheDocument();
    expect(screen.getByText("对话里出现了下一次见面的意向，但时间还没有落定。")).toBeInTheDocument();
    expect(screen.queryByText(/置信度/)).not.toBeInTheDocument();
    expect(screen.getByText("结合当前记录和已有记忆")).toBeInTheDocument();
    expect(screen.getByText("这只是当前录音中的互动线索，需要结合后续沟通继续确认。")).toBeInTheDocument();
    expect(screen.getByText("你可能想问")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /这次互动里还有什么需要继续确认？/ })).toBeInTheDocument();
    fireEvent.click(screen.getByText(/查看依据/));
    expect(screen.getByText("那我们之后再确认具体时间。")).toBeInTheDocument();
  });

  it("caps the suggested-question area at three cards", async () => {
    vi.stubGlobal("fetch", mockSettingsFetch());

    render(
      <QaPanel
        uploadId="upload_1"
        scope="current"
        suggestedQuestions={Array.from({ length: 5 }, (_, index) => ({
          id: `suggestion_${index + 1}`,
          scope: "current" as const,
          question: `具体问题 ${index + 1}？`,
          reason: `对应事件 ${index + 1}`,
          sourceType: "brief" as const,
          sourceIds: [`brief_${index + 1}`],
          sourceUploadIds: ["upload_1"]
        }))}
      />
    );

    expect(screen.getByRole("button", { name: /具体问题 1？/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /具体问题 3？/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /具体问题 4？/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /具体问题 5？/ })).not.toBeInTheDocument();
  });

  it("keeps suggested questions visible with history and fills the composer before explicit submit", async () => {
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      if (url === "/api/days/upload_1/qa" && !init?.method) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            answers: [
              {
                id: "answer_old",
                question: "之前问过的问题",
                answer: "之前保存的回答",
                citedSegmentIds: ["seg_1"],
                createdAt: "2026-07-09T10:00:00.000Z"
              }
            ]
          })
        });
      }

      if (url === "/api/days/upload_1/qa" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: "answer_new",
            question: "这次录音里的关系信号，原文证据是什么？",
            answer: "可以从原文证据回看这条关系信号。",
            citedSegmentIds: ["seg_1"],
            createdAt: "2026-07-09T10:01:00.000Z"
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <QaPanel
        uploadId="upload_1"
        scope="current"
        suggestedQuestions={[
          {
            id: "suggestion_relationship_1",
            scope: "current",
            question: "这次录音里的关系信号，原文证据是什么？",
            reason: "积极信号：对方先回应了疲惫感，再讨论下一步安排。",
            sourceType: "relationship_signal",
            sourceIds: ["signal_1"],
            sourceUploadIds: ["upload_1"]
          }
        ]}
      />
    );

    expect(await screen.findByText("之前保存的回答")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /这次录音里的关系信号，原文证据是什么？/ }));

    expect(screen.getByLabelText("问题")).toHaveValue("这次录音里的关系信号，原文证据是什么？");
    expect(screen.getByLabelText("问题")).toHaveFocus();
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/days/upload_1/qa" && init?.method === "POST")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "提问" }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([url, init]) => url === "/api/days/upload_1/qa" && init?.method === "POST");
      expect(postCall).toBeTruthy();
      expect(JSON.parse(String(postCall?.[1]?.body))).toEqual(
        expect.objectContaining({
          question: "这次录音里的关系信号，原文证据是什么？"
        })
      );
    });
    expect(await screen.findByText("可以从原文证据回看这条关系信号。")).toBeInTheDocument();
  });

  it("renders different companion copy for week and all-memory scopes", async () => {
    vi.stubGlobal("fetch", mockSettingsFetch());
    const { rerender } = render(<QaPanel scope="week" />);

    expect(screen.getByRole("heading", { name: "问问这一周" })).toBeInTheDocument();
    expect(screen.getByText("我会帮你把一周里的反复主题、推进和卡点串起来。")).toBeInTheDocument();
    expect(screen.getByLabelText("问题")).toHaveValue("");
    expect(screen.getByRole("button", { name: /这周反复出现的主题是什么？/ })).toBeInTheDocument();
    expect(screen.getByText("基于本周记忆")).toBeInTheDocument();

    rerender(<QaPanel scope="all" />);

    expect(screen.getByRole("heading", { name: "问问全部记忆" })).toBeInTheDocument();
    expect(screen.getByText("我会跨日期查找证据，但不会把没有证据的判断说成事实。")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("问题")).toHaveValue("");
    });
    expect(screen.getByRole("button", { name: /我之前怎么想这个问题的？/ })).toBeInTheDocument();
    expect(screen.getByText("基于全部记忆")).toBeInTheDocument();
  });

  it("renders explicit scope metadata and keeps it visible with history", async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      if (url === "/api/memory/all/qa") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            answers: [
              {
                id: "answer_all",
                question: "过去记录里有什么证据？",
                answer: "先看有日期的证据。",
                citedSegmentIds: ["seg_1"],
                createdAt: "2026-07-09T10:00:00.000Z"
              }
            ]
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <QaPanel
        scope="all"
        isActive
        scopeMeta={{
          scope: "all",
          label: "全部记忆",
          description: "基于全部已处理记忆回答，长期结论需要足够证据支持",
          recordingCount: 2,
          dateRangeLabel: "2026-07-01 至 2026-07-09",
          evidenceCount: 8,
          caution: "长期结论需要至少两个不同日期的证据支持"
        }}
      />
    );

    const scopeMeta = screen.getByLabelText("回答范围");
    expect(scopeMeta).toHaveTextContent("全部记忆");
    expect(scopeMeta).toHaveTextContent("基于全部已处理记忆回答，长期结论需要足够证据支持");
    expect(scopeMeta).toHaveTextContent("2 条录音");
    expect(scopeMeta).toHaveTextContent("2026-07-01 至 2026-07-09");
    expect(scopeMeta).toHaveTextContent("约 8 条证据");
    expect(scopeMeta).toHaveTextContent("长期结论需要至少两个不同日期的证据支持");
    expect(await screen.findByText("先看有日期的证据。")).toBeInTheDocument();
    expect(screen.getByLabelText("回答范围")).toBeInTheDocument();
  });

  it("submits the composer question when Enter is pressed", async () => {
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      if (url === "/api/days/upload_1/qa" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            answer: "今天最值得记住的是一次关键讨论。",
            citedSegmentIds: ["seg_1"]
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<QaPanel uploadId="upload_1" />);
    const input = screen.getByLabelText("问题");
    fireEvent.change(input, { target: { value: "今天有什么重点？" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/days/upload_1/qa",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ question: "今天有什么重点？", promptPresetId: "work", customPrompt: "" })
        })
      );
    });
    expect(document.querySelector(".bub")?.textContent).toBe("今天有什么重点？");
    expect(input).toHaveValue("");
  });

  it("keeps previous turns when asking another question", async () => {
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      if (url === "/api/days/upload_1/qa" && !init?.method) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ answers: [] })
        });
      }

      if (url === "/api/days/upload_1/qa" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { question: string };

        return Promise.resolve({
          ok: true,
          json: async () => ({
            answer: body.question === "第一个问题" ? "第一个回答" : "第二个回答",
            citedSegmentIds: ["seg_1"]
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<QaPanel uploadId="upload_1" />);
    const input = screen.getByLabelText("问题");

    fireEvent.change(input, { target: { value: "第一个问题" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(await screen.findByText("第一个回答")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /这一天最值得我记住的是什么？/ })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "第二个问题" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(await screen.findByText("第二个回答")).toBeInTheDocument();

    expect(screen.getByText("第一个问题")).toBeInTheDocument();
    expect(screen.getByText("第一个回答")).toBeInTheDocument();
    expect(screen.getByText("第二个问题")).toBeInTheDocument();
  });

  it("keeps the composer outside the independently scrollable history after many turns", async () => {
    vi.stubGlobal("fetch", mockSettingsFetch());
    const history = Array.from({ length: 12 }, (_, index) => ({
      id: `answer_${index + 1}`,
      question: `Question ${index + 1}`,
      answer: `Answer ${index + 1}`,
      citedSegmentIds: [`segment_${index + 1}`],
      createdAt: `2026-07-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`
    }));

    render(
      <QaPanel
        uploadId="upload_1"
        loadQuestionHistory={() => history}
      />
    );

    expect(await screen.findByText("Answer 12")).toBeInTheDocument();
    const historyRegion = screen.getByRole("log", { name: "QA history" });
    const composer = screen.getByRole("form", { name: "QA composer" });
    expect(historyRegion).toHaveClass("thread");
    expect(composer).toHaveClass("compose");
    expect(historyRegion).not.toContainElement(composer);
    expect(composer.querySelector("textarea[name='question']")).toBeInTheDocument();
  });

  it("places the production voice control immediately before send in the shared composer", async () => {
    vi.stubGlobal("fetch", mockSettingsFetch());

    render(
      <QaVoiceWorkspace
        active
        scope="current"
        uploadId="upload_1"
      >
        <QaPanel
          uploadId="upload_1"
          onLocalQuestion={async () => ({
            id: "unused",
            question: "unused",
            answer: "unused",
            citedSegmentIds: [],
            createdAt: "2026-07-24T00:00:00.000Z"
          })}
        />
      </QaVoiceWorkspace>
    );

    const composer = screen.getByRole("form", { name: "QA composer" });
    const voiceButton = await screen.findByRole("button", { name: "开始语音提问" });
    const sendButton = screen.getByRole("button", { name: "提问" });

    expect(composer).toContainElement(voiceButton);
    expect(composer).toContainElement(sendButton);
    expect(
      voiceButton.compareDocumentPosition(sendButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(document.querySelector(".voice-qa-card")).not.toBeInTheDocument();
  });

  it("sends recent conversation context when the user asks a follow-up question", async () => {
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      if (url === "/api/days/upload_1/qa" && !init?.method) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ answers: [] })
        });
      }

      if (url === "/api/days/upload_1/qa" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          question: string;
          conversation?: Array<{ role: string; content: string }>;
        };

        if (body.question === "你看看会议中的每个人的性格是怎么样的，分析一下") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              answer: "不适合给参会者下性格结论。如果你愿意，我可以改成分析每个人在这场会议里的发言角色、关注点、决策风格或协作方式。",
              citedSegmentIds: []
            })
          });
        }

        if (body.question === "可以") {
          expect(body.conversation).toEqual([
            {
              role: "user",
              content: "你看看会议中的每个人的性格是怎么样的，分析一下"
            },
            {
              role: "assistant",
              content: "不适合给参会者下性格结论。如果你愿意，我可以改成分析每个人在这场会议里的发言角色、关注点、决策风格或协作方式。"
            }
          ]);

          return Promise.resolve({
            ok: true,
            json: async () => ({
              answer: "可以，我按发言角色、关注点和协作方式来分析。",
              citedSegmentIds: ["seg_1"]
            })
          });
        }
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<QaPanel uploadId="upload_1" />);
    const input = screen.getByLabelText("问题");

    fireEvent.change(input, { target: { value: "你看看会议中的每个人的性格是怎么样的，分析一下" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(await screen.findByText(/不适合给参会者下性格结论/)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "可以" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("可以，我按发言角色、关注点和协作方式来分析。")).toBeInTheDocument();
  });

  it("uses a local question handler for local-first current-day QA instead of posting to the server", async () => {
    const onLocalQuestion = vi.fn().mockResolvedValue({
      answer: "这是本地直连模型给出的回答。",
      citedSegmentIds: ["local_seg_1"],
      citations: [
        {
          id: "local_citation_1",
          title: "本地录音片段",
          startSeconds: 0,
          endSeconds: 30,
          excerpt: "本地上下文",
          sourceSegmentIds: ["local_seg_1"]
        }
      ]
    });
    const fetchMock = vi.fn((url: string | URL | Request) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<QaPanel uploadId="local_1" scope="current" onLocalQuestion={onLocalQuestion} />);
    const input = screen.getByLabelText("问题");
    fireEvent.change(input, { target: { value: "今天有什么重点？" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("这是本地直连模型给出的回答。")).toBeInTheDocument();
    expect(onLocalQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "今天有什么重点？",
        conversation: [],
        model: "openai/gpt-5-mini"
      })
    );
    expect(fetchMock).not.toHaveBeenCalledWith("/api/days/local_1/qa", expect.anything());
  });

  it("uses a provided question handler for week-scope QA instead of posting to server memory", async () => {
    const onLocalQuestion = vi.fn().mockResolvedValue({
      answer: "这是本周本地记忆给出的回答。",
      citedSegmentIds: ["week_seg_1"]
    });
    const fetchMock = vi.fn((url: string | URL | Request) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<QaPanel scope="week" referenceDate="2026-06-10" onLocalQuestion={onLocalQuestion} />);
    const input = screen.getByLabelText("问题");
    fireEvent.change(input, { target: { value: "这周互动氛围怎么样？" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("这是本周本地记忆给出的回答。")).toBeInTheDocument();
    expect(onLocalQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "这周互动氛围怎么样？",
        conversation: [],
        model: "openai/gpt-5-mini"
      })
    );
    expect(fetchMock).not.toHaveBeenCalledWith("/api/memory/week/qa?referenceDate=2026-06-10", expect.anything());
  });

  it("loads saved QA history when the panel opens", async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      if (url === "/api/days/upload_1/qa") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            answers: [
              {
                id: "answer_old",
                question: "之前问过的问题",
                answer: "之前保存的回答",
                citedSegmentIds: ["seg_1"],
                createdAt: "2026-06-05T10:00:00.000Z"
              }
            ]
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<QaPanel uploadId="upload_1" />);

    expect(await screen.findByText("之前问过的问题")).toBeInTheDocument();
    expect(screen.getByText("之前保存的回答")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /这一天最值得我记住的是什么？/ })).not.toBeInTheDocument();
  });

  it("uses the selected reference date for week-scope history and questions", async () => {
    const weekEndpoint = "/api/memory/week/qa?referenceDate=2026-06-05";
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      if (url === weekEndpoint && !init?.method) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ answers: [] })
        });
      }

      if (url === weekEndpoint && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            answer: "这是 2026-06-05 所在周的回答。",
            citedSegmentIds: ["seg_week"]
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<QaPanel scope="week" referenceDate="2026-06-05" />);
    const input = screen.getByLabelText("问题");
    fireEvent.change(input, { target: { value: "这周有什么进展？" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("这是 2026-06-05 所在周的回答。")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(weekEndpoint, expect.objectContaining({ cache: "no-store" }));
    expect(fetchMock).toHaveBeenCalledWith(
      weekEndpoint,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ question: "这周有什么进展？", promptPresetId: "work", customPrompt: "" })
      })
    );
  });

  it("loads custom current-day history and saves the answered turn for custom question handlers", async () => {
    const onLocalQuestion = vi.fn().mockResolvedValue({
      id: "answer_new",
      question: "可以",
      answer: "可以，我继续按发言角色和关注点分析。",
      citedSegmentIds: ["seg_2"],
      createdAt: "2026-06-09T10:01:00.000Z"
    });
    const loadQuestionHistory = vi.fn().mockResolvedValue([
      {
        id: "answer_old",
        question: "你看看会议中的每个人的性格是怎么样的，分析一下",
        answer: "我可以改成分析每个人在这场会议里的发言角色、关注点、决策风格或协作方式。",
        citedSegmentIds: [],
        createdAt: "2026-06-09T10:00:00.000Z"
      }
    ]);
    const saveQuestionHistory = vi.fn();
    const fetchMock = vi.fn((url: string | URL | Request) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <QaPanel
        uploadId="day_2026-06-09"
        scope="current"
        onLocalQuestion={onLocalQuestion}
        loadQuestionHistory={loadQuestionHistory}
        saveQuestionHistory={saveQuestionHistory}
        includeLoadedHistoryInConversation
      />
    );

    expect(await screen.findByText("我可以改成分析每个人在这场会议里的发言角色、关注点、决策风格或协作方式。")).toBeInTheDocument();

    const input = screen.getByLabelText("问题");
    fireEvent.change(input, { target: { value: "可以" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("可以，我继续按发言角色和关注点分析。")).toBeInTheDocument();
    expect(onLocalQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "可以",
        conversation: [
          {
            role: "user",
            content: "你看看会议中的每个人的性格是怎么样的，分析一下"
          },
          {
            role: "assistant",
            content: "我可以改成分析每个人在这场会议里的发言角色、关注点、决策风格或协作方式。"
          }
        ]
      })
    );
    expect(saveQuestionHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "answer_new",
        question: "可以",
        answer: "可以，我继续按发言角色和关注点分析。",
        citedSegmentIds: ["seg_2"],
        createdAt: "2026-06-09T10:01:00.000Z"
      })
    );
    expect(fetchMock).not.toHaveBeenCalledWith("/api/days/day_2026-06-09/qa", expect.anything());
  });

  it("can display loaded current-day history without sending it to a custom question handler", async () => {
    const onLocalQuestion = vi.fn().mockResolvedValue({
      id: "answer_new",
      question: "继续",
      answer: "继续看当前会话里的新增内容。",
      citedSegmentIds: ["seg_2"],
      createdAt: "2026-06-09T10:01:00.000Z"
    });
    const fetchMock = vi.fn((url: string | URL | Request) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <QaPanel
        uploadId="day_2026-06-09"
        scope="current"
        onLocalQuestion={onLocalQuestion}
        loadQuestionHistory={() => [
          {
            id: "answer_old",
            question: "之前的问题",
            answer: "之前的回答",
            citedSegmentIds: [],
            createdAt: "2026-06-09T10:00:00.000Z"
          }
        ]}
        includeLoadedHistoryInConversation={false}
      />
    );

    expect(await screen.findByText("之前的回答")).toBeInTheDocument();

    const input = screen.getByLabelText("问题");
    fireEvent.change(input, { target: { value: "继续" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("继续看当前会话里的新增内容。")).toBeInTheDocument();
    expect(onLocalQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "继续",
        conversation: []
      })
    );
  });

  it("generates a persistent answer id before saving custom handler answers without ids", async () => {
    const saveQuestionHistory = vi.fn();
    const fetchMock = vi.fn((url: string | URL | Request) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <QaPanel
        uploadId="day_2026-06-09"
        scope="current"
        onLocalQuestion={() =>
          Promise.resolve({
            answer: "这是没有服务端 id 的回答。",
            citedSegmentIds: ["seg_1"]
          })
        }
        saveQuestionHistory={saveQuestionHistory}
      />
    );

    const input = screen.getByLabelText("问题");
    fireEvent.change(input, { target: { value: "今天有什么重点？" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("这是没有服务端 id 的回答。")).toBeInTheDocument();
    expect(saveQuestionHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^qa_/),
        question: "今天有什么重点？",
        answer: "这是没有服务端 id 的回答。"
      })
    );
    expect(saveQuestionHistory.mock.calls[0]?.[0].id).not.toMatch(/^pending_/);
  });

  it("keeps Enter handling inside the composer instead of bubbling to parent navigation", async () => {
    const parentKeyDown = vi.fn();
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      if (url === "/api/days/upload_1/qa" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            answer: "今天最值得记住的是一次关键讨论。",
            citedSegmentIds: ["seg_1"]
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <div onKeyDown={parentKeyDown}>
        <QaPanel uploadId="upload_1" />
      </div>
    );

    const input = screen.getByLabelText("问题");
    fireEvent.change(input, { target: { value: "今天有什么重点？" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/days/upload_1/qa",
        expect.objectContaining({
          method: "POST"
        })
      );
    });
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it("does not submit the composer question when Shift Enter is pressed", () => {
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      if (url === "/api/days/upload_1/qa" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            answer: "这个请求不该被发送。",
            citedSegmentIds: ["seg_1"]
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<QaPanel uploadId="upload_1" />);
    const input = screen.getByLabelText("问题");
    fireEvent.change(input, { target: { value: "第一行" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: true });

    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/days/upload_1/qa" && init?.method === "POST")).toBe(false);
  });

  it("does not submit a second question while the first Enter request is pending", async () => {
    let resolveQaRequest: ((value: Response) => void) | undefined;
    const qaRequest = new Promise<Response>((resolve) => {
      resolveQaRequest = resolve;
    });
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      if (url === "/api/days/upload_1/qa" && init?.method === "POST") {
        return qaRequest;
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });
    const qaCalls = () => fetchMock.mock.calls.filter(([url, init]) => url === "/api/days/upload_1/qa" && init?.method === "POST");

    vi.stubGlobal("fetch", fetchMock);

    render(<QaPanel uploadId="upload_1" />);
    const input = screen.getByLabelText("问题");
    fireEvent.change(input, { target: { value: "今天有什么重点？" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(qaCalls()).toHaveLength(1);
    });
    expect(await screen.findByText("我在翻这一天的记录")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(qaCalls()).toHaveLength(1);

    await act(async () => {
      resolveQaRequest?.({
        ok: true,
        json: async () => ({
          answer: "今天最值得记住的是一次关键讨论。",
          citedSegmentIds: ["seg_1"]
        })
      } as Response);
      await qaRequest;
    });
  });

  it("shows humanized loading and recoverable error copy", async () => {
    let resolveQaRequest: ((value: Response) => void) | undefined;
    const qaRequest = new Promise<Response>((resolve) => {
      resolveQaRequest = resolve;
    });
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      if (typeof url === "string" && url.endsWith("/qa") && init?.method === "POST") {
        return qaRequest;
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<QaPanel uploadId="upload_1" />);
    fireEvent.change(screen.getByLabelText("问题"), { target: { value: "今天有什么重点？" } });
    fireEvent.submit(screen.getByRole("button", { name: "提问" }).closest("form") as HTMLFormElement);

    expect(await screen.findByText("我在翻这一天的记录")).toBeInTheDocument();
    expect(document.querySelectorAll(".typing i")).toHaveLength(3);
    resolveQaRequest?.({
      ok: false,
      json: async () => ({})
    } as Response);
    expect(await screen.findByText("这次没有答出来，可能是模型服务或记忆检索出了问题。已保存的录音数据不会因此丢失，你可以稍后再问。")).toBeInTheDocument();
  });

  it("does not show backend machine error codes to users", async () => {
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      if (url === "/api/memory/week/qa" && init?.method === "POST") {
        return Promise.resolve({
          ok: false,
          json: async () => ({ error: "week_memory_not_found" })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<QaPanel scope="week" />);
    fireEvent.change(screen.getByLabelText("问题"), { target: { value: "本周有什么要跟进？" } });
    fireEvent.submit(screen.getByRole("button", { name: "提问" }).closest("form") as HTMLFormElement);

    expect(await screen.findByText("这次没有答出来，可能是模型服务或记忆检索出了问题。已保存的录音数据不会因此丢失，你可以稍后再问。")).toBeInTheDocument();
    expect(screen.queryByText("week_memory_not_found")).not.toBeInTheDocument();
  });

  it("ignores stale QA responses after the scope changes", async () => {
    let resolveWeekRequest: ((value: Response) => void) | undefined;
    const weekRequest = new Promise<Response>((resolve) => {
      resolveWeekRequest = resolve;
    });
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      if (url === "/api/memory/week/qa" && init?.method === "POST") {
        return weekRequest;
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<QaPanel scope="week" />);
    fireEvent.change(screen.getByLabelText("问题"), { target: { value: "本周有什么要跟进？" } });
    fireEvent.submit(screen.getByRole("button", { name: "提问" }).closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/memory/week/qa",
        expect.objectContaining({
          method: "POST"
        })
      );
    });

    rerender(<QaPanel scope="all" />);
    expect(screen.getByRole("heading", { name: "问问全部记忆" })).toBeInTheDocument();

    await act(async () => {
      resolveWeekRequest?.({
        ok: true,
        json: async () => ({
          answer: "旧的一周答案不该出现",
          citedSegmentIds: ["upload_week_seg_1"]
        })
      } as Response);
      await weekRequest;
      await Promise.resolve();
    });

    expect(screen.queryByText("旧的一周答案不该出现")).not.toBeInTheDocument();
    expect(screen.getByText("基于全部记忆")).toBeInTheDocument();
  });

  it("ignores pending QA responses after switching into an empty data state", async () => {
    let resolveQaRequest: ((value: Response) => void) | undefined;
    const qaRequest = new Promise<Response>((resolve) => {
      resolveQaRequest = resolve;
    });
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      if (url === "/api/days/upload_1/qa" && init?.method === "POST") {
        return qaRequest;
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<QaPanel uploadId="upload_1" />);
    fireEvent.change(screen.getByLabelText("问题"), { target: { value: "今天有什么重点？" } });
    fireEvent.submit(screen.getByRole("button", { name: "提问" }).closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/days/upload_1/qa",
        expect.objectContaining({
          method: "POST"
        })
      );
    });

    rerender(
      <QaPanel
        uploadId="upload_1"
        emptyState={{
          title: "这一天还没有可用于问答的录音",
          detail: "暂无处理完成的录音。",
          placeholder: "这一天还没有录音，上传后再问"
        }}
      />
    );

    expect(screen.getByRole("heading", { name: "这一天还没有可用于问答的录音" })).toBeInTheDocument();
    expect(screen.getByLabelText("问题")).toBeDisabled();

    await act(async () => {
      resolveQaRequest?.({
        ok: true,
        json: async () => ({
          answer: "旧请求返回的答案不该出现",
          citedSegmentIds: ["seg_1"]
        })
      } as Response);
      await qaRequest;
      await Promise.resolve();
    });

    expect(screen.queryByText("旧请求返回的答案不该出现")).not.toBeInTheDocument();
    expect(screen.queryByText(/这次没有答出来/)).not.toBeInTheDocument();
  });

  it("preserves line breaks in multi-line answers", async () => {
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      if (typeof url === "string" && url.endsWith("/qa") && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            answer: "第一行\n第二行",
            citedSegmentIds: ["seg_1", "seg_2"],
            citations: [
              {
                id: "E1",
                title: "客户续费讨论",
                startSeconds: 60,
                endSeconds: 120,
                excerpt: "客户合同费用需要重新评估。",
                sourceSegmentIds: ["seg_1", "seg_2"]
              }
            ]
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<QaPanel uploadId="upload_1" />);

    fireEvent.change(screen.getByLabelText("问题"), { target: { value: "今天有什么重点？" } });
    fireEvent.submit(screen.getByRole("button", { name: "提问" }).closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(screen.getByText("引用证据")).toBeInTheDocument();
    });

    const citationDetails = document.querySelector(".qa-citations");
    expect(citationDetails).toBeInstanceOf(HTMLDetailsElement);
    expect((citationDetails as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByText("1 条")).toBeInTheDocument();
    expect(screen.getByText("1:00-2:00")).not.toBeVisible();

    fireEvent.click(screen.getByText("引用证据"));

    expect((citationDetails as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByText("1:00-2:00")).toBeVisible();
    expect(screen.getByText("客户续费讨论")).toBeInTheDocument();
    expect(screen.queryByText(/seg_1/)).not.toBeInTheDocument();
    const answer = document.querySelector("pre");
    expect(answer).not.toBeNull();
    expect(answer?.textContent).toBe("第一行\n第二行");
    expect(answer?.tagName).toBe("PRE");
    expect(answer).toHaveClass("qa-answer-content");
    expect(screen.getByText("今天有什么重点？")).not.toHaveClass("qa-answer-content");
    expect(citationDetails).not.toHaveClass("qa-answer-content");
  });

  it("lets users select and save the QA model preset inside the composer", async () => {
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/settings" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5.2",
            qaModelPresets: [
              { label: "GPT-5 Mini", value: "openai/gpt-5-mini" },
              { label: "GPT-5.2", value: "openai/gpt-5.2" }
            ]
          })
        });
      }

      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [
              { label: "GPT-5 Mini", value: "openai/gpt-5-mini" },
              { label: "GPT-5.2", value: "openai/gpt-5.2" }
            ]
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<QaPanel uploadId="upload_1" />);

    const selector = await screen.findByLabelText("AI 问答模型");
    expect(screen.queryByRole("button", { name: "保存问答模型" })).not.toBeInTheDocument();
    fireEvent.change(selector, { target: { value: "openai/gpt-5.2" } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ qaModel: "openai/gpt-5.2" })
        })
      );
    });
    expect(await screen.findByText("已切换问答模型")).toBeInTheDocument();
  });

  it("lets users select and save the QA role inside the QA page", async () => {
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/settings" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }],
            qaPromptPresetId: "learning",
            customQaPrompt: "",
            qaPromptPresets: qaPromptPresets()
          })
        });
      }

      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }],
            qaPromptPresetId: "work",
            customQaPrompt: "",
            qaPromptPresets: qaPromptPresets()
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<QaPanel uploadId="upload_1" />);

    const roleSelector = await screen.findByLabelText("AI 问答角色");
    fireEvent.change(roleSelector, { target: { value: "learning" } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            qaPromptPresetId: "learning",
            customQaPrompt: ""
          })
        })
      );
    });
    expect(await screen.findByText("已保存问答角色")).toBeInTheDocument();
  });

  it("saves a custom QA role prompt inside the QA page", async () => {
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/settings" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }],
            qaPromptPresetId: "custom",
            customQaPrompt: "请像约会复盘助手一样回答，关注互动节奏和边界。",
            qaPromptPresets: qaPromptPresets()
          })
        });
      }

      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }],
            qaPromptPresetId: "work",
            customQaPrompt: "",
            qaPromptPresets: qaPromptPresets()
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<QaPanel uploadId="upload_1" />);

    const roleSelector = await screen.findByLabelText("AI 问答角色");
    fireEvent.change(roleSelector, { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("自定义问答角色提示词"), {
      target: { value: "请像约会复盘助手一样回答，关注互动节奏和边界。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "保存自定义角色" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            qaPromptPresetId: "custom",
            customQaPrompt: "请像约会复盘助手一样回答，关注互动节奏和边界。"
          })
        })
      );
    });
  });

  it("does not show backend machine error codes when saving the QA model fails", async () => {
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/settings" && init?.method === "POST") {
        return Promise.resolve({
          ok: false,
          json: async () => ({ error: "invalid_model" })
        });
      }

      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [
              { label: "GPT-5 Mini", value: "openai/gpt-5-mini" },
              { label: "GPT-5.2", value: "openai/gpt-5.2" }
            ]
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<QaPanel uploadId="upload_1" />);

    const selector = await screen.findByLabelText("AI 问答模型");
    fireEvent.change(selector, { target: { value: "openai/gpt-5.2" } });

    expect(await screen.findByText("保存问答模型失败。")).toBeInTheDocument();
    expect(screen.queryByText("invalid_model")).not.toBeInTheDocument();
  });

  it("posts questions to the week memory endpoint when week scope is selected", async () => {
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      if (url === "/api/memory/week/qa" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            answer: "本周客户续费需要继续跟进。",
            citedSegmentIds: ["upload_week_seg_1"]
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<QaPanel scope="week" />);

    fireEvent.change(screen.getByLabelText("问题"), { target: { value: "这周反复出现的主题是什么？" } });
    fireEvent.submit(screen.getByRole("button", { name: "提问" }).closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/memory/week/qa",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ question: "这周反复出现的主题是什么？", promptPresetId: "work", customPrompt: "" })
        })
      );
    });
    expect(screen.getByText("基于本周记忆")).toBeInTheDocument();
  });

  it("renders grounded stream sentences in order, then atomically replaces them with the final answer", async () => {
    const stream = controlledQaStreamResponse();
    const onStreamQuestion = vi.fn().mockResolvedValue(stream.response);
    const saveQuestionHistory = vi.fn();
    const trace = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", mockSettingsFetch());

    render(
      <QaPanel
        uploadId="upload_1"
        onStreamQuestion={onStreamQuestion}
        saveQuestionHistory={saveQuestionHistory}
      />
    );

    const input = document.querySelector('textarea[name="question"]') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "今天有什么重点？" } });
    fireEvent.submit(document.querySelector("form.compose") as HTMLFormElement);
    await waitFor(() => expect(onStreamQuestion).toHaveBeenCalledOnce());

    await act(async () => {
      stream.emit({ type: "meta", version: 1, streamId: "11111111-1111-4111-8111-111111111111" });
      stream.emit({
        type: "sentence",
        sequence: 1,
        text: "第一句。",
        supportIds: ["seg_1"],
        citedSegmentIds: ["seg_1"],
        groundingValidated: true
      });
    });

    expect(await screen.findByText("第一句。")).toBeInTheDocument();
    expect(document.querySelector(".typing")).not.toBeInTheDocument();
    expect(saveQuestionHistory).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(trace).toHaveBeenCalledWith(
        "QA_STREAM_TRACE:",
        expect.stringContaining('"event":"first_text_render"')
      )
    );

    await act(async () => {
      stream.emit({
        type: "sentence",
        sequence: 2,
        text: "第二句。",
        supportIds: ["seg_2"],
        citedSegmentIds: ["seg_2"],
        groundingValidated: true
      });
    });
    expect(await screen.findByText("第一句。第二句。")).toBeInTheDocument();

    await act(async () => {
      stream.emit({
        type: "final",
        answer: finalStreamAnswer({ answer: "最终第一句。\n最终第二句。" }),
        source: "provider_stream"
      });
      stream.emit({ type: "complete", status: "completed" });
      stream.close();
    });

    await waitFor(() =>
      expect(document.querySelector(".qa-answer-content")?.textContent).toBe("最终第一句。\n最终第二句。")
    );
    expect(screen.queryByText("第一句。第二句。")).not.toBeInTheDocument();
    await waitFor(() => expect(saveQuestionHistory).toHaveBeenCalledOnce());
    expect(saveQuestionHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "answer_streamed",
        answer: "最终第一句。\n最终第二句。",
        citedSegmentIds: ["seg_1", "seg_2"]
      })
    );
    expect(onStreamQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "今天有什么重点？",
        conversation: [],
        signal: expect.any(AbortSignal)
      })
    );
  });

  it("clears partially rendered text and preserves the existing panel error on stream failure", async () => {
    const stream = controlledQaStreamResponse();
    const onStreamQuestion = vi.fn().mockResolvedValue(stream.response);
    const saveQuestionHistory = vi.fn();
    vi.stubGlobal("fetch", mockSettingsFetch());

    render(
      <QaPanel
        uploadId="upload_1"
        onStreamQuestion={onStreamQuestion}
        saveQuestionHistory={saveQuestionHistory}
      />
    );

    const input = document.querySelector('textarea[name="question"]') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "失败时怎么办？" } });
    fireEvent.submit(document.querySelector("form.compose") as HTMLFormElement);
    await waitFor(() => expect(onStreamQuestion).toHaveBeenCalledOnce());

    await act(async () => {
      stream.emit({ type: "meta", version: 1, streamId: "22222222-2222-4222-8222-222222222222" });
      stream.emit({
        type: "sentence",
        sequence: 1,
        text: "这段文字稍后必须清除。",
        supportIds: ["seg_1"],
        citedSegmentIds: ["seg_1"],
        groundingValidated: true
      });
    });
    expect(await screen.findByText("这段文字稍后必须清除。")).toBeInTheDocument();

    await act(async () => {
      stream.emit({ type: "error", code: "provider_stream_failed", recoverable: true });
      stream.emit({ type: "complete", status: "failed" });
      stream.close();
    });

    await waitFor(() => expect(screen.queryByText("这段文字稍后必须清除。")).not.toBeInTheDocument());
    expect(document.querySelector(".form-error")).not.toBeNull();
    expect(document.querySelector(".typing")).not.toBeInTheDocument();
    expect(saveQuestionHistory).not.toHaveBeenCalled();
  });

  it("accepts a safe non-stream fallback final without exposing an intermediate answer", async () => {
    const stream = controlledQaStreamResponse();
    const onStreamQuestion = vi.fn().mockResolvedValue(stream.response);
    const saveQuestionHistory = vi.fn();
    vi.stubGlobal("fetch", mockSettingsFetch());

    render(
      <QaPanel
        uploadId="upload_1"
        onStreamQuestion={onStreamQuestion}
        saveQuestionHistory={saveQuestionHistory}
      />
    );

    const input = document.querySelector('textarea[name="question"]') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "回退回答是什么？" } });
    fireEvent.submit(document.querySelector("form.compose") as HTMLFormElement);
    await waitFor(() => expect(onStreamQuestion).toHaveBeenCalledOnce());

    await act(async () => {
      stream.emit({ type: "meta", version: 1, streamId: "33333333-3333-4333-8333-333333333333" });
      stream.emit({
        type: "final",
        answer: finalStreamAnswer({
          question: "回退回答是什么？",
          answer: "这是经过完整验证的回退回答。",
          citedSegmentIds: ["seg_1"],
          citations: undefined
        }),
        source: "non_stream_fallback"
      });
      stream.emit({ type: "complete", status: "completed_with_fallback" });
      stream.close();
    });

    expect(await screen.findByText("这是经过完整验证的回退回答。")).toBeInTheDocument();
    await waitFor(() => expect(saveQuestionHistory).toHaveBeenCalledOnce());
    expect(saveQuestionHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        answer: "这是经过完整验证的回退回答。",
        citedSegmentIds: ["seg_1"]
      })
    );
  });

  it("posts questions to the all memory endpoint when all scope is selected", async () => {
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            qaModel: "openai/gpt-5-mini",
            qaModelPresets: [{ label: "GPT-5 Mini", value: "openai/gpt-5-mini" }]
          })
        });
      }

      if (url === "/api/memory/all/qa" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            answer: "过去所有录音里，客户续费和预算控制都需要跟进。",
            citedSegmentIds: ["upload_all_seg_1"]
          })
        });
      }

      throw new Error(`Unexpected request: ${String(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<QaPanel scope="all" />);

    fireEvent.change(screen.getByLabelText("问题"), { target: { value: "我之前怎么想这个问题的？" } });
    fireEvent.submit(screen.getByRole("button", { name: "提问" }).closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/memory/all/qa",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ question: "我之前怎么想这个问题的？", promptPresetId: "work", customPrompt: "" })
        })
      );
    });
    expect(screen.getByText("基于全部记忆")).toBeInTheDocument();
  });
});
