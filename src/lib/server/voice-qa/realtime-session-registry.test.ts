// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const controllerMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    listeners: Set<(event: unknown) => unknown>;
    start: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    sendAudio: ReturnType<typeof vi.fn>;
    startClientTurn: ReturnType<typeof vi.fn>;
    cancelSessionTurn: ReturnType<typeof vi.fn>;
    truncatePlayback: ReturnType<typeof vi.fn>;
    markBrowserPlaybackStarted: ReturnType<typeof vi.fn>;
    emit: (event: unknown) => void;
  }>
}));

vi.mock("@/lib/server/voice/provider", () => ({
  createVoiceProvider: vi.fn(() => ({ provider: "mock" }))
}));
vi.mock("./adapter", () => ({
  createMemoryVoiceQaAnswerer: vi.fn(() => ({ answer: vi.fn() }))
}));
vi.mock("./doubao-rag-shadow", () => ({
  DoubaoRagShadowRunner: class {
    readonly mode = "off";
    readonly close = vi.fn();
  }
}));
vi.mock("./realtime-controller", () => ({
  RealtimeVoiceQaController: class {
    readonly listeners = new Set<(event: unknown) => unknown>();
    readonly start = vi.fn(async () => ({ sessionId: "provider-session" }));
    readonly close = vi.fn(async () => undefined);
    readonly sendAudio = vi.fn(async () => undefined);
    readonly startClientTurn = vi.fn(async () => undefined);
    readonly cancelSessionTurn = vi.fn(async () => undefined);
    readonly truncatePlayback = vi.fn(async () => true);
    readonly markBrowserPlaybackStarted = vi.fn(async () => true);
    constructor() {
      controllerMocks.instances.push(this);
    }
    onEvent(listener: (event: unknown) => unknown) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    emit(event: unknown) {
      for (const listener of this.listeners) listener(event);
    }
  }
}));

import {
  RealtimeVoiceQaSessionError,
  RealtimeVoiceQaSessionRegistry
} from "./realtime-session-registry";

const enabled = { VOICE_REALTIME_ENABLED: "true" };
const store = {} as Parameters<RealtimeVoiceQaSessionRegistry["create"]>[0]["store"];

describe("RealtimeVoiceQaSessionRegistry", () => {
  beforeEach(() => {
    controllerMocks.instances.splice(0);
  });

  it("stays disabled by default and never creates a Provider session", async () => {
    const registry = new RealtimeVoiceQaSessionRegistry();
    await expect(registry.create({
      userId: "user-1",
      store,
      scope: "all"
    }, {})).rejects.toMatchObject({ code: "disabled" });
    expect(controllerMocks.instances).toHaveLength(0);
  });

  it("buffers events until one owned subscriber attaches and permits reconnect", async () => {
    const registry = new RealtimeVoiceQaSessionRegistry();
    const session = await registry.create({
      userId: "user-1",
      store,
      scope: "all"
    }, enabled);
    const controller = controllerMocks.instances[0]!;
    controller.emit({ type: "session_started", providerSessionId: "provider-session" });
    const firstListener = vi.fn();
    const unsubscribe = registry.subscribe(
      session.sessionId,
      "user-1",
      firstListener
    );
    expect(firstListener).toHaveBeenCalledWith({
      type: "session_started",
      providerSessionId: "provider-session"
    });
    expect(() => registry.subscribe(
      session.sessionId,
      "user-1",
      vi.fn()
    )).toThrow(RealtimeVoiceQaSessionError);

    unsubscribe();
    const reconnectedListener = vi.fn();
    expect(() => registry.subscribe(
      session.sessionId,
      "user-1",
      reconnectedListener
    )).not.toThrow();

    await registry.sendAudio(session.sessionId, "user-1", Buffer.from([1, 2]));
    await registry.startClientTurn(session.sessionId, "user-1");
    await registry.cancelSessionTurn(session.sessionId, "user-1");
    await registry.markBrowserPlaybackStarted(session.sessionId, "user-1", 2);
    await registry.truncatePlayback(
      session.sessionId,
      "user-1",
      2,
      "reply-2",
      240
    );
    expect(controller.sendAudio).toHaveBeenCalledWith(Buffer.from([1, 2]));
    expect(controller.startClientTurn).toHaveBeenCalledOnce();
    expect(controller.cancelSessionTurn).toHaveBeenCalledWith("barge_in");
    expect(controller.markBrowserPlaybackStarted).toHaveBeenCalledWith(2);
    expect(controller.truncatePlayback).toHaveBeenCalledWith(
      2,
      "reply-2",
      240
    );
  });

  it("enforces ownership and the two-session per-user bound", async () => {
    const registry = new RealtimeVoiceQaSessionRegistry();
    const first = await registry.create({
      userId: "user-1",
      store,
      scope: "all"
    }, enabled);
    await registry.create({
      userId: "user-1",
      store,
      scope: "week"
    }, enabled);
    expect(registry.has(first.sessionId, "other-user")).toBe(false);
    await expect(registry.create({
      userId: "user-1",
      store,
      scope: "all"
    }, enabled)).rejects.toMatchObject({ code: "session_limit" });
  });

  it("expires idle sessions and closes their controller", async () => {
    vi.useFakeTimers();
    try {
      const registry = new RealtimeVoiceQaSessionRegistry(1_000);
      const session = await registry.create({
        userId: "user-1",
        store,
        scope: "all"
      }, enabled);
      const controller = controllerMocks.instances[0]!;
      vi.advanceTimersByTime(1_001);

      expect(registry.has(session.sessionId, "user-1")).toBe(false);
      expect(controller.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
