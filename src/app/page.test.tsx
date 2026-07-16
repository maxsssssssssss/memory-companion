import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProactiveInsight } from "@/lib/domain/proactive-insights";
import type { AudioInsight, AudioUpload, BriefItem, ProcessingJob, RelationshipSignalCard, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";

type LocalDayIndexItem = {
  uploadId: string;
  recordingDate: string;
  originalName: string;
  createdAt: string;
};

const localAnalysisMocks = vi.hoisted(() => ({
  analyzeAudioLocally: vi.fn(),
  answerQuestionLocally: vi.fn(),
  saveLocalDayPayload: vi.fn(),
  readLocalDayPayload: vi.fn(),
  deleteLocalDayPayload: vi.fn(),
  listLocalDayIndex: vi.fn<() => LocalDayIndexItem[]>(() => []),
  readLocalQaHistory: vi.fn(),
  appendLocalQaHistory: vi.fn(),
  clearLocalQaHistory: vi.fn()
}));

vi.mock("@/components/upload-panel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/upload-panel")>();

  return {
    ...actual,
    UploadPanel: ({
      onUploaded,
      processingMode,
      onLocalAnalyze
    }: {
      onUploaded: (uploadId: string) => void;
      processingMode?: "online" | "local";
      onLocalAnalyze?: (input: { file: File; recordingDate: string }) => Promise<void>;
    }) => (
      <section>
        <button type="button" onClick={() => onUploaded("upload_1")}>
          upload-1
        </button>
        <button type="button" onClick={() => onUploaded("upload_2")}>
          upload-2
        </button>
        {processingMode === "local" ? (
          <button
            type="button"
            onClick={() =>
              onLocalAnalyze?.({
                file: new File(["audio"], "local-meeting.mp3", { type: "audio/mpeg" }),
                recordingDate: "2026-06-09"
              })
            }
          >
            local-analyze
          </button>
        ) : null}
      </section>
    )
  };
});

vi.mock("@/lib/client/local-analysis", () => localAnalysisMocks);

import { formatLocalDateInputValue } from "@/components/upload-panel";

import HomePage from "./page";

type DayPayload = {
  upload: AudioUpload;
  job?: ProcessingJob;
  segments: TranscriptSegment[];
  audioInsights?: AudioInsight[];
  semanticSegments?: SemanticSegment[];
  semanticSegmentsAvailable?: boolean;
  briefItems: BriefItem[];
  relationshipSignals?: RelationshipSignalCard[];
  relationshipSignalsAvailable?: boolean;
  proactiveInsights?: ProactiveInsight[];
  proactiveInsightsAvailable?: boolean;
  speakerAliases?: Record<string, string>;
  speakerAliasesByUploadId?: Record<string, Record<string, string>>;
};

type MockJsonResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

const AUTH_USER = { id: "user_test", email: "tester@example.com", name: "测试用户" };
const ACTIVE_USER_STORAGE_KEY = "daily-brief:active-user-id";
const LAST_UPLOAD_ID_STORAGE_KEY = `daily-brief:${AUTH_USER.id}:last-upload-id`;
const SELECTED_RECORDING_DATE_STORAGE_KEY = `daily-brief:${AUTH_USER.id}:selected-recording-date`;
const LOCAL_OPENROUTER_API_KEY_STORAGE_KEY = `daily-brief:${AUTH_USER.id}:openrouter-api-key`;

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

function deferredResponse() {
  let resolve!: (response: MockJsonResponse) => void;
  const promise = new Promise<MockJsonResponse>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): MockJsonResponse {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body
  };
}

function authMeResponse() {
  return jsonResponse({ user: AUTH_USER });
}

function withAuthenticatedFetch(fetchMock: (input: RequestInfo | URL, init?: RequestInit) => unknown) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url === "/api/auth/me") {
      return Promise.resolve(authMeResponse());
    }

    return fetchMock(input, init);
  });
}

function latestUploadResponse(uploadId: string | null = null) {
  return jsonResponse({ uploadId });
}

function uploadByDateResponse(date: string, uploadId: string | null = null) {
  return jsonResponse({ uploadId, recordingDate: date });
}

function uploadsByDateResponse(date: string, uploadIds: string[]) {
  return jsonResponse({ uploadId: uploadIds.at(-1) ?? null, uploadIds, recordingDate: date });
}

function uploadDatesResponse(dates: string[]) {
  return jsonResponse({ dates });
}

function settingsResponse(overrides?: Record<string, unknown>) {
  return jsonResponse({
    apiKeyMode: "default",
    hasCustomApiKey: false,
    defaultApiKeyAvailable: true,
    activeApiKeySource: "default",
    providerDisplayName: "OpenRouter / OpenAI compatible",
    storageMode: "local",
    canOpenDataFolder: true,
    dataDirectory: "/Users/wangsong/Documents/Long-time Record Analyze/.data",
    uploadsDirectory: "/Users/wangsong/Documents/Long-time Record Analyze/.data/uploads",
    apiKeyStoragePath: "/Users/wangsong/Documents/Long-time Record Analyze/.data/settings/provider-config.json",
    qaPromptPresetId: "work",
    customQaPrompt: "",
    qaPromptPresets: [
      { id: "work", label: "工作复盘", description: "决策、任务、风险" },
      { id: "date", label: "约会陪伴", description: "互动、感受、关系线索" },
      { id: "negotiation", label: "商务谈判", description: "诉求、筹码、风险" },
      { id: "learning", label: "听课学习", description: "知识点、例子、复习" },
      { id: "casual", label: "日常闲聊", description: "生活细节、轻松记录" },
      { id: "custom", label: "自定义", description: "使用你写的提示词" }
    ],
    ...overrides
  });
}

function countFetchCallsTo(fetchMock: ReturnType<typeof vi.fn>, targetUrl: string) {
  return fetchMock.mock.calls.filter(([input]) => String(input) === targetUrl).length;
}

async function triggerMockUpload(uploadButtonName: "upload-1" | "upload-2") {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  const uploadButtons = screen.getAllByRole("button", { name: "上传录音" });

  await act(async () => {
    fireEvent.click(uploadButtons[0]);
    await Promise.resolve();
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: uploadButtonName }));
    await Promise.resolve();
  });
}

async function openCalendar() {
  fireEvent.click(screen.getByLabelText("查看日期"));

  await waitFor(() => {
    expect(screen.getByRole("dialog", { name: "选择查看日期" })).toBeInTheDocument();
  });
}

async function selectCalendarDate(date: string, hasEntry = true) {
  await openCalendar();
  const label = `${date} ${hasEntry ? "有日记" : "无日记"}`;
  const targetMonth = date.slice(0, 7);

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const targetButton = screen.queryByLabelText(label);
    if (targetButton) {
      fireEvent.click(targetButton);
      return;
    }

    const monthLabel = screen.getByRole("grid").getAttribute("aria-label") ?? "";
    const monthMatch = /^(\d{4}) 年 (\d{1,2}) 月$/.exec(monthLabel);
    if (!monthMatch) {
      break;
    }

    const currentMonth = `${monthMatch[1]}-${monthMatch[2].padStart(2, "0")}`;
    if (currentMonth === targetMonth) {
      break;
    }

    fireEvent.click(screen.getByRole("button", { name: currentMonth > targetMonth ? "上个月" : "下个月" }));
  }

  fireEvent.click(screen.getByLabelText(label));
}

function buildPayload(
  uploadId: string,
  status: ProcessingJob["status"],
  overrides?: Partial<DayPayload>
): DayPayload {
  return {
    upload: {
      id: uploadId,
      originalName: `${uploadId}.m4a`,
      mimeType: "audio/m4a",
      sizeBytes: 1024,
      recordingDate: "2026-06-04",
      status
    },
    job: {
      id: `job_${uploadId}`,
      uploadId,
      status,
      progress: status === "ready" ? 100 : 30
    },
    segments: [],
    briefItems: [],
    ...overrides
  };
}

