// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  requireAuthContext: vi.fn(),
  isUnauthenticatedError: vi.fn(
    (error: unknown) =>
      error instanceof Error && error.message === "unauthenticated"
  ),
  unauthorizedResponse: vi.fn(() =>
    Response.json({ error: "unauthenticated" }, { status: 401 })
  )
}));

const sessionMocks = vi.hoisted(() => ({
  create: vi.fn(),
  has: vi.fn(),
  subscribe: vi.fn(),
  sendAudio: vi.fn(),
  markBrowserPlaybackStarted: vi.fn(),
  truncatePlayback: vi.fn(),
  close: vi.fn()
}));

vi.mock("@/lib/server/auth/request-context", () => authMocks);
vi.mock("@/lib/server/voice-qa/realtime-session-registry", () => ({
  RealtimeVoiceQaSessionError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  realtimeVoiceQaSessions: sessionMocks
}));

import { POST as startSession } from "./session/route";
import { DELETE as closeSession } from "./session/[sessionId]/route";
import { POST as sendAudio } from "./session/[sessionId]/audio/route";
import { GET as receiveEvents } from "./session/[sessionId]/events/route";
import { POST as truncatePlayback } from "./session/[sessionId]/playback/route";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const routeContext = {
  params: Promise.resolve({ sessionId: SESSION_ID })
};

describe("realtime Voice QA routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.requireAuthContext.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com" },
      store: { name: "authenticated-store" }
    });
    sessionMocks.create.mockResolvedValue({
      sessionId: SESSION_ID,
      createdAt: "2026-07-31T00:00:00.000Z"
    });
    sessionMocks.has.mockReturnValue(true);
    sessionMocks.sendAudio.mockResolvedValue(undefined);
    sessionMocks.markBrowserPlaybackStarted.mockResolvedValue(true);
    sessionMocks.truncatePlayback.mockResolvedValue(true);
    sessionMocks.close.mockResolvedValue(undefined);
  });

  it("starts an authenticated all-memory session without accepting a model override", async () => {
    const response = await startSession(new Request(
      "http://localhost/api/voice/realtime/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "all" })
      }
    ));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      version: 1,
      sessionId: SESSION_ID,
      inputAudio: {
        format: "pcm_s16le",
        sampleRate: 16_000,
        chunkSamples: 320
      },
      outputAudio: {
        format: "pcm_s16le",
        sampleRate: 24_000
      }
    });
    expect(sessionMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      scope: "all",
      store: { name: "authenticated-store" }
    }));

    const rejected = await startSession(new Request(
      "http://localhost/api/voice/realtime/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "all",
          llmProviderId: "gpt-5.5"
        })
      }
    ));
    expect(rejected.status).toBe(400);
  });

  it("streams bounded PCM chunks into the owned session", async () => {
    const audio = Buffer.alloc(642, 7);
    const response = await sendAudio(new Request(
      `http://localhost/api/voice/realtime/session/${SESSION_ID}/audio`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: audio
      }
    ), routeContext);

    expect(response.status).toBe(204);
    expect(sessionMocks.sendAudio).toHaveBeenCalledTimes(2);
    expect(sessionMocks.sendAudio.mock.calls[0]).toEqual([
      SESSION_ID,
      "user-1",
      expect.objectContaining({ byteLength: 640 })
    ]);
    expect(sessionMocks.sendAudio.mock.calls[1]).toEqual([
      SESSION_ID,
      "user-1",
      expect.objectContaining({ byteLength: 2 })
    ]);
  });

  it("serializes canonical metadata and audio as NDJSON without answer internals", async () => {
    sessionMocks.subscribe.mockImplementation(
      (
        _sessionId: string,
        _userId: string,
        listener: (event: unknown) => void
      ) => {
        listener({
          type: "audio_chunk",
          turnSequence: 1,
          sequence: 1,
          sentenceSequence: 1,
          sentenceChunkSequence: 1,
          supportIds: ["segment-1"],
          audio: Buffer.from([1, 2])
        });
        listener({
          type: "answer",
          turnSequence: 1,
          transcript: "question",
          text: "spoken answer",
          answer: {
            id: "answer-1",
            uploadId: "all_memory",
            question: "question",
            answer: "canonical answer [E1]",
            citedSegmentIds: ["segment-1"],
            citations: [{
              id: "E1",
              title: "Evidence",
              startSeconds: 1,
              endSeconds: 2,
              excerpt: "Evidence excerpt",
              sourceSegmentIds: ["segment-1"]
            }],
            createdAt: "2026-07-31T00:00:00.000Z"
          }
        });
        listener({ type: "session_closed" });
        return () => undefined;
      }
    );

    const response = await receiveEvents(new Request(
      `http://localhost/api/voice/realtime/session/${SESSION_ID}/events`
    ), routeContext);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      type: "audio_chunk",
      audioBase64: Buffer.from([1, 2]).toString("base64")
    });
    expect(events[1]).toMatchObject({
      type: "answer",
      text: "spoken answer",
      answer: {
        id: "answer-1",
        citedSegmentIds: ["segment-1"]
      }
    });
    expect(JSON.stringify(events[1])).not.toContain("canonical answer");
    expect(JSON.stringify(events[1])).not.toContain("all_memory");
    expect(events[2]).toEqual({ type: "session_closed" });
  });

  it("forwards playback truncation and closes only the authenticated session", async () => {
    const playbackStartedResponse = await truncatePlayback(new Request(
      `http://localhost/api/voice/realtime/session/${SESSION_ID}/playback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "browser_playback_start",
          turnSequence: 3
        })
      }
    ), routeContext);
    expect(playbackStartedResponse.status).toBe(200);
    expect(sessionMocks.markBrowserPlaybackStarted).toHaveBeenCalledWith(
      SESSION_ID,
      "user-1",
      3
    );

    const playbackResponse = await truncatePlayback(new Request(
      `http://localhost/api/voice/realtime/session/${SESSION_ID}/playback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "truncate",
          turnSequence: 3,
          providerItemId: "reply-3",
          audioEndMs: 240
        })
      }
    ), routeContext);
    expect(playbackResponse.status).toBe(200);
    expect(sessionMocks.truncatePlayback).toHaveBeenCalledWith(
      SESSION_ID,
      "user-1",
      3,
      "reply-3",
      240
    );

    const closeResponse = await closeSession(new Request(
      `http://localhost/api/voice/realtime/session/${SESSION_ID}`,
      { method: "DELETE" }
    ), routeContext);
    expect(closeResponse.status).toBe(204);
    expect(sessionMocks.close).toHaveBeenCalledWith(SESSION_ID, "user-1");
  });
});
