import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TranscriptSegment } from "@/lib/domain/types";

import {
  createDeepseekAudioInsightProvider,
  DeepseekAudioInsightError
} from "./deepseek-provider";

type CreateResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | Array<{ type?: string; text?: string }> | null };
  }>;
};

type CreateRequest = Record<string, unknown>;

const segments: TranscriptSegment[] = [
  {
    id: "seg_1",
    uploadId: "upload_1",
    startSeconds: 1,
    endSeconds: 8,
    speaker: "speaker_1",
    text: "I hear you. Let us confirm the plan tomorrow.",
    confidence: 0.9,
    sceneLabels: ["self_reflection"],
    valueLabels: ["commitment"]
  }
];

const validResponse = (): CreateResponse => ({
  choices: [
    {
      message: {
        content: JSON.stringify({
          items: [
            {
              sourceSegmentIds: ["seg_1"],
              speaker: { id: "speaker_1", role: "self", confidence: 0.8 },
              voice: {
                pace: "normal",
                volume: "unknown",
                pause: "unknown",
                overlap: false,
                confidence: 0.5
              },
              toneLabels: ["comforting"],
              emotionLabels: ["neutral"],
              interactionLabels: ["agreement"],
              summary: "The speaker acknowledged the other person and proposed a confirmation.",
              evidence: "The cited segment contains acknowledgement and a concrete follow-up.",
              confidence: 0.78
            }
          ]
        })
      }
    }
  ]
});

