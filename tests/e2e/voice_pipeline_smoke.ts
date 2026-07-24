import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { QuestionAnswer } from "../../src/lib/domain/types";
import {
  VoiceEvent,
  type ParsedVoiceServerEvent
} from "../../src/lib/server/voice/events";
import type {
  VoiceProvider,
  VoiceSessionConfig,
  VoiceSessionInfo
} from "../../src/lib/server/voice/types";
import { VoiceQaBridge } from "../../src/lib/server/voice-qa/bridge";
import { VoiceSessionManager } from "../../src/lib/server/voice-qa/session-manager";
import { JsonStore } from "../../src/lib/server/storage/json-store";
import type {
  VoiceQARequest,
  VoiceQAResponse
} from "../../src/lib/server/voice-qa/types";

type SmokeConfiguration = {
  configuredProvider: "mock" | "volcengine";
  testMode: true;
  debug: boolean;
};

type SmokeDebugFields = Readonly<Record<string, string | number | boolean | undefined>>;

function booleanFlag(name: string, value: string | undefined, fallback: boolean) {
  if (!value?.trim()) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error(`${name} must be true or false`);
}

function readSmokeConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env
): SmokeConfiguration {
  const configuredProvider = environment.VOICE_PROVIDER?.trim().toLowerCase() || "volcengine";
  if (configuredProvider !== "mock" && configuredProvider !== "volcengine") {
    throw new Error("VOICE_PROVIDER must be mock or volcengine");
  }
  if (!booleanFlag("VOICE_TEST_MODE", environment.VOICE_TEST_MODE, false)) {
    throw new Error("VOICE_TEST_MODE=true is required for the offline voice smoke test");
  }
  return {
    configuredProvider,
    testMode: true,
    debug: booleanFlag("VOICE_DEBUG", environment.VOICE_DEBUG, false)
  };
}

function createDebugLogger(enabled: boolean) {
  return (event: string, fields: SmokeDebugFields = {}) => {
    if (!enabled) return;
    const details = Object.entries(fields)
      .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    process.stderr.write(`[voice-smoke-debug] event=${event}${details ? ` ${details}` : ""}\n`);
  };
}

function serverEvent(
  eventId: VoiceEvent,
  sessionId: string,
  payload?: unknown,
  audio?: Buffer
): ParsedVoiceServerEvent {
  return {
    eventId,
    eventName: VoiceEvent[eventId],
    sessionId,
    ...(payload === undefined ? {} : { payload }),
    ...(audio ? { audio } : {}),
    rawPayload: Buffer.alloc(0),
    compressed: false,
    serialization: audio ? "none" : "json",
    unknown: false
  };
}

class OfflineVoiceProvider implements VoiceProvider {
  readonly sessionId: string;
  readonly sentAudio: Buffer[] = [];
  readonly sentText: string[] = [];
  failTts = false;
  private readonly eventListeners = new Set<(event: ParsedVoiceServerEvent) => void>();
  private readonly audioListeners = new Set<(audio: Buffer) => void>();
  private readonly transcriptListeners = new Set<(text: string) => void>();

  constructor(
    sessionId: string,
    private readonly debug: ReturnType<typeof createDebugLogger>
  ) {
    this.sessionId = sessionId;
  }

  async connect() {
    this.debug("websocket_connected", { transport: "mock" });
  }

  async startSession(_config?: VoiceSessionConfig): Promise<VoiceSessionInfo> {
    this.debug("session_started", { session_id: this.sessionId });
    return { sessionId: this.sessionId };
  }

  async sendAudio(chunk: Buffer) {
    this.sentAudio.push(Buffer.from(chunk));
    this.debug("audio_sent", { bytes: chunk.byteLength });
  }

  async finishAudioInput() {
    this.debug("audio_input_finished", { session_id: this.sessionId });
  }

