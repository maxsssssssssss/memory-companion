// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { JsonStore } from "@/lib/server/storage/json-store";

import { RegistryRealtimeVoiceGatewayRuntimeManager } from "./realtime-gateway-runtime";
import type { RealtimeVoiceQaEvent } from "./realtime-controller";

describe("RegistryRealtimeVoiceGatewayRuntimeManager", () => {
  it("reuses the authenticated canonical registry and exposes only transport operations", async () => {
    let listener: ((event: RealtimeVoiceQaEvent) => unknown) | undefined;
    const registry = {
      create: vi.fn(async () => ({
        sessionId: "11111111-1111-4111-8111-111111111111" as const,
        createdAt: "2026-08-03T00:00:00.000Z"
      })),
      subscribe: vi.fn((_sessionId, _userId, next) => {
        listener = next;
        return () => { listener = undefined; };
      }),
      sendAudio: vi.fn(async () => undefined),
      startClientTurn: vi.fn(async () => undefined),
      cancelSessionTurn: vi.fn(async () => true),
      keepAlive: vi.fn(async () => undefined),
      markBrowserPlaybackStarted: vi.fn(async () => true),
      truncatePlayback: vi.fn(async () => true),
      close: vi.fn(async () => undefined)
    };
    const manager = new RegistryRealtimeVoiceGatewayRuntimeManager(
      registry,
      { VOICE_REALTIME_ENABLED: "true" }
    );
    const store = {} as JsonStore;
    const runtime = await manager.create({
      userId: "user-1",
      store,
      scope: "week",
      referenceDate: "2026-08-03"
    });
    expect(registry.create).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      store,
      scope: "week",
      referenceDate: expect.any(Date)
    }), { VOICE_REALTIME_ENABLED: "true" });

    listener?.({ type: "asr_partial", transcript: "测试" });
    const events: RealtimeVoiceQaEvent[] = [];
    runtime.subscribe((event) => events.push(event));
    expect(events).toEqual([{ type: "asr_partial", transcript: "测试" }]);

    await runtime.sendAudio(Buffer.from([1, 2]));
    await runtime.startClientTurn();
    await runtime.cancelSessionTurn();
    await runtime.keepAlive();
    await runtime.markBrowserPlaybackStarted(2);
    await runtime.truncatePlayback(2, "reply-2", 240);
    expect(registry.sendAudio).toHaveBeenCalledWith(
      runtime.sessionId,
      "user-1",
      Buffer.from([1, 2])
    );
    expect(registry.cancelSessionTurn).toHaveBeenCalledOnce();
    expect(registry.keepAlive).toHaveBeenCalledWith(runtime.sessionId, "user-1");
    expect(registry.truncatePlayback).toHaveBeenCalledWith(
      runtime.sessionId,
      "user-1",
      2,
      "reply-2",
      240
    );
  });
});