const snapshot = {
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseUrl: process.env.DEEPSEEK_BASE_URL,
  model: process.env.DEEPSEEK_AUDIO_INSIGHT_MODEL,
  genericModel: process.env.DEEPSEEK_MODEL,
  qaModel: process.env.OPENAI_QA_MODEL,
  timeout: process.env.AUDIO_INSIGHT_TIMEOUT_MS,
  retries: process.env.AUDIO_INSIGHT_MAX_RETRIES,
  maxOutputTokens: process.env.AUDIO_INSIGHT_MAX_OUTPUT_TOKENS
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("createDeepseekAudioInsightProvider", () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "deepseek_test_key";
    process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com";
    process.env.DEEPSEEK_AUDIO_INSIGHT_MODEL = "deepseek-v4-flash";
    process.env.AUDIO_INSIGHT_TIMEOUT_MS = "60000";
    process.env.AUDIO_INSIGHT_MAX_RETRIES = "1";
    process.env.AUDIO_INSIGHT_MAX_OUTPUT_TOKENS = "3200";
  });

  afterEach(() => {
    restore("DEEPSEEK_API_KEY", snapshot.apiKey);
    restore("DEEPSEEK_BASE_URL", snapshot.baseUrl);
    restore("DEEPSEEK_AUDIO_INSIGHT_MODEL", snapshot.model);
    restore("DEEPSEEK_MODEL", snapshot.genericModel);
    restore("OPENAI_QA_MODEL", snapshot.qaModel);
    restore("AUDIO_INSIGHT_TIMEOUT_MS", snapshot.timeout);
    restore("AUDIO_INSIGHT_MAX_RETRIES", snapshot.retries);
    restore("AUDIO_INSIGHT_MAX_OUTPUT_TOKENS", snapshot.maxOutputTokens);
  });

  it("uses one DeepSeek JSON request with an independent model, bounded timeout, and zero retries", async () => {
    process.env.DEEPSEEK_MODEL = "deepseek-v4-pro";
    process.env.OPENAI_QA_MODEL = "gpt-5.5";
    const create = vi.fn<(request: CreateRequest) => Promise<CreateResponse>>().mockResolvedValue(validResponse());
    const clientFactory = vi.fn(() => ({ chat: { completions: { create } } }));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const provider = createDeepseekAudioInsightProvider({ clientFactory, logger, now: () => 1000 });

    const result = await provider.analyze("upload_1", segments);

    expect(result).toHaveLength(1);
    expect(result[0]?.sourceSegmentIds).toEqual(["seg_1"]);
    expect(clientFactory).toHaveBeenCalledWith({
      apiKey: "deepseek_test_key",
      baseURL: "https://api.deepseek.com",
      timeout: 60000,
      maxRetries: 0
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "deepseek-v4-flash",
        stream: false,
        response_format: { type: "json_object" },
        max_tokens: 3200,
        thinking: { type: "disabled" }
      })
    );
    const request = create.mock.calls[0]?.[0];
    const userPrompt = String(
      (request?.messages as Array<{ role?: string; content?: string }> | undefined)?.find(
        (message) => message.role === "user"
      )?.content ?? ""
    );
    expect(userPrompt).toContain('"sourceSegmentIds": [');
    expect(userPrompt).toContain('"seg_1"');
    expect(userPrompt).toContain('"toneLabels": [');
    const completionLog = String(logger.info.mock.calls.at(-1)?.[0]);
    expect(completionLog).toContain("provider=deepseek model=deepseek-v4-flash");
    expect(completionLog).toContain("segments=1");
    expect(completionLog).toContain("completed=true");
  });

  it("keeps valid items when another candidate has an invalid schema", async () => {
    const mixed = validResponse();
    const content = JSON.parse(String(mixed.choices?.[0]?.message?.content));
    content.items.push({ sourceSegmentIds: ["seg_1"], summary: "missing required fields" });
    const create = vi.fn<(request: CreateRequest) => Promise<CreateResponse>>().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(content) } }]
    });
    const provider = createDeepseekAudioInsightProvider({
      clientFactory: vi.fn(() => ({ chat: { completions: { create } } })),
      logger: { info: vi.fn(), warn: vi.fn() }
    });

    await expect(provider.analyze("upload_1", segments)).resolves.toHaveLength(1);
  });

  it("classifies invalid JSON without issuing a second request", async () => {
    const create = vi.fn<(request: CreateRequest) => Promise<CreateResponse>>().mockResolvedValue({
      choices: [{ message: { content: "not json" } }]
    });
    const provider = createDeepseekAudioInsightProvider({
      clientFactory: vi.fn(() => ({ chat: { completions: { create } } })),
      logger: { info: vi.fn(), warn: vi.fn() }
    });

    await expect(provider.analyze("upload_1", segments)).rejects.toMatchObject({
      code: "invalid_json"
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("parses multiple content blocks and conservative trailing-comma cleanup", async () => {
    const content = String(validResponse().choices?.[0]?.message?.content).replace(/}\s*$/, ",}");
    const create = vi.fn<(request: CreateRequest) => Promise<CreateResponse>>().mockResolvedValue({
      choices: [{ message: { content: [{ type: "text", text: "```json\n" }, { type: "text", text: `${content}\n\`\`\`` }] } }]
    });
    const provider = createDeepseekAudioInsightProvider({
      clientFactory: vi.fn(() => ({ chat: { completions: { create } } })),
      logger: { info: vi.fn(), warn: vi.fn() }
    });

    await expect(provider.analyze("upload_1", segments)).resolves.toHaveLength(1);
  });

  it("classifies truncated completion separately from generic invalid JSON", async () => {
    const create = vi.fn<(request: CreateRequest) => Promise<CreateResponse>>().mockResolvedValue({
      choices: [{ finish_reason: "length", message: { content: '{"items":[' } }]
    });
    const provider = createDeepseekAudioInsightProvider({
      clientFactory: vi.fn(() => ({ chat: { completions: { create } } })),
      logger: { info: vi.fn(), warn: vi.fn() }
    });

    await expect(provider.analyze("upload_1", segments)).rejects.toMatchObject({ code: "incomplete_response" });
  });

  it("rejects an item when any cited source segment id is fabricated", async () => {
    const response = validResponse();
    const payload = JSON.parse(String(response.choices?.[0]?.message?.content));
    payload.items[0].sourceSegmentIds.push("invented_segment");
    const create = vi.fn<(request: CreateRequest) => Promise<CreateResponse>>().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(payload) } }]
    });
    const provider = createDeepseekAudioInsightProvider({
      clientFactory: vi.fn(() => ({ chat: { completions: { create } } })),
      logger: { info: vi.fn(), warn: vi.fn() }
    });

    await expect(provider.analyze("upload_1", segments)).rejects.toMatchObject({ code: "invalid_evidence" });
  });

  it("classifies timeouts and never logs the key or transcript", async () => {
    const timeout = new Error("request timed out");
    timeout.name = "APIConnectionTimeoutError";
    const create = vi.fn<(request: CreateRequest) => Promise<CreateResponse>>().mockRejectedValue(timeout);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const provider = createDeepseekAudioInsightProvider({
      clientFactory: vi.fn(() => ({ chat: { completions: { create } } })),
      logger
    });

    await expect(provider.analyze("upload_1", segments)).rejects.toBeInstanceOf(DeepseekAudioInsightError);
    await expect(provider.analyze("upload_1", segments)).rejects.toMatchObject({ code: "timeout" });
    const logs = [...logger.info.mock.calls, ...logger.warn.mock.calls].flat().join("\n");
    expect(logs).not.toContain("deepseek_test_key");
    expect(logs).not.toContain(segments[0]?.text);
  });
});
