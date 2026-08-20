import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import {
  GPT55Provider,
  VLLMQwenProvider,
  isVllmQwenProviderSelected,
  resolveVllmQwenDevelopmentConfig,
  resolveVoiceQaLlmProviderId
} from "./qa-llm-provider";

function fakeClient(create: ReturnType<typeof vi.fn>) {
  return {
    chat: {
      completions: { create }
    }
  } as unknown as OpenAI;
}

function fakeResponsesClient(create: ReturnType<typeof vi.fn>) {
  return {
    responses: { create }
  } as unknown as OpenAI;
}

async function collect(stream: AsyncGenerator<string>) {
  const values: string[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

describe("VLLMQwenProvider", () => {
  it("uses the loopback-only development defaults with thinking disabled", () => {
    expect(resolveVllmQwenDevelopmentConfig({
      NODE_ENV: "development"
    })).toEqual({
      baseUrl: "http://127.0.0.1:8700/v1",
      apiKey: "dummy",
      model: "Qwen/Qwen3.6-27B",
      reasoningEnabled: false
    });
    expect(isVllmQwenProviderSelected({
      NODE_ENV: "development",
      LLM_PROVIDER: "qwen-vllm"
    })).toBe(true);
  });

  it("fails closed in production and rejects a non-loopback endpoint", () => {
    expect(() => resolveVllmQwenDevelopmentConfig({
      NODE_ENV: "production"
    })).toThrow(/development\/evaluation-only/u);
    expect(() => resolveVllmQwenDevelopmentConfig({
      NODE_ENV: "development",
      VLLM_BASE_URL: "https://vllm.example.test/v1"
    })).toThrow(/loopback/u);
  });

  it("allows only an explicit Voice-owned loopback Qwen configuration in production", () => {
    expect(resolveVllmQwenDevelopmentConfig(
      { NODE_ENV: "production" },
      { allowProductionLoopback: true }
    )).toMatchObject({
      baseUrl: "http://127.0.0.1:8700/v1",
      model: "Qwen/Qwen3.6-27B",
      reasoningEnabled: false
    });

    expect(() => resolveVllmQwenDevelopmentConfig({
      NODE_ENV: "production",
      LLM_PROVIDER: "qwen-vllm"
    })).toThrow(/development\/evaluation-only/u);
  });

  it("defaults Voice QA to Qwen while retaining an explicit GPT rollback", () => {
    expect(resolveVoiceQaLlmProviderId({})).toBe("qwen-vllm");
    expect(resolveVoiceQaLlmProviderId({
      VOICE_QA_LLM_PROVIDER: "gpt-5.5"
    })).toBe("gpt-5.5");
    expect(() => resolveVoiceQaLlmProviderId({
      VOICE_QA_LLM_PROVIDER: "other"
    })).toThrow(/VOICE_QA_LLM_PROVIDER/u);
  });

  it("streams chat completions with the Qwen thinking switch and reports token usage", async () => {
    async function* chunks() {
      yield {
        choices: [{ delta: { content: "{\"answer\":\"第一句。[E1]" }, finish_reason: null }]
      };
      yield {
        choices: [{ delta: { content: "\"}" }, finish_reason: "stop" }],
        usage: { completion_tokens: 17, total_tokens: 93 }
      };
    }
    const create = vi.fn().mockResolvedValue(chunks());
    const provider = new VLLMQwenProvider({
      client: fakeClient(create),
      model: "Qwen/Qwen3.6-27B",
      reasoningEnabled: false
    });
    const metrics = vi.fn();

    await expect(collect(provider.answerTextStream("system", "user", metrics)))
      .resolves.toEqual(["{\"answer\":\"第一句。[E1]", "\"}"]);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: "Qwen/Qwen3.6-27B",
      stream: true,
      stream_options: { include_usage: true },
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "user" }
      ]
    }));
    expect(metrics).toHaveBeenCalledWith({
      providerId: "qwen-vllm",
      model: "Qwen/Qwen3.6-27B",
      reasoningEnabled: false,
      outputTokenCount: 17,
      totalTokenCount: 93
    });
  });

  it("sends enable_thinking false explicitly on every request in a five-turn Voice session", async () => {
    const create = vi.fn().mockImplementation(async () => (async function* chunks() {
      yield { choices: [{ delta: { content: "answer" }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: "stop" }] };
    })());
    const provider = new VLLMQwenProvider({
      client: fakeClient(create),
      model: "Qwen/Qwen3.6-27B",
      reasoningEnabled: false
    });

    for (let turn = 1; turn <= 5; turn += 1) {
      await expect(collect(provider.answerTextStream("system", `turn-${turn}`)))
        .resolves.toEqual(["answer"]);
    }

    expect(create).toHaveBeenCalledTimes(5);
    for (const [body] of create.mock.calls) {
      expect(body).toEqual(expect.objectContaining({
        model: "Qwen/Qwen3.6-27B",
        stream: true,
        chat_template_kwargs: { enable_thinking: false }
      }));
    }
  });

});

describe("GPT55Provider", () => {
  it("preserves the existing OpenAI-compatible chat request shape", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: " canonical answer " } }],
      usage: { completion_tokens: 8, total_tokens: 40 }
    });
    const provider = new GPT55Provider({
      client: fakeClient(create),
      model: "gpt-5.5",
      wireApi: "chat",
      logProvider: "openai-compatible"
    });
    const metrics = vi.fn();

    await expect(provider.answerText("system", "user", metrics))
      .resolves.toBe("canonical answer");
    const body = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("chat_template_kwargs");
    expect(body).not.toHaveProperty("stream_options");
    expect(metrics).toHaveBeenCalledWith({
      providerId: "gpt-5.5",
      model: "gpt-5.5",
      reasoningEnabled: null,
      outputTokenCount: 8,
      totalTokenCount: 40
    });
  });

  it("records Responses API usage from the terminal streaming event", async () => {
    async function* events() {
      yield { type: "response.output_text.delta", delta: "answer" };
      yield {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { output_tokens: 12, total_tokens: 52 }
        }
      };
    }
    const create = vi.fn().mockResolvedValue(events());
    const provider = new GPT55Provider({
      client: fakeResponsesClient(create),
      model: "gpt-5.5",
      wireApi: "responses",
      logProvider: "openai-compatible"
    });
    const metrics = vi.fn();

    await expect(collect(provider.answerTextStream("system", "user", metrics)))
      .resolves.toEqual(["answer"]);
    expect(metrics).toHaveBeenCalledWith({
      providerId: "gpt-5.5",
      model: "gpt-5.5",
      reasoningEnabled: null,
      outputTokenCount: 12,
      totalTokenCount: 52
    });
  });
});
