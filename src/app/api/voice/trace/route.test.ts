// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JsonStore } from "@/lib/server/storage/json-store";
import { VoiceSessionManager } from "@/lib/server/voice-qa/session-manager";
import { JsonVoiceSessionTraceRepository } from "@/lib/server/voice-qa/trace-repository";
import { createVoiceSessionTraceModel, updateVoiceSessionTrace } from "@/lib/server/voice-qa/trace";

const authContextMock = vi.hoisted(() => ({
  isUnauthenticatedError: vi.fn((error: unknown) => error instanceof Error && error.message === "unauthenticated"),
  requireAuthContext: vi.fn(),
  unauthorizedResponse: vi.fn(() => Response.json({ error: "unauthenticated" }, { status: 401 }))
}));

vi.mock("@/lib/server/auth/request-context", () => authContextMock);

import { POST } from "./route";

const TRACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TRACE_ID = "22222222-2222-4222-8222-222222222222";
const APPLICATION_SESSION_ID = "conversation_session_1";
const epoch = Date.parse("2026-07-21T00:00:00.000Z");
let tempDir: string | undefined;
let store: JsonStore;

function request(body: unknown) {
  return new Request("http://localhost/api/voice/trace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function at(offsetMs: number) {
  return new Date(epoch + offsetMs);
}

async function seedTrace(options: { applicationSession?: boolean } = {}) {
  if (options.applicationSession) {
    const manager = new VoiceSessionManager({ store, now: () => at(0) });
    await manager.create({
      sessionId: APPLICATION_SESSION_ID,
      userId: "user_1",
      initialState: "IDLE"
    });
    await manager.claimTurn(APPLICATION_SESSION_ID, "user_1");
    await manager.attachTrace(APPLICATION_SESSION_ID, TRACE_ID, "user_1");
  }
  let trace = createVoiceSessionTraceModel({
    sessionId: TRACE_ID,
    ...(options.applicationSession
      ? { applicationSessionId: APPLICATION_SESSION_ID }
      : {}),
    scope: "all",
    now: () => at(0)
  });
  for (const [event, offset] of [
    ["speech_started", 10],
    ["speech_ended", 100],
    ["asr_final_received", 150],
    ["qa_started", 150],
    ["qa_completed", 250],
    ["tts_started", 250]
  ] as const) {
    trace = updateVoiceSessionTrace(trace, { event, now: () => at(offset) });
  }
  await new JsonVoiceSessionTraceRepository(store).write(trace);
}

describe("POST /api/voice/trace", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    tempDir = await mkdtemp(join(tmpdir(), "voice-trace-route-"));
    store = new JsonStore(tempDir);
    authContextMock.requireAuthContext.mockResolvedValue({
      user: { id: "user_1" },
      store
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("records browser playback and completes a normal trace", async () => {
    await seedTrace();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    vi.setSystemTime(at(400));
    const playing = await POST(request({ traceId: TRACE_ID, event: "audio_play_started" }));
    expect(playing.status).toBe(200);

    vi.setSystemTime(at(900));
    const completed = await POST(request({
      traceId: TRACE_ID,
      event: "session_completed",
      outcome: "completed"
    }));
    expect(completed.status).toBe(200);

    const trace = await new JsonVoiceSessionTraceRepository(store).read(TRACE_ID);
    expect(trace).toMatchObject({
      status: "completed",
      latencies: {
        asrLatencyMs: 50,
        qaLatencyMs: 100,
        ttsLatencyMs: 150,
        totalResponseLatencyMs: 300
      }
    });
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^VOICE_TRACE: /u));
  });

  it("records streaming playback only after the first audio chunk", async () => {
    let trace = createVoiceSessionTraceModel({
      sessionId: TRACE_ID,
      scope: "all",
      now: () => at(0)
    });
    for (const [event, offset] of [
      ["speech_ended", 100],
      ["first_sentence_committed", 200],
      ["first_safe_sentence", 210],
      ["tts_stream_started", 220],
      ["first_audio_chunk_received", 250]
    ] as const) {
      trace = updateVoiceSessionTrace(trace, { event, now: () => at(offset) });
    }
    await new JsonVoiceSessionTraceRepository(store).write(trace);
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    vi.setSystemTime(at(300));
    const playing = await POST(request({ traceId: TRACE_ID, event: "playback_started" }));
    expect(playing.status).toBe(200);

    vi.setSystemTime(at(600));
    const completed = await POST(request({
      traceId: TRACE_ID,
      event: "session_completed",
      outcome: "completed"
    }));
    expect(completed.status).toBe(200);

    await expect(new JsonVoiceSessionTraceRepository(store).read(TRACE_ID)).resolves.toMatchObject({
      status: "completed",
      latencies: { totalResponseLatencyMs: 200, ttsLatencyMs: 80 },
      streamingLatencies: {
        speechToFirstAudioPlayMs: 200,
        ttsToFirstAudioChunkMs: 30,
        firstAudioChunkToPlaybackMs: 50
      }
    });
  });

  it("keeps the browser observation time while a streaming checkpoint finishes persisting", async () => {
    let trace = createVoiceSessionTraceModel({
      sessionId: TRACE_ID,
      scope: "all",
      now: () => at(0)
    });
    for (const [event, offset] of [
      ["speech_ended", 100],
      ["voice_question_received", 150],
      ["first_sentence_committed", 200],
      ["first_safe_sentence", 210],
      ["tts_stream_started", 220]
    ] as const) {
      trace = updateVoiceSessionTrace(trace, { event, now: () => at(offset) });
    }
    const repository = new JsonVoiceSessionTraceRepository(store);
    await repository.write(trace);

    vi.setSystemTime(at(300));
    const pendingPlayback = POST(request({
      traceId: TRACE_ID,
      event: "playback_started"
    }));
    await vi.advanceTimersByTimeAsync(25);

    trace = updateVoiceSessionTrace(trace, {
      event: "first_audio_chunk_received",
      now: () => at(250)
    });
    await repository.write(trace);
    await vi.advanceTimersByTimeAsync(25);

    const response = await pendingPlayback;
    expect(response.status).toBe(200);
    await expect(repository.read(TRACE_ID)).resolves.toMatchObject({
      timestamps: {
        first_audio_chunk_received: at(250).toISOString(),
        playback_started: at(300).toISOString()
      },
      latencySegments: {
        browser_buffer_ms: 50
      }
    });
  });

  it("rejects streaming playback before a server audio chunk exists", async () => {
    await seedTrace();
    const response = await POST(request({ traceId: TRACE_ID, event: "playback_started" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "invalid_trace_transition" });
  });

  it("marks a playback failure without inventing playback completion latency", async () => {
    await seedTrace();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.setSystemTime(at(500));

    const response = await POST(request({
      traceId: TRACE_ID,
      event: "session_completed",
      outcome: "failed"
    }));

    expect(response.status).toBe(200);
    const trace = await new JsonVoiceSessionTraceRepository(store).read(TRACE_ID);
    expect(trace).toMatchObject({
      status: "failed",
      latencies: {
        ttsLatencyMs: null,
        totalResponseLatencyMs: null
      },
      failures: [{ stage: "playback", code: "playback_failed" }]
    });
    expect(trace?.timestamps.audio_play_started).toBeUndefined();
  });

  it("synchronizes an aborted trace with its active VoiceSession", async () => {
    await seedTrace({ applicationSession: true });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.setSystemTime(at(500));

    const response = await POST(request({
      traceId: TRACE_ID,
      event: "session_completed",
      outcome: "aborted"
    }));

    expect(response.status).toBe(200);
    await expect(new JsonVoiceSessionTraceRepository(store).read(TRACE_ID)).resolves.toMatchObject({
      status: "aborted",
      failures: [{ stage: "session", code: "client_closed" }]
    });
    const session = await new VoiceSessionManager({ store })
      .lookup(APPLICATION_SESSION_ID, "user_1");
    expect(session?.state).toBe("IDLE");
    expect(session?.activeTraceId).toBeUndefined();
  });

  it("retries abort synchronization idempotently without releasing a newer turn", async () => {
    await seedTrace({ applicationSession: true });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.setSystemTime(at(500));
    await POST(request({
      traceId: TRACE_ID,
      event: "session_completed",
      outcome: "aborted"
    }));

    const manager = new VoiceSessionManager({ store });
    await manager.claimTurn(APPLICATION_SESSION_ID, "user_1");
    await manager.attachTrace(APPLICATION_SESSION_ID, OTHER_TRACE_ID, "user_1");
    const duplicate = await POST(request({
      traceId: TRACE_ID,
      event: "session_completed",
      outcome: "aborted"
    }));

    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ ok: true, idempotent: true });
    await expect(manager.lookup(APPLICATION_SESSION_ID, "user_1")).resolves.toMatchObject({
      state: "LISTENING",
      activeTraceId: OTHER_TRACE_ID
    });
  });

  it("lets a duplicate abort repair a matching session left active", async () => {
    vi.setSystemTime(at(500));
    await seedTrace({ applicationSession: true });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    await POST(request({
      traceId: TRACE_ID,
      event: "session_completed",
      outcome: "aborted"
    }));

    const manager = new VoiceSessionManager({ store });
    await manager.claimTurn(APPLICATION_SESSION_ID, "user_1");
    await manager.attachTrace(APPLICATION_SESSION_ID, TRACE_ID, "user_1");
    const duplicate = await POST(request({
      traceId: TRACE_ID,
      event: "session_completed",
      outcome: "aborted"
    }));

    expect(duplicate.status).toBe(200);
    const session = await manager.lookup(APPLICATION_SESSION_ID, "user_1");
    expect(session?.state).toBe("IDLE");
    expect(session?.activeTraceId).toBeUndefined();
  });

  it("rejects a successful completion before playback starts", async () => {
    await seedTrace();
    vi.setSystemTime(at(400));

    const response = await POST(request({
      traceId: TRACE_ID,
      event: "session_completed",
      outcome: "completed"
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "invalid_trace_transition" });
    await expect(new JsonVoiceSessionTraceRepository(store).read(TRACE_ID)).resolves.toMatchObject({
      status: "in_progress",
      timestamps: expect.not.objectContaining({ session_completed: expect.anything() })
    });
  });

  it("keeps terminal traces immutable and treats duplicate completion as idempotent", async () => {
    await seedTrace();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.setSystemTime(at(400));
    await POST(request({ traceId: TRACE_ID, event: "audio_play_started" }));
    vi.setSystemTime(at(500));
    await POST(request({ traceId: TRACE_ID, event: "session_completed", outcome: "completed" }));

    vi.setSystemTime(at(600));
    const duplicate = await POST(request({
      traceId: TRACE_ID,
      event: "session_completed",
      outcome: "completed"
    }));
    const latePlayback = await POST(request({ traceId: TRACE_ID, event: "audio_play_started" }));

    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ ok: true, idempotent: true });
    expect(latePlayback.status).toBe(409);
    const trace = await new JsonVoiceSessionTraceRepository(store).read(TRACE_ID);
    expect(trace?.updatedAt).toBe(at(500).toISOString());
  });

  it("serializes concurrent playback and completion and keeps completion idempotent", async () => {
    let trace = createVoiceSessionTraceModel({
      sessionId: TRACE_ID,
      scope: "all",
      now: () => at(0)
    });
    for (const [event, offset] of [
      ["speech_ended", 100],
      ["tts_stream_started", 200],
      ["first_audio_chunk_received", 250]
    ] as const) {
      trace = updateVoiceSessionTrace(trace, { event, now: () => at(offset) });
    }
    await new JsonVoiceSessionTraceRepository(store).write(trace);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.setSystemTime(at(300));

    const [playing, completed] = await Promise.all([
      POST(request({ traceId: TRACE_ID, event: "playback_started" })),
      POST(request({ traceId: TRACE_ID, event: "session_completed", outcome: "completed" }))
    ]);

    expect(playing.status).toBe(200);
    expect(completed.status).toBe(200);
    vi.setSystemTime(at(400));
    const duplicate = await POST(request({
      traceId: TRACE_ID,
      event: "session_completed",
      outcome: "completed"
    }));
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ ok: true, idempotent: true });
    await expect(new JsonVoiceSessionTraceRepository(store).read(TRACE_ID)).resolves.toMatchObject({
      status: "completed",
      timestamps: {
        playback_started: at(300).toISOString(),
        session_completed: at(300).toISOString()
      }
    });
  });

  it("rejects malformed events and traces outside the authenticated user store", async () => {
    const malformed = await POST(request({ traceId: "../other-user", event: "session_completed" }));
    expect(malformed.status).toBe(400);

    const missing = await POST(request({ traceId: TRACE_ID, event: "audio_play_started" }));
    expect(missing.status).toBe(404);
  });
});