describe("HomePage", () => {
  let localStorageMock: Storage;

  beforeEach(() => {
    localAnalysisMocks.analyzeAudioLocally.mockReset();
    localAnalysisMocks.answerQuestionLocally.mockReset();
    localAnalysisMocks.saveLocalDayPayload.mockReset();
    localAnalysisMocks.readLocalDayPayload.mockReset();
    localAnalysisMocks.deleteLocalDayPayload.mockReset();
    localAnalysisMocks.listLocalDayIndex.mockReset();
    localAnalysisMocks.listLocalDayIndex.mockReturnValue([]);
    localAnalysisMocks.readLocalQaHistory.mockReset();
    localAnalysisMocks.readLocalQaHistory.mockReturnValue([]);
    localAnalysisMocks.appendLocalQaHistory.mockReset();
    localAnalysisMocks.clearLocalQaHistory.mockReset();
    localStorageMock = createLocalStorageMock();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: localStorageMock
    });
  });

  afterEach(() => {
    cleanup();
    localStorageMock.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the local calendar date for the recording input default", () => {
    const localMidnight = new Date(2026, 0, 2, 0, 30);

    expect(formatLocalDateInputValue(localMidnight)).toBe("2026-01-02");
  });

  it("shows the login screen when no authenticated user exists", async () => {
    const anonymousFetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/auth/me") {
        return Promise.resolve(jsonResponse({ error: "unauthenticated" }, { ok: false, status: 401 }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", anonymousFetchMock);

    render(<HomePage />);

    expect(await screen.findByRole("heading", { name: "登录昼记" })).toBeInTheDocument();
    expect(screen.getByText("每个账号拥有独立的录音、摘要、问答历史和模型配置。")).toBeInTheDocument();
    expect(countFetchCallsTo(anonymousFetchMock, "/api/settings")).toBe(0);
  });

  it("logs in, enters the isolated workspace, and logs out", async () => {
    const authFetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/auth/me") {
        return Promise.resolve(jsonResponse({ error: "unauthenticated" }, { ok: false, status: 401 }));
      }

      if (url === "/api/auth/login" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ user: AUTH_USER }));
      }

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/latest") {
        return Promise.resolve(latestUploadResponse(null));
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse([]));
      }

      if (url === "/api/auth/logout" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ ok: true }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", authFetchMock);

    render(<HomePage />);

    fireEvent.change(await screen.findByLabelText("邮箱"), { target: { value: AUTH_USER.email } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByText("上传录音后，这里会成为你的工作台。")).toBeInTheDocument();
    expect(screen.getByText(AUTH_USER.name)).toBeInTheDocument();
    expect(window.localStorage.getItem(ACTIVE_USER_STORAGE_KEY)).toBe(AUTH_USER.id);

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));

    expect(await screen.findByRole("heading", { name: "登录昼记" })).toBeInTheDocument();
    expect(authFetchMock).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
    expect(window.localStorage.getItem(ACTIVE_USER_STORAGE_KEY)).toBeNull();
  });

  it("sends an invite code when registering a new user", async () => {
    const authFetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/auth/me") {
        return Promise.resolve(jsonResponse({ error: "unauthenticated" }, { ok: false, status: 401 }));
      }

      if (url === "/api/auth/register" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ user: AUTH_USER }));
      }

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/latest") {
        return Promise.resolve(latestUploadResponse(null));
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse([]));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", authFetchMock);

    render(<HomePage />);

    fireEvent.click(await screen.findByRole("button", { name: "还没有账号？注册" }));
    fireEvent.change(screen.getByLabelText("昵称"), { target: { value: AUTH_USER.name } });
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: AUTH_USER.email } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "password123" } });
    fireEvent.change(screen.getByLabelText("邀请码"), { target: { value: "alpha-invite" } });
    fireEvent.click(screen.getByRole("button", { name: "注册并进入" }));

    expect(await screen.findByText("上传录音后，这里会成为你的工作台。")).toBeInTheDocument();

    const registerCall = authFetchMock.mock.calls.find(([url, init]) => String(url) === "/api/auth/register" && init?.method === "POST");
    expect(JSON.parse(String(registerCall?.[1]?.body))).toEqual({
      email: AUTH_USER.email,
      password: "password123",
      name: AUTH_USER.name,
      inviteCode: "alpha-invite"
    });
  });

  it("restores the last upload from local storage after a refresh", async () => {
    window.localStorage.setItem(LAST_UPLOAD_ID_STORAGE_KEY, "upload_1");
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/days/upload_1") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_1", "ready", {
              briefItems: [
                {
                  id: "brief_restore",
                  uploadId: "upload_1",
                  category: "decision",
                  title: "刷新后恢复的决策",
                  body: "刷新后应自动读取已保存结果。",
                  priority: "high",
                  confidence: 0.9,
                  status: "confirmed",
                  sourceSegmentIds: ["seg_restore"],
                  sourceTimeRange: { startSeconds: 10, endSeconds: 20 },
                  transcriptExcerpt: "恢复结果",
                  people: [],
                  topics: []
                }
              ]
            })
          )
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("刷新后恢复的决策")).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/days/upload_1", expect.anything());
  });

  it("shows a user-friendly recording status summary instead of the raw upload id", async () => {
    const uploadId = "99f3f2c6-38af-4847-a325-5f08a1743005";
    window.localStorage.setItem(LAST_UPLOAD_ID_STORAGE_KEY, uploadId);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === `/api/days/${uploadId}`) {
        return Promise.resolve(
          jsonResponse(
            buildPayload(uploadId, "ready", {
              upload: {
                id: uploadId,
                originalName: "board-meeting.mp3",
                mimeType: "audio/mpeg",
                sizeBytes: 2048,
                recordingDate: "2026-06-05",
                status: "ready",
                durationSeconds: 3660
              }
            })
          )
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    const statusRegion = await screen.findByLabelText("处理状态");

    await waitFor(() => {
      expect(within(statusRegion).getByText("录音复盘已完成")).toBeInTheDocument();
    });
    expect(within(statusRegion).getByText("已完成")).toBeInTheDocument();
    expect(within(statusRegion).getByText("每日复盘、时间轴和问答已可用")).toBeInTheDocument();
    expect(within(statusRegion).getByText("录音日期")).toBeInTheDocument();
    expect(within(statusRegion).getByText("2026 年 6 月 5 日")).toBeInTheDocument();
    expect(within(statusRegion).getByText("音频时长")).toBeInTheDocument();
    expect(within(statusRegion).getByText("1h 1m")).toBeInTheDocument();
    expect(within(statusRegion).getByText("记录编号")).toBeInTheDocument();
    expect(within(statusRegion).getByText("99f3f2c6…3005")).toBeInTheDocument();
    expect(within(statusRegion).queryByText("上传 ID")).not.toBeInTheDocument();
    expect(within(statusRegion).queryByText(uploadId)).not.toBeInTheDocument();
  });

  it("filters the current recording from the top search and shows result counts", async () => {
    window.localStorage.setItem(LAST_UPLOAD_ID_STORAGE_KEY, "upload_search");
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/days/upload_search") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_search", "ready", {
              briefItems: [
                {
                  id: "brief_customer",
                  uploadId: "upload_search",
                  category: "task",
                  title: "跟进客户续费预算",
                  body: "客户希望本周重新确认续费预算。",
                  priority: "high",
                  confidence: 0.92,
                  status: "confirmed",
                  sourceSegmentIds: ["seg_customer"],
                  sourceTimeRange: { startSeconds: 120, endSeconds: 180 },
                  transcriptExcerpt: "客户续费预算要重新确认。",
                  people: ["客户"],
                  topics: ["续费"]
                },
                {
                  id: "brief_internal",
                  uploadId: "upload_search",
                  category: "task",
                  title: "整理内部培训材料",
                  body: "团队内部培训材料需要更新。",
                  priority: "medium",
                  confidence: 0.86,
                  status: "confirmed",
                  sourceSegmentIds: ["seg_internal"],
                  sourceTimeRange: { startSeconds: 220, endSeconds: 260 },
                  transcriptExcerpt: "内部培训材料需要更新。",
                  people: [],
                  topics: ["培训"]
                }
              ],
              segments: [
                {
                  id: "seg_customer",
                  uploadId: "upload_search",
                  startSeconds: 120,
                  endSeconds: 180,
                  text: "客户续费预算要重新确认。",
                  confidence: 0.94,
                  sceneLabels: ["customer_call"],
                  valueLabels: ["task"]
                },
                {
                  id: "seg_internal",
                  uploadId: "upload_search",
                  startSeconds: 220,
                  endSeconds: 260,
                  text: "内部培训材料需要更新。",
                  confidence: 0.91,
                  sceneLabels: ["team_management"],
                  valueLabels: ["task"]
                }
              ],
              semanticSegments: [
                {
                  id: "semantic_customer",
                  uploadId: "upload_search",
                  title: "续费预算跟进",
                  summary: "讨论续费预算，需要继续和客户确认。",
                  startSeconds: 120,
                  endSeconds: 180,
                  tags: ["客户", "任务"],
                  sceneLabels: ["customer_call"],
                  valueLabels: ["task"],
                  confidence: 0.9,
                  sourceSegmentIds: ["seg_customer"],
                  sourceTimeRange: { startSeconds: 120, endSeconds: 180 },
                  transcriptExcerpt: "客户续费预算要重新确认。"
                },
                {
                  id: "semantic_internal",
                  uploadId: "upload_search",
                  title: "内部培训材料更新",
                  summary: "讨论内部培训材料更新。",
                  startSeconds: 220,
                  endSeconds: 260,
                  tags: ["培训", "任务"],
                  sceneLabels: ["team_management"],
                  valueLabels: ["task"],
                  confidence: 0.88,
                  sourceSegmentIds: ["seg_internal"],
                  sourceTimeRange: { startSeconds: 220, endSeconds: 260 },
                  transcriptExcerpt: "内部培训材料需要更新。"
                }
              ],
              semanticSegmentsAvailable: true
            })
          )
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("跟进客户续费预算")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText("搜索当前录音的内容、人名、承诺..."), {
      target: { value: "客户" }
    });

    const searchRegion = await screen.findByLabelText("搜索结果");

    expect(within(searchRegion).getByText("搜索 “客户”")).toBeInTheDocument();
    expect(within(searchRegion).getByText("简报 1 条")).toBeInTheDocument();
    expect(within(searchRegion).getByText("时间轴 1 段")).toBeInTheDocument();
    expect(screen.getByText("跟进客户续费预算")).toBeInTheDocument();
    expect(screen.queryByText("整理内部培训材料")).not.toBeInTheDocument();
  });

  it("shows speaker aliases in timeline audio insight details", async () => {
    window.localStorage.setItem(LAST_UPLOAD_ID_STORAGE_KEY, "upload_alias");
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/days/upload_alias") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_alias", "ready", {
              speakerAliasesByUploadId: {
                upload_alias: {
                  speaker_1: "张三"
                }
              },
              segments: [
                {
                  id: "seg_alias",
                  uploadId: "upload_alias",
                  startSeconds: 60,
                  endSeconds: 120,
                  speaker: "speaker_1",
                  text: "延期风险需要今天确认。",
                  confidence: 0.9,
                  sceneLabels: ["product_discussion"],
                  valueLabels: ["risk"]
                }
              ],
              audioInsights: [
                {
                  id: "insight_alias",
                  uploadId: "upload_alias",
                  sourceSegmentIds: ["seg_alias"],
                  sourceTimeRange: { startSeconds: 60, endSeconds: 120 },
                  speaker: { id: "speaker_1", role: "unknown", confidence: 0.5 },
                  voice: { pace: "normal", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.4 },
                  toneLabels: ["firm"],
                  emotionLabels: ["neutral"],
                  interactionLabels: ["decision_moment"],
                  summary: "speaker_1 明确要求确认延期风险。",
                  evidence: "speaker_1 提到延期风险需要今天确认。",
                  confidence: 0.7
                }
              ]
            })
          )
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await screen.findByText("录音复盘已完成");
    fireEvent.click(screen.getByRole("button", { name: "时间轴" }));

    const details = await screen.findByText("speaker_1：延期风险需要今天确认");
    details.closest("details")?.setAttribute("open", "");

    expect(
      screen.getByText((_, element) => {
        const text = element?.textContent?.replace(/\s+/g, " ").trim();
        return text === "张三：张三 明确要求确认延期风险。张三 提到延期风险需要今天确认。";
      })
    ).toBeInTheDocument();
  });

  it("saves speaker aliases to browser cache when the temporary server upload has been cleaned", async () => {
    window.localStorage.setItem(LAST_UPLOAD_ID_STORAGE_KEY, "upload_alias_cleaned");
    const cachedPayload = buildPayload("upload_alias_cleaned", "ready", {
      segments: [
        {
          id: "seg_alias_cleaned",
          uploadId: "upload_alias_cleaned",
          startSeconds: 60,
          endSeconds: 120,
          speaker: "speaker_1",
          text: "speaker_1 说明天继续确认渠道策略。",
          confidence: 0.9,
          sceneLabels: ["product_discussion"],
          valueLabels: ["task"]
        }
      ],
      briefItems: [
        {
          id: "brief_alias_cleaned",
          uploadId: "upload_alias_cleaned",
          category: "task",
          title: "speaker_1 确认渠道策略",
          body: "speaker_1 提到明天继续确认渠道策略。",
          priority: "medium",
          confidence: 0.82,
          status: "confirmed",
          sourceSegmentIds: ["seg_alias_cleaned"],
          sourceTimeRange: { startSeconds: 60, endSeconds: 120 },
          transcriptExcerpt: "speaker_1 说明天继续确认渠道策略。",
          people: ["speaker_1"],
          topics: ["渠道"]
        }
      ]
    });
    localAnalysisMocks.readLocalDayPayload.mockImplementation((uploadId: string) => (uploadId === "upload_alias_cleaned" ? cachedPayload : null));
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/days/upload_alias_cleaned/speaker-aliases" && init?.method === "PUT") {
        return Promise.resolve(jsonResponse({ error: "upload_not_found" }, { ok: false, status: 404 }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await screen.findByText("录音复盘已完成");
    fireEvent.change(screen.getByPlaceholderText("speaker_1"), { target: { value: "大叔" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("已保存")).toBeInTheDocument();
    expect(localAnalysisMocks.saveLocalDayPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        upload: expect.objectContaining({ id: "upload_alias_cleaned" }),
        speakerAliases: {
          speaker_1: "大叔"
        },
        speakerAliasesByUploadId: {
          upload_alias_cleaned: {
            speaker_1: "大叔"
          }
        }
      })
    );
  });

  it("uses speaker aliases in current recording QA context while preserving raw segment speaker ids", async () => {
    window.localStorage.setItem(LAST_UPLOAD_ID_STORAGE_KEY, "upload_qa_alias");
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/days/upload_qa_alias") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_qa_alias", "ready", {
              speakerAliasesByUploadId: {
                upload_qa_alias: {
                  speaker_1: "张三"
                }
              },
              segments: [
                {
                  id: "seg_qa_alias",
                  uploadId: "upload_qa_alias",
                  startSeconds: 10,
                  endSeconds: 40,
                  speaker: "speaker_1",
                  text: "speaker_1 说今天要确认方案。",
                  confidence: 0.9,
                  sceneLabels: ["product_discussion"],
                  valueLabels: ["task"]
                }
              ],
              audioInsights: [
                {
                  id: "insight_qa_alias",
                  uploadId: "upload_qa_alias",
                  sourceSegmentIds: ["seg_qa_alias"],
                  sourceTimeRange: { startSeconds: 10, endSeconds: 40 },
                  speaker: { id: "speaker_1", role: "unknown", confidence: 0.5 },
                  voice: { pace: "normal", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.4 },
                  toneLabels: ["firm"],
                  emotionLabels: ["neutral"],
                  interactionLabels: ["decision_moment"],
                  summary: "speaker_1 明确推进方案。",
                  evidence: "speaker_1 说今天要确认方案。",
                  confidence: 0.7
                }
              ],
              briefItems: [
                {
                  id: "brief_qa_alias",
                  uploadId: "upload_qa_alias",
                  category: "task",
                  title: "speaker_1 确认方案",
                  body: "speaker_1 今天要确认方案。",
                  priority: "high",
                  confidence: 0.9,
                  status: "confirmed",
                  sourceSegmentIds: ["seg_qa_alias"],
                  sourceTimeRange: { startSeconds: 10, endSeconds: 40 },
                  transcriptExcerpt: "speaker_1 说今天要确认方案。",
                  people: ["speaker_1"],
                  topics: ["方案"]
                }
              ]
            })
          )
        );
      }

      if (url === "/api/days/context/qa" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          segments?: TranscriptSegment[];
          audioInsights?: AudioInsight[];
          briefItems?: BriefItem[];
        };

        expect(body.segments?.[0]?.speaker).toBe("speaker_1");
        expect(body.audioInsights?.[0]?.speaker.displayName).toBe("张三");
        expect(body.audioInsights?.[0]?.summary).toBe("张三 明确推进方案。");
        expect(body.briefItems?.[0]?.people).toEqual(["张三"]);
        expect(body.briefItems?.[0]?.title).toBe("张三 确认方案");

        return Promise.resolve(
          jsonResponse({
            id: "answer_qa_alias",
            uploadId: "upload_qa_alias",
            question: "谁要确认方案？",
            answer: "张三要确认方案。",
            citedSegmentIds: ["seg_qa_alias"],
            createdAt: "2026-06-04T10:00:00.000Z"
          })
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await screen.findByText("张三 确认方案");
    fireEvent.click(screen.getAllByRole("button", { name: /问答/ })[0]);

    const questionBox = await screen.findByLabelText("问题");
    fireEvent.change(questionBox, { target: { value: "谁要确认方案？" } });
    fireEvent.keyDown(questionBox, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("张三要确认方案。")).toBeInTheDocument();
  });

  it("shows relationship-signal proactive questions in the QA panel", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/latest") {
        return Promise.resolve(latestUploadResponse("upload_relationship"));
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse(["2026-07-09"]));
      }

      if (url === "/api/days/upload_relationship") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_relationship", "ready", {
              upload: {
                id: "upload_relationship",
                originalName: "date.mp3",
                mimeType: "audio/mpeg",
                sizeBytes: 2048,
                recordingDate: "2026-07-09",
                createdAt: "2026-07-09T10:00:00.000Z",
                status: "ready"
              },
              segments: [
                {
                  id: "seg_relationship_1",
                  uploadId: "upload_relationship",
                  startSeconds: 0,
                  endSeconds: 20,
                  speaker: "speaker_1",
                  text: "我听到你说最近有点累，所以先不急着定下一次见面。",
                  confidence: 0.92,
                  sceneLabels: ["self_reflection"],
                  valueLabels: ["idea"]
                }
              ],
              briefItems: [
                {
                  id: "brief_relationship_1",
                  uploadId: "upload_relationship",
                  category: "open_question",
                  title: "下次见面安排还没有完全说清",
                  body: "对话里提到下次见面的可能时间，但还没有明确确认。",
                  priority: "high",
                  confidence: 0.84,
                  status: "confirmed",
                  sourceSegmentIds: ["seg_relationship_1"],
                  sourceTimeRange: { startSeconds: 0, endSeconds: 20 },
                  transcriptExcerpt: "那我们下周再看看时间。",
                  people: [],
                  topics: ["见面安排"]
                }
              ],
              relationshipSignals: [
                {
                  id: "signal_relationship_1",
                  uploadId: "upload_relationship",
                  date: "2026-07-09",
                  signalType: "emotional_support",
                  signalCategory: "positive",
                  severity: "low",
                  confidence: 0.74,
                  summary: "对方先回应了疲惫感，再讨论下一步安排。",
                  explanation: "这更像是在确认感受后再推进话题。",
                  involvedSpeakers: ["speaker_1"],
                  timeRange: { startSeconds: 0, endSeconds: 20 },
                  evidenceSegments: [
                    {
                      segmentId: "seg_relationship_1",
                      speaker: "speaker_1",
                      startSeconds: 0,
                      endSeconds: 20,
                      text: "我听到你说最近有点累，所以先不急着定下一次见面。"
                    }
                  ],
                  textEvidence: ["先回应疲惫感，再讨论安排。"],
                  suggestedReflection: "你可以回看这个回应是否让你感到被理解。",
                  createdAt: "2026-07-09T10:00:00.000Z"
                }
              ],
              relationshipSignalsAvailable: true,
              proactiveInsights: [
                {
                  id: "proactive_relationship_1",
                  scope: "current",
                  type: "reflection",
                  category: "relationship",
                  observation: "这次回应先接住了疲惫感，再讨论下一步安排。",
                  question: "这次回应中，哪句话最值得继续确认？",
                  reason: "这能帮助你区分被理解的感受和仍需澄清的安排。",
                  confidence: 0.78,
                  evidenceRefs: [
                    {
                      evidenceId: "relationship_signal:signal_relationship_1",
                      kind: "relationship_signal",
                      sourceType: "relationship_signal",
                      sourceId: "signal_relationship_1",
                      uploadId: "upload_relationship",
                      recordingDate: "2026-07-09",
                      sourceSegmentIds: ["seg_relationship_1"],
                      timeRange: { startSeconds: 0, endSeconds: 20 },
                      title: "情绪接住",
                      summary: "对方先回应了疲惫感，再讨论下一步安排。",
                      excerpt: "我听到你说最近有点累，所以先不急着定下一次见面。",
                      confidence: 0.74,
                      signalCategory: "positive"
                    }
                  ],
                  sourceUploadIds: ["upload_relationship"],
                  createdAt: "2026-07-09T10:02:00.000Z"
                }
              ],
              proactiveInsightsAvailable: true
            })
          )
        );
      }

      if (url === "/api/days/context/qa" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          relationshipSignals?: RelationshipSignalCard[];
        };
        expect(body.relationshipSignals?.map((card) => card.id)).toEqual(["signal_relationship_1"]);

        return Promise.resolve(
          jsonResponse({
            id: "answer_relationship_signal",
            uploadId: "upload_relationship",
            question: "这次回应中，哪句话最值得继续确认？",
            answer: "这次互动里有一条情绪接住的积极线索，并引用了原文证据。",
            citedSegmentIds: ["seg_relationship_1"],
            createdAt: "2026-07-09T10:05:00.000Z"
          })
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    expect(await screen.findByText("下次见面安排还没有完全说清")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "问答 AI" }));

    expect(await screen.findByText("AI 主动观察")).toBeInTheDocument();
    expect(screen.getByText("这次回应先接住了疲惫感，再讨论下一步安排。")).toBeInTheDocument();
    expect(screen.getByText("你可能想问")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /这次回应中，哪句话最值得继续确认？/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /这次回应中，哪句话最值得继续确认？/ }));
    expect(screen.getByLabelText("问题")).toHaveValue("这次回应中，哪句话最值得继续确认？");
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/days/context/qa" && init?.method === "POST")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    expect(await screen.findByText("这次互动里有一条情绪接住的积极线索，并引用了原文证据。")).toBeInTheDocument();
  });

  it("loads the latest saved upload when local storage is empty", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/latest") {
        return Promise.resolve(latestUploadResponse("upload_2"));
      }

      if (url === "/api/days/upload_2") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_2", "ready", {
              briefItems: [
                {
                  id: "brief_latest",
                  uploadId: "upload_2",
                  category: "task",
                  title: "最新保存的待办",
                  body: "没有本地 uploadId 时应读取服务端最新记录。",
                  priority: "high",
                  confidence: 0.91,
                  status: "confirmed",
                  sourceSegmentIds: ["seg_latest"],
                  sourceTimeRange: { startSeconds: 30, endSeconds: 40 },
                  transcriptExcerpt: "最新记录",
                  people: [],
                  topics: []
                }
              ]
            })
          )
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
    expect(screen.getByText("最新保存的待办")).toBeInTheDocument();
    });
    expect(window.localStorage.getItem(LAST_UPLOAD_ID_STORAGE_KEY)).toBe("upload_2");
  });

  it("falls back to the latest saved upload when the stored upload id is unreadable", async () => {
    window.localStorage.setItem(LAST_UPLOAD_ID_STORAGE_KEY, "stale_upload");
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/days/stale_upload") {
        return Promise.resolve(jsonResponse({ error: "旧录音已不存在。" }, { ok: false, status: 404 }));
      }

      if (url === "/api/uploads/latest") {
        return Promise.resolve(latestUploadResponse("upload_2"));
      }

      if (url === "/api/days/upload_2") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_2", "ready", {
              briefItems: [
                {
                  id: "brief_latest_after_stale",
                  uploadId: "upload_2",
                  category: "task",
                  title: "旧缓存失效后恢复的待办",
                  body: "本地旧 uploadId 不可读时应自动读取服务端最新记录。",
                  priority: "high",
                  confidence: 0.91,
                  status: "confirmed",
                  sourceSegmentIds: ["seg_latest_after_stale"],
                  sourceTimeRange: { startSeconds: 30, endSeconds: 40 },
                  transcriptExcerpt: "旧缓存失效后恢复",
                  people: [],
                  topics: []
                }
              ]
            })
          )
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("旧缓存失效后恢复的待办")).toBeInTheDocument();
    });

    expect(window.localStorage.getItem(LAST_UPLOAD_ID_STORAGE_KEY)).toBe("upload_2");
    expect(screen.queryByText("读取分析结果失败。")).not.toBeInTheDocument();
  });

  it("does not let a stale latest upload response override a selected date", async () => {
    const latest = deferredResponse();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/latest") {
        return latest.promise;
      }

      if (url === "/api/uploads/by-date?date=2026-06-03") {
        return Promise.resolve(uploadByDateResponse("2026-06-03", "upload_3"));
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse(["2026-06-03"]));
      }

      if (url === "/api/days/upload_3") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_3", "ready", {
              upload: {
                id: "upload_3",
                originalName: "upload_3.m4a",
                mimeType: "audio/m4a",
                sizeBytes: 1024,
                recordingDate: "2026-06-03",
                status: "ready"
              },
              briefItems: [
                {
                  id: "brief_selected_before_latest",
                  uploadId: "upload_3",
                  category: "task",
                  title: "用户选择日期后的内容",
                  body: "latest 晚返回也不能覆盖这个日期。",
                  priority: "high",
                  confidence: 0.92,
                  status: "confirmed",
                  sourceSegmentIds: ["seg_selected_before_latest"],
                  sourceTimeRange: { startSeconds: 30, endSeconds: 40 },
                  transcriptExcerpt: "用户选择日期内容",
                  people: [],
                  topics: []
                }
              ]
            })
          )
        );
      }

      if (url === "/api/days/upload_latest") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_latest", "ready", {
              briefItems: [
                {
                  id: "brief_stale_latest",
                  uploadId: "upload_latest",
                  category: "decision",
                  title: "晚返回的最新录音",
                  body: "这个内容不应该覆盖用户选择的日期。",
                  priority: "high",
                  confidence: 0.9,
                  status: "confirmed",
                  sourceSegmentIds: ["seg_stale_latest"],
                  sourceTimeRange: { startSeconds: 10, endSeconds: 20 },
                  transcriptExcerpt: "晚返回 latest",
                  people: [],
                  topics: []
                }
              ]
            })
          )
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/uploads/latest", expect.anything());
    });

    await selectCalendarDate("2026-06-03");

    await waitFor(() => {
      expect(screen.getByText("用户选择日期后的内容")).toBeInTheDocument();
    });

    await act(async () => {
      latest.resolve(latestUploadResponse("upload_latest"));
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalledWith("/api/days/upload_latest", expect.anything());
    expect(screen.queryByText("晚返回的最新录音")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(LAST_UPLOAD_ID_STORAGE_KEY)).toBe("upload_3");
  });

  it("loads another day when the top date selector changes", async () => {
    window.localStorage.setItem(LAST_UPLOAD_ID_STORAGE_KEY, "upload_4");
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/days/upload_4") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_4", "ready", {
              upload: {
                id: "upload_4",
                originalName: "upload_4.m4a",
                mimeType: "audio/m4a",
                sizeBytes: 1024,
                recordingDate: "2026-06-04",
                status: "ready"
              },
              briefItems: [
                {
                  id: "brief_today",
                  uploadId: "upload_4",
                  category: "decision",
                  title: "今天的复盘",
                  body: "这是当前日期的内容。",
                  priority: "high",
                  confidence: 0.9,
                  status: "confirmed",
                  sourceSegmentIds: ["seg_today"],
                  sourceTimeRange: { startSeconds: 10, endSeconds: 20 },
                  transcriptExcerpt: "今天的内容",
                  people: [],
                  topics: []
                }
              ]
            })
          )
        );
      }

      if (url === "/api/uploads/by-date?date=2026-06-03") {
        return Promise.resolve(uploadByDateResponse("2026-06-03", "upload_3"));
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse(["2026-06-03", "2026-06-04"]));
      }

      if (url === "/api/days/upload_3") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_3", "ready", {
              upload: {
                id: "upload_3",
                originalName: "upload_3.m4a",
                mimeType: "audio/m4a",
                sizeBytes: 1024,
                recordingDate: "2026-06-03",
                status: "ready"
              },
              briefItems: [
                {
                  id: "brief_selected_date",
                  uploadId: "upload_3",
                  category: "task",
                  title: "六月三日的待办",
                  body: "切换日期后应展示这一天的内容。",
                  priority: "high",
                  confidence: 0.92,
                  status: "confirmed",
                  sourceSegmentIds: ["seg_selected_date"],
                  sourceTimeRange: { startSeconds: 30, endSeconds: 40 },
                  transcriptExcerpt: "六月三日内容",
                  people: [],
                  topics: []
                }
              ]
            })
          )
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("今天的复盘")).toBeInTheDocument();
    });

    await selectCalendarDate("2026-06-03");

    await waitFor(() => {
      expect(screen.getByText("六月三日的待办")).toBeInTheDocument();
    });
    expect(screen.queryByText("今天的复盘")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(LAST_UPLOAD_ID_STORAGE_KEY)).toBe("upload_3");
    expect(fetchMock).toHaveBeenCalledWith("/api/uploads/by-date?date=2026-06-03", expect.anything());
  });

  it("combines multiple local recordings from the selected date into one day view", async () => {
    window.localStorage.setItem(LAST_UPLOAD_ID_STORAGE_KEY, "upload_4");
    const morningPayload = buildPayload("local_morning", "ready", {
      upload: {
        id: "local_morning",
        originalName: "morning.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 2048,
        recordingDate: "2026-06-03",
        createdAt: "2026-06-03T01:00:00.000Z",
        durationSeconds: 60,
        status: "ready"
      },
      briefItems: [
        {
          id: "brief_morning",
          uploadId: "local_morning",
          category: "decision",
          title: "上午会议结论",
          body: "上午确认了产品方向。",
          priority: "high",
          confidence: 0.9,
          status: "confirmed",
          sourceSegmentIds: ["seg_morning"],
          sourceTimeRange: { startSeconds: 10, endSeconds: 20 },
          transcriptExcerpt: "上午确认产品方向。",
          people: [],
          topics: ["产品"]
        }
      ]
    });
    const afternoonPayload = buildPayload("local_afternoon", "ready", {
      upload: {
        id: "local_afternoon",
        originalName: "afternoon.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 4096,
        recordingDate: "2026-06-03",
        createdAt: "2026-06-03T06:00:00.000Z",
        durationSeconds: 90,
        status: "ready"
      },
      briefItems: [
        {
          id: "brief_afternoon",
          uploadId: "local_afternoon",
          category: "task",
          title: "下午客户待办",
          body: "下午需要跟进客户预算。",
          priority: "high",
          confidence: 0.92,
          status: "confirmed",
          sourceSegmentIds: ["seg_afternoon"],
          sourceTimeRange: { startSeconds: 30, endSeconds: 50 },
          transcriptExcerpt: "下午跟进客户预算。",
          people: ["客户"],
          topics: ["预算"]
        }
      ]
    });
    const localPayloads = new Map([
      ["local_morning", morningPayload],
      ["local_afternoon", afternoonPayload]
    ]);
    localAnalysisMocks.listLocalDayIndex.mockReturnValue([
      {
        uploadId: "local_morning",
        recordingDate: "2026-06-03",
        originalName: "morning.mp3",
        createdAt: "2026-06-03T01:00:00.000Z"
      },
      {
        uploadId: "local_afternoon",
        recordingDate: "2026-06-03",
        originalName: "afternoon.mp3",
        createdAt: "2026-06-03T06:00:00.000Z"
      }
    ]);
    localAnalysisMocks.readLocalDayPayload.mockImplementation((uploadId: string) => localPayloads.get(uploadId) ?? null);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/days/upload_4") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_4", "ready", {
              upload: {
                id: "upload_4",
                originalName: "upload_4.m4a",
                mimeType: "audio/m4a",
                sizeBytes: 1024,
                recordingDate: "2026-06-04",
                status: "ready"
              }
            })
          )
        );
      }

      if (url === "/api/uploads/by-date?date=2026-06-03") {
        return Promise.resolve(uploadsByDateResponse("2026-06-03", []));
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse(["2026-06-04"]));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("录音复盘已完成")).toBeInTheDocument();
    });

    await selectCalendarDate("2026-06-03");

    await waitFor(() => {
      expect(screen.getByText("上午会议结论")).toBeInTheDocument();
    });
    expect(screen.getByText("下午客户待办")).toBeInTheDocument();
    expect(screen.getByLabelText("处理状态")).toHaveTextContent("2 段录音");
    expect(screen.getByLabelText("当天录音列表")).toHaveTextContent("morning.mp3");
    expect(screen.getByLabelText("当天录音列表")).toHaveTextContent("afternoon.mp3");
    expect(window.localStorage.getItem(LAST_UPLOAD_ID_STORAGE_KEY)).toBe("day_2026-06-03");
  });

  it("expands the latest server upload into all recordings from the same day on first restore", async () => {
    const morningPayload = buildPayload("upload_morning", "ready", {
      upload: {
        id: "upload_morning",
        originalName: "morning.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 2048,
        recordingDate: "2026-06-03",
        createdAt: "2026-06-03T01:00:00.000Z",
        durationSeconds: 60,
        status: "ready"
      },
      briefItems: [
        {
          id: "brief_server_morning",
          uploadId: "upload_morning",
          category: "decision",
          title: "服务器上午结论",
          body: "上午确认了上线节奏。",
          priority: "high",
          confidence: 0.9,
          status: "confirmed",
          sourceSegmentIds: ["seg_server_morning"],
          sourceTimeRange: { startSeconds: 10, endSeconds: 20 },
          transcriptExcerpt: "上午确认上线节奏。",
          people: [],
          topics: ["上线"]
        }
      ]
    });
    const eveningPayload = buildPayload("upload_evening", "ready", {
      upload: {
        id: "upload_evening",
        originalName: "evening.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 4096,
        recordingDate: "2026-06-03",
        createdAt: "2026-06-03T09:00:00.000Z",
        durationSeconds: 90,
        status: "ready"
      },
      briefItems: [
        {
          id: "brief_server_evening",
          uploadId: "upload_evening",
          category: "task",
          title: "服务器晚间待办",
          body: "晚间需要补齐客户材料。",
          priority: "high",
          confidence: 0.92,
          status: "confirmed",
          sourceSegmentIds: ["seg_server_evening"],
          sourceTimeRange: { startSeconds: 30, endSeconds: 50 },
          transcriptExcerpt: "晚间补齐客户材料。",
          people: ["客户"],
          topics: ["材料"]
        }
      ]
    });
    localAnalysisMocks.readLocalQaHistory.mockReturnValue([
      {
        id: "answer_existing_day",
        uploadId: "day_2026-06-03",
        question: "之前问过什么？",
        answer: "之前已经问过当天重点。",
        citedSegmentIds: ["seg_server_morning"],
        createdAt: "2026-06-03T09:50:00.000Z"
      }
    ]);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse({ qaPromptPresetId: "date" }));
      }

      if (url === "/api/uploads/latest") {
        return Promise.resolve(latestUploadResponse("upload_evening"));
      }

      if (url === "/api/uploads/by-date?date=2026-06-03") {
        return Promise.resolve(uploadsByDateResponse("2026-06-03", ["upload_morning", "upload_evening"]));
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse(["2026-06-03"]));
      }

      if (url === "/api/days/upload_morning") {
        return Promise.resolve(jsonResponse(morningPayload));
      }

      if (url === "/api/days/upload_evening") {
        return Promise.resolve(jsonResponse(eveningPayload));
      }

      if ((url === "/api/uploads/upload_morning" || url === "/api/uploads/upload_evening") && init?.method === "DELETE") {
        return Promise.resolve(jsonResponse({ deleted: true }));
      }

      if (url === "/api/days/context/qa" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          question?: string;
          conversation?: Array<{ role: string; content: string }>;
        };

        if (body.question === "继续") {
          expect(body.conversation).toEqual([
            { role: "user", content: "这一天有什么重点？" },
            { role: "assistant", content: "这一天上午确认上线节奏，晚间要补齐客户材料。" }
          ]);

          return Promise.resolve(
            jsonResponse({
              id: "answer_day_context_followup",
              uploadId: "day_2026-06-03",
              question: "继续",
              answer: "继续看，晚间材料是下一步重点。",
              citedSegmentIds: ["seg_server_evening"],
              createdAt: "2026-06-03T10:02:00.000Z"
            })
          );
        }

        return Promise.resolve(
          jsonResponse({
            id: "answer_day_context",
            uploadId: "day_2026-06-03",
            question: "这一天有什么重点？",
            answer: "这一天上午确认上线节奏，晚间要补齐客户材料。",
            citedSegmentIds: ["seg_server_morning", "seg_server_evening"],
            createdAt: "2026-06-03T10:00:00.000Z"
          })
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("服务器上午结论")).toBeInTheDocument();
    });
    expect(screen.getByText("服务器晚间待办")).toBeInTheDocument();
    expect(screen.getByLabelText("当天录音列表")).toHaveTextContent("2 段录音合并查看");
    expect(window.localStorage.getItem(LAST_UPLOAD_ID_STORAGE_KEY)).toBe("day_2026-06-03");

    fireEvent.click(screen.getAllByRole("button", { name: /问答/ })[0]);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "问问这一天" })).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByLabelText("AI 问答角色")).toHaveValue("date");
    });
    expect(screen.getByText("之前已经问过当天重点。")).toBeInTheDocument();

    const questionBox = screen.getByLabelText("问题");
    fireEvent.change(questionBox, { target: { value: "这一天有什么重点？" } });
    fireEvent.keyDown(questionBox, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) => String(url) === "/api/days/context/qa" && init?.method === "POST")).toBe(true);
    });
    const contextQaCall = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/days/context/qa" && init?.method === "POST");
    const contextQaBody = JSON.parse(String(contextQaCall?.[1]?.body)) as {
      uploadId?: string;
      question?: string;
      briefItems?: BriefItem[];
      conversation?: Array<{ role: string; content: string }>;
      promptPresetId?: string;
      customPrompt?: string;
    };
    expect(contextQaBody.uploadId).toBe("day_2026-06-03");
    expect(contextQaBody.question).toBe("这一天有什么重点？");
    expect(contextQaBody.promptPresetId).toBe("date");
    expect(contextQaBody.customPrompt).toBe("");
    expect(contextQaBody.briefItems?.map((item) => item.id)).toEqual(["brief_server_morning", "brief_server_evening"]);
    expect(contextQaBody.conversation).toBeUndefined();
    expect(localAnalysisMocks.readLocalQaHistory).toHaveBeenCalledWith("day_2026-06-03");
    expect(localAnalysisMocks.appendLocalQaHistory).toHaveBeenCalledWith(
      "day_2026-06-03",
      expect.objectContaining({
        id: "answer_day_context",
        question: "这一天有什么重点？",
        answer: "这一天上午确认上线节奏，晚间要补齐客户材料。",
        citedSegmentIds: ["seg_server_morning", "seg_server_evening"]
      })
    );

    fireEvent.change(questionBox, { target: { value: "继续" } });
    fireEvent.keyDown(questionBox, { key: "Enter", code: "Enter" });
    expect(await screen.findByText("继续看，晚间材料是下一步重点。")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/days/day_2026-06-03/qa")).toBe(false);
  });

  it("shows an empty current QA state when a ready recording has no usable evidence", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/latest") {
        return Promise.resolve(latestUploadResponse("upload_empty_ready"));
      }

      if (url === "/api/days/upload_empty_ready") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_empty_ready", "ready", {
              upload: {
                id: "upload_empty_ready",
                originalName: "empty-ready.m4a",
                mimeType: "audio/m4a",
                sizeBytes: 1024,
                recordingDate: "2026-06-04",
                status: "ready"
              },
              segments: [],
              semanticSegments: [],
              briefItems: []
            })
          )
        );
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse([]));
      }

      if (url === "/api/days/context/qa" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ error: "qa_context_empty" }, { ok: false, status: 404 }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("录音复盘已完成")).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole("button", { name: /问答/ })[0]);

    expect(await screen.findByRole("heading", { name: "这一天还没有可用于问答的录音" })).toBeInTheDocument();
    expect(screen.getByLabelText("问题")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "提问" }));

    expect(fetchMock.mock.calls.some(([url, init]) => String(url) === "/api/days/context/qa" && init?.method === "POST")).toBe(false);
    expect(screen.queryByText(/这次没有答出来/)).not.toBeInTheDocument();
  });

  it("deletes the real upload when a stored day view now contains only one recording", async () => {
    window.localStorage.setItem(LAST_UPLOAD_ID_STORAGE_KEY, "day_2026-06-03");
    const singlePayload = buildPayload("upload_single", "ready", {
      upload: {
        id: "upload_single",
        originalName: "single.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 2048,
        recordingDate: "2026-06-03",
        createdAt: "2026-06-03T01:00:00.000Z",
        durationSeconds: 60,
        status: "ready"
      },
      briefItems: [
        {
          id: "brief_single",
          uploadId: "upload_single",
          category: "decision",
          title: "只剩一段的结论",
          body: "当天只剩一段真实录音。",
          priority: "high",
          confidence: 0.9,
          status: "confirmed",
          sourceSegmentIds: ["seg_single"],
          sourceTimeRange: { startSeconds: 10, endSeconds: 20 },
          transcriptExcerpt: "只剩一段真实录音。",
          people: [],
          topics: []
        }
      ]
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/by-date?date=2026-06-03") {
        return Promise.resolve(uploadsByDateResponse("2026-06-03", ["upload_single"]));
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse(["2026-06-03"]));
      }

      if (url === "/api/days/upload_single") {
        return Promise.resolve(jsonResponse(singlePayload));
      }

      if (url === "/api/uploads/upload_single" && init?.method === "DELETE") {
        return Promise.resolve(jsonResponse({ deleted: true }));
      }

      if (url === "/api/uploads/day_2026-06-03" && init?.method === "DELETE") {
        return Promise.resolve(jsonResponse({ error: "wrong_upload_id" }, { ok: false, status: 404 }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("只剩一段的结论")).toBeInTheDocument();
    });
    expect(window.localStorage.getItem(LAST_UPLOAD_ID_STORAGE_KEY)).toBe("upload_single");

    fireEvent.click(screen.getByRole("button", { name: "删除本次上传" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/uploads/upload_single",
        expect.objectContaining({
          method: "DELETE"
        })
      );
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/uploads/day_2026-06-03",
      expect.objectContaining({
        method: "DELETE"
      })
    );
    expect(localAnalysisMocks.clearLocalQaHistory).toHaveBeenCalledWith("day_2026-06-03");
    expect(localAnalysisMocks.clearLocalQaHistory).toHaveBeenCalledWith("upload_single");
  });

  it("preloads recording dates before the calendar is opened", async () => {
    window.localStorage.setItem(LAST_UPLOAD_ID_STORAGE_KEY, "upload_4");
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/days/upload_4") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_4", "ready", {
              upload: {
                id: "upload_4",
                originalName: "upload_4.m4a",
                mimeType: "audio/m4a",
                sizeBytes: 1024,
                recordingDate: "2026-06-04",
                status: "ready"
              }
            })
          )
        );
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse(["2026-06-04", "2026-06-05"]));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("录音复盘已完成")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(countFetchCallsTo(fetchMock, "/api/uploads/dates")).toBe(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "查看日期" }));

    expect(screen.getByRole("button", { name: "2026-06-05 有日记" })).toBeInTheDocument();
  });

  it("shows a date lookup state while another day is being resolved", async () => {
    window.localStorage.setItem(LAST_UPLOAD_ID_STORAGE_KEY, "upload_4");
    const selectedDateLookup = deferredResponse();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/days/upload_4") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_4", "ready", {
              upload: {
                id: "upload_4",
                originalName: "upload_4.m4a",
                mimeType: "audio/m4a",
                sizeBytes: 1024,
                recordingDate: "2026-06-04",
                status: "ready"
              }
            })
          )
        );
      }

      if (url === "/api/uploads/by-date?date=2026-06-03") {
        return selectedDateLookup.promise;
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse(["2026-06-03", "2026-06-04"]));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("录音复盘已完成")).toBeInTheDocument();
    });

    await selectCalendarDate("2026-06-03");

    expect(screen.getByRole("heading", { name: "正在查找这一天的录音" })).toBeInTheDocument();
    expect(screen.queryByText("还没有选择录音")).not.toBeInTheDocument();
    expect(screen.queryByText("上传录音后，这里会成为你的工作台。")).not.toBeInTheDocument();
  });

  it("uses transcript segment ranges as the ready recording duration fallback", async () => {
    window.localStorage.setItem(LAST_UPLOAD_ID_STORAGE_KEY, "upload_4");
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/days/upload_4") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_4", "ready", {
              upload: {
                id: "upload_4",
                originalName: "upload_4.m4a",
                mimeType: "audio/m4a",
                sizeBytes: 1024,
                recordingDate: "2026-06-04",
                status: "ready"
              },
              segments: [
                {
                  id: "seg_duration",
                  uploadId: "upload_4",
                  startSeconds: 3600,
                  endSeconds: 4260,
                  text: "最后一段转写。",
                  confidence: 0.9,
                  speaker: "speaker_1",
                  sceneLabels: [],
                  valueLabels: []
                }
              ]
            })
          )
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByLabelText("处理状态")).toHaveTextContent("1h 11m");
    });
    expect(screen.getByLabelText("处理状态")).not.toHaveTextContent("待识别");
  });

  it("labels the current recording QA scope with the selected date instead of always today", async () => {
    window.localStorage.setItem(LAST_UPLOAD_ID_STORAGE_KEY, "upload_4");
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/days/upload_4") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_4", "ready", {
              upload: {
                id: "upload_4",
                originalName: "upload_4.m4a",
                mimeType: "audio/m4a",
                sizeBytes: 1024,
                recordingDate: "2026-06-04",
                status: "ready"
              }
            })
          )
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("录音复盘已完成")).toBeInTheDocument();
    });

    const qaScopeGroup = screen.getByRole("group", { name: "问答范围" });
    const currentScope = within(qaScopeGroup).getByRole("button", { name: /当前录音/ });

    expect(currentScope).toHaveTextContent("6/4");
    expect(currentScope).not.toHaveTextContent("今天");
  });

  it("marks calendar dates that already have diary entries", async () => {
    window.localStorage.setItem(LAST_UPLOAD_ID_STORAGE_KEY, "upload_4");
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/days/upload_4") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_4", "ready", {
              upload: {
                id: "upload_4",
                originalName: "upload_4.m4a",
                mimeType: "audio/m4a",
                sizeBytes: 1024,
                recordingDate: "2026-06-04",
                status: "ready"
              }
            })
          )
        );
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse(["2026-06-03", "2026-06-04"]));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("录音复盘已完成")).toBeInTheDocument();
    });

    await openCalendar();

    expect(screen.getByLabelText("2026-06-03 有日记")).toBeInTheDocument();
    expect(screen.getByLabelText("2026-06-04 有日记")).toBeInTheDocument();
    expect(screen.getByLabelText("2026-06-05 无日记")).toBeInTheDocument();
    expect(screen.getAllByTitle("这一天有日记")).toHaveLength(2);
  });

  it("clears the workspace when the selected date has no upload", async () => {
    window.localStorage.setItem(LAST_UPLOAD_ID_STORAGE_KEY, "upload_4");
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/days/upload_4") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_4", "ready", {
              upload: {
                id: "upload_4",
                originalName: "upload_4.m4a",
                mimeType: "audio/m4a",
                sizeBytes: 1024,
                recordingDate: "2026-06-04",
                status: "ready"
              },
              briefItems: [
                {
                  id: "brief_existing",
                  uploadId: "upload_4",
                  category: "decision",
                  title: "已有日期的内容",
                  body: "切换到空日期后不应继续显示。",
                  priority: "high",
                  confidence: 0.9,
                  status: "confirmed",
                  sourceSegmentIds: ["seg_existing"],
                  sourceTimeRange: { startSeconds: 10, endSeconds: 20 },
                  transcriptExcerpt: "已有内容",
                  people: [],
                  topics: []
                }
              ]
            })
          )
        );
      }

      if (url === "/api/uploads/by-date?date=2026-06-02") {
        return Promise.resolve(uploadByDateResponse("2026-06-02", null));
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse(["2026-06-04"]));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("已有日期的内容")).toBeInTheDocument();
    });

    await selectCalendarDate("2026-06-02", false);

    await waitFor(() => {
      expect(screen.getByText("这一天没有可查看的录音")).toBeInTheDocument();
    });
    expect(screen.queryByText("已有日期的内容")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(LAST_UPLOAD_ID_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(SELECTED_RECORDING_DATE_STORAGE_KEY)).toBe("2026-06-02");
  });

  it("restores a manually selected empty date after refresh instead of jumping to the latest upload", async () => {
    window.localStorage.setItem(SELECTED_RECORDING_DATE_STORAGE_KEY, "2026-06-08");
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/by-date?date=2026-06-08") {
        return Promise.resolve(uploadByDateResponse("2026-06-08", null));
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse(["2026-06-06"]));
      }

      if (url === "/api/uploads/latest") {
        return Promise.resolve(latestUploadResponse("upload_6"));
      }

      if (url === "/api/days/upload_6") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_6", "ready", {
              upload: {
                id: "upload_6",
                originalName: "upload_6.m4a",
                mimeType: "audio/m4a",
                sizeBytes: 1024,
                recordingDate: "2026-06-06",
                status: "ready"
              },
              briefItems: [
                {
                  id: "brief_latest_should_not_show",
                  uploadId: "upload_6",
                  category: "decision",
                  title: "两天前的复盘",
                  body: "刷新空日期时不应该跳回这里。",
                  priority: "high",
                  confidence: 0.9,
                  status: "confirmed",
                  sourceSegmentIds: ["seg_latest_should_not_show"],
                  sourceTimeRange: { startSeconds: 10, endSeconds: 20 },
                  transcriptExcerpt: "两天前的内容",
                  people: [],
                  topics: []
                }
              ]
            })
          )
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("这一天没有可查看的录音")).toBeInTheDocument();
    });

    expect(screen.getByText("2026 年 6 月 8 日 暂无处理完成或正在处理的录音。你可以切换到其他日期，或上传这一天的录音。")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/uploads/by-date?date=2026-06-08", expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith("/api/uploads/latest", expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith("/api/days/upload_6", expect.anything());
    expect(screen.queryByText("两天前的复盘")).not.toBeInTheDocument();
  });

  it("nests memory scopes under QA and opens all-memory question answering", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/latest") {
        return Promise.resolve(latestUploadResponse(null));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/uploads/latest", expect.anything());
    });

    expect(screen.queryByText("历史记忆")).not.toBeInTheDocument();
    expect(screen.queryByText("记忆范围")).not.toBeInTheDocument();
    const qaScopeGroup = screen.getByRole("group", { name: "问答范围" });
    expect(qaScopeGroup).toHaveTextContent("当前录音");
    expect(qaScopeGroup).toHaveTextContent("本周范围");
    expect(qaScopeGroup).toHaveTextContent("全部记忆");
    const weekButton = within(qaScopeGroup).getByRole("button", { name: /本周范围/ });
    const allButton = within(qaScopeGroup).getByRole("button", { name: /全部记忆/ });
    expect(weekButton).not.toBeDisabled();
    expect(allButton).not.toBeDisabled();

    fireEvent.click(weekButton);

    expect(await screen.findByText("这一周还没有可用于问答的录音")).toBeInTheDocument();
    expect(screen.getByLabelText("当前数据范围")).toHaveTextContent("本周范围");

    fireEvent.click(allButton);

    expect(await screen.findByText("还没有可用于问答的录音")).toBeInTheDocument();
    expect(screen.getByLabelText("当前数据范围")).toHaveTextContent("全部记忆");
  });

  it("shows an empty QA state and prevents sending when the selected week has no recordings", async () => {
    window.localStorage.setItem(SELECTED_RECORDING_DATE_STORAGE_KEY, "2026-06-03");
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/by-date?date=2026-06-03") {
        return Promise.resolve(uploadByDateResponse("2026-06-03", null));
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse(["2026-05-27"]));
      }

      if (url === "/api/memory/week/qa?referenceDate=2026-06-03" && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            answers: [
              {
                id: "answer_old_week",
                question: "旧问题",
                answer: "旧的一周历史不应该显示。",
                citedSegmentIds: ["seg_old"],
                createdAt: "2026-05-27T10:00:00.000Z"
              }
            ]
          })
        );
      }

      if (url === "/api/memory/week/qa?referenceDate=2026-06-03" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ error: "no_ready_uploads" }, { ok: false, status: 404 }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("这一天没有可查看的录音")).toBeInTheDocument();
    });

    fireEvent.click(within(screen.getByRole("group", { name: "问答范围" })).getByRole("button", { name: /本周范围/ }));

    expect(await screen.findByRole("heading", { name: "这一周还没有可用于问答的录音" })).toBeInTheDocument();
    expect(screen.getByText("2026 年 6 月 1 日 至 2026 年 6 月 7 日 暂无处理完成的录音，上传本周录音后就可以提问。")).toBeInTheDocument();
    expect(screen.queryByText("旧的一周历史不应该显示。")).not.toBeInTheDocument();
    expect(screen.queryByText(/这次没有答出来/)).not.toBeInTheDocument();

    const questionBox = screen.getByLabelText("问题");
    expect(questionBox).toBeDisabled();
    expect(questionBox).toHaveAttribute("placeholder", "本周还没有录音，上传后再问");

    fireEvent.change(questionBox, { target: { value: "这周有什么重点？" } });
    fireEvent.keyDown(questionBox, { key: "Enter", code: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));

    expect(fetchMock.mock.calls.some(([url, init]) => String(url) === "/api/memory/week/qa?referenceDate=2026-06-03" && init?.method === "POST")).toBe(false);
  });

  it("does not fall back to server week QA in local-first mode when no browser context exists", async () => {
    window.localStorage.setItem(SELECTED_RECORDING_DATE_STORAGE_KEY, "2026-06-10");
    window.localStorage.setItem(LOCAL_OPENROUTER_API_KEY_STORAGE_KEY, "sk-or-user");
    localAnalysisMocks.listLocalDayIndex.mockReturnValue([]);
    localAnalysisMocks.readLocalDayPayload.mockReturnValue(null);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/by-date?date=2026-06-10") {
        return Promise.resolve(uploadByDateResponse("2026-06-10", null));
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse(["2026-06-10"]));
      }

      if (url.startsWith("/api/memory/week/qa")) {
        throw new Error("Local-first mode must not call server week QA without browser context.");
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("这一天没有可查看的录音")).toBeInTheDocument();
    });

    fireEvent.click(within(screen.getByRole("group", { name: "问答范围" })).getByRole("button", { name: /本周范围/ }));

    expect(await screen.findByRole("heading", { name: "这一周还没有可用于问答的录音" })).toBeInTheDocument();
    expect(screen.getByLabelText("问题")).toBeDisabled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/memory/week/qa"))).toBe(false);
  });

  it("keeps week QA disabled when the selected week only has processing recordings", async () => {
    window.localStorage.setItem(SELECTED_RECORDING_DATE_STORAGE_KEY, "2026-06-03");
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/by-date?date=2026-06-03") {
        return Promise.resolve(uploadByDateResponse("2026-06-03", "upload_processing"));
      }

      if (url === "/api/days/upload_processing") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_processing", "transcribing", {
              upload: {
                id: "upload_processing",
                originalName: "processing.m4a",
                mimeType: "audio/m4a",
                sizeBytes: 1024,
                recordingDate: "2026-06-03",
                status: "transcribing"
              }
            })
          )
        );
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse([]));
      }

      if (url === "/api/memory/week/qa?referenceDate=2026-06-03") {
        return Promise.resolve(jsonResponse({ error: "week_memory_not_found" }, { ok: false, status: 404 }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await screen.findByText("录音处理中，正式结果将在提取完成后展示。");
    fireEvent.click(within(screen.getByRole("group", { name: "问答范围" })).getByRole("button", { name: /本周范围/ }));

    expect(await screen.findByRole("heading", { name: "这一周还没有可用于问答的录音" })).toBeInTheDocument();
    expect(screen.getByLabelText("问题")).toBeDisabled();
    expect(screen.queryByText(/这次没有答出来/)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url, init]) => String(url) === "/api/memory/week/qa?referenceDate=2026-06-03" && init?.method === "POST")).toBe(false);
  });

  it("uses the selected calendar date when opening week-scope question answering", async () => {
    window.localStorage.setItem(LAST_UPLOAD_ID_STORAGE_KEY, "upload_4");
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/days/upload_4") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_4", "ready", {
              upload: {
                id: "upload_4",
                originalName: "upload_4.m4a",
                mimeType: "audio/m4a",
                sizeBytes: 1024,
                recordingDate: "2026-06-04",
                status: "ready"
              }
            })
          )
        );
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse(["2026-06-03", "2026-06-04"]));
      }

      if (url === "/api/uploads/by-date?date=2026-06-03") {
        return Promise.resolve(uploadByDateResponse("2026-06-03", "upload_3"));
      }

      if (url === "/api/days/upload_3") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_3", "ready", {
              upload: {
                id: "upload_3",
                originalName: "upload_3.m4a",
                mimeType: "audio/m4a",
                sizeBytes: 1024,
                recordingDate: "2026-06-03",
                status: "ready"
              }
            })
          )
        );
      }

      if (url === "/api/memory/week/qa?referenceDate=2026-06-03") {
        return Promise.resolve(jsonResponse({ answers: [] }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("录音复盘已完成")).toBeInTheDocument();
    });

    await selectCalendarDate("2026-06-03");
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/days/upload_3", expect.anything());
    });

    const qaScopeGroup = screen.getByRole("group", { name: "问答范围" });
    fireEvent.click(within(qaScopeGroup).getByRole("button", { name: /本周范围/ }));

    expect(await screen.findByText("问问这一周")).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/memory/week/qa?referenceDate=2026-06-03", expect.objectContaining({ cache: "no-store" }));
    });
  });

  it("answers week-scope questions with browser local context including scoped speaker aliases", async () => {
    window.localStorage.setItem(SELECTED_RECORDING_DATE_STORAGE_KEY, "2026-06-10");
    const localPayload = buildPayload("local_week", "ready", {
      upload: {
        id: "local_week",
        originalName: "week.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 2048,
        recordingDate: "2026-06-10",
        createdAt: "2026-06-10T09:00:00.000Z",
        status: "ready"
      },
      segments: [
        {
          id: "local_week_seg_1",
          uploadId: "local_week",
          startSeconds: 0,
          endSeconds: 45,
          speaker: "speaker_1",
          text: "speaker_1 说下周还可以再约，语气挺轻松。",
          confidence: 0.92,
          sceneLabels: ["self_reflection"],
          valueLabels: ["idea"]
        }
      ],
      audioInsights: [
        {
          id: "local_week_audio_1",
          uploadId: "local_week",
          sourceSegmentIds: ["local_week_seg_1"],
          sourceTimeRange: { startSeconds: 0, endSeconds: 45 },
          speaker: { id: "speaker_1", role: "unknown", confidence: 0.4 },
          voice: { pace: "normal", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.35 },
          toneLabels: ["playful"],
          emotionLabels: ["relaxed"],
          interactionLabels: ["rapport"],
          summary: "speaker_1 互动氛围轻松，有继续见面的信号。",
          evidence: "speaker_1 说下周还可以再约，语气挺轻松。",
          confidence: 0.58
        }
      ],
      briefItems: [
        {
          id: "brief_local_week",
          uploadId: "local_week",
          category: "idea",
          title: "speaker_1 继续见面",
          body: "speaker_1 释放了继续见面的信号。",
          priority: "medium",
          confidence: 0.82,
          status: "confirmed",
          sourceSegmentIds: ["local_week_seg_1"],
          sourceTimeRange: { startSeconds: 0, endSeconds: 45 },
          transcriptExcerpt: "speaker_1 说下周还可以再约。",
          people: ["speaker_1"],
          topics: ["互动"]
        }
      ],
      relationshipSignals: [
        {
          id: "relationship_signal_local_week_1",
          uploadId: "local_week",
          date: "2026-06-10",
          signalType: "active_listening",
          signalCategory: "positive",
          severity: "low",
          confidence: 0.78,
          summary: "回应里出现了继续了解对方安排的线索。",
          explanation: "这只描述当前互动，不能推出长期关系结论。",
          involvedSpeakers: ["speaker_1"],
          timeRange: { startSeconds: 0, endSeconds: 45 },
          evidenceSegments: [
            {
              segmentId: "local_week_seg_1",
              speaker: "speaker_1",
              startSeconds: 0,
              endSeconds: 45,
              text: "speaker_1 说下周还可以再约，语气挺轻松。"
            }
          ],
          textEvidence: ["下周还可以再约"],
          suggestedReflection: "可以继续观察双方是否会确认具体安排。",
          createdAt: "2026-06-10T10:00:00.000Z"
        }
      ],
      relationshipSignalsAvailable: true,
      speakerAliases: {
        speaker_1: "张三"
      }
    });
    const secondLocalPayload = buildPayload("local_week_second", "ready", {
      upload: {
        id: "local_week_second",
        originalName: "week-second.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 2048,
        recordingDate: "2026-06-11",
        createdAt: "2026-06-11T09:00:00.000Z",
        status: "ready"
      },
      segments: [
        {
          id: "local_week_second_seg_1",
          uploadId: "local_week_second",
          startSeconds: 0,
          endSeconds: 45,
          speaker: "speaker_1",
          text: "speaker_1 说预算要继续确认。",
          confidence: 0.92,
          sceneLabels: ["product_discussion"],
          valueLabels: ["task"]
        }
      ],
      audioInsights: [
        {
          id: "local_week_second_audio_1",
          uploadId: "local_week_second",
          sourceSegmentIds: ["local_week_second_seg_1"],
          sourceTimeRange: { startSeconds: 0, endSeconds: 45 },
          speaker: { id: "speaker_1", role: "unknown", confidence: 0.4 },
          voice: { pace: "normal", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.35 },
          toneLabels: ["firm"],
          emotionLabels: ["neutral"],
          interactionLabels: ["decision_moment"],
          summary: "speaker_1 明确要求继续确认预算。",
          evidence: "speaker_1 说预算要继续确认。",
          confidence: 0.58
        }
      ],
      briefItems: [
        {
          id: "brief_local_week_second",
          uploadId: "local_week_second",
          category: "task",
          title: "speaker_1 确认预算",
          body: "speaker_1 要继续确认预算。",
          priority: "high",
          confidence: 0.86,
          status: "confirmed",
          sourceSegmentIds: ["local_week_second_seg_1"],
          sourceTimeRange: { startSeconds: 0, endSeconds: 45 },
          transcriptExcerpt: "speaker_1 说预算要继续确认。",
          people: ["speaker_1"],
          topics: ["预算"]
        }
      ],
      speakerAliases: {
        speaker_1: "李四"
      }
    });
    localAnalysisMocks.listLocalDayIndex.mockReturnValue([
      {
        uploadId: "local_week",
        recordingDate: "2026-06-10",
        originalName: "week.mp3",
        createdAt: "2026-06-10T09:00:00.000Z"
      },
      {
        uploadId: "local_week_second",
        recordingDate: "2026-06-11",
        originalName: "week-second.mp3",
        createdAt: "2026-06-11T09:00:00.000Z"
      }
    ]);
    localAnalysisMocks.readLocalDayPayload.mockImplementation((uploadId: string) => {
      if (uploadId === "local_week") {
        return localPayload;
      }
      if (uploadId === "local_week_second") {
        return secondLocalPayload;
      }
      return null;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse({ qaPromptPresetId: "date" }));
      }

      if (url === "/api/uploads/by-date?date=2026-06-10") {
        return Promise.resolve(uploadByDateResponse("2026-06-10", null));
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse([]));
      }

      if (url === "/api/days/context/qa" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          uploadId?: string;
          scope?: string;
          question?: string;
          segments?: TranscriptSegment[];
          audioInsights?: AudioInsight[];
          briefItems?: BriefItem[];
          relationshipSignals?: RelationshipSignalCard[];
          promptPresetId?: string;
        };

        expect(body.uploadId).toBe("week_2026-06-08_2026-06-14");
        expect(body.scope).toBe("week");
        expect(body.question).toBe("这周互动氛围怎么样？");
        expect(body.promptPresetId).toBe("date");
        expect(body.segments?.map((segment) => segment.speaker)).toEqual(["speaker_1", "speaker_1"]);
        expect(body.audioInsights).toHaveLength(2);
        expect(body.audioInsights?.map((insight) => insight.speaker.displayName)).toEqual(["张三", "李四"]);
        expect(body.audioInsights?.map((insight) => insight.summary).join(" ")).toContain("张三");
        expect(body.audioInsights?.map((insight) => insight.summary).join(" ")).toContain("李四");
        expect(body.audioInsights?.map((insight) => insight.summary).join(" ")).not.toContain("speaker_1");
        expect(body.briefItems?.map((item) => item.people[0])).toEqual(["张三", "李四"]);
        expect(body.briefItems?.map((item) => item.title).join(" ")).not.toContain("speaker_1");
        expect(body.relationshipSignals?.map((card) => card.id)).toEqual(["relationship_signal_local_week_1"]);

        return Promise.resolve(
          jsonResponse({
            id: "answer_week_context",
            uploadId: "week_2026-06-08_2026-06-14",
            question: "这周互动氛围怎么样？",
            answer: "这周的互动氛围偏轻松，对方释放了继续见面的信号。",
            citedSegmentIds: ["local_week_seg_1"],
            createdAt: "2026-06-10T10:00:00.000Z"
          })
        );
      }

      if (url.startsWith("/api/memory/week/qa")) {
        throw new Error("Week QA should use browser local context instead of server memory endpoints.");
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("录音复盘已完成")).toBeInTheDocument();
    });

    fireEvent.click(within(screen.getByRole("group", { name: "问答范围" })).getByRole("button", { name: /本周范围/ }));

    expect(await screen.findByText("问问这一周")).toBeInTheDocument();
    const scopeMeta = screen.getByLabelText("回答范围");
    expect(scopeMeta).toHaveTextContent("本周范围");
    expect(scopeMeta).toHaveTextContent("基于本周已处理录音回答");
    expect(scopeMeta).toHaveTextContent("2 条录音");
    expect(scopeMeta).toHaveTextContent("2026-06-10 至 2026-06-11");
    expect(scopeMeta).toHaveTextContent("约 6 条证据");
    const questionBox = screen.getByLabelText("问题");
    fireEvent.change(questionBox, { target: { value: "这周互动氛围怎么样？" } });
    fireEvent.keyDown(questionBox, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("这周的互动氛围偏轻松，对方释放了继续见面的信号。")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/memory/week/qa"))).toBe(false);
  });

  it("opens local-only storage details from the top bar and saves a user API key only in the browser", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/settings" && init?.method === "POST") {
        return Promise.resolve(
          settingsResponse({
            apiKeyMode: "custom",
            hasCustomApiKey: true,
            activeApiKeySource: "custom"
          })
        );
      }

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/latest") {
        return Promise.resolve(latestUploadResponse());
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "本地数据 / API Key" })).toBeInTheDocument();
    });
    const settingsToggle = screen.getByRole("button", { name: "本地数据 / API Key" });

    expect(settingsToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("数据只保存在本机")).not.toBeInTheDocument();

    fireEvent.click(settingsToggle);

    expect(settingsToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("数据只保存在本机")).toBeInTheDocument();
    expect(screen.getByText("/Users/wangsong/Documents/Long-time Record Analyze/.data")).toBeInTheDocument();
    expect(screen.getByText("不会上传到我们的云")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "使用我的 OpenRouter Key" }));
    fireEvent.change(screen.getByLabelText("OpenRouter API Key"), {
      target: { value: "sk-or-user" }
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => {
      expect(screen.getAllByText("正在使用你的 OpenRouter Key").length).toBeGreaterThan(0);
    });
    expect(window.localStorage.getItem(LOCAL_OPENROUTER_API_KEY_STORAGE_KEY)).toBe("sk-or-user");
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("sk-or-user")
      })
    );
  });

  it("uses browser-side local analysis instead of uploading audio when a user API key is stored", async () => {
    window.localStorage.setItem(LOCAL_OPENROUTER_API_KEY_STORAGE_KEY, "sk-or-user");
    const localPayload = buildPayload("local_test", "ready", {
      upload: {
        id: "local_test",
        originalName: "local-meeting.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 5,
        recordingDate: "2026-06-09",
        status: "ready"
      }
    });
    localAnalysisMocks.analyzeAudioLocally.mockResolvedValue(localPayload);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/latest") {
        return Promise.resolve(latestUploadResponse());
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse([]));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "本地数据 / API Key" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole("button", { name: "上传录音" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "local-analyze" }));

    await waitFor(() => {
      expect(localAnalysisMocks.analyzeAudioLocally).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: "sk-or-user",
          recordingDate: "2026-06-09"
        })
      );
    });
    expect(localAnalysisMocks.saveLocalDayPayload).toHaveBeenCalledWith(localPayload);
    expect(screen.getByText("录音复盘已完成")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/uploads", expect.anything());
  });

  it("caches ready online-service results in the browser and cleans the server upload record", async () => {
    const readyPayload = buildPayload("upload_online", "ready");
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(
          settingsResponse({
            storageMode: "server",
            canOpenDataFolder: false
          })
        );
      }

      if (url === "/api/uploads/latest") {
        return Promise.resolve(latestUploadResponse("upload_online"));
      }

      if (url === "/api/uploads/dates") {
        return Promise.resolve(uploadDatesResponse(["2026-06-04"]));
      }

      if (url === "/api/days/upload_online") {
        return Promise.resolve(jsonResponse(readyPayload));
      }

      if (url === "/api/uploads/upload_online" && init?.method === "DELETE") {
        return Promise.resolve(jsonResponse({ deleted: true }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(localAnalysisMocks.saveLocalDayPayload).toHaveBeenCalledWith(
        expect.objectContaining({
          upload: readyPayload.upload,
          job: readyPayload.job,
          segments: readyPayload.segments,
          briefItems: readyPayload.briefItems
        })
      );
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/uploads/upload_online",
      expect.objectContaining({
        method: "DELETE"
      })
    );
  });

  it("shows server storage wording for internal online validation", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(
          settingsResponse({
            storageMode: "server",
            canOpenDataFolder: false,
            dataDirectory: "/var/data/daily-brief",
            uploadsDirectory: "/var/data/daily-brief/uploads",
            apiKeyStoragePath: "/var/data/daily-brief/settings/provider-config.json"
          })
        );
      }

      if (url === "/api/uploads/latest") {
        return Promise.resolve(latestUploadResponse());
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    const settingsToggle = await screen.findByRole("button", { name: "在线服务 / API Key" });
    fireEvent.click(settingsToggle);

    expect(screen.getByText("在线服务模式：服务器只临时处理")).toBeInTheDocument();
    expect(screen.getByText(/处理完成后原始录音会删除/)).toBeInTheDocument();
    expect(screen.queryByText("服务端数据目录")).not.toBeInTheDocument();
    expect(screen.queryByText("/var/data/daily-brief")).not.toBeInTheDocument();
    expect(screen.queryByText("服务端录音目录")).not.toBeInTheDocument();
    expect(screen.queryByText("/var/data/daily-brief/uploads")).not.toBeInTheDocument();
    expect(screen.queryByText(/默认服务 Key 保存在当前验证服务器配置文件/)).not.toBeInTheDocument();
    expect(screen.queryByText("/var/data/daily-brief/settings/provider-config.json")).not.toBeInTheDocument();
    expect(screen.queryByText("线上验证环境不能从网页直接打开服务端目录，请在部署服务器或持久化卷中查看。")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开本地数据文件夹" })).not.toBeInTheDocument();
  });

  it("does not start concurrent polling requests while a day request is still pending", async () => {
    vi.useFakeTimers();

    const pending = deferredResponse();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/latest") {
        return Promise.resolve(latestUploadResponse());
      }

      if (url === "/api/days/upload_1") {
        return pending.promise;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await triggerMockUpload("upload-1");

    expect(countFetchCallsTo(fetchMock, "/api/days/upload_1")).toBe(1);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(countFetchCallsTo(fetchMock, "/api/days/upload_1")).toBe(1);
    vi.useRealTimers();
  });

  it("ignores stale responses after switching uploads", async () => {
    const upload1 = deferredResponse();
    const upload2 = deferredResponse();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/latest") {
        return Promise.resolve(latestUploadResponse());
      }

      if (url === "/api/days/upload_1") {
        return upload1.promise;
      }

      if (url === "/api/days/upload_2") {
        return upload2.promise;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await triggerMockUpload("upload-1");
    expect(fetchMock).toHaveBeenCalledWith("/api/days/upload_1", expect.anything());

    await triggerMockUpload("upload-2");
    expect(fetchMock).toHaveBeenCalledWith("/api/days/upload_2", expect.anything());

    await act(async () => {
      upload1.resolve(
        jsonResponse(
          buildPayload("upload_1", "ready", {
            briefItems: [
              {
                id: "brief_old",
                uploadId: "upload_1",
                category: "decision",
                title: "旧录音结论",
                body: "不应被渲染回来",
                priority: "high",
                confidence: 0.9,
                status: "confirmed",
                sourceSegmentIds: ["seg_old"],
                sourceTimeRange: { startSeconds: 60, endSeconds: 120 },
                transcriptExcerpt: "旧结论",
                people: [],
                topics: []
              }
            ]
          })
        )
      );
      await Promise.resolve();
    });

    expect(screen.queryByText("旧录音结论")).not.toBeInTheDocument();

    await act(async () => {
      upload2.resolve(
        jsonResponse(
          buildPayload("upload_2", "ready", {
            briefItems: [
              {
                id: "brief_new",
                uploadId: "upload_2",
                category: "task",
                title: "新录音待办",
                body: "应该显示的新结果",
                priority: "high",
                confidence: 0.93,
                status: "confirmed",
                sourceSegmentIds: ["seg_new"],
                sourceTimeRange: { startSeconds: 180, endSeconds: 240 },
                transcriptExcerpt: "新待办",
                people: [],
                topics: []
              }
            ]
          })
        )
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText("新录音待办")).toBeInTheDocument();
    });
    expect(screen.queryByText("旧录音结论")).not.toBeInTheDocument();
  });

  it("ignores stale responses after deleting the active upload", async () => {
    const upload1 = deferredResponse();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/latest") {
        return Promise.resolve(latestUploadResponse());
      }

      if (url === "/api/days/upload_1") {
        return upload1.promise;
      }

      if (url === "/api/uploads/upload_1" && init?.method === "DELETE") {
        return Promise.resolve(jsonResponse({ deleted: true }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await triggerMockUpload("upload-1");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "删除本次上传" }));
      await Promise.resolve();
    });

    await act(async () => {
      upload1.resolve(
        jsonResponse(
          buildPayload("upload_1", "ready", {
            briefItems: [
              {
                id: "brief_deleted",
                uploadId: "upload_1",
                category: "task",
                title: "已删除上传的旧结果",
                body: "不应回写到页面",
                priority: "high",
                confidence: 0.9,
                status: "confirmed",
                sourceSegmentIds: ["seg_deleted"],
                sourceTimeRange: { startSeconds: 60, endSeconds: 120 },
                transcriptExcerpt: "旧结果",
                people: [],
                topics: []
              }
            ]
          })
        )
      );
      await Promise.resolve();
    });

    expect(screen.queryByText("已删除上传的旧结果")).not.toBeInTheDocument();
    expect(screen.getByText("等待上传")).toBeInTheDocument();
    expect(screen.getByText("未建立")).toBeInTheDocument();
  });

  it("resumes polling when delete fails during processing", async () => {
    vi.useFakeTimers();

    const dayResponses = [
      jsonResponse(buildPayload("upload_1", "transcribing")),
      jsonResponse(
        buildPayload("upload_1", "ready", {
          briefItems: [
            {
              id: "brief_resume",
              uploadId: "upload_1",
              category: "task",
              title: "删除失败后继续刷新",
              body: "轮询恢复后拿到的新结果",
              priority: "high",
              confidence: 0.94,
              status: "confirmed",
              sourceSegmentIds: ["seg_resume"],
              sourceTimeRange: { startSeconds: 120, endSeconds: 180 },
              transcriptExcerpt: "继续刷新",
              people: [],
              topics: []
            }
          ]
        })
      )
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/latest") {
        return Promise.resolve(latestUploadResponse());
      }

      if (url === "/api/days/upload_1") {
        const nextResponse = dayResponses.shift();

        if (nextResponse) {
          return Promise.resolve(nextResponse);
        }
      }

      if (url === "/api/uploads/upload_1" && init?.method === "DELETE") {
        return Promise.resolve(jsonResponse({ error: "删除失败" }, { ok: false, status: 500 }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await triggerMockUpload("upload-1");
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("正在整理录音 · 30%")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "删除本次上传" }));
      await Promise.resolve();
    });

    expect(screen.getByText("删除失败")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1200);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(countFetchCallsTo(fetchMock, "/api/days/upload_1")).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith("/api/days/upload_1", expect.anything());
    expect(screen.getByText("删除失败后继续刷新")).toBeInTheDocument();
  });

  it("shows processing state before ready and only mounts results after ready", async () => {
    const dayResponses = [
      jsonResponse(buildPayload("upload_1", "transcribing")),
      jsonResponse(
        buildPayload("upload_1", "ready", {
          segments: [
            {
              id: "seg_1",
              uploadId: "upload_1",
              startSeconds: 420,
              endSeconds: 510,
              speaker: "Founder",
              text: "今晚把 onboarding 草案发给王敏。",
              confidence: 0.95,
              sceneLabels: ["team_management"],
              valueLabels: ["commitment"]
            }
          ],
          briefItems: [
            {
              id: "brief_1",
              uploadId: "upload_1",
              category: "commitment",
              title: "今晚把 onboarding 草案发给王敏",
              body: "承诺今天下班前整理好 onboarding 草案并发送。",
              priority: "high",
              confidence: 0.92,
              status: "confirmed",
              sourceSegmentIds: ["seg_1"],
              sourceTimeRange: { startSeconds: 420, endSeconds: 510 },
              transcriptExcerpt: "我今晚把 onboarding 草案发给王敏。",
              people: ["王敏"],
              topics: ["onboarding"]
            }
          ]
        })
      )
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/latest") {
        return Promise.resolve(latestUploadResponse());
      }

      if (url === "/api/days/upload_1") {
        const nextResponse = dayResponses.shift();

        if (nextResponse) {
          return Promise.resolve(nextResponse);
        }
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await triggerMockUpload("upload-1");

    await waitFor(() => {
      expect(screen.getByText("正在整理录音 · 30%")).toBeInTheDocument();
    });

    expect(screen.queryByText("今天还没有高优先级提要。")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "问问这一天" })).not.toBeInTheDocument();
    expect(screen.getByText("录音处理中，正式结果将在提取完成后展示。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));

    await waitFor(() => {
      expect(screen.getByText("今晚把 onboarding 草案发给王敏")).toBeInTheDocument();
    });

    expect(screen.getAllByText("时间轴").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "问答 AI" }));

    expect(screen.getByRole("heading", { name: "问问这一天" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提问" })).toBeEnabled();
  });

  it("keeps an empty generated semantic timeline from falling back to raw fragments", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === "/api/settings") {
        return Promise.resolve(settingsResponse());
      }

      if (url === "/api/uploads/latest") {
        return Promise.resolve(latestUploadResponse("upload_1"));
      }

      if (url === "/api/days/upload_1") {
        return Promise.resolve(
          jsonResponse(
            buildPayload("upload_1", "ready", {
              segments: [
                {
                  id: "seg_low_value",
                  uploadId: "upload_1",
                  startSeconds: 60,
                  endSeconds: 90,
                  text: "客户合同费用需要重新评估。",
                  confidence: 0.9,
                  sceneLabels: ["customer_call"],
                  valueLabels: ["task"]
                }
              ],
              semanticSegments: [],
              semanticSegmentsAvailable: true
            })
          )
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", withAuthenticatedFetch(fetchMock));

    render(<HomePage />);

    await waitFor(() => {
      expect(screen.getByText("录音复盘已完成")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "时间轴" }));

    expect(screen.getByText("本次没有足够有价值的时间轴内容。")).toBeInTheDocument();
    expect(screen.queryByText("客户合同费用需要重新评估。")).not.toBeInTheDocument();
  });
});
