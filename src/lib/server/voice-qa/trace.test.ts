// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { JsonStore } from "@/lib/server/storage/json-store";

import { JsonVoiceSessionTraceRepository } from "./trace-repository";
import {
  VoiceSessionTracer,
  calculateVoiceLatencySegments,
  calculateVoiceStreamingTraceLatencies,
  calculateVoiceSessionTraceLatencies,
  createVoiceSessionTraceModel,
  logVoiceSessionTrace,
  updateVoiceSessionTrace
} from "./trace";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const epoch = Date.parse("2026-07-21T00:00:00.000Z");
let tempDir: string | undefined;

function dateAt(offsetMs: number) {
  return new Date(epoch + offsetMs);
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("VoiceSessionTrace", () => {
  it("tracks a normal voice turn and calculates stage latencies", () => {
    const offsets = [0, 10, 100, 120, 150, 150, 250, 250, 400, 450, 900];
    const info = vi.fn();
    const tracer = new VoiceSessionTracer({
      sessionId: SESSION_ID,
      scope: "all",
      now: () => dateAt(offsets.shift() ?? 900),
      logger: { info, warn: vi.fn() }
    });

    tracer.mark("speech_started");
    tracer.mark("speech_ended");
    expect(tracer.mark("asr_first_partial")).toBe(true);
    expect(tracer.mark("asr_first_partial")).toBe(false);
    tracer.mark("asr_final_received");
    tracer.mark("qa_started");
    tracer.mark("qa_completed");
    tracer.mark("tts_started");
    tracer.mark("audio_play_started");
    tracer.recordQaBreakdown({
      answerMode: "agent",
      memoryRetrievalMs: null,
      relationshipContextBuildingMs: 1,
      rerankingMs: 6,
      promptConstructionMs: 2,
      llmGenerationMs: 88,
      responseValidationMs: 1,
      totalMs: 98,
      promptCharacters: 2_000,
      responseCharacters: 120,
      evidenceCount: 8,
      providerCallCount: 1,
      fallbackReason: "none",
      responseOptimizationMs: 1,
      endToEndQaMs: 99
    });
    tracer.complete();

    const trace = tracer.snapshot();
    expect(trace.status).toBe("completed");
    expect(trace.latencies).toEqual({
      asrLatencyMs: 50,
      qaLatencyMs: 100,
      ttsLatencyMs: 150,
      totalResponseLatencyMs: 300
    });
    expect(trace.qaBreakdown).toMatchObject({
      answerMode: "agent",
      llmGenerationMs: 88,
      responseOptimizationMs: 1
    });
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^VOICE_TRACE: /u));
  });

  it("keeps unavailable or reversed timestamp pairs null", () => {
    let trace = createVoiceSessionTraceModel({
      sessionId: SESSION_ID,
      scope: "all",
      now: () => dateAt(0)
    });
    trace = updateVoiceSessionTrace(trace, { event: "qa_started", now: () => dateAt(100) });
    trace = updateVoiceSessionTrace(trace, { event: "qa_completed", now: () => dateAt(175) });
    trace = updateVoiceSessionTrace(trace, { event: "tts_started", now: () => dateAt(500) });
    trace = updateVoiceSessionTrace(trace, { event: "audio_play_started", now: () => dateAt(400) });

    expect(calculateVoiceSessionTraceLatencies(trace.timestamps)).toEqual({
      asrLatencyMs: null,
      qaLatencyMs: 75,
      ttsLatencyMs: null,
      totalResponseLatencyMs: null
    });
  });

  it("tracks the safe streaming voice path from speech end to first playback", () => {
    const offsets = [0, 100, 120, 200, 205, 210, 230, 260, 900];
    const tracer = new VoiceSessionTracer({
      sessionId: SESSION_ID,
      scope: "all",
      now: () => dateAt(offsets.shift() ?? 900),
      logger: { info: vi.fn(), warn: vi.fn() }
    });

    tracer.mark("speech_ended");
    tracer.mark("first_sentence_committed");
    tracer.mark("first_safe_sentence");
    tracer.mark("tts_stream_started");
    tracer.mark("first_audio_chunk_received");
    tracer.mark("playback_started");
    tracer.mark("tts_stream_complete");

    const trace = tracer.snapshot();
    expect(trace.timestamps).toMatchObject({
      tts_stream_complete: dateAt(260).toISOString(),
      stream_completed: dateAt(260).toISOString()
    });
    expect(trace.streamingLatencies).toEqual({
      speechToFirstSentenceCommittedMs: 20,
      speechToFirstSafeSentenceMs: 100,
      ttsToFirstAudioChunkMs: 5,
      firstAudioChunkToPlaybackMs: 20,
      speechToFirstAudioPlayMs: 130,
      streamDurationMs: 55
    });
    expect(trace.latencies.totalResponseLatencyMs).toBe(130);
    expect(trace.latencies.ttsLatencyMs).toBe(25);
  });

  it("keeps QA, partial-audio, fallback-audio, and transport terminals as distinct milestones", () => {
    const offsets = [0, 10, 20, 30, 40];
    const tracer = new VoiceSessionTracer({
      sessionId: SESSION_ID,
      scope: "all",
      now: () => dateAt(offsets.shift() ?? 40),
      logger: { info: vi.fn(), warn: vi.fn() }
    });

    tracer.mark("qa_provider_stream_complete");
    tracer.mark("tts_partial_audio_failure");
    tracer.mark("fallback_audio_complete");
    tracer.mark("transport_complete_written");

    expect(tracer.snapshot().timestamps).toMatchObject({
      qa_provider_stream_complete: dateAt(10).toISOString(),
      tts_partial_audio_failure: dateAt(20).toISOString(),
      fallback_audio_complete: dateAt(30).toISOString(),
      transport_complete_written: dateAt(40).toISOString()
    });
  });

  it("keeps missing or reversed streaming latency pairs null", () => {
    let trace = createVoiceSessionTraceModel({
      sessionId: SESSION_ID,
      scope: "all",
      now: () => dateAt(0)
    });
    trace = updateVoiceSessionTrace(trace, {
      event: "tts_stream_started",
      now: () => dateAt(500)
    });
    trace = updateVoiceSessionTrace(trace, {
      event: "first_audio_chunk_received",
      now: () => dateAt(400)
    });

    expect(calculateVoiceStreamingTraceLatencies(trace.timestamps)).toEqual({
      speechToFirstSentenceCommittedMs: null,
      speechToFirstSafeSentenceMs: null,
      ttsToFirstAudioChunkMs: null,
      firstAudioChunkToPlaybackMs: null,
      speechToFirstAudioPlayMs: null,
      streamDurationMs: null
    });
  });

  it("records the detailed Voice first-audio critical path without inferring missing stages", () => {
    const offsets = [0, 100, 130, 300, 420, 430, 900, 960, 1_200];
    const tracer = new VoiceSessionTracer({
      sessionId: SESSION_ID,
      scope: "all",
      now: () => dateAt(offsets.shift() ?? 1_200),
      logger: { info: vi.fn(), warn: vi.fn() }
    });

    tracer.mark("voice_question_received");
    tracer.mark("retrieval_complete");
    tracer.mark("llm_first_token");
    tracer.mark("first_sentence_committed");
    tracer.mark("tts_request_start");
    tracer.mark("first_audio_chunk_received");
    tracer.mark("playback_started");
    tracer.complete();

    const trace = tracer.snapshot();
    expect(trace.timestamps).toMatchObject({
      sentence_commit: dateAt(420).toISOString(),
      tts_first_audio_chunk: dateAt(900).toISOString(),
      browser_playback_start: dateAt(960).toISOString(),
      complete: dateAt(1_200).toISOString()
    });
    expect(trace.latencySegments).toEqual({
      retrieval_ms: 30,
      llm_ttft_ms: 170,
      sentence_commit_wait_ms: 120,
      tts_request_latency_ms: 10,
      tts_first_audio_ms: 470,
      browser_buffer_ms: 60,
      first_audio_total_ms: 860
    });

    expect(calculateVoiceLatencySegments({
      session_created: dateAt(0).toISOString(),
      voice_question_received: dateAt(200).toISOString(),
      retrieval_complete: dateAt(100).toISOString()
    })).toMatchObject({
      retrieval_ms: null,
      llm_ttft_ms: null,
      first_audio_total_ms: null
    });
  });

  it("keeps a terminal trace immutable when delayed telemetry arrives", () => {
    let trace = createVoiceSessionTraceModel({
      sessionId: SESSION_ID,
      scope: "all",
      now: () => dateAt(0)
    });
    trace = updateVoiceSessionTrace(trace, {
      event: "session_completed",
      terminalStatus: "completed",
      now: () => dateAt(100)
    });

    const delayed = updateVoiceSessionTrace(trace, {
      event: "audio_play_started",
      failure: { stage: "playback", code: "playback_failed" },
      now: () => dateAt(200)
    });

    expect(delayed).toBe(trace);
    expect(delayed.timestamps.audio_play_started).toBeUndefined();
    expect(delayed.failures).toEqual([]);
  });

  it("logs only structural identifiers, latency values, and status", () => {
    const info = vi.fn();
    const trace = createVoiceSessionTraceModel({
      sessionId: SESSION_ID,
      scope: "current",
      uploadId: "upload_1",
      now: () => dateAt(0)
    });

    logVoiceSessionTrace(trace, { info });

    const output = String(info.mock.calls[0]?.[0]);
    expect(output).toContain("VOICE_TRACE:");
    expect(output).toContain(SESSION_ID);
    expect(output).not.toContain("upload_1");
    expect(output).not.toContain("transcript");
    expect(output).not.toContain("audio_bytes");
    expect(output).not.toContain("audioBase64");
    expect(output).not.toContain("secret");
  });

  it("persists and serializes concurrent updates in the existing JsonStore", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "voice-trace-"));
    const repository = new JsonVoiceSessionTraceRepository(new JsonStore(tempDir));
    const secondRequestRepository = new JsonVoiceSessionTraceRepository(new JsonStore(tempDir));
    const trace = createVoiceSessionTraceModel({
      sessionId: SESSION_ID,
      scope: "all",
      now: () => dateAt(0)
    });
    await repository.write(trace);

    await Promise.all([
      repository.update(SESSION_ID, { event: "speech_started", now: () => dateAt(10) }),
      secondRequestRepository.update(SESSION_ID, { event: "speech_ended", now: () => dateAt(100) })
    ]);

    await expect(repository.read(SESSION_ID)).resolves.toMatchObject({
      sessionId: SESSION_ID,
      timestamps: {
        speech_started: dateAt(10).toISOString(),
        speech_ended: dateAt(100).toISOString()
      }
    });
  });

  it("merges a stale server snapshot after browser playback without losing either event", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "voice-trace-"));
    const repository = new JsonVoiceSessionTraceRepository(new JsonStore(tempDir));
    let serverSnapshot = createVoiceSessionTraceModel({
      sessionId: SESSION_ID,
      scope: "all",
      now: () => dateAt(0)
    });
    for (const [event, offset] of [
      ["speech_ended", 100],
      ["tts_stream_started", 200],
      ["first_audio_chunk_received", 250]
    ] as const) {
      serverSnapshot = updateVoiceSessionTrace(serverSnapshot, {
        event,
        now: () => dateAt(offset)
      });
    }
    await repository.write(serverSnapshot);

    await repository.update(SESSION_ID, {
      event: "playback_started",
      now: () => dateAt(300)
    });
    const staleStreamCompletion = updateVoiceSessionTrace(serverSnapshot, {
      event: "stream_completed",
      now: () => dateAt(400)
    });
    await repository.write(staleStreamCompletion);

    await expect(repository.read(SESSION_ID)).resolves.toMatchObject({
      status: "in_progress",
      timestamps: {
        playback_started: dateAt(300).toISOString(),
        stream_completed: dateAt(400).toISOString()
      },
      streamingLatencies: {
        speechToFirstAudioPlayMs: 200,
        streamDurationMs: 200
      }
    });
  });

  it("merges concurrent full-snapshot writes through one session queue", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "voice-trace-"));
    const repository = new JsonVoiceSessionTraceRepository(new JsonStore(tempDir));
    const secondRequestRepository = new JsonVoiceSessionTraceRepository(new JsonStore(tempDir));
    let base = createVoiceSessionTraceModel({
      sessionId: SESSION_ID,
      scope: "all",
      now: () => dateAt(0)
    });
    base = updateVoiceSessionTrace(base, {
      event: "first_audio_chunk_received",
      now: () => dateAt(100)
    });
    await repository.write(base);

    const playbackSnapshot = updateVoiceSessionTrace(base, {
      event: "playback_started",
      now: () => dateAt(200)
    });
    const completedSnapshot = updateVoiceSessionTrace(base, {
      event: "stream_completed",
      now: () => dateAt(300)
    });
    await Promise.all([
      repository.write(playbackSnapshot),
      secondRequestRepository.write(completedSnapshot)
    ]);

    await expect(repository.read(SESSION_ID)).resolves.toMatchObject({
      timestamps: {
        playback_started: dateAt(200).toISOString(),
        stream_completed: dateAt(300).toISOString()
      }
    });
  });

  it("does not let an older snapshot overwrite a terminal trace", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "voice-trace-"));
    const repository = new JsonVoiceSessionTraceRepository(new JsonStore(tempDir));
    let staleSnapshot = createVoiceSessionTraceModel({
      sessionId: SESSION_ID,
      scope: "all",
      now: () => dateAt(0)
    });
    staleSnapshot = updateVoiceSessionTrace(staleSnapshot, {
      event: "audio_play_started",
      now: () => dateAt(100)
    });
    await repository.write(staleSnapshot);
    await repository.update(SESSION_ID, {
      event: "session_completed",
      terminalStatus: "completed",
      now: () => dateAt(200)
    });

    await repository.write(staleSnapshot);

    await expect(repository.read(SESSION_ID)).resolves.toMatchObject({
      status: "completed",
      timestamps: {
        audio_play_started: dateAt(100).toISOString(),
        session_completed: dateAt(200).toISOString()
      },
      updatedAt: dateAt(200).toISOString()
    });
  });
});
