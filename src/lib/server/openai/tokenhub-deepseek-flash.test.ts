// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTokenHubFlashSmoke, summarizeTokenHubFlashSmokeFailure, type FlashSmokeRole } from "../../../../scripts/smoke-tokenhub-flash-providers";
import { createDeepseekAudioInsightProvider } from "../audio-insights/deepseek-provider";
import { flashSmokeSegments } from "../../../../scripts/smoke-tokenhub-flash-providers";
import { flashSmokeContext, flashSmokeMemoryInput } from "../../../../scripts/smoke-tokenhub-flash-providers";
import { createDeepseekProactiveInsightProvider } from "../proactive-insights/deepseek-provider";
import { createDeepseekMemoryRelevanceJudge } from "../memory/relevance/deepseek-judge";

const endpoint = "https://tokenhub.vision-intelligence.tech/v1";
const routes = { audio: "AUDIO_INSIGHT_BASE_URL", proactive: "PROACTIVE_INSIGHT_BASE_URL", memory: "MEMORY_RELEVANCE_BASE_URL" } as const;
const responses = {
  audio: { items: [{ sourceSegmentIds: ["synthetic_segment"], speaker: { id: "speaker_1", role: "unknown", confidence: 0.7 },
    voice: { pace: "normal", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.5 },
    toneLabels: ["explaining"], emotionLabels: ["neutral"], interactionLabels: ["agreement"],
    summary: "The speaker acknowledges a suggestion and proposes checking the sample.",
    evidence: "I hear your suggestion. Let us check the sample together tomorrow.", confidence: 0.7 }] },
  proactive: { items: [{ type: "relationship_question", insightType: "reflection", category: "relationship",
    observation: "A sample check was proposed for tomorrow.", question: "What needs checking in the sample?",
    reason: "The sample check gives a concrete topic to revisit.", evidenceIds: ["brief:synthetic"], memoryRefs: [], confidence: 0.8 }] },
  memory: { results: [{ memoryId: "synthetic_memory", shouldUse: false, relevanceScore: 0.4,
    usefulnessScore: 0.3, reason: "The older sample note adds little to this check." }] }
};

