// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  assertEvaluationReportPath,
  assertStreamingVoiceRemoteEnvironment,
  classifyStreamingVoiceFailure,
  classifyStreamingVoiceOutcome,
  matchesStreamingVoiceExpectedOutcome,
  observedVoiceModelIdentity,
  parseQaStreamTraceLine,
  parseStreamingVoiceE2eArgs,
  summarizeLegacyVoiceResponse,
  summarizeVoiceNdjson
} from "./validate-streaming-voice-e2e";

const BASE_ENV = {
  APP_DATA_DIR: ".data-test"
};

describe("streaming voice E2E evaluation harness", () => {
  it("classifies failures without returning error bodies, paths, or secrets", () => {
    const classified = classifyStreamingVoiceFailure(
      new Error(`${["C:", "private", "token.txt"].join("\\")} contains secret-value`)
    );
    expect(classified).toBe("unexpected_failure");
    expect(classified).not.toContain("private");
    expect(classified).not.toContain("secret-value");
    expect(classifyStreamingVoiceFailure(
      new Error("RUN_STREAMING_VOICE_REMOTE_VERIFY=1 is required")
    )).toBe("preflight_rejected");
    expect(classifyStreamingVoiceFailure(
      new Error("voice_trace_terminal_state_timeout")
    )).toBe("terminal_state_timeout");
  });

  it("is fail-closed unless remote evaluation is explicitly enabled", () => {
    expect(() => assertStreamingVoiceRemoteEnvironment({})).toThrow(
      "RUN_STREAMING_VOICE_REMOTE_VERIFY=1"
    );
    expect(() => assertStreamingVoiceRemoteEnvironment({
      RUN_STREAMING_VOICE_REMOTE_VERIFY: "1",
      EVALUATION_MODE: "false"
    })).toThrow("EVALUATION_MODE=true");
    expect(() => assertStreamingVoiceRemoteEnvironment({
      RUN_STREAMING_VOICE_REMOTE_VERIFY: "1",
      EVALUATION_MODE: "true"
    })).toThrow("VOLCENGINE_APP_ID");
  });

  it("requires bounded WAV scenarios and keeps credentials out of CLI arguments", () => {
    expect(() => parseStreamingVoiceE2eArgs([], BASE_ENV)).toThrow("single_sentence");
    const parsed = parseStreamingVoiceE2eArgs([
      "--single-audio", "single.wav",
      "--multi-audio", "multi.wav",
      "--uncertainty-audio", "uncertain.wav",
      "--port", "3220",
      "--timeout-seconds", "300"
    ], BASE_ENV);
    expect(parsed).toMatchObject({
      port: 3220,
      timeoutMs: 300_000,
      scope: "all",
      answerMode: "agent"
    });
    expect(parsed.audio.cancel).toBe(parsed.audio.single_sentence);
    expect(() => parseStreamingVoiceE2eArgs([
      "--email", "private@example.com",
      "--single-audio", "single.wav",
      "--multi-audio", "multi.wav",
      "--uncertainty-audio", "uncertain.wav"
    ], BASE_ENV)).toThrow("Unknown argument: --email");
  });

  it("only permits a new report below the evaluation data root", () => {
    expect(() => assertEvaluationReportPath(".data-test", ".data-test/report.json")).toThrow(
      "APP_DATA_DIR/evaluation"
    );
    expect(() => assertEvaluationReportPath(
      ".data-test",
      ".data-test/evaluation/streaming-voice/report.json"
    )).not.toThrow();
  });

  it("summarizes NDJSON without retaining transcript, answer, citations, or audio", () => {
    const raw = [
      {
        type: "meta",
        version: 1,
        conversationSessionId: "conversation_1",
        traceId: "11111111-1111-4111-8111-111111111111",
        audio: { format: "pcm_s16le", sampleRate: 24_000, channels: 1 }
      },
      {
        type: "audio_chunk",
        sequence: 1,
        sentenceSequence: 1,
        chunkSequence: 1,
        audioBase64: Buffer.from([1, 2]).toString("base64")
      },
      {
        type: "audio_chunk",
        sequence: 2,
        sentenceSequence: 2,
        chunkSequence: 1,
        audioBase64: Buffer.from([3, 4]).toString("base64")
      },
      {
        type: "answer",
        sessionId: "provider_session_1",
        transcript: "private question",
        text: "目前没有证据证明已经完成。",
        answer: {
          id: "answer_1",
          citedSegmentIds: ["segment_1"],
          citations: [
            {
              id: "E1",
              title: "private evidence",
              startSeconds: 10,
              endSeconds: 12,
              excerpt: "private evidence excerpt",
              sourceSegmentIds: ["segment_1"]
            }
          ]
        }
      },
      { type: "complete", status: "completed", errors: [] }
    ].map((value) => JSON.stringify(value)).join("\n");
    const summary = summarizeVoiceNdjson(raw);
    expect(summary).toMatchObject({
      audioChunkCount: 2,
      sentenceAudioCount: 2,
      audioBytes: 4,
      chunkOrderingValid: true,
      transcriptPresent: true,
      answerPresent: true,
      answerSentenceCount: 1,
      citationCount: 1,
      citationMarkersRemoved: true,
      uncertaintyPreserved: true
    });
    expect(JSON.stringify(summary)).not.toContain("private question");
    expect(JSON.stringify(summary)).not.toContain("没有证据证明");
    expect(JSON.stringify(summary)).not.toContain("evidence");
    expect(JSON.stringify(summary)).not.toContain(Buffer.from([1, 2]).toString("base64"));
  });

  it("detects out-of-order TTS chunks", () => {
    const raw = [
      {
        type: "meta",
        version: 1,
        conversationSessionId: "conversation_1",
        traceId: "11111111-1111-4111-8111-111111111111",
        audio: { format: "pcm_s16le", sampleRate: 24_000, channels: 1 }
      },
      {
        type: "audio_chunk",
        sequence: 2,
        sentenceSequence: 1,
        chunkSequence: 1,
        audioBase64: Buffer.from([1, 2]).toString("base64")
      },
      { type: "complete", status: "failed", errors: ["tts_failed"] }
    ].map((value) => JSON.stringify(value)).join("\n");
    expect(summarizeVoiceNdjson(raw)).toMatchObject({
      chunkOrderingValid: false,
      errorCount: 1
    });
  });

  it("summarizes legacy JSON/WAV without saving response content", () => {
    const summary = summarizeLegacyVoiceResponse(JSON.stringify({
      traceId: "11111111-1111-4111-8111-111111111111",
      transcript: "private question",
      text: "A grounded answer",
      audioBase64: Buffer.from([1, 2, 3]).toString("base64"),
      answer: { citations: [{ id: "E1" }] }
    }));
    expect(summary).toMatchObject({
      transcriptPresent: true,
      answerPresent: true,
      audioPresent: true,
      audioBytes: 3,
      citationCount: 1
    });
    expect(JSON.stringify(summary)).not.toContain("private question");
    expect(JSON.stringify(summary)).not.toContain("grounded answer");
  });

  it("extracts only content-free QA streaming metrics from server logs", () => {
    expect(parseQaStreamTraceLine(
      'QA_STREAM_TRACE: {"stream_id":"private","status":"completed","first_token_ms":120,' +
      '"first_sentence_ms":650,"total_stream_ms":2200,"token_chunk_count":20,' +
      '"sentence_count":2,"provider_call_count":1,"fallback_reason":null,' +
      '"provider_id":"qwen-vllm","model":"Qwen/Qwen3.6-27B",' +
      '"reasoning_enabled":false,"output_token_count":17,"total_token_count":93}'
    )).toEqual({
      observed: true,
      status: "completed",
      firstTokenMs: 120,
      firstSentenceMs: 650,
      totalStreamMs: 2200,
      tokenChunkCount: 20,
      sentenceCount: 2,
      providerCallCount: 1,
      fallbackReasonPresent: false,
      providerId: "qwen-vllm",
      model: "Qwen/Qwen3.6-27B",
      reasoningEnabled: false,
      outputTokenCount: 17,
      totalTokenCount: 93
    });

    expect(parseQaStreamTraceLine(
      'QA_STREAM_TRACE: {"status":"completed","model":"private answer text"}'
    )).toEqual({
      observed: true,
      status: "completed",
      firstTokenMs: undefined,
      firstSentenceMs: undefined,
      totalStreamMs: undefined,
      fallbackReasonPresent: false
    });
    expect(observedVoiceModelIdentity({ observed: true })).toEqual({
      provider: "unknown",
      model: "unknown",
      reasoningEnabled: null
    });
  });

  it("classifies ordered streamed speech as streaming_success", () => {
    const snapshot = {
      response: {
        status: "completed",
        answerPresent: true,
        audioChunkCount: 3,
        chunkOrderingValid: true,
        fallbackAudioPresent: false
      },
      trace: {
        status: "completed",
        timestamps: {
          playback_started: "2026-07-23T00:00:01.000Z",
          tts_stream_complete: "2026-07-23T00:00:02.000Z",
          stream_completed: "2026-07-23T00:00:02.000Z",
          transport_complete_written: "2026-07-23T00:00:02.500Z",
          session_completed: "2026-07-23T00:00:03.000Z"
        }
      },
      browserOutcome: "completed",
      qaStreamTrace: {
        observed: true,
        status: "completed",
        fallbackReasonPresent: false
      }
    };

    expect(classifyStreamingVoiceOutcome(snapshot)).toBe("streaming_success");
    expect(matchesStreamingVoiceExpectedOutcome("streaming_success", snapshot)).toBe(true);
    expect(classifyStreamingVoiceOutcome({
      ...snapshot,
      response: { ...snapshot.response, chunkOrderingValid: false }
    })).toBe("unexpected");
    expect(classifyStreamingVoiceOutcome({
      ...snapshot,
      trace: {
        ...snapshot.trace,
        timestamps: {
          ...snapshot.trace.timestamps,
          tts_partial_audio_failure: "2026-07-23T00:00:02.250Z"
        }
      }
    })).toBe("unexpected");
  });

  it("accepts a grounded uncertainty response as safe_fallback without requiring streamed audio", () => {
    const snapshot = {
      response: {
        status: "completed",
        answerPresent: true,
        audioChunkCount: 0,
        chunkOrderingValid: true,
        fallbackAudioPresent: true
      },
      trace: {
        status: "completed",
        timestamps: {
          audio_play_started: "2026-07-23T00:00:01.000Z",
          fallback_audio_complete: "2026-07-23T00:00:01.500Z",
          transport_complete_written: "2026-07-23T00:00:01.750Z",
          session_completed: "2026-07-23T00:00:02.000Z"
        }
      },
      browserOutcome: "completed",
      qaStreamTrace: {
        observed: true,
        status: "completed_with_fallback",
        fallbackReasonPresent: true
      }
    };

    expect(classifyStreamingVoiceOutcome(snapshot)).toBe("safe_fallback");
    expect(matchesStreamingVoiceExpectedOutcome("safe_fallback", snapshot)).toBe(true);
    expect(classifyStreamingVoiceOutcome({
      ...snapshot,
      response: { ...snapshot.response, audioChunkCount: 1 }
    })).toBe("unexpected");
    expect(classifyStreamingVoiceOutcome({
      ...snapshot,
      qaStreamTrace: { ...snapshot.qaStreamTrace, fallbackReasonPresent: false }
    })).toBe("unexpected");
  });

  it("accepts a final uncertainty projection streamed after QA fallback", () => {
    const snapshot = {
      response: {
        status: "completed",
        answerPresent: true,
        audioChunkCount: 2,
        chunkOrderingValid: true,
        fallbackAudioPresent: false
      },
      trace: {
        status: "completed",
        timestamps: {
          playback_started: "2026-07-23T00:00:01.000Z",
          tts_stream_complete: "2026-07-23T00:00:02.000Z",
          transport_complete_written: "2026-07-23T00:00:02.100Z",
          session_completed: "2026-07-23T00:00:03.000Z"
        }
      },
      browserOutcome: "completed",
      qaStreamTrace: {
        observed: true,
        status: "completed_with_fallback",
        fallbackReasonPresent: true
      }
    };

    expect(classifyStreamingVoiceOutcome(snapshot)).toBe("safe_fallback");
    expect(matchesStreamingVoiceExpectedOutcome("safe_fallback", snapshot)).toBe(true);
  });

  it("requires both aborted telemetry and an IDLE VoiceSession", () => {
    const snapshot = {
      trace: {
        status: "aborted",
        timestamps: { session_completed: "2026-07-23T00:00:01.000Z" }
      },
      browserOutcome: "aborted",
      cancelled: true,
      voiceSessionState: "IDLE" as const
    };

    expect(classifyStreamingVoiceOutcome(snapshot)).toBe("aborted");
    expect(matchesStreamingVoiceExpectedOutcome("aborted", snapshot)).toBe(true);
    expect(matchesStreamingVoiceExpectedOutcome("aborted", {
      ...snapshot,
      voiceSessionState: "LISTENING"
    })).toBe(false);
    expect(classifyStreamingVoiceOutcome({
      ...snapshot,
      browserOutcome: "completed"
    })).toBe("unexpected");
  });
});
