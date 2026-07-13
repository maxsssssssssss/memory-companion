import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeAudioLocally,
  answerQuestionLocally,
  appendLocalQaHistory,
  clearLocalQaHistory,
  deleteLocalDayPayload,
  listLocalDayIndex,
  readLocalDayPayload,
  readLocalQaHistory,
  saveLocalDayPayload,
  type LocalDayPayload
} from "./local-analysis";

const ACTIVE_USER_STORAGE_KEY = "daily-brief:active-user-id";

function createLocalStorageMock() {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    })
  } as Storage;
}

describe("local audio analysis", () => {
  let localStorageMock: Storage;

  beforeEach(() => {
    localStorageMock = createLocalStorageMock();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: localStorageMock
    });
  });

  afterEach(() => {
    localStorageMock.clear();
    vi.unstubAllGlobals();
  });

  it("builds a ready day payload from browser-side OpenRouter transcription and stores it locally", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "我们决定推进本地优先模式。下周跟进 OpenRouter 直连验证。", usage: { seconds: 60 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["audio"], "meeting.mp3", { type: "audio/mpeg" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(new TextEncoder().encode("audio").buffer)
    });

    const payload = await analyzeAudioLocally({
      file,
      recordingDate: "2026-06-09",
      apiKey: "sk-or-user",
      uploadId: "local_test"
    });
    saveLocalDayPayload(payload);

    expect(payload.upload).toEqual(
      expect.objectContaining({
        id: "local_test",
        originalName: "meeting.mp3",
        recordingDate: "2026-06-09",
        status: "ready"
      })
    );
    expect(payload.segments.length).toBeGreaterThan(0);
    expect(payload.audioInsights.length).toBeGreaterThan(0);
    expect(payload.audioInsights[0].sourceSegmentIds.length).toBeGreaterThan(0);
    expect(payload.semanticSegments.length).toBeGreaterThan(0);
    expect(payload.briefItems.length).toBeGreaterThan(0);
    expect(payload.proactiveInsights).toEqual([]);
    expect(payload.proactiveInsightsAvailable).toBe(false);
    expect(readLocalDayPayload("local_test")?.upload.id).toBe("local_test");
    expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/v1/audio/transcriptions", expect.any(Object));
  });

  it("uses browser-side OpenRouter chat to enrich local audio insights when available", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "客户问预算是不是还有点风险。对方说可以先把条件讲清楚。", usage: { seconds: 45 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  "```json\n" +
                  JSON.stringify({
                    items: [
                      {
                        sourceSegmentIds: ["local_ai_seg_1"],
                        speaker: { id: "speaker_unknown", role: "customer", confidence: 0.65 },
                        voice: { pace: "normal", volume: "unknown", pause: "normal", overlap: false, confidence: 0.4 },
                        toneLabels: ["hesitant", "questioning"],
                        emotionLabels: ["anxious"],
                        interactionLabels: ["follow_up_question", "tension"],
                        summary: "客户在试探预算风险。",
                        evidence: "客户问预算是不是还有点风险。",
                        confidence: 0.74
                      }
                    ]
                  }) +
                  "\n```"
              }
            }
          ]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["audio"], "meeting.mp3", { type: "audio/mpeg" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(new TextEncoder().encode("audio").buffer)
    });

    const payload = await analyzeAudioLocally({
      file,
      recordingDate: "2026-06-09",
      apiKey: "sk-or-user",
      uploadId: "local_ai"
    });

    expect(payload.audioInsights[0]).toMatchObject({
      id: "insight_local_ai_ai_1",
      summary: "客户在试探预算风险。",
      toneLabels: ["hesitant", "questioning"],
      emotionLabels: ["anxious"],
      interactionLabels: ["follow_up_question", "tension"]
    });
    expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/v1/chat/completions", expect.any(Object));
  });

  it("enriches local-first audio insights with browser acoustic features", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "客户问预算是不是还有点风险。", usage: { seconds: 2 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "不是 JSON" } }]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const samples = new Float32Array(200);
    samples.fill(0.6, 0, 100);
    samples.fill(0, 100, 200);
    const closeMock = vi.fn();
    class FakeAudioContext {
      async decodeAudioData() {
        return {
          duration: 2,
          sampleRate: 100,
          numberOfChannels: 1,
          getChannelData: () => samples
        };
      }

      close = closeMock;
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const file = new File(["audio"], "meeting.mp3", { type: "audio/mpeg" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(new TextEncoder().encode("audio").buffer)
    });

    const payload = await analyzeAudioLocally({
      file,
      recordingDate: "2026-06-09",
      apiKey: "sk-or-user",
      uploadId: "local_acoustic"
    });

    expect(payload.audioInsights[0].voice).toMatchObject({
      volume: "high",
      pause: "many",
      confidence: 0.74
    });
    expect(payload.audioInsights[0].atmosphereLabels).toEqual(expect.arrayContaining(["uncertain"]));
    expect(
      payload.audioInsights[0].emotionEvidence?.some(
        (evidence) =>
          (evidence.source === "acoustic" || evidence.source === "fusion") &&
          evidence.sourceSegmentIds.includes("local_acoustic_seg_1")
      )
    ).toBe(true);
    expect(
      payload.audioInsights[0].emotionEvidence?.some(
        (evidence) =>
          evidence.source === "fusion" &&
          evidence.normalizedLabel === "uncertain" &&
          evidence.sourceSegmentIds.includes("local_acoustic_seg_1")
      )
    ).toBe(true);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to rule audio insights when browser-side insight JSON is invalid", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "客户问预算是不是还有点风险。", usage: { seconds: 30 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "我无法输出 JSON。" } }]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["audio"], "meeting.mp3", { type: "audio/mpeg" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(new TextEncoder().encode("audio").buffer)
    });

    const payload = await analyzeAudioLocally({
      file,
      recordingDate: "2026-06-09",
      apiKey: "sk-or-user",
      uploadId: "local_ai_invalid"
    });

    expect(payload.audioInsights.length).toBeGreaterThan(0);
    expect(payload.audioInsights[0].id).toBe("insight_local_ai_invalid_1");
    expect(payload.audioInsights[0].summary).toContain("试探");
  });

  it("normalizes local-first pcm uploads before calling OpenRouter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "这是一段 PCM 录音。", usage: { seconds: 20 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["pcm"], "Note-20000105224639.pcm", { type: "" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(new Uint8Array([0x01, 0x00, 0xff, 0x7f]).buffer)
    });

    const payload = await analyzeAudioLocally({
      file,
      recordingDate: "2026-06-09",
      apiKey: "sk-or-user",
      uploadId: "local_pcm"
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { input_audio: { format: string; data: string } };

    expect(payload.upload.originalName).toBe("Note-20000105224639.pcm");
    expect(payload.upload.mimeType).toBe("audio/wav");
    expect(body.input_audio.format).toBe("wav");
    expect(body.input_audio.data).toBeTruthy();
  });

  it("deletes one locally stored recording without touching other recordings from the same day", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ text: "我们决定推进本地优先模式。", usage: { seconds: 60 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = Object.assign(new File(["audio"], "meeting.mp3", { type: "audio/mpeg" }), {
      arrayBuffer: vi.fn().mockResolvedValue(new TextEncoder().encode("audio").buffer)
    });
    const firstPayload = await analyzeAudioLocally({
      file,
      recordingDate: "2026-06-09",
      apiKey: "sk-or-user",
      uploadId: "local_first"
    });
    const secondPayload = await analyzeAudioLocally({
      file,
      recordingDate: "2026-06-09",
      apiKey: "sk-or-user",
      uploadId: "local_second"
    });
    saveLocalDayPayload(firstPayload);
    saveLocalDayPayload(secondPayload);

    deleteLocalDayPayload("local_first");

    expect(readLocalDayPayload("local_first")).toBeNull();
    expect(readLocalDayPayload("local_second")?.upload.id).toBe("local_second");
    expect(listLocalDayIndex().map((item) => item.uploadId)).toEqual(["local_second"]);
  });

  it("does not store virtual aggregated day payloads as real local recordings", () => {
    expect(() =>
      saveLocalDayPayload({
        upload: {
          id: "day_2026-06-09",
          originalName: "2 段录音",
          mimeType: "application/vnd.daily-brief.day",
          sizeBytes: 100,
          recordingDate: "2026-06-09",
          status: "ready"
        },
        job: {
          id: "job_day_2026-06-09",
          uploadId: "day_2026-06-09",
          status: "ready",
          progress: 100
        },
        segments: [],
        audioInsights: [],
        semanticSegments: [],
        semanticSegmentsAvailable: false,
        briefItems: []
      })
    ).toThrow("不能把聚合日视图保存为真实本地录音。");
    expect(listLocalDayIndex()).toEqual([]);
  });

  it("isolates browser-stored recordings and QA history by active user", () => {
    const payload: LocalDayPayload = {
      upload: {
        id: "local_shared_name",
        originalName: "private.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 100,
        recordingDate: "2026-06-09",
        status: "ready"
      },
      job: {
        id: "job_local_shared_name",
        uploadId: "local_shared_name",
        status: "ready",
        progress: 100
      },
      segments: [],
      audioInsights: [],
      semanticSegments: [],
      semanticSegmentsAvailable: true,
      briefItems: []
    };

    window.localStorage.setItem(ACTIVE_USER_STORAGE_KEY, "user_a");
    saveLocalDayPayload(payload);
    appendLocalQaHistory("local_shared_name", {
      id: "answer_user_a",
      uploadId: "local_shared_name",
      question: "A 的问题",
      answer: "A 的答案",
      citedSegmentIds: [],
      createdAt: "2026-06-09T10:00:00.000Z"
    });

    window.localStorage.setItem(ACTIVE_USER_STORAGE_KEY, "user_b");

    expect(readLocalDayPayload("local_shared_name")).toBeNull();
    expect(listLocalDayIndex()).toEqual([]);
    expect(readLocalQaHistory("local_shared_name")).toEqual([]);

    window.localStorage.setItem(ACTIVE_USER_STORAGE_KEY, "user_a");

    expect(readLocalDayPayload("local_shared_name")?.upload.originalName).toBe("private.mp3");
    expect(listLocalDayIndex().map((item) => item.uploadId)).toEqual(["local_shared_name"]);
    expect(readLocalQaHistory("local_shared_name").map((answer) => answer.question)).toEqual(["A 的问题"]);
  });

  it("stores and clears current-day QA history locally by upload id", () => {
    appendLocalQaHistory("day_2026-06-09", {
      id: "answer_1",
      uploadId: "day_2026-06-09",
      question: "今天有什么重点？",
      answer: "今天重点是本地优先。",
      citedSegmentIds: ["seg_1"],
      createdAt: "2026-06-09T10:00:00.000Z"
    });
    appendLocalQaHistory("day_2026-06-09", {
      id: "answer_2",
      uploadId: "day_2026-06-09",
      question: "还有什么待办？",
      answer: "待办是继续验证。",
      citedSegmentIds: ["seg_2"],
      createdAt: "2026-06-09T10:01:00.000Z"
    });

    expect(readLocalQaHistory("day_2026-06-09").map((answer) => answer.question)).toEqual(["今天有什么重点？", "还有什么待办？"]);

    clearLocalQaHistory("day_2026-06-09");

    expect(readLocalQaHistory("day_2026-06-09")).toEqual([]);
  });

  it("answers local questions by sending local transcript context directly to OpenRouter", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "我们决定推进本地优先模式。下周跟进 OpenRouter 直连验证。", usage: { seconds: 60 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "今天重点是推进本地优先模式，并安排下周验证。" } }]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const payload = await analyzeAudioLocally({
      file: Object.assign(new File(["audio"], "meeting.mp3", { type: "audio/mpeg" }), {
        arrayBuffer: vi.fn().mockResolvedValue(new TextEncoder().encode("audio").buffer)
      }),
      recordingDate: "2026-06-09",
      apiKey: "sk-or-user",
      uploadId: "local_qa"
    });
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "今天重点是推进本地优先模式，并安排下周验证。" } }]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    );

    const answer = await answerQuestionLocally({
      payload,
      apiKey: "sk-or-user",
      model: "openai/gpt-5-mini",
      question: "今天有什么重点？",
      conversation: [],
      promptPresetId: "date"
    });

    expect(answer.answer).toBe("今天重点是推进本地优先模式，并安排下周验证。");
    expect(answer.citedSegmentIds.length).toBeGreaterThan(0);
    expect(answer.citations?.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-or-user"
        }),
        body: expect.stringContaining("互动节奏")
      })
    );
  });

  it("includes acoustic voice signals in local-first QA context", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "这一段声音偏高，停顿也比较多。" } }]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const payload: LocalDayPayload = {
      upload: {
        id: "local_voice_qa",
        originalName: "voice.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 10,
        recordingDate: "2026-06-09",
        status: "ready"
      },
      segments: [
        {
          id: "seg_voice",
          uploadId: "local_voice_qa",
          startSeconds: 0,
          endSeconds: 30,
          text: "这里声音变得比较明显。",
          confidence: 0.9,
          sceneLabels: ["unknown"],
          valueLabels: []
        }
      ],
      audioInsights: [
        {
          id: "insight_voice",
          uploadId: "local_voice_qa",
          sourceSegmentIds: ["seg_voice"],
          sourceTimeRange: { startSeconds: 0, endSeconds: 30 },
          speaker: { id: "speaker_1", role: "unknown", confidence: 0.4 },
          voice: { pace: "normal", volume: "high", pause: "many", overlap: true, confidence: 0.74 },
          toneLabels: ["unknown"],
          emotionLabels: ["neutral"],
          interactionLabels: ["unknown"],
          summary: "声音有明显变化。",
          evidence: "这里声音变得比较明显。",
          confidence: 0.7
        }
      ],
      semanticSegments: [],
      semanticSegmentsAvailable: false,
      briefItems: []
    };

    await answerQuestionLocally({
      payload,
      apiKey: "sk-or-user",
      question: "这段声音状态怎么样？",
      conversation: []
    });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };

    expect(requestBody.messages.at(-1)?.content).toContain("声音：语速 normal，音量 high，停顿 many，重叠 true");
  });

  it("includes emotion evidence in local-first QA context", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "这一段气氛认真偏紧。" } }]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const payload: LocalDayPayload = {
      upload: {
        id: "local_emotion_qa",
        originalName: "emotion.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 10,
        recordingDate: "2026-06-09",
        status: "ready"
      },
      segments: [
        {
          id: "seg_emotion",
          uploadId: "local_emotion_qa",
          startSeconds: 0,
          endSeconds: 30,
          text: "预算是不是还有风险？",
          confidence: 0.9,
          sceneLabels: ["unknown"],
          valueLabels: []
        }
      ],
      audioInsights: [
        {
          id: "insight_emotion",
          uploadId: "local_emotion_qa",
          sourceSegmentIds: ["seg_emotion"],
          sourceTimeRange: { startSeconds: 0, endSeconds: 30 },
          speaker: { id: "speaker_1", role: "unknown", confidence: 0.4 },
          voice: { pace: "normal", volume: "high", pause: "many", overlap: true, confidence: 0.74 },
          toneLabels: ["serious"],
          emotionLabels: ["anxious"],
          interactionLabels: ["tension"],
          atmosphereLabels: ["serious", "tense"],
          emotionEvidence: [
            {
              id: "emotion_evidence_1",
              kind: "atmosphere",
              label: "认真偏紧",
              normalizedLabel: "tense",
              source: "acoustic",
              confidence: 0.72,
              detail: "音量升高、停顿变多，并且多人重叠。",
              sourceSegmentIds: ["seg_emotion"],
              sourceTimeRange: { startSeconds: 0, endSeconds: 30 },
              features: [
                { name: "volume", label: "音量更高", value: "-16", unit: "dBFS" },
                { name: "pause", label: "停顿变多", value: "42", unit: "%" }
              ]
            },
            {
              id: "legacy_emotion_evidence_1",
              kind: "atmosphere",
              label: "旧数据线索",
              normalizedLabel: "tense",
              source: "acoustic",
              confidence: 0.61,
              detail: "旧数据没有 features 字段。",
              sourceSegmentIds: ["seg_emotion"],
              sourceTimeRange: { startSeconds: 0, endSeconds: 30 }
            } as unknown as NonNullable<LocalDayPayload["audioInsights"][number]["emotionEvidence"]>[number]
          ],
          summary: "对方在追问预算风险。",
          evidence: "预算是不是还有风险？",
          confidence: 0.7
        }
      ],
      semanticSegments: [],
      semanticSegmentsAvailable: false,
      briefItems: []
    };

    await answerQuestionLocally({
      payload,
      apiKey: "sk-or-user",
      question: "当时气氛是不是有点紧张？",
      conversation: []
    });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };

    expect(requestBody.messages.at(-1)?.content).toContain("气氛线索");
    expect(requestBody.messages.at(-1)?.content).toContain("认真偏紧");
    expect(requestBody.messages.at(-1)?.content).toContain("停顿变多");
    expect(requestBody.messages.at(-1)?.content).toContain("旧数据没有 features 字段");
    expect(requestBody.messages[0]?.content).toContain("不做心理诊断");
    expect(requestBody.messages[0]?.content).toContain("情绪只能作为线索");
  });

  it("uses scope-aware wording for local-first week memory QA", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "本周互动氛围偏轻松。" } }]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const payload: LocalDayPayload = {
      upload: {
        id: "week_2026-06-08_2026-06-14",
        originalName: "本周记忆",
        mimeType: "application/vnd.daily-brief.memory",
        sizeBytes: 0,
        recordingDate: "2026-06-10",
        status: "ready"
      },
      job: {
        id: "job_week_2026-06-08_2026-06-14",
        uploadId: "week_2026-06-08_2026-06-14",
        status: "ready",
        progress: 100
      },
      segments: [
        {
          id: "week_seg_1",
          uploadId: "local_week",
          startSeconds: 0,
          endSeconds: 30,
          text: "[2026-06-10] 她说下周还可以再约。",
          confidence: 0.9,
          sceneLabels: ["self_reflection"],
          valueLabels: ["idea"]
        }
      ],
      audioInsights: [],
      semanticSegments: [],
      semanticSegmentsAvailable: false,
      briefItems: []
    };

    await answerQuestionLocally({
      payload,
      apiKey: "sk-or-user",
      model: "openai/gpt-5-mini",
      question: "这周互动氛围怎么样？",
      conversation: [],
      scope: "week",
      promptPresetId: "date"
    });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };

    expect(requestBody.messages[0]?.content).toContain("本周录音记忆回答");
    expect(requestBody.messages.at(-1)?.content).toContain("本周记忆上下文");
    expect(requestBody.messages.at(-1)?.content).not.toContain("当天录音上下文");
  });
});