function wireFetch(value: unknown, status = "completed") {
  return vi.fn<typeof fetch>().mockImplementation(async () => new Response(`data: ${JSON.stringify({
    type: `response.${status}`, response: { status, error: null, incomplete_details: status === "completed" ? null : { reason: "max_output_tokens" },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] }] }
  })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
}

beforeEach(() => {
  for (const key of Object.values(routes)) vi.stubEnv(key, "");
  vi.stubEnv("OPENAI_API_KEY", "TOKENHUB_FIXTURE_KEY");
  vi.stubEnv("OPENAI_AUTH_HEADER_MODE", "bearer");
  vi.stubEnv("DEEPSEEK_API_KEY", "OFFICIAL_FIXTURE_KEY");
  vi.stubEnv("DEEPSEEK_BASE_URL", "https://api.deepseek.com");
  vi.stubEnv("DEEPSEEK_MODEL", "deepseek-v4-flash");
  vi.stubEnv("DEEPSEEK_AUDIO_INSIGHT_MODEL", "deepseek-v4-flash");
  vi.stubEnv("MEMORY_RELEVANCE_PROVIDER", "deepseek");
  for (const key of ["AUDIO_INSIGHT_MAX_OUTPUT_TOKENS", "PROACTIVE_INSIGHT_MAX_OUTPUT_TOKENS", "MEMORY_RELEVANCE_MAX_OUTPUT_TOKENS"]) vi.stubEnv(key, "1200");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("TokenHub Flash production adapter transport", () => {
  it.each(Object.keys(routes) as FlashSmokeRole[])("routes only %s through one authenticated Responses request and preserves validation", async (role) => {
    vi.stubEnv(routes[role], endpoint);
    const transport = wireFetch(responses[role]);
    const result = await runTokenHubFlashSmoke(role, transport);
    expect(result).toMatchObject({ role, channel: "tokenhub", model: "deepseek-v4-flash", status: "passed", count: 1 });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0]!;
    expect(String(url)).toBe(`${endpoint}/responses`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer TOKENHUB_FIXTURE_KEY");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "deepseek-v4-flash", stream: true,
      reasoning: { effort: "none" }, max_output_tokens: 1200 });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("thinking");
    const wireInput = JSON.parse(String(init?.body)).input as Array<{ role: string; content: string }>;
    expect(wireInput[0]).toMatchObject({ role: "system" });
    expect(wireInput[0]!.content).toContain(`JSON 根对象必须包含 ${role === "memory" ? "results" : "items"} 字段。`);
    if (role === "memory") expect(JSON.stringify(wireInput)).not.toContain("JSON 根对象必须包含 items 字段。");
    expect(process.env.DEEPSEEK_BASE_URL).toBe("https://api.deepseek.com");
    expect(process.env.DEEPSEEK_API_KEY).toBe("OFFICIAL_FIXTURE_KEY");
    for (const [other, key] of Object.entries(routes)) if (other !== role) expect(process.env[key]).toBe("");
  });

  it.each(Object.keys(routes) as FlashSmokeRole[])("rejects incomplete terminal output for %s without fallback success", async (role) => {
    vi.stubEnv(routes[role], endpoint);
    const transport = wireFetch(responses[role], "incomplete");
    await expect(runTokenHubFlashSmoke(role, transport)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(Object.keys(routes) as FlashSmokeRole[])("rejects invalid source results for %s", async (role) => {
    vi.stubEnv(routes[role], endpoint);
    const raw = JSON.stringify(responses[role]).replaceAll("synthetic_segment", "unrelated_segment")
      .replaceAll("brief:synthetic", "brief:unrelated").replaceAll("synthetic_memory", "unrelated_memory");
    const transport = wireFetch(JSON.parse(raw));
    await expect(runTokenHubFlashSmoke(role, transport)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(Object.keys(routes) as FlashSmokeRole[])("does not retry %s or expose private gateway errors", async (role) => {
    vi.stubEnv(routes[role], endpoint);
    const secret = "PRIVATE_GATEWAY_BODY";
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(secret, { status: 503 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = await runTokenHubFlashSmoke(role, transport).catch((value: unknown) => value);
    expect(failure).toBeInstanceOf(Error); expect(transport).toHaveBeenCalledTimes(1);
    expect(String(failure)).not.toContain(secret);
    expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toMatch(/PRIVATE_GATEWAY_BODY|TOKENHUB_FIXTURE_KEY|OFFICIAL_FIXTURE_KEY/);
  });

  it.each(Object.keys(routes) as FlashSmokeRole[])("rejects invalid output schema for %s", async (role) => {
    vi.stubEnv(routes[role], endpoint);
    const transport = wireFetch({ items: "PRIVATE_INVALID_SHAPE", results: "PRIVATE_INVALID_SHAPE" });
    await expect(runTokenHubFlashSmoke(role, transport)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(["bad_url", "missing_key", "wrong_model", "global_only"])("fails closed in all three adapters for %s without contacting either provider", async (kind) => {
    for (const key of Object.values(routes)) vi.stubEnv(key, kind === "bad_url" ? `${endpoint}?token=PRIVATE_QUERY` : kind === "global_only" ? "" : endpoint);
    if (kind === "missing_key") vi.stubEnv("OPENAI_API_KEY", "");
    if (kind === "wrong_model") {
      vi.stubEnv("DEEPSEEK_MODEL", "deepseek-v4-pro"); vi.stubEnv("DEEPSEEK_AUDIO_INSIGHT_MODEL", "deepseek-v4-pro");
    }
    if (kind === "global_only") vi.stubEnv("DEEPSEEK_BASE_URL", endpoint);
    const transport = wireFetch({}); const clientFactory = vi.fn();
    await expect(createDeepseekAudioInsightProvider({ fetch: transport, clientFactory, logger: { info() {}, warn() {} } })
      .analyze("synthetic_upload", flashSmokeSegments)).rejects.toThrow();
    const proactive = await createDeepseekProactiveInsightProvider({ fetch: transport, clientFactory, logger: { info() {}, warn() {} } })
      .generate({ context: flashSmokeContext });
    const memory = await createDeepseekMemoryRelevanceJudge({ fetch: transport, clientFactory }).judge(flashSmokeMemoryInput);
    expect(proactive.status).toBe("fallback"); expect(memory.status).toBe("fallback");
    expect(transport).not.toHaveBeenCalled(); expect(clientFactory).not.toHaveBeenCalled();
  });

  it("keeps the official adapter selected when the role override is absent", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(responses.audio) } }] });
    const clientFactory = vi.fn(() => ({ chat: { completions: { create } } }));
    const transport = wireFetch(responses.audio);
    await createDeepseekAudioInsightProvider({ clientFactory, fetch: transport, logger: { info() {}, warn() {} } }).analyze("synthetic_upload", flashSmokeSegments);
    expect(clientFactory).toHaveBeenCalledWith(expect.objectContaining({ baseURL: "https://api.deepseek.com", apiKey: "OFFICIAL_FIXTURE_KEY", maxRetries: 0 }));
    expect(create).toHaveBeenCalledTimes(1); expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "terminal", value: responses.memory, terminal: "incomplete", code: "api_error", stage: "memory_transport" },
    { kind: "response_shape", value: { results: "PRIVATE_VALUE" }, terminal: "completed", code: "invalid_schema", stage: "memory_response_schema" },
    { kind: "item_shape", value: { results: [{ ...responses.memory.results[0], caution: null, PRIVATE_FIELD: "PRIVATE_VALUE" }] }, terminal: "completed", code: "invalid_evidence", stage: "memory_result_validation" },
    { kind: "source", value: { results: [{ ...responses.memory.results[0], memoryId: "PRIVATE_WRONG_ID" }] }, terminal: "completed", code: "invalid_evidence", stage: "memory_result_validation" },
    { kind: "empty", value: { results: [] }, terminal: "completed", code: "invalid_evidence", stage: "memory_result_validation" },
    { kind: "unsafe", value: { results: [{ ...responses.memory.results[0], reason: "personality disorder PRIVATE_VALUE" }] }, terminal: "completed", code: "invalid_evidence", stage: "memory_result_validation" }
  ])("keeps a safe Memory diagnostic for $kind", async ({ kind, value, terminal, code, stage }) => {
    vi.stubEnv(routes.memory, endpoint);
    const transport = wireFetch(value, terminal);
    const failure = await runTokenHubFlashSmoke("memory", transport).catch((error: unknown) => error);
    const diagnostic = summarizeTokenHubFlashSmokeFailure(failure);
    expect(diagnostic).toMatchObject({ status: "failed", errorCode: code, diagnostic: { stage } });
    expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE_|TOKENHUB_FIXTURE_KEY|OFFICIAL_FIXTURE_KEY|personality disorder/);
    expect(transport).toHaveBeenCalledTimes(1);
    if (kind === "terminal") expect(diagnostic).toMatchObject({ diagnostic: { transportCode: "incomplete_response" } });
    if (kind === "item_shape") expect(diagnostic).toMatchObject({ diagnostic: {
      rawResultCount: 1, validResultCount: 0,
      schemaIssues: expect.arrayContaining([{ index: 0, code: "invalid_type", path: "caution" }, { index: 0, code: "unrecognized_keys", path: "$" }])
    } });
    if (kind === "source") expect(diagnostic).toMatchObject({ diagnostic: { schemaIssues: [], rejectionReasons: { invalid_result: 2 } } });
    if (kind === "empty") expect(diagnostic).toMatchObject({ diagnostic: { rawResultCount: 0, validResultCount: 0 } });
    if (kind === "unsafe") expect(diagnostic).toMatchObject({ diagnostic: { rejectionReasons: { unsafe_judgment: 1 } } });
  });

  it("keeps gateway failure diagnostics fixed and arbitrary exceptions private", async () => {
    vi.stubEnv(routes.memory, endpoint);
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("PRIVATE_GATEWAY_BODY", { status: 503 }));
    const failure = await runTokenHubFlashSmoke("memory", transport).catch((error: unknown) => error);
    expect(summarizeTokenHubFlashSmokeFailure(failure)).toEqual({ status: "failed", errorCode: "api_error",
      diagnostic: { stage: "memory_transport", adapterStatus: "fallback", transportCode: "request_failed" } });
    expect(summarizeTokenHubFlashSmokeFailure(Object.assign(new Error("PRIVATE_MESSAGE"), { code: "PRIVATE_CODE", diagnostic: "PRIVATE_BODY" })))
      .toEqual({ status: "failed", errorCode: "tokenhub_flash_smoke_failed" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("accepts a valid positive Memory decision with the synthetic ranking context", async () => {
    vi.stubEnv(routes.memory, endpoint);
    const transport = wireFetch({ results: [{ ...responses.memory.results[0], shouldUse: true, relevanceScore: 0.8, usefulnessScore: 0.8 }] });
    await expect(runTokenHubFlashSmoke("memory", transport)).resolves.toMatchObject({ status: "passed", count: 1 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not let an observer change the Memory adapter failure contract", async () => {
    vi.stubEnv(routes.memory, endpoint);
    const transport = wireFetch(responses.memory, "incomplete");
    const result = await createDeepseekMemoryRelevanceJudge({ fetch: transport, onTransportFailure() { throw new Error("observer_failed"); } }).judge(flashSmokeMemoryInput);
    expect(result).toMatchObject({ status: "fallback", failureCode: "api_error", rawResults: [] });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    { value: { PRIVATE_FIELD: "PRIVATE_VALUE" }, resultsType: "missing", extraFieldCount: 1, issue: { code: "invalid_type", path: "results" } },
    { value: { results: "PRIVATE_VALUE" }, resultsType: "string", extraFieldCount: 0, issue: { code: "invalid_type", path: "results" } },
    { value: { results: Array(21).fill("PRIVATE_VALUE") }, resultsType: "array", extraFieldCount: 0, issue: { code: "too_big", path: "results" } },
    { value: { ...responses.memory, PRIVATE_FIELD: "PRIVATE_VALUE" }, resultsType: "array", extraFieldCount: 1, issue: { code: "unrecognized_keys", path: "$" } }
  ])("distinguishes the outer Memory schema failure without revealing keys or values: $resultsType/$extraFieldCount", async ({ value, resultsType, extraFieldCount, issue }) => {
    vi.stubEnv(routes.memory, endpoint);
    const transport = wireFetch(value);
    const failure = await runTokenHubFlashSmoke("memory", transport).catch((error: unknown) => error);
    const safe = summarizeTokenHubFlashSmokeFailure(failure);
    expect(safe).toMatchObject({ errorCode: "invalid_schema", diagnostic: { stage: "memory_response_schema",
      responseSchema: { resultsType, extraFieldCount, issues: expect.arrayContaining([issue]) } } });
    expect(JSON.stringify(safe)).not.toContain("PRIVATE_");
    if (Array.isArray(value.results)) expect(safe).toMatchObject({ diagnostic: { responseSchema: { resultCount: value.results.length } } });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("keeps the schema failure when its observer throws", async () => {
    vi.stubEnv(routes.memory, endpoint);
    const transport = wireFetch({ results: null });
    const result = await createDeepseekMemoryRelevanceJudge({ fetch: transport, onResponseSchemaFailure() { throw new Error("observer_failed"); } }).judge(flashSmokeMemoryInput);
    expect(result).toMatchObject({ status: "fallback", failureCode: "invalid_schema", rawResults: [] });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects the observed Memory items envelope instead of silently remapping it", async () => {
    vi.stubEnv(routes.memory, endpoint);
    const transport = wireFetch({ items: [{ memoryId: "synthetic_memory", shouldUse: true,
      relevanceScore: 0.95, usefulnessScore: 0.85, reason: "The previous note and current brief both concern checking a sample.",
      caution: "Mention only the sample check from the note." }] });
    const failure = await runTokenHubFlashSmoke("memory", transport).catch((error: unknown) => error);
    expect(summarizeTokenHubFlashSmokeFailure(failure)).toMatchObject({ errorCode: "invalid_schema", diagnostic: {
      stage: "memory_response_schema", responseSchema: { resultsType: "missing", extraFieldCount: 1 }
    } });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