  async sendText(text: string) {
    this.sentText.push(text);
    this.debug("tts_started", { text_chars: text.length });
    if (this.failTts) {
      this.debug("tts_failed", { reason: "simulated_provider_failure" });
      throw new Error("simulated TTS failure");
    }

    const stream = {
      tts_type: "chat_tts_text",
      question_id: "question-smoke",
      reply_id: "reply-smoke"
    };
    this.emit(serverEvent(VoiceEvent.TTSSentenceStart, this.sessionId, stream));
    this.emit(serverEvent(
      VoiceEvent.TTSResponse,
      this.sessionId,
      undefined,
      Buffer.from([1, 2, 3, 4])
    ));
    this.emit(serverEvent(VoiceEvent.TTSEnded, this.sessionId, stream));
  }

  async finishSession() {
    this.debug("session_finished", { session_id: this.sessionId });
  }

  onTranscript(callback: (text: string) => void) {
    this.transcriptListeners.add(callback);
    return () => this.transcriptListeners.delete(callback);
  }

  onAudio(callback: (audio: Buffer) => void) {
    this.audioListeners.add(callback);
    return () => this.audioListeners.delete(callback);
  }

  onEvent(callback: (event: ParsedVoiceServerEvent) => void) {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  async close() {
    this.debug("websocket_closed", { transport: "mock" });
  }

  emitPartial(transcript: string) {
    this.debug("asr_message", { finality: "partial", text_chars: transcript.length });
    this.emit(serverEvent(VoiceEvent.ASRResponse, this.sessionId, {
      results: [{ text: transcript, is_interim: true }]
    }));
  }

  emitFinal(transcript: string) {
    this.debug("asr_message", { finality: "final", text_chars: transcript.length });
    this.emit(serverEvent(VoiceEvent.ASRResponse, this.sessionId, {
      results: [{ text: transcript, is_interim: false }]
    }));
    this.emit(serverEvent(VoiceEvent.ASREnded, this.sessionId));
  }

  private emit(event: ParsedVoiceServerEvent) {
    this.debug("websocket_event", {
      event_name: event.eventName,
      audio_bytes: event.audio?.byteLength
    });
    for (const listener of this.eventListeners) listener(event);
    if (event.audio) {
      for (const listener of this.audioListeners) listener(Buffer.from(event.audio));
    }
  }
}

function smokeAnswer(question: string): QuestionAnswer {
  return {
    id: "answer-smoke",
    uploadId: "all_memory",
    question,
    answer: "今天有一项值得留意的安排。[E1]",
    citedSegmentIds: ["segment-smoke"],
    citations: [{
      id: "E1",
      title: "已有安排",
      startSeconds: 1,
      endSeconds: 2,
      excerpt: "已经确认了安排",
      sourceSegmentIds: ["segment-smoke"]
    }],
    createdAt: "2026-07-21T00:00:00.000Z"
  };
}

async function runScenario(input: {
  sessionId: string;
  failTts: boolean;
  debug: ReturnType<typeof createDebugLogger>;
}) {
  const sessionRoot = await mkdtemp(join(tmpdir(), "voice-smoke-session-"));
  const sessionManager = new VoiceSessionManager({ store: new JsonStore(sessionRoot) });
  let managedSession = await sessionManager.create({
    sessionId: `logical-${input.sessionId}`,
    userId: "voice-smoke-user"
  });
  managedSession = await sessionManager.transition(
    managedSession.sessionId,
    "LISTENING",
    "voice-smoke-user"
  );
  const provider = new OfflineVoiceProvider(input.sessionId, input.debug);
  provider.failTts = input.failTts;
  const qaRequests: VoiceQARequest[] = [];
  const responses: VoiceQAResponse[] = [];
  const bridge = new VoiceQaBridge({
    provider,
    userId: "voice-smoke-user",
    scope: "all",
    responseMode: "VOICE",
    applicationSessionId: managedSession.sessionId,
    initialConversation: managedSession.conversationContext,
    onLifecycleStateChange: async (state) => {
      managedSession = await sessionManager.transition(
        managedSession.sessionId,
        state,
        "voice-smoke-user"
      );
    },
    onTurnCompleted: async (turn) => {
      managedSession = await sessionManager.appendTurn(
        managedSession.sessionId,
        turn,
        "voice-smoke-user"
      );
    },
    ttsTimeoutMs: 1_000,
    answerer: {
      answer: async (request) => {
        const startedAt = Date.now();
        qaRequests.push(request);
        const answer = smokeAnswer(request.transcript);
        input.debug("qa_completed", {
          elapsed_ms: Math.max(0, Date.now() - startedAt),
          evidence_count: answer.citedSegmentIds.length
        });
        return answer;
      }
    }
  });
  bridge.onResponse((response) => responses.push(response));

  try {
    const created = await bridge.start();
    await bridge.sendAudio(Buffer.from([10, 20, 30, 40]));
    provider.emitPartial("今天有什么");
    await Promise.resolve();
    const qaCallsAfterPartial = qaRequests.length;
    provider.emitFinal("今天有什么重要事情？");
    await bridge.waitForIdle();
    const beforeClose = bridge.snapshot();
    await bridge.close();
    const afterClose = bridge.snapshot();
    const persisted = await sessionManager.lookup(
      managedSession.sessionId,
      "voice-smoke-user"
    );
    await sessionManager.close(managedSession.sessionId, "voice-smoke-user");

    return {
      sessionCreated: created.id === input.sessionId && created.state === "idle",
      logicalSessionCreated: qaRequests[0]?.sessionId === managedSession.sessionId,
      logicalContextMessages: persisted?.conversationContext.length ?? 0,
      logicalStateBeforeClose: persisted?.state,
      audioInputBytes: provider.sentAudio.reduce((total, chunk) => total + chunk.byteLength, 0),
      qaCallsAfterPartial,
      qaCallCount: qaRequests.length,
      ttsRequestCount: provider.sentText.length,
      responseCount: responses.length,
      responseAudioBytes: responses[0]?.audio?.byteLength ?? 0,
      responseHasText: Boolean(responses[0]?.text.trim()),
      responseErrors: responses[0]?.errors ?? [],
      stateBeforeClose: beforeClose.state,
      stateAfterClose: afterClose.state
    };
  } finally {
    await bridge.close().catch(() => undefined);
    await rm(sessionRoot, { recursive: true, force: true });
  }
}

async function main() {
  const config = readSmokeConfiguration();
  const debug = createDebugLogger(config.debug);
  debug("smoke_started", {
    configured_provider: config.configuredProvider,
    transport: "mock",
    test_mode: config.testMode
  });

  const normal = await runScenario({
    sessionId: "voice-smoke-normal",
    failTts: false,
    debug
  });
  const ttsFailure = await runScenario({
    sessionId: "voice-smoke-tts-failure",
    failTts: true,
    debug
  });
  const assertions = {
    sessionCreated: normal.sessionCreated && ttsFailure.sessionCreated &&
      normal.logicalSessionCreated && ttsFailure.logicalSessionCreated,
    sessionContextPersisted: normal.logicalContextMessages === 2 &&
      ttsFailure.logicalContextMessages === 2 &&
      normal.logicalStateBeforeClose === "IDLE" &&
      ttsFailure.logicalStateBeforeClose === "IDLE",
    partialDidNotTriggerQa: normal.qaCallsAfterPartial === 0 && ttsFailure.qaCallsAfterPartial === 0,
    finalTriggeredQa: normal.qaCallCount === 1 && ttsFailure.qaCallCount === 1,
    normalTtsReturnedAudio: normal.responseAudioBytes > 0 && normal.responseErrors.length === 0,
    ttsFailureReturnedText: ttsFailure.responseHasText &&
      ttsFailure.responseAudioBytes === 0 &&
      ttsFailure.responseErrors.includes("tts_failed"),
    sessionsClosed: normal.stateAfterClose === "closed" && ttsFailure.stateAfterClose === "closed"
  };
  const pass = Object.values(assertions).every(Boolean);
  const report = {
    version: 1,
    configuredProvider: config.configuredProvider,
    transport: "mock",
    testMode: config.testMode,
    debug: config.debug,
    normal,
    ttsFailure,
    assertions,
    pass
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!pass) process.exitCode = 1;
}

await main();
